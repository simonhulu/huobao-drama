# Isolated MuseTalk 1.5 speed validation

`bootstrap.py` creates `/root/rivermind-data/musetalk-runtime` using the existing
`/root/rivermind-data/latentsync-venv/bin/python` (Python 3.12). A `.pth` file in
the new runtime makes the existing LatentSync and base `site-packages` available,
including the already installed PyTorch 2.12.1/CUDA 13.0, torchvision,
diffusers 0.32.2, transformers 4.48 and NumPy 1.26. It does not reinstall or
upgrade those packages, modify the old environments, start a service, or change
the science workflow.

Only missing packages from a small explicit pure-Python allowlist are installed
in the new runtime, using `pip --no-deps`. PyTorch, torchvision, NumPy and other
compiled libraries are never installed by this script. Face preprocessing uses
the vendored OpenAvatarChat ONNX implementation at commit
[`8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b`](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/tree/8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b),
so this runtime does not require MMCV, MMDetection or MMPose. The official
MuseTalk 1.5 UNet, VAE and audio-driven generation remain unchanged. This reuse
setup has generated playable benchmark MP4s on the remote RTX 3090; upstream
does not officially test this newer dependency combination.

With the official MuseTalk checkout already at `/root/rivermind-data/MuseTalk`:

```sh
/root/rivermind-data/latentsync-venv/bin/python bootstrap.py --phase environment
```

The default phase is `environment` and does not download model weights. The
runtime's `runtime-reuse.json` records the existing package directories and any
small additions. An existing runtime with a different Python ABI is rejected.

Weight downloading is a separate explicit operation. Do not start a second copy
while another weights process is running. If weights need to be prepared later:

```sh
/root/rivermind-data/musetalk-runtime/bin/python bootstrap.py --phase weights --aria2 aria2c
/root/rivermind-data/musetalk-runtime/bin/python bootstrap.py --phase check
```

The weights phase uses ModelScope mirrors and parallel `aria2c` transfers. Every
downloaded file must match the fixed byte count and SHA-256 in `WEIGHTS` before
it replaces its final path. Existing matching files are reused without a
download or even requiring `aria2c`. The known SD VAE is checked against its
fixed size and SHA-256, then linked from the existing shared directory instead
of copied. All verified files, their sources and the VAE config hash are
recorded in `models/bootstrap-manifest.json`.

| Assets | ModelScope repository |
| --- | --- |
| MuseTalk 1.5 UNet and config | `AI-ModelScope/MuseTalk` |
| Whisper Tiny weights and configs | `openai-mirror/whisper-tiny` |
| DWPose ONNX | `xiaolaowx/UniAnimate-DiT` |
| Face parsing and ResNet18 | `aile1997/face-parse-bisenet` |
| S3FD | `HaveAnApplePie/s3fd-619a316812` |

DWPose and Whisper checksums match their upstream Hugging Face LFS records.
Face parsing and ResNet18 match the corresponding MuseTalk asset mirror. The
unused PyTorch DWPose checkpoint and alternative Whisper formats are not
downloaded. The slow Hugging Face and Google Drive download paths were removed.

The `check` phase reads actual files and does not require a bootstrap manifest.
It verifies the fixed checksums, loads the UNet, VAE, Whisper and supporting
checkpoints, performs a PyTorch CUDA operation, and runs the DWPose ONNX model
with `CPUExecutionProvider`. The official ResNet18 checkpoint is a legacy tar;
only after its exact checksum matches may it be loaded with
`weights_only=False`. The benchmark converts that trusted file to a separate
`resnet18-state-dict.pth` for the current PyTorch loader, retaining the original.
Other supporting checkpoints use `weights_only=True` during the check.

Avatar material preparation extracts face positions, VAE latents and blending
masks once for the fixed reference. Subsequent narration uses the cached avatar.
ONNX DWPose preprocessing is outside the repeated warm-generation work.

Set `TORCH_HOME=/root/rivermind-data/MuseTalk/models/.torch` when running a
benchmark so the official face detector finds its downloaded weights without
writing into another environment's cache. The environment and `models/`
directory are independent of running production services.

