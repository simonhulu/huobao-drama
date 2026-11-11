"""Persistent official MuseTalk 1.5 runtime with direct 360px MP4 delivery."""

import hashlib
import importlib.util
import json
import math
from fractions import Fraction
from numbers import Real
import os
from pathlib import Path
import queue
import re
import select
import subprocess
import sys
import threading
import time
from types import MethodType, SimpleNamespace

from playback import IndexedSequence, plan_indices, validate_playback


MODEL = "musetalk-v15"
SOURCE_REVISION = "0a89dec45a0192b824e3cf4daf96c239440c5ed8"
SOURCE_FILES = {
    "scripts/realtime_inference.py": "d0dee17b902caec8a9ad0e929f048ad3746915b1323d0db998bc801d319eedbb",
    "musetalk/utils/audio_processor.py": "b7b62f3daa99678576138bf581a6394a10d346571a2530a760d1299ffd622b81",
    "musetalk/models/unet.py": "05d5dadfde2e726b61d8387a4876336d4dcacc696636e8dcfec69863ce819256",
    "musetalk/models/vae.py": "6ecde3f4417178d8a9de5ed6045e2a4832efa65189b10b0672cab68efe529d32",
    "musetalk/utils/blending.py": "f1be04977db7e6fa1551dfe66dfbdea1e2f32c8d237edaf5a75a0ca4ddd80b53",
}
PARSING_MODES = ("jaw", "raw", "neck")


def add_quality_arguments(parser):
    parser.add_argument("--fps", type=int, choices=(15, 20, 25), default=25)
    parser.add_argument("--precision", choices=("fp16", "fp32"), default="fp16")
    parser.add_argument("--extra-margin", type=int, default=10)
    parser.add_argument("--parsing-mode", choices=PARSING_MODES, default="jaw")
    parser.add_argument("--left-cheek-width", type=int, default=90)
    parser.add_argument("--right-cheek-width", type=int, default=90)
    parser.add_argument("--audio-lookahead-frames", type=int, choices=range(6), default=0)


def apply_audio_lookahead(conditions, frames):
    if frames == 0 or len(conditions) < 2:
        return conditions
    last = len(conditions) - 1
    return conditions[[min(index + frames, last) for index in range(len(conditions))]]


def validate_avatar(avatar):
    names = ("input_latent_list_cycle", "frame_list_cycle", "coord_list_cycle",
             "mask_list_cycle", "mask_coords_list_cycle")
    lengths = {}
    for name in names:
        try:
            lengths[name] = len(getattr(avatar, name))
        except (AttributeError, TypeError) as error:
            raise RuntimeError(f"Invalid MuseTalk avatar cache: missing cycle {name}") from error
    if not all(lengths.values()) or len(set(lengths.values())) != 1:
        raise RuntimeError(f"Invalid MuseTalk avatar cache: cycle lengths must match and be non-empty: {lengths}")
    for index, (bbox, frame) in enumerate(zip(avatar.coord_list_cycle, avatar.frame_list_cycle)):
        try:
            height, width = frame.shape[:2]
            valid = (len(bbox) == 4 and all(isinstance(value, Real) and math.isfinite(value)
                                           and int(value) == value for value in bbox))
            if valid:
                x1, y1, x2, y2 = bbox
                valid = 0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height
        except (AttributeError, TypeError, ValueError):
            valid = False
        if not valid:
            raise RuntimeError(f"Invalid MuseTalk avatar cache: invalid bbox at frame {index}: {bbox}")


class GenerationCancelled(Exception):
    pass


def file_hash(filename):
    digest = hashlib.sha256()
    with Path(filename).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_source(root):
    root = Path(root)
    if (root / ".git").exists():
        actual_revision = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        if actual_revision != SOURCE_REVISION:
            raise RuntimeError(f"MuseTalk checkout must be pinned to {SOURCE_REVISION}")
        return
    # GitHub source archives have no .git metadata; verify the pinned inference files directly.
    for relative, expected in SOURCE_FILES.items():
        source = root / relative
        if not source.is_file() or file_hash(source) != expected:
            raise RuntimeError(f"MuseTalk source archive does not match {SOURCE_REVISION}: {relative}")


def media_info(filename):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(filename)],
        check=True, capture_output=True, text=True, timeout=60,
    )
    return json.loads(result.stdout)


