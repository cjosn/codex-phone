// workflow: persistent sequential workflows (shell + prompt steps).
// Definitions and real run records are owned by ../../workflows.mjs. Prompt steps are
// executed by the Codex Pocket bridge through POST /api/thread/create + /api/turn/send,
// and the answer text is collected from the bridge SSE stream.
//
// 权限边界：shell 步骤会真的执行命令，所以运行时是只读沙箱时必须立刻抛 sandbox/denied，
// 一个字节都不跑；prompt 步骤走 bridge 模型回合，不执行本机命令。
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,open,readFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {WorkflowStore} from '../../workflows.mjs';
import {bridgeEvents,bridgeRequest,resolveDirectory} from '../_shared.mjs';

const MAX_STEP_OUTPUT=1024*1024;
const DEFAULT_STEP_TIMEOUT_MS=120000;
const MIN_STEP_TIMEOUT_MS=1000;
const MAX_STEP_TIMEOUT_MS=3600000;
const MIN_WORKFLOW_STEPS=1;
const MAX_WORKFLOW_STEPS=50;
const MAX_NAME_LENGTH=120;
const READ_ONLY_MODES=new Set(['read-only','readonly','read_only','ro','r/o']);
const TRUTHY=new Set(['1','true','yes','on']);
let store=null,pendingStore=null;

// 统一错误：英文人类可读消息 + area/kebab-case 错误码（宿主会包进 {ok:false,error}）。
const fail=(message,code)=>Object.assign(new Error(message),{code});
const invalid=message=>fail(message,'args/invalid');

const requireId=value=>{
 if(typeof value!=='string'||!value.trim())throw invalid('id is required: pass the workflow id returned by workflow_create or workflow_list');
 return value.trim();
};

const optionalBoolean=(value,label)=>{
 if(value===undefined||value===null)return false;
 if(typeof value!=='boolean')throw invalid(`${label} must be a boolean (true or false)`);
 return value;
};

