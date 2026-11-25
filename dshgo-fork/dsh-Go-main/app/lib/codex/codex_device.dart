import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'codex_pocket_state.dart';
import 'codex_ui_kit.dart';

/// 原生设备通道（Kotlin `codex/CodexDevicePlugin.kt`）。方法名两边必须一字不差。
const MethodChannel kCodexDeviceChannel = MethodChannel('codex/device');

/// 一次「手机能力」状态快照：档位、通道开关、每项能力与权限的真实可用性。
///
/// 全部以原生回答为准；原生不可用（非 Android、通道没起）时用
/// [CodexDeviceSnapshot.unavailable] 表示，界面如实显示，不做本地猜测。
class CodexDeviceSnapshot {
  const CodexDeviceSnapshot({
    this.enabled = false,
    this.baseUrl,
    this.tier = 'standard',
    this.consent = false,
    this.capabilities = const {},
    this.permissions = const {},
    this.tiers = const {},
    this.audit = const [],
    this.handshake,
    this.unavailable,
  });

  factory CodexDeviceSnapshot.fromMap(Map<String, dynamic> map) => CodexDeviceSnapshot(
    enabled: map['enabled'] == true,
    baseUrl: map['baseUrl'] as String?,
    tier: (map['tier'] as String?) ?? 'standard',
    consent: map['consent'] == true,
    capabilities: _boolMap(map['capabilities']),
    permissions: _stringMap(map['permissions']),
    tiers: _boolMap(map['tiers']),
    audit: _mapList(map['audit']),
    handshake: map['handshake'] as String?,
  );

  factory CodexDeviceSnapshot.unavailable(String message) => CodexDeviceSnapshot(unavailable: message);

  final bool enabled;
  final String? baseUrl;
  final String tier;
  final bool consent;
  final Map<String, bool> capabilities;
  final Map<String, String> permissions;
  final Map<String, bool> tiers;
  final List<Map<String, dynamic>> audit;
  final String? handshake;

  /// 非空 = 原生通道没有回答（页面只显示原因和免责声明，不假装开启成功）。
  final String? unavailable;

  /// 某项权限当下的状态词（`granted` / `denied` / `enabled` / `ignored` … 见原生契约）。
  String permission(String id) => permissions[id] ?? 'unknown';
}

Map<String, bool> _boolMap(Object? value) => {
  if (value is Map)
    for (final entry in value.entries) entry.key.toString(): entry.value == true,
};

Map<String, String> _stringMap(Object? value) => {
  if (value is Map)
    for (final entry in value.entries) entry.key.toString(): entry.value?.toString() ?? '',
};

List<Map<String, dynamic>> _mapList(Object? value) => [
  if (value is List)
    for (final entry in value)
      if (entry is Map) entry.map((key, item) => MapEntry(key.toString(), item)),
];

/// 一次「去授权」的原生回答：`{status, canOpen, opened}`。
///
/// - [status] 是跳转那一刻的真实状态（`granted` / `denied` / `enabled` / `optimized` …）；
/// - [canOpen] = 这版系统有没有这个入口（例如 Android 11 以下没有「所有文件访问」页）；
/// - [opened] = 这次跳转/系统对话框是否真的发生了。
///
/// [opened] 为 false 时页面必须明说「本机不支持，去系统设置手动找」，不能装成功。
class CodexPermissionResult {
  const CodexPermissionResult({
    required this.target,
    this.status = 'unknown',
    this.canOpen = true,
    this.opened = false,
  });

  factory CodexPermissionResult.fromNative(String target, Object? value) {
    if (value is Map) {
      return CodexPermissionResult(
        target: (value['target'] ?? target).toString(),
        status: (value['status'] ?? 'unknown').toString(),
        canOpen: value['canOpen'] != false,
        opened: value['opened'] == true,
      );
    }
    // 老版本原生只回 bool：true = 跳过去了。
    final opened = value == true;
    return CodexPermissionResult(target: target, canOpen: opened, opened: opened);
  }

  final String target;
  final String status;
  final bool canOpen;
  final bool opened;

  /// 用户还能不能自救：系统没给这个页面时，让他自己去设置里手动找。
  String get failureHint => canOpen
      ? '系统没有接受这次跳转，请手动进入 设置 → 应用 → Codex Pocket → 权限 里找。'
      : '本机不支持这个系统页面，去系统设置里手动找：设置 → 应用 → Codex Pocket → 权限。';
}

/// 「手机能力」页与首次启动向导和原生之间唯一的入口。
class CodexDeviceChannel {
  CodexDeviceChannel({MethodChannel? channel}) : _channel = channel ?? kCodexDeviceChannel;

  final MethodChannel _channel;

  Future<CodexDeviceSnapshot> status() => _snapshot('status');

  Future<CodexDeviceSnapshot> enable() => _snapshot('enable');

  /// 关闭设备通道：停端口 + 删握手文件 + 档位回 standard（原生一次做完）。
  Future<CodexDeviceSnapshot> disable() => _snapshot('disable');

  Future<CodexDeviceSnapshot> setTier(String tier) => _snapshot('setTier', {'tier': tier});

  Future<CodexDeviceSnapshot> acceptConsent() => _snapshot('acceptConsent');

