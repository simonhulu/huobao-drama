"""Headless adapter for VideoHighlighter, not a replacement highlight detector.

Verified against simonhulu/VideoHighlighter commit
8d3eee1379467057801bd987725d71b353b2a6dd: pipeline.py run_highlighter(),
report_only branch returning [(start, end), ...], and *_why.json segments.
"""

import argparse
from contextlib import contextmanager
import importlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys


@contextmanager
def unused_object_detector(config):
    """Work around upstream eagerly fetching YOLOX with no objects selected.

    Only the unused object-model constructors are suppressed, within this child
    process. All scene, motion, audio, scoring and selection run unchanged.
    Enabling objects or actions restores upstream's normal model loading.
    """
    if config.get("highlight_objects") or config.get("interesting_actions"):
        yield
        return
    from modules.vision import detection_backend
    import object_recognition
    original_build = detection_backend.build_object_detector
    original_directml = object_recognition.directml_detector
    try:
        detection_backend.build_object_detector = lambda *args, **kwargs: (None, [])
        object_recognition.directml_detector = lambda *args, **kwargs: None
        print("Adapter: object/action classes are empty; skip unused object-model initialization and downloads.", flush=True)
        yield
    finally:
        detection_backend.build_object_detector = original_build
        object_recognition.directml_detector = original_directml


def normalize_segments(segments, report=None):
    """Normalize report-only tuples; never infer basketball event identities."""
    if not isinstance(segments, (list, tuple)):
        raise ValueError("Upstream did not return report-only segment tuples; inspect analysis.log and the installed revision.")
    report_segments = (report or {}).get("segments", [])
    clips = []
    for segment in segments:
        if not isinstance(segment, (list, tuple)) or len(segment) != 2:
            raise ValueError(f"Invalid upstream segment: {segment!r}")
        start, end = (float(value) for value in segment)
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end):
            raise ValueError(f"Invalid upstream time range: {segment!r}")
        clip = {"start": start, "end": end, "semanticVerified": False}
        for entry in report_segments:
            if abs(float(entry.get("start", -1)) - start) < 0.001 and abs(float(entry.get("end", -1)) - end) < 0.001:
                score = entry.get("score")
                if isinstance(score, (int, float)) and math.isfinite(score):
                    clip["score"] = float(score)
                break
        clips.append(clip)
    return sorted(clips, key=lambda clip: (clip["start"], clip["end"]))


def run(request):
    repo = Path(request["repoPath"]).resolve()
    run_dir = Path(request["runDir"]).resolve()
    source = Path(request["input"]).resolve()
    sys.path.insert(0, str(repo))
    try:
        pipeline = importlib.import_module("pipeline")
    except ImportError as exc:
        raise RuntimeError(
            f"Cannot import VideoHighlighter: {exc}. Select a Python environment with "
            "numpy, torch, PyYAML, opencv-python and tqdm installed using "
            "VIDEOHIGHLIGHTER_PYTHON or pythonPath. Optional detectors require the "
            "upstream requirements.txt; the default adapter does not download models."
        ) from exc
    if Path(pipeline.__file__).resolve() != repo / "pipeline.py":
        raise RuntimeError("Imported pipeline is not from the selected VideoHighlighter checkout.")

    config = {
        "max_duration": 420, "clip_time": 18, "coverage": 0.4,
        "scene_points": 1, "motion_event_points": 1, "motion_peak_points": 2,
        "audio_peak_points": 2, "loudness_burst_points": 4,
        "object_points": 0, "action_points": 0, "keyword_points": 0,
        "transcript_points": 0, "face_expression_points": 0,
        "beginning_points": 0, "ending_points": 0,
        "highlight_objects": [], "interesting_actions": [],
        "use_transcript": False, "use_cache": True,
        **request.get("config", {}),
        # These are the adapter contract, not configurable output side effects.
        "report_only": True, "use_time_range": False,
        "create_timeline_viewer": False, "create_subtitles": False,
        "transcript_only": False, "export_separate_clips": False,
        "narrate_clips": False, "narrate_chapters": False,
        "write_highlight_report": True,
        "output_file": str(run_dir / "candidates.mp4"),
        "cache_dir": request["cacheDir"],
    }
    with unused_object_detector(config):
        segments = pipeline.run_highlighter(
            video_path=str(source), gui_config=config,
            log_fn=lambda message: print(message, flush=True),
        )
    if segments is None:
        raise RuntimeError("VideoHighlighter returned no result. Read the preceding pipeline error in analysis.log, correct the input or environment, and rerun.")
    report_path = run_dir / "candidates_why.json"
    report = None
    warnings = ["Candidates use audiovisual scores only; verify the game, players, event and complete possession before editing."]
    if report_path.is_file():
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            warnings.append(f"Could not read upstream score report: {exc}")
    else:
        warnings.append("Upstream produced no score report. Candidate time ranges are available without score explanations.")
    clips = normalize_segments(segments, report)
    if not clips:
        warnings.append("No candidate clips were found. Inspect the source recording and adjust scoring, or mark reviewed clips manually.")
    revision = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=False,
    ).stdout.strip() or None
    return {
        "source": "VideoHighlighter", "repoCommit": revision,
        "clips": clips, "semanticVerified": False, "warnings": warnings,
        "artifacts": [str(item) for item in sorted(run_dir.glob("candidates_why.*")) if item.is_file()],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args()
    try:
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        result = run(request)
        destination = Path(args.result)
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        os.replace(temporary, destination)
    except Exception as exc:
        print(f"VideoHighlighter adapter error: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
