// core: 有界文件访问、递归搜索、时钟与日历。
// 约定：run() 只返回可直接 JSON 序列化的数据（宿主负责包成 {ok,data}）；
// 失败一律 throw Error，并带稳定 code，方便宿主与模型按 code 分支处理。
import {readFileSync} from 'node:fs';
import {readdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
 insidePath,optionalBoolean,optionalInteger,optionalString,requireString,resolvePath,walkFiles,
} from '../_shared.mjs';

const MAX_FILE_BYTES=2*1024*1024;
const CODEX_HOME=path.resolve(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
const CONFIG_FILE=path.join(CODEX_HOME,'config.toml');

const fail=(message,code)=>Object.assign(new Error(message),{code});

// 读 ${CODEX_HOME}/config.toml 的 sandbox_mode：文件缺失、不可读或没有该键都返回 null，
// 绝不猜测一个模式。
function sandboxMode(){
 try{
  for(const line of readFileSync(CONFIG_FILE,'utf8').split(/\r?\n/)){
   const match=/^\s*sandbox_mode\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))/.exec(line);
   if(match)return match[1]??match[2]??match[3]??null;
  }
 }catch{/* 读不到就当作未知 */}
 return null;
}

// 只读沙箱下先抛错再动手，避免写出半截文件。
function assertWriteAllowed(operation){
 if(sandboxMode()==='read-only')throw fail(`${operation} is blocked: the current sandbox is read-only (${CONFIG_FILE} sets sandbox_mode = "read-only"), so file writes are refused and nothing was written. Call tooling_status in the system pack for the full environment picture, or ask the user to switch sandbox_mode to workspace-write.`,'sandbox/denied');
}

// _shared 的校验器/路径助手不带 code（或用 toolpack/* 码），在包边界统一改写成本包对外的 code，
// 消息保持原样（里面已经有具体路径，模型可以直接引用）。
const argsError=error=>fail(error?.message??'invalid arguments','args/invalid');
const needString=(value,label)=>{try{return requireString(value,label);}catch(error){throw argsError(error);}};
const maybeString=(value,label)=>{try{return optionalString(value,label);}catch(error){throw argsError(error);}};
const maybeInteger=(value,label,options)=>{try{return optionalInteger(value,label,options);}catch(error){throw argsError(error);}};
const maybeBoolean=(value,label)=>{try{return optionalBoolean(value,label);}catch(error){throw argsError(error);}};

function pathError(error){
 const code=typeof error?.code==='string'?error.code:'';
 if(code==='toolpack/outside-roots')return fail(error.message,'path/outside-roots');
 if(code==='ENOTDIR')return fail(`Not a directory: ${error.message}. Use file_list on the parent directory to see what is there.`,'path/not-a-directory');
 if(code==='ENOENT'||/does not exist/i.test(error?.message??''))return fail(error.message,'path/not-found');
 if(code==='EACCES'||code==='EPERM')return fail(`${error.message}. The operating system denied access; check sandbox_mode and file permissions, then retry.`,'sandbox/denied');
 if(code.startsWith('toolpack/'))return fail(error.message,'tool/internal');
 return error;
}

// 所有路径都先过 realpath 证明，symlink 不能把路径带出 allowed roots。
async function objectPath(roots,input,{parent=false,label='path'}={}){
 needString(input,label); // 参数不合法先报 args/invalid，不要落到路径解析里
 try{return await resolvePath(roots,input,{parent,label});}
 catch(error){throw pathError(error);}
}

async function fileRead(args,ctx){
 const target=await objectPath(ctx.roots,args.path);
 let info;
 try{info=await stat(target);}
 catch(error){throw pathError(error);}
 if(!info.isFile())throw fail(`Not a regular file: ${target}. Use file_list to inspect directories and file_search to locate files.`,'path/not-a-file');
 if(info.size>MAX_FILE_BYTES)throw fail(`File is ${info.size} bytes, above the ${MAX_FILE_BYTES} byte (2 MiB) read cap: ${target}. Read a narrower file, or locate the interesting lines with file_search mode content.`,'file/too-large');
 let content;
 try{content=await readFile(target,'utf8');}
 catch(error){throw pathError(error);}
 return {path:target,bytes:info.size,content};
}

