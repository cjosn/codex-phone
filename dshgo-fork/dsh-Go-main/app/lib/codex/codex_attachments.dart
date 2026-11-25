import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const codexMaxImageBytes = 20 * 1024 * 1024;
const codexMaxFileBytes = 20 * 1024 * 1024;
const codexMaxTotalFileBytes = 64 * 1024 * 1024;
const codexMaxBatchImages = 4;
const codexMaxBatchImageBytes = 48 * 1024 * 1024;
const codexMaxBatchFileBytes = 16 * 1024 * 1024;
const _imageMimes = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'};
const _textMimes = {'text/plain', 'text/markdown', 'text/x-markdown'};

enum CodexAttachmentAction { images, files, clipboardImage }

/// In-memory only: no device path, persistence or automatic clipboard reads.
class CodexAttachment {
  CodexAttachment._({required this.name, required this.mime, required this.bytes, required this.truncated});

  factory CodexAttachment.fromBytes({
    required String name,
    required String mime,
    required Uint8List bytes,
    bool truncated = false,
  }) {
    if (name.isEmpty || utf8.encode(name).length > 255 || RegExp(r'[\x00-\x1f\x7f/\\]').hasMatch(name)) {
      throw const FormatException('附件名称无效');
    }
    if (_imageMimes.contains(mime)) {
      final extension = name.contains('.') ? name.split('.').last.toLowerCase() : '';
      if (extension.isNotEmpty && !{'png', 'jpg', 'jpeg', 'webp', 'gif'}.contains(extension)) {
        throw const FormatException('图片文件扩展名不受支持');
      }
      if (bytes.isEmpty || bytes.length > codexMaxImageBytes) {
        throw const FormatException('图片每张最多 20 MiB');
      }
      if (!_matchesImage(bytes, mime)) {
        throw const FormatException('图片内容与类型不符');
      }
      return CodexAttachment._(name: name, mime: mime, bytes: Uint8List.fromList(bytes), truncated: false);
    }
    if (!_textMimes.contains(mime) || !RegExp(r'\.(md|txt)$', caseSensitive: false).hasMatch(name)) {
      throw const FormatException('仅支持 PNG/JPEG/WebP/GIF 图片和 MD/TXT 文本');
    }
    if (bytes.length > codexMaxFileBytes) {
      throw const FormatException('文本附件每个最多 20 MiB');
    }
    final retained = Uint8List.fromList(bytes);
    final text = utf8.decode(retained); // Reject malformed UTF-8 and binary documents.
    if (text.contains('\u0000')) throw const FormatException('附件不是 UTF-8 文本');
    return CodexAttachment._(name: name, mime: mime, bytes: retained, truncated: truncated);
  }

  final String name;
  final String mime;
  final Uint8List bytes;
  final bool truncated;
  bool get isImage => _imageMimes.contains(mime);
  String get text => isImage ? '' : utf8.decode(bytes);
  String get dataURL => 'data:$mime;base64,${base64Encode(bytes)}';

  /// Spread into the existing request. An empty list produces no new keys.
  static Map<String, Object> toRequestFields(List<CodexAttachment> attachments) {
    final images = attachments.where((item) => item.isImage).map((item) => item.dataURL).toList();
    final files = attachments
        .where((item) => !item.isImage)
        .map((item) => <String, String>{'name': item.name, 'mime': item.mime, 'text': item.text})
        .toList();
    return {if (images.isNotEmpty) 'images': images, if (files.isNotEmpty) 'files': files};
  }
}

bool _matchesImage(Uint8List bytes, String mime) {
  bool starts(List<int> magic) =>
      bytes.length >= magic.length &&
      List.generate(magic.length, (index) => bytes[index] == magic[index]).every((value) => value);
  switch (mime) {
    case 'image/png':
      return starts([137, 80, 78, 71, 13, 10, 26, 10]);
    case 'image/jpeg':
      return starts([255, 216, 255]);
    case 'image/gif':
      return starts(ascii.encode('GIF87a')) || starts(ascii.encode('GIF89a'));
    case 'image/webp':
      return starts(ascii.encode('RIFF')) &&
          bytes.length >= 12 &&
          ascii.decode(bytes.sublist(8, 12), allowInvalid: true) == 'WEBP';
    default:
      return false;
  }
}

