// files: existence/info/hash, move/copy/append/truncate and tar.gz archives.
// 所有路径都走 _shared.mjs 的 realpath + 允许根校验；写盘或执行外部命令的工具在只读
// 沙箱下先抛 sandbox/denied，绝不写一半再失败。归档只用系统 `tar`（child_process,
// shell:false）；zip/7z 需要无法保证存在的二进制，因此显式拒绝而不是假装成功。
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {appendFile,cp,lstat,mkdir,readFile,readdir,readlink,realpath,rename,rm,stat,truncate,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
 DEFAULT_IGNORED_DIRECTORIES,assertExistingInside,insidePath,optionalBoolean,optionalInteger,
 optionalString,requireString,resolveDirectory,resolveLoosePath,resolvePath,runProcess,
 truncateText,
} from '../_shared.mjs';

const MAX_APPEND_BYTES=2*1024*1024;
const MAX_ARCHIVE_ENTRIES=5000;
const HASHES=new Set(['sha256','sha512','sha384','sha1','md5']);
const TAR_MISSING='The system `tar` executable is not available on this host, so tar.gz archives cannot be created or read here. Install bsdtar or GNU tar and retry; zip/7z are intentionally not used because they need a binary that cannot be assumed.';

// ---------------------------------------------------------------------------
// 统一失败约定：run() 只返回可 JSON 序列化的数据（宿主会包成 {ok:true,data:V}），
// 失败一律 throw Error + code。_shared.mjs 抛的是旧的 toolpack/* 码，这里映射成本组
// 的统一码，消息原样保留（调用方/AI 已按这些措辞判断）。
// ---------------------------------------------------------------------------
const fail=(message,code)=>Object.assign(Error(message),{code});

const SHARED_ERROR_CODES={
 'toolpack/outside-roots':'path/outside-roots',
 'toolpack/timeout':'exec/unavailable',
 'toolpack/command-failed':'exec/unavailable',
 'toolpack/tar-unavailable':'exec/unavailable',
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
 if(parentMissing)return fail(`Parent directory does not exist: ${parentMissing[1]}. Create the parent first (for example with file_write or archive_extract), then retry.`,'path/not-found');
 if(/^Not a directory: /.test(message))return fail(`${message}. This tool needs a directory inside an allowed root; pass a directory path instead.`,'path/not-a-file');
 if(/^Not a regular file: /.test(message))return fail(`${message}. This tool needs a regular file; directories, devices and symlink loops are rejected.`,'path/not-a-file');
 if(/outside the allowed roots/i.test(message))return fail(message,'path/outside-roots');
 if(/must be an integer between|must be a nonempty string|must be a boolean|must be a nonempty string array|must be one of/i.test(message))return fail(`${message}. Read the tool inputSchema for the accepted type, range and enum values, then retry.`,'args/invalid');
 if(/does not exist/i.test(message))return fail(message,'path/not-found');
 if(/ENOENT|not found on PATH/i.test(`${error?.code??''} ${message}`))return fail(`${message}. The external command is missing or not on PATH, so nothing was run; install it or use another tool.`,'exec/unavailable');
 return fail(message,'tool/internal');
}

// 所有工具都经过 guard：成功原样返回数据，失败统一补上 code。
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
// sandbox.type）或环境变量里声明只读；任一命中即拒绝写盘与执行。
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

function requireWritable(ctx,tool){
 if(!isReadOnlySandbox(ctx))return;
 throw fail(`${tool} writes to disk, but this session runs in a read-only sandbox, so the call was refused before any file was touched. Ask the user to switch the sandbox to workspace-write or danger-full-access and retry, or use a read-only tool such as file_info or file_hash.`,'sandbox/denied');
}

function requireExec(ctx,tool){
 if(!isReadOnlySandbox(ctx))return;
 throw fail(`${tool} starts an external command (the system tar binary), but this session runs in a read-only sandbox, so nothing was executed and no archive was written. Ask the user to switch the sandbox to workspace-write or danger-full-access and retry.`,'sandbox/denied');
}

async function statOrNull(target){
 try{return await lstat(target);}
 catch(error){
  if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;
  throw error;
 }
}

function typeOf(info){
 if(!info)return null;
 if(info.isSymbolicLink())return 'symlink';
 if(info.isDirectory())return 'directory';
 if(info.isFile())return 'file';
 return 'other';
}

function modeOf(info){return info.mode===undefined?null:'0o'+(info.mode&0o7777).toString(8).padStart(4,'0');}

const iso=value=>value instanceof Date?value.toISOString():null;

async function tarProcess(argv,options){
 try{return await runProcess(argv,options);}
 catch(error){
  if(error.code==='ENOENT')throw fail(TAR_MISSING,'exec/unavailable');
  throw error;
 }
}

// ---------------------------------------------------------------------------
async function fileExists(args,ctx){
 const target=await resolveLoosePath(ctx.roots,args.path);
 const info=await statOrNull(target);
 if(!info)return {path:target,exists:false,type:null};
 const record={path:target,exists:true,type:typeOf(info),bytes:info.size??0,mtime:iso(info.mtime)};
 if(record.type==='symlink')record.linkTarget=await readlink(target).catch(()=>null);
 if(record.type==='symlink'){
  const actual=await realpath(target).catch(()=>null);
  record.realPath=actual;
  record.targetExists=actual!==null;
 }
 return record;
}

async function fileInfo(args,ctx){
 const target=await resolvePath(ctx.roots,args.path);
 const info=await lstat(target);
 const record={
  path:target,
  realPath:await realpath(target).catch(()=>target),
  type:typeOf(info),
  bytes:info.size,
  mode:modeOf(info),
  isSymlink:info.isSymbolicLink(),
  linkTarget:info.isSymbolicLink()?await readlink(target).catch(()=>null):null,
  createdAt:iso(info.birthtime),
  modifiedAt:iso(info.mtime),
  accessedAt:iso(info.atime),
  changedAt:iso(info.ctime),
  links:info.nlink,
  ownerUid:info.uid??null,
  ownerGid:info.gid??null,
 };
 if(record.type==='directory')record.entries=await readdir(target).then(list=>list.length).catch(()=>null);
 return record;
}

async function fileHash(args,ctx){
 const algorithm=optionalString(args.algorithm,'algorithm')??'sha256';
 if(!HASHES.has(algorithm))throw fail(`algorithm must be one of ${[...HASHES].join(', ')} (got ${JSON.stringify(algorithm)}). Pick sha256 unless a peer requires another digest, then retry.`,'args/invalid');
 const target=await resolvePath(ctx.roots,args.path);
 const info=await stat(target);
 if(!info.isFile())throw fail(`Not a regular file: ${target}. Hashing needs a regular file; use file_info to inspect directories and symlinks.`,'path/not-a-file');
 const digest=await new Promise((resolve,reject)=>{
  const hash=createHash(algorithm);
  let bytes=0;
  const stream=createReadStream(target);
  stream.on('data',chunk=>{bytes+=chunk.length;hash.update(chunk);});
  stream.on('error',reject);
  stream.on('end',()=>resolve({hash:hash.digest('hex'),bytes}));
 });
 return {path:target,algorithm,...digest};
}

