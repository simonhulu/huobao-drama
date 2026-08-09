# Story-Material Curation (故事素材提纯)

Runs after search and before the creative contract. In original mode, load it after the original
structure dissection; in generate mode, load it directly from the confirmed topic and provisional
story requirements. Every surviving material must be assigned to a story job before the writer
sees it. This step is the quality filter between raw search and the writer.

## Principle

Raw search produces far more material than a story can carry. Most of it is unusable because it
does not create desire, opposition, reversal, consequence, or a memorable image.

The curation agent's job is to choose ruthlessly. A material survives only when it helps the
audience feel, understand, or anticipate something in the story.

## Input

All files under `scripts/polish-notes/<article-id>/01-raw-search/`.

## Process

### Phase 1: Discard (Remove Junk)

Discard any raw material that:
- Is a summary or generalization ("满族是少数民族", "旗人生活困难")
- Is SEO content or AI-generated filler
- Restates common knowledge the audience already knows
- Does not change a character's action, the audience's belief, the cost, or the next question

### Phase 2: Select Story-Bearing Material

When materials overlap, keep the version that creates the clearest scene or strongest turn. Do not
spend the writer's attention reconciling dates, source rankings, quotations, or competing versions.
The writer may compress, reorder, merge, or invent connective material. The selection question is
always: “What does this make the character do, lose, learn, or choose next?”

### Phase 3: Score Density

Score every surviving material 1–3:

| Score | Criteria | Examples |
|-------|----------|----------|
| **3** | Creates a visible choice, reversal, loss, or consequence | “军队打到城下，却被迫撤走” |
| **2** | Supports a turn or clarifies the central conflict | “战胜共同敌人后，盟友转而争夺成果” |
| **1** | Atmosphere or context that can stay only if it strengthens a scene | “一个政权长期保留，但外部控制加深” |
| **0** | Discard — summary, background, or filler with no story movement | “某朝代与某地关系密切” |

### Phase 4: Assign to Acts

Assign each material to the act or provisional structure slot it best serves. Use the dissected
skeleton in original mode; in generate mode use the topic's main hole, likely causal turns, and
target audience to define the provisional slots that Step 2 will turn into the final plan:

- **Opening (Act 1)**: one material that creates the main hole. Favor ironic reversals and concrete stakes.
- **Body (Acts 2–N)**: one to three materials per turn. Favor escalating opposition, before/after contrasts, and consequential choices.
- **Close (Final Act)**: one material that pays the opening promise. Favor a decisive result and a charged after-effect.

### Phase 5: Flag Gaps

If a planned turn has no material or scene that can make it happen, flag the gap. The orchestrator
may search for one targeted story ingredient, but must not bulk-import more facts.

## Output

Write `scripts/polish-notes/<article-id>/02-story-material-pool.md`:

```markdown
# Story Material Pool

## Opening (Act 1) — Main Hole

### M1 [Score: 3] [Story job: ...]
1924年，北京把最后一笔旗饷停了——每月二两银子，一名三两饷银的马甲仅领到铜元50枚。

### M2 [Score: 3] [Story job: ...]
启功，雍正九世孙。祖父临终遗言："你决不许姓金。你要是姓了金就不是我的孙子。"他自创"启"姓，有人写"爱新觉罗·启功收"，他退回标注"查无此人"。

...

## Body Turns
...

## Story Gaps
- Turn 3 lacks a consequence that forces the next choice.
```

## Token Discipline

- The curation agent reads all raw search files (on disk, not in main session).
- The story-material pool is the only search artifact passed downstream.
- The pool targets 6–15 load-bearing materials total. More is not better after this point.
