import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAudioConfigById } from './ai.js'
import { generateTTS } from './tts-generation.js'

const root = process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))
const pending = new Map<string, Promise<string>>()

export async function generateVoicePreview(params: { voice: string; text: string; configId?: number }) {
  const config = getAudioConfigById(params.configId)
  const key = createHash('sha256').update(JSON.stringify(['voice-preview-v1', params, config.provider,
    config.baseUrl, config.apiKey, config.model, config.settings])).digest('hex')
  const relative = `audio/voice-previews/${key}.m4a`
  const filename = path.join(root, relative)
  try { if ((await fs.stat(filename)).size > 0) return `static/${relative}` } catch { /* no cached preview */ }
  const existing = pending.get(key)
  if (existing) return existing
  // Retain the result if a browser stops waiting. A later request can reuse it
  // rather than generating and charging for the same short sample again.
  const run = (async () => {
    const signal = AbortSignal.timeout(60_000)
    try {
      const generated = await generateTTS({ ...params, synchronous: config.provider.toLowerCase() === 'minimax' }, { signal })
      await fs.mkdir(path.dirname(filename), { recursive: true })
      await fs.rename(path.join(root, generated.replace(/^\/?static\//, '')), filename)
      return `static/${relative}`
    } catch (error) {
      if (signal.aborted) throw new Error('试听生成超时（60 秒），请稍后重新试听；若持续失败，请检查音频服务或更换音色。')
      throw error
    }
  })()
  pending.set(key, run)
  try { return await run } finally { if (pending.get(key) === run) pending.delete(key) }
}
