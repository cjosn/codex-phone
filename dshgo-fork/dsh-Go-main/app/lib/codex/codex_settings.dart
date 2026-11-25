import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'codex_brand.dart';
import 'codex_device.dart';
import 'codex_pocket_state.dart';
import 'codex_theme.dart';
import 'codex_ui_kit.dart';

/// Settings is an intent-based hub. Every row opens a focused page instead of
/// placing connection secrets, provider setup and runtime controls in one list.
class CodexSettingsHome extends StatelessWidget {
  const CodexSettingsHome({
    super.key,
    required this.state,
    required this.theme,
    required this.reasoning,
    required this.approval,
    required this.startingLogin,
    required this.runtimeStatus,
    required this.onReasoningChanged,
    required this.onApprovalChanged,
    required this.onThemeChanged,
    required this.onPickModel,
    required this.onStartLogin,
    required this.onCheckUpdate,
    required this.onRuntimeAction,
    required this.onShowRuntimeLogs,
    required this.onCopyFeedback,
    this.backgroundImage,
    this.onBackgroundImage,
  });

  final CodexPocketState state;
  final CodexTheme theme;
  final String reasoning;
  final String approval;
  final bool startingLogin;
  final Map<String, dynamic> runtimeStatus;
  final ValueChanged<String> onReasoningChanged;
  final ValueChanged<String> onApprovalChanged;
  final ValueChanged<CodexTheme> onThemeChanged;
  final VoidCallback onPickModel;
  final Future<void> Function() onStartLogin;
  final Future<void> Function() onCheckUpdate;
  final Future<Map<String, dynamic>> Function(String action) onRuntimeAction;
  final Future<void> Function() onShowRuntimeLogs;
  final Future<void> Function() onCopyFeedback;
  final String? backgroundImage;
  final ValueChanged<String?>? onBackgroundImage;

  @override
  Widget build(BuildContext context) {
    void open(Widget page) => Navigator.of(context).push(codexPageRoute(page));
    final model = state.config['model']?.toString();
    return ListView(
      key: const Key('settings-home'),
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(color: const Color(0xff252722), borderRadius: BorderRadius.circular(16)),
          child: Row(
            children: [
              const Icon(Icons.terminal, color: Colors.white, size: 25),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '官方 Codex · 本机运行',
                      style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      state.connected ? '已连接 · ${state.threads.length} 个会话' : '未连接 · 检查连接或运行时',
                      style: const TextStyle(color: Color(0xffb9beb1), fontSize: 11.5),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: '刷新 Codex 状态',
                onPressed: state.connect,
                icon: const Icon(Icons.refresh, color: Colors.white70, size: 19),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        CodexSection(
          title: '对话与 AI',
          children: [
            CodexSettingTile(
              icon: Icons.memory_outlined,
              title: '模型与渠道',
              subtitle:
                  '${model?.isEmpty == false ? model : '未选模型'} · '
                  '${state.activeChannel?['name'] ?? state.activeChannel?['id'] ?? state.currentProvider ?? state.config['provider'] ?? 'openai'}',
              onTap: () => open(CodexModelSettingsPage(state: state, onPickModel: onPickModel)),
            ),
            CodexSettingTile(
              icon: Icons.tune,
              title: '推理与审批',
              subtitle: '推理 ${_reasoningLabel(reasoning)} · ${_approvalLabel(approval)}',
              onTap: () => open(
                CodexBehaviorSettingsPage(
                  reasoning: reasoning,
                  approval: approval,
                  onReasoningChanged: onReasoningChanged,
                  onApprovalChanged: onApprovalChanged,
                ),
              ),
            ),
            CodexSettingTile(
              icon: Icons.notes_outlined,
              title: '长期指令',
              subtitle: state.systemPrompt.trim().isEmpty ? '配置 ~/.codex/AGENTS.md' : '已设置 · 新会话生效',
              onTap: () => open(CodexInstructionsSettingsPage(state: state)),
            ),
            CodexSettingTile(
              icon: Icons.badge_outlined,
              title: '人设',
              subtitle: state.personaActive && state.personaName.isNotEmpty
                  ? '${state.personaName} · 已启用'
                  : '名称 / 风格 / 指令，写进 AGENTS.md 托管区块',
              onTap: () => open(CodexPersonaSettingsPage(state: state)),
            ),
          ],
        ),
        CodexSection(
          title: '上下文与插件',
          children: [
            CodexSettingTile(
              icon: Icons.data_usage,
              title: '上下文与压缩',
              subtitle:
                  '${state.contextPercent == null ? '用量未知' : '已用 ${state.contextPercent!.round()}%'} · 阈值 ${state.contextThresholdPercent}%',
              onTap: () => open(CodexContextSettingsPage(state: state)),
            ),
            CodexSettingTile(
              icon: Icons.extension_outlined,
              title: '插件',
              subtitle: state.plugins.isEmpty ? '安装目录插件（工具包 / 技能）' : '${state.plugins.length} 个插件',
              onTap: () => open(CodexPluginsSettingsPage(state: state)),
            ),
          ],
        ),
        CodexSection(
          title: '手机与权限',
          children: [
            CodexSettingTile(
              icon: Icons.phonelink_lock_outlined,
              title: '手机能力',
              subtitle: '授权向导 / 读屏点击 / 截图 · 随时可退回标准权限',
              onTap: () => open(CodexDeviceSettingsPage(state: state)),
            ),
          ],
        ),
        CodexSection(
          title: '账号与主机',
          children: [
            CodexSettingTile(
              icon: Icons.account_circle_outlined,
              title: 'ChatGPT 账号',
              subtitle: state.account['account']?.toString() ?? '使用官方账号登录',
              onTap: () =>
                  open(CodexAccountSettingsPage(state: state, startingLogin: startingLogin, onLogin: onStartLogin)),
            ),
            CodexSettingTile(
              icon: Icons.link_outlined,
              title: 'Bridge 连接',
              subtitle:
                  '${state.connected ? '已连接' : '未连接'} · ${state.isRemoteMode ? '远程' : '本机'} · ${state.client.baseUrl}',
              onTap: () => open(CodexConnectionSettingsPage(state: state)),
            ),
            CodexSettingTile(
              icon: Icons.developer_board_outlined,
              title: 'Codex 运行时',
              subtitle: _runtimeLabel(runtimeStatus),
              onTap: () => open(
                CodexRuntimeSettingsPage(
                  status: runtimeStatus,
                  state: state,
                  onAction: onRuntimeAction,
                  onShowLogs: onShowRuntimeLogs,
                ),
              ),
            ),
          ],
        ),
        CodexSection(
          title: '应用',
          children: [
            CodexSettingTile(
              icon: Icons.palette_outlined,
              title: '外观',
              subtitle: '${theme.name} · 四种本地主题',
              onTap: () => open(
                CodexAppearanceSettingsPage(
                  selected: theme,
                  onChanged: onThemeChanged,
                  backgroundImage: backgroundImage,
                  onBackgroundImage: onBackgroundImage,
                ),
              ),
            ),
            CodexSettingTile(
              icon: Icons.system_update_alt,
              title: '更新与关于',
              subtitle: '$kBrandName $kAppVersion',
              onTap: () => open(
                CodexAboutSettingsPage(state: state, onCheckUpdate: onCheckUpdate, onCopyFeedback: onCopyFeedback),
              ),
            ),
          ],
        ),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            '模型、账号、技能与终端均由官方 codex app-server 提供；Codex Pocket 不替换推理引擎。',
            style: TextStyle(fontSize: 11, height: 1.55, color: Color(0xff85877d)),
          ),
        ),
      ],
    );
  }

  static String _runtimeLabel(Map<String, dynamic> status) => switch (status['phase']) {
    'running' => '运行中 · codex app-server',
    'installed' => '已安装 · 未运行',
    'notInstalled' => '未安装',
    'error' => '需要检查错误',
    _ => '本机 PRoot / Ubuntu',
  };
}

class CodexModelSettingsPage extends StatefulWidget {
  const CodexModelSettingsPage({super.key, required this.state, required this.onPickModel});
  final CodexPocketState state;
  final VoidCallback onPickModel;

  @override
  State<CodexModelSettingsPage> createState() => _CodexModelSettingsPageState();
}

class _CodexModelSettingsPageState extends State<CodexModelSettingsPage> {
  CodexPocketState get state => widget.state;
  final _name = TextEditingController();
  final _baseUrl = TextEditingController();
  final _model = TextEditingController();
  final _key = TextEditingController();
  String _wire = 'openai-chat';
  String? _editingId;
  bool _loading = true;
  bool _saving = false;

  /// 桥上的那条渠道的四个字段：用来判断表单有没有改动（测试连接前要先保存）。
  String _savedName = '';
  String _savedBaseUrl = '';
  String _savedWire = 'openai-chat';
  String _savedModel = '';