  /// 跳系统设置页 / 弹系统权限对话框；跳不动时 `opened=false`，页面给文字指引。
  Future<CodexPermissionResult> openSettings(String target) async {
    try {
      final value = await _channel.invokeMethod<Object>('openSettings', {'target': target});
      return CodexPermissionResult.fromNative(target, value);
    } on PlatformException {
      return CodexPermissionResult(target: target, opened: false);
    } on MissingPluginException {
      return CodexPermissionResult(target: target, canOpen: false);
    }
  }

  Future<CodexDeviceSnapshot> _snapshot(String method, [Map<String, Object?>? arguments]) async {
    try {
      final value = await _channel.invokeMethod<Map<Object?, Object?>>(method, arguments);
      return CodexDeviceSnapshot.fromMap(value?.map((key, item) => MapEntry(key.toString(), item)) ?? const {});
    } on PlatformException catch (error) {
      return CodexDeviceSnapshot.unavailable(error.message ?? error.code);
    } on MissingPluginException {
      return CodexDeviceSnapshot.unavailable('当前平台没有设备通道（只有 Android App 里有）');
    }
  }
}

/// 设备通道的「上次是开着的」标记。
///
/// 为什么要有：通道是 App 进程内的服务，**每次重启/更新都会变成关闭**，
/// 而模型那边只会得到 `device/unavailable`，用户完全不知道发生了什么（真机复现：
/// 新建会话让它读屏，模型回「看不到你的屏幕」）。这里记住用户的开关意图，启动时自动恢复；
/// 恢复不了（比如无障碍被系统清了）就在首页给一条明确的提示，而不是让模型背锅。
class CodexDeviceChannelPrefs {
  static const String enabledKey = 'codex.device.channelEnabled';

  static Future<bool> enabled() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(enabledKey) == true;
    } catch (_) {
      return false;
    }
  }

  static Future<void> markEnabled(bool value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(enabledKey, value);
    } catch (_) {}
  }
}

/// 首次启动授权向导「看过了没有」。
///
/// 谁置位：向导里点「保持标准权限」或「完成设置」；谁清除：设置 → 手机能力 →「重新运行向导」。
/// 清不掉只会让下次启动再弹一次向导，不影响任何功能。
class CodexPermissionsIntro {
  static const String seenKey = 'codex.permissionsIntroSeen';

  static Future<bool> seen() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(seenKey) == true;
    } catch (_) {
      // 读不到本地存储时按「没看过」处理：宁可多弹一次向导，也别悄悄跳过授权说明。
      return false;
    }
  }

  static Future<void> markSeen() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(seenKey, true);
    } catch (_) {}
  }

  static Future<void> reset() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(seenKey);
    } catch (_) {}
  }
}

/// 一个档位卡片要写的三段话（方案 §2 的「多拿到什么 / 需要什么」）。
class _TierCardInfo {
  const _TierCardInfo(this.id, this.title, this.gains, this.needs);
  final String id;
  final String title;
  final String gains;
  final String needs;
}

const List<_TierCardInfo> _tierCards = [
  _TierCardInfo('standard', 'STANDARD · 标准权限', 'PRoot 里的一切：文件、命令、apt 装环境、网络、git、子会话、工具包', '无需授权（安装即用）'),
  _TierCardInfo(
    'accessibility',
    'ACCESSIBILITY · 无障碍',
    '读屏 / 点击 / 滑动 / 输入 / 截图 / 启动应用 / 返回主页',
    '在系统设置里打开 Codex Pocket 的无障碍服务',
  ),
  _TierCardInfo(
    'debugger',
    'DEBUGGER · shell UID',
    '以上全部 + 受限 shell 命令（pm / am / input / settings / getprop / dumpsys / cmd，单条命令、禁管道）',
    '安装并启动 Shizuku，在本 App 内授权',
  ),
  _TierCardInfo('admin', 'ADMIN · 设备管理员', '以上全部 + 静默安装/卸载、设备策略', 'Device Owner（需 adb 激活；本版尚未接入）'),
  _TierCardInfo(
    'root',
    'ROOT · root 权限',
    '以上全部 + 同一组受限 shell 命令，走 su 执行（需 root 管理器实际授予 uid 0）',
    '在 root 管理器里允许本 App；没有 root 时自动回落到 Shizuku',
  ),
];

const String _disclaimerIntro =
    'Codex Pocket 是一个跑在你自己手机上的本地 Agent。为了让模型能帮你操作手机'
    '（读屏、点击、启动应用、执行 shell 命令等），App 需要你主动授予相应的 Android 权限。请注意：';

const List<String> _disclaimerItems = [
  '1. 这些权限只在本机使用，不会上传到任何服务器；所有操作记录只保存在本机（可随时查看/清空）。',
  '2. 授权后，AI 模型在你要求下可以直接操作你的手机界面与命令，包括点击、输入、启动/停止应用、执行 shell 命令。'
      '模型可能犯错、可能误点、可能执行你不想要的操作。请自行确认每一步要做什么，重要数据请先备份。',
  '3. 你随时可以在「设置 → 手机能力」里退回「标准权限」，或去系统设置关闭无障碍/Shizuku/设备管理员；'
      '关闭后相关工具立即失效，App 的业务功能（对话、文件、命令、网络）不受影响。',
  '4. 部分能力（短信、电话、精确定位）涉及隐私与商店政策，默认不提供；本版本也不会上传通讯录、短信等隐私数据。',
];

