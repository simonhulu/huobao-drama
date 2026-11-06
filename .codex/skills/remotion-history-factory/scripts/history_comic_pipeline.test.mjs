import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  acquireRunLease,
  actionFailureRecovery,
  approvalMatchesArtifact,
  autoApproveAssets,
  autoApproveFrames,
  budgets,
  classifyNextAction,
  commitHistoryComicDeliveryRecord,
  compiledExecutionPlan,
  composeHistoryProps,
  createInitialRun,
  deliveryVideoUrl,
  deriveBgmMix,
  deriveNarrationGain,
  deriveRunStatus,
  driveUntilBoundary,
  gridStyleProfileFromRaw,
  migrateRunState,
  pairChapterHooks,
  readEpisodePublishingFacts,
  recoverTransientTaskPoll,
  releaseRunLease,
  runnerExitContract,
  stageRetryRecovery,
  storyboardRegenRecovery,
  styleProfileMismatchReason,
  validateEpisodeReadback,
  validateEpisodeVideoUrl,
  validateFrozenTtsArtifacts,
  verificationFailureRecovery,
  isTransientTaskPollError,
} from './history_comic_pipeline.mjs'
import { validatePanelAssets, validateVisualApproval } from './history_comic_validator.mjs'
import { buildOverlayProps } from '../../remotion-dharma-factory/scripts/dharma_comic_pipeline.mjs'
import { publishingPackageFingerprint } from '../../remotion-dharma-factory/scripts/dharma_publishing_package.mjs'
import { computeSubtitleDisplayWindows } from '../../../../scripts/videoeditor/dharma_comic_native_core.mjs'

const requireFromBackend = createRequire(new URL('../../../../backend/package.json', import.meta.url))
const Database = requireFromBackend('better-sqlite3')
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sha256File = (path) => sha256(readFileSync(path))

