#!/usr/bin/env python3
"""Independently verify generated editorial review assets."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from verify_analysis import verify_artifact_record


TARGET_SEQUENCE_SAMPLES = 5
TARGET_SEQUENCE_FRAME_STEP = 3


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _same_sample(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    keys = {
        "sampleIndex",
        "requestedTimeSeconds",
        "decodedTimeSeconds",
        "frameIndex",
    }
    return all(left.get(key) == right.get(key) for key in keys)


def _load_corpus_source(
    record: Mapping[str, Any], source_id: str
) -> tuple[dict[str, Any] | None, list[str]]:
    errors = verify_artifact_record(record)
    path = Path(str(record.get("path", "")))
    if not path.is_file():
        return None, errors
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != "corpus-manifest-v1":
        errors.append("unsupported corpus manifest schema")
        return None, errors
    matches = [
        source for source in payload.get("sources", []) if source.get("id") == source_id
    ]
    if len(matches) != 1:
        errors.append(f"corpus manifest must contain exactly one source {source_id!r}")
        return None, errors
    return matches[0], errors


def _source_timing(source: Mapping[str, Any]) -> tuple[float, float, int]:
    video = source["video"]
    fps_record = video["fps"]
    numerator = int(fps_record["numerator"])
    denominator = int(fps_record["denominator"])
    if numerator <= 0 or denominator <= 0:
        raise ValueError("source FPS numerator and denominator must be positive")
    fps = numerator / denominator
    start_seconds = float(video.get("start", 0.0))
    explicit_count = video.get("frameCount", video.get("nbFrames"))
    if explicit_count is not None:
        frame_count = int(explicit_count)
    else:
        duration = float(video.get("duration", source["formatDurationSeconds"]))
        frame_count = int(math.ceil(duration * fps - 1e-9))
    if not math.isfinite(start_seconds) or frame_count <= 0:
        raise ValueError("source timing is invalid")
    return fps, start_seconds, frame_count


def _expected_target_frames(anchor_frame_index: int, frame_count: int) -> list[int]:
    if not 0 <= anchor_frame_index < frame_count:
        raise ValueError("target anchor frame falls outside the source")
    left_steps = anchor_frame_index // TARGET_SEQUENCE_FRAME_STEP
    right_steps = (
        frame_count - 1 - anchor_frame_index
    ) // TARGET_SEQUENCE_FRAME_STEP
    minimum_start = max(-left_steps, -(TARGET_SEQUENCE_SAMPLES - 1))
    maximum_start = min(right_steps - (TARGET_SEQUENCE_SAMPLES - 1), 0)
    if minimum_start > maximum_start:
        raise ValueError(
            "source does not contain five unique fixed-step frames around the target anchor"
        )
    preferred_start = -(TARGET_SEQUENCE_SAMPLES // 2)
    start = min(max(preferred_start, minimum_start), maximum_start)
    return [
        anchor_frame_index
        + (start + sample_index) * TARGET_SEQUENCE_FRAME_STEP
        for sample_index in range(TARGET_SEQUENCE_SAMPLES)
    ]


def validate_target_sequences(
    sequences: Sequence[Mapping[str, Any]],
    review_windows: Sequence[Mapping[str, Any]],
    *,
    source: Mapping[str, Any] | None,
    samples_per_sequence: int,
    frame_step: int,
    output_directory: Path,
) -> list[str]:
    errors: list[str] = []
    if samples_per_sequence != TARGET_SEQUENCE_SAMPLES:
        errors.append("targetSequenceSamples must be 5")
    if frame_step != TARGET_SEQUENCE_FRAME_STEP:
        errors.append("targetSequenceFrameStep must be 3")

    expected: dict[tuple[str, str], Mapping[str, Any]] = {}
    for window in review_windows:
        review_window_id = str(window.get("id", ""))
        targets = window.get("observationTargets", [])
        if not isinstance(targets, list):
            errors.append(f"{review_window_id} observationTargets must be an array")
            continue
        for target in targets:
            if not isinstance(target, Mapping):
                errors.append(f"{review_window_id} contains an invalid observation target")
                continue
            target_id = str(target.get("id", ""))
            key = (review_window_id, target_id)
            if not target_id or key in expected:
                errors.append(
                    f"empty or duplicate planned target key: {review_window_id}:{target_id}"
                )
                continue
            expected[key] = target

    actual: dict[tuple[str, str], Mapping[str, Any]] = {}
    for sequence in sequences:
        key = (
            str(sequence.get("reviewWindowId", "")),
            str(sequence.get("targetId", "")),
        )
        if not key[0] or not key[1] or key in actual:
            errors.append(f"empty or duplicate target sequence key: {key[0]}:{key[1]}")
            continue
        actual[key] = sequence

    missing = sorted(set(expected) - set(actual))
    unexpected = sorted(set(actual) - set(expected))
    if missing:
        errors.append(
            "missing target sequences: "
            + ", ".join(f"{window_id}:{target_id}" for window_id, target_id in missing)
        )
    if unexpected:
        errors.append(
            "unexpected target sequences: "
            + ", ".join(f"{window_id}:{target_id}" for window_id, target_id in unexpected)
        )

    timing: tuple[float, float, int] | None = None
    if source is not None:
        try:
            timing = _source_timing(source)
        except (KeyError, TypeError, ValueError) as error:
            errors.append(f"cannot resolve source timing for target sequences: {error}")

    sample_keys: list[tuple[str, str, int]] = []
    for key in sorted(set(expected) & set(actual)):
        target = expected[key]
        sequence = actual[key]
        label = f"{key[0]}:{key[1]}"
        if sequence.get("targetProvenance") != target:
            errors.append(f"{label} target provenance does not match the review plan")
        samples = sequence.get("samples")
        if not isinstance(samples, list) or len(samples) != TARGET_SEQUENCE_SAMPLES:
            errors.append(f"{label} target sequence does not contain 5 samples")
            continue
        sample_indices = [int(sample.get("sampleIndex", -1)) for sample in samples]
        if sample_indices != list(range(TARGET_SEQUENCE_SAMPLES)):
            errors.append(f"{label} target sample indices must be 0..4")
        frame_indices = [int(sample.get("frameIndex", -1)) for sample in samples]
        if len(set(frame_indices)) != TARGET_SEQUENCE_SAMPLES or any(
            current <= previous
            for previous, current in zip(frame_indices, frame_indices[1:])
        ):
            errors.append(f"{label} target frame indices must be unique and increasing")
        anchor_frame_index = int(target.get("anchorFrameIndex", -1))
        if anchor_frame_index not in frame_indices:
            errors.append(f"{label} target sequence does not include its anchor frame")

        if timing is not None:
            fps, start_seconds, frame_count = timing
            try:
                expected_frames = _expected_target_frames(anchor_frame_index, frame_count)
            except ValueError as error:
                errors.append(f"{label} target frame plan is invalid: {error}")
                expected_frames = []
            if frame_indices != expected_frames:
                errors.append(f"{label} target frame indices do not match the deterministic plan")
            expected_times = [round(start_seconds + frame / fps, 9) for frame in expected_frames]
            actual_requested = [
                float(sample.get("requestedTimeSeconds", -1)) for sample in samples
            ]
            actual_decoded = [
                float(sample.get("decodedTimeSeconds", -1)) for sample in samples
            ]
            if actual_requested != expected_times or actual_decoded != expected_times:
                errors.append(f"{label} target sample times do not match source frames")

        expected_offsets = [frame - anchor_frame_index for frame in frame_indices]
        actual_offsets = [int(sample.get("frameOffset", 0)) for sample in samples]
        if actual_offsets != expected_offsets:
            errors.append(f"{label} target frame offsets do not match the anchor")
        for sample_position, sample in enumerate(samples, start=1):
            sample_index = int(sample.get("sampleIndex", -1))
            sample_keys.append((key[0], key[1], sample_index))
            actual_path = Path(str(sample.get("path", ""))).resolve()
            expected_path = (
                output_directory
                / "target-sequences"
                / key[0]
                / f"{key[1]}-frame-{sample_position:02d}.jpg"
            ).resolve()
            if actual_path != expected_path:
                errors.append(
                    f"{label} target frame path mismatch at sample {sample_position - 1}: "
                    f"expected {expected_path}, found {actual_path}"
                )

    duplicate_sample_keys = sorted(
        value for value, count in Counter(sample_keys).items() if count > 1
    )
    if duplicate_sample_keys:
        errors.append(
            "duplicate target sample keys: "
            + ", ".join(
                f"{window_id}:{target_id}:{sample_index}"
                for window_id, target_id, sample_index in duplicate_sample_keys
            )
        )
    return errors


def validate_review_strips(
    strips: Sequence[Mapping[str, Any]],
    candidate_windows: Sequence[Mapping[str, Any]],
    *,
    samples_per_window: int,
    output_directory: Path,
) -> list[str]:
    errors: list[str] = []
    expected_samples_per_window = 5
    if samples_per_window != expected_samples_per_window:
        errors.append("reviewSamplesPerWindow must be 5")
    ids = [str(strip.get("reviewWindowId", "")) for strip in strips]
    duplicate_ids = sorted(value for value, count in Counter(ids).items() if count > 1)
    if duplicate_ids:
        errors.append(f"duplicate review-window ids: {', '.join(duplicate_ids)}")
    if len(strips) != len(candidate_windows):
        errors.append(
            f"review strip count mismatch: expected {len(candidate_windows)}, found {len(strips)}"
        )

    frame_paths: list[str] = []
    sample_keys: list[tuple[str, int]] = []
    for index, strip in enumerate(strips, start=1):
        window = candidate_windows[index - 1] if index <= len(candidate_windows) else {}
        expected_id = str(window.get("id", f"review-window-{index:06d}"))
        window_id = str(strip.get("reviewWindowId", ""))
        if strip.get("reviewWindowId") != expected_id:
            errors.append(f"review strip {index} id is not {expected_id}")
        if index <= len(candidate_windows):
            for key in ("startSeconds", "endSeconds"):
                if float(strip.get(key, -1)) != float(window[key]):
                    errors.append(f"{expected_id} {key} does not match candidate-events")
            if list(strip.get("candidateIds", [])) != list(window.get("candidateIds", [])):
                errors.append(f"{expected_id} candidate ids do not match the review plan")
            if "parentReviewWindowId" in window and strip.get(
                "parentReviewWindowId"
            ) != window.get("parentReviewWindowId"):
                errors.append(f"{expected_id} parent review window does not match")
        samples = strip.get("samples")
        if not isinstance(samples, list) or len(samples) != expected_samples_per_window:
            errors.append(
                f"{expected_id} does not contain {expected_samples_per_window} samples"
            )
            continue

        sample_indices = [int(sample.get("sampleIndex", -1)) for sample in samples]
        if sample_indices != list(range(expected_samples_per_window)):
            errors.append(f"{expected_id} sample indices must be 0..4")
        if "samples" in window:
            expected_times = [float(sample["timeSeconds"]) for sample in window["samples"]]
            expected_frames = [int(sample["frameIndex"]) for sample in window["samples"]]
            actual_times = [float(sample.get("requestedTimeSeconds", -1)) for sample in samples]
            actual_frames = [int(sample.get("frameIndex", -1)) for sample in samples]
            if actual_times != expected_times:
                errors.append(f"{expected_id} requested sample times do not match")
            if actual_frames != expected_frames:
                errors.append(f"{expected_id} frame indices do not match")
        for sample_position, sample in enumerate(samples, start=1):
            sample_index = int(sample.get("sampleIndex", -1))
            sample_keys.append((window_id, sample_index))
            actual_path = Path(str(sample.get("path", ""))).resolve()
            frame_paths.append(str(actual_path))
            expected_path = (
                output_directory
                / "review-frames"
                / f"{expected_id}-frame-{sample_position:02d}.jpg"
            ).resolve()
            if actual_path != expected_path:
                errors.append(
                    f"{expected_id} review frame path mismatch at sample "
                    f"{sample_position - 1}: expected {expected_path}, found {actual_path}"
                )

    duplicate_paths = sorted(
        value for value, count in Counter(frame_paths).items() if count > 1
    )
    if duplicate_paths:
        errors.append(f"duplicate review frame paths: {', '.join(duplicate_paths)}")
    duplicate_sample_keys = sorted(
        value for value, count in Counter(sample_keys).items() if count > 1
    )
    if duplicate_sample_keys:
        rendered_keys = ", ".join(
            f"{window_id}:{sample_index}"
            for window_id, sample_index in duplicate_sample_keys
        )
        errors.append(f"duplicate review frame sample keys: {rendered_keys}")
    return errors


def _load_review_unit_plan(
    record: Mapping[str, Any],
    *,
    source_id: str,
    analysis_digest: str,
    candidate_payload: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    errors = verify_artifact_record(record)
    path = Path(str(record.get("path", "")))
    if not path.is_file():
        return [], errors
    plan = json.loads(path.read_text(encoding="utf-8"))
    if plan.get("schemaVersion") != "review-unit-plan-v1":
        errors.append("unsupported review-unit plan schema")
    if plan.get("sourceId") != source_id:
        errors.append("review-unit plan source does not match review assets")
    if plan.get("analysisDigest") != analysis_digest:
        errors.append("review-unit plan digest does not match review assets")
    configuration = plan.get("configuration")
    units = plan.get("units")
    if not isinstance(configuration, dict) or not isinstance(units, list):
        errors.append("review-unit plan configuration or units are invalid")
        return [], errors
    expected_digest = hashlib.sha256(
        json.dumps(
            {
                "sourceId": source_id,
                "analysisDigest": analysis_digest,
                "configuration": configuration,
                "units": units,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    if plan.get("planDigest") != expected_digest:
        errors.append("review-unit plan content digest mismatch")
    parent_ids = {
        f"review-window-{index:06d}"
        for index, _window in enumerate(candidate_payload.get("reviewWindows", []), start=1)
    }
    candidate_ids = {str(event.get("id", "")) for event in candidate_payload.get("events", [])}
    references: Counter[str] = Counter()
    seen_ids: set[str] = set()
    for index, unit in enumerate(units, start=1):
        if not isinstance(unit, dict):
            errors.append(f"review unit {index} is not an object")
            continue
        unit_id = str(unit.get("id", ""))
        if not unit_id or unit_id in seen_ids:
            errors.append(f"review unit {index} has an empty or duplicate id")
        seen_ids.add(unit_id)
        if unit.get("parentReviewWindowId") not in parent_ids:
            errors.append(f"review unit {unit_id or index} has an unknown parent window")
        unit_candidate_ids = [str(value) for value in unit.get("candidateIds", [])]
        references.update(unit_candidate_ids)
        if not unit_candidate_ids or not set(unit_candidate_ids).issubset(candidate_ids):
            errors.append(f"review unit {unit_id or index} has invalid candidate ids")
        samples = unit.get("samples")
        if not isinstance(samples, list) or len(samples) != 5:
            errors.append(f"review unit {unit_id or index} does not have five samples")
            continue
        frame_indices = [int(sample.get("frameIndex", -1)) for sample in samples]
        if any(current <= previous for previous, current in zip(frame_indices, frame_indices[1:])):
            errors.append(f"review unit {unit_id or index} frame indices do not increase")
        anchors = [
            int(target.get("anchorFrameIndex", -1))
            for target in unit.get("observationTargets", [])
        ]
        if not anchors or any(anchor not in frame_indices for anchor in anchors):
            errors.append(f"review unit {unit_id or index} has an unsampled target anchor")
    if references != Counter(candidate_ids):
        errors.append("review-unit plan does not reference every candidate exactly once")
    return units, errors


def validate_fine_evidence(
    records: Sequence[Mapping[str, Any]],
    strips: Sequence[Mapping[str, Any]],
    *,
    source_id: str,
    analysis_digest: str,
) -> list[str]:
    errors: list[str] = []
    by_window: dict[str, list[Mapping[str, Any]]] = {}
    ids: Counter[str] = Counter()
    for record in records:
        record_id = str(record.get("id", ""))
        ids[record_id] += 1
        window_id = str(record.get("reviewWindowId", ""))
        by_window.setdefault(window_id, []).append(record)
        if record.get("schemaVersion") != "fine-evidence-v1":
            errors.append(f"fine evidence {record_id or '<unknown>'} has an invalid schema")
        if record.get("sourceId") != source_id:
            errors.append(f"fine evidence {record_id or '<unknown>'} has a source mismatch")
        if record.get("analysisDigest") != analysis_digest:
            errors.append(f"fine evidence {record_id or '<unknown>'} has a digest mismatch")

    duplicate_ids = sorted(value for value, count in ids.items() if not value or count > 1)
    if duplicate_ids:
        errors.append(f"empty or duplicate fine-evidence ids: {', '.join(duplicate_ids)}")

    expected_window_ids = {str(strip["reviewWindowId"]) for strip in strips}
    unexpected_window_ids = sorted(set(by_window) - expected_window_ids)
    if unexpected_window_ids:
        errors.append(
            f"fine evidence references unknown windows: {', '.join(unexpected_window_ids)}"
        )

    for strip in strips:
        window_id = str(strip["reviewWindowId"])
        samples = strip.get("samples", [])
        window_records = sorted(
            by_window.get(window_id, []),
            key=lambda record: int(record.get("pairIndex", -1)),
        )
        expected_pairs = max(0, len(samples) - 1)
        if len(window_records) != expected_pairs:
            errors.append(
                f"{window_id} fine-evidence count mismatch: expected {expected_pairs}, "
                f"found {len(window_records)}"
            )
            continue
        for pair_index, record in enumerate(window_records, start=1):
            if int(record.get("pairIndex", -1)) != pair_index:
                errors.append(f"{window_id} fine-evidence pair indices are not contiguous")
            if list(record.get("candidateIds", [])) != list(strip.get("candidateIds", [])):
                errors.append(f"{window_id} fine-evidence candidate ids do not match")
            if not _same_sample(record.get("previousFrame", {}), samples[pair_index - 1]):
                errors.append(f"{window_id} pair {pair_index} previous frame does not match")
            if not _same_sample(record.get("currentFrame", {}), samples[pair_index]):
                errors.append(f"{window_id} pair {pair_index} current frame does not match")
    return errors


def verify_review_assets_directory(directory: Path) -> dict[str, Any]:
    manifest_path = directory / "review-assets-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_id = str(manifest.get("sourceId", "unknown"))
    analysis_digest = str(manifest.get("analysisDigest", ""))
    errors: list[str] = []
    if manifest.get("schemaVersion") != "review-assets-manifest-v2":
        errors.append("unsupported review-assets manifest schema")
    if manifest.get("status") != "complete":
        errors.append("review-assets manifest is not complete")

    output_directory = Path(str(manifest.get("outputDirectory", directory))).resolve()
    if output_directory != directory.resolve():
        errors.append("manifest outputDirectory does not match the inspected directory")

    inputs = manifest.get("inputs", {})
    corpus_record = inputs.get("corpusManifest")
    source: dict[str, Any] | None = None
    if not isinstance(corpus_record, Mapping):
        errors.append("corpus manifest input record is missing")
    else:
        source, corpus_errors = _load_corpus_source(corpus_record, source_id)
        errors.extend(corpus_errors)

    candidate_record = inputs.get("candidateEvents")
    candidate_payload: dict[str, Any] = {}
    if not isinstance(candidate_record, Mapping):
        errors.append("candidate-events input record is missing")
        candidate_windows: list[dict[str, Any]] = []
    else:
        errors.extend(verify_artifact_record(candidate_record))
        candidate_path = Path(str(candidate_record["path"]))
        candidate_payload = json.loads(candidate_path.read_text(encoding="utf-8"))
        candidate_windows = candidate_payload.get("reviewWindows", [])
        if candidate_payload.get("sourceId") != source_id:
            errors.append("candidate-events source does not match review assets")
        if candidate_payload.get("analysisDigest") != analysis_digest:
            errors.append("candidate-events digest does not match review assets")

    review_windows = candidate_windows
    review_unit_plan_record = inputs.get("reviewUnitPlan")
    if review_unit_plan_record is not None:
        if not isinstance(review_unit_plan_record, Mapping):
            errors.append("review-unit plan input record is invalid")
            review_windows = []
        else:
            review_windows, plan_errors = _load_review_unit_plan(
                review_unit_plan_record,
                source_id=source_id,
                analysis_digest=analysis_digest,
                candidate_payload=candidate_payload,
            )
            errors.extend(plan_errors)

    artifacts = manifest.get("artifacts", {})
    fine_record = artifacts.get("fineEvidence")
    strips = artifacts.get("reviewStrips", [])
    target_sequences = artifacts.get("targetSequences", [])
    overview_pages = artifacts.get("overviewContactSheets", [])
    all_samples = [sample for strip in strips for sample in strip.get("samples", [])]
    target_samples = [
        sample for sequence in target_sequences for sample in sequence.get("samples", [])
    ]
    artifact_records = [
        record
        for record in [
            fine_record,
            *strips,
            *all_samples,
            *target_samples,
            *overview_pages,
        ]
        if record
    ]
    artifact_paths: list[str] = []
    for artifact_record in artifact_records:
        errors.extend(verify_artifact_record(artifact_record))
        artifact_path = Path(str(artifact_record["path"])).resolve()
        artifact_paths.append(str(artifact_path))
        if not artifact_path.is_relative_to(output_directory):
            errors.append(f"review artifact is outside outputDirectory: {artifact_path}")
    duplicate_artifact_paths = sorted(
        value for value, count in Counter(artifact_paths).items() if count > 1
    )
    if duplicate_artifact_paths:
        errors.append(
            f"duplicate artifact paths: {', '.join(duplicate_artifact_paths)}"
        )

    samples_per_window = int(
        manifest.get("configuration", {}).get("reviewSamplesPerWindow", -1)
    )
    errors.extend(
        validate_review_strips(
            strips,
            review_windows,
            samples_per_window=samples_per_window,
            output_directory=output_directory,
        )
    )
    configuration = manifest.get("configuration", {})
    errors.extend(
        validate_target_sequences(
            target_sequences,
            review_windows,
            source=source,
            samples_per_sequence=int(configuration.get("targetSequenceSamples", -1)),
            frame_step=int(configuration.get("targetSequenceFrameStep", -1)),
            output_directory=output_directory,
        )
    )

    if isinstance(fine_record, Mapping) and Path(str(fine_record["path"])).is_file():
        fine_records = _load_jsonl(Path(str(fine_record["path"])))
    else:
        fine_records = []
    errors.extend(
        validate_fine_evidence(
            fine_records,
            strips,
            source_id=source_id,
            analysis_digest=analysis_digest,
        )
    )

    overview_samples = [
        sample for page in overview_pages for sample in page.get("samples", [])
    ]
    unique_frames = {
        int(sample["frameIndex"])
        for sample in [*all_samples, *target_samples, *overview_samples]
    }
    actual_counts = {
        "parentReviewWindows": len(candidate_windows),
        "reviewUnits": len(review_windows),
        "reviewWindows": len(review_windows),
        "reviewSamples": len(all_samples),
        "reviewFrames": len(all_samples),
        "targetSequences": len(target_sequences),
        "targetSequenceSamples": len(target_samples),
        "targetFrames": len(target_samples),
        "overviewSamples": len(overview_samples),
        "decodedUniqueFrames": len(unique_frames),
        "reviewStrips": len(strips),
        "overviewContactSheets": len(overview_pages),
        "fineEvidenceRecords": len(fine_records),
    }
    manifest_counts = manifest.get("counts", {})
    for key, actual in actual_counts.items():
        if key in {"parentReviewWindows", "reviewUnits"} and key not in manifest_counts:
            continue
        if int(manifest_counts.get(key, -1)) != actual:
            errors.append(
                f"count mismatch for {key}: manifest={manifest_counts.get(key)}, actual={actual}"
            )
    if int(manifest_counts.get("ffmpegDecodePasses", 0)) < 1:
        errors.append("ffmpegDecodePasses must be positive")
    if list(directory.rglob(".*.tmp")):
        errors.append("temporary files remain in the review-assets directory")

    return {
        "sourceId": source_id,
        "status": "passed" if not errors else "failed",
        "errors": errors,
        "counts": {
            **actual_counts,
            "ffmpegDecodePasses": int(manifest_counts.get("ffmpegDecodePasses", 0)),
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
    parser.add_argument(
        "--corpus-manifest",
        type=Path,
        default=Path("docs/editorial-grammar/corpus-manifest.json"),
    )
    parser.add_argument("--review-assets-directory", type=Path, action="append", required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("tmp/editorial-analysis/review-assets-verification.json"),
    )
    arguments = parser.parse_args()

    corpus = json.loads(arguments.corpus_manifest.read_text(encoding="utf-8"))
    expected_ids = {str(source["id"]) for source in corpus.get("sources", [])}
    reports = [
        verify_review_assets_directory(directory)
        for directory in arguments.review_assets_directory
    ]
    actual_ids = {str(report["sourceId"]) for report in reports}
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
    count_keys = (
        "reviewWindows",
        "parentReviewWindows",
        "reviewUnits",
        "reviewSamples",
        "reviewFrames",
        "targetSequences",
        "targetSequenceSamples",
        "targetFrames",
        "overviewSamples",
        "decodedUniqueFrames",
        "reviewStrips",
        "overviewContactSheets",
        "fineEvidenceRecords",
        "ffmpegDecodePasses",
    )
    output = {
        "schemaVersion": "review-assets-verification-v1",
        "status": status,
        "corpusErrors": corpus_errors,
        "sourceReports": reports,
        "totals": {
            key: sum(int(report["counts"].get(key, 0)) for report in reports)
            for key in count_keys
        },
    }
    _write_json(arguments.output, output)
    print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
