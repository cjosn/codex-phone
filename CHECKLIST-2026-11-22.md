# Codex Pocket 待办总清单（2026-11-22 晚，合并三份材料）

> 来源：`HANDOFF-2026-11-22.md`、`D:\Downloads\CodexPocket-缺口清单-2026-11-22.md`、
> `D:\Downloads\CodexPocket-过程流改造方案.md`、`D:\Downloads\dsh-go-phone-port.zip`。
> 标记：✅ 已完成并有真机证据 / 🔧 代码完成待真机 / ❌ 未做 / 🚫 不建议做

---

## 一、已完成（Sprint 1，本地 1.6.5 已装机）

| 项 | 状态 | 真机证据 |
|---|---|---|
| A1 系统提示 `developerInstructions` 新会话注入 | ✅ | 独立会话严格回 `POCKET_INSTRUCTION_OK` |
| A2 `turn/start` 的 `summary:'auto'` 真思考链 | ✅ | ds/chat 返回 156 字符 reasoning，36853 正确 |
| A4 diff 卡（修正 `changes[].diff`、按回合替换、折叠/复制/+N−M） | ✅ | apply_patch 真实补丁，alpha→beta 已验证 |
| A5 插话（`expectedTurnId`、不打断回合） | ✅ | 原回合以 `STEER_OK` 完成 |
| A6 回滚（只删对话历史、活动回合 409、权威重读） | ✅ | 4 items → 2 items，第二回合消失 |
| A3 计划卡 | ❌ | 见下：ds 会话未挂载 plan 工具，聚合代码已就绪但未通过 |

---

## 二、A3 计划卡（唯一未通过的 Sprint 1 项）

**真机实测的根因（2026-11-23 凌晨定位）**：不是计划卡代码的问题，而是 **codex 0.170 根本没把 MCP 工具交给模型**。

证据链：
- `POST /api/mcp` → `mcpServerStatus/list` 报告 `phone`（原 `local-tools`）服务器有 **121 个工具**，含 `screen`、`plan_create`，`error: null`；
- 同一个会话里让模型列出自己拿到的工具，它只有一个都不含 MCP 的清单：
  `exec_command`、`write_stdin`、`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`、
  `request_user_input`、`view_image`、`get_goal`、`create_goal`、`update_goal`、`multi_tool_use.parallel`；
- 排除过的假设（都不是原因）：工具数量太多（降到 19 个仍看不到）、服务器名带连字符（改成 `phone` 无效）、
  `features.incremental_tools=false`（无效）、MCP 宿主启动慢（实测 `/api/mcp` 预热 420 ms）。

**结论（2026-11-22 已定案并修复）**：不是「codex 侧不给工具」，是**我们的 compat-proxy 没写全**。

- codex 0.170 把整个 MCP 服务器发成一个 `{type:'namespace', name:'mcp__phone', tools:[…123 个 function…]}`；
  旧 `toChatTools` 只认 `type:'function'`，把这个 namespace 连同 123 个工具**整块丢掉** → chat wire（手机用的就是它）上一个都看不到。
- 模型调用时，Responses 的 `function_call` 需要**独立的 `namespace` 字段**（`router.rs` 用 `(namespace, name)` 路由），
  旧代理只回裸 `name`，codex 只会在默认 `functions` 命名空间里找 → `unsupported call: screen`。
- 修复：摊平 namespace（同名跨 namespace 用可逆别名）+ 每次请求记录 `别名 → (namespace, name)` 映射，
  在 `output_item.added` / `done` / `completed.output[]` 三处一并还原。
- **真机验收**：`turn-probe` 直接 `screen` 读到真实屏幕；`plan_create` 等计划工具真执行并产生 5 次 `plan.updated`；
  E2E `test/codex-mcp-namespace-e2e.mjs` 断言上游拿到 MCP 真实结果（而不是 `unsupported call`）。
- 顺带修：`mcpServer/elicitation/request`（MCP 工具审批）过去被桥当「不支持」直接拒，导致工具「被用户拒绝」；
  现在变成 App 的审批卡，按协议回 `{action: accept|decline|cancel}`。

---

## 三、新增：过程流改造（DSH 那种观感）— 来自过程流改造方案

> 核心结论：**不缺组件，缺数据模型**。按类型分组存（reasoningList/toolCallList）导致时序永远拼不回。

