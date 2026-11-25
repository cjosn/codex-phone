import 'package:flutter/material.dart';

import 'codex_brand.dart';
import 'codex_pocket_state.dart';

/// 两个抽屉分开放，各自只管一件事：
///
/// - [CodexHistoryPanel]：**对话历史**（标题 + 搜索/筛选 + 新建对话 + 会话列表），
///   由标题栏的「历史」按钮从左侧滑出，是自定义的左侧浮层（不是 `Scaffold.drawer`）；
/// - [CodexToolsPanel]：**设置与工具**（运行时状态 + 终端/能力/设置/关于 + 工作区 + 版本号），
///   由标题栏的汉堡按钮打开，走 `Scaffold.drawer`。
///
/// 会话列表、搜索、筛选、重命名/删除这些逻辑只在这里写一份，两边宿主各嵌自己的面板。
class CodexHistoryPanel extends StatefulWidget {
  const CodexHistoryPanel({
    super.key,
    required this.state,
    required this.onNewTask,
    required this.onOpenThread,
    required this.onClose,
  });

  final CodexPocketState state;
  final Future<void> Function() onNewTask;
  final Future<void> Function(String id) onOpenThread;
  final VoidCallback onClose;

  @override
  State<CodexHistoryPanel> createState() => _CodexHistoryPanelState();
}

