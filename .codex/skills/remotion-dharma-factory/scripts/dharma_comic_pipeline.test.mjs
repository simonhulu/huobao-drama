import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  acquireRunLease,
  actionFailureRecovery,
  approvalMatchesArtifact,
  buildOverlayProps,
  buildQuoteProps,
  classifyNextAction,
  commitEpisodeDeliveryRecord,
  deliveryVideoUrl,
  deriveNextAction,
  driveUntilBoundary,
  executionSurface,
  releaseRunLease,
  renderOverlayDelivery,
  resolveChapterHooks,
  reviewEscalationMatchesArtifact,
  runnerExitContract,
  ttsFailureRecovery,
  validateFrozenTtsArtifacts,
  validateEpisodeFootageReadback,
  validateEpisodeVideoUrl,
  verificationFailureRecovery,
} from './dharma_comic_pipeline.mjs'
import {
  assessDeliveryQuality,
  extractFfmpegWarnings,
  parseBlackIntervals,
  parseProgressFrameCount,
} from './dharma_comic_validator.mjs'

const requireFromBackend = createRequire(new URL('../../../../backend/package.json', import.meta.url))
const Database = requireFromBackend('better-sqlite3')
const runnerPath = fileURLToPath(new URL('./dharma_comic_pipeline.mjs', import.meta.url))

function pipelineManifest() {
  return {
    panels: Array.from({ length: 5 }, (_, index) => ({
      key: `panel_${index + 1}`,
      referencePanelKeys: [],
    })),
  }
}

function pipelineState(status = 'succeeded') {
  return {
    manifestHash: 'manifest-hash',
    jobs: pipelineManifest().panels.map((panel) => ({
      key: panel.key,
      status,
      attempt: 1,
      ...(status === 'succeeded' ? { localPath: `static/images/${panel.key}.png` } : {}),
    })),
    stages: {},
  }
}

function pipelineFacts(overrides = {}) {
  return {
    manifestHash: 'manifest-hash',
    assetsValid: true,
    assetContactSheetCurrent: true,
    assetApprovalCurrent: true,
    propsCurrent: true,
    deliveryRenderCurrent: true,
    deliveryRenderRecoverable: false,
    deliveryExists: true,
    deliveryOwned: true,
    deliveryVerified: true,
    deliverySha256: 'delivery-hash',
    verificationSha256: 'delivery-hash',
    verificationAttested: true,
    episodePublishedCurrent: true,
    ...overrides,
  }
}

test('comic pipeline derives one deterministic next action for every production gate', () => {
  const manifest = pipelineManifest()
  assert.deepEqual(
    deriveNextAction(manifest, null, pipelineFacts()),
    {
      stage: 'manifest_validate',
      status: 'ready',
      checks: { manifest_hash_matches: null, state_exists: false },
      error_code: 'STATE_REQUIRED',
      next_action: 'init',
      action_kind: 'machine',
      continuation_required: true,
      user_handoff_allowed: false,
    },
  )

  const pending = pipelineState('pending')
  assert.equal(deriveNextAction(manifest, pending, pipelineFacts()).next_action, 'submit')

  const active = pipelineState('submitted')
  active.jobs.forEach((job, index) => { job.taskId = index + 1 })
  assert.equal(deriveNextAction(manifest, active, pipelineFacts()).next_action, 'wait')

  const recoveredSucceeded = pipelineState('succeeded')
  recoveredSucceeded.jobs.forEach((job, index) => {
    job.taskId = index + 1
    delete job.localPath
  })
  assert.equal(deriveNextAction(manifest, recoveredSucceeded, pipelineFacts()).next_action, 'wait')

  const failed = pipelineState('failed')
  assert.equal(deriveNextAction(manifest, failed, pipelineFacts()).next_action, 'retry-failed --key panel_1')

  const completeImages = pipelineState()
  const transitions = [
    [{ assetContactSheetCurrent: false }, 'contact-sheet'],
    [{ assetApprovalCurrent: false }, 'review-assets'],
    [{ propsCurrent: false }, 'build-props'],
    [{ deliveryExists: false, deliveryRenderCurrent: false }, 'render-delivery'],
    [{ deliveryRenderCurrent: false, deliveryRenderRecoverable: true }, 'recover-delivery'],
    [{ deliveryExists: false, deliveryRenderCurrent: false, deliveryRenderRecoverable: false }, 'render-delivery'],
    [{ deliveryExists: true, deliveryRenderCurrent: false, deliveryRenderRecoverable: false }, 'start-new-run'],
    [{ deliveryVerified: false }, 'verify'],
    [{ episodePublishedCurrent: false }, 'publish-episode'],
    [{}, null],
  ]
  for (const [overrides, expected] of transitions) {
    assert.equal(
      deriveNextAction(manifest, completeImages, pipelineFacts(overrides)).next_action,
      expected,
      JSON.stringify(overrides),
    )
  }
})

