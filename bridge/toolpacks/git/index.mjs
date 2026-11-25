// git: real repository inspection and staging/commit helpers.
// 每条命令都是 spawn('git', argv, {cwd, shell:false})，cwd 一定在允许根之内；
// 读类工具（status/diff/log）只读，只读沙箱下仍可用；git_add / git_commit 会写仓库，
// 只读沙箱下直接抛 sandbox/denied。
import path from 'node:path';
import {insidePath,optionalBoolean,optionalInteger,optionalString,requireString,requireStringArray,resolveDirectory,runOrThrow} from '../_shared.mjs';

const MAX_OUTPUT=1024*1024;
const TIMEOUT_MS=60000;

// ---------------------------------------------------------------------------
// 统一失败约定：run() 只返回可 JSON 序列化的数据（宿主会包成 {ok:true,data:V}），
// 失败一律 throw Error + code。_shared.mjs 抛的是旧的 toolpack/* 码，这里映射成本组
// 的统一码，消息原样保留。
// ---------------------------------------------------------------------------
const fail=(message,code)=>Object.assign(Error(message),{code});

const SHARED_ERROR_CODES={
 'toolpack/outside-roots':'path/outside-roots',
 'toolpack/timeout':'git/command-failed',
 'toolpack/command-failed':'git/command-failed',
};

function normalizeError(error){
 if(error&&typeof error==='object'&&typeof error.code==='string'){
  const mapped=SHARED_ERROR_CODES[error.code];
  if(mapped)return Object.assign(error,{code:mapped});
  if(error.code.includes('/'))return error;
 }
 const message=String(error?.message??error);
 const missing=message.match(/^Path does not exist: (.+)$/);
 if(missing)return fail(`Path does not exist: ${missing[1]}. Check the spelling against the allowed roots, then retry.`,'path/not-found');
 const parentMissing=message.match(/^Parent directory does not exist: (.+)$/);
 if(parentMissing)return fail(`Parent directory does not exist: ${parentMissing[1]}. Create the parent first, then retry.`,'path/not-found');
 if(/^Not a directory: /.test(message))return fail(`${message}. This tool needs a directory inside an allowed root; pass the repository directory.`,'path/not-a-file');
 if(/^Not a regular file: /.test(message))return fail(`${message}. This tool needs a regular file; directories and devices are rejected.`,'path/not-a-file');
 if(/outside the allowed roots/i.test(message))return fail(message,'path/outside-roots');
 if(/must be an integer between|must be a nonempty string|must be a boolean|must be a nonempty string array|must be one of/i.test(message))return fail(`${message}. Read the tool inputSchema for the accepted type, range and enum values, then retry.`,'args/invalid');
 if(/does not exist/i.test(message))return fail(message,'path/not-found');
 if(/ENOENT|not found on PATH/i.test(`${error?.code??''} ${message}`))return fail(`${message}. The git executable is missing or not on PATH, so nothing was run; install git and retry.`,'exec/unavailable');
 return fail(message,'tool/internal');
}

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
// sandbox.type）或环境变量里声明只读；任一命中即拒绝一切会改动仓库的工具。
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
 throw fail(`${tool} changes the repository (index or commits), but this session runs in a read-only sandbox, so nothing was staged or committed. Ask the user to switch the sandbox to workspace-write or danger-full-access and retry; git_status, git_diff and git_log stay available for inspection.`,'sandbox/denied');
}

// 统一的 git 调用：只读命令照常返回，写命令由调用方先过 requireWritable。
async function git(repository,args,{allowEmpty=false}={}){
 try{
  return await runOrThrow(['git','--no-pager',...args],{cwd:repository,timeoutMs:TIMEOUT_MS,maxBytes:MAX_OUTPUT});
 }catch(error){
  const stderr=String(error.details?.stderr??'');
  if(error.code==='ENOENT')throw fail('git is not installed or not on PATH, so no git command could run. Install git, then retry.','exec/unavailable');
  if(error.code==='toolpack/timeout')throw fail(`git ${args[0]} timed out after ${TIMEOUT_MS}ms in ${repository}, so no result was produced. Retry with a narrower scope (a lower limit or a specific path) or check the repository for a stale lock.`,'git/command-failed');
  if(allowEmpty&&/does not have any commits yet|unknown revision|bad default revision/i.test(stderr||error.message))return {argv:['git',...args],exitCode:128,stdout:'',stderr,emptyRepository:true};
  throw Object.assign(fail(`git ${args[0]} failed in ${repository} (exit ${error.details?.exitCode??'unknown'}): ${(stderr||error.message).trim().slice(0,1200)||'no output'}. Fix the reported problem (missing identity, empty index, hook failure or permissions) and call the tool again.`,'git/command-failed'),{details:error.details});
 }
}

