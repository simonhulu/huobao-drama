#!/usr/bin/env python3
"""
Depth Parallax Prototype
生成单目深度图，用于 2.5D 视差动画。

如果 backend/models/depth_anything_v2_vits.onnx 存在，则使用 Depth-Anything V2 Small ONNX 推理；
否则退回到 mock 模式，生成一个中心近、边缘远的模拟深度图（仅用于验证视差管线）。

用法：
  python backend/scripts/depth_parallax.py <input_image> <output_depth_png> [--mock]
"""
import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np


def mock_depth(image: np.ndarray) -> np.ndarray:
    """生成模拟深度图：中心区域较亮（近），四周较暗（远），并叠加轻微噪声。"""
    h, w = image.shape[:2]
    y, x = np.indices((h, w))
    cx, cy = w / 2, h / 2
    max_dist = np.sqrt(cx**2 + cy**2)
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    # 距离中心越远深度值越大（在视差管线里会被反转成越远越暗）
    depth = dist / max_dist
    # 增加一点基于亮度的细节：亮部更可能靠近镜头
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    depth = depth * 0.7 + (1 - gray) * 0.3
    # 归一化到 0-1
    depth = (depth - depth.min()) / (depth.max() - depth.min() + 1e-8)
    return depth


def run_onnx(image: np.ndarray, model_path: str) -> np.ndarray:
    import onnxruntime as ort

    h, w = image.shape[:2]
    input_size = 518
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB) / 255.0
    resized = cv2.resize(rgb, (input_size, input_size), interpolation=cv2.INTER_CUBIC)
    input_tensor = np.transpose(resized, (2, 0, 1))[None].astype(np.float32)

    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(model_path, sess_options, providers=["CPUExecutionProvider"])

    outputs = session.run(None, {"image": input_tensor})
    depth = outputs[0].squeeze()
    depth = cv2.resize(depth, (w, h), interpolation=cv2.INTER_CUBIC)
    depth = (depth - depth.min()) / (depth.max() - depth.min() + 1e-8)
    return depth


def main():
    parser = argparse.ArgumentParser(description="Generate depth map for parallax effect")
    parser.add_argument("input_image", help="Path to input image")
    parser.add_argument("output_depth", help="Path to output depth PNG")
    parser.add_argument("--mock", action="store_true", help="Force mock depth generation")
    args = parser.parse_args()

    input_path = Path(args.input_image)
    output_path = Path(args.output_depth)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        print(json.dumps({"error": f"Input image not found: {input_path}"}))
        sys.exit(1)

    image = cv2.imread(str(input_path))
    if image is None:
        print(json.dumps({"error": f"Failed to read image: {input_path}"}))
        sys.exit(1)

    repo_root = Path(__file__).resolve().parents[2]
    model_path = repo_root / "backend" / "models" / "depth_anything_v2_vits.onnx"

    use_mock = args.mock or not model_path.exists() or model_path.stat().st_size < 1_000_000

    start = os.times().elapsed
    if use_mock:
        depth = mock_depth(image)
        mode = "mock"
    else:
        depth = run_onnx(image, str(model_path))
        mode = "onnx"
    elapsed = os.times().elapsed - start

    depth_uint16 = (depth * 65535).astype(np.uint16)
    cv2.imwrite(str(output_path), depth_uint16)

    result = {
        "mode": mode,
        "input": str(input_path),
        "output": str(output_path),
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "depth_min": float(depth.min()),
        "depth_max": float(depth.max()),
        "elapsed_seconds": round(elapsed, 3),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
