# Codex Pocket 手机能力扩展方案（Android 原生通道 + 分级授权）

> 结论先行：**之前「PRoot 不能装 Operit 那套工具」的说法只对了一半**。
> 对的部分：PRoot 里的进程**没有** Android Binder / 应用权限，调不到 a11y、通知、短信、应用管理这些系统 API。
> 错的部分：因此就说「加不了」——正确做法是**在 App 的 Kotlin 侧开一条原生通道**，让 PRoot 里的模型通过本机 HTTP 调过去；
> 权限由用户分级授权，没授权就降级到 PRoot 能做的事。Operit 也是这么做的（它自带 accessibility 服务 + 独立的 UI 自动化 AIDL 模块）。

本文是给实现方的方案与契约，配套文件：`DEVICE-API-CONTRACT.md`（接口形状）。

---

## 1. 能力盘点：哪些真的受系统限制，哪些能靠用户授权拿到

| 能力 | PRoot 里能做吗 | 需要什么 | 实现路径 | 现状 |
|---|---|---|---|---|
| 读写在**允许根**里的文件 | ✅ | 无 | 已有 `files` 包 | 已有 |
| 执行命令 / 脚本（bash、apt 装环境） | ✅（PRoot 内） | 无 | 已有 `dev`/`code` 包 | 已有（`jq` 真机装成功） |
| 网络请求、网页抓取 | ✅ | 无 | 已有 `net`/`web` 包 | 已有 |
| **读屏（UI 层级）/ 点击 / 滑动 / 输入** | ❌ | 无障碍服务（AccessibilityService） | Kotlin 服务 + 本机 API + `android` 包 | 待做（Phase B） |
| 截图 | ❌ | 无障碍 `takeScreenshot`(API 30+) 或 MediaProjection | 同上 | 待做（Phase B） |
| 启动应用 / 列出应用 / 停用应用 | ❌ | 无障碍 `performGlobalAction` 有限；完整要 shell 或 Shizuku | Shizuku 提供 shell UID | 待做（Phase C） |
| 通知读取 / 发送 | ❌ | NotificationListenerService（用户手动授权） | Kotlin 服务 | 待做（Phase C） |
| 剪贴板读写 | ❌（PRoot 无） | 前台时可用 `ClipboardManager`；后台受限制 | Kotlin API | 待做（Phase A） |
| 短信 / 电话 | ❌ | READ_SMS / CALL_PHONE 等危险权限 + 商店政策 | Kotlin API | **不建议做**（政策与隐私风险大） |
| 设备信息（型号/电量/网络/存储） | 部分（`/proc`、`statfs`） | 无 | 已有 `system` 包；原生通道可补电量/网络类型 | 部分已有 |
| 定时任务（App 退出后仍执行） | ❌（进程会被杀） | WorkManager / AlarmManager / 前台服务 | Kotlin | 待做（Phase D） |
| 静默安装 / 卸载 / 改系统设置 | ❌ | Device Owner（设备管理员）或 shell | DevicePolicyManager / Shizuku | 待做（Phase D，风险最高） |
| 后台保活 / 悬浮窗 | ❌ | 前台服务 + SYSTEM_ALERT_WINDOW | Kotlin | 待做（Phase D） |
| 位置 | ❌ | ACCESS_*_LOCATION（危险权限） | Kotlin | 待做（Phase D） |

**一句话**：能靠「用户运行时授权」拿到的，是**无障碍、通知监听、悬浮窗、设备管理员、Shizuku（shell UID）**这五类；
存储/位置/电话/短信属于危险权限，能申请但涉及隐私与商店政策，默认不做（可留开关给自用版本）。

---

## 2. 分级授权模型（照抄 Operit 的交互，术语对齐用户习惯）

用户在「设置 → 手机能力」里看到的四个级别（**默认 STANDARD**，随点随生效，随时可退回）：

| 级别 | 你能得到什么 | 需要用户做什么 | 我们的降级行为 |
|---|---|---|---|
| **STANDARD**（默认） | PRoot 里的一切：文件、命令、apt 装环境、网络、git、子会话、工具包 | 无（安装即用） | — |
| **ACCESSIBILITY** | 读屏 / 点击 / 滑动 / 输入 / 截图 / 启动应用 / 返回主页（= Operit 的「屏幕自动点击」「终端支持」那类） | 系统设置里打开本 App 的无障碍服务（跳转一键直达） | 这些工具返回 `device/permission-denied`，并说明「去设置 → 无障碍里打开 Codex Pocket」 |
| **DEBUGGER** | 上面全部 + **shell UID 命令**（`pm list packages`、`am start`、`settings get/put`、读 `/data/local/tmp`、`run-as`） | 装 Shizuku 并授权本 App（无线调试或 adb 启动），或直接用 adb（本机已连 USB 时可 adb 授权） | 返回 `device/shizuku-unavailable` + 一句「装 Shizuku 或插 USB 用 adb 授权」 |
| **ADMIN** | 上面全部 + Device Owner 能力（静默安装/卸载、锁屏密码策略、禁用相机等） | 需要设备处于「无账号」状态用 `adb shell dpm set-device-owner` 激活，或用户手动授予设备管理员 | 返回 `device/admin-unavailable` |
| **ROOT** | 上面全部 + 真正的 root | 设备已 root 且授予 su | 返回 `device/root-unavailable`；**本机未 root，故 ROOT 档只做探测不做承诺** |

