// threads: 通过 bridge 的 /api/thread/* 与 /api/turn/* 端点查看和操作 Codex 会话。
// 这些工具只在 bridge 握手可用时工作。thread_send 故意“只发不等”：投递一条消息后立刻返回，
// 需要完整答复时用 subagent 包。
import {
 bridgeRequest,optionalInteger,optionalString,requireString,
} from '../_shared.mjs';

const MAX_ITEMS=200;
const MAX_ITEM_TEXT=20000;
const EFFORTS=['none','minimal','low','medium','high','xhigh'];
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

// 桥调用统一出口：404/“不存在”折成 thread/not-found，其余折成 bridge/request-failed，
// 并把上游 code 放进 upstreamCode 便于排查。
async function callBridge(bridge,endpoint,body,options={}){
 try{return await bridgeRequest(bridge,endpoint,body,options);}
 catch(error){
  const upstream=typeof error?.code==='string'&&error.code?error.code:'bridge/error';
  const detail=error?.message??String(error);
  const status=Number(error?.details?.status);
  const missing=status===404||/not[-_ ]?found|unknown thread|no such thread|missing thread/i.test(`${upstream} ${detail}`);
  const wrapped=missing
   ?fail(`${endpoint} failed: ${detail} (upstream code ${upstream}). That thread id does not exist or was archived; call thread_list to get a current id and retry.`,'thread/not-found')
   :fail(`${endpoint} failed: ${detail} (upstream code ${upstream}). The handshake is valid but the bridge rejected, timed out or could not be reached; check that the bridge is still running, then retry.`,'bridge/request-failed');
  wrapped.upstreamCode=upstream;
  wrapped.details=error?.details;
  throw wrapped;
 }
}

function itemText(item){
 const content=item?.content;
 if(Array.isArray(content)){
  return content
   .map(part=>typeof part==='string'?part:(typeof part?.text==='string'?part.text:''))
   .filter(Boolean)
   .join('\n');
 }
 if(typeof item?.text==='string')return item.text;
 if(typeof item?.message==='string')return item.message;
 return '';
}

function summarizeThread(thread){
 return {
  id:thread?.id??thread?.threadId??null,
  title:thread?.name??thread?.title??thread?.preview??thread?.id??null,
  preview:thread?.preview??null,
  cwd:thread?.cwd??null,
  createdAt:thread?.createdAt??null,
  updatedAt:thread?.updatedAt??null,
  status:thread?.status??null,
 };
}

function normalizeItem(item,index){
 const text=itemText(item);
 return {
  index,
  type:item?.type??null,
  role:item?.role??null,
  turnId:item?.turnId??null,
  text:text.length>MAX_ITEM_TEXT?text.slice(0,MAX_ITEM_TEXT):text,
  truncated:text.length>MAX_ITEM_TEXT,
 };
}

const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});

export const meta={
 name:'threads',
 title:'Threads',
 version:'2.1.0',
 description:'List, read, rename, archive and message Codex conversations through the authenticated bridge API.',
};

