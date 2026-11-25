import 'package:flutter/material.dart';

import 'codex_agents.dart';
import 'codex_theme.dart';

/// Independent task board, usable in a bottom sheet or as a full page body.
class CodexAgentsPanel extends StatefulWidget {
  const CodexAgentsPanel({super.key, required this.state, this.refresh, this.theme, this.onOpenConversation});
  final CodexAgentsState state;
  final Future<void> Function()? refresh;
  final CodexTheme? theme;
  final void Function(CodexAgent agent)? onOpenConversation;

  @override
  State<CodexAgentsPanel> createState() => _CodexAgentsPanelState();
}

class _CodexAgentsPanelState extends State<CodexAgentsPanel> {
  bool _loading = false;
  String? _error;
  CodexTheme get theme => widget.theme ?? kCodexThemes.first;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _refresh();
    });
  }

  Future<void> _refresh() async {
    if (_loading || widget.refresh == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.refresh!();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.state,
    builder: (context, _) {
      final agents = widget.state.agents;
      final active = agents.where((a) => a.active).length;
      return Material(
        color: theme.background,
        child: SafeArea(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 12, 8),
                child: Row(
                  children: [
                    Icon(Icons.account_tree_outlined, color: theme.accent),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'Agent 面板',
                        style: TextStyle(color: theme.ink, fontSize: 20, fontWeight: FontWeight.w600),
                      ),
                    ),
                    Text('$active 进行中 · ${agents.length} 个任务', style: TextStyle(color: theme.muted, fontSize: 12)),
                    IconButton(
                      tooltip: '刷新任务',
                      onPressed: _loading || widget.refresh == null ? null : _refresh,
                      icon: Icon(Icons.refresh, color: theme.accent),
                    ),
                  ],
                ),
              ),
              if (_loading) LinearProgressIndicator(color: theme.accent, backgroundColor: theme.border),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline, color: Color(0xffb05245)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text('加载任务失败：$_error', style: TextStyle(color: theme.ink)),
                      ),
                      TextButton(onPressed: _refresh, child: const Text('重试')),
                    ],
                  ),
                ),
              Expanded(
                child: agents.isEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            _loading ? '正在加载 Agent…' : '暂无 Agent 任务\n派发子任务后，可在这里查看进度与日志。',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: theme.muted, height: 1.7),
                          ),
                        ),
                      )
                    : LayoutBuilder(
                        builder: (context, box) => GridView.builder(
                          padding: const EdgeInsets.all(16),
                          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                            crossAxisCount: box.maxWidth >= 720
                                ? 3
                                : box.maxWidth >= 440
                                ? 2
                                : 1,
                            mainAxisExtent: 205,
                            mainAxisSpacing: 12,
                            crossAxisSpacing: 12,
                          ),
                          itemCount: agents.length,
                          itemBuilder: (context, index) => _card(agents[index]),
                        ),
                      ),
              ),
            ],
          ),
        ),
      );
    },
  );

  Widget _card(CodexAgent agent) {
    final parent = agent.parentId == null ? null : widget.state.agent(agent.parentId!);
    return Material(
      key: ValueKey('agent-card-${agent.agentId}'),
      color: theme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: theme.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: widget.onOpenConversation != null && agent.agentThreadId?.isNotEmpty == true
            ? () => widget.onOpenConversation!(agent)
            : () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => _AgentDetails(state: widget.state, agentId: agent.agentId, theme: theme),
                ),
              ),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      agent.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: theme.ink, fontWeight: FontWeight.w600, fontSize: 16),
                    ),
                  ),
                  const SizedBox(width: 8),
                  _AgentStatus(agent: agent, theme: theme),
                ],
              ),
              if (agent.role?.isNotEmpty == true)
                Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Text(
                    agent.role!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: theme.accent, fontSize: 12),
                  ),
                ),
              const SizedBox(height: 10),
              Expanded(
                child: Text(
                  agent.task,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: theme.ink, height: 1.45, fontSize: 13),
                ),
              ),
              if (agent.error != null)
                Text(
                  agent.error!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Color(0xffb05245), fontSize: 12),
                ),
              const SizedBox(height: 8),
              Text(
                parent == null
                    ? widget.onOpenConversation != null && agent.agentThreadId?.isNotEmpty == true
                          ? '${agent.logs.length} 条日志 · 点击继续对话'
                          : '${agent.logs.length} 条日志 · 点击查看过程'
                    : '来自 ${parent.name} · ${agent.logs.length} 条日志',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: theme.muted, fontSize: 11),
              ),
              if (widget.onOpenConversation != null && agent.agentThreadId?.isNotEmpty == true)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Row(
                    children: [
                      Icon(Icons.chat_bubble_outline, size: 13, color: theme.accent),
                      const SizedBox(width: 4),
                      Text('打开独立对话', style: TextStyle(color: theme.accent, fontSize: 11)),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AgentStatus extends StatelessWidget {
  const _AgentStatus({required this.agent, required this.theme});
  final CodexAgent agent;
  final CodexTheme theme;
  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (agent.active)
        SizedBox(width: 12, height: 12, child: CircularProgressIndicator(strokeWidth: 1.8, color: theme.accent))
      else
        Icon(
          agent.state == 'done' ? Icons.check_circle_outline : Icons.error_outline,
          size: 14,
          color: agent.state == 'done' ? theme.accent : const Color(0xffb05245),
        ),
      const SizedBox(width: 5),
      Text(switch (agent.state) {
        'queued' => '排队中',
        'running' => '运行中',
        'done' => '已完成',
        'failed' => '失败',
        _ => agent.state,
      }, style: TextStyle(color: theme.muted, fontSize: 11)),
    ],
  );
}

