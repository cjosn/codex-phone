import 'package:flutter/material.dart';

import 'codex_pocket_state.dart';
import 'codex_ui_kit.dart';

/// Tools, skills, MCP and workflows are operational surfaces. Tool shortcuts
/// send a real Codex turn; management actions use the bridge contracts directly.
class CodexCapabilitiesPage extends StatefulWidget {
  const CodexCapabilitiesPage({
    super.key,
    required this.state,
    required this.cwd,
    required this.onUseTool,
    this.embedded = false,
  });

  final CodexPocketState state;
  final String cwd;
  final Future<void> Function(String tool, String instruction) onUseTool;

  /// true = 作为抽屉里 push 出来的二级页，自带 AppBar 与返回键。
  final bool embedded;

  @override
  State<CodexCapabilitiesPage> createState() => _CodexCapabilitiesPageState();
}

class _CodexCapabilitiesPageState extends State<CodexCapabilitiesPage> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 5, vsync: this);
  final _search = TextEditingController();
  String _query = '';

  /// 工具包的失败原因直接来自桥的 error.message，显示在页面上而不是吞掉。
  String? _toolpackError;

  CodexPocketState get state => widget.state;

  /// 桥的 mcpServerStatus/list 里 tools 是对象（{名称: 定义}），老 fixture 用数组；
  /// 两种形状都要能读，否则真机上整页会在构建期抛类型错误变成空白。
  List<Map<String, dynamic>> _mcpTools(Map<String, dynamic> server) {
    final raw = server['tools'];
    if (raw is Map) {
      return [
        for (final entry in raw.entries)
          if (entry.value is Map)
            {
              'name': (entry.value as Map)['name'] ?? entry.key,
              'description': (entry.value as Map)['description'] ?? '',
            },
      ];
    }
    if (raw is List) return raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
    return const [];
  }

  @override
  void initState() {
    super.initState();
    state.addListener(_changed);
    // Deferred loading avoids notifying sibling listeners during widget build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _refresh();
    });
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    state.removeListener(_changed);
    _tabs.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    try {
      await Future.wait([state.loadSkills(), state.loadMcp(), state.loadWorkflows(), state.loadToolpacks()]);
      if (mounted && _toolpackError != null) setState(() => _toolpackError = null);
    } catch (error) {
      // 工具包接口缺失或报文异常时把原因留在页面上，其余能力照常可用。
      if (mounted) setState(() => _toolpackError = _errorText(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    final content = _content();
    if (!widget.embedded) return content;
    return Scaffold(
      backgroundColor: const Color(0xfff8f8f4),
      appBar: AppBar(
        title: const Text('能力', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        backgroundColor: const Color(0xfff8f8f4),
        surfaceTintColor: Colors.transparent,
      ),
      body: SafeArea(top: false, child: content),
    );
  }

  Widget _content() => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 4, 4),
        child: Row(
          children: [
            Expanded(
              child: TabBar(
                controller: _tabs,
                isScrollable: true,
                tabAlignment: TabAlignment.start,
                labelPadding: const EdgeInsets.symmetric(horizontal: 13),
                tabs: [
                  const Tab(text: '工具'),
                  Tab(text: '技能 ${state.skills.length}'),
                  Tab(text: 'MCP ${state.mcpServers.length}'),
                  Tab(text: '工作流 ${state.workflows.length}'),
                  Tab(text: '工具包 ${state.toolpacks.length}'),
                ],
              ),
            ),
            IconButton(tooltip: '刷新能力', onPressed: _refresh, icon: const Icon(Icons.refresh, size: 19)),
          ],
        ),
      ),
      Expanded(
        child: TabBarView(
          controller: _tabs,
          children: [_toolsTab(), _skillsTab(), _mcpTab(), _workflowsTab(), _toolpacksTab()],
        ),
      ),
    ],
  );

  Widget _searchField(String hint) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
    child: TextField(
      controller: _search,
      decoration: codexFieldDecoration(hint).copyWith(
        isDense: true,
        prefixIcon: const Icon(Icons.search, size: 18),
        suffixIcon: _query.isEmpty
            ? null
            : IconButton(
                tooltip: '清除搜索',
                onPressed: () {
                  _search.clear();
                  setState(() => _query = '');
                },
                icon: const Icon(Icons.close, size: 16),
              ),
      ),
      onChanged: (value) => setState(() => _query = value),
    ),
  );

  Widget _toolsTab() {
    final tools = <_CapabilityTool>[
      const _CapabilityTool('apply_patch', '修改项目文件', '让 Codex 审查并生成最小补丁', Icons.difference_outlined),
      const _CapabilityTool('exec_command', '运行命令', '在官方审批与沙箱策略下执行命令', Icons.terminal),
      const _CapabilityTool('read_file', '阅读代码', '读取当前工作区并解释实现', Icons.code),
      const _CapabilityTool('web_search', '联网检索', '查找最新文档并核对来源', Icons.travel_explore_outlined),
      for (final server in state.mcpServers)
        for (final raw in _mcpTools(server))
          _CapabilityTool(
            (raw['name'] ?? 'tool').toString(),
            (server['name'] ?? server['id'] ?? 'MCP').toString(),
            (raw['description'] ?? '由 MCP 服务器提供的工具').toString(),
            Icons.extension_outlined,
          ),
    ];
    final filtered = tools.where((tool) {
      final query = _query.trim().toLowerCase();
      return query.isEmpty || '${tool.name} ${tool.title} ${tool.description}'.toLowerCase().contains(query);
    }).toList();
    return Column(
      children: [
        _searchField('搜索内置与 MCP 工具'),
        Expanded(
          child: filtered.isEmpty
              ? const CodexEmptyState(
                  icon: Icons.handyman_outlined,
                  title: '没有匹配的工具',
                  message: '清除搜索，或在 MCP 页连接一个工具服务器。',
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  itemCount: filtered.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, index) {
                    final tool = filtered[index];
                    return Card(
                      elevation: 0,
                      color: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: const BorderSide(color: Color(0xffe4e5dc)),
                      ),
                      child: ListTile(
                        leading: Icon(tool.icon, color: const Color(0xff505748)),
                        title: Text(tool.title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                        subtitle: Text(
                          '${tool.name}\n${tool.description}',
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                        ),
                        isThreeLine: true,
                        trailing: FilledButton.tonal(onPressed: () => _useTool(tool), child: const Text('使用')),
                      ),
                    );
                  },
                ),
        ),
      ],
    );
  }

  Future<void> _useTool(_CapabilityTool tool) async {
    final controller = TextEditingController();
    final instruction = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('使用 ${tool.title}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('将发送给官方 Codex，由 app-server 按权限策略调度 ${tool.name}。', style: const TextStyle(fontSize: 12)),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              autofocus: true,
              minLines: 3,
              maxLines: 6,
              decoration: codexFieldDecoration('任务说明', hint: '要读取、修改、运行或查询什么？'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('发送任务')),
        ],
      ),
    );
    if (instruction == null || instruction.isEmpty) return;
    await widget.onUseTool(tool.name, instruction);
  }

  Widget _skillsTab() {
    final query = _query.trim().toLowerCase();
    final skills = state.skills.where((skill) {
      return query.isEmpty ||
          '${skill['name']} ${skill['description']} ${skill['interface']}'.toLowerCase().contains(query);
    }).toList();
    return Column(
      children: [
        _searchField('搜索技能'),
        Expanded(
          child: state.skillsLoading
              ? const Center(child: CircularProgressIndicator())
              : skills.isEmpty
              ? CodexEmptyState(
                  icon: Icons.auto_awesome_outlined,
                  title: '没有技能',
                  message: '创建 SKILL.md 后，官方 Codex 会按描述匹配并在对话中使用。',
                  action: FilledButton.icon(
                    onPressed: _createSkill,
                    icon: const Icon(Icons.add),
                    label: const Text('新建技能'),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 80),
                  children: [
                    for (final skill in skills)
                      Card(
                        elevation: 0,
                        color: Colors.white,
                        margin: const EdgeInsets.only(bottom: 8),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                          side: const BorderSide(color: Color(0xffe4e5dc)),
                        ),
                        child: ListTile(
                          leading: const Icon(Icons.auto_awesome_outlined),
                          title: Text(_skillName(skill), style: const TextStyle(fontWeight: FontWeight.w600)),
                          subtitle: Text(
                            (skill['description'] ?? '无描述').toString(),
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                          ),
                          trailing: CodexStatusBadge(
                            label: (skill['scope'] ?? 'system') == 'user' ? '个人' : '系统',
                            positive: skill['enabled'] != false,
                          ),
                        ),
                      ),
                  ],
                ),
        ),
      ],
    );
  }

  Future<void> _createSkill() async {
    final name = TextEditingController();
    final description = TextEditingController();
    final body = TextEditingController(text: '# 使用步骤\n\n1. \n');
    final save = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('新建 Codex 技能'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: name,
                decoration: codexFieldDecoration('英文名称', hint: 'release-check'),
              ),
              const SizedBox(height: 10),
              TextField(controller: description, decoration: codexFieldDecoration('何时使用这项技能')),
              const SizedBox(height: 10),
              TextField(controller: body, minLines: 7, maxLines: 12, decoration: codexFieldDecoration('SKILL.md 正文')),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('创建')),
        ],
      ),
    );
    if (save != true) return;
    await state.createSkill(name.text.trim(), description.text.trim(), body.text);
    if (mounted) showCodexMessage(context, state.error ?? '技能已创建');
  }

  Widget _mcpTab() {
    if (state.mcpLoading) return const Center(child: CircularProgressIndicator());
    return Stack(
      children: [
        state.mcpServers.isEmpty
            ? CodexEmptyState(
                icon: Icons.extension_outlined,
                title: '连接 MCP 工具服务器',
                message: '写入官方 Codex 配置后，服务器工具会出现在“工具”分类，并由 Codex 在对话中调度。',
                action: FilledButton.icon(onPressed: _addMcp, icon: const Icon(Icons.add), label: const Text('添加 MCP')),
              )
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 82),
                children: [
                  for (final server in state.mcpServers)
                    Card(
                      elevation: 0,
                      color: Colors.white,
                      margin: const EdgeInsets.only(bottom: 10),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: const BorderSide(color: Color(0xffe4e5dc)),
                      ),
                      child: Column(
                        children: [
                          ListTile(
                            leading: const Icon(Icons.dns_outlined),
                            title: Text((server['name'] ?? server['id'] ?? 'MCP').toString()),
                            subtitle: Text(
                              '${_mcpTools(server).length} 个工具 · ${server['runtimeStatus'] ?? server['status'] ?? server['state'] ?? 'unknown'}',
                            ),
                            trailing: IconButton(
                              tooltip: '移除 MCP 服务器',
                              onPressed: () => _removeMcp(server),
                              icon: const Icon(Icons.delete_outline, size: 19),
                            ),
                          ),
                          if (_mcpTools(server).isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: Wrap(
                                  spacing: 6,
                                  runSpacing: 6,
                                  children: [
                                    for (final tool in _mcpTools(server).take(12))
                                      Chip(
                                        visualDensity: VisualDensity.compact,
                                        label: Text((tool['name'] ?? 'tool').toString()),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
        Positioned(
          right: 16,
          bottom: 16,
          child: FloatingActionButton.small(tooltip: '添加 MCP', onPressed: _addMcp, child: const Icon(Icons.add)),
        ),
      ],
    );
  }

  Future<void> _addMcp() async {
    final name = TextEditingController();
    final command = TextEditingController();
    final args = TextEditingController();
    final cwd = TextEditingController(text: widget.cwd);
    final env = TextEditingController();
    final save = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('添加 stdio MCP'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: name,
                decoration: codexFieldDecoration('服务器名称', hint: 'filesystem'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: command,
                decoration: codexFieldDecoration('可执行命令', hint: 'npx'),
              ),
              const SizedBox(height: 10),
              TextField(controller: args, minLines: 2, maxLines: 4, decoration: codexFieldDecoration('参数（每行一个）')),
              const SizedBox(height: 10),
              TextField(controller: cwd, decoration: codexFieldDecoration('工作目录（可选）')),
              const SizedBox(height: 10),
              TextField(
                controller: env,
                minLines: 2,
                maxLines: 4,
                decoration: codexFieldDecoration('环境变量（每行 KEY=VALUE）'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('添加')),
        ],
      ),
    );
    if (save != true) return;
    try {
      final environment = <String, String>{};
      for (final line in env.text.split('\n')) {
        final index = line.indexOf('=');
        if (index > 0) environment[line.substring(0, index).trim()] = line.substring(index + 1);
      }
      await state.addMcpServer(
        name: name.text.trim(),
        command: command.text.trim(),
        args: args.text.split('\n').map((arg) => arg.trim()).where((arg) => arg.isNotEmpty).toList(),
        cwd: cwd.text.trim(),
        env: environment,
      );
      if (mounted) showCodexMessage(context, 'MCP 服务器已写入 Codex 配置');
    } catch (error) {
      if (mounted) showCodexMessage(context, '添加失败：$error');
    }
  }

  Future<void> _removeMcp(Map<String, dynamic> server) async {
    final name = (server['name'] ?? server['id'] ?? '').toString();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('移除 $name？'),
        content: const Text('这会从 Codex 配置中删除该 MCP 服务器，不影响其他服务器。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('移除')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await state.removeMcpServer(name);
    } catch (error) {
      if (mounted) showCodexMessage(context, '移除失败：$error');
    }
  }

  Widget _workflowsTab() {
    if (state.workflowsLoading && state.workflows.isEmpty) return const Center(child: CircularProgressIndicator());
    return Stack(
      children: [
        state.workflows.isEmpty
            ? CodexEmptyState(
                icon: Icons.account_tree_outlined,
                title: '把重复任务编成工作流',
                message: '提示步骤使用官方 Codex 会话；Shell 步骤每次运行都需要单独批准。',
                action: FilledButton.icon(
                  onPressed: _createWorkflow,
                  icon: const Icon(Icons.add),
                  label: const Text('新建工作流'),
                ),
              )
            : ListView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 82),
                children: [
                  for (final workflow in state.workflows)
                    Builder(
                      builder: (context) {
                        final steps = (workflow['steps'] as List? ?? const []);
                        final hasShell = steps.any((step) => step is Map && step['type'] == 'shell');
                        return Card(
                          elevation: 0,
                          color: Colors.white,
                          margin: const EdgeInsets.only(bottom: 10),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(12),
                            side: const BorderSide(color: Color(0xffe4e5dc)),
                          ),
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    const Icon(Icons.account_tree_outlined, size: 20),
                                    const SizedBox(width: 8),
                                    Expanded(
                                      child: Text(
                                        (workflow['name'] ?? '工作流').toString(),
                                        style: const TextStyle(fontWeight: FontWeight.w600),
                                      ),
                                    ),
                                    IconButton(
                                      tooltip: '删除工作流',
                                      onPressed: () => _deleteWorkflow(workflow),
                                      icon: const Icon(Icons.delete_outline, size: 18),
                                    ),
                                  ],
                                ),
                                Text(
                                  '${steps.length} 个步骤${hasShell ? ' · 含需批准的 Shell' : ' · 仅 Codex 提示'}',
                                  style: const TextStyle(fontSize: 11.5, color: Color(0xff7c7e74)),
                                ),
                                const SizedBox(height: 8),
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.end,
                                  children: [
                                    TextButton(onPressed: () => _workflowDetails(workflow), child: const Text('详情与记录')),
                                    const SizedBox(width: 6),
                                    FilledButton.icon(
                                      onPressed: () => _runWorkflow(workflow, hasShell),
                                      icon: const Icon(Icons.play_arrow, size: 17),
                                      label: const Text('运行'),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                ],
              ),
        Positioned(
          right: 16,
          bottom: 16,
          child: FloatingActionButton.small(tooltip: '新建工作流', onPressed: _createWorkflow, child: const Icon(Icons.add)),
        ),
      ],
    );
  }

  Future<void> _createWorkflow() async {
    final draft = await showModalBottomSheet<_WorkflowDraft>(
      context: context,
      isScrollControlled: true,
      builder: (_) => const _WorkflowEditor(),
    );
    if (draft == null) return;
    try {
      await state.createWorkflow(draft.name, draft.steps);
      if (mounted) showCodexMessage(context, '工作流已创建');
    } catch (error) {
      if (mounted) showCodexMessage(context, '创建失败：$error');
    }
  }

  Future<void> _runWorkflow(Map<String, dynamic> workflow, bool hasShell) async {
    final id = (workflow['id'] ?? '').toString();
    if (id.isEmpty) return;
    if (hasShell) {
      final approved = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          icon: const Icon(Icons.warning_amber_outlined),
          title: const Text('批准本次 Shell 步骤？'),
          content: const Text('工作流会在本机执行其中的 Shell 命令。批准只对本次运行生效；请先在详情中检查命令。'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('批准并运行')),
          ],
        ),
      );
      if (approved != true) return;
    }
    try {
      final run = await state.runWorkflow(id, approveShell: hasShell);
      if (mounted)
        showCodexMessage(context, '工作流${run['status'] == 'failed' ? '失败' : '已完成'} · ${run['status'] ?? 'running'}');
    } catch (error) {
      if (mounted) showCodexMessage(context, '运行失败：$error');
    }
  }

  Future<void> _workflowDetails(Map<String, dynamic> workflow) async {
    final id = (workflow['id'] ?? '').toString();
    try {
      final result = await state.getWorkflow(id);
      if (!mounted) return;
      final detail = (result['workflow'] as Map? ?? workflow).cast<String, dynamic>();
      final runs = (result['runs'] as List? ?? const []).whereType<Map>().toList();
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (context) => DraggableScrollableSheet(
          expand: false,
          initialChildSize: 0.72,
          builder: (context, scroll) => ListView(
            controller: scroll,
            padding: const EdgeInsets.all(18),
            children: [
              Text(
                (detail['name'] ?? '工作流').toString(),
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 14),
              const Text('步骤', style: TextStyle(fontWeight: FontWeight.w600)),
              for (final step in (detail['steps'] as List? ?? const []))
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(step is Map && step['type'] == 'shell' ? Icons.terminal : Icons.chat_outlined),
                  title: Text(step is Map ? (step['type'] ?? 'step').toString() : 'step'),
                  subtitle: SelectableText(
                    step is Map
                        ? (step['text'] ?? (step['argv'] as List?)?.join(' ') ?? '').toString()
                        : step.toString(),
                  ),
                ),
              const Divider(),
              const Text('最近运行', style: TextStyle(fontWeight: FontWeight.w600)),
              if (runs.isEmpty) const Padding(padding: EdgeInsets.all(12), child: Text('还没有运行记录')),
              for (final run in runs)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.history),
                  title: Text((run['status'] ?? 'unknown').toString()),
                  subtitle: Text((run['startedAt'] ?? '').toString()),
                ),
            ],
          ),
        ),
      );
    } catch (error) {
      if (mounted) showCodexMessage(context, '读取失败：$error');
    }
  }

  Future<void> _deleteWorkflow(Map<String, dynamic> workflow) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('删除 ${workflow['name'] ?? '工作流'}？'),
        content: const Text('只删除工作流定义，不删除已产生的 Codex 会话。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('删除')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await state.deleteWorkflow((workflow['id'] ?? '').toString());
    } catch (error) {
      if (mounted) showCodexMessage(context, '删除失败：$error');
    }
  }

  // ---- 工具包：每个包一行（标题、工具数、开关、内置/用户），内置包只能禁用 ----
  Widget _toolpacksTab() {
    final failure = _toolpackError ?? state.toolpacksError;
    return Column(
      children: [
        if (failure != null) _failureNote(failure),
        Expanded(
          child: state.toolpacksLoading && state.toolpacks.isEmpty
              ? const Center(child: CircularProgressIndicator())
              : state.toolpacks.isEmpty
              ? const CodexEmptyState(
                  icon: Icons.inventory_2_outlined,
                  title: '还没有工具包',
                  message: '工具按包管理：启用后才会随会话加载给模型，禁用的包不会暴露。',
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                  itemCount: state.toolpacks.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, index) => _toolpackCard(state.toolpacks[index]),
                ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                key: const Key('import-toolpack'),
                onPressed: _importToolpack,
                icon: const Icon(Icons.file_download_outlined, size: 18),
                label: const Text('导入工具包'),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _failureNote(String message) => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(16, 8, 16, 4),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(color: const Color(0xffffebe7), borderRadius: BorderRadius.circular(10)),
    child: SelectableText(message, style: const TextStyle(fontSize: 12, height: 1.4, color: Color(0xff8b2b20))),
  );

  Widget _toolpackCard(Map<String, dynamic> pack) {
    final name = (pack['name'] ?? '').toString();
    final tools = (pack['tools'] as List?) ?? const [];
    final builtin = pack['builtin'] == true;
    final description = (pack['description'] ?? '').toString();
    return Card(
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: Color(0xffe4e5dc)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            leading: const Icon(Icons.inventory_2_outlined),
            title: Text(
              (pack['title'] ?? name).toString(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
            ),
            subtitle: Text('${tools.length} 个工具 · ${builtin ? '内置包' : '用户包'}'),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Switch(
                  key: Key('toolpack-switch-$name'),
                  value: pack['enabled'] != false,
                  onChanged: (value) => _toggleToolpack(name, value),
                ),
                if (!builtin)
                  IconButton(
                    key: Key('toolpack-remove-$name'),
                    tooltip: '删除工具包',
                    onPressed: () => _removeToolpack(name),
                    icon: const Icon(Icons.delete_outline, size: 19),
                  ),
              ],
            ),
          ),
          if (description.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Text(
                description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11.5, color: Color(0xff7c7e74)),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _toggleToolpack(String name, bool enabled) async {
    try {
      await state.toggleToolpack(name, enabled);
      if (mounted && _toolpackError != null) setState(() => _toolpackError = null);
    } catch (error) {
      if (mounted) setState(() => _toolpackError = _errorText(error));
    }
  }

  Future<void> _importToolpack() async {
    final path = TextEditingController();
    final target = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('导入工具包'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('把含 index.mjs 的目录复制进用户工具包目录，导入后可直接启用。', style: TextStyle(fontSize: 12)),
            const SizedBox(height: 12),
            TextField(
              key: const Key('toolpack-import-path'),
              controller: path,
              autofocus: true,
              decoration: codexFieldDecoration('工具包目录', hint: '/root/workspace/packs/mypack'),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(
            key: const Key('toolpack-import-confirm'),
            onPressed: () => Navigator.pop(context, path.text.trim()),
            child: const Text('导入'),
          ),
        ],
      ),
    );
    if (target == null || target.isEmpty) return;
    try {
      final name = await state.importToolpack(target);
      if (!mounted) return;
      setState(() => _toolpackError = null);
      showCodexMessage(context, '已导入工具包 $name');
    } catch (error) {
      if (mounted) setState(() => _toolpackError = _errorText(error));
    }
  }

  Future<void> _removeToolpack(String name) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('删除工具包 $name？'),
        content: const Text('只删除用户工具包目录里的副本，内置包不受影响（内置包只能禁用）。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('删除')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await state.removeToolpack(name);
      if (mounted && _toolpackError != null) setState(() => _toolpackError = null);
    } catch (error) {
      if (mounted) setState(() => _toolpackError = _errorText(error));
    }
  }

  static String _errorText(Object error) => error.toString().replaceFirst('Exception: ', '');

  static String _skillName(Map<String, dynamic> skill) {
    final interface = skill['interface'];
    if (interface is Map && interface['displayName'] != null) return interface['displayName'].toString();
    return (skill['name'] ?? '未命名技能').toString();
  }
}

class _CapabilityTool {
  const _CapabilityTool(this.name, this.title, this.description, this.icon);
  final String name;
  final String title;
  final String description;
  final IconData icon;
}

class _WorkflowDraft {
  const _WorkflowDraft(this.name, this.steps);
  final String name;
  final List<Map<String, dynamic>> steps;
}

class _WorkflowEditor extends StatefulWidget {
  const _WorkflowEditor();

  @override
  State<_WorkflowEditor> createState() => _WorkflowEditorState();
}

class _WorkflowEditorState extends State<_WorkflowEditor> {
  final _name = TextEditingController();
  final List<_WorkflowStepDraft> _steps = [_WorkflowStepDraft('prompt')];

  @override
  void dispose() {
    _name.dispose();
    for (final step in _steps) step.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
    child: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('新建工作流', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          TextField(
            controller: _name,
            decoration: codexFieldDecoration('名称', hint: '检查并修复项目'),
          ),
          const SizedBox(height: 12),
          for (var index = 0; index < _steps.length; index++)
            _WorkflowStepEditor(
              index: index,
              draft: _steps[index],
              onTypeChanged: (type) => setState(() => _steps[index].type = type),
              onRemove: _steps.length == 1 ? null : () => setState(() => _steps.removeAt(index).dispose()),
            ),
          OutlinedButton.icon(
            onPressed: () => setState(() => _steps.add(_WorkflowStepDraft('prompt'))),
            icon: const Icon(Icons.add),
            label: const Text('添加步骤'),
          ),
          const SizedBox(height: 8),
          const Text(
            'Shell 使用可执行文件与逐行参数，不经过命令字符串拆分。每次运行都会要求明确批准。',
            style: TextStyle(fontSize: 11, height: 1.5, color: Color(0xff7c7e74)),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () {
              if (_name.text.trim().isEmpty) return;
              final steps = [for (final step in _steps) step.toJson()].where((step) => step.isNotEmpty).toList();
              if (steps.isEmpty) return;
              Navigator.pop(context, _WorkflowDraft(_name.text.trim(), steps));
            },
            child: const Text('创建工作流'),
          ),
        ],
      ),
    ),
  );
}

