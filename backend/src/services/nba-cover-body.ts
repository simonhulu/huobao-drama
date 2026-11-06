import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { NbaCoverPlayer } from './nba-cover-players.js'
import { NBA_COVER_MAX_PHOTO_UPSCALE, prepareNbaCoverPhoto } from './nba-cover-photo.js'

export interface NbaBodyCrop { x: number; y: number; width: number; height: number }
export interface NbaBodyImage {
  path: string
  sha256: string
  width: number
  height: number
  crop?: NbaBodyCrop
  verification: Record<string, unknown>
}
export type NbaBodyPrepare = (input: { filename: string; playerName: string; teamName: string; teamAbbreviation: string; signal: AbortSignal }) => Promise<NbaBodyImage | null>
export type NbaBodyRequest = (url: string, kind: 'body-api' | 'body-photo') => Promise<{ bytes: Buffer; sourceUrl: string }>
export interface NbaBodyPhotoSource { sourceUrl: string; pageUrl?: string }
interface BodyInput { player: Pick<NbaCoverPlayer, 'id' | 'name' | 'teamAbbreviation'>; teamName: string; directory: string; signal: AbortSignal; recentPhotoSha256s?: string[] }
interface SourceEvidence { version: 1; sourceUrl: string; sha256: string; width: number; height: number }
type PlayerRecord = { idPlayer?: string; strPlayer?: string; strSport?: string; strRender?: string; strCutout?: string }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const normalizeName = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function nbaBodyRequestUrl(value: string, kind: 'body-api' | 'body-photo') {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('身体素材只允许受信任的 HTTPS 来源')
  if (url.hostname === 'www.pngarts.com' && !url.search && (kind === 'body-photo'
    ? /^\/files\/\d{1,3}\/[a-z\d-]{1,180}\.png$/i.test(url.pathname)
    : /^\/explore\/tag\/[a-z\d-]{1,120}$/.test(url.pathname))) {
    url.hash = ''; return url.href
  }
  if (kind === 'body-photo') {
    if (url.hostname !== 'r2.thesportsdb.com' || !/^\/images\/media\/player\/(?:render|cutout)\/[a-z\d_-]+\.png$/i.test(url.pathname) || url.search) {
      throw new Error('身体素材必须来自 TheSportsDB 的原始透明人物 PNG')
    }
  } else {
    const search = url.pathname === '/api/v1/json/123/searchplayers.php' && [...url.searchParams.keys()].join() === 'p' && Boolean(url.searchParams.get('p'))
    const lookup = url.pathname === '/api/v1/json/123/lookupplayer.php' && [...url.searchParams.keys()].join() === 'id' && /^\d{1,12}$/.test(url.searchParams.get('id') || '')
    if (url.hostname !== 'www.thesportsdb.com' || !(search || lookup)) throw new Error('身体素材仅使用 TheSportsDB 球员检索 API')
  }
  url.hash = ''
  return url.href
}

