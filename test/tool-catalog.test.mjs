// node --test test/tool-catalog.test.mjs
// Real tools/list budget includes every currently loaded builtin (including future
// root/subagent additions); no fixed tool count or copied schema fixture can hide growth.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {test} from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {compactTool,createToolCatalog} from '../bridge/tool-catalog.mjs';

const bridge=fileURLToPath(new URL('../bridge/',import.meta.url));
const pick=({name,description,inputSchema})=>({name,description,inputSchema});
async function originals(){
 const result=[];
 const entries=await readdir(join(bridge,'toolpacks'),{withFileTypes:true});
 entries.sort((a,b)=>a.name.localeCompare(b.name));
 for(const entry of entries){
  if(!entry.isDirectory())continue;
  const pack=await import(pathToFileURL(join(bridge,'toolpacks',entry.name,'index.mjs')).href);
  result.push(...pack.tools.map(pick));
 }
 return result;
}

// Used to assert every non-description keyword, including arbitrary extension
// keywords, definitions, refs, enum/default/const payloads and nested constraints.
// Deliberately do not recursively strip keys from enum/default data: those may be
// literal application properties named "description", not schema annotations.
function withoutSchemaDescriptions(value){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(withoutSchemaDescriptions);
 const schemaMaps=new Set(['properties','patternProperties','$defs','definitions','dependentSchemas']);
 return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='description').map(([key,item])=>[
  key,['enum','const','default','examples'].includes(key)?item
   :schemaMaps.has(key)?Object.fromEntries(Object.entries(item).map(([name,schema])=>[name,withoutSchemaDescriptions(schema)]))
   :withoutSchemaDescriptions(item),
 ]));
}