class CodexAttachmentSelection {
  const CodexAttachmentSelection({this.attachments = const [], this.warnings = const [], this.cancelled = false});
  final List<CodexAttachment> attachments;
  final List<String> warnings;
  final bool cancelled;
}

/// Reapply the cumulative text limit when adding another picker/clipboard selection.
/// Images are never dropped for count. Existing items retain identity, so callers
/// can safely remove them by item; text is never truncated to make it fit.
CodexAttachmentSelection mergeCodexAttachments(List<CodexAttachment> existing, List<CodexAttachment> incoming) {
  final items = <CodexAttachment>[];
  final warnings = <String>[];
  var fileBytes = 0;
  for (final item in [...existing, ...incoming]) {
    if (item.isImage) {
      items.add(item);
      continue;
    }
    if (fileBytes + item.bytes.length > codexMaxTotalFileBytes) {
      warnings.add('文本附件合计最多 64 MiB，已忽略「${item.name}」');
      continue;
    }
    items.add(item);
    fileBytes += item.bytes.length;
    if (item.truncated) warnings.add('「${item.name}」由来源标记为截断，请重新选择完整文件');
  }
  return CodexAttachmentSelection(attachments: List.unmodifiable(items), warnings: warnings);
}

/// Preserve attachment identity and flattened order while bounding each request.
/// A single 16–20 MiB document occupies its own batch: it remains intact here
/// and is split into UTF-8-safe model input parts by the bridge.
List<List<CodexAttachment>> codexMakeAttachmentBatches(List<CodexAttachment> attachments) {
  if (attachments.isEmpty) return [];
  final batches = <List<CodexAttachment>>[];
  var batch = <CodexAttachment>[];
  var imageCount = 0;
  var imageBytes = 0;
  var fileBytes = 0;

  void flush() {
    if (batch.isEmpty) return;
    batches.add(List.unmodifiable(batch));
    batch = <CodexAttachment>[];
    imageCount = 0;
    imageBytes = 0;
    fileBytes = 0;
  }

  for (final item in attachments) {
    final exceedsImageBudget =
        item.isImage && (imageCount >= codexMaxBatchImages || imageBytes + item.bytes.length > codexMaxBatchImageBytes);
    final exceedsFileBudget = !item.isImage && fileBytes + item.bytes.length > codexMaxBatchFileBytes;
    if (batch.isNotEmpty && (exceedsImageBudget || exceedsFileBudget)) flush();
    batch.add(item);
    if (item.isImage) {
      imageCount++;
      imageBytes += item.bytes.length;
    } else {
      fileBytes += item.bytes.length;
    }
  }
  flush();
  return List.unmodifiable(batches);
}

class CodexAttachmentPicker {
  const CodexAttachmentPicker({this.channel = const MethodChannel('codex/attachments')});
  final MethodChannel channel;

  Future<CodexAttachmentSelection> pickImages() => _invoke('pickImages');
  Future<CodexAttachmentSelection> pickFiles() => _invoke('pickFiles');

  /// Call only from a deliberate paste action. Never call during build/startup.
  Future<CodexAttachmentSelection> readClipboardImage() => _invoke('readClipboardImage');

  Future<CodexAttachmentSelection> _invoke(String method) async {
    final raw = await channel.invokeMapMethod<String, dynamic>(method);
    if (raw == null || raw['cancelled'] == true) {
      return const CodexAttachmentSelection(cancelled: true);
    }
    final items = <CodexAttachment>[];
    final warnings = (raw['warnings'] as List? ?? []).map((value) => value.toString()).toList();
    for (final value in raw['attachments'] as List? ?? []) {
      final item = value as Map;
      final bytes = item['bytes'];
      if (bytes is! Uint8List) throw const FormatException('附件数据无效');
      items.add(
        CodexAttachment.fromBytes(
          name: item['name'] as String,
          mime: item['mime'] as String,
          bytes: bytes,
          truncated: item['truncated'] == true,
        ),
      );
    }
    final selection = mergeCodexAttachments(const [], items);
    return CodexAttachmentSelection(attachments: selection.attachments, warnings: [...warnings, ...selection.warnings]);
  }
}

