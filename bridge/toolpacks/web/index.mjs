// web: fetch an HTTP(S) resource as text. No HTML stripping: callers get the raw body,
// truncated by a hard byte cap, together with the status line and response headers.
// 只读沙箱下也能用（只读 = 不写文件、不执行命令，不等于断网）；这里只读网络，不落盘。
const TIMEOUT_MS=20000;
const MAX_BYTES=1024*1024;
// 出站身份与 bridge 的 CLI_UA 一致：多数中转站/站点按 User-Agent 白名单放行编程客户端。
const USER_AGENT='codex_cli_rs/0.170.0';

const fail=(message,code)=>Object.assign(new Error(message),{code});
const invalid=message=>fail(message,'args/invalid');

function parseUrl(input){
 if(typeof input!=='string'||!input.trim())throw invalid('url is required: pass an absolute http or https URL');
 let url;
 try{url=new URL(input.trim());}
 catch{throw invalid(`url is not a valid absolute URL: ${input}. Example: https://example.com/page`);}
 if(url.protocol!=='http:'&&url.protocol!=='https:'){
  throw fail(`Only http and https URLs are accepted, got ${url.protocol}. file:, data:, ftp: and other schemes are rejected on purpose; read local files with file_read instead.`,'net/blocked-scheme');
 }
 return url;
}

function maxCharsOf(value){
 if(value===undefined||value===null)return null;
 if(!Number.isSafeInteger(value)||value<1||value>MAX_BYTES){
  throw invalid(`maxChars must be an integer between 1 and ${MAX_BYTES} (1 MiB)`);
 }
 return value;
}

async function webFetch(args){
 const url=parseUrl(args.url);
 const maxChars=maxCharsOf(args.maxChars);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
 try{
  const response=await fetch(url,{
   method:'GET',
   redirect:'follow',
   headers:{'user-agent':USER_AGENT,accept:'*/*'},
   signal:controller.signal,
  });
  const chunks=[];
  let bytes=0,truncated=false;
  if(response.body){
   const reader=response.body.getReader();
   try{
    while(true){
     const chunk=await reader.read();
     if(chunk.done)break;
     const value=chunk.value;
     if(bytes+value.byteLength>MAX_BYTES){
      chunks.push(value.subarray(0,MAX_BYTES-bytes));
      bytes=MAX_BYTES;
      truncated=true;
      await reader.cancel().catch(()=>{});
      break;
     }
     chunks.push(value);
     bytes+=value.byteLength;
    }
   }catch(error){
    throw fail(`web_fetch read ${bytes} bytes from ${url.toString()} and then failed: ${error.message}. Retry, or fetch a smaller resource.`,'net/unreachable');
   }
  }
  const buffer=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk)));
  let text=buffer.toString('utf8');
  if(maxChars!==null&&text.length>maxChars){text=text.slice(0,maxChars);truncated=true;}
  return {
   url:url.toString(),
   finalUrl:response.url||url.toString(),
   status:response.status,
   statusText:response.statusText,
   ok:response.ok,
   contentType:response.headers.get('content-type'),
   bytes,
   truncated,
   maxBytes:MAX_BYTES,
   maxChars,
   timeoutMs:TIMEOUT_MS,
   headers:Object.fromEntries(response.headers.entries()),
   text,
  };
 }catch(error){
  if(error?.code)throw error;
  if(error?.name==='AbortError'){
   throw fail(`web_fetch timed out after ${TIMEOUT_MS} ms for ${url.toString()}. The timeout is fixed at 20000 ms; use net's http_request when you need a configurable timeout.`,'net/timeout');
  }
  throw fail(`web_fetch could not reach ${url.toString()}: ${error.message}. Check the URL, DNS, TLS and proxy settings of the host.`,'net/unreachable');
 }finally{clearTimeout(timer);}
}

export const meta={
 name:'web',
 title:'Web',
 version:'1.0.0',
 description:'Fetch HTTP(S) resources as text with a hard timeout, byte cap and response metadata.',
};

export const tools=[
 {
  name:'web_fetch',
  description:[
   'Use this to read one web page or HTTP resource as raw text (HTML, JSON, XML, CSS, plain text): no HTML stripping, no rendering and no JavaScript execution, so a script-heavy page returns its bare markup.',
   'Parameters: url (required, absolute http/https) and maxChars (optional cap 1..1048576 on the decoded text length; omit to keep the whole body up to the 1 MiB byte cap).',
   'Returns {url,finalUrl,status,statusText,ok,contentType,bytes,truncated,maxBytes,maxChars,timeoutMs,headers,text}; ok means the HTTP status was 2xx, so a 404 or 500 is a successful call with ok:false and the server body in text, never a thrown error.',
   'Network facts: only http and https URLs (file:, data:, ftp: fail with net/blocked-scheme); GET only; redirects are followed and finalUrl reports the last hop; the request sends user-agent codex_cli_rs/0.170.0 and accept */*; the call aborts after 20000 ms (fixed) and the body is capped at 1048576 bytes (1 MiB).',
   'truncated:true means text was cut, either by the 1 MiB byte cap or by maxChars. text is decoded as UTF-8, so use net http_download for binaries.',
   'Failures: args/invalid (missing or unparsable url, maxChars out of range 1..1048576), net/blocked-scheme, net/timeout (20000 ms fixed), net/unreachable (DNS/connect/TLS/read failure). Works in a read-only sandbox because it only reads the network and never writes files.',
   'Use net http_request when you need another method, custom headers or a configurable timeout; use http_download to save a file; use web_search to discover URLs first.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   url:{type:'string',description:'Absolute URL to GET; must start with http:// or https:// (other schemes are rejected with net/blocked-scheme).'},
   maxChars:{type:'integer',minimum:1,maximum:MAX_BYTES,description:'Optional extra cap on the decoded text length in characters; minimum 1, maximum 1048576 (1 MiB). Omit to keep everything under the 1 MiB byte cap. Cutting the text sets truncated:true.'},
  },required:['url'],additionalProperties:false},
  run:webFetch,
 },
];
