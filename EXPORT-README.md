# Codex Go — 源码导出说明（供审计）

导出时间：2026-11-19。这份包是当前工作树的可审计子集，**不是**可一键构建的完整发行包（原因见下）。

## 一、这份包解决什么问题

给审计者判断三件事：

1. 现有代码里**哪些是真跑通的**（有真机/真 codex 证据）
2. **哪些是壳**（UI 有了，后端没接）
3. 要接原版 Codex Harness，**哪些保留、哪些改接口、哪些必须重写**

## 二、目录结构

```
codex-go/
├─ bridge/                    ← ★ 核心：Codex app-server 的 Node 桥（真实现，非模拟）
│  ├─ server.mjs              HTTP + Bearer + SSE + 线程/turn/审批/配置/终端/技能
│  ├─ adapter.mjs             codex 通知 → 前端事件的唯一映射层
│  └─ fake-codex.mjs          协议夹具（仅测试用，不是运行路径）
├─ web/                       ← 浏览器版 WebUI（纯静态，可选运行路径）
├─ test/
│  ├─ fixture-model.mjs       ★ 本地合成 Responses 模型，用来无 key 验证渲染与工具链
│  ├─ e2e.mjs / probe.mjs     桥的端到端/探测脚本
│  └─ shot.mjs                Edge CDP 截图
├─ dshgo-fork/dsh-Go-main/    ← 上游 DSH Go 源码（fork 基底，未删改的部分保持原样）
│  ├─ app/lib/codex/          ★ 本项目新增的 Flutter 层（3 个文件 + 终端页 + 技能页）
│  ├─ app/android/.../codex/  ★ 新增的 Kotlin：PRoot 运行时、前台服务、桥资产覆盖
│  ├─ app/lib/ 其余           DSH Go 原有界面/状态（当前**未编译进 Codex Go**）
│  ├─ packages/               dsh_client / dsh_remote 等（多数未接入 Codex 路径）
│  └─ runtime/               runtime 清单与构建脚本（大 tar 已排除）
├─ tooling/                   ← 构建脚本（SDK 已排除，见三）
│  ├─ env.ps1                 本地工具链环境（Flutter/Dart/JDK/SDK 路径与缓存重定向）
│  └─ sync-bridge.ps1         ★ 把 bridge/*.mjs 同步进 APK 资产（桥热更新的关键）
├─ device/                    ← 真机自动化：uia.mjs（语义化点击/截图/dump）
├─ backend/                   ← 早期 DSH 后端试验（与 Codex 路径无关，可忽略）
└─ *.md                       ← PLAN / CONTINUE / README 等过程文档
```

标 ★ 的是本项目真正新增或改造的部分；其余是 fork 基底或过程产物。

## 三、被排除的内容（及原因）

| 排除项 | 体积 | 原因 |
|---|---|---|
| `tooling/sdk/**` | ~15 GB | 本地 Flutter/JDK/Android SDK/NDK/pub+gradle 缓存，可用 `tooling/env.ps1` 指向系统安装 |
| `**/node_modules/**` | ~950 MB | 依赖，用 `npm i` 还原 |
| `runtime/**/*.tar.xz` | ~300 MB | 已打好的 rootfs 镜像（含 Ubuntu+node+codex 二进制） |
| `app/build/**`、`**/.dart_tool/**` | ~1.8 GB | 构建产物 |
| `*/交付_*/*.apk` | ~300 MB/个 | 成品 APK（298 MB，无法随源码分发） |
| `bridge-home/**` | 105 MB | **运行时状态目录，含真实密钥文件**，已整体排除 |

## 四、密钥与凭据处理

- `bridge-home/codex-go-secrets.json`（含中转 key）**已排除**
- 源码内检索到的 `sk-...` 全部是测试用假值（如 `sk-0123456789abcdef...`），无真实凭据
- `dshgo-fork/packages/dartssh2/test/fixtures/` 下的 `id_rsa*` 是上游测试夹具，非真实私钥
- 手机端运行时的 token 由 bridge 每次启动随机生成，不落盘到源码

## 五、构建与运行（最小路径）

### 只跑桥（不需要 Android，最容易审计）
```powershell
# 1) 装官方 codex CLI（或指向已有）
# 2) 起桥
.\tooling\dev-run-bridge.ps1 -Port 8787 -Token devtoken
# 3) 直接看接口
curl http://127.0.0.1:8787/healthz
# 4) 浏览器打开 WebUI
http://127.0.0.1:8787/?token=devtoken
```

### 无 API key 验证工具链渲染
```powershell
node test\fixture-model.mjs --port 8790
# 在 App/WebUI 里把 Base URL 指向 http://127.0.0.1:8790/v1，model 填 gpt-5-codex，
# 发一句包含 "fixture" 的话：会走「思考 → exec_command → apply_patch」三轮
```

### 构建 APK
```powershell
Set-ExecutionPolicy -Scope Process Bypass
. .\tooling\env.ps1          # 需要先把 sdk 路径改到你本机
powershell -File .\tooling\sync-bridge.ps1
cd .\dshgo-fork\dsh-Go-main\app
flutter build apk --release --flavor arm64 --target-platform android-arm64
```

## 六、审计时请重点看这几处（我已知的弱点）

| 位置 | 现状 | 问题 |
|---|---|---|
| `bridge/server.mjs` `configure()` | 写 `config.toml` 时曾把 `null` 写回，已修；内置 provider 做自动改名 | 仍靠字符串拼 TOML 键路径，未用 codex 的 schema 校验 |
| `bridge/server.mjs` `turn/send` | 已补「未传 model 用配置模型」 | 旧线程仍可能带旧模型，缺迁移/校验 |
| `bridge/adapter.mjs` | 只映射了 14 类通知 | `remoteControl/*`、`mcpServer/*`、`plugin/*`、`fs/*`、`review/*` **未映射** |
| `app/lib/codex/codex_pocket_state.dart` | 事件→状态是手写的分支 | 缺事件类型白名单/未知事件日志，扩展成本高 |
| `app/lib/codex/codex_pocket_ui.dart` | 设置页是表单堆叠 | 与桌面 Settings 的信息结构差距大；无 Plugins/Scheduled/Projects |
| 技能 | 只拉了 `skills/list` 展示 | **无技能选择/开关/调用入口**；`image_gen` 工具是否下发未验证 |
| 终端 | `command/exec` + xterm 已真机跑通 | 无多标签、无历史、无 cwd 联动 |
| 保活 | 前台服务 + wakelock | 长时后台、锁屏恢复未压测 |

## 七、已真机验证过的事实（可直接复核）

- 真机 Android 16（2406ERN9CC / arm64）：APK 安装、PRoot 起 `codex app-server`、`/healthz` 返回 `engine=codex`
- 真 codex 0.170.0（Windows）：`/healthz`、`thread/list`、`config`、`models`、`account`、`skills/list` 全通
- 工具链真执行：`exec_command` 在 Android PRoot 内跑 `echo CODEX_GO_TOOL_OK` 成功（需 `sandbox_mode=danger-full-access`，否则 bubblewrap 建不起来）
- 终端：`/bin/bash` PTY，`ls -la`/`pwd` 有真实输出
- 模型传递：`thread.model` 与 rollout 内实际请求模型一致（`gpt-6.1-sol`）
