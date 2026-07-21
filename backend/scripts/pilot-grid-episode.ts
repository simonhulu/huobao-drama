/**
 * 双宫格流水线整集试点（episode 500，33 个镜头）
 * 流程：旁白拆帧(deepseek) → 双宫格生成(apimart 1K) → 切分(sharp) → GridStoryPreview props
 * v7 冻结规格：竖幅2宫格 / 构图四要素(三分法·分层·引导线·方向光) / 图片零文字(文字走叠加层) /
 *              运镜语法(push·pull·tiltDown·tiltUp·hold) / 过场语法(cut·dissolve·fade·reveal仅开场一次)
 * 产物：data/pilot-grid/ep500_full/ + data/temp/grid-episode-500-props.json，不碰任何生产表
 * 运行: cd backend && node run-tsx.mjs scripts/pilot-grid-episode.ts
 */
import Database from 'better-sqlite3'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const proxyUrl =
  process.env.IMAGE_HTTPS_PROXY || process.env.HTTPS_PROXY || process.env.IMAGE_HTTP_PROXY || process.env.HTTP_PROXY
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
if (dispatcher) console.log(`using proxy: ${proxyUrl}`)

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (dispatcher) return undiciFetch(url, { ...init, dispatcher } as any) as unknown as Response
  return fetch(url, init)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const DB_PATH = path.join(repoRoot, 'data/huobao_drama.db')
const OUT_ROOT = path.join(repoRoot, 'data/pilot-grid/ep500_full')
const PUBLIC_DIR = path.join(repoRoot, 'remotion/public/grid-ep500')
const PROPS_PATH = path.join(repoRoot, 'data/temp/grid-episode-500-props.json')
const EPISODE_ID = 500

const MOVES = ['push', 'pull', 'tiltDown', 'tiltUp', 'hold'] as const
const ENTERS = ['cut', 'dissolve', 'fade'] as const
type Move = (typeof MOVES)[number]
type Enter = (typeof ENTERS)[number]

type Beat = {
  description: string
  move: Move
  enter: Enter
  enterFrames?: number
  text?: { content: string; fontSize?: number }
}
type Decomp = { theme: string; beats: Beat[] }

// ---------- LLM 拆帧 ----------
const SYSTEM_PROMPT = `你是历史纪录片的视觉导演。把一个镜头的旁白拆成左右两格竖幅画面（双宫格），并给出每格的运镜与过场方式。只输出严格 JSON，不要输出任何其他内容。

JSON 结构：
{
  "theme": "本镜头主题与主色调倾向（中文，25字内）",
  "beats": [
    {
      "description": "竖幅画面描述（中文，70字内）：主体及位置（三分法）+ 前/中/后景分层 + 光影方向 + 色调",
      "move": "push|pull|tiltDown|tiltUp|hold 之一",
      "enter": "cut|dissolve|fade 之一",
      "enterFrames": 可选，数字（dissolve 取 15-24，fade 取 10-14）,
      "text": 可选，{"content": "叠加文字", "fontSize": 可选数字}
    }
  ]
}

硬性规则：
1. beats 恰好 2 个，分别承担旁白的两个关键信息，内容必须不同但风格统一。
2. 画面里绝对不要出现任何文字、数字、字幕、印章（信息性文字放进 text 字段，由后期叠加层承担）。
3. 时代自洽：1850年代清代中国的道具、服饰、建筑、器物，禁止现代物品、现代字体。
4. move 规则：push=聚焦/逼近/情绪收紧；pull=揭示规模/释然；tiltDown=从天空/高处落到主体；tiltUp=从地面/细节升向主体；hold=信息密度高的画面近乎静止。
5. enter 规则（剪辑语法）：cut=同场景节拍切换（默认）；dissolve=时间流逝/回忆/地点跳转；fade=章节/话题转换。第一格一般用 cut。
6. text 字段只在旁白包含明确年份/地点/人名等"信息本体"时使用，content ≤6 字。
7. 竖幅竖构图：上（天空/氛围）、中（主体）、下（前景）三段分层。`

