import { and, eq, like } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import type { CreationTask, TransactionClient } from './tasks/types.js'
import { syncRemotionAssetForImageGeneration } from './remotion-asset-sync.js'

interface ImageGenerationResult {
  image_generation_id: number
  local_path: string
  image_url?: string | null
}

function writesStoryboardComposedImage(frameType: string | null | undefined): boolean {
  return !frameType || frameType === 'default' || frameType === 'composed'
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
  tx: TransactionClient | typeof db,
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
      errorMsg: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      updatedAt: now(),
      completedAt: now(),
    })
    .where(eq(schema.imageGenerations.id, generationId))
    .run()

  if (record.storyboardId) {
    const sbUpdate: Record<string, unknown> = { updatedAt: now() }
    if (record.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (record.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else if (writesStoryboardComposedImage(record.frameType)) sbUpdate.composedImage = localPath
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

  syncRemotionAssetForImageGeneration(tx, generationId, {
    status: 'completed',
    localPath,
    sourceUrl: imageUrl ?? null,
    completed: true,
  })
}

function setImageGenerationFailed(
  tx: TransactionClient | typeof db,
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
  syncRemotionAssetForImageGeneration(tx, generationId, {
    status: 'failed',
    errorCode: errorCode ?? null,
    errorMessage: errorMessage ?? 'Task failed',
  })
}

function setImageGenerationCanceled(
  tx: TransactionClient | typeof db,
  generationId: number,
): void {
  tx.update(schema.imageGenerations)
    .set({ status: 'canceled', updatedAt: now() })
    .where(eq(schema.imageGenerations.id, generationId))
    .run()
  syncRemotionAssetForImageGeneration(tx, generationId, {
    status: 'canceled',
    errorCode: 'canceled',
    errorMessage: 'Task canceled',
  })
}

function setImageGenerationProcessing(
  tx: TransactionClient | typeof db,
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
  syncRemotionAssetForImageGeneration(tx, generationId, {
    status: 'processing',
    errorCode: errorCode ?? null,
    errorMessage: errorMessage ?? null,
  })
}

function setImageGenerationQueued(
  tx: TransactionClient | typeof db,
  generationId: number,
  errorMessage?: string | null,
  errorCode?: string | null,
): void {
  tx.update(schema.imageGenerations)
    .set({
      status: 'pending',
      errorMsg: errorMessage ?? null,
      lastErrorCode: errorCode ?? null,
      lastErrorDetail: errorMessage ?? null,
      updatedAt: now(),
    })
    .where(eq(schema.imageGenerations.id, generationId))
    .run()
  syncRemotionAssetForImageGeneration(tx, generationId, {
    status: 'queued',
    errorCode: errorCode ?? null,
    errorMessage: errorMessage ?? null,
  })
}

export function syncImageGenerationTaskState(
  tx: TransactionClient | typeof db,
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
    setImageGenerationQueued(tx, generationId, task.errorMessage, errorCode)
    return
  }

  if (task.status === 'running') {
    setImageGenerationProcessing(tx, generationId, task.errorMessage, task.errorCode)
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

// Dharma footage generation executes the image adapter inside its parent task
// instead of creating a separate image.generate child task. The periodic
// reconciler must not mark that in-flight record as orphaned while the parent
// is legitimately waiting on the provider.
function findDharmaFootageTaskByImageGenerationId(generationId: number): CreationTask | null {
  const eventRows = db.select()
    .from(schema.creationTaskEvents)
    .where(and(
      eq(schema.creationTaskEvents.eventType, 'dharma.footage.generation'),
      like(schema.creationTaskEvents.dataJson, `%\"image_generation_id\":${generationId}%`),
    ))
    .all()
    .sort((a, b) => b.id - a.id)

  for (const event of eventRows) {
    const [task] = db.select()
      .from(schema.creationTasks)
      .where(and(
        eq(schema.creationTasks.id, event.taskId),
        eq(schema.creationTasks.type, 'dharma.footage_generate'),
      ))
      .all()
    if (task) return normalizeTask(task)
  }
  return null
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
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    attempts: row.attempts ?? 0,
    maxAttempts: row.maxAttempts ?? 1,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    cancelRequested: Boolean(row.cancelRequested),
    commitClaimedAt: row.commitClaimedAt ?? null,
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

    // 封面生成的 image generation 记录由 cover.generate 任务直接管理，不走 image.generate task，
    // 调和时不应因找不到 image.generate 任务而将其标记为失败。
    if (record.imageType === 'cover' || record.imageType === 'cover_base') {
      continue
    }

    const dharmaTask = findDharmaFootageTaskByImageGenerationId(generationId)
    if (dharmaTask) {
      if (!isTerminalStatus(dharmaTask.status)) continue
      db.transaction((tx) => {
        if (dharmaTask.status === 'canceled') {
          setImageGenerationCanceled(tx, generationId)
        } else {
          setImageGenerationFailed(
            tx,
            generationId,
            `Dharma footage task ${dharmaTask.id} ${dharmaTask.status} before image generation completed`,
            dharmaTask.errorCode,
          )
        }
        updated++
      })
      continue
    }

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
