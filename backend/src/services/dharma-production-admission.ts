import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  buildDharmaCanaryInputFingerprint,
  buildDharmaEpisodeInputFingerprint,
  getDharmaPilotApprovalState,
  type DharmaInputFingerprintClient,
} from './dharma-props.js'
import {
  evaluateDharmaFormalRenderAdmission,
  getDharmaProductionGate,
  type DharmaFormalRenderAdmission,
  type DharmaProductionGate,
} from './dharma-production-gate.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const canaryOutputPattern = /^static\/remotion\/dharma-ep\d+-canary-(?:\d+(?:\.\d+)?)s-task\d+\.mp4$/

export function isDharmaCanaryOutputAvailable(output: string | null | undefined): boolean {
  if (!output || !canaryOutputPattern.test(output)) return false
  const root = path.resolve(repoRoot, 'data/static/remotion')
  const candidate = path.resolve(repoRoot, 'data', output)
  const relative = path.relative(root, candidate)
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && fs.existsSync(candidate)
}

export interface DharmaFormalRenderAdmissionState {
  gate: DharmaProductionGate | null
  currentFullPlanFingerprint: string
  currentCanaryFingerprint: string | null
  admission: DharmaFormalRenderAdmission
}

export interface DharmaCanaryRenderAdmissionState {
  allowed: boolean
  reason?: string
  gate: DharmaProductionGate | null
  currentFullPlanFingerprint: string
  currentCanaryFingerprint: string | null
}

/** Shared by HTTP admission and the durable worker before render and publish. */
export function getDharmaFormalRenderAdmission(
  episodeId: number,
  client: DharmaInputFingerprintClient = db,
): DharmaFormalRenderAdmissionState {
  const [episode] = client.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) throw new Error(`Episode ${episodeId} 不存在或已删除`)

  const gate = getDharmaProductionGate(episode.metadata)
  const currentFullPlanFingerprint = buildDharmaEpisodeInputFingerprint(episodeId, client)
  let currentCanaryFingerprint: string | null = null
  if (gate?.canary.requirement === 'required'
    && gate.fullPlan.fingerprint === currentFullPlanFingerprint
    && gate.canary.window) {
    try {
      currentCanaryFingerprint = buildDharmaCanaryInputFingerprint(
        episodeId,
        gate.canary.window.storyboardIds,
        client,
      )
    } catch {
      currentCanaryFingerprint = null
    }
  }
  const legacyPilotApproved = gate ? false : getDharmaPilotApprovalState(episodeId, client).approved
  const admission = evaluateDharmaFormalRenderAdmission({
    gate,
    currentFullPlanFingerprint,
    currentCanaryFingerprint,
    canaryOutputAvailable: gate?.canary.requirement === 'required'
      ? isDharmaCanaryOutputAvailable(gate.canary.output)
      : false,
    legacyPilotApproved,
  })
  return { gate, currentFullPlanFingerprint, currentCanaryFingerprint, admission }
}

export function getDharmaCanaryRenderAdmission(
  episodeId: number,
  input: { taskId: number; storyboardIds: number[]; durationSec: number },
  client: DharmaInputFingerprintClient = db,
): DharmaCanaryRenderAdmissionState {
  const [episode] = client.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .all()
  if (!episode) throw new Error(`Episode ${episodeId} 不存在或已删除`)
  const gate = getDharmaProductionGate(episode.metadata)
  const currentFullPlanFingerprint = buildDharmaEpisodeInputFingerprint(episodeId, client)
  if (!gate) {
    return { allowed: false, reason: '尚未完成全片生产预检', gate, currentFullPlanFingerprint, currentCanaryFingerprint: null }
  }
  if (gate.canary.requirement !== 'required' || !gate.canary.window || !gate.canary.fingerprint) {
    return { allowed: false, reason: '当前生产计划不要求 canary', gate, currentFullPlanFingerprint, currentCanaryFingerprint: null }
  }
  let currentCanaryFingerprint: string | null = null
  try {
    currentCanaryFingerprint = buildDharmaCanaryInputFingerprint(episodeId, gate.canary.window.storyboardIds, client)
  } catch {
    currentCanaryFingerprint = null
  }
  const sameIds = JSON.stringify([...input.storyboardIds].sort((a, b) => a - b))
    === JSON.stringify([...gate.canary.window.storyboardIds].sort((a, b) => a - b))
  if (gate.canary.taskId !== input.taskId) {
    return { allowed: false, reason: 'canary task 与当前生产门禁不一致', gate, currentFullPlanFingerprint, currentCanaryFingerprint }
  }
  if (gate.canary.status !== 'pending') {
    return { allowed: false, reason: 'canary 不处于待渲染状态', gate, currentFullPlanFingerprint, currentCanaryFingerprint }
  }
  if (!sameIds || Math.abs(input.durationSec - gate.canary.window.durationSec) > 0.001) {
    return { allowed: false, reason: 'canary payload 与服务器选择的风险窗口不一致', gate, currentFullPlanFingerprint, currentCanaryFingerprint }
  }
  if (currentCanaryFingerprint !== gate.canary.fingerprint) {
    return { allowed: false, reason: 'canary 风险窗口输入已变化', gate, currentFullPlanFingerprint, currentCanaryFingerprint }
  }
  return { allowed: true, gate, currentFullPlanFingerprint, currentCanaryFingerprint }
}