async function fileAppend(args,ctx){
 requireWritable(ctx,'file_append');
 if(typeof args.content!=='string')throw fail('content must be a string: pass the exact UTF-8 text to append, including its line breaks, then retry.','args/invalid');
 const bytes=Buffer.byteLength(args.content);
 if(bytes>MAX_APPEND_BYTES)throw fail(`content is ${bytes} bytes, above the ${MAX_APPEND_BYTES} byte append limit for one call. Split the payload into several file_append calls of at most ${MAX_APPEND_BYTES} bytes each.`,'file/too-large');
 const target=await resolvePath(ctx.roots,args.path,{parent:true});
 await assertExistingInside(ctx.roots,target);
 const before=await statOrNull(target);
 if(before?.isDirectory())throw fail(`Cannot append to a directory: ${target}. Pass the path of a file, or archive the directory with archive_create.`,'path/not-a-file');
 await appendFile(target,args.content,'utf8');
 const after=await stat(target);
 return {path:target,appendedBytes:bytes,created:!before,previousSize:before?.size??0,size:after.size};
}

async function destinationFor(ctx,from,target,{overwrite}){
 let to=target;
 const targetInfo=await statOrNull(target);
 if(targetInfo?.isDirectory()){
  to=path.join(target,path.basename(from));
  await assertExistingInside(ctx.roots,to);
 }
 const comparisonFrom=process.platform==='win32'?from.toLowerCase():from;
 const comparisonTo=process.platform==='win32'?to.toLowerCase():to;
 if(comparisonFrom===comparisonTo)throw fail(`from and to resolve to the same path (${to}). Pass two different paths inside the allowed roots and retry.`,'args/invalid');
 if(insidePath(from,to)&&from!==to)throw fail(`Cannot move or copy a directory into itself (${from} -> ${to}). Pick a destination outside the source directory.`,'args/invalid');
 const existing=await statOrNull(to);
 if(existing&&!overwrite)throw fail(`Destination already exists: ${to}. Pass overwrite:true to replace it, or choose another destination.`,'args/invalid');
 return {to,existing};
}

async function fileMove(args,ctx){
 requireWritable(ctx,'file_move');
 // 先校验参数再碰文件系统，避免参数错误被路径错误掩盖。
 const overwrite=optionalBoolean(args.overwrite,'overwrite');
 const from=await resolvePath(ctx.roots,args.from,{label:'from'});
 const target=await resolvePath(ctx.roots,args.to,{parent:true,label:'to'});
 const sourceInfo=await lstat(from);
 const {to,existing}=await destinationFor(ctx,from,target,{overwrite});
 if(existing?.isDirectory())await rm(to,{recursive:true,force:true});
 try{
  await rename(from,to);
 }catch(error){
  if(error.code!=='EXDEV')throw error;
  // Different volumes: real copy followed by a real delete of the source.
  await cp(from,to,{recursive:true,force:true,errorOnExist:false});
  await rm(from,{recursive:true,force:true});
 }
 return {from,to,moved:true,type:typeOf(sourceInfo),overwritten:existing!==null,bytes:sourceInfo.size};
}

async function fileCopy(args,ctx){
 requireWritable(ctx,'file_copy');
 // 先校验参数再碰文件系统，避免参数错误被路径错误掩盖。
 const overwrite=optionalBoolean(args.overwrite,'overwrite');
 const from=await resolvePath(ctx.roots,args.from,{label:'from'});
 const target=await resolvePath(ctx.roots,args.to,{parent:true,label:'to'});
 const sourceInfo=await lstat(from);
 if(sourceInfo.isSymbolicLink())throw fail(`Refusing to copy a symbolic link: ${from}. Copy the resolved target instead (file_info reports realPath), then retry.`,'args/invalid');
 const {to,existing}=await destinationFor(ctx,from,target,{overwrite});
 if(existing?.isDirectory())await rm(to,{recursive:true,force:true});
 await cp(from,to,{recursive:true,force:true,errorOnExist:false,preserveTimestamps:true});
 const copied=await stat(to);
 return {
  from,
  to,
  copied:true,
  type:typeOf(sourceInfo),
  overwritten:existing!==null,
  bytes:copied.isDirectory()?null:copied.size,
 };
}

async function fileTruncate(args,ctx){
 requireWritable(ctx,'file_truncate');
 const size=optionalInteger(args.size,'size',{min:0,max:Number.MAX_SAFE_INTEGER,fallback:0});
 const target=await resolvePath(ctx.roots,args.path);
 const info=await stat(target);
 if(!info.isFile())throw fail(`Not a regular file: ${target}. Truncation needs a regular file; use file_info to inspect directories and symlinks.`,'path/not-a-file');
 const allowExtend=optionalBoolean(args.allowExtend,'allowExtend');
 if(size>info.size&&!allowExtend)throw fail(`size ${size} is larger than the current ${info.size} bytes; extending pads the file with zero bytes. Pass allowExtend:true to confirm, or pass a size between 0 and ${info.size}.`,'args/invalid');
 await truncate(target,size);
 return {path:target,previousSize:info.size,size,shrunk:size<info.size};
}

async function archiveCreate(args,ctx){
 requireWritable(ctx,'archive_create');
 requireExec(ctx,'archive_create');
 const output=await resolvePath(ctx.roots,args.output,{parent:true});
 const format=optionalString(args.format,'format')??'tar.gz';
 if(!['tar.gz','tgz'].includes(format)){
  throw fail(`archive_create only writes tar.gz (got ${JSON.stringify(format)}): zip and 7z need a binary that is not guaranteed on this host. Pass format "tar.gz", or use the system tar tool directly.`,'args/invalid');
 }
 const base=await resolveDirectory(ctx.roots,args.base??'.',{label:'base'});
 const requested=Array.isArray(args.paths)&&args.paths.length?args.paths:['.'];
 if(requested.length>MAX_ARCHIVE_ENTRIES)throw fail(`paths lists ${requested.length} entries, above the ${MAX_ARCHIVE_ENTRIES} entry limit for one call. Archive a parent directory instead (paths:["."]) or split the work into several archives.`,'args/invalid');
 const entries=[];
 for(const item of requested){
  const resolved=await resolvePath(ctx.roots,item,{label:'paths'});
  if(!insidePath(resolved,base))throw fail(`Archive entry is outside the base directory: ${item} (resolved to ${resolved}, base is ${base}). Pass base as a directory that contains every entry, or change paths.`,'path/outside-roots');
  entries.push(path.relative(base,resolved).split(path.sep).join('/')||'.');
 }
 const slash=value=>value.split(path.sep).join('/');
 const relativeOutput=insidePath(output,base)?slash(path.relative(base,output)):null;
 if(output===base)throw fail(`The archive output cannot be the base directory itself (${base}). Pass an output file path, for example "bundle.tar.gz".`,'args/invalid');
 const argv=['tar','-czf',output];
 if(relativeOutput)argv.push(`--exclude=${relativeOutput}`);
 argv.push('-C',base,...entries);
 const result=await tarProcess(argv,{timeoutMs:120000,maxBytes:64*1024});
 if(result.exitCode!==0){
  throw fail(`tar -czf failed with ${result.exitCode??result.signal}: ${(result.stderr||result.stdout).trim().slice(0,2000)||'no output'}. The archive at ${output} is incomplete, so treat it as unusable; check that every entry is readable and that the output directory is writable, then retry.`,'exec/unavailable');
 }
 const info=await stat(output);
 return {
  archive:output,
  format:'tar.gz',
  bytes:info.size,
  base,
  entries,
  excludedOutput:relativeOutput,
  implementation:'system tar (child_process, shell:false)',
 };
}

