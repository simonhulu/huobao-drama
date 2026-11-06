# Single-Image Pipeline — grid asset production (design / generate)

> **Scope note:** this document covers only the live grid asset-production
> contract — the intake flow (script → Episode) and the narrative-panel
> design/generate stages (`grid.episode_design`, `grid.episode_generate`).
> The v8 render path formerly documented here — VLM six-axis review, the Grok
> video layer, `GridStoryPreview` props/render/BGM, and the pilot validation
> ladder — was retired on 2026-07-31; see `references/comic-pipeline.md` for
> the current history-comic-five-v1 path.

This document covers the drama Episode asset-production path (the storyboard
page, for example `http://localhost:3013/drama/114`).

## Intake: from a standalone script to a grid-ready Episode

For a final script that is NOT yet a drama Episode (e.g. a polished
talking-head script from `scripts/`):

1. `POST /api/v1/dramas` with the explicit `media_account_id`.
2. `POST /api/v1/dramas/:id/import-script` with `script_content` +
   `narration_voice_id` (use the account's production voice). This creates a
   `direct_script` / `verbatim` Episode and schedules extractor ->
   `tts.pre_generate` -> storyboard breaker.
3. **Immediately** `PUT /api/v1/episodes/:id { auto_mode: false }` —
   otherwise `advanceAfterStoryboardBreaker` auto-schedules the CLASSIC
   per-shot `image.generate` + TTS + compose chain, which conflicts with and
   wastes money against the grid pipeline.
4. After the breaker completes, **verify `storyboards` actually exist**
   (count > 0). The agent path can report `succeeded` with zero storyboards
   saved (see below).
5. Verify `preTtsAudioUrl` and `preTtsTitlesJson` exist and cover the master
   narration duration. They are the only timing source for storyboard Events
   and captions; do not create or concatenate per-storyboard narration audio.

Known breaker failure mode (fixed 2026-07-18 in
`storyboard-breaker-direct.ts`): the instructions mandate calling
`save_director_plan` before `save_storyboards`, but the direct request
originally exposed only `save_storyboards`; the model then hallucinates a
call to the missing tool and saves nothing (task still ends "succeeded").
The direct path now exposes both schemas and runs a small loop: execute
`save_director_plan` (best-effort — strict validator rejections are logged
and skipped, the v7 pipeline does not consume director plans), then execute
`save_storyboards`. LLM generation of a full episode's shots takes several
minutes — never run it under a 600 s cap.

One Episode = one task chain. All stages run through the shared task queue;
routes return `{ task_id }` and must be polled, never blocked on HTTP.

| Order | Task type | Route | Purpose |
| --- | --- | --- | --- |
| 1 | `grid.episode_design` | `POST /api/v1/grid/episode/:id/design` | continuity design only (camera tracks + anchors) -> persist `narrative_sequences.design_json`; no image generation |
| 2 | `grid.episode_generate` | `POST /api/v1/grid/episode/:id/generate` | LLM single-frame design -> one complete 16:9 image per shot -> write `gridCells` and `storyboard_panels.final_path` |

Supporting reads: `GET /api/v1/grid/episode/:id/cells` (per-shot production
state).

Payloads:

- design: `{ onlySequenceIds?, onlyStoryboardIds? }`
- generate: `{ force?, onlyStoryboardIds?, useReferenceImages? }`

## Frozen visual spec

- One complete static image per shot: **16:9, recorded as 1920x1080,
  generated at 1K** (`frameType: 'single_frame_16x9'`). The user has
  explicitly rejected 2K: the
  delivery target is a phone screen, and 2K costs more than 2x for no
  visible gain.
- The image occupies the whole generated canvas. It contains one decisive
  visible moment, one main action, and one visual anchor. Collages, grids,
  split screens, picture-in-picture, dividers, and repeated subjects are hard
  failures. The user explicitly removed the dual-panel mode because sharing
  pixels across two portrait cells reduced image quality.
- **Zero text in the image**: no characters, digits, seals, watermarks, or
  generator labels. All information content goes into the shot's `graphic`
  field and is handled by the downstream overlay layer. Close-up tombstones,
  letters, signs and newspapers are text magnets: either shoot them
  wide/from the side, or require "碑面刻字隐于阴影、模糊不可辨"; a
  description that asks for legible lettering fails the text check every
  time.
- No post-generation split or crop artifact is created. The completed
  `imageGenerations.localPath` becomes the shot's sole cell `src` directly.

## Reference-art layer (continuity & style)

Shot generation is text-to-image per shot; without references every shot
becomes a disconnected vignette with a drifting face and style. The fix is
a one-time reference-art layer per Episode; the pipeline then auto-attaches
these refs (`collectReferenceImages`) to every shot image:

1. **Character cards** (`characters.image_url/local_path`): one
   costume-and-era-specific portrait per main character (2:3). Faces,
   costumes and presence stay locked across shots.
2. **Scene storyboard** (`scenes.image_url/local_path`): one 3x3 sheet
   (split into 9 with sharp) containing every scene's key art in ONE call,
   one unified style. It is a composition/style reference only — never
   shown to the viewer, so 1K per-cell fidelity is acceptable.
3. **Executable series style profile**: select ONE neutral profile from
   [visual-style-library.md](visual-style-library.md) before paid reference
   generation. The profile freezes capture engine, composition grammar,
   color-field policy, lighting hierarchy, film response, and negative
   boundaries. `drama.style` resolves through
   `history-visual-style.ts`; the selected `styleProfile` is persisted in
   `gridCells`. Per-shot `look` chooses concrete palette, light, and mood
   inside the profile instead of forcing one duotone across the Episode.
   Changing the resolved profile makes old decompositions stale on the next
   pipeline run. Creator-name shortcuts, generic cinematic suffixes, and
   competing profiles in one shot fail the style gate.

Operational rules:

- All image generations MUST go through the `createTask({type:
  'image.generate'})` queue. Direct `imageGenerations` inserts without a
  task are orphans and get marked failed by the reconciler
  (`reconcileImageGenerationState`) — this exact mistake cost four
  generations on 2026-07-18.
- apimart async tasks intermittently answer polls with "No associated task
  found" right after submit; the adapter treats this as pending, never as
  terminal.

## gridCells data contract

Written back to `storyboards.gridCells` as JSON:

```json
{
  "theme": "string",
  "displayTitle": "中文4-12字完整短标题，不得机械截断旁白",
  "styleProfile": "<selected-style-id>",
  "cells": [
    {
      "description": "中文 <=90 字, one decisive action + composition four elements",
      "move": "push | pull | tiltDown | tiltUp | hold",
      "enter": "cut | dissolve | fade",
      "enterFrames": 15,
      "graphic": { "type": "bignum", "value": 8000, "prefix": "$", "suffix": "美元", "label": "普利策悬赏寻人" },
      "src": "static/images/....png"
    }
  ]
}
```

`move` / `enter` are whitelisted by the decompose prompt (`enter`: `cut |
dissolve | fade`); the LLM never emits `reveal` (显影). Every current
storyboard contains exactly one cell.

`graphic` (info graphic, OPTIONAL — present on roughly one third of cells,
never all of them) is the only sanctioned carrier of informational text: the
generated image itself stays text-free, and any numbers or labels live in
this field as design metadata for the downstream overlay layer, never baked
into the picture:

- `bignum`: one striking number — `{type:"bignum", value, prefix?, suffix?, label<=10字}` (count-up animation);
- `trend`: 2–5 point comparison — `{type:"trend", title<=10字, unit?, points:[{label<=6字, value}]}` (staggered bar chart);
- `card`: 1–2 line takeaway — `{type:"card", title<=8字, lines[<=12字 x2]}`.

Numbers must come from the narration — no invented figures, and never
repeat a name/year/place the narration already stated (that is redundancy,
not information). Malformed graphics are stripped at validation, not
rejected.

## Decompose + generate

`decomposeEpisodeForGrid` (only shots with empty gridCells, unless `force`)
sends each storyboard to the active text LLM (`getActiveTextConfig()`, model
field may be a JSON array string — parse and take the first element) with:

- shot title, narration (`sb.narration || sb.description`), scene/time/shot
  size, the original action sketch (truncated at 120 chars), and cast
  characters (name + stable identity appearance only; scene-bound posture,
  location, action, gaze, and emotion are stripped before prompting);
- hard rules: zero text in frame; era self-consistency (props, costumes,
  architecture, vessels correct for the story's period; no modern objects,
  no modern typefaces); each description carries the **composition four
  elements** — subject + position (rule of thirds), fore/mid/background
  layering, light direction, color tone.

Before any paid `image.generate` task is created, the description passes the
documentary reality gate:

- the action must be physically possible and consistent with real social,
  ritual, and professional procedure;
- the camera must occupy a location a real camera could access;
- abstract identity, relationship, motive, and secret-information narration
  may be carried by a credible contextual image plus voice-over — do not
  invent a literal event simply to visualize the statement;
- a cemetery burial defaults to a closed casket; visible remains or an open
  casket require the current narration to explicitly establish a viewing,
  farewell, exhumation, or opening event.

The same reality gate runs again immediately before generation so stale
persisted `gridCells` cannot bypass it.

`generateEpisodeGridSheets` then, per shot: inserts an `imageGenerations`
row, creates an `image.generate` task through the queue (idempotency key
`image.generate:storyboard:single16x9:{sbId}:{generationId}`), and polls the
task table every 5 s (timeout `max(10, tasks*3)` min). **Never insert task
rows directly** — the reconciler misreads hand-written rows; always use
`createTask`. The image model resolves from `ep.imageConfigId ??
getActiveImageConfigId()`; the apimart adapter defaults to `gpt-image-2`,
`resolution: '1k'`, size normalized to `16:9`. Reference images (character +
scene stills) are collected into `referenceImages`. On success the complete
image path is written directly to the sole cell `src` and `gridSheetImage`.

### Narration-to-visual evidence contract (hard lesson)

A shot image must help the viewer understand its narration span. Run this
contract before any paid image task:

1. Extract the current clause's core claim: actor, action or result, time state,
   location, and what changes.
2. Split first when one frame cannot contain those facts together: living vs
   post-death, departure vs arrival, different locations, or multiple decisive
   events. Do not ask one image to summarize a sentence by using generic B-roll.
3. Choose the strongest valid evidence route: **direct event** (the action is
   visibly happening) -> **aftermath trace** (the event has left unmistakable
   physical consequences) -> **credible evidence scene + controlled graphic**
   (only for abstract identity, number, relationship, or record facts).
4. Name one fact-derived attention anchor: danger, contradiction, discovery,
   irreversible result, scale, strong human choice, or abnormal aftermath. If
   neither plot nor image has one, redesign the shot without inventing facts.
5. Apply the mute test to the final composition, including declared info
   graphics. A viewer should be able to identify the core action or result;
   matching only era, location, costume, or mood is a failure.

Reject symbolic or conceptual illustrations at the decompose gate: "why did it
erupt in the 1850s" must not become a blank calendar. Reject proxy activity too:
asking a clerk, writing, holding a notebook or wallet, hanging a key, and looking
at a file do not prove escape, burial, pursuit, discovery, or a failed search.
Those actions pass only when the narration actually describes that process.

Regression examples:

- `一个活着东躲西藏、死了还要用假名下葬的人` cannot be one frame. Split it
  into escape/hiding, closed-casket burial with an alias graphic, and the next
  clause's search result.
- `生前自然是不太好找的` is not a reporter interviewing a clerk. Use an
  aftermath trace such as an emptied room, a still-warm cup, footprints, and a
  moving back door so the failed search is physically readable.
- `根本不叫这个名字` needs a credible identity-evidence scene (for example two
  records aligned for comparison) plus `identity_reveal`; a person merely
  writing on paper is not evidence.

Future user rejections of narration-match quality are regression incidents, not
one-off prompt-tuning requests. Before regenerating:

1. Preserve a paired fixture containing the exact narration, rejected visual,
   accepted redesign, selected evidence route, and attention anchor.
2. Put the general lesson in this canonical contract. Add a deterministic
   pre-generation rule only for a high-confidence event family; leave open-ended
   semantic judgment to visual review rather than growing a brittle keyword
   blacklist.
3. Add both reject and accept assertions, then run the existing accepted Episode
   shots through the gate to catch false positives.
4. Do not "fix" a semantic mismatch by changing the series style, adding
   cinematic adjectives, or creating an Episode-specific generation path.

### Shot length and sequencing

Each single-image storyboard contains exactly one semantic event and must be
8 seconds or shorter. Split longer material before decomposition using the
real pre-TTS title timeline; if one spoken sentence is still too long, split
at visible clause punctuation and interpolate its TTS window. The current
`narration` is the unique source of truth for the current frame. Stale title,
description, action, cast links, or future/previous narration may not introduce
the wife, funeral, reveal, or any other subject outside its spoken span.

Design adjacent shots as one sequence: setup -> development -> turn -> landing.
Pass the previous completed shot design and next narration into decomposition;
preserve face, costume, props, weather, light direction, color response, screen
direction, eyeline, and axis inside the same scene while deliberately varying
shot size, camera angle, focus depth, action, and framing.

## Cost rules

- 1K images only; 2K is rejected for this delivery target.
- One paid image covers one storyboard; reuse approved assets before paying
  for new ones.
