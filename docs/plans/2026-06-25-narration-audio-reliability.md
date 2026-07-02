# [旁白与成片音频可靠性] Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 narrator agent 即使因为模型/Provider 原因没有成功保存旁白，也能通过兜底服务生成并写入；同时确保每个合成镜头和最终成片都携带音频流，避免再次出现“成片无声音”的静默失败。

**Architecture:** 在 `agent-run.ts` 中把 narrator 兜底从“可选补救”升级为“强校验”——agent 运行后若旁白未写全则触发 JSON 模式兜底，兜底后仍不完整则任务直接失败；在 `ffmpeg-compose.ts` 合成后用 `ffprobe` 校验输出包含音频流；在 `ffmpeg-merge.ts` 拼接后校验成片音频流；为所有新增行为补充单元测试。

**Tech Stack:** Hono 4, Nuxt 3, SQLite + Drizzle ORM, Node native test runner, fluent-ffmpeg, MiniMax TTS.

---

### Task 1: 让 `generateAndSaveNarrations` 可注入 fetcher 并补单元测试

**Files:**
- Modify: `backend/src/services/narration-generation.ts`
- Create: `backend/src/services/narration-generation.test.ts`

**Step 1: 修改 `narration-generation.ts` 支持依赖注入**

把 `aiFetch` 改为可注入，方便测试时 mock，不需要改实际调用方。

```ts
// backend/src/services/narration-generation.ts
export interface NarrationGenerationDeps {
  fetcher?: typeof aiFetch
}

export async function generateAndSaveNarrations(
  episodeId: number,
  dramaId: number,
  deps: NarrationGenerationDeps = {},
) {
  const fetcher = deps.fetcher || aiFetch
  // ... 保持原有逻辑不变，只把下面的 aiFetch(...) 改为 fetcher(...)
  const resp = await fetcher(
    textConfig.provider || 'text',
    url,
    { /* 原请求参数 */ },
    { timeoutMs: 180_000, maxAttempts: 2 },
  )
  // ...
}
```

**Step 2: 编写失败的测试**

```ts
// backend/src/services/narration-generation.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-narration-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('./db/index.js')
const { generateAndSaveNarrations } = await import('./narration-generation.js')

test('generateAndSaveNarrations writes narrations from JSON response', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: 'Test Text',
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-4o-mini']),
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    content: '原始故事：他表面冷静，内心已经放弃。',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '协议压桌',
    description: '他盯着桌上的离婚协议。',
    duration: 10,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const mockFetcher = async () => ({
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            narrations: [{ shot_number: 1, narration: '他看着协议，已经不想争辩。' }],
          }),
        },
      }],
    }),
  }) as any

  await generateAndSaveNarrations(episodeId, dramaId, { fetcher: mockFetcher })

  const [sb] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
  assert.equal(sb.narration, '他看着协议，已经不想争辩。')
})
```

**Step 3: 运行测试，确认失败（如果还没修改）或成功**

```bash
cd backend
node --test src/services/narration-generation.test.ts
```

Expected: `PASS` for the single test.

**Step 4: Commit**

```bash
cd /Users/zhangshijie/Documents/workspace/huobao-drama
git add backend/src/services/narration-generation.ts backend/src/services/narration-generation.test.ts
git commit -m "test(narration): injectable aiFetch + unit test for narration fallback"
```

---

### Task 2: 把 narrator 兜底升级为“强校验”，不完整则任务失败

**Files:**
- Modify: `backend/src/services/tasks/handlers/agent-run.ts`
- Modify: `backend/src/services/tasks/handlers/agent-run.test.ts`

**Step 1: 在 `agent-run.ts` 中注入 fallback 并强校验结果**