async function archiveExtract(args,ctx){
 requireWritable(ctx,'archive_extract');
 requireExec(ctx,'archive_extract');
 const archive=await resolvePath(ctx.roots,args.archive,{label:'archive'});
 const destination=await resolvePath(ctx.roots,args.destination??'.',{parent:true,label:'destination'});
 await mkdir(destination,{recursive:true,mode:0o700});
 await assertExistingInside(ctx.roots,destination);
 const listing=await tarProcess(['tar','-tzf',archive],{timeoutMs:120000,maxBytes:4*1024*1024});
 if(listing.exitCode!==0){
  throw fail(`tar -tzf failed with ${listing.exitCode??listing.signal}: ${(listing.stderr||listing.stdout).trim().slice(0,2000)||'not a readable tar.gz archive'}. Nothing was extracted; confirm the file is a real tar.gz (archive_create writes that format) and retry.`,'exec/unavailable');
 }
 const names=listing.stdout.split(/\r?\n/).map(name=>name.trim()).filter(Boolean);
 if(!names.length)throw fail(`The archive is empty: ${archive} lists zero entries, so there is nothing to extract. Check that archive_create was given paths and retry.`,'args/invalid');
 if(names.length>MAX_ARCHIVE_ENTRIES)throw fail(`Archive has ${names.length} entries, above the ${MAX_ARCHIVE_ENTRIES} entry limit. Extract it with the system tar tool directly, or narrow the archive.`,'args/invalid');
 const unsafe=names.filter(name=>path.posix.isAbsolute(name)||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'));
 if(unsafe.length)throw fail(`Refusing to extract an archive with unsafe paths: ${unsafe.slice(0,5).join(', ')}. Nothing was extracted; rebuild the archive with relative entries inside one directory.`,'path/outside-roots');
 const extracted=await tarProcess(['tar','-xzf',archive,'-C',destination],{timeoutMs:120000,maxBytes:64*1024});
 if(extracted.exitCode!==0){
  throw fail(`tar -xzf failed with ${extracted.exitCode??extracted.signal}: ${(extracted.stderr||extracted.stdout).trim().slice(0,2000)||'no output'}. Some files may already be in ${destination}; check the destination and retry.`,'exec/unavailable');
 }
 const files=names.filter(name=>!name.endsWith('/'));
 return {
  archive,
  destination,
  entries:names.length,
  files:files.length,
  directories:names.length-files.length,
  listing:names.slice(0,500),
  truncatedListing:names.length>500,
 };
}

// ---------------------------------------------------------------------------
// 基础文件工具补充：按行区间读、精确替换、删除、建目录、按名查找、按内容查找。
// 路径一律走上面的允许根校验；写类工具在碰盘之前先过 requireWritable，读类工具在只读
// 沙箱下照常工作。任何参数错误都先于文件系统改动抛出，绝不写一半再失败。
// ---------------------------------------------------------------------------
const READ_RANGE_DEFAULT_BYTES=262144;
const READ_RANGE_MAX_BYTES=2*1024*1024;
const READ_RANGE_MAX_LINES=5000;
const READ_RANGE_MAX_LINE_NUMBER=100000000;
const EDIT_MAX_BYTES=32*1024*1024;
const FIND_MAX_DEPTH=32;
const FIND_MAX_LIMIT=2000;
const GREP_MAX_RESULTS=500;
const GREP_MAX_CONTEXT=5;
const GREP_MAX_FILE_BYTES=16*1024*1024;
const GREP_MAX_LINE_CHARS=2000;
const WALK_MAX_ENTRIES=50000;

// 通配符只认 `*`（任意字符序列）和 `?`（单个字符），其余字符按字面量转义；
// 匹配对象是条目名（basename），不是相对路径。调用方已经拒绝带分隔符的模式。
function globToRegExp(pattern,label){
 let source='^';
 for(const character of pattern){
  if(character==='*')source+='[^/]*';
  else if(character==='?')source+='[^/]';
  else source+=character.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 }
 try{return new RegExp(`${source}$`);}
 catch(error){throw fail(`${label} is not a usable wildcard pattern: ${error.message}. Use only * and ? as wildcards, for example "*.ts", then retry.`,'args/invalid');}
}

// mode 只接受八进制字符串（JSON 无法表达前导 0 的数字），"755" 与 "0755" 等价。
function parseMode(value){
 if(value===undefined||value===null||value==='')return undefined;
 if(typeof value!=='string')throw fail('mode must be an octal string such as "0755", not a JSON number, because JSON cannot express a leading zero. Pass the digits as a string, then retry.','args/invalid');
 const text=value.trim().replace(/^0o/i,'');
 if(!/^[0-7]{3,4}$/.test(text))throw fail(`mode must be 3 or 4 octal digits such as "0755" or "755" (got ${JSON.stringify(value)}). It is parsed as base 8, so only the digits 0-7 are allowed; fix the mode or omit it.`,'args/invalid');
 return Number.parseInt(text,8);
}

// 确定性深度优先遍历：目录按名字排序，跳过符号链接、隐藏条目（可选）与重量级目录。
// onEntry 返回 'stop' 时立刻停止遍历。maxDepth 计入 root 之下一层的深度。
async function walkTree(root,{maxDepth,includeHidden=false,maxEntries=WALK_MAX_ENTRIES,onEntry}){
 const stats={entries:0,skipped:0,directories:0,truncated:false};
 let stopped=false;
 const visit=async(directory,depth)=>{
  if(depth>maxDepth){stats.truncated=true;return;}
  let listing;
  try{listing=await readdir(directory,{withFileTypes:true});}
  catch{stats.skipped++;return;}
  stats.directories++;
  listing.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of listing){
   if(stopped)return;
   stats.entries++;
   if(stats.entries>maxEntries){stats.truncated=true;stopped=true;return;}
   if(!includeHidden&&entry.name.startsWith('.')){stats.skipped++;continue;}
   if(entry.isSymbolicLink()){stats.skipped++;continue;}
   const isDirectory=entry.isDirectory();
   if(isDirectory&&DEFAULT_IGNORED_DIRECTORIES.has(entry.name)){stats.skipped++;continue;}
   const full=path.join(directory,entry.name);
   if(await onEntry({path:full,name:entry.name,isDirectory,depth})==='stop'){stopped=true;return;}
   if(isDirectory)await visit(full,depth+1);
  }
 };
 await visit(root,1);
 return stats;
}

