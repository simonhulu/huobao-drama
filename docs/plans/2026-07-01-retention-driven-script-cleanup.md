# [System] 精稿导入时的留存驱动脚本清理

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 `direct_script` 成品稿导入流程中增加「留存驱动清理」模式，自动压缩铺垫、删除重复总结、合并列举、前置钩子，并可生成独立开头片段，从而提升完播率。

**Architecture:** 在现有 `cleanDirectScript` 基础上增加 `retention_mode` 与 `hook_style` 选项；新增 `retention-script-optimizer.ts` 服务负责 LLM 改写；改写结果写入 `episodes.content/script_content/openingHook`；`storyboard_breaker` 读取 `openingHook` 与 `retention_mode` 生成强钩子第一镜、紧凑分镜，并输出 `【快剪】` / `【对比】` / `【分屏】` / `【关键词叠加】` 视觉节奏标签。Phase 1 用多格漫画图 prompt 模拟画面节奏；Phase 2 扩展 `composition` 层实现真正的关键词叠加、多图快剪和分屏合成。

**Tech Stack:** TypeScript, Hono, Drizzle ORM, better-sqlite3, 现有 `direct-script-cleaner.ts` / `episode-splitter.ts` / `storyboard_breaker`。

---

## 背景与问题诊断

当前 `direct-script-cleaner.ts` 只做「去无关内容、去诱导话术」的消极清理，不做积极的节奏优化。导致成品稿导入后经常出现：

1. **开头铺垫过长**：大段背景、理由列举、定义解释堆在开头，前 6-10 秒没有钩子。
2. **中段信息罗列**：多个并列点（三条理由、四种手段、五个阶段）逐条展开，节奏拖沓。
3. **结尾重复总结**：结尾再次复述前文结论，没有新的落点或情绪上扬/下压。
4. **背景与主线断裂**：背景铺垫单独成段，中断核心冲突张力。
5. **缺少视觉节奏提示**：文案紧凑但分镜仍按常规叙事切，无法配合快剪、对比、分屏。

本次方案把平台反馈中的方法（悬念前置、冲突引爆、数据冲击、背景转对比、独立开头）沉淀为系统能力。

---

## 预期行为

导入脚本时，如果开启 `retention_mode: 'tight'`：

- 时长压缩目标：原文旁白时长 × 0.55-0.70。
- 结构目标：
  - 0-10s：钩子（悬念/冲突/数据三选一）
  - 10-30s：快速带过铺垫，点出核心冲突
  - 30-70s：主线推进，合并并列列举
  - 70-100s：利落结尾，不重复总结
- 视觉节奏：storyboard breaker 在相关镜头备注 `快剪` / `对比` / `分屏` / `关键词叠加`。

---

## Task 1: 扩展 `cleanDirectScript` 支持 retention 模式

**Files:**
- Modify: `backend/src/services/direct-script-cleaner.ts`
- Test: `backend/src/services/direct-script-cleaner.test.ts`（新建）

**Step 1: 增加选项类型**

```typescript
export type RetentionMode = 'standard' | 'tight'
export type HookStyle = 'suspense' | 'conflict' | 'data' | 'auto'

export interface CleanDirectScriptOptions {
  temperature?: number
  maxTokens?: number
  retentionMode?: RetentionMode
  hookStyle?: HookStyle
}
```

**Step 2: 根据 retentionMode 切换 system prompt**

```typescript
function buildSystemPrompt(options: CleanDirectScriptOptions): string {
  if (options.retentionMode === 'tight') {
    return `你是短视频 retention 编辑，专门优化知识类/历史类解说稿的完播率。
优化原则：
1. 开头必须前 10 秒出钩子：用悬念、冲突或数据反差直接点出核心矛盾，禁止先铺陈背景或理由。
2. 压缩铺垫：背景信息只保留理解主线所必需的最小份额；大段背景改为服务于主线的对比（繁荣→衰败、支持→反对）。
3. 合并列举：三条理由、四种手段等并列内容，合并成 1-2 句紧凑表述，不再逐条展开。
4. 删除重复总结：结尾只保留最有力量的收束句，禁止复述前文结论。
5. 保留核心信息、关键数据、直接引语、动作和空间转换；不编造原文没有的内容。
6. 输出只包含改写后的完整文稿，不要添加说明、总结或分段标题。`
  }

  return `你是纪录片/知识类视频编辑，擅长对已有解说稿做清理和精简。...`
}
```

