// memoryx: memory 的扩展半边 —— 修改/删除已有笔记、把笔记连成关系图、保存用户偏好。
//
// 笔记本体存放在 `toolpack-memory.json`，也就是 `memory` 包（memory_add/memory_search/
// memory_list/memory_forget）拥有的同一个文件，因此 memoryx 没有“新建”工具：它编辑的是
// 由 memory_add 创建的笔记。关系（links）与偏好（preferences）存放在
// `toolpack-memoryx.json`。两个文件都是 ctx.dataDir 下的原子 JSON。
// 约定：run() 只返回可 JSON 序列化的数据（宿主负责封装），失败一律 throw 带 code 的 Error。
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readJsonStore,serializeTasks,writeJsonStore} from '../_shared.mjs';

// 与 `memory` 包共用同一个存储，这是刻意的：一套笔记，两个工具面。
const MEMORY_FILE='toolpack-memory.json';
const STATE_FILE='toolpack-memoryx.json';
const MAX_LINKS=2000;                 // 关系总数上限
const MAX_TEXT=8000;                  // 笔记正文上限（memory_add 自身限制 4000）
const MAX_TAGS=20;                    // 单条笔记标签上限
const MAX_PREFERENCE_KEYS=200;        // 偏好键数量上限
const MAX_PREFERENCE_BYTES=100*1024;  // 偏好对象序列化后的字节上限
const MAX_RELATION=60;                // 关系标签长度上限
const serialize=serializeTasks();

const fail=(message,code)=>Object.assign(Error(message),{code});
const DENIED_CODES=new Set(['EACCES','EPERM','EROFS']);

// ---------------------------------------------------------------------------
// 状态读写：把 _shared 的裸错误翻译成本组统一错误码，并给出下一步。
// ---------------------------------------------------------------------------
async function loadStore(ctx,file){
 try{return await readJsonStore(ctx,file);}
 catch(error){
  const target=path.join(ctx.dataDir,file);
  if(DENIED_CODES.has(error?.code)){
   throw fail(`Cannot read ${target}: the filesystem or sandbox denied access. Grant read access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  if(error?.code==='toolpack/store-corrupt'){
   throw fail(`The state file ${target} is not valid JSON (${error.message}); it was left untouched so nothing was lost. Repair or delete that file, then retry`,'state/corrupt');
  }
  throw fail(`Reading ${target} failed (${error?.code??'unknown error'}: ${error?.message??error}); nothing was changed. Retry once, then check the data directory permissions`,'state/corrupt');
 }
}

async function saveStore(ctx,file,value){
 try{return await writeJsonStore(ctx,file,value);}
 catch(error){
  const target=path.join(ctx.dataDir,file);
  if(DENIED_CODES.has(error?.code)){
   throw fail(`Cannot write ${target}: the filesystem or sandbox denied the write. Grant write access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  throw fail(`Writing ${target} failed (${error?.code??'unknown error'}: ${error?.message??error}); the previous state is intact. Retry once, then check free disk space and directory ownership`,'store/write-failed');
 }
}

async function loadMemories(ctx){
 const store=await loadStore(ctx,MEMORY_FILE);
 return Array.isArray(store.entries)
  ? store.entries.filter(item=>item&&typeof item.id==='string'&&typeof item.text==='string')
  : [];
}

async function saveMemories(ctx,entries){
 await saveStore(ctx,MEMORY_FILE,{version:1,updatedAt:Date.now(),entries});
}

async function loadState(ctx){
 const store=await loadStore(ctx,STATE_FILE);
 const links=Array.isArray(store.links)?store.links.filter(item=>item&&typeof item.from==='string'&&typeof item.to==='string'):[];
 const preferences=store.preferences&&typeof store.preferences==='object'&&!Array.isArray(store.preferences)?store.preferences:{};
 return {links,preferences};
}

async function saveState(ctx,state){
 await saveStore(ctx,STATE_FILE,{version:2,updatedAt:Date.now(),links:state.links,preferences:state.preferences});
}

// ---------------------------------------------------------------------------
// 参数校验：失败统一 args/invalid，消息写明字段与合法范围。
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

function needTags(value,label='tags'){
 if(value===undefined||value===null)return undefined;
 if(!Array.isArray(value)||value.some(item=>typeof item!=='string')){
  throw fail(`${label} must be an array of strings; pass keyword strings or omit the field, then retry`,'args/invalid');
 }
 const tags=[...new Set(value.map(tag=>tag.trim()).filter(Boolean))];
 if(tags.length>MAX_TAGS){
  throw fail(`${label} has ${tags.length} unique keywords but the limit is ${MAX_TAGS}; send at most ${MAX_TAGS} keywords, then retry`,'args/invalid');
 }
 return tags;
}

function needText(value,label='text'){
 const text=needString(value,label);
 if(text.length>MAX_TEXT){
  throw fail(`${label} is ${text.length} characters but the limit is ${MAX_TEXT}; shorten it, then retry`,'args/invalid');
 }
 return text;
}

function summary(memory){
 return {id:memory.id,text:memory.text,tags:memory.tags??[],createdAt:memory.createdAt,updatedAt:memory.updatedAt};
}

// 引用既可以是 id，也可以是当前笔记的精确正文；找不到时给出下一步。
function findMemory(memories,reference,label){
 const raw=needString(reference,label);
 const byId=memories.find(memory=>memory.id===raw);
 if(byId)return byId;
 const byText=memories.find(memory=>memory.text===raw);
 if(byText)return byText;
 const shown=raw.length>80?raw.slice(0,80)+'...':raw;
 throw fail(`No memory matches ${label} ${JSON.stringify(shown)}. Pass an existing note id or its exact current text; list notes with memory_list, or create one with memory_add first`,'state/not-found');
}

function linkSummary(link,memories){
 const textOfId=id=>memories.find(memory=>memory.id===id)?.text.slice(0,120)??null;
 return {...link,fromText:textOfId(link.from),toText:textOfId(link.to)};
}

function termsOf(query){return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(token=>token.length>1))];}

