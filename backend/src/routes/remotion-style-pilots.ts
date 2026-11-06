import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success } from '../utils/response.js'

const app = new Hono()

app.get('/', (c) => {
  const table = schema.stylePilots
  const items = db.select({
    id: table.id,
    name: table.name,
    desc: table.desc,
    mood: table.mood,
    lens: table.lens,
    profile: table.profile,
    aspectRatio: table.aspectRatio,
    prompt: table.prompt,
    url: table.url,
    mediaType: table.mediaType,
    sortOrder: table.sortOrder,
  }).from(table)
    .where(eq(table.isActive, true))
    .orderBy(asc(table.sortOrder), asc(table.id))
    .all()

  return success(c, { items })
})

export default app
