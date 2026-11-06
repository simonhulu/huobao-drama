#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
  extractFfmpegWarnings,
  manifestFactory,
  minHistoryBgmSec,
  parseBlackIntervals,
  parseProgressFrameCount,
  storyboardIdFromPanelKey,
  validateEnvironment,
  validateEpisodeSnapshot,
  validateManifest,
  validateNarrativePlan,
  validateNativeResult,
  validatePanelAssets,
  validateTtsTimeline,
  validateVisualApproval,
} from './history_comic_validator.mjs'
import { addFailureLesson } from './history_comic_lessons.mjs'
import {
  overlayFingerprint,
  readOverlayCompositeEvidence,
  renderDirectTextOverlay,
} from '../../remotion-dharma-factory/scripts/dharma_text_overlay_stage.mjs'
import { buildOverlayProps } from '../../remotion-dharma-factory/scripts/dharma_comic_pipeline.mjs'
import {
  normalizePublishingPackage,
  publishingPackageFingerprint,
} from '../../remotion-dharma-factory/scripts/dharma_publishing_package.mjs'
import {
  TEXT_PRESENTATION_VERSION,
  computeSubtitleDisplayWindows,
} from '../../../../scripts/videoeditor/dharma_comic_native_core.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../../../..')
const requireFromBackend = createRequire(join(repoRoot, 'backend/package.json'))
const Database = requireFromBackend('better-sqlite3')

const apiBase = process.env.HUOBAO_API_URL || 'http://127.0.0.1:5679/api/v1'
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled', 'stale'])
const activeTaskStatuses = new Set(['queued', 'running'])
const currentRunVersion = 1
// Runner behavior release, stamped into every run file this runner writes
// (runnerRelease). A runner refuses to mutate or migrate a run file last
// written by a NEWER release: that state may carry semantics this binary does
// not understand. Real incident: a stale runner met the unknown
// auto-approve-assets action mid-production and recorded it as an action
// failure, polluting the repair budget. Version mismatches now fail before
// any state or budget write with RUNNER_VERSION_MISMATCH. Bump on every
// runner behavior change.
export const currentRunnerRelease = 8
const currentPlanVersion = 'history-comic-plan-v1'
const defaultRunLeaseMs = 60_000
const defaultMachineLoopMs = Number.POSITIVE_INFINITY
const defaultPollIntervalMs = 5_000
const defaultTaskPollTimeoutMs = 15_000
const defaultTaskPollTransientErrorLimit = 12
const defaultVerifyStageRetryLimit = 2
const defaultVerificationTransientRetryLimit = 3
const defaultVerificationRepairLimit = 2
const defaultActionRepairLimit = 2
const defaultGridTaskRequeueLimit = 1
const defaultCoverWaitTimeoutMs = 15 * 60 * 1000
const defaultCoverPollIntervalMs = 5_000
// 每个 storyboard 的画格重生预算：首次生成 + 3 次重生（与审查退回共享）。
const defaultStoryboardRegenAttemptLimit = 4
export const budgets = Object.freeze({
  storyboardRegenAttempts: defaultStoryboardRegenAttemptLimit,
  actionRepairs: defaultActionRepairLimit,
  deliveryTransientRetries: defaultVerificationTransientRetryLimit,
  deliveryRepairs: defaultVerificationRepairLimit,
  gridTaskRequeue: defaultGridTaskRequeueLimit,
  verifyStageRetries: defaultVerifyStageRetryLimit,
})
const productionProfile = Object.freeze({
  id: manifestFactory,
  renderer: 'native-comic-v12',
  width: 1280,
  height: 720,
  fps: 30,
})

const coverRatios = Object.freeze([
  { ratio: '4:3', urlKey: 'cover_4x3_url' },
  { ratio: '3:4', urlKey: 'cover_3x4_url' },
])

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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
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

export function validateFrozenTtsArtifacts(tts) {
  const errors = []
  for (const [kind, path, expected] of [
    ['audio', tts?.audioPath, tts?.audioSha256],
    ['titles', tts?.titlesPath, tts?.titlesSha256],
  ]) {
    if (!path || !existsSync(path)) errors.push(`Frozen TTS ${kind} artifact is missing`)
    else if (!expected || hashFile(path) !== expected) errors.push(`Frozen TTS ${kind} SHA-256 changed`)
  }
  return { passed: errors.length === 0, errors }
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
    checks: ['episode and drama are resolved from the database', 'drama style is non-empty', 'the publishing package is present, title-matched, and fingerprinted', 'episodeId, dramaId, style, title, creationToken, and runId are persisted', 'the run path is immutable', 'the same episode and token replay the original run'],
  },
  {
    index: 2,
    stage: 'environment_check',
    owner: 'runner+validator',
    checks: ['backend and workers healthy', 'ffmpeg, ffprobe, and native renderer available', 'production fonts and the sync checker exist', 'episode BGM is set and at least 30s'],
  },
  {
    index: 3,
    stage: 'tts_verify',
    owner: 'validator',
    checks: ['pre-TTS audio and titles exist', 'titles are ordered and non-overlapping', 'title/audio coverage ratio is 0.60-1.05', 'audio and titles are frozen into the run dir with SHA-256', 'later stages only consume the frozen copies'],
  },
  {
    index: 4,
    stage: 'narrative_plan_verify',
    owner: 'validator',
    checks: ["latest narrative plan has kind = 'full'", 'timing_source is not storyboard_grid_fallback', 'beat timing coverage equals the in-scope storyboard count'],
  },
  {
    index: 5,
    stage: 'design_ensure',
    owner: 'runner',
    checks: ['every in-scope sequence has non-null design_json', 'missing sequences trigger grid.episode_design and are polled to terminal', 'a succeeded task is re-checked before the stage passes'],
  },
  {
    index: 6,
    stage: 'generate_ensure',
    owner: 'runner',
    checks: ['every storyboard panel has a completed final image on disk', 'every storyboard has grid_cells', 'missing storyboards trigger grid.episode_generate scoped by onlyStoryboardIds', 'regeneration consumes the fixed storyboard attempt budget'],
  },
  {
    index: 7,
    stage: 'manifest_build',
    owner: 'runner+validator',
    checks: ['build_history_comic_manifest.mjs exits 0', 'manifest passes the independent validator', 'manifest SHA-256 is frozen and bound to the frozen TTS artifacts'],
  },
  {
    index: 8,
    stage: 'asset_review',
    owner: 'runner+validator',
    gate: 'asset_contact_sheet',
    checks: ['all panel files exist', 'content hashes are unique', 'contact sheet matches asset fingerprint', 'runner auto-approves the sheet on numeric evidence (no visual review)'],
  },
  {
    index: 9,
    stage: 'props_build',
    owner: 'runner',
    checks: ['approved asset fingerprint is current', 'TTS titles drive all frames', 'every subtitle names its TTS title index', 'narration and BGM loudness are measured', 'props fingerprint is persisted', 'stale frame approval evidence is deleted'],
  },
  {
    index: 10,
    stage: 'candidate_render',
    owner: 'runner+validator',
    checks: ['native candidate is rendered from frozen props', 'candidate result binds full props and output SHA-256', 'an existing result binding the current props is adopted for free', 'candidate is not published as delivery'],
  },
  {
    index: 11,
    stage: 'frame_review',
    owner: 'runner+validator',
    checks: ['the deterministic renderer candidate carries every panel and subtitle frame', 'frame approval binds the current candidate bytes, candidate SHA-256, and the full panel count', 'runner auto-approves on numeric evidence (no visual review)'],
  },
  {
    index: 12,
    stage: 'publish',
    owner: 'runner',
    checks: ['both visual approvals bind current sheet bytes and complete review counts', 'the approved candidate bytes are atomically published', 'immutable delivery SHA-256 equals candidate SHA-256', 'different bytes are never overwritten'],
  },
  {
    index: 13,
    stage: 'delivery_verify',
    owner: 'runner+validator',
    checks: ['H.264 and AAC', '1280x720 at 30fps', 'decoded frame count matches plan', 'audio/video durations match within 0.5s', 'subtitles independently match frozen TTS timing', 'loudness and sustained-black checks pass', 'transient tool failures retry unchanged delivery bytes within fixed machine and Agent budgets', 'delivery SHA-256 is persisted'],
  },
  {
    index: 14,
    stage: 'episode_publish',
    owner: 'runner+validator',
    checks: ['publishing package hooks and fingerprint still match the episode database', 'both 4:3 and 3:4 covers are generated and read back', 'verified delivery path is converted to the frontend media URL', 'episode video_url and historyComic metadata commit atomically in one compare-and-set', 'replay is idempotent and a foreign pointer is rejected', 'the episodes API echoes the same videoUrl'],
  },
  {
    index: 15,
    stage: 'complete',
    owner: 'runner',
    checks: ['verification report passed', 'delivery hash matches report', 'artifact chain is consistent', 'episode publication is current', 'next_action is null'],
  },
])

export const machineActions = new Set([
  'init',
  'check-environment',
  'verify-tts',
  'verify-plan',
  'ensure-design',
  'ensure-generate',
  'build-manifest',
  'contact-sheet',
  'auto-approve-assets',
  'build-props',
  'render-candidate',
  'recover-candidate',
  'auto-approve-frames',
  'publish-candidate',
  'verify',
  'publish-episode',
])
export const agentActions = new Set([
  'retry-action',
  'retry-stage',
  'repair-delivery',
  'start-new-run',
])

export function classifyNextAction(nextAction) {
  if (nextAction === null || nextAction === undefined || String(nextAction).trim() === '') return 'terminal'
  const action = String(nextAction).trim().split(/\s+/u)[0]
  if (machineActions.has(action)) return 'machine'
  if (agentActions.has(action)) return 'agent'
  fail(`Unclassified next action: ${nextAction} (if this came from a run file, the run was likely written by a newer runner; use that runner or start-new-run)`)
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
  // Single-line JSON: agents read this on every poll, pretty printing was a
  // quadratic token amplifier (4-8.6KB per call for a ~65-700B decision core).
  console.log(JSON.stringify(status))
  const exit = runnerExitContract(status)
  if (exit.marker) console.error(exit.marker)
  process.exitCode = exit.exitCode
}

// Fields below hold current run evidence; failure histories are deliberately
// absent — migrations and rejections never delete failure history.
const downstreamEvidenceFields = Object.freeze([
  'environmentReport',
  'environmentFacts',
  'tts',
  'ttsTimelineReport',
  'narrativePlanReport',
  'designEvidence',
  'designTask',
  'designIntent',
  'designRequeueCount',
  'generateEvidence',
  'generateTask',
  'generateIntent',
  'generateRequeueCount',
  'regenRequests',
  'manifestPath',
  'manifestHash',
  'manifestFrozenAt',
  'manifestTtsAudioSha256',
  'manifestTtsTitlesSha256',
  'assetContactSheet',
  'assetApproval',
  'assetReviewEscalation',
  'props',
  'candidate',
  'frameApproval',
  'frameReviewEscalation',
  'frameRejection',
  'coverGeneration',
  'publication',
  'verificationReport',
  'deliveryVerifiedAt',
  'artifactChain',
  'episodePublication',
  'episodePublicationIntent',
  'actionFailure',
  'completedAt',
])

export function migrateRunState(input) {
  if (!input || input.workflow !== productionProfile.id) fail('Unsupported run workflow')
  if (Number(input.version) !== currentRunVersion) {
    fail(`Unsupported run state version: ${input.version}`)
  }
  const state = structuredClone(input)
  const expectedPlanHash = hash(JSON.stringify(compiledExecutionPlan))
  const storedPlanHash = state.planHash || hash(JSON.stringify(state.executionPlan || []))
  let migrated = false
  if (storedPlanHash !== expectedPlanHash) {
    state.planMigrations ||= []
    state.planMigrations.push({
      fromVersion: Number(state.version),
      toVersion: currentRunVersion,
      fromPlanVersion: state.planVersion || null,
      toPlanVersion: currentPlanVersion,
      fromPlanHash: storedPlanHash,
      toPlanHash: expectedPlanHash,
      migratedAt: new Date().toISOString(),
      invalidatedFromStage: 'environment_check',
      invalidationReason: 'execution plan changed; downstream evidence re-derives from the intake snapshot',
    })
    for (const field of downstreamEvidenceFields) delete state[field]
    state.version = currentRunVersion
    state.planVersion = currentPlanVersion
    state.planHash = expectedPlanHash
    state.executionPlan = compiledExecutionPlan
    state.profile = productionProfile
    migrated = true
  }
  return { state, migrated }
}

