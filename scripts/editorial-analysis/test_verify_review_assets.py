import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_review_assets import verify_review_assets_directory  # noqa: E402


def artifact(path: Path) -> dict[str, object]:
    return {
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def build_fixture(root: Path) -> tuple[Path, dict[str, Any]]:
    output = root / "review-assets"
    output.mkdir()
    corpus_path = root / "corpus-manifest.json"
    corpus_path.write_text(
        json.dumps(
            {
                "schemaVersion": "corpus-manifest-v1",
                "sources": [
                    {
                        "id": "sample",
                        "formatDurationSeconds": 3.0,
                        "video": {
                            "duration": 3.0,
                            "start": 0.0,
                            "frameCount": 30,
                            "fps": {"numerator": 10, "denominator": 1},
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    candidate_path = root / "candidate-events.json"
    candidate_path.write_text(
        json.dumps(
            {
                "schemaVersion": "candidate-events-v1",
                "sourceId": "sample",
                "analysisDigest": "digest",
                "events": [{"id": "candidate-1", "timeSeconds": 1.2}],
                "reviewWindows": [
                    {
                        "startSeconds": 1.0,
                        "endSeconds": 2.0,
                        "candidateIds": ["candidate-1"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    review_frames_directory = output / "review-frames"
    review_frames_directory.mkdir()
    samples = []
    for index in range(5):
        frame_path = (
            review_frames_directory
            / f"review-unit-000001-frame-{index + 1:02d}.jpg"
        )
        frame_path.write_bytes(b"\xff\xd8" + bytes([index]) + b"\xff\xd9")
        samples.append(
            {
                "sampleIndex": index,
                "requestedTimeSeconds": 1.0 + index * 0.25,
                "decodedTimeSeconds": 1.0 + index * 0.25,
                "frameIndex": 10 + index,
                **artifact(frame_path),
            }
        )

    target = {
        "id": "observation-target-000001",
        "candidateIds": ["candidate-1"],
        "candidateTimesSeconds": [1.2],
        "anchorFrameIndex": 12,
        "anchorTimeSeconds": 1.2,
        "intervalIndex": 1,
        "previousSampleIndex": 1,
        "currentSampleIndex": 2,
        "separability": "independent",
    }
    unit = {
        "id": "review-unit-000001",
        "parentReviewWindowId": "review-window-000001",
        "startSeconds": 1.0,
        "endSeconds": 2.0,
        "candidateIds": ["candidate-1"],
        "observationTargets": [target],
        "samples": [
            {
                "index": index,
                "timeSeconds": 1.0 + index * 0.25,
                "frameIndex": 10 + index,
            }
            for index in range(5)
        ],
    }
    plan_payload = {
        "sourceId": "sample",
        "analysisDigest": "digest",
        "configuration": {"samplesPerReviewUnit": 5},
        "units": [unit],
    }
    plan_path = root / "review-unit-plan.json"
    plan_path.write_text(
        json.dumps(
            {
                "schemaVersion": "review-unit-plan-v1",
                **plan_payload,
                "planDigest": hashlib.sha256(
                    json.dumps(
                        plan_payload,
                        ensure_ascii=False,
                        separators=(",", ":"),
                        sort_keys=True,
                    ).encode("utf-8")
                ).hexdigest(),
            }
        ),
        encoding="utf-8",
    )

    strip_path = output / "review-strips" / "review-unit-000001.jpg"
    strip_path.parent.mkdir()
    strip_path.write_bytes(b"\xff\xd8\xff\xd9")
    overview_path = output / "overview" / "overview-0001.jpg"
    overview_path.parent.mkdir()
    overview_path.write_bytes(b"\xff\xd8\xff\xd9")
    fine_path = output / "fine-evidence.jsonl"
    fine_records = [
        {
            "schemaVersion": "fine-evidence-v1",
            "id": f"fine-{pair_index}",
            "sourceId": "sample",
            "analysisDigest": "digest",
            "reviewWindowId": "review-unit-000001",
            "parentReviewWindowId": "review-window-000001",
            "candidateIds": ["candidate-1"],
            "pairIndex": pair_index,
            "previousFrame": samples[pair_index - 1],
            "currentFrame": samples[pair_index],
        }
        for pair_index in range(1, 5)
    ]
    fine_path.write_text(
        "".join(json.dumps(record) + "\n" for record in fine_records),
        encoding="utf-8",
    )
    target_samples = []
    target_directory = output / "target-sequences" / "review-unit-000001"
    target_directory.mkdir(parents=True)
    for sample_index, frame_index in enumerate([6, 9, 12, 15, 18]):
        target_path = (
            target_directory
            / f"observation-target-000001-frame-{sample_index + 1:02d}.jpg"
        )
        target_path.write_bytes(b"\xff\xd8target" + bytes([sample_index]) + b"\xff\xd9")
        target_samples.append(
            {
                "sampleIndex": sample_index,
                "frameOffset": frame_index - 12,
                "requestedTimeSeconds": frame_index / 10,
                "decodedTimeSeconds": frame_index / 10,
                "frameIndex": frame_index,
                **artifact(target_path),
            }
        )
    manifest = {
        "schemaVersion": "review-assets-manifest-v2",
        "status": "complete",
        "sourceId": "sample",
        "analysisDigest": "digest",
        "outputDirectory": str(output),
        "configuration": {
            "reviewSamplesPerWindow": 5,
            "targetSequenceSamples": 5,
            "targetSequenceFrameStep": 3,
        },
        "inputs": {
            "corpusManifest": artifact(corpus_path),
            "candidateEvents": artifact(candidate_path),
            "reviewUnitPlan": artifact(plan_path),
        },
        "counts": {
            "parentReviewWindows": 1,
            "reviewUnits": 1,
            "reviewWindows": 1,
            "reviewSamples": 5,
            "reviewFrames": 5,
            "targetSequences": 1,
            "targetSequenceSamples": 5,
            "targetFrames": 5,
            "overviewSamples": 1,
            "decodedUniqueFrames": 9,
            "reviewStrips": 1,
            "overviewContactSheets": 1,
            "fineEvidenceRecords": 4,
            "ffmpegDecodePasses": 1,
        },
        "artifacts": {
            "fineEvidence": artifact(fine_path),
            "reviewStrips": [
                {
                    "reviewWindowId": "review-unit-000001",
                    "parentReviewWindowId": "review-window-000001",
                    "startSeconds": 1.0,
                    "endSeconds": 2.0,
                    "candidateIds": ["candidate-1"],
                    "samples": samples,
                    **artifact(strip_path),
                }
            ],
            "targetSequences": [
                {
                    "reviewWindowId": "review-unit-000001",
                    "targetId": "observation-target-000001",
                    "targetProvenance": target,
                    "samples": target_samples,
                }
            ],
            "overviewContactSheets": [
                {
                    "page": 1,
                    "samples": [samples[0]],
                    **artifact(overview_path),
                }
            ],
        },
    }
    write_manifest(output, manifest)
    return output, manifest


def write_manifest(output: Path, manifest: dict[str, Any]) -> None:
    (output / "review-assets-manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )


class ReviewAssetsVerificationTests(unittest.TestCase):
    def test_verifies_artifacts_windows_and_fine_evidence(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, _ = build_fixture(Path(temporary_directory))

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "passed")
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["counts"]["reviewFrames"], 5)
            self.assertEqual(report["counts"]["targetSequences"], 1)
            self.assertEqual(report["counts"]["targetSequenceSamples"], 5)
            self.assertEqual(report["counts"]["targetFrames"], 5)
            self.assertEqual(report["counts"]["decodedUniqueFrames"], 9)

    def test_rejects_review_frame_with_wrong_path_name(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            wrong_path = output / "review-frames" / "wrong-name.jpg"
            wrong_path.write_bytes(b"\xff\xd8wrong\xff\xd9")
            manifest["artifacts"]["reviewStrips"][0]["samples"][0].update(
                artifact(wrong_path)
            )
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any("review frame path mismatch" in error for error in report["errors"])
            )

    def test_rejects_review_frame_with_wrong_digest(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            manifest["artifacts"]["reviewStrips"][0]["samples"][0]["sha256"] = "0" * 64
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any("artifact digest mismatch" in error for error in report["errors"])
            )

    def test_rejects_inconsistent_sample_index_and_fine_evidence_mapping(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            manifest["artifacts"]["reviewStrips"][0]["samples"][0]["sampleIndex"] = 4
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any("sample indices must be 0..4" in error for error in report["errors"])
            )
            self.assertTrue(
                any("previous frame does not match" in error for error in report["errors"])
            )
            self.assertTrue(
                any("duplicate review frame sample keys" in error for error in report["errors"])
            )

    def test_rejects_target_sequence_with_changed_provenance(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            manifest["artifacts"]["targetSequences"][0]["targetProvenance"][
                "anchorFrameIndex"
            ] = 15
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any("target provenance does not match" in error for error in report["errors"])
            )

    def test_rejects_target_sequence_that_is_not_the_deterministic_frame_plan(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            manifest["artifacts"]["targetSequences"][0]["samples"][0][
                "frameIndex"
            ] = 7
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any(
                    "target frame indices do not match" in error
                    for error in report["errors"]
                )
            )

    def test_rejects_target_sequence_without_anchor_or_unique_frames(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            manifest["artifacts"]["targetSequences"][0]["samples"][2][
                "frameIndex"
            ] = 15
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any(
                    "frame indices must be unique and increasing" in error
                    for error in report["errors"]
                )
            )
            self.assertTrue(
                any("does not include its anchor frame" in error for error in report["errors"])
            )

    def test_rejects_target_artifact_with_noncanonical_path(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            wrong_path = output / "target-sequences" / "wrong-name.jpg"
            wrong_path.write_bytes(b"\xff\xd8wrong-target\xff\xd9")
            manifest["artifacts"]["targetSequences"][0]["samples"][0].update(
                artifact(wrong_path)
            )
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any("target frame path mismatch" in error for error in report["errors"])
            )

    def test_rejects_duplicate_target_artifact_path(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output, manifest = build_fixture(Path(temporary_directory))
            samples = manifest["artifacts"]["targetSequences"][0]["samples"]
            samples[1].update(
                {key: samples[0][key] for key in ("path", "bytes", "sha256")}
            )
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any("duplicate artifact paths" in error for error in report["errors"])
            )

    def test_rejects_target_artifact_outside_output_directory(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            output, manifest = build_fixture(root)
            outside = root / "outside.jpg"
            outside.write_bytes(b"\xff\xd8outside\xff\xd9")
            manifest["artifacts"]["targetSequences"][0]["samples"][0].update(
                artifact(outside)
            )
            write_manifest(output, manifest)

            report = verify_review_assets_directory(output)

            self.assertEqual(report["status"], "failed")
            self.assertTrue(
                any("outside outputDirectory" in error for error in report["errors"])
            )


if __name__ == "__main__":
    unittest.main()
