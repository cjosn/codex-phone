import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'codex_agents.dart';

/// 桥的错误响应：`message` 是桥的原话；`details` 原样保留
/// （例如 `/api/channels/test` 的 `details.stage`）。`details` 可能在顶层，
/// 也可能挂在 `error` 下面（切换渠道的 409 就是这样），两种都读。
class CodexBridgeException implements Exception {
  CodexBridgeException(this.message, [this.details = const {}, this.code = '']);
  final String message;
  final Map<String, dynamic> details;

  /// 桥的错误码（`channel/thread-binding` 这类需要分支处理的错误靠它区分）。
  final String code;

  @override
  String toString() => message;
}

class CodexBridgeClient {
  CodexBridgeClient({http.Client? client, this.baseUrl = 'http://127.0.0.1:8787', this.token = '', this.eventSource})
    : _client = client ?? http.Client();
  final http.Client _client;
  final Stream<Map<String, dynamic>> Function(int after)? eventSource;
  String baseUrl;
  String token;
  Uri _uri(String path, [Map<String, String>? query]) => Uri.parse('$baseUrl$path').replace(queryParameters: query);
  Map<String, String> get _eventHeaders => {
    'accept': 'text/event-stream',
    if (token.isNotEmpty) 'authorization': 'Bearer $token',
  };
  Map<String, String> get _headers => {
    'content-type': 'application/json',
    if (token.isNotEmpty) 'authorization': 'Bearer $token',
  };

  Future<Map<String, dynamic>> get(String path) async => _request('GET', path);
  Future<Map<String, dynamic>> post(String path, [Map<String, dynamic> body = const {}]) async =>
      _request('POST', path, body);
  Future<Map<String, dynamic>> _request(String method, String path, [Map<String, dynamic>? body]) async {
    final uri = _uri(path);
    final response = method == 'GET'
        ? await _client.get(uri, headers: _headers).timeout(const Duration(seconds: 30))
        : await _client
              .post(uri, headers: _headers, body: jsonEncode(body ?? const {}))
              .timeout(const Duration(seconds: 30));
    final decoded = response.body.isEmpty
        ? <String, dynamic>{}
        : (jsonDecode(response.body) as Map).cast<String, dynamic>();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = decoded['error'];
      final raw = decoded['details'] ?? (error is Map ? error['details'] : null);
      throw CodexBridgeException(
        (error is Map
                ? (error['message'] ?? error['code'] ?? 'HTTP ${response.statusCode}')
                : 'HTTP ${response.statusCode}: ${response.body}')
            .toString(),
        raw is Map ? raw.cast<String, dynamic>() : const {},
        error is Map ? (error['code'] ?? '').toString() : '',
      );
    }
    return decoded;
  }

  Stream<Map<String, dynamic>> events(int after) async* {
    if (eventSource != null) {
      yield* eventSource!(after);
      return;
    }
    final request = http.Request('GET', _uri('/api/events', {'after': '$after'}))..headers.addAll(_eventHeaders);
    final response = await _client.send(request).timeout(const Duration(seconds: 30));
    if (response.statusCode != 200) {
      final body = await response.stream.bytesToString();
      throw Exception(_responseError(response.statusCode, body));
    }
    var data = StringBuffer();
    await for (final line in response.stream.transform(utf8.decoder).transform(const LineSplitter())) {
      if (line.isEmpty) {
        if (data.isNotEmpty) {
          yield (jsonDecode(data.toString()) as Map).cast<String, dynamic>();
          data = StringBuffer();
        }
      } else if (line.startsWith('data:')) {
        if (data.isNotEmpty) data.write('\n');
        data.write(line.substring(5).trimLeft());
      }
    }
  }

  String _responseError(int status, String body) {
    try {
      final json = (jsonDecode(body) as Map).cast<String, dynamic>();
      final error = json['error'];
      if (error is Map) return (error['message'] ?? error['code'] ?? 'HTTP $status').toString();
    } catch (_) {}
    return 'HTTP $status${body.isEmpty ? '' : ': $body'}';
  }

  void close() => _client.close();
}

class PocketEvent {
  PocketEvent(
    this.type,
    this.payload, {
    this.itemType,
    this.approvalId,
    this.itemId,
    this.threadId,
    this.name,
    this.status,
    this.exitCode,
    this.turnId,
    this.durationMs,
    this.arguments = '',
  });
  final String type;
  final String payload;
  final String? itemType;
  final String? approvalId;
  final String? itemId;
  final String? threadId;

  /// 工具名/命令（`tool.start` 时写入，后续事件沿用）。
  final String? name;

  /// running / completed / failed。
  final String? status;
  final int? exitCode;

  /// 这条事件属于哪一回合（桥的事件都带 `turnId`）。思考链按它把同一回合的
  /// reasoning/工具聚成一块，放在该回合回答上方；消息级「分支」也用它当 `lastTurnId`。
  final String? turnId;

  /// 这一步花了多久（毫秒）。来自协议自己的 `item.durationMs`，不是界面掐表。
  final int? durationMs;

  /// 工具参数独立于输出保存；尚未闭合的 JSON 也能实时展示。
  final String arguments;
}

/// 过程流的一步：把协议 item 翻成一句人话（「读取 server.mjs」而不是 `file_read`）。
/// 文案是 UI 的事，所以放在 App 侧——改文案不用重发桥。
String codexStepTitle(PocketEvent event) {
  final type = (event.itemType ?? '').toLowerCase();
  final name = (event.name ?? '').trim();
  final output = event.payload.trim();
  final firstLine = output.isEmpty ? '' : output.split('\n').first.trim();
  switch (type) {
    case 'commandexecution':
      final command = name.isNotEmpty ? name : firstLine;
      if (command.isEmpty) return '运行命令';
      final bin = command.split(RegExp(r'\s+')).first.split('/').last;
      const verbs = {
        'ls': '查看目录',
        'cat': '读取文件',
        'grep': '搜索内容',
        'rg': '搜索内容',
        'find': '查找文件',
        'npm': '运行 npm',
        'pnpm': '运行 pnpm',
        'yarn': '运行 yarn',
        'node': '运行 node',
        'python3': '运行 python',
        'pip': '安装依赖',
        'apt-get': '安装系统包',
        'flutter': '运行 flutter',
        'curl': '请求网络',
        'ssh': '连接远程',
        'tar': '打包',
        'git': '执行 git',
      };
      final verb = verbs[bin];
      if (verb != null) return command.length <= 40 ? '$verb' : '$verb · ${command.substring(0, 40)}…';
      return command.length <= 40 ? '运行 $command' : '运行命令';
    case 'filechange':
      final count = output.isEmpty ? 1 : output.split('\n').where((line) => line.startsWith('+++')).length;
      return count <= 1 ? '修改 1 个文件' : '修改 $count 个文件';
    case 'mcptoolcall':
      const mcp = {
        'file_read': '读取文件',
        'file_write': '写入文件',
        'file_edit': '编辑文件',
        'file_grep': '搜索内容',
        'file_find': '查找文件',
        'web_fetch': '抓取网页',
        'env_run': '运行命令',
        'env_install': '安装环境',
        'screen': '读屏',
        'tap': '点击屏幕',
        'type': '输入文字',
      };
      final tool = name.split('.').last;
      return mcp[tool] ?? (tool.isEmpty ? '调用工具' : '调用 $tool');
    case 'websearch':
      final query = name.isNotEmpty ? name : firstLine;
      return query.isEmpty ? '联网搜索' : '搜索「${query.length > 18 ? '${query.substring(0, 18)}…' : query}」';
    case 'fileschange':
      return '修改文件';
    case 'plan':
      return '拆解计划';
    case 'subagentactivity':
    case 'collabagenttoolcall':
      return '子代理';
    case 'contextcompaction':
      return '压缩上下文';
    case 'imageview':
      return '查看图片';
    case 'imagegeneration':
      return '生成图片';
    case 'sleep':
      return '等待';
    default:
      return name.isEmpty ? '处理中' : name;
  }
}

/// 事件的分组键：带 `turnId` 的按真实回合，不带的（用户消息、老桥、恢复的历史）
/// 按用户消息切段。这样一段回答的思考链和正文一定落在同一块里，
/// 不会因为事件缺少 `turnId` 就散成多块或跑到别的回合去。
List<String?> chatTurnKeys(List<PocketEvent> events) {
  final keys = <String?>[];
  var segment = 0;
  for (final event in events) {
    final isUser = event.type == 'user' || event.type == 'userMessage';
    if (isUser) {
      keys.add(null);
      // 用户消息之后才是下一段回答：再往里加事件时就换了分段编号，
      // 上一段回答不会和下一段并进同一块。
      segment++;
      continue;
    }
    final id = event.turnId;
    keys.add(id == null || id.isEmpty ? 'segment:$segment' : 'turn:$id');
  }
  return keys;
}

/// 一种上游协议（`wire`，CONTRACT-V4 A）：codex 只会说 Responses，
/// 除 `openai-responses` 直连外都由本机兼容代理转换协议。
class CodexChannelWire {
  const CodexChannelWire(this.value, this.label, this.badge, this.example, {required this.proxied, required this.note});
  final String value;
  final String label; // 下拉里的名字（契约 D 的写法）
  final String badge; // 列表 / 模型池徽标用的短中文名
  final String example; // 该 wire 该填的 Base URL 例子
  final bool proxied;
  final String note; // 是否走本机代理，一句话
}