```ts
// backend/src/services/tasks/handlers/agent-run.ts
interface CreateAgentRunHandlerDeps {
  createAgent?: (type: string, episodeId: number, dramaId: number) => AgentLike | null
  timeoutMs?: number
  generateNarrationsFallback?: (episodeId: number, dramaId: number) => Promise<void>
}

export function createAgentRunHandler(deps: CreateAgentRunHandlerDeps = {}): TaskHandler<AgentRunPayload> {
  const createAgent = deps.createAgent ?? defaultCreateAgent
  const timeoutMs = getTimeoutMs(deps.timeoutMs)
  const generateNarrationsFallback = deps.generateNarrationsFallback ?? generateAndSaveNarrations
  // ...

  // narrator 兜底 + 强校验
  if (agentType === 'narrator') {
    const total = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
      .all().length

    let existing = countExistingNarrations(episodeId)
    if (existing < total) {
      try {
        await generateNarrationsFallback(episodeId, dramaId)
      } catch (err: any) {
        ctx.event('agent.narration_fallback_failed', { error: err.message })
      }
    }

    existing = countExistingNarrations(episodeId)
    if (existing < total) {
      throw new Error(`Narration incomplete after fallback: ${existing}/${total}`)
    }
  }
  // ...
}
```

**Step 2: 在 `agent-run.test.ts` 增加“兜底仍失败则抛错”的测试**

```ts
test('narrator run fails when agent and fallback both leave narrations empty', async () => {
  const ts = new Date().toISOString()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Narration Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Episode',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: 'Shot',
    description: 'Shot description',
    duration: 10,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  let fallbackCalled = false
  const handler = createAgentRunHandler({
    createAgent: () => ({
      generate: async () => ({ text: '', toolCalls: [], toolResults: [] }),
    }),
    generateNarrationsFallback: async () => {
      fallbackCalled = true
      // 模拟兜底也什么都没写入
    },
  })

  const task = createTask({
    type: 'agent.run',
    dramaId,
    episodeId,
    payload: {
      agent_type: 'narrator',
      message: 'write narration',
      drama_id: dramaId,
      episode_id: episodeId,
    },
  })

  await assert.rejects(
    () => handler.run({
      taskId: task.id,
      payload: task.payload,
      signal: new AbortController().signal,
      progress() {},
      event() {},
      isCancelRequested() { return false },
    }),
    /Narration incomplete after fallback/,
  )
  assert.equal(fallbackCalled, true)
})
```

**Step 3: 运行测试**

```bash
cd backend
node --test src/services/tasks/handlers/agent-run.test.ts
```

Expected: 全部 `PASS`。

**Step 4: Commit**

```bash
git add backend/src/services/tasks/handlers/agent-run.ts backend/src/services/tasks/handlers/agent-run.test.ts
git commit -m "fix(narrator): enforce narration completeness after fallback"
```

---

### Task 3: 合成单个镜头后校验输出视频必须包含音频流

**Files:**
- Modify: `backend/src/services/ffmpeg-merge-helpers.ts`
- Modify: `backend/src/services/ffmpeg-compose.ts`
- Create: `backend/src/services/ffmpeg-merge-helpers.test.ts`

**Step 1: 在 `ffmpeg-merge-helpers.ts` 增加断言辅助函数**

```ts
// backend/src/services/ffmpeg-merge-helpers.ts
export async function assertHasAudioStream(filePath: string): Promise<void> {
  const ok = await hasAudioStream(filePath)
  if (!ok) {
    throw new Error(`Missing audio stream: ${filePath}`)
  }
}
```

**Step 2: 在 `ffmpeg-compose.ts` 合成结束后调用断言**

```ts
// backend/src/services/ffmpeg-compose.ts
import { addSilentAudio, hasAudioStream, assertHasAudioStream } from './ffmpeg-merge-helpers.js'

// 在 composeStoryboard 的 ffmpeg run 结束后、更新数据库前：
await assertHasAudioStream(outputPath)

const composedRelative = `static/composed/${outputFilename}`
db.update(schema.storyboards)
  .set({ composedVideoUrl: composedRelative, status: 'compose_completed', updatedAt: now() })
  .where(eq(schema.storyboards.id, storyboardId)).run()
```

**Step 3: 为 helper 编写测试**

