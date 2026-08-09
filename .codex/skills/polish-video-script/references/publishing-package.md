# Publishing Package

`07-publishing-package.json` is the handoff contract from the script factory to the video factory
and platform publishers. It is JSON so the factory can validate it, store the complete object in
the episode record, preserve extension fields, and fingerprint the exact package used for
production.

## Source Mapping

| Field | Source | Rule |
| --- | --- | --- |
| `title` | Confirmed title in `06-title.md` and script frontmatter | Must match exactly. |
| `opening_hook` | Opening audit and the first paid beat | A concise, specific social hook that creates a question without inventing a claim. |
| `cliffhanger` | Ending audit and the final unpaid relation/question | A forward-facing unresolved question, not generic "敬请期待". |
| `creative_brief` | `02-creative-plan.md` and `03-outline.md` | Keep it extensible; retain stance, audience, promise, source anchor, emotional arc/gap, and behavioral payoff. |
| `cover_design.main_title` | Cover copy derived from the title promise and creative plan | At most 8 Chinese characters; do not repeat the full video title. |
| `cover_design.sub_title` | Optional cover support line | At most 4 Chinese characters. |
| `cover_design.ai_prompt` | Cover designer pass | Describe the visual scene in English and explicitly require no text, logo, watermark, or typography. |
| `chapter_hooks` | `03-outline.md` chapter structure, one hook per narrative chapter | Optional top chapter-bar hooks. `label`: at most 12 Chinese characters, written as a suspense hook (an unanswered question or cost), not a dry catalog name; `anchor`: optional, the opening characters of the chapter's first narration sentence. Count must equal the narrative sequence count of the episode; the factory fails on mismatch. |

## Contract

```json
{
  "schema_version": "dharma-publishing-package/v1",
  "title": "与 06-title.md 完全一致的标题",
  "opening_hook": "让观众立刻感到代价，并留下一个未回答的问题。",
  "cliffhanger": "让观众想知道下一步如何解决，而不是简单宣布下集再见。",
  "creative_brief": {
    "primary_genre": "historical_dilemma",
    "structure_shell": "story_progression",
    "stance": "作者立场",
    "central_question": "观众真正想解决的问题",
    "primary_promise": "视频承诺交付的答案",
    "source_anchor": "历史材料或主题来源",
    "target_audience": "具体受众",
    "emotional_arc": ["进入情绪", "中段转折", "最终释放"],
    "emotional_gap": "答案为什么必须延后到后段",
    "behavioral_payoff": ["观众看完可以执行的动作"]
  },
  "cover_design": {
    "main_title": "不必燃烧",
    "sub_title": "可以报恩",
    "kicker": "主题锚点",
    "layout": "人物与一个核心冲突物件形成清晰前中后景",
    "rationale": "封面如何补充标题而不泄露完整答案",
    "ai_prompt": "A cinematic historical scene ... no text, no letters, no subtitles, no logo, no watermark, no typography."
  },
  "chapter_hooks": [
    { "label": "他为何敢违诏出兵", "anchor": "公元前119年春" },
    { "label": "补给线被切断之后" }
  ]
}
```

## Production Boundary

The script stage produces the package and editable cover specification. It does not render cover
PNGs. `remotion-history-factory` receives the final script and package, writes the package into
the episode database, schedules both `4:3` and `3:4` cover jobs, and stores the generated cover
URLs beside the hooks and video URL.

The publisher then runs its default `db` provider with an episode id or frontend episode URL. It
reads `title`, `opening_hook`, `cliffhanger`, `video_url`, `cover_image_4x3_url`, and
`cover_image_3x4_url` from the database. It may normalize image dimensions for a platform, but it
must not create new copy or fall back to a script file.

## Validation

- Parse the file as JSON and keep the exact confirmed title.
- Keep all required strings and objects non-empty.
- Make both hooks true to the final script and useful as a description on their own.
- Keep cover copy short enough for mobile previews and the image prompt free of rendered text.
- `chapter_hooks` is optional; when present, keep every label a suspense hook within 12 Chinese
  characters, and keep the hook count equal to the episode's narrative sequence count.
- Preserve project-specific fields at the package root or inside `creative_brief`; the factory
  stores extension fields with the package instead of discarding them.