const codexChannelWires = <CodexChannelWire>[
  CodexChannelWire(
    'openai-chat',
    'OpenAI 兼容（chat）',
    'OpenAI 兼容',
    'https://api.openai.com/v1',
    proxied: true,
    note: '走本机兼容代理：把 Responses 请求翻成对方的 /chat/completions。',
  ),
  CodexChannelWire(
    'openai-responses',
    'OpenAI Responses',
    'OpenAI Responses',
    'https://api.openai.com/v1',
    proxied: false,
    note: '直连：codex 原样说 Responses，不经过本机代理。',
  ),
  CodexChannelWire(
    'anthropic',
    'Anthropic',
    'Anthropic',
    'https://api.anthropic.com/v1',
    proxied: true,
    note: '走本机兼容代理：转成 /messages（x-api-key 鉴权）。',
  ),
  CodexChannelWire(
    'gemini',
    'Gemini',
    'Gemini',
    'https://generativelanguage.googleapis.com/v1beta',
    proxied: true,
    note: '走本机兼容代理：转成 Gemini 的 generateContent 形状。',
  ),
  CodexChannelWire(
    'azure-openai',
    'Azure OpenAI',
    'Azure OpenAI',
    'https://<resource>.openai.azure.com',
    proxied: true,
    note: '走本机兼容代理：按 deployment 拼 Azure 的 chat/completions。',
  ),
  CodexChannelWire(
    'ollama',
    'Ollama 本地',
    'Ollama',
    'http://127.0.0.1:11434',
    proxied: true,
    note: '走本机兼容代理：转成 Ollama 的 /api/chat（本地不需要密钥）。',
  ),
];

/// 兼容旧值：`chat` → `openai-chat`，`responses` → `openai-responses`。
/// 读渠道文件时归一化，写回时一律用新值（CONTRACT-V4 A）。
String normalizeChannelWire(String? wire) => switch (wire?.trim()) {
  'chat' => 'openai-chat',
  'responses' => 'openai-responses',
  null || '' => 'openai-chat',
  final value => value,
};

/// 找不到的 wire（桥以后新增的）返回 null，界面回落显示原值而不是崩。
CodexChannelWire? channelWireOf(String? wire) {
  final value = normalizeChannelWire(wire);
  for (final option in codexChannelWires) {
    if (option.value == value) return option;
  }
  return null;
}

/// 列表徽标文字：已知 wire 用中文名，未知 wire 原样显示。
String channelWireBadge(String? wire) => channelWireOf(wire)?.badge ?? normalizeChannelWire(wire);

/// `/api/channels/test` 成功的结果（CONTRACT-V4 C）。
class CodexChannelTestReport {
  const CodexChannelTestReport({required this.wire, required this.models, required this.latencyMs});
  final String wire;
  final int models;
  final int latencyMs;
}

/// 测试连接失败：桥给的阶段（`connect`/`auth`/`list`/`infer`）与原话，不吞。
class CodexChannelTestFailure implements Exception {
  const CodexChannelTestFailure({required this.stage, required this.message});
  final String stage;
  final String message;

  @override
  String toString() => message;
}

int _intValue(Object? value) => value is int ? value : int.tryParse('${value ?? ''}') ?? 0;

class CodexPocketState extends ChangeNotifier {
  CodexPocketState(this.client);
  final CodexBridgeClient client;
  final CodexAgentsState agents = CodexAgentsState();
  bool connected = false;
  bool loading = false;
  String? error;
  Map<String, dynamic> health = {};
  List<Map<String, dynamic>> threads = [];
  List<PocketEvent> events = [];

  /// 真实正文/思考/工具变更时递增，原位归并也算进展，心跳不算。
  /// UI 在回合开始记录基线，历史正文不能让下一轮误完成。
  int streamRevision = 0;
  int answerRevision = 0;
  String? threadId;

  /// 当前会话绑在哪个渠道上：codex 的 thread 在创建时就绑死了 provider，
  /// 切渠道后不搬会话，下一回合就会拿新渠道的模型名去打旧渠道（上游 404 重试 5 次）。
  String? threadChannel;
  int seq = 0;
  bool busy = false;

  /// 当前活动回合的 id：事件里带了 `turnId` 就记下来，没带的事件沿用它
  /// （老桥/历史恢复），`turn.end` 清空——否则下一轮没带 turnId 的事件
  /// 会被并进上一轮的思考链。
  String? currentTurnId;

  /// Agent 面：计划步骤、目标、上下文用量、线程状态。
  List<Map<String, dynamic>> plan = [];
  String? planExplanation;
  Map<String, dynamic>? goal;
  Map<String, dynamic>? usage;
  String? threadStatus;

  /// 上游重试/连接提示（"Reconnecting... 2/5"）：只是一行状态，不进对话正文。
  String? statusHint;

  // ---- 终端（codex command/exec + PTY）----
  final StreamController<String> _terminalOut = StreamController<String>.broadcast();
  Stream<String> get terminalOut => _terminalOut.stream;
  String? termProcessId;

  Future<void> startShell({int rows = 30, int cols = 90}) async {
    final id = 'term-${DateTime.now().millisecondsSinceEpoch}';
    termProcessId = id;
    await client.post('/api/exec', {
      'processId': id,
      'argv': ['/bin/bash', '-i'],
      'rows': rows,
      'cols': cols,
    });
  }

  Future<void> shellInput(String data) async {
    final id = termProcessId;
    if (id == null || data.isEmpty) return;
    await client.post('/api/exec/write', {'processId': id, 'deltaBase64': base64Encode(utf8.encode(data))});
  }

  Future<void> shellResize(int cols, int rows) async {
    final id = termProcessId;
    if (id == null) return;
    await client.post('/api/exec/resize', {'processId': id, 'rows': rows, 'cols': cols});
  }

  /// 旧版系统提示入口仍保留兼容性；新人设页由桥同时写 AGENTS.md 与 developerInstructions。
  /// 上次打开的会话：启动时直接回到它，而不是落在目录页。
  String? lastThreadId;

