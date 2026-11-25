// text: encoding conversion, line diff, sorting, de-duplication, word counts and
// replacements over inline text or a file inside the allowed roots.
// 输入文本（内联或文件）上限 2 MiB，避免一次调用耗尽 MCP 宿主；base64/hex/ascii 会先
// 校验再解码，因为 Buffer 会静默跳过坏字符，那等于悄悄改数据。
import {readFile,stat,writeFile} from 'node:fs/promises';
import {
 assertExistingInside,optionalBoolean,optionalInteger,optionalString,requireString,resolvePath,
} from '../_shared.mjs';

const MAX_TEXT_BYTES=2*1024*1024;
const MAX_DIFF_LINES=1500;
const MAX_RETURN_CHARS=200000;
const ENCODINGS=new Map([
 ['utf8','utf8'],['utf-8','utf8'],['base64','base64'],['hex','hex'],['latin1','latin1'],
 ['binary','latin1'],['utf16le','utf16le'],['utf-16le','utf16le'],['ascii','ascii'],
]);
const STOPWORDS=new Set(('the a an and or but if then than that this these those of in on at to for from with without into over under again further once here there all any both each few more most other some such no nor not only own same so too very can will just should now is are was were be been being have has had do does did it its as by we you they he she i me my our your their').split(' '));

// ---------------------------------------------------------------------------
// 统一失败约定：run() 只返回可 JSON 序列化的数据（宿主会包成 {ok:true,data:V}），
// 失败一律 throw Error + code。_shared.mjs 抛的是旧的 toolpack/* 码，这里映射成本组
// 的统一码，消息原样保留。
// ---------------------------------------------------------------------------
const fail=(message,code)=>Object.assign(Error(message),{code});

const SHARED_ERROR_CODES={
 'toolpack/outside-roots':'path/outside-roots',
 'toolpack/timeout':'exec/unavailable',
 'toolpack/command-failed':'exec/unavailable',
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
 if(parentMissing)return fail(`Parent directory does not exist: ${parentMissing[1]}. Create the parent first, then retry.`,'path/not-found');
 if(/^Not a directory: /.test(message))return fail(`${message}. This tool needs a directory inside an allowed root; pass a directory path instead.`,'path/not-a-file');
 if(/^Not a regular file: /.test(message))return fail(`${message}. This tool needs a regular file; directories and devices are rejected.`,'path/not-a-file');
 if(/outside the allowed roots/i.test(message))return fail(message,'path/outside-roots');
 if(/must be an integer between|must be a nonempty string|must be a boolean|must be a nonempty string array|must be one of/i.test(message))return fail(`${message}. Read the tool inputSchema for the accepted type, range and enum values, then retry.`,'args/invalid');
 if(/does not exist/i.test(message))return fail(message,'path/not-found');
 if(/ENOENT|not found on PATH/i.test(`${error?.code??''} ${message}`))return fail(`${message}. The external command is missing or not on PATH, so nothing was run; install it or use another tool.`,'exec/unavailable');
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
// sandbox.type）或环境变量里声明只读；任一命中即拒绝写盘。
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
 throw fail(`${tool} writes its result to disk, but this session runs in a read-only sandbox, so the call was refused before any file was touched. Drop outputPath to get the text in the response instead, or ask the user to switch the sandbox to workspace-write or danger-full-access and retry.`,'sandbox/denied');
}

// ---------------------------------------------------------------------------
function encodingOf(value,label,fallback){
 const raw=optionalString(value,label)??fallback;
 const resolved=ENCODINGS.get(String(raw).toLowerCase());
 if(!resolved)throw fail(`${label} must be one of ${[...new Set(ENCODINGS.keys())].join(', ')} (got ${JSON.stringify(raw)}). Pick the encoding that matches the data and retry.`,'args/invalid');
 return resolved;
}

