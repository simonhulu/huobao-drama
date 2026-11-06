"""Validation wrapper around the existing LatentSync api_server, not a new inference pipeline."""

import hashlib
import json
import re
import subprocess
import uuid
from pathlib import Path

import api_server as upstream


VAE_SIZE = 334643276
VAE_SHA256 = "a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815"
VAE_REVISION = "31f26fdeee1355a5c34592e401dd41e45d25a493"
UNET_SIZE = 5072222488
UNET_SHA256 = "0a478e89eb660f82da4c35dbdde8a5adfb27f99d1b4e50edd03729e1e98316d3"
WHISPER_SIZE = 75572083
WHISPER_SHA256 = "65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9"
app = upstream.app
_load_pipeline = upstream.load_pipeline
_run_job = upstream.run_job
_set_job = upstream.set_job


def verify_vae(filename, expected_size=VAE_SIZE, expected_sha256=VAE_SHA256):
    return verify_weights(filename, expected_size, expected_sha256, "VAE")


def verify_weights(filename, expected_size, expected_sha256, name):
    filename = Path(filename)
    if filename.stat().st_size != expected_size:
        raise RuntimeError(f"{name} download is incomplete: unexpected file size")
    sha = hashlib.sha256()
    with filename.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    if sha.hexdigest() != expected_sha256:
        raise RuntimeError(f"{name} SHA-256 mismatch: incomplete or corrupted weights; refusing inference")
    return sha.hexdigest()


def media_info(filename):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(filename)],
        check=True, capture_output=True, text=True, timeout=60,
    )
    return json.loads(result.stdout)


def validate_output(filename, audio_path):
    filename = Path(filename)
    if not filename.is_file() or filename.stat().st_size == 0:
        raise RuntimeError("LatentSync did not write the final video_out_path")
    data = media_info(filename)
    video = next((s for s in data["streams"] if s.get("codec_type") == "video"), None)
    audio = next((s for s in data["streams"] if s.get("codec_type") == "audio"), None)
    if not video or not audio or video.get("width", 0) <= 0 or video.get("height", 0) <= 0:
        raise RuntimeError("LatentSync final output must contain restored video and audio")
    expected = float(media_info(audio_path)["format"]["duration"])
    actual = float(video.get("duration") or data["format"]["duration"])
    if expected <= 0 or not expected - 0.15 <= actual <= expected + 0.25:
        raise RuntimeError("LatentSync final video does not cover the narration duration")


def persist_job(record):
    directory = upstream.JOB_ROOT / record["id"]
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / f".job-{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("w", encoding="utf-8") as target:
            json.dump(record, target)
        temporary.replace(directory / "job.json")
    finally:
        temporary.unlink(missing_ok=True)


def set_job(job_id, **values):
    if values.get("status") == "completed":
        with upstream.jobs_lock:
            current = dict(upstream.jobs[job_id])
        upstream.validate_settings(current.get("inference_settings"))
        if values.get("result") != current.get("output_path"):
            raise RuntimeError("LatentSync result is not the requested final video_out_path")
        validate_output(values["result"], current["input_audio"])
        values.update(output_stage="restored_video", vae_sha256=VAE_SHA256)
    _set_job(job_id, **values)
    with upstream.jobs_lock:
        record = dict(upstream.jobs[job_id])
    persist_job(record)


def restore_jobs():
    for filename in upstream.JOB_ROOT.glob("*/job.json"):
        try:
            record = json.loads(filename.read_text(encoding="utf-8"))
            job_id = filename.parent.name
            if not isinstance(record, dict) or not re.fullmatch(r"[a-f0-9]{32}", job_id) or record.get("id") != job_id:
                continue
            if record.get("status") == "completed":
                try:
                    if (record.get("output_stage") != "restored_video"
                            or record.get("vae_sha256") != VAE_SHA256
                            or Path(record["result"]).resolve() != (filename.parent / "result.mp4").resolve()):
                        raise RuntimeError("Legacy result has not passed final-output validation")
                    upstream.validate_settings(record.get("inference_settings"))
                    validate_output(record["result"], record["input_audio"])
                except (RuntimeError, KeyError, OSError, ValueError, subprocess.SubprocessError) as error:
                    record.update(status="failed", result=None, error=str(error))
            elif record.get("status") in ("queued", "running", "processing", "in_progress"):
                record.update(status="failed", result=None, error="Service restarted before inference completed; task was not replayed")
            with upstream.jobs_lock:
                upstream.jobs[job_id] = record
            persist_job(record)
        except (OSError, ValueError, TypeError):
            continue


def load_pipeline():
    restore_jobs()
    verify_vae(upstream.VAE_PATH / "diffusion_pytorch_model.safetensors")
    verify_weights(upstream.CHECKPOINT, UNET_SIZE, UNET_SHA256, "UNet")
    verify_weights(upstream.ROOT / "checkpoints/whisper/tiny.pt", WHISPER_SIZE, WHISPER_SHA256, "Whisper")
    _load_pipeline()
    pipeline = upstream.pipeline_state["pipeline"]
    decode = pipeline.decode_latents

    def checked_decode(latents):
        import torch
        decoded = decode(latents)
        if decoded.ndim != 4 or decoded.numel() == 0 or not bool(torch.isfinite(decoded).all()):
            raise RuntimeError("LatentSync decoder produced invalid pixels")
        spatial_variance = decoded.float().var(dim=(-2, -1), unbiased=False).mean(dim=1)
        if bool((spatial_variance < 1e-8).any()):
            raise RuntimeError("LatentSync decoder produced a constant frame; refusing gray output")
        return decoded

    pipeline.decode_latents = checked_decode


def run_job(job_id, video_path, audio_path, output_path):
    set_job(job_id, input_video=str(video_path), input_audio=str(audio_path), output_path=str(output_path))
    return _run_job(job_id, video_path, audio_path, output_path)


upstream.load_pipeline = load_pipeline
upstream.run_job = run_job
upstream.set_job = set_job
