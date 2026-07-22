from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parents[2] / "python"
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))


class PackageImportTests(unittest.TestCase):
    def test_provider_neutral_modules_use_package_imports(self):
        from remotion_editorial_director import audio, core, detectors, review_sampling
        from remotion_editorial_director.verification import (
            analysis,
            review_assets,
            semantic_outlines,
        )

        self.assertTrue(callable(core.parse_srt))
        self.assertTrue(callable(audio.compute_audio_features))
        self.assertTrue(callable(detectors.compute_frame_features))
        self.assertTrue(callable(review_sampling.build_review_unit_plan))
        self.assertTrue(callable(analysis.verify_artifact_record))
        self.assertTrue(callable(review_assets.verify_review_assets_directory))
        self.assertTrue(callable(semantic_outlines.verify_semantic_outline))


class CoreRegressionTests(unittest.TestCase):
    def test_parse_srt_preserves_multiline_text_and_clamps_media_end(self):
        from remotion_editorial_director.core import parse_srt

        cues = parse_srt(
            """1
00:00:00,500 --> 00:00:02,000
First line
second line

2
00:00:09,000 --> 00:00:12,000
[Music]
""",
            media_duration_seconds=10.0,
        )

        self.assertEqual(cues[0]["text"], "First line\nsecond line")
        self.assertEqual(cues[1]["endSeconds"], 10.0)
        self.assertEqual(cues[1]["clampReason"], "media_end")

    def test_parse_srt_rejects_cues_outside_media(self):
        from remotion_editorial_director.core import parse_srt

        with self.assertRaisesRegex(ValueError, "non-positive"):
            parse_srt(
                "1\n00:00:11,000 --> 00:00:12,000\nOutside\n",
                media_duration_seconds=10.0,
            )

    def test_coverage_is_contiguous_and_frame_exact(self):
        from remotion_editorial_director.core import build_coverage

        coverage = build_coverage(
            source_id="sample",
            duration_seconds=10.0,
            fps_numerator=30,
            fps_denominator=1,
            subtitle_cues=[
                {"id": "cue-1", "startSeconds": 1.0, "endSeconds": 4.0},
            ],
            visual_event_seconds=[2.0],
            max_segment_seconds=2.0,
        )

        intervals = coverage["intervals"]
        self.assertEqual(intervals[0]["startFrame"], 0)
        self.assertEqual(intervals[-1]["endFrame"], 300)
        self.assertTrue(
            all(
                left["endFrame"] == right["startFrame"]
                for left, right in zip(intervals, intervals[1:])
            )
        )


class ProviderNeutralBehaviorTests(unittest.TestCase):
    def test_detector_and_audio_functions_execute_through_package_namespace(self):
        import numpy as np

        from remotion_editorial_director.audio import compute_audio_features
        from remotion_editorial_director.detectors import compute_frame_features

        samples = np.zeros(800, dtype=np.float32)
        features = compute_audio_features(
            samples,
            sample_rate=8000,
            window_seconds=0.05,
            hop_seconds=0.025,
        )
        frame = np.zeros((24, 32, 3), dtype=np.uint8)

        self.assertTrue(features)
        self.assertEqual(compute_frame_features(frame, frame.copy())["pixelDiffMean"], 0.0)

    def test_side_onset_calibration_normalizes_before_peak_picking(self):
        import numpy as np

        from remotion_editorial_director.audio import detect_side_onsets

        sample_rate = 8_000
        stereo = np.zeros((sample_rate * 4, 2), dtype=np.float32)
        for seconds, amplitude, width in (
            (0.4, 0.8, 128),
            (1.2, 0.5, 256),
            (2.0, 0.9, 64),
            (3.2, 0.35, 200),
        ):
            start = int(seconds * sample_rate)
            pulse = amplitude * np.hanning(width).astype(np.float32)
            stereo[start : start + width, 0] += pulse
            stereo[start : start + width, 1] -= pulse

        centered = 0.02 * np.sin(
            2 * np.pi * 180 * np.arange(len(stereo)) / sample_rate
        ).astype(np.float32)
        stereo[:, 0] += centered
        stereo[:, 1] += centered

        analysis = detect_side_onsets(
            stereo,
            sample_rate=sample_rate,
            hop_length=256,
            delta=0.30,
            wait=5,
            target_density_per_minute=(20.0, 100.0),
            delta_bounds=(0.20, 0.40),
            delta_step=0.02,
        )

        calibration = {
            round(float(entry["delta"]), 2): int(entry["eventCount"])
            for entry in analysis["deltaCalibration"]
        }
        self.assertEqual(calibration[0.20], 4)
        self.assertEqual(calibration[0.30], 2)
        self.assertEqual(analysis["selectedDelta"], 0.30)
        self.assertEqual(
            [event["frameIndex"] for event in analysis["events"]],
            [14, 63],
        )

    def test_review_sampling_plan_and_verifier_are_package_local(self):
        from remotion_editorial_director.review_sampling import build_review_unit_plan
        from remotion_editorial_director.verification.analysis import validate_candidate_events

        candidate_payload = {
            "schemaVersion": "candidate-events-v1",
            "sourceId": "sample",
            "analysisDigest": "d" * 64,
            "events": [
                {
                    "id": "candidate-1",
                    "timeSeconds": 1.0,
                    "candidateLevel": "audio_beat_candidate",
                    "evidence": [{"detector": "test"}],
                }
            ],
            "reviewWindows": [
                {
                    "startSeconds": 0.5,
                    "endSeconds": 1.5,
                    "candidateIds": ["candidate-1"],
                }
            ],
        }
        source = {
            "id": "sample",
            "formatDurationSeconds": 2.0,
            "video": {
                "duration": 2.0,
                "start": 0.0,
                "fps": {"numerator": 20, "denominator": 1},
            },
        }

        plan = build_review_unit_plan(candidate_payload, source)

        self.assertEqual(plan["sourceId"], "sample")
        self.assertEqual(validate_candidate_events(candidate_payload["events"]), [])


