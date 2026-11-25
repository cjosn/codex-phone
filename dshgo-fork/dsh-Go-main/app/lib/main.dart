import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'codex/codex_pocket_app.dart';

// Codex Go has its own application and real Codex runtime. DSH Go's reusable
// widgets and Android runtime utilities remain in the source fork; its root
// gate, DSH account/provider state, and engine are not started here.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: Color(0xfff8f8f4),
      systemNavigationBarIconBrightness: Brightness.dark,
    ),
  );
  runApp(const CodexPocketApp());
}
