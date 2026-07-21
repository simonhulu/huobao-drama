import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from verify_semantic_outlines import validate_semantic_outline  # noqa: E402


def make_segment(segment_id, start, end, cue_ids, captioned_seconds):
    duration = end - start
    return {
        "id": segment_id,
        "start": start,
        "end": end,
        "cueIds": cue_ids,
        "summary": "summary",
        "narrativeFunction": "exposition",
        "discourseBoundary": {"type": "opening", "cueIds": [cue_ids[0]], "description": "boundary"},
        "lexicalSignals": [],
        "entities": [],
        "metrics": {
            "durationSeconds": duration,
            "cueCount": len(cue_ids),
            "captionedSeconds": captioned_seconds,
            "captionCoverageRatio": captioned_seconds / duration,
            "quantifiedClaimCueIds": [],
            "questionCueIds": [],
        },
        "editorialOpportunities": [],
        "avoidOvereditingNotes": [],
    }


class SemanticOutlineValidationTests(unittest.TestCase):
    def setUp(self):
        self.subtitles = {
            "schemaVersion": "normalized-subtitles-v1",
            "sourceId": "sample",
            "mediaDurationSeconds": 5.0,
            "cues": [
                {"index": 1, "startSeconds": 0.5, "endSeconds": 1.5, "text": "one"},
                {"index": 2, "startSeconds": 2.0, "endSeconds": 4.0, "text": "two"},
            ],
        }
        self.outline = {
            "schemaVersion": "semantic-outline-v1",
            "sourceId": "sample",
            "analysisBasis": {
                "modality": "subtitle-only",
                "mediaDurationSeconds": 5.0,
                "cueCount": 2,
                "firstCueStart": 0.5,
                "lastCueEnd": 4.0,
            },
            "coverage": {
                "start": 0.5,
                "end": 4.0,
                "segmentCount": 2,
                "segmentsAreContinuous": True,
                "cueAssignment": "exactly-once",
                "captionedSeconds": 3.0,
                "edgeUncaptionedIntervals": [
                    {"start": 0, "end": 0.5, "durationSeconds": 0.5},
                    {"start": 4.0, "end": 5.0, "durationSeconds": 1.0},
                ],
                "subtitleGaps": [
                    {
                        "start": 1.5,
                        "end": 2.0,
                        "durationSeconds": 0.5,
                        "afterCueId": 1,
                        "beforeCueId": 2,
                    }
                ],
                "gapInterpretation": "no inference",
            },
            "segments": [
                make_segment("sample-s01", 0.5, 2.0, [1], 1.0),
                make_segment("sample-s02", 2.0, 4.0, [2], 2.0),
            ],
            "specialIntervals": [],
        }

    def test_accepts_contiguous_exactly_once_outline(self):
        self.assertEqual(validate_semantic_outline(self.outline, self.subtitles), [])

    def test_rejects_duplicate_cue_assignment(self):
        self.outline["segments"][1]["cueIds"] = [1, 2]

        errors = validate_semantic_outline(self.outline, self.subtitles)

        self.assertTrue(any("exactly once" in error for error in errors))

    def test_rejects_malformed_evidence_record(self):
        self.outline["segments"][0]["avoidOvereditingNotes"] = [
            {"cueIds": 1, "note": 2}
        ]

        errors = validate_semantic_outline(self.outline, self.subtitles)

        self.assertTrue(any("avoidOvereditingNotes" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
