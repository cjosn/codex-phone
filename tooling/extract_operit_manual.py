import sys
from docx import Document

path = r"D:\Downloads\Operit完全使用手册.docx"
doc = Document(path)
out = []
for p in doc.paragraphs:
    text = p.text.strip()
    if not text:
        continue
    style = p.style.name if p.style is not None else ""
    out.append(f"[{style}] {text}")
for table_index, table in enumerate(doc.tables):
    out.append(f"=== TABLE {table_index} ===")
    for row in table.rows:
        cells = [c.text.strip().replace("\n", " ") for c in row.cells]
        out.append(" | ".join(cells))

target = r"C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go\_handoff\operit-manual.txt"
with open(target, "w", encoding="utf-8") as handle:
    handle.write("\n".join(out))
print(f"paragraphs={len(doc.paragraphs)} tables={len(doc.tables)} lines={len(out)}")
