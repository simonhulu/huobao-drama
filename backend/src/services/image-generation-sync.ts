import { and, eq, like } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import type { CreationTask, TransactionClient } from './tasks/types.js'

interface ImageGenerationResult {
  image_generation_id: number
  local_path: string
  image_url?: string | null
}

function readImageGenerationId(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const raw = p.image_generation_id ?? p.imageGenerationId
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : null
}

function readResult(task: CreationTask): ImageGenerationResult | null {
  const result = task.result
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  const generationId = Number(r.image_generation_id)
  const localPath = typeof r.local_path === 'string' ? r.local_path : undefined
  if (!Number.isFinite(generationId) || !localPath) return null
  return {
    image_generation_id: generationId,
    local_path: localPath,
    image_url: r.image_url == null ? null : String(r.image_url),
  }
}

export function syncRelatedImageTables(
  tx: TransactionClient,
  generationId: number,
  localPath: string,
  imageUrl?: string | null,
): void {
  const [record] = tx.select()
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, generationId))
    .all()
  if (!record) return

  tx.update(schema.imageGenerations)
    .set({
      imageUrl: imageUrl ?? record.imageUrl ?? null,
      localPath,
      status: 'completed',
      updatedAt: now(),
      completedAt: now(),
    })
    .where(eq(schema.imageGenerations.id, generationId))
    .run()

  if (record.storyboardId) {
    const sbUpdate: Record<string, unknown> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    tx.update(schema.storyboards)
      .set(sbUpdate)
      .where(eq(schema.storyboards.id, record.storyboardId))
      .run()
  }

  if (record.characterId) {
    tx.update(schema.characters)
      .set({ imageUrl: localPath, updatedAt: now() })
      .where(eq(schema.characters.id, record.characterId))
      .run()
  }

  if (record.sceneId) {
    tx.update(schema.scenes)
      .set({ imageUrl: localPath, status: 'completed', updatedAt: now() })
      .where(eq(schema.scenes.id, record.sceneId))
      .run()
  }
}

function setImageGenerationFailed(
  tx: TransactionClient,
  generationId: number,
  errorMessage: string | null,
  errorCode?: string | null,
): void {
  tx.update(schema.imageGenerations)
    .set({
      status: 'failed',
      errorMsg: errorMessage ?? 'Task failed',
      lastErrorCode: errorCode ?? null,
      lastErrorDetail: errorMessage ?? null,
      updatedAt: now(),
    })
    .where(eq(schema.imageGenerations.id, generationId))
    .run()
}

function setImageGenerationCanceled(
  tx: TransactionClient,
  generationId: number,
): void {
  tx.update(schema.imageGenerations)
    .set({ status: 'canceled', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, generationId))
    .run()
}

function setImageGenerationProcessing(
  tx: TransactionClient,
  generationId: number,
  errorMessage?: string | null,
  errorCode?: string | null,
): void {
  tx.update(schema.imageGenerations)
    .set({
      status: 'processing',
      errorMsg: errorMessage ?? null,
      lastErrorCode: errorCode ?? null,
      lastErrorDetail: errorMessage ?? null,
      updatedAt: now(),
    })
    .where(eq(schema.imageGenerations.id, generationId))
    .run()
}

export function syncImageGenerationTaskState(
  tx: TransactionClient,
  task: CreationTask,
): void {
  if (task.type !== 'image.generate') return
  const generationId = readImageGenerationId(task.payload)
  if (!generationId) return

  if (task.status === 'succeeded') {
    const result = readResult(task)
    if (result) {
      syncRelatedImageTables(tx, generationId, result.local_path, result.image_url)
    }
    return
  }

  if (task.status === 'failed') {
    setImageGenerationFailed(tx, generationId, task.errorMessage, task.errorCode)
    return
  }

  if (task.status === 'canceled') {
    setImageGenerationCanceled(tx, generationId)
    return
  }

  if (task.status === 'queued') {
    const errorCode = task.errorCode ?? task.retryReason
    setImageGenerationProcessing(tx, generationId, task.errorMessage, errorCode)
    return
  }
}

function findTaskByImageGenerationId(generationId: number): CreationTask | null {
  const pattern = `%"image_generation_id":${generationId}%`
  const rows = db.select()
    .from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.type, 'image.generate'),
      like(schema.creationTasks.payloadJson, pattern),
    ))
    .all()
    .sort((a, b) => b.id - a.id)
  return rows.length ? normalizeTask(rows[0]) : null
}

function normalizeTask(row: typeof schema.creationTasks.$inferSelect): CreationTask {
  function parseJson(value: string | null | undefined) {
    if (!value) return null
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  return {
    id: row.id,
    type: row.type,
    status: row.status as CreationTask['status'],
    dramaId: row.dramaId,
    episodeId: row.episodeId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    idempotencyKey: row.idempotencyKey,
    parentTaskId: row.parentTaskId,
    payload: parseJson(row.payloadJson),
    result: parseJson(row.resultJson),
    progressCurrent: row.progressCurrent ?? 0,
    progressTotal: row.progressTotal ?? 0,
    progressMessage: row.progressMessage,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    attempts: row.attempts ?? 0,
    maxAttempts: row.maxAttempts ?? 1,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    cancelRequested: Boolean(row.cancelRequested),
    priority: row.priority ?? 0,
    scheduledAt: row.scheduledAt ?? null,
    provider: row.provider ?? null,
    retryReason: row.retryReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }
}

function isTerminalStatus(status: string): boolean {
  return ['succeeded', 'failed', 'canceled', 'stale'].includes(status)
}

export function reconcileImageGenerationState(): { processed: number; updated: number } {
  let processed = 0
  let updated = 0

  const processing = db.select()
    .from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.status, 'processing'))
    .all()

  for (const record of processing) {
    processed++
    const generationId = record.id
    const task = findTaskByImageGenerationId(generationId)

    db.transaction((tx) => {
      if (!task) {
        setImageGenerationFailed(tx, generationId, 'No associated task found')
        updated++
        return
      }

      if (!isTerminalStatus(task.status)) return

      if (task.status === 'succeeded') {
        const result = readResult(task)
        if (result) {
          syncRelatedImageTables(tx, generationId, result.local_path, result.image_url)
          updated++
        }
        return
      }

      if (task.status === 'failed') {
        setImageGenerationFailed(tx, generationId, task.errorMessage, task.errorCode)
        updated++
        return
      }

      if (task.status === 'canceled') {
        setImageGenerationCanceled(tx, generationId)
        updated++
        return
      }

      if (task.status === 'stale') {
        setImageGenerationFailed(tx, generationId, 'Worker became stale', 'stale_worker')
        updated++
      }
    })
  }

  return { processed, updated }
}
