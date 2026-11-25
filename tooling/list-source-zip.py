import zipfile
p=r'C:\Users\13721\Documents\deepseek-harness\default-workspace\codex-go-source-2026-11-19.zip'
with zipfile.ZipFile(p) as z:
    for i,n in enumerate(z.namelist()[:160]): print(n)
