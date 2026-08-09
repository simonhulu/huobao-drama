#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import {
  assessDeliveryQuality,
  parseProgressFrameCount,
  validateEnvironment,
  validateEpisodeOwnership,
  validateManifest,
  validateNativeResult,
  validatePanelAssets,
  validateTtsClone,
  validateTtsTimeline,
  validateVisualApproval,
} from './dharma_comic_validator.mjs'
import {
  compositeTextOverlay,
  overlayFingerprint,
  readOverlayCompositeEvidence,
  renderTextOverlaySequence,
} from './dharma_text_overlay_stage.mjs'
import { DHARMA_VIDEO_ENCODER } from '../../../../scripts/videoeditor/dharma_ffmpeg_config.mjs'
import {
  acquireDharmaRenderLock,
  releaseDharmaRenderLock,
} from '../../../../scripts/videoeditor/dharma_render_lock.mjs'
import { addFailureLesson } from './dharma_comic_lessons.mjs'
import {
  NATIVE_AUDIO_MIX_VERSION,
  computeSubtitleDisplayWindows,
  extractSubtitleKeywords,
} from '../../../../scripts/videoeditor/dharma_comic_native_core.mjs'
import {
  normalizePublishingPackage,
  publishingPackageFingerprint,
  readPublishingPackage,
} from './dharma_publishing_package.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../../..')
const requireFromBackend = createRequire(join(repoRoot, 'backend/package.json'))
const Database = requireFromBackend('better-sqlite3')

const apiBase = process.env.HUOBAO_API_URL || 'http://127.0.0.1:5679/api/v1'
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled', 'stale'])
const currentRunVersion = 4
const currentPlanVersion = 'comic-production-plan-v7'
const defaultRunLeaseMs = 60_000
const defaultMachineLoopMs = Number.POSITIVE_INFINITY
const defaultPollIntervalMs = 5_000
const defaultTtsMachineRetryLimit = 1
const defaultTtsRepairLimit = 2
const defaultVerificationTransientRetryLimit = 3
const defaultVerificationRepairLimit = 2
const defaultActionRepairLimit = 2
const defaultCoverPollIntervalMs = 5_000
const defaultCoverWaitTimeoutMs = 30 * 60_000
// gpt-image-2 的可靠性低于 gpt-image-2-1k，但单价只有一半；
// 用有界的面板级重试预算（1 次首次提交 + 3 次机器重试）换取可靠性。
const defaultImageAttemptLimit = 4
export const DEFAULT_DHARMA_NARRATION_SPEED = 0.85
const MIN_DHARMA_NARRATION_SPEED = 0.8
const MAX_DHARMA_NARRATION_SPEED = 2.5
const stylePrompts = {
  'retro-anime-1980s': [
    'Visual style library preset retro-anime-1980s: classic 1980s Japanese theatrical and OVA anime cel illustration.',
    'Use crisp bold black linework, hard-edged two-tone cel shading, clean saturated color fields, adult-proportioned expressive faces, intricate hand-painted East Asian environments, cinematic staging, and strong readable silhouettes.',
    'Clarity requirement: razor-sharp facial features and linework at 1K; every foreground and midground subject must be clearly readable.',
    'No haze, bloom, soft focus, depth-of-field blur, motion blur, film grain, faded wash, muddy shadows, photorealism, 3D render, glossy digital gradients, malformed hands, duplicate faces, or extra characters.',
    'The generated image itself must contain no text, letters, subtitles, speech balloons, manga sound effects, logo, watermark, or panel border.',
  ].join(' '),
}
const textPresentationVersion = 'dharma-text-v5'
const subtitlePreset = 'ink-read-v2'
const emphasisPresentation = Object.freeze({
  theme: Object.freeze({ animationPreset: 'handwrite-pose-v1', sfxPreset: 'low-temple-bell-v1' }),
  scripture: Object.freeze({ animationPreset: 'scripture-lines-v1', sfxPreset: 'clear-chime-v1' }),
  explanation: Object.freeze({ animationPreset: 'center-lift-v1' }),
})

function fail(message) {
  throw new Error(message)
}

function parseArgs(argv) {
  const command = argv[0]
  const options = { keys: [] }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`)
    const name = token.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`Missing value for --${name}`)
    index += 1
    if (name === 'key') options.keys.push(value)
    else options[name.replaceAll('-', '_')] = value
  }
  return { command, options }
}

export function parseDharmaNarrationSpeed(value, fallback = DEFAULT_DHARMA_NARRATION_SPEED) {
  const raw = value === undefined || value === null || value === '' ? fallback : value
  const speed = Number(raw)
  if (!Number.isFinite(speed) || speed < MIN_DHARMA_NARRATION_SPEED || speed > MAX_DHARMA_NARRATION_SPEED) {
    fail(`narration speed must be between ${MIN_DHARMA_NARRATION_SPEED} and ${MAX_DHARMA_NARRATION_SPEED}`)
  }
  return Math.round(speed * 100) / 100
}

export const DEFAULT_DHARMA_NARRATION_VOICE_ID = 'voice-clone-aug7-1786117023178'

function parseDharmaVoiceId(value, fallback = DEFAULT_DHARMA_NARRATION_VOICE_ID) {
  const voiceId = String(value === undefined || value === null || value === '' ? fallback : value).trim()
  if (!voiceId) fail('narration voice id must not be empty')
  return voiceId
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function publishingPackageCandidates(scriptPath) {
  const noteDir = dirname(scriptPath)
  return [
    join(noteDir, '07-publishing-package.json'),
    join(noteDir, 'publishing-package.json'),
  ]
}

function resolvePublishingPackagePath(scriptPath, requestedPath, required = true) {
  if (requestedPath) {
    const candidate = resolve(repoRoot, requestedPath)
    if (!existsSync(candidate)) fail(`Publishing package does not exist: ${candidate}`)
    return candidate
  }
  const candidate = publishingPackageCandidates(scriptPath).find((path) => existsSync(path))
  if (candidate) return candidate
  if (required) {
    fail(`Publishing package is required; create ${publishingPackageCandidates(scriptPath)[0]} or pass --publishing-package <path>`)
  }
  return null
}

function loadRunPublishingPackage(run, requestedPath, required = true) {
  const packagePath = resolvePublishingPackagePath(
    run.scriptPath,
    requestedPath || run.publishingPackagePath,
    required,
  )
  if (!packagePath) return null
  return readPublishingPackage(packagePath, { expectedTitle: run.title })
}

/**
 * Final-script input contract: front matter is document metadata, never
 * narration. Keep the parser intentionally small and flat because the factory
 * only accepts scalar YAML metadata and a Markdown body.
 */
export function parseDharmaScriptDocument(text) {
  const source = String(text ?? '').replace(/^\uFEFF/u, '')
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u)
  if (!match) return { body: source, metadata: {}, hasFrontMatter: false }

  const metadata = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/u)
    if (!entry) continue
    const value = entry[2]
    metadata[entry[1]] = value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value
  }
  if (!Object.keys(metadata).length) return { body: source, metadata: {}, hasFrontMatter: false }
  return {
    body: source.slice(match[0].length).replace(/^\r?\n/u, ''),
    metadata,
    hasFrontMatter: true,
  }
}

function hash(value, algorithm = 'sha256') {
  return createHash(algorithm).update(value).digest('hex')
}

function hashFile(path) {
  return hash(readFileSync(path))
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function acquireRunLease(runPath, options = {}) {
  const lockPath = `${resolve(runPath)}.lock`
  const owner = String(options.owner || `${hostname()}:${process.pid}:${randomUUID()}`)
  const leaseMs = Number(options.leaseMs || defaultRunLeaseMs)
  if (!Number.isFinite(leaseMs) || leaseMs < 1_000) fail('Run lease must be at least 1000ms')
  const now = Number(options.now || Date.now())
  const record = {
    owner,
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
  }
  mkdirSync(dirname(lockPath), { recursive: true })
  try {
    const descriptor = openSync(lockPath, 'wx')
    try {
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`)
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    let existing = null
    try { existing = readJson(lockPath) } catch {}
    const expiresAt = new Date(existing?.expiresAt || 0).getTime()
    const sameHostLiveProcess = existing?.hostname === hostname() && processIsAlive(Number(existing?.pid))
    if (sameHostLiveProcess || !Number.isFinite(expiresAt) || expiresAt > now) {
      fail(`RUN_LEASE_ACTIVE: ${lockPath} is owned by ${existing?.owner || 'unknown'}`)
    }
    unlinkSync(lockPath)
    return acquireRunLease(runPath, options)
  }
  return { lockPath, owner, record }
}

export function releaseRunLease(lease) {
  if (!lease?.lockPath || !existsSync(lease.lockPath)) return
  let existing = null
  try { existing = readJson(lease.lockPath) } catch {}
  if (existing?.owner && existing.owner !== lease.owner) {
    fail(`RUN_LEASE_OWNERSHIP_MISMATCH: ${lease.lockPath}`)
  }
  unlinkSync(lease.lockPath)
}

export function heartbeatRunLease(lease, leaseMs = defaultRunLeaseMs) {
  if (!lease?.lockPath || !existsSync(lease.lockPath)) fail('RUN_LEASE_LOST')
  const existing = readJson(lease.lockPath)
  if (existing.owner !== lease.owner) fail(`RUN_LEASE_OWNERSHIP_MISMATCH: ${lease.lockPath}`)
  const heartbeatAt = Date.now()
  const record = {
    ...existing,
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    expiresAt: new Date(heartbeatAt + leaseMs).toISOString(),
  }
  atomicWriteJson(lease.lockPath, record)
  lease.record = record
  return lease
}

export function approvalMatchesArtifact(approval, artifactPath) {
  return Boolean(
    approval?.artifactSha256
    && artifactPath
    && existsSync(artifactPath)
    && approval.artifactSha256 === hashFile(artifactPath),
  )
}

function visualApprovalMatchesArtifact(approval, artifactPath, expectedArtifactSha256, expectedReviewedCount) {
  return validateVisualApproval({
    approval,
    artifactPath,
    expectedArtifactSha256,
    expectedReviewedCount,
  }).passed
}

export function reviewEscalationMatchesArtifact(escalation, artifactPath, expectedArtifactSha256) {
  return Boolean(
    escalation?.artifactSha256
    && escalation.actor === 'agent'
    && ['view_image', 'native_image_read'].includes(escalation.reviewTool)
    && String(escalation.reason || '').trim().length >= 12
    && artifactPath
    && existsSync(artifactPath)
    && escalation.artifactSha256 === expectedArtifactSha256
    && escalation.artifactSha256 === hashFile(artifactPath),
  )
}

export function validateFrozenTtsArtifacts(tts) {
  const errors = []
  if (!tts?.taskId) errors.push('Frozen TTS task id is missing')
  for (const [kind, path, expected] of [
    ['audio', tts?.audioPath, tts?.audioSha256],
    ['titles', tts?.titlesPath, tts?.titlesSha256],
  ]) {
    if (!path || !existsSync(path)) errors.push(`Frozen TTS ${kind} artifact is missing`)
    else if (!expected || hashFile(path) !== expected) errors.push(`Frozen TTS ${kind} SHA-256 changed`)
  }
  return { passed: errors.length === 0, errors }
}

function loadManifest(manifestArg) {
  if (!manifestArg) fail('Pass --manifest <path>')
  const manifestPath = resolve(repoRoot, manifestArg)
  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  const validation = validateManifest(manifest, { resolveReferenceImage: resolveDataPath })
  requirePassed(validation)
  return { manifest, manifestPath, manifestHash: hash(raw) }
}

function requirePassed(report) {
  if (!report.passed) {
    const error = new Error(report.checks.errors.join('; '))
    error.errorCode = report.error_code
    error.validationReport = report
    throw error
  }
  return report.data
}

export const compiledExecutionPlan = Object.freeze([
  {
    index: 1,
    stage: 'intake',
    owner: 'runner',
    checks: ['final script exists', 'script is non-empty', 'script SHA-256 is persisted', 'title and immutable run path are persisted'],
  },
  {
    index: 2,
    stage: 'environment_check',
    owner: 'runner+validator',
    checks: ['backend and workers healthy', 'ffmpeg, ffprobe, and native renderer available', 'active pcore config includes gpt-image-2', 'fixed BGM is at least 180s', 'active MiniMax audio config and fixed narration voice exist', 'Dharma media account exists'],
  },
  {
    index: 3,
    stage: 'episode_create',
    owner: 'runner+validator',
    checks: ['one factory intake receipt is keyed by the immutable run token', 'receipt, drama, and exactly one episode are committed in one transaction', 'same token and request hash replay the original IDs', 'same token with changed immutable input is rejected', 'voice, image config, aspect ratio, and BGM match fixed inputs'],
  },
  {
    index: 4,
    stage: 'tts_wait',
    owner: 'runner',
    checks: ['exactly one tts.pre_generate task is tracked', 'active task is polled without duplication', 'one machine retry and two Agent repair attempts are enforced', 'terminal failure preserves task and retry evidence'],
  },
  {
    index: 5,
    stage: 'tts_verify',
    owner: 'validator',
    checks: ['audio and titles exist', 'titles are ordered and non-overlapping', 'title/audio coverage ratio is 0.60-1.05', 'voice instruct hash is unchanged', 'clone reference and clone-mode evidence pass'],
  },
  {
    index: 6,
    stage: 'manifest_plan',
    owner: 'runner+creator',
    checks: ['TTS titles are partitioned into a multiple of five beats', 'fixed manifest fields are emitted', 'one global theme plus typed scripture and explanation events are planned', 'all creative fields are completed before generation'],
  },
  {
    index: 7,
    stage: 'manifest_validate',
    owner: 'validator',
    checks: ['fixed profile and run IDs match', 'five-panel pages are complete', 'panel TTS title ranges are contiguous and exactly match frozen beats', 'semantic fields and prompts are complete', 'text emphasis kinds and source rules pass', 'references point backward', 'manifest SHA-256 is frozen'],
  },
  {
    index: 8,
    stage: 'image_submit',
    owner: 'runner',
    checks: ['only dependency-ready wave is submitted', 'submission intent precedes every POST', 'deterministic frame type recovers prior task', 'all task and generation IDs are persisted'],
  },
  {
    index: 9,
    stage: 'image_wait',
    owner: 'runner',
    checks: ['active tasks are polled', 'local paths are persisted', 'failed panels retry within the fixed image attempt budget'],
  },
  {
    index: 10,
    stage: 'asset_review',
    owner: 'validator+agent',
    gate: 'asset_contact_sheet',
    checks: ['all files exist', 'content hashes are unique', 'contact sheet matches asset fingerprint', 'Agent reviews every cell with an image-capable tool', 'user escalation only when undecidable'],
  },
  {
    index: 11,
    stage: 'props_build',
    owner: 'runner',
    checks: ['approved asset fingerprint is current', 'TTS titles drive all frames', 'every subtitle names its TTS title index', 'every emphasis event is located only inside its panel TTS range', 'animation and SFX presets are deterministic', 'narration and BGM loudness are measured', 'props fingerprint is persisted'],
  },
  {
    index: 12,
    stage: 'delivery_render',
    owner: 'runner+validator',
    checks: ['native renderer and text overlay render the final delivery from frozen props', 'renderer result binds full props and final output SHA-256', 'final output path is exactly manifest.deliveryOutput', 'no candidate video is created'],
  },
  {
    index: 13,
    stage: 'delivery_verify',
    owner: 'runner+validator',
    checks: ['H.264 and AAC', '1280x720 at 30fps', 'decoded frame count matches plan', 'audio/video durations match', 'subtitles and quotes independently match frozen TTS timing', 'loudness and sustained-black checks pass', 'transient tool failures retry unchanged delivery bytes within fixed machine and Agent budgets', 'delivery SHA-256 is persisted'],
  },
  {
    index: 14,
    stage: 'episode_publish',
    owner: 'runner+validator',
    checks: ['verified delivery path is converted to the frontend media URL', 'episode video_url and Dharma delivery metadata commit atomically', 'replay is idempotent and a foreign pointer is rejected', 'the footage API echoes the same video_url'],
  },
  {
    index: 15,
    stage: 'complete',
    owner: 'runner',
    checks: ['verification report passed', 'delivery hash matches report', 'next_action is null', 'stage accounting is frozen'],
  },
])

const productionProfile = Object.freeze({
  id: 'comic-progressive-five-v1',
  stylePreset: 'retro-anime-1980s',
  imageModel: 'gpt-image-2',
  renderer: 'native-comic-v12',
  width: 1280,
  height: 720,
  fps: 30,
})
const fixedBgmPath = 'static/music/freepacks/dharma-ambient/angelic-pad-loop-cc0-210s.mp3'
const fixedMediaAccountName = '静室听法'

const machineActions = new Set([
  'check-environment',
  'create-episode',
  'create-tts-task',
  'wait-tts',
  'retry-tts-task',
  'verify-tts',
  'prepare-manifest',
  'attach-manifest',
  'init',
  'submit',
  'wait',
  'retry-failed',
  'contact-sheet',
  'build-props',
  'render-delivery',
  'recover-delivery',
  'publish-episode',
  'verify',
])
const runLifecycleActions = new Set([
  'check-environment',
  'create-episode',
  'create-tts-task',
  'wait-tts',
  'retry-tts-task',
  'verify-tts',
  'prepare-manifest',
  'attach-manifest',
])
const agentActions = new Set([
  'complete-manifest',
  'review-assets',
  'repair-manifest',
  'repair-delivery',
  'retry-action',
  'retry-stage',
  'start-new-run',
])
const humanActions = new Set(['decide-assets'])

export function classifyNextAction(nextAction) {
  if (nextAction === null || nextAction === undefined || String(nextAction).trim() === '') return 'terminal'
  const action = String(nextAction).trim().split(/\s+/u)[0]
  if (machineActions.has(action)) return 'machine'
  if (agentActions.has(action)) return 'agent'
  if (humanActions.has(action)) return 'human'
  fail(`Unclassified next action: ${nextAction}`)
}

export function runnerExitContract(status) {
  const handoffAllowed = status?.user_handoff_allowed === true
  return handoffAllowed
    ? { exitCode: 0, marker: null }
    : {
        exitCode: 75,
        marker: 'AGENT_CONTINUATION_REQUIRED: execute next_action and resume the same run; do not return to the user',
      }
}

function emitWorkflowStatus(status) {
  console.log(JSON.stringify(status, null, 2))
  const exit = runnerExitContract(status)
  if (exit.marker) console.error(exit.marker)
  process.exitCode = exit.exitCode
}

export function executionSurface(nextAction) {
  const action = String(nextAction || '').trim().split(/\s+/u)[0]
  if (runLifecycleActions.has(action)) return 'run-lifecycle'
  if (machineActions.has(action)) return 'artifact-pipeline'
  fail(`Action is not machine-executable: ${nextAction}`)
}

function validateCurrentRunState(input) {
  if (!input || input.workflow !== productionProfile.id) fail('Unsupported run workflow')
  const expectedPlanHash = hash(JSON.stringify(compiledExecutionPlan))
  if (Number(input.version) === currentRunVersion
    && input.planVersion === currentPlanVersion
    && input.planHash === expectedPlanHash) {
    return input
  }
  fail(`Unsupported run state version/plan: ${input.version}/${input.planVersion || 'missing'}; start a new run`)
}

export async function driveUntilBoundary({
  getStatus,
  executeMachineAction,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  pollIntervalMs = defaultPollIntervalMs,
  maxRuntimeMs = defaultMachineLoopMs,
  maxSteps = Number.POSITIVE_INFINITY,
  onStatus = () => {},
  now = () => Date.now(),
}) {
  const runtimeLimit = Number(maxRuntimeMs)
  const stepLimit = Number(maxSteps)
  if (!(runtimeLimit === Number.POSITIVE_INFINITY || (Number.isFinite(runtimeLimit) && runtimeLimit >= 0))) {
    fail('maxRuntimeMs must be a non-negative number or Infinity')
  }
  if (!(stepLimit === Number.POSITIVE_INFINITY || (Number.isInteger(stepLimit) && stepLimit >= 1))) {
    fail('maxSteps must be a positive integer or Infinity')
  }
  const deadline = runtimeLimit === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : now() + runtimeLimit
  for (let step = 0; step < stepLimit; step += 1) {
    const status = await getStatus()
    onStatus(status)
    const actionKind = status.action_kind || classifyNextAction(status.next_action)
    if (status.status === 'complete' || status.status === 'failed' || actionKind !== 'machine') return status
    if (now() >= deadline) {
      return {
        ...status,
        status: 'paused',
        error_code: 'RUN_DEADLINE_REACHED',
        checks: {
          ...status.checks,
          runtime_limit_ms: runtimeLimit,
          resume_with_same_run: true,
        },
        continuation_required: true,
        user_handoff_allowed: false,
      }
    }
    await executeMachineAction(status)
    if (status.status === 'running' && pollIntervalMs > 0) await sleep(pollIntervalMs)
  }
  const status = await getStatus()
  return {
    ...status,
    status: 'paused',
    error_code: 'RUN_STEP_LIMIT_REACHED',
    checks: {
      ...status.checks,
      step_limit: stepLimit,
      resume_with_same_run: true,
    },
    continuation_required: true,
    user_handoff_allowed: false,
  }
}

