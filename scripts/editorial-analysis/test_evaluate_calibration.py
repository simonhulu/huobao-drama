import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from evaluate_calibration import evaluate_calibration  # noqa: E402


def candidate(candidate_id: str, time_seconds: float, detector: str) -> dict[str, object]:
    return {
        "id": candidate_id,
        "timeSeconds": time_seconds,
        "evidence": [{"detector": detector}],
    }


class CalibrationEvaluationTests(unittest.TestCase):
    def test_reports_incremental_edge_detector_recall(self):
        calibration = {
            "schemaVersion": "observed-edit-calibration-v1",
            "sourceId": "sample",
            "range": {"startSeconds": 0.0, "endSeconds": 10.0},
            "evidence": {"timeToleranceSeconds": 0.25},
            "shotBoundaries": [
                {"id": "shot-1", "startSeconds": 0.9, "endSeconds": 1.1},
                {"id": "shot-2", "startSeconds": 4.9, "endSeconds": 5.1},
            ],
            "withinShotBeats": [
                {"id": "beat-1", "startSeconds": 1.8, "endSeconds": 2.0},
                {"id": "beat-2", "startSeconds": 5.8, "endSeconds": 6.0},
            ],
        }
        candidates = {
            "schemaVersion": "candidate-events-v1",
            "sourceId": "sample",
            "analysisDigest": "digest",
            "events": [
                candidate("scene", 1.0, "ffmpeg_scene"),
                candidate("difference", 2.2, "ffmpeg_difference"),
                candidate("edge-shot", 5.0, "ffmpeg_edge_difference"),
                candidate("edge-beat", 6.2, "ffmpeg_edge_difference"),
                candidate("audio", 8.0, "librosa_side_onset"),
            ],
        }

        report = evaluate_calibration(calibration, candidates)

        base = report["profiles"]["sceneAndDifference"]["annotationSets"]
        with_edge = report["profiles"]["sceneDifferenceAndEdge"]["annotationSets"]
        self.assertEqual(base["shotBoundaries"]["recall"], 0.5)
        self.assertEqual(base["withinShotBeats"]["recall"], 0.5)
        self.assertEqual(with_edge["shotBoundaries"]["recall"], 1.0)
        self.assertEqual(with_edge["withinShotBeats"]["recall"], 1.0)

    def test_rejects_source_mismatch(self):
        calibration = {
            "schemaVersion": "observed-edit-calibration-v1",
            "sourceId": "one",
            "evidence": {"timeToleranceSeconds": 0.25},
        }
        candidates = {
            "schemaVersion": "candidate-events-v1",
            "sourceId": "two",
            "events": [],
        }

        with self.assertRaisesRegex(ValueError, "source ids"):
            evaluate_calibration(calibration, candidates)


if __name__ == "__main__":
    unittest.main()
