# Videoeditor Stock B-roll

`scripts/videoeditor/stock_videos.mjs` is an optional helper for searching and downloading stock video candidates for Remotion showcase work. It does not automatically download on search, does not modify shot plans, and does not assign footage to any storyboard.

## Search

Set the provider API key in the environment. Only these variables are read:

- `PEXELS_API_KEY` or comma-separated `PEXELS_API_KEYS`
- `PIXABAY_API_KEY` or comma-separated `PIXABAY_API_KEYS`
- `COVERR_API_KEY` or comma-separated `COVERR_API_KEYS`

Examples:

```bash
PEXELS_API_KEY=... node scripts/videoeditor/stock_videos.mjs search \
  --provider pexels \
  --query "storm clouds" \
  --limit 8 \
  --min-duration 4 \
  --output data/temp/stock-clouds.json
```

```bash
PIXABAY_API_KEY=... node scripts/videoeditor/stock_videos.mjs search \
  --provider pixabay \
  --query "city traffic timelapse" \
  --manifest data/temp/stock-city-flow.json
```

Search output is an auditable JSON manifest with `provider`, `videoId`, `title`, `creator`, `duration`, `width`, `height`, `sourceUrl`, `downloadUrl`, `licenseUrl`, and `query`. API keys are never written to the manifest. Results prefer 16:9 landscape files at least 720px wide and filter out clips shorter than `--min-duration`.

## Download

Download is explicit and manifest-driven:

```bash
node scripts/videoeditor/stock_videos.mjs download \
  --manifest data/temp/stock-clouds.json \
  --dest data/static/remotion/stock
```

Only manifest entries with `downloadUrl` are downloaded. Files are saved as:

```text
data/static/remotion/stock/<provider>-<videoId>.mp4
```

The manifest is updated in place with `localPath`, `downloadedAt`, `sha256`, and `bytes`.

## Usage Boundary

Stock B-roll is suitable for observable motion and for period/environment texture: clouds, smoke, ocean surfaces, fire, rain, crowd flow, terrain, carriages, architecture, industry, and similar inserts. Selection uses a one-axis acceptance rule: narration/action match **or** era/setting credibility is enough for inclusion. Clips strong on both axes may be full-frame primary visuals; clips strong on one axis should normally be brief cutaways, transitions, or cropped inserts. Do not reduce selected footage to a decorative low-opacity texture.

Era-only stock may establish atmosphere but must not be labeled as proof of a historical identity, location-specific fact, or core event. Narration-matched stock may be used when the exact year or place is uncertain; trim, crop, or grade secondary conflicts when practical. Reject a clip only when neither axis is strong, or when an unavoidable contradiction dominates the frame. Verified public-domain archival footage may carry more specific historical evidence when its provenance and usage rights are recorded. To use a downloaded clip in a showcase, manually and explicitly copy the chosen `localPath` into the showcase stock manifest or shot manifest, and record the provider, source URL, license URL, creator, query, hash, and review notes alongside the shot. Keep source and authorization records auditable for every selected clip.

The optional showcase manifest uses an explicit `items` array. A clip is ignored unless its local file exists and it names at least one storyboard number:

```json
{
  "schemaVersion": 1,
  "kind": "remotion-showcase-stock-broll",
  "items": [
    {
      "provider": "pexels",
      "videoId": "12345",
      "storyboardNumbers": [11],
      "localPath": "static/remotion/stock/pexels-12345.mp4",
      "sourceUrl": "https://www.pexels.com/video/12345/",
      "licenseUrl": "https://www.pexels.com/license/",
      "creator": "Creator",
      "duration": 8,
      "opacity": 1,
      "blendMode": "normal",
      "reviewNotes": "作为可见动态转场，实际画面已通过年代可信单轴审查"
    }
  ]
}
```

`build_showcase_manifest.mjs` converts an absolute downloaded path under `data/` to a `static/...` URL. Remotion receives only this local URL; it never uses `downloadUrl` or makes a provider request while rendering.