  /// 保存成功过的 id：表单清空后还能直接测这条渠道。
  String? _lastSavedId;

  // 自动拉取的模型列表：只给下拉选项用，选中的 ID 才写进 _model。
  bool _fetchingModels = false;
  String? _modelFetchError;
  String? _modelFetchNotice;
  List<String> _fetchedModels = const [];
  String? _selectedModel;

  // 测试连接：成功给模型数+延迟，失败给桥的阶段与原话。
  bool _testing = false;
  CodexChannelTestReport? _testReport;
  CodexChannelTestFailure? _testFailure;

  String? _listError;
  String? _formError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _name.dispose();
    _baseUrl.dispose();
    _model.dispose();
    _key.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _listError = null;
    });
    try {
      await state.loadChannels();
    } catch (error) {
      if (mounted) setState(() => _listError = _errorText(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 进入编辑态：把该渠道填进下面的表单，密钥输入框始终从空开始（不回显）。
  void _editChannel(Map<String, dynamic> channel) => setState(() {
    _editingId = channel['id']?.toString();
    _name.text = channel['name']?.toString() ?? channel['id']?.toString() ?? '';
    _baseUrl.text = channel['baseUrl']?.toString() ?? '';
    // 旧值 chat/responses 归一化成新 wire，下拉里显示新名称。
    _wire = channelWireOf(channel['wire']?.toString())?.value ?? 'openai-chat';
    _model.text = channel['model']?.toString() ?? '';
    _key.clear();
    _fetchedModels = const [];
    _selectedModel = null;
    _modelFetchError = null;
    _formError = null;
    _rememberSaved();
  });

  void _resetForm() => setState(() {
    _editingId = null;
    _name.clear();
    _baseUrl.clear();
    _model.clear();
    _key.clear();
    _wire = 'openai-chat';
    _fetchedModels = const [];
    _selectedModel = null;
    _modelFetchError = null;
    _formError = null;
    _testReport = null;
    _testFailure = null;
    _rememberSaved();
  });

  /// 把表单当前值记成「桥上的值」，之后 `_formChanged` 用它判断有没有改动。
  void _rememberSaved() {
    _savedName = _name.text;
    _savedBaseUrl = _baseUrl.text;
    _savedWire = _wire;
    _savedModel = _model.text;
  }

  /// 表单里有没有还没上行的改动：测试连接要先保存，才能让桥按这条渠道探活。
  bool get _formChanged {
    if (_editingId != null) {
      return _name.text != _savedName ||
          _baseUrl.text != _savedBaseUrl ||
          _wire != _savedWire ||
          _model.text != _savedModel ||
          _key.text.trim().isNotEmpty;
    }
    // 还没保存过的新渠道：只要填了东西就算改动。
    return _name.text.trim().isNotEmpty ||
        _baseUrl.text.trim().isNotEmpty ||
        _model.text.trim().isNotEmpty ||
        _key.text.trim().isNotEmpty;
  }

  Future<void> _fetchModels() async {
    setState(() {
      _fetchingModels = true;
      _modelFetchError = null;
      _modelFetchNotice = null;
    });
    try {
      final result = await state.fetchChannelModels(
        id: _editingId,
        baseUrl: _baseUrl.text,
        wire: _wire,
        apiKey: _key.text,
      );
      if (!mounted) return;
      setState(() {
        _fetchingModels = false;
        final models = result.models;
        final normalized = result.normalizedBaseUrl;
        if (normalized != null && normalized.isNotEmpty && normalized != _baseUrl.text.trim()) {
          _baseUrl.text = normalized;
          _modelFetchNotice = '已按 $normalized 处理';
        } else {
          _modelFetchNotice = null;
        }
        _fetchedModels = models;
        // 不覆盖用户已填的模型 ID：只换选项，选中才写进输入框。
        _selectedModel = null;
        if (models.isEmpty) _modelFetchError = '端点没有返回任何模型 ID';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _fetchingModels = false;
        _modelFetchError = _errorText(error);
      });
    }
  }

  /// 走 `/api/channels/save`；成功返回桥确认的 id，失败返回桥的原话。
  Future<({String? id, String? error})> _persist(String apiKey) async {
    try {
      final id = await state.saveChannel(
        id: _editingId,
        name: _name.text,
        baseUrl: _baseUrl.text,
        wire: _wire,
        model: _model.text,
        apiKey: apiKey,
      );
      return (id: id, error: null);
    } catch (error) {
      return (id: null, error: _errorText(error));
    }
  }

  Future<void> _save() async {
    final apiKey = _key.text.trim();
    setState(() {
      _saving = true;
      _formError = null;
    });
    final saved = await _persist(apiKey);
    if (!mounted) return;
    setState(() {
      _saving = false;
      _formError = saved.error;
      if (saved.error == null) {
        // 只有真的存进去了才清掉密钥输入框；失败时用户不用重新粘贴。
        _lastSavedId = saved.id;
        _editingId = null;
        _name.clear();
        _baseUrl.clear();
        _model.clear();
        _key.clear();
        _wire = 'openai-chat';
        _fetchedModels = const [];
        _selectedModel = null;
        _rememberSaved();
      }
    });
    if (saved.error == null) showCodexMessage(context, '渠道已保存');
  }

  /// 测试连接：字段有改动先保存，再 `POST /api/channels/test {id}`。
  /// 失败阶段（connect/auth/list/infer）与桥的原话都照实显示，不吞。
  Future<void> _testConnection() async {
    setState(() {
      _testing = true;
      _testReport = null;
      _testFailure = null;
      _formError = null;
    });
    try {
      var id = _editingId ?? _lastSavedId;
      if (_formChanged) {
        final saved = await _persist(_key.text.trim());
        if (saved.error != null) {
          if (mounted) setState(() => _formError = saved.error);
          return;
        }
        id = saved.id;
        if (!mounted) return;
        setState(() {
          // 刚上行的密钥不再回显；表单内容保留，后续保存还走同一条渠道。
          _key.clear();
          _lastSavedId = saved.id ?? _lastSavedId;
          _editingId = saved.id ?? _editingId;
          _rememberSaved();
        });
      }
      if (id == null || id.isEmpty) {
        setState(() => _formError = '先填渠道信息并保存，再测试连接');
        return;
      }
      final report = await state.testChannel(id);
      if (mounted) setState(() => _testReport = report);
    } on CodexChannelTestFailure catch (failure) {
      if (mounted) setState(() => _testFailure = failure);
    } catch (error) {
      if (mounted) setState(() => _formError = _errorText(error));
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  /// 测试连接失败阶段的界面用词（CONTRACT-V4 C 的 details.stage）。
  static const _testStageLabels = {'connect': '连接', 'auth': '鉴权', 'list': '模型清单', 'infer': '推理'};

  String _testStageLabel(String stage) => _testStageLabels[stage] ?? (stage.isEmpty ? '未知阶段' : stage);

  /// 激活渠道会被「活动回合」拒绝（409 + details.activeTurns）。
  /// 别让用户卡在这儿：直接给「停止并重试」，停掉回合后重新激活。
  Future<void> _activateChannel(Map<String, dynamic> channel) async {
    final id = channel['id'].toString();
    setState(() => _listError = null);
    var failure = await _tryActivate(id);
    if (failure != null && failure.contains('active turn') && mounted) {
      final stop = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('有正在进行的回合'),
          content: const Text('切换渠道前要先结束当前回合。停止它并重试吗？'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(
              key: const Key('stop-turn-and-retry'),
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('停止并重试'),
            ),
          ],
        ),
      );
      if (stop == true && mounted) {
        await state.interruptAll();
        failure = await _tryActivate(id);
      }
    }
    if (!mounted) return;
    if (failure == null) {
      showCodexMessage(context, '已激活渠道 $id');
    } else {
      setState(() => _listError = failure);
    }
  }

  Future<String?> _tryActivate(String id) async {
    try {
      await state.activateChannel(id);
      return null;
    } catch (error) {
      return _errorText(error);
    }
  }

  Future<void> _removeChannel(Map<String, dynamic> channel) async {
    final id = channel['id'].toString();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除渠道'),
        content: Text('删除后不再保留 $id 的地址与密钥；如果它是活动渠道，桥会自动切到第一个。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            key: const Key('confirm-remove-channel'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _listError = null);
    try {
      await state.removeChannel(id);
    } catch (error) {
      if (mounted) setState(() => _listError = _errorText(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    final active = state.activeChannel;
    final model = (active?['model'] ?? state.config['model'])?.toString();
    final activeName = active?['name']?.toString() ?? active?['id']?.toString();
    return CodexSubpage(
      title: '模型与渠道',
      actions: [
        IconButton(
          key: const Key('reload-channels'),
          tooltip: '重新读取渠道',
          onPressed: _loading ? null : _load,
          icon: const Icon(Icons.refresh),
        ),
      ],
      children: [
        if (_loading) const LinearProgressIndicator(minHeight: 2),
        CodexSection(
          title: '当前模型',
          description: '来自 /api/channels 的活动渠道；点按打开模型池调整模型与推理强度。',
          children: [
            CodexSettingTile(
              key: const Key('current-model'),
              icon: Icons.memory_outlined,
              title: (model == null || model.isEmpty) ? '还没有活动模型' : model,
              subtitle: activeName == null
                  ? '${state.models.length} 个可用模型 · 还没有活动渠道'
                  : '活动渠道 · $activeName · ${state.models.length} 个可用模型',
              onTap: widget.onPickModel,
            ),
          ],
        ),
        CodexSection(
          title: '渠道',
          description: '一个渠道 = 一个地址 + 一种协议 + 一把密钥。OpenAI Responses 直连，其余协议由本机兼容代理转换。',
          children: [
            if (_listError != null) _errorBox(_listError!, const Key('channel-list-error')),
            if (!_loading && state.channels.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16, vertical: 18),
                child: Text('还没有渠道，用下面的表单新增一个', style: TextStyle(fontSize: 12, color: Color(0xff85867e))),
              ),
            for (final channel in state.channels) _channelTile(channel, active),
          ],
        ),
        CodexSection(
          title: _editingId == null ? '新增渠道' : '编辑渠道 · $_editingId',
          description: '密钥只上行保存，列表和表单都不会回显；保存成功后才清空输入框。',
          children: [
            Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                children: [
                  if (_formError != null) _errorBox(_formError!, const Key('channel-form-error')),
                  TextField(
                    key: const Key('channel-name'),
                    controller: _name,
                    decoration: codexFieldDecoration('名称', hint: '例如 中转 A / 官方直连'),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('channel-base-url'),
                    controller: _baseUrl,
                    keyboardType: TextInputType.url,
                    decoration: codexFieldDecoration('Base URL', hint: channelWireOf(_wire)?.example),
                  ),
                  const SizedBox(height: 12),
                  InputDecorator(
                    decoration: codexFieldDecoration('协议'),
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        key: const Key('channel-wire'),
                        value: _wire,
                        isExpanded: true,
                        items: [
                          for (final option in codexChannelWires)
                            DropdownMenuItem<String>(
                              value: option.value,
                              child: Text(option.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                            ),
                        ],
                        onChanged: _saving || _testing
                            ? null
                            : (value) {
                                if (value == null) return;
                                setState(() => _wire = value);
                              },
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      '示例：${channelWireOf(_wire)?.example ?? ''}',
                      key: const Key('channel-wire-example'),
                      style: const TextStyle(fontSize: 11, height: 1.45, color: Color(0xff4c5145)),
                    ),
                  ),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      channelWireOf(_wire)?.note ?? '',
                      key: const Key('channel-wire-note'),
                      style: const TextStyle(fontSize: 11, height: 1.45, color: Color(0xff85867e)),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      key: const Key('fetch-channel-models'),
                      onPressed: _fetchingModels ? null : _fetchModels,
                      icon: _fetchingModels
                          ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.cloud_download_outlined, size: 17),
                      label: Text(_fetchingModels ? '拉取中…' : '拉取模型'),
                    ),
                  ),
                  if (_modelFetchNotice != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        _modelFetchNotice!,
                        key: const Key('channel-base-normalized'),
                        style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xff2f5d3a)),
                      ),
                    ),
                  if (_modelFetchError != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: SelectableText(
                          _modelFetchError!,
                          key: const Key('channel-model-error'),
                          style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xff8b2b20)),
                        ),
                      ),
                    ),
                  if (_fetchedModels.isNotEmpty) ...[
                    DropdownButtonFormField<String>(
                      key: const Key('channel-fetched-models'),
                      initialValue: _selectedModel,
                      isExpanded: true,
                      decoration: codexFieldDecoration('从端点拉取的模型'),
                      hint: const Text('选择后写入下方模型 ID'),
                      items: [
                        for (final id in _fetchedModels)
                          DropdownMenuItem<String>(
                            value: id,
                            child: Text(id, maxLines: 1, overflow: TextOverflow.ellipsis),
                          ),
                      ],
                      onChanged: (value) {
                        if (value == null) return;
                        setState(() => _selectedModel = value);
                        _model.text = value;
                      },
                    ),
                    const SizedBox(height: 8),
                  ],
                  TextField(
                    key: const Key('channel-model'),
                    controller: _model,
                    decoration: codexFieldDecoration('模型 ID', hint: 'deepseek-v4.1-flash'),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('channel-api-key'),
                    controller: _key,
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    decoration: codexFieldDecoration(
                      'API Key',
                      hint: _editingId == null ? '仅提交，不在界面回显' : '已保存的密钥不回显；留空保持不变',
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_testReport != null)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: SelectableText(
                        '成功 · ${_testReport!.models} 个模型 · ${_testReport!.latencyMs}ms',
                        key: const Key('channel-test-ok'),
                        style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xff2f5d3a)),
                      ),
                    ),
                  if (_testFailure != null)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: SelectableText(
                        '失败于 ${_testStageLabel(_testFailure!.stage)}：${_testFailure!.message}',
                        key: const Key('channel-test-failure'),
                        style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xff8b2b20)),
                      ),
                    ),
                  if (_testReport != null || _testFailure != null) const SizedBox(height: 6),
                  Wrap(
                    alignment: WrapAlignment.end,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      if (_editingId != null)
                        TextButton(
                          key: const Key('cancel-edit-channel'),
                          onPressed: _saving || _testing ? null : _resetForm,
                          child: const Text('取消编辑'),
                        ),
                      OutlinedButton.icon(
                        key: const Key('channel-test'),
                        onPressed: _saving || _testing ? null : _testConnection,
                        icon: _testing
                            ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.wifi_tethering_outlined, size: 17),
                        label: Text(_testing ? '测试中…' : '测试连接'),
                      ),
                      FilledButton.icon(
                        key: const Key('save-channel'),
                        onPressed: _saving || _testing ? null : _save,
                        icon: const Icon(Icons.save_outlined, size: 17),
                        label: Text(_saving ? '保存中…' : (_editingId == null ? '新增渠道' : '保存渠道')),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _errorBox(String message, Key key) => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(14, 10, 14, 2),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(color: const Color(0xffffe8e4), borderRadius: BorderRadius.circular(9)),
    child: SelectableText(
      message,
      key: key,
      style: const TextStyle(fontSize: 12, height: 1.45, color: Color(0xff8b2b20)),
    ),
  );

  Widget _channelTile(Map<String, dynamic> channel, Map<String, dynamic>? active) {
    final id = channel['id'].toString();
    final isActive = channel['active'] == true || id == active?['id']?.toString();
    final keyReady = channel['apiKeyConfigured'] == true;
    final model = channel['model']?.toString() ?? '';
    final models = (channel['models'] as List?)?.length ?? 0;
    final subtitle = [
      channel['baseUrl']?.toString() ?? '',
      model.isEmpty ? '未选模型' : model,
      keyReady ? '密钥已配置' : '未配置密钥',
      if (models > 0) '$models 个模型',
    ].where((part) => part.isNotEmpty).join(' · ');
    return ListTile(
      key: Key('channel-$id'),
      leading: Icon(
        isActive ? Icons.radio_button_checked : Icons.dns_outlined,
        size: 20,
        color: isActive ? const Color(0xff376c48) : const Color(0xff4c5145),
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              channel['name']?.toString() ?? id,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
            ),
          ),
          // 徽标显示 wire 的中文名；旧值 chat/responses 也显示成新名称。
          // 窄屏（360dp）下图标按钮已经占满行尾，徽标按剩余宽度等比缩小而不是溢出。
          const SizedBox(width: 6),
          Flexible(
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: CodexStatusBadge(label: channelWireBadge(channel['wire']?.toString())),
            ),
          ),
          if (isActive) ...[
            const SizedBox(width: 4),
            const Flexible(
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: CodexStatusBadge(label: '活动', positive: true),
              ),
            ),
          ],
        ],
      ),
      subtitle: Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5)),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!isActive)
            IconButton(
              key: Key('channel-activate-$id'),
              tooltip: '激活渠道',
              visualDensity: VisualDensity.compact,
              onPressed: () => _activateChannel(channel),
              icon: const Icon(Icons.check_circle_outline, size: 20),
            ),
          IconButton(
            key: Key('channel-edit-$id'),
            tooltip: '编辑渠道',
            visualDensity: VisualDensity.compact,
            onPressed: () => _editChannel(channel),
            icon: const Icon(Icons.edit_outlined, size: 19),
          ),
          IconButton(
            key: Key('channel-remove-$id'),
            tooltip: '删除渠道',
            visualDensity: VisualDensity.compact,
            onPressed: () => _removeChannel(channel),
            icon: const Icon(Icons.delete_outline, size: 19),
          ),
        ],
      ),
    );
  }
}

