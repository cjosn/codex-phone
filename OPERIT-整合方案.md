# Operit 整合方案（基于真实源码，不是猜）

> 拉取时间：2026-11-20。来源 `AAswordman/Operit`（`main` @ 2026-11-18 推送）。

## 0. 先说两条硬事实

**① 许可证**

| 仓库 | 协议 | 对我们意味着什么 |
|---|---|---|
| `AAswordman/Operit` | **LGPL-3.0** | 可以用、可以改；**把它的源码编译进我们的 App 后，那部分必须仍然允许替换/回馈**。闭源分发要提供对应源码或可重链接的目标文件。 |
| `AAswordman/Operit2` | **AGPL-3.0** | 更严格，整机传染。**不建议抄**。 |

**② 架构现实（决定怎么搬）**

Operit 是「自己实现 agent 循环 + 自己定义工具」；我们的 Codex 是「官方 app-server 决定工具面」。
Codex 不会执行任意 Kotlin 工具——**它只认三样东西**：

1. 内置工具（`exec_command` / `apply_patch` / `view_image` …）
2. **MCP 服务器**（`config.toml` 的 `[mcp_servers.*]`）
3. Skills（`~/.codex/skills/*/SKILL.md`，等于提示词 + 说明）

所以正确的搬运姿势只有一条：

```
Operit 的工具 / 记忆 / 工作流  →  MCP Server（跑在 PRoot 里，Node/Python 都行）  →  codex 原生调用
Operit 的 MCP 管理能力        →  我们的 App（写 codex 的 mcp_servers 配置）
```

把 Operit 的 Kotlin 工具直接塞进我们的 Flutter App 是死路：codex 根本不会调用它们。

## 1. 源码盘点（实测数字）

```
Kotlin 文件 1476 个
  tool*      316   ← 工具族最大
  mcp         41
  memory      39
  workflow    20
  llama        5
```

关键路径（真实存在，已核对）：

```
core/tools/AIToolHandler.kt          工具调用入口
core/tools/ToolRegistration.kt       工具注册表
core/tools/ToolPackage.kt            工具包（可安装的扩展）
core/tools/mcp/MCPTool.kt            MCP 工具的本地代理
core/tools/mcp/MCPToolExecutor.kt    MCP 工具执行
core/tools/mcp/McpRuntimeSession.kt  MCP 会话（stdio/SSE）
data/mcp/MCPRepository.kt            MCP 配置仓库
data/mcp/MCPLocalServer.kt           本地起 MCP
data/mcp/McpConfigImportParser.kt    导入 mcp.json（Claude/Cursor 格式）
data/mcp/McpStdioConfigResolver.kt   stdio 命令解析
core/workflow/WorkflowExecutor.kt    工作流执行
core/workflow/WorkflowScheduler.kt   定时调度（WorkManager）
core/tools/defaultTool/standard/StandardWorkflowTools.kt  工作流工具
api/chat/library/MemoryLibrary.kt    记忆库
api/chat/llmprovider/LlamaProvider.kt 本地 llama.cpp
llm/llama/.../LlamaNative.kt         JNI 绑定
```

## 2. 搬运决策表

