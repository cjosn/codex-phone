// time: 当前时间、按显式 IANA 时区格式化、以及日历加减。
// 日历运算（月/年）在 UTC 瞬间上执行并做“月末钳制”，所以 2024-01-31 加一个月是
// 2024-02-29；时区只影响展示出来的本地时间文本，不影响计算结果本身。
// 约定：run() 只返回可 JSON 序列化的数据（宿主负责封装），失败一律 throw 带 code 的 Error。
const DAY_MS=86400000;
const MAX_AMOUNT=1e9;                       // 加减量的绝对值上限，防止溢出成无效日期
const UNITS=['seconds','minutes','hours','days','weeks','months','years'];
const FORMATS=['iso','date','time','datetime','locale','unix','unix-ms','custom'];

// 统一错误：英文消息说明“哪一步失败 + 下一步怎么办”，code 供上层分流。
const fail=(message,code)=>Object.assign(Error(message),{code});

// 时区：缺省 UTC；非字符串或 Intl 不认识的区域一律 time/invalid-zone。
function zoneOf(value){
 const zone=(value===undefined||value===null||value==='')?'UTC':value;
 if(typeof zone!=='string'){
  throw fail(`timeZone must be an IANA zone name such as "Asia/Shanghai" or "UTC" but was a ${typeof zone}; pass a zone name string, then retry`,'time/invalid-zone');
 }
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(0);}
 catch{
  throw fail(`Invalid IANA time zone: ${zone}. Pass a zone name such as "Asia/Shanghai", "Europe/Berlin" or "UTC"; numeric offsets like "+08:00" are not accepted`,'time/invalid-zone');
 }
 return zone;
}

function partsOf(date,timeZone){
 const formatter=new Intl.DateTimeFormat('en-US',{
  timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'long',
 });
 const parts={};
 for(const part of formatter.formatToParts(date))if(part.type!=='literal')parts[part.type]=part.value;
 const hour=Number(parts.hour)%24;
 return {
  year:Number(parts.year),
  month:Number(parts.month),
  day:Number(parts.day),
  hour,
  minute:Number(parts.minute),
  second:Number(parts.second),
  weekday:parts.weekday,
 };
}

function offsetMinutes(date,timeZone){
 const parts=partsOf(date,timeZone);
 const asUtc=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second,date.getUTCMilliseconds());
 return Math.round((asUtc-date.getTime())/60000);
}

function offsetText(minutes){
 const sign=minutes<0?'-':'+';
 const absolute=Math.abs(minutes);
 return `${sign}${String(Math.floor(absolute/60)).padStart(2,'0')}:${String(absolute%60).padStart(2,'0')}`;
}

function pad(value,width=2){return String(value).padStart(width,'0');}

function isoWeek(date){
 const target=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));
 const day=(target.getUTCDay()+6)%7;
 target.setUTCDate(target.getUTCDate()-day+3);
 const firstThursday=new Date(Date.UTC(target.getUTCFullYear(),0,4));
 const firstDay=(firstThursday.getUTCDay()+6)%7;
 firstThursday.setUTCDate(firstThursday.getUTCDate()-firstDay+3);
 return 1+Math.round((target-firstThursday)/(7*DAY_MS));
}

function dayOfYear(date){
 const start=Date.UTC(date.getUTCFullYear(),0,1);
 return Math.floor((Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate())-start)/DAY_MS)+1;
}

function dstOf(date,timeZone){
 const year=date.getUTCFullYear();
 const january=offsetMinutes(new Date(Date.UTC(year,0,1)),timeZone);
 const july=offsetMinutes(new Date(Date.UTC(year,6,1)),timeZone);
 if(january===july)return {hasDST:false,isDST:false};
 return {hasDST:true,isDST:offsetMinutes(date,timeZone)>Math.min(january,july)};
}

// 统一的“一个瞬间 + 一个时区”描述对象，三个工具都用它作为返回骨架。
function describe(date,timeZone){
 const parts=partsOf(date,timeZone);
 const offset=offsetMinutes(date,timeZone);
 return {
  iso:date.toISOString(),
  local:`${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} ${offsetText(offset)}`,
  timeZone,
  offsetMinutes:offset,
  offset:offsetText(offset),
  weekday:parts.weekday,
  isoWeek:isoWeek(date),
  dayOfYear:dayOfYear(date),
  unixSeconds:Math.floor(date.getTime()/1000),
  unixMilliseconds:date.getTime(),
  ...dstOf(date,timeZone),
 };
}