test('every emitted action has one explicit owner class', () => {
  const cases = [
    ['submit', 'machine'],
    ['wait', 'machine'],
    ['render-delivery', 'machine'],
    ['recover-delivery', 'machine'],
    ['publish-episode', 'machine'],
    ['retry-action', 'agent'],
    ['retry-stage', 'agent'],
    ['repair-delivery', 'agent'],
    ['start-new-run', 'agent'],
    ['complete-manifest --draft a --output b', 'agent'],
    ['review-assets', 'agent'],
    ['decide-assets', 'human'],
    [null, 'terminal'],
  ]
  for (const [action, expected] of cases) {
    assert.equal(classifyNextAction(action), expected, String(action))
  }
  assert.throws(() => classifyNextAction('invented-action'), /Unclassified next action/u)
  assert.equal(executionSurface('create-tts-task'), 'run-lifecycle')
  assert.equal(executionSurface('wait'), 'artifact-pipeline')
  assert.equal(executionSurface('render-delivery'), 'artifact-pipeline')
  assert.equal(executionSurface('recover-delivery'), 'artifact-pipeline')
})

test('runner exits successfully only when user handoff is explicitly allowed', () => {
  assert.deepEqual(runnerExitContract({
    action_kind: 'machine',
    user_handoff_allowed: false,
  }), {
    exitCode: 75,
    marker: 'AGENT_CONTINUATION_REQUIRED: execute next_action and resume the same run; do not return to the user',
  })
  assert.deepEqual(runnerExitContract({
    action_kind: 'agent',
    user_handoff_allowed: false,
  }), {
    exitCode: 75,
    marker: 'AGENT_CONTINUATION_REQUIRED: execute next_action and resume the same run; do not return to the user',
  })
  assert.deepEqual(runnerExitContract({
    action_kind: 'human',
    user_handoff_allowed: true,
  }), { exitCode: 0, marker: null })
  assert.deepEqual(runnerExitContract({
    status: 'complete',
    action_kind: 'terminal',
    user_handoff_allowed: true,
  }), { exitCode: 0, marker: null })
})

test('autonomous driver never returns at submit, wait, or active task state', async () => {
  const statuses = [
    { stage: 'image_submit', status: 'ready', error_code: 'IMAGE_SUBMISSION_REQUIRED', next_action: 'submit', action_kind: 'machine' },
    { stage: 'image_wait', status: 'running', error_code: 'IMAGE_TASKS_ACTIVE', next_action: 'wait', action_kind: 'machine' },
    { stage: 'image_wait', status: 'running', error_code: 'IMAGE_TASKS_ACTIVE', next_action: 'wait', action_kind: 'machine' },
    { stage: 'asset_review', status: 'ready', error_code: 'ASSET_VISUAL_REVIEW_REQUIRED', next_action: 'review-assets', action_kind: 'agent' },
  ]
  const executed = []
  let cursor = 0
  const result = await driveUntilBoundary({
    getStatus: async () => statuses[Math.min(cursor, statuses.length - 1)],
    executeMachineAction: async (status) => {
      executed.push(status.next_action)
      cursor += 1
    },
    sleep: async () => {},
    maxSteps: 10,
  })

  assert.deepEqual(executed, ['submit', 'wait', 'wait'])
  assert.equal(result.error_code, 'ASSET_VISUAL_REVIEW_REQUIRED')
  assert.equal(result.continuation_required ?? true, true)
})

test('asset review is the only visual gate before direct delivery rendering', () => {
  const state = pipelineState()
  const assetReview = deriveNextAction(pipelineManifest(), state, pipelineFacts({
    assetApprovalCurrent: false,
    assetReviewEscalated: false,
  }))
  assert.equal(assetReview.next_action, 'review-assets')
  assert.equal(assetReview.action_kind, 'agent')
  assert.equal(assetReview.continuation_required, true)
  assert.equal(assetReview.user_handoff_allowed, false)

  const assetEscalation = deriveNextAction(pipelineManifest(), state, pipelineFacts({
    assetApprovalCurrent: false,
    assetReviewEscalated: true,
  }))
  assert.equal(assetEscalation.error_code, 'ASSET_HUMAN_REVIEW_REQUIRED')
  assert.equal(assetEscalation.next_action, 'decide-assets')
  assert.equal(assetEscalation.action_kind, 'human')
  assert.equal(assetEscalation.user_handoff_allowed, true)

  assert.throws(() => classifyNextAction('review-frames'), /Unclassified next action/u)
  assert.throws(() => classifyNextAction('publish-candidate'), /Unclassified next action/u)
})