async function start(t,{disabled=[],userTools=[],config='',env={}}={}){
 const base=await mkdtemp(join(tmpdir(),'codex-tool-catalog-'));
 const home=join(base,'home');
 await mkdir(home,{recursive:true});
 if(disabled.length)await writeFile(join(home,'codex-go-toolpacks.json'),JSON.stringify({disabled}));
 if(config)await writeFile(join(home,'config.toml'),config);
 if(userTools.length){
  const directory=join(home,'toolpacks','catalog_test');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'index.mjs'),`export const meta={name:'catalog_test'};\nexport const tools=${JSON.stringify(userTools)}.map(tool=>({...tool,run:async()=>({echo:true})}));`);
 }
 const child=spawn(process.execPath,[resolve(bridge,'mcp-server.mjs')],{
  cwd:base,env:{...process.env,NODE_USE_ENV_PROXY:'0',CODEX_HOME:home,CODEX_GO_DATA_DIR:join(base,'data'),CODEX_GO_ALLOWED_ROOTS:base,...env},
  stdio:['pipe','pipe','pipe'],windowsHide:true,
 });
 let nextId=1,stderr='';
 const pending=new Map();
 child.stderr.setEncoding('utf8');
 child.stderr.on('data',chunk=>{stderr+=chunk;});
 const exited=once(child,'close').then(()=>{
  for(const entry of pending.values())entry.reject(Error('MCP exited before replying'));
  pending.clear();
 });
 createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{
  const message=JSON.parse(line);
  const entry=pending.get(message.id);
  if(!entry)return;
  pending.delete(message.id);
  if(message.error)entry.reject(Object.assign(Error(message.error.message),{rpc:message.error}));
  else entry.resolve(message.result);
 });
 t.after(async()=>{
  if(child.exitCode===null)child.kill();
  await exited;
  // base is the exact absolute mkdtemp directory created above, never a user path.
  await rm(base,{recursive:true,force:true});
 });
 const request=(method,params={})=>new Promise((resolveReply,rejectReply)=>{
  const id=nextId++;
  const timer=setTimeout(()=>{pending.delete(id);rejectReply(Error(`MCP timeout: ${method}`));},30000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolveReply(value);},reject:error=>{clearTimeout(timer);rejectReply(error);}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 const init=await request('initialize');
 return {request,init,stderr:()=>stderr,call:(name,args={})=>request('tools/call',{name,arguments:args})};
}

function data(reply){
 assert.equal(reply.isError,false,reply.content?.[0]?.text);
 assert.equal(reply.structuredContent.ok,true);
 assert.equal(reply.content[0].text,JSON.stringify(reply.structuredContent));
 return reply.structuredContent.data;
}

function failure(reply){
 assert.equal(reply.isError,true);
 assert.equal(reply.structuredContent.ok,false);
 assert.equal(reply.structuredContent.error.code,'args/invalid');
 return reply.structuredContent.error;
}

test('real tools/list preserves every tool and full inputSchema, with a strict 80,000 byte budget',{timeout:60000},async t=>{
 const original=await originals();
 const client=await start(t);
 const response=await client.request('tools/list');
 const listed=response.tools;
 assert.deepEqual(listed.map(tool=>tool.name),original.map(tool=>tool.name));
 assert.equal(new Set(listed.map(tool=>tool.name)).size,listed.length);
 const fullIndex=new Map(original.map(tool=>[tool.name,tool]));
 for(const tool of listed){
  const full=fullIndex.get(tool.name);
  assert.deepEqual(withoutSchemaDescriptions(tool.inputSchema),withoutSchemaDescriptions(full.inputSchema),`${tool.name}: validation keywords changed`);
  // Stronger than requested: schema descriptions are also untouched.
  assert.deepEqual(tool.inputSchema,full.inputSchema,`${tool.name}: inputSchema changed`);
  assert.deepEqual(tool,compactTool(full));
 }
 const fullBytes=Buffer.byteLength(JSON.stringify(original));
 const compactBytes=Buffer.byteLength(JSON.stringify(listed));
 const resultBytes=Buffer.byteLength(JSON.stringify(response));
 const wireBytes=Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:2,result:response}));
 assert.ok(compactBytes<=80000,`tools array is ${compactBytes} bytes > 80000`);
 assert.ok(resultBytes<=80000,`tools/list result is ${resultBytes} bytes > 80000`);
 assert.ok(wireBytes<=80000,`JSON-RPC response is ${wireBytes} bytes > 80000`);
 assert.ok(compactBytes<fullBytes*0.5,'compact metadata should be less than half of original');
 const startup=client.stderr().match(/loaded (\d+) packs, (\d+) tools/);
 assert.ok(startup);
 assert.equal(Number(startup[2]),listed.length);
 const declared=client.init.instructions.match(/(\d+) toolpacks loaded:/);
 assert.equal(Number(declared[1]),Number(startup[1]));
 assert.match(client.init.instructions,/Before first using a tool.*tool_help/);
 t.diagnostic(JSON.stringify({tools:listed.length,originalBytes:fullBytes,compactBytes,resultBytes,wireBytes,reductionPercent:Number(((1-compactBytes/fullBytes)*100).toFixed(3))}));
});

test('full help equals every original description/schema and returns only metadata',{timeout:60000},async t=>{
 const client=await start(t,{config:'sandbox_mode = "read-only"\n',env:{CATALOG_TEST_SECRET:'catalog-secret-marker'}});
 const original=await originals();
 for(const full of original){
  const help=data(await client.call('tool_help',{name:full.name}));
  assert.deepEqual(help,full,full.name);
  assert.deepEqual(Object.keys(help),['name','description','inputSchema']);
 }
 // In particular no runtime roots, module paths, config, credentials or run functions
 // are added to help. Original doc examples/paths remain exactly as authored above.
 const ownHelp=data(await client.call('tool_help',{name:'tool_help'}));
 assert.ok(!JSON.stringify(ownHelp).includes('catalog-secret-marker'));
 assert.ok(!client.stderr().includes('catalog-secret-marker'));
 failure(await client.call('tool_help',{name:'unknown_tool'}));
 failure(await client.call('tool_help',{}));
 failure(await client.call('tool_help',{name:'../config.toml'}));
 failure(await client.call('tool_help',{name:'file_read',detail:true}));
 failure(await client.call('tool_help',{name:42}));
 await assert.rejects(client.call('unknown_tool'),error=>error.rpc?.code===-32602);
});

