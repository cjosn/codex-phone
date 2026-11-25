import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'package:dsh_app/codex/codex_pocket_state.dart';
import 'package:dsh_app/codex/codex_theme.dart';

class _FakeHttp extends http.BaseClient {
  _FakeHttp(this.handler);
  final Future<http.Response> Function(http.Request request) handler;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await handler(request as http.Request);
    return http.StreamedResponse(
      Stream.value(response.bodyBytes),
      response.statusCode,
      headers: response.headers,
      request: request,
    );
  }
}

Map<String, dynamic> _sentBody(http.Request request) => jsonDecode(request.body) as Map<String, dynamic>;
http.Response _json(Object value, [int status = 200]) =>
    http.Response(jsonEncode(value), status, headers: {'content-type': 'application/json'});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('legacy on-failure preference is migrated and persisted', () async {
    SharedPreferences.setMockInitialValues({'codex.approval': 'on-failure'});
    expect(await CodexPrefs.loadApproval(), 'on-request');
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('codex.approval'), 'on-request');
    await CodexPrefs.saveApproval('on-failure');
    expect(prefs.getString('codex.approval'), 'on-request');
  });

  test('agent events are consumed before main-thread filtering', () {
    final client = CodexBridgeClient(client: _FakeHttp((request) async => _json({})));
    final state = CodexPocketState(client)..threadId = 'main-thread';
    state.acceptEvent({
      'type': 'agent.status',
      'agentId': 'a1',
      'name': 'reader',
      'state': 'running',
      'parentThreadId': null,
      'agentThreadId': 'child-thread',
      'revision': 1,
      'boardVersion': 1,
    });
    state.acceptEvent({
      'type': 'text.delta',
      'threadId': 'child-thread',
      'turnId': 't',
      'itemId': 'i',
      'text': 'not main chat',
    });
    expect(state.agents.agent('a1')?.state, 'running');
    expect(state.events, isEmpty);
    state.dispose();
  });

  test('send adds attachments only when present and reports success honestly', () async {
    final bodies = <Map<String, dynamic>>[];
    final client = CodexBridgeClient(
      client: _FakeHttp((request) async {
        bodies.add(_sentBody(request));
        return _json({'threadId': 'thread-1', 'turnId': 'turn-1'});
      }),
    );
    final state = CodexPocketState(client)
      ..threadId = 'thread-1'
      ..config = {'model': 'fixture-model'};
    state.applyChannelListForTest({
      'active': 'fixture',
      'channels': [
        {'id': 'fixture', 'model': 'fixture-model'},
      ],
    });
    expect(await state.send('plain', cwd: '/fixture'), isTrue);
    expect(bodies.single['text'], 'plain');
    expect(bodies.single.containsKey('images'), isFalse);
    expect(bodies.single.containsKey('files'), isFalse);
    bodies.clear();
    expect(
      await state.send(
        'look',
        cwd: '/fixture',
        images: const ['data:image/png;base64,iVBORw0KGgo='],
        files: const [
          {'name': 'note.md', 'mime': 'text/markdown', 'text': 'original'},
        ],
      ),
      isTrue,
    );
    expect(bodies.single['images'], ['data:image/png;base64,iVBORw0KGgo=']);
    expect(bodies.single['files'], [
      {'name': 'note.md', 'mime': 'text/markdown', 'text': 'original'},
    ]);
    state.dispose();
  });

  test('failed send returns false and removes only the optimistic user row', () async {
    final client = CodexBridgeClient(
      client: _FakeHttp(
        (request) async => _json({
          'error': {'code': 'fixture/failure', 'message': 'no send'},
        }, 500),
      ),
    );
    final state = CodexPocketState(client)
      ..threadId = 'thread-1'
      ..config = {'model': 'fixture-model'};
    state.applyChannelListForTest({
      'active': 'fixture',
      'channels': [
        {'id': 'fixture', 'model': 'fixture-model'},
      ],
    });
    expect(
      await state.send(
        'keep draft',
        cwd: '/fixture',
        files: const [
          {'name': 'note.txt', 'mime': 'text/plain', 'text': 'kept'},
        ],
      ),
      isFalse,
    );
    expect(state.events.where((event) => event.type == 'user'), isEmpty);
    expect(state.error, contains('no send'));
    expect(state.busy, isFalse);
    state.dispose();
  });

  test('turn completion removes any unresolved approval cards', () {
    final client = CodexBridgeClient(client: _FakeHttp((request) async => _json({})));
    final state = CodexPocketState(client)..threadId = 'main-thread';
    state.acceptEvent({
      'type': 'approval.request',
      'approvalId': 'rpc:1',
      'threadId': 'main-thread',
      'turnId': 'turn-1',
      'payload': {'command': 'echo test'},
    });
    expect(state.events.where((event) => event.type == 'approval.request'), hasLength(1));
    state.acceptEvent({'type': 'turn.end', 'threadId': 'main-thread', 'turnId': 'turn-1', 'status': 'completed'});
    expect(state.events.where((event) => event.type == 'approval.request'), isEmpty);
    state.dispose();
  });

  test('expired approval click removes the dead card without showing an error', () async {
    final client = CodexBridgeClient(
      client: _FakeHttp(
        (request) async => _json({
          'error': {'code': 'codex/approval-expired', 'message': 'Approval is no longer pending'},
        }, 409),
      ),
    );
    final state = CodexPocketState(client)..threadId = 'main-thread';
    state.acceptEvent({
      'type': 'approval.request',
      'approvalId': 'rpc:stale',
      'threadId': 'main-thread',
      'turnId': 'turn-1',
      'payload': {'command': 'echo test'},
    });
    await state.approve('rpc:stale', true);
    expect(state.events.where((event) => event.type == 'approval.request'), isEmpty);
    expect(state.error, isNull);
    state.dispose();
  });

  test('history never restores an approval request as an actionable card', () async {
    final client = CodexBridgeClient(
      client: _FakeHttp(
        (request) async => _json({
          'threadId': 'main-thread',
          'items': [
            {
              'id': 'old-approval',
              'type': 'commandExecution/requestApproval',
              'text': 'approve old command',
              'approvalId': 'rpc:old',
            },
            {'id': 'answer', 'type': 'agentMessage', 'text': 'completed answer'},
          ],
        }),
      ),
    );
    final state = CodexPocketState(client);
    await state.resumeThread('main-thread');
    expect(state.events.where((event) => event.type.contains('approval')), isEmpty);
    expect(state.events.single.payload, 'completed answer');
    state.dispose();
  });
}
