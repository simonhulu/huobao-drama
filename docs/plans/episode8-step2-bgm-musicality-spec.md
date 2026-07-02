# Spec: 提升 BGM 音乐性，避免简单打击音效

## Problem

当前 episode 8 的背景音听起来像“咚”一类的简单音效，缺乏氛围和旋律，无法有效烘托情绪。

注意：用户明确不要“人声歌曲/歌词”，而是希望 BGM 是更“音乐化”的氛围乐（弦乐、合唱哼鸣、电影感主题、氛围铺垫）。

## Goal

1. BGM 选择/生成优先出“氛围乐/电影感音乐”，而不是短促打击音效。
2. 保留无歌词（instrumental / choir humming）。
3. 用户能感知 BGM 来源，并可在需要时调整。

## Scope

- 只改 BGM 的 prompt 构建和本地曲库评分，不动 SFX/Ambient 选择逻辑。
- 不改 MiniMax 适配器的 `is_instrumental: true`（保持无歌词）。

## Context

- `backend/src/services/audio-profile.ts` 构建 BGM prompt，当前会默认补一句 `no vocals`，但没有强调“音乐性”。
- `backend/src/services/adapters/minimax-music.ts:38` 固定 `is_instrumental: true`。
- `backend/src/services/local-bgm-library.ts` 按情绪 bucket 选本地音乐。
- `backend/src/services/free-audio-packs.ts` 已包含 `fantasy-choir`、`signature-choirs`、`cinematic` 等氛围包。
- 当前 BGM prompt 容易偏向“sound effect”描述，导致生成/匹配到短音效。

## Approach

### 1. BGM prompt 强制音乐化

在 `backend/src/services/audio-profile.ts`：
- 当生成 BGM prompt 时，在描述后追加固定引导语：
  - `"cinematic background music, atmospheric orchestral theme, no vocals, no short sound effects"`
- 如果已有 `no vocals`，保留；如果没有，补上。
- 避免 prompt 里出现 `sound effect`、`hit`、`impact`、`dong` 等偏向短音效的词。

### 2. 本地曲库标签与评分

在 `backend/src/services/local-bgm-library.ts` / `backend/src/services/free-audio-packs.ts`：
- 给每个音频文件/包打标签：`musical`、`atmospheric`、`orchestral`、`choir`、`cinematic`、`percussion-only` 等。
- 评分时，BGM 请求优先匹配 `musical/atmospheric/orchestral/choir`，降级 `percussion-only`。
- 至少保证不会把纯打击音效选为 BGM。

### 3. 生成与本地 fallback 一致

- MiniMax 生成：通过 prompt 控制出氛围乐。
- 本地 fallback：通过标签评分优先选氛围乐。
- 结果：无论走生成还是本地，BGM 都是音乐化的。

### 4. 可观测性（配合 Step 1）

- 前端详情面板已显示 BGM 素材索引，用户能看到 source / tags，确认不是短音效。

## Verification

1. 重新生成/合成一个镜头后，BGM 听起来是持续的氛围乐，不是“咚”一声。
2. `/library/music` 中的 BGM 条目 tags 包含 `musical` / `atmospheric` 等。
3. 前端 BGM 详情显示 source 和 tags，能确认类型。
4. `npm run typecheck` 通过。

## Risks

- 氛围乐可能在某些紧张场景下情绪不够强烈；需要保留按情绪 bucket 匹配。
- 本地曲库如果缺少某类情绪的氛围乐，可能 fallback 到次优选择。

## Out of scope

- 人声歌曲 / 歌词 BGM。
- SFX / Ambient 选择算法修改。
- 8 秒镜头拆分。
