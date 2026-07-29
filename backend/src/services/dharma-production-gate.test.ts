import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDharmaProductionPreflight,
  approveDharmaProductionGate,
  evaluateDharmaFormalRenderAdmission,
  getDharmaProductionGate,
  recordDharmaCanaryRendered,
  scheduleDharmaCanary,
  selectDharmaCanaryWindow,
  setDharmaProductionGateMetadata,
  type DharmaProductionGate,
} from './dharma-production-gate.js'

const validatedAt = '2026-07-28T05:00:00.000Z'

function validatedGate(options: {
  fullPlanFingerprint?: string
  canaryFingerprint?: string
  canaryRequired?: boolean
} = {}): DharmaProductionGate {
  return applyDharmaProductionPreflight(null, {
    fullPlanFingerprint: options.fullPlanFingerprint ?? 'full-v1',
    validatorVersion: 'full-plan-v1',
    rendererContractVersion: 'renderer-v1',
    report: { valid: true, segmentCount: 4 },
    validatedAt,
    canary: options.canaryRequired === false
      ? { requirement: 'not_required', reasons: [] }
      : {
          requirement: 'required',
          reasons: ['generated_image'],
          fingerprint: options.canaryFingerprint ?? 'canary-v1',
          window: {
            storyboardIds: [2, 3, 4],
            storyboardNumbers: [2, 3, 4],
            startMs: 6_000,
            endMs: 24_000,
            durationSec: 18,
          },
        },
  })
}

test('formal render admission rejects missing and stale full-plan approval', () => {
  assert.deepEqual(evaluateDharmaFormalRenderAdmission({
    gate: null,
    currentFullPlanFingerprint: 'full-v1',
    currentCanaryFingerprint: null,
    canaryOutputAvailable: false,
    legacyPilotApproved: false,
  }), {
    allowed: false,
    mode: 'production_gate',
    reason: '尚未完成全片生产预检',
  })

  const approved = approveDharmaProductionGate(validatedGate({ canaryRequired: false }), {
    fullPlanFingerprint: 'full-v1',
    actor: 'producer',
    reason: 'full plan reviewed',
    approvedAt: '2026-07-28T05:05:00.000Z',
  })
  const admission = evaluateDharmaFormalRenderAdmission({
    gate: approved,
    currentFullPlanFingerprint: 'full-v2',
    currentCanaryFingerprint: null,
    canaryOutputAvailable: false,
    legacyPilotApproved: true,
  })
  assert.equal(admission.allowed, false)
  assert.match(admission.reason ?? '', /全片输入已变化/)
})

test('approved plan without canary risk admits one formal render', () => {
  const gate = approveDharmaProductionGate(validatedGate({ canaryRequired: false }), {
    fullPlanFingerprint: 'full-v1',
    actor: 'producer',
    reason: 'no dynamic visual risk',
    approvedAt: '2026-07-28T05:05:00.000Z',
  })
  assert.deepEqual(evaluateDharmaFormalRenderAdmission({
    gate,
    currentFullPlanFingerprint: 'full-v1',
    currentCanaryFingerprint: null,
    canaryOutputAvailable: false,
    legacyPilotApproved: false,
  }), { allowed: true, mode: 'production_gate' })
})

test('required canary must be rendered, current, available, and approved', () => {
  const pending = validatedGate()
  pending.fullPlan = {
    ...pending.fullPlan,
    status: 'approved',
    actor: 'producer',
    reason: 'reviewed before canary migration',
    approvedAt: '2026-07-28T05:03:00.000Z',
  }
  let admission = evaluateDharmaFormalRenderAdmission({
    gate: pending,
    currentFullPlanFingerprint: 'full-v1',
    currentCanaryFingerprint: 'canary-v1',
    canaryOutputAvailable: false,
    legacyPilotApproved: false,
  })
  assert.equal(admission.allowed, false)
  assert.match(admission.reason ?? '', /canary 尚未审核通过/)

  const rendered: DharmaProductionGate = {
    ...pending,
    canary: {
      ...pending.canary,
      status: 'rendered',
      taskId: 91,
      output: 'static/remotion/dharma-ep7-canary-task91.mp4',
      renderedAt: '2026-07-28T05:04:00.000Z',
    },
  }
  const approved = approveDharmaProductionGate(rendered, {
    fullPlanFingerprint: 'full-v1',
    canaryFingerprint: 'canary-v1',
    actor: 'producer',
    reason: 'risk window reviewed',
    approvedAt: '2026-07-28T05:05:00.000Z',
  })
  admission = evaluateDharmaFormalRenderAdmission({
    gate: approved,
    currentFullPlanFingerprint: 'full-v1',
    currentCanaryFingerprint: 'canary-v1',
    canaryOutputAvailable: true,
    legacyPilotApproved: false,
  })
  assert.deepEqual(admission, { allowed: true, mode: 'production_gate' })

  admission = evaluateDharmaFormalRenderAdmission({
    gate: approved,
    currentFullPlanFingerprint: 'full-v1',
    currentCanaryFingerprint: 'canary-v2',
    canaryOutputAvailable: true,
    legacyPilotApproved: false,
  })
  assert.equal(admission.allowed, false)
  assert.match(admission.reason ?? '', /canary 输入已变化/)
})