test('candidate recovery passes the overlay evidence paths expected by the stage helper', () => {
  const source = readFileSync(join(repoRoot, '.codex/skills/remotion-history-factory/scripts/history_comic_pipeline.mjs'), 'utf8')
  assert.match(
    source,
    /readOverlayCompositeEvidence\(\{\s*deliveryRecordPath: paths\.compositeRecordPath,\s*deliveryPath: paths\.candidatePath/s,
  )
  assert.match(source, /renderDirectTextOverlay\(/, 'new history candidates must use the full Remotion video path')
  assert.match(source, /expectedMode: 'remotion-direct'/, 'recovery must reject a cached legacy subtitle render')
  assert.match(source, /overlayMode: 'remotion-direct'/, 'the chosen render path must be explicit in delivery evidence')
  assert.match(source, /deliverySha256: composite\.outputSha256/)
  assert.match(source, /facts\.candidateSha256 = adopted\.overlay\.deliverySha256/)
  assert.match(source, /state\.publishingPackage = publishing\.package/)
  assert.match(source, /state\.publishingPackageSha256 = publishing\.sha256/)
})

function baseRun(overrides = {}) {
  return {
    version: 1,
    workflow: 'history-comic-five-v1',
    runId: 'run-1',
    planVersion: 'history-comic-plan-v1',
    planHash: 'plan-hash',
    executionPlan: compiledExecutionPlan,
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试集',
    creationToken: 'token-1',
    intakeSnapshot: {
      episodeId: 7,
      dramaId: 3,
      style: 'ink-wash',
      title: '测试集',
      resolvedAt: '2026-07-31T00:00:00.000Z',
    },
    stages: {},
    environmentReport: { passed: true, checks: {} },
    environmentFacts: { bgm: { path: 'static/bgm/loop.mp3', durationSec: 60 } },
    tts: {
      audioPath: '/tmp/tts-audio.wav',
      audioSha256: 'a'.repeat(64),
      titlesPath: '/tmp/tts-titles.json',
      titlesSha256: 'b'.repeat(64),
      titleCount: 10,
      narrationEndSec: 28.5,
    },
    ttsTimelineReport: { passed: true, checks: {} },
    narrativePlanReport: { passed: true, checks: {} },
    manifestHash: 'c'.repeat(64),
    ...overrides,
  }
}

function baseFacts(overrides = {}) {
  return {
    ttsFrozen: { passed: true, errors: [] },
    designMissing: [],
    generateMissing: [],
    regenQueue: [],
    manifestPath: '/tmp/history-comic.manifest.json',
    manifestCurrent: true,
    assetFingerprint: 'fp-1',
    assetCount: 5,
    assetSheetCurrent: true,
    assetSheetPath: '/tmp/assets.jpg',
    assetSheetSha256: 'd'.repeat(64),
    assetApprovalCurrent: true,
    propsCurrent: true,
    candidateCurrent: true,
    candidateRecoverable: false,
    candidateSha256: 'e'.repeat(64),
    frameApprovalCurrent: true,
    deliveryExists: true,
    deliveryPublishedOwned: true,
    deliverySha256: 'f'.repeat(64),
    deliveryVerified: true,
    verificationAttested: true,
    verificationSha256: 'f'.repeat(64),
    episodeVideoUrl: 'static/remotion/history-comic-f.mp4',
    expectedEpisodeVideoUrl: 'static/remotion/history-comic-f.mp4',
    episodePublishedCurrent: true,
    ...overrides,
  }
}

test('deriveRunStatus walks the full gate chain deterministically', () => {
  const run = baseRun()
  const complete = deriveRunStatus(run, baseFacts())
  assert.equal(complete.stage, 'complete')
  assert.equal(complete.status, 'complete')
  assert.equal(complete.next_action, null)
  assert.equal(complete.action_kind, 'terminal')

  const transitions = [
    [{ episodePublishedCurrent: false }, 'episode_publish', 'publish-episode'],
    [{ episodePublishedCurrent: false, deliveryVerified: false, verificationAttested: false }, 'delivery_verify', 'verify'],
    [{ episodePublishedCurrent: false, deliveryVerified: false, verificationAttested: false, deliveryPublishedOwned: false }, 'publish', 'start-new-run'],
    [{ deliveryExists: false }, 'publish', 'publish-candidate'],
    [{ frameApprovalCurrent: false }, 'frame_review', 'auto-approve-frames'],
    [{ candidateCurrent: false, candidateRecoverable: true }, 'candidate_render', 'recover-candidate'],
    [{ candidateCurrent: false }, 'candidate_render', 'render-candidate'],
    [{ propsCurrent: false }, 'props_build', 'build-props'],
    [{ assetApprovalCurrent: false }, 'asset_review', 'auto-approve-assets'],
    [{ assetSheetCurrent: false }, 'asset_review', 'contact-sheet'],
    [{ assetError: 'panel missing', assetSheetCurrent: false }, 'asset_review', 'start-new-run'],
    [{ manifestCurrent: false }, 'manifest_build', 'start-new-run'],
    [{ generateMissing: [12], manifestCurrent: false }, 'generate_ensure', 'ensure-generate'],
    [{ designMissing: [4], generateMissing: [12], manifestCurrent: false }, 'design_ensure', 'ensure-design'],
  ]
  for (const [factsOverride, stage, nextAction] of transitions) {
    const status = deriveRunStatus(run, baseFacts(factsOverride))
    assert.equal(status.stage, stage, JSON.stringify(factsOverride))
    assert.equal(status.next_action, nextAction, JSON.stringify(factsOverride))
  }

  const assetAutoApprove = deriveRunStatus(run, baseFacts({ assetApprovalCurrent: false }))
  assert.equal(assetAutoApprove.action_kind, 'machine')
  assert.equal(assetAutoApprove.continuation_required, true)
  assert.equal(assetAutoApprove.user_handoff_allowed, false)
  const frameAutoApprove = deriveRunStatus(run, baseFacts({ frameApprovalCurrent: false }))
  assert.equal(frameAutoApprove.action_kind, 'machine')
  assert.equal(frameAutoApprove.continuation_required, true)
  assert.equal(frameAutoApprove.user_handoff_allowed, false)
})

test('deriveRunStatus gates before the artifact chain', () => {
  const run = baseRun()

  const noManifest = baseRun()
  delete noManifest.manifestHash
  assert.equal(deriveRunStatus(noManifest, baseFacts()).next_action, 'build-manifest')

  const generateActive = baseRun({ generateTask: { id: 't1', status: 'running' } })
  const activeGenerate = deriveRunStatus(generateActive, baseFacts())
  assert.equal(activeGenerate.status, 'running')
  assert.equal(activeGenerate.next_action, 'ensure-generate')
  assert.equal(activeGenerate.error_code, 'GENERATE_TASK_ACTIVE')

  const designActive = baseRun({ designTask: { id: 't2', status: 'queued' } })
  assert.equal(deriveRunStatus(designActive, baseFacts({ designMissing: [1] })).next_action, 'ensure-design')

  const regen = deriveRunStatus(run, baseFacts({ regenQueue: [12] }))
  assert.equal(regen.stage, 'generate_ensure')
  assert.equal(regen.next_action, 'ensure-generate')

  const exhaustedByQueue = deriveRunStatus(
    baseRun({ generateAttempts: { 12: budgets.storyboardRegenAttempts } }),
    baseFacts({ regenQueue: [12] }),
  )
  assert.equal(exhaustedByQueue.status, 'failed')
  assert.equal(exhaustedByQueue.error_code, 'IMAGE_RETRY_EXHAUSTED')
  assert.equal(exhaustedByQueue.next_action, 'start-new-run')

  const exhaustedFlag = deriveRunStatus(
    baseRun({ regenExhausted: { storyboardId: 12, attempts: 4 } }),
    baseFacts(),
  )
  assert.equal(exhaustedFlag.error_code, 'IMAGE_RETRY_EXHAUSTED')
  assert.equal(exhaustedFlag.next_action, 'start-new-run')
})

test('design task polling preserves active state across transient fetch failures', () => {
  const error = new TypeError('fetch failed')
  assert.equal(isTransientTaskPollError(error), true)

  const first = recoverTransientTaskPoll({ id: 26774, status: 'running' }, error, 2)
  assert.equal(first.status, 'running')
  assert.equal(first.pollFailures, 1)
  assert.match(first.lastPollError, /fetch failed/)

  const second = recoverTransientTaskPoll(first, new Error('network error'), 2)
  assert.equal(second.status, 'running')
  assert.equal(second.pollFailures, 2)
  assert.equal(recoverTransientTaskPoll(second, error, 2), null)
  assert.equal(isTransientTaskPollError(new Error('404 returned')), false)
})

test('episode publication gates on the database package and both cover URLs', () => {
  const packageMissing = deriveRunStatus(
    baseRun(),
    baseFacts({ publishingPackageCurrent: false }),
  )
  assert.equal(packageMissing.stage, 'episode_publish')
  assert.equal(packageMissing.error_code, 'EPISODE_PUBLISHING_PACKAGE_REQUIRED')
  assert.equal(packageMissing.next_action, 'start-new-run')

  const coversMissing = deriveRunStatus(
    baseRun(),
    baseFacts({ publishingPackageCurrent: true, coversCurrent: false }),
  )
  assert.equal(coversMissing.stage, 'episode_publish')
  assert.equal(coversMissing.error_code, 'EPISODE_COVERS_REQUIRED')
  assert.equal(coversMissing.next_action, 'publish-episode')
})

test('episode publishing facts read the stored package fingerprint and cover URLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-publishing-facts-'))
  const dbPath = join(dir, 'episodes.db')
  const db = new Database(dbPath)
  const publishingPackage = {
    schema_version: 'dharma-publishing-package/v1',
    title: '测试集',
    opening_hook: '开头钩子',
    cliffhanger: '结尾悬念',
    creative_brief: { stance: '测试立场' },
    cover_design: {
      main_title: '测试封面',
      ai_prompt: 'cinematic historical scene, no text, no logo, no watermark',
    },
  }
  const packageSha256 = publishingPackageFingerprint(publishingPackage)
  db.exec(`
    create table episodes (
      id integer primary key,
      title text not null,
      opening_hook text,
      cliffhanger text,
      creative_brief_json text,
      cover_prompt text,
      cover_design_json text,
      cover_image_4x3_url text,
      cover_image_3x4_url text,
      metadata text,
      deleted_at text
    );
  `)
  db.prepare(`
    insert into episodes (id, title, opening_hook, cliffhanger, cover_image_4x3_url, cover_image_3x4_url, metadata)
    values (?, ?, ?, ?, ?, ?, ?)
  `).run(
    7,
    '测试集',
    publishingPackage.opening_hook,
    publishingPackage.cliffhanger,
    'static/covers/test-4x3.png',
    'static/covers/test-3x4.png',
    JSON.stringify({ dharmaPublishing: { package: publishingPackage, package_sha256: packageSha256 } }),
  )
  db.close()

  const previousDbPath = process.env.DB_PATH
  process.env.DB_PATH = dbPath
  try {
    assert.deepEqual(readEpisodePublishingFacts(7, packageSha256), {
      publishingPackageCurrent: true,
      openingHookPresent: true,
      cliffhangerPresent: true,
      cover4x3Url: 'static/covers/test-4x3.png',
      cover3x4Url: 'static/covers/test-3x4.png',
      coversCurrent: true,
    })
    assert.equal(readEpisodePublishingFacts(7, '0'.repeat(64)).publishingPackageCurrent, false)
  } finally {
    if (previousDbPath === undefined) delete process.env.DB_PATH
    else process.env.DB_PATH = previousDbPath
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deriveRunStatus budgets report-stage retries and action repairs', () => {
  const envFailed = baseRun({ environmentReport: { passed: false, error_code: 'ENVIRONMENT_INVALID', checks: { errors: ['no ffmpeg'] } } })
  assert.equal(deriveRunStatus(envFailed, baseFacts()).next_action, 'retry-stage')

  const ttsFailed = baseRun({ ttsTimelineReport: { passed: false, error_code: 'TTS_TIMELINE_MISMATCH', checks: {} } })
  assert.equal(deriveRunStatus(ttsFailed, baseFacts()).next_action, 'retry-stage')
  const ttsRetriedOut = baseRun({
    ttsTimelineReport: { passed: false, error_code: 'TTS_TIMELINE_MISMATCH', checks: {} },
    stageRetryHistory: [
      { stage: 'tts_verify', retriedAt: '2026-01-01T00:00:00.000Z' },
      { stage: 'tts_verify', retriedAt: '2026-01-01T00:05:00.000Z' },
    ],
  })
  assert.equal(deriveRunStatus(ttsRetriedOut, baseFacts()).next_action, null)

  const planFailed = baseRun({ narrativePlanReport: { passed: false, error_code: 'NARRATIVE_PLAN_INVALID', checks: {} } })
  assert.equal(deriveRunStatus(planFailed, baseFacts()).next_action, 'retry-stage')

  const withFailure = baseRun({
    actionFailure: {
      action: 'render-candidate',
      stage: 'candidate_render',
      errors: ['renderer crashed'],
      errorCode: 'RENDER_FAILED',
      failedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  const retry = deriveRunStatus(withFailure, baseFacts())
  assert.equal(retry.status, 'failed')
  assert.equal(retry.next_action, 'retry-action')
  assert.equal(retry.error_code, 'RENDER_FAILED')

  const repairedOut = baseRun({
    actionFailure: {
      action: 'render-candidate',
      stage: 'candidate_render',
      errors: ['renderer crashed'],
      errorCode: 'RENDER_FAILED',
      failedAt: '2026-01-01T00:00:00.000Z',
    },
    actionFailureHistory: [
      { action: 'render-candidate', errorCode: 'RENDER_FAILED' },
      { action: 'render-candidate', errorCode: 'RENDER_FAILED' },
    ],
  })
  assert.equal(deriveRunStatus(repairedOut, baseFacts()).next_action, null)

  // Requeue-budget exhaustion skips the structurally useless retry-action and
  // points straight at start-new-run (real incident: retry-action burned the
  // whole repair budget on no-op rethrows).
  const designExhausted = baseRun({
    designRequeueCount: budgets.gridTaskRequeue,
    actionFailure: {
      action: 'ensure-design',
      stage: 'design_ensure',
      errors: ['grid.episode_design succeeded but sequences still miss design_json: s1'],
      errorCode: 'DESIGN_INCOMPLETE',
      failedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  const designExhaustedStatus = deriveRunStatus(designExhausted, baseFacts())
  assert.equal(designExhaustedStatus.status, 'failed')
  assert.equal(designExhaustedStatus.error_code, 'DESIGN_INCOMPLETE')
  assert.equal(designExhaustedStatus.next_action, 'start-new-run')
  assert.equal(designExhaustedStatus.checks.requeue_budget_exhausted, true)
  assert.equal(designExhaustedStatus.checks.design_requeue_count, budgets.gridTaskRequeue)

  const generateExhausted = baseRun({
    generateRequeueCount: budgets.gridTaskRequeue,
    actionFailure: {
      action: 'ensure-generate',
      stage: 'generate_ensure',
      errors: ['grid.episode_generate succeeded but storyboards still miss panel images: 12'],
      errorCode: 'GENERATE_INCOMPLETE',
      failedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  const generateExhaustedStatus = deriveRunStatus(generateExhausted, baseFacts())
  assert.equal(generateExhaustedStatus.next_action, 'start-new-run')
  assert.equal(generateExhaustedStatus.checks.requeue_budget_exhausted, true)

  const missingEnv = baseRun()
  delete missingEnv.environmentReport
  assert.equal(deriveRunStatus(missingEnv, baseFacts()).next_action, 'check-environment')

  const noTts = baseRun()
  delete noTts.tts
  delete noTts.ttsTimelineReport
  assert.equal(deriveRunStatus(noTts, baseFacts({ ttsFrozen: { passed: false, errors: ['missing'] } })).next_action, 'verify-tts')

  const noPlan = baseRun()
  delete noPlan.narrativePlanReport
  assert.equal(deriveRunStatus(noPlan, baseFacts()).next_action, 'verify-plan')

  const noIntake = baseRun()
  delete noIntake.intakeSnapshot
  assert.equal(deriveRunStatus(noIntake, baseFacts()).next_action, 'init')
})

test('failed statuses carry a lesson path and ready statuses never do', () => {
  const failed = deriveRunStatus(baseRun({
    actionFailure: {
      action: 'render-candidate',
      stage: 'candidate_render',
      errors: ['renderer crashed'],
      errorCode: 'RENDER_FAILED',
      failedAt: '2026-01-01T00:00:00.000Z',
    },
  }), baseFacts())
  assert.equal(failed.status, 'failed')
  assert.match(failed.checks.lesson_path, /references\/lessons\/render-recovery\.md$/u)

  const ready = deriveRunStatus(baseRun(), baseFacts({ assetApprovalCurrent: false }))
  assert.equal(ready.status, 'ready')
  assert.equal('lesson_path' in ready.checks, false)

  const complete = deriveRunStatus(baseRun(), baseFacts())
  assert.equal(complete.status, 'complete')
  assert.equal('lesson_path' in complete.checks, false)
})

test('status checks summarize grid tasks and long missing lists', () => {
  const run = baseRun({
    generateTask: {
      id: 1234,
      status: 'running',
      targets: [11, 12],
      raw: { id: 1234, status: 'running', payload: 'x'.repeat(4096) },
    },
  })
  const active = deriveRunStatus(run, baseFacts({ generateMissing: null, manifestCurrent: false }))
  assert.equal(active.error_code, 'GENERATE_TASK_ACTIVE')
  assert.deepEqual(active.checks.generate_task, { id: 1234, status: 'running', error: null })
  assert.equal('raw' in active.checks.generate_task, false)

  const missing = Array.from({ length: 9 }, (_, index) => ({ storyboardId: 100 + index, reasons: ['missing grid_cells'] }))
  const ready = deriveRunStatus(baseRun(), baseFacts({ generateMissing: missing, manifestCurrent: false }))
  assert.equal(ready.checks.generate_missing.count, 9)
  assert.equal(ready.checks.generate_missing.sample.length, 5)
  assert.deepEqual(ready.checks.generate_missing.sample[0], { storyboard_id: 100, reasons: ['missing grid_cells'] })

  const designMissing = Array.from({ length: 7 }, (_, index) => ({ sequenceId: index + 1, seqKey: `seq-${index + 1}` }))
  const designReady = deriveRunStatus(baseRun(), baseFacts({ designMissing, generateMissing: missing, manifestCurrent: false }))
  assert.equal(designReady.checks.design_missing.count, 7)
  assert.deepEqual(designReady.checks.design_missing.sample, ['seq-1', 'seq-2', 'seq-3', 'seq-4', 'seq-5'])

  const unknown = deriveRunStatus(baseRun(), baseFacts({ designMissing: null, generateMissing: null, manifestCurrent: false }))
  assert.equal(unknown.checks.design_missing, null)
  const generateUnknown = deriveRunStatus(baseRun(), baseFacts({ designMissing: [], generateMissing: null, manifestCurrent: false }))
  assert.equal(generateUnknown.checks.generate_missing, null)
})

test('style-bound grid cells are recognized as stale generation targets', () => {
  assert.equal(
    gridStyleProfileFromRaw(JSON.stringify({ styleProfile: 'y2k-film-bedroom-snapshot', cells: [] })),
    'y2k-film-bedroom-snapshot',
  )
  assert.equal(gridStyleProfileFromRaw('{not-json}'), null)
  assert.equal(
    styleProfileMismatchReason('y2k-film-bedroom-snapshot', 'japanese-cel-animation-twilight'),
    'style profile y2k-film-bedroom-snapshot does not match expected japanese-cel-animation-twilight',
  )
  assert.equal(styleProfileMismatchReason('japanese_cel_animation_twilight', 'japanese-cel-animation-twilight'), null)
  assert.equal(styleProfileMismatchReason('japanese-cel-animation-twilight', 'japanese-cel-animation-twilight'), null)
  assert.equal(styleProfileMismatchReason(null, ''), null)
})

test('failed verification bound to the current delivery follows the retry chain', () => {
  const deterministic = baseRun({
    verificationReport: { passed: false, sha256: 'f'.repeat(64), failureClass: 'deterministic', retryable: false, attempt: 1 },
  })
  const failed = deriveRunStatus(deterministic, baseFacts({ deliveryVerified: false, verificationAttested: false }))
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error_code, 'DELIVERY_VERIFICATION_FAILED')
  assert.equal(failed.next_action, 'start-new-run')

  const transientAttempt2 = baseRun({
    verificationReport: {
      passed: false,
      sha256: 'f'.repeat(64),
      failureClass: 'transient',
      retryable: true,
      attempt: 2,
      retryableErrors: [{ code: 'DECODE_TOOL_FAILED', retryable: true }],
    },
  })
  const retryVerify = deriveRunStatus(transientAttempt2, baseFacts({ deliveryVerified: false, verificationAttested: false }))
  assert.equal(retryVerify.status, 'running')
  assert.equal(retryVerify.next_action, 'verify')

  const transientAttempt3 = baseRun({
    verificationReport: {
      passed: false,
      sha256: 'f'.repeat(64),
      failureClass: 'transient',
      retryable: true,
      attempt: 3,
      retryableErrors: [{ code: 'DECODE_TOOL_FAILED', retryable: true }],
    },
  })
  const repair = deriveRunStatus(transientAttempt3, baseFacts({ deliveryVerified: false, verificationAttested: false }))
  assert.equal(repair.next_action, 'repair-delivery')

  const repairedTwice = baseRun({
    verificationReport: {
      passed: false,
      sha256: 'f'.repeat(64),
      failureClass: 'transient',
      retryable: true,
      attempt: 5,
      retryableErrors: [],
    },
    verificationRepairHistory: [{ repairedAt: 'a' }, { repairedAt: 'b' }],
  })
  assert.equal(deriveRunStatus(repairedTwice, baseFacts({ deliveryVerified: false, verificationAttested: false })).next_action, null)

  // A stale failure report for different delivery bytes must not block the chain.
  const staleReport = baseRun({
    verificationReport: { passed: false, sha256: '0'.repeat(64), failureClass: 'deterministic', retryable: false, attempt: 1 },
  })
  const stale = deriveRunStatus(staleReport, baseFacts({ deliveryVerified: false, verificationAttested: false }))
  assert.equal(stale.next_action, 'verify')
})

test('recovery helpers encode the fixed budgets', () => {
  assert.deepEqual(verificationFailureRecovery({ retryable: false, failureClass: 'deterministic' }), {
    status: 'failed',
    nextAction: 'start-new-run',
  })
  assert.deepEqual(
    verificationFailureRecovery({ retryable: true, failureClass: 'transient', attempt: 1 }),
    { status: 'running', nextAction: 'verify' },
  )
  assert.deepEqual(
    verificationFailureRecovery({ retryable: true, failureClass: 'transient', attempt: 3 }, 0),
    { status: 'failed', nextAction: 'repair-delivery' },
  )
  assert.deepEqual(
    verificationFailureRecovery({ retryable: true, failureClass: 'transient', attempt: 5 }, 2),
    { status: 'failed', nextAction: null },
  )

  assert.equal(actionFailureRecovery({ action: 'verify', errorCode: 'X' }, []).nextAction, 'retry-action')
  assert.equal(actionFailureRecovery({ action: 'verify', errorCode: 'X' }, [
    { action: 'verify', errorCode: 'X' },
    { action: 'verify', errorCode: 'X' },
  ]).nextAction, null)

  assert.equal(stageRetryRecovery({ stage: 'tts_verify', history: [] }).nextAction, 'retry-stage')
  assert.equal(stageRetryRecovery({ stage: 'tts_verify', history: [{ stage: 'tts_verify' }] }).nextAction, 'retry-stage')
  assert.equal(stageRetryRecovery({
    stage: 'tts_verify',
    history: [{ stage: 'tts_verify' }, { stage: 'tts_verify' }],
  }).nextAction, null)

  assert.equal(storyboardRegenRecovery(0).retryAvailable, true)
  assert.equal(storyboardRegenRecovery(3).retryAvailable, true)
  assert.equal(storyboardRegenRecovery(4).retryAvailable, false)
  assert.deepEqual(budgets, {
    storyboardRegenAttempts: 4,
    actionRepairs: 2,
    deliveryTransientRetries: 3,
    deliveryRepairs: 2,
    gridTaskRequeue: 1,
    verifyStageRetries: 2,
  })
})

test('next-action classification and exit contract', () => {
  assert.equal(classifyNextAction('init'), 'machine')
  assert.equal(classifyNextAction('publish-episode'), 'machine')
  assert.equal(classifyNextAction('auto-approve-assets'), 'machine')
  assert.equal(classifyNextAction('auto-approve-frames'), 'machine')
  assert.equal(classifyNextAction('start-new-run'), 'agent')
  assert.equal(classifyNextAction(null), 'terminal')
  assert.equal(classifyNextAction(''), 'terminal')
  assert.throws(() => classifyNextAction('review-assets'), /Unclassified next action/u)
  assert.throws(() => classifyNextAction('bogus'), /Unclassified next action/u)

  assert.deepEqual(runnerExitContract({ user_handoff_allowed: true }), { exitCode: 0, marker: null })
  const continuation = runnerExitContract({ user_handoff_allowed: false })
  assert.equal(continuation.exitCode, 75)
  assert.match(continuation.marker, /AGENT_CONTINUATION_REQUIRED/u)
})

test('driveUntilBoundary executes machine actions and stops at an agent boundary', async () => {
  const statuses = [
    { status: 'ready', next_action: 'init', action_kind: 'machine' },
    { status: 'ready', next_action: 'check-environment', action_kind: 'machine' },
    { status: 'failed', next_action: 'retry-action', action_kind: 'agent' },
  ]
  const executed = []
  let calls = 0
  const result = await driveUntilBoundary({
    getStatus: async () => statuses[Math.min(calls++, statuses.length - 1)],
    executeMachineAction: async (status) => { executed.push(status.next_action) },
    pollIntervalMs: 0,
  })
  assert.equal(result.next_action, 'retry-action')
  assert.deepEqual(executed, ['init', 'check-environment'])

  const paused = await driveUntilBoundary({
    getStatus: async () => ({ status: 'ready', next_action: 'init', action_kind: 'machine', checks: {} }),
    executeMachineAction: async () => {},
    maxRuntimeMs: 0,
    pollIntervalMs: 0,
  })
  assert.equal(paused.status, 'paused')
  assert.equal(paused.error_code, 'RUN_DEADLINE_REACHED')
  assert.equal(paused.continuation_required, true)

  const complete = await driveUntilBoundary({
    getStatus: async () => ({ status: 'complete', next_action: null, action_kind: 'terminal' }),
    executeMachineAction: async () => { throw new Error('must not run') },
    pollIntervalMs: 0,
  })
  assert.equal(complete.status, 'complete')
})

test('only one runner owner can hold the run lease; dead owners can be stolen', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-run-lease-'))
  const runPath = join(temp, 'run.json')
  writeFileSync(runPath, '{}')
  const first = acquireRunLease(runPath, { owner: 'owner-a', leaseMs: 60_000 })
  assert.throws(
    () => acquireRunLease(runPath, { owner: 'owner-b', leaseMs: 60_000 }),
    /RUN_LEASE_ACTIVE/u,
  )
  releaseRunLease(first)
  const second = acquireRunLease(runPath, { owner: 'owner-b', leaseMs: 60_000 })
  releaseRunLease(second)

  // A stale lock owned by a dead process with an expired lease is stealable.
  writeFileSync(`${runPath}.lock`, `${JSON.stringify({
    owner: 'dead-owner',
    pid: 99998,
    hostname: 'test-host',
    acquiredAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-01T00:01:00.000Z',
  })}\n`)
  const stolen = acquireRunLease(runPath, { owner: 'owner-c', leaseMs: 60_000 })
  releaseRunLease(stolen)

  // Releasing a lock owned by someone else refuses to delete it.
  writeFileSync(`${runPath}.lock`, `${JSON.stringify({
    owner: 'other-owner',
    pid: process.pid,
    hostname: 'test-host',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })}\n`)
  assert.throws(
    () => releaseRunLease({ lockPath: `${runPath}.lock`, owner: 'owner-d' }),
    /RUN_LEASE_OWNERSHIP_MISMATCH/u,
  )
})

test('frozen TTS and approval evidence become stale when artifact bytes change', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-artifact-chain-'))
  const audioPath = join(temp, 'voice.wav')
  const titlesPath = join(temp, 'titles.json')
  const sheetPath = join(temp, 'sheet.jpg')
  writeFileSync(audioPath, 'audio-v1')
  writeFileSync(titlesPath, '[{"text":"一句"}]')
  writeFileSync(sheetPath, 'sheet-v1')

  const frozen = {
    audioPath,
    audioSha256: sha256File(audioPath),
    titlesPath,
    titlesSha256: sha256File(titlesPath),
  }
  const sheetSha256 = sha256File(sheetPath)
  assert.equal(validateFrozenTtsArtifacts(frozen).passed, true)
  assert.equal(approvalMatchesArtifact({ artifactSha256: sheetSha256 }, sheetPath), true)

  writeFileSync(audioPath, 'audio-v2')
  writeFileSync(sheetPath, 'sheet-v2')
  assert.equal(validateFrozenTtsArtifacts(frozen).passed, false)
  assert.equal(approvalMatchesArtifact({ artifactSha256: sheetSha256 }, sheetPath), false)
})

function autoApproveRunFixture(temp, overrides = {}) {
  return {
    ...baseRun(),
    planHash: sha256(JSON.stringify(compiledExecutionPlan)),
    manifestTtsAudioSha256: 'a'.repeat(64),
    manifestTtsTitlesSha256: 'b'.repeat(64),
    ...overrides,
  }
}

test('autoApproveAssets records runner numeric approval bound to the current sheet bytes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-auto-approve-assets-'))
  const runPath = join(temp, 'run.json')
  const panels = [0, 1].map((index) => {
    const src = join(temp, `panel-${index}.png`)
    writeFileSync(src, `image-${index}`)
    return { key: `sb-${11 + index}`, src }
  })
  const manifestRaw = `${JSON.stringify({ panels }, null, 2)}\n`
  writeFileSync(join(temp, 'history-comic.manifest.json'), manifestRaw)
  const sheetPath = join(temp, 'history-comic.assets.jpg')
  writeFileSync(sheetPath, 'sheet-v1')
  const resolved = validatePanelAssets(panels, {
    resolveAssetPath: (source) => source,
    statFile: statSync,
    hashFile: sha256File,
    hashValue: sha256,
  })
  assert.equal(resolved.passed, true)
  const run = autoApproveRunFixture(temp, {
    manifestHash: sha256(manifestRaw),
    assetContactSheet: {
      path: sheetPath,
      indexPath: `${sheetPath}.json`,
      fingerprint: resolved.data.fingerprint,
      artifactSha256: sha256File(sheetPath),
      indexSha256: '9'.repeat(64),
      generatedAt: '2026-08-02T00:00:00.000Z',
    },
  })
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)

  const approval = autoApproveAssets(runPath)
  assert.equal(approval.actor, 'runner')
  assert.equal(approval.reviewTool, 'numeric')
  assert.equal(approval.reviewedCount, 2)
  assert.equal(approval.artifactSha256, sha256File(sheetPath))
  assert.equal(approval.fingerprint, resolved.data.fingerprint)
  assert.equal(validateVisualApproval({
    approval,
    artifactPath: sheetPath,
    expectedArtifactSha256: sha256File(sheetPath),
    expectedReviewedCount: 2,
  }).passed, true)
  const persisted = JSON.parse(readFileSync(runPath, 'utf8'))
  assert.equal(persisted.assetApproval.actor, 'runner')
  assert.equal(persisted.assetApproval.reviewTool, 'numeric')

  // Byte changes invalidate the approval; auto-approval refuses until the
  // contact sheet is rebuilt and re-anchors the new bytes.
  writeFileSync(sheetPath, 'sheet-v2')
  assert.equal(approvalMatchesArtifact(persisted.assetApproval, sheetPath), false)
  assert.throws(() => autoApproveAssets(runPath), /rebuild the contact sheet/u)
})

test('autoApproveFrames records runner numeric approval bound to the candidate bytes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-auto-approve-frames-'))
  const runPath = join(temp, 'run.json')
  const candidatePath = join(temp, 'candidate.mp4')
  const propsPath = join(temp, 'history-comic.props.json')
  writeFileSync(candidatePath, 'candidate-v1')
  writeFileSync(propsPath, `${JSON.stringify({ panels: [{ key: 'sb-11' }, { key: 'sb-12' }] }, null, 2)}\n`)
  const run = autoApproveRunFixture(temp, {
    props: { path: propsPath, sha256: sha256File(propsPath), fingerprint: 'fp-1' },
    candidate: { path: candidatePath, outputSha256: sha256File(candidatePath) },
  })
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)

  const approval = autoApproveFrames(runPath)
  assert.equal(approval.actor, 'runner')
  assert.equal(approval.reviewTool, 'numeric')
  assert.equal(approval.reviewedCount, 2)
  assert.equal(approval.artifactSha256, sha256File(candidatePath))
  assert.equal(approval.candidateSha256, sha256File(candidatePath))
  const persisted = JSON.parse(readFileSync(runPath, 'utf8'))
  assert.equal(persisted.frameApproval.actor, 'runner')
  assert.equal(approvalMatchesArtifact(persisted.frameApproval, candidatePath), true)

  // Candidate byte changes invalidate the approval and block re-approval.
  writeFileSync(candidatePath, 'candidate-v2')
  assert.equal(approvalMatchesArtifact(persisted.frameApproval, candidatePath), false)
  assert.throws(() => autoApproveFrames(runPath), /Candidate bytes changed/u)
})

