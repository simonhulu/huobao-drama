# MuseTalk production assessment - 2026-11-07

## Decision

MuseTalk 1.5 is a reasonable candidate for replacing the expensive LatentSync body-lipsync stage. Its single-step architecture and reusable avatar preparation directly address the current speed problem. Neither official sources nor this research establish that the user's RTX 3090 can deliver the complete science-pop workflow within 10-15 minutes. Quality also requires an actual comparison using the existing R3 reference and the same narration audio.

The initial read-only assessment below was followed by remote RTX 3090 measurements and the user's acceptance of sample quality. This workspace now upgrades automatic science-pop production to MuseTalk with an intro-only fallback. The production application runs on another Mac; it must receive the update and restart before that behavior takes effect there. Existing completed jobs, writer service, and LatentSync environment were not changed.

## Remote Validation

MuseTalk lives at `/root/rivermind-data/MuseTalk`. Its separate runtime at
`/root/rivermind-data/musetalk-runtime` reuses the already installed
`PyTorch 2.12.1+cu130` from `/opt/conda/lib/python3.12/site-packages/torch` and
the existing LatentSync Python packages. An initial attempt to download the
older official PyTorch version was stopped; that version was not installed.
The updated bootstrap never installs PyTorch, torchvision, or compiled packages.
All GPU synthesis runs remotely, not on the local Mac.

The existing writing service is `llama-server` on port 8788, occupying roughly
9.5 GB of GPU memory during these tests. It remained running. Avatar preparation
uses the existing accepted R3 reference, and test narration comes from the
completed durian job `science-f87eda8b-a767-4405-ba20-219164839162`.
No new paid video, TTS, or writing request was made.

| Completed test | Narration | Complete MP4 export |
| --- | ---: | ---: |
| Official PNG export, warm 25 FPS | 60.032 s | 126.607 s |
| Direct pipe + NVENC, warm 25 FPS | 60.032 s | 65.948 s |
| Direct pipe + libx264, warm 25 FPS | 60.032 s | 66.208 s |
| Crop before transfer + libx264, full 15 FPS | 536.256 s | 358.701 s |

These export measurements include audio features, synthesis, original face
blending, encoding and audio mux. Model startup takes about 18-20 seconds;
cached avatar loading is about 8 seconds. One-time preparation took 108.65
seconds. The pipe outputs a 360x360 presenter for circle display, whereas the
original PNG path writes source-size frames; these are distinct delivery paths.

The 60-second NVENC result was composed with the existing intro and shrinking
circle transition into a playable 1920x1080, 30 FPS, 65.067-second validation
video. The local preparation took 9.412 seconds, presenter normalization 1.752
seconds, and composition 79.376 seconds. The initial clip preparation is specific
to this shortened sample. A frame inspection confirms a visible presenter face
in the bottom-right circle without a gray intermediate mask. Full decoding passed;
no strict dynamic lip-sync or aesthetic quality score is claimed.

Preview: <http://localhost:3013/static/science-validation/musetalk-speed-20261107/musetalk-60s.mp4>.

Artifacts: `data/reports/science-musetalk-speed-20261107/`.
The NVENC full-narration attempt was canceled for an encoder comparison; its
partial report explicitly says `cancelled` and contains only completed short
runs. The first full-frame pipe 15 FPS attempt was also canceled to reduce pipe
transfer overhead. Neither canceled attempt establishes full completion.
`cropped-full-15fps.json` is the completed full-narration report.

The completed 15 FPS result was downloaded in 55.52 seconds, normalized in
14.187 seconds, and composed in 420.135 seconds. Local preparation and copying
bring local total time to 434.721 seconds. Together with remote export and
download, the measured work took 848.943 seconds (14 minutes 9 seconds).
The final 1920x1080 video lasts 541.333 seconds, includes audio and the fixed
intro, passes full decoding, and is available at
<http://localhost:3013/static/science-validation/musetalk-speed-20261107/musetalk-full.mp4>.
This excludes earlier writing/Huasheng production, fresh audio upload, and model
startup. It does not establish a 15-minute complete new-news workflow.

