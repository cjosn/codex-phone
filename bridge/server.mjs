// Codex Pocket bridge: the only production engine is official `codex app-server`.
// Protocol baseline: openai/codex rust-v0.170.0 generated app-server schema.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createInterface} from 'node:readline';
import {existsSync,readdirSync,symlinkSync} from 'node:fs';
import {cp,readFile,writeFile,mkdir,readdir,rename,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {normalize} from './adapter.mjs';
import {WorkflowStore} from './workflows.mjs';
import {buildListRequest,buildProbeRequest,fetchWireModels,normalizeWire,parseWireModels,requiresApiKey,start as startCompatProxy,WIRE_NAMES} from './compat-proxy.mjs';
import {buildCodexAttachmentInput} from './attachments.mjs';
import {AgentRunRegistry} from './agent-runs.mjs';
import {completeLocalOAuthCallback} from './account-login.mjs';
import {stageLargeTextAttachments} from './attachment-store.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const arg=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const MODE=arg('mode','app-server');
if(MODE!=='app-server')throw Error('Only the real app-server engine is supported. Test fixtures run as explicitly selected test processes.');
const HOST=arg('host','127.0.0.1');
const PORT=Number(arg('port','8787'));
const TOKEN=arg('token',process.env.CODEX_GO_TOKEN||randomBytes(32).toString('base64url'));
const CODEX=arg('codex',process.env.CODEX_GO_EXECUTABLE||'codex');
// Explicit executable arguments support portable CLI launchers and protocol tests.
const CODEX_ARGS=args.flatMap((value,index)=>value==='--codex-arg'&&args[index+1]?[args[index+1]]:[]);
// 0.170 默认把工具调用交给 `codex-code-mode-host`：codex 只在**自己所在目录**找它。
// 我们的 ARM 运行时把 codex 放在 /opt/codex/bin，而 host 在 /opt/codex/vendor/<triple>/bin，
// 于是任何工具调用都报 `failed to spawn code-mode host ... host executable was not found`，
// 模型只能说「工具无法启动」。这里先补一条相对软链（幂等）；真找不到就关掉 code mode，
// 走回经典 exec 通道——两条路都比「工具全废」强。
const CODE_MODE_HOST_NAME=process.platform==='win32'?'codex-code-mode-host.exe':'codex-code-mode-host';
function codeModeHostPath(){return path.join(path.dirname(path.resolve(CODEX)),CODE_MODE_HOST_NAME);}
function healCodeModeHost(){
 const link=codeModeHostPath();
 try{
  if(existsSync(link))return true;
  const vendor=path.join(path.dirname(path.dirname(path.resolve(CODEX))),'vendor');
  if(!existsSync(vendor))return false;
  for(const triple of readdirSync(vendor)){
   const candidate=path.join(vendor,triple,'bin',CODE_MODE_HOST_NAME);
   if(!existsSync(candidate))continue;
   symlinkSync(candidate,link);
   console.error(`codex-go: linked code-mode host ${candidate} -> ${link}`);
   return true;
  }
 }catch(error){console.error('codex-go: code-mode host heal failed: '+String(error?.message??error));}
 return existsSync(link);
}
const CODE_MODE_READY=healCodeModeHost();
// 注意顺序：先 --codex-arg（测试替身要靠它把 fixture 当成可执行体），再放 codex 自己的开关。
const CODE_MODE_ARGS=CODE_MODE_READY?[]:['-c','features.code_mode=false'];
const BRIDGE_REV='asset-2';
// Advertised to guest processes through ${CODEX_HOME}/codex-go-bridge.json only.
const BRIDGE_VERSION='0.9.5';
const CODEX_HOME=path.resolve(arg('codex-home',process.env.CODEX_HOME||path.join(os.homedir(),'.codex')));
const CWD=path.resolve(arg('cwd',process.cwd()));
const WEB=path.resolve(HERE,'../web');
const SECRET_FILE=path.join(CODEX_HOME,'codex-go-secrets.json');
const HANDSHAKE_FILE=path.join(CODEX_HOME,'codex-go-bridge.json');
const TOOLPACK_STATE_FILE=path.join(CODEX_HOME,'codex-go-toolpacks.json');
const USER_TOOLPACKS=path.join(CODEX_HOME,'toolpacks');
// Contract path on device; without an explicit override the checked-out packs next to
// server.mjs are the local fallback, an explicit override is always honoured literally.
const BUNDLED_TOOLPACKS=path.join(HERE,'toolpacks');
const TOOLPACKS_OVERRIDE=arg('toolpacks',process.env.CODEX_GO_TOOLPACKS||null);
const BUILTIN_TOOLPACKS=path.resolve(TOOLPACKS_OVERRIDE||'/opt/codex-go/bridge/toolpacks');
// 第二阶段（CONTRACT-V2）：上下文设置、系统人设、插件目录。
const CONTEXT_SETTINGS_FILE=path.join(CODEX_HOME,'codex-go-settings.json');
const PERSONA_FILE=path.join(CODEX_HOME,'codex-go-persona.json');
const AGENTS_FILE=path.join(CODEX_HOME,'AGENTS.md');
const PLUGIN_STATE_FILE=path.join(CODEX_HOME,'codex-go-plugins.json');
const USER_PLUGINS=path.join(CODEX_HOME,'plugins');
const USER_SKILLS=path.join(CODEX_HOME,'skills');
const BUNDLED_PLUGINS=path.join(HERE,'plugins');
const PLUGINS_OVERRIDE=arg('plugins',process.env.CODEX_GO_PLUGINS||null);
const BUILTIN_PLUGINS=path.resolve(PLUGINS_OVERRIDE||'/opt/codex-go/bridge/plugins');
// 第三阶段（CONTRACT-V3）：多渠道注册表 + 本机 Responses<->chat 兼容代理。
const CHANNELS_FILE=path.join(CODEX_HOME,'codex-go-channels.json');
const CHANNEL_ID=/^[a-z][a-z0-9-]{0,63}$/;
// 契约 V4：wire 枚举（openai-chat/openai-responses/anthropic/gemini/azure-openai/ollama）由
// compat-proxy 统一维护；旧值 chat/responses 只在读取时归一化，落盘一律用新值。
const CHANNEL_NAME_MAX=120;
const CHANNEL_FIELDS=new Set(['id','name','baseUrl','wire','model','models','apiKey']);
const channelEnvKey=id=>`CODEX_GO_CHANNEL_${id.toUpperCase().replaceAll('-','_')}_KEY`;
const MODELS_TIMEOUT_MS=20000,MODELS_MAX_BYTES=2*1024*1024;
// 渠道探活（POST /api/channels/test）：连接 30s、推理探针 30s。
const CHANNEL_TEST_CONNECT_TIMEOUT_MS=30000,CHANNEL_TEST_INFER_TIMEOUT_MS=30000;
const SUBAGENT_RUNS=20,SUBAGENT_REASONING=new Set(['none','minimal','low','medium','high','xhigh']);
// 包名与 TOOLPACKS-CONTRACT §3 / mcp-server.mjs 保持一致：允许连字符（例如 android-screen）。
const PACK_NAME=/^[a-z][a-z0-9_-]{0,63}$/;
const PLUGIN_NAME=/^[a-z][a-z0-9_-]{0,63}$/;
const SKILL_NAME=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_BODY=128*1024*1024;
// 中转站普遍按 User-Agent 白名单放行（只认 codex_cli_rs/… 等编程客户端）。
const CLI_UA='codex_cli_rs/0.170.0';
const withCliUa=headers=>({...headers,'user-agent':headers['user-agent']||CLI_UA});
// 上下文压缩：契约 B 的固定默认值与自动触发窗口。
const CONTEXT_DEFAULTS=Object.freeze({enabled:true,thresholdPercent:75,keepRecentTurns:4,autoCompact:true,summaryModel:null,contextWindowTokens:null});
const CONTEXT_MIN_PERCENT=10,CONTEXT_MAX_PERCENT=95,CONTEXT_MAX_TURNS=50,AUTO_COMPACT_WINDOW_MS=60000,COMPACT_TIMEOUT_MS=60000;
// 上下文窗口长度由用户填（tokens）。上游一般不报窗口，报的时候也可能不是用户想用的那个模型，
// 所以「用户设置」优先于「上游上报」：百分比与自动压缩阈值都按它算，并标明来源。
const CONTEXT_WINDOW_MIN=1000,CONTEXT_WINDOW_MAX=10000000;
let contextWindowTokensCache=null;
// 人设托管区块：只改这两个标记之间的内容，其余字节保持不动。
const PERSONA_START='<!-- codex-pocket:persona:start -->';
const PERSONA_END='<!-- codex-pocket:persona:end -->';
const PERSONA_LIMITS={name:200,style:2000,instructions:40000};
// AGENTS.md 适合项目说明，但不能单独承担 Agent 行为约束：项目级文件可能覆盖全局人设。
// 这份内置规范在新建会话时通过 codex 的 developerInstructions 注入。
const DEFAULT_AGENT_INSTRUCTIONS=`You are Codex Pocket, an autonomous coding and device agent.
For non-trivial tasks, inspect the relevant files and current state first, make a short plan, then execute the steps instead of stopping at advice or pasted code. Use update_plan when available; otherwise use plan_create, plan_update_step and plan_complete so progress remains visible.
Use the available tools to perform the requested work. Make small, focused changes and verify each change with the most relevant available check.
When a command or tool fails, diagnose the actual output before retrying; do not repeat the same failing action blindly.
Before finishing, review the final result and report only checks that actually ran, including any remaining limitations.
When environment or tool availability is uncertain, inspect it with system/tooling_status or dev/env_probe rather than guessing.
If the MCP tools are not exposed in your tool list (you only see exec_command and write_stdin), or a call comes back "unsupported call: <name>", reach them through the phone CLI instead: run node /opt/codex-go/bridge/phone.mjs screen to read the phone screen as numbered lines, then phone.mjs tap <id>, type, key, scroll, apps, open or collect. Read that screen before every action and never claim you cannot see the phone while that command works.
Respect the active permission boundary and ask before destructive or irreversible actions.`;
const startedAt=Date.now();
let seq=0,stopping=false,codexVersion=null;
const ring=[],sse=new Set(),turns=new Map(),pendingApprovals=new Map(),loadingThreads=new Set();
// 用户点了「本会话允许」的 MCP server：之后该 server 的工具不再逐次弹审批。
const sessionApprovedMcp=new Set();
// 每个 thread 最近一次 turn/start 用的审批策略（never = 完全权限）。
const threadApprovalPolicy=new Map();
// 每个 thread 的沙箱：danger-full-access 时 MCP 工具审批纯属噪音，直接放行。
const threadSandboxMode=new Map();
// thread -> 建线程时绑定的 provider（渠道）。codex 0.170 的 turn/start 只能换 model，
// thread/resume 的 model/modelProvider 会被忽略，只有 thread/fork 能换 provider，
// 所以必须记住绑定关系：否则切渠道后老会话会拿新渠道的模型名去打旧上游（404 重试 5 次）。
const threadProviders=new Map();
// 会话级指令只覆盖全局人设，内置 Agent 规范始终保留；值只存在本机桥进程内。
const threadInstructionOverrides=new Map(),threadInjectedInstructions=new Map();
const subagentRuns=[],subagentWatchers=new Map();
let subagentSeq=0,packState=null,packRootsCache=null;
let contextState=null,personaState=null,pluginState=null,pluginRootsCache=null;
let compatProxy=null,compatPort=null,channelKeysDirty=false;
const usageByThread=new Map(),lastAutoCompact=new Map(),autoCompactInflight=new Set();
let lastUsage=null;
const turnWaiters=new Map(),execWaiters=new Map();
const rpcCode=(code,message,status=400,details)=>Object.assign(new Error(message),{code,status,details});
// 上游 4xx 不是「网络抽风」，重试也没用：把 codex 的原始 JSON 换成用户能照做的说法。
// 依据（真机 + 本地实测 codex 0.170）：404 时 error.codexErrorInfo 是
// responseStreamDisconnected/httpConnectionFailed 带 httpStatusCode，message 里是上游原话。
const MODEL_MISSING=/模型不存在|模型未启用|model[_ -]?not[_ -]?found|model[_ -]?unknown|invalid[_ -]?model|no such model/i;
function upstreamHttpStatus(error){
 return error?.codexErrorInfo?.responseStreamDisconnected?.httpStatusCode??error?.codexErrorInfo?.httpConnectionFailed?.httpStatusCode??null;
}
function friendlyTurnError(error){
 if(!error)return error;
 const text=typeof error==='string'?error:typeof error?.message==='string'?error.message:'';
 if(!text)return error;
 const status=upstreamHttpStatus(error);
 const withMessage=message=>typeof error==='string'?message:{...error,message};
 if(status===404||MODEL_MISSING.test(text))return withMessage('这个渠道没有当前模型（上游回 404 / 模型不存在）：换一个模型，或切到有它的渠道再发一次。');
 if(status===401||status===403)return withMessage(`上游拒绝了这把密钥（HTTP ${status}）：检查渠道的 API Key 是否有效、这个模型是否已开通。`);
 return error;
}
const scrub=value=>String(value).replace(/([?&]token=)[^\s&]+/g,'$1[redacted]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [redacted]');
const secureEqual=(a,b)=>{const aa=Buffer.from(a||''),bb=Buffer.from(b||'');return aa.length===bb.length&&timingSafeEqual(aa,bb);};
// 只有「真的在产出」的事件才续命看门狗：正文/思考/工具/计划/审批。
// `usage`、`account.updated`、`thread.status`、`error`（Reconnecting 噪音）都不算进展——
// 否则上游断流时这些心跳会把 120s 看门狗喂成永不触发，界面就一直「正在思考」。
const TURN_PROGRESS_TYPES=new Set(['turn.start','text.delta','reasoning.delta','tool.start','tool.args.delta','tool.output','tool.end','diff','plan.updated','approval.request']);
function broadcast(event){
 if(event.threadId&&TURN_PROGRESS_TYPES.has(event.type))touchTurn(event.threadId);
 const item={...event,seq:++seq,at:Date.now()};ring.push(item);if(ring.length>6000)ring.shift();
 for(const client of sse){if(client.threadId&&item.threadId&&client.threadId!==item.threadId)continue;client.res.write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);}
 return item;
}
const AGENT_BOARD_FILE=path.join(CODEX_HOME,'codex-go-agents.json');
let agentBoardTimer=null;
function saveAgentBoard(){
 if(agentBoardTimer)return;
 agentBoardTimer=setTimeout(async()=>{
  agentBoardTimer=null;
  try{await writeFile(AGENT_BOARD_FILE+'.tmp',JSON.stringify(agentRegistry.view()),{mode:0o600});await rename(AGENT_BOARD_FILE+'.tmp',AGENT_BOARD_FILE);}
  catch(error){console.error('codex-go: could not save the agent board: '+scrub(error.message));}
 },250).unref();
}
const agentRegistry=new AgentRunRegistry({emit:broadcast,onChange:saveAgentBoard});
const migrateApproval=value=>value==='on-failure'?'on-request':value;

