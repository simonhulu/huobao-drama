/**
 * 本地 SFX 音效库
 *
 * 默认下载 Kenney / OpenGameArt 的免费 CC0 音效包到 data/sfx，
 * 解压后建立关键词映射，供合成阶段根据 sound_effect 描述快速匹配。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import AdmZip from 'adm-zip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.resolve(__dirname, '../../../data')

export const SFX_LIBRARY_ROOT = process.env.SFX_LIBRARY_PATH || path.join(DATA_ROOT, 'sfx')
const DOWNLOAD_DIR = path.join(SFX_LIBRARY_ROOT, 'downloads')
const EXTRACT_DIR = path.join(SFX_LIBRARY_ROOT, 'library')
const MAPPING_FILE = path.join(SFX_LIBRARY_ROOT, 'sfx-mapping.json')

const AUDIO_EXTENSIONS = new Set(['.wav', '.ogg', '.mp3', '.m4a', '.flac'])

export interface SfxPack {
  name: string
  url: string
  subdir?: string
}

export const DEFAULT_SFX_PACKS: SfxPack[] = [
  { name: 'digital-sfx', url: 'https://opengameart.org/sites/default/files/Digital_SFX_Set.zip' },
  { name: 'water-bubbles', url: 'https://bigsoundbank.com/UPLOAD/mp3/0183.mp3' },
  { name: 'steps', url: 'https://opengameart.org/sites/default/files/%5Bkdd%5DDifferentSteps_0.zip' },
  { name: 'ui-sfx', url: 'https://opengameart.org/sites/default/files/UI_SFX_Set.zip' },
  { name: 'kenney-interface', url: 'https://opengameart.org/sites/default/files/kenney_interfaceSounds.zip' },
  { name: 'rpg-sounds', url: 'https://opengameart.org/sites/default/files/RPGsounds_Kenney.zip' },
  { name: 'casino-audio', url: 'https://opengameart.org/sites/default/files/kenney_casino-audio.zip' },
]

export interface SfxMapping {
  version: number
  generatedAt: string
  entries: Array<{
    pack: string
    relativePath: string
    keywords: string[]
  }>
}

function ensureDirs() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  fs.mkdirSync(EXTRACT_DIR, { recursive: true })
}

function extensionOf(file: string): string {
  return path.extname(file).toLowerCase()
}

function isAudioFile(file: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(file))
}

function filenameToKeywords(file: string): string[] {
  const base = path.basename(file, extensionOf(file))
  return base
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\d+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function packNameToKeywords(packName: string): string[] {
  return packName
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\d+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export async function downloadPack(pack: SfxPack, timeoutMs = 120_000): Promise<string> {
  ensureDirs()
  const filename = path.basename(new URL(pack.url).pathname) || `${pack.name}.zip`
  const downloadPath = path.join(DOWNLOAD_DIR, filename)

  if (fs.existsSync(downloadPath)) {
    return downloadPath
  }

  const res = await fetch(pack.url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    throw new Error(`Failed to download SFX pack ${pack.name}: ${res.status} ${res.statusText}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(downloadPath, buffer)
  return downloadPath
}

export function extractPack(zipPath: string, packName: string): string {
  const targetDir = path.join(EXTRACT_DIR, packName)
  fs.mkdirSync(targetDir, { recursive: true })

  const zip = new AdmZip(zipPath)
  zip.extractAllTo(targetDir, /*overwrite*/ true)
  return targetDir
}

export function buildMapping(_packs?: SfxPack[]): SfxMapping {
  ensureDirs()
  const entries: SfxMapping['entries'] = []

  if (!fs.existsSync(EXTRACT_DIR)) {
    const emptyMapping: SfxMapping = {
      version: 1,
      generatedAt: new Date().toISOString(),
      entries,
    }
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(emptyMapping, null, 2))
    return emptyMapping
  }

  for (const packName of fs.readdirSync(EXTRACT_DIR)) {
    const packDir = path.join(EXTRACT_DIR, packName)
    if (!fs.statSync(packDir).isDirectory()) continue

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry)
        const stat = fs.statSync(fullPath)
        if (stat.isDirectory()) {
          walk(fullPath)
        } else if (isAudioFile(fullPath)) {
          const relativePath = path.relative(SFX_LIBRARY_ROOT, fullPath).replace(/\\/g, '/')
          entries.push({
            pack: packName,
            relativePath,
            keywords: [...new Set([...filenameToKeywords(fullPath), ...packNameToKeywords(packName)])],
          })
        }
      }
    }

    walk(packDir)
  }

  const mapping: SfxMapping = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  }
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2))
  return mapping
}

