import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_vlm_review_input as builder  # noqa: E402


class VlmReviewInputBuilderTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name)
        self.analysis_directory = self.root / "analysis"
        self.assets_directory = self.analysis_directory / "review-assets"
        self.output_path = self.root / "requests" / "vlm-review-input.json"
        self.analysis_directory.mkdir()
        self.assets_directory.mkdir()
        self._write_valid_inputs()

    def _write_json(self, path: Path, payload: object) -> None:
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _read_json(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_valid_inputs(self) -> None:
        source_id = "sample-source"
        digest = "d" * 64
        candidate_id = "sample-candidate-000001"
        self._write_json(
            self.analysis_directory / "candidate-events.json",
            {
                "schemaVersion": "candidate-events-v1",
                "sourceId": source_id,
                "analysisDigest": digest,
                "events": [
                    {
                        "id": candidate_id,
                        "timeSeconds": 1.0,
                        "score": 0.82,
                        "candidateLevel": "setup_boundary_candidate",
                        "family": "multi_candidate",
                        "detectors": ["ffmpeg_scene", "stereo_side_onset"],
                        "families": [
                            "audio_onset_candidate",
                            "visual_reset_candidate",
                        ],
                        "evidence": [
                            {
                                "timeSeconds": 1.0,
                                "detector": "ffmpeg_scene",
                                "family": "visual_reset_candidate",
                                "tier": "strong",
                                "candidateLevel": "must-not-leak",
                                "families": ["must-not-leak"],
                                "score": 0.82,
                                "adaptiveThreshold": 0.75,
                                "measurements": {"maxSceneScore": 0.82},
                            },
                            {
                                "timeSeconds": 1.02,
                                "detector": "stereo_side_onset",
                                "family": "audio_onset_candidate",
                                "score": 0.61,
                            },
                        ],
                    }
                ],
                "reviewWindows": [
                    {
                        "startSeconds": 0.5,
                        "endSeconds": 1.5,
                        "candidateIds": [candidate_id],
                    }
                ],
            },
        )
        self._write_json(
            self.analysis_directory / "subtitles.json",
            {
                "schemaVersion": "normalized-subtitles-v1",
                "sourceId": source_id,
                "mediaDurationSeconds": 4.0,
                "cues": [
                    {"id": "cue-1", "startSeconds": 0.0, "endSeconds": 0.1, "text": "far before"},
                    {"id": "cue-2", "startSeconds": 0.2, "endSeconds": 0.4, "text": "previous"},
                    {"id": "cue-3", "startSeconds": 0.8, "endSeconds": 1.2, "text": "overlap"},
                    {"id": "cue-4", "startSeconds": 1.6, "endSeconds": 1.8, "text": "next"},
                    {"id": "cue-5", "startSeconds": 3.0, "endSeconds": 3.5, "text": "far after"},
                ],
            },
        )
        self._write_json(
            self.analysis_directory / "audio-evidence.json",
            {
                "sampleRate": 22050,
                "events": [
                    self._audio_event(0.2, 0.4),
                    self._audio_event(1.0, 0.9),
                    self._audio_event(1.8, 0.5),
                    self._audio_event(2.1, 0.7),
                ],
            },
        )

        strip_path = self.assets_directory / "review-strips" / "review-window-000001.jpg"
        strip_path.parent.mkdir(exist_ok=True)
        strip_path.write_bytes(b"\xff\xd8\xff\xd9")
        frames_directory = self.assets_directory / "review-frames" / "review-window-000001"
        frames_directory.mkdir(parents=True, exist_ok=True)
        samples = []
        for sample_index in range(5):
            frame_path = frames_directory / f"sample-{sample_index:02d}.jpg"
            frame_bytes = b"\xff\xd8\xff" + bytes([sample_index])
            frame_path.write_bytes(frame_bytes)
            samples.append(
                {
                    **self._sample_reference(sample_index),
                    "path": str(frame_path.resolve()),
                    "bytes": len(frame_bytes),
                    "sha256": hashlib.sha256(frame_bytes).hexdigest(),
                }
            )
        self._write_json(
            self.assets_directory / "review-assets-manifest.json",
            {
                "schemaVersion": "review-assets-manifest-v1",
                "status": "complete",
                "sourceId": source_id,
                "analysisDigest": digest,
                "configuration": {"reviewSamplesPerWindow": 5},
                "counts": {"reviewFrames": 5},
                "artifacts": {
                    "reviewStrips": [
                        {
                            "reviewWindowId": "review-window-000001",
                            "startSeconds": 0.5,
                            "endSeconds": 1.5,
                            "candidateIds": [candidate_id],
                            "path": str(strip_path.resolve()),
                            "samples": samples,
                        }
                    ]
                },
            },
        )
        records = [self._fine_evidence(pair_index) for pair_index in (3, 1, 4, 2)]
        (self.assets_directory / "fine-evidence.jsonl").write_text(
            "".join(json.dumps(record, sort_keys=True) + "\n" for record in records),
            encoding="utf-8",
        )
        self._enable_review_unit_plan()

    def _enable_review_unit_plan(self) -> str:
        plan_path = self.analysis_directory / "review-unit-plan.json"
        samples = [
            {
                "index": index,
                "timeSeconds": reference["requestedTimeSeconds"],
                "frameIndex": reference["frameIndex"],
            }
            for index in range(5)
            for reference in [self._sample_reference(index)]
        ]
        observation_target = {
            "id": "observation-target-000001",
            "candidateIds": ["sample-candidate-000001"],
            "candidateTimesSeconds": [1.0],
            "anchorFrameIndex": 11,
            "anchorTimeSeconds": 1.0,
            "intervalIndex": 1,
            "previousSampleIndex": 1,
            "currentSampleIndex": 2,
            "separability": "independent",
        }
        unit = {
            "id": "review-unit-000001",
            "parentReviewWindowId": "review-window-000001",
            "startSeconds": 0.5,
            "endSeconds": 1.5,
            "candidateIds": ["sample-candidate-000001"],
            "observationTargets": [observation_target],
            "samples": samples,
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
            "sourceId": "sample-source",
            "analysisDigest": "d" * 64,
            "configuration": configuration,
            "units": [unit],
        }
        plan_digest = hashlib.sha256(
            json.dumps(
                digest_payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        self._write_json(
            plan_path,
            {
                "schemaVersion": "review-unit-plan-v1",
                **digest_payload,
                "planDigest": plan_digest,
                "counts": {
                    "parentReviewWindows": 1,
                    "reviewUnits": 1,
                    "rawCandidates": 1,
                    "observationTargets": 1,
                    "coincidentSameFrameGroups": 0,
                    "reviewSamples": 5,
                },
            },
        )
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        manifest["schemaVersion"] = "review-assets-manifest-v2"
        manifest["configuration"].update(
            {"targetSequenceSamples": 5, "targetSequenceFrameStep": 3}
        )
        manifest["inputs"] = {
            "reviewUnitPlan": {
                "path": str(plan_path.resolve()),
                "bytes": plan_path.stat().st_size,
                "sha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
            }
        }
        strip = manifest["artifacts"]["reviewStrips"][0]
        strip["reviewWindowId"] = unit["id"]
        strip["parentReviewWindowId"] = unit["parentReviewWindowId"]
        target_samples = []
        target_directory = (
            self.assets_directory / "target-sequences" / unit["id"]
        )
        target_directory.mkdir(parents=True, exist_ok=True)
        for sample_index, reference in enumerate(samples):
            target_path = target_directory / f"{observation_target['id']}-frame-{sample_index + 1:02d}.jpg"
            target_bytes = b"\xff\xd8\xff" + bytes([sample_index + 16])
            target_path.write_bytes(target_bytes)
            target_samples.append(
                {
                    "sampleIndex": sample_index,
                    "frameOffset": reference["frameIndex"]
                    - observation_target["anchorFrameIndex"],
                    "requestedTimeSeconds": reference["timeSeconds"],
                    "decodedTimeSeconds": reference["timeSeconds"],
                    "frameIndex": reference["frameIndex"],
                    "path": str(target_path.resolve()),
                    "bytes": len(target_bytes),
                    "sha256": hashlib.sha256(target_bytes).hexdigest(),
                }
            )
        manifest["artifacts"]["targetSequences"] = [
            {
                "reviewWindowId": unit["id"],
                "targetId": observation_target["id"],
                "targetProvenance": observation_target,
                "samples": target_samples,
            }
        ]
        manifest["counts"].update(
            {
                "targetSequences": 1,
                "targetSequenceSamples": 5,
                "targetFrames": 5,
            }
        )
        self._write_json(manifest_path, manifest)
        fine_path = self.assets_directory / "fine-evidence.jsonl"
        fine_records = [
            json.loads(line) for line in fine_path.read_text(encoding="utf-8").splitlines()
        ]
        for record in fine_records:
            record["reviewWindowId"] = unit["id"]
            record["parentReviewWindowId"] = unit["parentReviewWindowId"]
        fine_path.write_text(
            "".join(json.dumps(record, sort_keys=True) + "\n" for record in fine_records),
            encoding="utf-8",
        )
        return plan_digest

    @staticmethod
    def _audio_event(time_seconds: float, score: float) -> dict:
        return {
            "timeSeconds": time_seconds,
            "detector": "stereo_side_onset",
            "family": "audio_onset_candidate",
            "score": score,
            "measurements": {"onsetStrength": score * 10},
        }

    @staticmethod
    def _sample_reference(sample_index: int) -> dict:
        return {
            "sampleIndex": sample_index,
            "requestedTimeSeconds": 0.5 + sample_index * 0.25,
            "decodedTimeSeconds": 0.5 + sample_index * 0.25,
            "frameIndex": 5 + sample_index * 3,
        }

    @staticmethod
    def _fine_evidence(pair_index: int) -> dict:
        return {
            "schemaVersion": "fine-evidence-v1",
            "id": f"sample-fine-{pair_index}",
            "sourceId": "sample-source",
            "analysisDigest": "d" * 64,
            "reviewWindowId": "review-window-000001",
            "candidateIds": ["sample-candidate-000001"],
            "pairIndex": pair_index,
            "previousFrame": VlmReviewInputBuilderTests._sample_reference(pair_index - 1),
            "currentFrame": VlmReviewInputBuilderTests._sample_reference(pair_index),
            "frameFeatures": {"pixelDiffMean": pair_index / 10},
            "cameraTransform": {"resolved": False, "trackedPoints": 0},
            "cameraFamilyCandidate": None,
        }

    def _build(self) -> dict:
        return builder.build_vlm_review_input(
            analysis_directory=self.analysis_directory,
            output_path=self.output_path,
        )

    def test_builds_auditable_review_with_bounded_context(self):
        payload = self._build()

        self.assertEqual(payload["schemaVersion"], "editorial-vlm-review-input-v2")
        self.assertEqual(payload["sourceId"], "sample-source")
        self.assertEqual(self._read_json(self.output_path), payload)
        self.assertEqual(len(payload["reviews"]), 1)

        review = payload["reviews"][0]
        self.assertEqual(review["id"], "review-unit-000001")
        self.assertEqual(review["window"], {"startSeconds": 0.5, "endSeconds": 1.5})
        self.assertEqual(
            [cue["text"] for cue in review["adjacentSubtitles"]],
            ["previous", "overlap", "next"],
        )
        self.assertEqual(len(review["overview"]["imagePaths"]), 5)
        image_paths = [
            (self.output_path.parent / image_path).resolve()
            for image_path in review["overview"]["imagePaths"]
        ]
        self.assertEqual(len(set(image_paths)), 5)
        self.assertTrue(all(image_path.is_file() for image_path in image_paths))
        self.assertEqual(
            review["overview"]["samples"],
            [
                {"index": index, "timeSeconds": 0.5 + index * 0.25, "frameIndex": 5 + index * 3}
                for index in range(5)
            ],
        )
        self.assertEqual(len(review["targets"]), 1)
        target = review["targets"][0]
        self.assertEqual(target["targetRef"]["id"], "observation-target-000001")
        self.assertEqual(target["targetRef"]["anchorFrameIndex"], 11)
        self.assertEqual(target["intervalRef"]["intervalIndex"], 1)
        self.assertEqual(target["intervalRef"]["previousSample"], review["overview"]["samples"][1])
        self.assertEqual(target["intervalRef"]["currentSample"], review["overview"]["samples"][2])
        self.assertEqual(
            [sample["frameIndex"] for sample in target["microSequence"]["samples"]],
            [5, 8, 11, 14, 17],
        )
        self.assertEqual(len(target["microSequence"]["imagePaths"]), 5)
        micro_paths = [
            (self.output_path.parent / image_path).resolve()
            for image_path in target["microSequence"]["imagePaths"]
        ]
        self.assertEqual(len(set([*image_paths, *micro_paths])), 10)
        self.assertTrue(all(image_path.is_file() for image_path in micro_paths))

        evidence = review["machineEvidence"]
        self.assertEqual(evidence["candidateIds"], ["sample-candidate-000001"])
        self.assertEqual(
            evidence["candidates"],
            [
                {
                    "id": "sample-candidate-000001",
                    "timeSeconds": 1.0,
                    "score": 0.82,
                    "detectors": ["ffmpeg_scene", "stereo_side_onset"],
                }
            ],
        )
        self.assertEqual(len(evidence["visual"]), 1)
        visual = evidence["visual"][0]
        self.assertEqual(
            visual,
            {
                "candidateId": "sample-candidate-000001",
                "evidenceIndex": 0,
                "timeSeconds": 1.0,
                "detector": "ffmpeg_scene",
                "score": 0.82,
                "adaptiveThreshold": 0.75,
                "measurements": {"maxSceneScore": 0.82},
            },
        )
        self.assertTrue(
            {"family", "tier", "candidateLevel", "families"}.isdisjoint(visual)
        )
        self.assertEqual(
            [item["timeSeconds"] for item in evidence["audio"]],
            [0.2, 1.0, 1.8],
        )
        self.assertEqual(
            [item["pairIndex"] for item in evidence["fineEvidence"]],
            [1, 2, 3, 4],
        )

    def test_builds_from_a_hashed_candidate_aware_review_unit_plan(self):
        plan_digest = self._enable_review_unit_plan()

        payload = self._build()

        self.assertEqual(payload["reviewPlanDigest"], plan_digest)
        self.assertEqual(payload["reviews"][0]["id"], "review-unit-000001")
        self.assertEqual(
            payload["reviews"][0]["targets"][0]["targetRef"]["anchorFrameIndex"],
            11,
        )

    def test_requires_v2_assets_with_complete_target_sequences(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        manifest["schemaVersion"] = "review-assets-manifest-v1"
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "unsupported review-assets schemaVersion"):
            self._build()

        self._write_valid_inputs()
        manifest = self._read_json(manifest_path)
        manifest["artifacts"]["targetSequences"] = []
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "target sequence ids or order"):
            self._build()

        self._write_valid_inputs()
        manifest = self._read_json(manifest_path)
        manifest["artifacts"]["targetSequences"][0]["targetId"] = "wrong-target"
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "target sequence ids or order"):
            self._build()

    def test_rejects_target_sequence_provenance_and_sampling_mismatches(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        manifest["artifacts"]["targetSequences"][0]["targetProvenance"][
            "anchorFrameIndex"
        ] += 1
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "provenance does not match"):
            self._build()

        self._write_valid_inputs()
        manifest = self._read_json(manifest_path)
        samples = manifest["artifacts"]["targetSequences"][0]["samples"]
        for sample in samples:
            sample["frameIndex"] += 12
            sample["frameOffset"] += 12
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "must contain its anchor frame"):
            self._build()

        self._write_valid_inputs()
        manifest = self._read_json(manifest_path)
        samples = manifest["artifacts"]["targetSequences"][0]["samples"]
        samples[1], samples[2] = samples[2], samples[1]
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "sampleIndex must be 0..4"):
            self._build()

    def test_rejects_source_and_digest_mismatches(self):
        subtitles = self._read_json(self.analysis_directory / "subtitles.json")
        subtitles["sourceId"] = "other-source"
        self._write_json(self.analysis_directory / "subtitles.json", subtitles)
        with self.assertRaisesRegex(ValueError, "subtitles.*sourceId"):
            self._build()

        self._write_valid_inputs()
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        manifest["analysisDigest"] = "e" * 64
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "review-assets.*analysisDigest"):
            self._build()

    def test_rejects_missing_or_duplicate_review_strips(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        original = self._read_json(manifest_path)

        for strips, expected_message in (
            ([], "missing review strip"),
            (original["artifacts"]["reviewStrips"] * 2, "duplicate review strip"),
        ):
            with self.subTest(expected_message=expected_message):
                manifest = json.loads(json.dumps(original))
                manifest["artifacts"]["reviewStrips"] = strips
                self._write_json(manifest_path, manifest)
                with self.assertRaisesRegex(ValueError, expected_message):
                    self._build()

    def test_rejects_unknown_candidate_and_invalid_window(self):
        candidates_path = self.analysis_directory / "candidate-events.json"
        candidates = self._read_json(candidates_path)
        candidates["reviewWindows"][0]["candidateIds"] = ["unknown-candidate"]
        self._write_json(candidates_path, candidates)
        with self.assertRaisesRegex(ValueError, "unknown candidate"):
            self._build()

        self._write_valid_inputs()
        candidates = self._read_json(candidates_path)
        candidates["reviewWindows"][0]["endSeconds"] = 0.5
        self._write_json(candidates_path, candidates)
        with self.assertRaisesRegex(ValueError, "positive duration"):
            self._build()

    def test_requires_exactly_four_fine_evidence_pairs_per_window(self):
        fine_path = self.assets_directory / "fine-evidence.jsonl"
        records = fine_path.read_text(encoding="utf-8").splitlines()
        fine_path.write_text("\n".join(records[:3]) + "\n", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "exactly 4 fine-evidence"):
            self._build()

    def test_rejects_fine_evidence_that_does_not_match_strip_samples(self):
        fine_path = self.assets_directory / "fine-evidence.jsonl"
        records = [json.loads(line) for line in fine_path.read_text(encoding="utf-8").splitlines()]
        records[0]["previousFrame"]["frameIndex"] = 999
        fine_path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "previousFrame does not match review strip"):
            self._build()

    def test_rejects_incomplete_strip_and_fine_sample_references(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        for sample in manifest["artifacts"]["reviewStrips"][0]["samples"]:
            sample.pop("frameIndex")
        self._write_json(manifest_path, manifest)
        fine_path = self.assets_directory / "fine-evidence.jsonl"
        records = [json.loads(line) for line in fine_path.read_text(encoding="utf-8").splitlines()]
        for record in records:
            record["previousFrame"].pop("frameIndex")
            record["currentFrame"].pop("frameIndex")
        fine_path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "sample reference fields are incomplete"):
            self._build()

    def test_rejects_missing_frame_artifact_fields_and_bad_frame_counts(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        manifest["artifacts"]["reviewStrips"][0]["samples"][0].pop("sha256")
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "frame artifact fields are incomplete"):
            self._build()

        self._write_valid_inputs()
        manifest = self._read_json(manifest_path)
        manifest["counts"]["reviewFrames"] = 4
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "reviewFrames count"):
            self._build()

        self._write_valid_inputs()
        manifest = self._read_json(manifest_path)
        manifest["artifacts"]["reviewStrips"][0]["samples"].pop()
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "exactly five frame samples"):
            self._build()

    def test_rejects_duplicate_and_outside_frame_paths(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        samples = manifest["artifacts"]["reviewStrips"][0]["samples"]
        samples[1]["path"] = samples[0]["path"]
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "duplicate review frame path"):
            self._build()

        self._write_valid_inputs()
        outside_path = self.root / "outside.jpg"
        outside_bytes = b"\xff\xd8\xff\x00"
        outside_path.write_bytes(outside_bytes)
        manifest = self._read_json(manifest_path)
        sample = manifest["artifacts"]["reviewStrips"][0]["samples"][0]
        sample.update(
            {
                "path": str(outside_path),
                "bytes": len(outside_bytes),
                "sha256": hashlib.sha256(outside_bytes).hexdigest(),
            }
        )
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "outside review-assets directory"):
            self._build()

    def test_rejects_frame_byte_count_and_hash_mismatches(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        manifest = self._read_json(manifest_path)
        sample = manifest["artifacts"]["reviewStrips"][0]["samples"][0]
        sample["bytes"] += 1
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "frame byte count does not match"):
            self._build()

        self._write_valid_inputs()
        manifest = self._read_json(manifest_path)
        manifest["artifacts"]["reviewStrips"][0]["samples"][0]["sha256"] = "0" * 64
        self._write_json(manifest_path, manifest)
        with self.assertRaisesRegex(ValueError, "frame sha256 does not match"):
            self._build()

    def test_rejects_jpegs_that_the_runner_cannot_read(self):
        manifest_path = self.assets_directory / "review-assets-manifest.json"
        frame_path = (
            self.assets_directory
            / "review-frames"
            / "review-window-000001"
            / "sample-00.jpg"
        )
        for expected_message, size in (
            ("JPEG signature", 3),
            ("JPEG size", 25 * 1024 * 1024 + 1),
        ):
            with self.subTest(expected_message=expected_message):
                with frame_path.open("wb") as handle:
                    handle.write(b"\xff\xd8\xff")
                    handle.truncate(size)
                manifest = self._read_json(manifest_path)
                sample = manifest["artifacts"]["reviewStrips"][0]["samples"][0]
                sample["bytes"] = size
                if size == 3:
                    sample["sha256"] = hashlib.sha256(frame_path.read_bytes()).hexdigest()
                self._write_json(manifest_path, manifest)
                with self.assertRaisesRegex(ValueError, expected_message):
                    self._build()

    def test_rejects_subtitles_over_4000_javascript_characters(self):
        subtitles_path = self.analysis_directory / "subtitles.json"
        subtitles = self._read_json(subtitles_path)
        subtitles["cues"][2]["text"] = "😀" * 3000
        self._write_json(subtitles_path, subtitles)

        with self.assertRaisesRegex(ValueError, "subtitle cue 2 text is invalid"):
            self._build()

    def test_rejects_machine_evidence_larger_than_64000_json_characters(self):
        fine_path = self.assets_directory / "fine-evidence.jsonl"
        records = [json.loads(line) for line in fine_path.read_text(encoding="utf-8").splitlines()]
        records[0]["frameFeatures"]["oversized"] = "x" * 70_000
        fine_path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "machineEvidence exceeds 64000"):
            self._build()

    def test_rejects_full_review_at_or_above_64_kib_utf8(self):
        subtitles_path = self.analysis_directory / "subtitles.json"
        subtitles = self._read_json(subtitles_path)
        subtitles["cues"][2]["text"] = "界" * 3000
        self._write_json(subtitles_path, subtitles)
        fine_path = self.assets_directory / "fine-evidence.jsonl"
        records = [json.loads(line) for line in fine_path.read_text(encoding="utf-8").splitlines()]
        records[0]["frameFeatures"]["largeButAllowed"] = "x" * 59_000
        fine_path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )

        with mock.patch.object(builder, "MAX_REVIEW_UTF8_BYTES", 1_000_000):
            oversized_payload = self._build()
        review = oversized_payload["reviews"][0]
        evidence_json = builder._compact_json(review["machineEvidence"])
        self.assertLessEqual(
            builder._javascript_string_length(evidence_json),
            builder.MAX_MACHINE_EVIDENCE_JSON_CHARACTERS,
        )
        self.assertGreaterEqual(
            len(builder._compact_json(review).encode("utf-8")),
            64 * 1024,
        )

        with self.assertRaisesRegex(ValueError, "64 KiB UTF-8"):
            self._build()

    def test_writes_atomically_without_leaving_temporary_files(self):
        real_replace = os.replace
        with mock.patch.object(builder.os, "replace", wraps=real_replace) as replace:
            self._build()

        replace.assert_called_once()
        self.assertEqual(list(self.output_path.parent.glob(f".{self.output_path.name}.*.tmp")), [])

    def test_cli_uses_default_review_assets_directory(self):
        with contextlib.redirect_stdout(io.StringIO()):
            exit_code = builder.main(
                [
                    "--analysis-directory",
                    str(self.analysis_directory),
                    "--output",
                    str(self.output_path),
                ]
            )

        self.assertEqual(exit_code, 0)
        self.assertTrue(self.output_path.is_file())


if __name__ == "__main__":
    unittest.main()
