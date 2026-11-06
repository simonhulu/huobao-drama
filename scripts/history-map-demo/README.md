# History Map Animation Demo

A 24-second, 1920x1080, 30 fps fictional battle map demonstration.
Blender produces an original terrain plate and projects world-space routes
into the exact camera coordinates used by the Remotion overlay. Remotion
animates marches, a flank maneuver, converging attacks, retreat, flags,
stage text, and a shared camera move. The terrain camera is fixed during
the Blender render; the final motion is a composite over that plate.

## Reproduction

Run from the repository root using the existing Blender, Remotion, local
headless Chrome, macOS Tingting voice, and FFmpeg installations:

```sh
blender --background --factory-startup --python scripts/history-map-demo/build_terrain.py
node scripts/history-map-demo/render.mjs all
```

`stills` instead of `all` only renders four representative screenshots.
The renderer refuses to replace an existing dry MP4; use a new delivery
directory when producing another version. The terrain generator refreshes
its intermediate PNG, projection JSON, and editable Blender scene.

## Outputs

- `remotion/public/history-map-demo/terrain.png`: original rendered plate.
- `remotion/public/history-map-demo/scene.json`: projected route and place data.
- `data/static/history-map-demo-20261024/terrain.blend`: editable Blender scene.
- `data/static/history-map-demo-20261024/`: final MP4, review page, stills,
  temporary narration, input properties, hashes, and delivery metadata.

The review page is served by the existing backend at
`http://127.0.0.1:5679/static/history-map-demo-20261024/index.html`.
It can also be opened directly from the filesystem.

All terrain and battle data are fictional and marked illustrative in the
video and scene data. No geographic or historical accuracy is implied.
The voice is temporary local Mandarin speech synthesis. This demonstration
does not call an external generation API or create a database episode.
