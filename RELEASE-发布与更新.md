# 发布与更新（cjosn/codex-phone）

## 两个发布物

| 发布物 | 体积 | 何时更新 |
|---|---|---|
| `Codex-Pocket-<ver>-arm64.apk` | 12.5 MB（外置运行时后） | 改代码就发 |
| `runtime-arm64-v8a.tar.xz` | 286 MB | 只在升级 codex/node/rootfs 时发 |
| `latest.json` | 1 KB | 每次发 APK 一起发 |
| `runtime-arm64-v8a.json` | 1 KB | 每次发运行时一起发 |

APK 里的 `kUpdateManifestUrl` 指向：

```
https://github.com/cjosn/codex-phone/releases/latest/download/latest.json
```

GitHub 的 `releases/latest/download/<文件名>` 永远指向**最新一个 Release**，所以清单地址可以固定写死。

## 一次性准备

```powershell
winget install GitHub.cli
gh auth login
```

## 发一个版本（三条命令）

```powershell
cd <你的 codex-go 目录>

# 1) 构建 APK + 生成清单（约 2 分钟）
.\tooling\release.ps1 -Version 0.7.0 -Publish

# 2) 首次或运行时变化时，发运行时（286 MB，慢）
.\tooling\release-runtime.ps1 -Version 0.7.0 -Publish
```

`-Publish` 会用 `gh release create/upload` 推到 `cjosn/codex-phone`。
没装 gh 时脚本会打印手动上传步骤，产物都在 `dist\`。

## 用户侧怎么更新

1. App → 设置 → 更新 → 检查更新
2. 有新版 → 弹「发现新版本 → 去下载」→ 浏览器下载 12.5 MB → 安装
3. 想要全自动：装 [Obtainium](https://github.com/ImranR98/Obtainium)，填
   `https://github.com/cjosn/codex-phone`，之后自动跟更新

## 三条铁律

1. **keystore 不能换**。换签名后老用户装不上，只能卸载重装（数据丢）。当前 keystore 请立即备份。
2. **版本号必须递增**（`0.6.5` → `0.6.6`）。App 用数字逐段比较，同版本不提示。
3. **`latest.json` 里的 version 与 APK 的 `--build-name` 必须一致**，脚本已经保证。

## 运行时外置：当前状态

- [x] 瘦包构建开关：`-PcodexLeanApk=true` → 实测 12.5 MB
- [x] 运行时归档 + sha256 清单脚本
- [x] App 内「检查更新」读 `latest.json` 比对版本、给下载入口
- [ ] **App 内下载运行时并解压**（改 `CodexRuntime.kt`：优先用 `filesDir/runtime/<ver>/`，缺失时下载）
- [ ] 桥 JS 远程热更新（改 bridge 不用发 APK）

第 4 项做完之前，请继续发**完整包**（不带 `-Lean`），否则用户装上打不开。