// 流式扫描全文：只保留 [startLine,endLine] 的行，同时给出全文行数。
// 尾随换行不算额外一行；CRLF 的 \r 被去掉。
async function readLineWindow(target,{startLine,endLine}){
 const stream=createReadStream(target,{encoding:'utf8',highWaterMark:64*1024});
 const collected=[];
 let buffer='';
 let totalLines=0;
 const take=line=>{
  totalLines++;
  if(totalLines>=startLine&&totalLines<=endLine)collected.push(line);
 };
 try{
  for await (const chunk of stream){
   if(chunk.includes('\u0000'))throw fail(`${target} contains NUL bytes, so it is a binary file and cannot be read line by line as text; use file_hash or file_info to inspect it.`,'file/not-text');
   buffer+=chunk;
   let index;
   while((index=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,index);
    buffer=buffer.slice(index+1);
    take(line.endsWith('\r')?line.slice(0,-1):line);
   }
  }
  if(buffer.length)take(buffer.endsWith('\r')?buffer.slice(0,-1):buffer);
 }finally{stream.destroy();}
 return {totalLines,collected};
}

async function fileReadRange(args,ctx){
 const startLine=optionalInteger(args.startLine,'startLine',{min:1,max:READ_RANGE_MAX_LINE_NUMBER,fallback:1});
 const requestedEnd=optionalInteger(args.endLine,'endLine',{min:1,max:READ_RANGE_MAX_LINE_NUMBER});
 const maxBytes=optionalInteger(args.maxBytes,'maxBytes',{min:1,max:READ_RANGE_MAX_BYTES,fallback:READ_RANGE_DEFAULT_BYTES});
 const endLine=requestedEnd===undefined?Math.min(startLine+500,READ_RANGE_MAX_LINE_NUMBER):requestedEnd;
 if(endLine<startLine)throw fail(`endLine ${endLine} is below startLine ${startLine}, so the range would be empty. endLine is inclusive: pass endLine at or above startLine and retry.`,'args/invalid');
 if(endLine-startLine+1>READ_RANGE_MAX_LINES)throw fail(`The range ${startLine}-${endLine} spans ${endLine-startLine+1} lines, above the ${READ_RANGE_MAX_LINES} line ceiling for one call, so nothing was read. Page through the file with several calls of at most ${READ_RANGE_MAX_LINES} lines; totalLines in the result shows where the file ends.`,'args/invalid');
 const target=await resolvePath(ctx.roots,args.path);
 const info=await stat(target);
 if(!info.isFile())throw fail(`Not a regular file: ${target}`);
 const {totalLines,collected}=await readLineWindow(target,{startLine,endLine});
 if(totalLines===0)return {path:target,totalLines:0,startLine,endLine,truncated:false,content:''};
 if(startLine>totalLines)throw fail(`startLine ${startLine} is past the end of ${target}, which has ${totalLines} lines. Pass a startLine between 1 and ${totalLines}, then retry.`,'args/invalid');
 let content='';
 let cutByBytes=false;
 for(const line of collected){
  const candidate=content?`${content}\n${line}`:line;
  if(Buffer.byteLength(candidate)>maxBytes){
   const room=maxBytes-Buffer.byteLength(content)-(content?1:0);
   if(room>0){
    let slice=line;
    while(Buffer.byteLength(slice)>room)slice=slice.slice(0,-1);
    content=content?`${content}\n${slice}`:slice;
   }
   cutByBytes=true;
   break;
  }
  content=candidate;
 }
 return {
  path:target,
  totalLines,
  startLine,
  endLine,
  truncated:cutByBytes||endLine<totalLines,
  content,
 };
}

async function fileEdit(args,ctx){
 requireWritable(ctx,'file_edit');
 // 先校验参数，参数错误绝不触碰文件。
 const oldText=args.old;
 if(typeof oldText!=='string'||oldText.length===0)throw fail('old must be a nonempty string, so nothing was modified. Pass the exact text to replace; it is matched literally, never as a regular expression.','args/invalid');
 if(typeof args.new!=='string')throw fail('new must be a string, so nothing was modified. Pass the replacement text, or an empty string to delete the matched text.','args/invalid');
 const replaceAll=optionalBoolean(args.replaceAll,'replaceAll');
 const expectedCount=optionalInteger(args.expectedCount,'expectedCount',{min:1,max:1000000});
 const target=await resolvePath(ctx.roots,args.path);
 const info=await stat(target);
 if(!info.isFile())throw fail(`Not a regular file: ${target}`);
 if(info.size>EDIT_MAX_BYTES)throw fail(`${target} is ${info.size} bytes, above the ${EDIT_MAX_BYTES} byte ceiling for one exact edit, so nothing was changed. Split the file, or rewrite it whole with file_write.`,'file/too-large');
 const before=await readFile(target,'utf8');
 if(before.includes('\u0000'))throw fail(`${target} contains NUL bytes, so it is a binary file and an exact text edit would corrupt it; nothing was changed. Use file_hash or file_info to inspect it.`,'file/not-text');
 const count=before.split(oldText).length-1;
 if(count===0)throw fail(`old did not match anywhere in ${target}, so the file was not modified. The match is literal: copy the text from file_read or file_read_range exactly, including indentation and line breaks, then retry.`,'args/invalid');
 if(expectedCount!==undefined&&count!==expectedCount)throw fail(`old matches ${count} times in ${target} but expectedCount is ${expectedCount}, so the file was not modified. Fix the anchor text or the expected count and retry.`,'args/invalid');
 if(count>1&&!replaceAll)throw fail(`old matches ${count} times in ${target} and replaceAll is false, so the file was not modified. Pass replaceAll:true to replace every occurrence, or extend old with surrounding lines so it is unique.`,'args/invalid');
 const index=before.indexOf(oldText);
 const after=replaceAll?before.split(oldText).join(args.new):`${before.slice(0,index)}${args.new}${before.slice(index+oldText.length)}`;
 await writeFile(target,after,'utf8');
 return {
  path:target,
  replacements:count,
  bytesBefore:Buffer.byteLength(before),
  bytesAfter:Buffer.byteLength(after),
 };
}

