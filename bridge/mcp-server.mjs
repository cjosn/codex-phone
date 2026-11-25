// Dependency-free MCP stdio host for Codex Pocket toolpacks.
// Configure in Codex: command="node", args=["/absolute/path/bridge/mcp-server.mjs"].
//
// Packs are directories with an index.mjs that exports {meta, tools}. The host loads
// builtin packs from <this file>/toolpacks and user packs from ${CODEX_HOME}/toolpacks,
// skipping any pack listed in ${CODEX_HOME}/codex-go-toolpacks.json {"disabled":[...]}.
// Tool names are globally unique; a conflict is reported on stderr and the later tool
// is ignored instead of crashing the server.
//
// Every tools/call reply is normalised by the host into one envelope, so packs never have
// to care: success is {ok:true,data}, failure is {ok:false,error:{code,message}}.
import {existsSync} from 'node:fs';
import {readdir,readFile,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {compactTool,createToolCatalog} from './tool-catalog.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR=path.join(HERE,'toolpacks');
const CODEX_HOME=path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
const USER_DIR=path.join(CODEX_HOME,'toolpacks');
const DISABLED_FILE=path.join(CODEX_HOME,'codex-go-toolpacks.json');
const BRIDGE_FILE=path.join(CODEX_HOME,'codex-go-bridge.json');
const DATA_DIR=path.resolve(process.env.CODEX_GO_DATA_DIR||path.join(process.cwd(),'.codex-go'));
const SERVER_NAME='codex-go-local-toolkit';
const SERVER_VERSION='2.0.0';
// 默认 120s；测试和特殊部署可以用 CODEX_GO_TOOL_TIMEOUT_MS 调小，最小值 100ms。
const TOOL_TIMEOUT_MS=Math.max(100,Math.floor(Number(process.env.CODEX_GO_TOOL_TIMEOUT_MS)||120000));
const TOOL_NAME_PATTERN=/^[a-z][a-z0-9_]{0,63}$/;
const PACK_NAME_PATTERN=/^[a-z][a-z0-9_-]{0,63}$/;

const warn=message=>process.stderr.write(`[toolpacks] ${message}\n`);

// --- allowed roots -----------------------------------------------------------
const roots=[];
for(const value of (process.env.CODEX_GO_ALLOWED_ROOTS||process.cwd()).split(path.delimiter)){
 if(!value)continue;
 const resolved=path.resolve(value);
 try{roots.push(await realpath(resolved));}
 catch(error){warn(`ignoring allowed root ${resolved}: ${error.code==='ENOENT'?'directory does not exist':error.message}`);}
}
if(!roots.length){
 try{
  roots.push(await realpath(process.cwd()));
  warn(`no usable allowed roots were configured; using the working directory ${roots[0]}`);
 }catch(error){
  warn(`cannot resolve the working directory: ${error.message}`);
  process.exit(1);
 }
}

// --- state files -------------------------------------------------------------
async function readDisabled(){
 try{
  const value=JSON.parse(await readFile(DISABLED_FILE,'utf8'));
  const list=Array.isArray(value?.disabled)?value.disabled:Array.isArray(value)?value:[];
  return new Set(list.filter(item=>typeof item==='string'));
 }catch(error){
  if(error.code!=='ENOENT')warn(`ignoring unreadable ${DISABLED_FILE}: ${error.message}`);
  return new Set();
 }
}

async function readBridge(){
 try{
  const value=JSON.parse(await readFile(BRIDGE_FILE,'utf8'));
  if(!value||typeof value.baseUrl!=='string'||typeof value.token!=='string'||!value.token){
   warn(`ignoring ${BRIDGE_FILE}: expected {"baseUrl","token"}`);
   return null;
  }
  const url=new URL(value.baseUrl);
  if(!['http:','https:'].includes(url.protocol))throw Error('baseUrl must be http or https');
  return {baseUrl:value.baseUrl.replace(/\/+$/,''),token:value.token};
 }catch(error){
  if(error.code!=='ENOENT')warn(`bridge handshake unavailable: ${error.message}`);
  return null;
 }
}

// --- pack loading ------------------------------------------------------------
async function loadPacks(){
 const disabled=await readDisabled();
 const packs=[],tools=[],owners=new Map();
 for(const [origin,directory] of [['builtin',BUILTIN_DIR],['user',USER_DIR]]){
  let entries;
  try{entries=await readdir(directory,{withFileTypes:true});}
  catch(error){
   if(error.code!=='ENOENT')warn(`cannot read the ${origin} pack directory ${directory}: ${error.message}`);
   continue;
  }
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){
   if(!entry.isDirectory())continue;
   if(disabled.has(entry.name))continue;
   const packDirectory=path.join(directory,entry.name);
   let module;
   try{module=await import(pathToFileURL(path.join(packDirectory,'index.mjs')).href);}
   catch(error){warn(`skipping ${origin} pack directory "${entry.name}": ${error.message}`);continue;}
   const meta=module.meta;
   if(!meta||typeof meta!=='object'||Array.isArray(meta)){warn(`skipping ${origin} pack "${entry.name}": no meta export`);continue;}
   if(typeof meta.name!=='string'||!PACK_NAME_PATTERN.test(meta.name)){warn(`skipping ${origin} pack "${entry.name}": invalid meta.name ${JSON.stringify(meta.name)}`);continue;}
   if(disabled.has(meta.name))continue;
   if(packs.some(pack=>pack.name===meta.name)){warn(`skipping ${origin} pack "${meta.name}" (${packDirectory}): pack name already loaded`);continue;}
   if(!Array.isArray(module.tools)||module.tools.length===0){warn(`skipping ${origin} pack "${meta.name}": no tools exported`);continue;}
   const pack={
    name:meta.name,
    title:typeof meta.title==='string'&&meta.title.trim()?meta.title:meta.name,
    version:typeof meta.version==='string'&&meta.version.trim()?meta.version:'0.0.0',
    description:typeof meta.description==='string'?meta.description:'',
    builtin:origin==='builtin',
    enabled:true,
    directory:packDirectory,
    tools:[],
   };
   for(const tool of module.tools){
    if(!tool||typeof tool!=='object'||Array.isArray(tool)){warn(`ignoring a non-object tool in pack "${meta.name}"`);continue;}
    if(typeof tool.name!=='string'||!TOOL_NAME_PATTERN.test(tool.name)){warn(`ignoring tool ${JSON.stringify(tool.name)} in pack "${meta.name}": names must match ${TOOL_NAME_PATTERN}`);continue;}
    if(typeof tool.description!=='string'||!tool.description.trim()){warn(`ignoring tool "${tool.name}" in pack "${meta.name}": a description is required`);continue;}
    if(typeof tool.run!=='function'){warn(`ignoring tool "${tool.name}" in pack "${meta.name}": run must be a function`);continue;}
    const schema=tool.inputSchema;
    if(!schema||typeof schema!=='object'||schema.type!=='object'){warn(`ignoring tool "${tool.name}" in pack "${meta.name}": inputSchema must be an object schema`);continue;}
    if(owners.has(tool.name)){warn(`ignoring duplicate tool name "${tool.name}" from pack "${meta.name}": already provided by pack "${owners.get(tool.name)}"`);continue;}
    owners.set(tool.name,meta.name);
    const record={name:tool.name,description:tool.description,inputSchema:schema,run:tool.run,pack:meta.name,builtin:pack.builtin};
    tools.push(record);
    pack.tools.push({name:record.name,description:record.description,inputSchema:record.inputSchema});
   }
   if(!pack.tools.length){warn(`skipping ${origin} pack "${meta.name}": every exported tool was rejected`);continue;}
   packs.push(pack);
  }
 }
 return {packs,tools};
}