function userPrompt(sb: any, chars: Array<{ name: string | null; appearance: string | null }>): string {
  const charLine = chars.length
    ? `\n出场角色（外观需写进对应画面）：${chars.map((c) => `${c.name}（${c.appearance || '外观未设定'}）`).join('、')}`
    : ''
  return `镜头标题：${sb.title || ''}
旁白：${sb.description || ''}
场景：${sb.location || '未设定'}；时间：${sb.time || '未设定'}；景别：${sb.shotType || '未设定'}
原画面构想（可参考）：${(sb.action || '').slice(0, 120)}${charLine}
请输出拆帧 JSON。`
}

function validateDecomp(raw: any): Decomp | null {
  if (!raw || typeof raw.theme !== 'string' || !Array.isArray(raw.beats) || raw.beats.length !== 2) return null
  for (const b of raw.beats) {
    if (typeof b.description !== 'string' || !b.description.trim()) return null
    if (!MOVES.includes(b.move)) return null
    if (!ENTERS.includes(b.enter)) return null
    if (b.text != null && (typeof b.text.content !== 'string' || !b.text.content.trim())) return null
  }
  return raw as Decomp
}

async function decomposeShot(
  llm: { baseUrl: string; apiKey: string; model: string },
  sb: any,
  chars: Array<{ name: string | null; appearance: string | null }>,
): Promise<Decomp> {
  const body = {
    model: llm.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(sb, chars) },
    ],
    temperature: 0.7,
    response_format: { type: 'json_object' },
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await apiFetch(`${llm.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(attempt === 1 ? body : { ...body, response_format: undefined }),
    })
    if (!res.ok) throw new Error(`llm HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    const content = json.choices?.[0]?.message?.content || ''
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    try {
      const parsed = validateDecomp(JSON.parse(cleaned))
      if (parsed) return parsed
    } catch {
      /* fallthrough to retry */
    }
  }
  throw new Error('llm 拆帧两次均未返回合法 JSON')
}

// ---------- 图片生成 ----------
function buildSheetPrompt(theme: string, beats: Beat[]): string {
  const [b1, b2] = beats
  return [
    `一张左右双联电影分镜图，整体横屏16:9构图，恰好2个等大的竖幅格子（1行2列），格子之间有细窄深色分隔缝。2个格子是完全独立的画面，不要合并格子，不要跨格构图。`,
    `这是一段历史纪录片旁白的2个配套画面，旁白主题是：${theme}。两个格子分别解释旁白的两个关键信息，内容必须明显不同，但保持统一的美术风格与纪录片质感。`,
    `左格：${b1.description}。`,
    `右格：${b2.description}。`,
    `构图要求：两格均为竖幅电影构图，主体按三分法放置（避免死板居中），有明确的前景、中景、背景三层纵深，利用引导线把视线引向主体，光影有明确方向性。`,
    `统一风格：电影级写实纪录片质感，cinematic，胶片颗粒，画面细节丰富。画面中不要出现任何文字、字幕、数字、水印或标识。`,
  ].join('\n')
}

function extractImageUrl(data: any): string | null {
  const firstImage = data?.result?.images?.[0]
  const url = firstImage?.url
  if (Array.isArray(url)) return url[0] || null
  if (typeof url === 'string') return url
  return data?.image_url || data?.url || data?.data?.[0]?.url || null
}