function slug(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
  return normalized || 'dharma-comic'
}

function defaultTitle(scriptPath, scriptText) {
  const heading = String(scriptText).match(/^\s*#\s+(.+)$/mu)?.[1]?.trim()
  return heading || scriptPath.split('/').at(-1).replace(/\.[^.]+$/u, '')
}

function defaultRunPath(scriptPath) {
  const articleId = slug(scriptPath.split('/').at(-1).replace(/\.[^.]+$/u, ''))
  return join(repoRoot, 'scripts/dharma-notes', articleId, 'comic-production.run.json')
}

function saveRun(runPath, state) {
  atomicWriteJson(runPath, state)
}

function createRunFile(runPath, state) {
  mkdirSync(dirname(runPath), { recursive: true })
  const descriptor = openSync(runPath, 'wx')
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`)
  } finally {
    closeSync(descriptor)
  }
}

function manifestPathsForRun(runPath) {
  const noteDir = dirname(runPath)
  const manifestPrefix = /(?:^|[\\/])comic-production\.run\.json$/u.test(runPath)
    ? join(noteDir, 'comic-manifest')
    : runPath.replace(/\.json$/u, '.comic-manifest')
  return {
    draftPath: `${manifestPrefix}.plan.json`,
    outputPath: `${manifestPrefix}.json`,
  }
}

function loadRun(runArg) {
  if (!runArg) fail('Pass --run <path>')
  const runPath = resolve(repoRoot, runArg)
  if (!existsSync(runPath)) fail(`Run state does not exist: ${runPath}`)
  return { runPath, state: validateCurrentRunState(readJson(runPath)) }
}

export function createInitialRun({
  scriptPath,
  scriptHash,
  narrationHash,
  title,
  runPath,
  narrationSpeed = DEFAULT_DHARMA_NARRATION_SPEED,
  voiceId = DEFAULT_DHARMA_NARRATION_VOICE_ID,
  publishingPackage,
}) {
  const startedAt = new Date().toISOString()
  const runId = hash(`${productionProfile.id}\n${scriptHash}\n${title}\n${runPath}\n${startedAt}`).slice(0, 20)
  const manifestPaths = manifestPathsForRun(runPath)
  return {
    version: currentRunVersion,
    workflow: productionProfile.id,
    runId,
    profile: productionProfile,
    planVersion: currentPlanVersion,
    planHash: hash(JSON.stringify(compiledExecutionPlan)),
    executionPlan: compiledExecutionPlan,
    scriptPath,
    scriptHash,
    ...(narrationHash ? { narrationHash } : {}),
    title,
    ...(publishingPackage ? {
      publishingPackagePath: publishingPackage.path,
      publishingPackageSha256: publishingPackage.sha256,
      publishingPackage: publishingPackage.package,
    } : {}),
    voiceId: parseDharmaVoiceId(voiceId),
    narrationSpeed: parseDharmaNarrationSpeed(narrationSpeed),
    bgmPath: fixedBgmPath,
    mediaAccountName: fixedMediaAccountName,
    creationToken: `dharma-comic-run:${runId}`,
    manifestDraftPath: manifestPaths.draftPath,
    manifestOutputPath: manifestPaths.outputPath,
    deliveryOutput: join('data/static/remotion', `dharma-comic-${runId}.mp4`),
    startedAt,
    stages: {
      intake: {
        startedAt,
        completedAt: startedAt,
        elapsedMs: 0,
        scriptHash,
      },
    },
  }
}

function startRun(options, requirePublishingPackage = false) {
  if (!options.script) fail('start requires --script <final-script.md>')
  const scriptPath = resolve(repoRoot, options.script)
  if (!existsSync(scriptPath)) fail(`Script does not exist: ${scriptPath}`)
  const scriptText = readFileSync(scriptPath, 'utf8')
  if (!scriptText.trim()) fail('Script is empty')
  const scriptDocument = parseDharmaScriptDocument(scriptText)
  if (!scriptDocument.body.trim()) fail('Script narration body is empty after removing front matter')
  const scriptHash = hash(scriptText)
  const narrationHash = hash(scriptDocument.body)
  const narrationSpeed = parseDharmaNarrationSpeed(options.narration_speed)
  const voiceId = parseDharmaVoiceId(options.voice_id)
  const title = String(options.title || scriptDocument.metadata.title || defaultTitle(scriptPath, scriptDocument.body)).trim()
  if (!title) fail('Video title is empty')
  const runPath = resolve(repoRoot, options.run || defaultRunPath(scriptPath))
  if (existsSync(runPath)) {
    const existing = validateCurrentRunState(readJson(runPath))
    if (existing.workflow !== productionProfile.id
      || existing.scriptHash !== scriptHash
      || resolve(existing.scriptPath) !== scriptPath
      || existing.title !== title
      || parseDharmaNarrationSpeed(existing.narrationSpeed) !== narrationSpeed
      || parseDharmaVoiceId(existing.voiceId) !== voiceId) {
      fail(`Run path already belongs to different input: ${runPath}`)
    }
    const publishingPackage = loadRunPublishingPackage(
      { ...existing, scriptPath, title },
      options.publishing_package,
      requirePublishingPackage,
    )
    if (publishingPackage && existing.publishingPackageSha256
      && existing.publishingPackageSha256 !== publishingPackage.sha256) {
      fail(`Run path already belongs to a different publishing package: ${runPath}`)
    }
    if (publishingPackage && existing.publishingPackageSha256 !== publishingPackage.sha256) {
      existing.publishingPackagePath = publishingPackage.path
      existing.publishingPackageSha256 = publishingPackage.sha256
      existing.publishingPackage = publishingPackage.package
      saveRun(runPath, existing)
    }
    return { runPath, state: existing }
  }
  const publishingPackage = loadRunPublishingPackage(
    { scriptPath, title },
    options.publishing_package,
    requirePublishingPackage,
  )
  const state = createInitialRun({
    scriptPath,
    scriptHash,
    narrationHash,
    title,
    runPath,
    narrationSpeed,
    voiceId,
    publishingPackage,
  })
  state.scriptMetadata = scriptDocument.metadata
  if (options.media_account_id) state.requestedMediaAccountId = Number(options.media_account_id)
  try {
    createRunFile(runPath, state)
  } catch (error) {
    if (error?.code === 'EEXIST') return startRun(options)
    throw error
  }
  return { runPath, state }
}

function loadOrAttachRun(options, requirePublishingPackage = true) {
  const loaded = loadRun(options.run)
  const publishingPackage = loadRunPublishingPackage(
    loaded.state,
    options.publishing_package,
    requirePublishingPackage && !loaded.state.actionFailure,
  )
  if (!publishingPackage) return loaded
  if (loaded.state.publishingPackageSha256
    && loaded.state.publishingPackageSha256 !== publishingPackage.sha256) {
    fail(`Run path already belongs to a different publishing package: ${loaded.runPath}`)
  }
  if (loaded.state.publishingPackageSha256 !== publishingPackage.sha256) {
    loaded.state.publishingPackagePath = publishingPackage.path
    loaded.state.publishingPackageSha256 = publishingPackage.sha256
    loaded.state.publishingPackage = publishingPackage.package
    saveRun(loaded.runPath, loaded.state)
  }
  return loaded
}

function createRevisionRun(sourceRunPath, options) {
  const source = loadRun(sourceRunPath).state
  const extension = extname(sourceRunPath) || '.json'
  const stem = sourceRunPath.slice(0, -extension.length)
  let revision = 1
  let runPath
  do {
    runPath = `${stem}.revision-${String(revision).padStart(3, '0')}${extension}`
    revision += 1
  } while (existsSync(runPath))
  if (!existsSync(source.scriptPath)) fail('Cannot create a revision because the source script is missing')
  const currentScriptHash = hashFile(source.scriptPath)
  const currentScript = parseDharmaScriptDocument(readFileSync(source.scriptPath, 'utf8'))
  if (!currentScript.body.trim()) fail('Script narration body is empty after removing front matter')
  const narrationSpeed = options.narration_speed === undefined
    ? parseDharmaNarrationSpeed(source.narrationSpeed)
    : parseDharmaNarrationSpeed(options.narration_speed)
  const voiceId = parseDharmaVoiceId(options.voice_id, source.voiceId || DEFAULT_DHARMA_NARRATION_VOICE_ID)
  const publishingPackage = loadRunPublishingPackage(
    source,
    options.publishing_package,
    false,
  )
  const state = createInitialRun({
    scriptPath: source.scriptPath,
    scriptHash: currentScriptHash,
    narrationHash: hash(currentScript.body),
    title: source.title,
    runPath,
    narrationSpeed,
    voiceId,
    publishingPackage,
  })
  state.requestedMediaAccountId = source.mediaAccountId || source.requestedMediaAccountId || null
  state.revisionOf = source.runId
  state.revisionInputChanged = currentScriptHash !== source.scriptHash
  state.revisionSourceScriptHash = source.scriptHash
  state.scriptMetadata = currentScript.metadata
  state.revisionReason = requireTextOption(options, 'reason', 8)
  state.revisionActor = requireTextOption(options, 'actor')
  if (options.reuse_assets_from) {
    const reusable = loadReusableAssetSource(options.reuse_assets_from)
    state.assetReuse = {
      mode: 'tts-only',
      sourceRunPath: reusable.runPath,
      sourceRunId: reusable.state.runId,
      sourceManifestPath: reusable.state.manifestPath,
      sourceManifestHash: reusable.state.manifestHash,
      sourceAssetFingerprint: reusable.resolved.fingerprint,
      sourcePanelCount: reusable.resolved.assets.length,
      imageGenerationSkipped: true,
    }
  }
  createRunFile(runPath, state)
  return { runPath, state }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.map(String)
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function commandProbe(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    env: process.env,
  })
  const retainProbeOutput = (value) => {
    const text = String(value || '').trim()
    if (text.length <= 4000) return text
    return `${text.slice(0, 2000)}\n...[probe output truncated]...\n${text.slice(-2000)}`
  }
  return {
    status: result.status,
    signal: result.signal || null,
    error: result.error?.message || null,
    stdout: retainProbeOutput(result.stdout),
    stderr: retainProbeOutput(result.stderr),
  }
}

function currentVoiceFacts(voiceId = DEFAULT_DHARMA_NARRATION_VOICE_ID) {
  const db = database()
  try {
    const audioConfig = db.prepare(`
      select id, provider, settings
      from ai_service_configs
      where service_type = 'audio' and is_active = 1
      order by priority desc, id desc limit 1
    `).get()
    const voice = db.prepare(`
      select voice_id, provider, description
      from ai_voices where voice_id = ? limit 1
    `).get(voiceId)
    return {
      id: voiceId,
      provider: audioConfig?.provider || voice?.provider || null,
      voice_provider: voice?.provider || null,
      exists: Boolean(voice),
    }
  } finally {
    db.close()
  }
}

async function checkEnvironment(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'environment_check')
  saveRun(runPath, run)

  let apiHealthOk = false
  let workerCount = 0
  const networkErrors = []
  try {
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(5000) })
    apiHealthOk = response.ok
  } catch (error) {
    networkErrors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const workers = await request('/health/workers')
    workerCount = Number(workers.healthy_count || 0)
  } catch (error) {
    networkErrors.push(error instanceof Error ? error.message : String(error))
  }

  const ffmpeg = commandProbe('ffmpeg', ['-version'])
  const ffmpegVideoToolbox = commandProbe('ffmpeg', ['-hide_banner', '-h', 'encoder=h264_videotoolbox'])
  const ffprobeCommand = commandProbe('ffprobe', ['-version'])
  const rendererPath = join(repoRoot, 'scripts/videoeditor/dharma_comic_native_renderer.mjs')
  const db = database()
  let imageConfig
  let mediaAccount
  try {
    imageConfig = db.prepare(`
      select id, provider, model, is_active
      from ai_service_configs
      where service_type = 'image' and is_active = 1
      order by priority desc, id desc limit 1
    `).get()
    mediaAccount = run.requestedMediaAccountId
      ? db.prepare('select id, name from media_accounts where id = ? and deleted_at is null').get(run.requestedMediaAccountId)
      : db.prepare('select id, name from media_accounts where name = ? and deleted_at is null order by id limit 1').get(fixedMediaAccountName)
  } finally {
    db.close()
  }

  let bgmDurationSec = Number.NaN
  let bgmExists = false
  try {
    const bgmAbsolute = resolveDataPath(run.bgmPath)
    bgmExists = true
    bgmDurationSec = mediaDuration(bgmAbsolute)
  } catch {}

  const voice = currentVoiceFacts(run.voiceId)
  const facts = {
    api_health_ok: apiHealthOk,
    worker_count: workerCount,
    ffmpeg_ok: ffmpeg.status === 0,
    h264_videotoolbox_ok: ffmpegVideoToolbox.status === 0
      && new RegExp(`\\b${DHARMA_VIDEO_ENCODER}\\b`, 'u').test(`${ffmpegVideoToolbox.stdout}\n${ffmpegVideoToolbox.stderr}`),
    ffprobe_ok: ffprobeCommand.status === 0,
    native_renderer_ok: existsSync(rendererPath),
    media_account: mediaAccount || null,
    image_config: imageConfig ? {
      id: Number(imageConfig.id),
      provider: imageConfig.provider,
      active: Number(imageConfig.is_active) === 1,
      models: parseJsonArray(imageConfig.model),
    } : null,
    bgm: { exists: bgmExists, duration_sec: bgmDurationSec },
    voice,
  }
  const report = validateEnvironment(facts)
  report.checks.network_errors = networkErrors
  report.generatedAt = new Date().toISOString()
  run.environmentReport = report
  run.environmentFacts = facts
  if (report.passed) {
    run.imageConfigId = Number(imageConfig.id)
    run.mediaAccountId = Number(mediaAccount.id)
    run.voiceKey = voice.id
    finishStage(run, 'environment_check', { passed: true, imageConfigId: run.imageConfigId, voiceKey: run.voiceKey })
  } else {
    finishStage(run, 'environment_check', { passed: false, errors: report.checks.errors })
  }
  saveRun(runPath, run)
  return report
}

function recoverRunDrama(run) {
  const db = database()
  try {
    if (run.dramaId) {
      return db.prepare('select id, metadata from dramas where id = ? and deleted_at is null').get(run.dramaId) || null
    }
    const matches = db.prepare('select id, metadata from dramas where metadata = ? and deleted_at is null order by id').all(run.creationToken)
    if (matches.length > 1) fail(`Multiple dramas share run token ${run.creationToken}`)
    return matches[0] || null
  } finally {
    db.close()
  }
}

function recoverFactoryIntake(run) {
  const db = database()
  try {
    return db.prepare(`
      select
        receipt.request_sha256 as requestSha256,
        drama.id as dramaId,
        episode.id as episodeId
      from dharma_factory_intakes receipt
      join dramas drama on drama.id = receipt.drama_id and drama.deleted_at is null
      join episodes episode on episode.id = receipt.episode_id and episode.deleted_at is null
      where receipt.run_token = ?
    `).get(run.creationToken) || null
  } finally {
    db.close()
  }
}

function factoryIntakeRequestSha256(run) {
  return hash(JSON.stringify({
    title: run.title,
    scriptSha256: run.narrationHash || run.scriptHash,
    mediaAccountId: Number(run.mediaAccountId),
    imageConfigId: Number(run.imageConfigId),
    narrationVoiceId: run.voiceId,
    bgmAudioUrl: run.bgmPath,
    narrationSpeed: run.narrationSpeed,
    publishingPackageSha256: run.publishingPackageSha256 || '',
  }))
}

function recoverRunEpisode(run) {
  if (!run.dramaId) return null
  const db = database()
  try {
    if (run.episodeId) {
      return db.prepare('select id from episodes where id = ? and deleted_at is null').get(run.episodeId) || null
    }
    const matches = db.prepare('select id from episodes where drama_id = ? and deleted_at is null order by id').all(run.dramaId)
    if (matches.length > 1) fail(`Run drama ${run.dramaId} owns more than one episode`)
    return matches[0] || null
  } finally {
    db.close()
  }
}

function episodeOwnershipFacts(run) {
  const db = database()
  try {
    const drama = db.prepare('select id, metadata from dramas where id = ? and deleted_at is null').get(run.dramaId)
    const episode = db.prepare(`
      select id, drama_id, narration_voice_id, narration_speed, image_config_id, bgm_audio_url
      from episodes where id = ? and deleted_at is null
    `).get(run.episodeId)
    return { drama, episode }
  } finally {
    db.close()
  }
}

async function persistEpisodePublishingPackage(run) {
  const episodeId = Number(run.episodeId)
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) {
    fail('Cannot persist the publishing package before the episode exists')
  }
  if (!run.publishingPackage) {
    fail('A dharma publishing package is required before episode publication')
  }
  const publishingPackage = normalizePublishingPackage(run.publishingPackage, { expectedTitle: run.title })
  const packageSha256 = publishingPackageFingerprint(publishingPackage)
  if (run.publishingPackageSha256 && run.publishingPackageSha256 !== packageSha256) {
    fail('Run publishing package fingerprint does not match its normalized package')
  }
  run.publishingPackage = publishingPackage
  run.publishingPackageSha256 = packageSha256
  const result = await request(`/episodes/${episodeId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishing_package: publishingPackage }),
  })
  if (result?.publishing_package_saved !== true) {
    fail(`Episode ${episodeId} did not confirm the publishing package write`)
  }
  return result
}

async function createEpisodeForRun(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'episode_create')
  saveRun(runPath, run)
  const rawScriptContent = readFileSync(run.scriptPath, 'utf8')
  if (hash(rawScriptContent) !== run.scriptHash) fail('Source script changed before factory intake')
  const scriptDocument = parseDharmaScriptDocument(rawScriptContent)
  if (!scriptDocument.body.trim()) fail('Script narration body is empty after removing front matter')
  const narrationHash = hash(scriptDocument.body)
  if (run.narrationHash && run.narrationHash !== narrationHash) {
    fail('Narration body changed after run creation')
  }
  run.narrationHash = narrationHash
  run.scriptMetadata = scriptDocument.metadata
  if (run.publishingPackage) {
    run.publishingPackage = normalizePublishingPackage(run.publishingPackage, { expectedTitle: run.title })
    run.publishingPackageSha256 = publishingPackageFingerprint(run.publishingPackage)
  }
  saveRun(runPath, run)
  const receipt = recoverFactoryIntake(run)
  if (receipt && receipt.requestSha256 !== factoryIntakeRequestSha256(run)) {
    fail('Factory intake receipt request SHA-256 does not match this run')
  }
  let drama = receipt ? { id: receipt.dramaId } : recoverRunDrama(run)
  let episode = receipt ? { id: receipt.episodeId } : recoverRunEpisode({ ...run, dramaId: drama?.id || run.dramaId })
  if (!drama || !episode) {
    run.factoryIntakeIntent = {
      token: run.creationToken,
      scriptHash: run.scriptHash,
      recordedAt: new Date().toISOString(),
    }
    saveRun(runPath, run)
    const intake = await request('/dharma/factory/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run_token: run.creationToken,
        title: run.title,
        script_content: scriptDocument.body,
        script_sha256: narrationHash,
        script_source_sha256: run.scriptHash,
        script_metadata: scriptDocument.metadata,
        ...(run.publishingPackage ? {
          publishing_package: run.publishingPackage,
          publishing_package_sha256: run.publishingPackageSha256,
        } : {}),
        media_account_id: run.mediaAccountId,
        image_config_id: run.imageConfigId,
        narration_voice_id: run.voiceId,
        narration_speed: run.narrationSpeed,
        bgm_audio_url: run.bgmPath,
      }),
    })
    drama = { id: Number(intake.drama_id) }
    episode = { id: Number(intake.episode?.id) }
    if (!drama.id || !episode.id) fail('Factory intake did not return one drama and one episode')
    run.factoryIntakeReceipt = {
      requestSha256: intake.request_sha256,
      reused: intake.reused === true,
      recordedAt: new Date().toISOString(),
    }
    if (run.factoryIntakeReceipt.requestSha256 !== factoryIntakeRequestSha256(run)) {
      fail('Factory intake response request SHA-256 does not match this run')
    }
  }
  run.dramaId = Number(drama.id)
  run.episodeId = Number(episode.id)
  if (run.publishingPackage) {
    await persistEpisodePublishingPackage(run)
    run.publishingPackagePersistedAt = new Date().toISOString()
  }
  delete run.dramaCreateIntent
  delete run.episodeImportIntent
  delete run.factoryIntakeIntent
  saveRun(runPath, run)

  const ownership = validateEpisodeOwnership({ run, ...episodeOwnershipFacts(run) })
  run.episodeReport = ownership
  if (ownership.passed) finishStage(run, 'episode_create', { passed: true, dramaId: run.dramaId, episodeId: run.episodeId })
  else finishStage(run, 'episode_create', { passed: false, errors: ownership.checks.errors })
  saveRun(runPath, run)
  return ownership
}

function ttsTaskById(taskId) {
  if (!taskId) return null
  const db = database()
  try {
    return db.prepare(`
      select id, type, episode_id, status, attempts, error_code, error_message, progress_current, progress_total,
             progress_message, created_at, updated_at, started_at, completed_at
      from creation_tasks
      where id = ?
    `).get(taskId) || null
  } finally {
    db.close()
  }
}