async function fileWrite(args,ctx){
 if(typeof args.content!=='string')throw fail('content must be a string containing the complete new file body. This tool replaces the whole file; read it first if you need to keep existing lines.','args/invalid');
 const bytes=Buffer.byteLength(args.content);
 if(bytes>MAX_FILE_BYTES)throw fail(`content is ${bytes} bytes, above the ${MAX_FILE_BYTES} byte (2 MiB) write cap. Split the write, or produce the file with a command-line tool instead.`,'file/too-large');
 assertWriteAllowed('file_write');
 const target=await objectPath(ctx.roots,args.path,{parent:true});
 const existing=await realpath(target).catch(error=>{
  if(error.code==='ENOENT')return null;
  throw pathError(error);
 });
 if(existing&&!ctx.roots.some(root=>insidePath(existing,root)))throw fail(`Path resolves outside the allowed roots through a symlink: ${existing}. Write to a path inside an allowed root instead.`,'path/outside-roots');
 try{await writeFile(target,args.content,'utf8');}
 catch(error){throw pathError(error);}
 return {path:target,bytes};
}

async function fileList(args,ctx){
 const target=await objectPath(ctx.roots,args.path??'.');
 let entries;
 try{entries=await readdir(target,{withFileTypes:true});}
 catch(error){throw pathError(error);}
 return {
  path:target,
  entries:entries.map(entry=>({
   name:entry.name,
   type:entry.isDirectory()?'directory':entry.isFile()?'file':entry.isSymbolicLink()?'symlink':'other',
  })).sort((a,b)=>a.name.localeCompare(b.name)),
 };
}

function matcherFor(query,regex,caseSensitive){
 if(!regex)return text=>caseSensitive?text.includes(query):text.toLowerCase().includes(query.toLowerCase());
 let expression;
 try{expression=new RegExp(query,caseSensitive?'':'i');}
 catch(error){throw fail(`query is not a valid JavaScript regular expression: ${error.message}. Fix the pattern, or pass regex:false to search for the literal text.`,'args/invalid');}
 return text=>expression.test(text);
}

function looksBinary(text){
 if(text.includes('\u0000'))return true;
 let controls=0;
 for(const character of text.slice(0,8192)){const code=character.codePointAt(0);if(code<32&&code!==9&&code!==10&&code!==13)controls++;}
 return controls>8;
}

async function fileSearch(args,ctx){
 const query=needString(args.query,'query');
 const mode=maybeString(args.mode,'mode')??'auto';
 if(!['name','content','auto'].includes(mode))throw fail(`mode must be one of name, content or auto; received ${JSON.stringify(mode)}. Use name to match file names, content to match line text, or auto for both.`,'args/invalid');
 const regex=maybeBoolean(args.regex,'regex');
 const caseSensitive=maybeBoolean(args.caseSensitive,'caseSensitive');
 const limit=maybeInteger(args.maxResults,'maxResults',{min:1,max:1000,fallback:100});
 const maxFileBytes=maybeInteger(args.maxFileBytes,'maxFileBytes',{min:1024,max:5*1024*1024,fallback:1024*1024});
 const ignore=Array.isArray(args.ignore)?args.ignore.filter(item=>typeof item==='string'&&item):[];
 const root=await objectPath(ctx.roots,args.path??'.');
 let rootInfo;
 try{rootInfo=await stat(root);}
 catch(error){throw pathError(error);}
 if(!rootInfo.isDirectory())throw fail(`path must be a directory, but ${root} is not one. Point path at a directory such as "." or use file_read for a single file.`,'path/not-a-directory');
 const matches=matcherFor(query,regex,caseSensitive);
 const searchNames=mode!=='content';
 const searchContent=mode!=='name';
 let truncated=false,bytesRead=0;
 const results=[];
 const stats=await walkFiles(root,{
  ignore,
  maxEntries:50000,
  onEntry:async(full,name)=>{
   if(results.length>=limit){truncated=true;return true;}
   // 统一用正斜杠相对路径，让结果在任何平台都一致。
   const relative=(path.relative(root,full)||name).split(path.sep).join('/');
   if(searchNames&&matches(name)){
    const info=await stat(full).catch(()=>null);
    results.push({kind:'name',path:relative,name,bytes:info?.size??null});
    if(results.length>=limit){truncated=true;return true;}
   }
   if(!searchContent)return false;
   const info=await stat(full).catch(()=>null);
   if(!info||info.size===0||info.size>maxFileBytes)return false;
   let text;
   try{text=await readFile(full,'utf8');}
   catch{return false;}
   bytesRead+=info.size;
   if(looksBinary(text))return false;
   const lines=text.split(/\r?\n/);
   for(let index=0;index<lines.length;index++){
    if(!matches(lines[index]))continue;
    results.push({kind:'content',path:relative,line:index+1,text:lines[index].slice(0,400)});
    if(results.length>=limit){truncated=true;return true;}
   }
   return false;
  },
 });
 return {root,query,mode,regex:regex===true,caseSensitive:caseSensitive===true,matches:results,truncated,scanned:{files:stats.files,directories:stats.directories,entries:stats.entries,bytesRead}};
}

