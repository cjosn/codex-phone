import 'dart:convert';

import 'package:http/http.dart' as http;

import 'codex_brand.dart';

// 仓库 id 只在 codex_brand.dart 写一次：之前这里还留着旧 owner（jiajia-0613），
// 于是每次「检查更新」都 404，再退到手机网络里不可达的 github.com 清单——表现就是
// 点了半天没反应，然后弹「检查更新失败」。
const String codexGitHubLatestReleaseUrl = 'https://api.github.com/repos/$kRepoSlug/releases/latest';
const String codexReleasePageUrl = 'https://github.com/$kRepoSlug/releases/latest';

class CodexRelease {
  const CodexRelease({
    required this.version,
    required this.url,
    required this.notes,
    required this.releasePage,
    this.sha256,
    this.sizeMb,
    this.apiAssetUrl,
  });

  final String version;
  final String url;
  final String notes;
  final String? sha256;
  final double? sizeMb;
  final String releasePage;

  /// 通过 api.github.com 的资产接口下载（`github.com` 在部分网络下不可达，
  /// 但 `api.github.com/repos/<o>/<r>/releases/assets/<id>` 往往可用）。
  final String? apiAssetUrl;
}

class CodexUpdateException implements Exception {
  const CodexUpdateException(this.message);

  final String message;

  @override
  String toString() => message;
}

class CodexUpdateChecker {
  CodexUpdateChecker({http.Client? client, this.currentVersion = kAppVersion, this.manifestUrl = kUpdateManifestUrl})
    : _client = client ?? http.Client();

  final http.Client _client;
  final String currentVersion;
  final String manifestUrl;

  Map<String, String> get _headers => {
    'Accept': 'application/json',
    'User-Agent': 'Codex-Pocket-Updater/$currentVersion',
  };

  /// Returns the published release; callers decide whether it is newer.
  /// 先走 api.github.com：`github.com` 在国内网络常被阻断，而 API 域名一般可达。
  /// 两跳都失败时报主路径（API）的原话，别用清单的通用网络错误盖掉真正原因。
  Future<CodexRelease> check() async {
    try {
      return await _checkGitHub();
    } on CodexUpdateException catch (primary) {
      final manifestUri = Uri.tryParse(manifestUrl);
      if (!_isHttps(manifestUri)) throw primary;
      try {
        final response = await _client.get(manifestUri!, headers: _headers).timeout(const Duration(seconds: 8));
        if (response.statusCode != 200) throw primary;
        return _parseManifest(response);
      } catch (_) {
        throw primary;
      }
    }
  }

  Future<CodexRelease> _checkGitHub() async {
    final http.Response response;
    try {
      response = await _client
          .get(Uri.parse(codexGitHubLatestReleaseUrl), headers: _headers)
          .timeout(const Duration(seconds: 12));
    } on Exception {
      throw const CodexUpdateException('无法连接更新服务器，请检查网络后重试。');
    }

    if (response.statusCode == 404) {
      throw const CodexUpdateException('仓库没有公开的最新 Release（或仓库不可访问）；发布更新后即可使用。');
    }
    if (response.statusCode != 200) {
      throw CodexUpdateException('GitHub 更新检查失败（HTTP ${response.statusCode}）。');
    }

    final data = _decodeObject(response.bodyBytes, 'GitHub Release');
    final tag = _requiredString(data, 'tag_name', 'GitHub Release');
    final version = tag.startsWith('v') || tag.startsWith('V') ? tag.substring(1) : tag;
    _validateVersion(version, 'GitHub Release');

    final assets = data['assets'];
    if (assets is! List) {
      throw const CodexUpdateException('GitHub Release 格式不正确：缺少 assets。');
    }
    Map<String, dynamic>? selected;
    for (final value in assets) {
      if (value is! Map) continue;
      final asset = Map<String, dynamic>.from(value);
      final name = asset['name'];
      if (name is String && name.toLowerCase().contains('arm64') && name.toLowerCase().endsWith('.apk')) {
        selected = asset;
        break;
      }
    }
    if (selected == null) {
      throw const CodexUpdateException('最新 Release 中没有找到 arm64 APK 资源。');
    }

    final notes = data['body'];
    if (notes != null && notes is! String) {
      throw const CodexUpdateException('GitHub Release 格式不正确：body 必须是文本。');
    }
    final assetId = selected['id'];
    final apiAssetUrl = assetId is num
        ? '$codexGitHubLatestReleaseUrl'.replaceFirst('/releases/latest', '/releases/assets/$assetId')
        : null;
    final digest = selected['digest'];
    final sha256 = digest is String && digest.startsWith('sha256:') ? digest.substring(7).toLowerCase() : null;
    return _release(
      source: 'GitHub Release',
      version: version,
      url: _requiredString(selected, 'browser_download_url', 'arm64 APK 资源'),
      notes: notes as String? ?? '',
      sha256: sha256,
      apiAssetUrl: apiAssetUrl,
    );
  }