/// 免责声明正文：设置页塞进对话框，首次启动向导直接铺在页面上（同一份文案）。
class _DisclaimerBody extends StatelessWidget {
  const _DisclaimerBody();

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    mainAxisSize: MainAxisSize.min,
    children: [
      const Text(_disclaimerIntro, style: TextStyle(fontSize: 12.5, height: 1.6)),
      const SizedBox(height: 10),
      for (final item in _disclaimerItems)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Text(item, style: const TextStyle(fontSize: 12.5, height: 1.6)),
        ),
    ],
  );
}

/// 首次启动的全屏授权向导：不能用手势/返回键关掉，必须点「保持标准权限」或「完成设置」。
///
/// 和「设置 → 手机能力」共用 [_CodexDeviceBody]：同一套档位卡、能力矩阵、权限清单和引导。
class CodexPermissionsWizard extends StatelessWidget {
  const CodexPermissionsWizard({super.key, this.state, this.channel, this.onDone});

  /// 只为显示当前连接状态（终端/工具那一栏），不参与权限判定。
  final CodexPocketState? state;

  /// 测试可注入假通道；默认走原生 MethodChannel。
  final CodexDeviceChannel? channel;

  final VoidCallback? onDone;

  /// 两个出口都算「向导看过」：写 pref、关掉全屏向导。
  ///
  /// 这里必须用 `pop()` 而不是 `maybePop()`：本页外面套着 `PopScope(canPop: false)`，
  /// maybePop 会去问 PopScope，结果被自己挡住，点了没反应。
  Future<void> _complete(BuildContext context) async {
    await CodexPermissionsIntro.markSeen();
    onDone?.call();
    if (context.mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    child: Scaffold(
      key: const Key('permissions-wizard'),
      backgroundColor: const Color(0xfff8f8f4),
      appBar: AppBar(
        automaticallyImplyLeading: false,
        title: const Text('授予手机能力', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        backgroundColor: const Color(0xfff8f8f4),
        surfaceTintColor: Colors.transparent,
      ),
      body: SafeArea(
        top: false,
        child: _CodexDeviceBody(
          mode: _DeviceBodyMode.wizard,
          channel: channel,
          state: state,
          onKeepStandard: () => _complete(context),
          onFinishSetup: () => _complete(context),
        ),
      ),
    ),
  );
}

/// 「设置 → 手机能力」页：和首次启动向导共用同一个正文，多出操作记录/退回标准权限/重跑向导。
class CodexDeviceSettingsPage extends StatefulWidget {
  const CodexDeviceSettingsPage({super.key, this.channel, this.state});

  /// 测试可注入假通道；默认走原生 MethodChannel。
  final CodexDeviceChannel? channel;
  final CodexPocketState? state;

  @override
  State<CodexDeviceSettingsPage> createState() => _CodexDeviceSettingsPageState();
}

class _CodexDeviceSettingsPageState extends State<CodexDeviceSettingsPage> {
  /// 从向导回来要重读一次状态：向导里同意过免责声明/授过权，这里得跟上。
  int _reloadToken = 0;

  Future<void> _rerunWizard() async {
    await CodexPermissionsIntro.reset();
    if (!mounted) return;
    await Navigator.of(context)
        .push(codexPageRoute(CodexPermissionsWizard(state: widget.state, channel: widget.channel)));
    if (mounted) setState(() => _reloadToken++);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    key: const Key('device-page'),
    backgroundColor: const Color(0xfff8f8f4),
    appBar: AppBar(
      title: const Text('手机能力', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      backgroundColor: const Color(0xfff8f8f4),
      surfaceTintColor: Colors.transparent,
    ),
    body: SafeArea(
      top: false,
      child: _CodexDeviceBody(
        mode: _DeviceBodyMode.settings,
        channel: widget.channel,
        state: widget.state,
        reloadToken: _reloadToken,
        onRerunWizard: _rerunWizard,
      ),
    ),
  );
}

enum _DeviceBodyMode { settings, wizard }

/// 正文：首次启动向导与设置页共用。
///
/// 顺序按「先说清楚代价 → 再选档位 → 再看能力 → 再点授权 → 最后给分步向导」排，
/// 每一处状态都读原生回答，跳不动的按钮会明说「本机不支持」。
class _CodexDeviceBody extends StatefulWidget {
  const _CodexDeviceBody({
    required this.mode,
    this.channel,
    this.state,
    this.reloadToken = 0,
    this.onKeepStandard,
    this.onFinishSetup,
    this.onRerunWizard,
  });

  final _DeviceBodyMode mode;
  final CodexDeviceChannel? channel;
  final CodexPocketState? state;
  final int reloadToken;
  final VoidCallback? onKeepStandard;
  final VoidCallback? onFinishSetup;
  final Future<void> Function()? onRerunWizard;

  @override
  State<_CodexDeviceBody> createState() => _CodexDeviceBodyState();
}

class _CodexDeviceBodyState extends State<_CodexDeviceBody> with WidgetsBindingObserver {
  late final CodexDeviceChannel _channel = widget.channel ?? CodexDeviceChannel();
  CodexDeviceSnapshot? _snapshot;
  bool _busy = false;
  String? _hint;
  bool _askedForConsent = false;

  /// 向导里那份免责声明的勾选门（设置页是弹窗，用弹窗自己的状态）。
  bool _agreed = false;

  /// 每个权限项最近一次「去授权」的原生回答，用来显示「本机不支持」。
  final Map<String, CodexPermissionResult> _lastResults = {};

  bool get _isWizard => widget.mode == _DeviceBodyMode.wizard;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void didUpdateWidget(covariant _CodexDeviceBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.reloadToken != oldWidget.reloadToken) _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// 从系统设置页回来时重新读一次权限，页面上的状态才是真的。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) _load();
  }

  Future<void> _load() async {
    final snapshot = await _channel.status();
    if (!mounted) return;
    setState(() => _snapshot = snapshot);
    // 首次启动向导把免责声明铺在页面上（勾选门在下面），不再叠一个同样的弹窗。
    if (!_isWizard && !snapshot.consent && !_askedForConsent) {
      _askedForConsent = true;
      await _showDisclaimer();
    }
  }

  Future<bool> _showDisclaimer() async {
    var agreed = false;
    final accepted = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('手机能力授权说明'),
          content: SizedBox(
            width: 460,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  const _DisclaimerBody(),
                  CheckboxListTile(
                    key: const Key('device-consent-check'),
                    value: agreed,
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    onChanged: (value) => setDialogState(() => agreed = value ?? false),
                    title: const Text('我已阅读并同意', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              key: const Key('device-consent-keep-standard'),
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('保持标准权限'),
            ),
            FilledButton(
              key: const Key('device-consent-agree'),
              onPressed: agreed ? () => Navigator.of(dialogContext).pop(true) : null,
              child: const Text('同意并继续'),
            ),
          ],
        ),
      ),
    );
    if (accepted != true) return false;
    final snapshot = await _channel.acceptConsent();
    if (mounted) setState(() => _snapshot = snapshot);
    return true;
  }

