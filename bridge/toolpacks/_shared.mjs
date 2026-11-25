// Shared helpers for the builtin MCP toolpacks.
// This file is NOT a pack: the host only imports directories that contain index.mjs,
// so `_shared.mjs` is never loaded as a toolpack. User packs must be self-contained
// (a single directory with an index.mjs) and cannot import this file.
import {spawn} from 'node:child_process';
import {mkdir, readdir, readFile, realpath, rename, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
 '.git','.hg','.svn','node_modules','__pycache__','.venv','venv','.idea','.gradle',
 '.dart_tool','.cache','.next','dist','build','target','coverage','.mypy_cache','.pytest_cache',
]);

const fail=(message,code)=>Object.assign(Error(message),code?{code}:{});

export function insidePath(candidate,root){
 const relative=path.relative(root,candidate);
 return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));
}

export function requireString(value,label){
 if(typeof value!=='string'||!value.trim())throw fail(`${label} must be a nonempty string`);
 return value;
}

export function optionalString(value,label){
 if(value===undefined||value===null||value==='')return undefined;
 if(typeof value!=='string'||!value.trim())throw fail(`${label} must be a nonempty string`);
 return value;
}

export function optionalInteger(value,label,{min=Number.MIN_SAFE_INTEGER,max=Number.MAX_SAFE_INTEGER,fallback}={}){
 if(value===undefined||value===null)return fallback;
 if(!Number.isSafeInteger(value)||value<min||value>max)throw fail(`${label} must be an integer between ${min} and ${max}`);
 return value;
}

export function optionalBoolean(value,label){
 if(value===undefined||value===null)return false;
 if(typeof value!=='boolean')throw fail(`${label} must be a boolean`);
 return value;
}

export function requireStringArray(value,label){
 if(!Array.isArray(value)||value.length===0||value.some(item=>typeof item!=='string'||!item.trim()))throw fail(`${label} must be a nonempty string array`);
 return value;
}

// Resolve `input` against the allowed roots and prove (through realpath) that the
// result stays inside the root. Existing symlinks cannot smuggle a path outside.
export async function resolvePath(roots,input,{parent=false,label='path'}={}){
 const outside=()=>fail(`Path is outside the allowed roots: ${String(input)}`,'toolpack/outside-roots');
 requireString(input,label);
 for(const root of roots){
  const candidate=path.resolve(root,input);
  if(!insidePath(candidate,root))continue;
  const check=parent?path.dirname(candidate):candidate;
  let actual;
  try{actual=await realpath(check);}
  catch(error){
   if(error.code==='ENOENT')throw fail(parent?`Parent directory does not exist: ${path.dirname(candidate)}`:`Path does not exist: ${candidate}`);
   throw error;
  }
  if(!insidePath(actual,root))throw outside();
  return candidate;
 }
 throw outside();
}

export async function resolveDirectory(roots,input,options={}){
 const target=await resolvePath(roots,input,options);
 const info=await stat(target);
 if(!info.isDirectory())throw fail(`Not a directory: ${target}`);
 return target;
}

// Lexical guard for paths that may not exist yet (file_exists, move/copy
// destinations). The deepest existing ancestor is still resolved through realpath,
// so a symlinked directory cannot smuggle a new file outside an allowed root.
export async function resolveLoosePath(roots,input,{label='path'}={}){
 requireString(input,label);
 const outside=()=>fail(`Path is outside the allowed roots: ${String(input)}`,'toolpack/outside-roots');
 for(const root of roots){
  const candidate=path.resolve(root,input);
  if(!insidePath(candidate,root))continue;
  let probe=candidate;
  while(true){
   let actual;
   try{actual=await realpath(probe);}
   catch(error){
    if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;
    const parent=path.dirname(probe);
    if(parent===probe)break;
    probe=parent;
    continue;
   }
   if(!insidePath(actual,root))throw outside();
   return candidate;
  }
  throw outside();
 }
 throw outside();
}

