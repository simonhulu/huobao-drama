import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import (  # noqa: E402
    build_coverage,
    canonical_digest,
    non_max_suppression,
    parse_srt,
)


class ParseSrtTests(unittest.TestCase):
    def test_parses_multiline_and_clamps_to_media_duration(self):
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

        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]["text"], "First line\nsecond line")
        self.assertEqual(cues[1]["endSeconds"], 10.0)
        self.assertEqual(cues[1]["clampReason"], "media_end")

    def test_rejects_non_positive_cue_after_clamping(self):
        with self.assertRaisesRegex(ValueError, "non-positive"):
            parse_srt(
                """1
00:00:11,000 --> 00:00:12,000
Outside
""",
                media_duration_seconds=10.0,
            )


class CandidateTests(unittest.TestCase):
    def test_non_max_suppression_keeps_strongest_nearby_event(self):
        events = [
            {"timeSeconds": 1.0, "score": 0.7},
            {"timeSeconds": 1.2, "score": 0.9},
            {"timeSeconds": 3.0, "score": 0.8},
        ]

        selected = non_max_suppression(events, min_spacing_seconds=0.5)

        self.assertEqual([event["timeSeconds"] for event in selected], [1.2, 3.0])


class CoverageTests(unittest.TestCase):
    def test_coverage_is_contiguous_and_respects_max_segment_duration(self):
        coverage = build_coverage(
            source_id="sample",
            duration_seconds=10.0,
            fps_numerator=30,
            fps_denominator=1,
            subtitle_cues=[
                {"id": "cue-1", "startSeconds": 1.0, "endSeconds": 4.0, "text": "One"},
                {"id": "cue-2", "startSeconds": 6.0, "endSeconds": 9.0, "text": "Two"},
            ],
            visual_event_seconds=[2.0, 7.5],
            max_segment_seconds=2.0,
        )

        intervals = coverage["intervals"]
        self.assertEqual(intervals[0]["startFrame"], 0)
        self.assertEqual(intervals[0]["endFrame"], 60)
        self.assertEqual(intervals[-1]["endFrame"], 300)
        self.assertTrue(all(a["endFrame"] == b["startFrame"] for a, b in zip(intervals, intervals[1:])))
        self.assertTrue(all(interval_["endFrame"] - interval_["startFrame"] <= 60 for interval_ in intervals))
        self.assertEqual(
            [cue["id"] for cue in intervals[1]["subtitleCues"]],
            ["cue-1"],
        )
        self.assertEqual(coverage["semanticIntervals"][0]["startFrame"], 0)
        self.assertTrue(any(interval_["subtitleCues"] for interval_ in coverage["semanticIntervals"]))


class DigestTests(unittest.TestCase):
    def test_canonical_digest_ignores_mapping_insertion_order(self):
        self.assertEqual(
            canonical_digest({"b": 2, "a": 1}),
            canonical_digest({"a": 1, "b": 2}),
        )


if __name__ == "__main__":
    unittest.main()