  Future<void> _run(Future<CodexDeviceSnapshot> Function() action, {String? hint}) async {
    setState(() {
      _busy = true;
      _hint = hint;
    });
    final snapshot = await action();
    if (!mounted) return;
    setState(() {
      _snapshot = snapshot;
      _busy = false;
    });
  }

  Future<void> _toggleChannel() async {
    final snapshot = _snapshot;
    if (snapshot == null) return;
    if (!snapshot.enabled && !snapshot.consent) {
      if (!await _showDisclaimer()) return;
    }
    if (!mounted) return;
    final turningOff = snapshot.enabled;
    await _run(
      () => turningOff ? _channel.disable() : _channel.enable(),
      hint: turningOff ? '设备通道已关闭，握手文件已删除（档位与授权保留，下次开启直接可用）。' : '设备通道已开启，端口只监听 127.0.0.1。',
    );
    // 记住用户的意图：下次启动自动恢复；关闭时清掉，避免它自己又开起来。
    final after = _snapshot;
    if (after != null) await CodexDeviceChannelPrefs.markEnabled(after.enabled);
  }

  Future<void> _selectTier(String tier) async {
    final snapshot = _snapshot;
    if (snapshot == null || _busy) return;
    if (!snapshot.consent) {
      if (!await _showDisclaimer()) return;
    }
    if (!mounted) return;
    await _run(() => _channel.setTier(tier));
    if (!mounted) return;
    final next = _snapshot;
    if (tier == 'accessibility' && next?.permissions['accessibility'] != 'enabled') {
      setState(() => _hint = '档位已切到 ACCESSIBILITY，但系统里还没打开无障碍服务——现在读屏/点击仍不可用。');
      await _openSettings('accessibility');
      return;
    }
    if (tier == 'debugger' || tier == 'root') {
      final shizukuReady = next?.permissions['shizuku'] == 'authorized';
      final rootReady = next?.permissions['root'] == 'available';
      if (tier == 'root' && !rootReady && !shizukuReady) {
        setState(() => _hint = '档位已记录，但 root 管理器没有授予 uid 0，Shizuku 也没授权：shell 命令现在会返回 device/shizuku-unavailable。');
        return;
      }
      if (tier == 'debugger' && !shizukuReady) {
        setState(() => _hint = '档位已记录，但 Shizuku 还没授权本 App：去 Shizuku 里把 Codex Pocket 打开，再回来。');
        await _openSettings('shizuku');
        return;
      }
      setState(
        () => _hint =
            '当前档位：${tier.toUpperCase()} · shell 已可用（backend：${rootReady && tier == 'root' ? 'root' : 'shizuku'}）',
      );
      return;
    }
    if (tier == 'admin') {
      setState(() => _hint = '档位已记录，但本版没有接设备管理员：对应工具会返回 device/shizuku-unavailable 等错误码。');
      return;
    }
    setState(() => _hint = '当前档位：${tier.toUpperCase()}');
  }

  /// 跳系统设置页/弹系统对话框。跳不动时如实告诉用户「本机不支持，去设置里手动找」。
  Future<CodexPermissionResult> _openSettings(String target) async {
    final result = await _channel.openSettings(target);
    if (!mounted) return result;
    setState(() => _lastResults[target] = result);
    // 跳出成功时不动 _hint：上层（例如切档位）刚写好的提示比「已打开设置页」更有用。
    if (!result.opened) setState(() => _hint = result.failureHint);
    return result;
  }

  Future<void> _resetToStandard() async {
    await _run(_channel.disable, hint: '已退回标准权限：设备通道已关闭，握手文件已删除。');
  }

