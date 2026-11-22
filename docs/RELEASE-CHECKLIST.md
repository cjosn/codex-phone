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
| 运行时清单 | `GET https://api.github.com/repos/cjosn/codex-phone/releases/latest` → 找 `runtime-arm64-v8a.json` → `GET .../releases/assets/<id>` | 见 §3 |
| 运行时 tar | 清单里的 `url` 字段 | 必须是 **api.github.com 资产地址**，不能是 github.com |

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

## 3. 发完必做的 4 条自检（缺一条就别宣布成功）

```powershell
$h=@{'User-Agent'='dsh'}
$r=(Invoke-WebRequest 'https://api.github.com/repos/cjosn/codex-phone/releases/latest' -Headers $h -UseBasicParsing).Content|ConvertFrom-Json
$r.tag_name                      # 1) 必须是刚发的 tag
$r.assets | ForEach-Object { $_.name }   # 2) 必须四个：APK / latest.json / runtime-arm64-v8a.json / runtime-arm64-v8a.tar.xz
$r.assets | Where-Object { $_.name -like '*.apk' } | ForEach-Object { $_.digest }  # 3) 必须等于本地 APK 的 sha256
# 4) 运行时清单能被 api 取到，且 url 指向 api 资产
$mid=($r.assets|Where-Object{$_.name -eq 'runtime-arm64-v8a.json'}).id
(Invoke-WebRequest "https://api.github.com/repos/cjosn/codex-phone/releases/assets/$mid" -Headers @{Accept='application/octet-stream';'User-Agent'='dsh'} -UseBasicParsing).Content
```

本地 APK 的 sha256：
```powershell
(Get-FileHash 'dist\Codex-Pocket-1.7.3-arm64.apk' -Algorithm SHA256).Hash.ToLower()
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
| v1.7.3 | 待发（记得带运行时资产） |
