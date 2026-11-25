// memory: 供后续 AI 会话复用的持久笔记，以原子 JSON 落盘到 ctx.dataDir。
// 约定：run() 只返回可 JSON 序列化的数据（宿主负责封装成结构化结果），失败一律
// throw 带 code 的 Error；注释中文，面向模型的文案英文。
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES=500;   // 全库条数上限，超出后丢弃最旧的一条
const MAX_TEXT=4000;     // 单条笔记长度上限（按 UTF-16 码元计）
const MAX_TAGS=20;       // 单条笔记标签数量上限
const FILE_NAME='toolpack-memory.json';

// 进程内写队列：同一 MCP 进程里的并发写按到达顺序串行执行，避免丢写。
let chain=Promise.resolve();

// 统一错误：英文消息说明“哪一步失败 + 下一步怎么办”，code 供上层分流。
const fail=(message,code)=>Object.assign(Error(message),{code});
// 只读沙箱 / 无权限的 errno 集合，统一映射成 sandbox/denied。
const DENIED_CODES=new Set(['EACCES','EPERM','EROFS']);
const fileFor=ctx=>path.join(ctx.dataDir,FILE_NAME);

// ---------------------------------------------------------------------------
// 参数校验：失败统一 args/invalid，消息里写明字段名与合法取值范围。
// ---------------------------------------------------------------------------
function needString(value,label){
 if(typeof value!=='string'||!value.trim()){
  const got=value===undefined||value===null?'missing':`a ${typeof value}`;
  throw fail(`${label} must be a nonempty string but was ${got}; pass a nonempty string, then retry`,'args/invalid');
 }
 return value;
}

function needTags(value,label='tags'){
 if(value===undefined||value===null)return [];
 if(!Array.isArray(value)||value.some(item=>typeof item!=='string')){
  throw fail(`${label} must be an array of strings; pass keyword strings or omit the field, then retry`,'args/invalid');
 }
 const tags=[...new Set(value.map(tag=>tag.trim()).filter(Boolean))];
 if(tags.length>MAX_TAGS){
  throw fail(`${label} has ${tags.length} unique keywords but the limit is ${MAX_TAGS}; send at most ${MAX_TAGS} keywords, then retry`,'args/invalid');
 }
 return tags;
}

function needInteger(value,label,{min,max,fallback}){
 if(value===undefined||value===null)return fallback;
 if(!Number.isSafeInteger(value)||value<min||value>max){
  throw fail(`${label} must be an integer between ${min} and ${max} but was ${JSON.stringify(value)}; retry inside that range or omit it to use the default ${fallback}`,'args/invalid');
 }
 return value;
}

function maybeString(value,label){
 if(value===undefined||value===null)return undefined;
 if(typeof value==='string'&&!value.trim())return undefined;
 return needString(value,label);
}