// If `target` already exists, prove through realpath that it is inside a root.
// Returns the real path, or null when the path does not exist yet.
export async function assertExistingInside(roots,target){
 const actual=await realpath(target).catch(error=>{
  if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;
  throw error;
 });
 if(actual&&!roots.some(root=>insidePath(actual,root)))throw fail(`Path is outside the allowed roots: ${target}`,'toolpack/outside-roots');
 return actual;
}

// Directory for durable pack state (`ctx.dataDir/<name>`).
export function dataPath(ctx,name){return path.join(ctx.dataDir,name);}

// Read a JSON store object; a missing file yields `{}`. Corrupt JSON is reported,
// never silently replaced, so a broken state file cannot quietly lose user data.
export async function readJsonStore(ctx,name){
 const target=dataPath(ctx,name);
 let raw;
 try{raw=await readFile(target,'utf8');}
 catch(error){
  if(error.code==='ENOENT')return {};
  throw error;
 }
 let value;
 try{value=JSON.parse(raw);}
 catch(error){throw fail(`${target} does not contain valid JSON: ${error.message}`,'toolpack/store-corrupt');}
 return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
}

// Atomic JSON write (temp file + rename) with 0600 permissions under 0700 dirs.
export async function writeJsonStore(ctx,name,value){
 await mkdir(ctx.dataDir,{recursive:true,mode:0o700});
 const target=dataPath(ctx,name);
 const temporary=`${target}.${process.pid}.${Date.now()}.tmp`;
 await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 await rename(temporary,target);
 return target;
}

// Serialize async mutations so concurrent tool calls cannot lose writes.
export function serializeTasks(){
 let chain=Promise.resolve();
 return task=>{
  const next=chain.then(task,task);
  chain=next.then(()=>undefined,()=>undefined);
  return next;
 };
}

// Spawn without a shell and capture bounded stdout/stderr.
export function runProcess(argv,{cwd,timeoutMs=60000,maxBytes=1024*1024,env}={}){
 return new Promise((resolve,reject)=>{
  if(!Array.isArray(argv)||argv.length===0||argv.some(item=>typeof item!=='string'||!item))return reject(fail('argv must be a nonempty string array'));
  let child;
  try{
   child=spawn(argv[0],argv.slice(1),{cwd,env:env??process.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  }catch(error){return reject(error);}
  let stdout='',stderr='',timedOut=false;
  let stdoutBytes=0,stderrBytes=0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdoutBytes+=Buffer.byteLength(chunk);if(stdout.length<maxBytes)stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);if(stderr.length<maxBytes)stderr+=chunk;});
  const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',(code,signal)=>{
   clearTimeout(timer);
   const truncated=stdoutBytes>maxBytes||stderrBytes>maxBytes;
   if(timedOut)return reject(fail(`Command timed out after ${timeoutMs}ms: ${argv.join(' ')}`,'toolpack/timeout'));
   resolve({argv,cwd:cwd??process.cwd(),exitCode:code,signal,stdout,stderr,truncated});
  });
 });
}

export async function runOrThrow(argv,options={}){
 const result=await runProcess(argv,options);
 if(result.exitCode!==0){
  const detail=(result.stderr||result.stdout||'').trim().slice(0,2000)||'no output';
  const error=fail(`${argv.slice(0,3).join(' ')} exited with ${result.exitCode??result.signal}: ${detail}`,'toolpack/command-failed');
  error.details=result;
  throw error;
 }
 return result;
}