class CodexRpc {
 constructor(){this.process=null;this.pending=new Map();this.id=0;this.ready=false;this.version=null;}
 async start(){
  const secrets=await readSecrets();
  const env={...process.env,CODEX_HOME,...secrets};
  const child=spawn(CODEX,[...CODEX_ARGS,...CODE_MODE_ARGS,'app-server'],{cwd:CWD,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  this.process=child;
  let stderr='';
  child.on('error',error=>this.fail(error));
  child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+scrub(chunk)).slice(-8000);});
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{
   let message;try{message=JSON.parse(line);}catch{return;}
   if(message.id!==undefined&&!message.method){const waiting=this.pending.get(String(message.id));if(!waiting)return;this.pending.delete(String(message.id));clearTimeout(waiting.timer);message.error?waiting.reject(rpcCode('codex/rpc-error',message.error.message||'Codex RPC failed',502,{rpcCode:message.error.code})):waiting.resolve(message.result);return;}
   if(message.method){
    if(message.id!==undefined)this.requestFromCodex(message);
    else this.notification(message.method,message.params||{});
   }
  });
  child.once('exit',(code,signal)=>{
   // A retired child must not reject requests owned by its replacement.
   if(this.process!==child)return;
   const intentional=stopping;
   this.ready=false;
   this.fail(rpcCode('codex/exited',`Codex app-server exited (${code??signal}). ${stderr.trim()}`,503));
   if(!intentional)broadcast({type:'error',code:'codex/exited',message:'Codex app-server exited. Restart the bridge to reconnect.',retryable:true});
  });
  // 身份要按官方 Codex CLI 报：不少中转站按客户端白名单放行（只认 Codex/Claude Code 等），
  // 报成自定义名字会被 403 client_not_allowed。引擎本来就是官方 codex，报这个名字不是伪装。
  const clientName=process.env.CODEX_GO_CLIENT_NAME||'codex_cli_rs';
  const result=await this.call('initialize',{clientInfo:{name:clientName,title:process.env.CODEX_GO_CLIENT_TITLE||'Codex CLI',version:'0.170.0'},capabilities:{experimentalApi:true}},30000);
  this.notify('initialized',{});this.ready=true;
  this.version=result?.userAgent??result?.serverInfo?.version??null;
  codexVersion=this.version;
  return result;
 }
 fail(error){for(const value of this.pending.values()){clearTimeout(value.timer);value.reject(error);}this.pending.clear();}
 call(method,params={},timeout=45000){
  const child=this.process;if(!child||child.exitCode!==null||!child.stdin.writable)return Promise.reject(rpcCode('codex/unavailable','Codex app-server is not available',503));
  const id=++this.id;return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(String(id));reject(rpcCode('codex/timeout',`Codex RPC timed out: ${method}`,504));},timeout);
   this.pending.set(String(id),{resolve,reject,timer});
   child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(String(id));reject(error);}});
  });
 }
 notify(method,params){this.process?.stdin.write(JSON.stringify({method,params})+'\n');}
 reply(id,result,error){this.process?.stdin.write(JSON.stringify(error?{id,error}:{id,result})+'\n');}
 notification(method,params){
   this.notificationExec(method,params);
  if(method==='turn/started'&&params.threadId&&params.turn?.id)turns.set(params.threadId,params.turn.id);
  if(method==='turn/completed'&&params.threadId){
   turns.delete(params.threadId);turnHeartbeat.delete(params.threadId);
    const turnId=params.turn?.id;const waiting=turnWaiters.get(turnId);if(waiting){turnWaiters.delete(turnId);clearTimeout(waiting.timer);waiting.resolve(params.turn);}
   for(const [id,approval] of pendingApprovals){
    if(approval.params.threadId===params.threadId&&(!approval.params.turnId||approval.params.turnId===params.turn?.id)){
     pendingApprovals.delete(id);broadcast({type:'approval.resolved',approvalId:id,threadId:params.threadId,decision:'expired'});
    }
   }
   // 用量可能在 turn 结束前到达；等 turn 释放后再判断自动压缩。
   queueAutoCompact(params.threadId);
  }
   for(const event of normalize(method,params)){if(event.type==='turn.end'&&!event.status?.match(/completed/i))event.error=friendlyTurnError(event.error);agentRegistry.accept(event);subagentEvent(event);broadcast(event);}
  if(method==='error')broadcast({type:'error',threadId:params.threadId,turnId:params.turnId,code:params.error?.codexErrorInfo??'codex/turn-error',message:params.error?.message??params.message??'Codex reported an error',retryable:params.willRetry===true});
  if(method==='thread/tokenUsage/updated'){
   broadcast({type:'usage',threadId:params.threadId,turnId:params.turnId,usage:params.tokenUsage});
   const usage=trackUsage(params.threadId,params.turnId,params.tokenUsage);
   if(usage)broadcast({type:'context.usage',threadId:usage.threadId,totalTokens:usage.totalTokens,contextWindow:usage.contextWindow,contextWindowSource:usage.contextWindowSource,percent:usage.percent});
   queueAutoCompact(params.threadId);
  }
  if(method.startsWith('account/'))broadcast({type:'account.updated',method,...params});
 }
 notificationExec(method,params){
   if(method==='command/exec/terminated'){
    const waiting=execWaiters.get(params.processId);if(waiting){execWaiters.delete(params.processId);clearTimeout(waiting.timer);waiting.resolve({exitCode:params.exitCode??null,stdout:waiting.stdout,stderr:waiting.stderr});}
   }
   if(method==='command/exec/outputDelta'){
    const waiting=execWaiters.get(params.processId);if(waiting){const text=Buffer.from(params.deltaBase64??'','base64').toString('utf8');const key=params.stream==='stderr'?'stderr':'stdout';waiting[key]=(waiting[key]+text).slice(-1048576);}
   }
  }
  requestFromCodex(message){
  const supported=new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','mcpServer/elicitation/request','execCommandApproval','applyPatchApproval']);
  if(!supported.has(message.method)){this.reply(message.id,null,{code:-32601,message:`This mobile client does not yet support ${message.method}`});broadcast({type:'error',threadId:message.params?.threadId,code:'codex/unsupported-interaction',message:`Codex requested ${message.method}, which this client cannot answer yet.`,retryable:false});return;}
  const id=`rpc:${String(message.id)}`;
  const threadId=message.params?.threadId;
  const policy=threadId?threadApprovalPolicy.get(threadId):null;
  const sandbox=threadId?threadSandboxMode.get(threadId):null;
  const serverName=String(message.params?.serverName??'');
  const auto=policy==='never'||sandbox==='danger-full-access'||(message.method==='mcpServer/elicitation/request'&&serverName&&sessionApprovedMcp.has(serverName));
  if(auto){
   if(message.method==='mcpServer/elicitation/request')this.reply(message.id,{action:'accept',content:null,_meta:null});
   else if(message.method.includes('permissions'))this.reply(message.id,{permissions:message.params?.permissions??{},scope:'turn'});
   else this.reply(message.id,{decision:'accept'});
   broadcast({type:'approval.auto',threadId,approvalId:id,serverName,decision:'accept',reason:policy==='never'?'完全权限':'本会话已允许'});
   return;
  }
  pendingApprovals.set(id,{id:message.id,method:message.method,params:message.params||{}});
  for(const event of normalize(message.method,message.params||{},{isRequest:true,requestId:message.id})){
   const {_internal,...publicEvent}=event;broadcast({...publicEvent,approvalId:id});
  }
 }
 async restart(){
  if(turns.size)throw rpcCode('codex/busy','Finish or interrupt all turns before changing provider credentials',409);
  const child=this.process;this.process=null;this.ready=false;
  if(child){child.stdin.end();child.kill();}
  pendingApprovals.clear();
  loadingThreads.clear();
  await this.start();
 }
}
async function healDanglingProvider(){
 const file=path.join(CODEX_HOME,'config.toml');
 let text;try{text=await readFile(file,'utf8');}catch{return;}
 const match=text.match(/^[ \t]*model_provider[ \t]*=[ \t]*"([^"]+)"/m);
 if(!match||match[1]==='openai')return;
 const id=match[1];
 const section=new RegExp(`^[ \\t]*\\[model_providers\\.${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\]`,'m');
 if(section.test(text))return;
 const healed=text.replace(/^[ \t]*model_provider[ \t]*=[ \t]*"[^"]+"/m,'model_provider = "openai"');
 await writeFile(file,healed);
 console.error(`codex-go: healed dangling model_provider "${id}" -> openai`);
}
const rpc=new CodexRpc();

// 卡死回合看门狗：上游断流时 Codex 会重试 5 次然后可能既不发 turn/completed 也不发 failed，
// 界面就会永远「正在思考」。这里按「该 thread 多久没有任何事件」判定卡死并主动收尾。
const turnHeartbeat=new Map();
// 5 分钟没进展才算卡死：部分中转站（实测 ly77625 的 deepseek-v4.1-flash）首字要 70–90s，
// 120s 会把「慢但活着」的回合误杀。真卡死的表现是永远不结束，5 分钟足够兜住。
const TURN_STALL_MS=Number(process.env.CODEX_GO_TURN_STALL_MS||300000);
// 检查间隔单独可调：测试要能在秒级验证「重试噪音不算活着」，默认仍是 15s。
const TURN_STALL_CHECK_MS=Number(process.env.CODEX_GO_TURN_STALL_CHECK_MS||15000);
function touchTurn(threadId){if(threadId)turnHeartbeat.set(threadId,Date.now());}
setInterval(()=>{
 for(const [threadId,turnId] of [...turns.entries()]){
  const seen=turnHeartbeat.get(threadId)||0;
  if(Date.now()-seen<TURN_STALL_MS)continue;
  turns.delete(threadId);turnHeartbeat.delete(threadId);
  if(turnId&&turnId!=='starting')rpc.call('turn/interrupt',{threadId,turnId}).catch(()=>{});
  broadcast({type:'turn.end',threadId,turnId,status:'failed',error:`回合长时间没有进展（${Math.round(TURN_STALL_MS/1000)}s），已中断；可重试或新建对话`});
 }
},TURN_STALL_CHECK_MS).unref();

async function executeWorkflowPrompt(step){
 let threadId=step.threadId;
 if(!threadId){const developerInstructions=await effectiveDeveloperInstructions();const value=await rpc.call('thread/start',{cwd:CWD,developerInstructions});threadId=value.thread?.id;if(!threadId)throw Error('Codex did not create a workflow thread');loadingThreads.add(threadId);threadInjectedInstructions.set(threadId,developerInstructions);}
 else await prepareThreadInstructions(threadId);
 if(turns.has(threadId))throw rpcCode('codex/thread-busy','Workflow prompt thread already has a running turn',409);
 const value=await rpc.call('turn/start',{threadId,input:[{type:'text',text:step.text}],summary:'auto'});const turnId=value.turn?.id;if(!turnId)throw Error('Codex did not start a workflow turn');
 turns.set(threadId,turnId);
 const turn=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{turnWaiters.delete(turnId);reject(Error('Workflow prompt timed out'));},1800000);turnWaiters.set(turnId,{resolve,timer});});
 if(turn.status!=='completed')throw Error(turn.error?.message||`Workflow prompt ended with ${turn.status}`);
 return {threadId,turnId,status:turn.status};
}
async function executeWorkflowShell(step){
 const processId=`workflow-${randomBytes(12).toString('hex')}`;let waiter;
 const completion=new Promise((resolve,reject)=>{waiter={resolve,stdout:'',stderr:''};execWaiters.set(processId,waiter);});
 try{
  const value=await rpc.call('command/exec',{command:step.argv,processId,tty:true,streamStdin:false,streamStdoutStderr:true,cwd:step.cwd||CWD,disableTimeout:false,...(step.timeoutMs?{timeoutMs:step.timeoutMs}:{})},step.timeoutMs?step.timeoutMs+5000:130000);
  if(value?.exitCode!==undefined)return {process:'codex-pty',processId,exitCode:value.exitCode,stdout:value.stdout??'',stderr:value.stderr??''};
  const timeoutMs=step.timeoutMs||120000;waiter.timer=setTimeout(()=>{execWaiters.delete(processId);rpc.call('command/exec/terminate',{processId}).catch(()=>{});waiter.reject(Error('Workflow shell step timed out'));},timeoutMs+5000);
  const result=await completion;if(result.exitCode!==0)throw Error(`Workflow command exited with ${result.exitCode}`);return {process:'codex-pty',processId,...result};
 }catch(error){execWaiters.delete(processId);throw error;}
}
const workflowStore=new WorkflowStore(CODEX_HOME,{executePrompt:executeWorkflowPrompt,executeShell:executeWorkflowShell,onChange:run=>broadcast({type:'workflow.run.updated',workflowId:run.workflowId,runId:run.id,status:run.status})});

