#!/usr/bin/env python3
"""Verify subtitle-only semantic outlines against normalized source cues."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


_TOP_LEVEL_KEYS = {
    "schemaVersion",
    "sourceId",
    "analysisBasis",
    "coverage",
    "segments",
    "specialIntervals",
}
_SEGMENT_KEYS = {
    "id",
    "start",
    "end",
    "cueIds",
    "summary",
    "narrativeFunction",
    "discourseBoundary",
    "lexicalSignals",
    "entities",
    "metrics",
    "editorialOpportunities",
    "avoidOvereditingNotes",
}
_NESTED_ARRAY_SCHEMAS = {
    "lexicalSignals": {"cueIds": list, "text": str, "function": str},
    "entities": {"cueIds": list, "name": str, "type": str},
    "editorialOpportunities": {
        "cueIds": list,
        "semanticTrigger": str,
        "opportunity": str,
    },
    "avoidOvereditingNotes": {"cueIds": list, "note": str},
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _close(left: Any, right: Any, *, tolerance: float = 1e-6) -> bool:
    try:
        return math.isclose(float(left), float(right), abs_tol=tolerance, rel_tol=0.0)
    except (TypeError, ValueError):
        return False


def _nested_cue_id_lists(value: Any, pointer: str = "$" ) -> list[tuple[str, list[Any]]]:
    found: list[tuple[str, list[Any]]] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            child_pointer = f"{pointer}.{key}"
            if key == "cueIds":
                if isinstance(child, list):
                    found.append((child_pointer, child))
                else:
                    found.append((child_pointer, ["<invalid-list>"]))
            else:
                found.extend(_nested_cue_id_lists(child, child_pointer))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(_nested_cue_id_lists(child, f"{pointer}[{index}]"))
    return found


def _expected_gaps(cues: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    gaps = []
    for previous, current in zip(cues, cues[1:]):
        start = float(previous["endSeconds"])
        end = float(current["startSeconds"])
        if end <= start:
            continue
        gaps.append(
            {
                "start": start,
                "end": end,
                "durationSeconds": end - start,
                "afterCueId": int(previous["index"]),
                "beforeCueId": int(current["index"]),
            }
        )
    return gaps


def _validate_gap_records(
    actual: Any,
    expected: Sequence[Mapping[str, Any]],
    *,
    label: str,
) -> list[str]:
    if not isinstance(actual, list):
        return [f"{label} must be an array"]
    errors = []
    if len(actual) != len(expected):
        errors.append(f"{label} count mismatch: expected {len(expected)}, found {len(actual)}")
    for index, (actual_gap, expected_gap) in enumerate(zip(actual, expected)):
        for key, expected_value in expected_gap.items():
            actual_value = actual_gap.get(key)
            if isinstance(expected_value, float):
                if not _close(actual_value, expected_value):
                    errors.append(f"{label}[{index}].{key} does not match subtitles")
            elif actual_value != expected_value:
                errors.append(f"{label}[{index}].{key} does not match subtitles")
    return errors


def validate_semantic_outline(
    outline: Mapping[str, Any],
    subtitles: Mapping[str, Any],
) -> list[str]:
    errors: list[str] = []
    if set(outline) != _TOP_LEVEL_KEYS:
        errors.append("semantic outline top-level keys do not match the v1 contract")
    if outline.get("schemaVersion") != "semantic-outline-v1":
        errors.append("unsupported semantic outline schema")
    if subtitles.get("schemaVersion") != "normalized-subtitles-v1":
        errors.append("unsupported normalized subtitles schema")
    source_id = str(outline.get("sourceId", ""))
    if not source_id or subtitles.get("sourceId") != source_id:
        errors.append("outline and subtitles source ids do not match")

    cues = subtitles.get("cues", [])
    segments = outline.get("segments", [])
    if not isinstance(cues, list) or not cues:
        return [*errors, "normalized subtitles contain no cues"]
    if not isinstance(segments, list) or not segments:
        return [*errors, "semantic outline contains no segments"]

    expected_cue_ids = [int(cue["index"]) for cue in cues]
    cues_by_id = {int(cue["index"]): cue for cue in cues}
    assigned_ids: list[int] = []
    segment_ids: Counter[str] = Counter()
    for index, segment in enumerate(segments):
        segment_id = str(segment.get("id", ""))
        segment_ids[segment_id] += 1
        if set(segment) != _SEGMENT_KEYS:
            errors.append(f"segment {segment_id or index} keys do not match the v1 contract")
        if not isinstance(segment.get("summary"), str) or not segment.get("summary", "").strip():
            errors.append(f"segment {segment_id or index} summary must be non-empty text")
        if not isinstance(segment.get("narrativeFunction"), str) or not segment.get(
            "narrativeFunction", ""
        ).strip():
            errors.append(
                f"segment {segment_id or index} narrativeFunction must be non-empty text"
            )
        boundary = segment.get("discourseBoundary")
        boundary_schema = {"type": str, "cueIds": list, "description": str}
        if not isinstance(boundary, Mapping) or set(boundary) != set(boundary_schema):
            errors.append(f"segment {segment_id or index} discourseBoundary is malformed")
        elif any(not isinstance(boundary[key], expected) for key, expected in boundary_schema.items()):
            errors.append(f"segment {segment_id or index} discourseBoundary types are invalid")
        for field, schema in _NESTED_ARRAY_SCHEMAS.items():
            records = segment.get(field)
            if not isinstance(records, list):
                errors.append(f"segment {segment_id or index} {field} must be an array")
                continue
            for record_index, record in enumerate(records):
                if not isinstance(record, Mapping) or set(record) != set(schema):
                    errors.append(
                        f"segment {segment_id or index} {field}[{record_index}] is malformed"
                    )
                    continue
                if any(not isinstance(record[key], expected) for key, expected in schema.items()):
                    errors.append(
                        f"segment {segment_id or index} {field}[{record_index}] types are invalid"
                    )
        cue_ids = segment.get("cueIds", [])
        if not isinstance(cue_ids, list) or not cue_ids:
            errors.append(f"segment {segment_id or index} has no cue ids")
            continue
        if any(not isinstance(cue_id, int) for cue_id in cue_ids):
            errors.append(f"segment {segment_id or index} cue ids must be integers")
            continue
        assigned_ids.extend(cue_ids)
        segment_cue_set = set(cue_ids)
        first_cue = cues_by_id.get(cue_ids[0])
        last_cue = cues_by_id.get(cue_ids[-1])
        if first_cue is None or last_cue is None:
            errors.append(f"segment {segment_id or index} references an unknown boundary cue")
            continue
        if not _close(segment.get("start"), first_cue["startSeconds"]):
            errors.append(f"segment {segment_id or index} does not start at its first cue")
        expected_end = (
            float(segments[index + 1]["start"])
            if index + 1 < len(segments)
            else float(last_cue["endSeconds"])
        )
        if not _close(segment.get("end"), expected_end):
            errors.append(f"segment {segment_id or index} end is not contiguous")
        if float(last_cue["endSeconds"]) > float(segment["end"]) + 1e-6:
            errors.append(f"segment {segment_id or index} ends before its last cue")

        for pointer, nested_ids in _nested_cue_id_lists(segment):
            if any(not isinstance(cue_id, int) or cue_id not in segment_cue_set for cue_id in nested_ids):
                errors.append(f"segment {segment_id or index} has out-of-segment ids at {pointer}")

        segment_cues = [cues_by_id[cue_id] for cue_id in cue_ids if cue_id in cues_by_id]
        captioned_seconds = sum(
            float(cue["endSeconds"]) - float(cue["startSeconds"])
            for cue in segment_cues
        )
        duration_seconds = float(segment["end"]) - float(segment["start"])
        metrics = segment.get("metrics", {})
        expected_metric_keys = {
            "durationSeconds",
            "cueCount",
            "captionedSeconds",
            "captionCoverageRatio",
            "quantifiedClaimCueIds",
            "questionCueIds",
        }
        if not isinstance(metrics, Mapping) or set(metrics) != expected_metric_keys:
            errors.append(f"segment {segment_id or index} metrics are malformed")
            metrics = {}
        elif not isinstance(metrics["quantifiedClaimCueIds"], list) or not isinstance(
            metrics["questionCueIds"], list
        ):
            errors.append(f"segment {segment_id or index} metric cue ids must be arrays")
        expected_metrics = {
            "durationSeconds": duration_seconds,
            "cueCount": len(cue_ids),
            "captionedSeconds": captioned_seconds,
            "captionCoverageRatio": captioned_seconds / duration_seconds,
        }
        for key, expected_value in expected_metrics.items():
            actual_value = metrics.get(key)
            if key == "cueCount":
                if actual_value != expected_value:
                    errors.append(f"segment {segment_id or index} metric {key} is incorrect")
            elif not _close(actual_value, expected_value, tolerance=1e-5):
                errors.append(f"segment {segment_id or index} metric {key} is incorrect")

    duplicate_segment_ids = sorted(
        segment_id for segment_id, count in segment_ids.items() if not segment_id or count > 1
    )
    if duplicate_segment_ids:
        errors.append(f"empty or duplicate segment ids: {', '.join(duplicate_segment_ids)}")
    if assigned_ids != expected_cue_ids:
        assigned_counts = Counter(assigned_ids)
        missing = [cue_id for cue_id in expected_cue_ids if assigned_counts[cue_id] == 0]
        duplicates = [cue_id for cue_id, count in assigned_counts.items() if count > 1]
        errors.append(
            f"cue assignment is not exactly once and ordered; missing={missing}, duplicates={duplicates}"
        )

    first_start = float(cues[0]["startSeconds"])
    last_end = float(cues[-1]["endSeconds"])
    captioned_seconds = sum(
        float(cue["endSeconds"]) - float(cue["startSeconds"]) for cue in cues
    )
    coverage = outline.get("coverage", {})
    coverage_expectations = {
        "start": first_start,
        "end": last_end,
        "segmentCount": len(segments),
        "captionedSeconds": captioned_seconds,
    }
    for key, expected_value in coverage_expectations.items():
        actual_value = coverage.get(key)
        if key == "segmentCount":
            if actual_value != expected_value:
                errors.append(f"coverage {key} is incorrect")
        elif not _close(actual_value, expected_value, tolerance=1e-5):
            errors.append(f"coverage {key} is incorrect")
    if coverage.get("segmentsAreContinuous") is not True:
        errors.append("coverage does not assert continuous segments")
    if coverage.get("cueAssignment") != "exactly-once":
        errors.append("coverage does not assert exactly-once cue assignment")
    errors.extend(
        _validate_gap_records(
            coverage.get("subtitleGaps"),
            _expected_gaps(cues),
            label="coverage.subtitleGaps",
        )
    )

    media_duration = float(subtitles["mediaDurationSeconds"])
    expected_edge_intervals = []
    if first_start > 0:
        expected_edge_intervals.append(
            {"start": 0.0, "end": first_start, "durationSeconds": first_start}
        )
    if last_end < media_duration:
        expected_edge_intervals.append(
            {
                "start": last_end,
                "end": media_duration,
                "durationSeconds": media_duration - last_end,
            }
        )
    errors.extend(
        _validate_gap_records(
            coverage.get("edgeUncaptionedIntervals"),
            expected_edge_intervals,
            label="coverage.edgeUncaptionedIntervals",
        )
    )

    basis = outline.get("analysisBasis", {})
    if basis.get("modality") != "subtitle-only":
        errors.append("analysisBasis.modality must be subtitle-only")
    basis_expectations = {
        "mediaDurationSeconds": media_duration,
        "cueCount": len(cues),
        "firstCueStart": first_start,
        "lastCueEnd": last_end,
    }
    for key, expected_value in basis_expectations.items():
        actual_value = basis.get(key)
        if key == "cueCount":
            if actual_value != expected_value:
                errors.append(f"analysisBasis.{key} is incorrect")
        elif not _close(actual_value, expected_value):
            errors.append(f"analysisBasis.{key} is incorrect")

    for interval_index, interval in enumerate(outline.get("specialIntervals", [])):
        interval_schema = {
            "type": str,
            "start": (int, float),
            "end": (int, float),
            "cueIds": list,
            "description": str,
        }
        if not isinstance(interval, Mapping) or set(interval) != set(interval_schema):
            errors.append(f"special interval {interval_index} is malformed")
            continue
        if any(
            not isinstance(interval[key], expected)
            for key, expected in interval_schema.items()
        ):
            errors.append(f"special interval {interval_index} types are invalid")
            continue
        cue_ids = interval.get("cueIds", [])
        if not cue_ids or any(cue_id not in cues_by_id for cue_id in cue_ids):
            errors.append(f"special interval {interval_index} has invalid cue ids")
            continue
        if float(interval["start"]) > float(cues_by_id[cue_ids[0]]["startSeconds"]):
            errors.append(f"special interval {interval_index} starts after its first cue")
        if float(interval["end"]) < float(cues_by_id[cue_ids[-1]]["endSeconds"]):
            errors.append(f"special interval {interval_index} ends before its last cue")
    return errors


def verify_semantic_outline(outline_path: Path, subtitles_path: Path) -> dict[str, Any]:
    outline = json.loads(outline_path.read_text(encoding="utf-8"))
    subtitles = json.loads(subtitles_path.read_text(encoding="utf-8"))
    errors = validate_semantic_outline(outline, subtitles)
    basis = outline.get("analysisBasis", {})
    srt_path = Path(str(basis.get("srtPath", "")))
    if not srt_path.is_file():
        errors.append(f"analysisBasis SRT is missing: {srt_path}")
    elif _sha256(srt_path) != basis.get("srtSha256"):
        errors.append("analysisBasis SRT hash does not match")
    return {
        "sourceId": str(outline.get("sourceId", "unknown")),
        "status": "passed" if not errors else "failed",
        "errors": errors,
        "counts": {
            "segments": len(outline.get("segments", [])),
            "cues": len(subtitles.get("cues", [])),
            "specialIntervals": len(outline.get("specialIntervals", [])),
            "subtitleGaps": len(outline.get("coverage", {}).get("subtitleGaps", [])),
        },
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
    parser.add_argument("--outline", type=Path, action="append", required=True)
    parser.add_argument("--subtitles", type=Path, action="append", required=True)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
    )
    arguments = parser.parse_args()
    if len(arguments.outline) != len(arguments.subtitles):
        raise ValueError("--outline and --subtitles counts must match")
    reports = [
        verify_semantic_outline(outline_path, subtitles_path)
        for outline_path, subtitles_path in zip(arguments.outline, arguments.subtitles)
    ]
    source_ids = [report["sourceId"] for report in reports]
    corpus_errors = []
    if len(source_ids) != len(set(source_ids)):
        corpus_errors.append("semantic outline source ids are duplicated")
    status = (
        "passed"
        if not corpus_errors and all(report["status"] == "passed" for report in reports)
        else "failed"
    )
    output = {
        "schemaVersion": "semantic-outlines-verification-v1",
        "status": status,
        "corpusErrors": corpus_errors,
        "sourceReports": reports,
        "totals": {
            key: sum(int(report["counts"][key]) for report in reports)
            for key in ("segments", "cues", "specialIntervals", "subtitleGaps")
        },
    }
    _write_json(arguments.output, output)
    print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
