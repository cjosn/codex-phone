import 'dart:convert';

import 'package:dsh_app/codex/codex_attachments.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Uint8List png([int size = 8]) {
  final bytes = Uint8List(size);
  bytes.setRange(0, 8, [137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
}

CodexAttachment image([String name = 'photo.png']) =>
    CodexAttachment.fromBytes(name: name, mime: 'image/png', bytes: png());
CodexAttachment document(String text, [String name = 'notes.md']) =>
    CodexAttachment.fromBytes(name: name, mime: 'text/markdown', bytes: Uint8List.fromList(utf8.encode(text)));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('codex/attachments');
  const picker = CodexAttachmentPicker();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('empty attachments leave request keys unchanged; images/files serialize in memory', () {
    expect(CodexAttachment.toRequestFields([]), isEmpty);
    final fields = CodexAttachment.toRequestFields([image(), document('原文😀')]);
    expect(fields['images'], ['data:image/png;base64,${base64Encode(png())}']);
    expect(fields['files'], [
      {'name': 'notes.md', 'mime': 'text/markdown', 'text': '原文😀'},
    ]);
    expect(fields.toString(), isNot(contains('path')));
  });

  test('text beyond the old 200 KiB limit is retained with UTF8 intact', () {
    for (final value in ['é', '中', '😀']) {
      final text = '${'a' * (200 * 1024 - 1)}${value}tail';
      final item = document(text);
      expect(item.bytes.length, utf8.encode(text).length);
      expect(item.truncated, isFalse);
      expect(item.text, text);
    }
    expect(() => document('a' * (codexMaxFileBytes + 1)), throwsFormatException);
  });

  test('reject oversize images, dangerous extension/MIME, binary and invalid UTF8', () {
    for (final action in <void Function()>[
      () => CodexAttachment.fromBytes(name: 'big.png', mime: 'image/png', bytes: png(codexMaxImageBytes + 1)),
      () => CodexAttachment.fromBytes(name: 'x.svg', mime: 'image/svg+xml', bytes: Uint8List.fromList([1])),
      () => CodexAttachment.fromBytes(name: 'bad.apk', mime: 'image/png', bytes: png()),
      () => document('text', 'bad.exe'),
      () => document('text', '../bad.md'),
      () => document('a\u0000b'),
      () => CodexAttachment.fromBytes(name: 'x.txt', mime: 'text/plain', bytes: Uint8List.fromList([255])),
      () => CodexAttachment.fromBytes(name: 'x.png', mime: 'image/png', bytes: Uint8List.fromList([1, 2, 3])),
    ]) {
      expect(action, throwsFormatException);
    }
    expect(
      CodexAttachment.fromBytes(name: 'ok.png', mime: 'image/png', bytes: png(codexMaxImageBytes)).bytes.length,
      codexMaxImageBytes,
    );
  });

  test('merge retains twelve images and existing item identity without count warnings', () {
    final existing = List.generate(5, (index) => image('existing-$index.png'));
    final incoming = List.generate(7, (index) => image('incoming-$index.png'));
    final result = mergeCodexAttachments(existing, incoming);
    expect(result.attachments, hasLength(12));
    expect(result.attachments, [...existing, ...incoming]);
    expect(identical(result.attachments.first, existing.first), isTrue);
    expect(result.warnings, isEmpty);
  });

  test('cumulative multi-file limit accepts 64 MiB intact and rejects overflow whole', () {
    final sizes = [20, 20, 20, 4];
    final existing = [for (final size in sizes.take(2)) document('a' * (size * 1024 * 1024), '$size.md')];
    final incoming = [for (final size in sizes.skip(2)) document('a' * (size * 1024 * 1024), '$size.md')];
    final result = mergeCodexAttachments(existing, incoming);
    expect(result.attachments, [...existing, ...incoming]);
    expect(result.attachments.fold<int>(0, (sum, item) => sum + item.bytes.length), codexMaxTotalFileBytes);
    expect(result.attachments.every((item) => !item.truncated), isTrue);
    expect(result.warnings, isEmpty);

    final overflow = document('not truncated');
    final limited = mergeCodexAttachments(result.attachments, [overflow]);
    expect(limited.attachments, result.attachments);
    expect(limited.attachments, isNot(contains(overflow)));
    expect(limited.warnings.single, contains('64 MiB'));
  });

  test('empty batches and twelve images preserve every item in order', () {
    expect(codexMakeAttachmentBatches([]), isEmpty);
    final images = List.generate(12, (index) => image('$index.png'));
    final batches = codexMakeAttachmentBatches(images);
    expect(batches.map((batch) => batch.length), [4, 4, 4]);
    expect(batches.expand((batch) => batch), images);
    for (var batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      for (var itemIndex = 0; itemIndex < batches[batchIndex].length; itemIndex++) {
        expect(identical(batches[batchIndex][itemIndex], images[batchIndex * 4 + itemIndex]), isTrue);
      }
    }
  });

  test('large images split by 48 MiB before four-count limit', () {
    final images = [
      for (var index = 0; index < 3; index++)
        CodexAttachment.fromBytes(name: '$index.png', mime: 'image/png', bytes: png(codexMaxImageBytes)),
    ];
    final batches = codexMakeAttachmentBatches(images);
    expect(batches.map((batch) => batch.length), [2, 1]);
    expect(batches.expand((batch) => batch), images);
    expect(
      batches.every((batch) => batch.fold<int>(0, (sum, item) => sum + item.bytes.length) <= 48 * 1024 * 1024),
      isTrue,
    );
  });

  test('mixed batches retain order, share image/text batches and bound text', () {
    final firstImages = List.generate(4, (index) => image('$index.png'));
    final firstText = document('first');
    final secondText = document('a' * (16 * 1024 * 1024), 'second.md');
    final thirdText = document('third');
    final lastImage = image('last.png');
    final items = [...firstImages, firstText, secondText, thirdText, lastImage];
    final batches = codexMakeAttachmentBatches(items);
    expect(batches.expand((batch) => batch), items);
    expect(batches.first, [...firstImages, firstText]);
    expect(batches[1], [secondText]);
    expect(batches[2], [thirdText, lastImage]);
    expect(batches.every((batch) => batch.where((item) => item.isImage).length <= 4), isTrue);
    expect(
      batches.every(
        (batch) =>
            batch.where((item) => item.isImage).fold<int>(0, (sum, item) => sum + item.bytes.length) <=
            48 * 1024 * 1024,
      ),
      isTrue,
    );
    expect(
      batches.every(
        (batch) =>
            batch.where((item) => !item.isImage).fold<int>(0, (sum, item) => sum + item.bytes.length) <=
            16 * 1024 * 1024,
      ),
      isTrue,
    );
  });

  test('picker cancellation and null result do not produce attachments', () async {
    messenger.setMockMethodCallHandler(channel, (_) async => {'cancelled': true, 'attachments': []});
    expect((await picker.pickImages()).cancelled, isTrue);
    expect((await picker.pickFiles()).attachments, isEmpty);
    messenger.setMockMethodCallHandler(channel, (_) async => null);
    expect((await picker.pickFiles()).cancelled, isTrue);
  });

  test('manual clipboard action uses only image method and decodes Uint8List', () async {
    final calls = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return {
        'attachments': [
          {'name': 'clipboard.png', 'mime': 'image/png', 'bytes': png()},
        ],
        'warnings': [],
        'cancelled': false,
      };
    });
    expect(calls, isEmpty);
    final result = await picker.readClipboardImage();
    expect(calls, ['readClipboardImage']);
    expect(result.attachments.single.isImage, isTrue);
    expect(result.attachments.single.bytes, png());
  });

  test('clipboard unavailable warning and platform failure reach caller', () async {
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {
        'attachments': [],
        'warnings': ['剪贴板中没有可读取的图片。'],
      },
    );
    final result = await picker.readClipboardImage();
    expect(result.attachments, isEmpty);
    expect(result.cancelled, isFalse);
    expect(result.warnings.single, contains('剪贴板'));
    messenger.setMockMethodCallHandler(channel, (_) async => throw PlatformException(code: 'attachments/no-activity'));
    await expectLater(picker.pickImages(), throwsA(isA<PlatformException>()));
  });

  test('native truncation flag remains visible and malformed native image is rejected', () async {
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {
        'attachments': [
          {'name': 'a.txt', 'mime': 'text/plain', 'bytes': Uint8List.fromList(utf8.encode('保留')), 'truncated': true},
        ],
      },
    );
    final result = await picker.pickFiles();
    expect(result.attachments.single.truncated, isTrue);
    expect(result.warnings.single, contains('截断'));
    messenger.setMockMethodCallHandler(
      channel,
      (_) async => {
        'attachments': [
          {
            'name': 'a.png',
            'mime': 'image/png',
            'bytes': Uint8List.fromList([1]),
          },
        ],
      },
    );
    await expectLater(picker.pickImages(), throwsFormatException);
  });

  testWidgets('tray shows file preview, truncation, honest estimate and removal', (tester) async {
    final item = CodexAttachment.fromBytes(
      name: 'notes.md',
      mime: 'text/markdown',
      bytes: Uint8List.fromList(utf8.encode('legacy partial')),
      truncated: true,
    );
    CodexAttachment? removed;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CodexAttachmentTray(attachments: [item], messageText: 'hi', onRemove: (value) => removed = value),
        ),
      ),
    );
    expect(find.text('notes.md'), findsOneWidget);
    expect(
      find.byWidgetPredicate((widget) => widget is ConstrainedBox && widget.constraints.maxHeight == 260),
      findsOneWidget,
    );
    expect(
      find.descendant(of: find.byType(ConstrainedBox), matching: find.byType(SingleChildScrollView)),
      findsOneWidget,
    );
    expect(find.text('已截断 · 仅发送预览内容'), findsOneWidget);
    expect(find.textContaining('本条消息预计占用'), findsOneWidget);
    expect(find.textContaining('粗略估算'), findsOneWidget);
    await tester.tap(find.byTooltip('移除 notes.md'));
    expect(identical(removed, item), isTrue);
    expect(estimateCodexAttachmentTokens('', [image()]), 4096);
  });

  testWidgets('image tray opens a zoomable preview', (tester) async {
    final item = CodexAttachment.fromBytes(
      name: 'tiny.png',
      mime: 'image/png',
      bytes: base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGPwTt/yHxkzkC4AAAPnJlH/osXzAAAAAElFTkSuQmCC',
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CodexAttachmentTray(attachments: [item], messageText: 'describe', onRemove: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(Image), findsOneWidget);
    expect(find.text('图片无法预览'), findsNothing);
    await tester.tap(find.byType(Image));
    await tester.pumpAndSettle();
    expect(find.byType(InteractiveViewer), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('opening menu does not read clipboard; manual action returns enum', (tester) async {
    final calls = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return null;
    });
    CodexAttachmentAction? selected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                selected = await showCodexAttachmentMenu(context);
              },
              child: const Text('attach'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('attach'));
    await tester.pumpAndSettle();
    expect(calls, isEmpty);
    await tester.tap(find.text('粘贴剪贴板图片'));
    await tester.pumpAndSettle();
    expect(selected, CodexAttachmentAction.clipboardImage);
    expect(calls, isEmpty); // Parent explicitly invokes picker after the menu choice.
  });
}