function timeNow(args){
 const zone=args.timeZone===undefined||args.timeZone===null||args.timeZone===''?'UTC':needString(args.timeZone,'timeZone');
 try{
  const now=new Date();
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,dateStyle:'full',timeStyle:'long'});
  return {
   iso:now.toISOString(),
   local:formatter.format(now),
   timeZone:zone,
   unixSeconds:Math.floor(now.getTime()/1000),
   unixMilliseconds:now.getTime(),
   weekday:new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long'}).format(now),
  };
 }catch{
  throw fail(`Invalid IANA time zone: ${JSON.stringify(zone)}. Use a zone name such as Asia/Shanghai, America/New_York or UTC.`,'args/invalid');
 }
}

function calendar(args){
 const now=new Date();
 const year=args.year??now.getUTCFullYear(),month=args.month??now.getUTCMonth()+1;
 if(!Number.isInteger(year)||year<1||year>9999)throw fail(`year must be an integer between 1 and 9999; received ${JSON.stringify(args.year)}. Omit year to use the current UTC year.`,'args/invalid');
 if(!Number.isInteger(month)||month<1||month>12)throw fail(`month must be an integer between 1 and 12; received ${JSON.stringify(args.month)}. Omit month to use the current UTC month.`,'args/invalid');
 const first=new Date(Date.UTC(year,month-1,1)),days=new Date(Date.UTC(year,month,0)).getUTCDate();
 const weeks=[];
 let week=Array(first.getUTCDay()).fill(null);
 for(let day=1;day<=days;day++){
  week.push(day);
  if(week.length===7){weeks.push(week);week=[];}
 }
 if(week.length){while(week.length<7)week.push(null);weeks.push(week);}
 return {year,month,weekdays:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],weeks};
}

export const meta={
 name:'core',
 title:'Core files and time',
 version:'1.1.0',
 description:'Bounded file access inside the allowed roots (read, write, list, recursive name/content search) plus clock and calendar helpers.',
};

