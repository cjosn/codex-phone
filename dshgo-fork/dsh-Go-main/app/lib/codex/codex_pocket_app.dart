import 'package:flutter/material.dart';

import 'codex_brand.dart';
import 'codex_pocket_state.dart';
import 'codex_pocket_ui.dart';

export 'codex_pocket_state.dart' show CodexBridgeClient, CodexPocketState;

class CodexPocketApp extends StatelessWidget {
  const CodexPocketApp({super.key, this.client, this.runtime, this.enableRuntime, this.fixtureEvents});

  final CodexBridgeClient? client;
  final CodexRuntimeApi? runtime;
  final bool? enableRuntime;
  final List<PocketEvent>? fixtureEvents;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: kBrandName,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.light,
        scaffoldBackgroundColor: const Color(0xfff8f8f4),
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff292a27),
          brightness: Brightness.light,
          surface: const Color(0xfff8f8f4),
        ),
        textTheme: ThemeData(brightness: Brightness.light, fontFamily: 'Roboto').textTheme,
        primaryTextTheme: ThemeData(brightness: Brightness.light, fontFamily: 'Roboto').primaryTextTheme,
        useMaterial3: true,
        fontFamily: 'Roboto',
      ),
      home: CodexPocketHome(
        client: client ?? CodexBridgeClient(),
        runtime: runtime,
        enableRuntime: enableRuntime,
        fixtureEvents: fixtureEvents,
      ),
    );
  }
}
