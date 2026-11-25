// Real MCP stdio child-process tests for the toolpack host and every builtin pack.
// The packs are exercised through the real JSON-RPC stdio protocol; nothing is stubbed,
// and bridge-backed tools are asserted to FAIL when no bridge handshake exists.
// Run: node --test --test-isolation=none test/toolpacks.test.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {mkdir,mkdtemp,readFile,readdir,rmdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const here=fileURLToPath(new URL('.',import.meta.url));
const serverPath=resolve(here,'../bridge/mcp-server.mjs');
const nodePath=process.execPath;

const sleep=ms=>new Promise(done=>setTimeout(done,ms));

class McpClient{
 static async start({roots,dataDir,home,env={}}={}){
  const child=spawn(nodePath,[serverPath],{
   env:{
    ...process.env,
    CODEX_GO_ALLOWED_ROOTS:roots,
    CODEX_GO_DATA_DIR:dataDir,
    CODEX_HOME:home,
    ...env,
   },
   stdio:['pipe','pipe','pipe'],
   windowsHide:true,
  });
  const client=new McpClient(child);
  client.initializeResult=await client.request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'toolpacks-test',version:'1'}});
  client.notify('notifications/initialized',{});
  return client;
 }
 constructor(child){
  this.child=child;this.nextId=1;this.pending=new Map();this.stderr='';this.exitCode=null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{this.stderr+=chunk;});
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{
   let message;
   try{message=JSON.parse(line);}
   catch{return;}
   if(message.id===undefined)return;
   const waiting=this.pending.get(message.id);
   if(!waiting)return;
   this.pending.delete(message.id);
   if(message.error)waiting.reject(Object.assign(Error(message.error.message),{rpc:message.error}));
   else waiting.resolve(message.result);
  });
  this.exited=once(child,'close').then(([code])=>{
   this.exitCode=code;
   for(const waiting of this.pending.values())waiting.reject(Error('MCP process exited before replying'));
   this.pending.clear();
   return code;
  });
 }
 send(message){this.child.stdin.write(JSON.stringify(message)+'\n');}
 notify(method,params={}){this.send({jsonrpc:'2.0',method,params});}
 request(method,params={},timeout=90000){
  const id=this.nextId++;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`MCP request timed out: ${method}`));},timeout);
   this.pending.set(id,{
    resolve:value=>{clearTimeout(timer);resolve(value);},
    reject:error=>{clearTimeout(timer);reject(error);},
   });
   this.send({jsonrpc:'2.0',id,method,params});
  });
 }
 async tools(){return (await this.request('tools/list',{})).tools;}
 async call(name,args={}){return this.request('tools/call',{name,arguments:args});}
 async close(){this.child.stdin.end();return this.exited;}
 async kill(){
  if(this.exitCode===null)this.child.kill();
  return this.exited;
 }
}

async function workspace(t,{name='toolpacks'}={}){
 const base=await mkdtemp(join(tmpdir(),`codex-${name}-`));
 const home=join(base,'codex-home');
 const files=join(base,'files');
 const data=join(base,'data');
 await mkdir(home,{recursive:true});
 await mkdir(files,{recursive:true});
 t.after(async()=>{await rm(base,{recursive:true,force:true});});
 return {base,home,files,data};
}

// The host normalises every tools/call into one envelope, so a test reads the tool's own
// value out of `structuredContent.data`. A tool whose value already carries a boolean `ok`
// (web_fetch, http_request, github_api, ping) is passed through untouched, so the helper
// must accept both shapes and hand back the tool's own object either way.
const isEnvelope=value=>{
 assert.ok(value&&typeof value==='object',`structuredContent must be an object; got ${JSON.stringify(value)}`);
 const keys=Object.keys(value);
 return keys.length===2&&keys.includes('ok')&&keys.includes('data');
};

function writtenText(result){
 assert.equal(result.isError,false,result.content?.[0]?.text);
 const structured=result.structuredContent;
 const enveloped=isEnvelope(structured);
 if(enveloped)assert.equal(structured.ok,true,`a successful call must report ok:true; got ${JSON.stringify(structured)}`);
 else assert.equal(typeof structured.ok,'boolean',`a successful call must carry a boolean ok flag; got ${JSON.stringify(structured)}`);
 assert.equal(typeof result.content?.[0]?.text,'string','a successful call must carry content[0].text');
 assert.equal(result.content[0].text,JSON.stringify(structured),'content[0].text must mirror structuredContent');
 return enveloped?structured.data:structured;
}

// Failures are {ok:false,error:{code,message}}; content[0].text must read "<code>: <message>".
// `code` is asserted by shape (any <area>/<kebab>) because pack-specific codes are owned by
// the packs; only codes the host itself produces (for example tool/timeout) are pinned.
function failure(result,{message}={}){
 assert.equal(result.isError,true,`expected a failure envelope; got ${JSON.stringify(result)}`);
 const structured=result.structuredContent;
 assert.ok(structured&&typeof structured==='object',`a failed call must still return structuredContent; got ${JSON.stringify(structured)}`);
 assert.equal(structured.ok,false,'a failed call must report ok:false');
 assert.equal(typeof structured.error?.code,'string','a failed call must carry error.code');
 assert.match(structured.error.code,/^[a-z][a-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*$/,`error.code must look like <area>/<kebab>; got ${structured.error.code}`);
 assert.equal(typeof structured.error.message,'string','a failed call must carry error.message');
 assert.ok(structured.error.message.trim().length>0,'error.message must not be empty');
 assert.equal(result.content?.[0]?.text,`${structured.error.code}: ${structured.error.message}`,'content[0].text must read "<code>: <message>"');
 if(message)assert.match(structured.error.message,message);
 return structured.error;
}

// ---------------------------------------------------------------------------
test('toolpack host loads every builtin pack over real stdio',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'host'});
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const init=client.initializeResult;
 assert.equal(init.serverInfo.name,'codex-go-local-toolkit');
 assert.deepEqual(init.capabilities.tools,{listChanged:false});
 assert.match(init.instructions,/core/);

 const tools=await client.tools();
 const names=new Set(tools.map(tool=>tool.name));
 const expected={
  core:['file_read','file_write','file_list','file_search','time_now','calendar'],
  workflow:['workflow_list','workflow_get','workflow_create','workflow_delete','workflow_run'],
  subagent:['subagent_run','subagent_list'],
  git:['git_status','git_diff','git_log','git_add','git_commit'],
  memory:['memory_add','memory_search','memory_list','memory_forget'],
  web:['web_fetch'],
  system:['system_uname','system_df','system_uptime','system_process_list','system_env_redacted'],
  files:['file_exists','file_move','file_copy','file_info','file_hash','file_append','archive_create','archive_extract','file_truncate'],
  text:['text_convert','text_diff','text_sort','text_unique','text_word_count','text_replace'],
  net:['http_request','http_download','cookie_store_list','web_search','web_search_news','crossref_search','github_api'],
  code:['code_run_python','code_run_python_file','code_run_node','code_run_node_file','code_run_shell','code_toolchains'],
  plan:['plan_get','plan_create','plan_add_step','plan_update_step','plan_complete'],
  worldbook:['wb_list','wb_get','wb_create','wb_update','wb_delete','wb_search','wb_import','wb_export'],
  memoryx:['memory_update','memory_delete','memory_link','memory_links','memory_preferences_get','memory_preferences_set'],
  admin:['pkg_list','pkg_set_enabled','pkg_install','context_get','context_set','model_list','model_set','persona_get','persona_set','ping'],
  threads:['thread_list','thread_read','thread_rename','thread_delete','thread_send'],
  time:['time_get','time_format','time_add'],
  android:['device_capabilities','device_info'],
  'android-screen':['screen','tap','type','scroll','key','tap_xy','collect','apps','open','shot','clipboard','android_shell','device_status'],
 };
 for(const packTools of Object.values(expected)){
  for(const name of packTools)assert.ok(names.has(name),`missing tool ${name}; got ${[...names].join(',')}`);
 }
 const contractTools=Object.values(expected).flat();
 // Counts are asserted as "at least the contract surface" plus a self-consistency check
 // between tools/list and the host's own startup log, so adding a pack later only
 // requires extending `expected` instead of rewriting magic totals.
 assert.ok(tools.length>=contractTools.length,`expected at least ${contractTools.length} tools, got ${tools.length}`);
 assert.equal(new Set(tools.map(tool=>tool.name)).size,tools.length,'tool names must be unique across packs');
 for(const tool of tools){
  assert.match(tool.name,/^[a-z][a-z0-9_]{0,63}$/);
  assert.equal(typeof tool.description,'string');
  assert.ok(tool.description.trim().length>=10,`${tool.name} needs a real description`);
  assert.match(tool.description,/^[^\x00-\x1F\x7F]+$/u,`${tool.name} description should be printable text without control characters`);
  assert.equal(tool.inputSchema?.type,'object');
 }
 await sleep(150);
 const summary=client.stderr.match(/loaded (\d+) packs, (\d+) tools/);
 assert.ok(summary,'the host must log how many packs and tools it loaded');
 assert.ok(Number(summary[1])>=Object.keys(expected).length,`host loaded ${summary[1]} packs, expected at least ${Object.keys(expected).length}`);
 assert.equal(Number(summary[2]),tools.length,'the host tool count must equal tools/list');
 assert.equal(Object.keys(expected).length,19,'the builtin pack set is 19 packs (CONTRACT-V2 section E plus android and android-screen)');

 // --- uniform envelope ------------------------------------------------------
 const raw=await client.call('time_now',{timeZone:'UTC'});
 assert.equal(raw.isError,false);
 assert.equal(raw.structuredContent.ok,true,'a successful call must report ok:true');
 assert.ok(Object.hasOwn(raw.structuredContent,'data'),'a successful call must wrap the tool value in data');
 assert.equal(raw.structuredContent.data.timeZone,'UTC');
 assert.equal(raw.content[0].text,JSON.stringify(raw.structuredContent),'content[0].text must mirror structuredContent');

 // --- measured toolingStatus in initialize.instructions ----------------------
 const statusOf=initResult=>{
  const line=initResult.instructions.match(/^toolingStatus: (.+)$/m);
  assert.ok(line,'initialize.instructions must carry a toolingStatus line');
  return JSON.parse(line[1]);
 };
 const status=statusOf(init);
 assert.deepEqual(Object.keys(status).sort(),['bridgeConnected','dataDir','execAvailable','execShell','roots','sandboxMode']);
 assert.equal(status.sandboxMode,null,'no config.toml in this CODEX_HOME, so sandboxMode must be null');
 assert.equal(status.bridgeConnected,false,'no handshake file, so bridgeConnected must be false');
 assert.equal(typeof status.execAvailable,'boolean','execAvailable must be a real probe result');
 assert.equal(status.dataDir.toLowerCase(),data.toLowerCase());
 assert.equal(status.roots.length,1);
 assert.ok(status.roots[0].toLowerCase().endsWith('files'),`the only allowed root is the workspace files dir; got ${status.roots[0]}`);
 assert.match(init.instructions,/instead of guessing/i,'instructions must tell the model to trust the measured status');

 await client.close();
 assert.equal(client.exitCode,0);

 // A real sandbox_mode in ${CODEX_HOME}/config.toml must show up in the next initialize.
 await writeFile(join(home,'config.toml'),'model = "gpt-5"\nsandbox_mode = "read-only"\napproval_policy = "never"\n');
 const readonly=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await readonly.kill();});
 assert.equal(statusOf(readonly.initializeResult).sandboxMode,'read-only','sandbox_mode must be read from config.toml');
});

// ---------------------------------------------------------------------------
test('core pack reads, searches names and contents, and reports time',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'core'});
 await mkdir(join(files,'src'),{recursive:true});
 await mkdir(join(files,'docs'),{recursive:true});
 await mkdir(join(files,'node_modules','pkg'),{recursive:true});
 await writeFile(join(files,'src','app.js'),'const needleInContent = 42;\nexport default 42;\n');
 await writeFile(join(files,'src','needle_name.txt'),'needle starts this line\nplain text\n');
 await writeFile(join(files,'docs','guide.md'),'# Guide\nThis document mentions needle as well.\n');
 await writeFile(join(files,'node_modules','pkg','index.js'),'needle should be ignored here\n');

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const byName=writtenText(await client.call('file_search',{query:'needle_name',mode:'name'}));
 assert.deepEqual(byName.matches.map(match=>match.path),['src/needle_name.txt']);
 assert.equal(byName.matches[0].kind,'name');
 assert.equal(byName.truncated,false);

 const byContent=writtenText(await client.call('file_search',{query:'needleInContent',mode:'content'}));
 assert.equal(byContent.matches.length,1);
 assert.equal(byContent.matches[0].path,'src/app.js');
 assert.equal(byContent.matches[0].line,1);
 assert.match(byContent.matches[0].text,/needleInContent/);
 assert.ok(byContent.scanned.files>=1);
 assert.equal(byName.scanned.files,3,'walk must skip node_modules and report what it read');

 const ignored=writtenText(await client.call('file_search',{query:'ignored here',mode:'content'}));
 assert.equal(ignored.matches.length,0,'node_modules must be skipped');

 const capped=writtenText(await client.call('file_search',{query:'needle',mode:'auto',maxResults:2}));
 assert.equal(capped.matches.length,2);
 assert.equal(capped.truncated,true);

 const regex=writtenText(await client.call('file_search',{query:'^needle',mode:'content',regex:true}));
 assert.deepEqual(regex.matches.map(match=>match.path),['src/needle_name.txt']);

 const traversal=await client.call('file_read',{path:'../outside.txt'});
 failure(traversal,{message:/outside the allowed roots/i});
 assert.equal(traversal.structuredContent.data,undefined,'a failed call must not fake a result');

 const write=writtenText(await client.call('file_write',{path:'src/new.txt',content:'hello toolpacks'}));
 assert.equal(write.bytes,15);
 assert.equal(await readFile(join(files,'src','new.txt'),'utf8'),'hello toolpacks');
 const read=writtenText(await client.call('file_read',{path:'src/new.txt'}));
 assert.equal(read.content,'hello toolpacks');

 const listing=writtenText(await client.call('file_list',{path:'src'}));
 assert.deepEqual(listing.entries.map(entry=>entry.name).sort(),['app.js','needle_name.txt','new.txt']);
 assert.equal(listing.entries.find(entry=>entry.name==='app.js').type,'file');

 const clock=writtenText(await client.call('time_now',{timeZone:'Asia/Shanghai'}));
 assert.equal(clock.timeZone,'Asia/Shanghai');
 assert.ok(clock.unixSeconds>0);

 const calendar=writtenText(await client.call('calendar',{year:2024,month:2}));
 assert.equal(calendar.weeks.flat().filter(day=>day!==null).length,29);
 assert.equal(calendar.weekdays.length,7);

 await assert.rejects(client.call('no_such_tool',{}),error=>error.rpc?.code===-32602&&/unknown tool/i.test(error.message));
 const missingArgument=await client.call('file_read',{});
 failure(missingArgument,{message:/path/});
});

// ---------------------------------------------------------------------------
test('memory pack round-trips notes and persists them to disk',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'memory'});
 const first=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await first.kill();});

 const added=writtenText(await first.call('memory_add',{text:'Deploy token rotation happens every Friday at 03:00 UTC',tags:['ops','deploy']}));
 assert.equal(added.created,true);
 assert.match(added.entry.id,/^[0-9a-f-]{36}$/);
 writtenText(await first.call('memory_add',{text:'The office coffee machine lives on floor 3',tags:['office']}));
 const duplicate=writtenText(await first.call('memory_add',{text:'Deploy token rotation happens every Friday at 03:00 UTC'}));
 assert.equal(duplicate.created,false,'identical text must not duplicate the note');
 assert.equal(duplicate.count,2);

 const found=writtenText(await first.call('memory_search',{query:'deploy rotation'}));
 assert.equal(found.count,1);
 assert.match(found.matches[0].text,/Deploy token rotation/);
 assert.ok(found.matches[0].score>0);

 const none=writtenText(await first.call('memory_search',{query:'quantum espresso'}));
 assert.equal(none.count,0);

 const listed=writtenText(await first.call('memory_list',{}));
 assert.equal(listed.total,2);

 const forgotten=writtenText(await first.call('memory_forget',{query:'coffee'}));
 assert.equal(forgotten.removed,1);
 assert.equal(forgotten.remaining,1);
 assert.deepEqual(forgotten.entries.map(entry=>entry.text),['The office coffee machine lives on floor 3']);

 const persisted=JSON.parse(await readFile(join(data,'toolpack-memory.json'),'utf8'));
 assert.equal(persisted.entries.length,1);
 assert.match(persisted.entries[0].text,/Deploy token rotation/);

 await first.close();
 assert.equal(first.exitCode,0);

 const second=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await second.kill();});
 const recalled=writtenText(await second.call('memory_search',{query:'friday token'}));
 assert.equal(recalled.count,1);
 assert.match(recalled.matches[0].text,/every Friday/);
 const cleared=writtenText(await second.call('memory_forget',{all:true}));
 assert.equal(cleared.removed,1);
 const empty=writtenText(await second.call('memory_list',{}));
 assert.equal(empty.total,0);

 const bad=await second.call('memory_add',{text:''});
 failure(bad);
});

