import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform, File;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:gpt_markdown/gpt_markdown.dart';

import 'codex_device.dart';
import 'codex_agents_panel.dart';
import 'codex_agents.dart';
import 'codex_attachments.dart';
import 'codex_model_sheet.dart';
import 'codex_pocket_state.dart';
import 'codex_theme.dart';
import 'codex_update.dart';
import 'codex_brand.dart';
import 'codex_capabilities_page.dart';
import 'codex_sessions_drawer.dart';
import 'codex_settings.dart';
import 'codex_terminal.dart';
import 'codex_ui_kit.dart';

/// 自定义背景上的可读性遮罩。旧值 0.86 会把图片几乎完全盖住；
/// 浅色主题保留 32% 遮罩，深色图片/主题用 42% 保住文字对比度。
double codexBackgroundOverlayOpacity(CodexTheme theme) => theme.background.computeLuminance() < 0.32 ? 0.42 : 0.32;

/// 安装运行时时该不该联网下载：**只有 APK 没内置运行时（瘦包）才需要**。
///
/// `bundledVersion` 只有 APK 真带了运行时才有值；旧的判断只看 `kRuntimeBaseUrl`
/// 是否为空，而它永远是常量、非空，于是完整包也会去下载 286MB（真机日志：
/// `Downloading runtime: https://api.github.com/...`），用户白等十几分钟。
bool codexShouldDownloadRuntime(Map<String, dynamic>? status) {
  final bundled = (status?['bundledVersion']?.toString() ?? '').trim();
  return bundled.isEmpty && kRuntimeBaseUrl.isNotEmpty;
}

/// 上次开着设备通道就自动恢复一次；返回 null 表示不用提示（没开过 / 已恢复成功）。
///
/// 真机复现：更新或重启后通道变关，模型读屏拿到 `device/unavailable`，用户看到的是
/// 「模型说看不到你的屏幕」——问题在 App 这一侧，必须由 App 说清楚。
Future<String?> codexResumeDeviceChannel({bool isAndroid = true, CodexDeviceChannel? channel}) async {
  if (!isAndroid) return null;
  if (!await CodexDeviceChannelPrefs.enabled()) return null;
  final snapshot = await (channel ?? CodexDeviceChannel()).enable();
  if (!snapshot.enabled) {
    return '设备通道没有自动恢复：去 设置 → 手机能力 重新开启。';
  }
  await CodexDeviceChannelPrefs.markEnabled(true);
  // 系统无障碍授权在**每次 APK 更新后都会被清掉**（真机实测 enabled_accessibility_services=null），
  // 于是通道能起来、档位却回落到 standard，读屏/点击全部 device/permission-denied。
  // 有 Shizuku/root 时由 shell UID 把授权写回系统设置，用户不用每次手动重开。
  var accessibilityReady = snapshot.tiers['accessibility'] == true;
  if (!accessibilityReady) {
    final restored = await (channel ?? CodexDeviceChannel()).restoreAccessibility();
    if (restored['restored'] == true) {
      final after = await (channel ?? CodexDeviceChannel()).status();
      accessibilityReady = after.tiers['accessibility'] == true;
    }
  }
  if (!accessibilityReady || snapshot.tier == 'standard') {
    return '系统无障碍授权被清掉了（每次更新后都会）：点右侧「去开启」，重新勾选 Codex Pocket。';
  }
  return null;
}

abstract interface class CodexRuntimeApi {
  Future<Map<String, dynamic>> invoke(String method);

  /// 带参数调用；布尔型结果（例如下载并安装运行时）走这个。
  Future<bool> invokeBool(String method, Map<String, dynamic> args);
  Stream<Map<String, dynamic>> get states;
}

class MethodChannelCodexRuntime implements CodexRuntimeApi {
  MethodChannelCodexRuntime({MethodChannel? methods, EventChannel? events})
    : _methods = methods ?? const MethodChannel('codex/runtime'),
      _events = events ?? const EventChannel('codex/runtime/events');
  final MethodChannel _methods;
  final EventChannel _events;
  @override
  Future<Map<String, dynamic>> invoke(String method) async =>
      await _methods.invokeMapMethod<String, dynamic>(method) ?? {};
  @override
  Future<bool> invokeBool(String method, Map<String, dynamic> args) async =>
      await _methods.invokeMethod<bool>(method, args) ?? false;
  @override
  Stream<Map<String, dynamic>> get states =>
      _events.receiveBroadcastStream().map((value) => (value as Map).cast<String, dynamic>());
}

/// 流式静默多久就认为这一轮“讲完了”，把思考卡收掉（默认 20s）。
/// codex 有时不吐 `turn/completed`（上游断流、重试耗尽），只靠 busy 判断会一直转。
const Duration kCodexThinkingIdleLimit = Duration(seconds: 20);

/// 「静默够久 + 已经有回答内容」= 认为这轮讲完了：把「正在思考 · Ns」折叠成「已完成 · Ns」。
bool codexShouldCollapseThinking({
  required DateTime? lastProgressAt,
  required DateTime now,
  required bool hasAnswer,
  Duration limit = kCodexThinkingIdleLimit,
}) => hasAnswer && lastProgressAt != null && now.difference(lastProgressAt) >= limit;

/// 一轮的真实进展；历史正文和心跳不能让新回合误完成。
class CodexStreamProgress {
  int _revision = 0;
  int _answerRevision = 0;
  int _answerBaseline = 0;
  DateTime? lastProgressAt;
  DateTime? lastAnswerAt;

  void begin(CodexPocketState state, DateTime now) {
    _revision = state.streamRevision;
    _answerRevision = _answerBaseline = state.answerRevision;
    lastProgressAt = lastAnswerAt = now;
  }

  bool observe(CodexPocketState state, DateTime now) {
    if (_revision == state.streamRevision) return false;
    _revision = state.streamRevision;
    lastProgressAt = now;
    if (_answerRevision != state.answerRevision) {
      _answerRevision = state.answerRevision;
      lastAnswerAt = now;
    }
    return true;
  }

  bool shouldCollapse(CodexPocketState state, DateTime now) => codexShouldCollapseThinking(
    lastProgressAt: lastProgressAt,
    now: now,
    hasAnswer: state.answerRevision > _answerBaseline,
  );

  bool answerQuiet(DateTime now) =>
      lastAnswerAt != null && now.difference(lastAnswerAt!) >= const Duration(milliseconds: 1500);

  String activityLabel(Iterable<PocketEvent> process, DateTime now) {
    if (!answerQuiet(now)) return 'Codex 正在工作';
    final entries = process.toList();
    for (final event in entries.reversed) {
      if ((event.type.startsWith('tool.') || event.type == 'step') && (event.status ?? 'running') == 'running') {
        return '正在调用 ${(event.name?.isNotEmpty ?? false) ? event.name : codexStepTitle(event)}';
      }
    }
    if (entries.isNotEmpty && (entries.last.type == 'reasoning.delta' || entries.last.type == 'reasoning')) {
      return '正在思考';
    }
    return 'Codex 正在工作';
  }
}

/// 活跃过程区最多约 12 行，完整内容保留在可滚动区域。
const int kCodexLiveTimelineLines = 12;

class CodexPocketHome extends StatefulWidget {
  const CodexPocketHome({super.key, required this.client, this.runtime, this.enableRuntime, this.fixtureEvents});
  final CodexBridgeClient client;
  final CodexRuntimeApi? runtime;
  final bool? enableRuntime;
  final List<PocketEvent>? fixtureEvents;
  @override
  State<CodexPocketHome> createState() => _CodexPocketHomeState();
}

class _CodexPocketHomeState extends State<CodexPocketHome> with WidgetsBindingObserver {
  late final CodexPocketState state = CodexPocketState(widget.client)..addListener(_changed);
  final _composer = TextEditingController();
  final _attachmentPicker = const CodexAttachmentPicker();
  List<CodexAttachment> _attachments = [];
  final _conversationScroll = ScrollController();
  bool _wasBusy = false;
  DateTime? _thinkingStartedAt;
  Timer? _thinkingTicker;

  /// 每一轮的耗时，按回合键记：思考链那行显示「已完成 · Ns」，
  /// 下一轮结束后前一轮的秒数不会被改掉。
  final Map<String, int> _turnSeconds = {};

  /// 流式产出静默多久就认为这一轮“讲完了”，把思考卡收掉（默认 20s）。
  final _streamProgress = CodexStreamProgress();
  int _turnStartIndex = 0;
  int _lastFollowRevision = -1;
  bool _thinkingStalled = false;
  final _cwd = TextEditingController();
  final _scaffoldKey = GlobalKey<ScaffoldState>();

  CodexTheme _theme = kCodexThemes.first;
  String? _agentParentThread;
  String? _agentReturnCandidate;
  bool _openingAgent = false;
  bool _wasConnected = false;

  /// 哪些主对话真的派发过子 Agent（桥推断不到父 ID 时的兜底）。
  /// 谁置位：当前对话回合里收到新的 agent.status(queued)；谁清除：仅随 App 数据清除。
  final Set<String> _dispatchedThreads = <String>{};
  String? _activeAgentThreadId;
  String _activeAgentName = '';

  String _reasoningLevel = 'medium';
  String _approval = 'on-request';

  /// 权限档位：默认**不指定**沙箱（沿用本机 codex 配置 = 完全权限）。
  /// PRoot 里没有可用的 Linux 沙箱，一旦发 workspaceWrite，codex 会拒绝执行命令，
  /// 模型只能说「工具无法启动」——所以「工作区可写」不再作为档位提供。
  String _sandboxMode = '';
  String? _backgroundImage;
  String _contextText = '';

  late final CodexRuntimeApi? _runtime =
      widget.runtime ?? ((widget.enableRuntime ?? Platform.isAndroid) ? MethodChannelCodexRuntime() : null);
  StreamSubscription<Map<String, dynamic>>? _runtimeEvents;
  Map<String, dynamic> _runtimeStatus = {};

  /// 检查更新进行中：避免连点并发请求，也让界面立刻有「正在检查」的反馈。
  bool _checkingUpdate = false;
  String? _connectedRuntimeUrl;
  String? _connectedRuntimeToken;
  // proot 里 node+codex 起来要十几秒，首次连接常常赶在 bridge listen 之前；
  // 只靠 runtime 事件驱动的话，一次失手就一直「未连接」，所以这里自己退避重试。
  Timer? _retryTimer;
  int _retryCount = 0;
  bool _runtimeConnectPending = false;
  late final _bridgeUrl = TextEditingController(text: widget.client.baseUrl);
  final _bridgeToken = TextEditingController();
  final _runtimeLogs = <String>[];

