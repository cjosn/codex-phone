# Codex Pocket 工具包 / 子智能体 / 模型自动拉取 —— 接口契约（唯一真源）

写给并行的三个实现方（bridge 后端、MCP 工具包、Flutter 界面）。**任何一方不得改本文件里的形状**；
需要改先说明，否则按此实现。

## 0. 设计前提（用户要求）

- 工具是**给以后的 AI 调用**的，不是给人点的按钮：描述用英文、参数 schema 明确、返回值是可解析的 JSON、
  失败用稳定的错误码说清原因（`{ok:false,error:{code,message}}`，见 §3.1/§3.2），不静默吞。
- 像 Operit 一样**按包管理**：每个包 = 一组相关工具，可启用/禁用/导入/移除，未启用则不暴露给模型。
- 缺子智能体：`subagent` 包提供「把子任务交给另一个 Codex 会话并拿回结果」。
- 自定义中转站要能**自动拉取模型列表**，不要再手打模型 ID。

## 1. 运行期握手文件（bridge → 嘉宾进程）

bridge 监听成功后写：

```
${CODEX_HOME}/codex-go-bridge.json     chmod 600
{"baseUrl":"http://127.0.0.1:PORT","token":"<bridge token>","pid":123,"startedAt":1699999999999,"version":"0.9.5"}
```

- MCP 子进程从 `CODEX_HOME` 读它，才能回调 bridge（子智能体/工作流 prompt 步骤）。
- 该文件**只给内部进程**用，不通过任何 HTTP 接口返回 token。

## 2. Bridge HTTP 新增接口（server.mjs）

所有 `/api/*` 已有鉴权、Origin 校验、`POST` 约定不变。

### 2.1 `POST /api/subagent/run`

```json
{"prompt":"...","cwd":"/root/workspace","model":"gpt-6.2-sol","reasoningEffort":"high","timeoutMs":600000,"title":"子任务"}
```

- `prompt` 必填非空；`cwd` 默认当前 CWD；`timeoutMs` 1000..1800000，默认 600000。
- 行为：`thread/start` → `turn/start` → 等该 thread 的 `turn/completed`（或 failed/超时）。
- 成功返回：`{"threadId","turnId","status":"completed","text":"<最终助手文本>"}`
- 失败：`codex/subagent-timeout` 504 / `codex/subagent-failed` 502，`details` 带 `threadId`。

### 2.2 `POST /api/subagent/runs`

返回最近 20 条（内存即可）：`{"runs":[{"id","threadId","title","status","startedAt","finishedAt","preview"}]}`

### 2.3 `POST /api/providers/models`

```json
{"baseUrl":"https://relay.example.com/v1","apiKey":"sk-...","provider":"relay2"}
```

- `baseUrl` 必填，绝对 http(s)，不得含账号密码/query/fragment；`apiKey` 可省（则用该 provider 已存密钥）。
- 请求 `GET {baseUrl}/models`，`Authorization: Bearer <key>`，10s 超时，响应 >2MB 拒绝。
- 返回：`{"baseUrl":"...","models":[{"id":"gpt-6.2-sol","ownedBy":null}],"count":3}`
- 上游非 2xx：`provider/models-fetch` 502，`details.status`；网络错误：`provider/models-unreachable` 502。

### 2.4 工具包管理

- `POST /api/toolpacks` → 列表（不用 GET，沿用现有约定）：
  ```json
  {"packs":[{"name":"git","title":"Git","version":"1.0.0","description":"...","builtin":true,
             "enabled":true,"tools":[{"name":"git_status","description":"..."}]}]}
  ```
- `POST /api/toolpacks/toggle` `{"name":"web","enabled":false}` → `{"name":"web","enabled":false}`
- `POST /api/toolpacks/import` `{"path":"/root/workspace/packs/mypack"}` → 复制进用户包目录，`{"name":"mypack"}`
- `POST /api/toolpacks/remove` `{"name":"mypack"}` → 仅用户包可删；内置包只能禁用，删则 400 `toolpack/builtin`。

启用状态持久化到 `${CODEX_HOME}/codex-go-toolpacks.json`：`{"disabled":["web"]}`。
内置包目录：`/opt/codex-go/bridge/toolpacks`；用户包目录：`${CODEX_HOME}/toolpacks`。

