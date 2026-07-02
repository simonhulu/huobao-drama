/**
 * 将 referenceImages JSON 字符串归一化为可用于远程 API 的图片列表。
 * - 去重、过滤空值
 * - 本地 static/ 路径会被压缩为 data URL
 * - 返回最多 6 张
 */
import { createHash } from 'crypto'
import { readImageAsCompressedBuffer, readImageAsCompressedDataUrl, mimeTypeToExtension, parseDataUrl } from '../../utils/storage.js'
import { logTaskWarn } from '../../utils/task-logger.js'

export interface NormalizeOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  format?: 'jpeg' | 'png' | 'webp' | 'preserve'
  maxCount?: number
  output?: 'dataUrl' | 'remoteUrl'
  uploadImage?: (input: {
    source: string
    buffer: Buffer
    mimeType: string
    filename: string
  }) => Promise<string>
}

export async function normalizeReferenceImages(
  raw: string | null | undefined,
  options: NormalizeOptions = {},
): Promise<string[]> {
  if (!raw) return []
  let refs: string[] = []
  try {
    refs = JSON.parse(raw)
  } catch {
    return []
  }

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const maxCount = options.maxCount ?? 6
  const output = options.output ?? 'dataUrl'

  const normalized = await Promise.all(deduped.slice(0, maxCount).map(async (value) => {
    if (value.startsWith('http://') || value.startsWith('https://')) return value
    if (value.startsWith('data:image/')) {
      if (output !== 'remoteUrl' || !options.uploadImage) return value
      const parsed = parseDataUrl(value)
      if (!parsed) return null
      const buffer = Buffer.from(parsed.data, 'base64')
      return options.uploadImage({
        source: value.slice(0, 64),
        buffer,
        mimeType: parsed.mimeType,
        filename: filenameForBuffer(buffer, parsed.mimeType),
      })
    }
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        if (output === 'remoteUrl' && options.uploadImage) {
          const image = await readImageAsCompressedBuffer(localPath, {
            maxWidth: options.maxWidth ?? 768,
            maxHeight: options.maxHeight ?? 768,
            quality: options.quality ?? 68,
            format: options.format ?? 'jpeg',
          })
          return options.uploadImage({
            source: localPath,
            buffer: image.buffer,
            mimeType: image.mimeType,
            filename: filenameForBuffer(image.buffer, image.mimeType),
          })
        }
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: options.maxWidth ?? 768,
          maxHeight: options.maxHeight ?? 768,
          quality: options.quality ?? 68,
          format: options.format ?? 'jpeg',
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item: string | null): item is string => !!item)
}

function filenameForBuffer(buffer: Buffer, mimeType: string): string {
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  return `${hash}${mimeTypeToExtension(mimeType)}`
}