// --- measured tooling status -------------------------------------------------
// initialize.instructions 里的 toolingStatus 只放宿主真的探测过的事实，模型据此判断
// 「能不能真跑命令 / 写文件 / 连网络」，不允许靠猜；同一份事实也通过 ctx 交给工具包，
// 让包能在 read-only 时抛 sandbox/denied。
const SHELL_CANDIDATES=process.platform==='win32'
 ? [process.env.ComSpec,process.env.SystemRoot?path.join(process.env.SystemRoot,'System32','cmd.exe'):null,'C:\\Program Files\\Git\\bin\\bash.exe']
 : ['/bin/sh','/usr/bin/sh','/bin/bash'];
const execShell=SHELL_CANDIDATES.find(candidate=>typeof candidate==='string'&&candidate&&existsSync(candidate))??null;

// 读 ${CODEX_HOME}/config.toml 里的 sandbox_mode；读不到就是 null，不猜默认值。
async function readSandboxMode(){
 try{
  const text=await readFile(path.join(CODEX_HOME,'config.toml'),'utf8');
  const match=text.match(/^\s*sandbox_mode\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
  if(!match)return null;
  const value=(match[1]??match[2]??match[3]??'').trim();
  return value||null;
 }catch{return null;}
}

const {packs,tools}=await loadPacks();
const catalog=createToolCatalog(tools);
const hasFullHelp=tools.some(tool=>tool.name==='tool_help'&&tool.builtin&&tool.pack==='catalog');
// A disabled/rejected help pack must never leave summaries with an unavailable
// help entry point. User pack metadata is always published exactly as declared.
const listedTools=tools.map(tool=>tool.builtin&&hasFullHelp?compactTool(tool):({name:tool.name,description:tool.description,inputSchema:tool.inputSchema}));
const initialSandboxMode=await readSandboxMode();
const ctx={
 describeTool:catalog.describeTool,
 roots,
 dataDir:DATA_DIR,
 bridge:await readBridge(),
 timeoutMs:TOOL_TIMEOUT_MS,
 bridgeFile:BRIDGE_FILE,
 sandboxMode:initialSandboxMode,
 readOnly:initialSandboxMode==='read-only',
 execAvailable:Boolean(execShell),
 execShell,
};
const summary=packs.map(pack=>`${pack.name}(${pack.tools.length})`).join(', ');
warn(`loaded ${packs.length} packs, ${tools.length} tools: ${summary}`);
if(!ctx.bridge)warn(`no bridge handshake at ${BRIDGE_FILE}; bridge-backed tools (subagent, prompt workflow steps) will fail until the bridge runs`);

// --- MCP protocol ------------------------------------------------------------
const TOOL_INDEX=new Map(tools.map(tool=>[tool.name,tool]));

function send(message){process.stdout.write(JSON.stringify(message)+'\n');}

async function runWithTimeout(tool,args){
 if(args===undefined||args===null)args={};
 if(typeof args!=='object'||Array.isArray(args))throw Object.assign(Error('tools/call arguments must be a JSON object'),{code:'args/invalid'});
 let timer;
 const timeout=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(Object.assign(Error(`Tool "${tool.name}" timed out after ${ctx.timeoutMs}ms`),{code:TIMEOUT_ERROR_CODE})),ctx.timeoutMs);
  timer.unref?.();
 });
 try{
  return await Promise.race([Promise.resolve().then(()=>tool.run(args,ctx)),timeout]);
 }finally{clearTimeout(timer);}
}