Official source inspected at
[`0a89dec45a0192b824e3cf4daf96c239440c5ed8`](https://github.com/TMElyralab/MuseTalk/tree/0a89dec45a0192b824e3cf4daf96c239440c5ed8).
The complete timed output must be a playable MP4, including preprocessing,
generation, face compositing, video encoding and audio mux. The official
`--skip_save_images` option does not export a video and cannot establish this
production throughput.

## Complete MP4 benchmark

Upload `benchmark.py`, `runtime.py` and `vendor/preprocessing_onnx.py` into the remote checkout.
Reuse the existing presenter reference and narration; no new TTS or paid video
generation is involved. Run one benchmark at a time, using a new report name:

```sh
TORCH_HOME=/root/rivermind-data/MuseTalk/models/.torch \
OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 MKL_NUM_THREADS=4 \
/root/rivermind-data/musetalk-runtime/bin/python benchmark.py \
  --root /root/rivermind-data/MuseTalk \
  --reference /root/rivermind-data/musetalk-speed-20261107/reference-r3-25fps.mp4 \
  --audio /root/rivermind-data/musetalk-speed-20261107/narration-warmup.wav \
          /root/rivermind-data/musetalk-speed-20261107/narration-full.wav \
  --report /root/rivermind-data/musetalk-speed-20261107/new-report.json \
  --fps 15 --encoding pipe --codec libx264 \
  --preprocessing-module /root/rivermind-data/MuseTalk/preprocessing_onnx.py
```

The `pipe` path keeps official synthesis and face blending, then crops and
resizes each completed frame to 360x360 before transferring it to FFmpeg.
It encodes the presenter directly instead of saving source-size PNGs.
It supports CPU `libx264` (default) or `h264_nvenc`. This is a delivery adaptation,
not an unmodified upstream end-to-end benchmark. Pipe writes time out after
120 seconds without progress. Each completed run records input/output hashes,
encoding time, media durations, GPU memory, and a full decode check. Model startup
and cached avatar loading are reported separately. Only `status: completed`
establishes that all requested audio files finished.

`../musetalk-speed-preview.ts` composes a completed presenter with an existing
science job, the original intro, and the existing shrinking-circle transition.
It writes a separate public validation MP4 and does not update the job or enable
the presenter in automatic production. The caller must use the same narration
as the original job; duration checking alone cannot identify the wrong audio.

## Persistent Production API

`api_server.py` reuses the same loader and 360x360 direct-encoding path as the
benchmark. Models and the R3 avatar remain loaded between jobs; one worker uses
the GPU, with at most two additional queued jobs by default. Production defaults
are 15 FPS, batch size 20, and `libx264`. The completed 536.256-second test used
this path and took 358.701 seconds for MP4 export; upload, download, writing, TTS
and final composition are additional work.

Copy `api_server.py`, `runtime.py` and the vendored preprocessing file together
onto the GPU server. Start with the already prepared runtime; no new pip
installation, Torch installation or model download is needed:

```sh
OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 MKL_NUM_THREADS=4 \
/root/rivermind-data/musetalk-runtime/bin/python api_server.py \
  --root /root/rivermind-data/MuseTalk \
  --reference /root/rivermind-data/musetalk-speed-20261107/reference-r3-25fps.mp4 \
  --jobs /root/rivermind-data/musetalk-jobs \
  --host 127.0.0.1 --port 8789 --fps 15 \
  --preprocessing-module /root/rivermind-data/MuseTalk/preprocessing_onnx.py
```

The runtime accepts either a Git checkout at the pinned commit or its official
source archive. Archives do not need Git metadata: SHA-256 checks of the five
core inference/audio/model/blending files establish the expected source version.

Paths belong to the GPU machine and can all be changed. `MUSETALK_ROOT`,
`MUSETALK_REFERENCE_PATH` and `MUSETALK_JOB_ROOT` are equivalent defaults for the
three required path arguments. The application's computer only needs HTTP
access through an SSH forward to port 8789; it does not need the reference file,
the models, Python, or any original Mac path. Bind to loopback and retain the
job directory across restarts. A process lock rejects a second worker opening
the same job directory. Keep one service instance for this GPU/avatar.

| Request | Behavior |
| --- | --- |
| `GET /health` | `status` is `loading`, `ready`, or `failed`; includes model, source revision, avatar/reference hash, FPS and queue depth. |
| `POST /v1/lipsync` | Multipart fields `audio` (WAV or lossless FLAC) and `request_id` (64 lowercase hexadecimal characters); returns the job record. |
| `GET /v1/jobs/{id}` | Durable `queued`, `running`, `completed`, `failed`, or `cancelled` record. |
| `GET /v1/jobs/{id}/result` | Completed final MP4 only, checked against its recorded SHA-256 before download. |
| `DELETE /v1/jobs/{id}` | Cancels queued work immediately; running work stops at the next batch, then becomes `cancelled`. Completed work remains available. |
| `POST /v1/jobs/{id}/retry` | Explicitly retries failed/cancelled work using its original audio; never duplicates running or completed work. |

The server retains the actual WAV/FLAC bytes and their SHA-256; FLAC is useful
for reducing SSH upload time. File names supplied by clients are ignored.
Uploads are limited to 128 MiB. Repeating a request with the same ID/audio/model/
avatar returns the existing job, including failures and cancellations. A
different binding returns 409, and a full queue returns 429 without accepting
the job. A client can retry 429 with the same ID.

Completed records include `result_sha256`, `audio_duration_seconds`,
`video_duration_seconds`, `width`, `height`, and a relative `result_url`.
Interrupted queued/running jobs become explicitly recoverable failures after
restart; the server does not silently replay GPU work. A later client resume
can call `/retry`. Missing or changed stored audio and a changed model/avatar
are rejected. A client timing out should send DELETE; generation checks
cancellation between batches and while transferring frames, then terminates
the encoder and waits for its consumer thread before reusing the avatar.

Run the offline contract/lifecycle tests without CUDA or extra dependencies:

```sh
python3 -m unittest discover -s backend/scripts/musetalk -p 'test_*.py' -v
```

The tests use a fake synthesis runner and actual loopback HTTP requests. They
cover idempotency, binding conflicts, WAV/FLAC storage, queue limits, cancellation,
explicit recovery, persistent completed results, integrity rejection, one worker,
and cleanup of the producer/consumer pipe when cancelled. The prepared remote
RTX 3090 API passed a real 60-second production-client smoke test on 2026-11-07:
62.204 seconds through SSH/upload/inference/download/normalization, followed by
1.282 seconds for a cached repeat. Recheck health after deploying elsewhere.