export const tools=[
 {
  name:'thread_list',
  description:'Find the conversation you want to inspect or message by listing what the bridge knows, newest first. cwd: optional working directory filter, only threads started there are returned. limit: 1-100, default 50; when more threads exist the result is cut and nextCursor is set. Returns {count (threads after the cwd filter), returned, nextCursor, threads: [{id, title, preview, cwd, createdAt, updatedAt, status}]} with threads that expose no id dropped. Fails with args/invalid for a limit outside 1-100, bridge/token-missing without a handshake, and bridge/request-failed when POST /api/thread/list fails.',
  inputSchema:object({
   cwd:{type:'string',description:'Only list threads whose working directory is this path.'},
   limit:{type:'integer',minimum:1,maximum:100,description:'Maximum number of threads returned, 1-100; defaults to 50.'},
  }),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'thread_list');
   const cwd=maybeString(args.cwd,'cwd');
   const limit=maybeInteger(args.limit,'limit',{min:1,max:100,fallback:50});
   const value=await callBridge(bridge,'thread/list',{...(cwd?{cwd}:{}),limit},{timeoutMs:30000});
   const threads=(Array.isArray(value?.threads)?value.threads:[]).map(summarizeThread).filter(thread=>thread.id);
   return {count:threads.length,returned:Math.min(threads.length,limit),nextCursor:value?.nextCursor??null,threads:threads.slice(0,limit)};
  },
 },
 {
  name:'thread_read',
  description:'Read one conversation (via POST /api/thread/resume) when you need the actual message history, for example to continue a discussion or quote an earlier answer. threadId: id from thread_list. cursor: pagination cursor from a previous read, omit for the first page. maxItems: 1-200, default 100; items beyond it are dropped and truncated becomes true. Returns {threadId, thread: {id, title, preview, cwd, timestamps, status}, itemCount (items the bridge sent), items: [{index, type, role, turnId, text, truncated}] where each text is capped at 20000 characters and empty non-function-call items are filtered out, truncated, nextCursor}. Fails with thread/not-found when the id is unknown or archived, args/invalid for a bad maxItems or missing threadId, bridge/token-missing without a handshake, bridge/request-failed for any other bridge failure.',
  inputSchema:object({
   threadId:{type:'string',description:'Thread id to read, as returned by thread_list.'},
   cursor:{type:'string',description:'Pagination cursor from an earlier thread_read; omit for the first page.'},
   maxItems:{type:'integer',minimum:1,maximum:200,description:'Maximum items returned, 1-200; defaults to 100.'},
  },['threadId']),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'thread_read');
   const threadId=needString(args.threadId,'threadId');
   const maxItems=maybeInteger(args.maxItems,'maxItems',{min:1,max:MAX_ITEMS,fallback:100});
   const cursor=maybeString(args.cursor,'cursor');
   const value=await callBridge(bridge,'thread/resume',{threadId,...(cursor?{cursor}:{})},{timeoutMs:60000});
   const rawItems=Array.isArray(value?.items)?value.items:[];
   const items=rawItems.slice(0,maxItems).map(normalizeItem);
   return {
    threadId:value?.threadId??threadId,
    thread:summarizeThread(value?.thread??{}),
    itemCount:rawItems.length,
    items:items.filter(item=>item.text||item.type==='function_call'),
    truncated:rawItems.length>maxItems,
    nextCursor:value?.nextCursor??null,
   };
  },
 },
 {
  name:'thread_rename',
  description:'Give a conversation a clearer title so the user can find it later; the new title is stored by Codex via POST /api/thread/rename. threadId: id from thread_list. title: the complete new title, nonempty, replaces the old one. Returns {renamed:true, threadId, title, result (raw bridge payload)}. Fails with thread/not-found for an unknown or archived id, args/invalid when threadId or title is missing or empty, bridge/token-missing without a handshake, bridge/request-failed for any other bridge failure.',
  inputSchema:object({
   threadId:{type:'string',description:'Thread id to rename.'},
   title:{type:'string',description:'New title, nonempty; it replaces the previous title.'},
  },['threadId','title']),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'thread_rename');
   const threadId=needString(args.threadId,'threadId');
   const title=needString(args.title,'title');
   const value=await callBridge(bridge,'thread/rename',{threadId,title},{timeoutMs:30000});
   return {renamed:true,threadId,title,result:value??{}};
  },
 },
 {
  name:'thread_delete',
  description:'Remove a conversation from the active bridge list. The Codex app-server exposes archive rather than hard delete, so this calls POST /api/thread/archive and says so instead of pretending the data is gone. threadId: id from thread_list. Returns {threadId, deleted:true, deletedVia:"thread/archive", archived:true, note (plain English reminder that the history file stays on disk)}. Fails with thread/not-found for an unknown id, args/invalid when threadId is missing, bridge/token-missing without a handshake, bridge/request-failed for any other bridge failure.',
  inputSchema:object({threadId:{type:'string',description:'Thread id to archive.'}},['threadId']),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'thread_delete');
   const threadId=needString(args.threadId,'threadId');
   await callBridge(bridge,'thread/archive',{threadId},{timeoutMs:30000});
   return {
    threadId,
    deleted:true,
    deletedVia:'thread/archive',
    archived:true,
    note:'Codex app-server has no hard-delete RPC, so the bridge archives the thread; it disappears from the active list but its history file stays on disk.',
   };
  },
 },
 {
  name:'thread_send',
  description:'Queue exactly one message for an existing conversation and return immediately with the accepted turn id; it does not wait for the answer, so it is the right tool for steering work in progress, not for getting a reply (use subagent_run when you need the final text). threadId: the conversation that receives the message. text: the message body, nonempty. model: optional model id for this turn only. reasoningEffort: optional one of none, minimal, low, medium, high, xhigh for this turn only. Returns {sent:true, threadId, turnId (or null), awaited:false, note}. Fails with thread/not-found for an unknown or archived id, args/invalid for missing text or a bad reasoningEffort, bridge/token-missing without a handshake, bridge/request-failed when POST /api/turn/send fails.',
  inputSchema:object({
   threadId:{type:'string',description:'Thread id that receives the message.'},
   text:{type:'string',description:'Message text to send, nonempty.'},
   model:{type:'string',description:'Optional model id used for this turn only.'},
   reasoningEffort:{type:'string',enum:['none','minimal','low','medium','high','xhigh'],description:'Optional reasoning effort for this turn only.'},
  },['threadId','text']),
  run:async(args,ctx)=>{
   const bridge=needBridge(ctx,'thread_send');
   const threadId=needString(args.threadId,'threadId');
   const text=needString(args.text,'text');
   const model=maybeString(args.model,'model');
   const reasoningEffort=maybeString(args.reasoningEffort,'reasoningEffort');
   if(reasoningEffort&&!EFFORTS.includes(reasoningEffort))throw fail(`reasoningEffort must be one of ${EFFORTS.join(', ')}; received ${JSON.stringify(reasoningEffort)}. Omit it to keep the thread default.`,'args/invalid');
   const value=await callBridge(bridge,'turn/send',{
    threadId,
    text,
    ...(model?{model}:{}),
    ...(reasoningEffort?{reasoningEffort}:{}),
   },{timeoutMs:60000});
   return {
    sent:true,
    threadId:value?.threadId??threadId,
    turnId:value?.turnId??null,
    awaited:false,
    note:'The bridge accepted the turn; this tool does not wait for the answer. Subscribe to /api/events or use subagent_run to collect a reply.',
   };
  },
 },
];