// 解码前校验：Buffer.from 对 base64/hex 会静默跳过坏字符、对 ascii 会静默丢高位，
// 所以这里先拒掉不合法的输入，而不是返回被改过的数据。
function assertDecodable(source,from,where){
 if(from==='base64'){
  const compact=source.replace(/\s+/g,'');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)||compact.length%4===1){
   throw fail(`Input is not valid base64 (${where}), so it was not decoded. Remove the characters outside A-Z a-z 0-9 + / = or pass the right from value, then retry.`,'file/encoding');
  }
  return;
 }
 if(from==='hex'){
  const compact=source.replace(/\s+/g,'');
  if(!/^[0-9a-fA-F]*$/.test(compact)||compact.length%2!==0){
   throw fail(`Input is not valid hex (${where}): it must contain only 0-9 a-f A-F and an even number of digits, so it was not decoded. Fix the payload or pass the right from value, then retry.`,'file/encoding');
  }
  return;
 }
 if(from==='ascii'&&/[^\x00-\x7F]/.test(source)){
  throw fail(`Input contains characters outside 7-bit ASCII (${where}), so it cannot be treated as ascii without corrupting the data. Use from "utf8" or "latin1" instead, then retry.`,'file/encoding');
 }
}

// 编码后校验：目标编码装不下这份数据时直接报错，而不是静默丢字符。
function assertEncodable(buffer,to,where){
 if(to==='ascii'&&buffer.some(byte=>byte>0x7f)){
  const offset=buffer.findIndex(byte=>byte>0x7f);
  throw fail(`Input has a byte outside 7-bit ASCII (offset ${offset}, ${where}), so it cannot be re-encoded as ascii without corrupting the data. Use to "utf8", "base64" or "hex" instead, then retry.`,'file/encoding');
 }
}

// 读取文本工具的真实输入：内联 text 按 from 编码，或允许根之下的 path。
async function sourceBuffer(args,ctx,{from='utf8',label='Provide either text (inline string) or path (a file inside an allowed root)'}={}){
 if(typeof args.text==='string'){
  const bytes=Buffer.byteLength(args.text,'utf8');
  if(bytes>MAX_TEXT_BYTES)throw fail(`Inline text is ${bytes} bytes, above the ${MAX_TEXT_BYTES} byte limit. Write it to a file inside an allowed root and pass path instead, or split the work.`,'file/too-large');
  assertDecodable(args.text,from,'inline text');
  return {buffer:Buffer.from(args.text,from),source:'text',path:null};
 }
 if(typeof args.path==='string'&&args.path.trim()){
  const target=await resolvePath(ctx.roots,args.path);
  const info=await stat(target);
  if(!info.isFile())throw fail(`Not a regular file: ${target}. Read-only text tools need a regular file; use file_info to inspect directories.`,'path/not-a-file');
  if(info.size>MAX_TEXT_BYTES)throw fail(`File is ${info.size} bytes, above the ${MAX_TEXT_BYTES} byte text limit: ${target}. Process the file in smaller pieces and retry.`,'file/too-large');
  return {buffer:await readFile(target),source:'file',path:target};
 }
 throw fail(`${label}, then retry.`, 'args/invalid');
}

async function sourceText(args,ctx,options={}){
 const {buffer,source,path}=await sourceBuffer(args,ctx,options);
 return {text:buffer.toString(options.from??'utf8'),source,path,bytes:buffer.length};
}

function splitLines(text){
 const normalized=text.replace(/\r\n/g,'\n');
 const trailing=normalized.endsWith('\n');
 const lines=normalized.split('\n');
 if(trailing)lines.pop();
 return {lines,trailing};
}

// ---------------------------------------------------------------------------
async function textConvert(args,ctx){
 const from=encodingOf(args.from,'from','utf8');
 const to=encodingOf(args.to,'to','utf8');
 const {buffer,source,path}=await sourceBuffer(args,ctx,{from});
 assertEncodable(buffer,to,source==='file'?path:'inline text');
 const output=buffer.toString(to);
 let outputPath=null;
 if(args.outputPath!==undefined){
  requireWritable(ctx,'text_convert');
  const target=await resolvePath(ctx.roots,args.outputPath,{parent:true,label:'outputPath'});
  await assertExistingInside(ctx.roots,target);
  // 转成 base64/hex 时，转换后的字符串本身就是载荷，写它的 ASCII 字节；
  // utf8/latin1/utf16le 则按目标编码写字符串。
  const bytes=to==='base64'||to==='hex'?Buffer.from(output,'utf8'):Buffer.from(output,to);
  await writeFile(target,bytes);
  outputPath=target;
 }
 return {from,to,source,inputBytes:buffer.length,outputLength:output.length,outputBytes:Buffer.byteLength(output),text:output,path,outputPath};
}