function parseStatus(raw){
 const entries=[];
 let branch=null,ahead=null,behind=null;
 for(const line of raw.split(/\r?\n/)){
  if(!line.trim())continue;
  if(line.startsWith('## ')){
   const info=line.slice(3);
   const [head,rest]=info.split(' [');
   branch=head.trim();
   const match=rest?.match(/ahead (\d+)/);if(match)ahead=Number(match[1]);
   const back=rest?.match(/behind (\d+)/);if(back)behind=Number(back[1]);
   continue;
  }
  const code=line.slice(0,2);
  let file=line.slice(3);
  if(code.includes('R')||code.includes('C')){
   const [from,to]=file.split(' -> ');
   file=to??file;
   entries.push({code,path:file,previousPath:from??null});
   continue;
  }
  entries.push({code,path:file});
 }
 return {branch,ahead,behind,entries};
}

async function repositoryOf(args,ctx,{label='path'}={}){
 const directory=await resolveDirectory(ctx.roots,args.path??'.',{label});
 let check;
 try{
  check=await git(directory,['rev-parse','--show-toplevel']);
 }catch(error){
  if(error.code==='exec/unavailable')throw error;
  throw fail(`Not a git repository: ${directory} is inside the allowed roots but no git work tree could be resolved there (git rev-parse --show-toplevel failed). Point path at a repository root or a directory inside one, or run git init first.`,'git/not-a-repo');
 }
 const top=check.stdout.trim();
 if(!top)throw fail(`Not a git repository: ${directory} did not report a work tree top level. Point path at a repository root and retry.`,'git/not-a-repo');
 if(!ctx.roots.some(root=>insidePath(top,root)))throw fail(`Repository top level is outside the allowed roots: ${top}. Only repositories inside an allowed root can be used; move or clone the repository into an allowed root and retry.`,'path/outside-roots');
 return {directory,top};
}

function validateRelativeFiles(top,files){
 return files.map(file=>{
  if(file.startsWith('-'))throw fail(`Refusing a path that looks like a git option: ${file}. Pass repository-relative file paths without a leading dash, then retry.`,'args/invalid');
  const resolved=path.resolve(top,file);
  if(!insidePath(resolved,top))throw fail(`Path escapes the repository: ${file} (resolved to ${resolved}, repository is ${top}). Pass a repository-relative path that stays inside the repository.`,'path/outside-roots');
  return file;
 });
}

const pathProperty=(description)=>({type:'string',description});

export const meta={
 name:'git',
 title:'Git',
 version:'1.0.0',
 description:'Inspect and stage changes in git repositories that live inside the allowed roots. Failures carry a code such as args/invalid, path/outside-roots, path/not-found, git/not-a-repo, git/command-failed, exec/unavailable or sandbox/denied.',
};