test('a late safe full-plan change invalidates plan approval but preserves an unchanged canary', () => {
  const rendered = validatedGate()
  rendered.canary = {
    ...rendered.canary,
    status: 'approved',
    taskId: 92,
    output: 'static/remotion/dharma-ep7-canary-task92.mp4',
    renderedAt: '2026-07-28T05:04:00.000Z',
    approvedAt: '2026-07-28T05:05:00.000Z',
  }
  rendered.fullPlan = {
    ...rendered.fullPlan,
    status: 'approved',
    actor: 'producer',
    reason: 'reviewed',
    approvedAt: '2026-07-28T05:05:00.000Z',
  }

  const refreshed = applyDharmaProductionPreflight(rendered, {
    fullPlanFingerprint: 'full-v2',
    validatorVersion: 'full-plan-v1',
    rendererContractVersion: 'renderer-v1',
    report: { valid: true, segmentCount: 5 },
    validatedAt: '2026-07-28T05:10:00.000Z',
    canary: {
      requirement: 'required',
      reasons: ['generated_image'],
      fingerprint: 'canary-v1',
      window: rendered.canary.window!,
    },
  })

  assert.equal(refreshed.fullPlan.status, 'validated')
  assert.equal(refreshed.canary.status, 'approved')
  assert.equal(refreshed.canary.output, rendered.canary.output)
})

test('canary selection chooses a deterministic contiguous 15-30 second risk window', () => {
  const window = selectDharmaCanaryWindow([
    { storyboardId: 11, storyboardNumber: 1, startMs: 0, endMs: 6_000, riskReasons: [] },
    { storyboardId: 12, storyboardNumber: 2, startMs: 6_000, endMs: 12_000, riskReasons: [] },
    { storyboardId: 13, storyboardNumber: 3, startMs: 12_000, endMs: 18_000, riskReasons: ['quote'] },
    { storyboardId: 14, storyboardNumber: 4, startMs: 18_000, endMs: 24_000, riskReasons: ['slow_video'] },
    { storyboardId: 15, storyboardNumber: 5, startMs: 24_000, endMs: 30_000, riskReasons: [] },
  ])

  assert.ok(window)
  assert.ok(window.durationSec >= 15 && window.durationSec <= 30)
  assert.deepEqual(window.storyboardNumbers, [2, 3, 4])
  assert.deepEqual(window.storyboardIds, [12, 13, 14])
  for (let index = 1; index < window.storyboardNumbers.length; index += 1) {
    assert.equal(window.storyboardNumbers[index], window.storyboardNumbers[index - 1] + 1)
  }
})

test('legacy exact-60 pilot approval remains an admission fallback only without a new gate', () => {
  assert.deepEqual(evaluateDharmaFormalRenderAdmission({
    gate: null,
    currentFullPlanFingerprint: 'legacy-current',
    currentCanaryFingerprint: null,
    canaryOutputAvailable: false,
    legacyPilotApproved: true,
  }), { allowed: true, mode: 'legacy_pilot' })
})

test('production-gate metadata parsing fails closed on malformed or partial state', () => {
  assert.equal(getDharmaProductionGate(null), null)
  assert.equal(getDharmaProductionGate('{not-json'), null)
  assert.equal(getDharmaProductionGate(JSON.stringify({
    dharmaProductionGate: { schemaVersion: 1, fullPlan: { status: 'approved' } },
  })), null)

  const gate = validatedGate({ canaryRequired: false })
  assert.deepEqual(getDharmaProductionGate(JSON.stringify({ dharmaProductionGate: gate })), gate)
})

test('only the current canary task and fingerprint may publish review evidence', () => {
  const gate = validatedGate()
  const scheduled: DharmaProductionGate = {
    ...gate,
    canary: { ...gate.canary, taskId: 101 },
  }
  assert.throws(() => recordDharmaCanaryRendered(scheduled, {
    taskId: 100,
    fingerprint: 'canary-v1',
    output: 'static/remotion/dharma-ep7-canary-18s-task100.mp4',
    renderedAt: '2026-07-28T05:04:00.000Z',
  }), /task/)
  assert.throws(() => recordDharmaCanaryRendered(scheduled, {
    taskId: 101,
    fingerprint: 'canary-v2',
    output: 'static/remotion/dharma-ep7-canary-18s-task101.mp4',
    renderedAt: '2026-07-28T05:04:00.000Z',
  }), /指纹/)

  const rendered = recordDharmaCanaryRendered(scheduled, {
    taskId: 101,
    fingerprint: 'canary-v1',
    output: 'static/remotion/dharma-ep7-canary-18s-task101.mp4',
    renderedAt: '2026-07-28T05:04:00.000Z',
  })
  assert.equal(rendered.canary.status, 'rendered')
  assert.equal(rendered.canary.output, 'static/remotion/dharma-ep7-canary-18s-task101.mp4')
  assert.equal(rendered.fullPlan.fingerprint, 'full-v1')
})

test('metadata writer preserves unrelated episode state and canary scheduling is fingerprint-fenced', () => {
  const gate = validatedGate()
  const metadata = setDharmaProductionGateMetadata(JSON.stringify({ keep: { value: 1 } }), gate)
  assert.deepEqual(JSON.parse(metadata), { keep: { value: 1 }, dharmaProductionGate: gate })

  assert.throws(() => scheduleDharmaCanary(gate, {
    taskId: 201,
    fullPlanFingerprint: 'full-v2',
    canaryFingerprint: 'canary-v1',
  }), /全片.*指纹/)
  assert.throws(() => scheduleDharmaCanary(gate, {
    taskId: 201,
    fullPlanFingerprint: 'full-v1',
    canaryFingerprint: 'canary-v2',
  }), /canary.*指纹/)

  const scheduled = scheduleDharmaCanary(gate, {
    taskId: 201,
    fullPlanFingerprint: 'full-v1',
    canaryFingerprint: 'canary-v1',
  })
  assert.equal(scheduled.canary.status, 'pending')
  assert.equal(scheduled.canary.taskId, 201)
  assert.equal(scheduled.fullPlan.status, 'validated')
})
