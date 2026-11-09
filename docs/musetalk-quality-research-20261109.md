# MuseTalk lip-sync quality research - 2026-11-09

## Decision

The first quality experiment should restore **25 FPS reference preparation and
25 FPS inference**, using the existing original half-body presenter and exactly
the same narration. The current 15 FPS optimization changes both temporal
sampling and the official audio-conditioning window. Converting the resulting
15 FPS video to 30 FPS does not generate the missing mouth states.

This note records source research, not a claim that a production change has
already improved perceptual synchronization. Deployment and experiment results
must be reported separately. The presenter must remain half-body with hands;
face-region tuning does not require replacing that framing with a head close-up.

## Source Versions

Inspected on 2026-11-09. The official main branch is still the revision already
pinned by this project; an upstream update alone offers no new inference code.

| Source | Inspected commit | Scope |
| --- | --- | --- |
| [TMElyralab/MuseTalk](https://github.com/TMElyralab/MuseTalk/tree/0a89dec45a0192b824e3cf4daf96c239440c5ed8) | `0a89dec45a0192b824e3cf4daf96c239440c5ed8` | Official 1.5 inference, audio, masks, VAE |
| [kijai/ComfyUI-MuseTalk-KJ](https://github.com/kijai/ComfyUI-MuseTalk-KJ/tree/fe908e93ea08d3b3303362c3e19928351f53234b) | `fe908e93ea08d3b3303362c3e19928351f53234b` | Older 1.0 integration; useful audio-index comparison |
| [chaojie/ComfyUI-MuseTalk](https://github.com/chaojie/ComfyUI-MuseTalk/tree/84f4b6dcbb0d87e87687f324092056646582457d) | `84f4b6dcbb0d87e87687f324092056646582457d` | Officially linked third-party integration; old model layout |
| [HumanAIGC-Engineering/OpenAvatarChat](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/tree/8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b) | `8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b` | Maintained 1.5 integration and offline comparison path |
| [joonson/syncnet_python](https://github.com/joonson/syncnet_python/tree/907c0b579c2e2d83f0eae1b2ac9e720cde4e5623) | `907c0b579c2e2d83f0eae1b2ac9e720cde4e5623` | Original SyncNet evaluation implementation |

The [official paper, v3](https://arxiv.org/html/2410.10122v3), supplies training
mechanisms and limitations. Issue comments below are dated contributor advice,
not immutable code or controlled benchmarks.

## Established Mechanisms

### Frame rate also changes audio conditioning

The [official README recommends 25 FPS to match training](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/README.md#L320).
The realtime script extracts every decoded reference frame without resampling;
the requested inference FPS controls narration feature selection and output
playback. Therefore changing only the inference FPS also changes the speed of
the cached source motion. Prepare a fresh 25 FPS reference from the original
presenter, rather than playing the existing 15 FPS cache at 25 FPS.
See [frame extraction](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L39)
and [audio-to-inference flow](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L237).

The [1.5 audio processor](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/utils/audio_processor.py#L48)
uses 50 Hz Whisper features. With the defaults `left=2, right=2`, each video
frame receives 10 consecutive feature positions. However, it pads the left
with `ceil(50 / fps) * 2` feature positions, then starts each window at
`floor(frame_index * 50 / fps)` in that padded sequence.

For an interior frame, let `q = floor(frame_index * 50 / fps)`:

| Inference FPS | Left padding | Original feature indices selected | Shift versus 25 FPS at the same feature-clock position |
| --- | ---: | --- | ---: |
| 25 | 4 | `q-4 ... q+5` | 0 ms |
| 20 | 6 | `q-6 ... q+3` | 40 ms earlier |
| 15 | 8 | `q-8 ... q+1` | 80 ms earlier |

This is a deterministic difference in the conditioning window, not proof that
the visible mouth lags by exactly 80 ms. The network's learned response,
feature quantization, and source-mouth content still matter. The implementation
does not by itself imply progressive drift: frame count and feature index both
scale with the same FPS. Merely matching the total MP4 duration cannot detect
this kind of local alignment error.

Changing `audio_padding_length_left` alone is not an equivalent correction:
it also changes the number of feature positions passed to the model. Preserve
the trained 10-position input shape when comparing audio alignment.

### Reference, latent, and blend frames must keep the same order

Official inference [resets `self.idx=0` per audio clip](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L260).
The [data generator](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/utils/utils.py#L49)
selects reference latent `(i + delay_frame) % len(latents)`, with default delay
zero. The compositor indexes the corresponding source frame and mask by the
generated frame index. `delay_frame` shifts reference selection, not narration
features; it is not a general audio/video synchronization adjustment.

Preparation [appends reversed frames, coordinates, and latents](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L184).
This produces a forward/backward motion loop. Reversed hand gestures and head
motion at the turnaround can look unnatural independently of lip accuracy.
Preserve current motion while isolating the FPS experiment; assess loop
turnarounds separately.

Preparation also [skips latent encoding for a zero bounding box](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L172)
without removing the corresponding frame and coordinate. A source with failed
face detection therefore needs validation before caching: all frame, coordinate,
latent, and mask sequences must be valid and aligned. This is a potential
failure mode, not evidence that this presenter's cache contains such a frame.

### Crop and fusion affect mouth visibility and chin motion

In 1.5, the [official realtime entry point forces `bbox_shift=0`](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L393).
Preparation instead [extends the bottom of the detected face by `extra_margin`](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L176),
then resizes that region to 256x256. The margin is measured in source pixels,
so the same value has different relative size after reference downscaling.

The [face parser's `jaw` mode](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/utils/face_parsing/__init__.py#L92)
includes mouth labels and modifies cheek/jaw mask geometry; it excludes the
nose. The [cached blend mask](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/utils/blending.py#L112)
also applies a lower-region boundary and Gaussian blur. A mask that leaves
original lip/chin pixels visible can look like incomplete mouth movement even
when the generated face crop moves correctly. Inspect the generated crop,
mask, and blended result together before changing parameters.

An official contributor's [specific long-face/non-frontal example](https://github.com/TMElyralab/MuseTalk/issues/303#issuecomment-2786295993)
uses left/right cheek widths 120/50 and margin 30. Their
[follow-up advice](https://github.com/TMElyralab/MuseTalk/issues/303#issuecomment-2789988130)
recommends frontal faces, restrained facial/lip movement, and room below the
chin. This supports presenter-specific tuning, not copying those values as a
universal improvement. More margin can also reduce the effective mouth detail
within a fixed 256x256 model input.

Crop, parsing mode, cheek widths, preprocessing version, precision used for
cached latents, and source content should participate in cache identity.
Changing preparation parameters while loading old latents/masks invalidates
the experiment. The original upstream metadata checks only limited fields.

### Source-mouth leakage is plausible, not yet diagnosed

The [VAE input](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/models/vae.py#L110)
concatenates a lower-face-masked latent with a full reference-face latent. The
[paper's section 3.4](https://arxiv.org/html/2410.10122v3#S3.SS4)
explains a training failure tendency to copy reference lips, particularly when
teeth are visible, and introduces Dynamic Margin Sampling to mitigate it.
This is a reason to compare a calmer existing source segment if poor closure
persists. It does not establish that every speaking reference must be replaced
or that a newly generated reference would solve this case.

Dynamic Margin Sampling is a **training** strategy. Randomizing the production
crop per output frame is not an implementation of that strategy and can add
jitter. Preserve half-body framing, body motion, and the user's existing
presenter when testing source segments.

### FP32 has a cost and needs an actual comparison

The [official demo instructions](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/README.md#L340)
say removing `--use_float16` can improve quality at increased VRAM/time cost.
However, [official realtime inference explicitly converts VAE, UNet, and positional encoding to FP16](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/scripts/realtime_inference.py#L366),
as does the inspected OpenAvatarChat path. There is no inspected controlled
benchmark quantifying a lip-sync gain from FP32 for this Mandarin presenter.

The [VAE samples its encoding distribution](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/musetalk/models/vae.py#L84).
Use fixed seeds and consistent cache construction in comparisons. Changing the
seed, source, frame rate, margin, and precision together prevents attribution.
With another service occupying GPU memory, test a short FP32 or VAE-only FP32
candidate with a small batch before proposing a production default. A VAE-only
test concerns image reconstruction and is not equivalent to full FP32 inference.

## What Community Implementations Add

| Implementation | Observed behavior | Implication |
| --- | --- | --- |
| ComfyUI-MuseTalk-KJ | [Old model path](https://github.com/kijai/ComfyUI-MuseTalk-KJ/blob/fe908e93ea08d3b3303362c3e19928351f53234b/nodes.py#L65); [audio slicing uses fixed `center-4 ... center+5`](https://github.com/kijai/ComfyUI-MuseTalk-KJ/blob/fe908e93ea08d3b3303362c3e19928351f53234b/nodes.py#L273), independently of FPS | Supports an isolated fixed-context low-FPS experiment; not evidence that reverting to 1.0 or installing ComfyUI improves quality |
| chaojie/ComfyUI-MuseTalk | [Weights layout is the older `musetalk/pytorch_model.bin`](https://github.com/chaojie/ComfyUI-MuseTalk/blob/84f4b6dcbb0d87e87687f324092056646582457d/README.md#L39) | A packaging/workflow reference, not a demonstrated upgrade over current 1.5 |
| OpenAvatarChat | [Defaults retain `jaw`, 90/90 cheek widths, margin 10, padding 2/2](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b/src/handlers/avatar/musetalk/musetalk_algo.py#L931); [FP16 models](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b/src/handlers/avatar/musetalk/musetalk_algo.py#L232); [offline comparison shares the realtime blend path](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b/src/handlers/avatar/musetalk/musetalk_algo.py#L779) | Useful pattern for controlled offline validation, not a distinct higher-quality model |

OpenAvatarChat's [guide recommends 20 FPS](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/8b7b3b45bca28ae9ab5fa72ee31bc03c5a99b08b/docs/reference/handlers/avatar/musetalk.md#L27),
while its offline configuration fallback is 25 FPS. This is an application
tradeoff, not evidence overriding official training-rate guidance. The official
project explicitly [does not verify or maintain third-party integrations](https://github.com/TMElyralab/MuseTalk/blob/0a89dec45a0192b824e3cf4daf96c239440c5ed8/README.md#L141).

## Minimal RTX 3090 Experiments

Use one existing 15-25 second Mandarin passage containing bilabial closures,
open vowels, pauses, and normal hand motion. It should span at least one
source-loop turnaround. Reuse the exact audio bytes for every candidate; no
new paid speech/video generation is needed. Record effective parameters,
source/audio hashes, elapsed time, peak VRAM, and output duration.

| Priority | Controlled A/B | Decision it resolves |
| --- | --- | --- |
| 1 | Current 720px/15 FPS reference + 15 FPS inference versus the original half-body reference resampled to 25 FPS + 25 FPS inference; otherwise identical defaults | Whether the supported training-rate path materially improves the deliverable; this combined test does not separate sampling density from context alignment |
| 2 | At 15 FPS with the same prepared avatar, current window versus fixed four-feature left padding and ten-feature window; retain existing boundary padding policy | Isolates the approximately 80 ms context shift from extra mouth frames; useful only if a lower-FPS speed mode is still required |
| 3 | At the winning FPS, inspect masks then compare margin 10 with one or two modest alternatives, such as 20/30 source pixels; alter cheek widths only where mask inspection shows a specific problem | Whether original mouth/chin leakage or insufficient chin room causes visible artifacts; use new cache identities |
| 4 | At fixed FPS/crop/precision, original motion cycle versus a calmer, more frontal existing source segment, when available; retain the half-body and hands | Whether reference mouth content or reverse-loop motion dominates remaining perceptual problems |
| 5 | At fixed winning settings, FP16 baseline versus one small-batch FP32 candidate, or explicitly labeled VAE-only FP32 reconstruction test | Whether increased memory/time buys a visible benefit on this presenter; stop if it threatens the resident writer service |

Do not run a full factorial sweep. Stop expanding the experiment once the
same-audio output has a clear usable improvement and sufficient production
headroom. Avoid changing crop settings to conceal a systematic timing error.

## Evaluation and Acceptance

Inspect the native synthesized face, the blended 360px presenter, and the final
1920x1080 layout. Compare at normal playback speed, then inspect closures and
pauses frame by frame. Confirm hands/body remain visible, mouth corners do not
double, the chin does not tear, identity remains consistent, and loop direction
changes do not create distracting motion.

SyncNet is useful as a secondary check of offset and consistency. The
[original evaluator](https://github.com/joonson/syncnet_python/blob/907c0b579c2e2d83f0eae1b2ac9e720cde4e5623/SyncNetInstance.py#L103)
assumes 25 FPS, 16 kHz audio, five-frame visual windows, and four MFCC steps
per video frame. Its [full pipeline converts to 25 FPS](https://github.com/joonson/syncnet_python/blob/907c0b579c2e2d83f0eae1b2ac9e720cde4e5623/run_pipeline.py#L264).
Normalize evaluation copies without changing duration or audio timestamps;
use the same detected face crop for all candidates, preferably before the
small presenter is embedded in the final circle.

The evaluator [searches candidate offsets and defines confidence as median distance minus the minimum distance](https://github.com/joonson/syncnet_python/blob/907c0b579c2e2d83f0eae1b2ac9e720cde4e5623/SyncNetInstance.py#L138).
Report the estimated offset as well as distance/confidence. A high confidence
at a nonzero offset can still mean a misaligned delivered clip. Do not silently
retime each candidate before judging its delivered synchronization, and do not
compare scores from differently cropped or sampled tracks as if equivalent.

The [MuseTalk paper's supplement](https://arxiv.org/html/2410.10122v3#as1_S4)
also cautions that low-resolution SyncNet-derived LSE-C does not strictly track
perceptual lip quality; it uses a different, larger LatentSync SyncNet for
training. Neither generic LSE-C thresholds nor the paper's dataset averages
establish quality for this presenter. A uniform manually selected audio offset
must not be introduced without repeatable same-direction offset evidence across
multiple speech segments.

The [paper's stated limitations](https://arxiv.org/html/2410.10122v3#as1_S7)
include imperfect lip shape/color, limited 256x256 face resolution, and
single-frame jitter. Face restoration or interpolation may change appearance,
but the inspected sources do not establish either as a repair for incorrect
phoneme timing. Neither retraining nor replacing the model is needed to run
the above experiments.
