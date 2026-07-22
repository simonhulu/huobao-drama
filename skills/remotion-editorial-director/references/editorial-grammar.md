# Magnates-style Remotion editorial grammar

## Scope and evidence

This is an implementation grammar distilled from four supplied videos. It describes observable editing behavior and when to use it; it does not copy scripts, branding, or visual assets.

The strongest visual calibration is Yahoo. The frozen Yahoo review set contains 25 target events across 10 review units, and the accepted high-resolution run passes 25/25 targets and 10/10 reviews. Large review media and run artifacts remain external to the portable Skill.

All four media files have verified machine analysis, subtitles, review windows, and review image assets. YouTube, Tencent, and Netflix do not yet have full-corpus VLM annotations, so their visual recipes combine machine boundary evidence with subtitle-derived semantic structure rather than claiming frame-by-frame labels.

Canonical analysis inputs:

| Source | Duration | Semantic segments | Candidate events | Review windows |
| --- | ---: | ---: | ---: | ---: |
| Yahoo | 955.5s | 18 | 899 | 283 |
| YouTube | 2374.0s | 30 | 2124 | 588 |
| Tencent | 4725.5s | 44 | 4367 | 1241 |
| Netflix | 4114.0s | 37 | 3715 | 1062 |

The source media, generated review assets, and verification reports are external evidence inputs. They are never embedded in or required to install the Skill.

## Primitive registry

The production vocabulary has 23 reusable primitives. A recipe must name the semantic subject, such as `Yahoo logo`, `view count`, `globe fragments`, or `purple underline`. Generic `text` and `shape` subjects are not sufficient.

| Group | Primitive | Remotion implementation | Use |
| --- | --- | --- | --- |
| Boundary | `hard_cut` | adjacent `Sequence` layers, zero overlap | Real temporal or archival discontinuity |
| Boundary | `dissolve` | crossed opacity, 10-18f | Gentle continuity, never a default |
| Boundary | `blur_bridge` | overlap + animated blur/scale/opacity | Concept changes with a designed visual link |
| Boundary | `graphic_transition` | bridge bars/lines/shape plus incoming scale | UI, map, diagram, or title changes |
| Boundary | `matte_transition` | irregular `clipPath` aperture from black | New act or a major narrative state change |
| Boundary | `distortion` | RGB-offset echoes, strips, skew, scan lines | Digital failure, rupture, censorship, crisis |
| Boundary | `ambiguous` | preserve direct boundary; do not invent a fade | Sampled black boundary without resolved intermediate frames |
| Continuity | `no_local_delta` | stable hold | No observable layer change |
| Continuity | `within_setup_change` | keep base/camera alive; mutate named layer only | Text, counter, bar, line-art, or interface update |
| Layer | `layer_entry` | `Sequence` + spring/translate/opacity | Add a logo, caption, bar, card, or diagram node |
| Layer | `layer_transform` | interpolate position, scale, rotation | Assemble globe fragments or move an existing layer |
| Layer | `mask_reveal` | `clipPath`/mask growth | Reveal logos, line art, maps, titles |
| Layer | `persistent_overlay_footage_cut` | overlay outside footage sequences | Supporting montage under one persistent claim |
| Text | `type_on` | progressive substring or character stagger | Short title or decisive phrase only |
| Text | `text_replace` | same setup, discrete keyed text value | Contrast, bid changes, before/after wording |
| Text | `text_counter_change` | numeric interpolation or discrete replacement | A named metric with unit and time context |
| Text | `underline_entry` | `scaleX` from left | Attach caption hierarchy to a title |
| Camera | `push_in` | 3-12% scale with focal origin | Revelation, emotion, rising consequence |
| Camera | `pull_out` | 3-8% scale out | Resolution, loss of power, context reveal |
| Camera | `pan_or_tilt` | restrained transform inside crop guard | Follow geography, lists, or a directional action |
| Camera | `scale_track` | layer scale independent from camera | Yahoo logo scale-out and map scale-in |
| Graphic | `globe_line_assembly` | circular strokes and mask/transform sequence | Internet scale, network reach, global platform |
| Graphic | `comparison_split` | two panels, divider, separately bound metrics | Competitors, business models, before/after |

Yahoo calibration confirms: logo `scale_down/out`; world map `scale_up/in`; map-to-laptop and search-to-90s `blur_bridge`; globe fragment/outline assembly; purple underline/bar entry; `The Rise` type-on; counter change; black irregular matte; chromatic distortion; graphic eye-to-`however`; true archival hard cuts; stable no-change holds.

## Semantic selection rules

1. `surprise_contrast`: retain the subject and replace only the metric/headline. Examples: Yahoo `$128B -> $1M`, Netflix `Blockbuster refusal -> $200B+`.
2. `mechanism_chain`: hold one map, monitor, phone, or diagram while nodes, arrows, captions, and counters enter in narration order. Camera drift stays under 5%.
3. `metric_subject_binding`: every number carries `{subject, value, unit, period}`. Never animate an unbound number.
4. `chapter_matte`: use black-to-irregular-matte only for a real act change: growth to crisis, product to regulation, failure to reinvention.
5. `concept_bridge`: use 10-18f blur/graphic bridges for related concepts with a new base setup. Use hard cut for a genuine time or archive break.
6. `archival_montage`: use fast cuts for a series of evidence items while a persistent title or metric remains stable.
7. `comparison_split`: keep both parties visible and update metrics inside their own side. Do not alternate full-screen cards when direct comparison matters.
8. `controversy_dual_frame`: present benefit and cost as separately sourced evidence. Do not render an allegation as a literal event.
9. `reversal_punch`: expectation hold, one short strike/replacement, 4-8f black or one distortion event, then the new state. Avoid repeated dissolves.
10. `resolution_pullout`: stop adding information, return to a verified subject, and hold or pull out for 1-2 seconds before the CTA.

## Source-specific pacing

- Yahoo: slower strategic post-mortem. Prefer 8-15s setups, restrained counters, comparison replacements, and chapter mattes.
- YouTube: platform lifecycle with dense incidents. Use UI/card assembly, creator and scandal montage, persistent counters, and clear sponsor bumpers.
- Tencent: highest information density and an ecosystem/regulation duality. Keep a stable phone/network base and add layers; reserve distortion for censorship, policy, or platform conflict.
- Netflix: chronological pivots and competition. Use timelines, price/market counters, competitor splits, and single hard-cut punchlines for business mistakes.

## Industrial recipe contract

The production machine-readable contract is `contracts/magnates-remotion-recipe-v2.schema.json`. Generated TypeScript contract types are in `generated/contracts.ts`. Recipe v1 is migration input only.

Key invariants:

- Shot durations sum to `durationInFrames` within one frame.
- A transition class is explicit; it is never inferred from a generic effect name.
- `within_setup_change` retains the same background setup.
- Text and counter cues have concrete subjects and non-empty frame ranges; counters also declare `unit` and `period`.
- Camera and independent layer scale are separate channels.
- Recipe `fps` drives Remotion metadata, and a completed project narration asset is mounted as the composition audio track.
- Static assets use `Img`, local video uses `OffthreadVideo`, and all final paths resolve locally at render time.
- Unsupported or unresolved boundaries fall back to `hard_cut`/`ambiguous`, not a fabricated dissolve.

The Director accepts a closed manifest and never guesses Magnates-style animation from legacy project state:

```bash
node scripts/director.mjs produce --manifest path/to/input-manifest.json
```

Missing assets, generic cue subjects, unbound counters, unsupported effect
names, and duration mismatches fail before render. Existing
project compositions remain outside the production adapter route.
