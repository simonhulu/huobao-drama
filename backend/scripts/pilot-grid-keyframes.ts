/**
 * 2宫格试点（drama 114 / episode 500 前1分钟，镜头1-5）
 * v7 改动：4宫格改2宫格（左右排列，单格竖幅 836x941，像素翻倍）；
 * prompt 应用摄影学习成果：三分法、前中后景分层、引导线、方向性光影、主色调+点缀色。
 * 产物写入 data/pilot-grid/ep500_v7/，不碰任何生产表。
 * 运行: cd backend && node run-tsx.mjs scripts/pilot-grid-keyframes.ts
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
  if (dispatcher) {
    return undiciFetch(url, { ...init, dispatcher } as any) as unknown as Response
  }
  return fetch(url, init)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const DB_PATH = path.join(repoRoot, 'data/huobao_drama.db')
const OUT_ROOT = path.join(repoRoot, 'data/pilot-grid/ep500_v7')

type ShotSpec = {
  sb: number
  theme: string
  beats: [string, string] // 左格 / 右格
  seed: number
}

const SHOTS: ShotSpec[] = [
  {
    sb: 1,
    theme: '太平天国距今仅170年，却深刻影响了中国近代史。暗金主色调，黄旗为视觉焦点',
    beats: [
      '竖幅构图：博物馆展柜中一面残破的太平天国黄旗，一位观众的背影置于左下三分之一交点处仰头凝视；前景是虚化的展柜玻璃反光，中景黄旗为主体，背景展厅射灯形成纵深光斑；顶光打在黄旗上，暗金色调',
      '竖幅构图：1850年代中国城池攻防战，前景城墙根下倒伏的断旗与散落兵器，中景蚁附攻城的军队洪流，背景浓烟遮蔽天空、仅顶部一线暗金色夕阳；地平线压在上三分之一线，烽金色调',
    ],
    seed: 187001,
  },
  {
    sb: 2,
    theme: '近代史难讲：离得太近资料太多，怎么评价争议太大。琥珀棕主色调，暖黄灯光点缀',
    beats: [
      '竖幅构图：昏暗书房中一位白发学者伏案于下三分之一横线、手扶额头；中景堆积如山的奏折与线装古籍环绕，背景高耸书架墙向上延伸没入黑暗；一盏暖黄台灯在右侧三分之一竖线处投下侧光，尘埃在光柱中漂浮，琥珀棕色调',
      '竖幅构图：一本上世纪七八十年代的老课本大特写，灰绿色布面卷边磨损，置于下三分之一横线；左侧暖光斜照拉出长影，背景是深度虚化的书架走廊、透视线形成引导线，暖怀旧色调',
    ],
    seed: 187002,
  },
  {
    sb: 3,
    theme: '核心追问：太平天国为什么偏偏在1850年代爆发。深褐暗黑主色调，火红点缀。画面必须纯净无任何文字（文字由后期叠加层承担）',
    beats: [
      '竖幅构图：昏暗清代书房内，一张泛黄的毛边宣纸平铺在旧木桌中央，纸面完全空白、没有任何字迹墨迹，纸边微微卷起；一侧烛台的烛火摇曳，暖光照亮纸面中央；背景书架隐入黑暗，神秘凝重。纸面和背景中不要出现任何文字、数字、印章、字迹',
      '竖幅构图：泛黄日历纸页大特写，纸页褶皱与纤维纹理清晰；纸页上缘透出背后战火般的红色光晕向上蔓延，明暗对比强烈，暗示"爆发"将至。不要任何文字',
    ],
    seed: 187003,
  },
  {
    sb: 4,
    theme: '1840年鸦片战争是门坎，太平天国紧随而来，内忧加外患一起发酵。左格冷灰蓝（外患），右格土黄（内忧），两格形成冷暖叙事对比',
    beats: [
      '竖幅构图：1840年珠江口海面，英国风帆战舰列阵于中景、舷侧火炮喷出白烟与火光；前景海浪翻涌，背景阴云低垂压在上三分之一线，冷灰蓝色调',
      '竖幅构图：干裂大地上饥民扶老携幼迁徙，前景龟裂土地的纹理特写，中景饥民队伍沿蜿蜒小路形成引导线，背景昏黄天空蝗虫漫天，土黄色调',
    ],
    seed: 187004,
  },
  {
    sb: 5,
    theme: '内因：盛极必衰，康乾盛世之后由盛转衰。左格金橙（盛世），右格土褐（衰败），两格形成盛衰色彩对比',
    beats: [
      '竖幅构图：康乾盛世的紫禁城，上三分之二为金色云海与初升朝阳，下三分之一为宫殿群深色剪影，庄严静观，金橙色调',
      '竖幅构图：黄昏荒田中一位老农扶犁而行的背影，置于右下三分之一交点；前景木犁与裂土，中景老农，背景昏黄远山与一缕孤烟，土褐色调',
    ],
    seed: 187005,
  },
]

function buildPrompt(shot: ShotSpec): string {
  const [b1, b2] = shot.beats
  return [
    `一张左右双联电影分镜图，整体横屏16:9构图，恰好2个等大的竖幅格子（1行2列），格子之间有细窄深色分隔缝。2个格子是完全独立的画面，不要合并格子，不要跨格构图。`,
    `这是一段历史纪录片旁白的2个配套画面，旁白主题是：${shot.theme}。两个格子分别解释旁白的两个关键信息，内容必须明显不同，但保持统一的美术风格与纪录片质感。`,
    `左格：${b1}。`,
    `右格：${b2}。`,
    `构图要求：两格均为竖幅电影构图，主体按三分法放置（避免死板居中），有明确的前景、中景、背景三层纵深，利用引导线把视线引向主体，光影有明确方向性。`,
    `统一风格：电影级写实纪录片质感，cinematic，胶片颗粒，画面细节丰富。除指定格子中明确要求的数字信息外，画面中不要出现任何其他文字、字幕、水印或标识。`,
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
  resolution: '1k' | '2k',
): Promise<Buffer> {
  const res = await apiFetch(`${cfg.baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '16:9', resolution, n: 1, seed }),
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

async function runJob(cfg: { baseUrl: string; apiKey: string }, shot: ShotSpec, resolution: '1k' | '2k') {
  const tag = `sb${shot.sb}_${resolution}`
  const outDir = path.join(OUT_ROOT, tag)
  fs.mkdirSync(outDir, { recursive: true })

  const prompt = buildPrompt(shot)
  fs.writeFileSync(path.join(outDir, 'prompt.txt'), prompt)

  const t0 = Date.now()
  const buf = await generateSheet(cfg, prompt, shot.seed, resolution)
  const sheetPath = path.join(outDir, 'sheet.png')
  fs.writeFileSync(sheetPath, buf)

  // 2宫格：1行2列
  const meta = await sharp(buf).metadata()
  const w = meta.width || 0
  const h = meta.height || 0
  const cellW = Math.floor(w / 2)
  for (let i = 0; i < 2; i++) {
    await sharp(buf)
      .extract({ left: i * cellW, top: 0, width: cellW, height: h })
      .toFile(path.join(outDir, `cell_${i + 1}.png`))
  }
  console.log(`[done] ${tag}: sheet ${w}x${h}, cells ${cellW}x${h}, ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outDir}`)
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true })
  const cfg = db.prepare(`SELECT * FROM ai_service_configs WHERE id = 6`).get() as any
  const apiKey = cfg.api_key ?? cfg.apiKey
  if (!cfg.base_url || !apiKey) throw new Error(`config incomplete, columns: ${Object.keys(cfg).join(',')}`)
  const config = { baseUrl: String(cfg.base_url).replace(/\/+$/, ''), apiKey: String(apiKey) }
  console.log(`provider=${cfg.provider} model=${cfg.model} baseUrl=${config.baseUrl}`)

  const jobs: Array<[ShotSpec, '1k' | '2k']> = [
    [SHOTS[2], '1k'],
  ]

  const results: Array<{ tag: string; ok: boolean; error?: string }> = []
  for (let i = 0; i < jobs.length; i += 3) {
    const chunk = jobs.slice(i, i + 3)
    const settled = await Promise.allSettled(
      chunk.map(([shot, res]) => runJob(config, shot, res).then(() => ({ tag: `sb${shot.sb}_${res}`, ok: true as const }))),
    )
    for (let idx = 0; idx < settled.length; idx++) {
      const s = settled[idx]
      const tag = `sb${chunk[idx][0].sb}_${chunk[idx][1]}`
      if (s.status === 'fulfilled') results.push(s.value)
      else results.push({ tag, ok: false, error: String(s.reason?.message || s.reason).slice(0, 300) })
    }
  }
  console.log('summary:', JSON.stringify(results, null, 2))
}

main().catch((e) => {
  console.error('FATAL:', e.message || e)
  process.exit(1)
})
