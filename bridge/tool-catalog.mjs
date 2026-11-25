// Compact discovery metadata for builtin tools only. Execution records stay intact.
// Keep inputSchema verbatim, including its descriptions: they carry argument rules.
// These are reviewed summaries, not character slices. Full docs live on each pack.
const SUMMARIES=Object.freeze({
 pkg_list:'List toolpacks and their enabled state through the running bridge.',
 pkg_set_enabled:'Enable or disable a toolpack through the bridge; disabled tools are hidden.',
 pkg_install:'Copy a user toolpack directory into the bridge home; cannot replace builtins.',
 context_get:'Read context compaction settings and current token usage from the bridge.',
 context_set:'Update supplied context compaction settings; omitted fields stay unchanged.',
 model_list:'List available models from the bridge before selecting a model id.',
 model_set:'Change supplied model/provider settings for new turns; active turns prevent changes.',
 persona_get:'Read the saved system persona before editing it.',
 persona_set:'Save supplied persona sections; empty strings clear them, active:false removes its managed block.',
 ping:'Check bridge health and handshake; restart the bridge if unreachable.',
 device_capabilities:'Check live phone permissions before Android actions and after permission errors; requires device channel.',
 device_info:'Read live phone hardware, battery, network and storage facts; needs the standard device tier.',
 code_run_python:'Execute a Python snippet; nonzero exit and timeout are returned as results. Refused in read-only.',
 code_run_python_file:'Execute a Python file inside allowed roots, with captured output. Refused in read-only.',
 code_run_node:'Execute a JavaScript ES module snippet with captured output. Refused in read-only.',
 code_run_node_file:'Execute a JavaScript file inside allowed roots, with captured output. Refused in read-only.',
 code_run_shell:'Execute real bash/sh commands with cwd inside allowed roots. Refused in read-only.',
 code_toolchains:'Probe installed interpreters before running code; only version probes run, including in read-only.',
 file_read:'Read a UTF-8 file inside allowed roots; files over 2 MiB are refused.',
 file_write:'Create or fully replace UTF-8 content inside allowed roots; parent must exist. Refused in read-only.',
 file_list:'List one directory level inside allowed roots, sorted by name.',
 file_search:'Search names/content recursively inside allowed roots; symlinks, binaries and heavy directories are skipped.',
 time_now:'Read the real current clock in an IANA zone; default UTC.',
 calendar:'Build a Gregorian month grid with Sunday-first weeks; defaults to the current UTC month.',
 sqlite_query:'Run one read-only SELECT/PRAGMA/WITH query inside allowed roots; write keywords are refused.',
 sqlite_tables:'List SQLite tables/views and row counts inside allowed roots; database is opened read-only.',
 json_query:'Read a JSON file fragment by RFC 6901 Pointer inside allowed roots; absent pointer returns found:false.',
 json_format:'Validate/format inline JSON or a file inside allowed roots; supply exactly one source.',
 env_probe:'Probe real terminal tool availability before installing or running; installs nothing.',
 env_install:'Install whitelisted apt toolchains persistently in PRoot; background job. Refused in read-only.',
 env_install_log:'Read an env_install log only; done is heuristic, so inspect output and recheck before assuming success.',
 env_run:'Execute real shell commands with cwd inside allowed roots; check returned shell. Refused in read-only.',
 file_exists:'Check existence/type/size inside allowed roots without reading contents; missing is a normal result.',
 file_move:'Move within allowed roots; overwrite:true can recursively remove a destination directory.',
 file_copy:'Copy inside allowed roots; no source symlinks. Existing destination needs overwrite:true.',
 file_info:'Read path metadata and symlink information inside allowed roots.',
 file_hash:'Stream a file checksum inside allowed roots; SHA-1/MD5 are for legacy use, not collision resistance.',
 file_append:'Append UTF-8 inside allowed roots, creating if missing; no newline added. Refused in read-only.',
 archive_create:'Create tar.gz inside allowed roots using system tar; entries must stay inside base. Refused in read-only.',
 archive_extract:'Extract tar.gz inside allowed roots; absolute/parent-escaping archive entries are refused before writing.',
 file_truncate:'Shrink a file inside allowed roots to a byte size; growing requires allowExtend:true.',
 file_read_range:'Read an inclusive 1-based text line range inside allowed roots; returns total lines and truncation.',
 file_edit:'Replace exact literal text inside allowed roots; ambiguous matches fail unless replaceAll:true.',
 file_delete:'Delete inside allowed roots; recursive:true removes a tree permanently. Cannot delete an allowed root.',
 file_mkdir:'Create a directory and missing parents inside allowed roots; idempotent. Refused in read-only.',
 file_find:'Find names inside allowed roots using basename wildcards, not regex or path patterns.',
 file_grep:'Search text lines inside allowed roots by JavaScript regex; glob filters basenames only.',
 git_status:'Read branch and changed paths; repository and work tree must be inside allowed roots.',
 git_diff:'Read unified diff inside allowed roots; staged selects the index, target must not start with a dash.',
 git_log:'Read recent commits, newest first, inside allowed roots.',
 git_add:'Stage selected repository-relative paths inside allowed roots; dot stages all. Refused in read-only.',
 git_commit:'Create a commit inside allowed roots; author identity must exist. Refused in read-only.',
 memory_add:'Persist a durable note; identical text merges tags, exceeding 500 notes drops the oldest.',
 memory_search:'Recall stored notes by weighted keyword matching before answering about earlier context.',
 memory_list:'Page stored notes, newest first, for an inventory.',
 memory_forget:'Delete notes: all=true wins over id, then query; query may delete multiple notes.',
 memory_update:'Update an existing note; avoid concurrent writes with memory_add (separate queues can lose writes).',
 memory_delete:'Delete notes and linked relations: all=true wins, then id/text, then query; query may delete many.',
 memory_link:'Persist a directed relation between two existing notes; duplicate relations are not added.',
 memory_links:'Read note relations; optional id/relation filters combine with AND.',
 memory_preferences_get:'Read persisted user preferences before writing; missing store returns an empty object.',
 memory_preferences_set:'Persist preferences; shallow merge, then key wins; null is stored, delete:true removes key.',
 http_request:'Call HTTP(S) with method/headers/body; cookies are automatic. Non-2xx returns ok:false plus body.',
 http_download:'Download HTTP(S) to allowed roots with SHA-256; parent must exist, overwrite defaults false.',
 cookie_store_list:'Inspect or clear process-local cookies; never persisted and no network call is made.',
 web_search:'Search DuckDuckGo web results; use web_fetch to read a selected URL.',
 web_search_news:'Search recent news through DuckDuckGo; returns actual titles, URLs and snippets.',
 crossref_search:'Search scholarly works or look up a DOI; at least one search key is required.',
 github_api:'Read/change GitHub REST API paths only; POST/PATCH/PUT need body, GET/DELETE forbid body.',
 plan_get:'Read current or selected persisted plan before continuing work.',
 plan_create:'Persist a new plan; at capacity, the oldest completed plan is dropped, active plans are kept.',
 plan_add_step:'Append a pending step to the current or selected plan; completed plans refuse additions.',
 plan_update_step:'Persist status/title/note changes to an existing plan step; at least one change is required.',
 plan_complete:'Close a plan; completeSteps:true also marks unfinished steps done.',
 subagent_run:'Delegate a self-contained task via bridge and wait for final text; child sees no conversation history.',
 subagent_list:'Read recent subagent runs from the running bridge, newest first.',
 system_uname:'Read host OS, CPU, memory and uptime facts; starts no external process.',
 system_df:'Read free disk space for every allowed root before large writes.',
 system_uptime:'Read system/process uptime and load averages; Windows load averages are zero by convention.',
 system_process_list:'List running processes with a bounded count; refused in read-only.',
 system_env_redacted:'Read environment variables with credential names redacted and other values capped.',
 tooling_status:'Inspect measured sandbox, roots, bridge and command availability before assuming capabilities.',
 text_convert:'Convert text encodings; optional outputPath writes inside allowed roots and is refused in read-only.',
 text_diff:'Compare two texts/files and return unified diff plus counts; input files stay inside allowed roots.',
 text_sort:'Sort lines with locale-aware comparison; source file stays inside allowed roots.',
 text_unique:'Deduplicate lines and report occurrence counts; source file stays inside allowed roots.',
 text_word_count:'Measure text/file characters, words, lines, bytes and frequent terms.',
 text_replace:'Replace literal/regex matches; outputPath writes inside allowed roots and is refused in read-only.',
 thread_list:'List bridge conversations newest first, with cwd filtering and pagination.',
 thread_read:'Read one conversation history through the bridge, with bounded items and text.',
 thread_rename:'Replace a conversation title through the bridge.',
 thread_delete:'Archive a conversation through the bridge; history remains on disk, this is not hard deletion.',
 thread_send:'Queue one message and return immediately; does not wait for a reply. Use subagent_run for final text.',
 time_get:'Read current wall clock in an IANA zone; numeric offsets are rejected, default UTC.',
 time_format:'Format an instant in a zone; append Z/offset to strings to avoid host-local interpretation.',
 time_add:'Compute date arithmetic in UTC with day clamping; timeZone affects display only, not arithmetic.',
 web_fetch:'Read raw HTTP(S) text, no JavaScript; body capped at 1 MiB. Non-2xx returns ok:false with body.',
 workflow_list:'List saved workflow definitions; never executes a step.',
 workflow_get:'Read a workflow definition and persisted run history.',
 workflow_create:'Save sequential shell/prompt steps; does not execute. Shell steps later need approveShell:true.',
 workflow_delete:'Permanently delete a workflow and all its run history; running workflows cannot be deleted.',
 workflow_run:'Execute stored steps; shell needs approveShell:true and writable sandbox, prompt needs bridge.',
 wb_list:'Page worldbook summaries, without full content; includeDisabled defaults true.',
 wb_get:'Read a full worldbook entry; id wins over exact title, duplicate titles return the oldest match.',
 wb_create:'Persist a worldbook entry; duplicate titles need allowDuplicate:true, then prefer ids.',
 wb_update:'Update supplied entry fields; content/keys/tags replace rather than merge, empty lists clear.',
 wb_delete:'Permanently delete a worldbook entry; export first if it may be needed later.',
 wb_search:'Search worldbook entries by weighted keywords; includeDisabled defaults true.',
 wb_import:'Import JSON entries; json wins over path, replace:true clears the store before importing.',
 wb_export:'Export all entries inline or write path inside allowed roots; store itself is only read.',
});

