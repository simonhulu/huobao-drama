import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import type { TransactionClient } from './tasks/types.js'

type RemotionAssetSyncStatus = 'planned' | 'queued' | 'processing' | 'completed' | 'failed' | 'canceled'

function assetMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function latestAssetStatusForShot(
  client: TransactionClient | typeof db,
  shotId: number,
): 'asset_pending' | 'ready' | 'failed' | null {
  const rows = client.select().from(schema.remotionAssets)
    .where(and(eq(schema.remotionAssets.shotId, shotId), isNull(schema.remotionAssets.deletedAt))).all()
  if (!rows.length) return null

  const latestByKey = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    const current = latestByKey.get(row.assetKey)
    if (!current || (row.version ?? 1) >= (current.version ?? 1)) latestByKey.set(row.assetKey, row)
  }
  const latest = [...latestByKey.values()]
  if (latest.some((asset) => asset.status === 'failed')) return 'failed'
  // Character images are generated as opaque sources first. They become
  // renderable only after the local segmentation step publishes alphaReady.
  if (latest.some((asset) => asset.assetType === 'character' && asset.status === 'completed' && assetMetadata(asset.metadataJson).alphaReady !== true)) {
    return 'asset_pending'
  }
  if (latest.every((asset) => asset.status === 'completed')) return 'ready'
  return 'asset_pending'
}

export function refreshRemotionShotStatus(
  client: TransactionClient | typeof db,
  shotId: number,
  errorCode?: string | null,
  errorMessage?: string | null,
) {
  const status = latestAssetStatusForShot(client, shotId)
  if (!status) return null
  client.update(schema.remotionShots).set({
    status,
    errorCode: errorCode ?? null,
    errorMessage: errorMessage ?? null,
    updatedAt: now(),
  }).where(eq(schema.remotionShots.id, shotId)).run()
  return status
}

/**
 * Keep the Remotion asset state beside image-generation state. This module is
 * deliberately independent from remotion.ts so the image worker can import it
 * without creating a service-cycle through image-generation.ts.
 */
export function syncRemotionAssetForImageGeneration(
  client: TransactionClient | typeof db,
  generationId: number,
  update: {
    status: RemotionAssetSyncStatus
    localPath?: string | null
    sourceUrl?: string | null
    errorCode?: string | null
    errorMessage?: string | null
    completed?: boolean
  },
) {
  const rows = client.select().from(schema.remotionAssets)
    .where(and(eq(schema.remotionAssets.imageGenerationId, generationId), isNull(schema.remotionAssets.deletedAt))).all()
  if (!rows.length) return
  const ts = now()
  for (const asset of rows) {
    const terminal = ['completed', 'failed', 'canceled'].includes(update.status)
    client.update(schema.remotionAssets).set({
      status: update.status,
      localPath: update.localPath === undefined ? asset.localPath : update.localPath,
      sourceUrl: update.sourceUrl === undefined ? asset.sourceUrl : update.sourceUrl,
      errorCode: update.errorCode ?? null,
      errorMessage: update.errorMessage ?? null,
      updatedAt: ts,
      startedAt: update.status === 'processing' ? asset.startedAt ?? ts : asset.startedAt,
      completedAt: terminal
        ? asset.completedAt ?? ts
        : update.completed ? ts : null,
    }).where(eq(schema.remotionAssets.id, asset.id)).run()
    if (asset.shotId) {
      refreshRemotionShotStatus(client, asset.shotId, update.errorCode, update.errorMessage)
    }
  }
}
