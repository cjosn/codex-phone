# Codex Pocket · 「操作屏幕」工具包（可直接落地的实现）

> 你不是缺思路，是缺**能编译通过的那一版**。这里给的是一份完整可跑的 `android-screen` 工具包：
> 读屏 → 编号 → 点按，全部在 PRoot 的 node 侧完成，Kotlin 不需要改一行（intent/notify/handoff 除外，见 §4）。

## 为什么模型「始终写不出来」

因为它每次都在从零算坐标。正确做法要有三样状态，模型自己写往往会漏掉其中两样：

| 必须有的状态 | 漏了会怎样 |
|---|---|
| **快照缓存**（屏幕号 → 元素表 + 时间戳） | 模型点 `[7]` 时不知道指的是哪一屏，只能猜坐标 |
| **编号 → bounds 中心** 的映射 | 直接让模型输出 x,y，它会算错、会点偏 |
| **过期检查**（30 秒） | 用上一屏的编号去点新屏，点到别的东西 |
| **动作后强制重新读屏** | 模型以为成功，实际没动，后面全错 |

这一包把这四件事都写进代码里了，模型的职责只剩「看文字、挑编号」。

## 1. 装（3 步）

```bash
# 1) 复制整个目录
cp -r bridge/toolpacks/android-screen $CODEX_HOME/../bridge/toolpacks/     # 或你项目里的 bridge/toolpacks/

# 2) 在 mcp-server.mjs 的包列表里加一项（按你的 TOOLPACKS-CONTRACT 四段式）
#    import { toolpack as androidScreen } from './toolpacks/android-screen/index.mjs';
#    const PACKS = [ ..., androidScreen ];

# 3) 验证：不接设备也能跑格式化
node -e "import('./bridge/toolpacks/android-screen/index.mjs').then(m=>console.log(Object.keys(m)))"
# 期望： [ 'tools', 'handlers', 'formatScreen', 'toolpack' ]
```

## 2. 13 个工具

| 工具 | 依赖端点 | 说明 |
|---|---|---|
| `screen` | `GET /capabilities` + `POST /ui/dump` | 输出带编号的一屏文字；`image:true` 附带截图 |
| `tap` | `POST /ui/tap` | 按编号点，用快照里的 bounds 算中心 |
| `type` | `POST /ui/text` | 先校验目标确实是输入框 |
| `scroll` | `POST /ui/swipe` | 按方向滑，坐标按屏幕比例算 |
| `key` | `POST /ui/key` | back / home / recents |
| `tap_xy` | `/ui/tap` `/ui/swipe` | 只有拿过截图才能用坐标 |
| `collect` | `/ui/dump` + `/ui/swipe` | 翻页收列表、按文字去重 |
| `apps` / `open` | `GET /app/list`、`POST /app/start` | **端点你早就有了，只是没暴露** |
| `shot` | `POST /ui/screenshot` | 返回 base64，可另存 |
| `clipboard` | `GET/POST /clipboard` | |
| `android_shell` | `POST /shell/exec` | 需 Shizuku |
| `device_status` | `GET /capabilities` | 动手前先看档位，别猜 |

**没有新增任何 Kotlin 端点**——全部走你 1.6.1 已经真机验证过的那 6 个。

## 3. 和现有 `android` 包共存

你现在有 `ui_dump` / `ui_tap` / `ui_swipe` / `ui_input` / `ui_key`。两条路：

- **保守**：两个包并存，旧工具保留，新包叫 `android-screen`。模型会优先用名字更明确的 `screen`/`tap`。
- **干净**：把旧 `android` 包里的 5 个 `ui_*` 删掉，只留 `device_*` / `clipboard` / `shell_exec`，其余交给新包。推荐这条——两套并存会让模型犹豫。

## 4. 还差的三个（要动 App，各约 60 行）

这两个端点你契约里没有，但工具描述里我按「有就用」写了：

```kotlin
// DeviceApiServer 里加两个 handler
"POST /notify" -> {
    val j = body.getJSONObject()
    val nm = getSystemService(NotificationManager::class.java)
    val n = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat)
        .setContentTitle(j.getString("title"))
        .setContentText(j.getString("text"))
        .setAutoCancel(true).build()
    nm.notify(++notifySeq, n)
    ok(JSONObject().put("shown", true))
}

"POST /intent" -> {
    val j = body.getJSONObject()
    val i = when (j.getString("kind")) {
        "dial"    -> Intent(Intent.ACTION_DIAL, Uri.parse("tel:${j.getString("number")}"))
        "sms_draft" -> Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${j.optString("number")}")).putExtra("sms_body", j.optString("text"))
        "share"   -> Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, j.optString("text"))
        "settings"-> Intent(Settings.ACTION_SETTINGS)
        "alarm"   -> Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, j.getInt("hour"))
                        .putExtra(AlarmClock.EXTRA_MINUTES, j.getInt("minute"))
        "timer"   -> Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, j.getInt("seconds"))
        else      -> throw DeviceError("args/invalid", "不支持的 kind")
    }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    startActivity(i)
    ok(JSONObject().put("started", true))
}
```

`handoff`（把手机交回给人）需要 App 侧阻塞：Flutter 弹一个「继续 / 停止」的对话框，桥这边等 promise 或轮询 `/handoff/status`。这个先别做——先把 `screen` 跑顺，`handoff` 是锦上添花。

## 5. 验收（真机 5 分钟）

1. 让模型「打开微信，给文件传输助手发一句 hi」，看它是否：`screen` → `open 微信` → `screen` → `tap 输入框` → `type "hi"` → `tap 发送` → `screen` 确认。
2. `tap` 用一个过期的屏幕号 → 必须报「快照已过期」，不能瞎点。
3. `collect` 一次把 30 条列表收全。
4. 密码页：`screen` 只出「密码框」，`type` 被拒并提示 handoff。
5. `apps` / `open` 能真的打开一个应用（这两个之前只是端点，没工具）。

## 6. 给模型的提示词（贴进人设或 developerInstructions）

```
操作手机屏幕的规矩：
1. 先用 screen 读屏，拿到带编号的元素列表；编号只在本屏有效。
2. 用 tap <编号> / type / scroll 操作，不要自己算坐标。
3. 每次动作后必须重新 screen，用新编号继续；旧编号会报过期。
4. 列表内容多时用 collect 一次收完，不要反复 screen。
5. 遇到密码、验证码、支付页：停下来让用户自己操作（handoff），不要猜。
6. 读不到文字（游戏、自绘界面）时用 screen {image:true} 截图，让能看图的模型判断。
```
