#!/usr/bin/env node
/**
 * Create the next MiniMax narration voice from a constrained voice brief.
 *
 * This intentionally uses Voice Design instead of cloning download1111.mp4:
 * the reference is a compressed finished-video track, so cloning it would
 * preserve its delivery and mastering artifacts instead of only borrowing
 * its storyteller identity.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { joinProviderUrl } from '../src/services/adapters/url.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const PREVIEW_DIR = path.resolve(PROJECT_ROOT, 'data/static/voice_samples')

const VOICE_NAME = '北方紧弦说书男声·快叙'
const PROMPT = [
  '一位40岁以上的北方男性短视频说书人，成熟、有阅历，面向大众讲述历史、悬疑和人物往事。',
  '以自然标准普通话为主，带极轻微的北方语气和厚实的中低音，声音有温暖的胸腔共鸣和少量自然颗粒感。',
  '口腔和下颌放松，发声不挤、不尖、不喊，咬字清楚但不带播音腔。',
  '基础语速明显偏快，约每秒五到五点五个汉字；起句快、推进快、短停顿，不能慢悠悠，不能拖长句尾，不能留大段空白。',
  '表达时从第一句话起就非常紧绷，像危险正在逼近；气息持续向前，句与句之间有追赶感，关键人物、数字和转折连续落重音。',
  '他很有表演欲，善于在快速讲述中用短促停顿、突然压低和迅速抬高音势传递惊讶、压迫、讥讽、悲悯与反转。',
  '整体像极受欢迎的短视频说书人：紧、快、抓人、可信，但不尖叫、不浮夸、不油腻、不像新闻播报员，也不唱快板。',
].join(' ')

const PREVIEW_TEXT = '先别急着下结论，真正要命的不是案发那一刻，而是所有人都以为事情结束以后。就在这时，门外突然传来三声敲门！不轻，不重，可屋里的人一下全僵住了——因为这个敲门的人，三年前就已经死了。'

function nowIso() {
  return new Date().toISOString()
}

function getConfig() {
  return db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter((row) => row.isActive && row.provider?.toLowerCase() === 'minimax' && row.apiKey)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
}

async function main() {
  const config = getConfig()
  if (!config) throw new Error('未找到启用的 MiniMax 音频配置')
  fs.mkdirSync(PREVIEW_DIR, { recursive: true })

  const response = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/voice_design'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: PROMPT,
      preview_text: PREVIEW_TEXT,
      aigc_watermark: false,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const result = await response.json().catch(() => ({})) as any
  if (!response.ok || result.base_resp?.status_code !== 0) {
    throw new Error(`MiniMax Voice Design 失败: ${result.base_resp?.status_msg || response.statusText} (${response.status})`)
  }

  const voiceId = String(result.voice_id || '').trim()
  if (!voiceId) throw new Error('Voice Design 未返回 voice_id')

  const trialHex = String(result.trial_audio || '').trim()
  let previewPath: string | null = null
  if (trialHex && /^[0-9a-f]+$/i.test(trialHex) && trialHex.length % 2 === 0) {
    previewPath = path.join(PREVIEW_DIR, `${voiceId}_preview.mp3`)
    fs.writeFileSync(previewPath, Buffer.from(trialHex, 'hex'))
  }

  db.insert(schema.aiVoices).values({
    voiceId,
    voiceName: VOICE_NAME,
    description: JSON.stringify([PROMPT]),
    language: '中文',
    provider: 'minimax',
    voiceType: 'voice_generation',
    createdAt: nowIso(),
  }).onConflictDoUpdate({
    target: schema.aiVoices.voiceId,
    set: {
      voiceName: VOICE_NAME,
      description: JSON.stringify([PROMPT]),
      language: '中文',
      provider: 'minimax',
      voiceType: 'voice_generation',
    },
  }).run()

  console.log(JSON.stringify({
    voice_id: voiceId,
    voice_name: VOICE_NAME,
    preview_text: PREVIEW_TEXT,
    preview_path: previewPath,
    prompt: PROMPT,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
