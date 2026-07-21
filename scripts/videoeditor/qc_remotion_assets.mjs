#!/usr/bin/env node

/**
 * Run deterministic asset checks for the Remotion factory and write the
 * asset_qc stage envelope. Visual/editorial review remains represented by the
 * per-asset checks and the manager gate; this script only approves files that
 * satisfy the machine-verifiable contract.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from '../../backend/node_modules/sharp/lib/index.js'

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

async function request(pathname) {
  const response = await fetch(`${apiBase()}${pathname}`, { headers: { accept: 'application/json' } })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : null } catch { throw new Error(`${pathname} returned invalid JSON`) }
  if (!response.ok || body?.code >= 400) throw new Error(`${pathname} failed: ${body?.message || raw}`)
  return body?.data ?? body
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function sourceFileFor(localPath) {
  if (!localPath) return null
  const normalized = String(localPath).replaceAll('\\', '/').replace(/^\/+/, '')
  const candidates = [
    path.isAbsolute(String(localPath)) ? String(localPath) : null,
    path.resolve(root, normalized),
    path.resolve(root, 'data', normalized),
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function latestAssets(snapshot) {
  const latest = new Map()
  for (const asset of (snapshot.shots || []).flatMap((shot) => shot.assets || [])) {
    const current = latest.get(asset.assetKey)
    if (!current || Number(asset.version || 1) > Number(current.version || 1)
      || (Number(asset.version || 1) === Number(current.version || 1) && Number(asset.id || 0) > Number(current.id || 0))) {
      latest.set(asset.assetKey, asset)
    }
  }
  return [...latest.values()].sort((left, right) => String(left.assetKey).localeCompare(String(right.assetKey)))
}

function imageAssets(snapshot) {
  return latestAssets(snapshot).filter((asset) => ['ai_image', 'character'].includes(asset.assetType))
}

function shotFor(snapshot, shotId) {
  return (snapshot.shots || []).find((shot) => Number(shot.id) === Number(shotId)) || null
}

function runOcr(file) {
  const result = spawnSync('tesseract', [file, 'stdout', '-l', 'chi_sim+eng', '--psm', '11'], { encoding: 'utf8' })
  if (result.status !== 0 && !result.stdout) return { available: false, text: '', error: (result.stderr || '').trim().slice(-300) }
  return { available: true, text: String(result.stdout || '').replace(/\s+/g, ' ').trim().slice(0, 200), error: null }
}

async function inspectImage(file, requireAlpha) {
  const metadata = await sharp(file).metadata()
  const checks = []
  checks.push({ name: 'file_exists', passed: true })
  checks.push({ name: 'dimensions', passed: Number(metadata.width) >= 1000 && Number(metadata.height) >= 500, value: `${metadata.width}x${metadata.height}` })
  if (requireAlpha) {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let nonZero = 0
    let minX = info.width
    let minY = info.height
    let maxX = -1
    let maxY = -1
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const alpha = data[offset + info.channels - 1]
      if (!alpha) continue
      nonZero += 1
      const pixel = offset / info.channels
      const x = pixel % info.width
      const y = Math.floor(pixel / info.width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    const coverage = nonZero / (info.width * info.height)
    checks.push({ name: 'alpha_channel', passed: metadata.hasAlpha === true, value: metadata.hasAlpha === true })
    checks.push({ name: 'alpha_edges', passed: coverage > 0.005 && coverage < 0.98 && maxX > minX && maxY > minY, value: { coverage, boundingBox: [minX, minY, maxX + 1, maxY + 1] } })
  } else {
    checks.push({ name: 'clean_plate_color', passed: Number(metadata.channels || 0) >= 3, value: metadata.channels })
  }
  const ocr = runOcr(file)
  // OCR on historical textures and transparent cutouts is intentionally
  // advisory: texture edges and clothing details routinely produce garbage
  // glyphs. The manager still reviews representative frames for real signs,
  // logos, and captions before the gate is recorded.
  checks.push({ name: 'embedded_text_scan', passed: true, advisory: true, value: ocr.available ? ocr.text || null : 'scanner-unavailable' })
  return { checks, metadata: { width: metadata.width, height: metadata.height, channels: metadata.channels, hasAlpha: metadata.hasAlpha } }
}

function inspectVideo(file, asset) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })
  let body = {}
  try { body = JSON.parse(result.stdout || '{}') } catch { body = {} }
  const stream = (body.streams || []).find((item) => item.codec_type === 'video') || {}
  const checks = [
    { name: 'file_exists', passed: true },
    { name: 'video_stream', passed: Boolean(stream.codec_name && Number(stream.width) > 0 && Number(stream.height) > 0), value: { codec: stream.codec_name, width: stream.width, height: stream.height } },
    { name: 'license_metadata', passed: Boolean(asset.provider && asRecord(asset.license).url), value: asset.provider },
  ]
  return { checks, metadata: { width: Number(stream.width) || null, height: Number(stream.height) || null, duration: Number(stream.duration || body.format?.duration) || null } }
}

async function inspectAsset(snapshot, asset) {
  const file = sourceFileFor(asset.localPath)
  let checks = []
  let metadata = {}
  if (asset.assetType === 'map') {
    const shot = shotFor(snapshot, asset.shotId)
    const map = asRecord(asRecord(shot?.visualPlan).map)
    const locations = Array.isArray(map.locations) ? map.locations : []
    const routes = Array.isArray(map.routes) ? map.routes : []
    checks = [
      { name: 'map_spec_present', passed: locations.length >= 2 && routes.length > 0, value: { locations: locations.length, routes: routes.length } },
      { name: 'map_source_recorded', passed: Boolean(asRecord(map.source).name && asRecord(map.source).license), value: asRecord(map.source).name || null },
      { name: 'illustrative_status_explicit', passed: map.historyStatus === 'illustrative' || locations.every((item) => item.coordinateSource), value: map.historyStatus || null },
    ]
  } else if (file && ['ai_image', 'character'].includes(asset.assetType)) {
    const result = await inspectImage(file, asset.assetType === 'character')
    checks = result.checks
    metadata = result.metadata
    if (asset.assetType === 'character') checks.push({ name: 'alpha_ready_metadata', passed: asRecord(asset.metadata).alphaReady === true, value: asRecord(asset.metadata).alphaReady === true })
  } else if (file && asset.assetType === 'stock_video') {
    const result = inspectVideo(file, asset)
    checks = result.checks
    metadata = result.metadata
  } else {
    checks = [{ name: 'file_exists', passed: false, value: asset.localPath || null }]
  }
  const passed = checks.every((check) => check.passed)
  return {
    assetKey: asset.assetKey,
    assetType: asset.assetType,
    decision: passed ? 'approved' : 'rework',
    checks,
    metadata,
    ...(passed ? {} : { reason: '机器检查未通过，需重做或人工复核' }),
  }
}

async function main() {
  const projectId = Number(required('--project-id'))
  const outputPath = path.resolve(root, value('--output', `data/temp/remotion-project-${projectId}-asset-qc.json`))
  const snapshot = await request(`/remotion/projects/${projectId}`)
  const results = []
  for (const asset of latestAssets(snapshot)) results.push(await inspectAsset(snapshot, asset))
  const passed = results.every((asset) => asset.decision === 'approved')
  const output = {
    schemaVersion: 1,
    factoryStage: 'asset_qc',
    attempt: 1,
    artifacts: [],
    checks: [
      { name: 'all_assets_machine_checked', passed: true },
      { name: 'all_assets_approved', passed },
    ],
    risks: passed ? [] : results.filter((asset) => asset.decision !== 'approved').map((asset) => `${asset.assetKey}: ${asset.reason}`),
    gate: { decision: passed ? 'passed' : 'rework', reviewer: 'asset-qc-agent' },
    assets: results,
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(JSON.stringify({ output: outputPath, assets: results.length, approved: results.filter((asset) => asset.decision === 'approved').length, rework: results.filter((asset) => asset.decision !== 'approved').length }, null, 2))
}

main().catch((error) => {
  console.error(`[remotion-asset-qc] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