function pollTts(runPath) {
  const run = loadRun(runPath).state
  const task = ttsTaskById(run.ttsTaskId)
  if (!task || task.type !== 'tts.pre_generate' || Number(task.episode_id) !== Number(run.episodeId)) {
    fail(`Pinned TTS task ${run.ttsTaskId || 'missing'} no longer belongs to this run`)
  }
  run.ttsTask = task
  saveRun(runPath, run)
  return task
}

async function createMissingTtsTask(runPath) {
  const run = loadRun(runPath).state
  const task = await request('/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'tts.pre_generate',
      drama_id: run.dramaId,
      episode_id: run.episodeId,
      scope_type: 'episode',
      scope_id: run.episodeId,
      idempotency_key: `tts.pre_generate:direct_script:${run.dramaId}:${run.episodeId}`,
      payload: { episode_id: run.episodeId, drama_id: run.dramaId },
      max_attempts: 2,
    }),
  })
  run.ttsTaskId = Number(task.id)
  run.ttsTaskPinnedAt = new Date().toISOString()
  run.ttsTask = task
  saveRun(runPath, run)
  return task
}

function retryTtsTask(runPath) {
  const run = loadRun(runPath).state
  run.ttsMachineRetryCount = Number(run.ttsMachineRetryCount || 0) + 1
  run.ttsRetryIntent = {
    taskId: Number(run.ttsTaskId),
    retryCount: run.ttsMachineRetryCount,
    recordedAt: new Date().toISOString(),
  }
  saveRun(runPath, run)
  const db = database(false)
  let task
  try {
    const transaction = db.transaction(() => {
      task = db.prepare(`
        select id, status, attempts, max_attempts
        from creation_tasks
        where id = ? and episode_id = ? and type = 'tts.pre_generate'
      `).get(run.ttsTaskId, run.episodeId)
      if (!task || !['failed', 'stale'].includes(task.status)) {
        fail(`TTS task is not retryable: ${task?.status || 'missing'}`)
      }
      const now = new Date().toISOString()
      db.prepare(`
        update creation_tasks
        set status = 'queued', scheduled_at = null, lease_owner = null, lease_token = null,
            lease_expires_at = null, completed_at = null, retry_reason = ?,
            max_attempts = ?, updated_at = ?
        where id = ?
      `).run('dharma_comic_runner_repair', Math.max(Number(task.max_attempts || 1), Number(task.attempts || 0) + 1), now, task.id)
      db.prepare(`
        insert into creation_task_events (task_id, event_type, data_json, created_at)
        values (?, 'retry.scheduled', ?, ?)
      `).run(task.id, JSON.stringify({
        source: 'dharma_comic_runner',
        previous_status: task.status,
        attempts: Number(task.attempts || 0),
      }), now)
    })
    transaction()
  } finally {
    db.close()
  }
  delete run.ttsTimelineReport
  delete run.ttsCloneReport
  delete run.tts
  delete run.targetDurationSec
  run.ttsRetryIntent.completedAt = new Date().toISOString()
  run.ttsTask = ttsTaskById(run.ttsTaskId)
  saveRun(runPath, run)
  return run.ttsTask
}

export function ttsFailureRecovery({ taskStatus, machineRetryCount = 0, repairCount = 0 }) {
  if (!['failed', 'stale'].includes(String(taskStatus || ''))) {
    return { status: 'failed', nextAction: 'start-new-run' }
  }
  if (Number(machineRetryCount) < defaultTtsMachineRetryLimit) {
    return { status: 'ready', nextAction: 'retry-tts-task' }
  }
  if (Number(repairCount) < defaultTtsRepairLimit) {
    return { status: 'failed', nextAction: 'retry-stage' }
  }
  return { status: 'failed', nextAction: null }
}

function verifyTtsForRun(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'tts_verify')
  saveRun(runPath, run)
  const db = database()
  let episode
  try {
    episode = db.prepare(`
      select pre_tts_audio_url, pre_tts_titles_json
      from episodes where id = ? and deleted_at is null
    `).get(run.episodeId)
  } finally {
    db.close()
  }
  const titles = episode?.pre_tts_titles_json ? JSON.parse(episode.pre_tts_titles_json) : []
  let narrationPath = null
  let audioDurationSec = Number.NaN
  try {
    narrationPath = resolveDataPath(episode?.pre_tts_audio_url)
    audioDurationSec = mediaDuration(narrationPath)
  } catch {}
  const timeline = validateTtsTimeline({ titles, audioDurationSec })
  const voice = currentVoiceFacts(run.voiceKey)
  const clone = validateTtsClone({
    expectedVoiceKey: run.voiceKey,
    currentVoiceKey: voice.id,
    provider: voice.provider,
  })
  run.ttsTimelineReport = timeline
  run.ttsCloneReport = clone
  if (timeline.passed && clone.passed) {
    const narrationEndSec = Number(titles.at(-1).time_end) / 1000
    run.targetDurationSec = Math.max(30, Math.round((narrationEndSec + 1) * 1000) / 1000)
    const titlesCanonical = `${JSON.stringify(titles, null, 2)}\n`
    const titlesSha256 = hash(titlesCanonical)
    const titlesPath = join(dirname(runPath), `tts-titles-${titlesSha256.slice(0, 16)}.json`)
    if (!existsSync(titlesPath)) writeFileSync(titlesPath, titlesCanonical)
    const task = ttsTaskById(run.ttsTaskId)
    if (!task || task.status !== 'succeeded') fail('Pinned TTS task is not succeeded during verification')
    run.tts = {
      taskId: Number(task.id),
      audioSource: episode.pre_tts_audio_url,
      audioPath: narrationPath,
      audioSha256: hashFile(narrationPath),
      audioBytes: statSync(narrationPath).size,
      titlesPath,
      titlesSha256,
      titleCount: titles.length,
      narrationEndSec,
      audioDurationSec,
      verifiedAt: new Date().toISOString(),
    }
    finishStage(run, 'tts_verify', { passed: true, titleCount: titles.length, narrationEndSec })
  } else {
    finishStage(run, 'tts_verify', {
      passed: false,
      timelineErrors: timeline.checks.errors,
      cloneErrors: clone.checks.errors,
    })
  }
  saveRun(runPath, run)
  return { timeline, clone }
}

export function buildManifestBeatSkeleton(titles, targetDurationSec, options = {}) {
  if (!Array.isArray(titles) || titles.length < 5) fail('At least five TTS titles are required for comic planning')
  const desired = Math.max(5, Math.round((targetDurationSec / 10) / 5) * 5)
  const maximum = Math.floor(titles.length / 5) * 5
  const requestedPanelCount = options.panelCount === undefined ? null : Number(options.panelCount)
  if (requestedPanelCount !== null
    && (!Number.isInteger(requestedPanelCount) || requestedPanelCount < 5 || requestedPanelCount % 5 !== 0)) {
    fail('Requested panel count must be a positive multiple of five')
  }
  const panelCount = requestedPanelCount === null
    ? Math.max(5, Math.min(desired, maximum))
    : requestedPanelCount
  if (panelCount > titles.length) fail('Requested panel count cannot exceed the TTS title count')
  const beats = []
  let cursor = 0
  for (let panelIndex = 0; panelIndex < panelCount; panelIndex += 1) {
    const groupsLeft = panelCount - panelIndex - 1
    const targetEndSec = targetDurationSec * ((panelIndex + 1) / panelCount)
    let end = cursor + 1
    const maximumEnd = titles.length - groupsLeft
    // 20s start-gap rule: each non-last panel must begin within 20s of the
    // previous panel's start. Cap the group so the next panel's first title
    // is never more than 20s after this panel's first title. Any titles that
    // would overflow are absorbed by the last panel, which has no following
    // start gap to violate.
    let gapSafeEnd = maximumEnd
    if (panelIndex !== panelCount - 1) {
      gapSafeEnd = cursor + 1
      while (gapSafeEnd < maximumEnd
             && (Number(titles[gapSafeEnd].time_begin) - Number(titles[cursor].time_begin)) / 1000 <= 20) {
        gapSafeEnd += 1
      }
      gapSafeEnd = Math.max(cursor + 1, gapSafeEnd - 1)
    }
    while (end < maximumEnd && Number(titles[end - 1].time_end) / 1000 < targetEndSec) end += 1
    if (end > gapSafeEnd) end = gapSafeEnd
    if (end <= cursor) end = cursor + 1
    const group = titles.slice(cursor, end)
    const startSec = panelIndex === 0 ? 0 : Number(group[0].time_begin) / 1000
    beats.push({
      key: `p_${String(panelIndex + 1).padStart(3, '0')}`,
      page: Math.floor(panelIndex / 5) + 1,
      panel: (panelIndex % 5) + 1,
      startSec: Math.round(startSec * 1000) / 1000,
      narrationText: group.map((title) => String(title.text || '')).join(''),
      ttsTitleStart: cursor,
      ttsTitleEnd: end - 1,
    })
    cursor = end
  }
  return beats
}

function prepareManifestPlan(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'manifest_plan')
  saveRun(runPath, run)
  const frozenTts = validateFrozenTtsArtifacts(run.tts)
  if (!frozenTts.passed) fail(frozenTts.errors.join('; '))
  const titles = readJson(run.tts.titlesPath)
  const beats = buildManifestBeatSkeleton(titles, run.targetDurationSec, {
    panelCount: run.assetReuse?.sourcePanelCount,
  })
  const plan = {
    contract: productionProfile.id,
    source: {
      scriptPath: run.scriptPath,
      scriptHash: run.scriptHash,
      episodeId: run.episodeId,
      dramaId: run.dramaId,
    },
    fixedManifestFields: {
      version: 1,
      textEmphasisVersion: 1,
      episodeId: run.episodeId,
      dramaId: run.dramaId,
      fps: productionProfile.fps,
      width: productionProfile.width,
      height: productionProfile.height,
      model: productionProfile.imageModel,
      configId: run.imageConfigId,
      stylePreset: productionProfile.stylePreset,
      deliveryOutput: run.deliveryOutput,
      targetDurationSec: run.targetDurationSec,
    },
    requiredCreativeFields: [
      'visualProposition',
      'semantic.subject_count',
      'semantic.subjects',
      'semantic.relationship',
      'semantic.action',
      'semantic.visible_emotion',
      'semantic.visual_evidence',
      'continuity',
      'prompt',
      'referencePanelKeys',
    ],
    optionalCreativeFields: ['bubble', 'quote', 'focusX', 'focusY'],
    outputPath: run.manifestOutputPath,
    beats,
  }
  atomicWriteJson(run.manifestDraftPath, plan)
  run.manifestPlan = {
    path: run.manifestDraftPath,
    sha256: hashFile(run.manifestDraftPath),
    outputPath: run.manifestOutputPath,
    panelCount: beats.length,
    beatsSha256: hash(JSON.stringify(beats)),
    ttsTaskId: run.tts.taskId,
    audioSha256: run.tts.audioSha256,
    titlesSha256: run.tts.titlesSha256,
    createdAt: new Date().toISOString(),
  }
  if (run.assetReuse?.mode === 'tts-only') {
    const reusable = loadReusableAssetSource(run.assetReuse.sourceRunPath)
    const reusedManifest = buildReusedManifest({ sourceManifest: reusable.manifest, plan, run })
    atomicWriteJson(run.manifestOutputPath, reusedManifest)
    run.assetReuse = {
      ...run.assetReuse,
      sourceAssetFingerprint: reusable.resolved.fingerprint,
      reusedManifestPath: run.manifestOutputPath,
      reusedManifestSha256: hashFile(run.manifestOutputPath),
      preparedAt: new Date().toISOString(),
    }
  }
  finishStage(run, 'manifest_plan', { panels: beats.length, draftPath: run.manifestDraftPath })
  saveRun(runPath, run)
  return plan
}

function loadFrozenManifestPlan(run) {
  const frozenTts = validateFrozenTtsArtifacts(run.tts)
  if (!frozenTts.passed) fail(frozenTts.errors.join('; '))
  if (!run.manifestPlan?.path || !existsSync(run.manifestPlan.path)) fail('Frozen manifest beat plan is missing')
  if (hashFile(run.manifestPlan.path) !== run.manifestPlan.sha256) fail('Frozen manifest beat plan SHA-256 changed')
  const plan = readJson(run.manifestPlan.path)
  const expectedBeats = buildManifestBeatSkeleton(readJson(run.tts.titlesPath), run.targetDurationSec, {
    panelCount: run.assetReuse?.sourcePanelCount,
  })
  if (hash(JSON.stringify(plan.beats || [])) !== hash(JSON.stringify(expectedBeats))) {
    fail('Frozen manifest beat plan no longer matches the frozen TTS titles')
  }
  return plan
}

function manifestValidationForRun(run) {
  if (!existsSync(run.manifestOutputPath)) return null
  try {
    const plan = loadFrozenManifestPlan(run)
    const manifest = readJson(run.manifestOutputPath)
    return validateManifest(manifest, {
      resolveReferenceImage: resolveDataPath,
      expectedEpisodeId: run.episodeId,
      expectedDramaId: run.dramaId,
      expectedConfigId: run.imageConfigId,
      expectedTargetDurationSec: run.targetDurationSec,
      expectedDeliveryOutput: run.deliveryOutput,
      expectedBeats: plan.beats,
    })
  } catch (error) {
    return {
      passed: false,
      error_code: 'MANIFEST_INVALID',
      checks: { errors: [error instanceof Error ? error.message : String(error)] },
      data: null,
    }
  }
}

const reusableCreativePanelFields = [
  'visualProposition',
  'semantic',
  'continuity',
  'prompt',
  'referencePanelKeys',
  'referenceImages',
  'bubble',
  'focusX',
  'focusY',
]

export function buildReusedManifest({ sourceManifest, plan, run }) {
  if (!sourceManifest || !Array.isArray(sourceManifest.panels)) {
    fail('TTS-only revision source manifest is missing panels')
  }
  if (!plan || !Array.isArray(plan.beats)) fail('TTS-only revision beat plan is missing')
  if (sourceManifest.panels.length !== plan.beats.length) {
    fail(`TTS-only revision requires ${sourceManifest.panels.length} panels, but the new TTS produced ${plan.beats.length}; refusing to generate images`)
  }

  const panels = plan.beats.map((beat, index) => {
    const sourcePanel = sourceManifest.panels[index]
    if (sourcePanel?.key !== beat.key) {
      fail(`TTS-only revision panel order changed at ${beat.key}; refusing to generate images`)
    }
    const creative = Object.fromEntries(reusableCreativePanelFields
      .filter((field) => sourcePanel[field] !== undefined)
      .map((field) => [field, structuredClone(sourcePanel[field])]))
    if (typeof creative.prompt !== 'string' || !creative.prompt.trim()) {
      fail(`TTS-only revision source panel ${beat.key} has no frozen prompt`)
    }
    return {
      ...beat,
      ...creative,
    }
  })

  for (const [sourceIndex, sourcePanel] of sourceManifest.panels.entries()) {
    if (!sourcePanel.quote) continue
    const quoteText = String(sourcePanel.quote.text || '').trim()
    const candidates = panels
      .map((panel, targetIndex) => ({ panel, targetIndex }))
      .filter(({ panel }) => !panel.quote && quoteText && String(panel.narrationText || '').includes(quoteText))
      .sort((left, right) => (
        Math.abs(left.targetIndex - sourceIndex) - Math.abs(right.targetIndex - sourceIndex)
      ))
    const target = candidates[0]
    if (!target) fail(`TTS-only revision cannot place quote from ${sourcePanel.key} in the new narration timeline`)
    target.panel.quote = structuredClone(sourcePanel.quote)
  }

  return {
    version: 1,
    textEmphasisVersion: sourceManifest.textEmphasisVersion ?? 1,
    episodeId: Number(run.episodeId),
    dramaId: Number(run.dramaId),
    fps: productionProfile.fps,
    width: productionProfile.width,
    height: productionProfile.height,
    model: productionProfile.imageModel,
    configId: Number(run.imageConfigId),
    stylePreset: productionProfile.stylePreset,
    deliveryOutput: run.deliveryOutput,
    targetDurationSec: Number(run.targetDurationSec),
    source: {
      scriptPath: run.scriptPath,
      scriptHash: run.scriptHash,
      episodeId: Number(run.episodeId),
      dramaId: Number(run.dramaId),
      reusedFromRunId: run.assetReuse?.sourceRunId || null,
    },
    panels,
  }
}

function loadReusableAssetSource(sourceRunArg) {
  const source = loadRun(sourceRunArg)
  const state = source.state
  if (!state.manifestPath || !state.manifestHash) fail('TTS-only revision source run has no frozen manifest')
  const raw = readFileSync(state.manifestPath, 'utf8')
  if (hash(raw) !== state.manifestHash) fail('TTS-only revision source manifest hash changed')
  const manifest = JSON.parse(raw)
  const plan = loadFrozenManifestPlan(state)
  requirePassed(validateManifest(manifest, {
    resolveReferenceImage: resolveDataPath,
    expectedEpisodeId: state.episodeId,
    expectedDramaId: state.dramaId,
    expectedConfigId: state.imageConfigId,
    expectedTargetDurationSec: state.targetDurationSec,
    expectedDeliveryOutput: state.deliveryOutput,
    expectedBeats: plan.beats,
  }))
  const resolved = resolvedPanelAssets(manifest, state)
  if (!state.assetContactSheet || state.assetContactSheet.fingerprint !== resolved.fingerprint
    || !visualApprovalMatchesArtifact(
      state.assetApproval,
      state.assetContactSheet.path,
      state.assetContactSheet.artifactSha256,
      resolved.assets.length,
    )) {
    fail('TTS-only revision source run does not have current approved image evidence')
  }
  return {
    runPath: source.runPath,
    state,
    manifest,
    resolved,
  }
}

function attachManifest(runPath, manifestArg) {
  const run = loadRun(runPath).state
  const manifestPath = resolve(repoRoot, manifestArg || run.manifestOutputPath)
  if (manifestPath !== resolve(run.manifestOutputPath)) {
    fail(`Manifest must use the run output path: ${run.manifestOutputPath}`)
  }
  const validation = manifestValidationForRun(run)
  requirePassed(validation)
  const raw = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  run.manifestPath = manifestPath
  run.manifestHash = hash(raw)
  run.manifestFrozenAt = new Date().toISOString()
  run.episodeId = manifest.episodeId
  if (run.assetReuse?.mode === 'tts-only') {
    const reusable = loadReusableAssetSource(run.assetReuse.sourceRunPath)
    if (reusable.resolved.assets.length !== manifest.panels.length) {
      fail('TTS-only revision panel count differs from its approved image set; refusing to generate images')
    }
    const sourceJobs = new Map(reusable.state.jobs.map((job) => [job.key, job]))
    run.jobs = manifest.panels.map((panel) => {
      const sourceJob = sourceJobs.get(panel.key)
      if (!sourceJob?.localPath) fail(`TTS-only revision is missing approved image ${panel.key}`)
      return {
        key: panel.key,
        status: 'succeeded',
        localPath: sourceJob.localPath,
        attempt: 0,
        reusedFromRunId: reusable.state.runId,
      }
    })
    run.assetContactSheet = structuredClone(reusable.state.assetContactSheet)
    run.assetApproval = structuredClone(reusable.state.assetApproval)
    run.assetReuse = {
      ...run.assetReuse,
      sourceAssetFingerprint: reusable.resolved.fingerprint,
      attachedAssetFingerprint: reusable.resolved.fingerprint,
      attachedAt: run.manifestFrozenAt,
      imageTasksCreated: 0,
    }
    run.stages.image_submission = {
      startedAt: run.manifestFrozenAt,
      completedAt: run.manifestFrozenAt,
      elapsedMs: 0,
      submitted: 0,
      reused: run.jobs.length,
      skipped: true,
    }
    run.stages.image_wait = {
      startedAt: run.manifestFrozenAt,
      completedAt: run.manifestFrozenAt,
      elapsedMs: 0,
      succeeded: run.jobs.length,
      failed: 0,
      inFlight: 0,
      skipped: true,
    }
    run.stages.asset_contact_sheet = {
      startedAt: run.manifestFrozenAt,
      completedAt: run.manifestFrozenAt,
      elapsedMs: 0,
      panels: run.jobs.length,
      reused: true,
      sourceRunId: reusable.state.runId,
      fingerprint: reusable.resolved.fingerprint,
    }
  } else {
    run.jobs = manifest.panels.map((panel) => panel.src
      ? { key: panel.key, status: 'existing', localPath: panel.src, attempt: 0 }
      : { key: panel.key, status: 'pending', attempt: 1 })
  }
  run.stages.manifest_validate = {
    startedAt: run.manifestFrozenAt,
    completedAt: run.manifestFrozenAt,
    elapsedMs: 0,
    manifestHash: run.manifestHash,
    panels: manifest.panels.length,
    manifestPlanSha256: run.manifestPlan.sha256,
    ttsAudioSha256: run.tts.audioSha256,
    ttsTitlesSha256: run.tts.titlesSha256,
  }
  run.artifactChain = {
    scriptSha256: run.scriptHash,
    ttsTaskId: run.tts.taskId,
    ttsAudioSha256: run.tts.audioSha256,
    ttsTitlesSha256: run.tts.titlesSha256,
    beatPlanSha256: run.manifestPlan.sha256,
    manifestSha256: run.manifestHash,
  }
  saveRun(runPath, run)
  return { manifestPath, manifestHash: run.manifestHash, panels: manifest.panels.length }
}

