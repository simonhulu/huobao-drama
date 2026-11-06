import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

type JsonRecord = Record<string, unknown>

interface StoryboardPlan {
  pilotPanelCount?: number
  sequences?: Array<{ panels?: Array<{ id?: string }> }>
}

interface FinalState {
  status?: string
  generationId?: number
  taskId?: number
  localPath?: string
  referenceMode?: string
  error?: string | null
}

interface ProductionState {
  finals?: Record<string, FinalState>
  producer?: {
    status?: string
    runId?: string
    heartbeatAt?: string
    activePanels?: string[]
    completedPanels?: number
    totalPanels?: number
    maxPanelAttempts?: number
  }
}

export interface NarrativeStoryboardProgress {
  available: boolean
  projectId: number
  reason?: 'not_configured'
  totalPanels?: number
  pilotPanels?: number
  productionPanels?: number
  completed?: number
  processing?: number
  failed?: number
  pending?: number
  remaining?: number
  percent?: number
  status?: 'ready' | 'generating' | 'blocked' | 'complete'
  provider?: string | null
  referenceMode?: string | null
  activePanels?: Array<{
    id: string
    status: 'submitted' | 'processing' | 'finalizing'
    generationId: number | null
    taskId: number | null
    providerStatus: string | null
    taskStatus: string | null
  }>
  recentCompleted?: Array<{ id: string, completedAt: string | null }>
  updatedAt?: string | null
  producer?: {
    status: 'running' | 'complete' | 'blocked' | 'unknown'
    runId: string | null
    heartbeatAt: string | null
    stale: boolean
    activePanels: string[]
    completedPanels: number | null
    totalPanels: number | null
    maxPanelAttempts: number | null
  }
}

const projectRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const PRODUCER_HEARTBEAT_TIMEOUT_MS = 90_000

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function panelNumber(id: string): number {
  const match = /^panel-(\d+)$/u.exec(id)
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY
}

function asPositiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function plannedPanelIds(plan: StoryboardPlan): string[] {
  const panelIds = (plan.sequences || [])
    .flatMap((sequence) => sequence.panels || [])
    .map((panel) => panel.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(panelIds)].sort((left, right) => panelNumber(left) - panelNumber(right))
}

