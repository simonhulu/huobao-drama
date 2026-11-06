"""Serial HTTP adapter for the official LatentSync 1.6 inference pipeline."""

import asyncio
import math
import os
import shutil
import sys
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse


ROOT = Path(os.environ.get("LATENTSYNC_ROOT", "/root/rivermind-data/LatentSync"))
JOB_ROOT = Path(os.environ.get("LATENTSYNC_JOB_ROOT", "/root/rivermind-data/latentsync-jobs"))
CHECKPOINT = ROOT / "checkpoints/latentsync_unet.pt"
CONFIG = ROOT / "configs/unet/stage2_512.yaml"
VAE_PATH = Path(os.environ.get("LATENTSYNC_VAE_PATH", "/root/rivermind-data/models/sd-vae-ft-mse"))
MAX_UPLOAD_BYTES = int(os.environ.get("LATENTSYNC_MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024)))
DEFAULT_SETTINGS = {
    "inference_steps": 40,
    "guidance_scale": 1.5,
    "enable_deepcache": False,
    "seed": 1247,
}

app = FastAPI(title="LatentSync API", version="1.6")
jobs = {}
jobs_lock = threading.Lock()
queue = asyncio.Queue()
pipeline_state = {"pipeline": None, "config": None, "helper": None, "deepcache_enabled": False, "error": None}


def validate_settings(settings):
    if not isinstance(settings, dict) or set(settings) != set(DEFAULT_SETTINGS):
        raise ValueError("LatentSync inference settings must contain all four supported fields")
    steps, guidance, cache, seed = (settings[key] for key in DEFAULT_SETTINGS)
    if type(steps) is not int or not 20 <= steps <= 50:
        raise ValueError("inference_steps must be an integer from 20 to 50")
    if type(guidance) not in (int, float) or not math.isfinite(guidance) or not 1 <= guidance <= 3:
        raise ValueError("guidance_scale must be finite and between 1 and 3")
    if type(cache) is not bool:
        raise ValueError("enable_deepcache must be a boolean")
    if type(seed) is not int or not 0 <= seed <= 4294967295:
        raise ValueError("seed must be an integer from 0 to 4294967295")
    return dict(settings)


def set_job(job_id, **values):
    with jobs_lock:
        existing = jobs[job_id].get("inference_settings")
        if "inference_settings" in values:
            values["inference_settings"] = validate_settings(values["inference_settings"])
            if existing is not None and values["inference_settings"] != existing:
                raise ValueError("Inference settings cannot change after submission")
        jobs[job_id].update(values)


@contextmanager
def use_float32_geometry(pipeline):
    original_loop = pipeline.loop_video

    def aligned_loop(*args, **kwargs):
        import torch

        # ImageProcessor is recreated per call, before loop_video aligns the faces.
        restorer = pipeline.image_processor.restorer
        restorer.dtype = torch.float32
        restorer.fill_value = restorer.fill_value.to(dtype=torch.float32)
        restorer.mask = restorer.mask.to(dtype=torch.float32)
        return original_loop(*args, **kwargs)

    pipeline.loop_video = aligned_loop
    try:
        yield
    finally:
        pipeline.loop_video = original_loop


def load_pipeline():
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    import torch
    from diffusers import AutoencoderKL, DDIMScheduler
    from omegaconf import OmegaConf
    from latentsync.models.unet import UNet3DConditionModel
    from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
    from latentsync.whisper.audio2feature import Audio2Feature
    from DeepCache import DeepCacheSDHelper

    if not CHECKPOINT.exists():
        raise RuntimeError(f"Missing checkpoint: {CHECKPOINT}")
    config = OmegaConf.load(CONFIG)
    dtype = torch.float16 if torch.cuda.is_available() and torch.cuda.get_device_capability()[0] > 7 else torch.float32
    scheduler = DDIMScheduler.from_pretrained(str(ROOT / "configs"))
    audio_encoder = Audio2Feature(
        model_path=str(ROOT / "checkpoints/whisper/tiny.pt"), device="cuda",
        num_frames=config.data.num_frames, audio_feat_length=config.data.audio_feat_length,
    )
    vae = AutoencoderKL.from_pretrained(str(VAE_PATH), torch_dtype=dtype)
    vae.config.scaling_factor = 0.18215
    vae.config.shift_factor = 0
    unet, _ = UNet3DConditionModel.from_pretrained(
        OmegaConf.to_container(config.model), str(CHECKPOINT), device="cpu"
    )
    pipeline = LipsyncPipeline(
        vae=vae, audio_encoder=audio_encoder, unet=unet.to(dtype=dtype), scheduler=scheduler
    ).to("cuda")
    helper = DeepCacheSDHelper(pipe=pipeline)
    helper.set_params(cache_interval=3, cache_branch_id=0)
    helper.reset_states()
    pipeline_state.update(pipeline=pipeline, config=config, helper=helper, deepcache_enabled=False)


def reset_cache():
    helper = pipeline_state["helper"]
    if helper is None:
        return
    if pipeline_state["deepcache_enabled"]:
        helper.disable()
        pipeline_state["deepcache_enabled"] = False
    else:
        helper.reset_states()


def run_job(job_id, video_path, audio_path, output_path):
    import torch
    from accelerate.utils import set_seed

    try:
        with jobs_lock:
            settings = validate_settings(jobs[job_id]["inference_settings"])
        set_job(job_id, status="running", geometry_dtype="float32")
        reset_cache()
        if settings["enable_deepcache"]:
            pipeline_state["helper"].enable()
            pipeline_state["deepcache_enabled"] = True
        set_seed(settings["seed"])
        pipeline, config = pipeline_state["pipeline"], pipeline_state["config"]
        with use_float32_geometry(pipeline):
            pipeline(
                video_path=str(video_path), audio_path=str(audio_path), video_out_path=str(output_path),
                num_frames=config.data.num_frames, num_inference_steps=settings["inference_steps"],
                guidance_scale=settings["guidance_scale"],
                weight_dtype=next(pipeline.unet.parameters()).dtype, width=config.data.resolution,
                height=config.data.resolution, mask_image_path=config.data.mask_image_path,
                temp_dir=str(video_path.parent / "temp"),
            )
        set_job(job_id, status="completed", result=str(output_path))
    except Exception as exc:
        set_job(job_id, status="failed", error=f"{type(exc).__name__}: {exc}")
    finally:
        reset_cache()
        torch.cuda.empty_cache()


async def worker():
    while True:
        job_id, video_path, audio_path, output_path = await queue.get()
        try:
            await asyncio.to_thread(run_job, job_id, video_path, audio_path, output_path)
        finally:
            queue.task_done()


@app.on_event("startup")
async def startup():
    JOB_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(load_pipeline)
    except Exception as exc:
        pipeline_state["error"] = f"{type(exc).__name__}: {exc}"
    asyncio.create_task(worker())


@app.get("/health")
async def health():
    return {
        "ok": pipeline_state["pipeline"] is not None, "error": pipeline_state["error"],
        "queued": queue.qsize(), "model": "LatentSync-1.6", "resolution": 512,
        "geometry_dtype": "float32",
        "default_inference_settings": dict(DEFAULT_SETTINGS),
    }


@app.post("/v1/lipsync")
async def create_job(
    video: UploadFile = File(...), audio: UploadFile = File(...),
    inference_steps: int = Form(40, ge=20, le=50),
    guidance_scale: float = Form(1.5, ge=1, le=3),
    enable_deepcache: bool = Form(False), seed: int = Form(1247, ge=0, le=4294967295),
):
    if pipeline_state["pipeline"] is None:
        raise HTTPException(503, detail=pipeline_state["error"] or "model is still loading")
    try:
        settings = validate_settings({
            "inference_steps": inference_steps, "guidance_scale": guidance_scale,
            "enable_deepcache": enable_deepcache, "seed": seed,
        })
    except ValueError as exc:
        raise HTTPException(422, detail=str(exc)) from exc
    job_id = uuid.uuid4().hex
    job_dir = JOB_ROOT / job_id
    job_dir.mkdir(parents=True)
    video_path, audio_path, output_path = (job_dir / name for name in ("input-video.mp4", "input-audio.wav", "result.mp4"))
    try:
        for upload, destination in ((video, video_path), (audio, audio_path)):
            size = 0
            with destination.open("wb") as target:
                while chunk := await upload.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, detail="upload is too large")
                    target.write(chunk)
            if not size:
                raise HTTPException(422, detail="video and audio uploads must not be empty")
        with jobs_lock:
            jobs[job_id] = {"id": job_id, "status": "queued", "result": None, "error": None}
        set_job(job_id, inference_settings=settings, input_video=str(video_path),
                input_audio=str(audio_path), output_path=str(output_path))
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        with jobs_lock:
            jobs.pop(job_id, None)
        raise
    await queue.put((job_id, video_path, audio_path, output_path))
    with jobs_lock:
        return dict(jobs[job_id])


@app.get("/v1/jobs/{job_id}")
async def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
        record = dict(job) if job else None
    if record is None:
        raise HTTPException(404, detail="job not found")
    return record


@app.get("/v1/jobs/{job_id}/result")
async def get_result(job_id: str):
    record = await get_job(job_id)
    if record["status"] != "completed":
        raise HTTPException(409, detail=record)
    return FileResponse(record["result"], media_type="video/mp4", filename="latentsync-result.mp4")
