// Codex Pocket bridge: Responses <-> upstream dialect compatibility proxy (CONTRACT-V4 B).
// Codex 0.170 only speaks the Responses API (`/responses`); a channel's `wire` says which dialect
// the upstream really speaks (openai-chat, anthropic, gemini, azure-openai, ollama, or a direct
// openai-responses endpoint that bypasses this proxy). This module translates one direction,
// listens on 127.0.0.1 only and never invents a successful answer: upstream failures are relayed
// as real HTTP errors.
import http from 'node:http';
import {randomUUID} from 'node:crypto';

export const DEFAULT_NO_DATA_TIMEOUT_MS=120000;
// 中转站普遍按 User-Agent 白名单放行（只认 codex_cli_rs/… 等编程客户端）。
export const CLI_UA='codex_cli_rs/0.170.0';
export const withCliUa=headers=>({...headers,'user-agent':headers?.['user-agent']||CLI_UA});
// 契约 A：所有请求 30s 连接超时、120s 无数据超时；响应体截断 1 MiB（模型清单）/ 2 MiB（对话）。
export const DEFAULT_CONNECT_TIMEOUT_MS=30000;
export const ANTHROPIC_VERSION='2023-06-01';
export const AZURE_API_VERSION='2024-10-21';
const MAX_BODY=8*1024*1024;
const MAX_ERROR_CHARS=300;
const MODELS_MAX_BYTES=1024*1024;
const COMPLETION_MAX_BYTES=2*1024*1024;
const ROUTE=/^\/v1\/([^/]+)\/responses\/?$/;
const SSE_HEADERS={'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-accel-buffering':'no'};

const newId=prefix=>`${prefix}_${randomUUID().replaceAll('-','')}`;
const snapshot=value=>JSON.parse(JSON.stringify(value));

// 上游错误正文只回前 300 字，避免把整页 HTML 或密钥回显给客户端。
function capMessage(value){
 const text=String(value??'').replace(/\s+/g,' ').trim();
 return text.length>MAX_ERROR_CHARS?`${text.slice(0,MAX_ERROR_CHARS)}…`:text;
}