设计原则（和 Operit 一致）：
1. **默认最低档**，用户点哪个档就即时生效，随时可退回标准档。
2. **每一档都写清楚「会多拿到什么」和「去哪授权」**，不偷偷降级、不假装成功。
3. 授权失败/被拒时**只禁用对应工具**，PRoot 能力照常，绝不整体不可用。
4. 第一次进页面前弹**免责声明**（见 §6），点了同意才允许选择更高档位。

---

## 3. 推荐架构（本机 HTTP 设备通道）

```
┌───────────────────────────── App 进程（Kotlin，持有系统权限）─────────────────────────────┐
│  AccessibilityService  ──┐                                                                │
│  NotificationListener  ──┼──▶  DeviceApiServer（127.0.0.1:<随机端口>，Bearer token）        │
│  Shizuku(可选)          ──┤        ├─ GET  /capabilities      当前档位 + 每项可用性         │
│  Clipboard/Battery/...  ──┘        ├─ POST /ui/dump           无障碍：读屏                  │
│                                    ├─ POST /ui/tap|swipe|text 无障碍：操作                  │
│                                    ├─ POST /ui/screenshot      无障碍：截图                  │
│                                    ├─ POST /shell/exec        Shizuku：shell UID 执行        │
│                                    └─ POST /app/list|start    无障碍/Shizuku 可用时          │
└───────────────────────────────────────────▲───────────────────────────────────────────────┘
                                            │ 127.0.0.1（PRoot 与 App 共享网络命名空间）
┌───────────────────────────────────────────┴───────────────────────────────────────────────┐
│  PRoot 里的 MCP 宿主（mcp-server.mjs）→ 新工具包 `android`（ui_dump/ui_tap/ui_text/app_*）  │
│  端口与 token 由 App 写进 ${CODEX_HOME}/codex-go-device.json（0600），宿主启动时读取         │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

为什么走本机 HTTP 而不是 Binder/AIDL：
- PRoot 里的进程**不能**直接调 Binder（没有 binder 驱动访问），但 **127.0.0.1 与 App 同网络命名空间**（现有 bridge 就是 37311 端口，App 能连）。
- HTTP + token 的鉴权模型我们已经在 bridge 上跑熟（同一套 Bearer + `Origin` 校验），学习成本为零。
- 复用现有约定：`POST /api/*`、错误 `{error:{code,message}}`、事件 `type` 字段。

安全边界：
- 只绑 `127.0.0.1`，随机端口，token 每次启动生成，写文件 `0600`，与 bridge token 分开；
- 所有写操作（点击/输入/安装）要求 body 带 `reason`（模型必须说明为什么操作），记进 ring 供用户回看；
- 用户可一键「关闭设备通道」（等于退回 STANDARD），关闭后端口立刻停止监听。

---

## 4. 实施步骤（可分批交付）

**Phase A（本期落地，1.6.1）**
1. Kotlin `DeviceApiServer`：`/capabilities`、`/clipboard`、`/device/info`、`/ui/*` 先返回 501 + `device/permission-denied` 骨架；标准权限状态查询与一键跳转申请（存储/悬浮窗/电池豁免/位置）。
2. Dart「设置 → 手机能力」页：四个档位卡片 + 每项权限状态 + 「去授权」按钮 + 免责声明同意门 + 「立即退回 STANDARD」。
3. MCP 新包 `android`：`device_capabilities`（先探测，再断言）、`device_clipboard_get/set`、`device_info`；其余 `ui_*` 工具先按契约实现，未授权时返回 `device/permission-denied` 并给出可执行提示。
4. App 启动时把 `{port,token}` 写进 `${CODEX_HOME}/codex-go-device.json`，关闭通道时删除。

**Phase B（下一步，最值钱）**
- AccessibilityService：`ui_dump`（可读文本/坐标/可点）、`ui_tap(x,y)`、`ui_click(text|resourceId)`、`ui_swipe`、`ui_input`、`ui_key(back/home/recents)`、`ui_screenshot`（API 30+ `takeScreenshot`）。
- 真机验收用例：打开设置 → 读屏 → 点「WLAN」→ 返回；全程由模型驱动，用户只看结果。

**Phase C（Shizuku）**
- 依赖 `dev.rikka.shizuku:api` + `:provider`（Apache-2.0，商用友好），`Shizuku.requestPermission` + `ShizukuBinderWrapper`；
- 工具：`shell_exec`（shell UID）、`app_list`、`app_start`、`app_force_stop`、`settings_get/put`、`pm_install_local`（需 `REQUEST_INSTALL_PACKAGES`）。

**Phase D（设备管理员 / 后台任务 / 悬浮窗）**
- `DevicePolicyManager` 设备管理员（非 Device Owner 也能做少量事）；Device Owner 需清机或 adb；WorkManager 做定时任务；`SYSTEM_ALERT_WINDOW` 做悬浮球。

---

## 5. 直接接 Operit 现成轮子的可行性

调研结论（GitHub `AAswordman/Operit2`，811★）：

| 项 | 结果 |
|---|---|
| 许可证 | **AGPL-3.0**：把它的代码合进我们项目，整个发行版就要按 AGPL 开源并对网络用户提供源码。**不建议直接拷代码**（除非愿意接受 AGPL）。 |
| 它的做法 | Flutter App + `tools/android-accessibility`（独立模块，AIDL `IUiAutomationProvider`）+ `AccessibilitySetupFlow.kt`；仓库里**没有** Shizuku 依赖（我们截图里看到的 DEBUGGER/ADMIN 是旧版 Operit AI 的 Shizuku 方案）。 |
| 可复用的“轮子” | ①无障碍服务的声明、权限引导流程（自己重写一遍很快，约 200 行）；②它的 UI 自动化 AIDL 契约可作为**接口参考**（我们改用 HTTP，无需 AIDL）；③Shizuku 本身 Apache-2.0，可直接用官方库。 |
| 结论 | **不引入 Operit 源码**，只借鉴交互与接口设计；Shizuku、无障碍服务用官方/自研实现。这样许可证干净、体积只涨几百 KB。 |

如果将来确实要“直接拿它的轮子”：唯一干净的方式是**独立进程 + 独立 APK**（Operit 的 accessibility helper 那样），通过 AIDL/HTTP 通信——这样两边仍是独立作品，AGPL 的传染范围只覆盖那个 helper 包。

---

## 6. 免责声明（App 内展示的原文，用户点「同意」才解锁高权限档）

> **手机能力授权说明**
> Codex Pocket 是一个跑在你自己手机上的本地 Agent。为了让模型能帮你操作手机（读屏、点击、启动应用、执行 shell 命令等），
> App 需要你**主动授予**相应的 Android 权限。请注意：
> 1. 这些权限**只在本机使用**，不会上传到任何服务器；所有操作记录只保存在本机（可随时查看/清空）。
> 2. 授权后，**AI 模型在你要求下可以直接操作你的手机界面与命令**，包括点击、输入、启动/停止应用、执行 shell 命令。
> 模型可能犯错、可能误点、可能执行你不想要的操作。**请自行确认每一步要做什么，重要数据请先备份。**
> 3. 你**随时可以**在「设置 → 手机能力」里退回「标准权限」，或去系统设置关闭无障碍/Shizuku/设备管理员；
> 关闭后相关工具立即失效，App 的业务功能（对话、文件、命令、网络）不受影响。
> 4. 部分能力（短信、电话、精确定位）涉及隐私与商店政策，**默认不提供**；本版本也不会上传通讯录、短信等隐私数据。
> 5. 如果你无法接受以上风险，请保持「标准权限」——App 依旧可以正常对话、读写文件、跑命令。
>
> ［同意并继续］ ［保持标准权限］

---

## 7. 限制说明（必须如实告知用户）

1. **本机未 root**：ROOT 档只能探测，不能承诺可用。
2. **Shizuku 需要用户装第三方 App 并每次重启后重新授权**（无线调试常驻的话不需要重启，但需要保持调试授权）。
3. **无障碍服务的“读屏”只能拿到系统暴露的控件树**：Canvas 自绘界面（游戏、部分 Flutter 页面）拿不到文本，只能是截图 + 坐标。
4. **截图在部分 App/系统上被 FLAG_SECURE 挡住**（本机 `adb screencap` 就是全黑，是这个原因），`ui_screenshot` 也会遇到同样的黑屏。
5. **后台任务**受 Android 电池优化/厂商杀后台影响；只能尽力保活（前台服务 + 电池豁免 + WorkManager），不保证 100%。
6. **Device Owner 需要清机或 adb**，不是所有用户都愿意；不做也能用其他档位。
7. 我们**不会**为了“更聪明”偷偷提权：所有提权都必须由用户在界面上明确点选。