// Refuse to touch a run last written by a newer runner release. Every mutation
// entry point asserts this before writing; reads stay best-effort.
export function assertRunnerRelease(state, runPath) {
  const writtenBy = Number(state?.runnerRelease || 1)
  if (writtenBy > currentRunnerRelease) {
    const error = new Error(
      `RUNNER_VERSION_MISMATCH: ${runPath} was last written by runner release ${writtenBy},`
      + ` but this runner is release ${currentRunnerRelease}; use the newer runner that owns the run,`
      + ' or create a fresh revision with start-new-run from that runner',
    )
    error.errorCode = 'RUNNER_VERSION_MISMATCH'
    throw error
  }
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

function defaultRunPath(episodeId) {
  return join(repoRoot, 'scripts/history-notes', `episode-${episodeId}`, 'history-comic.run.json')
}

function saveRun(runPath, state) {
  state.runnerRelease = currentRunnerRelease
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

function loadRun(runArg) {
  if (!runArg) fail('Pass --run <path>')
  const runPath = resolve(repoRoot, runArg)
  if (!existsSync(runPath)) fail(`Run state does not exist: ${runPath}`)
  const migration = migrateRunState(readJson(runPath))
  const state = migration.state
  if (migration.migrated) {
    // Never let an older runner downgrade a newer runner's run file.
    assertRunnerRelease(state, runPath)
    saveRun(runPath, state)
  }
  return { runPath, state }
}

function database(readonly = true) {
  const configured = process.env.DB_PATH || 'data/huobao_drama.db'
  const path = isAbsolute(configured) ? configured : resolve(repoRoot, configured)
  return new Database(path, { readonly })
}

function databasePath() {
  const configured = process.env.DB_PATH || 'data/huobao_drama.db'
  return isAbsolute(configured) ? configured : resolve(repoRoot, configured)
}

function runDerivedPaths(runPath) {
  const runDir = dirname(resolve(runPath))
  return {
    runDir,
    manifestPath: join(runDir, 'history-comic.manifest.json'),
    propsPath: join(runDir, 'history-comic.props.json'),
    contactSheetPath: join(runDir, 'history-comic.assets.jpg'),
    nativeWorkDir: join(runDir, 'native'),
    candidatePath: join(runDir, 'candidate.mp4'),
    eventsLogPath: join(runDir, 'history-comic.events.log'),
    // dharma-text-v5：plate 底片与 Remotion 文字叠加层产物路径（与 dharma 工厂
    // 同一编排，见 dharma_text_overlay_stage.mjs）。overlay 序列目录禁止点段
    // （Remotion CLI 会把点段误判为扩展名），runDir 本身不含点段。
    platePath: join(runDir, 'native/plate.mp4'),
    overlayPropsPath: join(runDir, 'history-comic.overlay-props.json'),
    overlaySequenceDir: join(runDir, 'overlay-sequence'),
    compositeRecordPath: join(runDir, 'candidate.mp4.composite.json'),
  }
}

// One JSONL line per run event; monitors subscribe to this file instead of
// polling the full status JSON every 30-60s. Appends are best-effort: logging
// must never break a production action.
function appendRunEvent(runPath, event) {
  try {
    const logPath = runDerivedPaths(runPath).eventsLogPath
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  } catch (error) {
    console.error(`event log append failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Status transitions are logged once per change of the
// (stage, status, error_code, next_action) tuple — polling the same state
// never appends a duplicate line.
function logStatusTransition(runPath, status) {
  const transition = {
    stage: status.stage,
    status: status.status,
    error_code: status.error_code ?? null,
    next_action: status.next_action ?? null,
  }
  try {
    const logPath = runDerivedPaths(runPath).eventsLogPath
    if (existsSync(logPath)) {
      const tail = readFileSync(logPath, 'utf8').trimEnd().split('\n').at(-1)
      if (tail) {
        const last = JSON.parse(tail)
        if (last.event === 'status'
          && last.stage === transition.stage
          && last.status === transition.status
          && last.error_code === transition.error_code
          && last.next_action === transition.next_action) {
          return
        }
      }
    }
  } catch {
    // An unreadable tail must not block recording the transition.
  }
  appendRunEvent(runPath, { event: 'status', ...transition })
}

function deliveryPathForCandidate(candidateSha256) {
  return join(repoRoot, 'data/static/remotion', `history-comic-${String(candidateSha256).slice(0, 12)}.mp4`)
}

function resolveEpisodeSnapshot(episodeId) {
  const db = database()
  try {
    const episode = db.prepare(`
      select id, drama_id, title, workflow_type, script_content
      from episodes where id = ? and deleted_at is null
    `).get(episodeId)
    const drama = episode
      ? db.prepare('select id, style, title from dramas where id = ? and deleted_at is null').get(episode.drama_id)
      : null
    return { episode, drama }
  } finally {
    db.close()
  }
}

export function createInitialRun({
  episodeId,
  dramaId,
  style,
  title,
  creationToken = `history-comic-run:${randomUUID()}`,
  startedAt = new Date().toISOString(),
}) {
  const runId = createHash('sha1').update(`${episodeId}\n${creationToken}`).digest('hex').slice(0, 20)
  return {
    version: currentRunVersion,
    runnerRelease: currentRunnerRelease,
    workflow: productionProfile.id,
    runId,
    profile: productionProfile,
    planVersion: currentPlanVersion,
    planHash: hash(JSON.stringify(compiledExecutionPlan)),
    executionPlan: compiledExecutionPlan,
    episodeId: Number(episodeId),
    dramaId: Number(dramaId),
    style: String(style),
    title: String(title || ''),
    creationToken,
    startedAt,
    intakeSnapshot: {
      episodeId: Number(episodeId),
      dramaId: Number(dramaId),
      style: String(style),
      title: String(title || ''),
      resolvedAt: startedAt,
    },
    stages: {
      intake: {
        startedAt,
        completedAt: startedAt,
        elapsedMs: 0,
        episodeId: Number(episodeId),
        dramaId: Number(dramaId),
        style: String(style),
      },
    },
  }
}

function startRun(options) {
  if (!options.episode) fail('start requires --episode <id>')
  const episodeId = Number(options.episode)
  if (!Number.isInteger(episodeId) || episodeId <= 0) fail('--episode must be a positive integer')
  const runPath = resolve(repoRoot, options.run || defaultRunPath(episodeId))
  if (existsSync(runPath)) {
    const migration = migrateRunState(readJson(runPath))
    const existing = migration.state
    if (migration.migrated) {
      assertRunnerRelease(existing, runPath)
      saveRun(runPath, existing)
    }
    if (existing.workflow !== productionProfile.id || Number(existing.episodeId) !== episodeId) {
      fail(`Run path already belongs to different input: ${runPath}`)
    }
    return { runPath, state: existing }
  }
  const snapshot = resolveEpisodeSnapshot(episodeId)
  const validation = validateEpisodeSnapshot(snapshot)
  if (!validation.passed) fail(validation.checks.errors.join('; '))
  const publishing = loadEpisodePublishingPackage(episodeId)
  const state = createInitialRun({
    episodeId,
    dramaId: snapshot.drama.id,
    style: snapshot.drama.style,
    title: snapshot.episode.title,
  })
  state.publishingPackage = publishing.package
  state.publishingPackageSha256 = publishing.sha256
  try {
    createRunFile(runPath, state)
  } catch (error) {
    if (error?.code === 'EEXIST') return startRun(options)
    throw error
  }
  return { runPath, state }
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
  const snapshot = resolveEpisodeSnapshot(source.episodeId)
  const validation = validateEpisodeSnapshot(snapshot)
  if (!validation.passed) fail(validation.checks.errors.join('; '))
  const publishing = loadEpisodePublishingPackage(source.episodeId)
  const state = createInitialRun({
    episodeId: source.episodeId,
    dramaId: snapshot.drama.id,
    style: snapshot.drama.style,
    title: snapshot.episode.title,
  })
  state.publishingPackage = publishing.package
  state.publishingPackageSha256 = publishing.sha256
  state.revisionOf = source.runId
  state.revisionReason = requireTextOption(options, 'reason', 8)
  state.revisionActor = requireTextOption(options, 'actor')
  // Audit trail only: the source failure history is summarized into the
  // revision record for forensics, but no budget counter (requeue counts,
  // regen attempts, repair history) is ever inherited into the fresh run.
  state.revisionSourceFailures = (source.actionFailureHistory || []).slice(-10).map((entry) => ({
    action: entry.action,
    stage: entry.stage,
    errorCode: entry.errorCode,
    failedAt: entry.failedAt,
  }))
  createRunFile(runPath, state)
  appendRunEvent(runPath, { event: 'run_revised', stage: 'intake', source_run_path: sourceRunPath })
  appendRunEvent(sourceRunPath, { event: 'run_superseded', revision_run_path: runPath })
  return { runPath, state }
}

function statusResult(stage, status, checks, errorCode, nextAction) {
  const actionKind = classifyNextAction(nextAction)
  // Single point that attaches the recovery lesson to every failed status.
  return addFailureLesson({
    stage,
    status,
    checks,
    error_code: errorCode,
    next_action: nextAction,
    action_kind: actionKind,
    continuation_required: actionKind === 'machine' || actionKind === 'agent',
    user_handoff_allowed: actionKind === 'terminal',
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

// These error codes are only thrown after the grid task requeue budget is
// exhausted, so re-running the failed action cannot post new work — the only
// useful recovery is a fresh revision. Real incident: retry-action burned the
// whole action-repair budget on sub-second no-op rethrows before the agent
// was forced into start-new-run anyway.
export const requeueExhaustedFailureCodes = Object.freeze(new Set(['DESIGN_INCOMPLETE', 'GENERATE_INCOMPLETE']))

// Status stdout is a decision surface, not a data dump: long id lists are
// summarized to {count, sample} and grid task refs drop their multi-KB raw
// payload (the full objects stay in run.json).
function summarizeIdList(list, mapItem = (item) => item) {
  if (!Array.isArray(list)) return null
  return { count: list.length, sample: list.slice(0, 5).map(mapItem) }
}

function summarizeGridTask(task) {
  if (!task) return null
  return {
    id: task.id ?? null,
    status: task.status ?? null,
    error: task.raw?.error_message || task.raw?.errorMessage || null,
  }
}

export function stageRetryRecovery({ stage, history = [], limit = defaultVerifyStageRetryLimit }) {
  const retryCount = (history || []).filter((entry) => entry.stage === stage).length
  return {
    retryCount,
    retryLimit: limit,
    nextAction: retryCount < limit ? 'retry-stage' : null,
  }
}

export function storyboardRegenRecovery(attempts, limit = defaultStoryboardRegenAttemptLimit) {
  const used = Number(attempts || 0)
  return {
    attempts: used,
    limit,
    retryAvailable: used < limit,
  }
}

function stageRetryCount(run, stage) {
  return (run.stageRetryHistory || []).filter((entry) => entry.stage === stage).length
}

function generateAttempts(run, storyboardId) {
  return Number(run.generateAttempts?.[String(storyboardId)] || 0)
}

export function deriveRunStatus(run, facts = {}) {
  const baseChecks = {
    run_id: run.runId,
    episode_id: run.episodeId ?? null,
    drama_id: run.dramaId ?? null,
  }
  if (!run.intakeSnapshot || !run.episodeId || !run.dramaId) {
    return statusResult('intake', 'ready', baseChecks, 'INTAKE_REQUIRED', 'init')
  }
  if (run.actionFailure) {
    if (requeueExhaustedFailureCodes.has(run.actionFailure.errorCode)) {
      return statusResult(
        run.actionFailure.stage,
        'failed',
        {
          ...baseChecks,
          failed_action: run.actionFailure.action,
          errors: run.actionFailure.errors,
          failed_at: run.actionFailure.failedAt,
          requeue_budget_exhausted: true,
          design_requeue_count: Number(run.designRequeueCount || 0),
          generate_requeue_count: Number(run.generateRequeueCount || 0),
          grid_task_requeue_limit: defaultGridTaskRequeueLimit,
        },
        run.actionFailure.errorCode,
        'start-new-run',
      )
    }
    const recovery = actionFailureRecovery(run.actionFailure, run.actionFailureHistory)
    return statusResult(
      run.actionFailure.stage,
      'failed',
      {
        ...baseChecks,
        failed_action: run.actionFailure.action,
        errors: run.actionFailure.errors,
        failed_at: run.actionFailure.failedAt,
        repair_count: recovery.repairCount,
        repair_limit: recovery.repairLimit,
        retry_available: recovery.nextAction !== null,
      },
      run.actionFailure.errorCode,
      recovery.nextAction,
    )
  }
  if (!run.environmentReport) {
    return statusResult('environment_check', 'ready', baseChecks, 'ENVIRONMENT_CHECK_REQUIRED', 'check-environment')
  }
  if (!run.environmentReport.passed) {
    return statusResult(
      'environment_check',
      'failed',
      { ...baseChecks, ...run.environmentReport.checks },
      run.environmentReport.error_code,
      'retry-stage',
    )
  }

  const frozenTts = facts.ttsFrozen || validateFrozenTtsArtifacts(run.tts)
  if (!run.tts || !run.ttsTimelineReport || !frozenTts.passed) {
    return statusResult(
      'tts_verify',
      'ready',
      { ...baseChecks, frozen_tts_errors: frozenTts.errors || [] },
      'TTS_VERIFICATION_REQUIRED',
      'verify-tts',
    )
  }
  if (!run.ttsTimelineReport.passed) {
    const recovery = stageRetryRecovery({ stage: 'tts_verify', history: run.stageRetryHistory })
    return statusResult(
      'tts_verify',
      'failed',
      {
        ...baseChecks,
        ...run.ttsTimelineReport.checks,
        retry_count: recovery.retryCount,
        retry_limit: recovery.retryLimit,
      },
      run.ttsTimelineReport.error_code,
      recovery.nextAction,
    )
  }
  if (!run.narrativePlanReport) {
    return statusResult('narrative_plan_verify', 'ready', baseChecks, 'NARRATIVE_PLAN_VERIFY_REQUIRED', 'verify-plan')
  }
  if (!run.narrativePlanReport.passed) {
    const recovery = stageRetryRecovery({ stage: 'narrative_plan_verify', history: run.stageRetryHistory })
    return statusResult(
      'narrative_plan_verify',
      'failed',
      {
        ...baseChecks,
        ...run.narrativePlanReport.checks,
        retry_count: recovery.retryCount,
        retry_limit: recovery.retryLimit,
      },
      run.narrativePlanReport.error_code,
      recovery.nextAction,
    )
  }

  const designChecks = {
    ...baseChecks,
    design_missing: summarizeIdList(facts.designMissing, (item) => item.seqKey),
    design_task: summarizeGridTask(run.designTask),
  }
  if (run.designTask && activeTaskStatuses.has(run.designTask.status)) {
    return statusResult('design_ensure', 'running', designChecks, 'DESIGN_TASK_ACTIVE', 'ensure-design')
  }
  if (!Array.isArray(facts.designMissing) || facts.designMissing.length > 0) {
    return statusResult('design_ensure', 'ready', designChecks, 'DESIGN_ENSURE_REQUIRED', 'ensure-design')
  }

  const regenQueue = Array.isArray(facts.regenQueue) ? facts.regenQueue : []
  const generateChecks = {
    ...baseChecks,
    generate_missing: summarizeIdList(facts.generateMissing, (item) => ({
      storyboard_id: item.storyboardId,
      reasons: item.reasons,
    })),
    regen_queue: regenQueue,
    generate_task: summarizeGridTask(run.generateTask),
    generate_attempts: run.generateAttempts || {},
  }
  if (run.regenExhausted) {
    return statusResult('generate_ensure', 'failed', {
      ...generateChecks,
      exhausted: run.regenExhausted,
      regen_attempt_limit: defaultStoryboardRegenAttemptLimit,
    }, 'IMAGE_RETRY_EXHAUSTED', 'start-new-run')
  }
  const exhaustedRegen = regenQueue.find((storyboardId) => (
    generateAttempts(run, storyboardId) >= defaultStoryboardRegenAttemptLimit
  ))
  if (exhaustedRegen !== undefined) {
    return statusResult('generate_ensure', 'failed', {
      ...generateChecks,
      exhausted_storyboard_id: exhaustedRegen,
      regen_attempt_limit: defaultStoryboardRegenAttemptLimit,
    }, 'IMAGE_RETRY_EXHAUSTED', 'start-new-run')
  }
  if (run.generateTask && activeTaskStatuses.has(run.generateTask.status)) {
    return statusResult('generate_ensure', 'running', generateChecks, 'GENERATE_TASK_ACTIVE', 'ensure-generate')
  }
  if (!Array.isArray(facts.generateMissing) || facts.generateMissing.length > 0 || regenQueue.length > 0) {
    return statusResult('generate_ensure', 'ready', generateChecks, 'GENERATE_ENSURE_REQUIRED', 'ensure-generate')
  }

  const manifestChecks = {
    ...baseChecks,
    manifest_path: facts.manifestPath || null,
    manifest_current: facts.manifestCurrent === true,
  }
  if (!run.manifestHash) {
    return statusResult('manifest_build', 'ready', manifestChecks, 'MANIFEST_BUILD_REQUIRED', 'build-manifest')
  }
  if (!facts.manifestCurrent) {
    return statusResult('manifest_build', 'failed', {
      ...manifestChecks,
      manifest_hash_matches: false,
    }, 'MANIFEST_CHANGED', 'start-new-run')
  }

  const artifactChecks = {
    ...baseChecks,
    manifest_current: true,
    asset_fingerprint: facts.assetFingerprint || null,
    asset_count: facts.assetCount || null,
    asset_sheet_current: facts.assetSheetCurrent === true,
    asset_sheet_path: facts.assetSheetPath || null,
    asset_sheet_sha256: facts.assetSheetSha256 || null,
    asset_review_count: facts.assetCount || null,
    asset_approval_current: facts.assetApprovalCurrent === true,
    props_current: facts.propsCurrent === true,
    candidate_current: facts.candidateCurrent === true,
    candidate_recoverable: facts.candidateRecoverable === true,
    candidate_sha256: facts.candidateSha256 || null,
    frame_approval_current: facts.frameApprovalCurrent === true,
    delivery_exists: facts.deliveryExists === true,
    delivery_published_owned: facts.deliveryPublishedOwned === true,
    delivery_verified: facts.deliveryVerified === true,
    verification_passed: facts.verificationAttested === true,
    delivery_sha256: facts.deliverySha256 || null,
    verification_sha256: facts.verificationSha256 || null,
    episode_video_url: facts.episodeVideoUrl || null,
    expected_episode_video_url: facts.expectedEpisodeVideoUrl || null,
    publishing_package_current: facts.publishingPackageCurrent === true,
    opening_hook_present: facts.openingHookPresent === true,
    cliffhanger_present: facts.cliffhangerPresent === true,
    cover_4x3_url: facts.cover4x3Url || null,
    cover_3x4_url: facts.cover3x4Url || null,
    covers_current: facts.coversCurrent === true,
    episode_published_current: facts.episodePublishedCurrent === true,
  }
  if (facts.assetError) {
    return statusResult('asset_review', 'failed', { ...artifactChecks, artifact_error: facts.assetError }, 'ASSET_INVALID', 'start-new-run')
  }
  if (!facts.assetSheetCurrent) {
    return statusResult('asset_review', 'ready', artifactChecks, 'ASSET_CONTACT_SHEET_REQUIRED', 'contact-sheet')
  }
  if (!facts.assetApprovalCurrent) {
    return statusResult('asset_review', 'ready', artifactChecks, 'ASSET_AUTO_APPROVAL_REQUIRED', 'auto-approve-assets')
  }
  if (!facts.propsCurrent) {
    return statusResult('props_build', 'ready', artifactChecks, 'PROPS_REQUIRED', 'build-props')
  }
  if (!facts.candidateCurrent) {
    return facts.candidateRecoverable
      ? statusResult('candidate_render', 'ready', artifactChecks, 'CANDIDATE_STATE_RECOVERY_REQUIRED', 'recover-candidate')
      : statusResult('candidate_render', 'ready', artifactChecks, 'CANDIDATE_RENDER_REQUIRED', 'render-candidate')
  }
  if (!facts.frameApprovalCurrent) {
    return statusResult('frame_review', 'ready', artifactChecks, 'FRAME_AUTO_APPROVAL_REQUIRED', 'auto-approve-frames')
  }
  if (!facts.deliveryExists) {
    return statusResult('publish', 'ready', artifactChecks, 'PUBLISH_REQUIRED', 'publish-candidate')
  }
  if (!facts.deliveryPublishedOwned) {
    return statusResult('publish', 'failed', artifactChecks, 'DELIVERY_EXISTS_UNOWNED', 'start-new-run')
  }
  if (run.verificationReport && run.verificationReport.passed === false
    && run.verificationReport.sha256 === facts.deliverySha256) {
    const verificationRepairCount = (run.verificationRepairHistory || []).length
    const recovery = verificationFailureRecovery(run.verificationReport, verificationRepairCount)
    if (recovery.nextAction === 'verify') {
      return statusResult(
        'delivery_verify',
        recovery.status,
        {
          ...artifactChecks,
          retryable_errors: run.verificationReport.retryableErrors || [],
          verification_attempt: run.verificationReport.attempt || 1,
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
      retryable_errors: run.verificationReport.retryableErrors || [],
      verification_attempt: run.verificationReport.attempt || 1,
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
  if (facts.publishingPackageCurrent === false) {
    return statusResult('episode_publish', 'failed', artifactChecks, 'EPISODE_PUBLISHING_PACKAGE_REQUIRED', 'start-new-run')
  }
  if (facts.coversCurrent === false) {
    return statusResult('episode_publish', 'ready', artifactChecks, 'EPISODE_COVERS_REQUIRED', 'publish-episode')
  }
  if (!facts.episodePublishedCurrent) {
    return statusResult('episode_publish', 'ready', artifactChecks, 'EPISODE_PUBLICATION_REQUIRED', 'publish-episode')
  }
  return statusResult('complete', 'complete', artifactChecks, 'COMPLETE', null)
}

function startStage(state, name) {
  state.stageHistory ||= {}
  if (state.stages?.[name]) {
    state.stageHistory[name] ||= []
    state.stageHistory[name].push(state.stages[name].completedAt
      ? state.stages[name]
      : { ...state.stages[name], abandonedAt: new Date().toISOString() })
  }
  state.stages ||= {}
  state.stages[name] = { startedAt: new Date().toISOString() }
}

function ensureStageOpen(state, name) {
  if (!state.stages?.[name] || state.stages[name].completedAt || state.stages[name].abandonedAt) {
    startStage(state, name)
  }
}

function finishStage(state, name, detail = {}) {
  state.stages[name] = {
    ...state.stages[name],
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - new Date(state.stages[name].startedAt).getTime(),
    ...detail,
  }
}

function requireTextOption(options, name, minimum = 3) {
  const value = String(options[name] || '').trim()
  if (value.length < minimum) fail(`--${name.replaceAll('_', '-')} must be at least ${minimum} characters`)
  return value
}

function commandProbe(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    env: process.env,
  })
  return {
    status: result.status,
    signal: result.signal || null,
    error: result.error?.message || null,
    stdout: String(result.stdout || '').trim().slice(-2000),
    stderr: String(result.stderr || '').trim().slice(-2000),
  }
}

async function request(path, init = {}) {
  const timeoutMs = Number(process.env.HISTORY_HTTP_TIMEOUT_MS || 30_000)
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

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: process.env,
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

function ffprobe(path) {
  return JSON.parse(runProcess('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]).stdout)
}

function mediaDuration(path) {
  const value = Number(ffprobe(path).format?.duration)
  if (!Number.isFinite(value)) fail(`Cannot read duration: ${path}`)
  return value
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

function tryResolveDataPath(input) {
  try {
    return resolveDataPath(input)
  } catch {
    return null
  }
}

function publishingPackageError(message) {
  const error = new Error(message)
  error.errorCode = 'EPISODE_PUBLISHING_PACKAGE_REQUIRED'
  return error
}

function readEpisodePublishingPackageRecord(episodeId) {
  const db = database()
  try {
    const episode = db.prepare(`
      select id, title, opening_hook, cliffhanger, creative_brief_json,
             cover_prompt, cover_design_json, cover_image_4x3_url,
             cover_image_3x4_url, metadata
      from episodes
      where id = ? and deleted_at is null
    `).get(episodeId)
    if (!episode) return null
    const metadata = parseEpisodeMetadata(episode.metadata)
    const stored = metadata?.dharmaPublishing?.package
    let publishingPackage = null
    let packageError = null
    if (stored) {
      try {
        publishingPackage = normalizePublishingPackage(stored, { expectedTitle: String(episode.title || '').trim() })
      } catch (error) {
        packageError = error instanceof Error ? error.message : String(error)
      }
    }
    const packageSha256 = publishingPackage ? publishingPackageFingerprint(publishingPackage) : null
    const recordedSha256 = String(metadata?.dharmaPublishing?.package_sha256 || '').trim() || null
    return {
      episode,
      metadata,
      publishingPackage,
      packageSha256,
      recordedSha256,
      packageError,
    }
  } finally {
    db.close()
  }
}

function loadEpisodePublishingPackage(episodeId) {
  const record = readEpisodePublishingPackageRecord(episodeId)
  if (!record) throw publishingPackageError(`Episode ${episodeId} has no publishing package in the database`)
  if (!record.publishingPackage) {
    throw publishingPackageError(
      `Episode ${episodeId} publishing package is invalid: ${record.packageError || 'metadata.dharmaPublishing.package is missing'}`,
    )
  }
  if (!record.recordedSha256 || record.recordedSha256 !== record.packageSha256) {
    throw publishingPackageError(`Episode ${episodeId} publishing package fingerprint is missing or stale`)
  }
  return {
    package: record.publishingPackage,
    sha256: record.packageSha256,
  }
}

function intakeForRun(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'intake')
  saveRun(runPath, run)
  const snapshot = resolveEpisodeSnapshot(run.episodeId)
  requirePassed(validateEpisodeSnapshot(snapshot))
  run.dramaId = Number(snapshot.drama.id)
  run.style = String(snapshot.drama.style)
  run.title = String(snapshot.episode.title || '')
  const publishing = loadEpisodePublishingPackage(run.episodeId)
  run.publishingPackage = publishing.package
  run.publishingPackageSha256 = publishing.sha256
  run.intakeSnapshot = {
    episodeId: Number(run.episodeId),
    dramaId: run.dramaId,
    style: run.style,
    title: run.title,
    resolvedAt: new Date().toISOString(),
  }
  finishStage(run, 'intake', {
    passed: true,
    episodeId: run.episodeId,
    dramaId: run.dramaId,
    style: run.style,
    publishingPackageSha256: publishing.sha256,
  })
  saveRun(runPath, run)
  return run.intakeSnapshot
}

async function checkEnvironment(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'environment_check')
  saveRun(runPath, run)

  let apiHealthOk = false
  let workerCount = 0
  const networkErrors = []
  try {
    const response = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(30_000) })
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
  const ffprobeCommand = commandProbe('ffprobe', ['-version'])
  const rendererPath = join(repoRoot, 'scripts/videoeditor/dharma_comic_native_renderer.mjs')
  const syncCheckerPath = join(repoRoot, 'scripts/videoeditor/check_dharma_sync.mjs')
  const fontSansPath = join(repoRoot, 'data/fonts/NotoSansCJKsc-Regular.otf')
  const fontSerifPath = join(repoRoot, 'remotion/public/fonts/NotoSerifSC-Bold.ttf')

  const db = database()
  let episode
  try {
    episode = db.prepare('select id, bgm_audio_url from episodes where id = ? and deleted_at is null').get(run.episodeId)
  } finally {
    db.close()
  }
  const bgm = { path: episode?.bgm_audio_url || null, exists: false, duration_sec: Number.NaN }
  if (episode?.bgm_audio_url) {
    try {
      const bgmAbsolute = resolveDataPath(episode.bgm_audio_url)
      bgm.exists = true
      bgm.duration_sec = mediaDuration(bgmAbsolute)
    } catch {}
  }

  const facts = {
    api_health_ok: apiHealthOk,
    worker_count: workerCount,
    ffmpeg_ok: ffmpeg.status === 0,
    ffprobe_ok: ffprobeCommand.status === 0,
    native_renderer_ok: existsSync(rendererPath),
    font_sans_ok: existsSync(fontSansPath),
    font_serif_ok: existsSync(fontSerifPath),
    sync_checker_ok: existsSync(syncCheckerPath),
    bgm,
  }
  const report = validateEnvironment(facts)
  report.checks.network_errors = networkErrors
  report.generatedAt = new Date().toISOString()
  run.environmentReport = report
  run.environmentFacts = facts
  finishStage(run, 'environment_check', report.passed
    ? { passed: true, bgmDurationSec: bgm.duration_sec }
    : { passed: false, errors: report.checks.errors })
  saveRun(runPath, run)
  return report
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
  let titles = []
  let titlesParseError = null
  try {
    titles = episode?.pre_tts_titles_json ? JSON.parse(episode.pre_tts_titles_json) : []
  } catch (error) {
    titlesParseError = error instanceof Error ? error.message : String(error)
  }
  let narrationPath = null
  let audioDurationSec = Number.NaN
  try {
    narrationPath = resolveDataPath(episode?.pre_tts_audio_url)
    audioDurationSec = mediaDuration(narrationPath)
  } catch {}
  if (!episode?.pre_tts_audio_url || !episode?.pre_tts_titles_json) {
    const timeline = {
      passed: false,
      error_code: 'TTS_TIMELINE_MISMATCH',
      checks: { errors: ['Episode has no pre-TTS master (pre_tts_audio_url/pre_tts_titles_json); run tts.pre_generate first'], title_count: 0 },
      data: null,
    }
    run.ttsTimelineReport = timeline
    finishStage(run, 'tts_verify', { passed: false, timelineErrors: timeline.checks.errors })
    saveRun(runPath, run)
    return timeline
  }
  const timeline = validateTtsTimeline({ titles, audioDurationSec })
  if (titlesParseError) {
    timeline.passed = false
    timeline.error_code ||= 'TTS_TIMELINE_MISMATCH'
    timeline.checks.errors.push(`TTS titles JSON does not parse: ${titlesParseError}`)
  }
  run.ttsTimelineReport = timeline
  if (timeline.passed) {
    const paths = runDerivedPaths(runPath)
    const sourceAudioSha256 = hashFile(narrationPath)
    const titlesCanonical = `${JSON.stringify(titles, null, 2)}\n`
    const titlesSha256 = hash(titlesCanonical)
    const audioExtension = extname(narrationPath) || '.wav'
    const frozenAudioPath = join(paths.runDir, `tts-audio${audioExtension}`)
    const frozenTitlesPath = join(paths.runDir, 'tts-titles.json')
    const reusable = run.tts
      && run.tts.audioSha256 === sourceAudioSha256
      && run.tts.titlesSha256 === titlesSha256
      && run.tts.audioPath === frozenAudioPath
      && run.tts.titlesPath === frozenTitlesPath
      && existsSync(frozenAudioPath) && hashFile(frozenAudioPath) === sourceAudioSha256
      && existsSync(frozenTitlesPath) && hashFile(frozenTitlesPath) === titlesSha256
    if (!reusable) {
      copyFileSync(narrationPath, frozenAudioPath)
      writeFileSync(frozenTitlesPath, titlesCanonical)
    }
    const narrationEndSec = Number(titles.at(-1).time_end) / 1000
    run.tts = {
      audioSource: episode.pre_tts_audio_url,
      audioPath: frozenAudioPath,
      audioSha256: hashFile(frozenAudioPath),
      audioBytes: statSync(frozenAudioPath).size,
      titlesPath: frozenTitlesPath,
      titlesSha256: hashFile(frozenTitlesPath),
      titleCount: titles.length,
      narrationEndSec,
      audioDurationSec,
      verifiedAt: new Date().toISOString(),
    }
    finishStage(run, 'tts_verify', { passed: true, titleCount: titles.length, narrationEndSec })
  } else {
    finishStage(run, 'tts_verify', { passed: false, timelineErrors: timeline.checks.errors })
  }
  saveRun(runPath, run)
  return timeline
}

export const beatCoverageSql = `SELECT COUNT(DISTINCT sb.id) FROM storyboards sb
JOIN storyboard_panels p ON p.panel_key = 'sb-' || sb.id
JOIN visual_beats vb ON vb.id = p.beat_id AND vb.start_ms IS NOT NULL
JOIN narrative_plans np ON np.id = p.plan_id AND np.kind='full'
WHERE sb.episode_id = ?`

function latestFullPlan(db, episodeId) {
  return db.prepare(`
    select id, kind, timing_source
    from narrative_plans
    where episode_id = ? and kind = 'full'
    order by created_at desc limit 1
  `).get(episodeId) || null
}

function verifyNarrativePlanForRun(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'narrative_plan_verify')
  saveRun(runPath, run)
  const db = database()
  let plan
  let beatCoverage
  let storyboardCount
  try {
    plan = latestFullPlan(db, run.episodeId)
    beatCoverage = Number(db.prepare(beatCoverageSql).get(run.episodeId)?.['COUNT(DISTINCT sb.id)'] ?? 0)
    storyboardCount = Number(db.prepare('select count(*) as c from storyboards where episode_id = ?').get(run.episodeId)?.c ?? 0)
  } finally {
    db.close()
  }
  const report = validateNarrativePlan({ plan, beatCoverage, storyboardCount })
  run.narrativePlanReport = {
    ...report,
    planId: plan?.id ?? null,
    verifiedAt: new Date().toISOString(),
  }
  finishStage(run, 'narrative_plan_verify', report.passed
    ? { passed: true, planId: plan.id, beatCoverage, storyboardCount }
    : { passed: false, errors: report.checks.errors })
  saveRun(runPath, run)
  return report
}

function computeMissingDesign(episodeId) {
  const db = database()
  try {
    const plan = latestFullPlan(db, episodeId)
    if (!plan) fail(`No full narrative plan exists for episode ${episodeId}`)
    const sequences = db.prepare(`
      select id, seq_key, design_json
      from narrative_sequences
      where plan_id = ?
      order by seq_index
    `).all(plan.id)
    const missing = []
    for (const sequence of sequences) {
      let valid = false
      if (sequence.design_json) {
        try {
          const parsed = JSON.parse(sequence.design_json)
          valid = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        } catch {}
      }
      if (!valid) missing.push({ sequenceId: Number(sequence.id), seqKey: String(sequence.seq_key) })
    }
    return missing
  } finally {
    db.close()
  }
}

function parseGridCells(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.cells)) {
      return parsed.cells
    }
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return null
}

export function gridStyleProfileFromRaw(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof parsed.styleProfile === 'string'
      ? parsed.styleProfile
      : null
  } catch {
    return null
  }
}

export function styleProfileMismatchReason(actual, expected) {
  const expectedStyle = String(expected || '').trim()
  const canonical = (value) => String(value || '').trim().toLowerCase().replaceAll('-', '_')
  if (!expectedStyle || canonical(actual) === canonical(expectedStyle)) return null
  return `style profile ${String(actual || 'missing')} does not match expected ${expectedStyle}`
}

export function computeMissingPanelStoryboards(episodeId, expectedStyleProfile = null) {
  const db = database()
  try {
    const plan = latestFullPlan(db, episodeId)
    if (!plan) fail(`No full narrative plan exists for episode ${episodeId}`)
    const storyboards = db.prepare(`
      select id, storyboard_number, grid_cells
      from storyboards
      where episode_id = ?
      order by storyboard_number
    `).all(episodeId)
    const panels = db.prepare(`
      select panel_key, gen_status, final_path
      from storyboard_panels
      where plan_id = ?
    `).all(plan.id)
    const panelsByStoryboard = new Map()
    for (const panel of panels) {
      const storyboardId = storyboardIdFromPanelKey(panel.panel_key)
      if (storyboardId === null) continue
      const list = panelsByStoryboard.get(storyboardId) || []
      list.push(panel)
      panelsByStoryboard.set(storyboardId, list)
    }
    const missing = []
    for (const storyboard of storyboards) {
      const storyboardId = Number(storyboard.id)
      const storyboardPanels = panelsByStoryboard.get(storyboardId) || []
      const cells = parseGridCells(storyboard.grid_cells)
      const reasons = []
      if (!cells || cells.length === 0) reasons.push('missing grid_cells')
      const styleMismatch = styleProfileMismatchReason(
        gridStyleProfileFromRaw(storyboard.grid_cells),
        expectedStyleProfile,
      )
      if (styleMismatch) reasons.push(styleMismatch)
      if (!storyboardPanels.length) {
        reasons.push('no storyboard_panels rows')
      } else {
        for (const panel of storyboardPanels) {
          if (String(panel.gen_status || '') !== 'completed') {
            reasons.push(`panel ${panel.panel_key} is not completed`)
            continue
          }
          if (!panel.final_path) {
            reasons.push(`panel ${panel.panel_key} has no final_path`)
            continue
          }
          const absolute = tryResolveDataPath(panel.final_path)
          if (!absolute) {
            reasons.push(`panel ${panel.panel_key} final image is missing on disk`)
          } else if (statSync(absolute).size < 1) {
            reasons.push(`panel ${panel.panel_key} final image is empty`)
          }
        }
      }
      if (reasons.length) missing.push({ storyboardId, reasons })
    }
    return missing
  } finally {
    db.close()
  }
}

export function isTransientTaskPollError(error) {
  const name = String(error?.name || '').toLowerCase()
  const message = String(error?.message || error || '').toLowerCase()
  return name === 'aborterror'
    || name === 'timeouterror'
    || message.includes('fetch failed')
    || message.includes('network error')
    || message.includes('econnrefused')
    || /returned 5\d\d\b/u.test(message)
}

export function recoverTransientTaskPoll(taskRef, error, limit = defaultTaskPollTransientErrorLimit) {
  if (!isTransientTaskPollError(error)) return null
  const failures = Number(taskRef.pollFailures || 0) + 1
  if (!Number.isFinite(limit) || failures > limit) return null
  return {
    ...taskRef,
    // The persisted task state is still active; do not turn a missing poll
    // response into a terminal design failure.
    status: activeTaskStatuses.has(taskRef.status) ? taskRef.status : 'running',
    pollFailures: failures,
    lastPollError: String(error?.message || error).slice(0, 240),
    updatedAt: new Date().toISOString(),
  }
}

async function pollGridTask(run, taskRef) {
  void run
  const timeoutMs = Number(process.env.HISTORY_TASK_POLL_TIMEOUT_MS || defaultTaskPollTimeoutMs)
  const signal = AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTaskPollTimeoutMs)
  try {
    const task = await request(`/tasks/${taskRef.id}`, { signal })
    return {
      ...taskRef,
      status: String(task?.status || 'unknown'),
      raw: task,
      pollFailures: 0,
      lastPollError: null,
      updatedAt: new Date().toISOString(),
    }
  } catch (error) {
    const recovered = recoverTransientTaskPoll(taskRef, error)
    if (recovered) return recovered
    throw error
  }
}

async function ensureDesign(runPath) {
  const run = loadRun(runPath).state
  ensureStageOpen(run, 'design_ensure')
  saveRun(runPath, run)

  if (run.designTask && activeTaskStatuses.has(run.designTask.status)) {
    run.designTask = await pollGridTask(run, run.designTask)
    saveRun(runPath, run)
    if (activeTaskStatuses.has(run.designTask.status)) return run.designTask
  }
  if (run.designTask && terminalStatuses.has(run.designTask.status)) {
    const task = run.designTask
    if (task.status !== 'succeeded') {
      const error = new Error(`grid.episode_design task ${task.id} ended as ${task.status}: ${task.raw?.error_message || task.raw?.errorMessage || 'no error message'}`)
      error.errorCode = 'DESIGN_TASK_FAILED'
      throw error
    }
    const missing = computeMissingDesign(run.episodeId)
    if (!missing.length) {
      run.designEvidence = { missing: [], taskId: Number(task.id), verifiedAt: new Date().toISOString() }
      run.designTask = null
      finishStage(run, 'design_ensure', { passed: true, taskId: Number(task.id) })
      saveRun(runPath, run)
      return run.designEvidence
    }
    const requeueCount = Number(run.designRequeueCount || 0)
    if (requeueCount < defaultGridTaskRequeueLimit) {
      run.designRequeueCount = requeueCount + 1
      const created = await request(`/grid/episode/${run.episodeId}/design`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlySequenceIds: missing.map((item) => item.sequenceId) }),
      })
      run.designTask = { id: Number(created.task_id), status: 'queued', requeue: true, targets: missing.map((item) => item.seqKey), postedAt: new Date().toISOString() }
      saveRun(runPath, run)
      return run.designTask
    }
    const error = new Error(`grid.episode_design succeeded but sequences still miss design_json: ${missing.map((item) => item.seqKey).join(', ')}`)
    error.errorCode = 'DESIGN_INCOMPLETE'
    throw error
  }

  const missing = computeMissingDesign(run.episodeId)
  if (!missing.length) {
    run.designEvidence = { missing: [], taskId: null, verifiedAt: new Date().toISOString() }
    finishStage(run, 'design_ensure', { passed: true, noop: true })
    saveRun(runPath, run)
    return run.designEvidence
  }
  run.designIntent = { missing: missing.map((item) => item.seqKey), recordedAt: new Date().toISOString() }
  saveRun(runPath, run)
  const created = await request(`/grid/episode/${run.episodeId}/design`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onlySequenceIds: missing.map((item) => item.sequenceId) }),
  })
  run.designTask = { id: Number(created.task_id), status: 'queued', targets: missing.map((item) => item.seqKey), postedAt: new Date().toISOString() }
  delete run.designIntent
  saveRun(runPath, run)
  return run.designTask
}

async function ensureGenerate(runPath) {
  const run = loadRun(runPath).state
  ensureStageOpen(run, 'generate_ensure')
  saveRun(runPath, run)

  const completeTargets = (targets) => {
    const missing = computeMissingPanelStoryboards(run.episodeId, run.style)
    const missingIds = new Set(missing.map((item) => item.storyboardId))
    const completed = targets.filter((storyboardId) => !missingIds.has(storyboardId))
    const stillMissing = targets.filter((storyboardId) => missingIds.has(storyboardId))
    return { missing, completed, stillMissing }
  }
  const recordAttempts = (completedTargets, regenTargets) => {
    run.generateAttempts ||= {}
    for (const storyboardId of completedTargets) {
      const key = String(storyboardId)
      if (regenTargets.includes(storyboardId)) run.generateAttempts[key] = generateAttempts(run, storyboardId) + 1
      else run.generateAttempts[key] = Math.max(1, generateAttempts(run, storyboardId))
    }
    if (regenTargets.length) {
      const cleared = new Set(completedTargets)
      run.regenRequests = (run.regenRequests || []).filter((item) => !cleared.has(item.storyboardId))
    }
  }

  if (run.generateTask && activeTaskStatuses.has(run.generateTask.status)) {
    run.generateTask = await pollGridTask(run, run.generateTask)
    saveRun(runPath, run)
    if (activeTaskStatuses.has(run.generateTask.status)) return run.generateTask
  }
  if (run.generateTask && terminalStatuses.has(run.generateTask.status)) {
    const task = run.generateTask
    const targets = task.targets || []
    const regenTargets = task.regenTargets || []
    const { completed, stillMissing } = completeTargets(targets)
    recordAttempts(completed, regenTargets)
    if (!stillMissing.length) {
      run.generateEvidence = { taskId: Number(task.id), verifiedAt: new Date().toISOString() }
      run.generateTask = null
      finishStage(run, 'generate_ensure', { passed: true, taskId: Number(task.id), targets: completed })
      saveRun(runPath, run)
      return run.generateEvidence
    }

    // A grid task can now be terminal-failed after preserving successful
    // panels. Reconcile the database first and requeue only the still-missing
    // storyboard ids; the task status itself must not discard good panels.
    if (task.status !== 'succeeded' && task.status !== 'failed' && task.status !== 'stale') {
      const error = new Error(`grid.episode_generate task ${task.id} ended as ${task.status}: ${task.raw?.error_message || task.raw?.errorMessage || 'no error message'}`)
      error.errorCode = 'GENERATE_TASK_FAILED'
      throw error
    }
    const requeueCount = Number(run.generateRequeueCount || 0)
    if (requeueCount < defaultGridTaskRequeueLimit) {
      run.generateRequeueCount = requeueCount + 1
      const force = regenTargets.some((storyboardId) => stillMissing.includes(storyboardId))
      const created = await request(`/grid/episode/${run.episodeId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlyStoryboardIds: stillMissing, force }),
      })
      run.generateTask = { id: Number(created.task_id), status: 'queued', requeue: true, targets: stillMissing, regenTargets: regenTargets.filter((id) => stillMissing.includes(id)), postedAt: new Date().toISOString() }
      saveRun(runPath, run)
      return run.generateTask
    }
    const error = new Error(`grid.episode_generate succeeded but storyboards still miss panel images: ${stillMissing.join(', ')}`)
    error.errorCode = 'GENERATE_INCOMPLETE'
    throw error
  }

  const missing = computeMissingPanelStoryboards(run.episodeId, run.style)
  const styleRegenTargets = missing
    .filter((item) => item.reasons.some((reason) => reason.startsWith('style profile ')))
    .map((item) => Number(item.storyboardId))
  const regenTargets = [...new Set([
    ...(run.regenRequests || []).map((item) => Number(item.storyboardId)),
    ...styleRegenTargets,
  ])]
  const targets = [...new Set([...missing.map((item) => item.storyboardId), ...regenTargets])]
  if (!targets.length) {
    run.generateEvidence = { taskId: null, verifiedAt: new Date().toISOString() }
    finishStage(run, 'generate_ensure', { passed: true, noop: true })
    saveRun(runPath, run)
    return run.generateEvidence
  }
  const exhausted = regenTargets.find((storyboardId) => generateAttempts(run, storyboardId) >= defaultStoryboardRegenAttemptLimit)
  if (exhausted !== undefined) {
    run.regenExhausted = {
      storyboardId: exhausted,
      attempts: generateAttempts(run, exhausted),
      recordedAt: new Date().toISOString(),
    }
    saveRun(runPath, run)
    return run.regenExhausted
  }
  run.generateIntent = { targets, regenTargets, recordedAt: new Date().toISOString() }
  saveRun(runPath, run)
  const created = await request(`/grid/episode/${run.episodeId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ onlyStoryboardIds: targets, force: regenTargets.length > 0 }),
  })
  run.generateTask = { id: Number(created.task_id), status: 'queued', targets, regenTargets, postedAt: new Date().toISOString() }
  delete run.generateIntent
  saveRun(runPath, run)
  return run.generateTask
}

function buildManifestForRun(runPath) {
  const run = loadRun(runPath).state
  startStage(run, 'manifest_build')
  saveRun(runPath, run)
  const frozenTts = validateFrozenTtsArtifacts(run.tts)
  if (!frozenTts.passed) fail(frozenTts.errors.join('; '))
  if (!run.narrativePlanReport?.passed) fail('Narrative plan must be verified before manifest build')
  const paths = runDerivedPaths(runPath)
  const builderPath = join(repoRoot, 'scripts/videoeditor/build_history_comic_manifest.mjs')
  if (!existsSync(builderPath)) fail(`History manifest builder is missing: ${builderPath}`)
  runProcess('node', [
    builderPath,
    String(run.episodeId),
    '--out', paths.manifestPath,
    '--db', databasePath(),
  ], { timeout: 30 * 60_000 })
  const raw = readFileSync(paths.manifestPath, 'utf8')
  const manifest = JSON.parse(raw)
  requirePassed(validateManifest(manifest, {
    expectedEpisodeId: run.episodeId,
    expectedDramaId: run.dramaId,
    expectedTitleCount: run.tts.titleCount,
    expectedNarrationEndSec: run.tts.narrationEndSec,
  }))
  run.manifestPath = paths.manifestPath
  run.manifestHash = hash(raw)
  run.manifestFrozenAt = new Date().toISOString()
  run.manifestTtsAudioSha256 = run.tts.audioSha256
  run.manifestTtsTitlesSha256 = run.tts.titlesSha256
  run.artifactChain = {
    episodeId: Number(run.episodeId),
    creationToken: run.creationToken,
    ttsAudioSha256: run.tts.audioSha256,
    ttsTitlesSha256: run.tts.titlesSha256,
    planId: run.narrativePlanReport.planId ?? null,
    manifestSha256: run.manifestHash,
  }
  finishStage(run, 'manifest_build', { passed: true, panels: manifest.panels.length, manifestHash: run.manifestHash })
  saveRun(runPath, run)
  return { manifestPath: paths.manifestPath, manifestHash: run.manifestHash, panels: manifest.panels.length }
}

function loadRunManifest(runPath) {
  const run = loadRun(runPath).state
  if (!run.manifestHash) fail('Run has no frozen manifest')
  const paths = runDerivedPaths(runPath)
  if (!existsSync(paths.manifestPath)) fail('Frozen manifest file is missing')
  const raw = readFileSync(paths.manifestPath, 'utf8')
  if (hash(raw) !== run.manifestHash) fail('Frozen manifest hash changed')
  if (run.manifestTtsAudioSha256 !== run.tts?.audioSha256 || run.manifestTtsTitlesSha256 !== run.tts?.titlesSha256) {
    fail('Frozen manifest no longer binds the current frozen TTS artifacts')
  }
  return { run, manifest: JSON.parse(raw), paths }
}

function resolvedPanelAssets(panels) {
  return requirePassed(validatePanelAssets(panels, {
    resolveAssetPath: resolveDataPath,
    statFile: statSync,
    hashFile,
    hashValue: hash,
  }))
}

// A single ffmpeg xstack with ~250+ input streams (each scaled + cropped)
// deterministically fails on this hardware ("Resource temporarily unavailable"
// when the mjpeg encoder opens, or "Failed to configure output pad"). Large
// episodes routinely exceed that ceiling, so we chunk tiles into pages of at
// most MAX_CONTACT_SHEET_PAGE_TILES and stitch the page images into one final
// sheet with a second ffmpeg pass (few inputs). The output path and fingerprint
// semantics are unchanged — the binder still sees one sheet file.
const MAX_CONTACT_SHEET_PAGE_TILES = 200

function renderContactSheetPage(imagePaths, outputPath, tileWidth, tileHeight, columns) {
  const filters = imagePaths.map((_, index) => (
    `[${index}:v]scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase,crop=${tileWidth}:${tileHeight}[v${index}]`
  ))
  const layout = imagePaths.map((_, index) => `${(index % columns) * tileWidth}_${Math.floor(index / columns) * tileHeight}`).join('|')
  filters.push(`${imagePaths.map((_, index) => `[v${index}]`).join('')}xstack=inputs=${imagePaths.length}:layout=${layout}:fill=black[out]`)
  runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...imagePaths.flatMap((path) => ['-i', path]),
    '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', outputPath,
  ])
}

function createContactSheet(imagePaths, outputPath, tileWidth = 320, tileHeight = 180) {
  mkdirSync(dirname(outputPath), { recursive: true })
  const columns = Math.min(5, imagePaths.length)
  if (imagePaths.length <= MAX_CONTACT_SHEET_PAGE_TILES) {
    renderContactSheetPage(imagePaths, outputPath, tileWidth, tileHeight, columns)
    return
  }
  // Chunk into pages, render each page to a temp file, then stitch pages
  // vertically into the single final sheet (page count stays tiny).
  const pageTemp = `${outputPath}.pages`
  mkdirSync(pageTemp, { recursive: true })
  const pages = []
  for (let start = 0; start < imagePaths.length; start += MAX_CONTACT_SHEET_PAGE_TILES) {
    const chunk = imagePaths.slice(start, start + MAX_CONTACT_SHEET_PAGE_TILES)
    const pagePath = join(pageTemp, `page-${pages.length}.jpg`)
    renderContactSheetPage(chunk, pagePath, tileWidth, tileHeight, columns)
    pages.push(pagePath)
  }
  // Stitch pages vertically with vstack (single-column stacking, no manual
  // offsets to get wrong). Pages already share the same width.
  const stackFilters = pages.map((_, index) => `[${index}:v]setsar=1[p${index}]`)
  stackFilters.push(`${pages.map((_, index) => `[p${index}]`).join('')}vstack=inputs=${pages.length}[out]`)
  runProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...pages.flatMap((path) => ['-i', path]),
    '-filter_complex', stackFilters.join(';'), '-map', '[out]', '-frames:v', '1', outputPath,
  ])
  rmSync(pageTemp, { recursive: true, force: true })
}

function contactSheet(runPath) {
  const { run, manifest, paths } = loadRunManifest(runPath)
  startStage(run, 'asset_review')
  saveRun(runPath, run)
  const resolved = resolvedPanelAssets(manifest.panels)
  createContactSheet(resolved.assets.map((asset) => asset.path), paths.contactSheetPath)
  const columns = Math.min(5, resolved.assets.length)
  const indexPath = `${paths.contactSheetPath}.json`
  atomicWriteJson(indexPath, resolved.assets.map((asset, index) => ({
    panel: index + 1,
    key: asset.key,
    row: Math.floor(index / columns) + 1,
    column: (index % columns) + 1,
    sourcePath: asset.sourcePath,
  })))
  run.assetContactSheet = {
    path: paths.contactSheetPath,
    indexPath,
    fingerprint: resolved.fingerprint,
    artifactSha256: hashFile(paths.contactSheetPath),
    indexSha256: hashFile(indexPath),
    generatedAt: new Date().toISOString(),
  }
  if (run.assetApproval?.fingerprint !== resolved.fingerprint) delete run.assetApproval
  delete run.assetReviewEscalation
  finishStage(run, 'asset_review', { panels: resolved.assets.length, fingerprint: resolved.fingerprint })
  saveRun(runPath, run)
  return { contactSheetPath: paths.contactSheetPath, fingerprint: resolved.fingerprint }
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

// The asset review gate is numeric: once the contact sheet binds the current
// asset fingerprint, the runner approves it without any visual inspection.
export function autoApproveAssets(runPath) {
  const { run, manifest } = loadRunManifest(runPath)
  const resolved = resolvedPanelAssets(manifest.panels)
  if (!run.assetContactSheet || run.assetContactSheet.fingerprint !== resolved.fingerprint) {
    fail('Regenerate the contact sheet before asset auto-approval')
  }
  const sheetSha256 = hashFile(run.assetContactSheet.path)
  if (sheetSha256 !== run.assetContactSheet.artifactSha256) {
    fail('Contact sheet bytes changed after generation; rebuild the contact sheet')
  }
  run.assetApproval = {
    ...buildVisualApproval({
      actor: 'runner',
      review_tool: 'numeric',
      reviewed_count: resolved.assets.length,
      reason: 'numeric gate: every panel file exists, is non-empty, and carries unique content; the contact sheet binds the asset fingerprint',
    }, {
      artifactPath: run.assetContactSheet.path,
      artifactSha256: sheetSha256,
      expectedReviewedCount: resolved.assets.length,
      fingerprint: resolved.fingerprint,
    }),
    approvedAt: new Date().toISOString(),
  }
  saveRun(runPath, run)
  return run.assetApproval
}
// ---------------------------------------------------------------------------
// Loudness + BGM mix
// ---------------------------------------------------------------------------

export const HISTORY_NARRATION_TARGET_LUFS = -24

export function deriveNarrationGain(narrationIntegratedLufs, targetLufs = HISTORY_NARRATION_TARGET_LUFS) {
  if (!Number.isFinite(narrationIntegratedLufs)) throw new Error('narration loudness is required before gain derivation')
  if (!Number.isFinite(targetLufs)) throw new Error('narration target loudness is required before gain derivation')
  const gain = 10 ** ((targetLufs - narrationIntegratedLufs) / 20)
  if (!Number.isFinite(gain) || gain <= 0) throw new Error('derived narration gain is not usable')
  return Number(gain.toFixed(6))
}

function parseLoudnormJson(stderr) {
  const blocks = stderr.match(/\{\s*"input_i"[\s\S]*?\}/gu);
  if (!blocks?.length) throw new Error('loudnorm JSON not found in ffmpeg output');
  return JSON.parse(blocks.at(-1));
}

function measureLoudness(filePath) {
  const proc = runProcess('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
  if (proc.status !== 0) {
    throw new Error(`loudness measurement failed for ${filePath}: ${(proc.stderr || '').trim().slice(-500)}`);
  }
  const parsed = parseLoudnormJson(proc.stderr || '');
  const integrated = Number(parsed.input_i);
  if (!Number.isFinite(integrated)) throw new Error(`loudness measurement missing input_i for ${filePath}`);
  return Number(integrated.toFixed(2));
}

async function measureLoudnessAsync(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`loudness measurement failed for ${filePath}: ${stderr.trim().slice(-500)}`));
        return;
      }
      try {
        const parsed = parseLoudnormJson(stderr);
        const integrated = Number(parsed.input_i);
        if (!Number.isFinite(integrated)) throw new Error(`loudness measurement missing input_i for ${filePath}`);
        resolvePromise(Number(integrated.toFixed(2)));
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

export function deriveBgmMix({ narrationIntegratedLufs, bgmIntegratedLufs, bgmDurationSec }) {
  if (!Number.isFinite(narrationIntegratedLufs)) throw new Error('narration loudness measurement is required before props build');
  if (!Number.isFinite(bgmIntegratedLufs)) throw new Error('BGM loudness measurement is required before props build');
  if (!Number.isFinite(bgmDurationSec) || bgmDurationSec <= 0) throw new Error('BGM duration must be positive before props build');
  if (bgmDurationSec + 1e-6 < minHistoryBgmSec) {
    throw new Error(
      `history production requires at least ${minHistoryBgmSec}s of usable BGM audio for safe looping; found ${bgmDurationSec}s`,
    );
  }
  const targetLufs = narrationIntegratedLufs - 14;
  const volume = 10 ** ((targetLufs - bgmIntegratedLufs) / 20);
  if (!Number.isFinite(volume) || volume <= 0) throw new Error('derived BGM volume is not usable');
  if (volume > 0.5) {
    throw new Error(
      `derived BGM volume ${volume.toFixed(4)} exceeds the 0.5 ceiling; choose a quieter loop instead of mixing louder BGM`,
    );
  }
  return {
    sourceDurationSec: Number(bgmDurationSec.toFixed(3)),
    volume: Number(volume.toFixed(4)),
    narrationVolume: Number((volume * 0.5).toFixed(4)),
    fadeInSec: 3,
    fadeOutSec: 5,
    loopCrossfadeSec: 4,
    narrationIntegratedLufs: Number(narrationIntegratedLufs.toFixed(2)),
    bgmIntegratedLufs: Number(bgmIntegratedLufs.toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Subtitle splitting — verbatim copy of the history/dharma rule
// ---------------------------------------------------------------------------

function roundMs(value) {
  return Math.max(0, Math.round(value));
}

function splitSubtitle(entry, index) {
  const text = String(entry?.text || '');
  const start = Number(entry?.time_begin);
  const end = Number(entry?.time_end);
  if (!text.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  // Standalone punctuation and boundary whitespace belong to the frozen title timeline.
  const sentences = text.match(/[^，。！？；：、]+[，。！？；：、]?|[，。！？；：、]+/gu) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    if ((current + sentence).length <= 18) {
      current += sentence;
      continue;
    }
    chunks.push(current);
    current = sentence;
  }
  while (current.length > 18) {
    chunks.push(current.slice(0, 18));
    current = current.slice(18);
  }
  if (current) chunks.push(current);
  if (!chunks.length) return [];

  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || text.length;
  let cursor = start;
  return chunks.map((chunk, chunkIndex) => {
    const share = chunk.length / totalChars;
    const next = chunkIndex === chunks.length - 1 ? end : cursor + (end - start) * share;
    const segment = {
      index,
      text: chunk,
      startSec: Number((roundMs(cursor) / 1000).toFixed(3)),
      endSec: Number((roundMs(next) / 1000).toFixed(3)),
      ttsTitleIndex: Number.isInteger(entry?.ttsTitleIndex) ? entry.ttsTitleIndex : index,
    };
    cursor = next;
    return segment;
  });
}

// ---------------------------------------------------------------------------
// Props composition
// ---------------------------------------------------------------------------

// 文字呈现版本与 renderer 的 v5 渲染门同源（TEXT_PRESENTATION_VERSION 从
// dharma_comic_native_core.mjs 导入），不再本地硬编码。
const PROPS_SUBTITLE_PRESET = 'ink-read-v2';

// chapter-hooks-v2：顶部章节目录条派生。chapter_hooks 与 full 叙事计划的
// narrative_sequences 按顺序一一对应；hook.anchor 若提供，必须出现在该
// sequence 的旁白文本内（防错配 fail-fast）。label 是写稿阶段确认的悬念
// 钩子，不做截断降级；无 hooks 返回空数组，episode 不出章节条。
export function pairChapterHooks(chapterHooks, sequences) {
  if (!Array.isArray(chapterHooks) || !chapterHooks.length) return [];
  if (chapterHooks.length !== sequences.length) {
    fail(`Chapter hook count (${chapterHooks.length}) does not match narrative sequence count (${sequences.length}); fix chapter_hooks in the publishing package`);
  }
  return chapterHooks.map((hook, index) => {
    const sequence = sequences[index];
    const label = String(hook?.label || '').trim();
    if (!label) fail(`Chapter hook ${index + 1} is missing its label`);
    const anchor = String(hook?.anchor || '').trim();
    if (anchor && !String(sequence.text || '').includes(anchor)) {
      fail(`Chapter hook ${index + 1} (${label}) anchor is not in sequence ${sequence.seqKey || index + 1} narration text`);
    }
    const startMs = Number(sequence.startMs);
    const endMs = Number(sequence.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      fail(`Narrative sequence ${sequence.seqKey || index + 1} has an invalid start/end window for chapter hooks`);
    }
    return {
      label,
      startSec: Number((startMs / 1000).toFixed(3)),
      endSec: Number((endMs / 1000).toFixed(3)),
    };
  });
}

function loadNarrativeSequencesForChapters(episodeId) {
  const db = database();
  try {
    const plan = latestFullPlan(db, episodeId);
    if (!plan) fail(`No full narrative plan exists for episode ${episodeId}`);
    const sequences = db.prepare(`
      select id, seq_key, title, start_ms, end_ms
      from narrative_sequences
      where plan_id = ?
      order by seq_index
    `).all(plan.id);
    const eventText = db.prepare(`
      select group_concat(text, '') as text
      from narration_events
      where sequence_id = ?
      order by event_index
    `);
    return sequences.map((sequence) => ({
      seqKey: sequence.seq_key,
      title: sequence.title,
      startMs: Number(sequence.start_ms),
      endMs: Number(sequence.end_ms),
      text: String(eventText.get(sequence.id)?.text || ''),
    }));
  } finally {
    db.close();
  }
}

export function composeHistoryProps({
  manifest,
  manifestSha256,
  titles,
  style,
  audioPath,
  bgmPath,
  bgm,
  assetFingerprint,
  ttsAudioSha256,
  ttsTitlesSha256,
  bgmSha256,
  episodeId,
  chapters = [],
  resolveAsset = (value) => value,
  statFile = null,
}) {
  if (!manifest || !Array.isArray(manifest.panels)) throw new Error('manifest with panels is required');
  if (!Array.isArray(titles) || !titles.length) throw new Error('TTS titles are required');
  const styleProfile = String(style || '').trim();
  if (!styleProfile) throw new Error('selected visual style is required');
  if (!bgm || typeof bgm !== 'object') throw new Error('BGM mix is required');
  const fps = productionProfile.fps;
  const durationInFrames = Math.max(1, Math.round(manifest.targetDurationSec * fps));
  const narrationEndFrame = Math.round((manifest.narrationEndSec || 0) * fps);
  if (durationInFrames - narrationEndFrame < 0 || durationInFrames - narrationEndFrame > 2 * fps) {
    throw new Error(
      `delivery tail out of range: duration ${durationInFrames} frames vs narration end ${narrationEndFrame} frames`,
    );
  }
  const stat = statFile || ((target) => statSync(target));
  const assertSource = (source, label) => {
    const resolved = resolveAsset(source);
    if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
    if (stat(resolved).size <= 0) throw new Error(`${label} is empty: ${resolved}`);
    return resolved;
  };
  const resolvedAudio = assertSource(audioPath, 'narration audio');
  const resolvedBgm = assertSource(bgmPath, 'BGM audio');
  const resolvedPanels = manifest.panels.map((panel) => ({
    ...panel,
    src: assertSource(panel.src, `panel asset ${panel.key || panel.src}`),
  }));

  const panelEntries = resolvedPanels.map((panel, index) => ({
    key: panel.key,
    src: panel.src,
    focusX: Number.isFinite(panel.focusX) ? panel.focusX : 50,
    focusY: Number.isFinite(panel.focusY) ? panel.focusY : 50,
    emphasisStartFrame: index === 0 ? 0 : Math.round(panel.startSec * fps),
  }));
  if (panelEntries[0]?.emphasisStartFrame !== 0) throw new Error('first panel emphasis must start at frame 0');
  for (let index = 1; index < panelEntries.length; index += 1) {
    if (panelEntries[index].emphasisStartFrame <= panelEntries[index - 1].emphasisStartFrame) {
      throw new Error(`panel emphasis frames must strictly increase (panel ${panelEntries[index].key || index})`);
    }
  }
  for (const panel of panelEntries) {
    if (panel.emphasisStartFrame >= durationInFrames) {
      throw new Error(`panel ${panel.key || panel.src} starts past the episode duration`);
    }
  }

  // One window per frozen TTS title, integer frames — this is the exact shape
  // the independent sync checker (check_dharma_sync.mjs, progressive_five
  // branch) re-derives and compares against; panel-derived windows fail delivery.
  const narrationWindows = titles.map((entry) => ({
    startFrame: Math.round((Number(entry.time_begin) / 1000) * fps),
    endFrame: Math.round((Number(entry.time_end) / 1000) * fps),
  }));
  const spokenSubtitles = titles.flatMap((entry, index) => splitSubtitle(entry, index));
  // dharma-text-v5：display 驻留窗口与 core 同源（computeSubtitleDisplayWindows，
  // ink-read-v2 规则），显式落盘——overlay 侧不允许现算兜底，check_dharma_sync
  // 从冻结 TTS titles 独立重算这些窗口。历史叙事不提取关键词：
  // subtitleKeywords 恒为空数组，Remotion overlay 只出暖白楷体字幕 +
  // SharedAxisZ 句间转场，无 InlineHighlight 描金层（金句恒空同理）。
  const displayWindows = computeSubtitleDisplayWindows(spokenSubtitles, fps);
  const subtitles = spokenSubtitles.map((subtitle, index) => ({
    ...subtitle,
    ...displayWindows[index],
    subtitleKeywords: [],
  }));

  // The native renderer requires a non-empty segments array even though the
  // history visual system is panel-driven; one synthetic hold segment covers
  // the whole timeline and is fully covered by the panels overlay.
  const segments = [{
    kind: 'image',
    src: resolvedPanels[0].src,
    startFrame: 0,
    durationInFrames,
    move: 'hold',
    styleId: styleProfile,
    shotFunction: 'narrative_illustration',
  }];

  return {
    variant: 'progressive_five',
    styleProfile,
    width: productionProfile.width,
    height: productionProfile.height,
    fps,
    durationInFrames,
    audio: resolvedAudio,
    audioStartFrame: 0,
    narrationEndFrame,
    narrationWindows,
    // dharma-text-v5：subtitle 文字层由 Remotion overlay 叠加（DharmaTextOverlay），
    // native renderer 只出 plate 底片；版本与 renderer 的 v5 渲染门同源。
    textPresentationVersion: TEXT_PRESENTATION_VERSION,
    subtitlePreset: PROPS_SUBTITLE_PRESET,
    textLayers: 'overlay',
    bgm: { src: resolvedBgm, ...bgm },
    artifactChain: {
      manifestSha256: manifestSha256 || null,
      assetFingerprint,
      ttsAudioSha256,
      ttsTitlesSha256,
      bgmSha256,
      episodeId,
    },
    segments,
    quotes: [],
    subtitles,
    chapters,
    panels: panelEntries,
  };
}

function loadFrozenTitles(run) {
  const titlesPath = run?.tts?.titlesPath;
  if (!titlesPath || !existsSync(titlesPath)) throw new Error('frozen TTS titles are required before props build');
  const titles = JSON.parse(readFileSync(titlesPath, 'utf8'));
  if (!Array.isArray(titles) || !titles.length) throw new Error('frozen TTS titles must be a non-empty array');
  return titles;
}

function buildProps(runPath, options = {}) {
  const { run, manifest, paths } = loadRunManifest(runPath)
  startStage(run, 'props_build')
  const frozenTts = validateFrozenTtsArtifacts(run.tts)
  if (!frozenTts.passed) fail(frozenTts.errors.join('; '))
  if (!run.assetApproval) fail('Panel assets must be approved before props build')
  const resolved = resolvedPanelAssets(manifest.panels)
  if (!approvalMatchesArtifact(run.assetApproval, paths.contactSheetPath)
    || run.assetApproval.fingerprint !== resolved.fingerprint) {
    fail('Asset approval no longer matches the frozen manifest panel set; rebuild the contact sheet')
  }
  const bgmPath = run.environmentFacts?.bgm?.path ? tryResolveDataPath(run.environmentFacts.bgm.path) : null
  if (!bgmPath) fail('Environment check must pass with a usable BGM file before props build')
  const bgmSha256 = hashFile(bgmPath)
  const narrationIntegratedLufs = measureLoudness(run.tts.audioPath)
  const bgmIntegratedLufs = measureLoudness(bgmPath)
  const bgmDurationSec = Number(run.environmentFacts.bgm.durationSec) || mediaDuration(bgmPath)
  const narrationGain = deriveNarrationGain(narrationIntegratedLufs)
  const bgm = {
    ...deriveBgmMix({
      narrationIntegratedLufs: HISTORY_NARRATION_TARGET_LUFS,
      bgmIntegratedLufs,
      bgmDurationSec,
    }),
    narrationInputIntegratedLufs: Number(narrationIntegratedLufs.toFixed(2)),
    narrationTargetLufs: HISTORY_NARRATION_TARGET_LUFS,
    narrationGain,
  }
  const chapterHooks = run.publishingPackage?.chapter_hooks;
  const chapters = Array.isArray(chapterHooks) && chapterHooks.length
    ? pairChapterHooks(chapterHooks, loadNarrativeSequencesForChapters(run.episodeId))
    : [];
  const props = composeHistoryProps({
    manifest,
    manifestSha256: run.manifestHash,
    titles: loadFrozenTitles(run),
    style: run.style,
    audioPath: run.tts.audioPath,
    bgmPath,
    bgm,
    assetFingerprint: resolved.fingerprint,
    ttsAudioSha256: run.tts.audioSha256,
    ttsTitlesSha256: run.tts.titlesSha256,
    bgmSha256,
    episodeId: run.episodeId,
    chapters,
    resolveAsset: resolveDataPath,
  })
  atomicWriteJson(paths.propsPath, props)
  // dharma-text-v5：显式落盘 Remotion overlay props（display 窗口 + 恒空关键词 +
  // 空金句层），overlayFingerprint 绑定此文件字节，与底片 interval 指纹分离——
  // 缺 display 窗口或 subtitleKeywords 字段时 buildOverlayProps 显式失败。
  const overlayProps = buildOverlayProps(props)
  atomicWriteJson(paths.overlayPropsPath, overlayProps)
  run.props = {
    path: paths.propsPath,
    sha256: hashFile(paths.propsPath),
    fingerprint: resolved.fingerprint,
    manifestSha256: run.manifestHash,
    assetFingerprint: resolved.fingerprint,
    ttsAudioSha256: run.tts.audioSha256,
    ttsTitlesSha256: run.tts.titlesSha256,
    bgmSha256,
    textLayers: 'overlay',
    overlayPropsPath: paths.overlayPropsPath,
    overlayPropsSha256: hashFile(paths.overlayPropsPath),
    narrationEndSec: manifest.narrationEndSec,
    builtAt: new Date().toISOString(),
  }
  // New props invalidate any earlier frame review, which sampled old props.
  delete run.frameApproval
  delete run.frameReviewEscalation
  finishStage(run, 'props_build', {
    durationInFrames: props.durationInFrames,
    panels: props.panels.length,
    subtitles: props.subtitles.length,
    fingerprint: resolved.fingerprint,
  })
  saveRun(runPath, run)
  return { propsPath: paths.propsPath, fingerprint: resolved.fingerprint }
}

// ---------------------------------------------------------------------------
// Frame approval — numeric gate anchored on the candidate bytes
// ---------------------------------------------------------------------------

// The frame review gate is numeric: the deterministic renderer's candidate
// carries every panel and subtitle frame, so approval binds the candidate
// bytes themselves (no frame extraction, no visual inspection).
export function autoApproveFrames(runPath) {
  const { state: run } = loadRun(runPath)
  const paths = runDerivedPaths(runPath)
  if (!run.candidate) fail('Candidate render must complete before frame auto-approval')
  if (!run.props?.path || !existsSync(run.props.path)) fail('Props must be built before frame auto-approval')
  const props = readJson(run.props.path)
  const reviewedCount = Array.isArray(props.panels) ? props.panels.length : 0
  if (!Number.isInteger(reviewedCount) || reviewedCount < 1) fail('Props panels are required for frame auto-approval')
  const candidateSha256 = hashFile(paths.candidatePath)
  if (candidateSha256 !== run.candidate.outputSha256) {
    fail('Candidate bytes changed after render; re-render the candidate')
  }
  run.frameApproval = {
    ...buildVisualApproval({
      actor: 'runner',
      review_tool: 'numeric',
      reviewed_count: reviewedCount,
      reason: 'numeric gate: approval binds the deterministic renderer candidate bytes that carry every panel and subtitle frame',
    }, {
      artifactPath: paths.candidatePath,
      artifactSha256: candidateSha256,
      expectedReviewedCount: reviewedCount,
      fingerprint: run.props?.fingerprint || null,
      extra: { candidateSha256 },
    }),
    approvedAt: new Date().toISOString(),
  }
  saveRun(runPath, run)
  return run.frameApproval
}

// ---------------------------------------------------------------------------
// Native render + candidate adoption（dharma-text-v5：plate + Remotion overlay）
// ---------------------------------------------------------------------------

function nativeResultPathFor(paths) {
  return join(paths.nativeWorkDir, 'result.json')
}

// 校验 renderer result.json 与其直接产物（plate 底片）。dharma-text-v5 起
// history 只走 overlay/plate 模式：props 缺 textLayers='overlay' 即判陈旧，
// 防止 burned 全层产物混进叠加链路。
function readValidPlateResult(paths, props) {
  const nativeResultPath = nativeResultPathFor(paths)
  if (!existsSync(nativeResultPath) || !existsSync(paths.platePath)) return null
  if (props?.textLayers !== 'overlay') return null
  const report = validateNativeResult({
    nativeResultPath,
    deliveryPath: paths.platePath,
    expectedFrames: props.durationInFrames,
    expectedPropsSha256: hashFile(paths.propsPath),
    expectedSfxEventCount: 0,
    expectedNarrationLufs: props.bgm?.narrationIntegratedLufs,
    expectedTextLayers: 'overlay',
  })
  return report.passed ? report : null
}

// candidate 当前性判定：renderer result 绑定当前 plate 字节之外，还要求
// 合成记录绑定 overlay 指纹和当前 plate/candidate 字节。
function readValidNativeResult(runPath) {
  const paths = runDerivedPaths(runPath)
  if (!existsSync(paths.propsPath)) return null
  let props
  try {
    props = readJson(paths.propsPath)
  } catch {
    return null
  }
  if (!Number.isInteger(props?.durationInFrames)) return null
  const plate = readValidPlateResult(paths, props)
  if (!plate) return null
  if (!existsSync(paths.overlayPropsPath) || !existsSync(paths.candidatePath)) return null
  const evidence = readOverlayCompositeEvidence({
    deliveryRecordPath: paths.compositeRecordPath,
    deliveryPath: paths.candidatePath,
    platePath: paths.platePath,
    sequenceDir: paths.overlaySequenceDir,
    expectedFrames: props.durationInFrames,
    expectedFingerprint: overlayFingerprint({ propsSha256: hashFile(paths.overlayPropsPath) }),
    expectedPlateSha256: plate.data.outputSha256,
    propsPath: paths.overlayPropsPath,
    expectedMode: 'remotion-direct',
  })
  if (!evidence) return null
  return { result: plate.data, checks: plate.checks, overlay: evidence }
}

// dharma-text-v6 文字叠加生产编排：复用现有底片
// → Remotion renderMedia 共享内存传帧、VideoToolbox编码、复用原AAC音轨。
// candidate 并落盘合成记录。任一环节失败显式抛错，不回退 ffmpeg 仿制文字层。
export function renderOverlayCandidate({ paths, props, env = process.env }) {
  const rendererPath = join(repoRoot, 'scripts/videoeditor/dharma_comic_native_renderer.mjs')
  if (!existsSync(rendererPath)) fail(`Native comic renderer is missing: ${rendererPath}`)
  if (props?.textLayers !== 'overlay') {
    fail('History props are not in overlay text mode; rebuild props (dharma-text-v6)')
  }
  if (!existsSync(paths.overlayPropsPath)) {
    fail(`Overlay props are missing: ${paths.overlayPropsPath}; rebuild props`)
  }
  let plate = readValidPlateResult(paths, props)
  if (!plate) {
    mkdirSync(dirname(paths.platePath), { recursive: true })
    runProcess('node', [
      rendererPath,
      '--props', paths.propsPath,
      '--output', paths.platePath,
      '--work-dir', paths.nativeWorkDir,
    ], { inherit: true, timeout: 6 * 60 * 60_000, env })
    plate = readValidPlateResult(paths, props)
    if (!plate) fail('Native renderer completed without a valid plate result.json')
  }
  const expectedFrames = Number(props.durationInFrames)
  const composite = renderDirectTextOverlay({
    propsPath: paths.overlayPropsPath,
    platePath: paths.platePath,
    outputPath: paths.candidatePath,
    expectedFrames,
    repoRoot,
  })
  const record = {
    plateSha256: plate.data.outputSha256,
    overlayFingerprint: composite.fingerprint,
    overlayMode: 'remotion-direct',
    renderedFrames: composite.renderedFrames,
    deliverySha256: composite.outputSha256,
    videoEncoder: composite.videoEncoder,
    frames: composite.frames,
    directResultPath: composite.directResultPath,
    directResultSha256: composite.directResultSha256,
    workerSummaryPath: composite.workerSummaryPath,
    workerSummarySha256: composite.workerSummarySha256,
    workerPeakResidentBytes: JSON.parse(readFileSync(composite.workerSummaryPath, 'utf8')).peakResidentBytes,
    composedAt: composite.completedAt,
  }
  atomicWriteJson(paths.compositeRecordPath, record)
  return { ...plate.data, overlay: record }
}

function finishCandidateRender(runPath, run) {
  const paths = runDerivedPaths(runPath)
  const adopted = readValidNativeResult(runPath)
  if (!adopted) return null
  const { result, checks, overlay } = adopted
  run.candidate = {
    path: paths.candidatePath,
    propsSha256: checks.props_sha256,
    outputSha256: overlay.deliverySha256,
    outputBytes: statSync(paths.candidatePath).size,
    frames: checks.duration_frames,
    sfxEventCount: Number(result.sfxEventCount ?? 0),
    narrationLufs: Number.isFinite(Number(result.narrationLufs)) ? Number(result.narrationLufs) : null,
    renderer: result.renderer,
    renderedAt: result.renderedAt || null,
    recordedAt: new Date().toISOString(),
    stageStartedAt: run.stages?.candidate_render?.startedAt || null,
    overlay: {
      fingerprint: overlay.overlayFingerprint,
      frames: overlay.frames,
      plateSha256: overlay.plateSha256,
      composedAt: overlay.composedAt,
    },
  }
  // Adopting an existing candidate must still have an open stage record;
  // finishStage reads startedAt. Guard so recover-candidate on a fresh run
  // (stage never started) does not throw on an undefined startedAt.
  ensureStageOpen(run, 'candidate_render')
  finishStage(run, 'candidate_render', {
    frames: checks.duration_frames,
    outputSha256: overlay.deliverySha256,
    adoptedExisting: run.candidate.stageStartedAt == null,
  })
  saveRun(runPath, run)
  return { run, candidate: run.candidate }
}

function recoverCandidate(runPath) {
  const { state: run } = loadRun(runPath)
  const recovered = finishCandidateRender(runPath, run)
  if (!recovered) {
    fail(`Native render recovery found no valid plate/overlay/candidate evidence chain under ${runDerivedPaths(runPath).runDir}; the output is incomplete and cannot be adopted`)
  }
  return recovered.candidate
}

function renderCandidate(runPath, options = {}) {
  const { state: run } = loadRun(runPath)
  const paths = runDerivedPaths(runPath)
  if (!run.props?.path) fail('Props must be built before rendering')
  const recovered = finishCandidateRender(runPath, run)
  if (recovered) return { adoptedExisting: true }
  startStage(run, 'candidate_render')
  saveRun(runPath, run)
  const props = readJson(paths.propsPath)
  renderOverlayCandidate({ paths, props })
  const finished = finishCandidateRender(runPath, loadRun(runPath).state)
  if (!finished) fail('Overlay candidate finished without a valid plate/sequence/composite evidence chain')
  return { adoptedExisting: false }
}

// ---------------------------------------------------------------------------
// Publish candidate to data/static
// ---------------------------------------------------------------------------

function publishCandidate(runPath) {
  const { state: run } = loadRun(runPath)
  const paths = runDerivedPaths(runPath)
  if (!run.candidate) fail('Candidate render must complete before publish')
  if (!run.assetApproval || !run.frameApproval) fail('Asset and frame approvals are required before publish')
  if (!approvalMatchesArtifact(run.assetApproval, paths.contactSheetPath)) {
    fail('Asset approval no longer matches the current contact sheet bytes')
  }
  if (!approvalMatchesArtifact(run.frameApproval, paths.candidatePath)) {
    fail('Frame approval no longer matches the current candidate bytes')
  }
  const candidateSha256 = hashFile(paths.candidatePath)
  if (candidateSha256 !== run.candidate.outputSha256) {
    fail('Candidate bytes changed after approval; rebuild the approval evidence')
  }
  if (run.frameApproval.candidateSha256 && run.frameApproval.candidateSha256 !== candidateSha256) {
    fail('Frame approval was recorded for a different candidate render')
  }
  startStage(run, 'publish')
  const deliveryPath = deliveryPathForCandidate(candidateSha256)
  if (existsSync(deliveryPath)) {
    if (hashFile(deliveryPath) !== candidateSha256) {
      fail(`Delivery target already exists with different bytes and is immutable: ${deliveryPath}; restore the original file or start a new run`)
    }
    run.publication = {
      deliveryPath,
      sha256: candidateSha256,
      bytes: statSync(deliveryPath).size,
      publishedAt: run.publication?.publishedAt || new Date().toISOString(),
      recoveredExisting: true,
    }
    finishStage(run, 'publish', { deliveryPath, sha256: candidateSha256, recoveredExisting: true })
    saveRun(runPath, run)
    return { deliveryPath, sha256: candidateSha256 }
  }
  mkdirSync(dirname(deliveryPath), { recursive: true })
  const tempPath = `${deliveryPath}.tmp-${process.pid}-${Date.now()}`
  copyFileSync(paths.candidatePath, tempPath)
  if (hashFile(tempPath) !== candidateSha256) {
    rmSync(tempPath, { force: true })
    fail('Delivery copy failed the SHA-256 equality check before rename')
  }
  renameSync(tempPath, deliveryPath)
  run.publication = {
    deliveryPath,
    sha256: candidateSha256,
    bytes: statSync(deliveryPath).size,
    publishedAt: new Date().toISOString(),
    recoveredExisting: false,
  }
  finishStage(run, 'publish', { deliveryPath, sha256: candidateSha256, recoveredExisting: false })
  saveRun(runPath, run)
  return { deliveryPath, sha256: candidateSha256 }
}

// ---------------------------------------------------------------------------
// Delivery verification
// ---------------------------------------------------------------------------

function probeDelivery(videoPath) {
  const result = { probe: null, probeStatus: 1, probeToolError: null }
  try {
    const proc = spawnSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,duration,bit_rate,has_b_frames',
      '-of', 'json',
      videoPath,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    if (proc.error) {
      result.probeToolError = proc.error.message
      return result
    }
    result.probeStatus = proc.status ?? 1
    if (result.probeStatus === 0) result.probe = JSON.parse(proc.stdout || '{}')
  } catch (error) {
    result.probeToolError = error instanceof Error ? error.message : String(error)
  }
  return result
}

function decodeDelivery(videoPath) {
  const result = { decodeStatus: 1, decodeToolError: null, decodedFrames: Number.NaN, blackScanLog: '' }
  try {
    const proc = spawnSync('ffmpeg', [
      '-hide_banner',
      '-i', videoPath,
      '-vf', 'blackdetect=d=0.6:pix_th=0.10',
      '-f', 'null', '-',
      '-progress', 'pipe:1',
    ], { encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 })
    if (proc.error) {
      result.decodeToolError = proc.error.message
      return result
    }
    result.decodeStatus = proc.status ?? 1
    result.decodedFrames = parseProgressFrameCount(proc.stdout || '')
    result.blackScanLog = proc.stderr || ''
  } catch (error) {
    result.decodeToolError = error instanceof Error ? error.message : String(error)
  }
  return result
}

function syncCheckDelivery(run) {
  const result = { syncStatus: 1, syncToolError: null, syncOutput: '' }
  try {
    const proc = spawnSync('node', [
      join(repoRoot, 'scripts/videoeditor/check_dharma_sync.mjs'),
      String(run.episodeId),
      run.props.path,
      '--titles', run.tts.titlesPath,
    ], { encoding: 'utf8', cwd: repoRoot, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 })
    if (proc.error) {
      result.syncToolError = proc.error.message
      return result
    }
    result.syncStatus = proc.status ?? 1
    result.syncOutput = `${proc.stdout || ''}${proc.stderr || ''}`.trim()
  } catch (error) {
    result.syncToolError = error instanceof Error ? error.message : String(error)
  }
  return result
}

function verify(runPath) {
  const { state: run } = loadRun(runPath)
  if (!run.publication) fail('Candidate must be published before delivery verification')
  const deliveryPath = run.publication.deliveryPath
  if (!existsSync(deliveryPath)) fail(`Published delivery is missing: ${deliveryPath}`)
  const deliverySha256 = hashFile(deliveryPath)
  if (deliverySha256 !== run.publication.sha256) {
    fail('Published delivery bytes no longer match the recorded publication SHA-256')
  }
  if (!run.props?.path || !existsSync(run.props.path)) fail('Props are required for delivery verification')
  const props = readJson(run.props.path)
  const propsSha256 = hashFile(run.props.path)
  const candidateSha256 = existsSync(runDerivedPaths(runPath).candidatePath)
    ? hashFile(runDerivedPaths(runPath).candidatePath)
    : null
  startStage(run, 'delivery_verify')
  saveRun(runPath, run)

  const probeResult = probeDelivery(deliveryPath)
  const decodeResult = decodeDelivery(deliveryPath)
  const syncResult = syncCheckDelivery(run)
  let integratedLufs = Number.NaN
  let loudnessError = null
  try {
    integratedLufs = measureLoudness(deliveryPath)
  } catch (error) {
    loudnessError = error instanceof Error ? error.message : String(error)
  }

  const assessment = assessDeliveryQuality({
    probe: probeResult.probe,
    probeStatus: probeResult.probeStatus,
    probeToolError: probeResult.probeToolError,
    expectedFrames: props.durationInFrames,
    expectedFps: props.fps || 30,
    decodeStatus: decodeResult.decodeStatus,
    decodeToolError: decodeResult.decodeToolError,
    decodedFrames: decodeResult.decodedFrames,
    blackScanLog: decodeResult.blackScanLog,
    integratedLufs,
    loudnessError,
    syncStatus: syncResult.syncStatus,
    syncToolError: syncResult.syncToolError,
  })

  const report = {
    ...assessment,
    output: deliveryPath,
    sha256: deliverySha256,
    propsSha256,
    candidateSha256,
    assetSheetSha256: run.assetContactSheet?.artifactSha256 || null,
    ttsAudioSha256: run.tts?.audioSha256 || null,
    ttsTitlesSha256: run.tts?.titlesSha256 || null,
    attempt: (run.verificationHistory?.length || 0) + 1,
    generatedAt: new Date().toISOString(),
    syncOutput: syncResult.syncOutput,
  }
  run.verificationHistory = [...(run.verificationHistory || []), report]
  run.verificationReport = report
  if (report.passed) {
    run.deliveryVerifiedAt = new Date().toISOString()
    finishStage(run, 'delivery_verify', { passed: true, sha256: deliverySha256, attempt: report.attempt })
  } else {
    finishStage(run, 'delivery_verify', {
      passed: false,
      failureClass: report.failureClass,
      attempt: report.attempt,
      blockingErrors: (report.blockingErrors || []).map((error) => error.code),
    })
  }
  saveRun(runPath, run)
  return report
}

// ---------------------------------------------------------------------------
// Episode video_url commit + readback
// ---------------------------------------------------------------------------

export function validateEpisodeVideoUrl(value) {
  return typeof value === 'string' && /^static\/remotion\/[a-z0-9][a-z0-9._-]*\.mp4$/iu.test(value)
}

export function deliveryVideoUrl(deliveryPath) {
  const staticRoot = join(repoRoot, 'data', 'static')
  const resolvedDelivery = resolve(deliveryPath)
  if (!resolvedDelivery.startsWith(`${staticRoot}/`)) {
    fail(`Delivery path is outside data/static: ${deliveryPath}`)
  }
  const url = `static/${relative(staticRoot, resolvedDelivery).split('\\').join('/')}`
  if (!validateEpisodeVideoUrl(url)) fail(`Delivery URL fails the episode contract: ${url}`)
  return url
}

export function commitHistoryComicDeliveryRecord(db, { episodeId, videoUrl, deliverySha256, verificationSha256, runId, publishedAt }) {
  const episode = db.prepare('select id, video_url, metadata from episodes where id = ? and deleted_at is null').get(episodeId)
  if (!episode) fail(`Episode ${episodeId} not found for delivery commit`)
  if (episode.video_url && episode.video_url !== videoUrl) {
    fail(`Episode ${episodeId} already points at a foreign video_url (${episode.video_url}); refusing to overwrite`)
  }
  const metadata = parseEpisodeMetadata(episode.metadata)
  const existing = metadata?.historyComic
  if (episode.video_url === videoUrl) {
    if (!existing || existing.runId !== runId || existing.sha256 !== deliverySha256) {
      fail(`Episode ${episodeId} already has this video_url but the recorded historyComic evidence belongs to a different run or SHA; refusing to claim it`)
    }
    return { episodeId, videoUrl, alreadyCommitted: true, publishedAt: existing.publishedAt }
  }
  const nextMetadata = {
    ...metadata,
    historyComic: {
      runId,
      sha256: deliverySha256,
      verificationSha256,
      publishedAt,
    },
  }
  const result = db.prepare(
    'update episodes set video_url = ?, metadata = ? where id = ? and (video_url is null or video_url = ?)',
  ).run(videoUrl, JSON.stringify(nextMetadata), episodeId, videoUrl)
  if (result.changes !== 1) {
    fail(`Episode ${episodeId} video_url CAS update failed (changes=${result.changes}); another writer raced the publish`)
  }
  return { episodeId, videoUrl, alreadyCommitted: false, publishedAt }
}

export function validateEpisodeReadback(payload, { episodeId, videoUrl }) {
  if (!payload || typeof payload !== 'object') {
    return { passed: false, error: 'readback payload is not an object' }
  }
  const body = payload.data && typeof payload.data === 'object' ? payload.data : payload
  const id = Number(body.id ?? body.episode_id)
  const url = body.video_url ?? body.videoUrl ?? null
  if (!Number.isInteger(id) || id !== episodeId) {
    return { passed: false, error: `readback episode id mismatch: expected ${episodeId}, got ${body.id ?? body.episode_id ?? 'missing'}` }
  }
  if (url !== videoUrl) {
    return { passed: false, error: `readback video_url mismatch: expected ${videoUrl}, got ${url ?? 'missing'}` }
  }
  return { passed: true, data: { id, video_url: url } }
}

function parseEpisodeMetadata(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value) || {}
  } catch {
    return {}
  }
}

export function readEpisodePublishingFacts(episodeId, expectedPackageSha256) {
  const record = readEpisodePublishingPackageRecord(episodeId)
  if (!record) {
    return {
      publishingPackageCurrent: false,
      openingHookPresent: false,
      cliffhangerPresent: false,
      cover4x3Url: null,
      cover3x4Url: null,
      coversCurrent: false,
    }
  }
  const openingHook = String(record.publishingPackage?.opening_hook || record.episode.opening_hook || '').trim()
  const cliffhanger = String(record.publishingPackage?.cliffhanger || record.episode.cliffhanger || '').trim()
  const cover4x3Url = String(record.episode.cover_image_4x3_url || '').trim()
  const cover3x4Url = String(record.episode.cover_image_3x4_url || '').trim()
  const publishingPackageCurrent = Boolean(
    record.publishingPackage
    && openingHook
    && cliffhanger
    && expectedPackageSha256
    && record.packageSha256 === expectedPackageSha256
    && record.recordedSha256 === record.packageSha256,
  )
  return {
    publishingPackageCurrent,
    openingHookPresent: Boolean(openingHook),
    cliffhangerPresent: Boolean(cliffhanger),
    cover4x3Url,
    cover3x4Url,
    coversCurrent: Boolean(cover4x3Url && cover3x4Url),
  }
}

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

async function scheduleEpisodeCover(run, runPath, ratio) {
  const coverState = coverGenerationState(run)
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
  saveRun(runPath, run)
  return taskId
}

async function ensureEpisodeCovers(runPath) {
  const { state: run } = loadRun(runPath)
  if (!run.publishingPackage) throw publishingPackageError('A publishing package is required before cover generation')
  const episodeId = Number(run.episodeId)
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) fail('Cover generation requires a valid episode id')

  const timeoutMs = Number(process.env.HISTORY_COVER_WAIT_TIMEOUT_MS || defaultCoverWaitTimeoutMs)
  const pollIntervalMs = Number(process.env.HISTORY_COVER_POLL_INTERVAL_MS || defaultCoverPollIntervalMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('HISTORY_COVER_WAIT_TIMEOUT_MS must be positive')
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) fail('HISTORY_COVER_POLL_INTERVAL_MS must be non-negative')
  const deadline = Date.now() + timeoutMs

  let covers = await request(`/episodes/${episodeId}/covers`)
  const coverState = coverGenerationState(run)
  run.coverGeneration = {
    ...coverState,
    episodeId,
    packageSha256: run.publishingPackageSha256,
    startedAt: coverState.startedAt || new Date().toISOString(),
  }
  saveRun(runPath, run)

  while (true) {
    const missing = coverRatios.filter(({ ratio }) => !coverUrl(covers, ratio))
    if (!missing.length) {
      run.coverGeneration.completedAt = new Date().toISOString()
      run.coverGeneration.urls = Object.fromEntries(
        coverRatios.map(({ ratio }) => [ratio, coverUrl(covers, ratio)]),
      )
      saveRun(runPath, run)
      return covers
    }

    for (const { ratio } of missing) {
      const currentTaskId = Number(run.coverGeneration.tasks[ratio] || 0)
      if (currentTaskId > 0) {
        const task = await request(`/tasks/${currentTaskId}`)
        if (!task) fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} no longer exists`)
        if (task.status === 'succeeded') {
          fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} succeeded without a cover URL`)
        }
        if (terminalStatuses.has(task.status)) {
          delete run.coverGeneration.tasks[ratio]
          run.coverGeneration.lastFailure = {
            ratio,
            taskId: currentTaskId,
            status: task.status,
            error: task.error_message || task.errorMessage || null,
            recordedAt: new Date().toISOString(),
          }
          saveRun(runPath, run)
          fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} ended as ${task.status}: ${task.error_message || task.errorMessage || 'unknown error'}`)
        }
        if (!activeTaskStatuses.has(task.status)) {
          fail(`Episode ${episodeId} cover ${ratio} task ${currentTaskId} has unexpected status ${task.status}`)
        }
        continue
      }
      await scheduleEpisodeCover(run, runPath, ratio)
    }

    if (Date.now() >= deadline) {
      fail(`Episode ${episodeId} covers did not finish within ${Math.round(timeoutMs / 1000)} seconds`)
    }
    if (pollIntervalMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    covers = await request(`/episodes/${episodeId}/covers`)
  }
}

