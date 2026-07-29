export const DHARMA_PRODUCTION_GATE_SCHEMA_VERSION = 1 as const

export type DharmaFullPlanStatus = 'validated' | 'approved'
export type DharmaCanaryRequirement = 'required' | 'not_required'
export type DharmaCanaryStatus = 'not_required' | 'pending' | 'rendered' | 'approved'

export interface DharmaCanaryWindow {
  storyboardIds: number[]
  storyboardNumbers: number[]
  startMs: number
  endMs: number
  durationSec: number
}

export interface DharmaFullPlanGate {
  status: DharmaFullPlanStatus
  fingerprint: string
  validatorVersion: string
  rendererContractVersion: string
  report: Record<string, unknown>
  validatedAt: string
  approvedAt?: string
  actor?: string
  reason?: string
}

export interface DharmaCanaryGate {
  requirement: DharmaCanaryRequirement
  status: DharmaCanaryStatus
  reasons: string[]
  window?: DharmaCanaryWindow
  fingerprint?: string
  taskId?: number
  output?: string
  renderedAt?: string
  approvedAt?: string
}

export interface DharmaProductionGate {
  schemaVersion: typeof DHARMA_PRODUCTION_GATE_SCHEMA_VERSION
  fullPlan: DharmaFullPlanGate
  canary: DharmaCanaryGate
}

export interface DharmaCanaryWindowCandidate {
  storyboardId: number
  storyboardNumber: number
  startMs: number
  endMs: number
  riskReasons: string[]
}

export interface ApplyDharmaProductionPreflightInput {
  fullPlanFingerprint: string
  validatorVersion: string
  rendererContractVersion: string
  report: Record<string, unknown>
  validatedAt: string
  canary:
    | { requirement: 'not_required'; reasons: string[] }
    | {
        requirement: 'required'
        reasons: string[]
        fingerprint: string
        window: DharmaCanaryWindow
      }
}

export interface ApproveDharmaProductionGateInput {
  fullPlanFingerprint: string
  canaryFingerprint?: string
  actor: string
  reason: string
  approvedAt: string
}