async function writeAtomic(filename: string, value: Buffer | string) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, value); await fs.rename(temporary, filename) }
  finally { await fs.unlink(temporary).catch(() => {}) }
}
async function readLimited(filename: string, limit: number) {
  if ((await fs.stat(filename)).size > limit) throw new Error('身体素材缓存大小异常')
  return fs.readFile(filename)
}
function imageUrls(record?: PlayerRecord) {
  return [...new Set([record?.strRender, record?.strCutout].filter((url): url is string => {
    if (!url) return false
    try { return nbaBodyRequestUrl(url, 'body-photo') === url } catch { return false }
  }))]
}
function recordFor(payload: unknown, key: 'player' | 'players', name: string, id?: string) {
  if (!payload || typeof payload !== 'object') return undefined
  const rows = (payload as Record<string, unknown>)[key]
  if (!Array.isArray(rows)) return undefined
  return rows.find((row: PlayerRecord | null) => row && typeof row.strPlayer === 'string' && normalizeName(row.strPlayer) === normalizeName(name)
    && row.strSport === 'Basketball' && (!id || String(row.idPlayer) === id)) as PlayerRecord | undefined
}
async function bodyMetadata(bytes: Buffer) {
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 16 * 1024 ** 2 }), metadata = await image.metadata()
  if (metadata.format !== 'png' || !metadata.hasAlpha || (metadata.pages || 1) !== 1 || !metadata.width || !metadata.height
    || metadata.width < 240 || metadata.height < 360 || metadata.width > 4096 || metadata.height > 4096) throw new Error('身体素材必须是原生像素足够的透明 PNG')
  const stats = await image.stats(), alpha = stats.channels.at(-1)!
  if (alpha.min === 255 || alpha.max === 0 || alpha.mean < 2 || !stats.channels.slice(0, 3).some(channel => channel.stdev > 2)) {
    throw new Error('身体素材缺少真实透明人物内容')
  }
  return { width: metadata.width, height: metadata.height }
}
function validCrop(crop?: NbaBodyCrop) {
  return !crop || [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
    && crop.x + crop.width <= 1.000001 && crop.y + crop.height <= 1.000001
}

export async function resolveNbaBodyPhoto(input: BodyInput, options: { request: NbaBodyRequest; prepareBody?: NbaBodyPrepare;
  additionalPhotos?: () => Promise<NbaBodyPhotoSource[]> }): Promise<NbaCoverPlayer | undefined> {
  const { signal, player } = input
  const recent = new Set(input.recentPhotoSha256s || [])
  const candidates: Array<{ player: NbaCoverPlayer; upscaleToFill: number; recentlyUsed: boolean }> = []
  signal.throwIfAborted()
  async function apiRecord(url: string, key: 'player' | 'players', id?: string) {
    url = nbaBodyRequestUrl(url, 'body-api')
    const filename = path.join(input.directory, `tsdb-player-${digest(url).slice(0, 24)}.json`)
    try {
      const payload = JSON.parse((await readLimited(filename, 2 * 1024 ** 2)).toString('utf8'))
      const record = recordFor(payload, key, player.name, id)
      if (record && imageUrls(record).length) return record
    } catch { signal.throwIfAborted() }
    const response = await options.request(url, 'body-api')
    signal.throwIfAborted()
    if (response.sourceUrl !== url || response.bytes.length > 2 * 1024 ** 2) throw new Error('球员 API 返回了非预期来源或大小')
    const payload = JSON.parse(response.bytes.toString('utf8')), record = recordFor(payload, key, player.name, id)
    // Only successful identity matches with image candidates become reusable search cache entries.
    if (record && imageUrls(record).length) {
      await fs.mkdir(input.directory, { recursive: true })
      await writeAtomic(filename, response.bytes).catch(() => {})
    }
    return record
  }
  async function source(url: string) {
    url = nbaBodyRequestUrl(url, 'body-photo')
    const filename = path.join(input.directory, `tsdb-body-${player.id}-${digest(url).slice(0, 16)}.png`)
    try {
      const evidence = JSON.parse((await readLimited(`${filename}.json`, 8192)).toString('utf8')) as SourceEvidence
      const bytes = await readLimited(filename, 8 * 1024 ** 2), metadata = await bodyMetadata(bytes)
      if (evidence.version === 1 && evidence.sourceUrl === url && evidence.sha256 === digest(bytes)
        && evidence.width === metadata.width && evidence.height === metadata.height) return { filename, evidence }
    } catch { signal.throwIfAborted() }
    const response = await options.request(url, 'body-photo')
    signal.throwIfAborted()
    if (response.sourceUrl !== url || response.bytes.length > 8 * 1024 ** 2) throw new Error('身体图片返回了非预期来源或大小')
    const metadata = await bodyMetadata(response.bytes)
    const evidence: SourceEvidence = { version: 1, sourceUrl: url, sha256: digest(response.bytes), ...metadata }
    signal.throwIfAborted()
    await fs.mkdir(input.directory, { recursive: true })
    await writeAtomic(filename, response.bytes)
    await writeAtomic(`${filename}.json`, JSON.stringify(evidence, null, 2) + '\n')
    return { filename, evidence }
  }
  try {
    let additional: NbaBodyPhotoSource[] = [], record: PlayerRecord | undefined
    try { additional = await options.additionalPhotos?.() || [] } catch { signal.throwIfAborted() }
    try {
      const search = await apiRecord(`https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=${encodeURIComponent(player.name)}`, 'player')
      record = search
      if (search && !imageUrls({ strRender: search.strRender }).length && /^\d{1,12}$/.test(String(search.idPlayer || ''))) {
        try {
          const details = await apiRecord(`https://www.thesportsdb.com/api/v1/json/123/lookupplayer.php?id=${search.idPlayer}`, 'players', String(search.idPlayer))
          if (details) record = { ...search, ...details, strRender: details.strRender || search.strRender, strCutout: details.strCutout || search.strCutout }
        } catch { signal.throwIfAborted() }
      }
    } catch { signal.throwIfAborted() }
    const sources = new Map<string, NbaBodyPhotoSource>()
    for (const candidate of [...additional.slice(0, 3), ...imageUrls(record).map(sourceUrl => ({ sourceUrl }))]) {
      try { sources.set(nbaBodyRequestUrl(candidate.sourceUrl, 'body-photo'), candidate) } catch { signal.throwIfAborted() }
    }
    for (const [url, candidateSource] of sources) {
      signal.throwIfAborted()
      try {
        const original = await source(url)
        const prepare = options.prepareBody || (await import('./nba-cover-body-image.js')).prepareNbaBodyImage as NbaBodyPrepare
        const prepared = await prepare({ filename: original.filename, playerName: player.name, teamName: input.teamName, teamAbbreviation: player.teamAbbreviation, signal })
        signal.throwIfAborted()
        if (!prepared || !validCrop(prepared.crop) || !prepared.verification || Array.isArray(prepared.verification) || typeof prepared.verification !== 'object') continue
        const bytes = await readLimited(prepared.path, 8 * 1024 ** 2), metadata = await bodyMetadata(bytes)
        if (prepared.sha256 !== digest(bytes) || prepared.width !== metadata.width || prepared.height !== metadata.height
          || prepared.width > original.evidence.width || prepared.height > original.evidence.height) continue
        const visible = await prepareNbaCoverPhoto(bytes, prepared.crop)
        signal.throwIfAborted()
        const candidate: NbaCoverPlayer = { ...player, photoKind: 'body', photoPath: prepared.path, photoSha256: prepared.sha256, photoWidth: prepared.width, photoHeight: prepared.height,
          sourceUrl: url, ...(prepared.crop ? { photoCrop: prepared.crop } : {}), photoVerification: { ...prepared.verification,
            ...(candidateSource.pageUrl ? { sourcePageUrl: candidateSource.pageUrl } : {}),
            sourceSha256: original.evidence.sha256, sourceWidth: original.evidence.width, sourceHeight: original.evidence.height,
            effectiveWidth: visible.width, effectiveHeight: visible.height, upscaleToFill: visible.upscaleToFill,
            cropOmittedForResolution: visible.cropOmittedForResolution } }
        candidates.push({ player: candidate, upscaleToFill: visible.upscaleToFill,
          recentlyUsed: recent.has(original.evidence.sha256) || recent.has(prepared.sha256) })
      } catch { signal.throwIfAborted() }
    }
  } catch { signal.throwIfAborted() }
  const clear = candidates.filter(candidate => candidate.upscaleToFill <= NBA_COVER_MAX_PHOTO_UPSCALE)
  if (clear.length) return (clear.find(candidate => !candidate.recentlyUsed) || clear[0]).player
  candidates.sort((a, b) => a.upscaleToFill - b.upscaleToFill)
  // Reuse is secondary to visible detail; prefer an unused pose only within 10% of the best available resolution.
  const comparable = candidates.filter(candidate => candidate.upscaleToFill <= candidates[0]!.upscaleToFill * 1.1)
  return (comparable.find(candidate => !candidate.recentlyUsed) || candidates[0])?.player
}