function diffOperations(a,b){
 // 经典 LCS 动态规划。矩阵分配前已把输入裁到 MAX_DIFF_LINES 行以内，
 // 最坏情况约 1500x1500 个单元格。
 const n=a.length,m=b.length;
 const width=m+1;
 const table=new Int32Array((n+1)*width);
 for(let i=n-1;i>=0;i--){
  for(let j=m-1;j>=0;j--){
   table[i*width+j]=a[i]===b[j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  }
 }
 const ops=[];
 let i=0,j=0;
 while(i<n&&j<m){
  if(a[i]===b[j]){ops.push({type:' ',text:a[i]});i++;j++;continue;}
  if(table[(i+1)*width+j]>=table[i*width+j+1]){ops.push({type:'-',text:a[i]});i++;}
  else{ops.push({type:'+',text:b[j]});j++;}
 }
 while(i<n){ops.push({type:'-',text:a[i]});i++;}
 while(j<m){ops.push({type:'+',text:b[j]});j++;}
 return ops;
}

function unifiedDiff(ops,context,leftLabel,rightLabel){
 const oldNo=[],newNo=[];
 let oldLine=1,newLine=1;
 for(const op of ops){
  oldNo.push(oldLine);newNo.push(newLine);
  if(op.type!=='+')oldLine++;
  if(op.type!=='-')newLine++;
 }
 const hunks=[];
 let index=0;
 while(index<ops.length){
  if(ops[index].type===' '){index++;continue;}
  let start=Math.max(0,index-context);
  let end=index;
  while(end<ops.length){
   if(ops[end].type!==' '){end++;continue;}
   let run=end;
   while(run<ops.length&&ops[run].type===' ')run++;
   if(run>=ops.length||run-end>2*context)break;
   end=run;
  }
  const stop=Math.min(ops.length,end+context);
  hunks.push([start,stop]);
  index=stop;
 }
 if(!hunks.length)return {unified:'',hunks:[]};
 const out=[`--- ${leftLabel}`,`+++ ${rightLabel}`];
 for(const [start,stop] of hunks){
  const slice=ops.slice(start,stop);
  const oldCount=slice.filter(op=>op.type!=='+').length;
  const newCount=slice.filter(op=>op.type!=='-').length;
  const oldStart=slice.length?oldNo[start]:0;
  const newStart=slice.length?newNo[start]:0;
  out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  for(const op of slice)out.push(op.type+op.text);
 }
 return {unified:out.join('\n'),hunks:hunks.map(([start,stop])=>({oldStart:oldNo[start]??null,newStart:newNo[start]??null,lines:stop-start}))};
}

async function textDiff(args,ctx){
 const contextLines=optionalInteger(args.context,'context',{min:0,max:20,fallback:3});
 const left=await sourceText({text:args.a,path:args.pathA},ctx,{label:'Provide a (inline text) or pathA (a file inside an allowed root) for the left side'});
 const right=await sourceText({text:args.b,path:args.pathB},ctx,{label:'Provide b (inline text) or pathB (a file inside an allowed root) for the right side'});
 const leftSplit=splitLines(left.text),rightSplit=splitLines(right.text);
 const truncated=leftSplit.lines.length>MAX_DIFF_LINES||rightSplit.lines.length>MAX_DIFF_LINES;
 const a=leftSplit.lines.slice(0,MAX_DIFF_LINES),b=rightSplit.lines.slice(0,MAX_DIFF_LINES);
 const ops=diffOperations(a,b);
 const added=ops.filter(op=>op.type==='+').length;
 const removed=ops.filter(op=>op.type==='-').length;
 const unchanged=ops.filter(op=>op.type===' ').length;
 const leftLabel=optionalString(args.leftLabel,'leftLabel')??(left.path?left.path.split(/[\\/]/).pop():'left');
 const rightLabel=optionalString(args.rightLabel,'rightLabel')??(right.path?right.path.split(/[\\/]/).pop():'right');
 const {unified,hunks}=unifiedDiff(ops,contextLines,leftLabel,rightLabel);
 return {
  identical:added===0&&removed===0,
  left:{source:left.source,path:left.path,lines:leftSplit.lines.length,trailingNewline:leftSplit.trailing},
  right:{source:right.source,path:right.path,lines:rightSplit.lines.length,trailingNewline:rightSplit.trailing},
  added,removed,unchanged,
  comparedLines:{left:a.length,right:b.length},
  truncated,
  context:contextLines,
  hunks,
  unified,
 };
}

function sortOptions(args){
 const order=optionalString(args.order,'order')??'asc';
 if(!['asc','desc'].includes(order))throw fail(`order must be "asc" or "desc" (got ${JSON.stringify(order)}). Use "asc" for A to Z, "desc" for the reverse, then retry.`,'args/invalid');
 return {
  order,
  caseSensitive:optionalBoolean(args.caseSensitive,'caseSensitive'),
  numeric:optionalBoolean(args.numeric,'numeric'),
  unique:optionalBoolean(args.unique,'unique'),
 };
}

async function textSort(args,ctx){
 const options=sortOptions(args);
 const {text,source,path}=await sourceText(args,ctx);
 const {lines,trailing}=splitLines(text);
 let entries=lines;
 if(options.unique)entries=[...new Set(entries)];
 const collator=new Intl.Collator(undefined,{sensitivity:options.caseSensitive?'variant':'base',numeric:options.numeric});
 entries.sort((left,right)=>{
  const result=collator.compare(left,right);
  return options.order==='desc'?-result:result;
 });
 const output=entries.join('\n')+(trailing&&entries.length?'\n':'');
 return {
  source,path,
  order:options.order,
  caseSensitive:options.caseSensitive,
  numeric:options.numeric,
  uniqueApplied:options.unique,
  inputLines:lines.length,
  outputLines:entries.length,
  text:output,
 };
}

async function textUnique(args,ctx){
 const caseSensitive=optionalBoolean(args.caseSensitive,'caseSensitive');
 const withCounts=args.count!==false;
 const {text,source,path}=await sourceText(args,ctx);
 const {lines,trailing}=splitLines(text);
 const counts=new Map();
 for(const line of lines){
  const key=caseSensitive?line:line.toLowerCase();
  const existing=counts.get(key);
  if(existing)existing.count++;
  else counts.set(key,{line,count:1});
 }
 let entries=[...counts.values()];
 if(args.sortByCount===true)entries.sort((left,right)=>right.count-left.count||left.line.localeCompare(right.line));
 else entries.sort((left,right)=>left.line.localeCompare(right.line));
 const duplicates=entries.filter(entry=>entry.count>1);
 const output=entries.map(entry=>entry.line).join('\n')+(trailing&&entries.length?'\n':'');
 return {
  source,path,
  caseSensitive,
  withCounts,
  totalLines:lines.length,
  uniqueLines:entries.length,
  removedDuplicates:lines.length-entries.length,
  duplicateGroups:duplicates.length,
  entries,
  text:output,
 };
}

async function textWordCount(args,ctx){
 const {text,source,path}=await sourceText(args,ctx);
 const words=text.match(/\p{L}[\p{L}\p{N}'’-]*/gu)??[];
 const characters=[...text].length;
 const sentences=(text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g)??[]).filter(sentence=>sentence.trim()).length;
 const paragraphs=text.split(/\n\s*\n/).filter(block=>block.trim()).length;
 const lines=text.length?text.split(/\r?\n/).length:0;
 const frequencies=new Map();
 for(const word of words){
  const key=word.toLowerCase();
  if(key.length<2||STOPWORDS.has(key))continue;
  frequencies.set(key,(frequencies.get(key)??0)+1);
 }
 const topWords=[...frequencies.entries()]
  .sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]))
  .slice(0,25)
  .map(([word,count])=>({word,count}));
 return {
  source,path,
  characters,
  charactersNoSpaces:characters-(text.match(/\s/g)??[]).length,
  bytes:Buffer.byteLength(text),
  words:words.length,
  lines,
  paragraphs,
  sentences,
  uniqueWords:frequencies.size,
  readingMinutes:Number((words.length/200).toFixed(1)),
  topWords,
 };
}