  /// 向导的「完成设置」：先记下免责声明同意，再让页面写 pref 并关掉向导。
  Future<void> _finishSetup() async {
    final snapshot = _snapshot;
    if (snapshot != null && !snapshot.consent) {
      setState(() => _busy = true);
      final next = await _channel.acceptConsent();
      if (!mounted) return;
      setState(() {
        _snapshot = next;
        _busy = false;
      });
    }
    widget.onFinishSetup?.call();
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = _snapshot;
    // 用 SingleChildScrollView 而不是 ListView：这页只有二十来个段落，
    // 全部一次性建好（不做懒回收）才能保证「滚到底部按钮后，顶部那张通道卡
    // 仍在 element 树里」——状态回读（点退回标准权限后重看顶部状态）和测试都依赖这点。
    return SingleChildScrollView(
      key: ValueKey('device-body-${widget.mode.name}'),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_busy) const Padding(padding: EdgeInsets.only(bottom: 8), child: LinearProgressIndicator(minHeight: 2)),
          if (_isWizard) ...[_introCard(), _disclaimerCard()],
          if (snapshot == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(child: Text('正在读取设备能力…', style: TextStyle(fontSize: 12.5))),
            )
          else ...[
            if (!_isWizard) _channelCard(snapshot),
            if (_hint != null) _hintBox(_hint!),
            if (snapshot.unavailable != null) _hintBox('设备通道不可用：${snapshot.unavailable}'),
            _tierSection(snapshot),
            if (_isWizard) _channelCard(snapshot),
            // 设置页保持原来的顺序（档位 → 权限清单 → 操作记录 → 退回标准权限），
            // 能力矩阵 / 设置向导这种「说明性」段落放在它后面：既不打乱老页面，
            // 也让「退回标准权限」这种真要动手的按钮留在手指够得到的位置。
            if (_isWizard) ...[
              _capabilitySection(snapshot),
              _permissionSection(snapshot),
              _guideSection(snapshot),
              _wizardActions(snapshot),
            ] else ...[
              _permissionSection(snapshot),
              if (snapshot.audit.isNotEmpty) _auditSection(snapshot),
              const SizedBox(height: 4),
              _resetButton(),
              _rerunWizardButton(),
              _capabilitySection(snapshot),
              _guideSection(snapshot),
              const Padding(
                padding: EdgeInsets.fromLTRB(4, 14, 4, 0),
                child: Text(
                  '限制说明：ROOT 档需要 root 管理器实际授予 uid 0，只看探测结果、不承诺；Shizuku 每次重启手机后要重新启动一次；'
                  '无障碍读屏只能拿到系统暴露的控件树，Canvas 自绘页面拿不到文本；部分页面有 FLAG_SECURE，截图会是黑屏。',
                  style: TextStyle(fontSize: 11, height: 1.6, color: Color(0xff85877d)),
                ),
              ),
            ],
          ],
        ],
      ),
    );
  }

  /// 向导顶部：先说清楚「不授权也能用什么」，再说明授权多拿到什么。
  Widget _introCard() => Container(
    key: const Key('wizard-intro'),
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(color: const Color(0xff252722), borderRadius: BorderRadius.circular(16)),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.shield_outlined, color: Colors.white, size: 22),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                '先把手机能力讲清楚',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        const Text(
          '不授权也能用 PRoot 全套：对话、文件、命令、网络、apt 装环境、git 全部照常，'
          'App 不会因为你不给权限就不好用。授权只是多出「读屏」「自动点击」「读应用列表」'
          '「改系统设置」这些需要系统点头的能力。',
          style: TextStyle(color: Color(0xffb9beb1), fontSize: 11.5, height: 1.6),
        ),
        const SizedBox(height: 6),
        const Text(
          '每一行的状态都是现查的：可用 / 需授权 / 本机不支持。点「需授权」会直接跳到系统的那个页面。',
          style: TextStyle(color: Color(0xff8f948a), fontSize: 11, height: 1.5),
        ),
      ],
    ),
  );

  /// 向导里的免责声明 + 勾选门（勾了才能点「完成设置」）。
  Widget _disclaimerCard() => Container(
    key: const Key('wizard-disclaimer'),
    margin: const EdgeInsets.only(top: 12),
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(13),
      border: Border.all(color: const Color(0xffe5e6de)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('授权说明（点「完成设置」前必须读一遍）', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        const _DisclaimerBody(),
        // ListTile（CheckboxListTile）必须躺在 Material 上：这里的白卡片是 Container+decoration，
        // 不包一层 Material 会在 debug 模式抛「ListTile needs a Material ancestor」。
        Material(
          color: Colors.transparent,
          child: CheckboxListTile(
            key: const Key('wizard-consent-check'),
            value: _agreed,
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            onChanged: (value) => setState(() => _agreed = value ?? false),
            title: const Text('我已阅读并同意', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          ),
        ),
      ],
    ),
  );

  Widget _wizardActions(CodexDeviceSnapshot snapshot) {
    final canFinish = _agreed || snapshot.consent;
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        children: [
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              key: const Key('wizard-finish'),
              onPressed: _busy || !canFinish ? null : _finishSetup,
              child: const Text('完成设置'),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              key: const Key('wizard-keep-standard'),
              onPressed: _busy ? null : widget.onKeepStandard,
              child: const Text('保持标准权限'),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
            child: Text(
              canFinish ? '之后想补授权：设置 → 手机能力。' : '读完并勾选才能点「完成设置」；只想先用基础功能就直接「保持标准权限」。',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 11, height: 1.5, color: Color(0xff85877d)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _channelCard(CodexDeviceSnapshot snapshot) => Container(
    key: const Key('device-channel-card'),
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(color: const Color(0xff252722), borderRadius: BorderRadius.circular(16)),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.smartphone, color: Colors.white, size: 22),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                snapshot.enabled ? '设备通道已开启' : '设备通道未开启',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 14),
              ),
            ),
            CodexStatusBadge(
              label: snapshot.tier.toUpperCase(),
              positive: snapshot.tier != 'standard',
              warning: snapshot.tier == 'standard',
            ),
          ],
        ),
        const SizedBox(height: 8),
        Text(
          snapshot.enabled
              ? '${snapshot.baseUrl ?? 'http://127.0.0.1'} · 只监听本机回环，模型每次调用都要带随机 token'
              : '开启后 App 才会在 127.0.0.1 上监听随机端口，并把地址/令牌写进 Codex 的握手文件；不开启时通道完全关闭。',
          style: const TextStyle(color: Color(0xffb9beb1), fontSize: 11.5, height: 1.5),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            FilledButton(
              key: const Key('device-channel-toggle'),
              onPressed: _busy ? null : _toggleChannel,
              child: Text(snapshot.enabled ? '关闭设备通道' : '开启设备通道'),
            ),
            const SizedBox(width: 10),
            Text(
              snapshot.consent ? '免责声明已同意' : '选择更高档位前需先同意免责声明',
              style: const TextStyle(color: Color(0xff8f948a), fontSize: 11),
            ),
          ],
        ),
      ],
    ),
  );

  Widget _hintBox(String text) => Container(
    key: const Key('device-hint'),
    margin: const EdgeInsets.only(top: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xfffff7e6),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: const Color(0xffe8d7ae)),
    ),
    child: Text(text, style: const TextStyle(fontSize: 12, height: 1.5, color: Color(0xff6b551f))),
  );

  Widget _tierSection(CodexDeviceSnapshot snapshot) => Padding(
    padding: const EdgeInsets.only(top: 20),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(
            '档位',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Color(0xff6d6f65)),
          ),
        ),
        for (final card in _tierCards) _tierCard(card, snapshot),
      ],
    ),
  );

  Widget _tierCard(_TierCardInfo info, CodexDeviceSnapshot snapshot) {
    final current = snapshot.tier == info.id;
    final available =
        info.id == 'standard' ||
        (info.id == 'root' && (snapshot.tiers['root'] == true || snapshot.tiers['debugger'] == true)) ||
        snapshot.tiers[info.id] == true;
    final status = current
        ? '当前档位'
        : available
        ? '可切换'
        : info.id == 'accessibility'
        ? '需要无障碍授权'
        : info.id == 'debugger' || info.id == 'root'
        ? '需要 root 或 Shizuku 授权'
        : '本版未接入';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: current ? const Color(0xffeef2ea) : Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(13),
          side: BorderSide(color: current ? const Color(0xff7f9a6b) : const Color(0xffe5e6de)),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: Key('device-tier-${info.id}'),
          onTap: _busy ? null : () => _selectTier(info.id),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(info.title, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
                    ),
                    CodexStatusBadge(label: status, positive: current, warning: !available),
                  ],
                ),
                const SizedBox(height: 6),
                _tierLine('多拿到什么', info.gains),
                _tierLine('需要什么', info.needs),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _tierLine(String label, String value) => Padding(
    padding: const EdgeInsets.only(top: 2),
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$label · ',
            style: const TextStyle(fontSize: 11.5, color: Color(0xff85877d), fontWeight: FontWeight.w600),
          ),
          TextSpan(
            text: value,
            style: const TextStyle(fontSize: 11.5, height: 1.45, color: Color(0xff4c5145)),
          ),
        ],
      ),
    ),
  );

  /// 能力矩阵：每项都问原生，别在 Dart 里猜。
  Widget _capabilitySection(CodexDeviceSnapshot snapshot) => Padding(
    padding: const EdgeInsets.only(top: 18),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(
            '能力矩阵',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Color(0xff6d6f65)),
          ),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(
            '可用 = 现在就能用；需授权 = 点一下直接跳到对应的系统页面；本机不支持 = 这版系统/这版 App 做不到，不装样子。',
            style: TextStyle(fontSize: 11.5, height: 1.45, color: Color(0xff85877d)),
          ),
        ),
        LayoutBuilder(
          builder: (context, constraints) {
            final width = (constraints.maxWidth - 10) / 2;
            return Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final item in _capabilityItems) SizedBox(width: width, child: _capabilityCard(item, snapshot)),
              ],
            );
          },
        ),
      ],
    ),
  );

  Widget _capabilityCard(_CapabilityItem item, CodexDeviceSnapshot snapshot) {
    final state = _capabilityStateOf(item, snapshot);
    return Material(
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(13),
        side: const BorderSide(color: Color(0xffe5e6de)),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        key: Key('capability-${item.id}'),
        onTap: _busy ? null : () => _tapCapability(item, state),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                state == _CapabilityState.ready ? item.icon : Icons.lock_outline,
                size: 19,
                color: state == _CapabilityState.ready ? const Color(0xff376c48) : const Color(0xff8a8d82),
              ),
              const SizedBox(height: 8),
              Text(
                item.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 5),
              CodexStatusBadge(label: state.label, positive: state.positive, warning: state.warning),
            ],
          ),
        ),
      ),
    );
  }

  _CapabilityState _capabilityStateOf(_CapabilityItem item, CodexDeviceSnapshot snapshot) {
    switch (item.id) {
      case 'window':
        return snapshot.permission('overlay') == 'granted' ? _CapabilityState.ready : _CapabilityState.needsGrant;
      case 'files':
      case 'androidData':
        return snapshot.permission('storage') == 'granted' ? _CapabilityState.ready : _CapabilityState.needsGrant;
      case 'tap':
      case 'virtualScreen':
        return snapshot.permission('accessibility') == 'enabled' ? _CapabilityState.ready : _CapabilityState.needsGrant;
      case 'terminal':
      case 'mcp':
        return _CapabilityState.ready;
      default:
        // data/data 与「系统权限修改」需要 root / shell UID，本版没接。
        return _CapabilityState.unsupported;
    }
  }

  Future<void> _tapCapability(_CapabilityItem item, _CapabilityState state) async {
    switch (state) {
      case _CapabilityState.ready:
        setState(() => _hint = '${item.title}：现在就能用，不需要再授权。');
      case _CapabilityState.needsGrant:
        await _openSettings(item.target);
      case _CapabilityState.unsupported:
        setState(() => _hint = '${item.title}：本机不支持——${item.unsupportedHint}');
    }
  }

  Widget _permissionSection(CodexDeviceSnapshot snapshot) => Padding(
    padding: const EdgeInsets.only(top: 10),
    child: CodexSection(
      title: '基础权限',
      description: '状态每次进来现查。位置、通知只在你点「去授权」时才向系统申请；短信、电话、通讯录本版不申请。',
      children: [for (final entry in _permissionRows) _permissionTile(entry, snapshot)],
    ),
  );

  Widget _permissionTile(_PermissionRow row, CodexDeviceSnapshot snapshot) {
    final status = snapshot.permission(row.id);
    final last = _lastResults[row.target];
    final subtitle = last != null && !last.opened
        ? '${_statusLabel(status)} · ${last.failureHint}'
        : _statusLabel(status);
    return CodexSettingTile(
      icon: row.icon,
      title: row.title,
      subtitle: subtitle,
      trailing: TextButton(
        key: Key('device-grant-${row.id}'),
        onPressed: _busy ? null : () => _openSettings(row.target),
        child: const Text('去授权', style: TextStyle(fontSize: 12)),
      ),
    );
  }

  /// 设置向导：无障碍 / Shizuku / 终端环境，分步说明 + 能点的按钮。
  Widget _guideSection(CodexDeviceSnapshot snapshot) => Padding(
    padding: const EdgeInsets.only(top: 10),
    child: CodexSection(
      title: '设置向导',
      description: '跟着做一遍，缺什么补什么。',
      children: [
        _guideCard(
          key: const Key('guide-accessibility'),
          icon: Icons.accessibility_new_outlined,
          title: '无障碍服务向导',
          steps: const ['点下面的「打开无障碍设置」。', '在「已下载的应用」里找到 Codex Pocket。', '打开开关，弹窗里选「允许」。', '回到本页：读屏 / 点击 / 截图马上变成「可用」。'],
          actionLabel: '打开无障碍设置',
          actionKey: const Key('guide-open-accessibility'),
          onTap: () => _openSettings('accessibility'),
        ),
        _guideCard(
          key: const Key('guide-shizuku'),
          icon: Icons.terminal_outlined,
          title: 'Shizuku 向导（shell UID）',
          steps: [
            snapshot.permission('shizuku') == 'installed-not-authorized'
                ? 'Shizuku 已安装：打开它，按提示开始服务。'
                : 'Shizuku 未安装：点下面的按钮去官网下载安装。',
            '在 Shizuku 的「应用管理」里把「Codex Pocket」打开授权（开关打开后，本 App 才会收到授权）。',
            '手机重启后要重新启动 Shizuku 一次（这是它的机制，不是本 App 的限制）。',
            '回到本页选 DEBUGGER 或 ROOT 档；受限 shell 只允许白名单内的单条命令，禁管道/分号/重定向。',
          ],
          actionLabel: snapshot.permission('shizuku') == 'installed-not-authorized' ? '打开 Shizuku' : '去下载',
          actionKey: const Key('guide-open-shizuku'),
          onTap: () => _openSettings('shizuku'),
        ),
        _guideCard(
          key: const Key('guide-terminal'),
          icon: Icons.data_object,
          title: '终端环境（PRoot，不需要系统权限）',
          steps: [
            'python / ssh / git 这些都装在 PRoot 里，和 Android 权限无关。',
            if (widget.state != null)
              widget.state!.connected ? '当前已连上本机 Codex，可以直接开终端。' : '当前还没连上本机 Codex：先在首页把运行时拉起来。',
            '在终端里用内置 dev 工具装（没有 dev 就 apt-get install）：',
          ],
          command: 'dev install python3 openssh-client git',
          actionLabel: null,
        ),
      ],
    ),
  );

  Widget _guideCard({
    required Key key,
    required IconData icon,
    required String title,
    required List<String> steps,
    String? command,
    String? actionLabel,
    Key? actionKey,
    Future<void> Function()? onTap,
  }) => Padding(
    key: key,
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 18, color: const Color(0xff4c5145)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            ),
          ],
        ),
        const SizedBox(height: 6),
        for (var i = 0; i < steps.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Text(
              '$i. ${steps[i]}',
              style: const TextStyle(fontSize: 11.5, height: 1.5, color: Color(0xff5b604f)),
            ),
          ),
        if (command != null)
          Container(
            margin: const EdgeInsets.only(top: 6),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(color: const Color(0xff252722), borderRadius: BorderRadius.circular(8)),
            // 用 Text 而不是 SelectableText：后者内部会带一个 Scrollable，
            // 页面里多出一个 Scrollable 会让「整页滚动区」的定位（含测试里的 scrollable）失准。
            child: Text(
              command,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: Color(0xffe6e6df)),
            ),
          ),
        if (actionLabel != null) ...[
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              key: actionKey,
              onPressed: _busy ? null : onTap,
              child: Text(actionLabel, style: const TextStyle(fontSize: 12)),
            ),
          ),
        ],
      ],
    ),
  );

  Widget _auditSection(CodexDeviceSnapshot snapshot) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: CodexSection(
      title: '最近操作记录',
      description: '模型每次点击/输入都必须说明理由，理由记在本机（最多 50 条）。',
      children: [
        for (final entry in snapshot.audit.reversed.take(5))
          ListTile(
            dense: true,
            leading: const Icon(Icons.history, size: 18, color: Color(0xff6d6f65)),
            title: Text(entry['path']?.toString() ?? '', style: const TextStyle(fontSize: 12)),
            subtitle: Text(entry['reason']?.toString() ?? '', style: const TextStyle(fontSize: 11)),
          ),
      ],
    ),
  );

  Widget _resetButton() => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        key: const Key('device-reset-standard'),
        onPressed: _busy ? null : _resetToStandard,
        icon: const Icon(Icons.lock_outline, size: 18),
        label: const Text('立即退回标准权限'),
        style: OutlinedButton.styleFrom(
          foregroundColor: const Color(0xff9c3b32),
          side: const BorderSide(color: Color(0xffe3c4c0)),
          padding: const EdgeInsets.symmetric(vertical: 13),
        ),
      ),
    ),
  );

  /// 复测入口：清掉「看过了」的 pref，再全屏跑一遍首次启动向导。
  Widget _rerunWizardButton() => Padding(
    padding: const EdgeInsets.only(top: 10),
    child: SizedBox(
      width: double.infinity,
      child: TextButton.icon(
        key: const Key('device-rerun-wizard'),
        onPressed: _busy ? null : widget.onRerunWizard,
        icon: const Icon(Icons.restart_alt, size: 18),
        label: const Text('重新运行授权向导'),
        style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 12)),
      ),
    ),
  );
}