  /// 与 `state.connectionMode` 同步的本地副本：只有它变化时才重新决定要不要拉起运行时。
  String _connectionMode = 'local';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.fixtureEvents != null) state.events = [...widget.fixtureEvents!];
    state.loadCachedConfig();
    state.loadSystemPrompt();
    state.loadProviders();
    CodexPrefs.loadTheme().then((value) => mounted ? setState(() => _theme = value) : null);
    CodexPrefs.loadReasoning().then((value) => mounted ? setState(() => _reasoningLevel = value) : null);
    CodexPrefs.loadApproval().then((value) => mounted ? setState(() => _approval = value) : null);
    CodexPrefs.loadSandboxMode().then((value) => mounted ? setState(() => _sandboxMode = value) : null);
    CodexPrefs.loadBackgroundImage().then((value) => mounted ? setState(() => _backgroundImage = value) : null);
    unawaited(_resumeDeviceChannel());
    CodexPrefs.loadContextWindow().then((tokens) {
      state.contextWindowOverride = tokens;
      if (mounted) setState(() {});
    });
    unawaited(_bootstrapConnection());
    // 首次启动先把手机能力讲清楚：不阻塞连接流程，等第一帧出来再盖全屏向导。
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_showPermissionsWizardIfFirstRun()));
  }

  /// 第一次打开 App（本地还没记过「向导看过」）就自动弹全屏授权向导。
  ///
  /// 只在 Android 上弹：桌面/Web 没有这些系统权限页，弹出来只会全是「本机不支持」。
  /// 谁置位 `codex.permissionsIntroSeen`：向导的「保持标准权限」/「完成设置」；
  /// 谁清除：设置 → 手机能力 →「重新运行授权向导」。
  Future<void> _showPermissionsWizardIfFirstRun() async {
    if (defaultTargetPlatform != TargetPlatform.android) return;
    if (!mounted) return;
    if (await CodexPermissionsIntro.seen()) return;
    if (!mounted) return;
    await Navigator.of(context).push(
      PageRouteBuilder<void>(
        opaque: true,
        transitionDuration: const Duration(milliseconds: 220),
        pageBuilder: (_, _, _) => CodexPermissionsWizard(state: state),
      ),
    );
  }

  /// 本机 / 远程的分叉点（CONTRACT-V3 C）：远程模式不拉起本机运行时，
  /// 地址与令牌由连接页手填；本机模式仍自动启动并等待运行时下发地址令牌。
  Future<void> _bootstrapConnection() async {
    await state.loadConnectionMode();
    if (!mounted) return;
    _connectionMode = state.connectionMode;
    if (_connectionMode == 'remote') {
      if (state.remoteBaseUrl.isNotEmpty) {
        widget.client.baseUrl = state.remoteBaseUrl;
        _bridgeUrl.text = state.remoteBaseUrl;
      }
      await _connectAndRestore();
      return;
    }
    if (_runtime != null) {
      _ensureRuntimeEvents();
      await _loadRuntime();
    } else {
      await _connectAndRestore();
    }
  }

  void _ensureRuntimeEvents() {
    final runtime = _runtime;
    if (runtime == null || _runtimeEvents != null) return;
    _runtimeEvents = runtime.states.listen(
      _acceptRuntime,
      onError: (Object e) {
        if (mounted) setState(() => _runtimeStatus = {'phase': 'error', 'error': e.toString()});
      },
    );
  }

  /// 没有本机运行时（桌面/测试）时也要走「握手 → 回到上次会话」这条路，
  /// 否则主页会停在空白等用户自己点。
  Future<void> _connectAndRestore() async {
    await state.loadLastThread();
    if (!mounted) return;
    await state.connect();
    if (!mounted) return;
    unawaited(_loadAgentBoard());
    await _restoreLastConversation();
  }

  /// 主对话附录要有数据：连上桥就拉一次子 Agent 树（失败不影响对话）。
  Future<void> _loadAgentBoard() async {
    try {
      final snapshot = await state.client.get('/api/subagent/tree');
      state.agents.replaceSnapshot(snapshot);
    } catch (_) {}
  }

  Future<void> _loadRuntime() async {
    final runtime = _runtime;
    if (runtime == null) return;
    // 远程模式不拉起本机运行时（CONTRACT-V3 C）。
    if (state.connectionMode == 'remote') return;
    try {
      // Use the endpoint actually issued by the native runtime. A cached or
      // hard-coded port can point at a dead bridge after process recovery.
      final status = await runtime.invoke('connection');
      _acceptRuntime(status);
      final phase = (status['phase'] ?? '').toString();
      if (phase == 'installed' || phase == 'notInstalled') {
        _acceptRuntime(await runtime.invoke('start'));
        // start() 只是把服务拉起来；「running + 真实端口/token」是稍后由原生发布的。
        // 那一次事件可能在 Flutter 端订阅之前就发出去（冷启动常见），只靠事件会永远
        // 停在默认 8787 → Connection refused。这里主动轮询到就绪为止。
        unawaited(_awaitRuntimeReady());
      }
    } catch (error) {
      if (mounted) setState(() => _runtimeStatus = {'phase': 'error', 'error': error.toString()});
    }
  }

  /// 轮询运行时状态直到 bridge 真正就绪（有 baseUrl/token），最多约 60 秒。
  Future<void> _awaitRuntimeReady() async {
    final runtime = _runtime;
    if (runtime == null) return;
    for (var i = 0; i < 85; i++) {
      if (!mounted) return;
      Map<String, dynamic> conn;
      try {
        conn = await runtime.invoke('connection');
      } catch (_) {
        return;
      }
      if (!mounted) return;
      _acceptRuntime(conn);
      final phase = (conn['phase'] ?? '').toString();
      if (phase == 'running' && conn['baseUrl'] is String) return;
      if (phase == 'error' || phase == 'notInstalled') return;
      await Future<void>.delayed(const Duration(milliseconds: 700));
    }
  }

  Future<void> _showRuntimeLogs() async {
    final runtime = _runtime;
    if (runtime == null) return;
    final result = await runtime.invoke('logs');
    _acceptRuntime(result);
    if (!mounted) return;
    // 弹层里用打开这一刻的快照：日志列表随后还会被运行时事件改写，
    // 直接读可变列表会出现「明明点了日志，弹层却是空的」。
    final snapshot = List<String>.of(_runtimeLogs);
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text('Codex runtime logs', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            if (snapshot.isEmpty) const Text('运行时还没有日志', style: TextStyle(fontSize: 12, color: Color(0xff85877d))),
            for (final line in snapshot)
              SelectableText(line, style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
          ],
        ),
      ),
    );
  }

  void _acceptRuntime(Map<String, dynamic> result) {
    if (!mounted) return;
    setState(() {
      _runtimeStatus = result;
      _runtimeLogs
        ..clear()
        ..addAll((result['logs'] as List? ?? []).map((line) => line.toString()));
    });
    if ((result['phase'] ?? '').toString() != 'running') {
      // 运行时停了/重启中：清掉「已连过这个地址」的标记，下次 running 时重新握手。
      _connectedRuntimeUrl = null;
      _connectedRuntimeToken = null;
      return;
    }
    if (result['baseUrl'] is String && result['token'] is String) {
      // 远程模式用连接页手填的地址，别被本机运行时下发值覆盖。
      if (state.connectionMode == 'remote') return;
      // 只有运行时下发了新地址/令牌才重新连接。握手失败走 _scheduleConnectRetry，
      // 事件流断开走 state 自己的退避重连；否则「刚连上就被断开」的状态事件会
      // 递归触发一次新连接，界面表现为无限重连。
      if (_connectedRuntimeUrl != _runtimeUrlOf(result) || _connectedRuntimeToken != _runtimeTokenOf(result)) {
        _connectToRuntime();
      }
    }
  }

  /// bridge 打印的是 http://127.0.0.1:PORT/?token=xxx；直接当 baseUrl 拼路径会坏。
  String _runtimeUrlOf(Map<String, dynamic> result) {
    final raw = (result['baseUrl'] as String? ?? '').trim();
    final parsed = Uri.tryParse(raw);
    return parsed == null || parsed.host.isEmpty ? raw : '${parsed.scheme}://${parsed.host}:${parsed.port}';
  }

  String _runtimeTokenOf(Map<String, dynamic> result) {
    final issued = (result['token'] as String? ?? '').trim();
    if (issued.isNotEmpty) return issued;
    return Uri.tryParse((result['baseUrl'] as String? ?? '').trim())?.queryParameters['token'] ?? '';
  }

  /// 真正发起一次本机连接。冷启动时 PRoot 里 node+bridge 可能比界面晚十几秒才 listen，
  /// 所以失败要能自己继续重试，而不是等下一个运行时事件（事件去重后可能不再来）。
  Future<void> _connectToRuntime() async {
    if (!mounted || _runtimeConnectPending) return;
    if (state.connectionMode == 'remote') return;
    final status = _runtimeStatus;
    if ((status['phase'] ?? '').toString() != 'running') return;
    final url = _runtimeUrlOf(status);
    final token = _runtimeTokenOf(status);
    if (url.isEmpty) return;
    _connectedRuntimeUrl = url;
    _connectedRuntimeToken = token;
    widget.client.baseUrl = url;
    if (token.isNotEmpty) widget.client.token = token;
    _bridgeUrl.text = url;
    _bridgeToken.clear();
    _runtimeConnectPending = true;
    await state.loadLastThread();
    await state.connect();
    if (!mounted) return;
    _runtimeConnectPending = false;
    await _restoreLastConversation();
    if (state.connected) {
      _retryCount = 0;
      _retryTimer?.cancel();
    } else {
      _scheduleConnectRetry();
    }
  }

  /// 桥还没 listen / 首次探测失败就继续试：约 30 次、最长 3 秒一次，覆盖 PRoot 冷启动。
  void _scheduleConnectRetry() {
    if (!mounted || state.connected || _retryCount >= 30) return;
    _retryTimer?.cancel();
    final delay = Duration(milliseconds: (600 + _retryCount * 400).clamp(600, 3000));
    _retryTimer = Timer(delay, () {
      if (!mounted || state.connected || _runtimeConnectPending) return;
      _retryCount++;
      _connectToRuntime();
    });
  }

  /// 返回动作后的运行时状态，打开中的运行时二级页据此刷新自身，而不是显示旧快照。
  Future<Map<String, dynamic>> _runtimeAction(String action) async {
    final runtime = _runtime;
    if (runtime == null) return _runtimeStatus;
    try {
      final next = await runtime.invoke(action);
      _acceptRuntime(next);
      return next;
    } catch (e) {
      final failed = <String, dynamic>{'phase': 'error', 'error': e.toString()};
      if (mounted) setState(() => _runtimeStatus = failed);
      return failed;
    }
  }

  void _changed() {
    if (!mounted) return;
    // 记住"这个对话派发过子 Agent"：桥只在有新成员排队时发出 queued。
    final thread = state.threadId;
    if (thread != null && state.agents.hasFreshQueued) {
      _dispatchedThreads.add(thread);
      state.agents.consumeFreshQueued();
    }
    if (state.connected && !_wasConnected) {
      _wasConnected = true;
      unawaited(_loadAgentBoard());
    } else if (!state.connected) {
      _wasConnected = false;
    }
    // State.threadId is null while resumeThread is still loading; only leave
    // agent mode when a different, real thread became active.
    if (!_openingAgent &&
        _activeAgentThreadId != null &&
        state.threadId != null &&
        state.threadId != _activeAgentThreadId) {
      _activeAgentThreadId = null;
      _agentParentThread = null;
      _activeAgentName = '';
    }
    final followTail =
        state.busy &&
        state.streamRevision != _lastFollowRevision &&
        (!_conversationScroll.hasClients || _conversationScroll.position.extentAfter < 48);
    _lastFollowRevision = state.streamRevision;
    // 连接页切换本机/远程时即时生效：切回本机就自动拉起运行时，切到远程就不再碰它。
    if (state.connectionMode != _connectionMode) {
      _connectionMode = state.connectionMode;
      _onConnectionModeChanged();
    }
    if (state.busy && !_wasBusy) {
      _thinkingStartedAt = DateTime.now();
      _streamProgress.begin(state, DateTime.now());
      _turnStartIndex = state.events.length;
      _thinkingStalled = false;
      _thinkingTicker = Timer.periodic(const Duration(milliseconds: 500), (_) {
        if (!mounted) return;
        _evaluateThinking();
        if (state.busy) setState(() {});
      });
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToLatest());
    } else if (!state.busy && _wasBusy) {
      // 回合结束：把这段时间记到本轮的思考块上，折叠成「已完成 · Ns」，点开仍能看思考链。
      _finishThinking();
      _thinkingTicker?.cancel();
      _thinkingTicker = null;
    } else if (state.busy) {
      _evaluateThinking();
    }
    _wasBusy = state.busy;
    setState(() {});
    if (followTail) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToLatest());
    }
  }

  /// 有产出就刷新“最后进展时间”；静默超过阈值且有回答内容时，把思考卡收成「已完成」。
  /// 只看真实产出（正文/思考/工具），不看 `usage`、`account.updated` 这类心跳——否则永远判不出卡死。
  void _evaluateThinking() {
    if (!state.busy) return;
    if (_streamProgress.observe(state, DateTime.now())) {
      if (_thinkingStalled) _thinkingStartedAt = DateTime.now();
      _thinkingStalled = false;
      return;
    }
    if (_thinkingStalled || !_streamProgress.shouldCollapse(state, DateTime.now())) return;
    _thinkingStalled = true;
    _finishThinking();
  }

  /// 把当前这轮折叠成「已完成 · Ns」；重复调用是安全的。
  /// 秒数按回合记，后面的回合结束不会改掉前面「已完成 · Ns」的时长。
  void _finishThinking() {
    final started = _thinkingStartedAt;
    _thinkingStartedAt = null;
    if (started == null) return;
    final key = _currentTurnKey();
    if (key != null) _turnSeconds[key] = DateTime.now().difference(started).inSeconds;
  }

  /// 当前这一轮的回合键（和 `_conversationRows()` 用的分组键同一套）。
  String? _currentTurnKey() {
    final id = state.currentTurnId;
    if (state.busy && id != null && id.isNotEmpty) return 'turn:$id';
    final keys = chatTurnKeys(state.events);
    final start = state.busy ? _turnStartIndex : 0;
    for (var i = keys.length - 1; i >= start; i--) {
      if (keys[i] != null) return keys[i];
    }
    return null;
  }

  /// 思考卡是否还该显示：桥说忙 + 没被判成静默卡死。
  bool get _thinkingLive => state.busy && !_thinkingStalled;

  /// 新轮或用户停在尾部时跟随最新内容；查看历史时不抢滚动。
  void _scrollToLatest() {
    if (!mounted || !_conversationScroll.hasClients) return;
    _conversationScroll.jumpTo(_conversationScroll.position.maxScrollExtent);
  }

  void _onConnectionModeChanged() {
    _retryTimer?.cancel();
    if (_connectionMode == 'remote') return;
    _ensureRuntimeEvents();
    unawaited(_loadRuntime());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    // 从后台回来时服务端可能已经被别处改过渠道/模型，刷新一次再显示。
    if (lifecycleState == AppLifecycleState.resumed) {
      unawaited(state.refreshFromServer());
      // 用户很可能刚去系统设置里勾了无障碍：回来就立刻复查，别让提示条一直挂着。
      unawaited(_checkDeviceChannel(showNotice: true));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _retryTimer?.cancel();
    _deviceRecheckTimer?.cancel();
    state.removeListener(_changed);
    state.dispose();
    _runtimeEvents?.cancel();
    _composer.dispose();
    _conversationScroll.dispose();
    _thinkingTicker?.cancel();
    _cwd.dispose();
    _bridgeUrl.dispose();
    _bridgeToken.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: _theme.background,
      // 设置抽屉：运行时状态 + 终端/能力/设置/关于 + 工作区 + 版本号（会话列表在历史浮层里）。
      drawer: Drawer(
        width: 300,
        backgroundColor: const Color(0xfff1f2ed),
        child: CodexToolsPanel(
          currentCwd: _cwd.text,
          connected: state.connected,
          onReconnect: state.connect,
          onChooseFolder: _chooseFolder,
          onOpenSettings: () => _openPage(_settingsPage()),
          onOpenTerminal: () => _openPage(CodexTerminalPage(state: state)),
          onOpenCapabilities: () => _openPage(_capabilitiesPage()),
          onOpenAbout: () => _openPage(
            CodexAboutSettingsPage(state: state, onCheckUpdate: _checkUpdate, onCopyFeedback: _copyFeedbackQq),
          ),
          // 远程模式不碰本机运行时，就不显示它的状态（否则永远是「读取中」）。
          runtimeTile: _runtime == null || state.isRemoteMode ? null : _runtimeTile(),
        ),
      ),
      appBar: _appBar(),
      body: Stack(
        children: [
          if (_backgroundImage != null)
            Positioned.fill(
              child: Image.file(
                File(_backgroundImage!),
                key: const Key('chat-background-image'),
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
            ),
          if (_backgroundImage != null)
            // 图片上盖一层主题色，保证正文与卡片始终可读。
            Positioned.fill(
              child: ColoredBox(color: _theme.background.withValues(alpha: codexBackgroundOverlayOpacity(_theme))),
            ),
          SafeArea(
            top: false,
            child: Column(
              children: [
                if (state.error != null) _errorBanner(),
                if (_deviceChannelNotice != null) _deviceChannelBanner(),
                Expanded(
                  child: Column(
                    key: const ValueKey('conversation'),
                    children: [
                      _agentStrip(),
                      Expanded(child: _conversation()),
                      if (_activeAgentThreadId != null) _agentConversationBanner(),
                      if (state.statusHint != null) _statusHintLine(state.statusHint!),
                      _composerBox(),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 顶部：汉堡（设置抽屉）、历史（对话历史浮层）、会话标题、会话操作。
  PreferredSizeWidget _appBar() => AppBar(
    backgroundColor: _theme.background,
    surfaceTintColor: Colors.transparent,
    elevation: 0,
    titleSpacing: 0,
    leadingWidth: _appBarLeadingWidth,
    leading: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _appBarIcon(
          key: const Key('open-drawer'),
          tooltip: '设置与工具',
          icon: Icons.menu,
          onPressed: () => _scaffoldKey.currentState?.openDrawer(),
        ),
        _appBarIcon(key: const Key('open-history'), tooltip: '对话历史', icon: Icons.history, onPressed: _openHistory),
      ],
    ),
    title: Row(
      children: [
        Icon(Icons.circle, size: 8, color: state.connected ? const Color(0xff36845d) : Colors.grey),
        const SizedBox(width: 7),
        Flexible(
          child: Text(
            _taskTitle(),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
          ),
        ),
        // 与 DSH 一致：只有这个对话真的派发过子 Agent，才在主对话旁显示成员入口。
        AnimatedBuilder(
          animation: state.agents,
          builder: (context, _) {
            final members = _agentsForCurrentThread();
            if (members.isEmpty) return const SizedBox.shrink();
            final running = members.where((agent) => agent.active).length;
            return Padding(
              padding: const EdgeInsets.only(left: 6),
              child: TextButton.icon(
                key: const Key('thread-agents-pill'),
                style: TextButton.styleFrom(
                  visualDensity: VisualDensity.compact,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(0, 28),
                  backgroundColor: _theme.background.withValues(alpha: 0.6),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: () => _openAgents(focusThread: state.threadId),
                icon: Icon(
                  running > 0 ? Icons.autorenew : Icons.groups_2_outlined,
                  size: 15,
                  color: running > 0 ? const Color(0xff7a6320) : _theme.accent,
                ),
                label: Text(
                  running > 0 ? '$running/${members.length}' : '${members.length}',
                  style: TextStyle(fontSize: 12, color: _theme.ink, fontWeight: FontWeight.w600),
                ),
              ),
            );
          },
        ),
      ],
    ),
    actions: [
      PopupMenuButton<String>(
        tooltip: '会话操作',
        icon: const Icon(Icons.more_vert, size: 20),
        onSelected: (action) {
          switch (action) {
            case 'branch':
              _branchThread();
            case 'goal':
              _editGoal();
            case 'compact':
              state.compact();
            case 'project':
              _chooseFolder();
            case 'context':
              _openContextSettings();
          }
        },
        itemBuilder: (_) => const [
          PopupMenuItem(
            value: 'goal',
            child: ListTile(dense: true, leading: Icon(Icons.track_changes), title: Text('目标与计划')),
          ),
          PopupMenuItem(
            value: 'branch',
            child: ListTile(dense: true, leading: Icon(Icons.call_split), title: Text('从这里分支')),
          ),
          PopupMenuItem(
            value: 'compact',
            child: ListTile(dense: true, leading: Icon(Icons.compress), title: Text('压缩上下文')),
          ),
          PopupMenuItem(
            value: 'context',
            child: ListTile(dense: true, leading: Icon(Icons.data_usage), title: Text('上下文设置')),
          ),
          PopupMenuItem(
            value: 'project',
            child: ListTile(dense: true, leading: Icon(Icons.folder_open_outlined), title: Text('项目文件夹')),
          ),
        ],
      ),
    ],
  );

  Future<void> _openAgents({String? focusThread}) async {
    if (_activeAgentThreadId == null) _agentReturnCandidate = state.threadId;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => FractionallySizedBox(
        heightFactor: 0.88,
        child: SafeArea(
          child: CodexAgentsPanel(
            state: state.agents,
            theme: _theme,
            focusThreadId: focusThread ?? state.threadId,
            refresh: () async {
              final snapshot = await state.client.get('/api/subagent/tree');
              state.agents.replaceSnapshot(snapshot);
            },
            onOpenConversation: (agent) => _openAgentConversation(agent, fromSheet: true),
          ),
        ),
      ),
    );
  }

  /// 只把「这个对话派发的」子代理算作成员：显式父 ID 匹配，或这个对话在
  /// 本机记录里确实派发过（桥推断不到父 ID 时的兜底）。没有成员就不显示入口。
  List<CodexAgent> _agentsForCurrentThread() {
    final thread = state.threadId;
    if (thread == null || thread.isEmpty) return const [];
    final dispatched = _dispatchedThreads.contains(thread);
    return state.agents.agents.where((agent) {
      final parent = agent.parentThreadId;
      if (parent != null && parent.isNotEmpty) return parent == thread;
      return dispatched;
    }).toList();
  }

  /// 只有从底部面板进入时才需要先关掉面板；从附录条进入时不能 pop，
  /// 否则会把主页面自己弹出导航栈（真机表现为整屏黑）。
  Future<void> _openAgentConversation(CodexAgent agent, {bool fromSheet = false}) async {
    final childThread = agent.agentThreadId;
    if (childThread == null || childThread.isEmpty) {
      showCodexMessage(context, '这个子 Agent 的会话已经不可用');
      return;
    }
    final current = state.threadId;
    final recordedParent = agent.parentThreadId;
    final candidate = _agentReturnCandidate;
    // The conversation the user was actually reading when opening the board
    // is the most reliable return target; a persisted parent id may be absent
    // or synthetic. Fall back to the recorded parent, then the current thread.
    final parent = candidate != null && candidate.isNotEmpty && candidate != childThread
        ? candidate
        : (recordedParent != null && recordedParent.isNotEmpty && recordedParent != childThread
              ? recordedParent
              : (current != null && current != childThread ? current : null));
    if (fromSheet) Navigator.of(context).pop();
    setState(() {
      _agentParentThread = parent;
      _activeAgentThreadId = childThread;
      _activeAgentName = agent.name;
    });
    _openingAgent = true;
    try {
      await state.resumeThread(childThread);
    } finally {
      _openingAgent = false;
    }
    if (parent != null && parent.isNotEmpty) await state.rememberMainThread(parent);
  }

  Future<void> _returnFromAgent() async {
    final parent = _agentParentThread;
    final child = _activeAgentThreadId;
    final last = state.lastThreadId;
    setState(() {
      _activeAgentThreadId = null;
      _agentParentThread = null;
      _activeAgentName = '';
    });
    final candidates = <String>{
      if (parent != null && parent.isNotEmpty && parent != child) parent,
      if (last != null && last.isNotEmpty && last != child) last,
    };
    for (final candidate in candidates) {
      if (state.error != null) state.clearError();
      await state.resumeThread(candidate);
      if (state.error == null) {
        await state.rememberMainThread(candidate);
        return;
      }
    }
    // No usable parent thread (for example an agent recorded with a synthetic
    // parent id): clear the error and let the user pick a conversation.
    if (state.error != null) state.clearError();
    if (mounted) await _openHistory();
  }

  Widget _agentConversationBanner() => Container(
    key: const Key('agent-conversation-banner'),
    margin: const EdgeInsets.fromLTRB(16, 6, 16, 0),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    decoration: BoxDecoration(color: const Color(0xffe9efe4), borderRadius: BorderRadius.circular(12)),
    child: Row(
      children: [
        const Icon(Icons.account_tree_outlined, size: 19, color: Color(0xff476a3b)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            '子 Agent · $_activeAgentName\n这是独立会话，可继续派发任务',
            maxLines: 2,
            style: const TextStyle(fontSize: 12, height: 1.35, color: Color(0xff405338)),
          ),
        ),
        TextButton.icon(
          key: const Key('return-from-agent'),
          onPressed: _returnFromAgent,
          icon: const Icon(Icons.arrow_back, size: 17),
          label: const Text('返回主对话'),
        ),
      ],
    ),
  );

  /// 标题栏两枚 20px 图标（汉堡 + 历史），总宽压在 96 以内，别把标题挤没了。
  static const double _appBarLeadingWidth = 92;
  Widget _appBarIcon({
    required Key key,
    required String tooltip,
    required IconData icon,
    required VoidCallback onPressed,
  }) => IconButton(
    key: key,
    tooltip: tooltip,
    onPressed: onPressed,
    padding: EdgeInsets.zero,
    visualDensity: VisualDensity.compact,
    iconSize: 20,
    constraints: const BoxConstraints.tightFor(width: 44, height: 44),
    icon: Icon(icon, size: 20),
  );

  /// 对话历史是**独立**的左侧浮层（不是 `Scaffold.drawer`）：点标题栏「历史」从左边滑出，
  /// 点空白处、返回键或面板右上角都能收起。设置/工具在汉堡抽屉里，两边互不掺杂。
  Future<void> _openHistory() async {
    final width = MediaQuery.sizeOf(context).width;
    final panelWidth = width >= 400 ? 320.0 : width * 0.88;
    await showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: '关闭对话历史',
      barrierColor: Colors.black.withValues(alpha: 0.32),
      transitionDuration: const Duration(milliseconds: 220),
      pageBuilder: (dialogContext, _, _) => Align(
        alignment: Alignment.centerLeft,
        child: SizedBox(
          width: panelWidth,
          height: double.infinity,
          child: CodexHistoryPanel(
            state: state,
            onClose: () => Navigator.of(dialogContext).maybePop(),
            onNewTask: () async {
              Navigator.of(dialogContext).maybePop();
              await _newTask();
            },
            onOpenThread: (id) async {
              Navigator.of(dialogContext).maybePop();
              await _openThread(id);
            },
          ),
        ),
      ),
      transitionBuilder: (dialogContext, animation, _, child) => SlideTransition(
        position: Tween(
          begin: const Offset(-1, 0),
          end: Offset.zero,
        ).animate(CurvedAnimation(parent: animation, curve: Curves.easeOutCubic, reverseCurve: Curves.easeInCubic)),
        child: child,
      ),
    );
  }

  /// 抽屉里的入口都是 Navigator.push 的二级页：返回键/返回手势直接回到对话。
  void _openPage(Widget page) {
    _scaffoldKey.currentState?.closeDrawer();
    Navigator.of(context).push(codexPageRoute(page));
  }

  void _openContextSettings() => _openPage(CodexContextSettingsPage(state: state));

  Widget _capabilitiesPage() => CodexCapabilitiesPage(
    state: state,
    cwd: _cwd.text,
    embedded: true,
    onUseTool: (tool, instruction) async {
      if (Navigator.of(context).canPop()) Navigator.of(context).pop();
      await state.send(
        'Use the $tool capability for this task:\n$instruction',
        cwd: _cwd.text,
        reasoning: _reasoningLevel,
        approval: _approval,
      );
    },
  );

  Future<void> _openThread(String id) async {
    if (id.isEmpty) return;
    _scaffoldKey.currentState?.closeDrawer();
    await state.resumeThread(id);
  }

  /// 启动后回到上次的会话，而不是让用户先看目录。
  /// 取运行时清单：**优先走 api.github.com**。
  /// 手机网络里 `github.com` 常常不可达（实测 20s 超时 / 404），只有 `api.github.com` 稳定；
  /// 旧实现打 `releases/latest/download/...` 会在这种网络下必失败。
  Future<Map<String, dynamic>> _fetchRuntimeManifest() async {
    // §2.20：清单可能不在 latest（1.7.1 就漏传过），先在最近 10 个 Release 里找。
    // 只有确实一个都没有时才退回 github.com 直链兜底（手机网络里这条通常不可达）。
    try {
      final found = await fetchRuntimeManifestAsset(http.Client());
      if (found != null) return found;
    } on CodexUpdateException {
      // 列不出 Release 时继续走直链兜底，兜底失败再把原因抛给用户。
    }
    final resp = await http
        .get(Uri.parse('$kRuntimeBaseUrl/runtime-arm64-v8a.json'))
        .timeout(const Duration(seconds: 30));
    if (resp.statusCode != 200) throw Exception('清单 HTTP ${resp.statusCode}');
    return jsonDecode(resp.body) as Map<String, dynamic>;
  }

  /// 设备通道没恢复时的提示条：说清「去哪开」，不让用户以为是模型坏了。
  Widget _deviceChannelBanner() => Container(
    key: const Key('device-channel-notice'),
    margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
    padding: const EdgeInsets.fromLTRB(12, 9, 8, 9),
    decoration: BoxDecoration(
      color: const Color(0xfffff7e6),
      borderRadius: BorderRadius.circular(9),
      border: Border.all(color: const Color(0xffe8dcc0)),
    ),
    child: Row(
      children: [
        const Icon(Icons.phonelink_lock_outlined, size: 16, color: Color(0xff8b6a1c)),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            _deviceChannelNotice!,
            style: const TextStyle(fontSize: 12, height: 1.45, color: Color(0xff7a6320)),
          ),
        ),
        TextButton(
          key: const Key('retry-device-channel'),
          onPressed: () {
            _deviceRecheckAttempts = 0;
            unawaited(_checkDeviceChannel());
          },
          child: const Text('重试', style: TextStyle(fontSize: 12, color: Color(0xff7a6320))),
        ),
        TextButton(
          key: const Key('open-accessibility-settings'),
          onPressed: () async {
            await CodexDeviceChannel().openSettings('accessibility');
          },
          child: const Text('去开启', style: TextStyle(fontSize: 12, color: Color(0xff7a6320))),
        ),
        IconButton(
          key: const Key('dismiss-device-channel-notice'),
          visualDensity: VisualDensity.compact,
          icon: const Icon(Icons.close, size: 16, color: Color(0xff7a6320)),
          onPressed: () => setState(() => _deviceChannelNotice = null),
        ),
      ],
    ),
  );

  /// 上次用户开着设备通道就自动恢复，并记住恢复失败的原因给首页提示。
  ///
  /// 真机复现过：更新/重启后通道变关，模型读屏拿到 `device/unavailable`，用户看到的是
  /// 「模型说看不到你的屏幕」——问题其实在 App 这一侧。恢复不了时必须明说，别让模型背锅。
  String? _deviceChannelNotice;

  Future<void> _resumeDeviceChannel() async {
    final notice = await codexResumeDeviceChannel(isAndroid: Platform.isAndroid);
    if (!mounted) return;
    setState(() => _deviceChannelNotice = notice);
    if (notice != null) _scheduleDeviceChannelRecheck();
  }

  /// 静默复查：系统绑定无障碍是异步的（MIUI 上尤其慢），启动那一刻读不到很正常。
  /// 所以提示条不是一锤定音：定时复查，一旦可用就自己消失。
  Future<void> _checkDeviceChannel({bool showNotice = true}) async {
    if (!Platform.isAndroid) return;
    if (!await CodexDeviceChannelPrefs.enabled()) return;
    final notice = await codexResumeDeviceChannel(isAndroid: true);
    if (!mounted) return;
    setState(() => _deviceChannelNotice = showNotice ? notice : (notice == null ? null : _deviceChannelNotice));
    if (notice != null) _scheduleDeviceChannelRecheck();
  }

  Timer? _deviceRecheckTimer;
  int _deviceRecheckAttempts = 0;

  void _scheduleDeviceChannelRecheck() {
    _deviceRecheckTimer?.cancel();
    if (_deviceRecheckAttempts >= 12) return; // 约 1 分钟还没好就一直显示提示，等用户手动点
    _deviceRecheckTimer = Timer(const Duration(seconds: 5), () async {
      if (!mounted) return;
      _deviceRecheckAttempts++;
      await _checkDeviceChannel();
      if (mounted && _deviceChannelNotice == null) _deviceRecheckAttempts = 0;
    });
  }

  /// 安装运行时该走哪条路：**APK 里带了运行时就直接解压**，只有瘦包（没带）才联网下载。
  ///
  /// 之前只看 `kRuntimeBaseUrl` 是否为空，而它永远是常量、非空，于是内置了 286MB 运行时的
  /// 完整包也会去联网下载——真机日志里能看到 `Downloading runtime: https://api.github.com/...`，
  /// 表现就是「装完还要等十几分钟」。`bundledVersion` 只有真带了运行时才有值。
  bool _shouldDownloadRuntime([Map<String, dynamic>? status]) => codexShouldDownloadRuntime(status ?? _runtimeStatus);

  Future<void> _installRuntime() async {
    if (_shouldDownloadRuntime()) {
      await _downloadRuntime();
      return;
    }
    await _runtimeAction('install');
  }

  Future<void> _downloadRuntime() async {
    // 瘦包首次启动：拉运行时清单 → 下载 → 校验 → 安装。
    if (_runtime == null || kRuntimeBaseUrl.isEmpty) return;
    try {
      final data = await _fetchRuntimeManifest();
      final url = (data['url'] ?? '').toString();
      final sha = (data['sha256'] ?? '').toString();
      final version = (data['version'] ?? 'downloaded').toString();
      if (url.isEmpty || sha.isEmpty) throw Exception('运行时清单缺 url/sha256');
      final size = (data['sizeMb'] ?? 0);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('开始下载运行时约 ${size}MB，期间可以切后台')));
      }
      final ok = await _runtime.invokeBool('downloadRuntime', {'url': url, 'sha256': sha, 'version': version});
      if (mounted && ok == true) {
        _acceptRuntime(await _runtime.invoke('connection'));
        await _runtimeAction('start');
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('运行时安装失败，看下方日志')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('下载失败：$e')));
      }
    }
  }

  /// 启动后直接回到上次的会话：主页就是对话，不是会话列表。
  Future<void> _restoreLastConversation() async {
    // 连接前先跟 runtime 对一次地址：bridge 端口每次启动都可能不同，
    // 只靠事件推送会在"服务先起来、界面后订阅"时丢掉新端口。
    // 远程模式不碰本机运行时（不探状态、不改地址）。
    if (_runtime != null && state.connectionMode != 'remote') {
      try {
        final conn = await _runtime.invoke('connection');
        final merged = <String, dynamic>{..._runtimeStatus, ...conn};
        if (merged['phase'] == 'running') _acceptRuntime(merged);
      } catch (_) {}
    }
    final id = state.lastThreadId;
    if (id == null || id.isEmpty || !mounted) return;
    if (state.threadId == id && state.events.isNotEmpty) return;
    await state.resumeThread(id);
  }

  /// 检查更新：读 latest.json（失败回退 GitHub Release）→ 比版本 → 给下载入口。
  ///
  /// 先弹一个「正在检查更新…」的转圈对话框：网络慢时（api.github.com + 清单两跳，
  /// 各 12s 超时）原来没有任何反馈，用户点了以为没反应，就会反复点。
  Future<void> _checkUpdate() async {
    if (_checkingUpdate) return;
    _checkingUpdate = true;
    final navigator = Navigator.of(context, rootNavigator: true);
    var progressOpen = true;
    unawaited(
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => const AlertDialog(
          content: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
              SizedBox(width: 14),
              Flexible(child: Text('正在检查更新…')),
            ],
          ),
        ),
      ),
    );
    void closeProgress() {
      if (!progressOpen) return;
      progressOpen = false;
      if (navigator.canPop()) navigator.pop();
    }

    try {
      final release = await CodexUpdateChecker().check();
      if (!mounted) return;
      closeProgress();
      final newer = _compareVersion(release.version, kAppVersion) > 0;
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(newer ? '发现新版本 ${release.version}' : '已是最新'),
          content: Text(
            newer
                ? '当前：$kAppVersion\n最新：${release.version}\n\n${release.notes.isEmpty ? '（无更新说明）' : release.notes}'
                : '当前版本 $kAppVersion 已经是最新的。',
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
            if (newer)
              FilledButton(
                key: const Key('download-update'),
                onPressed: () async {
                  Navigator.pop(ctx);
                  final target = release.apiAssetUrl ?? release.url;
                  final sha = release.sha256;
                  if (sha == null) {
                    // 没有校验值就只在浏览器打开发布页，绝不盲目下载安装。
                    await const MethodChannel('codex/runtime').invokeMethod<bool>('openUrl', {'url': release.url});
                    return;
                  }
                  try {
                    await const MethodChannel(
                      'codex/runtime',
                    ).invokeMethod<int>('downloadUpdate', {'url': target, 'sha256': sha, 'version': release.version});
                  } catch (error) {
                    if (mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('下载失败：$error')));
                    }
                  }
                },
                child: Text(release.sha256 == null ? '去浏览器下载' : '下载并安装'),
              ),
          ],
        ),
      );
    } on CodexUpdateException catch (error) {
      closeProgress();
      if (!mounted) return;
      // 失败必须弹对话框：SnackBar 会被输入框/底部栏挡住，用户看到的就是「点了没反应」。
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('检查更新失败'),
          content: SelectableText(error.message),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭')),
            FilledButton(
              onPressed: () {
                Navigator.pop(ctx);
                const MethodChannel('codex/runtime').invokeMethod<bool>('openUrl', {'url': codexReleasePageUrl});
              },
              child: const Text('打开发布页'),
            ),
          ],
        ),
      );
    } catch (error) {
      closeProgress();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('检查更新失败'),
          content: SelectableText('$error'),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('关闭'))],
        ),
      );
    } finally {
      _checkingUpdate = false;
    }
  }

  int _compareVersion(String a, String b) {
    List<int> parts(String v) =>
        v.split(RegExp(r'[.+-]')).map((s) => int.tryParse(s.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0).toList();
    final pa = parts(a), pb = parts(b);
    for (var i = 0; i < 3; i++) {
      final x = i < pa.length ? pa[i] : 0;
      final y = i < pb.length ? pb[i] : 0;
      if (x != y) return x.compareTo(y);
    }
    return 0;
  }

  /// 标题 = 当前会话名；还没有会话时就是「新对话」。
  String _taskTitle() {
    final t = state.threads.where((e) => (e['id'] ?? e['threadId']) == state.threadId);
    if (t.isEmpty) return '新对话';
    final title = (t.first['title'] ?? '').toString().trim();
    return title.isEmpty ? '新对话' : title;
  }

  /// 错误横幅要能关掉：它以前换页也一直在，看着像「一直连不上」。
  Widget _errorBanner() => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(18, 0, 18, 8),
    padding: const EdgeInsets.fromLTRB(10, 6, 4, 6),
    decoration: BoxDecoration(color: const Color(0xffffe8e4), borderRadius: BorderRadius.circular(6)),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('错误：${state.error}', style: const TextStyle(color: Color(0xff8b2b20), fontSize: 12.5)),
          ),
        ),
        IconButton(
          key: const Key('dismiss-error'),
          tooltip: '关闭错误提示',
          visualDensity: VisualDensity.compact,
          icon: const Icon(Icons.close, size: 17, color: Color(0xff8b2b20)),
          onPressed: state.clearError,
        ),
      ],
    ),
  );

  /// 运行时状态挪到抽屉里：主界面只留对话。
  Widget _runtimeTile() {
    final phase = (_runtimeStatus['phase'] ?? 'loading').toString();
    final running = phase == 'running';
    final installed =
        _runtimeStatus['installed'] == true || const {'installed', 'starting', 'running', 'stopping'}.contains(phase);
    final label = switch (phase) {
      'notInstalled' => 'Runtime 未安装',
      'installing' => '正在安装 runtime',
      'installed' => 'Runtime 已安装 · 未运行',
      'starting' => '正在启动 Codex',
      'running' => 'Codex 正在运行',
      'stopping' => '正在停止 Codex',
      'error' => 'Runtime 错误',
      _ => '读取 runtime 状态',
    };
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
      decoration: BoxDecoration(color: const Color(0xffe7e9e2), borderRadius: BorderRadius.circular(9)),
      child: Row(
        children: [
          Icon(Icons.circle, size: 8, color: running ? const Color(0xff36845d) : const Color(0xffa0a29a)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              key: const Key('drawer-runtime-label'),
              style: const TextStyle(fontSize: 12),
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (!installed)
            IconButton(
              key: const Key('drawer-install-runtime'),
              tooltip: '安装 Codex runtime',
              visualDensity: VisualDensity.compact,
              onPressed: phase == 'installing' ? null : _installRuntime,
              icon: const Icon(Icons.download_outlined, size: 18),
            ),
          if (installed && !running)
            IconButton(
              tooltip: '启动 Codex app-server',
              visualDensity: VisualDensity.compact,
              onPressed: phase == 'starting' ? null : () => _runtimeAction('start'),
              icon: const Icon(Icons.play_arrow, size: 18),
            ),
          if (running)
            IconButton(
              tooltip: '停止 Codex app-server',
              visualDensity: VisualDensity.compact,
              onPressed: () => _runtimeAction('stop'),
              icon: const Icon(Icons.stop, size: 18),
            ),
          IconButton(
            tooltip: '查看运行日志',
            visualDensity: VisualDensity.compact,
            onPressed: _showRuntimeLogs,
            icon: const Icon(Icons.receipt_long_outlined, size: 18),
          ),
        ],
      ),
    );
  }

  Widget _conversation() {
    if (state.events.isEmpty && !state.busy)
      return Center(
        key: const Key('empty-conversation'),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.terminal, size: 34, color: Color(0xffaaa99f)),
            const SizedBox(height: 12),
            Text(
              state.connected ? '新对话' : '等待本机 Codex 连接',
              style: const TextStyle(fontSize: 17, color: Color(0xff55564f)),
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 40),
              child: Text(
                state.connected ? '直接描述任务开始；历史会话点左上角的历史图标。' : '在设置里检查 Bridge 连接，或启动本机运行时。',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 12, height: 1.5, color: Color(0xff85877d)),
              ),
            ),
          ],
        ),
      );
    final rows = _conversationRows();
    if (rows.isEmpty) return const SizedBox.shrink();
    return ListView.builder(
      controller: _conversationScroll,
      padding: const EdgeInsets.fromLTRB(22, 12, 22, 24),
      itemCount: rows.length,
      itemBuilder: (context, i) => _rowWidget(rows[i]),
    );
  }

  /// 只聚合相邻过程事件；正文仍独立渲染，不把后续思考或工具提前。
  List<_ChatRow> _conversationRows() {
    final events = state.events;
    final keys = chatTurnKeys(events);
    final currentKey = _currentTurnKey();
    final rows = <_ChatRow>[];
    var waiting = _thinkingLive;
    var i = 0;
    while (i < events.length) {
      final key = keys[i];
      if (key == null) {
        rows.add(_EventRow(i++));
        continue;
      }
      var end = i;
      while (end < events.length && keys[end] == key) {
        end++;
      }
      final thinking = [
        for (var n = i; n < end; n++)
          if (_isThinkingEvent(events[n])) n,
      ];
      final live = _thinkingLive && key == currentKey;
      if (live) waiting = false;
      final hasAnswer = events.sublist(i, end).any(_isAnswerEvent);
      var hasHeader = false;
      if (thinking.isEmpty && hasAnswer) {
        if (live) {
          rows.add(const _WaitingRow());
        } else {
          rows.add(_MindRow(turnKey: key, thinking: const [], summaryThinking: const [], anchor: i, live: false));
        }
      }
      while (i < end) {
        if (!_isThinkingEvent(events[i])) {
          rows.add(_EventRow(i++));
          continue;
        }
        final start = i;
        while (i < end && _isThinkingEvent(events[i])) {
          i++;
        }
        rows.add(
          _MindRow(
            turnKey: key,
            thinking: [for (var n = start; n < i; n++) n],
            summaryThinking: thinking,
            anchor: start,
            live: live,
            showHeader: !hasHeader,
          ),
        );
        hasHeader = true;
      }
    }
    // 新回合还没有事件时放在历史之后，不能插到上一轮正文前。
    if (waiting) rows.add(const _WaitingRow());
    return rows;
  }

  Widget _rowWidget(_ChatRow row) => switch (row) {
    _WaitingRow() => _waitingThinkingCard(),
    final _MindRow mind => _mindBlock(mind),
    final _EventRow event => _eventRow(event.index),
  };

  /// 用户消息：右对齐气泡，底色取主题强调色的浅色版（深色主题下同样可辨），圆角 12。
  /// 字号/行距与模型回答（markdown 正文 14 / 1.5）保持一致，只靠对齐 + 底色区分。
  Widget _userBubble(PocketEvent e, int index) {
    final accent = _theme.accent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        GestureDetector(
          key: Key('message-bubble-$index'),
          onLongPress: () => _showMessageActions(index, assistant: false),
          child: Container(
            constraints: const BoxConstraints(maxWidth: 620),
            margin: const EdgeInsets.only(top: 10, left: 48, right: 4),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: accent.withValues(alpha: 0.12),
              border: Border.all(color: accent.withValues(alpha: 0.22)),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(e.payload, style: TextStyle(fontSize: 14, height: 1.5, color: _theme.ink)),
          ),
        ),
        _messageActions(index, assistant: false),
      ],
    );
  }

  /// 单个事件：用户气泡 / 助手正文（可长按弹菜单）/ 工具卡 / 补丁 / 审批。
  Widget _eventRow(int index) {
    final e = state.events[index];
    if (e.type == 'user' || e.type == 'userMessage') return _userBubble(e, index);
    if (e.type == 'step') return _stepLine(e);
    if (e.type == 'diff') return _diffCard(e, index);
    if (e.type.startsWith('tool.')) return _toolCard(e, index);
    if (e.type == 'approval.request') return _approvalCard(e);
    final approval = e.type == 'approval.request';
    final tool =
        e.type.startsWith('tool.') ||
        e.type.contains('command') ||
        e.itemType == 'commandExecution' ||
        e.itemType == 'tool';
    // 上游重试提示（"Reconnecting... 1/5"）可能混进正文（live 与历史 items 都有）：
    // 按行剔掉；只剩噪音的一条直接不渲染，状态只用输入框上方那行灰字。
    final body = CodexPocketState.stripRetryLines(e.payload);
    if (body.trim().isEmpty) return const SizedBox.shrink();
    final answer = _isAnswerEvent(e);
    return GestureDetector(
      onLongPress: answer ? () => _showMessageActions(index, assistant: true) : null,
      child: Container(
        width: double.infinity,
        constraints: const BoxConstraints(maxWidth: 780),
        margin: const EdgeInsets.symmetric(vertical: 8),
        padding: const EdgeInsets.all(12),
        // 模型回答不套气泡：只有工具输出才有底色，正文保持无背景（左对齐整宽）。
        decoration: tool ? BoxDecoration(color: const Color(0xffeeefeb), borderRadius: BorderRadius.circular(7)) : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (tool)
              const Text(
                '工具输出',
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Color(0xff66675f)),
              ),
            if (tool) const SizedBox(height: 5),
            GptMarkdown(
              body,
              style: const TextStyle(fontFamily: 'Roboto', fontSize: 14, height: 1.5, color: Color(0xff282925)),
              styleSheet: const GptMarkdownStyleSheet(
                codeBlock: CodeBlockStyle(
                  backgroundColor: Color(0xffeeefeb),
                  borderColor: Color(0xffe0e1dc),
                  borderRadius: Radius.circular(8),
                  fontFamily: 'JetBrainsMono',
                  textColor: Color(0xff292a27),
                  showCopyButton: true,
                ),
                inlineCode: InlineCodeStyle(
                  fontFamily: 'JetBrainsMono',
                  fontFamilyFallback: ['Roboto', 'Noto Sans CJK SC'],
                  backgroundColor: Color(0xffeeefeb),
                  color: Color(0xff292a27),
                ),
              ),
            ),
            if (approval)
              Wrap(
                spacing: 8,
                children: [
                  OutlinedButton(onPressed: () => state.approve(e.approvalId ?? '', true), child: const Text('批准一次')),
                  OutlinedButton(
                    onPressed: () => state.approve(e.approvalId ?? '', true, forSession: true),
                    child: const Text('本会话允许'),
                  ),
                  TextButton(onPressed: () => state.approve(e.approvalId ?? '', false), child: const Text('拒绝')),
                ],
              ),
            if (answer) Align(alignment: Alignment.centerRight, child: _messageActions(index, assistant: true)),
          ],
        ),
      ),
    );
  }

  /// 每条消息下方的快捷操作：复制；助手回答还能「分支」，用户消息还能「编辑并重发」。
  Widget _messageActions(int index, {required bool assistant}) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (assistant)
        _messageAction(
          key: Key('branch-message-$index'),
          icon: Icons.call_split,
          tooltip: '从这条回答分支',
          onPressed: () => _branchFromMessage(index),
        )
      else
        _messageAction(
          key: Key('edit-message-$index'),
          icon: Icons.edit_outlined,
          tooltip: '编辑并重发',
          onPressed: () => _editUserMessage(index),
        ),
      _messageAction(
        key: Key('copy-message-$index'),
        icon: Icons.copy_all_outlined,
        tooltip: '复制',
        onPressed: () => _copyMessage(state.events[index]),
      ),
    ],
  );

  Widget _messageAction({
    required Key key,
    required IconData icon,
    required String tooltip,
    required VoidCallback onPressed,
  }) => IconButton(
    key: key,
    tooltip: tooltip,
    icon: Icon(icon, size: 15),
    color: const Color(0xff8b8d83),
    visualDensity: VisualDensity.compact,
    padding: EdgeInsets.zero,
    constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
    onPressed: onPressed,
  );

  Future<void> _copyMessage(PocketEvent event) async {
    await Clipboard.setData(ClipboardData(text: event.payload));
    if (mounted) showCodexMessage(context, '已复制');
  }

  /// 长按消息弹出的同一组操作（鼠标/触摸都走得通）。
  Future<void> _showMessageActions(int index, {required bool assistant}) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: _theme.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              key: Key('menu-copy-$index'),
              leading: const Icon(Icons.copy_all_outlined),
              title: const Text('复制'),
              onTap: () => Navigator.pop(ctx, 'copy'),
            ),
            if (assistant)
              ListTile(
                key: Key('menu-branch-$index'),
                leading: const Icon(Icons.call_split),
                title: const Text('从这条回答分支'),
                onTap: () => Navigator.pop(ctx, 'branch'),
              ),
            if (!assistant)
              ListTile(
                key: Key('menu-edit-$index'),
                leading: const Icon(Icons.edit_outlined),
                title: const Text('编辑并重发'),
                onTap: () => Navigator.pop(ctx, 'edit'),
              ),
            if (!state.busy && state.turnIdOfMessage(index) != null)
              ListTile(
                key: Key('menu-revert-$index'),
                leading: const Icon(Icons.history),
                title: const Text('删除此回合及后续对话…'),
                onTap: () => Navigator.pop(ctx, 'revert'),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (!mounted || action == null || index >= state.events.length) return;
    switch (action) {
      case 'copy':
        await _copyMessage(state.events[index]);
      case 'branch':
        await _branchFromMessage(index);
      case 'edit':
        await _editUserMessage(index);
      case 'revert':
        await _revertMessage(index);
    }
  }

  Future<void> _revertMessage(int index) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除此回合及后续对话？'),
        content: const Text('将删除该消息所在的整个回合及其后所有回合。只影响 Codex 对话历史，不会撤销代码、文件、命令或外部服务的变更，且本界面不能一键恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            key: const Key('confirm-revert'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除对话'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final reverted = await state.revertMessage(index);
    if (!mounted) return;
    if (!reverted) {
      showCodexMessage(context, '删除失败：${state.error ?? '未知原因'}');
      return;
    }
    _resetTurnState();
    showCodexMessage(context, '对话历史已删除并重新读取；文件改动未撤销');
  }

  /// 从这条回答分支：`lastTurnId` 用这条回答所属回合，桥做 codex 原生 fork。
  /// 会新开一个会话，所以先确认一次（误触一下就把对话切走很烦）。
  Future<void> _branchFromMessage(int index) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('从这条回答分支'),
        content: const Text('会以这条回答为止的内容新建一个会话，当前会话保留。继续？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            key: const Key('confirm-branch'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('分支'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final created = await state.branchFromTurn(state.turnIdOfMessage(index));
    if (!mounted) return;
    if (created == null) {
      showCodexMessage(context, '分支失败：${state.error ?? '未知原因'}');
      return;
    }
    _resetTurnState();
    showCodexMessage(context, '已从这条回答分支（新会话）');
  }

  /// 编辑用户消息后重发：先分支到这条消息之前那一轮，再发新文本。
  /// 第一条消息没有更早回合可分支（桥整段照抄），state 会把旧内容从界面上清掉，
  /// 不会出现两条一样的用户消息。
  Future<void> _editUserMessage(int index) async {
    final event = state.events[index];
    final field = TextEditingController(text: event.payload);
    final edited = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('编辑并重发'),
        content: TextField(
          key: const Key('edit-message-field'),
          controller: field,
          autofocus: true,
          minLines: 3,
          maxLines: 10,
          decoration: const InputDecoration(border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, field.text), child: const Text('重发')),
        ],
      ),
    );
    if (!mounted || edited == null || edited.trim().isEmpty) return;
    await state.editAndResend(
      index,
      edited,
      cwd: _cwd.text,
      reasoning: _reasoningLevel,
      approval: _approval,
      sandbox: _sandboxMode.isEmpty ? null : _sandboxMode,
    );
    if (!mounted) return;
    if (state.error != null) {
      showCodexMessage(context, '重发失败：${state.error}');
      return;
    }
    _resetTurnState();
    showCodexMessage(context, '已从这条消息之前分支，并重发新的内容');
  }

  /// 换了会话（新建/分支/编辑重发）之后，思考计时与折叠状态都属于上一条会话。
  void _resetTurnState() {
    _thinkingTicker?.cancel();
    _thinkingTicker = null;
    _wasBusy = state.busy;
    _thinkingStartedAt = state.busy ? DateTime.now() : null;
    _thinkingStalled = false;
    _streamProgress.begin(state, DateTime.now());
    _turnStartIndex = state.events.length;
    _turnSeconds.clear();
    if (mounted) setState(() {});
  }

  /// 每条记录的展开状态；思考默认展开（要能看见思考在流），工具输出默认收起。
  final Map<String, bool> _open = {};
  String _keyOf(PocketEvent e, int i) => e.itemId ?? '${e.type}#$i';
  bool _isOpen(String key, bool fallback) => _open[key] ?? fallback;
  void _toggle(String key, bool fallback) => setState(() => _open[key] = !_isOpen(key, fallback));

  bool _isAnswerEvent(PocketEvent event) =>
      event.type == 'text.delta' ||
      event.type == 'agent_message' ||
      event.type == 'agentMessage' ||
      event.itemType == 'agent_message';

  /// 过程链内容：reasoning、工具、步骤与 diff 都归入同一个回合块。
  bool _isThinkingEvent(PocketEvent event) =>
      _isReasoningEvent(event) || event.type.startsWith('tool.') || event.type == 'step' || event.type == 'diff';

  bool _isReasoningEvent(PocketEvent event) => event.type == 'reasoning.delta' || event.type == 'reasoning';

  String get _thinkingElapsed {
    final started = _thinkingStartedAt;
    if (started == null) return '';
    final seconds = DateTime.now().difference(started).inSeconds;
    return seconds < 60 ? '${seconds}s' : '${seconds ~/ 60}m ${seconds % 60}s';
  }

  Widget _waitingThinkingCard() => Container(
    key: const Key('live-thinking-card'),
    width: double.infinity,
    margin: const EdgeInsets.symmetric(vertical: 6),
    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
    decoration: BoxDecoration(
      color: const Color(0xfff0f1ec),
      borderRadius: BorderRadius.circular(9),
      border: const Border(left: BorderSide(color: Color(0xff8a6d1f), width: 2)),
    ),
    child: Row(
      children: [
        const SizedBox(
          width: 13,
          height: 13,
          child: CircularProgressIndicator(strokeWidth: 1.8, color: Color(0xff8a6d1f)),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            'Codex 正在思考${_thinkingElapsed.isEmpty ? '…' : ' · $_thinkingElapsed'}',
            style: const TextStyle(fontSize: 12, color: Color(0xff8a6d1f)),
          ),
        ),
      ],
    ),
  );

  /// 相邻过程段共享同一回合的展开选择；仅第一段显示摘要，正文保持原位置。
  /// 完成后保留摘要，未返回思考内容的回答也可展开查看说明。
  Widget _mindBlock(_MindRow row) {
    final events = state.events;
    final openKey = 'mind:${row.turnKey}';
    final live = row.live;
    final open = _isOpen(openKey, live);
    if (!row.showHeader && !open) return const SizedBox.shrink();
    final elapsed = _turnSeconds[row.turnKey];
    final stepCount = row.summaryThinking
        .where(
          (index) =>
              !_isReasoningEvent(events[index]) &&
              !(events[index].type.startsWith('tool.') && _hasStepCompanion(events[index], row.summaryThinking)),
        )
        .length;
    final protocolMs = row.summaryThinking
        .map((index) => events[index].durationMs)
        .whereType<int>()
        .fold<int>(0, (total, value) => total + value);
    // 协议的 durationMs 偶有几个工具报 0（被审批打断/瞬间返回），此时用界面实测耗时兜底，
    // 否则整轮会显示成没有任何信息量的「0.0s」。
    final summarySeconds = protocolMs >= 1000
        ? (protocolMs / 1000).toStringAsFixed(1)
        : (elapsed ?? 0) > 0
        ? '$elapsed'
        : null;
    return Container(
      key: Key('reasoning-block-${row.anchor}'),
      width: double.infinity,
      constraints: const BoxConstraints(maxWidth: 780),
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
      decoration: BoxDecoration(
        color: live || open ? _theme.surface.withValues(alpha: 0.94) : Colors.transparent,
        border: Border(left: BorderSide(color: live ? const Color(0xff8a6d1f) : const Color(0xffd9dad4), width: 2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (row.showHeader)
            InkWell(
              key: Key('reasoning-toggle-${row.anchor}'),
              onTap: () => _toggle(openKey, live),
              child: Row(
                children: [
                  if (live)
                    const Padding(
                      padding: EdgeInsets.only(right: 6),
                      child: SizedBox(
                        width: 11,
                        height: 11,
                        child: CircularProgressIndicator(strokeWidth: 1.6, color: Color(0xff8a6d1f)),
                      ),
                    ),
                  Icon(open ? Icons.expand_more : Icons.chevron_right, size: 16, color: const Color(0xff8a8b82)),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      live
                          ? '${_liveActivity(row.summaryThinking)}${_thinkingElapsed.isEmpty ? '…' : ' · $_thinkingElapsed'}'
                          : stepCount > 0
                          ? '执行 $stepCount 步${summarySeconds == null ? '' : ' · ${summarySeconds}s'}${open ? '' : ' · 点击查看过程'}'
                          : '已完成${(elapsed ?? 0) > 0 ? ' · ${elapsed}s' : ''}${open ? '' : ' · 点击查看过程'}',
                      key: live ? const Key('live-reasoning-label') : Key('reasoning-done-${row.anchor}'),
                      style: TextStyle(fontSize: 12, color: live ? const Color(0xff8a6d1f) : const Color(0xff3c6b48)),
                    ),
                  ),
                ],
              ),
            ),
          if (open)
            _LiveTimelineViewport(
              key: ValueKey('timeline:${row.turnKey}:${row.anchor}'),
              live: live,
              revision: state.streamRevision,
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: _mindBody(row, events)),
            ),
        ],
      ),
    );
  }

  List<Widget> _mindBody(_MindRow row, List<PocketEvent> events) {
    final hasReasoning = row.thinking.any(
      (index) => _isReasoningEvent(events[index]) && events[index].payload.isNotEmpty,
    );
    final onlyEmptyReasoning = row.thinking.every((index) => _isReasoningEvent(events[index]));
    return [
      if (!hasReasoning && onlyEmptyReasoning)
        const Padding(
          padding: EdgeInsets.fromLTRB(20, 5, 0, 2),
          child: Text(
            '（这次回复没有返回思考内容）',
            key: Key('reasoning-empty-body'),
            style: TextStyle(fontSize: 12.5, height: 1.6, color: Color(0xff8a8b82)),
          ),
        ),
      for (final index in row.thinking)
        if (_isReasoningEvent(events[index]))
          if (events[index].payload.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 5, 0, 2),
              child: Text(
                events[index].payload,
                key: Key('reasoning-body-$index'),
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.6,
                  fontStyle: FontStyle.italic,
                  color: Color(0xff6f7069),
                ),
              ),
            )
          else
            const SizedBox.shrink()
        else if (events[index].type.startsWith('tool.') && _hasStepCompanion(events[index], row.summaryThinking))
          const SizedBox.shrink()
        else
          _eventRow(index),
    ];
  }

  bool _hasStepCompanion(PocketEvent event, List<int> indices) =>
      event.itemId != null &&
      indices.any(
        (index) =>
            state.events[index].type == 'step' &&
            state.events[index].itemId == event.itemId &&
            state.events[index].turnId == event.turnId,
      );

  String _liveActivity(List<int> indices) =>
      _streamProgress.activityLabel(indices.map((index) => state.events[index]), DateTime.now());

  Widget _toolCard(PocketEvent e, int i) {
    final key = _keyOf(e, i);
    final running = (e.status ?? 'running') == 'running';
    final failed = (e.status ?? '') == 'failed';
    final open = _isOpen(key, failed);
    final label = (e.name ?? '').isEmpty ? '命令' : e.name!;
    final out = e.payload;
    final arguments = e.arguments;
    final badge = failed
        ? (e.exitCode != null ? '退出 ${e.exitCode}' : '失败')
        : running
        ? '运行中'
        : '完成';
    final tone = failed
        ? const Color(0xff9c3b32)
        : running
        ? const Color(0xff8a6d1f)
        : const Color(0xff3f6b45);
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(maxWidth: 780),
      margin: const EdgeInsets.symmetric(vertical: 7),
      decoration: BoxDecoration(
        color: const Color(0xfff1f1ec),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: failed ? const Color(0xffe2c7c3) : const Color(0xffe4e4de)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: Key('tool-toggle-$i'),
            onTap: out.isEmpty && arguments.isEmpty ? null : () => _toggle(key, failed),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
              child: Row(
                children: [
                  Icon(
                    running ? Icons.sync : (failed ? Icons.error_outline : Icons.check_circle_outline),
                    size: 15,
                    color: tone,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 12.5, color: Color(0xff2b2c28)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(badge, style: TextStyle(fontSize: 11, color: tone)),
                  if (out.isNotEmpty || arguments.isNotEmpty) ...[
                    const SizedBox(width: 3),
                    Icon(open ? Icons.expand_less : Icons.expand_more, size: 15, color: const Color(0xff8a8b82)),
                  ],
                ],
              ),
            ),
          ),
          if (arguments.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(11, 0, 11, 8),
              child: Text(
                arguments,
                key: Key('tool-args-$i'),
                maxLines: open ? null : 2,
                overflow: open ? null : TextOverflow.ellipsis,
                style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 11.5, color: Color(0xff6f7069)),
              ),
            ),
          if (open && out.isNotEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(11, 9, 11, 10),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: Color(0xffe4e4de))),
              ),
              child: SelectableText(
                out,
                style: const TextStyle(
                  fontFamily: 'JetBrainsMono',
                  fontSize: 11.5,
                  height: 1.45,
                  color: Color(0xff3a3b36),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 过程流的一步：一行「● 读取 server.mjs · 0.2s ✓」，点开看输出。
  /// 顺序就是事件顺序，所以思考/工具/正文按真实时序交错，而不是按类型分区。
  Widget _stepLine(PocketEvent e) {
    final key = _keyOf(e, e.itemId?.hashCode ?? 0);
    final companionIndex = e.itemId == null
        ? -1
        : state.events.lastIndexWhere(
            (event) => event.type.startsWith('tool.') && event.itemId == e.itemId && event.turnId == e.turnId,
          );
    final companion = companionIndex < 0 ? null : state.events[companionIndex];
    final arguments = companion?.arguments ?? '';
    final stepOutput = e.payload.trim();
    final toolOutput = companion?.payload.trim() ?? '';
    final output = toolOutput.startsWith(stepOutput)
        ? toolOutput
        : stepOutput.startsWith(toolOutput)
        ? stepOutput
        : '$stepOutput\n$toolOutput';
    final failed = (e.status ?? '').toLowerCase().contains('fail') || (e.exitCode ?? 0) != 0;
    final running = (e.status ?? 'running') == 'running';
    final open = _isOpen(key, failed);
    final title = codexStepTitle(e);
    final tone = failed
        ? const Color(0xff9c2f24)
        : running
        ? const Color(0xff7a6320)
        : const Color(0xff3a3b36);
    final seconds = e.durationMs == null
        ? ''
        : ' · ${(e.durationMs! / 1000).toStringAsFixed(e.durationMs! < 1000 ? 2 : 1)}s';
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(maxWidth: 780),
      margin: const EdgeInsets.only(top: 2, bottom: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: Key('step-$key'),
            onTap: output.isEmpty && arguments.isEmpty ? null : () => _toggle(key, failed),
            borderRadius: BorderRadius.circular(7),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 5),
              child: Row(
                children: [
                  Icon(
                    failed
                        ? Icons.error_outline
                        : running
                        ? Icons.radio_button_unchecked
                        : Icons.check_circle_outline,
                    size: 14,
                    color: tone,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.5, height: 1.3, color: tone),
                    ),
                  ),
                  if (seconds.isNotEmpty) Text(seconds, style: const TextStyle(fontSize: 11, color: Color(0xff8a8b82))),
                  if (output.isNotEmpty) ...[
                    const SizedBox(width: 4),
                    Icon(open ? Icons.expand_less : Icons.expand_more, size: 15, color: const Color(0xff8a8b82)),
                  ],
                ],
              ),
            ),
          ),
          if (arguments.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 25, bottom: 4),
              child: Text(
                arguments,
                key: Key('step-args-$key'),
                maxLines: open ? null : 2,
                overflow: open ? null : TextOverflow.ellipsis,
                style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 11.5, color: Color(0xff6f7069)),
              ),
            ),
          if (open && output.isNotEmpty)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(left: 21, top: 2),
              padding: const EdgeInsets.fromLTRB(9, 7, 9, 8),
              decoration: BoxDecoration(
                color: const Color(0xfff4f4ef),
                borderRadius: BorderRadius.circular(7),
                border: Border.all(color: const Color(0xffe4e4de)),
              ),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Text(
                  output,
                  style: const TextStyle(
                    fontFamily: 'JetBrainsMono',
                    fontSize: 11,
                    height: 1.45,
                    color: Color(0xff3a3b36),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _diffCard(PocketEvent e, int i) {
    final key = _keyOf(e, i);
    final open = _isOpen(key, false);
    final lines = e.payload.split('\n');
    final added = lines.where((line) => line.startsWith('+') && !line.startsWith('+++')).length;
    final removed = lines.where((line) => line.startsWith('-') && !line.startsWith('---')).length;
    final pathMatch = RegExp(r'^diff --git a/(.+?) b/', multiLine: true).firstMatch(e.payload);
    final title = pathMatch?.group(1) ?? '本回合文件变更';
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(maxWidth: 780),
      margin: const EdgeInsets.symmetric(vertical: 7),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: const Color(0xffe4e4de)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            key: Key('diff-toggle-$i'),
            onTap: () => _toggle(key, false),
            borderRadius: BorderRadius.circular(9),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(11, 5, 5, 5),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600),
                        ),
                        Text(
                          '补丁 · +$added / −$removed',
                          style: const TextStyle(fontSize: 10.5, color: Color(0xff66675f)),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    key: Key('copy-diff-$i'),
                    tooltip: '复制完整补丁',
                    visualDensity: VisualDensity.compact,
                    onPressed: () => _copyMessage(e),
                    icon: const Icon(Icons.copy_all_outlined, size: 16),
                  ),
                  Icon(open ? Icons.expand_less : Icons.expand_more, size: 17, color: const Color(0xff8a8b82)),
                  const SizedBox(width: 5),
                ],
              ),
            ),
          ),
          if (open) ...[
            const Divider(height: 1, color: Color(0xffecece6)),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final line in lines.take(400))
                    Container(
                      color: line.startsWith('+') && !line.startsWith('+++')
                          ? const Color(0xffeaf5ec)
                          : line.startsWith('-') && !line.startsWith('---')
                          ? const Color(0xfffbeceb)
                          : Colors.transparent,
                      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 1),
                      child: Text(
                        line.isEmpty ? ' ' : line,
                        softWrap: false,
                        style: TextStyle(
                          fontFamily: 'JetBrainsMono',
                          fontSize: 11.5,
                          height: 1.4,
                          color: line.startsWith('@@') ? const Color(0xff3a5f8a) : const Color(0xff3a3b36),
                        ),
                      ),
                    ),
                  if (lines.length > 400)
                    const Padding(
                      padding: EdgeInsets.all(11),
                      child: Text('仅显示前 400 行；复制按钮仍复制完整补丁', style: TextStyle(fontSize: 11)),
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _approvalCard(PocketEvent e) => Container(
    width: double.infinity,
    constraints: const BoxConstraints(maxWidth: 780),
    margin: const EdgeInsets.symmetric(vertical: 7),
    padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
    decoration: BoxDecoration(
      color: const Color(0xfffdf8ec),
      borderRadius: BorderRadius.circular(9),
      border: Border.all(color: const Color(0xffe8dcc0)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '要执行，批准？',
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xff7a6320)),
        ),
        if (e.payload.isNotEmpty) ...[
          const SizedBox(height: 6),
          SelectableText(
            e.payload,
            style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 11.5, height: 1.45, color: Color(0xff4a4433)),
          ),
          const SizedBox(height: 8),
        ],
        Wrap(
          spacing: 8,
          children: [
            OutlinedButton(onPressed: () => state.approve(e.approvalId ?? '', true), child: const Text('批准一次')),
            OutlinedButton(
              onPressed: () => state.approve(e.approvalId ?? '', true, forSession: true),
              child: const Text('本会话允许'),
            ),
            TextButton(onPressed: () => state.approve(e.approvalId ?? '', false), child: const Text('拒绝')),
          ],
        ),
      ],
    ),
  );

  /// Agent 状态条：目标 + 计划进度 + 上下文用量，点开看每一步。
  bool _agentOpen = false;

  Widget _agentStrip() {
    final goal = state.goal;
    final usage = state.usage;
    final hasPlan = state.plan.isNotEmpty;
    if (goal == null && !hasPlan && usage == null) return const SizedBox.shrink();
    String st(Map<String, dynamic> s) => (s['status'] ?? '').toString();
    final done = state.plan.where((s) => st(s).contains('completed')).length;
    final active = state.plan.where((s) => st(s).contains('progress')).toList();
    final tokens = usage?['totalTokens'] ?? usage?['total_tokens'] ?? goal?['tokensUsed'];
    final budget = goal?['tokenBudget'];
    final objective = goal?['objective']?.toString();
    final status = goal?['status']?.toString();
    return Container(
      margin: const EdgeInsets.fromLTRB(18, 0, 18, 6),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: BoxDecoration(
        color: const Color(0xfff4f4ef),
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: const Color(0xffe6e6df)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _agentOpen = !_agentOpen),
            child: Row(
              children: [
                const Icon(Icons.track_changes, size: 15, color: Color(0xff6f7069)),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    (objective != null && objective.isNotEmpty) ? objective : '这个会话还没有设定目标',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12.5, color: Color(0xff2b2c28)),
                  ),
                ),
                if (hasPlan)
                  Text('$done/${state.plan.length}', style: const TextStyle(fontSize: 11, color: Color(0xff6f7069))),
                if (tokens != null) ...[
                  const SizedBox(width: 8),
                  Text(
                    budget == null ? '$tokens tok' : '$tokens/$budget',
                    style: const TextStyle(fontSize: 11, color: Color(0xff8a8b82)),
                  ),
                ],
                const SizedBox(width: 4),
                Icon(_agentOpen ? Icons.expand_less : Icons.expand_more, size: 15, color: const Color(0xff8a8b82)),
              ],
            ),
          ),
          if (!_agentOpen && active.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(21, 4, 0, 0),
              child: Text(
                '→ ${active.first['step']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11.5, color: Color(0xff8a6d1f)),
              ),
            ),
          if (_agentOpen) ...[
            const SizedBox(height: 6),
            for (final step in state.plan)
              _agentRow(
                st(step).contains('completed')
                    ? '✓'
                    : st(step).contains('progress')
                    ? '→'
                    : '·',
                (step['step'] ?? '').toString(),
              ),
            if (status != null) _agentRow('·', '目标状态：$status'),
            const SizedBox(height: 4),
            Wrap(
              spacing: 6,
              children: [
                TextButton(onPressed: state.busy ? null : state.compact, child: const Text('压缩上下文')),
                TextButton(onPressed: _editGoal, child: const Text('设定目标')),
                if (goal != null) TextButton(onPressed: state.clearGoal, child: const Text('清除目标')),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _agentRow(String mark, String text) => Padding(
    padding: const EdgeInsets.fromLTRB(21, 2, 0, 2),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 16,
          child: Text(mark, style: const TextStyle(fontSize: 12, color: Color(0xff6f7069))),
        ),
        Expanded(
          child: Text(text, style: const TextStyle(fontSize: 12, height: 1.45, color: Color(0xff3a3b36))),
        ),
      ],
    ),
  );

  Future<void> _editGoal() async {
    final controller = TextEditingController(text: state.goal?['objective']?.toString() ?? '');
    final value = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('设定目标'),
        content: TextField(
          controller: controller,
          minLines: 2,
          maxLines: 4,
          decoration: const InputDecoration(hintText: '这个会话要达成什么'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('保存')),
        ],
      ),
    );
    if (value != null && value.trim().isNotEmpty) await state.setGoal(value.trim());
  }

  /// 思考中反馈：有进度感，不用盯着空白等。
  /// 上游重试提示单独一行灰字：不再当成聊天内容堆在对话里。
  Widget _statusHintLine(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(22, 0, 22, 4),
    child: Row(
      children: [
        const Icon(Icons.wifi_tethering, size: 13, color: Color(0xff9a7b2f)),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            key: const Key('status-hint'),
            style: const TextStyle(fontSize: 11.5, color: Color(0xff9a7b2f)),
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    ),
  );

  /// 权限档位：写进每个回合的 sandboxPolicy，真正影响命令与文件操作。
  Widget _composerPermissionChip() {
    final label = switch (_sandboxMode) {
      'read-only' => '只读',
      _ => '完全权限',
    };
    final tone = _sandboxMode == 'read-only' ? const Color(0xff6f7069) : const Color(0xff9c3b32);
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: InkWell(
        key: const Key('composer-permission-chip'),
        onTap: _pickPermission,
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
          decoration: BoxDecoration(
            color: const Color(0xfff1f1ec),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: const Color(0xffe2e2db)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(_sandboxMode == 'read-only' ? Icons.lock_outline : Icons.shield_outlined, size: 12, color: tone),
              const SizedBox(width: 4),
              Text(label, style: TextStyle(fontSize: 11.5, color: tone)),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _pickPermission() async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: _theme.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 14, 16, 6),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text('权限范围', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              ),
            ),
            for (final option in const [
              ('', '完全权限（默认）', '不指定沙箱：沿用本机 Codex 配置，可以真正执行命令、读写文件'),
              ('read-only', '只读', '只能读取文件与查看信息，不能改动任何内容'),
            ])
              RadioListTile<String>(
                key: Key('permission-option-${option.$1}'),
                value: option.$1,
                groupValue: _sandboxMode,
                title: Text(option.$2),
                subtitle: Text(option.$3, style: const TextStyle(fontSize: 11.5, height: 1.4)),
                onChanged: (value) => Navigator.pop(ctx, value),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (picked == null || picked == _sandboxMode) return;
    setState(() => _sandboxMode = picked);
    await CodexPrefs.saveSandboxMode(picked);
  }

  /// 输入框内联模型切换：不用每次点设置。
  Widget _composerModelChip() {
    // 以当前活动渠道为准：本地 config 可能是上一次会话的旧模型，会让标签与实际请求不一致。
    final channelModel = state.activeChannel?['model']?.toString();
    final model = (channelModel != null && channelModel.trim().isNotEmpty)
        ? channelModel
        : state.config['model']?.toString();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: InkWell(
        onTap: _pickModel,
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
          decoration: BoxDecoration(
            color: const Color(0xfff1f1ec),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: const Color(0xffe2e2db)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.memory, size: 12, color: Color(0xff6f7069)),
              const SizedBox(width: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 74),
                child: Text(
                  (model == null || model.isEmpty) ? '选模型' : model,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5, color: Color(0xff3a3b36)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _composerBox() => Padding(
    padding: EdgeInsets.fromLTRB(18, 8, 18, MediaQuery.viewInsetsOf(context).bottom > 0 ? 8 : 18),
    child: Container(
      constraints: const BoxConstraints(maxWidth: 860),
      padding: const EdgeInsets.fromLTRB(16, 7, 8, 8),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xffe7e7e1)),
      ),
      child: Column(
        children: [
          if (_attachments.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: CodexAttachmentTray(
                key: const Key('composer-attachments'),
                attachments: _attachments,
                messageText: _composer.text,
                onRemove: (attachment) => setState(() => _attachments = [..._attachments]..remove(attachment)),
              ),
            ),
          TextField(
            controller: _composer,
            minLines: 2,
            maxLines: 7,
            textInputAction: TextInputAction.newline,
            decoration: const InputDecoration(hintText: '描述你要完成的任务', border: InputBorder.none),
          ),
          Row(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      IconButton(
                        key: const Key('add-attachment'),
                        tooltip: '添加图片或 MD/TXT 附件',
                        visualDensity: VisualDensity.compact,
                        onPressed: state.busy ? null : _pickAttachments,
                        icon: const Icon(Icons.attach_file, size: 19),
                      ),
                      IconButton(
                        tooltip: '选择项目文件夹',
                        visualDensity: VisualDensity.compact,
                        onPressed: _chooseFolder,
                        icon: const Icon(Icons.folder_open, size: 18),
                      ),
                      CodexContextRing(
                        key: const Key('composer-context-ring'),
                        state: state,
                        onTap: _openContextSettings,
                        size: 24,
                      ),
                      _composerModelChip(),
                      _composerPermissionChip(),
                      const SizedBox(width: 2),
                    ],
                  ),
                ),
              ),
              if (state.busy) ...[
                if (_composer.text.trim().isNotEmpty && state.currentTurnId != null)
                  IconButton(
                    key: const Key('steer-current-turn'),
                    tooltip: '插话到当前回合（不打断）',
                    onPressed: () async {
                      final text = _composer.text.trim();
                      if (text.isEmpty) return;
                      await state.steer(text);
                      if (!mounted) return;
                      if (state.error == null) {
                        _composer.clear();
                        showCodexMessage(context, '已插话，原回合继续运行');
                      } else {
                        showCodexMessage(context, '插话失败：${state.error}');
                      }
                    },
                    icon: const Icon(Icons.subdirectory_arrow_left),
                  ),
                IconButton(tooltip: '停止', onPressed: state.interrupt, icon: const Icon(Icons.stop_circle_outlined)),
              ] else
                IconButton.filled(
                  tooltip: '发送',
                  onPressed: state.connected ? _send : null,
                  style: IconButton.styleFrom(backgroundColor: const Color(0xff252622), foregroundColor: Colors.white),
                  icon: const Icon(Icons.arrow_upward, size: 19),
                ),
            ],
          ),
        ],
      ),
    ),
  );
  Future<void> _pickAttachments() async {
    final action = await showCodexAttachmentMenu(context);
    if (action == null || !mounted) return;
    try {
      final selected = switch (action) {
        CodexAttachmentAction.images => await _attachmentPicker.pickImages(),
        CodexAttachmentAction.files => await _attachmentPicker.pickFiles(),
        CodexAttachmentAction.clipboardImage => await _attachmentPicker.readClipboardImage(),
      };
      if (selected.cancelled || !mounted) return;
      final merged = mergeCodexAttachments(_attachments, selected.attachments);
      setState(() => _attachments = [...merged.attachments]);
      final warnings = [...selected.warnings, ...merged.warnings];
      if (warnings.isNotEmpty) showCodexMessage(context, warnings.join('\n'));
    } on PlatformException catch (error) {
      if (mounted) showCodexMessage(context, '附件读取失败：${error.message ?? error.code}');
    } on FormatException catch (error) {
      if (mounted) showCodexMessage(context, '附件读取失败：${error.message}');
    }
  }

  Future<bool> _waitForCurrentTurn() async {
    if (!state.busy) return state.error == null;
    final completer = Completer<bool>();
    late final VoidCallback listener;
    listener = () {
      if (!state.busy && !completer.isCompleted) completer.complete(state.error == null);
    };
    state.addListener(listener);
    try {
      return await completer.future.timeout(const Duration(minutes: 10), onTimeout: () => false);
    } finally {
      state.removeListener(listener);
    }
  }

  Future<void> _send() async {
    final draft = _composer.text.trim();
    if (draft.isEmpty && _attachments.isEmpty) return;
    final text = _contextText.isEmpty ? draft : '$draft\n\nContext:\n$_contextText';
    final batches = codexMakeAttachmentBatches(_attachments);
    try {
      if (batches.isEmpty) {
        final sent = await state.send(
          text,
          cwd: _cwd.text,
          reasoning: _reasoningLevel,
          approval: _approval,
          sandbox: _sandboxMode.isEmpty ? null : _sandboxMode,
        );
        if (!mounted) return;
        if (sent) _composer.clear();
        if (!sent) showCodexMessage(context, '发送失败，文字已保留：${state.error ?? '请检查连接'}');
        return;
      }
      for (var index = 0; index < batches.length; index++) {
        if (state.error != null) state.clearError();
        final batch = batches[index];
        final last = index == batches.length - 1;
        final prompt = last
            ? '$text\n\n[这是最后一批附件，请按原任务处理全部附件。]'
            : '[附件分批 ${index + 1}/${batches.length}，共 ${batch.length} 项。请只确认收到，不要开始分析，等待最后一批。]';
        final fields = CodexAttachment.toRequestFields(batch);
        final sent = await state.send(
          prompt,
          cwd: _cwd.text,
          reasoning: _reasoningLevel,
          approval: _approval,
          sandbox: _sandboxMode.isEmpty ? null : _sandboxMode,
          images: (fields['images'] as List? ?? const []).cast<String>(),
          files: (fields['files'] as List? ?? const [])
              .whereType<Map>()
              .map((item) => item.cast<String, dynamic>())
              .toList(),
        );
        if (!mounted) return;
        if (!sent) {
          showCodexMessage(context, '第 ${index + 1}/${batches.length} 批发送失败，文字和附件已保留：${state.error ?? '请检查连接'}');
          return;
        }
        if (!last && !await _waitForCurrentTurn()) {
          if (mounted) showCodexMessage(context, '第 ${index + 1} 批未正常结束，后续批次未发送，附件已保留');
          return;
        }
      }
      if (mounted) {
        _composer.clear();
        setState(() => _attachments = []);
      }
    } catch (error) {
      if (mounted) showCodexMessage(context, '发送失败，文字和附件已保留：$error');
    }
  }

  /// 顶部模型标签：一眼看到当前用的是什么模型，点开直接换。
  Widget _modelChip() {
    final model = state.config['model']?.toString();
    return InkWell(
      onTap: _pickModel,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: const Color(0xffefefe9),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: const Color(0xffe2e2db)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.memory, size: 13, color: Color(0xff6f7069)),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                '${(model == null || model.isEmpty) ? '选模型' : model} · $_reasoningLevel',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Color(0xff3a3b36)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 对话分支：把当前会话 fork 成一条新线程再切过去（codex thread/fork）。
  Future<void> _branchThread() async {
    if (state.threadId == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('先发一条消息，产生会话后才能分支')));
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('从这里分支'),
        content: const Text('会复制当前会话历史到一条新线程，原会话保持不变。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('分支')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await state.forkThread();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已切到分支会话')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('分支失败：$e')));
      }
    }
  }

  Future<void> _pickModel() async {
    await showCodexModelSheet(
      context,
      state: state,
      theme: _theme,
      reasoning: _reasoningLevel,
      onReasoning: (value) async {
        setState(() => _reasoningLevel = value);
        await CodexPrefs.saveReasoning(value);
      },
      // 「新增渠道」沿用渠道页的表单：关掉弹层后进「模型与渠道」页。
      onManageChannels: () {
        Navigator.of(context).pop();
        _openPage(CodexModelSettingsPage(state: state, onPickModel: _pickModel));
      },
    );
  }

  Future<void> _newTask() async {
    _scaffoldKey.currentState?.closeDrawer();
    final before = state.threadId;
    await state.createThread(_cwd.text);
    if (!mounted) return;
    if (state.threadId == before) {
      // 新建失败：停在当前会话并明说原因，绝不悄悄复用旧线程。
      showCodexMessage(context, '新建会话失败：${state.error ?? '桥没有返回 threadId'}');
      return;
    }
    _resetTurnState();
  }

  Future<void> _chooseFolder() async {
    final c = TextEditingController(text: _cwd.text);
    final value = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('项目文件夹'),
        content: TextField(
          controller: c,
          autofocus: true,
          decoration: const InputDecoration(hintText: '/path/to/project'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text('选择')),
        ],
      ),
    );
    if (value == null) return;
    setState(() => _cwd.text = value);
  }

  /// 设置是二级页：抽屉里点「设置」push 进来，返回回到对话。
  Widget _settingsPage() => Scaffold(
    backgroundColor: _theme.background,
    appBar: AppBar(
      title: const Text('设置', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      backgroundColor: _theme.background,
      surfaceTintColor: Colors.transparent,
    ),
    body: SafeArea(top: false, child: _settingsHome()),
  );

  Widget _settingsHome() => CodexSettingsHome(
    state: state,
    theme: _theme,
    reasoning: _reasoningLevel,
    approval: _approval,
    startingLogin: _startingLogin,
    runtimeStatus: _runtimeStatus,
    onReasoningChanged: (value) {
      setState(() => _reasoningLevel = value);
      CodexPrefs.saveReasoning(value);
    },
    onApprovalChanged: (value) {
      setState(() => _approval = value);
      CodexPrefs.saveApproval(value);
    },
    onThemeChanged: (value) {
      setState(() => _theme = value);
      CodexPrefs.saveTheme(value.id);
    },
    onPickModel: _pickModel,
    onStartLogin: _startLogin,
    onCheckUpdate: _checkUpdate,
    onRuntimeAction: (action) async {
      // 只有瘦包（APK 没带运行时）才走联网下载；完整包直接解压，别让用户白等十几分钟。
      if (action == 'install' && _shouldDownloadRuntime()) {
        await _downloadRuntime();
        return _runtimeStatus;
      }
      return _runtimeAction(action);
    },
    onShowRuntimeLogs: _showRuntimeLogs,
    onCopyFeedback: _copyFeedbackQq,
    backgroundImage: _backgroundImage,
    onBackgroundImage: (path) async {
      await CodexPrefs.saveBackgroundImage(path);
      if (mounted) setState(() => _backgroundImage = path);
    },
  );

  Future<void> _copyFeedbackQq() async {
    await Clipboard.setData(const ClipboardData(text: '1604756256'));
    if (mounted) showCodexMessage(context, '已复制 QQ：1604756256');
  }

  bool _startingLogin = false;

  /// 官方账号登录完成后轮询到凭据落地，再刷新桥状态。
  Future<void> _startLogin() async {
    setState(() => _startingLogin = true);
    try {
      final result = await widget.client.post('/api/account/login/start');
      final url = result['authUrl'];
      if (url is! String || url.isEmpty) throw Exception('没有拿到授权地址');
      if (Platform.isAndroid) {
        final opened = await const MethodChannel('codex/runtime').invokeMethod<bool>('openUrl', {'url': url});
        if (opened != true) throw Exception('没有可用浏览器打开授权页');
      }
      final polling = _pollChatgptLogin();
      await _showLoginGuide(url);
      await polling;
    } catch (error) {
      if (mounted) setState(() => state.error = error.toString());
    } finally {
      if (mounted) setState(() => _startingLogin = false);
    }
  }

  Future<void> _pollChatgptLogin() async {
    for (var i = 0; i < 90; i++) {
      await Future<void>.delayed(const Duration(seconds: 2));
      if (!mounted) return;
      final account = await widget.client.get('/api/account');
      if (account['account'] != null) {
        await state.connect();
        if (mounted) showCodexMessage(context, 'ChatGPT 账号已同步');
        return;
      }
    }
  }

  Future<void> _showLoginGuide(String authUrl) async {
    final callback = TextEditingController();
    String? dialogError;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('完成 ChatGPT 登录'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('1. 在浏览器中打开 OpenAI 授权页；也可以点下方复制链接，到电脑或其他设备打开。'),
                TextButton.icon(
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: authUrl));
                    if (mounted) showCodexMessage(this.context, '授权链接已复制');
                  },
                  icon: const Icon(Icons.copy, size: 17),
                  label: const Text('复制授权链接'),
                ),
                const SizedBox(height: 8),
                const Text('如果页面显示 country/region not supported，说明当前网络出口被 OpenAI 地区限制，不是密码错误；请更换合规网络后再登录。'),
                const SizedBox(height: 8),
                const Text('2. 如果手机浏览器出现网络故障，完成登录后复制地址栏最终的 http://127.0.0.1:1455/… 地址，粘到下面。'),
                TextField(
                  controller: callback,
                  minLines: 2,
                  maxLines: 4,
                  decoration: const InputDecoration(hintText: '粘贴最终回调地址（可选）', border: OutlineInputBorder()),
                ),
                if (dialogError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      dialogError!,
                      style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('浏览器中继续')),
            FilledButton(
              onPressed: () async {
                if (callback.text.trim().isEmpty) {
                  setDialogState(() => dialogError = '也可以直接关闭本框，在浏览器里完成；或粘贴最终回调地址。');
                  return;
                }
                try {
                  await widget.client.post('/api/account/login/complete', {'callbackUrl': callback.text.trim()});
                  if (dialogContext.mounted) Navigator.pop(dialogContext);
                } catch (error) {
                  setDialogState(() => dialogError = error.toString());
                }
              },
              child: const Text('完成同步'),
            ),
          ],
        ),
      ),
    );
    callback.dispose();
  }
}