class JsonWorkerTests(unittest.TestCase):
    def _run_worker(self, requests: list[dict[str, object]]) -> list[dict[str, object]]:
        environment = os.environ.copy()
        environment["PYTHONPATH"] = os.pathsep.join(
            [str(PACKAGE_ROOT), environment.get("PYTHONPATH", "")]
        ).rstrip(os.pathsep)
        process = subprocess.run(
            [sys.executable, "-m", "remotion_editorial_director.workers.json_worker"],
            input="".join(json.dumps(request) + "\n" for request in requests),
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stderr, "")
        return [json.loads(line) for line in process.stdout.splitlines() if line.strip()]

    def test_worker_returns_json_result_for_parse_srt(self):
        responses = self._run_worker(
            [
                {
                    "operation": "parse_srt",
                    "text": "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
                    "mediaDurationSeconds": 1.0,
                }
            ]
        )

        self.assertEqual(responses[0]["ok"], True)
        self.assertEqual(responses[0]["result"][0]["text"], "Hello")

    def test_worker_serializes_errors_without_tracebacks(self):
        responses = self._run_worker([{"operation": "parse_srt", "text": "bad"}])

        self.assertEqual(responses[0]["ok"], False)
        self.assertEqual(responses[0]["error"]["type"], "ValueError")
        self.assertIn("media duration", responses[0]["error"]["message"])

    def test_worker_accepts_nested_params_and_operation_aliases(self):
        responses = self._run_worker(
            [
                {
                    "op": "parse-srt",
                    "params": {
                        "text": "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
                        "media_duration_seconds": 1.0,
                    },
                }
            ]
        )

        self.assertEqual(responses[0]["ok"], True)
        self.assertEqual(responses[0]["result"][0]["index"], 1)


class LockfileTests(unittest.TestCase):
    def test_requirements_lock_is_pinned_and_portable(self):
        lockfile = PACKAGE_ROOT / "requirements.lock"
        lines = [line.strip() for line in lockfile.read_text(encoding="utf-8").splitlines()]
        requirements = [
            line
            for line in lines
            if line and not line.startswith("#") and not line.startswith("--hash=")
        ]

        self.assertTrue(requirements)
        self.assertTrue(all("==" in requirement for requirement in requirements))
        self.assertTrue(all("/Users/" not in requirement for requirement in requirements))
        self.assertTrue(all("../" not in requirement for requirement in requirements))
        hashes = [line for line in lines if line.startswith("--hash=sha256:")]
        self.assertGreaterEqual(len(hashes), len(requirements))
        self.assertTrue(
            all(
                len(line.removeprefix("--hash=sha256:").rstrip(" " + chr(92))) == 64
                for line in hashes
            )
        )

    def test_python_package_has_no_project_specific_default_paths(self):
        source_root = PACKAGE_ROOT / "remotion_editorial_director"
        source = "\n".join(
            path.read_text(encoding="utf-8")
            for path in source_root.rglob("*.py")
        )
        self.assertNotIn('Path("docs/editorial-grammar/', source)
        self.assertNotIn('Path("tmp/editorial-analysis/', source)


if __name__ == "__main__":
    unittest.main()
