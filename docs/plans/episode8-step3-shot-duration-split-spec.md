# Spec: direct_script 模式下单镜头 ≤ 8 秒，图文对齐

## Problem

在 direct_script 模式下：
- 没有旁白/对白音频，镜头时长由 `storyboards.duration` 决定（默认 10 秒）。
- 一个分镜常常覆盖一大段原文，只有一张图，导致单张图片停留超过 8 秒，用户感到无趣。
- 图片数量和“解说/原文”长度不匹配，画面和文本对不上。

## Goal

1. direct_script 模式下，每个镜头合成时长 ≤ 8 秒。
2. 如果原文段落较长，自动拆成多个分镜，每个分镜对应更短的文本和一张独立图片。
3. 保持精稿直出的语义：不删改原文，只是按节奏切分呈现。

## Scope

- 只改 direct_script 模式的分镜生成与时长控制。
- 不动 story_rewrite 模式（有旁白/对白音频，时长由音频决定）。
- 不动图片生成、合成、BGM/SFX 选择逻辑。

## Context

- direct_script 的分镜由 `storyboard_breaker_direct_script` agent 生成：`backend/src/agents/index.ts:272`。
- 该 agent 的 tools 在 `backend/src/agents/tools/storyboard-tools.ts`。
- 当前 `storyboards.duration` 默认 10 秒：`backend/src/db/schema.ts:153`。
- `ffmpeg-compose.ts:363-369` 里，`audioDuration = 0` 时 `requiredDuration = baseDuration = sb.duration || 10`。
- 已有 auto-split 能力：`backend/src/routes/storyboards.ts:381-526` 可按文本长度拆分 storyboard。

## Approach

### 1. 数据层：默认时长改为 8 秒

- `backend/src/db/schema.ts`：
  - `duration: integer('duration').default(8)`（从 10 改为 8）。
- `backend/src/services/ffmpeg-compose.ts`：
  - 兜底 `baseDuration = sb.duration || 8`。
- 前端 `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`：
  - fallback `sb.duration || 8`。

### 2. direct_script breaker：按 8 秒可读长度切分原文

修改 `storyboard_breaker_direct_script` agent（`backend/src/agents/index.ts` 和对应 tools）：

- 输入：精稿原文（`scriptContent`）。
- 规则：
  - 先按自然段落/场景拆成初始分镜。
  - 对每个初始分镜，估算朗读/阅读时长（中文字符按 4–5 字/秒估算）。
  - 如果某段文字预估时长 > 8 秒，按句子或 8 秒边界继续拆分成多个子分镜。
  - 每个子分镜保留完整原文片段（不改写），设置 `duration` ≤ 8。
- 输出：生成多个 `storyboards` 行，每个对应 ≤ 8 秒的呈现单元。

示例：
- 原文 180 字，预估 36 秒 → 拆成 5 个分镜（8+8+8+8+4 秒）。
- 每个分镜一段原文，各自一张图。

### 3. 复用或扩展 auto-split

- 如果 breaker 拆分不够细，在 `backend/src/routes/storyboards.ts` 的 auto-split 入口增加：
  - `maxDurationSeconds` 参数（默认 8）。
  - 根据 `maxDurationSeconds` 和预估阅读速度拆分文本。
- direct_script 模式下，可以在合成前（`compose.storyboard`）检查：
  - 若 `sb.duration > 8`，调用 auto-split 拆成多个分镜，再为每个新分镜生成图片。
  - 但更好的做法是在 breaker 阶段就拆分完毕，避免合成时再次调度。

### 4. 图片生成与合成顺序

- breaker 输出更多分镜后，原有 auto-pipeline 会为每个分镜调度 `image.generate`。
- 每个分镜独立合成，时长 ≤ 8 秒。
- 集合并并时保持顺序。

## Verification

1. 导入一段 200 字精稿，生成 direct_script episode。
2. 检查 `storyboards` 表：每个 `duration` ≤ 8。
3. 合成后打开视频，单张图片停留不超过 8 秒。
4. 分镜数量 > 原始段落数量，每个分镜对应一段较短原文。
5. `npm run typecheck` 通过。

## Risks

- 拆分后分镜数增加，图片生成数量和费用上升。
- 某些短镜头（< 2 秒）可能切换过快；可设置下限 3 秒。
- 需要确保 `storyboard_breaker_direct_script` 不丢失原文顺序。

## Out of scope

- story_rewrite 模式的时长控制（由旁白音频决定）。
- BGM/SFX 选择优化。
- 显示音频素材索引。
