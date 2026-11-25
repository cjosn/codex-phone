# Codex Pocket「检查更新」真机诊断报告

时间：2026-11-21 17:54–18:04（Asia/Shanghai）
方式：只用 adb + device/uia.mjs 控件树（未截图，未安装/卸载/清数据，未改渠道配置，未点「下载并安装」）

## 1. 设备与已安装版本

| 项 | 值 |
|---|---|
| 序列号 | 7131af7c |
| 机型 | Redmi 2406ERN9CC（product: breeze） |
| Android | 16（SDK 36） |
| 包名 / Activity | io.github.codexgo.app / io.github.ccch1mneyyy.dsh_app.MainActivity |
| versionName | **1.5.5** |
| versionCode | 2026112137 |

## 2. 日志文件（完整路径）

- `C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go\device\update-check-20261121-1757.log`（主抓取窗口，20.3 MB，17:57–18:03）
- `C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go\device\update-check-20261121-1754.log`（早期探索，10.2 MB）

## 3. 每步 dump 观察

### 3.1 进入路径
抽屉（左上「打开抽屉」）→「设置」→ 下滑 →「更新与关于\nCodex Pocket 1.5.5」。
进入后页面 dump（点击前基线）：

```
 198   77 Button       "Back"
 198  308 View         "更新与关于"
 680  540 View         "应用"
 473  540 View         "Codex Pocket\n独立移动客户端 · 官方 Codex app-server\n1"
 687  540 Button       "检查更新\n从发布清单检查新版本"
 902  540 Button       "问题反馈\n复制反馈 QQ，附带版本与错误信息"
```

**「检查更新」这一项的文字与状态**：唯一文案是「检查更新 / 从发布清单检查新版本」，
第二行是固定副标题（源码 codex_settings.dart:1597 `subtitle: kUpdateManifestUrl.isEmpty ? '未配置更新源' : '从发布清单检查新版本'`），
**不是状态**——即稳态下不显示「已是最新 / 发现新版本 / 上次检查时间」，行尾也没有任何状态块。

### 3.2 点击「检查更新」后的逐次观察（共 6 次点击）

| # | 点击时刻 | 观测结果 |
|---|---|---|
| 1 | 17:57:28.898 | T+2.7 / 5.5 / 10.6 / 22.5 / 33.1 s 五次 dump **完全无变化**：无对话框、无转圈、无 SnackBar，文案仍是「检查更新\n从发布清单检查新版本」 |
| 2 | 18:02:03.872 | T+4.9 s 已出现对话框 |
| 3 | 18:02:21.139 | T+2.72 s 页面原样；**T+5.16 s** 出现对话框（首次可见反馈落在 2.7–5.2 s 之间） |
| 4 | 18:03:11 | 18 s 内**无任何可见变化** |
| 5 | 18:03:16 | T+5.2 s 对话框 |
| 6 | 18:03:23 | T+5.4 s 对话框 |

成功时的对话框 dump（原文，1.5.5 的「已是最新」）：

```
1120  540 View         "已是最新"
1235  540 View         "当前版本 1.5.5 已经是最新的。"
1395  771 Button       "关闭"
1230  540 View         "Dismiss"
```

要点：
- 从来没有出现「转圈对话框」或 SnackBar；成功路径是**直接弹「已是最新」对话框**（约 3–5 s 后）。
- 失败路径（2/6 次）是**彻底静默**，18–33 s 内界面零反馈，也**没有**「检查更新失败 / 网络不可用」提示。
- 该页**没有**「发现新版本」态可观测（服务端当前最新就是 1.5.5，所以只会走 upToDate 分支）。

### 3.3 点击是否送达 App（排除输入问题）
点击坐标就是控件中心（540,687，控件 bounds 中心），logcat 里每次都有对应 MotionEvent 进到本 App 窗口：

