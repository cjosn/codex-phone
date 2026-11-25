/// 品牌只在这里改：App 标题、侧栏、关于页都读它。
///
/// 启动器上显示的名字在 `app/android/gradle.properties` 的 `dshAppName`；
/// 两处保持一致即可（Dart 侧管界面文案，Gradle 侧管安装包标签）。
library;

const String kBrandName = 'Codex Pocket';

/// App 版本（与构建时的 --build-name 保持一致）。
const String kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: 'dev');

/// 空状态/侧栏里那行小字，可以写你自己的署名。
const String kBrandOwner = '本机 Codex';

/// 侧栏底部那句说明。
const String kBrandTagline = 'PRoot 里的真 Codex';

/// 发布仓库（唯一事实来源）：更新检查与下载地址都由它拼出来，别再各处手写 id。
const String kRepoSlug = 'cjosn/codex-phone';

/// 更新源清单地址：放一个 latest.json，App 自己比对版本。
/// 留空 = 不检查更新（设置页里会显示"未配置"）。
/// 例：https://你的域名/codex-pocket/latest.json
const String kUpdateManifestUrl = 'https://github.com/$kRepoSlug/releases/latest/download/latest.json';

/// 运行时（rootfs）单独下载用的基地址；APK 里不再打包 286MB 运行时。
const String kRuntimeBaseUrl = 'https://github.com/$kRepoSlug/releases/latest/download';
