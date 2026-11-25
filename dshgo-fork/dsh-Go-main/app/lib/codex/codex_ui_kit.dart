import 'package:flutter/material.dart';

import 'codex_theme.dart';

class CodexSection extends StatelessWidget {
  const CodexSection({super.key, required this.title, required this.children, this.description});
  final String title;
  final String? description;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
          child: Text(
            title,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Color(0xff6d6f65)),
          ),
        ),
        if (description != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
            child: Text(description!, style: const TextStyle(fontSize: 11.5, height: 1.45, color: Color(0xff85877d))),
          ),
        Material(
          color: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(13),
            side: const BorderSide(color: Color(0xffe5e6de)),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(children: children),
        ),
      ],
    ),
  );
}

class CodexSettingTile extends StatelessWidget {
  const CodexSettingTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    this.onTap,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => ListTile(
    onTap: onTap,
    leading: Icon(icon, size: 21, color: const Color(0xff4c5145)),
    title: Text(title, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
    subtitle: Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5)),
    trailing: trailing ?? (onTap == null ? null : const Icon(Icons.chevron_right, size: 19)),
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 3),
  );
}

class CodexSubpage extends StatelessWidget {
  const CodexSubpage({super.key, required this.title, required this.children, this.actions});
  final String title;
  final List<Widget> children;
  final List<Widget>? actions;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: const Color(0xfff8f8f4),
    appBar: AppBar(
      title: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      backgroundColor: const Color(0xfff8f8f4),
      surfaceTintColor: Colors.transparent,
      actions: actions,
    ),
    body: SafeArea(
      top: false,
      child: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: children),
    ),
  );
}

class CodexEmptyState extends StatelessWidget {
  const CodexEmptyState({super.key, required this.icon, required this.title, required this.message, this.action});
  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
    child: SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 36, color: const Color(0xff96988d)),
          const SizedBox(height: 12),
          Text(
            title,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            message,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12, height: 1.55, color: Color(0xff7c7e74)),
          ),
          if (action != null) ...[const SizedBox(height: 14), action!],
        ],
      ),
    ),
  );
}

class CodexStatusBadge extends StatelessWidget {
  const CodexStatusBadge({super.key, required this.label, this.positive = false, this.warning = false});
  final String label;
  final bool positive;
  final bool warning;

  @override
  Widget build(BuildContext context) {
    final color = positive
        ? const Color(0xff376c48)
        : warning
        ? const Color(0xff8a6d1f)
        : const Color(0xff777970);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.09), borderRadius: BorderRadius.circular(20)),
      child: Text(
        label,
        style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: color),
      ),
    );
  }
}

void showCodexMessage(BuildContext context, String message) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

InputDecoration codexFieldDecoration(String label, {String? hint}) => InputDecoration(
  labelText: label,
  hintText: hint,
  filled: true,
  fillColor: Colors.white,
  border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
  enabledBorder: OutlineInputBorder(
    borderRadius: BorderRadius.circular(10),
    borderSide: const BorderSide(color: Color(0xffdfe0d8)),
  ),
);

/// Shared page transition used by settings and capability detail pages.
Route<void> codexPageRoute(Widget page) => MaterialPageRoute<void>(builder: (_) => page);

ThemeData codexMaterialTheme(CodexTheme theme) => ThemeData(
  useMaterial3: true,
  brightness: theme.ink.computeLuminance() > 0.5 ? Brightness.dark : Brightness.light,
  scaffoldBackgroundColor: theme.background,
  colorScheme: ColorScheme.fromSeed(
    seedColor: theme.accent,
    brightness: theme.ink.computeLuminance() > 0.5 ? Brightness.dark : Brightness.light,
    surface: theme.surface,
  ),
  fontFamily: 'Roboto',
);
