# Local MCP toolkit (toolpack host)

`mcp-server.mjs` is a dependency-free Node stdio MCP server that hosts **toolpacks**. It implements its own tool surface; it does not copy Operit/Operit2 tool schemas. Toolpack contract: `TOOLPACKS-CONTRACT.md` §3.

## 约定（写工具包、写调用方都先看这一节）

### 1) 返回值封装：只有 `{ok,data}` 和 `{ok:false,error}` 两种

宿主在 `tools/call` 上统一归一化，工具包不用自己拼信封：

| 工具 `run()` 的结果 | 返回给模型的 `structuredContent` |
| --- | --- |
| 对象 V，没有布尔 `ok` 字段 | `{ok:true, data:V}` |
| `undefined` | `{ok:true, data:null}` |
| 对象 V 且 `typeof V.ok === 'boolean'` | V 原样透传（`web_fetch`/`http_request`/`github_api`/`ping` 自带 `ok`） |
| 抛错 E | `{ok:false, error:{code, message}}`，`code` 取 `E.code`（形状合法时）否则 `tool/internal` |
| 超时（默认 120s） | `{ok:false, error:{code:'tool/timeout', message}}` |

成功（`content[0].text` 就是 `JSON.stringify(structuredContent)`）：

```json
{"content": [{"type": "text", "text": "{\"ok\":true,\"data\":{\"path\":\"src/app.js\",\"bytes\":42}}"}],
 "structuredContent": {"ok": true, "data": {"path": "src/app.js", "bytes": 42}},
 "isError": false}
```

失败（`content[0].text` 是 `"<code>: <message>"`，没有 `data`）：

```json
{"content": [{"type": "text", "text": "path/outside-roots: Path is outside the allowed roots: ../outside.txt"}],
 "structuredContent": {"ok": false, "error": {"code": "path/outside-roots", "message": "Path is outside the allowed roots: ../outside.txt"}},
 "isError": true}
```

读法：**先看 `isError`**（这次调用有没有抛错/超时），**再看 `structuredContent`**。
透传工具自己的 `ok` 是业务语义——`web_fetch` 拿到 HTTP 404 时是 `ok:false` 但 `isError:false`，因为调用本身成功了。

### 2) 错误码词表（`code` 形状固定为 `<area>/<kebab>`）

| code | 含义 | 谁抛 |
| --- | --- | --- |
| `args/invalid` | 参数缺失/类型错/超范围 | 包 |
| `path/outside-roots` | 路径逃出 allowed roots（含 `..`、symlink） | 包 |
| `path/not-found` | 路径不存在 | 包 |
| `exec/unavailable` | 解释器/外部命令不存在（什么都没执行） | 包 |
| `sandbox/denied` | 沙箱策略拒绝（`sandboxMode=read-only`） | 包 |
| `net/unreachable` | DNS/连接/超时等网络层失败 | 包 |
| `net/http-status` | 上游非 2xx 且按失败处理 | 包 |
| `tool/timeout` | 超过宿主 `timeoutMs` | 宿主 |
| `tool/internal` | 兜底（含形状非法的错误码，例如 `ENOENT`） | 宿主 |

包自己的码必须也是 `<area>/<kebab>` 并登记到 `TOOLPACKS-CONTRACT.md` §3.2，例如 `git/not-a-repo`、
`workflow/not-found`、`bridge/token-missing`、`toolpack/tar-unavailable`。

### 3) 权限边界（`sandboxMode=read-only`）

`initialize.instructions` 末尾的 `toolingStatus` 是宿主实测的事实（`sandboxMode`、`roots`、`dataDir`、
`bridgeConnected`、`execAvailable`、`execShell`）。**模型应据此判断能不能真跑命令、写文件、连网络，而不是猜**；
包通过 `ctx.sandboxMode` / `ctx.readOnly` 拿到同一份值。

`read-only` 时，所有写文件、执行命令、走网络的工具都必须在动手前抛 `sandbox/denied`（什么都不留下）；
只读工具（`file_read`/`file_list`/`file_search`/`file_exists`/`file_info`/`file_hash`/`system_*`/`time_*`/
`calendar`/不带 `outputPath` 的 `text_*`/`memory_search`/`memory_list`/`plan_get`/`wb_list`/`wb_get`/`wb_search`/
`code_toolchains`）照常工作。判定顺序固定：参数校验 → 权限判定 → 执行。细节见 `TOOLPACKS-CONTRACT.md` §3.3。

