/**
 * 开场视频（片头）独立 storyboard 设计与生产。
 *
 * 与逐镜 designVideoShot 分开：开场 ~8s 是独立于正文的蒙太奇/建立镜头，需要自己的一套
 * storyboard（概念 + 若干 Beat 的景别/运镜/主体/情绪 + 最终视频提示词）。设计结果持久化到
 * episodes.opening_storyboard_json，生产结果写回 episodes.introVideoUrl，由 episode-mixer
 * 自动前置为片头。
 */
import fs from 'fs'
import path from 'path'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { aiFetch } from './ai-client.js'
import { getTextRequestExtras } from './ai.js'
import { getActiveTextConfig } from './grid-narrative-pipeline.js'
import { runEgakiVideo, VIDEO_DIR, DEFAULT_T2V_MODEL } from './grok-video.js'

export interface OpeningBeat {
  shotSize: string
  cameraMove: string
  subject: string
  mood: string
}

export interface OpeningStoryboard {
  concept: string
  durationSec: number
  beats: OpeningBeat[]
  prompt: string
}

const DESIGN_SYSTEM_PROMPT = `你是历史纪录片的片头导演。为整集设计一个时长约 8 秒的开场视频（片头）storyboard：
一段蒙太奇/建立镜头，呼应本集主题与开场钩子，先声夺人但不剧透。

只输出严格 JSON，不要输出任何其他内容：
{
  "concept": "一句话总构思：开场用什么意象/运动建立本集基调（如：孤雁掠过祁连雪线，叠化至未央宫阙，引出少年将军）",
  "durationSec": 8,
  "beats": [
    { "shotSize": "establishing_wide|wide|full|medium|close|face_closeup|extreme_detail", "cameraMove": "缓慢推进/横移揭示/升镜拉远/环绕/静态持住", "subject": "该 Beat 的主体与动作", "mood": "该 Beat 的情绪" }
  ],
  "prompt": "最终视频生成提示词：中文描述整段开场画面（主体与动作、景别与机位、构图层次、色彩基调、光线、缓慢电影感运镜），200字以内，绝对不出现任何文字、字幕、水印"
}

要求：
- beats 用 3-5 个，按时间顺序构成一条连续发展轨道（建立→发展→落点），不要跳切；
- 时代自洽是硬约束：服饰、建筑、兵器、道具必须符合本集年代，禁止出现该年代不存在之物；
- 色彩与光线服务情绪，开篇冷峻、收束留悬念；
- prompt 字段即视频生产依据，须可直接用于文生视频。`

function extractJson(text: string): any | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export function safeParseOpeningStoryboard(raw: string | null | undefined): OpeningStoryboard | null {
  if (!raw) return null
  const parsed = extractJson(String(raw))
  if (!parsed || typeof parsed !== 'object') return null
  if (typeof parsed.concept !== 'string' || typeof parsed.prompt !== 'string') return null
  if (!Array.isArray(parsed.beats) || parsed.beats.length === 0) return null
  const beats: OpeningBeat[] = parsed.beats
    .slice(0, 6)
    .map((b: any) => ({
      shotSize: typeof b.shotSize === 'string' ? b.shotSize : 'wide',
      cameraMove: typeof b.cameraMove === 'string' ? b.cameraMove : '缓慢推进',
      subject: typeof b.subject === 'string' ? b.subject : '',
      mood: typeof b.mood === 'string' ? b.mood : '',
    }))
  const durationSec = Math.min(10, Math.max(6, Number(parsed.durationSec) || 8))
  return { concept: parsed.concept, durationSec, beats, prompt: parsed.prompt }
}

