// system: 真实主机事实（node:os / statfs / tasklist / ps），以及对当前环境是否允许
// 执行命令、写文件的自检（tooling_status）。所有结论都来自真实探测，不做猜测。
import {existsSync,readFileSync} from 'node:fs';
import {statfs} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {optionalInteger,runProcess,truncateText} from '../_shared.mjs';

const REDACTED_NAME=/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|PRIVATE)/i;
const MAX_PROCESSES=400;
const EXEC_PROBE_TIMEOUT_MS=2000;
const CODEX_HOME=path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
const CONFIG_FILE=path.join(CODEX_HOME,'config.toml');

const fail=(message,code)=>Object.assign(new Error(message),{code});
const argsError=error=>fail(error?.message??'invalid arguments','args/invalid');
const maybeInteger=(value,label,options)=>{try{return optionalInteger(value,label,options);}catch(error){throw argsError(error);}};

// 读 ${CODEX_HOME}/config.toml 的 sandbox_mode：缺失、不可读或没有该键时返回 null。
function sandboxMode(){
 try{
  for(const line of readFileSync(CONFIG_FILE,'utf8').split(/\r?\n/)){
   const match=/^\s*sandbox_mode\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))/.exec(line);
   if(match)return match[1]??match[2]??match[3]??null;
  }
 }catch{/* 读不到就当作未知 */}
 return null;
}

// 只读沙箱里不允许启动外部进程：先抛 sandbox/denied，绝不“悄悄跑一下试试”。
function assertExecAllowed(operation){
 if(sandboxMode()==='read-only')throw fail(`${operation} is blocked: the current sandbox is read-only (${CONFIG_FILE} sets sandbox_mode = "read-only"), so starting external processes is refused and nothing was executed. Call tooling_status for the full picture, or ask the user to switch sandbox_mode.`,'sandbox/denied');
}

// 真实探测“能不能起进程”：起一个立即退出的空命令，成功退出码 0 才算可用。
// Windows 没有 /bin/sh，因此先试 cmd.exe，再退回当前 Node.js 可执行文件。
function probeExec(){
 const attempts=[];
 const candidates=process.platform==='win32'
  ?[{label:'cmd.exe',command:process.env.ComSpec||path.join(process.env.SystemRoot??'C:\\Windows','System32','cmd.exe'),args:['/d','/c','exit 0']}]
  :[{label:'/bin/sh',command:'/bin/sh',args:['-c','true']}];
 candidates.push({label:'node',command:process.execPath,args:['-e','']});
 for(const candidate of candidates){
  if(typeof candidate.command!=='string'||!candidate.command)continue;
  if(!existsSync(candidate.command)){attempts.push(`${candidate.label}: not found at ${candidate.command}`);continue;}
  let result;
  try{result=spawnSync(candidate.command,candidate.args,{timeout:EXEC_PROBE_TIMEOUT_MS,windowsHide:true,stdio:'ignore'});}
  catch(error){attempts.push(`${candidate.label}: could not start (${error.message})`);continue;}
  if(result?.error){attempts.push(`${candidate.label}: could not start (${result.error.message})`);continue;}
  if(result?.status===0)return {available:true,attempts};
  attempts.push(`${candidate.label}: exited with ${result?.status??`signal ${result?.signal??'unknown'}`}`);
 }
 return {available:false,attempts};
}

function humanDuration(seconds){
 const parts=[];
 let rest=Math.max(0,Math.floor(seconds));
 const days=Math.floor(rest/86400);rest-=days*86400;
 const hours=Math.floor(rest/3600);rest-=hours*3600;
 const minutes=Math.floor(rest/60);rest-=minutes*60;
 if(days)parts.push(`${days}d`);
 if(hours)parts.push(`${hours}h`);
 if(minutes)parts.push(`${minutes}m`);
 parts.push(`${rest}s`);
 return parts.join(' ');
}

