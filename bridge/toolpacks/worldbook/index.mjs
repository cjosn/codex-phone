// worldbook: 可持久命名的世界书条目（知识/lore 块），外加 SillyTavern world-info 的导入导出。
// 状态是 ctx.dataDir 下的原子 JSON，所有写操作串行化。
// 约定：run() 只返回可 JSON 序列化的数据（宿主负责封装），失败一律 throw 带 code 的 Error。
import {randomUUID} from 'node:crypto';
import {readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
 assertExistingInside,readJsonStore,resolvePath,serializeTasks,writeJsonStore,
} from '../_shared.mjs';

const FILE='toolpack-worldbook.json';
const MAX_ENTRIES=500;                       // 条目总数上限
const MAX_CONTENT=20000;                     // 单条正文长度上限
const MAX_TITLE=300;                         // 标题长度上限
const MAX_KEYS=50;                           // 单条条目标签/关键词上限
const MAX_TAGS=30;                           // 单条条目 tag 上限
const MAX_IMPORT_BYTES=4*1024*1024;          // 从文件导入时的字节上限
const serialize=serializeTasks();

const fail=(message,code)=>Object.assign(Error(message),{code});
const DENIED_CODES=new Set(['EACCES','EPERM','EROFS']);

// ---------------------------------------------------------------------------
// 状态读写：把 _shared 的裸错误翻译成本组统一错误码。
// ---------------------------------------------------------------------------
async function load(ctx){
 try{
  const store=await readJsonStore(ctx,FILE);
  const entries=Array.isArray(store.entries)?store.entries.filter(entry=>entry&&typeof entry.id==='string'):[];
  return {version:2,...store,entries};
 }catch(error){
  const target=path.join(ctx.dataDir,FILE);
  if(DENIED_CODES.has(error?.code)){
   throw fail(`Cannot read the worldbook store ${target}: the filesystem or sandbox denied access. Grant read access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  if(error?.code==='toolpack/store-corrupt'){
   throw fail(`The worldbook store ${target} is not valid JSON (${error.message}); it was left untouched so no entry was lost. Repair or delete that file, then retry`,'state/corrupt');
  }
  throw fail(`Reading the worldbook store ${target} failed (${error?.code??'unknown error'}: ${error?.message??error}); nothing was changed. Retry once, then check the data directory permissions`,'state/corrupt');
 }
}

async function save(ctx,store){
 const target=path.join(ctx.dataDir,FILE);
 try{return await writeJsonStore(ctx,FILE,store);}
 catch(error){
  if(DENIED_CODES.has(error?.code)){
   throw fail(`Cannot write the worldbook store ${target}: the filesystem or sandbox denied the write. Grant write access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  throw fail(`Writing the worldbook store ${target} failed (${error?.code??'unknown error'}: ${error?.message??error}); the previous entries are intact. Retry once, then check free disk space and directory ownership`,'store/write-failed');
 }
}

// ---------------------------------------------------------------------------
// 参数校验：失败统一 args/invalid。
// ---------------------------------------------------------------------------
function needString(value,label){
 if(typeof value!=='string'||!value.trim()){
  const got=value===undefined||value===null?'missing':`a ${typeof value}`;
  throw fail(`${label} must be a nonempty string but was ${got}; pass a nonempty string, then retry`,'args/invalid');
 }
 return value;
}

function maybeString(value,label){
 if(value===undefined||value===null)return undefined;
 if(typeof value==='string'&&!value.trim())return undefined;
 return needString(value,label);
}

function needInteger(value,label,{min,max,fallback}){
 if(value===undefined||value===null)return fallback;
 if(!Number.isSafeInteger(value)||value<min||value>max){
  throw fail(`${label} must be an integer between ${min} and ${max} but was ${JSON.stringify(value)}; retry inside that range or omit it to use the default ${fallback}`,'args/invalid');
 }
 return value;
}

function needBoolean(value,label,fallback=false){
 if(value===undefined||value===null)return fallback;
 if(typeof value!=='boolean'){
  throw fail(`${label} must be a boolean but was a ${typeof value}; pass true or false, then retry`,'args/invalid');
 }
 return value;
}

function stringList(value,label,{max=MAX_KEYS,split=false}={}){
 if(value===undefined||value===null)return [];
 let list=value;
 if(typeof list==='string')list=split?list.split(/[,，]/):[list];
 if(!Array.isArray(list)||list.some(item=>typeof item!=='string')){
  throw fail(`${label} must be an array of strings; pass keyword strings or omit the field, then retry`,'args/invalid');
 }
 const cleaned=[...new Set(list.map(item=>item.trim()).filter(Boolean))];
 if(cleaned.length>max){
  throw fail(`${label} has ${cleaned.length} unique items but the limit is ${max}; trim the list, then retry`,'args/invalid');
 }
 return cleaned;
}

function contentOf(value,label='content'){
 const text=needString(value,label);
 if(text.length>MAX_CONTENT){
  throw fail(`${label} is ${text.length} characters but the limit is ${MAX_CONTENT}; split the entry into several entries or shorten it, then retry`,'args/invalid');
 }
 return text;
}

function titleOf(value,label='title'){
 const text=needString(value,label);
 if(text.length>MAX_TITLE){
  throw fail(`${label} is ${text.length} characters but the limit is ${MAX_TITLE}; shorten it, then retry`,'args/invalid');
 }
 return text;
}

function summary(entry){
 return {
  id:entry.id,
  title:entry.title,
  keys:entry.keys,
  tags:entry.tags,
  enabled:entry.enabled,
  contentLength:entry.content.length,
  createdAt:entry.createdAt,
  updatedAt:entry.updatedAt,
 };
}

// 条目定位：id 优先，其次精确标题（区分大小写）；标题可能重复，重复时返回最早创建的一条。
function findEntry(store,args){
 const id=maybeString(args.id,'id');
 const title=maybeString(args.title,'title');
 if(!id&&!title){
  throw fail('Provide id or title to identify the entry; list entries with wb_list first if you do not know either','args/invalid');
 }
 const entry=id?store.entries.find(candidate=>candidate.id===id):store.entries.find(candidate=>candidate.title===title);
 if(!entry){
  const shown=id?`id ${id}`:`title ${JSON.stringify(title)}`;
  const known=store.entries.map(candidate=>candidate.title).slice(0,10).join(', ')||'none';
  throw fail(`No worldbook entry matches ${shown}. Known titles: ${known}. List entries with wb_list, or create it with wb_create`,'state/not-found');
 }
 return entry;
}

function occurrences(haystack,needle){
 if(!needle)return 0;
 const text=haystack.toLowerCase();
 const term=needle.toLowerCase();
 let count=0,index=0;
 while((index=text.indexOf(term,index))>=0){count++;index+=term.length;}
 return count;
}

function termsOf(query){return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(token=>token.length>1))];}