**Step 3: 在 user prompt 里注入 hook style 偏好**

```typescript
function buildUserPrompt(script: string, options: CleanDirectScriptOptions): string {
  const hookHint = options.hookStyle && options.hookStyle !== 'auto'
    ? `\n优先使用「${options.hookStyle === 'suspense' ? '悬念前置' : options.hookStyle === 'conflict' ? '冲突引爆' : '数据冲击'}」风格开头。`
    : ''
  return `请清理并优化以下解说稿：${hookHint}\n\n${script}`
}
```

**Step 4: 更新函数签名与实现**

```typescript
export async function cleanDirectScript(
  script: string,
  options: CleanDirectScriptOptions = {},
): Promise<string> {
  if (!script.trim()) return script

  const systemPrompt = buildSystemPrompt(options)
  const userPrompt = buildUserPrompt(script, options)

  const cleaned = await callTextModel(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens,
    },
  )

  return cleaned || script
}
```

**Step 5: 写基础测试**

Create `backend/src/services/direct-script-cleaner.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { cleanDirectScript } from './direct-script-cleaner.js'

describe('cleanDirectScript', () => {
  it('returns empty string for empty input', async () => {
    const result = await cleanDirectScript('')
    assert.equal(result, '')
  })

  it('returns unchanged in standard mode', async () => {
    const script = '大臣们反对万历开矿。'
    const result = await cleanDirectScript(script, { retentionMode: 'standard' })
    assert.ok(result.length >= script.length * 0.5)
  })
})
```

**Step 6: 运行测试**

Run:
```bash
cd /Users/zhangshijie/Documents/workspace/huobao-drama/backend
npx tsx --test src/services/direct-script-cleaner.test.ts
```

Expected: PASS（标准模式测试通过；tight 模式依赖 LLM，先占位）。

---

## Task 2: 新增 `retention-script-optimizer.ts` 服务

**Files:**
- Create: `backend/src/services/retention-script-optimizer.ts`
- Test: `backend/src/services/retention-script-optimizer.test.ts`

这个服务负责更结构化的改写：输出改写后正文 + 可选独立开头。

**Step 1: 定义输出类型**

```typescript
export interface RetentionOptimizationResult {
  content: string
  openingHook?: string
  hookStyle: HookStyle
  estimatedDurationSeconds: number
  changes: string[]
}

export interface RetentionOptimizerOptions {
  retentionMode?: RetentionMode
  hookStyle?: HookStyle
  targetDurationSeconds?: number
}
```

**Step 2: 实现核心函数**

```typescript
export async function optimizeScriptForRetention(
  script: string,
  options: RetentionOptimizerOptions = {},
): Promise<RetentionOptimizationResult> {
  const retentionMode = options.retentionMode ?? 'tight'
  const hookStyle = options.hookStyle ?? 'auto'

  if (retentionMode === 'standard') {
    return {
      content: script,
      hookStyle,
      estimatedDurationSeconds: estimateDurationSeconds(script),
      changes: [],
    }
  }

  const optimized = await cleanDirectScript(script, {
    retentionMode,
    hookStyle,
    temperature: 0.4,
  })

  const openingHook = extractOpeningHook(optimized, hookStyle)
  const changes = summarizeChanges(script, optimized)

  return {
    content: optimized,
    openingHook,
    hookStyle,
    estimatedDurationSeconds: estimateDurationSeconds(optimized),
    changes,
  }
}

function estimateDurationSeconds(script: string): number {
  // 按中文语速 ~250 字/分钟，再乘以短视频节奏系数
  return Math.ceil((script.length / 250) * 60 * 0.9)
}

function extractOpeningHook(optimized: string, style: HookStyle): string | undefined {
  const firstSentence = optimized.split(/[。！？\n]/, 1)[0]
  if (!firstSentence) return undefined
  if (style === 'auto') {
    return firstSentence.length > 60 ? firstSentence.slice(0, 60) + '……' : firstSentence
  }
  return firstSentence
}

function summarizeChanges(original: string, optimized: string): string[] {
  const changes: string[] = []
  if (optimized.length < original.length * 0.8) {
    changes.push(`字数压缩 ${original.length} → ${optimized.length}`)
  }
  return changes
}
```