// 接受 ISO 字符串、数字纪元（|v| < 1e11 视为秒，否则毫秒）或留空（= 现在）。
function instantOf(input,label='instant'){
 if(input===undefined||input===null||input==='')return new Date();
 if(typeof input==='number'){
  if(!Number.isFinite(input)){
   throw fail(`${label} must be a finite epoch number but was ${String(input)}; pass seconds, milliseconds or an ISO 8601 string, then retry`,'time/invalid-date');
  }
  const date=new Date(Math.abs(input)<1e11?input*1000:input);
  if(Number.isNaN(date.getTime())){
   throw fail(`${label} ${input} is out of the representable date range; pass a smaller epoch value or an ISO 8601 string, then retry`,'time/invalid-date');
  }
  return date;
 }
 if(typeof input==='string'){
  const trimmed=input.trim();
  if(/^-?\d+(\.\d+)?$/.test(trimmed))return instantOf(Number(trimmed),label);
  const parsed=Date.parse(trimmed);
  if(Number.isNaN(parsed)){
   throw fail(`${label} is not a parseable date/time: ${String(input)}. Pass ISO 8601 such as "2024-02-29T12:34:56Z", a date such as "2024-02-29", or an epoch number, then retry`,'time/invalid-date');
  }
  return new Date(parsed);
 }
 throw fail(`${label} must be an ISO 8601 string or an epoch number but was a ${typeof input}; pass a string or number, then retry`,'args/invalid');
}

function formatWithPattern(date,timeZone,pattern){
 const parts=partsOf(date,timeZone);
 const offset=offsetMinutes(date,timeZone);
 const tokens={
  YYYY:String(parts.year),
  YY:String(parts.year).slice(-2),
  MM:pad(parts.month),
  M:String(parts.month),
  DD:pad(parts.day),
  D:String(parts.day),
  HH:pad(parts.hour),
  H:String(parts.hour),
  mm:pad(parts.minute),
  m:String(parts.minute),
  ss:pad(parts.second),
  s:String(parts.second),
  SSS:pad(date.getUTCMilliseconds(),3),
  Z:offsetText(offset),
  z:timeZone,
 };
 return pattern.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s|SSS|Z|z/g,token=>tokens[token]??token);
}

export const meta={
 name:'time',
 title:'Time',
 version:'2.0.0',
 description:'Current time, IANA-zone-aware formatting with custom patterns, and calendar arithmetic across seconds, minutes, hours, days, weeks, months and years.',
};

