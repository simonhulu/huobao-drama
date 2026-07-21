/**
 * VLM 六维校验环：每分镜单张画面审查；兼容读取历史双格数据。
 * 六维规则：旁白匹配、时代自洽、文字洁净、现实可信、机位可达、纪实体裁一致。
 * 结构检查（sharp 尺寸/空白）+ VLM 视觉审查（apimart gpt-4o-mini，base64 上传）。
 * 硬失败镜头自动换种子重生一次，复审仍失败则把问题写回 gridCells.review 供人工处理。
 */
import { eq } from 'drizzle-orm'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { aiFetch } from './ai-client.js'
import { generateEpisodeGridSheets } from './grid-narrative-pipeline.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

const VLM_MODEL = 'gpt-4o-mini'

export interface CellReviewVerdict {
  pass: boolean
  issues: string[]
  structural: boolean
  vlm: boolean
}

interface ReviewOptions {
  onlyStoryboardIds?: number[]
  maxRetries?: number
  useReferenceImages?: boolean
}

type ProgressFn = (current: number, total: number, message: string) => void

function resolveStaticPath(rel: string): string {
  if (rel.startsWith('static/')) return path.join(repoRoot, 'data', rel)
  return rel.startsWith('/') ? rel : path.join(repoRoot, 'data', rel)
}

export function getImageConfig(): { baseUrl: string; apiKey: string } {
  const [row] = db
    .select()
    .from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, 6))
    .all()
  if (!row) throw new Error('image config 6 not found')
  return { baseUrl: String(row.baseUrl).replace(/\/+$/, ''), apiKey: String(row.apiKey) }
}

async function structuralCheck(absPath: string): Promise<string[]> {
  const issues: string[] = []
  if (!fs.existsSync(absPath)) return ['file missing']
  try {
    const meta = await sharp(absPath).metadata()
    if (!meta.width || !meta.height) issues.push('无法读取尺寸')
    else if (meta.width < 700 || meta.height < 800) issues.push(`尺寸异常 ${meta.width}x${meta.height}`)
    const stats = await sharp(absPath).stats()
    const mean = stats.channels[0]?.mean ?? 0
    const stdev = stats.channels[0]?.stdev ?? 0
    if (mean < 6 && stdev < 6) issues.push('画面疑似全黑/空白')
  } catch (e: any) {
    issues.push(`结构检查异常: ${String(e?.message || e).slice(0, 80)}`)
  }
  return issues
}

export function buildGridReviewSystemPrompt(): string {
  return `你是纪实历史视频的画面审查员。审查一张 AI 生成的16:9横屏画面。"预期描述"不是事实依据，必须同时对照当前旁白、地点、时间和体裁进行六项独立审查：
1. narration_match：最终画面（原图加已声明的后期信息层）是否直接支持当前旁白，且没有延续上一镜或提前表现下一镜
2. era_ok：道具、服饰、建筑与社会程序是否符合历史年代
3. text_clean：没有文字、字幕、数字、水印或印章
4. reality_ok：人物行为、仪式阶段、空间关系是否可能在现实生活中发生；不得把抽象信息强行演成虚构事件
5. camera_access_ok：摄影机位置在现实中可达，没有进入棺内、人体、墙体或不可能空间
6. documentary_genre_ok：画面保持纪实可信度，不以惊悚、猎奇或预告片式夸张替代事实

墓地下葬默认棺盖关闭。只有当前旁白明确建立瞻仰遗容、遗体告别或开棺行为时，才允许展示遗体。

narration_match 必须按“静音可读”严格判定：忽略预期描述里声称但画面实际没有的内容；最终画面至少要给出旁白核心人物、动作或结果的一项直接可见证据。证据优先级是正在发生的直接事件 > 已发生事件留下的后果痕迹 > 可信证据现场与后期信息层。仅仅在年代、地点或气氛上沾边，仍然判 false。记者询问、店员摇头、人物写字、拿书本或钱包、挂钥匙、看文件等泛化调查 B-roll，不能替代逃藏、下葬、冲突、发现等核心事件。只有当这些动作本身就是旁白事件，或已声明的后期信息层与现场证据合起来能清楚表达核心关系时，才可通过。画面还必须抓住来自当前史实的决定性瞬间或异常后果；如果旁白包含危险、矛盾、发现、不可逆结果或规模变化，画面或信息层必须显出这个注意力锚点，不能只是人物无变化地摆姿势。若旁白同时包含单帧不能共存的多个时态、地点或事件，也判 false，并在 issues 中写明“应先拆镜”。

只输出严格 JSON：{"narration_match":true|false,"era_ok":true|false,"text_clean":true|false,"reality_ok":true|false,"camera_access_ok":true|false,"documentary_genre_ok":true|false,"issues":["用中文简短列出发现的问题，无问题则为空数组"]}`
}

