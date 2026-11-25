// admin: 通过带鉴权的 bridge HTTP API 管理 Codex Pocket 的上下文压缩、人格、模型与工具包。
// 这里每个工具都依赖 ${CODEX_HOME}/codex-go-bridge.json 握手；没有握手时立刻失败并说明
// 缺哪个文件，绝不伪造结果或改走别的路径。端点遵循 CONTRACT-V2：
// context, context/config, persona, persona/save, toolpacks, toolpacks/toggle,
// toolpacks/import, config, models。
import {
 bridgeRequest,optionalBoolean,optionalInteger,optionalString,requireString,
} from '../_shared.mjs';

const PACK_NAME_PATTERN=/^[a-z][a-z0-9_-]{0,63}$/;
const EFFORTS=['none','minimal','low','medium','high','xhigh'];
const BRIDGE_FILE_HINT='${CODEX_HOME}/codex-go-bridge.json';

const fail=(message,code)=>Object.assign(new Error(message),{code});
const argsError=error=>fail(error?.message??'invalid arguments','args/invalid');
const needString=(value,label)=>{try{return requireString(value,label);}catch(error){throw argsError(error);}};
const maybeString=(value,label)=>{try{return optionalString(value,label);}catch(error){throw argsError(error);}};
const maybeInteger=(value,label,options)=>{try{return optionalInteger(value,label,options);}catch(error){throw argsError(error);}};
const maybeBoolean=(value,label)=>{try{return optionalBoolean(value,label);}catch(error){throw argsError(error);}};

// 桥握手门禁：缺 baseUrl/token 就直接抛 bridge/token-missing，连请求都不发。
function needBridge(ctx,feature){
 const bridge=ctx?.bridge;
 const where=ctx?.bridgeFile??BRIDGE_FILE_HINT;
 if(!bridge||typeof bridge!=='object'||typeof bridge.baseUrl!=='string'||!bridge.baseUrl||typeof bridge.token!=='string'||!bridge.token){
  throw fail(`${feature} needs the running Codex Pocket bridge, but no usable handshake was found at ${where} (the file must contain baseUrl and token). Start the bridge, which rewrites the handshake file, then retry; no request was sent.`,'bridge/token-missing');
 }
 return bridge;
}

// 统一桥调用：把网络/HTTP/超时失败折成 bridge/request-failed，并保留上游 code 便于排查。
async function callBridge(bridge,endpoint,body,options={}){
 try{return await bridgeRequest(bridge,endpoint,body,options);}
 catch(error){
  const upstream=typeof error?.code==='string'&&error.code?error.code:'bridge/error';
  const detail=error?.message??String(error);
  const wrapped=fail(`${endpoint} failed: ${detail} (upstream code ${upstream}). The handshake is valid but the bridge rejected, timed out or could not be reached; check that the bridge is still running and look at its log, then retry.`,'bridge/request-failed');
  wrapped.upstreamCode=upstream;
  wrapped.details=error?.details;
  throw wrapped;
 }
}

function packName(value){
 const name=needString(value,'name');
 if(!PACK_NAME_PATTERN.test(name))throw fail(`name must match ${PACK_NAME_PATTERN} (a lowercase letter followed by up to 63 lowercase letters, digits, dashes or underscores); received ${JSON.stringify(name)}.`,'args/invalid');
 return name;
}

async function ping(args,ctx){
 const bridge=needBridge(ctx,'ping');
 const url=new URL(`${bridge.baseUrl}/healthz`);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),5000);
 try{
  const response=await fetch(url,{headers:{accept:'application/json'},signal:controller.signal});
  const raw=await response.text();
  let value=null;
  try{value=JSON.parse(raw);}catch{value={raw:raw.slice(0,500)};}
  return {
   reachable:true,
   handshake:true,
   baseUrl:bridge.baseUrl,
   status:response.status,
   ok:Boolean(value?.ok),
   engine:value?.engine??null,
   mode:value?.mode??null,
   bridgeRevision:value?.bridge??null,
   codexVersion:value?.codexVersion??null,
   activeTurns:value?.activeTurns??null,
  };
 }catch(error){
  const detail=error?.name==='AbortError'?'timed out after 5000ms':error?.message??String(error);
  throw fail(`The handshake file ${ctx?.bridgeFile??BRIDGE_FILE_HINT} exists but ${bridge.baseUrl}/healthz is unreachable: ${detail}. The bridge process probably stopped or moved; restart the bridge and retry ping.`,'bridge/request-failed');
 }finally{clearTimeout(timer);}
}