async function readSecrets(){try{const value=JSON.parse(await readFile(SECRET_FILE,'utf8'));return Object.fromEntries(Object.entries(value).filter(([key,val])=>/^CODEX_GO_[A-Z0-9_]+_KEY$/.test(key)&&typeof val==='string'));}catch(error){if(error.code==='ENOENT')return {};throw error;}}
async function saveSecrets(values){await mkdir(CODEX_HOME,{recursive:true,mode:0o700});const temporary=SECRET_FILE+'.tmp';await writeFile(temporary,JSON.stringify(values)+'\n',{mode:0o600});await rename(temporary,SECRET_FILE);}
async function rawConfig(){return rpc.call('config/read',{includeLayers:false});}
function configValue(raw){return raw?.config??raw??{};}
async function configView(){
 const config=configValue(await rawConfig());const provider=config.model_provider??config.modelProvider??'openai';const profile=config.model_providers?.[provider]??config.modelProviders?.[provider]??{};
 const secrets=await readSecrets();
  return {provider,model:config.model??null,baseUrl:profile.base_url??profile.baseUrl??null,apiKeyConfigured:!!(profile.env_key&&(secrets[profile.env_key]||process.env[profile.env_key]))||!!profile.experimental_bearer_token,
   envKey:profile.env_key??null,secretsFile:SECRET_FILE,secretsCount:Object.keys(secrets).length,
   apiKeySource:profile.env_key&&secrets[profile.env_key]?'bridge-secret':profile.env_key&&process.env[profile.env_key]?'process-env':profile.experimental_bearer_token?'profile-token':'none',
   approvalPolicy:config.approval_policy??'on-request',sandboxMode:config.sandbox_mode??null};
}
async function configure(body){
 if(turns.size)throw Object.assign(rpcCode('codex/busy','Cannot change provider settings during an active turn',409),{details:{activeTurns:[...turns.keys()],hint:'Interrupt the active turn, then save again'}});
 const allowed=new Set(['provider','model','baseUrl','apiKey','approvalPolicy','reasoningEffort','sandboxMode']);for(const key of Object.keys(body))if(!allowed.has(key))throw rpcCode('request/invalid',`Unknown configuration field: ${key}`);
 const current=await configView();
  const RESERVED_PROVIDERS=new Set(['openai','anthropic','azure','bedrock','vertex','gemini','ollama']);
  let provider=body.provider??current.provider;
  // 内置 provider 不能覆盖；用户填了自定义 Base URL 就自动改名为 <id>-custom，而不是甩一串报错。
  if(body.baseUrl&&RESERVED_PROVIDERS.has(provider))provider=provider+'-custom';
 if(typeof provider!=='string'||! /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(provider))throw rpcCode('config/provider','Use a simple provider identifier');
 const edits=[];const set=(keyPath,value)=>edits.push({keyPath,value,mergeStrategy:'replace'});
 if(body.model!==undefined){if(typeof body.model!=='string'||!body.model.trim())throw rpcCode('config/model','A model ID is required');set('model',body.model.trim());}
 let secretRef;
 if(body.baseUrl!==undefined&&body.baseUrl!==''){
  let url;try{url=new URL(body.baseUrl);}catch{throw rpcCode('config/base-url','Provider Base URL must be absolute HTTP(S)');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw rpcCode('config/base-url','Use an HTTP(S) endpoint without embedded credentials, query or fragment');
  secretRef=`CODEX_GO_${provider.toUpperCase().replaceAll('-','_')}_KEY`;
  const existing=configValue(await rawConfig()).model_providers?.[provider]??{};
   const profile={name:provider,base_url:normalizeBaseUrl(url.toString(),'openai-responses'),wire_api:'responses',env_key:secretRef};
   // codex 的 config/read 会把可选字段回成 null，直接展开会让 batchWrite 报 "invalid type: null"。
   for(const [key,value] of Object.entries(existing))if(value!==null&&value!==undefined&&!(key in profile))profile[key]=value;
   set('model_providers.'+provider,profile);
 } else if(provider!=='openai'&&provider!==current.provider)throw rpcCode('config/base-url','A custom provider requires a Base URL');
 if(body.apiKey!==undefined){
  if(typeof body.apiKey!=='string'||!body.apiKey.trim())throw rpcCode('config/api-key','API Key must be nonempty when supplied');
  secretRef??=`CODEX_GO_${provider.toUpperCase().replaceAll('-','_')}_KEY`;
  if(provider==='openai'&&!body.baseUrl)throw rpcCode('config/api-key','For API-key access, configure a named Responses provider and its Base URL, or use Codex account login');
 }
 set('model_provider',provider);
 if(body.approvalPolicy!==undefined){const approvalPolicy=migrateApproval(body.approvalPolicy);if(!['on-request','untrusted','never'].includes(approvalPolicy))throw rpcCode('config/approval','Unsupported Codex approval policy');set('approval_policy',approvalPolicy);}
  if(body.sandboxMode!==undefined){if(!['read-only','workspace-write','danger-full-access'].includes(body.sandboxMode))throw rpcCode('config/sandbox','Unsupported sandbox mode');set('sandbox_mode',body.sandboxMode);}
 if(body.reasoningEffort!==undefined){if(!['none','minimal','low','medium','high','xhigh'].includes(body.reasoningEffort))throw rpcCode('config/reasoning','Unsupported reasoning effort');set('model_reasoning_effort',body.reasoningEffort);}
 await rpc.call('config/batchWrite',{edits,reloadUserConfig:true});
 if(body.apiKey!==undefined){const secrets=await readSecrets();secrets[secretRef]=body.apiKey;await saveSecrets(secrets);await rpc.restart();}
 return {...await configView(),...(body.approvalPolicy==='on-failure'?{migrated:true}:{})};
}

// ---- 契约 B：多渠道（codex-go-channels.json + 本机兼容代理）----
// 优先级：/api/config 与 /api/channels/activate 写的是同一份 codex 配置，后写者生效。
// /api/config 管理「当前活动 provider」的凭据与审批/沙箱/推理等运行设置；渠道 API 只写
// model_providers.<id> + model_provider + model，不碰 approval_policy / sandbox_mode /
// model_reasoning_effort，所以两者互不覆盖。activate 沿用 configure 的 busy 规则：
// 有活动回合时返回 409 + details.activeTurns。
function rejectChannelFields(body,allowed=CHANNEL_FIELDS){for(const key of Object.keys(body))if(!allowed.has(key))throw rpcCode('request/invalid',`Unknown channel field: ${key}`);}
function requireChannelId(body){
 const value=body.id;
 if(typeof value!=='string'||!CHANNEL_ID.test(value))throw rpcCode('channel/id','Channel id must match ^[a-z][a-z0-9-]{0,63}$',400,{id:value??null});
 return value;
}
function channelFieldName(value){
 if(typeof value!=='string'||!value.trim())throw rpcCode('channel/name','A channel name is required');
 const name=value.trim();
 if(name.length>CHANNEL_NAME_MAX)throw rpcCode('channel/name',`Channel name must be at most ${CHANNEL_NAME_MAX} characters`);
 return name;
}
function channelFieldWire(value){
 // 兼容旧值：chat -> openai-chat，responses -> openai-responses；持久化用规范值。
 const wire=normalizeWire(value);
 if(!wire)throw rpcCode('channel/wire',`wire must be one of ${WIRE_NAMES.join(', ')} (legacy chat/responses are accepted and normalized)`);
 return wire;
}
function channelFieldBaseUrl(value,wire='openai-responses'){
 try{return normalizeBaseUrl(value,wire);}
 catch(error){throw rpcCode('channel/base-url',error.message,400);}
}
function channelFieldModel(value){
 if(typeof value!=='string'||!value.trim())throw rpcCode('channel/model','model must be a nonempty string');
 if(value.trim().length>200)throw rpcCode('channel/model','model must be at most 200 characters');
 return value.trim();
}
function channelFieldModels(value){
 if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw rpcCode('channel/models','models must be an array of model ids');
 return [...new Set(value.map(item=>item.trim()).filter(Boolean))].slice(0,500);
}
async function readChannels(){
 let text;
 try{text=await readFile(CHANNELS_FILE,'utf8');}
 catch(error){if(error.code==='ENOENT')return {active:null,channels:[]};throw rpcCode('channel/state',`Cannot read channels: ${error.message}`,500,{path:CHANNELS_FILE});}
 let value;
 try{value=JSON.parse(text);}catch{throw rpcCode('channel/state','codex-go-channels.json is not valid JSON',500,{path:CHANNELS_FILE});}
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.channels))throw rpcCode('channel/state','Channels must be {"active": id|null, "channels": [...]}',500,{path:CHANNELS_FILE});
 const seen=new Set(),channels=[];
 for(const raw of value.channels){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw rpcCode('channel/state','Channel entries must be objects',500,{path:CHANNELS_FILE});
  const id=raw.id;
  if(typeof id!=='string'||!CHANNEL_ID.test(id))throw rpcCode('channel/state','Channel ids must match ^[a-z][a-z0-9-]{0,63}$',500,{path:CHANNELS_FILE});
  if(seen.has(id))throw rpcCode('channel/state',`Duplicate channel id: ${id}`,500,{path:CHANNELS_FILE});
  seen.add(id);
  channels.push({id,
   name:typeof raw.name==='string'&&raw.name.trim()?raw.name.trim():id,
   baseUrl:typeof raw.baseUrl==='string'?raw.baseUrl:'',
   wire:normalizeWire(raw.wire)??'openai-chat',
   model:typeof raw.model==='string'&&raw.model.trim()?raw.model.trim():null,
   models:Array.isArray(raw.models)?raw.models.filter(item=>typeof item==='string'):[],
   envKey:typeof raw.envKey==='string'&&/^CODEX_GO_[A-Z0-9_]+_KEY$/.test(raw.envKey)?raw.envKey:channelEnvKey(id)});
 }
 const active=typeof value.active==='string'&&seen.has(value.active)?value.active:null;
 return {active,channels};
}
async function writeChannels(state){
 await mkdir(CODEX_HOME,{recursive:true,mode:0o700});
 const payload={active:state.active??null,channels:state.channels.map(channel=>({id:channel.id,name:channel.name,baseUrl:channel.baseUrl,wire:channel.wire,model:channel.model??null,models:[...(channel.models??[])],envKey:channel.envKey}))};
 const temporary=CHANNELS_FILE+'.tmp';
 await writeFile(temporary,JSON.stringify(payload,null,1)+'\n',{mode:0o600});
 await rename(temporary,CHANNELS_FILE);
 return payload;
}
// 密钥只写 codex-go-secrets.json，任何 GET/列表响应只暴露 apiKeyConfigured。
function channelView(channel,active,secrets){
 return {id:channel.id,name:channel.name,baseUrl:channel.baseUrl,wire:channel.wire,
  model:channel.model??null,models:[...(channel.models??[])],
  apiKeyConfigured:!!(channel.envKey&&(secrets[channel.envKey]||process.env[channel.envKey])),
  active:channel.id===active};
}
async function channelSecret(channel){const secrets=await readSecrets();return (channel?.envKey&&(secrets[channel.envKey]||process.env[channel.envKey]))||null;}
async function channelListView(){const state=await readChannels();const secrets=await readSecrets();return {active:state.active,channels:state.channels.map(channel=>channelView(channel,state.active,secrets))};}
async function activeChannelRecord(){const state=await readChannels();return state.channels.find(channel=>channel.id===state.active)??null;}
// codex 把 provider 绑在 thread 上（实测 0.170：turn/start 只认 model，thread/resume 的
// model/modelProvider 被忽略，只有 thread/fork 能换 provider），所以要记住每个 thread 的 provider。
function rememberThreadProvider(threadId,provider){if(typeof threadId==='string'&&threadId&&typeof provider==='string'&&provider)threadProviders.set(threadId,provider);}
function uniqueChannelId(channels,name){
 const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);
 const base=slug&&/^[a-z]/.test(slug)?slug:`channel-${channels.length+1}`;
 let candidate=base,index=2;
 while(channels.some(channel=>channel.id===candidate))candidate=`${base}-${index++}`;
 return candidate;
}
async function reuseProviderSecret(channel){
 // 只在地址等价时复用（忽略结尾斜杠与 /v1 差异），避免把 A 站的密钥发给 B 站。
 const normalize=value=>String(value??'').trim().replace(/\/+$/,'').replace(/\/v1$/i,'');
 const wanted=normalize(channel.baseUrl);
 const secrets=await readSecrets();
 const cfg=configValue(await rawConfig());
 const providers=cfg.model_providers??cfg.modelProviders??{};
 for(const [id,profile] of Object.entries(providers)){
  if(normalize(profile?.base_url??profile?.baseUrl)!==wanted)continue;
  const envKey=profile?.env_key;
  if(!envKey||!secrets[envKey])continue;
  if(secrets[channel.envKey])return false;
  secrets[channel.envKey]=secrets[envKey];
  await saveSecrets(secrets);
  return true;
 }
 return false;
}
async function saveChannel(body){
 rejectChannelFields(body);
 const state=await readChannels();
 const name=channelFieldName(body.name);
 const wire=channelFieldWire(body.wire);
 const baseUrl=channelFieldBaseUrl(body.baseUrl,wire);
 const model=body.model===undefined||body.model===null||body.model===''?null:channelFieldModel(body.model);
 const models=body.models===undefined?null:channelFieldModels(body.models);
 if(body.apiKey!==undefined&&(typeof body.apiKey!=='string'||!body.apiKey.trim()))throw rpcCode('channel/api-key','API Key must be nonempty when supplied');
 const id=body.id===undefined?uniqueChannelId(state.channels,name):requireChannelId(body);
 const existing=state.channels.find(channel=>channel.id===id)??null;
 const channel={id,name,baseUrl,wire,model,models:models??existing?.models??[],envKey:existing?.envKey??channelEnvKey(id)};
 const next={active:state.active,channels:existing?state.channels.map(item=>item.id===id?channel:item):[...state.channels,channel]};
 if(body.apiKey!==undefined){const secrets=await readSecrets();secrets[channel.envKey]=body.apiKey.trim();await saveSecrets(secrets);channelKeysDirty=true;}
 else if(!existing){
  // 迁移友好：用户以前在 /api/config 里配过同地址的 provider，就把那把密钥带过来，
  // 否则新建渠道会显示「未配置」并 401（用户看到的就是“接不进来”）。
  const reused=await reuseProviderSecret(channel);
  if(reused)channelKeysDirty=true;
 }
 await writeChannels(next);
 // 编辑活动渠道要立刻生效；有活动回合时留到下一次 activate（与 configure 的 busy 规则一致）。
 if(next.active===id&&!turns.size)await applyChannelConfig(channel);
 // 新密钥要进 codex 进程环境，重启 app-server 才生效；只在没有活动回合时做。
 if(channelKeysDirty&&!turns.size){await rpc.restart();channelKeysDirty=false;}
 return channelView(channel,next.active,await readSecrets());
}
async function removeChannel(body){
 rejectChannelFields(body,new Set(['id']));
 const id=requireChannelId(body);
 const state=await readChannels();
 const channel=state.channels.find(item=>item.id===id);
 if(!channel)throw rpcCode('channel/unknown',`Unknown channel: ${id}`,404,{id});
 const channels=state.channels.filter(item=>item.id!==id);
 const wasActive=state.active===id;
 const active=wasActive?channels[0]?.id??null:state.active;
 await writeChannels({active,channels});
 // 删活动渠道自动切到第一个剩余渠道；一个都不剩就清掉它的 provider 条目。
 // 非活动渠道保留 model_providers 条目，避免误删其它入口仍在用的配置。
 if(wasActive){
  if(active)await applyChannelConfig(channels.find(item=>item.id===active));
  else await rpc.call('config/batchWrite',{edits:[
   {keyPath:`model_providers.${id}`,value:null,mergeStrategy:'replace'},
   // 只删 provider 条目会让 model_provider 指向一个不存在的 provider，codex 之后所有
   // RPC 都会报 "Model provider `id` not found"。要把活动 provider 一并复位。
   {keyPath:'model_provider',value:'openai',mergeStrategy:'replace'},
  ],reloadUserConfig:true});
 }
 return {removed:true,id,active};
}
async function activateChannel(body){
 rejectChannelFields(body,new Set(['id','interruptAll']));
 const id=requireChannelId(body);
 const state=await readChannels();
 const channel=state.channels.find(item=>item.id===id);
 if(!channel)throw rpcCode('channel/unknown',`Unknown channel: ${id}`,404,{id});
 // 已经在跑的回合绑死了旧 provider，切渠道后它只会在旧上游上重试到 5 次：
 // 默认先把它停掉（interruptAll:false 可保留旧的 409 行为）。
 const interrupted=[];
 if(turns.size){
  if(body.interruptAll===false)throw Object.assign(rpcCode('codex/busy','Cannot switch provider channels during an active turn',409),{details:{activeTurns:[...turns.keys()],hint:'Interrupt the active turn, then switch channels'}});
  for(const [threadId,turnId] of [...turns.entries()]){
   if(turnId==='starting'){turns.delete(threadId);turnHeartbeat.delete(threadId);interrupted.push({threadId,turnId:null,reason:'turn was still starting'});continue;}
   try{await rpc.call('turn/interrupt',{threadId,turnId});turns.delete(threadId);turnHeartbeat.delete(threadId);interrupted.push({threadId,turnId});}
   catch(error){interrupted.push({threadId,turnId,error:scrub(error.message||'interrupt failed')});}
  }
 }
 await applyChannelConfig(channel);
 await writeChannels({active:id,channels:state.channels});
 if(channelKeysDirty){await rpc.restart();channelKeysDirty=false;}
 return {...await channelListView(),interrupted};
}
async function channelModels(body){
 rejectChannelFields(body,new Set(['id','baseUrl','wire','apiKey']));
 const state=await readChannels();
 let channel=null;
 if(body.id!==undefined){
  const id=requireChannelId(body);
  channel=state.channels.find(item=>item.id===id)??null;
  if(!channel)throw rpcCode('channel/unknown',`Unknown channel: ${id}`,404,{id});
 }
 const wire=body.wire!==undefined?channelFieldWire(body.wire):channel?.wire??'openai-chat';
 const baseUrl=body.baseUrl!==undefined?channelFieldBaseUrl(body.baseUrl,wire):channel?channelFieldBaseUrl(channel.baseUrl,wire):null;
 if(!baseUrl)throw rpcCode('channel/base-url','Supply a channel id or a Base URL');
 if(body.apiKey!==undefined&&typeof body.apiKey!=='string')throw rpcCode('channel/api-key','apiKey must be a string when supplied');
 const supplied=typeof body.apiKey==='string'&&body.apiKey.trim()?body.apiKey.trim():null;
 const apiKey=supplied??(channel?await channelSecret(channel):null);
 // 契约 A：ollama 本地无鉴权，其它 wire 都必须有密钥。每种 wire 走自己的清单端点/鉴权/解析。
 if(!apiKey&&requiresApiKey(wire))throw rpcCode('channel/api-key','No API key is configured for this channel',400,{id:channel?.id??null,wire});
 let result;
 try{result=await fetchWireModels({wire,baseUrl,apiKey:apiKey??null});}
 catch(error){error.details={...error.details,baseUrl,wire};throw error;}
 return {baseUrl:result.baseUrl,models:result.models.map(model=>({id:model.id})),count:result.count};
}
function testErrorText(value){
 const text=String(value??'').replace(/\s+/g,' ').trim();
 return text.length>200?`${text.slice(0,200)}…`:text;
}
// 契约 C：POST /api/channels/test 分阶段探活 connect -> auth -> list -> infer。
// 成功返回 {ok,wire,models,latencyMs}；失败一律 502 并带 details.stage，UI 才能说清卡在哪一步。
async function channelTest(body){
 rejectChannelFields(body,new Set(['id']));
 const started=Date.now();
 const id=requireChannelId(body);
 const state=await readChannels();
 const channel=state.channels.find(item=>item.id===id)??null;
 if(!channel)throw rpcCode('channel/unknown',`Unknown channel: ${id}`,404,{id});
 const wire=normalizeWire(channel.wire)??'openai-chat';
 const fail=(code,message,details)=>rpcCode(code,message,502,{id,wire,latencyMs:Date.now()-started,...details});
 const baseUrl=channelFieldBaseUrl(channel.baseUrl,wire);
 const apiKey=await channelSecret(channel);
 if(requiresApiKey(wire)&&!apiKey)throw fail('channel/test','No API key is configured for this channel',{stage:'auth'});
 if(!channel.model)throw fail('channel/test','Choose a model for this channel before testing it',{stage:'infer'});
 // connect / auth / list：一次清单请求按 HTTP 结果分阶段判定。
 const listRequest=buildListRequest({wire,baseUrl,apiKey});
 const controller=new AbortController();
 const connectTimer=setTimeout(()=>controller.abort(),CHANNEL_TEST_CONNECT_TIMEOUT_MS);
 let response;
 try{
  response=await fetch(listRequest.url,{method:'GET',headers:withCliUa(listRequest.headers),signal:controller.signal});
 }catch(error){
  clearTimeout(connectTimer);
  const timeout=error?.name==='TimeoutError'||error?.name==='AbortError';
  throw fail('channel/test',timeout?`Upstream did not answer within ${CHANNEL_TEST_CONNECT_TIMEOUT_MS}ms`:`Could not connect to the upstream: ${testErrorText(error?.message??'network error')}`,{stage:'connect',timeout});
 }
 clearTimeout(connectTimer);
 if(response.status===401||response.status===403){
  await response.text().catch(()=> {});
  throw fail('channel/test',`Upstream rejected the credentials (HTTP ${response.status})`,{stage:'auth',status:response.status});
 }
 // 契约 A：模型清单响应体上限 1 MiB。
 const declared=Number(response.headers.get('content-length')??0);
 if(Number.isFinite(declared)&&declared>listRequest.maxBytes)throw fail('channel/test',`Upstream model list exceeds ${listRequest.maxBytes} bytes`,{stage:'list',status:response.status});
 let text;
 try{text=await response.text();}
 catch{throw fail('channel/test','Could not read the upstream model list',{stage:'list',status:response.status});}
 if(text.length>listRequest.maxBytes)throw fail('channel/test',`Upstream model list exceeds ${listRequest.maxBytes} bytes`,{stage:'list',status:response.status});
 if(!response.ok)throw fail('channel/test',`Upstream model list failed (HTTP ${response.status}): ${testErrorText(text)}`,{stage:'list',status:response.status});
 let models;
 try{models=parseWireModels(wire,JSON.parse(text));}
 catch{throw fail('channel/test',`Upstream returned an unusable model list: ${testErrorText(text)}`,{stage:'list',status:response.status});}
 // infer：一次极小的非流式请求，验证这把密钥真的能出字。
 const probe=buildProbeRequest({wire,baseUrl,apiKey,model:channel.model});
 let probeResponse;
 try{
  probeResponse=await fetch(probe.url,{method:'POST',headers:withCliUa(probe.headers),body:JSON.stringify(probe.body),signal:AbortSignal.timeout(CHANNEL_TEST_INFER_TIMEOUT_MS)});
 }catch(error){
  const timeout=error?.name==='TimeoutError'||error?.name==='AbortError';
  throw fail('channel/test',timeout?`Upstream did not answer the probe within ${CHANNEL_TEST_INFER_TIMEOUT_MS}ms`:`Upstream probe failed: ${testErrorText(error?.message??'network error')}`,{stage:'infer',timeout});
 }
 const probeText=await probeResponse.text().catch(()=> '');
 if(!probeResponse.ok)throw fail('channel/test',`Upstream rejected the probe (HTTP ${probeResponse.status}): ${testErrorText(probeText)}`,{stage:'infer',status:probeResponse.status});
 try{JSON.parse(probeText);}
 catch{throw fail('channel/test','Upstream probe did not return JSON',{stage:'infer',status:probeResponse.status});}
 return {ok:true,id,wire,baseUrl,models:models.length,latencyMs:Date.now()-started};
}
async function applyChannelConfig(channel){
 if(!channel)throw rpcCode('channel/unknown','No channel is selected',404);
 let baseUrl=channel.baseUrl;
 // 契约 A/B：除 openai-responses 直连外，所有 wire 都指向本机代理，由代理去适配方言。
 if(channel.wire!=='openai-responses'){
  if(!compatPort)throw rpcCode('channel/proxy-unavailable','The local compatibility proxy is not running',503);
  baseUrl=`http://127.0.0.1:${compatPort}/v1/${channel.id}`;
 }
 const existing=configValue(await rawConfig()).model_providers?.[channel.id]??{};
 const profile={name:channel.name,base_url:baseUrl,wire_api:'responses',env_key:channel.envKey};
 // codex 的 config/read 会把可选字段回成 null，直接展开会让 batchWrite 报 "invalid type: null"。
 for(const [key,value] of Object.entries(existing))if(value!==null&&value!==undefined&&!(key in profile))profile[key]=value;
 const edits=[{keyPath:`model_providers.${channel.id}`,value:profile,mergeStrategy:'replace'},{keyPath:'model_provider',value:channel.id,mergeStrategy:'replace'}];
 if(channel.model)edits.push({keyPath:'model',value:channel.model,mergeStrategy:'replace'});
 await rpc.call('config/batchWrite',{edits,reloadUserConfig:true});
 return profile;
}
// 兼容代理按 channelId 反查渠道；未知 id 返回 null（代理回 404 channel/unknown）。
async function compatLookupChannel(id){
 const state=await readChannels();
 const channel=state.channels.find(item=>item.id===id);
 if(!channel)return null;
 return {id:channel.id,name:channel.name,baseUrl:channel.baseUrl,wire:channel.wire,model:channel.model,models:channel.models,apiKey:await channelSecret(channel)};
}
// 「把会话搬到当前渠道」= 停掉在跑的回合 → fork 到当前 provider → 回新 threadId 与历史。
// 为什么必须合成一个接口：App 里分两步做（activate → fork）时，如果回合还没停干净，
// fork 会失败被吞掉，用户看到的就是「换了渠道就连不上」。这里先把忙碌状态处理干净再 fork。
async function waitThreadIdle(threadId,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  const current=turns.get(threadId);
  if(!current)return true;
  if(current!=='starting')await rpc.call('turn/interrupt',{threadId,turnId:current}).catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,150));
 }
 return !turns.has(threadId);
}
async function rebindThread(body){
 for(const key of Object.keys(body))if(!['threadId','model','archiveSource'].includes(key))throw rpcCode('request/invalid',`Unknown rebind field: ${key}`);
 const threadId=requireString(body,'threadId');
 const channel=await activeChannelRecord();
 if(!channel)throw rpcCode('channel/unknown','No channel is selected; activate one first',404);
 const bound=threadProviders.get(threadId)??null;
 if(bound===channel.id)return {threadId,channel:bound,forked:false};
 // 正在跑的回合绑的是旧 provider，先停下来（fork 需要一个干净的历史）。
 if(!await waitThreadIdle(threadId,10000))throw rpcCode('codex/thread-busy','This thread still has a running turn; stop it and retry',409,{threadId});
 const model=typeof body.model==='string'&&body.model.trim()?body.model.trim():channel.model??null;
 const developerInstructions=await effectiveDeveloperInstructions(threadId);
 const value=await rpc.call('thread/fork',{threadId,developerInstructions,...(model?{model}:{}),modelProvider:channel.id});
 const forkedId=value.thread?.id;if(!forkedId)throw rpcCode('codex/protocol','thread/fork did not return a thread',502);
 loadingThreads.add(forkedId);threadInjectedInstructions.set(forkedId,developerInstructions);if(threadInstructionOverrides.has(threadId))threadInstructionOverrides.set(forkedId,threadInstructionOverrides.get(threadId));
 rememberThreadProvider(forkedId,value.modelProvider??channel.id);
 broadcast({type:'thread.changed',threadId:forkedId});
 // 只保留搬过去的会话：源 thread 归档掉，抽屉里就不会多出一条重复对话。
 if(body.archiveSource!==false)await rpc.call('thread/archive',{threadId}).catch(()=>{});
 return {threadId:forkedId,from:threadId,channel:channel.id,model:value.model??model,forked:true,thread:value.thread};
}