```ts
// backend/src/services/ffmpeg-merge-helpers.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'huobao-ffmpeg-helpers-'))
const noAudio = join(dir, 'no-audio.mp4')
const withAudio = join(dir, 'with-audio.mp4')

execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=1',
  '-pix_fmt', 'yuv420p', noAudio,
])
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=1',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
  '-pix_fmt', 'yuv420p', '-shortest', withAudio,
])

const { hasAudioStream, assertHasAudioStream } = await import('./ffmpeg-merge-helpers.js')

test('hasAudioStream returns false for video without audio', async () => {
  assert.equal(await hasAudioStream(noAudio), false)
})

test('hasAudioStream returns true for video with audio', async () => {
  assert.equal(await hasAudioStream(withAudio), true)
})

test('assertHasAudioStream throws when audio is missing', async () => {
  await assert.rejects(
    async () => assertHasAudioStream(noAudio),
    /Missing audio stream/,
  )
})

test('assertHasAudioStream resolves when audio is present', async () => {
  await assert.doesNotReject(() => assertHasAudioStream(withAudio))
})
```

**Step 4: 运行测试**

```bash
cd backend
node --test src/services/ffmpeg-merge-helpers.test.ts
```

Expected: 4 tests `PASS`。

**Step 5: Commit**

```bash
git add backend/src/services/ffmpeg-merge-helpers.ts backend/src/services/ffmpeg-compose.ts backend/src/services/ffmpeg-merge-helpers.test.ts
git commit -m "fix(compose): assert composed video has audio stream"
```

---

### Task 4: 拼接成片后校验最终视频必须包含音频流

**Files:**
- Modify: `backend/src/services/ffmpeg-merge.ts`

**Step 1: 在 `doMerge` 完成后增加音频流断言**

```ts
// backend/src/services/ffmpeg-merge.ts
import { addSilentAudio, hasAudioStream, assertHasAudioStream } from './ffmpeg-merge-helpers.js'

// 在 doMerge 中，ffmpeg run 结束、获取时长后：
await assertHasAudioStream(outputPath)
const duration = await getVideoDuration(outputPath)
```

这样如果 concat 导致音频流丢失，`doMerge` 会抛错，`executeEpisodeMerge` 的 catch 会把 `video_merges` 记录标记为 `failed`。

**Step 2: 手动验证命令**

```bash
cd backend
npx tsx scripts/recompose-episode.ts 38 14
```

完成后运行：

```bash
ffprobe -v error -select_streams a -show_entries stream=codec_type,codec_name -of csv=p=0 \
  /Users/zhangshijie/Documents/workspace/huobao-drama/data/static/merged/$(sqlite3 ../data/huobao_drama.db "SELECT merged_url FROM video_merges WHERE episode_id=38 ORDER BY id DESC LIMIT 1" | sed 's|static/merged/||')
```

Expected output: `audio,aac`。

**Step 3: Commit**

```bash
git add backend/src/services/ffmpeg-merge.ts
git commit -m "fix(merge): assert merged episode has audio stream"
```

---

### Task 5: 运行类型检查与现有测试，确保没有回归

**Step 1: 后端类型检查**

```bash
cd backend
npm run build
```

Expected: `tsc` 无错误。

**Step 2: 后端相关测试**

```bash
cd backend
node --test src/services/narration-generation.test.ts src/services/ffmpeg-merge-helpers.test.ts src/services/tasks/handlers/agent-run.test.ts src/services/tasks/handlers/compose.test.ts src/services/tasks/handlers/merge.test.ts
```

Expected: 全部 `PASS`。

**Step 3: 前端构建检查**

```bash
cd frontend
npm run build
```

Expected: Nuxt build 成功（本计划未改前端文件，但保险起见跑一遍）。

**Step 4: Commit（仅当需要修复构建问题时）**

```bash
git commit -m "chore: verify narration-audio reliability changes with tsc and tests"
```

---

## 验收标准

- `agent.run` 的 narrator 任务在 agent 未保存任何旁白时，会自动触发兜底；兜底后仍不完整则任务状态为 `failed`，不会继续进入 TTS/合成阶段。
- `composeStoryboard` 输出的每个 `composedVideoUrl` 对应的文件都包含音频流。
- `executeEpisodeMerge` 输出的成片文件包含 AAC 音频流。
- 新增/修改的单元测试全部通过，`npm run build` 无类型错误。

## 后续可选

- 在导出面板增加“音频校验通过”徽标（需要后端提供 `/api/episodes/:id/audio-check` 端点）。
- 为 `ffmpeg-merge.ts` 增加音量检测（mean_volume 过低时告警），避免“有音频但几乎听不见”的静默失败。
