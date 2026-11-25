// dev: probe and install terminal toolchains inside a phone PRoot rootfs.
//
// 真机事实（安卓 PRoot Ubuntu 24.04）：有 bash/sh/dash/git/tar/ps/top，node 只在
// /opt/node/bin/node；没有 python3/java/go/rustc/cargo/ssh/gcc/make/sqlite3/curl/wget。
// APK 里不可能把这些都塞进去（包已经 299MB），所以环境只能现场用 apt 装进 rootfs 的
// /usr（重启 App 不丢，但需要网络）。这一组工具就分两步：
//   env_probe       测「这台机器现在到底有什么」（只跑 --version，什么都不装）
//   env_install     用 apt-get 在后台装（立刻返回 + 日志路径，不阻塞模型）
//   env_install_log 读安装日志尾部（done 是启发式，说清信号来源）
//   env_run         在真 bash/sh 里跑命令（补齐 BSH 太低级的问题）
// 只读沙箱下「安装」和「执行」都在动手前抛 sandbox/denied（口径与 code/files 包一致：
// 参数校验 → 权限判定 → 执行），探测与读日志照常工作。
import {existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {open,stat} from 'node:fs/promises';
import path from 'node:path';
import {optionalBoolean,optionalInteger,requireString,resolveDirectory} from '../_shared.mjs';

// ---------------------------------------------------------------------------
// 统一失败约定：run() 只返回可 JSON 序列化的数据（宿主包成 {ok:true,data:V}），
// 失败一律 throw Error + code。_shared.mjs 抛的是旧的 toolpack/* 码，这里映射成本组
// 的统一码，消息原样保留（调用方/AI 已按这些措辞判断）。
// ---------------------------------------------------------------------------
const fail=(message,code)=>Object.assign(Error(message),{code});

const SHARED_ERROR_CODES={
 'toolpack/outside-roots':'path/outside-roots',
 'toolpack/timeout':'exec/unavailable',
 'toolpack/command-failed':'exec/unavailable',
};

function normalizeError(error){
 if(error&&typeof error==='object'&&typeof error.code==='string'){
  const mapped=SHARED_ERROR_CODES[error.code];
  if(mapped)return Object.assign(error,{code:mapped});
  if(error.code.includes('/'))return error;
 }
 const message=String(error?.message??error);
 const missing=message.match(/^Path does not exist: (.+)$/);
 if(missing)return fail(`Path does not exist: ${missing[1]}. Check the spelling against the allowed roots, then retry.`,'path/not-found');
 const parentMissing=message.match(/^Parent directory does not exist: (.+)$/);
 if(parentMissing)return fail(`Parent directory does not exist: ${parentMissing[1]}. Create the parent first, then retry.`,'path/not-found');
 if(/^Not a directory: /.test(message))return fail(`${message}. This tool needs a directory inside an allowed root; pass a directory path instead, then retry.`,'path/not-a-file');
 if(/^Not a regular file: /.test(message))return fail(`${message}. This tool needs a regular file; directories and devices are rejected.`,'path/not-a-file');
 if(/outside the allowed roots/i.test(message))return fail(message,'path/outside-roots');
 if(/must be an integer between|must be a nonempty string|must be a boolean|must be a nonempty string array|must be one of/i.test(message))return fail(`${message}. Read the tool inputSchema for the accepted type, range and enum values, then retry.`,'args/invalid');
 if(/does not exist/i.test(message))return fail(message,'path/not-found');
 if(/ENOENT|not found on PATH|spawn /i.test(`${error?.code??''} ${message}`))return fail(`${message}. The external command is missing or not on PATH, so nothing was executed; call env_probe to see what this host really has.`,'exec/unavailable');
 return fail(message,'tool/internal');
}

function guard(run){
 return async(args,ctx)=>{
  try{
   return await run(args??{},ctx);
  }catch(error){
   throw normalizeError(error);
  }
 };
}

// 只读沙箱判定：宿主可能在 ctx（readOnly / readonly / sandboxMode / sandbox.mode /
// sandbox.type）或环境变量里声明只读；任一命中即拒绝安装/执行（fail closed）。
const READ_ONLY_VALUES=new Set(['read-only','readonly','read_only','readonly-mode','ro']);
function isReadOnlySandbox(ctx){
 const candidates=[
  ctx?.readOnly,ctx?.readonly,ctx?.sandboxMode,ctx?.sandbox?.readOnly,
  ctx?.sandbox?.mode,ctx?.sandbox?.type,
  ctx?.env?.CODEX_GO_SANDBOX_MODE,process.env.CODEX_GO_SANDBOX_MODE,
  process.env.CODEX_GO_SANDBOX,process.env.SANDBOX_MODE,
 ];
 for(const value of candidates){
  if(value===true)return true;
  if(typeof value==='string'&&READ_ONLY_VALUES.has(value.trim().toLowerCase()))return true;
 }
 return false;
}

function requireWritableSandbox(ctx,tool,what){
 if(!isReadOnlySandbox(ctx))return;
 throw fail(`${tool} ${what}, but this session runs in a read-only sandbox, so nothing was executed and nothing was written. Ask the user to switch the sandbox to workspace-write or danger-full-access and retry. env_probe and env_install_log still work because they install nothing.`,'sandbox/denied');
}

// ---------------------------------------------------------------------------
// 子进程环境：PATH 追加 /opt/node/bin（真机上 node 只在这里）和当前 Node 所在目录，
// 这样「不在 /usr/bin 的 node」也能被探测到和调用到。Windows 上 process.env 里键名可能
// 是 Path，先统一去掉再写 PATH，避免同一变量传两份。
// ---------------------------------------------------------------------------
const EXTRA_PATH_ENTRIES=['/opt/node/bin'];

function commandPath(){
 const seen=[];
 for(const value of String(process.env.PATH??'').split(path.delimiter)){
  const entry=value.trim();
  if(entry&&!seen.includes(entry))seen.push(entry);
 }
 for(const extra of [...EXTRA_PATH_ENTRIES,path.dirname(process.execPath)]){
  if(extra&&!seen.includes(extra))seen.push(extra);
 }
 return seen.join(path.delimiter);
}

function commandEnv(extra={}){
 const env={};
 for(const [key,value] of Object.entries(process.env))if(key.toLowerCase()!=='path')env[key]=value;
 env.PATH=commandPath();
 return {...env,...extra};
}

// ---------------------------------------------------------------------------
// 1) env_probe：固定清单逐个 spawnSync(cmd,['--version'])，shell:false，5 s 超时。
// sh/bash 没有可移植的 --version 形式，按约定用 -c 'echo ok' 判存在（版本记 null）。
// 「可用」= 操作系统真的把这个二进制起来了：spawn 报错（ENOENT）算没有，探测 5 s 超时
// 算没有，Windows 应用执行别名桩（exit 9009）算没有；但「打印 usage 后非零退出」的
// 工具（ssh/go/java 的某些版本就是这样）算存在，否则会把装好的东西报成没装。
// ---------------------------------------------------------------------------
const PROBE_TIMEOUT_MS=5000;
const PROBE_LIST=[
 'bash','sh','node','python3','pip3','git','tar','ssh','scp','java','javac','go','cargo',
 'rustc','gcc','make','sqlite3','curl','wget','unzip','jq',
];
const SHELL_PROBES=new Set(['bash','sh']);
// --version 输出为空或退出非零时，用各家真正的版本开关再试一次，只为拿到版本串。
const VERSION_FALLBACK_ARGS={
 ssh:['-V'],scp:['-V'],java:['-version'],javac:['-version'],go:['version'],
};
const WINDOWS_ALIAS_STUB_EXIT=9009;
const MAX_VERSION_CHARS=160;

function firstOutputLine(value){
 for(const line of String(value??'').split(/\r?\n/)){
  const trimmed=line.trim();
  if(trimmed)return trimmed.length>MAX_VERSION_CHARS?`${trimmed.slice(0,MAX_VERSION_CHARS)}...`:trimmed;
 }
 return null;
}

// spawnSync never throws for a missing binary: it returns {error:{code:'ENOENT'}}.
function spawnSyncProbe(argv,{timeoutMs=PROBE_TIMEOUT_MS}={}){
 try{
  return {
   result:spawnSync(argv[0],argv.slice(1),{
    shell:false,
    windowsHide:true,
    timeout:timeoutMs,
    encoding:'utf8',
    maxBuffer:2*1024*1024,
    stdio:['ignore','pipe','pipe'],
    env:commandEnv(),
   }),
  };
 }catch(error){
  return {thrown:error};
 }
}

function spawnFailureReason(error,timeoutMs){
 const code=error?.code??'UNKNOWN';
 if(code==='ENOENT')return 'not found on PATH';
 if(code==='ETIMEDOUT')return `did not answer within ${timeoutMs} ms`;
 if(code==='EACCES'||code==='EPERM')return `not executable (${code})`;
 return `could not be started (${code}: ${error?.message??'unknown error'})`;
}

function probeOne(name,{captureVersion=true}={}){
 const argv=SHELL_PROBES.has(name)?[name,'-c','echo ok']:[name,'--version'];
 const outcome=spawnSyncProbe(argv);
 const spawned=outcome.thrown?{error:outcome.thrown}:outcome.result;
 const spawnError=spawned.error??null;
 if(spawnError){
  return {name,available:false,version:null,spawnErrorCode:spawnError.code??'UNKNOWN',reason:spawnFailureReason(spawnError,PROBE_TIMEOUT_MS)};
 }
 if(spawned.status===WINDOWS_ALIAS_STUB_EXIT){
  return {name,available:false,version:null,spawnErrorCode:null,reason:`the Windows App Execution Alias stub answered with exit ${WINDOWS_ALIAS_STUB_EXIT} instead of a real binary`};
 }
 let line=SHELL_PROBES.has(name)?null:(firstOutputLine(spawned.stdout)??firstOutputLine(spawned.stderr));
 let exitCode=spawned.status;
 if(line===null&&!SHELL_PROBES.has(name)){
  for(const flags of VERSION_FALLBACK_ARGS[name]??[]){
   const retry=spawnSyncProbe([name,...flags]);
   if(retry.thrown||retry.result.error)break;
   line=firstOutputLine(retry.result.stdout)??firstOutputLine(retry.result.stderr);
   exitCode=retry.result.status;
   if(line!==null)break;
  }
 }
 // 真机上 sh/bash 只判存在，版本记 null（-c 'echo ok' 不产生版本信息）。
 return {name,available:true,version:captureVersion?line:null,spawnErrorCode:null,reason:null,exitCode};
}

function probeAll({captureVersion=true}={}){
 return PROBE_LIST.map(name=>probeOne(name,{captureVersion}));
}

// ---------------------------------------------------------------------------
// 2) env_install：白名单别名 → apt 包名；后台 nohup，立刻返回日志路径。
// ---------------------------------------------------------------------------
const INSTALL_LOG_PREFIX='/tmp/codex-go-env-';
const INSTALL_LOG_PATTERN=/^\/tmp\/codex-go-env-[A-Za-z0-9._-]{1,120}\.log$/;
const MAX_INSTALL_PACKAGES=8;
// `node` 不在白名单里：运行时自带 /opt/node/bin/node，装 Ubuntu 的 nodejs 反而会遮蔽它。
const INSTALL_WHITELIST=Object.freeze({
 python:['python3','python3-pip'],
 ssh:['openssh-client'],
 java:['default-jdk-headless'],
 go:['golang-go'],
 rust:['rustc','cargo'],
 build:['build-essential'],
 sqlite:['sqlite3'],
 net:['curl','wget'],
 unzip:['unzip'],
 jq:['jq'],
});

// POSIX 单引号转义：apt 命令整段作为一个参数交给内层 sh -c。
function shellQuote(value){return `'${String(value).replace(/'/g,"'\\''")}'`;}

function normalizePackages(value){
 if(!Array.isArray(value)||value.length===0){
  throw fail(`packages must be a nonempty array of tool names from the install whitelist (${Object.keys(INSTALL_WHITELIST).join(', ')}), for example ["python","ssh"]. Nothing was executed and apt was not started.`,'args/invalid');
 }
 if(value.length>MAX_INSTALL_PACKAGES){
  throw fail(`packages lists ${value.length} entries, above the ${MAX_INSTALL_PACKAGES} entry limit for one call, so nothing was executed and apt was not started. Split the work into several env_install calls of at most ${MAX_INSTALL_PACKAGES} names each.`,'args/invalid');
 }
 const unknown=value.filter(item=>typeof item!=='string'||!Object.hasOwn(INSTALL_WHITELIST,item.trim()));
 if(unknown.length){
  throw fail(`packages contains ${JSON.stringify(unknown[0])}, which is not in the install whitelist (${Object.keys(INSTALL_WHITELIST).join(', ')}), so nothing was executed and apt was not started. Use only whitelisted names; arbitrary apt packages are refused on purpose because an unbounded apt-get can reinstall or remove system packages inside the rootfs.`,'args/invalid');
 }
 const aliases=[...new Set(value.map(item=>item.trim()))];
 const aptPackages=[...new Set(aliases.flatMap(alias=>INSTALL_WHITELIST[alias]))];
 return {aliases,aptPackages};
}

function installLogPath(){
 return `${INSTALL_LOG_PREFIX}${Date.now()}-${process.pid}.log`;
}

function installScript(aptPackages,logPath){
 const apt=`apt-get update -y && apt-get install -y --no-install-recommends ${aptPackages.join(' ')}`;
 return `nohup sh -c ${shellQuote(apt)} > ${shellQuote(logPath)} 2>&1 &`;
}

// detached + stdio:'ignore' + unref()：宿主进程退出后 apt 继续跑；用 'spawn' 事件等
// 「真的起来了」再返回，'error' 事件则如实报 exec/unavailable（Windows 上没有 sh）。
function startInstall(script){
 return new Promise((resolve,reject)=>{
  let child;
  try{
   child=spawn('sh',['-c',script],{
    detached:true,
    stdio:'ignore',
    shell:false,
    windowsHide:true,
    env:commandEnv({DEBIAN_FRONTEND:'noninteractive',APT_LISTCHANGES_FRONTEND:'none'}),
   });
  }catch(error){
   return reject(fail(`sh could not be started to run apt-get (${error.code??'unknown error'}: ${error.message}), so nothing was installed. This tool needs a Linux host with sh and apt-get; env_probe shows what this host really has.`,'exec/unavailable'));
  }
  child.once('error',error=>{
   reject(fail(`sh could not be started to run apt-get (${error.code??'unknown error'}: ${error.message}), so nothing was installed and no log was written. This tool needs a Linux host with sh and apt-get; env_probe shows what this host really has.`,'exec/unavailable'));
  });
  child.once('spawn',()=>{
   child.unref();
   resolve({pid:child.pid??null});
  });
 });
}

// ---------------------------------------------------------------------------
// 3) env_install_log：只读 /tmp/codex-go-env-*.log 的尾部若干行，done 是启发式。
// ---------------------------------------------------------------------------
const LOG_TAIL_BYTES=1024*1024;
const LOG_DEFAULT_LINES=60;
const LOG_MAX_LINES=500;
const LOG_IDLE_MS=5000;

function requireInstallLogPath(value){
 requireString(value,'logPath');
 const text=value.trim();
 if(!INSTALL_LOG_PATTERN.test(text)){
  throw fail(`logPath must be an exact install log path this toolkit created, matching /tmp/codex-go-env-<name>.log (got ${JSON.stringify(value)}), so env_install_log cannot be pointed at any other file. Pass the logPath that env_install returned, then retry.`,'path/outside-roots');
 }
 return text;
}

async function readLogTail(target){
 const info=await stat(target);
 if(!info.isFile())throw fail(`${target} is not a regular file, so there is no install log to read. Pass the logPath that env_install returned.`,'path/not-found');
 const length=Math.min(info.size,LOG_TAIL_BYTES);
 const handle=await open(target,'r');
 try{
  if(length===0)return {text:'',bytes:info.size,modifiedAt:info.mtimeMs,truncated:false};
  const buffer=Buffer.alloc(length);
  await handle.read(buffer,0,length,info.size-length);
  let text=buffer.toString('utf8');
  // 从中间截断时丢掉第一个不完整的行。
  const partial=info.size>length?text.indexOf('\n'):-1;
  if(partial>=0)text=text.slice(partial+1);
  return {text,bytes:info.size,modifiedAt:info.mtimeMs,truncated:info.size>length};
 }finally{
  await handle.close();
 }
}

function logReading(text,{bytes,modifiedAt},limit){
 const lines=text.split('\n').map(line=>line.endsWith('\r')?line.slice(0,-1):line);
 while(lines.length&&lines[lines.length-1]==='')lines.pop();
 const tail=lines.slice(-limit);
 const sawError=/(^|\n)\s*E: \S/.test(text);
 const sawSetup=/(^|\n)Setting up \S/.test(text);
 const idleFor=Date.now()-modifiedAt;
 const signals=[];
 if(sawError)signals.push('the log contains an apt failure line ("E: ")');
 if(sawSetup)signals.push('the log contains a "Setting up <package>" line');
 if(idleFor>=LOG_IDLE_MS)signals.push(`the log has not changed for ${Math.round(idleFor)} ms`);
 const done=signals.length>0;
 const exitHint=done
  ? `heuristic signal(s): ${signals.join('; ')}. This is a guess, not apt's exit code: a long multi-package install can still be running after apt has printed "Setting up", so read the lines above and poll again before concluding success.`
  : `no completion marker yet and the log changed ${Math.round(idleFor)} ms ago, so apt is probably still installing; wait a few seconds and poll again. A log with no "Setting up" line and no "E: " line is the normal state while apt-get update is still downloading indexes.`;
 return {lines:tail,done,exitHint,bytes,truncated:false};
}

// ---------------------------------------------------------------------------
// 4) env_run：把 command 作为一个参数交给 bash/sh 的 -c。shell 解析顺序：绝对候选路径 →
// PATH 上的同名命令 → 宿主实测的 toolingStatus.execShell（Windows 上就是 cmd.exe），
// 返回里写明真正跑的是哪个，绝不假装是 bash。
// ---------------------------------------------------------------------------
const MAX_OUTPUT=1024*1024;
const DEFAULT_RUN_TIMEOUT_MS=30000;
const MAX_RUN_TIMEOUT_MS=110000;

const SHELL_CANDIDATES={
 bash:[
  '/bin/bash','/usr/bin/bash','/usr/local/bin/bash',
  'C:\\Program Files\\Git\\bin\\bash.exe','C:\\Program Files\\Git\\usr\\bin\\bash.exe',
 ],
 sh:['/bin/sh','/usr/bin/sh','/usr/local/bin/sh'],
};

function shellInvocation(shellPath){
 const base=path.basename(shellPath).toLowerCase().replace(/\.exe$/,'');
 if(base==='cmd')return {name:'cmd',args:['/d','/s','/c']};
 if(base==='powershell'||base==='pwsh')return {name:base,args:['-NoProfile','-NonInteractive','-Command']};
 return {name:base,args:['-c']};
}

function resolveShell(requested,ctx){
 const candidates=SHELL_CANDIDATES[requested]??[];
 for(const candidate of candidates)if(existsSync(candidate))return {path:candidate,how:'absolute candidate'};
 // 让操作系统按 PATH 解析（PRoot 里 bash 在 /bin，Windows 上通常就没有 bash）。
 const probe=spawnSync(requested,['-c','exit 0'],{shell:false,windowsHide:true,timeout:PROBE_TIMEOUT_MS,stdio:'ignore',env:commandEnv()});
 if(!probe.error&&probe.status===0)return {path:requested,how:'resolved through PATH'};
 const measured=typeof ctx.execShell==='string'&&ctx.execShell?ctx.execShell:null;
 if(measured&&existsSync(measured))return {path:measured,how:'toolingStatus.execShell fallback'};
 const tried=[...candidates,`${requested} on PATH`,measured??'toolingStatus.execShell=null'].join(', ');
 throw fail(`${requested} is not installed on this host and no fallback shell was usable (tried ${tried}), so nothing was executed. Read toolingStatus.execShell from initialize.instructions to see which shell this host really has; on a Linux PRoot, install one with env_install (the build alias pulls build-essential) or use the shell that is already there.`,'exec/unavailable');
}

const POSIX_SIGNALS=process.platform!=='win32';

function runShell(executable,args,cwd,timeoutMs){
 return new Promise((resolve,reject)=>{
  const startedAt=Date.now();
  let child;
  try{
   child=spawn(executable,args,{
    cwd,
    shell:false,
    windowsHide:true,
    // detached 让子进程自成进程组：超时时按组杀，孙进程（bash -c "sleep 5" 里的
    // sleep）不会继续攥着 stdout 让 'close' 拖到超时之后才到。
    detached:POSIX_SIGNALS,
    stdio:['ignore','pipe','pipe'],
    env:commandEnv(),
   });
  }catch(error){
   return reject(fail(`${executable} could not be started (${error.code??'unknown error'}: ${error.message}), so nothing was executed.`,'exec/unavailable'));
  }
  let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,timedOut=false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdoutBytes+=Buffer.byteLength(chunk);if(stdout.length<MAX_OUTPUT)stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);if(stderr.length<MAX_OUTPUT)stderr+=chunk;});
  const killTree=signal=>{
   if(POSIX_SIGNALS&&child.pid){
    try{process.kill(-child.pid,signal);return;}catch{/* group gone: fall back to the child */}
   }
   if(!POSIX_SIGNALS&&child.pid){
    // Windows 上没有进程组信号：taskkill /T 干掉整棵进程树，否则孙进程继续攥着管道。
    try{spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}).on('error',()=>{});return;}catch{/* fall back to the child */}
   }
   try{child.kill(signal);}catch{/* already gone */}
  };
  const timer=setTimeout(()=>{
   timedOut=true;
   killTree('SIGTERM');
   setTimeout(()=>killTree('SIGKILL'),2000).unref?.();
  },timeoutMs);
  child.on('error',error=>{
   clearTimeout(timer);
   reject(fail(`${executable} could not be started (${error.code??'unknown error'}: ${error.message}), so nothing was executed.`,'exec/unavailable'));
  });
  child.on('close',(code,signal)=>{
   clearTimeout(timer);
   resolve({
    exitCode:code,
    signal,
    timedOut,
    stdout:stdout.length>MAX_OUTPUT?stdout.slice(0,MAX_OUTPUT):stdout,
    stderr:stderr.length>MAX_OUTPUT?stderr.slice(0,MAX_OUTPUT):stderr,
    truncated:stdoutBytes>MAX_OUTPUT||stderrBytes>MAX_OUTPUT,
    durationMs:Date.now()-startedAt,
   });
  });
 });
}

