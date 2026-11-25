// plan: 可跨 MCP 重启存活的步骤化计划。
// 状态存放在 ctx.dataDir/toolpack-plan.json，原子写入；所有写操作串行化，
// 两次并发调用不会丢步骤。
// 约定：run() 只返回可 JSON 序列化的数据（宿主负责封装），失败一律 throw 带 code 的 Error。
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readJsonStore,serializeTasks,writeJsonStore} from '../_shared.mjs';

const FILE='toolpack-plan.json';
const MAX_PLANS=50;       // 计划总数上限，满时自动丢弃最早更新的已完成计划
const MAX_STEPS=200;      // 单个计划的步骤上限
const MAX_TITLE=300;      // 计划标题 / 步骤标题长度上限
const MAX_NOTE=4000;      // 步骤备注长度上限
const MAX_SUMMARY=4000;   // 完成摘要长度上限
const STEP_STATUSES=['pending','in_progress','done','blocked','skipped'];
const serialize=serializeTasks();

const fail=(message,code)=>Object.assign(Error(message),{code});
const DENIED_CODES=new Set(['EACCES','EPERM','EROFS']);

// ---------------------------------------------------------------------------
// 状态读写：把 _shared 的裸错误翻译成本组统一错误码。
// ---------------------------------------------------------------------------
async function load(ctx){
 try{
  const store=await readJsonStore(ctx,FILE);
  const plans=Array.isArray(store.plans)?store.plans.filter(plan=>plan&&typeof plan.id==='string'):[];
  return {version:2,...store,plans};
 }catch(error){
  const target=path.join(ctx.dataDir,FILE);
  if(DENIED_CODES.has(error?.code)){
   throw fail(`Cannot read the plan store ${target}: the filesystem or sandbox denied access. Grant read access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  if(error?.code==='toolpack/store-corrupt'){
   throw fail(`The plan store ${target} is not valid JSON (${error.message}); it was left untouched so no plan was lost. Repair or delete that file, then retry`,'state/corrupt');
  }
  throw fail(`Reading the plan store ${target} failed (${error?.code??'unknown error'}: ${error?.message??error}); nothing was changed. Retry once, then check the data directory permissions`,'state/corrupt');
 }
}

async function save(ctx,store){
 const target=path.join(ctx.dataDir,FILE);
 try{return await writeJsonStore(ctx,FILE,store);}
 catch(error){
  if(DENIED_CODES.has(error?.code)){
   throw fail(`Cannot write the plan store ${target}: the filesystem or sandbox denied the write. Grant write access to the data directory (or leave read-only mode), then retry`,'sandbox/denied');
  }
  throw fail(`Writing the plan store ${target} failed (${error?.code??'unknown error'}: ${error?.message??error}); the previous plans are intact. Retry once, then check free disk space and directory ownership`,'store/write-failed');
 }
}

// ---------------------------------------------------------------------------
// 计划 / 步骤查找
// ---------------------------------------------------------------------------
function countsOf(plan){
 const counts={total:plan.steps.length,done:0,inProgress:0,pending:0,blocked:0,skipped:0};
 for(const step of plan.steps){
  if(step.status==='done')counts.done++;
  else if(step.status==='in_progress')counts.inProgress++;
  else if(step.status==='blocked')counts.blocked++;
  else if(step.status==='skipped')counts.skipped++;
  else counts.pending++;
 }
 return counts;
}

function summaryOf(plan){
 return {
  id:plan.id,
  title:plan.title,
  status:plan.status,
  createdAt:plan.createdAt,
  updatedAt:plan.updatedAt,
  completedAt:plan.completedAt??null,
  counts:countsOf(plan),
 };
}

function publicPlan(plan){
 return {...plan,counts:countsOf(plan)};
}

function findPlan(store,id){
 if(!id)return null;
 return store.plans.find(plan=>plan.id===id)??null;
}

// “当前计划” = 最近更新的未完成计划；没有未完成计划时退化为最近更新的已完成计划；都没有则 null。
function currentPlan(store,id){
 if(id){
  const plan=findPlan(store,id);
  if(!plan){
   const known=store.plans.map(candidate=>`${candidate.id} (${candidate.title})`).join(', ')||'none';
   throw fail(`Unknown plan id: ${id}. Known plans: ${known}. Call plan_get without an id to see the current plan, or plan_create to start a new one`,'state/not-found');
  }
  return plan;
 }
 const active=store.plans.filter(plan=>plan.status!=='completed').sort((left,right)=>(right.updatedAt??'').localeCompare(left.updatedAt??''));
 if(active.length)return active[0];
 const completed=[...store.plans].sort((left,right)=>(right.updatedAt??'').localeCompare(left.updatedAt??''));
 return completed[0]??null;
}

function requirePlan(store,id,label='plan'){
 const plan=currentPlan(store,id);
 if(!plan){
  throw fail(`No ${label} exists yet${id?` with id ${id}`:''}; call plan_create first to create one, then retry`,'state/not-found');
 }
 return plan;
}

function requireStep(store,stepId,planId){
 const planIdValue=typeof planId==='string'&&planId.trim()?planId:undefined;
 const plan=planIdValue?requirePlan(store,planIdValue):store.plans.find(candidate=>candidate.steps.some(step=>step.id===stepId));
 if(!plan){
  throw fail(`Unknown step id: ${stepId}. Pass the stepId returned by plan_add_step or plan_create, or read the plan with plan_get`,'state/not-found');
 }
 const step=plan.steps.find(candidate=>candidate.id===stepId);
 if(!step)throw fail(`Step ${stepId} does not belong to plan ${plan.id}; pass the matching planId or retry with a step id from that plan`,'state/not-found');
 return {plan,step};
}

// ---------------------------------------------------------------------------
// 参数校验：失败统一 args/invalid。
// ---------------------------------------------------------------------------
function needString(value,label){
 if(typeof value!=='string'||!value.trim()){
  const got=value===undefined||value===null?'missing':`a ${typeof value}`;
  throw fail(`${label} must be a nonempty string but was ${got}; pass a nonempty string, then retry`,'args/invalid');
 }
 return value;
}

function maybeString(value,label){
 if(value===undefined||value===null)return undefined;
 if(typeof value==='string'&&!value.trim())return undefined;
 return needString(value,label);
}

function needTitle(value,label,max=MAX_TITLE){
 const text=needString(value,label);
 if(text.length>max){
  throw fail(`${label} is ${text.length} characters but the limit is ${max}; shorten it, then retry`,'args/invalid');
 }
 return text;
}

function needNote(value,label,max=MAX_NOTE){
 const text=maybeString(value,label);
 if(text&&text.length>max){
  throw fail(`${label} is ${text.length} characters but the limit is ${max}; shorten it, then retry`,'args/invalid');
 }
 return text;
}

function newStep(input,index){
 const title=needTitle(input?.title,`steps[${index}].title`);
 const now=new Date().toISOString();
 return {
  id:randomUUID(),
  title,
  note:needNote(input?.note,`steps[${index}].note`)??null,
  status:'pending',
  createdAt:now,
  updatedAt:now,
 };
}

export const meta={
 name:'plan',
 title:'Plans',
 version:'2.0.0',
 description:'Durable step-based plans (get, create, add step, update step, complete) stored as atomic JSON at <dataDir>/toolpack-plan.json.',
};

export const tools=[
 {
  name:'plan_get',
  description:[
   'Use this to re-read the plan before continuing multi-step work, and to recover the current plan after a restart instead of asking the user to repeat it.',
   'id (string, optional) selects one plan by id; an unknown id fails with state/not-found. Omit it to get the current plan, defined as the most recently updated plan that is not completed, or the most recently updated completed plan when every plan is done.',
   'Returns {plan, count, plans}. plan is the full current plan with steps, or null when no plan exists yet; count is the number of stored plans; plans is a summary list of every plan with its per-status counts.',
   'A plan step looks like {id,title,note,status,createdAt,updatedAt,completedAt} with status one of pending, in_progress, done, blocked, skipped; counts has total, done, inProgress, pending, blocked, skipped.',
   'Read-only: no file is written. A missing store returns plan null and count 0 rather than failing.',
   'Failures: args/invalid (id is not a string), state/not-found (unknown id), state/corrupt (the store file is not valid JSON), sandbox/denied (the data directory cannot be read).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   id:{type:'string',minLength:1,description:'Plan id to read. Omit to read the current plan.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>{
   const store=await load(ctx);
   const plan=currentPlan(store,maybeString(args.id,'id'));
   return {plan:plan?publicPlan(plan):null,count:store.plans.length,plans:store.plans.map(summaryOf)};
  },
 },
 {
  name:'plan_create',
  description:[
   'Use this at the start of any task that needs more than a couple of steps, so progress survives restarts and can be resumed later.',
   'title (string, required, 1-300 characters) names the plan.',
   'steps (array, optional, default [], at most 200 items) are the initial steps; each item is an object {title (required, 1-300 characters), note (optional, at most 4000 characters)}. Every step starts as pending with a generated id.',
   'The new plan is stored with status active and becomes the current plan because its updatedAt is the newest, so plan_get without an id returns it.',
   'Capacity: at most 50 plans are stored; when the store is full the completed plan with the oldest updatedAt is dropped automatically to make room, and when every plan is still active the call fails with state/conflict instead of discarding work.',
   'Returns {plan, created:true, count} where plan is the stored plan with its steps and counts, and count is the number of plans kept after the write.',
   'Persistence: written atomically to <dataDir>/toolpack-plan.json with 0600 permissions; writes are serialized inside this pack, so concurrent plan_create calls cannot lose a plan.',
   'Failures: args/invalid (missing or over-long title, over-long note, more than 200 steps), state/conflict (50 active plans), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   title:{type:'string',minLength:1,maxLength:MAX_TITLE,description:'Plan title, 1-300 characters.'},
   steps:{type:'array',maxItems:MAX_STEPS,description:'Optional initial steps, at most 200; each starts as pending. Omit or pass [] to create an empty plan.',items:{type:'object',properties:{
    title:{type:'string',minLength:1,maxLength:MAX_TITLE,description:'Step text, 1-300 characters.'},
    note:{type:'string',maxLength:MAX_NOTE,description:'Optional detail for the step, at most 4000 characters; stored as null when omitted.'},
   },required:['title'],additionalProperties:false}},
  },required:['title'],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const title=needTitle(args.title,'title');
   if(args.steps!==undefined&&args.steps!==null&&!Array.isArray(args.steps)){
    throw fail('steps must be an array of {title, note} objects; pass an array or omit it, then retry','args/invalid');
   }
   const requested=Array.isArray(args.steps)?args.steps:[];
   if(requested.length>MAX_STEPS){
    throw fail(`steps has ${requested.length} items but the limit is ${MAX_STEPS}; split the work into several plans or fewer steps, then retry`,'args/invalid');
   }
   if(store.plans.length>=MAX_PLANS){
    const finished=store.plans.filter(plan=>plan.status==='completed').sort((left,right)=>(left.updatedAt??'').localeCompare(right.updatedAt??''))[0];
    if(!finished){
     throw fail(`The store already holds the maximum ${MAX_PLANS} plans and none of them is completed, so nothing can be dropped automatically; complete an existing plan with plan_complete first, then retry`,'state/conflict');
    }
    store.plans=store.plans.filter(plan=>plan.id!==finished.id);
   }
   const now=new Date().toISOString();
   const plan={
    id:randomUUID(),
    title,
    status:'active',
    createdAt:now,
    updatedAt:now,
    completedAt:null,
    summary:null,
    steps:requested.map(newStep),
   };
   store.plans.push(plan);
   await save(ctx,store);
   return {plan:publicPlan(plan),created:true,count:store.plans.length};
  }),
 },
 {
  name:'plan_add_step',
  description:[
   'Use this when the plan needs another step, for example after discovering extra work mid-task; the step is persisted immediately.',
   'planId (string, optional) targets one plan; omit it to append to the current plan (the most recently updated unfinished plan).',
   'title (string, required, 1-300 characters) is the step text.',
   'note (string, optional, at most 4000 characters) is extra detail stored with the step.',
   'The appended step starts as pending with a generated id, the plan updatedAt is refreshed, and the new step id is returned so plan_update_step can address it later.',
   'Refusals: appending to a completed plan fails with state/conflict (create a new plan instead), and a plan that already holds 200 steps fails with state/conflict too.',
   'Returns {plan, step} where plan is the updated plan with fresh counts and step is the appended step object.',
   'Persistence: atomic write to <dataDir>/toolpack-plan.json, serialized inside this pack.',
   'Failures: args/invalid (missing or over-long title or note), state/not-found (unknown planId, or no plan exists yet), state/conflict (completed plan, 200 step cap), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   planId:{type:'string',minLength:1,description:'Target plan id; omit to use the current plan.'},
   title:{type:'string',minLength:1,maxLength:MAX_TITLE,description:'Step text, 1-300 characters.'},
   note:{type:'string',maxLength:MAX_NOTE,description:'Optional detail for the step, at most 4000 characters.'},
  },required:['title'],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const plan=requirePlan(store,maybeString(args.planId,'planId'));
   if(plan.status==='completed'){
    throw fail(`Plan ${plan.id} is already completed; open a new plan with plan_create to keep planning`,'state/conflict');
   }
   if(plan.steps.length>=MAX_STEPS){
    throw fail(`Plan ${plan.id} already holds the maximum ${MAX_STEPS} steps; complete or split the plan instead of appending more`,'state/conflict');
   }
   const step=newStep(args,0);
   plan.steps.push(step);
   plan.updatedAt=new Date().toISOString();
   await save(ctx,store);
   return {plan:publicPlan(plan),step};
  }),
 },
 {
  name:'plan_update_step',
  description:[
   'Use this to record progress on one step: mark it in_progress when starting, done when finished, blocked or skipped when it cannot be done.',
   'stepId (string, required) is the id returned when the step was created or appended.',
   'planId (string, optional) names the plan that owns the step; when omitted the step id is looked up across all plans, which costs nothing for small stores but is ambiguous only if two plans share a step id (they never do, ids are UUIDs).',
   'status (string enum, optional) is one of pending, in_progress, done, blocked, skipped. Setting done stamps completedAt, any other status clears completedAt to null.',
   'title (string, optional, 1-300 characters) replaces the step text; note (string, optional, at most 4000 characters) replaces the note and an empty string clears it to null.',
   'At least one of status, title or note must be supplied, otherwise args/invalid is returned and nothing changes. The plan updatedAt is refreshed by every successful call, which also makes it the current plan.',
   'Returns {plan, step} with the updated plan (fresh counts) and the updated step.',
   'Persistence: atomic write to <dataDir>/toolpack-plan.json, serialized inside this pack, so concurrent updates cannot lose each other.',
   'Failures: args/invalid (unknown status value, nothing to change, over-long text), state/not-found (unknown stepId or planId), state/conflict, state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   stepId:{type:'string',minLength:1,description:'Id of the step to update.'},
   planId:{type:'string',minLength:1,description:'Plan that contains the step; looked up across plans when omitted.'},
   status:{type:'string',enum:STEP_STATUSES,description:'New step status: pending (not started), in_progress (being worked on), done (finished, stamps completedAt), blocked (cannot proceed, needs a decision), skipped (deliberately not done).'},
   title:{type:'string',minLength:1,maxLength:MAX_TITLE,description:'Replacement step text, 1-300 characters.'},
   note:{type:'string',maxLength:MAX_NOTE,description:'Replacement note, at most 4000 characters; an empty string clears the note.'},
  },required:['stepId'],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const stepId=needString(args.stepId,'stepId');
   const {plan,step}=requireStep(store,stepId,maybeString(args.planId,'planId'));
   const status=maybeString(args.status,'status');
   if(status!==undefined&&!STEP_STATUSES.includes(status)){
    throw fail(`status must be one of ${STEP_STATUSES.join(', ')} but was ${JSON.stringify(status)}; retry with one of those values`,'args/invalid');
   }
   if(status===undefined&&args.title===undefined&&args.note===undefined){
    throw fail('plan_update_step needs something to change: pass status, title or note; nothing was changed','args/invalid');
   }
   if(status!==undefined)step.status=status;
   if(args.title!==undefined)step.title=needTitle(args.title,'title');
   if(args.note!==undefined)step.note=needNote(args.note,'note')??null;
   const now=new Date().toISOString();
   step.updatedAt=now;
   step.completedAt=status==='done'?now:null;
   plan.updatedAt=now;
   await save(ctx,store);
   return {plan:publicPlan(plan),step};
  }),
 },
 {
  name:'plan_complete',
  description:[
   'Use this when the plan is finished or abandoned, optionally recording the outcome, so later sessions see a closed plan instead of a stale active one.',
   'planId (string, optional) selects the plan to complete; omit it to complete the current plan, which fails with state/not-found when no plan exists yet.',
   'summary (string, optional, at most 4000 characters) is stored on the plan as its outcome; omit it to store null.',
   'completeSteps (boolean, optional, default false) marks every pending, in_progress or blocked step as done with a completion timestamp; skipped steps stay skipped and steps already done keep their timestamps.',
   'Other plans are untouched. Repeated calls on an already completed plan succeed and simply refresh summary, completedAt and updatedAt.',
   'Returns {plan, completed:true, remainingOpen} where remainingOpen counts steps still pending or in_progress after the call, so 0 means nothing is left open.',
   'Persistence: atomic write to <dataDir>/toolpack-plan.json, serialized inside this pack.',
   'Failures: args/invalid (summary too long, completeSteps not a boolean), state/not-found (unknown planId or no plan exists), state/corrupt, store/write-failed, sandbox/denied.',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   planId:{type:'string',minLength:1,description:'Plan to complete; omit to complete the current plan.'},
   summary:{type:'string',maxLength:MAX_SUMMARY,description:'Outcome summary stored with the plan, at most 4000 characters; defaults to null.'},
   completeSteps:{type:'boolean',description:'Mark remaining pending, in_progress and blocked steps as done. Defaults to false.'},
  },required:[],additionalProperties:false},
  run:async(args={},ctx)=>serialize(async()=>{
   const store=await load(ctx);
   const plan=requirePlan(store,maybeString(args.planId,'planId'));
   const summary=needNote(args.summary,'summary',MAX_SUMMARY)??null;
   let completeSteps=false;
   if(args.completeSteps!==undefined&&args.completeSteps!==null){
    if(typeof args.completeSteps!=='boolean'){
     throw fail(`completeSteps must be a boolean but was a ${typeof args.completeSteps}; pass true or false, then retry`,'args/invalid');
    }
    completeSteps=args.completeSteps;
   }
   const now=new Date().toISOString();
   if(completeSteps){
    for(const step of plan.steps){
     if(step.status!=='done'&&step.status!=='skipped'){step.status='done';step.completedAt=now;step.updatedAt=now;}
    }
   }
   plan.status='completed';
   plan.completedAt=now;
   plan.updatedAt=now;
   plan.summary=summary;
   await save(ctx,store);
   return {plan:publicPlan(plan),completed:true,remainingOpen:plan.steps.filter(step=>step.status==='pending'||step.status==='in_progress').length};
  }),
 },
];
