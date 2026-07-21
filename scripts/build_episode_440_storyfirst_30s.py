"""Build the story-first 2x1 sheets for Episode 440's opening 30 seconds.

This pilot intentionally reuses approved stills from the existing episode. The
two cells in each sheet are different narrative states; Pillow only normalizes
framing and tone. No layers, cards, I2V, or generated video are involved.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "static" / "images"
OUTPUT = ROOT / "data" / "static" / "images" / "episode-440-storyfirst-30s"
CELL = (1280, 720)


def fit(source: Image.Image, anchor_x: float = 0.5, scale: float = 1.0) -> Image.Image:
    image = source.convert("RGB")
    target = (round(CELL[0] * scale), round(CELL[1] * scale))
    ratio = max(target[0] / image.width, target[1] / image.height)
    resized = image.resize(
        (round(image.width * ratio), round(image.height * ratio)),
        Image.Resampling.LANCZOS,
    )
    left = round(max(0, min(resized.width - CELL[0], (resized.width - CELL[0]) * anchor_x)))
    top = max(0, (resized.height - CELL[1]) // 2)
    return resized.crop((left, top, left + CELL[0], top + CELL[1]))


def make_sheet(start: Path, result: Path, destination: Path, start_tone: float = 1.0) -> None:
    left = fit(Image.open(start), anchor_x=0.42, scale=1.02)
    right = fit(Image.open(result), anchor_x=0.58, scale=1.02)
    if start_tone != 1.0:
        left = ImageEnhance.Brightness(left).enhance(start_tone)
    canvas = Image.new("RGB", (CELL[0] * 2, CELL[1]), (11, 9, 7))
    canvas.paste(left, (0, 0))
    canvas.paste(right, (CELL[0], 0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    output = args.output if args.output.is_absolute() else ROOT / args.output
    output.mkdir(parents=True, exist_ok=True)

    # Each pair is one filmable action. Repeated source images are intentional:
    # they establish a match cut from the latrine door to Liu Ying's reaction.
    shots = [
        {
            "shotId": "sf-01",
            "start": "f79b5bb3-4813-4969-ac00-414759279505.png",
            "result": "4c09678c-e695-4f09-bf5a-010f6f570440.png",
            "startAction": "侍卫押着戚夫人走向永巷尽头的门",
            "resultAction": "厕所木门合上，门内只剩湿冷的石地和衣料",
            "startTone": 0.9,
        },
        {
            "shotId": "sf-02",
            "start": "d5e5e29a-6f7b-463d-b21f-80ee835c2b22.png",
            "result": "4c09678c-e695-4f09-bf5a-010f6f570440.png",
            "startAction": "戚夫人隔着木栏缩在牢房角落，守卫从她身边走过",
            "resultAction": "镜头落到厕所地面，刑具和破碎衣料留下后果",
            "startTone": 0.94,
        },
        {
            "shotId": "sf-03",
            "start": "4c09678c-e695-4f09-bf5a-010f6f570440.png",
            "result": "7beae563-a806-4f71-9148-082f5c5ad0b6.png",
            "startAction": "刘盈的手伸向厕所门环，门缝里透出冷光",
            "resultAction": "门被推开，刘盈看见门内后惊退跌坐在地",
            "startTone": 0.88,
        },
        {
            "shotId": "sf-04",
            "start": "ca178303-f8ca-4178-8ef6-da1a4f7d5b44.png",
            "result": "e7096728-9be4-48ac-ba2a-ab657f002193.png",
            "startAction": "吕雉在帷幕后听完禀报，手压住案上的印玺",
            "resultAction": "她走入朝堂，官员俯身让开通道，政令从她手中发出",
            "startTone": 0.96,
        },
    ]

    manifest = {
        "schemaVersion": 1,
        "visualMode": "temporal-2grid",
        "assetStrategy": "temporal-2grid-remotion",
        "layout": "2x1",
        "generation": {"provider": "local-pillow-reuse", "newImageGeneration": False, "i2v": False},
        "shots": [],
    }
    for shot in shots:
        destination = output / f"{shot['shotId']}.png"
        make_sheet(
            SOURCE / shot["start"],
            SOURCE / shot["result"],
            destination,
            float(shot["startTone"]),
        )
        manifest["shots"].append(
            {
                "shotId": shot["shotId"],
                "file": destination.name,
                "source": {"start": shot["start"], "result": shot["result"]},
                "startAction": shot["startAction"],
                "resultAction": shot["resultAction"],
            }
        )
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"output": str(output), "sheets": len(shots), "newImageGeneration": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
