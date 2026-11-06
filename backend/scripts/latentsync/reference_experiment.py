"""Isolated short-clip experiment for the official LatentSync reference branch.

Run inside the existing GPU venv, with api_server.py and verified_api.py beside
this file. This does not start HTTP or resume production jobs. Offset 0 keeps
the official reference input; other offsets change only prepare_image_latents.
"""

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path


class ReferenceOffset:
    def __init__(self, pipeline, offset, geometry_dtype="float16"):
        if geometry_dtype not in ("float16", "float32"):
            raise ValueError("Unsupported geometry dtype")
        self.pipeline = pipeline
        self.offset = offset
        self.geometry_dtype = geometry_dtype
        self.restorer_state = None
        self.faces = None
        self.cursor = 0
        self.record = {"requested_offset_frames": offset, "geometry_dtype": geometry_dtype, "windows": []}

    def __enter__(self):
        self.original_loop = self.pipeline.loop_video
        self.original_prepare = self.pipeline.prepare_image_latents

        def capture_loop(*args, **kwargs):
            if self.faces is not None:
                raise RuntimeError("This experiment supports one pipeline invocation")
            if self.geometry_dtype == "float32":
                import torch

                restorer = self.pipeline.image_processor.restorer
                self.restorer_state = (restorer, restorer.dtype, restorer.fill_value, restorer.mask)
                restorer.dtype = torch.float32
                restorer.fill_value = restorer.fill_value.to(dtype=torch.float32)
                restorer.mask = restorer.mask.to(dtype=torch.float32)
            result = self.original_loop(*args, **kwargs)
            self.faces = result[1]
            count = len(self.faces)
            if not count:
                raise RuntimeError("The official pipeline returned no aligned faces")
            self.record.update(
                aligned_frame_count=count,
                effective_offset_frames=self.offset % count,
            )
            return result

        def prepare_reference(images, *args, **kwargs):
            if self.faces is None:
                raise RuntimeError("Reference requested before aligned faces were captured")
            count = images.shape[0]
            end = self.cursor + count
            if count <= 0 or end > len(self.faces):
                raise RuntimeError("Reference window exceeds the captured target sequence")
            indices = [(index + self.offset) % len(self.faces) for index in range(self.cursor, end)]
            self.record["windows"].append({
                "target_start_frame": self.cursor,
                "frame_count": count,
                "reference_indices": indices,
            })
            self.cursor = end
            if self.offset % len(self.faces):
                images = self.pipeline.image_processor.process_images(self.faces[indices])
            return self.original_prepare(images, *args, **kwargs)

        self.pipeline.loop_video = capture_loop
        self.pipeline.prepare_image_latents = prepare_reference
        return self

    def verify_complete(self):
        if self.faces is None or self.cursor != len(self.faces):
            raise RuntimeError("Reference windows did not cover the complete target sequence")

    def __exit__(self, *args):
        self.pipeline.loop_video = self.original_loop
        self.pipeline.prepare_image_latents = self.original_prepare
        if self.restorer_state is not None:
            restorer, dtype, fill_value, mask = self.restorer_state
            restorer.dtype, restorer.fill_value, restorer.mask = dtype, fill_value, mask


