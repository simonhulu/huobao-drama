/**
 * 免费影视级音频素材包管理
 *
 * 维护一份精选的 CC0 / Public Domain / Royalty-Free 音频包清单，
 * 并提供一键导入脚本，把它们下载、解压、分类、写入索引。
 *
 * 注意：
 * - 真正的电影/电视剧原声（OST）受版权保护，不能免费商用。
 * - 这里收集的是由专业声音设计师/作曲家发布的、可商用的「影视级」素材，
 *   以及进入公有领域的古典音乐录音。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import AdmZip from 'adm-zip'
import type { EmotionBucket } from './audio-profile.js'
import { MUSIC_DIR } from './music-library.js'
import { loadMusicLibrary, saveMusicLibrary, type MusicLibraryEntry } from './music-library.js'
import { SFX_LIBRARY_ROOT, extractPack, buildMapping, type SfxPack } from './sfx-library.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOWNLOAD_DIR = path.resolve(__dirname, '../../../data/downloads/free-audio-packs')

export interface FreePack {
  name: string
  /** 人类可读名称 */
  title: string
  type: 'music' | 'sfx'
  /** 直接下载链接；如果是 null，则只能手动下载 */
  url: string | null
  homepage: string
  license: string
  /** 大致大小，仅用于提示 */
  sizeBytes?: number
  /** 适用情绪桶，导入后会写进 music-library 元数据 */
  emotionBuckets?: EmotionBucket[]
  intensity?: 'low' | 'medium' | 'high'
  /** 一句话说明，会写进 prompt 字段 */
  description?: string
  /** 全局标签（如风格、乐器、场景） */
  tags?: string[]
  /** 按文件名关键词追加的标签 */
  filenameTagRules?: Record<string, string[]>
}