function isZipUrl(url: string): boolean {
  return url.toLowerCase().endsWith('.zip')
}

async function downloadSingleAudioFile(pack: SfxPack, timeoutMs = 120_000): Promise<string> {
  ensureDirs()
  const filename = path.basename(new URL(pack.url).pathname) || 'sound.mp3'
  const targetDir = path.join(EXTRACT_DIR, pack.name)
  fs.mkdirSync(targetDir, { recursive: true })
  const targetPath = path.join(targetDir, filename)

  if (fs.existsSync(targetPath)) {
    return targetPath
  }

  const res = await fetch(pack.url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    throw new Error(`Failed to download SFX file ${pack.name}: ${res.status} ${res.statusText}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(targetPath, buffer)
  return targetPath
}

export async function setupSfxLibrary(packs: SfxPack[] = DEFAULT_SFX_PACKS): Promise<SfxMapping> {
  ensureDirs()
  for (const pack of packs) {
    try {
      if (isZipUrl(pack.url)) {
        console.log(`[SFX] Downloading ${pack.name}...`)
        const zipPath = await downloadPack(pack)
        console.log(`[SFX] Extracting ${pack.name}...`)
        extractPack(zipPath, pack.name)
      } else {
        console.log(`[SFX] Downloading ${pack.name} audio file...`)
        await downloadSingleAudioFile(pack)
      }
    } catch (err: any) {
      console.error(`[SFX] Failed to setup pack ${pack.name}: ${err.message}`)
    }
  }
  return buildMapping(packs)
}

export function loadMapping(): SfxMapping | null {
  if (!fs.existsSync(MAPPING_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8')) as SfxMapping
  } catch {
    return null
  }
}

function getAbsolutePath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  return path.join(SFX_LIBRARY_ROOT, relativePath)
}

function resolveDeletableSfxFile(relativeOrUrl: string): { relativePath: string; absPath: string } | null {
  const cleaned = decodeURIComponent(String(relativeOrUrl || ''))
    .trim()
    .replace(/^\/+/, '')
    .replace(/^sfx\//, '')
  if (!cleaned || cleaned.includes('\0')) return null
  if (!cleaned.startsWith('library/')) return null
  if (!AUDIO_EXTENSIONS.has(path.extname(cleaned).toLowerCase())) return null

  const root = path.resolve(EXTRACT_DIR)
  const absPath = path.resolve(SFX_LIBRARY_ROOT, cleaned)
  if (absPath === root || !absPath.startsWith(`${root}${path.sep}`)) return null
  return { relativePath: cleaned.replace(/\\/g, '/'), absPath }
}

function getRelativePath(absolutePath: string): string {
  if (!path.isAbsolute(absolutePath)) return absolutePath.replace(/\\/g, '/')
  return path.relative(SFX_LIBRARY_ROOT, absolutePath).replace(/\\/g, '/')
}

/**
 * 把 SFX 绝对路径转成前端可播放的 URL（如 sfx/library/kenney/click.mp3）。
 */
export function getSfxUrl(absolutePath: string): string {
  return `sfx/${getRelativePath(absolutePath)}`
}

/**
 * 根据绝对路径查找 SFX mapping 条目。
 */
export function findSfxEntryByAbsolutePath(absolutePath: string): SfxMapping['entries'][number] | null {
  const relativePath = getRelativePath(absolutePath)
  const mapping = loadMapping()
  if (!mapping) return null
  return mapping.entries.find(e => e.relativePath === relativePath) || null
}

export function deleteSfxAsset(relativeOrUrl: string): {
  deleted: boolean
  relativePath: string
  total: number
} {
  const resolved = resolveDeletableSfxFile(relativeOrUrl)
  if (!resolved) {
    throw new Error('Invalid sfx path')
  }

  if (!fs.existsSync(resolved.absPath) || !fs.statSync(resolved.absPath).isFile()) {
    throw new Error('SFX file not found')
  }

  fs.unlinkSync(resolved.absPath)
  const mapping = buildMapping()
  return {
    deleted: true,
    relativePath: resolved.relativePath,
    total: mapping.entries.length,
  }
}

/**
 * 场景关键词 -> 期望出现在文件名中的关键词。
 * 越靠前的匹配优先级越高。
 */
const SCENE_CATEGORIES: Array<{ sceneKeywords: string[]; sfxKeywords: string[] }> = [
  { sceneKeywords: ['palace', 'palace hall', 'hall', 'castle', 'ancient', 'historical', 'throne', 'dynasty', 'emperor', '宫殿', '大厅', '城堡', '古代', '历史', '王座', '王朝', '皇帝'], sfxKeywords: ['wood', 'door', 'step', 'footstep', 'impact', 'stone', 'carpet', 'cloth', 'sword', '木门', '脚步', '石板', '碰撞', '剑'] },
  { sceneKeywords: ['space', 'spaceship', 'sci-fi', 'scifi', 'future', 'laser', 'robot', 'cyber', '太空', '飞船', '科幻', '未来', '激光', '机器人'], sfxKeywords: ['laser', 'space', 'sci-fi', 'scifi', 'digital', 'robot', 'zap', 'phaser', 'engine', 'alarm', '激光', '引擎'] },
  { sceneKeywords: ['deep sea', 'ocean', 'underwater', 'sea', 'submarine', 'dive', 'water', '深海', '海洋', '水下', '海底', '潜水'], sfxKeywords: ['water', 'bubble', 'splash', 'swim', 'underwater', 'drip', 'slime', '水', '气泡', ' splash'] },
  { sceneKeywords: ['forest', 'nature', 'jungle', 'wood', 'rain', '森林', '自然', '丛林', '雨林'], sfxKeywords: ['nature', 'forest', 'bird', 'wind', 'rain', 'leaf', 'ambient'] },
  { sceneKeywords: ['battle', 'war', 'fight', 'sword', 'combat', '战斗', '战争', '剑'], sfxKeywords: ['sword', 'hit', 'impact', 'shoot', 'explosion', 'arrow', 'bow', 'gun', '剑', '击中'] },
  { sceneKeywords: ['ui', 'button', 'click', 'menu', 'interface', '按钮', '点击', '菜单'], sfxKeywords: ['click', 'ui', 'button', 'switch', 'interface', 'confirm'] },
]

/**
 * 中文音效描述 -> 英文文件名关键词。
 * 帮助把 agent/用户写的中文 sound_effect 映射到现有的英文 SFX 素材。
 */
/**
 * 中文音效描述 -> 英文文件名关键词。
 * 只保留本地 SFX 库中确实存在的素材方向（door/wood、cloth、footstep、
 * glass/paper/book 等），避免把不存在的概念（fire/horse/sword/water）
 * 映射后反而拉来不相关的文件。
 */
const SFX_TRANSLATIONS: Record<string, string[]> = {
  纸: ['paper', 'page', 'scroll', 'book'],
  纸张: ['paper', 'page', 'scroll'],
  奏疏: ['paper', 'page'],
  上书: ['paper', 'page'],
  圣旨: ['paper', 'scroll'],
  地图: ['paper', 'map'],
  毛笔: ['paper', 'write'],
  朱笔: ['paper'],
  封蜡: ['paper'],
  书: ['book', 'page'],
  翻: ['book', 'page'],
  页: ['page', 'paper'],
  碗碟: ['glass', 'cup'],
  杯: ['glass', 'cup'],
  玻璃: ['glass', 'break'],
  门: ['door', 'wood', 'creak'],
  大门: ['door', 'wood'],
  城门: ['door', 'wood'],
  宫门: ['door', 'wood'],
  开门: ['door', 'open'],
  关门: ['door', 'close'],
  脚步: ['footstep', 'step', 'walk'],
  脚步声: ['footstep', 'step'],
  踏: ['step'],
  衣袍: ['cloth', 'fabric'],
  龙袍: ['cloth'],
  帷幔: ['cloth', 'fabric'],
  布: ['cloth', 'fabric'],
}

function expandChineseTokens(tokens: string[]): string[] {
  const expanded = new Set(tokens)
  for (const [cn, english] of Object.entries(SFX_TRANSLATIONS)) {
    for (const token of tokens) {
      if (token.includes(cn) || cn.includes(token)) {
        for (const e of english) expanded.add(e)
      }
    }
  }
  return Array.from(expanded)
}

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[，,、。\.!！?？;；:：]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return expandChineseTokens(tokens)
}

interface ScoredEntry {
  entry: SfxMapping['entries'][number]
  score: number
}

function scoreSfxEntries(description: string, mapping: SfxMapping): ScoredEntry[] {
  const tokens = tokenize(description)
  if (tokens.length === 0) return []

  // 先识别描述属于哪类场景
  let categorySfxKeywords: string[] = []
  for (const cat of SCENE_CATEGORIES) {
    if (cat.sceneKeywords.some(kw => tokens.some(t => t.includes(kw) || kw.includes(t)))) {
      categorySfxKeywords = cat.sfxKeywords
      break
    }
  }

  // 同时把描述里的显式音效词也纳入匹配
  const explicitKeywords: string[] = []
  for (const entry of mapping.entries) {
    for (const kw of entry.keywords) {
      if (tokens.some(t => t.includes(kw) || kw.includes(t))) {
        explicitKeywords.push(kw)
      }
    }
  }

  const scored: ScoredEntry[] = []

  for (const entry of mapping.entries) {
    const fileKws = entry.keywords
    let score = 0

    // 场景类别匹配
    for (const kw of categorySfxKeywords) {
      if (fileKws.some(fk => fk.includes(kw) || kw.includes(fk))) {
        score += 3
      }
    }

    // 描述中的显式词匹配
    for (const kw of explicitKeywords) {
      if (fileKws.some(fk => fk.includes(kw) || kw.includes(fk))) {
        score += 2
      }
    }

    // 通用文件名与 token 的包含匹配
    for (const token of tokens) {
      if (fileKws.some(fk => fk.includes(token) || token.includes(fk))) {
        score += 1
      }
    }

    if (score > 0) {
      scored.push({ entry, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored
}

/**
 * 根据 sound_effect 描述在已下载的 SFX 库中查找最合适的音频文件。
 * 返回绝对路径；未找到时返回 null。
 */
export function findSfxFile(description: string | null | undefined, exclude?: Set<string>): string | null {
  const raw = description?.trim() || ''
  if (!raw) return null

  const mapping = loadMapping()
  if (!mapping || mapping.entries.length === 0) return null

  const scored = scoreSfxEntries(raw, mapping)
  for (const { entry } of scored) {
    const absPath = getAbsolutePath(entry.relativePath)
    if (exclude && exclude.has(absPath)) continue
    return absPath
  }

  // 没有匹配到合适的音效，宁可不放也不要随机塞一个
  return null
}

/**
 * 根据 sound_effect 描述返回前 N 个候选音频文件，用于避免同一文件反复使用。
 */
export function findSfxFiles(description: string | null | undefined, limit = 3, exclude?: Set<string>): string[] {
  const raw = description?.trim() || ''
  if (!raw) return []

  const mapping = loadMapping()
  if (!mapping || mapping.entries.length === 0) return []

  const scored = scoreSfxEntries(raw, mapping)
  const result: string[] = []
  for (const { entry } of scored) {
    const absPath = getAbsolutePath(entry.relativePath)
    if (exclude && exclude.has(absPath)) continue
    result.push(absPath)
    if (result.length >= limit) break
  }
  return result
}

/**
 * 为场景匹配一段环境底噪（ambient）音频。
 * 复用已有的 SFX 库，把短音效循环播放作为持续环境层；
 * 未找到时返回 null。
 */
export function findAmbientFile(description: string | null | undefined): string | null {
  const raw = description?.trim() || ''
  if (!raw) return null

  const mapping = loadMapping()
  if (!mapping || mapping.entries.length === 0) return null

  const tokens = tokenize(raw)

  // 识别场景类别
  let categorySfxKeywords: string[] = []
  for (const cat of SCENE_CATEGORIES) {
    if (cat.sceneKeywords.some(kw => tokens.some(t => t.includes(kw) || kw.includes(t)))) {
      categorySfxKeywords = cat.sfxKeywords
      break
    }
  }
  if (categorySfxKeywords.length === 0) return null

  let best: { entry: SfxMapping['entries'][number]; score: number } | null = null

  for (const entry of mapping.entries) {
    const fileKws = entry.keywords
    let score = 0
    for (const kw of categorySfxKeywords) {
      if (fileKws.some(fk => fk.includes(kw) || kw.includes(fk))) {
        score += 3
      }
    }
    // 环境底噪更偏好持续、柔和、无冲击性的关键词；这里简单用文件名长度/loop 友好度做微调
    const base = path.basename(entry.relativePath, path.extname(entry.relativePath)).toLowerCase()
    if (!/\d/.test(base) && base.length > 3) score += 1

    if (score > 0 && (!best || score > best.score)) {
      best = { entry, score }
    }
  }

  return best ? getAbsolutePath(best.entry.relativePath) : null
}

export function getSfxLibraryStats(): { totalFiles: number; mappingExists: boolean } {
  const mapping = loadMapping()
  return {
    totalFiles: mapping?.entries.length || 0,
    mappingExists: !!mapping,
  }
}
