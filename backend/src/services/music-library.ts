/**
 * 本地 BGM 素材库索引服务
 *
 * 维护 data/static/music/library.json，记录每段 BGM 的元数据：
 * - prompt / emotionBucket / intensity：用于本地兜底匹配
 * - duration / source / createdAt：用于前端展示
 *
 * 这样已生成的 MiniMax Music 文件不再是“UUID 黑盒”，
 * 而是可按情绪、关键词、来源筛选的累计素材库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EmotionBucket } from './audio-profile.js'
import { getAudioDuration, toAbsPath } from './ffmpeg-compose.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
export const MUSIC_DIR = path.join(STORAGE_ROOT, 'music')
const LIBRARY_FILE = path.join(MUSIC_DIR, 'library.json')

export interface MusicLibraryEntry {
  filename: string
  relativePath: string
  url: string
  duration: number
  prompt?: string
  emotionBucket?: EmotionBucket
  intensity?: 'low' | 'medium' | 'high'
  tags?: string[]
  episodeId?: number
  source: 'minimax' | 'local' | 'freepack' | 'unknown'
  createdAt: string
}

export interface MusicLibrary {
  version: number
  generatedAt: string
  entries: MusicLibraryEntry[]
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac'])

function ensureDir() {
  fs.mkdirSync(MUSIC_DIR, { recursive: true })
}

export function loadMusicLibrary(): MusicLibrary {
  ensureDir()
  if (!fs.existsSync(LIBRARY_FILE)) {
    return { version: 1, generatedAt: new Date().toISOString(), entries: [] }
  }
  try {
    const raw = fs.readFileSync(LIBRARY_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as MusicLibrary
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { version: 1, generatedAt: new Date().toISOString(), entries: [] }
    }
    return parsed
  } catch {
    return { version: 1, generatedAt: new Date().toISOString(), entries: [] }
  }
}

export function saveMusicLibrary(lib: MusicLibrary): void {
  ensureDir()
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2))
}

interface MusicFileInfo {
  filename: string
  relativePath: string
  absPath: string
}

function listMusicFiles(): MusicFileInfo[] {
  ensureDir()
  const results: MusicFileInfo[] = []

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry)
      const stat = fs.statSync(fullPath)
      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (/\.(mp3|m4a|wav|ogg|flac)$/i.test(entry)) {
        const relFromMusic = path.relative(MUSIC_DIR, fullPath).replace(/\\/g, '/')
        results.push({
          filename: entry,
          relativePath: `static/music/${relFromMusic}`,
          absPath: fullPath,
        })
      }
    }
  }

  walk(MUSIC_DIR)
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function guessSource(filename: string, existing?: MusicLibraryEntry): MusicLibraryEntry['source'] {
  if (existing?.source) return existing.source
  // UUID 文件名通常是 MiniMax 生成
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i.test(filename)) {
    return 'minimax'
  }
  return 'local'
}

function resolveMusicFile(relativeOrUrl: string): { relativePath: string; absPath: string } | null {
  const cleaned = decodeURIComponent(String(relativeOrUrl || ''))
    .trim()
    .replace(/^\/+/, '')
  const relativePath = cleaned.startsWith('static/music/')
    ? cleaned
    : cleaned.startsWith('music/')
      ? `static/${cleaned}`
      : ''
  if (!relativePath) return null

  const relFromMusic = relativePath.slice('static/music/'.length)
  if (!relFromMusic || relFromMusic.includes('\0')) return null
  if (!AUDIO_EXTENSIONS.has(path.extname(relFromMusic).toLowerCase())) return null

  const root = path.resolve(MUSIC_DIR)
  const absPath = path.resolve(MUSIC_DIR, relFromMusic)
  if (absPath === root || !absPath.startsWith(`${root}${path.sep}`)) return null
  return { relativePath: relativePath.replace(/\\/g, '/'), absPath }
}

/**
 * 扫描 music 目录，把新文件或元数据缺失的文件补进 library.json。
 * 已有元数据的条目保持不变（保留 prompt / emotion 等人工/生成信息）。
 * 支持子目录，方便按素材包组织免费影视级 BGM。
 */
export async function refreshMusicLibrary(): Promise<MusicLibrary> {
  const lib = loadMusicLibrary()
  const existingByRelativePath = new Map(lib.entries.map(e => [e.relativePath, e]))
  const files = listMusicFiles()

  const nextEntries: MusicLibraryEntry[] = []
  for (const file of files) {
    const existing = existingByRelativePath.get(file.relativePath)
    let duration = existing?.duration ?? 0
    if (!duration && fs.existsSync(file.absPath)) {
      try {
        duration = await getAudioDuration(file.absPath)
      } catch {
        duration = 0
      }
    }

    nextEntries.push({
      filename: file.filename,
      relativePath: file.relativePath,
      url: file.relativePath,
      duration,
      prompt: existing?.prompt,
      emotionBucket: existing?.emotionBucket,
      intensity: existing?.intensity,
      tags: existing?.tags,
      episodeId: existing?.episodeId,
      source: guessSource(file.filename, existing),
      createdAt: existing?.createdAt || new Date().toISOString(),
    })
  }

  const next: MusicLibrary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: nextEntries,
  }
  saveMusicLibrary(next)
  return next
}

