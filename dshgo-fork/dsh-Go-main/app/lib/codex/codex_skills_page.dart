import 'package:flutter/material.dart';

import 'codex_pocket_state.dart';

/// 技能页：对齐桌面端 Plugins / Skills 的信息结构
/// （搜索 + 已安装网格 + System/Personal 分区 + 启用状态）。
class CodexSkillsPage extends StatefulWidget {
  const CodexSkillsPage({super.key, required this.state, this.embedded = false});

  final CodexPocketState state;

  /// true = 作为 Tab 内容渲染（不要自己的 AppBar/Scaffold）。
  final bool embedded;

  @override
  State<CodexSkillsPage> createState() => _CodexSkillsPageState();
}

class _CodexSkillsPageState extends State<CodexSkillsPage> {
  final _search = TextEditingController();
  String _query = '';

  /// 0 = 技能，1 = MCP 服务器
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_changed);
    widget.state.loadSkills();
    widget.state.loadMcp();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.state.removeListener(_changed);
    _search.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> get _filtered {
    final q = _query.trim().toLowerCase();
    final all = widget.state.skills;
    if (q.isEmpty) return all;
    return all.where((s) => '${s['name']} ${s['description']} ${_displayName(s)}'.toLowerCase().contains(q)).toList();
  }

  String _displayName(Map<String, dynamic> skill) {
    final raw = skill['interface'];
    if (raw is Map) {
      final name = raw['displayName'];
      if (name != null && name.toString().isNotEmpty) return name.toString();
    }
    return (skill['name'] ?? '未命名技能').toString();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final items = _filtered;
    final system = items.where((s) => (s['scope'] ?? '') != 'user').toList();
    final personal = items.where((s) => (s['scope'] ?? '') == 'user').toList();
    final skillsList = ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
      children: [
        TextField(
          controller: _search,
          decoration: InputDecoration(
            isDense: true,
            hintText: '搜索技能',
            prefixIcon: const Icon(Icons.search, size: 18),
            filled: true,
            fillColor: Colors.white,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(22),
              borderSide: const BorderSide(color: Color(0xffe6e6df)),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(22),
              borderSide: const BorderSide(color: Color(0xffe6e6df)),
            ),
          ),
          onChanged: (v) => setState(() => _query = v),
        ),
        const SizedBox(height: 14),
        if (state.skillsLoading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 16),
            child: Text('正在读取技能…', style: TextStyle(fontSize: 12, color: Color(0xff8a8b82))),
          ),
        if (!state.skillsLoading && items.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Text(
              '没有读到技能。检查 Codex 的 skills 目录或 ~/.codex/AGENTS.md。',
              style: TextStyle(fontSize: 12.5, color: Color(0xff8a8b82)),
            ),
          ),
        if (system.isNotEmpty) ...[
          const _SectionLabel('系统'),
          for (final skill in system) _SkillTile(skill: skill, name: _displayName(skill)),
        ],
        if (personal.isNotEmpty) ...[
          const _SectionLabel('个人'),
          for (final skill in personal) _SkillTile(skill: skill, name: _displayName(skill)),
        ],
      ],
    );

    final body = _tab == 1 ? _mcpList(state) : skillsList;

    if (widget.embedded) {
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 8, 0),
            child: Row(
              children: [
                SegmentedButton<int>(
                  showSelectedIcon: false,
                  style: const ButtonStyle(visualDensity: VisualDensity.compact),
                  segments: [
                    ButtonSegment(value: 0, label: Text('技能 ${items.length}', style: const TextStyle(fontSize: 12))),
                    ButtonSegment(
                      value: 1,
                      label: Text('MCP ${state.mcpServers.length}', style: const TextStyle(fontSize: 12)),
                    ),
                  ],
                  selected: {_tab},
                  onSelectionChanged: (value) {
                    setState(() => _tab = value.first);
                    if (_tab == 1) state.loadMcp();
                  },
                ),
                const Spacer(),
                if (_tab == 0)
                  IconButton(tooltip: '新建技能', onPressed: _createSkill, icon: const Icon(Icons.add, size: 18)),
                IconButton(
                  tooltip: '刷新',
                  onPressed: _tab == 1 ? state.loadMcp : state.loadSkills,
                  icon: const Icon(Icons.refresh, size: 18),
                ),
              ],
            ),
          ),
          Expanded(child: body),
        ],
      );
    }
    return Scaffold(
      backgroundColor: const Color(0xfff8f8f4),
      appBar: AppBar(
        backgroundColor: const Color(0xfff8f8f4),
        surfaceTintColor: Colors.transparent,
        title: const Text('技能', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        actions: [IconButton(tooltip: '刷新', onPressed: state.loadSkills, icon: const Icon(Icons.refresh, size: 19))],
      ),
      body: body,
    );
  }

  /// MCP 服务器列表：来自 codex 的 mcpServerStatus/list。
  Widget _mcpList(CodexPocketState state) {
    if (state.mcpLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('正在读取 MCP 服务器…', style: TextStyle(fontSize: 12, color: Color(0xff8a8b82))),
        ),
      );
    }
    if (state.mcpServers.isEmpty) {
      return ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
        children: const [
          Text('还没有 MCP 服务器', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
          SizedBox(height: 6),
          Text(
            'codex 通过 ~/.codex/config.toml 的 [mcp_servers.<名字>] 加载 MCP；'
            '配上之后这些工具会直接出现在 codex 的工具列表里。',
            style: TextStyle(fontSize: 11.5, height: 1.6, color: Color(0xff8a8b82)),
          ),
        ],
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
      children: [
        for (final server in state.mcpServers)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 11),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: const Color(0xffe8e8e1)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.extension_outlined, size: 16),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        (server['name'] ?? server['id'] ?? 'MCP').toString(),
                        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                      ),
                    ),
                    Text(
                      (server['status'] ?? server['state'] ?? 'unknown').toString(),
                      style: const TextStyle(fontSize: 10.5, color: Color(0xff8a8b82)),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  '工具 ${(server['tools'] as List?)?.length ?? 0} 个',
                  style: const TextStyle(fontSize: 11, color: Color(0xff8a8b82)),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// 自定义技能：写一份 SKILL.md 到 CODEX_HOME/skills/<slug>/，然后刷新列表。
  Future<void> _createSkill() async {
    final name = TextEditingController();
    final description = TextEditingController();
    final body = TextEditingController(text: '# 用法\n\n1. \n');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新建技能'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: name,
                decoration: const InputDecoration(labelText: '名称（英文，用作目录名）'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: description,
                decoration: const InputDecoration(labelText: '一句话描述（决定何时被匹配）'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: body,
                minLines: 5,
                maxLines: 10,
                decoration: const InputDecoration(labelText: 'SKILL.md 正文（Markdown）'),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('创建')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await widget.state.createSkill(name.text.trim(), description.text.trim(), body.text);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('技能已创建并刷新')));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('创建失败：$e')));
      }
    }
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 14, 4, 8),
    child: Text(
      text,
      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xff66675f)),
    ),
  );
}

class _SkillTile extends StatelessWidget {
  const _SkillTile({required this.skill, required this.name});

  final Map<String, dynamic> skill;
  final String name;

  @override
  Widget build(BuildContext context) {
    final enabled = skill['enabled'] != false;
    final description = (skill['description'] ?? '').toString();
    final scope = (skill['scope'] ?? '').toString();
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(12, 11, 10, 11),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: const Color(0xffe8e8e1)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(color: const Color(0xfff1f1ec), borderRadius: BorderRadius.circular(9)),
            child: const Icon(Icons.auto_awesome_outlined, size: 18, color: Color(0xff6f7069)),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: Color(0xff232420)),
                ),
                if (description.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    description,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, height: 1.45, color: Color(0xff77786f)),
                  ),
                ],
                if (scope.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(scope, style: const TextStyle(fontSize: 10.5, color: Color(0xff9a9b92))),
                ],
              ],
            ),
          ),
          Icon(
            enabled ? Icons.check : Icons.remove,
            size: 16,
            color: enabled ? const Color(0xff4b8a63) : const Color(0xffb9bab1),
          ),
        ],
      ),
    );
  }
}