export const FREE_MUSIC_PACKS: FreePack[] = [
  {
    name: 'holst-planets',
    title: 'Holst - The Planets Suite（霍尔斯特：行星组曲）',
    type: 'music',
    url: 'https://opengameart.org/sites/default/files/Holst%20-%20The%20Planets%20%28Public%20Domain%29.zip',
    homepage: 'https://opengameart.org/content/holst-the-planets-suite',
    license: 'Public Domain',
    sizeBytes: 37_312_511,
    emotionBuckets: ['epic', 'tense', 'mysterious'],
    intensity: 'high',
    description: 'Public domain orchestral suite, frequently referenced in film scores. Epic and cosmic.',
    tags: ['public-domain', 'classical', 'orchestral', 'suite', 'film-score-reference', 'cosmic'],
    filenameTagRules: {
      mars: ['mars', 'war', 'aggressive', 'battle', 'epic', 'tense'],
      venus: ['venus', 'peaceful', 'romantic', 'calm', 'gentle'],
      mercury: ['mercury', 'messenger', 'playful', 'fast', 'whimsical'],
      jupiter: ['jupiter', 'triumphant', 'heroic', 'epic', 'celebration'],
      saturn: ['saturn', 'slow', 'solemn', 'sad', 'mysterious', 'contemplative'],
      uranus: ['uranus', 'magic', 'mysterious', 'mechanical', 'quirky'],
      neptune: ['neptune', 'mystical', 'ethereal', 'mysterious', 'ambient'],
    },
  },
  {
    name: 'fantasy-choir',
    title: 'Fantasy Choir - 3 Orchestral Pieces（奇幻合唱与管弦乐）',
    type: 'music',
    url: 'https://opengameart.org/sites/default/files/FantasyChoir24bit.zip',
    homepage: 'https://opengameart.org/content/fantasy-choir-3-orchestral-pieces',
    license: 'CC0',
    sizeBytes: 69_735_362,
    emotionBuckets: ['epic', 'mysterious', 'sad'],
    intensity: 'high',
    description: 'CC0 fantasy choir and orchestral pieces, suitable for epic and emotional scenes.',
    tags: ['cc0', 'choir', 'orchestral', 'fantasy', 'vocal', 'epic'],
    filenameTagRules: {
      choir: ['choir', 'vocal', 'choral'],
      orchestral: ['orchestral', 'orchestra'],
    },
  },
  {
    name: 'vampires-piano',
    title: "Vampire's Piano（悲伤/黑暗奇幻钢琴）",
    type: 'music',
    url: 'https://opengameart.org/sites/default/files/vampires_piano_8.mp3',
    homepage: 'https://opengameart.org/content/vampires-piano',
    license: 'CC0',
    sizeBytes: 2_866_281,
    emotionBuckets: ['sad', 'mysterious'],
    intensity: 'low',
    description: 'CC0 sad dark fantasy piano loop.',
    tags: ['cc0', 'piano', 'solo', 'dark', 'fantasy', 'loop'],
  },
  {
    name: 'qazijamjam-battle',
    title: 'QaziJamJam（管弦战斗主题）',
    type: 'music',
    url: 'https://opengameart.org/sites/default/files/QaziJamJam.wav',
    homepage: 'https://opengameart.org/content/qazijamjam-orchestral-battle-theme',
    license: 'CC0',
    sizeBytes: 41_298_176,
    emotionBuckets: ['epic', 'action'],
    intensity: 'high',
    description: 'CC0 orchestral battle theme.',
    tags: ['cc0', 'orchestral', 'battle', 'war', 'heroic', 'action', 'fight'],
  },
  {
    name: 'game-loops',
    title: 'Royalty Free Game Music Loops（多风格循环配乐）',
    type: 'music',
    url: 'https://opengameart.org/sites/default/files/GameLoops.zip',
    homepage: 'https://opengameart.org/content/royalty-free-game-music-loops',
    license: 'CC0',
    sizeBytes: 73_333_587,
    emotionBuckets: ['neutral', 'happy', 'calm', 'tense'],
    intensity: 'medium',
    description: 'CC0 assorted music loops for background and transition use.',
    tags: ['cc0', 'loop', 'game', 'background'],
    filenameTagRules: {
      battle: ['battle', 'war', 'action', 'epic'],
      boss: ['boss', 'battle', 'epic', 'tense'],
      calm: ['calm', 'peaceful', 'quiet'],
      dark: ['dark', 'mysterious', 'ominous'],
      happy: ['happy', 'bright', 'cheerful'],
      menu: ['menu', 'neutral', 'calm'],
      town: ['town', 'peaceful', 'neutral'],
      victory: ['victory', 'happy', 'triumphant', 'epic'],
    },
  },
]

/** 可直接下载的免费音效包 */
export const FREE_SFX_PACKS: FreePack[] = [
  {
    name: '100-cc0-sfx-v2',
    title: '100 CC0 SFX #2（通用环境/脚步/玻璃/金属）',
    type: 'sfx',
    url: 'https://opengameart.org/sites/default/files/sfx_100_v2.zip',
    homepage: 'https://opengameart.org/content/100-cc0-sfx-2',
    license: 'CC0',
    sizeBytes: 2_367_871,
  },
]

