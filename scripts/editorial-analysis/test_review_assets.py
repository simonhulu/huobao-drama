import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parent))

from review_assets import (  # noqa: E402
    FRAME_HEIGHT,
    FRAME_WIDTH,
    TIMECODE_HEIGHT,
    _partition_frame_indices,
    _select_filter,
    classify_camera_family_candidate,
    compose_review_strip,
    main,
    plan_review_samples,
    plan_target_sequence_frames,
    stream_selected_frames,
)
from verify_review_assets import verify_review_assets_directory  # noqa: E402


class ReviewSamplePlanningTests(unittest.TestCase):
    def test_plans_five_evenly_spaced_samples_for_each_window(self):
        planned = plan_review_samples(
            [
                {
                    "startSeconds": 1.0,
                    "endSeconds": 3.0,
                    "candidateIds": ["candidate-1", "candidate-2"],
                },
                {
                    "startSeconds": 4.5,
                    "endSeconds": 5.0,
                    "candidateIds": ["candidate-3"],
                },
            ],
            duration_seconds=6.0,
        )

        self.assertEqual(len(planned), 2)
        self.assertEqual(planned[0]["id"], "review-window-000001")
        self.assertEqual(planned[0]["candidateIds"], ["candidate-1", "candidate-2"])
        self.assertEqual(
            [sample["timeSeconds"] for sample in planned[0]["samples"]],
            [1.0, 1.5, 2.0, 2.5, 3.0],
        )
        self.assertEqual(len(planned[1]["samples"]), 5)

    def test_preserves_explicit_candidate_aware_samples_and_unit_ids(self):
        observation_target = {
            "id": "observation-target-000001",
            "candidateIds": ["candidate-1", "candidate-2"],
            "candidateTimesSeconds": [1.4, 1.6],
            "anchorFrameIndex": 30,
            "anchorTimeSeconds": 1.5,
            "intervalIndex": 1,
            "previousSampleIndex": 1,
            "currentSampleIndex": 2,
            "separability": "coincident_same_decoded_frame",
        }
        planned = plan_review_samples(
            [
                {
                    "id": "review-unit-000001",
                    "parentReviewWindowId": "review-window-000036",
                    "startSeconds": 1.0,
                    "endSeconds": 2.0,
                    "candidateIds": ["candidate-1", "candidate-2"],
                    "observationTargets": [observation_target],
                    "samples": [
                        {"index": index, "timeSeconds": 1.0 + index * 0.25, "frameIndex": 20 + index * 5}
                        for index in range(5)
                    ],
                }
            ],
            duration_seconds=3.0,
        )

        self.assertEqual(planned[0]["id"], "review-unit-000001")
        self.assertEqual(planned[0]["parentReviewWindowId"], "review-window-000036")
        self.assertEqual(planned[0]["observationTargets"], [observation_target])
        self.assertEqual(
            [sample["plannedFrameIndex"] for sample in planned[0]["samples"]],
            [20, 25, 30, 35, 40],
        )

    def test_partitions_selection_before_filter_limit(self):
        indices = [0, 20, 40, 60, 80, 100]
        two_frame_limit = len(_select_filter([0, 20]).encode("utf-8"))

        chunks = _partition_frame_indices(
            indices,
            maximum_filter_bytes=two_frame_limit,
        )

        self.assertEqual(chunks, [[0, 20], [40, 60], [80, 100]])


class TargetSequencePlanningTests(unittest.TestCase):
    def test_centers_five_frames_on_anchor_at_three_frame_steps(self):
        self.assertEqual(
            plan_target_sequence_frames(anchor_frame_index=12, frame_count=30),
            [6, 9, 12, 15, 18],
        )

    def test_spills_samples_to_available_side_near_video_boundaries(self):
        self.assertEqual(
            plan_target_sequence_frames(anchor_frame_index=1, frame_count=30),
            [1, 4, 7, 10, 13],
        )
        self.assertEqual(
            plan_target_sequence_frames(anchor_frame_index=28, frame_count=30),
            [16, 19, 22, 25, 28],
        )