export const meta={
 name:'memoryx',
 title:'Memory graph',
 version:'2.0.0',
 description:'Edit notes created by memory_add, link related memories with labelled relations, and store user preferences; state lives in <dataDir>/toolpack-memory.json and <dataDir>/toolpack-memoryx.json.',
};

export const tools=[
 {
  name:'memory_update',
  description:[
   'Use this when an existing note is wrong or incomplete and should be corrected in place instead of creating another note; notes are created by memory_add, not here.',
   'Selector: id (preferred) or text. When both are supplied id wins; text must match the current note text exactly. An unknown selector fails with state/not-found.',
   'newText (string, optional, 1-8000 characters) replaces the whole note body; the note keeps its id and tags.',
   'tags (string array, optional) replaces the tag list; addTags (string array, optional) is unioned into the existing tags afterwards, and both are capped at 20 unique keywords, with more being an args/invalid error.',
   'At least one of newText, tags or addTags must be supplied; updatedAt is refreshed on every successful call.',
   'Returns {memory:{id,text,tags,createdAt,updatedAt}, updated:true, total, store} where total is the number of notes after the write and store is the shared file name toolpack-memory.json.',
   'Overwrite policy: the shared store is read-modify-written atomically and serialized inside this pack, but the memory pack keeps its own queue, so a memory_add running at the same time in the same process may still be lost; avoid issuing writes from both packs concurrently. Across processes the last writer wins.',
   'Failures: args/invalid (missing selector, no field to change, over-long text, bad tags), state/not-found (no note matches the selector), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Id of the note to update; preferred over text and wins when both are supplied.'},
   text:{type:'string',minLength:1,description:'Exact current note text, used as the selector only when id is omitted.'},
   newText:{type:'string',minLength:1,maxLength:MAX_TEXT,description:'Replacement note body, 1-8000 characters. Omit to keep the current text.'},
   tags:{type:'array',items:{type:'string'},maxItems:MAX_TAGS,description:'Replacement tag list, at most 20 unique keywords; duplicates and blanks are ignored and more than 20 is rejected. Omit to keep the current tags.'},
   addTags:{type:'array',items:{type:'string'},maxItems:MAX_TAGS,description:'Tags unioned into the existing tags after any replacement, at most 20 unique keywords; duplicates and blanks are ignored.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const memories=await loadMemories(ctx);
   const id=maybeString(args.id,'id');
   const current=maybeString(args.text,'text');
   if(!id&&!current){
    throw fail('memory_update needs a selector: pass the id of the note to update, or its exact current text as text; nothing was changed','args/invalid');
   }
   if(args.newText===undefined&&args.tags===undefined&&args.addTags===undefined){
    throw fail('memory_update needs something to change: pass newText, tags or addTags; nothing was changed','args/invalid');
   }
   const memory=findMemory(memories,id??current,id?'id':'text');
   if(args.newText!==undefined)memory.text=needText(args.newText,'newText');
   if(args.tags!==undefined)memory.tags=needTags(args.tags);
   if(args.addTags!==undefined){
    const extra=needTags(args.addTags,'addTags')??[];
    memory.tags=[...new Set([...(memory.tags??[]),...extra])].slice(0,MAX_TAGS);
   }
   memory.updatedAt=Date.now();
   await saveMemories(ctx,memories);
   return {memory:summary(memory),updated:true,total:memories.length,store:MEMORY_FILE};
  }),
 },
 {
  name:'memory_delete',
  description:[
   'Use this to remove notes from the shared memory store and to clean up the relations that pointed at them; use memory_forget only when you want the simpler forget-by-keyword behaviour.',
   'Selection precedence: all=true, then id or text, then query. Supplying none is rejected with args/invalid.',
   'id (string, optional) deletes the note with that exact id; text (string, optional) deletes the note whose body matches exactly. Both select a single note and fail with state/not-found when nothing matches.',
   'query (string, optional) deletes every note whose text or tags contain any query term of two or more letters, so it can delete several notes at once.',
   'all (boolean, optional) deletes every note; it must be literally true to take effect.',
   'Side effect: every relation whose from or to is a deleted note id is dropped too, reported as linksRemoved, and the note file plus the relation file are written in one serialized step.',
   'Returns {removed, ids, memories, linksRemoved, remaining} where memories are the deleted notes in full and remaining is the note count afterwards. A query that matches nothing succeeds with removed:0; only an id or text selector that matches no note is an error.',
   'Failures: args/invalid (no selector), state/not-found (selector matches no note), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Id of the note to delete; takes precedence over text and query.'},
   text:{type:'string',minLength:1,description:'Exact current note text to delete, used only when id is omitted.'},
   query:{type:'string',minLength:1,description:'Delete every note whose text or tags contain any of these keywords. Used only when all, id and text are absent.'},
   all:{type:'boolean',description:'Delete every note. Must be exactly true; takes precedence over all other selectors.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const memories=await loadMemories(ctx);
   const state=await loadState(ctx);
   const id=maybeString(args.id,'id');
   const text=maybeString(args.text,'text');
   const query=maybeString(args.query,'query');
   if(!id&&!text&&!query&&args.all!==true){
    throw fail('memory_delete needs one selector: pass id, text, query, or all:true to delete everything; nothing was removed','args/invalid');
   }
   let removed;
   if(args.all===true)removed=[...memories];
   else if(id||text)removed=[findMemory(memories,id??text,id?'id':'text')];
   else{
    const terms=termsOf(query);
    removed=memories.filter(memory=>{
     const haystack=(memory.text+' '+(memory.tags??[]).join(' ')).toLowerCase();
     return terms.some(term=>haystack.includes(term));
    });
   }
   const ids=new Set(removed.map(memory=>memory.id));
   const remaining=memories.filter(memory=>!ids.has(memory.id));
   const linksBefore=state.links.length;
   state.links=state.links.filter(link=>!ids.has(link.from)&&!ids.has(link.to));
   await saveMemories(ctx,remaining);
   await saveState(ctx,state);
   return {
    removed:removed.length,
    ids:[...ids],
    memories:removed.map(summary),
    linksRemoved:linksBefore-state.links.length,
    remaining:remaining.length,
   };
  }),
 },
 {
  name:'memory_link',
  description:[
   'Use this to record that two existing notes are related, for example "this deploy note depends on that vault note", so later readers can follow the graph.',
   'from and to (strings, required) identify existing notes by id or by exact current text; both must resolve or the call fails with state/not-found.',
   'relation (string, optional, default "related", 1-60 characters, case-sensitive) is the free-form label; use a stable label such as depends_on, same_person or supersedes so memory_links can filter on it.',
   'Overwrite policy: relations are directed and duplicate detection is exact on (from, to, relation); repeating an existing relation returns created:false with the stored link instead of adding a second row. Self-links are allowed.',
   'Capacity: at most 2000 relations are stored; adding one more fails with state/conflict until notes or relations are deleted.',
   'Returns {link:{id,from,to,relation,createdAt,fromText,toText}, created, total, note?}; fromText and toText are the first 120 characters of the linked notes, and total is the relation count afterwards.',
   'Persistence: written atomically to <dataDir>/toolpack-memoryx.json; writes are serialized inside this pack, so concurrent memory_link calls cannot duplicate a relation or lose one.',
   'Failures: args/invalid (missing from/to, relation too long), state/not-found (from or to matches no note), state/conflict (2000 relation cap), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   from:{type:'string',minLength:1,description:'Source note id or its exact current text.'},
   to:{type:'string',minLength:1,description:'Target note id or its exact current text.'},
   relation:{type:'string',minLength:1,maxLength:MAX_RELATION,description:'Relation label, 1-60 characters, case-sensitive; defaults to "related". Reuse one label per meaning so filtering works.'},
  },required:['from','to'],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const memories=await loadMemories(ctx);
   const state=await loadState(ctx);
   const from=findMemory(memories,args.from,'from');
   const to=findMemory(memories,args.to,'to');
   const relation=maybeString(args.relation,'relation')??'related';
   if(relation.length>MAX_RELATION){
    throw fail(`relation is ${relation.length} characters but the limit is ${MAX_RELATION}; shorten the label, then retry`,'args/invalid');
   }
   const existing=state.links.find(link=>link.from===from.id&&link.to===to.id&&link.relation===relation);
   if(existing)return {link:linkSummary(existing,memories),created:false,total:state.links.length,note:'This relation already existed.'};
   if(state.links.length>=MAX_LINKS){
    throw fail(`The store already holds the maximum ${MAX_LINKS} relations; delete notes or relations first, then retry`,'state/conflict');
   }
   const link={id:randomUUID(),from:from.id,to:to.id,relation,createdAt:new Date().toISOString()};
   state.links.push(link);
   await saveState(ctx,state);
   return {link:linkSummary(link,memories),created:true,total:state.links.length};
  }),
 },
 {
  name:'memory_links',
  description:[
   'Use this to inspect the relation graph before editing notes, or to answer questions such as "what else is connected to this note".',
   'id (string, optional) keeps only relations whose source or target is that note; an unknown id fails with state/not-found instead of returning an empty list.',
   'relation (string, optional, case-sensitive) keeps only relations with that exact label.',
   'Both filters combine with AND; omitting both returns the whole graph.',
   'Relations are directed: a link from A to B is not also listed for B unless you pass B as id, in which case it appears because either endpoint matches.',
   'Returns {id, relation, count, totalLinks, totalMemories, links:[{id,from,to,relation,createdAt,fromText,toText}]} where count is the filtered length and totalLinks counts every stored relation.',
   'Read-only: no file is written; an empty graph returns count 0.',
   'Failures: args/invalid (non-string id or relation), state/not-found (unknown id), state/corrupt, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Note id; keeps only relations whose from or to is this note.'},
   relation:{type:'string',minLength:1,maxLength:MAX_RELATION,description:'Exact relation label to keep, case-sensitive.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const memories=await loadMemories(ctx);
   const state=await loadState(ctx);
   const id=maybeString(args.id,'id');
   const relation=maybeString(args.relation,'relation');
   if(id&&!memories.some(memory=>memory.id===id)){
    throw fail(`Unknown memory id: ${id}. Pass an id that exists (list notes with memory_list), or omit id to list the whole graph`,'state/not-found');
   }
   const links=state.links
    .filter(link=>!id||link.from===id||link.to===id)
    .filter(link=>!relation||link.relation===relation)
    .map(link=>linkSummary(link,memories));
   return {
    id:id??null,
    relation:relation??null,
    count:links.length,
    totalLinks:state.links.length,
    totalMemories:memories.length,
    links,
   };
  },
 },
 {
  name:'memory_preferences_get',
  description:[
   'Use this at the start of a session or before writing anything to learn the user preferences that persisted from earlier sessions; it needs no arguments.',
   'Returns {preferences, keys, bytes, limit:{keys,bytes}} where preferences is the stored JSON object (empty object when nothing was saved), keys counts its top-level keys, bytes is the serialized byte size, and limit reports the 200 key / 102400 byte caps.',
   'Read-only: no file is written; a missing state file returns an empty preferences object instead of failing.',
   'Failures: state/corrupt (the state file is not valid JSON and was left untouched), sandbox/denied (the data directory cannot be read).',
  ].join(' '),
  inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const state=await loadState(ctx);
   const serialized=JSON.stringify(state.preferences);
   return {
    preferences:state.preferences,
    keys:Object.keys(state.preferences).length,
    bytes:Buffer.byteLength(serialized),
    limit:{keys:MAX_PREFERENCE_KEYS,bytes:MAX_PREFERENCE_BYTES},
   };
  },
 },
 {
  name:'memory_preferences_set',
  description:[
   'Use this to persist stable user preferences (language, answer style, time zone) that should survive restarts; store task data in notes instead.',
   'preferences (object, optional) is merged into the stored object with a shallow overwrite: only the supplied top-level keys change and other keys are kept. Keys with a null value are stored as null, not deleted. Because the keys are user defined, this one schema fragment is an open map (additionalProperties true) while every other object in this pack forbids unknown keys.',
   'key (string, optional, 1-100 characters) sets or deletes exactly one top-level key; it is applied after preferences, so it wins on conflict.',
   'value (any JSON value, optional) is stored under key; it is required unless delete is true, and null is stored as an explicit null.',
   'delete (boolean, optional, default false) removes key from the preferences object instead of setting it.',
   'At least one of preferences or key must be supplied. After the merge the object must stay within 200 top-level keys and 102400 serialized bytes or the call fails with state/conflict and nothing is written.',
   'Returns {preferences, keys, bytes, updated:true} describing the stored object after the write.',
   'Persistence: written atomically to <dataDir>/toolpack-memoryx.json; writes are serialized inside this pack, so two concurrent preference writes cannot interleave and lose a key.',
   'Failures: args/invalid (no argument, key too long, value missing without delete, preferences not an object), state/conflict (key or byte cap), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   preferences:{type:'object',additionalProperties:true,description:'Plain object merged shallowly into the stored preferences; keys are user defined so this open map accepts any top-level key. Nested objects are replaced whole, not deep-merged.'},
   key:{type:'string',minLength:1,maxLength:100,description:'Single top-level preference key, 1-100 characters. Applied after preferences.'},
   value:{description:'Any JSON value stored under key (string, number, boolean, object, array or null). Required unless delete is true.'},
   delete:{type:'boolean',description:'Remove key from the preferences object instead of setting it. Defaults to false.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const state=await loadState(ctx);
   const key=maybeString(args.key,'key');
   if(args.preferences!==undefined&&(!args.preferences||typeof args.preferences!=='object'||Array.isArray(args.preferences))){
    throw fail('preferences must be a plain JSON object of top-level keys; pass an object such as {"theme":"dark"} or use key/value; nothing was changed','args/invalid');
   }
   if(args.preferences===undefined&&!key){
    throw fail('memory_preferences_set needs preferences (an object to merge) or key (one key to set or delete); nothing was changed','args/invalid');
   }
   if(args.preferences!==undefined)state.preferences={...state.preferences,...args.preferences};
   if(key){
    if(key.length>100){
     throw fail(`key is ${key.length} characters but the limit is 100; shorten it, then retry`,'args/invalid');
    }
    if(args.delete===true)delete state.preferences[key];
    else{
     if(args.value===undefined){
      throw fail(`Provide value to store under key ${JSON.stringify(key)}, or pass delete:true to remove that key; nothing was changed`,'args/invalid');
     }
     state.preferences[key]=args.value;
    }
   }
   const serialized=JSON.stringify(state.preferences);
   if(Object.keys(state.preferences).length>MAX_PREFERENCE_KEYS){
    throw fail(`preferences would have ${Object.keys(state.preferences).length} keys but the limit is ${MAX_PREFERENCE_KEYS}; delete some keys first, then retry`,'state/conflict');
   }
   if(Buffer.byteLength(serialized)>MAX_PREFERENCE_BYTES){
    throw fail(`preferences would serialize to ${Buffer.byteLength(serialized)} bytes but the limit is ${MAX_PREFERENCE_BYTES}; shrink the value, then retry`,'state/conflict');
   }
   await saveState(ctx,state);
   return {
    preferences:state.preferences,
    keys:Object.keys(state.preferences).length,
    bytes:Buffer.byteLength(serialized),
    updated:true,
   };
  }),
 },
];