// ---------------------------------------------------------------------------
// 只读沙箱判定。宿主（mcp-server.mjs）从 ${CODEX_HOME}/config.toml 的 sandbox_mode 读取
// 同一份事实；这里按同一来源判断，另外也接受 ctx 或环境变量显式声明的模式。
// ---------------------------------------------------------------------------
async function readCodexSandboxMode(){
 const home=process.env.CODEX_HOME||path.join(homedir(),'.codex');
 try{
  const text=await readFile(path.join(home,'config.toml'),'utf8');
  const match=text.match(/^\s*sandbox_mode\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
  if(!match)return null;
  return (match[1]??match[2]??match[3]??'').trim()||null;
 }catch{return null;}
}

async function isReadOnlySandbox(ctx){
 const declared=[
  ctx?.sandboxMode,ctx?.sandbox,ctx?.permissionMode,
  process.env.CODEX_GO_SANDBOX_MODE,process.env.CODEX_GO_SANDBOX,process.env.DSH_SANDBOX_MODE,process.env.CODEX_SANDBOX_MODE,
 ].find(value=>typeof value==='string'&&value.trim());
 if(declared)return READ_ONLY_MODES.has(declared.trim().toLowerCase());
 if([process.env.CODEX_GO_READ_ONLY,process.env.DSH_READ_ONLY].some(value=>TRUTHY.has(String(value??'').toLowerCase())))return true;
 // Node 权限模型（--permission）：既不能写文件也不能起子进程时等同只读。
 const permission=process.permission;
 if(permission&&typeof permission.has==='function'){
  try{
   if(permission.has('fs.write')===false&&permission.has('child')===false)return true;
  }catch{/* 该作用域不受支持，交给 config.toml 判断 */}
 }
 const mode=await readCodexSandboxMode();
 return mode!==null&&READ_ONLY_MODES.has(mode.toLowerCase());
}

async function assertCommandExecutionAllowed(ctx,{tool}){
 if(await isReadOnlySandbox(ctx)){
  throw fail(`${tool} cannot run shell steps: the runtime sandbox is read-only (sandbox_mode="read-only"), so executing commands is not allowed. Nothing was executed and no run record was written. Use prompt-only steps, or ask the user to switch the sandbox to workspace-write.`,'sandbox/denied');
 }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
async function getStore(ctx){
 if(store)return store;
 if(!pendingStore){
  const value=new WorkflowStore(ctx.dataDir,{
   executeShell:(step,runtime)=>executeShell(step,ctx,runtime),
   executePrompt:(step,runtime)=>executePrompt(step,ctx,runtime),
  });
  pendingStore=value.load().then(loaded=>{store=loaded;return loaded;});
 }
 return pendingStore;
}

// Direct exec, no shell, output captured through file descriptors so it also works
// in confined runtimes where anonymous pipes are unavailable.
async function executeShell(step,ctx,runtime={}){
 const position=(runtime.step??0)+1;
 await assertCommandExecutionAllowed(ctx,{tool:`workflow_run step ${position} (shell)`});
 const cwd=await resolveDirectory(ctx.roots,step.cwd??'.').catch(error=>{
  if(error?.code)throw error;
  throw invalid(`Shell step ${position} cwd "${step.cwd}" is not a directory inside the allowed roots: ${error.message}`);
 });
 const timeoutMs=step.timeoutMs??DEFAULT_STEP_TIMEOUT_MS;
 await mkdir(ctx.dataDir,{recursive:true,mode:0o700});
 const id=randomUUID(),stdoutPath=path.join(ctx.dataDir,id+'.out'),stderrPath=path.join(ctx.dataDir,id+'.err');
 const out=await open(stdoutPath,'w'),err=await open(stderrPath,'w');
 try{
  return await new Promise((resolve,reject)=>{
   let timedOut=false;
   const child=spawn(step.argv[0],step.argv.slice(1),{cwd,shell:false,windowsHide:true,stdio:['ignore',out.fd,err.fd]});
   const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
   child.on('error',error=>{
    clearTimeout(timer);
    const missing=error?.code==='ENOENT';
    reject(fail(missing
     ?`Shell step ${position} could not start "${step.argv[0]}": the executable was not found (ENOENT). Use an absolute path or one of the interpreters reported by code_toolchains; nothing else was executed.`
     :`Shell step ${position} could not start "${step.argv[0]}": ${error.message}. Nothing else was executed.`,'workflow/invalid'));
   });
   child.on('close',async(code,signal)=>{
    clearTimeout(timer);
    try{
     const stdout=(await readFile(stdoutPath,'utf8')).slice(-MAX_STEP_OUTPUT);
     const stderr=(await readFile(stderrPath,'utf8')).slice(-MAX_STEP_OUTPUT);
     if(timedOut){
      reject(fail(`Shell step ${position} (${step.argv[0]}) was killed after the ${timeoutMs} ms timeout; partial stdout: ${stdout.slice(0,400)||'(empty)'}. Raise the step timeoutMs (maximum ${MAX_STEP_TIMEOUT_MS}) or fix the command.`,'workflow/timeout'));
      return;
     }
     if(code!==0){
      reject(fail(`Shell step ${position} (${step.argv.join(' ')}) exited with ${code??signal}: ${(stderr||stdout).slice(0,800)||'no output'}. Inspect argv/cwd, or run the command once through code_run_shell to debug.`,'workflow/failed'));
      return;
     }
     resolve({process:'exec',exitCode:code,stdout,stderr});
    }catch(error){
     reject(error?.code?error:fail(`Shell step ${position} finished but its captured output could not be read: ${error.message}.`,'tool/internal'));
    }
   });
  });
 }finally{
  await out.close();await err.close();
  await rm(stdoutPath,{force:true});await rm(stderrPath,{force:true});
 }
}

async function executePrompt(step,ctx){
 const bridge=ctx.bridge;
 if(!bridge){
  throw fail(`Workflow prompt steps need the running Codex Pocket bridge: the handshake file ${ctx.bridgeFile??'${CODEX_HOME}/codex-go-bridge.json'} was not found, so no model turn was started. Start the bridge (it writes the handshake with the API token) and re-run.`,'bridge/token-missing');
 }
 const timeoutMs=Math.max(1000,(ctx.timeoutMs??DEFAULT_STEP_TIMEOUT_MS)-1000);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  let threadId=step.threadId;
  if(!threadId){
   const created=await bridgeRequest(bridge,'thread/create',{},{timeoutMs});
   threadId=created?.threadId;
   if(!threadId)throw fail('The bridge did not return a threadId for the workflow prompt step; no model turn was started. Check that the bridge is healthy (admin ping).','bridge/error');
  }
  const stream=bridgeEvents(bridge,{threadId,signal:controller.signal})[Symbol.asyncIterator]();
  const sent=await bridgeRequest(bridge,'turn/send',{threadId,text:step.text},{timeoutMs});
  const turnId=sent?.turnId??null;
  let text='';
  while(true){
   const next=await stream.next();
   if(next.done)throw fail('The bridge event stream ended before the prompt turn completed, so no answer text can be reported. Re-run the workflow or inspect the bridge log.','bridge/error');
   const event=next.value;
   if(event.type==='text.delta'&&(!event.turnId||event.turnId===turnId))text+=event.text??'';
   if(event.type==='turn.end'&&(event.turnId===turnId||(turnId===null&&!event.turnId))){
    const status=event.status??'completed';
    if(status!=='completed'){
     throw fail(`Prompt turn ended with status "${status}"${event.error?.message?`: ${event.error.message}`:''}. The step produced no usable answer; re-run the workflow or check the model channel.`,'workflow/failed');
    }
    return {process:'bridge-turn',threadId,turnId,status,text};
   }
  }
 }catch(error){
  if(error?.name==='AbortError'){
   throw fail(`Workflow prompt step timed out after ${timeoutMs} ms while waiting for the model turn. Re-run with a shorter prompt or check the bridge/model channel.`,'bridge/timeout');
  }
  throw error;
 }finally{
  clearTimeout(timer);
  controller.abort();
 }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});

