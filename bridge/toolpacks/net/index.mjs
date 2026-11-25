// net: real HTTP(S) requests and downloads, a process-local cookie jar, DuckDuckGo
// HTML search (web + news verticals), Crossref and the GitHub REST API.
// Nothing here fabricates a result: when a network call fails the tool throws a
// readable error with an `area/kebab-case` code, and when a search page cannot be
// parsed the result list is empty with an explicit note instead of invented links.
//
// 约定（宿主会再包一层 {ok:true,data:...}，所以这里只返回业务数据，不自己包 ok）：
// - 只允许 http/https；重定向跟随；默认带 user-agent: codex_cli_rs/0.170.0；
// - 错误码见每个工具 description 的 "Failures" 段。
import {createWriteStream} from 'node:fs';
import {rm,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {assertExistingInside,resolvePath} from '../_shared.mjs';

// 出站身份：与 bridge（server.mjs / compat-proxy.mjs 的 CLI_UA）保持一致，
// 因为多数中转站按 User-Agent 白名单放行编程客户端。
const USER_AGENT='codex_cli_rs/0.170.0';
const MIN_TIMEOUT_MS=1000;
const DEFAULT_TIMEOUT_MS=20000;
const MAX_TIMEOUT_MS=120000;
const MAX_RESPONSE_BYTES=2*1024*1024;
const MAX_DOWNLOAD_BYTES=200*1024*1024;
const MAX_GITHUB_BYTES=1024*1024;
const HTTP_METHODS=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
const GITHUB_METHODS=['GET','POST','PATCH','PUT','DELETE'];
const SEARCH_BASE=()=> (process.env.CODEX_GO_SEARCH_BASE||'https://html.duckduckgo.com').replace(/\/+$/,'');
const CROSSREF_BASE=()=> (process.env.CODEX_GO_CROSSREF_BASE||'https://api.crossref.org').replace(/\/+$/,'');
const GITHUB_BASE=()=> (process.env.CODEX_GO_GITHUB_BASE||'https://api.github.com').replace(/\/+$/,'');
const MAX_COOKIES=200;

// ---------------------------------------------------------------------------
// 参数校验：所有失败都带 args/invalid，消息说明“哪个参数错了 + 期望什么”
// ---------------------------------------------------------------------------
const fail=(message,code)=>Object.assign(new Error(message),{code});
const invalid=message=>fail(message,'args/invalid');

function requireString(value,label){
 if(typeof value!=='string'||!value.trim())throw invalid(`${label} is required and must be a nonempty string`);
 return value.trim();
}

function optionalString(value,label){
 if(value===undefined||value===null||value==='')return undefined;
 if(typeof value!=='string'||!value.trim())throw invalid(`${label} must be a nonempty string when provided`);
 return value.trim();
}

function optionalInteger(value,label,{min,max,fallback}){
 if(value===undefined||value===null)return fallback;
 if(!Number.isSafeInteger(value))throw invalid(`${label} must be an integer between ${min} and ${max}`);
 if(value<min||value>max)throw invalid(`${label} must be between ${min} and ${max} (got ${value})`);
 return value;
}

function optionalBoolean(value,label){
 if(value===undefined||value===null)return false;
 if(typeof value!=='boolean')throw invalid(`${label} must be a boolean (true or false)`);
 return value;
}

// _shared 的路径助手只保证越界错误带 toolpack/outside-roots；其余消息在这里补码。
function withCode(error,code){
 if(error&&typeof error==='object'&&!error.code)error.code=code;
 return error;
}

// ---------------------------------------------------------------------------
// URL / header plumbing
// ---------------------------------------------------------------------------
function parseUrl(input,{label='url'}={}){
 const raw=requireString(input,label);
 let url;
 try{url=new URL(raw);}
 catch{
  throw invalid(`${label} is not a valid absolute URL: ${raw}. Pass a full URL such as https://example.com/path`);
 }
 if(url.protocol!=='http:'&&url.protocol!=='https:'){
  throw fail(`Only http and https URLs are accepted, got ${url.protocol} for ${raw}. file:, data:, ftp: and other schemes are rejected on purpose; read local files with file_read instead.`,'net/blocked-scheme');
 }
 return url;
}

function normalizeHeaders(input){
 if(input===undefined||input===null)return {};
 if(typeof input!=='object'||Array.isArray(input))throw invalid('headers must be an object mapping header names to string values');
 const headers={};
 for(const [name,value] of Object.entries(input)){
  if(typeof value!=='string')throw invalid(`Header ${name} must have a string value`);
  if(!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name))throw invalid(`Invalid header name: ${name}. Header names may only use letters, digits and !#$%&'*+.^_\`|~-`);
  if(/[\r\n]/.test(value))throw invalid(`Header ${name} must not contain CR or LF characters`);
  headers[name]=value;
 }
 return headers;
}

function timeoutOf(args){
 return optionalInteger(args.timeoutMs,'timeoutMs',{min:MIN_TIMEOUT_MS,max:MAX_TIMEOUT_MS,fallback:DEFAULT_TIMEOUT_MS});
}

function hasHeader(headers,name){
 const wanted=name.toLowerCase();
 return Object.keys(headers).some(key=>key.toLowerCase()===wanted);
}