// ---------------------------------------------------------------------------
test('git pack inspects and commits a real temporary repository',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'git'});
 const repository=join(files,'repo');
 await mkdir(repository,{recursive:true});
 const gitCommand=['git'];
 const gitBase=['-c','user.name=Toolpack Test','-c','user.email=toolpack@example.invalid','-c','commit.gpgsign=false'];
 const runGit=async args=>{
  const child=spawn(gitCommand[0],[...gitBase,...args],{cwd:repository,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const [code]=await once(child,'close');
  assert.equal(code,0,`git ${args.join(' ')} failed: ${stderr}`);
  return stdout;
 };
 await runGit(['init','-q']);
 // A real repository has an author identity; the git tool intentionally does not inject one.
 await runGit(['config','user.email','toolpack@example.invalid']);
 await runGit(['config','user.name','Toolpack Test']);
 await runGit(['config','commit.gpgsign','false']);
 await writeFile(join(repository,'tracked.txt'),'original line\n');
 await runGit(['add','tracked.txt']);
 await runGit(['commit','-q','-m','initial commit']);

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const clean=writtenText(await client.call('git_status',{path:'repo'}));
 assert.equal(clean.clean,true);
 assert.equal(clean.entries.length,0);
 assert.ok(clean.branch,'git_status must report the branch');
 assert.ok(clean.path.toLowerCase().endsWith('repo'));

 const log=writtenText(await client.call('git_log',{path:'repo'}));
 assert.equal(log.count,1);
 assert.equal(log.commits[0].subject,'initial commit');
 assert.match(log.commits[0].hash,/^[0-9a-f]{40}$/);

 await writeFile(join(repository,'tracked.txt'),'original line\nsecond line\n');
 const dirty=writtenText(await client.call('git_status',{path:'repo'}));
 assert.equal(dirty.clean,false);
 assert.equal(dirty.entries.length,1);
 assert.equal(dirty.entries[0].code,' M');
 assert.equal(dirty.entries[0].path,'tracked.txt');

 const diff=writtenText(await client.call('git_diff',{path:'repo'}));
 assert.match(diff.diff,/\+second line/);
 assert.ok(diff.lines>0);

 const staged=writtenText(await client.call('git_add',{path:'repo',files:['tracked.txt']}));
 assert.deepEqual(staged.staged,['tracked.txt']);
 const stagedDiff=writtenText(await client.call('git_diff',{path:'repo',staged:true}));
 assert.match(stagedDiff.diff,/\+second line/);

 const committed=writtenText(await client.call('git_commit',{path:'repo',message:'second commit'}));
 assert.match(committed.commit,/^[0-9a-f]{40}$/);
 assert.equal(committed.subject,'second commit');
 const after=writtenText(await client.call('git_log',{path:'repo',limit:5}));
 assert.equal(after.count,2);
 assert.equal(after.commits[0].subject,'second commit');

 const escaped=await client.call('git_add',{path:'repo',files:['../outside.txt']});
 failure(escaped,{message:/escapes the repository/});

 const notRepository=await client.call('git_status',{path:'.'});
 failure(notRepository);
});

// ---------------------------------------------------------------------------
test('user packs, disabled list and duplicate tool names are handled',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'packs'});
 const packDirectory=join(home,'toolpacks','mypack');
 await mkdir(packDirectory,{recursive:true});
 await writeFile(join(packDirectory,'index.mjs'),`
export const meta={name:'mypack',title:'My pack',version:'0.1.0',description:'User pack used by the toolpack host test'};
export const tools=[
 {name:'mypack_echo',description:'Echo the text argument back to the caller.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},run:async args=>({text:args.text})},
 {name:'mypack_ownenvelope',description:'Return a value that already carries its own boolean ok field.',inputSchema:{type:'object',properties:{}},run:async()=>({ok:true,note:'self-enveloped'})},
 {name:'mypack_fail',description:'Throw an error that already carries its own area-prefixed code.',inputSchema:{type:'object',properties:{}},run:async()=>{throw Object.assign(Error('boom from user pack'),{code:'mypack/boom'});}},
 {name:'file_read',description:'A shadowing duplicate that must never be exposed.',inputSchema:{type:'object',properties:{}},run:async()=>({shadow:true})},
];
`);
 const brokenDirectory=join(home,'toolpacks','broken');
 await mkdir(brokenDirectory,{recursive:true});
 await writeFile(join(brokenDirectory,'index.mjs'),`
export const meta={name:'broken',title:'Broken',version:'0.1.0',description:'Pack with an invalid tool name'};
export const tools=[{name:'Bad Tool',description:'invalid name',inputSchema:{type:'object',properties:{}},run:async()=>({})}];
`);

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});
 const tools=await client.tools();
 const names=tools.map(tool=>tool.name);
 assert.ok(names.includes('mypack_echo'),'user pack tool must be exposed');
 assert.equal(names.filter(name=>name==='file_read').length,1,'duplicate tool names must collapse to one');
 await sleep(150);
 assert.match(client.stderr,/ignoring duplicate tool name "file_read" from pack "mypack": already provided by pack "core"/);
 assert.match(client.stderr,/names must match/);
 assert.ok(!names.some(name=>name.includes('Bad')),'invalid tool names must not be exposed');
 assert.ok(!names.includes('Invalid name'),'rejected tools stay hidden');

 const echoed=writtenText(await client.call('mypack_echo',{text:'hello user pack'}));
 assert.equal(echoed.text,'hello user pack');
 const ownEnvelope=await client.call('mypack_ownenvelope',{});
 assert.equal(ownEnvelope.isError,false);
 assert.deepEqual(ownEnvelope.structuredContent,{ok:true,note:'self-enveloped'},'a tool value that already carries a boolean ok must pass through untouched');
 const userFailure=await client.call('mypack_fail',{});
 const userFailureError=failure(userFailure);
 assert.equal(userFailureError.code,'mypack/boom','a pack-supplied code must survive the host envelope');
 assert.equal(userFailureError.message,'boom from user pack');
 const coreRead=await client.call('file_read',{path:'missing.txt'});
 assert.equal(coreRead.isError,true,'the builtin file_read must win the name conflict');
 failure(coreRead);

 await writeFile(join(home,'codex-go-toolpacks.json'),JSON.stringify({disabled:['web','mypack']}));
 const disabledClient=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await disabledClient.kill();});
 const disabledNames=(await disabledClient.tools()).map(tool=>tool.name);
 assert.ok(!disabledNames.includes('web_fetch'),'disabled builtin pack must be hidden');
 assert.ok(!disabledNames.includes('mypack_echo'),'disabled user pack must be hidden');
 assert.ok(disabledNames.includes('git_status'),'other packs keep loading');
 await sleep(150);
 assert.ok(!disabledClient.stderr.includes('duplicate tool name'),'a disabled pack must not be imported at all');
});

// ---------------------------------------------------------------------------
test('web_fetch reads a local HTTP server with caps and clear errors',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'web'});
 const httpServer=createServer((request,response)=>{
  response.on('error',()=>{});
  if(request.url==='/page'){
   response.writeHead(200,{'content-type':'text/html; charset=utf-8','x-toolpack':'yes'});
   response.end('<html><body>toolpack-marker-42</body></html>');
   return;
  }
  if(request.url==='/big'){
   response.writeHead(200,{'content-type':'text/plain'});
   response.end('a'.repeat(2*1024*1024));
   return;
  }
  response.writeHead(404,{'content-type':'text/plain'});
  response.end('not found here');
 });
 httpServer.on('clientError',()=>{});
 await new Promise(resolveListen=>httpServer.listen(0,'127.0.0.1',resolveListen));
 const {port}=httpServer.address();
 t.after(()=>new Promise(done=>{httpServer.closeAllConnections?.();httpServer.close(()=>done());}));

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const page=writtenText(await client.call('web_fetch',{url:`http://127.0.0.1:${port}/page`}));
 assert.equal(page.status,200);
 assert.equal(page.ok,true);
 assert.match(page.text,/toolpack-marker-42/);
 assert.equal(page.headers['x-toolpack'],'yes');
 assert.match(page.contentType,/text\/html/);
 assert.equal(page.truncated,false);

 // web_fetch returns its own {ok,...} value, so the host passes it through untouched: there
 // is no .data wrapper and `ok` means "HTTP status was 2xx", not "the call succeeded".
 const missing=writtenText(await client.call('web_fetch',{url:`http://127.0.0.1:${port}/missing`}));
 assert.equal(missing.status,404);
 assert.equal(missing.ok,false);
 assert.match(missing.text,/not found here/);

 const big=writtenText(await client.call('web_fetch',{url:`http://127.0.0.1:${port}/big`}));
 assert.equal(big.truncated,true);
 assert.equal(big.bytes,1024*1024,'the body cap is exactly 1 MiB');
 assert.equal(big.text.length,1024*1024);

 const shortened=writtenText(await client.call('web_fetch',{url:`http://127.0.0.1:${port}/page`,maxChars:12}));
 assert.equal(shortened.text.length,12);
 assert.equal(shortened.truncated,true);

 const scheme=await client.call('web_fetch',{url:'file:///etc/passwd'});
 failure(scheme,{message:/http/i});

 const unreachable=await client.call('web_fetch',{url:'http://127.0.0.1:1/nope'});
 failure(unreachable);
});

// ---------------------------------------------------------------------------
test('system pack reports real facts and never prints secret values',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'system'});
 const secret='super-secret-value-1234567890';
 const client=await McpClient.start({roots:files,dataDir:data,home,env:{TOOLPACK_TEST_API_KEY:secret,TOOLPACK_TEST_GREETING:'hello-toolpacks'}});
 t.after(async()=>{await client.kill();});

 const uname=writtenText(await client.call('system_uname',{}));
 assert.equal(uname.platform,process.platform);
 assert.equal(uname.arch,process.arch);
 assert.equal(uname.node,process.version);
 assert.ok(uname.cpuCount>0);
 assert.ok(uname.totalMemoryBytes>0);
 assert.ok(uname.hostname.length>0);

 const df=writtenText(await client.call('system_df',{}));
 assert.equal(df.volumes.length,1);
 assert.ok(df.volumes[0].totalBytes>0);
 assert.ok(df.volumes[0].freeBytes>=0);
 assert.equal(typeof df.volumes[0].usedPercent,'number');

 const uptime=writtenText(await client.call('system_uptime',{}));
 assert.ok(uptime.systemUptimeSeconds>0);
 assert.ok(uptime.processUptimeSeconds>=0);
 assert.equal(uptime.loadAverage.length,3);

 const processes=writtenText(await client.call('system_process_list',{limit:25}));
 assert.ok(processes.total>0);
 assert.ok(processes.processes.length<=25);
 assert.equal(typeof processes.processes[0].pid,'number');
 assert.equal(typeof processes.processes[0].name,'string');

 const envResult=await client.call('system_env_redacted',{});
 const env=writtenText(envResult);
 const text=envResult.content[0].text;
 assert.ok(!text.includes(secret),'secret values must never be printed');
 assert.ok(env.redactedNames.includes('TOOLPACK_TEST_API_KEY'));
 const keyEntry=env.variables.find(entry=>entry.name==='TOOLPACK_TEST_API_KEY');
 assert.equal(keyEntry.redacted,true);
 assert.equal(keyEntry.value,null);
 const greeting=env.variables.find(entry=>entry.name==='TOOLPACK_TEST_GREETING');
 assert.equal(greeting.value,'hello-toolpacks');
});

// ---------------------------------------------------------------------------
test('bridge-backed tools fail clearly when no bridge handshake exists',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'bridge'});
 // No codex-go-bridge.json in this CODEX_HOME on purpose.
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});
 await sleep(150);
 assert.match(client.stderr,/no bridge handshake/i);

 const run=await client.call('subagent_run',{prompt:'Summarise the repository'});
 const runError=failure(run);
 assert.match(runError.message,/bridge/i);
 assert.match(runError.message,/handshake/i);
 assert.equal(run.structuredContent.data,undefined,'a failed tool must not fake a result');
 assert.match(run.content[0].text,/^[a-z][a-z0-9-]*\/[a-z0-9-]+: /,'a failure message must start with its code');

 const list=await client.call('subagent_list',{});
 failure(list,{message:/bridge/i});

 const created=writtenText(await client.call('workflow_create',{name:'prompt only',steps:[{type:'prompt',text:'Say hello'}]}));
 assert.ok(created.id);
 const runWorkflow=await client.call('workflow_run',{id:created.id});
 failure(runWorkflow,{message:/bridge/i});

 const shellWorkflow=writtenText(await client.call('workflow_create',{name:'shell only',steps:[{type:'shell',argv:[nodePath,'-e',"process.stdout.write('from-shell')"]}]}));
 const withoutApproval=await client.call('workflow_run',{id:shellWorkflow.id});
 failure(withoutApproval,{message:/approveShell/});
 const approved=writtenText(await client.call('workflow_run',{id:shellWorkflow.id,approveShell:true}));
 assert.deepEqual(approved.steps.map(step=>step.stdout),['from-shell']);

 const listed=writtenText(await client.call('workflow_list',{}));
 assert.equal(listed.workflows.length,2);
 const history=writtenText(await client.call('workflow_get',{id:shellWorkflow.id}));
 assert.ok(history.runs.some(entry=>entry.status==='completed'));
});

