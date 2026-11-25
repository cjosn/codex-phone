// code: run Python, Node.js and shell code for real through child processes.
// 解释器发现是真实探测（`--version`），缺失就如实报错而不是假装执行。除了
// code_run_shell 故意用 `bash -c` 之外，其余都是一次性 exec（shell:false）。
// 输出截断到 1 MiB，默认 60 s 超时；这两件事都写在返回结构里
// （{exitCode,stdout,stderr,truncated,timedOut}）。脚本非零退出是“结果”，不是工具失败。
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {optionalInteger,resolveDirectory,resolvePath} from '../_shared.mjs';

const MAX_OUTPUT=1024*1024;
const DEFAULT_TIMEOUT_MS=60000;
const MAX_TIMEOUT_MS=600000;
const PROBE_TIMEOUT_MS=15000;

const PROBES={
 python:{label:'Python 3',candidates:[['python3'],['python']],versionArgs:['--version'],extension:'py'},
 node:{label:'Node.js',candidates:[['node'],[process.execPath]],versionArgs:['--version'],extension:'mjs'},
 bash:{label:'Bash',candidates:[['bash'],['sh']],versionArgs:['--version'],extension:'sh'},
 gcc:{label:'GCC',candidates:[['gcc'],['cc']],versionArgs:['--version'],extension:'c'},
 go:{label:'Go',candidates:[['go']],versionArgs:['version'],extension:'go'},
 rustc:{label:'Rust',candidates:[['rustc']],versionArgs:['--version'],extension:'rs'},
};

const detections=new Map();

// ---------------------------------------------------------------------------
// 统一失败约定：run() 只返回可 JSON 序列化的数据（宿主会包成 {ok:true,data:V}），
// 失败一律 throw Error + code。_shared.mjs 抛的是旧的 toolpack/* 码，这里映射成本组
// 的统一码，消息原样保留。
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
 if(/^Not a directory: /.test(message))return fail(`${message}. This tool needs a directory inside an allowed root; pass a directory path instead.`,'path/not-a-file');
 if(/^Not a regular file: /.test(message))return fail(`${message}. This tool needs a regular file; directories and devices are rejected.`,'path/not-a-file');
 if(/outside the allowed roots/i.test(message))return fail(message,'path/outside-roots');
 if(/must be an integer between|must be a nonempty string|must be a boolean|must be a nonempty string array|must be one of/i.test(message))return fail(`${message}. Read the tool inputSchema for the accepted type, range and enum values, then retry.`,'args/invalid');
 if(/does not exist/i.test(message))return fail(message,'path/not-found');
 if(/ENOENT|not found on PATH|spawn /i.test(`${error?.code??''} ${message}`))return fail(`${message}. The interpreter or command is missing or not on PATH, so nothing was executed; call code_toolchains to see what this host has.`,'exec/unavailable');
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
// sandbox.type）或环境变量里声明只读；任一命中即拒绝启动子进程。
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

// 执行代码会写临时文件、跑任意进程，只读沙箱下必须 fail closed。
function requireExec(ctx,tool){
 if(!isReadOnlySandbox(ctx))return;
 throw fail(`${tool} executes code in a child process, but this session runs in a read-only sandbox, so nothing was executed and no temporary script was written. Ask the user to switch the sandbox to workspace-write or danger-full-access and retry. code_toolchains still works because it only runs --version probes.`,'sandbox/denied');
}

function truncateOutput(text){return text.length>MAX_OUTPUT?text.slice(0,MAX_OUTPUT):text;}