/** 质量很高、但需要手动下载/解压的素材包 */
export const MANUAL_RESOURCE_LINKS: FreePack[] = [
  {
    name: 'sonniss-gdc-2026',
    title: 'Sonniss GDC 2026 Game Audio Bundle',
    type: 'sfx',
    url: null,
    homepage: 'https://gdc.sonniss.com/',
    license: 'Royalty-free, no attribution, commercial use',
    sizeBytes: 7_470_000_000,
    description: '347 high-quality WAV sound effects from pro sound libraries. Too large to auto-download reliably.',
  },
  {
    name: '99sounds-cinematic-sounds',
    title: '99Sounds Cinematic Sounds',
    type: 'sfx',
    url: null,
    homepage: 'https://99sounds.org/cinematic-sounds/',
    license: 'Royalty-free',
    sizeBytes: 357_000_000,
    description: 'Braams, booms, impacts, whooshes, tension builders (Gumroad free download).',
  },
  {
    name: '99sounds-cinematic-loops',
    title: '99Sounds Cinematic Loops',
    type: 'music',
    url: null,
    homepage: 'https://99sounds.org/cinematic-loops/',
    license: 'Royalty-free',
    sizeBytes: 60_400_000,
    emotionBuckets: ['tense', 'mysterious', 'action'],
    intensity: 'medium',
    description: '99 cinematic loops inspired by sci-fi / thriller / action trailers (Gumroad free download).',
  },
  {
    name: 'signature-orchestral',
    title: 'Signature Sounds - Orchestral CC0 Sample Pack',
    type: 'music',
    url: null,
    homepage: 'https://signaturesounds.org/orchestral-cc0-sample-pack-cc0-free-to-download',
    license: 'CC0',
    sizeBytes: 87_000_000,
    emotionBuckets: ['epic', 'sad', 'romantic'],
    intensity: 'high',
    description: '23 orchestral score loops and instrument loops (strings, brass, woodwinds, percussion).',
  },
  {
    name: 'signature-choirs',
    title: 'Signature Sounds - Choirs of Life',
    type: 'music',
    url: null,
    homepage: 'https://signaturesounds.org/store/p/choirs-of-life',
    license: 'CC0',
    sizeBytes: 215_000_000,
    emotionBuckets: ['epic', 'mysterious', 'sad'],
    intensity: 'high',
    description: '153 full choir loops, vocal harmonies and pads.',
  },
  {
    name: 'signature-wartime-drums',
    title: 'Signature Sounds - Wartime Drum Loops',
    type: 'music',
    url: null,
    homepage: 'https://signaturesounds.org/',
    license: 'CC0',
    sizeBytes: 49_000_000,
    emotionBuckets: ['epic', 'action', 'tense'],
    intensity: 'high',
    description: 'Marching snares, rolling rhythms, cinematic percussion.',
  },
]