// ---------------------------------------------------------------------------
// CONTRACT-V2 section E packs.
// ---------------------------------------------------------------------------
test('files pack covers existence, metadata, hashing, move/copy/append/truncate and a tar.gz round-trip',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'files'});
 await mkdir(join(files,'docs'),{recursive:true});
 await mkdir(join(files,'nested'),{recursive:true});
 await writeFile(join(files,'docs','a.txt'),'hello toolpacks');

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const file=writtenText(await client.call('file_exists',{path:'docs/a.txt'}));
 assert.equal(file.exists,true);
 assert.equal(file.type,'file');
 assert.equal(file.bytes,15);
 const missing=writtenText(await client.call('file_exists',{path:'docs/missing.txt'}));
 assert.equal(missing.exists,false);
 assert.equal(missing.type,null);
 const directory=writtenText(await client.call('file_exists',{path:'docs'}));
 assert.equal(directory.type,'directory');
 const escaped=await client.call('file_exists',{path:'../outside.txt'});
 failure(escaped,{message:/outside the allowed roots/i});

 const info=writtenText(await client.call('file_info',{path:'docs/a.txt'}));
 assert.equal(info.type,'file');
 assert.equal(info.bytes,15);
 assert.match(info.mode,/^0o[0-7]{4}$/);
 assert.match(info.realPath,/a\.txt$/);
 assert.match(info.modifiedAt,/^\d{4}-\d\d-\d\dT/);

 const expectedSha256=createHash('sha256').update('hello toolpacks').digest('hex');
 const hash=writtenText(await client.call('file_hash',{path:'docs/a.txt'}));
 assert.equal(hash.algorithm,'sha256');
 assert.equal(hash.hash,expectedSha256);
 assert.equal(hash.bytes,15);
 const sha1=writtenText(await client.call('file_hash',{path:'docs/a.txt',algorithm:'sha1'}));
 assert.equal(sha1.hash,createHash('sha1').update('hello toolpacks').digest('hex'));

 const appended=writtenText(await client.call('file_append',{path:'docs/a.txt',content:' world'}));
 assert.equal(appended.created,false);
 assert.equal(appended.previousSize,15);
 assert.equal(appended.size,21);
 assert.equal(await readFile(join(files,'docs','a.txt'),'utf8'),'hello toolpacks world');

 const copied=writtenText(await client.call('file_copy',{from:'docs/a.txt',to:'docs/b.txt'}));
 assert.equal(copied.overwritten,false);
 assert.equal(copied.bytes,21);
 assert.equal(await readFile(join(files,'docs','b.txt'),'utf8'),'hello toolpacks world');
 const refusedCopy=await client.call('file_copy',{from:'docs/a.txt',to:'docs/b.txt'});
 failure(refusedCopy,{message:/already exists/i});

 const moved=writtenText(await client.call('file_move',{from:'docs/b.txt',to:'nested/c.txt'}));
 assert.equal(moved.moved,true);
 assert.equal(moved.type,'file');
 failure(await client.call('file_info',{path:'docs/b.txt'}));
 const refusedMove=await client.call('file_move',{from:'nested/c.txt',to:'docs/a.txt'});
 failure(refusedMove,{message:/already exists/i});
 const overwritten=writtenText(await client.call('file_move',{from:'nested/c.txt',to:'docs/a.txt',overwrite:true}));
 assert.equal(overwritten.overwritten,true);
 assert.equal(await readFile(join(files,'docs','a.txt'),'utf8'),'hello toolpacks world');

 const truncated=writtenText(await client.call('file_truncate',{path:'docs/a.txt',size:5}));
 assert.equal(truncated.size,5);
 assert.equal(truncated.shrunk,true);
 assert.equal(await readFile(join(files,'docs','a.txt'),'utf8'),'hello');
 const grow=await client.call('file_truncate',{path:'docs/a.txt',size:9});
 failure(grow,{message:/allowExtend/});

 await mkdir(join(files,'bundle','sub'),{recursive:true});
 await writeFile(join(files,'bundle','one.txt'),'first archive member');
 await writeFile(join(files,'bundle','sub','two.txt'),'second archive member');
 const created=await client.call('archive_create',{output:'bundle.tar.gz',base:'bundle',paths:['bundle']});
 if(created.isError&&/`tar` executable/i.test(created.content[0].text)){
  failure(created,{message:/`tar` executable/i});
  t.diagnostic('system tar is not installed; tar.gz round-trip skipped on this host');
 }else{
  const archive=writtenText(created);
  assert.equal(archive.format,'tar.gz');
  assert.ok(archive.bytes>0);
  assert.match(archive.implementation,/shell:false/);
  await mkdir(join(files,'restored'),{recursive:true});
  const extracted=writtenText(await client.call('archive_extract',{archive:'bundle.tar.gz',destination:'restored'}));
  assert.ok(extracted.files>=2);
  assert.equal(await readFile(join(files,'restored','one.txt'),'utf8'),'first archive member');
  assert.equal(await readFile(join(files,'restored','sub','two.txt'),'utf8'),'second archive member');
 }
 const zip=await client.call('archive_create',{output:'bundle.zip',format:'zip'});
 failure(zip,{message:/tar\.gz/});
 const absent=await client.call('archive_extract',{archive:'does-not-exist.tar.gz'});
 failure(absent);
});

// ---------------------------------------------------------------------------
test('text pack converts encodings, diffs, sorts, dedupes, counts and replaces',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'text'});
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const encoded=writtenText(await client.call('text_convert',{text:'hello 世界',to:'base64'}));
 assert.equal(encoded.from,'utf8');
 assert.equal(encoded.to,'base64');
 assert.equal(encoded.text,Buffer.from('hello 世界','utf8').toString('base64'));
 assert.equal(encoded.inputBytes,Buffer.byteLength('hello 世界'));
 const decoded=writtenText(await client.call('text_convert',{text:encoded.text,from:'base64',to:'utf8'}));
 assert.equal(decoded.text,'hello 世界');

 await writeFile(join(files,'notes.txt'),'alpha\n');
 const hex=writtenText(await client.call('text_convert',{path:'notes.txt',to:'hex'}));
 assert.equal(hex.source,'file');
 assert.equal(hex.text,Buffer.from('alpha\n','utf8').toString('hex'));
 await mkdir(join(files,'out'),{recursive:true});
 const written=writtenText(await client.call('text_convert',{text:'written',to:'base64',outputPath:'out/b64.txt'}));
 assert.equal(await readFile(join(files,'out','b64.txt'),'utf8'),written.text);

 const diff=writtenText(await client.call('text_diff',{a:'a\nb\nc',b:'a\nB\nc\nd',context:1}));
 assert.equal(diff.identical,false);
 assert.equal(diff.added,2);
 assert.equal(diff.removed,1);
 assert.equal(diff.unchanged,2);
 assert.equal(diff.left.lines,3);
 assert.match(diff.unified,/^--- left$/m);
 assert.match(diff.unified,/^\+B$/m);
 assert.match(diff.unified,/^-b$/m);
 const identical=writtenText(await client.call('text_diff',{a:'same',b:'same'}));
 assert.equal(identical.identical,true);
 assert.equal(identical.unified,'');
 assert.equal(identical.added,0);

 const sorted=writtenText(await client.call('text_sort',{text:'10\n2\n1\n',numeric:true}));
 assert.equal(sorted.text,'1\n2\n10\n');
 assert.equal(sorted.outputLines,3);
 const descending=writtenText(await client.call('text_sort',{text:'banana\nApple\ncherry',order:'desc'}));
 assert.equal(descending.text,'cherry\nbanana\nApple');

 const unique=writtenText(await client.call('text_unique',{text:'a\nb\na\nA\n',count:false}));
 assert.equal(unique.totalLines,4);
 assert.equal(unique.uniqueLines,2);
 assert.equal(unique.removedDuplicates,2);
 assert.equal(unique.text,'a\nb\n');
 const counted=writtenText(await client.call('text_unique',{text:'x\nx\ny',sortByCount:true}));
 assert.equal(counted.entries[0].line,'x');
 assert.equal(counted.entries[0].count,2);

 const words=writtenText(await client.call('text_word_count',{text:'Hello world. Hello again!\n\nSecond paragraph.'}));
 assert.equal(words.words,6);
 assert.equal(words.paragraphs,2);
 assert.equal(words.sentences,3);
 assert.equal(words.lines,3);
 assert.equal(words.topWords[0].word,'hello');
 assert.equal(words.topWords[0].count,2);
 assert.ok(words.characters>words.charactersNoSpaces);

 const regexReplace=writtenText(await client.call('text_replace',{text:'a1b22c333',pattern:'\\d+',replacement:'#',regex:true}));
 assert.equal(regexReplace.text,'a#b#c#');
 assert.equal(regexReplace.replacements,3);
 const literalReplace=writtenText(await client.call('text_replace',{text:'a.b.a.b',pattern:'a.b',replacement:'X'}));
 assert.equal(literalReplace.text,'X.X','a literal pattern must not be treated as a regular expression');
 const firstOnly=writtenText(await client.call('text_replace',{text:'one one',pattern:'one',replacement:'two',all:false}));
 assert.equal(firstOnly.text,'two one');
 const toFile=writtenText(await client.call('text_replace',{text:'rename this',pattern:'this',replacement:'that',outputPath:'out/replaced.txt'}));
 assert.match(toFile.outputPath,/replaced\.txt$/);
 assert.equal(await readFile(join(files,'out','replaced.txt'),'utf8'),'rename that');
 const badRegex=await client.call('text_replace',{text:'x',pattern:'(',replacement:'y',regex:true});
 failure(badRegex);
});

// ---------------------------------------------------------------------------
const DDG_HTML=`<html><body>
<div class="result results_links web-result">
 <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/toolpacks')}&amp;rut=abc123">Toolpacks &amp; more</a></h2>
 <a class="result__snippet" href="#">First <b>toolpack</b> snippet &amp; detail</a>
</div>
<div class="result results_links web-result">
 <a class="result__a" href="https://example.org/second">Second result</a>
 <a class="result__snippet" href="#">Second snippet text</a>
</div>
</body></html>`;

const DDG_NEWS_HTML=`<html><body>
<div class="result result--news">
 <a class="result__a" href="https://news.example.com/story">Toolpacks shipped</a>
 <a class="result__snippet" href="#">Release news snippet</a>
</div>
</body></html>`;

