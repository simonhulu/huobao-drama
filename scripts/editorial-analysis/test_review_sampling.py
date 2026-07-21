import json
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from review_sampling import (  # noqa: E402
    build_review_unit_plan,
    build_sampling_adequacy_report,
    main,
)


def source_fixture() -> dict:
    return {
        "id": "sample",
        "formatDurationSeconds": 12.0,
        "video": {
            "duration": 12.0,
            "start": 0.0,
            "fps": {"numerator": 20, "denominator": 1},
        },
    }


def candidate_fixture(times: list[float]) -> dict:
    events = [
        {
            "id": f"candidate-{index:02d}",
            "timeSeconds": time_seconds,
        }
        for index, time_seconds in enumerate(times, start=1)
    ]
    return {
        "schemaVersion": "candidate-events-v1",
        "sourceId": "sample",
        "analysisDigest": "d" * 64,
        "events": events,
        "reviewWindows": [
            {
                "startSeconds": max(0.0, min(times) - 0.5),
                "endSeconds": min(12.0, max(times) + 0.5),
                "candidateIds": [event["id"] for event in events],
            }
        ],
    }


class ReviewUnitPlanningTests(unittest.TestCase):
    def test_splits_a_chained_window_and_makes_every_unit_auditable(self):
        candidates = candidate_fixture(
            [1.0, 1.4, 1.8, 2.2, 2.6, 3.0, 3.4, 3.8, 4.2, 4.6]
        )

        plan = build_review_unit_plan(candidates, source_fixture())
        report = build_sampling_adequacy_report(candidates, source_fixture(), plan)

        self.assertEqual(plan["counts"]["reviewUnits"], 3)
        self.assertEqual(plan["counts"]["rawCandidates"], 10)
        self.assertEqual(
            [candidate_id for unit in plan["units"] for candidate_id in unit["candidateIds"]],
            [event["id"] for event in candidates["events"]],
        )
        self.assertTrue(
            all(len(unit["samples"]) == 5 for unit in plan["units"])
        )
        self.assertTrue(
            all(
                len({sample["frameIndex"] for sample in unit["samples"]}) == 5
                for unit in plan["units"]
            )
        )
        self.assertEqual(report["legacyMergedWindows"]["status"], "failed")
        self.assertGreater(
            report["legacyMergedWindows"]["counts"]["collisionIntervals"], 0
        )
        self.assertEqual(report["plannedReviewUnits"]["status"], "passed")
        self.assertEqual(
            report["plannedReviewUnits"]["counts"]["collisionIntervals"], 0
        )

    def test_groups_candidates_that_are_not_separable_at_source_fps(self):
        candidates = candidate_fixture([1.0, 1.01, 1.4])

        plan = build_review_unit_plan(candidates, source_fixture())
        report = build_sampling_adequacy_report(candidates, source_fixture(), plan)

        targets = plan["units"][0]["observationTargets"]
        self.assertEqual(targets[0]["candidateIds"], ["candidate-01", "candidate-02"])
        self.assertEqual(targets[0]["separability"], "coincident_same_decoded_frame")
        self.assertEqual(plan["counts"]["coincidentSameFrameGroups"], 1)
        self.assertEqual(report["plannedReviewUnits"]["status"], "passed")

    def test_directly_samples_every_observation_target_anchor(self):
        candidates = candidate_fixture([1.0, 1.4, 1.8, 2.2])

        plan = build_review_unit_plan(candidates, source_fixture())

        unit = plan["units"][0]
        sample_frames = {sample["frameIndex"] for sample in unit["samples"]}
        self.assertEqual(
            [target["anchorFrameIndex"] for target in unit["observationTargets"]],
            [20, 28, 36, 44],
        )
        self.assertTrue(
            all(
                target["anchorFrameIndex"] in sample_frames
                for target in unit["observationTargets"]
            )
        )

    def test_allows_a_final_target_on_the_last_source_frame(self):
        candidates = candidate_fixture([11.95])

        plan = build_review_unit_plan(candidates, source_fixture())

        unit = plan["units"][0]
        self.assertEqual(unit["observationTargets"][0]["anchorFrameIndex"], 239)
        self.assertEqual(unit["samples"][-1]["frameIndex"], 239)
        self.assertEqual(
            build_sampling_adequacy_report(candidates, source_fixture(), plan)[
                "plannedReviewUnits"
            ]["status"],
            "passed",
        )

    def test_preserves_parent_window_trace_and_has_a_deterministic_digest(self):
        candidates = candidate_fixture([1.0, 1.4, 1.8, 2.2, 2.6])

        first = build_review_unit_plan(candidates, source_fixture())
        second = build_review_unit_plan(candidates, source_fixture())

        self.assertEqual(first["planDigest"], second["planDigest"])
        self.assertEqual(
            {unit["parentReviewWindowId"] for unit in first["units"]},
            {"review-window-000001"},
        )

        tampered = json.loads(json.dumps(first))
        tampered["units"][0]["candidateIds"].reverse()
        with self.assertRaisesRegex(ValueError, "plan digest mismatch"):
            build_sampling_adequacy_report(candidates, source_fixture(), tampered)

    def test_cli_writes_plan_and_audit_without_mutating_candidate_events(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            analysis = root / "analysis"
            analysis.mkdir()
            candidates = candidate_fixture([1.0, 1.4, 1.8, 2.2, 2.6])
            candidate_path = analysis / "candidate-events.json"
            original = json.dumps(candidates, sort_keys=True)
            candidate_path.write_text(original, encoding="utf-8")
            manifest = root / "corpus-manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": "corpus-manifest-v1",
                        "sources": [source_fixture()],
                    }
                ),
                encoding="utf-8",
            )

            exit_code = main(
                [
                    "--manifest",
                    str(manifest),
                    "--source",
                    "sample",
                    "--analysis-directory",
                    str(analysis),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertTrue((analysis / "review-unit-plan.json").is_file())
            report = json.loads(
                (analysis / "review-sampling-adequacy.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(report["status"], "passed")
            self.assertEqual(candidate_path.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
