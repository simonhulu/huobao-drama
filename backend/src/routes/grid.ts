import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import fs from 'fs'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { aspectRatioToSize } from '../services/adapters/aspect-ratio-to-size.js'
import { splitGridImage } from '../services/grid-split.js'
import { buildConsistencySeed, buildConsistencySuffix, buildGridConsistencyInput } from '../services/image-seed.js'
import { createAgent } from '../agents/index.js'
import { styleToPromptPhrase } from '../services/visual-style.js'
import { logTaskError, logTaskPayload, logTaskProgress } from '../utils/task-logger.js'
import { createTask } from '../services/tasks/store.js'
import { getAbsolutePath } from '../utils/storage.js'
import { areStoryboardNumbersContiguous } from '../services/grid-story-props.js'

const app = new Hono()

const POSITIONS = [
  'top-left', 'top-right', 'top-center',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

function posLabel(i: number, rows: number, cols: number) {
  const r = Math.floor(i / cols), c = i % cols
  return `row ${r + 1} col ${c + 1}`
}

function cellLabel(i: number, rows: number, cols: number) {
  return `格${i + 1}（${posLabel(i, rows, cols)}）`
}

function safeParseJsonArray(value: any): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(Boolean) : []
  } catch {
    return []
  }
}

function getStoryboardCharacterIds(storyboardIds: number[]) {
  if (!storyboardIds.length) return new Map<number, number[]>()
  const links = db.select().from(schema.storyboardCharacters).all()
    .filter((link) => storyboardIds.includes(link.storyboardId))
  const map = new Map<number, number[]>()
  for (const link of links) {
    const arr = map.get(link.storyboardId) || []
    arr.push(link.characterId)
    map.set(link.storyboardId, arr)
  }
  return map
}

function collectGridReferenceAssets(storyboards: any[]) {
  const storyboardIds = storyboards.map((sb) => sb.id)
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboardIds)
  const sceneIds = [...new Set(storyboards.map((sb) => sb.sceneId).filter(Boolean))]
  const characterIds = [...new Set([...storyboardCharacterIds.values()].flat().filter(Boolean))]

  const scenes = sceneIds.length
    ? db.select().from(schema.scenes).all().filter((scene) => sceneIds.includes(scene.id))
    : []
  const characters = characterIds.length
    ? db.select().from(schema.characters).all().filter((char) => characterIds.includes(char.id))
    : []

  const assets: Array<{
    path: string
    label: string
    kind: 'scene' | 'character' | 'storyboard'
    sceneId?: number
    characterId?: number
    storyboardId?: number
  }> = []
  const seen = new Set<string>()
  const pushAsset = (
    path: string | null | undefined,
    label: string,
    kind: 'scene' | 'character' | 'storyboard',
    extra: { sceneId?: number; characterId?: number; storyboardId?: number } = {},
  ) => {
    if (!path || seen.has(path) || assets.length >= 6) return
    seen.add(path)
    assets.push({ path, label, kind, ...extra })
  }

  for (const sb of storyboards) {
    pushAsset(sb.firstFrameImage, `镜头${sb.storyboardNumber}首帧`, 'storyboard', { storyboardId: sb.id })
    pushAsset(sb.lastFrameImage, `镜头${sb.storyboardNumber}尾帧`, 'storyboard', { storyboardId: sb.id })
    pushAsset(sb.composedImage, `镜头${sb.storyboardNumber}镜头图`, 'storyboard', { storyboardId: sb.id })
    for (const ref of safeParseJsonArray(sb.referenceImages)) {
      pushAsset(ref, `镜头${sb.storyboardNumber}参考图`, 'storyboard', { storyboardId: sb.id })
    }
  }
  for (const scene of scenes) {
    pushAsset(scene.imageUrl, `${scene.location}${scene.time ? `（${scene.time}）` : ''}场景`, 'scene', { sceneId: scene.id })
  }
  for (const char of characters) {
    pushAsset(char.imageUrl, `${char.name}角色`, 'character', { characterId: char.id })
  }

  return assets.map((asset, index) => ({
    ...asset,
    imageIndex: index + 1,
    imageLabel: `图片${index + 1}`,
  }))
}