test('net pack speaks real HTTP, keeps cookies, parses DuckDuckGo/Crossref fixtures and rejects bad schemes',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'net'});
 const requests=[];
 const httpServer=createServer((request,response)=>{
  response.on('error',()=>{});
  const chunks=[];
  request.on('data',chunk=>{chunks.push(chunk);});
  request.on('end',()=>{
   const body=Buffer.concat(chunks).toString('utf8');
   requests.push({method:request.method,url:request.url,body});
   const pathname=new URL(request.url,'http://127.0.0.1').pathname;
   if(pathname==='/echo'){
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({method:request.method,url:request.url,headers:request.headers,body}));
    return;
   }
   if(pathname==='/set-cookie'){
    response.writeHead(200,{'content-type':'text/plain','set-cookie':['sid=abc123; Path=/; HttpOnly','theme=dark; Path=/']});
    response.end('cookies set');
    return;
   }
   if(pathname==='/big'){
    response.writeHead(200,{'content-type':'text/plain'});
    response.end('a'.repeat(3*1024*1024));
    return;
   }
   if(pathname==='/download.txt'){
    response.writeHead(200,{'content-type':'text/plain'});
    response.end('downloaded-content');
    return;
   }
   if(pathname==='/html/'){
    const vertical=new URL(request.url,'http://127.0.0.1').searchParams.get('iar');
    response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
    response.end(vertical==='news'?DDG_NEWS_HTML:DDG_HTML);
    return;
   }
   if(pathname==='/works'){
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({message:{'total-results':1,items:[{
     DOI:'10.1234/example',
     title:['A toolpack study'],
     author:[{given:'Ada',family:'Lovelace'}],
     'container-title':['Journal of Toolpacks'],
     publisher:'Example Press',
     type:'journal-article',
     issued:{'date-parts':[[2024,5,1]]},
     URL:'https://doi.org/10.1234/example',
     'is-referenced-by-count':7,
    }]}}));
    return;
   }
   if(pathname==='/slow'){
    // Accept the request and never answer: the host timeout must fire, not the tool's own.
    return;
   }
   response.writeHead(404,{'content-type':'text/plain'});
   response.end('not found');
  });
 });
 httpServer.on('clientError',()=>{});
 await new Promise(done=>httpServer.listen(0,'127.0.0.1',done));
 const {port}=httpServer.address();
 t.after(()=>new Promise(done=>{httpServer.closeAllConnections?.();httpServer.close(()=>done());}));
 const base=`http://127.0.0.1:${port}`;

 const client=await McpClient.start({
  roots:files,dataDir:data,home,
  env:{CODEX_GO_SEARCH_BASE:base,CODEX_GO_CROSSREF_BASE:base},
 });
 t.after(async()=>{await client.kill();});

 const echoed=writtenText(await client.call('http_request',{url:`${base}/echo`,method:'POST',headers:{'x-toolpack-test':'yes'},body:'payload-42'}));
 assert.equal(echoed.status,200);
 assert.equal(echoed.ok,true);
 assert.equal(echoed.method,'POST');
 assert.equal(echoed.truncated,false);
 const echoedBody=JSON.parse(echoed.text);
 assert.equal(echoedBody.method,'POST');
 assert.equal(echoedBody.body,'payload-42');
 assert.equal(echoedBody.headers['x-toolpack-test'],'yes');

 const fetched=writtenText(await client.call('http_request',{url:`${base}/echo`}));
 assert.equal(fetched.method,'GET');
 assert.equal(fetched.contentType,'application/json');

 const big=writtenText(await client.call('http_request',{url:`${base}/big`}));
 assert.equal(big.truncated,true);
 assert.equal(big.bytes,2*1024*1024,'http_request caps the body at 2 MiB');

 const scheme=await client.call('http_request',{url:'file:///etc/passwd'});
 failure(scheme,{message:/http/i});

 const cookies=writtenText(await client.call('http_request',{url:`${base}/set-cookie`}));
 assert.equal(cookies.status,200);
 const jar=writtenText(await client.call('cookie_store_list',{host:`127.0.0.1:${port}`}));
 assert.equal(jar.count,2);
 assert.deepEqual(jar.cookies.map(cookie=>cookie.name).sort(),['sid','theme']);
 assert.equal(jar.cookies.find(cookie=>cookie.name==='sid').value,'abc123');

 const downloaded=writtenText(await client.call('http_download',{url:`${base}/download.txt`,path:'download.txt'}));
 assert.equal(downloaded.bytes,18);
 assert.equal(downloaded.sha256,createHash('sha256').update('downloaded-content').digest('hex'));
 assert.equal(await readFile(join(files,'download.txt'),'utf8'),'downloaded-content');
 const refusedDownload=await client.call('http_download',{url:`${base}/download.txt`,path:'download.txt'});
 failure(refusedDownload,{message:/already exists/i});

 const search=writtenText(await client.call('web_search',{query:'toolpacks',maxResults:5}));
 assert.equal(search.engine,'duckduckgo-html');
 assert.equal(search.vertical,'web');
 assert.equal(search.resultCount,2);
 assert.equal(search.results[0].url,'https://example.com/toolpacks','the uddg redirect must be unwrapped');
 assert.equal(search.results[0].title,'Toolpacks & more');
 assert.match(search.results[0].snippet,/First toolpack snippet & detail/);
 assert.equal(search.results[1].url,'https://example.org/second');
 assert.equal(search.results[1].snippet,'Second snippet text');
 assert.match(search.endpoint,new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/html/`));
 assert.ok(requests.some(entry=>entry.url.startsWith('/html/?q=toolpacks')),'the DuckDuckGo query must be a real request');

 const news=writtenText(await client.call('web_search_news',{query:'toolpacks release'}));
 assert.equal(news.vertical,'news');
 assert.equal(news.resultCount,1);
 assert.equal(news.results[0].title,'Toolpacks shipped');
 assert.match(news.endpoint,/iar=news/);
 assert.equal(news.results[0].url,'https://news.example.com/story');

 const works=writtenText(await client.call('crossref_search',{query:'toolpacks',rows:3}));
 assert.equal(works.source,'crossref');
 assert.equal(works.count,1);
 assert.equal(works.works[0].doi,'10.1234/example');
 assert.equal(works.works[0].title,'A toolpack study');
 assert.deepEqual(works.works[0].authors,['Ada Lovelace']);
 assert.equal(works.works[0].year,2024);
 assert.equal(works.works[0].citations,7);

 const badGithubPath=await client.call('github_api',{path:'repos/owner/name'});
 failure(badGithubPath,{message:/start with/i});
 const badGithubMethod=await client.call('github_api',{path:'/rate_limit',method:'TRACE'});
 failure(badGithubMethod,{message:/Unsupported GitHub method/i});

 const offline=await McpClient.start({
  roots:files,dataDir:data,home,
  env:{CODEX_GO_SEARCH_BASE:'http://127.0.0.1:1'},
 });
 t.after(async()=>{await offline.kill();});
 const failedSearch=await offline.call('web_search',{query:'toolpacks',timeoutMs:2000});
 failure(failedSearch,{message:/failed|timed out/i});

 // The host timeout is a failure path with its own stable code. CODEX_GO_TOOL_TIMEOUT_MS
 // shrinks the 120 s default so the test does not have to wait for a real stall.
 const slow=await McpClient.start({
  roots:files,dataDir:data,home,
  env:{CODEX_GO_TOOL_TIMEOUT_MS:'400'},
 });
 t.after(async()=>{await slow.kill();});
 const timedOut=await slow.call('http_request',{url:`${base}/slow`,timeoutMs:5000});
 const timeoutError=failure(timedOut,{message:/timed out after 400ms/i});
 assert.equal(timeoutError.code,'tool/timeout','a host timeout must be reported as tool/timeout');
 assert.match(timeoutError.message,/http_request/,'the timeout message must name the tool that stalled');
});

// ---------------------------------------------------------------------------
test('code pack runs real node/python processes with timeout, output cap and honest toolchains',{timeout:120000},async t=>{
 const {home,files,data}=await workspace(t,{name:'code'});
 await writeFile(join(files,'script.mjs'),'console.log("file-args:"+process.argv.slice(2).join(","));\n');
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const toolchains=writtenText(await client.call('code_toolchains',{}));
 assert.deepEqual(toolchains.checked,['python','node','bash','gcc','go','rustc']);
 assert.ok(toolchains.available.includes('node'),'node must be detected because it is running this server');
 assert.equal(toolchains.platform,process.platform);
 for(const entry of toolchains.toolchains){
  assert.equal(typeof entry.available,'boolean');
  if(entry.available)assert.equal(typeof entry.command,'string');
  else assert.ok(Array.isArray(entry.tried)&&entry.tried.length>0,`${entry.name} must record what it probed`);
 }
 const pythonEntry=toolchains.toolchains.find(entry=>entry.name==='python');
 const bashEntry=toolchains.toolchains.find(entry=>entry.name==='bash');

 const nodeRun=writtenText(await client.call('code_run_node',{code:'console.log("node-ok")'}));
 assert.equal(nodeRun.exitCode,0);
 assert.equal(nodeRun.stdout.trim(),'node-ok');
 assert.equal(nodeRun.stderr,'');
 assert.equal(nodeRun.timedOut,false);
 assert.equal(nodeRun.truncated,false);
 assert.equal(nodeRun.interpreter.name,'node');

 const fileRun=writtenText(await client.call('code_run_node_file',{path:'script.mjs',args:['alpha','beta']}));
 assert.equal(fileRun.exitCode,0);
 assert.equal(fileRun.stdout.trim(),'file-args:alpha,beta');
 assert.match(fileRun.script,/script\.mjs$/);

 const failing=writtenText(await client.call('code_run_node',{code:'process.exit(3)'}));
 assert.equal(failing.exitCode,3,'a non-zero exit is reported as a structured result, not a tool failure');
 const throwing=writtenText(await client.call('code_run_node',{code:'throw new Error("boom")'}));
 assert.notEqual(throwing.exitCode,0);
 assert.match(throwing.stderr,/boom/);

 const timeout=writtenText(await client.call('code_run_node',{code:'setTimeout(()=>{},10000)',timeoutMs:1000}));
 assert.equal(timeout.timedOut,true);
 assert.equal(timeout.timeoutMs,1000);

 const big=writtenText(await client.call('code_run_node',{code:'process.stdout.write("a".repeat(1200000))'}));
 assert.equal(big.truncated,true,'output above 1 MiB must be flagged');
 assert.equal(big.stdout.length,1024*1024);

 if(pythonEntry.available){
  const python=writtenText(await client.call('code_run_python',{code:'import sys\nprint("py-ok", sys.version_info[0])'}));
  assert.equal(python.exitCode,0);
  assert.match(python.stdout,/py-ok 3/);
  await writeFile(join(files,'script.py'),'import sys\nprint("py-file:"+",".join(sys.argv[1:]))\n');
  const pythonFile=writtenText(await client.call('code_run_python_file',{path:'script.py',args:['x','y']}));
  assert.equal(pythonFile.stdout.trim(),'py-file:x,y');
 }else{
  const missingPython=await client.call('code_run_python',{code:'print(1)'});
  const missingPythonError=failure(missingPython,{message:/Python 3 is not installed/i});
  assert.match(missingPythonError.message,/Nothing was executed/i);
 }

 if(bashEntry.available){
  const shell=writtenText(await client.call('code_run_shell',{script:'echo shell-ok'}));
  assert.equal(shell.exitCode,0);
  assert.equal(shell.stdout.trim(),'shell-ok');
 }else{
  const missingShell=await client.call('code_run_shell',{script:'echo hi'});
  failure(missingShell,{message:/Bash is not installed/i});
 }
});

// ---------------------------------------------------------------------------
test('plan, worldbook and memoryx persist real state across a restart',{timeout:120000},async t=>{
 const {home,files,data}=await workspace(t,{name:'state'});
 await mkdir(join(files,'export'),{recursive:true});
 const first=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await first.kill();});

 const empty=writtenText(await first.call('plan_get',{}));
 assert.equal(empty.plan,null);
 assert.equal(empty.count,0);

 const created=writtenText(await first.call('plan_create',{title:'Ship toolpacks v2',steps:[{title:'write packs'},{title:'write tests',note:'real assertions'}]}));
 const planId=created.plan.id;
 assert.equal(created.created,true);
 assert.equal(created.plan.steps.length,2);
 assert.equal(created.plan.counts.total,2);
 assert.equal(created.plan.counts.pending,2);
 const added=writtenText(await first.call('plan_add_step',{planId,title:'run tests'}));
 const stepId=added.step.id;
 assert.equal(added.plan.steps.length,3);
 const updated=writtenText(await first.call('plan_update_step',{stepId,status:'done'}));
 assert.equal(updated.step.status,'done');
 assert.equal(updated.plan.counts.done,1);
 assert.equal(updated.plan.counts.pending,2);
 const badStatus=await first.call('plan_update_step',{stepId,status:'finished'});
 failure(badStatus);
 const currentPlan=writtenText(await first.call('plan_get',{}));
 assert.equal(currentPlan.plan.id,planId);
 assert.equal(currentPlan.plans.length,1);
 const completed=writtenText(await first.call('plan_complete',{planId,summary:'all done',completeSteps:true}));
 assert.equal(completed.plan.status,'completed');
 assert.equal(completed.plan.summary,'all done');
 assert.equal(completed.remainingOpen,0);
 assert.equal(completed.plan.counts.done,3);
 const planStore=JSON.parse(await readFile(join(data,'toolpack-plan.json'),'utf8'));
 assert.equal(planStore.plans.length,1);
 assert.equal(planStore.plans[0].status,'completed');
 assert.equal(planStore.plans[0].steps.length,3);

 const lore=writtenText(await first.call('wb_create',{title:'Dragons',content:'Dragons live in the northern mountains.',keys:['dragon','wyrm'],tags:['lore']}));
 assert.equal(lore.entry.enabled,true);
 assert.deepEqual(lore.entry.keys,['dragon','wyrm']);
 const duplicateTitle=await first.call('wb_create',{title:'Dragons',content:'duplicate'});
 failure(duplicateTitle,{message:/already exists/i});
 const fetched=writtenText(await first.call('wb_get',{title:'Dragons'}));
 assert.equal(fetched.entry.id,lore.entry.id);
 assert.equal(fetched.entry.content,'Dragons live in the northern mountains.');
 const updatedLore=writtenText(await first.call('wb_update',{id:lore.entry.id,content:'Dragons live in the northern mountains and hoard toolpacks.'}));
 assert.match(updatedLore.entry.content,/hoard toolpacks/);
 const search=writtenText(await first.call('wb_search',{query:'dragon'}));
 assert.equal(search.count,1);
 assert.ok(search.matches[0].score>0);
 assert.match(search.matches[0].snippet,/Dragons live/);
 const imported=writtenText(await first.call('wb_import',{json:{entries:{
  '0':{key:['ship'],comment:'Ships',content:'Ships cross the eastern sea.',disable:false},
  '1':{key:['king'],comment:'The King',content:'The king rules from the keep.'},
 }}}));
 assert.equal(imported.imported,2);
 assert.equal(imported.total,3);
 const exported=writtenText(await first.call('wb_export',{format:'tavern',path:'export/worldbook.json'}));
 assert.equal(exported.count,3);
 const tavern=JSON.parse(await readFile(join(files,'export','worldbook.json'),'utf8'));
 assert.equal(Object.keys(tavern.entries).length,3);
 assert.equal(tavern.entries['0'].comment,'Dragons');
 assert.deepEqual(tavern.entries['0'].key,['dragon','wyrm']);
 assert.equal(tavern.entries['0'].disable,false);
 const deletedLore=writtenText(await first.call('wb_delete',{id:lore.entry.id}));
 assert.equal(deletedLore.remaining,2);
 const listedWorldbook=writtenText(await first.call('wb_list',{}));
 assert.equal(listedWorldbook.total,2);
 const worldbookStore=JSON.parse(await readFile(join(data,'toolpack-worldbook.json'),'utf8'));
 assert.equal(worldbookStore.entries.length,2);

 // memoryx intentionally shares the `memory` pack store: create with memory_add, edit with memoryx.
 const noteA=writtenText(await first.call('memory_add',{text:'Deploy rotation happens every Friday',tags:['ops']}));
 const noteB=writtenText(await first.call('memory_add',{text:'The deploy key lives in the vault',tags:['ops']}));
 const changed=writtenText(await first.call('memory_update',{id:noteA.entry.id,newText:'Deploy rotation happens every Friday at 03:00 UTC',addTags:['deploy']}));
 assert.match(changed.memory.text,/03:00 UTC/);
 assert.deepEqual(changed.memory.tags,['ops','deploy']);
 assert.equal(changed.store,'toolpack-memory.json');
 const recalled=writtenText(await first.call('memory_search',{query:'rotation'}));
 assert.equal(recalled.count,1);
 assert.match(recalled.matches[0].text,/03:00 UTC/);
 const linked=writtenText(await first.call('memory_link',{from:noteA.entry.id,to:noteB.entry.id,relation:'depends_on'}));
 assert.equal(linked.created,true);
 assert.equal(linked.link.from,noteA.entry.id);
 const duplicateLink=writtenText(await first.call('memory_link',{from:noteA.entry.id,to:noteB.entry.id,relation:'depends_on'}));
 assert.equal(duplicateLink.created,false);
 const links=writtenText(await first.call('memory_links',{id:noteA.entry.id}));
 assert.equal(links.count,1);
 assert.equal(links.links[0].relation,'depends_on');
 assert.match(links.links[0].toText,/vault/);
 const prefsSet=writtenText(await first.call('memory_preferences_set',{key:'theme',value:'dark'}));
 assert.equal(prefsSet.preferences.theme,'dark');
 writtenText(await first.call('memory_preferences_set',{preferences:{language:'zh-CN'}}));
 const prefs=writtenText(await first.call('memory_preferences_get',{}));
 assert.equal(prefs.preferences.theme,'dark');
 assert.equal(prefs.preferences.language,'zh-CN');
 assert.equal(prefs.keys,2);
 const removed=writtenText(await first.call('memory_delete',{id:noteB.entry.id}));
 assert.equal(removed.removed,1);
 assert.equal(removed.linksRemoved,1,'deleting a linked note must drop its links');
 assert.equal(removed.remaining,1);
 const remainingNotes=writtenText(await first.call('memory_list',{}));
 assert.equal(remainingNotes.total,1);
 assert.equal(remainingNotes.entries[0].text,'Deploy rotation happens every Friday at 03:00 UTC');
 const stateStore=JSON.parse(await readFile(join(data,'toolpack-memoryx.json'),'utf8'));
 assert.equal(stateStore.links.length,0);
 assert.equal(stateStore.preferences.theme,'dark');

 await first.close();
 assert.equal(first.exitCode,0);

 const second=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await second.kill();});
 const persistedPlan=writtenText(await second.call('plan_get',{id:planId}));
 assert.equal(persistedPlan.plan.status,'completed');
 assert.equal(persistedPlan.plan.title,'Ship toolpacks v2');
 const persistedWorldbook=writtenText(await second.call('wb_list',{}));
 assert.equal(persistedWorldbook.total,2);
 const persistedPrefs=writtenText(await second.call('memory_preferences_get',{}));
 assert.equal(persistedPrefs.preferences.theme,'dark');
 const persistedNote=writtenText(await second.call('memory_search',{query:'rotation'}));
 assert.equal(persistedNote.count,1);
});

// ---------------------------------------------------------------------------
test('admin and threads packs fail clearly without a bridge handshake',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'admin'});
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const cases=[
  ['pkg_list',{}],
  ['pkg_set_enabled',{name:'files',enabled:false}],
  ['pkg_install',{path:'/tmp/some-pack'}],
  ['context_get',{}],
  ['context_set',{thresholdPercent:80}],
  ['model_list',{}],
  ['model_set',{model:'gpt-5'}],
  ['persona_get',{}],
  ['persona_set',{name:'Aide'}],
  ['ping',{}],
  ['thread_list',{}],
  ['thread_read',{threadId:'thread-1'}],
  ['thread_rename',{threadId:'thread-1',title:'renamed'}],
  ['thread_delete',{threadId:'thread-1'}],
  ['thread_send',{threadId:'thread-1',text:'hello'}],
 ];
 for(const [name,args] of cases){
  const result=await client.call(name,args);
  assert.equal(result.isError,true,`${name} must fail without a bridge handshake`);
  failure(result,{message:/handshake/i});
  assert.ok(result.structuredContent.error.code.length>0,`${name} must name a stable error code`);
  assert.equal(result.structuredContent.data,undefined,`${name} must not fake a result`);
 }
});

// ---------------------------------------------------------------------------
test('admin and threads packs speak the documented bridge endpoints',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'bridge-api'});
 const calls=[];
 const bridgeServer=createServer((request,response)=>{
  response.on('error',()=>{});
  const chunks=[];
  request.on('data',chunk=>{chunks.push(chunk);});
  request.on('end',()=>{
   const raw=Buffer.concat(chunks).toString('utf8');
   const url=new URL(request.url,'http://127.0.0.1');
   const body=raw?JSON.parse(raw):null;
   calls.push({method:request.method,path:url.pathname,body,authorization:request.headers.authorization??null});
   const send=(status,value)=>{
    response.writeHead(status,{'content-type':'application/json'});
    response.end(JSON.stringify(value));
   };
   if(url.pathname==='/healthz')return send(200,{ok:true,engine:'codex',mode:'app-server',bridge:'2.0.0',codexVersion:'0.170.0',activeTurns:0});
   if(url.pathname==='/api/context')return send(200,{enabled:true,thresholdPercent:75,keepRecentTurns:4,autoCompact:true,summaryModel:null,usage:{totalTokens:1000,contextWindow:10000,percent:10}});
   if(url.pathname==='/api/context/config')return send(200,{...body,usage:{totalTokens:1000,contextWindow:10000,percent:10}});
   if(url.pathname==='/api/models')return send(200,{models:[{id:'gpt-5',name:'gpt-5',displayName:'GPT-5'}]});
   if(url.pathname==='/api/config')return send(200,{saved:true,...body});
   if(url.pathname==='/api/persona')return send(200,{name:'Aide',style:'terse',instructions:'be helpful',active:true,path:'/root/.codex/AGENTS.md'});
   if(url.pathname==='/api/persona/save')return send(200,{...body,path:'/root/.codex/AGENTS.md'});
   if(url.pathname==='/api/toolpacks')return send(200,{packs:[{name:'files',title:'Files',version:'2.0.0',description:'file tools',builtin:true,enabled:true,tools:['file_exists']}]});
   if(url.pathname==='/api/toolpacks/toggle')return send(200,{name:body.name,enabled:body.enabled});
   if(url.pathname==='/api/toolpacks/import')return send(200,{name:'mypack'});
   if(url.pathname==='/api/thread/list')return send(200,{threads:[{id:'thread-1',name:'First thread',preview:'hello there',cwd:'/work',updatedAt:'2026-01-01T00:00:00Z'}],nextCursor:null});
   if(url.pathname==='/api/thread/resume')return send(200,{threadId:'thread-1',thread:{id:'thread-1',name:'First thread'},items:[
    {type:'message',role:'user',content:[{type:'input_text',text:'hello'}],turnId:'turn-1'},
    {type:'message',role:'assistant',content:[{type:'output_text',text:'hi back'}],turnId:'turn-1'},
   ],nextCursor:null});
   if(url.pathname==='/api/thread/rename')return send(200,{ok:true});
   if(url.pathname==='/api/thread/archive')return send(200,{ok:true});
   if(url.pathname==='/api/turn/send')return send(200,{threadId:body.threadId,turnId:'turn-2'});
   return send(404,{error:{code:'request/not-found',message:'Unknown bridge endpoint'}});
  });
 });
 bridgeServer.on('clientError',()=>{});
 await new Promise(done=>bridgeServer.listen(0,'127.0.0.1',done));
 const {port}=bridgeServer.address();
 t.after(()=>new Promise(done=>{bridgeServer.closeAllConnections?.();bridgeServer.close(()=>done());}));
 const baseUrl=`http://127.0.0.1:${port}`;
 const token='bridge-test-token';
 await writeFile(join(home,'codex-go-bridge.json'),JSON.stringify({baseUrl,token,pid:process.pid,startedAt:Date.now(),version:'2.0.0'}));

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const ping=writtenText(await client.call('ping',{}));
 assert.equal(ping.handshake,true);
 assert.equal(ping.reachable,true);
 assert.equal(ping.ok,true);
 assert.equal(ping.engine,'codex');

 const packs=writtenText(await client.call('pkg_list',{}));
 assert.equal(packs.count,1);
 assert.equal(packs.packs[0].name,'files');
 const toggled=writtenText(await client.call('pkg_set_enabled',{name:'files',enabled:false}));
 assert.equal(toggled.enabled,false);
 const installed=writtenText(await client.call('pkg_install',{path:'/tmp/some-pack'}));
 assert.equal(installed.installed,true);
 assert.equal(installed.name,'mypack');

 const context=writtenText(await client.call('context_get',{}));
 assert.equal(context.thresholdPercent,75);
 assert.equal(context.usage.totalTokens,1000);
 const changed=writtenText(await client.call('context_set',{thresholdPercent:80,autoCompact:true}));
 assert.equal(changed.thresholdPercent,80);
 assert.equal(changed.autoCompact,true);
 const invalidContext=await client.call('context_set',{thresholdPercent:5});
 failure(invalidContext,{message:/between 10 and 95/});

 const models=writtenText(await client.call('model_list',{}));
 assert.equal(models.count,1);
 assert.equal(models.models[0].id,'gpt-5');
 const modelSaved=writtenText(await client.call('model_set',{model:'gpt-5',reasoningEffort:'high'}));
 assert.equal(modelSaved.saved,true);

 const persona=writtenText(await client.call('persona_get',{}));
 assert.equal(persona.name,'Aide');
 assert.equal(persona.path,'/root/.codex/AGENTS.md');
 const personaSaved=writtenText(await client.call('persona_set',{name:'Aide',instructions:'be terse',active:true}));
 assert.equal(personaSaved.name,'Aide');

 const threads=writtenText(await client.call('thread_list',{}));
 assert.equal(threads.count,1);
 assert.equal(threads.threads[0].title,'First thread');
 assert.equal(threads.threads[0].cwd,'/work');
 const read=writtenText(await client.call('thread_read',{threadId:'thread-1'}));
 assert.equal(read.itemCount,2);
 assert.deepEqual(read.items.map(item=>item.text),['hello','hi back']);
 assert.deepEqual(read.items.map(item=>item.role),['user','assistant']);
 const renamed=writtenText(await client.call('thread_rename',{threadId:'thread-1',title:'Renamed thread'}));
 assert.equal(renamed.renamed,true);
 const deleted=writtenText(await client.call('thread_delete',{threadId:'thread-1'}));
 assert.equal(deleted.deletedVia,'thread/archive');
 assert.equal(deleted.archived,true);
 const sent=writtenText(await client.call('thread_send',{threadId:'thread-1',text:'ping'}));
 assert.equal(sent.sent,true);
 assert.equal(sent.turnId,'turn-2');
 assert.equal(sent.awaited,false);

 const paths=calls.map(call=>call.path);
 for(const expected of ['/api/toolpacks','/api/toolpacks/toggle','/api/toolpacks/import','/api/context','/api/context/config','/api/models','/api/config','/api/persona','/api/persona/save','/api/thread/list','/api/thread/resume','/api/thread/rename','/api/thread/archive','/api/turn/send']){
  assert.ok(paths.includes(expected),`the bridge must have received ${expected}; got ${paths.join(', ')}`);
 }
 const apiCalls=calls.filter(call=>call.path.startsWith('/api/'));
 assert.ok(apiCalls.length>=14);
 for(const call of apiCalls)assert.equal(call.authorization,`Bearer ${token}`,`${call.path} must be authenticated`);
 assert.deepEqual(calls.find(call=>call.path==='/api/toolpacks/toggle').body,{name:'files',enabled:false});
 assert.deepEqual(calls.find(call=>call.path==='/api/toolpacks/import').body,{path:'/tmp/some-pack'});
 assert.equal(calls.find(call=>call.path==='/api/models').method,'GET');
 assert.deepEqual(calls.find(call=>call.path==='/api/turn/send').body,{threadId:'thread-1',text:'ping'});
 assert.equal(calls.find(call=>call.path==='/api/thread/rename').body.title,'Renamed thread');
});