### 4) 每个工具的 `description` 必须写什么

这些描述是模型唯一的说明书，缺一项就等于让模型猜。四个必写段落，写成英文、纯 ASCII、单行：

1. **何时用**：开头一句 `Use this to ...`，说清它解决什么问题、什么时候该选它而不是别的工具。
2. **参数含义与范围**：逐个参数写类型、必填/可选、单位、默认值和上下限（例如 `at most 2 MiB (2097152 bytes)`）。
3. **返回什么**：给出对象形状（字段名 + 含义），模型才知道怎么读结果。
4. **失败长什么样**：列出可能出现的 `code` 及触发条件（例如 `Failures: "args/invalid" (...), "path/outside-roots" (...), "sandbox/denied" in a read-only session, "tool/internal".`）。

模板（照抄这个结构，别省略第 4 段）：

```js
export const tools = [{
 name:'file_write',
 description:'Use this to create or completely replace one UTF-8 text file inside an allowed root, when you need to persist generated content. '
  +'path (string, required) is an absolute path or a path relative to an allowed root; content (string, required) is the complete new body, at most 2097152 bytes. '
  +'Returns {path, bytes} where bytes is what was written. '
  +'Failures: "args/invalid" (content is not a string), "path/outside-roots", "path/not-found" (parent directory missing), "file/too-large", "sandbox/denied" in a read-only session, "tool/internal".',
 inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false},
 run:async(args,ctx)=>({/* ... */}),
}];
```

## Registering it

Register it through **MCP → Add** (or `POST /api/mcp/add`):