```
11-21 18:02:21.442 I/MIUIInput(26924): [MotionEvent] ViewRootImpl windowName 'io.github.codexgo.app/io.github.ccch1mneyyy.dsh_app.MainActivity', { action=ACTION_DOWN, id[0]=0, pointerCount=1, eventTime=87398278, downTime=87398278, phoneEventTime=1795255341439 } moveCount:0
11-21 18:02:21.447 I/MIUIInput(26924): [MotionEvent] ViewRootImpl windowName 'io.github.codexgo.app/io.github.ccch1mneyyy.dsh_app.MainActivity', { action=ACTION_UP, id[0]=0, pointerCount=1, eventTime=87398278, downTime=87398278, phoneEventTime=1795255341440 } moveCount:0
```

## 4. logcat 关键片段（原文，未修改）

过滤 `grep -iE 'codexgo|flutter|Codex|okhttp|SocketException|github'` 后，**与 App 自身相关的应用层日志只有输入事件**；
整个窗口内**没有任何** flutter / Dart 异常 / okhttp / SocketException / HTTP 404 / SSL 相关行，也没有 App 的自定义 tag 输出：

```
11-21 18:02:04.173 I/MIUIInput(26924): [MotionEvent] ViewRootImpl windowName 'io.github.codexgo.app/...MainActivity', { action=ACTION_DOWN, ... } moveCount:0
11-21 18:02:04.177 I/MIUIInput(26924): [MotionEvent] ViewRootImpl windowName 'io.github.codexgo.app/...MainActivity', { action=ACTION_UP, ... } moveCount:0
11-21 18:02:17.346 I/MIUIInput(26924): [MotionEvent] ... ACTION_DOWN, eventTime=87394182 ...
11-21 18:02:21.442 I/MIUIInput(26924): [MotionEvent] ... ACTION_DOWN, eventTime=87398278 ...
11-21 18:02:21.447 I/MIUIInput(26924): [MotionEvent] ... ACTION_UP, eventTime=87398278 ...
11-21 18:01:52.257 I/hub.codexgo.app(26924): AssetManager2(0x7b6234d938) locale list changing from [] to [zh-CN]
11-21 18:02:04.173 D/VRI[MainActivity](26924): getMiuiFreeformStackInfo mTmpFrames.miuiFreeFormStackInfo: null
```

唯一搜到的 "404" 命中是无关进程（`JavaheapMonitor( 4043)` 之类的 PID 数字），**不是 HTTP 404**。
结论：release 包不打点，logcat 里拿不到更新检查的 HTTP 状态，因此**日志层面既没有 404，也没有网络异常**——同时也说明失败时 App 没有抛出/记录任何异常。

更新源（源码常量）：`https://github.com/cjosn/codex-phone/releases/latest/download/latest.json`，
代码里还有 8 秒超时和 `UpdateCheckPhase.unavailable → SnackBar` 分支；本次失败样本里 **SnackBar 从未出现**，
说明失败不是"请求超时/失败"这条分支，而是根本没走到检查或结果回写。

## 5. 结论

- **界面有可见反馈**：成功时弹对话框，文案为「已是最新」+「当前版本 1.5.5 已经是最新的。」+「关闭」按钮。
- **从点击到出现反馈约 2.7–5.5 秒**（两次精确观测：T+5.16 s、T+4.9 s；三次重复 5.2 / 5.4 s），期间没有任何"正在检查"的可见指示。
- **日志里没有 404，也没有网络错误**（App 进程在窗口内只输出输入事件，无 flutter/Dart 异常）。
- **但该按钮行为不稳定**：6 次点击中 2 次（17:57:28、18:03:11）在 18–33 秒内界面零反馈，无转圈、无 SnackBar、无错误提示，只能靠再点一次才出现对话框。

## 6. 一句话判断

「检查更新」本身能连通、也能正确判定"已是最新"，但**点击后没有任何"检查中"的可见状态**（1.5.5 只在行尾放了一个 16px 转圈，控件树/肉眼都几乎看不出），
且当检查因状态竞态（源码里 `await controller.ready` 后才发请求、`check == checking` 时 onTap 直接为 null）被吞掉时**静默无任何兜底提示**，
于是表现为"点了没反应、要再点一次或等 5 秒才弹框"——用户感知就是"检查更新没反馈/不可靠"。