function findFinalFiles(finalsDirectory: string): Map<string, Date> {
  if (!existsSync(finalsDirectory)) return new Map()
  const files = new Map<string, Date>()
  for (const entry of readdirSync(finalsDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const match = /^(panel-\d+)\.png$/u.exec(entry.name)
    if (!match) continue
    files.set(match[1], statSync(join(finalsDirectory, entry.name)).mtime)
  }
  return files
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function getNarrativeStoryboardProgress(
  projectId: number,
  options: { dataRoot?: string } = {},
): NarrativeStoryboardProgress {
  const dataRoot = options.dataRoot || join(projectRoot, 'data')
  const planPath = join(dataRoot, 'temp', `project-${projectId}-full-storyboard-sound-plan.json`)
  const outputRoot = join(dataRoot, 'static', 'remotion', `project-${projectId}`, 'narrative-storyboard', 'full-v2')
  const statePath = join(outputRoot, 'production-state.json')
  const finalsDirectory = join(outputRoot, 'finals')

  if (!existsSync(planPath)) return { available: false, projectId, reason: 'not_configured' }

  const plan = readJson<StoryboardPlan>(planPath)
  const panelIds = plannedPanelIds(plan)
  const pilotPanels = Math.max(0, Number(plan.pilotPanelCount) || 0)
  const productionIds = panelIds.filter((id) => panelNumber(id) > pilotPanels)
  const state = existsSync(statePath) ? readJson<ProductionState>(statePath) : {}
  const finals = asRecord(state.finals) as Record<string, FinalState>
  const producer = asRecord(state.producer)
  const finalFiles = findFinalFiles(finalsDirectory)
  const generationIds = [...new Set(productionIds
    .map((id) => asPositiveInteger(finals[id]?.generationId))
    .filter((id): id is number => id !== null))]
  const taskIds = [...new Set(productionIds
    .map((id) => asPositiveInteger(finals[id]?.taskId))
    .filter((id): id is number => id !== null))]
  const generations = generationIds.length
    ? db.select({ id: schema.imageGenerations.id, status: schema.imageGenerations.status, provider: schema.imageGenerations.provider, completedAt: schema.imageGenerations.completedAt })
      .from(schema.imageGenerations)
      .where(inArray(schema.imageGenerations.id, generationIds))
      .all()
    : []
  const tasks = taskIds.length
    ? db.select({ id: schema.creationTasks.id, status: schema.creationTasks.status })
      .from(schema.creationTasks)
      .where(inArray(schema.creationTasks.id, taskIds))
      .all()
    : []
  const generationById = new Map(generations.map((generation) => [generation.id, generation]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const completedIds = new Set<string>()
  const failedIds = new Set<string>()
  const activePanels: NonNullable<NarrativeStoryboardProgress['activePanels']> = []

  for (const id of productionIds) {
    const final = finals[id]
    const generationId = asPositiveInteger(final?.generationId)
    const taskId = asPositiveInteger(final?.taskId)
    const generation = generationId ? generationById.get(generationId) : null
    const task = taskId ? taskById.get(taskId) : null
    const stateStatus = final?.status || ''
    const providerStatus = generation?.status || null
    const taskStatus = task?.status || null

    if (finalFiles.has(id) || stateStatus === 'completed') {
      completedIds.add(id)
      continue
    }
    if (stateStatus === 'failed' || providerStatus === 'failed' || taskStatus === 'failed') {
      failedIds.add(id)
      continue
    }
    if (final || generation || task) {
      activePanels.push({
        id,
        status: providerStatus === 'completed' ? 'finalizing' : stateStatus === 'processing' ? 'processing' : 'submitted',
        generationId,
        taskId,
        providerStatus,
        taskStatus,
      })
    }
  }

  const completed = completedIds.size
  const processing = activePanels.length
  const failed = failedIds.size
  const pending = Math.max(0, productionIds.length - completed - processing - failed)
  const recentCompleted = [...completedIds]
    .map((id) => {
      const final = finals[id]
      const generationId = asPositiveInteger(final?.generationId)
      const generation = generationId ? generationById.get(generationId) : null
      return { id, completedAt: isoOrNull(finalFiles.get(id) || generation?.completedAt) }
    })
    .sort((left, right) => (right.completedAt || '').localeCompare(left.completedAt || ''))
    .slice(0, 6)
  const referenceMode = [...productionIds].reverse()
    .map((id) => finals[id]?.referenceMode)
    .find((value): value is string => typeof value === 'string') || null
  const provider = activePanels
    .map((panel) => panel.generationId ? generationById.get(panel.generationId)?.provider : null)
    .find((value): value is string => typeof value === 'string')
    || generations.find((generation) => generation.provider)?.provider
    || null
  const updatedAt = existsSync(statePath) ? statSync(statePath).mtime.toISOString() : null
  const producerHeartbeatAt = isoOrNull(typeof producer.heartbeatAt === 'string' ? producer.heartbeatAt : null)
  const producerHeartbeatMs = producerHeartbeatAt ? Date.parse(producerHeartbeatAt) : Number.NaN
  const producerStale = producer.status === 'running'
    && (!Number.isFinite(producerHeartbeatMs) || Date.now() - producerHeartbeatMs > PRODUCER_HEARTBEAT_TIMEOUT_MS)
  const producerRunning = producer.status === 'running' && !producerStale
  const status: NarrativeStoryboardProgress['status'] = completed === productionIds.length
    ? 'complete'
    : processing > 0 || producerRunning ? 'generating'
      : failed > 0 ? 'blocked'
        : 'ready'

  return {
    available: true,
    projectId,
    totalPanels: panelIds.length,
    pilotPanels,
    productionPanels: productionIds.length,
    completed,
    processing,
    failed,
    pending,
    remaining: productionIds.length - completed,
    percent: productionIds.length ? Math.round(completed / productionIds.length * 100) : 0,
    status,
    provider,
    referenceMode,
    activePanels: activePanels.slice(0, 8),
    recentCompleted,
    updatedAt,
    producer: {
      status: producer.status === 'running' || producer.status === 'complete' || producer.status === 'blocked' ? producer.status : 'unknown',
      runId: typeof producer.runId === 'string' ? producer.runId : null,
      heartbeatAt: producerHeartbeatAt,
      stale: producerStale,
      activePanels: Array.isArray(producer.activePanels) ? producer.activePanels.filter((id): id is string => typeof id === 'string').slice(0, 8) : [],
      completedPanels: asPositiveInteger(producer.completedPanels),
      totalPanels: asPositiveInteger(producer.totalPanels),
      maxPanelAttempts: asPositiveInteger(producer.maxPanelAttempts),
    },
  }
}