/// 能力矩阵的状态词。
enum _CapabilityState {
  ready('可用', true, false),
  needsGrant('需授权', false, true),
  unsupported('本机不支持', false, true);

  const _CapabilityState(this.label, this.positive, this.warning);
  final String label;
  final bool positive;
  final bool warning;
}

class _CapabilityItem {
  const _CapabilityItem(this.id, this.title, this.icon, this.target, {this.unsupportedHint = ''});
  final String id;
  final String title;
  final IconData icon;

  /// 点「需授权」时跳的系统页（`codex/device.openSettings` 的 target）。
  final String target;
  final String unsupportedHint;
}

const List<_CapabilityItem> _capabilityItems = [
  _CapabilityItem('window', '悬浮窗', Icons.picture_in_picture_alt_outlined, 'overlay'),
  _CapabilityItem('files', '文件操作', Icons.folder_outlined, 'storage'),
  _CapabilityItem('androidData', 'Android/data', Icons.folder_copy_outlined, 'storage'),
  _CapabilityItem(
    'privateData',
    'data/data',
    Icons.lock_outline,
    'app',
    unsupportedHint: '应用私有目录要 root 或 shell UID，本版两个都没接。',
  ),
  _CapabilityItem('tap', '屏幕自动点击', Icons.touch_app_outlined, 'accessibility'),
  _CapabilityItem(
    'systemSettings',
    '系统权限修改',
    Icons.settings_suggest_outlined,
    'shizuku',
    unsupportedHint: 'settings put / pm grant 需要 shell UID（Shizuku 或 adb），本版只到无障碍档。',
  ),
  _CapabilityItem('terminal', '终端支持', Icons.terminal_outlined, 'app'),
  _CapabilityItem('virtualScreen', '虚拟屏幕', Icons.layers_outlined, 'accessibility'),
  _CapabilityItem('mcp', '插件市场 MCP', Icons.extension_outlined, 'app'),
];