## 3. MCP 宿主与工具包格式（mcp-server.mjs）

- 服务器名仍是 `codex-go-local-toolkit`；启动时加载「内置目录 + 用户目录」，跳过 disabled。
- 工具名全局唯一（`^[a-z][a-z0-9_]{0,63}$`）；重名以先加载者为准并写 stderr 警告。
- 包模块形状（每个包一个 `index.mjs`）：

```js
export const meta = {name:'git', title:'Git', version:'1.0.0', description:'Version control helpers'};
export const tools = [{
  name:'git_status', description:'Show working tree status for a repository path.',
  inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},
  run: async (args, ctx) => ({...}),   // 返回 JSON 可序列化对象；失败就 throw
}];
```

- `ctx`：`{roots: string[], dataDir: string, bridge: {baseUrl, token} | null, timeoutMs: number,
  bridgeFile: string, sandboxMode: string | null, readOnly: boolean, execAvailable: boolean, execShell: string | null}`。
  `sandboxMode`/`readOnly`/`execAvailable` 是宿主实测值（见 §3.4），包不需要自己去读 `config.toml`。
- 每个工具执行超时 `timeoutMs`（默认 120000，可用环境变量 `CODEX_GO_TOOL_TIMEOUT_MS` 调小）；
  超时按失败处理，`code` 是 `tool/timeout`。
- 必带包：`core`（文件/时间/日历）、`workflow`、`subagent`、`git`、`memory`、`web`、`system`。

### 3.1 返回值封装（宿主统一归一化）

归一化**只发生在宿主**（`mcp-server.mjs` 的 `tools/call` 成功/失败两条路径），工具包不用自己拼信封：

| 工具 `run()` 的结果 | `structuredContent` |
| --- | --- |
| 返回对象 V，V 没有布尔 `ok` 字段 | `{ok:true, data:V}` |
| 返回 `undefined` | `{ok:true, data:null}` |
| 返回对象 V 且 `typeof V.ok === 'boolean'` | V 原样透传（`web_fetch` / `http_request` / `github_api` / `ping` 的返回值就带自己的 `ok`） |
| `throw` 出错误 E | `{ok:false, error:{code, message}}`；`code` 取 `E.code`（形状合法时，见 §3.2），否则 `tool/internal`；`message` 取 `E.message` |
| 超过 `timeoutMs` | `{ok:false, error:{code:'tool/timeout', message}}`（与失败同一条路径） |

成功报文（`content[0].text` 是 `JSON.stringify(structuredContent)`）：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{"type": "text", "text": "{\"ok\":true,\"data\":{\"path\":\"src/app.js\",\"bytes\":42}}"}],
    "structuredContent": {"ok": true, "data": {"path": "src/app.js", "bytes": 42}},
    "isError": false
  }
}
```

失败报文（`content[0].text` 是 `"<code>: <message>"`，`isError` 为 `true`，**没有** `data` 字段）：

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "content": [{"type": "text", "text": "path/outside-roots: Path is outside the allowed roots: ../outside.txt"}],
    "structuredContent": {"ok": false, "error": {"code": "path/outside-roots", "message": "Path is outside the allowed roots: ../outside.txt"}},
    "isError": true
  }
}
```

约定：

- `content[0].text` 与 `structuredContent` 永远一致（成功 = 同一个 JSON，失败 = `"<code>: <message>"`），模型看哪个都行。
- `isError` 只说「这次调用有没有抛错或超时」，**不说业务结果**。透传工具自带的 `ok` 是它自己的语义
  （`web_fetch` 的 `ok:false` 只是 HTTP 非 2xx，调用本身成功，`isError:false`），所以先看 `isError`，再看工具自己的字段。
- 失败报文里不允许出现 `data`（不许伪造半个结果），成功报文里不允许出现 `error`。
- 工具包的 `run()` **不需要**返回 `{ok:true,data:...}`；直接返回自己的业务对象即可，宿主会包。
  只有确实想自己控制信封语义时才返回带布尔 `ok` 的对象（此时宿主原样透传）。
