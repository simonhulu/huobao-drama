import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { FormData } from 'undici'
import { aiFetch } from '../ai-client.js'
import { joinProviderUrl } from './url.js'
import type { AIConfig } from './types.js'

interface UploadCacheEntry {
  url: string
  createdAt: number
}

interface UploadCache {
  entries: Record<string, UploadCacheEntry>
}

export interface APIMartUploadImageInput {
  buffer: Buffer
  mimeType: string
  filename: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_PATH = process.env.APIMART_UPLOAD_CACHE_PATH
  || path.resolve(__dirname, '../../../../data/apimart-upload-cache.json')
const CACHE_TTL_MS = 60 * 60 * 60 * 1000
const pendingUploads = new Map<string, Promise<string>>()

function readCache(): UploadCache {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      entries: parsed && typeof parsed.entries === 'object' ? parsed.entries : {},
    }
  } catch {
    return { entries: {} }
  }
}

function writeCache(cache: UploadCache): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true })
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2))
}

function cacheKey(config: AIConfig, input: APIMartUploadImageInput): string {
  const hash = createHash('sha256')
    .update(config.baseUrl)
    .update('\n')
    .update(input.mimeType)
    .update('\n')
    .update(input.buffer)
    .digest('hex')
  return `${config.provider}:${hash}`
}

function extractUploadedImageUrl(result: any): string | null {
  return result?.url
    || result?.image_url
    || result?.data?.url
    || result?.data?.image_url
    || result?.data?.[0]?.url
    || result?.data?.[0]?.image_url
    || result?.file?.url
    || null
}

export async function uploadAPIMartImage(
  config: AIConfig,
  input: APIMartUploadImageInput,
): Promise<string> {
  const key = cacheKey(config, input)
  const now = Date.now()
  const cache = readCache()
  const cached = cache.entries[key]
  if (cached && now - cached.createdAt < CACHE_TTL_MS) return cached.url

  const pending = pendingUploads.get(key)
  if (pending) return pending

  const upload = (async () => {
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
      input.filename,
    )

    const resp = await aiFetch(config.provider, joinProviderUrl(config.baseUrl, '/v1', '/uploads/images'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: form as unknown as BodyInit,
    }, { timeoutMs: 120_000, maxAttempts: 2 })

    if (!resp.ok) {
      const responseText = await resp.text()
      throw new Error(`APIMart upload failed ${resp.status}: ${responseText}`)
    }

    const result = await resp.json() as any
    const url = extractUploadedImageUrl(result)
    if (!url) throw new Error('APIMart upload response did not include an image URL')

    cache.entries[key] = { url, createdAt: Date.now() }
    writeCache(cache)
    return url
  })()

  pendingUploads.set(key, upload)
  try {
    return await upload
  } finally {
    pendingUploads.delete(key)
  }
}
