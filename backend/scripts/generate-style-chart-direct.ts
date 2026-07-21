/**
 * 直接调用 apimart API 生成风格示意图（绕过 backend executeImageGeneration）
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { applyVisualStyle } from '../src/services/visual-style.js'
import { getActiveConfig } from '../src/services/ai.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const outputDir = path.resolve(repoRoot, 'data/temp/style-chart')

const baseScene = `A still life on an old wooden table: a cracked ceramic vase, an ancient scroll, a single plum blossom branch, and a bronze incense burner. Soft morning window light, shallow depth of field, no text, no watermark.`

const CONCURRENCY = 3
const POLL_MAX_TRIES = 120

// 57 个 unique 视觉风格（与 frontend/app/pages/index.vue 的 styles 数组一致）
const styles = [
  // 通用 / 基础风格
  { key: 'generic', label: '通用（电影感）' },
  { key: 'realistic', label: '写实' },
  { key: 'cinematic', label: '电影' },
  { key: 'anime', label: '二次元' },
  { key: 'ghibli', label: '吉卜力' },
  { key: 'comic', label: '漫画' },
  { key: 'watercolor', label: '水彩' },

  // 电影摄影风格（导演 / 镜头语言）
  { key: 'wes_anderson', label: '韦斯·安德森' },
  { key: 'film_noir', label: '黑色电影' },
  { key: 'rembrandt', label: '伦勃朗光' },
  { key: 'villeneuve', label: '维伦纽瓦史诗' },
  { key: 'wong_kar_wai', label: '王家卫' },
  { key: 'documentary', label: '纪录片' },
  { key: 'vintage_film', label: '复古胶片' },

  // 艺术绘画
  { key: 'oil_painting', label: '油画' },
  { key: 'pastel', label: '色粉画' },
  { key: 'ink_wash', label: '水墨' },
  { key: 'ukiyo_e', label: '浮世绘' },
  { key: 'impressionist', label: '印象派' },
  { key: 'pop_art', label: '波普艺术' },
  { key: 'renaissance', label: '文艺复兴' },
  { key: 'baroque', label: '巴洛克' },
  { key: 'neoclassical', label: '新古典主义' },

  // 视觉氛围
  { key: 'cyberpunk', label: '赛博朋克' },
  { key: 'steampunk', label: '蒸汽朋克' },
  { key: 'fantasy', label: '奇幻' },
  { key: 'noir', label: '黑色电影' },
  { key: 'vintage', label: '复古' },
  { key: 'minimalist', label: '极简' },
  { key: 'dark_academia', label: '暗黑学院' },

  // 媒介渲染
  { key: 'digital_art', label: '数字艺术' },
  { key: 'concept_art', label: '概念艺术' },
  { key: 'pixel_art', label: '像素风' },
  { key: 'line_art', label: '线稿' },
  { key: '3d_render', label: '3D 渲染' },
  { key: 'isometric', label: '等距插画' },

  // 中式 / 东方历史
  { key: 'chinese_ink', label: '中式水墨' },
  { key: 'chinese_gongbi', label: '工笔重彩' },
  { key: 'wuxia', label: '武侠' },
  { key: 'chinese_palace', label: '宫廷国风' },
  { key: 'eastern_fantasy', label: '东方玄幻' },
  { key: 'ukiyo_samurai', label: '浮世绘武士' },

  // 西方 / 世界历史
  { key: 'historical', label: '历史史诗' },
  { key: 'historical_epic', label: '历史史诗' },
  { key: 'roman_fresco', label: '古罗马壁画' },
  { key: 'byzantine', label: '拜占庭圣像' },
  { key: 'medieval_manuscript', label: '中世纪手抄本' },
  { key: 'dutch_golden_age', label: '荷兰黄金时代' },
  { key: 'victorian', label: '维多利亚' },
  { key: 'prohibition_era', label: '禁酒令时代' },
  { key: 'wwii_photo', label: '二战纪实' },

  // 高级主题风格
  { key: 'scifi', label: '科幻' },
  { key: 'mythology', label: '神话 / 奇幻' },
  { key: 'space', label: '太空' },
  { key: 'deepsea', label: '深海' },
  { key: 'ancient', label: '古文明' },
  { key: 'wasteland', label: '末日废土' },
]

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchWithProxy(url: string, init: any) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  const agent = proxy ? new ProxyAgent(proxy) : undefined
  return undiciFetch(url, { ...init, dispatcher: agent })
}

async function submitTask(config: any, prompt: string, style: string): Promise<string> {
  const url = `${config.baseUrl}/v1/images/generations`
  const body = {
    model: config.model || 'gpt-image-2',
    prompt,
    size: '1:1',
    resolution: '1k',
    n: 1,
  }
  log(`[${style}] POST ${url}`)
  const resp = await fetchWithProxy(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  log(`[${style}] submit response: ${resp.status} ${text}`)
  if (!resp.ok) throw new Error(`Submit failed: ${resp.status} ${text}`)
  const data = JSON.parse(text)
  const taskId = data.data?.[0]?.task_id || data.task_id
  if (!taskId) throw new Error(`No task_id in response: ${text}`)
  return taskId
}

async function pollTask(config: any, taskId: string, style: string): Promise<string> {
  const url = `${config.baseUrl}/v1/tasks/${taskId}`
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await sleep(5000)
    const resp = await fetchWithProxy(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
    })
    const text = await resp.text()
    log(`[${style}] poll ${i + 1}: ${resp.status} ${text}`)
    if (!resp.ok) continue
    const data = JSON.parse(text).data
    const status = String(data.status || '').toLowerCase()
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const url = data.result?.images?.[0]?.url
      return Array.isArray(url) ? url[0] : url
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw new Error(`Task failed: ${JSON.stringify(data.error || data)}`)
    }
  }
  throw new Error('Polling timeout')
}

async function downloadImage(imageUrl: string, destPath: string) {
  const resp = await fetchWithProxy(imageUrl, { method: 'GET' })
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)
  const buffer = Buffer.from(await resp.arrayBuffer())
  fs.writeFileSync(destPath, buffer)
}

async function generateForStyle(
  config: any,
  style: { key: string; label: string },
): Promise<{ key: string; label: string; localPath: string } | null> {
  try {
    const prompt = applyVisualStyle(baseScene, style.key)
    log(`[${style.label}] prompt: ${prompt.slice(0, 100)}...`)
    const taskId = await submitTask(config, prompt, style.label)
    const imageUrl = await pollTask(config, taskId, style.label)
    const ext = path.extname(new URL(imageUrl).pathname) || '.png'
    const dest = path.join(outputDir, `${style.key}${ext}`)
    await downloadImage(imageUrl, dest)
    log(`[${style.label}] saved -> ${dest}`)
    return { key: style.key, label: style.label, localPath: dest }
  } catch (err: any) {
    log(`[${style.label}] FAILED: ${err.message}`)
    return null
  }
}

async function asyncPool<T, R>(concurrency: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const executing: Set<Promise<void>> = new Set()
  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i])
      .then((r) => { results[i] = r })
      .finally(() => { executing.delete(p) })
    executing.add(p)
    if (executing.size >= concurrency) {
      await Promise.race(executing)
    }
  }
  await Promise.all(executing)
  return results
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  const config = getActiveConfig('image')
  if (!config) throw new Error('No active image config')
  log(`Using config: ${config.provider} ${config.model} ${config.baseUrl}`)

  const results = await asyncPool(CONCURRENCY, styles, (style) => generateForStyle(config, style))

  const valid = results.filter(Boolean) as Array<{ key: string; label: string; localPath: string }>
  log(`Success: ${valid.length}/${styles.length}`)
  if (valid.length === 0) return

  const metaPath = path.join(outputDir, 'meta.json')
  fs.writeFileSync(metaPath, JSON.stringify(valid, null, 2))

  const { spawn } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('data/temp/venv-style-chart/bin/python3', [
      path.resolve(repoRoot, 'backend/scripts/compose-style-grid.py'),
      outputDir,
    ], { cwd: repoRoot, stdio: 'inherit' })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`compose exited ${code}`))))
  })

  // 同步到 data/static，便于后端 /static/style_grid.jpg 直接提供
  const staticGridPath = path.resolve(repoRoot, 'data/static/style_grid.jpg')
  const generatedGridPath = path.join(outputDir, 'style_grid.jpg')
  fs.copyFileSync(generatedGridPath, staticGridPath)
  log(`Copied grid -> ${staticGridPath}`)

  // 同步单图到 data/static/style-chart/，便于按风格展示
  const staticStyleDir = path.resolve(repoRoot, 'data/static/style-chart')
  fs.mkdirSync(staticStyleDir, { recursive: true })
  for (const item of valid) {
    const dest = path.join(staticStyleDir, `${item.key}${path.extname(item.localPath)}`)
    fs.copyFileSync(item.localPath, dest)
    log(`Copied style image -> ${dest}`)
  }
}

main().catch((err) => {
  log(`Fatal: ${err.message}`)
  process.exit(1)
})
