import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 主题预设：一层背景 + 卡片色 + 主色，够用且不改 Material 结构。
class CodexTheme {
  const CodexTheme({
    required this.id,
    required this.name,
    required this.background,
    required this.surface,
    required this.border,
    required this.ink,
    required this.muted,
    required this.accent,
    required this.onAccent,
  });

  final String id;
  final String name;
  final Color background;
  final Color surface;
  final Color border;
  final Color ink;
  final Color muted;
  final Color accent;
  final Color onAccent;

  /// 用户自选背景与强调色；卡片、边框和文字对比度由背景明暗自动推导。
  factory CodexTheme.customized({required Color background, required Color accent}) {
    final dark = background.computeLuminance() < 0.32;
    return CodexTheme(
      id: 'custom',
      name: '自定义',
      background: background,
      surface: Color.lerp(background, dark ? Colors.white : Colors.black, dark ? 0.075 : 0.025)!,
      border: Color.lerp(background, dark ? Colors.white : Colors.black, dark ? 0.17 : 0.11)!,
      ink: dark ? const Color(0xffeef0f2) : const Color(0xff242522),
      muted: dark ? const Color(0xffa2a7ad) : const Color(0xff73766e),
      accent: accent,
      onAccent: accent.computeLuminance() > 0.42 ? const Color(0xff161713) : Colors.white,
    );
  }
}

const List<CodexTheme> kCodexThemes = [
  CodexTheme(
    id: 'cream',
    name: '奶油',
    background: Color(0xfff8f8f4),
    surface: Color(0xffffffff),
    border: Color(0xffe6e6df),
    ink: Color(0xff232420),
    muted: Color(0xff8a8b82),
    accent: Color(0xff2f5d3a),
    onAccent: Colors.white,
  ),
  CodexTheme(
    id: 'frost',
    name: '霜白',
    background: Color(0xfff2f5f8),
    surface: Color(0xffffffff),
    border: Color(0xffdde4ea),
    ink: Color(0xff1f2733),
    muted: Color(0xff7c8894),
    accent: Color(0xff2f4f6f),
    onAccent: Colors.white,
  ),
  CodexTheme(
    id: 'sand',
    name: '沙砾',
    background: Color(0xfff6f1e7),
    surface: Color(0xfffffdf8),
    border: Color(0xffe6ddcc),
    ink: Color(0xff2a251d),
    muted: Color(0xff8d8577),
    accent: Color(0xff6b4f2a),
    onAccent: Colors.white,
  ),
  CodexTheme(
    id: 'ink',
    name: '墨黑',
    background: Color(0xff14161a),
    surface: Color(0xff1d2026),
    border: Color(0xff2c313a),
    ink: Color(0xffe8eaee),
    muted: Color(0xff8b93a1),
    accent: Color(0xff7fb98a),
    onAccent: Color(0xff101215),
  ),
];

CodexTheme themeById(String? id) => kCodexThemes.firstWhere((t) => t.id == id, orElse: () => kCodexThemes.first);

/// 主题与推理强度都存本地，重启后保持。
class CodexPrefs {
  static const _themeKey = 'codex.theme';
  static const _reasoningKey = 'codex.reasoning';
  static const _approvalKey = 'codex.approval';
  static const _sandboxKey = 'codex.sandboxMode';
  static const _customBackgroundKey = 'codex.theme.customBackground';
  static const _customAccentKey = 'codex.theme.customAccent';
  static const _backgroundImageKey = 'codex.theme.backgroundImage';
  static const _contextWindowKey = 'codex.contextWindow';

  static Future<String?> loadBackgroundImage() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final path = prefs.getString(_backgroundImageKey);
      return (path == null || path.isEmpty) ? null : path;
    } catch (_) {
      return null;
    }
  }

  static Future<void> saveBackgroundImage(String? path) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (path == null || path.isEmpty) {
        await prefs.remove(_backgroundImageKey);
      } else {
        await prefs.setString(_backgroundImageKey, path);
      }
    } catch (_) {}
  }

  static Future<CodexTheme> loadTheme() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final id = prefs.getString(_themeKey);
      if (id == 'custom') {
        final background = prefs.getInt(_customBackgroundKey);
        final accent = prefs.getInt(_customAccentKey);
        if (background != null && accent != null) {
          return CodexTheme.customized(background: Color(background), accent: Color(accent));
        }
      }
      return themeById(id);
    } catch (_) {
      return kCodexThemes.first;
    }
  }

  static Future<void> saveTheme(String id) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_themeKey, id);
    } catch (_) {}
  }

  static Future<void> saveCustomTheme(CodexTheme theme) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_themeKey, 'custom');
      await prefs.setInt(_customBackgroundKey, theme.background.toARGB32());
      await prefs.setInt(_customAccentKey, theme.accent.toARGB32());
    } catch (_) {}
  }

  static Future<String> loadSandboxMode() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final value = prefs.getString(_sandboxKey) ?? '';
      // '' = 不指定沙箱（沿用本机 codex 配置 = 完全权限）。
      // 老版本把 workspace-write 当默认值，而 PRoot 里没有可用的沙箱，选它必然「工具起不来」，
      // 所以除「只读」以外的一切历史值都归一到「不指定」。
      return value == 'read-only' ? 'read-only' : '';
    } catch (_) {
      return '';
    }
  }

  static Future<void> saveSandboxMode(String value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_sandboxKey, value);
    } catch (_) {}
  }

  static Future<int> loadContextWindow() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getInt(_contextWindowKey) ?? 0;
    } catch (_) {
      return 0;
    }
  }

  static Future<void> saveContextWindow(int tokens) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt(_contextWindowKey, tokens);
    } catch (_) {}
  }

  static Future<String> loadReasoning() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString(_reasoningKey) ?? 'medium';
    } catch (_) {
      return 'medium';
    }
  }

  static Future<void> saveReasoning(String value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_reasoningKey, value);
    } catch (_) {}
  }

  static Future<String> loadApproval() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_approvalKey) ?? 'on-request';
      if (saved == 'on-failure') {
        await prefs.setString(_approvalKey, 'on-request');
        return 'on-request';
      }
      return saved;
    } catch (_) {
      return 'on-request';
    }
  }

  static Future<void> saveApproval(String value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_approvalKey, value == 'on-failure' ? 'on-request' : value);
    } catch (_) {}
  }
}
