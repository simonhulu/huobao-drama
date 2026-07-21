#!/usr/bin/env python3
"""
把 data/temp/style-chart/ 里的风格样例图拼成带标签的网格图。
读取 meta.json 获取顺序和标签。
输出：data/temp/style-chart/style_grid.jpg
"""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

GRID_COLS = 3
THUMB_SIZE = 512
LABEL_HEIGHT = 48
BG_COLOR = (15, 17, 21)
TEXT_COLOR = (230, 230, 230)
BORDER_COLOR = (42, 46, 54)


def find_font():
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


def main():
    output_dir = sys.argv[1] if len(sys.argv) > 1 else "data/temp/style-chart"
    meta_path = os.path.join(output_dir, "meta.json")
    if not os.path.exists(meta_path):
        print(f"meta.json not found: {meta_path}")
        sys.exit(1)

    with open(meta_path, "r", encoding="utf-8") as f:
        items = json.load(f)

    if not items:
        print("No images to compose")
        sys.exit(1)

    font_path = find_font()
    font = ImageFont.truetype(font_path, 24) if font_path else ImageFont.load_default()

    rows = (len(items) + GRID_COLS - 1) // GRID_COLS
    grid_w = GRID_COLS * THUMB_SIZE
    grid_h = rows * (THUMB_SIZE + LABEL_HEIGHT)

    grid = Image.new("RGB", (grid_w, grid_h), BG_COLOR)
    draw = ImageDraw.Draw(grid)

    for idx, item in enumerate(items):
        img_path = item["localPath"]
        label = item["label"]
        col = idx % GRID_COLS
        row = idx // GRID_COLS
        x = col * THUMB_SIZE
        y = row * (THUMB_SIZE + LABEL_HEIGHT)

        img = Image.open(img_path)
        img = img.convert("RGB")
        img.thumbnail((THUMB_SIZE, THUMB_SIZE))

        # 居中贴图
        paste_x = x + (THUMB_SIZE - img.width) // 2
        paste_y = y + (THUMB_SIZE - img.height) // 2
        grid.paste(img, (paste_x, paste_y))

        # 边框
        draw.rectangle([x, y, x + THUMB_SIZE - 1, y + THUMB_SIZE - 1], outline=BORDER_COLOR, width=1)

        # 标签背景
        label_y = y + THUMB_SIZE
        draw.rectangle([x, label_y, x + THUMB_SIZE - 1, label_y + LABEL_HEIGHT - 1], fill=(24, 27, 33))

        # 标签文字居中
        bbox = draw.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        text_x = x + (THUMB_SIZE - text_w) // 2
        text_y = label_y + (LABEL_HEIGHT - text_h) // 2 - 2
        draw.text((text_x, text_y), label, font=font, fill=TEXT_COLOR)

    out_path = os.path.join(output_dir, "style_grid.jpg")
    grid.save(out_path, "JPEG", quality=92)
    print(f"Saved grid to: {out_path} ({grid_w}x{grid_h})")


if __name__ == "__main__":
    main()
