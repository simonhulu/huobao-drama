"""Remove the separator gutters from a generated 2x2 temporal keyframe sheet.

The output remains one raster sheet. Remotion crops its four quadrants at
runtime; it does not receive separate character, prop, or card layers.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def crop_fill(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    target_width, target_height = size
    scale = max(target_width / image.width, target_height / image.height)
    resized = image.resize(
        (round(image.width * scale), round(image.height * scale)),
        Image.Resampling.LANCZOS,
    )
    left = max(0, (resized.width - target_width) // 2)
    top = max(0, (resized.height - target_height) // 2)
    return resized.crop((left, top, left + target_width, top + target_height))


def build_sheet(source: Path, destination: Path) -> None:
    image = Image.open(source).convert("RGB")
    width, height = image.size

    # The generator's white gutters are centered near these positions. Keep
    # only the image content on either side, then normalize every panel to the
    # same 16:9 frame before stitching it back into one source sheet.
    vertical_gutter = width // 2
    horizontal_gutter = height // 2
    gutter_width = 4
    gutter_height = 4
    left = (0, vertical_gutter - gutter_width // 2)
    right = (vertical_gutter + gutter_width // 2, width)
    top = (0, horizontal_gutter - gutter_height // 2)
    bottom = (horizontal_gutter + gutter_height // 2, height)

    panel_width = max(right[1] - right[0], left[1] - left[0])
    panel_height = max(bottom[1] - bottom[0], top[1] - top[0])
    panels = [
        image.crop((left[0], top[0], left[1], top[1])),
        image.crop((right[0], top[0], right[1], top[1])),
        image.crop((left[0], bottom[0], left[1], bottom[1])),
        image.crop((right[0], bottom[0], right[1], bottom[1])),
    ]

    # 1280x720 per panel keeps the runtime crop pixel-perfect for the demo.
    normalized = [crop_fill(panel, (1280, 720)) for panel in panels]
    sheet = Image.new("RGB", (2560, 1440))
    for index, panel in enumerate(normalized):
        x = (index % 2) * 1280
        y = (index // 2) * 720
        sheet.paste(panel, (x, y))

    destination.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(destination, format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    build_sheet(args.source, args.destination)


if __name__ == "__main__":
    main()