function derivedPaths(manifest, manifestHash, options) {
  const slug = `dharma-comic-ep${manifest.episodeId}-${Math.round(manifest.targetDurationSec)}s-${manifestHash.slice(0, 10)}`
  return {
    statePath: resolve(repoRoot, options.state || `data/temp/${slug}.state.json`),
    propsPath: resolve(repoRoot, options.props || `data/temp/${slug}.props.json`),
    contactSheetPath: resolve(repoRoot, options.contact_sheet || `data/temp/${slug}.assets.jpg`),
    nativeWorkDir: resolve(repoRoot, options.native_work_dir || `data/temp/${slug}.native`),
    // dharma-text-v5：plate 底片与 Remotion 文字叠加层产物路径。overlay 序列目录
    // 禁止点段（Remotion CLI 会把点段误判为扩展名），所以用连字符目录。
    platePath: resolve(repoRoot, options.plate || `data/temp/${slug}.native/plate.mp4`),
    overlayPropsPath: resolve(repoRoot, options.overlay_props || `data/temp/${slug}.overlay-props.json`),
    overlaySequenceDir: resolve(repoRoot, options.overlay_sequence_dir || `data/temp/${slug}-overlay-sequence`),
    deliveryRecordPath: resolve(repoRoot, options.delivery_record || `data/temp/${slug}.delivery-render.json`),
    deliveryPath: resolve(repoRoot, options.output || manifest.deliveryOutput || `data/static/remotion/${slug}.mp4`),
  }
}

function initialState(context) {
  const { manifest, manifestPath, manifestHash } = context
  return {
    version: 1,
    manifestPath,
    manifestHash,
    episodeId: manifest.episodeId,
    startedAt: new Date().toISOString(),
    jobs: manifest.panels.map((panel) => panel.src
      ? { key: panel.key, status: 'existing', localPath: panel.src, attempt: 0 }
      : { key: panel.key, status: 'pending', attempt: 1 }),
    stages: {},
  }
}

function statusResult(stage, status, checks, errorCode, nextAction) {
  const actionKind = classifyNextAction(nextAction)
  return addFailureLesson({
    stage,
    status,
    checks,
    error_code: errorCode,
    next_action: nextAction,
    action_kind: actionKind,
    continuation_required: actionKind === 'machine' || actionKind === 'agent',
    user_handoff_allowed: actionKind === 'human' || actionKind === 'terminal',
  })
}

export function verificationFailureRecovery(report, repairCount = 0) {
  if (report?.retryable !== true || report?.failureClass !== 'transient') {
    return { status: 'failed', nextAction: 'start-new-run' }
  }
  if (Number(report.attempt || 0) < defaultVerificationTransientRetryLimit) {
    return { status: 'running', nextAction: 'verify' }
  }
  if (Number(repairCount) < defaultVerificationRepairLimit) {
    return { status: 'failed', nextAction: 'repair-delivery' }
  }
  return { status: 'failed', nextAction: null }
}

export function actionFailureRecovery(failure, history = []) {
  const repairCount = (history || []).filter((entry) => (
    entry.action === failure?.action && entry.errorCode === failure?.errorCode
  )).length
  return {
    repairCount,
    repairLimit: defaultActionRepairLimit,
    nextAction: repairCount < defaultActionRepairLimit ? 'retry-action' : null,
  }
}

export function deriveNextAction(manifest, state, facts = {}) {
  const baseChecks = {
    manifest_hash_matches: state ? state.manifestHash === facts.manifestHash : null,
    state_exists: Boolean(state),
  }
  if (!state) {
    return statusResult('manifest_validate', 'ready', baseChecks, 'STATE_REQUIRED', 'init')
  }
  if (state.manifestHash !== facts.manifestHash) {
    return statusResult('manifest_validate', 'failed', baseChecks, 'MANIFEST_CHANGED', null)
  }

  const failedJobs = state.jobs
    .filter((job) => ['failed', 'canceled', 'stale'].includes(job.status))
    .sort((left, right) => left.key.localeCompare(right.key))
  const activeJobs = state.jobs.filter((job) => job.taskId && !job.localPath)
  const pendingJobs = state.jobs.filter((job) => job.status === 'pending')
  const jobsByKey = new Map(state.jobs.map((job) => [job.key, job]))
  const panelsByKey = new Map(manifest.panels.map((panel) => [panel.key, panel]))
  const readyPendingJobs = pendingJobs.filter((job) => (panelsByKey.get(job.key)?.referencePanelKeys || [])
    .every((key) => Boolean(jobsByKey.get(key)?.localPath)))
  const imageChecks = {
    ...baseChecks,
    jobs_total: state.jobs.length,
    jobs_failed: failedJobs.length,
    jobs_active: activeJobs.length,
    jobs_pending: pendingJobs.length,
    jobs_ready_to_submit: readyPendingJobs.length,
  }

  if (failedJobs.length) {
    const failed = failedJobs[0]
    const canRetry = Number(failed.attempt || 0) < defaultImageAttemptLimit
    return statusResult(
      'image_wait',
      canRetry ? 'ready' : 'failed',
      { ...imageChecks, failed_key: failed.key, retry_available: canRetry },
      canRetry ? 'IMAGE_RETRY_REQUIRED' : 'IMAGE_RETRY_EXHAUSTED',
      canRetry ? `retry-failed --key ${failed.key}` : 'start-new-run',
    )
  }
  if (activeJobs.length) {
    return statusResult('image_wait', 'running', imageChecks, 'IMAGE_TASKS_ACTIVE', 'wait')
  }
  if (readyPendingJobs.length) {
    return statusResult('image_submit', 'ready', imageChecks, 'IMAGE_SUBMISSION_REQUIRED', 'submit')
  }
  if (pendingJobs.length) {
    return statusResult('image_submit', 'failed', imageChecks, 'IMAGE_DEPENDENCY_BLOCKED', 'start-new-run')
  }

  const artifactChecks = {
    ...imageChecks,
    assets_valid: facts.assetsValid === true,
    asset_contact_sheet_current: facts.assetContactSheetCurrent === true,
    asset_sheet_path: facts.assetSheetPath || null,
    asset_sheet_sha256: facts.assetSheetSha256 || null,
    asset_review_count: facts.assetReviewCount || null,
    asset_review_escalated: facts.assetReviewEscalated === true,
    asset_approval_current: facts.assetApprovalCurrent === true,
    props_current: facts.propsCurrent === true,
    delivery_render_current: facts.deliveryRenderCurrent === true,
    delivery_render_recoverable: facts.deliveryRenderRecoverable === true,
    delivery_render_sha256: facts.deliveryRenderSha256 || null,
    delivery_exists: facts.deliveryExists === true,
    delivery_owned: facts.deliveryOwned === true,
    delivery_verified: facts.deliveryVerified === true,
    verification_passed: facts.verificationAttested === true,
    delivery_sha256: facts.deliverySha256 || null,
    verification_sha256: facts.verificationSha256 || null,
    episode_video_url: facts.episodeVideoUrl || null,
    expected_episode_video_url: facts.expectedEpisodeVideoUrl || null,
    publishing_package_current: facts.publishingPackageCurrent === true,
    opening_hook_present: facts.openingHookPresent === true,
    cliffhanger_present: facts.cliffhangerPresent === true,
    cover_4x3_ready: facts.cover4x3Ready === true,
    cover_3x4_ready: facts.cover3x4Ready === true,
    episode_published_current: facts.episodePublishedCurrent === true,
  }
  if (facts.artifactError) {
    return statusResult('asset_review', 'failed', { ...artifactChecks, artifact_error: facts.artifactError }, 'ASSET_INVALID', 'start-new-run')
  }
  if (!facts.assetContactSheetCurrent) {
    return statusResult('asset_review', 'ready', artifactChecks, 'ASSET_CONTACT_SHEET_REQUIRED', 'contact-sheet')
  }
  if (!facts.assetApprovalCurrent) {
    return facts.assetReviewEscalated
      ? statusResult('asset_review', 'blocked', artifactChecks, 'ASSET_HUMAN_REVIEW_REQUIRED', 'decide-assets')
      : statusResult('asset_review', 'ready', artifactChecks, 'ASSET_VISUAL_REVIEW_REQUIRED', 'review-assets')
  }
  if (!facts.propsCurrent) {
    return statusResult('props_build', 'ready', artifactChecks, 'PROPS_REQUIRED', 'build-props')
  }
  if (!facts.deliveryRenderCurrent) {
    if (facts.deliveryExists && !facts.deliveryRenderRecoverable) {
      return statusResult('delivery_render', 'failed', artifactChecks, 'DELIVERY_EXISTS_UNOWNED', 'start-new-run')
    }
    return facts.deliveryRenderRecoverable
      ? statusResult('delivery_render', 'ready', artifactChecks, 'DELIVERY_RENDER_STATE_RECOVERY_REQUIRED', 'recover-delivery')
      : statusResult('delivery_render', 'ready', artifactChecks, 'DELIVERY_RENDER_REQUIRED', 'render-delivery')
  }
  if (!facts.deliveryOwned) {
    return statusResult('delivery_render', 'failed', artifactChecks, 'DELIVERY_RENDER_UNOWNED', 'start-new-run')
  }
  if (state.verificationReport && state.verificationReport.passed === false
    && state.verificationReport.sha256 === facts.deliverySha256) {
    const verificationRepairCount = (state.verificationRepairHistory || []).length
    const recovery = verificationFailureRecovery(state.verificationReport, verificationRepairCount)
    if (recovery.nextAction === 'verify') {
      return statusResult(
        'delivery_verify',
        recovery.status,
        {
          ...artifactChecks,
          retryable_errors: state.verificationReport.retryableErrors || [],
          verification_attempt: state.verificationReport.attempt || 1,
          verification_retry_limit: defaultVerificationTransientRetryLimit,
          verification_repair_count: verificationRepairCount,
          verification_repair_limit: defaultVerificationRepairLimit,
        },
        'DELIVERY_VERIFICATION_RETRY_REQUIRED',
        recovery.nextAction,
      )
    }
    return statusResult('delivery_verify', recovery.status, {
      ...artifactChecks,
      retryable_errors: state.verificationReport.retryableErrors || [],
      verification_attempt: state.verificationReport.attempt || 1,
      verification_retry_limit: defaultVerificationTransientRetryLimit,
      verification_repair_count: verificationRepairCount,
      verification_repair_limit: defaultVerificationRepairLimit,
    }, 'DELIVERY_VERIFICATION_FAILED', recovery.nextAction)
  }
  const deliveryVerificationCurrent = facts.deliveryVerified
    && facts.verificationAttested === true
    && facts.deliverySha256
    && facts.deliverySha256 === facts.verificationSha256
  if (!deliveryVerificationCurrent) {
    return statusResult('delivery_verify', 'ready', artifactChecks, 'DELIVERY_VERIFICATION_REQUIRED', 'verify')
  }
  if (facts.publishingPackageGateEnabled === true && (
    !facts.publishingPackageCurrent
    || !facts.openingHookPresent
    || !facts.cliffhangerPresent
    || !facts.cover4x3Ready
    || !facts.cover3x4Ready
  )) {
    return statusResult('episode_publish', 'ready', artifactChecks, 'EPISODE_PUBLISHING_PACKAGE_REQUIRED', 'publish-episode')
  }
  if (!facts.episodePublishedCurrent) {
    return statusResult('episode_publish', 'ready', artifactChecks, 'EPISODE_PUBLICATION_REQUIRED', 'publish-episode')
  }
  return statusResult('complete', 'complete', artifactChecks, 'COMPLETE', null)
}

function loadState(context, paths, create = false) {
  if (!existsSync(paths.statePath)) {
    if (!create) fail(`State does not exist: ${paths.statePath}; run init first`)
    const state = initialState(context)
    atomicWriteJson(paths.statePath, state)
    return state
  }
  const state = readJson(paths.statePath)
  if (state.manifestHash !== context.manifestHash) {
    fail(`Manifest changed after state creation; preserve ${paths.statePath} for audit and start with a new manifest path`)
  }
  return state
}

function saveState(paths, state) {
  atomicWriteJson(paths.statePath, state)
}

function startStage(state, name) {
  state.stageHistory ||= {}
  if (state.stages[name]) {
    state.stageHistory[name] ||= []
    state.stageHistory[name].push(state.stages[name].completedAt
      ? state.stages[name]
      : { ...state.stages[name], abandonedAt: new Date().toISOString() })
  }
  state.stages[name] = { startedAt: new Date().toISOString() }
}

function finishStage(state, name, detail = {}) {
  state.stages[name] = {
    ...state.stages[name],
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - new Date(state.stages[name].startedAt).getTime(),
    ...detail,
  }
}

function database(readonly = true) {
  const configured = process.env.DB_PATH || 'data/huobao_drama.db'
  const path = isAbsolute(configured) ? configured : resolve(repoRoot, configured)
  return new Database(path, { readonly })
}

function parseMetadata(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function commitEpisodeDeliveryRecord(db, input) {
  const episodeId = Number(input.episodeId)
  const videoUrl = String(input.videoUrl || '').trim()
  const deliverySha256 = String(input.deliverySha256 || '').trim()
  const verificationSha256 = String(input.verificationSha256 || '').trim()
  const runId = String(input.runId || '').trim()
  const propsSha256 = String(input.propsSha256 || '').trim()
  const publishedAt = String(input.publishedAt || new Date().toISOString())
  if (!Number.isInteger(episodeId) || episodeId <= 0) fail('Episode publication requires a positive episodeId')
  validateEpisodeVideoUrl(videoUrl)
  if (!/^[0-9a-f]{64}$/u.test(deliverySha256) || deliverySha256 !== verificationSha256) {
    fail('Episode publication requires matching delivery and verification SHA-256 values')
  }
  if (!runId || !/^[0-9a-f]{64}$/u.test(propsSha256)) fail('Episode publication is missing immutable run evidence')

  const transaction = db.transaction(() => {
    const current = db.prepare(`
      select id, video_url, metadata
      from episodes
      where id = ? and deleted_at is null
    `).get(episodeId)
    if (!current) fail(`Episode ${episodeId} does not exist for publication`)
    if (current.video_url && current.video_url !== videoUrl) {
      fail(`Episode ${episodeId} already points to a different delivery`)
    }
    const metadata = parseMetadata(current.metadata)
    const evidence = {
      runId,
      videoUrl,
      deliverySha256,
      verificationSha256,
      propsSha256,
      publishedAt,
    }
    const existingEvidence = metadata.dharmaComic
    const immutableEvidenceKeys = ['runId', 'videoUrl', 'deliverySha256', 'verificationSha256', 'propsSha256']
    const sameImmutableEvidence = existingEvidence
      && immutableEvidenceKeys.every((key) => existingEvidence[key] === evidence[key])
    if (current.video_url === videoUrl && existingEvidence && !sameImmutableEvidence) {
      fail(`Episode ${episodeId} delivery metadata belongs to a different run`)
    }
    const idempotent = current.video_url === videoUrl && sameImmutableEvidence
    if (!idempotent) {
      metadata.dharmaComic = evidence
      const update = db.prepare(`
        update episodes
        set video_url = ?, metadata = ?, updated_at = ?
        where id = ? and deleted_at is null and (video_url is null or video_url = ?)
      `).run(videoUrl, JSON.stringify(metadata), publishedAt, episodeId, videoUrl)
      if (update.changes !== 1) fail(`Episode ${episodeId} publication lost its compare-and-set`)
    }
    const committed = db.prepare(`
      select id, video_url
      from episodes
      where id = ? and deleted_at is null
    `).get(episodeId)
    if (!committed || committed.video_url !== videoUrl) fail(`Episode ${episodeId} publication did not commit`)
    return {
      episodeId,
      videoUrl,
      idempotent: Boolean(idempotent),
      publishedAt: idempotent ? String(existingEvidence.publishedAt || publishedAt) : publishedAt,
    }
  })
  return transaction()
}

export function validateEpisodeVideoUrl(value) {
  const videoUrl = String(value || '').trim()
  if (!/^static\/remotion\/[a-z0-9][a-z0-9._-]*\.mp4$/iu.test(videoUrl)) {
    fail('Episode publication requires a static/remotion/*.mp4 video URL')
  }
  return videoUrl
}

export function validateEpisodeFootageReadback(payload, expected) {
  const episodeId = Number(expected.episodeId)
  const videoUrl = String(expected.videoUrl || '')
  if (Number(payload?.episode_id) !== episodeId) {
    fail(`Footage API returned the wrong episode for publication: ${payload?.episode_id}`)
  }
  if (String(payload?.video_url || '') !== videoUrl) {
    fail(`Footage API does not expose the published video_url for episode ${episodeId}`)
  }
  return { episodeId, videoUrl }
}

export function deliveryVideoUrl(deliveryPath) {
  const deliveryRoot = join(repoRoot, 'data/static/remotion')
  const absolute = resolve(deliveryPath)
  const insideRoot = relative(deliveryRoot, absolute).replaceAll('\\', '/')
  if (!insideRoot || insideRoot.startsWith('../') || isAbsolute(insideRoot) || insideRoot.includes('/')) {
    fail(`Delivery is outside the frontend remotion root: ${deliveryPath}`)
  }
  return validateEpisodeVideoUrl(`static/remotion/${insideRoot}`)
}

function readEpisodeVideoUrl(episodeId) {
  const db = database()
  try {
    return db.prepare('select video_url from episodes where id = ? and deleted_at is null').get(episodeId)?.video_url || null
  } finally {
    db.close()
  }
}

function readEpisodePublishingFacts(episodeId, expectedPackageSha256) {
  const db = database()
  try {
    const episode = db.prepare(`
      select opening_hook, cliffhanger, creative_brief_json, cover_prompt,
             cover_design_json, cover_image_4x3_url, cover_image_3x4_url, metadata
      from episodes
      where id = ? and deleted_at is null
    `).get(episodeId)
    if (!episode) {
      return {
        publishingPackageCurrent: false,
        openingHook: null,
        cliffhanger: null,
        cover4x3Url: null,
        cover3x4Url: null,
      }
    }
    const metadata = parseMetadata(episode.metadata)
    const publishing = metadata.dharmaPublishing
    const packageSha256 = typeof publishing?.package_sha256 === 'string'
      ? publishing.package_sha256
      : ''
    const hasCreativeBrief = Boolean(String(episode.creative_brief_json || '').trim())
    const hasCoverDesign = Boolean(String(episode.cover_design_json || '').trim())
    const hasCoverPrompt = Boolean(String(episode.cover_prompt || '').trim())
    const openingHook = String(episode.opening_hook || '').trim()
    const cliffhanger = String(episode.cliffhanger || '').trim()
    const cover4x3Url = String(episode.cover_image_4x3_url || '').trim()
    const cover3x4Url = String(episode.cover_image_3x4_url || '').trim()
    return {
      publishingPackageCurrent: Boolean(
        openingHook
        && cliffhanger
        && hasCreativeBrief
        && hasCoverDesign
        && hasCoverPrompt
        && packageSha256
        && packageSha256 === expectedPackageSha256,
      ),
      openingHook,
      cliffhanger,
      cover4x3Url,
      cover3x4Url,
    }
  } finally {
    db.close()
  }
}

function recoverSubmission(frameType, dramaId) {
  const db = database()
  try {
    const idempotencyKey = `image.generate:global:${dramaId}:${frameType}`
    const task = db.prepare('select id, status, payload_json as payload from creation_tasks where idempotency_key = ? order by id desc limit 1').get(idempotencyKey)
    if (!task) return null
    let payload = {}
    try { payload = JSON.parse(task.payload || '{}') } catch {}
    const generationId = Number(payload.image_generation_id)
    if (!generationId) return null
    return { taskId: Number(task.id), imageGenerationId: generationId, status: task.status }
  } finally {
    db.close()
  }
}

async function request(path, init = {}) {
  const timeoutMs = Number(process.env.DHARMA_HTTP_TIMEOUT_MS || 30_000)
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  })
  const body = await response.text()
  let json
  try { json = JSON.parse(body) } catch { json = { message: body } }
  if (!response.ok) fail(`${path} returned ${response.status}: ${json.message || body}`)
  return json.data ?? json
}

const coverRatios = Object.freeze([
  { ratio: '4:3', urlKey: 'cover_4x3_url' },
  { ratio: '3:4', urlKey: 'cover_3x4_url' },
])

function coverGenerationState(state) {
  state.coverGeneration ||= {
    requiredRatios: coverRatios.map(({ ratio }) => ratio),
    tasks: {},
    attempts: {},
  }
  state.coverGeneration.tasks ||= {}
  state.coverGeneration.attempts ||= {}
  return state.coverGeneration
}

function coverUrl(covers, ratio) {
  const spec = coverRatios.find((item) => item.ratio === ratio)
  return String(spec ? covers?.[spec.urlKey] || '' : '').trim()
}

