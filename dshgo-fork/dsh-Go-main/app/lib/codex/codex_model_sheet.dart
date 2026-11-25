import 'package:flutter/material.dart';

import 'codex_pocket_state.dart';
import 'codex_theme.dart';

/// 模型池抽屉：完全由 `/api/channels` 驱动。
///
/// 一个渠道 = 一个地址 + 一种协议（OpenAI Responses 直连 / 其余由本机兼容代理转换）+ 该渠道的模型。
/// 点渠道 = 激活并展开它的模型；点模型 = 把模型写回这个渠道。
/// 这里不碰 `/api/providers`，也不展示 codex `model/list` 的官方模型 ——
/// 自定义渠道不该被官方模型 ID 覆盖（真机上会直接把 chat 渠道顶回 responses 直连）。
Future<bool> showCodexModelSheet(
  BuildContext context, {
  required CodexPocketState state,
  required CodexTheme theme,
  required String reasoning,
  required Future<void> Function(String value) onReasoning,
  VoidCallback? onManageChannels,
}) async {
  var changed = false;
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: theme.surface,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
    builder: (_) => _ChannelModelSheet(
      state: state,
      theme: theme,
      reasoning: reasoning,
      onReasoning: onReasoning,
      onManageChannels: onManageChannels,
      onChanged: () => changed = true,
    ),
  );
  return changed;
}

class _ChannelModelSheet extends StatefulWidget {
  const _ChannelModelSheet({
    required this.state,
    required this.theme,
    required this.reasoning,
    required this.onReasoning,
    required this.onChanged,
    this.onManageChannels,
  });

  final CodexPocketState state;
  final CodexTheme theme;
  final String reasoning;
  final Future<void> Function(String value) onReasoning;
  final VoidCallback onChanged;
  final VoidCallback? onManageChannels;

  @override
  State<_ChannelModelSheet> createState() => _ChannelModelSheetState();
}

class _ChannelModelSheetState extends State<_ChannelModelSheet> {
  CodexPocketState get state => widget.state;

  late String _reasoning = widget.reasoning;
  bool _loading = true;
  String? _listError;
  String? _expandedId;
  String? _busyId;

  /// 每个渠道自己的错误（拉模型 / 保存模型），显示桥的原话，不伪造列表。
  final Map<String, String> _channelErrors = {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
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

  String _errorText(Object error) => error.toString().replaceFirst('Exception: ', '');

  bool _isBusyError(Object error) {
    final text = _errorText(error).toLowerCase();
    return text.contains('active turn') || text.contains('during an active');
  }

  Map<String, dynamic>? _channelById(String id) {
    for (final channel in state.channels) {
      if (channel['id']?.toString() == id) return channel;
    }
    return null;
  }

  List<String> _modelsOf(Map<String, dynamic> channel) =>
      ((channel['models'] as List?) ?? const []).map((entry) => entry.toString()).where((id) => id.isNotEmpty).toList();

  bool _isActive(Map<String, dynamic> channel) =>
      channel['active'] == true || channel['id']?.toString() == state.activeChannel?['id']?.toString();

  /// 对话页里的快速渠道切换：点一下即生效，不要求先展开模型列表。
  Future<void> _switchChannel(Map<String, dynamic> channel) async {
    final id = channel['id'].toString();
    if (_busyId != null) return;
    if (_isActive(channel)) {
      setState(() => _expandedId = _expandedId == id ? null : id);
      return;
    }
    setState(() {
      _busyId = id;
      _channelErrors.remove(id);
    });
    try {
      await _activateWithConfirm(id);
      widget.onChanged();
      if (mounted) setState(() => _expandedId = null);
    } catch (error) {
      if (mounted) setState(() => _channelErrors[id] = _errorText(error));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  /// 切渠道被“有活动回合”拦住时，给一次「停止并切换」的选择，而不是甩一句拒绝。
  Future<bool> _confirmStopAndSwitch(BuildContext context) async {
    final stop = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('有正在进行的回合'),
        content: const Text('切换渠道需要先结束当前回合。停止它并切换到新渠道吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(
            key: const Key('stop-and-switch-channel'),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('停止并切换'),
          ),
        ],
      ),
    );
    return stop == true;
  }