async function publishEpisode(runPath) {
  let { state: run } = loadRun(runPath)
  if (!run.deliveryVerifiedAt || !run.verificationReport?.passed) {
    fail('Delivery must pass verification before episode publish')
  }
  const deliverySha256 = hashFile(run.publication.deliveryPath)
  if (deliverySha256 !== run.verificationReport.sha256 || deliverySha256 !== run.publication.sha256) {
    fail('Delivery bytes changed after verification; re-run verification before publish')
  }
  const publishing = loadEpisodePublishingPackage(run.episodeId)
  if (publishing.sha256 !== run.publishingPackageSha256) {
    fail(`Episode ${run.episodeId} publishing package changed after intake; start a new history run`)
  }
  const videoUrl = deliveryVideoUrl(run.publication.deliveryPath)
  startStage(run, 'episode_publish')
  saveRun(runPath, run)
  await ensureEpisodeCovers(runPath)
  run = loadRun(runPath).state
  const publishingFacts = readEpisodePublishingFacts(run.episodeId, run.publishingPackageSha256)
  if (!publishingFacts.publishingPackageCurrent || !publishingFacts.coversCurrent) {
    fail(`Episode ${run.episodeId} publishing package or both cover URLs are not current after generation`)
  }
  const db = new Database(databasePath())
  let commit
  try {
    commit = commitHistoryComicDeliveryRecord(db, {
      episodeId: run.episodeId,
      videoUrl,
      deliverySha256,
      verificationSha256: run.verificationReport.sha256,
      runId: run.runId,
      publishedAt: run.publication.publishedAt || new Date().toISOString(),
    })
  } finally {
    db.close()
  }
  const readbackPayload = await request(`/episodes/${run.episodeId}`)
  const readback = validateEpisodeReadback(readbackPayload, { episodeId: run.episodeId, videoUrl })
  if (!readback.passed) fail(`Episode readback verification failed: ${readback.error}`)
  run.episodePublication = {
    episodeId: run.episodeId,
    videoUrl,
    sha256: deliverySha256,
    publishedAt: commit.publishedAt,
    readbackVerifiedAt: new Date().toISOString(),
    alreadyCommitted: commit.alreadyCommitted,
  }
  run.completedAt = new Date().toISOString()
  finishStage(run, 'episode_publish', {
    videoUrl,
    alreadyCommitted: commit.alreadyCommitted,
    publishingPackageSha256: run.publishingPackageSha256,
    cover4x3Url: publishingFacts.cover4x3Url,
    cover3x4Url: publishingFacts.cover3x4Url,
  })
  startStage(run, 'complete')
  finishStage(run, 'complete', { videoUrl })
  saveRun(runPath, run)
  return run.episodePublication
}

