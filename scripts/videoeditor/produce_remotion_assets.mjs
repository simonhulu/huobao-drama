#!/usr/bin/env node

/**
 * Enqueue the producer-owned AI assets for a Remotion project.
 *
 * This script only creates image tasks and records their state. It never
 * edits legacy storyboard media. Character tasks intentionally produce an
 * opaque source first; cutout_remotion_characters.mjs publishes the RGBA
 * version after BiRefNet quality checks.
 */

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const command = args[0] || 'enqueue'

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

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function parseAssetTypes() {
  return new Set(String(value('--asset-types', 'ai_image,character'))
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item === 'ai_image' || item === 'character'))
}

function promptText(asset) {
  const prompt = asset?.prompt
  if (typeof prompt === 'string') return prompt
  if (prompt && typeof prompt === 'object' && typeof prompt.text === 'string') return prompt.text
  return ''
}

function reuseKeyFor(asset) {
  const metadata = asRecord(asset?.metadata)
  const reuseKey = typeof metadata.reuseKey === 'string' ? metadata.reuseKey.trim() : ''
  return reuseKey || String(asset?.assetKey || '')
}

function latestAssets(snapshot) {
  const assets = (snapshot.shots || []).flatMap((shot) => shot.assets || [])
  const latest = new Map()
  for (const asset of assets) {
    const current = latest.get(asset.assetKey)
    if (!current || Number(asset.version || 1) > Number(current.version || 1)) latest.set(asset.assetKey, asset)
  }
  return [...latest.values()].sort((left, right) => String(left.assetKey).localeCompare(String(right.assetKey)))
}

function productionState(snapshot) {
  const assets = latestAssets(snapshot).filter((asset) => ['ai_image', 'character'].includes(asset.assetType))
  const statuses = assets.map((asset) => ({
    assetKey: asset.assetKey,
    assetType: asset.assetType,
    status: asset.status,
    version: asset.version || 1,
    taskId: asset.taskId || null,
    alphaReady: asset.assetType === 'character' ? asRecord(asset.metadata).alphaReady === true : undefined,
  }))
  const failed = assets.some((asset) => ['failed', 'canceled'].includes(asset.status))
  const complete = assets.length > 0 && assets.every((asset) => asset.status === 'completed'
    && (asset.assetType !== 'character' || asRecord(asset.metadata).alphaReady === true))
  return {
    status: complete ? 'succeeded' : failed ? 'failed' : 'running',
    output: {
      schemaVersion: 1,
      factoryStage: 'asset_production',
      attempt: 1,
      artifacts: [],
      checks: [{ name: 'asset_tasks_recorded', passed: true }],
      risks: failed ? ['至少一个动态素材任务失败，需要重新提交该资产版本'] : [],
      assets: statuses,
    },
  }
}

async function writeStage(projectId, snapshot, statusOverride = null) {
  const state = productionState(snapshot)
  return request(`/remotion/projects/${projectId}/stages/asset_production`, {
    method: 'POST',
    body: JSON.stringify({
      status: statusOverride || state.status,
      input: { producer: 'produce_remotion_assets', assetTypes: [...parseAssetTypes()] },
      output: state.output,
    }),
  })
}

function selectedAssets(snapshot) {
  const types = parseAssetTypes()
  const retry = hasFlag('--retry')
  const assets = latestAssets(snapshot)
    .filter((asset) => types.has(asset.assetType))
    .filter((asset) => {
      if (asset.status === 'planned') return true
      if (retry && ['failed', 'canceled'].includes(asset.status)) return true
      // A completed opaque character is waiting for the local alpha stage.
      return asset.assetType === 'character' && asset.status === 'completed'
        && asRecord(asset.metadata).alphaReady !== true
        && hasFlag('--requeue-opaque')
    })
  // Generate one representative per setup-level reuseKey. The planner keeps
  // shot-level assetKey values for database uniqueness; reuseKey is the cost
  // and file-deduplication boundary.
  const representatives = []
  const seenReuseKeys = new Set()
  for (const asset of assets) {
    const reuseKey = reuseKeyFor(asset)
    if (seenReuseKeys.has(reuseKey)) continue
    seenReuseKeys.add(reuseKey)
    representatives.push(asset)
  }
  const limit = Number(value('--limit', '0'))
  return Number.isFinite(limit) && limit > 0 ? representatives.slice(0, limit) : representatives
}

function latestAssetsByReuseKey(snapshot) {
  const groups = new Map()
  for (const asset of latestAssets(snapshot).filter((item) => ['ai_image', 'character'].includes(item.assetType))) {
    const key = reuseKeyFor(asset)
    const group = groups.get(key) || []
    group.push(asset)
    groups.set(key, group)
  }
  return groups
}