def validate_reference_fps(reference, fps):
    recovery = f"Resample the original reference to {fps} FPS before preparing the avatar."
    try:
        metadata = media_info(reference)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot inspect the MuseTalk reference video. {recovery}") from error
    streams = metadata.get("streams") if isinstance(metadata, dict) else None
    video = next((stream for stream in streams if isinstance(stream, dict)
                  and stream.get("codec_type") == "video"), None) if isinstance(streams, list) else None
    rate = None
    if video is not None:
        for name in ("avg_frame_rate", "r_frame_rate"):
            try:
                candidate = Fraction(str(video.get(name)))
            except (ValueError, ZeroDivisionError):
                continue
            if candidate > 0:
                rate = candidate
                break
    if rate is None:
        raise RuntimeError(f"MuseTalk reference has no video stream with a valid frame rate. {recovery}")
    if abs(rate - fps) > Fraction(1, 100):
        raise RuntimeError(f"MuseTalk reference frame rate {float(rate):g} FPS does not match {fps} FPS. {recovery}")
    return float(rate)


def reference_frame_count(reference):
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries", "stream=nb_read_frames", "-of", "json", str(reference),
    ], check=True, capture_output=True, text=True, timeout=120)
    try:
        frames = int(json.loads(result.stdout)["streams"][0]["nb_read_frames"])
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise RuntimeError("Cannot count the gesture bank reference frames") from error
    if frames < 1:
        raise RuntimeError("Gesture bank reference has no decoded frames")
    return frames


def check_cancelled(cancel):
    if cancel is not None and cancel.is_set():
        raise GenerationCancelled("Generation cancelled")