// ---------------------------------------------------------------------------
// Stage fact collection (the IO twin of deriveRunStatus)
// ---------------------------------------------------------------------------

// A killed process can leave a valid sheet on disk while run.json never
// recorded it (real incident: an orphaned contact sheet sat on disk while
// the approval action reported no sheet available). When the on-disk index
// proves the sheet binds the current manifest panel set, reattach the
// evidence instead of reporting it missing.
function selfHealAssetContactSheet(run, runPath, paths, resolvedAssets) {
  if (run.assetContactSheet || !existsSync(paths.contactSheetPath)) return
  const indexPath = `${paths.contactSheetPath}.json`
  if (!existsSync(indexPath)) return
  try {
    const index = readJson(indexPath)
    const columns = Math.min(5, resolvedAssets.assets.length)
    const expected = resolvedAssets.assets.map((asset, position) => ({
      panel: position + 1,
      key: asset.key,
      row: Math.floor(position / columns) + 1,
      column: (position % columns) + 1,
      sourcePath: asset.sourcePath,
    }))
    if (JSON.stringify(index) !== JSON.stringify(expected)) return
    run.assetContactSheet = {
      path: paths.contactSheetPath,
      indexPath,
      fingerprint: resolvedAssets.fingerprint,
      artifactSha256: hashFile(paths.contactSheetPath),
      indexSha256: hashFile(indexPath),
      generatedAt: statSync(paths.contactSheetPath).mtime.toISOString(),
      selfHealedAt: new Date().toISOString(),
    }
    saveRun(runPath, run)
    appendRunEvent(runPath, { event: 'artifact_self_healed', stage: 'asset_review', artifact: 'asset_contact_sheet' })
  } catch {
    // A partial or unreadable orphan stays orphaned; the contact-sheet action rebuilds it.
  }
}

