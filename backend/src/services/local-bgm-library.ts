/**
 * 本地 BGM 素材库匹配
 *
 * 从已有的 static/music 文件中选择一段风格最接近当前音频画像的 BGM。
 *
 * 优先使用 music-library.json 里的元数据（prompt / emotion / intensity / tags）做匹配；
 * 没有元数据时回退到文件名关键词 + 固定索引兜底。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { EmotionBucket } from './audio-profile.js'
import { loadMusicLibrary, type MusicLibraryEntry } from './music-library.js'
import { toAbsPath } from './ffmpeg-compose.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MUSIC_DIR = path.resolve(__dirname, '../../../data/static/music')

function listExistingMusicFiles(): string[] {
  if (!fs.existsSync(MUSIC_DIR)) return []
  return fs
    .readdirSync(MUSIC_DIR)
    .filter(f => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f))
    .sort()
}

const BUCKET_PREFERRED_INDEX: Record<EmotionBucket, number> = {
  tense: 2,
  romantic: 1,
  sad: 0,
  happy: 4,
  epic: 3,
  mysterious: 6,
  calm: 1,
  action: 5,
  neutral: 4,
}

const BUCKET_KEYWORDS: Record<EmotionBucket, string[]> = {
  tense: ['tense', 'thriller', 'suspense', 'nervous', 'ominous', 'danger'],
  romantic: ['romantic', 'love', 'tender', 'piano', 'violin', 'warm'],
  sad: ['sad', 'melancholic', 'cello', 'grief', 'somber', 'piano'],
  happy: ['happy', 'bright', 'upbeat', 'joy', 'cheerful', 'acoustic'],
  epic: ['epic', 'orchestral', 'heroic', 'brass', 'drums', 'war'],
  mysterious: ['mysterious', 'ambient', 'synth', 'dark', 'eerie', 'secret'],
  calm: ['calm', 'peaceful', 'ambient', 'gentle', 'soft', 'guitar'],
  action: ['action', 'chase', 'percussion', 'fast', 'driving', 'fight'],
  neutral: ['neutral', 'cinematic', 'pad', 'background'],
}

type BgmIntensity = 'low' | 'medium' | 'high'

interface LocalBgmProfileOptions {
  prompt?: string
  intensity?: BgmIntensity
  seed?: string | number
  minScore?: number
}

function filenameToKeywords(filename: string): string[] {
  const base = path.basename(filename, path.extname(filename)).toLowerCase()
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\d+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function tokenizeForMatch(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .replace(/[，,、。\.!！?？;；:：""''（）()\[\]{}|/\\_-]+/g, ' ')
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3)
      .filter(t => !['and', 'the', 'with', 'for', 'music', 'background', 'instrumental', 'cinematic'].includes(t)),
  ))
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function scoreEntryForEmotion(entry: MusicLibraryEntry, bucket: EmotionBucket): number {
  let score = 0
  const bucketKws = BUCKET_KEYWORDS[bucket] || []
  const targetIntensity = entry.intensity || 'medium'

  // 1. 情绪桶直接命中：最高分
  if (entry.emotionBucket === bucket) {
    score += 20
  }

  // 2. prompt 里的关键词命中
  const prompt = (entry.prompt || '').toLowerCase()
  for (const kw of bucketKws) {
    if (prompt.includes(kw)) score += 3
  }

  // 3. 文件名关键词命中
  const fileKws = filenameToKeywords(entry.filename)
  for (const kw of bucketKws) {
    if (fileKws.some(fk => fk.includes(kw) || kw.includes(fk))) score += 2
  }

  // 4. 强度加权：高能量场景优先高/中强度；低能量场景优先低/中强度
  if (bucket === 'epic' || bucket === 'action' || bucket === 'tense') {
    if (targetIntensity === 'high') score += 2
    if (targetIntensity === 'medium') score += 1
  } else if (bucket === 'romantic' || bucket === 'calm') {
    if (targetIntensity === 'low') score += 2
    if (targetIntensity === 'medium') score += 1
  } else {
    if (targetIntensity === 'medium') score += 1
  }

  // 5. tags 命中情绪桶关键词：高权重
  const entryTags = (entry.tags || []).map(t => t.toLowerCase())
  for (const kw of bucketKws) {
    if (entryTags.some(t => t.includes(kw) || kw.includes(t))) score += 4
  }

  // 6. 有完整元数据的条目优先（说明是之前生成/标记过的）
  if (entry.emotionBucket && entry.prompt) score += 1

  // 7. 优先“音乐化”标签，降级“音效化”标签
  const allText = `${entryTags.join(' ')} ${filenameToKeywords(entry.filename).join(' ')} ${(entry.prompt || '').toLowerCase()}`
  const musicalKeywords = ['orchestral', 'choir', 'choral', 'piano', 'strings', 'violin', 'cello', 'ambient', 'cinematic', 'pad', 'melodic', 'symphonic', 'suite']
  const sfxLikeKeywords = ['percussion', 'hit', 'impact', 'sting', 'sfx', 'sound effect', 'short', 'drum only', 'drums only']
  for (const kw of musicalKeywords) {
    if (allText.includes(kw)) score += 2
  }
  for (const kw of sfxLikeKeywords) {
    if (allText.includes(kw)) score -= 5
  }

  return score
}

function hasUsableMetadata(entry: MusicLibraryEntry): boolean {
  return Boolean(entry.emotionBucket || entry.prompt || (entry.tags && entry.tags.length > 0))
}

function entryMatchText(entry: MusicLibraryEntry): string {
  return [
    entry.prompt,
    ...(entry.tags || []),
    ...filenameToKeywords(entry.filename),
  ].filter(Boolean).join(' ').toLowerCase()
}

function scoreEntryForProfile(
  entry: MusicLibraryEntry,
  bucket: EmotionBucket,
  options: LocalBgmProfileOptions,
): number {
  if (!hasUsableMetadata(entry)) return Number.NEGATIVE_INFINITY

  let score = scoreEntryForEmotion(entry, bucket)

  if (entry.emotionBucket === bucket) score += 8

  if (options.intensity && entry.intensity) {
    if (entry.intensity === options.intensity) {
      score += 6
    } else if (entry.intensity === 'medium' || options.intensity === 'medium') {
      score += 2
    } else {
      score -= 4
    }
  }

  const promptTokens = tokenizeForMatch(options.prompt || '')
  if (promptTokens.length > 0) {
    const text = entryMatchText(entry)
    let overlapScore = 0
    for (const token of promptTokens) {
      if (text.includes(token)) overlapScore += 2
    }
    score += Math.min(12, overlapScore)
  }

  if (entry.source === 'minimax') score += 2

  if (entry.duration >= 45) score += 3
  else if (entry.duration >= 25) score += 1
  else if (entry.duration > 0 && entry.duration < 20) score -= 8

  return score
}

function pickScoredEntry(
  scored: Array<{ entry: MusicLibraryEntry; score: number }>,
  seed?: string | number,
): { entry: MusicLibraryEntry; score: number } | null {
  if (scored.length === 0) return null

  const sorted = scored.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.entry.duration !== a.entry.duration) return b.entry.duration - a.entry.duration
    return a.entry.relativePath.localeCompare(b.entry.relativePath)
  })

  const topScore = sorted[0].score
  const candidates = sorted
    .filter(s => s.score >= topScore - 4)
    .slice(0, 8)
  if (!seed || candidates.length === 1) return candidates[0]

  const index = stableHash(String(seed)) % candidates.length
  return candidates[index]
}

function fallbackByIndex(files: string[], bucket: EmotionBucket): string | null {
  const preferred = BUCKET_PREFERRED_INDEX[bucket] ?? 0
  const index = preferred % files.length
  const filename = files[index]
  if (!filename) return null
  const absPath = path.join(MUSIC_DIR, filename)
  if (!fs.existsSync(absPath)) return null
  return `static/music/${filename}`
}

/**
 * 为当前音频画像优先复用素材库中的高置信 BGM。
 * 这个函数用于正常生产路径；只有没有可靠匹配时才应该继续调用生成服务。
 */