async function addMcpServer(body){
 const allowed=new Set(['name','command','args','env','cwd','enabled','startupTimeoutSec','toolTimeoutSec']);for(const key of Object.keys(body))if(!allowed.has(key))throw rpcCode('request/invalid',`Unknown MCP field: ${key}`);
 const name=requireString(body,'name'),command=requireString(body,'command');if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))throw rpcCode('request/invalid','MCP name must be a simple identifier without dots');
 const args=body.args??[];if(!Array.isArray(args)||args.some(value=>typeof value!=='string'))throw rpcCode('request/invalid','MCP args must be a string array');
 const env=body.env??{};if(!env||typeof env!=='object'||Array.isArray(env)||Object.entries(env).some(([key,value])=>!key||typeof value!=='string'))throw rpcCode('request/invalid','MCP env must be a string map');
 if(body.cwd!==undefined&&(typeof body.cwd!=='string'||!body.cwd.trim()))throw rpcCode('request/invalid','MCP cwd must be a nonempty path');
 for(const key of ['startupTimeoutSec','toolTimeoutSec'])if(body[key]!==undefined&&(typeof body[key]!=='number'||body[key]<=0))throw rpcCode('request/invalid',`${key} must be positive`);
 const value={command,args,env,...(body.cwd?{cwd:body.cwd}:{}),...(body.enabled===undefined?{}:{enabled:body.enabled===true}),...(body.startupTimeoutSec?{startup_timeout_sec:body.startupTimeoutSec}:{}),...(body.toolTimeoutSec?{tool_timeout_sec:body.toolTimeoutSec}:{})};
 await rpc.call('config/batchWrite',{edits:[{keyPath:`mcp_servers.${name}`,value,mergeStrategy:'replace'}],reloadUserConfig:true});return {name,server:value};
}
async function removeMcpServer(body){const name=requireString(body,'name');if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name))throw rpcCode('request/invalid','Invalid MCP name');await rpc.call('config/batchWrite',{edits:[{keyPath:`mcp_servers.${name}`,value:null,mergeStrategy:'replace'}],reloadUserConfig:true});return {removed:true,name};}

// 运行期握手：嘉宾进程只从 CODEX_HOME 读它，任何 HTTP 接口都不返回 token。
async function writeHandshake(address){
 const baseUrl=`http://${HOST==='0.0.0.0'?'127.0.0.1':HOST}:${address.port}`;
 await mkdir(CODEX_HOME,{recursive:true,mode:0o700});
 const temporary=HANDSHAKE_FILE+'.tmp';
 await writeFile(temporary,JSON.stringify({baseUrl,token:TOKEN,pid:process.pid,startedAt,version:BRIDGE_VERSION})+'\n',{mode:0o600});
 await rename(temporary,HANDSHAKE_FILE);
 return baseUrl;
}
async function removeHandshake(){try{await rm(HANDSHAKE_FILE,{force:true});}catch(error){console.error('codex-go: could not remove the handshake file: '+scrub(error.message));}}

function integerField(body,key,min,max,fallback){if(body[key]===undefined)return fallback;const value=body[key];if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw rpcCode('request/invalid',`${key} must be an integer between ${min} and ${max}`);return value;}

// 子智能体：每次一个全新 thread，最终文本取自规范化事件流（回退到 thread/read 的 items）。
function createSubagentWatcher(timeoutMs){
 const watcher={turnId:null,texts:[],settled:false};
 watcher.promise=new Promise(resolve=>{watcher.resolve=resolve;});
 watcher.settle=outcome=>{if(watcher.settled)return;watcher.settled=true;clearTimeout(watcher.timer);watcher.resolve(outcome);};
 watcher.timer=setTimeout(()=>watcher.settle({timeout:true}),timeoutMs);
 watcher.dispose=()=>{clearTimeout(watcher.timer);watcher.settled=true;};
 return watcher;
}
function subagentEvent(event){
 const watcher=event.threadId==null?null:subagentWatchers.get(event.threadId);if(!watcher)return;
 if(event.type==='text.delta'){if(watcher.turnId&&event.turnId&&event.turnId!==watcher.turnId)return;watcher.texts.push(event.text??'');return;}
 if(event.type!=='turn.end')return;
 if(watcher.turnId&&event.turnId!==watcher.turnId)return;
 watcher.settle({turnId:event.turnId,status:event.status,error:event.error??null});
}
async function subagentText(threadId,chunks){
 const streamed=chunks.join('');
 if(streamed.trim())return streamed;
 try{
  const {thread}=await rpc.call('thread/read',{threadId,includeTurns:true},20000);
  const items=(thread?.turns??[]).flatMap(turn=>turn.items??[]);
  const message=[...items].reverse().find(item=>/agentMessage/i.test(String(item?.type??''))&&typeof item.text==='string');
  return message?.text??'';
 }catch(error){console.error('codex-go: could not read subagent thread items: '+scrub(error.message));return '';}
}
async function subagentRun(body){
 const allowed=new Set(['prompt','cwd','model','reasoningEffort','timeoutMs','title','name','role','parentId','parentThreadId']);for(const key of Object.keys(body))if(!allowed.has(key))throw rpcCode('request/invalid',`Unknown subagent field: ${key}`);
 const prompt=requireString(body,'prompt');
 if(body.cwd!==undefined&&(typeof body.cwd!=='string'||!body.cwd.trim()))throw rpcCode('request/invalid','cwd must be a nonempty path string');
 if(body.model!==undefined&&(typeof body.model!=='string'||!body.model.trim()))throw rpcCode('request/invalid','model must be a nonempty string');
 if(body.reasoningEffort!==undefined&&!SUBAGENT_REASONING.has(body.reasoningEffort))throw rpcCode('request/invalid','Unsupported reasoning effort');
 if(body.title!==undefined&&(typeof body.title!=='string'||!body.title.trim()||body.title.length>200))throw rpcCode('request/invalid','title must be a nonempty string of at most 200 characters');
 for(const key of ['name','role','parentId','parentThreadId'])if(body[key]!==undefined&&(typeof body[key]!=='string'||body[key].length>200))throw rpcCode('request/invalid',`${key} must be a string of at most 200 characters`);
 const cwd=body.cwd?path.resolve(body.cwd):CWD,model=body.model?.trim(),timeoutMs=integerField(body,'timeoutMs',1000,1800000,600000);
 const {agentId}=agentRegistry.queue({name:body.name??body.title,role:body.role,task:prompt,parentId:body.parentId,parentThreadId:body.parentThreadId});
 const run={id:`sub-${++subagentSeq}`,threadId:null,title:body.title?.trim()??(prompt.split('\n')[0].slice(0,80)||'Subagent run'),status:'running',startedAt:Date.now(),finishedAt:null,preview:prompt.slice(0,160)};
 subagentRuns.unshift(run);if(subagentRuns.length>SUBAGENT_RUNS)subagentRuns.length=SUBAGENT_RUNS;
 let threadId=null,turnId=null,watcher=null;
 try{
  const developerInstructions=await effectiveDeveloperInstructions();
  const started=await rpc.call('thread/start',{cwd,developerInstructions,...(model?{model}:{})});
  threadId=started?.thread?.id;if(!threadId)throw rpcCode('codex/protocol','thread/start did not return a thread',502);
  loadingThreads.add(threadId);threadInjectedInstructions.set(threadId,developerInstructions);run.threadId=threadId;
  agentRegistry.start(agentId,{threadId});
  watcher=createSubagentWatcher(timeoutMs);subagentWatchers.set(threadId,watcher);
  const value=await rpc.call('turn/start',{threadId,input:[{type:'text',text:prompt}],summary:'auto',...(model?{model}:{}),...(body.reasoningEffort?{effort:body.reasoningEffort}:{})});
  turnId=value?.turn?.id;if(!turnId)throw rpcCode('codex/protocol','turn/start did not return a turn',502);
  watcher.turnId=turnId;turns.set(threadId,turnId);
  const outcome=await watcher.promise;
  if(outcome.timeout){
   run.status='timeout';run.finishedAt=Date.now();
   rpc.call('turn/interrupt',{threadId,turnId},15000).catch(error=>console.error('codex-go: subagent interrupt failed: '+scrub(error.message)));
   throw rpcCode('codex/subagent-timeout',`Subagent turn did not finish within ${timeoutMs}ms`,504,{threadId,turnId,timeoutMs});
  }
  if(outcome.status!=='completed'){
   run.status='failed';run.finishedAt=Date.now();
   throw rpcCode('codex/subagent-failed',outcome.error?.message||`Subagent turn ended with ${outcome.status??'unknown'}`,502,{threadId,turnId,status:outcome.status??null,error:outcome.error??null});
  }
  const text=await subagentText(threadId,watcher.texts);
  run.status='completed';run.finishedAt=Date.now();if(text.trim())run.preview=text.slice(0,160);
  agentRegistry.finish(agentId,{state:'completed'});
  return {threadId,turnId,status:'completed',text};
 }catch(error){
  agentRegistry.finish(agentId,{state:error.code==='codex/subagent-timeout'?'timeout':'failed',error});
  if(run.status==='running'){run.status=error.code==='codex/subagent-timeout'?'timeout':'failed';run.finishedAt=Date.now();}
  throw error;
 }finally{
  if(watcher){watcher.dispose();if(threadId&&subagentWatchers.get(threadId)===watcher)subagentWatchers.delete(threadId);}
  // 任何退出路径都不能在 turns 里留僵尸条目。
  if(threadId){const current=turns.get(threadId);if(turnId?current===turnId:current==='starting')turns.delete(threadId);}
 }
}

// 中转站模型自动拉取：GET {baseUrl}/models，10s 超时，响应上限 2 MiB。
function normalizeBaseUrl(value,wire='openai-responses'){
 if(typeof value!=='string'||!value.trim())throw rpcCode('provider/base-url','baseUrl is required');
 let url;try{url=new URL(value.trim());}catch{throw rpcCode('provider/base-url','Base URL must be absolute HTTP(S)');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw rpcCode('provider/base-url','Use an HTTP(S) endpoint without embedded credentials, query or fragment');
 const openai=wire==='openai-chat'||wire==='openai-responses'||wire==='chat'||wire==='responses';
 const segments=url.pathname.split('/').filter(Boolean);
 if(openai&&segments.length===0)segments.push('v1');
 else if(openai&&segments.at(-1)?.toLowerCase()==='v')segments[segments.length-1]='v1';
 url.pathname='/'+segments.join('/');
 return url.toString().replace(/\/$/,'');
}
async function storedProviderKey(provider){
 const cfg=configValue(await rawConfig());const map=cfg.model_providers??cfg.modelProviders??{};
 const profile=map[provider];if(!profile)throw rpcCode('provider/unknown',`Unknown provider: ${provider}`,400,{provider});
 const secrets=await readSecrets();const envKey=profile.env_key??profile.envKey??null;
 const apiKey=(envKey&&(secrets[envKey]||process.env[envKey]))||profile.experimental_bearer_token||null;
 if(!apiKey)throw rpcCode('provider/api-key',`No stored API key for provider: ${provider}`,400,{provider,envKey});
 return apiKey;
}
async function readCappedText(response,limit,baseUrl){
 const reader=response.body?.getReader();if(!reader)return '';
 const chunks=[];let size=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   size+=value?.byteLength??0;
   if(size>limit){await reader.cancel().catch(()=>{});throw rpcCode('provider/models-too-large',`Provider model list exceeds ${limit} bytes`,502,{baseUrl});}
   chunks.push(Buffer.from(value));
  }
 }catch(error){if(error.code)throw error;throw rpcCode('provider/models-unreachable',`Provider response could not be read: ${error.message}`,502,{baseUrl});}
 return Buffer.concat(chunks).toString('utf8');
}
async function providerModels(body){
 const allowed=new Set(['baseUrl','apiKey','provider']);for(const key of Object.keys(body))if(!allowed.has(key))throw rpcCode('request/invalid',`Unknown provider field: ${key}`);
 const baseUrl=normalizeBaseUrl(body.baseUrl);
 if(body.apiKey!==undefined&&typeof body.apiKey!=='string')throw rpcCode('provider/api-key','apiKey must be a string when supplied');
 // 空字符串等于「没说」：用该 provider 已存的密钥，别把界面留空当成错误。
 const suppliedKey=typeof body.apiKey==='string'&&body.apiKey.trim()?body.apiKey.trim():undefined;
 if(suppliedKey===undefined&&body.provider===undefined)throw rpcCode('provider/api-key','Supply apiKey or a provider with a stored key');
 if(body.provider!==undefined&&(typeof body.provider!=='string'||! /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(body.provider)))throw rpcCode('provider/unknown','provider must be a simple identifier',400);
 const apiKey=suppliedKey??await storedProviderKey(body.provider);
 let response;
 try{response=await fetch(`${baseUrl}/models`,{method:'GET',headers:withCliUa({accept:'application/json',authorization:`Bearer ${apiKey}`}),signal:AbortSignal.timeout(MODELS_TIMEOUT_MS)});}
 catch(error){
  const timeout=error?.name==='TimeoutError'||/timed? ?out|abort/i.test(String(error?.message));
  throw rpcCode('provider/models-unreachable',timeout?`Provider did not answer within ${MODELS_TIMEOUT_MS}ms`:`Could not reach provider: ${error?.message??'network error'}`,502,{baseUrl,timeout});
 }
 if(!response.ok){
  await response.arrayBuffer().catch(()=>{});
  throw rpcCode('provider/models-fetch',`Provider responded ${response.status}`,502,{status:response.status,baseUrl});
 }
 const declared=Number(response.headers.get('content-length')??0);
 if(Number.isFinite(declared)&&declared>MODELS_MAX_BYTES)throw rpcCode('provider/models-too-large',`Provider model list exceeds ${MODELS_MAX_BYTES} bytes`,502,{baseUrl});
 let payload;try{payload=JSON.parse(await readCappedText(response,MODELS_MAX_BYTES,baseUrl));}catch(error){if(error.code)throw error;throw rpcCode('provider/models-invalid','Provider returned a non-JSON model list',502,{baseUrl});}
 const entries=Array.isArray(payload)?payload:Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.models)?payload.models:null;
 if(!entries)throw rpcCode('provider/models-invalid','Expected a model list in data or models',502,{baseUrl});
 const seen=new Set(),models=[];
 for(const entry of entries){
  const raw=typeof entry==='string'?entry:typeof entry?.id==='string'?entry.id:typeof entry?.model==='string'?entry.model:null;
  if(typeof raw!=='string'||!raw.trim()||seen.has(raw.trim()))continue;
  seen.add(raw.trim());
  const owner=entry&&typeof entry==='object'?(entry.owned_by??entry.ownedBy):null;
  models.push({id:raw.trim(),ownedBy:typeof owner==='string'?owner:null});
 }
 return {baseUrl,models,count:models.length};
}