- 只有「工具真的跑过」才有信封。协议层问题仍然是 JSON-RPC error：未知工具名 `-32602`、
  未知方法 `-32601`、解析失败 `-32700`。`tools/call` 的 `arguments` 不是对象时会走失败信封（`args/invalid`）。

### 3.2 错误码词表

`code` 的形状固定为 `<area>/<kebab>`，正则 `^[a-z][a-z0-9-]*\/[a-z0-9]+(-[a-z0-9]+)*$`。
宿主只接受这个形状，**其他形状（例如 Node 的 `ENOENT`、`EACCES`）一律改写为 `tool/internal`**，
所以模型看到的 `code` 永远可枚举、可比较。

宿主/公共词表（新增码必须登记在本节，同义不要造第二个）：

| code | 含义 | 谁抛 |
| --- | --- | --- |
| `args/invalid` | 参数缺失、类型错、超出允许范围 | 工具包 |
| `path/outside-roots` | 路径逃出 allowed roots（含 `..` 与 symlink） | 工具包 |
| `path/not-found` | 目标路径不存在 | 工具包 |
| `exec/unavailable` | 解释器/外部命令不存在或起不来（什么都没执行） | 工具包 |
| `sandbox/denied` | 沙箱策略拒绝（`sandboxMode=read-only` 等，见 §3.3） | 工具包 |
| `net/unreachable` | DNS/连接/超时等网络层失败 | 工具包 |
| `net/http-status` | 上游返回非 2xx，且工具决定按失败处理 | 工具包 |
| `tool/timeout` | 超过宿主 `timeoutMs`（默认 120s） | 宿主 |
| `tool/internal` | 兜底：未分类或未标注的错误 | 宿主 |

包自己的 `<area>/<kebab>`（示例，随包扩充，但必须登记在这里）：

| code | 含义 |
| --- | --- |
| `git/not-a-repo` | 目标目录不是 git 仓库 |
| `workflow/not-found` | 工作流 id 不存在 |
| `bridge/token-missing` | 握手文件缺 token |
| `device/unavailable` | 设备通道没开或不可达（握手文件缺失/读不到/连不上），请求没有到达手机 |
| `device/permission-denied` | App 侧权限档位不够（例如标准档读屏），App 的原话原样透传 |
| `device/shizuku-unavailable` | Android shell 需要 Shizuku 或本版未接入 shell UID |
| `device/timeout` | 手机侧没有在截止时间内应答，请求已中止 |
| `device/unsupported` | App 回了未登记的错误体，或目标元素不可操作（无 bounds / 非输入框） |
| `device/screenshot-blocked` | 系统拒绝截图（FLAG_SECURE 等受保护页面） |
| `device/stale-screen` | 屏幕快照过期或不属于当前屏，编号不能再用 |
| `file/too-large`、`time/invalid-date`、`state/not-found`、`state/conflict`、`store/write-failed` | 包内更细的失败分类（文件过大、时间解析失败、记录不存在、唯一性冲突、写状态文件失败） |
| `toolpack/tar-unavailable`、`toolpack/outside-roots`、`toolpack/timeout` 等 | 内置包共享辅助（`_shared.mjs`）产生的公共码，同样符合 `<area>/<kebab>` |

`message` 的写法（英文）：

- 说清「为什么失败」+「下一步怎么办」，例如 `Path is outside the allowed roots: ../outside.txt`。
- 不要只写 `failed` / `error`；不要把密钥、token、账户目录等敏感内容写进 `message`（允许根内的路径可以写，方便模型定位）。
- 失败必须发生在**任何副作用之前**（参数校验 → 权限判定 → 执行），不能留下半个文件。

### 3.3 权限边界（`sandboxMode = read-only`）

事实来源：`initialize.instructions` 里的 `toolingStatus.sandboxMode`（见 §3.4），同一份值通过
`ctx.sandboxMode` / `ctx.readOnly` 交给工具包。宿主编排层不做读写判断（它不知道某个包会不会写盘），
**边界由工具包自己执行**，判定顺序固定为「参数校验 → 权限判定 → 执行」。

`sandboxMode === 'read-only'` 时，下面三类工具**必须**在动手前抛 `sandbox/denied`：