// ---------------------------------------------------------------------------
test('time pack performs real zone formatting and calendar arithmetic',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'time'});
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const now=writtenText(await client.call('time_get',{timeZone:'Asia/Shanghai'}));
 assert.equal(now.timeZone,'Asia/Shanghai');
 assert.equal(now.offsetMinutes,480,'Asia/Shanghai is UTC+8');
 assert.match(now.local,/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+08:00$/);
 // 2 s of slack: the value is read inside the child process, and an OS clock correction
 // between the two Date.now() calls must not turn this into a flake.
 assert.ok(Math.abs(now.unixMilliseconds-Date.now())<=2000,'time_get must report the real current instant');
 assert.equal(now.unixSeconds,Math.floor(now.unixMilliseconds/1000));
 assert.match(now.iso,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
 assert.ok(typeof now.weekday==='string'&&now.weekday.length>2);
 assert.ok(now.isoWeek>=1&&now.isoWeek<=53);
 assert.ok(now.dayOfYear>=1&&now.dayOfYear<=366);

 const iso=writtenText(await client.call('time_format',{instant:'2024-02-29T12:34:56.789Z',format:'iso'}));
 assert.equal(iso.text,'2024-02-29T12:34:56.789Z');
 const custom=writtenText(await client.call('time_format',{instant:'2024-02-29T12:34:56.789Z',format:'custom',pattern:'YYYY-MM-DD HH:mm:ss.SSS Z'}));
 assert.equal(custom.text,'2024-02-29 12:34:56.789 +00:00');
 const shanghai=writtenText(await client.call('time_format',{instant:'2024-02-29T12:34:56.789Z',format:'custom',pattern:'YYYY-MM-DD HH:mm:ss Z',timeZone:'Asia/Shanghai'}));
 assert.equal(shanghai.text,'2024-02-29 20:34:56 +08:00');
 const unix=writtenText(await client.call('time_format',{instant:'2024-02-29T12:34:56.789Z',format:'unix'}));
 assert.equal(unix.text,'1709210096');
 const epochSeconds=writtenText(await client.call('time_format',{instant:1709210096,format:'iso'}));
 assert.equal(epochSeconds.text,'2024-02-29T12:34:56.000Z','small epoch numbers are seconds');
 const epochMillis=writtenText(await client.call('time_format',{instant:1709210096789,format:'iso'}));
 assert.equal(epochMillis.text,'2024-02-29T12:34:56.789Z');
 const weekday=writtenText(await client.call('time_format',{instant:'2024-02-29T12:34:56Z',format:'custom',pattern:'YYYY-MM-DD'}));
 assert.equal(weekday.text,'2024-02-29');
 const invalidZone=await client.call('time_get',{timeZone:'Mars/Olympus'});
 failure(invalidZone,{message:/Invalid IANA time zone/i});
 const invalidFormat=await client.call('time_format',{format:'made-up'});
 failure(invalidFormat);

 const nextMonth=writtenText(await client.call('time_add',{instant:'2024-01-31T00:00:00Z',amount:1,unit:'months'}));
 assert.equal(nextMonth.result.iso,'2024-02-29T00:00:00.000Z','month arithmetic must clamp to the last valid day');
 const previousDay=writtenText(await client.call('time_add',{instant:'2024-03-01T00:00:00Z',amount:-1,unit:'days'}));
 assert.equal(previousDay.result.iso,'2024-02-29T00:00:00.000Z');
 const ninetyMinutes=writtenText(await client.call('time_add',{instant:'2024-02-29T12:00:00Z',amount:90,unit:'minutes'}));
 assert.equal(ninetyMinutes.result.iso,'2024-02-29T13:30:00.000Z');
 const twoWeeks=writtenText(await client.call('time_add',{instant:'2024-02-29T00:00:00Z',amount:2,unit:'weeks',timeZone:'Asia/Shanghai'}));
 assert.equal(twoWeeks.result.iso,'2024-03-14T00:00:00.000Z');
 assert.equal(twoWeeks.result.offsetMinutes,480);
 const yearLater=writtenText(await client.call('time_add',{instant:'2024-02-29T00:00:00Z',amount:1,unit:'years'}));
 assert.equal(yearLater.result.iso,'2025-02-28T00:00:00.000Z','February 29 clamps in a non-leap year');
 const badUnit=await client.call('time_add',{instant:'2024-02-29T00:00:00Z',amount:1,unit:'fortnights'});
 failure(badUnit);
});

// ---------------------------------------------------------------------------
// data pack: read-only SQLite introspection and JSON pointer/format helpers.
// node:sqlite availability is probed in this process; the pack runs in the MCP child and
// loads the same builtin module, so a skip here is honest for both sides.
async function builtinSqlite(){
 try{
  const module=await import('node:sqlite');
  return typeof module.DatabaseSync==='function'?module:null;
 }catch{return null;}
}

test('data pack describes a strict four-tool surface',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'data-surface'});
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const tools=await client.tools();
 const names=tools.map(tool=>tool.name);
 for(const name of ['sqlite_query','sqlite_tables','json_query','json_format']){
  assert.ok(names.includes(name),`the data pack must expose ${name}; got ${names.join(',')}`);
 }
 for(const name of ['sqlite_query','sqlite_tables','json_query','json_format']){
  const schema=tools.find(tool=>tool.name===name).inputSchema;
  assert.equal(schema.type,'object');
  assert.equal(schema.additionalProperties,false,`${name} must reject undeclared properties`);
  assert.ok(Array.isArray(schema.required),`${name} must declare an explicit required array`);
 }
 const querySchema=tools.find(tool=>tool.name==='sqlite_query').inputSchema;
 assert.deepEqual(querySchema.required,['path','sql']);
 assert.equal(querySchema.properties.limit.minimum,1);
 assert.equal(querySchema.properties.limit.maximum,5000);
 assert.equal(querySchema.properties.params.type,'array');
 const formatSchema=tools.find(tool=>tool.name==='json_format').inputSchema;
 assert.equal(formatSchema.properties.indent.minimum,0);
 assert.equal(formatSchema.properties.indent.maximum,8);
 assert.deepEqual(formatSchema.required,[],'json_format takes json or path, so nothing is unconditionally required');
 const pointerSchema=tools.find(tool=>tool.name==='json_query').inputSchema;
 assert.deepEqual(pointerSchema.required,['path']);
 assert.equal(pointerSchema.properties.pretty.type,'boolean');
});

test('data pack resolves JSON Pointers and formats or minifies JSON',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'data-json'});
 const document={
  items:[{name:'first',qty:2},{name:'second',qty:3}],
  meta:{owner:'ada',active:true},
  none:null,
  escaped:{'a/b':'slash','t~n':'tilde'},
 };
 await writeFile(join(files,'doc.json'),JSON.stringify(document,null,2)+'\n');
 await writeFile(join(files,'broken.json'),'{ "a": 1, }\n');
 await writeFile(join(files,'scalar.json'),'42\n');
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const whole=writtenText(await client.call('json_query',{path:'doc.json'}));
 assert.equal(whole.found,true);
 assert.equal(whole.type,'object');
 assert.equal(whole.pointer,'');
 assert.deepEqual(whole.value,document);
 assert.ok(whole.path.toLowerCase().endsWith('doc.json'));
 assert.equal(whole.text,undefined,'text is only added when pretty is true');

 const pointer=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/items/0/name'}));
 assert.equal(pointer.found,true);
 assert.equal(pointer.type,'string');
 assert.equal(pointer.value,'first');

 const nestedArray=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/items'}));
 assert.equal(nestedArray.type,'array');
 assert.deepEqual(nestedArray.value.map(item=>item.qty),[2,3]);

 const object=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/meta',pretty:true}));
 assert.equal(object.type,'object');
 assert.deepEqual(object.value,{owner:'ada',active:true});
 assert.equal(object.text,JSON.stringify({owner:'ada',active:true},null,2),'pretty adds a real indented rendering');

 const nullValue=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/none'}));
 assert.equal(nullValue.found,true);
 assert.equal(nullValue.type,'null');
 assert.equal(nullValue.value,null);

 const escapedSlash=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/escaped/a~1b'}));
 assert.equal(escapedSlash.value,'slash','~1 must decode to a literal slash');
 const escapedTilde=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/escaped/t~0n'}));
 assert.equal(escapedTilde.value,'tilde','~0 must decode to a literal tilde');

 const missingIndex=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/items/9'}));
 assert.equal(missingIndex.found,false,'a missing pointer is a normal answer');
 assert.equal(missingIndex.type,null);
 assert.equal(missingIndex.value,null);
 const missingKey=writtenText(await client.call('json_query',{path:'doc.json',pointer:'/meta/nope'}));
 assert.equal(missingKey.found,false);

 assert.equal(failure(await client.call('json_query',{path:'doc.json',pointer:'items/0'}),{message:/JSON Pointer/}).code,'args/invalid');
 assert.equal(failure(await client.call('json_query',{path:'broken.json'}),{message:/not contain valid JSON/i}).code,'args/invalid');
 assert.equal(failure(await client.call('json_query',{path:'scalar.json'}),{message:/root/i}).code,'args/invalid');
 assert.equal(failure(await client.call('json_query',{path:'../nope.json'}),{message:/outside the allowed roots/i}).code,'path/outside-roots');
 assert.equal(failure(await client.call('json_query',{path:'nope.json'})).code,'path/not-found');

 const compact=writtenText(await client.call('json_format',{json:JSON.stringify(document),indent:0}));
 assert.equal(compact.valid,true);
 assert.equal(compact.text,JSON.stringify(document),'indent 0 must produce the minified document');
 assert.equal(compact.bytes,Buffer.byteLength(compact.text,'utf8'));

 const compactFile=writtenText(await client.call('json_format',{path:'doc.json',indent:0}));
 assert.equal(compactFile.valid,true);
 assert.equal(compactFile.text,JSON.stringify(document));

 const pretty=writtenText(await client.call('json_format',{json:'{"b":1,"a":[1,2]}'}));
 assert.equal(pretty.valid,true);
 assert.equal(pretty.text,'{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}','the default indent is two spaces');
 assert.equal(pretty.bytes,Buffer.byteLength(pretty.text,'utf8'));
 const wide=writtenText(await client.call('json_format',{json:'{"b":1,"a":2}',indent:8}));
 assert.match(wide.text,/^\{\n {8}"b": 1,/);

 const broken=writtenText(await client.call('json_format',{json:'{ "a": 1, }'}));
 assert.equal(broken.valid,false,'malformed JSON is a successful answer with valid:false');
 assert.equal(typeof broken.error.message,'string');
 assert.ok(broken.error.message.length>0);
 assert.equal(broken.error.line,1);
 assert.equal(typeof broken.error.column,'number');
 assert.ok(broken.error.column>0);
 assert.equal(broken.text,undefined,'no formatted text exists for invalid JSON');

 const brokenFile=writtenText(await client.call('json_format',{path:'broken.json'}));
 assert.equal(brokenFile.valid,false);
 assert.equal(brokenFile.error.line,1);

 assert.equal(failure(await client.call('json_format',{json:'{}',path:'doc.json'}),{message:/exactly one/i}).code,'args/invalid');
 assert.equal(failure(await client.call('json_format',{}),{message:/exactly one/i}).code,'args/invalid');
 assert.equal(failure(await client.call('json_format',{json:'{}',indent:9})).code,'args/invalid');
 assert.equal(failure(await client.call('json_format',{path:'nope.json'})).code,'path/not-found');
 assert.equal(failure(await client.call('json_format',{path:'../nope.json'})).code,'path/outside-roots');
});