export const tools=[
 {
  name:'file_read',
  description:'Read one UTF-8 text file whose path you already know, for example before editing it or to quote its exact contents. Use file_list to discover names and file_search to find a file by pattern first. path: absolute path, or a path resolved against one of the configured allowed roots; anything that resolves outside every allowed root is refused. Returns {path: resolved absolute path, bytes: file size on disk, content: the whole file decoded as UTF-8}. Files above 2 MiB (2097152 bytes) are refused instead of truncated, so narrow the file or locate the interesting lines with file_search. Errors: args/invalid (path missing or not a nonempty string), path/outside-roots (path escapes all allowed roots), path/not-found (nothing exists at that path), path/not-a-file (it is a directory or special file), file/too-large (over 2 MiB), sandbox/denied (the operating system denied access).',
  inputSchema:{type:'object',properties:{path:{type:'string',description:'File path, absolute or relative to an allowed root, e.g. "src/app.js". Must resolve inside an allowed root.'}},required:['path'],additionalProperties:false},
  run:fileRead,
 },
 {
  name:'file_write',
  description:'Create or completely replace one UTF-8 text file inside an allowed root. The parent directory must already exist; this tool never appends, so to add a line read the file, concatenate and write the whole new body. path: absolute file path or a path relative to an allowed root. content: the complete new UTF-8 body, at most 2 MiB (2097152 bytes). Returns {path: resolved absolute path, bytes: number of bytes written}. Fails with sandbox/denied when the current sandbox is read-only (sandbox_mode = read-only in ${CODEX_HOME}/config.toml), in which case nothing is written; path/outside-roots when the path or an existing symlink escapes every allowed root; path/not-found when the parent directory does not exist; file/too-large when content is over 2 MiB; args/invalid when content is not a string.',
  inputSchema:{type:'object',properties:{path:{type:'string',description:'File path, absolute or relative to an allowed root. The parent directory must already exist.'},content:{type:'string',description:'Full UTF-8 content to write, at most 2 MiB. Existing content is replaced, not appended.'}},required:['path','content'],additionalProperties:false},
  run:fileWrite,
 },
 {
  name:'file_list',
  description:'List the direct entries of one directory inside an allowed root, sorted by name, to orient yourself before reading or writing files. path: the directory to list, absolute or relative to an allowed root; defaults to "." (the root itself). Only one level is returned, use file_search with mode name for a recursive listing. Returns {path: resolved absolute path, entries: [{name, type}]} where type is one of file, directory, symlink, other. Errors: args/invalid (path not a string), path/outside-roots, path/not-found (directory does not exist), path/not-a-directory (the path is a file), sandbox/denied (the operating system denied access).',
  inputSchema:{type:'object',properties:{path:{type:'string',description:'Directory path, absolute or relative to an allowed root; defaults to ".".'}},required:[],additionalProperties:false},
  run:fileList,
 },
 {
  name:'file_search',
  description:'Recursively search a directory tree for file names and/or file contents, the fastest way to find a symbol, string or file in a workspace you have not memorised. query: required literal text, or a JavaScript regular expression when regex is true. path: directory to start from, absolute or relative to an allowed root, default ".". mode: name (file names only), content (line text inside files) or auto (both), default auto. regex: treat query as a JavaScript regular expression, default false. caseSensitive: default false. maxResults: 1-1000 matches in total, default 100; hitting the cap sets truncated true. maxFileBytes: 1024-5242880, default 1048576; larger files are skipped in content mode. ignore: extra directory names to skip on top of the built-in list (.git, node_modules, dist, build, target, coverage, ...). Returns {root, query, mode, regex, caseSensitive, matches, truncated, scanned:{files, directories, entries, bytesRead}}; each match is {kind:"name", path, name, bytes} or {kind:"content", path, line (1-based), text (first 400 characters)} with forward-slash relative paths. Binary files, symlinks and oversized files are skipped silently. Errors: args/invalid (bad query, mode, numbers or regular expression), path/outside-roots, path/not-found, path/not-a-directory.',
  inputSchema:{type:'object',properties:{
   query:{type:'string',description:'Text or JavaScript regular expression to find; must be nonempty.'},
   path:{type:'string',description:'Directory to start the recursive walk from; defaults to ".".'},
   mode:{type:'string',enum:['name','content','auto'],description:'name matches file names, content matches line text inside files, auto matches both. Defaults to auto.'},
   regex:{type:'boolean',description:'Treat query as a JavaScript regular expression instead of literal text. Defaults to false.'},
   caseSensitive:{type:'boolean',description:'Match case-sensitively. Defaults to false (case-insensitive).'},
   maxResults:{type:'integer',minimum:1,maximum:1000,description:'Maximum number of matches returned in total; defaults to 100.'},
   maxFileBytes:{type:'integer',minimum:1024,maximum:5242880,description:'Skip files larger than this many bytes in content mode; defaults to 1048576 (1 MiB).'},
   ignore:{type:'array',items:{type:'string'},description:'Extra directory names to skip besides the built-in build/VCS list.'},
  },required:['query'],additionalProperties:false},
  run:fileSearch,
 },
 {
  name:'time_now',
  description:'Read the real clock when you need today\'s date, a unix timestamp or the local time in a specific zone rather than guessing. timeZone: IANA zone name such as Asia/Shanghai, America/New_York or Europe/Berlin; defaults to UTC. Returns {iso: UTC ISO-8601 instant, local: human readable date and time in the requested zone, timeZone: the zone actually used, unixSeconds: integer epoch seconds, unixMilliseconds: integer epoch milliseconds, weekday: English weekday name}. Do arithmetic on the returned value instead of calling this twice. Errors: args/invalid when timeZone is not a string or not a known IANA zone.',
  inputSchema:{type:'object',properties:{timeZone:{type:'string',description:'IANA time zone name such as Asia/Shanghai; defaults to UTC.'}},required:[],additionalProperties:false},
  run:timeNow,
 },
 {
  name:'calendar',
  description:'Build a Gregorian month grid when you must reason about weekdays, for example planning a schedule or counting the days in a month. year: integer 1-9999, default the current UTC year. month: integer 1-12 where 1 is January, default the current UTC month. Returns {year, month, weekdays: [Sun, Mon, Tue, Wed, Thu, Fri, Sat], weeks: array of week rows, each row exactly 7 cells holding a day number or null for padding}. Weeks start on Sunday and the grid is computed from the real calendar, including leap years; no time zone is applied. Errors: args/invalid when year or month is not an integer or is out of range.',
  inputSchema:{type:'object',properties:{year:{type:'integer',minimum:1,maximum:9999,description:'Calendar year, 1-9999; defaults to the current UTC year.'},month:{type:'integer',minimum:1,maximum:12,description:'Month 1-12 (1 is January); defaults to the current UTC month.'}},required:[],additionalProperties:false},
  run:calendar,
 },
];