class StageCapture:
    """Observe selected frames without changing tensors or consuming random numbers."""

    def __init__(self, pipeline, directory, indices=(0, 25, 50, 75, 100)):
        self.pipeline = pipeline
        self.directory = Path(directory)
        self.indices = sorted(set(indices))
        self.cursor = 0
        self.record = {"directory": str(self.directory), "selected_frames": self.indices, "files": []}

    def save_rgb(self, stage, index, pixels):
        import cv2

        filename = self.directory / f"{stage}-{index:04d}.png"
        if not cv2.imwrite(str(filename), cv2.cvtColor(pixels, cv2.COLOR_RGB2BGR)):
            raise RuntimeError(f"Cannot write diagnosis frame: {filename}")
        self.record["files"].append({"stage": stage, "frame": index, "filename": filename.name})

    def save_tensor(self, stage, index, pixels):
        import torch

        rgb = ((pixels.detach().float().clamp(-1, 1) + 1) * 127.5).round().to(torch.uint8)
        self.save_rgb(stage, index, rgb.permute(1, 2, 0).cpu().numpy())

    def __enter__(self):
        self.directory.mkdir(parents=True, exist_ok=False)
        self.originals = {name: getattr(self.pipeline, name) for name in (
            "decode_latents", "paste_surrounding_pixels_back", "restore_video",
        )}

        def decode(*args, **kwargs):
            result = self.originals["decode_latents"](*args, **kwargs)
            for index in self.indices:
                if self.cursor <= index < self.cursor + len(result):
                    self.save_tensor("decoded", index, result[index - self.cursor])
            return result

        def paste(decoded, source, *args, **kwargs):
            result = self.originals["paste_surrounding_pixels_back"](decoded, source, *args, **kwargs)
            for index in self.indices:
                if self.cursor <= index < self.cursor + len(result):
                    self.save_tensor("aligned-source", index, source[index - self.cursor])
                    self.save_tensor("pasted", index, result[index - self.cursor])
            self.cursor += len(result)
            return result

        def restore(faces, source, *args, **kwargs):
            result = self.originals["restore_video"](faces, source, *args, **kwargs)
            for index in self.indices:
                if index < len(result):
                    self.save_rgb("source", index, source[index])
                    self.save_rgb("restored", index, result[index])
            return result

        self.pipeline.decode_latents = decode
        self.pipeline.paste_surrounding_pixels_back = paste
        self.pipeline.restore_video = restore
        return self

    def __exit__(self, *args):
        for name, original in self.originals.items():
            setattr(self.pipeline, name, original)


def sha256_file(filename):
    sha = hashlib.sha256()
    with Path(filename).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def git_revision(root):
    result = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        capture_output=True, text=True, timeout=30,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--guidance", type=float, default=1.5)
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--ref-offset", type=int, default=16)
    parser.add_argument("--geometry-dtype", choices=("float16", "float32"), default="float16")
    parser.add_argument("--capture-stages", action="store_true", help="Save selected source, decoded and restored frames")
    parser.add_argument("--seed", type=int, default=1247)
    args = parser.parse_args(argv)
    if not math.isfinite(args.guidance) or not 1 <= args.guidance <= 3:
        parser.error("--guidance must be finite and between 1 and 3")
    if not 20 <= args.steps <= 50:
        parser.error("--steps must be between 20 and 50")
    if not 0 <= args.seed <= 4294967295:
        parser.error("--seed must be between 0 and 4294967295")
    for name in ("video", "audio", "output"):
        setattr(args, name, getattr(args, name).expanduser().resolve())
    if not args.video.is_file() or not args.audio.is_file():
        parser.error("--video and --audio must be existing files")
    if args.output.suffix.lower() != ".mp4":
        parser.error("--output must end with .mp4")
    return args


