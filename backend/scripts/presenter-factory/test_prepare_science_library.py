import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import prepare_science_library as packer


class ScienceLibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="science-library-media-")
        cls.addClassCleanup(cls.fixture.cleanup)
        cls.root = Path(cls.fixture.name)
        for number, item in enumerate(packer.SETS):
            target = cls.root / item["intro"]
            target.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                f"color=c={['red', 'green', 'blue'][number]}:s=160x90:r=25:d=0.2",
                "-f", "lavfi", "-i", "sine=f=440:d=0.2", "-c:v", "libx264", "-preset", "ultrafast",
                "-c:a", "aac", "-shortest", str(target),
            ], check=True)
        body = cls.root / packer.BODY
        body.mkdir(parents=True, exist_ok=True)
        for name in ("xiaolu-01-body-bank.mp4", "xiaolu-01-body-bank-corrected.mp4", "xiaolu-02-body-bank.mp4"):
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=480x480:r=25",
                "-frames:v", "1508", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", str(body / name),
            ], check=True)
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=16x16",
            "-frames:v", "1", str(body / "xiaolu-01-clean-background-plate.png"),
        ], check=True)
        cls.receipt = {
            "version": 2, "input_sha256": packer.digest(body / "xiaolu-01-body-bank.mp4"),
            "output_sha256": packer.digest(body / "xiaolu-01-body-bank-corrected.mp4"),
            "reference_sha256": packer.digest(body / "xiaolu-01-clean-background-plate.png"),
            "frames": 1508, "fps": "25",
        }
        (body / "xiaolu-01-body-bank-corrected.mp4.repair.json").write_text(json.dumps(cls.receipt))

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="science-library-output-")
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name) / "bundle"

    def test_actual_media_bundle_has_three_bound_pairs_and_reuses(self):
        result = packer.stage(self.root, self.output, "/srv/science", "/gpu/science")
        library = packer.load(result["library"])
        registry = packer.load(result["registry_additions"])
        self.assertEqual(len(library["clips"]), 3)
        self.assertEqual(len({clip["fingerprint"] for clip in library["clips"]}), 3)
        for clip in library["clips"]:
            self.assertEqual(clip["status"], "ready")
            self.assertTrue(clip["videoPath"].startswith("/srv/science/intros/"))
            self.assertEqual(clip["referenceSha256"], registry["avatars"][clip["avatarId"]]["reference_sha256"])
        original = registry["avatars"]["xiaolu-original-approved-20261111"]
        self.assertEqual(original["reference"], packer.ORIGINAL_REFERENCE)
        self.assertNotIn("playback", original)
        self.assertNotIn(packer.ORIGINAL_DEFAULT_ID, registry["avatars"])
        self.assertEqual(registry["avatars"]["xiaolu-01-body-approved-20261111"]["playback"]["segments"][-1]["end_frame"], 1508)
        for asset in result["files"]:
            self.assertEqual(packer.digest(self.output / asset["path"]), asset["sha256"])
        self.assertEqual(packer.stage(self.root, self.output, "/srv/science", "/gpu/science")["fingerprint"], result["fingerprint"])
        existing = self.output / "intros/xiaolu-01-intro.mp4"
        existing.write_bytes(b"different-existing-intro")
        with self.assertRaisesRegex(FileExistsError, "preserved"):
            packer.stage(self.root, self.output, "/srv/science", "/gpu/science")
        self.assertEqual(existing.read_bytes(), b"different-existing-intro")

    def test_registry_merge_preserves_default_user_and_other_avatars(self):
        original = {"avatars": {"user-avatar": {"reference": "user.mp4", "reference_sha256": "a" * 64}}}
        before = copy.deepcopy(original)
        additions = {"avatars": {"xiaolu-new": {"reference": "/gpu/new.mp4", "reference_sha256": "b" * 64}}}
        merged = packer.merge_additions(original, additions)
        self.assertEqual(original, before)
        self.assertEqual(merged["avatars"]["user-avatar"], original["avatars"]["user-avatar"])
        self.assertEqual(packer.merge_additions(merged, additions), merged)
        with self.assertRaisesRegex(ValueError, "conflicting"):
            packer.merge_additions(original, {"avatars": {"user-avatar": {"reference": "/wrong.mp4"}}})

    def test_corrected_reference_hash_chain_is_required(self):
        filename = self.root / packer.BODY / "xiaolu-01-body-bank-corrected.mp4.repair.json"
        before = filename.read_bytes()
        self.addCleanup(filename.write_bytes, before)
        filename.write_text(json.dumps({**self.receipt, "output_sha256": "0" * 64}))
        with self.assertRaisesRegex(ValueError, "not bound"):
            packer.stage(self.root, self.output)
        self.assertFalse(self.output.exists())

    def test_invalid_intro_media_is_rejected(self):
        filename = self.root / packer.SETS[1]["intro"]
        before = filename.read_bytes()
        self.addCleanup(filename.write_bytes, before)
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "color=s=160x160:r=25:d=0.2",
            "-c:v", "libx264", "-preset", "ultrafast", str(filename),
        ], check=True)
        with self.assertRaisesRegex(ValueError, "16:9 with audio"):
            packer.stage(self.root, self.output)
        self.assertFalse((self.output / "ready-science-xiaolu.json").exists())


if __name__ == "__main__":
    unittest.main()