class _PermissionRow {
  const _PermissionRow(this.id, this.title, this.icon, this.target);
  final String id;
  final String title;
  final IconData icon;
  final String target;
}

const List<_PermissionRow> _permissionRows = [
  _PermissionRow('storage', '存储权限（所有文件访问）', Icons.folder_outlined, 'storage'),
  _PermissionRow('overlay', '悬浮窗权限', Icons.picture_in_picture_alt_outlined, 'overlay'),
  _PermissionRow('batteryOptimization', '电池优化豁免', Icons.battery_charging_full_outlined, 'battery'),
  _PermissionRow('location', '位置权限', Icons.place_outlined, 'location'),
  _PermissionRow('notifications', '通知权限', Icons.notifications_outlined, 'notifications'),
  _PermissionRow('accessibility', '无障碍服务', Icons.accessibility_new_outlined, 'accessibility'),
];

String _statusLabel(String status) => switch (status) {
  'granted' => '已授权',
  'ignored' => '已豁免',
  'enabled' => '已开启',
  'installed-not-authorized' => '已安装 · 未授权给本 App',
  'not-installed' => '未安装',
  'optimized' => '受系统电池优化限制',
  'not-granted' => '未授权（点「去授权」向系统申请）',
  'disabled' => '未开启',
  _ => '未知',
};
