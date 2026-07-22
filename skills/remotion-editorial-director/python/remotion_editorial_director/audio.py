"""Deterministic audio-envelope measurements for editorial analysis."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

from .core import non_max_suppression


def select_density_calibrated_delta(
    evaluations: Sequence[Mapping[str, float]],
    *,
    preferred_delta: float,
    target_minimum: float,
    target_maximum: float,
) -> float:
    if not evaluations:
        raise ValueError("at least one delta evaluation is required")
    if target_minimum < 0 or target_maximum < target_minimum:
        raise ValueError("invalid target density range")

    in_range = [
        evaluation
        for evaluation in evaluations
        if target_minimum <= float(evaluation["densityPerMinute"]) <= target_maximum
    ]
    candidates = in_range or list(evaluations)
    target_midpoint = (target_minimum + target_maximum) * 0.5
    selected = min(
        candidates,
        key=lambda evaluation: (
            abs(float(evaluation["delta"]) - preferred_delta)
            if in_range
            else abs(float(evaluation["densityPerMinute"]) - target_midpoint),
            -float(evaluation["delta"]),
        ),
    )
    return float(selected["delta"])


def _dbfs(amplitude: float) -> float:
    return max(-120.0, 20.0 * math.log10(max(amplitude, 1e-6)))


def compute_audio_features(
    samples: np.ndarray,
    *,
    sample_rate: int,
    window_seconds: float = 0.1,
    hop_seconds: float = 0.05,
) -> list[dict[str, float]]:
    """Compute windowed energy and normalized positive spectral flux."""

    if sample_rate <= 0:
        raise ValueError("sample rate must be positive")
    if window_seconds <= 0 or hop_seconds <= 0:
        raise ValueError("window and hop durations must be positive")

    mono = np.asarray(samples, dtype=np.float32).reshape(-1)
    window_size = max(2, int(round(window_seconds * sample_rate)))
    hop_size = max(1, int(round(hop_seconds * sample_rate)))
    if mono.size < window_size:
        return []

    taper = np.hanning(window_size).astype(np.float32)
    frequencies = np.fft.rfftfreq(window_size, d=1.0 / sample_rate)
    features: list[dict[str, float]] = []
    previous_spectrum: np.ndarray | None = None

    for start in range(0, mono.size - window_size + 1, hop_size):
        frame = mono[start : start + window_size]
        rms = float(np.sqrt(np.mean(np.square(frame, dtype=np.float64))))
        peak = float(np.max(np.abs(frame)))
        spectrum = np.abs(np.fft.rfft(frame * taper)).astype(np.float64)
        spectrum_sum = float(np.sum(spectrum))
        normalized_spectrum = spectrum / spectrum_sum if spectrum_sum > 1e-12 else spectrum
        if previous_spectrum is None:
            spectral_flux = 0.0
        else:
            spectral_flux = float(np.sum(np.maximum(normalized_spectrum - previous_spectrum, 0.0)))
        spectral_centroid = (
            float(np.sum(frequencies * spectrum) / spectrum_sum) if spectrum_sum > 1e-12 else 0.0
        )
        signs = np.signbit(frame)
        zero_crossing_rate = float(np.count_nonzero(signs[1:] != signs[:-1]) / (window_size - 1))

        features.append(
            {
                "timeSeconds": start / sample_rate,
                "rmsDbfs": _dbfs(rms),
                "peakDbfs": _dbfs(peak),
                "spectralFlux": spectral_flux,
                "spectralCentroidHz": spectral_centroid,
                "zeroCrossingRate": zero_crossing_rate,
            }
        )
        previous_spectrum = normalized_spectrum

    return features


def _mel_filterbank(sample_rate: int, n_fft: int, *, n_mels: int = 128) -> np.ndarray:
    """Build the Slaney mel bank used by the onset spectral envelope."""

    f_sp = 200.0 / 3.0
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    log_step = math.log(6.4) / 27.0

    def hz_to_mel(frequencies: np.ndarray) -> np.ndarray:
        mels = frequencies / f_sp
        logarithmic = frequencies >= min_log_hz
        mels[logarithmic] = min_log_mel + np.log(
            frequencies[logarithmic] / min_log_hz
        ) / log_step
        return mels

    def mel_to_hz(mels: np.ndarray) -> np.ndarray:
        frequencies = f_sp * mels
        logarithmic = mels >= min_log_mel
        frequencies[logarithmic] = min_log_hz * np.exp(
            log_step * (mels[logarithmic] - min_log_mel)
        )
        return frequencies

    mel_points = np.linspace(
        hz_to_mel(np.asarray([0.0]))[0],
        hz_to_mel(np.asarray([sample_rate / 2.0]))[0],
        n_mels + 2,
    )
    frequencies = mel_to_hz(mel_points)
    fft_frequencies = np.arange(1 + n_fft // 2, dtype=np.float64) * sample_rate / n_fft
    differences = np.diff(frequencies)
    ramps = np.subtract.outer(frequencies, fft_frequencies)

    weights = np.zeros((n_mels, 1 + n_fft // 2), dtype=np.float32)
    for index in range(n_mels):
        lower = -ramps[index] / differences[index]
        upper = ramps[index + 2] / differences[index + 1]
        weights[index] = np.maximum(0.0, np.minimum(lower, upper))

    weights *= (2.0 / (frequencies[2 : n_mels + 2] - frequencies[:n_mels]))[:, None]
    return weights


def _spectral_onset_envelope(
    samples: np.ndarray,
    *,
    sample_rate: int,
    hop_length: int,
    n_fft: int = 2048,
) -> np.ndarray:
    """Compute a centered log-mel spectral-flux envelope with SciPy only."""

    from scipy import fft

    signal_samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    padded = np.pad(signal_samples, (n_fft // 2, n_fft // 2), mode="constant")
    frame_count = 1 + signal_samples.size // hop_length
    frame_view = np.lib.stride_tricks.sliding_window_view(padded, n_fft)
    window = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n_fft) / n_fft)
    spectrum = np.empty((1 + n_fft // 2, frame_count), dtype=np.complex64)
    for start in range(0, frame_count, 1024):
        stop = min(frame_count, start + 1024)
        frames = frame_view[start * hop_length : stop * hop_length : hop_length]
        block = fft.rfft(frames * window, axis=1).T
        spectrum[:, start:stop] = block.astype(np.complex64, copy=False)

    power = np.abs(spectrum) ** 2
    mel_power = np.einsum(
        "mf,ft->mt",
        _mel_filterbank(sample_rate, n_fft),
        power,
        optimize=True,
    )
    log_power = 10.0 * np.log10(np.maximum(1e-10, mel_power))
    log_power = np.maximum(log_power, np.max(log_power) - 80.0)
    onset_envelope = np.mean(
        np.maximum(0.0, log_power[:, 1:] - log_power[:, :-1]),
        axis=0,
    )
    pad_width = 1 + n_fft // (2 * hop_length)
    return np.pad(onset_envelope, (pad_width, 0), mode="constant")[: log_power.shape[-1]]


def _peak_pick(
    values: np.ndarray,
    *,
    pre_max: int,
    post_max: int,
    pre_avg: int,
    post_avg: int,
    delta: float,
    wait: int,
) -> np.ndarray:
    """Pick peaks using a deterministic local-max/local-average gate."""

    peaks = np.zeros(values.shape, dtype=bool)
    if values.size == 0:
        return np.flatnonzero(peaks)

    peaks[0] = values[0] >= np.max(values[: min(post_max, values.shape[0])])
    peaks[0] &= values[0] >= np.mean(values[: min(post_avg, values.shape[0])]) + delta
    index = wait + 1 if peaks[0] else 1
    while index < values.shape[0]:
        maximum = np.max(values[max(0, index - pre_max) : min(index + post_max, values.shape[0])])
        peaks[index] = values[index] == maximum
        if not peaks[index]:
            index += 1
            continue
        average = np.mean(
            values[max(0, index - pre_avg) : min(index + post_avg, values.shape[0])]
        )
        peaks[index] &= values[index] >= average + delta
        if not peaks[index]:
            index += 1
            continue
        index += wait + 1
    return np.flatnonzero(peaks)


def detect_side_onsets(
    stereo_samples: np.ndarray,
    *,
    sample_rate: int,
    hop_length: int = 512,
    delta: float = 0.30,
    wait: int = 21,
    target_density_per_minute: tuple[float, float] | None = None,
    delta_bounds: tuple[float, float] = (0.20, 0.40),
    delta_step: float = 0.01,
) -> dict[str, Any]:
    """Detect stereo-side transients while suppressing centred narration."""

    if sample_rate <= 0 or hop_length <= 0 or wait < 0 or delta < 0:
        raise ValueError("invalid side-onset parameters")
    if delta_step <= 0 or delta_bounds[0] < 0 or delta_bounds[1] < delta_bounds[0]:
        raise ValueError("invalid delta calibration bounds")
    original = np.asarray(stereo_samples)
    if original.ndim != 2 or original.shape[1] != 2:
        raise ValueError("side-onset analysis requires exactly two audio channels")
    if np.issubdtype(original.dtype, np.integer):
        scale = float(max(abs(np.iinfo(original.dtype).min), np.iinfo(original.dtype).max))
        stereo = original.astype(np.float32) / scale
    else:
        stereo = original.astype(np.float32)

    mid = (stereo[:, 0] + stereo[:, 1]) * 0.5
    side = (stereo[:, 0] - stereo[:, 1]) * 0.5
    mid_rms = float(np.sqrt(np.mean(np.square(mid, dtype=np.float64))))
    side_rms = float(np.sqrt(np.mean(np.square(side, dtype=np.float64))))
    side_to_mid_ratio = side_rms / max(mid_rms, 1e-9)

    onset_envelope = _spectral_onset_envelope(
        side,
        sample_rate=sample_rate,
        hop_length=hop_length,
    )
    # The reference onset detector normalizes the supplied envelope before
    # peak picking. Keep the original strengths for output while matching
    # that threshold calibration behavior.
    detection_envelope = onset_envelope - np.min(onset_envelope)
    detection_envelope /= np.max(detection_envelope) + np.finfo(detection_envelope.dtype).tiny
    duration_minutes = len(stereo) / sample_rate / 60.0
    if target_density_per_minute is None:
        deltas = [delta]
    else:
        step_count = int(round((delta_bounds[1] - delta_bounds[0]) / delta_step))
        deltas = [round(delta_bounds[0] + index * delta_step, 6) for index in range(step_count + 1)]
        if not any(abs(candidate - delta) < 1e-9 for candidate in deltas):
            deltas.append(delta)
            deltas.sort()

    frames_by_delta: dict[float, np.ndarray] = {}
    calibration: list[dict[str, float | int]] = []
    for candidate_delta in deltas:
        candidate_frames = _peak_pick(
            detection_envelope,
            pre_max=int(0.03 * sample_rate // hop_length),
            post_max=int(0.00 * sample_rate // hop_length + 1),
            pre_avg=int(0.10 * sample_rate // hop_length),
            post_avg=int(0.10 * sample_rate // hop_length + 1),
            delta=candidate_delta,
            wait=wait,
        )
        frames_by_delta[candidate_delta] = candidate_frames
        density = len(candidate_frames) / max(duration_minutes, 1e-9)
        calibration.append(
            {
                "delta": candidate_delta,
                "eventCount": int(len(candidate_frames)),
                "densityPerMinute": density,
            }
        )

    if target_density_per_minute is None:
        selected_delta = delta
    else:
        selected_delta = select_density_calibrated_delta(
            calibration,
            preferred_delta=delta,
            target_minimum=target_density_per_minute[0],
            target_maximum=target_density_per_minute[1],
        )
    onset_frames = frames_by_delta[selected_delta]
    reference_strength = max(float(np.percentile(onset_envelope, 95)), 1e-9)
    times = np.arange(len(onset_envelope), dtype=np.float64) * hop_length / sample_rate
    events = [
        {
            "timeSeconds": float(times[frame]),
            "frameIndex": int(frame),
            "family": "audio_onset_candidate",
            "detector": "stereo_side_onset",
            "score": min(1.0, float(onset_envelope[frame]) / reference_strength),
            "measurements": {
                "onsetStrength": float(onset_envelope[frame]),
                "delta": selected_delta,
                "waitFrames": wait,
                "hopLength": hop_length,
            },
        }
        for frame in onset_frames
    ]
    envelope = [
        {
            "frameIndex": frame,
            "timeSeconds": float(times[frame]),
            "onsetStrength": float(strength),
        }
        for frame, strength in enumerate(onset_envelope)
    ]
    return {
        "sampleRate": sample_rate,
        "hopLength": hop_length,
        "requestedDelta": delta,
        "selectedDelta": selected_delta,
        "targetDensityPerMinute": list(target_density_per_minute)
        if target_density_per_minute is not None
        else None,
        "deltaCalibration": calibration,
        "wait": wait,
        "midRms": mid_rms,
        "sideRms": side_rms,
        "sideToMidRmsRatio": side_to_mid_ratio,
        "events": events,
        "envelope": envelope,
    }


def detect_audio_events(
    features: Sequence[Mapping[str, Any]],
    *,
    hop_seconds: float,
    window_seconds: float | None = None,
    silence_threshold_db: float = -50.0,
    minimum_silence_seconds: float = 0.35,
    onset_spacing_seconds: float = 0.3,
    baseline_window_seconds: float = 60.0,
) -> list[dict[str, Any]]:
    """Detect sustained silence and robust spectral/energy onsets."""

    if hop_seconds <= 0:
        raise ValueError("hop duration must be positive")
    if window_seconds is None:
        window_seconds = hop_seconds
    if window_seconds <= 0 or baseline_window_seconds <= 0:
        raise ValueError("window and baseline durations must be positive")
    if minimum_silence_seconds <= 0:
        raise ValueError("minimum silence duration must be positive")
    if not features:
        return []

    baselines: dict[int, tuple[float, float]] = {}
    grouped_flux: dict[int, list[float]] = {}
    for feature in features:
        block = int(float(feature["timeSeconds"]) // baseline_window_seconds)
        grouped_flux.setdefault(block, []).append(float(feature["spectralFlux"]))
    for block, values in grouped_flux.items():
        flux_values = np.asarray(values)
        flux_median = float(np.median(flux_values))
        flux_mad = float(np.median(np.abs(flux_values - flux_median)))
        baselines[block] = (flux_median, flux_median + max(0.04, 6.0 * flux_mad))

    onset_candidates: list[dict[str, Any]] = []
    previous_rms = float(features[0]["rmsDbfs"])
    for feature in features[1:]:
        rms = float(feature["rmsDbfs"])
        flux = float(feature["spectralFlux"])
        block = int(float(feature["timeSeconds"]) // baseline_window_seconds)
        flux_median, flux_threshold = baselines[block]
        energy_jump = rms - previous_rms
        if flux >= flux_threshold and (rms >= -45.0 or energy_jump >= 6.0):
            robust_flux = (flux - flux_median) / max(0.08, flux_threshold - flux_median)
            jump_score = max(0.0, energy_jump / 18.0)
            onset_candidates.append(
                {
                    "timeSeconds": float(feature["timeSeconds"]),
                    "family": "audio_onset_candidate",
                    "detector": "spectral_flux",
                    "score": min(1.0, 0.75 * robust_flux + 0.25 * jump_score),
                    "measurements": {
                        "spectralFlux": flux,
                        "fluxThreshold": flux_threshold,
                        "rmsDbfs": rms,
                        "energyJumpDb": energy_jump,
                        "baselineWindowSeconds": baseline_window_seconds,
                    },
                }
            )
        previous_rms = rms

    selected_onsets = non_max_suppression(
        onset_candidates,
        min_spacing_seconds=onset_spacing_seconds,
    )

    silence_events: list[dict[str, Any]] = []
    silence_start: int | None = None
    for index in range(len(features) + 1):
        is_silent = index < len(features) and float(features[index]["rmsDbfs"]) <= silence_threshold_db
        if is_silent and silence_start is None:
            silence_start = index
        if (not is_silent or index == len(features)) and silence_start is not None:
            length = index - silence_start
            duration_seconds = (length - 1) * hop_seconds + window_seconds
            if duration_seconds + 1e-9 >= minimum_silence_seconds:
                window = features[silence_start:index]
                silence_events.append(
                    {
                        "timeSeconds": float(features[silence_start]["timeSeconds"]),
                        "durationSeconds": duration_seconds,
                        "family": "silence_candidate",
                        "detector": "rms_run",
                        "score": min(1.0, duration_seconds / 1.5),
                        "measurements": {
                            "minimumRmsDbfs": min(float(feature["rmsDbfs"]) for feature in window),
                            "thresholdDbfs": silence_threshold_db,
                        },
                    }
                )
            silence_start = None

    return sorted(
        [*selected_onsets, *silence_events],
        key=lambda event: (event["timeSeconds"], event["family"]),
    )
