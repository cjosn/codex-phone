# Device API 契约（App 原生通道 ↔ PRoot 里的 MCP 工具）

> 目的：让跑在 PRoot 里的模型能调用 Android 原生能力。App（Kotlin）在 `127.0.0.1` 上开一个 HTTP 服务，
> MCP 宿主从 `${CODEX_HOME}/codex-go-device.json` 读 `{baseUrl, token}` 后以 Bearer 鉴权调用。
> **权限分级**：`standard`（默认，仅 PRoot）/ `accessibility` / `debugger`(Shizuku) / `admin` / `root`。
> 未授权的能力一律返回 `501` + `device/permission-denied`（或更具体的码），**不允许假装成功**。

## 0. 握手文件

`${CODEX_HOME}/codex-go-device.json`（模式 0600，App 启动/开启通道时写，关闭通道时删除）：

```json
{
  "baseUrl": "http://127.0.0.1:38211",
  "token": "<每次启动随机生成，与 bridge token 不同>",
  "tier": "standard",
  "granted": ["accessibility"],
  "version": "1.6.1",
  "pid": 12345,
  "startedAt": 1795267900000
}
```

- 工具侧**每次调用前读一次**文件（不要缓存整场会话）：用户可能随时退回标准档。
- 文件不存在 → 工具报 `device/unavailable`，消息里写「App 的设备通道没开，去 设置 → 手机能力 打开」。

## 1. 通用约定

- 所有请求 `Authorization: Bearer <token>`；`Content-Type: application/json`。
- 成功：`200` + 业务对象（不额外包 `ok`）。
- 失败：HTTP `4xx/5xx` + `{"error":{"code":"<area>/<kebab>","message":"<english, actionable>"}}`。
- 错误码词表（与 MCP 宿主同口径）：
  `device/unavailable`、`device/permission-denied`、`device/shizuku-unavailable`、`device/admin-unavailable`、
  `device/root-unavailable`、`device/unsupported`、`device/timeout`、`device/screenshot-blocked`、`args/invalid`。
- 时间单位：毫秒；坐标：屏幕物理像素（`x,y`，左上原点）。
- 每个**有副作用**的请求（`/ui/tap|swipe|text|key`、`/shell/exec`、`/app/*`）必须带 `reason`（字符串，≥4 字符），
  App 把它写进本机审计环（供用户在界面上回看）。

## 2. 端点

### `GET /capabilities`
返回当前档位与每项能力的真实可用性（工具应先调它再断言，不要猜）。

```json
{
  "tier": "accessibility",
  "tiers": {"standard": true, "accessibility": true, "debugger": false, "admin": false, "root": false},
  "granted": ["accessibility", "storage", "overlay", "battery"],
  "denied": [{"capability": "shizuku", "hint": "Install Shizuku and authorize Codex Pocket"}],
  "capabilities": {
    "ui_dump": true, "ui_tap": true, "ui_text": true, "ui_key": true, "ui_screenshot": true,
    "clipboard": true, "device_info": true, "app_list": false, "shell": false,
    "notifications": false, "background_tasks": false
  },
  "device": {"model": "2406ERN9CC", "brand": "Redmi", "sdk": 36, "androidRelease": "16"},
  "permissions": {"storage": "granted", "overlay": "granted", "batteryOptimization": "ignored", "location": "granted", "accessibility": "enabled", "shizuku": "not-installed", "admin": "not-granted"}
}
```

### `POST /ui/dump` → 无障碍读屏
请求：`{"includeInvisible":false,"maxNodes":1500}`
成功：`{"nodes":[{"index":0,"className":"android.widget.TextView","text":"WLAN","desc":null,"resourceId":"android:id/title","bounds":[40,120,300,180],"clickable":true,"enabled":true,"focused":false,"depth":4}],"screens":[{"width":1080,"height":2460}],"truncated":false}`
失败：`device/permission-denied`（无障碍未开）。

### `POST /ui/tap` → 点击
请求：`{"x":540,"y":300,"reason":"user asked to open WLAN"}` 或 `{"text":"WLAN","reason":"..."}`（二选一；text 模式在内部先 dump 再找可点祖先）
成功：`{"ok":true,"target":{"x":540,"y":300,"matchedText":"WLAN"}}`

### `POST /ui/swipe` → 滑动
请求：`{"fromX":540,"fromY":1800,"toX":540,"toY":600,"durationMs":300,"reason":"..."}`

### `POST /ui/text` → 输入
请求：`{"text":"hello","reason":"...","submit":false}`（写入当前焦点输入框；`submit:true` 回车）

### `POST /ui/key` → 按键
请求：`{"key":"back|home|recents|enter|del","reason":"..."}`

### `POST /ui/screenshot` → 截图
请求：`{"maxWidth":1080}`
成功：`{"png_base64":"...","width":1080,"height":2400,"bytes":123456}`
失败：`device/screenshot-blocked`（FLAG_SECURE 或系统拒绝）。

### `GET /clipboard` / `POST /clipboard`
请求：`{"text":"..."}`；返回 `{"text":"..."}`。后台读取可能失败 → `device/permission-denied`。

### `GET /device/info`
`{"model","brand","manufacturer","sdk","androidRelease","battery":{"percent":77,"charging":false},"network":{"type":"5G","connected":true},"storage":{"totalBytes":123,"freeBytes":45},"app":{"versionName":"1.6.1","versionCode":2026112220}}`

### `GET /app/list` / `POST /app/start` / `POST /app/stop`
- `GET /app/list?includeSystem=false` → `{"apps":[{"packageName":"com.android.settings","label":"设置","system":true,"enabled":true}]}`
- `POST /app/start {"package":"com.android.settings","reason":"..."}` → `{"started":true}`
- `POST /app/stop {"package":"...","reason":"..."}` → 需要 Shizuku（`am force-stop`）
未授权：`device/permission-denied`（无无障碍也无 Shizuku）或 `device/shizuku-unavailable`。

### `POST /shell/exec` → Shizuku（shell UID）执行
请求：`{"command":"pm list packages -3","timeoutMs":20000,"reason":"..."}`
成功：`{"exitCode":0,"stdout":"...","stderr":"","truncated":false,"uid":2000}`
失败：`device/shizuku-unavailable`（未装/未授权）、`device/timeout`。

### `POST /notifications/recent`（Phase C）
`{"limit":20}` → `{"items":[{"package":"...","title":"...","text":"...","postedAt":179...}]}`；未授权 `device/permission-denied`。

## 3. 与 MCP 工具的映射

| MCP 工具（`android` 包） | 调用 | 无权限时的返回 |
|---|---|---|
| `device_capabilities` | `GET /capabilities` | 文件不存在 → `device/unavailable` |
| `ui_dump` | `POST /ui/dump` | `device/permission-denied` |
| `ui_tap` / `ui_click_text` | `POST /ui/tap` | `device/permission-denied` |
| `ui_swipe` / `ui_input` / `ui_key` | 对应端点 | `device/permission-denied` |
| `ui_screenshot` | `POST /ui/screenshot` | `device/screenshot-blocked` / `permission-denied` |
| `device_info` / `device_clipboard_*` | `GET /device/info`、`/clipboard` | `device/unavailable` |
| `app_list` / `app_start` | `/app/*` | `device/permission-denied` |
| `shell_exec` | `/shell/exec` | `device/shizuku-unavailable` |

MCP 侧返回统一走宿主封装：成功 `{ok:true,data}`、失败 `{ok:false,error:{code,message}}`；
错误 message 必须**可执行**（例如「Grant Accessibility for Codex Pocket in Settings → Accessibility」）。
