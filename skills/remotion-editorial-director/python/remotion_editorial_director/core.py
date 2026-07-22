"""Deterministic primitives shared by the editorial-analysis scripts.

The analysis pipeline keeps source timing in seconds while deriving frame-exact,
half-open coverage intervals for each video's native frame rate.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from decimal import Decimal, ROUND_HALF_UP
from typing import Any


_TIMESTAMP_RE = re.compile(
    r"^(?P<hours>\d{1,3}):(?P<minutes>\d{2}):(?P<seconds>\d{2})"
    r"[,.](?P<milliseconds>\d{3})$"
)


def _parse_timestamp(value: str) -> float:
    match = _TIMESTAMP_RE.fullmatch(value.strip())
    if match is None:
        raise ValueError(f"invalid SRT timestamp: {value!r}")

    hours = int(match.group("hours"))
    minutes = int(match.group("minutes"))
    seconds = int(match.group("seconds"))
    milliseconds = int(match.group("milliseconds"))
    if minutes >= 60 or seconds >= 60:
        raise ValueError(f"invalid SRT timestamp: {value!r}")

    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000


def parse_srt(text: str, *, media_duration_seconds: float) -> list[dict[str, Any]]:
    """Parse SRT text and clamp cues to the authoritative media duration."""

    if not math.isfinite(media_duration_seconds) or media_duration_seconds <= 0:
        raise ValueError("media duration must be a positive finite number")

    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []

    cues: list[dict[str, Any]] = []
    for block_number, block in enumerate(re.split(r"\n[ \t]*\n", normalized), start=1):
        lines = block.split("\n")
        if len(lines) < 2:
            raise ValueError(f"malformed SRT block {block_number}")

        if "-->" in lines[0]:
            cue_index = block_number
            timing_line = lines[0]
            text_lines = lines[1:]
        else:
            try:
                cue_index = int(lines[0].strip())
            except ValueError as error:
                raise ValueError(f"invalid SRT cue index in block {block_number}") from error
            timing_line = lines[1]
            text_lines = lines[2:]

        timing_parts = re.split(r"\s*-->\s*", timing_line.strip())
        if len(timing_parts) != 2:
            raise ValueError(f"invalid SRT timing line in block {block_number}")

        original_start = _parse_timestamp(timing_parts[0].split()[0])
        original_end = _parse_timestamp(timing_parts[1].split()[0])
        start = max(0.0, original_start)
        end = min(media_duration_seconds, original_end)
        if end <= start:
            raise ValueError(
                f"cue {cue_index} has non-positive duration after clamping: {start:.6f}..{end:.6f}"
            )

        clamp_reasons: list[str] = []
        if start != original_start:
            clamp_reasons.append("media_start")
        if end != original_end:
            clamp_reasons.append("media_end")

        cues.append(
            {
                "id": f"cue-{cue_index}",
                "index": cue_index,
                "startSeconds": start,
                "endSeconds": end,
                "text": "\n".join(text_lines).strip(),
                "clampReason": "+".join(clamp_reasons) if clamp_reasons else None,
            }
        )

    return cues


def non_max_suppression(
    events: Iterable[Mapping[str, Any]], *, min_spacing_seconds: float
) -> list[dict[str, Any]]:
    """Keep the strongest event in each temporal neighbourhood."""

    if not math.isfinite(min_spacing_seconds) or min_spacing_seconds < 0:
        raise ValueError("minimum spacing must be a non-negative finite number")

    normalized: list[dict[str, Any]] = []
    for event in events:
        candidate = dict(event)
        time_seconds = float(candidate["timeSeconds"])
        score = float(candidate["score"])
        if not math.isfinite(time_seconds) or not math.isfinite(score):
            raise ValueError("event time and score must be finite")
        candidate["timeSeconds"] = time_seconds
        candidate["score"] = score
        normalized.append(candidate)

    selected: list[dict[str, Any]] = []
    for candidate in sorted(
        normalized,
        key=lambda event: (-event["score"], event["timeSeconds"]),
    ):
        if all(
            abs(candidate["timeSeconds"] - accepted["timeSeconds"]) >= min_spacing_seconds
            for accepted in selected
        ):
            selected.append(candidate)

    return sorted(selected, key=lambda event: event["timeSeconds"])


def _seconds_to_frame(seconds: float, fps_numerator: int, fps_denominator: int) -> int:
    frames = Decimal(str(seconds)) * Decimal(fps_numerator) / Decimal(fps_denominator)
    return int(frames.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def build_coverage(
    *,
    source_id: str,
    duration_seconds: float,
    fps_numerator: int,
    fps_denominator: int,
    subtitle_cues: Sequence[Mapping[str, Any]],
    visual_event_seconds: Sequence[float],
    max_segment_seconds: float,
) -> dict[str, Any]:
    """Build contiguous native-frame intervals around cues and visual events."""

    if not source_id:
        raise ValueError("source id must not be empty")
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("duration must be a positive finite number")
    if fps_numerator <= 0 or fps_denominator <= 0:
        raise ValueError("frame-rate numerator and denominator must be positive")
    if not math.isfinite(max_segment_seconds) or max_segment_seconds <= 0:
        raise ValueError("maximum segment duration must be a positive finite number")

    end_frame = _seconds_to_frame(duration_seconds, fps_numerator, fps_denominator)
    max_segment_frames = max(
        1,
        _seconds_to_frame(max_segment_seconds, fps_numerator, fps_denominator),
    )
    if end_frame <= 0:
        raise ValueError("media duration resolves to zero frames")

    normalized_cues: list[dict[str, Any]] = []
    anchors = {0, end_frame}
    for cue in subtitle_cues:
        normalized_cue = dict(cue)
        start_seconds = float(normalized_cue["startSeconds"])
        end_seconds = float(normalized_cue["endSeconds"])
        if not math.isfinite(start_seconds) or not math.isfinite(end_seconds):
            raise ValueError("subtitle cue boundaries must be finite")
        start_seconds = min(duration_seconds, max(0.0, start_seconds))
        end_seconds = min(duration_seconds, max(0.0, end_seconds))
        start_frame = min(
            end_frame,
            max(0, _seconds_to_frame(start_seconds, fps_numerator, fps_denominator)),
        )
        cue_end_frame = min(
            end_frame,
            max(0, _seconds_to_frame(end_seconds, fps_numerator, fps_denominator)),
        )
        if cue_end_frame <= start_frame:
            raise ValueError(f"subtitle cue {normalized_cue.get('id', '<unknown>')} is non-positive")
        normalized_cue["startFrame"] = start_frame
        normalized_cue["endFrame"] = cue_end_frame
        normalized_cues.append(normalized_cue)

    normalized_events: list[tuple[int, float]] = []
    for event_seconds_value in visual_event_seconds:
        event_seconds = float(event_seconds_value)
        if not math.isfinite(event_seconds):
            raise ValueError("visual event times must be finite")
        event_seconds = min(duration_seconds, max(0.0, event_seconds))
        event_frame = min(
            end_frame,
            max(0, _seconds_to_frame(event_seconds, fps_numerator, fps_denominator)),
        )
        normalized_events.append((event_frame, event_seconds))
        anchors.add(event_frame)

    split_frames: list[int] = []
    ordered_anchors = sorted(anchors)
    for anchor_index, start_frame in enumerate(ordered_anchors[:-1]):
        stop_frame = ordered_anchors[anchor_index + 1]
        split_frames.append(start_frame)
        cursor = start_frame + max_segment_frames
        while cursor < stop_frame:
            split_frames.append(cursor)
            cursor += max_segment_frames
    split_frames.append(end_frame)

    intervals: list[dict[str, Any]] = []
    for start_frame, stop_frame in zip(split_frames, split_frames[1:]):
        if stop_frame <= start_frame:
            continue
        overlapping_cues = [
            cue
            for cue in normalized_cues
            if cue["startFrame"] < stop_frame and cue["endFrame"] > start_frame
        ]
        interval_events = [
            {
                "frame": event_frame,
                "timeSeconds": event_seconds,
            }
            for event_frame, event_seconds in normalized_events
            if start_frame <= event_frame < stop_frame
        ]
        intervals.append(
            {
                "startFrame": start_frame,
                "endFrame": stop_frame,
                "subtitleCues": overlapping_cues,
                "visualEvents": interval_events,
            }
        )

    semantic_anchors = {0, end_frame}
    for cue in normalized_cues:
        semantic_anchors.update((cue["startFrame"], cue["endFrame"]))
    ordered_semantic_anchors = sorted(semantic_anchors)
    semantic_intervals = []
    for start_frame, stop_frame in zip(ordered_semantic_anchors, ordered_semantic_anchors[1:]):
        if stop_frame <= start_frame:
            continue
        semantic_intervals.append(
            {
                "startFrame": start_frame,
                "endFrame": stop_frame,
                "subtitleCues": [
                    cue
                    for cue in normalized_cues
                    if cue["startFrame"] < stop_frame and cue["endFrame"] > start_frame
                ],
            }
        )

    return {
        "schemaVersion": 1,
        "sourceId": source_id,
        "sourceFps": {
            "numerator": fps_numerator,
            "denominator": fps_denominator,
        },
        "endFrame": end_frame,
        "intervals": intervals,
        "semanticIntervals": semantic_intervals,
    }


def canonical_digest(value: Any) -> str:
    """Return the SHA-256 of canonical UTF-8 JSON."""

    encoded = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
