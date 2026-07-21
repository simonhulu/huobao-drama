import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from analyze_video import (  # noqa: E402
    AnalysisConfig,
    analyze_source,
    run_difference_evidence,
    run_edge_difference_evidence,
    run_scene_evidence,
)


class FfmpegEvidenceIntegrationTests(unittest.TestCase):
    def test_extracts_scene_and_difference_metadata(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video = root / "cut.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=160x90:r=24:d=0.5",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=white:s=160x90:r=24:d=0.5",
                    "-filter_complex",
                    "[0:v][1:v]concat=n=2:v=1:a=0",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-y",
                    str(video),
                ],
                check=True,
            )

            scene = run_scene_evidence(video, root / "scene.log", analysis_width=160)
            difference = run_difference_evidence(
                video,
                root / "difference.log",
                analysis_width=160,
                sample_fps=12.0,
            )

            self.assertGreaterEqual(len(scene), 20)
            scene_peak = max(scene, key=lambda record: record["score"])
            self.assertAlmostEqual(scene_peak["timeSeconds"], 0.5, delta=0.1)
            self.assertGreater(scene_peak["score"], 0.8)
            difference_peak = max(difference, key=lambda record: record["difference"])
            self.assertAlmostEqual(difference_peak["timeSeconds"], 0.5, delta=0.12)
            self.assertGreater(difference_peak["difference"], 100.0)

    def test_extracts_edge_change_for_graphic_appearance(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video = root / "graphic.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=160x90:r=24:d=2",
                    "-vf",
                    "drawbox=x=40:y=20:w=80:h=30:color=white:t=fill:enable='gte(t,1)'",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-y",
                    str(video),
                ],
                check=True,
            )

            evidence = run_edge_difference_evidence(
                video,
                root / "edge.log",
                analysis_width=160,
                sample_fps=4.0,
            )

            peak = max(evidence, key=lambda record: record["difference"])
            self.assertAlmostEqual(peak["timeSeconds"], 1.0, delta=0.26)
            self.assertGreater(peak["difference"], 1.0)

    def test_analyzes_a_complete_synthetic_source_and_writes_auditable_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            video = root / "source.mp4"
            subtitles = root / "source.srt"
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=160x90:r=24:d=1.5",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=white:s=160x90:r=24:d=1.5",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=22050:duration=3",
                    "-filter_complex",
                    "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]pan=stereo|c0=c0|c1=c0[a]",
                    "-map",
                    "[v]",
                    "-map",
                    "[a]",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    "-y",
                    str(video),
                ],
                check=True,
            )
            subtitles.write_text(
                "1\n00:00:00,200 --> 00:00:01,800\nA synthetic cue\n",
                encoding="utf-8",
            )

            def record(path: Path) -> dict[str, object]:
                return {
                    "path": str(path),
                    "bytes": path.stat().st_size,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                }

            source = {
                "id": "synthetic",
                "mp4": record(video),
                "srt": record(subtitles),
                "formatDurationSeconds": 3.0,
                "video": {
                    "fps": {"numerator": 24, "denominator": 1},
                    "width": 160,
                    "height": 90,
                },
            }
            result = analyze_source(
                source,
                config=AnalysisConfig(diff_sample_fps=8.0),
                output_root=root / "analysis",
            )

            output_directory = Path(result["outputDirectory"])
            self.assertEqual(result["status"], "complete")
            self.assertTrue((output_directory / "scene-evidence.jsonl").is_file())
            self.assertTrue((output_directory / "difference-evidence.jsonl").is_file())
            self.assertTrue((output_directory / "audio-evidence.json").is_file())
            self.assertTrue((output_directory / "candidate-events.json").is_file())
            coverage = json.loads((output_directory / "machine-coverage.json").read_text())
            self.assertEqual(coverage["endFrame"], 72)
            self.assertEqual(coverage["intervals"][0]["startFrame"], 0)
            self.assertEqual(coverage["intervals"][-1]["endFrame"], 72)


if __name__ == "__main__":
    unittest.main()
