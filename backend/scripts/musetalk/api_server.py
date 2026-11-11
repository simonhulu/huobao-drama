"""Loopback MuseTalk API with one warm GPU worker and durable idempotent jobs.

No web framework or new runtime dependency is required. Expose through SSH,
not a public interface. All server paths are configured on the GPU machine.
"""

import argparse
from collections import deque
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import threading
from urllib.parse import parse_qs, urlsplit

from runtime import GenerationCancelled, MuseTalkRuntime, add_quality_arguments, file_hash


REQUEST_ID = re.compile(r"[0-9a-f]{64}\Z")
AVATAR_ID = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")
MAX_UPLOAD_BYTES = 128 * 1024 * 1024
TERMINAL = {"completed", "failed", "cancelled"}


def now():
    return datetime.now(timezone.utc).isoformat()


class APIError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def audio_suffix(audio):
    if audio.startswith(b"fLaC"):
        return ".flac"
    if audio.startswith(b"RIFF") and audio[8:12] == b"WAVE":
        return ".wav"
    raise APIError(400, "Upload a WAV or FLAC narration file")


class JobService:
    def __init__(self, root, runner, max_queue=2):
        if max_queue < 1:
            raise ValueError("Queue capacity must be positive")
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.runner = runner
        self.identity = dict(runner.identity)
        self.max_queue = max_queue
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.pending = deque()
        self.jobs = {}
        self.active_id = None
        self.active_cancel = None
        self.status, self.error = "loading", None
        self.stopping = False
        self.worker = None
        # A second process must not load the same avatar and consume the same queue.
        self.process_lock = (self.root / ".worker.lock").open("a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.process_lock.seek(0)
                if not self.process_lock.read(1):
                    self.process_lock.write(b"0")
                    self.process_lock.flush()
                self.process_lock.seek(0)
                msvcrt.locking(self.process_lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.process_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._restore()
        except BaseException:
            self.process_lock.close()
            raise

    def _job_directory(self, job_id):
        if not REQUEST_ID.fullmatch(job_id):
            raise APIError(400, "Invalid request_id")
        return self.root / job_id

    def _persist(self, record):
        directory = self._job_directory(record["id"])
        temporary = directory / "record.tmp"
        with temporary.open("w", encoding="utf-8") as target:
            json.dump(record, target, ensure_ascii=True, indent=2)
            target.flush()
            os.fsync(target.fileno())
        temporary.replace(directory / "record.json")

    def _compatible(self, record):
        try:
            selected = self._identity(record.get("avatar_selection"),
                                      record.get("reference_sha256") if record.get("avatar_selection") else None)
            return all(record.get(key) == value for key, value in selected.items())
        except APIError:
            return False

    def _identity(self, avatar_id=None, reference_sha256=None):
        if avatar_id is None and reference_sha256 is None:
            return dict(self.identity)
        if not isinstance(avatar_id, str) or not AVATAR_ID.fullmatch(avatar_id) \
                or not isinstance(reference_sha256, str) or not REQUEST_ID.fullmatch(reference_sha256):
            raise APIError(400, "Provide valid avatar_id and reference_sha256 together")
        try:
            if hasattr(self.runner, "identity_for"):
                selected = self.runner.identity_for(avatar_id)
            elif avatar_id == self.identity["avatar_id"]:
                selected = dict(self.identity)
            else:
                raise KeyError("Unknown registered avatar")
        except KeyError as error:
            raise APIError(404, "Unknown registered avatar") from error
        except (OSError, ValueError) as error:
            raise APIError(409, "Registered avatar reference failed checksum validation") from error
        if selected["reference_sha256"] != reference_sha256:
            raise APIError(409, "Registered avatar reference_sha256 does not match")
        return selected

    def _audio_path(self, record):
        suffix = record.get("audio_suffix")
        if suffix not in (".wav", ".flac"):
            raise RuntimeError("Stored audio format is invalid")
        return self._job_directory(record["id"]) / f"audio{suffix}"

    def _restore(self):
        for directory in sorted(self.root.iterdir()):
            if not directory.is_dir() or not REQUEST_ID.fullmatch(directory.name):
                continue
            path = directory / "record.json"
            if not path.is_file():
                # An upload interrupted before its atomic record commit was never accepted.
                shutil.rmtree(directory)
                continue
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("id") != directory.name or record.get("status") not in TERMINAL | {"queued", "running"}:
                raise RuntimeError(f"Invalid persisted job record: {path}")
            self._audio_path(record)
            self.jobs[record["id"]] = record
            if record["status"] in ("queued", "running"):
                record.update(status="failed", error="Worker restarted before this job finished",
                              error_code="worker_interrupted", finished_at=now(),
                              recoverable=self._compatible(record) and self._audio_path(record).is_file())
                record.pop("cancel_requested", None)
                self._persist(record)

    def start(self):
        with self.lock:
            if self.worker is not None:
                raise RuntimeError("Worker has already started")
            self.worker = threading.Thread(target=self._work, name="musetalk-gpu-worker", daemon=False)
            self.worker.start()

    def health(self, avatar_id=None):
        with self.lock:
            if avatar_id is None:
                selected = dict(self.identity)
            else:
                if not isinstance(avatar_id, str) or not AVATAR_ID.fullmatch(avatar_id):
                    raise APIError(400, "Invalid avatar_id")
                try:
                    selected = self.runner.identity_for(avatar_id)
                except (AttributeError, KeyError) as error:
                    raise APIError(404, "Unknown registered avatar") from error
                except (OSError, ValueError) as error:
                    raise APIError(409, "Registered avatar reference failed checksum validation") from error
            result = {"ok": self.status == "ready" and not self.stopping,
                      "status": self.status, **selected, "queue_depth": len(self.pending),
                      "active_job_id": self.active_id}
            if hasattr(self.runner, "quality_for"):
                result["quality_config"] = self.runner.quality_for(avatar_id)
            elif hasattr(self.runner, "quality_config"):
                result["quality_config"] = dict(self.runner.quality_config)
            if self.error:
                result["error"] = self.error
            return result

    def _require_capacity(self):
        if self.stopping or self.status == "failed":
            raise APIError(503, "MuseTalk worker is unavailable")
        if len(self.pending) >= self.max_queue:
            raise APIError(429, "MuseTalk queue is full; retry later with the same request_id")

    def submit(self, request_id, audio, avatar_id=None, reference_sha256=None):
        self._job_directory(request_id)
        suffix = audio_suffix(audio)
        digest = hashlib.sha256(audio).hexdigest()
        selected = self._identity(avatar_id, reference_sha256)
        with self.changed:
            if request_id in self.jobs:
                record = self.jobs[request_id]
                if record["audio_sha256"] != digest or not self._compatible(record) \
                        or any(record.get(key) != value for key, value in selected.items()):
                    raise APIError(409, "request_id is already bound to a different audio/model/avatar")
                return self._public(record), False
            self._require_capacity()
            directory = self._job_directory(request_id)
            directory.mkdir()
            try:
                with (directory / f"audio{suffix}").open("xb") as target:
                    target.write(audio)
                    target.flush()
                    os.fsync(target.fileno())
                record = {"id": request_id, "job_id": request_id, "request_id": request_id,
                          "status": "queued", "audio_sha256": digest, "audio_suffix": suffix,
                          **selected, "created_at": now(), "attempt": 1}
                if avatar_id is not None:
                    record["avatar_selection"] = avatar_id
                self._persist(record)
            except BaseException:
                shutil.rmtree(directory)
                raise
            self.jobs[request_id] = record
            self.pending.append(request_id)
            self.changed.notify_all()
            return self._public(record), True

    @staticmethod
    def _public(record):
        return {key: value for key, value in record.items() if key != "audio_suffix"}

    def _get(self, job_id):
        self._job_directory(job_id)
        if job_id not in self.jobs:
            raise APIError(404, "Job not found")
        return self.jobs[job_id]

    def get(self, job_id):
        with self.lock:
            return self._public(self._get(job_id))

    def cancel(self, job_id):
        with self.changed:
            record = self._get(job_id)
            if record["status"] == "queued":
                self.pending.remove(job_id)
                record.update(status="cancelled", recoverable=True, finished_at=now())
                self._persist(record)
            elif record["status"] == "running":
                self.active_cancel.set()
                record["cancel_requested"] = True
                self._persist(record)
            self.changed.notify_all()
            return self._public(record)

    def retry(self, job_id):
        with self.changed:
            record = self._get(job_id)
            if record["status"] not in ("failed", "cancelled"):
                return self._public(record)
            if not self._compatible(record):
                raise APIError(409, "This job belongs to a different model/avatar configuration")
            audio = self._audio_path(record)
            if not audio.is_file() or file_hash(audio) != record["audio_sha256"]:
                raise APIError(409, "Original audio is missing or its checksum changed")
            self._require_capacity()
            retained = {key: record[key] for key in ("id", "job_id", "request_id", "audio_sha256",
                                                    "audio_suffix", "created_at", *self.identity)}
            for key in ("avatar_selection", "avatar_profile_sha256"):
                if key in record:
                    retained[key] = record[key]
            retained.update(status="queued", attempt=record.get("attempt", 1) + 1, retried_at=now())
            self._persist(retained)
            self.jobs[job_id] = retained
            self.pending.append(job_id)
            self.changed.notify_all()
            return self._public(retained)

    def result(self, job_id):
        with self.lock:
            record = self._get(job_id)
            if record["status"] != "completed":
                raise APIError(409, "Job has not completed")
            path = self._job_directory(job_id) / "result.mp4"
            if not path.is_file() or file_hash(path) != record.get("result_sha256"):
                record.update(status="failed", error="Result is missing or its checksum changed",
                              error_code="result_integrity", recoverable=self._audio_path(record).is_file())
                self._persist(record)
                raise APIError(409, record["error"])
            # Keep this descriptor open so a retry cannot replace an in-flight response.
            return path.open("rb"), path.stat().st_size

    def _work(self):
        try:
            self.runner.load()
            with self.changed:
                self.status = "ready"
                self.changed.notify_all()
        except BaseException as error:
            with self.changed:
                self.status, self.error = "failed", str(error)
                while self.pending:
                    record = self.jobs[self.pending.popleft()]
                    record.update(status="failed", error=f"Runtime failed to load: {error}",
                                  recoverable=True, finished_at=now())
                    self._persist(record)
                self.changed.notify_all()
            return
        while True:
            with self.changed:
                self.changed.wait_for(lambda: self.stopping or self.pending)
                if self.stopping:
                    return
                job_id = self.pending.popleft()
                record = self.jobs[job_id]
                record.update(status="running", started_at=now())
                self._persist(record)
                self.active_id, self.active_cancel = job_id, threading.Event()
                cancel = self.active_cancel
            directory = self._job_directory(job_id)
            partial = directory / "result.partial.mp4"
            try:
                partial.unlink(missing_ok=True)
                selected = record.get("avatar_selection")
                if not self._compatible(record):
                    raise RuntimeError("Stored job avatar identity no longer matches the registry")
                metadata = self.runner.generate(self._audio_path(record), partial, cancel,
                                                **({"avatar_id": selected} if selected is not None else {}))
                if not partial.is_file() or not partial.stat().st_size:
                    raise RuntimeError("Runtime did not produce an MP4")
                digest = file_hash(partial)
                with self.changed:
                    if cancel.is_set():
                        raise GenerationCancelled("Generation cancelled")
                    partial.replace(directory / "result.mp4")
                    record.update({key: metadata[key] for key in ("audio_duration_seconds", "video_duration_seconds",
                                                                 "width", "height", "elapsed_seconds")})
                    record.update(status="completed", result_sha256=digest,
                                  result_url=f"/v1/jobs/{job_id}/result", finished_at=now(), recoverable=False)
                    record.pop("cancel_requested", None)
                    self._persist(record)
            except BaseException as error:
                with self.changed:
                    record.update(status="cancelled" if cancel.is_set() or isinstance(error, GenerationCancelled)
                                  else "failed", error=str(error), finished_at=now(), recoverable=True)
                    record.pop("cancel_requested", None)
                    self._persist(record)
            finally:
                partial.unlink(missing_ok=True)
                with self.changed:
                    self.active_id = self.active_cancel = None
                    self.changed.notify_all()

    def close(self, timeout=30):
        with self.changed:
            self.stopping = True
            if self.active_cancel:
                self.active_cancel.set()
            while self.pending:
                record = self.jobs[self.pending.popleft()]
                record.update(status="cancelled", error="Worker is shutting down", recoverable=True,
                              finished_at=now())
                self._persist(record)
            self.changed.notify_all()
        if self.worker is not None:
            self.worker.join(timeout=timeout)
            if self.worker.is_alive():
                raise RuntimeError("GPU worker did not stop; do not start another process until it exits")
        self.process_lock.close()


def read_submission(content_type, body):
    if "\r" in content_type or "\n" in content_type:
        raise APIError(400, "Invalid Content-Type")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    if message.get_content_type() != "multipart/form-data" or not message.is_multipart() or message.defects:
        raise APIError(400, "Expected multipart/form-data")
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if part.get_content_disposition() != "form-data" or name not in ("audio", "request_id", "avatar_id", "reference_sha256") or name in fields:
            raise APIError(400, "Expected one audio file and one request_id")
        if part.is_multipart() or part.defects:
            raise APIError(400, "Invalid multipart field")
        fields[name] = part.get_payload(decode=True)
    if fields.keys() not in ({"audio", "request_id"}, {"audio", "request_id", "avatar_id", "reference_sha256"}) or not fields["audio"]:
        raise APIError(400, "Expected one audio file and one request_id")
    try:
        request_id = fields["request_id"].decode("ascii")
    except UnicodeDecodeError as error:
        raise APIError(400, "Invalid request_id") from error
    if not REQUEST_ID.fullmatch(request_id):
        raise APIError(400, "request_id must be 64 lowercase hexadecimal characters")
    if "avatar_id" not in fields:
        return request_id, fields["audio"]
    try:
        avatar_id = fields["avatar_id"].decode("ascii")
        reference_sha256 = fields["reference_sha256"].decode("ascii")
    except UnicodeDecodeError as error:
        raise APIError(400, "Invalid avatar identity fields") from error
    if not AVATAR_ID.fullmatch(avatar_id) or not REQUEST_ID.fullmatch(reference_sha256):
        raise APIError(400, "Invalid avatar identity fields")
    return request_id, fields["audio"], avatar_id, reference_sha256


class APIServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, service, max_upload_bytes=MAX_UPLOAD_BYTES):
        self.service = service
        self.max_upload_bytes = max_upload_bytes
        self.upload_slots = threading.BoundedSemaphore(2)
        super().__init__(address, APIHandler)


class APIHandler(BaseHTTPRequestHandler):
    server_version = "MuseTalkAPI/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(120)

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if status in (429, 503):
            self.send_header("Retry-After", "3")
        self.end_headers()
        self.wfile.write(body)

    def _dispatch(self):
        url = urlsplit(self.path)
        path = url.path
        service = self.server.service
        if self.command == "GET" and path == "/health":
            query = parse_qs(url.query, keep_blank_values=True)
            if set(query) - {"avatar_id"} or "avatar_id" in query and len(query["avatar_id"]) != 1:
                raise APIError(400, "Health accepts one optional avatar_id")
            self._json(200, service.health(query.get("avatar_id", [None])[0]))
            return
        if self.command == "POST" and path == "/v1/lipsync":
            if self.headers.get("Transfer-Encoding"):
                raise APIError(400, "Send Content-Length, not chunked encoding")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as error:
                raise APIError(400, "Invalid Content-Length") from error
            if not 0 < length <= self.server.max_upload_bytes:
                raise APIError(413, "Narration upload is empty or too large")
            if not self.server.upload_slots.acquire(blocking=False):
                raise APIError(429, "Too many simultaneous uploads")
            try:
                body = self.rfile.read(length)
                if len(body) != length:
                    raise APIError(400, "Incomplete narration upload")
                submission = read_submission(self.headers.get("Content-Type", ""), body)
                record, created = service.submit(*submission)
            finally:
                self.server.upload_slots.release()
            self._json(201 if created else 200, record)
            return
        match = re.fullmatch(r"/v1/jobs/([0-9a-f]{64})(?:/(result|retry))?", path)
        if match:
            job_id, action = match.groups()
            if self.command == "GET" and action is None:
                self._json(200, service.get(job_id))
                return
            if self.command == "DELETE" and action is None:
                self._json(200, service.cancel(job_id))
                return
            if self.command == "POST" and action == "retry":
                self._json(200, service.retry(job_id))
                return
            if self.command == "GET" and action == "result":
                source, length = service.result(job_id)
                with source:
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Content-Disposition", 'attachment; filename="presenter.mp4"')
                    self.end_headers()
                    shutil.copyfileobj(source, self.wfile, length=1024 * 1024)
                return
        raise APIError(404, "Endpoint not found")

    def _handle(self):
        try:
            self._dispatch()
        except APIError as error:
            self._json(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception as error:
            self.log_error("Request failed: %s", error)
            self._json(500, {"error": "Internal server error; see server log"})

    do_GET = do_POST = do_DELETE = _handle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=os.environ.get("MUSETALK_ROOT"))
    parser.add_argument("--reference", type=Path, default=os.environ.get("MUSETALK_REFERENCE_PATH"))
    parser.add_argument("--jobs", type=Path, default=os.environ.get("MUSETALK_JOB_ROOT"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8789)
    add_quality_arguments(parser)
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--queue-size", type=int, default=2)
    parser.add_argument("--codec", choices=("libx264", "h264_nvenc"), default="libx264")
    parser.add_argument("--preprocessing-module", type=Path)
    parser.add_argument("--avatar-registry", type=Path, default=os.environ.get("MUSETALK_AVATAR_REGISTRY"))
    args = parser.parse_args()
    if not args.root or not args.reference or not args.jobs:
        parser.error("Set --root, --reference, --jobs (or corresponding MUSETALK_* environment variables)")
    try:
        if not ipaddress.ip_address(args.host).is_loopback:
            parser.error("Bind a loopback IP and use SSH forwarding")
    except ValueError:
        parser.error("--host must be a loopback IP address")
    runner = MuseTalkRuntime(args.root, args.reference, args.fps, args.batch_size,
                            args.codec, args.preprocessing_module, precision=args.precision,
                            extra_margin=args.extra_margin, parsing_mode=args.parsing_mode,
                            left_cheek_width=args.left_cheek_width, right_cheek_width=args.right_cheek_width,
                            audio_lookahead_frames=args.audio_lookahead_frames, avatar_registry=args.avatar_registry)
    service = JobService(args.jobs, runner, args.queue_size)
    server = APIServer((args.host, args.port), service)

    def shutdown(signum, frame):
        # HTTPServer.shutdown must be called from a different thread than serve_forever.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        service.start()
        print(json.dumps({"listening": f"http://{args.host}:{args.port}", **service.identity}), flush=True)
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        try:
            service.close()
        except RuntimeError as error:
            # A stuck native CUDA call must not survive process shutdown or run beside a new worker.
            print(str(error), file=sys.stderr, flush=True)
            os._exit(1)


if __name__ == "__main__":
    main()