export const tools=[
 {
  name:'time_get',
  description:[
   'Use this whenever you need the real current time or the wall clock of a specific region before answering; never guess the date, because the host clock is the source of truth.',
   'timeZone (string, optional, default "UTC") is an IANA zone name such as "Asia/Shanghai" or "Europe/Berlin"; numeric offsets such as "+08:00" are rejected with time/invalid-zone.',
   'Returns a full instant description: iso (UTC, millisecond precision), local ("YYYY-MM-DD HH:mm:ss +HH:MM" wall clock in the requested zone), timeZone, offsetMinutes (for example 480 for Asia/Shanghai) and offset ("+08:00"), weekday (English long name), isoWeek (ISO 8601 week 1-53), dayOfYear (1-366), unixSeconds and unixMilliseconds (epoch), plus hasDST and isDST for the zone on that date.',
   'Read-only and argument-only: nothing is written to disk and no network call is made.',
   'Failures: time/invalid-zone (unknown or malformed zone name), args/invalid (timeZone is not a string).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   timeZone:{type:'string',minLength:1,description:'IANA time zone name such as "Asia/Shanghai" or "UTC"; defaults to "UTC". Numeric UTC offsets are not accepted.'},
  },required:[],additionalProperties:false},
  run:async(args={})=>describe(new Date(),zoneOf(args.timeZone)),
 },
 {
  name:'time_format',
  description:[
   'Use this to render one specific instant, or a deadline, in a chosen style and zone; use time_get for "right now" and time_add for arithmetic.',
   'instant (string or number, optional, default now) is the instant to format. A number is an epoch value: below 1e11 in absolute value it is read as seconds, otherwise as milliseconds. A string is ISO 8601 such as "2024-02-29T12:34:56.789Z", a date such as "2024-02-29", or a numeric epoch string.',
   'Warning about zone-less strings: an ISO string without Z or an explicit offset is interpreted in the host process local zone (ECMAScript behaviour), so append Z or an offset when the instant must be deterministic.',
   'timeZone (string, optional, default "UTC") is an IANA zone name and only affects the rendered text and the returned offset fields, never the instant itself.',
   'format (string enum, optional, default "iso"): iso returns UTC ISO 8601 with milliseconds; date returns the full date style; time returns the long time style; datetime returns medium date plus long time; locale returns full date plus long time; unix returns integer epoch seconds; unix-ms returns epoch milliseconds; custom applies pattern.',
   'pattern (string, required when format is "custom") supports the tokens YYYY, YY, MM, M, DD, D, HH (24h), H, mm, m, ss, s, SSS (milliseconds), Z (offset like +08:00) and z (zone name); any other character is copied literally, for example "YYYY-MM-DD HH:mm:ss.SSS Z".',
   'locale (string, optional, default "en-US") is a BCP 47 locale used by the date, time, datetime and locale formats, for example "zh-CN"; it does not change the custom pattern output.',
   'Returns {format, text, pattern, locale, timeZone, iso, local, offsetMinutes, offset, weekday, isoWeek, dayOfYear, unixSeconds, unixMilliseconds, hasDST, isDST}; text is the formatted string and local is the zone wall clock.',
   'Read-only and argument-only: nothing is written to disk.',
   'Failures: args/invalid (unsupported format value, custom without pattern, non-string pattern, malformed locale), time/invalid-zone, time/invalid-date (unparseable or out-of-range instant).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   instant:{type:['string','number'],description:'ISO 8601 string, or an epoch number where |value| < 1e11 means seconds and larger values mean milliseconds; defaults to now.'},
   timeZone:{type:'string',minLength:1,description:'IANA time zone name used for the rendered text; defaults to "UTC".'},
   format:{type:'string',enum:FORMATS,description:'Output style; defaults to "iso". One of iso, date, time, datetime, locale, unix, unix-ms, custom.'},
   pattern:{type:'string',minLength:1,description:'Custom pattern used when format is "custom", for example "YYYY-MM-DD HH:mm:ss Z". Tokens: YYYY YY MM M DD D HH H mm m ss s SSS Z z.'},
   locale:{type:'string',minLength:1,description:'BCP 47 locale for the date, time, datetime and locale formats, for example "en-US" or "zh-CN"; defaults to "en-US".'},
  },required:[],additionalProperties:false},
  run:async args=>{
   const timeZone=zoneOf(args.timeZone);
   const date=instantOf(args.instant);
   const format=(args.format===undefined||args.format===null)?'iso':args.format;
   if(typeof format!=='string'||!FORMATS.includes(format)){
    throw fail(`format must be one of ${FORMATS.join(', ')} but was ${JSON.stringify(format)}; retry with one of those values`,'args/invalid');
   }
   if(args.locale!==undefined&&args.locale!==null&&typeof args.locale!=='string'){
    throw fail(`locale must be a BCP 47 locale string such as "en-US" but was a ${typeof args.locale}; pass a string or omit it, then retry`,'args/invalid');
   }
   const locale=typeof args.locale==='string'&&args.locale.trim()?args.locale:'en-US';
   let text;
   if(format==='iso')text=date.toISOString();
   else if(format==='unix')text=String(Math.floor(date.getTime()/1000));
   else if(format==='unix-ms')text=String(date.getTime());
   else if(format==='custom'){
    if(typeof args.pattern!=='string'||!args.pattern){
     throw fail('pattern is required when format is "custom"; pass a token pattern such as "YYYY-MM-DD", then retry','args/invalid');
    }
    text=formatWithPattern(date,timeZone,args.pattern);
   }else{
    const options={timeZone,locale};
    if(format==='date')Object.assign(options,{dateStyle:'full'});
    else if(format==='time')Object.assign(options,{timeStyle:'long'});
    else if(format==='datetime')Object.assign(options,{dateStyle:'medium',timeStyle:'long'});
    else Object.assign(options,{dateStyle:'full',timeStyle:'long'});
    try{text=new Intl.DateTimeFormat(locale,options).format(date);}
    catch(error){
     throw fail(`Could not format with locale ${locale} (${error.message}); pass a BCP 47 locale such as "en-US" or omit locale, then retry`,'args/invalid');
    }
   }
   return {format,text,pattern:args.pattern??null,locale,timeZone,...describe(date,timeZone)};
  },
 },
 {
  name:'time_add',
  description:[
   'Use this for deadlines and date math such as "three weeks from Friday" or "two months before the invoice date"; it never changes the stored clock, it only computes.',
   'instant (string or number, optional, default now) is the starting instant; a number below 1e11 in absolute value is epoch seconds, larger values are epoch milliseconds, and a string is ISO 8601 (append Z or an offset to avoid host-local interpretation).',
   'amount (integer, required) is the signed amount to add; a negative value subtracts. The absolute value must be at most 1000000000.',
   'unit (string enum, required) is one of seconds, minutes, hours, days, weeks, months, years. seconds to weeks are exact durations of fixed milliseconds; months and years are calendar units.',
   'Month and year clamping rule: calendar math runs on the UTC instant, and when the target month is shorter the day is clamped to the last day of that month, so 2024-01-31 plus 1 month is 2024-02-29 and 2024-02-29 plus 1 year is 2025-02-28. Time of day, minutes, seconds and milliseconds are preserved.',
   'timeZone (string, optional, default "UTC") only affects the displayed local time and offset fields; it does not shift the arithmetic, and daylight-saving transitions therefore do not move the result.',
   'Returns {input:{iso,unixMilliseconds}, amount, unit, arithmetic, result}, where result is a full instant description with iso, local, offsetMinutes, offset, weekday, isoWeek, dayOfYear, unixSeconds, unixMilliseconds, hasDST and isDST, and arithmetic is the constant string "UTC calendar arithmetic with day clamping".',
   'Read-only and argument-only: nothing is written to disk.',
   'Failures: args/invalid (amount not an integer or out of range, unsupported unit), time/invalid-date (unparseable or out-of-range instant, or a result outside the representable range), time/invalid-zone (unknown zone name).',
  ].join(' '),
  inputSchema:{type:'object',properties:{
   instant:{type:['string','number'],description:'Starting instant as an ISO 8601 string or epoch number (|value| < 1e11 means seconds, larger values mean milliseconds); defaults to now.'},
   amount:{type:'integer',minimum:-MAX_AMOUNT,maximum:MAX_AMOUNT,description:'Signed amount to add; negative subtracts. Required, and the absolute value must be at most 1000000000.'},
   unit:{type:'string',enum:UNITS,description:'Unit of the amount: seconds, minutes, hours, days, weeks, months or years. Months and years are calendar units and clamp the day to the end of the target month.'},
   timeZone:{type:'string',minLength:1,description:'IANA time zone name used only for the displayed local time and offset; defaults to "UTC".'},
  },required:['amount','unit'],additionalProperties:false},
  run:async args=>{
   const timeZone=zoneOf(args.timeZone);
   const amount=args.amount;
   if(!Number.isSafeInteger(amount)||Math.abs(amount)>MAX_AMOUNT){
    throw fail(`amount must be an integer with an absolute value of at most ${MAX_AMOUNT} but was ${JSON.stringify(amount)}; retry with a smaller integer, and use unit "years" for long spans`,'args/invalid');
   }
   const unit=args.unit;
   if(typeof unit!=='string'||!UNITS.includes(unit)){
    throw fail(`unit must be one of ${UNITS.join(', ')} but was ${JSON.stringify(unit)}; retry with one of those units`,'args/invalid');
   }
   const start=instantOf(args.instant);
   let result;
   if(unit==='months'||unit==='years'){
    const months=unit==='months'?amount:amount*12;
    const year=start.getUTCFullYear();
    const monthIndex=start.getUTCMonth()+months;
    const targetYear=year+Math.floor(monthIndex/12);
    const targetMonth=((monthIndex%12)+12)%12;
    const lastDay=new Date(Date.UTC(targetYear,targetMonth+1,0)).getUTCDate();
    const day=Math.min(start.getUTCDate(),lastDay);
    result=new Date(Date.UTC(targetYear,targetMonth,day,start.getUTCHours(),start.getUTCMinutes(),start.getUTCSeconds(),start.getUTCMilliseconds()));
   }else{
    const multipliers={seconds:1000,minutes:60000,hours:3600000,days:DAY_MS,weeks:7*DAY_MS};
    result=new Date(start.getTime()+amount*multipliers[unit]);
   }
   if(!Number.isFinite(result.getTime())){
    throw fail(`Adding ${amount} ${unit} to ${start.toISOString()} produced an instant outside the representable range; use a smaller amount or a closer instant, then retry`,'time/invalid-date');
   }
   return {
    input:{iso:start.toISOString(),unixMilliseconds:start.getTime()},
    amount,
    unit,
    arithmetic:'UTC calendar arithmetic with day clamping',
    result:describe(result,timeZone),
   };
  },
 },
];
