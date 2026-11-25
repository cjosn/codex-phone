import io
import sys

path = sys.argv[1]
text = io.open(path, encoding='utf-8').read()

pairs = [
    ("'text': '先理解问题，再组织答案 });", "'text': '先理解问题，再组织答案' });"),
    ("'OpenAI 兼容（chat） ,", "'OpenAI 兼容（chat）',"),
    ("PocketEvent('user', '第一问 , threadId: 't1'),", "PocketEvent('user', '第一问', threadId: 't1'),"),
    ("PocketEvent('user', '第二问 , threadId: 't1'),", "PocketEvent('user', '第二问', threadId: 't1'),"),
    ("(widget) => widget is Text && (widget.data ?? '').contains('已完成 ),", "(widget) => widget is Text && (widget.data ?? '').contains('已完成'),"),
    ("{'type': 'userMessage', 'id': 'u1', 'content': [{'text': '第一问 }]},", "{'type': 'userMessage', 'id': 'u1', 'content': [{'text': '第一问'}]},"),
    ("expect(state.events.map((event) => event.payload), ['第一问 , '第一答']);", "expect(state.events.map((event) => event.payload), ['第一问', '第一答']);"),
    ("PocketEvent('user', '原来是这样问的 , threadId: 't1'),", "PocketEvent('user', '原来是这样问的', threadId: 't1'),"),
    ("expect(field.controller?.text, '原来是这样问的 );", "expect(field.controller?.text, '原来是这样问的');"),
    ("expect(find.textContaining('随时可以在 ), findsOneWidget);", "expect(find.textContaining('随时可以在'), findsOneWidget);"),
    ("expect(find.textContaining('默认不提供 ), findsOneWidget);", "expect(find.textContaining('默认不提供'), findsOneWidget);"),
]

missing = []
for old, new in pairs:
    if old not in text:
        missing.append(old)
        continue
    text = text.replace(old, new)

io.open(path, 'w', encoding='utf-8').write(text)
print('patched', len(pairs) - len(missing), 'of', len(pairs))
for item in missing:
    print('MISSING:', item)
