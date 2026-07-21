#!/usr/bin/env python3
"""
Depth-aware single-image motion without layer compositing.

This is intentionally conservative: it uses the depth map as a continuous
displacement field, then crops from a slightly enlarged canvas. It avoids the
hard foreground/midground/background masks that create visible ghosting.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from depth_parallax import mock_depth, run_onnx


def fit_cover(image: np.ndarray, width: int, height: int) -> np.ndarray:
    h, w = image.shape[:2]
    scale = max(width / w, height / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    resized = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_AREA)
    x0 = max(0, (nw - width) // 2)
    y0 = max(0, (nh - height) // 2)
    return resized[y0:y0 + height, x0:x0 + width]


def smooth_depth(depth: np.ndarray) -> np.ndarray:
    depth = cv2.GaussianBlur(depth.astype(np.float32), (0, 0), 7)
    depth = (depth - depth.min()) / (depth.max() - depth.min() + 1e-8)
    return depth


def render_clip(
    image: np.ndarray,
    depth: np.ndarray,
    output: Path,
    width: int,
    height: int,
    duration: float,
    fps: int,
    strength: float,
    direction: int,
):
    frames = max(1, int(round(duration * fps)))

    # Work on a larger canvas so remap/crop does not expose hard borders.
    pad = int(max(48, strength * 3))
    canvas_w = width + pad * 2
    canvas_h = height + pad * 2
    base = cv2.copyMakeBorder(image, pad, pad, pad, pad, cv2.BORDER_REFLECT_101)
    depth_canvas = cv2.copyMakeBorder(depth, pad, pad, pad, pad, cv2.BORDER_REFLECT_101)

    y, x = np.indices((canvas_h, canvas_w), dtype=np.float32)
    depth_centered = depth_canvas - float(depth_canvas.mean())
    depth_centered = cv2.GaussianBlur(depth_centered, (0, 0), 3)

    ffmpeg_cmd = [
        "ffmpeg",
        "-y",
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "-",
        "-an",
        "-c:v", "h264_videotoolbox" if sys.platform == "darwin" else "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(output),
    ]
    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None

    try:
        for i in range(frames):
            p = i / max(1, frames - 1)
            ease = 0.5 - 0.5 * np.cos(np.pi * p)
            centered = ease - 0.5

            # Global Ken Burns motion plus a smaller depth-relative shift.
            global_x = direction * strength * 0.35 * centered
            global_y = strength * 0.07 * np.sin(2 * np.pi * p)
            depth_x = direction * strength * depth_centered * centered
            depth_y = strength * 0.10 * depth_centered * np.sin(np.pi * p)

            map_x = x - global_x - depth_x
            map_y = y - global_y - depth_y
            warped = cv2.remap(base, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)

            # Gentle push-in from the already enlarged canvas.
            zoom = 1.0 + 0.025 * ease
            crop_w = int(round(width / zoom))
            crop_h = int(round(height / zoom))
            cx = canvas_w // 2
            cy = canvas_h // 2
            x0 = max(0, min(canvas_w - crop_w, cx - crop_w // 2))
            y0 = max(0, min(canvas_h - crop_h, cy - crop_h // 2))
            frame = warped[y0:y0 + crop_h, x0:x0 + crop_w]
            frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_LINEAR)
            proc.stdin.write(frame.tobytes())
    finally:
        proc.stdin.close()
        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"ffmpeg exited with code {code}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_image")
    parser.add_argument("output_video")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--duration", type=float, default=5.0)
    parser.add_argument("--fps", type=int, default=24)
    parser.add_argument("--strength", type=float, default=24.0)
    parser.add_argument("--direction", type=int, default=1)
    parser.add_argument("--mock", action="store_true")
    args = parser.parse_args()

    input_path = Path(args.input_image)
    output_path = Path(args.output_video)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    image = cv2.imread(str(input_path))
    if image is None:
        raise SystemExit(f"Failed to read image: {input_path}")
    image = fit_cover(image, args.width, args.height)

    repo_root = Path(__file__).resolve().parents[2]
    model_path = repo_root / "backend" / "models" / "depth_anything_v2_vits.onnx"
    start = time.time()
    if args.mock or not model_path.exists() or model_path.stat().st_size < 1_000_000:
        depth = mock_depth(image)
        mode = "mock"
    else:
        depth = run_onnx(image, str(model_path))
        mode = "onnx"
    depth = cv2.resize(depth, (args.width, args.height), interpolation=cv2.INTER_CUBIC)
    depth = smooth_depth(depth)

    render_clip(
        image=image,
        depth=depth,
        output=output_path,
        width=args.width,
        height=args.height,
        duration=args.duration,
        fps=args.fps,
        strength=args.strength,
        direction=args.direction,
    )

    print(json.dumps({
        "output": str(output_path),
        "mode": mode,
        "elapsed_seconds": round(time.time() - start, 3),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