test('data pack lists sqlite tables and runs read-only queries',{timeout:90000},async t=>{
 const sqlite=await builtinSqlite();
 if(!sqlite){
  t.skip('node:sqlite is not available in this Node build, so the sqlite_query/sqlite_tables cases are skipped');
  return;
 }
 const {home,files,data}=await workspace(t,{name:'data-sqlite'});
 const databaseFile=join(files,'notes.db');
 const database=new sqlite.DatabaseSync(databaseFile);
 database.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, name TEXT, score INTEGER)');
 database.exec('CREATE TABLE empty_table (id INTEGER)');
 database.exec('CREATE VIEW top_notes AS SELECT name, score FROM notes WHERE score >= 10');
 const insert=database.prepare('INSERT INTO notes (name, score) VALUES (?, ?)');
 insert.run('alpha',5);
 insert.run('beta',42);
 insert.run('gamma',11);
 database.close();

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const tables=writtenText(await client.call('sqlite_tables',{path:'notes.db'}));
 assert.ok(tables.path.toLowerCase().endsWith('notes.db'));
 assert.deepEqual(tables.tables.map(table=>table.name).sort(),['empty_table','notes']);
 for(const table of tables.tables)assert.equal(table.type,'table');
 assert.equal(tables.tables.find(table=>table.name==='notes').rowCount,3);
 assert.equal(tables.tables.find(table=>table.name==='empty_table').rowCount,0);
 assert.equal(tables.views.length,1);
 assert.equal(tables.views[0].name,'top_notes');
 assert.equal(tables.views[0].type,'view');
 assert.equal(tables.views[0].rowCount,2);

 const rows=writtenText(await client.call('sqlite_query',{path:'notes.db',sql:'SELECT name, score FROM notes WHERE score > ? ORDER BY score',params:[5]}));
 assert.deepEqual(rows.columns,['name','score']);
 assert.deepEqual(rows.rows,[['gamma',11],['beta',42]]);
 assert.equal(rows.rowCount,2);
 assert.equal(rows.truncated,false);
 assert.equal(typeof rows.durationMs,'number');

 const capped=writtenText(await client.call('sqlite_query',{path:'notes.db',sql:'SELECT name FROM notes ORDER BY id',limit:2}));
 assert.equal(capped.rowCount,2);
 assert.equal(capped.truncated,true,'a third row exists, so the cap must be reported');
 assert.deepEqual(capped.rows,[['alpha'],['beta']]);

 const pragma=writtenText(await client.call('sqlite_query',{path:'notes.db',sql:'PRAGMA table_info(notes)'}));
 assert.equal(pragma.columns.length,6);
 assert.equal(pragma.rowCount,3);
 assert.deepEqual(pragma.rows.map(row=>row[1]),['id','name','score']);

 const withClause=writtenText(await client.call('sqlite_query',{path:'notes.db',sql:'WITH totals AS (SELECT SUM(score) AS total FROM notes) SELECT total FROM totals'}));
 assert.deepEqual(withClause.rows,[[58]],'a WITH statement is a read and must be allowed');

 // Writes are refused before the database is touched, and the data survives.
 for(const sql of ['DELETE FROM notes','INSERT INTO notes (name) VALUES (\'x\')','UPDATE notes SET score = 0','DROP TABLE notes','ALTER TABLE notes ADD COLUMN extra TEXT','CREATE TABLE extra (id INTEGER)','ATTACH DATABASE \'other.db\' AS other','SELECT 1; DROP TABLE notes']){
  const rejected=await client.call('sqlite_query',{path:'notes.db',sql});
  const error=failure(rejected,{message:/read-only|write keyword/i});
  assert.equal(error.code,'args/invalid',`${sql} must be rejected with args/invalid; got ${error.code}`);
 }
 const survived=writtenText(await client.call('sqlite_query',{path:'notes.db',sql:'SELECT COUNT(*) AS count FROM notes'}));
 assert.equal(survived.rows[0][0],3,'a rejected write must not change the database');
 assert.deepEqual(survived.columns,['count']);

 assert.equal(failure(await client.call('sqlite_query',{path:'notes.db',sql:'SELECT * FROM missing_table'}),{message:/no such table/i}).code,'args/invalid');
 assert.equal(failure(await client.call('sqlite_query',{path:'notes.db',sql:''}),{message:/sql/}).code,'args/invalid');
 assert.equal(failure(await client.call('sqlite_query',{path:'notes.db'}),{message:/sql/}).code,'args/invalid');
 assert.equal(failure(await client.call('sqlite_query',{path:'notes.db',sql:'SELECT 1',params:[{a:1}]}),{message:/params/}).code,'args/invalid');
 assert.equal(failure(await client.call('sqlite_query',{path:'notes.db',sql:'SELECT 1',limit:9000})).code,'args/invalid');
 assert.equal(failure(await client.call('sqlite_query',{path:'missing.db',sql:'SELECT 1'}),{message:/does not exist/i}).code,'path/not-found');
 assert.equal(failure(await client.call('sqlite_tables',{path:'missing.db'})).code,'path/not-found');
 assert.equal(failure(await client.call('sqlite_query',{path:'../outside.db',sql:'SELECT 1'})).code,'path/outside-roots');
 assert.equal(failure(await client.call('sqlite_tables',{path:'../outside.db'})).code,'path/outside-roots');
});

// ---------------------------------------------------------------------------
test('files pack reads line ranges, edits exactly, deletes, creates directories, finds names and greps contents',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'files-basic'});
 await mkdir(join(files,'src','nested'),{recursive:true});
 await mkdir(join(files,'scratch'),{recursive:true});
 await mkdir(join(files,'node_modules','pkg'),{recursive:true});
 const manyLines=Array.from({length:1500},(_,index)=>`row ${index+1}`).join('\n')+'\n';
 await writeFile(join(files,'src','many.txt'),manyLines);
 await writeFile(join(files,'src','notes.md'),'alpha\nbeta marker\nbeta marker\ngamma\n');
 await writeFile(join(files,'src','nested','deep.log'),'intro\nfinder-marker inside a log line\noutro\n');
 await writeFile(join(files,'.hidden.txt'),'hidden finder-marker\n');
 await writeFile(join(files,'node_modules','pkg','skip.txt'),'finder-marker must be skipped\n');

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 // --- schemas: additionalProperties false, explicit required, bounds, enums
 const surface=new Map((await client.tools()).map(tool=>[tool.name,tool]));
 for(const name of ['file_read_range','file_edit','file_delete','file_mkdir','file_find','file_grep']){
  const tool=surface.get(name);
  assert.ok(tool,`the files pack must expose ${name}`);
  const schema=tool.inputSchema;
  assert.equal(schema.type,'object',`${name} must declare an object schema`);
  assert.equal(schema.additionalProperties,false,`${name} must reject undeclared properties`);
  assert.ok(Array.isArray(schema.required),`${name} must declare an explicit required array`);
  for(const [property,spec] of Object.entries(schema.properties)){
   assert.equal(typeof spec.description,'string',`${name}.${property} needs a description`);
   assert.ok(spec.description.length>0,`${name}.${property} description must not be empty`);
  }
 }
 assert.deepEqual(surface.get('file_read_range').inputSchema.required,['path']);
 assert.equal(surface.get('file_read_range').inputSchema.properties.startLine.minimum,1);
 assert.equal(surface.get('file_read_range').inputSchema.properties.endLine.minimum,1);
 assert.equal(surface.get('file_read_range').inputSchema.properties.maxBytes.minimum,1);
 assert.equal(surface.get('file_read_range').inputSchema.properties.maxBytes.maximum,2097152);
 assert.deepEqual(surface.get('file_edit').inputSchema.required,['path','old','new']);
 assert.equal(surface.get('file_edit').inputSchema.properties.old.minLength,1);
 assert.equal(surface.get('file_edit').inputSchema.properties.expectedCount.minimum,1);
 assert.deepEqual(surface.get('file_delete').inputSchema.required,['path']);
 assert.equal(surface.get('file_delete').inputSchema.properties.recursive.type,'boolean');
 assert.deepEqual(surface.get('file_mkdir').inputSchema.required,['path']);
 assert.equal(surface.get('file_mkdir').inputSchema.properties.mode.type,'string');
 assert.deepEqual(surface.get('file_find').inputSchema.required,['pattern']);
 assert.equal(surface.get('file_find').inputSchema.properties.maxDepth.minimum,1);
 assert.equal(surface.get('file_find').inputSchema.properties.maxDepth.maximum,32);
 assert.equal(surface.get('file_find').inputSchema.properties.limit.maximum,2000);
 assert.deepEqual(surface.get('file_find').inputSchema.properties.type.enum,['file','dir','any']);
 assert.deepEqual(surface.get('file_grep').inputSchema.required,['pattern']);
 assert.equal(surface.get('file_grep').inputSchema.properties.maxResults.maximum,500);
 assert.equal(surface.get('file_grep').inputSchema.properties.contextLines.minimum,0);
 assert.equal(surface.get('file_grep').inputSchema.properties.contextLines.maximum,5);
 assert.equal(surface.get('file_grep').inputSchema.properties.maxFileBytes.maximum,16777216);

 // --- file_read_range: the reported totalLines is the whole-file count ---------
 const head=writtenText(await client.call('file_read_range',{path:'src/many.txt'}));
 assert.equal(head.totalLines,1500,'totalLines must count every line of the whole file');
 assert.equal(head.startLine,1);
 assert.equal(head.endLine,501,'the default window is 500 lines past startLine');
 assert.equal(head.content.split('\n').length,501);
 assert.equal(head.content.split('\n')[0],'row 1');
 assert.equal(head.content.split('\n').at(-1),'row 501');
 assert.equal(head.truncated,true,'more lines follow the default window');
 assert.ok(head.path.toLowerCase().endsWith('many.txt'));

 const middle=writtenText(await client.call('file_read_range',{path:'src/many.txt',startLine:700,endLine:702}));
 assert.equal(middle.totalLines,1500,'a window in the middle still reports the whole file');
 assert.equal(middle.startLine,700);
 assert.equal(middle.endLine,702);
 assert.equal(middle.content,'row 700\nrow 701\nrow 702','endLine is inclusive');
 assert.equal(middle.truncated,true);

 const tail=writtenText(await client.call('file_read_range',{path:'src/many.txt',startLine:1499,endLine:1500}));
 assert.equal(tail.content,'row 1499\nrow 1500');
 assert.equal(tail.truncated,false,'a window that reaches the last line is complete');

 const capped=writtenText(await client.call('file_read_range',{path:'src/many.txt',maxBytes:12}));
 assert.equal(capped.truncated,true,'maxBytes must be reported as truncation');
 assert.ok(Buffer.byteLength(capped.content,'utf8')<=12);
 assert.equal(capped.totalLines,1500,'the byte cap must not change the reported total');

 failure(await client.call('file_read_range',{path:'src/many.txt',startLine:4000}),{message:/past the end/i});
 failure(await client.call('file_read_range',{path:'src/many.txt',startLine:1,endLine:6000}),{message:/5000 line/i});
 failure(await client.call('file_read_range',{path:'src/many.txt',startLine:5,endLine:2}));
 failure(await client.call('file_read_range',{path:'../outside.txt'}),{message:/outside the allowed roots/i});
 failure(await client.call('file_read_range',{path:'src/nested'}),{message:/Not a regular file/i});

 // --- file_edit: verified by reading the real file back -----------------------
 const edited=writtenText(await client.call('file_edit',{path:'src/notes.md',old:'alpha',new:'ALPHA'}));
 assert.equal(edited.replacements,1);
 assert.equal(edited.bytesBefore,36);
 assert.equal(edited.bytesAfter,36);
 assert.equal(await readFile(join(files,'src','notes.md'),'utf8'),'ALPHA\nbeta marker\nbeta marker\ngamma\n','file_edit must really rewrite the file');
 const readBack=writtenText(await client.call('file_read',{path:'src/notes.md'}));
 assert.equal(readBack.content,'ALPHA\nbeta marker\nbeta marker\ngamma\n','the edited bytes must be visible to a later read');

 const replacedAll=writtenText(await client.call('file_edit',{path:'src/notes.md',old:'beta marker',new:'BETA',replaceAll:true,expectedCount:2}));
 assert.equal(replacedAll.replacements,2);
 assert.equal(await readFile(join(files,'src','notes.md'),'utf8'),'ALPHA\nBETA\nBETA\ngamma\n');
 assert.ok(replacedAll.bytesAfter<replacedAll.bytesBefore);

 const removedText=writtenText(await client.call('file_edit',{path:'src/notes.md',old:'ALPHA\n',new:''}));
 assert.equal(removedText.replacements,1);
 assert.equal(await readFile(join(files,'src','notes.md'),'utf8'),'BETA\nBETA\ngamma\n','an empty new deletes the matched text');

 const ambiguous=await client.call('file_edit',{path:'src/notes.md',old:'BETA',new:'beta'});
 assert.equal(failure(ambiguous,{message:/replaceAll/i}).code,'args/invalid');
 assert.equal(await readFile(join(files,'src','notes.md'),'utf8'),'BETA\nBETA\ngamma\n','a refused edit must not touch the file');
 assert.equal(failure(await client.call('file_edit',{path:'src/notes.md',old:'BETA',new:'beta',replaceAll:true,expectedCount:5}),{message:/expectedCount/}).code,'args/invalid');
 assert.equal(await readFile(join(files,'src','notes.md'),'utf8'),'BETA\nBETA\ngamma\n','a count mismatch must not touch the file');
 assert.equal(failure(await client.call('file_edit',{path:'src/notes.md',old:'nothing like this',new:'x'}),{message:/did not match/i}).code,'args/invalid');
 assert.equal(await readFile(join(files,'src','notes.md'),'utf8'),'BETA\nBETA\ngamma\n','a zero-match edit must not touch the file');
 failure(await client.call('file_edit',{path:'src/notes.md',old:'',new:'x'}),{message:/old/});
 failure(await client.call('file_edit',{path:'src/notes.md',old:'BETA',new:'beta',replaceAll:'yes'}));
 failure(await client.call('file_edit',{path:'../outside.txt',old:'a',new:'b'}),{message:/outside the allowed roots/i});

 // --- file_mkdir: recursive, idempotent, and honest about conflicts ----------
 const made=writtenText(await client.call('file_mkdir',{path:'scratch/a/b/c',mode:'0755'}));
 assert.equal(made.created,true);
 const madeAgain=writtenText(await client.call('file_mkdir',{path:'scratch/a/b/c'}));
 assert.equal(madeAgain.created,false,'an existing directory is not an error');
 assert.equal(writtenText(await client.call('file_exists',{path:'scratch/a/b/c'})).type,'directory','all parents must exist after one call');
 failure(await client.call('file_mkdir',{path:'src/many.txt'}),{message:/not a directory/i});
 failure(await client.call('file_mkdir',{path:'scratch/a',mode:'99'}));
 failure(await client.call('file_mkdir',{path:'../escape'}),{message:/outside the allowed roots/i});

 // --- file_find: wildcard names, depth, type, hidden files and ignore list ---
 const found=writtenText(await client.call('file_find',{pattern:'*.log'}));
 assert.equal(found.count,1);
 assert.deepEqual(found.entries.map(entry=>entry.relative),['src/nested/deep.log']);
 assert.equal(found.entries[0].isDirectory,false);
 assert.ok(found.entries[0].sizeBytes>0,'a file reports its real size');
 assert.match(found.entries[0].modifiedAt,/^\d{4}-\d\d-\d\dT/);
 assert.equal(found.truncated,false);
 assert.ok(found.root.toLowerCase().endsWith('files'));

 const directories=writtenText(await client.call('file_find',{pattern:'nested',type:'dir'}));
 assert.deepEqual(directories.entries.map(entry=>entry.relative),['src/nested']);
 assert.equal(directories.entries[0].isDirectory,true);
 assert.equal(directories.entries[0].sizeBytes,0,'directories report sizeBytes 0');
 const filesOnly=writtenText(await client.call('file_find',{pattern:'nested',type:'file'}));
 assert.equal(filesOnly.count,0,'type file must not report directories');

 const shallow=writtenText(await client.call('file_find',{pattern:'*.txt',maxDepth:1}));
 assert.equal(shallow.count,0,'*.txt lives below depth 1 and the hidden one is skipped');
 const withHidden=writtenText(await client.call('file_find',{pattern:'*.txt',maxDepth:1,includeHidden:true}));
 assert.deepEqual(withHidden.entries.map(entry=>entry.relative),['.hidden.txt'],'includeHidden exposes dot entries');
 const ignoredDirs=writtenText(await client.call('file_find',{pattern:'skip.txt'}));
 assert.equal(ignoredDirs.count,0,'node_modules must be skipped');
 const limited=writtenText(await client.call('file_find',{pattern:'*',root:'src',limit:1}));
 assert.equal(limited.count,1);
 assert.equal(limited.truncated,true,'limit must be reported as truncation');

 failure(await client.call('file_find',{pattern:'src/*.txt'}),{message:/path separator/i});
 failure(await client.call('file_find',{pattern:'*',type:'symlink'}));
 failure(await client.call('file_find',{pattern:'*',maxDepth:99}));
 failure(await client.call('file_find',{pattern:'*',root:'../outside'}),{message:/outside the allowed roots/i});

 // --- file_grep: regex + context, honouring glob, ignore list and caps ------
 const grep=writtenText(await client.call('file_grep',{pattern:'finder-marker',contextLines:1}));
 assert.equal(grep.pattern,'finder-marker');
 assert.equal(grep.filesScanned,3,'hidden files and node_modules must not be read');
 assert.equal(grep.matches.length,1,'only the visible log file may match');
 assert.equal(grep.matches[0].line,2);
 assert.equal(grep.matches[0].column,1);
 assert.equal(grep.matches[0].text,'finder-marker inside a log line');
 assert.deepEqual(grep.matches[0].before,['intro']);
 assert.deepEqual(grep.matches[0].after,['outro']);
 assert.equal(grep.truncated,false);
 assert.ok(grep.matches[0].path.toLowerCase().endsWith('deep.log'));

 const noGlobHit=writtenText(await client.call('file_grep',{pattern:'finder-marker',glob:'*.md'}));
 assert.equal(noGlobHit.matches.length,0,'glob must restrict which files are read');
 assert.equal(noGlobHit.filesScanned,1);

 const insensitive=writtenText(await client.call('file_grep',{pattern:'FINDER-MARKER',ignoreCase:true}));
 assert.equal(insensitive.matches.length,1,'ignoreCase must match the lower-case text');
 assert.equal(writtenText(await client.call('file_grep',{pattern:'FINDER-MARKER'})).matches.length,0);

 const columnHunt=writtenText(await client.call('file_grep',{pattern:'marker',glob:'*.log'}));
 assert.equal(columnHunt.matches[0].column,8,'column is the 1-based start of the match on that line');

 const grepCapped=writtenText(await client.call('file_grep',{pattern:'row \\d+',glob:'*.txt',maxResults:2}));
 assert.equal(grepCapped.matches.length,2);
 assert.equal(grepCapped.truncated,true,'maxResults must be reported as truncation');
 assert.equal(grepCapped.matches[0].line,1);
 assert.equal(grepCapped.matches[0].column,1);

 failure(await client.call('file_grep',{pattern:'('}),{message:/regular expression/i});
 failure(await client.call('file_grep',{pattern:'x',glob:'src/*.md'}));
 failure(await client.call('file_grep',{pattern:'x',contextLines:9}));
 failure(await client.call('file_grep',{pattern:'x',root:'../outside'}),{message:/outside the allowed roots/i});

 // --- file_delete: file, empty directory, non-empty guard, recursion --------
 const removedFile=writtenText(await client.call('file_delete',{path:'src/nested/deep.log'}));
 assert.equal(removedFile.deleted,true);
 assert.equal(removedFile.kind,'file');
 assert.equal(writtenText(await client.call('file_exists',{path:'src/nested/deep.log'})).exists,false,'the file must really be gone');
 failure(await client.call('file_delete',{path:'src/nested/deep.log'}),{message:/does not exist/i});

 await mkdir(join(files,'scratch','empty'));
 const removedEmpty=writtenText(await client.call('file_delete',{path:'scratch/empty'}));
 assert.equal(removedEmpty.deleted,true);
 assert.equal(removedEmpty.kind,'directory');
 assert.equal(writtenText(await client.call('file_exists',{path:'scratch/empty'})).exists,false);

 const nonEmpty=await client.call('file_delete',{path:'scratch/a'});
 assert.equal(failure(nonEmpty,{message:/recursive/i}).code,'args/invalid');
 assert.equal(writtenText(await client.call('file_exists',{path:'scratch/a/b/c'})).exists,true,'a refused delete must remove nothing');
 const removedTree=writtenText(await client.call('file_delete',{path:'scratch/a',recursive:true}));
 assert.equal(removedTree.kind,'directory');
 assert.equal(writtenText(await client.call('file_exists',{path:'scratch/a'})).exists,false,'recursive must remove the whole tree');

 failure(await client.call('file_delete',{path:'../outside.txt'}),{message:/outside the allowed roots/i});
 assert.equal(failure(await client.call('file_delete',{path:'.'}),{message:/allowed root/i}).code,'args/invalid');

 // --- a read-only sandbox refuses the writers and still serves the readers --
 await writeFile(join(home,'config.toml'),'model = "gpt-5"\nsandbox_mode = "read-only"\napproval_policy = "never"\n');
 const readonly=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await readonly.kill();});
 assert.equal(failure(await readonly.call('file_edit',{path:'src/notes.md',old:'BETA',new:'beta',replaceAll:true}),{message:/read-only/i}).code,'sandbox/denied');
 assert.equal(failure(await readonly.call('file_delete',{path:'src/notes.md'})).code,'sandbox/denied');
 assert.equal(failure(await readonly.call('file_mkdir',{path:'scratch/readonly'})).code,'sandbox/denied');
 assert.equal(await readFile(join(files,'src','notes.md'),'utf8'),'BETA\nBETA\ngamma\n','a read-only session must not write');
 assert.equal(writtenText(await readonly.call('file_exists',{path:'scratch/readonly'})).exists,false,'a refused mkdir must create nothing');
 const readonlyRead=writtenText(await readonly.call('file_read_range',{path:'src/many.txt',startLine:1,endLine:2}));
 assert.equal(readonlyRead.content,'row 1\nrow 2','file_read_range stays available in a read-only session');
 assert.equal(readonlyRead.totalLines,1500);
 const readonlyFind=writtenText(await readonly.call('file_find',{pattern:'*.md'}));
 assert.deepEqual(readonlyFind.entries.map(entry=>entry.relative),['src/notes.md'],'file_find stays available in a read-only session');
 const readonlyGrep=writtenText(await readonly.call('file_grep',{pattern:'^BETA$',glob:'*.md'}));
 assert.equal(readonlyGrep.matches.length,2,'file_grep stays available in a read-only session');
});

