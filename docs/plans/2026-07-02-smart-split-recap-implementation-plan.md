# Smart Split Recap Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a templated intro animation before each episode, and a voice-over + visual recap video before each episode (starting from episode 2) so viewers can understand the current episode without watching the previous one.

**Architecture:** Extract hook generation (`opening_hook`, `cliffhanger_hook`, `recap_script`, `series_hook`) from `episode-splitter.ts` into a new `HookDesigner` step. Add an `IntroComposer` step that renders a short intro from a configurable `intro_template`. Add a `RecapComposer` step that reuses previous episode storyboard frames and newly generated TTS to produce a recap video. The episode merge step prepends intro then recap to the final episode output.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, SQLite, fluent-ffmpeg, custom composition services under `backend/src/services/composition/`.

---

## Task 1: Add intro + recap schema

**Files:**
- Modify: `backend/src/db/schema.ts`
- Test: `backend/src/db/schema.test.ts` (create if missing, or add inline type check)

**Step 1: Write the failing test**

Create `backend/src/db/schema.test.ts` if it does not exist:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { episodes, dramas, introTemplates } from './schema.js'

describe('recap + intro schema', () => {
  it('has recap and hook columns on episodes', () => {
    assert.ok(episodes.recapScript)
    assert.ok(episodes.recapVideoUrl)
    assert.ok(episodes.introVideoUrl)
    assert.ok(episodes.openingHook)
    assert.ok(episodes.cliffhangerHook)
    assert.ok(episodes.seriesHook)
  })

  it('has intro_template_id on dramas', () => {
    assert.ok(dramas.introTemplateId)
  })

  it('has intro_templates table', () => {
    assert.ok(introTemplates.id)
    assert.ok(introTemplates.name)
    assert.ok(introTemplates.config)
    assert.ok(introTemplates.isDefault)
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/db/schema.test.ts
```

Expected: FAIL with `Cannot find module` if file is new, or assertion error if fields missing.

**Step 3: Write minimal implementation**

1. Add `intro_templates` table in `backend/src/db/schema.ts`:

```ts
export const introTemplates = sqliteTable('intro_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

2. Add to `dramas` table:

```ts
  introTemplateId: text('intro_template_id').references(() => introTemplates.id),
```

3. Add to `episodes` table after existing hook fields:

```ts
  introVideoUrl: text('intro_video_url'),
  recapScript: text('recap_script'),
  recapVideoUrl: text('recap_video_url'),
  openingHook: text('opening_hook'),
  cliffhangerHook: text('cliffhanger_hook'),
  seriesHook: text('series_hook'),
```

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/db/schema.test.ts
```

Expected: PASS.

**Step 5: Generate and push migration**

Run:
```bash
cd backend && npm run db:generate && npm run db:push
```

Expected: Migration created and applied successfully.

**Step 6: Commit**

```bash
git add backend/src/db/schema.ts backend/src/db/schema.test.ts
git commit -m "feat(schema): add intro_template, recap and hook fields"
```

---

## Task 2: Seed default intro template

**Files:**
- Create or modify: `backend/scripts/seed-default-intro-template.ts`
- Modify: `backend/package.json` scripts (optional)

**Step 1: Write the script**

Create `backend/scripts/seed-default-intro-template.ts`:

```ts
import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'

const DEFAULT_ID = 'classic-title-fade'

const defaultConfig = {
  duration: 3,
  background: { type: 'color', value: '#000000' },
  variables: {
    dramaTitle: { source: 'drama.title', fallback: '精彩短剧' },
  },
  layers: [
    {
      type: 'text',
      content: '{{dramaTitle}}',
      fontSize: 72,
      color: '#ffffff',
      position: 'center',
      animation: { type: 'fadeIn', duration: 1.5, delay: 0.5 },
    },
  ],
  audio: null,
}

async function main() {
  const existing = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, DEFAULT_ID)).all()[0]
  if (existing) {
    console.log('Default intro template already exists')
    return
  }

  db.insert(schema.introTemplates).values({
    id: DEFAULT_ID,
    name: '经典黑场标题淡入',
    config: defaultConfig,
    isDefault: true,
  }).run()

  console.log('Default intro template seeded')
}

main().catch(console.error)
```

**Step 2: Run the script**

Run:
```bash
cd backend && npx tsx scripts/seed-default-intro-template.ts
```

Expected: Default template inserted.

**Step 3: Commit**

```bash
git add backend/scripts/seed-default-intro-template.ts
git commit -m "chore(intro): seed default intro template"
```

---

## Task 3: Remove hook generation from episode-splitter

**Files:**
- Modify: `backend/src/services/episode-splitter.ts:79-88, 316-322, 340-346, 640-659`
- Test: `backend/src/services/episode-splitter.test.ts`

**Step 1: Write the failing test**

Open `backend/src/services/episode-splitter.test.ts` and add:

```ts
it('does not generate opening_hook or cliffhanger_hook', async () => {
  const result = await splitStoryIntoEpisodes({
    sourceText: 'Alice met Bob. They argued. Alice left.',
    durationPresetId: 'shorts_1_3',
  })
  assert.ok(result.episodes.length > 0)
  assert.strictEqual(result.episodes[0].openingHook, undefined)
  assert.strictEqual(result.episodes[0].cliffhangerHook, undefined)
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/services/episode-splitter.test.ts
```

Expected: FAIL because `openingHook` is still defined.

**Step 3: Write minimal implementation**

1. In `splitEpisodeSchema` (lines ~79-88), remove `opening_hook` and `cliffhanger_hook`.
2. In `splitEpisodesToolJsonSchema` (lines ~123-160), remove `opening_hook` and `cliffhanger_hook` from required properties.
3. In `SmartSplitEpisodeBoundary` interface (lines ~181-190), remove `openingHook` and `cliffhangerHook`.
4. In `MaterializedSmartSplitEpisode` interface (line ~192-194), keep `content` plus title/summary.
5. In `buildEpisodeSplitSystemPrompt` (lines ~316-322), remove instructions about `opening_hook` and `cliffhanger_hook`. Keep instructions about `series_hook`.
6. In `buildEpisodeSplitUserPrompt` (lines ~340-346), remove references to `opening_hook` and `cliffhanger_hook`.
7. In `splitStoryIntoEpisodes` (lines ~640-659), stop mapping `openingHook` and `cliffhangerHook`. Keep `series_hook`.

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/services/episode-splitter.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/src/services/episode-splitter.ts backend/src/services/episode-splitter.test.ts
git commit -m "refactor(splitter): remove hook generation from episode splitter"
```

---

## Task 4: Create HookDesigner service

**Files:**
- Create: `backend/src/services/hook-designer.ts`
- Test: `backend/src/services/hook-designer.test.ts`

**Step 1: Write the failing test**

Create `backend/src/services/hook-designer.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { designHooksForEpisodes } from './hook-designer.js'

describe('hook designer', () => {
  it('generates recap_script for episode 2 based on episode 1 cliffhanger', async () => {
    const episodes = [
      {
        episodeNumber: 1,
        content: 'Alice met Bob. They argued. Alice left.',
        summary: 'Alice meets Bob, argues, and leaves.',
        coveredBeatIds: ['b1', 'b2', 'b3'],
      },
      {
        episodeNumber: 2,
        content: 'Bob chased Alice. They talked.',
        summary: 'Bob chases Alice and they reconcile.',
        coveredBeatIds: ['b4', 'b5'],
      },
    ]
    const plotChain = [
      { beatId: 'b1', summary: 'Alice meets Bob', mustKeepContext: 'Introduces main characters.' },
      { beatId: 'b2', summary: 'They argue', mustKeepContext: 'Sets up conflict.' },
      { beatId: 'b3', summary: 'Alice leaves', mustKeepContext: 'Cliffhanger: will Bob follow?' },
      { beatId: 'b4', summary: 'Bob chases Alice', mustKeepContext: 'Resolution begins.' },
      { beatId: 'b5', summary: 'They talk', mustKeepContext: 'Conflict de-escalates.' },
    ]
    const result = await designHooksForEpisodes({ episodes, plotChain, dramaTitle: 'Alice and Bob' })
    assert.strictEqual(result.seriesHook.length > 0, true)
    assert.strictEqual(result.episodeHooks.length, 2)
    assert.strictEqual(result.episodeHooks[0].recapScript, undefined)
    assert.ok(result.episodeHooks[1].recapScript)
    assert.ok(result.episodeHooks[1].recapScript?.includes('Alice'))
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/services/hook-designer.test.ts
```

Expected: FAIL because `designHooksForEpisodes` is not defined.

**Step 3: Write minimal implementation**

Create `backend/src/services/hook-designer.ts`:

```ts
import { z } from 'zod'
import { aiFetch } from './ai-client.js'
import { getTextConfig, getTextProviderBaseUrl } from './ai.js'
import { joinProviderUrl } from './adapters/url.js'

const SMART_HOOK_DESIGN_MODEL = 'deepseek-v4-flash'

const episodeHookSchema = z.object({
  episode_number: z.number().int().positive(),
  opening_hook: z.string().min(1),
  cliffhanger_hook: z.string().min(1),
  recap_script: z.string().optional(),
})

const hookDesignPayloadSchema = z.object({
  series_hook: z.string().min(1),
  episode_hooks: z.array(episodeHookSchema).min(1),
})

export interface HookDesignInput {
  dramaTitle?: string | null
  episodes: Array<{
    episodeNumber: number
    content: string
    summary: string
    coveredBeatIds: string[]
  }>
  plotChain: Array<{
    beatId: string
    summary: string
    mustKeepContext: string
  }>
}

export interface EpisodeHooks {
  episodeNumber: number
  openingHook: string
  cliffhangerHook: string
  recapScript?: string
}

export interface HookDesignResult {
  seriesHook: string
  episodeHooks: EpisodeHooks[]
}

function buildSystemPrompt(): string {
  return [
    '你是短剧钩子设计师。',
    '你已经收到了完整的分集结果和剧情推进链。',
    '你的任务是为每一集生成：',
    '1. opening_hook：recap 结束后、正文开始前的过渡钩子，直接抛出本集核心冲突，不要交代前情。',
    '2. cliffhanger_hook：本集结尾悬念，让观众想看下一集。',
    '3. recap_script（从第二集开始）：用上一集画面+新配音生成前情提要，40-70字，概括上一集关键事件。',
    '4. series_hook：全剧一句话核心钩子，用于封面标题。',
    'recap_script 必须基于上一集的 cliffhanger_hook 和 must_keep_context 生成。',
    '第一集不需要 recap_script。',
    '只通过函数调用提交结果，不要输出额外正文。',
  ].join('\n')
}

function buildUserPrompt(input: HookDesignInput): string {
  return [
    `剧名：${input.dramaTitle?.trim() || '未命名项目'}`,
    '分集结果：',
    JSON.stringify(input.episodes.map(ep => ({
      episode_number: ep.episodeNumber,
      summary: ep.summary,
      covered_beat_ids: ep.coveredBeatIds,
    })), null, 2),
    '',
    '剧情推进链：',
    JSON.stringify(input.plotChain.map(b => ({
      beat_id: b.beatId,
      summary: b.summary,
      must_keep_context: b.mustKeepContext,
    })), null, 2),
    '',
    '要求：',
    '1. series_hook 用一句话概括全剧最大冲突。',
    '2. 第一集 recap_script 为空。',
    '3. 从第二集开始，recap_script 必须让观众理解当前集的前因。',
    '4. opening_hook 不再承担前情交代，只负责把观众拉进本集冲突。',
  ].join('\n')
}

export async function designHooksForEpisodes(input: HookDesignInput): Promise<HookDesignResult> {
  const textConfig = getTextConfig()
  const providerBase = getTextProviderBaseUrl(textConfig)
  const url = joinProviderUrl(providerBase, '', '/chat/completions')
  const model = process.env.SMART_HOOK_DESIGN_MODEL || SMART_HOOK_DESIGN_MODEL

  const response = await aiFetch(textConfig.provider || 'text', url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${textConfig.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      temperature: 0.3,
      max_tokens: 8000,
      tools: [{
        type: 'function',
        function: {
          name: 'submit_hook_design',
          description: '提交全剧钩子设计',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              series_hook: { type: 'string' },
              episode_hooks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    episode_number: { type: 'integer' },
                    opening_hook: { type: 'string' },
                    cliffhanger_hook: { type: 'string' },
                    recap_script: { type: 'string' },
                  },
                  required: ['episode_number', 'opening_hook', 'cliffhanger_hook'],
                },
              },
            },
            required: ['series_hook', 'episode_hooks'],
          },
        },
      }],
      tool_choice: {
        type: 'function',
        function: { name: 'submit_hook_design' },
      },
    })
  }, { timeoutMs: 180_000, maxAttempts: 2 })

  const data = await response.json()
  const toolCall = data?.choices?.[0]?.message?.tool_calls?.find(
    (item: any) => item?.function?.name === 'submit_hook_design'
  )
  if (!toolCall) throw new Error('Hook design model did not return expected tool call')
  const parsed = JSON.parse(toolCall.function.arguments)
  const validated = hookDesignPayloadSchema.parse(parsed)

  return {
    seriesHook: validated.series_hook,
    episodeHooks: validated.episode_hooks.map(h => ({
      episodeNumber: h.episode_number,
      openingHook: h.opening_hook,
      cliffhangerHook: h.cliffhanger_hook,
      recapScript: h.recap_script,
    })),
  }
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/services/hook-designer.test.ts
```

Expected: PASS (assuming AI call succeeds; if external call is flaky, mock `aiFetch` in a follow-up task).

**Step 5: Commit**

```bash
git add backend/src/services/hook-designer.ts backend/src/services/hook-designer.test.ts
git commit -m "feat(hooks): add HookDesigner service for recap/opening/cliffhanger hooks"
```

---

## Task 5: Add hook-design task handler

**Files:**
- Create: `backend/src/services/tasks/handlers/hook-design.ts`
- Modify: `backend/src/services/tasks/registry.ts` (if registration is centralized)
- Modify: `backend/src/index.ts:91-96` to register handler
- Test: `backend/src/services/tasks/handlers/hook-design.test.ts`

**Step 1: Inspect registry pattern**

Run:
```bash
grep -n "registerTaskHandler\|registerComposeStoryboardHandler" backend/src/services/tasks/handlers/*.ts backend/src/index.ts
```

Confirm handlers self-register via side-effect imports in `backend/src/index.ts`.

**Step 2: Write the failing test**

Create `backend/src/services/tasks/handlers/hook-design.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHookDesignHandler } from './hook-design.js'

describe('hook design handler', () => {
  it('exists and exposes run function', () => {
    const handler = createHookDesignHandler()
    assert.strictEqual(typeof handler.run, 'function')
  })
})
```

**Step 3: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/services/tasks/handlers/hook-design.test.ts
```

Expected: FAIL because file does not exist.

**Step 4: Write minimal implementation**

Create `backend/src/services/tasks/handlers/hook-design.ts`:

```ts
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { designHooksForEpisodes } from '../../hook-designer.js'
import { registerTaskHandler } from '../registry.js'
import { logTaskStart, logTaskSuccess, logTaskError } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface HookDesignPayload {
  episode_id?: number
  episodeId?: number
}

export function createHookDesignHandler(): TaskHandler<HookDesignPayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<HookDesignPayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      logTaskStart('HookDesignTask', 'hook-design', { episodeId })
      ctx.progress('Designing hooks and recap scripts', 0, 1)

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) throw new Error(`Episode ${episodeId} not found`)

      const allEpisodes = db.select().from(schema.episodes)
        .where(eq(schema.episodes.dramaId, ep.dramaId))
        .orderBy(schema.episodes.episodeNumber)
        .all()

      const splitResults = allEpisodes.map(e => ({
        episodeNumber: e.episodeNumber,
        content: e.content || '',
        summary: e.description || '',
        coveredBeatIds: [], // TODO: persist covered_beat_ids in a later task
      }))

      const plotChain: any[] = [] // TODO: load from episode metadata or persist plot chain

      const result = await designHooksForEpisodes({
        dramaTitle: ep.title,
        episodes: splitResults,
        plotChain,
      })

      for (const hook of result.episodeHooks) {
        const target = allEpisodes.find(e => e.episodeNumber === hook.episodeNumber)
        if (!target) continue
        db.update(schema.episodes)
          .set({
            openingHook: hook.openingHook,
            cliffhanger: hook.cliffhangerHook,
            recapScript: hook.recapScript,
            seriesHook: result.seriesHook,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.episodes.id, target.id))
          .run()
      }

      ctx.progress('Hook design completed', 1, 1)
      logTaskSuccess('HookDesignTask', 'hook-design', { episodeId, seriesHook: result.seriesHook })
      return { episode_id: episodeId, series_hook: result.seriesHook }
    },
  }
}

export function registerHookDesignHandler() {
  registerTaskHandler('hook.design', createHookDesignHandler())
}
```

Add to `backend/src/index.ts` after line 91:

```ts
import { registerHookDesignHandler } from './services/tasks/handlers/hook-design.js'
```

And call `registerHookDesignHandler()` near other registrations.

**Step 5: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/services/tasks/handlers/hook-design.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/src/services/tasks/handlers/hook-design.ts backend/src/services/tasks/handlers/hook-design.test.ts backend/src/index.ts
git commit -m "feat(tasks): add hook-design task handler"
```

---

## Task 6: Persist plot chain and covered_beat_ids

**Files:**
- Modify: `backend/src/db/schema.ts:28-71`
- Modify: `backend/src/services/episode-splitter.ts:660-673`
- Test: `backend/src/services/episode-splitter.test.ts`

**Step 1: Write the failing test**

Add to `backend/src/services/episode-splitter.test.ts`:

```ts
it('persists plot chain and covered beat ids to episode metadata', async () => {
  const result = await splitStoryIntoEpisodes({
    sourceText: 'Alice met Bob. They argued. Alice left. Bob chased her.',
    durationPresetId: 'shorts_1_3',
  })
  assert.ok(result.plotProgressionChain.length > 0)
  assert.ok(result.episodes[0].coveredBeatIds.length > 0)
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/services/episode-splitter.test.ts
```

Expected: FAIL if `metadata` field is not used, or test expectations mismatch.

**Step 3: Write minimal implementation**

1. Add `metadata` to episodes if not present, or use existing `metadata` text field.
2. In `splitStoryIntoEpisodes`, serialize plot chain and per-episode coveredBeatIds into episode metadata after splitting.

Example update in `episode-splitter.ts`:

```ts
// After materializing episodes, persist plot chain to each episode's metadata
for (const ep of episodes) {
  db.update(schema.episodes)
    .set({
      metadata: JSON.stringify({
        plotProgressionChain: plotChainPayload.plot_progression_chain,
        coveredBeatIds: ep.coveredBeatIds,
      }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.episodes.id, ep.id))
    .run()
}
```

Note: this requires the caller to pass episode IDs, which may not be the case. If `splitStoryIntoEpisodes` does not know DB IDs, move persistence to the route/handler that calls it.

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/services/episode-splitter.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/src/services/episode-splitter.ts backend/src/services/episode-splitter.test.ts
git commit -m "feat(splitter): persist plot chain and covered beat ids"
```

---

## Task 7: Create IntroComposer service

**Files:**
- Create: `backend/src/services/intro-composer.ts`
- Test: `backend/src/services/intro-composer.test.ts`

**Step 1: Write the failing test**

Create `backend/src/services/intro-composer.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { composeIntroForEpisode } from './intro-composer.js'

describe('intro composer', () => {
  it('returns a video url for a valid episode and template', async () => {
    const result = await composeIntroForEpisode({
      episodeId: 1,
      episodeNumber: 1,
      dramaTitle: '测试短剧',
      templateId: 'classic-title-fade',
    })
    assert.ok(result)
    assert.ok(result!.endsWith('.mp4'))
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/services/intro-composer.test.ts
```

Expected: FAIL because function not defined.

**Step 3: Write minimal implementation**

Create `backend/src/services/intro-composer.ts`:

```ts
import path from 'path'
import fs from 'fs'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

export interface IntroComposeInput {
  episodeId: number
  episodeNumber: number
  dramaTitle?: string | null
  templateId?: string | null
}

export interface IntroTemplateConfig {
  duration: number
  background: { type: 'color' | 'image'; value: string }
  variables?: Record<string, { source: string; fallback?: string }>
  layers: Array<{
    type: 'text' | 'image'
    content: string
    fontSize?: number
    color?: string
    position?: string
    animation?: { type: string; duration: number; delay?: number }
  }>
  audio?: any
}

export async function composeIntroForEpisode(input: IntroComposeInput): Promise<string | null> {
  // Resolve template
  let template = input.templateId
    ? db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, input.templateId)).all()[0]
    : undefined

  if (!template) {
    const defaults = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.isDefault, true)).all()
    template = defaults[0]
  }

  if (!template) {
    console.warn('No intro template found, skipping intro')
    return null
  }

  const config = template.config as IntroTemplateConfig

  // Resolve variables
  const vars: Record<string, string> = {
    dramaTitle: input.dramaTitle || '精彩短剧',
    episodeNumber: String(input.episodeNumber),
  }

  // TODO: build composition with config.background + layers + animations
  // TODO: render video to data/static/intros/<episodeId>-intro.mp4

  return null
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/services/intro-composer.test.ts
```

Expected: PASS once rendering returns a path.

**Step 5: Commit**

```bash
git add backend/src/services/intro-composer.ts backend/src/services/intro-composer.test.ts
git commit -m "feat(intro): add IntroComposer skeleton"
```

---

## Task 8: Implement IntroComposer rendering for default template

**Files:**
- Modify: `backend/src/services/intro-composer.ts`
- Test: `backend/src/services/intro-composer.test.ts`

**Step 1: Implement default template renderer**

For the default `classic-title-fade` template:
1. Create a black background image or use ffmpeg color source.
2. Render centered white text with fade-in animation.
3. Export to `data/static/intros/<episodeId>-intro.mp4`.
4. Return relative URL `static/intros/<episodeId>-intro.mp4`.

Reuse `composition/` helpers if available (e.g., `buildStoryboardComposition`, `renderStoryboardComposition`).

**Step 2: Run test**

Run:
```bash
cd backend && npx tsx --test src/services/intro-composer.test.ts
```

Expected: PASS and an actual mp4 file is created.

**Step 3: Commit**

```bash
git add backend/src/services/intro-composer.ts backend/src/services/intro-composer.test.ts
git commit -m "feat(intro): render default black-fade title intro"
```

---

## Task 9: Add intro-compose task handler

**Files:**
- Create: `backend/src/services/tasks/handlers/intro-compose.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/services/tasks/handlers/intro-compose.test.ts`

**Step 1: Write the failing test**

Create `backend/src/services/tasks/handlers/intro-compose.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createIntroComposeHandler } from './intro-compose.js'

describe('intro compose handler', () => {
  it('exists and exposes run function', () => {
    const handler = createIntroComposeHandler()
    assert.strictEqual(typeof handler.run, 'function')
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/services/tasks/handlers/intro-compose.test.ts
```

Expected: FAIL because file does not exist.

**Step 3: Write minimal implementation**

Create `backend/src/services/tasks/handlers/intro-compose.ts`:

```ts
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { composeIntroForEpisode } from '../../intro-composer.js'
import { registerTaskHandler } from '../registry.js'
import { logTaskStart, logTaskSuccess, logTaskError } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface IntroComposePayload {
  episode_id?: number
  episodeId?: number
}

export function createIntroComposeHandler(): TaskHandler<IntroComposePayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<IntroComposePayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      logTaskStart('IntroComposeTask', 'intro-compose', { episodeId })
      ctx.progress('Composing intro animation', 0, 1)

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) throw new Error(`Episode ${episodeId} not found`)

      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()

      const introVideoUrl = await composeIntroForEpisode({
        episodeId,
        episodeNumber: ep.episodeNumber,
        dramaTitle: drama?.title,
        templateId: drama?.introTemplateId,
      })

      db.update(schema.episodes)
        .set({ introVideoUrl, updatedAt: new Date().toISOString() })
        .where(eq(schema.episodes.id, episodeId))
        .run()

      ctx.progress('Intro compose completed', 1, 1)
      logTaskSuccess('IntroComposeTask', 'intro-compose', { episodeId, introVideoUrl })
      return { episode_id: episodeId, intro_video_url: introVideoUrl }
    },
  }
}

export function registerIntroComposeHandler() {
  registerTaskHandler('intro.compose', createIntroComposeHandler())
}
```

Add to `backend/src/index.ts` and call `registerIntroComposeHandler()`.

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/services/tasks/handlers/intro-compose.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/src/services/tasks/handlers/intro-compose.ts backend/src/services/tasks/handlers/intro-compose.test.ts backend/src/index.ts
git commit -m "feat(tasks): add intro-compose task handler"
```

---

## Task 10: Create RecapComposer service

**Files:**
- Create: `backend/src/services/recap-composer.ts`
- Test: `backend/src/services/recap-composer.test.ts`

**Step 1: Write the failing test**

Create `backend/src/services/recap-composer.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert'
import { composeRecapForEpisode } from './recap-composer.js'

describe('recap composer', () => {
  it('returns null for episode 1', async () => {
    const result = await composeRecapForEpisode({ episodeId: 1, episodeNumber: 1, recapScript: 'test' })
    assert.strictEqual(result, null)
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/services/recap-composer.test.ts
```

Expected: FAIL because function not defined.

**Step 3: Write minimal implementation**

Create `backend/src/services/recap-composer.ts` with skeleton:

```ts
import path from 'path'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { generateTTS } from './tts-generation.js'
import { buildStoryboardComposition, renderStoryboardComposition, type AudioLayer } from './composition/index.js'

export interface RecapComposeInput {
  episodeId: number
  episodeNumber: number
  recapScript: string
  openingHook?: string | null
}

export async function composeRecapForEpisode(input: RecapComposeInput): Promise<string | null> {
  if (input.episodeNumber <= 1) return null
  if (!input.recapScript.trim()) return null

  // TODO: load previous episode storyboards and pick frames
  // TODO: generate TTS for recapScript
  // TODO: build composition with Ken Burns on frames + subtitle overlay
  // TODO: render and return recap video URL

  return null
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/services/recap-composer.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/src/services/recap-composer.ts backend/src/services/recap-composer.test.ts
git commit -m "feat(recap): add RecapComposer skeleton"
```

---

## Task 11: Implement RecapComposer frame selection and TTS

**Files:**
- Modify: `backend/src/services/recap-composer.ts`
- Test: `backend/src/services/recap-composer.test.ts`

**Step 1: Add frame selection logic**

Implement helper to find previous episode's key storyboards:

```ts
function findPreviousEpisodeFrames(currentEpisodeNumber: number, dramaId: number): string[] {
  const prevEp = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), eq(schema.episodes.episodeNumber, currentEpisodeNumber - 1)))
    .all()[0]
  if (!prevEp) return []

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, prevEp.id))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  // Pick first, middle-ish, and last frames
  const frames: string[] = []
  if (storyboards.length > 0) frames.push(storyboards[0].firstFrameImage)
  if (storyboards.length > 2) frames.push(storyboards[Math.floor(storyboards.length / 2)].firstFrameImage)
  if (storyboards.length > 1) frames.push(storyboards[storyboards.length - 1].firstFrameImage)

  return frames.filter(Boolean).map(f => {
    if (path.isAbsolute(f)) return f
    if (f.startsWith('static/')) return path.resolve(process.cwd(), 'data', f)
    return path.resolve(process.cwd(), 'data/static', f)
  })
}
```

**Step 2: Add TTS generation**

Generate TTS for `recapScript` using `generateTTS`:

```ts
const ttsResult = await generateTTS({
  text: input.recapScript,
  voice: 'alloy',
  subtitleEnable: false,
})
```

**Step 3: Build composition**

Use first frame as base image with Ken Burns, overlay openingHook as title, add audio.

**Step 4: Run tests**

Run:
```bash
cd backend && npx tsx --test src/services/recap-composer.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/src/services/recap-composer.ts backend/src/services/recap-composer.test.ts
git commit -m "feat(recap): implement frame selection, tts and composition"
```

---

## Task 12: Add recap-compose task handler

**Files:**
- Create: `backend/src/services/tasks/handlers/recap-compose.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/services/tasks/handlers/recap-compose.test.ts`

**Step 1: Write handler**

Create `backend/src/services/tasks/handlers/recap-compose.ts`:

```ts
import { db, schema } from '../../../db/index.js'
import { eq } from 'drizzle-orm'
import { composeRecapForEpisode } from '../../recap-composer.js'
import { registerTaskHandler } from '../registry.js'
import { logTaskStart, logTaskSuccess, logTaskError } from '../../../utils/task-logger.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface RecapComposePayload {
  episode_id?: number
  episodeId?: number
}

export function createRecapComposeHandler(): TaskHandler<RecapComposePayload> {
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<RecapComposePayload>) {
      const episodeId = Number(ctx.payload.episode_id ?? ctx.payload.episodeId)
      if (!episodeId) throw new Error('episode_id is required')

      logTaskStart('RecapComposeTask', 'recap-compose', { episodeId })
      ctx.progress('Composing recap video', 0, 1)

      const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) throw new Error(`Episode ${episodeId} not found`)

      const recapVideoUrl = await composeRecapForEpisode({
        episodeId,
        episodeNumber: ep.episodeNumber,
        recapScript: ep.recapScript || '',
        openingHook: ep.openingHook,
      })

      db.update(schema.episodes)
        .set({ recapVideoUrl, updatedAt: new Date().toISOString() })
        .where(eq(schema.episodes.id, episodeId))
        .run()

      ctx.progress('Recap compose completed', 1, 1)
      logTaskSuccess('RecapComposeTask', 'recap-compose', { episodeId, recapVideoUrl })
      return { episode_id: episodeId, recap_video_url: recapVideoUrl }
    },
  }
}

export function registerRecapComposeHandler() {
  registerTaskHandler('recap.compose', createRecapComposeHandler())
}
```

Register in `backend/src/index.ts`.

**Step 2: Run test**

Run:
```bash
cd backend && npx tsx --test src/services/tasks/handlers/recap-compose.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add backend/src/services/tasks/handlers/recap-compose.ts backend/src/services/tasks/handlers/recap-compose.test.ts backend/src/index.ts
git commit -m "feat(tasks): add recap-compose task handler"
```

---

## Task 13: Modify episode merge to prepend intro + recap

**Files:**
- Modify: `backend/src/services/tasks/handlers/merge-episode.ts`
- Test: `backend/src/services/tasks/handlers/merge.test.ts` (or create)

**Step 1: Locate merge logic**

Open `backend/src/services/tasks/handlers/merge-episode.ts` and find where storyboard videos are concatenated.

**Step 2: Prepend intro then recap**

Before concatenating storyboard videos, check `episode.introVideoUrl` and `episode.recapVideoUrl`. If present and file exists, prepend in order.

```ts
const inputs: string[] = []

if (episode.introVideoUrl) {
  const introPath = toAbsPath(episode.introVideoUrl)
  if (fs.existsSync(introPath)) {
    inputs.push(introPath)
  }
}

if (episode.recapVideoUrl) {
  const recapPath = toAbsPath(episode.recapVideoUrl)
  if (fs.existsSync(recapPath)) {
    inputs.push(recapPath)
  }
}

inputs.push(...storyboardVideoPaths)
```

**Step 3: Run tests**

Run:
```bash
cd backend && npx tsx --test src/services/tasks/handlers/merge.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add backend/src/services/tasks/handlers/merge-episode.ts backend/src/services/tasks/handlers/merge.test.ts
git commit -m "feat(merge): prepend intro and recap videos to episode output"
```

---

## Task 14: Update auto-pipeline dependencies

**Files:**
- Modify: `backend/src/services/tasks/auto-pipeline.ts`

**Step 1: Find episode creation / split trigger**

Locate where `compose.storyboard` tasks are created after episode split.

**Step 2: Add hook-design, intro-compose and recap-compose tasks**

After episode split completes, create `hook.design` task for each episode. Then create `intro.compose` and `recap.compose` tasks.

- `intro.compose` depends on `hook.design` (so drama title/series hook is stable) but can run in parallel with storyboard composition.
- `recap.compose` depends on `hook.design` and previous episode `compose.storyboard` tasks.
- `merge` depends on `intro.compose`, `recap.compose`, and current episode `compose.storyboard`.

```ts
const hookTask = createTask({
  type: 'hook.design',
  episodeId: ep.id,
  scopeType: 'episode',
  scopeId: ep.id,
  idempotencyKey: `hook.design:${ep.id}`,
  payload: { episode_id: ep.id },
})

const introTask = createTask({
  type: 'intro.compose',
  episodeId: ep.id,
  scopeType: 'episode',
  scopeId: ep.id,
  idempotencyKey: `intro.compose:${ep.id}`,
  payload: { episode_id: ep.id },
})
addTaskDependency(introTask.id, hookTask.id)

const recapTask = createTask({
  type: 'recap.compose',
  episodeId: ep.id,
  scopeType: 'episode',
  scopeId: ep.id,
  idempotencyKey: `recap.compose:${ep.id}`,
  payload: { episode_id: ep.id },
})
addTaskDependency(recapTask.id, hookTask.id)
if (prevEpisodeStoryboardTask) {
  addTaskDependency(recapTask.id, prevEpisodeStoryboardTask.id)
}
```

**Step 3: Commit**

```bash
git add backend/src/services/tasks/auto-pipeline.ts
git commit -m "feat(pipeline): trigger hook-design, intro-compose and recap-compose tasks"
```

---

## Task 15: End-to-end smoke test

**Files:**
- Use existing UI or curl

**Step 1: Trigger smart split**

Via UI or curl, trigger smart split on a drama with direct script source.

**Step 2: Verify tasks**

Poll tasks API:
```bash
curl http://localhost:5679/api/v1/tasks?episode_id=<ID>
```

Expect to see `hook.design`, `intro.compose`, and `recap.compose` tasks complete.

**Step 3: Verify output**

Check episode row has `intro_video_url`, `recap_video_url`, and final merged video starts with intro then recap.

**Step 4: Commit any test fixtures**

```bash
git add backend/src/services/tasks/auto-pipeline.ts
git commit -m "chore: verify intro + recap end-to-end"
```

---

## Task 16: Add intro template REST routes

**Files:**
- Create: `backend/src/routes/introTemplates.ts`
- Modify: `backend/src/index.ts` to mount route
- Test: `backend/src/routes/introTemplates.test.ts`

**Step 1: Write the failing test**

Create `backend/src/routes/introTemplates.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('intro templates routes', () => {
  it('lists intro templates', async () => {
    const res = await fetch('http://localhost:5679/api/v1/intro-templates')
    assert.strictEqual(res.status, 200)
    const json = await res.json()
    assert.ok(Array.isArray(json.data))
  })
})
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd backend && npx tsx --test src/routes/introTemplates.test.ts
```

Expected: FAIL (route not mounted or 404).

**Step 3: Write minimal implementation**

Create `backend/src/routes/introTemplates.ts`:

```ts
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound, badRequest, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'

const app = new Hono()

app.get('/', async (c) => {
  const rows = db.select().from(schema.introTemplates).orderBy(schema.introTemplates.createdAt).all()
  return success(c, toSnakeCaseArray(rows))
})

app.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, id)).all()
  if (!row) return notFound(c, 'Template not found')
  return success(c, toSnakeCase(row))
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  if (!body.id || !body.name || !body.config) return badRequest(c, 'id, name, config required')
  const ts = now()
  db.insert(schema.introTemplates).values({
    id: body.id,
    name: body.name,
    config: typeof body.config === 'string' ? body.config : JSON.stringify(body.config),
    isDefault: !!body.is_default,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return created(c, { id: body.id })
})

app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) updates.name = body.name
  if (body.config !== undefined) updates.config = typeof body.config === 'string' ? body.config : JSON.stringify(body.config)
  db.update(schema.introTemplates).set(updates).where(eq(schema.introTemplates.id, id)).run()
  return success(c)
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  db.delete(schema.introTemplates).where(eq(schema.introTemplates.id, id)).run()
  return success(c)
})

app.post('/:id/set-default', async (c) => {
  const id = c.req.param('id')
  const ts = now()
  db.update(schema.introTemplates).set({ isDefault: false }).run()
  db.update(schema.introTemplates).set({ isDefault: true, updatedAt: ts }).where(eq(schema.introTemplates.id, id)).run()
  return success(c)
})

export default app
```

Mount in `backend/src/index.ts`:

```ts
import introTemplatesRoute from './routes/introTemplates.js'
app.route('/api/v1/intro-templates', introTemplatesRoute)
```

**Step 4: Run test to verify it passes**

Run:
```bash
cd backend && npx tsx --test src/routes/introTemplates.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/src/routes/introTemplates.ts backend/src/routes/introTemplates.test.ts backend/src/index.ts
git commit -m "feat(routes): add intro template CRUD and set-default"
```

---

## Task 17: Update drama/episode routes to expose intro and hook fields

**Files:**
- Modify: `backend/src/routes/dramas.ts`
- Modify: `backend/src/routes/episodes.ts`

**Step 1: Update drama PUT**

In `backend/src/routes/dramas.ts` `PUT /:id`, add to allowed updates:

```ts
if (body.intro_template_id !== undefined) updates.introTemplateId = body.intro_template_id || null
```

**Step 2: Update episode PUT**

In `backend/src/routes/episodes.ts` `PUT /:id`, add to allowed list:

```ts
'opening_hook', 'cliffhanger_hook', 'recap_script', 'series_hook'
```

And map them in drizzleUpdates:

```ts
if ('opening_hook' in updates) drizzleUpdates.openingHook = updates.opening_hook || null
if ('cliffhanger_hook' in updates) drizzleUpdates.cliffhanger = updates.cliffhanger_hook || null
if ('recap_script' in updates) drizzleUpdates.recapScript = updates.recap_script || null
if ('series_hook' in updates) drizzleUpdates.seriesHook = updates.series_hook || null
```

**Step 3: Run relevant tests**

Run:
```bash
cd backend && npx tsx --test src/routes/dramas-import-script.test.ts src/routes/episodes.test.ts
```

If `episodes.test.ts` does not exist, create a minimal test that PUTs hook fields and reads them back.

**Step 4: Commit**

```bash
git add backend/src/routes/dramas.ts backend/src/routes/episodes.ts
git commit -m "feat(routes): expose intro_template_id and hook fields via PUT"
```

---

## Task 18: Frontend — intro template management in settings

**Files:**
- Modify: `frontend/app/pages/settings.vue`
- Create: `frontend/app/components/IntroTemplateEditor.vue` (optional)
- Modify: `frontend/app/composables/useApi.ts`

**Step 1: Add API composable**

In `useApi.ts` add:

```ts
export const introTemplateAPI = {
  list: () => api.get('/intro-templates'),
  get: (id: string) => api.get(`/intro-templates/${id}`),
  create: (data: any) => api.post('/intro-templates', data),
  update: (id: string, data: any) => api.put(`/intro-templates/${id}`, data),
  del: (id: string) => api.del(`/intro-templates/${id}`),
  setDefault: (id: string) => api.post(`/intro-templates/${id}/set-default`, {}),
}
```

**Step 2: Add settings tab**

In `settings.vue` baseTabs 增加：

```ts
{ id: 'intro', label: '开场模板', icon: Clapperboard }
```

`advancedTabs` 保持不变。

**Step 3: Build tab UI**

Add a new `v-if="tab === 'intro'"` block that:
1. Calls `introTemplateAPI.list()` on mount.
2. Lists templates with name, default badge, and a small `<video>` preview if available.
3. Provides buttons: 设为默认、编辑、删除。
4. Provides a 「新建模板」 button opening a dialog with name, duration, background color, title text, font size/color, animation type, and a JSON advanced editor.

**Step 4: Test manually**

Open `http://localhost:3013/settings` (or the actual dev port) and verify:
- Default template is shown.
- Creating a new template appears in the list.
- Setting default updates the badge.

**Step 5: Commit**

```bash
git add frontend/app/pages/settings.vue frontend/app/composables/useApi.ts
if [ -f frontend/app/components/IntroTemplateEditor.vue ]; then git add frontend/app/components/IntroTemplateEditor.vue; fi
git commit -m "feat(ui): intro template management in settings"
```

---

## Task 19: Frontend — drama-level intro template selector

**Files:**
- Modify: `frontend/app/pages/drama/[id]/index.vue`
- Modify: `frontend/app/composables/useApi.ts` (if not done in Task 18)

**Step 1: Load templates**

In `load()` or a new `loadIntroTemplates()` function, call `introTemplateAPI.list()`.

**Step 2: Add selector**

In the header actions area, after the existing buttons, add a `BaseSelect`:

```vue
<BaseSelect
  v-model="dramaIntroTemplateId"
  :options="introTemplateOptions"
  placeholder="使用默认开场模板"
  class="intro-template-select"
  @update:model-value="updateDramaIntroTemplate"
/>
```

Options should include `{ label: '使用默认模板', value: '' }` plus all templates.

**Step 3: Persist selection**

```ts
async function updateDramaIntroTemplate(value: string) {
  try {
    await dramaAPI.update(dramaId, { intro_template_id: value || null })
    toast.success('已更新开场模板')
    await load()
  } catch (e) {
    toast.error(e.message)
  }
}
```

**Step 4: Smart split result panel**

Remove the display of `opening_hook` / `cliffhanger_hook` from the smart split result grid, because they are now generated later. Replace with `summary` and a small tag「钩子待生成」。

**Step 5: Commit**

```bash
git add frontend/app/pages/drama/[id]/index.vue frontend/app/composables/useApi.ts
git commit -m "feat(ui): select intro template per drama and update split result panel"
```

---

## Task 20: Frontend — episode studio intro/recap section

**Files:**
- Modify: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`
- Modify: `frontend/app/composables/useApi.ts` (if not done)

**Step 1: Add settings drawer section**

In the settings drawer body, after the 「字幕」 section, add **「开场与前情提要」** section:

```vue
<section class="settings-section">
  <div class="settings-section-title">开场与前情提要</div>
  <div class="settings-control-row">
    <span class="render-mode-label">当前模板</span>
    <span class="dim">{{ selectedIntroTemplateName }}</span>
    <NuxtLink :to="`/settings?tab=intro`" class="btn btn-sm ml-auto">管理模板</NuxtLink>
  </div>
  <div class="settings-control-row">
    <span class="render-mode-label">开场动画</span>
    <span :class="['tag', episode?.intro_video_url ? 'tag-success' : 'tag-pending']">
      {{ episode?.intro_video_url ? '已生成' : '未生成' }}
    </span>
    <button v-if="episode?.intro_video_url" class="btn btn-sm" @click="previewIntro">播放</button>
    <button class="btn btn-sm ml-auto" :disabled="regeneratingIntro" @click="regenerateIntro">重新生成</button>
  </div>
  <div v-if="episodeNumber > 1" class="settings-control-row">
    <span class="render-mode-label">前情提要</span>
    <span :class="['tag', episode?.recap_video_url ? 'tag-success' : 'tag-pending']">
      {{ episode?.recap_video_url ? '已生成' : '未生成' }}
    </span>
    <button class="btn btn-sm ml-auto" :disabled="regeneratingRecap" @click="regenerateRecap">重新生成</button>
  </div>
  <label v-if="episodeNumber > 1" class="field" style="margin-top:8px">
    <span class="field-label">recap_script</span>
    <textarea v-model="editableRecapScript" class="input textarea" rows="3" />
  </label>
  <label class="field" style="margin-top:8px">
    <span class="field-label">opening_hook</span>
    <input v-model="editableOpeningHook" class="input" />
  </label>
  <label class="field" style="margin-top:8px">
    <span class="field-label">cliffhanger_hook</span>
    <input v-model="editableCliffhangerHook" class="input" />
  </label>
  <label v-if="episodeNumber === 1" class="field" style="margin-top:8px">
    <span class="field-label">series_hook</span>
    <input v-model="editableSeriesHook" class="input" />
  </label>
  <button class="btn btn-primary btn-sm" style="margin-top:10px" :disabled="savingHooks" @click="saveHooks">保存钩子与提要</button>
</section>
```

**Step 2: Add actions**

```ts
async function regenerateIntro() {
  const task = await taskAPI.create({
    type: 'intro.compose',
    drama_id: drama.value.id,
    episode_id: episode.value.id,
    scope_type: 'episode',
    scope_id: episode.value.id,
    payload: { episode_id: episode.value.id },
  })
  toast.success(`已创建开场动画生成任务 #${task.id}`)
}

async function regenerateRecap() {
  const task = await taskAPI.create({
    type: 'recap.compose',
    drama_id: drama.value.id,
    episode_id: episode.value.id,
    scope_type: 'episode',
    scope_id: episode.value.id,
    payload: { episode_id: episode.value.id },
  })
  toast.success(`已创建前情提要生成任务 #${task.id}`)
}

async function saveHooks() {
  await episodeAPI.update(episode.value.id, {
    recap_script: editableRecapScript.value,
    opening_hook: editableOpeningHook.value,
    cliffhanger_hook: editableCliffhangerHook.value,
    series_hook: editableSeriesHook.value,
  })
  toast.success('已保存')
}
```

**Step 3: Export panel 片头结构**

Above the storyboard overview list (`export-list`), add a small `intro-recap-overview` card showing:
- Intro row with play button when `intro_video_url` exists.
- Recap row with play button when `recap_video_url` exists (only for episode > 1).

**Step 4: Commit**

```bash
git add frontend/app/pages/drama/[id]/episode/[episodeNumber].vue frontend/app/composables/useApi.ts
git commit -m "feat(ui): episode studio intro/recap section and export overview"
```

---

## Task 21: End-to-end UI verification

**Files:**
- None (manual verification)

**Step 1: Settings page**

- Verify default template exists.
- Create a new template and set it as default.

**Step 2: Drama page**

- Open a drama.
- Change intro template via the header selector.
- Run smart split or import script.

**Step 3: Episode studio**

- Open episode 1, verify intro generated and series_hook editable.
- Open episode 2+, verify recap_script editable and recap video generated after pipeline.
- Check export panel shows intro/recap rows and the merged video includes them.

**Step 4: Commit any fixes**

```bash
git commit -m "chore: verify intro/recap UI end-to-end"
```

## Notes

- The `coveredBeatIds` persistence in Task 6 is a placeholder because the current `splitStoryIntoEpisodes` returns boundaries but may not have episode DB IDs. Adjust persistence to the route/handler layer if needed.
- Mock external AI calls in unit tests if they become flaky.
- Keep recap duration under 25 seconds to avoid viewer drop-off.
- Intro duration is currently 3 seconds by default; tune based on platform best practices.
