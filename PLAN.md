# 当前实施目标：真正 Codex App

用户已明确纠正：复用 dsh-go 有用的移动端轮子，不能把 DSH 引擎和页面改名就当作 Codex。界面以用户浅色 Codex Pocket Demo 为准。

当前主线：

1. 官方 `codex app-server` 0.170.0 与真实 schema；桥接 JSON-RPC 为移动端HTTP/SSE，默认绝非fake。
2. 独立 `CodexPocketApp`：浅米白背景、浅灰侧栏、新建任务/最近/工作区/会话、底部输入区和黑色发送按钮；手机抽屉/平板双栏。
3. 独立 Android Codex 前台服务和 runtime 安装；只复用 PRoot/解包/保活/日志等组件。
4. runtime 删除 DSH 引擎和旧 profile/user home，安装官方Linux ARM64 Codex与新bridge/WebUI。
5. 先电脑真实Codex后端联调、Flutter/WebUI渲染、APK构建，之后USB测试新包，保留原版。

之前的 DSH headless/Web/provider/PI_AI_ERROR/purge 测试仅为已否定旧路线记录，不作为当前验收依据。当前尚不能宣称真实Codex ARM64/保活/模型登录均验证通过，最终以新链路的实际结果更新。