async function propagateReuse(projectId, snapshot) {
  const propagated = []
  for (const [reuseKey, group] of latestAssetsByReuseKey(snapshot)) {
    const source = group.find((asset) => asset.status === 'completed' && asset.localPath)
    if (!source) continue
    for (const asset of group) {
      if (asset.assetKey === source.assetKey || (asset.status === 'completed' && asset.localPath)) continue
      if (!['planned', 'failed', 'canceled'].includes(asset.status)) continue
      const metadata = {
        ...asRecord(asset.metadata),
        reuseKey,
        reused: true,
        reuseSourceAssetKey: source.assetKey,
        producer: 'remotion-asset-production',
      }
      await request(`/remotion/projects/${projectId}/assets`, {
        method: 'POST',
        body: JSON.stringify({
          shotId: asset.shotId,
          assetKey: asset.assetKey,
          assetType: asset.assetType,
          provider: source.provider || 'local-reuse',
          status: 'completed',
          localPath: source.localPath,
          mimeType: source.mimeType,
          width: source.width,
          height: source.height,
          durationMs: source.durationMs,
          sourceUrl: source.sourceUrl,
          license: source.license,
          contentHash: source.contentHash,
          metadata,
        }),
      })
      propagated.push({ assetKey: asset.assetKey, reuseKey, sourceAssetKey: source.assetKey })
    }
  }
  return propagated
}

async function enqueue(projectId, snapshot) {
  const selected = selectedAssets(snapshot)
  if (hasFlag('--dry-run')) {
    const all = latestAssets(snapshot).filter((asset) => ['ai_image', 'character'].includes(asset.assetType))
    const groups = latestAssetsByReuseKey(snapshot)
    console.log(JSON.stringify({
      dryRun: true,
      projectId,
      plannedImageRows: all.filter((asset) => asset.status === 'planned').length,
      reuseGroups: groups.size,
      selectedRepresentatives: selected.map((asset) => ({
        assetKey: asset.assetKey,
        assetType: asset.assetType,
        shotId: asset.shotId,
        status: asset.status,
        reuseKey: reuseKeyFor(asset),
        groupSize: groups.get(reuseKeyFor(asset))?.length || 1,
      })),
    }, null, 2))
    return
  }

  await writeStage(projectId, snapshot, 'running')
  const submitted = []
  for (const asset of selected) {
    const prompt = promptText(asset)
    if (!prompt.trim()) {
      submitted.push({ assetKey: asset.assetKey, status: 'skipped', reason: 'missing prompt' })
      continue
    }
    const metadata = {
      ...asRecord(asset.metadata),
      producer: 'remotion-asset-production',
      sourceAssetVersion: asset.version || 1,
      ...(asset.assetType === 'character' ? { requiresAlpha: true, alphaReady: false } : {}),
    }
    const result = await request(`/remotion/projects/${projectId}/assets/image`, {
      method: 'POST',
      body: JSON.stringify({
        shot_id: asset.shotId,
        asset_key: asset.assetKey,
        asset_type: asset.assetType,
        prompt,
        provider: asset.provider || undefined,
        config_id: value('--config-id') ? Number(value('--config-id')) : undefined,
        size: value('--size'),
        style: value('--style'),
        seed: value('--seed') ? Number(value('--seed')) : undefined,
        metadata,
      }),
    })
    submitted.push({ assetKey: asset.assetKey, assetType: asset.assetType, status: result.asset?.status || 'queued', taskId: result.task?.id || null })
  }

  let latest = await request(`/remotion/projects/${projectId}`)
  if (hasFlag('--wait')) {
    const timeoutMs = Number(value('--timeout-ms', '1200000'))
    const intervalMs = Number(value('--interval-ms', '3000'))
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const activeTasks = (latest.tasks || []).filter((task) => ['queued', 'running'].includes(task.status))
      if (!activeTasks.length) break
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      latest = await request(`/remotion/projects/${projectId}`)
    }
  }
  const propagated = await propagateReuse(projectId, latest)
  latest = await request(`/remotion/projects/${projectId}`)
  const stage = await writeStage(projectId, latest)
  console.log(JSON.stringify({ projectId, submitted, propagated, assetProduction: { status: stage.status, output: stage.output } }, null, 2))
}

async function main() {
  if (!['enqueue', 'status'].includes(command)) throw new Error('Usage: produce_remotion_assets.mjs <enqueue|status> --project-id <id> [options]')
  const projectId = Number(required('--project-id'))
  if (!Number.isInteger(projectId) || projectId < 1) throw new Error('project id must be a positive integer')
  const snapshot = await request(`/remotion/projects/${projectId}`)
  if (command === 'status') {
    const stage = hasFlag('--dry-run') ? productionState(snapshot) : await writeStage(projectId, snapshot)
    console.log(JSON.stringify({ projectId, assetProduction: stage }, null, 2))
    return
  }
  await enqueue(projectId, snapshot)
}

main().catch((error) => {
  console.error(`[remotion-assets] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
