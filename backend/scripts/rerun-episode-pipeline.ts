import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'
import { createStoryboardTools } from '../src/agents/tools/storyboard-tools.js'
import { buildAgentInstructions } from '../src/agents/index.js'
import { callTextModel } from '../src/services/ai.js'
import {
  generateEpisodePreTTS,
  applyPreTTSTimingsToStoryboards,
  splitLongStoryboardsByPreTTS,
} from '../src/services/episode-tts.js'
import { restoreOriginalTextNarrations } from '../src/services/narration-generation.js'
import { now } from '../src/utils/response.js'

const episodeId = 425
const dramaId = 90

console.log(`[rerun] start episodeId=${episodeId} dramaId=${dramaId}`)

// 1. 重置本集分镜和预生成 TTS
console.log('[rerun] clearing existing storyboards and pre-TTS...')
db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()
db.update(schema.episodes)
  .set({
    preTtsAudioUrl: null,
    preTtsTitlesJson: null,
    duration: 0,
    updatedAt: now(),
  })
  .where(eq(schema.episodes.id, episodeId))
  .run()

// 2. 重新粗分分镜（用 JSON 模式直接输出，绕过 DeepSeek tool_call 参数解析问题）
console.log('[rerun] generating coarse storyboards via JSON mode...')
const tools = createStoryboardTools(episodeId, dramaId)
const context = await (tools.readStoryboardContext as any).execute({})
const instructions = buildAgentInstructions('storyboard_breaker', episodeId)
if (!instructions) {
  throw new Error('Failed to build storyboard_breaker instructions')
}

const outputRules = [
  '',
  '输出要求（不要调用工具，直接返回 JSON）：',
  '1. 只输出一个合法的 JSON 对象，顶层字段为 "storyboards"，值是一个数组。',
  '2. 每个数组元素字段：shot_number, title, shot_type, angle, movement, location, time, action, dialogue, description, result, atmosphere, image_prompt, video_prompt, bgm_prompt, sound_effect, duration, energy_level, scene_id, character_ids。',
  '3. description 必须是原文片段，不要按字数或时长拆。',
  '4. 不要包裹 Markdown 代码块。',
].join('\n')

const raw = await callTextModel([
  { role: 'system', content: instructions + outputRules },
  { role: 'user', content: [
    '上下文数据（请严格依据以下剧本、角色和场景生成分镜）：',
    '',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
    '',
    '请根据上述上下文重新拆解本集分镜。要求：',
    '- direct_script 模式下按事件/情节点粗分，每个镜头的 description 必须是原文片段。',
    '- 拆分要积极：每出现一次新的动作、对象、空间转换、时间推进或因果转折，就拆成新镜头。',
    '- 不要合并独立事件，宁可多拆也不要把一整段压缩成一两个镜头。',
    '- 本集粗分镜头数目标：50-70 个。',
  ].join('\n') },
], {
  temperature: 0.7,
  maxTokens: 32768,
  responseFormat: { type: 'json_object' },
  extraBody: { thinking: { type: 'disabled' } },
})

let parsed: any
let storyboards: any[]
try {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  parsed = JSON.parse(text)
  storyboards = Array.isArray(parsed.storyboards) ? parsed.storyboards : Array.isArray(parsed) ? parsed : []
} catch (err: any) {
  console.error('[rerun] raw model output:\n', raw)
  throw new Error(`Failed to parse storyboards JSON: ${err.message}`)
}

console.log(`[rerun] model returned ${storyboards.length} coarse storyboards`)

function normalizeEnergyLevel(level: any): 'high' | 'medium' | 'low' {
  const s = String(level || '').toLowerCase().trim()
  if (s === 'high' || s === '高' || s === 'h') return 'high'
  if (s === 'low' || s === '低' || s === 'l') return 'low'
  return 'medium'
}

// 把模型可能输出成字符串的 id/duration 强制转数字，energy_level 归一化
const normalizedStoryboards = storyboards.map((sb: any) => ({
  ...sb,
  shot_number: Number(sb.shot_number),
  scene_id: sb.scene_id == null ? null : Number(sb.scene_id),
  duration: sb.duration == null ? undefined : Number(sb.duration),
  energy_level: normalizeEnergyLevel(sb.energy_level),
  character_ids: Array.isArray(sb.character_ids)
    ? sb.character_ids.map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id))
    : undefined,
}))

const saveResult = await (tools.saveStoryboards as any).execute({ storyboards: normalizedStoryboards })
console.log('[rerun] save result:', saveResult)
if (saveResult?.error) {
  throw new Error(`saveStoryboards failed: ${saveResult.message}`)
}

// 3. 把 narration 对齐到原文（direct_script / verbatim 模式）
console.log('[rerun] restoring original text narrations...')
const restored = restoreOriginalTextNarrations(episodeId)
console.log('[rerun] restored:', restored)

// 4. 预生成整集 TTS
console.log('[rerun] generating pre-TTS...')
const tts = await generateEpisodePreTTS(episodeId)
console.log('[rerun] pre-TTS audio:', tts.audioUrl, 'titles:', tts.titles.length)

// 5. 用真实时间轴覆盖每镜时长
console.log('[rerun] applying pre-TTS timings...')
const timings = applyPreTTSTimingsToStoryboards(episodeId)
console.log('[rerun] timings:', timings)

// 6. 自动 12 秒拆分已临时关闭，优先保证粗分质量
console.log('[rerun] auto 12s split is currently disabled')

// 7. 检查结果
const rows = db.select().from(schema.storyboards)
  .where(eq(schema.storyboards.episodeId, episodeId))
  .orderBy(schema.storyboards.storyboardNumber)
  .all()

const totalDuration = rows.reduce((sum, r) => sum + (r.duration || 0), 0)
console.log(`[rerun] final: ${rows.length} shots, total ${totalDuration}s (~${(totalDuration / 60).toFixed(1)}min)`)

console.log('[rerun] first 10 shots:')
for (let i = 0; i < Math.min(10, rows.length); i++) {
  const r = rows[i]
  console.log(
    `#${r.storyboardNumber}`,
    `dur=${r.duration}`,
    `desc=${(r.description || '').slice(0, 40)}`,
    `img=${(r.imagePrompt || '').slice(0, 80)}`,
  )
}

// 8. 当前已关闭自动拆分，所以不会有 (x/N) 子镜头
console.log('[rerun] no (x/N) child shots because auto split is disabled')

console.log('[rerun] done')