  /// 点渠道：先激活，再展开；`models` 为空时按 id 拉一次并写回渠道。
  Future<void> _toggleChannel(Map<String, dynamic> channel) async {
    final id = channel['id'].toString();
    if (_busyId != null) return;
    if (_expandedId == id) {
      setState(() => _expandedId = null);
      return;
    }
    setState(() {
      _busyId = id;
      _channelErrors.remove(id);
    });
    try {
      if (!_isActive(channel)) {
        // 桥在 activate 时重写 config.toml：之后新回合就走这个渠道。
        await _activateWithConfirm(id);
        widget.onChanged();
      }
      var current = _channelById(id) ?? channel;
      if (_modelsOf(current).isEmpty) {
        final failure = await _fetchModels(current);
        if (failure != null && mounted) setState(() => _channelErrors[id] = failure);
        current = _channelById(id) ?? current;
      }
      if (!mounted) return;
      setState(() => _expandedId = id);
    } catch (error) {
      if (mounted) setState(() => _channelErrors[id] = _errorText(error));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  /// 拉模型并写回渠道；返回失败原因（成功为 null）。
  Future<String?> _fetchModels(Map<String, dynamic> channel) async {
    try {
      await state.refreshChannelModels(channel);
      return null;
    } catch (error) {
      return _errorText(error);
    }
  }

  /// 选模型必须连同「渠道切换」一起做：只写渠道条目不会改变 codex 的 provider，
  /// 请求仍会打到上一个渠道（真机上表现为模型与渠道错位、报错来自旧渠道）。
  Future<void> _pickModel(Map<String, dynamic> channel, String model) async {
    final id = channel['id'].toString();
    if (_busyId != null) return;
    setState(() {
      _busyId = id;
      _channelErrors.remove(id);
    });
    try {
      if (!_isActive(channel)) {
        await _activateWithConfirm(id);
      }
      await state.patchChannel(channel, model: model);
      // 激活会把 provider + model 一起写进 codex 配置；这一步才真正换网关。
      await state.activateChannel(id);
      widget.onChanged();
    } catch (error) {
      if (mounted) setState(() => _channelErrors[id] = _errorText(error));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  /// 激活渠道；遇到「有活动回合」时问一次是否停止并切换。
  Future<void> _activateWithConfirm(String id) async {
    try {
      await state.activateChannel(id);
    } catch (error) {
      if (!mounted || !_isBusyError(error)) rethrow;
      setState(() => _busyId = null);
      if (!await _confirmStopAndSwitch(context) || !mounted) return;
      await state.interruptAll();
      await state.activateChannel(id);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = widget.theme;
    final active = state.activeChannel;
    final currentModel = active?['model']?.toString();
    final currentName = active?['name']?.toString() ?? active?['id']?.toString();
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.72,
      minChildSize: 0.45,
      maxChildSize: 0.95,
      builder: (context, scroll) => ListView(
        controller: scroll,
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 26),
        children: [
          Center(
            child: Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(color: theme.border, borderRadius: BorderRadius.circular(2)),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Text(
                '模型 · 渠道 · 推理强度',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: theme.ink),
              ),
              const Spacer(),
              TextButton(
                key: const Key('model-sheet-refresh'),
                onPressed: _loading || _busyId != null ? null : _load,
                child: const Text('刷新', style: TextStyle(fontSize: 12)),
              ),
            ],
          ),
          Text(
            currentModel == null || currentModel.isEmpty
                ? '还没有活动模型；点渠道切换，再点模型选中'
                : '当前：$currentModel${currentName == null ? '' : ' · $currentName'}',
            style: TextStyle(fontSize: 11.5, color: theme.muted),
          ),
          Text(
            '渠道来自 /api/channels：OpenAI Responses 直连，其余协议由本机兼容代理转换；模型只写回该渠道。',
            style: TextStyle(fontSize: 10.5, height: 1.4, color: theme.muted),
          ),
          const SizedBox(height: 12),
          if (_listError != null)
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: const Color(0xffffe8e4), borderRadius: BorderRadius.circular(9)),
              child: SelectableText(
                _listError!,
                key: const Key('model-sheet-error'),
                style: const TextStyle(fontSize: 12, height: 1.45, color: Color(0xff8b2b20)),
              ),
            ),
          if (_loading && state.channels.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
            ),
          if (!_loading && state.channels.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Text('还没有渠道，先新增一个', style: TextStyle(fontSize: 12, color: theme.muted)),
            ),
          if (state.channels.isNotEmpty) ...[
            Text(
              '快速切换渠道',
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: theme.muted),
            ),
            const SizedBox(height: 7),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final channel in state.channels)
                    Padding(
                      padding: const EdgeInsets.only(right: 7),
                      child: ChoiceChip(
                        key: Key('quick-channel-${channel['id']}'),
                        selected: _isActive(channel),
                        avatar: Icon(
                          _isActive(channel) ? Icons.check_circle : Icons.swap_horiz,
                          size: 15,
                          color: _isActive(channel) ? theme.accent : theme.muted,
                        ),
                        label: Text(channel['name']?.toString() ?? channel['id'].toString()),
                        onSelected: _busyId != null ? null : (_) => _switchChannel(channel),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
          ],
          for (final channel in state.channels) _channelGroup(channel),
          const SizedBox(height: 8),
          if (widget.onManageChannels != null)
            OutlinedButton.icon(
              key: const Key('model-sheet-add-channel'),
              onPressed: widget.onManageChannels,
              icon: const Icon(Icons.add, size: 17),
              label: const Text('新增渠道', style: TextStyle(fontSize: 12.5)),
            ),
          const SizedBox(height: 18),
          Divider(color: theme.border),
          const SizedBox(height: 10),
          Text(
            '推理强度',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: theme.muted),
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            children: [
              for (final level in const ['low', 'medium', 'high', 'xhigh'])
                ChoiceChip(
                  label: Text(switch (level) {
                    'low' => '低',
                    'high' => '高',
                    'xhigh' => '极高',
                    _ => '中',
                  }),
                  selected: _reasoning == level,
                  onSelected: (_) async {
                    setState(() => _reasoning = level);
                    await widget.onReasoning(level);
                    widget.onChanged();
                  },
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            '代理路径：/v1/<id>/responses → 上游按 wire 转换；Responses 渠道直连。'
            '切换渠道要求当前没有进行中的回合。',
            style: TextStyle(fontSize: 11, height: 1.5, color: theme.muted),
          ),
        ],
      ),
    );
  }

