import io

path = 'test/bridge-contract.test.mjs'
text = io.open(path, encoding='utf-8').read()
lines = text.split('\n')
target = None
for index, line in enumerate(lines):
    if 'turn released after revert' in line:
        target = index
        break
if target is None:
    raise SystemExit('line with "turn released after revert" not found')

fixed = "      await until(async () => (await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, 'turn released after revert');"
print('old:', repr(lines[target]))
lines[target] = fixed
io.open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
print('new:', repr(fixed))
