import re
src = r".\_handoff\operit-manual.txt"
lines = open(src, encoding="utf-8").read().split("\n")
packs, cur = [], None
for line in lines:
    m3 = re.match(r"^\[Heading 3\] (.+)$", line)
    m4 = re.match(r"^\[Heading 4\] (.+)$", line)
    if m3:
        cur = {"name": m3.group(1).strip(), "tools": []}
        packs.append(cur)
    elif m4 and cur is not None:
        cur["tools"].append(m4.group(1).strip())
out = []
for p in packs:
    if p["tools"]:
        out.append(f"{p['name']} ({len(p['tools'])}): " + ", ".join(p["tools"]))
open(r".\_handoff\operit-tools.txt", "w", encoding="utf-8").write("\n".join(out))
print(len(out), "pack sections,", sum(len(p["tools"]) for p in packs), "tools")
