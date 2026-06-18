import { eq } from 'drizzle-orm'
import { db, schema } from '../../../db/index.js'
import { now } from '../../../utils/response.js'
import { executeImageGeneration } from '../../image-generation.js'
import { splitGridImage as defaultSplitGridImage } from '../../grid-split.js'
import { registerTaskHandler } from '../registry.js'
import type { TaskContext, TaskHandler } from '../types.js'

interface GridGeneratePayload {
  grid_draft_id?: number
  gridDraftId?: number
  image_generation_id?: number
  imageGenerationId?: number
  config_id?: number
  configId?: number
}

interface GridSplitPayload {
  image_generation_id?: number
  imageGenerationId?: number
  rows?: number
  cols?: number
  assignments?: Array<{ storyboard_id?: number; storyboardId?: number; frame_type?: string; frameType?: string }>
}

interface GridGenerateDeps {
  executeImageGeneration?: typeof executeImageGeneration
}

interface GridSplitDeps {
  splitGridImage?: typeof defaultSplitGridImage
}

export function createGridGenerateHandler(deps: GridGenerateDeps = {}): TaskHandler<GridGeneratePayload> {
  const execute = deps.executeImageGeneration ?? executeImageGeneration
  return {
    resumable: true,
    maxAttempts: 2,
    async run(ctx: TaskContext<GridGeneratePayload>) {
      const draftId = Number(ctx.payload.grid_draft_id ?? ctx.payload.gridDraftId)
      const generationId = Number(ctx.payload.image_generation_id ?? ctx.payload.imageGenerationId)
      const configId = ctx.payload.config_id ?? ctx.payload.configId
      if (!draftId) throw new Error('grid_draft_id is required')
      if (!generationId) throw new Error('image_generation_id is required')

      ctx.progress('Generating grid image', 0, 2)
      const result = await execute(generationId, {
        configId: configId == null ? undefined : Number(configId),
        taskContext: ctx,
      })
      db.update(schema.gridDrafts).set({
        activeImagePath: result.local_path ?? null,
        imageGenerationId: generationId,
        updatedAt: now(),
      }).where(eq(schema.gridDrafts.id, draftId)).run()

      const response = {
        grid_draft_id: draftId,
        image_generation_id: generationId,
        local_path: result.local_path,
      }
      ctx.progress('Grid image generated', 2, 2)
      ctx.event('grid.generated', response)
      return response
    },
  }
}

export function createGridSplitHandler(deps: GridSplitDeps = {}): TaskHandler<GridSplitPayload> {
  const splitGridImage = deps.splitGridImage ?? defaultSplitGridImage
  return {
    resumable: true,
    maxAttempts: 1,
    async run(ctx: TaskContext<GridSplitPayload>) {
      const generationId = Number(ctx.payload.image_generation_id ?? ctx.payload.imageGenerationId)
      const rows = Number(ctx.payload.rows)
      const cols = Number(ctx.payload.cols)
      const assignments = ctx.payload.assignments || []
      if (!generationId) throw new Error('image_generation_id is required')
      if (!rows || !cols) throw new Error('rows and cols are required')
      if (!assignments.length) throw new Error('assignments are required')

      const [imgRecord] = db.select().from(schema.imageGenerations)
        .where(eq(schema.imageGenerations.id, generationId))
        .all()
      if (!imgRecord) throw new Error('Image generation not found')
      if (imgRecord.status !== 'completed') throw new Error(`Image status: ${imgRecord.status}`)
      if (!imgRecord.localPath) throw new Error('No local image file')

      ctx.progress('Splitting grid image', 0, assignments.length)
      const cells = await splitGridImage(imgRecord.localPath, rows, cols)

      const results: any[] = []
      for (let i = 0; i < assignments.length && i < cells.length; i++) {
        const assignment = assignments[i]
        const storyboardId = Number(assignment.storyboard_id ?? assignment.storyboardId)
        const frameType = assignment.frame_type ?? assignment.frameType
        const cell = cells[i]
        if (!storyboardId) continue

        const update: Record<string, any> = { updatedAt: now() }
        if (frameType === 'first_frame') update.firstFrameImage = cell.localPath
        else if (frameType === 'last_frame') update.lastFrameImage = cell.localPath
        else if (frameType === 'reference') {
          const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
          const existing = sb?.referenceImages ? JSON.parse(sb.referenceImages) : []
          existing.push(cell.localPath)
          update.referenceImages = JSON.stringify(existing)
        }

        db.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, storyboardId)).run()
        results.push({ storyboard_id: storyboardId, frame_type: frameType, local_path: cell.localPath })
        ctx.progress('Applied grid cell assignment', i + 1, assignments.length)
      }

      const response = { cells: results }
      ctx.event('grid.split.completed', response)
      return response
    },
  }
}

export function registerGridHandlers() {
  registerTaskHandler('grid.generate', createGridGenerateHandler())
  registerTaskHandler('grid.split', createGridSplitHandler())
}
