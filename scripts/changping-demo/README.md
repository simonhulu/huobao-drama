# Changping Control Map Demo

A 45-second map of the changing local Qin/Zhao control situation around
Shangdang and Changping. The sequence distinguishes the transfer of Han
Shangdang to Zhao, Qin advances and Zhao defense, Zhao's temporary sortie,
Qin encirclement, the battlefield defeat, and subsequent consolidation of
Shangdang. Handan and the Zhao homeland remain blue at the end.

The imagery is an illustrative regional map. Fronts, control polygons,
historical boundaries and troop paths are authored schematic geometry,
not measured historical GIS data. Geographic anchors use approximate
modern city positions and do not claim precise ancient sites. The
Blender relief is a schematic representation of regional mountain ranges,
not a DEM. No area shares, force ratios, or casualty counts are invented.

Sources, anchor coordinates and timing are recorded in
`remotion/src/changping-data.ts` and copied into the delivery directory.
The historical sequence follows *Shiji*, especially the Bai Qi/Wang Jian
biography. Web search indexes supplied the quoted passages; direct full
text retrieval was not available in this session.

```sh
blender --background --factory-startup --python scripts/changping-demo/build_relief.py
node scripts/changping-demo/render.mjs stills
node scripts/changping-demo/render.mjs video
node scripts/changping-demo/serve.mjs
```

Use `all` to render stills and video together. The renderer refuses to
overwrite an existing dry MP4; use a new output directory for another
version. The local macOS Tingting voice is used for temporary narration.

Delivery: `data/static/changping-demo-20261024/`.
Review URL: `http://127.0.0.1:5679/static/changping-demo-20261024/index.html`.
The HTML can also be opened directly with its adjacent assets.
The included server supports byte ranges for video seeking. With it running,
`node scripts/changping-demo/verify.mjs` checks full decoding, audio level and
cue timing, desktop/mobile playback, changing frame pixels and page overflow.

## Real-Geography Atlas Version

The upgraded version preserves the earlier video and uses actual DEM relief
from cached Mapzen Terrain Tiles, Natural Earth rivers and modern city
coordinates, and a separately credited Philg88 Warring States overview.
The 1380x752 regional map keeps nearly equal geographic scale in each
direction. The battle-control layer and troop paths remain schematic.

```sh
node scripts/changping-demo/build-real-map.mjs
node scripts/changping-demo/render.mjs all --atlas
node scripts/changping-demo/serve.mjs 5680 --atlas
node scripts/changping-demo/verify.mjs --atlas
```

The build caches elevation tiles and Natural Earth data, records source
hashes and imagery headers, and resamples Web Mercator tiles into the
map's longitude/latitude projection. Rendering itself uses local assets.
For the historical overview, the downloaded 522x480 image is retained in
`remotion/public/changping-demo-v2/warring-states-260bce.jpg`. Its source is
`https://textimgs.s3.amazonaws.com/boundless-world-history/7mx6nxtws92ubzub3pwz.jpe`,
a reproduction of Philg88's Commons original in Lumen Learning's course.

Delivery: `data/static/changping-demo-v2-20261024/`.
Review: `http://127.0.0.1:5680/static/changping-demo-v2-20261024/index.html`.
This demo video and map artwork are provided under CC BY-SA 3.0; attribution
and scope are recorded in its `LICENSE.md`. Data choices and limits are
explained in `docs/free-map-data-for-history.md`.
