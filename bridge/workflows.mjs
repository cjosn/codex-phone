// Persistent, sequential workflow execution. No synthetic progress or background timers.
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';

const problem=(message,code='workflow/invalid')=>Object.assign(new Error(message),{code,status:400});
export function validateWorkflow(body){
 if(!body||typeof body.name!=='string'||!body.name.trim())throw problem('Workflow name is required');
 if(body.name.length>120)throw problem('Workflow name is too long');
 if(!Array.isArray(body.steps)||body.steps.length===0||body.steps.length>50)throw problem('Workflow requires 1 to 50 steps');
 const steps=body.steps.map((step,index)=>{
  if(!step||typeof step!=='object'||Array.isArray(step))throw problem(`Step ${index+1} must be an object`);
  if(step.type==='prompt'){
   if(typeof step.text!=='string'||!step.text.trim())throw problem(`Prompt step ${index+1} requires text`);
   if(step.threadId!==undefined&&(typeof step.threadId!=='string'||!step.threadId.trim()))throw problem(`Prompt step ${index+1} threadId must be a string`);
   return {type:'prompt',text:step.text,...(step.threadId?{threadId:step.threadId}:{})};
  }
  if(step.type==='shell'){
   if(!Array.isArray(step.argv)||step.argv.length===0||step.argv.some(value=>typeof value!=='string'||!value))throw problem(`Shell step ${index+1} requires a nonempty string argv`);
   if(step.cwd!==undefined&&(typeof step.cwd!=='string'||!step.cwd.trim()))throw problem(`Shell step ${index+1} cwd must be a string`);
   if(step.timeoutMs!==undefined&&(!Number.isSafeInteger(step.timeoutMs)||step.timeoutMs<1000||step.timeoutMs>3600000))throw problem(`Shell step ${index+1} timeoutMs must be 1000..3600000`);
   return {type:'shell',argv:[...step.argv],...(step.cwd?{cwd:step.cwd}:{}),...(step.timeoutMs?{timeoutMs:step.timeoutMs}:{})};
  }
  throw problem(`Step ${index+1} must be prompt or shell`);
 });
 return {name:body.name.trim(),steps};
}

export class WorkflowStore{
 constructor(directory,{executePrompt,executeShell,onChange}={}){
  this.directory=directory;this.file=path.join(directory,'workflows.json');this.runFile=path.join(directory,'workflow-runs.json');
  this.executePrompt=executePrompt;this.executeShell=executeShell;this.onChange=onChange;this.workflows=[];this.runs=[];this.active=new Map();this.writeChain=Promise.resolve();
 }
 async load(){
  this.workflows=await this.#read(this.file);this.runs=await this.#read(this.runFile);
  // A process restart cannot honestly resume an in-flight child/turn.
  let changed=false;for(const run of this.runs)if(run.status==='running'){run.status='interrupted';run.finishedAt=Date.now();run.error='Bridge stopped during execution';changed=true;}
  if(changed)await this.#write(this.runFile,this.runs);
  return this;
 }
 async #read(file){try{const value=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(value))throw Error('Expected an array');return value;}catch(error){if(error.code==='ENOENT')return [];throw error;}}
 #write(file,value){this.writeChain=this.writeChain.then(async()=>{await mkdir(this.directory,{recursive:true,mode:0o700});const temporary=file+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temporary,file);});return this.writeChain;}
 list(){return this.workflows;}
 get(id){const workflow=this.workflows.find(item=>item.id===id);if(!workflow)throw problem('Workflow not found','workflow/not-found');return workflow;}
 getRun(id){const run=this.runs.find(item=>item.id===id);if(!run)throw problem('Workflow run not found','workflow/not-found');return run;}
 runsFor(id){this.get(id);return this.runs.filter(run=>run.workflowId===id);}
 async create(body){const value=validateWorkflow(body);const workflow={id:randomUUID(),...value,createdAt:Date.now()};this.workflows.push(workflow);await this.#write(this.file,this.workflows);return workflow;}
 async delete(id){this.get(id);if(this.active.has(id))throw problem('Workflow is running','workflow/busy');this.workflows=this.workflows.filter(item=>item.id!==id);this.runs=this.runs.filter(item=>item.workflowId!==id);await this.#write(this.file,this.workflows);await this.#write(this.runFile,this.runs);return {deleted:true,id};}
 async run(id,{approveShell=false}={}){
  const workflow=this.get(id);if(this.active.has(id))throw problem('Workflow is already running','workflow/busy');
  if(workflow.steps.some(step=>step.type==='shell')&&approveShell!==true)throw problem('Running shell steps requires explicit approveShell=true for this run','workflow/approval-required');
  const run={id:randomUUID(),workflowId:id,status:'running',startedAt:Date.now(),finishedAt:null,steps:workflow.steps.map((step,index)=>({index,type:step.type,status:'pending'})),error:null};
  this.runs.unshift(run);if(this.runs.length>100)this.runs.length=100;this.active.set(id,run.id);
  await this.#write(this.runFile,this.runs);this.onChange?.(run);
  try{
   for(let index=0;index<workflow.steps.length;index++){
    const definition=workflow.steps[index],record=run.steps[index];record.status='running';record.startedAt=Date.now();await this.#write(this.runFile,this.runs);this.onChange?.(run);
    const result=definition.type==='prompt'
     ?await this.executePrompt?.(definition,{workflowId:id,runId:run.id,step:index})
     :await this.executeShell?.(definition,{workflowId:id,runId:run.id,step:index});
    if(!result)throw Error(`No ${definition.type} executor is available in this process`);
    Object.assign(record,result,{status:'completed',finishedAt:Date.now()});await this.#write(this.runFile,this.runs);this.onChange?.(run);
   }
   run.status='completed';
  }catch(error){const current=run.steps.find(step=>step.status==='running');if(current){current.status='failed';current.finishedAt=Date.now();current.error=error.message;}run.status='failed';run.error=error.message;}
  finally{run.finishedAt=Date.now();this.active.delete(id);await this.#write(this.runFile,this.runs);this.onChange?.(run);}
  if(run.status==='failed')throw Object.assign(new Error(run.error),{code:'workflow/failed',status:500,details:{run}});
  return run;
 }
}