// 工具包：内置目录 + 用户目录，启用状态持久化，模块形状见 TOOLPACKS-CONTRACT.md §3。
async function isDirectory(target){try{return (await stat(target)).isDirectory();}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}}
async function isFile(target){try{return (await stat(target)).isFile();}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}}
function inside(child,parent){const relative=path.relative(parent,child);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
async function toolpackRoots(){
 if(packRootsCache)return packRootsCache;
 let builtin=BUILTIN_TOOLPACKS;
 if(!TOOLPACKS_OVERRIDE&&!(await isDirectory(builtin))&&(await isDirectory(BUNDLED_TOOLPACKS)))builtin=BUNDLED_TOOLPACKS;
 const roots=[{dir:builtin,builtin:true},{dir:USER_TOOLPACKS,builtin:false}];
 // 契约 D：启用插件的 toolpacks/* 等价于内置包目录，最后加载，冲突时让位。
 for(const plugin of await collectPlugins())if(plugin.enabled&&!plugin.error)roots.push({dir:path.join(plugin.dir,'toolpacks'),builtin:false,plugin:plugin.name});
 packRootsCache=roots;
 return packRootsCache;
}
async function readPackState(){
 if(packState)return packState;
 let text;
 try{text=await readFile(TOOLPACK_STATE_FILE,'utf8');}
 catch(error){if(error.code!=='ENOENT')throw rpcCode('toolpack/state',`Cannot read toolpack state: ${error.message}`,500,{path:TOOLPACK_STATE_FILE});packState={disabled:[]};return packState;}
 let value;
 try{value=JSON.parse(text);}catch{throw rpcCode('toolpack/state','Toolpack state file is not valid JSON',500,{path:TOOLPACK_STATE_FILE});}
 if(!value||typeof value!=='object'||!Array.isArray(value.disabled)||value.disabled.some(name=>typeof name!=='string'))throw rpcCode('toolpack/state','Toolpack state must be {"disabled":[names]}',500,{path:TOOLPACK_STATE_FILE});
 packState={disabled:[...new Set(value.disabled)]};
 return packState;
}
async function writePackState(disabled){
 const value=[...disabled].sort();
 await mkdir(CODEX_HOME,{recursive:true,mode:0o700});
 const temporary=TOOLPACK_STATE_FILE+'.tmp';
 await writeFile(temporary,JSON.stringify({disabled:value})+'\n',{mode:0o600});
 await rename(temporary,TOOLPACK_STATE_FILE);
 packState={disabled:value};
}
async function scanToolpacks(root,builtin){
 let entries;
 try{entries=await readdir(root,{withFileTypes:true});}
 catch(error){if(error.code==='ENOENT')return [];throw rpcCode('toolpack/scan',`Cannot read toolpack directory: ${error.message}`,500,{path:root});}
 const packs=[];
 for(const entry of entries.filter(item=>item.isDirectory()&&PACK_NAME.test(item.name)).map(item=>item.name).sort()){
  const dir=path.join(root,entry),index=path.join(dir,'index.mjs');
  if(await isFile(index))packs.push({name:entry,dir,index,builtin});
 }
 return packs;
}
async function loadToolpack(entry){
 const info=await stat(entry.index);
 const module=await import(`${pathToFileURL(entry.index).href}?v=${info.mtimeMs}`);
 const meta=module?.meta;if(!meta||typeof meta!=='object')throw Error('index.mjs must export a meta object');
 const name=typeof meta.name==='string'?meta.name.trim():'';
 if(!PACK_NAME.test(name))throw Error('meta.name must match ^[a-z][a-z0-9_]{0,63}$');
 const tools=Array.isArray(module.tools)?module.tools:[];
 const listed=[],seen=new Set();
 for(const tool of tools){
  if(!tool||typeof tool!=='object'||typeof tool.name!=='string'||!PACK_NAME.test(tool.name))throw Error(`tool name ${String(tool?.name)} must match ^[a-z][a-z0-9_]{0,63}$`);
  if(typeof tool.description!=='string'||!tool.description.trim())throw Error(`tool ${tool.name} needs a description`);
  if(seen.has(tool.name))throw Error(`duplicate tool name ${tool.name}`);
  seen.add(tool.name);listed.push({name:tool.name,description:tool.description});
 }
 return {name,title:typeof meta.title==='string'&&meta.title.trim()?meta.title:name,version:typeof meta.version==='string'?meta.version:null,description:typeof meta.description==='string'?meta.description:null,builtin:entry.builtin,dir:entry.dir,tools:listed};
}
async function collectToolpacks(){
 const disabled=new Set((await readPackState()).disabled);
 const packs=[],seen=new Set();
 for(const root of await toolpackRoots()){
  for(const entry of await scanToolpacks(root.dir,root.builtin)){
   if(root.plugin&&seen.has(entry.name)){
    // 插件工具包名必须全局唯一：后加载者跳过，但要在列表里留下可读原因。
    packs.push({name:entry.name,title:entry.name,version:null,description:null,builtin:false,enabled:false,tools:[],error:`Plugin ${root.plugin} ships toolpack ${entry.name}, which another toolpack already provides`,dir:entry.dir});
    continue;
   }
   let pack;
   try{pack=await loadToolpack(entry);}
   catch(error){
    if(seen.has(entry.name))continue;
    seen.add(entry.name);
    packs.push({name:entry.name,title:entry.name,version:null,description:null,builtin:root.builtin,enabled:!disabled.has(entry.name),tools:[],error:String(error?.message??error),dir:entry.dir});
    continue;
   }
   if(seen.has(pack.name)){console.error(`codex-go: duplicate toolpack ${pack.name} at ${entry.dir} is shadowed`);continue;}
   seen.add(pack.name);packs.push({...pack,enabled:!disabled.has(pack.name)});
  }
 }
 return packs;
}
async function findToolpack(name){return (await collectToolpacks()).find(pack=>pack.name===name)??null;}
function requireToolpackName(body,allowed=[]){
 for(const key of Object.keys(body))if(key!=='name'&&!allowed.includes(key))throw rpcCode('request/invalid',`Unknown toolpack field: ${key}`);
 const name=requireString(body,'name');
 if(!PACK_NAME.test(name))throw rpcCode('request/invalid','Toolpack name must match ^[a-z][a-z0-9_]{0,63}$');
 return name;
}
async function listToolpacks(){const packs=await collectToolpacks();return {packs:packs.map(({dir,...pack})=>pack)};}
async function toggleToolpack(body){
 const name=requireToolpackName(body,['enabled']);
 if(typeof body.enabled!=='boolean')throw rpcCode('request/invalid','enabled must be a boolean');
 if(!(await findToolpack(name)))throw rpcCode('toolpack/not-found',`Unknown toolpack: ${name}`,404,{name});
 const disabled=new Set((await readPackState()).disabled),before=new Set(disabled);
 if(body.enabled)disabled.delete(name);else disabled.add(name);
 if(disabled.size!==before.size||[...disabled].some(item=>!before.has(item)))await writePackState(disabled);
 return {name,enabled:body.enabled};
}
async function importToolpack(body){
 for(const key of Object.keys(body))if(key!=='path')throw rpcCode('request/invalid',`Unknown toolpack field: ${key}`);
 const source=requireString(body,'path');
 if(!path.isAbsolute(source))throw rpcCode('toolpack/import','Toolpack path must be an absolute directory',400,{path:source});
 const resolved=path.resolve(source);
 const info=await stat(resolved).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;});
 if(!info?.isDirectory())throw rpcCode('toolpack/import',`Not a directory: ${resolved}`,400,{path:resolved});
 const index=path.join(resolved,'index.mjs');
 if(!(await isFile(index)))throw rpcCode('toolpack/import','A toolpack directory must contain index.mjs',400,{path:resolved});
 let pack;try{pack=await loadToolpack({name:path.basename(resolved),dir:resolved,index,builtin:false});}catch(error){throw rpcCode('toolpack/invalid',`Toolpack failed to load: ${error.message}`,400,{path:resolved});}
 if((await findToolpack(pack.name))?.builtin)throw rpcCode('toolpack/builtin',`${pack.name} is a builtin toolpack name and cannot be replaced`,400,{name:pack.name});
 const target=path.join(USER_TOOLPACKS,pack.name),userRoot=path.resolve(USER_TOOLPACKS);
 if(resolved===target)return {name:pack.name}; // 重复导入同一包是幂等的
 if(resolved===userRoot||inside(target,resolved)||inside(resolved,userRoot))throw rpcCode('toolpack/import','Source directory overlaps the user toolpack root',400,{name:pack.name,path:resolved});
 await mkdir(USER_TOOLPACKS,{recursive:true,mode:0o700});
 const staging=path.join(CODEX_HOME,`.toolpack-${randomBytes(6).toString('hex')}`);
 try{
  await cp(resolved,staging,{recursive:true,force:true});
  await rm(target,{recursive:true,force:true});
  await rename(staging,target);
 }catch(error){
  await rm(staging,{recursive:true,force:true}).catch(cleanup=>console.error('codex-go: could not clean toolpack staging: '+scrub(cleanup.message)));
  throw rpcCode('toolpack/import',`Could not install toolpack: ${error.message}`,500,{name:pack.name,path:resolved});
 }
 return {name:pack.name};
}
async function removeToolpack(body){
 const name=requireToolpackName(body);
 const pack=await findToolpack(name);if(!pack)throw rpcCode('toolpack/not-found',`Unknown toolpack: ${name}`,404,{name});
 if(pack.builtin)throw rpcCode('toolpack/builtin','Builtin toolpacks can be disabled but not removed',400,{name});
 const target=path.resolve(pack.dir),userRoot=path.resolve(USER_TOOLPACKS);
 if(target===userRoot||!inside(target,userRoot))throw rpcCode('toolpack/remove','Refusing to remove a directory outside the user toolpack root',400,{name,path:target});
 await rm(target,{recursive:true,force:true});
 const state=await readPackState();
 if(state.disabled.includes(name))await writePackState(state.disabled.filter(item=>item!==name));
 return {removed:true,name};
}