test('createInitialRun derives a deterministic run id and full execution plan', () => {
  const run = createInitialRun({
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试',
    creationToken: 'fixed-token',
  })
  const expectedRunId = createHash('sha1').update('7\nfixed-token').digest('hex').slice(0, 20)
  assert.equal(run.runId, expectedRunId)
  assert.equal(run.workflow, 'history-comic-five-v1')
  assert.equal(run.planVersion, 'history-comic-plan-v1')
  assert.deepEqual(run.executionPlan, compiledExecutionPlan)
  assert.equal(run.executionPlan.length, 15)
  assert.equal(run.stages.intake.episodeId, 7)
})

test('plan migrations invalidate downstream evidence but never failure history', () => {
  const run = createInitialRun({
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试',
    creationToken: 'fixed-token',
  })
  run.environmentReport = { passed: true }
  run.tts = { audioPath: '/a', audioSha256: 'a' }
  run.manifestHash = 'm'
  run.assetRejections = [{ key: 'sb-12', reason: 'bad hand' }]
  run.actionFailureHistory = [{ action: 'verify', errorCode: 'X' }]
  run.stageRetryHistory = [{ stage: 'tts_verify' }]
  run.verificationHistory = [{ passed: false }]
  run.planHash = 'stale-plan-hash'

  const migrated = migrateRunState(run)
  assert.equal(migrated.migrated, true)
  assert.equal(migrated.state.environmentReport, undefined)
  assert.equal(migrated.state.tts, undefined)
  assert.equal(migrated.state.manifestHash, undefined)
  assert.equal(migrated.state.planMigrations.length, 1)
  assert.equal(migrated.state.planMigrations[0].toPlanVersion, 'history-comic-plan-v1')
  assert.deepEqual(migrated.state.assetRejections, [{ key: 'sb-12', reason: 'bad hand' }])
  assert.equal(migrated.state.actionFailureHistory.length, 1)
  assert.equal(migrated.state.stageRetryHistory.length, 1)
  assert.equal(migrated.state.verificationHistory.length, 1)
  assert.equal(migrated.state.stages.intake.episodeId, 7)

  const stable = migrateRunState(migrated.state)
  assert.equal(stable.migrated, false)
  assert.throws(() => migrateRunState({ ...run, workflow: 'other' }), /Unsupported run workflow/u)
  assert.throws(() => migrateRunState({ ...migrated.state, version: 99 }), /Unsupported run state version/u)
})

