# Codex Pocket

安卓手机上的本地 Codex Agent：官方 `codex app-server` 跑在 PRoot 里，Flutter 原生界面，多渠道 / 多协议中转站，工具包与手机能力分级授权。

## 下载

- 最新版（App 内的「检查更新」也是读这里）：https://github.com/cjosn/codex-phone/releases/latest
- v1.6.3：https://github.com/cjosn/codex-phone/releases/tag/v1.6.3
  （`Codex-Pocket-1.6.3-arm64.apk`，299 MB，SHA-256 `82e91ab635605890950b8dc27481bee5c0502acae7371f7240498d25b33cbe5e`）
- App 更新清单：https://github.com/cjosn/codex-phone/releases/latest/download/latest.json

> 手机网络里 `github.com` 常常不可达，App 内的更新检查与下载都走 `api.github.com`
> （`/repos/<owner>/<repo>/releases/latest` 与 `/releases/assets/<id>`，带 `Accept: application/octet-stream`）。

## 文档

- [交接文档 HANDOFF-2026-11-21.md](HANDOFF-2026-11-21.md)：现状、已知问题、调试手法、发布流程
- [手机 Agent 能力扩展方案](docs/手机Agent能力扩展方案.md)：PRoot 之外的原生能力、分级授权模型、实施阶段、限制与免责声明
- [Device API 契约](docs/DEVICE-API-CONTRACT.md)：App 原生通道 ↔ MCP 工具的端点/错误码/握手文件

## 能力概览

- 引擎：官方 `codex-cli 0.170.0`（app-server 协议），在 PRoot Ubuntu 24.04 里运行
- 界面：Flutter 原生（会话/思考链/工具卡/审批/终端/主题），历史与设置分两个抽屉
- 模型接入：6 种 wire（`openai-chat` / `openai-responses` / `anthropic` / `gemini` / `azure-openai` / `ollama`），非 responses 走本机兼容代理
- 工具：20 个工具包 / 118 个工具（文件、代码、git、网络、记忆、计划、工作流、sqlite/json、终端环境、Android 设备）
- 手机能力：STANDARD / ACCESSIBILITY / DEBUGGER / ADMIN 四级授权，读屏·点击·截图经无障碍服务，shell 需 Shizuku
- 更新：应用内检查 → 下载（api.github.com）→ SHA-256 校验 → 系统安装器