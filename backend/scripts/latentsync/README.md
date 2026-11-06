# Verified LatentSync API

Copy both `api_server.py` and `verified_api.py` into the remote
LatentSync checkout, then start the existing virtual environment with:

```sh
uvicorn verified_api:app --host 127.0.0.1 --port 8787
```

The wrapper retains the existing HTTP API and the upstream inference pipeline.
The production adapter uses FP32 for face alignment and restoration, matching
the accepted R3 reference sample; UNet and VAE keep their inference precision.
`/health` and newly processed jobs report `geometry_dtype: float32`. The science
client rejects completed jobs without this record and uses a new presenter cache
version, so old face geometry results cannot be reused.
It verifies the complete VAE, LatentSync 1.6 UNet and Whisper tiny weights before model loading, rejects invalid or
constant decoder frames, validates the final video and audio, and stores job
states in each job's `job.json`. Interrupted tasks are retained as failures after
a restart; they are never automatically submitted a second time. Verified
completed responses include `output_stage: restored_video` and `vae_sha256`.

`POST /v1/lipsync` accepts `video` and `audio` plus optional multipart fields:

| Field | Default | Accepted values |
| --- | --- | --- |
| `inference_steps` | `40` | Integer, 20 to 50 |
| `guidance_scale` | `1.5` | Finite number, 1 to 3 |
| `enable_deepcache` | `false` | Boolean |
| `seed` | `1247` | Integer, 0 to 4294967295 |

Every job returns and persists these exact values as `inference_settings`.
The settings cannot be changed after submission. The single serial worker
enables DeepCache only for requested jobs and disables it and clears its
feature cache after every job, including failed jobs. The default is an
uncached 40-step quality candidate; compare short samples before choosing
production settings. `/health` reports the defaults and 512 model resolution.

The science backend uses `SCIENCE_PRESENTER_REFERENCE_PATH` for the body reference,
independently of `SCIENCE_INTRO_VIDEO_PATH`. Set `SCIENCE_PRESENTER_FRAMING=closeup`
for a face close-up so the circular overlay retains the full square crop.
`LATENTSYNC_INFERENCE_STEPS`, `LATENTSYNC_GUIDANCE_SCALE`,
`LATENTSYNC_ENABLE_DEEPCACHE` and `LATENTSYNC_SEED` select the request settings.
Both the reference bytes and all four settings are bound to the presenter cache;
completed responses with different settings are rejected. Each production segment
waits up to one hour by default, retaining its remote job ID when interrupted.

The task-specific A/B/C/D comparison uses the same ten seconds of narration:

```sh
cd backend
node --env-file=.env --import tsx scripts/latentsync-quality-validation.ts
```

`evaluate_quality.py` runs upstream SyncNet on CPU, verifies its auxiliary weights,
and isolates upstream temporary files from the running API. Confidence and AV
offset supplement visual review; they do not measure naturalness or tooth quality.

The VAE is `stabilityai/sd-vae-ft-mse` at revision
[`31f26fdeee1355a5c34592e401dd41e45d25a493`](https://huggingface.co/stabilityai/sd-vae-ft-mse/tree/31f26fdeee1355a5c34592e401dd41e45d25a493).
Its `diffusion_pytorch_model.safetensors` is 334643276 bytes with SHA-256
`a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815`.
A preallocated but unfinished download can have the correct size while containing
zero-filled tensor regions, so file size and successful model loading are not
sufficient integrity checks.

Official inference reference: ByteDance/LatentSync revision
[`a229c3948406bc2cf6eaf4873e662e70c6a04746`](https://github.com/bytedance/LatentSync/tree/a229c3948406bc2cf6eaf4873e662e70c6a04746).
[`scripts/inference.py`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/scripts/inference.py#L89)
calls the full pipeline. Masked input frames are not delivery output. The pipeline
decodes generated latents, pastes surrounding pixels back, restores faces to the
original frames, then writes and muxes `video_out_path`:
[`lipsync_pipeline.py`](https://github.com/bytedance/LatentSync/blob/a229c3948406bc2cf6eaf4873e662e70c6a04746/latentsync/pipelines/lipsync_pipeline.py#L453).

Focused tests need only the Python standard library:

```sh
python3 -m unittest discover -s backend/scripts/latentsync -p 'test_*.py'
```

## Isolated Reference Samples

`reference_experiment.py` uses the verified existing weights without starting
the API or restoring production jobs. Run it beside `api_server.py` and
`verified_api.py` in the existing GPU environment:

```sh
python reference_experiment.py --video reference.mp4 --audio narration.wav \
  --output sample.mp4 --steps 40 --guidance 1.5 --ref-offset 0 \
  --geometry-dtype float32 --seed 1247 --capture-stages
```

The JSON records input, runner, source and weight hashes, exact settings, and
the final restored output hash. Existing outputs and stage directories are
never overwritten. Audio is limited to 30 seconds; DeepCache stays disabled.
The geometry option affects alignment and restoration, not UNet/VAE precision.

`--capture-stages` observes frames 0, 25, 50, 75 and 100 in `sample.stages/`:
aligned source, decoded face, face after surrounding-pixel paste, original full
frame and restored full frame. It preserves pipeline tensors and RNG state.
These PNGs are diagnostic images. Only the completed, validated `sample.mp4`
is a playable final output. Stills cannot establish speech synchronization or
temporal quality.