async function fileDelete(args,ctx){
 requireWritable(ctx,'file_delete');
 const recursive=optionalBoolean(args.recursive,'recursive');
 const target=await resolvePath(ctx.roots,args.path);
 const normalized=process.platform==='win32'?target.toLowerCase():target;
 for(const root of ctx.roots){
  const comparison=process.platform==='win32'?root.toLowerCase():root;
  if(normalized===comparison)throw fail(`Refusing to delete the allowed root itself (${target}), so nothing was deleted. Delete entries inside the root, or ask the user to change the allowed roots.`,'args/invalid');
 }
 const info=await lstat(target);
 if(info.isSymbolicLink()){
  await rm(target,{force:false});
  return {path:target,deleted:true,kind:'symlink'};
 }
 if(info.isDirectory()){
  const children=await readdir(target);
  if(children.length&&!recursive)throw fail(`${target} is a directory with ${children.length} entries and recursive is false, so nothing was deleted. Pass recursive:true to delete the directory and everything inside it, or delete the entries first.`,'args/invalid');
  await rm(target,{recursive:true,force:false});
  return {path:target,deleted:true,kind:'directory'};
 }
 await rm(target,{force:false});
 return {path:target,deleted:true,kind:'file'};
}

async function fileMkdir(args,ctx){
 requireWritable(ctx,'file_mkdir');
 const mode=parseMode(args.mode);
 const target=await resolveLoosePath(ctx.roots,args.path);
 const existing=await stat(target).catch(error=>{
  if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;
  throw error;
 });
 if(existing){
  if(existing.isDirectory())return {path:target,created:false};
  throw fail(`${target} already exists and is not a directory, so nothing was created. Move or delete it, or choose another path.`,'path/not-a-directory');
 }
 try{
  await mkdir(target,{recursive:true,...(mode===undefined?{}:{mode})});
 }catch(error){
  if(error.code==='EEXIST'||error.code==='ENOTDIR')throw fail(`${target} could not be created as a directory: ${error.code}. Something else occupies that path; inspect it with file_info, then retry.`,'path/not-a-directory');
  throw error;
 }
 await assertExistingInside(ctx.roots,target);
 return {path:target,created:true};
}

async function fileFind(args,ctx){
 const root=await resolveDirectory(ctx.roots,optionalString(args.root,'root')??'.',{label:'root'});
 const pattern=requireString(args.pattern,'pattern');
 if(pattern.includes('/')||pattern.includes('\\'))throw fail(`pattern must match entry names, not paths, so it cannot contain a path separator (got ${JSON.stringify(pattern)}). Pass a name pattern such as "*.ts" and choose the directory with root, then retry.`,'args/invalid');
 const maxDepth=optionalInteger(args.maxDepth,'maxDepth',{min:1,max:FIND_MAX_DEPTH,fallback:8});
 const type=optionalString(args.type,'type')??'any';
 if(!['file','dir','any'].includes(type))throw fail(`type must be one of "file", "dir", "any" (got ${JSON.stringify(type)}). Pick one of those three values and retry.`,'args/invalid');
 const limit=optionalInteger(args.limit,'limit',{min:1,max:FIND_MAX_LIMIT,fallback:200});
 const includeHidden=optionalBoolean(args.includeHidden,'includeHidden');
 const matcher=globToRegExp(pattern,'pattern');
 const entries=[];
 let hitLimit=false;
 const stats=await walkTree(root,{maxDepth,includeHidden,onEntry:async entry=>{
  if(type==='file'&&entry.isDirectory)return;
  if(type==='dir'&&!entry.isDirectory)return;
  if(!matcher.test(entry.name))return;
  if(entries.length>=limit){hitLimit=true;return 'stop';}
  const info=await lstat(entry.path).catch(()=>null);
  entries.push({
   path:entry.path,
   relative:path.relative(root,entry.path).split(path.sep).join('/'),
   sizeBytes:entry.isDirectory?0:(info?.size??0),
   isDirectory:entry.isDirectory,
   modifiedAt:info?info.mtime.toISOString():null,
  });
 }});
 entries.sort((a,b)=>a.relative.localeCompare(b.relative));
 return {root,count:entries.length,truncated:hitLimit||stats.truncated,entries};
}

async function fileGrep(args,ctx){
 const root=await resolveDirectory(ctx.roots,optionalString(args.root,'root')??'.',{label:'root'});
 const source=requireString(args.pattern,'pattern');
 const glob=optionalString(args.glob,'glob')??'*';
 if(glob.includes('/')||glob.includes('\\'))throw fail(`glob must match file names, not paths, so it cannot contain a path separator (got ${JSON.stringify(glob)}). Pass a name wildcard such as "*.js" and choose the directory with root, then retry.`,'args/invalid');
 const ignoreCase=optionalBoolean(args.ignoreCase,'ignoreCase');
 let expression;
 try{expression=new RegExp(source,ignoreCase?'gi':'g');}
 catch(error){throw fail(`pattern is not a valid JavaScript regular expression: ${error.message}. Nothing was searched; escape ( ) [ ] { } . * + ? ^ $ | with a backslash or simplify the pattern, then retry.`,'args/invalid');}
 const maxResults=optionalInteger(args.maxResults,'maxResults',{min:1,max:GREP_MAX_RESULTS,fallback:50});
 const contextLines=optionalInteger(args.contextLines,'contextLines',{min:0,max:GREP_MAX_CONTEXT,fallback:0});
 const maxFileBytes=optionalInteger(args.maxFileBytes,'maxFileBytes',{min:1,max:GREP_MAX_FILE_BYTES,fallback:2*1024*1024});
 const fileMatcher=globToRegExp(glob,'glob');
 const matches=[];
 let filesScanned=0;
 let hitLimit=false;
 const stats=await walkTree(root,{maxDepth:FIND_MAX_DEPTH,onEntry:async entry=>{
  if(entry.isDirectory)return;
  if(!fileMatcher.test(entry.name))return;
  let info;
  try{info=await lstat(entry.path);}catch{return;}
  if(!info.isFile()||info.size===0||info.size>maxFileBytes)return;
  let text;
  try{text=await readFile(entry.path,'utf8');}catch{return;}
  if(text.includes('\u0000'))return;
  filesScanned++;
  const lines=text.split('\n').map(line=>line.endsWith('\r')?line.slice(0,-1):line);
  for(let index=0;index<lines.length;index++){
   const line=lines[index];
   expression.lastIndex=0;
   let found;
   while((found=expression.exec(line))!==null){
    if(found[0].length===0){expression.lastIndex=found.index+1;continue;}
    if(matches.length>=maxResults){hitLimit=true;return 'stop';}
    matches.push({
     path:entry.path,
     line:index+1,
     column:found.index+1,
     text:truncateText(line,GREP_MAX_LINE_CHARS),
     before:lines.slice(Math.max(0,index-contextLines),index),
     after:lines.slice(index+1,index+1+contextLines),
    });
   }
  }
 }});
 return {root,pattern:source,filesScanned,matches,truncated:hitLimit||stats.truncated};
}

