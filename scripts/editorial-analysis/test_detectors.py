import sys
import unittest
from pathlib import Path

import cv2
import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parent))

from detectors import (  # noqa: E402
    cluster_scene_events,
    compute_frame_features,
    detect_visual_events,
    estimate_camera_transform,
    merge_candidate_events,
    parse_ffmpeg_metadata,
    select_adaptive_diff_peaks,
)


class FrameFeatureTests(unittest.TestCase):
    def test_hard_cut_has_large_pixel_and_histogram_distance(self):
        previous = np.zeros((90, 160, 3), dtype=np.uint8)
        current = np.full((90, 160, 3), 255, dtype=np.uint8)

        features = compute_frame_features(previous, current)

        self.assertGreater(features["pixelDiffMean"], 0.95)
        self.assertGreater(features["histogramDistance"], 0.95)
        self.assertEqual(features["lumaMean"], 1.0)

    def test_identical_frames_have_zero_change(self):
        frame = np.full((90, 160, 3), 127, dtype=np.uint8)

        features = compute_frame_features(frame, frame.copy())

        self.assertEqual(features["pixelDiffMean"], 0.0)
        self.assertAlmostEqual(features["histogramDistance"], 0.0, places=6)

    def test_detects_equal_luma_colour_change(self):
        previous = np.full((90, 160, 3), (0, 0, 255), dtype=np.uint8)
        current = np.full((90, 160, 3), (0, 129, 0), dtype=np.uint8)

        features = compute_frame_features(previous, current)

        self.assertGreater(features["colorHistogramDistance"], 0.9)
        self.assertGreater(features["histogramDistance"], 0.9)

    def test_full_frame_edge_change_catches_central_text_region(self):
        previous = np.zeros((100, 160, 3), dtype=np.uint8)
        current = previous.copy()
        cv2.putText(current, "YAHOO", (20, 45), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)

        features = compute_frame_features(previous, current)

        self.assertGreater(features["fullFrameEdgeDiffMean"], 0.01)
        self.assertEqual(features["textRegionDiffMean"], 0.0)


class CameraTransformTests(unittest.TestCase):
    def test_estimates_horizontal_translation(self):
        rng = np.random.default_rng(7)
        previous = rng.integers(0, 256, size=(120, 180), dtype=np.uint8)
        matrix = np.float32([[1, 0, 5], [0, 1, 0]])
        current = cv2.warpAffine(previous, matrix, (180, 120))

        transform = estimate_camera_transform(previous, current)

        self.assertGreaterEqual(transform["trackedPoints"], 20)
        self.assertGreater(transform["inlierRatio"], 0.7)
        self.assertAlmostEqual(transform["dxPixels"], 5.0, delta=0.8)
        self.assertAlmostEqual(transform["scale"], 1.0, delta=0.02)


class VisualEventTests(unittest.TestCase):
    def test_detects_cut_and_flash_recovery(self):
        samples = [
            {"timeSeconds": 0.0, "pixelDiffMean": 0.01, "histogramDistance": 0.01, "lumaMean": 0.2, "blurVariance": 20.0},
            {"timeSeconds": 0.125, "pixelDiffMean": 0.62, "histogramDistance": 0.72, "lumaMean": 0.5, "blurVariance": 18.0},
            {"timeSeconds": 1.0, "pixelDiffMean": 0.02, "histogramDistance": 0.01, "lumaMean": 0.25, "blurVariance": 20.0},
            {"timeSeconds": 1.125, "pixelDiffMean": 0.75, "histogramDistance": 0.2, "lumaMean": 0.99, "blurVariance": 2.0},
            {"timeSeconds": 1.25, "pixelDiffMean": 0.74, "histogramDistance": 0.19, "lumaMean": 0.24, "blurVariance": 19.0},
        ]

        events = detect_visual_events(samples, sample_fps=8.0)

        families = [event["family"] for event in events]
        self.assertIn("cut_candidate", families)
        self.assertIn("flash_candidate", families)


class CandidateMergeTests(unittest.TestCase):
    def test_merges_nearby_detector_evidence_without_losing_provenance(self):
        merged = merge_candidate_events(
            [
                {"timeSeconds": 5.0, "score": 0.7, "family": "cut_candidate", "detector": "frame_diff"},
                {"timeSeconds": 5.08, "score": 0.9, "family": "cut_candidate", "detector": "ffmpeg_scene"},
                {"timeSeconds": 8.0, "score": 0.6, "family": "audio_impact_candidate", "detector": "spectral_flux"},
            ],
            merge_window_seconds=0.15,
        )

        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["timeSeconds"], 5.08)
        self.assertEqual(merged[0]["detectors"], ["ffmpeg_scene", "frame_diff"])
        self.assertEqual(len(merged[0]["evidence"]), 2)

    def test_does_not_chain_separate_fast_events_into_one_long_cluster(self):
        merged = merge_candidate_events(
            [
                {"timeSeconds": 1.0, "score": 0.7, "family": "cut_candidate", "detector": "a"},
                {"timeSeconds": 1.14, "score": 0.8, "family": "flash_candidate", "detector": "b"},
                {"timeSeconds": 1.28, "score": 0.9, "family": "cut_candidate", "detector": "c"},
            ],
            merge_window_seconds=0.15,
        )

        self.assertEqual(len(merged), 2)