```json
{
  "name": "codex-go-local",
  "command": "node",
  "args": ["/absolute/path/to/bridge/mcp-server.mjs"],
  "env": {
    "CODEX_GO_ALLOWED_ROOTS": "/path/to/workspace",
    "CODEX_GO_DATA_DIR": "/path/to/workspace/.codex-go",
    "CODEX_HOME": "/path/to/.codex"
  }
}
```

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `CODEX_GO_ALLOWED_ROOTS` | OS-path-delimiter-separated roots. Each root is resolved through `realpath`; unresolvable roots are reported on stderr and ignored. | the server working directory |
| `CODEX_GO_DATA_DIR` | Directory for durable tool state (`workflows.json`, `workflow-runs.json`, `toolpack-memory.json`, `toolpack-plan.json`, `toolpack-worldbook.json`, `toolpack-memoryx.json`, shell-step/code temp files). | `<cwd>/.codex-go` |
| `CODEX_HOME` | Where the bridge handshake, toolpack enable state and user packs live. | `~/.codex` |
| `CODEX_GO_SEARCH_BASE` | Base URL for the DuckDuckGo HTML endpoint used by `web_search` / `web_search_news` (the tool appends `/html/`). Useful for a mirror or a mock server. | `https://html.duckduckgo.com` |
| `CODEX_GO_CROSSREF_BASE` | Base URL for Crossref (`crossref_search` appends `/works`). | `https://api.crossref.org` |
| `CODEX_GO_GITHUB_BASE` | Base URL for the GitHub REST API used by `github_api` (GitHub Enterprise uses `https://host/api/v3`). | `https://api.github.com` |
| `CODEX_GO_GITHUB_TOKEN` / `GITHUB_TOKEN` | Optional GitHub token; `github_api`'s own `token` argument wins. Secrets are never echoed back. | unset |
| `CODEX_GO_CONTACT_EMAIL` | Contact address sent in the Crossref `User-Agent` (Crossref's polite pool). | `noreply@example.invalid` |
| `CODEX_GO_TOOL_TIMEOUT_MS` | Per-call host timeout in milliseconds (minimum 100). A call that exceeds it fails with `code:"tool/timeout"`; the tests use it to exercise that path without waiting two minutes. | `120000` |

## Packs

- Builtin packs: `<directory of mcp-server.mjs>/toolpacks/*/index.mjs` (shipped with the bridge).
- User packs: `${CODEX_HOME}/toolpacks/*/index.mjs`.
- Disabled packs: `${CODEX_HOME}/codex-go-toolpacks.json` → `{"disabled":["web"]}`. A pack is skipped by directory name or by `meta.name`.
- Tool names are globally unique and must match `^[a-z][a-z0-9_]{0,63}$`. A conflicting tool is **not** loaded; the host writes a warning to stderr and keeps serving (builtin packs load before user packs, so a builtin name always wins).
- Packs that fail to import, export no valid tools, or export an invalid `meta.name` are skipped with a stderr warning. The host never crashes because of a bad pack.

Pack module shape (one directory per pack, entry `index.mjs`):

```js
export const meta = {name:'git', title:'Git', version:'1.0.0', description:'Version control helpers'};
export const tools = [{
  name:'git_status',
  description:'Show working tree status for a repository path.',
  inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},
  run: async (args, ctx) => ({/* JSON-serializable object */}),
}];
```

`ctx` passed to every `run`:

- `roots: string[]` — realpath-checked allowed roots.
- `dataDir: string` — durable state directory.
- `bridge: {baseUrl, token} | null` — parsed `${CODEX_HOME}/codex-go-bridge.json` handshake, or `null` when the bridge has not started. Re-read before a bridge-backed call when it is still `null`.
- `timeoutMs: number` — per-call host timeout (`120000` by default, `CODEX_GO_TOOL_TIMEOUT_MS` overrides it).
- `bridgeFile: string` — extension used only for error messages (packs may ignore it).
- `sandboxMode: string | null` — the measured `sandbox_mode` from `${CODEX_HOME}/config.toml` (`null` when the file or the key is missing). Read it instead of parsing the file yourself.
- `readOnly: boolean` — `sandboxMode === 'read-only'`; when true, every write/exec/network tool must throw `sandbox/denied` before touching anything.
- `execAvailable: boolean` / `execShell: string | null` — the shell the host actually found on this machine (POSIX: `/bin/sh`, `/usr/bin/sh`, `/bin/bash`; Windows: `COMSPEC`, `System32\cmd.exe`, Git Bash).

User packs must be self-contained: their `index.mjs` cannot import `../_shared.mjs` (that helper belongs to the builtin packs).

## Tools

| Pack | Tools | What they do |
| --- | --- | --- |
| `core` (6) | `file_read`, `file_write`, `file_list`, `file_search`, `time_now`, `calendar` | Bounded UTF-8 file access (2 MiB), recursive name/content search with caps and standard build/VCS ignores, clock and Gregorian calendar. |
| `workflow` (5) | `workflow_list`, `workflow_get`, `workflow_create`, `workflow_delete`, `workflow_run` | Persistent sequential workflows via `workflows.mjs`: real run history, shell steps (`approveShell:true` per run), and prompt steps executed through the bridge. |
| `subagent` (2) | `subagent_run`, `subagent_list` | Delegate a task to a separate Codex session (`POST /api/subagent/run`) and list recent runs (`POST /api/subagent/runs`). |
| `git` (5) | `git_status`, `git_diff`, `git_log`, `git_add`, `git_commit` | Real git commands spawned with `shell:false` and a cwd inside an allowed root. |
| `memory` (4) | `memory_add`, `memory_search`, `memory_list`, `memory_forget` | Durable notes in `dataDir/toolpack-memory.json` with keyword scoring (tags weigh 3×), dedupe by text and a 500-entry cap. |
| `web` (1) | `web_fetch` | HTTP(S) GET with a 20 s timeout, 1 MiB body cap, returned raw text plus status, final URL and headers. |
| `system` (6) | `system_uname`, `system_df`, `system_uptime`, `system_process_list`, `system_env_redacted`, `tooling_status` | Host facts from `node:os`/`fs.statfs`, processes via `tasklist`/`ps` (no shell), an environment dump that never prints secret-looking values, and `tooling_status` which reports the measured `{sandboxMode, roots, dataDir, bridgeConnected, execAvailable, execShell}` so the model asks instead of guessing. |
| `files` (15) | `file_exists`, `file_move`, `file_copy`, `file_info`, `file_hash`, `file_append`, `archive_create`, `archive_extract`, `file_truncate`, `file_read_range`, `file_edit`, `file_delete`, `file_mkdir`, `file_find`, `file_grep` | Existence/metadata/hash (streamed sha256 default), move/copy/append/truncate, tar.gz archives through the system `tar` binary (`shell:false`), plus the Operit-style basics: line-range reads with an accurate `totalLines`, exact `old`→`new` edits (`expectedCount`, `replaceAll`), delete (recursive optional), idempotent mkdir, wildcard `file_find` and regex `file_grep` with context lines — the last three skip build/VCS dirs, symlinks and binary files. All paths use the same realpath/allowed-roots guard. |
| `data` (4) | `sqlite_query`, `sqlite_tables`, `json_query`, `json_format` | Read-only SQLite through the built-in `node:sqlite` (`readOnly:true` + `PRAGMA query_only=ON` + statement whitelist, so writes are refused before the file is touched), table/view listing with row counts, JSON Pointer extraction (`/items/0/name`, `~0`/`~1` escapes) and JSON validate/format/minify with line/column on errors. No extra dependencies. |
| `text` (6) | `text_convert`, `text_diff`, `text_sort`, `text_unique`, `text_word_count`, `text_replace` | Encoding conversion (utf8/base64/hex/latin1/utf16le/ascii), real LCS line diff with unified hunks (1500-line cap), locale/numeric sorting, de-duplication with counts, word/paragraph/sentence statistics, literal or regex replacement (optionally to a file). |
| `net` (7) | `http_request`, `http_download`, `cookie_store_list`, `web_search`, `web_search_news`, `crossref_search`, `github_api` | Real HTTP(S) with method/headers/body/timeout, streaming downloads with sha256, a process-local cookie jar, DuckDuckGo HTML web/news parsing, Crossref works search and the GitHub REST API (1 MiB cap). |
| `code` (6) | `code_run_python`, `code_run_python_file`, `code_run_node`, `code_run_node_file`, `code_run_shell`, `code_toolchains` | Real interpreter execution with 60 s default timeout, 1 MiB output cap and `{exitCode,stdout,stderr,truncated,timedOut}`; `code_toolchains` probes python3/node/bash/gcc/go/rustc and reports honest absence. |
| `dev` (4) | `env_probe`, `env_install`, `env_install_log`, `env_run` | 探测 + 安装终端环境（真机 PRoot Ubuntu 24.04）：`env_probe` 对固定 21 项清单逐个探测（`--version`，sh/bash 用 `-c "echo ok"`，PATH 追加 `/opt/node/bin` 与当前 Node 目录）**只测不装**；`env_install` 按白名单（`python`/`ssh`/`java`/`go`/`rust`/`build`/`sqlite`/`net`/`unzip`/`jq`/`node` → apt 包）用后台 `nohup sh -c 'apt-get update -y && apt-get install -y --no-install-recommends …'` 安装，**立刻返回** `logPath`，`dryRun:true` 只打印将要执行的命令；装好的环境**持久存在**（写进 rootfs 的 `/usr`，重启 App 不丢），但 **apt 需要网络**；`env_install_log` 只读 `/tmp/codex-go-env-*.log` 尾部，`done` 是启发式（`E: `/`Setting up `/5 s 无变化，会在 `exitHint` 里说清）；`env_run` **默认用 bash**（`bash -c`，没有 bash 退回 `sh -c`，再退回宿主实测的 `execShell` 并在 `shell`/`shellPath` 里如实报告），1 MiB 输出上限、默认 30 s（上限 110 s）。只读沙箱下安装与执行一律 `sandbox/denied`，探测与读日志照常工作。 |
| `plan` (5) | `plan_get`, `plan_create`, `plan_add_step`, `plan_update_step`, `plan_complete` | Step-based plans persisted atomically in `toolpack-plan.json` (50 plans, 200 steps per plan, per-status counts). |
| `worldbook` (8) | `wb_list`, `wb_get`, `wb_create`, `wb_update`, `wb_delete`, `wb_search`, `wb_import`, `wb_export` | Durable lore entries with weighted keyword search, SillyTavern world-info import/export and a 500-entry cap in `toolpack-worldbook.json`. |
| `memoryx` (6) | `memory_update`, `memory_delete`, `memory_link`, `memory_links`, `memory_preferences_get`, `memory_preferences_set` | Edits/deletes the notes owned by the `memory` pack (`toolpack-memory.json`) and adds a link graph plus preferences in `toolpack-memoryx.json`. |
| `admin` (10) | `pkg_list`, `pkg_set_enabled`, `pkg_install`, `context_get`, `context_set`, `model_list`, `model_set`, `persona_get`, `persona_set`, `ping` | Bridge administration over the authenticated HTTP API: toolpacks, context compaction, models, persona and a `/healthz` ping. |
| `threads` (5) | `thread_list`, `thread_read`, `thread_rename`, `thread_delete`, `thread_send` | Conversation management through `/api/thread/*`; `thread_send` sends one message and returns without waiting. |
| `time` (3) | `time_get`, `time_format`, `time_add` | Zone-aware current time, formatting (`iso`/`date`/`time`/`datetime`/`locale`/`unix`/custom `YYYY-MM-DD HH:mm:ss Z` patterns) and day-clamped calendar arithmetic. |
| `android` (2) | `device_capabilities`, `device_info` | The App's native device channel (`docs/DEVICE-API-CONTRACT.md`): permission tier, capability flags and hardware facts. Read-only and cheap, so the model can check what the phone allows before touching it. Every call re-reads the handshake file `${CODEX_HOME}/codex-go-device.json`, so it also reports whether the channel is on at all. Screen control lives in `android-screen`. |
| `android-screen` (13) | `screen`, `tap`, `type`, `scroll`, `key`, `tap_xy`, `collect`, `apps`, `open`, `shot`, `clipboard`, `android_shell`, `device_status` | Operate the phone the way a person reads it: `screen` renders one line per element as `[id] role label`, grouped top/middle/bottom, with a 3000-character budget and password fields never shown; ids belong to that screen only and expire after 30 s, so an id from an older screen fails instead of tapping blind. Actions take the screen id plus the element id and land on the bounds centre (`tap`/`type`/`scroll`), and `collect` scrolls a list and de-duplicates it in one call. `apps`/`open` wrap the package list and launcher endpoints that already existed. Side-effecting tools throw `sandbox/denied` before touching the phone when `sandbox_mode = read-only`. Handlers return `{text}` (plus `image` for screenshots), so the model reads `data.text`. |

**Device channel (`android` pack).** These tools call the App's own HTTP service on `127.0.0.1`; they never spawn
anything in PRoot and never touch the filesystem. The App writes
`${CODEX_HOME}/codex-go-device.json` (`{"baseUrl","token","tier","granted","version","pid","startedAt"}`, mode 0600)
when the phone-capability channel is on, and deletes it when the channel is off. Every tool call reads that file
again before it sends a request, so a revoked tier or a closed channel is noticed by the very next call instead of
a cached session. The `token` is used only in the `Authorization: Bearer` header — it is never logged, never
returned, and if the App echoes it back it comes out as `[redacted]`. A missing or unreadable handshake is
`device/unavailable` with the "Open Settings → Phone capabilities in Codex Pocket and turn the device channel on"
hint; a network failure is `device/unavailable`, a local abort is `device/timeout`, and a non-2xx reply from the App
is rethrown with the App's own `error.code`/`error.message` unchanged.

Tiers (each tool description names the tier it needs, the code it gets without it and how to grant it):

| Tier | Tools | Failure when the grant is missing |
| --- | --- | --- |
| `standard` (default) | `device_capabilities`, `device_info`, `device_clipboard_get`, `device_clipboard_set` | `device/unavailable` when the channel is off; `device/permission-denied` when Android blocks a background clipboard read |
| `accessibility` | `ui_dump`, `ui_tap`, `ui_swipe`, `ui_input`, `ui_key` | `device/permission-denied` — ask the user to enable Codex Pocket in Settings → Accessibility |
| `debugger` (Shizuku) | `shell_exec` | `device/shizuku-unavailable` — ask the user to install, start and authorize Shizuku |
| `admin`, `root` | not used by this pack | — |

Call semantics: every `tools/call` reply carries one envelope in `structuredContent` — success `{"ok":true,"data":<tool value>}`, failure `{"ok":false,"error":{"code":"<area>/<kebab>","message":"..."}}`. `content[0].text` mirrors it (`JSON.stringify(structuredContent)` on success, `"<code>: <message>"` on failure) and `isError` is `true` only for the failure envelope, including `tool/timeout`. Tools that return their own boolean `ok` (`web_fetch`, `http_request`, `github_api`, `ping`) pass through untouched. See the 约定 section at the top and `TOOLPACKS-CONTRACT.md` §3.1–§3.3.

## Bridge integration

The bridge writes `${CODEX_HOME}/codex-go-bridge.json` (`{"baseUrl","token","pid","startedAt","version"}`, mode 600) once it listens. The MCP process reads it and calls authenticated `POST /api/...` with `Authorization: Bearer <token>`.

- `subagent_run` → `POST /api/subagent/run` with `{prompt,cwd?,model?,reasoningEffort?,timeoutMs?,title?}`.
- `subagent_list` → `POST /api/subagent/runs`.
- `workflow_run` prompt steps → `POST /api/thread/create`, then an SSE subscription on `/api/events`, then `POST /api/turn/send`, then waiting for the matching `turn.end` event and collecting `text.delta` chunks. The step record stores `process:"bridge-turn"`, `threadId`, `turnId`, `status` and the real assistant `text`.
- `admin` pack (CONTRACT-V2 §E):
  - `pkg_list` → `POST /api/toolpacks`; `pkg_set_enabled` → `POST /api/toolpacks/toggle` `{name,enabled}`; `pkg_install` → `POST /api/toolpacks/import` `{path}`.
  - `context_get` → `POST /api/context`; `context_set` → `POST /api/context/config` (`enabled`, `autoCompact`, `thresholdPercent` 10-95, `keepRecentTurns` 0-50, `summaryModel`).
  - `model_list` → `GET /api/models`; `model_set` → `POST /api/config` `{model?,provider?,reasoningEffort?,baseUrl?}`.
  - `persona_get` → `POST /api/persona`; `persona_set` → `POST /api/persona/save` `{name?,style?,instructions?,active?}`.
  - `ping` → `GET /healthz` (unauthenticated) and reports engine, mode, revision, Codex version and active turns.
- `threads` pack: `thread_list` → `POST /api/thread/list`, `thread_read` → `POST /api/thread/resume`, `thread_rename` → `POST /api/thread/rename`, `thread_delete` → `POST /api/thread/archive`, `thread_send` → `POST /api/turn/send`.
- Without a handshake all of those tools fail immediately with a message naming the missing handshake file; no thread is created and nothing is faked.

## Safety

- Paths are resolved against the allowed roots and re-checked through `realpath`, so symlinks and `..` cannot escape. Paths that do not exist yet (`file_exists`, move/copy/append destinations) resolve their deepest existing ancestor through `realpath` before use.
- Commands (`git`, `tar`, `tasklist`, `ps`, interpreters) are spawned as argv arrays with `shell:false`. `code_run_shell` is the single deliberate exception: it spawns `bash`/`sh` with `-c` so the script really is a shell script.
- `archive_extract` lists the archive first and refuses entries that are absolute, contain `..`, or use a drive letter; the destination is realpath-checked inside the allowed roots.
- `web_fetch` accepts only `http`/`https`, caps the body at 1 MiB and the call at 20 s; `http_request`/`http_download`/`github_api` reject every non-HTTP(S) scheme and cap bodies at 2 MiB / 200 MiB / 1 MiB.
- Search results are only reported when they were parsed from a real response. A network failure is an error; an unparsable page returns `resultCount: 0` with a `note` explaining that nothing was invented.
- `system_env_redacted` returns `value:null` for any name containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `COOKIE`, `AUTH` or `PRIVATE`.
- Requests are handled one at a time in arrival order so workflow, plan, worldbook and memory writes stay deterministic; each pack additionally serializes its own JSON mutations and writes atomically (temp file + rename, mode 600).
- `code_run_*` writes inline snippets to a 0600 temp file under `CODEX_GO_DATA_DIR`, runs it with a hard timeout and removes it afterwards.

## Limitations

- The MCP host enforces a 120 s limit per tool call. `subagent_run` therefore clamps its bridge timeout to the remaining budget (reported as `timeoutMs` / `clampedByHost`), and `code_run_*` defaults to 60 s.
- `archive_create` / `archive_extract` support **tar.gz only**, implemented with the system `tar` binary spawned without a shell. zip and 7z need a binary that cannot be assumed on the host, so they are refused with an explicit message instead of silently producing a different format. When `tar` itself is missing the tool says so.
- `code_run_*` returns a non-zero script exit as a structured result (`exitCode`, `stdout`, `stderr`), not as `isError`: the tool worked, the script failed. A timeout is reported as `timedOut:true` with the partial output that was captured; a missing interpreter is an `isError` naming what was probed. A present-but-broken candidate (for example the Windows Store `python3` stub, which exits 9009) is reported as unavailable, not as installed.
- `code_run_python`/`code_run_node` write the snippet as a `.py`/`.mjs` temp file, so Node runs ES modules (no `require`).
- `web_search` / `web_search_news` parse the current DuckDuckGo HTML markup (`result__a` anchors, `result__snippet` blocks, `uddg=` redirects, with a `result-link` fallback). If DuckDuckGo changes layout or serves an anti-bot page, the tool returns zero results plus a note rather than guesses. `CODEX_GO_SEARCH_BASE` can point it at a mirror.
- `cookie_store_list` reflects cookies captured in this MCP process only; the jar is in-memory and is not written to disk.
- `thread_delete` archives rather than hard-deletes: the Codex app-server exposes `thread/archive` and no delete RPC, and the result states this.
- `memoryx` deliberately has no create tool: it edits the notes that `memory_add` created (`toolpack-memory.json`) and keeps links/preferences in `toolpack-memoryx.json`.
- `web_links` (link extraction) is intentionally not implemented; use `web_fetch` and parse the text.
- Builtin packs share `toolpacks/_shared.mjs`; user packs must be a single self-contained directory.
- Tool execution is separate from model reasoning; only real Codex prompt/configuration protocol operations can invoke or configure deep reasoning.

## Tests

```bash
node --test --test-isolation=none test/toolpacks.test.mjs
```

The suite spawns `mcp-server.mjs` as a real stdio child (16 tests) and covers pack loading and the host's own `loaded N packs, M tools` log, file search, the memory round-trip including a process restart, git on a temporary repository, the disabled list and duplicate-name handling, `web_fetch` against a local HTTP server, the system pack's secret redaction, and the honest failure of bridge-backed tools when the handshake is absent.

The envelope contract is asserted on the wire, not assumed: a success is checked to be `{ok:true,data}` with `content[0].text === JSON.stringify(structuredContent)`, every failure is checked to be `{ok:false,error:{code,message}}` with `content[0].text === "<code>: <message>"` and no `data`, a user-pack value that carries its own boolean `ok` is checked to pass through untouched, a thrown pack code (`mypack/boom`) is checked to survive, the host timeout is checked to report `tool/timeout` (a call to a server that never answers, with `CODEX_GO_TOOL_TIMEOUT_MS=400`), and `initialize.instructions` is checked to carry a parseable `toolingStatus` line with `sandboxMode:null` when there is no `config.toml` and `"read-only"` once one sets `sandbox_mode`.

CONTRACT-V2 section E adds real assertions per pack: `files` (exists/info/hash/append/copy/move/truncate plus a tar.gz create+extract round-trip), `text` (base64/hex conversion, unified diff counts, numeric and descending sort, de-duplication, word statistics, literal vs regex replacement to a file), `net` (a local HTTP server for request/echo/truncation, cookie capture, a DuckDuckGo-like fixture including `uddg` redirects and HTML entities, a news fixture, a Crossref fixture, `file:` rejection and a clear error for an unreachable search endpoint), `code` (real `node` and `python` runs, a script file with argv, exit code 3, a thrown error, a 1 s timeout, the 1 MiB output cap and `code_toolchains`), `plan`/`worldbook`/`memoryx` (create/update/complete, SillyTavern import+export, link graph and preferences, all re-read after a process restart), `admin`/`threads` (each tool fails naming the missing handshake; a fake bridge server then proves every documented endpoint path, body and bearer token), and `time` (zone offset, custom patterns, epoch seconds vs milliseconds, month/day/year clamping).