function buildReferenceLegend(referenceAssets: Array<{ imageLabel: string; label: string }>) {
  if (!referenceAssets.length) return ''
  return referenceAssets.map((asset) => `${asset.imageLabel}=${asset.label}`).join('；')
}

function buildStoryboardReferenceHints(
  sb: any,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string; sceneId?: number; characterId?: number; storyboardId?: number }>,
  storyboardCharacterIds: Map<number, number[]>,
) {
  const hints: string[] = []
  const charIds = storyboardCharacterIds.get(sb.id) || []

  for (const asset of referenceAssets) {
    if (asset.kind === 'scene' && sb.sceneId && asset.sceneId === sb.sceneId) {
      hints.push(`${asset.imageLabel}（${asset.label}）`)
    }
    if (asset.kind === 'character') {
      if (asset.characterId && charIds.includes(asset.characterId)) {
        hints.push(`${asset.imageLabel}（${asset.label}）`)
      }
    }
    if (asset.kind === 'storyboard' && asset.storyboardId === sb.id) {
      hints.push(`${asset.imageLabel}（${asset.label}）`)
    }
  }

  return [...new Set(hints)].slice(0, 4)
}

// Build prompt based on mode
function buildGridPrompt(
  mode: string,
  storyboards: any[],
  rows: number,
  cols: number,
  dramaStyle: string,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string }>,
): string {
  const style = styleToPromptPhrase(dramaStyle) || 'cinematic film still, dramatic lighting, movie composition'
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboards.map((sb) => sb.id))
  const legend = buildReferenceLegend(referenceAssets)

  if (mode === 'first_frame') {
    // Each cell = one shot's first frame
    const cells = storyboards.map((sb, i) => {
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${i + 1}`
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      return `${cellLabel(i, rows, cols)}: ${refs.length ? `参考${refs.join('、')}，` : ''}${desc}`
    })
    return [
      `${rows}x${cols} grid layout, consistent art style, ${style},`,
      legend ? `参考图映射：${legend}` : '',
      '当画面涉及角色或场景时，优先使用对应的图片编号来约束一致性。',
      ...cells,
      'high quality, cinematic lighting, no text, no watermark',
    ].filter(Boolean).join('\n')
  }

  if (mode === 'first_last') {
    // Fill the selected grid using first/last-frame style cues, but do not force Nx2 layout.
    const totalCells = rows * cols
    const cells = Array.from({ length: totalCells }, (_, i) => {
      const sb = storyboards[i % storyboards.length]
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${i + 1}`
      const action = sb.action || sb.movement || ''
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      const frameHint = i % 2 === 0
        ? 'opening moment'
        : `${action ? `${action}, ` : ''}closing moment, subtle motion change`
      return `${cellLabel(i, rows, cols)}: ${refs.length ? `参考${refs.join('、')}，` : ''}${desc}, ${frameHint}`
    })
    return [
      `${rows}x${cols} grid layout, consistent art style, ${style},`,
      legend ? `参考图映射：${legend}` : '',
      'first/last frame visual rhythm, alternating opening and closing beats across the grid,',
      ...cells,
      'continuous motion implied between left and right, high quality, no text',
    ].filter(Boolean).join('\n')
  }

  if (mode === 'multi_ref') {
    // All cells are different angles/compositions of the same shot
    const sb = storyboards[0]
    const desc = sb.imagePrompt || sb.description || sb.title || 'scene'
    const angles = [
      'wide establishing shot', 'medium shot character focus',
      'close-up detail', 'dramatic low angle', 'over-the-shoulder view',
      'bird eye view', 'side profile', 'atmospheric detail',
      'extreme close-up', 'dutch angle', 'silhouette shot',
      'depth of field focus', 'symmetrical composition', 'leading lines',
      'negative space', 'high angle looking down', 'ground level',
      'panoramic wide', 'intimate two-shot', 'reflection shot',
      'shadow play', 'backlit silhouette', 'macro detail',
      'split lighting', 'rim light portrait',
    ]
    const totalCells = rows * cols
    const cells = Array.from({ length: totalCells }, (_, i) => {
      return `${cellLabel(i, rows, cols)}: ${legend ? `参考${legend}，` : ''}${desc}, ${angles[i % angles.length]}`
    })
    return [
      `${rows}x${cols} grid layout, same scene different angles and compositions, ${style},`,
      legend ? `参考图映射：${legend}` : '',
      `main scene: ${desc},`,
      ...cells,
      'consistent lighting and color palette, high quality, no text',
    ].filter(Boolean).join('\n')
  }

  return `${rows}x${cols} grid, ${style}, storyboard frames, high quality`
}

