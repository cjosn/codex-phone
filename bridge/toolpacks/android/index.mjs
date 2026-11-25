// android: 把 App 的原生设备通道（App 在 127.0.0.1 上开的 HTTP 服务）包装成模型可调用的工具。
// 契约见 docs/DEVICE-API-CONTRACT.md。握手文件 ${CODEX_HOME}/codex-go-device.json（模式 0600）
// 由 App 在开启通道时写入、关闭通道时删除：{"baseUrl","token","tier","granted","version","pid","startedAt"}。
//
// 三条硬约定：
// 1. 每个工具调用前**重新读**握手文件，不缓存整场会话（用户可能随时退回标准档或直接关通道）；
// 2. token 只在内存里用于 Authorization 头：不写日志、不进返回值、不进错误消息。若 App 把请求头
//    回显进响应体，这里会把 token 从返回值里抹成 [redacted]；
// 3. HTTP 非 2xx 时把 App 的 error.code/message **原样透传**（那是 App 侧的稳定码，词表见契约），
//    只有网络层失败才折成 device/unavailable，本地超时折成 device/timeout。
//
// 有副作用的端点（/ui/tap|swipe|text|key、/shell/exec、POST /clipboard）都带 reason，App 写进本机审计环。
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {optionalBoolean,optionalInteger} from '../_shared.mjs';

const DEVICE_FILE_NAME='codex-go-device.json';
const DEFAULT_TIMEOUT_MS=15000;
// shell_exec 的本地截止时间 = 参数 timeoutMs + 2 s 余量，让 App 侧先报自己的 device/timeout。
const SHELL_TIMEOUT_MARGIN_MS=2000;
const DEFAULT_SHELL_TIMEOUT_MS=20000;
const MAX_SHELL_TIMEOUT_MS=110000;
const MAX_DUMP_NODES=2000;
const DEFAULT_DUMP_NODES=1500;
const MIN_REASON=4;
const MAX_REASON=500;
const MAX_INPUT_TEXT=4000;
const MAX_TARGET_TEXT=200;
const MAX_COMMAND=4000;
const MAX_COORDINATE=100000;
const MIN_DURATION_MS=50;
const MAX_DURATION_MS=10000;
const DEFAULT_DURATION_MS=300;
const KEYS=['back','home','recents','enter','del'];
// 屏幕快照：编号只在本屏有效。screen/tap/type/scroll/key 共用这一份，
// 动作后立刻重新读屏并替换，于是旧编号自然失效；调用方带 screenId 时能当场发现自己在用旧屏。
let snapshot=null,snapshotSeq=0;
const MAX_COLLECT_ROUNDS=15,MAX_COLLECT_ITEMS=400,SCROLL_SETTLE_ROUNDS=1;
const SCROLL_DIRECTIONS=['down','up'];
// 通道没开时给模型一句可直接转告用户的操作路径（与 docs/DEVICE-API-CONTRACT.md §0 同口径）。
const TIER_HINT='Open Settings → Phone capabilities in Codex Pocket and turn the device channel on';

