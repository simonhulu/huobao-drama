#!/usr/bin/env node
/**
 * 以本地参考人声为基准，通过 MiniMax voice_clone 创建“大女主”自定义音色。
 *
 * 运行:
 *   cd backend && npx tsx scripts/design-daniangzhu-voice.ts
 *
 * 流程:
 *   1. 读取数据库中启用的 MiniMax 音频配置，获取 API Key 与 Base URL
 *   2. 上传 data/static/voice_samples/daniangzhu_source.mp3（purpose=voice_clone）
 *   3. 调用 /v1/voice_clone 创建自定义 voice_id，并生成试听音频
 *   4. 将新音色写入 ai_voices 表，下载试听文件到本地
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { joinProviderUrl } from '../src/services/adapters/url.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const SAMPLE_PATH = path.resolve(PROJECT_ROOT, 'data/static/voice_samples/daniangzhu_source.mp3')
const PREVIEW_DIR = path.resolve(PROJECT_ROOT, 'data/static/voice_samples')

const VOICE_NAME = '大女主'
const BASE_VOICE_ID = 'DaniangzhuVoice01'
const PREVIEW_TEXT = '我命由我不由天，既然这世间容不下我，那我便亲手改写这结局。'
const VOICE_DESCRIPTION = '成熟、自信、有张力的女性主角音色，普通话标准，语速稳健，带有一种历经沉浮后的笃定气场，适合大女主短剧的旁白与关键对白。'

function nowIso() {
  return new Date().toISOString()
}

async function getMinimaxAudioConfig() {
  const rows = db
    .select()
    .from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter((r) => r.isActive && r.provider === 'minimax' && r.apiKey)

  if (rows.length === 0) {
    throw new Error('未找到启用的 MiniMax 音频配置，请先在设置页面配置 audio/minimax 服务')
  }

  const cfg = rows[0]
  return {
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
  }
}

async function uploadAudio(baseUrl: string, apiKey: string, filePath: string) {
  const url = joinProviderUrl(baseUrl, '/v1', '/files/upload')
  const buffer = fs.readFileSync(filePath)
  const blob = new Blob([buffer], { type: 'audio/mpeg' })

  const form = new FormData()
  form.append('purpose', 'voice_clone')
  form.append('file', blob, path.basename(filePath))

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })

  const result = (await resp.json()) as any
  if (!resp.ok || result.base_resp?.status_code !== 0) {
    throw new Error(`上传音频失败: ${result.base_resp?.status_msg || resp.statusText} (${resp.status})`)
  }

  const fileId = result.file?.file_id
  if (!fileId) {
    throw new Error('上传音频成功但未返回 file_id')
  }

  console.log(`✅ 音频上传成功: file_id=${fileId}`)
  return fileId
}

async function cloneVoice(baseUrl: string, apiKey: string, fileId: number, voiceId: string) {
  const url = joinProviderUrl(baseUrl, '/v1', '/voice_clone')

  const body = {
    file_id: fileId,
    voice_id: voiceId,
    text: PREVIEW_TEXT,
    model: 'speech-2.8-hd',
    accuracy: 0.7,
    need_noise_reduction: false,
    need_volume_normalization: false,
    aigc_watermark: false,
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const result = (await resp.json()) as any
  if (!resp.ok || result.base_resp?.status_code !== 0) {
    throw new Error(`音色克隆失败: ${result.base_resp?.status_msg || resp.statusText} (${resp.status})`)
  }

  console.log(`✅ 音色克隆成功: voice_id=${voiceId}`)
  console.log(`   试听音频: ${result.demo_audio || '(未生成)'}`)
  console.log(`   音频信息:`, result.extra_info || {})

  return result
}

async function downloadPreview(demoUrl: string, voiceId: string) {
  if (!demoUrl) return null

  const ext = path.extname(new URL(demoUrl).pathname) || '.mp3'
  const outPath = path.resolve(PREVIEW_DIR, `${voiceId}_preview${ext}`)

  const resp = await fetch(demoUrl)
  if (!resp.ok) {
    console.warn(`⚠️ 试听音频下载失败: ${resp.statusText}`)
    return null
  }

  const buf = Buffer.from(await resp.arrayBuffer())
  fs.writeFileSync(outPath, buf)
  console.log(`✅ 试听音频已下载: ${outPath}`)
  return outPath
}

async function saveVoiceToDb(voiceId: string) {
  const existing = db
    .select()
    .from(schema.aiVoices)
    .where(eq(schema.aiVoices.voiceId, voiceId))
    .get()

  if (existing) {
    console.log(`ℹ️ ai_voices 中已存在 ${voiceId}，跳过插入`)
    return
  }

  db.insert(schema.aiVoices).values({
    voiceId,
    voiceName: VOICE_NAME,
    description: JSON.stringify([VOICE_DESCRIPTION]),
    language: '中文',
    provider: 'minimax',
    createdAt: nowIso(),
  }).run()

  console.log(`✅ 已写入 ai_voices 表: ${voiceId} / ${VOICE_NAME}`)
}

async function main() {
  if (!fs.existsSync(SAMPLE_PATH)) {
    throw new Error(`参考音频不存在: ${SAMPLE_PATH}\n请先从 MP4 提取并压缩音频。`)
  }

  fs.mkdirSync(PREVIEW_DIR, { recursive: true })

  const { baseUrl, apiKey } = await getMinimaxAudioConfig()
  console.log(`使用 MiniMax 配置: ${baseUrl}`)

  const fileId = await uploadAudio(baseUrl, apiKey, SAMPLE_PATH)
  const cloneResult = await cloneVoice(baseUrl, apiKey, fileId, BASE_VOICE_ID)
  await downloadPreview(cloneResult.demo_audio, BASE_VOICE_ID)
  await saveVoiceToDb(BASE_VOICE_ID)

  console.log('\n🎉 大女主音色已创建完成')
  console.log(`   voice_id : ${BASE_VOICE_ID}`)
  console.log(`   使用方式 : 在角色 / 旁白设置中选择「大女主」(${BASE_VOICE_ID})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