| # | 事项 | 层 | 状态 |
|---|---|---|---|
| P1 | 桥转发 `item/started`（带 `startedAtMs`） | bridge/adapter | ✅ 1.7.1 真机 |
| P2 | 桥转发 `item/completed`（带 `durationMs`/`exitCode`/`status`） | bridge/adapter | ✅ 1.7.1 真机 |
| P3 | 桥统一成 `item.start` / `item.delta` / `item.end` 三种事件（`field: text\|summary\|output\|patch\|prompt`） | bridge/adapter | ✅ 1.7.1 |
| P4 | `item/reasoning/summaryPartAdded`、`item/commandExecution/terminalInteraction` 补齐 | bridge/adapter | ❌ |
| P5 | App：把 item 事件折成一条 `step` 事件（按发生顺序留在正文上方） | app | ✅ 1.7.1 |
| P6 | App：步骤人话标题映射 `codexStepTitle`（「查看目录」而不是 `ls -la`） | app | ✅ 1.7.1 |
| P7 | App：每行右侧耗时 + 状态点（跑动/成功/失败） | app | ✅ 1.7.1 |
| P8 | App：命令输出默认折叠、失败永不折叠（8 行封顶） | app | ✅ 1.7.1 起 |
| P9 | App：思考流式斜体、结束随过程块一起收起 | app | ✅ 1.7.3 |
| P10 | App：**思考 + 工具 + diff 统一收成一条**「执行 N 步 · Xs」，正文始终展开 | app | ✅ 1.7.3 真机 |
| P11 | App：长按过程组「复制全部过程 / 只复制命令」 | app | ❌ |

**验收**：读 3 个文件出 3 行（不是 3 张卡）；`npm test` 边跑边长；改代码出「修改 2 个文件」+ diff；回合结束收组。

---

## 四、新增：手机工具移植（dsh-go 那套）— 来自 dsh-go-phone-port.zip

**现有 android 包 10 个工具**：`device_capabilities`、`device_clipboard_get/set`、`device_info`、
`shell_exec`、`ui_dump`、`ui_input`、`ui_key`、`ui_swipe`、`ui_tap`。
**目标 15 个**：`screen`、`tap`、`type`、`scroll`、`key`、`tap_xy`、`collect`、`apps`、`open`、
`intent`、`notify`、`clipboard`、`handoff`、`android_shell`、`diagnostics`。

| # | 工具 | 工作内容 | 需改 Kotlin | 状态 |
|---|---|---|---|---|
| H1 | `screen` | 套 `screen-view.mjs`：`[编号] 角色 文本` + 顶/中/底分区 + 3000 预算 | 否 | ✅ 真机通过（1.6.6） |
| H2 | `tap` | 按**编号**点，编号绑定本屏 snapshot；旧编号要明确报错 | 否 | ✅ 真机通过（点 [1] Back 从「手机能力」退回「设置」） |
| H3 | `type` | 输入 + 回读 + `submit` 确认；密码框拒绝并转 handoff | 否 | 🔧 已实现待真机 |
| H4 | `scroll` | 按列表编号滚动，不盲滑 | 否 | 🔧 已实现待真机 |
| H5 | `key` | 系统键（back/home/recents/enter/del） | 否 | 🔧 已实现待真机 |
| H6 | `tap_xy` | 仅用最近一次真实截图坐标，一张图供一次手势 | 否 | 🔧 已实现待真机 |
| H7 | `collect` | 纯 node：循环 dump→取列表项→swipe→去重 | 否 | 🔧 已实现待真机 |
| H8 | `apps` | 包装已有 `GET /app/list` | 否 | 🔧 已实现待真机 |
| H9 | `open` | 包装已有 `POST /app/start` | 否 | 🔧 已实现待真机 |
| H10 | `clipboard` | 合并 get/set 成一个工具 | 否 | 🔧 已实现待真机 |
| H11 | `diagnostics` | 读白名单诊断段 | 否（端点**不存在**，需新加） | ❌ |
| H12 | `intent` | 闹钟/计时器/日程/导航/分享/拨号/短信等系统意图 | **是（约 60 行）** | ❌ |
| H13 | `notify` | 发系统通知 | **是（约 30 行）** | ❌ |
| H14 | `handoff` | 把手机交还给人，等「继续/停止」，最长 10 分钟 | **是（等待回路）** | ❌ |
| H15 | 密码框保护 | `screen` 只显示「密码框」，`type` 直接拒绝 | 否（Kotlin 增 `password` 字段） | ✅ 1.6.7 起 |
| H16 | **`bridge/phone.mjs` CLI 兜底** | MCP 工具接不进会话时，模型用 `exec_command` 跑 `node /opt/codex-go/bridge/phone.mjs screen` 等命令，读写手机屏幕；编号快照落 `codex-go-screen.json`，所以 `screen` 之后能在另一条命令里 `tap <编号>` | 否 | ✅ 1.6.8，真机验证 |
| H17 | **`android-screen` 包（用户提供）按 TOOLPACKS-CONTRACT 注册** | 原样保留用户的 13 个工具实现；只补 `meta`、把 `handlers` 绑成 `run`、加只读守卫（§3.3）；`android` 包同时瘦身到 2 个只读工具避免重名 | 否 | ✅ 1.7.0，真机验证 |

