#!/usr/bin/env python3
"""Build the story-first 2x1 sheets for Episode 440's 60-second pilot.

This stage is deterministic and provider-free. It reuses approved stills and
turns concrete event images into two-state sheets; it never creates layers,
cards, I2V footage, or text baked into an image.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "data" / "static" / "images"
STORYFIRST_30 = IMAGES / "episode-440-storyfirst-30s"
OUTPUT = IMAGES / "episode-440-storyfirst-60s"
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


def make_sheet(left: Image.Image, right: Image.Image, destination: Path) -> None:
    canvas = Image.new("RGB", (CELL[0] * 2, CELL[1]), (11, 9, 7))
    canvas.paste(fit(left, anchor_x=0.42, scale=1.02), (0, 0))
    canvas.paste(fit(right, anchor_x=0.58, scale=1.02), (CELL[0], 0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)


def make_court_progression(destination: Path) -> None:
    """Create two distinct court framings from one approved court still."""
    source = Image.open(STORYFIRST_30 / "sf-04.png").convert("RGB").crop((1280, 0, 2560, 720))
    start = fit(source, anchor_x=0.28, scale=1.04)
    result = ImageEnhance.Brightness(fit(source, anchor_x=0.72, scale=1.18)).enhance(1.04)
    canvas = Image.new("RGB", (CELL[0] * 2, CELL[1]), (11, 9, 7))
    canvas.paste(start, (0, 0))
    canvas.paste(result, (CELL[0], 0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)


def image(name: str) -> Image.Image:
    path = IMAGES / name
    if not path.exists():
        raise FileNotFoundError(path)
    return Image.open(path)


def copy_sheet(source: Path, destination: Path) -> None:
    if not source.exists():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "visualMode": "temporal-2grid",
        "assetStrategy": "temporal-2grid-remotion",
        "layout": "2x1",
        "generation": {"provider": "local-pillow-reuse", "newImageGeneration": False, "i2v": False},
        "shots": [],
    }

    # Keep the four reviewed opening shots exactly as they appeared in the
    # accepted 30-second pilot.
    for shot_number in range(1, 5):
        source = STORYFIRST_30 / f"sf-0{shot_number}.png"
        destination = OUTPUT / f"shot-{3598 + shot_number}.png"
        copy_sheet(source, destination)
        manifest["shots"].append({
            "shotId": 3598 + shot_number,
            "file": destination.name,
            "source": str(source.relative_to(ROOT)),
            "mode": "approved-storyfirst-30s-sheet",
        })

    # Shot 5 is an explanatory beat, but it still needs a filmable change.
    # Start on the face that carries the public label, then move into a real
    # palace exchange so the beat points at a person making decisions rather
    # than dissolving into an abstract fog plate.
    destination_3603 = OUTPUT / "shot-3603.png"
    make_sheet(
        image("ca178303-f8ca-4178-8ef6-da1a4f7d5b44.png"),
        image("e7096728-9be4-48ac-ba2a-ab657f002193.png"),
        destination_3603,
    )
    manifest["shots"].append({
        "shotId": 3603,
        "file": destination_3603.name,
        "source": [
            "data/static/images/ca178303-f8ca-4178-8ef6-da1a4f7d5b44.png",
            "data/static/images/e7096728-9be4-48ac-ba2a-ab657f002193.png",
        ],
        "startAction": "吕雉正面承受‘狠毒’的历史标签",
        "resultAction": "吕雉转入宫中政务，与刘邦面对面议事",
        "mode": "concrete-person-to-decision-reuse",
    })

    # The narration names Han Xin and Peng Yue, but they are two different
    # events. Keep them in separate temporal sheets so each pair remains one
    # causal action instead of a split-screen montage.
    destination_3604_1 = OUTPUT / "shot-3604-1.png"
    make_sheet(
        image("c45ebc0f-c97b-4bbc-9b3e-23a9fa64a62b.png"),
        image("4451b4d3-ff18-4290-80f5-0935ddba2217.png"),
        destination_3604_1,
    )
    manifest["shots"].append({
        "shotId": "3604-1",
        "file": destination_3604_1.name,
        "source": [
            "data/static/images/c45ebc0f-c97b-4bbc-9b3e-23a9fa64a62b.png",
            "data/static/images/4451b4d3-ff18-4290-80f5-0935ddba2217.png",
        ],
        "startAction": "韩信被软禁在长安，等待处置",
        "resultAction": "韩信被引入长乐宫，守卫封住退路",
        "mode": "concrete-event-reuse",
    })

    # The second half follows Peng Yue's own causal action: a plea on the
    # road, followed by the carriage taking him back toward the court.
    destination_3604_2 = OUTPUT / "shot-3604-2.png"
    make_sheet(
        image("f1606879-299c-46a9-b1ac-9dc38b06e843.png"),
        image("980e1ac6-e82b-44f2-87b6-fbf5e134ab93.png"),
        destination_3604_2,
    )
    manifest["shots"].append({
        "shotId": "3604-2",
        "file": destination_3604_2.name,
        "source": [
            "data/static/images/f1606879-299c-46a9-b1ac-9dc38b06e843.png",
            "data/static/images/980e1ac6-e82b-44f2-87b6-fbf5e134ab93.png",
        ],
        "startAction": "彭越在流放路上跪地求情",
        "resultAction": "吕雉的车驾把彭越带回洛阳",
        "mode": "concrete-event-reuse",
    })

    # The closing metaphor is visualized as a real court action: she enters,
    # officials bow, and the order is issued from her position in court.
    destination_3605 = OUTPUT / "shot-3605.png"
    make_court_progression(destination_3605)
    manifest["shots"].append({
        "shotId": 3605,
        "file": destination_3605.name,
        "source": str((STORYFIRST_30 / "sf-04.png").relative_to(ROOT)),
        "startAction": "吕雉走入朝堂",
        "resultAction": "百官俯身，政令从她手中发出",
        "mode": "approved-storyfirst-court-sheet",
    })

    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"output": str(OUTPUT), "sheets": len(manifest["shots"]), "newImageGeneration": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
