"""Observable visual measurements and candidate-event detectors.

These functions deliberately emit candidates, not editorial-technique labels.
Flattened video cannot prove the original layer structure or effect settings.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from typing import Any

import cv2
import numpy as np

from core import non_max_suppression


def _as_gray(frame: np.ndarray) -> np.ndarray:
    if frame.ndim == 2:
        return frame
    if frame.ndim == 3 and frame.shape[2] == 3:
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    raise ValueError(f"expected a gray or BGR frame, got shape {frame.shape}")


def _gray_histogram(gray: np.ndarray) -> np.ndarray:
    histogram = cv2.calcHist([gray], [0], None, [64], [0, 256])
    cv2.normalize(histogram, histogram, alpha=1.0, norm_type=cv2.NORM_L1)
    return histogram


def _color_histogram(frame: np.ndarray) -> np.ndarray:
    if frame.ndim == 2:
        return _gray_histogram(frame)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0, 1], None, [36, 16], [0, 180, 0, 256])
    cv2.normalize(histogram, histogram, alpha=1.0, norm_type=cv2.NORM_L1)
    return histogram


def compute_frame_features(previous: np.ndarray, current: np.ndarray) -> dict[str, float]:
    """Measure visual change from two equal-sized frames."""

    if previous.shape != current.shape:
        raise ValueError("previous and current frames must have identical dimensions")

    previous_gray = _as_gray(previous)
    current_gray = _as_gray(current)
    pixel_diff = cv2.absdiff(previous_gray, current_gray)
    gray_histogram_distance = cv2.compareHist(
        _gray_histogram(previous_gray),
        _gray_histogram(current_gray),
        cv2.HISTCMP_BHATTACHARYYA,
    )
    color_histogram_distance = cv2.compareHist(
        _color_histogram(previous),
        _color_histogram(current),
        cv2.HISTCMP_BHATTACHARYYA,
    )
    previous_edges = cv2.Canny(previous_gray, 80, 180)
    current_edges = cv2.Canny(current_gray, 80, 180)
    edge_diff = cv2.absdiff(previous_edges, current_edges)

    height = current_gray.shape[0]
    text_region_start = max(0, int(height * 0.55))
    previous_text_region = previous_gray[text_region_start:, :]
    current_text_region = current_gray[text_region_start:, :]
    text_region_diff = cv2.absdiff(previous_text_region, current_text_region)

    return {
        "pixelDiffMean": float(np.mean(pixel_diff) / 255.0),
        "pixelDiffP95": float(np.percentile(pixel_diff, 95) / 255.0),
        "histogramDistance": float(max(gray_histogram_distance, color_histogram_distance)),
        "grayHistogramDistance": float(gray_histogram_distance),
        "colorHistogramDistance": float(color_histogram_distance),
        "lumaMean": float(np.mean(current_gray) / 255.0),
        "lumaStd": float(np.std(current_gray) / 255.0),
        "blurVariance": float(cv2.Laplacian(current_gray, cv2.CV_64F).var()),
        "edgeDensity": float(np.count_nonzero(current_edges) / current_edges.size),
        "fullFrameEdgeDiffMean": float(np.mean(edge_diff) / 255.0),
        "textRegionDiffMean": float(np.mean(text_region_diff) / 255.0),
    }


def estimate_camera_transform(previous_gray: np.ndarray, current_gray: np.ndarray) -> dict[str, Any]:
    """Estimate a robust partial affine transform from the previous frame."""

    previous = _as_gray(previous_gray)
    current = _as_gray(current_gray)
    if previous.shape != current.shape:
        raise ValueError("previous and current frames must have identical dimensions")

    points = cv2.goodFeaturesToTrack(
        previous,
        maxCorners=300,
        qualityLevel=0.01,
        minDistance=5,
        blockSize=5,
    )
    if points is None or len(points) < 6:
        return _unresolved_transform(0)

    tracked, status, _errors = cv2.calcOpticalFlowPyrLK(
        previous,
        current,
        points,
        None,
        winSize=(21, 21),
        maxLevel=3,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
    )
    if tracked is None or status is None:
        return _unresolved_transform(0)

    valid = status.reshape(-1).astype(bool)
    source_points = points.reshape(-1, 2)[valid]
    destination_points = tracked.reshape(-1, 2)[valid]
    tracked_points = len(source_points)
    if tracked_points < 6:
        return _unresolved_transform(tracked_points)

    matrix, inliers = cv2.estimateAffinePartial2D(
        source_points,
        destination_points,
        method=cv2.RANSAC,
        ransacReprojThreshold=2.0,
        maxIters=2000,
        confidence=0.99,
        refineIters=10,
    )
    if matrix is None or inliers is None:
        return _unresolved_transform(tracked_points)

    a = float(matrix[0, 0])
    b = float(matrix[1, 0])
    scale = math.hypot(a, b)
    rotation_degrees = math.degrees(math.atan2(b, a))
    dx = float(matrix[0, 2])
    dy = float(matrix[1, 2])
    inlier_mask = inliers.reshape(-1).astype(bool)

    if np.any(inlier_mask):
        transformed = cv2.transform(source_points[inlier_mask, None, :], matrix).reshape(-1, 2)
        residual = float(
            np.median(np.linalg.norm(transformed - destination_points[inlier_mask], axis=1))
        )
    else:
        residual = None

    height, width = previous.shape
    return {
        "resolved": True,
        "trackedPoints": tracked_points,
        "inlierRatio": float(np.mean(inlier_mask)),
        "dxPixels": dx,
        "dyPixels": dy,
        "dxNormalized": dx / width,
        "dyNormalized": dy / height,
        "scale": scale,
        "rotationDegrees": rotation_degrees,
        "medianResidualPixels": residual,
    }


def _unresolved_transform(tracked_points: int) -> dict[str, Any]:
    return {
        "resolved": False,
        "trackedPoints": tracked_points,
        "inlierRatio": 0.0,
        "dxPixels": None,
        "dyPixels": None,
        "dxNormalized": None,
        "dyNormalized": None,
        "scale": None,
        "rotationDegrees": None,
        "medianResidualPixels": None,
    }


def _candidate(
    sample: Mapping[str, Any],
    *,
    family: str,
    detector: str,
    score: float,
    measurements: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "timeSeconds": float(sample["timeSeconds"]),
        "family": family,
        "detector": detector,
        "score": float(min(1.0, max(0.0, score))),
        "measurements": dict(measurements),
    }


_FRAME_HEADER_RE = re.compile(
    r"frame:\s*(?P<frame>-?\d+).*?pts_time:\s*(?P<time>-?(?:\d+(?:\.\d*)?|\.\d+))"
)


def parse_ffmpeg_metadata(
    text: str,
    *,
    metadata_key: str,
    value_name: str,
) -> list[dict[str, Any]]:
    """Parse FFmpeg metadata=print output into timestamped numeric records."""

    if not metadata_key or not value_name:
        raise ValueError("metadata key and value name must not be empty")

    records: list[dict[str, Any]] = []
    pending: dict[str, Any] | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        frame_match = _FRAME_HEADER_RE.search(line)
        if frame_match is not None:
            pending = {
                "frameIndex": int(frame_match.group("frame")),
                "timeSeconds": float(frame_match.group("time")),
            }
            continue
        if pending is None or not line.startswith(f"{metadata_key}="):
            continue
        value = float(line.split("=", 1)[1])
        if not math.isfinite(value):
            raise ValueError(f"non-finite FFmpeg metadata value for {metadata_key}")
        pending[value_name] = value
        records.append(pending)
        pending = None

    return records


def cluster_scene_events(
    records: Sequence[Mapping[str, Any]],
    *,
    activity_threshold: float = 0.08,
    strong_threshold: float = 0.22,
    cluster_window_seconds: float = 0.25,
) -> list[dict[str, Any]]:
    """Collapse adjacent scene-score frames into start/peak/end candidates."""

    if not 0 <= activity_threshold <= strong_threshold <= 1:
        raise ValueError("scene thresholds must satisfy 0 <= activity <= strong <= 1")
    if cluster_window_seconds < 0:
        raise ValueError("cluster window must be non-negative")

    active = sorted(
        (
            dict(record)
            for record in records
            if float(record["score"]) >= activity_threshold
        ),
        key=lambda record: float(record["timeSeconds"]),
    )
    clusters: list[list[dict[str, Any]]] = []
    for record in active:
        if (
            not clusters
            or float(record["timeSeconds"]) - float(clusters[-1][-1]["timeSeconds"])
            > cluster_window_seconds
        ):
            clusters.append([record])
        else:
            clusters[-1].append(record)

    events: list[dict[str, Any]] = []
    for cluster in clusters:
        peak = min(
            cluster,
            key=lambda record: (-float(record["score"]), float(record["timeSeconds"])),
        )
        max_score = float(peak["score"])
        events.append(
            {
                "timeSeconds": float(peak["timeSeconds"]),
                "startTimeSeconds": float(cluster[0]["timeSeconds"]),
                "endTimeSeconds": float(cluster[-1]["timeSeconds"]),
                "frameIndex": int(peak["frameIndex"]),
                "family": "visual_reset_candidate",
                "detector": "ffmpeg_scene",
                "tier": "strong" if max_score >= strong_threshold else "activity",
                "score": max_score,
                "measurements": {
                    "maxSceneScore": max_score,
                    "activeFrameCount": len(cluster),
                    "activityThreshold": activity_threshold,
                    "strongThreshold": strong_threshold,
                },
            }
        )
    return events


def select_adaptive_diff_peaks(
    records: Sequence[Mapping[str, Any]],
    *,
    quantile: float = 0.82,
    min_spacing_seconds: float = 0.5,
    detector: str = "ffmpeg_difference",
    family: str = "visual_activity_candidate",
    baseline_window_seconds: float | None = None,
) -> list[dict[str, Any]]:
    """Select local frame-difference peaks above a per-video quantile."""

    if not 0 <= quantile <= 1:
        raise ValueError("quantile must be between zero and one")
    if baseline_window_seconds is not None and baseline_window_seconds <= 0:
        raise ValueError("baseline window must be positive")
    if not records:
        return []

    ordered = sorted((dict(record) for record in records), key=lambda record: record["timeSeconds"])
    values = np.asarray([float(record["difference"]) for record in ordered], dtype=np.float64)
    if baseline_window_seconds is None:
        block_by_index = [0] * len(ordered)
    else:
        block_by_index = [
            int(float(record["timeSeconds"]) // baseline_window_seconds)
            for record in ordered
        ]
    values_by_block: dict[int, list[float]] = {}
    for block, value in zip(block_by_index, values):
        values_by_block.setdefault(block, []).append(float(value))
    thresholds = {
        block: float(np.quantile(block_values, quantile))
        for block, block_values in values_by_block.items()
    }
    maxima = {block: max(block_values) for block, block_values in values_by_block.items()}
    candidates: list[dict[str, Any]] = []
    for index, record in enumerate(ordered):
        value = float(record["difference"])
        block = block_by_index[index]
        threshold = thresholds[block]
        denominator = max(1e-9, maxima[block] - threshold)
        previous_value = float(ordered[index - 1]["difference"]) if index > 0 else -math.inf
        next_value = float(ordered[index + 1]["difference"]) if index + 1 < len(ordered) else -math.inf
        if value < threshold or value < previous_value or value < next_value:
            continue
        candidates.append(
            {
                "timeSeconds": float(record["timeSeconds"]),
                "frameIndex": int(record["frameIndex"]),
                "family": family,
                "detector": detector,
                "score": min(1.0, 0.5 + 0.5 * (value - threshold) / denominator),
                "adaptiveThreshold": threshold,
                "measurements": {
                    "difference": value,
                    "adaptiveThreshold": threshold,
                    "quantile": quantile,
                    "baselineWindowSeconds": baseline_window_seconds,
                },
            }
        )

    return non_max_suppression(candidates, min_spacing_seconds=min_spacing_seconds)


def detect_visual_events(
    samples: Sequence[Mapping[str, Any]], *, sample_fps: float
) -> list[dict[str, Any]]:
    """Generate explainable transition candidates from frame measurements."""

    if not math.isfinite(sample_fps) or sample_fps <= 0:
        raise ValueError("sample FPS must be a positive finite number")

    events: list[dict[str, Any]] = []
    for index, sample in enumerate(samples):
        pixel_diff = float(sample.get("pixelDiffMean", 0.0))
        histogram_distance = float(sample.get("histogramDistance", 0.0))

        if pixel_diff >= 0.16 and histogram_distance >= 0.16:
            events.append(
                _candidate(
                    sample,
                    family="cut_candidate",
                    detector="frame_diff",
                    score=0.55 * min(1.0, pixel_diff / 0.45)
                    + 0.45 * min(1.0, histogram_distance / 0.55),
                    measurements={
                        "pixelDiffMean": pixel_diff,
                        "histogramDistance": histogram_distance,
                    },
                )
            )

        if index == 0 or index == len(samples) - 1:
            continue

        previous = samples[index - 1]
        following = samples[index + 1]
        luma = float(sample.get("lumaMean", 0.0))
        previous_luma = float(previous.get("lumaMean", 0.0))
        following_luma = float(following.get("lumaMean", 0.0))
        recovery_delta = abs(previous_luma - following_luma)
        change_floor = min(
            pixel_diff,
            float(following.get("pixelDiffMean", 0.0)),
        )

        if (
            luma >= 0.9
            and max(previous_luma, following_luma) <= 0.72
            and recovery_delta <= 0.2
            and change_floor >= 0.18
        ):
            events.append(
                _candidate(
                    sample,
                    family="flash_candidate",
                    detector="luma_excursion",
                    score=(luma - max(previous_luma, following_luma)) / 0.9,
                    measurements={
                        "lumaMean": luma,
                        "previousLumaMean": previous_luma,
                        "followingLumaMean": following_luma,
                        "recoveryDelta": recovery_delta,
                    },
                )
            )

        if (
            luma <= 0.08
            and min(previous_luma, following_luma) >= 0.2
            and recovery_delta <= 0.2
            and change_floor >= 0.12
        ):
            events.append(
                _candidate(
                    sample,
                    family="dip_candidate",
                    detector="luma_excursion",
                    score=(min(previous_luma, following_luma) - luma) / 0.6,
                    measurements={
                        "lumaMean": luma,
                        "previousLumaMean": previous_luma,
                        "followingLumaMean": following_luma,
                        "recoveryDelta": recovery_delta,
                    },
                )
            )

        blur = float(sample.get("blurVariance", 0.0))
        neighbour_blur = min(
            float(previous.get("blurVariance", 0.0)),
            float(following.get("blurVariance", 0.0)),
        )
        if neighbour_blur >= 12.0 and blur <= neighbour_blur * 0.28 and change_floor >= 0.08:
            events.append(
                _candidate(
                    sample,
                    family="blur_bridge_candidate",
                    detector="focus_excursion",
                    score=1.0 - blur / neighbour_blur,
                    measurements={
                        "blurVariance": blur,
                        "neighbourBlurFloor": neighbour_blur,
                    },
                )
            )

    return sorted(events, key=lambda event: (event["timeSeconds"], event["family"]))


def merge_candidate_events(
    events: Sequence[Mapping[str, Any]], *, merge_window_seconds: float
) -> list[dict[str, Any]]:
    """Cluster coincident detector events and retain all measurement evidence."""

    if not math.isfinite(merge_window_seconds) or merge_window_seconds < 0:
        raise ValueError("merge window must be a non-negative finite number")
    if not events:
        return []

    ordered = sorted((dict(event) for event in events), key=lambda event: event["timeSeconds"])
    clusters: list[list[dict[str, Any]]] = []
    for event in ordered:
        if not clusters or event["timeSeconds"] - clusters[-1][0]["timeSeconds"] > merge_window_seconds:
            clusters.append([event])
        else:
            clusters[-1].append(event)

    merged: list[dict[str, Any]] = []
    for cluster in clusters:
        strongest = min(
            cluster,
            key=lambda event: (-float(event["score"]), float(event["timeSeconds"])),
        )
        families = sorted({str(event["family"]) for event in cluster})
        detectors = sorted({str(event["detector"]) for event in cluster})
        merged.append(
            {
                "timeSeconds": float(strongest["timeSeconds"]),
                "score": float(strongest["score"]),
                "family": families[0] if len(families) == 1 else "multi_candidate",
                "families": families,
                "detectors": detectors,
                "evidence": cluster,
            }
        )

    return merged