// 统一发给模型的网络失败：超时 vs 不可达，都要说清下一步怎么办。
async function fetchWithTimeout(url,options,timeoutMs,{what='request'}={}){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  return await fetch(url,{...options,signal:controller.signal});
 }catch(error){
  if(error?.name==='AbortError'){
   throw fail(`${what} timed out after ${timeoutMs} ms for ${url.toString()}. Raise timeoutMs (maximum 120000) or check that the endpoint responds.`,'net/timeout');
  }
  throw fail(`${what} could not reach ${url.toString()}: ${error.message}. Check the URL, DNS, TLS and proxy settings of the host.`,'net/unreachable');
 }finally{clearTimeout(timer);}
}

async function readCapped(response,maxBytes,{what='request'}={}){
 if(!response.body)return {buffer:Buffer.alloc(0),bytes:0,truncated:false};
 const chunks=[];
 let bytes=0,truncated=false;
 const reader=response.body.getReader();
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   if(bytes+value.byteLength>maxBytes){
    chunks.push(Buffer.from(value.subarray(0,maxBytes-bytes)));
    bytes=maxBytes;
    truncated=true;
    await reader.cancel().catch(()=>{});
    break;
   }
   chunks.push(Buffer.from(value));
   bytes+=value.byteLength;
  }
 }catch(error){
  throw fail(`${what} read ${bytes} bytes of the response body and then failed: ${error.message}. Retry, or lower maxBytes so the read finishes earlier.`,'net/unreachable');
 }
 return {buffer:Buffer.concat(chunks),bytes,truncated};
}

// ---------------------------------------------------------------------------
// Process-local cookie jar (DuckDuckGo/GitHub style Set-Cookie capture)
// ---------------------------------------------------------------------------
const jars=new Map();
let cookiesStored=0;

function jarFor(host){
 let jar=jars.get(host);
 if(!jar){jar=new Map();jars.set(host,jar);}
 return jar;
}

function captureCookies(url,headers){
 let list=[];
 try{list=headers.getSetCookie?.()??[];}
 catch{list=[];}
 if(!list.length){
  const single=headers.get('set-cookie');
  if(single)list=[single];
 }
 for(const raw of list){
  if(cookiesStored>=MAX_COOKIES)break;
  const [pair,...attributes]=String(raw).split(';');
  const separator=pair.indexOf('=');
  if(separator<=0)continue;
  const name=pair.slice(0,separator).trim();
  const value=pair.slice(separator+1).trim();
  if(!name)continue;
  let expires=null;
  for(const attribute of attributes){
   const [key,attrValue]=attribute.split('=');
   if(/^\s*expires\s*$/i.test(key??''))expires=attrValue?.trim()??null;
  }
  jarFor(url.host).set(name,{name,value,host:url.host,path:url.pathname,expires,storedAt:new Date().toISOString()});
  cookiesStored++;
 }
}

function cookieHeaderFor(url){
 const jar=jars.get(url.host);
 if(!jar||!jar.size)return null;
 return [...jar.values()].map(cookie=>`${cookie.name}=${cookie.value}`).join('; ');
}

function cookieStoreList(args){
 const host=optionalString(args.host,'host');
 const cookies=[];
 for(const [entryHost,jar] of jars){
  if(host&&entryHost!==host)continue;
  for(const cookie of jar.values())cookies.push({...cookie,value:cookie.value.length>120?cookie.value.slice(0,120)+'…':cookie.value});
 }
 if(args.clear===true){jars.clear();cookiesStored=0;}
 return {
  host:host??null,
  hosts:[...jars.keys()].sort(),
  count:cookies.length,
  limit:MAX_COOKIES,
  cleared:args.clear===true,
  cookies:cookies.sort((left,right)=>left.host.localeCompare(right.host)||left.name.localeCompare(right.name)),
  note:'Cookies captured from Set-Cookie headers in this MCP process; they are not written to disk.',
 };
}

// ---------------------------------------------------------------------------
// Generic HTTP
// ---------------------------------------------------------------------------
async function httpRequest(args){
 const url=parseUrl(args.url);
 const method=optionalString(args.method,'method')?.toUpperCase()??'GET';
 if(!HTTP_METHODS.includes(method)){
  throw invalid(`Unsupported HTTP method: ${method}. Use one of ${HTTP_METHODS.join(', ')} (default GET)`);
 }
 const headers=normalizeHeaders(args.headers);
 if(args.body!==undefined&&typeof args.body!=='string')throw invalid('body must be a string; serialize JSON yourself and set a content-type header');
 if(args.body!==undefined&&['GET','HEAD'].includes(method))throw invalid(`${method} requests cannot carry a body; use POST, PUT, PATCH or DELETE`);
 const timeoutMs=timeoutOf(args);
 const maxBytes=optionalInteger(args.maxBytes,'maxBytes',{min:1024,max:MAX_RESPONSE_BYTES,fallback:MAX_RESPONSE_BYTES});
 if(!hasHeader(headers,'user-agent'))headers['user-agent']=USER_AGENT;
 if(!hasHeader(headers,'cookie')){
  const cookie=cookieHeaderFor(url);
  if(cookie)headers.cookie=cookie;
 }
 const response=await fetchWithTimeout(url,{method,headers,redirect:'follow',body:args.body},timeoutMs,{what:'http_request'});
 captureCookies(url,response.headers);
 const {buffer,bytes,truncated}=await readCapped(response,maxBytes,{what:'http_request'});
 return {
  url:url.toString(),
  finalUrl:response.url||url.toString(),
  method,
  status:response.status,
  statusText:response.statusText,
  ok:response.ok,
  contentType:response.headers.get('content-type'),
  bytes,
  truncated,
  maxBytes,
  timeoutMs,
  headers:Object.fromEntries(response.headers.entries()),
  text:buffer.toString('utf8'),
 };
}

