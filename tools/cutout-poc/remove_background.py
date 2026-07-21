#!/usr/bin/env python3
"""Create an RGBA foreground and mask for the Remotion cutout POC."""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

from PIL import Image


DEFAULT_INPUT = Path("data/static/images/e8b313e0-52b1-4669-9466-101024be26ba.png")
DEFAULT_OUTPUT_DIR = Path("remotion/public/cutout-poc")
# Keep the smoke test small; use BiRefNet for the quality pass.
DEFAULT_MODEL = "u2netp"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.input.resolve()
    output_dir = args.output_dir.resolve()

    if not source.is_file():
        print(f"Input image does not exist: {source}", file=sys.stderr)
        return 2

    try:
        from rembg import new_session, remove
    except ImportError:
        print(
            "rembg is not installed. Run: "
            "python3 -m pip install 'rembg[cpu,cli]'",
            file=sys.stderr,
        )
        return 3

    output_dir.mkdir(parents=True, exist_ok=True)
    output_bytes = remove(source.read_bytes(), session=new_session(args.model))

    foreground_path = output_dir / "subject.png"
    mask_path = output_dir / "subject-mask.png"
    metadata_path = output_dir / "metadata.json"

    foreground = Image.open(io.BytesIO(output_bytes)).convert("RGBA")
    alpha = foreground.getchannel("A")
    alpha_min, alpha_max = alpha.getextrema()
    alpha_bbox = alpha.getbbox()
    alpha_coverage = sum(value > 0 for value in alpha.tobytes()) / (
        foreground.width * foreground.height
    )

    foreground.save(foreground_path)
    alpha.save(mask_path)
    metadata_path.write_text(
        json.dumps(
            {
                "tool": "rembg",
                "model": args.model,
                "source": str(source),
                "width": foreground.width,
                "height": foreground.height,
                "alphaMin": alpha_min,
                "alphaMax": alpha_max,
                "alphaCoverage": round(alpha_coverage, 6),
                "alphaBoundingBox": list(alpha_bbox) if alpha_bbox else None,
                "outputs": {
                    "foreground": str(foreground_path),
                    "mask": str(mask_path),
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"foreground: {foreground_path}")
    print(f"mask:       {mask_path}")
    print(f"metadata:   {metadata_path}")
    print(
        f"alpha:      min={alpha_min} max={alpha_max} "
        f"coverage={alpha_coverage:.2%}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
