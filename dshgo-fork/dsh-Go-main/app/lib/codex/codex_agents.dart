import 'package:flutter/foundation.dart';

int _integer(dynamic value) => value is num ? value.toInt() : 0;
String _state(dynamic value) => switch (value) {
  'completed' || 'success' => 'done',
  'timeout' || 'cancelled' || 'interrupted' => 'failed',
  final String text => text,
  _ => 'queued',
};

@immutable
class CodexAgentLog {
  const CodexAgentLog({
    required this.seq,
    required this.type,
    required this.level,
    required this.text,
    this.at,
    this.itemId,
    this.name,
    this.status,
    this.truncated = false,
    this.replace = false,
  });
  factory CodexAgentLog.fromMap(Map data) => CodexAgentLog(
    seq: _integer(data['seq']),
    type: '${data['type'] ?? 'text.delta'}',
    level: '${data['level'] ?? 'text'}',
    text: '${data['text'] ?? ''}',
    at: data['at'] is num ? DateTime.fromMillisecondsSinceEpoch(_integer(data['at'])) : null,
    itemId: data['itemId'] as String?,
    name: data['name'] as String?,
    status: data['status'] as String?,
    truncated: data['truncated'] == true,
    replace: data['replace'] == true,
  );
  final int seq;
  final String type, level, text;
  final DateTime? at;
  final String? itemId, name, status;
  final bool truncated, replace;
}

@immutable
class CodexAgent {
  CodexAgent.fromMap(Map data)
    : agentId = '${data['agentId'] ?? data['id'] ?? ''}',
      revision = _integer(data['revision']),
      name = '${data['name'] ?? data['title'] ?? 'Subagent'}',
      role = data['role'] as String?,
      task = '${data['task'] ?? ''}',
      state = _state(data['state'] ?? data['status']),
      parentId = data['parentId'] as String?,
      parentThreadId = data['parentThreadId'] as String?,
      agentThreadId = data['agentThreadId'] as String?,
      error = data['error']?.toString(),
      startedAt = data['startedAt'] is num ? DateTime.fromMillisecondsSinceEpoch(_integer(data['startedAt'])) : null,
      endedAt = data['endedAt'] is num ? DateTime.fromMillisecondsSinceEpoch(_integer(data['endedAt'])) : null,
      droppedLogs = _integer(data['droppedLogs']),
      droppedBytes = _integer(data['droppedBytes']),
      logs = List.unmodifiable((data['logs'] as List? ?? const []).whereType<Map>().map(CodexAgentLog.fromMap));
  final String agentId, name, task, state;
  final int revision, droppedLogs, droppedBytes;
  final String? role, parentId, parentThreadId, agentThreadId, error;
  final DateTime? startedAt, endedAt;
  final List<CodexAgentLog> logs;
  bool get active => state == 'queued' || state == 'running';

  Map<String, dynamic> toMap() => {
    'agentId': agentId,
    'revision': revision,
    'name': name,
    'role': role,
    'task': task,
    'state': state,
    'parentId': parentId,
    'parentThreadId': parentThreadId,
    'agentThreadId': agentThreadId,
    'error': error,
    'startedAt': startedAt?.millisecondsSinceEpoch,
    'endedAt': endedAt?.millisecondsSinceEpoch,
    'droppedLogs': droppedLogs,
    'droppedBytes': droppedBytes,
    'logs': [
      for (final log in logs)
        {
          'seq': log.seq,
          'type': log.type,
          'level': log.level,
          'text': log.text,
          'at': log.at?.millisecondsSinceEpoch,
          'itemId': log.itemId,
          'name': log.name,
          'status': log.status,
          'truncated': log.truncated,
          'replace': log.replace,
        },
    ],
  };
}

/// Independent agent board mirror. The owner supplies HTTP snapshots and SSE events.
/// A null parentThreadId shows the global board; no active-chat inference is made.
class CodexAgentsState extends ChangeNotifier {
  CodexAgentsState({this.parentThreadId});
  final String? parentThreadId;
  final Map<String, CodexAgent> _agents = {};
  final Map<String, int> _liveVersions = {};
  List<CodexAgent> get agents => List.unmodifiable(_agents.values);
  CodexAgent? agent(String id) => _agents[id];
  List<CodexAgent> children(String? parentId) => List.unmodifiable(
    _agents.values.where(
      (a) => parentId == null ? a.parentId == null || !_agents.containsKey(a.parentId) : a.parentId == parentId,
    ),
  );
  List<CodexAgent> forThread(String threadId) =>
      List.unmodifiable(_agents.values.where((a) => a.parentThreadId == threadId));