// ---------------------------------------------------------------------------
// 只读沙箱判定（只影响会落盘的工具；纯读的 HTTP 工具在只读下照常可用）。
// 宿主 mcp-server.mjs 从 ${CODEX_HOME}/config.toml 的 sandbox_mode 读同一份事实，
// 这里用同一来源判断，另外接受 ctx / 环境变量 / Node 权限模型显式声明的模式。
// ---------------------------------------------------------------------------
const READ_ONLY_MODES=new Set(['read-only','readonly','read_only','ro','r/o']);
const TRUTHY=new Set(['1','true','yes','on']);

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
 const permission=process.permission;
 if(permission&&typeof permission.has==='function'){
  try{
   if(permission.has('fs.write')===false&&permission.has('child')===false)return true;
  }catch{/* 该作用域不受支持，交给 config.toml 判断 */}
 }
 const mode=await readCodexSandboxMode();
 return mode!==null&&READ_ONLY_MODES.has(mode.toLowerCase());
}

const WRITE_DENIED_CODES=new Set(['EACCES','EPERM','EROFS','EISDIR']);

function mapDestinationError(error,{path:target}){
 if(WRITE_DENIED_CODES.has(error?.code)){
  return fail(`Cannot write ${target}: the filesystem or sandbox denied the write (${error.code}). This tool cannot create files in a read-only sandbox; use http_request to read small bodies into the reply instead, or ask the user to allow writes.`,'sandbox/denied');
 }
 if(error?.code==='ENOSPC')return fail(`Cannot write ${target}: the disk is full (ENOSPC). Free space or choose another destination.`,'net/too-large');
 return fail(`Writing ${target} failed: ${error.message}. Check the destination path and permissions.`,'net/unreachable');
}

async function httpDownload(args,ctx){
 const url=parseUrl(args.url);
 let target;
 try{
  target=await resolvePath(ctx.roots,args.path,{parent:true,label:'path'});
  await assertExistingInside(ctx.roots,target);
 }catch(error){throw withCode(error,'args/invalid');}
 if(await isReadOnlySandbox(ctx)){
  throw fail(`http_download cannot save to ${target}: the runtime sandbox is read-only (sandbox_mode="read-only"), so writing files is not allowed. Nothing was downloaded. Use http_request to read a small body into the reply, or ask the user to switch the sandbox to workspace-write.`,'sandbox/denied');
 }
 const overwrite=optionalBoolean(args.overwrite,'overwrite');
 const timeoutMs=timeoutOf(args);
 const maxBytes=optionalInteger(args.maxBytes,'maxBytes',{min:1024,max:MAX_DOWNLOAD_BYTES,fallback:MAX_DOWNLOAD_BYTES});
 if(!overwrite){
  const existing=await stat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing)throw fail(`Destination already exists: ${target}. Pass overwrite:true to replace it, or choose another path.`,'net/destination-exists');
 }
 const headers=normalizeHeaders(args.headers);
 if(!hasHeader(headers,'user-agent'))headers['user-agent']=USER_AGENT;
 if(!hasHeader(headers,'cookie')){
  const cookie=cookieHeaderFor(url);
  if(cookie)headers.cookie=cookie;
 }
 const response=await fetchWithTimeout(url,{method:'GET',headers,redirect:'follow'},timeoutMs,{what:'http_download'});
 captureCookies(url,response.headers);
 if(!response.ok||!response.body){
  throw fail(`http_download failed: ${url.toString()} returned HTTP ${response.status} ${response.statusText}. Only 2xx responses are saved; check the URL or use http_request to inspect the error body.`.trim(),'net/http-status');
 }
 const hash=createHash('sha256');
 let bytes=0;
 let overLimit=false;
 const meter=new Transform({
  transform(chunk,encoding,callback){
   bytes+=chunk.length;
   if(bytes>maxBytes){
    overLimit=true;
    callback(Error(`Download exceeds the ${maxBytes} byte limit`));
    return;
   }
   hash.update(chunk);
   callback(null,chunk);
  },
 });
 try{
  await pipeline(Readable.fromWeb(response.body),meter,createWriteStream(target));
 }catch(error){
  await rm(target,{force:true}).catch(()=>{});
  if(overLimit){
   throw fail(`Download exceeds the ${maxBytes} byte limit; the partial file ${target} was removed. Raise maxBytes (maximum ${MAX_DOWNLOAD_BYTES}) or download a smaller resource.`,'net/too-large');
  }
  throw mapDestinationError(error,{path:target,maxBytes});
 }
 return {
  url:url.toString(),
  finalUrl:response.url||url.toString(),
  path:target,
  status:response.status,
  contentType:response.headers.get('content-type'),
  contentLength:response.headers.get('content-length'),
  bytes,
  maxBytes,
  timeoutMs,
  sha256:hash.digest('hex'),
  overwritten:overwrite,
 };
}