class CodexBehaviorSettingsPage extends StatefulWidget {
  const CodexBehaviorSettingsPage({
    super.key,
    required this.reasoning,
    required this.approval,
    required this.onReasoningChanged,
    required this.onApprovalChanged,
  });
  final String reasoning;
  final String approval;
  final ValueChanged<String> onReasoningChanged;
  final ValueChanged<String> onApprovalChanged;

  @override
  State<CodexBehaviorSettingsPage> createState() => _CodexBehaviorSettingsPageState();
}

class _CodexBehaviorSettingsPageState extends State<CodexBehaviorSettingsPage> {
  late String _reasoning = widget.reasoning;
  late String _approval = widget.approval;

  @override
  Widget build(BuildContext context) => CodexSubpage(
    title: '推理与审批',
    children: [
      CodexSection(
        title: '默认推理强度',
        description: '控制 Codex 在每个任务上投入的思考量。更强的推理通常更慢，并消耗更多额度。',
        children: [
          for (final option in const [
            ('low', '低', '快速回答与轻量修改'),
            ('medium', '中', '日常编码的均衡选择'),
            ('high', '高', '复杂调试与架构分析'),
            ('xhigh', '极高', '模型支持时用于最困难的任务'),
          ])
            RadioListTile<String>(
              value: option.$1,
              groupValue: _reasoning,
              title: Text(option.$2),
              subtitle: Text(option.$3),
              onChanged: (value) {
                if (value == null) return;
                setState(() => _reasoning = value);
                widget.onReasoningChanged(value);
              },
            ),
        ],
      ),
      CodexSection(
        title: '命令审批策略',
        description: '这是发送给官方 Codex 的 approvalPolicy。单条危险请求仍可在对话审批卡中拒绝。',
        children: [
          for (final option in const [
            ('on-request', '按需询问', 'Codex 判断需要授权时询问'),
            ('never', '不主动询问', '不会自动提升权限；被拒绝的操作会失败'),
          ])
            RadioListTile<String>(
              value: option.$1,
              groupValue: _approval,
              title: Text(option.$2),
              subtitle: Text(option.$3),
              onChanged: (value) {
                if (value == null) return;
                setState(() => _approval = value);
                widget.onApprovalChanged(value);
              },
            ),
        ],
      ),
    ],
  );
}

