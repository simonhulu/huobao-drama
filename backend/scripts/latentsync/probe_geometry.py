"""Measure upstream face alignment/restoration loss without loading the UNet."""

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path


def sha256(filename):
    digest = hashlib.sha256()
    with filename.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("/root/rivermind-data/LatentSync"))
    parser.add_argument("--video-path", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=6)
    parser.add_argument("--sample-fps", type=float, default=5)
    args = parser.parse_args()
    if not 0 < args.seconds <= 30 or not 0 < args.sample_fps <= 25:
        parser.error("seconds must be 0..30 and sample-fps must be 0..25")
    repo = args.repo_root.resolve(strict=True)
    video = args.video_path.resolve(strict=True)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(repo))

    import cv2
    import numpy as np
    import torch
    from einops import rearrange
    from torchvision.transforms.functional import resize
    from torchvision.transforms import InterpolationMode
    from latentsync.utils.affine_transform import AlignRestore
    from latentsync.utils.face_detector import FaceDetector

    torch.set_num_threads(2)
    cv2.setNumThreads(1)
    detector = FaceDetector(device="cuda")
    restorers = {name: AlignRestore(resolution=512, device="cuda", dtype=dtype)
                 for name, dtype in (("fp16", torch.float16), ("fp32", torch.float32))}
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError("Cannot open the reference video")
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if not math.isfinite(source_fps) or source_fps <= 0:
        raise RuntimeError("Reference video has no valid frame rate")
    records = []
    saved_frames = []
    previous = {}
    try:
        with torch.inference_mode():
            for index in range(math.ceil(args.seconds * args.sample_fps)):
                seconds = index / args.sample_fps
                cap.set(cv2.CAP_PROP_POS_FRAMES, round(seconds * source_fps))
                ok, bgr = cap.read()
                if not ok:
                    raise RuntimeError(f"Cannot decode reference at {seconds}s")
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                bbox, points = detector(rgb)
                if bbox is None:
                    raise RuntimeError(f"No face at {seconds}s")
                # Match upstream's three-point calculation and integer rounding.
                points3 = np.round([
                    np.mean(points[[43, 48, 49, 51, 50]], axis=0),
                    np.mean(points[101:106], axis=0),
                    np.mean(points[[74, 77, 83, 86]], axis=0),
                ])
                h, w = rgb.shape[:2]
                x1, y1, x2, y2 = map(int, bbox)
                x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
                original_roi = rgb[y1:y2, x1:x2]
                if not original_roi.size:
                    raise RuntimeError("Invalid face bounding box")
                row = {"time_seconds": seconds, "bbox": [x1, y1, x2, y2], "variants": {}}
                panels = [original_roi]
                for name, restorer in restorers.items():
                    face, matrix = restorer.align_warp_face(rgb.copy(), points3, smooth=True)
                    face512 = cv2.resize(face, (512, 512), interpolation=cv2.INTER_LANCZOS4)
                    normalized = rearrange(torch.from_numpy(face512).float() / 127.5 - 1, "h w c -> c h w")
                    normalized = resize(normalized, [restorer.face_size[1], restorer.face_size[0]],
                                        interpolation=InterpolationMode.BICUBIC, antialias=True)
                    restored = restorer.restore_img(rgb, normalized.to("cuda"), matrix)
                    roi = restored[y1:y2, x1:x2]
                    error = roi.astype(np.float32) - original_roi.astype(np.float32)
                    mse = float(np.mean(error ** 2))
                    original_gray = cv2.cvtColor(original_roi, cv2.COLOR_RGB2GRAY)
                    restored_gray = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY)
                    shift, correlation = cv2.phaseCorrelate(original_gray.astype(np.float32),
                                                           restored_gray.astype(np.float32))
                    values = {"mae": float(np.mean(np.abs(error))), "psnr_db": 10 * math.log10(255 ** 2 / max(mse, 1e-12)),
                              "phase_shift_x_px": float(shift[0]), "phase_shift_y_px": float(shift[1]),
                              "phase_response": float(correlation),
                              "laplacian_variance_ratio": float(cv2.Laplacian(restored_gray, cv2.CV_32F).var()
                                                                / max(cv2.Laplacian(original_gray, cv2.CV_32F).var(), 1e-12)),
                              "affine": matrix.float().cpu().numpy()[0].tolist()}
                    if name in previous:
                        values["phase_shift_delta_px"] = float(np.linalg.norm(np.asarray(shift) - previous[name]))
                    previous[name] = np.asarray(shift)
                    row["variants"][name] = values
                    panels.append(roi)
                tile = np.concatenate([cv2.resize(panel, (360, 480)) for panel in panels], axis=1)
                for column, label in enumerate(("Source", "FP16 round trip", "FP32 round trip")):
                    cv2.putText(tile, label, (column * 360 + 8, 26), cv2.FONT_HERSHEY_SIMPLEX,
                                .65, (255, 255, 255), 2, cv2.LINE_AA)
                if index in (0, 5, 10, 15, 20, 25):
                    name = f"roundtrip-{index:03d}.png"
                    cv2.imwrite(str(output / name), cv2.cvtColor(tile, cv2.COLOR_RGB2BGR))
                    saved_frames.append(name)
                records.append(row)
                print(f"geometry frame {index + 1}/{math.ceil(args.seconds * args.sample_fps)}", flush=True)
    finally:
        cap.release()

    metrics = ("mae", "psnr_db", "phase_shift_x_px", "phase_shift_y_px", "phase_shift_delta_px", "laplacian_variance_ratio")
    summary = {}
    for name in restorers:
        summary[name] = {}
        for metric in metrics:
            values = [row["variants"][name][metric] for row in records if metric in row["variants"][name]]
            summary[name][metric] = {"mean": float(np.mean(values)), "max": float(np.max(values))}
    report = {"video_path": str(video), "video_sha256": sha256(video), "source_fps": source_fps,
              "sample_fps": args.sample_fps, "sample_seconds": args.seconds, "frame_count": len(records),
              "probe": "identity alignment and restoration, no VAE or UNet", "summary": summary,
              "images": saved_frames, "frames": records}
    (output / "geometry.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(summary, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
