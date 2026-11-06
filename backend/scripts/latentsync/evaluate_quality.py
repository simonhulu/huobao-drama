"""Run the official SyncNet detector/evaluator on CPU in isolated scratch space."""

import argparse
import contextlib
import hashlib
import importlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from statistics import fmean


WEIGHTS = {
    "syncnet_v2.model": (54573114, "961e8696f888fce4f3f3a6c3d5b3267cf5b343100b238e79b2659bff2c605442"),
    "sfd_face.pth": (89844381, "d54a87c2b7543b64729c9a25eafd188da15fd3f6e02f0ecec76ae1b30d86c491"),
}


def verified_weights(directory):
    paths = {}
    for name, (expected_size, expected_sha256) in WEIGHTS.items():
        filename = (directory / name).resolve(strict=True)
        if filename.stat().st_size != expected_size:
            raise RuntimeError(f"Incomplete evaluation weights: {name}")
        sha = hashlib.sha256()
        with filename.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                sha.update(chunk)
        if sha.hexdigest() != expected_sha256:
            raise RuntimeError(f"Evaluation weight SHA-256 mismatch: {name}")
        paths[name] = filename
    return paths


def load_evaluators(repo_root, weights, threads):
    sys.path.insert(0, str(repo_root))
    import torch
    import cv2
    from eval.syncnet import SyncNetEval
    from eval.syncnet_detect import SyncNetDetector

    torch.set_num_threads(threads)
    cv2.setNumThreads(1)
    # S3FD's upstream default is relative; never let it trigger an implicit download.
    importlib.import_module("eval.detectors.s3fd").PATH_WEIGHT = str(weights["sfd_face.pth"])
    syncnet = SyncNetEval(device="cpu")
    syncnet.loadParameters(str(weights["syncnet_v2.model"]))
    detector = SyncNetDetector(device="cpu", detect_results_dir="detect_results")
    return torch, syncnet, detector


def evaluate(video_path, torch, syncnet, detector):
    # Upstream removes its temp directories. Keep all of them inside this private cwd.
    previous_directory = Path.cwd()
    try:
        with tempfile.TemporaryDirectory(prefix="latentsync-syncnet-") as temporary:
            os.chdir(temporary)
            Path("input.mp4").symlink_to(video_path)
            detector(video_path="input.mp4", min_track=50)
            crops = sorted(Path("detect_results/crop").glob("*.mp4"))
            if not crops:
                raise RuntimeError("Official detector found no face track of at least 50 frames")
            tracks = []
            with torch.inference_mode():
                for crop in crops:
                    offset, minimum, confidence = syncnet.evaluate(
                        video_path=str(crop), temp_dir="syncnet-temp", batch_size=8,
                    )
                    if not all(math.isfinite(value) for value in (offset, minimum, confidence)):
                        raise RuntimeError("SyncNet returned a nonfinite metric")
                    tracks.append({
                        "crop": crop.name, "confidence": float(confidence),
                        "av_offset_frames": int(offset), "min_distance": float(minimum),
                    })
            offset = int(fmean(track["av_offset_frames"] for track in tracks))
            return {
                "video_path": str(video_path),
                "confidence": fmean(track["confidence"] for track in tracks),
                "av_offset_frames": offset, "av_offset_ms": offset * 40,
                "min_distance_if_available": fmean(track["min_distance"] for track in tracks),
                "evaluation_fps": 25, "device": "cpu", "tracks": tracks,
            }
    finally:
        os.chdir(previous_directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("/root/rivermind-data/LatentSync"))
    parser.add_argument("--weights-dir", type=Path)
    parser.add_argument("--video-path", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--check-only", action="store_true", help="Verify weights and load CPU models without evaluating")
    args = parser.parse_args()
    if not 1 <= args.threads <= 16:
        parser.error("--threads must be between 1 and 16")
    if not args.check_only and args.video_path is None:
        parser.error("--video-path is required unless --check-only is used")
    repo_root = args.repo_root.resolve(strict=True)
    weights_dir = (args.weights_dir or repo_root / "checkpoints/auxiliary").resolve(strict=True)
    video_path = args.video_path.resolve(strict=True) if args.video_path else None
    output_path = args.output.resolve() if args.output else None
    weights = verified_weights(weights_dir)
    with contextlib.redirect_stdout(sys.stderr):
        torch, syncnet, detector = load_evaluators(repo_root, weights, args.threads)
        result = {"ready": True, "device": "cpu", "weights": {name: str(path) for name, path in weights.items()}} if args.check_only else evaluate(video_path, torch, syncnet, detector)
    rendered = json.dumps(result, indent=2, allow_nan=False)
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