function uname(){
 const cpus=os.cpus();
 return {
  platform:os.platform(),
  type:os.type(),
  release:os.release(),
  version:os.version(),
  arch:os.arch(),
  hostname:os.hostname(),
  machine:process.arch,
  node:process.version,
  cpuCount:cpus.length,
  cpuModel:cpus[0]?.model??null,
  totalMemoryBytes:os.totalmem(),
  freeMemoryBytes:os.freemem(),
  uptimeSeconds:Math.floor(os.uptime()),
  uptimeHuman:humanDuration(os.uptime()),
 };
}

async function diskUsage(roots){
 const volumes=[];
 for(const root of roots){
  try{
   const stats=await statfs(root);
   const blockSize=stats.bsize??stats.frsize??4096;
   const totalBytes=Number(stats.blocks)*Number(blockSize);
   const freeBytes=Number(stats.bfree)*Number(blockSize);
   const availableBytes=Number(stats.bavail)*Number(blockSize);
   volumes.push({
    path:root,
    totalBytes,
    freeBytes,
    availableBytes,
    usedBytes:totalBytes-freeBytes,
    usedPercent:totalBytes?Number((((totalBytes-freeBytes)/totalBytes)*100).toFixed(2)):null,
    blockSize,
   });
  }catch(error){
   volumes.push({path:root,error:error.code??error.message});
  }
 }
 return volumes;
}

function parseCsvLine(line){
 const fields=[];let current='';let quoted=false;
 for(let index=0;index<line.length;index++){
  const character=line[index];
  if(character==='"'){
   if(quoted&&line[index+1]==='"'){current+='"';index++;continue;}
   quoted=!quoted;continue;
  }
  if(character===','&&!quoted){fields.push(current);current='';continue;}
  current+=character;
 }
 fields.push(current);
 return fields;
}

// runProcess 的 timeout/spawn 失败要翻译成“执行不可用”系列 code，
// 让模型知道该调 tooling_status 而不是怀疑参数。
async function execute(argv,options){
 try{return await runProcess(argv,options);}
 catch(error){
  if(error?.code==='toolpack/timeout')throw fail(`Command timed out after ${options?.timeoutMs??60000}ms while running ${argv.join(' ')}. The host is slow or the command hung; retry with a smaller limit or inspect it with another tool.`,'exec/timeout');
  throw fail(`Could not start ${argv[0]}: ${error?.message??String(error)}. Process execution appears to be unavailable in this sandbox; call tooling_status to confirm, then ask the user to relax sandbox_mode instead of retrying blindly.`,'exec/unavailable');
 }
}

async function processList(args,ctx){
 const limit=maybeInteger(args.limit,'limit',{min:1,max:MAX_PROCESSES,fallback:200});
 assertExecAllowed('system_process_list');
 const platform=os.platform();
 let processes=[],truncated=false,source;
 if(platform==='win32'){
  source='tasklist';
  const result=await execute(['tasklist','/fo','csv','/nh'],{timeoutMs:20000,maxBytes:4*1024*1024});
  if(result.exitCode!==0)throw fail(`tasklist exited with ${result.exitCode??result.signal}: ${(result.stderr||result.stdout||'no output').trim().slice(0,1000)}. Process listing is not working in this environment; call tooling_status to check whether execution is allowed.`,'exec/unavailable');
  processes=result.stdout.split(/\r?\n/).filter(Boolean).map(line=>{
   const fields=parseCsvLine(line.trim());
   if(fields.length<5)return null;
   return {name:fields[0],pid:Number(fields[1]),session:fields[2],sessionNumber:Number(fields[3]),memory:fields[4]};
  }).filter(Boolean).sort((a,b)=>a.pid-b.pid);
  truncated=result.truncated;
 }else{
  source='ps';
  const result=await execute(['ps','-axo','pid=,ppid=,comm='],{timeoutMs:20000,maxBytes:4*1024*1024});
  if(result.exitCode!==0)throw fail(`ps exited with ${result.exitCode??result.signal}: ${(result.stderr||result.stdout||'no output').trim().slice(0,1000)}. Process listing is not working in this environment; call tooling_status to check whether execution is allowed.`,'exec/unavailable');
  processes=result.stdout.split(/\r?\n/).filter(Boolean).map(line=>{
   const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
   if(!match)return null;
   return {pid:Number(match[1]),ppid:Number(match[2]),name:match[3]};
  }).filter(Boolean).sort((a,b)=>a.pid-b.pid);
  truncated=result.truncated;
 }
 const total=processes.length;
 if(processes.length>limit)processes=processes.slice(0,limit);
 return {platform,source,total,returned:processes.length,truncated:truncated||total>limit,processes};
}

