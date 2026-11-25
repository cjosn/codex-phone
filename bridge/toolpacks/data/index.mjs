// data: read-only SQLite inspection plus JSON pointer lookup and JSON formatting.
// 本包只读：SQLite 一律用 new DatabaseSync(path,{readOnly:true}) 打开并额外设
// PRAGMA query_only，写语句在碰数据库之前就按关键字拒掉；JSON 工具只读文件。
// 因此只读沙箱下这 4 个工具全部可用（没有 requireWritable 检查），也没有任何写盘路径。
// sqlite 依赖 Node 内置 node:sqlite（动态 import，缺失时报 exec/unavailable），
// 不新增 npm 依赖，也不去 spawn 外部 sqlite 二进制。
import {readFile,stat} from 'node:fs/promises';
import {
 optionalBoolean,optionalInteger,requireString,resolvePath,
} from '../_shared.mjs';

const DEFAULT_LIMIT=200;
const MAX_LIMIT=5000;
const MAX_PARAMS=1000;
const MAX_JSON_BYTES=16*1024*1024;
const MAX_ENTRIES=500;
const ALLOWED_FIRST_KEYWORDS=new Set(['SELECT','PRAGMA','WITH']);
// 只拦真正会写库的动词；\b 边界让 created_at/updated_by 这类列名不被误伤。
const WRITE_KEYWORD_PATTERN=/\b(insert|update|delete|drop|alter|create|attach|detach)\b/i;
const BLOCKED_KEYWORD_HINT='INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, ATTACH and DETACH are refused before the database is touched because sqlite_query is read-only.';

// ---------------------------------------------------------------------------
// 统一失败约定：run() 只返回可 JSON 序列化的数据（宿主会包成 {ok:true,data:V}），
// 失败一律 throw Error + code。_shared.mjs 抛的是旧 toolpack/* 码，这里映射成本组码，
// 消息原样保留。
// ---------------------------------------------------------------------------
const fail=(message,code)=>Object.assign(Error(message),{code});

const SHARED_ERROR_CODES={
 'toolpack/outside-roots':'path/outside-roots',
 'toolpack/store-corrupt':'args/invalid',
};