export const tools=[
 {
  name:'git_status',
  description:'Use this first before touching a repository: it reports the branch, ahead/behind counts and one entry per changed path, so you can see whether the tree is clean. Parameter: path (string, default ".") is the repository directory or any directory inside it; it must resolve inside an allowed root and the work tree top level must be inside an allowed root too. Returns {path: work tree top level, branch: "main" or "main...origin/main" style string or null when detached, upstream: the tracked branch or null, ahead: number|null, behind: number|null, clean: boolean, entries: [{code: two-letter git porcelain code such as " M", "M ", "??", "R ", path: repository-relative path, previousPath: source path for renames and copies}]}. Untracked files are listed individually. This tool only reads, so it also works in a read-only sandbox. Failures: "args/invalid" (path empty or not a string), "path/outside-roots" (path or work tree top outside the allowed roots), "path/not-found" (directory missing), "path/not-a-file" (path is not a directory), "git/not-a-repo" (no work tree there), "git/command-failed", "exec/unavailable" (git missing), "tool/internal".',
  inputSchema:{type:'object',properties:{
   path:pathProperty('Repository directory, or any directory inside it; must stay inside the allowed roots. Defaults to "." (the first allowed root).'),
  },required:[],additionalProperties:false},
  run:guard(async(args,ctx)=>{
   const {top}=await repositoryOf(args,ctx);
   const result=await git(top,['status','--porcelain=v1','-b','--untracked-files=all']);
   const parsed=parseStatus(result.stdout);
   return {path:top,branch:parsed.branch,upstream:parsed.branch?.includes('...')?parsed.branch.split('...')[1]:null,ahead:parsed.ahead,behind:parsed.behind,clean:parsed.entries.length===0,entries:parsed.entries};
  }),
 },
 {
  name:'git_diff',
  description:'Use this to read exactly what changed before committing or reviewing: it returns the real unified diff text. Parameters: path (string, default ".") is the repository directory or any directory inside it, inside an allowed root; staged (boolean, default false) diffs the index against HEAD instead of the working tree; target (string, optional) is a revision or range to diff against, for example "HEAD~1", and must not start with a dash. Returns {path: work tree top level, staged: boolean, target: string|null, diff: unified diff text ("" when there is no change), bytes: diff size in bytes, lines: number of diff lines excluding the trailing empty line, truncated: boolean (true when git output passed 1048576 bytes)}. This tool only reads, so it also works in a read-only sandbox. Failures: "args/invalid" (bad boolean, target starting with a dash), "path/outside-roots", "path/not-found", "path/not-a-file", "git/not-a-repo", "git/command-failed" (bad revision, unmerged path), "exec/unavailable", "tool/internal".',
  inputSchema:{type:'object',properties:{
   path:pathProperty('Repository directory, or any directory inside it; must stay inside the allowed roots. Defaults to "." (the first allowed root).'),
   staged:{type:'boolean',description:'Diff the index against HEAD (what git commit would record) when true. Defaults to false, which diffs the working tree against the index.'},
   target:{type:'string',description:'Optional revision or revision range to diff against, for example "HEAD~1" or "main..HEAD". Must not start with a dash.'},
  },required:[],additionalProperties:false},
  run:guard(async(args,ctx)=>{
   // 先校验参数再碰仓库：参数错误不应该被后面的 "not a repo" 盖掉。
   const staged=optionalBoolean(args.staged,'staged');
   const target=optionalString(args.target,'target');
   if(target&&target.startsWith('-'))throw fail('target must not start with a dash: git would read it as an option. Pass a revision such as HEAD~1, then retry.','args/invalid');
   const {top}=await repositoryOf(args,ctx);
   const argv=['diff','--no-color',...(staged?['--cached']:[]),...(target?[target]:[]),'--'];
   const result=await git(top,argv);
   return {path:top,staged,target:target??null,diff:result.stdout,bytes:Buffer.byteLength(result.stdout),lines:result.stdout?result.stdout.split(/\r?\n/).length-1:0,truncated:result.truncated};
  }),
 },
 {
  name:'git_log',
  description:'Use this to read recent history before changing code: it returns one record per commit, newest first. Parameters: path (string, default ".") is the repository directory or any directory inside it, inside an allowed root; limit (integer, 1 to 200, default 20) is how many commits to return. Returns {path: work tree top level, limit, count: number of commits returned, emptyRepository: boolean (true when HEAD has no commits yet), commits: [{hash: full 40 hex sha, shortHash, author: author name, date: ISO-8601 author date, subject: first line of the message}]}. This tool only reads, so it also works in a read-only sandbox. Failures: "args/invalid" (limit outside 1 to 200), "path/outside-roots", "path/not-found", "path/not-a-file", "git/not-a-repo", "git/command-failed", "exec/unavailable", "tool/internal".',
  inputSchema:{type:'object',properties:{
   path:pathProperty('Repository directory, or any directory inside it; must stay inside the allowed roots. Defaults to "." (the first allowed root).'),
   limit:{type:'integer',minimum:1,maximum:200,description:'Number of commits to return, newest first, 1 to 200. Defaults to 20.'},
  },required:[],additionalProperties:false},
  run:guard(async(args,ctx)=>{
   // 先校验参数再碰仓库，保证 AI 看到的是真正的输入错误。
   const limit=optionalInteger(args.limit,'limit',{min:1,max:200,fallback:20});
   const {top}=await repositoryOf(args,ctx);
   const result=await git(top,['log','-n',String(limit),'--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s'],{allowEmpty:true});
   const commits=result.stdout.split(/\r?\n/).filter(Boolean).map(line=>{
    const [hash,shortHash,author,date,subject]=line.split('\t');
    return {hash,shortHash,author,date,subject};
   });
   return {path:top,limit,count:commits.length,emptyRepository:result.emptyRepository===true,commits};
  }),
 },
 {
  name:'git_add',
  description:'Use this to stage exactly the paths you intend to commit, instead of running a shell command. Parameters: path (string, default ".") is the repository directory or any directory inside it, inside an allowed root; files (array of strings, required, at least 1 item) lists repository-relative paths to stage, and "." stages everything under the repository (a leading dash is rejected because it would look like a git option). Returns {path: work tree top level, files: the staged path list as given, staged: repository-relative paths now staged (index changes only), entries: the full status entries after staging}. This tool writes the index, so a read-only sandbox refuses it with "sandbox/denied" before anything is staged. Failures: "args/invalid" (files empty or not strings, a path starting with a dash), "path/outside-roots" (a path escapes the repository, or the repository is outside the roots), "path/not-found", "git/not-a-repo", "git/command-failed" (ignored path, missing file, lock contention), "exec/unavailable", "sandbox/denied", "tool/internal".',
  inputSchema:{type:'object',properties:{
   path:pathProperty('Repository directory, or any directory inside it; must stay inside the allowed roots. Defaults to "." (the first allowed root).'),
   files:{type:'array',items:{type:'string'},minItems:1,description:'Repository-relative paths to stage; each must stay inside the repository and must not start with a dash. Use "." to stage everything under the repository.'},
  },required:['files'],additionalProperties:false},
  run:guard(async(args,ctx)=>{
   requireWritable(ctx,'git_add');
   const {top}=await repositoryOf(args,ctx);
   const files=validateRelativeFiles(top,requireStringArray(args.files,'files'));
   await git(top,['add','--',...files]);
   const status=await git(top,['status','--porcelain=v1','-b','--untracked-files=all']);
   const parsed=parseStatus(status.stdout);
   return {path:top,files,staged:parsed.entries.filter(entry=>entry.code[0]!==' '&&entry.code[0]!=='?').map(entry=>entry.path),entries:parsed.entries};
  }),
 },
 {
  name:'git_commit',
  description:'Use this after git_add to record a commit with a real message and get the new commit hash. Parameters: path (string, default ".") is the repository directory or any directory inside it, inside an allowed root; message (string, required, 1 to 4000 characters) is the commit message; all (boolean, default false) stages modified and deleted tracked files first (git commit --all) so git_add is not needed for those. The repository author identity is not injected, so user.name and user.email must already be configured or git reports a clear failure. Returns {path: work tree top level, commit: full 40 hex sha of the new commit, shortHash, author, date: ISO-8601 author date, subject: first line of the message, output: git stdout summary}. This tool writes commits, so a read-only sandbox refuses it with "sandbox/denied" before anything is committed. Failures: "args/invalid" (message empty or longer than 4000 characters, bad boolean), "path/outside-roots", "path/not-found", "git/not-a-repo", "git/command-failed" (nothing staged, missing identity, hook failure), "exec/unavailable", "sandbox/denied", "tool/internal".',
  inputSchema:{type:'object',properties:{
   path:pathProperty('Repository directory, or any directory inside it; must stay inside the allowed roots. Defaults to "." (the first allowed root).'),
   message:{type:'string',description:'Commit message, 1 to 4000 characters. The first line becomes the subject reported back as subject.'},
   all:{type:'boolean',description:'Stage modified and deleted tracked files before committing (git commit --all) when true. Defaults to false, which commits only what git_add already staged.'},
  },required:['message'],additionalProperties:false},
  run:guard(async(args,ctx)=>{
   requireWritable(ctx,'git_commit');
   // 先校验参数再碰仓库，保证 AI 看到的是真正的输入错误。
   const message=requireString(args.message,'message');
   if(message.length>4000)throw fail(`message is ${message.length} characters, above the 4000 character limit. Shorten it (put long explanations in the repository instead) and retry.`,'args/invalid');
   const all=optionalBoolean(args.all,'all');
   const {top}=await repositoryOf(args,ctx);
   const result=await git(top,['commit','-m',message,...(all?['--all']:[])]);
   const head=await git(top,['rev-parse','HEAD']);
   const summary=await git(top,['show','-s','--pretty=format:%H%x09%h%x09%an%x09%aI%x09%s','HEAD']);
   const [hash,shortHash,author,date,subject]=summary.stdout.split('\t');
   return {path:top,commit:head.stdout.trim(),shortHash,author,date,subject,output:result.stdout.trim()};
  }),
 },
];