export interface DharmaFormalRenderAdmission {
  allowed: boolean
  mode: 'production_gate' | 'legacy_pilot'
  reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isCanaryWindow(value: unknown): value is DharmaCanaryWindow {
  if (!isRecord(value)) return false
  return Array.isArray(value.storyboardIds)
    && value.storyboardIds.length > 0
    && value.storyboardIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
    && Array.isArray(value.storyboardNumbers)
    && value.storyboardNumbers.length === value.storyboardIds.length
    && value.storyboardNumbers.every((number) => Number.isSafeInteger(number) && Number(number) > 0)
    && Number.isFinite(value.startMs)
    && Number.isFinite(value.endMs)
    && Number(value.endMs) > Number(value.startMs)
    && Number.isFinite(value.durationSec)
    && Number(value.durationSec) > 0
}

function parseDharmaProductionGateCandidate(value: unknown): DharmaProductionGate | null {
  if (!isRecord(value) || value.schemaVersion !== DHARMA_PRODUCTION_GATE_SCHEMA_VERSION) return null
  if (!isRecord(value.fullPlan) || !isRecord(value.canary)) return null
  const fullPlan = value.fullPlan
  const canary = value.canary
  if ((fullPlan.status !== 'validated' && fullPlan.status !== 'approved')
    || typeof fullPlan.fingerprint !== 'string'
    || typeof fullPlan.validatorVersion !== 'string'
    || typeof fullPlan.rendererContractVersion !== 'string'
    || !isRecord(fullPlan.report)
    || typeof fullPlan.validatedAt !== 'string') return null
  if (fullPlan.status === 'approved'
    && (typeof fullPlan.approvedAt !== 'string'
      || typeof fullPlan.actor !== 'string'
      || typeof fullPlan.reason !== 'string')) return null
  if ((canary.requirement !== 'required' && canary.requirement !== 'not_required')
    || (canary.status !== 'not_required'
      && canary.status !== 'pending'
      && canary.status !== 'rendered'
      && canary.status !== 'approved')
    || !isStringArray(canary.reasons)) return null
  if (canary.requirement === 'not_required') {
    if (canary.status !== 'not_required') return null
  } else {
    if (canary.status === 'not_required'
      || typeof canary.fingerprint !== 'string'
      || !isCanaryWindow(canary.window)) return null
    if ((canary.status === 'rendered' || canary.status === 'approved')
      && (!Number.isSafeInteger(canary.taskId)
        || typeof canary.output !== 'string'
        || typeof canary.renderedAt !== 'string')) return null
    if (canary.status === 'approved' && typeof canary.approvedAt !== 'string') return null
  }
  return value as unknown as DharmaProductionGate
}

export function getDharmaProductionGate(metadata: string | null | undefined): DharmaProductionGate | null {
  try {
    const parsed = metadata ? JSON.parse(metadata) : null
    if (!isRecord(parsed)) return null
    return parseDharmaProductionGateCandidate(parsed.dharmaProductionGate)
  } catch {
    return null
  }
}

export function setDharmaProductionGateMetadata(
  metadata: string | null | undefined,
  gate: DharmaProductionGate,
): string {
  let record: Record<string, unknown> = {}
  try {
    const parsed = metadata ? JSON.parse(metadata) : {}
    if (isRecord(parsed)) record = parsed
  } catch {
    // A malformed legacy metadata blob cannot be preserved as structured JSON.
  }
  return JSON.stringify({ ...record, dharmaProductionGate: gate })
}

export function selectDharmaCanaryWindow(
  candidates: DharmaCanaryWindowCandidate[],
  minDurationSec = 15,
  maxDurationSec = 30,
): DharmaCanaryWindow | null {
  if (!candidates.some((candidate) => candidate.riskReasons.length > 0)) return null

  const ordered = [...candidates].sort((left, right) => left.storyboardNumber - right.storyboardNumber)
  let best: { score: number; durationMs: number; startIndex: number; endIndex: number } | null = null

  for (let startIndex = 0; startIndex < ordered.length; startIndex += 1) {
    let score = 0
    for (let endIndex = startIndex; endIndex < ordered.length; endIndex += 1) {
      if (endIndex > startIndex
        && ordered[endIndex].storyboardNumber !== ordered[endIndex - 1].storyboardNumber + 1) break
      score += ordered[endIndex].riskReasons.length
      const durationMs = ordered[endIndex].endMs - ordered[startIndex].startMs
      if (durationMs > maxDurationSec * 1000) break
      if (durationMs < minDurationSec * 1000 || score === 0) continue
      const proposal = { score, durationMs, startIndex, endIndex }
      if (!best
        || proposal.score > best.score
        || (proposal.score === best.score && proposal.durationMs < best.durationMs)
        || (proposal.score === best.score
          && proposal.durationMs === best.durationMs
          && proposal.startIndex < best.startIndex)) {
        best = proposal
      }
    }
  }

  if (!best) return null
  const selected = ordered.slice(best.startIndex, best.endIndex + 1)
  return {
    storyboardIds: selected.map((candidate) => candidate.storyboardId),
    storyboardNumbers: selected.map((candidate) => candidate.storyboardNumber),
    startMs: selected[0].startMs,
    endMs: selected[selected.length - 1].endMs,
    durationSec: best.durationMs / 1000,
  }
}

export function applyDharmaProductionPreflight(
  existing: DharmaProductionGate | null,
  input: ApplyDharmaProductionPreflightInput,
): DharmaProductionGate {
  const sameFullPlan = existing?.fullPlan.fingerprint === input.fullPlanFingerprint
  const fullPlan: DharmaFullPlanGate = {
    status: sameFullPlan && existing?.fullPlan.status === 'approved' ? 'approved' : 'validated',
    fingerprint: input.fullPlanFingerprint,
    validatorVersion: input.validatorVersion,
    rendererContractVersion: input.rendererContractVersion,
    report: input.report,
    validatedAt: input.validatedAt,
    ...(sameFullPlan && existing?.fullPlan.status === 'approved'
      ? {
          approvedAt: existing.fullPlan.approvedAt,
          actor: existing.fullPlan.actor,
          reason: existing.fullPlan.reason,
        }
      : {}),
  }

  if (input.canary.requirement === 'not_required') {
    return {
      schemaVersion: DHARMA_PRODUCTION_GATE_SCHEMA_VERSION,
      fullPlan,
      canary: { requirement: 'not_required', status: 'not_required', reasons: input.canary.reasons },
    }
  }

  const sameCanary = existing?.canary.requirement === 'required'
    && existing.canary.fingerprint === input.canary.fingerprint
  const canary: DharmaCanaryGate = {
    requirement: 'required',
    status: sameCanary ? existing.canary.status : 'pending',
    reasons: input.canary.reasons,
    fingerprint: input.canary.fingerprint,
    window: input.canary.window,
    ...(sameCanary
      ? {
          taskId: existing.canary.taskId,
          output: existing.canary.output,
          renderedAt: existing.canary.renderedAt,
          approvedAt: existing.canary.approvedAt,
        }
      : {}),
  }
  return { schemaVersion: DHARMA_PRODUCTION_GATE_SCHEMA_VERSION, fullPlan, canary }
}

export function approveDharmaProductionGate(
  gate: DharmaProductionGate,
  input: ApproveDharmaProductionGateInput,
): DharmaProductionGate {
  if (gate.fullPlan.fingerprint !== input.fullPlanFingerprint) {
    throw new Error('全片生产计划指纹与当前预检不一致；请重新预检')
  }
  if (gate.canary.requirement === 'required') {
    if (gate.canary.fingerprint !== input.canaryFingerprint) {
      throw new Error('canary 指纹与当前风险窗口不一致；请重新生成 canary')
    }
    if (gate.canary.status !== 'rendered' && gate.canary.status !== 'approved') {
      throw new Error('风险 canary 尚未渲染完成')
    }
    if (!gate.canary.output || !gate.canary.renderedAt) {
      throw new Error('风险 canary 缺少可审核的交付记录')
    }
  }

  return {
    ...gate,
    fullPlan: {
      ...gate.fullPlan,
      status: 'approved',
      approvedAt: input.approvedAt,
      actor: input.actor,
      reason: input.reason,
    },
    canary: gate.canary.requirement === 'required'
      ? { ...gate.canary, status: 'approved', approvedAt: input.approvedAt }
      : gate.canary,
  }
}

export function recordDharmaCanaryRendered(
  gate: DharmaProductionGate,
  input: { taskId: number; fingerprint: string; output: string; renderedAt: string },
): DharmaProductionGate {
  if (gate.canary.requirement !== 'required') throw new Error('当前生产计划不要求 canary')
  if (gate.canary.taskId !== input.taskId) throw new Error('canary task 与当前生产门禁不一致')
  if (gate.canary.fingerprint !== input.fingerprint) throw new Error('canary 指纹与当前风险窗口不一致')
  return {
    ...gate,
    canary: {
      ...gate.canary,
      status: 'rendered',
      output: input.output,
      renderedAt: input.renderedAt,
      approvedAt: undefined,
    },
  }
}

export function scheduleDharmaCanary(
  gate: DharmaProductionGate,
  input: { taskId: number; fullPlanFingerprint: string; canaryFingerprint: string },
): DharmaProductionGate {
  if (gate.fullPlan.fingerprint !== input.fullPlanFingerprint) {
    throw new Error('全片生产计划指纹已变化；请重新预检')
  }
  if (gate.canary.requirement !== 'required') throw new Error('当前生产计划不要求 canary')
  if (gate.canary.fingerprint !== input.canaryFingerprint) {
    throw new Error('canary 指纹已变化；请重新预检')
  }
  if (gate.canary.status === 'rendered' || gate.canary.status === 'approved') {
    throw new Error('当前 canary 已经渲染，不能重复创建')
  }
  if (!Number.isSafeInteger(input.taskId) || input.taskId <= 0) throw new Error('canary taskId 无效')
  return {
    ...gate,
    canary: {
      ...gate.canary,
      status: 'pending',
      taskId: input.taskId,
      output: undefined,
      renderedAt: undefined,
      approvedAt: undefined,
    },
  }
}

export function evaluateDharmaFormalRenderAdmission(input: {
  gate: DharmaProductionGate | null
  currentFullPlanFingerprint: string
  currentCanaryFingerprint: string | null
  canaryOutputAvailable: boolean
  legacyPilotApproved: boolean
}): DharmaFormalRenderAdmission {
  if (!input.gate) {
    if (input.legacyPilotApproved) return { allowed: true, mode: 'legacy_pilot' }
    return { allowed: false, mode: 'production_gate', reason: '尚未完成全片生产预检' }
  }
  if (input.gate.fullPlan.fingerprint !== input.currentFullPlanFingerprint) {
    return { allowed: false, mode: 'production_gate', reason: '全片输入已变化；请重新预检并审核当前计划' }
  }
  if (input.gate.fullPlan.status !== 'approved' || !input.gate.fullPlan.approvedAt) {
    return { allowed: false, mode: 'production_gate', reason: '全片生产计划尚未人工审核通过' }
  }
  if (input.gate.canary.requirement === 'not_required') {
    return { allowed: true, mode: 'production_gate' }
  }
  if (input.gate.canary.fingerprint !== input.currentCanaryFingerprint) {
    return { allowed: false, mode: 'production_gate', reason: 'canary 输入已变化；请重新生成并审核风险窗口' }
  }
  if (input.gate.canary.status !== 'approved' || !input.gate.canary.approvedAt) {
    return { allowed: false, mode: 'production_gate', reason: 'canary 尚未审核通过' }
  }
  if (!input.canaryOutputAvailable) {
    return { allowed: false, mode: 'production_gate', reason: '已审核的 canary 文件不存在；请恢复或重新生成' }
  }
  return { allowed: true, mode: 'production_gate' }
}
