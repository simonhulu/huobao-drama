import asyncio
import hashlib
import importlib.util
import json
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class VerifiedApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.upstream = types.SimpleNamespace(
            app=object(), JOB_ROOT=self.root, VAE_PATH=self.root, ROOT=self.root, CHECKPOINT=self.root / "unet.pt",
            jobs={}, jobs_lock=threading.Lock(),
            pipeline_state={"pipeline": None}, load_pipeline=lambda: None, run_job=lambda *args: None,
            validate_settings=lambda settings: settings,
        )

        def set_job(job_id, **values):
            with self.upstream.jobs_lock:
                self.upstream.jobs[job_id].update(values)

        self.upstream.set_job = set_job
        spec = importlib.util.spec_from_file_location("verified_api_fixture", Path(__file__).with_name("verified_api.py"))
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", api_server=self.upstream):
            spec.loader.exec_module(self.module)
        self.job_id = "a" * 32

    def test_same_size_preallocated_download_is_rejected_by_digest(self):
        expected = b"real trained weights" * 128
        filename = self.root / "weights.safetensors"
        with filename.open("wb") as target:
            target.truncate(len(expected))
        sha = hashlib.sha256(expected).hexdigest()
        with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
            self.module.verify_vae(filename, len(expected), sha)
        filename.write_bytes(expected)
        self.assertEqual(self.module.verify_vae(filename, len(expected), sha), sha)
        filename.write_bytes(expected[:-1])
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            self.module.verify_vae(filename, len(expected), sha)

    def test_missing_final_output_cannot_be_marked_completed(self):
        output = self.root / self.job_id / "result.mp4"
        self.upstream.jobs[self.job_id] = {"id": self.job_id, "status": "running", "output_path": str(output), "input_audio": "audio.wav"}
        with self.assertRaisesRegex(RuntimeError, "final video_out_path"):
            self.module.set_job(self.job_id, status="completed", result=str(output))
        self.assertEqual(self.upstream.jobs[self.job_id]["status"], "running")

    def test_intermediate_file_is_not_accepted_as_final_output(self):
        self.upstream.jobs[self.job_id] = {"id": self.job_id, "status": "running", "output_path": "result.mp4", "input_audio": "audio.wav"}
        with self.assertRaisesRegex(RuntimeError, "requested final"):
            self.module.set_job(self.job_id, status="completed", result="masked_frames.mp4")

    def test_final_video_requires_audio_and_full_narration_duration(self):
        output = self.root / "result.mp4"
        output.write_bytes(b"video")
        video = {"streams": [{"codec_type": "video", "width": 512, "height": 512, "duration": "2"}], "format": {"duration": "2"}}
        with patch.object(self.module, "media_info", return_value=video):
            with self.assertRaisesRegex(RuntimeError, "video and audio"):
                self.module.validate_output(output, "audio.wav")
        video["streams"].append({"codec_type": "audio"})
        with patch.object(self.module, "media_info", side_effect=[video, {"format": {"duration": "30"}}]):
            with self.assertRaisesRegex(RuntimeError, "narration duration"):
                self.module.validate_output(output, "audio.wav")

    def test_validated_result_is_persisted_and_restored_without_replay(self):
        output = self.root / self.job_id / "result.mp4"
        settings = {"inference_steps": 40, "guidance_scale": 2.0, "enable_deepcache": False, "seed": 1247}
        self.upstream.jobs[self.job_id] = {"id": self.job_id, "status": "running", "output_path": str(output), "input_audio": "audio.wav", "inference_settings": settings}
        with patch.object(self.module, "validate_output"):
            self.module.set_job(self.job_id, status="completed", result=str(output))
            saved = json.loads((output.parent / "job.json").read_text())
            self.assertEqual(saved["output_stage"], "restored_video")
            self.assertEqual(saved["vae_sha256"], self.module.VAE_SHA256)
            self.assertEqual(saved["inference_settings"], settings)
            self.upstream.jobs.clear()
            self.module.restore_jobs()
        self.assertEqual(self.upstream.jobs[self.job_id], saved)

    def test_restart_fails_interrupted_and_unverified_jobs_without_dispatching(self):
        for index, status in enumerate(("running", "queued", "completed")):
            job_id = str(index) * 32
            self.module.persist_job({"id": job_id, "status": status, "result": "result.mp4"})
        self.module.restore_jobs()
        self.assertEqual(len(self.upstream.jobs), 3)
        self.assertTrue(all(job["status"] == "failed" for job in self.upstream.jobs.values()))
        self.assertTrue(all(job["result"] is None for job in self.upstream.jobs.values()))

    def test_decoder_guard_rejects_nonfinite_and_constant_frames(self):
        class Pixels:
            ndim = 4
            valid = True
            constant = False

            def numel(self):
                return 100

            def float(self):
                return self

            def var(self, **kwargs):
                return self

            def mean(self, **kwargs):
                return self

            def __lt__(self, other):
                return self

            def any(self):
                return self.constant

        pixels = Pixels()
        pipeline = types.SimpleNamespace(decode_latents=lambda _: pixels)
        self.upstream.pipeline_state["pipeline"] = pipeline
        torch = types.SimpleNamespace(isfinite=lambda tensor: types.SimpleNamespace(all=lambda: tensor.valid))
        with patch.object(self.module, "verify_vae"), patch.object(self.module, "verify_weights"):
            self.module.load_pipeline()
        with patch.dict("sys.modules", torch=torch):
            self.assertIs(pipeline.decode_latents(None), pixels)
            pixels.valid = False
            with self.assertRaisesRegex(RuntimeError, "invalid pixels"):
                pipeline.decode_latents(None)
            pixels.valid, pixels.constant = True, True
            with self.assertRaisesRegex(RuntimeError, "constant frame"):
                pipeline.decode_latents(None)


