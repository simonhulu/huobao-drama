import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("reference_experiment", Path(__file__).with_name("reference_experiment.py"))
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


class Frames(list):
    @property
    def shape(self):
        return (len(self), 3, 512, 512)

    def __getitem__(self, key):
        if isinstance(key, list):
            return Frames(list.__getitem__(self, index) for index in key)
        value = super().__getitem__(key)
        return Frames(value) if isinstance(key, slice) else value


class ReferenceOffsetTests(unittest.TestCase):
    def make_pipeline(self, count):
        faces = Frames(range(count))
        prepared = []
        result = (object(), faces, object(), object())
        processor_calls = []

        def normalize(frames):
            processor_calls.append(list(frames))
            return Frames(f"normalized-{index}" for index in frames)

        def prepare(images, *args, **kwargs):
            prepared.append((images, args, kwargs))
            return images

        pipeline = SimpleNamespace(
            loop_video=lambda *args, **kwargs: result,
            prepare_image_latents=prepare,
            image_processor=SimpleNamespace(process_images=normalize),
            prepare_mask_latents=object(),
            paste_surrounding_pixels_back=object(),
        )
        return pipeline, result, prepared, processor_calls

    def test_baseline_preserves_input_identity_and_target_paths(self):
        pipeline, result, prepared, normalized = self.make_pipeline(20)
        originals = dict(vars(pipeline))
        with experiment.ReferenceOffset(pipeline, 0) as reference:
            self.assertIs(pipeline.loop_video(), result)
            for size in (16, 4):
                images = Frames(["current-pixels"] * size)
                self.assertIs(pipeline.prepare_image_latents(images, "cpu", dtype="float16"), images)
            reference.verify_complete()
            self.assertIs(pipeline.prepare_mask_latents, originals["prepare_mask_latents"])
            self.assertIs(pipeline.paste_surrounding_pixels_back, originals["paste_surrounding_pixels_back"])
        self.assertEqual(normalized, [])
        self.assertEqual(prepared[0][1:], (("cpu",), {"dtype": "float16"}))
        self.assertIs(pipeline.loop_video, originals["loop_video"])
        self.assertIs(pipeline.prepare_image_latents, originals["prepare_image_latents"])

    def test_offset_wraps_and_handles_short_final_window(self):
        pipeline, result, prepared, normalized = self.make_pipeline(20)
        with experiment.ReferenceOffset(pipeline, 16) as reference:
            self.assertIs(pipeline.loop_video(), result)
            for size in (16, 4):
                pipeline.prepare_image_latents(Frames(["target"] * size))
            reference.verify_complete()
        self.assertEqual(normalized, [list(range(16, 20)) + list(range(12)), list(range(12, 16))])
        self.assertEqual(prepared[1][0], [f"normalized-{index}" for index in range(12, 16)])
        self.assertEqual(reference.record["effective_offset_frames"], 16)
        self.assertEqual([window["frame_count"] for window in reference.record["windows"]], [16, 4])

    def test_offset_larger_than_sequence_is_reported_and_uses_modulo(self):
        pipeline, _, _, normalized = self.make_pipeline(7)
        with experiment.ReferenceOffset(pipeline, 16) as reference:
            pipeline.loop_video()
            pipeline.prepare_image_latents(Frames(range(7)))
            reference.verify_complete()
        self.assertEqual(normalized, [[2, 3, 4, 5, 6, 0, 1]])
        self.assertEqual(reference.record["effective_offset_frames"], 2)

    def test_methods_restore_after_failure_and_incomplete_coverage_is_rejected(self):
        pipeline, _, _, _ = self.make_pipeline(20)
        original = pipeline.prepare_image_latents
        with self.assertRaisesRegex(RuntimeError, "complete target"):
            with experiment.ReferenceOffset(pipeline, 16) as reference:
                pipeline.loop_video()
                pipeline.prepare_image_latents(Frames(range(16)))
                reference.verify_complete()
        self.assertIs(pipeline.prepare_image_latents, original)

    def test_reference_before_loop_and_extra_windows_are_rejected(self):
        pipeline, _, _, _ = self.make_pipeline(4)
        with experiment.ReferenceOffset(pipeline, 16):
            with self.assertRaisesRegex(RuntimeError, "before aligned"):
                pipeline.prepare_image_latents(Frames(range(4)))
            pipeline.loop_video()
            with self.assertRaisesRegex(RuntimeError, "exceeds"):
                pipeline.prepare_image_latents(Frames(range(5)))

    def test_float32_geometry_is_active_before_alignment_and_restored_afterward(self):
        pipeline, result, _, _ = self.make_pipeline(4)

        class Tensor:
            def __init__(self, dtype):
                self.dtype = dtype

            def to(self, *, dtype):
                return Tensor(dtype)

        fill, mask = Tensor("float16"), Tensor("float16")
        restorer = SimpleNamespace(dtype="float16", fill_value=fill, mask=mask)
        pipeline.image_processor.restorer = restorer
        pipeline.unet = object()
        pipeline.vae = object()
        unet, vae = pipeline.unet, pipeline.vae

        def aligned_loop():
            self.assertEqual(restorer.dtype, "float32")
            self.assertEqual(restorer.fill_value.dtype, "float32")
            self.assertEqual(restorer.mask.dtype, "float32")
            return result

        pipeline.loop_video = aligned_loop
        with patch.dict("sys.modules", torch=SimpleNamespace(float32="float32")):
            with experiment.ReferenceOffset(pipeline, 0, "float32") as reference:
                pipeline.loop_video()
                pipeline.prepare_image_latents(Frames(range(4)))
                reference.verify_complete()
                self.assertEqual(restorer.dtype, "float32")
                self.assertIs(pipeline.unet, unet)
                self.assertIs(pipeline.vae, vae)
        self.assertEqual(restorer.dtype, "float16")
        self.assertIs(restorer.fill_value, fill)
        self.assertIs(restorer.mask, mask)
        self.assertEqual(reference.record["geometry_dtype"], "float32")