const metadata=({name,description,inputSchema})=>({name,description,inputSchema});
const HELP_SUFFIX=' Help: tool_help.';

export function compactTool(tool){
 const full=metadata(tool);
 // Short descriptions (notably Android screen safety instructions) need no reduction.
 if(tool.description.length<=220)return full;
 const summary=SUMMARIES[tool.name];
 // New tools require deliberate documentation review before use. Do not slice unknown
 // text at a character/word boundary, or infer which later sentences are unimportant.
 const description=summary
  ?summary+HELP_SUFFIX
  :`Use ${tool.name}. Read tool_help before calling for the complete instructions and safety constraints.`;
 return {...full,description};
}

// Only accepted, enabled tools enter this index. Expose JSON metadata copies, never
// run functions, pack directories, ctx, handshake contents or environment values.
export function createToolCatalog(tools){
 const index=new Map(tools.map(tool=>[tool.name,structuredClone(metadata(tool))]));
 return Object.freeze({
  describeTool(name){
   if(typeof name!=='string'||!name.trim())throw Object.assign(Error('name must be a nonempty tool name'),{code:'args/invalid'});
   const tool=index.get(name);
   if(!tool)throw Object.assign(Error('Unknown or unavailable tool'),{code:'args/invalid'});
   return structuredClone(tool);
  },
 });
}
