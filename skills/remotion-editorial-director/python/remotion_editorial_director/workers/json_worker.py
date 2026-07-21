"""Line-oriented JSON boundary for provider-neutral editorial analysis.

The worker intentionally exposes deterministic analysis functions only. VLM
clients, credentials, and network calls belong to the caller and are not
loaded by this process boundary.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable


def _field(payload: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
    return default


def _payload(request: Mapping[str, Any]) -> Mapping[str, Any]:
    nested = request.get("params", request.get("arguments"))
    if nested is None:
        return request
    if not isinstance(nested, Mapping):
        raise ValueError("params must be a JSON object")
    merged = dict(request)
    merged.update(nested)
    return merged


def _parse_srt(request: Mapping[str, Any]) -> Any:
    from ..core import parse_srt

    duration = _field(
        request,
        "mediaDurationSeconds",
        "media_duration_seconds",
        "durationSeconds",
        "duration_seconds",
    )
    if duration is None:
        raise ValueError("media duration is required")
    text = request.get("text")
    if not isinstance(text, str):
        raise ValueError("SRT text must be a string")
    return parse_srt(text, media_duration_seconds=duration)


def _non_max_suppression(request: Mapping[str, Any]) -> Any:
    from ..core import non_max_suppression

    spacing = _field(request, "minSpacingSeconds", "min_spacing_seconds")
    return non_max_suppression(request.get("events", []), min_spacing_seconds=spacing)


def _build_coverage(request: Mapping[str, Any]) -> Any:
    from ..core import build_coverage

    return build_coverage(
        source_id=str(_field(request, "sourceId", "source_id", default="")),
        duration_seconds=_field(request, "durationSeconds", "duration_seconds"),
        fps_numerator=int(_field(request, "fpsNumerator", "fps_numerator")),
        fps_denominator=int(_field(request, "fpsDenominator", "fps_denominator", default=1)),
        subtitle_cues=request.get("subtitleCues", request.get("subtitle_cues", [])),
        visual_event_seconds=request.get(
            "visualEventSeconds", request.get("visual_event_seconds", [])
        ),
        max_segment_seconds=_field(request, "maxSegmentSeconds", "max_segment_seconds"),
    )


def _compute_audio_features(request: Mapping[str, Any]) -> Any:
    import numpy as np

    from ..audio import compute_audio_features

    return compute_audio_features(
        np.asarray(request.get("samples", [])),
        sample_rate=int(_field(request, "sampleRate", "sample_rate")),
        window_seconds=float(_field(request, "windowSeconds", "window_seconds", default=0.1)),
        hop_seconds=float(_field(request, "hopSeconds", "hop_seconds", default=0.05)),
    )


def _detect_audio_events(request: Mapping[str, Any]) -> Any:
    from ..audio import detect_audio_events

    return detect_audio_events(
        request.get("features", []),
        hop_seconds=float(_field(request, "hopSeconds", "hop_seconds")),
        window_seconds=_field(request, "windowSeconds", "window_seconds"),
        silence_threshold_db=float(
            _field(request, "silenceThresholdDb", "silence_threshold_db", default=-50.0)
        ),
        minimum_silence_seconds=float(
            _field(
                request,
                "minimumSilenceSeconds",
                "minimum_silence_seconds",
                default=0.35,
            )
        ),
        onset_spacing_seconds=float(
            _field(request, "onsetSpacingSeconds", "onset_spacing_seconds", default=0.3)
        ),
        baseline_window_seconds=float(
            _field(request, "baselineWindowSeconds", "baseline_window_seconds", default=60.0)
        ),
    )


def _detect_visual_events(request: Mapping[str, Any]) -> Any:
    from ..detectors import detect_visual_events

    return detect_visual_events(
        request.get("samples", []),
        sample_fps=float(_field(request, "sampleFps", "sample_fps")),
    )


def _merge_candidate_events(request: Mapping[str, Any]) -> Any:
    from ..detectors import merge_candidate_events

    return merge_candidate_events(
        request.get("events", []),
        merge_window_seconds=float(
            _field(request, "mergeWindowSeconds", "merge_window_seconds")
        ),
    )


def _review_unit_plan(request: Mapping[str, Any]) -> Any:
    from ..review_sampling import build_review_unit_plan

    return build_review_unit_plan(
        request.get("candidates", request.get("candidateEvents", {})),
        request.get("source", {}),
    )


def _sampling_adequacy(request: Mapping[str, Any]) -> Any:
    from ..review_sampling import build_sampling_adequacy_report

    return build_sampling_adequacy_report(
        request.get("candidates", request.get("candidateEvents", {})),
        request.get("source", {}),
        request.get("plan", request.get("reviewUnitPlan", {})),
    )


def _verify_artifact(request: Mapping[str, Any]) -> Any:
    from ..verification.analysis import verify_artifact_record

    return {"errors": verify_artifact_record(request.get("record", {}))}


def _verify_analysis_directory(request: Mapping[str, Any]) -> Any:
    from ..verification.analysis import verify_analysis_directory

    duration = _field(request, "durationSeconds", "duration_seconds")
    if duration is None:
        raise ValueError("duration seconds is required")
    return verify_analysis_directory(
        Path(str(_field(request, "directory", "path"))),
        duration_seconds=float(duration),
    )


def _verify_semantic_outline(request: Mapping[str, Any]) -> Any:
    from ..verification.semantic_outlines import verify_semantic_outline

    return verify_semantic_outline(
        Path(str(_field(request, "outlinePath", "outline_path"))),
        Path(str(_field(request, "subtitlesPath", "subtitles_path"))),
    )


def _verify_review_assets(request: Mapping[str, Any]) -> Any:
    from ..verification.review_assets import verify_review_assets_directory

    return verify_review_assets_directory(Path(str(_field(request, "directory", "path"))))


_OPERATIONS: dict[str, Callable[[Mapping[str, Any]], Any]] = {
    "parse_srt": _parse_srt,
    "non_max_suppression": _non_max_suppression,
    "build_coverage": _build_coverage,
    "compute_audio_features": _compute_audio_features,
    "detect_audio_events": _detect_audio_events,
    "detect_visual_events": _detect_visual_events,
    "merge_candidate_events": _merge_candidate_events,
    "build_review_unit_plan": _review_unit_plan,
    "build_sampling_adequacy_report": _sampling_adequacy,
    "verify_artifact_record": _verify_artifact,
    "verify_analysis_directory": _verify_analysis_directory,
    "verify_semantic_outline": _verify_semantic_outline,
    "verify_review_assets_directory": _verify_review_assets,
}


def handle_request(request: Mapping[str, Any]) -> dict[str, Any]:
    """Run one request and return a JSON-compatible success/error envelope."""

    if not isinstance(request, Mapping):
        raise ValueError("request must be a JSON object")
    operation = request.get("operation", request.get("op", request.get("action")))
    if not isinstance(operation, str) or not operation.strip():
        raise ValueError("request operation is required")
    normalized_operation = operation.strip().replace("-", "_").replace(".", "_")
    handler = _OPERATIONS.get(normalized_operation)
    if handler is None:
        raise ValueError(f"unsupported operation: {operation}")
    return {"ok": True, "result": handler(_payload(request))}


def _json_default(value: Any) -> Any:
    try:
        import numpy as np

        if isinstance(value, np.ndarray):
            return value.tolist()
        if isinstance(value, np.generic):
            return value.item()
    except ImportError:
        pass
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"value is not JSON serializable: {type(value).__name__}")


def _error_response(error: BaseException) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "type": type(error).__name__,
            "message": str(error),
        },
    }


def process_line(line: str) -> str:
    """Convert one input line to one output line without emitting tracebacks."""

    try:
        request = json.loads(line)
        response = handle_request(request)
    except Exception as error:  # boundary must contain every request failure
        response = _error_response(error)
    return json.dumps(
        response,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        default=_json_default,
    )


def main() -> int:
    for line in sys.stdin:
        if line.strip():
            sys.stdout.write(process_line(line) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
