# Codex Pocket / Codex Go

独立的 Codex 移动端，按用户提供的浅色 Codex Pocket Demo 实现。**真正后端是 OpenAI `codex app-server`，不是 DSH 引擎接 Codex 模型。**

早期实现误用了完整 DSH 根界面与引擎，此路线已停止。历史测试和源码保留便于追溯，但不能作为当前 Codex 引擎的验收结果。

## 当前架构

```text
Flutter CodexPocketApp / 浅色 WebUI
  任务、工作区、消息流、工具、审批、设置、项目路径
                │ HTTP + Bearer token + SSE
                ▼
Node Codex bridge（codex-go/bridge）
  真实JSON-RPC、会话绑定、审批应答、配置、事件断点
                │ stdio JSON-RPC
                ▼
官方 Codex app-server（固定0.170.0，按官方schema适配）
  Codex调度、工具执行、MCP、provider、账号与会话持久化
```

手机本地模式在 PRoot Ubuntu 内运行 Node bridge 和 Linux ARM64 Codex。Android 前台服务、runtime 解包、PRoot 和日志这些基础组件借用 dsh-go 的成熟实现；不启动其 DshApp、RootGate、LaunchStart 或 DSH provider/OAuth 服务。

## 源码位置

- `dshgo-fork/dsh-Go-main/app/lib/codex/`：独立 Flutter 根应用、浅色任务界面和HTTP/SSE客户端。
- `dshgo-fork/dsh-Go-main/app/lib/main.dart`：直接启动 CodexPocketApp。
- `dshgo-fork/dsh-Go-main/app/android/.../codex/`：独立 Codex 安装、启动、健康检查、日志、前台保活服务。
- `bridge/`：真正 Codex app-server 的桥接层。
- `web/`：按 Demo 重做的浅色 WebUI，手机抽屉和平板双栏。
- `tooling/build-codex-runtime.py`：组装含官方 ARM64 Codex 的 runtime，删除原 DSH 引擎和旧用户目录。
- `dshgo-fork/dsh-Go-main/runtime/codex-go/`：Termux入口与真正Codex runtime校验器。

Android applicationId：`io.github.codexgo.app`，与原版并存。Kotlin namespace 保留原值，只为复用代码；运行引擎身份会独立检查 `manifest.codexGo.engine == 'codex-app-server'`，不能把旧DSH runtime误启动为Codex。

## 能力边界

Codex 自己的调度、会话、工具、provider 配置和流式协议由实际 app-server 承接。DSH 的 pi-ai、`PI_AI_ERROR`、Cordis schema 和 dsh-purge 不是 Codex 核心接口；原版能力不可原封不动装到 Codex 内核，也不会用伪造状态代替兼容性。

KV cache 是模型服务的能力；客户端只能显示 Codex 实际返回的 token/缓存用量。桌面操作系统工具与 Android 内核/沙箱能力不同，不能仅凭复用UI就承诺完全等价。

## 开发和构建顺序

先电脑端前后端联调、Flutter/WebUI真实渲染、源码分析及APK构建，再通过USB安装新的独立App进行ARM64、PRoot、保活、锁屏恢复、授权与模型调用测试。原版App不会被卸载或覆盖。

工作区工具链在 `tooling/sdk/`，不是交付源码的一部分。版本为 Flutter 3.47.7 / Dart 3.13.5、JDK17、SDK36、NDK28.2.13676358。PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
. .\tooling\env.ps1
cd .\dshgo-fork\dsh-Go-main\app
flutter pub get
flutter analyze --no-fatal-infos
flutter test test/codex_pocket
flutter build apk --release --flavor arm64 --target-platform android-arm64 --build-name 0.1.0
```

当前发布线以 v1.8.6 为基线；v1.9.0 本地改造包含图片/MD/TXT 附件、协议容错、流式工具参数、子 Agent 面板、受限 root/Shizuku shell 与工具 schema 压缩。完整包构建和真机验收记录见 `HANDOFF-2026-11-25.md`。`tooling/clean-runtime.py` 和 `backend/` 下 DSH 集成测试属于旧路线，不可用来证明新 App 已完成。

## 来源

dsh-go源码来自用户提供的ZIP快照，无Git commit元数据，不伪造提交号。保留上游AGPL、第三方许可和署名。新增图标为原创终端符号，不使用OpenAI官方商标；本App非OpenAI官方产品。