async function contextSet(args,ctx){
 const bridge=needBridge(ctx,'context_set');
 const body={};
 if(args.enabled!==undefined)body.enabled=maybeBoolean(args.enabled,'enabled');
 if(args.autoCompact!==undefined)body.autoCompact=maybeBoolean(args.autoCompact,'autoCompact');
 if(args.thresholdPercent!==undefined)body.thresholdPercent=maybeInteger(args.thresholdPercent,'thresholdPercent',{min:10,max:95});
 if(args.keepRecentTurns!==undefined)body.keepRecentTurns=maybeInteger(args.keepRecentTurns,'keepRecentTurns',{min:0,max:50});
 if(args.summaryModel!==undefined){
  if(args.summaryModel===null||args.summaryModel==='')body.summaryModel=null;
  else body.summaryModel=needString(args.summaryModel,'summaryModel');
 }
 if(!Object.keys(body).length)throw fail('Provide at least one of enabled, autoCompact, thresholdPercent, keepRecentTurns or summaryModel. Nothing was sent to the bridge; call context_get first if you need the current values.','args/invalid');
 return callBridge(bridge,'context/config',body,{timeoutMs:20000});
}

async function modelList(args,ctx){
 const bridge=needBridge(ctx,'model_list');
 const value=await callBridge(bridge,'models',{}, {timeoutMs:30000,method:'GET'});
 const models=Array.isArray(value?.models)?value.models:[];
 const limit=maybeInteger(args.limit,'limit',{min:1,max:500,fallback:200});
 return {
  count:models.length,
  models:models.slice(0,limit).map(model=>typeof model==='object'&&model?{...model}:{name:String(model)}),
  nextCursor:value?.nextCursor??null,
  truncated:models.length>limit,
 };
}

async function modelSet(args,ctx){
 const bridge=needBridge(ctx,'model_set');
 const body={};
 if(args.model!==undefined)body.model=needString(args.model,'model');
 if(args.provider!==undefined)body.provider=needString(args.provider,'provider');
 if(args.reasoningEffort!==undefined){
  const effort=maybeString(args.reasoningEffort,'reasoningEffort');
  if(effort&&!EFFORTS.includes(effort))throw fail(`reasoningEffort must be one of ${EFFORTS.join(', ')}; received ${JSON.stringify(effort)}. Omit it to keep the current effort.`,'args/invalid');
  if(effort)body.reasoningEffort=effort;
 }
 if(args.baseUrl!==undefined)body.baseUrl=needString(args.baseUrl,'baseUrl');
 if(!Object.keys(body).length)throw fail('Provide at least one of model, provider, reasoningEffort or baseUrl. Nothing was sent to the bridge; call model_list first if you need available ids.','args/invalid');
 const result=await callBridge(bridge,'config',body,{timeoutMs:60000});
 return {saved:true,...result};
}

async function personaSet(args,ctx){
 const bridge=needBridge(ctx,'persona_set');
 const body={};
 if(args.name!==undefined)body.name=typeof args.name==='string'?args.name:'';
 if(args.style!==undefined)body.style=typeof args.style==='string'?args.style:'';
 if(args.instructions!==undefined)body.instructions=typeof args.instructions==='string'?args.instructions:'';
 if(args.active!==undefined)body.active=maybeBoolean(args.active,'active');
 if(!Object.keys(body).length)throw fail('Provide at least one of name, style, instructions or active. Nothing was sent to the bridge; call persona_get first if you need the current values.','args/invalid');
 return callBridge(bridge,'persona/save',body,{timeoutMs:30000});
}

const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});

export const meta={
 name:'admin',
 title:'Bridge administration',
 version:'2.1.0',
 description:'Read and change bridge context settings, persona, models and MCP toolpacks through the authenticated bridge HTTP API, plus a handshake-aware ping.',
};