| Operit 能力 | 搬什么 | 落到我们哪 | 方式 | 收益/代价 |
|---|---|---|---|---|
| **MCP 管理** | `McpConfigImportParser` + `MCPServerConfig` + `MCPRepository` 的**配置模型与导入格式** | 能力抽屉 → MCP 页 + `[mcp_servers.*]` 写入 | 重写成 Dart/JS 的配置层（不搬 Kotlin UI） | 高收益、低风险；**已起步** |
| **工具族（316 个）** | 不搬代码，搬**工具定义**（名字/描述/参数 schema） | 自建 MCP server（Node，跑 PRoot） | 用 Operit 的 schema 当参考，重实现执行体 | 中收益、中成本；工具要按 codex 环境重写 |
| **记忆库** | `MemoryLibrary` 的**数据结构与检索策略**（分块、摘要、回填窗口） | 自建 `memory` MCP server（SQLite + 向量可选） | 重实现，schema 对齐 | 高收益；codex 原生没有长期记忆 |
| **工作流** | `WorkflowExecutor/Scheduler` 的**步骤模型与触发方式** | `workflow` MCP server + 复用我们的定时能力 | 重实现调度（Android 侧用 WorkManager 或 bridge 内 cron） | 中高收益 |
| **深度搜索** | 搜索工具的参数与结果裁剪策略 | `search` MCP server（Bing/Tavily/Serper 任选） | 重实现 | 高收益，改动小 |
| **llama.cpp 本地模型** | **不搬 JNI**（`LlamaNative` 要 .so + NDK，且与我们的 arm64 运行时冲突） | PRoot 里跑 `llama-server`（OpenAI 兼容），注册成 codex 的 provider | 复用我们已有的「多中转站」抽屉 | 高收益，且**零 Kt 改动** |
| **多语言界面** | ARB / 文案表 | 我们已是中文单语 | 后置 | 低优先 |
| **手机操控（a11y）** | 已从 dsh-go 那边评估过（`PhoneA11yService`/`Actuator`） | 保持原计划：`codex/phone` channel | 与 Operit 无关 | — |

## 3. 五个阶段（每阶段可单独验收）

### 阶段 1：MCP 管理器（进行中）

- 已做：桥 `/api/mcp` 透传 `mcpServerStatus/list`；能力抽屉加「技能 / MCP」分段；空态说明
- 待做：
  - 「添加 MCP 服务器」表单（名称/命令/参数/env）
  - 写入 `config.toml [mcp_servers.x]`（桥新增 `/api/mcp/add`、`/api/mcp/remove`）
  - 导入 `mcp.json`（照 Operit `McpConfigImportParser` 支持的格式）
  - 每个服务器展开看工具清单
- 验收：加一个 `filesystem` MCP，codex 工具列表里出现 `mcp__filesystem__*`，能真读文件

### 阶段 2：memory MCP server

- 新建 `bridge/mcp/memory-server.mjs`：`memory_add` / `memory_search` / `memory_list` / `memory_forget`
- 存储：`~/.codex/memory.db`（sqlite），分块 + 关键词；向量检索后置
- 自动注入：每轮对话前把 top-k 记忆拼进 system prompt（bridge 侧做）
- 验收：说「记住我喜欢喝冰美式」→ 新会话问「我喜欢喝什么」→ 能答出来

### 阶段 3：workflow

- `workflow_run` / `workflow_list`：步骤 = 一串 prompt 或 shell
- 触发：手动 / 定时（bridge 内 node-cron，App 在前台时生效）
- 验收：定义一个每天跑的 workflow，到点执行并留下记录

### 阶段 4：search + 工具族

- `web_search` MCP（接一个搜索 API），带结果裁剪
- 从 Operit 的工具定义里挑 10~15 个高频（文件、剪贴板、通知、日历），逐个重实现
- 验收：问「帮我查今天的新闻并总结」能走通

### 阶段 5：本地模型

- PRoot 内装 `llama-server` + 一个 4B 级 GGUF
- 注册为 provider（`openai-generic`，baseUrl 指向 `127.0.0.1:PORT/v1`）
- 模型抽屉里出现「本地」分组
- 验收：断网能对话

## 4. 现在就能做的第一刀

**阶段 1 的「添加 MCP 服务器」**——这是所有工具的地基。它做完之后，Operit 那 316 个工具才有地方挂。

需要动的东西：

```
bridge/server.mjs        + /api/mcp/add, /api/mcp/remove（写 config.toml）
codex_pocket_state.dart  + addMcpServer/removeMcpServer
codex_skills_page.dart   MCP 页加「添加」按钮 + 表单
```

## 5. 不做的事

- 不搬 Operit 的 Compose UI（它整套 UI 绑在自己的状态模型上，搬进来等于重写）
- 不搬 `Operit2`（AGPL）
- 不搬 `llm/llama` 的 JNI（会和我们的 PRoot 运行时抢 ABI/内存）
- 不在我们的 App 里重实现 agent 循环（codex 已经有了）
