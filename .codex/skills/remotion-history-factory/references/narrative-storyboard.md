# Narrative Storyboard Contract

Use this mode when one narration event contains several causally connected
visible moments that must read as one scene, such as approach -> accusation ->
strike -> aftermath. It is a planning layer above the existing v8 one-image
production path, not a replacement renderer.

## Hierarchy

```text
Narrative Sequence
  -> Narration Event
    -> Visual Beat
      -> Storyboard Panel
        -> Render Shot
```

- A **Narrative Sequence** is one continuous dramatic unit with stable place,
  participants, objective, and screen direction.
- A **Narration Event** is an exact contiguous interval from the authoritative
  MiniMax narration timeline. Events partition their Sequence without gaps or
  overlap.
- A **Visual Beat** is one observable action or state change. A `cut` owns a
  verified absolute interval. A `waypoint` belongs to a group inside one Event
  and does not own independent time.
- A **Storyboard Panel** is the visual plan for exactly one Beat. Panels are
  first reviewed together in a monochrome contact sheet, then regenerated as
  separate complete 16:9 production images.
- A **Render Shot** plays either one cut Beat or one ordered waypoint group. It
  never references Beats from another Event or Sequence.

## Timing Authority

The narration master and its original MiniMax `titles` timeline remain the only
time authority. The renderer mounts exactly one top-level narration `<Audio>`;
shot video is muted and no per-shot narration audio is allowed.

For a waypoint group:

1. The first waypoint begins at its Narration Event's `startMs`.
2. Every later waypoint supplies an ordered, non-empty `anchorText` substring
   found in the authoritative caption stream for that same Event.
3. The anchor's caption-relative position becomes the waypoint's absolute
   `startMs`; the following waypoint starts where the previous one ends.
4. The final waypoint ends at the Event's exact `endMs`.
5. Missing, ambiguous, reversed, or out-of-event anchors fail the production
   gate. Equal division is draft-only fallback and must be reported as
   `equal-fallback`, never silently approved for a multi-waypoint action scene.

Run the pure contract and timing tests before paid generation:

```bash
node --test \
  scripts/videoeditor/narrative_storyboard_contract.test.mjs \
  scripts/videoeditor/narrative_storyboard_runtime.test.mjs
```

## Storyboard Sheet

Group panels by Narrative Sequence, not by an arbitrary panel count. Split a
long Sequence across numbered continuation sheets only when the model's usable
contact-sheet capacity is exceeded; preserve panel ids and order.

The planning prompt must freeze:

- one clean monochrome 2D line-sketch language;
- near-equal 16:9 panels, clear gutters, natural `P##` order;
- one concise camera/shot-size/action header per panel;
- stable identities, wardrobe, props, geography, left-right axis, and persistent
  damage or state changes;
- no captions, dialogue, arrows, duplicate panels, ghost poses, collage effects,
  shading, texture, color, or finished illustration.

The sheet controls composition and continuity only. It is not rendered and is
not used as a low-resolution crop in production.

## Production References

Generate one final image per approved panel. Keep reference responsibilities
separate:

- the cropped storyboard panel controls framing, blocking, action, and screen
  direction;
- identity cards control only stable face, age, build, hair, and wardrobe;
- prior approved final panels control recurring character, costume, architecture,
  palette, and direction continuity only;
- the series style profile controls the capture engine and material language.

Do not let a prior final image copy its scene-bound pose, gaze, emotion, injury,
or location into a later panel. Limit the continuity chain to the smallest set
that identifies recurring subjects and state; six references is the hard cap.

## Safe Prompt Compilation

Content-safety adaptation must preserve narrative causality. Compile explicit
risk tags into visible but non-graphic staging: covered injury, damaged armor,
weapon trajectory, body balance, obscured contact, or covered aftermath. Never
delete the cause, target, direction, or consequence merely to remove gore.

Classify content rejection separately from provider/network failure. A content
rejection receives one conservative prompt rewrite and resubmission. Provider
overload, timeout, or lost polling state follows the recovery rules below and
must not mutate creative intent.

## Resumable Generation

Persist provider task id, request hash, status, output path, and retry history
before polling. On restart choose exactly one action:

- `reuse`: state is completed and the local asset exists;
- `adopt`: provider completed while local state was interrupted;
- `wait`: provider task is still live;
- `resubmit`: no recoverable live/completed task exists, or force was explicit.

One failed panel must not cancel unrelated parallel panels. Never resubmit a
live or completed task merely because the local process exited; that risks
duplicate billing.

## Motion And Opening Video

Assign restrained motion from narrative function, not shot index alone:
establishing pull, impact push, memory pull, restrained hold, reveal push,
action follow, or slow push. Alternate horizontal direction only where it does
not break the scene axis. Waypoint panels own their local motion and transition.

The first Render Shot remains mandatory video. Reuse an approved tagged clip
when it exactly fits; otherwise generate image-to-video from the approved first
panel. The input panel is the exact first-frame staging, the prompt describes
one continuous action, and duration follows that shot's narration window up to
10 seconds. Render the clip muted beneath the single narration master.

## Gates

Do not render until all are true:

- Sequences and Events continuously partition the requested narration range;
- every Beat has exactly one Panel and every Render Shot stays inside one Event;
- every multi-waypoint production shot reports `narration-anchor`;
- each final panel exists as a complete 16:9 asset and passed review;
- the opening video is nonblank, readable in the first two and five seconds,
  duration-compatible, muted in Remotion, and followed by the correct next shot;
- semantic motion contains meaningful variety without decorative line wipes;
- Remotion receives one master narration track and no duplicate narration;
- macOS H.264 output logs `h264_videotoolbox` with hardware acceleration.

After rendering, verify exact duration, one AAC audio stream, no black frames,
anchor-time frame changes, and audio identity against the narration master.
