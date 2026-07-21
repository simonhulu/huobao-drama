import sys
import json
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze_video import (  # noqa: E402
    AnalysisConfig,
    build_argument_parser,
    build_analysis_identity,
    combine_candidate_layers,
    load_manifest_source,
    merge_review_windows,
    resolve_source_ids,
    verify_input_file,
)


class AnalysisIdentityTests(unittest.TestCase):
    def test_identity_changes_with_detector_configuration(self):
        source = {
            "id": "sample",
            "mp4": {"sha256": "a" * 64},
            "srt": {"sha256": "b" * 64},
        }

        first = build_analysis_identity(source, AnalysisConfig(diff_sample_fps=12.0))
        second = build_analysis_identity(source, AnalysisConfig(diff_sample_fps=8.0))

        self.assertNotEqual(first["digest"], second["digest"])
        self.assertEqual(first["sourceId"], "sample")

    def test_loads_manifest_source_and_verifies_input_digest(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            media = root / "sample.bin"
            media.write_bytes(b"reference media")
            manifest = root / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "schemaVersion": "corpus-manifest-v1",
                        "sources": [
                            {
                                "id": "sample",
                                "mp4": {
                                    "path": str(media),
                                    "bytes": 15,
                                    "sha256": "b79e5ab526089e7d616fa3468a5152ad5bfe437b0ceb9725311b21cabc4e9798",
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            source = load_manifest_source(manifest, "sample")
            result = verify_input_file(source["mp4"])

            self.assertEqual(source["id"], "sample")
            self.assertEqual(result["bytes"], 15)

    def test_cli_defaults_to_all_manifest_sources(self):
        arguments = build_argument_parser().parse_args([])

        self.assertEqual(arguments.source, ["all"])
        self.assertEqual(arguments.output_root, Path("tmp/editorial-analysis"))

    def test_explicit_source_overrides_implicit_all_default(self):
        self.assertEqual(
            resolve_source_ids(["all", "yahoo"], ["yahoo", "youtube"]),
            ["yahoo"],
        )


class LayerCombinationTests(unittest.TestCase):
    def test_attaches_coincident_diff_and_audio_to_visual_candidate(self):
        combined = combine_candidate_layers(
            scene_events=[
                {"timeSeconds": 5.0, "score": 0.7, "family": "visual_reset_candidate", "detector": "ffmpeg_scene"}
            ],
            difference_events=[
                {"timeSeconds": 5.1, "score": 0.8, "family": "visual_activity_candidate", "detector": "ffmpeg_difference"}
            ],
            edge_events=[
                {"timeSeconds": 5.18, "score": 0.5, "family": "text_or_graphic_state_candidate", "detector": "ffmpeg_edge_difference"}
            ],
            audio_events=[
                {"timeSeconds": 5.28, "score": 0.6, "family": "audio_onset_candidate", "detector": "side_onset"},
                {"timeSeconds": 8.0, "score": 0.9, "family": "audio_onset_candidate", "detector": "side_onset"},
            ],
            visual_merge_seconds=0.25,
            audio_attach_seconds=0.35,
        )

        self.assertEqual(len(combined), 2)
        self.assertEqual(combined[0]["timeSeconds"], 5.1)
        self.assertEqual(
            combined[0]["detectors"],
            [
                "ffmpeg_difference",
                "ffmpeg_edge_difference",
                "ffmpeg_scene",
                "side_onset",
            ],
        )
        self.assertEqual(combined[1]["timeSeconds"], 8.0)


class ReviewWindowTests(unittest.TestCase):
    def test_merges_overlapping_windows_and_keeps_candidate_ids(self):
        windows = merge_review_windows(
            [
                {"id": "event-1", "timeSeconds": 1.0},
                {"id": "event-2", "timeSeconds": 1.6},
                {"id": "event-3", "timeSeconds": 3.0},
            ],
            before_seconds=0.5,
            after_seconds=0.5,
            duration_seconds=4.0,
        )

        self.assertEqual(len(windows), 2)
        self.assertEqual(windows[0]["startSeconds"], 0.5)
        self.assertEqual(windows[0]["endSeconds"], 2.1)
        self.assertEqual(windows[0]["candidateIds"], ["event-1", "event-2"])


if __name__ == "__main__":
    unittest.main()