/// 上下文百分比环形：数据来自 `/api/context` 的 usage 或 SSE `context.usage`。
/// 点一下进「上下文与压缩」设置。
class CodexContextRing extends StatelessWidget {
  const CodexContextRing({super.key, required this.state, this.onTap, this.size = 30});

  final CodexPocketState state;
  final VoidCallback? onTap;
  final double size;

  /// 圆形指示器右侧/内部的百分比文字，测试和无障碍都读它。
  static String label(double? percent) => percent == null ? '—' : '${percent.round()}';

  @override
  Widget build(BuildContext context) {
    final percent = state.contextPercent;
    final ratio = ((percent ?? 0) / 100).clamp(0.0, 1.0);
    final color = ratio >= 0.85
        ? const Color(0xff9c3b32)
        : ratio >= 0.6
        ? const Color(0xff8a6d1f)
        : const Color(0xff2f5d3a);
    return Tooltip(
      message: percent == null ? '上下文用量未知' : '上下文已用 ${percent.round()}%（点按设置）',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(size),
        child: Padding(
          padding: const EdgeInsets.all(5),
          child: SizedBox(
            width: size,
            height: size,
            child: Stack(
              alignment: Alignment.center,
              children: [
                CircularProgressIndicator(
                  value: ratio,
                  strokeWidth: 2.6,
                  backgroundColor: const Color(0xffe0e1da),
                  color: color,
                ),
                Text(
                  label(percent),
                  key: const Key('context-ring-label'),
                  style: const TextStyle(fontSize: 9, fontWeight: FontWeight.w600, color: Color(0xff5c5d56)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 对话列表里的一行：普通事件、某回合的思考链块，或「正在思考」等待卡。
sealed class _ChatRow {
  const _ChatRow();
}

class _EventRow extends _ChatRow {
  const _EventRow(this.index);
  final int index;
}

/// 一个相邻过程段；同轮摘要与折叠状态共享，正文保持独立行。
class _MindRow extends _ChatRow {
  const _MindRow({
    required this.turnKey,
    required this.thinking,
    required this.summaryThinking,
    required this.anchor,
    required this.live,
    this.showHeader = true,
  });
  final List<int> summaryThinking;
  final bool showHeader;

  /// 回合分组键（`chatTurnKeys` 算出来的那一套）。
  final String turnKey;

  /// 这一轮的思考/工具事件下标（`state.events` 里的位置）。
  final List<int> thinking;

  /// 块内第一个事件的下标：思考链那行的 key（`reasoning-block-N` / `reasoning-done-N`）用它。
  final int anchor;

  /// 这一轮还在跑吗（配合 `_thinkingLive` 显示「Codex 正在思考 · Ns」）。
  final bool live;
}

class _WaitingRow extends _ChatRow {
  const _WaitingRow();
}

/// 限高而不截断内容。默认跟随尾部，用户向上滚动后暂停跟随。
class _LiveTimelineViewport extends StatefulWidget {
  const _LiveTimelineViewport({super.key, required this.live, required this.revision, required this.child});
  final bool live;
  final int revision;
  final Widget child;
  @override
  State<_LiveTimelineViewport> createState() => _LiveTimelineViewportState();
}

class _LiveTimelineViewportState extends State<_LiveTimelineViewport> {
  final _scroll = ScrollController();
  bool _follow = true;
  @override
  void initState() {
    super.initState();
    _followTail();
  }

  @override
  void didUpdateWidget(_LiveTimelineViewport oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.revision != widget.revision || oldWidget.live != widget.live) _followTail();
  }

  void _followTail() {
    if (!widget.live || !_follow) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.live && _follow && _scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.live) return widget.child;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: kCodexLiveTimelineLines * 20 * MediaQuery.textScalerOf(context).scale(1)),
      child: NotificationListener<ScrollUpdateNotification>(
        onNotification: (notification) {
          if (notification.dragDetails != null) _follow = notification.metrics.extentAfter < 24;
          return false;
        },
        child: SingleChildScrollView(controller: _scroll, primary: false, child: widget.child),
      ),
    );
  }
}
