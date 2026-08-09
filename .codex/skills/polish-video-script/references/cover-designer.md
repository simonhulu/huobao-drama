# Cover Designer Agent

## Purpose

Design a high-CTR video cover (thumbnail) for a completed script. The output is a design specification plus an image-generation prompt, not a rendered image.

This agent runs only after the clean script has been persisted and the user has either confirmed the script or explicitly asked for cover design.

## Inputs

- Final script body (`scripts/<article-id>.md`)
- `00-angle-decision.md`
- `00-metrics-contract.md`
- `01-retention-contract.md`
- Target platform and aspect ratio
- Selected title from `title-options.md`

## Output

A single file: `scripts/polish-notes/<article-id>/cover-spec.md`

Sections:

1. **Platform & Ratio** — e.g., 抖音 9:16 (1080×1920), B站 16:9, YouTube 16:9.
2. **Layout Template** — one of: 左文右图 / 中心对称 / 三联拼图 / 对比分割 / 人物大字 / 统一色块.
3. **One-Sentence Hook** — the curiosity gap this cover must create.
4. **Subject** — face / object / scene / before-after. State the single focal point.
5. **Expression / Action** — if a face, name the exact emotion and gaze direction.
6. **Main Title on Cover** — max 8 Chinese characters. Must not repeat the video title word-for-word.
7. **Subtitle / Tag** — optional, max 4 characters, e.g., “3 分钟”“真相”“揭秘”.
8. **Color Palette** — 2–3 colors: background, subject, accent. Include contrast reasoning and hex values.
9. **Typography** — font style, main title size (px or relative height), subtitle size, stroke/shadow treatment.
10. **Composition Notes** — rule of thirds, safe zones, negative space, element placement, mobile-safe zones.
11. **Mobile Readability Check** — describe what remains legible at 160–320 px width.
12. **Image Generation Prompt** — a single English prompt suitable for Midjourney / Flux / ComfyUI. Include style, lighting, subject, text content, color, and composition.
13. **Pairing Note** — how this cover complements the selected title without repeating it.

## Platform-Specific Rules

### 抖音 (Douyin)

- **Canvas size:** 1080×1920 px (9:16). Design for the center 1080×1440 px safe zone; Douyin crops to 3:4 in the feed.
- **Dead zones:**
  - Top 0–200 px: system status bar + Douyin top nav.
  - Right edge 150 px: avatar, like, comment, share buttons.
  - Bottom 350 px: video caption, hashtags, music disc.
- **Main title:** ≤ 8 Chinese characters, bold sans-serif, height ≥ 1/3 of cover height. Add 2–4 px stroke or dark semi-transparent backing.
- **Subtitle:** ≤ 4 characters, size roughly 1/2 of main title.
- **Subject:** face or strong visual object occupying 60–70% of frame when face is used; otherwise one clear focal object.
- **Layout:** prefer 左文右图 (text left, image right), center-symmetric, or top-title-bottom-image.
- **Colors:** max 3 dominant colors. Use dark background + bright yellow/white text or high-warmth contrast. Saturation 70–85%. Contrast ratio ≥ 4.5:1.
- **File:** JPG/PNG, < 2MB.

### B站 / YouTube

- **Canvas size:** 1920×1080 px (16:9).
- **Dead zones:** bottom-right 15% for duration badge.
- **Main title:** ≤ 5 words or 8 Chinese characters, bold sans-serif, 60–80 pt at 1280×720 equivalent.
- **Subject:** face filling ~1/3 of frame, or one clear focal object.
- **Colors:** complementary pairs (yellow/violet, red/cyan, blue/orange), strong contrast, readable at 120 px width.

## Design Rules

- One dominant focal point. If the eye cannot land in 300 ms, redesign.
- 30–40% negative space around the subject.
- Text must be readable at mobile preview size. Test mentally at 120 px wide.
- Face should occupy 25–40% of the frame if used; expression must be genuine, not a stock scream.
- Use complementary high-contrast colors (e.g., yellow/violet, red/cyan, blue/orange).
- Do not repeat the video title text on the cover.
- The cover promise must match the first 30 seconds of the script.

## Anti-Patterns

- Cluttered multi-element scenes.
- Tiny or decorative text.
- Muted colors that blend into the platform interface.
- Stock photo feel.
- A cover that resolves the curiosity gap the title opens.
- Text placed in Douyin dead zones (top 200px, right 150px, bottom 350px).
- More than 8 Chinese characters in the main cover title.

## Generation Process

1. Read the selected title from `title-options.md`. The cover must add information the title does not already reveal.
2. Identify the single most clickable visual hook from the script: a face, an object, a moment of conflict, or a before/after.
3. Choose the layout template that fits the platform and the hook.
4. Define the cover text: main title ≤ 8 chars, subtitle ≤ 4 chars. Neither may repeat the video title verbatim.
5. Define the color palette (2–3 colors) and typography treatment.
6. Compose with platform safe zones in mind.
7. Run the **Cover Review Pass** below.
8. Output the image generation prompt in English.

## Cover Review Pass (Mandatory)

After drafting the cover spec, run it through an independent review using the current Codex native subagent facility. The reviewer must not know which layout the writer prefers.

Reviewer packet:

- The clean script body
- `00-angle-decision.md`
- `01-retention-contract.md`
- The selected title from `title-options.md`
- The drafted cover spec
- This `cover-designer.md` rules section

Reviewer task:

Score 1–5 on:

1. **Platform compliance:** Does the layout respect the target platform's safe zones, aspect ratio, and text limits?
2. **Curiosity gap:** Does the cover create a clear visual question that the video answers?
3. **Title synergy:** Does the cover add information the title does not already say?
4. **Mobile readability:** Would the main title and subject still read at thumbnail size?
5. **High-traffic keyword use:** Does the cover leverage recognizable faces, objects, or symbols?
6. **Color/contrast:** Is the palette high-contrast and platform-appropriate?

Reject any spec scoring below 4 on platform compliance or curiosity gap. Reject any spec scoring below 3 on mobile readability.

The review output must be appended to `cover-spec.md` under `## Review Notes` with:

- Each criterion's score
- The concrete reason for any rejection
- The final approved cover spec and why it won

## Evaluation Checklist

Before finalizing, confirm:

- [ ] The cover size and safe zones match the target platform.
- [ ] The main cover title has ≤ 8 Chinese characters (or ≤ 5 words in English).
- [ ] The subtitle/tag has ≤ 4 Chinese characters.
- [ ] The cover text does not repeat the video title verbatim.
- [ ] The subject occupies the correct proportion of the frame.
- [ ] Colors are high-contrast and limited to 2–3 dominant colors.
- [ ] No critical element falls inside platform dead zones.
- [ ] The cover has passed an independent review with scores recorded.