def pipe_inference(avatar, upstream, audio, name, fps, codec, cancel=None, *,
                   playback=None, avatar_profile_sha256=None):
    """Keep upstream synthesis/blending; encode only the delivered circle.

    The official inference method starts a consumer thread and normally joins it.
    On cancellation or producer failure, stop both sides before reusing the avatar.
    """
    check_cancelled(cancel)
    frame = avatar.frame_list_cycle[0]
    height, width = frame.shape[:2]
    side = min(width, height)
    crop_x, crop_y = (width - side) // 2, (height - side) // 2
    output = Path(avatar.video_out_path) / f"{name}.mp4"
    log_path = output.with_suffix(".ffmpeg.log")
    original_process = avatar.process_frames
    original_skip = upstream.args.skip_save_images
    original_datagen = upstream.datagen
    if playback is not None:
        playback = validate_playback(playback)
    playback_plan = None
    plan_ready = threading.Event()
    failures = []
    stopped = threading.Event()
    consumer_expected = threading.Event()
    consumer_started = threading.Event()
    consumer_done = threading.Event()
    codec_args = (["-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-threads", "2"]
                  if codec == "libx264" else ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "26"])

    def check_running():
        check_cancelled(cancel)
        if failures:
            raise RuntimeError(f"Frame encoding failed: {failures[0]}")
        if stopped.is_set():
            raise RuntimeError("Frame encoder stopped")

    def checked_datagen(*args, **kwargs):
        nonlocal playback_plan
        consumer_expected.set()
        if playback is not None:
            if len(args) < 2 or (len(args) > 3 and args[3] != 0) or kwargs.get("delay_frame", 0) != 0:
                raise RuntimeError("Gesture playback requires the pinned zero-delay datagen call")
            playback_plan = plan_indices(playback, len(args[0]), file_hash(audio), avatar_profile_sha256)
            args = (args[0], IndexedSequence(args[1], playback_plan), *args[2:])
            # Publish one plan before the first synthesized batch reaches the consumer.
            plan_ready.set()
        for batch in original_datagen(*args, **kwargs):
            check_running()
            yield batch
        check_running()

    with log_path.open("wb") as log:
        encoder = subprocess.Popen([
            "ffmpeg", "-nostdin", "-v", "error", "-n", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", "360x360", "-r", str(fps), "-i", "pipe:0", "-i", str(audio),
            "-map", "0:v:0", "-map", "1:a:0",
            *codec_args, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
            "-shortest", "-movflags", "+faststart", str(output),
        ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
        os.set_blocking(encoder.stdin.fileno(), False)

        def write_frame(data):
            pending = memoryview(data)
            deadline = time.monotonic() + 120
            while pending:
                check_running()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("FFmpeg stopped consuming frames for 120 seconds")
                if not select.select([], [encoder.stdin], [], min(remaining, 0.5))[1]:
                    continue
                try:
                    written = os.write(encoder.stdin.fileno(), pending)
                    pending = pending[written:]
                    deadline = time.monotonic() + 120
                except BlockingIOError:
                    continue

        def process_frames(self, frames, video_len, skip_save_images):
            consumer_started.set()
            try:
                if playback is not None:
                    deadline = time.monotonic() + 120
                    while not plan_ready.wait(0.25):
                        check_running()
                        if time.monotonic() >= deadline:
                            raise TimeoutError("No gesture playback plan for 120 seconds")
                    if len(playback_plan) != video_len:
                        raise RuntimeError("Gesture playback plan does not match the synthesis frame count")
                for index in range(video_len):
                    deadline = time.monotonic() + 120
                    while True:
                        check_running()
                        try:
                            result = frames.get(timeout=0.25)
                            break
                        except queue.Empty:
                            if time.monotonic() >= deadline:
                                raise TimeoutError("No generated frame for 120 seconds")
                    cycle_index = playback_plan[index] if playback is not None else index % len(self.coord_list_cycle)
                    bbox = self.coord_list_cycle[cycle_index]
                    x1, y1, x2, y2 = bbox
                    face = upstream.cv2.resize(result, (x2 - x1, y2 - y1))
                    combined = upstream.get_image_blending(
                        self.frame_list_cycle[cycle_index], face, bbox,
                        self.mask_list_cycle[cycle_index], self.mask_coords_list_cycle[cycle_index],
                    )
                    # Crop before transfer: source-size frames caused the old encoder bottleneck.
                    cropped = combined[crop_y:crop_y + side, crop_x:crop_x + side]
                    delivered = upstream.cv2.resize(cropped, (360, 360))
                    write_frame(delivered.tobytes())
                    self.idx = index + 1
            except BaseException as error:
                failures.append(error)
            finally:
                consumer_done.set()

        avatar.process_frames = MethodType(process_frames, avatar)
        upstream.args.skip_save_images = True
        upstream.datagen = checked_datagen
        try:
            avatar.inference(str(audio), name, fps, True)
            check_running()
            encoder.stdin.close()
            deadline = time.monotonic() + 120
            while encoder.poll() is None:
                check_cancelled(cancel)
                if time.monotonic() >= deadline:
                    raise TimeoutError("FFmpeg did not finish within 120 seconds")
                try:
                    encoder.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            if encoder.returncode:
                raise RuntimeError(f"Video encoding failed; see {log_path}")
        finally:
            stopped.set()
            if encoder.poll() is None:
                encoder.kill()
            encoder.wait()
            if not encoder.stdin.closed:
                encoder.stdin.close()
            consumer_stuck = (consumer_started.is_set() or consumer_expected.is_set()) and not consumer_done.wait(timeout=5)
            avatar.process_frames = original_process
            upstream.args.skip_save_images = original_skip
            upstream.datagen = original_datagen
            if consumer_stuck:
                raise RuntimeError("Frame consumer did not stop; restart this worker before another job")


class MuseTalkRuntime:
    """One shared model and one resident avatar, used serially by the HTTP worker."""

    def __init__(self, root, reference, fps=25, batch_size=20, codec="libx264", preprocessing_module=None,
                 *, precision="fp16", extra_margin=10, parsing_mode="jaw", left_cheek_width=90,
                 right_cheek_width=90, audio_lookahead_frames=0, avatar_registry=None):
        self.root = Path(root).resolve()
        self.reference = Path(reference).resolve()
        self.preprocessing_module = Path(preprocessing_module or
                                         Path(__file__).resolve().parent / "vendor/preprocessing_onnx.py").resolve()
        if type(fps) is not int or fps not in (15, 20, 25) or type(batch_size) is not int or not 1 <= batch_size <= 64:
            raise ValueError("FPS must be 15/20/25 and batch size must be 1-64")
        if codec not in ("libx264", "h264_nvenc"):
            raise ValueError("Unsupported encoder")
        if precision not in ("fp16", "fp32"):
            raise ValueError("Precision must be fp16 or fp32")
        if parsing_mode not in PARSING_MODES:
            raise ValueError(f"Parsing mode must be one of {PARSING_MODES}")
        if type(extra_margin) is not int or not 0 <= extra_margin <= 64:
            raise ValueError("Extra margin must be an integer between 0 and 64")
        for name, value in (("Left cheek width", left_cheek_width), ("Right cheek width", right_cheek_width)):
            if type(value) is not int or not 0 <= value <= 128:
                raise ValueError(f"{name} must be an integer between 0 and 128")
        if type(audio_lookahead_frames) is not int or not 0 <= audio_lookahead_frames <= 5:
            raise ValueError("Audio lookahead frames must be an integer between 0 and 5")
        self.fps, self.batch_size, self.codec = fps, batch_size, codec
        self.precision = precision
        self.extra_margin, self.parsing_mode = extra_margin, parsing_mode
        self.left_cheek_width, self.right_cheek_width = left_cheek_width, right_cheek_width
        self.audio_lookahead_frames = audio_lookahead_frames
        reference_hash = file_hash(self.reference)
        self.quality_config = {
            "version": 1, "model": MODEL, "source_revision": SOURCE_REVISION,
            "reference_sha256": reference_hash, "preprocessing_sha256": file_hash(self.preprocessing_module),
            "fps": fps, "precision": precision, "extra_margin": extra_margin,
            "parsing_mode": parsing_mode, "left_cheek_width": left_cheek_width,
            "right_cheek_width": right_cheek_width, "codec": codec,
            "audio_lookahead_frames": audio_lookahead_frames,
        }
        profile_hash = hashlib.sha256(json.dumps(self.quality_config, sort_keys=True,
                                                separators=(",", ":")).encode("ascii")).hexdigest()
        self.identity = {
            "model": MODEL, "source_revision": SOURCE_REVISION,
            "avatar_id": f"xiaolu-r4-{profile_hash[:24]}",
            "reference_sha256": reference_hash, "fps": fps,
        }
        self.avatar_profiles = {self.identity["avatar_id"]: {
            "identity": self.identity, "reference": self.reference,
            "quality_config": self.quality_config, "cache_id": self.identity["avatar_id"],
        }}
        if avatar_registry is not None:
            registry_path = Path(avatar_registry).resolve()
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
            if not isinstance(registry, dict) or set(registry) != {"avatars"} or not isinstance(registry["avatars"], dict):
                raise ValueError("Avatar registry must contain an avatars object")
            for avatar_id, entry in registry["avatars"].items():
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", avatar_id) or avatar_id in self.avatar_profiles:
                    raise ValueError("Invalid or duplicate registered avatar ID")
                if not isinstance(entry, dict) or set(entry) not in (
                        {"reference", "reference_sha256"}, {"reference", "reference_sha256", "playback"}):
                    raise ValueError("Each registered avatar requires reference and reference_sha256")
                if not isinstance(entry["reference"], str) or not entry["reference"].strip():
                    raise ValueError("Registered avatar reference must be a nonempty path")
                reference = (registry_path.parent / entry["reference"]).resolve()
                expected = entry["reference_sha256"]
                if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                    raise ValueError("Registered avatar reference_sha256 must be a SHA-256 hash")
                if not reference.is_file() or file_hash(reference) != expected:
                    raise ValueError(f"Registered avatar reference checksum does not match: {avatar_id}")
                quality = {**self.quality_config, "reference_sha256": expected}
                playback = validate_playback(entry["playback"]) if "playback" in entry else None
                if playback is not None:
                    quality["playback"] = playback
                profile = hashlib.sha256(json.dumps(quality, sort_keys=True, separators=(",", ":")).encode("ascii")).hexdigest()
                self.avatar_profiles[avatar_id] = {
                    "identity": {**self.identity, "avatar_id": avatar_id, "reference_sha256": expected,
                                 "avatar_profile_sha256": profile},
                    "reference": reference, "quality_config": quality, "cache_id": f"{avatar_id}-{profile[:24]}",
                    **({"playback": playback} if playback is not None else {}),
                }
        self.torch = self.upstream = self.avatar = None
        self.active_avatar_id = None
        self.load_metrics = {}

    def identity_for(self, avatar_id=None):
        avatar_id = self.identity["avatar_id"] if avatar_id is None else avatar_id
        if avatar_id not in self.avatar_profiles:
            raise KeyError("Unknown registered avatar")
        profile = self.avatar_profiles[avatar_id]
        if avatar_id != self.identity["avatar_id"] and file_hash(profile["reference"]) != profile["identity"]["reference_sha256"]:
            raise ValueError("Registered avatar reference checksum changed")
        return dict(profile["identity"])

    def quality_for(self, avatar_id=None):
        selected = self.identity_for(avatar_id)
        return dict(self.avatar_profiles[selected["avatar_id"]]["quality_config"])

    def load(self):
        if self.upstream is not None:
            self._load_avatar()
            return
        started = time.perf_counter()
        self.load_metrics["reference_fps"] = validate_reference_fps(self.reference, self.fps)
        validate_source(self.root)
        os.chdir(self.root)
        os.environ.setdefault("TORCH_HOME", str(self.root / "models/.torch"))
        sys.path.insert(0, str(self.root))
        sys.path.insert(0, str(self.root / "musetalk/utils"))
        import torch
        import onnxruntime as ort
        from transformers import WhisperModel

        spec = importlib.util.spec_from_file_location("musetalk.utils.preprocessing", self.preprocessing_module)
        preprocessing = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = preprocessing
        spec.loader.exec_module(preprocessing)
        session_options = ort.SessionOptions()
        session_options.intra_op_num_threads = 4
        session_options.inter_op_num_threads = 1
        preprocessing._dwpose_session = ort.InferenceSession(
            str(self.root / "models/dwpose/dw-ll_ucoco_384.onnx"),
            sess_options=session_options, providers=["CPUExecutionProvider"],
        )
        from scripts import realtime_inference as upstream

        if not torch.cuda.is_available():
            raise RuntimeError("MuseTalk requires the production CUDA GPU")
        torch.set_num_threads(4)
        torch.backends.cudnn.benchmark = True
        torch.backends.cuda.matmul.allow_tf32 = self.precision != "fp32"
        torch.backends.cudnn.allow_tf32 = self.precision != "fp32"
        torch.manual_seed(1247)
        upstream.args = SimpleNamespace(
            version="v15", extra_margin=self.extra_margin, parsing_mode=self.parsing_mode,
            audio_padding_length_left=2, audio_padding_length_right=2, skip_save_images=False,
        )
        upstream.device = torch.device("cuda:0")
        upstream.vae, upstream.unet, upstream.pe = upstream.load_all_model(
            unet_model_path="models/musetalkV15/unet.pth",
            unet_config="models/musetalkV15/musetalk.json", device=upstream.device,
        )
        weight_dtype = torch.float16 if self.precision == "fp16" else torch.float32
        upstream.pe = upstream.pe.to(device=upstream.device, dtype=weight_dtype).eval()
        upstream.vae.vae = upstream.vae.vae.to(device=upstream.device, dtype=weight_dtype).eval()
        upstream.unet.model = upstream.unet.model.to(device=upstream.device, dtype=weight_dtype).eval()
        upstream.timesteps = torch.tensor([0], device=upstream.device)
        upstream.weight_dtype = upstream.unet.model.dtype
        lookahead_frames = self.audio_lookahead_frames

        class RuntimeAudioProcessor(upstream.AudioProcessor):
            def get_whisper_chunk(self, *args, **kwargs):
                conditions = super().get_whisper_chunk(*args, **kwargs)
                return apply_audio_lookahead(conditions, lookahead_frames)

        upstream.audio_processor = RuntimeAudioProcessor(feature_extractor_path="models/whisper")
        upstream.whisper = WhisperModel.from_pretrained("models/whisper").to(
            device=upstream.device, dtype=upstream.weight_dtype,
        ).eval()
        upstream.whisper.requires_grad_(False)
        # Only this verified legacy TAR is loaded with the current Torch compatibility opt-out.
        resnet = self.root / "models/face-parse-bisent/resnet18-5c106cde.pth"
        if file_hash(resnet) != "5c106cde386e87d4033832f2996f5493238eda96ccf559d1d62760c4de0613f8":
            raise RuntimeError("The legacy ResNet checkpoint checksum does not match")
        resnet_compatible = resnet.with_name("resnet18-state-dict.pth")
        if not resnet_compatible.exists():
            torch.save(torch.load(resnet, map_location="cpu", weights_only=False), resnet_compatible)

        class RuntimeFaceParsing(upstream.FaceParsing):
            def model_init(self, resnet_path=str(resnet_compatible),
                           model_pth="./models/face-parse-bisent/79999_iter.pth"):
                return super().model_init(resnet_path, model_pth)

        upstream.fp = RuntimeFaceParsing(left_cheek_width=self.left_cheek_width,
                                        right_cheek_width=self.right_cheek_width)
        torch.cuda.synchronize()
        self.load_metrics.update(model_load_seconds=time.perf_counter() - started,
                                 gpu=torch.cuda.get_device_name(0), torch_version=torch.__version__)
        self.torch, self.upstream = torch, upstream
        self._load_avatar()

    def _load_avatar(self, avatar_id=None):
        selected = self.identity_for(avatar_id)
        if self.avatar is not None and self.active_avatar_id == selected["avatar_id"]:
            return
        profile = self.avatar_profiles[selected["avatar_id"]]
        validate_reference_fps(profile["reference"], self.fps)
        forward_frames = None
        if "playback" in profile:
            forward_frames = reference_frame_count(profile["reference"])
            if forward_frames != profile["playback"]["segments"][-1]["end_frame"]:
                raise RuntimeError("Gesture playback segments do not cover the decoded reference frames")
        cached = self.root / "results/v15/avatars" / profile["cache_id"]
        preparing = not (cached / "latents.pt").is_file()
        if preparing and cached.exists():
            raise RuntimeError(f"Incomplete avatar preparation needs recovery: {cached}")
        if self.avatar is not None:
            self.avatar = None
            self.active_avatar_id = None
            self.torch.cuda.empty_cache()
        before = time.perf_counter()
        avatar = self.upstream.Avatar(profile["cache_id"], str(profile["reference"]), 0, self.batch_size, preparing)
        try:
            validate_avatar(avatar)
            if forward_frames is not None and len(avatar.frame_list_cycle) != forward_frames * 2:
                raise RuntimeError("Gesture bank cache must contain the pinned forward-and-reverse frame cycle")
        except RuntimeError as error:
            raise RuntimeError(f"{error}; rebuild the avatar cache at {cached}") from error
        self.torch.cuda.synchronize()
        self.load_metrics.update(avatar_prepared=preparing,
                                 avatar_load_or_prepare_seconds=time.perf_counter() - before,
                                 quality_config=profile["quality_config"])
        self.avatar, self.active_avatar_id = avatar, selected["avatar_id"]

    def generate(self, audio, output, cancel, *, avatar_id=None):
        if self.upstream is None:
            raise RuntimeError("Runtime has not loaded")
        check_cancelled(cancel)
        self._load_avatar(avatar_id)
        output = Path(output).resolve()
        if output.exists():
            raise FileExistsError(output)
        original_directory = self.avatar.video_out_path
        self.avatar.video_out_path = str(output.parent)
        started = time.perf_counter()
        try:
            with self.torch.inference_mode():
                profile = self.avatar_profiles[self.active_avatar_id]
                playback_options = ({"playback": profile["playback"],
                                     "avatar_profile_sha256": profile["identity"]["avatar_profile_sha256"]}
                                    if "playback" in profile else {})
                pipe_inference(self.avatar, self.upstream, audio, output.stem, self.fps, self.codec, cancel,
                               **playback_options)
            self.torch.cuda.synchronize()
            check_cancelled(cancel)
            source_duration = float(media_info(audio)["format"]["duration"])
            result = media_info(output)
            video = next(item for item in result["streams"] if item.get("codec_type") == "video")
            if not any(item.get("codec_type") == "audio" for item in result["streams"]):
                raise RuntimeError("Delivered MP4 has no audio")
            duration = float(video.get("duration") or result["format"]["duration"])
            if abs(source_duration - duration) > 0.15:
                raise RuntimeError("Output does not cover the complete narration")
            if video.get("width") != 360 or video.get("height") != 360:
                raise RuntimeError("Unexpected presenter dimensions")
            return {"audio_duration_seconds": source_duration, "video_duration_seconds": duration,
                    "width": 360, "height": 360, "elapsed_seconds": time.perf_counter() - started}
        finally:
            self.avatar.video_out_path = original_directory