// ---------------------------------------------------------------------------
// dev pack: probe the terminal environment, preview apt installs, read the install log
// and run real shell commands. env_install is ONLY ever called with dryRun:true here, so
// no test starts apt-get on any host.
test('dev pack probes toolchains, previews apt installs, reads install logs and runs real shell commands',{timeout:90000},async t=>{
 const {home,files,data}=await workspace(t,{name:'dev'});
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const PROBES=['bash','sh','node','python3','pip3','git','tar','ssh','scp','java','javac','go','cargo','rustc','gcc','make','sqlite3','curl','wget','unzip','jq'];
 const WHITELIST=['python','ssh','java','go','rust','build','sqlite','net','unzip','jq'];

 // --- surface: four tools, closed schemas, explicit required ----------------
 const surface=new Map((await client.tools()).map(tool=>[tool.name,tool]));
 for(const name of ['env_probe','env_install','env_install_log','env_run']){
  const tool=surface.get(name);
  assert.ok(tool,`the dev pack must expose ${name}`);
  assert.equal(tool.inputSchema.type,'object',`${name} must declare an object schema`);
  assert.equal(tool.inputSchema.additionalProperties,false,`${name} must reject undeclared properties`);
  assert.ok(Array.isArray(tool.inputSchema.required),`${name} must declare an explicit required array`);
 }
 assert.deepEqual(surface.get('env_probe').inputSchema.required,[],'env_probe has no required parameter');
 assert.equal(surface.get('env_probe').inputSchema.properties.includeVersions.type,'boolean');
 assert.deepEqual(surface.get('env_install').inputSchema.required,['packages']);
 assert.equal(surface.get('env_install').inputSchema.properties.packages.type,'array');
 assert.equal(surface.get('env_install').inputSchema.properties.packages.minItems,1);
 assert.equal(surface.get('env_install').inputSchema.properties.packages.maxItems,8);
 assert.deepEqual(surface.get('env_install').inputSchema.properties.packages.items.enum,WHITELIST);
 assert.equal(surface.get('env_install').inputSchema.properties.dryRun.type,'boolean');
 assert.deepEqual(surface.get('env_install_log').inputSchema.required,['logPath']);
 assert.equal(surface.get('env_install_log').inputSchema.properties.lines.minimum,1);
 assert.equal(surface.get('env_install_log').inputSchema.properties.lines.maximum,500);
 assert.deepEqual(surface.get('env_run').inputSchema.required,['command']);
 assert.deepEqual(surface.get('env_run').inputSchema.properties.shell.enum,['bash','sh']);
 assert.equal(surface.get('env_run').inputSchema.properties.timeoutMs.minimum,1000);
 assert.equal(surface.get('env_run').inputSchema.properties.timeoutMs.maximum,110000);

 // --- env_probe: a real measurement of 21 commands --------------------------
 const probe=writtenText(await client.call('env_probe',{}));
 assert.equal(probe.platform,process.platform);
 assert.equal(probe.arch,process.arch);
 assert.equal(probe.sandboxMode,null,'no config.toml in this CODEX_HOME, so sandboxMode must be null');
 assert.deepEqual(Object.keys(probe.available).sort(),[...PROBES].sort(),'env_probe must report every probed command');
 assert.equal(probe.available.node,true,'node runs this server, so it must be found even when it is not on PATH');
 for(const [name,value] of Object.entries(probe.available))assert.equal(typeof value,'boolean',`available.${name} must be a boolean`);
 assert.deepEqual(probe.missing,PROBES.filter(name=>probe.available[name]===false),'missing must list exactly the unavailable probes, in probe order');
 assert.deepEqual(Object.keys(probe.versions).sort(),[...PROBES].sort(),'versions must cover the same 21 names');
 for(const [name,value] of Object.entries(probe.versions))assert.ok(value===null||typeof value==='string',`versions.${name} must be a string or null`);
 assert.equal(probe.versions.node,`v${process.versions.node}`,'the node probe must report the version of the node that runs the server');
 const unversioned=writtenText(await client.call('env_probe',{includeVersions:false}));
 assert.equal(unversioned.available.node,true,'includeVersions:false must not change availability');
 assert.deepEqual(Object.values(unversioned.versions).filter(value=>value!==null),[],'includeVersions:false must not capture version strings');
 assert.equal(failure(await client.call('env_probe',{includeVersions:'yes'}),{message:/includeVersions/}).code,'args/invalid');

 // --- env_install: whitelist mapping, dryRun and nothing actually started ---
 const preview=writtenText(await client.call('env_install',{packages:['python','ssh'],dryRun:true}));
 assert.equal(preview.started,false,'dryRun must not start apt');
 assert.deepEqual(preview.packages,['python3','python3-pip','openssh-client'],'whitelist aliases must map to their apt package names');
 assert.match(preview.command,/^nohup sh -c /,'the documented background form must be used');
 assert.match(preview.command,/apt-get update -y && apt-get install -y --no-install-recommends python3 python3-pip openssh-client/);
 assert.match(preview.command,/2>&1 &$/);
 assert.match(preview.logPath,/^\/tmp\/codex-go-env-[A-Za-z0-9._-]+\.log$/,`logPath must stay in the documented /tmp prefix; got ${preview.logPath}`);
 assert.ok(preview.command.includes(preview.logPath),'the command must write exactly the log path it returns');
 assert.match(preview.note,/dryRun/i);
 assert.equal(failure(await client.call('env_install_log',{logPath:preview.logPath}),{message:/no install log/i}).code,'path/not-found','a dryRun install must not create a log');

 const everyAlias=writtenText(await client.call('env_install',{packages:['java','go','rust','build','sqlite','net','unzip','jq'],dryRun:true}));
 assert.deepEqual(everyAlias.packages,['default-jdk-headless','golang-go','rustc','cargo','build-essential','sqlite3','curl','wget','unzip','jq']);
 // `node` 故意不在白名单：运行时自带 /opt/node/bin/node，装 Ubuntu nodejs 会遮蔽它。
 assert.equal(failure(await client.call('env_install',{packages:['node'],dryRun:true}),{message:/whitelist/i}).code,'args/invalid');
 assert.equal(failure(await client.call('env_install',{packages:['ruby'],dryRun:true}),{message:/whitelist/i}).code,'args/invalid');
 assert.equal(failure(await client.call('env_install',{packages:[],dryRun:true}),{message:/packages/}).code,'args/invalid');
 assert.equal(failure(await client.call('env_install',{dryRun:true}),{message:/packages/}).code,'args/invalid');
 assert.equal(failure(await client.call('env_install',{packages:['python','ssh','java','go','rust','build','sqlite','net','jq'],dryRun:true}),{message:/8/}).code,'args/invalid');

 // --- env_install_log: only install logs, and a real read back ---------------
 assert.equal(failure(await client.call('env_install_log',{logPath:'/etc/passwd'}),{message:/install log path/i}).code,'path/outside-roots');
 assert.equal(failure(await client.call('env_install_log',{logPath:'/tmp/other.log'})).code,'path/outside-roots');
 assert.equal(failure(await client.call('env_install_log',{logPath:'/tmp/codex-go-env-../../etc/passwd.log'})).code,'path/outside-roots');
 assert.equal(failure(await client.call('env_install_log',{})).code,'args/invalid');
 assert.equal(failure(await client.call('env_install_log',{logPath:'/tmp/codex-go-env-missing.log'})).code,'path/not-found');
 assert.equal(failure(await client.call('env_install_log',{logPath:'/tmp/codex-go-env-missing.log',lines:501})).code,'args/invalid');

 // A log that exists is read from the tail; /tmp is drive-relative on Windows, so
 // the directory is created when possible and the case is skipped when it is not.
 const logDirectory=resolve('/tmp');
 const logPath='/tmp/codex-go-env-toolpack-test.log';
 const logFile=join(logDirectory,'codex-go-env-toolpack-test.log');
 const logDirectoryExisted=await stat(logDirectory).then(()=>true).catch(()=>false);
 let logWritten=false;
 try{
  await mkdir(logDirectory,{recursive:true});
  await writeFile(logFile,['Get:1 http://ports.ubuntu.com noble InRelease','Fetched 12400 kB in 3s','Reading package lists...','Setting up python3 (3.12.3-0ubuntu2) ...'].join('\n')+'\n');
  logWritten=true;
 }catch(error){
  t.diagnostic(`cannot write ${logFile} (${error.code}); the env_install_log read case is skipped`);
 }
 t.after(async()=>{
  await rm(logFile,{force:true});
  if(logDirectoryExisted)return;
  // Remove the drive root directory again, but only when this test left it empty: /tmp
  // is shared, so anything else in it means it is not ours to delete. rmdir (not rm) is
  // used because fs.rm rejects a directory without recursive:true.
  for(const delay of [0,100]){
   if(delay)await sleep(delay);
   const entries=await readdir(logDirectory).catch(()=>null);
   if(entries===null)return;
   if(entries.length)return;
   try{
    await rmdir(logDirectory);
    return;
   }catch{/* retry */}
  }
 });
 if(logWritten){
  const reading=writtenText(await client.call('env_install_log',{logPath,lines:2}));
  assert.equal(reading.exists,true);
  assert.equal(reading.logPath,logPath);
  assert.deepEqual(reading.lines,['Reading package lists...','Setting up python3 (3.12.3-0ubuntu2) ...'],'lines must be the tail of the log');
  assert.equal(reading.done,true,'a "Setting up" line makes the heuristic report done');
  assert.match(reading.exitHint,/heuristic/i,'the answer must say that done is only a heuristic');
  const allLines=writtenText(await client.call('env_install_log',{logPath}));
  assert.equal(allLines.lines.length,4,'the default is the last 60 lines, so every line comes back');
  await writeFile(logFile,'Err:1 http://ports.ubuntu.com noble InRelease\nE: Unable to locate package golang-go\n');
  const failed=writtenText(await client.call('env_install_log',{logPath}));
  assert.equal(failed.done,true);
  assert.match(failed.exitHint,/"E: "/,'an apt failure line must be named in exitHint');
  assert.ok(failed.lines.some(line=>line.startsWith('E: ')),'the real apt error line must be returned');
 }

 // --- env_run: real stdout, real exit code, real guards ---------------------
 const echoed=writtenText(await client.call('env_run',{command:'echo env-run-marker'}));
 assert.equal(echoed.exitCode,0);
 assert.match(echoed.stdout,/env-run-marker/,'env_run must return the real stdout of the command');
 assert.equal(echoed.stderr,'');
 assert.equal(echoed.timedOut,false);
 assert.equal(echoed.truncated,false);
 assert.equal(typeof echoed.durationMs,'number');
 assert.ok(echoed.durationMs>=0);
 assert.ok(typeof echoed.shell==='string'&&echoed.shell.length>0,'env_run must name the shell that really ran');
 assert.ok(typeof echoed.shellPath==='string'&&echoed.shellPath.length>0);
 assert.ok(echoed.cwd.toLowerCase().endsWith('files'),'the default cwd is the first allowed root');

 const otherShell=writtenText(await client.call('env_run',{shell:'sh',command:'echo from-sh'}));
 assert.match(otherShell.stdout,/from-sh/);
 assert.equal(otherShell.exitCode,0);

 const nonZero=writtenText(await client.call('env_run',{command:'exit 7'}));
 assert.equal(nonZero.exitCode,7,'a non-zero exit is a structured result, not a tool failure');
 assert.equal(nonZero.timedOut,false);

 const timeout=writtenText(await client.call('env_run',{command:'sleep 5',timeoutMs:1000}));
 assert.equal(timeout.timedOut,true,'a command past timeoutMs must report timedOut:true');
 assert.equal(timeout.truncated,false);

 assert.equal(failure(await client.call('env_run',{}),{message:/command/}).code,'args/invalid');
 assert.equal(failure(await client.call('env_run',{command:'   '}),{message:/command/}).code,'args/invalid');
 assert.equal(failure(await client.call('env_run',{command:'echo hi',shell:'zsh'})).code,'args/invalid');
 assert.equal(failure(await client.call('env_run',{command:'echo hi',timeoutMs:999})).code,'args/invalid');
 assert.equal(failure(await client.call('env_run',{command:'echo hi',cwd:'../outside'}),{message:/outside the allowed roots/i}).code,'path/outside-roots');
 assert.equal(failure(await client.call('env_run',{command:'echo hi',cwd:'missing-dir'})).code,'path/not-found');
});

