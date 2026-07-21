/**
 * 异步生成风格示意图（带重试）
 *
 * 用同一个历史场景，在不同视觉风格下各生成一张图。
 * 每张图失败后会按指数退避重试，全部完成后用 PIL 拼成网格图。
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createImageGenerationRecord, executeImageGeneration } from '../src/services/image-generation.js'
import { applyVisualStyle } from '../src/services/visual-style.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const outputDir = path.resolve(repoRoot, 'data/temp/style-chart')
const statusPath = path.join(outputDir, 'status.json')

const baseScene = `A dignified Han-dynasty official in dark silk robes stands in a palace courtyard at dawn. Behind him are red palace pillars, golden dragon motifs, and distant misty mountains. He holds a bamboo scroll, his expression solemn and contemplative. Soft morning light, cinematic composition, no text, no watermark.`

const styles = [
  { key: 'realistic', label: '写实' },
  { key: 'cinematic', label: '电影' },
  { key: 'historical_epic', label: '历史史诗' },
  { key: 'documentary', label: '纪录片' },
  { key: 'villeneuve', label: '维伦纽瓦史诗' },
  { key: 'chinese_ink', label: '中式水墨' },
  { key: 'chinese_gongbi', label: '工笔重彩' },
  { key: 'wuxia', label: '武侠' },
  { key: 'oil_painting', label: '油画' },
]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function log(message: string) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${message}`)
}

function writeStatus(status: any) {
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2))
}

async function generateWithRetry(
  style: { key: string; label: string },
  maxRetries = 20,
): Promise<{ key: string; label: string; localPath: string } | null> {
  const prompt = applyVisualStyle(baseScene, style.key)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`[${style.label}] attempt ${attempt}/${maxRetries}`)
      const id = createImageGenerationRecord({
        prompt,
        style: style.key,
        size: '1024x1024',
      })
      const result = await executeImageGeneration(id)
      const ext = path.extname(result.local_path) || '.png'
      const dest = path.join(outputDir, `${style.key}${ext}`)
      fs.copyFileSync(result.local_path, dest)
      log(`[${style.label}] success -> ${dest}`)
      return { key: style.key, label: style.label, localPath: dest }
    } catch (err: any) {
      const errorMessage = err?.message || String(err)
      log(`[${style.label}] attempt ${attempt} failed: ${errorMessage}`)
      if (attempt === maxRetries) {
        log(`[${style.label}] giving up after ${maxRetries} attempts`)
        return null
      }
      // 指数退避：30s, 60s, 120s... 最长 5 分钟
      const delay = Math.min(30000 * 2 ** (attempt - 1), 300000)
      log(`[${style.label}] retrying in ${delay / 1000}s`)
      await sleep(delay)
    }
  }
  return null
}

async function composeGrid(results: Array<{ key: string; label: string; localPath: string } | null>) {
  const valid = results.filter((r): r is { key: string; label: string; localPath: string } => r !== null)
  if (valid.length === 0) {
    log('No successful generations, skipping grid composition')
    return
  }

  const metaPath = path.join(outputDir, 'meta.json')
  fs.writeFileSync(metaPath, JSON.stringify(valid, null, 2))

  // 调用 Python 脚本拼图
  const pythonScript = path.resolve(repoRoot, 'backend/scripts/compose-style-grid.py')
  const { spawn } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('data/temp/venv-style-chart/bin/python3', [pythonScript, outputDir], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Python compose exited with ${code}`))
    })
  })
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  log('Starting async style chart generation...')
  log(`Output dir: ${outputDir}`)

  writeStatus({ startedAt: new Date().toISOString(), status: 'running', progress: '0/9' })

  // 并行发起，每个风格独立重试
  const promises = styles.map(async (style, idx) => {
    const result = await generateWithRetry(style)
    const completed = (idx + 1).toString()
    writeStatus({ startedAt: new Date().toISOString(), status: 'running', progress: `${completed}/9`, lastCompleted: style.label })
    return result
  })

  const results = await Promise.all(promises)
  const successCount = results.filter(Boolean).length
  log(`Generation complete: ${successCount}/${styles.length} successful`)

  await composeGrid(results)

  writeStatus({
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: successCount === styles.length ? 'completed' : 'partial',
    progress: `${successCount}/${styles.length}`,
    gridPath: path.join(outputDir, 'style_grid.jpg'),
  })

  log('Done')
}

main().catch((err) => {
  log(`Fatal error: ${err?.message || String(err)}`)
  writeStatus({ status: 'failed', error: err?.message || String(err) })
  process.exit(1)
})