// --- result envelope ---------------------------------------------------------
// 全项目统一口径（详见 TOOLPACKS-CONTRACT.md §3.1）：
//   成功  {ok:true, data:<工具自己的返回值>}
//   失败  {ok:false, error:{code:<area>/<kebab>, message}}
// 归一化只在宿主做，工具包不需要改：run() 的返回值没有布尔 ok 字段时由宿主补外壳；
// 自带布尔 ok 的返回值（web_fetch / http_request / github_api / ping）视为已经是信封，原样透传。
const DEFAULT_ERROR_CODE='tool/internal';
const TIMEOUT_ERROR_CODE='tool/timeout';
const ERROR_CODE_PATTERN=/^[a-z][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

function successEnvelope(value){
 if(isObject(value)&&typeof value.ok==='boolean')return value;
 return {ok:true,data:value===undefined?null:value};
}

// 只接受 "<area>/<kebab>" 形状的错误码；ENOENT 之类的系统码一律归入 tool/internal，
// 这样模型看到的 code 永远在词表形状内。
function errorEnvelope(error){
 const raw=typeof error?.code==='string'?error.code.trim():'';
 const code=ERROR_CODE_PATTERN.test(raw)?raw:DEFAULT_ERROR_CODE;
 const message=typeof error?.message==='string'&&error.message.trim()
  ?error.message.trim()
  :(String(error??'').trim()||'Tool failed without a message');
 return {ok:false,error:{code,message}};
}

function successResult(value){
 const structuredContent=successEnvelope(value);
 let text;
 try{text=JSON.stringify(structuredContent);}
 catch{throw Object.assign(Error('Tool returned a value that is not JSON serializable'),{code:DEFAULT_ERROR_CODE});}
 if(typeof text!=='string')throw Object.assign(Error('Tool returned a value that is not JSON serializable'),{code:DEFAULT_ERROR_CODE});
 return {content:[{type:'text',text}],structuredContent,isError:false};
}

function failureResult(error){
 const structuredContent=errorEnvelope(error);
 return {content:[{type:'text',text:`${structuredContent.error.code}: ${structuredContent.error.message}`}],structuredContent,isError:true};
}

// Requests are handled one at a time, in arrival order. MCP clients expect replies in
// order, and serialising calls keeps workflow/memory writes deterministic.
let queue=Promise.resolve();
function enqueue(task){
 const next=queue.then(task,task);
 queue=next.then(()=>undefined,()=>undefined);
 return next;
}

// initialize.instructions 是模型看到的唯一「运行环境自述」。这里只写宿主真的测到的
// 事实（sandbox_mode、允许根、数据目录、bridge 握手、shell 是否存在），并明确要求模型
// 据此判断能力，不要猜。
async function buildInstructions(){
 // 每次 initialize 重新读一次 config.toml，并同步回 ctx，保证「告诉模型的事实」和
 // 「工具包拿到的 ctx.sandboxMode」永远是同一份。
 const sandboxMode=await readSandboxMode();
 ctx.sandboxMode=sandboxMode;
 ctx.readOnly=sandboxMode==='read-only';
 const status={
  sandboxMode,
  roots:[...roots],
  dataDir:DATA_DIR,
  bridgeConnected:Boolean(ctx.bridge),
  execAvailable:Boolean(execShell),
  execShell,
 };
 return [
  `Codex Pocket local toolkit. ${packs.length} toolpacks loaded: ${summary}.`,
  ...(hasFullHelp?['Builtin tool descriptions are discovery summaries; inputSchema is unchanged. Before first using a tool marked "Help: tool_help" or "Read tool_help", call tool_help({name:"<tool name>"}) and follow its complete original instructions, safety rules, defaults and result semantics. Help is read-only and covers only enabled, accepted tools.']:[]),
  'Every tools/call returns one JSON envelope in structuredContent: success is {"ok":true,"data":<tool value>}, failure is {"ok":false,"error":{"code":"<area>/<kebab>","message":"..."}}. content[0].text mirrors the envelope (on failure it reads "<code>: <message>") and isError is true only for the failure envelope.',
  'Branch on error.code (args/invalid, path/outside-roots, path/not-found, exec/unavailable, sandbox/denied, net/unreachable, net/http-status, tool/timeout, tool/internal, or a pack code such as git/not-a-repo) instead of parsing the message.',
  'When toolingStatus.sandboxMode is "read-only", tools that would write files or execute commands fail with sandbox/denied (network reads such as web_fetch still work); do not retry those calls with different arguments.',
  'The toolingStatus line below was measured by the host itself; use it to decide whether you can really run commands, write files, reach the bridge or the network instead of guessing.',
  'Terminal environments: call dev/env_probe before claiming a toolchain is or is not available. On a phone PRoot only bash/sh/git/tar are usually present; python3, java, go, rust and ssh can be added with dev/env_install (apt-get, runs in the background — poll dev/env_install_log until it finishes) and then run through dev/env_run, which uses bash by default.',
  `toolingStatus: ${JSON.stringify(status)}`,
 ].join('\n');
}

async function handle(message){
 const reply=result=>send({jsonrpc:'2.0',id:message.id,result});
 const fail=(code,text)=>send({jsonrpc:'2.0',id:message.id,error:{code,message:text}});
 try{
  if(message.method==='initialize'){
   return reply({
    protocolVersion:message.params?.protocolVersion||'2024-11-05',
    capabilities:{tools:{listChanged:false}},
    serverInfo:{name:SERVER_NAME,version:SERVER_VERSION},
    instructions:await buildInstructions(),
   });
  }
  if(message.method==='ping')return reply({});
  if(message.method==='tools/list')return reply({tools:listedTools});
  if(message.method==='tools/call'){
   const tool=TOOL_INDEX.get(message.params?.name);
   if(!tool)return fail(-32602,`Unknown tool: ${String(message.params?.name)}`);
   // The bridge may start after this process; re-read its handshake before failing.
   if(!ctx.bridge)ctx.bridge=await readBridge();
   try{
    // 成功路径：没有 ok 字段的返回值由宿主包成 {ok:true,data}。
    const value=await runWithTimeout(tool,message.params?.arguments);
    return reply(successResult(value));
   }catch(error){
    // 失败路径（含 tool/timeout）：统一 {ok:false,error:{code,message}}。
    return reply(failureResult(error));
   }
  }
  return fail(-32601,'Method not found');
 }catch(error){return fail(-32603,error?.message??String(error));}
}

createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
 let message;
 try{message=JSON.parse(line);}
 catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
 if(message.id===undefined)return; // Notifications require no response.
 enqueue(()=>handle(message)).catch(()=>{});
});