// ---------------------------------------------------------------------------
// HTML helpers for the DuckDuckGo result page
// ---------------------------------------------------------------------------
function stripTags(html){
 return String(html)
  .replace(/<script[\s\S]*?<\/script>/gi,' ')
  .replace(/<style[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]*>/g,' ');
}

function decodeEntities(text){
 return String(text)
  .replace(/&#x([0-9a-f]+);/gi,(_,hex)=>String.fromCodePoint(parseInt(hex,16)))
  .replace(/&#(\d+);/g,(_,dec)=>String.fromCodePoint(Number(dec)))
  .replace(/&nbsp;/gi,' ')
  .replace(/&amp;/gi,'&')
  .replace(/&lt;/gi,'<')
  .replace(/&gt;/gi,'>')
  .replace(/&quot;/gi,'"')
  .replace(/&#39;|&apos;/gi,"'")
  .replace(/&hellip;/gi,'…')
  .replace(/&mdash;/gi,'—')
  .replace(/&ndash;/gi,'–')
  .replace(/&rsquo;/gi,'’')
  .replace(/&lsquo;/gi,'‘')
  .replace(/&ldquo;/gi,'“')
  .replace(/&rdquo;/gi,'”');
}

function cleanText(html){return decodeEntities(stripTags(html)).replace(/\s+/g,' ').trim();}

function unwrapUrl(href){
 let raw=decodeEntities(String(href??'').trim());
 if(!raw)return '';
 if(raw.startsWith('//'))raw='https:'+raw;
 const uddg=raw.match(/[?&]uddg=([^&]+)/);
 if(uddg){
  try{return decodeURIComponent(uddg[1]);}
  catch{return uddg[1];}
 }
 try{return new URL(raw).toString();}
 catch{return raw;}
}

function anchorsByClass(html,className){
 const results=[];
 const tag=/<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
 let match;
 while((match=tag.exec(html))){
  const attributes=match[1];
  const classes=(attributes.match(/class\s*=\s*["']([^"']*)["']/i)??[])[1]??'';
  if(!classes.split(/\s+/).includes(className))continue;
  const href=(attributes.match(/href\s*=\s*["']([^"']*)["']/i)??[])[1]??'';
  results.push({href,html:match[2],end:tag.lastIndex});
 }
 return results;
}

function snippetAfter(html,index){
 const window=html.slice(index,index+8000);
 const match=window.match(/class\s*=\s*["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
 return match?cleanText(match[1]):'';
}

function extractDuckDuckGoResults(html,maxResults){
 let anchors=anchorsByClass(html,'result__a');
 let mode='result__a';
 if(!anchors.length){
  // DuckDuckGo lite markup uses result-link anchors.
  anchors=anchorsByClass(html,'result-link');
  mode='result-link';
 }
 const results=[];
 const seen=new Set();
 for(const anchor of anchors){
  const url=unwrapUrl(anchor.href);
  const title=cleanText(anchor.html);
  if(!url||!title||seen.has(url))continue;
  seen.add(url);
  results.push({title,url,snippet:snippetAfter(html,anchor.end)});
  if(results.length>=maxResults)break;
 }
 return {results,mode};
}

async function duckDuckGoSearch(args,{vertical='web'}={}){
 const query=requireString(args.query,'query');
 const maxResults=optionalInteger(args.maxResults,'maxResults',{min:1,max:30,fallback:10});
 const region=optionalString(args.region,'region');
 const timeoutMs=timeoutOf(args);
 const endpoint=new URL(`${SEARCH_BASE()}/html/`);
 endpoint.searchParams.set('q',query);
 if(region)endpoint.searchParams.set('kl',region);
 if(args.safeSearch===true)endpoint.searchParams.set('kp','1');
 if(vertical==='news')endpoint.searchParams.set('iar','news');
 const what=vertical==='news'?'web_search_news':'web_search';
 const response=await fetchWithTimeout(endpoint,{
  method:'GET',
  redirect:'follow',
  headers:{
   'user-agent':USER_AGENT,
   accept:'text/html,application/xhtml+xml',
   'accept-language':'en-US,en;q=0.9',
  },
 },timeoutMs,{what});
 captureCookies(endpoint,response.headers);
 if(!response.ok){
  throw fail(`${what}: DuckDuckGo returned HTTP ${response.status} ${response.statusText} for ${endpoint.toString()}. Wait and retry, or point CODEX_GO_SEARCH_BASE at another DuckDuckGo mirror.`,'net/http-status');
 }
 const {buffer,bytes,truncated}=await readCapped(response,MAX_RESPONSE_BYTES,{what});
 const html=buffer.toString('utf8');
 const {results,mode}=extractDuckDuckGoResults(html,maxResults);
 const payload={
  engine:'duckduckgo-html',
  vertical,
  endpoint:endpoint.toString(),
  query,
  maxResults,
  status:response.status,
  resultCount:results.length,
  results,
  parserMode:mode,
  htmlBytes:bytes,
  truncated,
 };
 if(!results.length){
  payload.note='DuckDuckGo answered but no result block could be parsed. This usually means the endpoint returned an anti-bot page or changed its markup; no results are invented here.';
 }
 return payload;
}

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------
function crossrefItem(item){
 const authors=Array.isArray(item.author)?item.author.map(author=>[author.given,author.family].filter(Boolean).join(' ')||author.name||null).filter(Boolean):[];
 const date=(item.issued??item.published??{})['date-parts']?.[0]??[];
 return {
  doi:item.DOI??null,
  title:(item.title??[])[0]??null,
  authors,
  container:(item['container-title']??[])[0]??null,
  publisher:item.publisher??null,
  type:item.type??null,
  year:date[0]??null,
  issued:date.join('-')||null,
  url:item.URL??null,
  citations:item['is-referenced-by-count']??null,
  references:item['references-count']??null,
  abstract:item.abstract?cleanText(item.abstract).slice(0,600):null,
 };
}

async function crossrefSearch(args){
 const doi=optionalString(args.doi,'doi');
 const query=optionalString(args.query,'query');
 const author=optionalString(args.author,'author');
 const title=optionalString(args.title,'title');
 const issn=optionalString(args.issn,'issn');
 if(!doi&&!query&&!author&&!title&&!issn){
  throw invalid('Provide at least one search key: doi, query, author, title or issn');
 }
 const timeoutMs=timeoutOf(args);
 // Crossref 的 polite pool 要求在 User-Agent 里带联系方式，所以保留 mailto 后缀。
 const contact=process.env.CODEX_GO_CONTACT_EMAIL||'noreply@example.invalid';
 const headers={'user-agent':`${USER_AGENT} (mailto:${contact})`,accept:'application/json'};
 const parseJson=async(response,what)=>{
  const {buffer,truncated}=await readCapped(response,MAX_RESPONSE_BYTES,{what});
  try{return {value:JSON.parse(buffer.toString('utf8')),truncated};}
  catch{
   throw fail(`${what}: Crossref returned a body that is not JSON (Content-Type: ${response.headers.get('content-type')??'unknown'}). Retry later or verify the query parameters.`,'net/invalid-response');
  }
 };
 if(doi){
  const endpoint=new URL(`${CROSSREF_BASE()}/works/${encodeURIComponent(doi)}`);
  const response=await fetchWithTimeout(endpoint,{headers,redirect:'follow'},timeoutMs,{what:'crossref_search'});
  if(response.status===404)throw fail(`Crossref has no work with DOI ${doi}. Check the DOI spelling, or search by query/title instead.`,'net/http-status');
  if(!response.ok)throw fail(`Crossref returned HTTP ${response.status} for DOI ${doi}. Retry later or check the DOI.`,'net/http-status');
  const {value}=await parseJson(response,'crossref_search');
  return {source:'crossref',query:{doi},count:value?.message?1:0,works:value?.message?[crossrefItem(value.message)]:[]};
 }
 const rows=optionalInteger(args.rows,'rows',{min:1,max:50,fallback:5});
 const endpoint=new URL(`${CROSSREF_BASE()}/works`);
 if(query)endpoint.searchParams.set('query',query);
 if(author)endpoint.searchParams.set('query.author',author);
 if(title)endpoint.searchParams.set('query.title',title);
 if(issn)endpoint.searchParams.set('filter',`issn:${issn}`);
 endpoint.searchParams.set('rows',String(rows));
 if(args.filter)endpoint.searchParams.set('filter',String(args.filter));
 const response=await fetchWithTimeout(endpoint,{headers,redirect:'follow'},timeoutMs,{what:'crossref_search'});
 if(!response.ok){
  throw fail(`Crossref returned HTTP ${response.status} ${response.statusText} for ${endpoint.toString()}. Retry later, or narrow the query.`,'net/http-status');
 }
 const {value,truncated}=await parseJson(response,'crossref_search');
 const items=Array.isArray(value?.message?.items)?value.message.items:[];
 return {
  source:'crossref',
  query:{query:query??null,author:author??null,title:title??null,issn:issn??null,rows},
  total:value?.message?.['total-results']??null,
  count:items.length,
  truncated,
  works:items.map(crossrefItem),
 };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
function githubUrl(path,label='path'){
 const raw=typeof path==='string'?path.trim():'';
 if(!raw)throw invalid(`${label} is required, e.g. /repos/owner/name or /search/repositories?q=cli`);
 if(/^[a-z]+:\/\//i.test(raw))throw invalid(`${label} must be a GitHub API path (for example /repos/owner/name), not an absolute URL`);
 if(!raw.startsWith('/'))throw invalid(`${label} must start with "/", for example /repos/owner/name`);
 if(raw.includes('\\')||/\s/.test(raw))throw invalid(`${label} must not contain whitespace or backslashes`);
 const segments=raw.split('?')[0].split('/');
 if(segments.some(segment=>segment==='..'||segment==='.'))throw invalid(`${label} must not contain "." or ".." segments`);
 return `${GITHUB_BASE()}${raw}`;
}

async function githubApi(args){
 const endpoint=parseUrl(githubUrl(args.path),{label:'path'});
 const method=optionalString(args.method,'method')?.toUpperCase()??'GET';
 if(!GITHUB_METHODS.includes(method)){
  throw invalid(`Unsupported GitHub method: ${method}. Use one of ${GITHUB_METHODS.join(', ')} (default GET)`);
 }
 const token=args.token??process.env.CODEX_GO_GITHUB_TOKEN??process.env.GITHUB_TOKEN;
 const timeoutMs=timeoutOf(args);
 const headers={'user-agent':USER_AGENT,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'};
 if(token)headers.authorization=`Bearer ${token}`;
 let body;
 if(args.body!==undefined){
  body=typeof args.body==='string'?args.body:JSON.stringify(args.body);
  headers['content-type']='application/json';
 }else if(method!=='GET'&&method!=='DELETE'){
  throw invalid(`${method} requires a body; pass body as a JSON value or a JSON string`);
 }
 if(['GET','DELETE'].includes(method)&&body!==undefined)throw invalid(`${method} does not accept a body`);
 const response=await fetchWithTimeout(endpoint,{method,headers,redirect:'follow',body},timeoutMs,{what:'github_api'});
 const {buffer,bytes,truncated}=await readCapped(response,MAX_GITHUB_BYTES,{what:'github_api'});
 const text=buffer.toString('utf8');
 let data=null;
 if(text&&(response.headers.get('content-type')??'').includes('json')){
  try{data=JSON.parse(text);}
  catch{data=null;}
 }
 const rateLimit={
  limit:Number(response.headers.get('x-ratelimit-limit')??0)||null,
  remaining:Number(response.headers.get('x-ratelimit-remaining')??0)||null,
  reset:response.headers.get('x-ratelimit-reset')??null,
 };
 return {
  url:endpoint.toString(),
  method,
  status:response.status,
  ok:response.ok,
  authenticated:Boolean(token),
  rateLimit,
  bytes,
  truncated,
  data:data??null,
  text:data===null?text:undefined,
  errorMessage:response.ok?undefined:(data?.message??text.slice(0,500)),
 };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});

const urlProperty={type:'string',description:'Absolute URL; must use http or https (file:, data:, ftp: are rejected with net/blocked-scheme).'};
const timeoutProperty={type:'integer',minimum:MIN_TIMEOUT_MS,maximum:MAX_TIMEOUT_MS,description:'Abort the whole call after this many milliseconds; minimum 1000, maximum 120000, default 20000.'};
const headersProperty={type:'object',additionalProperties:{type:'string'},description:'Extra request headers as a flat object of string values, e.g. {"accept":"application/json"}. A user-agent header you set here replaces the default codex_cli_rs/0.170.0.'};

const queryProperties=()=>({
 query:{type:'string',description:'Search terms, e.g. "rust async book". Required and nonempty.'},
 maxResults:{type:'integer',minimum:1,maximum:30,description:'Maximum number of parsed results to return; minimum 1, maximum 30, default 10.'},
 region:{type:'string',description:'Optional DuckDuckGo region/locale code passed as kl, for example us-en or cn-zh. Omit for the endpoint default.'},
 safeSearch:{type:'boolean',description:'true asks DuckDuckGo for strict safe search (kp=1); default false.'},
 timeoutMs:timeoutProperty,
});

export const meta={
 name:'net',
 title:'Networking and search',
 version:'2.0.0',
 description:'Real HTTP requests and downloads, a process-local cookie jar, DuckDuckGo HTML web/news search, Crossref and the GitHub REST API.',
};

export const tools=[
 {
  name:'http_request',
  description:[
   'Use this to call any HTTP(S) API and read the response body as text: custom method, headers, optional string body.',
   'Parameters: url (required, absolute http/https), method (GET default; POST, PUT, PATCH, DELETE, HEAD, OPTIONS), headers (flat object of string values), body (string, POST/PUT/PATCH/DELETE only), timeoutMs (1000..120000, default 20000), maxBytes (1024..2097152, default 2097152).',
   'Returns {url,finalUrl,method,status,statusText,ok,contentType,bytes,truncated,maxBytes,timeoutMs,headers,text}; truncated:true means the body reached maxBytes (default 2097152 = 2 MiB) and text ends there.',
   'Network facts: only http and https are accepted; redirects are followed (finalUrl reports where the request ended); every request sends user-agent codex_cli_rs/0.170.0 unless you pass your own user-agent header; cookies previously stored for that host are attached automatically; Set-Cookie responses are captured into the process-local jar.',
   'A non-2xx status is still a successful call: ok:false plus the real body. Failures throw english messages with code args/invalid (bad url, method, headers or body), net/blocked-scheme, net/timeout, or net/unreachable (DNS/connect/TLS).',
   'Do not use this for local files (use file_read); do not use it to download big binaries (use http_download). A read-only sandbox does not block this tool: read-only means no file writes and no command execution, not no network, so GET/POST reads keep working.',
  ].join(' '),
  inputSchema:object({
   url:urlProperty,
   method:{type:'string',enum:HTTP_METHODS,description:'HTTP method; one of GET (read, no body), POST (create or submit a body), PUT (replace), PATCH (partial update), DELETE (remove), HEAD (headers only, empty body), OPTIONS (capability probe). Default GET.'},
   headers:headersProperty,
   body:{type:'string',description:'Raw request body as a string, only for POST/PUT/PATCH/DELETE. Serialize JSON yourself and set content-type if needed; GET and HEAD reject a body.'},
   timeoutMs:timeoutProperty,
   maxBytes:{type:'integer',minimum:1024,maximum:MAX_RESPONSE_BYTES,description:'Response body cap in bytes; minimum 1024, maximum 2097152 (2 MiB), default 2097152. Larger bodies are cut and flagged with truncated:true.'},
  },['url']),
  run:httpRequest,
 },
 {
  name:'http_download',
  description:[
   'Use this to save a remote file (release asset, dataset, image, model weight) into the workspace: streams the response to disk inside the allowed roots and feeds sha256 while writing.',
   'Parameters: url (required), path (required, inside an allowed root whose parent directory exists), headers (flat object of string values), overwrite (default false), maxBytes (1024..209715200, default 209715200), timeoutMs (1000..120000, default 20000).',
   'Returns {url,finalUrl,path,status,contentType,contentLength,bytes,maxBytes,timeoutMs,sha256,overwritten}; sha256 is the digest of exactly the bytes written.',
   'Network facts: http/https only (otherwise net/blocked-scheme); redirects are followed; sends user-agent codex_cli_rs/0.170.0 unless headers override it; aborts after timeoutMs (default 20000, range 1000..120000); refuses bodies above maxBytes (default and maximum 209715200 = 200 MiB).',
   'The parent directory of path must already exist and an existing file is never replaced unless overwrite:true. Failures: args/invalid, toolpack/outside-roots (destination escapes the allowed roots), net/destination-exists, net/http-status (non-2xx; nothing is saved), net/timeout, net/unreachable, net/too-large (partial file removed), sandbox/denied (read-only sandbox: refused up front before any byte is downloaded; use http_request for small bodies instead).',
  ].join(' '),
  inputSchema:object({
   url:urlProperty,
   path:{type:'string',description:'Destination file path inside an allowed root, relative or absolute; its parent directory must already exist. Existing files need overwrite:true.'},
   headers:headersProperty,
   overwrite:{type:'boolean',description:'true replaces an existing destination file; default false, which fails with net/destination-exists.'},
   maxBytes:{type:'integer',minimum:1024,maximum:MAX_DOWNLOAD_BYTES,description:'Download size cap in bytes; minimum 1024, maximum 209715200 (200 MiB), default 209715200. Exceeding it removes the partial file and fails with net/too-large.'},
   timeoutMs:timeoutProperty,
  },['url','path']),
  run:httpDownload,
 },
 {
  name:'cookie_store_list',
  description:[
   'Use this to inspect (or clear) the process-local cookie jar filled by earlier http_request, http_download, web_search and web_search_news calls from Set-Cookie headers.',
   'Returns {host,hosts,count,limit,cleared,cookies:[{name,value,host,path,expires,storedAt}]}; value is shortened to 120 characters, limit is the 200-entry cap for this MCP process.',
   'Cookies are never written to disk and vanish when this process restarts; pass host (for example 127.0.0.1:8080) to filter one origin. Failures: args/invalid when host is not a nonempty string. This tool never touches the network.',
  ].join(' '),
  inputSchema:object({
   host:{type:'string',description:'Only list cookies for this exact host[:port] key, e.g. example.com or 127.0.0.1:8080. Omit to list every host.'},
   clear:{type:'boolean',description:'true empties the whole jar after building the reply; default false.'},
  }),
  run:async args=>cookieStoreList(args??{}),
 },
 {
  name:'web_search',
  description:[
   'Use this to find web pages for a query through the DuckDuckGo HTML endpoint and get real, parsed results (title, url, snippet) - nothing is invented.',
   'Parameters: query (required, nonempty), maxResults (1..30, default 10), region (DuckDuckGo kl code such as us-en), safeSearch (default false), timeoutMs (1000..120000, default 20000).',
   'Returns {engine:"duckduckgo-html",vertical:"web",endpoint,query,maxResults,status,resultCount,results:[{title,url,snippet}],parserMode,htmlBytes,truncated}; DuckDuckGo uddg redirects are unwrapped to the real target URL. When the page cannot be parsed, resultCount is 0 and note explains why.',
   'Network facts: redirects are followed; sends user-agent codex_cli_rs/0.170.0 with accept-language en-US; response page capped at 2 MiB; aborts after timeoutMs (default 20000, range 1000..120000); http/https only, base URL defaults to https://html.duckduckgo.com and can be redirected with CODEX_GO_SEARCH_BASE.',
   'Failures throw instead of returning empty results: args/invalid (empty query or out-of-range maxResults), net/timeout, net/unreachable, net/http-status (DuckDuckGo answered non-2xx).',
   'Use web_search_news for recent news, and web_fetch on a specific URL once you picked one.',
  ].join(' '),
  inputSchema:object(queryProperties(),['query']),
  run:async args=>duckDuckGoSearch(args,{vertical:'web'}),
 },
 {
  name:'web_search_news',
  description:[
   'Use this for recent news coverage: same DuckDuckGo HTML endpoint as web_search but with the news vertical (iar=news).',
   'Parameters: query (required, nonempty), maxResults (1..30, default 10), region (DuckDuckGo kl code), safeSearch (default false), timeoutMs (1000..120000, default 20000).',
   'Returns {engine:"duckduckgo-html",vertical:"news",endpoint,query,maxResults,status,resultCount,results:[{title,url,snippet}],parserMode,htmlBytes,truncated} plus note when nothing parsed; results are real and never synthesized.',
   'Network facts: redirects followed; user-agent codex_cli_rs/0.170.0; response page capped at 2 MiB; timeoutMs default 20000 (range 1000..120000); http/https only, base URL from CODEX_GO_SEARCH_BASE.',
   'Failures: args/invalid, net/timeout, net/unreachable, net/http-status.',
  ].join(' '),
  inputSchema:object(queryProperties(),['query']),
  run:async args=>duckDuckGoSearch(args,{vertical:'news'}),
 },
 {
  name:'crossref_search',
  description:[
   'Use this for scholarly literature: look up one work by DOI, or search Crossref works by keyword, author, title or ISSN.',
   'Parameters: doi (exact DOI, returns one work), query (free text), author, title, issn, rows (1..50, default 5), filter (raw Crossref filter), timeoutMs (1000..120000, default 20000); at least one of doi, query, author, title or issn is required.',
   'Returns {source:"crossref",query,total,count,truncated,works:[{doi,title,authors,container,publisher,type,year,issued,url,citations,references,abstract}]}; by-DOI mode returns query:{doi} and either 1 work or an error.',
   'You must supply at least one of doi, query, author, title, issn. rows is 1..50 (default 5). Network facts: redirects followed; user-agent is codex_cli_rs/0.170.0 with the Crossref polite-pool mailto suffix from CODEX_GO_CONTACT_EMAIL; response capped at 2 MiB; timeoutMs default 20000 (range 1000..120000); http/https only.',
   'Failures: args/invalid (no search key or bad rows), net/timeout, net/unreachable, net/http-status (including HTTP 404 for an unknown DOI), net/invalid-response (body was not JSON).',
  ].join(' '),
  inputSchema:object({
   doi:{type:'string',description:'Exact DOI such as 10.1234/example. Takes precedence: one work is returned instead of a list search.'},
   query:{type:'string',description:'Free-text keyword query, passed as query=.'},
   author:{type:'string',description:'Author name filter, passed as query.author=.'},
   title:{type:'string',description:'Title words filter, passed as query.title=.'},
   issn:{type:'string',description:'ISSN filter, e.g. 1234-5678; combined with filter=issn:<value>.'},
   rows:{type:'integer',minimum:1,maximum:50,description:'Maximum works returned in list mode; minimum 1, maximum 50, default 5.'},
   filter:{type:'string',description:'Raw Crossref filter expression such as from-pub-date:2023-01-01,type:journal-article. Overrides the issn filter when both are given.'},
   timeoutMs:timeoutProperty,
  }),
  run:crossrefSearch,
 },
 {
  name:'github_api',
  description:[
   'Use this to read or change GitHub through its REST API: repositories, issues, pull requests, releases, search, rate limits.',
   'Parameters: path (required API path), method (GET default; POST, PATCH, PUT, DELETE), body (JSON value or JSON string), token (optional), timeoutMs (1000..120000, default 20000).',
   'Returns {url,method,status,ok,authenticated,rateLimit:{limit,remaining,reset},bytes,truncated,data,text,errorMessage}; data is the parsed JSON when the response is JSON (otherwise text holds the raw body) and errorMessage carries GitHub\'s message for non-2xx answers - a non-2xx status is not thrown so you can inspect it.',
   'path must be an API path starting with "/" (e.g. /repos/owner/name, /search/repositories?q=cli); absolute URLs are rejected. method is GET, POST, PATCH, PUT or DELETE (default GET); POST/PATCH/PUT need a body, GET/DELETE must not have one.',
   'Auth: token argument, else CODEX_GO_GITHUB_TOKEN, else GITHUB_TOKEN; without a token you get the anonymous rate limit. Network facts: redirects followed; user-agent codex_cli_rs/0.170.0 with accept application/vnd.github+json and X-GitHub-Api-Version 2022-11-28; response capped at 1 MiB; timeoutMs default 20000 (range 1000..120000); http/https only.',
   'Failures: args/invalid (bad path, unsupported method, missing or forbidden body), net/blocked-scheme, net/timeout, net/unreachable.',
  ].join(' '),
  inputSchema:object({
   path:{type:'string',description:'GitHub REST API path beginning with "/", for example /repos/owner/name or /search/repositories?q=cli. No scheme, whitespace or dot segments.'},
   method:{type:'string',enum:GITHUB_METHODS,description:'HTTP method; one of GET (read), POST (create), PATCH (partial update), PUT (replace), DELETE (remove). Default GET.'},
   body:{description:'Request body for POST/PATCH/PUT: either a JSON value (object/array/number/boolean) or an already serialized JSON string. Not allowed for GET/DELETE.'},
   token:{type:'string',description:'Optional GitHub token for this call; falls back to CODEX_GO_GITHUB_TOKEN then GITHUB_TOKEN. Never echoed back in the reply.'},
   timeoutMs:timeoutProperty,
  },['path']),
  run:githubApi,
 },
];
