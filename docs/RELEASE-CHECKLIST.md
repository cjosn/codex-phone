# 发布须知（给发版的人 / Agent）

> 目标：任何人发版都**不会把自动更新和运行时安装搞坏**。
> 仓库：`cjosn/codex-phone`（public）。**owner 是 `cjosn`，不是 `jiajia-0613`**（历史上写错过，会导致 404）。

---

## 1. 这些地址是**编译进 App 的常量**，不要改

`app/lib/codex/codex_brand.dart`

```dart
const String kRepoSlug = 'cjosn/codex-phone';
const String kUpdateManifestUrl = 'https://github.com/$kRepoSlug/releases/latest/download/latest.json';
const String kRuntimeBaseUrl   = 'https://github.com/$kRepoSlug/releases/latest/download';
```

App 实际使用的**网络地址**（手机端只能稳定访问 `api.github.com`）：

| 用途 | URL | 备注 |
|---|---|---|
| 检查更新 | `GET https://api.github.com/repos/cjosn/codex-phone/releases/latest` | 读 `tag_name` 与 `assets[].digest` |
| 下载 APK | `GET https://api.github.com/repos/cjosn/codex-phone/releases/assets/<apkAssetId>` | 必须带 `Accept: application/octet-stream` |
| 运行时清单 | `GET https://api.github.com/repos/cjosn/codex-phone/releases?per_page=10` → 在**最近若干 Release**里找第一个带 `runtime-arm64-v8a.json` 的 → `GET .../releases/assets/<id>` | 见 §3；**不只看 latest**（1.7.1/1.7.5 都漏过运行时） |
| 运行时 tar | 清单里的 `url` 字段 | 必须是 **api.github.com 资产地址**，不能是 github.com；可以指向**其它 Release 里**的资产 id |

`latest.json` 结构（App 读它做兜底）：

```json
{ "version": "1.7.3", "url": "https://github.com/cjosn/codex-phone/releases/download/v1.7.3/Codex-Pocket-1.7.3-arm64.apk",
  "sha256": "<APK 的 sha256>", "sizeMb": 299.0, "notes": "更新说明", "builtAt": "2026-11-22T13:00:00" }
```

---

## 2. 发布命令（唯一推荐路径）

```powershell
cd C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go
Set-ExecutionPolicy -Scope Process Bypass -Force
. .\tooling\env.ps1

# 1) 构建（versionName/versionCode 必须比线上更大；MIUI 不允许降级安装）
cd dshgo-fork\dsh-Go-main\app
flutter build apk --release --flavor arm64 --target-platform android-arm64 `
  --build-name 1.7.3 --build-number 2026112700 --dart-define=APP_VERSION=1.7.3

# 2) 拷到 dist/（脚本按这个名字找 APK）
cd ..\..\..
Copy-Item 'dshgo-fork\dsh-Go-main\app\build\app\outputs\flutter-apk\app-arm64-release.apk' `
  'dist\Codex-Pocket-1.7.3-arm64.apk' -Force

# 3) 发布（脚本会自动上传 APK + latest.json + 运行时 tar + 运行时清单）
$env:GITHUB_TOKEN = '<classic token，勾 repo>'
.\tooling\publish-release.ps1 -Repo cjosn/codex-phone -Version 1.7.3 `
  -Notes "1.7.3：<一句话说明>"