test('episode delivery commit is transactional, idempotent, and refuses a foreign pointer', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-episode-publish-'))
  const db = new Database(join(temp, 'test.sqlite'))
  try {
    db.exec(`
      create table episodes (
        id integer primary key,
        video_url text,
        metadata text,
        updated_at text,
        deleted_at text
      );
      insert into episodes (id, video_url, metadata, updated_at, deleted_at)
      values (7, null, '{"existing":true}', '2026-01-01T00:00:00.000Z', null);
    `)
    const input = {
      episodeId: 7,
      videoUrl: 'static/remotion/history-comic-abc123def456.mp4',
      deliverySha256: 'd'.repeat(64),
      verificationSha256: 'd'.repeat(64),
      runId: 'run-7',
      publishedAt: '2026-07-31T00:00:00.000Z',
    }
    const first = commitHistoryComicDeliveryRecord(db, input)
    assert.equal(first.alreadyCommitted, false)
    const row = db.prepare('select video_url, metadata from episodes where id = 7').get()
    assert.equal(row.video_url, input.videoUrl)
    assert.equal(JSON.parse(row.metadata).existing, true)
    assert.equal(JSON.parse(row.metadata).historyComic.sha256, input.deliverySha256)
    assert.equal(JSON.parse(row.metadata).historyComic.runId, 'run-7')

    const replay = commitHistoryComicDeliveryRecord(db, { ...input, publishedAt: '2026-08-01T00:00:00.000Z' })
    assert.equal(replay.alreadyCommitted, true)
    assert.equal(replay.publishedAt, input.publishedAt)
    assert.equal(
      JSON.parse(db.prepare('select metadata from episodes where id = 7').get().metadata).historyComic.publishedAt,
      input.publishedAt,
    )

    assert.throws(
      () => commitHistoryComicDeliveryRecord(db, { ...input, runId: 'other-run' }),
      /different run or SHA/u,
    )
    db.prepare('update episodes set video_url = ? where id = 7').run('static/remotion/foreign.mp4')
    assert.throws(() => commitHistoryComicDeliveryRecord(db, input), /foreign video_url/u)
    assert.throws(
      () => commitHistoryComicDeliveryRecord(db, { ...input, episodeId: 99 }),
      /not found/u,
    )
  } finally {
    db.close()
  }
})

