# Codex Pocket 第二阶段契约（工具扩容 / 上下文压缩 / 人设 / 插件 / 布局）

唯一真源。三个并行实现方（bridge-v2、packs-v2、ui-v2）都按此实现；要改先说明。
参考：`codex-go/_handoff/operit-tools.txt`（Operit 38 包 310 工具清单，只取 PRoot 能落地的部分）。

## A. 布局（ui-v2）

主页 = **上次对话**（有 `lastThreadId` 就直接 resume 进对话），不再以会话列表为首页。
会话列表、终端、能力、设置、关于/手册全部收进**左侧抽屉**；底部不再放 4 个 tab。

- AppBar：左汉堡（开抽屉）、标题（会话名；新会话显示「新对话」）、右侧上下文百分比环形（点开=上下文设置）、模型 chip。
- 抽屉结构（自上而下）：
  1. 品牌头 + 连接状态点（绿=已连接/灰=未连接，点击重连）
  2. 主操作：新对话
  3. 会话列表（搜索、按「最近」分组；长按/右侧菜单：重命名、归档、删除）
  4. 工具入口：终端、能力（工具/技能/MCP/工作流/工具包）、设置、关于与使用手册
  5. 底部：版本号
- 抽屉里每个入口用 `Navigator.push` 打开二级页，不改变主界面状态；返回即回到对话。
- 真机要求：首页进入 ≤1.5s 就显示上次对话内容（可先骨架，再填充消息）。

## B. 上下文压缩与总结（bridge-v2 + ui-v2）

配置存 `${CODEX_HOME}/codex-go-settings.json`：

```json
{"context":{"enabled":true,"thresholdPercent":75,"keepRecentTurns":4,"autoCompact":true,"summaryModel":null}}
```

- `POST /api/context`（读）→ `{"enabled":true,"thresholdPercent":75,"keepRecentTurns":4,"autoCompact":true,"summaryModel":null,"usage":{"totalTokens":0,"contextWindow":null,"percent":0}}`
- `POST /api/context/config` `{enabled?,thresholdPercent?,keepRecentTurns?,autoCompact?,summaryModel?}`
  - `thresholdPercent` 10..95 整数；`keepRecentTurns` 0..50；非法 400 `context/invalid`。
- `POST /api/context/compact` `{threadId}` → 调官方 `thread/compact/start`，返回 `{"threadId","status":"started"}`。
- **自动压缩**：bridge 收到 `thread/tokenUsage/updated` 时记录用量；当 `autoCompact && percent >= thresholdPercent`
  且该 thread 没有活动 turn 时，自动触发一次 `thread/compact/start`，并广播 `{"type":"context.compacted","threadId","percent"}`。
  同一 thread 60s 内不重复触发；失败广播 `context.compact-failed`（带原因），不影响对话。
- 事件里也要广播 `{"type":"context.usage","threadId","totalTokens","contextWindow","percent"}` 供 UI 环形显示。

## C. 系统人设（bridge-v2 + ui-v2）

- `POST /api/persona`（读）→ `{"name":"","style":"","instructions":"","active":true,"path":"/root/.codex/AGENTS.md","effectiveInstructions":"...","injection":"developerInstructions+AGENTS.md"}`。
- `POST /api/persona/save` `{name,style,instructions,active}` → 写入 `${CODEX_HOME}/codex-go-persona.json`，
  并把 `AGENTS.md` 中 `<!-- codex-pocket:persona:start -->` 与 `:end` 之间的托管区块替换掉；
  文件其余内容（用户手写指令）保持不变。返回保存后的读结果。
- 空字符串表示清除该段；`active:false` 时移除托管区块但不删 persona.json。
- 新建会话还会把内置 Agent 行为规范与当前人设合成 `thread/start.developerInstructions`；
  `POST /api/thread/create` 可传 `developerInstructions`（string/null）作为会话级覆盖，优先级高于全局人设，内置规范始终保留。
- **codex 0.170 限制**：已有 thread 固定使用初始指令，`thread/resume`、`thread/fork` 与 `turn/start` 均不能热替换；
  修改人设后必须新建会话。`turn/start` 不带 instructions，只统一传 `summary:"auto"` 请求真实 reasoning summary。

## D. 插件（bridge-v2 + packs-v2 + ui-v2）