class ReviewStripTests(unittest.TestCase):
    def test_strip_has_fixed_dimensions_for_any_input_frame_size(self):
        frames = [
            np.full((40 + index, 70 + index, 3), index * 30, dtype=np.uint8)
            for index in range(5)
        ]

        strip = compose_review_strip(frames, [0.0, 0.25, 0.5, 0.75, 1.0])

        self.assertEqual(
            strip.shape,
            (FRAME_HEIGHT + TIMECODE_HEIGHT, FRAME_WIDTH * 5, 3),
        )


class CameraCandidateTests(unittest.TestCase):
    def test_classifies_pan_and_push_in_candidates(self):
        common = {
            "resolved": True,
            "trackedPoints": 80,
            "inlierRatio": 0.92,
            "rotationDegrees": 0.2,
            "medianResidualPixels": 0.3,
        }

        pan = classify_camera_family_candidate(
            {
                **common,
                "dxNormalized": 0.035,
                "dyNormalized": 0.002,
                "scale": 1.001,
            }
        )
        push = classify_camera_family_candidate(
            {
                **common,
                "dxNormalized": 0.001,
                "dyNormalized": 0.001,
                "scale": 1.035,
            }
        )

        self.assertEqual(pan, "pan_candidate")
        self.assertEqual(push, "push_in_candidate")


