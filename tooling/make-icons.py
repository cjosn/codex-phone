"""生成 Codex Pocket 的启动图标（自适应前景 + 传统方图标）。

用法：python tooling/make-icons.py
输出到 app/android/app/src/main/res/mipmap-*/ 覆盖同名文件。
"""
import math
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RES = os.path.join(ROOT, 'dshgo-fork', 'dsh-Go-main', 'app', 'android', 'app', 'src', 'main', 'res')

BG = (245, 243, 236, 255)      # 奶油底
INK = (31, 32, 29, 255)        # 近黑
ACCENT = (75, 138, 99, 255)    # 绿色点缀（和界面里的"已连接"同色）

DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_mark(size, with_bg):
    """画一枚 mark：终端窗口 + 尖括号 + 光点。size 为正方形边长。"""
    scale = 4  # 超采样后缩小，边缘更干净
    s = size * scale
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if with_bg:
        # 传统图标：整块圆角方 + 背景色
        rounded(d, (0, 0, s - 1, s - 1), int(s * 0.22), BG)
        inset = s * 0.16
    else:
        # 自适应前景：内容只占中间 ~62%，留出安全区
        inset = s * 0.19

    x0, y0, x1, y1 = inset, inset, s - inset, s - inset
    w = x1 - x0
    h = y1 - y0

    # 终端窗口
    rounded(d, (x0, y0, x1, y1), int(w * 0.16), INK)

    # 顶部标题栏（挖一条）
    bar = y0 + h * 0.20
    d.rectangle((x0 + w * 0.10, y0 + h * 0.09, x1 - w * 0.10, y0 + h * 0.155), fill=(245, 243, 236, 255))

    # 尖括号 >
    stroke = max(2, int(w * 0.055))
    cx0, cy = x0 + w * 0.30, y0 + h * 0.60
    d.line([(cx0, cy - h * 0.13), (cx0 + w * 0.16, cy), (cx0, cy + h * 0.13)],
           fill=BG, width=stroke, joint='curve')
    # 下划线 _
    d.line([(cx0 + w * 0.24, cy + h * 0.13), (cx0 + w * 0.46, cy + h * 0.13)],
           fill=ACCENT, width=stroke)

    return img.resize((size, size), Image.LANCZOS)


def main():
    made = []
    for name, factor in DENSITIES.items():
        folder = os.path.join(RES, 'mipmap-' + name)
        if not os.path.isdir(folder):
            os.makedirs(folder, exist_ok=True)

        fg = int(round(108 * factor))      # 自适应前景 108dp
        legacy = int(round(48 * factor))   # 传统图标 48dp

        fg_img = draw_mark(fg, with_bg=False)
        fg_path = os.path.join(folder, 'ic_launcher_foreground.png')
        fg_img.save(fg_path)

        for fname in ('ic_launcher.png', 'ic_launcher_round.png'):
            legacy_img = draw_mark(legacy, with_bg=True)
            legacy_img.save(os.path.join(folder, fname))

        made.append((name, fg, legacy))

    for name, fg, legacy in made:
        print(f'  {name:<8} foreground={fg}px  legacy={legacy}px')
    print('图标已写入', RES)


if __name__ == '__main__':
    main()