class _CodexHistoryPanelState extends State<CodexHistoryPanel> {
  final _search = TextEditingController();
  int _section = 0;
  String? _project;
  String _query = '';
  bool _filterOpen = false;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_changed);
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

  /// 搜索命中四个字段：标题、预览、目录、会话 ID（ID 只要前几位片段就够认人）。
  List<Map<String, dynamic>> get _threads {
    final query = _query.trim().toLowerCase();
    return widget.state.threads.where((thread) {
      if (_project != null && _cwd(thread) != _project) return false;
      if (query.isEmpty) return true;
      if (_title(thread).toLowerCase().contains(query)) return true;
      if (_preview(thread).toLowerCase().contains(query)) return true;
      if (_cwd(thread).toLowerCase().contains(query)) return true;
      return _id(thread).toLowerCase().contains(query);
    }).toList();
  }

  Map<String, List<Map<String, dynamic>>> get _projects {
    final result = <String, List<Map<String, dynamic>>>{};
    for (final thread in widget.state.threads) {
      final cwd = _cwd(thread);
      if (cwd.isEmpty) continue;
      if (_query.isNotEmpty && !cwd.toLowerCase().contains(_query.trim().toLowerCase())) continue;
      result.putIfAbsent(cwd, () => []).add(thread);
    }
    return result;
  }

  void _clearSearch() {
    _search.clear();
    setState(() => _query = '');
  }

  /// 面板从上到下：标题行(36) → 8 → 搜索框(40) → 8 → 新建(44) → 6 → 会话列表。
  /// 顶部让出状态栏（SafeArea）+ 12 的留白，内容不再贴着屏幕上沿。
  @override
  Widget build(BuildContext context) {
    final threads = _threads;
    return Material(
      color: const Color(0xfff1f2ed),
      child: SafeArea(
        top: true,
        bottom: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(context),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 0),
              child: SizedBox(
                height: 40,
                child: _searchField(),
              ),
            ),
            if (_filterOpen)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 6, 14, 0),
                child: SegmentedButton<int>(
                  showSelectedIcon: false,
                  segments: const [
                    ButtonSegment(value: 0, icon: Icon(Icons.history, size: 16), label: Text('最近')),
                    ButtonSegment(value: 1, icon: Icon(Icons.folder_outlined, size: 16), label: Text('项目')),
                  ],
                  selected: {_section},
                  onSelectionChanged: (value) => setState(() {
                    _section = value.first;
                    _project = null;
                  }),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
              child: SizedBox(
                height: 44,
                child: FilledButton.icon(
                  key: const Key('drawer-new-task'),
                  onPressed: widget.onNewTask,
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('新建对话'),
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(44),
                    padding: EdgeInsets.zero,
                    backgroundColor: Theme.of(context).colorScheme.primary,
                    foregroundColor: Theme.of(context).colorScheme.onPrimary,
                    shape: const StadiumBorder(),
                    // 字号跟着主题的 label 走，中文才用得上系统/主题字体，而不是回落成方块。
                    textStyle: Theme.of(context).textTheme.labelLarge?.copyWith(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 6),
            Expanded(child: _section == 0 || _project != null ? _threadList(threads) : _projectList()),
          ],
        ),
      ),
    );
  }

  // ---- 顶部标题区：标题 + 筛选/关闭（搜索框常驻在标题下面）----

  Widget _header(BuildContext context) {
    final primary = Theme.of(context).colorScheme.primary;
    final filtered = _section != 0 || _project != null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
      child: SizedBox(
        height: 36,
        child: Row(
          children: [
            const Expanded(
              child: Text(
                '对话历史',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
            ),
            _headerIcon(
              key: const Key('drawer-filter'),
              tooltip: '筛选会话',
              icon: Icons.tune,
              tint: _filterOpen || filtered ? primary : null,
              onPressed: () => setState(() => _filterOpen = !_filterOpen),
            ),
            _headerIcon(
              key: const Key('history-close'),
              tooltip: '收起对话历史',
              icon: Icons.arrow_back,
              onPressed: widget.onClose,
            ),
          ],
        ),
      ),
    );
  }

  /// 搜索框默认展开：占位文案统一「搜索对话、目录或 ID」，支持 ID 前缀。
  Widget _searchField() => TextField(
    key: const Key('drawer-thread-search'),
    controller: _search,
    textAlignVertical: TextAlignVertical.center,
    style: const TextStyle(fontSize: 13),
    decoration: InputDecoration(
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(vertical: 10),
      hintText: _section == 0 ? '搜索对话、目录或 ID' : '搜索项目目录',
      hintStyle: const TextStyle(fontSize: 13, color: Color(0xff9a9b92)),
      prefixIcon: const Icon(Icons.search, size: 18),
      prefixIconConstraints: const BoxConstraints.tightFor(width: 36, height: 36),
      suffixIcon: _query.isEmpty
          ? null
          : IconButton(
              key: const Key('drawer-search-clear'),
              tooltip: '清除搜索',
              padding: EdgeInsets.zero,
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints.tightFor(width: 32, height: 32),
              onPressed: _clearSearch,
              icon: const Icon(Icons.close, size: 16),
            ),
      suffixIconConstraints: const BoxConstraints.tightFor(width: 36, height: 36),
      filled: true,
      fillColor: Colors.white,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(11),
        borderSide: const BorderSide(color: Color(0xffdfe0d8)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(11),
        borderSide: const BorderSide(color: Color(0xffdfe0d8)),
      ),
    ),
    onChanged: (value) => setState(() => _query = value),
  );

  Widget _headerIcon({
    required Key key,
    required String tooltip,
    required IconData icon,
    required VoidCallback onPressed,
    Color? tint,
  }) => IconButton(
    key: key,
    tooltip: tooltip,
    onPressed: onPressed,
    padding: EdgeInsets.zero,
    visualDensity: VisualDensity.compact,
    constraints: const BoxConstraints.tightFor(width: 36, height: 36),
    icon: Icon(icon, size: 19, color: tint),
  );

  // ---- 会话列表 ----

  Widget _threadList(List<Map<String, dynamic>> threads) {
    final searching = _query.trim().isNotEmpty;
    final filtering = searching || _project != null;
    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
      children: [
        if (_project != null)
          ListTile(
            dense: true,
            leading: const Icon(Icons.arrow_back, size: 18),
            title: Text(_projectName(_project!), maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(_project!, maxLines: 1, overflow: TextOverflow.ellipsis),
            onTap: () => setState(() => _project = null),
          )
        else if (!searching)
          const _DrawerLabel('最近会话'),
        if (threads.isEmpty) _emptyHint(filtering ? '没有匹配的会话' : '还没有会话，点上面新建一个'),
        for (final thread in threads) _threadTile(thread),
      ],
    );
  }

  Widget _emptyHint(String text) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 26),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: const TextStyle(fontSize: 12, height: 1.5, color: Color(0xff85867e)),
    ),
  );

  Widget _threadTile(Map<String, dynamic> thread) {
    final id = _id(thread);
    final selected = id == widget.state.threadId;
    final searching = _query.trim().isNotEmpty;
    final cwd = _cwd(thread);
    final radius = BorderRadius.circular(9);
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Dismissible(
        key: ValueKey('thread-swipe-$id'),
        background: _swipeAction(
          Icons.edit_outlined,
          '重命名',
          const Color(0xffe2e5dc),
          const Color(0xff3d4a3f),
          Alignment.centerLeft,
        ),
        secondaryBackground: _swipeAction(
          Icons.delete_outline,
          '删除',
          const Color(0xfff2ddd8),
          const Color(0xff8a3c2f),
          Alignment.centerRight,
        ),
        // 滑动只是发起入口：重命名/删除仍走原有弹窗，条目等 state 刷新后再变。
        confirmDismiss: (direction) async {
          if (direction == DismissDirection.startToEnd) {
            await _renameThread(thread);
          } else {
            await _confirmDelete(thread);
          }
          return false;
        },
        child: Material(
          color: selected ? const Color(0xffe2e5dc) : Colors.transparent,
          borderRadius: radius,
          child: InkWell(
            borderRadius: radius,
            onTap: () => widget.onOpenThread(id),
            onLongPress: () => _threadMenu(context, thread),
            child: SizedBox(
              height: 64,
              child: Row(
                children: [
                  const SizedBox(width: 12),
                  Icon(selected ? Icons.chat_bubble : Icons.chat_bubble_outline, size: 17),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _title(thread),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13.5,
                            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                            color: const Color(0xff2f322c),
                          ),
                        ),
                        // 目录一直在，搜索时再补一行 ID 前 8 位，方便按 ID 认会话。
                        if (cwd.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(
                              cwd,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 11, color: Color(0xff7a7b73)),
                            ),
                          ),
                        if (searching && id.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 1),
                            child: Text(
                              _shortId(id),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 10, color: Color(0xff9a9b92), letterSpacing: 0.2),
                            ),
                          ),
                      ],
                    ),
                  ),
                  PopupMenuButton<String>(
                    key: Key('thread-menu-$id'),
                    tooltip: '会话操作',
                    icon: const Icon(Icons.more_horiz, size: 17),
                    padding: EdgeInsets.zero,
                    onSelected: (action) {
                      switch (action) {
                        case 'rename':
                          _renameThread(thread);
                        case 'archive':
                          _runAction(() => widget.state.archiveThread(id), '已归档会话');
                        case 'delete':
                          _confirmDelete(thread);
                      }
                    },
                    itemBuilder: (_) => const [
                      PopupMenuItem(value: 'rename', child: Text('重命名')),
                      PopupMenuItem(value: 'archive', child: Text('归档')),
                      PopupMenuItem(value: 'delete', child: Text('删除')),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _swipeAction(IconData icon, String label, Color background, Color foreground, Alignment alignment) {
    return Container(
      alignment: alignment,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(9)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: foreground),
          const SizedBox(width: 5),
          Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: foreground)),
        ],
      ),
    );
  }

  Future<void> _threadMenu(BuildContext context, Map<String, dynamic> thread) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('重命名'),
              onTap: () => Navigator.pop(ctx, 'rename'),
            ),
            ListTile(
              leading: const Icon(Icons.archive_outlined),
              title: const Text('归档'),
              onTap: () => Navigator.pop(ctx, 'archive'),
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: const Text('删除'),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
          ],
        ),
      ),
    );
    if (action == null || !mounted) return;
    switch (action) {
      case 'rename':
        await _renameThread(thread);
      case 'archive':
        await _runAction(() => widget.state.archiveThread(_id(thread)), '已归档会话');
      case 'delete':
        await _confirmDelete(thread);
    }
  }

  Future<void> _renameThread(Map<String, dynamic> thread) async {
    final controller = TextEditingController(text: _title(thread));
    final value = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('重命名会话'),
        content: TextField(
          key: const Key('rename-thread-input'),
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: '会话标题'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('保存')),
        ],
      ),
    );
    if (value == null || !mounted) return;
    await _runAction(() => widget.state.renameThread(_id(thread), value), '已重命名会话');
  }

  Future<void> _confirmDelete(Map<String, dynamic> thread) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('删除会话'),
        content: Text('「${_title(thread)}」会从会话列表里删除，无法恢复。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('删除')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await _runAction(() => widget.state.deleteThread(_id(thread)), '已删除会话');
  }

  /// 失败原因照桥的原话显示，不静默吞掉。
  Future<void> _runAction(Future<void> Function() action, String done) async {
    try {
      await action();
      if (mounted) _toast(done);
    } catch (error) {
      if (mounted) _toast(error.toString().replaceFirst('Exception: ', ''));
    }
  }

  void _toast(String message) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message)));

  Widget _projectList() {
    final projects = _projects.entries.toList();
    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 2, 8, 12),
      children: [
        const _DrawerLabel('项目'),
        if (projects.isEmpty) _emptyHint('会话按工作区归档后，会显示在这里。'),
        for (final entry in projects)
          ListTile(
            dense: true,
            leading: const Icon(Icons.folder_outlined, size: 19),
            title: Text(_projectName(entry.key), maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(entry.key, maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: Text('${entry.value.length}'),
            onTap: () => setState(() => _project = entry.key),
          ),
      ],
    );
  }

  static String _id(Map<String, dynamic> thread) => (thread['id'] ?? thread['threadId'] ?? '').toString();
  static String _cwd(Map<String, dynamic> thread) => (thread['cwd'] ?? '').toString();
  static String _title(Map<String, dynamic> thread) => (thread['title'] ?? thread['name'] ?? _id(thread)).toString();
  static String _preview(Map<String, dynamic> thread) => (thread['preview'] ?? '').toString();
  /// 列表里只露 ID 前 8 位：够认人，也不至于把一行撑爆。
  static String _shortId(String id) => id.length <= 8 ? id : id.substring(0, 8);
  static String _projectName(String cwd) {
    final parts = cwd.split(RegExp(r'[\\/]')).where((part) => part.isNotEmpty).toList();
    return parts.isEmpty ? cwd : parts.last;
  }
}