async function scheduleEpisodeCover(run, state, paths, ratio) {
  const coverState = coverGenerationState(state)
  const response = await request(`/episodes/${Number(run.episodeId)}/generate-covers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frame_type: ratio,
      cover_design: run.publishingPackage.cover_design,
    }),
  })
  const taskId = Number(response?.task_id)
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    fail(`Episode ${run.episodeId} cover ${ratio} scheduling returned no task id`)
  }
  coverState.tasks[ratio] = taskId
  coverState.attempts[ratio] = Number(coverState.attempts[ratio] || 0) + 1
  coverState.updatedAt = new Date().toISOString()
  saveState(paths, state)
  return taskId
}

async function ensureEpisodeCovers(run, state, paths) {
  if (!run.publishingPackage) fail('A dharma publishing package is required before cover generation')
  const episodeId = Number(run.episodeId)
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) fail('Cover generation requires a valid episode id')

  const timeoutMs = Number(process.env.DHARMA_COVER_WAIT_TIMEOUT_MS || defaultCoverWaitTimeoutMs)
  const pollIntervalMs = Number(process.env.DHARMA_COVER_POLL_INTERVAL_MS || defaultCoverPollIntervalMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('DHARMA_COVER_WAIT_TIMEOUT_MS must be positive')
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) fail('DHARMA_COVER_POLL_INTERVAL_MS must be non-negative')
  const deadline = Date.now() + timeoutMs

  let covers = await request(`/episodes/${episodeId}/covers`)
  const coverState = coverGenerationState(state)
  state.coverGeneration = {
    ...coverState,
    episodeId,
    packageSha256: run.publishingPackageSha256,
    startedAt: coverState.startedAt || new Date().toISOString(),
  }
  saveState(paths, state)

  while (true) {
    const missing = coverRatios.filter(({ ratio }) => !coverUrl(covers, ratio))
    if (!missing.length) {
      state.coverGeneration.completedAt = new Date().toISOString()
      state.coverGeneration.urls = Object.fromEntries(
        coverRatios.map(({ ratio }) => [ratio, coverUrl(covers, ratio)]),
      )
      saveState(paths, state)
      return covers
    }

    for (const { ratio } of missing) {
      const currentTaskId = Number(state.coverGeneration.tasks[ratio] || 0)
      if (currentTaskId > 0) {
        const task = await request(`/tasks/${currentTaskId}`)
        if (!task) fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} no longer exists`)
        if (task.status === 'succeeded') {
          fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} succeeded without a cover URL`)
        }
        if (terminalStatuses.has(task.status)) {
          delete state.coverGeneration.tasks[ratio]
          state.coverGeneration.lastFailure = {
            ratio,
            taskId: currentTaskId,
            status: task.status,
            error: task.error_message || null,
            recordedAt: new Date().toISOString(),
          }
          saveState(paths, state)
          fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} ended as ${task.status}: ${task.error_message || 'unknown error'}`)
        }
        if (task.status !== 'queued' && task.status !== 'running') {
          fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} has unexpected status ${task.status}`)
        }
        continue
      }
      await scheduleEpisodeCover(run, state, paths, ratio)
    }

    if (Date.now() >= deadline) {
      fail(`Episode ${episodeId} covers did not finish within ${Math.round(timeoutMs / 1000)} seconds`)
    }
    if (pollIntervalMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    covers = await request(`/episodes/${episodeId}/covers`)
  }
}

function composedPrompt(panel, stylePreset) {
  return [
    'Use case: reference-guided narrative illustration for a philosophical voiceover video.',
    'Asset type: one full-bleed 16:9 source image, not a finished comic page.',
    `Narration meaning: ${panel.visualProposition}`,
    `Scene: ${panel.prompt}`,
    `Mandatory visible evidence: ${panel.semantic.visual_evidence}`,
    panel.continuity ? `Character continuity: ${panel.continuity}` : '',
    'Composition: foreground, midground, and background must be clearly separated. Reserve useful negative space for editorial overlays without weakening the narrative action.',
    stylePrompts[stylePreset],
  ].filter(Boolean).join(' ')
}

function resolveReferenceImages(panel, state) {
  const byKey = new Map(state.jobs.map((job) => [job.key, job]))
  const dynamic = (panel.referencePanelKeys || []).map((key) => byKey.get(key)?.localPath)
  if (dynamic.some((value) => !value)) return null
  return [...new Set([...(panel.referenceImages || []), ...dynamic])]
}

async function submitReady(context, paths, onlyKeys = []) {
  const { manifest, manifestHash } = context
  const state = loadState(context, paths)
  if (state.assetReuse?.mode === 'tts-only') {
    fail('TTS-only asset reuse revision cannot submit image generation tasks')
  }
  startStage(state, 'image_submission')
  saveState(paths, state)
  const panelByKey = new Map(manifest.panels.map((panel) => [panel.key, panel]))
  let submitted = 0
  let recovered = 0
  for (const job of state.jobs) {
    if (job.status !== 'pending') continue
    if (onlyKeys.length && !onlyKeys.includes(job.key)) continue
    const panel = panelByKey.get(job.key)
    const referenceImages = resolveReferenceImages(panel, state)
    if (!referenceImages) continue
    const frameType = `dharma_comic_ep${manifest.episodeId}_${manifestHash.slice(0, 10)}_${job.key}_a${job.attempt}`
    const existing = recoverSubmission(frameType, manifest.dramaId)
    if (existing) {
      Object.assign(job, existing, { frameType, submittedAt: job.submittedAt || new Date().toISOString() })
      recovered += 1
      saveState(paths, state)
      continue
    }

    job.submissionIntent = { frameType, recordedAt: new Date().toISOString() }
    saveState(paths, state)
    const result = await request('/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drama_id: manifest.dramaId,
        prompt: composedPrompt(panel, manifest.stylePreset),
        config_id: manifest.configId,
        model: manifest.model,
        style: manifest.stylePreset,
        aspect_ratio: '16:9',
        frame_type: frameType,
        reference_images: referenceImages,
      }),
    })
    Object.assign(job, {
      status: 'submitted',
      frameType,
      imageGenerationId: Number(result.id),
      taskId: Number(result.task_id),
      submittedAt: new Date().toISOString(),
    })
    delete job.submissionIntent
    submitted += 1
    saveState(paths, state)
  }
  finishStage(state, 'image_submission', { submitted, recovered })
  saveState(paths, state)
  const blocked = state.jobs.filter((job) => job.status === 'pending').map((job) => job.key)
  console.log(JSON.stringify({
    submitted,
    recovered,
    blockedCount: blocked.length,
    blockedSample: blocked.slice(0, 8),
    statePath: paths.statePath,
  }, null, 2))
}

async function waitForSubmitted(context, paths, untilOne = false) {
  const state = loadState(context, paths)
  const active = state.jobs.filter((job) => job.taskId && !job.localPath)
  if (!active.length) fail('No submitted image jobs are waiting')
  startStage(state, 'image_wait')
  saveState(paths, state)
  let terminalCount = 0
  for (const job of active) {
    const previousStatus = job.status
    const task = await request(`/tasks/${job.taskId}`)
    job.status = task.status
    if (previousStatus !== task.status) {
      console.log(`${new Date().toISOString()} key=${job.key} task=${job.taskId} status=${task.status}`)
    }
    if (terminalStatuses.has(task.status)) {
      terminalCount += 1
      if (task.status === 'succeeded') {
        const image = await request(`/images/${job.imageGenerationId}`)
        if (image.status !== 'completed' || !image.localPath) fail(`Image ${job.imageGenerationId} has no localPath`)
        job.localPath = image.localPath
        job.completedAt = new Date().toISOString()
      } else {
        job.failedAt = new Date().toISOString()
      }
    }
  }
  saveState(paths, state)
  const completed = active.filter((job) => job.status === 'succeeded' && job.localPath)
  const failed = active.filter((job) => terminalStatuses.has(job.status) && job.status !== 'succeeded')
  const inFlight = active.length - completed.length - failed.length
  finishStage(state, 'image_wait', { succeeded: completed.length, failed: failed.length, inFlight })
  saveState(paths, state)
  if (failed.length) {
    console.error(`Image jobs failed: ${failed.map((job) => `${job.key}:${job.taskId}:${job.status}`).join(', ')}`)
  }
  const pending = state.jobs.filter((job) => job.status === 'pending').map((job) => job.key)
  console.log(JSON.stringify({
    succeeded: completed.length,
    inFlight,
    pendingDependencyCount: pending.length,
    pendingDependencySample: pending.slice(0, 8),
  }, null, 2))
}

async function retryFailed(context, paths, key) {
  if (!key) fail('retry-failed requires exactly one --key <panel-key>')
  const state = loadState(context, paths)
  const job = state.jobs.find((candidate) => candidate.key === key)
  if (!job) fail(`Unknown panel key: ${key}`)
  if (!['failed', 'canceled', 'stale'].includes(job.status)) fail(`Panel ${key} is not failed`)
  if (job.attempt >= defaultImageAttemptLimit) fail(`Panel ${key} already exhausted its image attempt budget`)
  Object.assign(job, { status: 'pending', attempt: job.attempt + 1 })
  for (const field of ['taskId', 'imageGenerationId', 'localPath', 'failedAt', 'completedAt', 'frameType']) delete job[field]
  saveState(paths, state)
  await submitReady(context, paths, [key])
}

function rejectAsset(context, paths, key, options) {
  if (!key) fail('reject-asset requires exactly one --key <panel-key>')
  const state = loadState(context, paths)
  const job = state.jobs.find((candidate) => candidate.key === key)
  if (!job) fail(`Unknown panel key: ${key}`)
  if (job.status !== 'succeeded' || !job.localPath) {
    fail(`Panel ${key} is not a generated succeeded asset`)
  }
  if (job.attempt >= defaultImageAttemptLimit) fail(`Panel ${key} already exhausted its image attempt budget`)
  const actor = requireTextOption(options, 'actor')
  const reason = requireTextOption(options, 'reason', 8)
  const rejectedAt = new Date().toISOString()
  state.assetRejections ||= []
  state.assetRejections.push({
    key,
    actor,
    reason,
    rejectedAt,
    attempt: job.attempt,
    localPath: job.localPath,
    sha256: hashFile(resolveDataPath(job.localPath)),
  })
  Object.assign(job, {
    status: 'failed',
    failedAt: rejectedAt,
    reviewRejected: true,
  })
  delete state.assetContactSheet
  delete state.assetApproval
  delete state.assetReviewEscalation
  delete state.props
  saveState(paths, state)
  console.log(JSON.stringify({ key, status: job.status, actor, reason, rejectedAt }, null, 2))
}

function resolveDataPath(input) {
  if (!input) fail('Missing asset path')
  const path = String(input)
  const absolute = isAbsolute(path)
    ? path
    : path.startsWith('static/')
      ? join(repoRoot, 'data', path)
      : resolve(repoRoot, path)
  if (!existsSync(absolute)) fail(`Asset does not exist: ${input}`)
  return absolute
}

function resolvedPanelAssets(manifest, state) {
  return requirePassed(validatePanelAssets(manifest, state, {
    resolveAssetPath: resolveDataPath,
    statFile: statSync,
    hashFile,
    hashValue: hash,
  }))
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: options.env || process.env,
    timeout: options.timeout || 2 * 60 * 60_000,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
  })
  if (result.error) fail(`${command} failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = options.inherit ? '' : `\n${result.stdout || ''}\n${result.stderr || ''}`
    fail(`${command} exited ${result.status}${detail}`)
  }
  return result
}

function createContactSheet(imagePaths, outputPath, tileWidth = 320, tileHeight = 180) {
  mkdirSync(dirname(outputPath), { recursive: true })
  const columns = Math.min(5, imagePaths.length)
  const filters = imagePaths.map((_, index) => (
    `[${index}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase,crop=${tileWidth}:${tileHeight}[v${index}]`
  ))
  const layout = imagePaths.map((_, index) => `${(index % columns) * tileWidth}_${Math.floor(index / columns) * tileHeight}`).join('|')
  filters.push(`${imagePaths.map((_, index) => `[v${index}]`).join('')}xstack=inputs=${imagePaths.length}:layout=${layout}:fill=black[out]`)
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...imagePaths.flatMap((path) => ['-i', path]),
    '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', outputPath,
  ])
}

function contactSheet(context, paths) {
  const state = loadState(context, paths)
  startStage(state, 'asset_contact_sheet')
  const resolved = resolvedPanelAssets(context.manifest, state)
  createContactSheet(resolved.assets.map((asset) => asset.path), paths.contactSheetPath)
  const indexPath = `${paths.contactSheetPath}.json`
  atomicWriteJson(indexPath, resolved.assets.map((asset, index) => ({
    panel: index + 1,
    key: asset.key,
    row: Math.floor(index / 5) + 1,
    column: (index % 5) + 1,
    sourcePath: asset.sourcePath,
  })))
  state.assetContactSheet = {
    path: paths.contactSheetPath,
    indexPath,
    fingerprint: resolved.fingerprint,
    artifactSha256: hashFile(paths.contactSheetPath),
    indexSha256: hashFile(indexPath),
    generatedAt: new Date().toISOString(),
  }
  if (state.assetApproval?.fingerprint !== resolved.fingerprint) delete state.assetApproval
  delete state.assetReviewEscalation
  finishStage(state, 'asset_contact_sheet', { panels: resolved.assets.length })
  saveState(paths, state)
  console.log(JSON.stringify({ contactSheetPath: paths.contactSheetPath, fingerprint: resolved.fingerprint }, null, 2))
}

function requireTextOption(options, name, minimum = 3) {
  const value = String(options[name] || '').trim()
  if (value.length < minimum) fail(`--${name.replaceAll('_', '-')} must be at least ${minimum} characters`)
  return value
}

function buildVisualApproval(options, {
  artifactPath,
  artifactSha256,
  expectedReviewedCount,
  fingerprint,
  extra = {},
}) {
  const reviewedCount = Number(options.reviewed_count)
  if (!Number.isInteger(reviewedCount) || reviewedCount < 1) {
    fail('--reviewed-count must be a positive integer')
  }
  const approval = {
    fingerprint,
    artifactSha256,
    actor: requireTextOption(options, 'actor'),
    reviewTool: requireTextOption(options, 'review_tool'),
    reviewedCount,
    reason: requireTextOption(options, 'reason', 12),
    ...extra,
  }
  requirePassed(validateVisualApproval({
    approval,
    artifactPath,
    expectedArtifactSha256: artifactSha256,
    expectedReviewedCount,
  }))
  return approval
}

function buildReviewEscalation(options, { artifactPath, artifactSha256, fingerprint }) {
  const sheetSha256 = requireTextOption(options, 'sheet_sha256', 64)
  if (sheetSha256 !== artifactSha256 || sheetSha256 !== hashFile(artifactPath)) {
    fail('Review escalation SHA-256 does not match the current sheet bytes')
  }
  const actor = requireTextOption(options, 'actor')
  const reviewTool = requireTextOption(options, 'review_tool')
  const reason = requireTextOption(options, 'reason', 12)
  if (actor !== 'agent') fail('Only the reviewing Agent can escalate an undecidable visual review')
  if (!['view_image', 'native_image_read'].includes(reviewTool)) {
    fail('Visual review must use view_image or a native image-reading tool before escalation')
  }
  return {
    fingerprint,
    artifactSha256: sheetSha256,
    actor,
    reviewTool,
    reason,
    escalatedAt: new Date().toISOString(),
  }
}

function approveAssets(context, paths, options) {
  const state = loadState(context, paths)
  const resolved = resolvedPanelAssets(context.manifest, state)
  if (!state.assetContactSheet || state.assetContactSheet.fingerprint !== resolved.fingerprint) {
    fail('Generate and inspect the current contact sheet before approval')
  }
  const sheetSha256 = requireTextOption(options, 'sheet_sha256', 64)
  if (sheetSha256 !== hashFile(state.assetContactSheet.path)
    || sheetSha256 !== state.assetContactSheet.artifactSha256) {
    fail('Asset approval SHA-256 does not match the current contact sheet bytes')
  }
  state.assetApproval = {
    ...buildVisualApproval(options, {
      artifactPath: state.assetContactSheet.path,
      artifactSha256: sheetSha256,
      expectedReviewedCount: resolved.assets.length,
      fingerprint: resolved.fingerprint,
    }),
    approvedAt: new Date().toISOString(),
  }
  if (state.assetApproval.actor === 'user'
    && (state.assetReviewEscalation?.fingerprint !== resolved.fingerprint
      || !reviewEscalationMatchesArtifact(
        state.assetReviewEscalation,
        state.assetContactSheet.path,
        state.assetContactSheet.artifactSha256,
      ))) {
    fail('User asset approval requires a current Agent review escalation')
  }
  delete state.assetReviewEscalation
  saveState(paths, state)
  console.log(JSON.stringify(state.assetApproval, null, 2))
}

function escalateAssets(context, paths, options) {
  const state = loadState(context, paths)
  const resolved = resolvedPanelAssets(context.manifest, state)
  if (!state.assetContactSheet || state.assetContactSheet.fingerprint !== resolved.fingerprint) {
    fail('Generate and inspect the current contact sheet before escalation')
  }
  state.assetReviewEscalation = buildReviewEscalation(options, {
    artifactPath: state.assetContactSheet.path,
    artifactSha256: state.assetContactSheet.artifactSha256,
    fingerprint: resolved.fingerprint,
  })
  delete state.assetApproval
  saveState(paths, state)
  console.log(JSON.stringify(state.assetReviewEscalation, null, 2))
}

function stageAsset(path) {
  const absolute = resolveDataPath(path)
  const extension = extname(absolute).toLowerCase() || '.bin'
  const filename = `${hashFile(absolute).slice(0, 20)}${extension}`
  const targetDir = join(repoRoot, 'remotion/public/dharma-assets')
  const target = join(targetDir, filename)
  mkdirSync(targetDir, { recursive: true })
  if (!existsSync(target)) copyFileSync(absolute, target)
  return `dharma-assets/${filename}`
}

function ffprobe(path) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]).stdout)
}

function mediaDuration(path) {
  const value = Number(ffprobe(path).format?.duration)
  if (!Number.isFinite(value)) fail(`Cannot read duration: ${path}`)
  return value
}

function measureLoudness(path) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', path,
    '-af', 'loudnorm=I=-24:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error) fail(`Cannot measure loudness: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`Cannot measure loudness: ffmpeg exited ${result.status}: ${String(result.stderr || '').slice(-1200)}`)
  }
  const blocks = String(result.stderr || '').match(/\{\s*"input_i"[\s\S]*?\}/gu)
  if (!blocks?.length) fail(`Cannot measure loudness: ${path}`)
  const parsed = JSON.parse(blocks.at(-1))
  const integratedLufs = Number(parsed.input_i)
  if (!Number.isFinite(integratedLufs)) fail(`Invalid loudness result: ${path}`)
  return integratedLufs
}

function measureLoudnessAsync(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-nostats', '-i', path,
      '-af', 'loudnorm=I=-24:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-256_000)
    })
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(`Loudness scan timed out: ${path}`))
    }, 10 * 60_000)
    child.on('error', (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        rejectPromise(new Error(`Cannot measure loudness: ${path} (ffmpeg exit ${code})`))
        return
      }
      try {
        const blocks = stderr.match(/\{\s*"input_i"[\s\S]*?\}/gu)
        if (!blocks?.length) throw new Error('loudnorm JSON is missing')
        const integratedLufs = Number(JSON.parse(blocks.at(-1)).input_i)
        if (!Number.isFinite(integratedLufs)) throw new Error('input_i is invalid')
        resolvePromise(integratedLufs)
      } catch (error) {
        rejectPromise(new Error(`Cannot parse loudness for ${path}: ${error.message}`))
      }
    })
  })
}

function deriveBgmMix(narrationLufs, bgmLufs, sourceDurationSec) {
  if (sourceDurationSec < 180) fail(`BGM is ${sourceDurationSec.toFixed(1)}s; production requires at least 180s`)
  const targetLufs = narrationLufs - 14
  const volume = 10 ** ((targetLufs - bgmLufs) / 20)
  if (volume > 0.5) fail(`BGM is too quiet and would require unsafe gain ${volume.toFixed(3)}`)
  const round = (value) => Math.round(value * 10_000) / 10_000
  return {
    volume: round(volume),
    narrationVolume: round(volume * 0.5),
    fadeInSec: 3,
    fadeOutSec: 5,
    loopCrossfadeSec: 4,
    sourceDurationSec,
    targetLufs: Math.round(targetLufs * 10) / 10,
    narrationLufs,
    bgmLufs,
  }
}

function splitSubtitle(title, ttsTitleIndex) {
  const text = String(title.text || '')
  const parts = text.match(/[^，。！？；：、]+[，。！？；：、]?/gu) || [text]
  const duration = (title.time_end - title.time_begin) / 1000
  let offset = 0
  return parts.flatMap((part) => {
    const chunks = []
    for (let index = 0; index < part.length; index += 18) chunks.push(part.slice(index, index + 18))
    return chunks.map((chunk) => {
      const start = offset
      offset += chunk.length
      return {
        ttsTitleIndex,
        text: chunk,
        // ink-read-v2：关键词由规则自动提取（佛学术语/否定/转折/金句短词，≤2 个）。
        subtitleKeywords: extractSubtitleKeywords(chunk),
        startSec: title.time_begin / 1000 + duration * (start / Math.max(1, text.length)),
        endSec: title.time_begin / 1000 + duration * (offset / Math.max(1, text.length)),
      }
    })
  })
}