Production integration uses a persistent loopback API on remote port 8789,
lossless FLAC upload, one GPU worker, a cached avatar, content-bound idempotent
jobs, cancellation and resume. After a default 10-minute lip-sync budget or
service failure, the workflow finishes intro-only and records the downgrade.
Explicit user cancellation stops work rather than causing fallback. Deployment
instructions are in `science-musetalk-deployment.md`.

The persistent API subsequently passed a real production-client smoke test:
automatic SSH, 60-second FLAC upload, inference, result download/integrity/decode
checks and normalization took 62.204 seconds including initial model readiness.
A second invocation reused the result in 1.282 seconds. Health afterward was
`ready`, with no active or queued jobs. Artifacts are recorded in
`production-client-smoke.json`. The code on the other production Mac has not
been updated by these local tests.

## Sources and Version

The repository was inspected at main commit `0a89dec45a0192b824e3cf4daf96c239440c5ed8`.

- [Official README](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/README.md).
- [Official realtime pipeline](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py).
- [Official VAE input preparation](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/models/vae.py).
- [Official face compositing](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/utils/blending.py).
- [Official paper v3](https://arxiv.org/html/2410.10122v3).

The official README recommends version 1.5, released on 2025-03-28. Version 1.5 adds perceptual, adversarial, and sync losses, two-stage training, and spatio-temporal sampling. Version 1.0 tuning advice must not be copied indiscriminately: the current realtime script forces `bbox_shift=0` for version 1.5 and uses `extra_margin` and face parsing for its crop/blending behavior.

## What the Official Speed Claim Means

The README advertises 30+ FPS on a Tesla V100. The [paper, section 4.2](https://arxiv.org/html/2410.10122v3#S4.SS2), explicitly qualifies the result as 30 FPS at a 256x256 face-region resolution on a V100 **with preloaded data**. No RTX 3090 throughput measurement was found in the inspected official README, paper, or inference code.

MuseTalk is not an iterative diffusion model. It performs one-step latent inpainting using a UNet and VAE decoder, with Whisper-Tiny audio features. This gives a credible architectural reason to expect a substantial speed improvement over the user's 40-step LatentSync configuration. It does not establish a specific RTX 3090 speedup or a quality ranking on this presenter.

For scale only: five minutes at 25 FPS contains 7,500 frames. At an assumed sustained 30 generated frames/second, that generation stage would take 250 seconds, or 4 minutes 10 seconds. This is arithmetic based on the official V100/preloaded-data claim, not a prediction or measurement for the user's machine, and excludes other workflow costs.

The code makes the measurement boundary particularly important:

- Avatar preparation performs frame extraction, landmark/bbox detection, VAE input encoding, face parsing, and mask generation. These artifacts are cached and reused for the same avatar.
- Audio-feature processing completes before the generation timer begins ([realtime script, lines 239-268](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L239)).
- The timed generation region includes UNet inference, VAE decoding, and the joined frame-compositing thread. PNG saving is optionally included.
- MP4 encoding and audio mux occur after the printed generation time ([lines 285-307](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L285)). Model loading, transfers, downstream circle/intro composition, and delivery are also outside that number.
- `--skip_save_images` is a benchmark switch in the unmodified script. The final video-generation block requires `skip_save_images=False`; simply enabling the switch does not produce a deliverable MP4 faster.

A persistent worker with cached avatar material is the relevant production architecture. Running a fresh normal-inference CLI for every task repeats avoidable preparation and model loading. The remote measurements above keep the existing writer model resident; they do not measure simultaneous heavy writing and lip-sync workloads.

## Quality and Reference Material

Official capabilities and limitations:

| Topic | Evidence and consequence |
| --- | --- |
| Input language | Chinese audio is explicitly supported. |
| Face generation resolution | The generated face region is 256x256, independently of the final video's resolution. A small presenter circle is a more plausible display target than a large close-up; that suitability is an inference, not a measured result. |
| Identity | The README and paper explicitly note imperfect preservation of details such as lip shape/color and mustaches. |
| Temporal stability | The README and paper still acknowledge occasional jitter from single-frame generation. Version 1.5's spatio-temporal training does not justify claiming a temporal inference module fixes this. |
| Teeth and mouth | The paper describes a tradeoff between sharp dental detail and accurate audio-driven mouth movement; version 1.5's Dynamic Margin Sampling is intended to mitigate it. No guarantee is given for every source. |
| Frame rate | The README recommends 25 FPS input to match training. |

The [paper's comparison table](https://arxiv.org/html/2410.10122v3#S4.T1) is evidence against promising universally better lip synchronization: MuseTalk's LSE-C is 6.53 on HDTF and 4.77 on VFHQ, versus 7.90 and 6.79 for the tested LatentSync baseline. MuseTalk has better FID and CSIM in that comparison. These dataset-level results do not evaluate the user's tuned LatentSync version, R3 video, Mandarin narration, or final circle layout.

There is no inspected official requirement to generate new speaking reference clips containing a rich phoneme inventory. The README accepts a video, image, or directory of images for normal inference. The current avatar-preparation code extracts image frames and does not use the reference video's original speech as the driving condition; the separate narration audio drives synthesis.

Reference mouth content is nevertheless not irrelevant. [`VAE.get_latents_for_unet`](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/models/vae.py#L108) concatenates a lower-face-masked latent and a full reference-face latent. The [paper's section 3.4](https://arxiv.org/html/2410.10122v3#S3.SS4) discusses copying reference lip movement, especially when teeth are visible, as a failure tendency addressed during training. This supports comparing existing references if artifacts appear, not requiring the user to pay for more clips in advance.

The existing accepted R3 clip should be the first trial input. Preserve its identity and use the existing narration audio, so the evaluation isolates the replacement model. Inspect teeth, mouth corners, lip closure, synchronization, identity changes, mask edges, and jitter at both native crop size and the intended circle size. Optional face restoration is not a proven solution to sync error or temporal instability and should not be a default extra stage before the basic result is judged.

One source-specific loop issue matters: realtime avatar preparation constructs `frames + reversed(frames)`, with corresponding coordinates and latents ([lines 184-186](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L184)). Original head and hand motion therefore plays backward for half the cycle. Check existing R3 motion at the turnaround; do not assume that a source clip becomes a natural seamless long-form loop automatically.

## Community Reports Are Not Benchmarks

[Issue 373](https://github.com/TMElyralab/MuseTalk/issues/373) reports a 30-40% difference between two RTX 3090 systems with different CPUs. The author says CPU CV operations were slower, before FFmpeg composition, and later marks it self-resolved without publishing the fix. It supplies no reproducible absolute RTX 3090 production throughput.

[Issue 396](https://github.com/TMElyralab/MuseTalk/issues/396) includes mixed, unaudited user throughput reports on other GPUs, including a 4090 report around 15 FPS. These reinforce the need to measure the complete pipeline; they do not establish a reliable RTX 3090 estimate.

## Acceptance Boundary

The validation sequence starts with official MuseTalk 1.5, existing R3 material, 25 FPS, and cached avatar preparation. Completed short tests and delivery adaptations are recorded above. The long-form speed trial uses 15 FPS for the small circle, prioritizing the user's speed requirement. A persistent worker would additionally avoid per-task model startup; this benchmark remains a CLI and does not claim to be that production worker.

The production target remains a usable final video in approximately 10-15 minutes. The user accepted the short sample quality and authorized the production upgrade. Full existing-video lip-sync/transfer/composition was measured above; a fresh news task from collection through Huasheng and deployment performance on the other Mac remain outside that measurement. The new fallback preserves the accepted intro-only output when the optional lip-sync stage cannot finish promptly.