test('episode delivery URL is constrained to the frontend remotion media root', () => {
  const deliveryPath = join(repoRoot, 'data/static/remotion/history-comic-abc123def456.mp4')
  assert.equal(deliveryVideoUrl(deliveryPath), 'static/remotion/history-comic-abc123def456.mp4')
  assert.equal(validateEpisodeVideoUrl('static/remotion/history-comic-abc123def456.mp4'), true)
  assert.equal(validateEpisodeVideoUrl('/static/remotion/x.mp4'), false)
  assert.equal(validateEpisodeVideoUrl('static/other/x.mp4'), false)
  assert.equal(validateEpisodeVideoUrl('static/remotion/../x.mp4'), false)
  assert.equal(validateEpisodeVideoUrl('static/remotion/x.mov'), false)
  assert.throws(() => deliveryVideoUrl(join(repoRoot, 'data/temp/x.mp4')), /outside data\/static/u)
})

test('episode readback tolerates envelope and casing variants', () => {
  const videoUrl = 'static/remotion/history-comic-abc123def456.mp4'
  assert.deepEqual(validateEpisodeReadback({ id: 7, video_url: videoUrl }, { episodeId: 7, videoUrl }), {
    passed: true,
    data: { id: 7, video_url: videoUrl },
  })
  assert.equal(validateEpisodeReadback({ data: { episode_id: 7, videoUrl } }, { episodeId: 7, videoUrl }).passed, true)
  assert.equal(validateEpisodeReadback({ id: 8, video_url: videoUrl }, { episodeId: 7, videoUrl }).passed, false)
  assert.equal(validateEpisodeReadback({ id: 7, video_url: null }, { episodeId: 7, videoUrl }).passed, false)
  assert.equal(validateEpisodeReadback(null, { episodeId: 7, videoUrl }).passed, false)
})