  CodexRelease _parseManifest(http.Response response) {
    final data = _decodeObject(response.bodyBytes, '更新清单');
    final version = _requiredString(data, 'version', '更新清单');
    _validateVersion(version, '更新清单');
    final notes = data['notes'];
    if (notes != null && notes is! String) {
      throw const CodexUpdateException('更新清单格式不正确：notes 必须是文本。');
    }

    final shaValue = data['sha256'];
    if (shaValue != null && (shaValue is! String || !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(shaValue))) {
      throw const CodexUpdateException('更新清单格式不正确：sha256 必须是 64 位十六进制。');
    }
    final sizeValue = data['sizeMb'];
    if (sizeValue != null && (sizeValue is! num || !sizeValue.isFinite || sizeValue <= 0)) {
      throw const CodexUpdateException('更新清单格式不正确：sizeMb 必须是正数。');
    }

    return _release(
      source: '更新清单',
      version: version,
      url: _requiredString(data, 'url', '更新清单'),
      notes: notes as String? ?? '',
      sha256: (shaValue as String?)?.toLowerCase(),
      sizeMb: (sizeValue as num?)?.toDouble(),
    );
  }

  CodexRelease _release({
    required String source,
    required String version,
    required String url,
    required String notes,
    String? sha256,
    double? sizeMb,
    String? apiAssetUrl,
  }) {
    final downloadUri = Uri.tryParse(url);
    if (!_isHttps(downloadUri)) {
      throw CodexUpdateException('$source 的下载地址必须是有效的 HTTPS 地址。');
    }
    return CodexRelease(
      version: version,
      url: url,
      notes: notes,
      sha256: sha256,
      sizeMb: sizeMb,
      releasePage: codexReleasePageUrl,
      apiAssetUrl: apiAssetUrl,
    );
  }

  static Map<String, dynamic> _decodeObject(List<int> bytes, String source) {
    final Object? decoded;
    try {
      decoded = jsonDecode(utf8.decode(bytes));
    } on FormatException {
      throw CodexUpdateException('$source 不是有效的 UTF-8 JSON。');
    }
    if (decoded is! Map) {
      throw CodexUpdateException('$source 格式不正确：顶层必须是 JSON 对象。');
    }
    return Map<String, dynamic>.from(decoded);
  }

  static String _requiredString(Map<String, dynamic> data, String key, String source) {
    final value = data[key];
    if (value is! String || value.trim().isEmpty) {
      throw CodexUpdateException('$source 格式不正确：缺少有效的 $key。');
    }
    return value.trim();
  }

  static void _validateVersion(String version, String source) {
    if (_SemVer.tryParse(version, allowVPrefix: false) == null) {
      throw CodexUpdateException('$source 格式不正确：version 必须是语义化版本号。');
    }
  }

  static bool _isHttps(Uri? uri) => uri != null && uri.scheme.toLowerCase() == 'https' && uri.host.isNotEmpty;
}

/// 最近若干 Release 的列表（不是 `latest`）：运行时清单在某些版本里会漏传。
final String codexReleasesUrl = 'https://api.github.com/repos/$kRepoSlug/releases?per_page=10';