function snippetAround(content,terms,length=200){
 const lower=content.toLowerCase();
 let index=-1;
 for(const term of terms){
  const found=lower.indexOf(term);
  if(found>=0&&(index<0||found<index))index=found;
 }
 if(index<0)return content.slice(0,length);
 const start=Math.max(0,index-60);
 return (start>0?'…':'')+content.slice(start,start+length)+(start+length<content.length?'…':'');
}

function worldbookEntryFrom(input,index,{enabled=true}={}){
 const title=titleOf(
  input?.title??input?.comment??input?.name??(Array.isArray(input?.keys)&&input?.keys[0])??`Entry ${index+1}`,
  `entries[${index}].title`,
 );
 const content=contentOf(input?.content,'entries[].content');
 const now=new Date().toISOString();
 return {
  id:randomUUID(),
  title,
  content,
  keys:stringList(input?.keys??input?.key,'entries[].keys',{max:MAX_KEYS,split:true}),
  tags:stringList(input?.tags,'entries[].tags',{max:MAX_TAGS,split:true}),
  enabled:input?.enabled===undefined?input?.disable===undefined?enabled:input.disable!==true:input.enabled!==false,
  createdAt:now,
  updatedAt:now,
 };
}

// 导入源：内联 JSON（对象/数组/JSON 字符串）或工作区内的 JSON 文件。
async function parseImportSource(args,ctx){
 const json=args.json;
 if(json!==undefined){
  if(typeof json==='string'){
   try{return JSON.parse(json);}
   catch(error){
    throw fail(`json is not valid JSON (${error.message}); pass a JSON string that parses, or pass json as an object; nothing was imported`,'args/invalid');
   }
  }
  if(json&&typeof json==='object')return json;
  const kind=json===null?'null':`a ${typeof json}`;
  throw fail(`json must be an object, an array or a JSON string but was ${kind}; retry with one of those shapes; nothing was imported`,'args/invalid');
 }
 if(args.path!==undefined){
  const target=await resolveWorkspacePath(ctx,args.path);
  const info=await stat(target).catch(error=>{
   if(DENIED_CODES.has(error?.code)){
    throw fail(`Cannot read ${target}: the filesystem or sandbox denied access. Grant read access, then retry; nothing was imported`,'sandbox/denied');
   }
   throw fail(`Cannot stat the import file ${target} (${error?.code??'unknown error'}); check that the path exists and is readable, then retry; nothing was imported`,'state/not-found');
  });
  if(!info.isFile()){
   throw fail(`Not a regular file: ${target}. Pass a path to a JSON file, then retry; nothing was imported`,'args/invalid');
  }
  if(info.size>MAX_IMPORT_BYTES){
   throw fail(`The import file ${target} is ${info.size} bytes but the limit is ${MAX_IMPORT_BYTES}; split it into smaller files, then retry; nothing was imported`,'args/invalid');
  }
  let raw;
  try{raw=await readFile(target,'utf8');}
  catch(error){
   if(DENIED_CODES.has(error?.code)){
    throw fail(`Cannot read ${target}: the filesystem or sandbox denied access. Grant read access, then retry`,'sandbox/denied');
   }
   throw fail(`Reading ${target} failed (${error?.code??'unknown error'}); nothing was imported. Retry, and check the file permissions if it keeps failing`,'state/not-found');
  }
  try{return JSON.parse(raw);}
  catch(error){
   throw fail(`${target} is not valid JSON (${error.message}); fix the file, then retry; nothing was imported`,'args/invalid');
  }
 }
 throw fail('wb_import needs a source: pass json (inline payload) or path (a JSON file inside an allowed root); nothing was imported','args/invalid');
}

