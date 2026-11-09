"""Measure complete MP4 export with the official cached MuseTalk 1.5 avatar.

Run in the upstream checkout; its inference implementation remains unchanged.
Avatar preparation and model startup are recorded separately from warm jobs.
"""

import argparse
import json
from pathlib import Path
import subprocess
import time

from runtime import MODEL, SOURCE_REVISION, MuseTalkRuntime, add_quality_arguments, file_hash, media_info, pipe_inference


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--audio", type=Path, nargs="+", required=True)
    parser.add_argument("--report", type=Path, required=True)
    add_quality_arguments(parser)
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--encoding", choices=("png", "pipe"), default="png")
    parser.add_argument("--codec", choices=("libx264", "h264_nvenc"), default="libx264")
    parser.add_argument("--preprocessing-module", type=Path,
                        default=Path(__file__).resolve().parent / "vendor/preprocessing_onnx.py")
    args = parser.parse_args()
    for name in ("root", "reference", "report"):
        setattr(args, name, getattr(args, name).resolve())
    args.audio = [item.resolve() for item in args.audio]
    if args.report.exists():
        raise FileExistsError("Choose a new report path; benchmarks are not overwritten")
    if not args.reference.is_file() or not all(item.is_file() for item in args.audio):
        raise ValueError("Reference and narration files must exist")
    if not 1 <= args.batch_size <= 64:
        raise ValueError("Batch size must be between 1 and 64")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "model": MODEL, "fps": args.fps, "batch_size": args.batch_size, "encoding": args.encoding,
        "codec": args.codec if args.encoding == "pipe" else "libx264",
        "pipe_frame_size": [360, 360] if args.encoding == "pipe" else None,
        "source_revision": SOURCE_REVISION,
        "audio_lookahead_frames": args.audio_lookahead_frames,
        "reference_sha256": file_hash(args.reference), "status": "loading", "runs": [],
    }

    def save():
        temporary = args.report.with_suffix(".tmp")
        temporary.write_text(json.dumps(report, indent=2), encoding="utf-8")
        temporary.replace(args.report)

    save()
    started = time.perf_counter()
    try:
        runtime = MuseTalkRuntime(args.root, args.reference, args.fps, args.batch_size,
                                  args.codec, args.preprocessing_module, precision=args.precision,
                                  extra_margin=args.extra_margin, parsing_mode=args.parsing_mode,
                                  left_cheek_width=args.left_cheek_width, right_cheek_width=args.right_cheek_width,
                                  audio_lookahead_frames=args.audio_lookahead_frames)
        runtime.load()
        torch, upstream, avatar = runtime.torch, runtime.upstream, runtime.avatar
        report.update(runtime.load_metrics, avatar_id=runtime.identity["avatar_id"], status="running")
        save()
        for index, audio in enumerate(args.audio):
            name = f"{args.report.stem}-{index}-{args.fps}fps"
            output = Path(avatar.video_out_path) / f"{name}.mp4"
            if output.exists():
                raise FileExistsError(output)
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            before = time.perf_counter()
            with torch.inference_mode():
                if args.encoding == "pipe":
                    pipe_inference(avatar, upstream, audio, name, args.fps, args.codec)
                else:
                    avatar.inference(str(audio), name, args.fps, False)
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - before
            source_duration = float(media_info(audio)["format"]["duration"])
            result = media_info(output)
            video = next(item for item in result["streams"] if item.get("codec_type") == "video")
            if not any(item.get("codec_type") == "audio" for item in result["streams"]):
                raise RuntimeError("The delivered MP4 has no audio")
            duration = float(video.get("duration") or result["format"]["duration"])
            if abs(source_duration - duration) > 0.15:
                raise RuntimeError("The output does not cover the complete narration")
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(output), "-f", "null", "-"],
                           check=True, timeout=180)
            entry = {
                "audio": str(audio), "audio_sha256": file_hash(audio), "output": str(output),
                "output_sha256": file_hash(output), "audio_duration_seconds": source_duration,
                "video_duration_seconds": duration, "elapsed_seconds": elapsed,
                "realtime_factor": elapsed / source_duration,
                "effective_fps": source_duration * args.fps / elapsed,
                "peak_allocated_gib": torch.cuda.max_memory_allocated() / (1024 ** 3),
                "output_bytes": output.stat().st_size,
            }
            report["runs"].append(entry)
            save()
            print("BENCHMARK_RESULT " + json.dumps(entry), flush=True)
        report.update(status="completed", total_seconds=time.perf_counter() - started)
        save()
    except BaseException as error:
        report.update(status="failed", error=str(error), total_seconds=time.perf_counter() - started)
        save()
        raise


if __name__ == "__main__":
    main()