/// 取运行时清单：**不能只看 latest**。
///
/// 历史问题：v1.7.1 发布时用了 `-SkipRuntime`，latest 里没有 `runtime-arm64-v8a.json`，
/// 于是「安装运行时」必然失败。这里改成在最近 [maxReleases] 个 Release 里找**第一个**
/// 带该资产的，只要任意一版传过清单就能装上。
///
/// 返回 null = 这些 Release 里都没有清单（调用方再退回 github.com 直链兜底）；
/// 网络/格式问题抛 [CodexUpdateException]，由调用方决定是否兜底。
Future<Map<String, dynamic>?> fetchRuntimeManifestAsset(
  http.Client client, {
  int maxReleases = 10,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final uri = Uri.parse('$codexReleasesUrl'.replaceFirst('per_page=10', 'per_page=$maxReleases'));
  final http.Response listing;
  try {
    listing = await client.get(uri, headers: const {'accept': 'application/vnd.github+json'}).timeout(timeout);
  } on Exception catch (error) {
    throw CodexUpdateException('无法连接更新服务器：$error');
  }
  if (listing.statusCode != 200) {
    throw CodexUpdateException('运行时清单列表 HTTP ${listing.statusCode}');
  }
  final Object? decoded;
  try {
    decoded = jsonDecode(utf8.decode(listing.bodyBytes));
  } on FormatException {
    throw const CodexUpdateException('Release 列表不是有效的 UTF-8 JSON。');
  }
  if (decoded is! List) throw const CodexUpdateException('Release 列表格式不正确：顶层必须是数组。');

  for (final entry in decoded) {
    if (entry is! Map) continue;
    final assets = entry['assets'];
    if (assets is! List) continue;
    num? assetId;
    for (final asset in assets) {
      if (asset is Map && asset['name'] == 'runtime-arm64-v8a.json' && asset['id'] is num) {
        assetId = asset['id'] as num;
        break;
      }
    }
    if (assetId == null) continue;
    final http.Response manifest;
    try {
      manifest = await client
          .get(
            Uri.parse('https://api.github.com/repos/$kRepoSlug/releases/assets/$assetId'),
            headers: const {'accept': 'application/octet-stream'},
          )
          .timeout(timeout);
    } on Exception catch (error) {
      throw CodexUpdateException('运行时清单下载失败：$error');
    }
    if (manifest.statusCode != 200) {
      throw CodexUpdateException('运行时清单资产 HTTP ${manifest.statusCode}');
    }
    final Object? body;
    try {
      body = jsonDecode(utf8.decode(manifest.bodyBytes));
    } on FormatException {
      throw const CodexUpdateException('运行时清单不是有效的 UTF-8 JSON。');
    }
    if (body is! Map) throw const CodexUpdateException('运行时清单格式不正确：顶层必须是对象。');
    final value = Map<String, dynamic>.from(body);
    final url = value['url'];
    final sha = value['sha256'];
    if (url is! String || url.trim().isEmpty || sha is! String || sha.trim().isEmpty) {
      throw const CodexUpdateException('运行时清单缺 url/sha256。');
    }
    return value;
  }
  return null;
}

/// Compares semantic versions. A leading `v` is accepted for GitHub-style tags.
int compareVersions(String a, String b) {
  final left = _SemVer.tryParse(a, allowVPrefix: true);
  final right = _SemVer.tryParse(b, allowVPrefix: true);
  if (left == null || right == null) {
    throw FormatException('无效的语义化版本号：${left == null ? a : b}');
  }
  for (var i = 0; i < 3; i++) {
    final comparison = left.core[i].compareTo(right.core[i]);
    if (comparison != 0) return comparison;
  }
  if (left.prerelease.isEmpty || right.prerelease.isEmpty) {
    if (left.prerelease.isEmpty && right.prerelease.isEmpty) return 0;
    return left.prerelease.isEmpty ? 1 : -1;
  }
  for (var i = 0; i < left.prerelease.length && i < right.prerelease.length; i++) {
    final aPart = left.prerelease[i];
    final bPart = right.prerelease[i];
    final aNumeric = _numericIdentifier.hasMatch(aPart);
    final bNumeric = _numericIdentifier.hasMatch(bPart);
    if (aNumeric && bNumeric) {
      final comparison = int.parse(aPart).compareTo(int.parse(bPart));
      if (comparison != 0) return comparison;
    } else if (aNumeric != bNumeric) {
      return aNumeric ? -1 : 1;
    } else {
      final comparison = aPart.compareTo(bPart);
      if (comparison != 0) return comparison;
    }
  }
  return left.prerelease.length.compareTo(right.prerelease.length);
}

final RegExp _numericIdentifier = RegExp(r'^[0-9]+$');
final RegExp _semanticVersion = RegExp(
  r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
  r'(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?'
  r'(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$',
);

class _SemVer {
  const _SemVer(this.core, this.prerelease);

  final List<int> core;
  final List<String> prerelease;

  static _SemVer? tryParse(String value, {required bool allowVPrefix}) {
    var normalized = value.trim();
    if (allowVPrefix && normalized.startsWith('v')) {
      normalized = normalized.substring(1);
    }
    final match = _semanticVersion.firstMatch(normalized);
    if (match == null) return null;
    final prerelease = match.group(4)?.split('.') ?? const <String>[];
    for (final identifier in prerelease) {
      if (_numericIdentifier.hasMatch(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
        return null;
      }
    }
    return _SemVer([for (var i = 1; i <= 3; i++) int.parse(match.group(i)!)], prerelease);
  }
}
