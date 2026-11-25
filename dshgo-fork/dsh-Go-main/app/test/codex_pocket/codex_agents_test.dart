import 'dart:async';

import 'package:dsh_app/codex/codex_agents.dart';
import 'package:dsh_app/codex/codex_agents_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> status(String id, String state, {String parent = 'main', int revision = 1}) => {
  'type': 'agent.status',
  'agentId': id,
  'state': state,
  'name': 'Worker $id',
  'role': 'Research',
  'task': 'Task $id',
  'parentThreadId': parent,
  'revision': revision,
};
Map<String, dynamic> log(String id, int seq, String type, String text, {int firstSeq = 1, int dropped = 0}) => {
  'type': 'agent.log',
  'agentId': id,
  'parentThreadId': 'main',
  'revision': seq + 2,
  'firstSeq': firstSeq,
  'droppedLogs': dropped,
  'droppedBytes': dropped * 100,
  'log': {
    'seq': seq,
    'type': type,
    'text': text,
    'level': type == 'reasoning.delta'
        ? 'reasoning'
        : type.startsWith('tool.')
        ? 'tool'
        : 'text',
  },
};

void main() {
  test('three simultaneous agents keep independent lifecycle and explicit parents', () {
    final state = CodexAgentsState(parentThreadId: 'main');
    addTearDown(state.dispose);
    for (final id in ['a', 'b', 'c']) {
      state.apply(status(id, 'queued'));
    }
    state.apply(status('other', 'running', parent: 'other'));
    expect(state.agents, hasLength(3));
    expect(state.agents.every((a) => a.state == 'queued'), isTrue);
    for (final id in ['a', 'b', 'c']) {
      state.apply(status(id, 'running', revision: 2));
    }
    state.apply({...status('b', 'completed', revision: 3), 'parentId': 'a'});
    state.apply({...status('c', 'timeout', revision: 3), 'error': 'timed out'});
    expect(state.children('a').single.agentId, 'b');
    expect(state.agent('b')!.state, 'done');
    expect(state.agent('c')!.state, 'failed');
    expect(state.agent('a')!.active, isTrue);
  });

  test('snapshot restoration, stale snapshot protection, log ordering and explicit pruning', () {
    final state = CodexAgentsState();
    addTearDown(state.dispose);
    state.replaceSnapshot({
      'agents': [
        {
          ...status('a', 'running', revision: 2),
          'logs': [
            {'seq': 1, 'type': 'reasoning.delta', 'level': 'reasoning', 'text': 'think'},
          ],
        },
      ],
    });
    state.apply(log('a', 3, 'text.delta', 'answer'));
    state.apply(log('a', 2, 'tool.start', 'fetch'));
    expect(state.agent('a')!.logs.map((e) => e.seq), [1, 2, 3]);
    state.replaceSnapshot({
      'agents': [status('a', 'queued', revision: 1)],
    });
    expect(state.agent('a')!.logs, hasLength(3));
    state.apply(log('a', 4, 'tool.output', '[truncated] result', firstSeq: 3, dropped: 2));
    expect(state.agent('a')!.logs.map((e) => e.seq), [3, 4]);
    expect(state.agent('a')!.droppedLogs, 2);
    state.apply({'type': 'agent.removed', 'agentId': 'a'});
    expect(state.agents, isEmpty);
  });

  test('snapshot cannot erase a newly queued agent or resurrect a removed agent', () {
    final state = CodexAgentsState();
    addTearDown(state.dispose);
    state.apply({...status('removed', 'done'), 'boardVersion': 10});
    state.apply({'type': 'agent.removed', 'agentId': 'removed', 'boardVersion': 12});
    state.apply({...status('new', 'queued'), 'boardVersion': 13});
    state.replaceSnapshot({
      'boardVersion': 11,
      'agents': [status('removed', 'done')],
    });
    expect(state.agent('removed'), isNull);
    expect(state.agent('new'), isNotNull);
    state.replaceSnapshot({'boardVersion': 14, 'agents': []});
    expect(state.agents, isEmpty);
  });

  testWidgets('board shows three cards, real logs, and restores after closing', (tester) async {
    final state = CodexAgentsState();
    addTearDown(state.dispose);
    for (final id in ['a', 'b', 'c']) {
      state.apply(status(id, 'queued'));
    }
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: CodexAgentsPanel(state: state)),
      ),
    );
    expect(find.byKey(const ValueKey('agent-card-a')), findsOneWidget);
    expect(find.text('排队中'), findsWidgets);
    state.apply(status('a', 'running', revision: 2));
    state.apply(log('a', 1, 'reasoning.delta', '真实思考片段'));
    state.apply(log('a', 2, 'tool.start', '真实工具参数'));
    state.apply(log('a', 3, 'text.delta', '真实正文结果'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('agent-card-a')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byWidgetPredicate((widget) => widget is SelectableText && widget.data == '真实思考片段'), findsOneWidget);
    expect(find.byWidgetPredicate((widget) => widget is SelectableText && widget.data == '真实工具参数'), findsOneWidget);
    expect(find.byWidgetPredicate((widget) => widget is SelectableText && widget.data == '真实正文结果'), findsOneWidget);
    state.apply(status('a', 'done', revision: 10));
    await tester.pump();
    expect(find.text('已完成'), findsWidgets);
    await tester.pageBack();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CodexAgentsPanel(
            state: state,
            refresh: () async {
              state.replaceSnapshot({'agents': state.agents.map((a) => a.toMap()).toList()});
            },
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('agent-card-a')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byWidgetPredicate((widget) => widget is SelectableText && widget.data == '真实思考片段'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('card with a real thread opens an interactive conversation instead of a log page', (tester) async {
    final state = CodexAgentsState();
    addTearDown(state.dispose);
    state.apply({...status('a', 'done'), 'agentThreadId': 'child-thread-a'});
    CodexAgent? opened;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CodexAgentsPanel(state: state, onOpenConversation: (agent) => opened = agent),
        ),
      ),
    );
    expect(find.textContaining('点击继续对话'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('agent-card-a')));
    expect(opened?.agentThreadId, 'child-thread-a');
    expect(opened?.name, 'Worker a');
  });

  testWidgets('loading empty error and retry states are visible', (tester) async {
    final state = CodexAgentsState();
    addTearDown(state.dispose);
    var attempts = 0;
    final pending = Completer<void>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CodexAgentsPanel(
            state: state,
            refresh: () {
              attempts++;
              return attempts == 1 ? pending.future : Future<void>.value();
            },
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('正在加载 Agent…'), findsOneWidget);
    pending.completeError(StateError('offline'));
    await tester.pump();
    expect(find.textContaining('offline'), findsOneWidget);
    expect(find.textContaining('暂无 Agent 任务'), findsOneWidget);
    await tester.tap(find.text('重试'));
    await tester.pump();
    expect(attempts, 2);
    expect(find.textContaining('offline'), findsNothing);
  });
}
