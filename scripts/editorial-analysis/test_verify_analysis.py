import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_analysis import (  # noqa: E402
    validate_candidate_events,
    validate_interval_track,
    validate_review_windows,
    verify_artifact_record,
    verify_analysis_directory,
)


class IntervalValidationTests(unittest.TestCase):
    def test_accepts_contiguous_half_open_track(self):
        errors = validate_interval_track(
            [{"startFrame": 0, "endFrame": 10}, {"startFrame": 10, "endFrame": 20}],
            expected_end_frame=20,
            maximum_interval_frames=10,
            label="visual",
        )

        self.assertEqual(errors, [])

    def test_reports_gap_and_oversized_interval(self):
        errors = validate_interval_track(
            [{"startFrame": 0, "endFrame": 11}, {"startFrame": 12, "endFrame": 20}],
            expected_end_frame=20,
            maximum_interval_frames=10,
            label="visual",
        )

        self.assertTrue(any("exceeds" in error for error in errors))
        self.assertTrue(any("not contiguous" in error for error in errors))


class CandidateValidationTests(unittest.TestCase):
    def test_accepts_sorted_unique_candidates_and_covering_review_window(self):
        events = [
            {"id": "one", "timeSeconds": 1.0, "candidateLevel": "setup_boundary_candidate", "evidence": [{}]},
            {"id": "two", "timeSeconds": 2.0, "candidateLevel": "audio_beat_candidate", "evidence": [{}]},
        ]
        windows = [{"startSeconds": 0.5, "endSeconds": 2.5, "candidateIds": ["one", "two"]}]

        self.assertEqual(validate_candidate_events(events), [])
        self.assertEqual(validate_review_windows(windows, events, duration_seconds=3.0), [])

    def test_reports_duplicate_candidate_reference(self):
        events = [
            {"id": "one", "timeSeconds": 1.0, "candidateLevel": "setup_boundary_candidate", "evidence": [{}]}
        ]
        windows = [
            {"startSeconds": 0.5, "endSeconds": 1.5, "candidateIds": ["one"]},
            {"startSeconds": 1.5, "endSeconds": 2.0, "candidateIds": ["one"]},
        ]

        errors = validate_review_windows(windows, events, duration_seconds=3.0)

        self.assertTrue(any("exactly once" in error for error in errors))


class ArtifactValidationTests(unittest.TestCase):
    def test_verifies_size_and_sha256(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "artifact.json"
            path.write_bytes(b"artifact")
            record = {
                "path": str(path),
                "bytes": 8,
                "sha256": hashlib.sha256(b"artifact").hexdigest(),
            }

            self.assertEqual(verify_artifact_record(record), [])

    def test_verifies_cross_file_counts_and_coverage(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)

            def write(name: str, value: object) -> dict[str, object]:
                path = root / name
                path.write_text(json.dumps(value), encoding="utf-8")
                return {
                    "path": str(path),
                    "bytes": path.stat().st_size,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }

            coverage = {
                "endFrame": 60,
                "sourceFps": {"numerator": 30, "denominator": 1},
                "intervals": [{"startFrame": 0, "endFrame": 60}],
                "semanticIntervals": [{"startFrame": 0, "endFrame": 60}],
            }
            candidates = {
                "events": [
                    {
                        "id": "one",
                        "timeSeconds": 1.0,
                        "candidateLevel": "setup_boundary_candidate",
                        "evidence": [{}],
                    }
                ],
                "reviewWindows": [
                    {"startSeconds": 0.5, "endSeconds": 1.5, "candidateIds": ["one"]}
                ],
            }
            subtitles = {"cues": []}
            audio = {"events": [], "selectedDelta": 0.3, "deltaCalibration": []}
            artifacts = [
                write("machine-coverage.json", coverage),
                write("candidate-events.json", candidates),
                write("subtitles.json", subtitles),
                write("audio-evidence.json", audio),
            ]
            manifest = {
                "status": "complete",
                "identity": {
                    "sourceId": "sample",
                    "config": {"coverage_max_segment_seconds": 2.0},
                },
                "counts": {
                    "combinedCandidates": 1,
                    "reviewWindows": 1,
                    "visualCoverageIntervals": 1,
                    "semanticCoverageIntervals": 1,
                    "subtitleCues": 0,
                    "audioOnsets": 0,
                },
                "artifacts": artifacts,
            }
            (root / "analysis-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

            report = verify_analysis_directory(root, duration_seconds=2.0)

            self.assertEqual(report["status"], "passed")
            self.assertEqual(report["errors"], [])


if __name__ == "__main__":
    unittest.main()
