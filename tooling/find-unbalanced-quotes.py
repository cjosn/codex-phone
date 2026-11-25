import re
import sys

path = sys.argv[1]
lines = open(path, encoding='utf-8').read().split('\n')
bad = []
for index, line in enumerate(lines, 1):
    code = line
    # 去掉行内注释（粗略，够用：只处理 // 且在引号外的情形交给下一步）
    if code.count("'") % 2 == 1:
        bad.append((index, line))
print('lines with odd single quotes:', len(bad))
for index, line in bad[:40]:
    print(index, line.strip()[:120])