export function resolveLocalBgmForProfile(
  bucket: EmotionBucket,
  options: LocalBgmProfileOptions = {},
): string | null {
  const lib = loadMusicLibrary()
  const minScore = options.minScore ?? 18
  const scored = lib.entries
    .map(entry => ({ entry, score: scoreEntryForProfile(entry, bucket, options) }))
    .filter(s => s.score >= minScore)

  const winner = pickScoredEntry(scored, options.seed)
  if (!winner) return null

  const absPath = toAbsPath(winner.entry.relativePath)
  if (!fs.existsSync(absPath)) return null

  console.log(`[LocalBGM] profile matched ${winner.entry.relativePath} for ${bucket} (score=${winner.score})`)
  return winner.entry.relativePath
}

/**
 * 为指定情绪桶返回本地已有的 BGM 文件相对路径（static/music/...）。
 * 如果没有可用文件则返回 null。
 */
export function resolveLocalBgmForEmotion(bucket: EmotionBucket): string | null {
  const lib = loadMusicLibrary()
  const entries = lib.entries.length > 0 ? lib.entries : []

  if (entries.length > 0) {
    const scored = entries
      .map(entry => ({ entry, score: scoreEntryForEmotion(entry, bucket) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length > 0) {
      const winner = scored[0].entry
      const absPath = toAbsPath(winner.relativePath)
      if (fs.existsSync(absPath)) {
        console.log(`[LocalBGM] matched ${winner.relativePath} for ${bucket} (score=${scored[0].score})`)
        return winner.relativePath
      }
    }
  }

  // 兜底：没有索引或没有匹配项时，按老规则取固定索引
  const files = listExistingMusicFiles()
  if (files.length === 0) return null
  const fallback = fallbackByIndex(files, bucket)
  if (fallback) {
    console.log(`[LocalBGM] fallback ${path.basename(fallback)} for ${bucket}`)
  }
  return fallback
}