async function generateSheet(
  cfg: { baseUrl: string; apiKey: string },
  prompt: string,
  seed: number,
): Promise<Buffer> {
  const res = await apiFetch(`${cfg.baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '16:9', resolution: '1k', n: 1, seed }),
  })
  if (!res.ok) throw new Error(`generate HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const result = await res.json()
  const first = Array.isArray(result?.data) ? result.data[0] : result?.data

  const syncUrl = extractImageUrl(first ?? result)
  if (syncUrl) return downloadImage(syncUrl)

  const taskId = result.task_id || first?.task_id || first?.id || result.id
  if (!taskId) throw new Error(`no task_id: ${JSON.stringify(result).slice(0, 300)}`)

  const deadline = Date.now() + 8 * 60_000
  let pollPath = `/v1/tasks/${taskId}`
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    let poll = await apiFetch(`${cfg.baseUrl}${pollPath}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
    if (poll.status === 404 && pollPath.startsWith('/v1/tasks/')) {
      pollPath = `/v1/images/task/${taskId}`
      poll = await apiFetch(`${cfg.baseUrl}${pollPath}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
    }
    if (!poll.ok) continue
    const pr = await poll.json()
    const data = Array.isArray(pr?.data) ? pr.data[0] : (pr?.data ?? pr)
    const status = String(data.status || '').toLowerCase()
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const url = extractImageUrl(data)
      if (!url) throw new Error('completed but no image url')
      return downloadImage(url)
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(`task failed: ${JSON.stringify(data).slice(0, 300)}`)
    }
  }
  throw new Error('poll timeout (8min)')
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await apiFetch(url)
  if (!res.ok) throw new Error(`download HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function runPool<T, R>(items: T[], size: number, worker: (item: T, idx: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    const settled = await Promise.allSettled(chunk.map((item, j) => worker(item, i + j)))
    results.push(...settled)
  }
  return results
}

// ---------- 主流程 ----------
async function main() {
  const db = new Database(DB_PATH, { readonly: true })
  const imgCfg = db.prepare(`SELECT * FROM ai_service_configs WHERE id = 6`).get() as any
  const llmCfg = db.prepare(`SELECT * FROM ai_service_configs WHERE id = 1`).get() as any
  const llm = {
    baseUrl: String(llmCfg.base_url).replace(/\/+$/, ''),
    apiKey: String(llmCfg.api_key ?? llmCfg.apiKey),
    model: JSON.parse(llmCfg.model)[0],
  }
  const img = {
    baseUrl: String(imgCfg.base_url).replace(/\/+$/, ''),
    apiKey: String(imgCfg.api_key ?? imgCfg.apiKey),
  }
  console.log(`llm=${llm.model}@${llm.baseUrl} img=apimart/gpt-image-2`)

  const storyboards = db
    .prepare(
      `SELECT id, storyboard_number AS sb, title, description, duration, narration_audio_url AS audio, location, time, shot_type AS shotType, action
       FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number`,
    )
    .all(EPISODE_ID) as any[]
  console.log(`episode ${EPISODE_ID}: ${storyboards.length} 个镜头`)

  const links = db
    .prepare(
      `SELECT sc.storyboard_id AS sid, c.name, c.appearance FROM storyboard_characters sc
       JOIN characters c ON c.id = sc.character_id
       JOIN storyboards s ON s.id = sc.storyboard_id WHERE s.episode_id = ?`,
    )
    .all(EPISODE_ID) as any[]
  const charsBySb = new Map<number, Array<{ name: string | null; appearance: string | null }>>()
  for (const l of links) {
    if (!charsBySb.has(l.sid)) charsBySb.set(l.sid, [])
    charsBySb.get(l.sid)!.push({ name: l.name, appearance: l.appearance })
  }

  // 阶段1：LLM 拆帧
  console.log('--- 阶段1：LLM 拆帧 ---')
  const decompResults = await runPool(storyboards, 5, async (sb) => decomposeShot(llm, sb, charsBySb.get(sb.id) || []))
  const decomps: Array<Decomp | null> = decompResults.map((r) => (r.status === 'fulfilled' ? r.value : null))
  const decompFailed = decompResults.map((r, i) => (r.status === 'rejected' ? storyboards[i].sb : null)).filter(Boolean)
  if (decompFailed.length) console.log(`拆帧失败镜头: ${decompFailed.join(',')}`)

  fs.mkdirSync(OUT_ROOT, { recursive: true })
  fs.writeFileSync(
    path.join(OUT_ROOT, 'decomposition.json'),
    JSON.stringify(storyboards.map((sb, i) => ({ sb: sb.sb, title: sb.title, decomp: decomps[i] })), null, 2),
  )
  for (let i = 0; i < Math.min(3, storyboards.length); i++) {
    console.log(`  sb${storyboards[i].sb}「${storyboards[i].title}」: ${decomps[i]?.theme}`)
  }

  // 阶段2：双宫格生成 + 切分
  console.log('--- 阶段2：双宫格生成 ---')
  const genTargets = storyboards
    .map((sb, i) => ({ sb, decomp: decomps[i] }))
    .filter((t): t is { sb: any; decomp: Decomp } => t.decomp != null)

  const genResults = await runPool(genTargets, 3, async ({ sb, decomp }) => {
    const dir = path.join(OUT_ROOT, `sb${sb.sb}`)
    fs.mkdirSync(dir, { recursive: true })
    const prompt = buildSheetPrompt(decomp.theme, decomp.beats)
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt)
    const buf = await generateSheet(img, prompt, 200000 + sb.id)
    fs.writeFileSync(path.join(dir, 'sheet.png'), buf)
    const meta = await sharp(buf).metadata()
    const cellW = Math.floor((meta.width || 0) / 2)
    for (let c = 0; c < 2; c++) {
      await sharp(buf)
        .extract({ left: c * cellW, top: 0, width: cellW, height: meta.height })
        .toFile(path.join(dir, `cell_${c + 1}.png`))
    }
    return { sb: sb.sb, w: meta.width, h: meta.height }
  })
  const genOk = new Set(genResults.filter((r) => r.status === 'fulfilled').map((r: any) => r.value.sb))
  const genFailed = genTargets.filter((t) => !genOk.has(t.sb.sb)).map((t) => t.sb.sb)
  console.log(`生成成功 ${genOk.size}/${genTargets.length}，失败: ${genFailed.join(',') || '无'}`)

  // 阶段3：拷贝素材 + 组装 props
  console.log('--- 阶段3：组装 props ---')
  fs.mkdirSync(path.join(PUBLIC_DIR, 'audio'), { recursive: true })
  const fps = 30
  const shots: any[] = []
  for (let i = 0; i < storyboards.length; i++) {
    const sb = storyboards[i]
    const decomp = decomps[i]
    if (!decomp || !genOk.has(sb.sb)) continue
    for (let c = 1; c <= 2; c++) {
      fs.copyFileSync(path.join(OUT_ROOT, `sb${sb.sb}`, `cell_${c}.png`), path.join(PUBLIC_DIR, `sb${sb.sb}_cell${c}.png`))
    }
    const audioRel = String(sb.audio || '')
    const audioAbs = audioRel ? path.join(repoRoot, 'data', audioRel) : null
    let audioPath = ''
    if (audioAbs && fs.existsSync(audioAbs)) {
      audioPath = `grid-ep500/audio/sb${sb.sb}.m4a`
      fs.copyFileSync(audioAbs, path.join(PUBLIC_DIR, 'audio', `sb${sb.sb}.m4a`))
    }
    shots.push({
      title: sb.title || `镜头${sb.sb}`,
      narration: String(sb.description || '').replace(/\s+/g, ''),
      audio: audioPath,
      cells: decomp.beats.map((b, c) => ({
        src: `grid-ep500/sb${sb.sb}_cell${c + 1}.png`,
        move: b.move,
        enter: b.enter,
        ...(b.enterFrames ? { enterFrames: b.enterFrames } : {}),
        ...(b.text ? { text: b.text } : {}),
      })),
      durationInFrames: Math.max(60, Math.round((sb.duration || 8) * fps)),
    })
  }
  // 显影签名：全片仅第一镜第一格
  if (shots.length) shots[0].cells[0].enter = 'reveal'

  const total = shots.reduce((a, s) => a + s.durationInFrames, 0)
  fs.writeFileSync(PROPS_PATH, JSON.stringify({ durationInFrames: total, shots }, null, 2))
  console.log(`props: ${shots.length} shots, ${total} frames (${(total / fps).toFixed(1)}s) -> ${PROPS_PATH}`)
  console.log('done')
}

main().catch((e) => {
  console.error('FATAL:', e.message || e)
  process.exit(1)
})