export const tools=[
 {
  name:'pkg_list',
  description:'Inventory the MCP toolpacks the bridge knows about before toggling or installing anything. Takes no parameters. Returns {count, enabled (packs not explicitly disabled), packs: [{name, title, version, description, builtin, enabled, tools (list of tool names)}]}. Requires the running bridge and a valid handshake; fails with bridge/token-missing when ${CODEX_HOME}/codex-go-bridge.json is missing or has no baseUrl/token, and bridge/request-failed when the bridge rejects or cannot serve POST /api/toolpacks.',
  inputSchema:object({}),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'pkg_list');
   const value=await callBridge(bridge,'toolpacks',{}, {timeoutMs:30000});
   const packs=Array.isArray(value?.packs)?value.packs:[];
   return {count:packs.length,enabled:packs.filter(pack=>pack.enabled!==false).length,packs};
  },
 },
 {
  name:'pkg_set_enabled',
  description:'Turn one MCP toolpack on or off for the running bridge without touching files on disk. name: pack name matching ^[a-z][a-z0-9_-]{0,63}$, for example "files" or "web" (use pkg_list to discover names). enabled: true enables the pack and exposes its tools, false hides them. Returns {changed:true, name, enabled} reflecting the state the bridge reported. Fails with args/invalid for a malformed name or a non-boolean enabled, bridge/token-missing without a handshake, and bridge/request-failed when POST /api/toolpacks/toggle fails.',
  inputSchema:object({
   name:{type:'string',description:'Toolpack name to toggle, matching ^[a-z][a-z0-9_-]{0,63}$, e.g. "files".'},
   enabled:{type:'boolean',description:'true enables the pack, false disables it.'},
  },['name','enabled']),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'pkg_set_enabled');
   const name=packName(args.name);
   if(typeof args.enabled!=='boolean')throw fail(`enabled must be a boolean; received ${JSON.stringify(args.enabled)}. Pass true to enable the pack or false to disable it.`,'args/invalid');
   const result=await callBridge(bridge,'toolpacks/toggle',{name,enabled:args.enabled},{timeoutMs:30000});
   return {changed:true,name:result?.name??name,enabled:result?.enabled??args.enabled};
  },
 },
 {
  name:'pkg_install',
  description:'Install a user toolpack from a directory on the bridge host by calling POST /api/toolpacks/import; builtin pack names cannot be replaced. path: absolute directory that contains an index.mjs exporting {meta, tools}; the bridge validates the pack and copies it into ${CODEX_HOME}/toolpacks. Returns {installed:true, name (pack name reported by the bridge, or null), source}. Fails with args/invalid when path is missing or not a string, bridge/token-missing without a handshake, and bridge/request-failed when the bridge cannot read the directory, rejects the pack or the import call fails.',
  inputSchema:object({path:{type:'string',description:'Absolute path of a directory that contains the pack index.mjs.'}},['path']),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'pkg_install');
   const source=needString(args.path,'path');
   const result=await callBridge(bridge,'toolpacks/import',{path:source},{timeoutMs:60000});
   return {installed:true,name:result?.name??null,source};
  },
 },
 {
  name:'context_get',
  description:'Read the bridge context-compaction settings together with the current token usage before deciding whether to change them. Takes no parameters. Returns {enabled, thresholdPercent (usage percentage that triggers compaction), keepRecentTurns (recent turns kept verbatim), autoCompact, summaryModel (null means the active model is used), usage (whatever the bridge reports, usually {totalTokens, contextWindow, percent})}. Fails with bridge/token-missing without a handshake and bridge/request-failed when POST /api/context fails.',
  inputSchema:object({}),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'context_get');
   const value=await callBridge(bridge,'context',{}, {timeoutMs:30000});
   return {
    enabled:value?.enabled??null,
    thresholdPercent:value?.thresholdPercent??null,
    keepRecentTurns:value?.keepRecentTurns??null,
    autoCompact:value?.autoCompact??null,
    summaryModel:value?.summaryModel??null,
    usage:value?.usage??null,
   };
  },
 },
 {
  name:'context_set',
  description:'Change bridge context-compaction settings through POST /api/context/config; only the fields you supply are sent and returned, so omitted settings keep their current value. enabled: turn context accounting on or off. autoCompact: compact automatically when the threshold is crossed. thresholdPercent: integer 10-95, the usage percentage that triggers compaction. keepRecentTurns: integer 0-50, recent turns kept verbatim while summarizing. summaryModel: model id used for summaries, or null/"" to fall back to the active model. Returns the bridge payload, normally {enabled, autoCompact, thresholdPercent, keepRecentTurns, summaryModel, usage}. Fails with args/invalid when no field is supplied or a number is out of range (for example thresholdPercent 5), bridge/token-missing without a handshake, bridge/request-failed when the bridge rejects the write (for example while a turn is running).',
  inputSchema:object({
   enabled:{type:'boolean',description:'Enable context accounting for the bridge.'},
   autoCompact:{type:'boolean',description:'Compact automatically when thresholdPercent is crossed.'},
   thresholdPercent:{type:'integer',minimum:10,maximum:95,description:'Usage percentage 10-95 that triggers compaction.'},
   keepRecentTurns:{type:'integer',minimum:0,maximum:50,description:'Number of recent turns 0-50 kept verbatim when summarizing.'},
   summaryModel:{type:['string','null'],description:'Model id used for summaries; null or "" uses the active model.'},
  }),
  run:contextSet,
 },
 {
  name:'model_list',
  description:'List the models the bridge reports from the Codex app-server (GET /api/models) so you can pick a valid id for model_set. limit: 1-500, default 200; rows beyond the limit are dropped and truncated becomes true. Returns {count (total reported), models (array of model objects as the bridge sends them, passed through unchanged), nextCursor, truncated}. Fails with args/invalid for a limit outside 1-500, bridge/token-missing without a handshake, and bridge/request-failed when the bridge cannot answer the GET (for example the app-server is down).',
  inputSchema:object({limit:{type:'integer',minimum:1,maximum:500,description:'Maximum number of model rows returned, 1-500; defaults to 200.'}}),
  run:modelList,
 },
 {
  name:'model_set',
  description:'Switch the active model, provider, reasoning effort or custom provider base URL through POST /api/config; only supplied fields change. model: model id such as "gpt-5". provider: provider id such as "openai". reasoningEffort: one of none, minimal, low, medium, high, xhigh and applies to new turns. baseUrl: HTTP(S) base URL for a custom provider. Returns {saved:true, ...bridge payload} echoing the accepted values. Fails with args/invalid when no field is supplied or reasoningEffort is not in the enum, bridge/token-missing without a handshake, and bridge/request-failed when the bridge refuses the change (it rejects model changes while a turn is running) or the call times out.',
  inputSchema:object({
   model:{type:'string',description:'Model id to activate, e.g. "gpt-5".'},
   provider:{type:'string',description:'Provider id, e.g. "openai" or a custom provider name.'},
   reasoningEffort:{type:'string',enum:['none','minimal','low','medium','high','xhigh'],description:'Reasoning effort for new turns: none, minimal, low, medium, high or xhigh.'},
   baseUrl:{type:'string',description:'HTTP(S) base URL for a custom provider endpoint.'},
  }),
  run:modelSet,
 },
 {
  name:'persona_get',
  description:'Read the system persona before editing it, so you only change what is needed. Takes no parameters. Returns {name, style, instructions, active, path (absolute AGENTS.md path managed by the bridge, or null)}. Fails with bridge/token-missing without a handshake and bridge/request-failed when POST /api/persona fails.',
  inputSchema:object({}),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'persona_get');
   const value=await callBridge(bridge,'persona',{}, {timeoutMs:30000});
   return {
    name:value?.name??'',
    style:value?.style??'',
    instructions:value?.instructions??'',
    active:value?.active??true,
    path:value?.path??null,
   };
  },
 },
 {
  name:'persona_set',
  description:'Save the system persona through POST /api/persona/save; the bridge writes persona.json and the managed block in AGENTS.md. Supply only the sections you want to change. name: persona name. style: short style guidance. instructions: the system instructions themselves. active: false removes the managed block from AGENTS.md without deleting persona.json, true restores it. An empty string clears that section. Returns the bridge payload, usually {name, style, instructions, active, path}. Fails with args/invalid when no field is supplied or active is not a boolean, bridge/token-missing without a handshake, and bridge/request-failed when the bridge cannot write the files.',
  inputSchema:object({
   name:{type:'string',description:'Persona name.'},
   style:{type:'string',description:'Style guidance for the persona.'},
   instructions:{type:'string',description:'System instructions for the persona.'},
   active:{type:'boolean',description:'false removes the managed AGENTS.md block but keeps persona.json.'},
  }),
  run:personaSet,
 },
 {
  name:'ping',
  description:'Verify that the bridge is actually alive and that the handshake works, before blaming another bridge-backed tool. Takes no parameters. Calls GET /healthz (no token needed) and returns {reachable:true, handshake:true, baseUrl, status (HTTP status), ok (bridge health flag), engine, mode, bridgeRevision, codexVersion, activeTurns}. Fails with bridge/token-missing when ${CODEX_HOME}/codex-go-bridge.json is absent or lacks baseUrl/token, and bridge/request-failed when the handshake exists but /healthz cannot be reached within 5 seconds - in that case restart the bridge instead of retrying.',
  inputSchema:object({}),
  run:ping,
 },
];