function titleTimeAt(titles, characterIndex, edge) {
  let cursor = 0
  for (const title of titles) {
    const text = String(title.text || '')
    const end = cursor + text.length
    const inside = edge === 'start'
      ? characterIndex >= cursor && characterIndex < end
      : characterIndex > cursor && characterIndex <= end
    if (inside && text.length > 0) {
      const startMs = Number(title.time_begin)
      const endMs = Number(title.time_end)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        fail('TTS title contains an invalid time range')
      }
      const progress = Math.min(1, Math.max(0, (characterIndex - cursor) / text.length))
      return (startMs + (endMs - startMs) * progress) / 1000
    }
    cursor = end
  }
  if (edge === 'start' && characterIndex === cursor && titles.length) {
    return Number(titles.at(-1).time_end) / 1000
  }
  fail(`Cannot map TTS character ${characterIndex} to time`)
}

export function buildQuoteProps(manifest, titles, fps) {
  const titleOffsets = []
  let timelineLength = 0
  for (const title of titles) {
    titleOffsets.push(timelineLength)
    timelineLength += String(title.text || '').length
  }
  const quotePanels = manifest.panels
    .map((panel, panelIndex) => ({ panel, panelIndex }))
    .filter(({ panel }) => panel.quote)
  const explicitTheme = quotePanels.find(({ panel }) => panel.quote?.kind === 'theme')
  const legacyTheme = explicitTheme || quotePanels.find(({ panel, panelIndex }) => {
    const source = String(panel.quote?.source || '')
    const textLength = [...String(panel.quote?.text || '').trim()].length
    return panel.quote?.kind === undefined
      && panelIndex < manifest.panels.length * 0.9
      && (!source || /义理|转述/u.test(source))
      && textLength >= 4
      && textLength <= 28
  }) || quotePanels.find(({ panel }) => panel.quote?.kind === undefined)

  return quotePanels.flatMap(({ panel }) => {
    if (!panel.quote) return []
    const text = String(panel.quote.text).trim()
    const ttsTitleStart = Number(panel.ttsTitleStart)
    const ttsTitleEnd = Number(panel.ttsTitleEnd)
    if (!Number.isInteger(ttsTitleStart) || !Number.isInteger(ttsTitleEnd)
      || ttsTitleStart < 0 || ttsTitleEnd < ttsTitleStart || ttsTitleEnd >= titles.length) {
      fail(`Panel ${panel.key} has an invalid frozen TTS title range`)
    }
    const panelTimeline = titles
      .slice(ttsTitleStart, ttsTitleEnd + 1)
      .map((title) => String(title.text || ''))
      .join('')
    const relativeStartIndex = panelTimeline.indexOf(text)
    if (relativeStartIndex < 0) {
      fail(`Quote is missing from panel ${panel.key} frozen TTS title range: ${text}`)
    }
    const startIndex = titleOffsets[ttsTitleStart] + relativeStartIndex
    const endIndex = startIndex + text.length
    const spokenStartSec = titleTimeAt(titles, startIndex, 'start')
    const spokenEndSec = titleTimeAt(titles, endIndex, 'end')
    let kind = String(panel.quote.kind || '').trim()
    if (!kind) {
      const source = String(panel.quote.source || '')
      if (legacyTheme?.panel.key === panel.key) kind = 'theme'
      else if (source && !/义理|转述/u.test(source)) kind = 'scripture'
      else kind = 'explanation'
    }
    const presentation = emphasisPresentation[kind]
    if (!presentation) fail(`Panel ${panel.key} has an unsupported quote kind: ${kind}`)
    // Quote timing is locked to the authoritative independent checker
    // (scripts/videoeditor/check_dharma_sync.mjs): lead -0.35s, tail +0.65s,
    // minimum 90 frames. The checker re-derives the same frames from the frozen
    // TTS titles and fails the delivery on any mismatch, so these values are
    // the single source of truth for every kind. Visual kind differences are
    // expressed by animationPreset/sfxPreset, not by the time window.
    const timing = { leadSec: 0.35, tailSec: 0.65, minimumFrames: 90 }
    const startFrame = Math.max(0, Math.floor((spokenStartSec - timing.leadSec) * fps))
    const spokenEndFrame = Math.ceil((spokenEndSec + timing.tailSec) * fps)
    const durationInFrames = Math.max(timing.minimumFrames, spokenEndFrame - startFrame)
    return [{
      panelKey: panel.key,
      ttsTitleStart,
      ttsTitleEnd,
      text,
      kind,
      ...presentation,
      ...(panel.quote.source ? { source: String(panel.quote.source).trim() } : {}),
      startFrame,
      durationInFrames,
    }]
  })
}

export function buildTimedTextProps(manifest, titles, fps) {
  if (!Number.isFinite(fps) || fps <= 0) fail('Timed text fps must be positive')
  if (!Array.isArray(titles) || !titles.length) fail('Timed text requires frozen TTS titles')
  const frame = (seconds) => Math.round(seconds * fps)
  const narrationEndSec = Number(titles.at(-1).time_end) / 1000
  if (!Number.isFinite(narrationEndSec) || narrationEndSec <= 0) {
    fail('Timed text has an invalid narration end')
  }
  const spokenSubtitles = titles.flatMap((title, index) => splitSubtitle(title, index))
  // ink-read-v2：显示窗口在 spoken 窗口上应用驻留规则（+0.35s、间隙 <12 帧减半、
  // 退场与下一句入场重叠 3 帧封顶）。check_dharma_sync.mjs 从冻结 TTS titles
  // 独立重算这些窗口，任何手改 props 都会在那里失败。
  const displayWindows = computeSubtitleDisplayWindows(spokenSubtitles, fps)
  const subtitles = spokenSubtitles.map((subtitle, index) => ({
    ...subtitle,
    ...displayWindows[index],
  }))
  return {
    textPresentationVersion,
    subtitlePreset,
    narrationEndFrame: frame(narrationEndSec),
    narrationWindows: titles.map((title) => ({
      startFrame: frame(Number(title.time_begin) / 1000),
      endFrame: frame(Number(title.time_end) / 1000),
    })),
    quotes: buildQuoteProps(manifest, titles, fps),
    subtitles,
  }
}

// chapter-hooks-v1：顶部章节条派生。chapter_hooks 的 anchor 是该章第一句
// 旁白的开头片段（写稿阶段从正文抄准），在冻结 TTS titles 里定位章节起点；
// 章节时间轴的唯一真源是 titles 的 time_begin/time_end。缺省返回空数组——
// 无 hooks 的 episode 不出章节条。anchor 失配是写稿侧错误，fail-fast 不容错。
export function resolveChapterHooks(chapterHooks, titles, durationSec) {
  if (!Array.isArray(chapterHooks) || !chapterHooks.length) return []
  if (!Array.isArray(titles) || !titles.length) fail('Chapter hooks require frozen TTS titles')
  if (!Number.isFinite(durationSec) || durationSec <= 0) fail('Chapter hooks require a positive duration')
  let previousStartSec = -Infinity
  const chapters = chapterHooks.map((hook, index) => {
    const label = String(hook.label || '').trim()
    const anchor = String(hook.anchor || '').trim()
    if (!anchor) {
      fail(`Chapter hook ${index + 1} (${label || 'unlabeled'}) is missing its anchor; chapter timing is located via anchor text`)
    }
    const title = titles.find((entry) => String(entry.text || '').includes(anchor))
    if (!title) {
      fail(`Chapter hook ${index + 1} anchor is not in the frozen TTS titles: ${anchor}`)
    }
    const startSec = Number(title.time_begin) / 1000
    if (!Number.isFinite(startSec) || startSec <= previousStartSec) {
      fail(`Chapter hook ${index + 1} (${label}) does not start after the previous chapter; check anchor ordering`)
    }
    previousStartSec = startSec
    return { label, startSec }
  })
  return chapters.map((chapter, index) => ({
    label: chapter.label,
    startSec: chapter.startSec,
    endSec: index + 1 < chapters.length ? chapters[index + 1].startSec : durationSec,
  }))
}

// dharma-text-v5：Remotion 文字叠加层（DharmaTextOverlay）的显式输入契约。
// 只保留真正参与文字层渲染的字段，使 overlayFingerprint 与底片素材解耦——
// 换画面不重渲文字，改文字不重渲底片。字幕必须自带 ink-read-v2 display
// 窗口与 subtitleKeywords，金句必须自带 startFrame/durationInFrames；
// 生产链路不允许 overlay 侧现算兜底，缺字段即显式失败。
export function buildOverlayProps(props) {
  const subtitles = props.subtitles || []
  const quotes = props.quotes || []
  const chapters = props.chapters || []
  for (const [index, subtitle] of subtitles.entries()) {
    if (!Number.isFinite(Number(subtitle.displayStartSec)) || !Number.isFinite(Number(subtitle.displayEndSec))
      || Number(subtitle.displayEndSec) <= Number(subtitle.displayStartSec)) {
      fail(`Subtitle ${index + 1} is missing its ink-read-v2 display window; rebuild timed text props`)
    }
    if (!Array.isArray(subtitle.subtitleKeywords)) {
      fail(`Subtitle ${index + 1} is missing subtitleKeywords; rebuild timed text props`)
    }
  }
  for (const [index, quote] of quotes.entries()) {
    if (!Number.isInteger(quote.startFrame) || !Number.isInteger(quote.durationInFrames) || quote.durationInFrames <= 0) {
      fail(`Quote ${index + 1} is missing startFrame/durationInFrames; rebuild timed text props`)
    }
  }
  // chapter-hooks-v1：顶部章节条契约。秒制窗口,与 subtitles 同源;
  // 必须单调不重叠且落在全片时长内,缺省空数组(无 hooks 不出条)。
  const durationSec = Number(props.durationInFrames) / Number(props.fps)
  let previousEndSec = -Infinity
  for (const [index, chapter] of chapters.entries()) {
    const startSec = Number(chapter.startSec)
    const endSec = Number(chapter.endSec)
    if (!String(chapter.label || '').trim()) {
      fail(`Chapter ${index + 1} is missing its label; rebuild chapter hooks`)
    }
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      fail(`Chapter ${index + 1} has an invalid startSec/endSec window; rebuild chapter hooks`)
    }
    if (startSec < previousEndSec - 1e-6) {
      fail(`Chapter ${index + 1} overlaps the previous chapter; rebuild chapter hooks`)
    }
    if (endSec > durationSec + 0.5) {
      fail(`Chapter ${index + 1} ends beyond the episode duration; rebuild chapter hooks`)
    }
    previousEndSec = endSec
  }
  return {
    durationInFrames: props.durationInFrames,
    fps: props.fps,
    width: props.width,
    height: props.height,
    subtitles,
    quotes,
    chapters,
  }
}

async function buildProps(context, paths) {
  const { manifest } = context
  const state = loadState(context, paths)
  const resolved = resolvedPanelAssets(manifest, state)
  if (state.assetApproval?.fingerprint !== resolved.fingerprint
    || !state.assetContactSheet
    || !visualApprovalMatchesArtifact(
      state.assetApproval,
      state.assetContactSheet.path,
      state.assetContactSheet.artifactSha256,
      resolved.assets.length,
    )) {
    fail('Current assets do not have valid visual review evidence')
  }
  startStage(state, 'props_build')
  saveState(paths, state)

  const frozenTts = validateFrozenTtsArtifacts(state.tts)
  if (!frozenTts.passed) fail(frozenTts.errors.join('; '))
  const titles = readJson(state.tts.titlesPath)
  if (!titles.length) fail('Frozen TTS title timeline is empty')
  const narrationEndSec = Number(titles.at(-1).time_end) / 1000
  if (manifest.targetDurationSec - narrationEndSec > 3) {
    fail(`Target leaves ${(manifest.targetDurationSec - narrationEndSec).toFixed(2)}s after narration; allow at most 3s`)
  }

  const narrationPath = state.tts.audioPath
  const bgmSource = state.bgmPath || fixedBgmPath
  const bgmPath = resolveDataPath(bgmSource)
  const audioDurationSec = mediaDuration(narrationPath)
  requirePassed(validateTtsTimeline({ titles, audioDurationSec, targetDurationSec: manifest.targetDurationSec }))
  const bgmDurationSec = mediaDuration(bgmPath)
  const [narrationLufs, bgmLufs] = await Promise.all([
    measureLoudnessAsync(narrationPath),
    measureLoudnessAsync(bgmPath),
  ])
  const bgm = deriveBgmMix(narrationLufs, bgmLufs, bgmDurationSec)
  const fps = manifest.fps ?? 30
  const frame = (seconds) => Math.round(seconds * fps)
  const timedText = buildTimedTextProps(manifest, titles, fps)
  const chapters = resolveChapterHooks(state.publishingPackage?.chapter_hooks, titles, narrationEndSec)
  const sfxCandidates = timedText.quotes.filter((quote) => quote.sfxPreset)
  const themeSfx = sfxCandidates.find((quote) => quote.kind === 'theme')
  const selectedSfxFrames = themeSfx ? [themeSfx.startFrame] : []
  const selectedScriptureKeys = new Set()
  for (const quote of sfxCandidates.filter((candidate) => candidate.kind === 'scripture')) {
    if (selectedSfxFrames.every((frameValue) => Math.abs(frameValue - quote.startFrame) >= 45 * fps)) {
      selectedSfxFrames.push(quote.startFrame)
      selectedScriptureKeys.add(quote.panelKey)
    }
  }
  const quotes = timedText.quotes.map((quote) => {
    const keepSfx = quote.kind === 'theme' || selectedScriptureKeys.has(quote.panelKey)
    if (keepSfx || !quote.sfxPreset) return quote
    const { sfxPreset: _discardedSfxPreset, ...withoutSfx } = quote
    return withoutSfx
  })
  const assetsByKey = new Map(resolved.assets.map((asset) => [asset.key, asset.sourcePath]))
  const panels = manifest.panels.map((panel) => ({
    src: stageAsset(assetsByKey.get(panel.key)),
    focusX: panel.focusX ?? 50,
    focusY: panel.focusY ?? 50,
    emphasisStartFrame: frame(panel.startSec),
    ...(panel.bubble ? { bubble: panel.bubble } : {}),
  }))
  const props = {
    variant: 'progressive_five',
    durationInFrames: frame(manifest.targetDurationSec),
    fps,
    width: 1280,
    height: 720,
    // dharma-text-v5：subtitle/emphasis 文字层由 Remotion overlay 叠加，
    // native renderer 只出 plate 底片（见 dharma_text_overlay_stage.mjs）。
    textLayers: 'overlay',
    audio: stageAsset(narrationPath),
    audioStartFrame: 0,
    narrationEndFrame: timedText.narrationEndFrame,
    narrationWindows: timedText.narrationWindows,
    textPresentationVersion: timedText.textPresentationVersion,
    subtitlePreset: timedText.subtitlePreset,
    bgm: { ...bgm, src: stageAsset(bgmPath) },
    artifactChain: {
      manifestSha256: context.manifestHash,
      assetFingerprint: resolved.fingerprint,
      ttsTaskId: state.tts.taskId,
      ttsAudioSha256: state.tts.audioSha256,
      ttsTitlesSha256: state.tts.titlesSha256,
      bgmSha256: hashFile(bgmPath),
    },
    segments: [{
      kind: 'image',
      src: panels[0].src,
      startFrame: 0,
      durationInFrames: frame(manifest.targetDurationSec),
      move: 'hold',
      treatment: 'surreal_dream',
      shotFunction: 'narrative_illustration',
    }],
    quotes,
    subtitles: timedText.subtitles,
    chapters,
    panels,
  }
  atomicWriteJson(paths.propsPath, props)
  // 显式落盘 Remotion overlay props（display 窗口 + 关键词 + 金句帧窗口），
  // overlayFingerprint 绑定此文件字节，与底片 interval 指纹分离。
  const overlayProps = buildOverlayProps(props)
  atomicWriteJson(paths.overlayPropsPath, overlayProps)
  state.props = {
    path: paths.propsPath,
    fingerprint: hashFile(paths.propsPath),
    textLayers: 'overlay',
    overlayPropsPath: paths.overlayPropsPath,
    overlayPropsSha256: hashFile(paths.overlayPropsPath),
    manifestSha256: context.manifestHash,
    assetFingerprint: resolved.fingerprint,
    ttsAudioSha256: state.tts.audioSha256,
    ttsTitlesSha256: state.tts.titlesSha256,
    narrationEndSec,
    builtAt: new Date().toISOString(),
  }
  finishStage(state, 'props_build', {
    panels: panels.length,
    quotes: quotes.length,
    sfxEvents: quotes.filter((quote) => quote.sfxPreset).length,
    subtitles: props.subtitles.length,
    bgm,
  })
  saveState(paths, state)
  console.log(JSON.stringify({ propsPath: paths.propsPath, narrationEndSec, panels: panels.length, bgm }, null, 2))
}

// 校验 renderer result.json 与 plate 底片。生产模式显式要求
// textLayers='overlay'，防止 burned 全层产物混进叠加链路。
function readValidRendererResult(context, paths) {
  const nativeResultPath = join(paths.nativeWorkDir, 'result.json')
  const props = existsSync(paths.propsPath) ? readJson(paths.propsPath) : null
  const report = validateNativeResult({
    nativeResultPath,
    deliveryPath: paths.platePath,
    expectedFrames: Math.round(context.manifest.targetDurationSec * 30),
    expectedPropsSha256: existsSync(paths.propsPath) ? hashFile(paths.propsPath) : null,
    expectedSfxEventCount: Array.isArray(props?.quotes)
      ? props.quotes.filter((quote) => quote.sfxPreset).length
      : undefined,
    expectedNarrationLufs: props?.bgm?.narrationLufs,
    expectedAudioMixVersion: NATIVE_AUDIO_MIX_VERSION,
    expectedBgmMounted: Boolean(props?.bgm?.src),
    expectedTextLayers: 'overlay',
  })
  return report.passed ? report.data : null
}

// final delivery 当前性判定：overlay 序列指纹命中且合成记录绑定当前
// plate/delivery 字节（三环缺一即重跑）。
function readValidDeliveryRenderResult(context, paths) {
  const props = existsSync(paths.propsPath) ? readJson(paths.propsPath) : null
  if (props?.textLayers !== 'overlay') return null
  const rendererResult = readValidRendererResult(context, paths)
  if (!rendererResult) return null
  if (!existsSync(paths.overlayPropsPath)) return null
  const evidence = readOverlayCompositeEvidence({
    deliveryRecordPath: paths.deliveryRecordPath,
    deliveryPath: paths.deliveryPath,
    platePath: paths.platePath,
    sequenceDir: paths.overlaySequenceDir,
    expectedFrames: Math.round(context.manifest.targetDurationSec * 30),
    expectedFingerprint: overlayFingerprint({ propsSha256: hashFile(paths.overlayPropsPath) }),
    expectedPlateSha256: rendererResult.outputSha256,
    expectedVideoEncoder: DHARMA_VIDEO_ENCODER,
  })
  if (!evidence) return null
  return { ...rendererResult, overlay: evidence }
}

// dharma-text-v5 文字叠加生产编排（render-delivery 与 e2e 共用同一函数，
// 不许另拼命令）：plate 底片（result.json 有效则复用 interval 指纹缓存跳过）
// → Remotion overlay PNG 序列（overlayFingerprint 命中跳过）→ ffmpeg 合成
// final delivery 并落盘合成记录。任一环节失败显式抛错，不回退 ffmpeg 仿制文字层。
export function renderOverlayDelivery({ context, paths, props, env = process.env }) {
  if (props?.textLayers !== 'overlay') {
    fail("Overlay delivery rendering requires props.textLayers='overlay'")
  }
  const rendererPath = join(repoRoot, 'scripts/videoeditor/dharma_comic_native_renderer.mjs')
  if (!existsSync(rendererPath)) fail(`Native comic renderer is missing: ${rendererPath}`)
  let rendererResult = readValidRendererResult(context, paths)
  if (!rendererResult) {
    mkdirSync(dirname(paths.platePath), { recursive: true })
    run('node', [
      rendererPath,
      '--props', paths.propsPath,
      '--output', paths.platePath,
      '--work-dir', paths.nativeWorkDir,
    ], { inherit: true, timeout: 6 * 60 * 60_000, env })
    rendererResult = readValidRendererResult(context, paths)
    if (!rendererResult) fail('Native renderer completed without a valid plate result.json')
  }
  const expectedFrames = Number(props.durationInFrames)
  const sequence = renderTextOverlaySequence({
    propsPath: paths.overlayPropsPath,
    sequenceDir: paths.overlaySequenceDir,
    expectedFrames,
  })
  const composite = compositeTextOverlay({
    platePath: paths.platePath,
    sequenceDir: paths.overlaySequenceDir,
    outputPath: paths.deliveryPath,
    expectedFrames,
  })
  const record = {
    plateSha256: rendererResult.outputSha256,
    overlayFingerprint: sequence.fingerprint,
    deliverySha256: composite.outputSha256,
    videoEncoder: composite.videoEncoder,
    frames: composite.frames,
    composedAt: new Date().toISOString(),
  }
  atomicWriteJson(paths.deliveryRecordPath, record)
  return { ...rendererResult, overlay: { ...record, sequenceDir: paths.overlaySequenceDir } }
}

