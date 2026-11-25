import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import 'codex_pocket_state.dart';

/// 真终端页：走桥的 /api/exec（codex `command/exec` + PTY），
/// 输出经 `command/exec/outputDelta` 的 base64 流回来，写进 xterm。
class CodexTerminalPage extends StatefulWidget {
  const CodexTerminalPage({super.key, required this.state, this.embedded = false});

  final CodexPocketState state;
  final bool embedded;

  @override
  State<CodexTerminalPage> createState() => _CodexTerminalPageState();
}

class _CodexTerminalPageState extends State<CodexTerminalPage> {
  final Terminal terminal = Terminal(maxLines: 8000);
  StreamSubscription<String>? _sub;
  bool _starting = true;
  String? _error;
  int _rows = 30;
  int _cols = 90;

  @override
  void initState() {
    super.initState();
    terminal.onOutput = (data) => widget.state.shellInput(data);
    terminal.onResize = (width, height, pixelWidth, pixelHeight) {
      _cols = width;
      _rows = height;
      widget.state.shellResize(width, height);
    };
    _sub = widget.state.terminalOut.listen((chunk) {
      if (chunk.isEmpty) return;
      terminal.write(chunk);
    }, onError: (Object e) => setState(() => _error = e.toString()));
    _start();
  }

  Future<void> _start() async {
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      await widget.state.startShell(rows: _rows, cols: _cols);
      terminal.write('\x1b[2J\x1b[H');
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    widget.state.stopShell();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final body = SafeArea(
      child: Column(
        children: [
          if (_error != null)
            Container(
              width: double.infinity,
              color: const Color(0xff4a2320),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Text(_error!, style: const TextStyle(color: Color(0xffffb4ab), fontSize: 12)),
            ),
          if (_starting)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 6),
              child: Text('正在启动 shell…', style: TextStyle(color: Colors.white38, fontSize: 12)),
            ),
          Expanded(
            child: TerminalView(
              terminal,
              autofocus: true,
              theme: codexTerminalTheme,
              textStyle: const TerminalStyle(fontFamily: 'JetBrainsMono', fontSize: 12.5),
            ),
          ),
          Container(
            height: 44,
            decoration: const BoxDecoration(
              color: Color(0xff232420),
              border: Border(top: BorderSide(color: Color(0xff31322d))),
            ),
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              children: [
                for (final command in const [
                  'ls -la',
                  'pwd',
                  'cd /root/workspace && ls',
                  'codex --version',
                  'node --version',
                  'cat /root/.codex/config.toml',
                ])
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        foregroundColor: const Color(0xffc8c9c1),
                        side: const BorderSide(color: Color(0xff3d3e38)),
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        visualDensity: VisualDensity.compact,
                      ),
                      onPressed: () => widget.state.shellInput('$command\r'),
                      child: Text(command, style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 11)),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
    if (widget.embedded) {
      return ColoredBox(
        color: const Color(0xff1c1d1a),
        child: Column(
          children: [
            SizedBox(
              height: 42,
              child: Row(
                children: [
                  const SizedBox(width: 16),
                  const Expanded(
                    child: Text(
                      '/bin/bash · PTY',
                      style: TextStyle(color: Colors.white70, fontFamily: 'JetBrainsMono', fontSize: 12),
                    ),
                  ),
                  IconButton(
                    tooltip: '清屏',
                    color: Colors.white70,
                    onPressed: () => terminal.write('\x1b[2J\x1b[H'),
                    icon: const Icon(Icons.cleaning_services_outlined, size: 18),
                  ),
                  IconButton(
                    tooltip: '重连 shell',
                    color: Colors.white70,
                    onPressed: _start,
                    icon: const Icon(Icons.refresh, size: 18),
                  ),
                ],
              ),
            ),
            Expanded(child: body),
          ],
        ),
      );
    }
    return Scaffold(
      backgroundColor: const Color(0xff1c1d1a),
      appBar: AppBar(
        backgroundColor: const Color(0xff232420),
        foregroundColor: Colors.white70,
        title: const Text('终端 · /bin/bash'),
        actions: [
          IconButton(
            tooltip: '清屏',
            onPressed: () => terminal.write('\x1b[2J\x1b[H'),
            icon: const Icon(Icons.cleaning_services_outlined),
          ),
          IconButton(tooltip: '重连 shell', onPressed: _start, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: body,
    );
  }
}

/// 让 xterm 的中文/宽字符不至于全糊在一块：终端主题偏 Codex 的深色。
final codexTerminalTheme = TerminalTheme(
  cursor: const Color(0xffe8e8e2),
  selection: const Color(0x40ffffff),
  foreground: const Color(0xffe6e6df),
  background: const Color(0xff1c1d1a),
  black: const Color(0xff1c1d1a),
  red: const Color(0xffe0857e),
  green: const Color(0xff9ecf9a),
  yellow: const Color(0xffdfcf8f),
  blue: const Color(0xff8fb6d9),
  magenta: const Color(0xffc7a3d9),
  cyan: const Color(0xff8fd3d0),
  white: const Color(0xffe6e6df),
  brightBlack: const Color(0xff6f7069),
  brightRed: const Color(0xfff2a49d),
  brightGreen: const Color(0xffb9e6b4),
  brightYellow: const Color(0xfff0e2a8),
  brightBlue: const Color(0xffa9cbe8),
  brightMagenta: const Color(0xffdcbdec),
  brightCyan: const Color(0xffa9e8e5),
  brightWhite: const Color(0xfffffff8),
  searchHitBackground: const Color(0x66dfcf8f),
  searchHitBackgroundCurrent: const Color(0xaa8a6d1f),
  searchHitForeground: const Color(0xff1c1d1a),
);

String decodeBase64Utf8(String value) {
  try {
    return utf8.decode(base64Decode(value), allowMalformed: true);
  } catch (_) {
    return '';
  }
}