/// 设置与工具抽屉：运行时状态 + 二级页入口 + 工作区 + 版本号。
/// 会话列表不在这里——那是 [CodexHistoryPanel] 的事。
class CodexToolsPanel extends StatelessWidget {
  const CodexToolsPanel({
    super.key,
    required this.currentCwd,
    required this.connected,
    required this.onReconnect,
    required this.onChooseFolder,
    required this.onOpenSettings,
    this.onOpenTerminal,
    this.onOpenCapabilities,
    this.onOpenAbout,
    this.runtimeTile,
  });

  final String currentCwd;
  final bool connected;
  final VoidCallback onReconnect;
  final Future<void> Function() onChooseFolder;
  final VoidCallback onOpenSettings;
  final VoidCallback? onOpenTerminal;
  final VoidCallback? onOpenCapabilities;
  final VoidCallback? onOpenAbout;

  /// 运行时状态条由宿主注入（它要读 runtime 的实时状态），面板本身不碰 runtime。
  final Widget? runtimeTile;

  @override
  Widget build(BuildContext context) => Material(
    color: const Color(0xfff1f2ed),
    child: SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(context),
          ?runtimeTile,
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(6, 2, 6, 8),
              children: [
                _entry(Icons.terminal, '终端', onOpenTerminal, key: const Key('drawer-terminal')),
                _entry(Icons.widgets_outlined, '能力', onOpenCapabilities, key: const Key('drawer-capabilities')),
                _entry(Icons.settings_outlined, '设置', onOpenSettings, key: const Key('drawer-settings')),
                _entry(Icons.menu_book_outlined, '关于与使用手册', onOpenAbout, key: const Key('drawer-about')),
                ListTile(
                  key: const Key('drawer-workspace'),
                  dense: true,
                  visualDensity: VisualDensity.compact,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
                  leading: const Icon(Icons.folder_open_outlined, size: 19),
                  title: Text(
                    currentCwd.isEmpty ? '选择工作区' : currentCwd,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12.5),
                  ),
                  onTap: onChooseFolder,
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
            child: Text(
              '$kBrandName $kAppVersion',
              style: const TextStyle(fontSize: 10.5, color: Color(0xff85867e)),
            ),
          ),
        ],
      ),
    ),
  );

  Widget _header(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(14, 10, 4, 4),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            // 连接状态点：点一下重连，不用再翻设置。
            IconButton(
              key: const Key('drawer-connection'),
              tooltip: connected ? '已连接 · 点击重连' : '未连接 · 点击重连',
              onPressed: onReconnect,
              padding: EdgeInsets.zero,
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints.tightFor(width: 28, height: 28),
              icon: Icon(Icons.circle, size: 10, color: connected ? const Color(0xff36845d) : const Color(0xffa0a198)),
            ),
            const SizedBox(width: 4),
            const Expanded(
              child: Text(
                '设置与工具',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
            ),
            IconButton(
              key: const Key('drawer-close'),
              tooltip: '收起抽屉',
              onPressed: () => Scaffold.maybeOf(context)?.closeDrawer(),
              padding: EdgeInsets.zero,
              visualDensity: VisualDensity.compact,
              constraints: const BoxConstraints.tightFor(width: 36, height: 36),
              icon: const Icon(Icons.arrow_back, size: 19),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(left: 32, bottom: 2),
          child: Text(
            kBrandTagline,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 10.5, color: Color(0xff7a7b73)),
          ),
        ),
      ],
    ),
  );

  Widget _entry(IconData icon, String label, VoidCallback? onTap, {Key? key}) => ListTile(
    key: key,
    dense: true,
    visualDensity: VisualDensity.compact,
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
    leading: Icon(icon, size: 19),
    title: Text(label, style: const TextStyle(fontSize: 13)),
    trailing: const Icon(Icons.chevron_right, size: 17),
    onTap: onTap,
  );
}

class _DrawerLabel extends StatelessWidget {
  const _DrawerLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
    child: Text(
      text,
      style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Color(0xff74766c)),
    ),
  );
}