async function textReplace(args,ctx){
 const pattern=requireString(args.pattern,'pattern');
 if(typeof args.replacement!=='string')throw fail('replacement must be a string: pass the exact replacement text (use "" to delete the matches), then retry.','args/invalid');
 const regex=optionalBoolean(args.regex,'regex');
 const all=args.all!==false;
 const caseSensitive=optionalBoolean(args.caseSensitive,'caseSensitive');
 const {text,source,path}=await sourceText(args,ctx);
 let output,matches;
 if(regex){
  let expression;
  try{expression=new RegExp(pattern,all?'g'+(caseSensitive?'':'i'):(caseSensitive?'':'i'));}
  catch(error){throw fail(`pattern is not a valid regular expression: ${error.message}. Escape the special characters or pass regex:false to match the text literally, then retry.`,'args/invalid');}
  matches=[...text.matchAll(new RegExp(pattern,'g'+(caseSensitive?'':'i')))].length;
  output=text.replace(expression,args.replacement);
 }else{
  if(!pattern)throw fail('pattern must not be empty: pass the literal text to find, then retry.','args/invalid');
  // Literal mode: escape the pattern, then insert the replacement verbatim (a
  // function replacement also disables `$&`/`$1` expansion).
  const escaped=pattern.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const expression=new RegExp(escaped,all?'g'+(caseSensitive?'':'i'):(caseSensitive?'':'i'));
  matches=[...text.matchAll(new RegExp(escaped,'g'+(caseSensitive?'':'i')))].length;
  output=text.replace(expression,()=>args.replacement);
 }
 let outputPath=null;
 if(args.outputPath!==undefined){
  requireWritable(ctx,'text_replace');
  const target=await resolvePath(ctx.roots,args.outputPath,{parent:true,label:'outputPath'});
  await assertExistingInside(ctx.roots,target);
  if(Buffer.byteLength(output)>MAX_TEXT_BYTES)throw fail(`Replaced text is ${Buffer.byteLength(output)} bytes, above the ${MAX_TEXT_BYTES} byte write limit. Narrow the input or replace in smaller pieces, then retry.`,'file/too-large');
  await writeFile(target,output,'utf8');
  outputPath=target;
 }
 return {
  source,path,
  regex,
  all,
  caseSensitive,
  replacements:matches,
  changed:matches>0,
  outputLength:output.length,
  truncated:output.length>MAX_RETURN_CHARS,
  text:output.length>MAX_RETURN_CHARS?output.slice(0,MAX_RETURN_CHARS):output,
  outputPath,
 };
}