function collectRunFacts(run, runPath) {
  const paths = runDerivedPaths(runPath)
  const facts = {}
  try {
    Object.assign(facts, readEpisodePublishingFacts(run.episodeId, run.publishingPackageSha256))
  } catch {
    facts.publishingPackageCurrent = false
    facts.openingHookPresent = false
    facts.cliffhangerPresent = false
    facts.cover4x3Url = null
    facts.cover3x4Url = null
    facts.coversCurrent = false
  }
  facts.ttsFrozen = run.tts
    ? validateFrozenTtsArtifacts(run.tts)
    : { passed: false, errors: ['No frozen TTS artifacts recorded'] }

  if (run.narrativePlanReport?.passed) {
    try {
      facts.designMissing = computeMissingDesign(run.episodeId)
    } catch {
      facts.designMissing = null
    }
    try {
      facts.generateMissing = computeMissingPanelStoryboards(run.episodeId, run.style)
    } catch {
      facts.generateMissing = null
    }
  }
  facts.regenQueue = (run.regenRequests || []).map((item) => item.storyboardId)

  facts.manifestPath = paths.manifestPath
  facts.manifestCurrent = false
  let manifest = null
  if (run.manifestHash && existsSync(paths.manifestPath)) {
    try {
      const raw = readFileSync(paths.manifestPath, 'utf8')
      if (hash(raw) === run.manifestHash
        && run.manifestTtsAudioSha256 === run.tts?.audioSha256
        && run.manifestTtsTitlesSha256 === run.tts?.titlesSha256) {
        manifest = JSON.parse(raw)
        facts.manifestCurrent = true
      }
    } catch {
      facts.manifestCurrent = false
    }
  }

  let resolvedAssets = null
  if (facts.manifestCurrent && manifest) {
    try {
      resolvedAssets = resolvedPanelAssets(manifest.panels)
      facts.assetFingerprint = resolvedAssets.fingerprint
      facts.assetCount = resolvedAssets.assets.length
    } catch (error) {
      facts.assetError = error instanceof Error ? error.message : String(error)
    }
  }
  if (resolvedAssets) {
    selfHealAssetContactSheet(run, runPath, paths, resolvedAssets)
    facts.assetSheetPath = paths.contactSheetPath
    facts.assetSheetCurrent = false
    if (run.assetContactSheet && existsSync(paths.contactSheetPath)) {
      const sheetSha256 = hashFile(paths.contactSheetPath)
      facts.assetSheetSha256 = sheetSha256
      facts.assetSheetCurrent = run.assetContactSheet.fingerprint === resolvedAssets.fingerprint
        && run.assetContactSheet.artifactSha256 === sheetSha256
    }
    facts.assetApprovalCurrent = Boolean(run.assetApproval)
      && run.assetApproval.fingerprint === resolvedAssets.fingerprint
      && visualApprovalMatchesArtifact(
        run.assetApproval,
        paths.contactSheetPath,
        run.assetContactSheet?.artifactSha256,
        resolvedAssets.assets.length,
      )
  }

  facts.propsCurrent = false
  if (run.props?.path && existsSync(run.props.path)) {
    try {
      const propsSha256 = hashFile(run.props.path)
      const props = readJson(run.props.path)
      let bgmCurrent = true
      if (run.environmentFacts?.bgm?.path) {
        const bgmPath = tryResolveDataPath(run.environmentFacts.bgm.path)
        bgmCurrent = Boolean(bgmPath) && hashFile(bgmPath) === run.props.bgmSha256
      }
      facts.propsCurrent = run.props.sha256 === propsSha256
        && Number.isFinite(Number(props.bgm?.sourceDurationSec))
        && Number(props.bgm.sourceDurationSec) > 0
        && run.props.manifestSha256 === run.manifestHash
        && run.props.assetFingerprint === facts.assetFingerprint
        && run.props.ttsAudioSha256 === run.tts?.audioSha256
        && run.props.ttsTitlesSha256 === run.tts?.titlesSha256
        && bgmCurrent
    } catch {
      facts.propsCurrent = false
    }
  }

  const adopted = readValidNativeResult(runPath)
  facts.candidateRecoverable = Boolean(adopted)
  facts.candidateCurrent = false
  if (adopted) {
    // The native result binds the plate SHA; the candidate gate must bind the
    // final plate+overlay composite SHA instead.
    facts.candidateSha256 = adopted.overlay.deliverySha256
    facts.candidateCurrent = Boolean(run.candidate)
      && run.candidate.outputSha256 === facts.candidateSha256
      && run.candidate.propsSha256 === adopted.checks.props_sha256
  }

  facts.frameApprovalCurrent = Boolean(run.frameApproval)
    && facts.candidateCurrent === true
    && approvalMatchesArtifact(run.frameApproval, paths.candidatePath)
    && (!run.frameApproval.candidateSha256 || run.frameApproval.candidateSha256 === facts.candidateSha256)

  facts.deliveryExists = Boolean(run.publication?.deliveryPath && existsSync(run.publication.deliveryPath))
  facts.deliveryPublishedOwned = false
  if (facts.deliveryExists) {
    facts.deliverySha256 = hashFile(run.publication.deliveryPath)
    facts.deliveryPublishedOwned = run.publication.sha256 === facts.deliverySha256
  }

  facts.verificationSha256 = run.verificationReport?.sha256 || null
  facts.verificationAttested = Boolean(run.verificationReport)
    && run.verificationReport.passed === true
    && Boolean(run.deliveryVerifiedAt)
  facts.deliveryVerified = facts.verificationAttested

  if (run.publication?.deliveryPath) {
    try {
      facts.expectedEpisodeVideoUrl = deliveryVideoUrl(run.publication.deliveryPath)
    } catch {
      facts.expectedEpisodeVideoUrl = null
    }
  }
  facts.episodePublishedCurrent = false
  if (run.episodePublication) {
    try {
      const db = database()
      try {
        const row = db.prepare('select video_url, metadata from episodes where id = ? and deleted_at is null').get(run.episodeId)
        facts.episodeVideoUrl = row?.video_url || null
        const metadata = parseEpisodeMetadata(row?.metadata)
        facts.episodePublishedCurrent = Boolean(run.completedAt)
          && row?.video_url === facts.expectedEpisodeVideoUrl
          && metadata?.historyComic?.runId === run.runId
          && metadata?.historyComic?.sha256 === facts.deliverySha256
          && facts.publishingPackageCurrent === true
          && facts.coversCurrent === true
      } finally {
        db.close()
      }
    } catch {
      facts.episodePublishedCurrent = false
    }
  }
  return facts
}