class _AgentDetails extends StatelessWidget {
  const _AgentDetails({required this.state, required this.agentId, required this.theme});
  final CodexAgentsState state;
  final String agentId;
  final CodexTheme theme;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: state,
    builder: (context, _) {
      final agent = state.agent(agentId);
      return Scaffold(
        backgroundColor: theme.background,
        appBar: AppBar(
          backgroundColor: theme.surface,
          foregroundColor: theme.ink,
          title: Text(agent?.name ?? 'Agent 详情'),
          actions: [
            if (agent != null)
              Padding(
                padding: const EdgeInsets.only(right: 16),
                child: _AgentStatus(agent: agent, theme: theme),
              ),
          ],
        ),
        body: agent == null
            ? const Center(child: Text('此任务已从历史记录中移除'))
            : ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  if (agent.role != null)
                    Text(
                      agent.role!,
                      style: TextStyle(color: theme.accent, fontWeight: FontWeight.w600),
                    ),
                  const SizedBox(height: 8),
                  SelectableText(agent.task, style: TextStyle(color: theme.ink, height: 1.5)),
                  const SizedBox(height: 12),
                  Text(_times(agent), style: TextStyle(color: theme.muted, fontSize: 12)),
                  if (agent.error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: SelectableText(agent.error!, style: const TextStyle(color: Color(0xffb05245))),
                    ),
                  const SizedBox(height: 20),
                  if (agent.droppedLogs > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(
                        '[truncated] 日志达到保留限额，较早的 ${agent.droppedLogs} 条日志（${agent.droppedBytes} bytes）已移除。',
                        style: TextStyle(color: theme.muted, fontSize: 12),
                      ),
                    ),
                  if (agent.logs.isEmpty)
                    Text(agent.active ? '等待子 Agent 输出…' : '此任务没有日志', style: TextStyle(color: theme.muted)),
                  for (final log in agent.logs) _log(log),
                ],
              ),
      );
    },
  );

  String _times(CodexAgent agent) {
    String format(DateTime date) => date.toLocal().toIso8601String().replaceFirst('T', ' ').split('.').first;
    return [
      if (agent.startedAt != null) '开始 ${format(agent.startedAt!)}',
      if (agent.endedAt != null) '结束 ${format(agent.endedAt!)}',
    ].join(' · ');
  }

  Widget _log(CodexAgentLog log) {
    final reasoning = log.level == 'reasoning';
    final tool = log.level == 'tool';
    final label = reasoning
        ? '思考'
        : tool
        ? '工具 · ${log.name ?? log.type}'
        : '正文';
    return Container(
      key: ValueKey('agent-log-${log.seq}'),
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('$label · #${log.seq}', style: TextStyle(fontSize: 11, color: theme.accent)),
          const SizedBox(height: 8),
          SelectableText(
            log.text,
            style: TextStyle(
              color: reasoning ? theme.muted : theme.ink,
              fontStyle: reasoning ? FontStyle.italic : FontStyle.normal,
              fontFamily: tool ? 'monospace' : null,
              height: 1.5,
              fontSize: 13,
            ),
          ),
          if (log.truncated && !log.text.contains('truncated'))
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('[truncated] 此条日志已截断', style: TextStyle(color: theme.muted, fontSize: 11)),
            ),
        ],
      ),
    );
  }
}
