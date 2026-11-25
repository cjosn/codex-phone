// subagent: 通过 bridge 把一个自包含子任务交给另一个 Codex 会话执行。
// bridge（server.mjs）实现 POST /api/subagent/run 与 POST /api/subagent/runs。
// 没有握手时这些工具会如实失败，不会伪造一个“子会话”。
import {bridgeRequest,optionalInteger,optionalString,requireString} from '../_shared.mjs';

const EFFORTS=['none','minimal','low','medium','high','xhigh'];
const DEFAULT_TIMEOUT_MS=600000;
const BRIDGE_FILE_HINT='${CODEX_HOME}/codex-go-bridge.json';

const fail=(message,code)=>Object.assign(new Error(message),{code});
const argsError=error=>fail(error?.message??'invalid arguments','args/invalid');
const needString=(value,label)=>{try{return requireString(value,label);}catch(error){throw argsError(error);}};
const maybeString=(value,label)=>{try{return optionalString(value,label);}catch(error){throw argsError(error);}};
const maybeInteger=(value,label,options)=>{try{return optionalInteger(value,label,options);}catch(error){throw argsError(error);}};

// 桥握手门禁：缺 baseUrl/token 直接 bridge/token-missing，不发送任何请求。
function needBridge(ctx,feature){
 const bridge=ctx?.bridge;
 const where=ctx?.bridgeFile??BRIDGE_FILE_HINT;
 if(!bridge||typeof bridge!=='object'||typeof bridge.baseUrl!=='string'||!bridge.baseUrl||typeof bridge.token!=='string'||!bridge.token){
  throw fail(`${feature} needs the running Codex Pocket bridge, but no usable handshake was found at ${where} (the file must contain baseUrl and token). Start the bridge, which rewrites the handshake file, then retry; no request was sent.`,'bridge/token-missing');
 }
 return bridge;
}

// 桥调用统一出口：网络/HTTP/超时失败折成 bridge/request-failed，保留上游 code 便于排查。
async function callBridge(bridge,endpoint,body,options={}){
 try{return await bridgeRequest(bridge,endpoint,body,options);}
 catch(error){
  const upstream=typeof error?.code==='string'&&error.code?error.code:'bridge/error';
  const wrapped=fail(`${endpoint} failed: ${error?.message??String(error)} (upstream code ${upstream}). The handshake is valid but the bridge rejected, timed out or could not be reached; check that the bridge is still running and retry, or shorten the task.`,'bridge/request-failed');
  wrapped.upstreamCode=upstream;
  wrapped.details=error?.details;
  throw wrapped;
 }
}

export const meta={
 name:'subagent',
 title:'Subagents',
 version:'1.1.0',
 description:'Run a self-contained sub-task in a separate Codex session through the bridge and inspect recent subagent runs.',
};

export const tools=[
 {
  name:'subagent_run',
  description:'Delegate a complete self-contained prompt to a fresh Codex session and wait for its final text. Include paths and constraints: the child has no conversation history. Optional name/role label the agent board; parentId and parentThreadId explicitly attach it to a parent agent/session (omit unknown parents). timeoutMs is clamped below the host deadline. Returns threadId, turnId, status, text and timeout metadata. Errors: args/invalid, bridge/token-missing, bridge/request-failed.',
  inputSchema:{type:'object',properties:{
   prompt:{type:'string',description:'Complete, self-contained task for the subagent; it does not see this conversation.'},
   cwd:{type:'string',description:'Working directory for the child session; defaults to the bridge working directory.'},
   model:{type:'string',description:'Optional model id for the child session.'},
   reasoningEffort:{type:'string',enum:['none','minimal','low','medium','high','xhigh'],description:'Optional reasoning effort for the child session.'},
   timeoutMs:{type:'integer',minimum:1000,maximum:1800000,description:'Bridge-side deadline in milliseconds, 1000-1800000; defaults to 600000. The host still caps one tool call at 120000 ms.'},
   title:{type:'string',description:'Short label shown in the subagent run list.'},
    name:{type:'string',maxLength:200,description:'Agent board display name.'},
    role:{type:'string',maxLength:200,description:'Agent role, such as researcher or reviewer.'},
    parentId:{type:'string',maxLength:200,description:'Explicit parent agent id, if known.'},
    parentThreadId:{type:'string',maxLength:200,description:'Explicit parent conversation thread id; omit unknown parents for global board.'},
  },required:['prompt'],additionalProperties:false},
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'subagent_run');
   const prompt=needString(args.prompt,'prompt');
   const cwd=maybeString(args.cwd,'cwd');
   const model=maybeString(args.model,'model');
   const title=maybeString(args.title,'title');
    const metadata={};
    for(const key of ['name','role','parentId','parentThreadId']){
     const value=maybeString(args[key],key);
     if(value&&value.length>200)throw fail(`${key} must be at most 200 characters`,'args/invalid');
     if(value)metadata[key]=value;
    }
   const reasoningEffort=maybeString(args.reasoningEffort,'reasoningEffort');
   if(reasoningEffort&&!EFFORTS.includes(reasoningEffort))throw fail(`reasoningEffort must be one of ${EFFORTS.join(', ')}; received ${JSON.stringify(reasoningEffort)}. Omit it to inherit the bridge default.`,'args/invalid');
   const requestedTimeout=maybeInteger(args.timeoutMs,'timeoutMs',{min:1000,max:1800000,fallback:DEFAULT_TIMEOUT_MS});
   // MCP 宿主会在 ctx.timeoutMs 时掐断整个工具调用，所以桥侧截止时间要略小一点，
   // 让 bridge 先报自己的超时，而不是被客户端直接 abort。
   const callBudget=Math.max(1000,(ctx.timeoutMs??120000)-1000);
   const timeoutMs=Math.min(requestedTimeout,callBudget);
   const body={prompt,...metadata,...(cwd?{cwd}:{}),...(model?{model}:{}),...(reasoningEffort?{reasoningEffort}:{}),...(title?{title}:{}),timeoutMs};
   const result=await callBridge(bridge,'subagent/run',body,{timeoutMs:callBudget});
   return {
    threadId:result.threadId??null,
    turnId:result.turnId??null,
    status:result.status??null,
    text:result.text??'',
    title:title??null,
    model:model??null,
    reasoningEffort:reasoningEffort??null,
    timeoutMs,
    clampedByHost:requestedTimeout>timeoutMs,
   };
  },
 },
 {
  name:'subagent_list',
  description:'List recent bridge subagent runs, newest first. Returns {count,runs} with ids, threadId, title, legacy status, timestamps and text preview. Requires a running bridge handshake. Errors: bridge/token-missing or bridge/request-failed.',
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'subagent_list');
   const result=await callBridge(bridge,'subagent/runs',{},{timeoutMs:Math.max(1000,(ctx.timeoutMs??120000)-1000)});
   const runs=Array.isArray(result.runs)?result.runs:[];
   return {count:runs.length,runs};
  },
 },
];
