---
name: science-pop-factory
description: "Create animal/plant science-pop videos from a user-provided source clip and narration script: keyframe/scene segmentation into shots, TTS narration, and final composition with the subject always on screen."
---

# Science-Pop Factory（动物/植物科普视频工厂）

## Current Automatic Workflow

The primary `/science-pop` content workflow now uses remote writing, Huasheng
voice `1595608`, a separate fixed intro, and remote MuseTalk 1.5 for the body
presenter circle. See `docs/science-musetalk-deployment.md` for deployment and
the current behavior. The production application runs on the other Mac at
`192.168.0.105`, maintained through `ssh root@192.168.0.105`. Commit and push changes, then synchronize
and verify that host; a local update package alone does not finish deployment.
Never assume this Mac's paths, dependencies or `.env` exist there. MuseTalk GPU
inference runs only on the remote RTX 3090, reusing its existing PyTorch.
No Higgsfield generation or new paid reference footage is needed.

Keep the fixed greeting out of the rewritten body. Reuse the original main
audio for lip-sync, preserve the intro-to-circle motion transition, and fall
back to intro-only delivery when the lip-sync service fails or times out.
Explicit user cancellation must stop work instead of triggering fallback.

The project/episode APIs and segmentation workflow documented below are the
separate legacy/manual workflow, not the automatic news content pipeline.

Use this skill to produce short science-pop videos for animals or plants. The workflow is intentionally simpler than `remotion-history-factory`:

- **No image/video generation.** The user provides the source video (e.g. a tiger clip).
- **No plot or dramatic continuity.** The goal is simply to keep the subject visible while the narration plays.
- **Optional semantic matching.** Prefer clips that match what the narration says, but if matching is hard, looping the subject footage is acceptable.

## When to use

- User wants a 科普 video about an animal or plant.
- User has raw footage and a narration script (口播文案).
- Output is a single MP4 with narration audio mixed over the footage.

## UI entry point

Open `http://localhost:3013/science-pop` in the browser.

## Pipeline stages

```text
Create project  →  Intake (upload video + paste script)  →  TTS  →  Segment  →  Compose
```

### 1. Create a project

From the UI:
1. Go to `/science-pop`.
2. Click **新建项目**.
3. Enter project title, episode title, optional description.

From the API:

```bash
POST /api/v1/science-pop/projects
{
  "title": "老虎的秘密生活",
  "episode_title": "为什么老虎是森林之王",
  "description": "科普老虎的捕猎与习性"
}
```

Response contains `episode.id`. The UI redirects to `/science-pop/episode/{id}`.

### 2. Intake: source video + narration script

The user must provide:
- `source_video_url` — a path under `data/static/...` or `static/...`. Upload the file first (e.g. via the existing `/upload` endpoint or any file drop), then paste the returned static path.
- `script_content` — the verbatim Chinese narration script.

From the UI:
1. Paste the static video path into the **源视频** field.
2. Paste the narration script into the **科普口播脚本** textarea.
3. Click **保存资料**.

From the API:

```bash
PUT /api/v1/science-pop/projects/{episode_id}/intake
{
  "source_video_url": "static/uploads/tiger.mp4",
  "script_content": "老虎是世界上最大的猫科动物……"
}
```

### 3. Generate narration TTS

This enqueues `tts.episode_unified`, which calls MiniMax TTS and stores the audio at `episodes.pre_tts_audio_url` plus a sentence-level `pre_tts_titles_json`.

From the UI: click **生成 TTS**.

From the API:

```bash
POST /api/v1/science-pop/projects/{episode_id}/tts
```

Poll `GET /api/v1/tasks/{task_id}` until `succeeded`.

### 4. Segment the source video

This enqueues `science_pop.segment`. The backend:
1. Runs FFmpeg scene detection (`select=gt(scene\,0.3)`).
2. Splits the source video at detected scene changes using the segment muxer (copy codec).
3. If too few scene changes are found, falls back to equal-duration splits (~5 s each).
4. Creates one `storyboards` row per clip with `video_url` pointing to the local clip.

From the UI: click **开始分镜**.

From the API:

```bash
POST /api/v1/science-pop/projects/{episode_id}/segment
{
  "scene_threshold": 0.3,      // optional
  "target_shot_seconds": 5     // optional, fallback split size
}
```

Poll the returned task id.

### 5. Compose final video

This enqueues `science_pop.compose`. The backend:
1. Concatenates all clip storyboards in order.
2. Loops the concatenated video with `-stream_loop -1` to cover the full narration audio length.
3. Mixes the narration audio track.
4. Writes the final MP4 to `episodes.video_url`.

From the UI: click **合成成片**.

From the API:

```bash
POST /api/v1/science-pop/projects/{episode_id}/compose
```

### 6. Review and download

- In the UI, the **成片** section shows a video player and a download button.
- The final file is served under `/static/science-pop/{episode_id}/{uuid}_final.mp4`.

## Data model

- `dramas` — project container; `workflow_type = 'science_pop'`.
- `episodes` — one episode; holds `source_video_url`, `script_content`, `pre_tts_audio_url`, `video_url`.
- `storyboards` — one row per segmented clip; `video_url` is the clip path, `duration` is the clip duration.

## Task types

| Type | Stage | Long-running | Output |
| --- | --- | --- | --- |
| `tts.episode_unified` | TTS | no | `episodes.pre_tts_audio_url` |
| `science_pop.segment` | Segment | no | `storyboards` rows with clip paths |
| `science_pop.compose` | Compose | yes | `episodes.video_url` |

## Verification commands

```bash
# Final video exists and has audio
ffprobe -v error -show_entries format=duration -of csv=p=0 backend/data/static/science-pop/{episode_id}/*_final.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=s=x:p=0 backend/data/static/science-pop/{episode_id}/*_final.mp4

# Storyboard clips
sqlite3 backend/data/huobao_drama.db "SELECT storyboard_number, duration, video_url FROM storyboards WHERE episode_id = {episode_id} ORDER BY storyboard_number;"
```

## Constraints and conventions

- Do not run `science_pop.compose` before segmentation and TTS are complete.
- Source video should ideally show the subject clearly and continuously.
- The final video is rendered at 1280x720. Upscaling/downscaling is handled by FFmpeg pad+scale filters.
- No subtitles are burned in v1; subtitles can be added later if needed using `pre_tts_titles_json`.
- If narration is longer than footage, the video loops to cover the audio. If shorter, the video is truncated to the audio length.

## Repair playbook

- **Segmentation produced too many/few shots:** re-run segment with a lower/higher `scene_threshold`.
- **Final video has no audio:** check that TTS succeeded and `pre_tts_audio_url` is set.
- **Final video is black or frozen:** check that source clip files exist and are readable.
- **Compose failed because video is shorter than audio:** this is handled by looping, but if the source clip is corrupt, re-segment first.