function currentRunStatus(runPath, options = {}) {
  const resolvedRunPath = resolve(repoRoot, runPath)
  const { state: run } = loadRun(resolvedRunPath)
  const facts = collectRunFacts(run, resolvedRunPath)
  const status = deriveRunStatus(run, facts)
  status.checks = {
    run_path: resolvedRunPath,
    workflow: run.workflow,
    ...status.checks,
  }
  if (status.status === 'complete') {
    // Final-report fields only; full evidence stays in run.json.
    const report = run.verificationReport || null
    status.verificationReport = report
      ? { passed: report.passed === true, metrics: report.metrics || null }
      : null
    status.delivery = run.publication
      ? { deliveryPath: run.publication.deliveryPath || null, sha256: run.publication.sha256 || null }
      : null
    status.episodePublication = run.episodePublication
      ? { videoUrl: run.episodePublication.videoUrl || null }
      : null
  }
  // Runner/mutation paths log the transition; status/next stay side-effect free.
  if (options.logTransitions !== false) logStatusTransition(resolvedRunPath, status)
  return status
}

// ---------------------------------------------------------------------------
// Action failure / retry / repair
// ---------------------------------------------------------------------------

const actionStages = Object.freeze({
  init: 'intake',
  'check-environment': 'environment_check',
  'verify-tts': 'tts_verify',
  'verify-plan': 'narrative_plan_verify',
  'ensure-design': 'design_ensure',
  'ensure-generate': 'generate_ensure',
  'build-manifest': 'manifest_build',
  'contact-sheet': 'asset_review',
  'auto-approve-assets': 'asset_review',
  'build-props': 'props_build',
  'render-candidate': 'candidate_render',
  'recover-candidate': 'candidate_render',
  'auto-approve-frames': 'frame_review',
  'publish-candidate': 'publish',
  verify: 'delivery_verify',
  'publish-episode': 'episode_publish',
})