test('an explicit runner deadline pauses without converting work into failure', async () => {
  let executions = 0
  const result = await driveUntilBoundary({
    getStatus: async () => ({
      stage: 'image_wait',
      status: 'running',
      checks: { task_id: 42 },
      error_code: 'IMAGE_TASKS_ACTIVE',
      next_action: 'wait',
      action_kind: 'machine',
    }),
    executeMachineAction: async () => { executions += 1 },
    maxRuntimeMs: 0,
    now: () => 1_000,
  })

  assert.equal(executions, 0)
  assert.equal(result.status, 'paused')
  assert.equal(result.error_code, 'RUN_DEADLINE_REACHED')
  assert.equal(result.next_action, 'wait')
  assert.equal(result.checks.resume_with_same_run, true)
  assert.equal(result.continuation_required, true)
  assert.equal(result.user_handoff_allowed, false)
})

test('quote timing is constrained to the panel frozen TTS title range', () => {
  const titles = [
    { text: '重复金句', time_begin: 0, time_end: 1000 },
    { text: '中间过渡', time_begin: 1000, time_end: 2000 },
    { text: '重复金句', time_begin: 2000, time_end: 3000 },
  ]
  const quotes = buildQuoteProps({
    panels: [{
      key: 'p_003',
      ttsTitleStart: 2,
      ttsTitleEnd: 2,
      quote: { text: '重复金句' },
    }],
  }, titles, 30)

  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].panelKey, 'p_003')
  assert.equal(quotes[0].ttsTitleStart, 2)
  assert.equal(quotes[0].ttsTitleEnd, 2)
  assert.ok(quotes[0].startFrame >= 45, 'quote must anchor near the later 2s occurrence')
  assert.equal(quotes[0].kind, 'theme')
  assert.equal(quotes[0].animationPreset, 'handwrite-pose-v1')
  assert.equal(quotes[0].sfxPreset, 'low-temple-bell-v1')
})

test('typed emphasis events compile to fixed animation and SFX presets', () => {
  const titles = [
    { text: '缘起性空。', time_begin: 0, time_end: 1000 },
    { text: '色即是空。', time_begin: 1000, time_end: 2000 },
    { text: '所谓放下，是不再抓住。', time_begin: 2000, time_end: 4000 },
  ]
  const quotes = buildQuoteProps({
    textEmphasisVersion: 1,
    panels: [
      { key: 'p_001', ttsTitleStart: 0, ttsTitleEnd: 0, quote: { kind: 'theme', text: '缘起性空' } },
      { key: 'p_002', ttsTitleStart: 1, ttsTitleEnd: 1, quote: { kind: 'scripture', text: '色即是空', source: '《心经》' } },
      { key: 'p_003', ttsTitleStart: 2, ttsTitleEnd: 2, quote: { kind: 'explanation', text: '不再抓住' } },
    ],
  }, titles, 30)

  assert.deepEqual(quotes.map(({ kind, animationPreset, sfxPreset }) => ({ kind, animationPreset, sfxPreset: sfxPreset ?? null })), [
    { kind: 'theme', animationPreset: 'handwrite-pose-v1', sfxPreset: 'low-temple-bell-v1' },
    { kind: 'scripture', animationPreset: 'scripture-lines-v1', sfxPreset: 'clear-chime-v1' },
    { kind: 'explanation', animationPreset: 'center-lift-v1', sfxPreset: null },
  ])
})

test('episode delivery publication is transactional, idempotent, and refuses a foreign pointer', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-episode-publish-'))
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
      videoUrl: 'static/remotion/dharma-comic-run-7.mp4',
      deliverySha256: 'd'.repeat(64),
      verificationSha256: 'd'.repeat(64),
      runId: 'run-7',
      propsSha256: 'a'.repeat(64),
      publishedAt: '2026-07-31T00:00:00.000Z',
    }
    const first = commitEpisodeDeliveryRecord(db, input)
    assert.equal(first.videoUrl, input.videoUrl)
    assert.equal(first.idempotent, false)
    const row = db.prepare('select video_url, metadata from episodes where id = 7').get()
    assert.equal(row.video_url, input.videoUrl)
    assert.equal(JSON.parse(row.metadata).existing, true)
    assert.equal(JSON.parse(row.metadata).dharmaComic.deliverySha256, input.deliverySha256)

    const replay = commitEpisodeDeliveryRecord(db, input)
    assert.equal(replay.idempotent, true)
    const replayWithNewClock = commitEpisodeDeliveryRecord(db, {
      ...input,
      publishedAt: '2026-08-01T00:00:00.000Z',
    })
    assert.equal(replayWithNewClock.idempotent, true)
    assert.equal(replayWithNewClock.publishedAt, input.publishedAt)
    assert.equal(JSON.parse(db.prepare('select metadata from episodes where id = 7').get().metadata).dharmaComic.publishedAt, input.publishedAt)

    db.prepare('update episodes set video_url = ? where id = 7').run('static/remotion/foreign.mp4')
    assert.throws(() => commitEpisodeDeliveryRecord(db, input), /already points to a different delivery/u)
  } finally {
    db.close()
  }
})