// 接受 {entries:[...]}、{entries:{id:{...}}}、{data:[...]}、裸数组或单个条目对象。
function importItems(value){
 if(Array.isArray(value))return value;
 if(!value||typeof value!=='object'){
  throw fail(`The import payload must be an object or an array but was a ${typeof value}; pass SillyTavern world info or a plain entry list, then retry`,'args/invalid');
 }
 const wrapped=value.entries!==undefined||value.data!==undefined;
 const entries=wrapped?(value.entries??value.data):value;
 if(Array.isArray(entries))return entries;
 if(entries&&typeof entries==='object'){
  const list=Object.values(entries);
  // 完全没有 entries/data 包装且对象是空的：说明调用方传错了形状，直接报错而不是静默导入 0 条。
  if(!list.length&&!wrapped){
   throw fail('The import payload has no entries: expected {entries:[...]}, {entries:{id:entry}}, {data:[...]} or a bare array; nothing was imported','args/invalid');
  }
  return list;
 }
 throw fail('The import payload has no entries: expected {entries:[...]}, {entries:{id:entry}}, {data:[...]} or a bare array; nothing was imported','args/invalid');
}

// 工作区路径解析：越界 / 权限问题统一成 sandbox/denied，其余按“路径不存在”处理。
async function resolveWorkspacePath(ctx,input,{parent=false}={}){
 try{return await resolvePath(ctx.roots,input,{parent,label:'path'});}
 catch(error){
  if(DENIED_CODES.has(error?.code)){
   throw fail(`Cannot access ${input}: the filesystem or sandbox denied access. Grant access, then retry`,'sandbox/denied');
  }
  if(error?.code==='toolpack/outside-roots'){
   throw fail(`${error.message}. Only files inside the allowed workspace roots can be read or written; pass a path inside them, then retry`,'sandbox/denied');
  }
  throw fail(`${error.message}. Verify the path exists inside an allowed root, then retry`,'state/not-found');
 }
}