function propsFixture(temp) {
  const audioPath = join(temp, 'voice.wav')
  const bgmPath = join(temp, 'bgm.mp3')
  writeFileSync(audioPath, 'narration')
  writeFileSync(bgmPath, 'bgm')
  const panels = [0, 1, 2, 3, 4].map((index) => {
    const src = join(temp, `panel-${index}.png`)
    writeFileSync(src, `image-${index}`)
    return {
      key: `sb-${11 + index}`,
      src,
      startSec: index * 6,
      endSec: (index + 1) * 6,
      ttsTitleStart: index * 2,
      ttsTitleEnd: index * 2 + 1,
    }
  })
  const manifest = {
    contract: 'history-comic-five-manifest-v1',
    factory: 'history-comic-five-v1',
    episodeId: 7,
    dramaId: 3,
    targetDurationSec: 30,
    narrationEndSec: 28.5,
    panels,
  }
  const titles = Array.from({ length: 10 }, (_, index) => ({
    text: `第${index + 1}句`,
    time_begin: index * 2850,
    time_end: (index + 1) * 2850,
  }))
  return { audioPath, bgmPath, manifest, titles }
}

function propsInput(fixture, overrides = {}) {
  return {
    manifest: fixture.manifest,
    manifestSha256: 'm'.repeat(64),
    titles: fixture.titles,
    style: 'ink-wash',
    audioPath: fixture.audioPath,
    bgmPath: fixture.bgmPath,
    bgm: { volume: 0.1, narrationVolume: 0.05, fadeInSec: 3, fadeOutSec: 5, loopCrossfadeSec: 4 },
    assetFingerprint: 'fp-1',
    ttsAudioSha256: 'a'.repeat(64),
    ttsTitlesSha256: 'b'.repeat(64),
    bgmSha256: 'c'.repeat(64),
    episodeId: 7,
    ...overrides,
  }
}