  bool _matches(Map data) => parentThreadId == null || data['parentThreadId'] == parentThreadId;

  void apply(Map event) {
    if (!'${event['type']}'.startsWith('agent.') || !_matches(event)) return;
    final id = '${event['agentId'] ?? ''}';
    if (id.isEmpty) return;
    final version = _integer(event['boardVersion']);
    if (version > (_liveVersions[id] ?? 0)) _liveVersions[id] = version;
    if (event['type'] == 'agent.removed') {
      if (_agents.remove(id) != null) notifyListeners();
      return;
    }
    final old = _agents[id];
    final revision = _integer(event['revision']);
    if (old != null && revision != 0 && old.revision > revision && event['type'] == 'agent.status') return;
    if (event['type'] == 'agent.status') {
      final data = {...?old?.toMap(), ...event};
      _agents[id] = CodexAgent.fromMap(data);
    } else if (event['type'] == 'agent.log') {
      final raw = event['log'];
      if (raw is! Map) return;
      final log = CodexAgentLog.fromMap(raw);
      final firstSeq = _integer(event['firstSeq']);
      final retainedFirst = old != null && old.droppedLogs > 0 && old.logs.isNotEmpty ? old.logs.first.seq : 0;
      final floor = firstSeq > retainedFirst ? firstSeq : retainedFirst;
      if (log.seq < floor) return;
      final logs = [...?old?.logs].where((e) => e.seq >= floor && e.seq != log.seq).toList()..add(log);
      logs.sort((a, b) => a.seq.compareTo(b.seq));
      final data = {
        ...?old?.toMap(),
        'agentId': id,
        'parentThreadId': event['parentThreadId'],
        'agentThreadId': event['agentThreadId'],
        'revision': revision > (old?.revision ?? 0) ? revision : old?.revision ?? 0,
        'droppedLogs': _integer(event['droppedLogs']) > (old?.droppedLogs ?? 0)
            ? _integer(event['droppedLogs'])
            : old?.droppedLogs ?? 0,
        'droppedBytes': _integer(event['droppedBytes']) > (old?.droppedBytes ?? 0)
            ? _integer(event['droppedBytes'])
            : old?.droppedBytes ?? 0,
      };
      data['logs'] = [
        for (final e in logs)
          {
            'seq': e.seq,
            'at': e.at?.millisecondsSinceEpoch,
            'type': e.type,
            'level': e.level,
            'text': e.text,
            'itemId': e.itemId,
            'name': e.name,
            'status': e.status,
            'truncated': e.truncated,
            'replace': e.replace,
          },
      ];
      _agents[id] = CodexAgent.fromMap(data);
    } else {
      return;
    }
    notifyListeners();
  }

  void replaceSnapshot(Map snapshot) {
    final previous = Map.of(_agents);
    final snapshotVersion = _integer(snapshot['boardVersion']);
    _agents.clear();
    for (final data in (snapshot['agents'] as List? ?? const []).whereType<Map>()) {
      if (!_matches(data)) continue;
      final next = CodexAgent.fromMap(data);
      if (next.agentId.isEmpty) continue;
      final old = previous[next.agentId];
      if ((_liveVersions[next.agentId] ?? 0) > snapshotVersion) {
        if (old != null) _agents[next.agentId] = old;
      } else {
        _agents[next.agentId] = old != null && old.revision > next.revision ? old : next;
      }
    }
    for (final entry in previous.entries) {
      if ((_liveVersions[entry.key] ?? 0) > snapshotVersion) _agents[entry.key] = entry.value;
    }
    _liveVersions.removeWhere((_, version) => version <= snapshotVersion);
    notifyListeners();
  }

  void clear() {
    _agents.clear();
    _liveVersions.clear();
    notifyListeners();
  }
}
