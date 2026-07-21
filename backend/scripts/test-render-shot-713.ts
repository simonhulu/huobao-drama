import path from 'path'
import fs from 'fs'
import { db, schema } from '../src/db/index.js'
import { eq } from 'drizzle-orm'
import {
  buildStoryboardComposition,
  renderStoryboardComposition,
  parseMovement,
} from '../src/services/composition/index.js'
import { ensureFont } from '../src/services/composition/fonts.js'
import type { TitleOverlay, GrainVignetteOverlay } from '../src/services/composition/types.js'

const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(import.meta.dirname, '../../data/static')
const DATA_ROOT = path.resolve(import.meta.dirname, '../../data')

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

async function main() {
  const storyboardId = 713
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)
  if (!sb.firstFrameImage) throw new Error(`Storyboard ${storyboardId} has no first_frame_image`)

  console.log('Rendering storyboard:', sb.title, '| movement:', sb.movement)

  const outputDir = path.join(STORAGE_ROOT, 'composed')
  fs.mkdirSync(outputDir, { recursive: true })

  const motion = parseMovement(sb.movement) || undefined

  const composition = buildStoryboardComposition({
    outputDir,
    width: 1920,
    height: 1080,
    duration: 5,
    baseImagePath: toAbsPath(sb.firstFrameImage),
    motion,
    audioLayers: [],
  })

  const fontPath = await ensureFont()

  const titleOverlay: TitleOverlay = {
    kind: 'title',
    start: 0,
    duration: 5,
    params: { text: sb.title || 'Chapter', fontPath },
  }

  const grainOverlay: GrainVignetteOverlay = {
    kind: 'grain-vignette',
    start: 0,
    duration: 5,
    params: { grainIntensity: 0.04, vignetteIntensity: 0.35 },
  }

  composition.video.overlays = [titleOverlay, grainOverlay]

  const result = await renderStoryboardComposition(composition)
  console.log('Rendered video:', result.outputPath)
  console.log('Duration:', result.duration)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
