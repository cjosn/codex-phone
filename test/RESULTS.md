# Codex Pocket 实际验证记录

2026-11-19，Asia/Shanghai。

## 真正官方 Codex 引擎：已执行通过

`codex-real-smoke.mjs` 使用官方 Codex `0.170.0` Windows x64 二进制（npm 包 SRI 校验），完全隔离 `CODEX_HOME`，没有读取或使用用户登录态。

- `--version` 返回 `codex-cli 0.170.0`。
- 真正 `app-server`：initialize / initialized、thread/list、model/list、account/read、thread/start。
- 使用本地合成 Responses 模型服务，真实 Codex 执行 text turn，状态 `completed`，文本精确匹配。
- 本地 fixture 让真实 Codex 执行 `exec_command` 的 `echo CODEX_TOOL_OK`，并断言工具输出回传模型。`toolRoundTrip: true`，总计 3 次模型请求。
- 通过真实 bridge HTTP 读取模型/账号/配置，写 provider 与密钥引用、重启 app-server，验证模型服务实际收到配置的合成 Bearer key。
- 真实 bridge SSE 文本完成，WebUI 资源 HTTP 200，分页历史读取成功，实际会话列表包含已持久化任务。
- 最后一次执行退出码 `0`，进程通过认证的 `/api/bridge/stop` 结束，并等待 Codex 关闭后清理测试目录。

日志：`../tooling/cache/codex-real-smoke.log`。测试仅连接本地合成模型，不代表外部 ChatGPT 授权或付费模型服务已测试。

真实协议发现并修复：新建空 thread 没有 rollout；`thread/read includeTurns:true` 不适合 paginated history，改 metadata-only + `thread/items/list`；配置重启中退休子进程的退出事件不能拒绝新子进程 RPC。

## 明确的协议 fixture：已执行通过

`bridge-contract.test.mjs`：8 项（含外层测试）通过。这里使用显式指定的合成 JSON-RPC 可执行脚本，**不是官方 Codex 引擎测试**。

覆盖：token 与 Origin、JSON/body 错误、密钥只落隔离私有文件且不回显、SSE seq 和 thread 过滤、活动 turn 排他与中断、真实格式审批应答、过期审批与重复应答拒绝、failed turn 保留错误且可恢复。

## Flutter 新界面：已执行通过

`flutter test --no-pub test/codex_pocket --update-goldens`：10 项通过。

包含 thread 过滤、流式 item 合并、跨线程 busy、文本/推理分离、聚合工具输出替换、历史角色恢复、cwd/send 错误、审批三种决定、provider/连接表单、runtime 安装/启动/停止/日志按钮、360/430/1280 浅色非空截图。

截图已经人工读取检查，代码和行内文本可见，未再出现旧渐变背景、字体方块或错误 engine banner。截图使用 fixture 状态，不是外部模型账号。

## WebUI：fixture 浏览器测试

`web-browser.mjs` 使用本地 HTTP/SSE fixture 和 Edge CDP，测试脚本与截图在项目中保留。此前代理报告通过，最终整合需继续核验当前源文件版本。

## 尚待完成

- 独立 Android Kotlin/manifest 编译与最终 APK 构建、签名和内容检查。
- ARM64 runtime 新归档最终源文件哈希一致性。
- 电脑步骤完成后，才通过 USB 安装新 applicationId 并测试 PRoot、真正 ARM64 Codex、后台/锁屏恢复。
- 外部账号授权与真实模型调用尚未执行。

旧 `backend/` 中 DSH 测试属于已经放弃的架构，不能计入此处 Codex 验证结果。
