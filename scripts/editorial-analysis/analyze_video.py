#!/usr/bin/env python3
"""Build an auditable coarse-analysis index for the reference-video corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from scipy.io import wavfile

from audio import detect_side_onsets
from core import build_coverage, canonical_digest, parse_srt
from detectors import (
    cluster_scene_events,
    merge_candidate_events,
    parse_ffmpeg_metadata,
    select_adaptive_diff_peaks,
)


ANALYZER_VERSION = "editorial-analysis-v1"


@dataclass(frozen=True)
class AnalysisConfig:
    scene_activity_threshold: float = 0.08
    scene_strong_threshold: float = 0.22
    scene_cluster_seconds: float = 0.25
    diff_sample_fps: float = 12.0
    diff_quantile: float = 0.82
    diff_spacing_seconds: float = 0.5
    edge_sample_fps: float = 4.0
    edge_quantile: float = 0.50
    edge_spacing_seconds: float = 0.25
    edge_baseline_window_seconds: float = 60.0
    visual_merge_seconds: float = 0.25
    audio_sample_rate: int = 22_050
    audio_hop_length: int = 512
    audio_onset_delta: float = 0.30
    audio_onset_wait: int = 21
    audio_delta_minimum: float = 0.20
    audio_delta_maximum: float = 0.40
    audio_delta_step: float = 0.01
    audio_target_density_minimum: float = 8.0
    audio_target_density_maximum: float = 15.0
    audio_attach_seconds: float = 0.35
    coverage_max_segment_seconds: float = 2.0


def load_manifest_source(manifest_path: Path, source_id: str) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != "corpus-manifest-v1":
        raise ValueError("unsupported corpus manifest schema")
    sources = manifest.get("sources")
    if not isinstance(sources, list):
        raise ValueError("corpus manifest sources must be an array")
    matches = [source for source in sources if source.get("id") == source_id]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one source with id {source_id!r}")
    return matches[0]


def verify_input_file(file_record: dict[str, Any]) -> dict[str, Any]:
    path = Path(file_record["path"])
    if not path.is_file():
        raise FileNotFoundError(path)
    byte_count = path.stat().st_size
    expected_byte_count = int(file_record["bytes"])
    if byte_count != expected_byte_count:
        raise ValueError(
            f"input size mismatch for {path}: expected {expected_byte_count}, found {byte_count}"
        )

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    actual_sha256 = digest.hexdigest()
    expected_sha256 = str(file_record["sha256"])
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"input SHA-256 mismatch for {path}: expected {expected_sha256}, found {actual_sha256}"
        )
    return {"path": str(path), "bytes": byte_count, "sha256": actual_sha256}


def build_analysis_identity(source: dict[str, Any], config: AnalysisConfig) -> dict[str, Any]:
    payload = {
        "analyzerVersion": ANALYZER_VERSION,
        "sourceId": source["id"],
        "videoSha256": source["mp4"]["sha256"],
        "subtitleSha256": source["srt"]["sha256"],
        "config": asdict(config),
    }
    return {**payload, "digest": canonical_digest(payload)}


def combine_candidate_layers(
    *,
    scene_events: list[dict[str, Any]],
    difference_events: list[dict[str, Any]],
    edge_events: list[dict[str, Any]] | None = None,
    audio_events: list[dict[str, Any]],
    visual_merge_seconds: float,
    audio_attach_seconds: float,
) -> list[dict[str, Any]]:
    visual = merge_candidate_events(
        [*scene_events, *difference_events, *(edge_events or [])],
        merge_window_seconds=visual_merge_seconds,
    )

    unattached_audio: list[dict[str, Any]] = []
    for audio_event in audio_events:
        nearest = min(
            visual,
            key=lambda event: abs(event["timeSeconds"] - audio_event["timeSeconds"]),
            default=None,
        )
        if nearest is None or abs(nearest["timeSeconds"] - audio_event["timeSeconds"]) > audio_attach_seconds:
            unattached_audio.append(audio_event)
            continue
        nearest["evidence"].append(dict(audio_event))
        nearest["families"] = sorted({*nearest["families"], str(audio_event["family"])})
        nearest["detectors"] = sorted({*nearest["detectors"], str(audio_event["detector"])})

    combined = [*visual]
    combined.extend(
        merge_candidate_events(unattached_audio, merge_window_seconds=visual_merge_seconds)
    )
    return sorted(combined, key=lambda event: event["timeSeconds"])


def merge_review_windows(
    events: list[dict[str, Any]],
    *,
    before_seconds: float,
    after_seconds: float,
    duration_seconds: float,
) -> list[dict[str, Any]]:
    if before_seconds < 0 or after_seconds < 0 or duration_seconds <= 0:
        raise ValueError("review window durations must be valid")

    windows: list[dict[str, Any]] = []
    for event in sorted(events, key=lambda item: item["timeSeconds"]):
        start = max(0.0, float(event["timeSeconds"]) - before_seconds)
        end = min(duration_seconds, float(event["timeSeconds"]) + after_seconds)
        if windows and start <= windows[-1]["endSeconds"]:
            windows[-1]["endSeconds"] = max(windows[-1]["endSeconds"], end)
            windows[-1]["candidateIds"].append(event["id"])
        else:
            windows.append(
                {
                    "startSeconds": start,
                    "endSeconds": end,
                    "candidateIds": [event["id"]],
                }
            )
    return windows


def _metadata_output_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _run_ffmpeg_metadata_pass(
    video_path: Path,
    log_path: Path,
    *,
    video_filter: str,
    metadata_key: str,
    value_name: str,
) -> list[dict[str, Any]]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.unlink(missing_ok=True)
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        str(video_path),
        "-vf",
        f"{video_filter},metadata=print:key={metadata_key}:file='{_metadata_output_path(log_path)}'",
        "-an",
        "-f",
        "null",
        "-",
    ]
    subprocess.run(command, check=True)
    return parse_ffmpeg_metadata(
        log_path.read_text(encoding="utf-8"),
        metadata_key=metadata_key,
        value_name=value_name,
    )


def run_scene_evidence(
    video_path: Path,
    log_path: Path,
    *,
    analysis_width: int = 320,
) -> list[dict[str, Any]]:
    if analysis_width <= 0:
        raise ValueError("analysis width must be positive")
    return _run_ffmpeg_metadata_pass(
        video_path,
        log_path,
        video_filter=f"scale={analysis_width}:-2:flags=area,select='gte(scene,0)'",
        metadata_key="lavfi.scene_score",
        value_name="score",
    )


def run_difference_evidence(
    video_path: Path,
    log_path: Path,
    *,
    analysis_width: int = 320,
    sample_fps: float = 12.0,
) -> list[dict[str, Any]]:
    if analysis_width <= 0 or sample_fps <= 0:
        raise ValueError("analysis width and sample FPS must be positive")
    return _run_ffmpeg_metadata_pass(
        video_path,
        log_path,
        video_filter=(
            f"scale={analysis_width}:-2:flags=area,fps={sample_fps:g},"
            "tblend=all_mode=difference,signalstats"
        ),
        metadata_key="lavfi.signalstats.YAVG",
        value_name="difference",
    )


def run_edge_difference_evidence(
    video_path: Path,
    log_path: Path,
    *,
    analysis_width: int = 320,
    sample_fps: float = 4.0,
) -> list[dict[str, Any]]:
    if analysis_width <= 0 or sample_fps <= 0:
        raise ValueError("analysis width and edge sample FPS must be positive")
    return _run_ffmpeg_metadata_pass(
        video_path,
        log_path,
        video_filter=(
            f"fps={sample_fps:g},scale={analysis_width}:-2:flags=area,"
            "edgedetect=low=0.05:high=0.15,tblend=all_mode=difference,signalstats"
        ),
        metadata_key="lavfi.signalstats.YAVG",
        value_name="difference",
    )


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    with temporary_path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(
                json.dumps(
                    record,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
            )
            handle.write("\n")
    temporary_path.replace(path)


def _probe_media(video_path: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _run_side_audio_evidence(
    video_path: Path,
    wav_path: Path,
    *,
    sample_rate: int,
    hop_length: int,
    delta: float,
    wait: int,
    delta_bounds: tuple[float, float],
    delta_step: float,
    target_density_per_minute: tuple[float, float],
) -> dict[str, Any]:
    wav_path.unlink(missing_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "2",
            "-ar",
            str(sample_rate),
            "-c:a",
            "pcm_s16le",
            "-y",
            str(wav_path),
        ],
        check=True,
    )
    actual_sample_rate, samples = wavfile.read(wav_path)
    if actual_sample_rate != sample_rate:
        raise ValueError(
            f"audio resample mismatch: expected {sample_rate}, found {actual_sample_rate}"
        )
    try:
        return detect_side_onsets(
            samples,
            sample_rate=actual_sample_rate,
            hop_length=hop_length,
            delta=delta,
            wait=wait,
            target_density_per_minute=target_density_per_minute,
            delta_bounds=delta_bounds,
            delta_step=delta_step,
        )
    finally:
        wav_path.unlink(missing_ok=True)


def _event_context(time_seconds: float, cues: list[dict[str, Any]]) -> dict[str, Any]:
    overlapping = [
        cue
        for cue in cues
        if cue["startSeconds"] <= time_seconds < cue["endSeconds"]
    ]
    if overlapping:
        return {
            "nearestSubtitleCueIds": [cue["id"] for cue in overlapping],
            "subtitleDistanceSeconds": 0.0,
            "transcript": " ".join(cue["text"].replace("\n", " ") for cue in overlapping),
        }
    if not cues:
        return {
            "nearestSubtitleCueIds": [],
            "subtitleDistanceSeconds": None,
            "transcript": "",
        }
    nearest = min(
        cues,
        key=lambda cue: min(
            abs(time_seconds - cue["startSeconds"]),
            abs(time_seconds - cue["endSeconds"]),
        ),
    )
    distance = min(
        abs(time_seconds - nearest["startSeconds"]),
        abs(time_seconds - nearest["endSeconds"]),
    )
    return {
        "nearestSubtitleCueIds": [nearest["id"]],
        "subtitleDistanceSeconds": distance,
        "transcript": nearest["text"].replace("\n", " "),
    }


def _candidate_level(event: dict[str, Any]) -> str:
    scene_evidence = [
        evidence
        for evidence in event["evidence"]
        if evidence.get("detector") == "ffmpeg_scene"
    ]
    if any(evidence.get("tier") == "strong" for evidence in scene_evidence):
        return "setup_boundary_candidate"
    if scene_evidence:
        return "visual_boundary_or_effect_candidate"
    if {
        "ffmpeg_difference",
        "ffmpeg_edge_difference",
    }.intersection(event["detectors"]):
        return "within_shot_animation_beat_candidate"
    return "audio_beat_candidate"


def _tool_versions() -> dict[str, str]:
    ffmpeg_version = subprocess.run(
        ["ffmpeg", "-version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()[0]
    ffprobe_version = subprocess.run(
        ["ffprobe", "-version"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()[0]
    import librosa

    return {
        "analyzer": ANALYZER_VERSION,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "ffmpeg": ffmpeg_version,
        "ffprobe": ffprobe_version,
        "opencv": cv2.__version__,
        "numpy": np.__version__,
        "librosa": librosa.__version__,
    }


def _artifact_record(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return {
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "sha256": digest.hexdigest(),
    }


def analyze_source(
    source: dict[str, Any],
    *,
    config: AnalysisConfig,
    output_root: Path,
    force: bool = False,
) -> dict[str, Any]:
    """Run deterministic coarse analysis for one manifest source."""

    identity = build_analysis_identity(source, config)
    output_directory = output_root / f"{source['id']}-{identity['digest'][:16]}"
    manifest_path = output_directory / "analysis-manifest.json"
    if not force and manifest_path.is_file():
        cached = json.loads(manifest_path.read_text(encoding="utf-8"))
        if cached.get("status") == "complete" and cached.get("identity") == identity:
            return cached

    output_directory.mkdir(parents=True, exist_ok=True)
    verified_video = verify_input_file(source["mp4"])
    verified_subtitles = verify_input_file(source["srt"])
    video_path = Path(source["mp4"]["path"])
    subtitle_path = Path(source["srt"]["path"])
    duration_seconds = float(source["formatDurationSeconds"])
    fps_numerator = int(source["video"]["fps"]["numerator"])
    fps_denominator = int(source["video"]["fps"]["denominator"])

    media_profile = _probe_media(video_path)
    media_profile_path = output_directory / "media-profile.json"
    _write_json(media_profile_path, media_profile)

    cues = parse_srt(
        subtitle_path.read_text(encoding="utf-8-sig"),
        media_duration_seconds=duration_seconds,
    )
    subtitles_path = output_directory / "subtitles.json"
    _write_json(
        subtitles_path,
        {
            "schemaVersion": "normalized-subtitles-v1",
            "sourceId": source["id"],
            "mediaDurationSeconds": duration_seconds,
            "cues": cues,
        },
    )

    scene_log_path = output_directory / "scene-evidence.ffmetadata"
    scene_records = run_scene_evidence(video_path, scene_log_path)
    scene_jsonl_path = output_directory / "scene-evidence.jsonl"
    _write_jsonl(scene_jsonl_path, scene_records)
    scene_events = cluster_scene_events(
        scene_records,
        activity_threshold=config.scene_activity_threshold,
        strong_threshold=config.scene_strong_threshold,
        cluster_window_seconds=config.scene_cluster_seconds,
    )

    difference_log_path = output_directory / "difference-evidence.ffmetadata"
    difference_records = run_difference_evidence(
        video_path,
        difference_log_path,
        sample_fps=config.diff_sample_fps,
    )
    difference_jsonl_path = output_directory / "difference-evidence.jsonl"
    _write_jsonl(difference_jsonl_path, difference_records)
    difference_events = select_adaptive_diff_peaks(
        difference_records,
        quantile=config.diff_quantile,
        min_spacing_seconds=config.diff_spacing_seconds,
    )

    edge_log_path = output_directory / "edge-difference-evidence.ffmetadata"
    edge_records = run_edge_difference_evidence(
        video_path,
        edge_log_path,
        sample_fps=config.edge_sample_fps,
    )
    edge_jsonl_path = output_directory / "edge-difference-evidence.jsonl"
    _write_jsonl(edge_jsonl_path, edge_records)
    edge_events = select_adaptive_diff_peaks(
        edge_records,
        quantile=config.edge_quantile,
        min_spacing_seconds=config.edge_spacing_seconds,
        detector="ffmpeg_edge_difference",
        family="text_or_graphic_state_candidate",
        baseline_window_seconds=config.edge_baseline_window_seconds,
    )

    audio_evidence = _run_side_audio_evidence(
        video_path,
        output_directory / ".audio-side.wav",
        sample_rate=config.audio_sample_rate,
        hop_length=config.audio_hop_length,
        delta=config.audio_onset_delta,
        wait=config.audio_onset_wait,
        delta_bounds=(config.audio_delta_minimum, config.audio_delta_maximum),
        delta_step=config.audio_delta_step,
        target_density_per_minute=(
            config.audio_target_density_minimum,
            config.audio_target_density_maximum,
        ),
    )
    audio_evidence_path = output_directory / "audio-evidence.json"
    _write_json(audio_evidence_path, audio_evidence)

    combined = combine_candidate_layers(
        scene_events=scene_events,
        difference_events=difference_events,
        edge_events=edge_events,
        audio_events=audio_evidence["events"],
        visual_merge_seconds=config.visual_merge_seconds,
        audio_attach_seconds=config.audio_attach_seconds,
    )
    candidates: list[dict[str, Any]] = []
    for index, event in enumerate(combined, start=1):
        candidate = {
            **event,
            "id": f"{source['id']}-candidate-{index:06d}",
            "candidateLevel": _candidate_level(event),
            **_event_context(float(event["timeSeconds"]), cues),
            "review": {"status": "unreviewed", "notes": []},
        }
        candidates.append(candidate)

    review_windows = merge_review_windows(
        candidates,
        before_seconds=0.5,
        after_seconds=0.5,
        duration_seconds=duration_seconds,
    )
    candidate_events_path = output_directory / "candidate-events.json"
    _write_json(
        candidate_events_path,
        {
            "schemaVersion": "candidate-events-v1",
            "sourceId": source["id"],
            "analysisDigest": identity["digest"],
            "events": candidates,
            "reviewWindows": review_windows,
        },
    )

    visual_event_seconds = [
        float(candidate["timeSeconds"])
        for candidate in candidates
        if candidate["candidateLevel"] != "audio_beat_candidate"
    ]
    coverage = build_coverage(
        source_id=source["id"],
        duration_seconds=duration_seconds,
        fps_numerator=fps_numerator,
        fps_denominator=fps_denominator,
        subtitle_cues=cues,
        visual_event_seconds=visual_event_seconds,
        max_segment_seconds=config.coverage_max_segment_seconds,
    )
    coverage["schemaVersion"] = "machine-coverage-v1"
    coverage["analysisDigest"] = identity["digest"]
    coverage_path = output_directory / "machine-coverage.json"
    _write_json(coverage_path, coverage)

    artifact_paths = [
        media_profile_path,
        subtitles_path,
        scene_log_path,
        scene_jsonl_path,
        difference_log_path,
        difference_jsonl_path,
        edge_log_path,
        edge_jsonl_path,
        audio_evidence_path,
        candidate_events_path,
        coverage_path,
    ]
    result = {
        "schemaVersion": "analysis-run-manifest-v1",
        "status": "complete",
        "identity": identity,
        "outputDirectory": str(output_directory.resolve()),
        "verifiedInputs": {
            "video": verified_video,
            "subtitles": verified_subtitles,
        },
        "tools": _tool_versions(),
        "counts": {
            "subtitleCues": len(cues),
            "sceneEvidenceFrames": len(scene_records),
            "sceneCandidates": len(scene_events),
            "differenceEvidenceFrames": len(difference_records),
            "differenceCandidates": len(difference_events),
            "edgeDifferenceEvidenceFrames": len(edge_records),
            "edgeDifferenceCandidates": len(edge_events),
            "audioOnsets": len(audio_evidence["events"]),
            "combinedCandidates": len(candidates),
            "reviewWindows": len(review_windows),
            "visualCoverageIntervals": len(coverage["intervals"]),
            "semanticCoverageIntervals": len(coverage["semanticIntervals"]),
        },
        "artifacts": [_artifact_record(path) for path in artifact_paths],
    }
    _write_json(manifest_path, result)
    return result


def build_argument_parser() -> argparse.ArgumentParser:
    defaults = AnalysisConfig()
    parser = argparse.ArgumentParser(
        description="Build coarse, auditable editorial-analysis evidence for the reference corpus."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("docs/editorial-grammar/corpus-manifest.json"),
    )
    parser.add_argument(
        "--source",
        action="append",
        default=["all"],
        help="Source id to analyze; repeat for multiple sources (default: all).",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("tmp/editorial-analysis"),
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--scene-activity-threshold", type=float, default=defaults.scene_activity_threshold)
    parser.add_argument("--scene-strong-threshold", type=float, default=defaults.scene_strong_threshold)
    parser.add_argument("--diff-sample-fps", type=float, default=defaults.diff_sample_fps)
    parser.add_argument("--diff-quantile", type=float, default=defaults.diff_quantile)
    parser.add_argument("--audio-onset-delta", type=float, default=defaults.audio_onset_delta)
    parser.add_argument("--audio-onset-wait", type=int, default=defaults.audio_onset_wait)
    return parser


def resolve_source_ids(requested_ids: list[str], available_ids: list[str]) -> list[str]:
    explicit_ids = [source_id for source_id in requested_ids if source_id != "all"]
    selected = explicit_ids if explicit_ids else available_ids
    return list(dict.fromkeys(selected))


def main(argv: list[str] | None = None) -> int:
    arguments = build_argument_parser().parse_args(argv)
    manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != "corpus-manifest-v1":
        raise ValueError("unsupported corpus manifest schema")
    available_ids = [source["id"] for source in manifest.get("sources", [])]
    requested_ids = resolve_source_ids(arguments.source, available_ids)
    unknown_ids = sorted(set(requested_ids) - set(available_ids))
    if unknown_ids:
        raise ValueError(f"unknown source ids: {', '.join(unknown_ids)}")

    config = AnalysisConfig(
        scene_activity_threshold=arguments.scene_activity_threshold,
        scene_strong_threshold=arguments.scene_strong_threshold,
        diff_sample_fps=arguments.diff_sample_fps,
        diff_quantile=arguments.diff_quantile,
        audio_onset_delta=arguments.audio_onset_delta,
        audio_onset_wait=arguments.audio_onset_wait,
    )
    results = []
    for source_id in requested_ids:
        source = load_manifest_source(arguments.manifest, source_id)
        print(f"[{source_id}] analyzing", file=sys.stderr, flush=True)
        result = analyze_source(
            source,
            config=config,
            output_root=arguments.output_root,
            force=arguments.force,
        )
        print(
            f"[{source_id}] {result['status']}: {result['counts']['combinedCandidates']} candidates, "
            f"{result['counts']['reviewWindows']} review windows",
            file=sys.stderr,
            flush=True,
        )
        results.append(result)

    print(
        json.dumps(
            {
                "schemaVersion": "analysis-run-summary-v1",
                "status": "complete",
                "sources": [
                    {
                        "sourceId": result["identity"]["sourceId"],
                        "outputDirectory": result["outputDirectory"],
                        "counts": result["counts"],
                    }
                    for result in results
                ],
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
