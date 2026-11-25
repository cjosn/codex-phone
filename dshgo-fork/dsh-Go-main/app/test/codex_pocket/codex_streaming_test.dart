import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/codex/codex_device.dart';
import 'package:dsh_app/codex/codex_pocket_app.dart';
import 'package:dsh_app/codex/codex_pocket_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({CodexPermissionsIntro.seenKey: true}));

  for (final type in ['text.delta', 'reasoning.delta', 'tool.output', 'item.delta']) {
    test('continuous $type on one item stays live beyond 20 seconds', () {
      final state = _state();
      final progress = CodexStreamProgress();
      final start = DateTime(2026, 11, 25);
      state.acceptEvent({'type': 'turn.start', 'turnId': 'new'});
      progress.begin(state, start);
      state.acceptEvent({'type': 'text.delta', 'itemId': 'answer', 'text': 'answer'});
      if (type == 'item.delta') {
        state.acceptEvent({'type': 'item.start', 'itemType': 'mcpToolCall', 'itemId': 'one'});
      }
      progress.observe(state, start);
      var count = -1;
      for (var seconds = 5; seconds <= 45; seconds += 5) {
        state.acceptEvent({
          'type': type,
          'itemId': 'one',
          'itemType': 'mcpToolCall',
          if (type == 'tool.output') 'chunk': 'x' else if (type == 'item.delta') 'delta': 'x' else 'text': 'x',
        });
        if (count == -1) count = state.events.length;
        expect(state.events.length, count, reason: 'later fragments update the same row');
        final now = start.add(Duration(seconds: seconds));
        expect(progress.observe(state, now), isTrue);
        expect(progress.shouldCollapse(state, now), isFalse);
      }
      expect(progress.shouldCollapse(state, start.add(const Duration(seconds: 66))), isTrue);
      state.dispose();
    });
  }

  test('old round answers and heartbeat events cannot complete a new round', () {
    final state = _state();
    final progress = CodexStreamProgress();
    final now = DateTime(2026, 11, 25);
    state.acceptEvent({'type': 'text.delta', 'turnId': 'old', 'itemId': 'answer', 'text': 'old answer'});
    state.acceptEvent({'type': 'turn.end', 'turnId': 'old'});
    state.acceptEvent({'type': 'turn.start', 'turnId': 'new'});
    progress.begin(state, now);
    state.acceptEvent({'type': 'reasoning.delta', 'itemId': 'reason', 'text': 'still thinking'});
    progress.observe(state, now);
    state.acceptEvent({
      'type': 'usage',
      'usage': {'tokens': 1},
    });
    expect(progress.observe(state, now.add(const Duration(seconds: 25))), isFalse);
    expect(progress.shouldCollapse(state, now.add(const Duration(seconds: 60))), isFalse);
    state.acceptEvent({'type': 'text.delta', 'itemId': 'answer', 'text': 'new answer'});
    progress.observe(state, now.add(const Duration(seconds: 61)));
    expect(state.events.last.payload, 'new answer');
    expect(state.events.last.turnId, 'new');
    expect(progress.shouldCollapse(state, now.add(const Duration(seconds: 82))), isTrue);
    state.dispose();
  });

  test('answer quiet threshold is 1.5 seconds and resets only on answer fragments', () {
    final state = _state();
    final progress = CodexStreamProgress();
    final start = DateTime(2026, 11, 25);
    progress.begin(state, start);
    state.acceptEvent({'type': 'reasoning.delta', 'itemId': 'r', 'text': 'thinking'});
    progress.observe(state, start.add(const Duration(seconds: 1)));
    expect(progress.answerQuiet(start.add(const Duration(milliseconds: 1499))), isFalse);
    expect(progress.activityLabel(state.events, start.add(const Duration(milliseconds: 1499))), 'Codex 正在工作');
    expect(progress.answerQuiet(start.add(const Duration(milliseconds: 1500))), isTrue);
    expect(progress.activityLabel(state.events, start.add(const Duration(milliseconds: 1500))), '正在思考');
    state.acceptEvent({'type': 'tool.start', 'itemId': 'tool', 'name': 'read'});
    expect(progress.activityLabel(state.events, start.add(const Duration(milliseconds: 1500))), '正在调用 read');
    state.acceptEvent({'type': 'tool.end', 'itemId': 'tool'});
    expect(progress.activityLabel(state.events, start.add(const Duration(milliseconds: 1500))), 'Codex 正在工作');
    state.acceptEvent({'type': 'text.delta', 'itemId': 'a', 'text': 'answer'});
    progress.observe(state, start.add(const Duration(seconds: 2)));
    expect(progress.answerQuiet(start.add(const Duration(seconds: 3))), isFalse);
    state.dispose();
  });

  test('interleaved same-item deltas retain order and tool arguments retain terminal status', () {
    final state = _state();
    state.acceptEvent({'type': 'turn.start', 'turnId': 'one'});
    for (final event in [
      {'type': 'reasoning.delta', 'itemId': 'r', 'text': 'think first'},
      {'type': 'text.delta', 'itemId': 'a', 'text': 'answer first'},
      {'type': 'tool.args.delta', 'itemId': 'tool', 'delta': '{"path":'},
      {'type': 'tool.start', 'itemId': 'tool', 'name': 'file_read'},
      {'type': 'reasoning.delta', 'itemId': 'r', 'text': 'think later'},
      {'type': 'tool.args.delta', 'itemId': 'tool', 'delta': '"a.txt"}'},
      {'type': 'tool.output', 'itemId': 'tool', 'chunk': 'partial'},
      {'type': 'text.delta', 'itemId': 'a', 'text': 'answer later'},
      {'type': 'tool.output', 'itemId': 'tool', 'chunk': 'complete', 'replace': true},
      {'type': 'tool.end', 'itemId': 'tool', 'status': 'failed', 'exitCode': 7},
      {'type': 'tool.args.delta', 'itemId': 'tool', 'delta': '\n'},
    ]) {
      state.acceptEvent(event);
    }
    expect(state.events.map((e) => e.payload), [
      'think first',
      'answer first',
      'complete',
      'think later',
      'answer later',
    ]);
    final tool = state.events[2];
    expect(tool.arguments, '{"path":"a.txt"}\n');
    expect(tool.name, 'file_read');
    expect(tool.status, 'failed');
    expect(tool.exitCode, 7);
    state.acceptEvent({'type': 'turn.start', 'turnId': 'two'});
    state.acceptEvent({'type': 'tool.args.delta', 'itemId': 'tool', 'delta': 'new'});
    expect(state.events.last.arguments, 'new');
    expect(state.events[2].arguments, '{"path":"a.txt"}\n');
    state.dispose();
  });

  test('long timelines do not discard early events at the former 800-row cap', () {
    final state = _state();
    for (var i = 0; i < 850; i++) {
      state.acceptEvent({'type': i.isEven ? 'reasoning.delta' : 'text.delta', 'itemId': '$i', 'text': 'line $i'});
    }
    expect(state.events, hasLength(850));
    expect(state.events.first.payload, 'line 0');
    state.dispose();
  });

  testWidgets('interleaved timeline keeps body order and shares the user fold choice', (tester) async {
    final stream = await _mount(tester);
    for (final event in [
      {'type': 'turn.start', 'turnId': 'new'},
      {'type': 'reasoning.delta', 'itemId': 'r', 'text': 'think first'},
      {'type': 'text.delta', 'itemId': 'a', 'text': 'answer first'},
      {'type': 'reasoning.delta', 'itemId': 'r', 'text': 'think later'},
      {'type': 'text.delta', 'itemId': 'a', 'text': 'answer later'},
    ]) {
      stream.add(event);
    }
    await tester.pump(const Duration(milliseconds: 30));
    expect(
      tester.getTopLeft(find.byKey(const Key('reasoning-body-0'))).dy,
      lessThan(tester.getTopLeft(_body('answer first')).dy),
    );
    expect(
      tester.getTopLeft(_body('answer first')).dy,
      lessThan(tester.getTopLeft(find.byKey(const Key('reasoning-body-2'))).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('reasoning-body-2'))).dy,
      lessThan(tester.getTopLeft(_body('answer later')).dy),
    );
    expect(find.byKey(const Key('live-reasoning-label')), findsOneWidget);
    await tester.tap(find.byKey(const Key('reasoning-toggle-0')));
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.byKey(const Key('reasoning-body-0')), findsNothing);
    expect(find.byKey(const Key('reasoning-body-2')), findsNothing);
    stream.add({'type': 'reasoning.delta', 'itemId': 'r', 'text': 'more thinking'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.text('more thinking'), findsNothing);
    expect(_body('answer first'), findsOneWidget);
    stream.add({'type': 'turn.end'});
    await tester.pumpAndSettle();
    expect(find.text('more thinking'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('live viewport follows tail, bounds height and preserves all earlier lines', (tester) async {
    final stream = await _mount(tester);
    stream.add({'type': 'turn.start', 'turnId': 'new'});
    stream.add({'type': 'reasoning.delta', 'itemId': 'r', 'text': List.generate(40, (i) => 'line $i').join('\n')});
    await tester.pump(const Duration(milliseconds: 30));
    await tester.pump();
    final viewport = find.byKey(const ValueKey('timeline:turn:new:0'));
    expect(tester.getSize(viewport).height, lessThanOrEqualTo(kCodexLiveTimelineLines * 20));
    final scrollable = find.descendant(of: viewport, matching: find.byType(Scrollable));
    final position = tester.state<ScrollableState>(scrollable).position;
    expect(position.pixels, position.maxScrollExtent);
    expect(tester.widget<Text>(find.byKey(const Key('reasoning-body-0'))).data, contains('line 0\n'));
    stream.add({'type': 'reasoning.delta', 'itemId': 'r', 'text': '\nlast line'});
    await tester.pump(const Duration(milliseconds: 30));
    await tester.pump();
    expect(position.pixels, position.maxScrollExtent);
    await tester.drag(scrollable, const Offset(0, 160));
    await tester.pump(const Duration(milliseconds: 30));
    final held = position.pixels;
    stream.add({'type': 'reasoning.delta', 'itemId': 'r', 'text': '\nnew last line'});
    await tester.pump(const Duration(milliseconds: 30));
    await tester.pump();
    expect(position.pixels, held, reason: 'reading earlier lines pauses tail following');
    stream.add({'type': 'turn.end'});
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('reasoning-toggle-0')));
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.byKey(const Key('reasoning-body-0'))).data, contains('new last line'));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('tool card consumes growing arguments without losing output or user expansion', (tester) async {
    final stream = await _mount(tester);
    stream.add({'type': 'turn.start', 'turnId': 'new'});
    stream.add({'type': 'tool.args.delta', 'itemId': 't', 'name': 'read', 'delta': '{"path":'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.text('{"path":'), findsOneWidget);
    await tester.tap(find.byKey(const Key('tool-toggle-0')));
    stream.add({'type': 'tool.args.delta', 'itemId': 't', 'delta': '"a"}'});
    stream.add({'type': 'tool.output', 'itemId': 't', 'chunk': 'output'});
    stream.add({'type': 'tool.end', 'itemId': 't', 'status': 'completed'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.text('{"path":"a"}'), findsOneWidget);
    expect(find.text('output'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);
    stream.add({'type': 'turn.end'});
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('reasoning-toggle-0')));
    await tester.pumpAndSettle();
    expect(find.text('output'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('paired step and tool events show one step with growing arguments and full output', (tester) async {
    final stream = await _mount(tester);
    stream.add({'type': 'turn.start', 'turnId': 'new'});
    stream.add({'type': 'item.start', 'itemId': 't', 'itemType': 'mcpToolCall', 'name': 'file_read'});
    stream.add({'type': 'tool.start', 'itemId': 't', 'name': 'file_read', 'args': '{"path":'});
    stream.add({'type': 'tool.args.delta', 'itemId': 't', 'delta': '"a"}'});
    final output = List.generate(12, (i) => 'output $i').join('\n');
    stream.add({'type': 'tool.output', 'itemId': 't', 'chunk': output});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.text('{"path":"a"}'), findsOneWidget);
    expect(find.byKey(const Key('tool-toggle-1')), findsNothing);
    await tester.tap(find.byKey(const Key('step-t')));
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.text(output), findsOneWidget, reason: 'step output is not truncated at eight lines');
    stream.add({'type': 'item.end', 'itemId': 't', 'itemType': 'mcpToolCall', 'status': 'completed'});
    stream.add({'type': 'tool.end', 'itemId': 't'});
    stream.add({'type': 'turn.end'});
    await tester.pumpAndSettle();
    expect(find.textContaining('执行 1 步'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('conversation follows new process at the tail but leaves a reader in history', (tester) async {
    final stream = await _mount(tester);
    stream.add({'type': 'turn.start', 'turnId': 'new'});
    stream.add({'type': 'text.delta', 'itemId': 'a', 'text': List.generate(100, (i) => 'answer $i\n\n').join()});
    await tester.pump(const Duration(milliseconds: 30));
    await tester.pump();
    final list = tester.widget<ListView>(find.byType(ListView));
    final controller = list.controller!;
    expect(controller.position.pixels, controller.position.maxScrollExtent);
    stream.add({'type': 'reasoning.delta', 'itemId': 'r', 'text': 'new process'});
    await tester.pump(const Duration(milliseconds: 30));
    await tester.pump();
    expect(controller.position.pixels, controller.position.maxScrollExtent);
    controller.jumpTo(controller.position.maxScrollExtent - 300);
    final held = controller.position.pixels;
    stream.add({'type': 'text.delta', 'itemId': 'a', 'text': 'new answer'});
    await tester.pump(const Duration(milliseconds: 30));
    await tester.pump();
    expect(controller.position.pixels, held);
    stream.add({'type': 'turn.end'});
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('new round waiting indicator stays after the old answer', (tester) async {
    final stream = await _mount(tester);
    stream.add({'type': 'text.delta', 'turnId': 'old', 'itemId': 'old', 'text': 'old answer'});
    await tester.pumpAndSettle();
    stream.add({'type': 'turn.start', 'turnId': 'new'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(
      tester.getTopLeft(find.byKey(const Key('live-thinking-card'))).dy,
      greaterThan(tester.getTopLeft(_body('old answer')).dy),
    );
    stream.add({'type': 'turn.end'});
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
  });
}

CodexPocketState _state() =>
    CodexPocketState(CodexBridgeClient(client: MockClient((_) async => http.Response('{}', 200))));

Finder _body(String text) =>
    find.byWidgetPredicate((widget) => widget is RichText && widget.text.toPlainText().contains(text));

Future<StreamController<Map<String, dynamic>>> _mount(WidgetTester tester) async {
  tester.view.physicalSize = const Size(900, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  final events = StreamController<Map<String, dynamic>>.broadcast();
  addTearDown(events.close);
  final client = CodexBridgeClient(
    eventSource: (_) => events.stream,
    client: MockClient(
      (request) async => http.Response(
        jsonEncode(switch (request.url.path) {
          '/healthz' => {'ok': true, 'engine': 'codex'},
          '/api/thread/list' => {'threads': []},
          '/api/config' => {'model': 'gpt-test'},
          '/api/models' => {'models': []},
          '/api/account' => {'account': null},
          _ => <String, dynamic>{},
        }),
        200,
      ),
    ),
  );
  await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
  await tester.pumpAndSettle();
  return events;
}
