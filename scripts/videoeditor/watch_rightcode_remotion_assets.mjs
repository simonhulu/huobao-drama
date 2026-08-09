#!/usr/bin/env node

/**
 * Probe RightCode with the first planned Remotion image, then submit the
 * remaining project images once the probe has produced a local asset.
 *
 * This command is intentionally a single run. macOS launchd invokes it every
 * 30 minutes, so a crashed or stopped process cannot leave a hidden scheduler
 * behind in a terminal session.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
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

const projectId = Number(required('--project-id'))
const apiBase = (value('--api', process.env.REMOTION_API_BASE || 'http://localhost:5679/api/v1')).replace(/\/$/, '')
const stateFile = path.resolve(root, value('--state-file', `.tmp/rightcode-remotion-watcher-project-${projectId}.json`))
const producer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'produce_remotion_assets.mjs')
const once = args.includes('--once')

async function request(pathname) {
  const response = await fetch(`${apiBase}${pathname}`, { headers: { accept: 'application/json' } })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : null } catch { throw new Error(`${pathname} returned invalid JSON`) }
  if (!response.ok || body?.code >= 400) throw new Error(`${pathname} failed: ${body?.message || raw}`)
  return body?.data ?? body
}

function latestAssets(snapshot) {
  const latest = new Map()
  for (const shot of snapshot?.shots || []) {
    for (const asset of shot.assets || []) {
      if (asset.assetType !== 'ai_image') continue
      const current = latest.get(asset.assetKey)
      if (!current || Number(asset.version || 1) > Number(current.version || 1)) latest.set(asset.assetKey, asset)
    }
  }
  return [...latest.values()]
}

function log(message, details) {
  const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`
  console.log(`[rightcode-watch ${new Date().toISOString()}] ${message}${suffix}`)
}

async function readState() {
  try { return JSON.parse(await fs.readFile(stateFile, 'utf8')) } catch { return { phase: 'waiting_probe' } }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true })
  await fs.writeFile(stateFile, `${JSON.stringify({ ...state, checkedAt: new Date().toISOString() }, null, 2)}\n`)
}

function runProducer(extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [producer, ...extraArgs], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`${stderr.trim() || stdout.trim() || `producer exited with ${code}`}`))
    })
  })
}

async function checkOnce() {
  const state = await readState()
  const snapshot = await request(`/remotion/projects/${projectId}`)
  const assets = latestAssets(snapshot)
  const first = assets.find((asset) => asset.assetKey === state.probeAssetKey)
    || assets.find((asset) => asset.assetKey === 'shot-1-ai-plate')
    || assets.sort((a, b) => String(a.assetKey).localeCompare(String(b.assetKey)))[0]

  if (state.phase === 'submitted') {
    log('full production already submitted; no duplicate enqueue', {
      completed: assets.filter((asset) => asset.status === 'completed').length,
      pending: assets.filter((asset) => ['planned', 'queued', 'running'].includes(asset.status)).length,
      failed: assets.filter((asset) => ['failed', 'canceled'].includes(asset.status)).length,
    })
    return
  }

  if (!first) throw new Error(`Project ${projectId} has no ai_image assets`)

  if (first.status === 'completed' && first.localPath) {
    log('RightCode probe is already complete; submitting full ai_image production')
    const full = await runProducer([
      'enqueue', '--project-id', String(projectId), '--asset-types', 'ai_image',
      '--provider', 'rightcode',
    ])
    await writeState({ phase: 'submitted', probeAssetKey: first.assetKey, submitOutput: full.stdout })
    log('full production submitted; watcher is now idempotently complete')
    return
  }

  if (['queued', 'processing', 'running'].includes(first.status)) {
    await writeState({ phase: 'probing', probeAssetKey: first.assetKey, probeTaskId: first.taskId || null })
    log('RightCode probe is still processing; no duplicate request submitted', { assetKey: first.assetKey, taskId: first.taskId })
    return
  }

  log('probing RightCode with first image', { assetKey: first.assetKey, status: first.status })
  try {
    const probe = await runProducer([
      'enqueue', '--project-id', String(projectId), '--asset-types', 'ai_image',
      '--limit', '1', '--retry', '--provider', 'rightcode',
    ])
    const result = JSON.parse(probe.stdout)
    const submitted = result.submitted?.find((item) => item.assetKey === first.assetKey) || result.submitted?.[0]
    await writeState({ phase: 'probing', probeAssetKey: first.assetKey, probeTaskId: submitted?.taskId || null, probeOutput: probe.stdout })
    log('RightCode probe submitted; next scheduled run will inspect its result', { taskId: submitted?.taskId || null })
  } catch (error) {
    await writeState({ phase: 'waiting_probe', lastError: error instanceof Error ? error.message : String(error) })
    log('RightCode is not ready; will retry on the next scheduled run', { error: error instanceof Error ? error.message : String(error) })
    if (once) process.exitCode = 1
  }
}

checkOnce().catch(async (error) => {
  await writeState({ phase: 'waiting_probe', lastError: error instanceof Error ? error.message : String(error) })
  log('watcher check failed; will retry on the next scheduled run', { error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
