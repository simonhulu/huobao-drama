# History recreation preparation

## Observed behavior

The existing history path made two `gpt-6.1-terra` calls: source analysis plus
three candidate angles, then drafting. It recorded a core viewpoint, story
structure, emotion triggers, essential facts, and short candidate outlines.
It did not require separate author stance, necessary background, source outline,
an inventory linking material to claims, or a final paragraph outline mapping
the emotional turns to the new manuscript.

Saved sources 129 (Episode 1102) and 116 (Episode 1103) still identify their
older recreation model as `gpt-6-luna` and have no new analysis checkpoint.
Video retries reuse these locked drafts. A model or prompt update does not
retroactively rewrite saved narration.

## Executed workflow

`history-script-recreation.ts` revision `history-perspective-recreation-v2`
retains two model calls and the existing checkpoint:

1. Analyze source viewpoint, author stance, background, original outline,
   narrative structure, actual emotional triggers, supporting excerpts, and
   material limitations. Each evidence excerpt must occur in the source.
2. Compare the existing three angles, selecting one supported by the material
   that explains and strengthens the core argument. Originality does not require
   automatically reversing the author's stance.
3. Produce a formal writing outline in the same first response. Each section
   records its purpose, new information, and evidence/background/emotion IDs.
   Validate references, unique IDs, and coverage of every identified necessary
   background item and emotional node; persist before drafting.
4. The second call receives this exact outline, source, and selected angle.
   Draft in outline order, introduce context where needed, and preserve the
   triggers and consequences of the emotional arc. Remove repeated judgments,
   generic reflection, and filler. There is no minimum character count.

The approximately ten-minute direction never justifies invented material or
padding a short source. Questionable precise details can be omitted or phrased
more conservatively. Editorial uncertainty records are not a list to read aloud
in the narration. Necessary limitations remain attached to relevant claims.

The existing History Scripts analysis disclosure now shows the added fields
and final outline. Legacy drafts and plans remain readable. The source pipeline
saves the outline in both the checkpoint and completed recreation metadata;
the narration field contains only the finished manuscript.

## Validation and limits

118 targeted backend tests passed for recreation, collection pipeline, and
source jobs. Four browser scenarios passed for old/new plans, pending/completed
writing, desktop and mobile. No historical draft was overwritten and no preview
triggered video production or publishing.

An isolated real-source run used source 129: 6,583 source characters, six emotion
nodes, three background items, 18 excerpts, and six outline sections. The first
draft had 1,679 characters versus the saved draft's 2,251. Full reading found
repeated editorial caveats despite the reduced length, so that first draft is
not evidence of adequate final prose. The writing instruction was corrected to
keep editorial records out of narration and omit unnecessary disputed details.
The next real attempt met the model gateway's concurrency 429. Artifacts are
under `data/static/history-recreation-study/`; these are isolated previews.

Structural validation proves the preparation exists and reaches drafting; it
cannot prove that every final paragraph follows it or that a manuscript is good.
Character counts do not prove information density. Full-script reading remains
the relevant quality check. A separate current Science workflow/test mismatch
prevents the workspace-wide TypeScript check; no history-change errors were
reported by that check.