// Real probe: spawn the candidate and keep the first version line. ENOENT means the
// binary genuinely is not on PATH; a non-zero exit (for example the Windows Store
// "python3" stub, which exits 9009) means the candidate exists but is unusable, so it
// is NOT reported as available.
async function detect(name){
 if(detections.has(name))return detections.get(name);
 const probe=PROBES[name];
 const tried=[];
 let found=null;
 for(const [command] of probe.candidates){
  const argv=[command,...probe.versionArgs];
  try{
   const run=await runCode(argv,{timeoutMs:PROBE_TIMEOUT_MS,maxBytes:64*1024});
   const version=((run.stdout||'')+(run.stderr||''))
    .split(/\r?\n/)
    .map(line=>line.trim())
    .filter(Boolean)[0]??null;
   if(run.exitCode===0&&found===null){
    found={name,label:probe.label,available:true,command,version,exitCode:run.exitCode,versionArgs:probe.versionArgs};
    tried.push({command,exitCode:0,version,error:null});
   }else{
    const detail=((run.stderr||run.stdout||'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean)[0]??'').slice(0,200);
    tried.push({command,exitCode:run.exitCode,version:null,error:`exited with ${run.exitCode??run.signal}${detail?`: ${detail}`:''}`});
   }
  }catch(error){
   const reason=error.code==='ENOENT'?'not found on PATH':error.message;
   tried.push({command,exitCode:null,version:null,error:reason});
  }
 }
 const detection=found??{name,label:probe.label,available:false,command:null,version:null,tried};
 if(!detection.available)detection.tried=tried;
 detections.set(name,detection);
 return detection;
}

function requireToolchain(detection){
 if(detection.available)return detection;
 const tried=(detection.tried??[]).map(entry=>`${entry.command} (${entry.error})`).join(', ');
 throw fail(`${detection.label} is not installed on this host: ${tried||'no candidate was found'}. Nothing was executed. Run code_toolchains to see which interpreters exist, or install ${detection.label}.`,'exec/unavailable');
}

// Bounded child-process runner. Unlike _shared.runProcess this keeps partial output
// and returns `timedOut:true` instead of throwing, because a script that ran too long
// is a script result and its captured output is still useful.
function runCode(argv,{cwd,timeoutMs,maxBytes=MAX_OUTPUT,env}={}){
 return new Promise((resolve,reject)=>{
  let child;
  try{
   child=spawn(argv[0],argv.slice(1),{
    cwd,
    shell:false,
    windowsHide:true,
    stdio:['ignore','pipe','pipe'],
    env:env??process.env,
   });
  }catch(error){return reject(error);}
  let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,timedOut=false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdoutBytes+=Buffer.byteLength(chunk);if(stdout.length<maxBytes)stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);if(stderr.length<maxBytes)stderr+=chunk;});
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',(code,signal)=>{
   clearTimeout(timer);
   resolve({
    argv,
    cwd:cwd??process.cwd(),
    exitCode:code,
    signal,
    timedOut,
    stdout:truncateOutput(stdout),
    stderr:truncateOutput(stderr),
    stdoutBytes,
    stderrBytes,
    truncated:stdoutBytes>maxBytes||stderrBytes>maxBytes,
   });
  });
 });
}

function timeoutOf(args){
 return optionalInteger(args.timeoutMs,'timeoutMs',{min:1000,max:MAX_TIMEOUT_MS,fallback:DEFAULT_TIMEOUT_MS});
}

function stringArguments(value,label){
 if(value===undefined||value===null)return [];
 if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw fail(`${label} must be a string array: pass each command line argument as its own string, without shell quoting, then retry.`,'args/invalid');
 return value;
}

// Write the snippet to a private temp file so multi-line code needs no quoting games,
// run it, and always remove the file afterwards.
async function runInline(ctx,toolchain,code,{timeoutMs,args,env}={}){
 const extension=PROBES[toolchain.name].extension;
 await mkdir(ctx.dataDir,{recursive:true,mode:0o700});
 const script=path.join(ctx.dataDir,`code-${randomUUID()}.${extension}`);
 await writeFile(script,code,{mode:0o600});
 try{
  const result=await runCode([toolchain.command,script,...stringArguments(args,'args')],{
   cwd:await resolveDirectory(ctx.roots,'.'),
   timeoutMs,
   env,
  });
  return {...result,script};
 }finally{
  await rm(script,{force:true}).catch(()=>{});
 }
}

async function runFile(ctx,args,toolchain,{env}={}){
 const target=await resolvePath(ctx.roots,args.path);
 const timeoutMs=timeoutOf(args);
 const result=await runCode([toolchain.command,target,...stringArguments(args.args,'args')],{
  cwd:args.cwd!==undefined?await resolveDirectory(ctx.roots,args.cwd):path.dirname(target),
  timeoutMs,
  env,
 });
 return {...result,script:target};
}

function summary(result,extra){
 return {
  interpreter:extra.interpreter,
  command:[result.argv[0],...result.argv.slice(1).map(item=>item.length>200?item.slice(0,200)+'...':item)].slice(0,3),
  cwd:result.cwd,
  timeoutMs:extra.timeoutMs,
  exitCode:result.exitCode,
  signal:result.signal,
  timedOut:result.timedOut,
  stdout:result.stdout,
  stderr:result.stderr,
  stdoutBytes:result.stdoutBytes,
  stderrBytes:result.stderrBytes,
  truncated:result.truncated,
  ...(result.script?{script:result.script}:{}),
 };
}