  Future<void> loadLastThread() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      lastThreadId = prefs.getString('codex.lastThread');
    } catch (_) {}
  }

  Future<void> _rememberThread(String id) async {
    lastThreadId = id;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('codex.lastThread', id);
    } catch (_) {}
  }

  String systemPrompt = '';

  Future<void> loadSystemPrompt() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      systemPrompt = prefs.getString('codex.systemPrompt') ?? '';
    } catch (_) {}
  }

  Future<void> saveSystemPrompt(String text) async => _run(() async {
    systemPrompt = text;
    await client.post('/api/fs/write', {'path': '/root/.codex/AGENTS.md', 'content': text});
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('codex.systemPrompt', text);
    } catch (_) {}
  });

  /// 上下文占比：给圆形指示器用。没有明确的窗口上限时按 128k 估算，
  /// 有 goal.tokenBudget 或 usage 里的窗口字段就优先用真实值。
  double? get contextRatio {
    final u = usage;
    if (u == null) return null;
    final used = (u['totalTokens'] ?? u['total_tokens'] ?? u['tokensUsed']) as num?;
    if (used == null) return null;
    final declared = (u['modelContextWindow'] ?? u['contextWindow'] ?? goal?['tokenBudget']) as num?;
    // 上游通常不报窗口大小；用户可以在设置里填自己模型的上下文长度（tokens）。
    final fallback = contextWindowOverride > 0 ? contextWindowOverride.toDouble() : 128000.0;
    final cap = (declared != null && declared > 0) ? declared.toDouble() : fallback;
    return (used / cap).clamp(0.0, 1.0);
  }

  /// 用户自定义的上下文窗口大小（tokens）；0 表示按上游上报值或 128k 估算。
  int contextWindowOverride = 0;

  /// 当前百分比用的窗口来自哪里：`user`（自己设置）/ `upstream`（上游上报）/ `unknown`。
  String? contextWindowSource;

  // ---- 上下文压缩与用量（CONTRACT-V2 B）----
  /// `/api/context` 的配置 + usage 快照；阈值/保留轮数都在里面。
  Map<String, dynamic> context = {};
  bool contextLoading = false;
  bool compacting = false;

  /// 自动压缩/失败事件的最近一条说明，设置页直接显示。
  String? contextNotice;

  /// 环形显示的已用百分比 0..100；没有真实用量时为 null。
  /// 契约里 `percent` 与 `thresholdPercent` 同一刻度（0..100），不是 0..1。
  double? get contextPercent {
    // 用量属于别的会话（切到新会话、或刚从设置页回来）时不能画到环上。
    final usageThread = contextUsage['threadId']?.toString();
    if (usageThread != null && usageThread.isNotEmpty && threadId != null && usageThread != threadId) return null;
    final event = contextUsage['percent'];
    final config = (context['usage'] as Map?)?['percent'];
    final raw = event is num ? event : (config is num ? config : null);
    if (raw != null) return raw.toDouble().clamp(0, 100);
    final ratio = contextRatio;
    return ratio == null ? null : ratio * 100;
  }

  Map<String, dynamic> contextUsage = {};

  int get contextThresholdPercent => (context['thresholdPercent'] as num?)?.round() ?? 75;
  int get contextKeepRecentTurns => (context['keepRecentTurns'] as num?)?.round() ?? 4;
  bool get contextEnabled => context['enabled'] != false;
  bool get contextAutoCompact => context['autoCompact'] != false;

  Future<void> loadContext() async {
    contextLoading = true;
    notifyListeners();
    try {
      // 带上 threadId：不然桥会回「最近一次用量」（可能是别的会话），
      // 新开的空会话就会显示上一轮的百分比（真机上看到过 100%）。
      final current = threadId;
      context = _parseContext(
        await client.post('/api/context', {if (current != null && current.isNotEmpty) 'threadId': current}),
      );
      contextUsage = (context['usage'] as Map?)?.cast<String, dynamic>() ?? {};
      // 窗口大小以桥为准：它才是算百分比和自动压缩阈值的地方，App 只缓存一份用于首屏。
      final window = context['contextWindowTokens'];
      contextWindowOverride = window is num && window > 0 ? window.round() : 0;
      contextWindowSource = (contextUsage['contextWindowSource'] ?? context['contextWindowSource'])?.toString();
    } finally {
      contextLoading = false;
      notifyListeners();
    }
  }

  /// 保存阈值/开关；桥的写接口只回结果，统一再读一次 `/api/context` 拿完整配置。
  Future<void> saveContextConfig(Map<String, dynamic> patch) async {
    await client.post('/api/context/config', patch);
    await loadContext();
  }

  /// 保存「上下文窗口大小」（tokens，0 = 交给上游/默认估算）。
  /// 必须写进桥：环形的百分比与自动压缩阈值都在桥里算，只存本地就会出现
  /// 「设置填了但百分比不变」——这就是之前的问题。
  Future<void> saveContextWindow(int tokens) async {
    final value = tokens > 0 ? tokens : null;
    await saveContextConfig({'contextWindowTokens': value});
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt('codex.contextWindow', tokens);
    } catch (_) {}
  }

  Future<void> compactThread({String? threadId}) async {
    final id = threadId ?? this.threadId;
    if (id == null || id.isEmpty) throw Exception('还没有活动会话');
    compacting = true;
    notifyListeners();
    try {
      final result = await client.post('/api/context/compact', {'threadId': id});
      final status = result['status']?.toString() ?? '';
      if (status.isEmpty) throw Exception('压缩响应缺少 status');
      contextNotice = '已请求压缩 · $status';
    } finally {
      compacting = false;
      notifyListeners();
    }
  }

  Map<String, dynamic> _parseContext(Map<String, dynamic> raw) {
    final enabled = raw['enabled'];
    final threshold = raw['thresholdPercent'];
    final keep = raw['keepRecentTurns'];
    if (enabled is! bool) throw Exception('上下文设置响应缺少 enabled');
    if (threshold is! num) throw Exception('上下文设置响应缺少 thresholdPercent');
    if (keep is! num) throw Exception('上下文设置响应缺少 keepRecentTurns');
    final percent = threshold.round();
    if (percent < 10 || percent > 95) throw Exception('上下文阈值必须在 10–95 之间，桥返回 $percent');
    return {
      'enabled': enabled,
      'thresholdPercent': percent,
      'keepRecentTurns': keep.round(),
      'autoCompact': raw['autoCompact'] == true,
      'summaryModel': raw['summaryModel'],
      // 用户填的上下文窗口（tokens）；null = 交给上游上报值 / 128k 估算。
      'contextWindowTokens': raw['contextWindowTokens'] is num ? (raw['contextWindowTokens'] as num).round() : null,
      'usage': raw['usage'] is Map ? (raw['usage'] as Map).cast<String, dynamic>() : <String, dynamic>{},
    };
  }

  // ---- 系统人设（CONTRACT-V2 C）----
  static const personaBlockStart = '<!-- codex-pocket:persona:start -->';
  static const personaBlockEnd = '<!-- codex-pocket:persona:end -->';

  Map<String, dynamic> persona = {};
  bool personaLoading = false;

  String get personaName => persona['name']?.toString() ?? '';
  String get personaStyle => persona['style']?.toString() ?? '';
  String get personaInstructions => persona['instructions']?.toString() ?? '';
  bool get personaActive => persona['active'] == true;
  String get personaPath => persona['path']?.toString() ?? '';
  String get personaEffectiveInstructions => persona['effectiveInstructions']?.toString() ?? '';

  Future<void> loadPersona() async {
    personaLoading = true;
    notifyListeners();
    try {
      persona = _parsePersona(await client.post('/api/persona'));
    } finally {
      personaLoading = false;
      notifyListeners();
    }
  }

  Future<void> savePersona({
    required String name,
    required String style,
    required String instructions,
    required bool active,
  }) async {
    persona = _parsePersona(
      await client.post('/api/persona/save', {
        'name': name,
        'style': style,
        'instructions': instructions,
        'active': active,
      }),
    );
    notifyListeners();
  }

  Map<String, dynamic> _parsePersona(Map<String, dynamic> raw) {
    final name = raw['name'];
    final style = raw['style'];
    final instructions = raw['instructions'];
    final active = raw['active'];
    if (name is! String || style is! String || instructions is! String || active is! bool) {
      throw Exception('人设响应格式不正确（需要 name/style/instructions/active）');
    }
    return {
      'name': name,
      'style': style,
      'instructions': instructions,
      'active': active,
      'path': raw['path']?.toString() ?? '',
      'effectiveInstructions': raw['effectiveInstructions']?.toString() ?? '',
      'injection': raw['injection']?.toString() ?? '',
    };
  }

  /// 保存后会在 AGENTS.md 里被替换掉的托管区块内容，给设置页做预览。
  String personaManagedBlock({String? name, String? style, String? instructions, bool? active}) {
    final title = (name ?? personaName).trim();
    final tone = (style ?? personaStyle).trim();
    final body = (instructions ?? personaInstructions).trim();
    final enabled = active ?? personaActive;
    if (!enabled) return '$personaBlockStart\n$personaBlockEnd';
    return [
      personaBlockStart,
      if (title.isNotEmpty) '## $title',
      if (tone.isNotEmpty) '风格：$tone',
      if (body.isNotEmpty) ...['', body],
      personaBlockEnd,
    ].join('\n');
  }

  // ---- 插件（CONTRACT-V2 D）----
  List<Map<String, dynamic>> plugins = [];
  bool pluginsLoading = false;
  String? pluginsError;

  Future<void> loadPlugins() async {
    pluginsLoading = true;
    pluginsError = null;
    notifyListeners();
    try {
      final result = await client.post('/api/plugins');
      final list = result['plugins'];
      if (list is! List) throw Exception('插件列表响应格式不正确');
      plugins = list.whereType<Map>().map((entry) => entry.cast<String, dynamic>()).toList();
      for (final plugin in plugins) {
        if ((plugin['name']?.toString() ?? '').isEmpty) throw Exception('插件列表里有缺少 name 的条目');
      }
    } catch (e) {
      pluginsError = _message(e);
      rethrow;
    } finally {
      pluginsLoading = false;
      notifyListeners();
    }
  }

  Future<String> installPlugin(String path) async {
    final target = path.trim();
    if (target.isEmpty) throw Exception('要安装的插件目录不能为空');
    final result = await client.post('/api/plugins/install', {'path': target});
    final name = result['name']?.toString() ?? '';
    if (name.isEmpty) throw Exception('安装响应缺少插件名称');
    await loadPlugins();
    return name;
  }

  Future<void> removePlugin(String name) async {
    final result = await client.post('/api/plugins/remove', {'name': name});
    final removed = result['name']?.toString();
    plugins.removeWhere((plugin) => plugin['name']?.toString() == (removed ?? name));
    notifyListeners();
  }

  Future<bool> togglePlugin(String name, bool enabled) async {
    final result = await client.post('/api/plugins/toggle', {'name': name, 'enabled': enabled});
    final applied = result['enabled'];
    if (applied is! bool) throw Exception('插件开关响应格式不正确');
    final index = plugins.indexWhere((plugin) => plugin['name']?.toString() == name);
    if (index >= 0) plugins[index] = {...plugins[index], 'enabled': applied};
    notifyListeners();
    return applied;
  }

  // ---- 会话列表操作（抽屉右键菜单）----
  Future<void> renameThread(String id, String title) async {
    final next = title.trim();
    if (next.isEmpty) throw Exception('会话标题不能为空');
    await client.post('/api/thread/rename', {'threadId': id, 'title': next});
    final index = threads.indexWhere((thread) => (thread['id'] ?? thread['threadId']) == id);
    if (index >= 0) threads[index] = {...threads[index], 'title': next};
    notifyListeners();
  }

  Future<void> archiveThread(String id) async {
    await client.post('/api/thread/archive', {'threadId': id});
    _dropThread(id);
  }

  Future<void> deleteThread(String id) async {
    await client.post('/api/thread/delete', {'threadId': id});
    _dropThread(id);
  }

  void _dropThread(String id) {
    threads.removeWhere((thread) => (thread['id'] ?? thread['threadId']) == id);
    if (threadId == id) {
      threadId = null;
      events = [];
      busy = false;
    }
    if (lastThreadId == id) lastThreadId = null;
    notifyListeners();
  }

  /// 新建自定义技能：写一份 SKILL.md 到 CODEX_HOME/skills/<slug>/，再刷新列表。
  Future<void> createSkill(String name, String description, String body) async => _run(() async {
    final slug = name.trim().toLowerCase().replaceAll(RegExp(r'[^a-z0-9_-]+'), '-').replaceAll(RegExp(r'^-+|-+\$'), '');
    if (slug.isEmpty) throw Exception('技能名要用英文/数字');
    final path = '/root/.codex/skills/$slug/SKILL.md';
    final content = '---\nname: "$name"\ndescription: "$description"\n---\n\n$body\n';
    await client.post('/api/fs/write', {'path': path, 'content': content});
    await loadSkills();
  });

  /// 对话分支：把当前线程 fork 成一条新线程，然后切过去。
  Future<void> forkThread() async => _run(() async {
    final id = threadId;
    if (id == null) throw Exception('还没有活动会话');
    final result = await client.post('/api/thread/fork', {'threadId': id});
    final created = (result['threadId'] ?? (result['thread'] as Map?)?['id'])?.toString();
    await refreshThreads();
    if (created != null && created.isNotEmpty) await resumeThread(created);
  });

  /// 从某一回合分支：`lastTurnId` 传了就「从该回合分支」（codex 原生 fork），
  /// 不传是整段历史照抄。成功后把新会话载入界面，返回新会话 id；
  /// 失败原因走 `_run` 统一放进 `error`，返回 null。
  Future<String?> branchFromTurn(String? turnId) async {
    String? created;
    await _run(() async {
      final id = threadId;
      if (id == null || id.isEmpty) throw Exception('还没有活动会话，无法分支');
      final lastTurnId = turnId?.trim() ?? '';
      final result = await client.post('/api/thread/fork', {
        'threadId': id,
        if (lastTurnId.isNotEmpty) 'lastTurnId': lastTurnId,
      });
      final createdId = (result['threadId'] ?? (result['thread'] as Map?)?['id'])?.toString();
      if (createdId == null || createdId.isEmpty) throw Exception('分支失败：桥没有返回 threadId');
      created = createdId;
      await refreshThreads();
    });
    final createdId = created;
    if (createdId == null || error != null) return null;
    // 分支会照抄历史，重新载入让对话内容不断档（失败时错误落在 error 上）。
    await resumeThread(createdId);
    return error == null ? createdId : null;
  }

  /// 消息所属回合的 turnId。用户消息是本地生成的、本身不带回合，
  /// 取它之后第一条带 turnId 的助手事件。
  String? turnIdOfMessage(int index) {
    if (index < 0 || index >= events.length) return null;
    final own = events[index].turnId;
    if (own != null && own.isNotEmpty) return own;
    for (var i = index + 1; i < events.length; i++) {
      final event = events[i];
      if (event.type == 'user' || event.type == 'userMessage') break;
      final id = event.turnId;
      if (id != null && id.isNotEmpty) return id;
    }
    return null;
  }

  /// 这条消息之前那一轮的 turnId。编辑重发时 `lastTurnId` 是「复制到哪一回合」，
  /// 必须传更早那一轮，新分支里才不会留着这条旧消息；第一条消息返回 null（整段照抄）。
  String? turnIdBeforeMessage(int index) {
    final own = turnIdOfMessage(index);
    String? previous;
    for (var i = 0; i < index && i < events.length; i++) {
      final id = events[i].turnId;
      if (id == null || id.isEmpty || id == own) continue;
      previous = id;
    }
    return previous;
  }

  /// 编辑用户消息并重发：先分支到这条消息之前那一轮，再发新文本。
  /// 第一条消息没有更早回合可分支（桥整段照抄），界面上把这条之后的旧内容清掉，
  /// 否则会出现两条一样的用户消息。
  Future<void> editAndResend(
    int index,
    String text, {
    required String cwd,
    String? reasoning,
    String? approval,
    String? sandbox,
  }) async {
    if (index < 0 || index >= events.length || text.trim().isEmpty) return;
    final previous = turnIdBeforeMessage(index);
    final created = await branchFromTurn(previous);
    if (created == null) return;
    if (previous == null) {
      events.clear();
    }
    await send(text.trim(), cwd: cwd, reasoning: reasoning, approval: approval, sandbox: sandbox);
  }

  /// 多中转站：来自桥的 /api/providers。
  List<Map<String, dynamic>> providers = [];
  String? currentProvider;

  Future<void> loadProviders() async {
    try {
      final r = await client.get('/api/providers');
      final list = (r['providers'] as List? ?? []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
      if (list.isEmpty) {
        // 兜底：只用 config 里的当前 provider，至少让抽屉有分组可点。
        final provider = (config['provider'] ?? r['current'] ?? '').toString();
        if (provider.isNotEmpty) {
          providers = [
            {'id': provider, 'baseUrl': (config['baseUrl'] ?? '').toString(), 'apiKeyConfigured': true},
          ];
        }
      } else {
        providers = list;
      }
      currentProvider = (r['current'] ?? config['provider'])?.toString();
      notifyListeners();
    } catch (_) {}
  }

  // ---- 渠道（CONTRACT-V3 B）：多渠道注册表，密钥只在保存时上行、任何列表都不回显 ----
  List<Map<String, dynamic>> channels = [];
  String? activeChannelId;

  /// 活动渠道：优先 `/api/channels` 的 active id，其次条目上的 active:true；
  /// 都没有（还没激活任何渠道）时返回 null，界面退回 config 里的模型。
  Map<String, dynamic>? get activeChannel {
    if (channels.isEmpty) return null;
    final id = activeChannelId;
    if (id != null && id.isNotEmpty) {
      for (final channel in channels) {
        if (channel['id']?.toString() == id) return channel;
      }
    }
    for (final channel in channels) {
      if (channel['active'] == true) return channel;
    }
    return null;
  }

  /// `/api/channels` 全量快照；失败原因原样抛给页面（由页面决定怎么显示）。
  Future<void> loadChannels() async => _applyChannelList(await client.post('/api/channels'));

  void _applyChannelList(Map<String, dynamic> raw) {
    final list = raw['channels'];
    if (list is! List) throw Exception('渠道列表响应格式不正确（缺 channels）');
    final parsed = <Map<String, dynamic>>[];
    for (final entry in list.whereType<Map>()) {
      final channel = entry.cast<String, dynamic>();
      final id = (channel['id'] ?? '').toString();
      if (id.isEmpty) throw Exception('渠道列表里有缺少 id 的条目');
      parsed.add(channel);
    }
    channels = parsed;
    activeChannelId = raw['active']?.toString();
    notifyListeners();
  }

  /// 保存或更新一条渠道；返回桥确认的 id（缺省 id 由桥按 name 生成 slug）。
  /// `models` 只在「拉取模型后写回渠道」时传，其它时候保持桥上的已有列表。
  Future<String> saveChannel({
    String? id,
    required String name,
    required String baseUrl,
    required String wire,
    String? model,
    List<String>? models,
    String? apiKey,
  }) async {
    final trimmedName = name.trim();
    final trimmedUrl = baseUrl.trim();
    final key = (apiKey ?? '').trim();
    final trimmedModel = (model ?? '').trim();
    final normalizedWire = normalizeChannelWire(wire);
    if (trimmedName.isEmpty) throw Exception('渠道名称不能为空');
    if (trimmedUrl.isEmpty) throw Exception('Base URL 不能为空');
    if (channelWireOf(normalizedWire) == null) {
      throw Exception('协议类型只能是 ${codexChannelWires.map((option) => option.value).join(' / ')}');
    }
    final result = await client.post('/api/channels/save', {
      if (id != null && id.isNotEmpty) 'id': id,
      'name': trimmedName,
      'baseUrl': trimmedUrl,
      'wire': normalizedWire,
      if (trimmedModel.isNotEmpty) 'model': trimmedModel,
      'models': ?models,
      if (key.isNotEmpty) 'apiKey': key,
    });
    // save 的单条响应与列表条目「同上」；统一重读列表，顺带拿到新的 active。
    final savedId = (result['id'] ?? id ?? '').toString();
    await loadChannels();
    // 活动渠道保存后桥会立刻写 config.toml；本地同步一份，顶栏模型 chip 才不会显示旧值。
    if (savedId.isNotEmpty && activeChannelId == savedId && trimmedModel.isNotEmpty) {
      config = {...config, 'provider': savedId, 'model': trimmedModel};
      notifyListeners();
    }
    return savedId;
  }

  /// 只改渠道上的一个字段（模型 / 模型列表）：`/api/channels/save` 每次都要
  /// name/baseUrl/wire，所以用渠道自身的字段补齐，别让桥把缺省值当成清空。
  Future<void> patchChannel(Map<String, dynamic> channel, {String? model, List<String>? models}) async {
    final id = channel['id'].toString();
    await saveChannel(
      id: id,
      name: channel['name']?.toString() ?? id,
      baseUrl: channel['baseUrl']?.toString() ?? '',
      wire: normalizeChannelWire(channel['wire']?.toString()),
      model: model ?? channel['model']?.toString(),
      models: models,
    );
  }

  /// 展开渠道时按 id 拉模型并写回渠道（下次打开/别的界面直接有）；失败原样抛出。
  Future<List<String>> refreshChannelModels(Map<String, dynamic> channel) async {
    final id = channel['id'].toString();
    final result = await fetchChannelModels(id: id, wire: normalizeChannelWire(channel['wire']?.toString()));
    await patchChannel(channel, models: result.models);
    return result.models;
  }

  Future<void> removeChannel(String id) async {
    await client.post('/api/channels/remove', {'id': id});
    await loadChannels();
  }

  /// 激活渠道：桥会把该渠道写进 codex config.toml，之后新回合走它。
  /// 响应就是完整的渠道列表视图（含新的 active），直接用，不必再拉一次。
  Future<void> activateChannel(String id) async {
    _applyChannelList(await client.post('/api/channels/activate', {'id': id}));
    // 切换渠道后必须同步本地 config：否则新回合仍带着上一个渠道的模型 ID，
    // 上游会报「模型不存在」并一直重试（真机上表现为无限 Reconnecting）。
    try {
      config = await client.get('/api/config');
      notifyListeners();
    } catch (_) {}
    // 已有会话还绑在旧渠道上：现在就把它搬到新渠道（桥会先停回合再 fork，历史照抄），
    // 不然下一句话会拿新渠道的模型名打到旧上游。搬不动就把原因摆到界面上，别静默失败。
    if (threadId != null && threadChannel != null && threadChannel != id) {
      try {
        await _rebindThread();
      } on CodexBridgeException catch (e) {
        error = e.code == 'codex/thread-busy' ? '先把正在跑的回合停掉（或等它结束），再切换渠道' : '切换渠道后搬会话失败：${e.message}';
        notifyListeners();
      }
    }
  }

  /// 测试连接（CONTRACT-V4 C）：`POST /api/channels/test {id}` 完整探活一次。
  /// 成功返回模型数与延迟；失败抛 [CodexChannelTestFailure]，带桥的 stage 与原话。
  Future<CodexChannelTestReport> testChannel(String id) async {
    final channelId = id.trim();
    if (channelId.isEmpty) throw Exception('先保存渠道，再测试连接');
    try {
      final result = await client.post('/api/channels/test', {'id': channelId});
      return CodexChannelTestReport(
        wire: normalizeChannelWire(result['wire']?.toString()),
        models: _intValue(result['models']),
        latencyMs: _intValue(result['latencyMs']),
      );
    } on CodexBridgeException catch (error) {
      throw CodexChannelTestFailure(stage: (error.details['stage'] ?? '').toString(), message: error.message);
    }
  }

  /// 拉候选模型：编辑已有渠道时传 id（桥用已存密钥）；新增时用表单里的 baseUrl + wire + key。
  Future<({List<String> models, String? normalizedBaseUrl})> fetchChannelModels({
    String? id,
    String? baseUrl,
    required String wire,
    String? apiKey,
  }) async {
    final channelId = (id ?? '').trim();
    final url = (baseUrl ?? '').trim();
    final key = (apiKey ?? '').trim();
    if (channelId.isEmpty && url.isEmpty) throw Exception('先填 Base URL，再拉取模型');
    final result = await client.post('/api/channels/models', {
      if (channelId.isNotEmpty) 'id': channelId,
      if (url.isNotEmpty) 'baseUrl': url,
      'wire': wire,
      if (key.isNotEmpty) 'apiKey': key,
    });
    final models = result['models'];
    if (models is! List) throw Exception('模型列表响应格式不正确');
    final ids = <String>[];
    for (final entry in models) {
      final modelId = entry is Map ? entry['id']?.toString() : null;
      if (modelId == null || modelId.isEmpty) throw Exception('模型列表里有无法识别的条目');
      ids.add(modelId);
    }
    return (models: ids, normalizedBaseUrl: (result['normalizedBaseUrl'] ?? result['baseUrl'])?.toString());
  }

  // ---- 本机 / 远程（CONTRACT-V3 C）----
  static const connectionModeKey = 'codex.connectionMode';
  static const remoteBaseUrlKey = 'codex.remoteBaseUrl';

  /// `local` = 用运行时下发的地址与令牌；`remote` = 手填地址与令牌。
  String connectionMode = 'local';
  String remoteBaseUrl = '';
  bool get isRemoteMode => connectionMode == 'remote';

  Future<void> loadConnectionMode() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      connectionMode = prefs.getString(connectionModeKey) == 'remote' ? 'remote' : 'local';
      remoteBaseUrl = prefs.getString(remoteBaseUrlKey) ?? '';
    } catch (_) {
      connectionMode = 'local';
    }
  }

  /// 切换后立刻落盘：下次冷启动据此决定「要不要自动拉起本机运行时」。
  /// token 属于凭据，按仓库规则不落盘，只在当前进程内使用。
  Future<void> setConnectionMode(String mode) async {
    connectionMode = mode == 'remote' ? 'remote' : 'local';
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(connectionModeKey, connectionMode);
    } catch (_) {}
  }

  Future<void> saveRemoteBaseUrl(String url) async {
    remoteBaseUrl = url.trim();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(remoteBaseUrlKey, remoteBaseUrl);
    } catch (_) {}
  }

  // ---- 技能（skills/list）----
  List<Map<String, dynamic>> skills = [];
  bool skillsLoading = false;

  Future<void> loadSkills() async {
    skillsLoading = true;
    notifyListeners();
    try {
      final result = await client.post('/api/skills');
      final data = (result['data'] as List?) ?? const [];
      skills = [
        for (final entry in data.whereType<Map>())
          for (final skill in ((entry['skills'] as List?) ?? const []).whereType<Map>()) skill.cast<String, dynamic>(),
      ];
    } catch (e) {
      error = _message(e);
    }
    skillsLoading = false;
    notifyListeners();
  }

  // ---- MCP 服务器（mcpServerStatus/list）----
  List<Map<String, dynamic>> mcpServers = [];
  bool mcpLoading = false;

  Future<void> loadMcp() async {
    mcpLoading = true;
    notifyListeners();
    try {
      // 桥的 /api/mcp 只接受 POST（GET 会回 "Use POST for this endpoint"）。
      final result = await client.post('/api/mcp');
      final list = (result['data'] as List? ?? []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
      mcpServers = list;
    } catch (_) {
      mcpServers = [];
    } finally {
      mcpLoading = false;
      notifyListeners();
    }
  }

  Future<void> addMcpServer({
    required String name,
    required String command,
    List<String> args = const [],
    Map<String, String>? env,
    String? cwd,
    int? startupTimeoutSec,
    int? toolTimeoutSec,
  }) async {
    await client.post('/api/mcp/add', {
      'name': name,
      'command': command,
      'args': args,
      if (env != null && env.isNotEmpty) 'env': env,
      if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
      if (startupTimeoutSec != null) 'startupTimeoutSec': startupTimeoutSec,
      if (toolTimeoutSec != null) 'toolTimeoutSec': toolTimeoutSec,
    });
    await loadMcp();
  }

  Future<void> removeMcpServer(String name) async {
    await client.post('/api/mcp/remove', {'name': name});
    await loadMcp();
  }

  // ---- Workflows: official Codex prompt turns and explicitly approved shell steps ----
  List<Map<String, dynamic>> workflows = [];
  bool workflowsLoading = false;

  Future<void> loadWorkflows() async {
    workflowsLoading = true;
    notifyListeners();
    try {
      final result = await client.post('/api/workflow/list');
      workflows = ((result['workflows'] as List?) ?? const [])
          .whereType<Map>()
          .map((entry) => entry.cast<String, dynamic>())
          .toList();
    } finally {
      workflowsLoading = false;
      notifyListeners();
    }
  }

  Future<Map<String, dynamic>> createWorkflow(String name, List<Map<String, dynamic>> steps) async {
    final result = await client.post('/api/workflow/create', {'name': name, 'steps': steps});
    await loadWorkflows();
    return result;
  }

  Future<Map<String, dynamic>> getWorkflow(String id) => client.post('/api/workflow/get', {'id': id});

  Future<void> deleteWorkflow(String id) async {
    await client.post('/api/workflow/delete', {'id': id});
    await loadWorkflows();
  }

  Future<Map<String, dynamic>> runWorkflow(String id, {bool approveShell = false}) =>
      client.post('/api/workflow/run', {'id': id, if (approveShell) 'approveShell': true});

  // ---- 工具包：工具按包管理，禁用的包不暴露给模型 ----
  List<Map<String, dynamic>> toolpacks = [];
  bool toolpacksLoading = false;
  String? toolpacksError;

  Future<void> loadToolpacks() async {
    toolpacksLoading = true;
    toolpacksError = null;
    notifyListeners();
    try {
      final result = await client.post('/api/toolpacks');
      final packs = result['packs'];
      if (packs is! List) throw Exception('工具包列表响应格式不正确');
      toolpacks = packs.whereType<Map>().map((entry) => entry.cast<String, dynamic>()).toList();
    } catch (e) {
      toolpacksError = _message(e);
      rethrow;
    } finally {
      toolpacksLoading = false;
      notifyListeners();
    }
  }

  Future<void> toggleToolpack(String name, bool enabled) async {
    final result = await client.post('/api/toolpacks/toggle', {'name': name, 'enabled': enabled});
    final applied = result['enabled'];
    if (applied is! bool) throw Exception('工具包开关响应格式不正确');
    final index = toolpacks.indexWhere((pack) => pack['name']?.toString() == name);
    if (index >= 0) toolpacks[index] = {...toolpacks[index], 'enabled': applied};
    notifyListeners();
  }

  /// 复制一个含 index.mjs 的目录进用户工具包目录；返回桥确认的包名。
  Future<String> importToolpack(String path) async {
    final target = path.trim();
    if (target.isEmpty) throw Exception('要导入的工具包路径不能为空');
    final result = await client.post('/api/toolpacks/import', {'path': target});
    final name = result['name']?.toString() ?? '';
    if (name.isEmpty) throw Exception('导入响应缺少工具包名称');
    await loadToolpacks();
    return name;
  }

  /// 只有用户包能删；内置包由桥回 400 toolpack/builtin，原因照原样抛给界面。
  Future<void> removeToolpack(String name) async {
    await client.post('/api/toolpacks/remove', {'name': name});
    toolpacks.removeWhere((pack) => pack['name']?.toString() == name);
    notifyListeners();
  }

  /// 自定义中转站自动拉模型：让用户从 ID 列表里选，不再手打模型 ID。
  Future<List<String>> fetchProviderModels({String? baseUrl, String? apiKey, String? provider}) async {
    final url = (baseUrl ?? '').trim();
    if (url.isEmpty) throw Exception('先填写 Base URL，再拉取模型');
    final result = await client.post('/api/providers/models', {
      'baseUrl': url,
      if (apiKey != null && apiKey.trim().isNotEmpty) 'apiKey': apiKey.trim(),
      if (provider != null && provider.trim().isNotEmpty) 'provider': provider.trim(),
    });
    final models = result['models'];
    if (models is! List) throw Exception('模型列表响应格式不正确');
    final ids = <String>[];
    for (final entry in models) {
      final id = entry is Map ? entry['id']?.toString() : null;
      if (id == null || id.isEmpty) throw Exception('模型列表里有无法识别的条目');
      ids.add(id);
    }
    return ids;
  }

  Future<void> stopShell() async {
    final id = termProcessId;
    termProcessId = null;
    if (id == null) return;
    try {
      await client.post('/api/exec/terminate', {'processId': id});
    } catch (_) {}
  }

  final Map<String, bool> _turnBusy = {};
  Map<String, dynamic> config = {};
  List<Map<String, dynamic>> models = [];
  Map<String, dynamic> account = {};
  StreamSubscription<Map<String, dynamic>>? _subscription;
  Timer? _reconnectTimer;
  int _reconnectAttempt = 0;
  bool _connecting = false;
  bool _disposed = false;
  bool _subscribing = false;
  String? _streamHost;
  int _connectionGeneration = 0;

  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  Future<void> connect() async {
    if (_disposed) return;
    final generation = ++_connectionGeneration;
    _connecting = true;
    bool current() => !_disposed && generation == _connectionGeneration;
    // 不等待旧流取消完成：SSE 关闭可能要等到底层连接收尾，await 在这里会把
    // 「连接/重连」卡住不动（界面一直显示连接中）。取消照发，代次校验兜住迟到事件。
    final previous = _subscription;
    _subscription = null;
    _subscribing = false;
    if (previous != null) unawaited(previous.cancel());
    _reconnectTimer?.cancel();
    final host = '${client.baseUrl}|${client.token}';
    if (_streamHost != host) {
      seq = 0;
      agents.clear();
      _streamHost = host;
    }
    loading = true;
    error = null;
    notifyListeners();
    try {
      final nextHealth = await client.get('/healthz');
      if (!current()) return;
      if (nextHealth['ok'] != true) throw Exception((nextHealth['error'] ?? 'Bridge is not ready').toString());
      if (nextHealth['engine'] != 'codex') throw Exception('Unexpected engine: ${nextHealth['engine']}');
      final responses = await Future.wait([
        client.post('/api/thread/list'),
        client.get('/api/config'),
        client.get('/api/models'),
        client.get('/api/account'),
      ]);
      if (!current()) return;
      health = nextHealth;
      threads = ((responses[0]['threads'] as List?) ?? [])
          .whereType<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList();
      config = responses[1];
      models = ((responses[2]['models'] as List?) ?? [])
          .whereType<Map>()
          .map((e) => e.cast<String, dynamic>())
          .toList();
      account = responses[3];
      connected = true;
      _reconnectAttempt = 0;
      _subscribeEvents();
      // 连上之后对齐一次渠道：旧 provider 残留在 codex config 里时，
      // 会把 chat 渠道顶回 responses 直连（真机表现是 4023 model_unknown）。
      await _ensureActiveChannel();
    } catch (e) {
      if (!current()) return;
      connected = false;
      error = _message(e);
    } finally {
      // 只有仍然有效的那次握手才收尾；被新握手取代时 loading 归它管，
      // 否则上一轮的早退会把 loading 永久留在 true，界面一直像在转圈。
      if (current()) {
        _connecting = false;
        loading = false;
        notifyListeners();
      }
    }
  }

  /// 连上之后对齐一次渠道：`/api/channels` 有 active 渠道而 codex config 不是它时，
  /// 重新 activate（桥会重写 config.toml 的 model_provider / base_url）。
  /// 失败一律不冒泡：老桥没有渠道接口、或当前有活动回合（409）都不该影响对话。
  Future<void> _ensureActiveChannel() async {
    if (!connected) return;
    try {
      _applyChannelList(await client.post('/api/channels'));
      final id = activeChannelId;
      if (id == null || id.isEmpty) return;
      final channel = activeChannel;
      if (channel == null) return;
      if (config['provider']?.toString() == id) return;
      _applyChannelList(await client.post('/api/channels/activate', {'id': id}));
      config = {...config, 'provider': id, if (channel['model'] != null) 'model': channel['model']};
      notifyListeners();
    } catch (_) {
      // 对齐失败保持现状：不要用渠道错误覆盖已建立的连接。
    }
  }

  void _subscribeEvents() {
    if (_disposed || _subscribing || !connected) return;
    _subscribing = true;
    _subscription = client
        .events(seq)
        .listen(
          _onEvent,
          onError: (Object e) {
            _subscribing = false;
            if (_disposed) return;
            error = _message(e);
            connected = false;
            notifyListeners();
            _scheduleReconnect();
          },
          onDone: () {
            _subscribing = false;
            if (_disposed) return;
            connected = false;
            notifyListeners();
            _scheduleReconnect();
          },
        );
  }

  /// 事件流断开后重新握手：不要乐观地把 connected 置回 true（那会让界面显示「已连接」
  /// 而流其实是死的，随后 again onDone，700ms 一轮无限重建 —— 表现为整屏闪烁）。
  /// 这里走 connect() 重新校验 /healthz，并指数退避，成功后清零计数。
  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    final delay = Duration(milliseconds: (700 * (1 << _reconnectAttempt.clamp(0, 5))).clamp(700, 30000));
    _reconnectTimer = Timer(delay, () {
      if (_disposed || connected) return;
      // 正在握手（用户点「连接」或上一轮重连）时不要插一脚：connect() 会自增代次，
      // 把别人正在进行的握手判成过期而静默丢弃。
      if (_connecting || loading) {
        _scheduleReconnect();
        return;
      }
      _reconnectAttempt++;
      connect();
    });
  }

  Future<void> refreshThreads() async {
    final result = await client.post('/api/thread/list');
    threads = ((result['threads'] as List?) ?? []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
    notifyListeners();
  }

  Future<void> createThread(String cwd) async {
    await _run(() async {
      final result = await client.post('/api/thread/create', {'cwd': cwd});
      final created = result['threadId'] as String?;
      if (created == null || created.isEmpty) throw Exception('新建会话失败：桥没有返回 threadId');
      threadId = created;
      threadChannel = result['channel']?.toString() ?? activeChannelId;
      // 必须记住新线程：否则下次连接/回前台时会被「上次会话」顶回旧 threadId，
      // 表现就是「点了新对话，标题是新的、内容还是旧的」。
      await _rememberThread(created);
      _turnBusy[created] = false;
      // 新会话要清掉上一轮的对话、用量与计划，别让 71% 这种旧数字留在环上。
      events = [];
      currentTurnId = null;
      contextUsage = {};
      context = {...context, 'usage': null};
      plan = [];
      planExplanation = null;
      goal = null;
      usage = null;
      threadStatus = null;
      statusHint = null;
      error = null;
      busy = false;
      notifyListeners();
      await refreshThreads();
    });
  }

  Future<void> resumeThread(String id) async {
    await _run(() async {
      final result = await client.post('/api/thread/resume', {'threadId': id});
      threadId = result['threadId'] as String? ?? id;
      // 桥会告诉这个会话绑在哪个渠道；老桥没有这个字段就保留原值。
      if (result.containsKey('channel')) threadChannel = result['channel']?.toString();
      await _rememberThread(threadId!);
      busy = _turnBusy[threadId] == true;
      events = [];
      currentTurnId = null;
      plan = [];
      planExplanation = null;
      for (final raw in (result['items'] as List? ?? [])) {
        if (raw is Map) _appendResumedItem(raw.cast<String, dynamic>());
      }
    });
  }

  /// 把当前会话搬到当前活动渠道，返回是否真的搬了。
  /// 走桥的 `/api/thread/rebind`：桥会先停掉在跑的回合再 fork——分两步做（activate → fork）
  /// 时回合没停干净 fork 会失败，用户看到的就是「换了渠道就连不上」。
  Future<bool> _rebindThread() async {
    final source = threadId;
    if (source == null) return false;
    final result = await client.post('/api/thread/rebind', {'threadId': source, 'archiveSource': true});
    final created = (result['threadId'] ?? (result['thread'] as Map?)?['id'])?.toString();
    threadChannel = result['channel']?.toString() ?? activeChannelId ?? threadChannel;
    if (created == null || created.isEmpty || created == source) {
      notifyListeners();
      return false;
    }
    // fork 会照抄历史，重新载入让对话内容不断档。
    await resumeThread(created);
    notifyListeners();
    return true;
  }

  Future<bool> send(
    String text, {
    required String cwd,
    String? model,
    String? reasoning,
    String? approval,
    String? sandbox,
    List<String> images = const [],
    List<Map<String, dynamic>> files = const [],
  }) async {
    // 模型以「当前活动渠道」为准：本地 config 可能还没同步，带错模型会把请求打到
    // 别的渠道模型名上（真机曾经因此出现「界面是 6.1、报错却来自 ly」）。
    // 先与服务器对齐一次，避免长期开着页面时用过期快照发请求。
    if (activeChannel == null || config.isEmpty) {
      await refreshFromServer();
    }
    final channelModel = activeChannel?['model']?.toString();
    final wanted = (channelModel != null && channelModel.trim().isNotEmpty)
        ? channelModel.trim()
        : (model != null && model.trim().isNotEmpty)
        ? model.trim()
        : config['model']?.toString();
    if (threadId == null) {
      final result = await client.post('/api/thread/create', {
        'cwd': cwd,
        if (wanted != null && wanted.isNotEmpty) 'model': wanted,
      });
      threadId = result['threadId'] as String?;
      threadChannel = result['channel']?.toString() ?? activeChannelId;
      events = [];
      await refreshThreads();
    }
    var activeThread = threadId;
    _turnBusy[activeThread ?? ''] = true;
    busy = true;
    // 新回合开始：上一轮的 turnId 不能继续用，否则这一轮的思考链会并进上一轮。
    currentTurnId = null;
    final displayText = text.trim().isNotEmpty ? text : '发送 ${images.length + files.length} 个附件';
    events.add(PocketEvent('user', displayText, threadId: activeThread));
    notifyListeners();
    Future<void> post() async {
      final result = await client.post('/api/turn/send', {
        'threadId': activeThread,
        'text': text,
        if (images.isNotEmpty) 'images': images,
        if (files.isNotEmpty) 'files': files,
        if (wanted != null && wanted.isNotEmpty) 'model': wanted,
        'reasoningEffort': ?reasoning,
        'approvalPolicy': ?approval,
        'sandboxMode': ?sandbox,
      });
      final startedTurn = result['turnId']?.toString();
      if (startedTurn != null && startedTurn.isNotEmpty && activeThread == threadId) currentTurnId = startedTurn;
    }

    try {
      try {
        await post();
      } on CodexBridgeException catch (e) {
        if (e.code == 'channel/thread-binding') {
          // 会话还绑在旧渠道上：搬到当前渠道（fork 保历史）再把这条消息发过去。
          // 否则新渠道的模型名会打到旧上游，表现就是「一直 Reconnecting + 报错来自别的渠道」。
          if (!await _rebindThread()) rethrow;
          activeThread = threadId;
          _turnBusy[activeThread ?? ''] = true;
          events.add(PocketEvent('user', displayText, threadId: activeThread));
          await post();
          return true;
        }
        // 该线程还挂着一个卡死的回合（旧渠道在重试）时，先中断再发一次，
        // 否则用户会一直看到「上一个渠道」的报错而发不出消息。
        final threadBusy = e.message.contains('running turn') || e.message.contains('thread-busy');
        if (!threadBusy) rethrow;
        await client.post('/api/turn/interrupt', {'threadId': activeThread});
        await post();
      }
      return true;
    } catch (e) {
      _turnBusy[activeThread ?? ''] = false;
      busy = false;
      events.removeWhere(
        (event) => event.type == 'user' && event.payload == displayText && event.threadId == activeThread,
      );
      error = _message(e);
      notifyListeners();
      return false;
    }
  }

  /// 回到前台时重新读一次服务端事实（渠道 + 活动模型），避免界面标签停留在旧值。
  Future<void> refreshFromServer() async {
    try {
      await loadChannels();
      config = await client.get('/api/config');
      notifyListeners();
    } catch (_) {}
  }

  @visibleForTesting
  void acceptEvent(Map<String, dynamic> event) => _onEvent(event);

  @visibleForTesting
  void applyChannelListForTest(Map<String, dynamic> result) => _applyChannelList(result);

  void _onEvent(Map<String, dynamic> event) {
    final n = event['seq'];
    if (n is int && n > seq) seq = n;
    final type = event['type']?.toString() ?? 'event';
    // Agent events must be handled before the main-thread filter. Their
    // threadId is the optional parent thread, not the agent's own thread.
    if (type.startsWith('agent.')) {
      agents.apply(event);
      notifyListeners();
      return;
    }

    // 终端输出不挂 thread，先处理掉，别被下面的线程过滤吞了。
    if (type == 'exec.output') {
      final pid = event['processId']?.toString();
      if (pid == null || pid == termProcessId) {
        final raw = event['delta']?.toString() ?? '';
        if (raw.isNotEmpty) {
          try {
            _terminalOut.add(utf8.decode(base64Decode(raw), allowMalformed: true));
          } catch (_) {}
        }
      }
      return;
    }
    final params = event['params'] is Map ? (event['params'] as Map).cast<String, dynamic>() : event;
    final eventThread = (event['threadId'] ?? params['threadId'])?.toString();
    final stateThread = eventThread ?? threadId;
    // 桥的事件都带 turnId；老桥没带就沿用当前回合，别让思考链断成两截。
    final eventTurnId = (event['turnId'] ?? params['turnId'])?.toString();
    final ownThread = eventThread == null || eventThread == threadId;
    final turnId = (eventTurnId == null || eventTurnId.isEmpty) ? currentTurnId : eventTurnId;
    if (ownThread && eventTurnId != null && eventTurnId.isNotEmpty) currentTurnId = eventTurnId;
    if (type == 'turn.start') _turnBusy[stateThread ?? ''] = true;
    if (type == 'turn.end') {
      // 回合结束：清掉当前回合，下一轮没带 turnId 的事件不会被并进这一轮的思考链。
      // 只有当前会话的回合结束才算，别被后台会话的 turn.end 带跑。
      if (ownThread) currentTurnId = null;
      // 任何线程的 turn 结束都要清掉对应忙碌标记；没带 threadId 就整体清空，
      // 否则界面会一直「正在思考」而答案早就出来了（真机复现过）。
      if (stateThread != null) {
        _turnBusy[stateThread] = false;
      } else {
        _turnBusy.clear();
      }
      if (event['usage'] is Map) usage = (event['usage'] as Map).cast<String, dynamic>();
      if (event['error'] != null || event['status'] == 'failed')
        error = (event['error'] ?? event['message'] ?? 'Turn failed').toString();
      // A finished turn can never still be awaiting approval. Remove any
      // leftover cards even if the resolved notification was missed.
      events.removeWhere(
        (entry) =>
            entry.type == 'approval.request' &&
            entry.threadId == stateThread &&
            (eventTurnId == null || entry.turnId == null || entry.turnId == eventTurnId),
      );
    }
    if (type == 'approval.resolved' || type == 'approval/resolved') {
      final approvalId = event['approvalId']?.toString();
      events.removeWhere((entry) => entry.approvalId == approvalId);
    }
    busy = _turnBusy[threadId ?? ''] == true;
    if (eventThread != null && eventThread != threadId) return;
    if (type == 'approval.resolved' || type == 'approval/resolved') {
      final approvalId = event['approvalId']?.toString();
      events.removeWhere((entry) => entry.approvalId == approvalId);
      notifyListeners();
      return;
    }
    final payload = event['payload'] is Map
        ? (event['payload'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final item = params['item'] is Map ? (params['item'] as Map).cast<String, dynamic>() : params;
    final itemId = (event['itemId'] ?? event['item_id'] ?? item['id'])?.toString();
    final text =
        (item['text'] ??
                item['command'] ??
                item['output'] ??
                params['message'] ??
                event['text'] ??
                event['chunk'] ??
                payload['command'] ??
                payload['reason'] ??
                payload['patch'] ??
                event['patch'] ??
                '')
            .toString();
    final displayType = type == 'tool.output' ? 'tool.output' : type;

    // Agent 面：计划 / 目标 / 用量 / 线程状态，各自更新状态后直接返回。
    if (type == 'plan.updated') {
      plan = ((event['steps'] as List?) ?? []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
      planExplanation = event['explanation']?.toString();
      notifyListeners();
      return;
    }
    if (type == 'goal.updated') {
      goal = event['goal'] is Map ? (event['goal'] as Map).cast<String, dynamic>() : null;
      notifyListeners();
      return;
    }
    if (type == 'usage') {
      usage = event['usage'] is Map ? (event['usage'] as Map).cast<String, dynamic>() : null;
      notifyListeners();
      return;
    }
    if (type == 'thread.status') {
      threadStatus = event['status']?.toString();
      notifyListeners();
      return;
    }
    // Codex 的上游重试提示（"Reconnecting... 1/5"）是状态噪音，不能当成聊天内容；
    // 真错误进横幅，重试提示只在输入框上方显示一行小字。
    if (type == 'error') {
      final message = (event['message'] ?? event['error'] ?? 'Codex 报告了一个错误').toString();
      if (RegExp(r'^Reconnecting').hasMatch(message) || RegExp(r'^Retrying').hasMatch(message)) {
        statusHint = message;
      } else {
        statusHint = null;
        error = message;
      }
      notifyListeners();
      return;
    }
    if (type == 'turn.start') statusHint = null;
    if (type == 'turn.end') statusHint = null;

    // 上下文用量：桥在 tokenUsage 更新时广播，环形进度条直接吃这一条。
    if (type == 'context.usage') {
      contextUsage = {
        'threadId': eventThread ?? threadId,
        'totalTokens': event['totalTokens'],
        'contextWindow': event['contextWindow'],
        'contextWindowSource': event['contextWindowSource'],
        'percent': event['percent'] ?? (event['usage'] as Map?)?['percent'],
      };
      contextWindowSource = event['contextWindowSource']?.toString() ?? contextWindowSource;
      context = {...context, 'usage': contextUsage};
      notifyListeners();
      return;
    }
    if (type == 'context.compacted' || type == 'context.compact-failed') {
      contextNotice = type == 'context.compacted'
          ? '已自动压缩上下文${event['percent'] == null ? '' : '（${event['percent']}%）'}'
          : '自动压缩失败：${event['message'] ?? event['error'] ?? '原因未知'}';
      notifyListeners();
      return;
    }

    // 过程流：item.start / item.delta / item.end 合成一条「步骤」，按发生顺序留在正文上方。
    // 正文（agentMessage）仍走 text.delta，思考走 reasoning.delta，这里只接其余步骤。
    if (type == 'item.start' || type == 'item.delta' || type == 'item.end') {
      final stepType = (event['itemType'] ?? '').toString();
      if (stepType.isEmpty || stepType == 'agentMessage' || stepType == 'reasoning') return;
      final sid = itemId;
      final existing = sid == null
          ? -1
          : events.lastIndexWhere(
              (entry) =>
                  entry.type == 'step' && entry.itemId == sid && entry.threadId == threadId && entry.turnId == turnId,
            );
      if (type == 'item.start') {
        events.add(
          PocketEvent(
            'step',
            '',
            itemId: sid,
            threadId: threadId,
            turnId: turnId,
            itemType: stepType,
            name: (event['name'] ?? '').toString(),
            status: 'running',
          ),
        );
        streamRevision++;
        notifyListeners();
        return;
      }
      if (existing < 0) return;
      final prev = events[existing];
      if (type == 'item.end') {
        final duration = event['durationMs'];
        events[existing] = PocketEvent(
          'step',
          prev.payload,
          itemId: sid,
          threadId: threadId,
          turnId: prev.turnId ?? turnId,
          itemType: prev.itemType,
          name: prev.name,
          status: (event['status'] ?? 'completed').toString(),
          exitCode: event['exitCode'] is int ? event['exitCode'] as int : null,
          durationMs: duration is int ? duration : prev.durationMs,
        );
      } else {
        final delta = (event['delta'] ?? '').toString();
        if (delta.isEmpty) return;
        events[existing] = PocketEvent(
          'step',
          prev.payload + delta,
          itemId: sid,
          threadId: threadId,
          turnId: prev.turnId ?? turnId,
          itemType: prev.itemType,
          name: prev.name,
          status: prev.status,
          exitCode: prev.exitCode,
          durationMs: prev.durationMs,
        );
      }
      streamRevision++;
      notifyListeners();
      return;
    }

    // 工具按回合 + item 归并；参数与输出分开累加，迟到分片不复活已完成工具。
    if (type == 'tool.start' || type == 'tool.args.delta' || type == 'tool.output' || type == 'tool.end') {
      final command = (event['name'] ?? item['command'] ?? item['name'] ?? '').toString();
      final idx = itemId == null
          ? -1
          : events.lastIndexWhere(
              (e) => e.itemId == itemId && e.turnId == turnId && e.type.startsWith('tool.') && e.threadId == threadId,
            );
      final prev = idx < 0 ? null : events[idx];
      final chunk = type == 'tool.output' ? text : '';
      final out = type == 'tool.output'
          ? (event['replace'] == true ? chunk : (prev?.payload ?? '') + chunk)
          : (prev?.payload ?? '');
      final argsDelta = type == 'tool.args.delta' ? (event['delta'] ?? params['delta'] ?? text).toString() : '';
      final rawArguments = event['args'] ?? item['arguments'];
      final arguments = type == 'tool.args.delta'
          ? (prev?.arguments ?? '') + argsDelta
          : (prev?.arguments.isNotEmpty ?? false)
          ? prev!.arguments
          : rawArguments == null
          ? ''
          : rawArguments is String
          ? rawArguments
          : jsonEncode(rawArguments);
      final ended = type == 'tool.end';
      final code = event['exitCode'];
      final next = PocketEvent(
        'tool.start',
        out,
        itemType: prev?.itemType ?? event['itemType']?.toString() ?? item['type']?.toString(),
        itemId: itemId,
        threadId: threadId,
        turnId: turnId,
        name: (prev?.name?.isNotEmpty ?? false) ? prev!.name : (command.isEmpty ? null : command),
        status: ended
            ? (event['status']?.toString() ?? ((code is int && code != 0) ? 'failed' : 'completed'))
            : (prev?.status ?? 'running'),
        exitCode: ended && code is int ? code : prev?.exitCode,
        arguments: arguments,
      );
      if (idx >= 0) {
        events[idx] = next;
      } else {
        events.add(next);
      }
      if (prev == null ||
          next.payload != prev.payload ||
          next.arguments != prev.arguments ||
          next.name != prev.name ||
          next.status != prev.status ||
          next.exitCode != prev.exitCode) {
        streamRevision++;
      }
      notifyListeners();
      return;
    }

    // diff 通知是最新完整快照，不是增量；按会话 + 回合 + item 替换，避免重复卡。
    if (type == 'diff') {
      if (text.isEmpty) return;
      final index = events.lastIndexWhere(
        (entry) =>
            entry.type == 'diff' && entry.itemId == itemId && entry.threadId == threadId && entry.turnId == turnId,
      );
      final next = PocketEvent('diff', text, itemId: itemId, threadId: threadId, turnId: turnId);
      if (index >= 0)
        events[index] = next;
      else
        events.add(next);
      streamRevision++;
      notifyListeners();
      return;
    }

    if (text.isNotEmpty || type.contains('approval') || type.contains('command')) {
      // 只归并相邻同类分片，跨过正文/思考/工具后追加新段，保持事件顺序。
      final mergeIndex =
          itemId != null &&
              events.isNotEmpty &&
              events.last.itemId == itemId &&
              events.last.type == type &&
              events.last.threadId == threadId &&
              events.last.turnId == turnId
          ? events.length - 1
          : -1;
      if (mergeIndex >= 0 && (type == 'text.delta' || type == 'reasoning.delta' || type == 'tool.output')) {
        final last = events[mergeIndex];
        final value = type == 'tool.output' && event['replace'] == true ? text : last.payload + text;
        events[mergeIndex] = PocketEvent(
          last.type,
          value,
          itemType: last.itemType,
          itemId: itemId,
          threadId: threadId,
          turnId: last.turnId ?? turnId,
        );
      } else {
        events.add(
          PocketEvent(
            displayType,
            text.isEmpty ? jsonEncode(event) : text,
            itemType: item['type']?.toString(),
            approvalId: event['approvalId']?.toString(),
            itemId: itemId,
            threadId: threadId,
            turnId: turnId,
          ),
        );
      }
      if (type == 'text.delta' || type == 'agent_message' || type == 'agentMessage') {
        streamRevision++;
        answerRevision++;
      } else if (type == 'reasoning.delta' || type == 'reasoning') {
        streamRevision++;
      }
    }
    notifyListeners();
  }

  void _appendResumedItem(Map<String, dynamic> item) {
    final rawType = (item['type'] ?? item['kind'] ?? '').toString();
    // A persisted approval request is historical evidence, not a live RPC.
    // Only the bridge's current pendingApprovals map may create actionable cards.
    if (rawType.toLowerCase().contains('approval')) return;
    final itemType = switch (rawType) {
      'userMessage' || 'user_message' => 'user',
      'agentMessage' || 'assistantMessage' || 'assistant_message' => 'agent_message',
      _ => rawType,
    };
    final raw = item['text'] ?? item['content'] ?? item['message'];
    final text = raw is String
        ? raw
        : raw is List
        ? raw.map((part) => part is Map ? (part['text'] ?? part['content'] ?? '').toString() : part.toString()).join()
        : '';
    // 历史线程里也会残留上游重试提示，恢复时直接按行剔掉，别变成聊天气泡。
    final cleaned = stripRetryLines(text).trim();
    if (cleaned.isNotEmpty)
      events.add(
        PocketEvent(
          itemType,
          cleaned,
          itemType: rawType,
          itemId: item['id']?.toString(),
          threadId: threadId,
          turnId: item['turnId']?.toString(),
        ),
      );
  }

  static final RegExp _retryLine = RegExp(r'^\s*(Reconnecting|Retrying)\b', caseSensitive: false);

  /// 上游重试提示（"Reconnecting... 1/5" / "Retrying..."）是状态噪音：
  /// 它可能混进消息正文或历史 items，渲染/恢复前按行剔掉，只留 statusHint 一行灰字。
  static String stripRetryLines(String text) => text.split('\n').where((line) => !_retryLine.hasMatch(line)).join('\n');

  /// 转向：在 turn 跑着的时候追加指令，不等当前 turn 结束。
  Future<void> steer(String text) async => _run(() async {
    final id = threadId;
    final expectedTurnId = currentTurnId;
    if (id == null || !busy || expectedTurnId == null || expectedTurnId.isEmpty) throw Exception('当前回合还不能插话，请等待回合开始');
    if (text.trim().isEmpty) throw Exception('插话内容不能为空');
    await client.post('/api/turn/steer', {'threadId': id, 'expectedTurnId': expectedTurnId, 'text': text.trim()});
  });

  /// 删除消息所在回合及后续对话；只改 Codex 历史，不撤销文件或命令副作用。
  Future<bool> revertMessage(int index) async {
    final id = threadId;
    final beforeTurnId = turnIdOfMessage(index);
    if (id == null || beforeTurnId == null || beforeTurnId.isEmpty) {
      error = '这条消息还没有可回滚的回合 ID';
      notifyListeners();
      return false;
    }
    await _run(() async {
      if (busy) throw Exception('请先停止当前回合，再删除对话历史');
      await client.post('/api/thread/revert', {'threadId': id, 'beforeTurnId': beforeTurnId});
      await refreshThreads();
    });
    if (error != null) return false;
    // 协议已改持久化历史；必须重新读取，不能只截本地数组。
    await resumeThread(id);
    return error == null;
  }

  Future<void> setGoal(String objective) async => _run(() async {
    final id = threadId;
    if (id == null) throw Exception('还没有活动会话');
    goal = await client.post('/api/thread/goal', {'threadId': id, 'action': 'set', 'objective': objective});
  });

  Future<void> clearGoal() async => _run(() async {
    final id = threadId;
    if (id == null) return;
    await client.post('/api/thread/goal', {'threadId': id, 'action': 'clear'});
    goal = null;
  });

  Future<void> compact() async => _run(() async {
    final id = threadId;
    if (id == null) throw Exception('还没有活动会话');
    await client.post('/api/thread/compact', {'threadId': id});
  });

  Future<void> interrupt() async => _run(() async {
    final id = threadId;
    await client.post('/api/turn/interrupt', {'threadId': id});
    _turnBusy[id ?? ''] = false;
    busy = false;
  });

  /// 卡住的回合要能一次性清掉：保存渠道/重启 app-server 都要求没有活动回合。
  Future<Map<String, dynamic>> interruptAll() async {
    Map<String, dynamic> result = const {};
    try {
      result = await client.post('/api/turn/interrupt-all');
      _turnBusy.clear();
      busy = false;
      error = null;
    } catch (e) {
      error = _message(e);
    }
    notifyListeners();
    return result;
  }

  /// 用户可以手动关掉错误横幅；下次失败会重新写入。
  void clearError() {
    error = null;
    notifyListeners();
  }

  final Set<String> _approvalInFlight = <String>{};
  Future<void> approve(String approvalId, bool approved, {bool forSession = false}) async {
    if (approvalId.isEmpty) {
      events.removeWhere((entry) => entry.type == 'approval.request' && entry.approvalId == approvalId);
      notifyListeners();
      return;
    }
    if (!_approvalInFlight.add(approvalId)) return;
    error = null;
    notifyListeners();
    try {
      await client.post('/api/approval', {
        'approvalId': approvalId,
        'decision': approved ? (forSession ? 'acceptForSession' : 'accept') : 'decline',
      });
      events.removeWhere((entry) => entry.approvalId == approvalId);
    } on CodexBridgeException catch (e) {
      if (e.code == 'codex/approval-expired') {
        events.removeWhere((entry) => entry.approvalId == approvalId);
        error = null;
      } else {
        error = _message(e);
      }
    } catch (e) {
      error = _message(e);
    } finally {
      _approvalInFlight.remove(approvalId);
      notifyListeners();
    }
  }

  Future<void> saveConfig(Map<String, dynamic> value) async => _run(() async {
    config = await client.post('/api/config', value);
    // 本地留一份最近配置，没连上时界面也能显示「上次用的是哪个模型」。
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('codex.config', jsonEncode(config));
    } catch (_) {}
  });

  /// 启动时先把上次的配置读出来，别一进 App 就显示「未选模型」。
  Future<void> loadCachedConfig() async {
    if (config.isNotEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('codex.config');
      if (raw == null || raw.isEmpty) return;
      config = (jsonDecode(raw) as Map).cast<String, dynamic>();
      notifyListeners();
    } catch (_) {}
  }

  Future<void> _run(Future<void> Function() action) async {
    error = null;
    notifyListeners();
    try {
      await action();
    } catch (e) {
      error = _message(e);
    }
    notifyListeners();
  }

  String _message(Object e) => e.toString().replaceFirst('Exception: ', '');
  @override
  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _subscription?.cancel();
    agents.dispose();
    client.close();
    super.dispose();
  }
}
