import 'dart:async';
import 'dart:io';
import 'dart:convert';

import 'package:dsh_app/codex/codex_device.dart';
import 'package:dsh_app/codex/codex_model_sheet.dart';
import 'package:dsh_app/codex/codex_brand.dart';
import 'package:dsh_app/codex/codex_pocket_app.dart';
import 'package:dsh_app/codex/codex_pocket_state.dart';
import 'package:dsh_app/codex/codex_pocket_ui.dart';
import 'package:dsh_app/codex/codex_sessions_drawer.dart';
import 'package:dsh_app/codex/codex_update.dart';
import 'package:dsh_app/codex/codex_settings.dart';
import 'package:dsh_app/codex/codex_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

void main() {
  // 每个用例都从「没有上次会话」的干净本地状态开始：上一条用供 resumeThread
  // 写进 SharedPreferences 的 codex.lastThread 不能漏到下一条。
  // 首次启动授权向导默认按「已看过」处理，否则它会盖在所有页面上）
  // 向导本身的用例自己把 codex.permissionsIntroSeen 清空。
  setUp(() => SharedPreferences.setMockInitialValues({CodexPermissionsIntro.seenKey: true}));

  test('bridge client reports actual API error messages', () async {
    final client = CodexBridgeClient(
      client: MockClient(
        (request) async => http.Response(
          jsonEncode({
            'error': {'code': 'DENIED', 'message': 'token rejected'},
          }),
          401,
        ),
      ),
    );
    expect(client.get('/healthz'), throwsA(predicate((e) => e.toString().contains('token rejected'))));
    client.close();
  });

  test('filters other threads and merges streamed text by item id', () {
    final state = CodexPocketState(CodexBridgeClient(client: MockClient((_) async => http.Response('{}', 200))))
      ..threadId = 'thread-a';
    state.acceptEvent({'seq': 1, 'type': 'text.delta', 'threadId': 'thread-b', 'itemId': 'm1', 'text': 'wrong'});
    state.acceptEvent({'seq': 2, 'type': 'text.delta', 'threadId': 'thread-a', 'itemId': 'm1', 'text': 'hel'});
    state.acceptEvent({'seq': 3, 'type': 'text.delta', 'threadId': 'thread-a', 'itemId': 'm1', 'text': 'lo'});
    expect(state.events, hasLength(1));
    expect(state.events.single.payload, 'hello');
    expect(state.seq, 3);
    state.dispose();
  });

  test('updates background turn state before filtering other threads', () {
    final state = CodexPocketState(CodexBridgeClient(client: MockClient((_) async => http.Response('{}', 200))))
      ..threadId = 'thread-b';
    state.acceptEvent({'seq': 1, 'type': 'turn.start', 'threadId': 'thread-a'});
    expect(state.busy, isFalse);
    state.acceptEvent({'seq': 2, 'type': 'turn.start', 'threadId': 'thread-b'});
    expect(state.busy, isTrue);
    state.acceptEvent({'seq': 3, 'type': 'turn.end', 'threadId': 'thread-a', 'status': 'completed'});
    expect(state.busy, isTrue);
    state.acceptEvent({
      'seq': 4,
      'type': 'turn.end',
      'threadId': 'thread-b',
      'status': 'failed',
      'error': 'compile failed',
    });
    expect(state.busy, isFalse);
    expect(state.error, contains('compile failed'));
    state.dispose();
  });

  test('merges text and reasoning separately; replaces aggregated tool output', () {
    final state = CodexPocketState(CodexBridgeClient(client: MockClient((_) async => http.Response('{}', 200))))
      ..threadId = 'thread-a';
    state.acceptEvent({'seq': 1, 'type': 'text.delta', 'threadId': 'thread-a', 'itemId': 'same', 'text': 'answer'});
    state.acceptEvent({
      'seq': 2,
      'type': 'reasoning.delta',
      'threadId': 'thread-a',
      'itemId': 'same',
      'text': 'thought',
    });
    state.acceptEvent({'seq': 3, 'type': 'tool.output', 'threadId': 'thread-a', 'itemId': 'tool1', 'chunk': 'part'});
    state.acceptEvent({
      'seq': 4,
      'type': 'tool.output',
      'threadId': 'thread-a',
      'itemId': 'tool1',
      'chunk': 'full output',
      'replace': true,
    });
    expect(state.events.map((e) => e.payload), ['answer', 'thought', 'full output']);
    state.dispose();
  });

  test('resume maps raw user/assistant messages to readable transcript rows', () async {
    final state = CodexPocketState(
      CodexBridgeClient(
        client: MockClient(
          (request) async => http.Response(
            '{"threadId":"thread-a","items":[{"type":"userMessage","id":"u1","content":[{"text":"hello"}]},{"type":"agentMessage","id":"a1","text":"world"}]}',
            200,
          ),
        ),
      ),
    );
    await state.resumeThread('thread-a');
    expect(state.events.map((e) => e.type), ['user', 'agent_message']);
    expect(state.events.map((e) => e.payload), ['hello', 'world']);
    state.dispose();
  });

  test('send uses selected cwd and restores busy state after an error', () async {
    final bodies = <String, Map<String, dynamic>>{};
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        if (request.url.path == '/api/thread/create') {
          bodies['create'] = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response('{"threadId":"thread-a"}', 200);
        }
        if (request.url.path == '/api/thread/list') return http.Response('{"threads":[]}', 200);
        if (request.url.path == '/api/turn/send') {
          bodies['send'] = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response('{"error":{"message":"send denied"}}', 403);
        }
        return http.Response('{}', 200);
      }),
    );
    final state = CodexPocketState(client);
    await state.send('hello', cwd: '/work/project');
    expect(bodies['create']?['cwd'], '/work/project');
    expect(bodies['send']?['threadId'], 'thread-a');
    expect(state.busy, isFalse);
    expect(state.error, contains('send denied'));
    state.dispose();
  });

  test('diff snapshots replace the same turn item and keep later turns separate', () async {
    final state = CodexPocketState(
      CodexBridgeClient(client: MockClient((_) async => _json({'threadId': 't1', 'items': []}))),
    );
    await state.resumeThread('t1');
    state.acceptEvent({'type': 'diff', 'threadId': 't1', 'turnId': 'turn1', 'itemId': 'file1', 'patch': 'old'});
    state.acceptEvent({
      'type': 'diff',
      'threadId': 't1',
      'turnId': 'turn1',
      'itemId': 'file1',
      'patch': 'new',
      'replace': true,
    });
    state.acceptEvent({'type': 'diff', 'threadId': 't1', 'turnId': 'turn2', 'itemId': 'file1', 'patch': 'later'});
    expect(state.events.where((event) => event.type == 'diff').map((event) => event.payload), ['new', 'later']);
    state.dispose();
  });

  test('steer sends the exact active turn id', () async {
    Map<String, dynamic>? sent;
    final state = CodexPocketState(
      CodexBridgeClient(
        client: MockClient((request) async {
          if (request.url.path == '/api/thread/resume') return _json({'threadId': 't1', 'items': []});
          if (request.url.path == '/api/turn/steer') {
            sent = jsonDecode(request.body) as Map<String, dynamic>;
            return _json({'turnId': 'turn1'});
          }
          return _json({});
        }),
      ),
    );
    await state.resumeThread('t1');
    state.acceptEvent({'type': 'turn.start', 'threadId': 't1', 'turnId': 'turn1'});
    await state.steer('keep the existing file');
    expect(sent, {'threadId': 't1', 'expectedTurnId': 'turn1', 'text': 'keep the existing file'});
    expect(state.error, isNull);
    state.dispose();
  });

  test('revert targets the message turn and reloads authoritative history', () async {
    String? beforeTurnId;
    var resumes = 0;
    final state = CodexPocketState(
      CodexBridgeClient(
        client: MockClient((request) async {
          if (request.url.path == '/api/thread/resume') {
            resumes++;
            return _json({
              'threadId': 't1',
              'items': resumes == 1
                  ? [
                      {
                        'type': 'userMessage',
                        'id': 'u1',
                        'turnId': 'turn1',
                        'content': [
                          {'text': 'first'},
                        ],
                      },
                      {'type': 'agentMessage', 'id': 'a1', 'turnId': 'turn1', 'text': 'answer'},
                    ]
                  : [],
            });
          }
          if (request.url.path == '/api/thread/revert') {
            beforeTurnId = (jsonDecode(request.body) as Map)['beforeTurnId']?.toString();
            return _json({'threadId': 't1'});
          }
          if (request.url.path == '/api/thread/list') return _json({'threads': []});
          return _json({});
        }),
      ),
    );
    await state.resumeThread('t1');
    expect(await state.revertMessage(1), isTrue);
    expect(beforeTurnId, 'turn1');
    expect(resumes, 2);
    expect(state.events, isEmpty);
    state.dispose();
  });

  test('item.start/delta/end collapse into one ordered step with the protocol duration', () async {
    final state = CodexPocketState(CodexBridgeClient(client: MockClient((_) async => _json({}))))..threadId = 't1';
    state.acceptEvent({'type': 'turn.start', 'threadId': 't1', 'turnId': 'turn1'});
    state.acceptEvent({
      'type': 'item.start',
      'threadId': 't1',
      'turnId': 'turn1',
      'itemId': 'i1',
      'itemType': 'commandExecution',
      'name': 'ls -la /root',
      'startedAtMs': 1000,
    });
    state.acceptEvent({
      'type': 'item.delta',
      'threadId': 't1',
      'turnId': 'turn1',
      'itemId': 'i1',
      'itemType': 'commandExecution',
      'field': 'output',
      'delta': 'total 4\n',
    });
    state.acceptEvent({
      'type': 'item.end',
      'threadId': 't1',
      'turnId': 'turn1',
      'itemId': 'i1',
      'itemType': 'commandExecution',
      'status': 'completed',
      'exitCode': 0,
      'durationMs': 230,
    });
    final steps = state.events.where((event) => event.type == 'step').toList();
    expect(steps, hasLength(1), reason: 'one item must produce exactly one step, not a row per event');
    expect(steps.single.payload, 'total 4\n');
    expect(steps.single.status, 'completed');
    expect(steps.single.durationMs, 230);
    expect(codexStepTitle(steps.single), '查看目录');
    state.dispose();
  });

  test('a failed step keeps its failure status so the UI never collapses it', () async {
    final state = CodexPocketState(CodexBridgeClient(client: MockClient((_) async => _json({}))))..threadId = 't1';
    state.acceptEvent({
      'type': 'item.start',
      'threadId': 't1',
      'turnId': 'turn1',
      'itemId': 'i2',
      'itemType': 'commandExecution',
      'name': 'npm test',
    });
    state.acceptEvent({
      'type': 'item.end',
      'threadId': 't1',
      'turnId': 'turn1',
      'itemId': 'i2',
      'itemType': 'commandExecution',
      'status': 'failed',
      'exitCode': 1,
      'durationMs': 1200,
    });
    final step = state.events.singleWhere((event) => event.type == 'step');
    expect(step.status, 'failed');
    expect(step.exitCode, 1);
    expect(codexStepTitle(step), '运行 npm');
    state.dispose();
  });

  testWidgets('a step renders as one human line with its duration', (tester) async {
    await tester.pumpWidget(
      CodexPocketApp(
        client: _mockClient(),
        enableRuntime: false,
        fixtureEvents: [
          PocketEvent('user', '看看目录', threadId: 't1'),
          PocketEvent(
            'step',
            'total 4\n',
            itemId: 'i1',
            itemType: 'commandExecution',
            name: 'ls -la',
            threadId: 't1',
            turnId: 'turn-1',
            status: 'completed',
            durationMs: 230,
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('reasoning-toggle-1')));
    await tester.pumpAndSettle();
    expect(find.text('查看目录'), findsOneWidget);
    expect(find.textContaining('0.23s'), findsOneWidget);
  });

  test('approvals send exact one-shot/session decisions', () async {
    final decisions = <String>[];
    final state = CodexPocketState(
      CodexBridgeClient(
        client: MockClient((request) async {
          if (request.url.path == '/api/approval')
            decisions.add((jsonDecode(request.body) as Map)['decision'].toString());
          return http.Response('{}', 200);
        }),
      ),
    );
    await state.approve('ap-1', true);
    await state.approve('ap-2', true, forSession: true);
    await state.approve('ap-3', false);
    expect(decisions, ['accept', 'acceptForSession', 'decline']);
    state.dispose();
  });

  test('workflow and MCP actions use the coordinated bridge contracts', () async {
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/workflow/list') {
          return http.Response('{"workflows":[{"id":"wf-1","name":"Release","steps":[]}]}', 200);
        }
        if (request.url.path == '/api/workflow/run') {
          return http.Response('{"id":"run-1","workflowId":"wf-1","status":"completed","steps":[]}', 200);
        }
        if (request.url.path == '/api/mcp') return http.Response('{"data":[]}', 200);
        if (request.url.path == '/api/workflow/create') {
          return http.Response('{"id":"wf-1","name":"Release","steps":[]}', 200);
        }
        return http.Response('{}', 200);
      }),
    );
    final state = CodexPocketState(client);
    await state.createWorkflow('Release', [
      {'type': 'prompt', 'text': 'check the release'},
    ]);
    await state.runWorkflow('wf-1', approveShell: true);
    await state.addMcpServer(name: 'local', command: 'node', args: ['server.js']);
    await state.removeMcpServer('local');
    final create = requests.firstWhere((request) => request.url.path == '/api/workflow/create');
    expect((jsonDecode(create.body) as Map)['name'], 'Release');
    final run = requests.firstWhere((request) => request.url.path == '/api/workflow/run');
    expect((jsonDecode(run.body) as Map)['approveShell'], isTrue);
    // 桥只接受 POST /api/mcp；GET 会被拒绝，界面就会一直显示'MCP 0。
    expect(
      requests.where((request) => request.url.path == '/api/mcp').every((request) => request.method == 'POST'),
      isTrue,
    );
    expect(requests.any((request) => request.url.path == '/api/mcp/add'), isTrue);
    expect(requests.any((request) => request.url.path == '/api/mcp/remove'), isTrue);
    state.dispose();
  });

  testWidgets('settings save bridge and channel without echoing secret', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final calls = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        calls.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'private-provider',
            'channels': [
              {
                'id': 'private-provider',
                'name': 'private-provider',
                'baseUrl': 'https://provider.invalid',
                'wire': 'chat',
                'model': 'gpt-test',
                'models': const <String>[],
                'apiKeyConfigured': true,
                'active': true,
              },
            ],
          });
        }
        if (request.url.path == '/api/channels/save' && request.method == 'POST')
          return _json({'id': 'private-provider'});
        return _appResponse(request);
      }),
    );
    await tester.pumpWidget(CodexPocketApp(client: client));
    await tester.pumpAndSettle();
    await _openDrawer(tester);
    await tester.tap(find.byKey(const Key('drawer-settings')));
    await tester.pumpAndSettle();
    final bridgeTile = find.widgetWithText(ListTile, 'Bridge 连接');
    await tester.scrollUntilVisible(
      bridgeTile,
      160,
      scrollable: find.descendant(of: find.byKey(const Key('settings-home')), matching: find.byType(Scrollable)),
    );
    await tester.tap(bridgeTile);
    await tester.pumpAndSettle();
    // 本机模式下地址由运行时下发；手填 URL+token 属于远程模式。
    await tester.tap(find.byKey(const Key('connection-mode-remote')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('bridge-url')), 'http://192.168.1.4:8787');
    await tester.enterText(find.byKey(const Key('bridge-token')), 'secret-token');
    await tester.ensureVisible(find.byKey(const Key('save-connection')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save-connection')));
    await tester.pumpAndSettle();
    // 连接是异步握手（healthz → 会话/配置/模型/账号），多泵几帧再断言。
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    await tester.pumpAndSettle();
    expect(
      calls.any((r) => r.url.host == '192.168.1.4' && r.headers['authorization'] == 'Bearer secret-token'),
      isTrue,
    );
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('模型与渠道'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('channel-name')), 'private-provider');
    await tester.enterText(find.byKey(const Key('channel-base-url')), 'https://provider.invalid');
    await tester.enterText(find.byKey(const Key('channel-model')), 'gpt-test');
    await tester.ensureVisible(find.byKey(const Key('channel-api-key')));
    await tester.enterText(find.byKey(const Key('channel-api-key')), 'private-key');
    await tester.ensureVisible(find.byKey(const Key('save-channel')));
    await tester.tap(find.byKey(const Key('save-channel')));
    await tester.pumpAndSettle();
    final posted = calls.lastWhere((r) => r.url.path == '/api/channels/save' && r.method == 'POST');
    final body = jsonDecode(posted.body) as Map;
    expect(body['name'], 'private-provider');
    expect(body['baseUrl'], 'https://provider.invalid');
    // 写入一律用新 wire 值（旧值 chat 只在读的时候才认）。
    expect(body['wire'], 'openai-chat');
    expect(body['model'], 'gpt-test');
    expect(body['apiKey'], 'private-key');
    expect(find.text('private-key'), findsNothing);
  });

  test('an enabled device channel is resumed at launch and reported when it fails', () async {
    // 真机复现：更新/重启后通道变关，模型读屏得到 device/unavailable，用户以为模型坏了。
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({'codex.device.channelEnabled': true});
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    var enabled = true;
    messenger.setMockMethodCallHandler(const MethodChannel('codex/device'), (call) async {
      if (call.method != 'enable') return null;
      return {
        'enabled': enabled,
        'tier': enabled ? 'accessibility' : 'standard',
        'tiers': {'accessibility': enabled},
        'consent': true,
      };
    });
    addTearDown(() => messenger.setMockMethodCallHandler(const MethodChannel('codex/device'), null));

    expect(await codexResumeDeviceChannel(), isNull, reason: 'a successful resume needs no notice');

    // 通道起来了但档位回落（无障碍被更新清掉）时必须提示，并指向系统设置。
    enabled = true;
    messenger.setMockMethodCallHandler(const MethodChannel('codex/device'), (call) async {
      if (call.method == 'enable')
        return {
          'enabled': true,
          'tier': 'accessibility',
          'tiers': {'accessibility': false},
          'consent': true,
        };
      return null;
    });
    final degraded = await codexResumeDeviceChannel();
    expect(degraded, isNotNull);
    expect(degraded, contains('无障碍'));
    messenger.setMockMethodCallHandler(const MethodChannel('codex/device'), (call) async {
      if (call.method != 'enable') return null;
      return {
        'enabled': enabled,
        'tier': enabled ? 'accessibility' : 'standard',
        'tiers': {'accessibility': enabled},
        'consent': true,
      };
    });

    enabled = false;
    final notice = await codexResumeDeviceChannel();
    expect(notice, isNotNull);
    expect(notice, contains('重新开启'), reason: 'a channel that failed to start must say where to turn it on');

    SharedPreferences.setMockInitialValues({});
    expect(await codexResumeDeviceChannel(), isNull, reason: 'a channel the user turned off must stay off');
  });

  test('a bundled runtime is installed locally instead of downloaded', () {
    // 回归点：完整包（APK 内置运行时）以前也会去下载 286MB 运行时。
    expect(codexShouldDownloadRuntime({'bundledVersion': 'codex-app-server-0.170.0-arm64'}), isFalse);
    expect(codexShouldDownloadRuntime({'bundledVersion': null}), isTrue);
    expect(codexShouldDownloadRuntime(const {}), isTrue);
  });

  testWidgets('runtime settings expose stop, restart and logs for the active engine', (tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final runtime = _FakeRuntime();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), runtime: runtime));
    await tester.pumpAndSettle();
    expect(runtime.actions, contains('start'));
    await _openDrawer(tester);
    await tester.tap(find.byKey(const Key('drawer-settings')));
    await tester.pumpAndSettle();
    final runtimeTile = find.widgetWithText(ListTile, 'Codex 运行时');
    await tester.scrollUntilVisible(
      runtimeTile,
      120,
      scrollable: find.descendant(of: find.byKey(const Key('settings-home')), matching: find.byType(Scrollable)),
    );
    await tester.tap(runtimeTile);
    await tester.pumpAndSettle();
    expect(find.text('Codex 运行时'), findsOneWidget);
    expect(find.text('运行中 · codex app-server'), findsOneWidget);
    await tester.tap(find.text('停止'));
    await tester.pumpAndSettle();
    expect(runtime.actions, contains('stop'));
    expect(find.text('已安装 · 未运行'), findsOneWidget);
    await tester.tap(find.text('启动'));
    await tester.pumpAndSettle();
    expect(runtime.actions.where((action) => action == 'start').length, greaterThanOrEqualTo(2));
    // §2.19：旧运行时残留要靠「重置运行时」清掉；会话不在 rootfs 里，所以重置不该动它们。
    await tester.ensureVisible(find.byKey(const Key('reset-runtime')));
    await tester.tap(find.byKey(const Key('reset-runtime')));
    await tester.pumpAndSettle();
    expect(find.textContaining('不会被删除'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm-reset-runtime')));
    await tester.pumpAndSettle();
    expect(runtime.actions, contains('reset'));
    // 重置后页面会轮询到「已清空」为止；把假时钟推过去，别把定时器留给下一个测试。
    await tester.pump(const Duration(seconds: 20));
    await tester.pumpAndSettle();
    await tester.tap(find.text('运行日志'));
    await tester.pumpAndSettle();
    expect(runtime.actions, contains('logs'));
    expect(find.text('Codex runtime logs'), findsOneWidget);
    expect(find.text('runtime log fixture'), findsOneWidget);
  });

  testWidgets('capability page renders MCP tools returned as a map', (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        switch (request.url.path) {
          case '/healthz':
            return http.Response('{"ok":true,"engine":"codex"}', 200);
          case '/api/mcp':
            return http.Response(
              '{"data":[{"name":"local-tools","tools":{"file_read":{"name":"file_read","description":"read a file"},'
              '"workflow_run":{"name":"workflow_run","description":"run steps"}}}]}',
              200,
            );
          case '/api/thread/list':
            return http.Response('{"threads":[]}', 200);
          case '/api/config':
            return http.Response('{"provider":"openai","model":"gpt-test","apiKeyConfigured":false}', 200);
          case '/api/models':
            return http.Response('{"models":[]}', 200);
          case '/api/account':
            return http.Response('{"account":null}', 200);
          case '/api/events':
            return http.Response('', 200);
          default:
            return http.Response('{}', 200);
        }
      }),
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    await _openDrawer(tester);
    await tester.tap(find.byKey(const Key('drawer-capabilities')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('MCP 1'), findsOneWidget);
    await tester.tap(find.text('MCP 1'));
    await tester.pumpAndSettle();
    expect(find.text('local-tools'), findsOneWidget);
    expect(find.textContaining('2 个工具'), findsOneWidget);
  });

  testWidgets('completed reasoning collapses into a 已完成 row that reopens the chain', (tester) async {
    final events = StreamController<Map<String, dynamic>>.broadcast();
    addTearDown(events.close);
    final client = CodexBridgeClient(
      client: MockClient((request) async => _appResponse(request)),
      eventSource: (after) => events.stream,
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    events.add({'seq': 1, 'type': 'turn.start'});
    events.add({'seq': 2, 'type': 'reasoning.delta', 'itemId': 'r1', 'text': '先看需求再动手'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.byKey(const Key('live-reasoning-label')), findsOneWidget);

    events.add({'seq': 3, 'type': 'text.delta', 'itemId': 'a1', 'text': '完成'});
    events.add({'seq': 4, 'type': 'turn.end', 'status': 'completed'});
    await tester.pumpAndSettle();
    // 结束后折叠成「已完成」，但思考链还能点开。
    expect(find.byKey(const Key('live-reasoning-label')), findsNothing);
    expect(find.byKey(const Key('reasoning-done-0')), findsOneWidget);
    expect(find.byKey(const Key('reasoning-body-0')), findsNothing);
    await tester.tap(find.byKey(const Key('reasoning-toggle-0')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('reasoning-body-0')), findsOneWidget);
    expect(find.textContaining('先看需求再动手'), findsOneWidget);
  });

  testWidgets('composer permission chip defaults to no sandbox override and can force read-only', (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/thread/create') return _json({'threadId': 't1'});
        return _appResponse(request);
      }),
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('composer-permission-chip')), findsOneWidget);
    // 顶栏不再重复放模型 上下文（只在输入区）。
    expect(find.byKey(const Key('appbar-context-ring')), findsNothing);
    // 默认 = 不指定沙箱（沿用本机 codex 配置）。PRoot 里没有可用沙箱，
    // 再发 workspaceWrite 会让模型以为「工具无法启动」。
    expect(find.text('完全权限'), findsOneWidget);

    await tester.tap(find.byKey(const Key('composer-permission-chip')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('permission-option-workspace-write')), findsNothing, reason: '工作区可写这个档位已删除');
    await tester.tap(find.byKey(const Key('permission-option-read-only')));
    await tester.pumpAndSettle();
    expect(find.text('只读'), findsOneWidget);

    // 只读档位要真的进 /api/turn/send；默认档位不能带 sandboxMode 字段。
    final state = CodexPocketState(client);
    await state.send('run ls', cwd: '/root/workspace', sandbox: 'read-only');
    final readonlyTurn = requests.lastWhere((request) => request.url.path == '/api/turn/send');
    expect((jsonDecode(readonlyTurn.body) as Map<String, dynamic>)['sandboxMode'], 'read-only');
    await state.send('run ls again', cwd: '/root/workspace');
    final defaultTurn = requests.lastWhere((request) => request.url.path == '/api/turn/send');
    expect((jsonDecode(defaultTurn.body) as Map<String, dynamic>).containsKey('sandboxMode'), isFalse);
    state.dispose();
  });

  testWidgets('custom theme applies background and accent and is persisted', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    CodexTheme? applied;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            key: const Key('open-appearance'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) =>
                    CodexAppearanceSettingsPage(selected: kCodexThemes.first, onChanged: (theme) => applied = theme),
              ),
            ),
            child: const Text('外观'),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('open-appearance')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('custom-accent-ffb05c48')));
    await tester.pumpAndSettle();
    expect(applied, isNotNull);
    expect(applied!.id, 'custom');
    expect(applied!.accent.toARGB32(), 0xffb05c48);
    await CodexPrefs.saveCustomTheme(applied!);
    final restored = await CodexPrefs.loadTheme();
    expect(restored.id, 'custom');
    expect(restored.accent.toARGB32(), 0xffb05c48);
  });

  testWidgets('update check surfaces a readable message when the repo has no release', (tester) async {
    final client = MockClient((request) async => _json({'message': 'Not Found'}, 404));
    final checker = CodexUpdateChecker(client: client, currentVersion: '1.0.0');
    await expectLater(
      checker.check(),
      throwsA(isA<CodexUpdateException>().having((error) => error.message, 'message', contains('没有公开的最新 Release'))),
    );
  });

  test('update check asks api.github.com for the real repo and returns the API asset URL', () async {
    // 回归点：更新地址曾经写死成旧 owner（jiajia-0613），每次检查都 404）
    // 于是「检查更新」永远找不到新版。仓库 id 现在只在 codex_brand.dart 写一次。
    final urls = <Uri>[];
    const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    final client = MockClient((request) async {
      urls.add(request.url);
      return _json({
        'tag_name': 'v9.9.9',
        'body': '更新说明',
        'assets': [
          {
            'id': 42,
            'name': 'Codex-Pocket-9.9.9-arm64.apk',
            'browser_download_url': 'https://github.com/cjosn/codex-phone/releases/download/v9.9.9/x.apk',
            'digest': 'sha256:$sha',
          },
        ],
      });
    });
    final release = await CodexUpdateChecker(client: client, currentVersion: '1.5.6').check();
    expect(urls.single.host, 'api.github.com');
    expect(urls.single.path, '/repos/cjosn/codex-phone/releases/latest');
    expect(release.version, '9.9.9');
    expect(release.sha256, sha);
    expect(release.apiAssetUrl, 'https://api.github.com/repos/cjosn/codex-phone/releases/assets/42');
    expect(compareVersions(release.version, '1.5.6') > 0, isTrue);
    expect(kUpdateManifestUrl, contains('cjosn/codex-phone'));
  });

  test('a new conversation clears the old thread state and is remembered', () async {
    // 回归点：点「新对话」后标题是新的、内容'百分比还是旧的 —— 因为没记住新 thread）
    // 也没游 events/contextUsage，下次连接还会被「上次会话」顶回去。
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/thread/create') return _json({'threadId': 't-new', 'channel': 'xingchi'});
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client)
      ..threadId = 't-old'
      ..threadChannel = 'xingchi'
      ..contextUsage = {'totalTokens': 90000, 'percent': 71}
      ..events = [PocketEvent('user', '你好', threadId: 't-old')];
    await state.createThread('/root');
    expect(state.threadId, 't-new');
    expect(state.events, isEmpty);
    expect(state.contextUsage, isEmpty);
    expect(state.contextPercent, isNull, reason: '新会话不该还显示上一轮的 71%');
    expect(state.lastThreadId, 't-new', reason: '必须记住新 thread，否则会被旧会话顶回来');
    expect(state.error, isNull);
    await state.createThread('/root');
    state.dispose();
  });

  test('a stalled stream collapses the thinking card instead of counting forever', () {
    final now = DateTime(2026, 11, 21, 12, 0, 0);
    // 已经有回答内容'+ 静默 21s → 收成「已完成」。
    expect(
      codexShouldCollapseThinking(lastProgressAt: now.subtract(const Duration(seconds: 21)), now: now, hasAnswer: true),
      isTrue,
    );
    // 还在 20s 内 → 继续显示「正在思考」。
    expect(
      codexShouldCollapseThinking(lastProgressAt: now.subtract(const Duration(seconds: 5)), now: now, hasAnswer: true),
      isFalse,
    );
    // 一个字都没出（模型还在想）→ 不能收，否则用户看不到任何进展。
    expect(
      codexShouldCollapseThinking(lastProgressAt: now.subtract(const Duration(minutes: 5)), now: now, hasAnswer: false),
      isFalse,
    );
  });

  test('an empty conversation never shows the previous thread context usage', () async {
    // 回归点：设置页 回前台会 loadContext，而桥以前回「最近一次用量」，
    // 于是新开的空会话环形显示上一轮的 100%。
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/context') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          final asked = body['threadId']?.toString();
          return _json({
            'enabled': true,
            'thresholdPercent': 75,
            'keepRecentTurns': 4,
            'autoCompact': true,
            'summaryModel': null,
            'contextWindowTokens': null,
            'usage': asked == 't-new'
                ? {'totalTokens': 0, 'contextWindow': null, 'contextWindowSource': 'unknown', 'percent': 0}
                : {'totalTokens': 794791, 'contextWindow': 475000, 'contextWindowSource': 'upstream', 'percent': 100},
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client)..threadId = 't-new';
    await state.loadContext();
    final posted = requests.firstWhere((request) => request.url.path == '/api/context');
    expect((jsonDecode(posted.body) as Map<String, dynamic>)['threadId'], 't-new');
    expect(state.contextPercent, 0);
    // 即使事件里混进了别的 thread 的用量，也不能画到当前会话环上。
    state.contextUsage = {'threadId': 't-old', 'totalTokens': 794791, 'contextWindow': 475000, 'percent': 100};
    expect(state.contextPercent, isNull);
    state.dispose();
  });

  testWidgets('picking a model from another channel also switches the gateway', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    var active = 'trae';
    List<Map<String, dynamic>> channels() => [
      {
        'id': 'trae',
        'name': 'trae',
        'baseUrl': 'https://trae.invalid/v1',
        'wire': 'openai-chat',
        'model': 'm1',
        'models': ['m1'],
        'apiKeyConfigured': true,
        'active': active == 'trae',
      },
      {
        'id': 'ly',
        'name': 'ly',
        'baseUrl': 'https://ly.invalid/v1',
        'wire': 'openai-chat',
        'model': 'm2',
        'models': ['m2'],
        'apiKeyConfigured': true,
        'active': active == 'ly',
      },
    ];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels') return _json({'active': active, 'channels': channels()});
        if (request.url.path == '/api/channels/save') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          final id = body['id'].toString();
          for (final channel in channels()) {
            if (channel['id'] == id && body['model'] != null) channel['model'] = body['model'];
          }
          return _json(channels().firstWhere((channel) => channel['id'] == id));
        }
        if (request.url.path == '/api/channels/activate') {
          active = (jsonDecode(request.body) as Map<String, dynamic>)['id'].toString();
          return _json({'active': active, 'channels': channels()});
        }
        if (request.url.path == '/api/config') {
          return _json({
            'provider': active,
            'model': channels().firstWhere((channel) => channel['id'] == active)['model'],
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: _ModelSheetHost(state: state)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-model-sheet')));
    await tester.pumpAndSettle();
    // 在 ly 渠道下选模型：必须过 provider 一起切过去。
    await tester.tap(find.byKey(const Key('sheet-channel-header-ly')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sheet-model-ly-m2')));
    await tester.pumpAndSettle();
    expect(requests.any((request) => request.url.path == '/api/channels/activate'), isTrue);
    expect(state.activeChannel?['id'], 'ly');
    expect(state.config['provider'], 'ly');
    expect(state.config['model'], 'm2');
    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  test('custom background image is persisted and cleared', () async {
    SharedPreferences.setMockInitialValues({});
    await CodexPrefs.saveBackgroundImage('/tmp/bg.png');
    expect(await CodexPrefs.loadBackgroundImage(), '/tmp/bg.png');
    await CodexPrefs.saveBackgroundImage(null);
    expect(await CodexPrefs.loadBackgroundImage(), isNull);
  });

  testWidgets('custom background keeps the image visible instead of an 86 percent theme cover', (tester) async {
    expect(codexBackgroundOverlayOpacity(themeById('cream')), 0.32);
    expect(codexBackgroundOverlayOpacity(themeById('ink')), 0.42);
    SharedPreferences.setMockInitialValues({
      'codex.theme.backgroundImage': '/tmp/bg.png',
      'codex.permissionsIntroSeen': true,
    });
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('chat-background-image')), findsOneWidget);
    final visibleOverlay = tester.widgetList<ColoredBox>(find.byType(ColoredBox)).any((box) => box.color.a == 0.32);
    expect(visibleOverlay, isTrue);
  });

  test('runtime manifest falls back to older releases when latest has no runtime asset', () async {
    // 回归点：1.7.1 用 -SkipRuntime 发布，latest 里没有 runtime-arm64-v8a.json，
    // 只看 latest 的旧实现必然失败。现在要在最近若干个 Release 里找到第一个带清单的。
    final requests = <Uri>[];
    final client = MockClient((request) async {
      requests.add(request.url);
      if (request.url.path == '/repos/cjosn/codex-phone/releases') {
        return _json([
          {
            'tag_name': 'v1.7.5',
            'assets': [
              {'name': 'Codex-Pocket-1.7.5-arm64.apk', 'id': 1},
            ],
          },
          {
            'tag_name': 'v1.7.1',
            'assets': [
              {'name': 'Codex-Pocket-1.7.1-arm64.apk', 'id': 2},
              {'name': 'runtime-arm64-v8a.json', 'id': 777934335},
            ],
          },
        ]);
      }
      if (request.url.path.endsWith('/releases/assets/777934335')) {
        return http.Response.bytes(
          utf8.encode(jsonEncode({'url': 'https://api.github.com/x', 'sha256': 'a' * 64, 'sizeMb': 286})),
          200,
        );
      }
      return http.Response('{}', 404);
    });
    final manifest = await fetchRuntimeManifestAsset(client);
    expect(manifest, isNotNull);
    expect(manifest!['sha256'], 'a' * 64);
    expect(requests.last.path, endsWith('/releases/assets/777934335'));
  });

  test('runtime manifest returns null when no release carries it', () async {
    final client = MockClient(
      (request) async => _json([
        {
          'tag_name': 'v1.7.5',
          'assets': [
            {'name': 'Codex-Pocket-1.7.5-arm64.apk', 'id': 1},
          ],
        },
      ]),
    );
    expect(await fetchRuntimeManifestAsset(client), isNull);
  });

  test('runtime manifest rejects a manifest without url or sha256', () async {
    final client = MockClient((request) async {
      if (request.url.path == '/repos/cjosn/codex-phone/releases') {
        return _json([
          {
            'tag_name': 'v1.7.1',
            'assets': [
              {'name': 'runtime-arm64-v8a.json', 'id': 42},
            ],
          },
        ]);
      }
      return http.Response.bytes(utf8.encode('{"sizeMb":286}'), 200);
    });
    await expectLater(fetchRuntimeManifestAsset(client), throwsA(isA<CodexUpdateException>()));
  });

  test('context window override drives the ring percentage', () async {
    SharedPreferences.setMockInitialValues({});
    final state = CodexPocketState(_mockClient());
    state.usage = {'totalTokens': 64000};
    // 默认按 128k 估算 → 50%
    expect(state.contextPercent!.round(), 50);
    // 用户填 64k → 100%
    await CodexPrefs.saveContextWindow(64000);
    state.contextWindowOverride = await CodexPrefs.loadContextWindow();
    expect(state.contextPercent!.round(), 100);
    state.dispose();
  });

  test('saving the context window goes through the bridge and adopts its answer', () async {
    // 回归点：窗口大小过去只写本地 SharedPreferences，桥算百分比时不知道）
    // 于是「填了值环形不变」。现在必须 POST /api/context/config 并回读桥的值。
    SharedPreferences.setMockInitialValues({});
    final requests = <http.Request>[];
    var stored = 0;
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/context/config') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          if (body.containsKey('contextWindowTokens')) {
            stored = (body['contextWindowTokens'] as num?)?.round() ?? 0;
          }
          return _json({
            'enabled': true,
            'thresholdPercent': 75,
            'keepRecentTurns': 4,
            'autoCompact': true,
            'summaryModel': null,
            'contextWindowTokens': stored == 0 ? null : stored,
            'usage': {
              'totalTokens': 9600,
              'contextWindow': stored == 0 ? null : stored,
              'contextWindowSource': stored == 0 ? 'unknown' : 'user',
              'percent': stored == 0 ? 0 : (9600 / stored * 100).round(),
            },
          });
        }
        if (request.url.path == '/api/context') {
          return _json({
            'enabled': true,
            'thresholdPercent': 75,
            'keepRecentTurns': 4,
            'autoCompact': true,
            'summaryModel': null,
            'contextWindowTokens': stored == 0 ? null : stored,
            'usage': {
              'totalTokens': 9600,
              'contextWindow': stored == 0 ? null : stored,
              'contextWindowSource': stored == 0 ? 'unknown' : 'user',
              'percent': stored == 0 ? 0 : (9600 / stored * 100).round(),
            },
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await state.saveContextWindow(20000);
    final posted = requests.firstWhere((request) => request.url.path == '/api/context/config');
    expect((jsonDecode(posted.body) as Map<String, dynamic>)['contextWindowTokens'], 20000);
    expect(state.contextWindowOverride, 20000);
    expect(state.contextWindowSource, 'user');
    expect(state.contextPercent!.round(), 48);
    // 清空 → 交回上游/默认。
    await state.saveContextWindow(0);
    expect(state.contextWindowOverride, 0);
    state.dispose();
  });

  test('send uses the active channel model instead of a stale local config', () async {
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/thread/create') return _json({'threadId': 't1'});
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client)
      ..config = {'model': 'stale-model'}
      ..applyChannelListForTest({
        'active': 'ly',
        'channels': [
          {
            'id': 'ly',
            'name': 'ly',
            'baseUrl': 'https://ly.invalid/v1',
            'wire': 'openai-chat',
            'model': 'real-model',
            'models': [],
          },
        ],
      });
    await state.send('hi', cwd: '/root/workspace');
    final turn = requests.firstWhere((request) => request.url.path == '/api/turn/send');
    expect((jsonDecode(turn.body) as Map<String, dynamic>)['model'], 'real-model');
    state.dispose();
  });

  test('a stuck turn is interrupted and the message is retried once', () async {
    final requests = <http.Request>[];
    var attempts = 0;
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/thread/create') return _json({'threadId': 't1'});
        if (request.url.path == '/api/turn/send') {
          attempts++;
          if (attempts == 1) {
            return _json({
              'error': {'code': 'codex/thread-busy', 'message': 'This thread already has a running turn'},
            }, 409);
          }
          return _json({'threadId': 't1', 'turnId': 'turn-2'});
        }
        if (request.url.path == '/api/turn/interrupt') return _json({'ok': true});
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await state.send('hi', cwd: '/root/workspace');
    expect(attempts, 2);
    expect(requests.any((request) => request.url.path == '/api/turn/interrupt'), isTrue);
    expect(state.error, isNull);
    state.dispose();
  });

  test('a thread bound to another channel is forked before the message is sent', () async {
    // codex 0.170 的考'thread 只认建线程时的 provider：桥会回 channel/thread-binding）
    // App 必须把它 fork 到当前渠道再发，否则新渠道的模型名会打到旧上游（404 重试 5 次）。
    final requests = <http.Request>[];
    var sends = 0;
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/thread/create') return _json({'threadId': 't1', 'channel': 'old'});
        if (request.url.path == '/api/turn/send') {
          sends++;
          if (sends == 1) {
            return _json({
              'error': {
                'code': 'channel/thread-binding',
                'message': '这个会话绑在渠道「old」上，不能直接发到「ly。',
                'details': {'threadId': 't1', 'boundChannel': 'old', 'activeChannel': 'ly'},
              },
            }, 409);
          }
          return _json({'threadId': 't2', 'turnId': 'turn-2'});
        }
        if (request.url.path == '/api/thread/rebind')
          return _json({'threadId': 't2', 'from': 't1', 'channel': 'ly', 'forked': true});
        if (request.url.path == '/api/thread/resume') return _json({'threadId': 't2', 'channel': 'ly', 'items': []});
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client)
      ..applyChannelListForTest({
        'active': 'ly',
        'channels': [
          {
            'id': 'ly',
            'name': 'ly',
            'baseUrl': 'https://ly.invalid/v1',
            'wire': 'openai-chat',
            'model': 'real-model',
            'models': [],
          },
        ],
      });
    await state.send('hi', cwd: '/root/workspace');
    expect(sends, 2);
    final fork = requests.singleWhere((request) => request.url.path == '/api/thread/rebind');
    expect((jsonDecode(fork.body) as Map<String, dynamic>)['threadId'], 't1');
    final second = requests.where((request) => request.url.path == '/api/turn/send').last;
    expect((jsonDecode(second.body) as Map<String, dynamic>)['threadId'], 't2');
    expect(state.threadId, 't2');
    expect(state.threadChannel, 'ly');
    expect(state.events.where((event) => event.type == 'user').length, 1, reason: '用户消息不能重复出现');
    expect(state.error, isNull);
    state.dispose();
  });

  test('switching channels moves the open thread onto the new channel', () async {
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels/activate') {
          return _json({
            'active': 'ly',
            'channels': [
              {
                'id': 'ly',
                'name': 'ly',
                'baseUrl': 'https://ly.invalid/v1',
                'wire': 'openai-chat',
                'model': 'real-model',
                'models': [],
              },
            ],
          });
        }
        if (request.url.path == '/api/thread/rebind')
          return _json({'threadId': 't2', 'from': 't1', 'channel': 'ly', 'forked': true});
        if (request.url.path == '/api/thread/resume') return _json({'threadId': 't2', 'channel': 'ly', 'items': []});
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client)
      ..threadId = 't1'
      ..threadChannel = 'old';
    await state.activateChannel('ly');
    final fork = requests.singleWhere((request) => request.url.path == '/api/thread/rebind');
    expect((jsonDecode(fork.body) as Map<String, dynamic>)['threadId'], 't1');
    expect(state.threadId, 't2');
    expect(state.threadChannel, 'ly');
    state.dispose();
  });

  testWidgets('renders responsive Codex Pocket fixture at 360, 430 and 900 widths', (tester) async {
    await loadTestFonts();
    for (final width in [360.0, 430.0, 1280.0]) {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 800);
      await tester.pumpWidget(
        CodexPocketApp(
          client: _mockClient(),
          fixtureEvents: [
            PocketEvent('user', 'Inspect the current repository'),
            PocketEvent(
              'text.delta',
              'I found a small issue.\n\n```dart\nfinal ready = true;\n```',
              itemType: 'agent_message',
            ),
            PocketEvent('approval.request', 'Run `flutter test`?', approvalId: 'fixture-approval'),
          ],
          enableRuntime: false,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Inspect the current repository'), findsOneWidget);
      // 导航入口在抽屉里：底部 4 tab 已经移除。
      expect(find.byType(NavigationBar), findsNothing);
      await _openDrawer(tester);
      expect(find.text('终端'), findsOneWidget);
      expect(find.text('能力'), findsOneWidget);
      expect(find.text('设置'), findsOneWidget);
      expect(find.text('关于与使用手册'), findsOneWidget);
      expect(tester.takeException(), isNull);
      // 同一棵子树在三种宽度间复用，抽屉要收起来，下一轮才能重新点汉堡。
      await tester.tap(find.byKey(const Key('drawer-close')));
      await tester.pumpAndSettle();
    }
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });

  testWidgets('toolpack tab lists packs and posts toggle/import to the bridge', (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        // 工具包管理全是 POST 路由：先按 path 判分支，再断言发出的 method。
        if (request.url.path == '/api/toolpacks' && request.method == 'POST') {
          return http.Response(
            jsonEncode({
              'packs': [
                {
                  'name': 'git',
                  'title': 'Git',
                  'version': '1.0.0',
                  'description': 'Version control helpers',
                  'builtin': true,
                  'enabled': true,
                  'tools': [
                    {'name': 'git_status', 'description': 'Show working tree status'},
                    {'name': 'git_diff', 'description': 'Show diff'},
                  ],
                },
                {
                  'name': 'mypack',
                  'title': 'My Pack',
                  'builtin': false,
                  'enabled': false,
                  'tools': [
                    {'name': 'my_tool', 'description': 'Mine'},
                  ],
                },
              ],
            }),
            200,
          );
        }
        if (request.url.path == '/api/toolpacks/toggle' && request.method == 'POST') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response(jsonEncode({'name': body['name'], 'enabled': body['enabled']}), 200);
        }
        if (request.url.path == '/api/toolpacks/import' && request.method == 'POST') {
          return http.Response('{"name":"my-pack-2"}', 200);
        }
        return _appResponse(request);
      }),
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    await _openDrawer(tester);
    await tester.tap(find.byKey(const Key('drawer-capabilities')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('工具包 2'));
    await tester.pumpAndSettle();

    expect(find.text('Git'), findsOneWidget);
    expect(find.text('My Pack'), findsOneWidget);
    expect(find.text('2 个工具 · 内置包'), findsOneWidget);
    expect(find.text('1 个工具 · 用户包'), findsOneWidget);
    // 内置包不能删，用户包可以删。
    expect(find.byKey(const Key('toolpack-remove-git')), findsNothing);
    expect(find.byKey(const Key('toolpack-remove-mypack')), findsOneWidget);

    await tester.tap(find.byKey(const Key('toolpack-switch-git')));
    await tester.pumpAndSettle();
    final toggle = requests.singleWhere((request) => request.url.path == '/api/toolpacks/toggle');
    expect(toggle.method, 'POST');
    expect(jsonDecode(toggle.body), {'name': 'git', 'enabled': false});

    await tester.tap(find.byKey(const Key('import-toolpack')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('toolpack-import-path')), '/root/workspace/packs/my-pack-2');
    await tester.tap(find.byKey(const Key('toolpack-import-confirm')));
    await tester.pumpAndSettle();
    final imported = requests.singleWhere((request) => request.url.path == '/api/toolpacks/import');
    expect(imported.method, 'POST');
    expect((jsonDecode(imported.body) as Map)['path'], '/root/workspace/packs/my-pack-2');
    // 导入成功后按契约用 POST /api/toolpacks 重新拉列表。
    final listings = requests.where((request) => request.url.path == '/api/toolpacks').toList();
    expect(listings.length, greaterThanOrEqualTo(2));
    expect(listings.every((request) => request.method == 'POST'), isTrue);
  });

  testWidgets('channel form fetches models from /api/channels/models and saves the selected id', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({'active': null, 'channels': <Object>[]});
        }
        if (request.url.path == '/api/channels/models' && request.method == 'POST') {
          return _json({
            'models': [
              {'id': 'deepseek-v4.1-flash'},
              {'id': 'gpt-6.2-sol'},
            ],
          });
        }
        if (request.url.path == '/api/channels/save' && request.method == 'POST') return _json({'id': 'relay2'});
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('channel-name')), 'relay2');
    await tester.enterText(find.byKey(const Key('channel-base-url')), 'https://relay.invalid/v1');
    await tester.enterText(find.byKey(const Key('channel-api-key')), 'sk-secret');
    await tester.ensureVisible(find.byKey(const Key('fetch-channel-models')));
    await tester.tap(find.byKey(const Key('fetch-channel-models')));
    await tester.pumpAndSettle();

    final fetch = requests.singleWhere((request) => request.url.path == '/api/channels/models');
    expect(fetch.method, 'POST');
    final fetchBody = jsonDecode(fetch.body) as Map<String, dynamic>;
    expect(fetchBody['baseUrl'], 'https://relay.invalid/v1');
    expect(fetchBody['wire'], 'openai-chat');
    expect(fetchBody['apiKey'], 'sk-secret');
    // 新增渠道还没有 id，桥会按 name 生成 slug；别把空 id 发过去。
    expect(fetchBody.containsKey('id'), isFalse);
    // 拉取只填选项，不覆盖还空着的模型 ID。
    expect(find.byKey(const Key('channel-fetched-models')), findsOneWidget);
    expect(_modelFieldText(tester), isEmpty);

    await tester.tap(find.byKey(const Key('channel-fetched-models')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('deepseek-v4.1-flash').last);
    await tester.pumpAndSettle();
    expect(_modelFieldText(tester), 'deepseek-v4.1-flash');

    await tester.ensureVisible(find.byKey(const Key('save-channel')));
    await tester.tap(find.byKey(const Key('save-channel')));
    await tester.pumpAndSettle();
    final saved = requests.where((request) => request.url.path == '/api/channels/save').last;
    final savedBody = jsonDecode(saved.body) as Map<String, dynamic>;
    expect(savedBody['name'], 'relay2');
    expect(savedBody['baseUrl'], 'https://relay.invalid/v1');
    expect(savedBody['wire'], 'openai-chat');
    expect(savedBody['model'], 'deepseek-v4.1-flash');
    expect(savedBody['apiKey'], 'sk-secret');
    expect(find.text('sk-secret'), findsNothing);
    // 保存成功后密钥输入框清空（失败时留着，见下一条用例）。
    expect(tester.widget<TextField>(find.byKey(const Key('channel-api-key'))).controller!.text, isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('busy channel activation offers stop-and-retry and then succeeds', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    var activations = 0;
    final requests = <http.Request>[];
    Map<String, dynamic> channel(String id, String name, {required bool active}) => {
      'id': id,
      'name': name,
      'baseUrl': 'https://$id.invalid/v1',
      'wire': 'chat',
      'model': 'deepseek-v4',
      'models': const <String>[],
      'apiKeyConfigured': true,
      'active': active,
    };
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        // 契约 B：切换渠道不允许在有活动回合时进行（409 + details.activeTurns）。
        if (request.url.path == '/api/channels/activate') {
          activations++;
          if (activations == 1) {
            return _json({
              'error': {
                'code': 'codex/busy',
                'message': 'Cannot switch provider channels during an active turn',
                'details': {
                  'activeTurns': ['thread-a'],
                },
              },
            }, 409);
          }
          return _json({
            'active': 'official',
            'channels': [channel('relay2', 'relay2', active: false), channel('official', 'official', active: true)],
          });
        }
        if (request.url.path == '/api/turn/interrupt-all') {
          return _json({
            'interrupted': [
              {'threadId': 'thread-a'},
            ],
            'failed': <Object>[],
            'remaining': <Object>[],
          });
        }
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': activations >= 2 ? 'official' : 'relay2',
            'channels': [
              channel('relay2', 'relay2', active: activations < 2),
              channel('official', 'official', active: activations >= 2),
            ],
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('channel-activate-official')));
    await tester.pumpAndSettle();
    // 有活动回合时要能一键停下重试，而不是让用户卡死。
    expect(find.text('有正在进行的回合'), findsOneWidget);
    await tester.tap(find.byKey(const Key('stop-turn-and-retry')));
    await tester.pumpAndSettle();
    expect(requests.any((request) => request.url.path == '/api/turn/interrupt-all'), isTrue);
    expect(activations, 2);
    expect(state.activeChannel?['id'], 'official');
    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('error banner can be dismissed instead of following every page', (tester) async {
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        if (request.url.path == '/api/config' && request.method == 'POST') {
          return http.Response('{"error":{"code":"codex/busy","message":"Cannot change provider settings"}}', 409);
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: state,
            builder: (context, _) => Column(
              children: [
                if (state.error != null)
                  Row(
                    children: [
                      Expanded(child: Text('错误） {state.error}')),
                      IconButton(
                        key: const Key('dismiss-error'),
                        onPressed: state.clearError,
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                TextButton(onPressed: () async => state.saveConfig({'model': 'x'}), child: const Text('save')),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('save'));
    await tester.pumpAndSettle();
    expect(state.error, isNotNull);
    await tester.tap(find.byKey(const Key('dismiss-error')));
    await tester.pumpAndSettle();
    expect(state.error, isNull);
    state.dispose();
  });

  testWidgets('drawer hosts the runtime status instead of the conversation header', (tester) async {
    final runtime = _FakeRuntime();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), runtime: runtime));
    await tester.pumpAndSettle();
    // 主界面不再常驻运行状态横幅。
    expect(find.text('Codex app-server 正在运行'), findsNothing);
    await tester.tap(find.byKey(const Key('open-drawer')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('drawer-runtime-label')), findsOneWidget);
    expect(find.text('Codex 正在运行'), findsOneWidget);
  });

  testWidgets('channel model fetch failure shows the server text and keeps the model blank', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels/models' && request.method == 'POST') {
          return _json({
            'error': {'code': 'channel/models-fetch', 'message': 'relay rejected key'},
          }, 502);
        }
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({'active': null, 'channels': <Object>[]});
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('channel-base-url')), 'https://relay.invalid/v1');
    await tester.ensureVisible(find.byKey(const Key('fetch-channel-models')));
    await tester.tap(find.byKey(const Key('fetch-channel-models')));
    await tester.pumpAndSettle();

    final fetch = requests.singleWhere((request) => request.url.path == '/api/channels/models');
    expect(fetch.method, 'POST');
    // 服务端错误文本要显示出来，不能吞。
    expect(find.textContaining('relay rejected key'), findsOneWidget);
    expect(find.byKey(const Key('channel-fetched-models')), findsNothing);
    expect(_modelFieldText(tester), isEmpty);
    expect(requests.where((request) => request.url.path == '/api/channels/save'), isEmpty);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('home opens the last conversation directly instead of a thread list', (tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    SharedPreferences.setMockInitialValues({CodexPermissionsIntro.seenKey: true, 'codex.lastThread': 'thread-a'});
    final resumes = <Map<String, dynamic>>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        if (request.url.path == '/api/thread/resume') {
          resumes.add(jsonDecode(request.body) as Map<String, dynamic>);
          return _json({
            'threadId': 'thread-a',
            'items': [
              {'type': 'userMessage', 'id': 'u1', 'text': '上次的问题'},
              {'type': 'agentMessage', 'id': 'a1', 'text': '上次的回答'},
            ],
          });
        }
        return _appResponse(request);
      }),
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();

    expect(resumes.single['threadId'], 'thread-a');
    expect(find.text('上次的问题'), findsOneWidget);
    expect(find.text('上次的回答'), findsOneWidget);
    expect(find.byKey(const Key('empty-conversation')), findsNothing);
  });

  testWidgets('drawer reaches terminal and capabilities as second-level pages', (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('empty-conversation')), findsOneWidget);

    await _openDrawer(tester);
    // 设置抽屉只放工具入口，会话区已经拆到「历史」面板里。
    expect(find.byKey(const Key('drawer-new-task')), findsNothing);
    await tester.tap(find.byKey(const Key('drawer-terminal')));
    await tester.pumpAndSettle();
    expect(find.text('终端 · /bin/bash'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('open-drawer')), findsOneWidget);

    await _openDrawer(tester);
    await tester.tap(find.byKey(const Key('drawer-capabilities')));
    await tester.pumpAndSettle();
    expect(find.text('能力'), findsOneWidget);
    expect(find.text('工具'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    // 返回键回到对话，而不是回到抽屉。
    expect(find.byKey(const Key('open-drawer')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('history panel is its own drawer: history header, search/filter, new task, session list', (tester) async {
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    await _openHistory(tester);

    // 顶部标题区：标题 + 筛选 收起（搜索框常驻，不再藏在放大镜后面）。
    expect(find.text('对话历史'), findsOneWidget);
    expect(find.byKey(const Key('drawer-search-toggle')), findsNothing);
    expect(find.byKey(const Key('drawer-filter')), findsOneWidget);
    expect(find.byKey(const Key('history-close')), findsOneWidget);
    // 搜索框默认展开在标题下面，占位文案带「对话、目录或 ID」。
    expect(find.byKey(const Key('drawer-thread-search')), findsOneWidget);
    expect(find.text('搜索对话、目录或 ID'), findsOneWidget);

    // 会话区：满宽新建按钮 + 空状态文案。
    expect(find.byKey(const Key('drawer-new-task')), findsOneWidget);
    expect(find.text('还没有会话，点上面新建一个'), findsOneWidget);

    // 顺序：标题'< 搜索 < 新建对话；设置类入口不混在历史面板里。
    final headerY = tester.getCenter(find.text('对话历史')).dy;
    final searchY = tester.getCenter(find.byKey(const Key('drawer-thread-search'))).dy;
    final newTaskY = tester.getCenter(find.byKey(const Key('drawer-new-task'))).dy;
    expect(headerY, lessThan(searchY));
    expect(searchY, lessThan(newTaskY));
    // 紧凑：搜索框 40、新建 44，两者之间只留 8。
    expect(tester.getSize(find.byKey(const Key('drawer-thread-search'))).height, 40);
    expect(tester.getSize(find.byKey(const Key('drawer-new-task'))).height, 44);
    expect(newTaskY - searchY, lessThan(60));
    expect(find.byKey(const Key('drawer-settings')), findsNothing);
    expect(find.byKey(const Key('drawer-terminal')), findsNothing);
    expect(find.byKey(const Key('drawer-capabilities')), findsNothing);
    expect(find.byKey(const Key('drawer-about')), findsNothing);
    expect(find.byKey(const Key('drawer-workspace')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('history search matches a thread id fragment case-insensitively and shows id prefix', (tester) async {
    await tester.pumpWidget(CodexPocketApp(client: _historyClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    await _openHistory(tester);

    // 不搜索时两条会话都在，且不带 ID 行。
    expect(find.text('整理发布清单'), findsOneWidget);
    expect(find.text('修复登录按钮'), findsOneWidget);
    expect(find.text('thread-9'), findsNothing);
    expect(find.byKey(const Key('drawer-search-clear')), findsNothing);

    // 输入会话 ID 的大写片段也能命中（大小写不敏感，按 id.contains 过滤）。
    await tester.enterText(find.byKey(const Key('drawer-thread-search')), '9F3A');
    await tester.pumpAndSettle();
    expect(find.text('整理发布清单'), findsOneWidget);
    expect(find.text('修复登录按钮'), findsNothing);
    expect(find.byKey(const Key('drawer-search-clear')), findsOneWidget);
    // 搜索模式：标题 + 目录 + ID 前 8 位。
    expect(find.text('/work/alpha'), findsOneWidget);
    expect(find.text('thread-9'), findsOneWidget);

    // 会话行高度压到 64，比原来的 dense ListTile 更紧。
    expect(tester.getSize(find.byKey(const ValueKey('thread-swipe-thread-9f3a2c41'))).height, 64);

    // 清除按钮回到全量列表。
    await tester.tap(find.byKey(const Key('drawer-search-clear')));
    await tester.pumpAndSettle();
    expect(find.text('整理发布清单'), findsOneWidget);
    expect(find.text('修复登录按钮'), findsOneWidget);
    expect(find.text('thread-9'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('history panel gives the status bar its room and stays compact', (tester) async {
    final state = CodexPocketState(CodexBridgeClient(client: MockClient((_) async => http.Response('{}', 200))));
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          // 真机状态栏高度由外层 MediaQuery 提供：面板自己要让出来。
          data: const MediaQueryData(size: Size(400, 800), padding: EdgeInsets.only(top: 44, bottom: 24)),
          child: SizedBox(
            width: 320,
            height: 800,
            child: CodexHistoryPanel(state: state, onNewTask: () async {}, onOpenThread: (_) async {}, onClose: () {}),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 标题不再贴边：面板顶部 = 状态栏 44 + 12 留白。
    final titleTop = tester.getTopLeft(find.text('对话历史')).dy;
    expect(titleTop, greaterThanOrEqualTo(56));
    // 从上到下：标题'→ 8 → 搜索 40 → 8 → 新建 44，间距压紧。
    final searchRect = tester.getRect(find.byKey(const Key('drawer-thread-search')));
    final newTaskRect = tester.getRect(find.byKey(const Key('drawer-new-task')));
    expect(searchRect.height, 40);
    expect(newTaskRect.height, 44);
    expect(searchRect.top, greaterThan(tester.getRect(find.text('对话历史')).bottom));
    expect(newTaskRect.top - searchRect.bottom, 8);
    expect(tester.takeException(), isNull);
  });

  testWidgets('history search with no match says 没有匹配的会话', (tester) async {
    await tester.pumpWidget(CodexPocketApp(client: _historyClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    await _openHistory(tester);

    await tester.enterText(find.byKey(const Key('drawer-thread-search')), 'zzz-no-such-thread');
    await tester.pumpAndSettle();
    expect(find.text('没有匹配的会话'), findsOneWidget);
    expect(find.text('整理发布清单'), findsNothing);
    expect(find.text('修复登录按钮'), findsNothing);
    expect(find.byKey(const Key('drawer-new-task')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tapping open-history slides out the conversation history with a new-chat entry', (tester) async {
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();

    // 「历史」入口在汉堡右侧，独立于设置抽屉。
    expect(find.byKey(const Key('open-history')), findsOneWidget);
    await tester.tap(find.byKey(const Key('open-history')));
    await tester.pumpAndSettle();
    expect(find.text('对话历史'), findsOneWidget);
    expect(find.text('新建对话'), findsOneWidget);
    expect(find.byKey(const Key('drawer-new-task')), findsOneWidget);

    // 点面板右侧空白处收起，回到对话。
    await tester.tapAt(const Offset(700, 300));
    await tester.pumpAndSettle();
    expect(find.text('对话历史'), findsNothing);
    expect(find.byKey(const Key('open-drawer')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('settings drawer keeps tool entries and lists no conversations', (tester) async {
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    await _openDrawer(tester);

    // 工具入口都在。
    expect(find.byKey(const Key('drawer-terminal')), findsOneWidget);
    expect(find.byKey(const Key('drawer-capabilities')), findsOneWidget);
    expect(find.byKey(const Key('drawer-settings')), findsOneWidget);
    expect(find.byKey(const Key('drawer-about')), findsOneWidget);
    // 会话列表项一个都不在：新建 搜索/筛选 会话分组标题都不该出现。
    expect(find.byKey(const Key('drawer-new-task')), findsNothing);
    expect(find.byKey(const Key('drawer-search-toggle')), findsNothing);
    expect(find.byKey(const Key('drawer-thread-search')), findsNothing);
    expect(find.byKey(const Key('drawer-filter')), findsNothing);
    expect(find.text('最近会话'), findsNothing);
    expect(find.text('新建对话'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('context settings save the threshold through /api/context/config', (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/context' && request.method == 'POST') {
          return http.Response(
            jsonEncode({
              'enabled': true,
              'thresholdPercent': 75,
              'keepRecentTurns': 4,
              'autoCompact': true,
              'summaryModel': null,
              'usage': {'totalTokens': 50000, 'contextWindow': 200000, 'percent': 25},
            }),
            200,
          );
        }
        if (request.url.path == '/api/context/config' && request.method == 'POST') {
          return http.Response('{"ok":true}', 200);
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: CodexContextSettingsPage(state: state)));
    await tester.pumpAndSettle();

    expect(find.text('已用 25%'), findsOneWidget);
    await tester.tap(find.byKey(const Key('context-threshold-increase')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('context-threshold-increase')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('save-context-config')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save-context-config')));
    await tester.pumpAndSettle();

    final saved = requests.lastWhere((request) => request.url.path == '/api/context/config');
    expect(saved.method, 'POST');
    final body = jsonDecode(saved.body) as Map<String, dynamic>;
    expect(body['thresholdPercent'], 77);
    expect(body['keepRecentTurns'], 4);
    expect(body['enabled'], isTrue);
    expect(body['autoCompact'], isTrue);
    expect(
      requests.where((request) => request.url.path == '/api/context').every((request) => request.method == 'POST'),
      isTrue,
    );

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('persona page saves the profile and previews the AGENTS.md block', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/persona' && request.method == 'POST') {
          return _json({
            'name': '',
            'style': '',
            'instructions': '',
            'active': true,
            'path': '/root/.codex/AGENTS.md',
            'effectiveInstructions': 'DEFAULT AGENT RULES',
            'injection': 'developerInstructions+AGENTS.md',
          });
        }
        if (request.url.path == '/api/persona/save' && request.method == 'POST') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({
            'name': body['name'],
            'style': body['style'],
            'instructions': body['instructions'],
            'active': body['active'],
            'path': '/root/.codex/AGENTS.md',
            'effectiveInstructions': 'DEFAULT AGENT RULES\n\n${body['instructions']}',
            'injection': 'developerInstructions+AGENTS.md',
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: CodexPersonaSettingsPage(state: state)));
    await tester.pumpAndSettle();
    expect(requests.any((request) => request.url.path == '/api/persona'), isTrue);
    expect(find.byKey(const Key('persona-preview')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('persona-name')), '审稿了');
    await tester.enterText(find.byKey(const Key('persona-style')), '简洁');
    await tester.enterText(find.byKey(const Key('persona-instructions')), '先给结论');
    await tester.ensureVisible(find.byKey(const Key('save-persona')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save-persona')));
    await tester.pumpAndSettle();

    final saved = requests.singleWhere((request) => request.url.path == '/api/persona/save');
    expect(saved.method, 'POST');
    expect(jsonDecode(saved.body), {'name': '审稿了', 'style': '简洁', 'instructions': '先给结论', 'active': true});
    expect(find.textContaining('codex-pocket:persona:start'), findsOneWidget);
    expect(find.textContaining('审稿了'), findsWidgets);
    // 保存响应真的被解析进状态（不是被 snackbar 吞掉的失败）。
    expect(state.personaName, '审稿了');
    expect(state.personaInstructions, '先给结论');
    expect(state.personaEffectiveInstructions, 'DEFAULT AGENT RULES\n\n先给结论');
    expect(find.textContaining('DEFAULT AGENT RULES'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('plugin page toggles, installs and removes through bridge routes', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/plugins' && request.method == 'POST') {
          return _json({
            'plugins': [
              {
                'name': 'git-helper',
                'title': 'Git 助手',
                'version': '1.0.0',
                'description': 'git helpers',
                'builtin': false,
                'enabled': true,
                'toolpacks': ['gitx'],
                'skills': ['review'],
              },
              {
                'name': 'builtin-pack',
                'title': '内置包',
                'version': '1.0.0',
                'builtin': true,
                'enabled': true,
                'toolpacks': [],
                'skills': [],
              },
            ],
          });
        }
        if (request.url.path == '/api/plugins/toggle' && request.method == 'POST') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({'name': body['name'], 'enabled': body['enabled']});
        }
        if (request.url.path == '/api/plugins/install' && request.method == 'POST') {
          return _json({'name': 'new-plugin'});
        }
        if (request.url.path == '/api/plugins/remove' && request.method == 'POST') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({'name': body['name']});
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: CodexPluginsSettingsPage(state: state)));
    await tester.pumpAndSettle();

    expect(find.text('Git 助手'), findsOneWidget);
    expect(find.textContaining('1 个工具包 · 1 个技能'), findsOneWidget);
    // 内置插件不能卸载。
    expect(find.byKey(const Key('plugin-remove-builtin-pack')), findsNothing);
    expect(find.byKey(const Key('plugin-remove-git-helper')), findsOneWidget);

    await tester.tap(find.byKey(const Key('plugin-switch-git-helper')));
    await tester.pumpAndSettle();
    final toggle = requests.singleWhere((request) => request.url.path == '/api/plugins/toggle');
    expect(toggle.method, 'POST');
    expect(jsonDecode(toggle.body), {'name': 'git-helper', 'enabled': false});

    await tester.ensureVisible(find.byKey(const Key('plugin-install-path')));
    await tester.enterText(find.byKey(const Key('plugin-install-path')), '/root/workspace/plugins/new-plugin');
    await tester.ensureVisible(find.byKey(const Key('plugin-install')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('plugin-install')));
    await tester.pumpAndSettle();
    final install = requests.singleWhere((request) => request.url.path == '/api/plugins/install');
    expect(install.method, 'POST');
    expect((jsonDecode(install.body) as Map)['path'], '/root/workspace/plugins/new-plugin');
    // 安装成功后按契约用 POST /api/plugins 重新拉列表。
    expect(requests.where((request) => request.url.path == '/api/plugins').length, greaterThanOrEqualTo(2));
    expect(
      requests.where((request) => request.url.path == '/api/plugins').every((request) => request.method == 'POST'),
      isTrue,
    );

    await tester.ensureVisible(find.byKey(const Key('plugin-remove-git-helper')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('plugin-remove-git-helper')));
    await tester.pumpAndSettle();
    final remove = requests.singleWhere((request) => request.url.path == '/api/plugins/remove');
    expect(remove.method, 'POST');
    expect(jsonDecode(remove.body), {'name': 'git-helper'});

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('tapping the app bar ring opens the context settings page', (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('composer-context-ring')));
    await tester.pumpAndSettle();
    expect(find.text('上下文与压缩'), findsOneWidget);
    // 桥没给上下文接口（默认 {}）时，解析失败原因要显示在页面上，不能空白。
    expect(find.textContaining('上下文设置响应缺少 enabled'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('open-drawer')), findsOneWidget);
  });

  testWidgets('context ring shows the percentage from context.usage events', (tester) async {
    final state = CodexPocketState(_mockClient())..threadId = 'thread-a';
    state.acceptEvent({
      'seq': 1,
      'type': 'context.usage',
      'threadId': 'thread-a',
      'totalTokens': 42000,
      'contextWindow': 100000,
      'percent': 42,
    });
    expect(state.contextPercent, 42);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          appBar: AppBar(actions: [CodexContextRing(state: state)]),
          body: const SizedBox.shrink(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('42'), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('context-ring-label'))).data, '42');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ---- CONTRACT-V3 D：流式与思考链 ----

  testWidgets('streamed text deltas render as they arrive, before the turn ends', (tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final events = StreamController<Map<String, dynamic>>.broadcast();
    addTearDown(events.close);
    final client = CodexBridgeClient(
      client: MockClient((request) async => _appResponse(request)),
      eventSource: (after) => events.stream,
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('empty-conversation')), findsOneWidget);

    var seq = 0;
    for (final chunk in ['流式', '渲染', '中']) {
      events.add({'seq': ++seq, 'type': 'text.delta', 'itemId': 'm1', 'text': chunk});
      await tester.pump(const Duration(milliseconds: 20));
    }
    // 还没收到 turn.end：界面必须已经有部分文本（边收边渲染）。
    expect(_rendersText(tester, '流式渲染中'), isTrue);

    events.add({'seq': ++seq, 'type': 'turn.end', 'status': 'completed'});
    await tester.pumpAndSettle();
    // turn.end 不能清掉已经渲染的内容。
    expect(_rendersText(tester, '流式渲染中'), isTrue);
  });

  testWidgets('reasoning events render an expandable thinking block', (tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final events = StreamController<Map<String, dynamic>>.broadcast();
    addTearDown(events.close);
    final client = CodexBridgeClient(
      client: MockClient((request) async => _appResponse(request)),
      eventSource: (after) => events.stream,
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();

    events.add({'seq': 0, 'type': 'turn.start'});
    events.add({'seq': 1, 'type': 'reasoning.delta', 'itemId': 'r1', 'text': '先读代码再动手'});
    // 思考进行中：有每秒计时器，不能用 pumpAndSettle。
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.byKey(const Key('reasoning-block-0')), findsOneWidget);
    // 思考链默认展开，能看见推理正文。
    expect(find.byKey(const Key('reasoning-body-0')), findsOneWidget);
    expect(find.textContaining('先读代码再动手'), findsOneWidget);
    expect(find.byKey(const Key('live-reasoning-label')), findsOneWidget);

    events.add({'seq': 2, 'type': 'turn.end', 'status': 'completed'});
    await tester.pumpAndSettle();
    // 结束后折叠为「已完成」，点开仍能看思考链。
    expect(find.byKey(const Key('reasoning-done-0')), findsOneWidget);
    expect(find.byKey(const Key('reasoning-body-0')), findsNothing);

    await tester.tap(find.byKey(const Key('reasoning-toggle-0')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('reasoning-body-0')), findsOneWidget);
    expect(find.textContaining('先读代码再动手'), findsOneWidget);
  });

  testWidgets('active reasoning stays directly above the streaming answer', (tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final events = StreamController<Map<String, dynamic>>.broadcast();
    addTearDown(events.close);
    final client = CodexBridgeClient(
      client: MockClient((request) async => _appResponse(request)),
      eventSource: (after) => events.stream,
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    events.add({'seq': 1, 'type': 'turn.start', 'threadId': null});
    events.add({'seq': 2, 'type': 'reasoning.delta', 'itemId': 'r-live', 'text': '先理解问题，再组织答案'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.byKey(const Key('live-reasoning-label')), findsOneWidget);
    expect(find.textContaining('先理解问题，再组织答案'), findsOneWidget);

    events.add({'seq': 3, 'type': 'text.delta', 'itemId': 'answer-live', 'text': '正在生成回复'});
    await tester.pump(const Duration(milliseconds: 30));
    final answer = find.byWidgetPredicate(
      (widget) => widget is RichText && widget.text.toPlainText().contains('正在生成回复'),
    );
    expect(answer, findsOneWidget);
    // 个 DSH 一致：思考链属于这条回答，显示在回答正文上方。
    expect(tester.getTopLeft(find.byKey(const Key('reasoning-block-0'))).dy, lessThan(tester.getTopLeft(answer).dy));
    events.add({'seq': 4, 'type': 'turn.end', 'status': 'completed'});
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('live-reasoning-label')), findsNothing);
    expect(_rendersText(tester, '正在生成回复'), isTrue);
  });

  testWidgets('waiting indicator appears inline before the first answer token', (tester) async {
    final events = StreamController<Map<String, dynamic>>.broadcast();
    addTearDown(events.close);
    final client = CodexBridgeClient(
      client: MockClient((request) async => _appResponse(request)),
      eventSource: (after) => events.stream,
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    events.add({'seq': 1, 'type': 'turn.start'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.byKey(const Key('live-thinking-card')), findsOneWidget);
    expect(find.byKey(const Key('empty-conversation')), findsNothing);
    events.add({'seq': 2, 'type': 'text.delta', 'itemId': 'a', 'text': 'OK'});
    await tester.pump(const Duration(milliseconds: 30));
    final answer = find.byWidgetPredicate((widget) => widget is RichText && widget.text.toPlainText().contains('OK'));
    expect(tester.getTopLeft(find.byKey(const Key('live-thinking-card'))).dy, lessThan(tester.getTopLeft(answer).dy));
    events.add({'seq': 3, 'type': 'turn.end', 'status': 'completed'});
    await tester.pumpAndSettle();
  });

  // ---- CONTRACT-V3 B：多渠道 ----

  testWidgets('channel list shows name/url/wire/model/key state and posts activate/remove once', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'relay-a',
            'channels': [
              {
                'id': 'relay-a',
                'name': 'Relay A',
                'baseUrl': 'https://relay-a.example/v1',
                'wire': 'chat',
                'model': 'deepseek-v4.1-flash',
                'models': ['deepseek-v4.1-flash'],
                'apiKeyConfigured': true,
                'active': true,
              },
              {
                'id': 'official',
                'name': '官方直连',
                'baseUrl': 'https://api.openai.com/v1',
                'wire': 'responses',
                'model': 'gpt-6.2-sol',
                'models': <Object>[],
                'apiKeyConfigured': false,
                'active': false,
              },
            ],
          });
        }
        // activate 的响应就是完整的渠道列表视图（CONTRACT-V3 B）。
        if (request.url.path == '/api/channels/activate') {
          return _json({
            'active': 'official',
            'channels': [
              {
                'id': 'relay-a',
                'name': 'Relay A',
                'baseUrl': 'https://relay-a.example/v1',
                'wire': 'chat',
                'model': 'deepseek-v4.1-flash',
                'models': ['deepseek-v4.1-flash'],
                'apiKeyConfigured': true,
                'active': false,
              },
              {
                'id': 'official',
                'name': '官方直连',
                'baseUrl': 'https://api.openai.com/v1',
                'wire': 'responses',
                'model': 'gpt-6.2-sol',
                'models': <Object>[],
                'apiKeyConfigured': false,
                'active': true,
              },
            ],
          });
        }
        if (request.url.path == '/api/channels/remove') {
          return _json({'removed': true, 'id': 'relay-a', 'active': null});
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();

    // 每行都要能看到：名称 / 地址 / 协议徽标 / 模型 / 活动标记 / 密钥是否已配置。
    expect(find.text('Relay A'), findsOneWidget);
    expect(find.text('官方直连'), findsOneWidget);
    expect(find.textContaining('https://relay-a.example/v1'), findsOneWidget);
    // 徽标显示 wire 的中文名；旧值 chat/responses 也回显成新名称。
    expect(find.text('OpenAI 兼容'), findsOneWidget);
    expect(find.text('OpenAI Responses'), findsOneWidget);
    expect(find.text('活动'), findsOneWidget);
    expect(find.textContaining('密钥已配置'), findsOneWidget);
    expect(find.textContaining('未配置密钥'), findsOneWidget);
    // 「当前模型」区块的数据来自活动渠道。
    expect(
      find.descendant(of: find.byKey(const Key('current-model')), matching: find.text('deepseek-v4.1-flash')),
      findsOneWidget,
    );
    // 活动渠道自己不再显示激活按钮。
    expect(find.byKey(const Key('channel-activate-relay-a')), findsNothing);
    expect(find.byKey(const Key('channel-activate-official')), findsOneWidget);

    // 编辑：表单填上该渠道，密钥不回显，协议跟着渠道走。
    await tester.tap(find.byKey(const Key('channel-edit-official')));
    await tester.pumpAndSettle();
    expect(find.textContaining('编辑渠道 · official'), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('channel-name'))).controller!.text, '官方直连');
    expect(
      tester.widget<TextField>(find.byKey(const Key('channel-base-url'))).controller!.text,
      'https://api.openai.com/v1',
    );
    expect(tester.widget<TextField>(find.byKey(const Key('channel-api-key'))).controller!.text, isEmpty);
    // 旧值 responses 在表单里回显为新名称 openai-responses。
    expect(tester.widget<DropdownButton<String>>(find.byKey(const Key('channel-wire'))).value, 'openai-responses');
    await tester.tap(find.byKey(const Key('cancel-edit-channel')));
    await tester.pumpAndSettle();
    expect(find.text('新增渠道'), findsWidgets);

    await tester.tap(find.byKey(const Key('channel-activate-official')));
    await tester.pumpAndSettle();
    final activate = requests.singleWhere((request) => request.url.path == '/api/channels/activate');
    expect(activate.method, 'POST');
    expect(jsonDecode(activate.body), {'id': 'official'});

    await tester.tap(find.byKey(const Key('channel-remove-relay-a')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-remove-channel')));
    await tester.pumpAndSettle();
    final remove = requests.singleWhere((request) => request.url.path == '/api/channels/remove');
    expect(remove.method, 'POST');
    expect(jsonDecode(remove.body), {'id': 'relay-a'});

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('channel page fits a 360dp phone without overflow', (tester) async {
    tester.view.physicalSize = const Size(360, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'relay-a',
            'channels': [
              {
                'id': 'relay-a',
                'name': 'Relay A with a fairly long channel name',
                'baseUrl': 'https://relay-a.example/v1',
                'wire': 'chat',
                'model': 'deepseek-v4.1-flash',
                'models': ['deepseek-v4.1-flash'],
                'apiKeyConfigured': true,
                'active': true,
              },
              {
                'id': 'official',
                'name': '官方直连',
                'baseUrl': 'https://api.openai.com/v1',
                'wire': 'responses',
                'model': 'gpt-6.2-sol',
                'models': <Object>[],
                'apiKeyConfigured': false,
                'active': false,
              },
            ],
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    // 滚到底把新增渠道表单也建出来：窄屏下按钮与下拉不能溢出。
    await tester.drag(find.byType(ListView).last, const Offset(0, -1200));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView).last, const Offset(0, -1200));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('channel save failure keeps the API key, retry posts the responses wire', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    var saves = 0;
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels/save' && request.method == 'POST') {
          saves++;
          if (saves == 1) {
            return _json({
              'error': {'code': 'channel/conflict', 'message': 'name already taken'},
            }, 409);
          }
          return _json({'id': 'official'});
        }
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'official',
            'channels': [
              {
                'id': 'official',
                'name': 'official',
                'baseUrl': 'https://api.openai.com/v1',
                'wire': 'responses',
                'model': 'gpt-6.2-sol',
                'models': <Object>[],
                'apiKeyConfigured': true,
                'active': true,
              },
            ],
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('channel-wire')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('OpenAI Responses').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('channel-name')), 'official');
    await tester.enterText(find.byKey(const Key('channel-base-url')), 'https://api.openai.com/v1');
    await tester.enterText(find.byKey(const Key('channel-model')), 'gpt-6.2-sol');
    await tester.ensureVisible(find.byKey(const Key('channel-api-key')));
    await tester.enterText(find.byKey(const Key('channel-api-key')), 'sk-keep');
    await tester.ensureVisible(find.byKey(const Key('save-channel')));
    await tester.tap(find.byKey(const Key('save-channel')));
    await tester.pumpAndSettle();

    // 保存失败：桥的原话原样显示，密钥输入框不清空。
    expect(find.textContaining('name already taken'), findsOneWidget);
    expect(find.byKey(const Key('channel-form-error')), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('channel-api-key'))).controller!.text, 'sk-keep');

    await tester.tap(find.byKey(const Key('save-channel')));
    await tester.pumpAndSettle();
    expect(saves, 2);
    final retried = requests.where((request) => request.url.path == '/api/channels/save').last;
    final retriedBody = jsonDecode(retried.body) as Map<String, dynamic>;
    expect(retriedBody['wire'], 'openai-responses');
    expect(retriedBody['name'], 'official');
    expect(retriedBody['model'], 'gpt-6.2-sol');
    expect(retriedBody['apiKey'], 'sk-keep');
    // 成功后才清空密钥输入框，并按 id 刷新列表。
    expect(tester.widget<TextField>(find.byKey(const Key('channel-api-key'))).controller!.text, isEmpty);
    expect(find.byKey(const Key('channel-official')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ---- CONTRACT-V4 D：协议下拉 + 测试连接 ----

  testWidgets('protocol dropdown offers six wires with base URL hints and posts the picked wire', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({'active': null, 'channels': <Object>[]});
        }
        if (request.url.path == '/api/channels/save' && request.method == 'POST') return _json({'id': 'gemini-main'});
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();

    // 默认 OpenAI 兼容（chat），示例 URL 跟着选中的 wire 走。
    expect(tester.widget<DropdownButton<String>>(find.byKey(const Key('channel-wire'))).value, 'openai-chat');
    expect(find.text('示例：https://api.openai.com/v1'), findsOneWidget);

    await tester.tap(find.byKey(const Key('channel-wire')));
    await tester.pumpAndSettle();
    for (final label in const [
      'OpenAI 兼容（chat）',
      'OpenAI Responses',
      'Anthropic',
      'Gemini',
      'Azure OpenAI',
      'Ollama 本地',
    ]) {
      expect(find.text(label), findsWidgets, reason: '协议下拉里缺 $label');
    }
    await tester.tap(find.text('Gemini').last);
    await tester.pumpAndSettle();
    expect(tester.widget<DropdownButton<String>>(find.byKey(const Key('channel-wire'))).value, 'gemini');
    // 选中后给出该 wire 的 Base URL 例子与「是否走本机代理」的一行说明。
    expect(find.text('示例：https://generativelanguage.googleapis.com/v1beta'), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('channel-wire-note'))).data, contains('走本机兼容代理'));

    await tester.enterText(find.byKey(const Key('channel-name')), 'gemini-main');
    await tester.enterText(
      find.byKey(const Key('channel-base-url')),
      'https://generativelanguage.googleapis.com/v1beta',
    );
    await tester.enterText(find.byKey(const Key('channel-model')), 'gemini-3-pro');
    await tester.ensureVisible(find.byKey(const Key('save-channel')));
    await tester.tap(find.byKey(const Key('save-channel')));
    await tester.pumpAndSettle();
    final saved = requests.lastWhere((request) => request.url.path == '/api/channels/save');
    final body = jsonDecode(saved.body) as Map<String, dynamic>;
    expect(body['wire'], 'gemini');
    expect(body['name'], 'gemini-main');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('connection test saves changed fields first, then reports models and latency', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({'active': null, 'channels': <Object>[]});
        }
        if (request.url.path == '/api/channels/save' && request.method == 'POST') return _json({'id': 'relay-test'});
        if (request.url.path == '/api/channels/test' && request.method == 'POST') {
          return _json({'ok': true, 'wire': 'anthropic', 'models': 12, 'latencyMs': 640});
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('channel-name')), 'relay-test');
    await tester.enterText(find.byKey(const Key('channel-base-url')), 'https://api.anthropic.com/v1');
    await tester.enterText(find.byKey(const Key('channel-model')), 'claude-4-5');
    await tester.enterText(find.byKey(const Key('channel-api-key')), 'sk-ant');
    await tester.tap(find.byKey(const Key('channel-wire')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Anthropic').last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('channel-test')));
    await tester.tap(find.byKey(const Key('channel-test')));
    await tester.pumpAndSettle();

    // 字段有改动：入 POST /api/channels/save，再用桥确认的 id 测。
    final saved = requests.lastWhere((request) => request.url.path == '/api/channels/save');
    final savedBody = jsonDecode(saved.body) as Map<String, dynamic>;
    expect(savedBody['wire'], 'anthropic');
    expect(savedBody['apiKey'], 'sk-ant');
    final tested = requests.lastWhere((request) => request.url.path == '/api/channels/test');
    expect(tested.method, 'POST');
    expect(jsonDecode(tested.body), {'id': 'relay-test'});
    expect(find.byKey(const Key('channel-test-ok')), findsOneWidget);
    expect(find.text('成功 · 12 个模型 · 640ms'), findsOneWidget);
    // 密钥只上行，界面不回显。
    expect(find.text('sk-ant'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('connection test shows the failing stage and the bridge text verbatim', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    var stage = 'connect';
    var message = 'boom';
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'relay-a',
            'channels': [
              {
                'id': 'relay-a',
                'name': 'relay-a',
                'baseUrl': 'https://relay-a.example/v1',
                'wire': 'chat',
                'model': 'deepseek-v4.1-flash',
                'models': ['deepseek-v4.1-flash'],
                'apiKeyConfigured': true,
                'active': true,
              },
            ],
          });
        }
        if (request.url.path == '/api/channels/test' && request.method == 'POST') {
          return _json({
            'error': {'code': 'channel/test-failed', 'message': message},
            'details': {'stage': stage},
          }, 502);
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(
      MaterialApp(
        home: CodexModelSettingsPage(state: state, onPickModel: () {}),
      ),
    );
    await tester.pumpAndSettle();

    // 编辑已有渠道且字段没改动：测试连接直接用已存的 id，不再保存。
    await tester.tap(find.byKey(const Key('channel-edit-relay-a')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('channel-test')));
    for (final (failureStage, label) in const [('connect', '连接'), ('auth', '鉴权'), ('infer', '推理')]) {
      stage = failureStage;
      message = '$failureStage exploded';
      await tester.tap(find.byKey(const Key('channel-test')));
      await tester.pumpAndSettle();
      expect(find.text('失败于 $label：$failureStage exploded'), findsOneWidget, reason: '$failureStage 阶段要显示对应中文阶段名与桥的原话');
    }
    expect(requests.where((request) => request.url.path == '/api/channels/save'), isEmpty);
    expect(requests.where((request) => request.url.path == '/api/channels/test'), hasLength(3));
    expect(find.byKey(const Key('channel-test-ok')), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  test('legacy chat/responses wires read as the new names and are written back as new values', () async {
    final bodies = <Map<String, dynamic>>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'official',
            'channels': [
              {
                'id': 'official',
                'name': 'official',
                'baseUrl': 'https://api.openai.com/v1',
                'wire': 'responses',
                'model': 'gpt-6.2-sol',
                'models': <Object>[],
                'apiKeyConfigured': true,
                'active': true,
              },
            ],
          });
        }
        if (request.url.path == '/api/channels/save' && request.method == 'POST') {
          bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          return _json({'id': 'official'});
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await state.loadChannels();
    expect(normalizeChannelWire('chat'), 'openai-chat');
    expect(normalizeChannelWire('responses'), 'openai-responses');
    expect(normalizeChannelWire('gemini'), 'gemini');
    expect(channelWireBadge('chat'), 'OpenAI 兼容');
    expect(channelWireBadge('responses'), 'OpenAI Responses');
    await state.patchChannel(state.channels.single, model: 'gpt-6.2-sol');
    expect(bodies.single['wire'], 'openai-responses');
    state.dispose();
  });

  // ---- CONTRACT-V3 C：本机 / 远程 ----

  testWidgets('remote mode is persisted, skips runtime auto-start, and local mode starts it again', (tester) async {
    tester.view.physicalSize = const Size(900, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    SharedPreferences.setMockInitialValues({
      CodexPermissionsIntro.seenKey: true,
      CodexPocketState.connectionModeKey: 'remote',
    });
    final runtime = _FakeRuntime();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), runtime: runtime));
    await tester.pumpAndSettle();

    // 远程模式：不拉起本机运行时（连状态都不探）。
    expect(runtime.actions, isEmpty);
    expect((await SharedPreferences.getInstance()).getString(CodexPocketState.connectionModeKey), 'remote');

    await _openDrawer(tester);
    await tester.tap(find.byKey(const Key('drawer-settings')));
    await tester.pumpAndSettle();
    final bridgeTile = find.widgetWithText(ListTile, 'Bridge 连接');
    await tester.scrollUntilVisible(
      bridgeTile,
      160,
      scrollable: find.descendant(of: find.byKey(const Key('settings-home')), matching: find.byType(Scrollable)),
    );
    await tester.tap(bridgeTile);
    await tester.pumpAndSettle();
    // 远程模式展示手填的 URL + token。
    expect(find.byKey(const Key('bridge-url')), findsOneWidget);
    expect(find.byKey(const Key('bridge-token')), findsOneWidget);

    // 切回本机：立刻落盘，并自动拉起运行时。
    await tester.tap(find.byKey(const Key('connection-mode-local')));
    await tester.pumpAndSettle();
    expect((await SharedPreferences.getInstance()).getString(CodexPocketState.connectionModeKey), 'local');
    expect(runtime.actions, contains('start'));
  });

  // ---- 模型池跟随渠道（真机 bug：点模型把 chat 渠道顶回 responses 直连） ---

  testWidgets('model sheet lists channel models and saves the picked model via /api/channels/save', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    var servedModel = 'DeepSeek-V4.1-Flash';
    const models = ['DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Lite'];
    Map<String, dynamic> channel() => {
      'id': 'trae',
      'name': 'trae',
      'baseUrl': 'https://trae.invalid/v1',
      'wire': 'chat',
      'model': servedModel,
      'models': models,
      'apiKeyConfigured': true,
      'active': true,
    };
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'trae',
            'channels': [channel()],
          });
        }
        if (request.url.path == '/api/channels/save' && request.method == 'POST') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          servedModel = body['model']?.toString() ?? servedModel;
          return _json(channel());
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: _ModelSheetHost(state: state)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-model-sheet')));
    await tester.pumpAndSettle();

    // 渠道（含 wire 标记）要出现在模型池里；不是 codex 官方模型目录。
    expect(find.text('trae'), findsWidgets);
    expect(find.text('OpenAI 兼容'), findsWidgets);
    // 底部「新增渠道」入口复用渠道页表单（由调用方提供导航）。
    expect(find.byKey(const Key('model-sheet-add-channel')), findsOneWidget);
    await tester.tap(find.byKey(const Key('sheet-channel-header-trae')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sheet-model-trae-DeepSeek-V4.1-Flash')), findsOneWidget);

    await tester.tap(find.byKey(const Key('sheet-model-trae-DeepSeek-V4.1-Lite')));
    await tester.pumpAndSettle();
    final saved = requests.singleWhere((request) => request.url.path == '/api/channels/save');
    final body = jsonDecode(saved.body) as Map<String, dynamic>;
    expect(body['id'], 'trae');
    expect(body['wire'], 'openai-chat');
    expect(body['model'], 'DeepSeek-V4.1-Lite');
    // 模型池绝不能再走 /api/providers 或把官方模型写进 /api/config。
    expect(
      requests.where((request) => request.url.path == '/api/config' || request.url.path.startsWith('/api/providers')),
      isEmpty,
    );
    // 选完立刻反映在标题上（活动渠道保存即生效）。
    expect(find.textContaining('当前：DeepSeek-V4.1-Lite'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('conversation model sheet switches channels with one tap', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    var active = 'trae';
    List<Map<String, dynamic>> channels() => [
      {
        'id': 'trae',
        'name': 'trae',
        'baseUrl': 'https://trae.invalid/v1',
        'wire': 'openai-chat',
        'model': 'DeepSeek-V4.1-Flash',
        'models': ['DeepSeek-V4.1-Flash'],
        'apiKeyConfigured': true,
        'active': active == 'trae',
      },
      {
        'id': 'ly',
        'name': 'ly',
        'baseUrl': 'https://ly.invalid/v1',
        'wire': 'openai-chat',
        'model': 'deepseek-v4.1-flash',
        'models': ['deepseek-v4.1-flash'],
        'apiKeyConfigured': true,
        'active': active == 'ly',
      },
    ];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels') return _json({'active': active, 'channels': channels()});
        if (request.url.path == '/api/channels/activate') {
          active = (jsonDecode(request.body) as Map<String, dynamic>)['id'].toString();
          return _json({'active': active, 'channels': channels()});
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: _ModelSheetHost(state: state)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-model-sheet')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('quick-channel-trae')), findsOneWidget);
    expect(find.byKey(const Key('quick-channel-ly')), findsOneWidget);
    await tester.tap(find.byKey(const Key('quick-channel-ly')));
    await tester.pumpAndSettle();
    final activations = requests.where((request) => request.url.path == '/api/channels/activate').toList();
    expect(activations, hasLength(1));
    expect((jsonDecode(activations.single.body) as Map<String, dynamic>)['id'], 'ly');
    expect(state.activeChannel?['id'], 'ly');
    expect(find.textContaining('当前：deepseek-v4.1-flash · ly'), findsOneWidget);
    // 快速切换不需要拉模型，也不能改走旧的 provider 路径（读取 /api/config 同步模型是允许的）。
    expect(requests.where((request) => request.url.path == '/api/channels/models'), isEmpty);
    expect(requests.where((request) => request.url.path == '/api/providers'), isEmpty);
    expect(requests.where((request) => request.url.path == '/api/config' && request.method == 'POST'), isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('blocked channel switch offers stop-and-switch and then activates', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    var active = 'trae';
    var blocked = true;
    List<Map<String, dynamic>> channels() => [
      {
        'id': 'trae',
        'name': 'trae',
        'baseUrl': 'https://trae.invalid/v1',
        'wire': 'openai-chat',
        'model': 'm1',
        'models': ['m1'],
        'apiKeyConfigured': true,
        'active': active == 'trae',
      },
      {
        'id': 'ly',
        'name': 'ly',
        'baseUrl': 'https://ly.invalid/v1',
        'wire': 'openai-chat',
        'model': 'm2',
        'models': ['m2'],
        'apiKeyConfigured': true,
        'active': active == 'ly',
      },
    ];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels') return _json({'active': active, 'channels': channels()});
        if (request.url.path == '/api/channels/activate') {
          if (blocked) {
            return _json({
              'error': {
                'code': 'codex/busy',
                'message': 'Cannot switch provider channels during an active turn',
                'details': {
                  'activeTurns': ['t1'],
                },
              },
            }, 409);
          }
          active = (jsonDecode(request.body) as Map<String, dynamic>)['id'].toString();
          return _json({'active': active, 'channels': channels()});
        }
        if (request.url.path == '/api/turn/interrupt-all') {
          blocked = false;
          return _json({
            'interrupted': [
              {'threadId': 't1'},
            ],
            'failed': [],
            'remaining': [],
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: _ModelSheetHost(state: state)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-model-sheet')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('quick-channel-ly')));
    await tester.pumpAndSettle();
    // 不能只甩一句错误：要给出「停止并切换」。
    expect(find.text('有正在进行的回合'), findsOneWidget);
    await tester.tap(find.byKey(const Key('stop-and-switch-channel')));
    await tester.pumpAndSettle();
    expect(requests.any((request) => request.url.path == '/api/turn/interrupt-all'), isTrue);
    expect(state.activeChannel?['id'], 'ly');
    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('expanding a channel with no models fetches and persists them', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final requests = <http.Request>[];
    var servedModels = <String>[];
    Map<String, dynamic> channel() => {
      'id': 'trae',
      'name': 'trae',
      'baseUrl': 'https://trae.invalid/v1',
      'wire': 'chat',
      'model': 'DeepSeek-V4.1-Flash',
      'models': servedModels,
      'apiKeyConfigured': true,
      'active': true,
    };
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'trae',
            'channels': [channel()],
          });
        }
        if (request.url.path == '/api/channels/models' && request.method == 'POST') {
          return _json({
            'models': [
              {'id': 'DeepSeek-V4.1-Flash'},
              {'id': 'DeepSeek-V4.1-Lite'},
            ],
          });
        }
        if (request.url.path == '/api/channels/save' && request.method == 'POST') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          servedModels = ((body['models'] as List?) ?? const []).map((entry) => entry.toString()).toList();
          return _json(channel());
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: _ModelSheetHost(state: state)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-model-sheet')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('sheet-channel-header-trae')));
    await tester.pumpAndSettle();
    // 空列表才拉：按 id 走 /api/channels/models，再把结果写回渠道。
    final fetch = requests.singleWhere((request) => request.url.path == '/api/channels/models');
    expect(jsonDecode(fetch.body)['id'], 'trae');
    final saved = requests.singleWhere((request) => request.url.path == '/api/channels/save');
    final body = jsonDecode(saved.body) as Map<String, dynamic>;
    expect(body['models'], ['DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Lite']);
    expect(body['wire'], 'openai-chat');
    expect(find.byKey(const Key('sheet-model-trae-DeepSeek-V4.1-Lite')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  testWidgets('channel model fetch failure shows the bridge text instead of a fake list', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'trae',
            'channels': [
              {
                'id': 'trae',
                'name': 'trae',
                'baseUrl': 'https://trae.invalid/v1',
                'wire': 'chat',
                'model': 'DeepSeek-V4.1-Flash',
                'models': <Object>[],
                'apiKeyConfigured': true,
                'active': true,
              },
            ],
          });
        }
        if (request.url.path == '/api/channels/models' && request.method == 'POST') {
          return _json({
            'error': {'code': 'channel/models-fetch', 'message': 'upstream said 4023 model_unknown'},
          }, 502);
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client);
    await tester.pumpWidget(MaterialApp(home: _ModelSheetHost(state: state)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-model-sheet')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sheet-channel-header-trae')));
    await tester.pumpAndSettle();
    expect(find.textContaining('4023 model_unknown'), findsOneWidget);
    expect(find.byKey(const Key('sheet-model-trae-DeepSeek-V4.1-Flash')), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  test('connect re-activates the active channel when codex config points elsewhere', () async {
    Map<String, dynamic> channel() => {
      'id': 'trae',
      'name': 'trae',
      'baseUrl': 'https://trae.invalid/v1',
      'wire': 'chat',
      'model': 'DeepSeek-V4.1-Flash',
      'models': const <String>[],
      'apiKeyConfigured': true,
      'active': true,
    };
    CodexBridgeClient makeClient(List<http.Request> requests, String provider) => CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/channels' && request.method == 'POST') {
          return _json({
            'active': 'trae',
            'channels': [channel()],
          });
        }
        if (request.url.path == '/api/channels/activate') {
          return _json({
            'active': 'trae',
            'channels': [channel()],
          });
        }
        if (request.url.path == '/api/config') {
          return http.Response('{"provider":"$provider","model":"gpt-6.2-sol","apiKeyConfigured":false}', 200);
        }
        return _appResponse(request);
      }),
    );

    // 时 provider（openai-custom）残留：连上后要重新 activate trae。
    final stale = <http.Request>[];
    final staleState = CodexPocketState(makeClient(stale, 'openai-custom'));
    await staleState.connect();
    final activates = stale.where((request) => request.url.path == '/api/channels/activate').toList();
    expect(activates, hasLength(1));
    expect(jsonDecode(activates.single.body), {'id': 'trae'});
    expect(staleState.config['provider'], 'trae');
    staleState.dispose();

    // config 已经指向该渠道时不要重复写（避免每次重连部 activate）。
    final aligned = <http.Request>[];
    final alignedState = CodexPocketState(makeClient(aligned, 'trae'));
    await alignedState.connect();
    expect(aligned.where((request) => request.url.path == '/api/channels/activate'), isEmpty);
    alignedState.dispose();
  });

  testWidgets('retry noise lines never render as chat bubbles', (tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final events = StreamController<Map<String, dynamic>>.broadcast();
    addTearDown(events.close);
    final client = CodexBridgeClient(
      client: MockClient((request) async => _appResponse(request)),
      eventSource: (after) => events.stream,
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();

    events.add({'seq': 1, 'type': 'text.delta', 'itemId': 'm1', 'text': 'Reconnecting... 1/5\n这是真正的回答'});
    await tester.pumpAndSettle();
    expect(_rendersText(tester, '这是真正的回答'), isTrue);
    expect(_rendersText(tester, 'Reconnecting'), isFalse);
  });

  testWidgets('resumed history drops retry noise lines', (tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    SharedPreferences.setMockInitialValues({CodexPermissionsIntro.seenKey: true, 'codex.lastThread': 'thread-a'});
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        if (request.url.path == '/api/thread/resume') {
          return _json({
            'threadId': 'thread-a',
            'items': [
              {'type': 'agentMessage', 'id': 'a1', 'text': 'Reconnecting... 3/5'},
              {'type': 'agentMessage', 'id': 'a2', 'text': 'Retrying... 2/5\n恢复后的真实回答'},
            ],
          });
        }
        return _appResponse(request);
      }),
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();
    expect(_rendersText(tester, '恢复后的真实回答'), isTrue);
    expect(_rendersText(tester, 'Reconnecting'), isFalse);
    expect(_rendersText(tester, 'Retrying'), isFalse);
  });

  // ---- 消息级交互：思考链在每条回答上方 + 每条消息的快捷操作 ----

  test('turn keys keep one turn of reasoning and answer in the same block', () {
    final keys = chatTurnKeys([
      PocketEvent('user', '第一闭'),
      PocketEvent('reasoning', '想一想', turnId: 'turn-1'),
      PocketEvent('text.delta', '第一答', itemType: 'agent_message', turnId: 'turn-1'),
      PocketEvent('user', '第二闭'),
      // 老桥的思考事件不带 turnId：按用户消息切段，不能并进第一轮。
      PocketEvent('reasoning', '再想一想'),
      PocketEvent('text.delta', '第二答', itemType: 'agent_message'),
    ]);
    expect(keys[0], isNull, reason: '用户消息单独成行');
    expect(keys[1], 'turn:turn-1');
    expect(keys[2], 'turn:turn-1');
    expect(keys[3], isNull);
    expect(keys[4], isNot(keys[1]));
    expect(keys[4], keys[5], reason: '同一段回答的思考链和正文必须同址');
  });

  testWidgets('every answer keeps a 已完成 row above it after its turn ends', (tester) async {
    tester.view.physicalSize = const Size(900, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(
      CodexPocketApp(
        client: _mockClient(),
        enableRuntime: false,
        fixtureEvents: [
          PocketEvent('user', '第一问', threadId: 't1'),
          PocketEvent('reasoning', '先看第一问的上下文', threadId: 't1', turnId: 'turn-1'),
          PocketEvent('text.delta', '第一答', itemType: 'agent_message', threadId: 't1', turnId: 'turn-1'),
          PocketEvent('user', '第二问', threadId: 't1'),
          // 第二轮模型没给思考内容：也要留一行「已完成」，点开写明这轮没有思考内容。
          PocketEvent('text.delta', '第二答', itemType: 'agent_message', threadId: 't1', turnId: 'turn-2'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    final completed = find.byWidgetPredicate((widget) => widget is Text && (widget.data ?? '').contains('已完成'));
    expect(completed, findsNWidgets(2), reason: '每条回答上方都要有一行「已完成。');

    // 思考链属于这条回答：在回答正文上方，而不是散在对话里别的位置。
    final firstAnswer = find.byWidgetPredicate(
      (widget) => widget is RichText && widget.text.toPlainText().contains('第一答'),
    );
    final secondAnswer = find.byWidgetPredicate(
      (widget) => widget is RichText && widget.text.toPlainText().contains('第二答'),
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('reasoning-block-1'))).dy,
      lessThan(tester.getTopLeft(firstAnswer).dy),
    );
    expect(
      tester.getTopLeft(find.byKey(const Key('reasoning-block-4'))).dy,
      lessThan(tester.getTopLeft(secondAnswer).dy),
    );

    // 没有思考内容的那一轮点开也要有交代。
    await tester.tap(find.byKey(const Key('reasoning-toggle-4')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('reasoning-empty-body')), findsOneWidget);
  });

  testWidgets('message copy button puts that exact text on the clipboard', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add(((call.arguments as Map)['text'] ?? '').toString());
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await tester.pumpWidget(
      CodexPocketApp(
        client: _mockClient(),
        enableRuntime: false,
        fixtureEvents: [
          PocketEvent('user', '把这段复制走', threadId: 't1'),
          PocketEvent('text.delta', '回答正文', itemType: 'agent_message', threadId: 't1', turnId: 'turn-1'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('copy-message-0')));
    await tester.pump();
    expect(copied, ['把这段复制走']);
    expect(find.text('已复制'), findsOneWidget);

    // 等提示自己消失，再复制助手回答（不然提示条可能盖住消息下方的按钮）。
    await tester.pumpAndSettle(const Duration(seconds: 5));
    await tester.tap(find.byKey(const Key('copy-message-1')));
    await tester.pump();
    expect(copied.last, '回答正文');
  });

  test('branchFromTurn forks at that turn and loads the new thread', () async {
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/thread/fork') return _json({'threadId': 'thread-new', 'modelProvider': 'p'});
        if (request.url.path == '/api/thread/resume') {
          return _json({
            'threadId': 'thread-new',
            'items': [
              {
                'type': 'userMessage',
                'id': 'u1',
                'content': [
                  {'text': '第一问'},
                ],
              },
              {'type': 'agentMessage', 'id': 'a1', 'text': '第一答'},
            ],
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client)..threadId = 'thread-old';
    final created = await state.branchFromTurn('turn-x');

    expect(created, 'thread-new');
    final fork = requests.singleWhere((request) => request.url.path == '/api/thread/fork');
    final body = jsonDecode(fork.body) as Map<String, dynamic>;
    expect(body['threadId'], 'thread-old');
    expect(body['lastTurnId'], 'turn-x');
    expect(requests.any((request) => request.url.path == '/api/thread/resume'), isTrue);
    expect(state.threadId, 'thread-new');
    expect(state.events.map((event) => event.payload), ['第一问', '第一答']);
    expect(state.error, isNull);
    state.dispose();
  });

  test('editing the first message branches from the start and resends without duplicates', () async {
    final requests = <http.Request>[];
    final client = CodexBridgeClient(
      client: MockClient((request) async {
        requests.add(request);
        // 第一条消息没有更早回合可分支：桥整段照抄历史。
        if (request.url.path == '/api/thread/fork') return _json({'threadId': 'thread-new'});
        if (request.url.path == '/api/thread/resume') {
          return _json({
            'threadId': 'thread-new',
            'items': [
              {
                'type': 'userMessage',
                'id': 'u1',
                'content': [
                  {'text': '旧问题'},
                ],
              },
              {'type': 'agentMessage', 'id': 'a1', 'text': '旧回答'},
            ],
          });
        }
        return _appResponse(request);
      }),
    );
    final state = CodexPocketState(client)
      ..threadId = 'thread-old'
      ..events = [
        PocketEvent('user', '旧问题', threadId: 'thread-old'),
        PocketEvent('text.delta', '旧回答', itemType: 'agent_message', threadId: 'thread-old', turnId: 'turn-1'),
      ];
    await state.editAndResend(0, '新问题', cwd: '/work');

    final fork = requests.singleWhere((request) => request.url.path == '/api/thread/fork');
    expect((jsonDecode(fork.body) as Map<String, dynamic>).containsKey('lastTurnId'), isFalse);
    final send = requests.singleWhere((request) => request.url.path == '/api/turn/send');
    expect((jsonDecode(send.body) as Map<String, dynamic>)['text'], '新问题');
    expect(state.events.where((event) => event.type == 'user').map((event) => event.payload), ['新问题']);
    state.dispose();
  });

  testWidgets('a user message offers edit-and-resend with the original text prefilled', (tester) async {
    await tester.pumpWidget(
      CodexPocketApp(
        client: _mockClient(),
        enableRuntime: false,
        fixtureEvents: [
          PocketEvent('user', '原来是这样问的', threadId: 't1'),
          PocketEvent('text.delta', '回答', itemType: 'agent_message', threadId: 't1', turnId: 'turn-1'),
        ],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('edit-message-0')));
    await tester.pumpAndSettle();
    final field = tester.widget<TextField>(find.byKey(const Key('edit-message-field')));
    expect(field.controller?.text, '原来是这样问的');
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    // 长按同一条消息也能叫出这组操作，不依赖鼠标。
    await tester.longPress(find.byKey(const Key('message-bubble-0')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('menu-edit-0')), findsOneWidget);
    expect(find.byKey(const Key('menu-copy-0')), findsOneWidget);
  });

  testWidgets('diff card collapses, expands and copies the complete patch', (tester) async {
    const patch = 'diff --git a/lib/a.dart b/lib/a.dart\n@@ -1 +1 @@\n-old\n+new';
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add(((call.arguments as Map)['text'] ?? '').toString());
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await tester.pumpWidget(
      CodexPocketApp(
        client: _mockClient(),
        enableRuntime: false,
        fixtureEvents: [PocketEvent('diff', patch, itemId: 'file1', threadId: 't1', turnId: 'turn-1')],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('reasoning-toggle-0')));
    await tester.pumpAndSettle();
    expect(find.text('lib/a.dart'), findsOneWidget);
    expect(find.text('补丁 · +1 / −1'), findsOneWidget);
    expect(find.text('+new'), findsNothing);
    await tester.tap(find.byKey(const Key('diff-toggle-0')));
    await tester.pumpAndSettle();
    expect(find.text('+new'), findsOneWidget);
    await tester.tap(find.byKey(const Key('copy-diff-0')));
    await tester.pump();
    expect(copied, [patch]);
  });

  testWidgets('tool cards stay visible inside their turn thinking block', (tester) async {
    await tester.pumpWidget(
      CodexPocketApp(
        client: _mockClient(),
        enableRuntime: false,
        fixtureEvents: [
          PocketEvent('reasoning', '先跑一下测试', threadId: 't1', turnId: 'turn-1'),
          PocketEvent('tool.start', '', name: 'bash', status: 'completed', threadId: 't1', turnId: 'turn-1'),
          PocketEvent('text.delta', '测试通过', itemType: 'agent_message', threadId: 't1', turnId: 'turn-1'),
        ],
      ),
    );
    await tester.pumpAndSettle();
    // 思考和工具共享同一个折叠块，默认只留一行摘要。
    expect(find.byKey(const Key('reasoning-done-0')), findsOneWidget);
    expect(find.text('bash'), findsNothing);
    // 展开同一个块后，思考正文和工具卡一起出现。

    await tester.tap(find.byKey(const Key('reasoning-toggle-0')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('reasoning-body-0')), findsOneWidget);
    expect(find.text('bash'), findsOneWidget);
  });

  testWidgets('a live turn shows Codex 正在工作 above its answer, then 已完成 · Ns', (tester) async {
    final events = StreamController<Map<String, dynamic>>.broadcast();
    addTearDown(events.close);
    final client = CodexBridgeClient(
      client: MockClient((request) async => _appResponse(request)),
      eventSource: (after) => events.stream,
    );
    await tester.pumpWidget(CodexPocketApp(client: client, enableRuntime: false));
    await tester.pumpAndSettle();

    var seq = 0;
    events.add({'seq': ++seq, 'type': 'turn.start', 'turnId': 'turn-1'});
    events.add({'seq': ++seq, 'type': 'reasoning.delta', 'turnId': 'turn-1', 'itemId': 'r1', 'text': '先想清楚'});
    events.add({'seq': ++seq, 'type': 'text.delta', 'turnId': 'turn-1', 'itemId': 'a1', 'text': '正在生成'});
    await tester.pump(const Duration(milliseconds: 30));
    expect(find.textContaining('Codex 正在工作'), findsOneWidget);
    final answer = find.byWidgetPredicate((widget) => widget is RichText && widget.text.toPlainText().contains('正在生成'));
    expect(tester.getTopLeft(find.byKey(const Key('reasoning-block-0'))).dy, lessThan(tester.getTopLeft(answer).dy));

    events.add({'seq': ++seq, 'type': 'turn.end', 'turnId': 'turn-1', 'status': 'completed'});
    await tester.pumpAndSettle();
    expect(find.textContaining('Codex 正在工作'), findsNothing);
    expect(find.byKey(const Key('reasoning-done-0')), findsOneWidget);
    expect(_rendersText(tester, '正在生成'), isTrue);
  });

  testWidgets('phone capability page gates higher tiers behind the disclaimer', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final bridge = _FakeDeviceBridge()..attach();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    await _openPhoneCapabilities(tester);
    // 第一次进页面先弹免责声明，四条都在，没勾选就不能同意。
    expect(find.text('手机能力授权说明'), findsOneWidget);
    expect(find.textContaining('只在本机使用'), findsOneWidget);
    expect(find.textContaining('请自行确认每一步要做什么'), findsOneWidget);
    expect(find.textContaining('随时可以在'), findsOneWidget);
    expect(find.textContaining('默认不提供'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('device-consent-agree'))).onPressed, isNull);
    expect(bridge.calls.map((call) => call.method), isNot(contains('acceptConsent')));

    await tester.tap(find.byKey(const Key('device-consent-check')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('device-consent-agree')));
    await tester.pumpAndSettle();
    expect(bridge.calls.map((call) => call.method), contains('acceptConsent'));
    expect(find.text('手机能力授权说明'), findsNothing);
    expect(find.textContaining('设备通道未开启'), findsOneWidget);
  });

  testWidgets('switching to ACCESSIBILITY goes through the device channel and points at the system setting', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final bridge = _FakeDeviceBridge(consent: true)..attach();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    final page = await _openPhoneCapabilities(tester);
    final card = find.byKey(const Key('device-tier-accessibility'));
    await tester.scrollUntilVisible(card, 160, scrollable: page);
    await tester.tap(card);
    await tester.pumpAndSettle();
    final switchCall = bridge.calls.lastWhere((call) => call.method == 'setTier');
    expect((switchCall.arguments as Map)['tier'], 'accessibility');
    // 无障碍没打开：如实提示，并把用户带到系统设置页，而不是假装档位已生效。
    expect(bridge.calls.map((call) => call.method), contains('openSettings'));
    expect(bridge.calls.lastWhere((call) => call.method == 'openSettings').arguments, {'target': 'accessibility'});
    expect(find.textContaining('还没打开无障碍服务'), findsOneWidget);
  });

  testWidgets('returning to standard closes the channel and deletes the handshake', (tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final bridge = _FakeDeviceBridge(consent: true, enabled: true, tier: 'accessibility')
      ..accessibilityEnabled = true
      ..attach();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    final page = await _openPhoneCapabilities(tester);
    expect(find.text('设备通道已开启'), findsOneWidget);
    final reset = find.byKey(const Key('device-reset-standard'));
    await tester.scrollUntilVisible(reset, 220, scrollable: page);
    await tester.tap(reset);
    await tester.pumpAndSettle();
    // 「立即退回标准权限」= 关闭通道 + 删握手文件 + 档位回 standard，全部在原生一次做完。
    expect(bridge.calls.map((call) => call.method), contains('disable'));
    expect(find.textContaining('设备通道未开启'), findsOneWidget);
    expect(find.textContaining('已退回标准权限'), findsOneWidget);
  });

  // ---- 首次启动授权向导（用户原话：权限要在刚进软件的时候就同意）----

  testWidgets('first launch shows the permissions wizard before anything else', (tester) async {
    _useTallPhone(tester);
    // 本地没有 codex.permissionsIntroSeen：这就是「第一次打开 App」。
    SharedPreferences.setMockInitialValues({});
    _FakeDeviceBridge().attach();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('permissions-wizard')), findsOneWidget);
    // 文案必须说清代价：不授权也能用 PRoot 全套，只是不能读屏点击。
    expect(find.textContaining('不授权也能用 PRoot 全套'), findsOneWidget);
    // 四条免责声明铺在向导里。
    expect(find.textContaining('请自行确认每一步要做什么'), findsOneWidget);
    expect(find.textContaining('默认不提供'), findsOneWidget);
    // 勾选门没打开时「完成设置」不可点。
    final finish = find.byKey(const Key('wizard-finish'));
    await tester.scrollUntilVisible(finish, 240, scrollable: _wizardScroll(tester));
    await tester.ensureVisible(finish);
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(finish).onPressed, isNull);
  });

  testWidgets('the permission wizard does not reappear once the intro was seen', (tester) async {
    SharedPreferences.setMockInitialValues({CodexPermissionsIntro.seenKey: true});
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('permissions-wizard')), findsNothing);
    // 主界面照常先用：向导不能挡着不让用。
    expect(find.byKey(const Key('open-drawer')), findsOneWidget);
  });

  testWidgets('tapping 悬浮窗 去授权 opens the system overlay page for this package', (tester) async {
    _useTallPhone(tester);
    SharedPreferences.setMockInitialValues({});
    final bridge = _FakeDeviceBridge()..attach();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    final grantOverlay = find.byKey(const Key('device-grant-overlay'));
    await tester.scrollUntilVisible(grantOverlay, 240, scrollable: _wizardScroll(tester));
    await tester.ensureVisible(grantOverlay);
    await tester.pumpAndSettle();
    await tester.tap(grantOverlay);
    await tester.pumpAndSettle();
    // 关键点：跳转参数必须是 overlay 这个 target（原生据此带 package: URI），不能只是弹个提示。
    expect(bridge.calls.lastWhere((call) => call.method == 'openSettings').arguments, {'target': 'overlay'});
  });

  testWidgets('保持标准权限 closes the wizard and remembers it was seen', (tester) async {
    _useTallPhone(tester);
    SharedPreferences.setMockInitialValues({});
    _FakeDeviceBridge().attach();
    await tester.pumpWidget(CodexPocketApp(client: _mockClient(), enableRuntime: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('permissions-wizard')), findsOneWidget);
    final keepStandard = find.byKey(const Key('wizard-keep-standard'));
    await tester.scrollUntilVisible(keepStandard, 240, scrollable: _wizardScroll(tester));
    await tester.ensureVisible(keepStandard);
    await tester.pumpAndSettle();
    await tester.tap(keepStandard);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('permissions-wizard')), findsNothing);
    // 记住了：pref 写 true，下次启动不再弹。
    expect((await SharedPreferences.getInstance()).getBool(CodexPermissionsIntro.seenKey), isTrue);
  });
}

/// 权限向导整页很长但一次性建好（产品侧是 SingleChildScrollView），所以滚动区只有一个。
Finder _wizardScroll(WidgetTester tester) =>
    find.descendant(of: find.byKey(const Key('permissions-wizard')), matching: find.byType(Scrollable)).first;

/// 权限向导内容很长：给它一块够高的屏，免得测试里因为布局溢出失败。
void _useTallPhone(WidgetTester tester) {
  tester.view.physicalSize = const Size(900, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

/// 从抽屉进「设置 → 手机能力」，返回该页的滚动区（页面是 push 出来的二级路由）。
Future<Finder> _openPhoneCapabilities(WidgetTester tester) async {
  await _openDrawer(tester);
  await tester.tap(find.byKey(const Key('drawer-settings')));
  await tester.pumpAndSettle();
  final tile = find.widgetWithText(ListTile, '手机能力');
  await tester.scrollUntilVisible(
    tile,
    160,
    scrollable: find.descendant(of: find.byKey(const Key('settings-home')), matching: find.byType(Scrollable)),
  );
  await tester.tap(tile);
  await tester.pumpAndSettle();
  return find.descendant(of: find.byKey(const Key('device-page')), matching: find.byType(Scrollable));
}

/// 假的原生设备通道：只回答 `codex/device` 的方法，并记下每次调用与参数。
/// 用它来断言「界面确实调了通道」，而不是在 Dart 里自说自话。
class _FakeDeviceBridge {
  _FakeDeviceBridge({this.consent = false, this.enabled = false, this.tier = 'standard'});

  bool consent;
  bool enabled;
  String tier;
  bool accessibilityEnabled = false;
  final List<MethodCall> calls = [];
  final TestDefaultBinaryMessenger _messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  void attach() {
    _messenger.setMockMethodCallHandler(kCodexDeviceChannel, (call) async {
      calls.add(call);
      switch (call.method) {
        case 'openSettings':
          return true;
        case 'acceptConsent':
          consent = true;
          return _state();
        case 'enable':
          enabled = true;
          return _state();
        case 'disable':
          enabled = false;
          tier = 'standard';
          return _state();
        case 'setTier':
          tier = (call.arguments as Map)['tier'] as String;
          return _state();
        default:
          return _state();
      }
    });
    addTearDown(() => _messenger.setMockMethodCallHandler(kCodexDeviceChannel, null));
  }

  Map<String, Object?> _state() => {
    'enabled': enabled,
    'baseUrl': enabled ? 'http://127.0.0.1:39217' : null,
    'tier': tier,
    'consent': consent,
    'capabilities': {'ui_dump': accessibilityEnabled, 'clipboard': enabled},
    'permissions': {
      'storage': 'denied',
      'overlay': 'denied',
      'batteryOptimization': 'optimized',
      'location': 'not-granted',
      'accessibility': accessibilityEnabled ? 'enabled' : 'disabled',
      'shizuku': 'not-installed',
      'admin': 'not-granted',
    },
    'tiers': {
      'standard': true,
      'accessibility': accessibilityEnabled,
      'debugger': false,
      'admin': false,
      'root': false,
    },
    'audit': <Object?>[],
    'handshake': '/root/.codex/codex-go-device.json',
  };
}

/// 两个抽屉两个入口：汉堡'= 设置与工具，汉堡右侧「历史。' 对话历史浮层。
Future<void> _openDrawer(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('open-drawer')));
  await tester.pumpAndSettle();
}

/// 对话历史是从左侧滑出的浮层，等动画结束再断言。
Future<void> _openHistory(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('open-history')));
  await tester.pumpAndSettle();
}

/// `http.Response(String, — ` 默认按 latin1 编码 body，中文'fixture 会直接抛错；
/// 带中文的假响应统一起 UTF-8 字节 + charset。
http.Response _json(Object data, [int status = 200]) => http.Response.bytes(
  utf8.encode(jsonEncode(data)),
  status,
  headers: const {'content-type': 'application/json; charset=utf-8'},
);

/// 首页握手需要的固定回答；其余路由由各测试按 method + path 自己匹配。
http.Response _appResponse(http.Request request) {
  switch (request.url.path) {
    case '/healthz':
      return http.Response('{"ok":true,"engine":"codex"}', 200);
    case '/api/thread/list':
      return http.Response('{"threads":[]}', 200);
    case '/api/config':
      return http.Response('{"provider":"openai","model":"gpt-test","apiKeyConfigured":false}', 200);
    case '/api/models':
      return http.Response('{"models":[]}', 200);
    case '/api/account':
      return http.Response('{"account":null}', 200);
    case '/api/events':
      return http.Response('', 200);
    default:
      return http.Response('{}', 200);
  }
}

String _modelFieldText(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(const Key('channel-model'))).controller!.text;

/// 界面上是否已经渲染出这段文字：正文走 GptMarkdown（Text/RichText 都可能））
/// 所以按 RichText 的纯文本来判断，而不是只手'Text 组件。
bool _rendersText(WidgetTester tester, String needle) =>
    tester.widgetList<RichText>(find.byType(RichText)).any((widget) => widget.text.toPlainText().contains(needle));

const List<int> _onePixelPng = <int>[
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  0,
  0,
  0,
  13,
  73,
  72,
  68,
  82,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  1,
  8,
  6,
  0,
  0,
  0,
  31,
  21,
  196,
  137,
  0,
  0,
  0,
  10,
  73,
  68,
  65,
  84,
  120,
  156,
  99,
  0,
  1,
  0,
  0,
  5,
  0,
  1,
  13,
  10,
  45,
  180,
  0,
  0,
  0,
  0,
  73,
  69,
  78,
  68,
  174,
  66,
  96,
  130,
];

CodexBridgeClient _mockClient() => CodexBridgeClient(client: MockClient((request) async => _appResponse(request)));

/// 历史抽屉专用：两条会话，ID 片段） f3a2c41 / 7b1d5e82）既不进标题也不进目录，
/// 所以能搜到就只可能是按 ID 命中。
CodexBridgeClient _historyClient() => CodexBridgeClient(
  client: MockClient((request) async {
    if (request.url.path == '/api/thread/list') {
      return _json({
        'threads': [
          {'id': 'thread-9f3a2c41', 'title': '整理发布清单', 'cwd': '/work/alpha', 'preview': '把发版步骤写清楚'},
          {'id': 'thread-7b1d5e82', 'title': '修复登录按钮', 'cwd': '/work/beta', 'preview': '点击之后没有反应'},
        ],
      });
    }
    return _appResponse(request);
  }),
);

/// 单独打开模型池弹层的最小宿主：不握手，所以断言里出现的请求只可能来自弹层。
class _ModelSheetHost extends StatelessWidget {
  const _ModelSheetHost({required this.state});
  final CodexPocketState state;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: TextButton(
        key: const Key('open-model-sheet'),
        onPressed: () => showCodexModelSheet(
          context,
          state: state,
          theme: kCodexThemes.first,
          reasoning: 'medium',
          onReasoning: (_) async {},
          onManageChannels: () {},
        ),
        child: const Text('模型求'),
      ),
    ),
  );
}

class _FakeRuntime implements CodexRuntimeApi {
  _FakeRuntime({this.bundledVersion});

  /// 完整包里内置的运行时版本；瘦包传 null。
  final String? bundledVersion;
  final actions = <String>[];
  final controller = StreamController<Map<String, dynamic>>.broadcast();
  var _phase = 'notInstalled';
  @override
  Stream<Map<String, dynamic>> get states => controller.stream;
  @override
  Future<bool> invokeBool(String method, Map<String, dynamic> args) async {
    actions.add(method);
    _phase = 'installed';
    final status = {'phase': _phase, 'installed': true, 'engine': 'codex-app-server'};
    controller.add(status);
    return true;
  }

  @override
  Future<Map<String, dynamic>> invoke(String method) async {
    actions.add(method);
    _phase = switch (method) {
      'install' => 'installed',
      'start' => 'running',
      'stop' => 'installed',
      _ => _phase,
    };
    final status = {
      'phase': _phase,
      'installed': _phase != 'notInstalled',
      'engine': 'codex-app-server',
      'bundledVersion': bundledVersion,
      'baseUrl': _phase == 'running' ? 'http://127.0.0.1:12345' : null,
      'token': _phase == 'running' ? 'fixture-token' : null,
      'logs': method == 'logs' ? ['runtime log fixture'] : <String>[],
    };
    controller.add(status);
    return status;
  }
}