function buildGridCellPrompts(
  mode: string,
  storyboards: any[],
  rows: number,
  cols: number,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string }>,
) {
  if (!storyboards.length) return []
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboards.map((sb) => sb.id))

  if (mode === 'multi_ref') {
    const sb = storyboards[0]
    const desc = sb.imagePrompt || sb.description || sb.title || 'scene'
    const angles = [
      'wide establishing shot', 'medium shot character focus',
      'close-up detail', 'dramatic low angle', 'over-the-shoulder view',
      'bird eye view', 'side profile', 'atmospheric detail',
      'extreme close-up', 'dutch angle', 'silhouette shot',
      'depth of field focus', 'symmetrical composition', 'leading lines',
      'negative space', 'high angle looking down', 'ground level',
      'panoramic wide', 'intimate two-shot', 'reflection shot',
      'shadow play', 'backlit silhouette', 'macro detail',
      'split lighting', 'rim light portrait',
    ]
    return Array.from({ length: rows * cols }, (_, i) => ({
      shot_number: sb.storyboardNumber,
      frame_type: 'reference',
      prompt: `${cellLabel(i, rows, cols)}: ${buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds).join('、')}${buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds).length ? '，' : ''}${desc}, ${angles[i % angles.length]}`,
    }))
  }

  if (mode === 'first_last') {
    return Array.from({ length: rows * cols }, (_, i) => {
      const sb = storyboards[i % storyboards.length]
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${sb.storyboardNumber || ''}`
      const motion = sb.action || sb.movement || ''
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      const isFirst = i % 2 === 0
      return {
        shot_number: sb.storyboardNumber,
        frame_type: isFirst ? 'first_frame' : 'last_frame',
        prompt: isFirst
          ? `${cellLabel(i, rows, cols)}，首帧：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${sb.location ? `, ${sb.location}` : ''}${sb.shotType ? `, ${sb.shotType}` : ''}`
          : `${cellLabel(i, rows, cols)}，尾帧：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${motion ? `, ${motion}` : ''}${sb.location ? `, ${sb.location}` : ''}${sb.shotType ? `, ${sb.shotType}` : ''}`,
      }
    })
  }

  return storyboards.slice(0, rows * cols).map((sb, index) => {
    const desc = sb.imagePrompt || sb.description || sb.title || `shot ${sb.storyboardNumber || ''}`
    const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
    return {
      shot_number: sb.storyboardNumber,
      frame_type: 'first_frame',
      prompt: `${cellLabel(index, rows, cols)}：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${sb.location ? `, ${sb.location}` : ''}${sb.shotType ? `, ${sb.shotType}` : ''}, opening scene`,
    }
  })
}

function extractJsonCandidate(text: string) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()

  const plain = text.match(/\{[\s\S]*\}/)
  return plain?.[0]?.trim() || ''
}

function normalizeGridPayload(payload: any) {
  if (!payload || typeof payload !== 'object') return null
  const gridPrompt = typeof payload.grid_prompt === 'string'
    ? payload.grid_prompt.trim()
    : typeof payload.gridPrompt === 'string'
      ? payload.gridPrompt.trim()
      : ''
  const rawCells = Array.isArray(payload.cell_prompts)
    ? payload.cell_prompts
    : Array.isArray(payload.cellPrompts)
      ? payload.cellPrompts
      : []
  const cellPrompts = rawCells.map((cell: any) => ({
    shot_number: Number(cell?.shot_number ?? cell?.shotNumber ?? 0) || 0,
    frame_type: String(cell?.frame_type ?? cell?.frameType ?? 'first_frame'),
    prompt: String(cell?.prompt ?? '').trim(),
  })).filter((cell: any) => cell.prompt)

  if (!gridPrompt) return null
  return { grid_prompt: gridPrompt, cell_prompts: cellPrompts }
}

function findGridPayload(value: any): { grid_prompt: string; cell_prompts: any[] } | null {
  if (!value) return null

  const normalized = normalizeGridPayload(value)
  if (normalized) return normalized

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'null') return null
    try {
      const parsed = JSON.parse(trimmed)
      return findGridPayload(parsed)
    } catch {
      const candidate = extractJsonCandidate(trimmed)
      if (!candidate) return null
      try {
        return findGridPayload(JSON.parse(candidate))
      } catch {
        return null
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGridPayload(item)
      if (found) return found
    }
    return null
  }

  if (typeof value === 'object') {
    for (const nested of Object.values(value)) {
      const found = findGridPayload(nested)
      if (found) return found
    }
  }

  return null
}

async function tryAgentGridPrompt(
  episodeId: number,
  dramaId: number,
  storyboardIds: number[],
  rows: number,
  cols: number,
  mode: string,
  referenceLegend: string,
  dramaStyle: string,
) {
  const agent = createAgent('grid_prompt_generator', episodeId, dramaId)
  if (!agent) return null

  const result = await agent.generate(
    [{
      role: 'user',
      content: [
        '请为宫格图生成提示词，并优先调用工具完成。',
        `选中镜头ID：${JSON.stringify(storyboardIds)}`,
        `行数：${rows}`,
        `列数：${cols}`,
        `模式：${mode}`,
        `整体视觉风格：${dramaStyle || 'cinematic'}，所有格子必须保持同一风格。`,
        referenceLegend ? `参考图映射：${referenceLegend}` : '',
        '当提示词涉及到某个角色或场景时，直接把对应的图片编号写进提示词，例如：图片1中的角色A站了起来，图片3中的房间场景。不要只写名字，不写图片编号。',
        `必须严格按 ${rows}x${cols} 生成，总共 exactly ${rows * cols} visible panels。不要合并格子，不要缺格。`,
        '必须返回 JSON，结构为：{"grid_prompt":"...","cell_prompts":[{"shot_number":1,"frame_type":"first_frame","prompt":"..."}]}',
      ].join('\n'),
    }],
    { maxSteps: 10 },
  )

  const fromTools = findGridPayload(result.toolResults)
  if (fromTools) return fromTools

  const fromText = findGridPayload(result.text)
  if (fromText) return fromText

  return null
}

// POST /grid/prompt
app.post('/prompt', async (c) => {
  const body = await c.req.json()
  const {
    storyboard_ids,
    drama_id,
    episode_id,
    rows,
    cols,
    mode = 'first_frame',
  } = body

  if (!storyboard_ids?.length) return badRequest(c, 'storyboard_ids required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')

  const storyboards = storyboard_ids.map((id: number) => {
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    return sb
  }).filter(Boolean)

  if (!storyboards.length) return badRequest(c, 'No storyboards found')

  let dramaStyle = ''
  if (drama_id) {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama_id)).all()
    dramaStyle = drama?.style || ''
  }

  const actualCols = cols
  const actualRows = rows
  const resolvedEpisodeId = Number(episode_id || storyboards[0]?.episodeId || 0)
  const referenceAssets = collectGridReferenceAssets(storyboards)
  const referenceLegend = buildReferenceLegend(referenceAssets)

  if (!resolvedEpisodeId) {
    return badRequest(c, 'episode_id required')
  }

  try {
    const agentPayload = await tryAgentGridPrompt(
      resolvedEpisodeId,
      Number(drama_id || 0),
      storyboard_ids,
      actualRows,
      actualCols,
      mode,
      referenceLegend,
      dramaStyle,
    )

    if (agentPayload?.grid_prompt) {
      logTaskProgress('GridPrompt', 'agent-success', {
        episodeId: resolvedEpisodeId,
        dramaId: drama_id,
        mode,
        rows: actualRows,
        cols: actualCols,
        storyboardCount: storyboard_ids.length,
      })
      logTaskPayload('GridPrompt', 'agent-result', agentPayload)
      return success(c, {
        ...agentPayload,
        source: 'agent',
        grid: { rows: actualRows, cols: actualCols },
        storyboard_ids,
        mode,
      })
    }
  } catch (err: any) {
    logTaskError('GridPrompt', 'agent-failed', {
      episodeId: resolvedEpisodeId,
      dramaId: drama_id,
      error: err.message,
    })
  }

  const gridPrompt = buildGridPrompt(mode, storyboards, actualRows, actualCols, dramaStyle, referenceAssets)
  const cellPrompts = buildGridCellPrompts(mode, storyboards, actualRows, actualCols, referenceAssets)
  logTaskProgress('GridPrompt', 'fallback-used', {
    episodeId: resolvedEpisodeId,
    dramaId: drama_id,
    mode,
    rows: actualRows,
    cols: actualCols,
    storyboardCount: storyboard_ids.length,
  })

  return success(c, {
    grid_prompt: gridPrompt,
    cell_prompts: cellPrompts,
    source: 'fallback',
    grid: { rows: actualRows, cols: actualCols },
    storyboard_ids,
    mode,
  })
})

// POST /grid/generate
app.post('/generate', async (c) => {
  const body = await c.req.json()
  const {
    storyboard_ids,
    drama_id,
    rows,
    cols,
    mode = 'first_frame', // first_frame | first_last | multi_ref
    custom_prompt,
    aspect_ratio,
  } = body

  if (!storyboard_ids?.length) return badRequest(c, 'storyboard_ids required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')

  const storyboards = storyboard_ids.map((id: number) => {
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    return sb
  }).filter(Boolean)

  if (!storyboards.length) return badRequest(c, 'No storyboards found')

  // Get drama style
  let dramaStyle = ''
  if (drama_id) {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama_id)).all()
    dramaStyle = drama?.style || ''
  }

  const referenceAssets = collectGridReferenceAssets(storyboards)
  const basePrompt = custom_prompt || buildGridPrompt(mode, storyboards, rows, cols, dramaStyle, referenceAssets)
  const consistency = buildGridConsistencyInput(storyboard_ids)
  const consistencySeed = buildConsistencySeed(consistency)
  const prompt = `${basePrompt}${buildConsistencySuffix(consistency)}`
  const referenceImages = referenceAssets.map((asset) => asset.path)

  const baseSize = aspectRatioToSize(aspect_ratio)
  const [baseWStr, baseHStr] = baseSize.split('x')
  const cellW = Math.round(Number(baseWStr) / cols)
  const cellH = Math.round(Number(baseHStr) / rows)
  const actualCols = cols
  const actualRows = rows
  const size = `${cellW * actualCols}x${cellH * actualRows}`

  try {
    const genId = await generateImage({
      dramaId: drama_id,
      prompt,
      size,
      frameType: `grid_${mode}_${actualRows}x${actualCols}`,
      referenceImages,
      seed: consistencySeed,
      style: dramaStyle,
    })

    logTaskProgress('GridGenerate', 'reference-images', {
      dramaId: drama_id,
      mode,
      rows: actualRows,
      cols: actualCols,
      referenceCount: referenceImages.length,
    })

    return success(c, {
      image_generation_id: genId,
      grid: { rows: actualRows, cols: actualCols },
      mode,
      storyboard_ids,
      prompt,
      reference_images: referenceImages,
    })
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// POST /grid/split
app.post('/split', async (c) => {
  const body = await c.req.json()
  const {
    image_generation_id,
    rows,
    cols,
    assignments, // [{storyboard_id, frame_type: 'first_frame'|'last_frame'|'reference'}]
  } = body

  if (!image_generation_id) return badRequest(c, 'image_generation_id required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')
  if (!assignments?.length) return badRequest(c, 'assignments required')

  const [imgRecord] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, image_generation_id)).all()

  if (!imgRecord) return badRequest(c, 'Image generation not found')
  if (imgRecord.status !== 'completed') return badRequest(c, `Image status: ${imgRecord.status}`)
  if (!imgRecord.localPath) return badRequest(c, 'No local image file')

  try {
    const cells = await splitGridImage(imgRecord.localPath, rows, cols)

    const results: any[] = []
    for (let i = 0; i < assignments.length && i < cells.length; i++) {
      const { storyboard_id, frame_type } = assignments[i]
      const cell = cells[i]
      if (!storyboard_id) continue

      const update: Record<string, any> = { updatedAt: now() }
      if (frame_type === 'first_frame') update.firstFrameImage = cell.localPath
      else if (frame_type === 'last_frame') update.lastFrameImage = cell.localPath
      else if (frame_type === 'reference') {
        const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
        const existing = sb?.referenceImages ? JSON.parse(sb.referenceImages) : []
        existing.push(cell.localPath)
        update.referenceImages = JSON.stringify(existing)
      }

      db.update(schema.storyboards).set(update).where(eq(schema.storyboards.id, storyboard_id)).run()
      results.push({ storyboard_id, frame_type, local_path: cell.localPath })
    }

    return success(c, { cells: results })
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// GET /grid/status/:id
app.get('/status/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  if (!row) return badRequest(c, 'Not found')
  return success(c, {
    id: row.id,
    status: row.status,
    local_path: row.localPath,
    image_url: row.imageUrl,
    error_msg: row.errorMsg,
  })
})

// POST /grid/episode/:episodeId/generate —— 每分镜单张16:9图片流水线
app.post('/episode/:episodeId/generate', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const body = await c.req.json().catch(() => ({} as any))
  const force = Boolean((body as any).force)
  const review = (body as any).review !== false
  const useReferenceImages = (body as any).useReferenceImages !== false
  const onlyIds = Array.isArray((body as any).onlyStoryboardIds)
    ? (body as any).onlyStoryboardIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : undefined

  const task = createTask({
    type: 'grid.episode_generate',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: force
      ? `grid.episode_generate:${episodeId}:force:${Date.now()}`
      : `grid.episode_generate:${episodeId}`,
    payload: {
      episode_id: episodeId,
      force,
      review,
      only_storyboard_ids: onlyIds,
      use_reference_images: useReferenceImages,
    },
  })
  return success(c, { task_id: task.id })
})

// POST /grid/episode/:episodeId/review —— VLM 六维校验（可独立触发）
app.post('/episode/:episodeId/review', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const body = await c.req.json().catch(() => ({} as any))
  const onlyIds = Array.isArray((body as any).onlyStoryboardIds)
    ? (body as any).onlyStoryboardIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : undefined
  const requestedMaxRetries = Number((body as any).maxRetries)
  const maxRetries = Number.isFinite(requestedMaxRetries)
    ? Math.max(0, Math.floor(requestedMaxRetries))
    : undefined

  const task = createTask({
    type: 'grid.episode_review',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `grid.episode_review:${episodeId}:${Date.now()}`,
    payload: { episode_id: episodeId, only_storyboard_ids: onlyIds, max_retries: maxRetries },
  })
  return success(c, { task_id: task.id })
})

// POST /grid/episode/:episodeId/render —— GridStoryPreview 合成整集 mp4
app.post('/episode/:episodeId/render', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const body = await c.req.json().catch(() => ({} as any))
  const onlyIds = Array.isArray((body as any).onlyStoryboardIds)
    ? (body as any).onlyStoryboardIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : undefined
  const maxDurationSec = Number((body as any).maxDurationSec)
  if (onlyIds?.length) {
    const selectedNumbers = db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter((sb) => onlyIds.includes(sb.id))
      .map((sb) => sb.storyboardNumber)
    if (selectedNumbers.length !== new Set(onlyIds).size) return badRequest(c, 'unknown storyboardId')
    if (!areStoryboardNumbersContiguous(selectedNumbers)) {
      return badRequest(c, 'non-contiguous storyboard render would skip narration')
    }
  }

  const task = createTask({
    type: 'grid.episode_render',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `grid.episode_render:${episodeId}:${Date.now()}`,
    payload: {
      episode_id: episodeId,
      only_storyboard_ids: onlyIds,
      max_duration_sec: Number.isFinite(maxDurationSec) && maxDurationSec > 0 ? maxDurationSec : undefined,
    },
  })
  return success(c, { task_id: task.id })
})

// POST /grid/episode/:episodeId/videos —— Grok 视频素材层（复用优先，未命中才生成）
app.post('/episode/:episodeId/videos', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isFinite(episodeId) || episodeId <= 0) return badRequest(c, 'invalid episodeId')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const body = await c.req.json().catch(() => ({} as any))
  const storyboardIds = Array.isArray((body as any).storyboardIds)
    ? (body as any).storyboardIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : []
  if (!storyboardIds.length) return badRequest(c, 'storyboardIds required')

  const task = createTask({
    type: 'grid.episode_videos',
    dramaId: ep.dramaId,
    episodeId,
    scopeType: 'episode',
    scopeId: episodeId,
    idempotencyKey: `grid.episode_videos:${episodeId}:${Date.now()}`,
    payload: {
      episode_id: episodeId,
      storyboard_ids: storyboardIds,
      tags: (body as any).tags,
      duration_sec: (body as any).durationSec,
      resolution: (body as any).resolution,
      mode: (body as any).mode,
      force: Boolean((body as any).force),
    },
  })
  return success(c, { task_id: task.id })
})

// GET /grid/videos/assets —— 视频素材库浏览（按标签过滤）
app.get('/videos/assets', async (c) => {
  const era = c.req.query('era')
  const rows = db.select().from(schema.videoAssets).all()
    .filter((r) => !era || String(r.era || '') === era)
    .map((r) => ({
      id: r.id,
      src: r.localPath,
      era: r.era,
      scene: r.sceneTag,
      event: r.eventTag,
      mood: r.mood,
      duration_sec: r.durationSec,
      resolution: r.resolution,
      status: r.status,
      use_count: r.useCount,
      prompt: r.prompt,
      design: r.designJson ? JSON.parse(r.designJson) : null,
      refs: r.refsJson ? JSON.parse(r.refsJson) : null,
      created_at: r.createdAt,
    }))
  return success(c, { assets: rows })
})

// GET /grid/episode/:episodeId/cells —— 查看各镜单图生产状态（兼容旧双格数据）
app.get('/episode/:episodeId/cells', async (c) => {
  const episodeId = Number(c.req.param('episodeId'))
  const rows = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber).all()
  return success(c, {
    storyboards: rows.map((sb) => {
      let cells: any = null
      try { cells = sb.gridCells ? JSON.parse(sb.gridCells) : null } catch { /* ignore */ }
      return {
        storyboard_id: sb.id,
        storyboard_number: sb.storyboardNumber,
        title: sb.title,
        grid_sheet_image: sb.gridSheetImage || null,
        cells: cells?.cells ?? null,
      }
    }),
  })
})

// GET /grid/productions —— 全部 Episode 的 grid 生产状态总览（/remotion 主页用）
app.get('/productions', async (c) => {
  const episodes = db.select().from(schema.episodes).all()
  const dramas = db.select().from(schema.dramas).all()
  const accounts = db.select().from(schema.mediaAccounts).all()
  const accountMap = new Map(accounts.map((a) => [a.id, a]))
  const dramaMap = new Map(dramas.map((d) => [d.id, d]))
  const storyboards = db.select().from(schema.storyboards).all()

  const byEpisode = new Map<number, typeof storyboards>()
  for (const sb of storyboards) {
    const list = byEpisode.get(sb.episodeId) ?? []
    list.push(sb)
    byEpisode.set(sb.episodeId, list)
  }

  const items = episodes
    .filter((ep) => (byEpisode.get(ep.id)?.length ?? 0) > 0)
    .map((ep) => {
      const shots = byEpisode.get(ep.id) ?? []
      let cellsReady = 0
      let reviewPassed = 0
      let reviewTotal = 0
      for (const sb of shots) {
        try {
          const gc = sb.gridCells ? JSON.parse(sb.gridCells) : null
          const cells = gc?.cells
          if (Array.isArray(cells) && cells.length && cells.every((cell: any) => cell?.src)) cellsReady++
          for (const cell of cells ?? []) {
            if (cell?.review) {
              reviewTotal++
              if (cell.review.pass) reviewPassed++
            }
          }
        } catch { /* ignore */ }
      }
      const renderAbs = getAbsolutePath(`remotion/grid-story-ep${ep.id}.mp4`)
      const hasRender = fs.existsSync(renderAbs)
      let renderAt: string | null = null
      if (hasRender) {
        try { renderAt = fs.statSync(renderAbs).mtime.toISOString() } catch { /* ignore */ }
      }
      let status = 'pending'
      if (hasRender) {
        status = 'done'
      } else if (cellsReady > 0 && cellsReady >= shots.length) {
        status = 'ready'
      } else if (cellsReady > 0) {
        status = 'working'
      }
      return {
        episode_id: ep.id,
        drama_id: ep.dramaId,
        drama_title: dramaMap.get(ep.dramaId)?.title ?? '',
        account_id: dramaMap.get(ep.dramaId)?.mediaAccountId ?? null,
        account_name: accountMap.get(dramaMap.get(ep.dramaId)?.mediaAccountId ?? -1)?.name ?? null,
        episode_number: ep.episodeNumber,
        title: ep.title,
        shot_count: shots.length,
        cells_ready: cellsReady,
        review_passed: reviewTotal ? reviewPassed : null,
        review_total: reviewTotal || null,
        has_render: hasRender,
        render_url: hasRender ? `/static/remotion/grid-story-ep${ep.id}.mp4` : null,
        render_at: renderAt,
        updated_at: ep.updatedAt,
        status,
      }
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))

  const queryAccountId = c.req.query('account_id')
  const queryDramaId = c.req.query('drama_id')
  const queryStatus = c.req.query('status')
  const queryQ = c.req.query('q')
  const accountIdFilter = queryAccountId ? Number(queryAccountId) : null
  const dramaIdFilter = queryDramaId ? Number(queryDramaId) : null
  const statusFilter = queryStatus || null
  const qFilter = queryQ ? String(queryQ).trim().toLowerCase() : null

  const filtered = items.filter((item) => {
    if (accountIdFilter !== null && item.account_id !== accountIdFilter) return false
    if (dramaIdFilter !== null && item.drama_id !== dramaIdFilter) return false
    if (statusFilter && item.status !== statusFilter) return false
    if (qFilter) {
      const haystack = `${item.title} ${item.drama_title} ${item.account_name ?? ''} E${String(item.episode_number).padStart(2, '0')}`.toLowerCase()
      if (!haystack.includes(qFilter)) return false
    }
    return true
  })

  const offset = Math.max(0, Number(c.req.query('offset')) || 0)
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 10))
  return success(c, { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit })
})

export default app
