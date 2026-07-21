#!/usr/bin/env python3
"""Build the 180-second Episode 440 temporal-2grid sheets.

The first ten sheets are the approved 60-second assets.  The extension reuses
only existing stills, cropping multi-panel source images into independent
frames before pairing them.  No runtime layers, Remotion cards, captions, or
I2V footage are generated here.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "data" / "static" / "images"
SOURCE_SHEETS = IMAGES / "episode-440-director-60s"
OUTPUT = IMAGES / "episode-440-director-180s"
CELL = (1280, 720)


def image(name: str) -> Image.Image:
    path = IMAGES / name
    if not path.exists():
        raise FileNotFoundError(path)
    return Image.open(path).convert("RGB")


def crop(source: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    return source.crop(box)


def fit(source: Image.Image, *, anchor_x: float = 0.5, scale: float = 1.02,
        brightness: float = 1.0, contrast: float = 1.0) -> Image.Image:
    source = source.convert("RGB")
    target = (round(CELL[0] * scale), round(CELL[1] * scale))
    ratio = max(target[0] / source.width, target[1] / source.height)
    resized = source.resize((round(source.width * ratio), round(source.height * ratio)), Image.Resampling.LANCZOS)
    left = round(max(0, min(resized.width - CELL[0], (resized.width - CELL[0]) * anchor_x)))
    top = max(0, (resized.height - CELL[1]) // 2)
    result = resized.crop((left, top, left + CELL[0], top + CELL[1]))
    if brightness != 1.0:
        result = ImageEnhance.Brightness(result).enhance(brightness)
    if contrast != 1.0:
        result = ImageEnhance.Contrast(result).enhance(contrast)
    return result


def contain_context(source: Image.Image) -> Image.Image:
    """Keep a narrow source frame intact instead of cover-cropping its action.

    Multi-panel storyboard exports often contain a tall 0.6-1.4 aspect-ratio
    cell.  Scaling that cell to cover 16:9 removes the actor's head, hands, or
    props.  A blurred enlargement of the same source gives the full frame a
    continuous period-colored environment while the foreground remains whole.
    """
    source = source.convert("RGB")
    background = fit(source, anchor_x=0.5, scale=1.0)
    background = ImageEnhance.Brightness(background).enhance(0.72)
    background = background.filter(ImageFilter.GaussianBlur(radius=24))
    canvas = background.convert("RGBA")
    veil = Image.new("RGBA", CELL, (12, 9, 6, 34))
    canvas.alpha_composite(veil)

    max_width = round(CELL[0] * 0.92)
    max_height = round(CELL[1] * 0.92)
    ratio = min(max_width / source.width, max_height / source.height)
    foreground = source.resize(
        (max(1, round(source.width * ratio)), max(1, round(source.height * ratio))),
        Image.Resampling.LANCZOS,
    )
    # Feather only the edge of the contained frame so it reads as a wider
    # composition, not as a UI card pasted on top of the scene.
    mask = Image.new("L", foreground.size, 255)
    draw = ImageDraw.Draw(mask)
    edge = max(16, min(36, foreground.width // 10, foreground.height // 10))
    draw.rectangle((0, 0, foreground.width - 1, foreground.height - 1), outline=0, width=edge)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=10))
    left = (CELL[0] - foreground.width) // 2
    top = (CELL[1] - foreground.height) // 2
    canvas.paste(foreground.convert("RGBA"), (left, top), mask)
    return canvas.convert("RGB")


def panel_frame(source: Image.Image, *, anchor_x: float = 0.5) -> Image.Image:
    """Use cover only for near-16:9 plates; preserve complete action cells.

    A 1.6:1 source can still lose a face or a raised hand when it is scaled to
    16:9.  The blurred context treatment is preferable until the source is
    genuinely close to the target ratio.
    """
    source = source.convert("RGB")
    aspect = source.width / source.height
    if aspect < 1.72:
        return contain_context(source)
    return fit(source, anchor_x=anchor_x)


def make_sheet(left: Image.Image, right: Image.Image, destination: Path) -> None:
    canvas = Image.new("RGB", (CELL[0] * 2, CELL[1]), (11, 9, 7))
    canvas.paste(panel_frame(left, anchor_x=0.38), (0, 0))
    canvas.paste(panel_frame(right, anchor_x=0.62), (CELL[0], 0))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, format="PNG", optimize=True)


def source_sheet(image_id: str, box: tuple[int, int, int, int] | None = None) -> Image.Image:
    source = image(f"{image_id}.png")
    return crop(source, box) if box else source


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

    # Preserve the approved first minute byte-for-byte.
    for index in range(1, 11):
        source = SOURCE_SHEETS / f"beat-{index:02d}.png"
        destination = OUTPUT / source.name
        shutil.copy2(source, destination)
        manifest["shots"].append({
            "beatId": f"B{index:02d}",
            "shotNumber": index,
            "file": destination.name,
            "source": [str(source.relative_to(ROOT))],
            "mode": "approved-static-event-pair-reuse",
        })

    # Source ids are the first-frame stills from storyboard rows 3606-3617.
    s3606 = source_sheet("7a90fe67-3c37-434d-970e-cd75030a28e9")
    s3607 = source_sheet("62072986-5bc4-47ac-b998-7ff57d368848")
    s3608 = source_sheet("8418e3e4-8a08-44e8-ae75-4dcfcfc2fc6a")
    s3609 = source_sheet("d4c414d5-d2a1-492d-8b0b-fc0bd1cf3323")
    s3610 = source_sheet("1cdd9c2a-b39a-49cd-96c9-ba07ca5fd714", (0, 86, 1672, 855))
    s3611 = source_sheet("c493c2d4-906a-4801-8cd2-50292efb819a")
    s3612 = source_sheet("b7060f01-1bcd-4494-9ec1-f905e61b9b6c")
    s3613 = source_sheet("3e7d9926-7eff-4e5e-a2a1-1015fcf5c2e3")
    s3614 = source_sheet("034751a2-d12a-4e33-8a1e-618bd46d5fac")
    s3615 = source_sheet("d5e5e29a-6f7b-463d-b21f-80ee835c2b22")
    s3616 = source_sheet("f79b5bb3-4813-4969-ac00-414759279505")
    s3617 = source_sheet("6f5bf5f2-3ea2-4246-bbe3-4c759c5bfda1")

    # Multi-panel sources are cropped before fit(), so no old collage is nested
    # in a new temporal sheet. Coordinates are kept explicit for review.
    d3609_left = crop(s3609, (0, 0, 1014, 941))
    d3609_right_top = crop(s3609, (1018, 0, 1672, 466))
    d3609_right_bottom = crop(s3609, (1018, 470, 1672, 941))
    d3612_left = crop(s3612, (0, 0, 555, 941))
    d3612_middle = crop(s3612, (558, 0, 1112, 941))
    d3612_right = crop(s3612, (1115, 0, 1672, 941))
    # 3613 contains baked text in the far-left strips and bottom margin. Keep
    # clean interior crops from each panel only.
    d3613_street = crop(s3613, (180, 40, 760, 855))
    # Start above the runner's head.  The old y=500 crop removed the head, and
    # the subsequent 16:9 cover fit removed it a second time.
    d3613_escape = crop(s3613, (1030, 430, 1672, 900))
    d3613_run = crop(s3613, (1030, 40, 1672, 450))
    # 3617 is a collage; the central captive is the only clean continuous
    # action frame, so crop her rather than carrying the moon montage forward.
    d3617_captive = crop(s3617, (380, 40, 1280, 920))

    specs = [
        (11, "B11-young-luzhi", s3606, fit(s3606, anchor_x=0.68, scale=1.18),
         "少女吕雉低头捻丝", "她听见车轮后抬头望向院门", ["7a90fe67-3c37-434d-970e-cd75030a28e9.png"]),
        (12, "B12-family-migration", s3607, fit(s3607, anchor_x=0.72, scale=1.16),
         "吕家车队在城门外赶路", "车队驶入沛县客舍前停下", ["62072986-5bc4-47ac-b998-7ff57d368848.png"]),
        (13, "B13-luzhi-meets-liubang", s3608, fit(s3608, anchor_x=0.28, scale=1.13),
         "刘邦端碗走入宴席", "吕公放下酒杯抬手让他坐近", ["8418e3e4-8a08-44e8-ae75-4dcfcfc2fc6a.png"]),
        (14, "B14-liubang-street", d3609_left, d3609_right_bottom,
         "刘邦在街巷酒肆拍桌喝酒", "他在酒席间举碗调笑并转身离开", ["d4c414d5-d2a1-492d-8b0b-fc0bd1cf3323.png"]),
        (15, "B15-liubang-no-foundation", d3609_right_top, d3609_left,
         "曹氏抱孩子站在家门内", "刘邦转身离开，母子留在屋里", ["d4c414d5-d2a1-492d-8b0b-fc0bd1cf3323.png"]),
        (16, "B16-marriage-decision", s3610, s3611,
         "吕公在堂前指向等候的刘邦", "吕雉接过婚书，婚事被当面定下", ["1cdd9c2a-b39a-49cd-96c9-ba07ca5fd714.png", "c493c2d4-906a-4801-8cd2-50292efb819a.png"]),
        (17, "B17-poor-wedding", s3610, fit(s3610, anchor_x=0.72, scale=1.2),
         "简陋厅堂里的婚礼和宾客", "红烛旁吕雉低头行礼，席面散去", ["1cdd9c2a-b39a-49cd-96c9-ba07ca5fd714.png"]),
        (18, "B18-arranged-marriage", s3610, s3611,
         "吕公把婚书递给吕雉", "她抬眼看刘邦后又低头握紧婚书", ["1cdd9c2a-b39a-49cd-96c9-ba07ca5fd714.png", "c493c2d4-906a-4801-8cd2-50292efb819a.png"]),
        (19, "B19-no-choice", s3611, s3610,
         "吕雉攥紧婚书站在门槛内", "她把婚书收入袖中，跨过门槛离开", ["c493c2d4-906a-4801-8cd2-50292efb819a.png", "1cdd9c2a-b39a-49cd-96c9-ba07ca5fd714.png"]),
        (20, "B20-family-labor", d3612_middle, d3612_right,
         "吕雉抱起孩子并把女儿交给婆婆", "她转身添柴，家人围桌吃饭", ["b7060f01-1bcd-4494-9ec1-f905e61b9b6c.png"]),
        (21, "B21-supports-household", d3612_left, d3612_middle,
         "吕雉在田里弯腰插秧", "她从织机前站起把水递给公婆", ["b7060f01-1bcd-4494-9ec1-f905e61b9b6c.png"]),
        (22, "B22-liubang-away", d3613_street, d3613_escape,
         "刘邦在外面喝酒游荡", "他离开街巷钻入山林，家门又空下来", ["3e7d9926-7eff-4e5e-a2a1-1015fcf5c2e3.png"]),
        (23, "B23-liubang-escapes", d3613_run, d3613_escape,
         "押送队伍在山道上发现囚徒逃散", "刘邦扔下竹简转身钻进芒砀山林", ["3e7d9926-7eff-4e5e-a2a1-1015fcf5c2e3.png"]),
        (24, "B24-luzhi-brings-provisions", s3614, fit(s3614, anchor_x=0.67, scale=1.18),
         "吕雉背包牵孩子翻山", "她把包裹递给山洞口的刘邦", ["034751a2-d12a-4e33-8a1e-618bd46d5fac.png"]),
        (25, "B25-abandoned-wife", d3612_middle, d3612_right,
         "吕雉独自照料孩子和家中老人", "她低头分饭，屋里没有刘邦的身影", ["b7060f01-1bcd-4494-9ec1-f905e61b9b6c.png"]),
        (26, "B26-luzhi-imprisoned", s3615, fit(s3615, anchor_x=0.68, scale=1.2),
         "狱卒把吕雉推入牢房并落闩", "她扶着木栏站起，护住衣包", ["d5e5e29a-6f7b-463d-b21f-80ee835c2b22.png"]),
        (27, "B27-chu-hostage", s3616, d3617_captive,
         "楚军押着吕雉和刘太公穿过营栅", "囚帐门帘和栅门合上，只剩火光中的背影", ["f79b5bb3-4813-4969-ac00-414759279505.png", "6f5bf5f2-3ea2-4246-bbe3-4c759c5bfda1.png"]),
    ]

    for number, beat_id, left, right, start_action, result_action, sources in specs:
        destination = OUTPUT / f"beat-{number:02d}.png"
        make_sheet(left, right, destination)
        manifest["shots"].append({
            "beatId": beat_id,
            "shotNumber": number,
            "file": destination.name,
            "source": sources,
            "startAction": start_action,
            "resultAction": result_action,
            "mode": "approved-static-event-pair-crop",
        })

    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(OUTPUT), "sheets": len(manifest["shots"]), "newImageGeneration": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
