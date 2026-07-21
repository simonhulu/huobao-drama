#!/usr/bin/env python3
"""Independent integrity checks for editorial-analysis artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


_CANDIDATE_LEVELS = {
    "setup_boundary_candidate",
    "visual_boundary_or_effect_candidate",
    "within_shot_animation_beat_candidate",
    "audio_beat_candidate",
}


def validate_interval_track(
    intervals: Sequence[Mapping[str, Any]],
    *,
    expected_end_frame: int,
    maximum_interval_frames: int | None,
    label: str,
) -> list[str]:
    errors: list[str] = []
    if not intervals:
        return [f"{label}: interval track is empty"]
    if int(intervals[0]["startFrame"]) != 0:
        errors.append(f"{label}: first interval does not start at frame 0")
    if int(intervals[-1]["endFrame"]) != expected_end_frame:
        errors.append(f"{label}: last interval does not end at frame {expected_end_frame}")

    for index, interval in enumerate(intervals):
        start = int(interval["startFrame"])
        end = int(interval["endFrame"])
        if end <= start:
            errors.append(f"{label}: interval {index} has non-positive duration")
        if maximum_interval_frames is not None and end - start > maximum_interval_frames:
            errors.append(
                f"{label}: interval {index} exceeds {maximum_interval_frames} frames"
            )
        if index + 1 < len(intervals):
            next_start = int(intervals[index + 1]["startFrame"])
            if end != next_start:
                errors.append(
                    f"{label}: intervals {index} and {index + 1} are not contiguous ({end} != {next_start})"
                )
    return errors


def validate_candidate_events(events: Sequence[Mapping[str, Any]]) -> list[str]:
    errors: list[str] = []
    ids = [str(event.get("id", "")) for event in events]
    duplicate_ids = sorted(candidate_id for candidate_id, count in Counter(ids).items() if count > 1)
    if duplicate_ids:
        errors.append(f"candidate ids are duplicated: {', '.join(duplicate_ids)}")

    previous_time = -math.inf
    for index, event in enumerate(events):
        candidate_id = str(event.get("id", ""))
        if not candidate_id:
            errors.append(f"candidate {index} has an empty id")
        time_seconds = float(event.get("timeSeconds", math.nan))
        if not math.isfinite(time_seconds) or time_seconds < 0:
            errors.append(f"candidate {candidate_id or index} has an invalid timestamp")
        if time_seconds < previous_time:
            errors.append(f"candidate events are not sorted at {candidate_id or index}")
        previous_time = time_seconds
        if event.get("candidateLevel") not in _CANDIDATE_LEVELS:
            errors.append(f"candidate {candidate_id or index} has an unknown level")
        evidence = event.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            errors.append(f"candidate {candidate_id or index} has no detector evidence")
    return errors


def validate_review_windows(
    windows: Sequence[Mapping[str, Any]],
    events: Sequence[Mapping[str, Any]],
    *,
    duration_seconds: float,
) -> list[str]:
    errors: list[str] = []
    events_by_id = {str(event["id"]): event for event in events}
    reference_counts: Counter[str] = Counter()
    previous_end = 0.0
    for index, window in enumerate(windows):
        start = float(window["startSeconds"])
        end = float(window["endSeconds"])
        if start < 0 or end > duration_seconds or end <= start:
            errors.append(f"review window {index} is outside the media or non-positive")
        if index > 0 and start < previous_end:
            errors.append(f"review windows {index - 1} and {index} overlap")
        previous_end = end
        candidate_ids = [str(candidate_id) for candidate_id in window.get("candidateIds", [])]
        if not candidate_ids:
            errors.append(f"review window {index} has no candidate ids")
        for candidate_id in candidate_ids:
            reference_counts[candidate_id] += 1
            event = events_by_id.get(candidate_id)
            if event is None:
                errors.append(f"review window {index} references unknown candidate {candidate_id}")
            elif not start <= float(event["timeSeconds"]) <= end:
                errors.append(f"review window {index} does not contain candidate {candidate_id}")

    for candidate_id in events_by_id:
        if reference_counts[candidate_id] != 1:
            errors.append(
                f"candidate {candidate_id} must be referenced exactly once; found {reference_counts[candidate_id]}"
            )
    return errors


def verify_artifact_record(record: Mapping[str, Any]) -> list[str]:
    path = Path(str(record["path"]))
    if not path.is_file():
        return [f"artifact is missing: {path}"]
    errors: list[str] = []
    expected_bytes = int(record["bytes"])
    if path.stat().st_size != expected_bytes:
        errors.append(
            f"artifact size mismatch for {path}: expected {expected_bytes}, found {path.stat().st_size}"
        )
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    actual_digest = digest.hexdigest()
    if actual_digest != record["sha256"]:
        errors.append(
            f"artifact digest mismatch for {path}: expected {record['sha256']}, found {actual_digest}"
        )
    return errors


def verify_analysis_directory(
    directory: Path,
    *,
    duration_seconds: float,
) -> dict[str, Any]:
    manifest_path = directory / "analysis-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_id = manifest.get("identity", {}).get("sourceId", "unknown")
    errors: list[str] = []
    if manifest.get("status") != "complete":
        errors.append("analysis manifest is not complete")

    artifacts = manifest.get("artifacts", [])
    for record in artifacts:
        errors.extend(verify_artifact_record(record))
    artifacts_by_name = {Path(record["path"]).name: Path(record["path"]) for record in artifacts}

    required_names = {
        "machine-coverage.json",
        "candidate-events.json",
        "subtitles.json",
        "audio-evidence.json",
    }
    missing_names = sorted(required_names - artifacts_by_name.keys())
    if missing_names:
        errors.append(f"required artifacts are absent from manifest: {', '.join(missing_names)}")
        return {"sourceId": source_id, "status": "failed", "errors": errors}

    coverage = json.loads(artifacts_by_name["machine-coverage.json"].read_text(encoding="utf-8"))
    candidate_payload = json.loads(
        artifacts_by_name["candidate-events.json"].read_text(encoding="utf-8")
    )
    subtitles = json.loads(artifacts_by_name["subtitles.json"].read_text(encoding="utf-8"))
    audio = json.loads(artifacts_by_name["audio-evidence.json"].read_text(encoding="utf-8"))

    end_frame = int(coverage["endFrame"])
    fps = coverage["sourceFps"]
    maximum_seconds = float(
        manifest["identity"]["config"]["coverage_max_segment_seconds"]
    )
    maximum_interval_frames = int(
        round(maximum_seconds * int(fps["numerator"]) / int(fps["denominator"]))
    )
    errors.extend(
        validate_interval_track(
            coverage["intervals"],
            expected_end_frame=end_frame,
            maximum_interval_frames=maximum_interval_frames,
            label="visual coverage",
        )
    )
    errors.extend(
        validate_interval_track(
            coverage["semanticIntervals"],
            expected_end_frame=end_frame,
            maximum_interval_frames=None,
            label="semantic coverage",
        )
    )

    events = candidate_payload["events"]
    review_windows = candidate_payload["reviewWindows"]
    errors.extend(validate_candidate_events(events))
    errors.extend(
        validate_review_windows(
            review_windows,
            events,
            duration_seconds=duration_seconds,
        )
    )

    expected_counts = {
        "combinedCandidates": len(events),
        "reviewWindows": len(review_windows),
        "visualCoverageIntervals": len(coverage["intervals"]),
        "semanticCoverageIntervals": len(coverage["semanticIntervals"]),
        "subtitleCues": len(subtitles["cues"]),
        "audioOnsets": len(audio["events"]),
    }
    for key, actual_value in expected_counts.items():
        if int(manifest["counts"].get(key, -1)) != actual_value:
            errors.append(
                f"count mismatch for {key}: manifest={manifest['counts'].get(key)}, actual={actual_value}"
            )

    return {
        "sourceId": source_id,
        "status": "passed" if not errors else "failed",
        "errors": errors,
        "counts": expected_counts,
        "coverage": {
            "startFrame": int(coverage["intervals"][0]["startFrame"]),
            "endFrame": int(coverage["intervals"][-1]["endFrame"]),
            "expectedEndFrame": end_frame,
            "visualIntervalCount": len(coverage["intervals"]),
            "semanticIntervalCount": len(coverage["semanticIntervals"]),
        },
        "audioCalibration": {
            "selectedDelta": audio.get("selectedDelta"),
            "targetDensityPerMinute": audio.get("targetDensityPerMinute"),
            "eventCount": len(audio["events"]),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify editorial-analysis artifacts and coverage.")
    parser.add_argument(
        "--manifest",
        type=Path,
        required=True,
    )
    parser.add_argument(
        "--analysis-directory",
        type=Path,
        action="append",
        required=True,
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
    )
    arguments = parser.parse_args()

    corpus_manifest = json.loads(arguments.manifest.read_text(encoding="utf-8"))
    durations = {
        source["id"]: float(source["formatDurationSeconds"])
        for source in corpus_manifest["sources"]
    }
    reports = []
    for directory in arguments.analysis_directory:
        analysis_manifest = json.loads(
            (directory / "analysis-manifest.json").read_text(encoding="utf-8")
        )
        source_id = analysis_manifest["identity"]["sourceId"]
        if source_id not in durations:
            reports.append(
                {
                    "sourceId": source_id,
                    "status": "failed",
                    "errors": ["source is not present in the corpus manifest"],
                }
            )
            continue
        reports.append(
            verify_analysis_directory(
                directory,
                duration_seconds=durations[source_id],
            )
        )

    expected_ids = {source["id"] for source in corpus_manifest["sources"]}
    actual_ids = {report["sourceId"] for report in reports}
    corpus_errors = []
    if actual_ids != expected_ids:
        corpus_errors.append(
            f"source set mismatch: expected {sorted(expected_ids)}, found {sorted(actual_ids)}"
        )
    status = (
        "passed"
        if not corpus_errors and all(report["status"] == "passed" for report in reports)
        else "failed"
    )
    output = {
        "schemaVersion": "analysis-verification-v1",
        "status": status,
        "corpusErrors": corpus_errors,
        "sourceReports": reports,
        "totals": {
            key: sum(report.get("counts", {}).get(key, 0) for report in reports)
            for key in (
                "combinedCandidates",
                "reviewWindows",
                "visualCoverageIntervals",
                "semanticCoverageIntervals",
                "subtitleCues",
                "audioOnsets",
            )
        },
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = arguments.output.with_name(f".{arguments.output.name}.tmp")
    temporary_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(arguments.output)
    print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