function normalizeUpstreamBase(value){
 if(typeof value!=='string'||!value.trim())throw Error('Channel Base URL is required');
 let url;try{url=new URL(value.trim());}catch{throw Error('Channel Base URL must be absolute HTTP(S)');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Channel Base URL must be HTTP(S) without embedded credentials');
 return url.toString().replace(/\/+$/,'');
}

function sendJson(res,status,value){
 if(res.headersSent||res.writableEnded){res.end();return;}
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
 res.end(JSON.stringify(value));
}
function sendError(res,status,error){sendJson(res,status,{error});}

function serializeEvent(type,payload){return `event: ${type}\ndata: ${JSON.stringify({type,...payload})}\n\n`;}

function readBody(req){
 return new Promise((resolve,reject)=>{
  let size=0;const chunks=[];
  req.on('data',chunk=>{
   size+=chunk.length;
   if(size>MAX_BODY){reject(Object.assign(Error('Request exceeds 8 MiB'),{status:413,code:'request/too-large'}));req.destroy();return;}
   chunks.push(chunk);
  });
  req.on('end',()=>{
   const text=Buffer.concat(chunks).toString('utf8');
   if(!text.trim())return resolve({});
   let value;try{value=JSON.parse(text);}catch{return reject(Object.assign(Error('Expected a JSON object'),{status:400,code:'request/json'}));}
   if(!value||typeof value!=='object'||Array.isArray(value))return reject(Object.assign(Error('Expected a JSON object'),{status:400,code:'request/json'}));
   resolve(value);
  });
  req.on('error',reject);
 });
}

// ---- A. wire 枚举、路径与鉴权 ----
export const WIRE_NAMES=Object.freeze(['openai-chat','openai-responses','anthropic','gemini','azure-openai','ollama']);
// 兼容旧渠道文件：chat -> openai-chat，responses -> openai-responses。
const WIRE_ALIASES=Object.freeze({chat:'openai-chat',responses:'openai-responses'});
export function normalizeWire(value){
 if(typeof value!=='string')return null;
 const text=value.trim().toLowerCase();
 if(!text)return null;
 return WIRE_NAMES.includes(text)?text:WIRE_ALIASES[text]??null;
}

// 每个 wire 的上游端点、鉴权种类与流格式（契约 A 的表格）。
// `direct:true` 表示 codex 直连该地址，本代理不参与。
export const WIRE_SPECS=Object.freeze({
 'openai-chat':Object.freeze({wire:'openai-chat',listPath:'models',chatPath:'chat/completions',auth:'bearer',format:'openai',streamKind:'sse',direct:false}),
 'openai-responses':Object.freeze({wire:'openai-responses',listPath:'models',chatPath:'responses',auth:'bearer',format:'responses',streamKind:'sse',direct:true}),
 anthropic:Object.freeze({wire:'anthropic',listPath:'models',chatPath:'messages',auth:'anthropic',format:'anthropic',streamKind:'sse',direct:false}),
 gemini:Object.freeze({wire:'gemini',listPath:'models',chatPath:null,auth:'gemini',format:'gemini',streamKind:'sse',direct:false}),
 'azure-openai':Object.freeze({wire:'azure-openai',listPath:`openai/models?api-version=${AZURE_API_VERSION}`,chatPath:null,auth:'azure',format:'openai',streamKind:'sse',direct:false}),
 ollama:Object.freeze({wire:'ollama',listPath:'api/tags',chatPath:'api/chat',auth:'none',format:'ollama',streamKind:'ndjson',direct:false}),
});

export function wireSpec(wire){return WIRE_SPECS[wire]??null;}
export function requiresApiKey(wire){return wire!=='ollama';}

// base 已经包含版本段（如 /v1、/v1beta、/openai），代理只在它后面接相对路径；
// 若 base 末尾与相对路径首段重名（/v1 + v1/chat/completions），只保留一段，绝不拼出 /v1/v1。
export function joinUpstreamUrl(baseUrl,relative){
 const url=new URL(normalizeUpstreamBase(baseUrl));
 const [rawPath='',rawQuery='']=String(relative).split('?');
 const baseSegments=url.pathname.split('/').filter(Boolean);
 const segments=rawPath.split('/').filter(Boolean);
 while(segments.length&&baseSegments.length&&segments[0].toLowerCase()===baseSegments.at(-1).toLowerCase())segments.shift();
 const pathname=`/${[...baseSegments,...segments].join('/')}`;
 const search=rawQuery?`?${rawQuery}`:'';
 return {url:`${url.origin}${pathname}${search}`,pathname,search,origin:url.origin};
}

export function wireAuthHeaders(wire,apiKey){
 const headers={};
 switch(wire){
  case 'anthropic':
   if(apiKey)headers['x-api-key']=apiKey;
   headers['anthropic-version']=ANTHROPIC_VERSION;
   break;
  case 'gemini':
   if(apiKey)headers['x-goog-api-key']=apiKey;
   break;
  case 'azure-openai':
   if(apiKey)headers['api-key']=apiKey;
   break;
  case 'ollama':
   break;
  default:
   if(apiKey)headers.authorization=`Bearer ${apiKey}`;
 }
 return headers;
}

// 模型清单：GET {base}/models（gemini/ollama 见契约表格），解析成 [{id,ownedBy}]。
export function buildListRequest({wire,baseUrl,apiKey}){
 const spec=wireSpec(wire);
 if(!spec)throw Object.assign(Error(`Unsupported wire: ${wire}`),{status:400,code:'channel/wire'});
 const target=joinUpstreamUrl(baseUrl,spec.listPath);
 return {wire,url:target.url,pathname:target.pathname,headers:{accept:'application/json',...wireAuthHeaders(wire,apiKey)},maxBytes:MODELS_MAX_BYTES};
}

function modelIdFromEntry(entry){
 const raw=typeof entry==='string'?entry
  :typeof entry?.id==='string'?entry.id
  :typeof entry?.model==='string'?entry.model
  :typeof entry?.name==='string'?entry.name
  :null;
 if(typeof raw!=='string')return null;
 const trimmed=raw.trim().replace(/^models\//i,''); // gemini 的 models/<id>
 return trimmed||null;
}

export function parseWireModels(wire,payload){
 const spec=wireSpec(wire);
 if(!spec)throw Object.assign(Error(`Unsupported wire: ${wire}`),{status:400,code:'channel/wire'});
 const entries=Array.isArray(payload)?payload
  :Array.isArray(payload?.data)?payload.data
  :Array.isArray(payload?.models)?payload.models
  :null;
 if(!entries)throw Object.assign(Error('Expected a model list in data or models'),{status:502,code:'provider/models-invalid'});
 const seen=new Set(),models=[];
 for(const entry of entries){
  const id=modelIdFromEntry(entry);
  if(!id||seen.has(id))continue;
  seen.add(id);
  const owner=entry&&typeof entry==='object'?(entry.owned_by??entry.ownedBy):null;
  models.push({id,ownedBy:typeof owner==='string'?owner:null});
 }
 return models;
}

async function readCappedText(stream,maxBytes,code){
 const reader=stream?.body?.getReader();
 if(!reader)return '';
 const decoder=new TextDecoder();
 const chunks=[];let size=0;
 while(true){
  const {done,value}=await reader.read();
  if(done)break;
  size+=value?.byteLength??0;
  if(size>maxBytes){
   await reader.cancel().catch(()=>{});
   throw Object.assign(Error(`Upstream response exceeds ${maxBytes} bytes`),{status:502,...(code?{code}:{})});
  }
  chunks.push(Buffer.from(value));
 }
 return Buffer.concat(chunks).toString('utf8');
}

export async function fetchWireModels({wire,baseUrl,apiKey,timeoutMs=10000,maxBytes=MODELS_MAX_BYTES}){
 const request=buildListRequest({wire,baseUrl,apiKey});
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 let response;
 try{response=await fetch(request.url,{method:'GET',headers:withCliUa(request.headers),signal:controller.signal});}
 catch(error){
  clearTimeout(timer);
  const timeout=error?.name==='TimeoutError'||error?.name==='AbortError';
  throw Object.assign(Error(timeout?`Provider did not answer within ${timeoutMs}ms`:`Could not reach provider: ${error?.message??'network error'}`),{status:502,code:'provider/models-unreachable',details:{baseUrl,timeout}});
 }
 try{
  if(!response.ok){
   const raw=await response.text().catch(()=> '');
   throw Object.assign(Error(`Provider responded ${response.status}: ${capMessage(raw)}`),{status:502,code:'provider/models-fetch',details:{status:response.status,baseUrl}});
  }
  const text=await readCappedText(response,maxBytes,'provider/models-too-large');
  let payload;
  try{payload=JSON.parse(text);}
  catch{throw Object.assign(Error('Provider returned a non-JSON model list'),{status:502,code:'provider/models-invalid',details:{baseUrl}});}
  const models=parseWireModels(wire,payload);
  return {wire,baseUrl,url:request.url,models,count:models.length};
 }catch(error){
  if(!error.code)throw Object.assign(error,{status:502,code:'provider/models-invalid',details:{baseUrl}});
  throw error;
 }finally{
  clearTimeout(timer);
 }
}

// 探活用的极小非流式请求（契约 C 的 infer 阶段：max_tokens/num_predict 1，prompt "ping"）。
export function buildProbeRequest({wire,baseUrl,apiKey,model}){
 const spec=wireSpec(wire);
 if(!spec)throw Object.assign(Error(`Unsupported wire: ${wire}`),{status:400,code:'channel/wire'});
 if(typeof model!=='string'||!model.trim())throw Object.assign(Error('model is required'),{status:400,code:'channel/model'});
 const requested=model.trim();
 const resolved=requested.replace(/^models\//i,'');
 const base=normalizeUpstreamBase(baseUrl);
 const headers={'content-type':'application/json',accept:'application/json',...wireAuthHeaders(wire,apiKey)};
 switch(wire){
  case 'openai-chat':
   return {wire,url:joinUpstreamUrl(base,spec.chatPath).url,headers,body:{model:requested,messages:[{role:'user',content:'ping'}],max_tokens:1,stream:false}};
  case 'openai-responses':
   return {wire,url:joinUpstreamUrl(base,'responses').url,headers,body:{model:requested,input:'ping',max_output_tokens:1,stream:false}};
  case 'azure-openai':
   return {wire,url:joinUpstreamUrl(base,`openai/deployments/${encodeURIComponent(resolved)}/chat/completions?api-version=${AZURE_API_VERSION}`).url,headers,body:{messages:[{role:'user',content:'ping'}],max_tokens:1,stream:false}};
  case 'anthropic':
   return {wire,url:joinUpstreamUrl(base,spec.chatPath).url,headers,body:{model:requested,max_tokens:1,messages:[{role:'user',content:'ping'}],stream:false}};
  case 'gemini':
   return {wire,url:joinUpstreamUrl(base,`models/${geminiModelPath(resolved)}:generateContent`).url,headers,body:{contents:[{role:'user',parts:[{text:'ping'}]}],generationConfig:{maxOutputTokens:1}}};
  case 'ollama':
   return {wire,url:joinUpstreamUrl(base,spec.chatPath).url,headers,body:{model:requested,messages:[{role:'user',content:'ping'}],stream:false,options:{num_predict:1}}};
  default:
   throw Object.assign(Error(`Unsupported wire: ${wire}`),{status:400,code:'channel/wire'});
 }
}

// ---- B. 请求转换：Responses -> 各家请求体 ----

function contentParts(item){
 if(Array.isArray(item.content))return item.content;
 if(typeof item.content==='string')return [{type:'input_text',text:item.content}];
 return [];
}

function stringifyToolOutput(output){
 if(typeof output==='string')return output;
 if(Array.isArray(output))return output.map(part=>typeof part==='string'?part:typeof part?.text==='string'?part.text:JSON.stringify(part)).join('\n');
 if(output===undefined||output===null)return '';
 return JSON.stringify(output);
}

function inputItems(body){
 const input=typeof body.input==='string'
  ?[{type:'message',role:'user',content:[{type:'input_text',text:body.input}]}]
  :Array.isArray(body.input)?body.input:[];
 return input.filter(item=>item&&typeof item==='object');
}

function itemType(item){return typeof item.type==='string'?item.type:item.role?'message':null;}
function isSystemRole(role){return role==='system'||role==='developer';}

function callIdOf(item){
 if(typeof item.call_id==='string'&&item.call_id)return item.call_id;
 if(typeof item.id==='string'&&item.id)return item.id;
 return newId('call');
}
function callNameOf(item){
 if(typeof item.name==='string')return item.name;
 if(typeof item.function?.name==='string')return item.function.name;
 return '';
}
function callArgumentsOf(item){
 if(typeof item.arguments==='string')return item.arguments;
 if(typeof item.function?.arguments==='string')return item.function.arguments;
 return JSON.stringify(item.arguments??item.function?.arguments??{});
}
function parseJsonObject(text){
 if(!text||typeof text!=='string')return {};
 try{const value=JSON.parse(text);return value&&typeof value==='object'?value:{};}catch{return {};}
}
function imageUrlsOf(part){
 const urls=[];
 if(part?.type!=='input_image')return urls;
 if(typeof part.image_url==='string'&&part.image_url)urls.push(part.image_url);
 else if(typeof part.image_url?.url==='string'&&part.image_url.url)urls.push(part.image_url.url);
 return urls;
}
function imageUrlsOfItem(item){
 const urls=[];
 for(const part of contentParts(item))urls.push(...imageUrlsOf(part));
 return urls;
}
function parseDataUrl(url){
 const match=/^data:([^;,]+);base64,(.*)$/i.exec(String(url));
 return match?{mediaType:match[1],data:match[2]}:null;
}

// 顶层 system：instructions 加上 input 里的 system/developer 消息（anthropic/gemini 需要）。
function systemText(body){
 const texts=[];
 if(typeof body.instructions==='string'&&body.instructions.trim())texts.push(body.instructions.trim());
 for(const item of inputItems(body)){
  if(itemType(item)!=='message'||!isSystemRole(item.role))continue;
  for(const part of contentParts(item)){
   if(typeof part?.text==='string'&&part.text)texts.push(part.text);
  }
 }
 return texts.join('\n\n');
}

function chatToolCall(item){
 const name=callNameOf(item);
 const args=callArgumentsOf(item);
 return {id:callIdOf(item),type:'function',function:{name,arguments:args}};
}

function pushToolCall(messages,call){
 const last=messages.at(-1);
 if(last&&last.role==='assistant'){last.tool_calls=last.tool_calls??[];last.tool_calls.push(call);if(last.content===undefined)last.content=null;return;}
 messages.push({role:'assistant',content:null,tool_calls:[call]});
}

function toChatMessages(body){
 const messages=[];
 if(typeof body.instructions==='string'&&body.instructions.trim())messages.push({role:'system',content:body.instructions.trim()});
 for(const item of inputItems(body)){
  const type=itemType(item);
  if(type==='message'){
   const role=item.role==='assistant'?'assistant':isSystemRole(item.role)?'system':'user';
   const texts=[],images=[],toolCalls=[];
   for(const part of contentParts(item)){
    if(!part||typeof part!=='object')continue;
    if(part.type==='function_call'||part.type==='tool_call'){toolCalls.push(chatToolCall(part));continue;}
    if(part.type==='input_image'){images.push(...imageUrlsOf(part));continue;}
    if(typeof part.text==='string'&&part.text)texts.push(part.text);
   }
   if(toolCalls.length)for(const call of toolCalls)pushToolCall(messages,call);
   if(images.length){
    // 带图时改用 OpenAI 视觉消息数组，纯文本仍保持字符串（中继站兼容性更好）。
    messages.push({role,content:[...texts.map(text=>({type:'text',text})),...images.map(url=>({type:'image_url',image_url:{url}}))]});
   }else{
    const text=texts.join('\n');
    if(text)messages.push({role,content:text});
    else if(role==='assistant'&&!toolCalls.length)messages.push({role,content:''});
   }
  }else if(type==='function_call'||type==='tool_call'){
   pushToolCall(messages,chatToolCall(item));
  }else if(type==='function_call_output'||type==='tool_result'){
   messages.push({role:'tool',tool_call_id:callIdOf(item),content:stringifyToolOutput(item.output)});
  }
  // reasoning / web_search_call and other non-chat items have no chat representation.
 }
 return messages;
}

// codex 0.170 把**整个 MCP 服务器**聚合成一个 `type:'namespace'` 工具发下来，
// 里面的 `tools` 才是真正的 function 工具（名字就是 MCP 原名）。chat / anthropic / gemini
// 三种 wire 都没有 namespace 这个概念，旧实现只认 `type:'function'`，于是把整个服务器
// 连同它的 100+ 个工具一起丢掉了——手机上的模型因此一个 MCP 工具都看不到。
// 这里统一摊平：namespace → 它的每一个子工具，名字保持不变（codex 按名字回派）。
function flattenTools(tools){
 if(!Array.isArray(tools))return [];
 const flat=[];
 const walk=(list,namespace=null)=>{
  for(const tool of list){
   if(!tool||typeof tool!=='object')continue;
   if(tool.type==='namespace'&&Array.isArray(tool.tools)){
    walk(tool.tools,typeof tool.name==='string'?tool.name:namespace);
    continue;
   }
   flat.push(namespace?{...tool,__codexNamespace:namespace}:tool);
  }
 };
 walk(tools);
 return flat;
}

// 同名工具若来自不同 namespace，chat wire 必须给它们不同的本地别名；
// 返回 Responses 时再按这张表恢复原名和 namespace，不能让 codex 猜分隔符。
function aliasedToolName(tool,used){
 const original=toolFunctionOf(tool)?.name??'';
 const namespace=tool.__codexNamespace??null;
 const owner=used.get(original);
 if(owner===undefined){used.set(original,namespace);return original;}
 if(owner===namespace)return original;
 const base=`${String(namespace??'tool').replace(/^mcp__/,'').replace(/[^a-zA-Z0-9_]/g,'_')}__${original}`;
 let alias=base,index=2;
 while(used.has(alias)&&used.get(alias)!==namespace)alias=`${base}_${index++}`;
 used.set(alias,namespace);
 return alias;
}

function namespaceCallMap(tools){
 const flat=flattenTools(tools),used=new Map(),calls=new Map();
 for(const tool of flat){
  if(tool.type!=='function')continue;
  const fn=toolFunctionOf(tool);if(!fn)continue;
  const alias=aliasedToolName(tool,used);
  const namespace=tool.__codexNamespace??null;
  if(namespace)calls.set(alias,{namespace,name:fn.name});
 }
 return calls;
}

function toolFunctionOf(tool){
 const fn=tool.function&&typeof tool.function==='object'?tool.function:tool;
 const name=typeof fn.name==='string'?fn.name:'';
 if(!name)return null;
 return {
  name,
  description:typeof fn.description==='string'?fn.description:'',
  parameters:fn.parameters&&typeof fn.parameters==='object'?fn.parameters:{type:'object',properties:{}},
  ...(typeof fn.strict==='boolean'?{strict:fn.strict}:{}),
 };
}

function toChatTools(tools){
 const flat=flattenTools(tools);
 if(!flat.length)return undefined;
 const mapped=[],seen=new Map();
 for(const tool of flat){
  if(tool.type!=='function')continue;
  const fn=toolFunctionOf(tool);if(!fn)continue;
  const alias=aliasedToolName(tool,seen);
  if(mapped.some(item=>item.function.name===alias))continue;
  mapped.push({type:'function',function:{...fn,name:alias}});
 }
 return mapped.length?mapped:undefined;
}

function toChatToolChoice(choice){
 if(choice===undefined||choice===null)return undefined;
 if(typeof choice==='string')return ['auto','none','required'].includes(choice)?choice:undefined;
 if(typeof choice==='object'){
  const name=typeof choice.name==='string'?choice.name:typeof choice.function?.name==='string'?choice.function.name:'';
  if(choice.type==='function'&&name)return {type:'function',function:{name}};
 }
 return undefined;
}

function resolveModel(body,fallbackModel){
 const model=typeof body.model==='string'&&body.model.trim()?body.model.trim():typeof fallbackModel==='string'&&fallbackModel.trim()?fallbackModel.trim():'';
 if(!model)throw Object.assign(Error('model is required'),{status:400,code:'channel/model'});
 return model;
}

export function toChatRequest(body,fallbackModel){
 const model=resolveModel(body,fallbackModel);
 const messages=toChatMessages(body);
 if(!messages.length)throw Object.assign(Error('input must contain at least one message'),{status:400,code:'request/input'});
 const request={model,messages,stream:true};
 const tools=toChatTools(body.tools);
 if(tools)request.tools=tools;
 const toolChoice=toChatToolChoice(body.tool_choice);
 if(toolChoice!==undefined)request.tool_choice=toolChoice;
 if(typeof body.max_output_tokens==='number'&&body.max_output_tokens>0)request.max_tokens=body.max_output_tokens;
 if(typeof body.temperature==='number')request.temperature=body.temperature;
 if(typeof body.top_p==='number')request.top_p=body.top_p;
 // Reasoning effort and Responses-only fields are intentionally dropped: relays reject them.
 return request;
}

function toOllamaRequest(body,fallbackModel){
 const model=resolveModel(body,fallbackModel);
 const messages=toChatMessages(body);
 if(!messages.length)throw Object.assign(Error('input must contain at least one message'),{status:400,code:'request/input'});
 const request={model,messages,stream:true};
 const tools=toChatTools(body.tools);
 if(tools)request.tools=tools;
 const options={};
 if(typeof body.max_output_tokens==='number'&&body.max_output_tokens>0)options.num_predict=body.max_output_tokens;
 if(typeof body.temperature==='number')options.temperature=body.temperature;
 if(typeof body.top_p==='number')options.top_p=body.top_p;
 if(Object.keys(options).length)request.options=options;
 return request;
}

function anthropicImage(url){
 const data=parseDataUrl(url);
 if(data)return {type:'image',source:{type:'base64',media_type:data.mediaType,data:data.data}};
 return {type:'image',source:{type:'url',url:String(url)}};
}

function toAnthropicMessages(body){
 const messages=[];
 const push=(role,blocks)=>{
  if(!blocks.length)return;
  const last=messages.at(-1);
  if(last&&last.role===role)last.content.push(...blocks);
  else messages.push({role,content:blocks});
 };
 for(const item of inputItems(body)){
  const type=itemType(item);
  if(type==='message'){
   if(isSystemRole(item.role))continue; // system 走顶层 system 字段
   const role=item.role==='assistant'?'assistant':'user';
   const blocks=[];
   for(const part of contentParts(item)){
    if(!part||typeof part!=='object')continue;
    if(part.type==='function_call'||part.type==='tool_call'){
     blocks.push({type:'tool_use',id:callIdOf(part),name:callNameOf(part),input:parseJsonObject(callArgumentsOf(part))});
     continue;
    }
    if(part.type==='input_image'){for(const url of imageUrlsOf(part))blocks.push(anthropicImage(url));continue;}
    if(typeof part.text==='string'&&part.text)blocks.push({type:'text',text:part.text});
   }
   push(role,blocks);
  }else if(type==='function_call'||type==='tool_call'){
   push('assistant',[{type:'tool_use',id:callIdOf(item),name:callNameOf(item),input:parseJsonObject(callArgumentsOf(item))}]);
  }else if(type==='function_call_output'||type==='tool_result'){
   push('user',[{type:'tool_result',tool_use_id:callIdOf(item),content:stringifyToolOutput(item.output)}]);
  }
 }
 return messages;
}

function toAnthropicTools(tools){
 const flat=flattenTools(tools);
 if(!flat.length)return undefined;
 const mapped=[],seen=new Map();
 for(const tool of flat){
  if(tool.type!=='function')continue;
  const fn=toolFunctionOf(tool);if(!fn)continue;
  const name=aliasedToolName(tool,seen);
  if(mapped.some(item=>item.name===name))continue;
  mapped.push({name,description:typeof fn.description==='string'?fn.description:'',
   input_schema:fn.parameters&&typeof fn.parameters==='object'?fn.parameters:{type:'object',properties:{}}});
 }
 return mapped.length?mapped:undefined;
}

function toAnthropicToolChoice(choice){
 if(choice===undefined||choice===null)return undefined;
 if(choice==='auto')return {type:'auto'};
 if(choice==='required')return {type:'any'};
 if(choice==='none')return undefined;
 if(typeof choice==='object'){
  const name=typeof choice.name==='string'?choice.name:typeof choice.function?.name==='string'?choice.function.name:'';
  if(name)return {type:'tool',name};
 }
 return undefined;
}

function toAnthropicRequest(body,fallbackModel){
 const model=resolveModel(body,fallbackModel);
 const messages=toAnthropicMessages(body);
 if(!messages.length)throw Object.assign(Error('input must contain at least one message'),{status:400,code:'request/input'});
 const request={model,messages,max_tokens:typeof body.max_output_tokens==='number'&&body.max_output_tokens>0?body.max_output_tokens:4096,stream:true};
 const system=systemText(body);
 if(system)request.system=system;
 const tools=toAnthropicTools(body.tools);
 if(tools)request.tools=tools;
 const toolChoice=toAnthropicToolChoice(body.tool_choice);
 if(toolChoice)request.tool_choice=toolChoice;
 if(typeof body.temperature==='number')request.temperature=body.temperature;
 if(typeof body.top_p==='number')request.top_p=body.top_p;
 return request;
}

function geminiModelPath(model){return String(model).replace(/^models\//i,'').split('/').map(encodeURIComponent).join('/');}

function geminiImage(url){
 const data=parseDataUrl(url);
 if(data)return {inlineData:{mimeType:data.mediaType,data:data.data}};
 return {fileData:{mimeType:'image/png',fileUri:String(url)}};
}

function toGeminiContents(body){
 const contents=[];
 const callNames=new Map();
 for(const item of inputItems(body)){
  const type=itemType(item);
  if(type==='function_call'||type==='tool_call')callNames.set(callIdOf(item),callNameOf(item));
 }
 const push=(role,parts)=>{
  if(!parts.length)return;
  const last=contents.at(-1);
  if(last&&last.role===role)last.parts.push(...parts);
  else contents.push({role,parts});
 };
 for(const item of inputItems(body)){
  const type=itemType(item);
  if(type==='message'){
   if(isSystemRole(item.role))continue; // system 走 systemInstruction
   const role=item.role==='assistant'?'model':'user';
   const parts=[];
   for(const part of contentParts(item)){
    if(!part||typeof part!=='object')continue;
    if(part.type==='function_call'||part.type==='tool_call'){
     parts.push({functionCall:{name:callNameOf(part),args:parseJsonObject(callArgumentsOf(part))}});
     continue;
    }
    if(part.type==='input_image'){for(const url of imageUrlsOf(part))parts.push(geminiImage(url));continue;}
    if(typeof part.text==='string'&&part.text)parts.push({text:part.text});
   }
   push(role,parts);
  }else if(type==='function_call'||type==='tool_call'){
   push('model',[{functionCall:{name:callNameOf(item),args:parseJsonObject(callArgumentsOf(item))}}]);
  }else if(type==='function_call_output'||type==='tool_result'){
   const name=callNames.get(callIdOf(item))||'tool';
   push('user',[{functionResponse:{name,response:{result:stringifyToolOutput(item.output)}}}]);
  }
 }
 return contents;
}

function toGeminiTools(tools){
 const flat=flattenTools(tools);
 if(!flat.length)return undefined;
 const declarations=[],seen=new Map();
 for(const tool of flat){
  if(tool.type!=='function')continue;
  const fn=toolFunctionOf(tool);if(!fn)continue;
  const name=aliasedToolName(tool,seen);
  if(declarations.some(item=>item.name===name))continue;
  declarations.push({name,
   description:typeof fn.description==='string'?fn.description:'',
   parameters:fn.parameters&&typeof fn.parameters==='object'?fn.parameters:{type:'object',properties:{}}});
 }
 return declarations.length?[{functionDeclarations:declarations}]:undefined;
}

function toGeminiToolConfig(choice){
 if(choice===undefined||choice===null)return undefined;
 if(choice==='auto')return {functionCallingConfig:{mode:'AUTO'}};
 if(choice==='required')return {functionCallingConfig:{mode:'ANY'}};
 if(choice==='none')return {functionCallingConfig:{mode:'NONE'}};
 if(typeof choice==='object'){
  const name=typeof choice.name==='string'?choice.name:typeof choice.function?.name==='string'?choice.function.name:'';
  if(name)return {functionCallingConfig:{mode:'ANY',allowedFunctionNames:[name]}};
 }
 return undefined;
}

function toGeminiRequest(body,fallbackModel){
 resolveModel(body,fallbackModel); // gemini 的 model 在路径里，但缺失仍是请求错误
 const contents=toGeminiContents(body);
 if(!contents.length)throw Object.assign(Error('input must contain at least one message'),{status:400,code:'request/input'});
 const request={contents};
 const system=systemText(body);
 if(system)request.systemInstruction={parts:[{text:system}]};
 const tools=toGeminiTools(body.tools);
 if(tools)request.tools=tools;
 const toolConfig=toGeminiToolConfig(body.tool_choice);
 if(toolConfig)request.toolConfig=toolConfig;
 const generationConfig={};
 if(typeof body.max_output_tokens==='number'&&body.max_output_tokens>0)generationConfig.maxOutputTokens=body.max_output_tokens;
 if(typeof body.temperature==='number')generationConfig.temperature=body.temperature;
 if(typeof body.top_p==='number')generationConfig.topP=body.top_p;
 if(Object.keys(generationConfig).length)request.generationConfig=generationConfig;
 return request;
}

// 组装一次上游请求：路径永远相对 base 拼接（版本段不重复），鉴权头按 wire。
function buildUpstreamRequest({wire,body,fallbackModel,stream}){
 const spec=wireSpec(wire);
 if(!spec||spec.direct)throw Object.assign(Error(`Channel wire "${wire}" is not proxied`),{status:400,code:'channel/wire'});
 const model=resolveModel(body,fallbackModel);
 const callMap=namespaceCallMap(body.tools);
 if(wire==='openai-chat')return {wire,model,callMap,path:spec.chatPath,payload:toChatRequest(body,model)};
 if(wire==='azure-openai')return {wire,model,callMap,path:`openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${AZURE_API_VERSION}`,payload:toChatRequest(body,model)};
 if(wire==='ollama')return {wire,model,callMap,path:spec.chatPath,payload:toOllamaRequest(body,model)};
 if(wire==='anthropic')return {wire,model,callMap,path:spec.chatPath,payload:toAnthropicRequest(body,model)};
 if(wire==='gemini')return {wire,model,callMap,path:`models/${geminiModelPath(model)}:${stream?'streamGenerateContent?alt=sse':'generateContent'}`,payload:toGeminiRequest(body,model)};
 throw Object.assign(Error(`Channel wire "${wire}" is not proxied`),{status:400,code:'channel/wire'});
}

// ---- 用量转换：各家 usage -> Responses usage ----
function pickNumber(...values){
 for(const value of values){
  if(value===undefined||value===null||value==='')continue;
  const number=Number(value);
  if(Number.isFinite(number))return number;
 }
 return null;
}
function responsesUsage(usage){
 if(!usage||typeof usage!=='object')return null;
 const input=pickNumber(usage.prompt_tokens,usage.input_tokens,usage.promptTokenCount,usage.prompt_token_count,usage.prompt_eval_count)??0;
 const output=pickNumber(usage.completion_tokens,usage.output_tokens,usage.candidatesTokenCount,usage.candidates_token_count,usage.eval_count)??0;
 const total=pickNumber(usage.total_tokens,usage.totalTokenCount,usage.total_token_count)??input+output;
 const cached=pickNumber(usage.prompt_tokens_details?.cached_tokens,usage.cached_tokens,usage.cache_read_input_tokens,usage.cachedContentTokenCount)??0;
 const reasoning=pickNumber(usage.completion_tokens_details?.reasoning_tokens,usage.reasoning_tokens,usage.thoughtsTokenCount,usage.thoughts_token_count)??0;
 return {
  input_tokens:input,
  input_tokens_details:{cached_tokens:cached},
  output_tokens:output,
  output_tokens_details:{reasoning_tokens:reasoning},
  total_tokens:total,
 };
}

// ---- 事件翻译：上游增量 -> Responses SSE 事件 ----
// 所有 wire 共用同一个 Translator：它按 Responses 契约维护 output 数组、增量与用量。
class Translator {
 constructor({model,emit,callMap,onToolArgumentsDelta,correlation}){
  this.model=model;
  this.emit=typeof emit==='function'?emit:()=>{};
  this.callMap=callMap instanceof Map?callMap:new Map();
  this.onToolArgumentsDelta=typeof onToolArgumentsDelta==='function'?onToolArgumentsDelta:null;
  this.correlation=correlation??null;
  this.id=newId('resp');
  this.createdAt=Math.floor(Date.now()/1000);
  this.outputs=[];
  this.reasoning=null;
  this.message=null;
  this.toolCalls=new Map();
  this.usage=null;
 }
 start(){
  this.emit('response.created',{response:{id:this.id,object:'response',created_at:this.createdAt,status:'in_progress',model:this.model,output:[]}});
 }
 addOutput(kind,item){
  const record={index:this.outputs.length,kind,item,closed:false};
  this.outputs.push(record);
  this.emit('response.output_item.added',{output_index:record.index,item:snapshot(item)});
  return record;
 }
 // content_block_start / 首个增量时创建条目，保证 added 一定先于 delta。
 ensureReasoning(){
  if(this.reasoning&&!this.reasoning.closed)return this.reasoning;
  this.reasoning=this.addOutput('reasoning',{type:'reasoning',id:newId('rs'),status:'in_progress',summary:[{type:'summary_text',text:''}]});
  return this.reasoning;
 }
 ensureMessage(){
  if(this.message&&!this.message.closed)return this.message;
  this.message=this.addOutput('message',{type:'message',id:newId('msg'),status:'in_progress',role:'assistant',content:[{type:'output_text',text:'',annotations:[]}]});
  return this.message;
 }
 ensureToolCall(index,patch={}){
  const existing=this.toolCalls.get(index);
  if(existing&&!existing.closed)return existing;
  const callId=typeof patch.id==='string'&&patch.id?patch.id:newId('call');
  const mapped=typeof patch.name==='string'?this.callMap.get(patch.name):null;
  // Codex 0.170 按独立的 (namespace, name) 路由 MCP 调用，不能只回一个裸名字。
  const record=this.addOutput('function_call',{
   type:'function_call',id:newId('fc'),call_id:callId,
   name:mapped?.name??(typeof patch.name==='string'?patch.name:''),
   ...(mapped?.namespace?{namespace:mapped.namespace}:{}),
   arguments:'',status:'in_progress',
  });
  this.toolCalls.set(index,record);
  return record;
 }
 closeOutput(record){
  if(!record||record.closed)return;
  record.closed=true;
  record.item.status='completed';
  this.emit('response.output_item.done',{output_index:record.index,item:snapshot(record.item)});
 }
 reasoningDelta(text){
  if(typeof text!=='string'||!text)return;
  const record=this.ensureReasoning();
  record.item.summary[0].text+=text;
  this.emit('response.reasoning_summary_text.delta',{item_id:record.item.id,output_index:record.index,summary_index:0,delta:text});
 }
 textDelta(text){
  if(typeof text!=='string'||!text)return;
  const record=this.ensureMessage();
  record.item.content[0].text+=text;
  this.emit('response.output_text.delta',{item_id:record.item.id,output_index:record.index,content_index:0,delta:text});
 }
 toolCallDelta(index,patch={}){
  const record=this.ensureToolCall(index,patch);
  if(typeof patch.name==='string'&&patch.name){
   const mapped=this.callMap.get(patch.name);
   if(mapped){record.item.name=mapped.name;record.item.namespace=mapped.namespace;}
   else if(!record.item.name)record.item.name=patch.name;
  }
  if(typeof patch.arguments==='string'&&patch.arguments){
   record.item.arguments+=patch.arguments;
   this.emit('response.function_call_arguments.delta',{item_id:record.item.id,output_index:record.index,delta:patch.arguments});
   // Codex 0.170 does not expose Responses argument deltas as app-server
   // notifications. Its request headers identify the owning thread/turn, so
   // the in-process bridge can mirror the same delta without guessing.
   if(this.onToolArgumentsDelta&&this.correlation){
    try{this.onToolArgumentsDelta({...this.correlation,itemId:record.item.call_id,upstreamItemId:record.item.id,callId:record.item.call_id,name:record.item.name,delta:patch.arguments});}
    catch(error){console.error(`codex-go: tool argument observer failed: ${capMessage(error?.message??error)}`);}
   }
  }
 }
 setUsage(usage){
  if(!usage||typeof usage!=='object')return;
  // anthropic 把输入/输出 tokens 分两次给（message_start/message_delta），这里合并。
  this.usage=this.usage?{...this.usage,...usage}:{...usage};
 }
 finish(){
  const response={id:this.id,object:'response',created_at:this.createdAt,status:'completed',model:this.model,output:[]};
  for(const record of this.outputs){
   this.closeOutput(record);
   response.output.push(snapshot(record.item));
  }
  const usage=responsesUsage(this.usage);
  if(usage)response.usage=usage;
  this.emit('response.completed',{response});
  return response;
 }
 fail(error){
  this.emit('response.failed',{response:{id:this.id,object:'response',created_at:this.createdAt,status:'failed',model:this.model,output:[],error}});
 }
}

// ---- openai-chat / azure-openai ----
function feedChatDelta(translator,delta){
 if(!delta||typeof delta!=='object')return;
 const reasoning=typeof delta.reasoning_content==='string'?delta.reasoning_content:typeof delta.reasoning==='string'?delta.reasoning:null;
 if(reasoning)translator.reasoningDelta(reasoning);
 if(typeof delta.content==='string')translator.textDelta(delta.content);
 else if(Array.isArray(delta.content))for(const part of delta.content)if(typeof part?.text==='string')translator.textDelta(part.text);
 if(Array.isArray(delta.tool_calls))for(const [position,call] of delta.tool_calls.entries()){
  if(!call||typeof call!=='object')continue;
  const index=Number.isInteger(call.index)?call.index:position;
  translator.toolCallDelta(index,{id:call.id,name:call.function?.name,arguments:call.function?.arguments});
 }
 // Legacy single function_call delta without the tool_calls array.
 if(delta.function_call&&typeof delta.function_call==='object')translator.toolCallDelta(0,{name:delta.function_call.name,arguments:delta.function_call.arguments});
}

function feedChatChunk(translator,chunk){
 translator.setUsage(chunk?.usage);
 const choice=Array.isArray(chunk?.choices)?chunk.choices[0]:null;
 if(choice?.delta)feedChatDelta(translator,choice.delta);
 else if(choice?.message)feedChatDelta(translator,choice.message);
}

function feedJsonCompletion(translator,payload){
 const choice=Array.isArray(payload?.choices)?payload.choices[0]:null;
 const message=choice?.message??choice?.delta??null;
 if(!message||typeof message!=='object')throw Error('Upstream returned no choices');
 const reasoning=typeof message.reasoning_content==='string'?message.reasoning_content:typeof message.reasoning==='string'?message.reasoning:null;
 if(reasoning)translator.reasoningDelta(reasoning);
 if(Array.isArray(message.content)){
  for(const part of message.content)if(typeof part?.text==='string')translator.textDelta(part.text);
 }else if(typeof message.content==='string')translator.textDelta(message.content);
 if(Array.isArray(message.tool_calls))for(const [position,call] of message.tool_calls.entries()){
  if(!call||typeof call!=='object')continue;
  const index=Number.isInteger(call.index)?call.index:position;
  translator.toolCallDelta(index,{id:call.id,name:call.function?.name,arguments:call.function?.arguments});
 }
 translator.setUsage(payload.usage);
}

// ---- ollama（NDJSON，一行一个 JSON）----
function ollamaToolCalls(translator,list){
 for(const [position,call] of list.entries()){
  if(!call||typeof call!=='object')continue;
  const index=Number.isInteger(call.index)?call.index:position;
  const args=call.function?.arguments;
  const text=typeof args==='string'?args:args===undefined||args===null?'':JSON.stringify(args);
  translator.toolCallDelta(index,{id:call.id,name:call.function?.name,arguments:text});
 }
}

function feedOllamaChunk(translator,payload){
 if(payload?.error)throw upstreamStreamError({error:payload.error});
 const message=payload?.message;
 if(message&&typeof message==='object'){
  if(typeof message.thinking==='string'&&message.thinking)translator.reasoningDelta(message.thinking);
  if(typeof message.content==='string'&&message.content)translator.textDelta(message.content);
  if(Array.isArray(message.tool_calls))ollamaToolCalls(translator,message.tool_calls);
 }
 if(payload?.done===true)translator.setUsage({prompt_eval_count:payload.prompt_eval_count,eval_count:payload.eval_count});
}

// ---- anthropic ----
function feedAnthropicMessage(translator,payload){
 if(payload?.type==='error'||payload?.error)throw upstreamStreamError(payload);
 const content=Array.isArray(payload?.content)?payload.content:null;
 if(!content)throw Error('Upstream returned no content blocks');
 content.forEach((block,index)=>{
  if(!block||typeof block!=='object')return;
  if(block.type==='thinking')translator.reasoningDelta(typeof block.thinking==='string'?block.thinking:'');
  else if(block.type==='text')translator.textDelta(typeof block.text==='string'?block.text:'');
  else if(block.type==='tool_use')translator.toolCallDelta(index,{id:block.id,name:block.name,arguments:JSON.stringify(block.input??{})});
 });
 translator.setUsage(payload?.usage);
}

function anthropicDecoder(translator){
 const blocks=new Map();
 const blockIndex=data=>Number.isInteger(data?.index)?data.index:0;
 const remember=(index,record)=>{if(record)blocks.set(index,record);};
 return {
  event(name,data){
   const type=typeof data?.type==='string'?data.type:name;
   if(type==='error')throw upstreamStreamError(data);
   if(type==='message_start'){
    translator.setUsage(data?.message?.usage);
    return;
   }
   if(type==='content_block_start'){
    const block=data?.content_block??{};
    const index=blockIndex(data);
    if(block.type==='thinking'||block.type==='redacted_thinking')remember(index,translator.ensureReasoning());
    else if(block.type==='tool_use')remember(index,translator.ensureToolCall(index,{id:block.id,name:block.name}));
    else remember(index,translator.ensureMessage());
    return;
   }
   if(type==='content_block_delta'){
    const delta=data?.delta??{};
    // anthropic 的 block 索引与 Translator 的工具索引一致，增量按索引归位。
    if(delta.type==='text_delta')translator.textDelta(delta.text);
    else if(delta.type==='thinking_delta')translator.reasoningDelta(delta.thinking);
    else if(delta.type==='input_json_delta')translator.toolCallDelta(blockIndex(data),{arguments:delta.partial_json});
    return;
   }
   if(type==='content_block_stop'){
    translator.closeOutput(blocks.get(blockIndex(data)));
    return;
   }
   if(type==='message_delta'){
    translator.setUsage(data?.usage);
    return;
   }
   // message_stop / ping / signature_delta 不需要额外事件。
  },
 };
}

// ---- gemini ----
function geminiFeed(translator,state,payload){
 if(payload?.error)throw upstreamStreamError(payload);
 const candidates=Array.isArray(payload?.candidates)?payload.candidates:null;
 // 流式最后一帧常常只有 usageMetadata；非流式则必须有 candidates 才算有效答复。
 if(!candidates&&!payload?.usageMetadata)throw Error('Upstream returned no candidates');
 for(const candidate of candidates??[]){
  const parts=Array.isArray(candidate?.content?.parts)?candidate.content.parts:[];
  for(const part of parts){
   if(!part||typeof part!=='object')continue;
   if(typeof part.text==='string'&&part.text){
    if(part.thought===true)translator.reasoningDelta(part.text);
    else translator.textDelta(part.text);
   }
   if(part.functionCall&&typeof part.functionCall==='object'){
    const name=typeof part.functionCall.name==='string'?part.functionCall.name:'';
    const args=part.functionCall.args??{};
    const key=`${name}:${JSON.stringify(args)}`;
    if(state.seen.has(key))continue;
    state.seen.add(key);
    translator.toolCallDelta(state.next++,{name,arguments:JSON.stringify(args)});
   }
  }
 }
 if(payload?.usageMetadata)translator.setUsage(payload.usageMetadata);
}

function geminiDecoder(translator){
 const state={seen:new Set(),next:0};
 return {event:(_name,data)=>geminiFeed(translator,state,data)};
}

function feedGeminiResponse(translator,payload){geminiFeed(translator,{seen:new Set(),next:0},payload);}

// ---- 解码器选择 ----
function createDecoder(wire,translator){
 if(wire==='anthropic')return anthropicDecoder(translator);
 if(wire==='gemini')return geminiDecoder(translator);
 if(wire==='ollama')return {event:(_name,data)=>feedOllamaChunk(translator,data)};
 return {event:(_name,data)=>{if(data?.error)throw upstreamStreamError(data);feedChatChunk(translator,data);}};
}

function feedPayload(wire,translator,payload){
 if(wire==='ollama')return feedOllamaChunk(translator,payload);
 if(wire==='anthropic')return feedAnthropicMessage(translator,payload);
 if(wire==='gemini')return feedGeminiResponse(translator,payload);
 return feedJsonCompletion(translator,payload);
}

function upstreamStreamError(value){
 const error=value?.error??value;
 const message=typeof error==='string'?error
  :typeof error?.message==='string'?error.message
  :JSON.stringify(error??'upstream error');
 const code=typeof error?.type==='string'?error.type:typeof error?.code==='string'?error.code:'upstream_stream';
 return Object.assign(Error(`Upstream stream error: ${capMessage(message)}`),{code});
}

// ---- 流读取：SSE 与 NDJSON；每收到数据重置「无数据超时」。----
async function pumpSse(upstream,decoder,arm,onFirstData){
 const reader=upstream.body.getReader();
 const terminator=new TextDecoder();
 let buffer='';
 let pendingEvent=null,pendingData=[];
 const dispatch=()=>{
  if(!pendingData.length)return false;
  const payload=pendingData.join('\n');pendingData=[];
  if(payload==='[DONE]')return true;
  let data;
  try{data=JSON.parse(payload);}
  catch{throw Error('Upstream sent malformed JSON in an SSE data field');}
  decoder.event(pendingEvent,data);
  pendingEvent=null;
  return false;
 };
 const consume=line=>{
  const text=line.endsWith('\r')?line.slice(0,-1):line;
  if(!text){
   const done=dispatch();pendingEvent=null;pendingData=[];
   return done;
  }
  if(text.startsWith(':'))return false;
  if(text.startsWith('event:')){pendingEvent=text.slice(6).trim();return false;}
  if(!text.startsWith('data:'))return false;
  let payload=text.slice(5);if(payload.startsWith(' '))payload=payload.slice(1);
  pendingData.push(payload);
  return false;
 };
 while(true){
  const {done,value}=await reader.read();
  if(done)break;
  arm();
  onFirstData?.();
  buffer+=terminator.decode(value,{stream:true});
  let boundary;
  while((boundary=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,boundary);
   buffer=buffer.slice(boundary+1);
   if(consume(line))return;
  }
 }
 buffer+=terminator.decode();
 if(buffer&&consume(buffer))return;
 dispatch();
}

async function pumpNdjson(upstream,decoder,arm,onFirstData){
 const reader=upstream.body.getReader();
 const terminator=new TextDecoder();
 let buffer='';
 const consume=line=>{
  const text=line.trim();
  if(!text)return;
  let data;
  try{data=JSON.parse(text);}
  catch{throw Error(`Upstream sent a non-JSON NDJSON line: ${capMessage(text)}`);}
  decoder.event(null,data);
 };
 while(true){
  const {done,value}=await reader.read();
  if(done)break;
  arm();
  onFirstData?.();
  buffer+=terminator.decode(value,{stream:true});
  let boundary;
  while((boundary=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,boundary);
   buffer=buffer.slice(boundary+1);
   consume(line);
  }
 }
 if(buffer.trim())consume(buffer);
}

async function readJsonResponse(upstream,maxBytes=COMPLETION_MAX_BYTES){
 const text=await readCappedText(upstream,maxBytes);
 let payload;
 try{payload=JSON.parse(text);}catch{throw Object.assign(Error(`Upstream returned a non-JSON body: ${capMessage(text)}`),{status:502});}
 return payload;
}

// ---- 单次代理请求：POST /v1/<id>/responses -> 按 wire 翻译到上游 ----
function requestCorrelation(req){
 const threadId=req.headers['thread-id'];
 const raw=req.headers['x-codex-turn-metadata'];
 if(typeof threadId!=='string'||!threadId||typeof raw!=='string'||!raw)return null;
 try{
  const metadata=JSON.parse(raw);
  if(metadata?.thread_id!==threadId||typeof metadata?.turn_id!=='string'||!metadata.turn_id)return null;
  return {threadId,turnId:metadata.turn_id};
 }catch{return null;}
}

async function handleResponses(req,res,channelId,options){
 let body;
 try{body=await readBody(req);}
 catch(error){return sendError(res,error.status??400,{type:'invalid_request_error',code:error.code??'request/json',message:error.message});}

 let channel;
 try{channel=await options.lookupChannel(channelId);}
 catch(error){return sendError(res,500,{type:'bridge/internal',code:'channel/lookup',message:capMessage(error?.message??error)});}
 if(!channel)return sendError(res,404,{type:'channel/unknown',code:'channel/unknown',message:`Unknown channel: ${channelId}`});
 const wire=channel.wire===undefined||channel.wire===null||channel.wire===''?'openai-chat':normalizeWire(channel.wire);
 if(!wire)return sendError(res,400,{type:'channel/wire',code:'channel/wire',message:`Channel ${channelId} uses unknown wire "${channel.wire}"`});
 if(wire==='openai-responses')return sendError(res,400,{type:'channel/wire',code:'channel/wire',message:`Channel ${channelId} uses wire "openai-responses", which Codex calls directly`});

 let baseUrl;
 try{baseUrl=normalizeUpstreamBase(channel.baseUrl);}
 catch(error){return sendError(res,400,{type:'invalid_request_error',code:'channel/base-url',message:error.message});}

 const stream=body.stream!==false;
 const correlation=requestCorrelation(req);
 let upstreamRequest;
 try{upstreamRequest=buildUpstreamRequest({wire,body,fallbackModel:channel.model,stream});}
 catch(error){return sendError(res,error.status??400,{type:'invalid_request_error',code:error.code??'request/input',message:error.message});}

 const target=joinUpstreamUrl(baseUrl,upstreamRequest.path);
 const headers={
  'content-type':'application/json',
  accept:stream?(wire==='ollama'?'application/x-ndjson':'text/event-stream'):'application/json',
  ...wireAuthHeaders(wire,channel.apiKey),
 };

 const controller=new AbortController();
 let noDataTimer=null,connectTimer=null,timedOut=null;
 // 30s 连接超时与 120s 无数据超时同时生效；先触发的那一个决定错误语义。
 const arm=()=>{
  if(noDataTimer)clearTimeout(noDataTimer);
  noDataTimer=setTimeout(()=>{timedOut=timedOut??'no-data';controller.abort();},options.noDataTimeoutMs);
 };
 const armConnect=()=>{
  if(connectTimer)clearTimeout(connectTimer);
  connectTimer=setTimeout(()=>{timedOut=timedOut??'connect';controller.abort();},options.connectTimeoutMs);
 };
 const clearConnect=()=>{if(connectTimer){clearTimeout(connectTimer);connectTimer=null;}};
 const disarm=()=>{
  if(noDataTimer){clearTimeout(noDataTimer);noDataTimer=null;}
  clearConnect();
 };

 let upstream;
 try{
  armConnect();
  arm();
  upstream=await fetch(target.url,{method:'POST',headers:withCliUa(headers),body:JSON.stringify(upstreamRequest.payload),signal:controller.signal});
 }catch(error){
  disarm();
  const message=capMessage(error?.message??error);
  if(timedOut==='connect')return sendError(res,504,{type:'upstream_timeout',code:'timeout',message:`Upstream did not accept the connection within ${options.connectTimeoutMs}ms`});
  if(timedOut==='no-data')return sendError(res,504,{type:'upstream_timeout',code:'timeout',message:`Upstream sent no data within ${options.noDataTimeoutMs}ms`});
  return sendError(res,502,{type:'upstream_unreachable',code:'connect_failed',message:`Could not reach ${baseUrl}: ${message}`});
 }
 // 连上之后换成「无数据超时」：上游可能收下请求却一直不说话。
 clearConnect();
 arm();

 try{
  if(!upstream.ok){
   const text=await upstream.text().catch(()=> '');
   disarm();
   const status=upstream.status>=400&&upstream.status<=599?upstream.status:502;
   return sendError(res,status,{type:'upstream_error',code:upstream.status,message:capMessage(text)||`Upstream responded ${upstream.status}`});
  }
  const contentType=String(upstream.headers.get('content-type')??'').toLowerCase();
  if(contentType.includes('event-stream')||contentType.includes('ndjson')||contentType.includes('x-jsonl')){
   // 只有拿到第一个上游数据块才写 SSE 响应头：这样「上游完全没数据」的超时还能回 504。
   let live=false;const pending=[];
   const flush=()=>{
    if(live)return;
    live=true;
    if(!stream)return;
    res.writeHead(200,SSE_HEADERS);
    for(const chunk of pending)res.write(chunk);
    pending.length=0;
   };
   const emit=stream?((type,payload)=>{
    const text=serializeEvent(type,payload);
    if(live)res.write(text);else pending.push(text);
   }):null;
   const translator=new Translator({model:upstreamRequest.model,emit,callMap:upstreamRequest.callMap,onToolArgumentsDelta:options.onToolArgumentsDelta,correlation});
   translator.start();
   const decoder=createDecoder(wire,translator);
   try{
    if(contentType.includes('ndjson')||contentType.includes('x-jsonl'))await pumpNdjson(upstream,decoder,arm,flush);
    else await pumpSse(upstream,decoder,arm,flush);
    disarm();
    flush();
    const response=translator.finish();
    if(stream)res.end();else sendJson(res,200,response);
   }catch(error){
    disarm();
    if(live&&stream){
     translator.fail({code:timedOut?'upstream_timeout':'upstream_stream',message:capMessage(timedOut?`Upstream sent no data within ${options.noDataTimeoutMs}ms`:error.message)});
     res.end();
    }else{
     // 非流式客户端还没写过响应头：仍然可以回真实 HTTP 状态。
     const status=timedOut?504:502;
     sendError(res,status,timedOut==='connect'
      ?{type:'upstream_timeout',code:'timeout',message:`Upstream did not accept the connection within ${options.connectTimeoutMs}ms`}
      :timedOut
      ?{type:'upstream_timeout',code:'timeout',message:`Upstream sent no data within ${options.noDataTimeoutMs}ms`}
      :{type:'upstream_error',code:502,message:capMessage(error.message)});
    }
   }
   return;
  }
  // 非流式上游（或忽略 alt=sse 的网关）：先读完整个 JSON，再合成完整事件序列。
  let payload;
  try{payload=await readJsonResponse(upstream);}
  catch(error){
   disarm();
   return sendError(res,error.status??502,{type:'upstream_error',code:502,message:capMessage(error.message)});
  }
  disarm();
  let emit=null;
  if(stream){res.writeHead(200,SSE_HEADERS);emit=(type,value)=>res.write(serializeEvent(type,value));}
  const translator=new Translator({model:upstreamRequest.model,emit,callMap:upstreamRequest.callMap,onToolArgumentsDelta:options.onToolArgumentsDelta,correlation});
  translator.start();
  try{feedPayload(wire,translator,payload);}
  catch(error){
   if(stream){translator.fail({code:'upstream_error',message:capMessage(error.message)});res.end();}
   else sendError(res,502,{type:'upstream_error',code:502,message:capMessage(error.message)});
   return;
  }
  const response=translator.finish();
  if(stream)res.end();else sendJson(res,200,response);
 }catch(error){
  disarm();
  if(!res.headersSent)sendError(res,502,{type:'upstream_error',code:502,message:capMessage(error?.message??error)});
  else res.end();
 }
}

// 测试与真实代理共用的入口：只绑定回环地址，端口由系统分配。
export async function start(port=0,host='127.0.0.1',options={}){
 const lookupChannel=typeof options.lookupChannel==='function'?options.lookupChannel:()=>null;
 const noDataTimeoutMs=Number.isFinite(options.noDataTimeoutMs)&&options.noDataTimeoutMs>0?options.noDataTimeoutMs:DEFAULT_NO_DATA_TIMEOUT_MS;
 const connectTimeoutMs=Number.isFinite(options.connectTimeoutMs)&&options.connectTimeoutMs>0?options.connectTimeoutMs:DEFAULT_CONNECT_TIMEOUT_MS;
 const server=http.createServer(async(req,res)=>{
  let url;
  try{url=new URL(req.url,`http://${req.headers.host||'127.0.0.1'}`);}
  catch{return sendError(res,400,{type:'invalid_request_error',code:'request/path',message:'Invalid request URL'});}
  const match=ROUTE.exec(url.pathname);
  if(!match)return sendError(res,404,{type:'invalid_request_error',code:'request/not-found',message:'Use POST /v1/<channel>/responses'});
  if(req.method!=='POST')return sendError(res,405,{type:'invalid_request_error',code:'request/method',message:'Use POST /v1/<channel>/responses'});
  let channelId;
  try{channelId=decodeURIComponent(match[1]);}
  catch{return sendError(res,400,{type:'invalid_request_error',code:'request/path',message:'Invalid channel id'});}
  try{await handleResponses(req,res,channelId,{lookupChannel,noDataTimeoutMs,connectTimeoutMs,onToolArgumentsDelta:options.onToolArgumentsDelta});}
  catch(error){
   if(!res.headersSent)sendError(res,500,{type:'bridge/internal',code:'proxy/internal',message:capMessage(error?.message??error)});
   else res.end();
  }
 });
 server.on('clientError',(error,socket)=>{socket.destroy();});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 const address=server.address();
 return {
  port:address.port,
  host,
  close:()=>new Promise(resolve=>{
   server.closeAllConnections?.();
   server.close(()=>resolve());
  }),
 };
}