function normalizeError(error){
 if(error&&typeof error==='object'&&typeof error.code==='string'){
  const mapped=SHARED_ERROR_CODES[error.code];
  if(mapped)return Object.assign(error,{code:mapped});
  if(error.code.includes('/'))return error;
 }
 const message=String(error?.message??error);
 const missing=message.match(/^Path does not exist: (.+)$/);
 if(missing)return fail(`Path does not exist: ${missing[1]}. Check the spelling against the allowed roots (file_exists on the parent directory shows what is there), then retry.`,'path/not-found');
 const parentMissing=message.match(/^Parent directory does not exist: (.+)$/);
 if(parentMissing)return fail(`Parent directory does not exist: ${parentMissing[1]}. Create the parent first, then retry.`,'path/not-found');
 if(/^Not a directory: /.test(message))return fail(`${message}. This tool needs a directory inside an allowed root; pass a directory path instead.`,'path/not-a-file');
 if(/^Not a regular file: /.test(message))return fail(`${message}. This tool needs a regular file; directories and devices are rejected.`,'path/not-a-file');
 if(/outside the allowed roots/i.test(message))return fail(message,'path/outside-roots');
 if(/must be an integer between|must be a nonempty string|must be a boolean|must be a nonempty string array|must be one of/i.test(message))return fail(`${message}. Read the tool inputSchema for the accepted type, range and enum values, then retry.`,'args/invalid');
 if(/does not exist/i.test(message))return fail(message,'path/not-found');
 if(/ENOENT|not found on PATH/i.test(`${error?.code??''} ${message}`))return fail(`${message}. The file or command is missing, so nothing was read or run; check the path and retry.`,'path/not-found');
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

// ---------------------------------------------------------------------------
// node:sqlite 只在真正调用 sqlite 工具时才加载：本 node 构建没有该模块时，
// 只有 sqlite_* 失败（exec/unavailable），json_* 照常工作。
// ---------------------------------------------------------------------------
let sqliteModule=null;
let sqliteLoadError=null;
let sqliteLoadTried=false;

async function requireSqlite(tool){
 if(!sqliteLoadTried){
  sqliteLoadTried=true;
  try{sqliteModule=await import('node:sqlite');}
  catch(error){sqliteLoadError=error;}
 }
 if(!sqliteModule||typeof sqliteModule.DatabaseSync!=='function'){
  const detail=sqliteLoadError?String(sqliteLoadError.message??sqliteLoadError):'the module exports no DatabaseSync';
  throw fail(`${tool} needs the built-in node:sqlite module, but this Node build has no node:sqlite (${detail}; running ${process.version}). Nothing was opened and no dependency was installed: use json_format or json_query on an exported JSON file instead, or run the bridge with a Node build that ships node:sqlite (Node 22.5 and newer, unflagged from Node 23.4).`,'exec/unavailable');
 }
 return sqliteModule;
}

async function openReadOnly(target,tool){
 const {DatabaseSync}=await requireSqlite(tool);
 const info=await stat(target);
 if(info.isDirectory())throw fail(`Not a regular file: ${target}. ${tool} needs a SQLite database file, not a directory; pass the .db/.sqlite file itself.`,'path/not-a-file');
 let database;
 try{
  database=new DatabaseSync(target,{readOnly:true});
 }catch(error){
  const message=String(error?.message??error);
  if(/unable to open database file|no such file|not a database|file is encrypted/i.test(message)){
   throw fail(`Cannot open ${target} as a SQLite database: ${message}. The file is missing, unreadable or not a SQLite database; check it with file_info first, then retry.`,'args/invalid');
  }
  throw fail(`Opening ${target} read-only failed: ${message}. Nothing was written to the file; check the path and permissions, then retry.`,'sql/error');
 }
 // readOnly:true 已经挡住写入，query_only 是第二道闸：即使参数被改坏也写不进库。
 try{database.exec('PRAGMA query_only = ON');}catch{/* older builds may lack it; readOnly still holds */}
 return database;
}

function closeQuietly(database){
 try{database.close();}catch{/* already closed */}
}

function sqliteFailure(error,target){
 const message=String(error?.message??error);
 if(/no such table|no such column|syntax error|near "|incomplete input|unrecognized token|no such function|ambiguous column|has no column named|datatype mismatch/i.test(message)){
  return fail(`SQLite rejected the statement: ${message}. Fix the SQL (table and column names can be listed with sqlite_tables) and retry; nothing was written to ${target}.`,'args/invalid');
 }
 if(/column index out of range|too many parameter|unknown named parameter|parameter/i.test(message)){
  return fail(`The params array does not match the placeholders in sql: ${message}. Pass exactly one params entry per ? placeholder, in order, then retry.`,'args/invalid');
 }
 if(/not a database|file is encrypted|malformed/i.test(message)){
  return fail(`${target} is not a readable SQLite database: ${message}. Check the file with file_info, then retry with the right path.`,'args/invalid');
 }
 return fail(`SQLite failed on ${target}: ${message}. Nothing was written; check the database file and the statement, then retry.`,'sql/error');
}

// bigint 统一降级成 number（安全范围内）或字符串，BLOB 转 {blob:base64,bytes}，
// 保证返回值一定能 JSON 序列化，也不会因为 64 位整数静默丢精度。
function normalizeValue(value){
 if(typeof value==='bigint'){
  if(value<=BigInt(Number.MAX_SAFE_INTEGER)&&value>=BigInt(Number.MIN_SAFE_INTEGER))return Number(value);
  return value.toString();
 }
 if(value instanceof Uint8Array)return {blob:Buffer.from(value).toString('base64'),bytes:value.length};
 return value;
}

function quoteIdentifier(name){return '"'+String(name).replace(/"/g,'""')+'"';}

function normalizeParams(value){
 if(value===undefined||value===null)return [];
 if(!Array.isArray(value))throw fail(`params must be an array of SQL parameter values (got ${typeof value}). Pass them in placeholder order, or omit params entirely, then retry.`,'args/invalid');
 if(value.length>MAX_PARAMS)throw fail(`params holds ${value.length} entries, above the ${MAX_PARAMS} parameter limit for one call. Split the work into several sqlite_query calls and retry.`,'args/invalid');
 return value.map((item,index)=>{
  if(item===null||item===undefined)return null;
  const type=typeof item;
  if(type==='string'||type==='number'||type==='bigint')return item;
  if(type==='boolean')return item?1:0;
  if(item instanceof Uint8Array)return item;
  throw fail(`params[${index}] must be a string, number, boolean, null or byte array (got ${type}): SQL parameters cannot be ${Array.isArray(item)?'arrays':'objects'}. Flatten the value or JSON-encode it into a string, then retry.`,'args/invalid');
 });
}

// 只允许以 SELECT/PRAGMA/WITH 开头的只读语句；关键字扫描在 prepare 之前完成，
// 所以写语句连解析都不会跑到。
function firstKeyword(sql){
 let rest=sql.trim();
 for(;;){
  if(rest.startsWith('--')){
   const newline=rest.indexOf('\n');
   if(newline<0)return '';
   rest=rest.slice(newline+1).trim();
   continue;
  }
  if(rest.startsWith('/*')){
   const end=rest.indexOf('*/');
   if(end<0)return '';
   rest=rest.slice(end+2).trim();
   continue;
  }
  break;
 }
 const match=rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
 return match?match[0].toUpperCase():'';
}

function assertReadOnlySql(sql){
 const keyword=firstKeyword(sql);
 if(!keyword)throw fail('sql must contain a read-only statement: it starts with a comment or is empty, so nothing was executed. Pass one SELECT, PRAGMA or WITH statement, then retry.','args/invalid');
 if(!ALLOWED_FIRST_KEYWORDS.has(keyword))throw fail(`sql must start with SELECT, PRAGMA or WITH (got ${keyword}). ${BLOCKED_KEYWORD_HINT} Rewrite the statement as a read-only query, then retry.`,'args/invalid');
 const forbidden=sql.match(WRITE_KEYWORD_PATTERN);
 if(forbidden)throw fail(`sql contains the write keyword ${forbidden[1].toUpperCase()}. ${BLOCKED_KEYWORD_HINT} Query the data read-only (for example describe the change with SELECT) and let a write-capable tool perform it.`,'args/invalid');
}

// ---------------------------------------------------------------------------
function columnNames(statement){
 try{
  return statement.columns().map(column=>column.name??'');
 }catch{
  return [];
 }
}

async function sqliteQuery(args,ctx){
 const target=await resolvePath(ctx.roots,args.path);
 const sql=requireString(args.sql,'sql');
 assertReadOnlySql(sql);
 const params=normalizeParams(args.params);
 const limit=optionalInteger(args.limit,'limit',{min:1,max:MAX_LIMIT,fallback:DEFAULT_LIMIT});
 const database=await openReadOnly(target,'sqlite_query');
 const started=performance.now();
 try{
  let statement;
  try{
   // readBigInts 让 64 位整数不再抛 RangeError，再由 normalizeValue 决定 number 或字符串。
   statement=database.prepare(sql,{readBigInts:true});
  }catch(error){throw sqliteFailure(error,target);}
  const columns=columnNames(statement);
  const rows=[];
  let truncated=false;
  let iterator=null;
  try{
   try{iterator=statement.iterate(...params);}
   catch(error){throw sqliteFailure(error,target);}
   for(const row of iterator){
    if(rows.length===limit){truncated=true;break;}
    rows.push(Object.values(row).map(normalizeValue));
   }
  }catch(error){
   throw error?.code?error:sqliteFailure(error,target);
  }finally{
   if(iterator&&typeof iterator.return==='function'){
    try{iterator.return();}catch{/* already exhausted */}
   }
  }
  return {path:target,columns,rows,rowCount:rows.length,truncated,durationMs:Math.round(performance.now()-started)};
 }finally{
  closeQuietly(database);
 }
}

function countRows(database,name){
 try{
  const row=database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`,{readBigInts:true}).all()[0];
  if(!row)return null;
  const value=normalizeValue(row.count);
  return typeof value==='number'?value:null;
 }catch{return null;}
}

async function sqliteTables(args,ctx){
 const target=await resolvePath(ctx.roots,args.path);
 const database=await openReadOnly(target,'sqlite_tables');
 try{
  let rows;
  try{
   rows=database.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",{readBigInts:true}).all();
  }catch(error){throw sqliteFailure(error,target);}
  const tables=[],views=[];
  for(const row of rows){
   const name=String(row.name);
   const type=String(row.type);
   const record={name,type,rowCount:countRows(database,name)};
   if(type==='view'){
    if(views.length<MAX_ENTRIES)views.push(record);
    continue;
   }
   if(tables.length<MAX_ENTRIES)tables.push(record);
  }
  return {path:target,tables,views};
 }finally{
  closeQuietly(database);
 }
}

// ---------------------------------------------------------------------------
async function readTextFile(target,tool){
 const info=await stat(target);
 if(!info.isFile())throw fail(`Not a regular file: ${target}. ${tool} needs a regular UTF-8 file; directories, devices and symlinks to them are rejected.`,'path/not-a-file');
 if(info.size>MAX_JSON_BYTES)throw fail(`${target} is ${info.size} bytes, above the ${MAX_JSON_BYTES} byte limit for one call. Extract the part you need with another tool first, then retry.`,'file/too-large');
 let raw=await readFile(target,'utf8');
 if(raw.charCodeAt(0)===0xfeff)raw=raw.slice(1);
 return raw;
}

function jsonTypeOf(value){
 if(value===null)return 'null';
 if(Array.isArray(value))return 'array';
 return typeof value;
}

function parsePointer(pointer){
 if(pointer==='')return [];
 if(!pointer.startsWith('/'))throw fail(`pointer must be a JSON Pointer string such as "/items/0/name" (got ${JSON.stringify(pointer)}). An empty string means the whole document; every other pointer starts with a slash.`,'args/invalid');
 return pointer.slice(1).split('/').map(token=>token.replace(/~1/g,'/').replace(/~0/g,'~'));
}

function resolvePointer(document,tokens){
 let current=document;
 for(const token of tokens){
  if(Array.isArray(current)){
   if(!/^(?:0|[1-9][0-9]*)$/.test(token))return {found:false};
   const index=Number(token);
   if(index>=current.length)return {found:false};
   current=current[index];
   continue;
  }
  if(current!==null&&typeof current==='object'){
   if(!Object.hasOwn(current,token))return {found:false};
   current=current[token];
   continue;
  }
  return {found:false};
 }
 return {found:true,value:current};
}

async function jsonQuery(args,ctx){
 const target=await resolvePath(ctx.roots,args.path);
 const pointer=args.pointer===undefined||args.pointer===null?'':args.pointer;
 if(typeof pointer!=='string')throw fail(`pointer must be a JSON Pointer string (got ${typeof pointer}). Pass "/a/b" or omit it to read the whole document, then retry.`,'args/invalid');
 const tokens=parsePointer(pointer);
 const pretty=optionalBoolean(args.pretty,'pretty');
 const raw=await readTextFile(target,'json_query');
 let document;
 try{document=JSON.parse(raw);}
 catch(error){throw fail(`${target} does not contain valid JSON: ${error.message}. Fix the file (json_format reports line and column) and retry.`,'args/invalid');}
 if(document===null||typeof document!=='object'){
  throw fail(`${target} has a JSON root of type ${jsonTypeOf(document)}, not an object or array. json_query only walks objects and arrays; put the value inside an object or array, or format the text with json_format.`,'args/invalid');
 }
 const resolved=resolvePointer(document,tokens);
 if(!resolved.found)return {path:target,pointer,found:false,type:null,value:null};
 const record={path:target,pointer,found:true,type:jsonTypeOf(resolved.value),value:resolved.value};
 if(pretty)record.text=JSON.stringify(resolved.value,null,2);
 return record;
}

// 1-based 行列号；offset 是 0-based 字符偏移。
function lineColumnAt(raw,offset){
 const point=Math.min(Math.max(offset,0),raw.length);
 const consumed=raw.slice(0,point);
 return {line:consumed.split('\n').length,column:point-consumed.lastIndexOf('\n')};
}

// V8 的 JSON 报错有的带 "(line L column C)"，有的只带 "at position N"，还有的只在消息里
// 引一段原文（"<snippet>" is not valid JSON）。按这三种线索尽量还原位置，还原不了就报 null，
// 而不是编一个坐标。
function jsonParseError(error,raw){
 const message=String(error?.message??error);
 const withLine=message.match(/line (\d+) column (\d+)/);
 if(withLine)return {message,line:Number(withLine[1]),column:Number(withLine[2])};
 const position=message.match(/at position (\d+)/);
 if(position)return {message,...lineColumnAt(raw,Number(position[1]))};
 const snippet=message.match(/"((?:[^"\\]|\\.)*)" is not valid JSON/);
 if(snippet){
  let text=snippet[1];
  try{text=JSON.parse(`"${snippet[1]}"`);}catch{/* keep the escaped form */}
  const index=raw.indexOf(text);
  if(index>=0)return {message,...lineColumnAt(raw,index)};
 }
 return {message,line:null,column:null};
}

async function jsonFormat(args,ctx){
 const indent=optionalInteger(args.indent,'indent',{min:0,max:8,fallback:2});
 const hasJson=Object.hasOwn(args,'json')&&args.json!==undefined&&args.json!==null;
 const hasPath=args.path!==undefined&&args.path!==null&&args.path!=='';
 if(hasJson===hasPath)throw fail(`Pass exactly one of json (inline JSON text) or path (a JSON file inside an allowed root); ${hasJson?'both were provided':'neither was provided'}, so nothing was parsed. Drop one of them and retry.`,'args/invalid');
 let raw;
 if(hasJson){
  if(typeof args.json!=='string')throw fail(`json must be a string of JSON text (got ${jsonTypeOf(args.json)}). Pass the document as text, or use path to read a file, then retry.`,'args/invalid');
  raw=args.json;
 }else{
  if(typeof args.path!=='string')throw fail(`path must be a string (got ${typeof args.path}). Pass a JSON file path inside an allowed root, then retry.`,'args/invalid');
  raw=await readTextFile(await resolvePath(ctx.roots,args.path),'json_format');
 }
 if(raw.charCodeAt(0)===0xfeff)raw=raw.slice(1);
 let value;
 try{value=JSON.parse(raw);}
 catch(error){return {valid:false,error:jsonParseError(error,raw)};}
 const text=indent===0?JSON.stringify(value):JSON.stringify(value,null,indent);
 return {valid:true,bytes:Buffer.byteLength(text,'utf8'),text};
}

// ---------------------------------------------------------------------------
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const pathProperty=(description)=>({type:'string',description});

export const meta={
 name:'data',
 title:'Data',
 version:'1.0.0',
 description:'Read-only SQLite and JSON inspection: list tables and views, run SELECT/PRAGMA/WITH statements with bound parameters and a row cap, resolve JSON Pointers inside a JSON file, and validate, pretty-print or minify JSON. Failures carry a code such as args/invalid, path/outside-roots, path/not-found, path/not-a-file, file/too-large, exec/unavailable or sql/error.',
};

export const tools=[
 {
  name:'sqlite_query',
  description:'Use this to run one read-only SQL statement against a SQLite database file and get the rows back as JSON, so a database can be inspected without any write ever reaching the file. Parameters: path (string, required) is the database file inside an allowed root; sql (string, required) must start with SELECT, PRAGMA or WITH, and any statement containing INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, ATTACH or DETACH is refused with args/invalid before the database is touched; params (array, default []) holds the bound values in placeholder order; limit (integer 1-5000, default 200) caps the returned rows, and one extra existing row only sets truncated. Returns {path: absolute path, columns: column names in order, rows: array of row arrays, rowCount: number of rows returned, truncated: boolean meaning more rows existed, durationMs: number}; integers outside the 2^53-1 range come back as strings and BLOB values as {blob: base64 string, bytes: number}. Failures: "args/invalid" (no sql, not a read statement, a write keyword, unsupported params), "path/outside-roots", "path/not-found" (nothing at path), "path/not-a-file" (path is a directory), "exec/unavailable" (this Node build has no node:sqlite), "sql/error". The file is opened with readOnly:true plus PRAGMA query_only, so this tool cannot modify it.',
  inputSchema:object({
   path:pathProperty('SQLite database file inside an allowed root; opened read-only.'),
   sql:{type:'string',description:'One read-only statement starting with SELECT, PRAGMA or WITH; ? placeholders are filled from params in order.'},
   params:{type:'array',items:{type:['string','number','integer','boolean','null']},maxItems:1000,description:'Bound values for the ? placeholders, in order. Defaults to [] (no parameters); booleans are sent as 1 and 0.'},
   limit:{type:'integer',minimum:1,maximum:5000,description:'Maximum rows to return after the columns are read. Defaults to 200; 1 to 5000 is accepted.'},
  },['path','sql']),
  run:guard(sqliteQuery),
 },
 {
  name:'sqlite_tables',
  description:'Use this to list every user table and view in a SQLite database file together with its row count, so the schema can be discovered before writing a query. Parameters: path (string, required) is the database file inside an allowed root and is opened read-only with PRAGMA query_only. Returns {path: absolute path, tables: [{name, type: "table", rowCount: number|null}], views: [{name, type: "view", rowCount: number|null}]} where internal sqlite_* objects are skipped, at most 500 entries per list are reported, and rowCount is null when the count failed or is not a safe integer. Failures: "args/invalid" (path is not a string, or the file is not a readable SQLite database), "path/outside-roots", "path/not-found", "path/not-a-file" (path is a directory), "exec/unavailable" (this Node build has no node:sqlite), "sql/error".',
  inputSchema:object({path:pathProperty('SQLite database file inside an allowed root; opened read-only.')},['path']),
  run:guard(sqliteTables),
 },
 {
  name:'json_query',
  description:'Use this to pull one part of a JSON document out of a file by JSON Pointer, a minimal jq-like lookup, instead of reading and parsing the whole file through the model. Parameters: path (string, required) is a UTF-8 JSON file inside an allowed root; pointer (string, default "") is an RFC 6901 JSON Pointer such as "/items/0/name", where an empty string means the whole document and tokens escape ~ as ~0 and / as ~1; pretty (boolean, default false) adds an indented text rendering of the fragment. Returns {path: absolute path, pointer, found: boolean, type: "object"|"array"|"string"|"number"|"boolean"|"null"|null, value: the resolved JSON fragment or null, text: indented JSON string present only when pretty is true}; a pointer that does not exist is a normal answer with found:false, not an error. Failures: "args/invalid" (pointer is not a JSON Pointer, the file is not valid JSON, or the document root is not an object or array), "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large" (file above 16777216 bytes).',
  inputSchema:object({
   path:pathProperty('UTF-8 JSON file inside an allowed root.'),
   pointer:{type:'string',description:'RFC 6901 JSON Pointer such as "/items/0/name"; empty or omitted means the whole document; ~1 means / and ~0 means ~.'},
   pretty:{type:'boolean',description:'Also return an indented text rendering in the text field. Defaults to false.'},
  },['path']),
  run:guard(jsonQuery),
 },
 {
  name:'json_format',
  description:'Use this to validate a JSON document and get a pretty-printed or minified copy of it, and to receive precise syntax error coordinates instead of a thrown failure when the text is malformed. Parameters: json (string) is the inline JSON text or path (string) is a JSON file inside an allowed root, and exactly one of the two must be given; indent (integer 0-8, default 2) is the indentation width, and 0 minifies the document to one compact line. Returns {valid: true, bytes: UTF-8 byte length of text, text: the formatted JSON} on success, and {valid: false, error: {message: the parser message, line: 1-based line or null, column: 1-based column or null}} when the JSON is malformed, which is a normal answer rather than a thrown failure. Failures: "args/invalid" (neither json nor path, both, indent outside 0-8, or json not a string), "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large" (file above 16777216 bytes).',
  inputSchema:object({
   json:{type:'string',description:'Inline JSON text to validate and format. Pass either json or path, never both.'},
   path:pathProperty('JSON file inside an allowed root to validate and format. Pass either json or path, never both.'),
   indent:{type:'integer',minimum:0,maximum:8,description:'Indentation width in spaces. Defaults to 2; 0 minifies the document and 0 to 8 is accepted.'},
  },[]),
  run:guard(jsonFormat),
 },
];