const actionFailureCodes = Object.freeze({
  init: 'EPISODE_SNAPSHOT_INVALID',
  'check-environment': 'ENVIRONMENT_INVALID',
  'verify-tts': 'TTS_TIMELINE_MISMATCH',
  'verify-plan': 'NARRATIVE_PLAN_INVALID',
  'ensure-design': 'DESIGN_TASK_FAILED',
  'ensure-generate': 'GENERATE_TASK_FAILED',
  'build-manifest': 'MANIFEST_BUILD_FAILED',
  'contact-sheet': 'ASSET_CONTACT_SHEET_FAILED',
  'auto-approve-assets': 'ASSET_AUTO_APPROVAL_FAILED',
  'build-props': 'PROPS_BUILD_FAILED',
  'render-candidate': 'RENDER_FAILED',
  'recover-candidate': 'NATIVE_RESULT_INVALID',
  'auto-approve-frames': 'FRAME_AUTO_APPROVAL_FAILED',
  'publish-candidate': 'RENDER_FAILED',
  verify: 'DELIVERY_VERIFICATION_FAILED',
  'publish-episode': 'EPISODE_PUBLISH_FAILED',
})

function recordActionFailure(runPath, action, error) {
  const { state: run } = loadRun(runPath)
  assertRunnerRelease(run, runPath)
  const entry = {
    action,
    stage: actionStages[action] || 'unknown',
    errors: [String(error?.message || error)],
    errorCode: error?.errorCode || actionFailureCodes[action] || 'ACTION_FAILED',
    failedAt: new Date().toISOString(),
  }
  run.actionFailure = entry
  run.actionFailureHistory = [...(run.actionFailureHistory || []), entry]
  saveRun(runPath, run)
  appendRunEvent(runPath, {
    event: 'action_failed',
    stage: entry.stage,
    action,
    error_code: entry.errorCode,
    message: entry.errors[0].slice(0, 200),
  })
  return entry
}