class CodexInstructionsSettingsPage extends StatefulWidget {
  const CodexInstructionsSettingsPage({super.key, required this.state});
  final CodexPocketState state;

  @override
  State<CodexInstructionsSettingsPage> createState() => _CodexInstructionsSettingsPageState();
}

class _CodexInstructionsSettingsPageState extends State<CodexInstructionsSettingsPage> {
  late final TextEditingController _controller = TextEditingController(text: widget.state.systemPrompt);
  bool _saving = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    await widget.state.saveSystemPrompt(_controller.text);
    if (mounted) {
      setState(() => _saving = false);
      showCodexMessage(context, widget.state.error ?? '已写入 AGENTS.md，新会话生效');
    }
  }

  @override
  Widget build(BuildContext context) => CodexSubpage(
    title: '长期指令',
    actions: [IconButton(tooltip: '保存指令', onPressed: _saving ? null : _save, icon: const Icon(Icons.save_outlined))],
    children: [
      const Text(
        '~/.codex/AGENTS.md',
        style: TextStyle(fontFamily: 'JetBrainsMono', fontSize: 12, color: Color(0xff6e7066)),
      ),
      const SizedBox(height: 8),
      const Text(
        '写入代码风格、测试要求、回复语言等长期约定。官方 Codex 会在新会话中读取它。',
        style: TextStyle(fontSize: 12, height: 1.55, color: Color(0xff777970)),
      ),
      const SizedBox(height: 16),
      TextField(
        controller: _controller,
        minLines: 16,
        maxLines: 30,
        style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 12.5, height: 1.55),
        decoration: codexFieldDecoration('AGENTS.md', hint: '# 项目约定\n\n- 修改后运行相关测试'),
      ),
      const SizedBox(height: 12),
      FilledButton.icon(
        onPressed: _saving ? null : _save,
        icon: const Icon(Icons.save_outlined),
        label: Text(_saving ? '正在写入…' : '保存到 Codex'),
      ),
    ],
  );
}

class CodexConnectionSettingsPage extends StatefulWidget {
  const CodexConnectionSettingsPage({super.key, required this.state});
  final CodexPocketState state;

  @override
  State<CodexConnectionSettingsPage> createState() => _CodexConnectionSettingsPageState();
}

class _CodexConnectionSettingsPageState extends State<CodexConnectionSettingsPage> {
  CodexPocketState get state => widget.state;
  late final TextEditingController _url = TextEditingController(
    text: state.isRemoteMode ? state.remoteBaseUrl : state.client.baseUrl,
  );
  final _token = TextEditingController();
  late String _mode = state.connectionMode;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  /// 模式立刻落盘（codex.connectionMode）：主页据此决定要不要自动拉起本机运行时。
  Future<void> _setMode(String mode) async {
    if (_mode == mode) return;
    setState(() {
      _mode = mode;
      _error = null;
      if (mode == 'remote' && _url.text.trim().isEmpty) _url.text = state.remoteBaseUrl;
    });
    await state.setConnectionMode(mode);
  }

  Future<void> _connect() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await state.setConnectionMode(_mode);
      if (_mode == 'remote') {
        final url = _url.text.trim().replaceFirst(RegExp(r'/$'), '');
        if (url.isEmpty) throw Exception('远程模式要先填 Bridge URL');
        state.client.baseUrl = url;
        final token = _token.text.trim();
        if (token.isNotEmpty) state.client.token = token;
        // token 属于凭据：只在内存里用，不落盘。
        _token.clear();
        await state.saveRemoteBaseUrl(url);
        await state.connect();
        if (!mounted) return;
        if (!state.connected) throw Exception(state.error ?? '连接失败');
        showCodexMessage(context, '已连接远程 Bridge');
      } else {
        // 本机模式：地址与临时令牌由运行时下发，这里不写死地址；主页会自动拉起并等待运行时。
        await state.connect();
        if (!mounted) return;
        showCodexMessage(context, state.connected ? '本机运行时已连接' : (state.error ?? '本机运行时还没就绪，启动后会自动连接'));
      }
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => CodexSubpage(
    title: 'Bridge 连接',
    children: [
      CodexSection(
        title: '连接模式',
        description: '本机 = 用运行时下发的地址与令牌，启动时自动拉起并等待本机运行时；远程 = 手填地址与令牌，不碰本机运行时。',
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Align(
                  alignment: Alignment.centerLeft,
                  child: Wrap(
                    spacing: 8,
                    children: [
                      ChoiceChip(
                        key: const Key('connection-mode-local'),
                        label: const Text('本机'),
                        selected: _mode == 'local',
                        onSelected: (selected) {
                          if (selected) _setMode('local');
                        },
                      ),
                      ChoiceChip(
                        key: const Key('connection-mode-remote'),
                        label: const Text('远程'),
                        selected: _mode == 'remote',
                        onSelected: (selected) {
                          if (selected) _setMode('remote');
                        },
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                if (_mode == 'local')
                  Text(
                    '地址与临时令牌由本机运行时下发。当前：${state.client.baseUrl}',
                    style: const TextStyle(fontSize: 11.5, height: 1.5, color: Color(0xff85877d)),
                  )
                else ...[
                  TextField(
                    key: const Key('bridge-url'),
                    controller: _url,
                    keyboardType: TextInputType.url,
                    decoration: codexFieldDecoration('Bridge URL', hint: 'http://192.168.1.4:8787'),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    key: const Key('bridge-token'),
                    controller: _token,
                    obscureText: true,
                    enableSuggestions: false,
                    autocorrect: false,
                    decoration: codexFieldDecoration('连接 Token', hint: '留空保持当前令牌'),
                  ),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  SelectableText(
                    _error!,
                    key: const Key('connection-error'),
                    style: const TextStyle(fontSize: 12, height: 1.45, color: Color(0xff8b2b20)),
                  ),
                ],
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: FilledButton.icon(
                    key: const Key('save-connection'),
                    onPressed: _saving ? null : _connect,
                    icon: const Icon(Icons.link, size: 17),
                    label: Text(_saving ? '连接中…' : (_mode == 'remote' ? '连接远程' : '重新连接本机')),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      CodexSection(
        title: '状态',
        children: [
          CodexSettingTile(
            icon: Icons.monitor_heart_outlined,
            title: widget.state.connected ? '连接正常' : '尚未连接',
            subtitle:
                '模式 ${_mode == 'remote' ? '远程' : '本机'} · 引擎 ${widget.state.health['engine'] ?? '-'} · 会话 ${widget.state.threads.length}',
            trailing: CodexStatusBadge(label: widget.state.connected ? '在线' : '离线', positive: widget.state.connected),
          ),
        ],
      ),
    ],
  );
}

class CodexAccountSettingsPage extends StatelessWidget {
  const CodexAccountSettingsPage({super.key, required this.state, required this.startingLogin, required this.onLogin});
  final CodexPocketState state;
  final bool startingLogin;
  final Future<void> Function() onLogin;

  @override
  Widget build(BuildContext context) => CodexSubpage(
    title: 'ChatGPT 账号',
    children: [
      CodexSection(
        title: '官方登录',
        description: '使用 ChatGPT 账号时，模型和额度与官方 Codex 一致，不需要配置中转地址或 API Key。',
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.account_circle_outlined, size: 30),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        state.account['account']?.toString() ?? '尚未登录',
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                FilledButton.icon(
                  onPressed: startingLogin ? null : onLogin,
                  icon: const Icon(Icons.login, size: 18),
                  label: Text(startingLogin ? '等待浏览器完成…' : '用 ChatGPT 账号登录'),
                ),
              ],
            ),
          ),
        ],
      ),
      const Text(
        '授权页在系统浏览器中打开，也可复制到电脑完成。若手机浏览器网络失败，把最终 127.0.0.1:1455 回调地址粘回登录向导即可；Codex Pocket 不保存你的账号密码。',
        style: TextStyle(fontSize: 11.5, height: 1.55, color: Color(0xff85877d)),
      ),
    ],
  );
}

class CodexAppearanceSettingsPage extends StatelessWidget {
  const CodexAppearanceSettingsPage({
    super.key,
    required this.selected,
    required this.onChanged,
    this.backgroundImage,
    this.onBackgroundImage,
  });
  final CodexTheme selected;
  final ValueChanged<CodexTheme> onChanged;