  Widget _channelGroup(Map<String, dynamic> channel) {
    final theme = widget.theme;
    final id = channel['id'].toString();
    final active = _isActive(channel);
    final expanded = _expandedId == id;
    final busy = _busyId == id;
    final models = _modelsOf(channel);
    final currentModel = channel['model']?.toString();
    final error = _channelErrors[id];
    final wire = channelWireOf(channel['wire']?.toString());
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        key: Key('sheet-channel-$id'),
        color: active ? theme.background : theme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(11),
          side: BorderSide(color: active ? theme.accent : theme.border),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              key: Key('sheet-channel-header-$id'),
              onTap: () => _toggleChannel(channel),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                child: Row(
                  children: [
                    Icon(
                      active ? Icons.radio_button_checked : Icons.radio_button_off,
                      size: 16,
                      color: active ? theme.accent : theme.muted,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Flexible(
                                child: Text(
                                  channel['name']?.toString() ?? id,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: theme.ink),
                                ),
                              ),
                              const SizedBox(width: 6),
                              _pill(
                                channelWireBadge(channel['wire']?.toString()),
                                wire?.proxied == false ? const Color(0xff3a5f8a) : const Color(0xff2f5d3a),
                              ),
                              if (active) ...[const SizedBox(width: 4), _pill('当前', theme.accent)],
                            ],
                          ),
                          const SizedBox(height: 2),
                          Text(
                            channel['baseUrl']?.toString() ?? '',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10.5, color: theme.muted),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 6),
                    if (busy)
                      const SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 2))
                    else
                      Icon(expanded ? Icons.expand_less : Icons.expand_more, size: 17, color: theme.muted),
                  ],
                ),
              ),
            ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(32, 0, 12, 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: SelectableText(
                        error,
                        key: Key('sheet-channel-error-$id'),
                        style: const TextStyle(fontSize: 11.5, height: 1.4, color: Color(0xff8b2b20)),
                      ),
                    ),
                    if (expanded)
                      TextButton(
                        key: Key('sheet-retry-models-$id'),
                        onPressed: busy
                            ? null
                            : () async {
                                final failure = await _fetchModels(channel);
                                if (!mounted) return;
                                setState(() {
                                  if (failure == null) {
                                    _channelErrors.remove(id);
                                  } else {
                                    _channelErrors[id] = failure;
                                  }
                                });
                              },
                        child: const Text('重试', style: TextStyle(fontSize: 11)),
                      ),
                  ],
                ),
              ),
            if (expanded) ...[
              if (models.isEmpty && error == null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(32, 0, 12, 10),
                  child: Text(
                    busy ? '正在拉取模型…' : '这个渠道还没有模型列表，点渠道标题重新拉取',
                    style: TextStyle(fontSize: 11.5, color: theme.muted),
                  ),
                ),
              for (final model in models)
                ListTile(
                  key: Key('sheet-model-$id-$model'),
                  dense: true,
                  contentPadding: const EdgeInsets.only(left: 36, right: 12),
                  title: Text(model, style: TextStyle(fontSize: 13, color: theme.ink)),
                  trailing: model == currentModel ? Icon(Icons.check, size: 16, color: theme.accent) : null,
                  onTap: () => _pickModel(channel, model),
                ),
              const SizedBox(height: 4),
            ],
          ],
        ),
      ),
    );
  }

  Widget _pill(String label, Color color) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(color: color.withValues(alpha: 0.10), borderRadius: BorderRadius.circular(20)),
    child: Text(
      label,
      style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w600, color: color),
    ),
  );
}