class ReviewAssetsIntegrationTests(unittest.TestCase):
    def test_chunked_seek_matches_single_pass_frames(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video_path = root / "sample.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=160x90:rate=10:duration=4",
                    "-c:v",
                    "mpeg4",
                    "-q:v",
                    "2",
                    "-pix_fmt",
                    "yuv420p",
                    "-y",
                    str(video_path),
                ],
                check=True,
            )
            indices = [0, 3, 7, 12, 19, 25, 31, 39]
            single_pass: dict[int, np.ndarray] = {}
            chunked: dict[int, np.ndarray] = {}

            single_pass_count = stream_selected_frames(
                video_path,
                indices,
                lambda index, frame: single_pass.__setitem__(index, frame.copy()),
                temporary_directory=root,
                fps_numerator=10,
                fps_denominator=1,
                maximum_filter_bytes=1_000_000,
            )
            two_frame_limit = len(_select_filter([0, 3]).encode("utf-8"))
            chunked_count = stream_selected_frames(
                video_path,
                indices,
                lambda index, frame: chunked.__setitem__(index, frame.copy()),
                temporary_directory=root,
                fps_numerator=10,
                fps_denominator=1,
                maximum_filter_bytes=two_frame_limit,
            )

            self.assertEqual(single_pass_count, 1)
            self.assertGreater(chunked_count, 1)
            self.assertEqual(single_pass.keys(), chunked.keys())
            for frame_index in indices:
                np.testing.assert_array_equal(single_pass[frame_index], chunked[frame_index])

    def test_two_second_video_generates_all_review_assets_in_one_decode_pass(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video_path = root / "sample.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=160x90:rate=10:duration=2",
                    "-c:v",
                    "mpeg4",
                    "-q:v",
                    "2",
                    "-pix_fmt",
                    "yuv420p",
                    "-y",
                    str(video_path),
                ],
                check=True,
            )

            manifest_path = root / "corpus-manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "corpus-manifest-v1",
                        "sources": [
                            {
                                "id": "sample",
                                "formatDurationSeconds": 2.0,
                                "mp4": {"path": str(video_path)},
                                "video": {
                                    "duration": 2.0,
                                    "start": 0.0,
                                    "width": 160,
                                    "height": 90,
                                    "fps": {"numerator": 10, "denominator": 1},
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            analysis_directory = root / "analysis"
            analysis_directory.mkdir()
            (analysis_directory / "candidate-events.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": "candidate-events-v1",
                        "sourceId": "sample",
                        "analysisDigest": "d" * 64,
                        "events": [
                            {
                                "id": "sample-candidate-000001",
                                "timeSeconds": 0.75,
                            }
                        ],
                        "reviewWindows": [
                            {
                                "startSeconds": 0.25,
                                "endSeconds": 1.25,
                                "candidateIds": ["sample-candidate-000001"],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            review_unit = {
                "id": "review-unit-000001",
                "parentReviewWindowId": "review-window-000001",
                "startSeconds": 0.3,
                "endSeconds": 1.3,
                "candidateIds": ["sample-candidate-000001"],
                "observationTargets": [
                    {
                        "id": "observation-target-000001",
                        "candidateIds": ["sample-candidate-000001"],
                        "candidateTimesSeconds": [0.75],
                        "anchorFrameIndex": 8,
                        "anchorTimeSeconds": 0.8,
                        "intervalIndex": 1,
                        "previousSampleIndex": 1,
                        "currentSampleIndex": 2,
                        "separability": "independent",
                    }
                ],
                "samples": [
                    {"index": 0, "timeSeconds": 0.3, "frameIndex": 3},
                    {"index": 1, "timeSeconds": 0.5, "frameIndex": 5},
                    {"index": 2, "timeSeconds": 0.8, "frameIndex": 8},
                    {"index": 3, "timeSeconds": 1.0, "frameIndex": 10},
                    {"index": 4, "timeSeconds": 1.3, "frameIndex": 13},
                ],
            }
            configuration = {
                "samplesPerReviewUnit": 5,
                "maximumTargetsPerReviewUnit": 4,
                "contextSeconds": 0.5,
                "contextFrames": 5,
                "maximumTargetSpanSeconds": 2.0,
                "maximumTargetSpanFrames": 20,
                "sameFramePolicy": "coalesce",
                "fpsNumerator": 10,
                "fpsDenominator": 1,
            }
            digest_payload = {
                "sourceId": "sample",
                "analysisDigest": "d" * 64,
                "configuration": configuration,
                "units": [review_unit],
            }
            review_unit_plan_path = analysis_directory / "review-unit-plan.json"
            review_unit_plan_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": "review-unit-plan-v1",
                        **digest_payload,
                        "planDigest": hashlib.sha256(
                            json.dumps(
                                digest_payload,
                                ensure_ascii=False,
                                separators=(",", ":"),
                                sort_keys=True,
                            ).encode("utf-8")
                        ).hexdigest(),
                        "counts": {
                            "parentReviewWindows": 1,
                            "reviewUnits": 1,
                            "rawCandidates": 1,
                            "observationTargets": 1,
                            "coincidentSameFrameGroups": 0,
                            "reviewSamples": 5,
                        },
                    }
                ),
                encoding="utf-8",
            )
            output_directory = root / "tmp" / "review-assets"

            exit_code = main(
                [
                    "--manifest",
                    str(manifest_path),
                    "--source",
                    "sample",
                    "--analysis-directory",
                    str(analysis_directory),
                    "--output-directory",
                    str(output_directory),
                    "--review-unit-plan",
                    str(review_unit_plan_path),
                ]
            )

            self.assertEqual(exit_code, 0)
            result = json.loads(
                (output_directory / "review-assets-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["schemaVersion"], "review-assets-manifest-v2")
            self.assertEqual(result["status"], "complete")
            self.assertEqual(result["configuration"]["targetSequenceSamples"], 5)
            self.assertEqual(result["configuration"]["targetSequenceFrameStep"], 3)
            self.assertEqual(result["counts"]["ffmpegDecodePasses"], 1)
            self.assertEqual(result["counts"]["reviewWindows"], 1)
            self.assertEqual(result["counts"]["reviewUnits"], 1)
            self.assertEqual(result["counts"]["reviewSamples"], 5)
            self.assertEqual(result["counts"]["reviewFrames"], 5)
            self.assertEqual(result["counts"]["targetSequences"], 1)
            self.assertEqual(result["counts"]["targetSequenceSamples"], 5)
            self.assertEqual(result["counts"]["targetFrames"], 5)
            self.assertEqual(result["counts"]["decodedUniqueFrames"], 9)
            self.assertEqual(result["counts"]["fineEvidenceRecords"], 4)
            self.assertEqual(result["counts"]["overviewSamples"], 1)

            strip_record = result["artifacts"]["reviewStrips"][0]
            self.assertEqual(strip_record["reviewWindowId"], "review-unit-000001")
            self.assertEqual(
                strip_record["parentReviewWindowId"], "review-window-000001"
            )
            strip_path = Path(strip_record["path"])
            strip = cv2.imread(str(strip_path), cv2.IMREAD_COLOR)
            self.assertIsNotNone(strip)
            self.assertEqual(
                strip.shape,
                (FRAME_HEIGHT + TIMECODE_HEIGHT, FRAME_WIDTH * 5, 3),
            )
            frame_records = strip_record["samples"]
            self.assertEqual(
                [Path(record["path"]).name for record in frame_records],
                [
                    f"review-unit-000001-frame-{index:02d}.jpg"
                    for index in range(1, 6)
                ],
            )
            self.assertEqual(
                [record["sampleIndex"] for record in frame_records],
                list(range(5)),
            )
            for record in frame_records:
                frame_path = Path(record["path"])
                frame = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
                self.assertIsNotNone(frame)
                self.assertEqual(
                    frame.shape,
                    (FRAME_HEIGHT + TIMECODE_HEIGHT, FRAME_WIDTH, 3),
                )
                self.assertGreater(np.count_nonzero(frame[FRAME_HEIGHT:]), 0)
                self.assertEqual(record["bytes"], frame_path.stat().st_size)
                self.assertEqual(
                    record["sha256"],
                    hashlib.sha256(frame_path.read_bytes()).hexdigest(),
                )

            target_record = result["artifacts"]["targetSequences"][0]
            self.assertEqual(target_record["reviewWindowId"], "review-unit-000001")
            self.assertEqual(target_record["targetId"], "observation-target-000001")
            self.assertEqual(target_record["targetProvenance"], review_unit["observationTargets"][0])
            self.assertEqual(
                [sample["frameIndex"] for sample in target_record["samples"]],
                [2, 5, 8, 11, 14],
            )
            self.assertEqual(
                [sample["frameOffset"] for sample in target_record["samples"]],
                [-6, -3, 0, 3, 6],
            )
            for sample_index, record in enumerate(target_record["samples"], start=1):
                frame_path = Path(record["path"])
                self.assertEqual(
                    frame_path,
                    (
                        output_directory
                        / "target-sequences"
                        / "review-unit-000001"
                        / f"observation-target-000001-frame-{sample_index:02d}.jpg"
                    ).resolve(),
                )
                frame = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
                self.assertIsNotNone(frame)
                self.assertEqual(
                    frame.shape,
                    (FRAME_HEIGHT + TIMECODE_HEIGHT, FRAME_WIDTH, 3),
                )
                self.assertGreater(np.count_nonzero(frame[FRAME_HEIGHT:]), 0)
                self.assertEqual(record["bytes"], frame_path.stat().st_size)
                self.assertEqual(
                    record["sha256"],
                    hashlib.sha256(frame_path.read_bytes()).hexdigest(),
                )
            overview_path = Path(result["artifacts"]["overviewContactSheets"][0]["path"])
            self.assertTrue(overview_path.is_file())

            evidence_lines = [
                json.loads(line)
                for line in (output_directory / "fine-evidence.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            self.assertEqual(len(evidence_lines), 4)
            self.assertIn("frameFeatures", evidence_lines[0])
            self.assertIn("cameraTransform", evidence_lines[0])
            self.assertIn("cameraFamilyCandidate", evidence_lines[0])
            self.assertNotIn("technique", evidence_lines[0])
            self.assertFalse(list(output_directory.rglob(".*.tmp")))

            verification = verify_review_assets_directory(output_directory)
            self.assertEqual(verification["status"], "passed")
            self.assertEqual(verification["errors"], [])


if __name__ == "__main__":
    unittest.main()