  /// 自定义桌面背景图（本机绝对路径）；null 表示不使用图片。
  final String? backgroundImage;
  final ValueChanged<String?>? onBackgroundImage;

  @override
  Widget build(BuildContext context) {
    var current = selected;
    var background = selected.id == 'custom' ? selected.background : kCodexThemes.first.background;
    var accent = selected.id == 'custom' ? selected.accent : kCodexThemes.first.accent;
    String? image = backgroundImage;
    Future<void> pickImage(BuildContext context, VoidCallback refresh) async {
      try {
        final path = await const MethodChannel('codex/runtime').invokeMethod<String>('pickImage');
        if (path == null || path.isEmpty) return;
        image = path;
        onBackgroundImage?.call(path);
        refresh();
      } catch (error) {
        if (context.mounted) showCodexMessage(context, '选择图片失败：$error');
      }
    }

    return StatefulBuilder(
      builder: (context, setLocal) => CodexSubpage(
        title: '外观',
        children: [
          CodexSection(
            title: '配色',
            description: '主题保存在本机，重启后保留。终端始终使用适合读输出的深色主题。',
            children: [
              Padding(
                padding: const EdgeInsets.all(12),
                child: GridView.count(
                  crossAxisCount: 2,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  mainAxisSpacing: 10,
                  crossAxisSpacing: 10,
                  childAspectRatio: 1.8,
                  children: [
                    for (final theme in kCodexThemes)
                      InkWell(
                        onTap: () {
                          setLocal(() => current = theme);
                          onChanged(theme);
                        },
                        borderRadius: BorderRadius.circular(12),
                        child: Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: theme.background,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: current.id == theme.id ? theme.accent : theme.border, width: 2),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Icon(Icons.circle, color: theme.accent, size: 18),
                              const Spacer(),
                              Text(
                                theme.name,
                                style: TextStyle(color: theme.ink, fontWeight: FontWeight.w600),
                              ),
                              if (current.id == theme.id)
                                Text('使用中', style: TextStyle(color: theme.muted, fontSize: 10)),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          CodexSection(
            title: '桌面背景图',
            description: '从相册选一张图当对话背景，会复制进应用私有目录；文字可读性由半透明遮罩保证。',
            children: [
              Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (image != null)
                      ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: Image.file(
                          File(image!),
                          key: const Key('theme-background-preview'),
                          height: 120,
                          width: double.infinity,
                          fit: BoxFit.cover,
                          errorBuilder: (_, _, _) => const SizedBox(
                            height: 60,
                            child: Center(child: Text('图片无法读取，请重新选择', style: TextStyle(fontSize: 12))),
                          ),
                        ),
                      ),
                    if (image != null) const SizedBox(height: 12),
                    Wrap(
                      spacing: 10,
                      children: [
                        FilledButton.icon(
                          key: const Key('theme-pick-image'),
                          onPressed: () => pickImage(context, () => setLocal(() {})),
                          icon: const Icon(Icons.image_outlined, size: 18),
                          label: Text(image == null ? '选择背景图片' : '更换背景图片'),
                        ),
                        if (image != null)
                          OutlinedButton.icon(
                            key: const Key('theme-clear-image'),
                            onPressed: () {
                              image = null;
                              onBackgroundImage?.call(null);
                              setLocal(() {});
                            },
                            icon: const Icon(Icons.close, size: 18),
                            label: const Text('移除背景图'),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          CodexSection(
            title: '自定义配色',
            description: '分别选择页面背景与强调色。卡片、边框和文字会自动保持可读对比度，并保存在本机。',
            children: [
              Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('背景色', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 10,
                      runSpacing: 10,
                      children: [
                        for (final color in const [
                          Color(0xfff8f8f4),
                          Color(0xfff2f5f8),
                          Color(0xfff6f1e7),
                          Color(0xfff4eef7),
                          Color(0xffe8f0ea),
                          Color(0xff14161a),
                          Color(0xff171b25),
                          Color(0xff211a24),
                        ])
                          _customColorButton(
                            key: Key('custom-background-${color.toARGB32().toRadixString(16)}'),
                            color: color,
                            selected: current.id == 'custom' && current.background.toARGB32() == color.toARGB32(),
                            onTap: () {
                              background = color;
                              current = CodexTheme.customized(background: background, accent: accent);
                              setLocal(() {});
                              onChanged(current);
                            },
                          ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    const Text('强调色', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 10,
                      runSpacing: 10,
                      children: [
                        for (final color in const [
                          Color(0xff2f5d3a),
                          Color(0xff2f4f6f),
                          Color(0xff6b4f2a),
                          Color(0xff7952a3),
                          Color(0xffb05c48),
                          Color(0xff187c80),
                          Color(0xff7fb98a),
                          Color(0xffd0a24c),
                        ])
                          _customColorButton(
                            key: Key('custom-accent-${color.toARGB32().toRadixString(16)}'),
                            color: color,
                            selected: current.id == 'custom' && current.accent.toARGB32() == color.toARGB32(),
                            onTap: () {
                              accent = color;
                              current = CodexTheme.customized(background: background, accent: accent);
                              setLocal(() {});
                              onChanged(current);
                            },
                          ),
                      ],
                    ),
                    if (current.id == 'custom') ...[
                      const SizedBox(height: 16),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: current.surface,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: current.border),
                        ),
                        child: Text('自定义预览 · 背景与强调色已生效', style: TextStyle(color: current.accent, fontSize: 12)),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

Widget _customColorButton({
  required Key key,
  required Color color,
  required bool selected,
  required VoidCallback onTap,
}) => InkWell(
  key: key,
  onTap: onTap,
  borderRadius: BorderRadius.circular(24),
  child: Container(
    width: 38,
    height: 38,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      border: Border.all(color: selected ? const Color(0xff22231f) : const Color(0xffc9cbc4), width: selected ? 3 : 1),
    ),
    child: selected
        ? Icon(Icons.check, size: 17, color: color.computeLuminance() > 0.4 ? Colors.black : Colors.white)
        : null,
  ),
);

class CodexRuntimeSettingsPage extends StatefulWidget {
  const CodexRuntimeSettingsPage({
    super.key,
    required this.status,
    required this.state,
    required this.onAction,
    required this.onShowLogs,
  });
  final Map<String, dynamic> status;
  final CodexPocketState state;
  final Future<Map<String, dynamic>> Function(String action) onAction;
  final Future<void> Function() onShowLogs;

  @override
  State<CodexRuntimeSettingsPage> createState() => _CodexRuntimeSettingsPageState();
}

class _CodexRuntimeSettingsPageState extends State<CodexRuntimeSettingsPage> {
  late Map<String, dynamic> _status = widget.status;

  Future<void> _run(String action) async {
    final next = await widget.onAction(action);
    if (mounted) setState(() => _status = next);
  }

  /// 重置运行时：只清引擎（rootfs + 版本标记），会话与工作区在 rootfs 外，一条都不会丢。
  /// 旧版本残留的「A different runtime is installed」就是靠这个清理。
  Future<void> _confirmReset() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重置运行时？'),
        content: const Text('会先停止引擎，再删除本机的 Codex 引擎（rootfs）并重新安装。\n\n会话记录、渠道密钥和工作区文件都在 rootfs 之外，不会被删除。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            key: const Key('confirm-reset-runtime'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('重置'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    // 引擎在跑就停掉（reset 要求没有活动进程），再清引擎。
    final phase = _status['phase']?.toString();
    if (phase == 'running' || phase == 'starting') {
      await _run('stop');
      if (!mounted) return;
    }
    await _run('reset');
    // reset 是一次异步服务动作：立刻回读的状态还是「已安装」，页面就会停在「启动」这种错状态
    // （真机实测：重置完显示启动，点了才报 Install the Codex runtime first）。这里轮询到清空为止。
    for (var i = 0; i < 15; i++) {
      await Future<void>.delayed(const Duration(seconds: 1));
      if (!mounted) return;
      await _run('status');
      if (_status['installed'] != true && _status['phase'] != 'resetting') break;
    }
    if (!mounted) return;
    showCodexMessage(context, _status['error'] != null ? '重置失败：${_status['error']}' : '运行时已重置，点「安装运行时」即可重装');
  }

  @override
  Widget build(BuildContext context) {
    final status = _status;
    final phase = status['phase']?.toString() ?? 'unknown';
    final running = phase == 'running';
    final installed =
        status['installed'] == true || const {'installed', 'starting', 'running', 'stopping'}.contains(phase);
    return CodexSubpage(
      title: 'Codex 运行时',
      children: [
        CodexSection(
          title: '本机引擎',
          description: '官方 codex app-server 在 PRoot / Ubuntu 中运行。界面只显示运行时实际返回的状态。',
          children: [
            CodexSettingTile(
              icon: Icons.developer_board_outlined,
              title: CodexSettingsHome._runtimeLabel(status),
              subtitle: status['engine']?.toString() ?? 'codex-app-server',
              trailing: CodexStatusBadge(label: running ? '运行中' : '未运行', positive: running),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (!installed)
                    FilledButton.icon(
                      onPressed: phase == 'installing' ? null : () => _run('install'),
                      icon: const Icon(Icons.download_outlined, size: 17),
                      label: Text(phase == 'installing' ? '安装中…' : '安装运行时'),
                    ),
                  if (installed && !running)
                    FilledButton.icon(
                      onPressed: phase == 'starting' ? null : () => _run('start'),
                      icon: const Icon(Icons.play_arrow, size: 18),
                      label: const Text('启动'),
                    ),
                  if (running)
                    OutlinedButton.icon(
                      onPressed: () => _run('stop'),
                      icon: const Icon(Icons.stop, size: 18),
                      label: const Text('停止'),
                    ),
                  OutlinedButton.icon(
                    onPressed: widget.onShowLogs,
                    icon: const Icon(Icons.receipt_long_outlined, size: 17),
                    label: const Text('运行日志'),
                  ),
                  OutlinedButton.icon(
                    key: const Key('reset-runtime'),
                    onPressed: phase == 'resetting' ? null : _confirmReset,
                    icon: const Icon(Icons.restart_alt, size: 18),
                    label: const Text('重置运行时（保留会话）'),
                  ),
                ],
              ),
            ),
          ],
        ),
        if (status['error'] != null)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: const Color(0xffffebe7), borderRadius: BorderRadius.circular(12)),
            child: SelectableText(status['error'].toString(), style: const TextStyle(color: Color(0xff8b2b20))),
          ),
        const SizedBox(height: 16),
        CodexSettingTile(
          icon: Icons.refresh,
          title: '重新检查连接',
          subtitle: widget.state.client.baseUrl,
          onTap: widget.state.connect,
        ),
      ],
    );
  }
}

class CodexAboutSettingsPage extends StatelessWidget {
  const CodexAboutSettingsPage({
    super.key,
    required this.state,
    required this.onCheckUpdate,
    required this.onCopyFeedback,
  });
  final CodexPocketState state;
  final Future<void> Function() onCheckUpdate;
  final Future<void> Function() onCopyFeedback;

  @override
  Widget build(BuildContext context) => CodexSubpage(
    title: '更新与关于',
    children: [
      CodexSection(
        title: '应用',
        children: [
          const CodexSettingTile(
            icon: Icons.terminal,
            title: kBrandName,
            subtitle: '独立移动客户端 · 官方 Codex app-server',
            trailing: Text(kAppVersion),
          ),
          CodexSettingTile(
            icon: Icons.system_update_alt,
            title: '检查更新',
            subtitle: kUpdateManifestUrl.isEmpty ? '未配置更新源' : '从发布清单检查新版本',
            onTap: onCheckUpdate,
          ),
          CodexSettingTile(
            icon: Icons.forum_outlined,
            title: '问题反馈',
            subtitle: '复制反馈 QQ，附带版本与错误信息',
            onTap: onCopyFeedback,
          ),
        ],
      ),
      const Text(
        'Codex Pocket 使用官方 Codex 引擎。OpenAI、ChatGPT 与 Codex 的名称和商标归各自所有者所有。',
        style: TextStyle(fontSize: 11.5, height: 1.55, color: Color(0xff85877d)),
      ),
      const SizedBox(height: 20),
      const CodexSection(
        title: '使用手册',
        description: '五件事覆盖日常使用；更细的说明见仓库 docs/guide。',
        children: [
          CodexManualEntry(
            icon: Icons.chat_bubble_outline,
            title: '对话',
            body: '主页就是上次的会话，直接在底部输入任务；左上角汉堡是设置与工具，旁边的历史按钮才是会话列表（可按标题/目录/会话 ID 搜索）。',
          ),
          CodexManualEntry(
            icon: Icons.data_usage,
            title: '上下文',
            body: '顶部环形显示已用上下文百分比。超过设定阈值后 bridge 会在没有进行中的 turn 时自动压缩，也可以手动「立即压缩」。',
          ),
          CodexManualEntry(
            icon: Icons.widgets_outlined,
            title: '能力',
            body: '抽屉里的「能力」管理工具、技能、MCP、工作流与工具包；点工具会把当前会话切过去执行。',
          ),
          CodexManualEntry(
            icon: Icons.terminal,
            title: '终端',
            body: '抽屉里的「终端」是 PRoot 里的真 /bin/bash，可以直接跑 codex CLI 或调试脚本。',
          ),
          CodexManualEntry(
            icon: Icons.badge_outlined,
            title: '人设与插件',
            body: '人设写进 AGENTS.md 的托管区块；插件按目录安装，附带工具包与技能，可在设置里开关。',
          ),
        ],
      ),
    ],
  );
}

class CodexManualEntry extends StatelessWidget {
  const CodexManualEntry({super.key, required this.icon, required this.title, required this.body});
  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) => ListTile(
    dense: true,
    leading: Icon(icon, size: 20, color: const Color(0xff4c5145)),
    title: Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
    subtitle: Text(body, style: const TextStyle(fontSize: 11.5, height: 1.5)),
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
  );
}

String _reasoningLabel(String value) => switch (value) {
  'low' => '低',
  'high' => '高',
  'xhigh' => '极高',
  _ => '中',
};

String _approvalLabel(String value) => switch (value) {
  'never' => '不主动询问',
  _ => '按需审批',
};

/// 上下文压缩设置：阈值、保留轮数、自动压缩与手动压缩。
class CodexContextSettingsPage extends StatefulWidget {
  const CodexContextSettingsPage({super.key, required this.state});
  final CodexPocketState state;

  @override
  State<CodexContextSettingsPage> createState() => _CodexContextSettingsPageState();
}

class _CodexContextSettingsPageState extends State<CodexContextSettingsPage> {
  CodexPocketState get state => widget.state;
  bool _loading = true;
  bool _saving = false;
  String? _error;

  late bool _enabled = state.contextEnabled;
  late bool _autoCompact = state.contextAutoCompact;
  late int _threshold = state.contextThresholdPercent;
  late int _keepTurns = state.contextKeepRecentTurns;

  /// 上下文窗口大小由用户自己填（上游通常不报）；0 表示按 128k 估算。
  late final TextEditingController _window = TextEditingController(
    text: state.contextWindowOverride > 0 ? '${state.contextWindowOverride}' : '',
  );

  @override
  void initState() {
    super.initState();
    state.addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    state.removeListener(_changed);
    _window.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await state.loadContext();
      if (!mounted) return;
      setState(() {
        _enabled = state.contextEnabled;
        _autoCompact = state.contextAutoCompact;
        _threshold = state.contextThresholdPercent;
        _keepTurns = state.contextKeepRecentTurns;
        // 以桥里的值为准回填输入框：本地缓存可能落后（换机/清数据/别处改过）。
        final saved = state.contextWindowOverride > 0 ? '${state.contextWindowOverride}' : '';
        if (_window.text.trim() != saved) _window.text = saved;
      });
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await state.saveContextConfig({
        'enabled': _enabled,
        'thresholdPercent': _threshold,
        'keepRecentTurns': _keepTurns,
        'autoCompact': _autoCompact,
      });
      if (mounted) showCodexMessage(context, '上下文设置已保存');
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _windowLabel(int tokens) => tokens >= 1000000
      ? '${(tokens / 1000000).toStringAsFixed(0)}M'
      : tokens >= 1000
      ? '${(tokens / 1000).toStringAsFixed(0)}k'
      : '$tokens';

  /// 窗口大小写进桥（不是只写本地）：百分比与自动压缩阈值都在桥里算，
  /// 只写本地就会出现「填了值但环形百分比不变」。
  Future<void> _saveWindow() async {
    final raw = _window.text.trim().replaceAll(',', '');
    final tokens = raw.isEmpty ? 0 : int.tryParse(raw);
    if (tokens == null || tokens < 0 || (tokens > 0 && tokens < 1000)) {
      setState(() => _error = '窗口大小请填 tokens 数（至少 1000），或留空按上游/默认 128k 估算');
      return;
    }
    try {
      await state.saveContextWindow(tokens);
      if (!mounted) return;
      setState(() => _error = null);
      showCodexMessage(context, tokens == 0 ? '已改为按上游上报值（没上报就按 128k）估算' : '窗口大小已保存：$tokens tokens，环形百分比与自动压缩立即按它算');
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    }
  }

  /// 当前百分比实际用的窗口：让用户知道「我填的值生效了没有、没生效是在用谁的」。
  String get _windowSourceLabel {
    final window = (state.contextUsage['contextWindow'] as num?)?.round();
    final source = state.contextWindowSource;
    if (window == null || window <= 0) {
      return state.contextWindowOverride > 0
          ? '当前按你填的 ${_windowLabel(state.contextWindowOverride)} 计算（还没有用量数据）'
          : '当前还没拿到用量数据；留空时按上游上报值，没上报就按 128k 估算';
    }
    return switch (source) {
      'user' => '当前按你填的 ${_windowLabel(window)} 计算',
      'upstream' => '当前按上游上报的 ${_windowLabel(window)} 计算（想固定就填一个值保存）',
      _ => '当前按 ${_windowLabel(window)} 计算',
    };
  }

  Future<void> _compact() async {
    try {
      await state.compactThread();
      if (mounted) showCodexMessage(context, state.contextNotice ?? '已请求压缩');
    } catch (error) {
      if (mounted) showCodexMessage(context, _errorText(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    final percent = state.contextPercent;
    final usage = state.contextUsage;
    final total = usage['totalTokens'];
    final window = usage['contextWindow'];
    return CodexSubpage(
      title: '上下文与压缩',
      actions: [
        IconButton(
          key: const Key('reload-context'),
          tooltip: '重新读取上下文设置',
          onPressed: _loading ? null : _load,
          icon: const Icon(Icons.refresh),
        ),
      ],
      children: [
        if (_loading)
          const LinearProgressIndicator(minHeight: 2)
        else if (_error != null)
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: const Color(0xffffe8e4), borderRadius: BorderRadius.circular(10)),
            child: SelectableText(_error!, style: const TextStyle(fontSize: 12, color: Color(0xff8b2b20))),
          ),
        CodexSection(
          title: '上下文窗口大小',
          description: '上游一般不告诉 App 你的模型能吃多少上下文，所以这里由你填；环形百分比按这个值计算。',
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextField(
                    key: const Key('context-window-field'),
                    controller: _window,
                    keyboardType: TextInputType.number,
                    decoration: codexFieldDecoration('上下文窗口（tokens）', hint: '例如 128000 / 200000 / 1000000；留空=按128k估算'),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final preset in const [32000, 64000, 128000, 200000, 1000000])
                        ActionChip(
                          key: Key('context-window-preset-$preset'),
                          label: Text(_windowLabel(preset)),
                          onPressed: () => setState(() => _window.text = '$preset'),
                        ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton.icon(
                      key: const Key('save-context-window'),
                      onPressed: _saving ? null : _saveWindow,
                      icon: const Icon(Icons.save_outlined, size: 17),
                      label: const Text('保存窗口大小'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _windowSourceLabel,
                    key: const Key('context-window-source'),
                    style: const TextStyle(fontSize: 11.5, height: 1.5, color: Color(0xff85877d)),
                  ),
                ],
              ),
            ),
          ],
        ),
        CodexSection(
          title: '当前用量',
          description: '来自 bridge 的 thread/tokenUsage/updated；环形跟这里同一个数值。',
          children: [
            CodexSettingTile(
              icon: Icons.data_usage,
              title: percent == null ? '上下文用量未知' : '已用 ${percent.round()}%',
              subtitle: total == null ? '还没有收到用量事件' : '$total tokens${window == null ? '' : ' / $window'}',
              trailing: CodexStatusBadge(
                label: percent == null ? '未知' : '${percent.round()}%',
                warning: (percent ?? 0) >= _threshold,
              ),
            ),
            if (state.contextNotice != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
                child: Text(state.contextNotice!, style: const TextStyle(fontSize: 11.5, color: Color(0xff6d6f65))),
              ),
          ],
        ),
        CodexSection(
          title: '压缩策略',
          description: '阈值区间 10–95%。达到阈值且该会话没有进行中的 turn 时，bridge 会自己压缩一次。',
          children: [
            SwitchListTile(
              key: const Key('context-enabled'),
              value: _enabled,
              title: const Text('启用上下文压缩', style: TextStyle(fontSize: 13.5)),
              subtitle: const Text('关闭后 bridge 不会自动压缩', style: TextStyle(fontSize: 11.5)),
              onChanged: (value) => setState(() => _enabled = value),
            ),
            SwitchListTile(
              key: const Key('context-auto-compact'),
              value: _autoCompact,
              title: const Text('达到阈值自动压缩', style: TextStyle(fontSize: 13.5)),
              subtitle: const Text('同一会话 60 秒内只触发一次', style: TextStyle(fontSize: 11.5)),
              onChanged: (value) => setState(() => _autoCompact = value),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '压缩阈值 · $_threshold%',
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                  ),
                  IconButton(
                    key: const Key('context-threshold-decrease'),
                    tooltip: '降低阈值',
                    onPressed: _threshold <= 10 ? null : () => setState(() => _threshold -= 1),
                    icon: const Icon(Icons.remove_circle_outline, size: 20),
                  ),
                  IconButton(
                    key: const Key('context-threshold-increase'),
                    tooltip: '提高阈值',
                    onPressed: _threshold >= 95 ? null : () => setState(() => _threshold += 1),
                    icon: const Icon(Icons.add_circle_outline, size: 20),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              child: Slider(
                key: const Key('context-threshold'),
                value: _threshold.toDouble(),
                min: 10,
                max: 95,
                divisions: 85,
                label: '$_threshold%',
                onChanged: (value) => setState(() => _threshold = value.round()),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '保留最近轮数 · $_keepTurns',
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                  ),
                  IconButton(
                    key: const Key('context-keep-turns-decrease'),
                    tooltip: '减少保留轮数',
                    onPressed: _keepTurns <= 0 ? null : () => setState(() => _keepTurns -= 1),
                    icon: const Icon(Icons.remove_circle_outline, size: 20),
                  ),
                  IconButton(
                    key: const Key('context-keep-turns-increase'),
                    tooltip: '增加保留轮数',
                    onPressed: _keepTurns >= 50 ? null : () => setState(() => _keepTurns += 1),
                    icon: const Icon(Icons.add_circle_outline, size: 20),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
              child: Align(
                alignment: Alignment.centerRight,
                child: FilledButton.icon(
                  key: const Key('save-context-config'),
                  onPressed: _saving || _loading ? null : _save,
                  icon: const Icon(Icons.save_outlined, size: 17),
                  label: Text(_saving ? '保存中…' : '保存设置'),
                ),
              ),
            ),
          ],
        ),
        CodexSection(
          title: '手动压缩',
          description: '立刻对当前会话调用 thread/compact/start，不等阈值。',
          children: [
            CodexSettingTile(
              icon: Icons.compress,
              title: state.busy ? '当前 turn 还在跑' : '立即压缩当前会话',
              subtitle: state.threadId == null ? '还没有活动会话' : '会话 ${state.threadId}',
              onTap: state.threadId == null || state.compacting || state.busy ? null : _compact,
              trailing: state.compacting
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : null,
            ),
          ],
        ),
      ],
    );
  }
}

/// 人设：名称/风格/指令写进 AGENTS.md 的托管区块，其余手写内容不动。
class CodexPersonaSettingsPage extends StatefulWidget {
  const CodexPersonaSettingsPage({super.key, required this.state});
  final CodexPocketState state;

  @override
  State<CodexPersonaSettingsPage> createState() => _CodexPersonaSettingsPageState();
}

class _CodexPersonaSettingsPageState extends State<CodexPersonaSettingsPage> {
  CodexPocketState get state => widget.state;
  final _name = TextEditingController();
  final _style = TextEditingController();
  final _instructions = TextEditingController();
  bool _active = true;
  bool _loading = true;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _name.dispose();
    _style.dispose();
    _instructions.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await state.loadPersona();
      if (!mounted) return;
      setState(() {
        _name.text = state.personaName;
        _style.text = state.personaStyle;
        _instructions.text = state.personaInstructions;
        _active = state.personaActive;
      });
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await state.savePersona(
        name: _name.text.trim(),
        style: _style.text.trim(),
        instructions: _instructions.text.trim(),
        active: _active,
      );
      if (mounted) showCodexMessage(context, '人设已保存，新建会话时通过高优先级指令生效');
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => CodexSubpage(
    title: '人设',
    actions: [
      IconButton(
        key: const Key('reload-persona'),
        tooltip: '重新读取人设',
        onPressed: _loading ? null : _load,
        icon: const Icon(Icons.refresh),
      ),
    ],
    children: [
      if (_loading) const LinearProgressIndicator(minHeight: 2),
      if (_error != null)
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: const Color(0xffffe8e4), borderRadius: BorderRadius.circular(10)),
          child: SelectableText(_error!, style: const TextStyle(fontSize: 12, color: Color(0xff8b2b20))),
        ),
      CodexSection(
        title: '人设内容',
        description: '保存后同时写入 AGENTS.md 与 Codex 高优先级 developerInstructions；文件其他部分保持不变。',
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              children: [
                TextField(
                  key: const Key('persona-name'),
                  controller: _name,
                  decoration: codexFieldDecoration('名称', hint: '例如：严谨的代码审查者'),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('persona-style'),
                  controller: _style,
                  decoration: codexFieldDecoration('风格', hint: '例如：先给结论，再给证据'),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const Key('persona-instructions'),
                  controller: _instructions,
                  minLines: 5,
                  maxLines: 12,
                  style: const TextStyle(fontSize: 12.5, height: 1.5),
                  decoration: codexFieldDecoration('指令', hint: '长期有效的具体指示，留空表示清除这一段'),
                ),
                const SizedBox(height: 4),
                SwitchListTile(
                  key: const Key('persona-active'),
                  contentPadding: EdgeInsets.zero,
                  value: _active,
                  title: const Text('启用', style: TextStyle(fontSize: 13.5)),
                  subtitle: const Text('关闭后移除托管区块，但保留本机人设文件', style: TextStyle(fontSize: 11.5)),
                  onChanged: (value) => setState(() => _active = value),
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerRight,
                  child: FilledButton.icon(
                    key: const Key('save-persona'),
                    onPressed: _saving || _loading ? null : _save,
                    icon: const Icon(Icons.save_outlined, size: 17),
                    label: Text(_saving ? '保存中…' : '保存人设'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      CodexSection(
        title: '新会话的系统提示',
        description: '内置 Agent 行为规范始终保留，人设追加到其后。Codex 0.170 会固定已有会话的初始指令，修改后请新建会话。',
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: const Color(0xfff6f6f1),
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: const Color(0xffe4e4de)),
              ),
              child: SelectableText(
                state.personaEffectiveInstructions.isEmpty ? '读取后显示实际注入内容' : state.personaEffectiveInstructions,
                key: const Key('persona-effective-instructions'),
                style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 11.5, height: 1.5),
              ),
            ),
          ),
        ],
      ),
      CodexSection(
        title: 'AGENTS.md 托管区块预览',
        description: state.personaPath.isEmpty ? '保存后显示会写入的区块' : '文件：${state.personaPath}',
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: const Color(0xfff6f6f1),
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: const Color(0xffe4e4de)),
              ),
              child: SelectableText(
                state.personaManagedBlock(
                  name: _name.text,
                  style: _style.text,
                  instructions: _instructions.text,
                  active: _active,
                ),
                key: const Key('persona-preview'),
                style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 11.5, height: 1.5),
              ),
            ),
          ),
        ],
      ),
    ],
  );
}

/// 插件：目录 = 含 plugin.json 的目录，可带 toolpacks/ 与 skills/。
class CodexPluginsSettingsPage extends StatefulWidget {
  const CodexPluginsSettingsPage({super.key, required this.state});
  final CodexPocketState state;

  @override
  State<CodexPluginsSettingsPage> createState() => _CodexPluginsSettingsPageState();
}

class _CodexPluginsSettingsPageState extends State<CodexPluginsSettingsPage> {
  CodexPocketState get state => widget.state;
  final _path = TextEditingController();
  bool _loading = true;
  bool _installing = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _path.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await state.loadPlugins();
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _install() async {
    setState(() {
      _installing = true;
      _error = null;
    });
    try {
      final name = await state.installPlugin(_path.text);
      if (!mounted) return;
      _path.clear();
      showCodexMessage(context, '已安装插件 $name');
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    } finally {
      if (mounted) setState(() => _installing = false);
    }
  }

  Future<void> _toggle(Map<String, dynamic> plugin, bool enabled) async {
    try {
      await state.togglePlugin(plugin['name'].toString(), enabled);
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    }
  }

  Future<void> _remove(Map<String, dynamic> plugin) async {
    try {
      await state.removePlugin(plugin['name'].toString());
    } catch (error) {
      if (mounted) setState(() => _error = _errorText(error));
    }
  }

  @override
  Widget build(BuildContext context) => CodexSubpage(
    title: '插件',
    actions: [
      IconButton(
        key: const Key('reload-plugins'),
        tooltip: '重新读取插件',
        onPressed: _loading ? null : _load,
        icon: const Icon(Icons.refresh),
      ),
    ],
    children: [
      if (_loading) const LinearProgressIndicator(minHeight: 2),
      if (_error != null)
        Container(
          margin: const EdgeInsets.only(bottom: 16),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: const Color(0xffffe8e4), borderRadius: BorderRadius.circular(10)),
          child: SelectableText(_error!, style: const TextStyle(fontSize: 12, height: 1.5, color: Color(0xff8b2b20))),
        ),
      CodexSection(
        title: '已安装插件',
        description: '内置插件随 APK 只读；用户插件放在 CODEX_HOME/plugins。禁用后其工具包与技能不再加载。',
        children: [
          if (state.plugins.isEmpty && !_loading)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16, vertical: 20),
              child: Text('还没有插件', style: TextStyle(fontSize: 12, color: Color(0xff85867e))),
            ),
          for (final plugin in state.plugins) _pluginTile(plugin),
        ],
      ),
      CodexSection(
        title: '按路径安装',
        description: '填一个含 plugin.json 的目录，bridge 会复制进用户插件目录；重名会覆盖。',
        children: [
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              children: [
                TextField(
                  key: const Key('plugin-install-path'),
                  controller: _path,
                  decoration: codexFieldDecoration('插件目录', hint: '/root/workspace/plugins/my-plugin'),
                ),
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: FilledButton.icon(
                    key: const Key('plugin-install'),
                    onPressed: _installing ? null : _install,
                    icon: const Icon(Icons.add_to_photos_outlined, size: 17),
                    label: Text(_installing ? '安装中…' : '安装插件'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    ],
  );

  Widget _pluginTile(Map<String, dynamic> plugin) {
    final name = plugin['name'].toString();
    final builtin = plugin['builtin'] == true;
    final enabled = plugin['enabled'] != false;
    final toolpacks = (plugin['toolpacks'] as List?)?.length ?? 0;
    final skills = (plugin['skills'] as List?)?.length ?? 0;
    final version = plugin['version']?.toString();
    return ListTile(
      key: Key('plugin-$name'),
      leading: Icon(builtin ? Icons.inventory_2_outlined : Icons.extension_outlined, size: 21),
      title: Text(
        (plugin['title'] ?? name).toString(),
        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        [
          if (version != null && version.isNotEmpty) 'v$version',
          '$toolpacks 个工具包 · $skills 个技能',
          builtin ? '内置' : '用户插件',
          if ((plugin['error'] ?? '').toString().isNotEmpty) '错误：${plugin['error']}',
        ].join(' · '),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 11.5),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Switch(key: Key('plugin-switch-$name'), value: enabled, onChanged: (value) => _toggle(plugin, value)),
          if (!builtin)
            IconButton(
              key: Key('plugin-remove-$name'),
              tooltip: '卸载插件',
              onPressed: () => _remove(plugin),
              icon: const Icon(Icons.delete_outline, size: 19),
            ),
        ],
      ),
    );
  }
}

String _errorText(Object error) {
  if (error is CodexBridgeException) {
    final hint = error.details['hint']?.toString();
    if (hint != null && hint.isNotEmpty && hint != error.message) return '${error.message}\n$hint';
    return error.message;
  }
  return error.toString().replaceFirst('Exception: ', '');
}
