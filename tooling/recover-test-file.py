#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""修复 PowerShell ANSI 往返损坏的 Dart 测试文件。

损坏形态（实测）：原本的 `CJK字符(3字节) + 紧随的1字节(通常是空格/引号)` 变成
`CJK前两字节 + 0x3F('?')`，即 4 字节 → 3 字节：
    E4 BE 8B 20   →   E4 BE 3F
恢复：给定前两字节 0xE0-0xEF / 0x80-0xBF，汉字候选 = 第三字节 0x80-0xBF 的 64 种；
丢失的那 1 字节从常见集合里选。用「仓库自身的中文文本」当语料打分。
"""
import os
import re
import sys
import json
import collections

ROOT = r'C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go'
TARGET = os.path.join(ROOT, r'dshgo-fork\dsh-Go-main\app\test\codex_pocket\codex_pocket_test.dart')
OUT = TARGET + '.recovered'

LOST_BYTES = [b' ', b'\t', b"'", b'"', b')', b',', b'.', b':', b';', b']', b'}']


def read_corpus():
    chunks = []
    exts = ('.dart', '.mjs', '.md', '.json', '.xml', '.kt', '.txt')
    skip = ('node_modules', 'build', '.dart_tool', 'gradle-cache', 'pub-cache', 'sdk\\', '.git')
    for dirpath, dirnames, filenames in os.walk(ROOT):
        low = dirpath.lower()
        if any(s in low for s in skip):
            continue
        for name in filenames:
            if not name.endswith(exts):
                continue
            path = os.path.join(dirpath, name)
            try:
                if os.path.getsize(path) > 4 * 1024 * 1024:
                    continue
                with open(path, 'rb') as handle:
                    data = handle.read()
                chunks.append(data.decode('utf-8', errors='ignore'))
            except OSError:
                continue
    return '\n'.join(chunks)


def main():
    raw = open(TARGET, 'rb').read()
    corpus = read_corpus()

    # 找出所有 [E0-EF][80-BF][3F] 的损坏点，重建文本
    pieces = []
    sites = []
    index = 0
    text_pos = 0
    while index < len(raw) - 2:
        b0, b1, b2 = raw[index], raw[index + 1], raw[index + 2]
        if 0xE0 <= b0 <= 0xEF and 0x80 <= b1 <= 0xBF and b2 == 0x3F:
            pieces.append(raw[text_pos:index].decode('utf-8', errors='ignore'))
            pieces.append('\x00')  # 占位符
            sites.append((b0, b1))
            index += 3
            text_pos = index
            continue
        index += 1
    pieces.append(raw[text_pos:].decode('utf-8', errors='ignore'))
    text = ''.join(pieces)

    if len(sites) != text.count('\x00'):
        print('site count mismatch', len(sites), text.count('\x00'))

    out = []
    unresolved = []
    cursor = 0
    for site_index, marker in enumerate([m.start() for m in re.finditer('\x00', text)]):
        out.append(text[cursor:marker])
        b0, b1 = sites[site_index]
        prefix = ''.join(out)[-4:]
        suffix = text[marker + 1:marker + 8]

        candidates = []
        for third in range(0x80, 0xC0):
            try:
                ch = bytes([b0, b1, third]).decode('utf-8')
            except UnicodeDecodeError:
                continue
            candidates.append(ch)

        best = None
        best_score = -1
        for ch in candidates:
            for lost in LOST_BYTES:
                needle = (prefix[-2:] + ch + lost.decode('utf-8') + suffix[:2]).encode('utf-8')
                score = corpus.count(needle.decode('utf-8'))
                # 弱证据：字符本身与前后文同时出现
                score2 = corpus.count((prefix[-1:] + ch).encode('utf-8').decode('utf-8')) if prefix else 0
                total = score * 10 + score2
                if total > best_score:
                    best_score = total
                    best = (ch, lost)
        if best is None:
            best = (candidates[0], b' ')
        ch, lost = best
        if best_score <= 0:
            unresolved.append((site_index, prefix, suffix))
        out.append(ch + lost.decode('utf-8', errors='ignore'))
        cursor = marker + 1
    out.append(text[cursor:])
    result = ''.join(out)

    with open(OUT, 'wb') as handle:
        handle.write(result.encode('utf-8'))
    print('sites:', len(sites), 'unresolved:', len(unresolved), '->', OUT)
    for item in unresolved[:40]:
        print('  unresolved', item)
    with open(os.path.join(os.path.dirname(TARGET), 'recover-report.json'), 'w', encoding='utf-8') as handle:
        json.dump({'sites': len(sites), 'unresolved': len(unresolved)}, handle)


if __name__ == '__main__':
    main()