插件 = 一个目录，含 `plugin.json`，可选 `toolpacks/<pack>/index.mjs` 与 `skills/<name>/SKILL.md`：

```json
{"name":"my-plugin","title":"我的插件","version":"1.0.0","description":"...","author":"..."}
```

- 目录：内置 `/opt/codex-go/bridge/plugins`（只读、随 APK），用户 `${CODEX_HOME}/plugins`。
- `POST /api/plugins` → `{"plugins":[{"name","title","version","description","builtin","enabled","toolpacks":["x"],"skills":["y"]}]}`
- `POST /api/plugins/install` `{path}` → 复制目录到用户插件目录；缺 `plugin.json` → 400 `plugin/invalid`；重名覆盖（返回 `{name}`）。
- `POST /api/plugins/remove` `{name}` → 仅用户插件；内置 → 400 `plugin/builtin`。
- `POST /api/plugins/toggle` `{name,enabled}` → 持久化 `${CODEX_HOME}/codex-go-plugins.json` `{"disabled":[names]}`。
- 启用插件的 `toolpacks/*` 目录由 **MCP 宿主**加载（等价于内置包目录）；`skills/*` 由 bridge 同步到
  `${CODEX_HOME}/skills/<name>/SKILL.md`（禁用/删除时移除该技能目录）。
- 一个插件的工具包名必须全局唯一；冲突时后加载者跳过并在 `toolpacks` 列表里带 `error`。

## E. 工具包扩容（packs-v2）

在现有 7 个包（core/workflow/subagent/git/memory/web/system，28 工具）基础上**新增**下列包；
工具命名 `^[a-z][a-z0-9_]{0,63}$`、英文描述、`inputSchema` 完整、返回 JSON、失败 `isError`。
不得与现有 28 个工具重名。

| 包 | 工具（新增） |
|---|---|
| `files` | file_exists, file_move, file_copy, file_info, file_hash, file_append, archive_create, archive_extract, file_truncate |
| `text` | text_convert, text_diff, text_sort, text_unique, text_word_count, text_replace |
| `net` | http_request, http_download, cookie_store_list, web_search, web_search_news, crossref_search, github_api |
| `code` | code_run_python, code_run_python_file, code_run_node, code_run_node_file, code_run_shell, code_toolchains |
| `plan` | plan_get, plan_create, plan_add_step, plan_update_step, plan_complete |
| `worldbook` | wb_list, wb_get, wb_create, wb_update, wb_delete, wb_search, wb_import, wb_export |
| `memoryx` | memory_update, memory_delete, memory_link, memory_links, memory_preferences_get, memory_preferences_set |
| `admin` | pkg_list, pkg_set_enabled, pkg_install, context_get, context_set, model_list, model_set, persona_get, persona_set, ping |
| `threads` | thread_list, thread_read, thread_rename, thread_delete, thread_send |
| `time` | time_get, time_format, time_add |

约束：

- `code_run_*` 必须真实执行（`spawn` 免 shell 参数数组），默认超时 60s、输出上限 1MB；
  `code_toolchains` 返回本机探测到的 python3/node/gcc/go/rustc 是否存在及版本，不存在的直接说明。
- `net_web_search` 走 DuckDuckGo HTML 端点解析标题/链接/摘要，**不伪造结果**；网络失败返回可读错误。
- `net_http_request` 支持 method/headers/body/超时，禁止 `file:`，响应 >2MB 截断并标注 `truncated:true`。
- `admin_*` 通过 bridge HTTP 调用第二阶段接口（context/persona/plugins/toolpacks），需要 handshake；
  没有 handshake 时明确报错。
- `threads_*` 走 bridge `/api/thread/*`；`thread_send` 只发一条消息、不等回答（等回答用 subagent）。
- 每个包必须在 `toolpacks.test.mjs` 里有真实断言（临时目录/临时 HTTP 服务/真 subprocess），不得只测 schema。

## F. 兼容

- 旧 `mcp-server.mjs` 行为不变：仍是 stdio MCP、`initialize/tools/list/tools/call`、顺序处理。
- 旧 UI 路由与 state 方法不得删除；新布局复用它们。
- 所有新接口沿用 `/api/*` 鉴权 + Origin + POST 约定；错误统一 `{error:{code,message,details?}}`。