**Step 3: 测试**

Create `backend/src/services/retention-script-optimizer.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { optimizeScriptForRetention } from './retention-script-optimizer.js'

describe('optimizeScriptForRetention', () => {
  it('returns unchanged in standard mode', async () => {
    const script = '大臣们反对万历开矿。真实原因是利益冲突。'
    const result = await optimizeScriptForRetention(script, { retentionMode: 'standard' })
    assert.equal(result.content, script)
    assert.equal(result.changes.length, 0)
  })

  it('extracts opening hook in tight mode', async () => {
    const script = '万历皇帝要开矿，大臣们集体反对。他们怕的不是动乱，而是钱进的不是国库。'
    const result = await optimizeScriptForRetention(script, { retentionMode: 'tight', hookStyle: 'suspense' })
    assert.ok(result.openingHook)
    assert.ok(result.estimatedDurationSeconds > 0)
  })
})
```

**Step 4: 运行测试**

Run:
```bash
npx tsx --test src/services/retention-script-optimizer.test.ts
```

Expected: PASS

---

## Task 3: 在导入 API 中暴露 retention 选项

**Files:**
- Modify: `backend/src/routes/dramas.ts` 的 `POST /:id/import-script`
- Modify: `backend/src/routes/scripts.ts` 的 `POST /scripts/clean`

**Step 1: dramas import-script 支持 retention 参数**

在 `backend/src/routes/dramas.ts:324-368` 区域修改：

```typescript
const shouldClean = body.clean === true || body.enable_clean === true
const retentionMode = body.retention_mode === 'tight' ? 'tight' : 'standard'
const hookStyle = ['suspense', 'conflict', 'data'].includes(body.hook_style)
  ? body.hook_style
  : 'auto'

if (shouldClean) {
  try {
    scriptContent = await cleanDirectScript(scriptContent, {
      retentionMode,
      hookStyle,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '清理解说稿失败'
    return serverError(c, message)
  }
}

let segments: DirectScriptSegment[]
const durationPresetId = body.duration_preset
if (durationPresetId) {
  segments = await smartSplitDirectScript(scriptContent, {
    dramaTitle: drama.title,
    durationPresetId,
    style: body.split_style === 'ai_manga_drama' ? 'ai_manga_drama' : 'default',
    pacingMode: body.pacing_mode || 'standard',
  })
} else {
  segments = [{
    title: body.title || '导入集',
    content: scriptContent,
    summary: body.description || '',
    openingHook: '',
    cliffhangerHook: '',
    estimatedDurationSeconds: 0,
  }]
}
```

**Step 2: 如果 retention 开启，为每段生成优化结果并写入 openingHook**

在 segments 循环之前插入：

```typescript
import { optimizeScriptForRetention } from '../services/retention-script-optimizer.js'

for (let i = 0; i < segments.length; i++) {
  const segment = segments[i]
  let segmentContent = segment.content
  let openingHook = segment.openingHook

  if (retentionMode === 'tight') {
    const optimized = await optimizeScriptForRetention(segmentContent, {
      retentionMode,
      hookStyle,
      targetDurationSeconds: segment.estimatedDurationSeconds || undefined,
    })
    segmentContent = optimized.content
    openingHook = optimized.openingHook || segment.openingHook
  }

  // 用 segmentContent / openingHook 写入 episodes
}
```

**Step 3: scripts/clean 也支持 retention 参数**