const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const textSource=(description)=>({
 text:{type:'string',description},
 path:{type:'string',description:'Alternatively read the text from this file inside an allowed root; must stay inside the allowed roots and is capped at 2097152 bytes.'},
});

const ENCODING_DESCRIPTION='One of "utf8" (default), "base64", "hex", "latin1" (alias "binary", one byte per character), "utf16le" (alias "utf-16le") or "ascii" (7-bit only).';

export const meta={
 name:'text',
 title:'Text',
 version:'2.0.0',
 description:'Convert encodings, diff, sort, de-duplicate, count and replace text from an argument or a file inside the allowed roots. Failures carry a code such as args/invalid, path/outside-roots, path/not-found, path/not-a-file, file/too-large, file/encoding or sandbox/denied.',
};

export const tools=[
 {
  name:'text_convert',
  description:'Use this to move text between encodings, for example to base64-encode a payload, decode a hex dump or read a UTF-16 file as UTF-8, without leaving the tool layer. Parameters: text (string) is the inline payload already encoded as from; path (string) alternatively reads a file inside an allowed root (2 MiB cap); from is the input encoding, one of utf8 (default) base64 hex latin1 binary utf16le ascii; to is the output encoding from the same enum, default utf8; outputPath (string, optional) writes the converted bytes to a file inside an allowed root whose parent exists. Returns {from, to, source: "text"|"file", inputBytes, outputLength: characters, outputBytes, text: the converted string, path: source file or null, outputPath: written file or null}. Invalid base64, odd-length hex, or data that ascii cannot represent fails with "file/encoding" instead of silently dropping characters. Other failures: "args/invalid" (unknown encoding, neither text nor path), "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large" (input above 2097152 bytes), "sandbox/denied" when outputPath is used in a read-only session.',
  inputSchema:object({
   ...textSource('Text already encoded as the from value.'),
   from:{type:'string',enum:['utf8','base64','hex','latin1','binary','utf16le','ascii'],description:`Input encoding. ${ENCODING_DESCRIPTION} Defaults to "utf8".`},
   to:{type:'string',enum:['utf8','base64','hex','latin1','binary','utf16le','ascii'],description:`Output encoding. ${ENCODING_DESCRIPTION} Defaults to "utf8".`},
   outputPath:{type:'string',description:'Optional file inside an allowed root that receives the converted bytes; its parent directory must exist.'},
  }),
  run:guard(textConvert),
 },
 {
  name:'text_diff',
  description:'Use this to compare two texts or files line by line before editing, reviewing or merging, and to get a unified diff plus counts. Parameters: a (string) is the left inline text or pathA (string) the left file inside an allowed root; b (string) is the right inline text or pathB (string) the right file; context (integer, 0 to 20, default 3) is how many unchanged lines surround each hunk; leftLabel and rightLabel (strings) override the names in the ---/+++ header. Returns {identical: boolean, left: {source, path, lines, trailingNewline}, right: same shape, added: number, removed: number, unchanged: number, comparedLines: {left, right}, truncated: boolean (true when a side exceeded 1500 lines and was capped), context, hunks: [{oldStart, newStart, lines}], unified: unified diff text or "" when identical}. Comparisons are exact per line and ignore no whitespace. Failures: "args/invalid" (missing a/b source or context out of range), "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large" (either input above 2097152 bytes).',
  inputSchema:object({
   a:{type:'string',description:'Left side as inline text. Provide a or pathA, not both preference-wise; when a is a string it wins.'},
   pathA:{type:'string',description:'Left side read from this file inside an allowed root; used when a is not a string.'},
   b:{type:'string',description:'Right side as inline text.'},
   pathB:{type:'string',description:'Right side read from this file inside an allowed root; used when b is not a string.'},
   context:{type:'integer',minimum:0,maximum:20,description:'Unchanged lines shown around each hunk, 0 to 20. Defaults to 3 like diff -u.'},
   leftLabel:{type:'string',description:'Label for the left side in the unified header. Defaults to the left file name or "left".'},
   rightLabel:{type:'string',description:'Label for the right side in the unified header. Defaults to the right file name or "right".'},
  }),
  run:guard(textDiff),
 },
 {
  name:'text_sort',
  description:'Use this to order the lines of a text or file with locale-aware comparison, for example to normalise a list before comparing or writing it back. Parameters: text (string) or path (string, file inside an allowed root); order is "asc" (default, A to Z) or "desc" (Z to A); caseSensitive (boolean, default false) keeps lower and upper case apart; numeric (boolean, default false) compares embedded numbers as numbers so 10 sorts after 2; unique (boolean, default false) removes duplicate lines before sorting. Returns {source, path, order, caseSensitive, numeric, uniqueApplied, inputLines, outputLines, text: the sorted lines joined by \\n, keeping one trailing newline when the input had one}. Failures: "args/invalid" (order outside the enum, bad boolean), "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large".',
  inputSchema:object({
   ...textSource('Text whose lines are sorted.'),
   order:{type:'string',enum:['asc','desc'],description:'Sort direction. "asc" (default) is ascending A to Z, "desc" is descending Z to A.'},
   caseSensitive:{type:'boolean',description:'Compare case-sensitively (a before B) when true. Defaults to false, which compares case-insensitively.'},
   numeric:{type:'boolean',description:'Compare embedded numbers by value (2 before 10) when true. Defaults to false, which compares character by character.'},
   unique:{type:'boolean',description:'Drop duplicate lines before sorting when true. Defaults to false, which keeps every line.'},
  }),
  run:guard(textSort),
 },
 {
  name:'text_unique',
  description:'Use this to collapse duplicate lines and learn how often each line occurred, for example to deduplicate a log or a list of ids. Parameters: text (string) or path (string, file inside an allowed root); caseSensitive (boolean, default false) treats "A" and "a" as different lines when true; count (boolean, default true) returns per-line occurrence entries, set false for the de-duplicated text only; sortByCount (boolean, default false) orders entries by descending count instead of alphabetically. Returns {source, path, caseSensitive, withCounts, totalLines, uniqueLines, removedDuplicates, duplicateGroups, entries: [{line, count}] sorted as requested, text: the de-duplicated lines joined by \\n}. Failures: "args/invalid", "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large".',
  inputSchema:object({
   ...textSource('Text whose lines are de-duplicated.'),
   caseSensitive:{type:'boolean',description:'Treat different letter case as different lines when true. Defaults to false, which folds case before comparing.'},
   count:{type:'boolean',description:'Return per-line occurrence entries when true. Defaults to true; false returns only the de-duplicated text.'},
   sortByCount:{type:'boolean',description:'Order entries by descending count, then alphabetically, when true. Defaults to false, which orders alphabetically.'},
  }),
  run:guard(textUnique),
 },
 {
  name:'text_word_count',
  description:'Use this to measure a text or file before summarising or to check a length budget: it returns characters, words, lines, paragraphs, sentences, byte size, estimated reading time and the most frequent terms. Parameters: text (string) or path (string, file inside an allowed root). Returns {source, path, characters, charactersNoSpaces, bytes: UTF-8 byte size, words, lines, paragraphs, sentences, uniqueWords: number of distinct non-stopword terms, readingMinutes: words divided by 200 rounded to one decimal, topWords: up to 25 {word, count} entries sorted by count then alphabetically}. Words are Unicode letters, sentences end at an ASCII or fullwidth period, exclamation or question mark, and paragraphs are separated by blank lines. Failures: "args/invalid", "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large".',
  inputSchema:object(textSource('Text to measure.')),
  run:guard(textWordCount),
 },
 {
  name:'text_replace',
  description:'Use this to rewrite occurrences of a literal string or a regular expression inside a text or file, optionally writing the result to a file, for example to rename identifiers in a template. Parameters: text (string) or path (string, file inside an allowed root); pattern (string, required) is the literal text, or a JavaScript regular expression source when regex is true; replacement (string, required) is the replacement text and supports $1 style groups in regex mode; regex (boolean, default false) switches pattern to regular-expression mode; all (boolean, default true) replaces every match, false replaces only the first; caseSensitive (boolean, default false) makes matching case-sensitive; outputPath (string, optional) writes the result to a file inside an allowed root whose parent exists. Returns {source, path, regex, all, caseSensitive, replacements: number of matches found, changed: boolean, outputLength, truncated: boolean (true when the returned text is capped at 200000 characters), text: the replaced text, outputPath: written file or null}. Literal mode never interprets $ or backslashes. Failures: "args/invalid" (invalid regular expression, empty pattern, replacement not a string), "path/outside-roots", "path/not-found", "path/not-a-file", "file/too-large" (input above 2097152 bytes or result above 2097152 bytes when written), "sandbox/denied" when outputPath is used in a read-only session.',
  inputSchema:object({
   ...textSource('Text to search.'),
   pattern:{type:'string',description:'Literal text to find, or a JavaScript regular expression source when regex is true. Must not be empty.'},
   replacement:{type:'string',description:'Replacement text, inserted verbatim in literal mode; $1, $& and similar group references work only in regex mode.'},
   regex:{type:'boolean',description:'Treat pattern as a JavaScript regular expression when true. Defaults to false, which matches the pattern literally.'},
   all:{type:'boolean',description:'Replace every occurrence when true. Defaults to true; false replaces only the first match.'},
   caseSensitive:{type:'boolean',description:'Match case-sensitively when true. Defaults to false, which ignores case.'},
   outputPath:{type:'string',description:'Optional file inside an allowed root that receives the replaced text; its parent directory must exist.'},
  },['pattern','replacement']),
  run:guard(textReplace),
 },
];