// ---- 契约 B：上下文设置 / 用量追踪 / 自动压缩 ----
async function readContextStateFile(){
 try{return JSON.parse(await readFile(CONTEXT_SETTINGS_FILE,'utf8'));}
 catch(error){
  if(error.code==='ENOENT')return {};
  if(error instanceof SyntaxError)throw rpcCode('context/state','codex-go-settings.json is not valid JSON',500,{path:CONTEXT_SETTINGS_FILE});
  throw rpcCode('context/state',`Cannot read context settings: ${error.message}`,500,{path:CONTEXT_SETTINGS_FILE});
 }
}
function normalizeContextSetting(raw){
 const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 const value={...CONTEXT_DEFAULTS};
 if(typeof source.enabled==='boolean')value.enabled=source.enabled;
 if(Number.isInteger(source.thresholdPercent)&&source.thresholdPercent>=CONTEXT_MIN_PERCENT&&source.thresholdPercent<=CONTEXT_MAX_PERCENT)value.thresholdPercent=source.thresholdPercent;
 if(Number.isInteger(source.keepRecentTurns)&&source.keepRecentTurns>=0&&source.keepRecentTurns<=CONTEXT_MAX_TURNS)value.keepRecentTurns=source.keepRecentTurns;
 if(typeof source.autoCompact==='boolean')value.autoCompact=source.autoCompact;
 if(source.summaryModel===null)value.summaryModel=null;
 else if(typeof source.summaryModel==='string'&&source.summaryModel.trim())value.summaryModel=source.summaryModel.trim();
 if(source.contextWindowTokens===null)value.contextWindowTokens=null;
 else if(Number.isInteger(source.contextWindowTokens)&&source.contextWindowTokens>=CONTEXT_WINDOW_MIN&&source.contextWindowTokens<=CONTEXT_WINDOW_MAX)value.contextWindowTokens=source.contextWindowTokens;
 return value;
}
async function readContextSettings(){
 if(contextState){contextWindowTokensCache=contextState.contextWindowTokens??null;return contextState;}
 contextState=normalizeContextSetting((await readContextStateFile())?.context);
 contextWindowTokensCache=contextState.contextWindowTokens??null;
 return contextState;
}
async function writeContextSettings(patch){
 const raw=await readContextStateFile();
 const document=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 const next={...normalizeContextSetting(document.context),...patch};
 await mkdir(CODEX_HOME,{recursive:true,mode:0o700});
 const temporary=CONTEXT_SETTINGS_FILE+'.tmp';
 await writeFile(temporary,JSON.stringify({...document,context:next})+'\n',{mode:0o600});
 await rename(temporary,CONTEXT_SETTINGS_FILE);
 contextState=next;
 contextWindowTokensCache=next.contextWindowTokens??null;
 return next;
}
function contextPercent(totalTokens,contextWindow){
 if(!(totalTokens>0)||!(contextWindow>0))return 0;
 return Math.min(100,Math.round((totalTokens/contextWindow)*100));
}
// 上下文占用 = **当前这一次请求**的 token 数，不是整个会话的累计。
//
// 踩过的坑：旧实现取 `tokenUsage.total.totalTokens`，而 codex 的 `total` 是会话累计
// （实测：一条「只回复两个字」53,046；三条同样的短消息 159,447）。按累计值画进度环，
// 用户说两句话就看到「上下文已满」，而真实内容只有几百 token。
// `last` 才是最近一次请求的用量（≈ 当前 prompt + 回复），这里用它。
function contextOccupancy(tokenUsage){
 if(!tokenUsage)return 0;
 const last=tokenUsage.last??null;
 const fromLast=Number(last?.inputTokens)+Number(last?.outputTokens);
 if(Number.isFinite(fromLast)&&fromLast>0)return fromLast;
 const lastTotal=Number(last?.totalTokens);
 if(Number.isFinite(lastTotal)&&lastTotal>0)return lastTotal;
 const totalTotal=Number(tokenUsage?.total?.totalTokens??tokenUsage?.totalTokens);
 return Number.isFinite(totalTotal)&&totalTotal>0?totalTotal:0;
}
function trackUsage(threadId,turnId,tokenUsage){
 if(!threadId)return null;
 const totalTokens=contextOccupancy(tokenUsage);
 const rawWindow=tokenUsage?.modelContextWindow??tokenUsage?.contextWindow??null;
 const upstreamWindow=Number.isFinite(Number(rawWindow))&&Number(rawWindow)>0?Number(rawWindow):null;
 // 用户设置优先：设置里填了窗口长度就按它算（否则「设置不生效」）。来源一起回给界面。
 const override=Number.isFinite(contextWindowTokensCache)&&contextWindowTokensCache>0?contextWindowTokensCache:null;
 const contextWindow=override??upstreamWindow;
 const source=override?'user':upstreamWindow?'upstream':'unknown';
 const usage={threadId,turnId:turnId??null,totalTokens,upstreamWindow,contextWindow,contextWindowSource:source,percent:contextPercent(totalTokens,contextWindow),at:Date.now()};
 usageByThread.set(threadId,usage);
 // 只保留最近 200 个 thread 的用量，长期运行不涨内存。
 if(usageByThread.size>200){const [oldest]=[...usageByThread.entries()].sort((a,b)=>a[1].at-b[1].at);if(oldest)usageByThread.delete(oldest[0]);}
 lastUsage=usage;
 return usage;
}
function usageView(threadId){
 const usage=threadId?usageByThread.get(threadId):lastUsage;
 if(!usage)return {totalTokens:0,contextWindow:null,contextWindowSource:'unknown',percent:0};
 // 用**当前**窗口设置重算，而不是沿用事件当时的：用户刚改完窗口就来看，百分比/分母要立刻是对的。
 const override=Number.isFinite(contextWindowTokensCache)&&contextWindowTokensCache>0?contextWindowTokensCache:null;
 const upstream=Number.isFinite(usage.upstreamWindow)&&usage.upstreamWindow>0?usage.upstreamWindow:null;
 const contextWindow=override??upstream;
 const contextWindowSource=override?'user':upstream?'upstream':'unknown';
 return {totalTokens:usage.totalTokens,contextWindow,contextWindowSource,percent:contextPercent(usage.totalTokens,contextWindow)};
}
function validateContextPatch(body){
 for(const key of Object.keys(body))if(!['enabled','thresholdPercent','keepRecentTurns','autoCompact','summaryModel','contextWindowTokens'].includes(key))throw rpcCode('request/invalid',`Unknown context field: ${key}`);
 const patch={};
 for(const key of ['enabled','autoCompact']){
  if(body[key]===undefined)continue;
  if(typeof body[key]!=='boolean')throw rpcCode('context/invalid',`${key} must be a boolean`);
  patch[key]=body[key];
 }
 if(body.thresholdPercent!==undefined){
  const value=body.thresholdPercent;
  if(typeof value!=='number'||!Number.isInteger(value)||value<CONTEXT_MIN_PERCENT||value>CONTEXT_MAX_PERCENT)throw rpcCode('context/invalid',`thresholdPercent must be an integer between ${CONTEXT_MIN_PERCENT} and ${CONTEXT_MAX_PERCENT}`);
  patch.thresholdPercent=value;
 }
 if(body.keepRecentTurns!==undefined){
  const value=body.keepRecentTurns;
  if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>CONTEXT_MAX_TURNS)throw rpcCode('context/invalid',`keepRecentTurns must be an integer between 0 and ${CONTEXT_MAX_TURNS}`);
  patch.keepRecentTurns=value;
 }
 if(body.summaryModel!==undefined){
  if(body.summaryModel===null)patch.summaryModel=null;
  else if(typeof body.summaryModel==='string'&&body.summaryModel.trim()&&body.summaryModel.trim().length<=200)patch.summaryModel=body.summaryModel.trim();
  else throw rpcCode('context/invalid','summaryModel must be null or a nonempty model id of at most 200 characters');
 }
 if(body.contextWindowTokens!==undefined){
  const value=body.contextWindowTokens;
  if(value===null)patch.contextWindowTokens=null;
  else if(typeof value!=='number'||!Number.isInteger(value)||value<CONTEXT_WINDOW_MIN||value>CONTEXT_WINDOW_MAX)throw rpcCode('context/invalid',`contextWindowTokens must be null or an integer between ${CONTEXT_WINDOW_MIN} and ${CONTEXT_WINDOW_MAX}`);
  else patch.contextWindowTokens=value;
 }
 return patch;
}
async function contextView(body={}){
 for(const key of Object.keys(body))if(key!=='threadId')throw rpcCode('request/invalid',`Unknown context field: ${key}`);
 let threadId=null;
 if(body.threadId!==undefined){
  if(typeof body.threadId!=='string'||!body.threadId.trim())throw rpcCode('request/invalid','threadId must be a nonempty string');
  threadId=body.threadId.trim();
 }
 return {...(await readContextSettings()),usage:usageView(threadId)};
}
async function contextConfigure(body){
 const patch=validateContextPatch(body);
 if(Object.keys(patch).length)await writeContextSettings(patch);
 return {...(await readContextSettings()),usage:usageView(null)};
}
async function contextCompact(body){
 for(const key of Object.keys(body))if(key!=='threadId')throw rpcCode('request/invalid',`Unknown compact field: ${key}`);
 const threadId=requireString(body,'threadId');
 await rpc.call('thread/compact/start',{threadId},COMPACT_TIMEOUT_MS);
 lastAutoCompact.set(threadId,Date.now());
 broadcast({type:'context.compacted',threadId,percent:usageView(threadId).percent});
 return {threadId,status:'started'};
}
async function maybeAutoCompact(threadId){
 if(!threadId||autoCompactInflight.has(threadId))return;
 let settings;
 try{settings=await readContextSettings();}
 catch(error){console.error('codex-go: auto-compact disabled, settings unreadable: '+scrub(error.message));return;}
 if(!settings.enabled||!settings.autoCompact)return;
 const usage=usageByThread.get(threadId);
 if(!usage?.contextWindow||usage.percent<settings.thresholdPercent)return;
 if(turns.has(threadId))return;
 const previous=lastAutoCompact.get(threadId)??0;
 if(Date.now()-previous<AUTO_COMPACT_WINDOW_MS)return;
 autoCompactInflight.add(threadId);lastAutoCompact.set(threadId,Date.now());
 if(lastAutoCompact.size>200){const [oldest]=[...lastAutoCompact.entries()].sort((a,b)=>a[1]-b[1]);if(oldest)lastAutoCompact.delete(oldest[0]);}
 try{
  await rpc.call('thread/compact/start',{threadId},COMPACT_TIMEOUT_MS);
  broadcast({type:'context.compacted',threadId,percent:usage.percent});
 }catch(error){
  broadcast({type:'context.compact-failed',threadId,percent:usage.percent,code:error?.code??'bridge/internal',message:scrub(error?.message??'Context compaction failed')});
 }finally{autoCompactInflight.delete(threadId);}
}
function queueAutoCompact(threadId){maybeAutoCompact(threadId).catch(error=>console.error('codex-go: auto-compact attempt failed: '+scrub(error.message)));}

// ---- 契约 C：系统人设（persona.json + AGENTS.md 托管区块）----
function normalizePersona(raw){
 const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 const text=value=>typeof value==='string'?value:'';
 return {name:text(source.name),style:text(source.style),instructions:text(source.instructions).replace(/\r\n/g,'\n').trim(),active:source.active!==false};
}
async function readPersona(){
 if(personaState)return personaState;
 let text;
 try{text=await readFile(PERSONA_FILE,'utf8');}
 catch(error){
  if(error.code==='ENOENT'){personaState=normalizePersona({});return personaState;}
  throw rpcCode('persona/state',`Cannot read persona file: ${error.message}`,500,{path:PERSONA_FILE});
 }
 let raw;
 try{raw=JSON.parse(text);}catch{throw rpcCode('persona/state','codex-go-persona.json is not valid JSON',500,{path:PERSONA_FILE});}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw rpcCode('persona/state','codex-go-persona.json must be a JSON object',500,{path:PERSONA_FILE});
 personaState=normalizePersona(raw);
 return personaState;
}
function validatePersona(body,current){
 for(const key of Object.keys(body))if(!['name','style','instructions','active'].includes(key))throw rpcCode('request/invalid',`Unknown persona field: ${key}`);
 const persona={...current};
 for(const field of ['name','style','instructions']){
  if(body[field]===undefined)continue;
  if(typeof body[field]!=='string')throw rpcCode('persona/invalid',`${field} must be a string`);
  const value=body[field].replace(/\r\n/g,'\n').trim();
  if(value.length>PERSONA_LIMITS[field])throw rpcCode('persona/invalid',`${field} must be at most ${PERSONA_LIMITS[field]} characters`);
  if(value.includes(PERSONA_START)||value.includes(PERSONA_END))throw rpcCode('persona/invalid','Persona text must not contain the Codex Pocket managed markers');
  persona[field]=value;
 }
 if(body.active!==undefined){
  if(typeof body.active!=='boolean')throw rpcCode('persona/invalid','active must be a boolean');
  persona.active=body.active;
 }
 return persona;
}
function personaBlock(persona){
 if(!persona.active)return '';
 const lines=[PERSONA_START];
 if(persona.name)lines.push(`Name: ${persona.name}`);
 if(persona.style)lines.push(`Style: ${persona.style}`);
 if(persona.instructions){if(lines.length>1)lines.push('');lines.push(persona.instructions);}
 if(lines.length===1)return '';
 lines.push(PERSONA_END);
 return lines.join('\n');
}
// 只替换托管区块；其余字节原样保留。区块独占的换行一并处理，避免反复开关累积空行。
function applyPersonaBlock(text,block){
 const startIndex=text.indexOf(PERSONA_START),endIndex=text.indexOf(PERSONA_END);
 if(startIndex<0&&endIndex<0){
  if(!block)return text;
  if(!text)return block+'\n';
  return text.endsWith('\n')?text+'\n'+block+'\n':text+'\n\n'+block+'\n';
 }
 if(startIndex<0||endIndex<startIndex)throw rpcCode('persona/state','AGENTS.md contains an unterminated Codex Pocket persona block',500,{path:AGENTS_FILE});
 let end=endIndex+PERSONA_END.length;
 if(text[end]==='\n')end+=1;
 const head=text.slice(0,startIndex),tail=text.slice(end);
 if(block)return head+block+'\n'+tail;
 if(!tail)return head.endsWith('\n\n')?head.slice(0,-1):head;
 return head+tail;
}
function personaInstructions(persona){
 if(!persona.active)return '';
 const lines=[];
 if(persona.name)lines.push(`Name: ${persona.name}`);
 if(persona.style)lines.push(`Style: ${persona.style}`);
 if(persona.instructions){if(lines.length)lines.push('');lines.push(persona.instructions);}
 return lines.join('\n');
}
function validateDeveloperInstructions(value){
 if(value===undefined)return undefined;
 if(value===null)return null;
 if(typeof value!=='string')throw rpcCode('request/invalid','developerInstructions must be a string or null');
 const text=value.replace(/\r\n/g,'\n').trim();
 if(text.length>PERSONA_LIMITS.instructions)throw rpcCode('request/invalid',`developerInstructions must be at most ${PERSONA_LIMITS.instructions} characters`);
 return text;
}
async function effectiveDeveloperInstructions(threadId=null,override){
 const custom=override!==undefined?override:threadInstructionOverrides.get(threadId);
 const global=custom===undefined?personaInstructions(await readPersona()):custom;
 return [DEFAULT_AGENT_INSTRUCTIONS,global].filter(Boolean).join('\n\n');
}
async function prepareThreadInstructions(threadId,override){
 if(override!==undefined){if(override)threadInstructionOverrides.set(threadId,override);else threadInstructionOverrides.delete(threadId);}
 const developerInstructions=await effectiveDeveloperInstructions(threadId);
 if(!loadingThreads.has(threadId)){
  const resumed=await rpc.call('thread/resume',{threadId,developerInstructions,excludeTurns:true});
  loadingThreads.add(threadId);rememberThreadProvider(threadId,resumed?.modelProvider);
  threadInjectedInstructions.set(threadId,developerInstructions);
 }
 // codex 0.170 会固定已有 thread 的初始指令；resume/fork/turn 都不能热替换。
 return {threadId,developerInstructions:threadInjectedInstructions.get(threadId)??developerInstructions};
}
async function personaView(body={}){
 for(const key of Object.keys(body))throw rpcCode('request/invalid',`Unknown persona field: ${key}`);
 const persona=await readPersona();
 return {name:persona.name,style:persona.style,instructions:persona.instructions,active:persona.active,path:AGENTS_FILE,effectiveInstructions:await effectiveDeveloperInstructions(),injection:'developerInstructions+AGENTS.md'};
}
async function savePersona(body){
 const persona=validatePersona(body,await readPersona());
 let agents='';
 try{agents=await readFile(AGENTS_FILE,'utf8');}
 catch(error){if(error.code!=='ENOENT')throw rpcCode('persona/state',`Cannot read AGENTS.md: ${error.message}`,500,{path:AGENTS_FILE});}
 const next=applyPersonaBlock(agents,personaBlock(persona));
 await mkdir(CODEX_HOME,{recursive:true,mode:0o700});
 if(next!==agents)await writeFile(AGENTS_FILE,next,{mode:0o600});
 const temporary=PERSONA_FILE+'.tmp';
 await writeFile(temporary,JSON.stringify({name:persona.name,style:persona.style,instructions:persona.instructions,active:persona.active})+'\n',{mode:0o600});
 await rename(temporary,PERSONA_FILE);
 personaState={...persona};
 return personaView({});
}

