"""Create an aligned arena bed using the official Torchaudio HDemucs model."""

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

try:
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
except (ImportError, OSError) as error:
    raise SystemExit(
        "HDemucs environment unavailable: configure NBA_AUDIO_PYTHON with compatible "
        "torch/torchaudio (for example both 2.6.0), numpy and soundfile. " + str(error)
    )

WEIGHTS_URL = "https://download.pytorch.org/torchaudio/models/hdemucs_high_trained.pt"
WEIGHTS_SHA256 = "a004b2790d73ffeaa535db458a1a79b539dfdbafbccc31f275d07e632ebd7816"
WEIGHTS_SIZE = 334697255


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def weights(cache):
    target = cache / "torchaudio/models/hdemucs_high_trained.pt"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size == WEIGHTS_SIZE and sha256(target) == WEIGHTS_SHA256:
        return target
    configured = os.environ.get("NBA_DEMUCS_WEIGHTS")
    if configured:
        existing = Path(configured)
        if existing.is_file() and sha256(existing) == WEIGHTS_SHA256:
            shutil.copyfile(existing, target)
            return target
        raise RuntimeError("NBA_DEMUCS_WEIGHTS does not match the official model SHA-256")
    parts = cache / "download-parts"
    parts.mkdir(parents=True, exist_ok=True)

    def download(index):
        width = math.ceil(WEIGHTS_SIZE / 16)
        start, end = index * width, min(WEIGHTS_SIZE - 1, (index + 1) * width - 1)
        filename = parts / f"hdemucs-{index:02d}.part"
        if filename.exists() and filename.stat().st_size == end - start + 1:
            return filename
        for attempt in range(4):
            try:
                request = urllib.request.Request(WEIGHTS_URL, headers={"Range": f"bytes={start}-{end}"})
                with urllib.request.urlopen(request, timeout=45) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{WEIGHTS_SIZE}":
                        raise RuntimeError("Official model server did not return the requested byte range")
                    with filename.open("wb") as handle:
                        while block := response.read(1024 * 1024):
                            handle.write(block)
                if filename.stat().st_size != end - start + 1:
                    raise RuntimeError("Incomplete model byte range")
                print(f"HDemucs model part {index + 1}/16 ready", flush=True)
                return filename
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(attempt + 1)

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        downloaded = list(pool.map(download, range(16)))
    descriptor, temporary = tempfile.mkstemp(dir=target.parent, suffix=".pt")
    with os.fdopen(descriptor, "wb") as output:
        for filename in downloaded:
            with filename.open("rb") as source:
                shutil.copyfileobj(source, output, 1024 * 1024)
    temporary = Path(temporary)
    if temporary.stat().st_size != WEIGHTS_SIZE or sha256(temporary) != WEIGHTS_SHA256:
        temporary.unlink()
        raise RuntimeError("Official HDemucs model fingerprint validation failed")
    temporary.replace(target)
    for filename in downloaded:
        filename.unlink()
    return target


def levels(audio):
    def db(value):
        return 20 * math.log10(max(float(value), 1e-12))

    stereo = np.asarray(audio, dtype=np.float64)
    mid = stereo.mean(axis=1)
    side = (stereo[:, 0] - stereo[:, 1]) / 2
    return {
        "rms_dbfs": db(np.sqrt(np.mean(stereo ** 2))),
        "peak_dbfs": db(np.max(np.abs(stereo))),
        "mid_rms_dbfs": db(np.sqrt(np.mean(mid ** 2))),
        "side_rms_dbfs": db(np.sqrt(np.mean(side ** 2))),
        "nonfinite_samples": int(np.count_nonzero(~np.isfinite(stereo))),
        "over_full_scale_samples": int(np.count_nonzero(np.abs(stereo) >= 1)),
    }


def atomic_json(filename, value):
    descriptor, temporary = tempfile.mkstemp(dir=filename.parent, suffix=".pending")
    temporary = Path(temporary)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(filename)
    finally:
        temporary.unlink(missing_ok=True)