const PYTHON_ENV=()=>({...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'});
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const executionProperties=()=>({
 timeoutMs:{type:'integer',minimum:1000,maximum:600000,description:'Kill the process after this many milliseconds, 1000 to 600000. Defaults to 60000; a run that hits the limit returns timedOut:true with the output captured so far.'},
 args:{type:'array',items:{type:'string'},description:'Extra command line arguments appended after the script path, one string per argument. Defaults to no arguments.'},
});
const RESULT_DOC='Returns {interpreter: {name, label, command, version}, command: the argv actually spawned (arguments longer than 200 characters are shortened with ...), cwd, timeoutMs, exitCode: number|null, signal: string|null, timedOut: boolean, stdout, stderr, stdoutBytes, stderrBytes, truncated: boolean (true when output passed 1048576 bytes and was cut)}. A non-zero exit code or a timeout is a normal result, not a tool failure.';

export const meta={
 name:'code',
 title:'Code execution',
 version:'2.0.0',
 description:'Run Python 3, Node.js and shell snippets or files for real with interpreter probing, a 60 s default timeout, a 1 MiB output cap and honest toolchain detection. Failures carry a code such as args/invalid, path/outside-roots, path/not-found, path/not-a-file, exec/unavailable, sandbox/denied or tool/internal.',
};

export const tools=[
 {
  name:'code_run_python',
  description:'Use this when you need to compute something, test a Python snippet or call a Python library that is not reachable from the other tools; the snippet runs in a real Python 3 child process. Parameters: code (string, required) is the Python source, written to a private temp file and removed afterwards; timeoutMs (integer, 1000 to 600000, default 60000) kills the process when it runs too long; args (array of strings, default empty) is appended to sys.argv. The working directory is the first allowed root and PYTHONIOENCODING/PYTHONUTF8 force UTF-8. ' + RESULT_DOC + ' Failures: "args/invalid" (code empty or not a string, bad args or timeoutMs), "exec/unavailable" (Python 3 is not installed, so nothing was executed; call code_toolchains), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   code:{type:'string',description:'Python source to execute. Must be nonempty; multi-line code is fine because it runs from a temp file, not a command line string.'},
   ...executionProperties(),
  },['code']),
  run:guard(async(args,ctx)=>{
   requireExec(ctx,'code_run_python');
   // 先校验参数再探测解释器，参数错误不该被 "没有 Python" 掩盖。
   const code=typeof args.code==='string'?args.code:'';
   if(!code.trim())throw fail('code must be a nonempty string: pass the Python source in code, or use code_run_python_file to run a file inside the allowed roots.','args/invalid');
   const toolchain=requireToolchain(await detect('python'));
   const result=await runInline(ctx,toolchain,code,{timeoutMs:timeoutOf(args),args:args.args,env:PYTHON_ENV()});
   return summary(result,{interpreter:toolchain,timeoutMs:timeoutOf(args)});
  }),
 },
 {
  name:'code_run_python_file',
  description:'Use this to run an existing Python file inside the allowed roots, for example a script from the repository under test, and get its real output. Parameters: path (string, required) is the Python file inside an allowed root; cwd (string, optional) is the working directory inside an allowed root and defaults to the script directory; timeoutMs (integer, 1000 to 600000, default 60000); args (array of strings, default empty) is appended to sys.argv. The file is executed as-is, so its own imports and permissions must already be correct. ' + RESULT_DOC + ' Failures: "args/invalid", "path/outside-roots", "path/not-found" (script or cwd missing), "path/not-a-file" (cwd is not a directory), "exec/unavailable" (Python 3 is not installed), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   path:{type:'string',description:'Python file inside an allowed root; must stay inside the allowed roots.'},
   cwd:{type:'string',description:'Working directory inside an allowed root. Defaults to the directory that contains the script.'},
   ...executionProperties(),
  },['path']),
  run:guard(async(args,ctx)=>{
   requireExec(ctx,'code_run_python_file');
   const toolchain=requireToolchain(await detect('python'));
   const result=await runFile(ctx,args,toolchain,{env:PYTHON_ENV()});
   return summary(result,{interpreter:toolchain,timeoutMs:timeoutOf(args)});
  }),
 },
 {
  name:'code_run_node',
  description:'Use this to compute something in JavaScript, exercise a Node.js snippet or check how Node handles a value without touching the project files. Parameters: code (string, required) is the JavaScript source, written to a temp .mjs file (ES module syntax works) and removed afterwards; timeoutMs (integer, 1000 to 600000, default 60000); args (array of strings, default empty) is appended to process.argv. Node is probed through PATH first and falls back to the interpreter running this MCP server. ' + RESULT_DOC + ' Failures: "args/invalid" (code empty or not a string, bad args or timeoutMs), "exec/unavailable" (Node.js was not found, so nothing was executed), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   code:{type:'string',description:'JavaScript source to execute. Must be nonempty; ES module syntax is supported because the snippet runs as a .mjs file.'},
   ...executionProperties(),
  },['code']),
  run:guard(async(args,ctx)=>{
   requireExec(ctx,'code_run_node');
   // 先校验参数再探测解释器，参数错误不该被 "没有 Node" 掩盖。
   const code=typeof args.code==='string'?args.code:'';
   if(!code.trim())throw fail('code must be a nonempty string: pass the JavaScript source in code, or use code_run_node_file to run a file inside the allowed roots.','args/invalid');
   const toolchain=requireToolchain(await detect('node'));
   const result=await runInline(ctx,toolchain,code,{timeoutMs:timeoutOf(args),args:args.args});
   return summary(result,{interpreter:toolchain,timeoutMs:timeoutOf(args)});
  }),
 },
 {
  name:'code_run_node_file',
  description:'Use this to execute an existing JavaScript or ES module file inside the allowed roots with Node.js and capture its real exit code and output. Parameters: path (string, required) is the JavaScript file inside an allowed root; cwd (string, optional) is the working directory inside an allowed root and defaults to the script directory; timeoutMs (integer, 1000 to 600000, default 60000); args (array of strings, default empty) is appended to process.argv. ' + RESULT_DOC + ' Failures: "args/invalid", "path/outside-roots", "path/not-found" (script or cwd missing), "path/not-a-file" (cwd is not a directory), "exec/unavailable" (Node.js was not found), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   path:{type:'string',description:'JavaScript file inside an allowed root; must stay inside the allowed roots.'},
   cwd:{type:'string',description:'Working directory inside an allowed root. Defaults to the directory that contains the script.'},
   ...executionProperties(),
  },['path']),
  run:guard(async(args,ctx)=>{
   requireExec(ctx,'code_run_node_file');
   const toolchain=requireToolchain(await detect('node'));
   const result=await runFile(ctx,args,toolchain);
   return summary(result,{interpreter:toolchain,timeoutMs:timeoutOf(args)});
  }),
 },
 {
  name:'code_run_shell',
  description:'Use this to run a short shell pipeline when no dedicated tool fits, for example to chain a command and read its output; the script is passed to bash -c (or sh -c) as one argument, never through a shell:true child process. Parameters: script (string, required) is the shell text; cwd (string, optional) is the working directory inside an allowed root and defaults to the first allowed root; timeoutMs (integer, 1000 to 600000, default 60000). ' + RESULT_DOC + ' The shell inherits the environment of this MCP server, so no extra variables are injected. Failures: "args/invalid" (script empty or not a string, bad cwd or timeoutMs), "path/outside-roots", "path/not-found", "path/not-a-file" (cwd is not a directory), "exec/unavailable" (Bash is not installed, so nothing was executed), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   script:{type:'string',description:'Shell script text, executed as bash -c <script> (or sh -c when bash is missing). Must be nonempty.'},
   cwd:{type:'string',description:'Working directory inside an allowed root. Defaults to the first allowed root.'},
   timeoutMs:{type:'integer',minimum:1000,maximum:600000,description:'Kill the process after this many milliseconds, 1000 to 600000. Defaults to 60000.'},
  },['script']),
  run:guard(async(args,ctx)=>{
   requireExec(ctx,'code_run_shell');
   const script=typeof args.script==='string'?args.script:'';
   if(!script.trim())throw fail('script must be a nonempty string: pass the shell text in script, then retry.','args/invalid');
   const toolchain=requireToolchain(await detect('bash'));
   const timeoutMs=timeoutOf(args);
   const cwd=args.cwd!==undefined?await resolveDirectory(ctx.roots,args.cwd):await resolveDirectory(ctx.roots,'.');
   const result=await runCode([toolchain.command,'-c',script],{cwd,timeoutMs});
   return summary(result,{interpreter:toolchain,timeoutMs});
  }),
 },
 {
  name:'code_toolchains',
  description:'Use this before running code to learn which interpreters this host really has, instead of assuming one exists. Takes no parameters. Probes python3 (fallback python), node, bash (fallback sh), gcc (fallback cc), go and rustc by spawning `<command> --version` with a 15 s timeout, and accepts a candidate only when it exits 0. Returns {platform, arch, checked: ["python","node","bash","gcc","go","rustc"], available: names that responded, missing: names that did not, toolchains: [{name, label, available: boolean, command: string|null, version: first version line|null, tried: [{command, exitCode, version, error}] when unavailable}]}. It only runs version probes, so it is allowed in a read-only sandbox; a probe that times out only marks the toolchain unavailable. Failures: "exec/unavailable" when the probes cannot be started at all, "tool/internal" for anything unexpected.',
  inputSchema:object({}),
  run:guard(async()=>{
   const names=Object.keys(PROBES);
   const toolchains=[];
   for(const name of names)toolchains.push(await detect(name));
   return {
    platform:process.platform,
    arch:process.arch,
    checked:names,
    available:toolchains.filter(entry=>entry.available).map(entry=>entry.name),
    missing:toolchains.filter(entry=>!entry.available).map(entry=>entry.name),
    toolchains,
   };
  }),
 },
];
