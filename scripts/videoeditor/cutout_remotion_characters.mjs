#!/usr/bin/env node

/**
 * Convert completed Remotion character sources into versioned RGBA layers.
 * The actual segmentation remains in the existing Python/rembg POC so the
 * model can be swapped without changing the database producer contract.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)

function value(name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function hasFlag(name) {
  return args.includes(name)
}

function required(name) {
  const result = value(name)
  if (!result) throw new Error(`Missing ${name}`)
  return result
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function apiBase() {
  return (value('--api', process.env.REMOTION_API_BASE || 'http://localhost:5679/api/v1')).replace(/\/$/, '')
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

function safePart(value) {
  return String(value).replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'character'
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function latestCharacterAssets(snapshot) {
  const latest = new Map()
  for (const asset of (snapshot.shots || []).flatMap((shot) => shot.assets || [])) {
    if (asset.assetType !== 'character') continue
    const current = latest.get(asset.assetKey)
    if (!current || Number(asset.version || 1) > Number(current.version || 1)) latest.set(asset.assetKey, asset)
  }
  return [...latest.values()].sort((left, right) => String(left.assetKey).localeCompare(String(right.assetKey)))
}

function outputRelativePath(projectId, assetKey) {
  return `data/static/remotion/project-${projectId}/characters/${safePart(assetKey)}.png`
}

function eligibleAssets(snapshot) {
  const assets = latestCharacterAssets(snapshot)
    .filter((asset) => asset.status === 'completed')
    .filter((asset) => asRecord(asset.metadata).alphaReady !== true)
    .map((asset) => ({ ...asset, sourceFile: sourceFileFor(asset.localPath) }))
    .filter((asset) => asset.sourceFile)
  const limit = Number(value('--limit', '0'))
  return Number.isFinite(limit) && limit > 0 ? assets.slice(0, limit) : assets
}

function validateMetadata(metadata) {
  const bbox = metadata.alphaBoundingBox
  const coverage = Number(metadata.alphaCoverage)
  return Array.isArray(bbox) && bbox.length === 4 && bbox[2] > bbox[0] && bbox[3] > bbox[1]
    && Number.isFinite(coverage) && coverage > 0.005 && coverage < 0.98
}

async function writeStage(projectId, snapshot, failed = []) {
  const assets = latestCharacterAssets(snapshot)
  const required = assets.filter((asset) => ['ai_image', 'character'].includes(asset.assetType))
  const output = {
    schemaVersion: 1,
    factoryStage: 'asset_production',
    attempt: 1,
    artifacts: [],
    checks: [{ name: 'character_alpha_gate', passed: failed.length === 0 }],
    risks: failed.length ? [`${failed.length} 个人物透明层未通过抠图质量门禁`] : [],
    assets: required.map((asset) => ({
      assetKey: asset.assetKey,
      status: asset.status,
      version: asset.version || 1,
      alphaReady: asset.assetType === 'character' ? asRecord(asset.metadata).alphaReady === true : undefined,
    })),
  }
  const complete = required.length > 0 && required.every((asset) => asset.status === 'completed'
    && (asset.assetType !== 'character' || asRecord(asset.metadata).alphaReady === true))
  const stage = await request(`/remotion/projects/${projectId}/stages/asset_production`, {
    method: 'POST',
    body: JSON.stringify({
      status: failed.length ? 'failed' : complete ? 'succeeded' : 'running',
      input: { producer: 'cutout_remotion_characters', model: value('--model', 'birefnet-general-lite') },
      output: failed.length ? { ...output, failures: failed } : output,
      error_code: failed.length ? 'character_cutout_failed' : undefined,
      error_message: failed.length ? `${failed.length} 个透明人物层处理失败` : undefined,
    }),
  })
  return { stage, output }
}

async function main() {
  const projectId = Number(required('--project-id'))
  if (!Number.isInteger(projectId) || projectId < 1) throw new Error('project id must be a positive integer')
  const snapshot = await request(`/remotion/projects/${projectId}`)
  const assets = eligibleAssets(snapshot)
  if (hasFlag('--dry-run')) {
    console.log(JSON.stringify({ dryRun: true, projectId, model: value('--model', 'birefnet-general-lite'), assets: assets.map((asset) => ({ assetKey: asset.assetKey, source: asset.localPath, sourceExists: Boolean(asset.sourceFile), version: asset.version || 1 })) }, null, 2))
    return
  }

  const python = value('--python', process.env.REMBG_PYTHON || (fs.existsSync('/tmp/huobao-rembg-venv/bin/python') ? '/tmp/huobao-rembg-venv/bin/python' : 'python3'))
  const model = value('--model', 'birefnet-general-lite')
  const failures = []
  const processed = []
  for (const asset of assets) {
    const tempDir = path.join(root, 'data/temp/remotion-cutouts', `project-${projectId}`, `${safePart(asset.assetKey)}-v${asset.version || 1}`)
    const finalRelative = outputRelativePath(projectId, asset.assetKey)
    const finalFile = path.resolve(root, finalRelative)
    fs.mkdirSync(tempDir, { recursive: true })
    fs.mkdirSync(path.dirname(finalFile), { recursive: true })
    const result = spawnSync(python, [
      path.join(root, 'tools/cutout-poc/remove_background.py'),
      '--input', asset.sourceFile,
      '--output-dir', tempDir,
      '--model', model,
    ], { encoding: 'utf8' })
    if (result.status !== 0) {
      failures.push({ assetKey: asset.assetKey, reason: (result.stderr || result.stdout || 'cutout process failed').trim().slice(-1000) })
      continue
    }
    const metadataFile = path.join(tempDir, 'metadata.json')
    const foregroundFile = path.join(tempDir, 'subject.png')
    if (!fs.existsSync(metadataFile) || !fs.existsSync(foregroundFile)) {
      failures.push({ assetKey: asset.assetKey, reason: 'cutout outputs are incomplete' })
      continue
    }
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
    if (!validateMetadata(metadata)) {
      failures.push({ assetKey: asset.assetKey, reason: 'alpha quality gate failed', metadata })
      continue
    }
    fs.copyFileSync(foregroundFile, finalFile)
    const updatedMetadata = {
      ...asRecord(asset.metadata),
      role: 'character-alpha-layer',
      requiresAlpha: true,
      alphaReady: true,
      alphaModel: model,
      alphaCoverage: metadata.alphaCoverage,
      alphaBoundingBox: metadata.alphaBoundingBox,
      sourceOpaquePath: asset.localPath,
      sourceAssetVersion: asset.version || 1,
      processedAt: new Date().toISOString(),
    }
    const updated = await request(`/remotion/projects/${projectId}/assets`, {
      method: 'POST',
      body: JSON.stringify({
        assetKey: asset.assetKey,
        assetType: 'character',
        shotId: asset.shotId,
        provider: asset.provider,
        status: 'completed',
        localPath: finalRelative,
        mimeType: 'image/png',
        width: Number(metadata.width) || asset.width || null,
        height: Number(metadata.height) || asset.height || null,
        imageGenerationId: asset.imageGenerationId || null,
        sourceUrl: asset.sourceUrl || null,
        license: asset.license || null,
        contentHash: sha256(finalFile),
        version: Number(asset.version || 1) + 1,
        metadata: updatedMetadata,
      }),
    })
    processed.push({ assetKey: asset.assetKey, version: updated.version, localPath: updated.localPath, alphaCoverage: metadata.alphaCoverage })
  }

  const latest = await request(`/remotion/projects/${projectId}`)
  const stage = await writeStage(projectId, latest, failures)
  console.log(JSON.stringify({ projectId, processed, failures, assetProduction: { status: stage.stage.status, output: stage.output } }, null, 2))
  if (failures.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(`[remotion-cutout] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