function envRedacted(){
 const variables=[];
 const redactedNames=[];
 for(const name of Object.keys(process.env).sort()){
  const value=process.env[name]??'';
  if(REDACTED_NAME.test(name)){
   redactedNames.push(name);
   variables.push({name,redacted:true,value:null,valueLength:value.length});
   continue;
  }
  variables.push({name,redacted:false,value:truncateText(value,500)});
 }
 return {count:variables.length,redactedCount:redactedNames.length,redactedNames,variables};
}

// 环境自检：把“当前到底允许做什么”一次性说清楚，模型就不必靠猜。
function toolingStatus(args,ctx){
 const mode=sandboxMode();
 const roots=Array.isArray(ctx?.roots)?ctx.roots.map(root=>String(root)):[];
 const dataDir=typeof ctx?.dataDir==='string'?ctx.dataDir:null;
 const bridge=ctx?.bridge;
 const bridgeConnected=Boolean(bridge&&typeof bridge==='object'
  &&typeof bridge.baseUrl==='string'&&bridge.baseUrl
  &&typeof bridge.token==='string'&&bridge.token);
 const readOnly=mode==='read-only';
 const probe=readOnly?{available:false,attempts:['skipped because the sandbox is read-only']}:probeExec();
 const notes=[];
 notes.push(mode===null
  ?`No sandbox_mode is configured, so ${CONFIG_FILE} did not restrict command execution or file writes.`
  :`sandbox_mode is "${mode}" according to ${CONFIG_FILE}.`);
 if(readOnly){
  notes.push('The current sandbox is read-only: tools that execute commands or write files fail with sandbox/denied until the user changes sandbox_mode.');
 }else if(mode!==null){
  notes.push(`The sandbox policy "${mode}" allows this toolkit to attempt writes and command execution; the operating system may still refuse individual paths.`);
 }
 notes.push(probe.available
  ?'Starting a no-op process succeeded, so command execution works right now.'
  :`No process could be started (${probe.attempts.join('; ')}), so tools that spawn programs are expected to fail with exec/unavailable.`);
 if(process.platform==='win32')notes.push('Windows has no /bin/sh, so the exec probe tries cmd.exe first and then the running Node.js binary.');
 notes.push(roots.length
  ?`Allowed roots: ${roots.join(', ')}. Files outside them fail with path/outside-roots.`
  :'No allowed roots are configured, so every path-based tool fails with path/outside-roots.');
 notes.push(bridgeConnected
  ?'A bridge handshake with baseUrl and token is loaded, so admin, threads and subagent tools can call the bridge.'
  :'No bridge handshake with baseUrl and token is loaded, so admin, threads and subagent tools fail with bridge/token-missing until the bridge runs.');
 notes.push(`Toolpack state is stored in ${dataDir??'an unknown dataDir'}.`);
 return {sandboxMode:mode,roots,dataDir,bridgeConnected,execAvailable:probe.available,notes};
}

export const meta={
 name:'system',
 title:'System',
 version:'1.1.0',
 description:'Host facts, disk usage, uptime, process listing, a redacted environment dump, and a tooling_status self-check that reports the sandbox mode, allowed roots, bridge state and whether command execution really works.',
};