class _WorkflowStepDraft {
  _WorkflowStepDraft(this.type);
  String type;
  final text = TextEditingController();
  final executable = TextEditingController();
  final args = TextEditingController();
  final cwd = TextEditingController();

  Map<String, dynamic> toJson() => type == 'prompt'
      ? {'type': 'prompt', 'text': text.text.trim()}
      : {
          'type': 'shell',
          'argv': [
            executable.text.trim(),
            ...args.text.split('\n').map((arg) => arg.trim()).where((arg) => arg.isNotEmpty),
          ],
          if (cwd.text.trim().isNotEmpty) 'cwd': cwd.text.trim(),
        };

  void dispose() {
    text.dispose();
    executable.dispose();
    args.dispose();
    cwd.dispose();
  }
}

class _WorkflowStepEditor extends StatelessWidget {
  const _WorkflowStepEditor({
    required this.index,
    required this.draft,
    required this.onTypeChanged,
    required this.onRemove,
  });
  final int index;
  final _WorkflowStepDraft draft;
  final ValueChanged<String> onTypeChanged;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) => Card(
    elevation: 0,
    margin: const EdgeInsets.only(bottom: 10),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(12),
      side: const BorderSide(color: Color(0xffdfe0d8)),
    ),
    child: Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<String>(
                  initialValue: draft.type,
                  decoration: codexFieldDecoration('步骤 ${index + 1}'),
                  items: const [
                    DropdownMenuItem(value: 'prompt', child: Text('Codex 提示')),
                    DropdownMenuItem(value: 'shell', child: Text('Shell 命令')),
                  ],
                  onChanged: (value) {
                    if (value != null) onTypeChanged(value);
                  },
                ),
              ),
              if (onRemove != null) IconButton(tooltip: '删除步骤', onPressed: onRemove, icon: const Icon(Icons.close)),
            ],
          ),
          const SizedBox(height: 10),
          if (draft.type == 'prompt')
            TextField(controller: draft.text, minLines: 3, maxLines: 6, decoration: codexFieldDecoration('提示内容'))
          else ...[
            TextField(
              controller: draft.executable,
              decoration: codexFieldDecoration('可执行文件', hint: 'git'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: draft.args,
              minLines: 2,
              maxLines: 4,
              decoration: codexFieldDecoration('参数（每行一个）', hint: 'status\n--short'),
            ),
            const SizedBox(height: 8),
            TextField(controller: draft.cwd, decoration: codexFieldDecoration('工作目录（可选）')),
          ],
        ],
      ),
    ),
  );
}