test('disabled/rejected tools stay unavailable; user metadata is never compacted',{timeout:60000},async t=>{
 const user={name:'catalog_user_echo',description:'A complete user declaration. '+('Do not rewrite this sentence. '.repeat(50)),inputSchema:{type:'object',properties:{description:{type:'string',description:'Long user parameter description. '.repeat(20)}},required:['description'],additionalProperties:false}};
 const rejected={...user,name:'Invalid Tool'};
 const duplicate={...user,name:'file_read'};
 const client=await start(t,{disabled:['web'],userTools:[user,rejected,duplicate]});
 const tools=(await client.request('tools/list')).tools;
 assert.deepEqual(tools.find(tool=>tool.name===user.name),user);
 assert.deepEqual(data(await client.call('tool_help',{name:user.name})),user);
 assert.deepEqual(data(await client.call('tool_help',{name:'file_read'})),(await originals()).find(tool=>tool.name==='file_read'));
 assert.ok(!tools.some(tool=>tool.name==='web_fetch'||tool.name==='Invalid Tool'));
 failure(await client.call('tool_help',{name:'web_fetch'}));
 failure(await client.call('tool_help',{name:'Invalid Tool'}));
 assert.match(client.stderr(),/ignoring duplicate tool name/);
 assert.equal(Number(client.stderr().match(/loaded \d+ packs, (\d+) tools/)[1]),tools.length);
 const disabledUser=await start(t,{disabled:['catalog_test'],userTools:[user]});
 failure(await disabledUser.call('tool_help',{name:user.name}));
 assert.ok(!(await disabledUser.request('tools/list')).tools.some(tool=>tool.name===user.name));
});

test('disabling the help pack falls back to complete builtin metadata',{timeout:60000},async t=>{
 const client=await start(t,{disabled:['catalog']});
 const tools=(await client.request('tools/list')).tools;
 assert.deepEqual(tools,(await originals()).filter(tool=>tool.name!=='tool_help'));
 assert.ok(!client.init.instructions.includes('Before first using a tool'));
 await assert.rejects(client.call('tool_help',{name:'file_read'}),error=>error.rpc?.code===-32602);
});

test('catalog copies cannot mutate records; unknown long descriptions are never sliced',()=>{
 const original={name:'future_tool',description:'An unreviewed description '+('with a very long first sentence '.repeat(30))+'. Safety rule: never proceed without confirmation.',inputSchema:{type:'object',properties:{nested:{type:'string',description:'A description.',minLength:3,maxLength:8}},$defs:{literal:{const:{description:'literal value'}}},additionalProperties:false}};
 const before=structuredClone(original);
 const compact=compactTool(original);
 assert.match(compact.description,/Read tool_help before calling/);
 assert.ok(!compact.description.includes('with a very long first'));
 assert.deepEqual(compact.inputSchema,original.inputSchema);
 assert.deepEqual(original,before);
 const catalog=createToolCatalog([{...original,run:()=>null,pack:'future',directory:'private-path'}]);
 const help=catalog.describeTool(original.name);
 assert.deepEqual(help,original);
 help.description='mutated';
 help.inputSchema.properties.nested.minLength=0;
 original.inputSchema.properties.nested.maxLength=99;
 assert.deepEqual(catalog.describeTool('future_tool'),before);
 assert.throws(()=>catalog.describeTool('missing'),error=>error.code==='args/invalid');
 assert.throws(()=>catalog.describeTool(null),error=>error.code==='args/invalid');
 const short={...before,description:'A complete short description. Never bypass confirmation.'};
 assert.deepEqual(compactTool(short),short);
});
