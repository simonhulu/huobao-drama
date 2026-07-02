import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound, badRequest, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'

const app = new Hono()

app.get('/', async (c) => {
  const rows = db.select().from(schema.introTemplates).orderBy(schema.introTemplates.createdAt).all()
  return success(c, toSnakeCaseArray(rows))
})

app.get('/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = db.select().from(schema.introTemplates).where(eq(schema.introTemplates.id, id)).all()
  if (!row) return notFound(c, 'Template not found')
  return success(c, toSnakeCase(row))
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  if (!body.id || !body.name || !body.config) return badRequest(c, 'id, name, config required')
  const ts = now()
  db.insert(schema.introTemplates).values({
    id: body.id,
    name: body.name,
    config: typeof body.config === 'string' ? body.config : JSON.stringify(body.config),
    isDefault: !!body.is_default,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return created(c, { id: body.id })
})

app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) updates.name = body.name
  if (body.config !== undefined) updates.config = typeof body.config === 'string' ? body.config : JSON.stringify(body.config)
  db.update(schema.introTemplates).set(updates).where(eq(schema.introTemplates.id, id)).run()
  return success(c)
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  db.delete(schema.introTemplates).where(eq(schema.introTemplates.id, id)).run()
  return success(c)
})

app.post('/:id/set-default', async (c) => {
  const id = c.req.param('id')
  const ts = now()
  db.update(schema.introTemplates).set({ isDefault: false }).run()
  db.update(schema.introTemplates).set({ isDefault: true, updatedAt: ts }).where(eq(schema.introTemplates.id, id)).run()
  return success(c)
})

export default app
