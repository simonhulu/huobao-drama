#!/usr/bin/env node

/**
 * Producer entry point for the database-backed Remotion planner.
 *
 * The script intentionally owns local catalog discovery and API writes. The
 * browser only observes the resulting project snapshot.
 */

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)

function value(name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function required(name) {
  const result = value(name)
  if (!result) throw new Error(`Missing ${name}`)
  return result
}

function apiBase() {
  return (value('--api', process.env.REMOTION_API_BASE || 'http://localhost:5679/api/v1')).replace(/\/$/, '')
}

function localPathExists(localPath) {
  if (!localPath) return false
  const normalized = String(localPath).replace(/^data[\\/]/, '')
  return fs.existsSync(path.join(root, 'data', normalized)) || fs.existsSync(path.resolve(root, String(localPath)))
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function catalogFiles() {
  const explicit = value('--stock-file')
  if (explicit) return explicit.split(',').map((file) => path.resolve(root, file.trim()))
  const tempDir = path.join(root, 'data/temp')
  return fs.readdirSync(tempDir)
    .filter((file) => file.endsWith('.json') && (file.endsWith('-selected.json') || file === 'videoeditor-stock-broll-114-1.json'))
    .sort()
    .map((file) => path.join(tempDir, file))
}

function buildCatalog() {
  const byKey = new Map()
  for (const filePath of catalogFiles()) {
    if (!fs.existsSync(filePath)) continue
    const body = readJson(filePath)
    const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.results) ? body.results : []
    for (const item of items) {
      const localPath = item.localPath || item.local_path
      if (!localPathExists(localPath)) continue
      const provider = String(item.provider || body.provider || '')
      const videoId = String(item.videoId || item.video_id || item.id || path.basename(localPath))
      if (!provider || !videoId) continue
      const key = `${provider}:${videoId}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        provider,
        videoId,
        title: item.title || item.tags || '',
        creator: item.creator || item.user || '',
        query: item.query || body.query || '',
        sourceUrl: item.sourceUrl || item.source_url || '',
        downloadUrl: item.downloadUrl || item.download_url || '',
        licenseUrl: item.licenseUrl || item.license_url || '',
        localPath: String(localPath).replaceAll(path.sep, '/'),
        duration: Number(item.duration) || null,
        width: Number(item.width) || null,
        height: Number(item.height) || null,
      })
    }
  }
  return [...byKey.values()]
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase()}${pathname}`, {
    ...options,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) },
  })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : null } catch { throw new Error(`${pathname} returned invalid JSON`) }
  if (!response.ok || body?.code >= 400) throw new Error(`${pathname} failed: ${body?.message || raw}`)
  return body?.data ?? body
}

async function main() {
  const projectId = required('--project-id')
  const catalog = buildCatalog()
  const result = await request(`/remotion/projects/${projectId}/plan`, {
    method: 'POST',
    body: JSON.stringify({ stock_catalog: catalog }),
  })
  console.log(JSON.stringify({
    projectId: Number(projectId),
    stockCatalog: catalog.length,
    summary: result.plan?.summary || null,
    activeShots: result.snapshot?.shots?.length || 0,
    activeAssets: result.snapshot?.shots?.reduce((sum, shot) => sum + (shot.assets?.length || 0), 0) || 0,
  }, null, 2))
}

main().catch((error) => {
  console.error(`[remotion-plan] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
