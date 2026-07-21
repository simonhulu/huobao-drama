import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import {
  getMediaAccount,
  listMediaAccounts,
  normalizeMediaAccount,
  serializePositioning,
} from '../services/media-accounts.js'

const app = new Hono()

function numberId(value: string) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

function positioningFromBody(body: Record<string, unknown>) {
  return body.positioning ?? body.positioning_json ?? {}
}

app.get('/', (c) => success(c, listMediaAccounts()))

app.get('/:id', (c) => {
  const id = numberId(c.req.param('id'))
  if (!id) return badRequest(c, 'invalid media account id')
  const account = getMediaAccount(id)
  return account ? success(c, account) : notFound(c, 'Media account not found')
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest(c, 'name is required')
  const ts = now()
  const result = db.insert(schema.mediaAccounts).values({
    name,
    handle: typeof body.handle === 'string' ? body.handle.trim() || null : null,
    positioningJson: serializePositioning(positioningFromBody(body)),
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const account = getMediaAccount(Number(result.lastInsertRowid))
  return created(c, account)
})

app.put('/:id', async (c) => {
  const id = numberId(c.req.param('id'))
  if (!id) return badRequest(c, 'invalid media account id')
  const [existing] = db.select().from(schema.mediaAccounts).where(eq(schema.mediaAccounts.id, id)).all()
  if (!existing || existing.deletedAt) return notFound(c, 'Media account not found')
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>
  const updates: Record<string, unknown> = { updatedAt: now() }
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()
  if (body.handle !== undefined) updates.handle = typeof body.handle === 'string' ? body.handle.trim() || null : null
  if (body.positioning !== undefined || body.positioning_json !== undefined) {
    updates.positioningJson = serializePositioning(positioningFromBody(body))
  }
  if (Object.keys(updates).length === 1) return badRequest(c, 'no valid fields')
  db.update(schema.mediaAccounts).set(updates).where(eq(schema.mediaAccounts.id, id)).run()
  const [updated] = db.select().from(schema.mediaAccounts).where(eq(schema.mediaAccounts.id, id)).all()
  return success(c, updated ? normalizeMediaAccount(updated) : null)
})

app.delete('/:id', (c) => {
  const id = numberId(c.req.param('id'))
  if (!id) return badRequest(c, 'invalid media account id')
  const account = getMediaAccount(id)
  if (!account) return notFound(c, 'Media account not found')
  const ts = now()
  db.update(schema.mediaAccounts).set({ deletedAt: ts, updatedAt: ts }).where(eq(schema.mediaAccounts.id, id)).run()
  return success(c)
})

export default app