/** 为整集设计开场 storyboard，持久化到 episodes.opening_storyboard_json，返回设计稿。 */
export async function designOpeningStoryboard(episodeId: number): Promise<OpeningStoryboard> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  const [drama] = ep.dramaId ? db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all() : [undefined]
  const llm = getActiveTextConfig()
  const userPrompt = `剧集：《${drama?.title || ''}》
本集标题：${ep.title || ''}
开场钩子：${ep.openingHook || ''}
请为这集设计一段约 8 秒的开场视频 storyboard。`

  let parsed: any = null
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    const res = await aiFetch(llm.provider, `${llm.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: DESIGN_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.6,
        response_format: { type: 'json_object' },
        ...getTextRequestExtras(llm),
      }),
    }, { lane: 'text-agent' })
    if (!res.ok) throw new Error(`opening design llm HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    const content = String(json.choices?.[0]?.message?.content || '')
    parsed = safeParseOpeningStoryboard(content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim())
  }
  if (!parsed) throw new Error(`Episode ${episodeId} 开场 storyboard 设计两次均未通过校验`)
  db.update(schema.episodes)
    .set({ openingStoryboardJson: JSON.stringify(parsed), updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
    .run()
  return parsed
}

export interface OpeningVideoResult {
  generated: boolean
  skipped: boolean
  src?: string
  assetId?: number
  error?: string
  storyboard?: OpeningStoryboard
}

/**
 * 开场视频生产：先确保有 storyboard（无则设计），再 t2v 生成 ~8s 视频，
 * 写回 episodes.introVideoUrl（由 episode-mixer 前置为片头）。
 */
export async function generateOpeningVideo(
  episodeId: number,
  opts: { force?: boolean; durationSec?: number; resolution?: string } = {},
  onProgress?: (current: number, total: number, message: string) => void,
): Promise<OpeningVideoResult> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)

  onProgress?.(0, 1, '开场 storyboard 设计/加载')
  let storyboard = safeParseOpeningStoryboard(ep.openingStoryboardJson)
  if (!storyboard || opts.force) {
    storyboard = await designOpeningStoryboard(episodeId)
  }

  if (!opts.force && ep.introVideoUrl) {
    onProgress?.(1, 1, '开场视频已存在，跳过')
    return { generated: false, skipped: true, src: ep.introVideoUrl, storyboard }
  }

  const durationSec = Math.min(10, Math.max(6, opts.durationSec || storyboard.durationSec || 8))
  const resolution = opts.resolution || '720p'
  const prompt = `${storyboard.prompt}。画面中不要出现任何文字、字幕、水印。`

  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  const ts = now()
  const insert = db
    .insert(schema.videoAssets)
    .values({
      dramaId: ep.dramaId,
      episodeId,
      prompt,
      model: DEFAULT_T2V_MODEL,
      provider: 'xai-oauth',
      mode: 't2v',
      era: '',
      sceneTag: 'opening',
      eventTag: '',
      mood: 'epic',
      durationSec,
      resolution,
      aspectRatio: '16:9',
      status: 'pending',
      designJson: JSON.stringify({ schemaVersion: 1, promptSource: 'opening_storyboard', storyboard }),
      createdAt: ts,
      updatedAt: ts,
    })
    .run()
  const assetId = Number(insert.lastInsertRowid)
  const fileName = `asset-${assetId}.mp4`
  const absOut = path.join(VIDEO_DIR, fileName)
  const relOut = `static/videos/${fileName}`

  onProgress?.(1, 1, `开场视频生成中（${durationSec}s）`)
  try {
    await runEgakiVideo({
      model: DEFAULT_T2V_MODEL,
      prompt,
      output: absOut,
      durationSec,
      resolution,
      aspectRatio: '16:9',
    })
  } catch (err: any) {
    const msg = String(err?.message || err)
    db.update(schema.videoAssets)
      .set({ status: 'failed', errorMsg: msg, updatedAt: now() })
      .where(eq(schema.videoAssets.id, assetId))
      .run()
    // xAI 不可用时（凭证/率限/服务问题）跳过开场视频，不阻塞整集生产。
    const isXaiUnavailable = /xai|egaki|token|refresh|rate.limit|429|401|insufficient balance|unavailable/i.test(msg)
    if (isXaiUnavailable) {
      return { generated: false, skipped: true, error: `xAI 不可用，跳过开场视频: ${msg}`, storyboard }
    }
    return { generated: false, skipped: false, error: msg, storyboard }
  }

  db.update(schema.videoAssets)
    .set({ localPath: relOut, status: 'completed', useCount: 1, lastUsedAt: now(), updatedAt: now() })
    .where(eq(schema.videoAssets.id, assetId))
    .run()
  db.update(schema.episodes)
    .set({ introVideoUrl: relOut, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
    .run()

  return { generated: true, skipped: false, src: relOut, assetId, storyboard }
}

