import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import soundfile as sf
import torch


spec = importlib.util.spec_from_file_location("separate_audio", Path(__file__).with_name("separate-audio.py"))
separation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(separation)


class FakeModel:
    sources = ["drums", "bass", "other", "vocals"]

    def __init__(self, interrupt_after=None):
        self.calls = 0
        self.interrupt_after = interrupt_after

    def __call__(self, batch):
        if self.interrupt_after is not None and self.calls >= self.interrupt_after:
            raise InterruptedError("simulated process interruption")
        self.calls += 1
        vocal = .25 * batch + .1 * batch.square()
        return torch.stack([batch * 0, batch * 0, batch * 0, vocal], dim=1)


class SeparationCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name) / "chunks"
        samples = np.arange(350, dtype=np.float32)
        self.waveform = torch.from_numpy(np.stack([np.sin(samples / 11) * .3, np.cos(samples / 17) * .2], axis=1).T)

    def separate(self, model, source="source-a", weights="weights-a"):
        return separation.separate_windows(self.waveform, model, 20, self.cache, source, weights, progress=lambda _: None)

    def test_interrupted_resume_reuses_chunks_and_preserves_exact_audio_samples(self):
        baseline, initial = self.separate(FakeModel())
        self.assertEqual(initial["computed_chunks"], 4)
        self.cache = Path(self.directory.name) / "interrupted"
        with self.assertRaises(InterruptedError):
            self.separate(FakeModel(interrupt_after=2))
        model = FakeModel()
        resumed, checkpoint = self.separate(model)
        self.assertEqual(model.calls, 2)
        self.assertEqual(checkpoint["reused_chunks"], 2)
        torch.testing.assert_close(resumed, baseline, rtol=0, atol=0)
        for name, vocals in (("baseline", baseline), ("resumed", resumed)):
            reduced = self.waveform - .94 * vocals
            reduced *= min(1.0, .98 / max(float(reduced.abs().max()), 1e-12))
            sf.write(Path(self.directory.name) / f"{name}.wav", reduced.T.numpy(), 20, subtype="PCM_24")
        original, rate = sf.read(Path(self.directory.name) / "baseline.wav", dtype="float32", always_2d=True)
        restored, restored_rate = sf.read(Path(self.directory.name) / "resumed.wav", dtype="float32", always_2d=True)
        self.assertEqual(original.shape, (350, 2))
        self.assertEqual(rate, restored_rate)
        np.testing.assert_array_equal(original, restored)
        self.assertTrue(np.isfinite(restored).all())

    def test_window_normalization_and_weighted_crossfades_match_the_previous_algorithm(self):
        reference = self.waveform.mean(dim=0)
        scale = reference.std()
        normalized = (self.waveform - reference.mean()) / scale
        vocal_sum, weight_sum = torch.zeros_like(self.waveform), torch.zeros(self.waveform.shape[-1])
        model = FakeModel()
        for start in range(0, self.waveform.shape[-1], 100):
            end = min(self.waveform.shape[-1], start + 120)
            prediction = model(normalized[:, start:end].unsqueeze(0))[0, 3]
            weight = torch.ones(end - start)
            if start:
                fade = min(20, end - start)
                weight[:fade] *= torch.linspace(0, 1, fade)
            if end < self.waveform.shape[-1]:
                fade = min(20, end - start)
                weight[-fade:] *= torch.linspace(1, 0, fade)
            vocal_sum[:, start:end] += prediction * weight
            weight_sum[start:end] += weight
            if end == self.waveform.shape[-1]:
                break
        actual, _ = self.separate(FakeModel())
        torch.testing.assert_close(actual, (vocal_sum / weight_sum) * scale, rtol=0, atol=0)

    def test_corrupt_prediction_is_recomputed_instead_of_reused(self):
        baseline, checkpoint = self.separate(FakeModel())
        chunks = sorted(Path(checkpoint["directory"]).glob("*.npy"))
        chunks[1].write_bytes(b"corrupt prediction")
        model = FakeModel()
        restored, result = self.separate(model)
        self.assertEqual(model.calls, 1)
        self.assertEqual(result["reused_chunks"], 3)
        torch.testing.assert_close(restored, baseline, rtol=0, atol=0)

    def test_source_model_and_normalization_changes_do_not_reuse_predictions(self):
        self.separate(FakeModel())
        for source, weights, adjust in (("source-b", "weights-a", False), ("source-a", "weights-b", False), ("source-a", "weights-a", True)):
            if adjust:
                self.waveform = self.waveform * .7 + .1
            model = FakeModel()
            _, result = self.separate(model, source, weights)
            self.assertEqual(model.calls, 4)
            self.assertEqual(result["reused_chunks"], 0)

    def test_invalid_proof_and_nonfinite_prediction_are_recomputed(self):
        expected, result = self.separate(FakeModel())
        chunks = sorted(Path(result["directory"]).glob("*.npy"))
        chunks[0].with_suffix(".json").write_text("[]")
        with chunks[1].open("wb") as handle:
            np.save(handle, np.full((2, 120), np.nan, dtype=np.float32), allow_pickle=False)
        proof = json.loads(chunks[1].with_suffix(".json").read_text())
        proof["sha256"] = separation.sha256(chunks[1])
        chunks[1].with_suffix(".json").write_text(json.dumps(proof))
        model = FakeModel()
        restored, checkpoint = self.separate(model)
        self.assertEqual(model.calls, 2)
        self.assertEqual(checkpoint["reused_chunks"], 2)
        torch.testing.assert_close(restored, expected, rtol=0, atol=0)


if __name__ == "__main__":
    unittest.main()
