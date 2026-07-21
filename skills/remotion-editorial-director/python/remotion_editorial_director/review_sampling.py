#!/usr/bin/env python3
"""Plan and audit five-frame editorial review units.

Candidate events are retrieval hints, not confirmed edits. Closely timed hints
that cannot be separated at the source frame rate are kept together as one
co-temporal cluster. Every separable cluster must be bracketed by its own pair
of adjacent review frames.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


PLAN_SCHEMA_VERSION = "review-unit-plan-v1"
AUDIT_SCHEMA_VERSION = "review-sampling-adequacy-v1"
SAMPLES_PER_REVIEW_UNIT = 5
MAXIMUM_CLUSTERS_PER_UNIT = SAMPLES_PER_REVIEW_UNIT - 1
DEFAULT_CONTEXT_SECONDS = 0.5
DEFAULT_MAXIMUM_TARGET_SPAN_SECONDS = 2.0


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number")
    return number


def _canonical_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _source_timing(source: Mapping[str, Any]) -> dict[str, Any]:
    video = source.get("video")
    if not isinstance(video, Mapping):
        raise ValueError("source video metadata is missing")
    fps_record = video.get("fps")
    if not isinstance(fps_record, Mapping):
        raise ValueError("source FPS metadata is missing")
    numerator = int(fps_record.get("numerator", 0))
    denominator = int(fps_record.get("denominator", 0))
    if numerator <= 0 or denominator <= 0:
        raise ValueError("source FPS must be positive")
    fps = numerator / denominator
    start_seconds = _finite_number(video.get("start", 0.0), "source start")
    duration_seconds = _finite_number(
        video.get("duration", source.get("formatDurationSeconds")),
        "source duration",
    )
    explicit_count = video.get("frameCount", video.get("nbFrames"))
    frame_count = (
        int(explicit_count)
        if explicit_count is not None
        else int(math.ceil(duration_seconds * fps - 1e-9))
    )
    if frame_count <= 0:
        raise ValueError("source resolves to zero frames")
    return {
        "fpsNumerator": numerator,
        "fpsDenominator": denominator,
        "fps": fps,
        "startSeconds": start_seconds,
        "durationSeconds": duration_seconds,
        "frameCount": frame_count,
        "lastFrameIndex": frame_count - 1,
    }


def _time_to_frame(time_seconds: float, timing: Mapping[str, Any]) -> int:
    relative = max(0.0, time_seconds - float(timing["startSeconds"]))
    return min(
        int(timing["lastFrameIndex"]),
        max(0, int(math.floor(relative * float(timing["fps"]) + 0.5))),
    )


def _frame_to_time(frame_index: int, timing: Mapping[str, Any]) -> float:
    return round(
        float(timing["startSeconds"]) + frame_index / float(timing["fps"]),
        9,
    )


def _validate_candidate_payload(
    payload: Mapping[str, Any], source_id: str
) -> tuple[str, dict[str, dict[str, Any]], list[dict[str, Any]]]:
    if payload.get("schemaVersion") != "candidate-events-v1":
        raise ValueError("unsupported candidate-events schema")
    if payload.get("sourceId") != source_id:
        raise ValueError("candidate-events source does not match the requested source")
    analysis_digest = payload.get("analysisDigest")
    if not isinstance(analysis_digest, str) or not analysis_digest:
        raise ValueError("candidate-events analysisDigest is invalid")

    raw_events = payload.get("events")
    if not isinstance(raw_events, list):
        raise ValueError("candidate-events events must be an array")
    events_by_id: dict[str, dict[str, Any]] = {}
    for index, event in enumerate(raw_events):
        if not isinstance(event, dict):
            raise ValueError(f"candidate event {index} must be an object")
        candidate_id = event.get("id")
        if not isinstance(candidate_id, str) or not candidate_id:
            raise ValueError(f"candidate event {index} has an invalid id")
        if candidate_id in events_by_id:
            raise ValueError(f"duplicate candidate id: {candidate_id}")
        time_seconds = _finite_number(
            event.get("timeSeconds"), f"candidate {candidate_id} timeSeconds"
        )
        if time_seconds < 0:
            raise ValueError(f"candidate {candidate_id} timeSeconds must be non-negative")
        events_by_id[candidate_id] = event

    raw_windows = payload.get("reviewWindows")
    if not isinstance(raw_windows, list):
        raise ValueError("candidate-events reviewWindows must be an array")
    windows: list[dict[str, Any]] = []
    references: Counter[str] = Counter()
    for index, window in enumerate(raw_windows, start=1):
        if not isinstance(window, dict):
            raise ValueError(f"review window {index} must be an object")
        candidate_ids = window.get("candidateIds")
        if (
            not isinstance(candidate_ids, list)
            or not candidate_ids
            or any(not isinstance(value, str) or not value for value in candidate_ids)
        ):
            raise ValueError(f"review window {index} candidateIds are invalid")
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError(f"review window {index} contains duplicate candidate ids")
        start_seconds = _finite_number(
            window.get("startSeconds"), f"review window {index} startSeconds"
        )
        end_seconds = _finite_number(
            window.get("endSeconds"), f"review window {index} endSeconds"
        )
        if start_seconds < 0 or end_seconds <= start_seconds:
            raise ValueError(f"review window {index} has invalid boundaries")
        for candidate_id in candidate_ids:
            event = events_by_id.get(candidate_id)
            if event is None:
                raise ValueError(
                    f"review window {index} references unknown candidate {candidate_id}"
                )
            candidate_time = float(event["timeSeconds"])
            if not start_seconds <= candidate_time <= end_seconds:
                raise ValueError(
                    f"review window {index} does not contain candidate {candidate_id}"
                )
            references[candidate_id] += 1
        windows.append(
            {
                "id": f"review-window-{index:06d}",
                "startSeconds": start_seconds,
                "endSeconds": end_seconds,
                "candidateIds": list(candidate_ids),
            }
        )
    invalid_references = sorted(
        candidate_id
        for candidate_id in events_by_id
        if references[candidate_id] != 1
    )
    if invalid_references:
        raise ValueError(
            "every candidate must appear in exactly one review window: "
            + ", ".join(invalid_references[:10])
        )
    return analysis_digest, events_by_id, windows


def _build_observation_targets(
    candidate_ids: Sequence[str],
    events_by_id: Mapping[str, Mapping[str, Any]],
    timing: Mapping[str, Any],
) -> list[dict[str, Any]]:
    ordered = sorted(
        (
            {
                "candidateId": candidate_id,
                "timeSeconds": float(events_by_id[candidate_id]["timeSeconds"]),
                "frameIndex": _time_to_frame(
                    float(events_by_id[candidate_id]["timeSeconds"]), timing
                ),
            }
            for candidate_id in candidate_ids
        ),
        key=lambda item: (item["frameIndex"], item["timeSeconds"], item["candidateId"]),
    )
    targets: list[dict[str, Any]] = []
    for candidate in ordered:
        if not targets or int(candidate["frameIndex"]) != int(targets[-1]["anchorFrameIndex"]):
            targets.append(
                {
                    "candidateIds": [candidate["candidateId"]],
                    "candidateTimesSeconds": [candidate["timeSeconds"]],
                    "anchorFrameIndex": candidate["frameIndex"],
                }
            )
            continue
        target = targets[-1]
        target["candidateIds"].append(candidate["candidateId"])
        target["candidateTimesSeconds"].append(candidate["timeSeconds"])
    return targets


def _atomic_target_runs(
    targets: Sequence[Mapping[str, Any]],
) -> list[list[dict[str, Any]]]:
    runs: list[list[dict[str, Any]]] = []
    for target in targets:
        copied = dict(target)
        if (
            not runs
            or int(copied["anchorFrameIndex"])
            - int(runs[-1][-1]["anchorFrameIndex"])
            > 1
        ):
            runs.append([copied])
        else:
            runs[-1].append(copied)
    return runs


def _pack_target_runs(
    runs: Sequence[Sequence[Mapping[str, Any]]],
    *,
    maximum_targets: int,
    maximum_target_span_frames: int,
) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for run in runs:
        copied_run = [dict(target) for target in run]
        if len(copied_run) > maximum_targets:
            raise ValueError("an inseparable adjacent-frame target run exceeds four targets")
        combined_count = len(current) + len(copied_run)
        combined_span = (
            int(copied_run[-1]["anchorFrameIndex"])
            - int(current[0]["anchorFrameIndex"])
            if current
            else 0
        )
        if current and (
            combined_count > maximum_targets
            or combined_span > maximum_target_span_frames
        ):
            groups.append(current)
            current = []
        current.extend(copied_run)
    if current:
        groups.append(current)
    return groups


def _expand_frame_bounds(
    left: int,
    right: int,
    *,
    last_frame_index: int,
    minimum_span_frames: int,
) -> tuple[int, int]:
    while right - left < minimum_span_frames:
        if left > 0:
            left -= 1
        elif right < last_frame_index:
            right += 1
        else:
            break
        if right - left < minimum_span_frames and right < last_frame_index:
            right += 1
    return left, right


def _plan_sample_frames(
    targets: Sequence[Mapping[str, Any]],
    *,
    context_frames: int,
    last_frame_index: int,
    previous_external_anchor: int | None,
    next_external_anchor: int | None,
) -> list[int]:
    if not 1 <= len(targets) <= MAXIMUM_CLUSTERS_PER_UNIT:
        raise ValueError("a review unit must contain between one and four targets")
    first_anchor = int(targets[0]["anchorFrameIndex"])
    last_anchor = int(targets[-1]["anchorFrameIndex"])
    left = max(0, first_anchor - context_frames)
    if previous_external_anchor is not None:
        if first_anchor - previous_external_anchor < 2:
            raise ValueError("adjacent-frame targets cannot be split across review units")
        left = max(left, (previous_external_anchor + first_anchor) // 2)
    if left >= first_anchor:
        raise ValueError("the first target has no observable pre-state frame")

    right = min(last_frame_index, last_anchor + context_frames)
    if next_external_anchor is not None:
        if next_external_anchor - last_anchor < 2:
            raise ValueError("adjacent-frame targets cannot be split across review units")
        right = min(right, (last_anchor + next_external_anchor) // 2)
    left, right = _expand_frame_bounds(
        left,
        right,
        last_frame_index=last_frame_index,
        minimum_span_frames=SAMPLES_PER_REVIEW_UNIT - 1,
    )
    anchors = [int(target["anchorFrameIndex"]) for target in targets]
    mandatory = [left, *anchors]
    if len(targets) < MAXIMUM_CLUSTERS_PER_UNIT and right > last_anchor:
        mandatory.append(right)
    samples = sorted(set(mandatory))
    candidates = [
        frame
        for frame in range(left, right + 1)
        if frame not in anchors and frame not in samples
    ]
    while len(samples) < SAMPLES_PER_REVIEW_UNIT and candidates:
        selected = max(
            candidates,
            key=lambda frame: (min(abs(frame - sample) for sample in samples), -frame),
        )
        samples.append(selected)
        samples.sort()
        candidates.remove(selected)
    if len(samples) != SAMPLES_PER_REVIEW_UNIT:
        raise ValueError("review unit cannot resolve five distinct source frames")
    return samples


def _assign_targets_to_intervals(
    targets: Sequence[Mapping[str, Any]], sample_frames: Sequence[int]
) -> list[dict[str, Any]]:
    assignments: list[dict[str, Any]] = []
    for target in targets:
        anchor_frame = int(target["anchorFrameIndex"])
        interval_index = next(
            (
                index
                for index, (previous, current) in enumerate(
                    zip(sample_frames, sample_frames[1:])
                )
                if previous < anchor_frame <= current
            ),
            None,
        )
        assignments.append(
            {
                **target,
                "intervalIndex": interval_index,
                "previousSampleIndex": interval_index,
                "currentSampleIndex": (
                    interval_index + 1 if interval_index is not None else None
                ),
            }
        )
    return assignments


def build_review_unit_plan(
    candidate_payload: Mapping[str, Any],
    source: Mapping[str, Any],
    *,
    context_seconds: float = DEFAULT_CONTEXT_SECONDS,
    maximum_target_span_seconds: float = DEFAULT_MAXIMUM_TARGET_SPAN_SECONDS,
) -> dict[str, Any]:
    """Split legacy merged windows into bounded, candidate-aware review units."""

    source_id = str(source.get("id", ""))
    if not source_id:
        raise ValueError("source id is missing")
    timing = _source_timing(source)
    context = _finite_number(context_seconds, "context_seconds")
    if context <= 0:
        raise ValueError("context_seconds must be positive")
    maximum_span = _finite_number(
        maximum_target_span_seconds, "maximum_target_span_seconds"
    )
    if maximum_span <= 0:
        raise ValueError("maximum_target_span_seconds must be positive")
    context_frames = max(1, int(math.floor(context * float(timing["fps"]))))
    maximum_target_span_frames = max(
        1, int(math.floor(maximum_span * float(timing["fps"])))
    )
    analysis_digest, events_by_id, parent_windows = _validate_candidate_payload(
        candidate_payload, source_id
    )

    units: list[dict[str, Any]] = []
    target_sequence = 0
    for parent in parent_windows:
        targets = _build_observation_targets(
            parent["candidateIds"],
            events_by_id,
            timing,
        )
        target_groups = _pack_target_runs(
            _atomic_target_runs(targets),
            maximum_targets=MAXIMUM_CLUSTERS_PER_UNIT,
            maximum_target_span_frames=maximum_target_span_frames,
        )
        for group_index, group in enumerate(target_groups):
            previous_external_anchor = (
                int(target_groups[group_index - 1][-1]["anchorFrameIndex"])
                if group_index > 0
                else None
            )
            next_external_anchor = (
                int(target_groups[group_index + 1][0]["anchorFrameIndex"])
                if group_index + 1 < len(target_groups)
                else None
            )
            sample_frames = _plan_sample_frames(
                group,
                context_frames=context_frames,
                last_frame_index=int(timing["lastFrameIndex"]),
                previous_external_anchor=previous_external_anchor,
                next_external_anchor=next_external_anchor,
            )
            assignments = _assign_targets_to_intervals(group, sample_frames)
            normalized_targets = []
            for assignment in assignments:
                target_sequence += 1
                normalized_targets.append(
                    {
                        "id": f"observation-target-{target_sequence:06d}",
                        **assignment,
                        "anchorTimeSeconds": _frame_to_time(
                            int(assignment["anchorFrameIndex"]), timing
                        ),
                        "separability": (
                            "coincident_same_decoded_frame"
                            if len(assignment["candidateIds"]) > 1
                            else "independent"
                        ),
                    }
                )
            unit_index = len(units) + 1
            candidate_ids = [
                candidate_id
                for target in normalized_targets
                for candidate_id in target["candidateIds"]
            ]
            samples = [
                {
                    "index": index,
                    "frameIndex": frame_index,
                    "timeSeconds": _frame_to_time(frame_index, timing),
                }
                for index, frame_index in enumerate(sample_frames)
            ]
            units.append(
                {
                    "id": f"review-unit-{unit_index:06d}",
                    "parentReviewWindowId": parent["id"],
                    "startSeconds": samples[0]["timeSeconds"],
                    "endSeconds": samples[-1]["timeSeconds"],
                    "candidateIds": candidate_ids,
                    "observationTargets": normalized_targets,
                    "samples": samples,
                }
            )

    configuration = {
        "samplesPerReviewUnit": SAMPLES_PER_REVIEW_UNIT,
        "maximumTargetsPerReviewUnit": MAXIMUM_CLUSTERS_PER_UNIT,
        "contextSeconds": context,
        "contextFrames": context_frames,
        "maximumTargetSpanSeconds": maximum_span,
        "maximumTargetSpanFrames": maximum_target_span_frames,
        "sameFramePolicy": "coalesce",
        "fpsNumerator": timing["fpsNumerator"],
        "fpsDenominator": timing["fpsDenominator"],
    }
    counts = {
        "parentReviewWindows": len(parent_windows),
        "reviewUnits": len(units),
        "rawCandidates": len(events_by_id),
        "observationTargets": sum(len(unit["observationTargets"]) for unit in units),
        "coincidentSameFrameGroups": sum(
            len(target["candidateIds"]) > 1
            for unit in units
            for target in unit["observationTargets"]
        ),
        "reviewSamples": len(units) * SAMPLES_PER_REVIEW_UNIT,
    }
    digest_payload = {
        "sourceId": source_id,
        "analysisDigest": analysis_digest,
        "configuration": configuration,
        "units": units,
    }
    return {
        "schemaVersion": PLAN_SCHEMA_VERSION,
        "sourceId": source_id,
        "analysisDigest": analysis_digest,
        "planDigest": _canonical_digest(digest_payload),
        "configuration": configuration,
        "counts": counts,
        "units": units,
    }


def _legacy_units(
    windows: Sequence[Mapping[str, Any]], timing: Mapping[str, Any]
) -> list[dict[str, Any]]:
    units = []
    for window in windows:
        start = float(window["startSeconds"])
        end = float(window["endSeconds"])
        times = [
            start + (end - start) * index / (SAMPLES_PER_REVIEW_UNIT - 1)
            for index in range(SAMPLES_PER_REVIEW_UNIT)
        ]
        units.append(
            {
                "id": window["id"],
                "parentReviewWindowId": window["id"],
                "startSeconds": start,
                "endSeconds": end,
                "candidateIds": list(window["candidateIds"]),
                "samples": [
                    {
                        "index": index,
                        "frameIndex": _time_to_frame(time_seconds, timing),
                        "timeSeconds": round(time_seconds, 9),
                    }
                    for index, time_seconds in enumerate(times)
                ],
            }
        )
    return units


def _audit_units(
    units: Sequence[Mapping[str, Any]],
    events_by_id: Mapping[str, Mapping[str, Any]],
    timing: Mapping[str, Any],
) -> dict[str, Any]:
    references: Counter[str] = Counter()
    unit_reports: list[dict[str, Any]] = []
    maximum_candidate_count = 0
    maximum_cluster_count = 0
    maximum_span_frames = 0
    maximum_sample_gap_frames = 0
    collision_interval_count = 0

    for unit_index, unit in enumerate(units, start=1):
        unit_id = str(unit.get("id", f"unit-{unit_index}"))
        candidate_ids = [str(value) for value in unit.get("candidateIds", [])]
        for candidate_id in candidate_ids:
            references[candidate_id] += 1
        errors: list[str] = []
        unknown = sorted(set(candidate_ids) - events_by_id.keys())
        if unknown:
            errors.append("unknown candidates: " + ", ".join(unknown))
        samples = list(unit.get("samples", []))
        sample_frames = [int(sample.get("frameIndex", -1)) for sample in samples]
        if len(samples) != SAMPLES_PER_REVIEW_UNIT:
            errors.append(
                f"expected {SAMPLES_PER_REVIEW_UNIT} samples, found {len(samples)}"
            )
        if any(
            current <= previous
            for previous, current in zip(sample_frames, sample_frames[1:])
        ):
            errors.append("sample frame indices are not strictly increasing")
        sample_gaps = [
            {
                "intervalIndex": index,
                "frames": current - previous,
                "seconds": round((current - previous) / float(timing["fps"]), 9),
            }
            for index, (previous, current) in enumerate(
                zip(sample_frames, sample_frames[1:])
            )
        ]
        maximum_sample_gap_frames = max(
            maximum_sample_gap_frames,
            max((gap["frames"] for gap in sample_gaps), default=0),
        )
        known_candidate_ids = [
            candidate_id for candidate_id in candidate_ids if candidate_id in events_by_id
        ]
        targets = _build_observation_targets(
            known_candidate_ids,
            events_by_id,
            timing,
        )
        interval_targets: dict[int, list[int]] = {}
        target_reports: list[dict[str, Any]] = []
        for target_index, target in enumerate(targets):
            assignments = _assign_targets_to_intervals([target], sample_frames)
            interval_index = assignments[0]["intervalIndex"] if assignments else None
            if interval_index is None:
                errors.append(f"target {target_index} is not bracketed by adjacent samples")
                previous_distance = None
                current_distance = None
            else:
                interval_targets.setdefault(interval_index, []).append(target_index)
                anchor_frame = int(target["anchorFrameIndex"])
                previous_distance = anchor_frame - sample_frames[interval_index]
                current_distance = sample_frames[interval_index + 1] - anchor_frame
                if anchor_frame not in sample_frames:
                    errors.append(f"target {target_index} anchor frame is not directly sampled")
            target_reports.append(
                {
                    "targetIndex": target_index,
                    "candidateIds": list(target["candidateIds"]),
                    "anchorFrameIndex": target["anchorFrameIndex"],
                    "intervalIndex": interval_index,
                    "previousDistanceFrames": previous_distance,
                    "currentDistanceFrames": current_distance,
                }
            )
        collisions = [
            {
                "intervalIndex": interval_index,
                "targetIndices": target_indices,
                "candidateIds": [
                    candidate_id
                    for target_index in target_indices
                    for candidate_id in targets[target_index]["candidateIds"]
                ],
            }
            for interval_index, target_indices in sorted(interval_targets.items())
            if len(target_indices) > 1
        ]
        if collisions:
            collision_interval_count += len(collisions)
            errors.append(
                f"{len(collisions)} adjacent sample intervals contain multiple separable clusters"
            )
        candidate_observations = []
        for candidate_id in known_candidate_ids:
            candidate_frame = _time_to_frame(
                float(events_by_id[candidate_id]["timeSeconds"]), timing
            )
            nearest_distance = min(
                (abs(candidate_frame - frame) for frame in sample_frames),
                default=None,
            )
            candidate_observations.append(
                {
                    "candidateId": candidate_id,
                    "timeSeconds": float(events_by_id[candidate_id]["timeSeconds"]),
                    "frameIndex": candidate_frame,
                    "nearestSampleDistanceFrames": nearest_distance,
                    "nearestSampleDistanceSeconds": (
                        round(nearest_distance / float(timing["fps"]), 9)
                        if nearest_distance is not None
                        else None
                    ),
                }
            )
        span_frames = sample_frames[-1] - sample_frames[0] if sample_frames else 0
        maximum_candidate_count = max(maximum_candidate_count, len(candidate_ids))
        maximum_cluster_count = max(maximum_cluster_count, len(targets))
        maximum_span_frames = max(maximum_span_frames, span_frames)
        unit_reports.append(
            {
                "id": unit_id,
                "auditable": not errors,
                "candidateCount": len(candidate_ids),
                "observationTargetCount": len(targets),
                "sampleFrames": sample_frames,
                "sampleGaps": sample_gaps,
                "spanFrames": span_frames,
                "spanSeconds": round(span_frames / float(timing["fps"]), 9),
                "observationTargets": target_reports,
                "candidateObservations": candidate_observations,
                "collisionIntervals": collisions,
                "errors": errors,
            }
        )

    missing_candidates = sorted(
        candidate_id for candidate_id in events_by_id if references[candidate_id] == 0
    )
    duplicated_candidates = sorted(
        candidate_id for candidate_id, count in references.items() if count > 1
    )
    global_errors = []
    if missing_candidates:
        global_errors.append(f"{len(missing_candidates)} candidates are not assigned")
    if duplicated_candidates:
        global_errors.append(f"{len(duplicated_candidates)} candidates are assigned more than once")
    unreviewable = [report["id"] for report in unit_reports if not report["auditable"]]
    status = "passed" if not global_errors and not unreviewable else "failed"
    return {
        "status": status,
        "globalErrors": global_errors,
        "missingCandidateIds": missing_candidates,
        "duplicatedCandidateIds": duplicated_candidates,
        "counts": {
            "reviewUnits": len(unit_reports),
            "auditableReviewUnits": len(unit_reports) - len(unreviewable),
            "unreviewableReviewUnits": len(unreviewable),
            "candidates": len(events_by_id),
            "candidateReferences": sum(references.values()),
            "collisionIntervals": collision_interval_count,
        },
        "maximums": {
            "candidatesPerReviewUnit": maximum_candidate_count,
            "observationTargetsPerReviewUnit": maximum_cluster_count,
            "spanFrames": maximum_span_frames,
            "spanSeconds": round(maximum_span_frames / float(timing["fps"]), 9),
            "sampleGapFrames": maximum_sample_gap_frames,
            "sampleGapSeconds": round(
                maximum_sample_gap_frames / float(timing["fps"]), 9
            ),
        },
        "unreviewableReviewUnitIds": unreviewable,
        "reviewUnits": unit_reports,
    }


def build_sampling_adequacy_report(
    candidate_payload: Mapping[str, Any],
    source: Mapping[str, Any],
    plan: Mapping[str, Any],
) -> dict[str, Any]:
    source_id = str(source.get("id", ""))
    timing = _source_timing(source)
    analysis_digest, events_by_id, parent_windows = _validate_candidate_payload(
        candidate_payload, source_id
    )
    if plan.get("schemaVersion") != PLAN_SCHEMA_VERSION:
        raise ValueError("unsupported review-unit plan schema")
    if plan.get("sourceId") != source_id:
        raise ValueError("review-unit plan source mismatch")
    if plan.get("analysisDigest") != analysis_digest:
        raise ValueError("review-unit plan analysisDigest mismatch")
    configuration = plan.get("configuration")
    if not isinstance(configuration, Mapping):
        raise ValueError("review-unit plan configuration is missing")
    expected_plan_digest = _canonical_digest(
        {
            "sourceId": source_id,
            "analysisDigest": analysis_digest,
            "configuration": dict(configuration),
            "units": plan.get("units", []),
        }
    )
    if plan.get("planDigest") != expected_plan_digest:
        raise ValueError("review-unit plan digest mismatch")
    legacy = _audit_units(
        _legacy_units(parent_windows, timing),
        events_by_id,
        timing,
    )
    planned = _audit_units(
        plan.get("units", []),
        events_by_id,
        timing,
    )
    return {
        "schemaVersion": AUDIT_SCHEMA_VERSION,
        "sourceId": source_id,
        "analysisDigest": analysis_digest,
        "planDigest": plan.get("planDigest"),
        "configuration": dict(configuration),
        "status": planned["status"],
        "legacyMergedWindows": legacy,
        "plannedReviewUnits": planned,
    }


def _load_source(manifest_path: Path, source_id: str) -> dict[str, Any]:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != "corpus-manifest-v1":
        raise ValueError("unsupported corpus manifest schema")
    sources = [source for source in payload.get("sources", []) if source.get("id") == source_id]
    if len(sources) != 1:
        raise ValueError(f"expected one corpus source named {source_id!r}")
    return sources[0]


def _atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        required=True,
    )
    parser.add_argument("--source", required=True)
    parser.add_argument("--analysis-directory", type=Path, required=True)
    parser.add_argument("--output-plan", type=Path)
    parser.add_argument("--output-report", type=Path)
    parser.add_argument("--context-seconds", type=float, default=DEFAULT_CONTEXT_SECONDS)
    parser.add_argument(
        "--maximum-target-span-seconds",
        type=float,
        default=DEFAULT_MAXIMUM_TARGET_SPAN_SECONDS,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_argument_parser().parse_args(argv)
    analysis_directory = arguments.analysis_directory.resolve()
    source = _load_source(arguments.manifest, arguments.source)
    candidate_payload = json.loads(
        (analysis_directory / "candidate-events.json").read_text(encoding="utf-8")
    )
    plan = build_review_unit_plan(
        candidate_payload,
        source,
        context_seconds=arguments.context_seconds,
        maximum_target_span_seconds=arguments.maximum_target_span_seconds,
    )
    report = build_sampling_adequacy_report(candidate_payload, source, plan)
    output_plan = arguments.output_plan or analysis_directory / "review-unit-plan.json"
    output_report = (
        arguments.output_report
        or analysis_directory / "review-sampling-adequacy.json"
    )
    _atomic_write_json(output_plan, plan)
    _atomic_write_json(output_report, report)
    summary = {
        "sourceId": arguments.source,
        "plan": str(output_plan.resolve()),
        "report": str(output_report.resolve()),
        "legacy": report["legacyMergedWindows"]["counts"],
        "planned": report["plannedReviewUnits"]["counts"],
        "status": report["status"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