test('episode delivery URL is constrained to the frontend remotion media root', () => {
  const path = join(process.cwd(), 'data/static/remotion/dharma-comic-run-7.mp4')
  assert.equal(deliveryVideoUrl(path), 'static/remotion/dharma-comic-run-7.mp4')
  assert.equal(validateEpisodeVideoUrl('static/remotion/dharma-comic-run-7.mp4'), 'static/remotion/dharma-comic-run-7.mp4')
  assert.throws(() => deliveryVideoUrl(join(process.cwd(), 'data/temp/x.mp4')), /outside the frontend remotion root/u)
  assert.throws(() => validateEpisodeVideoUrl('/static/remotion/x.mp4'), /static\/remotion/u)
  assert.throws(() => validateEpisodeVideoUrl('static/other/x.mp4'), /static\/remotion/u)
  assert.throws(() => validateEpisodeVideoUrl('static/remotion/../x.mp4'), /static\/remotion/u)
})

test('episode publication accepts completion only after the frontend footage API echoes the pointer', () => {
  assert.deepEqual(validateEpisodeFootageReadback({
    episode_id: 7,
    video_url: 'static/remotion/dharma-comic-run-7.mp4',
  }, {
    episodeId: 7,
    videoUrl: 'static/remotion/dharma-comic-run-7.mp4',
  }), {
    episodeId: 7,
    videoUrl: 'static/remotion/dharma-comic-run-7.mp4',
  })
  assert.throws(() => validateEpisodeFootageReadback({
    episode_id: 7,
    video_url: null,
  }, {
    episodeId: 7,
    videoUrl: 'static/remotion/dharma-comic-run-7.mp4',
  }), /does not expose the published video_url/u)
})