/// A transparent heuristic, never provider billing or measured model tokens.
int estimateCodexAttachmentTokens(String messageText, List<CodexAttachment> attachments) {
  var estimate = (utf8.encode(messageText).length / 3).ceil();
  for (final item in attachments) {
    estimate += item.isImage ? 4096 : (item.bytes.length / 3).ceil() + 64;
  }
  return estimate;
}

Future<CodexAttachmentAction?> showCodexAttachmentMenu(BuildContext context) =>
    showModalBottomSheet<CodexAttachmentAction>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('选择图片'),
              subtitle: const Text('数量不限，每张 20 MiB；按批发送'),
              onTap: () => Navigator.pop(context, CodexAttachmentAction.images),
            ),
            ListTile(
              leading: const Icon(Icons.description_outlined),
              title: const Text('选择 MD / TXT 文件'),
              subtitle: const Text('每文件 20 MiB，合计 64 MiB；完整保留内容'),
              onTap: () => Navigator.pop(context, CodexAttachmentAction.files),
            ),
            ListTile(
              leading: const Icon(Icons.content_paste_outlined),
              title: const Text('粘贴剪贴板图片'),
              onTap: () => Navigator.pop(context, CodexAttachmentAction.clipboardImage),
            ),
          ],
        ),
      ),
    );

class CodexAttachmentTray extends StatelessWidget {
  const CodexAttachmentTray({super.key, required this.attachments, required this.messageText, required this.onRemove});
  final List<CodexAttachment> attachments;
  final String messageText;
  final ValueChanged<CodexAttachment> onRemove;

  @override
  Widget build(BuildContext context) {
    if (attachments.isEmpty) return const SizedBox.shrink();
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 260),
          child: SingleChildScrollView(
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: attachments
                  .map(
                    (item) => Container(
                      width: item.isImage ? 112 : 220,
                      padding: const EdgeInsets.all(6),
                      decoration: BoxDecoration(
                        color: colors.surfaceContainerHighest,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Row(
                            children: [
                              Expanded(child: Text(item.name, maxLines: 1, overflow: TextOverflow.ellipsis)),
                              SizedBox(
                                width: 32,
                                height: 32,
                                child: IconButton(
                                  padding: EdgeInsets.zero,
                                  iconSize: 18,
                                  tooltip: '移除 ${item.name}',
                                  onPressed: () => onRemove(item),
                                  icon: const Icon(Icons.close),
                                ),
                              ),
                            ],
                          ),
                          if (item.isImage)
                            InkWell(
                              onTap: () => showDialog<void>(
                                context: context,
                                builder: (context) => Dialog(
                                  child: InteractiveViewer(
                                    child: Image.memory(item.bytes, errorBuilder: (_, _, _) => const Text('图片无法预览')),
                                  ),
                                ),
                              ),
                              child: Image.memory(
                                item.bytes,
                                width: 100,
                                height: 70,
                                fit: BoxFit.cover,
                                cacheWidth: 224,
                                errorBuilder: (_, _, _) =>
                                    const SizedBox(height: 70, child: Center(child: Text('图片无法预览'))),
                              ),
                            )
                          else
                            InkWell(
                              onTap: () => showDialog<void>(
                                context: context,
                                builder: (context) => AlertDialog(
                                  title: Text(item.name),
                                  content: SizedBox(
                                    width: 500,
                                    child: SingleChildScrollView(child: SelectableText(item.text)),
                                  ),
                                  actions: [
                                    TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
                                  ],
                                ),
                              ),
                              child: Text(item.text, maxLines: 3, overflow: TextOverflow.ellipsis),
                            ),
                          Text(
                            '${(item.bytes.length / 1024).toStringAsFixed(1)} KiB',
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                          if (item.truncated)
                            Text(
                              '已截断 · 仅发送预览内容',
                              style: TextStyle(color: colors.error, fontWeight: FontWeight.bold),
                            ),
                        ],
                      ),
                    ),
                  )
                  .toList(),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            '本条消息预计占用：约 ${estimateCodexAttachmentTokens(messageText, attachments)} tokens\n粗略估算，图片暂按每张 4096；实际随模型、分辨率与文档编码变化。',
            style: Theme.of(context).textTheme.labelSmall,
          ),
        ),
      ],
    );
  }
}