Remove-Item Env:GITHUB_TOKEN
```

要点：

- **不要加 `-SkipRuntime`**：运行时资产必须随 Release 发布，否则瘦包「安装运行时」会报
  `最新 Release 里没有 runtime-arm64-v8a.json`（1.7.1 就踩过这个坑）。
- 脚本会：上传 APK → 上传 latest.json（**无 BOM**）→ 上传 `runtime-arm64-v8a.tar.xz` →
  回读资产 id → 生成 `runtime-arm64-v8a.json`（`url` 用 api 资产地址）→ 上传。
- 若 `dist/runtime-arm64-v8a.tar.xz` 不存在（比如换了构建机），先同步：见 `tooling/build-codex-runtime.py`。
- 只补运行时资产（某次发布漏了）：
  ```powershell
  $env:GITHUB_TOKEN='…'; $env:RELEASE_TAG='v1.7.3'; python tooling\upload-runtime-assets.py
  ```

---

## 3. 发完必做的自检（脚本已自动化，这里说明判据）

`publish-release.ps1` 现在**自己就做这几条**，任何一条不过会在最后抛错并列出失败项：

1. `releases/latest` 的 `tag_name` 等于刚发的版本。
2. latest 里有 arm64 APK 与 `latest.json`。
3. APK 的 `digest` 等于本地 APK 的 `sha256`。
4. `latest.json` 里的 `version` / `sha256` 与本次发布一致。
5. 运行时清单存在，且清单里的 `url` 能按 `Accept: application/octet-stream` 取到（HTTP 200/206），
   `sha256` 与本地 `dist/runtime-arm64-v8a.tar.xz` 一致。

> **注意资产可以跨 Release 复用**：运行时 286MB，两版 App 之间往往根本没变。
> `upload-runtime-curl.ps1` 会先在最近 30 个 Release 里找 `sha256` 相同的既有 tar 资产，
> 找到就直接复用它的 `asset id`（清单 url 指向它），**不再重复上传**。
> 所以「四个资产」不是硬指标——真正的不变量是：**清单存在 + 清单指向的资产可下载 + sha256 一致**。

手工核对（不想跑脚本时）：

```powershell
$h=@{'User-Agent'='dsh'}
$r=(Invoke-WebRequest 'https://api.github.com/repos/cjosn/codex-phone/releases/latest' -Headers $h -UseBasicParsing).Content|ConvertFrom-Json
$r.tag_name
$r.assets | ForEach-Object { "$($_.name) $($_.size) $($_.digest)" }
(Get-FileHash 'dist\Codex-Pocket-<版本>-arm64.apk' -Algorithm SHA256).Hash.ToLower()
```

只补运行时资产（某次发布漏了，或想给旧 tag 补）：

```powershell
$env:GITHUB_TOKEN='…'; Set-ExecutionPolicy -Scope Process Bypass -Force
.\tooling\upload-runtime-curl.ps1 -Tag v1.7.6      # 优先复用，找不到才上传，带重试
# 旧脚本（Python，遇到 286MB 可能 ssl.SSLEOFError）：
$env:RELEASE_TAG='v1.7.6'; python tooling\upload-runtime-assets.py
```

---

## 4. 不能破的硬约束

1. **`latest.json` 不能带 BOM**（App 的 `jsonDecode` 不认 `\uFEFF`，会变成「检查更新失败」）；脚本已处理。
2. **`.ps1` 必须存成 UTF-8 with BOM**（PowerShell 5.1 读无 BOM 的中文脚本会乱码/解析失败）。
3. **APK 里不能有密钥**：发布前扫一遍 `sk-` / `ghp_` / `CODEX_GO_CHANNEL_`，只允许出现在注释或测试假值。
4. **`versionCode` 必须单调递增**：手机上装高版本后，MIUI 会拒绝降级安装（`INSTALL_FAILED_VERSION_DOWNGRADE`）。
5. **不要改 `kRepoSlug`**；改了就同时改 App 内容、`latest.json` 地址与运行时清单地址三处，否则更新链断。
6. **github.com 不能作为手机端的下载地址**（那台网络到 github.com 会超时）：资产一律走 `api.github.com/repos/<o>/<r>/releases/assets/<id>` + `Accept: application/octet-stream`。

---

## 5. 版本历史（便于对齐）

| 版本 | 说明 |
|---|---|
| v1.5.0 / 1.5.3 / 1.5.4 / 1.5.5 | 早期版本 |
| v1.6.2 / 1.6.3 | 权限向导 + 8 条系统权限 + 4 个真 bug；应用内更新端到端验证 |
| v1.6.4 | 运行时清单/更新统一走 `api.github.com`（github.com 不可达时不再超时） |
| v1.7.1 | 另一会话发布；**漏带运行时资产** → 已被补传（tar `777931886`，清单 `777934335`） |
| v1.7.5 | MCP 工具真派发（namespace 还原）、统一过程流、会话移出 rootfs；运行时**复用** 1.7.1 的 tar 资产 |
| v1.7.6 | 「重置运行时（保留会话）」按钮；运行时清单改为在最近 10 个 Release 里找；发布脚本自带自检 |