class QualityApiTests(unittest.TestCase):
    def setUp(self):
        class App:
            def __init__(self, **kwargs):
                pass

            def get(self, *args, **kwargs):
                return lambda function: function

            post = on_event = get

        class HTTPException(Exception):
            def __init__(self, status_code, detail):
                self.status_code, self.detail = status_code, detail

        fastapi = types.SimpleNamespace(
            FastAPI=App, File=lambda default, **kwargs: default,
            Form=lambda default, **kwargs: default, HTTPException=HTTPException, UploadFile=object,
        )
        spec = importlib.util.spec_from_file_location("quality_api_fixture", Path(__file__).with_name("api_server.py"))
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", fastapi=fastapi, **{"fastapi.responses": types.SimpleNamespace(FileResponse=object)}):
            spec.loader.exec_module(self.module)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.module.JOB_ROOT = Path(self.directory.name)
        self.seed_calls, self.pipeline_calls, self.cache_calls = [], [], []
        self.fail_pipeline = False

        def infer(**kwargs):
            self.pipeline_calls.append(kwargs)
            if self.fail_pipeline:
                raise RuntimeError("inference failed")

        class Pipeline:
            unet = types.SimpleNamespace(parameters=lambda: iter([types.SimpleNamespace(dtype="fp16")]))
            loop_video = staticmethod(lambda *args, **kwargs: None)

            def __call__(self, **kwargs):
                infer(**kwargs)

        helper = types.SimpleNamespace(**{
            name: (lambda operation=name: self.cache_calls.append(operation))
            for name in ("reset_states", "enable", "disable")
        })
        self.module.pipeline_state.update(
            pipeline=Pipeline(), helper=helper,
            config=types.SimpleNamespace(data=types.SimpleNamespace(num_frames=16, resolution=512, mask_image_path="mask.png")),
        )
        self.torch = types.SimpleNamespace(cuda=types.SimpleNamespace(empty_cache=lambda: None))
        self.accelerate = types.SimpleNamespace(set_seed=lambda value: self.seed_calls.append(value))

    def run_job(self, job_id, settings):
        self.module.jobs[job_id] = {"id": job_id, "inference_settings": dict(settings)}
        with patch.dict("sys.modules", torch=self.torch, **{"accelerate.utils": self.accelerate}):
            self.module.run_job(job_id, Path("video.mp4"), Path("audio.wav"), Path("result.mp4"))

    def test_cache_is_reset_between_cached_and_uncached_jobs_and_settings_reach_pipeline(self):
        cached = dict(self.module.DEFAULT_SETTINGS, inference_steps=20, enable_deepcache=True, seed=99)
        uncached = dict(self.module.DEFAULT_SETTINGS, guidance_scale=2.0)
        self.run_job("cached", cached)
        self.assertEqual(self.cache_calls, ["reset_states", "enable", "disable"])
        self.assertFalse(self.module.pipeline_state["deepcache_enabled"])
        self.run_job("uncached", uncached)
        self.assertEqual(self.cache_calls, ["reset_states", "enable", "disable", "reset_states", "reset_states"])
        self.assertEqual(self.seed_calls, [99, 1247])
        self.assertEqual([(call["num_inference_steps"], call["guidance_scale"], call["width"]) for call in self.pipeline_calls],
                         [(20, 1.5, 512), (40, 2.0, 512)])
        self.assertEqual(self.module.jobs["uncached"]["status"], "completed")

    def test_cached_failure_also_restores_uncached_pipeline(self):
        self.fail_pipeline = True
        self.run_job("failed", dict(self.module.DEFAULT_SETTINGS, enable_deepcache=True))
        self.assertEqual(self.module.jobs["failed"]["status"], "failed")
        self.assertEqual(self.cache_calls, ["reset_states", "enable", "disable"])
        self.assertFalse(self.module.pipeline_state["deepcache_enabled"])

    def test_float32_geometry_handles_each_new_processor_without_changing_models(self):
        class Tensor:
            def __init__(self, dtype):
                self.dtype = dtype

            def to(self, *, dtype):
                return Tensor(dtype)

        calls = []
        pipeline = types.SimpleNamespace(unet=object(), vae=object())
        unet, vae = pipeline.unet, pipeline.vae

        def aligned_loop(*args, **kwargs):
            restorer = pipeline.image_processor.restorer
            self.assertEqual((restorer.dtype, restorer.fill_value.dtype, restorer.mask.dtype),
                             ("float32", "float32", "float32"))
            calls.append((args, kwargs))
            return "aligned faces"

        pipeline.loop_video = aligned_loop
        with patch.dict("sys.modules", torch=types.SimpleNamespace(float32="float32")):
            with self.module.use_float32_geometry(pipeline):
                for index in range(2):
                    pipeline.image_processor = types.SimpleNamespace(restorer=types.SimpleNamespace(
                        dtype="float16", fill_value=Tensor("float16"), mask=Tensor("float16")))
                    self.assertEqual(pipeline.loop_video(index, frames="source"), "aligned faces")
        self.assertEqual(calls, [((0,), {"frames": "source"}), ((1,), {"frames": "source"})])
        self.assertIs(pipeline.loop_video, aligned_loop)
        self.assertIs(pipeline.unet, unet)
        self.assertIs(pipeline.vae, vae)
        with self.assertRaisesRegex(RuntimeError, "inference failure"):
            with self.module.use_float32_geometry(pipeline):
                raise RuntimeError("inference failure")
        self.assertIs(pipeline.loop_video, aligned_loop)

    def test_invalid_settings_are_rejected_and_submitted_settings_cannot_change(self):
        for changes in ({"inference_steps": 19}, {"inference_steps": 51}, {"inference_steps": True},
                        {"guidance_scale": float("nan")}, {"guidance_scale": 3.1}, {"enable_deepcache": "false"},
                        {"seed": -1}, {"seed": 4294967296}, {"seed": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.module.validate_settings(dict(self.module.DEFAULT_SETTINGS, **changes))
        self.module.jobs["job"] = {}
        self.module.set_job("job", inference_settings=self.module.DEFAULT_SETTINGS)
        with self.assertRaisesRegex(ValueError, "cannot change"):
            self.module.set_job("job", inference_settings=dict(self.module.DEFAULT_SETTINGS, inference_steps=50))

    def test_submission_persists_settings_before_enqueue_and_ignores_upload_filenames(self):
        class Upload:
            filename = "../../result.mp4"

            def __init__(self):
                self.sent = False

            async def read(self, size):
                if self.sent:
                    return b""
                self.sent = True
                return b"media"

        records = []
        original = self.module.set_job

        def persisted(job_id, **values):
            original(job_id, **values)
            self.assertEqual(self.module.queue.qsize(), 0)
            records.append(dict(self.module.jobs[job_id]))

        with patch.object(self.module, "set_job", side_effect=persisted):
            result = asyncio.run(self.module.create_job(Upload(), Upload(), 40, 1.5, False, 1247))
        self.assertEqual(result["inference_settings"], self.module.DEFAULT_SETTINGS)
        self.assertEqual(records, [result])
        self.assertEqual(self.module.queue.qsize(), 1)
        self.assertEqual(Path(result["input_video"]).name, "input-video.mp4")
        self.assertEqual(Path(result["input_audio"]).name, "input-audio.wav")

    def test_invalid_submission_returns_validation_error_without_upload_or_enqueue(self):
        with self.assertRaises(self.module.HTTPException) as error:
            asyncio.run(self.module.create_job(None, None, 40, float("nan"), False, 1247))
        self.assertEqual(error.exception.status_code, 422)
        self.assertFalse(self.module.jobs)
        self.assertTrue(self.module.queue.empty())


if __name__ == "__main__":
    unittest.main()
