# Metrics Contract

This contract locks the retention metrics the script is engineered for. Every later decision—hook choice, segment length, information density, sentence rhythm, CTA—must be traceable back to these numbers.

## Required fields

| Field | Value | Why it matters |
| --- | --- | --- |
| `target_platform` | e.g. bilibili, douyin, wechat_channels, youtube | Platform determines pacing, hook speed, and CTA style. |
| `target_duration_seconds` | integer ≥ 15 | Drives skeleton proportions and segment count. |
| `target_3s_retention` | 0–1 | The first filter: did the viewer stop scrolling? |
| `target_5s_completion` | 0–1 | Did the hook earn the next 10–20 seconds? |
| `target_overall_completion` | 0–1 | Did the body hold attention to the end? |
| `primary_metric` | `3s_retention` / `5s_completion` / `overall_completion` | Which retention metric wins when tactics conflict. |
| `target_comment_rate` | 0–1, optional | Secondary revenue metric: expected share of viewers who comment. |
| `comment_strategy` | `resonance` / `confrontation` / `expression` / `relation` / `none` | Which comment type the angle is engineered for. |

## Benchmarks

| Video length | 3s retention target | 5s completion target | Overall completion target |
| --- | --- | --- | --- |
| ≤1 min | ≥80% | ≥65% | ≥55% |
| 1–5 min | ≥75% | ≥55% | ≥50% |
| 5–10 min | ≥70% | ≥50% | ≥45% |
| 10–20 min | ≥65% | ≥45% | ≥35% |

## Comment rate benchmarks (secondary)

| Comment strategy | Healthy target | When to use |
| --- | --- | --- |
| resonance | ≥1.5% | Strong identity projection, shared grievance or relief. |
| confrontation | ≥1.0% | Hard stance that invites disagreement or correction. |
| expression | ≥0.8% | Dense knowledge or method that viewers want to repeat. |
| relation | ≥0.6% | Content viewers want to forward to a specific person. |

Comment rate is **secondary** to retention. A script with high comment potential but low completion is a failure because the algorithm will not distribute it.

## Conflict resolution

When a choice helps one metric but hurts another, use `primary_metric`:

- **3s_retention first**: favor sharper hooks, faster cold opens, stronger visual/sonic promises. Accept slightly more setup if it pays off in seconds 5–15.
- **5s_completion first**: favor immediate value delivery and promise-fulfillment in the first 5 seconds. Avoid clickbait hooks that create a gap between title and content.
- **overall_completion first**: favor modular 2–3 minute segments, re-engagement beats, and steady information density. Accept a softer hook if it builds a more trustworthy promise.

Default priority for most mid-length scripts: **3s_retention > overall_completion > 5s_completion**.

When `target_comment_rate` is set, the full priority is:

**3s_retention > 5s_completion > overall_completion > target_comment_rate**

## Retention vs. comment arbitration

A comment-optimizing choice is allowed only if it does not violate the retention priority above. Use these rules:

| Situation | Rule |
| --- | --- |
| Choice improves comment rate but lowers 3s retention | **Reject.** 3s retention is the absolute gate. |
| Choice improves comment rate but lowers 5s completion >5% | **Reject.** The hook must earn the next segment. |
| Choice improves comment rate but lowers overall completion >5% | **Reject unless** the comment-rate gain is >3× the completion loss and the 5s completion holds. |
| Choice improves comment rate with completion impact ≤3% | **Allow.** Record the trade-off in `metric_conflict_resolution`. |
| Choice improves both comment rate and a retention metric | **Adopt.** Mark as best practice. |

Every trade-off must be recorded:

```
metric_conflict_resolution:
  - decision: "保留 payoff 后的对抗型落点"
    retention_impact: "overall_completion -2%（预估）"
    comment_impact: "comment_rate +4%（预估）"
    verdict: allowed
    reason: "5s completion 不变，overall 损失在 3% 阈值内"
```

## Hook-to-metric mapping

| Hook type | Best for | Risk |
| --- | --- | --- |
| Result-first | 3s retention, 5s completion | Must deliver proof quickly or 5s drops. |
| Pain-point | 3s retention | Can feel manipulative if not followed by real value. |
| Contrarian claim | 3s retention, overall completion | Needs strong evidence or audience bails at 30–60s. |
| Suspense question | overall completion | Requires disciplined loop closure. |
| Data shock | 3s retention | Must explain relevance within 15s. |
| Visual contrast | 3s retention | Needs matching B-roll/shot plan. |

## Segment rhythm targets

Use the target duration to derive segment boundaries:

| Act | Share of duration | Key metric job |
| --- | --- | --- |
| Open | 10% | 3s retention + 5s completion |
| Body segment 1 | ~25% | overall completion launch |
| Body segment 2 | ~25% | retention valley rescue |
| Body segment 3 | ~20% | payoff build |
| Close | 15% | completion-to-action |
| Post | 5% | follow/series conversion |

Each body segment should be 2–3 minutes max; shorter if the platform is faster (douyin/wechat).

## Duration-vs-detail arbitration

Target duration is enforced at the beat map, never inside a scene. If the draft runs long:

- Drop or merge a beat, or compress a 过渡 / `compressed_fact` paragraph.
- Never flatten a contracted slow scene to fit the clock. Its `target_chars` is the contracted
  scene budget — it must be spent on scene work (bodies, objects, sound, decomposed action),
  not treated as a ceiling that justifies compression.
- "怕超时长" is never a valid reason to skip, shrink, or defer scene detail. Over-duration is
  fixed by re-planning the beat map and re-validating, not by thinning a contracted scene.

## Density target

- Every paragraph lock declares a `new_contribution`: what the viewer newly learns in this
  paragraph — a fact, relationship, or causal chain. "Feeling X more deeply" does not count.
  Contracted slow-scene dwell paragraphs and close paragraphs may declare `dwell:<scene_id>`
  or `payoff` instead.
- No two body paragraphs share the same meaning (declared in the confirmed outline, re-checked
  in the meaning map at audit). Each judgment is stated once in the whole script.
- Fact budget: `source_claims ≥ target_duration_seconds × 4.5 ÷ 250`. If supply falls short,
  shorten the duration or return upstream for more material — never dilute by restating
  judgments.
- Each paragraph must pass the **so what?** test.
- Sentence length mix: ~60% short (<15 chars), ~30% medium, ~10% punch.

## Stop if

- `primary_metric` is missing.
- The chosen hook type does not match the primary metric.
- A segment exceeds 3 minutes without a pattern interrupt.
- The opening cannot deliver concrete value within 15 seconds.
- `target_comment_rate` is set but `comment_strategy` is missing or `none`.
- A comment-optimizing decision violates the retention priority in **Retention vs. comment arbitration**.
- Any body paragraph fails the **so what?** test or contains only restated information.
