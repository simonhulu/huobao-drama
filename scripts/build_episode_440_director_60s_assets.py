#!/usr/bin/env python3
"""Build the director-plan sheets for Episode 440's 60-second pilot.

Every output is a single 2x1 sheet containing two consecutive states of one
filmable event.  The source stills already exist in the project; this script
only crops approved 2x2 temporal sheets and pairs existing historical stills.
It does not create runtime layers, cards, I2V footage, or baked captions.
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageEnhance


ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "data" / "static" / "images"
OUTPUT = IMAGES / "episode-440-director-60s"
CELL = (1280, 720)


def fit(source: Image.Image, anchor_x: float = 0.5, scale: float = 1.02) -> Image.Image:
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
    canvas.paste(fit(left, anchor_x=0.42), (0, 0))
    canvas.paste(fit(right, anchor_x=0.58), (CELL[0], 0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)


def panel(sheet: Image.Image, index: int) -> Image.Image:
    """Extract one cell from a 2x2 temporal sheet."""
    width, height = sheet.size
    cell_width, cell_height = width // 2, height // 2
    row, column = divmod(index, 2)
    return sheet.crop((column * cell_width, row * cell_height,
                       (column + 1) * cell_width, (row + 1) * cell_height))


def image(name: str) -> Image.Image:
    path = IMAGES / name
    if not path.exists():
        raise FileNotFoundError(path)
    return Image.open(path).convert("RGB")


def two_by_two(name: str, first: int, second: int) -> tuple[Image.Image, Image.Image]:
    sheet = image(name)
    return panel(sheet, first), panel(sheet, second)


def derived(source: Image.Image, *, brightness: float = 1.0, contrast: float = 1.0,
            anchor_x: float = 0.5) -> Image.Image:
    result = fit(source, anchor_x=anchor_x, scale=1.04)
    if brightness != 1.0:
        result = ImageEnhance.Brightness(result).enhance(brightness)
    if contrast != 1.0:
        result = ImageEnhance.Contrast(result).enhance(contrast)
    return result


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schemaVersion": 1,
        "visualMode": "temporal-2grid",
        "assetStrategy": "temporal-2grid-remotion",
        "layout": "2x1",
        "generation": {
            "provider": "local-pillow-reuse",
            "newImageGeneration": False,
            "i2v": False,
            "sourceLicense": "approved-existing-project-asset",
        },
        "shots": [],
    }

    # The 2x2 sheets 4078/4079/4080 were generated as consecutive keyframes.
    # We choose adjacent cells, then upscale each cell to one 1280x720 state.
    qi_start, qi_result = two_by_two("948292c7-de9c-4127-8f4c-1b4498f68885.png", 0, 1)
    qi_after, qi_closed = two_by_two("948292c7-de9c-4127-8f4c-1b4498f68885.png", 2, 3)
    liu_open, liu_react = two_by_two("4ff3c909-4885-4d34-930f-17e5c49c2eff.png", 0, 1)
    liu_stumble, liu_fall = two_by_two("4ff3c909-4885-4d34-930f-17e5c49c2eff.png", 2, 3)
    lu_seated, lu_reaches = two_by_two("24efaa38-aed4-4314-9b86-ea8ab5a5d72e.png", 0, 1)
    lu_lifts, lu_seals = two_by_two("24efaa38-aed4-4314-9b86-ea8ab5a5d72e.png", 2, 3)

    specs = [
        ("B01-door-escort", qi_start, qi_result,
         "守卫押着戚夫人走到永巷尽头，戚夫人回头挣扎，守卫把她推入囚室。",
         "戚夫人被推入囚室，木门把她与外界隔开。",
         ["948292c7-de9c-4127-8f4c-1b4498f68885.png"]),
        ("B02-door-bolt", qi_after, qi_closed,
         "戚夫人抓住木栏向外呼喊，守卫把门闩压下并离开。",
         "门闩落下，木栏后只留下戚夫人的手和散落衣料。",
         ["948292c7-de9c-4127-8f4c-1b4498f68885.png"]),
        ("B03-liuying-open-door", liu_open, liu_react,
         "刘盈走到厕所门外，守卫替他推开半扇木门。",
         "门缝打开，刘盈看见门内的残破地面和衣料。",
         ["4ff3c909-4885-4d34-930f-17e5c49c2eff.png"]),
        ("B04-liuying-fall", liu_stumble, liu_fall,
         "刘盈看清门内后向后踉跄，手松开门框。",
         "刘盈跌坐在地，守卫不敢上前。",
         ["4ff3c909-4885-4d34-930f-17e5c49c2eff.png"]),
        ("B05-luzhi-enters-court", image("ca178303-f8ca-4178-8ef6-da1a4f7d5b44.png"), image("e7096728-9be4-48ac-ba2a-ab657f002193.png"),
         "吕雉从内殿走入朝堂，官员听见脚步后停止交谈。",
         "通道被让出，吕雉走到案前，所有人的视线转向她。",
         ["ca178303-f8ca-4178-8ef6-da1a4f7d5b44.png", "e7096728-9be4-48ac-ba2a-ab657f002193.png"]),
        ("B06-luzhi-petition", lu_seated, lu_seals,
         "吕雉接过奏牍，翻开内容，手伸向案上的印玺。",
         "她按住印玺开始权衡一份真实政务，人物从标签回到选择。",
         ["24efaa38-aed4-4314-9b86-ea8ab5a5d72e.png"]),
        ("B07-hanxin-entered", image("c45ebc0f-c97b-4bbc-9b3e-23a9fa64a62b.png"), image("4451b4d3-ff18-4290-80f5-0935ddba2217.png"),
         "韩信被软禁在长安，等待处置。",
         "韩信被引入长乐宫，守卫封住退路。",
         ["c45ebc0f-c97b-4bbc-9b3e-23a9fa64a62b.png", "4451b4d3-ff18-4290-80f5-0935ddba2217.png"]),
        ("B08-pengyue-plea", image("980e1ac6-e82b-44f2-87b6-fbf5e134ab93.png"), image("f1606879-299c-46a9-b1ac-9dc38b06e843.png"),
         "彭越在流放路上被押送，看到吕雉车驾后追上去。",
         "彭越跪在车驾前求情，吕雉掀帘听完。",
         ["980e1ac6-e82b-44f2-87b6-fbf5e134ab93.png", "f1606879-299c-46a9-b1ac-9dc38b06e843.png"]),
        ("B09-relief-order", image("056f5108-0296-410d-9c64-a41bde271960.png"), image("2f95e788-3a11-4985-9675-469b9d0e14cd.png"),
         "中官在告示处展开减负文书，官吏按名册准备粮食。",
         "百姓领取粮食，队伍从围堵转为有序排队。",
         ["056f5108-0296-410d-9c64-a41bde271960.png", "2f95e788-3a11-4985-9675-469b9d0e14cd.png"]),
        ("B10-order-center", lu_lifts, image("78d42a4f-cb62-4ce7-8e8c-c62486e1e72f.png"),
         "吕雉把诏令交到中官手中，中官转身准备传令。",
         "诏令离开案前，政令从她的位置流向宫外。",
         ["24efaa38-aed4-4314-9b86-ea8ab5a5d72e.png", "78d42a4f-cb62-4ce7-8e8c-c62486e1e72f.png"]),
    ]

    for index, (beat_id, left, right, start_action, result_action, sources) in enumerate(specs, 1):
        destination = OUTPUT / f"beat-{index:02d}.png"
        make_sheet(left, right, destination)
        manifest["shots"].append({
            "beatId": beat_id,
            "shotNumber": index,
            "file": destination.name,
            "source": sources,
            "startAction": start_action,
            "resultAction": result_action,
            "mode": "approved-static-event-pair",
        })

    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"output": str(OUTPUT), "sheets": len(specs), "newImageGeneration": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