export const tools=[
 {
  name:'system_uname',
  description:'Identify the host before relying on platform-specific behaviour: operating system name, release and version, architecture, hostname, CPU model and count, memory totals and system uptime. Takes no parameters. Returns {platform (Node.js platform id such as win32 or linux), type, release, version, arch, hostname, machine (process architecture), node (Node.js version), cpuCount, cpuModel, totalMemoryBytes, freeMemoryBytes, uptimeSeconds, uptimeHuman}. Read-only, needs no bridge and never starts an external process, so it is always safe to call first. There are no anticipated failures: only tool/internal can occur if the host process itself is broken.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async()=>uname(),
 },
 {
  name:'system_df',
  description:'Check free disk space for every configured allowed root before writing large files, unpacking archives or cloning repositories. Takes no parameters. Returns {volumes: [{path, totalBytes, freeBytes, availableBytes, usedBytes, usedPercent, blockSize}]}, one entry per allowed root; a root that cannot be inspected instead yields {path, error} with the system error code, and the overall call still succeeds. usedPercent is a number with two decimals, or null when total capacity is unknown. Bytes are raw byte counts, not MiB. A single uninspectable root is reported inside its own volume entry and never fails the whole call; the only error is tool/internal if the host process itself is broken.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async(args,ctx)=>({volumes:await diskUsage(ctx.roots)}),
 },
 {
  name:'system_uptime',
  description:'Tell a freshly started container from a long-lived host, and read the machine load trivially. Takes no parameters. Returns {systemUptimeSeconds, systemUptimeHuman (for example "3d 4h 5m 6s"), processUptimeSeconds (this MCP server process), loadAverage: [oneMinute, fiveMinute, fifteenMinute] as floats}. On Windows the load averages are reported as 0 by platform convention; that is not an error. Read-only and always safe to call; there are no anticipated failures except tool/internal if the host process itself is broken.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async()=>({
   systemUptimeSeconds:Math.floor(os.uptime()),
   systemUptimeHuman:humanDuration(os.uptime()),
   processUptimeSeconds:Math.floor(process.uptime()),
   loadAverage:os.loadavg(),
  }),
 },
 {
  name:'system_process_list',
  description:'See what is already running before starting a server, build or watcher: duplicate processes, occupied ports and stuck children. limit: 1-400, default 200; the list is sorted by pid and cut to limit. Windows runs tasklist /fo csv /nh, other platforms run ps -axo pid=,ppid=,comm=; both are spawned directly without a shell. Returns {platform, source ("tasklist" or "ps"), total (all processes found), returned, truncated (true when anything was hidden), processes} where each process is {name, pid, session, sessionNumber, memory} on Windows or {pid, ppid, name} elsewhere. Fails with sandbox/denied when the current sandbox is read-only, exec/unavailable when the listing command cannot start or exits non-zero (the message names the command and its stderr), exec/timeout after 20 seconds, args/invalid for a limit outside 1-400.',
  inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:400,description:'Maximum number of processes returned, 1-400; defaults to 200.'}},required:[],additionalProperties:false},
  run:processList,
 },
 {
  name:'system_env_redacted',
  description:'Discover configuration through environment variables (data directories, proxy settings, feature flags) without leaking credentials. Takes no parameters. Returns {count, redactedCount, redactedNames (names only), variables: [{name, redacted, value, valueLength}]}; any variable whose name matches KEY, TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, COOKIE, AUTH or PRIVATE is reported with redacted true and value null so only its length survives. Non-secret values are truncated to 500 characters. The output is safe to quote back to the user; read-only and needs no bridge, and the only anticipated failure is tool/internal if the host process itself is broken.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async()=>envRedacted(),
 },
 {
  name:'tooling_status',
  description:'Call this first when you are about to run a command or write a file and are unsure whether the current environment allows it, instead of concluding that the tools are broken or guessing about the sandbox. Takes no parameters and changes nothing. sandboxMode is read from ${CODEX_HOME}/config.toml (the sandbox_mode key) and is null when that file or key is missing or unreadable; read-only means command execution and file writes are refused with sandbox/denied. roots lists the absolute allowed directories, dataDir is where toolpack state is stored, bridgeConnected is true only when a bridge handshake with both baseUrl and token is loaded (admin, threads and subagent tools need it), and execAvailable is the result of really starting a no-op program (cmd.exe on Windows, /bin/sh on POSIX, falling back to the running Node.js binary) and is false when the sandbox is read-only. Returns {sandboxMode, roots, dataDir, bridgeConnected, execAvailable, notes} where notes is a list of plain English sentences describing the current limits. Errors: tool/internal only if the process environment itself cannot be inspected; environment restrictions are reported as values, never as failures.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:toolingStatus,
 },
];