| 类别 | 工具（示例） | 拒绝时要说清 |
| --- | --- | --- |
| 写文件/写状态 | `file_write`、`file_append`、`file_move`、`file_copy`、`file_truncate`、`archive_create`、`archive_extract`、`http_download`、`text_convert`(带 `outputPath`)、`text_replace`(带 `outputPath`)、`wb_export`(带 `path`)、`memory_add`/`memory_update`/`memory_delete`/`memory_preferences_set`、`plan_create`/`plan_add_step`/`plan_update_step`/`plan_complete`、`wb_create`/`wb_update`/`wb_delete`/`wb_import` | 什么都没写 |
| 执行命令 | `code_run_python`、`code_run_python_file`、`code_run_node`、`code_run_node_file`、`code_run_shell`、`workflow_run` 的 shell 步骤、`git_add`、`git_commit`、`archive_*`（要 spawn `tar`） | 什么都没执行 |
| 网络 | `web_fetch`、`http_request`、`http_download`、`web_search`、`web_search_news`、`crossref_search`、`github_api`，以及所有走 bridge 的本地 HTTP 调用（`subagent_*`、`workflow_run` 的 prompt 步骤、`admin`、`threads`） | 请求没有发出 |

只读工具不受影响，照常工作：`file_read`、`file_list`、`file_search`、`file_exists`、`file_info`、
`file_hash`、`system_*`、`time_get`、`time_format`、`time_add`、`calendar`、`text_*`（不带 `outputPath`）、
`memory_search`、`memory_list`、`plan_get`、`wb_list`、`wb_get`、`wb_search`、`code_toolchains`（只跑 `--version` 探测）。

判定实现建议（工具包侧，读 `ctx` 即可，不必自己解析 `config.toml`）：

```js
const READ_ONLY_VALUES=new Set(['read-only','readonly','read_only']);
function assertSandboxAllows(ctx,tool,what){
 const mode=String(ctx?.sandboxMode??'').toLowerCase();
 if(!ctx?.readOnly&&!READ_ONLY_VALUES.has(mode))return;
 throw Object.assign(Error(
  `${tool} ${what}, but this session runs in a read-only sandbox (sandbox_mode = read-only), `
  +'so nothing was changed. Ask the user to switch sandbox_mode to workspace-write or '
  +'danger-full-access and retry, or use a read-only tool instead.',
 ),{code:'sandbox/denied'});
}
// 用法（放在参数校验之后、任何副作用之前）：
// assertSandboxAllows(ctx,'file_write','writes to disk');
```

### 3.4 `initialize.instructions` 里的 `toolingStatus`

宿主动手实测，**不写猜测值**；模型据此判断「能不能真跑命令 / 写文件 / 连网络」，而不是凭训练印象猜。
字段（`instructions` 最后一行的 `toolingStatus: {...}` 是紧凑 JSON，可直接解析）：

| 字段 | 含义 | 取不到时 |
| --- | --- | --- |
| `sandboxMode` | `${CODEX_HOME}/config.toml` 里 `sandbox_mode` 的值 | `null` |
| `roots` | 生效的 allowed roots（已 `realpath`） | 至少一项（cwd 兜底） |
| `dataDir` | 工具状态目录 | 总是有值 |
| `bridgeConnected` | 是否读到 `${CODEX_HOME}/codex-go-bridge.json` 握手 | `false` |
| `execAvailable` / `execShell` | 宿主能否找到可执行 shell（POSIX 探测 `/bin/sh`、`/usr/bin/sh`、`/bin/bash`；Windows 探测 `COMSPEC`、`System32\cmd.exe`、Git Bash） | `false` / `null` |

注意 `execAvailable` 只代表「shell 存在」，具体解释器是否存在要问 `code_toolchains`。

## 4. Flutter 界面

- 能力页新增第 5 个 tab：**工具包**（`工具 / 技能 / MCP / 工作流 / 工具包`），每行显示 title、工具数、开关；
  内置包不能删但有开关；底部「导入工具包」输入路径；失败要显示原因。
- 模型渠道页（`CodexModelSettingsPage`）：
  - 填了 Base URL 后点「拉取模型」→ `POST /api/providers/models`，成功把 ID 填进下拉可选项；
  - 下拉选中即写入模型 ID 输入框；失败显示错误文本，不写脏数据；
  - 不自动覆盖用户已填的模型 ID。
