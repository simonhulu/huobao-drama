#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const defaultStockDir = path.join(root, 'data/static/remotion/stock')
const providers = new Set(['pexels', 'pixabay', 'coverr'])
const licenseUrls = {
  pexels: 'https://www.pexels.com/license/',
  pixabay: 'https://pixabay.com/service/license-summary/',
  coverr: 'https://coverr.co/license',
}

// Keep the standalone CLI consistent with the backend: provider keys live in
// backend/.env, while explicit shell variables still take precedence.
for (const envFile of ['.env', '.env.local']) {
  const filePath = path.join(root, 'backend', envFile)
  try {
    process.loadEnvFile(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function cleanString(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function firstUrl(...values) {
  return values.map(cleanString).find((value) => /^https?:\/\//i.test(value)) || ''
}

function envNamesFor(provider) {
  return [`${provider.toUpperCase()}_API_KEY`, `${provider.toUpperCase()}_API_KEYS`]
}

export function getProviderApiKey(provider, env = process.env) {
  const names = envNamesFor(provider)
  for (const name of names) {
    const raw = env[name]
    if (!raw) continue
    const key = String(raw).split(',').map((value) => value.trim()).find(Boolean)
    if (key) return key
  }
  throw new Error(`Missing API key for ${provider}. Set ${names.join(' or ')}.`)
}

function chooseBestVideoFile(files) {
  const candidates = (Array.isArray(files) ? files : Object.values(files || {}))
    .map((file) => ({
      width: Math.round(toNumber(file?.width)),
      height: Math.round(toNumber(file?.height)),
      downloadUrl: firstUrl(file?.link, file?.url, file?.download_url, file?.downloadUrl),
    }))
    .filter((file) => file.downloadUrl && file.width >= 720 && file.height > 0 && file.width > file.height)
    .sort((a, b) => {
      const aRatioDelta = Math.abs(a.width / a.height - 16 / 9)
      const bRatioDelta = Math.abs(b.width / b.height - 16 / 9)
      if (aRatioDelta !== bRatioDelta) return aRatioDelta - bRatioDelta
      return b.width - a.width
    })
  return candidates[0] || null
}

function normalizeItem({ provider, videoId, title, creator, duration, width, height, sourceUrl, downloadUrl, query }) {
  if (!videoId || !downloadUrl) return null
  return {
    provider,
    videoId: cleanString(videoId),
    title: cleanString(title),
    creator: cleanString(creator),
    duration: toNumber(duration),
    width: Math.round(toNumber(width)),
    height: Math.round(toNumber(height)),
    sourceUrl: cleanString(sourceUrl),
    downloadUrl: cleanString(downloadUrl),
    licenseUrl: licenseUrls[provider],
    query: cleanString(query),
  }
}

function meetsDuration(item, minDuration) {
  return toNumber(item?.duration) >= toNumber(minDuration)
}

export function normalizePexelsVideos(response, { query = '', minDuration = 0 } = {}) {
  return (Array.isArray(response?.videos) ? response.videos : [])
    .filter((video) => meetsDuration(video, minDuration))
    .map((video) => {
      const selected = chooseBestVideoFile(video?.video_files)
      return selected && normalizeItem({
        provider: 'pexels',
        videoId: video?.id,
        title: video?.alt || video?.title || '',
        creator: video?.user?.name,
        duration: video?.duration,
        width: selected.width,
        height: selected.height,
        sourceUrl: video?.url,
        downloadUrl: selected.downloadUrl,
        query,
      })
    })
    .filter(Boolean)
}

export function normalizePixabayVideos(response, { query = '', minDuration = 0 } = {}) {
  return (Array.isArray(response?.hits) ? response.hits : [])
    .filter((video) => meetsDuration(video, minDuration))
    .map((video) => {
      const selected = chooseBestVideoFile(video?.videos)
      return selected && normalizeItem({
        provider: 'pixabay',
        videoId: video?.id,
        title: video?.tags || '',
        creator: video?.user,
        duration: video?.duration,
        width: selected.width,
        height: selected.height,
        sourceUrl: video?.pageURL,
        downloadUrl: selected.downloadUrl,
        query,
      })
    })
    .filter(Boolean)
}

export function normalizeCoverrVideos(response, { query = '', minDuration = 0 } = {}) {
  return (Array.isArray(response?.hits) ? response.hits : [])
    .map((video) => {
      const duration = Math.floor(toNumber(video?.duration))
      if (duration < toNumber(minDuration)) return null
      const selected = chooseBestVideoFile([
        {
          width: video?.width || video?.metadata?.width || video?.video_width || 1920,
          height: video?.height || video?.metadata?.height || video?.video_height || 1080,
          url: video?.urls?.mp4_download || video?.urls?.mp4 || video?.download_url,
        },
      ])
      return selected && normalizeItem({
        provider: 'coverr',
        videoId: video?.id,
        title: video?.title || video?.description || '',
        creator: video?.user?.name || video?.author || '',
        duration,
        width: selected.width,
        height: selected.height,
        sourceUrl: firstUrl(video?.url, video?.source_url, video?.urls?.html) || (video?.slug ? `https://coverr.co/videos/${video.slug}` : ''),
        downloadUrl: selected.downloadUrl,
        query,
      })
    })
    .filter(Boolean)
}

async function fetchJson(url, options, fetchImpl = fetch) {
  const response = await fetchImpl(url, options)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Request failed ${response.status} ${response.statusText || ''}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  return response.json()
}

export async function searchStockVideos({ provider, query, limit = 10, minDuration = 0, env = process.env, fetchImpl = fetch }) {
  if (!providers.has(provider)) throw new Error(`Unsupported provider "${provider}". Use pexels, pixabay, or coverr.`)
  if (!query) throw new Error('Missing --query.')
  const apiKey = getProviderApiKey(provider, env)
  const normalizedLimit = Math.max(1, Math.min(80, Number.parseInt(limit, 10) || 10))
  const normalizedMinDuration = Math.max(0, Number.parseFloat(minDuration) || 0)

  if (provider === 'pexels') {
    const params = new URLSearchParams({ query, per_page: String(normalizedLimit), orientation: 'landscape' })
    const body = await fetchJson(`https://api.pexels.com/videos/search?${params}`, {
      headers: { Authorization: apiKey },
    }, fetchImpl)
    return normalizePexelsVideos(body, { query, minDuration: normalizedMinDuration }).slice(0, normalizedLimit)
  }

  if (provider === 'pixabay') {
    const params = new URLSearchParams({
      q: query,
      video_type: 'all',
      per_page: String(Math.min(200, Math.max(3, normalizedLimit * 3))),
      key: apiKey,
    })
    const body = await fetchJson(`https://pixabay.com/api/videos/?${params}`, {}, fetchImpl)
    return normalizePixabayVideos(body, { query, minDuration: normalizedMinDuration }).slice(0, normalizedLimit)
  }

  const params = new URLSearchParams({
    query,
    page_size: String(Math.min(100, Math.max(3, normalizedLimit * 3))),
    urls: 'true',
    sort: 'popular',
  })
  const body = await fetchJson(`https://api.coverr.co/videos?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, fetchImpl)
  return normalizeCoverrVideos(body, { query, minDuration: normalizedMinDuration }).slice(0, normalizedLimit)
}

export function buildSearchManifest({ provider, query, minDuration = 0, results, now = () => new Date().toISOString() }) {
  return {
    schemaVersion: 1,
    kind: 'videoeditor-stock-videos',
    provider,
    query,
    minDuration: toNumber(minDuration),
    generatedAt: now(),
    results,
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = { command }
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) {
      if (!args.provider && providers.has(token)) args.provider = token
      continue
    }
    const key = token.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  args.minDuration = args['min-duration'] ?? args.minDuration
  return args
}

function usage() {
  return [
    'Usage:',
    '  node scripts/videoeditor/stock_videos.mjs search --provider pexels --query "clouds" [--limit 10] [--min-duration 4] [--output manifest.json]',
    '  node scripts/videoeditor/stock_videos.mjs download --manifest manifest.json [--dest data/static/remotion/stock]',
  ].join('\n')
}

function safeFilePart(value) {
  return cleanString(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'video'
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

export async function downloadFromManifest({ manifestPath, dest = defaultStockDir, fetchImpl = fetch, now = () => new Date().toISOString() }) {
  if (!manifestPath) throw new Error('Missing --manifest.')
  const manifest = await readJson(manifestPath)
  const results = Array.isArray(manifest?.results) ? manifest.results : []
  await fs.mkdir(dest, { recursive: true })

  let downloaded = 0
  for (const item of results) {
    if (!item?.downloadUrl) continue
    const provider = safeFilePart(item.provider || manifest.provider || 'stock')
    const videoId = safeFilePart(item.videoId || item.id)
    const localPath = path.join(dest, `${provider}-${videoId}.mp4`)
    const response = await fetchImpl(item.downloadUrl)
    if (!response.ok) throw new Error(`Download failed for ${provider}-${videoId}: ${response.status} ${response.statusText || ''}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(localPath, bytes)
    item.localPath = localPath
    item.downloadedAt = now()
    item.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    item.bytes = bytes.length
    downloaded += 1
  }

  manifest.downloadedAt = now()
  await writeJson(manifestPath, manifest)
  return { manifestPath, downloaded, skipped: results.length - downloaded, dest }
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'search') {
    const results = await searchStockVideos({
      provider: args.provider,
      query: args.query,
      limit: args.limit,
      minDuration: args.minDuration,
    })
    const manifest = buildSearchManifest({
      provider: args.provider,
      query: args.query,
      minDuration: args.minDuration,
      results,
    })
    const outputPath = args.output || args.manifest
    if (outputPath) {
      await writeJson(outputPath, manifest)
      console.log(JSON.stringify({ output: outputPath, results: results.length }, null, 2))
    } else {
      console.log(JSON.stringify(manifest, null, 2))
    }
    return
  }

  if (args.command === 'download') {
    const result = await downloadFromManifest({
      manifestPath: args.manifest || args.output,
      dest: args.dest || defaultStockDir,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  throw new Error(usage())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
