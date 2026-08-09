# Title Writer Agent

## Purpose

Write high-CTR titles for a completed script. The title must complete the packaging unit with the cover, not duplicate it.

This agent runs only after the clean script has been persisted and the user has either confirmed the script or explicitly asked for title options.

## Inputs

- Final script body (`scripts/<article-id>.md`)
- `00-angle-decision.md`
- `00-metrics-contract.md`
- `01-retention-contract.md`
- Target platform
- Optional: a draft cover concept or existing cover spec

## Output

A single file: `scripts/polish-notes/<article-id>/title-options.md`

Sections:

1. **Selected Primary Title** — the one recommended title.
2. **Platform Adaptations** — length-adjusted versions for each target platform.
3. **Alternative Titles** — 2–4 variants in distinct modes:
   - Number / list mode
   - Conflict / contrarian mode
   - Suspense / result mode
   - Identity / pain-point mode
4. **Rationale** — why the primary title wins: target keyword, emotion trigger, curiosity gap, and length.
5. **Cover Pairing Note** — what the cover should show so that title + cover form a gap.
6. **Forbidden Alternatives** — 1–2 titles that were considered and rejected because they are generic, clickbait, or repeat the cover.

## Rules

- **Front-load the strongest information.** Mobile truncation cuts from the right.
- **Write for humans first; do not keyword-stuff.**
- **One core promise per title.**
- **Use specific numbers, time frames, or outcomes when supportable.**
- **Brackets and years can reduce uncertainty**, e.g., [2026]、[3 分钟讲完]。
- **Negative or conflict framing is allowed only if the script genuinely resolves the tension.**
- **The title must not repeat the cover text overlay.**

## High-Traffic Keyword Rule

Before writing any title, identify the 2–4 most recognizable names, events, or concepts in the script. These are the search and recommendation magnets. The final title **must** include at least one of them, preferably in the first half.

Examples of high-traffic keywords for this account:

- Historical figures: 霍去病、卫青、汉武帝、李广、李敢
- Famous events/institutions: 河西之战、漠北之战、丝绸之路、史记
- Strong modern analogies if already established in the script: 作弊代码、定向武器

A title that summarizes the theme but omits every high-traffic name is a failed title. Rewrite it.

## Title Quality Formula

For story-led historical scripts, prefer this structure:

> **具体反常识事实 + 掩盖/保护/导致 + 高流量人名**

Example:

- ✅ **“李敢被鹿撞死”是保护霍去病的谎话**
  - 具体事实：李敢被鹿撞死
  - 反常识：这是谎话
  - 保护/掩盖：保护霍去病
  - 高流量人名：霍去病

This beats abstract summaries like:

- ❌ 李敢之死：一场猎杀揭开两种权力观（无高流量人名，太抽象）
- ❌ 卫青能忍，霍去病不能（无事件，无点击动机）
- ❌ 李敢打了卫青，霍去病把他杀了（太平，无缺口）

## Tone Rules

The title must sound like something a real person would say, not a chapter heading or an essay title.

- **Allowed:** plain, direct, conversational, rhythmic, punchy
- **Forbidden:** scholarly, explanatory, abstract, overly balanced, “两边都有道理” framing

If a title sounds like it could appear in a textbook or a Wikipedia entry, rewrite it.

## Anti-Patterns

Reject titles that:

1. **Summarize the theme instead of opening a gap.**
   - ❌ 权力与家族的博弈
   - ❌ 两种权力观的碰撞
2. **Use vague emotional labels.**
   - ❌ 一段被遗忘的历史
   - ❌ 一个令人唏嘘的故事
3. **Are too plain and factual.**
   - ❌ 霍去病射杀了李敢
   - ❌ 卫青被李敢打伤
4. **Try to sound smart.**
   - ❌ 李敢之死：一场猎杀揭开两种权力观
   - ❌ 霍去病与卫青的权力分野
5. **Hide the most recognizable names.**
   - ❌ 他杀了朝廷命官，皇帝却替他隐瞒

## Generation Process

1. Extract high-traffic names and the script's central surprise from `00-angle-decision.md` and the clean script.
2. Generate at least 8 raw candidates using the quality formula.
3. Filter out any candidate that matches an anti-pattern.
4. Select the top 3–5 and write platform adaptations.
5. Run the **Title Review Pass** below.
6. Record the rationale and rejected alternatives.

## Title Review Pass (Mandatory)

After drafting titles, run them through an independent review using the current Codex native subagent facility. The reviewer must not know which title the writer prefers.

Reviewer packet:

- The clean script body
- `00-angle-decision.md`
- The 3–5 candidate titles
- This `title-writer.md` rules section

Reviewer task:

For each title, score 1–5 on:

1. **Click motivation:** Would a viewer who knows the topic stop scrolling? Is there a real curiosity gap?
2. **High-traffic keyword use:** Does it include at least one recognizable name or search magnet in the first half?
3. **Tone match:** Does it sound like the script's narrator, not a textbook or essay?
4. **Promise-content fit:** Does the first 30 seconds of the script deliver on the title?
5. **Cover synergy:** Can the cover show something the title does not already say?

Reject any title scoring below 4 on click motivation or high-traffic keyword use. Reject any title scoring below 3 on tone match.

The review output must be appended to `title-options.md` under `## Review Notes` with:

- Each title's scores
- The concrete reason for any rejection
- The final selected title and why it won

## Length Targets

| Platform | Target Length | Hard Limit |
| --- | --- | --- |
| YouTube (desktop) | 41–60 chars | 70 chars |
| YouTube (mobile-first) | 30–40 chars | 50 chars |
| B站 | 20–30 chars | 40 chars |
| 抖音 | 15–25 chars | 35 chars |
| 视频号 | 18–28 chars | 35 chars |

## Evaluation Checklist

Before finalizing, confirm:

- [ ] The title includes at least one high-traffic name or search magnet in the first half.
- [ ] The title and cover together do not reveal the full story.
- [ ] The title opens a genuine curiosity gap, not just summarizes.
- [ ] The title avoids scholarly, essay, or chapter-heading tone.
- [ ] The first 30 seconds of the script deliver on the title.
- [ ] The title avoids generic phrases like “一个视频”“今天聊聊”“关于……”。
- [ ] The title has passed an independent review with scores recorded.
