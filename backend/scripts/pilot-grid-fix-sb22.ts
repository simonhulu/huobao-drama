/** 补跑 sb22：原拆帧含"割腕滴血"被内容策略拦截，换为"焚香盟誓"安全表述 */
import Database from 'better-sqlite3'
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const proxyUrl = process.env.IMAGE_HTTPS_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (dispatcher) return undiciFetch(url, { ...init, dispatcher } as any) as unknown as Response
  return fetch(url, init)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const OUT_DIR = path.join(repoRoot, 'data/pilot-grid/ep500_full/sb22')

function extractImageUrl(data: any): string | null {
  const firstImage = data?.result?.images?.[0]
  const url = firstImage?.url
  if (Array.isArray(url)) return url[0] || null
  if (typeof url === 'string') return url
  return data?.image_url || data?.url || data?.data?.[0]?.url || null
}

async function main() {
  const db = new Database(path.join(repoRoot, 'data/huobao_drama.db'), { readonly: true })
  const cfg = db.prepare(`SELECT * FROM ai_service_configs WHERE id = 6`).get() as any
  const apiKey = String(cfg.api_key ?? cfg.apiKey)
  const baseUrl = String(cfg.base_url).replace(/\/+$/, '')

  const prompt = [
    '一张左右双联电影分镜图，整体横屏16:9构图，恰好2个等大的竖幅格子（1行2列），格子之间有细窄深色分隔缝。2个格子是完全独立的画面，不要合并格子，不要跨格构图。',
    '这是一段历史纪录片旁白的2个配套画面，旁白主题是：清代民间秘密结社兴起，烛光香火中的盟誓与祈祷。两个格子分别解释旁白的两个关键信息，内容必须明显不同，但保持统一的美术风格与纪录片质感。',
    '左格：竖幅构图，昏暗祠堂内，几名清代布衣男子在供桌前焚香盟誓，双手高举线香过头；前景香炉青烟缭绕，后景神像与旗幡在烟雾中若隐若现；左上方烛光投射暖黄光影。',
    '右格：竖幅构图，堂屋内众多信徒跪坐焚香祷告，神情虔诚；前景火盆炽焰映亮人脸，后景梁柱悬挂符幡，烟雾升腾；烛光与火光交织暖橙色调。',
    '构图要求：两格均为竖幅电影构图，主体按三分法放置（避免死板居中），有明确的前景、中景、背景三层纵深，利用引导线把视线引向主体，光影有明确方向性。',
    '统一风格：电影级写实纪录片质感，cinematic，胶片颗粒，画面细节丰富。画面中不要出现任何文字、字幕、数字、水印或标识。',
  ].join('\n')

  fs.writeFileSync(path.join(OUT_DIR, 'prompt.txt'), prompt)
  const res = await apiFetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '16:9', resolution: '1k', n: 1, seed: 200022 }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const result = await res.json()
  const first = Array.isArray(result?.data) ? result.data[0] : result?.data
  let imageUrl = extractImageUrl(first ?? result)
  if (!imageUrl) {
    const taskId = result.task_id || first?.task_id || first?.id || result.id
    const deadline = Date.now() + 8 * 60_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000))
      const poll = await apiFetch(`${baseUrl}/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } })
      if (!poll.ok) continue
      const pr = await poll.json()
      const data = Array.isArray(pr?.data) ? pr.data[0] : (pr?.data ?? pr)
      const status = String(data.status || '').toLowerCase()
      if (status === 'completed' || status === 'succeeded' || status === 'success') {
        imageUrl = extractImageUrl(data)
        break
      }
      if (status === 'failed' || status === 'error' || status === 'cancelled') {
        throw new Error(`task failed: ${JSON.stringify(data).slice(0, 300)}`)
      }
    }
  }
  if (!imageUrl) throw new Error('no image url')
  const imgRes = await apiFetch(imageUrl)
  const buf = Buffer.from(await imgRes.arrayBuffer())
  fs.writeFileSync(path.join(OUT_DIR, 'sheet.png'), buf)
  const meta = await sharp(buf).metadata()
  const cellW = Math.floor((meta.width || 0) / 2)
  for (let c = 0; c < 2; c++) {
    await sharp(buf).extract({ left: c * cellW, top: 0, width: cellW, height: meta.height }).toFile(path.join(OUT_DIR, `cell_${c + 1}.png`))
  }
  console.log(`sb22 done: ${meta.width}x${meta.height}`)
}
main().catch((e) => { console.error('FATAL:', e.message || e); process.exit(1) })
