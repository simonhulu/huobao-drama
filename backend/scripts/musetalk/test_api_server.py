"""Offline contract and lifecycle tests; no model downloads or GPU access."""

import hashlib
import http.client
import json
import os
from pathlib import Path
import queue
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from api_server import APIError, APIServer, JobService, read_submission
from runtime import GenerationCancelled, MODEL, SOURCE_REVISION, pipe_inference, validate_source


WAV = b"RIFF\x10\x00\x00\x00WAVEfake-audio-one"
FLAC = b"fLaCfake-audio-two"


def request_id(value):
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def multipart(fields):
    parts = []
    for name, value in fields:
        parts.append(b'--b\r\nContent-Disposition: form-data; name="' + name.encode("ascii") + b'"\r\n\r\n' + value + b'\r\n')
    return b"".join(parts) + b"--b--\r\n"


def wait_until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.005)
    raise AssertionError("Timed out waiting for worker state")


class FakeRunner:
    def __init__(self, hold=False, load_error=None):
        self.identity = {"model": MODEL, "source_revision": SOURCE_REVISION, "avatar_id": "xiaolu-r3-test",
                         "reference_sha256": "a" * 64, "fps": 15}
        self.release = threading.Event()
        if not hold:
            self.release.set()
        self.load_error = load_error
        self.load_calls = 0
        self.calls = []
        self.active = 0
        self.max_active = 0

    def load(self):
        self.load_calls += 1
        if self.load_error:
            raise RuntimeError(self.load_error)

    def generate(self, audio, output, cancel):
        self.calls.append(Path(audio).read_bytes())
        self.active += 1
        self.max_active = max(self.active, self.max_active)
        try:
            while not self.release.wait(0.005):
                if cancel.is_set():
                    raise GenerationCancelled("Cancelled by caller")
            if cancel.is_set():
                raise GenerationCancelled("Cancelled by caller")
            Path(output).write_bytes(b"fake-mp4:" + Path(audio).read_bytes())
            return {"audio_duration_seconds": 60.032, "video_duration_seconds": 60.0,
                    "width": 360, "height": 360, "elapsed_seconds": 1.0}
        finally:
            self.active -= 1


class MultiAvatarRunner(FakeRunner):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.history_identity = {**self.identity, "avatar_id": "xiaoba-history-01",
                                 "reference_sha256": "b" * 64, "avatar_profile_sha256": "c" * 64}
        self.avatar_calls = []

    def identity_for(self, avatar_id=None):
        if avatar_id in (None, self.identity["avatar_id"]):
            return dict(self.identity)
        if avatar_id == self.history_identity["avatar_id"]:
            return dict(self.history_identity)
        raise KeyError("Unknown registered avatar")

    def generate(self, audio, output, cancel, *, avatar_id=None):
        self.avatar_calls.append(avatar_id)
        return super().generate(audio, output, cancel)


class JobServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.services = []

    def tearDown(self):
        for service in reversed(self.services):
            service.close()
        self.directory.cleanup()

    def service(self, runner=None, max_queue=2, start=True):
        service = JobService(self.directory.name, runner or FakeRunner(), max_queue=max_queue)
        self.services.append(service)
        if start:
            service.start()
            wait_until(lambda: service.health()["status"] != "loading")
        return service

    def completed(self, service, job_id):
        return wait_until(lambda: (record if (record := service.get(job_id))["status"] == "completed" else None))

    def test_complete_idempotent_job_and_result_binding(self):
        runner = FakeRunner()
        runner.quality_config = {"audio_lookahead_frames": 2}
        service = self.service(runner)
        self.assertEqual(service.health()["quality_config"], runner.quality_config)
        job_id = request_id("first")
        record, created = service.submit(job_id, FLAC)
        self.assertTrue(created)
        record = self.completed(service, job_id)
        self.assertEqual(record["audio_sha256"], hashlib.sha256(FLAC).hexdigest())
        self.assertEqual(record["fps"], 15)
        self.assertEqual(record["width"], 360)
        self.assertEqual(record["id"], record["job_id"])
        self.assertTrue((Path(self.directory.name) / job_id / "audio.flac").is_file())
        duplicate, created = service.submit(job_id, FLAC)
        self.assertFalse(created)
        self.assertEqual(duplicate["result_sha256"], record["result_sha256"])
        source, size = service.result(job_id)
        with source:
            result = source.read()
        self.assertEqual(size, len(result))
        self.assertEqual(hashlib.sha256(result).hexdigest(), record["result_sha256"])
        self.assertEqual(runner.load_calls, 1)
        self.assertEqual(len(runner.calls), 1)
        service.submit(request_id("second"), WAV)
        self.completed(service, request_id("second"))
        self.assertEqual(runner.load_calls, 1)
        self.assertEqual(runner.max_active, 1)

    def test_same_id_cannot_rebind_audio_or_reference(self):
        service = self.service(start=False)
        job_id = request_id("binding")
        service.submit(job_id, WAV)
        with self.assertRaises(APIError) as caught:
            service.submit(job_id, FLAC)
        self.assertEqual(caught.exception.status, 409)
        service.identity["reference_sha256"] = "b" * 64
        with self.assertRaises(APIError) as caught:
            service.submit(job_id, WAV)
        self.assertEqual(caught.exception.status, 409)

    def test_explicit_avatar_identity_is_bound_to_health_job_and_serial_execution(self):
        runner = MultiAvatarRunner()
        service = self.service(runner)
        selected = runner.history_identity
        self.assertEqual(service.health("xiaoba-history-01")["reference_sha256"], selected["reference_sha256"])
        self.assertEqual(service.health()["avatar_id"], runner.identity["avatar_id"])
        job_id = request_id("history")
        record, created = service.submit(job_id, WAV, selected["avatar_id"], selected["reference_sha256"])
        self.assertTrue(created)
        self.assertEqual(record["avatar_profile_sha256"], selected["avatar_profile_sha256"])
        self.completed(service, job_id)
        duplicate, created = service.submit(job_id, WAV, selected["avatar_id"], selected["reference_sha256"])
        self.assertFalse(created)
        self.assertEqual(duplicate["avatar_selection"], selected["avatar_id"])
        with self.assertRaises(APIError) as caught:
            service.submit(job_id, WAV)
        self.assertEqual(caught.exception.status, 409)
        service.submit(request_id("science-after-history"), WAV)
        self.completed(service, request_id("science-after-history"))
        self.assertEqual(runner.avatar_calls, ["xiaoba-history-01", None])
        self.assertEqual((runner.load_calls, runner.max_active), (1, 1))

    def test_explicit_avatar_never_falls_back_for_missing_or_changed_registry_entries(self):
        runner = MultiAvatarRunner()
        service = self.service(runner, start=False)
        for avatar_id, reference_sha256, status in (("unknown", "b" * 64, 404),
                                                   ("xiaoba-history-01", "a" * 64, 409),
                                                   ("xiaoba-history-01", None, 400),
                                                   (None, "b" * 64, 400)):
            with self.subTest(avatar_id=avatar_id, reference_sha256=reference_sha256):
                with self.assertRaises(APIError) as caught:
                    service.submit(request_id("invalid"), WAV, avatar_id, reference_sha256)
                self.assertEqual(caught.exception.status, status)
        self.assertEqual(service.jobs, {})
        service.submit(request_id("changed-before-run"), WAV, "xiaoba-history-01", "b" * 64)
        runner.history_identity["avatar_profile_sha256"] = "d" * 64
        service.start()
        wait_until(lambda: service.get(request_id("changed-before-run"))["status"] == "failed")
        self.assertEqual(runner.calls, [])
        with self.assertRaises(APIError) as caught:
            service.retry(request_id("changed-before-run"))
        self.assertEqual(caught.exception.status, 409)

    def test_explicit_avatar_survives_restart_and_retry_without_rebinding(self):
        first = self.service(MultiAvatarRunner(), start=False)
        job_id = request_id("history-restart")
        first.submit(job_id, FLAC, "xiaoba-history-01", "b" * 64)
        first.close()
        self.services.remove(first)
        runner = MultiAvatarRunner()
        second = self.service(runner)
        self.assertTrue(second.get(job_id)["recoverable"])
        retried = second.retry(job_id)
        self.assertEqual(retried["avatar_profile_sha256"], "c" * 64)
        self.assertEqual(retried["avatar_selection"], "xiaoba-history-01")
        self.completed(second, job_id)
        self.assertEqual(runner.avatar_calls, ["xiaoba-history-01"])

    def test_bounded_queue_and_queued_cancellation(self):
        service = self.service(start=False, max_queue=1)
        first = request_id("queue-first")
        service.submit(first, WAV)
        with self.assertRaises(APIError) as caught:
            service.submit(request_id("queue-second"), WAV)
        self.assertEqual(caught.exception.status, 429)
        self.assertEqual(service.cancel(first)["status"], "cancelled")
        service.submit(request_id("queue-second"), WAV)
        self.assertEqual(service.health()["queue_depth"], 1)

    def test_running_cancel_releases_worker_and_explicit_retry(self):
        runner = FakeRunner(hold=True)
        service = self.service(runner)
        job_id = request_id("running-cancel")
        service.submit(job_id, WAV)
        wait_until(lambda: service.get(job_id)["status"] == "running")
        service.cancel(job_id)
        wait_until(lambda: service.get(job_id)["status"] == "cancelled")
        self.assertEqual(runner.active, 0)
        self.assertFalse((Path(self.directory.name) / job_id / "result.mp4").exists())
        self.assertEqual(service.submit(job_id, WAV)[0]["status"], "cancelled")
        runner.release.set()
        service.retry(job_id)
        result = self.completed(service, job_id)
        self.assertEqual(result["attempt"], 2)
        self.assertNotIn("cancel_requested", result)
        self.assertEqual(service.cancel(job_id)["status"], "completed")
        self.assertEqual(len(runner.calls), 2)

    def test_restart_exposes_interruption_and_explicit_retry(self):
        first = self.service(start=False)
        job_id = request_id("interrupted")
        first.submit(job_id, WAV)
        # Release only the OS lock to simulate abrupt process loss before a record update.
        first.process_lock.close()
        self.services.remove(first)
        second = self.service()
        record = second.get(job_id)
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["error_code"], "worker_interrupted")
        self.assertTrue(record["recoverable"])
        self.assertEqual(second.health()["queue_depth"], 0)
        self.assertEqual(len(second.runner.calls), 0)
        second.retry(job_id)
        self.completed(second, job_id)
        self.assertEqual(len(second.runner.calls), 1)

    def test_completed_result_survives_restart_without_regeneration(self):
        first = self.service()
        job_id = request_id("completed-restart")
        first.submit(job_id, WAV)
        expected = self.completed(first, job_id)
        first.close()
        self.services.remove(first)
        second = self.service()
        self.assertEqual(second.get(job_id)["result_sha256"], expected["result_sha256"])
        self.assertEqual(second.submit(job_id, WAV)[0]["status"], "completed")
        self.assertEqual(len(second.runner.calls), 0)

    def test_result_corruption_is_not_served_and_can_be_retried(self):
        service = self.service()
        job_id = request_id("corrupt")
        service.submit(job_id, WAV)
        self.completed(service, job_id)
        (Path(self.directory.name) / job_id / "result.mp4").write_bytes(b"corrupt")
        with self.assertRaises(APIError) as caught:
            service.result(job_id)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(service.get(job_id)["status"], "failed")
        service.retry(job_id)
        self.completed(service, job_id)
        self.assertEqual(len(service.runner.calls), 2)

    def test_retry_rejects_changed_stored_audio(self):
        service = self.service(start=False)
        job_id = request_id("audio-corrupt")
        service.submit(job_id, WAV)
        service.cancel(job_id)
        (Path(self.directory.name) / job_id / "audio.wav").write_bytes(FLAC)
        with self.assertRaises(APIError) as caught:
            service.retry(job_id)
        self.assertEqual(caught.exception.status, 409)

    def test_runtime_load_failure_is_visible_and_does_not_run_jobs(self):
        service = self.service(FakeRunner(load_error="missing model"), start=False)
        job_id = request_id("load-failure")
        service.submit(job_id, WAV)
        service.start()
        wait_until(lambda: service.health()["status"] == "failed")
        self.assertFalse(service.health()["ok"])
        self.assertEqual(service.get(job_id)["status"], "failed")
        self.assertIn("missing model", service.get(job_id)["error"])
        with self.assertRaises(APIError) as caught:
            service.submit(request_id("not-accepted"), WAV)
        self.assertEqual(caught.exception.status, 503)

    def test_second_worker_cannot_open_same_store(self):
        self.service(start=False)
        with self.assertRaises(OSError):
            JobService(self.directory.name, FakeRunner())

    def test_http_multipart_status_result_and_error_contract(self):
        service = self.service(MultiAvatarRunner())
        server = APIServer(("127.0.0.1", 0), service, max_upload_bytes=2048)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            try:
                connection.request(method, path, body=body, headers=headers or {})
                response = connection.getresponse()
                payload = response.read()
                return response.status, payload
            finally:
                connection.close()

        try:
            status, body = request("GET", "/health")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["status"], "ready")
            job_id = request_id("http")
            body = (b"--test-boundary\r\nContent-Disposition: form-data; name=\"request_id\"\r\n\r\n" +
                    job_id.encode("ascii") + b"\r\n--test-boundary\r\n" +
                    b"Content-Disposition: form-data; name=\"audio\"; filename=\"../../audio.flac\"\r\n" +
                    b"Content-Type: audio/flac\r\n\r\n" + FLAC + b"\r\n--test-boundary--\r\n")
            headers = {"Content-Type": "multipart/form-data; boundary=test-boundary"}
            status, response = request("POST", "/v1/lipsync", body, headers)
            self.assertEqual(status, 201)
            self.assertEqual(json.loads(response)["job_id"], job_id)
            expected = self.completed(service, job_id)
            self.assertEqual(request("POST", "/v1/lipsync", body, headers)[0], 200)
            status, response = request("GET", f"/v1/jobs/{job_id}/result")
            self.assertEqual(status, 200)
            self.assertEqual(hashlib.sha256(response).hexdigest(), expected["result_sha256"])
            self.assertEqual(request("GET", f"/v1/jobs/{request_id('missing')}")[0], 404)
            self.assertEqual(request("POST", "/v1/lipsync", b"x" * 2049, headers)[0], 413)
            self.assertEqual(request("POST", "/v1/lipsync", b"invalid", headers)[0], 400)
            self.assertEqual(request("DELETE", f"/v1/jobs/{job_id}")[0], 200)
            self.assertEqual(request("POST", f"/v1/jobs/{job_id}/retry")[0], 200)
            self.assertEqual(len(service.runner.calls), 1)
            status, response = request("GET", "/health?avatar_id=xiaoba-history-01")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(response)["avatar_profile_sha256"], "c" * 64)
            self.assertEqual(request("GET", "/health?avatar_id=unknown")[0], 404)
            self.assertEqual(request("GET", "/health?avatar_id=xiaoba-history-01&avatar_id=other")[0], 400)
            history_job = request_id("http-history")
            history_form = multipart([("request_id", history_job.encode("ascii")), ("audio", WAV),
                                      ("avatar_id", b"xiaoba-history-01"), ("reference_sha256", b"b" * 64)])
            status, response = request("POST", "/v1/lipsync", history_form,
                                       {"Content-Type": "multipart/form-data; boundary=b"})
            self.assertEqual(status, 201)
            self.assertEqual(json.loads(response)["avatar_selection"], "xiaoba-history-01")
            self.completed(service, history_job)
            self.assertEqual(service.runner.avatar_calls, [None, "xiaoba-history-01"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_parser_rejects_duplicate_fields(self):
        body = (b"--b\r\nContent-Disposition: form-data; name=\"request_id\"\r\n\r\n" +
                b"a" * 64 + b"\r\n--b\r\nContent-Disposition: form-data; name=\"request_id\"\r\n\r\n" +
                b"b" * 64 + b"\r\n--b--\r\n")
        with self.assertRaises(APIError):
            read_submission("multipart/form-data; boundary=b", body)

    def test_parser_requires_complete_valid_avatar_identity_pair(self):
        base = [("request_id", b"a" * 64), ("audio", WAV)]
        for extra in ([("avatar_id", b"xiaoba-history-01")], [("reference_sha256", b"b" * 64)],
                      [("avatar_id", b"../escape"), ("reference_sha256", b"b" * 64)],
                      [("avatar_id", b"xiaoba-history-01"), ("reference_sha256", b"invalid")],
                      [("avatar_id", b"xiaoba-history-01"), ("avatar_id", b"other"), ("reference_sha256", b"b" * 64)]):
            with self.subTest(extra=extra), self.assertRaises(APIError):
                read_submission("multipart/form-data; boundary=b", multipart(base + extra))


class FakeFrame:
    shape = (540, 960, 3)

    def __getitem__(self, key):
        return self

    def tobytes(self):
        return b"x" * (360 * 360 * 3)


class FakeEncoder:
    def __init__(self):
        self.stdin = tempfile.TemporaryFile()
        self.returncode = None

    def poll(self):
        if self.stdin.closed and self.returncode is None:
            self.returncode = 0
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return self.returncode

    def kill(self):
        self.returncode = -9


class SourceVersionTests(unittest.TestCase):
    def test_source_archive_accepts_matching_files_and_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "scripts/realtime_inference.py"
            source.parent.mkdir()
            source.write_bytes(b"pinned source")
            manifest = {"scripts/realtime_inference.py": hashlib.sha256(b"pinned source").hexdigest()}
            with patch("runtime.SOURCE_FILES", manifest), patch("runtime.subprocess.run") as git:
                validate_source(directory)
                git.assert_not_called()
                source.write_bytes(b"modified source")
                with self.assertRaisesRegex(RuntimeError, "source archive does not match"):
                    validate_source(directory)
                source.unlink()
                with self.assertRaisesRegex(RuntimeError, "source archive does not match"):
                    validate_source(directory)


class PipeLifecycleTests(unittest.TestCase):
    def test_complete_frame_count_and_cancelled_producer_cleanup(self):
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled), tempfile.TemporaryDirectory() as directory:
                cancel = threading.Event()
                upstream = SimpleNamespace(
                    args=SimpleNamespace(skip_save_images=False), datagen=lambda *a, **k: iter(range(3)),
                    cv2=SimpleNamespace(resize=lambda *a: FakeFrame()),
                    get_image_blending=lambda *a: FakeFrame(),
                )
                avatar = SimpleNamespace(
                    video_out_path=directory, frame_list_cycle=[FakeFrame()], coord_list_cycle=[(1, 1, 3, 3)],
                    mask_list_cycle=[None], mask_coords_list_cycle=[None], idx=0,
                    process_frames=lambda *a: None,
                )

                def inference(*args):
                    frames = queue.Queue()
                    avatar.consumer = threading.Thread(target=avatar.process_frames, args=(frames, 3, True))
                    avatar.consumer.start()
                    for index in upstream.datagen():
                        frames.put(FakeFrame())
                        if cancelled:
                            cancel.set()
                    avatar.consumer.join(timeout=2)

                avatar.inference = inference
                process_frames, datagen = avatar.process_frames, upstream.datagen
                encoder = FakeEncoder()
                with patch("runtime.subprocess.Popen", return_value=encoder):
                    if cancelled:
                        with self.assertRaises(GenerationCancelled):
                            pipe_inference(avatar, upstream, WAV, "out", 15, "libx264", cancel)
                    else:
                        pipe_inference(avatar, upstream, WAV, "out", 15, "libx264", cancel)
                        self.assertEqual(avatar.idx, 3)
                self.assertFalse(avatar.consumer.is_alive())
                self.assertTrue(encoder.stdin.closed)
                self.assertIs(avatar.process_frames, process_frames)
                self.assertIs(upstream.datagen, datagen)
                self.assertFalse(upstream.args.skip_save_images)


if __name__ == "__main__":
    unittest.main()