const idProperty={type:'string',description:'Workflow id (uuid) exactly as returned by workflow_create or listed by workflow_list.'};

const shellStepSchema={
 type:'object',
 additionalProperties:false,
 description:'A shell step: argv is exec\'d directly without a shell, needs approveShell:true on every run, and is refused with sandbox/denied in a read-only sandbox.',
 properties:{
  type:{type:'string',enum:['shell'],description:'Must be "shell" to mark this step as a command step.'},
  argv:{type:'array',items:{type:'string'},minItems:1,description:'Command and arguments, e.g. ["node","-e","console.log(1)"]. Executed with shell:false, so no pipes, globs or $VAR expansion; call a shell explicitly if you need them.'},
  cwd:{type:'string',description:'Working directory inside an allowed root; default "." (the first allowed root). Relative paths are resolved against the allowed roots.'},
  timeoutMs:{type:'integer',minimum:MIN_STEP_TIMEOUT_MS,maximum:MAX_STEP_TIMEOUT_MS,description:'Kill the command after this many milliseconds; minimum 1000, maximum 3600000, default 120000. A kill is reported as workflow/timeout.'},
 },
 required:['type','argv'],
};

const promptStepSchema={
 type:'object',
 additionalProperties:false,
 description:'A prompt step: sends text to a bridge-backed model turn and stores the answer text. Needs the bridge handshake; it does not execute local commands.',
 properties:{
  type:{type:'string',enum:['prompt'],description:'Must be "prompt" to mark this step as a model-turn step.'},
  text:{type:'string',description:'Prompt sent to the model for this step; must be nonempty. The assistant answer text is stored in the run record as text.'},
  threadId:{type:'string',description:'Optional existing bridge thread id to continue; omit to create a fresh thread for this step.'},
 },
 required:['type','text'],
};

export const meta={
 name:'workflow',
 title:'Workflows',
 version:'1.0.0',
 description:'Create, inspect, run and delete persistent sequential workflows with real shell and bridge-backed prompt steps.',
};