export const meta={
 name:'worldbook',
 title:'Worldbook',
 version:'2.0.0',
 description:'Durable worldbook entries with keyword search plus SillyTavern world-info import and export, stored as atomic JSON at <dataDir>/toolpack-worldbook.json.',
};

export const tools=[
 {
  name:'wb_list',
  description:[
   'Use this to inventory worldbook entries before searching, editing, or deciding what to import; it returns summaries only, never full content.',
   'limit (integer, optional, 1-500, default 50) caps how many entries are returned after skipping offset.',
   'offset (integer, optional, minimum 0, default 0) skips that many entries so you can page through a large book.',
   'includeDisabled (boolean, optional, default true) also lists entries with enabled false; pass false to list only active entries.',
   'Ordering: newest first by updatedAt descending.',
   'Returns {total, stored, offset, limit, entries:[{id,title,keys,tags,enabled,contentLength,createdAt,updatedAt}]}; total counts visible entries, stored counts every entry including hidden ones, and content is omitted here so use wb_get for the body.',
   'Read-only: no file is written; an empty or missing store returns total 0.',
   'Failures: args/invalid (limit or offset out of range), state/corrupt (the store file is not valid JSON), sandbox/denied (the data directory cannot be read).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   limit:{type:'integer',minimum:1,maximum:500,default:50,description:'Maximum entries returned, 1-500; defaults to 50.'},
   offset:{type:'integer',minimum:0,maximum:1000000000,default:0,description:'Number of entries to skip before returning results; defaults to 0.'},
   includeDisabled:{type:'boolean',description:'Include entries whose enabled flag is false. Defaults to true.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const limit=needInteger(args.limit,'limit',{min:1,max:500,fallback:50});
   const offset=needInteger(args.offset,'offset',{min:0,max:1000000000,fallback:0});
   const includeDisabled=needBoolean(args.includeDisabled,'includeDisabled',true);
   const store=await load(ctx);
   const visible=store.entries.filter(entry=>includeDisabled||entry.enabled);
   const ordered=[...visible].sort((left,right)=>(right.updatedAt??'').localeCompare(left.updatedAt??''));
   return {total:visible.length,stored:store.entries.length,offset,limit,entries:ordered.slice(offset,offset+limit).map(summary)};
  },
 },
 {
  name:'wb_get',
  description:[
   'Use this to read the full body of one entry, for example after wb_search or wb_list returned a promising title.',
   'id (string, optional) selects by exact entry id (a UUID) and takes precedence over title.',
   'title (string, optional) selects by exact, case-sensitive title. When several entries share a title the oldest match is returned, so prefer id when titles can repeat.',
   'At least one of id or title is required; the call fails with args/invalid when both are missing and state/not-found when nothing matches.',
   'Returns {entry:{id,title,content,keys,tags,enabled,createdAt,updatedAt}, total} where total is the number of stored entries. content is the complete body, unlike the summaries returned by wb_list.',
   'Read-only: no file is written.',
   'Failures: args/invalid (no selector, non-string selector), state/not-found (no match), state/corrupt, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Exact entry id (UUID); preferred over title.'},
   title:{type:'string',minLength:1,description:'Exact entry title, case-sensitive. Used only when id is omitted.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const store=await load(ctx);
   const entry=findEntry(store,args);
   return {entry,total:store.entries.length};
  },
 },
 {
  name:'wb_create',
  description:[
   'Use this to add a new lore or knowledge block the assistant should be able to recall later; use wb_update to change an existing entry instead.',
   'title (string, required, 1-300 characters) is the display name and the key used by wb_get; titles are compared exactly and case-sensitively.',
   'content (string, required, 1-20000 characters) is the entry body and is stored verbatim.',
   'keys (string array, optional, default [], at most 50 items) are trigger keywords; blanks and duplicates are dropped, and a single bare string is accepted as a one-item list.',
   'tags (string array, optional, default [], at most 30 items) are free-form grouping labels; blanks and duplicates are dropped, and a single bare string is accepted as a one-item list.',
   'enabled (boolean, optional, default true) marks the entry active; disabled entries stay listed but can be filtered out.',
   'allowDuplicate (boolean, optional, default false): when false a title that already exists is rejected with state/conflict, and when true a second entry with the same title is allowed, after which title lookups may become ambiguous so use ids.',
   'Capacity: at most 500 entries are stored; adding one more fails with state/conflict until entries are deleted or exported.',
   'Returns {entry:{id,title,content,keys,tags,enabled,createdAt,updatedAt}, created:true, total}.',
   'Persistence: written atomically to <dataDir>/toolpack-worldbook.json with 0600 permissions; writes are serialized inside this pack, so concurrent wb_create calls cannot lose an entry.',
   'Failures: args/invalid (missing or over-long title/content, too many keys or tags), state/conflict (duplicate title or 500 entry cap), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   title:{type:'string',minLength:1,maxLength:MAX_TITLE,description:'Entry title, 1-300 characters; must be unique unless allowDuplicate is true.'},
   content:{type:'string',minLength:1,maxLength:MAX_CONTENT,description:'Entry body, 1-20000 characters, stored verbatim.'},
   keys:{type:'array',items:{type:'string'},maxItems:MAX_KEYS,description:'Trigger keywords, at most 50 unique non-empty strings; defaults to [] and blank or duplicate entries are ignored. A single bare string is also accepted.'},
   tags:{type:'array',items:{type:'string'},maxItems:MAX_TAGS,description:'Free-form tags, at most 30 unique non-empty strings; defaults to [] and blank or duplicate entries are ignored. A single bare string is also accepted.'},
   enabled:{type:'boolean',description:'Whether the entry is active. Defaults to true.'},
   allowDuplicate:{type:'boolean',description:'Allow a second entry with an existing title. Defaults to false, which rejects duplicates.'},
  },required:['title','content'],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const title=titleOf(args.title);
   const content=contentOf(args.content);
   const allowDuplicate=needBoolean(args.allowDuplicate,'allowDuplicate',false);
   const enabled=needBoolean(args.enabled,'enabled',true);
   if(store.entries.length>=MAX_ENTRIES){
    throw fail(`The worldbook already holds the maximum ${MAX_ENTRIES} entries; delete entries (wb_delete) or export them (wb_export) first, then retry`,'state/conflict');
   }
   const duplicate=store.entries.find(entry=>entry.title===title);
   if(duplicate&&!allowDuplicate){
    throw fail(`An entry titled "${title}" already exists (id ${duplicate.id}); pass allowDuplicate:true to add another one, or edit it with wb_update`,'state/conflict');
   }
   const now=new Date().toISOString();
   const entry={
    id:randomUUID(),
    title,
    content,
    keys:stringList(args.keys,'keys'),
    tags:stringList(args.tags,'tags'),
    enabled,
    createdAt:now,
    updatedAt:now,
   };
   store.entries.push(entry);
   await save(ctx,store);
   return {entry,created:true,total:store.entries.length};
  }),
 },
 {
  name:'wb_update',
  description:[
   'Use this to correct or extend one existing entry; only the fields you supply change, everything else keeps its value.',
   'id (string, required) identifies the entry; an unknown id fails with state/not-found, so read the id with wb_list or wb_search first.',
   'title (string, optional, 1-300 characters) replaces the title; it must not collide with another entry, otherwise state/conflict is returned.',
   'content (string, optional, 1-20000 characters) replaces the whole body; it is not merged with the previous text.',
   'keys (string array, optional, at most 50) replaces the keyword list outright, and tags (string array, optional, at most 30) replaces the tag list outright; pass [] to clear either list, and a single bare string is accepted as a one-item list.',
   'enabled (boolean, optional) toggles the entry; setting false hides it from includeDisabled:false listings without deleting it.',
   'updatedAt is refreshed on every successful call, which also moves the entry to the top of wb_list.',
   'Returns {entry, updated:true} with the complete stored entry after the change.',
   'Persistence: written atomically to <dataDir>/toolpack-worldbook.json; writes are serialized inside this pack, so concurrent updates cannot interleave.',
   'Failures: args/invalid (missing id, over-long or non-string field, too many keys or tags), state/not-found (unknown id), state/conflict (title collision), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Id of the entry to update.'},
   title:{type:'string',minLength:1,maxLength:MAX_TITLE,description:'Replacement title, 1-300 characters; must stay unique.'},
   content:{type:'string',minLength:1,maxLength:MAX_CONTENT,description:'Replacement body, 1-20000 characters; replaces the previous text.'},
   keys:{type:'array',items:{type:'string'},maxItems:MAX_KEYS,description:'Replacement trigger keywords, at most 50; pass [] to clear, blank and duplicate entries are ignored, a single bare string is also accepted.'},
   tags:{type:'array',items:{type:'string'},maxItems:MAX_TAGS,description:'Replacement tags, at most 30; pass [] to clear, blank and duplicate entries are ignored, a single bare string is also accepted.'},
   enabled:{type:'boolean',description:'Enable or disable the entry.'},
  },required:['id'],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const entry=findEntry(store,{id:args.id});
   // 注意：显式传 undefined 会触发默认参数，所以这里用三元判断而不是 fallback 哨兵。
   const enabled=(args.enabled===undefined||args.enabled===null)?undefined:needBoolean(args.enabled,'enabled',false);
   if(args.title!==undefined){
    const title=titleOf(args.title);
    const clash=store.entries.find(candidate=>candidate.id!==entry.id&&candidate.title===title);
    if(clash){
     throw fail(`Another entry titled "${title}" already exists (id ${clash.id}); pick a unique title or update that entry instead`,'state/conflict');
    }
    entry.title=title;
   }
   if(args.content!==undefined)entry.content=contentOf(args.content);
   if(args.keys!==undefined)entry.keys=stringList(args.keys,'keys');
   if(args.tags!==undefined)entry.tags=stringList(args.tags,'tags');
   if(enabled!==undefined)entry.enabled=enabled;
   entry.updatedAt=new Date().toISOString();
   await save(ctx,store);
   return {entry,updated:true};
  }),
 },
 {
  name:'wb_delete',
  description:[
   'Use this to remove an entry permanently once it is obsolete or wrong; export first with wb_export if the text may be needed later, because deletion cannot be undone.',
   'id (string, required) is the exact entry id; get it from wb_list or wb_search. An unknown id fails with state/not-found and nothing is deleted.',
   'Returns {deleted:true, id, title, remaining} where remaining is the entry count after the delete.',
   'Persistence: written atomically to <dataDir>/toolpack-worldbook.json; writes are serialized inside this pack.',
   'Failures: args/invalid (missing id), state/not-found (unknown id), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Id of the entry to delete.'},
  },required:['id'],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const id=needString(args.id,'id');
   const entry=store.entries.find(candidate=>candidate.id===id);
   if(!entry){
    throw fail(`Unknown worldbook entry id: ${id}. List entries with wb_list to find the right id, then retry`,'state/not-found');
   }
   store.entries=store.entries.filter(candidate=>candidate.id!==id);
   await save(ctx,store);
   return {deleted:true,id,title:entry.title,remaining:store.entries.length};
  }),
 },
 {
  name:'wb_search',
  description:[
   'Use this to find the entries relevant to a topic or character before answering, when you do not remember exact titles.',
   'query (string, required) is free text; it is lowercased and split on non-alphanumeric characters into terms longer than one character, and terms are matched case-insensitively as substrings.',
   'limit (integer, optional, 1-100, default 10) caps the number of returned matches.',
   'includeDisabled (boolean, optional, default true) also searches entries with enabled false; pass false to restrict to active entries.',
   'Scoring: each term adds 5 per occurrence in the title, 4 per occurrence across the keys, 3 per occurrence across the tags and 1 per occurrence in the content, plus 10 when the trimmed query appears in the title; entries scoring 0 are omitted and ties break by updatedAt descending.',
   'Returns {query, terms, limit, total, count, matches:[{id,title,keys,tags,enabled,contentLength,createdAt,updatedAt,score,snippet}]}; snippet is up to 200 characters of content around the first matched term, and count is the number of matches returned.',
   'Read-only: no file is written.',
   'Failures: args/invalid (empty query, limit out of range, non-boolean includeDisabled), state/corrupt, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   query:{type:'string',minLength:1,description:'Keywords to search for. Case-insensitive; terms of two or more letters are scored separately.'},
   limit:{type:'integer',minimum:1,maximum:100,default:10,description:'Maximum number of matches returned, 1-100; defaults to 10.'},
   includeDisabled:{type:'boolean',description:'Also search entries whose enabled flag is false. Defaults to true.'},
  },required:['query'],additionalProperties:false},
  run:async(args={},ctx)=>{
   const query=needString(args.query,'query');
   const limit=needInteger(args.limit,'limit',{min:1,max:100,fallback:10});
   const includeDisabled=needBoolean(args.includeDisabled,'includeDisabled',true);
   const terms=termsOf(query);
   const store=await load(ctx);
   const scored=[];
   for(const entry of store.entries){
    if(!includeDisabled&&!entry.enabled)continue;
    const titleHits=terms.reduce((sum,term)=>sum+occurrences(entry.title,term)*5,0);
    const keyHits=terms.reduce((sum,term)=>sum+entry.keys.reduce((inner,key)=>inner+occurrences(key,term)*4,0),0);
    const tagHits=terms.reduce((sum,term)=>sum+entry.tags.reduce((inner,tag)=>inner+occurrences(tag,term)*3,0),0);
    const contentHits=terms.reduce((sum,term)=>sum+occurrences(entry.content,term),0);
    const exact=entry.title.toLowerCase().includes(query.toLowerCase().trim())?10:0;
    const score=titleHits+keyHits+tagHits+contentHits+exact;
    if(score<=0)continue;
    scored.push({...summary(entry),score,snippet:snippetAround(entry.content,terms)});
   }
   scored.sort((left,right)=>right.score-left.score||(right.updatedAt??'').localeCompare(left.updatedAt??''));
   return {query,terms,limit,total:store.entries.length,count:Math.min(scored.length,limit),matches:scored.slice(0,limit)};
  },
 },
 {
  name:'wb_import',
  description:[
   'Use this to load a SillyTavern world-info export or a plain JSON entry list instead of recreating entries one by one.',
   'json (object, array or JSON string, optional) is an inline payload: an array of entry objects, {entries:[...]}, {entries:{id:entry}}, {data:[...]}, or a JSON string of any of those. Each entry may use title or comment or name, content, keys or key, tags, and enabled or disable.',
   'path (string, optional) is a JSON file inside an allowed workspace root, at most 4194304 bytes; the file is read, never modified.',
   'Exactly one source is normally supplied; json wins when both are present, and providing neither fails with args/invalid.',
   'replace (boolean, optional, default false) clears the store before importing, so the result contains only the imported entries; otherwise entries are appended.',
   'Import rules: every entry needs content, a missing title falls back to comment, then name, then the first key, then "Entry N"; entries are skipped once the 500 entry cap is reached, and malformed entries are counted in skipped rather than failing the whole import.',
   'Returns {imported, skipped, total, entries:[{id,title}], replaced} where total is the store size after the import.',
   'Persistence: the store is written atomically to <dataDir>/toolpack-worldbook.json; reading the source file requires read access to the workspace root, and any access failure is reported as sandbox/denied.',
   'Failures: args/invalid (no source, unparseable JSON, payload without entries, oversized file), state/not-found (path does not exist), sandbox/denied (path outside the allowed roots or filesystem denial), state/corrupt, store/write-failed.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   json:{type:['object','array','string'],description:'Inline payload: an array of entry objects, {entries:[...]}, {entries:{id:entry}}, {data:[...]} or a JSON string of any of those.'},
   path:{type:'string',minLength:1,description:'Path to a JSON file inside an allowed workspace root; at most 4194304 bytes and read-only access is enough.'},
   replace:{type:'boolean',description:'Replace the whole store instead of appending. Defaults to false.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const replace=needBoolean(args.replace,'replace',false);
   const payload=await parseImportSource(args,ctx);
   const items=importItems(payload);
   if(replace)store.entries=[];
   const imported=[];
   let skipped=0;
   for(const [index,item] of items.entries()){
    if(!item||typeof item!=='object'){skipped++;continue;}
    if(store.entries.length>=MAX_ENTRIES){skipped+=items.length-index;break;}
    try{
     const entry=worldbookEntryFrom(item,index);
     store.entries.push(entry);
     imported.push({id:entry.id,title:entry.title});
    }catch{skipped++;}
   }
   await save(ctx,store);
   return {imported:imported.length,skipped,total:store.entries.length,entries:imported,replaced:replace};
  }),
 },
 {
  name:'wb_export',
  description:[
   'Use this to hand entries to another tool or to back them up before deleting; it serializes the whole store in one call.',
   'format (string enum, optional, default "json"): json returns the native store shape {version,exportedAt,entries:[...]}; tavern returns SillyTavern world-info shape {entries:{"0":{uid,key,keysecondary,comment,content,disable,...}}} where comment is the title and disable is the inverse of enabled.',
   'path (string, optional) is a file inside an allowed workspace root; when supplied the JSON is written there and omitted from the response, otherwise the payload is returned inline. This is the only tool in this pack that writes a workspace file.',
   'Returns {format, count, outputPath, payload}; payload is present only when path was omitted, and count is the number of exported entries.',
   'Persistence and permissions: the store itself is only read; writing requires write access to the target directory, and a path outside the allowed roots or a filesystem denial fails with sandbox/denied, while other write failures report store/write-failed.',
   'Failures: args/invalid (unsupported format, non-string path), state/not-found (parent directory does not exist), sandbox/denied (outside allowed roots or permission denied), store/write-failed, state/corrupt.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   format:{type:'string',enum:['json','tavern'],description:'Export shape: json for the native store, tavern for SillyTavern world-info. Defaults to json.'},
   path:{type:'string',minLength:1,description:'Optional file inside an allowed workspace root to receive the exported JSON; the parent directory must already exist.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const format=maybeString(args.format,'format')??'json';
   if(!['json','tavern'].includes(format)){
    throw fail(`format must be json or tavern but was ${JSON.stringify(format)}; retry with one of those values`,'args/invalid');
   }
   const store=await load(ctx);
   const payload=format==='json'
    ? {version:2,exportedAt:new Date().toISOString(),entries:store.entries}
    : {entries:Object.fromEntries(store.entries.map((entry,index)=>[String(index),{
     uid:index,
     key:entry.keys,
     keysecondary:[],
     comment:entry.title,
     content:entry.content,
     disable:!entry.enabled,
     constant:false,
     selective:true,
     order:100,
     position:0,
     excludeRecursion:false,
     probability:100,
     useProbability:true,
    }]))};
   let outputPath=null;
   if(args.path!==undefined){
    const target=await resolveWorkspacePath(ctx,args.path,{parent:true});
    await assertExistingInside(ctx.roots,target);
    try{await writeFile(target,JSON.stringify(payload,null,2)+'\n','utf8');}
    catch(error){
     if(DENIED_CODES.has(error?.code)){
      throw fail(`Cannot write ${target}: the filesystem or sandbox denied the write. Grant write access to that directory (or leave read-only mode), then retry`,'sandbox/denied');
     }
     throw fail(`Writing ${target} failed (${error?.code??'unknown error'}: ${error?.message??error}); the worldbook store was not changed. Retry once, then check free disk space`,'store/write-failed');
    }
    outputPath=target;
   }
   return {format,count:store.entries.length,outputPath,payload:outputPath?undefined:payload};
  },
 },
];