export function buildGridReviewUserText(context: {
  expectedDesc: string
  narration: string
  location: string
  time: string
  dramaTitle: string
  graphic?: unknown
}): string {
  return [
    `剧集：《${context.dramaTitle}》`,
    `当前旁白（事实与语义依据）：${context.narration}`,
    `地点：${context.location}`,
    `时间：${context.time}`,
    `后期信息层（成片会叠加；没有则为无）：${context.graphic ? JSON.stringify(context.graphic) : '无'}`,
    `预期描述（仅为待审核的画面方案，不是事实依据）：${context.expectedDesc}`,
  ].join('\n')
}

interface GridReviewJson {
  narration_match: boolean
  era_ok: boolean
  text_clean: boolean
  reality_ok: boolean
  camera_access_ok: boolean
  documentary_genre_ok: boolean
  issues?: string[]
}

export function parseGridReviewJson(text: string): GridReviewJson | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    const required = [
      'narration_match',
      'era_ok',
      'text_clean',
      'reality_ok',
      'camera_access_ok',
      'documentary_genre_ok',
    ]
    if (required.some((key) => typeof parsed[key] !== 'boolean')) return null
    return parsed
  } catch {
    return null
  }
}

function extractChatContent(raw: string): string {
  const trimmed = raw.trim()
  // SSE 流式格式：逐行 data: {...}，拼接 delta.content
  if (trimmed.startsWith('data:')) {
    let out = ''
    for (const line of trimmed.split('\n')) {
      const l = line.trim()
      if (!l.startsWith('data:') || l === 'data: [DONE]') continue
      try {
        const j = JSON.parse(l.slice(5).trim())
        out += j.choices?.[0]?.delta?.content || ''
      } catch {
        /* skip bad chunk */
      }
    }
    return out
  }
  try {
    const j = JSON.parse(trimmed)
    return String(j.choices?.[0]?.message?.content || '')
  } catch {
    return trimmed
  }
}

/** 通用 VLM 看图对话：system + 用户文本 + 若干本地图片，返回文本内容（供镜头设计等场景复用） */
export async function vlmChatWithImages(
  systemPrompt: string,
  userText: string,
  absImagePaths: string[],
  maxTokens = 600,
): Promise<string | null> {
  const cfg = getImageConfig()
  const content: any[] = [{ type: 'text', text: userText }]
  for (const p of absImagePaths) {
    if (!fs.existsSync(p)) continue
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}` } })
  }
  if (content.length < 2) return null
  const body = {
    model: VLM_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
  }
  try {
    const res = await aiFetch('apimart', `${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return extractChatContent(await res.text()) || null
  } catch {
    return null
  }
}