class StageCaptureTests(unittest.TestCase):
    def test_capture_observes_pixels_without_replacing_pipeline_results(self):
        decoded = Frames(["d0", "d1", "d2", "d3"])
        source = Frames(["s0", "s1", "s2", "s3"])
        pasted = Frames(["p0", "p1", "p2", "p3"])
        restored = Frames(["r0", "r1", "r2", "r3"])
        originals = dict(
            decode_latents=lambda value: decoded,
            paste_surrounding_pixels_back=lambda *args: pasted,
            restore_video=lambda *args: restored,
        )
        pipeline = SimpleNamespace(**originals)
        with tempfile.TemporaryDirectory() as temporary:
            capture = experiment.StageCapture(pipeline, Path(temporary) / "stages", indices=(0, 3))
            with patch.object(capture, "save_tensor") as tensor, patch.object(capture, "save_rgb") as rgb:
                with capture:
                    self.assertIs(pipeline.decode_latents(object()), decoded)
                    self.assertIs(pipeline.paste_surrounding_pixels_back(decoded, source, object()), pasted)
                    self.assertIs(pipeline.restore_video(pasted, source, object(), object()), restored)
                self.assertEqual([call.args for call in tensor.call_args_list], [
                    ("decoded", 0, "d0"), ("decoded", 3, "d3"),
                    ("aligned-source", 0, "s0"), ("pasted", 0, "p0"),
                    ("aligned-source", 3, "s3"), ("pasted", 3, "p3"),
                ])
                self.assertEqual([call.args for call in rgb.call_args_list], [
                    ("source", 0, "s0"), ("restored", 0, "r0"),
                    ("source", 3, "s3"), ("restored", 3, "r3"),
                ])
        for name, original in originals.items():
            self.assertIs(getattr(pipeline, name), original)

    def test_hooks_restore_after_failure_and_existing_stage_directory_is_rejected(self):
        def fail(*args):
            raise RuntimeError("decoder failed")

        pipeline = SimpleNamespace(decode_latents=fail, paste_surrounding_pixels_back=object(), restore_video=object())
        originals = dict(vars(pipeline))
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "stages"
            with self.assertRaisesRegex(RuntimeError, "decoder failed"):
                with experiment.StageCapture(pipeline, directory):
                    pipeline.decode_latents(object())
            with self.assertRaises(FileExistsError):
                with experiment.StageCapture(pipeline, directory):
                    self.fail("Existing diagnosis frames must not be overwritten")
        for name, original in originals.items():
            self.assertIs(getattr(pipeline, name), original)


if __name__ == "__main__":
    unittest.main()