test('composeHistoryProps builds the progressive_five contract with hard invariants', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-props-'))
  const fixture = propsFixture(temp)
  const props = composeHistoryProps(propsInput(fixture))

  assert.equal(props.variant, 'progressive_five')
  assert.equal(props.styleProfile, 'ink-wash')
  assert.equal(props.width, 1280)
  assert.equal(props.height, 720)
  assert.equal(props.fps, 30)
  assert.equal(props.durationInFrames, 900)
  assert.equal(props.narrationEndFrame, 855)
  assert.equal(props.audioStartFrame, 0)
  assert.equal(props.textPresentationVersion, 'dharma-text-v5')
  assert.equal(props.subtitlePreset, 'ink-read-v2')
  assert.equal(props.textLayers, 'overlay')
  assert.deepEqual(props.quotes, [])
  assert.equal(props.segments.length, 1)
  assert.equal(props.segments[0].kind, 'image')
  assert.equal(props.segments[0].move, 'hold')
  assert.equal(props.segments[0].styleId, 'ink-wash')
  assert.equal(props.segments[0].durationInFrames, 900)
  assert.deepEqual(props.artifactChain, {
    manifestSha256: 'm'.repeat(64),
    assetFingerprint: 'fp-1',
    ttsAudioSha256: 'a'.repeat(64),
    ttsTitlesSha256: 'b'.repeat(64),
    bgmSha256: 'c'.repeat(64),
    episodeId: 7,
  })

  assert.equal(props.panels.length, 5)
  assert.equal(props.panels[0].key, 'sb-11')
  assert.equal(props.panels[0].emphasisStartFrame, 0)
  assert.equal(props.panels[0].focusX, 50)
  assert.equal(props.panels[0].focusY, 50)
  assert.deepEqual(props.panels.map((panel) => panel.emphasisStartFrame), [0, 180, 360, 540, 720])

  // One window per frozen TTS title in integer frames — pinned to what the
  // independent sync checker (check_dharma_sync.mjs) re-derives; regression
  // guard against panel-derived windows (which failed real delivery verify).
  assert.equal(props.narrationWindows.length, 10)
  assert.deepEqual(props.narrationWindows[0], { startFrame: 0, endFrame: 86 })
  assert.deepEqual(props.narrationWindows[9], { startFrame: 770, endFrame: 855 })

  assert.equal(props.subtitles.length, 10)
  props.subtitles.forEach((subtitle, index) => {
    assert.equal(subtitle.ttsTitleIndex, index)
    assert.equal(subtitle.text, `第${index + 1}句`)
    assert.ok(subtitle.endSec > subtitle.startSec)
  })
  const rejoined = props.subtitles.map((subtitle) => subtitle.text).join('')
  assert.equal(rejoined, fixture.titles.map((title) => title.text).join(''))
})