function retryRecordedAction(runPath) {
  const { state: run } = loadRun(runPath)
  if (!run.actionFailure) fail('No recorded action failure to retry')
  if (requeueExhaustedFailureCodes.has(run.actionFailure.errorCode)) {
    const requeueCount = run.actionFailure.errorCode === 'DESIGN_INCOMPLETE'
      ? Number(run.designRequeueCount || 0)
      : Number(run.generateRequeueCount || 0)
    if (requeueCount >= defaultGridTaskRequeueLimit) {
      // Retrying cannot resend work once the requeue budget is spent; refuse
      // before touching state so no repair budget or failure history is consumed.
      fail(`${run.actionFailure.errorCode}: the grid task requeue budget is exhausted, so retry-action cannot resend work; nothing was consumed. Use start-new-run --run <path> --actor <name> --reason <text> instead`)
    }
  }
  const action = run.actionFailure.action
  delete run.actionFailure
  saveRun(runPath, run)
  appendRunEvent(runPath, { event: 'action_retried', stage: actionStages[action] || 'unknown', action })
  return { retried: action }
}

const stageRetryClearFields = Object.freeze({
  environment_check: ['environmentReport', 'environmentFacts'],
  tts_verify: ['tts', 'ttsTimelineReport'],
  narrative_plan_verify: ['narrativePlanReport'],
  design_ensure: ['designEvidence'],
  generate_ensure: ['generateEvidence'],
  manifest_build: ['manifestHash', 'manifestFrozenAt', 'manifestTtsAudioSha256', 'manifestTtsTitlesSha256'],
})

function retryFailedStage(runPath) {
  const status = currentRunStatus(runPath)
  if (status.next_action !== 'retry-stage') {
    fail(`Current run is not waiting for a stage retry (next_action: ${status.next_action ?? 'none'})`)
  }
  const stage = status.stage
  const { state: run } = loadRun(runPath)
  run.stageRetryHistory = [...(run.stageRetryHistory || []), { stage, retriedAt: new Date().toISOString() }]
  for (const field of stageRetryClearFields[stage] || []) delete run[field]
  if (stage === 'design_ensure') run.designRequeueCount = 0
  if (stage === 'generate_ensure') run.generateRequeueCount = 0
  saveRun(runPath, run)
  appendRunEvent(runPath, { event: 'stage_retried', stage })
  return { stage }
}

function repairDeliveryVerification(runPath, options) {
  const { state: run } = loadRun(runPath)
  if (!run.verificationReport || run.verificationReport.passed !== false) {
    fail('No failed delivery verification is available to repair')
  }
  const actor = requireTextOption(options, 'actor')
  const reason = requireTextOption(options, 'reason', 8)
  run.verificationRepairHistory = [...(run.verificationRepairHistory || []), {
    actor,
    reason,
    reportAttempt: run.verificationReport.attempt || null,
    sha256: run.verificationReport.sha256 || null,
    repairedAt: new Date().toISOString(),
  }]
  // Clearing the report makes the derive chain require a fresh verification
  // pass against the unchanged delivery bytes.
  delete run.verificationReport
  saveRun(runPath, run)
  appendRunEvent(runPath, { event: 'delivery_repaired', stage: 'delivery_verify' })
  return { repairs: run.verificationRepairHistory.length }
}

// ---------------------------------------------------------------------------
// Machine dispatch + run loop
// ---------------------------------------------------------------------------

async function executeRunMachineAction(runPath, action) {
  switch (action) {
    case 'init': return intakeForRun(runPath)
    case 'check-environment': return checkEnvironment(runPath)
    case 'verify-tts': return verifyTtsForRun(runPath)
    case 'verify-plan': return verifyNarrativePlanForRun(runPath)
    case 'ensure-design': return ensureDesign(runPath)
    case 'ensure-generate': return ensureGenerate(runPath)
    case 'build-manifest': return buildManifestForRun(runPath)
    case 'contact-sheet': return contactSheet(runPath)
    case 'auto-approve-assets': return autoApproveAssets(runPath)
    case 'build-props': return buildProps(runPath)
    case 'render-candidate': return renderCandidate(runPath)
    case 'recover-candidate': return recoverCandidate(runPath)
    case 'auto-approve-frames': return autoApproveFrames(runPath)
    case 'publish-candidate': return publishCandidate(runPath)
    case 'verify': return verify(runPath)
    case 'publish-episode': return publishEpisode(runPath)
    default: {
      const error = new Error(
        `RUNNER_VERSION_MISMATCH: unknown machine action "${action}" — this run was likely written by a newer runner; use that runner or start-new-run`,
      )
      error.errorCode = 'RUNNER_VERSION_MISMATCH'
      throw error
    }
  }
}

async function runUntilGate(runPath, options = {}) {
  assertRunnerRelease(loadRun(runPath).state, runPath)
  const executeMachineAction = async (status) => {
    const action = String(status.next_action || '').trim().split(/\s+/u)[0]
    try {
      if (options.lease) heartbeatRunLease(options.lease)
      await executeRunMachineAction(runPath, action)
      if (options.lease) heartbeatRunLease(options.lease)
    } catch (error) {
      // Version mismatches are operator errors, not action failures: they must
      // never consume repair budgets or pollute actionFailureHistory.
      if (error?.errorCode === 'RUNNER_VERSION_MISMATCH') throw error
      recordActionFailure(runPath, action, error)
    }
  }
  return driveUntilBoundary({
    getStatus: () => currentRunStatus(runPath),
    executeMachineAction,
    pollIntervalMs: options.pollIntervalMs,
    maxRuntimeMs: options.maxRuntimeMs,
  })
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function requireRunPath(options) {
  if (!options.run) fail('Pass --run <path>')
  return resolve(repoRoot, options.run)
}

function usage() {
  console.log(`Usage: node .codex/skills/remotion-history-factory/scripts/history_comic_pipeline.mjs <command> [options]

Commands:
  start --episode <id> [--run <path>]
  run [--episode <id> | --run <path>]
  status --run <path>
  next --run <path>
  advance --run <path>
  retry-action --run <path>
  retry-stage --run <path>
  repair-delivery --run <path> --actor <name> --reason <text>
  start-new-run --run <path> --actor <name> --reason <text>`)
}

async function applyAndContinue(options, effect, extraChecks = {}) {
  const runPath = requireRunPath(options)
  const lease = acquireRunLease(runPath)
  let status
  try {
    assertRunnerRelease(loadRun(runPath).state, runPath)
    await effect(runPath)
    status = await runUntilGate(runPath, { lease })
  } finally {
    releaseRunLease(lease)
  }
  status.checks = { ...status.checks, ...extraChecks }
  emitWorkflowStatus(status)
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  switch (command) {
    case 'start': {
      const { runPath } = startRun(options)
      console.log(JSON.stringify(currentRunStatus(runPath)))
      return
    }
    case 'run': {
      const runPath = options.episode ? startRun(options).runPath : requireRunPath(options)
      const lease = acquireRunLease(runPath)
      let status
      try {
        status = await runUntilGate(runPath, { lease })
      } finally {
        releaseRunLease(lease)
      }
      emitWorkflowStatus(status)
      return
    }
    case 'status':
    case 'next': {
      console.log(JSON.stringify(currentRunStatus(requireRunPath(options), { logTransitions: false })))
      return
    }
    case 'advance': {
      const runPath = requireRunPath(options)
      const status = currentRunStatus(runPath)
      if ((status.action_kind || classifyNextAction(status.next_action)) === 'machine') {
        const action = String(status.next_action || '').trim().split(/\s+/u)[0]
        const lease = acquireRunLease(runPath)
        try {
          assertRunnerRelease(loadRun(runPath).state, runPath)
          try {
            await executeRunMachineAction(runPath, action)
          } catch (error) {
            if (error?.errorCode === 'RUNNER_VERSION_MISMATCH') throw error
            recordActionFailure(runPath, action, error)
          }
        } finally {
          releaseRunLease(lease)
        }
      }
      emitWorkflowStatus(currentRunStatus(runPath))
      return
    }
    case 'retry-action':
      return applyAndContinue(options, (runPath) => retryRecordedAction(runPath))
    case 'retry-stage':
      return applyAndContinue(options, (runPath) => retryFailedStage(runPath))
    case 'repair-delivery':
      return applyAndContinue(options, (runPath) => repairDeliveryVerification(runPath, options))
    case 'start-new-run': {
      const sourceRunPath = requireRunPath(options)
      const revision = createRevisionRun(sourceRunPath, options)
      const lease = acquireRunLease(revision.runPath)
      let status
      try {
        status = await runUntilGate(revision.runPath, { lease })
      } finally {
        releaseRunLease(lease)
      }
      status.checks = { ...status.checks, revision_of_run_path: sourceRunPath }
      emitWorkflowStatus(status)
      return
    }
    case undefined:
      usage()
      return
    default:
      usage()
      fail(`Unknown command: ${command}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = process.exitCode || 1
  })
}