```typescript
app.post('/clean', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const content = String(body.content || '').trim()
  if (!content) return badRequest(c, 'content is required')

  try {
    const retentionMode = body.retention_mode === 'tight' ? 'tight' : 'standard'
    const hookStyle = ['suspense', 'conflict', 'data'].includes(body.hook_style)
      ? body.hook_style
      : 'auto'
    const cleaned = await cleanDirectScript(content, { retentionMode, hookStyle })
    return success(c, {
      original_length: content.length,
      cleaned_length: cleaned.length,
      retention_mode: retentionMode,
      hook_style: hookStyle,
      content: cleaned,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '清理解说稿失败'
    return c.json({ code: 500, message }, 500)
  }
})
```

---

## Task 4: 让 storyboard breaker 识别 openingHook 与视觉节奏

**Files:**
- Modify: `backend/src/agents/index.ts` 中的 `storyboard_breaker_direct_script` prompt
- Modify: `backend/src/agents/tools/storyboard-tools.ts`（如需要传递 openingHook）

**Step 1: 在 breaker prompt 中加入 retention 上下文**

在 `storyboard_breaker_direct_script` 的 instructions 中增加：

```markdown
- 第一镜必须强化 `openingHook`：前 3 秒画面就要出现最强冲突/悬念/数据，配合关键词叠加。
- 如果文案是压缩后的紧凑版本，分镜要积极：每出现一个新动作、新对象、新空间就拆镜；同一事件内的多个连续画面可以让 `image_prompt` 描述为多格漫画式组合图。
- 视觉节奏标注：在 `description` 或 `image_prompt` 中适时使用以下标签：
  - `【快剪】`：快速切换多个相关画面（如大臣奏疏、矿场、争执）。
  - `【对比】`：左右/上下分屏展示对立双方（如百姓缴税 vs 皇帝内库）。
  - `【分屏】`：同一画面内并置两个场景。
  - `【关键词叠加】`：画面叠加大字关键词（如“利益冲突”“私库”）。
- 禁止把“叙事任务”“营造氛围”“画面推镜”等元描述单独成镜。
```

**Step 2: 确保 breaker 能读取 `openingHook`**

在生成 breaker agent 时，从 `episodes` 读取 `openingHook` 并注入工具上下文。当前 `storyboard-tools.ts` 已经基于 `episodeId` 读取 episode，可以在 `read_storyboards` 或 `generate_storyboards` 中附加 `openingHook`。

---

## Task 5: 可选 — 独立开头片段

**Files:**
- Create: `backend/src/db/migrations/...` 或直接在 `episodes` 表扩展
- Modify: `backend/src/db/schema.ts`

用户问「要不要单独制作开头？」建议先做**轻量版**：把 `openingHook` 作为第一镜的核心旁白/画面提示，不拆表。如果效果验证后需要更长的独立开头（3-10 秒可复用），再做独立表。

**轻量版实现（推荐先落地）：**

- `episodes.openingHook` 已存在。
- 在 `storyboard_breaker` 中，如果 `openingHook` 非空，第一镜专门承载它，时长控制在 3-8 秒，视觉标注 `【关键词叠加】` + `【快剪】`。

**独立表版（未来扩展）：**

```typescript
export const episodeOpenings = sqliteTable('episode_openings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  style: text('style').notNull(), // suspense / conflict / data
  content: text('content').notNull(),
  visualPrompt: text('visual_prompt'),
  durationSeconds: integer('duration_seconds').default(0),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})
```

本次方案先不落独立表，在 plan 中标记为 Phase 2。

---

## Task 6: 前端导入表单增加 retention 选项

**Files:**
- Modify: 前端导入脚本页面（需先定位文件路径）

由于当前 focus 在后端，前端改动可在后端验证后补充。Plan 中先标记：

- 在 `POST /dramas/:id/import-script` 的调用处增加：
  - `retention_mode`: `'standard' | 'tight'` 下拉
  - `hook_style`: `'auto' | 'suspense' | 'conflict' | 'data'` 下拉
  - `clean`: true（必须同时开启清理才生效）

---

## Task 5: 画面节奏实施 — 把平台视觉建议落到合成层

当前 `composition` 层只支持：单张底图/视频 + 字幕 + 标题卡 + 颗粒暗角。**真正的快剪、分屏、关键词叠加需要扩展合成层**。

### 5.1 当前可立即做的：用多格图 prompt 模拟视觉节奏

