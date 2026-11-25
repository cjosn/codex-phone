#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""修复被 PowerShell ANSI(cp936) 往返损坏的 Dart 测试文件（n-gram 版，快）。

损坏形态：`CJK(3字节) + 紧跟1字节` → `CJK前两字节 + 0x3F('?')`。
恢复：候选汉字由前两字节唯一约束（第 3 字节 0x80-0xBF 共 64 个），
丢失字节从常见集合里选；用仓库自身文本的 2-gram/3-gram 频次打分。
"""
import os
import re
import json
import collections

ROOT = r'C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go'
TARGET = os.path.join(ROOT, r'dshgo-fork\dsh-Go-main\app\test\codex_pocket\codex_pocket_test.dart')
OUT = TARGET + '.recovered'
DETAIL = os.path.join(ROOT, r'tooling\sdk\user-state\local\test-damage-sites-detail.json')

LOST = [' ', '\t', "'", '"', ')', ',', '.', ':', ';', ']', '}', '\r', '']
SKIP = ('node_modules', 'build', '.dart_tool', 'gradle-cache', 'pub-cache', '\\sdk\\', '.git', '\\dist\\')


def build_ngrams():
    tri = collections.Counter()
    bi = collections.Counter()
    exts = ('.dart', '.mjs', '.md', '.json', '.xml', '.kt', '.txt')
    seen = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        low = dirpath.lower()
        if any(s in low for s in SKIP):
            continue
        for name in filenames:
            if not name.endswith(exts):
                continue
            path = os.path.join(dirpath, name)
            try:
                if os.path.getsize(path) > 3 * 1024 * 1024:
                    continue
                text = open(path, 'rb').read().decode('utf-8', errors='ignore')
            except OSError:
                continue
            seen += 1
            for i in range(len(text) - 2):
                tri[text[i:i + 3]] += 1
                bi[text[i:i + 2]] += 1
    print('corpus files:', seen, 'trigrams:', len(tri))
    return tri, bi


def main():
    raw = open(TARGET, 'rb').read()
    tri, bi = build_ngrams()

    # 拆成片段 + 占位
    parts = []
    sites = []
    index = 0
    last = 0
    while index < len(raw) - 2:
        b0, b1, b2 = raw[index], raw[index + 1], raw[index + 2]
        if 0xE0 <= b0 <= 0xEF and 0x80 <= b1 <= 0xBF and b2 == 0x3F:
            parts.append(raw[last:index].decode('utf-8', errors='ignore'))
            parts.append('\x00')
            sites.append((b0, b1, index))
            index += 3
            last = index
            continue
        index += 1
    parts.append(raw[last:].decode('utf-8', errors='ignore'))
    text = ''.join(parts)

    detail = {}
    if os.path.exists(DETAIL):
        for item in json.load(open(DETAIL, encoding='utf-8')):
            detail[int(item.get('offset', -1))] = item

    out = []
    unresolved = []
    cursor = 0
    for n, match in enumerate(re.finditer('\x00', text)):
        out.append(text[cursor:match.start()])
        so_far = ''.join(out)
        b0, b1, offset = sites[n]
        left = so_far[-3:]
        right = text[match.start() + 1:match.start() + 4]

        cands = []
        for third in range(0x80, 0xC0):
            try:
                cands.append(bytes([b0, b1, third]).decode('utf-8'))
            except UnicodeDecodeError:
                pass

        forced = detail.get(offset)
        if forced:
            allowed = set(forced.get('candidates') or [])
            if allowed:
                narrowed = [c for c in cands if c in allowed]
                if narrowed:
                    cands = narrowed

        best = None
        best_score = -1
        for ch in cands:
            for lost in LOST:
                score = 0
                if len(left) >= 2:
                    score += tri.get(left[-2:] + ch, 0) * 12
                    score += bi.get(left[-1] + ch, 0) * 4
                tail = lost + right[:2]
                if len(tail) >= 2:
                    score += tri.get(ch + tail[:2], 0) * 12
                    score += bi.get(ch + lost, 0) * 3
                score += bi.get(ch + (right[:1] or ''), 0) * 2
                if score > best_score:
                    best_score = score
                    best = (ch, lost)
        if best is None:
            best = (cands[0], ' ')
        ch, lost = best
        if best_score <= 0:
            unresolved.append({'index': n, 'offset': offset, 'left': left, 'right': right, 'char': ch, 'byte': lost})
        out.append(ch + lost)
        cursor = match.start() + 1
    out.append(text[cursor:])
    result = ''.join(out)

    open(OUT, 'wb').write(result.encode('utf-8'))
    print('sites:', len(sites), 'unresolved:', len(unresolved), '->', OUT)
    for item in unresolved[:25]:
        print('  ', item)


if __name__ == '__main__':
    main()