// Deterministic recursive file walk with caps. `onEntry` may return true to stop early.
export async function walkFiles(root,{maxEntries=50000,ignore=[],onEntry}={}){
 const ignored=new Set([...DEFAULT_IGNORED_DIRECTORIES,...ignore]);
 const stats={files:0,directories:0,entries:0,skipped:0,truncated:false};
 const stack=[root];
 while(stack.length){
  const directory=stack.pop();
  let entries;
  try{entries=await readdir(directory,{withFileTypes:true});}
  catch{stats.skipped++;continue;}
  stats.directories++;
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){
   stats.entries++;
   if(stats.entries>maxEntries){stats.truncated=true;return stats;}
   if(entry.isSymbolicLink()){stats.skipped++;continue;}
   const full=path.join(directory,entry.name);
   if(entry.isDirectory()){
    if(ignored.has(entry.name)){stats.skipped++;continue;}
    stack.push(full);
    continue;
   }
   if(!entry.isFile())continue;
   stats.files++;
   if(onEntry&&await onEntry(full,entry.name)===true)return stats;
  }
 }
 return stats;
}

export function truncateText(value,max){const text=String(value??'');return text.length>max?text.slice(0,max):text;}

// ---------------------------------------------------------------------------
// Bridge access. The bridge writes ${CODEX_HOME}/codex-go-bridge.json once it is
// listening; MCP child processes read that handshake to call authenticated APIs.
// ---------------------------------------------------------------------------

export function requireBridge(ctx,feature){
 if(ctx.bridge)return ctx.bridge;
 const where=ctx.bridgeFile??'${CODEX_HOME}/codex-go-bridge.json';
 throw fail(`${feature} requires the running Codex Pocket bridge. Start the bridge first: it writes the handshake file ${where}, which this MCP process reads to authenticate. No bridge handshake was found, so the call was not attempted.`,'toolpack/bridge-unavailable');
}

export async function bridgeRequest(bridge,endpoint,body,{timeoutMs=120000,method='POST'}={}){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const headers={authorization:`Bearer ${bridge.token}`,accept:'application/json'};
  const options={method,headers,signal:controller.signal};
  if(method!=='GET'&&method!=='HEAD'){
   headers['content-type']='application/json';
   options.body=JSON.stringify(body??{});
  }
  const response=await fetch(`${bridge.baseUrl}/api/${endpoint}`,options);
  const raw=await response.text();
  let value={};
  try{value=raw?JSON.parse(raw):{};}catch{value={raw:raw.slice(0,4000)};}
  if(!response.ok){
   const error=fail(value?.error?.message||`Bridge ${endpoint} failed with HTTP ${response.status}`,value?.error?.code??'bridge/error');
   error.details=value?.error?.details??{status:response.status};
   throw error;
  }
  return value;
 }catch(error){
  if(error.name==='AbortError')throw fail(`Bridge ${endpoint} timed out after ${timeoutMs}ms`,'bridge/timeout');
  throw error;
 }finally{clearTimeout(timer);}
}

// Async iterator over the bridge SSE stream. Yields parsed JSON events.
export async function* bridgeEvents(bridge,{threadId,signal}={}){
 const url=new URL(`${bridge.baseUrl}/api/events`);
 url.searchParams.set('token',bridge.token);
 url.searchParams.set('after','0');
 if(threadId)url.searchParams.set('threadId',threadId);
 const response=await fetch(url,{headers:{accept:'text/event-stream'},signal});
 if(!response.ok||!response.body)throw fail(`Bridge event stream failed with HTTP ${response.status}`,'bridge/sse-failed');
 const reader=response.body.getReader();
 const decoder=new TextDecoder();
 let buffer='';
 try{
  while(true){
   const chunk=await reader.read();
   if(chunk.done)return;
   buffer+=decoder.decode(chunk.value,{stream:true});
   let boundary;
   while((boundary=buffer.indexOf('\n\n'))>=0){
    const block=buffer.slice(0,boundary);
    buffer=buffer.slice(boundary+2);
    for(const line of block.split('\n')){
     if(!line.startsWith('data: '))continue;
     const payload=line.slice(6);
     try{yield JSON.parse(payload);}catch{/* keepalive or partial frame */ }
    }
   }
  }
 }finally{
  try{await reader.cancel();}catch{/* stream already closed */}
 }
}