const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const pathProperty=(description)=>({type:'string',description});

export const meta={
 name:'files',
 title:'Files and archives',
 version:'2.1.0',
 description:'Existence, metadata, hashing, line-range reads, exact edits, deletion, directory creation, name and content search, move/copy/append/truncate and tar.gz archive creation and extraction inside the allowed roots. Failures carry a code such as args/invalid, path/outside-roots, path/not-found, path/not-a-file, path/not-a-directory, file/not-text, file/too-large, exec/unavailable or sandbox/denied.',
};

export const tools=[
 {
  name:'file_exists',
  description:'Use this when you only need to know whether a path exists inside an allowed root, what kind of node it is and how big it is, without reading the contents. Parameter: path (string, required) is absolute or relative to an allowed root, must stay inside the allowed roots, and may not exist yet. Returns {path: absolute resolved path, exists: boolean, type: "file"|"directory"|"symlink"|"other"|null, bytes: number, mtime: ISO-8601 string|null, linkTarget: string|null, realPath: string|null, targetExists: boolean|null}; a missing path is a normal answer with exists:false, type:null, not an error. Failures: "args/invalid" (path missing or not a string), "path/outside-roots" (resolves outside every allowed root), "tool/internal" (unexpected filesystem error).',
  inputSchema:object({path:pathProperty('Path to probe, absolute or relative to an allowed root; must stay inside the allowed roots and may not exist yet.')},['path']),
  run:guard(fileExists),
 },
 {
  name:'file_move',
  description:'Use this to rename or relocate a file or directory inside the allowed roots without rewriting its contents (a cross-device move falls back to copy plus delete). Parameters: from (string, required) is the existing source inside an allowed root; to (string, required) is the destination inside an allowed root and its parent directory must already exist, and when to is an existing directory the source basename is appended; overwrite (boolean, default false) must be true to replace an existing destination, and a destination directory is removed recursively when true. Returns {from, to: absolute paths, moved: true, type: source node type, overwritten: boolean, bytes: source size}. Failures: "args/invalid" (same path, directory moved into itself, destination exists without overwrite), "path/outside-roots", "path/not-found" (source or destination parent missing), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   from:pathProperty('Existing source path inside an allowed root.'),
   to:pathProperty('Destination path inside an allowed root; its parent directory must exist.'),
   overwrite:{type:'boolean',description:'Replace an existing destination when true. Defaults to false, which fails with args/invalid instead of overwriting.'},
  },['from','to']),
  run:guard(fileMove),
 },
 {
  name:'file_copy',
  description:'Use this to duplicate a file or a whole directory tree inside the allowed roots, preserving timestamps, when the source must stay in place. Parameters: from (string, required) is the existing source inside an allowed root and must not be a symlink; to (string, required) is the destination inside an allowed root whose parent directory exists, and when to is an existing directory the source basename is appended; overwrite (boolean, default false) must be true to replace an existing destination. Returns {from, to: absolute paths, copied: true, type: source node type, overwritten: boolean, bytes: copied size or null for directories}. Failures: "args/invalid" (symlink source, same path, directory copied into itself, destination exists without overwrite), "path/outside-roots", "path/not-found", "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   from:pathProperty('Existing source path inside an allowed root; must not be a symbolic link.'),
   to:pathProperty('Destination path inside an allowed root; its parent directory must exist.'),
   overwrite:{type:'boolean',description:'Replace an existing destination when true. Defaults to false, which fails with args/invalid instead of overwriting.'},
  },['from','to']),
  run:guard(fileCopy),
 },
 {
  name:'file_info',
  description:'Use this when you need real metadata for one existing path: permissions, timestamps, link count, ownership, symlink target and directory entry count. Parameter: path (string, required) must be an existing node inside an allowed root. Returns {path, realPath, type: "file"|"directory"|"symlink"|"other", bytes: number, mode: octal string such as "0o755", isSymlink: boolean, linkTarget: string|null, createdAt/modifiedAt/accessedAt/changedAt: ISO-8601 strings or null, links: hard link count, ownerUid/ownerGid: number|null, entries: number|null (directories only)}. Failures: "args/invalid", "path/outside-roots", "path/not-found" (nothing at that path), "tool/internal".',
  inputSchema:object({path:pathProperty('Existing path inside an allowed root; must stay inside the allowed roots.')},['path']),
  run:guard(fileInfo),
 },
 {
  name:'file_hash',
  description:'Use this to verify integrity, compare two copies or record a checksum of a regular file without loading it into memory; the file is streamed once through the hash. Parameters: path (string, required) is a regular file inside an allowed root; algorithm is one of "sha256" (default, use for integrity), "sha512", "sha384", "sha1" (legacy compatibility only), "md5" (legacy compatibility only, not collision resistant). Returns {path: absolute resolved path, algorithm, hash: lowercase hex digest, bytes: number of bytes hashed}. Failures: "args/invalid" (algorithm outside the enum), "path/outside-roots", "path/not-found", "path/not-a-file" (the path is a directory or another non-regular node), "tool/internal".',
  inputSchema:object({
   path:pathProperty('Regular file inside an allowed root.'),
   algorithm:{type:'string',enum:['sha256','sha512','sha384','sha1','md5'],description:'Hash algorithm. "sha256" (default) is the safe choice for integrity checks; "sha1" and "md5" exist only to match legacy peers and are not collision resistant.'},
  },['path']),
  run:guard(fileHash),
 },
 {
  name:'file_append',
  description:'Use this to add UTF-8 text to the end of an existing file, or to create it when missing, without rewriting the current contents (for example log lines or generated data). Parameters: path (string, required) is the target inside an allowed root and its parent directory must exist; content (string, required) is the exact UTF-8 text to append, capped at 2097152 bytes per call. Returns {path: absolute path, appendedBytes: number, created: boolean (true when the file did not exist), previousSize: bytes before the call, size: bytes after the call}. Failures: "args/invalid" (content missing or not a string), "file/too-large" (content above 2097152 bytes: split it into several calls), "path/outside-roots", "path/not-found" (parent directory missing), "path/not-a-file" (path is a directory), "sandbox/denied" in a read-only session. Note: appended text is not newline-terminated automatically. A UTF-8 byte-order mark is not added, so the encoding is always plain UTF-8.',
  inputSchema:object({
   path:pathProperty('Target file inside an allowed root; its parent directory must exist.'),
   content:{type:'string',description:'UTF-8 text to append verbatim. Maximum 2097152 bytes per call; no newline is added automatically.'},
  },['path','content']),
  run:guard(fileAppend),
 },
 {
  name:'archive_create',
  description:'Use this to pack files or directories from inside the allowed roots into one gzip-compressed tar archive, for backup or transfer, using the system tar binary spawned without a shell. Parameters: output (string, required) is the archive file to write and its parent directory must exist; paths (array of strings, default ["."], at most 5000 items) lists the files or directories to archive, each must resolve inside base; base (string, default ".") is the directory that archive entries are relative to; format is "tar.gz" (default) or "tgz" (the same format under an alias). zip, 7z and plain tar are refused on purpose. Returns {archive: absolute path, format: "tar.gz", bytes: archive size, base, entries: relative entry names, excludedOutput: the output file excluded from itself or null, implementation: "system tar (child_process, shell:false)"}. Failures: "args/invalid" (format not tar.gz/tgz, more than 5000 paths, output equal to base), "path/outside-roots" (an entry resolves outside base), "path/not-found" (base or output parent missing), "exec/unavailable" (no tar binary, or tar failed or timed out), "sandbox/denied" in a read-only session.',
  inputSchema:object({
   output:pathProperty('Archive file to write (tar.gz); its parent directory must exist.'),
   paths:{type:'array',items:{type:'string'},minItems:1,maxItems:5000,description:'Files or directories to archive, relative to an allowed root and inside base. Defaults to ["."] (the whole base directory).'},
   base:pathProperty('Directory the archive entries are relative to; defaults to "." (the first allowed root).'),
   format:{type:'string',enum:['tar.gz','tgz'],description:'Archive format. "tar.gz" is the real format; "tgz" is accepted as an alias for the same gzip-compressed tar. zip and 7z are rejected.'},
  },['output']),
  run:guard(archiveCreate),
 },
 {
  name:'archive_extract',
  description:'Use this to unpack a tar.gz archive into a directory inside the allowed roots after listing it and refusing absolute or parent-escaping entries. Parameters: archive (string, required) is an existing tar.gz inside an allowed root; destination (string, default ".") is the directory to extract into and is created when missing. Returns {archive, destination: absolute paths, entries: number of archived entries, files: number of regular files, directories: number of directories, listing: the first 500 entry names, truncatedListing: boolean}. The archive is listed first, so a corrupt or unsafe archive fails before anything is written. Failures: "args/invalid" (archive lists zero entries, or more than 5000 entries), "path/outside-roots" (an entry name is absolute or contains ..), "path/not-found" (archive missing), "exec/unavailable" (no tar binary, or tar failed or timed out), "sandbox/denied" in a read-only session.',
  inputSchema:object({
   archive:pathProperty('Existing tar.gz archive inside an allowed root.'),
   destination:pathProperty('Directory to extract into; defaults to "." and is created when missing.'),
  },['archive']),
  run:guard(archiveExtract),
 },
 {
  name:'file_truncate',
  description:'Use this to cut a regular file to an exact byte size inside the allowed roots (size 0 empties it), for example to drop a partially written tail. Parameters: path (string, required) is a regular file inside an allowed root; size (integer, minimum 0, maximum 9007199254740991, default 0) is the target size in bytes; allowExtend (boolean, default false) must be true to grow a file, because padding with zero bytes destroys nothing but surprises callers. Returns {path, previousSize: bytes before, size: bytes after, shrunk: boolean}. Failures: "args/invalid" (size not an integer in range, or larger than the current size without allowExtend), "path/outside-roots", "path/not-found", "path/not-a-file", "sandbox/denied" in a read-only session.',
  inputSchema:object({
   path:pathProperty('Regular file inside an allowed root.'),
   size:{type:'integer',minimum:0,maximum:9007199254740991,description:'Target size in bytes. Defaults to 0 (empty the file); 0 to 9007199254740991 (2^53-1) is accepted.'},
   allowExtend:{type:'boolean',description:'Allow growing the file by padding with zero bytes. Defaults to false, which fails with args/invalid when size is larger than the current size.'},
  },['path']),
  run:guard(fileTruncate),
 },
 {
  name:'file_read_range',
  description:'Use this when a file is too large to read whole, or when you only need a known window of it: it reads an inclusive 1-based line range and also reports the total line count so the next window can be planned. It never modifies the file and works in a read-only sandbox. Parameters: path (string, required) is an existing regular text file inside an allowed root; startLine (integer, 1 to 100000000, default 1) is the first line returned; endLine (integer, 1 to 100000000, default startLine+500) is the last line returned and is inclusive, must not be below startLine, and one call may span at most 5000 lines; maxBytes (integer, 1 to 2097152, default 262144) caps the returned content in UTF-8 bytes. Returns {path, totalLines, startLine, endLine, truncated, content}: totalLines counts every line of the whole file (a trailing newline does not add an empty line, CRLF is normalised), content joins the selected lines with a newline, and truncated is true when lines remain after endLine or maxBytes cut the content. Failures: "args/invalid" (startLine/endLine/maxBytes not integers in range, endLine below startLine, range wider than 5000 lines, or startLine past totalLines), "path/outside-roots", "path/not-found", "path/not-a-file", "file/not-text" (the file contains NUL bytes, so it is binary), "tool/internal".',
  inputSchema:object({
   path:pathProperty('Existing regular text file inside an allowed root; must stay inside the allowed roots.'),
   startLine:{type:'integer',minimum:1,maximum:100000000,description:'First line returned, 1-based. Defaults to 1.'},
   endLine:{type:'integer',minimum:1,maximum:100000000,description:'Last line returned, inclusive. Defaults to startLine+500; one call may span at most 5000 lines.'},
   maxBytes:{type:'integer',minimum:1,maximum:2097152,description:'Maximum UTF-8 bytes of returned content. Defaults to 262144; 2097152 is the hard ceiling.'},
  },['path']),
  run:guard(fileReadRange),
 },
 {
  name:'file_edit',
  description:'Use this to change one existing text file by replacing an exact string; it is the server-side entry point for edits, while whole-file rewrites use file_write. The match is always literal, never a regular expression. Parameters: path (string, required) is an existing regular text file inside an allowed root; old (string, required, nonempty) is the exact text to find, so include the full line or unique surroundings to anchor it; new (string, required, may be empty) replaces old verbatim, and an empty string deletes the matched text; replaceAll (boolean, default false) replaces every match instead of exactly one; expectedCount (integer, 1 to 1000000, optional) is the match count you expect, and the write is refused when the real count differs. Returns {path, replacements: number of matches replaced, bytesBefore: file size before, bytesAfter: file size after}. Every failure leaves the file untouched. Failures: "args/invalid" (old empty or not a string, new not a string, old matches 0 times so the file was not modified, expectedCount differs from the real count, more than one match with replaceAll false - add context or pass replaceAll:true), "path/outside-roots", "path/not-found", "path/not-a-file", "file/not-text" (binary file), "file/too-large" (above 33554432 bytes), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   path:pathProperty('Existing regular text file inside an allowed root.'),
   old:{type:'string',minLength:1,description:'Exact literal text to find. Never treated as a regular expression.'},
   new:{type:'string',description:'Exact literal replacement text. An empty string deletes the matched text.'},
   replaceAll:{type:'boolean',description:'Replace every match when true. Defaults to false, which fails with args/invalid when more than one match exists.'},
   expectedCount:{type:'integer',minimum:1,maximum:1000000,description:'Optional expected match count; the write is refused when the real count differs.'},
  },['path','old','new']),
  run:guard(fileEdit),
 },
 {
  name:'file_delete',
  description:'Use this to remove one file, one empty directory or, with recursive true, a whole directory tree inside the allowed roots; an allowed root itself is refused. Parameters: path (string, required) is an existing file, directory or symlink inside an allowed root; recursive (boolean, default false) must be true to delete a directory that still has entries, otherwise the call fails and nothing is deleted. Returns {path, deleted: true, kind: "file"|"directory"|"symlink"}. Failures: "args/invalid" (non-empty directory without recursive, or the path is an allowed root), "path/outside-roots", "path/not-found" (nothing exists at that path), "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   path:pathProperty('Existing file, directory or symlink inside an allowed root.'),
   recursive:{type:'boolean',description:'Delete a non-empty directory and its contents when true. Defaults to false, which fails with args/invalid on a non-empty directory.'},
  },['path']),
  run:guard(fileDelete),
 },
 {
  name:'file_mkdir',
  description:'Use this to create a directory, including any missing parents, so a later write, copy or extract has somewhere to land; it is idempotent. Parameters: path (string, required) is the directory to create, absolute inside an allowed root or relative to one, and missing parents are created; mode (octal string such as "0755" or "755", optional) is the permission to use, applied on POSIX hosts and ignored on Windows, and a JSON number is rejected because a leading zero cannot be expressed. Returns {path, created}: created is false when the directory already existed (not an error) and true when this call made it. Failures: "args/invalid" (mode not 3 or 4 octal digits), "path/not-a-directory" (something that is not a directory already occupies the path), "path/outside-roots", "sandbox/denied" in a read-only session, "tool/internal".',
  inputSchema:object({
   path:pathProperty('Directory to create inside an allowed root; missing parents are created too.'),
   mode:{type:'string',pattern:'^0?[0-7]{3,4}$',description:'Optional octal permission string such as "0755"; applied on POSIX hosts, ignored on Windows.'},
  },['path']),
  run:guard(fileMkdir),
 },
 {
  name:'file_find',
  description:'Use this to locate files or directories by name without reading their contents; file_grep searches contents and file_read_range reads a found file. The walk starts at root and visits entries in lexicographic order. Parameters: root (string, default ".") is an existing directory inside an allowed root; pattern (string, required) is a wildcard over entry names where * matches any run of characters and ? matches exactly one, it is not a regular expression and must not contain a path separator, so "*.ts" is valid and "src/*.ts" is not; maxDepth (integer, 1 to 32, default 8) is how many directory levels below root are visited; type ("file"|"dir"|"any", default "any") filters by entry kind; limit (integer, 1 to 2000, default 200) caps returned entries; includeHidden (boolean, default false) includes dot entries, while heavy directories such as .git, node_modules and dist are always skipped. Returns {root, count, truncated, entries:[{path: absolute path, relative: path from root with forward slashes, sizeBytes: 0 for directories, isDirectory: boolean, modifiedAt: ISO-8601 string|null}]}, where truncated is true when limit, maxDepth or the walk ceiling cut the result short. Failures: "args/invalid" (pattern missing or containing a separator, maxDepth/limit/type outside the documented range or enum), "path/outside-roots", "path/not-found" (root missing), "path/not-a-file" (root is not a directory), "tool/internal".',
  inputSchema:object({
   root:pathProperty('Existing directory inside an allowed root where the walk starts; defaults to "." (the first allowed root).'),
   pattern:{type:'string',minLength:1,description:'Wildcard over entry names: * matches any run of characters, ? matches one character. No path separators; use "*.ts", not "src/*.ts".'},
   maxDepth:{type:'integer',minimum:1,maximum:32,description:'Directory levels below root to visit. Defaults to 8; 32 is the ceiling.'},
   type:{type:'string',enum:['file','dir','any'],description:'Entry kind to report. Defaults to "any".'},
   limit:{type:'integer',minimum:1,maximum:2000,description:'Maximum entries returned. Defaults to 200; 2000 is the ceiling.'},
   includeHidden:{type:'boolean',description:'Include dot files and dot directories when true. Defaults to false.'},
  },['pattern']),
  run:guard(fileFind),
 },
 {
  name:'file_grep',
  description:'Use this to search file contents by regular expression with optional context lines, instead of reading every candidate file; file_find matches names and file_read_range reads the hits in full. Parameters: root (string, default ".") is an existing directory inside an allowed root; pattern (string, required) is a JavaScript regular expression matched against each line, and an invalid expression fails before any file is read; glob (string, default "*") filters which file names are read, using * and ? wildcards and no path separators; ignoreCase (boolean, default false) matches case-insensitively; maxResults (integer, 1 to 500, default 50) caps returned matches; contextLines (integer, 0 to 5, default 0) adds that many lines before and after each hit; maxFileBytes (integer, 1 to 16777216, default 2097152) skips larger files. Returns {root, pattern: the regular expression used, filesScanned: number of files actually read, matches:[{path: absolute path, line: 1-based line number, column: 1-based column of the match start, text: the matching line cut to 2000 characters, before: context lines above, after: context lines below}], truncated: true when maxResults or the walk ceiling stopped the scan early}. Heavy directories such as .git and node_modules, binary files (NUL bytes) and files above maxFileBytes are skipped without counting as scanned. Failures: "args/invalid" (pattern missing or not a valid regular expression, glob containing a separator, numbers outside their ranges), "path/outside-roots", "path/not-found" (root missing), "path/not-a-file" (root is not a directory), "tool/internal".',
  inputSchema:object({
   root:pathProperty('Existing directory inside an allowed root where the walk starts; defaults to "." (the first allowed root).'),
   pattern:{type:'string',minLength:1,description:'JavaScript regular expression matched against each line; an invalid expression fails with args/invalid.'},
   glob:{type:'string',minLength:1,description:'Wildcard that filters which file names are read, using * and ?. Defaults to "*" (every file).'},
   ignoreCase:{type:'boolean',description:'Match case-insensitively when true. Defaults to false.'},
   maxResults:{type:'integer',minimum:1,maximum:500,description:'Maximum matches returned. Defaults to 50; 500 is the ceiling.'},
   contextLines:{type:'integer',minimum:0,maximum:5,description:'Lines of context before and after each match. Defaults to 0; 5 is the ceiling.'},
   maxFileBytes:{type:'integer',minimum:1,maximum:16777216,description:'Skip files larger than this many bytes. Defaults to 2097152.'},
  },['pattern']),
  run:guard(fileGrep),
 },
];
