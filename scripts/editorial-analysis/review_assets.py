#!/usr/bin/env python3
"""Generate visual review assets and fine-grained observable evidence.

The output intentionally stops at camera-family candidates. Flattened reference
video is evidence of rendered motion, not proof of an original editing recipe.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import tempfile
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, BinaryIO

import cv2
import numpy as np

from detectors import compute_frame_features, estimate_camera_transform
from review_sampling import build_sampling_adequacy_report


FRAME_WIDTH = 256
FRAME_HEIGHT = 144
TIMECODE_HEIGHT = 24
SAMPLES_PER_REVIEW_WINDOW = 5
TARGET_SEQUENCE_SAMPLES = 5
TARGET_SEQUENCE_FRAME_STEP = 3
OVERVIEW_INTERVAL_SECONDS = 10.0
OVERVIEW_COLUMNS = 5
OVERVIEW_ROWS = 4
MAXIMUM_SELECTION_FILTER_BYTES = 32 * 1024
SCHEMA_VERSION = "review-assets-manifest-v2"


def plan_review_samples(
    review_windows: Sequence[Mapping[str, Any]],
    *,
    duration_seconds: float,
    samples_per_window: int = SAMPLES_PER_REVIEW_WINDOW,
) -> list[dict[str, Any]]:
    """Return a stable five-point sampling plan for each review window or unit."""

    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("duration must be a positive finite number")
    if samples_per_window < 2:
        raise ValueError("at least two samples per review window are required")

    planned: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for window_index, window in enumerate(review_windows, start=1):
        review_id = str(window.get("id", f"review-window-{window_index:06d}"))
        if not review_id or review_id in seen_ids:
            raise ValueError(f"review window {window_index} has an invalid or duplicate id")
        seen_ids.add(review_id)
        start_seconds = float(window["startSeconds"])
        end_seconds = float(window["endSeconds"])
        if not math.isfinite(start_seconds) or not math.isfinite(end_seconds):
            raise ValueError("review window boundaries must be finite")
        start_seconds = min(duration_seconds, max(0.0, start_seconds))
        end_seconds = min(duration_seconds, max(0.0, end_seconds))
        if end_seconds <= start_seconds:
            raise ValueError(f"review window {window_index} must have positive duration")

        explicit_samples = window.get("samples")
        if explicit_samples is None:
            span_seconds = end_seconds - start_seconds
            samples = [
                {
                    "index": sample_index,
                    "timeSeconds": round(
                        start_seconds
                        + span_seconds * sample_index / (samples_per_window - 1),
                        9,
                    ),
                }
                for sample_index in range(samples_per_window)
            ]
        else:
            if not isinstance(explicit_samples, list) or len(explicit_samples) != samples_per_window:
                raise ValueError(
                    f"review window {review_id} must provide exactly {samples_per_window} samples"
                )
            samples = []
            for sample_index, sample in enumerate(explicit_samples):
                if not isinstance(sample, Mapping) or int(sample.get("index", -1)) != sample_index:
                    raise ValueError(f"review window {review_id} sample indices must be 0..4")
                time_seconds = float(sample["timeSeconds"])
                if not math.isfinite(time_seconds) or not 0 <= time_seconds <= duration_seconds:
                    raise ValueError(f"review window {review_id} has an invalid sample time")
                normalized = {
                    "index": sample_index,
                    "timeSeconds": round(time_seconds, 9),
                }
                if "frameIndex" in sample:
                    normalized["plannedFrameIndex"] = int(sample["frameIndex"])
                samples.append(normalized)
            if any(
                current["timeSeconds"] <= previous["timeSeconds"]
                for previous, current in zip(samples, samples[1:])
            ):
                raise ValueError(f"review window {review_id} sample times must increase")
            if not math.isclose(samples[0]["timeSeconds"], start_seconds, abs_tol=1e-9):
                raise ValueError(f"review window {review_id} start does not match its first sample")
            if not math.isclose(samples[-1]["timeSeconds"], end_seconds, abs_tol=1e-9):
                raise ValueError(f"review window {review_id} end does not match its last sample")

        planned_window = {
            "id": review_id,
            "startSeconds": start_seconds,
            "endSeconds": end_seconds,
            "candidateIds": [str(value) for value in window.get("candidateIds", [])],
            "samples": samples,
        }
        if "parentReviewWindowId" in window:
            planned_window["parentReviewWindowId"] = str(window["parentReviewWindowId"])
        if "observationTargets" in window:
            targets = window["observationTargets"]
            if not isinstance(targets, list) or any(
                not isinstance(target, Mapping) for target in targets
            ):
                raise ValueError(
                    f"review window {review_id} observationTargets must be an array of objects"
                )
            planned_window["observationTargets"] = [dict(target) for target in targets]
        planned.append(planned_window)
    return planned


def plan_target_sequence_frames(
    *,
    anchor_frame_index: int,
    frame_count: int,
    samples: int = TARGET_SEQUENCE_SAMPLES,
    frame_step: int = TARGET_SEQUENCE_FRAME_STEP,
) -> list[int]:
    """Plan a centered fixed-step sequence, spilling at source boundaries."""

    if samples != TARGET_SEQUENCE_SAMPLES:
        raise ValueError(f"target sequences require exactly {TARGET_SEQUENCE_SAMPLES} samples")
    if frame_step != TARGET_SEQUENCE_FRAME_STEP:
        raise ValueError(
            f"target sequence frame step must be {TARGET_SEQUENCE_FRAME_STEP}"
        )
    if frame_count <= 0:
        raise ValueError("source frame count must be positive")
    if not 0 <= anchor_frame_index < frame_count:
        raise ValueError("target anchor frame falls outside the source")

    left_steps = anchor_frame_index // frame_step
    right_steps = (frame_count - 1 - anchor_frame_index) // frame_step
    minimum_start = max(-left_steps, -(samples - 1))
    maximum_start = min(right_steps - (samples - 1), 0)
    if minimum_start > maximum_start:
        raise ValueError(
            "source does not contain five unique fixed-step frames around the target anchor"
        )
    preferred_start = -(samples // 2)
    start = min(max(preferred_start, minimum_start), maximum_start)
    return [
        anchor_frame_index + (start + sample_index) * frame_step
        for sample_index in range(samples)
    ]


def plan_overview_samples(
    *, duration_seconds: float, interval_seconds: float = OVERVIEW_INTERVAL_SECONDS
) -> list[dict[str, Any]]:
    """Plan one overview frame at zero and at each full interval before EOF."""

    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("duration must be a positive finite number")
    if not math.isfinite(interval_seconds) or interval_seconds <= 0:
        raise ValueError("overview interval must be a positive finite number")

    count = max(1, int(math.ceil(duration_seconds / interval_seconds)))
    return [
        {
            "index": index,
            "timeSeconds": round(index * interval_seconds, 9),
        }
        for index in range(count)
    ]


def _normalize_frame(frame: np.ndarray) -> np.ndarray:
    if frame.ndim == 2:
        frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
    elif frame.ndim == 3 and frame.shape[2] == 4:
        frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
    elif frame.ndim != 3 or frame.shape[2] != 3:
        raise ValueError(f"unsupported frame shape: {frame.shape}")
    if frame.size == 0:
        raise ValueError("frame must not be empty")

    source_height, source_width = frame.shape[:2]
    scale = min(FRAME_WIDTH / source_width, FRAME_HEIGHT / source_height)
    target_width = max(1, min(FRAME_WIDTH, round(source_width * scale)))
    target_height = max(1, min(FRAME_HEIGHT, round(source_height * scale)))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    resized = cv2.resize(frame, (target_width, target_height), interpolation=interpolation)
    canvas = np.zeros((FRAME_HEIGHT, FRAME_WIDTH, 3), dtype=np.uint8)
    x = (FRAME_WIDTH - target_width) // 2
    y = (FRAME_HEIGHT - target_height) // 2
    canvas[y : y + target_height, x : x + target_width] = resized
    return canvas


def format_timecode(time_seconds: float) -> str:
    if not math.isfinite(time_seconds) or time_seconds < 0:
        raise ValueError("timecode must be a non-negative finite number")
    milliseconds = int(round(time_seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def _compose_labeled_tile(frame: np.ndarray, time_seconds: float) -> np.ndarray:
    tile = np.zeros((FRAME_HEIGHT + TIMECODE_HEIGHT, FRAME_WIDTH, 3), dtype=np.uint8)
    tile[:FRAME_HEIGHT] = _normalize_frame(frame)
    cv2.putText(
        tile,
        format_timecode(time_seconds),
        (7, FRAME_HEIGHT + 17),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.45,
        (235, 235, 235),
        1,
        cv2.LINE_AA,
    )
    return tile


def compose_review_strip(
    frames: Sequence[np.ndarray], sample_times_seconds: Sequence[float]
) -> np.ndarray:
    """Compose exactly five timecoded frames into a fixed-size horizontal strip."""

    if len(frames) != SAMPLES_PER_REVIEW_WINDOW:
        raise ValueError(f"review strip requires {SAMPLES_PER_REVIEW_WINDOW} frames")
    if len(sample_times_seconds) != len(frames):
        raise ValueError("frame and timecode counts must match")
    return np.concatenate(
        [
            _compose_labeled_tile(frame, float(time_seconds))
            for frame, time_seconds in zip(frames, sample_times_seconds)
        ],
        axis=1,
    )


def compose_overview_contact_sheet(
    frames: Sequence[np.ndarray],
    sample_times_seconds: Sequence[float],
    *,
    columns: int = OVERVIEW_COLUMNS,
    rows: int = OVERVIEW_ROWS,
) -> np.ndarray:
    """Compose a fixed-grid overview page, padding the final page with black tiles."""

    if columns <= 0 or rows <= 0:
        raise ValueError("overview grid dimensions must be positive")
    if len(frames) != len(sample_times_seconds):
        raise ValueError("frame and timecode counts must match")
    capacity = columns * rows
    if not frames or len(frames) > capacity:
        raise ValueError(f"overview page requires between 1 and {capacity} frames")

    tile_height = FRAME_HEIGHT + TIMECODE_HEIGHT
    sheet = np.zeros((tile_height * rows, FRAME_WIDTH * columns, 3), dtype=np.uint8)
    for index, (frame, time_seconds) in enumerate(zip(frames, sample_times_seconds)):
        row, column = divmod(index, columns)
        y = row * tile_height
        x = column * FRAME_WIDTH
        sheet[y : y + tile_height, x : x + FRAME_WIDTH] = _compose_labeled_tile(
            frame, float(time_seconds)
        )
    return sheet


def classify_camera_family_candidate(transform: Mapping[str, Any]) -> str | None:
    """Conservatively classify a robust affine estimate as a camera-motion candidate."""

    if not bool(transform.get("resolved")):
        return None
    tracked_points = int(transform.get("trackedPoints") or 0)
    inlier_ratio = float(transform.get("inlierRatio") or 0.0)
    if tracked_points < 8 or inlier_ratio < 0.55:
        return None

    scale = transform.get("scale")
    dx_normalized = transform.get("dxNormalized")
    dy_normalized = transform.get("dyNormalized")
    rotation_degrees = transform.get("rotationDegrees")
    if any(value is None for value in (scale, dx_normalized, dy_normalized, rotation_degrees)):
        return None
    scale = float(scale)
    dx_normalized = float(dx_normalized)
    dy_normalized = float(dy_normalized)
    rotation_degrees = float(rotation_degrees)
    if not all(
        math.isfinite(value)
        for value in (scale, dx_normalized, dy_normalized, rotation_degrees)
    ):
        return None

    scale_delta = scale - 1.0
    if scale_delta >= 0.012:
        return "push_in_candidate"
    if scale_delta <= -0.012:
        return "pull_out_candidate"
    if math.hypot(dx_normalized, dy_normalized) >= 0.008 and abs(rotation_degrees) <= 2.0:
        return "pan_candidate"
    if abs(rotation_degrees) >= 1.5:
        return "rotation_candidate"
    return None


def _load_source(manifest_path: Path, source_id: str) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != "corpus-manifest-v1":
        raise ValueError("unsupported corpus manifest schema")
    matches = [source for source in manifest.get("sources", []) if source.get("id") == source_id]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one source with id {source_id!r}")
    return matches[0]


def _load_candidate_events(analysis_directory: Path, source_id: str) -> dict[str, Any]:
    path = analysis_directory / "candidate-events.json"
    if not path.is_file():
        raise FileNotFoundError(path)
    candidates = json.loads(path.read_text(encoding="utf-8"))
    if candidates.get("schemaVersion") != "candidate-events-v1":
        raise ValueError("unsupported candidate-events schema")
    if candidates.get("sourceId") != source_id:
        raise ValueError("candidate-events source does not match the requested source")
    if not isinstance(candidates.get("reviewWindows"), list):
        raise ValueError("candidate-events reviewWindows must be an array")
    return candidates


def _load_review_unit_plan(
    path: Path,
    *,
    candidates: Mapping[str, Any],
    source: Mapping[str, Any],
    source_id: str,
) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(path)
    plan = json.loads(path.read_text(encoding="utf-8"))
    if plan.get("schemaVersion") != "review-unit-plan-v1":
        raise ValueError("unsupported review-unit plan schema")
    if plan.get("sourceId") != source_id:
        raise ValueError("review-unit plan source does not match the requested source")
    if plan.get("analysisDigest") != candidates.get("analysisDigest"):
        raise ValueError("review-unit plan analysisDigest does not match candidate-events")
    units = plan.get("units")
    if not isinstance(units, list) or not units:
        raise ValueError("review-unit plan units must be a non-empty array")
    candidate_ids = [str(event.get("id", "")) for event in candidates.get("events", [])]
    planned_ids = [str(value) for unit in units for value in unit.get("candidateIds", [])]
    if Counter(planned_ids) != Counter(candidate_ids):
        raise ValueError("review-unit plan must reference every candidate exactly once")
    report = build_sampling_adequacy_report(candidates, source, plan)
    if report["status"] != "passed":
        raise ValueError("review-unit plan does not pass sampling adequacy audit")
    return plan


def _stream_frame_count(source: Mapping[str, Any], fps: float) -> int:
    video = source["video"]
    explicit_count = video.get("frameCount", video.get("nbFrames"))
    if explicit_count is not None:
        count = int(explicit_count)
    else:
        duration = float(video.get("duration", source["formatDurationSeconds"]))
        count = int(math.ceil(duration * fps - 1e-9))
    if count <= 0:
        raise ValueError("source video resolves to zero frames")
    return count


def _attach_frame_indices(
    review_windows: list[dict[str, Any]],
    overview_samples: list[dict[str, Any]],
    *,
    source: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    fps_record = source["video"]["fps"]
    fps = float(fps_record["numerator"]) / float(fps_record["denominator"])
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("source FPS must be positive and finite")
    start_seconds = float(source["video"].get("start", 0.0))
    frame_count = _stream_frame_count(source, fps)

    def enrich(sample: Mapping[str, Any]) -> dict[str, Any]:
        requested = float(sample["timeSeconds"])
        relative = max(0.0, requested - start_seconds)
        frame_index = min(frame_count - 1, max(0, int(math.floor(relative * fps + 0.5))))
        planned_frame_index = sample.get("plannedFrameIndex")
        if planned_frame_index is not None and int(planned_frame_index) != frame_index:
            raise ValueError(
                f"planned frame {planned_frame_index} does not match resolved frame {frame_index}"
            )
        return {
            **{key: value for key, value in sample.items() if key != "plannedFrameIndex"},
            "requestedTimeSeconds": requested,
            "frameIndex": frame_index,
            "decodedTimeSeconds": round(start_seconds + frame_index / fps, 9),
        }

    enriched_windows = [
        {
            **window,
            "samples": [enrich(sample) for sample in window["samples"]],
        }
        for window in review_windows
    ]
    return enriched_windows, [enrich(sample) for sample in overview_samples]


def _plan_target_sequences(
    review_windows: Sequence[Mapping[str, Any]],
    *,
    source: Mapping[str, Any],
) -> list[dict[str, Any]]:
    fps_record = source["video"]["fps"]
    fps = float(fps_record["numerator"]) / float(fps_record["denominator"])
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("source FPS must be positive and finite")
    start_seconds = float(source["video"].get("start", 0.0))
    frame_count = _stream_frame_count(source, fps)
    planned: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()
    for window in review_windows:
        review_window_id = str(window["id"])
        for target in window.get("observationTargets", []):
            target_id = str(target.get("id", ""))
            key = (review_window_id, target_id)
            if not target_id or key in seen_keys:
                raise ValueError(
                    f"review window {review_window_id} has an empty or duplicate target id"
                )
            seen_keys.add(key)
            anchor_frame_index = int(target["anchorFrameIndex"])
            frame_indices = plan_target_sequence_frames(
                anchor_frame_index=anchor_frame_index,
                frame_count=frame_count,
            )
            samples = []
            for sample_index, frame_index in enumerate(frame_indices):
                decoded_time_seconds = round(start_seconds + frame_index / fps, 9)
                samples.append(
                    {
                        "sampleIndex": sample_index,
                        "frameOffset": frame_index - anchor_frame_index,
                        "requestedTimeSeconds": decoded_time_seconds,
                        "decodedTimeSeconds": decoded_time_seconds,
                        "frameIndex": frame_index,
                    }
                )
            planned.append(
                {
                    "reviewWindowId": review_window_id,
                    "targetId": target_id,
                    "targetProvenance": dict(target),
                    "samples": samples,
                }
            )
    return planned


def _select_filter(frame_indices: Sequence[int]) -> str:
    if not frame_indices:
        raise ValueError("at least one frame must be selected")
    expression = "+".join(f"eq(n\\,{frame_index})" for frame_index in frame_indices)
    return (
        f"select='{expression}',"
        f"scale=w={FRAME_WIDTH}:h={FRAME_HEIGHT}:"
        "force_original_aspect_ratio=decrease:flags=area,"
        f"pad={FRAME_WIDTH}:{FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,"
        "format=bgr24"
    )


def _partition_frame_indices(
    frame_indices: Sequence[int],
    *,
    maximum_filter_bytes: int = MAXIMUM_SELECTION_FILTER_BYTES,
) -> list[list[int]]:
    """Keep each FFmpeg expression below its practical parser-size limit."""

    ordered_indices = sorted(set(int(value) for value in frame_indices))
    if not ordered_indices:
        raise ValueError("at least one frame must be selected")
    if any(value < 0 for value in ordered_indices):
        raise ValueError("frame indices must be non-negative")
    if maximum_filter_bytes <= 0:
        raise ValueError("maximum filter bytes must be positive")

    fixed_bytes = len(_select_filter([0]).encode("utf-8")) - len("eq(n\\,0)")
    chunks: list[list[int]] = []
    current: list[int] = []
    expression_bytes = 0
    for frame_index in ordered_indices:
        origin = current[0] if current else frame_index
        relative_index = frame_index - origin
        term_bytes = len(f"eq(n\\,{relative_index})".encode("utf-8"))
        separator_bytes = 1 if current else 0
        projected_bytes = fixed_bytes + expression_bytes + separator_bytes + term_bytes
        if current and projected_bytes > maximum_filter_bytes:
            chunks.append(current)
            current = [frame_index]
            expression_bytes = len("eq(n\\,0)".encode("utf-8"))
            continue
        if projected_bytes > maximum_filter_bytes:
            raise ValueError("maximum filter bytes cannot hold one frame selector")
        current.append(frame_index)
        expression_bytes += separator_bytes + term_bytes

    if current:
        chunks.append(current)
    return chunks


def _read_exact(stream: BinaryIO, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def stream_selected_frames(
    video_path: Path,
    frame_indices: Sequence[int],
    consumer: Callable[[int, np.ndarray], None],
    *,
    temporary_directory: Path,
    fps_numerator: int,
    fps_denominator: int,
    maximum_filter_bytes: int = MAXIMUM_SELECTION_FILTER_BYTES,
) -> int:
    """Decode selected frames in ordered, accurately sought FFmpeg chunks."""

    if fps_numerator <= 0 or fps_denominator <= 0:
        raise ValueError("source FPS numerator and denominator must be positive")
    chunks = _partition_frame_indices(
        frame_indices,
        maximum_filter_bytes=maximum_filter_bytes,
    )
    temporary_directory.mkdir(parents=True, exist_ok=True)
    for pass_index, chunk in enumerate(chunks, start=1):
        origin = chunk[0]
        relative_indices = [frame_index - origin for frame_index in chunk]
        filter_handle = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=f".review-select-{pass_index:03d}-",
            suffix=".tmp",
            dir=temporary_directory,
            delete=False,
        )
        filter_path = Path(filter_handle.name)
        try:
            with filter_handle:
                filter_handle.write(_select_filter(relative_indices))

            seek_seconds = origin * fps_denominator / fps_numerator
            with tempfile.TemporaryFile() as error_log:
                process = subprocess.Popen(
                    [
                        "ffmpeg",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-nostdin",
                        "-ss",
                        f"{seek_seconds:.12f}",
                        "-i",
                        str(video_path),
                        "-map",
                        "0:v:0",
                        "-filter_script:v",
                        str(filter_path),
                        "-an",
                        "-fps_mode",
                        "passthrough",
                        "-pix_fmt",
                        "bgr24",
                        "-f",
                        "rawvideo",
                        "pipe:1",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=error_log,
                )
                assert process.stdout is not None
                frame_byte_count = FRAME_WIDTH * FRAME_HEIGHT * 3
                decode_error: Exception | None = None
                try:
                    for frame_index in chunk:
                        payload = _read_exact(process.stdout, frame_byte_count)
                        if len(payload) != frame_byte_count:
                            raise RuntimeError(
                                f"FFmpeg pass {pass_index} ended before selected frame "
                                f"{frame_index}; received {len(payload)} of "
                                f"{frame_byte_count} bytes"
                            )
                        frame = np.frombuffer(payload, dtype=np.uint8).reshape(
                            FRAME_HEIGHT, FRAME_WIDTH, 3
                        )
                        consumer(frame_index, frame)
                    if process.stdout.read(1):
                        raise RuntimeError(
                            f"FFmpeg pass {pass_index} emitted more frames than planned"
                        )
                except Exception as error:  # preserve the first processing failure
                    decode_error = error
                    process.kill()
                finally:
                    process.stdout.close()
                    return_code = process.wait()

                error_log.seek(0)
                error_text = error_log.read().decode("utf-8", errors="replace").strip()
                if decode_error is not None:
                    decode_error.add_note(f"FFmpeg return code: {return_code}")
                    if error_text:
                        decode_error.add_note(error_text)
                    raise decode_error
                if return_code != 0:
                    raise RuntimeError(
                        f"FFmpeg review decode pass {pass_index} failed "
                        f"({return_code}): {error_text}"
                    )
        finally:
            filter_path.unlink(missing_ok=True)
    return len(chunks)


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    try:
        temporary_path.write_bytes(payload)
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _write_jpeg(path: Path, image: np.ndarray) -> None:
    encoded, payload = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not encoded:
        raise RuntimeError(f"could not encode JPEG: {path}")
    _atomic_write_bytes(path, payload.tobytes())


def _atomic_write_json(path: Path, value: Any) -> None:
    payload = (
        json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    _atomic_write_bytes(path, payload)


def _atomic_write_jsonl(path: Path, records: Sequence[Mapping[str, Any]]) -> None:
    payload = "".join(
        json.dumps(
            record,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
        for record in records
    ).encode("utf-8")
    _atomic_write_bytes(path, payload)


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


def _sample_reference(sample: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "sampleIndex": int(sample["index"]),
        "requestedTimeSeconds": float(sample["requestedTimeSeconds"]),
        "decodedTimeSeconds": float(sample["decodedTimeSeconds"]),
        "frameIndex": int(sample["frameIndex"]),
    }


def generate_review_assets(
    *,
    manifest_path: Path,
    source_id: str,
    analysis_directory: Path,
    output_directory: Path,
    review_unit_plan_path: Path | None = None,
) -> dict[str, Any]:
    source = _load_source(manifest_path, source_id)
    candidates = _load_candidate_events(analysis_directory, source_id)
    video_path = Path(source["mp4"]["path"])
    if not video_path.is_file():
        raise FileNotFoundError(video_path)

    duration_seconds = float(source["formatDurationSeconds"])
    review_unit_plan = (
        _load_review_unit_plan(
            review_unit_plan_path,
            candidates=candidates,
            source=source,
            source_id=source_id,
        )
        if review_unit_plan_path is not None
        else None
    )
    review_windows = plan_review_samples(
        review_unit_plan["units"] if review_unit_plan is not None else candidates["reviewWindows"],
        duration_seconds=duration_seconds,
    )
    overview_samples = plan_overview_samples(duration_seconds=duration_seconds)
    review_windows, overview_samples = _attach_frame_indices(
        review_windows, overview_samples, source=source
    )
    target_sequences = _plan_target_sequences(review_windows, source=source)

    output_directory.mkdir(parents=True, exist_ok=True)
    strips_directory = output_directory / "review-strips"
    review_frames_directory = output_directory / "review-frames"
    target_sequences_directory = output_directory / "target-sequences"
    overview_directory = output_directory / "overview"
    window_references: dict[int, list[tuple[int, int]]] = {}
    target_references: dict[int, list[tuple[int, int]]] = {}
    overview_references: dict[int, list[int]] = {}
    for window_index, window in enumerate(review_windows):
        for sample_index, sample in enumerate(window["samples"]):
            window_references.setdefault(int(sample["frameIndex"]), []).append(
                (window_index, sample_index)
            )
    for sequence_index, sequence in enumerate(target_sequences):
        for sample_index, sample in enumerate(sequence["samples"]):
            target_references.setdefault(int(sample["frameIndex"]), []).append(
                (sequence_index, sample_index)
            )
    for overview_index, sample in enumerate(overview_samples):
        overview_references.setdefault(int(sample["frameIndex"]), []).append(overview_index)

    selected_indices = sorted(
        {*window_references, *target_references, *overview_references}
    )
    window_buffers: dict[int, dict[int, np.ndarray]] = {}
    target_buffers: dict[int, dict[int, np.ndarray]] = {}
    overview_frames: list[np.ndarray | None] = [None] * len(overview_samples)
    review_strip_artifacts: list[dict[str, Any]] = []
    target_sequence_artifacts: list[dict[str, Any]] = []
    fine_evidence: list[dict[str, Any]] = []

    def consume_frame(frame_index: int, frame: np.ndarray) -> None:
        for overview_index in overview_references.get(frame_index, []):
            overview_frames[overview_index] = frame.copy()

        touched_windows: set[int] = set()
        for window_index, sample_index in window_references.get(frame_index, []):
            window_buffers.setdefault(window_index, {})[sample_index] = frame.copy()
            touched_windows.add(window_index)

        for window_index in sorted(touched_windows):
            buffer = window_buffers[window_index]
            window = review_windows[window_index]
            if len(buffer) != len(window["samples"]):
                continue
            frames = [buffer[index] for index in range(len(window["samples"]))]
            sample_times = [
                float(sample["requestedTimeSeconds"]) for sample in window["samples"]
            ]
            review_frame_artifacts = []
            for sample_index, (frame, sample) in enumerate(
                zip(frames, window["samples"]), start=1
            ):
                frame_path = (
                    review_frames_directory
                    / f"{window['id']}-frame-{sample_index:02d}.jpg"
                )
                _write_jpeg(
                    frame_path,
                    _compose_labeled_tile(
                        frame, float(sample["requestedTimeSeconds"])
                    ),
                )
                review_frame_artifacts.append(
                    {
                        **_sample_reference(sample),
                        **_artifact_record(frame_path),
                    }
                )
            strip_path = strips_directory / f"{window['id']}.jpg"
            _write_jpeg(strip_path, compose_review_strip(frames, sample_times))
            review_strip_artifacts.append(
                {
                    "reviewWindowId": window["id"],
                    **(
                        {"parentReviewWindowId": window["parentReviewWindowId"]}
                        if "parentReviewWindowId" in window
                        else {}
                    ),
                    "startSeconds": window["startSeconds"],
                    "endSeconds": window["endSeconds"],
                    "candidateIds": window["candidateIds"],
                    "samples": review_frame_artifacts,
                    **_artifact_record(strip_path),
                }
            )

            for pair_index, (previous, current) in enumerate(zip(frames, frames[1:]), start=1):
                frame_features = compute_frame_features(previous, current)
                camera_transform = estimate_camera_transform(previous, current)
                fine_evidence.append(
                    {
                        "schemaVersion": "fine-evidence-v1",
                        "id": f"{source_id}-{window['id']}-pair-{pair_index:02d}",
                        "sourceId": source_id,
                        "analysisDigest": candidates.get("analysisDigest"),
                        "reviewWindowId": window["id"],
                        **(
                            {"parentReviewWindowId": window["parentReviewWindowId"]}
                            if "parentReviewWindowId" in window
                            else {}
                        ),
                        "candidateIds": window["candidateIds"],
                        "pairIndex": pair_index,
                        "previousFrame": _sample_reference(window["samples"][pair_index - 1]),
                        "currentFrame": _sample_reference(window["samples"][pair_index]),
                        "frameFeatures": frame_features,
                        "cameraTransform": camera_transform,
                        "cameraFamilyCandidate": classify_camera_family_candidate(
                            camera_transform
                        ),
                    }
                )
            del window_buffers[window_index]

        touched_sequences: set[int] = set()
        for sequence_index, sample_index in target_references.get(frame_index, []):
            target_buffers.setdefault(sequence_index, {})[sample_index] = frame.copy()
            touched_sequences.add(sequence_index)

        for sequence_index in sorted(touched_sequences):
            buffer = target_buffers[sequence_index]
            sequence = target_sequences[sequence_index]
            if len(buffer) != len(sequence["samples"]):
                continue
            target_frame_artifacts = []
            for sample_position, sample in enumerate(sequence["samples"], start=1):
                target_path = (
                    target_sequences_directory
                    / sequence["reviewWindowId"]
                    / f"{sequence['targetId']}-frame-{sample_position:02d}.jpg"
                )
                _write_jpeg(
                    target_path,
                    _compose_labeled_tile(
                        buffer[sample_position - 1],
                        float(sample["decodedTimeSeconds"]),
                    ),
                )
                target_frame_artifacts.append(
                    {
                        **sample,
                        **_artifact_record(target_path),
                    }
                )
            target_sequence_artifacts.append(
                {
                    "reviewWindowId": sequence["reviewWindowId"],
                    "targetId": sequence["targetId"],
                    "targetProvenance": sequence["targetProvenance"],
                    "samples": target_frame_artifacts,
                }
            )
            del target_buffers[sequence_index]

    fps_record = source["video"]["fps"]
    decode_passes = stream_selected_frames(
        video_path,
        selected_indices,
        consume_frame,
        temporary_directory=output_directory,
        fps_numerator=int(fps_record["numerator"]),
        fps_denominator=int(fps_record["denominator"]),
    )
    if window_buffers:
        missing = ", ".join(review_windows[index]["id"] for index in sorted(window_buffers))
        raise RuntimeError(f"review windows did not receive every frame: {missing}")
    if target_buffers:
        missing = ", ".join(
            f"{target_sequences[index]['reviewWindowId']}:{target_sequences[index]['targetId']}"
            for index in sorted(target_buffers)
        )
        raise RuntimeError(f"target sequences did not receive every frame: {missing}")
    if any(frame is None for frame in overview_frames):
        raise RuntimeError("overview did not receive every planned frame")

    review_strip_artifacts.sort(key=lambda record: record["reviewWindowId"])
    target_sequence_artifacts.sort(
        key=lambda record: (record["reviewWindowId"], record["targetId"])
    )
    overview_artifacts: list[dict[str, Any]] = []
    page_capacity = OVERVIEW_COLUMNS * OVERVIEW_ROWS
    for page_start in range(0, len(overview_samples), page_capacity):
        page_number = page_start // page_capacity + 1
        page_samples = overview_samples[page_start : page_start + page_capacity]
        page_frames = overview_frames[page_start : page_start + page_capacity]
        concrete_frames = [frame for frame in page_frames if frame is not None]
        page_path = overview_directory / f"overview-{page_number:04d}.jpg"
        _write_jpeg(
            page_path,
            compose_overview_contact_sheet(
                concrete_frames,
                [float(sample["requestedTimeSeconds"]) for sample in page_samples],
            ),
        )
        overview_artifacts.append(
            {
                "page": page_number,
                "startSeconds": page_samples[0]["requestedTimeSeconds"],
                "endSeconds": page_samples[-1]["requestedTimeSeconds"],
                "samples": [_sample_reference(sample) for sample in page_samples],
                **_artifact_record(page_path),
            }
        )

    fine_evidence.sort(key=lambda record: (record["reviewWindowId"], record["pairIndex"]))
    fine_evidence_path = output_directory / "fine-evidence.jsonl"
    _atomic_write_jsonl(fine_evidence_path, fine_evidence)

    result = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "complete",
        "sourceId": source_id,
        "analysisDigest": candidates.get("analysisDigest"),
        "outputDirectory": str(output_directory.resolve()),
        "configuration": {
            "reviewSamplesPerWindow": SAMPLES_PER_REVIEW_WINDOW,
            "targetSequenceSamples": TARGET_SEQUENCE_SAMPLES,
            "targetSequenceFrameStep": TARGET_SEQUENCE_FRAME_STEP,
            "overviewIntervalSeconds": OVERVIEW_INTERVAL_SECONDS,
            "frameWidth": FRAME_WIDTH,
            "frameHeight": FRAME_HEIGHT,
            "timecodeHeight": TIMECODE_HEIGHT,
            "overviewColumns": OVERVIEW_COLUMNS,
            "overviewRows": OVERVIEW_ROWS,
            "maximumSelectionFilterBytes": MAXIMUM_SELECTION_FILTER_BYTES,
        },
        "inputs": {
            "corpusManifest": _artifact_record(manifest_path),
            "videoPath": str(video_path.resolve()),
            "candidateEvents": _artifact_record(analysis_directory / "candidate-events.json"),
            **(
                {"reviewUnitPlan": _artifact_record(review_unit_plan_path)}
                if review_unit_plan_path is not None
                else {}
            ),
        },
        "counts": {
            "parentReviewWindows": len(candidates["reviewWindows"]),
            "reviewUnits": len(review_windows),
            "reviewWindows": len(review_windows),
            "reviewSamples": sum(len(window["samples"]) for window in review_windows),
            "reviewFrames": sum(
                len(strip["samples"]) for strip in review_strip_artifacts
            ),
            "targetSequences": len(target_sequence_artifacts),
            "targetSequenceSamples": sum(
                len(sequence["samples"]) for sequence in target_sequences
            ),
            "targetFrames": sum(
                len(sequence["samples"]) for sequence in target_sequence_artifacts
            ),
            "overviewSamples": len(overview_samples),
            "decodedUniqueFrames": len(selected_indices),
            "reviewStrips": len(review_strip_artifacts),
            "overviewContactSheets": len(overview_artifacts),
            "fineEvidenceRecords": len(fine_evidence),
            "ffmpegDecodePasses": decode_passes,
        },
        "artifacts": {
            "fineEvidence": _artifact_record(fine_evidence_path),
            "reviewStrips": review_strip_artifacts,
            "targetSequences": target_sequence_artifacts,
            "overviewContactSheets": overview_artifacts,
        },
    }
    _atomic_write_json(output_directory / "review-assets-manifest.json", result)
    return result


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate review strips, overview sheets, and observable fine evidence."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("docs/editorial-grammar/corpus-manifest.json"),
    )
    parser.add_argument("--source", required=True)
    parser.add_argument("--analysis-directory", type=Path, required=True)
    parser.add_argument("--output-directory", type=Path, required=True)
    parser.add_argument("--review-unit-plan", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_argument_parser().parse_args(argv)
    result = generate_review_assets(
        manifest_path=arguments.manifest,
        source_id=arguments.source,
        analysis_directory=arguments.analysis_directory,
        output_directory=arguments.output_directory,
        review_unit_plan_path=arguments.review_unit_plan,
    )
    print(
        json.dumps(
            {
                "schemaVersion": "review-assets-summary-v1",
                "status": result["status"],
                "sourceId": result["sourceId"],
                "outputDirectory": result["outputDirectory"],
                "counts": result["counts"],
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
