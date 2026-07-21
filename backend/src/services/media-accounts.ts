import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export type PositioningRecord = Record<string, unknown>

export const POSITIONING_SCHEMA_VERSION = 1

export function parseJsonRecord(value: unknown): PositioningRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as PositioningRecord
  }
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PositioningRecord
      : {}
  } catch {
    return {}
  }
}

export function serializePositioning(value: unknown): string {
  return JSON.stringify(parseJsonRecord(value))
}

export function normalizeMediaAccount(row: typeof schema.mediaAccounts.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    positioning: parseJsonRecord(row.positioningJson),
    positioningVersion: POSITIONING_SCHEMA_VERSION,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function listMediaAccounts() {
  return db.select().from(schema.mediaAccounts)
    .where(isNull(schema.mediaAccounts.deletedAt))
    .orderBy(desc(schema.mediaAccounts.updatedAt), desc(schema.mediaAccounts.id))
    .all()
    .map(normalizeMediaAccount)
}

export function getMediaAccount(id: number) {
  const [row] = db.select().from(schema.mediaAccounts).where(and(
    eq(schema.mediaAccounts.id, id),
    isNull(schema.mediaAccounts.deletedAt),
  )).all()
  return row ? normalizeMediaAccount(row) : null
}

export function getMediaAccountRow(id: number | null | undefined) {
  if (!id) return null
  const [row] = db.select().from(schema.mediaAccounts).where(and(
    eq(schema.mediaAccounts.id, id),
    isNull(schema.mediaAccounts.deletedAt),
  )).all()
  return row ?? null
}

export function getDefaultMediaAccountRow() {
  const [row] = db.select().from(schema.mediaAccounts).where(isNull(schema.mediaAccounts.deletedAt))
    .orderBy(schema.mediaAccounts.id)
    .limit(1)
    .all()
  if (row) return row

  const ts = now()
  const result = db.insert(schema.mediaAccounts).values({
    name: '默认自媒体账号',
    positioningJson: '{}',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return db.select().from(schema.mediaAccounts)
    .where(eq(schema.mediaAccounts.id, Number(result.lastInsertRowid)))
    .all()[0] ?? null
}