// ---- 契约 D：插件（内置目录只读 + 用户目录 + 技能同步）----
async function readPluginState(){
 if(pluginState)return pluginState;
 let text;
 try{text=await readFile(PLUGIN_STATE_FILE,'utf8');}
 catch(error){if(error.code!=='ENOENT')throw rpcCode('plugin/state',`Cannot read plugin state: ${error.message}`,500,{path:PLUGIN_STATE_FILE});pluginState={disabled:[]};return pluginState;}
 let value;
 try{value=JSON.parse(text);}catch{throw rpcCode('plugin/state','Plugin state file is not valid JSON',500,{path:PLUGIN_STATE_FILE});}
 if(!value||typeof value!=='object'||!Array.isArray(value.disabled)||value.disabled.some(name=>typeof name!=='string'))throw rpcCode('plugin/state','Plugin state must be {"disabled":[names]}',500,{path:PLUGIN_STATE_FILE});
 pluginState={disabled:[...new Set(value.disabled)]};
 return pluginState;
}
async function writePluginState(disabled){
 const value=[...new Set(disabled)].sort();
 await mkdir(CODEX_HOME,{recursive:true,mode:0o700});
 const temporary=PLUGIN_STATE_FILE+'.tmp';
 await writeFile(temporary,JSON.stringify({disabled:value})+'\n',{mode:0o600});
 await rename(temporary,PLUGIN_STATE_FILE);
 pluginState={disabled:value};
}
async function pluginRoots(){
 if(pluginRootsCache)return pluginRootsCache;
 let builtin=BUILTIN_PLUGINS;
 if(!PLUGINS_OVERRIDE&&!(await isDirectory(builtin))&&(await isDirectory(BUNDLED_PLUGINS)))builtin=BUNDLED_PLUGINS;
 pluginRootsCache=[{dir:builtin,builtin:true},{dir:USER_PLUGINS,builtin:false}];
 return pluginRootsCache;
}
async function listSubdirectories(root){
 try{return (await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort();}
 catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return [];throw rpcCode('plugin/scan',`Cannot read plugin directory: ${error.message}`,500,{path:root});}
}
async function pluginManifest(dir){
 const file=path.join(dir,'plugin.json');
 if(!(await isFile(file)))throw rpcCode('plugin/invalid','A plugin directory must contain plugin.json',400,{path:dir});
 let raw;
 try{raw=JSON.parse(await readFile(file,'utf8'));}
 catch{throw rpcCode('plugin/invalid','plugin.json is not valid JSON',400,{path:file});}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw rpcCode('plugin/invalid','plugin.json must be a JSON object',400,{path:file});
 const name=typeof raw.name==='string'?raw.name.trim():'';
 if(!PLUGIN_NAME.test(name))throw rpcCode('plugin/invalid','plugin.json name must match ^[a-z][a-z0-9_-]{0,63}$',400,{path:file});
 const text=(value,limit)=>{
  if(value===undefined||value===null)return null;
  if(typeof value!=='string')throw rpcCode('plugin/invalid','plugin.json text fields must be strings',400,{path:file});
  const trimmed=value.trim();
  if(trimmed.length>limit)throw rpcCode('plugin/invalid',`plugin.json field exceeds ${limit} characters`,400,{path:file});
  return trimmed||null;
 };
 const toolpacks=[],skills=[];
 for(const pack of await listSubdirectories(path.join(dir,'toolpacks'))){
  if(!PACK_NAME.test(pack))throw rpcCode('plugin/invalid',`Plugin toolpack directory ${pack} must match ^[a-z][a-z0-9_]{0,63}$`,400,{path:path.join(dir,'toolpacks',pack)});
  if(!(await isFile(path.join(dir,'toolpacks',pack,'index.mjs'))))throw rpcCode('plugin/invalid',`Plugin toolpack ${pack} must contain index.mjs`,400,{path:path.join(dir,'toolpacks',pack)});
  toolpacks.push(pack);
 }
 for(const skill of await listSubdirectories(path.join(dir,'skills'))){
  if(!SKILL_NAME.test(skill))throw rpcCode('plugin/invalid',`Plugin skill directory ${skill} must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`,400,{path:path.join(dir,'skills',skill)});
  if(!(await isFile(path.join(dir,'skills',skill,'SKILL.md'))))throw rpcCode('plugin/invalid',`Plugin skill ${skill} must contain SKILL.md`,400,{path:path.join(dir,'skills',skill)});
  skills.push(skill);
 }
 return {name,title:text(raw.title,200)??name,version:text(raw.version,64),description:text(raw.description,2000),author:text(raw.author,200),toolpacks,skills,dir};
}
async function collectPlugins(){
 const disabled=new Set((await readPluginState()).disabled);
 const plugins=[],seen=new Set();
 for(const root of await pluginRoots()){
  for(const dirName of await listSubdirectories(root.dir)){
   const dir=path.join(root.dir,dirName);
   let manifest;
   try{manifest=await pluginManifest(dir);}
   catch(error){
    if(seen.has(dirName))continue;
    seen.add(dirName);
    plugins.push({name:dirName,title:dirName,version:null,description:null,builtin:root.builtin,enabled:!disabled.has(dirName),toolpacks:[],skills:[],dir,error:scrub(error?.message??String(error))});
    continue;
   }
   if(seen.has(manifest.name)){console.error(`codex-go: duplicate plugin ${manifest.name} at ${dir} is shadowed`);continue;}
   seen.add(manifest.name);
   plugins.push({...manifest,builtin:root.builtin,enabled:!disabled.has(manifest.name)});
  }
 }
 return plugins;
}
async function findPlugin(name){return (await collectPlugins()).find(plugin=>plugin.name===name)??null;}
function requirePluginName(body,allowed=[]){
 for(const key of Object.keys(body))if(key!=='name'&&!allowed.includes(key))throw rpcCode('request/invalid',`Unknown plugin field: ${key}`);
 const name=requireString(body,'name');
 if(!PLUGIN_NAME.test(name))throw rpcCode('request/invalid','Plugin name must match ^[a-z][a-z0-9_-]{0,63}$');
 return name;
}
async function listPlugins(body){
 for(const key of Object.keys(body))throw rpcCode('request/invalid',`Unknown plugin field: ${key}`);
 const plugins=await collectPlugins();
 // 契约 D 的固定形状：只暴露 name/title/version/description/builtin/enabled/toolpacks/skills。
 return {plugins:plugins.map(plugin=>({name:plugin.name,title:plugin.title,version:plugin.version,description:plugin.description,builtin:plugin.builtin,enabled:plugin.enabled,toolpacks:plugin.toolpacks,skills:plugin.skills,...(plugin.error?{error:plugin.error}:{})}))};
}
// 启用 → 把插件技能拷进 CODEX_HOME/skills/<name>/SKILL.md；禁用/删除 → 移除该技能目录。
async function syncPluginSkills(plugin){
 const copied=[],removed=[];
 for(const name of plugin.skills??[]){
  const directory=path.join(USER_SKILLS,name);
  if(plugin.enabled){
   const source=path.join(plugin.dir,'skills',name,'SKILL.md');
   let content;
   try{content=await readFile(source,'utf8');}
   catch(error){throw rpcCode('plugin/skills',`Cannot read plugin skill ${name}: ${error.message}`,500,{plugin:plugin.name,skill:name,path:source});}
   try{
    await mkdir(directory,{recursive:true,mode:0o700});
    const temporary=path.join(directory,'SKILL.md.tmp');
    await writeFile(temporary,content,{mode:0o600});
    await rename(temporary,path.join(directory,'SKILL.md'));
   }catch(error){throw rpcCode('plugin/skills',`Cannot sync plugin skill ${name}: ${error.message}`,500,{plugin:plugin.name,skill:name,path:directory});}
   copied.push(name);
  }else{
   await rm(directory,{recursive:true,force:true});
   removed.push(name);
  }
 }
 return {copied,removed};
}
async function syncEnabledPluginSkills(){
 for(const plugin of await collectPlugins())if(plugin.enabled&&!plugin.error)await syncPluginSkills(plugin);
}
async function togglePlugin(body){
 const name=requirePluginName(body,['enabled']);
 if(typeof body.enabled!=='boolean')throw rpcCode('request/invalid','enabled must be a boolean');
 const plugin=await findPlugin(name);
 if(!plugin)throw rpcCode('plugin/not-found',`Unknown plugin: ${name}`,404,{name});
 const disabled=new Set((await readPluginState()).disabled);
 if(body.enabled)disabled.delete(name);else disabled.add(name);
 await writePluginState(disabled);
 await syncPluginSkills({...plugin,enabled:body.enabled});
 packRootsCache=null;
 return {name,enabled:body.enabled};
}
async function installPlugin(body){
 for(const key of Object.keys(body))if(key!=='path')throw rpcCode('request/invalid',`Unknown plugin field: ${key}`);
 const source=requireString(body,'path');
 if(!path.isAbsolute(source))throw rpcCode('plugin/install','Plugin path must be an absolute directory',400,{path:source});
 const resolved=path.resolve(source);
 const info=await stat(resolved).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;throw error;});
 if(!info?.isDirectory())throw rpcCode('plugin/install',`Not a directory: ${resolved}`,400,{path:resolved});
 const manifest=await pluginManifest(resolved);
 const existing=await findPlugin(manifest.name);
 if(existing?.builtin)throw rpcCode('plugin/builtin',`${manifest.name} is a builtin plugin name and cannot be replaced`,400,{name:manifest.name});
 const target=path.join(USER_PLUGINS,manifest.name),userRoot=path.resolve(USER_PLUGINS);
 if(resolved!==target){
  if(resolved===userRoot||inside(target,resolved)||inside(resolved,userRoot))throw rpcCode('plugin/install','Source directory overlaps the user plugin root',400,{name:manifest.name,path:resolved});
  await mkdir(USER_PLUGINS,{recursive:true,mode:0o700});
  const staging=path.join(CODEX_HOME,`.plugin-${randomBytes(6).toString('hex')}`);
  try{
   await cp(resolved,staging,{recursive:true,force:true});
   await rm(target,{recursive:true,force:true});
   await rename(staging,target);
  }catch(error){
   await rm(staging,{recursive:true,force:true}).catch(cleanup=>console.error('codex-go: could not clean plugin staging: '+scrub(cleanup.message)));
   throw rpcCode('plugin/install',`Could not install plugin: ${error.message}`,500,{name:manifest.name,path:resolved});
  }
 }
 const installed=await findPlugin(manifest.name);
 if(installed?.enabled)await syncPluginSkills(installed);
 packRootsCache=null;
 return {name:manifest.name};
}
async function removePlugin(body){
 const name=requirePluginName(body);
 const plugin=await findPlugin(name);
 if(!plugin)throw rpcCode('plugin/not-found',`Unknown plugin: ${name}`,404,{name});
 if(plugin.builtin)throw rpcCode('plugin/builtin','Builtin plugins cannot be removed',400,{name});
 const target=path.resolve(plugin.dir),userRoot=path.resolve(USER_PLUGINS);
 if(target===userRoot||!inside(target,userRoot))throw rpcCode('plugin/remove','Refusing to remove a directory outside the user plugin root',400,{name,path:target});
 await rm(target,{recursive:true,force:true});
 const state=await readPluginState();
 if(state.disabled.includes(name))await writePluginState(state.disabled.filter(item=>item!==name));
 await syncPluginSkills({...plugin,enabled:false});
 packRootsCache=null;
 return {removed:true,name};
}

