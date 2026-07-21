import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'
import ffmpeg from 'fluent-ffmpeg'
import path from 'path'

function toAbs(p: string) {
  if (path.isAbsolute(p)) return p
  if (p.startsWith('static/')) return path.resolve(import.meta.dirname, '../../data', p)
  return path.resolve(import.meta.dirname, '../../data/static', p)
}

async function main() {
  const episodeId = 139
  const sbs = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
  for (const sb of sbs) {
    if (!sb.composedVideoUrl) continue
    const d = await new Promise<number>((resolve) => {
      ffmpeg.ffprobe(toAbs(sb.composedVideoUrl!), (err, m) => resolve(err ? 0 : (m.format.duration || 0)))
    })
    db.update(schema.storyboards).set({ duration: d }).where(eq(schema.storyboards.id, sb.id)).run()
    console.log(sb.id, d.toFixed(2))
  }
}
main().catch(console.error)
