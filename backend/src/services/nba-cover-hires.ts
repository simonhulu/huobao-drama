import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseHTML } from 'linkedom'
import { z } from 'zod'
import type { NbaBodyRequest } from './nba-cover-body.js'

const METHOD = 'pngarts-hires-v1'
const LIMIT = 2 * 1024 ** 2
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalizedName = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const imageWords = new Set(['png', 'transparent', 'download', 'free', 'image', 'images', 'picture', 'pictures', 'photo', 'photos', 'background', 'high', 'quality'])
const imageSchema = z.object({ name: z.string().min(1).max(240), sourceUrl: z.string().max(2048), pageUrl: z.string().max(2048),
  width: z.number().int().min(600).max(4096), height: z.number().int().min(750).max(4096) }).strict()
type Image = z.infer<typeof imageSchema>
const cacheSchema = z.object({ version: z.literal(1), method: z.literal(METHOD), inputHash: z.string(), playerName: z.string(),
  tagUrl: z.string(), imagesSha256: z.string(), images: z.array(imageSchema).min(1).max(3) }).strict()

export function nbaHiresSourceUrl(value: string, kind: 'photo' | 'page') {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'www.pngarts.com' || url.username || url.password || url.port || url.search || url.hash
    || !(kind === 'photo' ? /^\/files\/\d+\/[A-Za-z0-9-]+\.png$/ : /^\/explore\/\d+$/).test(url.pathname)) {
    throw new Error('高清球员素材来源不受支持')
  }
  return url.href
}

function namePrefix(value: string, playerName: string) {
  const name = normalizedName(value)
  return name === playerName || name.startsWith(`${playerName} `)
}

function validImage(value: unknown, playerName: string): Image | undefined {
  const parsed = imageSchema.safeParse(value)
  if (!parsed.success || !namePrefix(parsed.data.name, playerName)) return undefined
  const suffix = normalizedName(parsed.data.name).slice(playerName.length).trim()
  if (suffix && suffix.split(' ').some(word => !imageWords.has(word))) return undefined
  try {
    nbaHiresSourceUrl(parsed.data.sourceUrl, 'photo')
    nbaHiresSourceUrl(parsed.data.pageUrl, 'page')
    return parsed.data
  } catch { return undefined }
}

function structuredImages(value: unknown): unknown[] {
  const queue: unknown[] = [value], result: unknown[] = []
  for (let index = 0; index < queue.length && index < 1024; index++) {
    const node = queue[index]
    if (Array.isArray(node)) { queue.push(...node.slice(0, 1024 - queue.length)); continue }
    if (!node || typeof node !== 'object') continue
    const row = node as Record<string, unknown>
    if (row['@type'] === 'ImageObject' || Array.isArray(row['@type']) && row['@type'].includes('ImageObject')) result.push(row)
    if (row['@graph']) queue.push(row['@graph'])
  }
  return result
}

/** Discover source metadata only; downloaded pixels still require the normal identity, team and body checks. */
export async function discoverNbaHiresPhotos(input: { playerName: string; directory: string; signal: AbortSignal }, request: NbaBodyRequest): Promise<Array<{ sourceUrl: string; pageUrl: string }>> {
  input.signal.throwIfAborted()
  const playerName = normalizedName(input.playerName)
  if (playerName.length < 3 || playerName.length > 120 || !/^[a-z0-9]+(?: [a-z0-9]+)+$/.test(playerName)) return []
  const tagUrl = `https://www.pngarts.com/explore/tag/${playerName.replaceAll(' ', '-')}`
  const inputHash = digest([METHOD, playerName, tagUrl])
  const filename = path.join(input.directory, `nba-hires-${inputHash.slice(0, 24)}.json`)
  const output = (images: Image[]) => images.map(({ sourceUrl, pageUrl }) => ({ sourceUrl, pageUrl }))
  try {
    if ((await fs.stat(filename)).size > 65536) throw new Error('高清素材缓存过大')
    const cached = cacheSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')))
    if (cached.inputHash !== inputHash || cached.playerName !== playerName || cached.tagUrl !== tagUrl
      || cached.imagesSha256 !== digest(cached.images) || cached.images.some(image => !validImage(image, playerName))
      || new Set(cached.images.map(image => image.sourceUrl)).size !== cached.images.length) throw new Error('高清素材缓存身份不符')
    input.signal.throwIfAborted()
    return output(cached.images)
  } catch { input.signal.throwIfAborted() }
  try {
    const response = await request(tagUrl, 'body-api')
    input.signal.throwIfAborted()
    if (response.sourceUrl !== tagUrl || !response.bytes.length || response.bytes.length > LIMIT) return []
    const { document } = parseHTML(response.bytes.toString('utf8'))
    const canonical = document.querySelectorAll('link[rel="canonical"]')
    const titles = [document.querySelector('h1')?.textContent?.trim(), document.querySelector('title')?.textContent?.trim()].filter((value): value is string => Boolean(value))
    if (canonical.length !== 1 || canonical[0].getAttribute('href') !== tagUrl || !titles.length || titles.some(title => !namePrefix(title, playerName))) return []
    const discovered: Image[] = []
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let rows: unknown[]
      try { rows = structuredImages(JSON.parse(script.textContent || '')) } catch { continue }
      for (const value of rows) {
        const row = value as Record<string, unknown>
        if (row.encodingFormat && row.encodingFormat !== 'image/png') continue
        const image = validImage({ name: row.name, sourceUrl: row.contentUrl, pageUrl: row.url, width: row.width, height: row.height }, playerName)
        if (image) discovered.push(image)
      }
    }
    const unique = new Map<string, Image>()
    for (const image of discovered.sort((a, b) => b.height - a.height || b.width - a.width)) {
      if (!unique.has(image.sourceUrl)) unique.set(image.sourceUrl, image)
    }
    const images = [...unique.values()].slice(0, 3)
    input.signal.throwIfAborted()
    if (!images.length) return []
    const temporary = `${filename}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(input.directory, { recursive: true })
      input.signal.throwIfAborted()
      await fs.writeFile(temporary, JSON.stringify({ version: 1, method: METHOD, inputHash, playerName, tagUrl,
        imagesSha256: digest(images), images }, null, 2) + '\n', { mode: 0o600 })
      input.signal.throwIfAborted()
      await fs.rename(temporary, filename)
    } catch { input.signal.throwIfAborted() }
    finally { await fs.unlink(temporary).catch(() => {}) }
    return output(images)
  } catch {
    input.signal.throwIfAborted()
    return []
  }
}