def separate_windows(waveform, model, rate, checkpoint_dir, source_hash, weights_hash, progress=print):
    total = waveform.shape[-1]
    reference = waveform.mean(dim=0)
    mean, scale = reference.mean(), reference.std()
    del reference
    if not torch.isfinite(mean) or not torch.isfinite(scale) or scale < 1e-8:
        raise RuntimeError("Original audio is silent or nonfinite")
    window, overlap = 6 * rate, rate
    identity = {
        "version": 1, "method": "hdemucs-vocal-subtraction", "source_sha256": source_hash,
        "weights_sha256": weights_hash, "sample_rate": rate, "samples_per_channel": total,
        "channels": waveform.shape[0], "window_samples": window, "overlap_samples": overlap,
        "normalization_mean": float(mean), "normalization_scale": float(scale),
        "torch": torch.__version__, "torchaudio": torchaudio.__version__,
        "formula": "reduced = (original - 0.94 * estimated_vocals) * peak_gain",
    }
    identity_hash = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    directory = checkpoint_dir / identity_hash
    directory.mkdir(parents=True, exist_ok=True)
    atomic_json(directory / "identity.json", identity)
    vocal_sum, weight_sum = torch.zeros_like(waveform), torch.zeros(total)
    vocal_index = model.sources.index("vocals")
    reused = computed = 0
    # Each prediction commits independently; overlap accumulation can be rebuilt after a restart.
    with torch.inference_mode():
        for index, start in enumerate(range(0, total, window - overlap)):
            end = min(total, start + window)
            filename = directory / f"chunk-{index:06d}.npy"
            proof_path = filename.with_suffix(".json")
            shape = [waveform.shape[0], end - start]
            prediction = None
            try:
                proof = json.loads(proof_path.read_text())
                if (isinstance(proof, dict) and proof.get("start") == start and proof.get("end") == end and proof.get("shape") == shape
                        and proof.get("sha256") == sha256(filename)):
                    stored = np.load(filename, allow_pickle=False)
                    if stored.shape == tuple(shape) and stored.dtype == np.float32 and np.isfinite(stored).all():
                        prediction = torch.from_numpy(stored)
            except (OSError, ValueError, TypeError, KeyError):
                pass
            if prediction is None:
                normalized = (waveform[:, start:end] - mean) / scale
                prediction = model(normalized.unsqueeze(0))[0, vocal_index]
                if list(prediction.shape) != shape or prediction.dtype != torch.float32 or not torch.isfinite(prediction).all():
                    raise RuntimeError("HDemucs prediction is nonfinite or has an invalid shape")
                descriptor, temporary = tempfile.mkstemp(dir=directory, suffix=".pending")
                temporary = Path(temporary)
                try:
                    with os.fdopen(descriptor, "wb") as handle:
                        np.save(handle, prediction.numpy(), allow_pickle=False)
                        handle.flush()
                        os.fsync(handle.fileno())
                    temporary.replace(filename)
                    atomic_json(proof_path, {"start": start, "end": end, "shape": shape, "sha256": sha256(filename)})
                finally:
                    temporary.unlink(missing_ok=True)
                computed += 1
            else:
                reused += 1
            local = torch.ones(end - start)
            if start > 0:
                fade = min(overlap, end - start)
                local[:fade] *= torch.linspace(0, 1, fade)
            if end < total:
                fade = min(overlap, end - start)
                local[-fade:] *= torch.linspace(1, 0, fade)
            vocal_sum[:, start:end] += prediction * local
            weight_sum[start:end] += local
            if index % 5 == 0 or end == total:
                progress(f"HDemucs separated {end / rate:.1f}/{total / rate:.1f} seconds")
            if end == total:
                break
    if float(weight_sum.min()) <= 0:
        raise RuntimeError("Uncovered samples at an audio chunk boundary")
    return (vocal_sum / weight_sum) * scale, {
        "directory": str(directory), "identity": identity_hash, "reused_chunks": reused,
        "computed_chunks": computed, "total_chunks": reused + computed,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--checkpoint-dir", type=Path)
    parser.add_argument("--threads", type=int, default=6)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    source_hash = sha256(args.input)
    model_file = weights(args.cache_dir)
    torch.hub.set_dir(str(args.cache_dir))
    torch.set_num_threads(max(1, min(args.threads, 16)))
    model = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.get_model().eval()
    original = args.output.parent / "original.wav"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(args.input), "-vn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", str(original)],
        check=True,
    )
    audio, rate = sf.read(original, dtype="float32", always_2d=True)
    if rate != 44100 or audio.shape[1] != 2 or not np.isfinite(audio).all():
        raise RuntimeError("Original audio is not finite 44.1 kHz stereo")
    waveform = torch.from_numpy(audio.T)
    total = waveform.shape[-1]
    started = time.monotonic()
    vocals, checkpoint = separate_windows(waveform, model, rate,
        args.checkpoint_dir or args.output.parent / ".separation-chunks", source_hash, WEIGHTS_SHA256,
        progress=lambda message: print(message, flush=True))
    reduced = waveform - 0.94 * vocals
    peak_gain = min(1.0, 0.98 / max(float(reduced.abs().max()), 1e-12))
    reduced *= peak_gain
    temporary = args.output.with_name(args.output.stem + ".pending.wav")
    sf.write(temporary, reduced.T.numpy(), rate, subtype="PCM_24")
    stored, stored_rate = sf.read(temporary, dtype="float32", always_2d=True)
    if stored.shape != audio.shape or stored_rate != rate or not np.isfinite(stored).all():
        raise RuntimeError("Separated audio failed exact sample alignment")
    if sha256(args.input) != source_hash:
        raise RuntimeError("Source changed during audio separation")
    temporary.replace(args.output)
    vocals_path = args.output.parent / "estimated_vocals.wav"
    sf.write(vocals_path, vocals.T.numpy(), rate, subtype="FLOAT")
    report = {
        "version": 1,
        "method": "hdemucs-vocal-subtraction",
        "source_sha256": source_hash,
        "output_sha256": sha256(args.output),
        "weights_sha256": sha256(model_file),
        "weights_url": WEIGHTS_URL,
        "reference": "https://docs.pytorch.org/audio/stable/tutorials/hybrid_demucs_tutorial.html",
        "torch": torch.__version__,
        "torchaudio": torchaudio.__version__,
        "device": "cpu",
        "sample_rate": rate,
        "samples_per_channel": total,
        "channels": 2,
        "duration_seconds": total / rate,
        "exact_sample_alignment": True,
        "window_seconds": 6,
        "overlap_seconds": 1,
        "formula": "reduced = (original - 0.94 * estimated_vocals) * peak_gain",
        "peak_gain": peak_gain,
        "elapsed_seconds": time.monotonic() - started,
        "checkpoint": checkpoint,
        "levels": {"original": levels(audio), "reduced": levels(stored)},
        "limitations": "Music-trained model may leave commentator speech and reduce crowd shouts. No claim of complete speech removal or subjective listening verification.",
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    temporary_report = args.report.with_name(args.report.name + ".pending")
    temporary_report.write_text(json.dumps(report, indent=2) + "\n")
    temporary_report.replace(args.report)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