export function formatSize(bytes?: number): string {
  if (bytes == null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export async function downloadToBuffer(url: string, timeoutMs = 600_000): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function ensureDownloadDir() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
}

export function getPackDownloadPath(pack: FreePack): string {
  ensureDownloadDir()
  if (!pack.url) throw new Error(`Pack ${pack.name} has no auto-download URL`)
  const raw = path.basename(new URL(pack.url).pathname) || `${pack.name}.zip`
  const filename = decodeURIComponent(raw)
  return path.join(DOWNLOAD_DIR, filename)
}

async function fetchContentLength(url: string): Promise<number> {
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HEAD failed: ${res.status} ${res.statusText} for ${url}`)
  const len = Number(res.headers.get('content-length'))
  if (!Number.isFinite(len) || len <= 0) throw new Error(`Could not determine content length for ${url}`)
  return len
}

async function downloadChunk(
  url: string,
  partPath: string,
  start: number,
  end: number,
  chunkId: number,
  total: number,
): Promise<void> {
  const expectedBytes = end - start + 1
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    const existingBytes = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
    if (existingBytes >= expectedBytes) return
    const offset = start + existingBytes
    const headers: Record<string, string> = { Range: `bytes=${offset}-${end}` }
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
      if (!res.ok && res.status !== 206) {
        throw new Error(`Chunk ${chunkId} fetch failed: ${res.status} ${res.statusText}`)
      }
      if (!res.body) throw new Error(`Chunk ${chunkId} has no body`)
      const part = fs.createWriteStream(partPath, { flags: 'a' })
      await pipeline(Readable.fromWeb(res.body as any), part)
      const finalBytes = fs.statSync(partPath).size
      if (finalBytes !== expectedBytes) {
        throw new Error(`Chunk ${chunkId} size mismatch: ${finalBytes}/${expectedBytes}`)
      }
      return
    } catch (err) {
      lastError = err
      if (attempt < 3) {
        console.log(`[FreeAudio] Chunk ${chunkId} attempt ${attempt} failed, retrying...`)
        await new Promise(r => setTimeout(r, 1000 * attempt))
      }
    }
  }
  throw lastError
}

async function mergeParts(outPath: string, numChunks: number) {
  const out = fs.createWriteStream(outPath)
  for (let i = 0; i < numChunks; i++) {
    const partPath = `${outPath}.ndpart${i}`
    await pipeline(fs.createReadStream(partPath), out, { end: false })
    fs.unlinkSync(partPath)
  }
  out.end()
  await new Promise<void>((resolve, reject) => {
    out.on('finish', resolve)
    out.on('error', reject)
  })
}

async function downloadFileMultipart(
  url: string,
  outPath: string,
  expectedSize?: number,
  threads = 8,
): Promise<void> {
  let total = expectedSize
  try {
    const actual = await fetchContentLength(url)
    if (total && total !== actual) {
      console.log(`[FreeAudio] Declared size ${formatSize(total)} differs from server ${formatSize(actual)}, using server value`)
    }
    total = actual
  } catch (err) {
    if (!total) throw new Error(`Cannot determine download size: ${err}`)
  }

  if (fs.existsSync(outPath)) {
    const stat = fs.statSync(outPath)
    if (stat.size === total) {
      console.log(`[FreeAudio] Using cached ${outPath}`)
      return
    }
    console.log(`[FreeAudio] Removing incomplete cached file ${outPath}`)
    fs.unlinkSync(outPath)
  }

  const chunkSize = Math.ceil(total / threads)
  const ranges: Array<{ start: number; end: number; id: number }> = []
  for (let i = 0; i < threads; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize - 1, total - 1)
    ranges.push({ start, end, id: i })
  }

  console.log(`[FreeAudio] Multi-thread downloading ${formatSize(total)} via ${ranges.length} chunks...`)
  let completed = 0
  const report = () => {
    const got = ranges.reduce((sum, r) => {
      const p = `${outPath}.ndpart${r.id}`
      return sum + (fs.existsSync(p) ? fs.statSync(p).size : 0)
    }, 0)
    console.log(`[FreeAudio] Progress ${Math.round((got / total) * 100)}% (${formatSize(got)}/${formatSize(total)})`)
  }
  const progressTimer = setInterval(report, 5000)

  await Promise.all(
    ranges.map(async r => {
      const partPath = `${outPath}.ndpart${r.id}`
      await downloadChunk(url, partPath, r.start, r.end, r.id, total)
      completed++
    }),
  )

  clearInterval(progressTimer)
  await mergeParts(outPath, threads)
  report()
  console.log(`[FreeAudio] Saved to ${outPath}`)
}

export async function downloadPack(pack: FreePack): Promise<string> {
  ensureDownloadDir()
  const downloadPath = getPackDownloadPath(pack)
  if (!pack.url) throw new Error(`Pack ${pack.name} has no auto-download URL`)
  if (!fs.existsSync(downloadPath)) {
    console.log(`[FreeAudio] Downloading ${pack.title} (${formatSize(pack.sizeBytes)})...`)
  }
  await downloadFileMultipart(pack.url, downloadPath, pack.sizeBytes, 8)
  return downloadPath
}

export function extractZip(zipPath: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(targetDir, /*overwrite*/ true)
}

const AUDIO_EXTENSIONS = /\.(mp3|m4a|wav|ogg|flac)$/i

function walkAudioFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      results.push(...walkAudioFiles(full))
    } else if (AUDIO_EXTENSIONS.test(entry)) {
      results.push(full)
    }
  }
  return results
}

/**
 * 把音乐包解压到 data/static/music/freepacks/<pack.name>/ 下，
 * 并返回相对于 MUSIC_DIR 的路径列表（不含 static/music 前缀）。
 */
export async function importMusicPack(pack: FreePack): Promise<{ relativePaths: string[] }> {
  if (!pack.url) {
    throw new Error(`Pack ${pack.name} must be downloaded manually from ${pack.homepage}`)
  }
  const downloadedPath = await downloadPack(pack)
  const targetDir = path.join(MUSIC_DIR, 'freepacks', pack.name)
  fs.mkdirSync(targetDir, { recursive: true })

  const isAudioFile = AUDIO_EXTENSIONS.test(downloadedPath)
  if (isAudioFile) {
    // 单文件音乐，直接复制到目标目录
    const targetPath = path.join(targetDir, path.basename(downloadedPath))
    fs.copyFileSync(downloadedPath, targetPath)
    console.log(`[FreeAudio] Copied single audio file to ${targetPath}`)
  } else {
    console.log(`[FreeAudio] Extracting ${pack.title} to ${targetDir}...`)
    extractZip(downloadedPath, targetDir)
  }

  const files = walkAudioFiles(targetDir)
  const relativePaths = files.map(abs => path.relative(MUSIC_DIR, abs).replace(/\\/g, '/'))
  console.log(`[FreeAudio] Found ${relativePaths.length} music files in ${pack.name}`)
  return { relativePaths }
}

function deriveFileTags(filename: string, pack: FreePack): string[] {
  const base = new Set<string>([
    ...(pack.tags || []),
    ...(pack.emotionBuckets || []),
    pack.intensity || 'medium',
  ])
  const lower = filename.toLowerCase()
  if (pack.filenameTagRules) {
    for (const [keyword, tags] of Object.entries(pack.filenameTagRules)) {
      if (lower.includes(keyword.toLowerCase())) {
        for (const t of tags) base.add(t)
      }
    }
  }
  return Array.from(base)
}

/**
 * 为已导入的免费包打上 source / emotion / intensity / tags 标签。
 */
export function tagImportedMusic(
  packName: string,
  tag: Pick<MusicLibraryEntry, 'emotionBucket' | 'intensity'> & { prompt?: string; tags?: string[] },
  pack?: FreePack,
): void {
  const lib = loadMusicLibrary()
  const prefix = `static/music/freepacks/${packName}/`
  let tagged = 0
  for (const entry of lib.entries) {
    if (!entry.relativePath.startsWith(prefix)) continue
    entry.source = 'freepack'
    if (tag.emotionBucket) entry.emotionBucket = tag.emotionBucket
    if (tag.intensity) entry.intensity = tag.intensity
    if (tag.prompt) entry.prompt = tag.prompt
    const fileTags = pack ? deriveFileTags(entry.filename, pack) : []
    entry.tags = [...new Set([...(tag.tags || []), ...fileTags])]
    tagged++
  }
  saveMusicLibrary(lib)
  console.log(`[FreeAudio] Tagged ${tagged} entries from ${packName}`)
}

/**
 * 把音效包导入到现有 SFX 库目录并重建索引。
 */
export async function importSfxPack(pack: FreePack): Promise<void> {
  if (!pack.url) {
    throw new Error(`Pack ${pack.name} must be downloaded manually from ${pack.homepage}`)
  }
  const zipPath = await downloadPack(pack)
  const extractDir = path.join(SFX_LIBRARY_ROOT, 'library', pack.name)
  fs.mkdirSync(extractDir, { recursive: true })
  console.log(`[FreeAudio] Extracting SFX ${pack.title} to ${extractDir}...`)
  extractPack(zipPath, pack.name)
}

export function buildSfxPackList(): SfxPack[] {
  return FREE_SFX_PACKS.map(p => ({ name: p.name, url: p.url! }))
}

export function rebuildSfxMapping(): void {
  buildMapping()
  console.log(`[FreeAudio] SFX mapping rebuilt at ${SFX_LIBRARY_ROOT}/sfx-mapping.json`)
}

export function listAllRecommendedPacks(): FreePack[] {
  return [...FREE_MUSIC_PACKS, ...FREE_SFX_PACKS, ...MANUAL_RESOURCE_LINKS]
}
