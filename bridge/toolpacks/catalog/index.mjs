// Read-only full documentation for the host's accepted, enabled tool index.
export const meta={
 name:'catalog',title:'Tool help',version:'1.0.0',
 description:'Read the original tool descriptions and argument schemas on demand.',
};

export const tools=[{
 name:'tool_help',
 description:'Read full original description and inputSchema for an enabled tool by name, including safety rules, defaults and results. No tool is executed.',
 inputSchema:{type:'object',properties:{name:{type:'string',minLength:1,maxLength:64,description:'Exact enabled tool name from tools/list.'}},required:['name'],additionalProperties:false},
 run:async(args,ctx)=>{
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='name')){
   throw Object.assign(Error('Supply only the tool name'),{code:'args/invalid'});
  }
  if(typeof args.name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(args.name)){
   throw Object.assign(Error('name must be a valid tool name from tools/list'),{code:'args/invalid'});
  }
  if(typeof ctx?.describeTool!=='function'){
   throw Object.assign(Error('Full tool documentation is unavailable in this host'),{code:'tool/internal'});
  }
  return ctx.describeTool(args.name);
 },
}];