test('dev pack refuses installs and execution in a read-only sandbox but still probes',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'dev-readonly'});
 await writeFile(join(home,'config.toml'),'model = "gpt-5"\nsandbox_mode = "read-only"\napproval_policy = "never"\n');
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const probe=writtenText(await client.call('env_probe',{}));
 assert.equal(probe.available.node,true,'env_probe installs nothing, so it must work in a read-only session');
 assert.equal(probe.sandboxMode,'read-only','the measured sandbox mode must be reported, not guessed');

 assert.equal(failure(await client.call('env_run',{command:'echo blocked'}),{message:/read-only/i}).code,'sandbox/denied');
 assert.equal(failure(await client.call('env_install',{packages:['python']}),{message:/read-only/i}).code,'sandbox/denied');
 assert.equal(failure(await client.call('env_install',{packages:['python'],dryRun:true}),{message:/read-only/i}).code,'sandbox/denied');
 assert.equal(failure(await client.call('env_install',{packages:['ruby'],dryRun:true}),{message:/whitelist/i}).code,'args/invalid','argument validation must run before the sandbox check');
 assert.equal(failure(await client.call('env_install_log',{logPath:'/etc/passwd'})).code,'path/outside-roots','the log reader is still a read-only tool and only validates its path');
});

// ---------------------------------------------------------------------------
// android pack: the App device channel (docs/DEVICE-API-CONTRACT.md). Every tool is
// backed by the handshake file ${CODEX_HOME}/codex-go-device.json, which the App writes
// when the channel is on and deletes when it is off — so these tools must fail honestly
// instead of faking a device.
// ---------------------------------------------------------------------------
const ANDROID_TOOLS=[
 'device_capabilities','device_info','shell_exec',
 'screen','tap','type','scroll','key','tap_xy','collect','apps','open','shot','clipboard','android_shell','device_status',
];

test('android and android-screen packs register per TOOLPACKS-CONTRACT and fail honestly when the channel is off',{timeout:60000},async t=>{
 const {home,files,data}=await workspace(t,{name:'android-off'});
 // No codex-go-device.json in this CODEX_HOME on purpose: the App channel is off.
 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});

 const tools=await client.tools();
 const names=tools.map(tool=>tool.name);
 for(const name of ANDROID_TOOLS)assert.ok(names.includes(name),`missing android tool ${name}`);
 await sleep(150);
 assert.match(client.stderr,/android\(3\)/,'android keeps two read-only capability tools plus the constrained shell tool');
 assert.match(client.stderr,/android-screen\(13\)/,'android-screen must register all 13 tools');

 // 两个包都必须带 meta（契约 §3）且每个工具都有 run。
 for(const tool of tools.filter(item=>ANDROID_TOOLS.includes(item.name))){
  assert.equal(typeof tool.run,'undefined','tools/list must not leak the run function to the model');
 }

 const capabilities=await client.call('device_capabilities',{});
 const off=failure(capabilities,{message:/Phone capabilities in Codex Pocket/});
 assert.equal(off.code,'device/unavailable','a missing handshake must be device/unavailable');
 assert.equal(capabilities.structuredContent.data,undefined,'a failed tool must not fake a result');

 assert.equal(failure(await client.call('device_info',{})).code,'device/unavailable');
 assert.equal(failure(await client.call('shell_exec',{command:'getprop ro.build.version.release',reason:'test channel off'})).code,'device/unavailable');
 assert.equal(failure(await client.call('screen',{})).code,'device/unavailable','android-screen must fail honestly without the channel too');
 assert.equal(failure(await client.call('device_status',{})).code,'device/unavailable');
 // 参数校验先于握手：缺 screen/id 的 tap 应该报参数错，而不是设备错。
 const noScreenId=failure(await client.call('tap',{id:1}));
 assert.equal(noScreenId.code,'args/invalid');
});

test('android-screen drives the fake device channel: numbered screen, id-bound taps, expiry and the read-only guard',{timeout:120000},async t=>{
 const {home,files,data}=await workspace(t,{name:'android-screen'});
 const token='device-token-aaaaaaaaaaaaaaaaaaaaaaaa';
 const permissionMessage='当前是标准权限，读屏用不了：设置 → 手机能力 → 选 ACCESSIBILITY（要开系统无障碍）。';
 const state={deny:false,requests:[]};
 const dump={
  nodes:[
   {index:0,className:'android.widget.FrameLayout',text:null,desc:null,resourceId:null,bounds:[0,0,1080,2460],clickable:false,enabled:true,focused:false,depth:0},
   {index:1,className:'android.widget.TextView',text:'WLAN',desc:null,resourceId:'android:id/title',bounds:[40,120,300,180],clickable:true,enabled:true,focused:false,depth:1},
   {index:2,className:'android.widget.EditText',text:null,desc:'搜索设置',resourceId:'com.android.settings:id/search',bounds:[40,200,1040,260],clickable:true,enabled:true,focused:false,depth:1},
  ],
  screens:[{width:1080,height:2460}],
  truncated:false,
 };

 const httpServer=createServer((request,response)=>{
  response.on('error',()=>{});
  const chunks=[];
  request.on('data',chunk=>{chunks.push(chunk);});
  request.on('end',()=>{
   const raw=Buffer.concat(chunks).toString('utf8');
   let body=null;
   try{body=raw?JSON.parse(raw):null;}catch{body=raw;}
   const url=new URL(request.url,'http://127.0.0.1');
   state.requests.push({method:request.method,pathname:url.pathname,search:url.search,authorization:request.headers.authorization,body});
   const json=(status,payload)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(payload));};
   if(url.pathname==='/capabilities'){
    json(200,{
     tier:state.deny?'standard':'accessibility',
     granted:['accessibility'],
     denied:[],
     capabilities:{ui_dump:!state.deny,ui_tap:!state.deny,ui_text:!state.deny,ui_key:!state.deny,ui_screenshot:!state.deny,clipboard:true,app_list:!state.deny},
     device:{model:'2406ERN9CC',brand:'Redmi',sdk:36},
    });
    return;
   }
   if(state.deny&&url.pathname.startsWith('/ui/')){
    json(501,{error:{code:'device/permission-denied',message:permissionMessage}});
    return;
   }
   if(url.pathname==='/ui/dump'){json(200,dump);return;}
   if(url.pathname==='/ui/tap'){json(200,{ok:true});return;}
   if(url.pathname==='/ui/swipe'||url.pathname==='/ui/text'||url.pathname==='/ui/key'){json(200,{ok:true});return;}
   if(url.pathname==='/app/list'){json(200,{apps:[{packageName:'com.tencent.mobileqq',label:'QQ',system:false,enabled:true}]});return;}
   if(url.pathname==='/app/start'){json(200,{started:true});return;}
   if(url.pathname==='/clipboard'&&request.method==='GET'){json(200,{text:'copied-on-phone'});return;}
   if(url.pathname==='/clipboard'){json(200,{text:body?.text});return;}
   json(404,{error:{code:'device/unsupported',message:'no such device endpoint'}});
  });
 });
 httpServer.on('clientError',()=>{});
 await new Promise(done=>httpServer.listen(0,'127.0.0.1',done));
 const {port}=httpServer.address();
 t.after(()=>new Promise(done=>{httpServer.closeAllConnections?.();httpServer.close(()=>done());}));
 const deviceFile=join(home,'codex-go-device.json');
 await writeFile(deviceFile,JSON.stringify({baseUrl:`http://127.0.0.1:${port}`,token,tier:'accessibility',granted:['accessibility']}));

 const client=await McpClient.start({roots:files,dataDir:data,home});
 t.after(async()=>{await client.kill();});
 const lastRequest=pathname=>state.requests.filter(entry=>entry.pathname===pathname).at(-1);

 // --- device_status: 先看档位，别猜 -----------------------------------------
 const status=writtenText(await client.call('device_status',{}));
 assert.match(status.text,/\u6863\u4f4d\uff1aaccessibility/,'device_status must report the tier the App reports, never a guess');

 // --- screen: 一屏带编号的文字，而不是原始控件树 -----------------------------
 const screen=writtenText(await client.call('screen',{}));
 const screenId=(screen.text.match(/屏幕 (s\d+)/)||[])[1];
 assert.ok(screenId,`screen output must name its screen so ids can be bound to it; got ${JSON.stringify(screen.text)}`);
 assert.match(screen.text,/\[1\] .*WLAN/,'a clickable row becomes one numbered line');
 assert.match(screen.text,/\[2\] 输入框/,'an EditText row is labelled as an input');
 assert.equal(lastRequest('/ui/dump').method,'POST');

 // --- tap: 用编号点，落到 bounds 中心 ---------------------------------------
 writtenText(await client.call('tap',{screen:screenId,id:1}));
 assert.deepEqual(lastRequest('/ui/tap').body,{x:170,y:150,reason:lastRequest('/ui/tap').body.reason});
 assert.match(lastRequest('/ui/tap').body.reason,/\[1\]/,'the audit reason must name the element that was tapped');

 // 编号不在这一屏：拒绝，什么都不发到手机。
 const tapsBefore=state.requests.filter(entry=>entry.pathname==='/ui/tap').length;
 const badId=failure(await client.call('tap',{screen:screenId,id:99}));
 assert.equal(badId.code,'args/invalid');
 assert.equal(state.requests.filter(entry=>entry.pathname==='/ui/tap').length,tapsBefore,'a rejected id must fail before anything reaches the phone');
 // 屏幕号根本不存在：同样拒绝。
 assert.equal(failure(await client.call('tap',{screen:'s9999',id:1})).code,'args/invalid');
 // 缺少 screen/id：参数错。
 assert.equal(failure(await client.call('tap',{id:1})).code,'args/invalid');
 assert.equal(failure(await client.call('tap',{screen:screenId})).code,'args/invalid');

 // --- type: 必须是输入框，否则拒绝 -----------------------------------------
 writtenText(await client.call('type',{screen:screenId,id:2,text:'hello',submit:true}));
 assert.deepEqual(lastRequest('/ui/text').body,{text:'hello',submit:true,reason:lastRequest('/ui/text').body.reason});
 const notEditable=failure(await client.call('type',{screen:screenId,id:1,text:'x'}));
 assert.equal(notEditable.code,'args/invalid','typing into a non-editable row must be refused');

 // --- scroll / key: 有副作用，走真实端点 -----------------------------------
 writtenText(await client.call('scroll',{screen:screenId,direction:'down'}));
 assert.equal(lastRequest('/ui/swipe').body.durationMs,350);
 writtenText(await client.call('key',{key:'back'}));
 assert.deepEqual(lastRequest('/ui/key').body,{key:'back',reason:lastRequest('/ui/key').body.reason});

 // --- apps / open: 端点早就有，只是以前没暴露 ------------------------------
 const apps=writtenText(await client.call('apps',{}));
 assert.match(apps.text,/com\.tencent\.mobileqq/,'apps must list real package ids');
 writtenText(await client.call('open',{app:'com.tencent.mobileqq'}));
 assert.match(JSON.stringify(lastRequest('/app/start').body),/com\.tencent\.mobileqq/,'open must ask the device channel to launch that package');

 // --- clipboard -----------------------------------------------------------
 assert.equal(writtenText(await client.call('clipboard',{get:true})).text,'copied-on-phone');
 writtenText(await client.call('clipboard',{set:'hello from the model'}));
 assert.equal(lastRequest('/clipboard').body.text,'hello from the model');

 // --- 只读沙箱：有副作用的工具必须先拒，且不发请求 -------------------------
 // 只读判定来自 config.toml 的 sandbox_mode（宿主实测，契约 §3.3/§3.4），所以另起一个 home。
 const readOnlyHome=join(home,'readonly');
 await mkdir(readOnlyHome,{recursive:true});
 await writeFile(join(readOnlyHome,'config.toml'),'sandbox_mode = "read-only"\n');
 await writeFile(join(readOnlyHome,'codex-go-device.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${port}`,token,tier:'accessibility',granted:['accessibility']}));
 const readOnlyClient=await McpClient.start({roots:files,dataDir:data,home:readOnlyHome});
 t.after(async()=>{await readOnlyClient.kill();});
 const tapsBeforeReadOnly=state.requests.filter(entry=>entry.pathname==='/ui/tap').length;
 const readsBeforeReadOnly=state.requests.filter(entry=>entry.pathname==='/ui/dump').length;
 const guarded=failure(await readOnlyClient.call('tap',{screen:screenId,id:1}));
 assert.equal(guarded.code,'sandbox/denied','a side-effecting tool must refuse in a read-only sandbox');
 assert.match(guarded.message,/read-only/);
 assert.equal(state.requests.filter(entry=>entry.pathname==='/ui/tap').length,tapsBeforeReadOnly,'a refused tap must not reach the phone');
 assert.equal(state.requests.filter(entry=>entry.pathname==='/ui/dump').length,readsBeforeReadOnly,'the guard must fire before the tool reads the screen');
 // 只读工具照常工作。
 assert.ok(writtenText(await readOnlyClient.call('screen',{})).text.includes('WLAN'),'reading the screen is still allowed in a read-only sandbox');

 // --- App 侧的档位拒绝原样透传 -------------------------------------------
 state.deny=true;
 const denied=failure(await client.call('screen',{}));
 assert.equal(denied.code,'device/permission-denied','the App code must survive untouched');
 assert.equal(denied.message,permissionMessage,'the App message must be passed through verbatim');
 state.deny=false;
});
