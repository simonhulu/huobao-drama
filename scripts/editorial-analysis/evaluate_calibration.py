#!/usr/bin/env python3
"""Measure detector recall against a manually reviewed calibration range."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


_PROFILES = {
    "sceneAndDifference": frozenset({"ffmpeg_scene", "ffmpeg_difference"}),
    "sceneDifferenceAndEdge": frozenset(
        {"ffmpeg_scene", "ffmpeg_difference", "ffmpeg_edge_difference"}
    ),
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _event_detectors(event: Mapping[str, Any]) -> frozenset[str]:
    evidence = event.get("evidence", [])
    if not isinstance(evidence, list):
        raise ValueError(f"candidate {event.get('id', '<unknown>')} has invalid evidence")
    return frozenset(
        str(item["detector"])
        for item in evidence
        if isinstance(item, Mapping) and item.get("detector")
    )


def _evaluate_annotations(
    annotations: Sequence[Mapping[str, Any]],
    events: Sequence[Mapping[str, Any]],
    *,
    allowed_detectors: frozenset[str],
    tolerance_seconds: float,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    detected = 0
    for annotation in annotations:
        annotation_id = str(annotation["id"])
        start_seconds = float(annotation["startSeconds"])
        end_seconds = float(annotation["endSeconds"])
        if end_seconds < start_seconds:
            raise ValueError(f"annotation {annotation_id} has an inverted time range")

        matches = []
        for event in events:
            event_time = float(event["timeSeconds"])
            detectors = _event_detectors(event)
            if not detectors.intersection(allowed_detectors):
                continue
            if start_seconds - tolerance_seconds <= event_time <= end_seconds + tolerance_seconds:
                matches.append(
                    {
                        "candidateId": str(event["id"]),
                        "timeSeconds": event_time,
                        "detectors": sorted(detectors.intersection(allowed_detectors)),
                    }
                )

        status = "detected" if matches else "missed"
        if matches:
            detected += 1
        results.append(
            {
                "id": annotation_id,
                "startSeconds": start_seconds,
                "endSeconds": end_seconds,
                "status": status,
                "matchedCandidates": matches,
            }
        )

    total = len(results)
    return {
        "total": total,
        "detected": detected,
        "recall": detected / total if total else 1.0,
        "missedIds": [result["id"] for result in results if result["status"] == "missed"],
        "annotations": results,
    }


def evaluate_calibration(
    calibration: Mapping[str, Any],
    candidates: Mapping[str, Any],
) -> dict[str, Any]:
    if calibration.get("schemaVersion") != "observed-edit-calibration-v1":
        raise ValueError("unsupported calibration schema")
    if candidates.get("schemaVersion") != "candidate-events-v1":
        raise ValueError("unsupported candidate-events schema")
    source_id = str(calibration.get("sourceId", ""))
    if not source_id or candidates.get("sourceId") != source_id:
        raise ValueError("calibration and candidate source ids do not match")

    tolerance_seconds = float(
        calibration.get("evidence", {}).get("timeToleranceSeconds", 0.0)
    )
    if not math.isfinite(tolerance_seconds) or tolerance_seconds < 0:
        raise ValueError("calibration tolerance must be a non-negative finite number")

    events = candidates.get("events")
    if not isinstance(events, list):
        raise ValueError("candidate payload must contain an events list")

    profiles: dict[str, Any] = {}
    for profile_name, allowed_detectors in _PROFILES.items():
        profiles[profile_name] = {
            "detectors": sorted(allowed_detectors),
            "annotationSets": {
                "shotBoundaries": _evaluate_annotations(
                    calibration.get("shotBoundaries", []),
                    events,
                    allowed_detectors=allowed_detectors,
                    tolerance_seconds=tolerance_seconds,
                ),
                "withinShotBeats": _evaluate_annotations(
                    calibration.get("withinShotBeats", []),
                    events,
                    allowed_detectors=allowed_detectors,
                    tolerance_seconds=tolerance_seconds,
                ),
            },
        }

    return {
        "schemaVersion": "calibration-evaluation-v1",
        "sourceId": source_id,
        "analysisDigest": candidates.get("analysisDigest"),
        "range": calibration.get("range"),
        "timeToleranceSeconds": tolerance_seconds,
        "profiles": profiles,
    }


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minimum-shot-recall", type=float, default=0.0)
    parser.add_argument("--minimum-beat-recall", type=float, default=0.0)
    arguments = parser.parse_args()

    for name, value in (
        ("minimum shot recall", arguments.minimum_shot_recall),
        ("minimum beat recall", arguments.minimum_beat_recall),
    ):
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise ValueError(f"{name} must be between zero and one")

    calibration = json.loads(arguments.calibration.read_text(encoding="utf-8"))
    candidates = json.loads(arguments.candidates.read_text(encoding="utf-8"))
    report = evaluate_calibration(calibration, candidates)
    report["inputs"] = {
        "calibration": {
            "path": str(arguments.calibration.resolve()),
            "sha256": _sha256(arguments.calibration),
        },
        "candidates": {
            "path": str(arguments.candidates.resolve()),
            "sha256": _sha256(arguments.candidates),
        },
    }

    annotation_sets = report["profiles"]["sceneDifferenceAndEdge"]["annotationSets"]
    shot_recall = float(annotation_sets["shotBoundaries"]["recall"])
    beat_recall = float(annotation_sets["withinShotBeats"]["recall"])
    passed = (
        shot_recall >= arguments.minimum_shot_recall
        and beat_recall >= arguments.minimum_beat_recall
    )
    report["gate"] = {
        "status": "passed" if passed else "failed",
        "profile": "sceneDifferenceAndEdge",
        "minimumShotRecall": arguments.minimum_shot_recall,
        "minimumWithinShotBeatRecall": arguments.minimum_beat_recall,
        "actualShotRecall": shot_recall,
        "actualWithinShotBeatRecall": beat_recall,
    }
    _write_json(arguments.output, report)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