`storyboard_breaker` 已经允许 `image_prompt` 描述「漫画式多格组合图」。在 retention 模式下，让 breaker 直接输出带视觉标签的 prompt：

**视觉标签规范（写入 `description` 或 `image_prompt` 开头）**

| 平台建议 | 标签 | image_prompt 写法示例 |
|---|---|---|
| 皇帝朱批特写 + 大臣争执快剪 | `【快剪】` | 漫画式三格组合图：左上皇帝朱批特写、右上大臣争执、下方红色印章，快速剪辑感 |
| 百姓缴税 vs 皇帝内库金银 | `【对比】` | 左右对比构图：左侧百姓缴税队伍、右侧皇帝内库堆积金银，中间用明暗分割 |
| 霸占/敲诈/设卡三个关键场景 | `【分屏】` | 三格分屏漫画：左格太监霸占民矿、中格敲诈富户、右格设卡收税 |
| 画面叠加“利益冲突”等关键词 | `【关键词叠加】` | 画面中央用粗体红色书法字叠加“利益冲突”，背景是大臣争执剪影 |

**修改 `storyboard_breaker_direct_script` prompt：**

在 `backend/src/agents/index.ts` 的 `storyboard_breaker_direct_script` instructions 中增加：

```markdown
- 第一镜必须承载 `openingHook`，并在 `image_prompt` 开头使用 `【关键词叠加】` + `【快剪】`。
- 遇到“压缩铺垫”段落，使用 `【快剪】`：多格漫画式组合图，快速闪过相关元素，不单独停留。
- 遇到“核心冲突”段落，使用 `【对比】`：左右/上下分屏展示对立双方。
- 遇到“并列手段/理由”段落，使用 `【分屏】`：同一画面内并置 2-4 个关键场景。
- 所有标签只作为画面提示词前缀，不影响 narration 内容。
```

### 5.2 必须扩展合成层才能真正实现的：多图快剪 / 分屏 / 关键词叠加

#### A. 关键词叠加（Keyword Overlay）

当前只有 `title` overlay（固定位置、固定大小）。需要新增 `keyword` overlay，支持：

- 任意位置（x, y）
- 任意字号、颜色、描边
- 出现时序（start / duration）
- 可动画（淡入、弹出）

**修改 `backend/src/services/composition/types.ts`：**

```typescript
export interface KeywordOverlay extends Overlay {
  kind: 'keyword'
  params: {
    text: string
    fontPath?: string
    fontSize: number
    fontColor: string
    strokeColor?: string
    strokeWidth?: number
    x: number | 'center' | 'left' | 'right'
    y: number | 'center' | 'top' | 'bottom'
    animation?: 'fade' | 'pop' | 'none'
  }
}
```

**修改 `backend/src/services/composition/renderer.ts`：**

在 `buildVideoFilter` 的 `for (const overlay of layer.overlays || [])` 中增加 `keyword` 分支，用 `drawtext` 实现。

#### B. 多图快剪（Fast Cut Sequence）

一个镜头内按时间切换多张图片。需要新增 `video.type: 'multi-image-sequence'`。

**修改 `backend/src/services/composition/types.ts`：**

```typescript
export interface MultiImageSequence {
  kind: 'multi-image-sequence'
  images: { filePath: string; duration: number }[]
}
```

**实现方式：**

FFmpeg 方案：用 `concat` demuxer 把多张图按指定时长拼成短视频，再作为 base video 输入。

简化方案（推荐 Phase 1）：让 AI 直接生成「漫画式多格组合图」，用 Ken Burns 在各格之间平移，模拟快剪感，不改动 video type。

#### C. 分屏 / 对比（Split Screen）

**方案 1（图片层，推荐 Phase 1）：** 让 `image_prompt` 直接描述左右/上下分屏构图，AI 生成一张图即可。

**方案 2（合成层，Phase 2）：** 生成两张图，用 FFmpeg `hstack` / `vstack` 拼接。

需要新增 video layer type：

```typescript
export interface SplitScreenVideoLayer extends Omit<VideoLayer, 'type'> {
  type: 'split-screen'
  layout: 'horizontal' | 'vertical'
  sources: { filePath: string; weight: number }[]
}
```