class FfmpegEvidenceTests(unittest.TestCase):
    def test_parses_metadata_frames_and_requested_key(self):
        records = parse_ffmpeg_metadata(
            """frame:0    pts:0       pts_time:0
lavfi.scene_score=0.001000
frame:24   pts:1001    pts_time:1.001
lavfi.scene_score=0.420000
""",
            metadata_key="lavfi.scene_score",
            value_name="score",
        )

        self.assertEqual(records[1]["frameIndex"], 24)
        self.assertEqual(records[1]["timeSeconds"], 1.001)
        self.assertEqual(records[1]["score"], 0.42)

    def test_clusters_scene_activity_and_preserves_strong_tier(self):
        events = cluster_scene_events(
            [
                {"frameIndex": 24, "timeSeconds": 1.0, "score": 0.25},
                {"frameIndex": 27, "timeSeconds": 1.12, "score": 0.31},
                {"frameIndex": 48, "timeSeconds": 2.0, "score": 0.1},
            ],
            activity_threshold=0.08,
            strong_threshold=0.22,
            cluster_window_seconds=0.25,
        )

        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["timeSeconds"], 1.12)
        self.assertEqual(events[0]["startTimeSeconds"], 1.0)
        self.assertEqual(events[0]["tier"], "strong")
        self.assertEqual(events[1]["tier"], "activity")

    def test_selects_quantile_local_diff_peaks_with_nms(self):
        peaks = select_adaptive_diff_peaks(
            [
                {"frameIndex": 0, "timeSeconds": 0.0, "difference": 1.0},
                {"frameIndex": 1, "timeSeconds": 0.1, "difference": 8.0},
                {"frameIndex": 2, "timeSeconds": 0.2, "difference": 5.0},
                {"frameIndex": 3, "timeSeconds": 1.0, "difference": 9.0},
                {"frameIndex": 4, "timeSeconds": 1.1, "difference": 2.0},
            ],
            quantile=0.5,
            min_spacing_seconds=0.5,
        )

        self.assertEqual([peak["timeSeconds"] for peak in peaks], [0.1, 1.0])
        self.assertTrue(all(peak["adaptiveThreshold"] == 5.0 for peak in peaks))

    def test_diff_peak_layer_can_keep_a_distinct_detector_identity(self):
        peaks = select_adaptive_diff_peaks(
            [
                {"frameIndex": 0, "timeSeconds": 0.0, "difference": 1.0},
                {"frameIndex": 1, "timeSeconds": 0.25, "difference": 9.0},
                {"frameIndex": 2, "timeSeconds": 0.5, "difference": 1.0},
            ],
            quantile=0.5,
            min_spacing_seconds=0.2,
            detector="ffmpeg_edge_difference",
            family="text_or_graphic_state_candidate",
        )

        self.assertEqual(peaks[0]["detector"], "ffmpeg_edge_difference")
        self.assertEqual(peaks[0]["family"], "text_or_graphic_state_candidate")

    def test_blockwise_threshold_preserves_quiet_chapter_peak(self):
        peaks = select_adaptive_diff_peaks(
            [
                {"frameIndex": 0, "timeSeconds": 0.0, "difference": 1.0},
                {"frameIndex": 1, "timeSeconds": 1.0, "difference": 3.0},
                {"frameIndex": 2, "timeSeconds": 2.0, "difference": 1.0},
                {"frameIndex": 3, "timeSeconds": 10.0, "difference": 100.0},
                {"frameIndex": 4, "timeSeconds": 11.0, "difference": 300.0},
                {"frameIndex": 5, "timeSeconds": 12.0, "difference": 100.0},
            ],
            quantile=0.5,
            min_spacing_seconds=0.5,
            baseline_window_seconds=10.0,
        )

        self.assertEqual([peak["timeSeconds"] for peak in peaks], [1.0, 11.0])
        self.assertEqual([peak["adaptiveThreshold"] for peak in peaks], [1.0, 100.0])


if __name__ == "__main__":
    unittest.main()
