/**
 * 生成风格示意图
 *
 * 用同一个历史场景，在不同视觉风格下各生成一张图，
 * 输出到 data/temp/style-chart/，供后续拼成网格风格图。
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

// 统一历史场景，避免主体变化干扰风格对比
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

async function generateForStyle(style: { key: string; label: string }): Promise<{ key: string; label: string; localPath: string }> {
  const prompt = applyVisualStyle(baseScene, style.key)
  console.log(`[${style.label}] Generating...`)
  console.log(`  prompt: ${prompt.slice(0, 120)}...`)

  const id = createImageGenerationRecord({
    prompt,
    style: style.key,
    size: '1024x1024',
  })

  const result = await executeImageGeneration(id)
  const ext = path.extname(result.local_path) || '.png'
  const dest = path.join(outputDir, `${style.key}${ext}`)
  fs.mkdirSync(outputDir, { recursive: true })
  fs.copyFileSync(result.local_path, dest)

  console.log(`[${style.label}] Done -> ${dest}`)
  return { key: style.key, label: style.label, localPath: dest }
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  console.log('Output dir:', outputDir)

  const results: Array<{ key: string; label: string; localPath: string }> = []
  for (const style of styles) {
    try {
      const r = await generateForStyle(style)
      results.push(r)
    } catch (err) {
      console.error(`[${style.label}] Failed:`, err)
    }
  }

  // 写入元数据，供 Python 拼图脚本读取
  const metaPath = path.join(outputDir, 'meta.json')
  fs.writeFileSync(metaPath, JSON.stringify(results, null, 2))
  console.log('Metadata:', metaPath)
}

main().catch((err) => {
  console.error('Script failed:', err)
  process.exit(1)
})