function finishDeliveryRender(context, paths, state, nativeResult) {
  const deliverySha256 = hashFile(paths.deliveryPath)
  finishStage(state, 'delivery_render', {
    renderer: nativeResult.renderer,
    propsFingerprint: state.props.fingerprint,
    output: paths.deliveryPath,
    outputSha256: deliverySha256,
    outputBytes: statSync(paths.deliveryPath).size,
    nativeResult,
    ...(nativeResult.overlay ? { overlay: nativeResult.overlay } : {}),
  })
  state.deliveryRender = {
    path: paths.deliveryPath,
    propsSha256: state.props.fingerprint,
    sha256: deliverySha256,
    bytes: statSync(paths.deliveryPath).size,
    renderedAt: new Date().toISOString(),
    ...(nativeResult.overlay ? {
      overlay: {
        fingerprint: nativeResult.overlay.overlayFingerprint,
        frames: nativeResult.overlay.frames,
        plateSha256: nativeResult.overlay.plateSha256,
        composedAt: nativeResult.overlay.composedAt,
      },
    } : {}),
  }
  saveState(paths, state)
}

function recoverDelivery(context, paths) {
  const state = loadState(context, paths)
  if (!state.props || state.props.fingerprint !== hashFile(paths.propsPath)) fail('Props are missing or stale')
  const nativeResult = readValidDeliveryRenderResult(context, paths)
  if (!nativeResult) fail('No complete final delivery render can be recovered')
  if (!state.stages.delivery_render) startStage(state, 'delivery_render')
  finishDeliveryRender(context, paths, state, nativeResult)
  console.log(JSON.stringify({ recovered: true, delivery: paths.deliveryPath }, null, 2))
}

function renderDelivery(context, paths) {
  const state = loadState(context, paths)
  if (!state.props || state.props.fingerprint !== hashFile(paths.propsPath)) fail('Props are missing or stale')
  if (state.assetApproval?.fingerprint !== state.assetContactSheet?.fingerprint
    || !visualApprovalMatchesArtifact(
      state.assetApproval,
      state.assetContactSheet?.path,
      state.assetContactSheet?.artifactSha256,
      context.manifest.panels.length,
    )) {
    fail('Assets do not have valid visual review evidence')
  }
  const existing = readValidDeliveryRenderResult(context, paths)
  if (existing) {
    if (!state.stages.delivery_render) startStage(state, 'delivery_render')
    finishDeliveryRender(context, paths, state, existing)
    console.log(JSON.stringify({ recovered: true, delivery: paths.deliveryPath }, null, 2))
    return
  }
  if (existsSync(paths.deliveryPath)) fail(`Refusing to overwrite immutable delivery: ${paths.deliveryPath}`)
  const rendererPath = join(repoRoot, 'scripts/videoeditor/dharma_comic_native_renderer.mjs')
  if (!existsSync(rendererPath)) fail(`Native comic renderer is missing: ${rendererPath}`)
  const renderLock = acquireDharmaRenderLock({
    metadata: { runPath: paths.statePath, deliveryPath: paths.deliveryPath },
  })
  try {
    // Another run may have finished while this run waited for the global lock.
    const lockedExisting = readValidDeliveryRenderResult(context, paths)
    if (lockedExisting) {
      if (!state.stages.delivery_render) startStage(state, 'delivery_render')
      finishDeliveryRender(context, paths, state, lockedExisting)
      console.log(JSON.stringify({ recovered: true, delivery: paths.deliveryPath }, null, 2))
      return
    }
    startStage(state, 'delivery_render')
    saveState(paths, state)
    mkdirSync(dirname(paths.deliveryPath), { recursive: true })
    const props = readJson(paths.propsPath)
    let nativeResult
    const renderEnv = { ...process.env, DHARMA_RENDER_LOCK_HELD: '1' }
    if (props.textLayers !== 'overlay') {
      fail("Delivery rendering requires props.textLayers='overlay'")
    }
    // dharma-text-v5：plate 底片 + Remotion 文字叠加 + 合成（共用编排函数）。
    nativeResult = renderOverlayDelivery({ context, paths, props, env: renderEnv })
    finishDeliveryRender(context, paths, state, nativeResult)
    console.log(JSON.stringify({ delivery: paths.deliveryPath, renderer: nativeResult.renderer }, null, 2))
  } finally {
    releaseDharmaRenderLock(renderLock)
  }
}

async function publishEpisode(context, paths) {
  const state = loadState(context, paths)
  const facts = buildPipelineFacts(context, paths, state)
  if (!facts.deliveryVerified || !facts.verificationAttested
    || facts.deliverySha256 !== facts.verificationSha256) {
    fail('Episode publication requires a currently verified immutable delivery')
  }
  const videoUrl = deliveryVideoUrl(paths.deliveryPath)
  startStage(state, 'episode_publish')
  saveState(paths, state)
  await persistEpisodePublishingPackage({
    ...state,
    episodeId: context.manifest.episodeId,
  })
  await ensureEpisodeCovers({
    ...state,
    episodeId: context.manifest.episodeId,
  }, state, paths)
  const immutableIntent = {
    episodeId: Number(context.manifest.episodeId),
    videoUrl,
    deliverySha256: facts.deliverySha256,
    verificationSha256: facts.verificationSha256,
  }
  const previousIntent = state.episodePublicationIntent
  const intentMatches = previousIntent
    && Object.entries(immutableIntent).every(([key, value]) => previousIntent[key] === value)
  if (previousIntent && !intentMatches) fail('Episode publication intent conflicts with the verified delivery')
  const publishedAt = intentMatches
    ? String(previousIntent.recordedAt)
    : new Date().toISOString()
  state.episodePublicationIntent = {
    ...immutableIntent,
    recordedAt: publishedAt,
  }
  saveState(paths, state)

  const db = database(false)
  let committed
  try {
    committed = commitEpisodeDeliveryRecord(db, {
      ...state.episodePublicationIntent,
      runId: state.runId,
      propsSha256: state.props.fingerprint,
      publishedAt,
    })
  } finally {
    db.close()
  }
  const footage = await request(`/dharma/episode/${context.manifest.episodeId}/footage`)
  const readback = validateEpisodeFootageReadback(footage, {
    episodeId: context.manifest.episodeId,
    videoUrl,
  })
  state.episodePublication = {
    ...committed,
    deliverySha256: facts.deliverySha256,
    verificationSha256: facts.verificationSha256,
    propsSha256: state.props.fingerprint,
    apiReadback: readback,
  }
  delete state.episodePublicationIntent
  state.completedAt = new Date().toISOString()
  finishStage(state, 'episode_publish', state.episodePublication)
  saveState(paths, state)
  console.log(JSON.stringify(state.episodePublication, null, 2))
}

