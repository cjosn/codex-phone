# android-screen —— 让「桌面端 agent」也能操作手机屏幕

> 桌面上的 DSH / Codex 没有无障碍权限，也没有 Shizuku，所以它**永远**读不到屏幕——
> 你给它多少答案都没用，它缺的是通道，不是知识。
> 这个工具补的就是通道：**只走 adb**，不需要手机上装任何 App、不需要无障碍、不需要 root。

## 为什么之前不行

| 你试的 | 为什么失败 |
|---|---|
| 桌面 agent 直接调 `ui_dump` | 那是手机 App 内部的端点，PC 上没有 |
| 把工具 schema 抄给它 | schema 只是说明书，没接线照样调不通 |
| 让它「看着屏幕点」 | 它没有截屏/读屏通道，看到的只有你的文字描述 |

## 安装（3 步，2 分钟）

1. **手机**：设置 → 开发者选项 → 打开「USB 调试」；想无线就再开「无线调试」，记下配对码和端口。
2. **PC**：装 platform-tools，`adb devices` 能看到设备即可。
   无线：`adb pair 手机IP:配对端口` 然后 `adb connect 手机IP:调试端口`。
3. **跑**：

```bash
node android-screen.mjs dump
```

Windows 上如果 adb 不在 PATH：

```bat
set ADB=C:\platform-tools\adb.exe
node android-screen.mjs dump
```

多设备时：`node android-screen.mjs dump --serial 1a2b3c4d`。

## 命令

| 命令 | 作用 |
|---|---|
| `dump` | 读当前屏，输出带编号的文本（`--json` 出结构化快照，`--detail` 带坐标） |
| `tap 7` | 点第 7 项（用**最近一次** dump 的编号；编号过期会明确报错，不会瞎点） |
| `tap --x 540 --y 300` | 按坐标点（兜底） |
| `type "你好" --submit` | 往当前焦点输入框输入，`--submit` 再回车 |
| `key back\|home\|recents\|notifications` | 系统键 |
| `swipe up\|down\|left\|right` | 滑动 |
| `collect 4 --pages 10` | 从编号 4 的列表开始自动翻页，去重收全部条目 |
| `shot a.png` | 截图 |
| `apps` | 列第三方应用包名 |
| `open com.tencent.mobileqq` | 打开应用或链接 |
| `--mcp` | 以 stdio MCP server 运行（给 agent 直接接） |

输出长这样（模型一眼能读）：

```
屏幕 s1 · 竖屏 · 共 12 项
顶部
[1] 按钮 返回
[3] 文本 文件传输助手
[4] 列表
  [5] 按钮 文件传输助手 · [文件] 方案.md 13.96KB
中部
  [7] 文本 Codex Pocket · 功能缺口 + 过程流方案
底部
[10] 输入框
[11] 按钮 发送
```

## 接进桌面端 DSH / Codex

**方式 A：当命令行工具（最省事）**
在它的 AGENTS.md / 系统提示里写一条：

> 操作手机一律用 `node <path>/android-screen.mjs`：先 `dump` 看编号，再 `tap <编号>`；
> 编号只在本屏有效，动作后必须重新 `dump`。不要用坐标，除非 dump 里找不到目标。

**方式 B：当 MCP server（stdio）**

```toml
# ~/.codex/config.toml 或桌面端对应配置
[mcp_servers.android_screen]
command = "node"
args = ["C:\\tools\\android-screen.mjs", "--mcp"]
```

暴露 9 个工具：`screen` / `tap` / `type` / `scroll` / `key` / `collect` / `apps` / `open` / `shot`。

## 离线自测（没设备也能验）

```bash
node android-screen.mjs dump --xml-file sample.xml
```

`sample.xml` 是 `adb shell uiautomator dump` 的产物，用来验证解析与排版。

## 优点与老实话

**优点**：零依赖、零权限申请、PC/Mac/Linux 通用、PC 上能同时跑多个 agent。

**限制**（真机实测过的坑）：

1. `uiautomator dump` 每次 **0.8–2 秒**，比 App 内无障碍慢；`collect` 翻 10 页约 15 秒。
2. **FLAG_SECURE 页面截图为黑屏**，但 `dump` 仍能读到控件树——所以读屏优先，别先截图。
3. **纯 Canvas / 游戏 / 部分 Flutter 页面**读不到文字，只能 `shot` 截图给能看图的模型。
4. 输入法联想、输入框焦点问题：先 `tap` 那个输入框再 `type`。
5. **敏感页（银行、支付、密码）默认别碰**；这类页面读屏通常为空，看到空就停下来问人。