/**
 * 当 MiniMax Music 生成并下载成功后调用，记录元数据。
 */
export function deriveTagsFromPrompt(prompt: string, emotionBucket: EmotionBucket, intensity: string): string[] {
  const tags = new Set<string>([emotionBucket, intensity])
  const lower = prompt.toLowerCase()
  const keywordMap: Record<string, string[]> = {
    orchestral: ['orchestral', 'orchestra', 'symphony', 'suite', 'brass', 'strings', 'woodwind'],
    piano: ['piano'],
    choir: ['choir', 'choral', 'vocals'],
    musical: ['musical', 'musical bed', 'continuous'],
    battle: ['battle', 'war', 'fight', 'combat'],
    tense: ['tense', 'thriller', 'suspense', 'ominous'],
    epic: ['epic', 'heroic', 'trailer', 'grand'],
    sad: ['sad', 'melancholic', 'grief', 'somber'],
    calm: ['calm', 'peaceful', 'ambient', 'gentle'],
    romantic: ['romantic', 'love', 'tender'],
    mysterious: ['mysterious', 'dark', 'eerie'],
    action: ['action', 'chase', 'percussion', 'fast'],
    happy: ['happy', 'bright', 'upbeat'],
    historical: ['historical', 'chinese orchestral', 'guzheng', 'erhu', 'pipa'],
    scifi: ['sci-fi', 'scifi', 'cyberpunk', 'future', 'space'],
  }
  for (const [tag, kws] of Object.entries(keywordMap)) {
    if (kws.some(kw => lower.includes(kw))) tags.add(tag)
  }
  return Array.from(tags)
}

export function recordGeneratedMusic(
  relativePath: string,
  metadata: {
    prompt: string
    emotionBucket: EmotionBucket
    intensity: 'low' | 'medium' | 'high'
    episodeId?: number
    duration?: number
    tags?: string[]
  },
): MusicLibraryEntry {
  const lib = loadMusicLibrary()
  const filename = path.basename(relativePath)
  const existingIndex = lib.entries.findIndex(e => e.filename === filename)

  const entry: MusicLibraryEntry = {
    filename,
    relativePath,
    url: relativePath,
    duration: metadata.duration ?? 0,
    prompt: metadata.prompt,
    emotionBucket: metadata.emotionBucket,
    intensity: metadata.intensity,
    tags: metadata.tags ?? deriveTagsFromPrompt(metadata.prompt, metadata.emotionBucket, metadata.intensity),
    episodeId: metadata.episodeId,
    source: 'minimax',
    createdAt: new Date().toISOString(),
  }

  if (existingIndex >= 0) {
    lib.entries[existingIndex] = entry
  } else {
    lib.entries.push(entry)
  }

  saveMusicLibrary(lib)
  return entry
}

/**
 * 查找指定文件的元数据；没有则返回 null。
 * 使用 relativePath（如 static/music/freepacks/xxx.mp3）作为唯一键。
 */
export function findMusicEntry(relativePath: string): MusicLibraryEntry | null {
  const lib = loadMusicLibrary()
  return lib.entries.find(e => e.relativePath === relativePath) || null
}

export async function deleteMusicAsset(relativeOrUrl: string): Promise<{
  deleted: boolean
  relativePath: string
  total: number
}> {
  const resolved = resolveMusicFile(relativeOrUrl)
  if (!resolved) {
    throw new Error('Invalid music path')
  }

  if (!fs.existsSync(resolved.absPath) || !fs.statSync(resolved.absPath).isFile()) {
    throw new Error('Music file not found')
  }

  fs.unlinkSync(resolved.absPath)
  const lib = await refreshMusicLibrary()
  return {
    deleted: true,
    relativePath: resolved.relativePath,
    total: lib.entries.length,
  }
}

/**
 * 读取文件实际时长并更新索引。
 */
export async function updateMusicDuration(relativePath: string): Promise<number> {
  const lib = loadMusicLibrary()
  const entry = lib.entries.find(e => e.relativePath === relativePath)
  if (!entry) return 0
  try {
    entry.duration = await getAudioDuration(toAbsPath(relativePath))
    saveMusicLibrary(lib)
    return entry.duration
  } catch {
    return entry.duration
  }
}