test('episode publication recovers idempotently when footage readback fails after the DB commit', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-episode-readback-retry-'))
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
      values (9, null, '{}', '2026-01-01T00:00:00.000Z', null);
    `)
    const input = {
      episodeId: 9,
      videoUrl: 'static/remotion/dharma-comic-run-9.mp4',
      deliverySha256: 'e'.repeat(64),
      verificationSha256: 'e'.repeat(64),
      runId: 'run-9',
      propsSha256: 'b'.repeat(64),
      publishedAt: '2026-07-31T01:00:00.000Z',
    }
    const committedBeforeReadback = commitEpisodeDeliveryRecord(db, input)
    assert.equal(committedBeforeReadback.idempotent, false)
    assert.throws(() => validateEpisodeFootageReadback({
      episode_id: 9,
      video_url: null,
    }, input), /does not expose the published video_url/u)

    const recovered = commitEpisodeDeliveryRecord(db, {
      ...input,
      publishedAt: '2026-07-31T01:05:00.000Z',
    })
    assert.equal(recovered.idempotent, true)
    assert.equal(recovered.publishedAt, input.publishedAt)
    assert.deepEqual(validateEpisodeFootageReadback({
      episode_id: 9,
      video_url: input.videoUrl,
    }, input), {
      episodeId: 9,
      videoUrl: input.videoUrl,
    })
  } finally {
    db.close()
  }
})

test('old run states are rejected instead of being migrated into the direct-delivery plan', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-legacy-run-'))
  const scriptPath = join(temp, 'input.md')
  writeFileSync(scriptPath, '# 旧 run\n最终净稿。\n')
  const legacy = {
    version: 3,
    workflow: 'comic-progressive-five-v1',
    planVersion: 'comic-production-plan-v6',
    planHash: 'legacy-plan',
    executionPlan: [{ stage: 'candidate_render' }, { stage: 'frame_review' }, { stage: 'publish' }],
  }
  const runPath = join(temp, 'legacy.json')
  writeFileSync(runPath, `${JSON.stringify(legacy)}\n`)
  for (const args of [
    ['next', '--run', runPath],
    ['run', '--script', scriptPath, '--title', '旧 run', '--run', runPath],
  ]) {
    const execution = spawnSync(process.execPath, [runnerPath, ...args], { encoding: 'utf8' })
    assert.notEqual(execution.status, 0)
    assert.match(`${execution.stdout}\n${execution.stderr}`, /Unsupported run state version\/plan/u)
  }
})

test('only one runner owner can hold the run lease', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-run-lease-'))
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
})

test('frozen TTS and approval evidence become stale when artifact bytes change', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-artifact-chain-'))
  const audioPath = join(temp, 'voice.wav')
  const titlesPath = join(temp, 'titles.json')
  const sheetPath = join(temp, 'sheet.jpg')
  writeFileSync(audioPath, 'audio-v1')
  writeFileSync(titlesPath, '[{"text":"一句"}]')
  writeFileSync(sheetPath, 'sheet-v1')

  const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const frozen = {
    taskId: 99,
    audioPath,
    audioSha256: sha256(audioPath),
    titlesPath,
    titlesSha256: sha256(titlesPath),
  }
  const sheetSha256 = sha256(sheetPath)
  assert.equal(validateFrozenTtsArtifacts(frozen).passed, true)
  assert.equal(approvalMatchesArtifact({ artifactSha256: sheetSha256 }, sheetPath), true)

  writeFileSync(audioPath, 'audio-v2')
  writeFileSync(sheetPath, 'sheet-v2')
  assert.equal(validateFrozenTtsArtifacts(frozen).passed, false)
  assert.equal(approvalMatchesArtifact({ artifactSha256: sheetSha256 }, sheetPath), false)
})

test('human review escalation is valid only for the current sheet bytes and an image-capable Agent review', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-review-escalation-'))
  const sheetPath = join(temp, 'sheet.jpg')
  writeFileSync(sheetPath, 'sheet-v1')
  const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const sheetSha256 = sha256(sheetPath)
  const escalation = {
    artifactSha256: sheetSha256,
    actor: 'agent',
    reviewTool: 'view_image',
    reason: '第十二格的人物手部被遮挡，无法可靠判断是否畸形。',
  }

  assert.equal(reviewEscalationMatchesArtifact(escalation, sheetPath, sheetSha256), true)
  assert.equal(reviewEscalationMatchesArtifact({
    ...escalation,
    reviewTool: 'sha256-only',
  }, sheetPath, sheetSha256), false)

  writeFileSync(sheetPath, 'sheet-v2')
  assert.equal(reviewEscalationMatchesArtifact(escalation, sheetPath, sheetSha256), false)
})

test('failed delivery verification cannot repeat against the same immutable delivery', () => {
  const state = pipelineState()
  state.verificationReport = { passed: false, sha256: 'delivery-hash' }
  const result = deriveNextAction(pipelineManifest(), state, pipelineFacts({
    deliveryVerified: false,
    deliverySha256: 'delivery-hash',
  }))
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'DELIVERY_VERIFICATION_FAILED')
  assert.equal(result.next_action, 'start-new-run')
  assert.equal(result.action_kind, 'agent')
  assert.equal(result.continuation_required, true)
  assert.equal(result.user_handoff_allowed, false)
  assert.match(result.checks.lesson_path, /delivery-verification\.md$/u)
})

test('transient delivery verification failure retries the unchanged delivery', () => {
  const state = pipelineState()
  state.verificationReport = {
    passed: false,
    sha256: 'delivery-hash',
    retryable: true,
    failureClass: 'transient',
    attempt: 2,
    retryableErrors: [{ code: 'DECODE_TOOL_FAILED', retryable: true }],
  }
  const result = deriveNextAction(pipelineManifest(), state, pipelineFacts({
    deliveryVerified: false,
    deliverySha256: 'delivery-hash',
  }))
  assert.equal(result.status, 'running')
  assert.equal(result.error_code, 'DELIVERY_VERIFICATION_RETRY_REQUIRED')
  assert.equal(result.next_action, 'verify')
  assert.equal(result.action_kind, 'machine')
  assert.equal(result.user_handoff_allowed, false)
})

test('transient verification has bounded machine and agent repair budgets', () => {
  const report = {
    passed: false,
    sha256: 'delivery-hash',
    retryable: true,
    failureClass: 'transient',
    attempt: 3,
    retryableErrors: [{ code: 'DECODE_TOOL_FAILED', retryable: true }],
  }
  assert.deepEqual(verificationFailureRecovery({ ...report, attempt: 2 }, 0), {
    status: 'running',
    nextAction: 'verify',
  })
  assert.deepEqual(verificationFailureRecovery(report, 0), {
    status: 'failed',
    nextAction: 'repair-delivery',
  })
  assert.deepEqual(verificationFailureRecovery(report, 2), {
    status: 'failed',
    nextAction: null,
  })

  const repairableState = pipelineState()
  repairableState.verificationReport = report
  const repairable = deriveNextAction(pipelineManifest(), repairableState, pipelineFacts({
    deliveryVerified: false,
    deliverySha256: 'delivery-hash',
  }))
  assert.equal(repairable.next_action, 'repair-delivery')
  assert.equal(repairable.action_kind, 'agent')
  assert.equal(repairable.user_handoff_allowed, false)

  repairableState.verificationRepairHistory = [{}, {}]
  const exhausted = deriveNextAction(pipelineManifest(), repairableState, pipelineFacts({
    deliveryVerified: false,
    deliverySha256: 'delivery-hash',
  }))
  assert.equal(exhausted.next_action, null)
  assert.equal(exhausted.action_kind, 'terminal')
  assert.equal(exhausted.user_handoff_allowed, true)
})

test('generic machine-action repair has a fixed terminal budget', () => {
  const failure = { action: 'publish-episode', errorCode: 'EPISODE_PUBLISH_FAILED' }
  assert.equal(actionFailureRecovery(failure, []).nextAction, 'retry-action')
  assert.equal(actionFailureRecovery(failure, [failure]).nextAction, 'retry-action')
  const exhausted = actionFailureRecovery(failure, [failure, failure])
  assert.equal(exhausted.nextAction, null)
  assert.equal(exhausted.repairCount, exhausted.repairLimit)
})

test('TTS retry policy cannot increase attempts forever', () => {
  assert.deepEqual(ttsFailureRecovery({
    taskStatus: 'failed',
    machineRetryCount: 0,
    repairCount: 0,
  }), { status: 'ready', nextAction: 'retry-tts-task' })
  assert.deepEqual(ttsFailureRecovery({
    taskStatus: 'failed',
    machineRetryCount: 1,
    repairCount: 0,
  }), { status: 'failed', nextAction: 'retry-stage' })
  assert.deepEqual(ttsFailureRecovery({
    taskStatus: 'stale',
    machineRetryCount: 1,
    repairCount: 2,
  }), { status: 'failed', nextAction: null })
  assert.deepEqual(ttsFailureRecovery({
    taskStatus: 'canceled',
    machineRetryCount: 0,
    repairCount: 0,
  }), { status: 'failed', nextAction: 'start-new-run' })
})

test('only a terminal failure without a recovery action permits user handoff', () => {
  const state = pipelineState()
  state.manifestHash = 'stale-manifest-hash'
  const result = deriveNextAction(pipelineManifest(), state, pipelineFacts())
  assert.equal(result.status, 'failed')
  assert.equal(result.next_action, null)
  assert.equal(result.action_kind, 'terminal')
  assert.equal(result.continuation_required, false)
  assert.equal(result.user_handoff_allowed, true)
})

test('complete status carries a matching verification attestation', () => {
  const state = pipelineState()
  state.verificationReport = { passed: true, sha256: 'delivery-hash' }
  const result = deriveNextAction(pipelineManifest(), state, pipelineFacts({
    deliverySha256: 'delivery-hash',
    verificationAttested: true,
  }))
  assert.equal(result.status, 'complete')
  assert.equal(result.error_code, 'COMPLETE')
  assert.equal(result.checks.verification_passed, true)
  assert.equal(result.checks.delivery_sha256, 'delivery-hash')
  assert.equal(result.checks.verification_sha256, 'delivery-hash')
  assert.equal(result.checks.episode_published_current, true)
})

test('publishing completion stays blocked until both cover ratios and both descriptions are in the database', () => {
  const state = pipelineState()
  state.verificationReport = { passed: true, sha256: 'delivery-hash' }
  const missingCover = deriveNextAction(pipelineManifest(), state, pipelineFacts({
    publishingPackageGateEnabled: true,
    publishingPackageCurrent: true,
    openingHookPresent: true,
    cliffhangerPresent: true,
    cover4x3Ready: true,
    cover3x4Ready: false,
  }))
  assert.equal(missingCover.next_action, 'publish-episode')
  assert.equal(missingCover.error_code, 'EPISODE_PUBLISHING_PACKAGE_REQUIRED')
  assert.equal(missingCover.checks.cover_3x4_ready, false)

  const complete = deriveNextAction(pipelineManifest(), state, pipelineFacts({
    publishingPackageGateEnabled: true,
    publishingPackageCurrent: true,
    openingHookPresent: true,
    cliffhangerPresent: true,
    cover4x3Ready: true,
    cover3x4Ready: true,
  }))
  assert.equal(complete.status, 'complete')
  assert.equal(complete.error_code, 'COMPLETE')
})

function healthyProbe(overrides = {}) {
  return {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1280,
        height: 720,
        has_b_frames: 0,
        avg_frame_rate: '30/1',
        duration: '10.000000',
        bit_rate: '900000',
      },
      {
        codec_type: 'audio',
        codec_name: 'aac',
        duration: '10.020000',
      },
    ],
    format: { duration: '10.020000' },
    ...overrides,
  }
}

test('ffmpeg codec and conversion diagnostics are deduplicated report warnings', () => {
  const warnings = extractFfmpegWarnings(`
    [swscaler] deprecated pixel format used, make sure you did set range correctly
    [null] Application provided invalid, non monotonically increasing dts
    [null] Application provided invalid, non monotonically increasing dts
    Conversion failed warning from a codec wrapper
  `)

  assert.deepEqual(warnings, [
    '[swscaler] deprecated pixel format used, make sure you did set range correctly',
    '[null] Application provided invalid, non monotonically increasing dts',
    'Conversion failed warning from a codec wrapper',
  ])
})

test('black-frame candidates become blocking only when the interval is plainly visible', () => {
  const intervals = parseBlackIntervals(`
    [blackdetect] black_start:1 black_end:1.2 black_duration:0.2
    [blackdetect] black_start:5 black_end:5.8 black_duration:0.8
  `)

  assert.deepEqual(intervals, [
    { startSec: 1, endSec: 1.2, durationSec: 0.2 },
    { startSec: 5, endSec: 5.8, durationSec: 0.8 },
  ])
})

test('full decode frame count comes from the final ffmpeg progress packet', () => {
  assert.equal(parseProgressFrameCount('frame=120\nprogress=continue\nframe=300\nprogress=end\n'), 300)
  assert.ok(Number.isNaN(parseProgressFrameCount('progress=end\n')))
})

test('healthy viewing result is not rejected because ffmpeg emitted warnings', () => {
  const result = assessDeliveryQuality({
    probe: healthyProbe({
      streams: [
        { ...healthyProbe().streams[0], has_b_frames: 2, bit_rate: '1400000' },
        healthyProbe().streams[1],
      ],
    }),
    expectedFrames: 300,
    expectedFps: 30,
    decodeStatus: 0,
    decodedFrames: 300,
    blackScanLog: '[null] non monotonically increasing dts\n[blackdetect] black_start:2 black_end:2.2 black_duration:0.2',
    integratedLufs: -27.5,
    syncStatus: 0,
  })

  assert.deepEqual(result.blockingErrors, [])
  assert.ok(result.warnings.some((warning) => warning.code === 'FFMPEG_DIAGNOSTIC'))
  assert.ok(result.warnings.some((warning) => warning.code === 'B_FRAMES_PRESENT'))
  assert.ok(result.warnings.some((warning) => warning.code === 'VIDEO_BITRATE_ABOVE_TARGET'))
  assert.ok(result.warnings.some((warning) => warning.code === 'BLACK_FRAME_CANDIDATE'))
})

test('deterministic decode, frame, stream, timing, black-frame, sync, and loudness failures block delivery', () => {
  const result = assessDeliveryQuality({
    probe: healthyProbe({
      streams: [
        { ...healthyProbe().streams[0], width: 1920, avg_frame_rate: '25/1', duration: '9.4' },
        { ...healthyProbe().streams[1], duration: '10.4' },
      ],
      format: { duration: '9.4' },
    }),
    expectedFrames: 300,
    expectedFps: 30,
    decodeStatus: 1,
    decodedFrames: 298,
    blackScanLog: '[blackdetect] black_start:4 black_end:4.8 black_duration:0.8',
    integratedLufs: -18,
    syncStatus: 1,
  })

  const codes = result.blockingErrors.map((error) => error.code)
  for (const code of [
    'WRONG_DIMENSIONS',
    'WRONG_FPS',
    'WRONG_DURATION',
    'AUDIO_VIDEO_DURATION_MISMATCH',
    'DECODE_FAILED',
    'DECODED_FRAME_COUNT_MISMATCH',
    'OBVIOUS_BLACK_FRAME',
    'SYNC_CHECK_FAILED',
    'LOUDNESS_OUT_OF_RANGE',
  ]) {
    assert.ok(codes.includes(code), `missing ${code}: ${JSON.stringify(result.blockingErrors)}`)
  }
  assert.equal(result.failureClass, 'deterministic')
  assert.equal(result.retryable, false)
})

test('spawn and loudness tool failures remain retryable for unchanged delivery bytes', () => {
  const result = assessDeliveryQuality({
    probe: healthyProbe(),
    expectedFrames: 300,
    expectedFps: 30,
    decodeStatus: null,
    decodeToolError: 'spawnSync ffmpeg ETIMEDOUT',
    decodedFrames: Number.NaN,
    blackScanLog: '',
    integratedLufs: Number.NaN,
    loudnessError: 'ffmpeg loudnorm tool unavailable',
    syncStatus: 0,
  })

  assert.equal(result.passed, false)
  assert.equal(result.failureClass, 'transient')
  assert.equal(result.retryable, true)
  assert.deepEqual(result.retryableErrors.map((error) => error.code), [
    'DECODE_TOOL_FAILED',
    'LOUDNESS_SCAN_FAILED',
  ])
  assert.equal(result.blockingErrors.some((error) => error.code === 'DECODED_FRAME_COUNT_MISMATCH'), false)
})

test('overlay props carry only the Remotion text-layer contract and reject implicit windows', () => {
  const subtitles = [
    {
      ttsTitleIndex: 0,
      text: '第一句',
      startSec: 0,
      endSec: 1,
      displayStartSec: 0,
      displayEndSec: 1.35,
      subtitleKeywords: ['第一'],
    },
  ]
  const quotes = [{ panelKey: 'p_001', kind: 'theme', text: '应无所住', startFrame: 30, durationInFrames: 90 }]
  const overlay = buildOverlayProps({
    durationInFrames: 450,
    fps: 30,
    width: 1280,
    height: 720,
    audio: 'static/audio/narration.mp3',
    bgm: { src: 'static/music/bgm.mp3' },
    panels: [{ src: 'static/images/panel.png' }],
    segments: [{ startFrame: 0, durationInFrames: 450 }],
    subtitles,
    quotes,
  })
  // 只保留文字层字段——底片素材/音频不进入 overlayFingerprint。
  assert.deepEqual(Object.keys(overlay).sort(), [
    'chapters',
    'durationInFrames',
    'fps',
    'height',
    'quotes',
    'subtitles',
    'width',
  ])
  assert.deepEqual(overlay.chapters, [])
  assert.equal(overlay.subtitles, subtitles)
  assert.equal(overlay.quotes, quotes)
  const base = { durationInFrames: 60, fps: 30, width: 1280, height: 720, quotes: [] }
  assert.throws(() => buildOverlayProps({
    ...base,
    subtitles: [{ text: '缺窗口', startSec: 0, endSec: 1, subtitleKeywords: [] }],
  }), /display window/u)
  assert.throws(() => buildOverlayProps({
    ...base,
    subtitles: [{
      text: '缺关键词', startSec: 0, endSec: 1, displayStartSec: 0, displayEndSec: 1,
    }],
  }), /subtitleKeywords/u)
  assert.throws(() => buildOverlayProps({
    ...base,
    subtitles: [],
    quotes: [{ text: '缺帧窗口' }],
  }), /startFrame\/durationInFrames/u)
})

test('direct delivery rendering refuses legacy props instead of entering the burned path', () => {
  assert.throws(() => renderOverlayDelivery({
    context: { manifest: { targetDurationSec: 1 } },
    paths: {},
    props: { durationInFrames: 30 },
  }), /requires props\.textLayers=['"]overlay['"]/u)
})

test('resolveChapterHooks locates chapter timing from frozen TTS titles via anchors', () => {
  const titles = [
    { text: '我们先把这句话放在台面上。', time_begin: 0, time_end: 2400 },
    { text: '它为什么让人心里一紧。', time_begin: 2400, time_end: 5100 },
    { text: '真正的报恩不是燃烧自己。', time_begin: 5100, time_end: 9000 },
    { text: '所以边界比牺牲更重要。', time_begin: 9000, time_end: 12000 },
  ]
  assert.deepEqual(resolveChapterHooks([], titles, 12), [])
  assert.deepEqual(resolveChapterHooks(null, titles, 12), [])
  const chapters = resolveChapterHooks([
    { label: '这句话为何刺痛你', anchor: '我们先把这句话' },
    { label: '报恩不是燃烧', anchor: '真正的报恩' },
  ], titles, 12)
  assert.deepEqual(chapters, [
    { label: '这句话为何刺痛你', startSec: 0, endSec: 5.1 },
    { label: '报恩不是燃烧', startSec: 5.1, endSec: 12 },
  ])

  assert.throws(() => resolveChapterHooks([
    { label: '缺 anchor' },
  ], titles, 12), /missing its anchor/u)
  assert.throws(() => resolveChapterHooks([
    { label: '失配', anchor: '这句话不在文稿里' },
  ], titles, 12), /not in the frozen TTS titles/u)
  assert.throws(() => resolveChapterHooks([
    { label: '第二章', anchor: '真正的报恩' },
    { label: '第一章', anchor: '我们先把这句话' },
  ], titles, 12), /does not start after the previous chapter/u)
})

test('buildOverlayProps validates chapter windows', () => {
  const base = {
    durationInFrames: 300,
    fps: 30,
    width: 1280,
    height: 720,
    subtitles: [],
    quotes: [],
  }
  assert.deepEqual(buildOverlayProps(base).chapters, [])
  const chapters = [
    { label: '第一章', startSec: 0, endSec: 4 },
    { label: '第二章', startSec: 4, endSec: 10 },
  ]
  assert.deepEqual(buildOverlayProps({ ...base, chapters }).chapters, chapters)
  assert.throws(() => buildOverlayProps({
    ...base,
    chapters: [{ label: '', startSec: 0, endSec: 4 }],
  }), /missing its label/u)
  assert.throws(() => buildOverlayProps({
    ...base,
    chapters: [
      { label: '第一章', startSec: 0, endSec: 6 },
      { label: '第二章', startSec: 5, endSec: 9 },
    ],
  }), /overlaps the previous chapter/u)
  assert.throws(() => buildOverlayProps({
    ...base,
    chapters: [{ label: '第一章', startSec: 0, endSec: 30 }],
  }), /ends beyond the episode duration/u)
})
