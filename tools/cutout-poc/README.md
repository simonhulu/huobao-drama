# Cutout to Remotion POC

This is the smallest local path for turning an opaque image into a layered
Remotion shot:

```text
source image -> rembg/BiRefNet -> RGBA foreground + grayscale mask -> Remotion
```

## Setup

Use a dedicated Python environment outside the repository if the dependency is
not already installed:

```bash
python3 -m venv /tmp/huobao-rembg-venv
/tmp/huobao-rembg-venv/bin/python -m pip install --upgrade pip
/tmp/huobao-rembg-venv/bin/python -m pip install 'rembg[cpu,cli]'
```

The first run downloads the selected model. The default `u2netp` model keeps
the smoke test small. For the quality pass, use `birefnet-general-lite` or
`birefnet-general` explicitly.

## Run

From the repository root:

```bash
/tmp/huobao-rembg-venv/bin/python tools/cutout-poc/remove_background.py
cd remotion
npm run render:cutout
```

The command writes `remotion/public/cutout-poc/subject.png`,
`subject-mask.png`, and `metadata.json`. The video is written to
`remotion/out/cutout-parallax.mp4`.

To test another image or model:

```bash
/tmp/huobao-rembg-venv/bin/python tools/cutout-poc/remove_background.py \
  --input data/static/images/e8b313e0-52b1-4669-9466-101024be26ba.png \
  --model birefnet-general-lite
```

## Acceptance checks

- `subject.png` is RGBA and has a non-empty alpha bounding box.
- `subject-mask.png` is grayscale and has the same dimensions as the source.
- The Remotion output is an 8-second, 1280x720 H.264 video.
- The subject moves independently from the background, proving that the
  transparent asset is being composited as a separate layer.