// 与宿主同一个形状：<area>/<kebab>。App 回来的 code 不合形状时不当错误码用（宿主会折成 tool/internal，
// 那样反而丢掉信息），这里改成 device/unsupported 并在 message 里带上原始码。
const ERROR_CODE_PATTERN=/^[a-z][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

const fail=(message,code)=>Object.assign(new Error(message),{code});
const invalid=message=>fail(message,'args/invalid');
const argsError=error=>invalid(error?.message??'invalid arguments');

// --- 参数校验（顺序固定：参数校验 → 握手 → 请求，参数错的时候不碰设备） ----------
function stringOf(value,label,{max,min=1}={}){
 if(typeof value!=='string')throw invalid(`${label} is required and must be a string`);
 const trimmed=value.trim();
 if(trimmed.length<min)throw invalid(`${label} must be a nonempty string`);
 if(trimmed.length>max)throw invalid(`${label} must be at most ${max} characters, received ${trimmed.length}`);
 return trimmed;
}

// ui_input 的正文必须原样发送（空白有意义），空串只在 submit:true 时合法。
function typedTextOf(value){
 if(typeof value!=='string')throw invalid('text is required and must be a string: the exact characters to type into the focused input field');
 if(value.length>MAX_INPUT_TEXT)throw invalid(`text must be at most ${MAX_INPUT_TEXT} characters, received ${value.length}`);
 return value;
}

function integerOf(value,label,{min,max,fallback}={}){
 try{return optionalInteger(value,label,{min,max,fallback});}
 catch(error){throw argsError(error);}
}

// 必填整数：optionalInteger 会把 undefined 当成「用默认值」，必填参数必须自己挡住。
function requiredIntegerOf(value,label,{min,max}={}){
 if(value===undefined||value===null)throw invalid(`${label} is required: pass an integer between ${min} and ${max} (screen pixels, origin at the top left)`);
 return integerOf(value,label,{min,max});
}

function boolOf(value,label,{fallback=false}={}){
 try{return optionalBoolean(value,label,{fallback});}
 catch(error){throw argsError(error);}
}

// reason 是审计凭据：App 把它写进本机审计环，用户据此回看手机被谁动了什么。
function reasonOf(value){
 if(typeof value!=='string')throw invalid(`reason is required: pass a short English sentence saying why the phone must be touched (${MIN_REASON}-${MAX_REASON} characters); it is stored in the device audit log the user can review`);
 const trimmed=value.trim();
 if(trimmed.length<MIN_REASON)throw invalid(`reason must be at least ${MIN_REASON} characters so the user can tell why the phone was touched; received ${JSON.stringify(value)}`);
 if(trimmed.length>MAX_REASON)throw invalid(`reason must be at most ${MAX_REASON} characters, received ${trimmed.length}`);
 return trimmed;
}

// --- 握手文件 ---------------------------------------------------------------
function codexHome(){
 const configured=process.env.CODEX_HOME;
 if(typeof configured==='string'&&configured.trim())return path.resolve(configured.trim());
 return path.join(os.homedir(),'.codex');
}

// 位置按契约固定为 ${CODEX_HOME}/codex-go-device.json，不额外引入开关：
// 测试和特殊部署都通过 CODEX_HOME 指到别处。
const deviceFilePath=()=>path.join(codexHome(),DEVICE_FILE_NAME);

function channelOff(file,detail){
 return fail(`The Android device channel is off for this call: ${detail} (handshake file ${file}). ${TIER_HINT}, then retry. No request reached the phone and nothing was changed.`,'device/unavailable');
}

// 每次调用都走这里：读文件 → 解析 → 校验 baseUrl/token，绝不缓存。
async function readHandshake(){
 const file=deviceFilePath();
 let raw;
 try{raw=await readFile(file,'utf8');}
 catch(error){
  if(error?.code==='ENOENT')throw channelOff(file,'the handshake file does not exist');
  throw channelOff(file,`the handshake file cannot be read (${error?.code??error?.message??'unknown error'})`);
 }
 let value;
 try{value=JSON.parse(raw);}
 catch{throw channelOff(file,'the handshake file is not valid JSON');}
 const baseUrl=typeof value?.baseUrl==='string'?value.baseUrl.trim():'';
 const token=typeof value?.token==='string'?value.token.trim():'';
 if(!baseUrl||!token)throw channelOff(file,'the handshake file carries no usable baseUrl and token pair');
 let url;
 try{url=new URL(baseUrl);}
 catch{throw channelOff(file,'the handshake baseUrl is not an absolute URL');}
 if(url.protocol!=='http:'&&url.protocol!=='https:')throw channelOff(file,`the handshake baseUrl is not http or https (${url.protocol})`);
 return {
  file,
  baseUrl:baseUrl.replace(/\/+$/,''),
  token,
  tier:typeof value?.tier==='string'?value.tier:null,
  granted:Array.isArray(value?.granted)?value.granted.filter(item=>typeof item==='string'):[],
 };
}

// --- 出站请求 ---------------------------------------------------------------
// 宿主会在 ctx.timeoutMs（默认 120000）时掐断整个调用；本地截止时间略小一点，
// 让设备通道先报自己的 device/timeout，而不是被宿主折成 tool/timeout。
function budgetOf(ctx,requested){
 const host=Number.isFinite(ctx?.timeoutMs)&&ctx.timeoutMs>0?ctx.timeoutMs:120000;
 const capped=Math.min(requested,host-1000);
 return capped>=500?capped:Math.max(100,Math.floor(host/2));
}

// token 只用于 Authorization 头。万一 App 把请求头/配置回显进响应体，这里把 token 抹掉，
// 保证「token 不出现在返回值里」；同名键（token/authorization/auth/bearer）也一律脱敏。
function scrub(value,token,seen){
 if(typeof value==='string')return value.includes(token)?'[redacted]':value;
 if(Array.isArray(value))return value.map(item=>scrub(item,token,seen));
 if(value&&typeof value==='object'){
  if(seen.has(value))return '[redacted]';
  seen.add(value);
  const output={};
  for(const [key,item] of Object.entries(value)){
   output[key]=/^(?:token|authorization|auth|bearer)$/i.test(key)?'[redacted]':scrub(item,token,seen);
  }
  return output;
 }
 return value;
}

function redact(value,token){
 if(!token)return value;
 if(typeof value==='string')return value.includes(token)?'[redacted]':value;
 if(!value||typeof value!=='object')return value;
 return scrub(value,token,new WeakSet());
}

// App 的副作用端点会回 {"ok":true,...}。宿主把「自带布尔 ok 的返回值」当成已封装信封原样透传，
// 所以这里先去掉 App 的 ok，让 data 里只剩真正的业务字段（成功与否由宿主信封的 ok 表示）。
function stripOk(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return value===undefined?{}:value;
 if(typeof value.ok!=='boolean')return value;
 const {ok,...rest}=value;
 return rest;
}

function excerpt(raw){return raw.replace(/\s+/g,' ').trim().slice(0,300)||'<empty body>';}

async function callDevice(handshake,{method='GET',endpoint,body,timeoutMs}){
 const headers={authorization:`Bearer ${handshake.token}`,accept:'application/json'};
 const init={method,headers,signal:AbortSignal.timeout(timeoutMs)};
 if(body!==undefined){
  headers['content-type']='application/json';
  init.body=JSON.stringify(body);
 }
 let response;
 try{response=await fetch(`${handshake.baseUrl}${endpoint}`,init);}
 catch(error){
  if(error?.name==='TimeoutError'||error?.name==='AbortError'){
   throw fail(`The device channel did not answer ${method} ${endpoint} within ${timeoutMs} ms, so the request was aborted (device/timeout). Check that the phone screen is on and Codex Pocket is still in the foreground; a long shell command needs a larger timeoutMs.`,'device/timeout');
  }
  const cause=error?.cause?.code??error?.code??error?.message??String(error);
  throw fail(`Cannot reach the Android device channel at ${handshake.baseUrl} for ${method} ${endpoint} (${cause}). The channel was probably turned off or the App was stopped: ${TIER_HINT}, then retry. Nothing was changed on the phone.`,'device/unavailable');
 }
 const raw=await response.text().catch(()=>'');
 let value;
 try{value=raw?JSON.parse(raw):{};}
 catch{value=undefined;}
 if(!response.ok){
  const code=typeof value?.error?.code==='string'?value.error.code.trim():'';
  const message=typeof value?.error?.message==='string'?value.error.message.trim():'';
  if(ERROR_CODE_PATTERN.test(code)){
   // App 侧的稳定码原样透传，message 也原样（它已经是可执行的英文提示）。
   throw fail(message||`The device channel rejected ${method} ${endpoint} with HTTP ${response.status} (${code}) and no message.`,code);
  }
  throw fail(`The device channel rejected ${method} ${endpoint} with HTTP ${response.status} but the body was not the documented error envelope${code?` (raw code ${JSON.stringify(code)})`:''}. Body: ${excerpt(raw)}. This App build probably predates the endpoint: update Codex Pocket on the phone and retry.`,'device/unsupported');
 }
 if(value===undefined){
  throw fail(`The device channel answered ${method} ${endpoint} with HTTP ${response.status} but the body was not JSON, so no result can be trusted. Body: ${excerpt(raw)}`,'device/unavailable');
 }
 return redact(value,handshake.token);
}

// 读取类端点：握手 → GET → 原样返回业务对象（契约里这些响应没有 ok 字段，去 ok 只是保险）。
async function readEndpoint(ctx,endpoint){
 const handshake=await readHandshake();
 return stripOk(await callDevice(handshake,{method:'GET',endpoint,timeoutMs:budgetOf(ctx,DEFAULT_TIMEOUT_MS)}));
}

// 副作用端点：握手 → POST JSON → 去掉 App 自己的 ok 字段。
async function postEndpoint(ctx,endpoint,body,{timeoutMs=DEFAULT_TIMEOUT_MS}={}){
 const handshake=await readHandshake();
 const value=await callDevice(handshake,{method:'POST',endpoint,body,timeoutMs:budgetOf(ctx,timeoutMs)});
 return stripOk(value);
}

// --- 屏幕快照与目标解析 ------------------------------------------------------
function staleFail(message){
 return fail(message,'device/stale-screen');
}

// 动作类工具统一从这里取「当前屏幕」：没读过屏就明确要求先读，绝不猜坐标。
function currentScreen(screenId){
 if(!snapshot){
  throw staleFail('No screen has been read in this session yet, so element ids cannot be resolved. Call screen first, then use the ids it returns.');
 }
 if(typeof screenId==='string'&&screenId.trim()&&screenId.trim()!==snapshot.screenId){
  throw staleFail(`screenId ${JSON.stringify(screenId)} is not the current screen (${snapshot.screenId}); those ids belong to an older screen. Call screen again and use the new ids. Nothing was touched.`);
 }
 return snapshot;
}

function elementOf(view,id){
 const element=view.elements.find(item=>item.id===id);
 if(!element){
  throw invalid(`Element [${id}] is not on the current screen (${view.screenId}), which lists ${view.elements.length} items. Use an id from the latest screen output. Nothing was touched.`);
 }
 const bounds=Array.isArray(element.bounds)?element.bounds:[];
 if(bounds.length<4||bounds[2]<=bounds[0]||bounds[3]<=bounds[1]){
  throw fail(`Element [${id}] has no usable bounds (${JSON.stringify(element.bounds)}), so it cannot be tapped by id. Re-read the screen, or pass x and y.`,'device/unsupported');
 }
 return element;
}

function centerOf(element){
 const [left,top,right,bottom]=element.bounds;
 return {x:Math.round((left+right)/2),y:Math.round((top+bottom)/2)};
}

async function captureScreen(ctx,{includeInvisible=false,maxNodes=DEFAULT_DUMP_NODES}={}){
 const dump=await postEndpoint(ctx,'/ui/dump',{includeInvisible,maxNodes});
 const screenId=`s${++snapshotSeq}`;
 const view=screenText(dump,{screenId});
 const size=(Array.isArray(dump?.screens)?dump.screens[0]:null)||{};
 snapshot={
  screenId,
  text:view.text,
  elements:view.elements,
  truncated:view.truncated||dump?.truncated===true,
  width:Number(size.width)||1080,
  height:Number(size.height)||2400,
 };
 return snapshot;
}

// 动作后统一回一张新屏：模型永远看到动作之后的事实，而不是自己想象的。
function screenResult(view,extra={}){
 return {screenId:view.screenId,text:view.text,elements:view.elements,truncated:view.truncated,...extra};
}

// 竖向滑动：默认在屏幕中段，指定 id 时用该元素的纵向范围。
async function swipeVertical(ctx,direction,{element,reason,view}){
 const up=direction==='up';
 const span=element
  ?{left:element.bounds[0],top:element.bounds[1],right:element.bounds[2],bottom:element.bounds[3]}
  :{left:view.width*0.2,top:view.height*0.25,right:view.width*0.8,bottom:view.height*0.75};
 const x=Math.round((span.left+span.right)/2);
 const top=Math.round(span.top),bottom=Math.round(span.bottom);
 // 留 20% 内缩：贴边滑动更容易被系统当成返回手势。
 const inset=Math.max(24,Math.round((bottom-top)*0.2));
 const topY=top+inset,bottomY=bottom-inset;
 // 内容向下滚动（露出后面的条目）= 手指从下往上划。
 const fromY=up?topY:bottomY;
 const toY=up?bottomY:topY;
 return postEndpoint(ctx,'/ui/swipe',{fromX:x,fromY,toX:x,toY,durationMs:400,reason});
}

// 屏幕读写已迁到 android-screen 包（按 TOOLPACKS-CONTRACT 注册）；本包只保留「先看能力」的两个只读工具。
export const meta={
 name:'android',
 title:'Android Device',
 version:'2.0.0',
 description:'Drive the phone through the Codex Pocket device channel. Read the screen as numbered text (screen), then act on those numbers (tap/type/scroll/key); also lists and opens apps, reads/writes the clipboard, collects long lists, and runs Shizuku shell when it is available. Every action is gated by its own permission tier and written to the on-device audit log.',
};

const REASON_PROP={type:'string',minLength:MIN_REASON,maxLength:MAX_REASON,description:'Short English sentence saying why the phone is being touched; 4-500 characters, recorded in the device audit log the user can review.'};
const SCREEN_ID_PROP={type:'string',maxLength:16,description:'Optional screenId the ids you are about to use belong to. When it is not the current screen the call fails with device/stale-screen instead of tapping the wrong place.'};

// 一次读屏后要重复用到的「成本说明」，避免每个工具重复写三遍。
const A11Y_TAIL='Needs the accessibility tier: the user must enable Codex Pocket under Settings > Accessibility of the phone; without it every call fails with "device/permission-denied" and no fallback is attempted.';
const CHANNEL_TAIL='Failures: "device/unavailable" when the channel is off (open Settings > Phone capabilities in Codex Pocket and turn the device channel on), "device/timeout" after 15000 ms, "device/unsupported" when the App answers with an undocumented body. The bearer token from the handshake file is never returned.';

export const tools=[
 {
  name:'device_capabilities',
  description:'Use this to learn what the phone actually allows right now before calling any other android tool, and to re-check after a permission failure: it reports the active permission tier, every capability flag, and the denied entries with their hints. '
   +'Takes no parameters; the handshake file ${CODEX_HOME}/codex-go-device.json is re-read on every call, so this call also tells you whether the device channel is on at all. '
   +'Returns the device capabilities object unchanged: {tier, tiers:{standard,accessibility,debugger,admin,root}, granted:[...], denied:[{capability,hint}], capabilities:{ui_dump,ui_tap,ui_text,ui_key,ui_screenshot,clipboard,device_info,app_list,shell,notifications,background_tasks}, device:{model,brand,sdk,androidRelease}, permissions:{...}}. '
   +'Needs no extra permission beyond the channel itself: every tier can call it. '
   +'Failures: "device/unavailable" when the handshake file is missing or unreadable, which means the channel is off and the fix is to open Settings > Phone capabilities in Codex Pocket and turn the device channel on; "device/timeout" when the phone does not answer within 15000 ms; "device/unsupported" when the App answers with an undocumented body; "args/invalid". The bearer token from the handshake file is never returned or logged.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async(args,ctx)=>readEndpoint(ctx,'/capabilities'),
 },
 {
  name:'device_info',
  description:'Use this to identify the phone and its live state (model, brand, manufacturer, Android SDK and release, battery, network type, storage, App version) when you need real hardware facts instead of assumptions. '
   +'Takes no parameters; the handshake file is re-read on every call. '
   +'Returns the device info object unchanged: {model,brand,manufacturer,sdk,androidRelease,battery:{percent,charging},network:{type,connected},storage:{totalBytes,freeBytes},app:{versionName,versionCode}}. '
   +'Needs only the standard tier: no Accessibility service and no Shizuku, and nothing on the phone is modified. '
   +'Failures: "device/unavailable" when the channel is off or unreachable (the fix is to open Settings > Phone capabilities in Codex Pocket and turn the device channel on), "device/timeout" after 15000 ms, "device/unsupported" for an undocumented body. The bearer token is never returned.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async(args,ctx)=>readEndpoint(ctx,'/device/info'),
 },
 {
  name:'shell_exec',
  description:'Run one validated Android command through root or authorized Shizuku; no shell pipelines, separators, redirects or substitutions. command: one pm/am/input/settings/getprop/dumpsys/cmd invocation. reason is recorded in the on-device audit log. Returns exitCode/stdout/stderr plus timeout/truncation/backend facts; unavailable backends fail with an actionable device error.',
  inputSchema:{type:'object',properties:{
   command:{type:'string',minLength:1,maxLength:MAX_COMMAND,description:'One command only, without pipes, separators, redirection, quoting or substitution.'},
   timeoutMs:{type:'integer',minimum:100,maximum:MAX_SHELL_TIMEOUT_MS,default:DEFAULT_SHELL_TIMEOUT_MS},
   reason:REASON_PROP,
  },required:['command','reason'],additionalProperties:false},
  run:async(args,ctx)=>{
   const command=stringOf(args.command,'command',{max:MAX_COMMAND});
   const reason=reasonOf(args.reason);
   const timeoutMs=integerOf(args.timeoutMs,'timeoutMs',{min:100,max:MAX_SHELL_TIMEOUT_MS,fallback:DEFAULT_SHELL_TIMEOUT_MS});
   return postEndpoint(ctx,'/shell/exec',{command,reason,timeoutMs},{timeoutMs:timeoutMs+SHELL_TIMEOUT_MARGIN_MS});
  },
 },
];
