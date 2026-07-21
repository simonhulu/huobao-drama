import sys
import unittest
from pathlib import Path

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parent))

from audio import (  # noqa: E402
    compute_audio_features,
    detect_audio_events,
    detect_side_onsets,
    select_density_calibrated_delta,
)


class AudioFeatureTests(unittest.TestCase):
    def test_reports_impulse_as_flux_and_energy_jump(self):
        sample_rate = 8_000
        samples = np.zeros(sample_rate * 2, dtype=np.float32)
        tone_time = np.arange(sample_rate, dtype=np.float32) / sample_rate
        samples[:sample_rate] = 0.02 * np.sin(2 * np.pi * 220 * tone_time)
        samples[sample_rate : sample_rate + 80] = 0.9

        features = compute_audio_features(
            samples,
            sample_rate=sample_rate,
            window_seconds=0.1,
            hop_seconds=0.05,
        )

        impulse = max(features, key=lambda feature: feature["spectralFlux"])
        self.assertAlmostEqual(impulse["timeSeconds"], 1.0, delta=0.11)
        self.assertGreater(impulse["spectralFlux"], 0.1)
        self.assertGreater(impulse["rmsDbfs"], -25.0)

    def test_detects_sustained_silence_and_onset(self):
        features = [
            {"timeSeconds": 0.0, "rmsDbfs": -24.0, "spectralFlux": 0.01},
            {"timeSeconds": 0.1, "rmsDbfs": -23.0, "spectralFlux": 0.02},
            {"timeSeconds": 0.2, "rmsDbfs": -60.0, "spectralFlux": 0.01},
            {"timeSeconds": 0.3, "rmsDbfs": -62.0, "spectralFlux": 0.01},
            {"timeSeconds": 0.4, "rmsDbfs": -61.0, "spectralFlux": 0.01},
            {"timeSeconds": 0.5, "rmsDbfs": -20.0, "spectralFlux": 0.8},
            {"timeSeconds": 0.6, "rmsDbfs": -22.0, "spectralFlux": 0.02},
        ]

        events = detect_audio_events(
            features,
            hop_seconds=0.1,
            window_seconds=0.1,
            silence_threshold_db=-50.0,
            minimum_silence_seconds=0.3,
        )

        silence = next(event for event in events if event["family"] == "silence_candidate")
        onset = next(event for event in events if event["family"] == "audio_onset_candidate")
        self.assertAlmostEqual(silence["timeSeconds"], 0.2)
        self.assertAlmostEqual(silence["durationSeconds"], 0.3)
        self.assertAlmostEqual(onset["timeSeconds"], 0.5)

    def test_side_channel_onset_suppresses_centered_tone(self):
        sample_rate = 22_050
        time = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
        centered = 0.03 * np.sin(2 * np.pi * 220 * time)
        stereo = np.stack([centered.copy(), centered.copy()], axis=1)
        stereo[sample_rate : sample_rate + 512, 0] += 0.8
        stereo[sample_rate : sample_rate + 512, 1] -= 0.8

        analysis = detect_side_onsets(
            stereo,
            sample_rate=sample_rate,
            hop_length=512,
            delta=0.1,
            wait=5,
            target_density_per_minute=(20.0, 40.0),
            delta_bounds=(0.08, 0.14),
            delta_step=0.01,
        )

        self.assertTrue(
            any(abs(event["timeSeconds"] - 1.0) < 0.12 for event in analysis["events"])
        )
        self.assertGreater(analysis["sideToMidRmsRatio"], 0.1)
        self.assertEqual(analysis["selectedDelta"], 0.1)
        self.assertGreater(len(analysis["deltaCalibration"]), 1)

    def test_selects_nearest_delta_that_enters_target_density(self):
        selected = select_density_calibrated_delta(
            [
                {"delta": 0.30, "densityPerMinute": 5.0},
                {"delta": 0.29, "densityPerMinute": 7.0},
                {"delta": 0.28, "densityPerMinute": 9.0},
                {"delta": 0.27, "densityPerMinute": 12.0},
            ],
            preferred_delta=0.30,
            target_minimum=8.0,
            target_maximum=15.0,
        )

        self.assertEqual(selected, 0.28)


if __name__ == "__main__":
    unittest.main()
