"""Build the production 2x1 sheets for the first 60 seconds of Episode 440.

This is a zero-generation step. Existing approved static images are reused;
Pillow only creates deterministic framing/tonal variants for the second state
when the legacy storyboard contains a single still. Remotion receives one
sheet per shot and crops its two cells at runtime.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
CELL = (1280, 720)
SOURCE_IMAGES = ROOT / "data" / "static" / "images"
LEGACY_SHEETS = SOURCE_IMAGES / "temporal-grid-episode-440-v5"
OUTPUT = SOURCE_IMAGES / "temporal-grid-episode-440-production-60s"


def fit(image: Image.Image, scale: float = 1.0, anchor_x: float = 0.5) -> Image.Image:
    image = image.convert("RGB")
    target_w = round(CELL[0] * scale)
    target_h = round(CELL[1] * scale)
    ratio = max(target_w / image.width, target_h / image.height)
    resized = image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)
    if resized.width < target_w or resized.height < target_h:
        resized = resized.resize((max(target_w, resized.width), max(target_h, resized.height)), Image.Resampling.LANCZOS)
    left = round(max(0, min(resized.width - target_w, (resized.width - target_w) * anchor_x)))
    top = max(0, (resized.height - target_h) // 2)
    return resized.crop((left, top, left + target_w, top + target_h))


def sheet(left: Image.Image, right: Image.Image, destination: Path) -> None:
    canvas = Image.new("RGB", (CELL[0] * 2, CELL[1]), (12, 10, 8))
    canvas.paste(fit(left), (0, 0))
    canvas.paste(fit(right), (CELL[0], 0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)


def build_derived(source_path: Path, destination: Path, mode: str) -> None:
    source = Image.open(source_path).convert("RGB")
    if mode == "fog":
        start = ImageEnhance.Contrast(source).enhance(1.18)
        start = ImageEnhance.Color(start).enhance(1.08).filter(ImageFilter.UnsharpMask(radius=1.2, percent=120, threshold=3))
        result = source.filter(ImageFilter.GaussianBlur(radius=4.2))
        result = ImageEnhance.Brightness(result).enhance(0.82)
    elif mode == "sides":
        start = fit(source, scale=1.55, anchor_x=0.12)
        start = ImageEnhance.Brightness(start).enhance(0.72)
        start_overlay = Image.new("RGBA", start.size, (0, 0, 0, 0))
        ImageDraw.Draw(start_overlay).rectangle((CELL[0] // 2, 0, CELL[0], CELL[1]), fill=(8, 4, 3, 150))
        start = Image.alpha_composite(start.convert("RGBA"), start_overlay).convert("RGB")
        result = fit(source, scale=1.55, anchor_x=0.88)
        result = ImageEnhance.Brightness(result).enhance(1.08)
        result_overlay = Image.new("RGBA", result.size, (0, 0, 0, 0))
        ImageDraw.Draw(result_overlay).rectangle((0, 0, CELL[0] // 2, CELL[1]), fill=(20, 8, 3, 120))
        result = Image.alpha_composite(result.convert("RGBA"), result_overlay).convert("RGB")
        sheet(start, result, destination)
        return
    elif mode == "reveal":
        start = ImageEnhance.Brightness(source).enhance(0.62).filter(ImageFilter.GaussianBlur(radius=1.4))
        result = ImageEnhance.Contrast(source).enhance(1.08)
    else:
        raise ValueError(f"unknown derived mode: {mode}")
    sheet(start, result, destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    output.mkdir(parents=True, exist_ok=True)

    manifest = {
        "schemaVersion": 1,
        "visualMode": "temporal-2grid",
        "assetStrategy": "temporal-2grid-remotion",
        "layout": "2x1",
        "generation": {"provider": "local-pillow-reuse", "newImageGeneration": False, "i2v": False},
        "shots": [],
    }

    # The first four shots already have reviewed 2x1 sheets from v6.
    for shot_id in (3599, 3600, 3601, 3602):
        source = LEGACY_SHEETS / f"shot-{shot_id}.png"
        destination = output / f"shot-{shot_id}.png"
        shutil.copy2(source, destination)
        manifest["shots"].append({"shotId": shot_id, "file": destination.name, "source": str(source.relative_to(ROOT)), "mode": "approved-existing-sheet"})

    derived = [
        (3603, "91cc2c56-3708-46c0-ba9e-043220b45291.png", "fog", "clear portrait under the label", "the portrait recedes into historical fog"),
        (3604, "14bc212a-4f98-477d-820e-93f386281a35.png", "sides", "the violent shadow side dominates", "the bright side reveals order and ordinary life"),
        (3605, "01ce2bec-48a9-49de-9b2f-a6e5ad59ad27.png", "reveal", "the chessboard and central figure are still obscured", "the woman stands clearly at the centre of the board"),
    ]
    for shot_id, source_name, mode, start_action, result_action in derived:
        source = SOURCE_IMAGES / source_name
        destination = output / f"shot-{shot_id}.png"
        build_derived(source, destination, mode)
        manifest["shots"].append({"shotId": shot_id, "file": destination.name, "source": str(source.relative_to(ROOT)), "mode": mode, "startAction": start_action, "resultAction": result_action})

    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "sheets": len(manifest["shots"]), "newImageGeneration": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
