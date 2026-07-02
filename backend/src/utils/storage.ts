/**
 * 文件存储工具 — 下载远程文件到本地
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

/**
 * 下载远程文件到本地存储
 */
export async function downloadFile(url: string, subDir: string): Promise<string> {
  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })

  const ext = getExtFromUrl(url)
  const filename = `${uuid()}${ext}`
  const filePath = path.join(dir, filename)

  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)

  const buffer = Buffer.from(await resp.arrayBuffer())
  fs.writeFileSync(filePath, buffer)

  // 返回相对路径（供 API 返回给前端）
  return `static/${subDir}/${filename}`
}

/**
 * 保存上传的文件
 */
export async function saveUploadedFile(data: ArrayBuffer, subDir: string, originalName: string): Promise<string> {
  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })

  const ext = path.extname(originalName) || '.bin'
  const filename = `${uuid()}${ext}`
  const filePath = path.join(dir, filename)

  fs.writeFileSync(filePath, Buffer.from(data))
  return `static/${subDir}/${filename}`
}

function getExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname)
    if (ext && ext.length <= 5) return ext
  } catch {}
  return '.bin'
}

/**
 * 获取本地文件的绝对路径
 */
export function getAbsolutePath(relativePath: string): string {
  if (relativePath.startsWith('static/')) {
    return path.join(STORAGE_ROOT, '..', relativePath)
  }
  return path.join(STORAGE_ROOT, relativePath)
}

/**
 * 保存 Base64 编码的图片数据到本地存储
 * 用于 Gemini 等只返回 base64 数据的厂商
 */
export async function saveBase64Image(base64Data: string, mimeType: string, subDir: string): Promise<string> {
  const dir = path.join(STORAGE_ROOT, subDir)
  fs.mkdirSync(dir, { recursive: true })

  // 从 mimeType 推断文件扩展名
  const ext = mimeTypeToExt(mimeType)
  const filename = `${uuid()}${ext}`
  const filePath = path.join(dir, filename)

  const buffer = Buffer.from(base64Data, 'base64')
  fs.writeFileSync(filePath, buffer)

  return `static/${subDir}/${filename}`
}

export function readImageAsDataUrl(relativePath: string): string {
  const filePath = getAbsolutePath(relativePath)
  const buffer = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = extToMimeType(ext)
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export async function readImageAsCompressedDataUrl(
  relativePath: string,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
    /** 输出格式：'jpeg' | 'png' | 'webp' | 'preserve'（保留原格式） */
    format?: 'jpeg' | 'png' | 'webp' | 'preserve'
  } = {},
): Promise<string> {
  const { buffer, mimeType } = await readImageAsCompressedBuffer(relativePath, options)
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export async function readImageAsCompressedBuffer(
  relativePath: string,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
    /** 输出格式：'jpeg' | 'png' | 'webp' | 'preserve'（保留原格式） */
    format?: 'jpeg' | 'png' | 'webp' | 'preserve'
  } = {},
): Promise<{ buffer: Buffer; mimeType: string; ext: string }> {
  const filePath = getAbsolutePath(relativePath)
  const maxWidth = options.maxWidth ?? 768
  const maxHeight = options.maxHeight ?? 768
  const quality = options.quality ?? 68
  const format = options.format ?? 'jpeg'

  const resized = sharp(filePath).rotate().resize({
    width: maxWidth,
    height: maxHeight,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const metadata = await resized.metadata()
  const ext = path.extname(filePath).toLowerCase()
  const originalMimeType = extToMimeType(ext)

  let outputBuffer: Buffer
  let mimeType: string

  if (format === 'preserve') {
    mimeType = originalMimeType
    if (originalMimeType === 'image/png' && !metadata.hasAlpha) {
      outputBuffer = await resized.jpeg({ quality, mozjpeg: true }).toBuffer()
      mimeType = 'image/jpeg'
    } else if (originalMimeType === 'image/png') {
      outputBuffer = await resized.png({ quality: Math.min(quality, 100), compressionLevel: 9 }).toBuffer()
    } else if (originalMimeType === 'image/webp') {
      outputBuffer = await resized.webp({ quality }).toBuffer()
    } else {
      outputBuffer = await resized.jpeg({ quality, mozjpeg: true }).toBuffer()
      mimeType = 'image/jpeg'
    }
  } else if (format === 'png') {
    outputBuffer = await resized.png({ quality: Math.min(quality, 100), compressionLevel: 9 }).toBuffer()
    mimeType = 'image/png'
  } else if (format === 'webp') {
    outputBuffer = await resized.webp({ quality }).toBuffer()
    mimeType = 'image/webp'
  } else {
    outputBuffer = metadata.hasAlpha
      ? await resized.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
      : await resized.jpeg({ quality, mozjpeg: true }).toBuffer()
    mimeType = 'image/jpeg'
  }

  return { buffer: outputBuffer, mimeType, ext: mimeTypeToExt(mimeType) }
}

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return {
    mimeType: match[1],
    data: match[2],
  }
}

export function mimeTypeToExtension(mimeType: string): string {
  return mimeTypeToExt(mimeType)
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }
  return map[mimeType] || '.png'
}

function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  return map[ext] || 'image/png'
}
