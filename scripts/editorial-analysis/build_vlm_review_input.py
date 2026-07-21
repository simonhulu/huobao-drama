#!/usr/bin/env python3
"""Build bounded, auditable inputs for the editorial VLM review runner."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
from collections import Counter
from collections.abc import Mapping
from pathlib import Path
from typing import Any


INPUT_SCHEMA_VERSION = "editorial-vlm-review-input-v2"
EXPECTED_FINE_EVIDENCE_PAIRS = 4
EXPECTED_TARGET_SEQUENCE_SAMPLES = 5
EXPECTED_TARGET_SEQUENCE_FRAME_STEP = 3
MAX_TARGETS_PER_REVIEW = 4
MAX_MACHINE_EVIDENCE_JSON_CHARACTERS = 64_000
MAX_REVIEW_UTF8_BYTES = 64 * 1024
MAX_JPEG_BYTES = 25 * 1024 * 1024
MAX_SUBTITLE_NEIGHBORS = 10
MAX_AUDIO_RADIUS_SECONDS = 5.0
_SAMPLE_REFERENCE_KEYS = (
    "sampleIndex",
    "requestedTimeSeconds",
    "decodedTimeSeconds",
    "frameIndex",
)
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SENSITIVE_KEY = re.compile(
    r"^(authorization|api[_-]?key|access[_-]?token|token|secret|password)$",
    re.IGNORECASE,
)


def _reject_non_standard_number(value: str) -> None:
    raise ValueError(f"JSON contains a non-finite number: {value}")


def _load_json_object(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=_reject_non_standard_number,
        )
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be a JSON object")
    return payload


def _load_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line, parse_constant=_reject_non_standard_number)
        except json.JSONDecodeError as error:
            raise ValueError(f"{label} line {line_number} is not valid JSON: {error}") from error
        if not isinstance(record, dict):
            raise ValueError(f"{label} line {line_number} must be a JSON object")
        records.append(record)
    return records


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number")
    return number


def _string_list(value: Any, label: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{label} must be an array of non-empty strings")
    if not allow_empty and not value:
        raise ValueError(f"{label} must not be empty")
    return list(value)


def _same_number(left: Any, right: Any) -> bool:
    return math.isclose(
        _finite_number(left, "time boundary"),
        _finite_number(right, "time boundary"),
        rel_tol=0.0,
        abs_tol=1e-9,
    )


def _validate_candidate_inputs(
    payload: Mapping[str, Any],
) -> tuple[str, str, dict[str, dict[str, Any]], list[dict[str, Any]]]:
    if payload.get("schemaVersion") != "candidate-events-v1":
        raise ValueError("unsupported candidate-events schemaVersion")
    source_id = payload.get("sourceId")
    if not isinstance(source_id, str) or not _SAFE_ID.fullmatch(source_id):
        raise ValueError("candidate-events sourceId is invalid")
    digest = payload.get("analysisDigest")
    if not isinstance(digest, str) or not digest:
        raise ValueError("candidate-events analysisDigest is invalid")

    raw_events = payload.get("events")
    if not isinstance(raw_events, list):
        raise ValueError("candidate-events events must be an array")
    events_by_id: dict[str, dict[str, Any]] = {}
    for index, event in enumerate(raw_events):
        if not isinstance(event, dict):
            raise ValueError(f"candidate-events event {index} must be an object")
        event_id = event.get("id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError(f"candidate-events event {index} has an invalid id")
        if event_id in events_by_id:
            raise ValueError(f"duplicate candidate id: {event_id}")
        time_seconds = _finite_number(event.get("timeSeconds"), f"candidate {event_id} timeSeconds")
        if time_seconds < 0:
            raise ValueError(f"candidate {event_id} timeSeconds must be non-negative")
        events_by_id[event_id] = event

    raw_windows = payload.get("reviewWindows")
    if not isinstance(raw_windows, list):
        raise ValueError("candidate-events reviewWindows must be an array")
    windows: list[dict[str, Any]] = []
    referenced_candidates: set[str] = set()
    previous_end: float | None = None
    for index, window in enumerate(raw_windows, start=1):
        if not isinstance(window, dict):
            raise ValueError(f"review window {index} must be an object")
        start_seconds = _finite_number(window.get("startSeconds"), f"review window {index} startSeconds")
        end_seconds = _finite_number(window.get("endSeconds"), f"review window {index} endSeconds")
        if start_seconds < 0 or end_seconds <= start_seconds:
            raise ValueError(f"review window {index} must have positive duration")
        if previous_end is not None and start_seconds <= previous_end:
            raise ValueError("review windows must be ordered and non-overlapping")
        candidate_ids = _string_list(
            window.get("candidateIds"),
            f"review window {index} candidateIds",
            allow_empty=False,
        )
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError(f"review window {index} contains duplicate candidate ids")
        for candidate_id in candidate_ids:
            candidate = events_by_id.get(candidate_id)
            if candidate is None:
                raise ValueError(f"review window {index} references unknown candidate {candidate_id}")
            if candidate_id in referenced_candidates:
                raise ValueError(f"candidate {candidate_id} is referenced by multiple review windows")
            candidate_time = _finite_number(
                candidate.get("timeSeconds"), f"candidate {candidate_id} timeSeconds"
            )
            if candidate_time < start_seconds or candidate_time > end_seconds:
                raise ValueError(f"candidate {candidate_id} falls outside review window {index}")
            referenced_candidates.add(candidate_id)
        windows.append(
            {
                "id": f"review-window-{index:06d}",
                "startSeconds": start_seconds,
                "endSeconds": end_seconds,
                "candidateIds": candidate_ids,
            }
        )
        previous_end = end_seconds
    return source_id, digest, events_by_id, windows


def _verify_input_artifact(record: Mapping[str, Any], label: str) -> Path:
    raw_path = record.get("path")
    expected_bytes = record.get("bytes")
    expected_sha256 = record.get("sha256")
    if not isinstance(raw_path, str) or not raw_path:
        raise ValueError(f"{label} path is invalid")
    if isinstance(expected_bytes, bool) or not isinstance(expected_bytes, int):
        raise ValueError(f"{label} bytes is invalid")
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError(f"{label} sha256 is invalid")
    path = Path(raw_path).resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size != expected_bytes:
        raise ValueError(f"{label} byte count does not match")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha256:
        raise ValueError(f"{label} sha256 does not match")
    return path


def _review_units_from_assets(
    assets_payload: Mapping[str, Any],
    *,
    source_id: str,
    digest: str,
    events_by_id: Mapping[str, Mapping[str, Any]],
    legacy_windows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str]:
    inputs = assets_payload.get("inputs")
    if not isinstance(inputs, Mapping):
        raise ValueError("review-assets manifest must reference a review-unit plan")
    plan_record = inputs.get("reviewUnitPlan")
    if plan_record is None:
        raise ValueError("review-assets manifest must reference a review-unit plan")
    if not isinstance(plan_record, Mapping):
        raise ValueError("review-assets reviewUnitPlan input record is invalid")
    plan_path = _verify_input_artifact(plan_record, "review-unit plan")
    plan = _load_json_object(plan_path, "review-unit plan")
    if plan.get("schemaVersion") != "review-unit-plan-v1":
        raise ValueError("unsupported review-unit plan schemaVersion")
    if plan.get("sourceId") != source_id:
        raise ValueError("review-unit plan sourceId does not match candidate-events")
    if plan.get("analysisDigest") != digest:
        raise ValueError("review-unit plan analysisDigest does not match candidate-events")
    configuration = plan.get("configuration")
    units = plan.get("units")
    if not isinstance(configuration, dict) or not isinstance(units, list) or not units:
        raise ValueError("review-unit plan configuration or units are invalid")
    expected_digest = hashlib.sha256(
        json.dumps(
            {
                "sourceId": source_id,
                "analysisDigest": digest,
                "configuration": configuration,
                "units": units,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    if plan.get("planDigest") != expected_digest:
        raise ValueError("review-unit plan digest does not match its contents")

    parent_ids = {window["id"] for window in legacy_windows}
    references: Counter[str] = Counter()
    normalized: list[dict[str, Any]] = []
    seen_unit_ids: set[str] = set()
    for index, unit in enumerate(units, start=1):
        if not isinstance(unit, dict):
            raise ValueError(f"review unit {index} must be an object")
        unit_id = unit.get("id")
        if not isinstance(unit_id, str) or not unit_id or unit_id in seen_unit_ids:
            raise ValueError(f"review unit {index} has an invalid or duplicate id")
        seen_unit_ids.add(unit_id)
        parent_id = unit.get("parentReviewWindowId")
        if parent_id not in parent_ids:
            raise ValueError(f"review unit {unit_id} has an unknown parent window")
        start_seconds = _finite_number(
            unit.get("startSeconds"), f"review unit {unit_id} startSeconds"
        )
        end_seconds = _finite_number(
            unit.get("endSeconds"), f"review unit {unit_id} endSeconds"
        )
        if start_seconds < 0 or end_seconds <= start_seconds:
            raise ValueError(f"review unit {unit_id} has invalid boundaries")
        candidate_ids = _string_list(
            unit.get("candidateIds"),
            f"review unit {unit_id} candidateIds",
            allow_empty=False,
        )
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError(f"review unit {unit_id} contains duplicate candidate ids")
        unknown = sorted(set(candidate_ids) - events_by_id.keys())
        if unknown:
            raise ValueError(f"review unit {unit_id} references unknown candidate {unknown[0]}")
        references.update(candidate_ids)
        samples = unit.get("samples")
        if not isinstance(samples, list) or len(samples) != 5:
            raise ValueError(f"review unit {unit_id} must contain exactly five samples")
        sample_times: list[float] = []
        sample_frames: list[int] = []
        normalized_samples = []
        for sample_index, sample in enumerate(samples):
            if not isinstance(sample, dict) or sample.get("index") != sample_index:
                raise ValueError(f"review unit {unit_id} sample indices must be 0..4")
            time_seconds = _finite_number(
                sample.get("timeSeconds"),
                f"review unit {unit_id} sample {sample_index} timeSeconds",
            )
            frame_index = sample.get("frameIndex")
            if isinstance(frame_index, bool) or not isinstance(frame_index, int) or frame_index < 0:
                raise ValueError(f"review unit {unit_id} sample frameIndex is invalid")
            sample_times.append(time_seconds)
            sample_frames.append(frame_index)
            normalized_samples.append(
                {"index": sample_index, "timeSeconds": time_seconds, "frameIndex": frame_index}
            )
        if any(current <= previous for previous, current in zip(sample_times, sample_times[1:])):
            raise ValueError(f"review unit {unit_id} sample times are not increasing")
        if any(current <= previous for previous, current in zip(sample_frames, sample_frames[1:])):
            raise ValueError(f"review unit {unit_id} frame indices are not increasing")
        if not _same_number(sample_times[0], start_seconds) or not _same_number(
            sample_times[-1], end_seconds
        ):
            raise ValueError(f"review unit {unit_id} boundaries do not match its samples")
        observation_targets = unit.get("observationTargets")
        if (
            not isinstance(observation_targets, list)
            or not 1 <= len(observation_targets) <= MAX_TARGETS_PER_REVIEW
        ):
            raise ValueError(f"review unit {unit_id} observationTargets are invalid")
        normalized_targets: list[dict[str, Any]] = []
        seen_target_ids: set[str] = set()
        seen_intervals: set[int] = set()
        for target_index, target in enumerate(observation_targets):
            if not isinstance(target, dict):
                raise ValueError(f"review unit {unit_id} target {target_index} must be an object")
            target_id = target.get("id")
            if (
                not isinstance(target_id, str)
                or not _SAFE_ID.fullmatch(target_id)
                or target_id in seen_target_ids
            ):
                raise ValueError(f"review unit {unit_id} has an invalid or duplicate target id")
            seen_target_ids.add(target_id)
            target_candidate_ids = _string_list(
                target.get("candidateIds"),
                f"review unit {unit_id} target {target_id} candidateIds",
                allow_empty=False,
            )
            if len(target_candidate_ids) != len(set(target_candidate_ids)):
                raise ValueError(f"review unit {unit_id} target {target_id} has duplicate candidates")
            candidate_times = target.get("candidateTimesSeconds")
            if (
                not isinstance(candidate_times, list)
                or len(candidate_times) != len(target_candidate_ids)
            ):
                raise ValueError(
                    f"review unit {unit_id} target {target_id} candidateTimesSeconds do not match"
                )
            normalized_candidate_times = [
                _finite_number(
                    value,
                    f"review unit {unit_id} target {target_id} candidateTimesSeconds",
                )
                for value in candidate_times
            ]
            if any(value < 0 for value in normalized_candidate_times):
                raise ValueError(
                    f"review unit {unit_id} target {target_id} candidateTimesSeconds are invalid"
                )
            for candidate_id, candidate_time in zip(
                target_candidate_ids, normalized_candidate_times
            ):
                candidate = events_by_id.get(candidate_id)
                if candidate is None or not math.isclose(
                    candidate_time,
                    _finite_number(
                        candidate.get("timeSeconds") if candidate is not None else None,
                        f"candidate {candidate_id} timeSeconds",
                    ),
                    rel_tol=0.0,
                    abs_tol=1e-9,
                ):
                    raise ValueError(
                        f"review unit {unit_id} target {target_id} candidate provenance does not match"
                    )
            interval_index = target.get("intervalIndex")
            previous_sample_index = target.get("previousSampleIndex")
            current_sample_index = target.get("currentSampleIndex")
            if (
                isinstance(interval_index, bool)
                or not isinstance(interval_index, int)
                or interval_index not in range(4)
                or interval_index in seen_intervals
                or previous_sample_index != interval_index
                or current_sample_index != interval_index + 1
            ):
                raise ValueError(f"review unit {unit_id} target {target_id} interval is invalid")
            seen_intervals.add(interval_index)
            anchor_frame_index = target.get("anchorFrameIndex")
            if (
                isinstance(anchor_frame_index, bool)
                or not isinstance(anchor_frame_index, int)
                or anchor_frame_index != sample_frames[current_sample_index]
            ):
                raise ValueError(
                    f"review unit {unit_id} target {target_id} anchor frame does not match its interval"
                )
            anchor_time_seconds = _finite_number(
                target.get("anchorTimeSeconds"),
                f"review unit {unit_id} target {target_id} anchorTimeSeconds",
            )
            if not math.isclose(
                anchor_time_seconds,
                sample_times[current_sample_index],
                rel_tol=0.0,
                abs_tol=1e-9,
            ):
                raise ValueError(
                    f"review unit {unit_id} target {target_id} anchor time does not match its interval"
                )
            separability = target.get("separability")
            if separability not in {"independent", "coincident_same_decoded_frame"}:
                raise ValueError(
                    f"review unit {unit_id} target {target_id} separability is invalid"
                )
            normalized_targets.append(
                {
                    "id": target_id,
                    "anchorFrameIndex": anchor_frame_index,
                    "anchorTimeSeconds": anchor_time_seconds,
                    "candidateIds": target_candidate_ids,
                    "candidateTimesSeconds": normalized_candidate_times,
                    "intervalIndex": interval_index,
                    "previousSampleIndex": previous_sample_index,
                    "currentSampleIndex": current_sample_index,
                    "separability": separability,
                }
            )
        if [target["intervalIndex"] for target in normalized_targets] != sorted(seen_intervals):
            raise ValueError(f"review unit {unit_id} targets must be ordered by interval")
        target_candidate_ids = [
            str(candidate_id)
            for target in normalized_targets
            for candidate_id in target.get("candidateIds", [])
        ]
        if Counter(target_candidate_ids) != Counter(candidate_ids):
            raise ValueError(f"review unit {unit_id} targets do not cover its candidates")
        normalized.append(
            {
                "id": unit_id,
                "parentReviewWindowId": parent_id,
                "startSeconds": start_seconds,
                "endSeconds": end_seconds,
                "candidateIds": candidate_ids,
                "samples": normalized_samples,
                "observationTargets": normalized_targets,
            }
        )
    expected_references = Counter(events_by_id.keys())
    if references != expected_references:
        raise ValueError("review-unit plan must reference every candidate exactly once")
    return normalized, str(plan["planDigest"])


def _validate_subtitles(payload: Mapping[str, Any], source_id: str) -> list[dict[str, Any]]:
    if payload.get("schemaVersion") != "normalized-subtitles-v1":
        raise ValueError("unsupported subtitles schemaVersion")
    if payload.get("sourceId") != source_id:
        raise ValueError("subtitles sourceId does not match candidate-events")
    raw_cues = payload.get("cues")
    if not isinstance(raw_cues, list):
        raise ValueError("subtitles cues must be an array")
    cues: list[dict[str, Any]] = []
    for index, cue in enumerate(raw_cues):
        if not isinstance(cue, dict):
            raise ValueError(f"subtitle cue {index} must be an object")
        start_seconds = _finite_number(cue.get("startSeconds"), f"subtitle cue {index} startSeconds")
        end_seconds = _finite_number(cue.get("endSeconds"), f"subtitle cue {index} endSeconds")
        text = cue.get("text")
        if start_seconds < 0 or end_seconds <= start_seconds:
            raise ValueError(f"subtitle cue {index} timing is invalid")
        if not isinstance(text, str) or _javascript_string_length(text) > 4000:
            raise ValueError(f"subtitle cue {index} text is invalid")
        cues.append(
            {
                "startSeconds": start_seconds,
                "endSeconds": end_seconds,
                "text": text,
                "_order": index,
            }
        )
    cues.sort(key=lambda cue: (cue["startSeconds"], cue["endSeconds"], cue["_order"]))
    return cues


def _select_subtitles(
    cues: list[dict[str, Any]],
    *,
    start_seconds: float,
    end_seconds: float,
    neighbors: int,
) -> list[dict[str, Any]]:
    overlapping = [
        index
        for index, cue in enumerate(cues)
        if cue["endSeconds"] > start_seconds and cue["startSeconds"] < end_seconds
    ]
    if overlapping:
        first = max(0, overlapping[0] - neighbors)
        last = min(len(cues), overlapping[-1] + neighbors + 1)
        selected = cues[first:last]
    else:
        before = [cue for cue in cues if cue["endSeconds"] <= start_seconds]
        after = [cue for cue in cues if cue["startSeconds"] >= end_seconds]
        previous_neighbors = before[-neighbors:] if neighbors else []
        selected = [*previous_neighbors, *after[:neighbors]]

    normalized: list[dict[str, Any]] = []
    seen: set[tuple[float, float, str]] = set()
    for cue in selected:
        key = (cue["startSeconds"], cue["endSeconds"], cue["text"])
        if key in seen:
            continue
        seen.add(key)
        normalized.append({key: cue[key] for key in ("startSeconds", "endSeconds", "text")})
    if len(normalized) > 100:
        raise ValueError("adjacentSubtitles exceeds 100 entries")
    return normalized


def _compact_event(event: Mapping[str, Any], *, candidate_id: str | None = None) -> dict[str, Any]:
    compact: dict[str, Any] = {}
    if candidate_id is not None:
        compact["candidateId"] = candidate_id
    for key in (
        "timeSeconds",
        "startTimeSeconds",
        "endTimeSeconds",
        "frameIndex",
        "family",
        "detector",
        "score",
        "tier",
        "adaptiveThreshold",
        "measurements",
    ):
        if key in event:
            compact[key] = event[key]
    return compact


def _compact_visual_evidence(
    event: Mapping[str, Any], *, candidate_id: str, evidence_index: int
) -> dict[str, Any]:
    compact: dict[str, Any] = {
        "candidateId": candidate_id,
        "evidenceIndex": evidence_index,
    }
    for key in (
        "timeSeconds",
        "startTimeSeconds",
        "endTimeSeconds",
        "frameIndex",
        "detector",
        "score",
        "adaptiveThreshold",
        "measurements",
    ):
        if key in event:
            compact[key] = event[key]
    return compact


def _candidate_and_visual_evidence(
    candidate_ids: list[str], events_by_id: Mapping[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    candidates: list[dict[str, Any]] = []
    visual: list[dict[str, Any]] = []
    for candidate_id in candidate_ids:
        candidate = events_by_id[candidate_id]
        score = _finite_number(candidate.get("score"), f"candidate {candidate_id} score")
        detectors = _string_list(
            candidate.get("detectors"),
            f"candidate {candidate_id} detectors",
            allow_empty=False,
        )
        summary = {
            "id": candidate_id,
            "timeSeconds": _finite_number(
                candidate.get("timeSeconds"), f"candidate {candidate_id} timeSeconds"
            ),
            "score": score,
            "detectors": detectors,
        }
        candidates.append(summary)
        raw_evidence = candidate.get("evidence")
        if not isinstance(raw_evidence, list):
            raise ValueError(f"candidate {candidate_id} evidence must be an array")
        for evidence_index, evidence in enumerate(raw_evidence):
            if not isinstance(evidence, dict):
                raise ValueError(f"candidate {candidate_id} evidence {evidence_index} must be an object")
            detector = evidence.get("detector")
            if not isinstance(detector, str) or not detector:
                raise ValueError(f"candidate {candidate_id} evidence {evidence_index} detector is invalid")
            if detector == "stereo_side_onset":
                continue
            visual.append(
                _compact_visual_evidence(
                    evidence,
                    candidate_id=candidate_id,
                    evidence_index=evidence_index,
                )
            )
    visual.sort(
        key=lambda item: (
            float(item.get("timeSeconds", events_by_id[item["candidateId"]]["timeSeconds"])),
            str(item.get("detector", "")),
            item["candidateId"],
            item["evidenceIndex"],
        )
    )
    return candidates, visual


def _validate_audio_events(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw_events = payload.get("events")
    if not isinstance(raw_events, list):
        raise ValueError("audio-evidence events must be an array")
    events: list[dict[str, Any]] = []
    for index, event in enumerate(raw_events):
        if not isinstance(event, dict):
            raise ValueError(f"audio-evidence event {index} must be an object")
        time_seconds = _finite_number(event.get("timeSeconds"), f"audio-evidence event {index} timeSeconds")
        if time_seconds < 0:
            raise ValueError(f"audio-evidence event {index} timeSeconds must be non-negative")
        detector = event.get("detector")
        if not isinstance(detector, str) or not detector:
            raise ValueError(f"audio-evidence event {index} detector is invalid")
        events.append(event)
    return events


def _select_audio(
    events: list[dict[str, Any]],
    *,
    start_seconds: float,
    end_seconds: float,
    radius_seconds: float,
) -> list[dict[str, Any]]:
    minimum = max(0.0, start_seconds - radius_seconds)
    maximum = end_seconds + radius_seconds
    selected = [
        _compact_event(event)
        for event in events
        if event["detector"] == "stereo_side_onset"
        and minimum <= float(event["timeSeconds"]) <= maximum
    ]
    selected.sort(key=lambda event: (float(event["timeSeconds"]), str(event["detector"])))
    return selected


def _resolve_frame_artifact(
    sample: Mapping[str, Any],
    *,
    assets_directory: Path,
    review_id: str,
    sample_index: int,
    seen_paths: set[Path],
) -> Path:
    if any(key not in sample for key in ("path", "bytes", "sha256")):
        raise ValueError(
            f"review strip {review_id} sample {sample_index} frame artifact fields are incomplete"
        )
    raw_path = sample["path"]
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError(f"review frame {review_id}/{sample_index} path is invalid")
    path = Path(raw_path)
    if not path.is_absolute():
        path = assets_directory / path
    path = path.resolve()
    if not path.is_relative_to(assets_directory.resolve()):
        raise ValueError(
            f"review frame {review_id}/{sample_index} is outside review-assets directory"
        )
    if path in seen_paths:
        raise ValueError(f"duplicate review frame path: {path}")
    seen_paths.add(path)
    if path.suffix.lower() not in {".jpg", ".jpeg"}:
        raise ValueError(f"review frame {review_id}/{sample_index} must be a JPEG")
    if not path.is_file():
        raise FileNotFoundError(path)
    expected_bytes = sample["bytes"]
    if (
        isinstance(expected_bytes, bool)
        or not isinstance(expected_bytes, int)
        or expected_bytes <= 0
    ):
        raise ValueError(f"review frame {review_id}/{sample_index} bytes is invalid")
    size = path.stat().st_size
    if size != expected_bytes:
        raise ValueError(
            f"review frame {review_id}/{sample_index} frame byte count does not match"
        )
    if size <= 0 or size > MAX_JPEG_BYTES:
        raise ValueError(f"review frame {review_id}/{sample_index} JPEG size is invalid")
    expected_sha256 = sample["sha256"]
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError(f"review frame {review_id}/{sample_index} sha256 is invalid")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        signature = handle.read(4)
        if len(signature) < 4 or signature[:3] != b"\xff\xd8\xff":
            raise ValueError(f"review frame {review_id}/{sample_index} JPEG signature is invalid")
        digest.update(signature)
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != expected_sha256:
        raise ValueError(f"review frame {review_id}/{sample_index} frame sha256 does not match")
    return path


def _validate_review_assets(
    payload: Mapping[str, Any],
    *,
    source_id: str,
    digest: str,
    windows: list[dict[str, Any]],
    assets_directory: Path,
) -> tuple[
    dict[str, list[Path]],
    dict[str, list[dict[str, Any]]],
    dict[str, list[dict[str, Any]]],
]:
    if payload.get("schemaVersion") != "review-assets-manifest-v2":
        raise ValueError("unsupported review-assets schemaVersion")
    if payload.get("status") != "complete":
        raise ValueError("review-assets manifest status must be complete")
    if payload.get("sourceId") != source_id:
        raise ValueError("review-assets sourceId does not match candidate-events")
    if payload.get("analysisDigest") != digest:
        raise ValueError("review-assets analysisDigest does not match candidate-events")
    configuration = payload.get("configuration", {})
    if not isinstance(configuration, dict):
        raise ValueError("review-assets configuration must be an object")
    if configuration.get("reviewSamplesPerWindow", 5) != 5:
        raise ValueError("review-assets must contain five samples per review window")
    if configuration.get("targetSequenceSamples") != EXPECTED_TARGET_SEQUENCE_SAMPLES:
        raise ValueError("review-assets must contain five samples per target sequence")
    if configuration.get("targetSequenceFrameStep") != EXPECTED_TARGET_SEQUENCE_FRAME_STEP:
        raise ValueError("review-assets target sequence frame step must be 3")
    counts = payload.get("counts")
    if not isinstance(counts, dict):
        raise ValueError("review-assets counts must be an object")
    expected_frame_count = len(windows) * 5
    review_frame_count = counts.get("reviewFrames")
    if (
        isinstance(review_frame_count, bool)
        or not isinstance(review_frame_count, int)
        or review_frame_count != expected_frame_count
    ):
        raise ValueError(
            f"review-assets reviewFrames count must be {expected_frame_count}"
        )
    expected_target_count = sum(len(window["observationTargets"]) for window in windows)
    expected_target_frame_count = expected_target_count * EXPECTED_TARGET_SEQUENCE_SAMPLES
    for count_key, expected_count in (
        ("targetSequences", expected_target_count),
        ("targetSequenceSamples", expected_target_frame_count),
        ("targetFrames", expected_target_frame_count),
    ):
        value = counts.get(count_key)
        if isinstance(value, bool) or not isinstance(value, int) or value != expected_count:
            raise ValueError(f"review-assets {count_key} count must be {expected_count}")
    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, dict):
        raise ValueError("review-assets artifacts must be an object")
    raw_strips = artifacts.get("reviewStrips")
    if not isinstance(raw_strips, list):
        raise ValueError("review-assets reviewStrips must be an array")
    raw_target_sequences = artifacts.get("targetSequences")
    if not isinstance(raw_target_sequences, list):
        raise ValueError("review-assets targetSequences must be an array")

    strips_by_id: dict[str, dict[str, Any]] = {}
    for index, strip in enumerate(raw_strips):
        if not isinstance(strip, dict):
            raise ValueError(f"review strip {index} must be an object")
        review_id = strip.get("reviewWindowId")
        if not isinstance(review_id, str) or not review_id:
            raise ValueError(f"review strip {index} has an invalid reviewWindowId")
        if review_id in strips_by_id:
            raise ValueError(f"duplicate review strip for {review_id}")
        strips_by_id[review_id] = strip

    expected_ids = {window["id"] for window in windows}
    for review_id in sorted(expected_ids - strips_by_id.keys()):
        raise ValueError(f"missing review strip for {review_id}")
    unexpected_ids = sorted(strips_by_id.keys() - expected_ids)
    if unexpected_ids:
        raise ValueError(f"review strip references unknown window {unexpected_ids[0]}")

    expected_sequence_keys = [
        (window["id"], target["id"])
        for window in windows
        for target in window["observationTargets"]
    ]
    actual_sequence_keys: list[tuple[str, str]] = []
    sequences_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for sequence_index, sequence in enumerate(raw_target_sequences):
        if not isinstance(sequence, dict):
            raise ValueError(f"target sequence {sequence_index} must be an object")
        review_id = sequence.get("reviewWindowId")
        target_id = sequence.get("targetId")
        if not isinstance(review_id, str) or not isinstance(target_id, str):
            raise ValueError(f"target sequence {sequence_index} has invalid ids")
        key = (review_id, target_id)
        if key in sequences_by_key:
            raise ValueError(f"duplicate target sequence for {review_id}/{target_id}")
        actual_sequence_keys.append(key)
        sequences_by_key[key] = sequence
    if actual_sequence_keys != expected_sequence_keys:
        raise ValueError("review-assets target sequence ids or order do not match review-unit plan")

    frame_paths: dict[str, list[Path]] = {}
    strip_samples: dict[str, list[dict[str, Any]]] = {}
    target_sequences: dict[str, list[dict[str, Any]]] = {}
    seen_frame_paths: set[Path] = set()
    for window in windows:
        review_id = window["id"]
        strip = strips_by_id[review_id]
        if not _same_number(strip.get("startSeconds"), window["startSeconds"]):
            raise ValueError(f"review strip {review_id} startSeconds does not match")
        if not _same_number(strip.get("endSeconds"), window["endSeconds"]):
            raise ValueError(f"review strip {review_id} endSeconds does not match")
        if strip.get("candidateIds") != window["candidateIds"]:
            raise ValueError(f"review strip {review_id} candidateIds do not match")
        samples = strip.get("samples")
        if (
            not isinstance(samples, list)
            or len(samples) != 5
            or any(not isinstance(sample, dict) for sample in samples)
        ):
            raise ValueError(f"review strip {review_id} must contain exactly five frame samples")
        for sample_index, sample in enumerate(samples):
            if any(key not in sample for key in _SAMPLE_REFERENCE_KEYS):
                raise ValueError(
                    f"review strip {review_id} sample reference fields are incomplete"
                )
            frame_index = sample["frameIndex"]
            if isinstance(frame_index, bool) or not isinstance(frame_index, int) or frame_index < 0:
                raise ValueError(f"review strip {review_id} frameIndex is invalid")
            for key in ("requestedTimeSeconds", "decodedTimeSeconds"):
                _finite_number(sample[key], f"review strip {review_id} sample {sample_index} {key}")
        if [sample.get("sampleIndex") for sample in samples] != list(range(5)):
            raise ValueError(f"review strip {review_id} sampleIndex must be 0..4")
        expected_requested_times = (
            [float(sample["timeSeconds"]) for sample in window["samples"]]
            if "samples" in window
            else [
                window["startSeconds"]
                + (window["endSeconds"] - window["startSeconds"]) * sample_index / 4
                for sample_index in range(5)
            ]
        )
        if any(
            not math.isclose(
                float(sample["requestedTimeSeconds"]),
                expected_requested_times[sample_index],
                rel_tol=0.0,
                abs_tol=1e-9,
            )
            for sample_index, sample in enumerate(samples)
        ):
            raise ValueError(f"review strip {review_id} requested sample times do not match window")
        if "samples" in window and [sample["frameIndex"] for sample in samples] != [
            sample["frameIndex"] for sample in window["samples"]
        ]:
            raise ValueError(f"review strip {review_id} frame indices do not match review-unit plan")
        frame_paths[review_id] = [
            _resolve_frame_artifact(
                sample,
                assets_directory=assets_directory,
                review_id=review_id,
                sample_index=sample_index,
                seen_paths=seen_frame_paths,
            )
            for sample_index, sample in enumerate(samples)
        ]
        strip_samples[review_id] = samples
        normalized_sequences: list[dict[str, Any]] = []
        for target in window["observationTargets"]:
            target_id = target["id"]
            sequence = sequences_by_key[(review_id, target_id)]
            if sequence.get("targetProvenance") != target:
                raise ValueError(
                    f"target sequence {review_id}/{target_id} provenance does not match"
                )
            target_samples = sequence.get("samples")
            if (
                not isinstance(target_samples, list)
                or len(target_samples) != EXPECTED_TARGET_SEQUENCE_SAMPLES
                or any(not isinstance(sample, dict) for sample in target_samples)
            ):
                raise ValueError(
                    f"target sequence {review_id}/{target_id} must contain exactly five samples"
                )
            if [sample.get("sampleIndex") for sample in target_samples] != list(
                range(EXPECTED_TARGET_SEQUENCE_SAMPLES)
            ):
                raise ValueError(
                    f"target sequence {review_id}/{target_id} sampleIndex must be 0..4"
                )
            target_frame_indices: list[int] = []
            normalized_target_samples: list[dict[str, Any]] = []
            for sample_index, sample in enumerate(target_samples):
                frame_index = sample.get("frameIndex")
                frame_offset = sample.get("frameOffset")
                if (
                    isinstance(frame_index, bool)
                    or not isinstance(frame_index, int)
                    or frame_index < 0
                    or isinstance(frame_offset, bool)
                    or not isinstance(frame_offset, int)
                    or frame_offset != frame_index - target["anchorFrameIndex"]
                ):
                    raise ValueError(
                        f"target sequence {review_id}/{target_id} sample {sample_index} frame provenance is invalid"
                    )
                requested_time = _finite_number(
                    sample.get("requestedTimeSeconds"),
                    f"target sequence {review_id}/{target_id} requestedTimeSeconds",
                )
                decoded_time = _finite_number(
                    sample.get("decodedTimeSeconds"),
                    f"target sequence {review_id}/{target_id} decodedTimeSeconds",
                )
                if requested_time < 0 or decoded_time < 0:
                    raise ValueError(
                        f"target sequence {review_id}/{target_id} sample time is invalid"
                    )
                target_frame_indices.append(frame_index)
                normalized_target_samples.append(
                    {
                        "index": sample_index,
                        "frameIndex": frame_index,
                        "timeSeconds": decoded_time,
                        "frameOffset": frame_offset,
                    }
                )
            if any(
                current - previous != EXPECTED_TARGET_SEQUENCE_FRAME_STEP
                for previous, current in zip(target_frame_indices, target_frame_indices[1:])
            ):
                raise ValueError(
                    f"target sequence {review_id}/{target_id} frames must increase by 3"
                )
            if target_frame_indices.count(target["anchorFrameIndex"]) != 1:
                raise ValueError(
                    f"target sequence {review_id}/{target_id} must contain its anchor frame"
                )
            sequence_paths = [
                _resolve_frame_artifact(
                    sample,
                    assets_directory=assets_directory,
                    review_id=f"{review_id}/{target_id}",
                    sample_index=sample_index,
                    seen_paths=seen_frame_paths,
                )
                for sample_index, sample in enumerate(target_samples)
            ]
            normalized_sequences.append(
                {
                    "targetId": target_id,
                    "imagePaths": sequence_paths,
                    "samples": normalized_target_samples,
                }
            )
        target_sequences[review_id] = normalized_sequences
    return frame_paths, strip_samples, target_sequences


def _same_sample_reference(left: Any, right: Any) -> bool:
    return isinstance(left, dict) and isinstance(right, dict) and all(
        left.get(key) == right.get(key) for key in _SAMPLE_REFERENCE_KEYS
    )


def _validate_fine_evidence(
    records: list[dict[str, Any]],
    *,
    source_id: str,
    digest: str,
    windows: list[dict[str, Any]],
    strip_samples: Mapping[str, list[dict[str, Any]]],
) -> dict[str, list[dict[str, Any]]]:
    expected = {window["id"]: window for window in windows}
    grouped: dict[str, list[dict[str, Any]]] = {review_id: [] for review_id in expected}
    for record_index, record in enumerate(records):
        record_id = record.get("id", f"record {record_index}")
        if record.get("schemaVersion") != "fine-evidence-v1":
            raise ValueError(f"fine-evidence {record_id} has an invalid schemaVersion")
        if record.get("sourceId") != source_id:
            raise ValueError(f"fine-evidence {record_id} sourceId does not match")
        if record.get("analysisDigest") != digest:
            raise ValueError(f"fine-evidence {record_id} analysisDigest does not match")
        review_id = record.get("reviewWindowId")
        if review_id not in expected:
            raise ValueError(f"fine-evidence {record_id} references unknown review window")
        if record.get("candidateIds") != expected[review_id]["candidateIds"]:
            raise ValueError(f"fine-evidence {record_id} candidateIds do not match")
        pair_index = record.get("pairIndex")
        if isinstance(pair_index, bool) or not isinstance(pair_index, int):
            raise ValueError(f"fine-evidence {record_id} pairIndex is invalid")
        if not isinstance(record.get("frameFeatures"), dict):
            raise ValueError(f"fine-evidence {record_id} frameFeatures must be an object")
        if not isinstance(record.get("cameraTransform"), dict):
            raise ValueError(f"fine-evidence {record_id} cameraTransform must be an object")
        grouped[review_id].append(record)

    compact_by_id: dict[str, list[dict[str, Any]]] = {}
    for review_id, window_records in grouped.items():
        if len(window_records) != EXPECTED_FINE_EVIDENCE_PAIRS:
            raise ValueError(
                f"review window {review_id} must contain exactly 4 fine-evidence pairs"
            )
        window_records.sort(key=lambda record: record["pairIndex"])
        if [record["pairIndex"] for record in window_records] != [1, 2, 3, 4]:
            raise ValueError(f"review window {review_id} fine-evidence pairIndex must be 1..4")
        samples = strip_samples[review_id]
        for pair_index, record in enumerate(window_records, start=1):
            if not _same_sample_reference(record.get("previousFrame"), samples[pair_index - 1]):
                raise ValueError(
                    f"review window {review_id} pair {pair_index} previousFrame "
                    "does not match review strip"
                )
            if not _same_sample_reference(record.get("currentFrame"), samples[pair_index]):
                raise ValueError(
                    f"review window {review_id} pair {pair_index} currentFrame "
                    "does not match review strip"
                )
        compact_by_id[review_id] = [
            {
                key: record[key]
                for key in (
                    "pairIndex",
                    "previousFrame",
                    "currentFrame",
                    "frameFeatures",
                    "cameraTransform",
                    "cameraFamilyCandidate",
                )
                if key in record
            }
            for record in window_records
        ]
    return compact_by_id


def _find_sensitive_key(value: Any, path: str = "$") -> str | None:
    if isinstance(value, list):
        for index, child in enumerate(value):
            found = _find_sensitive_key(child, f"{path}[{index}]")
            if found:
                return found
    elif isinstance(value, dict):
        for key, child in value.items():
            if _SENSITIVE_KEY.fullmatch(str(key)):
                return f"{path}.{key}"
            found = _find_sensitive_key(child, f"{path}.{key}")
            if found:
                return found
    return None


def _compact_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def _javascript_string_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _validate_review_size(review: Mapping[str, Any]) -> None:
    sensitive_path = _find_sensitive_key(
        {
            "adjacentSubtitles": review["adjacentSubtitles"],
            "machineEvidence": review["machineEvidence"],
        }
    )
    if sensitive_path:
        raise ValueError(f"review {review['id']} contains a forbidden credential-like field at {sensitive_path}")
    evidence_json = _compact_json(review["machineEvidence"])
    if _javascript_string_length(evidence_json) > MAX_MACHINE_EVIDENCE_JSON_CHARACTERS:
        raise ValueError(f"review {review['id']} machineEvidence exceeds 64000 JSON characters")
    if len(_compact_json(review).encode("utf-8")) >= MAX_REVIEW_UTF8_BYTES:
        raise ValueError(f"review {review['id']} exceeds the 64 KiB UTF-8 limit")


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                allow_nan=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def build_vlm_review_input(
    *,
    analysis_directory: Path,
    output_path: Path,
    review_assets_directory: Path | None = None,
    subtitle_neighbors: int = 1,
    audio_radius_seconds: float = 0.5,
) -> dict[str, Any]:
    """Validate local evidence and atomically build the VLM review input JSON."""

    analysis_directory = Path(analysis_directory).resolve()
    output_path = Path(output_path).resolve()
    assets_directory = (
        Path(review_assets_directory).resolve()
        if review_assets_directory is not None
        else analysis_directory / "review-assets"
    )
    if isinstance(subtitle_neighbors, bool) or not isinstance(subtitle_neighbors, int):
        raise ValueError("subtitle_neighbors must be an integer")
    if not 0 <= subtitle_neighbors <= MAX_SUBTITLE_NEIGHBORS:
        raise ValueError(f"subtitle_neighbors must be between 0 and {MAX_SUBTITLE_NEIGHBORS}")
    radius = _finite_number(audio_radius_seconds, "audio_radius_seconds")
    if not 0 <= radius <= MAX_AUDIO_RADIUS_SECONDS:
        raise ValueError(f"audio_radius_seconds must be between 0 and {MAX_AUDIO_RADIUS_SECONDS}")

    candidate_payload = _load_json_object(
        analysis_directory / "candidate-events.json", "candidate-events"
    )
    source_id, digest, events_by_id, legacy_windows = _validate_candidate_inputs(candidate_payload)
    subtitle_payload = _load_json_object(analysis_directory / "subtitles.json", "subtitles")
    cues = _validate_subtitles(subtitle_payload, source_id)
    audio_payload = _load_json_object(
        analysis_directory / "audio-evidence.json", "audio-evidence"
    )
    audio_events = _validate_audio_events(audio_payload)
    assets_payload = _load_json_object(
        assets_directory / "review-assets-manifest.json", "review-assets manifest"
    )
    windows, review_plan_digest = _review_units_from_assets(
        assets_payload,
        source_id=source_id,
        digest=digest,
        events_by_id=events_by_id,
        legacy_windows=legacy_windows,
    )
    frame_paths, strip_samples, target_sequences = _validate_review_assets(
        assets_payload,
        source_id=source_id,
        digest=digest,
        windows=windows,
        assets_directory=assets_directory,
    )
    if review_plan_digest is None:
        raise ValueError("review-unit plan digest is required for VLM input v2")
    fine_records = _load_jsonl(assets_directory / "fine-evidence.jsonl", "fine-evidence")
    fine_by_id = _validate_fine_evidence(
        fine_records,
        source_id=source_id,
        digest=digest,
        windows=windows,
        strip_samples=strip_samples,
    )

    reviews: list[dict[str, Any]] = []
    for window in windows:
        review_id = window["id"]
        candidates, visual = _candidate_and_visual_evidence(window["candidateIds"], events_by_id)
        relative_frame_paths = [
            Path(os.path.relpath(frame_path, start=output_path.parent)).as_posix()
            for frame_path in frame_paths[review_id]
        ]
        target_sequence_by_id = {
            sequence["targetId"]: sequence for sequence in target_sequences[review_id]
        }
        targets: list[dict[str, Any]] = []
        for target in window["observationTargets"]:
            interval_index = target["intervalIndex"]
            sequence = target_sequence_by_id[target["id"]]
            targets.append(
                {
                    "targetRef": {
                        key: target[key]
                        for key in (
                            "id",
                            "anchorFrameIndex",
                            "anchorTimeSeconds",
                            "candidateIds",
                            "candidateTimesSeconds",
                            "separability",
                        )
                    },
                    "intervalRef": {
                        "intervalIndex": interval_index,
                        "previousSample": window["samples"][interval_index],
                        "currentSample": window["samples"][interval_index + 1],
                    },
                    "microSequence": {
                        "imagePaths": [
                            Path(os.path.relpath(frame_path, start=output_path.parent)).as_posix()
                            for frame_path in sequence["imagePaths"]
                        ],
                        "samples": sequence["samples"],
                    },
                }
            )
        review = {
            "id": review_id,
            "window": {
                "startSeconds": window["startSeconds"],
                "endSeconds": window["endSeconds"],
            },
            "overview": {
                "imagePaths": relative_frame_paths,
                "samples": window["samples"],
            },
            "targets": targets,
            "adjacentSubtitles": _select_subtitles(
                cues,
                start_seconds=window["startSeconds"],
                end_seconds=window["endSeconds"],
                neighbors=subtitle_neighbors,
            ),
            "machineEvidence": {
                "candidateIds": window["candidateIds"],
                "candidates": candidates,
                "visual": visual,
                "audio": _select_audio(
                    audio_events,
                    start_seconds=window["startSeconds"],
                    end_seconds=window["endSeconds"],
                    radius_seconds=radius,
                ),
                "fineEvidence": fine_by_id[review_id],
            },
        }
        _validate_review_size(review)
        reviews.append(review)

    payload = {
        "schemaVersion": INPUT_SCHEMA_VERSION,
        "sourceId": source_id,
        "reviewPlanDigest": review_plan_digest,
        "reviews": reviews,
    }
    _atomic_write_json(output_path, payload)
    return payload


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build bounded, auditable input for scripts/editorial-analysis/vlm_review.mjs."
    )
    parser.add_argument("--analysis-directory", required=True, type=Path)
    parser.add_argument("--review-assets-directory", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--subtitle-neighbors", type=int, default=1)
    parser.add_argument("--audio-radius-seconds", type=float, default=0.5)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_argument_parser().parse_args(argv)
    payload = build_vlm_review_input(
        analysis_directory=arguments.analysis_directory,
        review_assets_directory=arguments.review_assets_directory,
        output_path=arguments.output,
        subtitle_neighbors=arguments.subtitle_neighbors,
        audio_radius_seconds=arguments.audio_radius_seconds,
    )
    print(
        json.dumps(
            {
                "output": str(arguments.output.resolve()),
                "sourceId": payload["sourceId"],
                "reviews": len(payload["reviews"]),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