async function vlmReviewCell(
  cfg: { baseUrl: string; apiKey: string },
  absPath: string,
  context: {
    expectedDesc: string
    narration: string
    location: string
    time: string
    dramaTitle: string
    graphic?: unknown
  },
): Promise<{ verdict: Omit<CellReviewVerdict, 'structural'> | null; error?: string }> {
  const b64 = fs.readFileSync(absPath).toString('base64')
  const body = {
    model: VLM_MODEL,
    messages: [
      { role: 'system', content: buildGridReviewSystemPrompt() },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildGridReviewUserText(context),
          },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 300,
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response
    try {
      res = await aiFetch('apimart', `${cfg.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
      })
    } catch (error: any) {
      return { verdict: null, error: `vlm unavailable: ${String(error?.message || error).slice(0, 120)}` }
    }
    if (!res.ok) return { verdict: null, error: `vlm HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` }
    const content = extractChatContent(await res.text())
    const parsed = parseGridReviewJson(content)
    if (parsed) {
      const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String).slice(0, 5) : []
      return {
        verdict: {
          pass: parsed.narration_match
            && parsed.era_ok
            && parsed.text_clean
            && parsed.reality_ok
            && parsed.camera_access_ok
            && parsed.documentary_genre_ok,
          issues,
          vlm: true,
        },
      }
    }
  }
  return { verdict: null, error: 'vlm 两次均未返回合法 JSON' }
}

function readGrid(sb: any): { theme: string; cells: any[] } | null {
  try {
    const raw = sb.gridCells ? JSON.parse(sb.gridCells) : null
    return [1, 2].includes(raw?.cells?.length) ? raw : null
  } catch {
    return null
  }
}

function writeGrid(sbId: number, grid: { theme: string; look?: unknown }, cells: any[]) {
  db.update(schema.storyboards)
    .set({ gridCells: JSON.stringify({ ...grid, cells }), updatedAt: now() })
    .where(eq(schema.storyboards.id, sbId))
    .run()
}

async function reviewStoryboard(
  cfg: { baseUrl: string; apiKey: string },
  sb: any,
  dramaTitle: string,
): Promise<{ cells: any[]; passAll: boolean }> {
  const grid = readGrid(sb)!
  const results: any[] = []
  let passAll = true
  for (let i = 0; i < grid.cells.length; i++) {
    const cell = grid.cells[i]
    const abs = cell.src ? resolveStaticPath(String(cell.src)) : ''
    const structuralIssues = abs ? await structuralCheck(abs) : ['file missing']
    let verdict: CellReviewVerdict
    if (structuralIssues.length) {
      verdict = { pass: false, issues: structuralIssues, structural: false, vlm: false }
    } else {
      const v = await vlmReviewCell(cfg, abs, {
        expectedDesc: String(cell.description || ''),
        narration: String(sb.narration || sb.description || ''),
        location: String(sb.location || ''),
        time: String(sb.time || ''),
        dramaTitle,
        graphic: cell.graphic,
      })
      verdict = v.verdict
        ? { ...v.verdict, structural: true }
        : { pass: true, issues: [`vlm 不可用: ${v.error}（仅结构检查通过）`], structural: true, vlm: false }
    }
    if (!verdict.pass) passAll = false
    results.push({ ...cell, review: verdict })
  }
  return { cells: results, passAll }
}

export async function reviewEpisodeGridCells(
  episodeId: number,
  opts: ReviewOptions = {},
  onProgress?: ProgressFn,
): Promise<{
  reviewed: number
  passed: number
  regenerated: number
  failedFinal: Array<{ storyboardId: number; storyboardNumber: number; issues: string[] }>
}> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
  const cfg = getImageConfig()
  const maxRetries = opts.maxRetries ?? 1

  const storyboards = db
    .select()
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter((sb) => !opts.onlyStoryboardIds || opts.onlyStoryboardIds.includes(sb.id))
    .filter((sb) => {
      const grid = readGrid(sb)
      return grid && sb.gridSheetImage && grid.cells.every((c: any) => c.src)
    })

  let reviewed = 0
  let passed = 0
  let regenerated = 0
  const failedFinal: Array<{ storyboardId: number; storyboardNumber: number; issues: string[] }> = []

  for (const sb of storyboards) {
    onProgress?.(reviewed, storyboards.length, `六维审查 sb${sb.storyboardNumber}「${sb.title || ''}」`)
    let { cells, passAll } = await reviewStoryboard(cfg, sb, drama?.title || '')
    reviewed++

    if (!passAll && maxRetries > 0) {
      // 换种子重生一次并复审
      const gen = await generateEpisodeGridSheets(
        episodeId,
        {
          force: true,
          onlyStoryboardIds: [sb.id],
          useReferenceImages: opts.useReferenceImages,
        },
        onProgress,
      )
      if (gen.generated > 0) {
        regenerated++
        const [fresh] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).all()
        const retry = await reviewStoryboard(cfg, fresh, drama?.title || '')
        cells = retry.cells
        passAll = retry.passAll
      } else {
        const issues = gen.failed[0]?.error ? [gen.failed[0].error] : ['regenerate failed']
        cells = cells.map((c: any) => ({ ...c, review: { pass: false, issues, structural: true, vlm: true } }))
      }
    }

    if (passAll) passed++
    else {
      const issues = cells.flatMap((c: any) => c.review?.issues || [])
      failedFinal.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, issues })
    }

    const grid = readGrid(sb)
    writeGrid(sb.id, grid ?? { theme: '' }, cells)
  }

  onProgress?.(storyboards.length, storyboards.length, `六维审查完成 ${passed}/${storyboards.length}`)
  return { reviewed, passed, regenerated, failedFinal }
}