test('composeHistoryProps preserves every frozen title character when splitting subtitles', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-subtitle-verbatim-'))
  try {
    const fixture = propsFixture(temp)
    const cases = [
      '；甲',
      '甲，，乙',
      '；，。',
      ' \t甲，乙 \n',
      `； ${'甲'.repeat(40)}。`,
      '； 寫著同樣的文字 （書同文） 走著同樣的道路（車同軌）',
    ]
    for (const text of cases) {
      fixture.titles[0].text = text
      const props = composeHistoryProps(propsInput(fixture))
      const subtitles = props.subtitles.filter((subtitle) => subtitle.ttsTitleIndex === 0)
      assert.equal(subtitles.map((subtitle) => subtitle.text).join(''), text)
      let consumed = 0
      const expectedSpoken = subtitles.map((subtitle) => {
        const startSec = 2.85 * consumed / text.length
        consumed += subtitle.text.length
        const endSec = 2.85 * consumed / text.length
        assert.ok(Math.abs(subtitle.startSec - startSec) <= 0.001)
        assert.ok(Math.abs(subtitle.endSec - endSec) <= 0.001)
        return { startSec, endSec }
      })
      const next = props.subtitles[subtitles.length]
      const expectedDisplay = computeSubtitleDisplayWindows([
        ...expectedSpoken,
        { startSec: next.startSec, endSec: next.endSec },
      ], props.fps)
      subtitles.forEach((subtitle, index) => {
        assert.ok(Math.abs(subtitle.displayStartSec - expectedDisplay[index].displayStartSec) <= 0.001)
        assert.ok(Math.abs(subtitle.displayEndSec - expectedDisplay[index].displayEndSec) <= 0.001)
      })
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('composeHistoryProps emits the dharma-text-v5 overlay subtitle contract', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-props-overlay-'))
  const fixture = propsFixture(temp)
  const props = composeHistoryProps(propsInput(fixture))

  // display 驻留窗口与 core 同源独立重算（check_dharma_sync 的同款推导）：
  // displayStartSec 恒等于 spoken startSec，displayEndSec 应用 +0.35s 驻留、
  // 短间隙减半、与下一句入场重叠 3 帧封顶。
  const spoken = props.subtitles.map((subtitle) => ({
    startSec: subtitle.startSec,
    endSec: subtitle.endSec,
  }))
  const expectedWindows = computeSubtitleDisplayWindows(spoken, props.fps)
  props.subtitles.forEach((subtitle, index) => {
    assert.equal(subtitle.displayStartSec, subtitle.startSec)
    assert.ok(subtitle.displayEndSec > subtitle.displayStartSec)
    assert.equal(subtitle.displayStartSec, expectedWindows[index].displayStartSec)
    assert.equal(subtitle.displayEndSec, expectedWindows[index].displayEndSec)
    // 历史叙事不做关键词描金：恒空数组，契约字段必须存在。
    assert.deepEqual(subtitle.subtitleKeywords, [])
  })

  // overlay props 契约与 dharma 完全同源：缺 display 窗口或 subtitleKeywords
  // 字段即失败；通过时只保留文字层字段，且 quotes 恒空。
  const overlay = buildOverlayProps(props)
  assert.deepEqual(Object.keys(overlay).sort(), [
    'chapters',
    'durationInFrames',
    'fps',
    'height',
    'quotes',
    'subtitles',
    'width',
  ])
  assert.equal(overlay.durationInFrames, props.durationInFrames)
  assert.equal(overlay.subtitles, props.subtitles)
  assert.deepEqual(overlay.quotes, [])
  const missingWindow = structuredClone(props)
  delete missingWindow.subtitles[0].displayStartSec
  assert.throws(() => buildOverlayProps(missingWindow), /display window/u)
})

test('composeHistoryProps rejects tail, ordering, and missing-file violations', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-props-bad-'))
  const fixture = propsFixture(temp)

  const longTail = structuredClone(fixture.manifest)
  longTail.narrationEndSec = 25 // tail 5s -> 150 frames > 60
  assert.throws(() => composeHistoryProps(propsInput(fixture, { manifest: longTail })), /tail out of range/u)

  const flatPanels = structuredClone(fixture.manifest)
  flatPanels.panels[2].startSec = 6 // same emphasis frame as panels[1]
  assert.throws(() => composeHistoryProps(propsInput(fixture, { manifest: flatPanels })), /strictly increase/u)

  const missingSrc = structuredClone(fixture.manifest)
  missingSrc.panels[0].src = join(temp, 'missing.png')
  assert.throws(() => composeHistoryProps(propsInput(fixture, { manifest: missingSrc })), /does not exist/u)

  assert.throws(
    () => composeHistoryProps(propsInput(fixture, { audioPath: join(temp, 'missing.wav') })),
    /does not exist/u,
  )
  assert.throws(
    () => composeHistoryProps(propsInput(fixture, { bgmPath: join(temp, 'missing.mp3') })),
    /does not exist/u,
  )
})

test('deriveBgmMix enforces the 30s floor, the 0.5 ceiling, and the -14 LU offset', () => {
  assert.throws(
    () => deriveBgmMix({ narrationIntegratedLufs: -16, bgmIntegratedLufs: -20, bgmDurationSec: 29.9 }),
    /at least 30s/u,
  )
  const mix = deriveBgmMix({ narrationIntegratedLufs: -16, bgmIntegratedLufs: -10, bgmDurationSec: 30 })
  // target = -30 LUFS; volume = 10^((-30 - -10)/20) = 0.1
  assert.equal(mix.volume, 0.1)
  assert.equal(mix.sourceDurationSec, 30)
  assert.equal(mix.narrationVolume, 0.05)
  assert.equal(mix.fadeInSec, 3)
  assert.equal(mix.fadeOutSec, 5)
  assert.equal(mix.loopCrossfadeSec, 4)
  assert.equal(mix.narrationIntegratedLufs, -16)
  assert.equal(mix.bgmIntegratedLufs, -10)

  assert.throws(
    () => deriveBgmMix({ narrationIntegratedLufs: -16, bgmIntegratedLufs: -36, bgmDurationSec: 60 }),
    /0\.5 ceiling/u,
  )
})

test('deriveNarrationGain normalizes provider-dependent narration to the history delivery target', () => {
  assert.equal(deriveNarrationGain(-24), 1)
  assert.ok(Math.abs(deriveNarrationGain(-13.89) - 0.312) < 0.001)
})

test('pairChapterHooks pairs hooks with narrative sequences in order', () => {
  const sequences = [
    { seqKey: 'seq-01', title: '第一组', startMs: 0, endMs: 12000, text: '公元前119年春,他决定出兵。' },
    { seqKey: 'seq-02', title: '第二组', startMs: 12000, endMs: 25000, text: '补给线被切断之后,军心开始动摇。' },
  ]
  assert.deepEqual(pairChapterHooks([], sequences), [])
  assert.deepEqual(pairChapterHooks(null, sequences), [])
  assert.deepEqual(pairChapterHooks([
    { label: '他为何敢违诏出兵', anchor: '公元前119年春' },
    { label: '补给线被切断之后' },
  ], sequences), [
    { label: '他为何敢违诏出兵', startSec: 0, endSec: 12 },
    { label: '补给线被切断之后', startSec: 12, endSec: 25 },
  ])

  assert.throws(() => pairChapterHooks([{ label: '只有一章' }], sequences), /does not match narrative sequence count/u)
  assert.throws(() => pairChapterHooks([
    { label: '错配', anchor: '这句不在第一段里' },
    { label: '第二章' },
  ], sequences), /anchor is not in sequence seq-01/u)
  assert.throws(() => pairChapterHooks([
    { label: '' },
    { label: '第二章' },
  ], sequences), /missing its label/u)
})