// ---------------------------------------------------------------------------
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});

export const meta={
 name:'dev',
 title:'Dev Environments',
 version:'1.0.0',
 description:'Probe which terminal tools a phone PRoot rootfs really has, install python/java/go/rust/ssh/gcc and friends with a background apt-get, read the install log tail and run commands in a real bash or sh. Failures carry a code such as args/invalid, path/outside-roots, path/not-found, exec/unavailable or sandbox/denied.',
};

export const tools=[
 {
  name:'env_probe',
  description:'Use this before installing or running anything, to learn which terminal tools this PRoot or host really has instead of assuming: it only runs version probes and installs nothing, so it is safe in a read-only sandbox. Parameters: includeVersions (boolean, default true) records the first output line of each probe in versions; set it to false to skip that capture, which keeps the same shape with null values. It probes this fixed list of 21 commands: bash, sh, node, python3, pip3, git, tar, ssh, scp, java, javac, go, cargo, rustc, gcc, make, sqlite3, curl, wget, unzip, jq. Each probe is a spawnSync with shell:false and a 5 s timeout, sending --version, except sh and bash which are probed with -c "echo ok" because they have no portable --version form; PATH is extended with /opt/node/bin and the directory of the Node process running this server, so a node that is not in /usr/bin is still found, and a tool that rejects --version is retried once with its canonical flag (ssh -V, scp -V, java -version, javac -version, go version) only to capture a version string. Returns {platform, arch, sandboxMode: string|null, available: {name: boolean} for all 21 probes, missing: names that are not usable, versions: {name: first probe output line or null}}. A tool counts as available only when the OS really started it: a spawn error (not on PATH), a probe that hung 5 s, and the Windows App Execution Alias stub (exit 9009) are reported as false, while a tool that prints a usage message and exits non-zero is still reported as present. Use env_install to add what is missing, then env_probe again to confirm. Failures: "args/invalid" (includeVersions is not a boolean), "exec/unavailable" (process spawning itself does not work here, so no probe could run), "tool/internal".',
  inputSchema:object({
   includeVersions:{type:'boolean',description:'Capture the first output line of each probe in versions. Defaults to true; false keeps the same keys with null values and a smaller answer.'},
  },[]),
  run:guard(async(args,ctx)=>{
   const includeVersions=args.includeVersions===undefined||args.includeVersions===null
    ?true
    :optionalBoolean(args.includeVersions,'includeVersions');
   const records=probeAll({captureVersion:includeVersions});
   const available={};
   const missing=[];
   const versions={};
   for(const record of records){
    available[record.name]=record.available;
    versions[record.name]=record.available&&includeVersions?record.version:null;
    if(!record.available)missing.push(record.name);
   }
   // 全部探针都以非 ENOENT 的方式失败（EACCES/EPERM/EINVAL…）说明这台机器根本起不了
   // 子进程，那是环境坏了，不是「什么都没装」，必须如实报 exec/unavailable。
   const systemic=records.every(record=>!record.available&&record.spawnErrorCode&&record.spawnErrorCode!=='ENOENT'&&record.spawnErrorCode!=='ETIMEDOUT');
   if(systemic){
    const reasons=[...new Set(records.map(record=>record.reason))].join('; ');
    throw fail(`No probe could be started at all (${reasons}), so this host cannot spawn child processes from the tool server; nothing was installed or changed. Run env_probe again after fixing the tool server's execution environment.`,'exec/unavailable');
   }
   return {
    platform:process.platform,
    arch:process.arch,
    sandboxMode:typeof ctx.sandboxMode==='string'?ctx.sandboxMode:(isReadOnlySandbox(ctx)?'read-only':null),
    available,
    missing,
    versions,
   };
  }),
 },
 {
  name:'env_install',
  description:'Use this to add missing terminal toolchains to a phone PRoot rootfs with apt-get, which is the only practical way to get python3, java, go, rust, ssh, gcc, sqlite3, curl and friends onto this device because the APK cannot ship them all: the packages are written into the rootfs /usr, so they survive an app restart, and apt needs a working network connection. It runs in the background and returns immediately, so poll env_install_log with the logPath this call returns instead of waiting. Parameters: packages (array of 1 to 8 tool names from this whitelist, required) where python installs python3 python3-pip, ssh installs openssh-client, java installs default-jdk-headless, go installs golang-go, rust installs rustc cargo, build installs build-essential, sqlite installs sqlite3, net installs curl wget, unzip installs unzip, jq installs jq and node installs nodejs npm; dryRun (boolean, default false) returns the exact command without executing anything, which is the safe way to preview an install. The started command is nohup sh -c "apt-get update -y && apt-get install -y --no-install-recommends <packages>" > <logPath> 2>&1 & with DEBIAN_FRONTEND=noninteractive, detached and unref-ed so it keeps running after the tool call. Returns {started: true, packages: the apt package names handed to apt-get, logPath: /tmp/codex-go-env-<timestamp>-<pid>.log, command: the exact shell text, note}, and with dryRun {started:false, packages, logPath, command, note}. Failures: "args/invalid" (packages missing, not an array, empty, more than 8 items, or a name outside the whitelist; nothing is executed and apt never starts), "sandbox/denied" in a read-only session (even with dryRun, because such a session may not change the rootfs at all), "exec/unavailable" (sh could not be started, for example on a Windows host without sh, so apt never ran), "tool/internal".',
  inputSchema:object({
   packages:{
    type:'array',
    items:{type:'string',enum:['python','ssh','java','go','rust','build','sqlite','net','unzip','jq']},
    minItems:1,
    maxItems:8,
    description:'Whitelisted tool names to install: python, ssh, java, go, rust, build, sqlite, net, unzip, jq, node. Each maps to fixed apt packages; arbitrary apt package names are refused.',
   },
   dryRun:{type:'boolean',description:'Preview the command without executing anything. Defaults to false, which really starts apt-get in the background.'},
  },['packages']),
  run:guard(async(args,ctx)=>{
   // 顺序固定：参数校验 → 权限判定 → 执行（参数错不会被 sandbox/denied 掩盖）。
   const {aliases,aptPackages}=normalizePackages(args.packages);
   const dryRun=optionalBoolean(args.dryRun,'dryRun');
   requireWritableSandbox(ctx,'env_install','installs Debian packages with apt-get');
   const logPath=installLogPath();
   const command=installScript(aptPackages,logPath);
   if(dryRun){
    return {
     started:false,
     packages:aptPackages,
     logPath,
     command,
     note:`dryRun: nothing was executed, apt-get was not started and no log was written. Omit dryRun (or pass dryRun:false) to really install ${aliases.join(', ')}; the call returns at once and you then poll env_install_log with logPath.`,
    };
   }
   const started=await startInstall(command);
   return {
    started:true,
    packages:aptPackages,
    logPath,
    command,
    pid:started.pid,
    note:`apt-get update and apt-get install are now running in the background as a detached process (pid ${started.pid??'unknown'}) with output in ${logPath}; this call does not wait for them. Poll env_install_log with logPath every few seconds, then verify with env_probe. apt needs network access, root inside the PRoot, and enough free space; the packages land in the rootfs /usr and survive an app restart.`,
   };
  }),
 },
 {
  name:'env_install_log',
  description:'Use this to watch an apt install that env_install started in the background, and to read the real apt error when something fails, without blocking the conversation. Parameters: logPath (string, required) must be an exact install log path returned by env_install, matching /tmp/codex-go-env-<name>.log, so this tool cannot be pointed at any other file; lines (integer, 1 to 500, default 60) is how many trailing lines to return. Returns {logPath, exists: true, lines: the last <lines> log lines as a string array, done: boolean, exitHint: which heuristic signal fired and what it means}. done is only a heuristic: it is true when the tail contains an apt failure line starting with "E: ", or a "Setting up <package>" line, or the log file has not changed for 5 seconds, because apt does not write an exit status into the log; a long multi-package install can still be running when it reports true, so read the lines and poll again before concluding success, and treat an "E: " line as a real failure. Works in a read-only sandbox because it only reads. Failures: "path/outside-roots" (logPath is not a /tmp/codex-go-env-*.log path), "path/not-found" (no log file exists at that path yet, for example after a refused install), "args/invalid" (logPath missing or not a string, lines out of range), "tool/internal".',
  inputSchema:object({
   logPath:{type:'string',description:'Exact install log path returned by env_install; must match /tmp/codex-go-env-<name>.log.'},
   lines:{type:'integer',minimum:1,maximum:500,description:'Trailing lines to return. Defaults to 60; 500 is the ceiling.'},
  },['logPath']),
  run:guard(async args=>{
   const logPath=requireInstallLogPath(args.logPath);
   const limit=optionalInteger(args.lines,'lines',{min:1,max:LOG_MAX_LINES,fallback:LOG_DEFAULT_LINES});
   let tail;
   try{
    tail=await readLogTail(logPath);
   }catch(error){
    if(error.code==='ENOENT'||error.code==='ENOTDIR'){
     throw fail(`No install log exists at ${logPath}, so nothing has written it yet. Use the logPath that env_install returned (a refused or dryRun:true call never creates a log), then retry.`,'path/not-found');
    }
    throw error;
   }
   const reading=logReading(tail.text,tail,limit);
   return {
    logPath,
    exists:true,
    lines:reading.lines,
    done:reading.done,
    exitHint:reading.exitHint,
    bytes:reading.bytes,
   };
  }),
 },
 {
  name:'env_run',
  description:'Use this to run a real shell command when no dedicated tool fits, for example to invoke a toolchain that env_probe found, to chain a pipeline or to use shell redirection; the command is handed to bash -c (or sh -c) as one argument, never through a shell:true child process. Parameters: shell ("bash" or "sh", default "bash") is the preference; command (string, required, nonempty) is the shell text; cwd (string, default the first allowed root) must be a directory inside an allowed root; timeoutMs (integer, 1000 to 110000, default 30000) kills the process when it runs too long. The shell is resolved from /bin/bash, /usr/bin/bash, /usr/local/bin/bash and Git Bash on Windows, then from the same name resolved through PATH, then from the measured toolingStatus.execShell as a last resort (on a Windows host without bash that is cmd.exe, and the result names it honestly in shell/shellPath instead of pretending it was bash). PATH is extended with /opt/node/bin and the directory of the Node process running this server, so a node outside /usr/bin still works. Returns {shell, shellPath, cwd, exitCode: number|null, stdout, stderr, truncated: boolean (true when a stream passed 1048576 bytes and was cut), timedOut: boolean, durationMs}; a non-zero exit code or a timeout is a normal result with the captured output, not a tool failure. Failures: "args/invalid" (command empty or not a string, shell outside the enum, timeoutMs out of range), "path/outside-roots" (cwd escapes the allowed roots), "path/not-found" (cwd does not exist), "path/not-a-file" (cwd is not a directory), "exec/unavailable" (no usable shell could be started, so nothing was executed), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   shell:{type:'string',enum:['bash','sh'],description:'Preferred shell. Defaults to "bash"; the result reports the shell that actually ran.'},
   command:{type:'string',minLength:1,description:'Shell text executed as bash -c <command> (or sh -c). Must be nonempty.'},
   cwd:{type:'string',description:'Working directory inside an allowed root. Defaults to the first allowed root.'},
   timeoutMs:{type:'integer',minimum:1000,maximum:110000,description:'Kill the command after this many milliseconds, 1000 to 110000. Defaults to 30000.'},
  },['command']),
  run:guard(async(args,ctx)=>{
   requireWritableSandbox(ctx,'env_run','executes a shell command');
   const requested=args.shell===undefined||args.shell===null?'bash':requireString(args.shell,'shell').trim();
   if(!['bash','sh'].includes(requested)){
    throw fail(`shell must be "bash" or "sh" (got ${JSON.stringify(args.shell)}), so nothing was executed. Pick one of those two values and retry.`,'args/invalid');
   }
   const command=requireString(args.command,'command');
   const timeoutMs=optionalInteger(args.timeoutMs,'timeoutMs',{min:1000,max:MAX_RUN_TIMEOUT_MS,fallback:DEFAULT_RUN_TIMEOUT_MS});
   const cwd=args.cwd!==undefined&&args.cwd!==null?await resolveDirectory(ctx.roots,args.cwd,{label:'cwd'}):await resolveDirectory(ctx.roots,'.');
   const resolved=resolveShell(requested,ctx);
   const invocation=shellInvocation(resolved.path);
   const result=await runShell(resolved.path,[...invocation.args,command],cwd,timeoutMs);
   return {
    shell:invocation.name,
    shellPath:resolved.path,
    shellSource:resolved.how,
    cwd,
    timeoutMs,
    exitCode:result.exitCode,
    signal:result.signal,
    stdout:result.stdout,
    stderr:result.stderr,
    truncated:result.truncated,
    timedOut:result.timedOut,
    durationMs:result.durationMs,
   };
  }),
 },
];