// ---------------------------------------------------------------------------
// 存储读写：原子写（临时文件 + rename），读失败与写失败分别给出可执行的下一步。
// ---------------------------------------------------------------------------
async function readStore(ctx){
 const target=fileFor(ctx);
 let raw;
 try{raw=await readFile(target,'utf8');}
 catch(error){
  if(error.code==='ENOENT')return {entries:[]};
  if(DENIED_CODES.has(error.code)){
   throw fail(`Cannot read the memory store ${target}: the filesystem or sandbox denied access. Grant read access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  throw fail(`Reading the memory store ${target} failed (${error.code??'unknown error'}); no note was changed. Retry once, then check the data directory permissions`,'state/corrupt');
 }
 let value;
 try{value=JSON.parse(raw);}
 catch(error){
  throw fail(`The memory store ${target} is not valid JSON (${error.message}); it was left untouched so no notes were lost. Repair or delete that file, then retry`,'state/corrupt');
 }
 const entries=Array.isArray(value?.entries)?value.entries:Array.isArray(value)?value:[];
 return {entries:entries.filter(entry=>entry&&typeof entry.id==='string'&&typeof entry.text==='string')};
}

async function writeStore(ctx,store){
 const target=fileFor(ctx);
 try{
  await mkdir(ctx.dataDir,{recursive:true,mode:0o700});
  const temporary=`${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary,JSON.stringify({version:1,updatedAt:Date.now(),entries:store.entries},null,2)+'\n',{mode:0o600});
  await rename(temporary,target);
 }catch(error){
  if(DENIED_CODES.has(error.code)){
   throw fail(`Cannot write the memory store ${target}: the filesystem or sandbox denied the write. Grant write access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  throw fail(`Writing the memory store ${target} failed (${error.code??'unknown error'}: ${error.message}); the previous notes are intact. Retry once, then check free disk space and directory ownership`,'store/write-failed');
 }
}

// 读-改-写整体串行化：两次并发调用不会互相覆盖。
function mutate(ctx,apply){
 const next=chain.then(async()=>{
  const store=await readStore(ctx);
  const result=await apply(store);
  await writeStore(ctx,store);
  return result;
 });
 chain=next.then(()=>undefined,()=>undefined);
 return next;
}

// ---------------------------------------------------------------------------
// 检索打分
// ---------------------------------------------------------------------------
// 查询词：小写化后按非字母数字切分，保留长度 > 1 的 token；切不出 token 时用整串。
function termsOf(query){
 const lower=query.toLowerCase().trim();
 const tokens=lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(token=>token.length>1);
 return [...new Set(tokens.length?tokens:[lower])];
}

function occurrences(haystack,needle){
 if(!needle)return 0;
 let count=0,index=0;
 while((index=haystack.indexOf(needle,index))>=0){count++;index+=needle.length;}
 return count;
}

function scoreEntry(entry,terms,phrase){
 const text=entry.text.toLowerCase();
 const tags=(entry.tags??[]).join(' ').toLowerCase();
 let score=0;
 for(const term of terms){
  score+=occurrences(text,term);
  score+=occurrences(tags,term)*3;
 }
 if(phrase&&text.includes(phrase))score+=5;
 return score;
}

export const meta={
 name:'memory',
 title:'Memory',
 version:'2.0.0',
 description:'Durable notes that survive MCP restarts: add, keyword-search, list and forget. State lives in <dataDir>/toolpack-memory.json.',
};

export const tools=[
 {
  name:'memory_add',
  description:[
   'Use this when the user states a durable fact, decision or preference that a later session must recall; do not use it for transient scratch text.',
   'text (string, required, 1-4000 characters) is the note body, stored verbatim but rejected when it is empty after trimming.',
   'tags (string array, optional, default []) are recall keywords; entries are trimmed, de-duplicated, empty strings are dropped, and at most 20 unique keywords are accepted.',
   'Overwrite policy: an identical note text (exact, case-sensitive match) is never duplicated; the existing note keeps its id, its tags are unioned with the supplied tags (capped at 20) and its updatedAt is refreshed, reported as created:false.',
   'Capacity: the store keeps at most 500 notes; adding one more drops the oldest note first and reports the removed count as droppedOldest.',
   'Returns {created, entry:{id,text,tags,createdAt,updatedAt}, count, droppedOldest}, where count is the number of stored notes after the write and timestamps are epoch milliseconds.',
   'Persistence: written atomically to <dataDir>/toolpack-memory.json with 0600 permissions. Writes are serialized inside one MCP process, so concurrent memory_add calls do not lose notes; a second process writing the same file is last-write-wins.',
   'Failures: args/invalid (missing or over-long text, tags not a string array, more than 20 tags), state/corrupt (the store file is not valid JSON and was left untouched), store/write-failed, sandbox/denied (read-only sandbox or missing permission).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   text:{type:'string',minLength:1,maxLength:MAX_TEXT,description:'Note body, 1-4000 characters. Must be nonempty after trimming; identical text merges into the existing note instead of creating a second one.'},
   tags:{type:'array',items:{type:'string'},maxItems:MAX_TAGS,description:'Recall keywords, at most 20 unique non-empty strings. Defaults to []; duplicate and blank entries are ignored, and more than 20 unique keywords is rejected.'},
  },required:['text'],additionalProperties:false},
  run:async(args={},ctx)=>{
   const text=needString(args.text,'text');
   if(text.length>MAX_TEXT){
    throw fail(`text is ${text.length} characters but the limit is ${MAX_TEXT}; split it into several notes or shorten it, then retry`,'args/invalid');
   }
   const tags=needTags(args.tags);
   return mutate(ctx,store=>{
    const existing=store.entries.find(entry=>entry.text===text);
    if(existing){
     existing.tags=[...new Set([...(existing.tags??[]),...tags])].slice(0,MAX_TAGS);
     existing.updatedAt=Date.now();
     return {created:false,entry:existing,count:store.entries.length,droppedOldest:0};
    }
    const entry={id:randomUUID(),text,tags,createdAt:Date.now(),updatedAt:Date.now()};
    store.entries.push(entry);
    let dropped=0;
    while(store.entries.length>MAX_ENTRIES){store.entries.shift();dropped++;}
    return {created:true,entry,count:store.entries.length,droppedOldest:dropped};
   });
  },
 },
 {
  name:'memory_search',
  description:[
   'Use this before answering questions about earlier context, or whenever the user asks what you remember; it is the read path for notes created by memory_add.',
   'query (string, required) is free text; it is lowercased and split on non-alphanumeric characters into terms longer than one character, and when no such term exists the whole trimmed query is used as a single term.',
   'limit (integer, optional, 1-100, default 10) caps the number of returned matches.',
   'Scoring: each term adds its occurrence count in the note text plus three times its occurrence count in the joined tags, and the whole query adds 5 more when it appears as a substring of the text; notes that score 0 are omitted, ties break by updatedAt descending.',
   'Returns {query, terms, limit, count, total, matches:[{id,text,tags,createdAt,updatedAt,score}]} where total is the number of stored notes and count is the number of matches returned.',
   'Read-only: no file is written. A missing store means no notes yet, so the call succeeds with count 0 instead of failing.',
   'Failures: args/invalid (empty query, limit out of range), state/corrupt (the store file is not valid JSON), sandbox/denied (the data directory cannot be read).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   query:{type:'string',minLength:1,description:'Keywords or phrase to recall. Case-insensitive; terms of two or more alphanumeric characters are scored separately.'},
   limit:{type:'integer',minimum:1,maximum:100,default:10,description:'Maximum number of matches to return, 1-100; defaults to 10.'},
  },required:['query'],additionalProperties:false},
  run:async(args={},ctx)=>{
   const query=needString(args.query,'query');
   const limit=needInteger(args.limit,'limit',{min:1,max:100,fallback:10});
   const terms=termsOf(query);
   const phrase=query.toLowerCase().trim();
   const store=await readStore(ctx);
   const scored=store.entries
    .map(entry=>({entry,score:scoreEntry(entry,terms,phrase)}))
    .filter(item=>item.score>0)
    .sort((a,b)=>b.score-a.score||(b.entry.updatedAt??0)-(a.entry.updatedAt??0))
    .slice(0,limit)
    .map(item=>({...item.entry,score:item.score}));
   return {query,terms,limit,count:scored.length,total:store.entries.length,matches:scored};
  },
 },
 {
  name:'memory_list',
  description:[
   'Use this to enumerate stored notes when you need a full inventory rather than keyword recall, for example to audit or clean up memory.',
   'limit (integer, optional, 1-500, default 50) caps how many notes are returned after skipping offset.',
   'offset (integer, optional, minimum 0, default 0) skips that many notes; total tells you how many exist so you can page.',
   'Ordering: newest first by updatedAt descending, so a note re-tagged by memory_add moves to the front.',
   'Returns {total, offset, limit, entries:[{id,text,tags,createdAt,updatedAt}]}; total counts every stored note, not just the returned page.',
   'Read-only: no file is written. An empty or missing store returns total 0 and an empty entries array.',
   'Failures: args/invalid (limit or offset out of range), state/corrupt (the store file is not valid JSON), sandbox/denied (the data directory cannot be read).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   limit:{type:'integer',minimum:1,maximum:500,default:50,description:'Maximum entries returned, 1-500; defaults to 50.'},
   offset:{type:'integer',minimum:0,maximum:1000000000,default:0,description:'Number of entries to skip before returning results; defaults to 0.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const limit=needInteger(args.limit,'limit',{min:1,max:500,fallback:50});
   const offset=needInteger(args.offset,'offset',{min:0,max:1000000000,fallback:0});
   const store=await readStore(ctx);
   const ordered=[...store.entries].sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0));
   return {total:ordered.length,offset,limit,entries:ordered.slice(offset,offset+limit)};
  },
 },
 {
  name:'memory_forget',
  description:[
   'Use this to delete notes that are wrong, outdated, or that the user asked to remove; it is the destructive path of the memory store.',
   'Selection precedence: all=true wins, then id, then query. Exactly one selector is normally supplied; providing none is rejected.',
   'id (string, optional) deletes the single note with that exact id and succeeds with removed:0 when no note matches.',
   'query (string, optional) deletes every note whose text or tags score above 0 with the same term matching as memory_search, so it can delete several notes at once.',
   'all (boolean, optional) deletes every note; it must be literally true and is ignored otherwise.',
   'Returns {removed, ids, remaining, entries} where entries holds the deleted notes in full (not what is left), ids lists the deleted ids, and remaining is the note count after the write. When nothing matches, the call still succeeds with removed:0 so it is safe to retry.',
   'Persistence: the store is rewritten atomically in one serialized step, so a concurrent memory_add either happens fully before or fully after the delete.',
   'Failures: args/invalid (no selector supplied), state/corrupt, store/write-failed, sandbox/denied (read-only sandbox or missing permission).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Exact note id to delete.'},
   query:{type:'string',minLength:1,description:'Delete every note whose text or tags match these keywords. Ignored when all is true or id is supplied.'},
   all:{type:'boolean',description:'Delete every stored note. Must be exactly true; omit or set false to keep notes. Takes precedence over id and query.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const id=maybeString(args.id,'id');
   const query=maybeString(args.query,'query');
   const all=args.all===true;
   if(!id&&!query&&!all){
    throw fail('memory_forget needs one selector: pass id to delete one note, query to delete matching notes, or all:true to delete everything; nothing was removed','args/invalid');
   }
   return mutate(ctx,store=>{
    let removed;
    if(all)removed=[...store.entries];
    else if(id)removed=store.entries.filter(entry=>entry.id===id);
    else{
     const terms=termsOf(query);
     const phrase=query.toLowerCase().trim();
     removed=store.entries.filter(entry=>scoreEntry(entry,terms,phrase)>0);
    }
    const ids=new Set(removed.map(entry=>entry.id));
    store.entries=store.entries.filter(entry=>!ids.has(entry.id));
    return {removed:removed.length,ids:[...ids],remaining:store.entries.length,entries:removed};
   });
  },
 },
];