### 5.3 画面节奏与 BGM / 音效卡点

平台建议「加快剪辑、卡点音乐」。当前 BGM 是连续铺底。需要：

- 在 `bgm_prompt` 中标注节奏强度（`intense`, `pulsing`, `fast-cut`）。
- 在 `music-generation.ts` 或 `audio-profile.ts` 中，识别 `【快剪】` / `【对比】` 标签，选择更高能量曲线或更密集的鼓点 BGM。
- 长期：按镜头切分点做 BGM 节拍对齐（需要音频分析，较复杂）。

### 5.4 实施优先级

**Phase 1（本次落地，不需要改合成层结构）：**
1. 在 breaker prompt 里强制输出 `【快剪】` / `【对比】` / `【分屏】` / `【关键词叠加】` 标签。
2. 用「漫画式多格组合图」prompt 模拟分屏、对比、快剪。
3. 让 BGM prompt 根据标签切换能量等级。

**Phase 2（需要扩展 composition）：**
1. 新增 `keyword` overlay，实现真正的关键词叠加。
2. 新增 `multi-image-sequence` video type，实现真快剪。
3. 新增 `split-screen` video type，实现真分屏。

---

## Task 6: 前端导入表单增加 retention 选项

**Files:**
- Modify: 前端导入脚本页面（需先定位文件路径）

由于当前 focus 在后端，前端改动可在后端验证后补充。Plan 中先标记：

- 在 `POST /dramas/:id/import-script` 的调用处增加：
  - `retention_mode`: `'standard' | 'tight'` 下拉
  - `hook_style`: `'auto' | 'suspense' | 'conflict' | 'data'` 下拉
  - `clean`: true（必须同时开启清理才生效）

---

## Task 7: 端到端验证

**Files:**
- Use API: `POST /scripts/clean`
- Use API: `POST /dramas/:id/import-script`

**Step 1: 测试 /scripts/clean 的 tight 模式**

Run:
```bash
curl -s -X POST http://localhost:5679/api/scripts/clean \
  -H "Content-Type: application/json" \
  -d '{
    "content": "内阁和户部给万历回复了三点反对开矿的理由：防患、惜财和怕扰动地方。第一点防患...",
    "retention_mode": "tight",
    "hook_style": "suspense"
  }' | jq '{original_length, cleaned_length, retention_mode, hook_style, content}'
```

Expected: `cleaned_length` 明显小于 `original_length`，`content` 开头是悬念式钩子。

**Step 2: 测试 import-script 生成 episode 并检查 openingHook**

Run:
```bash
curl -s -X POST http://localhost:5679/api/dramas/26/import-script \
  -H "Content-Type: application/json" \
  -d '{
    "script_content": "内阁和户部给万历回复了三点反对开矿的理由...",
    "clean": true,
    "retention_mode": "tight",
    "hook_style": "suspense",
    "title": "万历矿税测试"
  }' | jq '.created_episodes'
```

Expected: 生成 episode，其 `openingHook` 不为空且为悬念式第一句。

**Step 3: 类型检查**

Run:
```bash
cd /Users/zhangshijie/Documents/workspace/huobao-drama/backend
npm run typecheck
```

Expected: 无类型错误。

---

## 风险与回退

| 风险 | 回退方案 |
|---|---|
| LLM 改写过度，丢失关键事实 | 默认保留 `standard` 模式；`tight` 模式 optional |
| 钩子风格不合适 | `hook_style: 'auto'` 让模型自选；用户可切换 |
| 独立开头增加复杂度 | Phase 1 不拆表，仅用 `openingHook` |
| 与现有 direct_script 拆分逻辑冲突 | `retention_mode` 默认 `'standard'`，不影响旧流程 |

---

## Phase 2（可选）

1. 增加 `episode_openings` 独立表，支持 3-10 秒可复用开头。
2. 在视频合成阶段把独立开头 prepend 到正片前。
3. A/B 测试：对比 `standard` / `tight` / `tight + 独立开头` 的平均播放时长与完播率。