function requestBody(req){return new Promise((resolve,reject)=>{let size=0;const chunks=[];req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){reject(rpcCode('request/too-large','Request exceeds 128 MiB',413));req.destroy();}else chunks.push(chunk);});req.on('end',()=>{try{const data=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Expected JSON object');resolve(data);}catch{reject(rpcCode('request/json','Expected a JSON object'));}});req.on('error',reject);});}
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
function requireString(body,key){if(typeof body[key]!=='string'||!body[key].trim())throw rpcCode('request/invalid',`${key} is required`);return body[key];}
function authenticated(req,url){const bearer=req.headers.authorization?.replace(/^Bearer\s+/i,'');const query=url.searchParams.get('token');return secureEqual(bearer??query,TOKEN);}
function safeError(error){
 const code=error.code??'bridge/internal';
 const details={...error.details};
 if(/^provider\/models-/.test(code)&&details.baseUrl){
  const openai=!details.wire||details.wire==='openai-chat'||details.wire==='openai-responses';
  details.normalizedBaseUrl??=details.baseUrl;
  details.hint??=openai
   ?`模型列表拉取失败，已按 ${details.baseUrl} 处理。请检查 Base URL 是否少了 /v1；也可以直接手动输入模型 ID，不会被这个错误阻断。`
   :`模型列表拉取失败，已按 ${details.baseUrl} 处理。请检查该协议的地址与密钥，或直接手动输入模型 ID。`;
 }
 return {code,message:scrub(error.message??'Bridge request failed'),...(Object.keys(details).length?{details}:{}),...(details.hint?{hint:details.hint,normalizedBaseUrl:details.normalizedBaseUrl}:{})};
}
async function history(threadId, cursor) {
 const {thread} = await rpc.call('thread/read', {threadId, includeTurns:false});
 if (thread.historyMode === 'paginated') {
  const page = await rpc.call('thread/items/list', {threadId, limit:200, sortDirection:'desc', ...(cursor ? {cursor} : {})});
  return {threadId, thread, items:[...page.data].reverse().map(entry => ({...entry.item, turnId:entry.turnId})), nextCursor:page.nextCursor ?? null};
 }
 const response = await rpc.call('thread/read', {threadId, includeTurns:true});
 const turns = response.thread.turns ?? [];
 return {threadId, thread:response.thread, items:turns.flatMap(turn => (turn.items ?? []).map(item => ({...item, turnId:turn.id}))), turns};
}
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
 try{
  if(url.pathname==='/healthz'){json(res,rpc.ready?200:503,{ok:rpc.ready,engine:'codex',mode:'app-server',bridge:BRIDGE_REV,codexVersion,seq,activeTurns:turns.size,compatPort});return;}
  if(url.pathname==='/api/events'){
   if(!authenticated(req,url))throw rpcCode('auth/required','A valid bridge token is required',401);
   if(req.headers.origin&&req.headers.origin!==url.origin)throw rpcCode('auth/origin','Cross-origin event streams are not allowed',403);
   const after=Number(url.searchParams.get('after')??req.headers['last-event-id']??seq);if(!Number.isSafeInteger(after)||after<0)throw rpcCode('request/invalid','Invalid event cursor');
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
   // 立即刷出响应头，否则没有回放事件时客户端要等到第一次心跳（15s）才拿到流。
   res.write(': connected\n\n');
   const threadId=url.searchParams.get('threadId');
   if(ring.length&&after<ring[0].seq-1)res.write(`data: ${JSON.stringify({type:'resync.required',seq,message:'Event history expired; reload the thread'})}\n\n`);
   else for(const item of ring)if(item.seq>after&&(!threadId||!item.threadId||item.threadId===threadId))res.write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);
   const client={res,threadId};sse.add(client);const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);
   req.on('close',()=>{clearInterval(heartbeat);sse.delete(client);});return;
  }
  if(url.pathname.startsWith('/api/')){
   if(!authenticated(req,url))throw rpcCode('auth/required','A valid bridge token is required',401);
   if(req.headers.origin&&req.headers.origin!==url.origin)throw rpcCode('auth/origin','Cross-origin API requests are not allowed',403);
   if(!rpc.ready)throw rpcCode('codex/unavailable','Codex app-server is not ready',503);
   const endpoint=url.pathname.slice(5);const body=req.method==='POST'?await requestBody(req):{};let result;
 if(endpoint==='providers'&&req.method==='GET'){
  const cfg=configValue(await rawConfig());
  const map=cfg.model_providers||cfg.modelProviders||{};
  const secrets=await readSecrets();
  const list=[];
  for(const id of Object.keys(map)){
   const p=map[id]||{};
   const key=p.env_key||null;
   list.push({id,baseUrl:p.base_url||p.baseUrl||null,envKey:key,apiKeyConfigured:!!(key&&(secrets[key]||process.env[key]))});
  }
  json(res,200,{current:cfg.model_provider||'openai',model:cfg.model||null,providers:list});
  return;
 }
   if(endpoint==='subagent/tree'&&req.method==='GET'){
    const parentThreadId=url.searchParams.get('parentThreadId');
    json(res,200,agentRegistry.tree(parentThreadId===null?{}:{parentThreadId}));
    return;
   }
   if(endpoint==='bridge/stop'&&req.method==='POST') {
    json(res,200,{stopping:true});
    setImmediate(shutdown);
    return;
   }
   if(endpoint==='models'&&req.method==='GET'){
    const value=await rpc.call('model/list',{includeHidden:false,limit:200});result={models:(value.data??value.models??[]).map(model=>({...model,name:model.displayName??model.name??model.id})),nextCursor:value.nextCursor??null};
   }else if(endpoint==='account'&&req.method==='GET')result=await rpc.call('account/read',{refreshToken:false});
   else if(endpoint==='account/login/start'&&req.method==='POST')result=await rpc.call('account/login/start',{type:body.type??'chatgpt',useHostedLoginSuccessPage:true});
   else if(endpoint==='account/login/complete'&&req.method==='POST'){
     const callback=await completeLocalOAuthCallback(body.callbackUrl);
     if(!callback.ok)throw rpcCode('account/callback-rejected',`The OAuth callback was rejected with HTTP ${callback.status}; paste the complete final browser address`,400);
     const account=await rpc.call('account/read',{refreshToken:false});
     if(!account.account)throw rpcCode('account/not-ready','The callback was delivered, but the account is not ready yet; retry in a few seconds',409);
     broadcast({type:'account.updated',method:'account/login/completed'});
     result={ok:true,account:account.account};
    }
    else if(endpoint==='account/logout'&&req.method==='POST')result=await rpc.call('account/logout',{});
   else if(endpoint==='config')result=req.method==='GET'?await configView():req.method==='POST'?await configure(body):(()=>{throw rpcCode('request/method','Use GET or POST',405);})();
   else if(req.method!=='POST')throw rpcCode('request/method','Use POST for this endpoint',405);
   else if(endpoint==='thread/list'){
    const value=await rpc.call('thread/list',{limit:100,sortKey:'updated_at',...(body.cwd?{cwd:body.cwd}:{})});
    result={threads:(value.data??value.threads??[]).map(thread=>({...thread,title:thread.name??thread.preview??thread.id,updatedAt:thread.updatedAt,cwd:thread.cwd})),nextCursor:value.nextCursor??null};
   }else if(endpoint==='thread/create'){
    if(body.cwd!==undefined&&typeof body.cwd!=='string')throw rpcCode('request/invalid','cwd must be a path string');
    if(body.config!==undefined&&(!body.config||typeof body.config!=='object'||Array.isArray(body.config)))throw rpcCode('request/invalid','config must be an object');
    const cwd=body.cwd?.trim()||CWD;const override=validateDeveloperInstructions(body.developerInstructions);const developerInstructions=await effectiveDeveloperInstructions(null,override??undefined);const params={cwd,developerInstructions,...(body.config?{config:body.config}:{}) ,...(body.model?{model:body.model}:{}),...(body.provider?{modelProvider:body.provider}:{}),...(body.approvalPolicy?{approvalPolicy:migrateApproval(body.approvalPolicy)}:{})};
    const value=await rpc.call('thread/start',params);const thread=value.thread;if(!thread?.id)throw rpcCode('codex/protocol','thread/start did not return a thread',502);loadingThreads.add(thread.id);if(override)threadInstructionOverrides.set(thread.id,override);threadInjectedInstructions.set(thread.id,developerInstructions);rememberThreadProvider(thread.id,value.modelProvider??params.modelProvider??null);result={threadId:thread.id,thread,channel:threadProviders.get(thread.id)??null,developerInstructions};broadcast({type:'thread.changed',threadId:thread.id});
   }else if(endpoint==='thread/resume'){
    const threadId = requireString(body, 'threadId');
    const override=validateDeveloperInstructions(body.developerInstructions);
    const prepared=await prepareThreadInstructions(threadId,body.developerInstructions===undefined?undefined:override);
    result = {...await history(prepared.threadId, body.cursor), channel:threadProviders.get(prepared.threadId)??null};
   }else if(endpoint==='thread/rename'){const threadId=requireString(body,'threadId');result=await rpc.call('thread/name/set',{threadId,name:requireString(body,'title')});broadcast({type:'thread.changed',threadId});}
   else if(endpoint==='thread/archive'){result=await rpc.call('thread/archive',{threadId:requireString(body,'threadId')});}
   else if(endpoint==='thread/delete'){const threadId=requireString(body,'threadId');result=await rpc.call('thread/delete',{threadId});broadcast({type:'thread.changed',threadId,deleted:true});}
   else if(endpoint==='turn/send'){
    let threadId=requireString(body,'threadId');if(turns.has(threadId))throw rpcCode('codex/thread-busy','This thread already has a running turn',409);
    const instructionOverride=validateDeveloperInstructions(body.developerInstructions);
    // 老 thread 只认建线程时的 provider：切渠道后还往它发新渠道的模型名，上游会回
    // 「模型不存在」让 codex 重试 5 次（真机表现就是一直 Reconnecting、报错来自别的渠道）。
    // 与其打到错的上游，不如明确拒绝，让客户端先把它 fork 到当前渠道。
    const channel=await activeChannelRecord();
    const bound=threadProviders.get(threadId)??null;
    if(channel&&bound&&bound!==channel.id)throw rpcCode('channel/thread-binding',`这个会话绑在渠道「${bound}」上，不能直接发到「${channel.id}」`,409,{threadId,boundChannel:bound,activeChannel:channel.id,hint:'POST /api/thread/fork 把它搬到当前渠道，再发一次'});
    const originalInput=[];if(typeof body.text==='string'&&body.text.trim())originalInput.push({type:'text',text:body.text});
    const preparedAttachments=await stageLargeTextAttachments(body,{cwd:CWD});
    const {input,warnings:attachmentWarnings}=buildCodexAttachmentInput(preparedAttachments,{input:originalInput});
    if(!input.length)throw rpcCode('request/invalid','Text, image or file input is required');
    const prepared=await prepareThreadInstructions(threadId,body.developerInstructions===undefined?undefined:instructionOverride);threadId=prepared.threadId;
    turns.set(threadId,'starting');touchTurn(threadId);
    const cfgNow=configValue(await rawConfig());
    const cfgModel=body.model??channel?.model??cfgNow.model;
     const sandboxPolicies={'read-only':{type:'readOnly'},'workspace-write':{type:'workspaceWrite'},'danger-full-access':{type:'dangerFullAccess'}};
     if(body.sandboxMode!==undefined&&!sandboxPolicies[body.sandboxMode])throw rpcCode('config/sandbox','Unsupported sandbox mode');
     const sandboxPolicy=body.sandboxMode?sandboxPolicies[body.sandboxMode]:null;
    // 记下这一轮真正的策略：App 传了就用 App 的，没传就沿用本机 config（手机上是 never/danger-full-access）。
   threadApprovalPolicy.set(threadId,migrateApproval(body.approvalPolicy??cfgNow.approval_policy??'on-request'));
   threadSandboxMode.set(threadId,body.sandboxMode??cfgNow.sandbox_mode??null);
   try{const value=await rpc.call('turn/start',{threadId,input,summary:'auto',...(cfgModel?{model:cfgModel}:{}),...(body.reasoningEffort?{effort:body.reasoningEffort}:{}),...(body.approvalPolicy?{approvalPolicy:migrateApproval(body.approvalPolicy)}:{}),...(sandboxPolicy?{sandboxPolicy}:{})});const turnId=value.turn?.id;if(!turnId)throw rpcCode('codex/protocol','turn/start did not return a turn',502);if(turns.has(threadId))turns.set(threadId,turnId);result={threadId,turnId,...(attachmentWarnings.length?{attachmentWarnings}:{})};}catch(error){turns.delete(threadId);throw error;}
   }else if(endpoint==='turn/interrupt'){
    const threadId=requireString(body,'threadId');const turnId=body.turnId??turns.get(threadId);if(!turnId||turnId==='starting')throw rpcCode('codex/no-active-turn','No interruptible turn is active',409);result=await rpc.call('turn/interrupt',{threadId,turnId});
   }else if(endpoint==='turn/active'){
    result={turns:[...turns.entries()].map(([threadId,turnId])=>({threadId,turnId}))};
   }else if(endpoint==='turn/interrupt-all'){
    const interrupted=[],failed=[];
    for(const [threadId,turnId] of [...turns.entries()]){
     if(turnId==='starting'){turns.delete(threadId);failed.push({threadId,turnId,reason:'turn was still starting'});continue;}
     try{await rpc.call('turn/interrupt',{threadId,turnId});turns.delete(threadId);interrupted.push({threadId,turnId});}
     catch(error){failed.push({threadId,turnId,reason:scrub(error.message||'interrupt failed')});}
    }
    result={interrupted,failed,remaining:[...turns.keys()]};
   }else if(endpoint==='turn/steer'){
    const threadId=requireString(body,'threadId');const text=typeof body.text==='string'?body.text.trim():'';if(!text)throw rpcCode('request/invalid','Text is required');
    const expectedTurnId=body.expectedTurnId??turns.get(threadId);if(!expectedTurnId||expectedTurnId==='starting')throw rpcCode('codex/no-active-turn','No steerable turn is active',409);
    result=await rpc.call('turn/steer',{threadId,expectedTurnId,input:[{type:'text',text}]});
   }else if(endpoint==='thread/goal'){
    const threadId=requireString(body,'threadId');const action=body.action??'get';
    if(action==='set')result=await rpc.call('thread/goal/set',{threadId,objective:body.objective??null,status:body.status??null,tokenBudget:body.tokenBudget??null});
    else if(action==='clear')result=await rpc.call('thread/goal/clear',{threadId});
    else result=await rpc.call('thread/goal/get',{threadId});
   }else if(endpoint==='thread/revert'){
   // 只截断持久化对话历史；协议明确不会撤销文件、命令或外部服务副作用。
   // 活动回合中拒绝，避免删掉正在运行的回合后留下陈旧 busy/turnId。
   const threadId=requireString(body,'threadId');
   const beforeTurnId=requireString(body,'beforeTurnId');
   if(turns.has(threadId))throw rpcCode('codex/thread-busy','Stop the active turn before reverting conversation history',409);
   const value=await rpc.call('thread/revert',{threadId,beforeTurnId});
   loadingThreads.delete(threadId);
   broadcast({type:'thread.reverted',threadId,beforeTurnId});
   result={threadId,beforeTurnId,...(value&&typeof value==='object'?value:{})};
   }else if(endpoint==='skills'){
    // 技能面板：直接透传 codex 的 skills/list。
    result=await rpc.call('skills/list',{includeDisabled:true});
   }else if(endpoint==='mcp'){
    result=await rpc.call('mcpServerStatus/list',{});
    }else if(endpoint==='mcp/add'){
     result=await addMcpServer(body);
    }else if(endpoint==='mcp/remove'){
     result=await removeMcpServer(body);
    }else if(endpoint==='workflow/list'){
     result={workflows:workflowStore.list()};
    }else if(endpoint==='workflow/create'){
     result=await workflowStore.create(body);
    }else if(endpoint==='workflow/get'){
     const id=requireString(body,'id');result={workflow:workflowStore.get(id),runs:workflowStore.runsFor(id)};
    }else if(endpoint==='workflow/delete'){
     result=await workflowStore.delete(requireString(body,'id'));
    }else if(endpoint==='workflow/run'){
     result=await workflowStore.run(requireString(body,'id'),{approveShell:body.approveShell===true});
   }else if(endpoint==='fs/list'){
    result=await rpc.call('fs/readDirectory',{path:requireString(body,'path')});
   }else if(endpoint==='fs/write'){
    // 写文件：codex 要 base64，这里把明文 content 编好再转发。
    const target=requireString(body,'path');const text=typeof body.content==='string'?body.content:'';
    await rpc.call('fs/createDirectory',{path:target.replace(/[\\/][^\\/]+$/,''),recursive:true}).catch(()=>{});
    result=await rpc.call('fs/writeFile',{path:target,dataBase64:Buffer.from(text,'utf8').toString('base64')});
   }else if(endpoint==='thread/rebind'){
    result=await rebindThread(body);
   }else if(endpoint==='thread/fork'){
    // 切渠道后把老会话搬到新渠道只能靠 fork：codex 的 thread/resume 会忽略
    // model/modelProvider，thread/fork 才会按新 provider 重建（实测 0.170）。
    // 默认 fork 到当前活动渠道，历史照抄，所以对话内容不丢。
    const sourceId=requireString(body,'threadId');
    const activeChannel=await activeChannelRecord();
    const modelProvider=typeof body.modelProvider==='string'&&body.modelProvider.trim()?body.modelProvider.trim():activeChannel?.id??null;
    const model=typeof body.model==='string'&&body.model.trim()?body.model.trim():activeChannel?.model??null;
    // lastTurnId：从某条消息所在回合分支（codex 原生支持），不传就是整段历史照抄。
    const lastTurnId=typeof body.lastTurnId==='string'&&body.lastTurnId.trim()?body.lastTurnId.trim():null;
    const developerInstructions=await effectiveDeveloperInstructions(sourceId);
    const value=await rpc.call('thread/fork',{threadId:sourceId,developerInstructions,...(lastTurnId?{lastTurnId}:{}),...(body.cwd?{cwd:body.cwd}:{}),...(modelProvider?{modelProvider}:{}),...(model?{model}:{})});
    const forkedId=value.thread?.id;if(!forkedId)throw rpcCode('codex/protocol','thread/fork did not return a thread',502);
    loadingThreads.add(forkedId);threadInjectedInstructions.set(forkedId,developerInstructions);if(threadInstructionOverrides.has(sourceId))threadInstructionOverrides.set(forkedId,threadInstructionOverrides.get(sourceId));
    rememberThreadProvider(forkedId,value.modelProvider??modelProvider);
    result={threadId:forkedId,thread:value.thread,modelProvider:value.modelProvider??modelProvider,model:value.model??model};
    broadcast({type:'thread.changed',threadId:forkedId});
   }else if(endpoint==='thread/compact'){
    const threadId=requireString(body,'threadId');result=await rpc.call('thread/compact/start',{threadId});
   }else if(endpoint==='exec'){
    // 交互式终端：真 PTY + 流式 stdout/stderr，供 App 的 xterm 使用。
    const processId=requireString(body,'processId');
    const argv=Array.isArray(body.argv)?body.argv.map(String):['/bin/bash','-i'];
    if(!argv.length)throw rpcCode('request/invalid','argv is required');
    rpc.call('command/exec',{
     command:argv,
     processId,
     tty:true,
     streamStdin:true,
     streamStdoutStderr:true,
     cwd:typeof body.cwd==='string'&&body.cwd.trim()?body.cwd:null,
     size:{rows:Number(body.rows)||30,cols:Number(body.cols)||90},
     disableTimeout:true,
    }).catch(()=>{});
    result={processId};
   }else if(endpoint==='exec/write'){
    result=await rpc.call('command/exec/write',{processId:requireString(body,'processId'),deltaBase64:body.deltaBase64??null,closeStdin:body.closeStdin===true});
   }else if(endpoint==='exec/resize'){
    result=await rpc.call('command/exec/resize',{processId:requireString(body,'processId'),size:{rows:Number(body.rows)||30,cols:Number(body.cols)||90}});
   }else if(endpoint==='exec/terminate'){
    result=await rpc.call('command/exec/terminate',{processId:requireString(body,'processId')});
   }else if(endpoint==='approval'){
    const approvalId=requireString(body,'approvalId');const approval=pendingApprovals.get(approvalId);if(!approval)throw rpcCode('codex/approval-expired','Approval is no longer pending',409);
    const decisions=new Set(['accept','acceptForSession','decline','cancel']);if(!decisions.has(body.decision))throw rpcCode('request/invalid','Invalid approval decision');
    if(approval.method==='mcpServer/elicitation/request'){
     const action=body.decision==='decline'?'decline':body.decision==='cancel'?'cancel':'accept';
     if(body.decision==='acceptForSession'){
      const serverName=String(approval.params?.serverName??'');
      if(serverName)sessionApprovedMcp.add(serverName);
     }
     rpc.reply(approval.id,{action,content:null,_meta:null});
    }else if(approval.method.includes('permissions')){
     if(body.decision==='acceptForSession')rpc.reply(approval.id,{permissions:approval.params.permissions??{},scope:'session'});
     else rpc.reply(approval.id,{permissions:body.decision==='accept'?(approval.params.permissions??{}):{},scope:'turn'});
    }else rpc.reply(approval.id,{decision:body.decision});pendingApprovals.delete(approvalId);broadcast({type:'approval.resolved',approvalId,threadId:approval.params.threadId,decision:body.decision});result={ok:true};
   }else if(endpoint==='subagent/run'){
    result=await subagentRun(body);
   }else if(endpoint==='subagent/runs'){
    result={runs:subagentRuns};
   }else if(endpoint==='providers/models'){
    result=await providerModels(body);
   }else if(endpoint==='channels'){
    result=await channelListView();
   }else if(endpoint==='channels/save'){
    result=await saveChannel(body);
   }else if(endpoint==='channels/remove'){
    result=await removeChannel(body);
   }else if(endpoint==='channels/activate'){
    result=await activateChannel(body);
   }else if(endpoint==='channels/models'){
    result=await channelModels(body);
   }else if(endpoint==='channels/test'){
    result=await channelTest(body);
   }else if(endpoint==='toolpacks'){
    result=await listToolpacks();
   }else if(endpoint==='toolpacks/toggle'){
    result=await toggleToolpack(body);
   }else if(endpoint==='toolpacks/import'){
    result=await importToolpack(body);
   }else if(endpoint==='toolpacks/remove'){
    result=await removeToolpack(body);
   }else if(endpoint==='context'){
    result=await contextView(body);
   }else if(endpoint==='context/config'){
    result=await contextConfigure(body);
   }else if(endpoint==='context/compact'){
    result=await contextCompact(body);
   }else if(endpoint==='persona'){
    result=await personaView(body);
   }else if(endpoint==='persona/save'){
    result=await savePersona(body);
   }else if(endpoint==='plugins'){
    result=await listPlugins(body);
   }else if(endpoint==='plugins/install'){
    result=await installPlugin(body);
   }else if(endpoint==='plugins/remove'){
    result=await removePlugin(body);
   }else if(endpoint==='plugins/toggle'){
    result=await togglePlugin(body);
   }else throw rpcCode('request/not-found','Unknown bridge endpoint',404);
   json(res,200,result??{});return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD')throw rpcCode('request/method','Use GET',405);
  let relative;try{relative=decodeURIComponent(url.pathname);}catch{throw rpcCode('request/path','Invalid URL path');}
  const target=path.resolve(WEB,'.'+(relative==='/'?'/index.html':relative));if(target!==WEB&&!target.startsWith(WEB+path.sep))throw rpcCode('request/path','Path is outside WebUI',403);
  let content;try{content=await readFile(target);}catch{throw rpcCode('request/not-found','WebUI resource not found',404);}
  res.writeHead(200,{'content-type':MIME[path.extname(target)]??'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cache-control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
 }catch(error){if(!res.headersSent)json(res,error.status??500,{error:safeError(error)});else res.end();}
});

async function shutdown(){
 if(stopping)return;
 stopping=true;
 for(const client of sse)client.res.end();
 sse.clear();
 server.close();
 await removeHandshake();
 // 兼容代理和 bridge 一起退出，别在后台留一个监听端口。
 try{await compatProxy?.close();}catch(error){console.error('codex-go: could not close the compatibility proxy: '+scrub(error.message));}
 compatProxy=null;compatPort=null;
 const child=rpc.process;
 if(child&&child.exitCode===null){
  child.stdin.end();
  await new Promise(resolve=>{
   const timeout=setTimeout(()=>{child.kill();resolve();},3000);
   child.once('exit',()=>{clearTimeout(timeout);resolve();});
  });
 }
 setTimeout(()=>process.exit(0),100).unref();
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
await mkdir(CODEX_HOME,{recursive:true,mode:0o700});
// 兼容代理先起来：激活 chat 渠道时要把它的回环端口写进 codex 的 base_url。
try{
 compatProxy=await startCompatProxy(0,'127.0.0.1',{lookupChannel:compatLookupChannel,onToolArgumentsDelta:event=>{
  if(turns.get(event.threadId)!==event.turnId)return;
  const enriched={type:'tool.args.delta',...event};
  agentRegistry.accept(enriched);
  broadcast(enriched);
 }});
 compatPort=compatProxy.port;
 console.log(`Compatibility proxy: http://127.0.0.1:${compatPort}/v1/<channel>/responses`);
}catch(error){
 compatProxy=null;compatPort=null;
 console.error('codex-go: compatibility proxy failed to start: '+scrub(error.message));
}
await workflowStore.load();
try{agentRegistry.restore(JSON.parse(await readFile(AGENT_BOARD_FILE,'utf8')));}catch(error){if(error.code!=='ENOENT')console.error('codex-go: could not restore the agent board: '+scrub(error.message));}
// 上下文设置要在第一个 tokenUsage 之前就读进内存（trackUsage 是同步的）。
try{await readContextSettings();}catch(error){console.error('codex-go: context settings unreadable, using defaults: '+scrub(error.message));}
try{
 // config.toml 指向一个已被删掉的 provider 时，codex 所有 RPC 都会失败（连读配置都不行），
 // 那就没法用 RPC 修它。开机前先在文件层把悬空引用复位，否则整个桥等于砖了。
 await healDanglingProvider();
 await rpc.start();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(PORT,HOST,resolve);});
 // 启动时对齐渠道：如果用户上次选了 chat 渠道，而 codex 配置被别处（旧 provider 路径）改回直连，
 // 这里重新应用一次，避免一启动就打到只支持 chat/completions 的中转站上。
 try{const state=await readChannels();const active=state.channels.find(channel=>channel.id===state.active);
  if(active)await applyChannelConfig(active);}catch(error){console.error('codex-go: channel bootstrap failed: '+scrub(error.message));}
 const roots=await toolpackRoots();
 console.log(`Toolpacks: builtin=${roots[0].dir} user=${roots[1].dir}`);
 console.log(`Plugins: builtin=${(await pluginRoots())[0].dir} user=${(await pluginRoots())[1].dir}`);
 // 启动时补齐已启用插件的技能，避免清数据后技能目录缺失；失败不影响桥接启动。
 try{await syncEnabledPluginSkills();}catch(error){console.error('codex-go: plugin skill sync failed: '+scrub(error.message));}
 const baseUrl=await writeHandshake(server.address());
 console.log(`codex-go: ${baseUrl}/?token=${TOKEN}`);
 console.log(`Codex app-server ready. Engine: codex; protocol baseline: 0.170.0`);
}catch(error){console.error(scrub(error.message));await shutdown();process.exitCode=1;}