**已完成**：android 包从 10 个工具重做成 13 个（`device_capabilities`、`device_info`、`screen`、`tap`、`type`、`scroll`、`key`、`tap_xy`、`clipboard`、`apps`、`open`、`collect`、`shell_exec`），
`ui_dump`/`ui_tap`/`ui_swipe`/`ui_input`/`ui_key`/`device_clipboard_get`/`device_clipboard_set` 全部被新工具取代。
真机证据：模型调用 `screen` 得到 `屏幕 s1 · 当前应用 · 竖屏 · 共 7 项` + 分区 + `[编号]`；调用 `tap {id:1}` 真的点中 Back 并返回新屏。

**已知限制**：`shell_exec` 在当前 App 构建里永远抛 `device/shizuku-unavailable`（`DeviceApiServer.kt` 明确未接 shell UID），
界面上会显示「DEBUGGER · 本版未接入」。

**许可提醒**：dsh-go 是 AGPL-3.0。包内 `phone-tools.json`（契约）与 `screen-view.mjs`（按规则重写）
是干净做法；**不要直接拷 `McpServer.kt` / `SafetyGate.kt` 源码进闭源发行版**。

---

## 五、缺口清单里尚未开工的（按原优先级）

### P0/P1 协议白送、桥没暴露
| # | 事项 | 状态 |
|---|---|---|
| A7 | 图片输入（`input: [{type:'image',url:'data:...'}]`，桥已支持转发，App 缺选图入口） | ❌ |
| A8 | `@` 文件补全（`fuzzyFileSearch`） | ❌ |
| A9 | 用量条（`account/usage/read` + `rateLimits`） | ❌ |
| A10 | 真 PTY 终端页（`command/exec` 已有端点，App 有 xterm） | 🔧 待真机验证 |
| A11 | 手动压缩按钮 | ✅ 已有（`/api/context/compact`） |
| A12 | 会话分组（`threadSection/*`） | ❌ |
| A13 | 会话附件（`thread/attachment/*`） | ❌ |
| A14 | 目标常驻（`thread/goal/*`，桥已有） | 🔧 待真机验证 |
| A15 | 技能开关（`skills/config/write`） | ❌ |
| A16 | 插件市场安装（`plugin/install`、`marketplace/*`） | ❌ |
| A17 | 设置页读写 codex 配置（`config/batchWrite`，桥已有） | 🔧 部分 |
| A19 | `/review` 代码审查（`review/start`） | ❌ |
| A20 | `fs/watch` 文件树实时刷新 | ❌ |

### B 类（协议没有，得自己写）
| # | 事项 | 状态 |
|---|---|---|
| B1 | 后台保活 + 回合完成系统通知 | ❌ |
| B2 | 分享入口（`ACTION_SEND` → 新会话） | ❌ |
| B3 | 应用内下载进度条（299MB 只有转圈） | ❌ |
| B4 | 渠道密钥加密存储（Keystore + AES-GCM） | ❌ |
| B5 | 崩溃/日志诊断导出 zip | ❌ |
| B6 | 多会话并行队列 | ❌ |
| B7 | 预算告警 | ❌ |
| B8 | 手机能力补 MCP 工具（= 本清单第四节） | ❌ |

### 原 HANDOFF §2 里还没做的
| # | 事项 | 状态 |
|---|---|---|
| 2.2 | 网页端升级 + 二维码远程访问 | ❌ |
| 2.3 | playwright / 零安装 WebView 浏览器通道 | ❌ |
| 2.5 | 终端环境设置页 + 一键安装（ssh/python 已验证可装） | ❌ |
| 2.6 | 背景清晰度 / 卡片不透明度滑杆 | ❌ |
| 2.7 | 工具包扩充（20 包 / 118 工具 → 更多） | ❌ |
| 2.8 | team 包 + 团队页（子代理并发） | ❌ |
| 2.9 | 插件从手机上传 | ❌ |
| 2.10 | 提示词库 | 🚫 建议降级为 slash command + `~/.codex/prompts` |
| 2.11 | 页面整体重做 | ❌ |
| 2.12 | 思考链（已随 A2 完成主体） | ✅ |

---

## 六、建议施工顺序

1. **手机工具 H1/H2/H3/H5/H8/H9/H10**（零 Kotlin，直接解决「你能看我的屏幕吗」）— 今天
2. **过程流 P1–P5**（桥三种事件 + App 时间线模型，观感质变）— 1–2 天
3. **过程流 P6–P11**（人话标题、耗时、折叠策略）— 1 天
4. **H7 collect / H14 handoff / H12 intent / H13 notify**（要写 Kotlin）— 2 天
5. **A3 计划卡**（拆独立 plan server 或换渠道复验）— 半天
6. 其余按第五节优先级

---

## 七、真机验收方法（务必可见）

- 手机上**可见操作**用 `device/uia.mjs`（`tap`/`type`/`dump`/`key`），你会直接看到界面在动。
- 后台协议验证用 `tooling/turn-probe.mjs`（走桥 HTTP + SSE，屏幕上看不到动作，但事件是真实的）。
- 截图在这台 MIUI 上是全黑（FLAG_SECURE），视觉验收一律用 `uia.mjs dump`。
