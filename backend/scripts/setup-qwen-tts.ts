import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { QWEN_TTS_MODEL, QWEN_TTS_PROVIDER, qwenTTSBaseUrl } from '../src/services/adapters/qwen-tts.js'
import { createQwenVoice, listQwenVoices, waitForQwenVoice } from '../src/services/qwen-tts-voices.js'
import { generateVoicePreview } from '../src/services/voice-preview.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const instruction = '保留参考人声独特的音色、颗粒感和自然口语感。像一位有阅历的历史讲述者面对面讲故事，开头带悬念，人物与转折落重音，推进时干脆有力，沉痛处放低声音并短暂停顿。情绪随内容自然起伏，克制但有张力，避免平铺直叙、播音腔、夸张喊叫和拖长尾音。只朗读正文，不朗读指令。'
const previewText = '那一夜，城门还没有关。所有人都以为，援军就要到了。可守城的人等来的，却是一道撤退的命令。真正改变命运的，往往不是战场上的一声巨响，而是那个无人注意的决定。'

async function main() {
  if (!process.env.QWEN_API_KEY) throw Error('backend/.env 中缺少 QWEN_API_KEY')
  const source = path.resolve(process.argv[2] || '/Users/zhangshijie/Downloads/videoplayback.mp4')
  const start = Number(process.argv[3] || 20), duration = Number(process.argv[4] || 20)
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 3 || duration > 30) {
    throw Error('用法：setup-qwen-tts.ts <音视频路径> [起点秒数>=0] [样本秒数3-30]')
  }
  await fs.access(source)
  const config = { provider: QWEN_TTS_PROVIDER, model: QWEN_TTS_MODEL,
    baseUrl: qwenTTSBaseUrl({ baseUrl: process.env.QWEN_TTS_BASE_URL || '' }), apiKey: process.env.QWEN_API_KEY }
  const account = createHash('sha256').update(JSON.stringify([config.baseUrl, config.apiKey])).digest('hex')
  const root = path.join(projectRoot, 'data/storage/qwen-tts-voices', account.slice(0, 16))
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const sample = path.join(root, 'reference.wav')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(start), '-i', source, '-t', String(duration),
    '-vn', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', sample], { timeout: 60_000 })
  await fs.chmod(sample, 0o600)
  const audio = await fs.readFile(sample)
  const hash = createHash('sha256').update(audio).digest('hex')
  const prefix = `h${hash.slice(0, 9)}`
  const manifestPath = path.join(root, `${QWEN_TTS_MODEL}-${hash}.json`)
  let manifest: Record<string, any> = {}
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const save = async () => {
    const temporary = `${manifestPath}.tmp`
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 })
    await fs.rename(temporary, manifestPath)
  }
  if (!manifest.voiceId) {
    // A lost create response must be reconciled before another paid enrollment.
    if (manifest.enrollmentStartedAt) {
      const candidates = (await listQwenVoices(config)).filter(voice => voice.voice_id.startsWith(`${QWEN_TTS_MODEL}-${prefix}-`))
      if (candidates.length !== 1) throw Error(`此前复刻提交结果尚未确认，请先核对百炼音色列表：${prefix}`)
      manifest.voiceId = candidates[0]!.voice_id
    } else {
      manifest = { model: QWEN_TTS_MODEL, source, start, duration, sampleSha256: hash, prefix,
        enrollmentStartedAt: new Date().toISOString() }
      await save()
      console.log('正在提交 20 秒级参考人声，创建百炼专用复刻音色…')
      manifest.voiceId = await createQwenVoice(config, { audio: `data:audio/wav;base64,${audio.toString('base64')}`,
        prefix, languageHints: ['zh'], maxPromptAudioLength: duration, enablePreprocess: true, enableVolumeNormalization: true })
    }
    await save()
  }
  await waitForQwenVoice(config, manifest.voiceId)
  manifest.status = 'OK'
  await save()
  console.log(`复刻音色已就绪：${manifest.voiceId}`)
  const timestamp = new Date().toISOString()
  const existing = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.provider, QWEN_TTS_PROVIDER)).all()
    .find(row => row.serviceType === 'audio' && row.baseUrl === config.baseUrl && row.apiKey === config.apiKey)
  const settings = { ...(existing?.settings ? JSON.parse(existing.settings) : {}), narrationVoiceId: manifest.voiceId, instruction }
  let configId = existing?.id
  if (configId) {
    db.update(schema.aiServiceConfigs).set({ model: JSON.stringify([QWEN_TTS_MODEL]), settings: JSON.stringify(settings),
      isActive: true, updatedAt: timestamp }).where(eq(schema.aiServiceConfigs.id, configId)).run()
  } else {
    configId = Number(db.insert(schema.aiServiceConfigs).values({ serviceType: 'audio', provider: QWEN_TTS_PROVIDER,
      name: '阿里云百炼 Qwen 3.1 · 历史叙事复刻', baseUrl: config.baseUrl, apiKey: config.apiKey,
      model: JSON.stringify([QWEN_TTS_MODEL]), priority: 0, isActive: true, isDefault: false,
      settings: JSON.stringify({ ...settings, useForNarration: false }), createdAt: timestamp, updatedAt: timestamp }).run().lastInsertRowid)
  }
  db.insert(schema.aiVoices).values({ voiceId: manifest.voiceId, voiceName: '历史叙事·参考视频复刻（百炼）',
    description: JSON.stringify(['参考视频人声复刻', '悬念、重音与情绪起伏；自然、克制、有张力']), language: '中文',
    provider: QWEN_TTS_PROVIDER, voiceType: 'voice_cloning', createdAt: timestamp }).onConflictDoNothing().run()
  manifest.configId = configId
  await save()
  console.log('正在使用复刻音色生成情感试听…')
  manifest.previewUrl = await generateVoicePreview({ configId, voice: manifest.voiceId, text: previewText })
  manifest.previewText = previewText
  await save()
  // Switch narration only after the clone can actually synthesize audio.
  db.transaction(tx => {
    const rows = tx.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, 'audio')).all()
    const priority = Math.max(10, ...rows.filter(row => row.id !== configId).map(row => row.priority || 0)) + 1
    for (const row of rows) {
      const current = row.settings ? JSON.parse(row.settings) : {}
      tx.update(schema.aiServiceConfigs).set({ settings: JSON.stringify({ ...current, useForNarration: row.id === configId }),
        isDefault: row.id === configId, ...(row.id === configId ? { priority } : {}), updatedAt: timestamp })
        .where(eq(schema.aiServiceConfigs.id, row.id)).run()
    }
  }, { behavior: 'immediate' })
  manifest.activatedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ configId, model: QWEN_TTS_MODEL, voiceId: manifest.voiceId, previewUrl: manifest.previewUrl,
    useForNarration: true, manifestPath }, null, 2))
}

try { await main() }
catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(process.env.QWEN_API_KEY ? message.split(process.env.QWEN_API_KEY).join('***') : message)
  process.exitCode = 1
} finally { db.$client.close() }