def run(args):
    output = args.output
    metadata_path = output.with_suffix(".mp4.json")
    if output.exists() or metadata_path.exists():
        raise FileExistsError("Output or experiment metadata already exists; choose another output path")
    if args.capture_stages and output.with_suffix(".stages").exists():
        raise FileExistsError("Stage capture directory already exists; choose another output path")
    output.parent.mkdir(parents=True, exist_ok=True)

    import api_server as api
    import verified_api as verified

    audio_info = verified.media_info(args.audio)
    duration = float(audio_info["format"]["duration"])
    if not math.isfinite(duration) or not 0 < duration <= 30:
        raise ValueError("Reference experiments require an audio clip longer than 0 and at most 30 seconds")
    settings = api.validate_settings({
        "inference_steps": args.steps,
        "guidance_scale": args.guidance,
        "enable_deepcache": False,
        "seed": args.seed,
    })
    metadata = {
        "status": "preparing",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "video": str(args.video),
        "audio": str(args.audio),
        "output": str(output),
        "audio_duration_seconds": duration,
        "inference_settings": settings,
        "requested_reference_offset_frames": args.ref_offset,
        "geometry_dtype": args.geometry_dtype,
        "source_revision": git_revision(api.ROOT),
        "sha256": {
            "video": sha256_file(args.video),
            "audio": sha256_file(args.audio),
            "runner": sha256_file(__file__),
            "api_server": sha256_file(Path(__file__).with_name("api_server.py")),
            "verified_api": sha256_file(Path(__file__).with_name("verified_api.py")),
            "config": sha256_file(api.CONFIG),
            "pipeline": sha256_file(api.ROOT / "latentsync/pipelines/lipsync_pipeline.py"),
            "image_processor": sha256_file(api.ROOT / "latentsync/utils/image_processor.py"),
            "affine_transform": sha256_file(api.ROOT / "latentsync/utils/affine_transform.py"),
            "face_detector": sha256_file(api.ROOT / "latentsync/utils/face_detector.py"),
        },
        "target_and_paste": "current_frame_unchanged",
    }
    with metadata_path.open("x", encoding="utf-8") as target:
        json.dump(metadata, target, indent=2)
        target.write("\n")

    started = time.monotonic()
    work = Path(tempfile.mkdtemp(prefix=f".{output.stem}-", dir=output.parent))
    reference = None
    capture = None
    try:
        weights_started = time.monotonic()
        metadata["sha256"].update({
            "vae": verified.verify_vae(api.VAE_PATH / "diffusion_pytorch_model.safetensors"),
            "unet": verified.verify_weights(api.CHECKPOINT, verified.UNET_SIZE, verified.UNET_SHA256, "UNet"),
            "whisper": verified.verify_weights(
                api.ROOT / "checkpoints/whisper/tiny.pt", verified.WHISPER_SIZE, verified.WHISPER_SHA256, "Whisper"
            ),
        })
        metadata["weights_validation_seconds"] = round(time.monotonic() - weights_started, 3)

        # Skip verified_api.load_pipeline's production-job restoration in this standalone process.
        load_started = time.monotonic()
        verified._load_pipeline()
        api.reset_cache()
        metadata["model_loading_seconds"] = round(time.monotonic() - load_started, 3)

        from accelerate.utils import set_seed

        set_seed(args.seed)
        pipeline, config = api.pipeline_state["pipeline"], api.pipeline_state["config"]
        metadata["pipeline_config"] = {
            "num_frames": config.data.num_frames,
            "resolution": config.data.resolution,
            "video_fps": config.data.video_fps,
            "audio_sample_rate": config.data.audio_sample_rate,
            "weight_dtype": str(next(pipeline.unet.parameters()).dtype),
        }
        metadata["sha256"]["mask"] = sha256_file(api.ROOT / config.data.mask_image_path)
        candidate = work / "result.mp4"
        inference_started = time.monotonic()
        with ExitStack() as stack:
            reference = stack.enter_context(ReferenceOffset(pipeline, args.ref_offset, args.geometry_dtype))
            if args.capture_stages:
                capture = stack.enter_context(StageCapture(pipeline, output.with_suffix(".stages")))
            pipeline(
                video_path=str(args.video), audio_path=str(args.audio), video_out_path=str(candidate),
                num_frames=config.data.num_frames, video_fps=config.data.video_fps,
                audio_sample_rate=config.data.audio_sample_rate,
                num_inference_steps=args.steps, guidance_scale=args.guidance,
                weight_dtype=next(pipeline.unet.parameters()).dtype,
                width=config.data.resolution, height=config.data.resolution,
                mask_image_path=config.data.mask_image_path, temp_dir=str(work / "temp"),
            )
            reference.verify_complete()
        metadata["inference_seconds"] = round(time.monotonic() - inference_started, 3)
        verified.validate_output(candidate, args.audio)
        metadata["output_media"] = verified.media_info(candidate)
        metadata["sha256"]["output"] = sha256_file(candidate)
        # Both paths are on the same filesystem; link atomically refuses an existing output.
        os.link(candidate, output)
        metadata["status"] = "completed"
    except BaseException as error:
        metadata.update(status="failed", error=f"{type(error).__name__}: {error}")
        raise
    finally:
        if reference is not None:
            metadata["reference"] = reference.record
        if capture is not None:
            metadata["stage_capture"] = capture.record
        metadata["elapsed_seconds"] = round(time.monotonic() - started, 3)
        metadata["finished_at"] = datetime.now(timezone.utc).isoformat()
        temporary_metadata = work / "metadata.json"
        temporary_metadata.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        temporary_metadata.replace(metadata_path)
        api.reset_cache()
        shutil.rmtree(work)
    return metadata_path


if __name__ == "__main__":
    print(run(parse_args()))