export const tools=[
 {
  name:'workflow_list',
  description:[
   'Use this to see which workflows already exist before creating or running one; it reads the local store and never starts anything.',
   'Returns {count,workflows:[{id,name,createdAt,steps}]}; every entry is a persisted definition with its ordered steps, so use workflow_get to see a full run history.',
   'This tool only reads files under the data directory, so it also works in a read-only sandbox. It takes no arguments and never talks to the network or the bridge.',
   'Failures: tool/internal when the workflow store file on disk is unreadable or corrupt (the error names the file; delete or repair it, nothing is overwritten silently).',
  ].join(' '),
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async(args,ctx)=>{
   const value=await getStore(ctx);
   const workflows=value.list();
   return {count:workflows.length,workflows};
  },
 },
 {
  name:'workflow_get',
  description:[
   'Use this to inspect one workflow definition together with its persisted run history: what the steps are and what really happened on each run.',
   'Parameters: id (required workflow uuid).',
   'Returns {workflow:{id,name,createdAt,steps},runCount,runs:[{id,workflowId,status,startedAt,finishedAt,error,steps:[{index,type,status,startedAt,finishedAt,stdout,stderr,text,threadId,turnId,process,error}]}]}; runs are newest first and capped at the last 100 runs in the store, status is running, completed, failed or interrupted (a process restart marks in-flight runs interrupted).',
   'Read-only, no side effects, works in a read-only sandbox. Failures: args/invalid (missing id), workflow/not-found (no workflow with that id; call workflow_list to get the current ids).',
  ].join(' '),
  inputSchema:object({id:idProperty},['id']),
  run:async(args,ctx)=>{
   const value=await getStore(ctx);
   const id=requireId(args.id);
   const workflow=value.get(id);
   const runs=value.runsFor(id);
   return {workflow,runCount:runs.length,runs};
  },
 },
 {
  name:'workflow_create',
  description:[
   'Use this to save a new sequential workflow: an ordered list of 1 to 50 steps that can later be run (and re-run) by id.',
   'Parameters: name (1 to 120 characters) and steps (array of 1 to 50 items).',
   'Each step is either {type:"shell",argv:[...],cwd?,timeoutMs?} or {type:"prompt",text,threadId?}. Shell steps are executed directly with shell:false, so argv must already contain the command and every argument; prompt steps need the bridge and store the model answer text.',
   'Returns {id,name,createdAt,steps} of the persisted definition; passing the same name twice is allowed (ids are uuids), so check workflow_list first if you want to avoid duplicates. Creating never executes a step.',
   'Failures: args/invalid (missing or non-string name, empty steps array, more than 50 steps, malformed step, shell step without argv, prompt step without text), workflow/invalid (the store rejected the definition, for example a timeoutMs outside 1000..3600000).',
   'Running shell steps afterwards requires approveShell:true on every workflow_run call.',
  ].join(' '),
  inputSchema:object({
   name:{type:'string',description:`Human readable workflow name, 1 to ${MAX_NAME_LENGTH} characters; trimmed before it is stored.`},
   steps:{
    type:'array',
    minItems:MIN_WORKFLOW_STEPS,
    maxItems:MAX_WORKFLOW_STEPS,
    description:'Ordered steps, 1 to 50 items; each item is a shell step {type:"shell",argv,cwd?,timeoutMs?} or a prompt step {type:"prompt",text,threadId?}.',
    items:{oneOf:[shellStepSchema,promptStepSchema]},
   },
  },['name','steps']),
  run:async(args,ctx)=>{
   const value=await getStore(ctx);
   return value.create(args);
  },
 },
 {
  name:'workflow_delete',
  description:[
   'Use this to remove a workflow definition together with its local run history; use it to clean up experiments you no longer need.',
   'Parameters: id (required workflow uuid).',
   'Returns {deleted:true,id}. Deletion is permanent: the definition and every run record of that workflow are dropped from the store in one step.',
   'Failures: args/invalid (missing id), workflow/not-found (no workflow with that id), workflow/busy (that workflow is running right now; wait for the run to finish). Deleting writes the store, so a read-only runtime or a denied write surfaces as tool/internal (or sandbox/denied) instead of pretending success.',
  ].join(' '),
  inputSchema:object({id:idProperty},['id']),
  run:async(args,ctx)=>{
   const value=await getStore(ctx);
   return value.delete(requireId(args.id));
  },
 },
 {
  name:'workflow_run',
  description:[
   'Use this to execute a stored workflow step by step and get the real results: shell steps run as real processes and prompt steps run real model turns.',
   'Parameters: id (required workflow uuid) and approveShell (boolean, default false, must be exactly true for shell steps to run).',
   'Returns the run record {id,workflowId,status,startedAt,finishedAt,error,steps:[{index,type,status,stdout,stderr,text,threadId,turnId,process,error}]}; status is completed when every step succeeded and failed otherwise, and each step keeps its real stdout, stderr, exit code or answer text. Runs are persisted, so workflow_get shows the same history later.',
   'Shell steps only execute when approveShell is exactly true on this call, so the user sees the command execution as an explicit decision; the first failing step stops the run. Prompt steps need the running bridge handshake (${CODEX_HOME}/codex-go-bridge.json) and consume one model turn per step.',
   'Sandbox: shell steps are refused with sandbox/denied when the runtime is read-only (sandbox_mode="read-only" in ${CODEX_HOME}/config.toml, or an equivalent declared mode) and nothing is executed; prompt-only workflows still work because they run no local command.',
   'Failures: args/invalid (missing id, approveShell not a boolean), workflow/not-found, workflow/busy (the same workflow is already running), workflow/approval-required (shell steps without approveShell:true), sandbox/denied, bridge/token-missing (prompt step without the bridge handshake), bridge/timeout, bridge/error, workflow/timeout (a shell step exceeded its timeoutMs), workflow/failed (a step failed; the failed run stays in the history, so workflow_get still shows which step broke).',
  ].join(' '),
  inputSchema:object({
   id:idProperty,
   approveShell:{type:'boolean',description:'Must be exactly true to let shell steps execute on this run; default false, which fails a workflow containing shell steps with workflow/approval-required before anything runs. Prompt-only workflows ignore it.'},
  },['id']),
  run:async(args,ctx)=>{
   const value=await getStore(ctx);
   const id=requireId(args.id);
   const approveShell=optionalBoolean(args.approveShell,'approveShell');
   const workflow=value.get(id);
   if(workflow.steps.some(step=>step.type==='shell'))await assertCommandExecutionAllowed(ctx,{tool:'workflow_run'});
   return value.run(id,{approveShell});
  },
 },
];