function verify(context, paths, suppliedState) {
  const state = suppliedState || loadState(context, paths)
  if (!existsSync(paths.deliveryPath)) fail(`Delivery does not exist: ${paths.deliveryPath}`)
  startStage(state, 'delivery_verify')
  saveState(paths, state)
  const probeScan = spawnSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', paths.deliveryPath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5 * 60_000 })
  let probe = { streams: [], format: {} }
  let probeToolError = probeScan.error?.message || null
  if (!probeToolError && probeScan.status === 0) {
    try {
      probe = JSON.parse(String(probeScan.stdout || '{}'))
    } catch (error) {
      probeToolError = `Cannot parse ffprobe output: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const props = readJson(paths.propsPath)
  const expectedFrames = Number(props.durationInFrames)
  const expectedFps = Number(props.fps || context.manifest.fps || 30)
  const qualityScan = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', paths.deliveryPath,
    '-map', '0:v:0',
    '-vf', 'blackdetect=d=0.12:pix_th=0.06', '-an', '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 2 * 60 * 60_000 })
  const blackScanLog = String(qualityScan.stderr || '')
  const decodedFrames = parseProgressFrameCount(qualityScan.stdout)
  const syncCheck = spawnSync('node', [
    join(repoRoot, 'scripts/videoeditor/check_dharma_sync.mjs'),
    String(context.manifest.episodeId), paths.propsPath,
    `--titles=${state.tts.titlesPath}`,
  ], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5 * 60_000 })
  let integratedLufs = Number.NaN
  let loudnessError = null
  try {
    integratedLufs = measureLoudness(paths.deliveryPath)
  } catch (error) {
    loudnessError = error instanceof Error ? error.message : String(error)
  }
  const report = assessDeliveryQuality({
    probe,
    probeStatus: probeScan.status,
    probeToolError,
    expectedFrames,
    expectedFps,
    decodeStatus: qualityScan.status,
    decodeToolError: qualityScan.error?.message || null,
    decodedFrames,
    blackScanLog,
    integratedLufs,
    loudnessError,
    syncStatus: syncCheck.status,
    syncToolError: syncCheck.error?.message || null,
  })
  report.output = paths.deliveryPath
  report.sha256 = hashFile(paths.deliveryPath)
  report.propsSha256 = hashFile(paths.propsPath)
  report.deliveryRenderSha256 = state.deliveryRender?.sha256 || null
  report.assetSheetSha256 = state.assetApproval?.artifactSha256 || null
  report.ttsAudioSha256 = state.tts?.audioSha256 || null
  report.ttsTitlesSha256 = state.tts?.titlesSha256 || null
  report.attempt = Number(state.verificationReport?.attempt || 0) + 1
  report.generatedAt = new Date().toISOString()
  report.syncOutput = String(syncCheck.stdout || '').trim().slice(-1200)
  if (syncCheck.status !== 0) report.syncError = String(syncCheck.stderr || '').trim().slice(-1200)
  if (state.verificationReport) {
    state.verificationHistory ||= []
    state.verificationHistory.push(state.verificationReport)
  }
  state.verificationReport = report
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video') || {}
  const durationSec = Number(probe.format?.duration)
  const videoBitrate = Number(video.bit_rate || 0)
  finishStage(state, 'delivery_verify', {
    passed: report.passed,
    durationSec,
    bytes: statSync(paths.deliveryPath).size,
    videoBitrate,
    integratedLufs: report.metrics.integratedLufs,
    decodedFrames: report.metrics.decodedFrames,
    blackFrameCandidates: report.metrics.blackFrameCandidates,
    blockingErrors: report.blockingErrors,
    warnings: report.warnings,
  })
  if (report.passed) state.deliveryVerifiedAt = new Date().toISOString()
  saveState(paths, state)
  if (!report.passed) {
    console.error(JSON.stringify(report, null, 2))
    return report
  }
  console.log(JSON.stringify({
    output: paths.deliveryPath,
    durationSec,
    bytes: statSync(paths.deliveryPath).size,
    videoBitrate,
    integratedLufs: report.metrics.integratedLufs,
    decodedFrames: report.metrics.decodedFrames,
    blackFrameCandidates: report.metrics.blackFrameCandidates,
    warnings: report.warnings,
  }, null, 2))
}

function stageAccounting(state) {
  if (!state) return null
  const jobList = state.jobs || []
  const jobs = Object.fromEntries([...new Set(jobList.map((job) => job.status))]
    .map((status) => [status, jobList.filter((job) => job.status === status).length]))
  const stageNames = new Set([...Object.keys(state.stageHistory || {}), ...Object.keys(state.stages || {})])
  const stages = Object.fromEntries([...stageNames].map((name) => {
    const runs = [...(state.stageHistory?.[name] || []), ...(state.stages?.[name] ? [state.stages[name]] : [])]
    const elapsedMs = runs.reduce((sum, run) => sum + Number(run.elapsedMs || 0), 0)
    return [name, {
      runs: runs.length,
      elapsedSec: Math.round(elapsedMs / 100) / 10,
      active: runs.some((run) => !run.completedAt && !run.abandonedAt),
      completedAt: runs.at(-1)?.completedAt || null,
    }]
  }))
  const elapsedEndMs = state.completedAt ? new Date(state.completedAt).getTime() : Date.now()
  const elapsedSec = Math.round((elapsedEndMs - new Date(state.startedAt).getTime()) / 100) / 10
  const machineStageSec = Math.round(Object.values(stages).reduce((sum, stage) => sum + stage.elapsedSec, 0) * 10) / 10
  return {
    jobs,
    stages,
    wallElapsedSec: elapsedSec,
    machineStageSec,
    completedAt: state.completedAt || null,
  }
}

function buildPipelineFacts(context, paths, state) {
  const facts = {
    manifestHash: context.manifestHash,
    statePath: paths.statePath,
    deliveryPath: paths.deliveryPath,
  }
  if (!state || state.jobs.some((job) => !job.localPath)) return facts
  try {
    const resolved = resolvedPanelAssets(context.manifest, state)
    facts.assetsValid = true
    facts.assetFingerprint = resolved.fingerprint
    facts.assetContactSheetCurrent = Boolean(
      state.assetContactSheet
      && state.assetContactSheet.fingerprint === resolved.fingerprint
      && existsSync(state.assetContactSheet.path)
      && existsSync(state.assetContactSheet.indexPath)
      && state.assetContactSheet.artifactSha256 === hashFile(state.assetContactSheet.path)
      && state.assetContactSheet.indexSha256 === hashFile(state.assetContactSheet.indexPath),
    )
    facts.assetApprovalCurrent = Boolean(
      facts.assetContactSheetCurrent
      && state.assetApproval?.fingerprint === resolved.fingerprint
      && visualApprovalMatchesArtifact(
        state.assetApproval,
        state.assetContactSheet.path,
        state.assetContactSheet.artifactSha256,
        resolved.assets.length,
      ),
    )
    if (facts.assetContactSheetCurrent) {
      facts.assetSheetPath = state.assetContactSheet.path
      facts.assetSheetSha256 = state.assetContactSheet.artifactSha256
      facts.assetReviewCount = resolved.assets.length
      facts.assetReviewEscalated = Boolean(
        state.assetReviewEscalation?.fingerprint === resolved.fingerprint
        && reviewEscalationMatchesArtifact(
          state.assetReviewEscalation,
          state.assetContactSheet.path,
          state.assetContactSheet.artifactSha256,
        ),
      )
    }
  } catch (error) {
    facts.assetsValid = false
    facts.artifactError = error instanceof Error ? error.message : String(error)
    return facts
  }

  facts.propsCurrent = Boolean(
    state.props
    && existsSync(paths.propsPath)
    && state.props.fingerprint === hashFile(paths.propsPath)
    && state.props.textLayers === 'overlay'
    && existsSync(paths.overlayPropsPath)
    && state.props.overlayPropsSha256 === hashFile(paths.overlayPropsPath),
  )
  facts.deliveryExists = existsSync(paths.deliveryPath)
  if (facts.deliveryExists) facts.deliverySha256 = hashFile(paths.deliveryPath)
  const deliveryRenderResult = facts.propsCurrent
    ? readValidDeliveryRenderResult(context, paths)
    : null
  facts.deliveryRenderSha256 = deliveryRenderResult?.overlay?.deliverySha256 || null
  const deliveryRenderStage = state.stages?.delivery_render
  facts.deliveryRenderCurrent = Boolean(
    deliveryRenderResult
    && facts.deliveryExists
    && state.deliveryRender?.path === paths.deliveryPath
    && state.deliveryRender?.propsSha256 === state.props.fingerprint
    && state.deliveryRender?.sha256 === facts.deliverySha256
    && deliveryRenderStage?.completedAt
    && deliveryRenderStage.propsFingerprint === state.props.fingerprint
    && deliveryRenderStage.output === paths.deliveryPath
    && deliveryRenderStage.outputSha256 === facts.deliverySha256,
  )
  facts.deliveryRenderRecoverable = Boolean(deliveryRenderResult && !facts.deliveryRenderCurrent)
  facts.deliveryOwned = facts.deliveryRenderCurrent
  facts.verificationSha256 = state.verificationReport?.sha256 || null
  facts.verificationAttested = Boolean(
    state.verificationReport?.passed === true
    && state.verificationReport?.propsSha256 === state.props?.fingerprint
    && state.verificationReport?.deliveryRenderSha256 === state.deliveryRender?.sha256
    && state.verificationReport?.deliveryRenderSha256 === facts.deliverySha256
    && state.verificationReport?.assetSheetSha256 === state.assetApproval?.artifactSha256
    && state.verificationReport?.ttsAudioSha256 === state.tts?.audioSha256
    && state.verificationReport?.ttsTitlesSha256 === state.tts?.titlesSha256,
  )
  facts.deliveryVerified = Boolean(
    facts.deliveryOwned
    && facts.verificationAttested
    && state.verificationReport?.passed === true
    && state.verificationReport.output === paths.deliveryPath
    && state.verificationReport.sha256 === facts.deliverySha256,
  )
  facts.expectedEpisodeVideoUrl = deliveryVideoUrl(paths.deliveryPath)
  facts.episodeVideoUrl = readEpisodeVideoUrl(context.manifest.episodeId)
  const publishingFacts = readEpisodePublishingFacts(
    context.manifest.episodeId,
    state.publishingPackageSha256 || '',
  )
  facts.publishingPackageGateEnabled = true
  facts.publishingPackageCurrent = publishingFacts.publishingPackageCurrent
  facts.openingHookPresent = Boolean(publishingFacts.openingHook)
  facts.cliffhangerPresent = Boolean(publishingFacts.cliffhanger)
  facts.cover4x3Ready = Boolean(publishingFacts.cover4x3Url)
  facts.cover3x4Ready = Boolean(publishingFacts.cover3x4Url)
  facts.episodePublishedCurrent = Boolean(
    facts.deliveryVerified
    && facts.publishingPackageCurrent
    && facts.cover4x3Ready
    && facts.cover3x4Ready
    && facts.episodeVideoUrl === facts.expectedEpisodeVideoUrl
    && state.episodePublication?.episodeId === Number(context.manifest.episodeId)
    && state.episodePublication?.videoUrl === facts.expectedEpisodeVideoUrl
    && state.episodePublication?.deliverySha256 === facts.deliverySha256
    && state.episodePublication?.verificationSha256 === facts.verificationSha256
    && state.episodePublication?.apiReadback?.videoUrl === facts.expectedEpisodeVideoUrl,
  )
  return facts
}

function runManifestContext(runPath) {
  const run = loadRun(runPath).state
  if (!run.manifestPath || !run.manifestHash) fail('Run has no frozen manifest')
  const raw = readFileSync(run.manifestPath, 'utf8')
  const manifestHash = hash(raw)
  if (manifestHash !== run.manifestHash) fail('Frozen manifest hash changed')
  const manifest = JSON.parse(raw)
  const plan = loadFrozenManifestPlan(run)
  requirePassed(validateManifest(manifest, {
    resolveReferenceImage: resolveDataPath,
    expectedEpisodeId: run.episodeId,
    expectedDramaId: run.dramaId,
    expectedConfigId: run.imageConfigId,
    expectedTargetDurationSec: run.targetDurationSec,
    expectedDeliveryOutput: run.deliveryOutput,
    expectedBeats: plan.beats,
  }))
  const context = { manifest, manifestPath: run.manifestPath, manifestHash }
  const paths = derivedPaths(manifest, manifestHash, { state: runPath })
  return { run, context, paths }
}

function withRunChecks(result, runPath, run) {
  const enriched = {
    ...result,
    checks: {
      ...result.checks,
      run_path: runPath,
      workflow: run.workflow,
      script_path: run.scriptPath,
      accounting: stageAccounting(run),
    },
  }
  if (result.status === 'complete') {
    enriched.verificationReport = run.verificationReport
    enriched.delivery = {
      path: run.deliveryRender?.path || null,
      sha256: run.deliveryRender?.sha256 || null,
      bytes: run.deliveryRender?.bytes || null,
    }
    enriched.artifactChain = {
      ...(run.artifactChain || {}),
      assetSheetSha256: run.assetApproval?.artifactSha256 || null,
      propsSha256: run.props?.fingerprint || null,
      deliveryRenderSha256: run.deliveryRender?.sha256 || null,
      deliverySha256: run.deliveryRender?.sha256 || null,
      verificationSha256: run.verificationReport?.sha256 || null,
      episodeVideoUrl: run.episodePublication?.videoUrl || null,
    }
  }
  return enriched
}

function currentRunStatus(runPath) {
  const run = loadRun(runPath).state
  if (!existsSync(run.scriptPath) || hashFile(run.scriptPath) !== run.scriptHash) {
    return withRunChecks(statusResult(
      'intake',
      'failed',
      { script_hash_matches: false },
      'SCRIPT_CHANGED',
      'start-new-run',
    ), runPath, run)
  }
  if (run.actionFailure) {
    const recovery = actionFailureRecovery(run.actionFailure, run.actionFailureHistory)
    const retryAvailable = recovery.nextAction !== null
    return withRunChecks(statusResult(
      run.actionFailure.stage,
      'failed',
      {
        failed_action: run.actionFailure.action,
        errors: run.actionFailure.errors,
        failed_at: run.actionFailure.failedAt,
        repair_count: recovery.repairCount,
        repair_limit: recovery.repairLimit,
        retry_available: retryAvailable,
      },
      run.actionFailure.errorCode,
      recovery.nextAction,
    ), runPath, run)
  }
  if (!run.environmentReport) {
    return withRunChecks(statusResult(
      'environment_check', 'ready', {}, 'ENVIRONMENT_CHECK_REQUIRED', 'check-environment',
    ), runPath, run)
  }
  if (!run.environmentReport.passed) {
    return withRunChecks(statusResult(
      'environment_check',
      'failed',
      run.environmentReport.checks,
      run.environmentReport.error_code,
      'retry-stage',
    ), runPath, run)
  }
  if (!run.dramaId || !run.episodeId || !run.episodeReport) {
    return withRunChecks(statusResult(
      'episode_create', 'ready', {}, 'EPISODE_CREATE_REQUIRED', 'create-episode',
    ), runPath, run)
  }
  const ownership = validateEpisodeOwnership({ run, ...episodeOwnershipFacts(run) })
  if (!ownership.passed) {
    return withRunChecks(statusResult(
      'episode_create', 'failed', ownership.checks, ownership.error_code, 'retry-stage',
    ), runPath, run)
  }

  if (!run.ttsTaskId) {
    return withRunChecks(statusResult(
      'tts_wait', 'ready', { task_id: null }, 'TTS_TASK_CREATE_REQUIRED', 'create-tts-task',
    ), runPath, run)
  }
  const task = ttsTaskById(run.ttsTaskId)
  if (!task) {
    return withRunChecks(statusResult(
      'tts_wait',
      'failed',
      { errors: [`Pinned TTS task ${run.ttsTaskId} does not exist`] },
      'TTS_TASK_FAILED',
      'start-new-run',
    ), runPath, run)
  }
  if (task.type !== 'tts.pre_generate' || Number(task.episode_id) !== Number(run.episodeId)) {
    return withRunChecks(statusResult(
      'tts_wait', 'failed', { task, errors: ['Pinned task identity does not match this run'] }, 'TTS_TASK_FAILED', 'start-new-run',
    ), runPath, run)
  }
  if (['queued', 'running'].includes(task.status)) {
    return withRunChecks(statusResult(
      'tts_wait',
      'running',
      { task },
      'TTS_TASK_ACTIVE',
      'wait-tts',
    ), runPath, run)
  }
  if (task.status !== 'succeeded') {
    const repairCount = (run.stageRetryHistory || [])
      .filter((entry) => entry.stage === 'tts_wait')
      .length
    const recovery = ttsFailureRecovery({
      taskStatus: task.status,
      machineRetryCount: run.ttsMachineRetryCount,
      repairCount,
    })
    return withRunChecks(statusResult(
      'tts_wait',
      recovery.status,
      {
        task,
        machine_retry_count: Number(run.ttsMachineRetryCount || 0),
        machine_retry_limit: defaultTtsMachineRetryLimit,
        repair_count: repairCount,
        repair_limit: defaultTtsRepairLimit,
        errors: [task.error_message || `TTS task ended as ${task.status}`],
      },
      'TTS_TASK_FAILED',
      recovery.nextAction,
    ), runPath, run)
  }
  const frozenTts = validateFrozenTtsArtifacts(run.tts)
  if (run.tts?.taskId && Number(run.tts.taskId) !== Number(task.id)) {
    frozenTts.passed = false
    frozenTts.errors.push('Frozen TTS artifact task id differs from the pinned task')
  }
  if (!run.ttsTimelineReport || !run.ttsCloneReport || !frozenTts.passed) {
    return withRunChecks(statusResult(
      'tts_verify', 'ready', { task_id: task.id, frozen_tts_errors: frozenTts.errors }, 'TTS_VERIFICATION_REQUIRED', 'verify-tts',
    ), runPath, run)
  }
  if (!run.ttsCloneReport.passed) {
    return withRunChecks(statusResult(
      'tts_verify', 'failed', run.ttsCloneReport.checks, run.ttsCloneReport.error_code, 'retry-stage',
    ), runPath, run)
  }
  if (!run.ttsTimelineReport.passed) {
    return withRunChecks(statusResult(
      'tts_verify', 'failed', run.ttsTimelineReport.checks, run.ttsTimelineReport.error_code, 'retry-stage',
    ), runPath, run)
  }
  if (!run.manifestPlan
    || run.manifestPlan.path !== run.manifestDraftPath
    || run.manifestPlan.outputPath !== run.manifestOutputPath) {
    return withRunChecks(statusResult(
      'manifest_plan', 'ready', {}, 'MANIFEST_PLAN_REQUIRED', 'prepare-manifest',
    ), runPath, run)
  }
  if (!run.manifestHash) {
    if (!existsSync(run.manifestOutputPath)) {
      return withRunChecks(statusResult(
        'manifest_plan',
        'blocked',
        { draft_path: run.manifestDraftPath, output_path: run.manifestOutputPath },
        'MANIFEST_CREATION_REQUIRED',
        `complete-manifest --draft ${run.manifestDraftPath} --output ${run.manifestOutputPath}`,
      ), runPath, run)
    }
    const validation = manifestValidationForRun(run)
    if (!validation.passed) {
      if (run.assetReuse?.mode === 'tts-only') {
        return withRunChecks(statusResult(
          'manifest_plan',
          'ready',
          { ...validation.checks, manifest_path: run.manifestOutputPath, rebuild: true },
          'MANIFEST_REBUILD_REQUIRED',
          'prepare-manifest',
        ), runPath, run)
      }
      return withRunChecks(statusResult(
        'manifest_validate',
        'blocked',
        { ...validation.checks, manifest_path: run.manifestOutputPath },
        validation.error_code,
        `repair-manifest --path ${run.manifestOutputPath}`,
      ), runPath, run)
    }
    return withRunChecks(statusResult(
      'manifest_validate',
      'ready',
      { manifest_path: run.manifestOutputPath, validation: validation.checks },
      'MANIFEST_ATTACH_REQUIRED',
      `attach-manifest --manifest ${run.manifestOutputPath}`,
    ), runPath, run)
  }
  if (!existsSync(run.manifestPath) || hashFile(run.manifestPath) !== run.manifestHash) {
    return withRunChecks(statusResult(
      'manifest_validate',
      'failed',
      { manifest_hash_matches: false },
      'MANIFEST_CHANGED',
      'start-new-run',
    ), runPath, run)
  }
  const { context, paths } = runManifestContext(runPath)
  return withRunChecks(currentPipelineStatus(context, paths), runPath, run)
}

const actionFailureCodes = Object.freeze({
  'check-environment': 'ENVIRONMENT_INVALID',
  'create-episode': 'EPISODE_CREATE_FAILED',
  'wait-tts': 'TTS_TASK_FAILED',
  'create-tts-task': 'TTS_TASK_FAILED',
  'retry-tts-task': 'TTS_TASK_FAILED',
  'verify-tts': 'TTS_TIMELINE_MISMATCH',
  'prepare-manifest': 'MANIFEST_PLAN_FAILED',
  'attach-manifest': 'MANIFEST_INVALID',
  init: 'MANIFEST_INVALID',
  submit: 'IMAGE_SUBMISSION_FAILED',
  wait: 'IMAGE_TASK_FAILED',
  'retry-failed': 'IMAGE_TASK_FAILED',
  'contact-sheet': 'ASSET_CONTACT_SHEET_FAILED',
  'build-props': 'PROPS_BUILD_FAILED',
  'render-delivery': 'RENDER_FAILED',
  'recover-delivery': 'NATIVE_RESULT_INVALID',
  'publish-episode': 'EPISODE_PUBLISH_FAILED',
  verify: 'DELIVERY_VERIFICATION_FAILED',
})

function recordActionFailure(runPath, status, action, error) {
  const run = loadRun(runPath).state
  const errorCode = error?.errorCode || actionFailureCodes[action] || 'ORCHESTRATION_FAILED'
  run.actionFailure = {
    stage: status.stage,
    action,
    errorCode,
    errors: error?.validationReport?.checks?.errors
      || [error instanceof Error ? error.message : String(error)],
    failedAt: new Date().toISOString(),
  }
  saveRun(runPath, run)
}

function retryRecordedAction(runPath, options) {
  const status = currentRunStatus(runPath)
  if (status.status !== 'failed' || status.next_action !== 'retry-action') {
    fail('Current action failure has no remaining repair budget')
  }
  const run = loadRun(runPath).state
  if (!run.actionFailure) fail('No recorded action failure exists')
  run.actionFailureHistory ||= []
  run.actionFailureHistory.push({
    ...run.actionFailure,
    retryActor: requireTextOption(options, 'actor'),
    retryReason: requireTextOption(options, 'reason', 8),
    retryRecordedAt: new Date().toISOString(),
  })
  delete run.actionFailure
  saveRun(runPath, run)
}

function retryFailedStage(runPath, options) {
  const status = currentRunStatus(runPath)
  if (status.status !== 'failed' || status.next_action !== 'retry-stage') {
    fail('Current run is not waiting for an explicit stage retry')
  }
  const run = loadRun(runPath).state
  run.stageRetryHistory ||= []
  run.stageRetryHistory.push({
    stage: status.stage,
    errorCode: status.error_code,
    actor: requireTextOption(options, 'actor'),
    reason: requireTextOption(options, 'reason', 8),
    recordedAt: new Date().toISOString(),
  })
  if (status.stage === 'environment_check') delete run.environmentReport
  else if (status.stage === 'episode_create') delete run.episodeReport
  else if (status.stage === 'tts_wait') run.ttsMachineRetryCount = 0
  else if (status.stage === 'tts_verify') {
    delete run.ttsTimelineReport
    delete run.ttsCloneReport
  } else {
    fail(`Stage ${status.stage} has no explicit retry implementation`)
  }
  saveRun(runPath, run)
}

function repairDeliveryVerification(runPath, options) {
  const status = currentRunStatus(runPath)
  if (status.status !== 'failed' || status.next_action !== 'repair-delivery') {
    fail('Current run is not waiting for delivery verifier repair')
  }
  const run = loadRun(runPath).state
  if (!run.verificationReport || run.verificationReport.passed !== false) {
    fail('Failed delivery verification report is missing')
  }
  run.verificationRepairHistory ||= []
  run.verificationRepairHistory.push({
    deliverySha256: run.verificationReport.sha256 || null,
    verificationAttempt: Number(run.verificationReport.attempt || 0),
    errorCodes: (run.verificationReport.blockingErrors || []).map((error) => error.code),
    actor: requireTextOption(options, 'actor'),
    reason: requireTextOption(options, 'reason', 8),
    recordedAt: new Date().toISOString(),
  })
  run.verificationHistory ||= []
  run.verificationHistory.push(run.verificationReport)
  delete run.verificationReport
  delete run.completedAt
  saveRun(runPath, run)
}

async function executeRunMachineAction(runPath, status) {
  if (status.action_kind !== 'machine' || status.status === 'failed') {
    fail(`Cannot execute ${status.next_action || 'terminal'} from ${status.status}`)
  }
  const [action, ...args] = String(status.next_action || '').split(' ')
  if (action === 'check-environment') await checkEnvironment(runPath)
  else if (action === 'create-episode') await createEpisodeForRun(runPath)
  else if (action === 'create-tts-task') await createMissingTtsTask(runPath)
  else if (action === 'wait-tts') pollTts(runPath)
  else if (action === 'retry-tts-task') retryTtsTask(runPath)
  else if (action === 'verify-tts') verifyTtsForRun(runPath)
  else if (action === 'prepare-manifest') prepareManifestPlan(runPath)
  else if (action === 'attach-manifest') {
    const manifestIndex = args.indexOf('--manifest')
    attachManifest(runPath, manifestIndex >= 0 ? args[manifestIndex + 1] : null)
  } else if (executionSurface(status.next_action) === 'artifact-pipeline') {
    const { context, paths } = runManifestContext(runPath)
    await executePipelineMachineAction(status, context, paths)
  } else {
    fail(`Runner lifecycle action has no implementation: ${status.next_action}`)
  }
}

async function advanceRun(runPath) {
  const status = currentRunStatus(runPath)
  if (status.status === 'failed' || status.action_kind !== 'machine') {
    console.log(JSON.stringify(status, null, 2))
    return status
  }
  try {
    await executeRunMachineAction(runPath, status)
  } catch (error) {
    recordActionFailure(runPath, status, String(status.next_action).split(' ')[0], error)
  }
  const result = currentRunStatus(runPath)
  console.log(JSON.stringify(result, null, 2))
  return result
}

async function runUntilGate(runPath, options = {}) {
  const maxRuntimeMs = Number(options.max_runtime_ms || process.env.DHARMA_RUN_MAX_MS || defaultMachineLoopMs)
  const pollIntervalMs = Number(options.poll_interval_ms || process.env.DHARMA_POLL_INTERVAL_MS || defaultPollIntervalMs)
  try {
    return await driveUntilBoundary({
      maxRuntimeMs,
      pollIntervalMs,
      getStatus: async () => currentRunStatus(runPath),
      executeMachineAction: async (status) => {
        if (options.lease) heartbeatRunLease(options.lease)
        try {
          await executeRunMachineAction(runPath, status)
        } catch (error) {
          recordActionFailure(runPath, status, String(status.next_action).split(' ')[0], error)
        } finally {
          if (options.lease) heartbeatRunLease(options.lease)
        }
      },
    })
  } catch (error) {
    const status = currentRunStatus(runPath)
    if (status.status !== 'failed') {
      recordActionFailure(runPath, status, String(status.next_action || 'orchestration').split(' ')[0], error)
    }
    return currentRunStatus(runPath)
  }
}

function currentPipelineStatus(context, paths) {
  const state = existsSync(paths.statePath) ? loadState(context, paths) : null
  const facts = buildPipelineFacts(context, paths, state)
  const result = deriveNextAction(context.manifest, state, facts)
  result.checks = {
    ...result.checks,
    state_path: paths.statePath,
    delivery_path: paths.deliveryPath,
    accounting: stageAccounting(state),
  }
  return result
}

function printStatus(context, paths) {
  console.log(JSON.stringify(currentPipelineStatus(context, paths), null, 2))
}

async function executePipelineMachineAction(status, context, paths) {
  if (status.action_kind !== 'machine' || status.status === 'failed') {
    fail(`Cannot execute ${status.next_action || 'terminal'} from ${status.status}`)
  }
  const [action, ...args] = String(status.next_action || '').split(' ')
  if (action === 'init') loadState(context, paths, true)
  else if (action === 'submit') await submitReady(context, paths)
  else if (action === 'wait') await waitForSubmitted(context, paths)
  else if (action === 'retry-failed') {
    const keyIndex = args.indexOf('--key')
    if (keyIndex < 0 || !args[keyIndex + 1]) fail('Derived retry action has no panel key')
    await retryFailed(context, paths, args[keyIndex + 1])
  }
  else if (action === 'contact-sheet') contactSheet(context, paths)
  else if (action === 'build-props') await buildProps(context, paths)
  else if (action === 'render-delivery') renderDelivery(context, paths)
  else if (action === 'recover-delivery') recoverDelivery(context, paths)
  else if (action === 'verify') verify(context, paths)
  else if (action === 'publish-episode') await publishEpisode(context, paths)
  else fail(`advance cannot execute derived action: ${status.next_action}`)
}

async function advance(context, paths) {
  const status = currentPipelineStatus(context, paths)
  if (status.status === 'failed' || status.action_kind !== 'machine') {
    console.log(JSON.stringify(status, null, 2))
    return status
  }
  await executePipelineMachineAction(status, context, paths)
  printStatus(context, paths)
}

function usage() {
  console.log(`Usage:
  dharma_comic_pipeline.mjs run --script <final.md> --publishing-package <package.json> [--title <title>] [--voice-id <voice-id>] [--narration-speed <0.8-2.5>] [--run <state.json>]
  dharma_comic_pipeline.mjs run --run <state.json> --publishing-package <package.json>
  dharma_comic_pipeline.mjs start --script <final.md> --publishing-package <package.json> [--title <title>] [--voice-id <voice-id>] [--narration-speed <0.8-2.5>] [--run <state.json>]
  dharma_comic_pipeline.mjs next --run <state.json>
  dharma_comic_pipeline.mjs advance --run <state.json>
  dharma_comic_pipeline.mjs reject-asset --run <state.json> --key <panel-key> --actor <name> --reason <reason>
  dharma_comic_pipeline.mjs approve-assets --run <state.json> --sheet-sha256 <sha256> --actor <agent|user> --review-tool <view_image|native_image_read|human> --reviewed-count <count> --reason <visible evidence>
  dharma_comic_pipeline.mjs escalate-assets --run <state.json> --sheet-sha256 <sha256> --actor agent --review-tool <view_image|native_image_read> --reason <specific ambiguity>
  dharma_comic_pipeline.mjs retry-action --run <state.json> --actor <name> --reason <repair evidence>
  dharma_comic_pipeline.mjs retry-stage --run <state.json> --actor <name> --reason <repair evidence>
  dharma_comic_pipeline.mjs repair-delivery --run <state.json> --actor <name> --reason <verifier repair evidence>
  dharma_comic_pipeline.mjs start-new-run --run <state.json> --actor <name> --reason <revision reason> [--voice-id <voice-id>] [--reuse-assets-from <source-run.json>]

Validator compatibility:
  dharma_comic_pipeline.mjs validate --manifest <file>`)
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv)
  if (!command || command === 'help') {
    usage()
    process.exitCode = command ? 0 : 1
    return
  }

  if (command === 'start') {
    const started = startRun(options, false)
    console.log(JSON.stringify(currentRunStatus(started.runPath), null, 2))
    return
  }

  if (command === 'run' || command === 'resume') {
    const started = options.script ? startRun(options, true) : loadOrAttachRun(options, true)
    const lease = acquireRunLease(started.runPath)
    try {
      const result = await runUntilGate(started.runPath, { ...options, lease })
      emitWorkflowStatus(result)
    } finally {
      releaseRunLease(lease)
    }
    return
  }

  if (options.run) {
    const { runPath } = command === 'start-new-run'
      ? loadRun(options.run)
      : loadOrAttachRun(options, false)
    if (command === 'next' || command === 'status') {
      console.log(JSON.stringify(currentRunStatus(runPath), null, 2))
      return
    }
    const lease = acquireRunLease(runPath)
    try {
      if (command === 'advance') await advanceRun(runPath)
      else if (command === 'retry-action') {
        retryRecordedAction(runPath, options)
        emitWorkflowStatus(currentRunStatus(runPath))
      } else if (command === 'retry-stage') {
        retryFailedStage(runPath, options)
        emitWorkflowStatus(currentRunStatus(runPath))
      } else if (command === 'repair-delivery') {
        repairDeliveryVerification(runPath, options)
        emitWorkflowStatus(currentRunStatus(runPath))
      } else if (command === 'attach-manifest') {
        attachManifest(runPath, options.manifest)
        emitWorkflowStatus(currentRunStatus(runPath))
      } else if (command === 'start-new-run') {
        const revision = createRevisionRun(runPath, options)
        const revisionStatus = currentRunStatus(revision.runPath)
        emitWorkflowStatus({
          ...revisionStatus,
          checks: {
            ...revisionStatus.checks,
            revision_of_run_path: runPath,
          },
        })
      } else {
        const { context, paths } = runManifestContext(runPath)
        if (command === 'reject-asset') {
          if (options.keys.length !== 1) fail('reject-asset requires exactly one --key <panel-key>')
          rejectAsset(context, paths, options.keys[0], options)
        } else if (command === 'approve-assets') approveAssets(context, paths, options)
        else if (command === 'escalate-assets') escalateAssets(context, paths, options)
        else fail(`Command ${command} is not available through --run; use run/next`)
        emitWorkflowStatus(await runUntilGate(runPath, { ...options, lease }))
      }
    } finally {
      releaseRunLease(lease)
    }
    return
  }

  const context = loadManifest(options.manifest)
  const paths = derivedPaths(context.manifest, context.manifestHash, options)

  if (command === 'validate') console.log(JSON.stringify({ ok: true, panels: context.manifest.panels.length, manifestHash: context.manifestHash }, null, 2))
  else if (command === 'next' || command === 'status') printStatus(context, paths)
  else if (command === 'advance') await advance(context, paths)
  else if (command === 'init') {
    const state = loadState(context, paths, true)
    console.log(JSON.stringify({ statePath: paths.statePath, jobs: state.jobs.length }, null, 2))
  } else if (command === 'submit') await submitReady(context, paths, options.keys)
  else if (command === 'wait') await waitForSubmitted(context, paths, options.until === 'one')
  else if (command === 'reject-asset') {
    if (options.keys.length !== 1) fail('reject-asset requires exactly one --key <panel-key>')
    rejectAsset(context, paths, options.keys[0], options)
  }
  else if (command === 'retry-failed') {
    if (options.keys.length !== 1) fail('retry-failed requires exactly one --key <panel-key>')
    await retryFailed(context, paths, options.keys[0])
  } else if (command === 'contact-sheet') contactSheet(context, paths)
  else if (command === 'approve-assets') approveAssets(context, paths, options)
  else if (command === 'escalate-assets') escalateAssets(context, paths, options)
  else if (command === 'build-props') await buildProps(context, paths)
  else if (command === 'render-delivery') renderDelivery(context, paths)
  else if (command === 'recover-delivery') recoverDelivery(context, paths)
  else if (command === 'publish-episode') await publishEpisode(context, paths)
  else if (command === 'verify') verify(context, paths)
  else fail(`Unknown command: ${command}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
