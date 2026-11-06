import { Hono, type Context } from 'hono'
import { ZodError } from 'zod'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import {
  deleteHistorySource,
  getHistorySource,
  getHistorySourceArtifactState,
  getHistorySourceWorkflowState,
  listHistorySources,
  requireCurrentHistoryScript,
  updateHistorySource,
  type HistorySource,
  type HistoryLibraryCategory,
  type HistoryWorkflowState,
  type ListHistorySourcesOptions,
} from '../services/history-script-library.js'
import { badRequest, notFound, success } from '../utils/response.js'
import { acquireHistorySourceLock, HISTORY_SCRIPT_STORAGE_ROOT } from '../services/history-source-pipeline.js'
import { estimateHistoryScriptTiming } from '../services/history-script-processing.js'
import { runImmediateTransaction } from '../db/index.js'
import { createHistorySourceJobsRoute } from './history-source-jobs.js'
import { createHistorySourceSettingsRoute, createCzgtsSettingsRoute } from './history-source-settings.js'
import { createHistoryDeliveryRoute } from './history-script-delivery.js'
import { createHistoryArticleRoute } from './history-script-article.js'
import { createHistoryBrowserSessionRoute, type HistoryBrowserSessionRouteDependencies } from './history-browser-session.js'
import { createHistoryHuashengRoute, type HistoryHuashengRouteOptions } from './history-huasheng.js'
import { createHistoryHuashengExportRoute, type HistoryHuashengExportRouteOptions } from './history-huasheng-export.js'
import { createHistorySocialUploadRoute } from './history-social-upload.js'
import { createHistoryMotionRoute, type HistoryMotionRouteOptions } from './history-motion.js'
import { createHistoryProductionContinuationRoute } from './history-production-continuation.js'

const editableScriptSchema = z.string()
  .refine(value => value.trim().length > 0)

const rewriteUpdateSchema = z.object({
  rewrittenScript: editableScriptSchema,
  expectedUpdatedAt: z.string().min(1),
}).strict()

const draftUpdateSchema = z.object({
  rewrittenScript: editableScriptSchema,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

const deleteScriptSchema = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

interface RouteOptions {
  storageRoot?: string
  browserSessionDependencies?: Partial<HistoryBrowserSessionRouteDependencies>
  huasheng?: HistoryHuashengRouteOptions
  huashengExport?: HistoryHuashengExportRouteOptions
  motion?: HistoryMotionRouteOptions
}

function numberId(value: string) {
  if (!/^\d+$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function scriptRevision(source: HistorySource) {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

function sanitizePaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePaths)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/path$/i.test(key))
    .map(([key, entry]) => [key, sanitizePaths(entry)]))
}

function safeVideoPath(id: number, mediaJson: string, storageRoot: string) {
  const root = path.resolve(storageRoot)
  const expected = path.join(root, String(id), 'source.mp4')
  try {
    const media = JSON.parse(mediaJson)
    if (media?.videoPath !== expected) return null
    const realRoot = fs.realpathSync(root)
    const realPath = fs.realpathSync(expected)
    if (realPath !== path.join(realRoot, String(id), 'source.mp4')) return null
    return realPath
  } catch { return null }
}

function videoIsAvailable(source: HistorySource, storageRoot: string) {
  const filePath = safeVideoPath(source.id, source.mediaJson, storageRoot)
  if (!filePath || !fs.existsSync(filePath)) return false
  const info = fs.statSync(filePath)
  return info.isFile() && info.size > 0
}

function safeNoteImagePath(source: HistorySource, index: number, storageRoot: string) {
  try {
    const media = JSON.parse(source.mediaJson)
    const image = media.kind === 'note' && Array.isArray(media.images) ? media.images[index] : null
    if (!image || typeof image.path !== 'string') return null
    const filename = path.basename(image.path)
    if (!/^note-\d+\.(?:jpe?g|png|webp|avif|heic)$/.test(filename)) return null
    const expected = path.join(path.resolve(storageRoot), String(source.id), filename)
    if (image.path !== expected) return null
    const actual = fs.realpathSync(expected)
    if (actual !== path.join(fs.realpathSync(storageRoot), String(source.id), filename)) return null
    return fs.statSync(actual).isFile() ? actual : null
  } catch { return null }
}

function withUiState(record: HistorySource & { workflowState?: HistoryWorkflowState }, storageRoot: string) {
  // Production state changes must not invalidate the editable script revision.
  const { workflowState, ...source } = record
  const media = parseJsonObject(source.mediaJson)
  if (media.kind === 'note' && Array.isArray(media.images)) {
    media.images = media.images.map((image, index) => ({ ...image, url: `/api/v1/history-scripts/${source.id}/images/${index}` }))
  }
  return {
    ...source,
    mediaJson: JSON.stringify(sanitizePaths(media)),
    artifactState: getHistorySourceArtifactState(source),
    workflowState: workflowState ?? getHistorySourceWorkflowState(source.id),
    revision: scriptRevision(source),
    videoAvailable: videoIsAvailable(source, storageRoot),
    videoUrl: `/api/v1/history-scripts/${source.id}/video`,
  }
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseRange(value: string | undefined, size: number) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match) return { invalid: true as const }
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return { invalid: true as const }
  let start: number
  let end: number
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true as const }
    start = Math.max(size - suffix, 0)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return { invalid: true as const }
  }
  return { start, end: Math.min(end, size - 1) }
}

export function createHistoryScriptsRoute(options: RouteOptions = {}) {
  const app = new Hono()
  const storageRoot = options.storageRoot ?? HISTORY_SCRIPT_STORAGE_ROOT
  app.route('/', createHistoryProductionContinuationRoute())
  app.route('/', createHistoryHuashengRoute(options.huasheng))
  app.route('/', createHistoryHuashengExportRoute(options.huashengExport))
  app.route('/motion', createHistoryMotionRoute(options.motion))
  app.route('/collection-settings', createHistorySourceSettingsRoute())
  app.route('/czgts', createCzgtsSettingsRoute())
  app.route('/jobs', createHistorySourceJobsRoute())
  app.route('/browser-session', createHistoryBrowserSessionRoute(options.browserSessionDependencies))
  app.route('/uploads', createHistorySocialUploadRoute())
  app.route('/:id/delivery', createHistoryDeliveryRoute())
  app.route('/:id/article', createHistoryArticleRoute())

  app.get('/', (c) => {
  try {
    const page = listHistorySources({
      category: c.req.query('category') as HistoryLibraryCategory | undefined,
      status: c.req.query('status'),
      q: c.req.query('q'),
      video: c.req.query('video') as ListHistorySourcesOptions['video'],
      titlePlan: c.req.query('titlePlan') as ListHistorySourcesOptions['titlePlan'],
      cover: c.req.query('cover') as ListHistorySourcesOptions['cover'],
      motion: c.req.query('motion') as ListHistorySourcesOptions['motion'],
      upload: c.req.query('upload') as ListHistorySourcesOptions['upload'],
      limit: c.req.query('limit') !== undefined ? Number(c.req.query('limit')) : undefined,
      offset: c.req.query('offset') !== undefined ? Number(c.req.query('offset')) : undefined,
    })
    return success(c, { ...page, items: page.items.map(source => withUiState(source, storageRoot)) })
  } catch (error) {
    if (error instanceof ZodError) return badRequest(c, 'Invalid history script filters or pagination')
    throw error
  }
})

  app.get('/:id/export', (c) => {
  const id = numberId(c.req.param('id'))
  if (!id) return badRequest(c, 'Invalid history source id')
  const source = getHistorySource(id)
  if (!source) return notFound(c, 'History script not found')
  let script: string
  try { script = requireCurrentHistoryScript(source) } catch (error) {
    return c.json({ code: 409, message: (error as Error).message }, 409)
  }
  const markdown = [
    '---',
    `title: ${JSON.stringify(source.title)}`,
    `source_url: ${JSON.stringify(source.sourceUrl)}`,
    'status: needs_review',
    '---',
    '',
    script,
    '',
  ].join('\n')
  c.header('Content-Type', 'text/markdown; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="history-script-${source.id}.md"`)
  return c.body(markdown)
})

  async function saveRewrite(c: Context, legacy = false) {
  const id = numberId(c.req.param('id') ?? '')
  if (!id) return badRequest(c, 'Invalid history source id')
  let body: z.infer<typeof draftUpdateSchema> | z.infer<typeof rewriteUpdateSchema>
  try {
    body = (legacy ? rewriteUpdateSchema : draftUpdateSchema).parse(await c.req.json())
  } catch (error) {
    if (error instanceof ZodError) return badRequest(c, 'Invalid rewritten script update')
    return badRequest(c, 'Invalid JSON body')
  }
  if (!getHistorySource(id)) return notFound(c, 'History script not found')

  let release: (() => Promise<void>) | null = null
  try {
    release = await acquireHistorySourceLock(id, storageRoot)
    return runImmediateTransaction(() => {
    const source = getHistorySource(id)
    if (!source) return notFound(c, 'History script not found')
    if (['downloading', 'transcribing', 'correcting', 'rewriting'].includes(source.status)) {
      return c.json({ code: 409, message: '此脚本正在处理，暂时无法保存。你的修改仍保留。' }, 409)
    }
    const matches = 'expectedRevision' in body ? scriptRevision(source) === body.expectedRevision : source.updatedAt === body.expectedUpdatedAt
    if (!matches) {
      return c.json({
        code: 409,
        message: '此脚本已在其他窗口或流程中更新。你的修改仍保留，请读取最新稿后再合并。',
        data: withUiState(source, storageRoot),
      }, 409)
    }

    const review = parseJsonObject(source.reviewJson)
    const rewrittenScriptSha256 = createHash('sha256').update(body.rewrittenScript).digest('hex')
    const updated = updateHistorySource(id, {
      rewrittenScript: body.rewrittenScript,
      status: 'needs_review',
      reviewJson: JSON.stringify({
        ...review,
        factCheckStatus: typeof review.factCheckStatus === 'string' ? review.factCheckStatus : 'needs_sources',
        scriptTiming: estimateHistoryScriptTiming(body.rewrittenScript),
        manualEdit: {
          editedAt: new Date().toISOString(),
          previousRevision: scriptRevision(source),
          rewrittenScriptSha256,
          note: 'Rewritten script edited from history scripts UI; factual concerns remain open.',
        },
      }),
    })
    return updated ? success(c, withUiState(updated, storageRoot)) : notFound(c, 'History script not found')
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('is locked')) return c.json({ code: 409, message: '此脚本正由另一个任务处理。你的修改仍保留，请稍后重试。' }, 409)
    throw error
  } finally {
    if (release) await release()
  }
  }

  app.put('/:id/rewrite', c => saveRewrite(c, true))
  app.patch('/:id', c => saveRewrite(c))

  app.delete('/:id', async (c) => {
    const id = numberId(c.req.param('id'))
    if (!id) return badRequest(c, 'Invalid history source id')
    let body: z.infer<typeof deleteScriptSchema>
    try {
      body = deleteScriptSchema.parse(await c.req.json())
    } catch (error) {
      return badRequest(c, error instanceof ZodError ? 'Invalid history script deletion' : 'Invalid JSON body')
    }
    if (!getHistorySource(id)) return notFound(c, 'History script not found')
    let release: (() => Promise<void>) | null = null
    try {
      release = await acquireHistorySourceLock(id, storageRoot)
      return runImmediateTransaction(() => {
        const source = getHistorySource(id)
        if (!source) return notFound(c, 'History script not found')
        if (['downloading', 'transcribing', 'correcting', 'rewriting'].includes(source.status)) {
          return c.json({ code: 409, message: '此脚本正在处理，暂时无法删除，请等待处理完成或停止采集后重试。' }, 409)
        }
        if (scriptRevision(source) !== body.expectedRevision) {
          return c.json({ code: 409, message: '此脚本已在其他窗口或流程中更新，请刷新并确认最新内容后再删除。' }, 409)
        }
        return deleteHistorySource(id) ? success(c, { id }) : notFound(c, 'History script not found')
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('is locked')) {
        return c.json({ code: 409, message: '此脚本正由另一个任务处理，暂时无法删除，请稍后重试。' }, 409)
      }
      throw error
    } finally {
      if (release) await release()
    }
  })

  app.on(['GET', 'HEAD'], '/:id/video', (c) => {
  const id = numberId(c.req.param('id'))
  if (!id) return badRequest(c, 'Invalid history source id')
  const source = getHistorySource(id)
  if (!source) return notFound(c, 'History script not found')
  const filePath = safeVideoPath(id, source.mediaJson, storageRoot)
  if (!filePath || !fs.existsSync(filePath)) return notFound(c, 'History source video not found')
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size <= 0) return notFound(c, 'History source video not found')
  const range = parseRange(c.req.header('range'), stat.size)
  if (range?.invalid) {
    return c.newResponse('Range Not Satisfiable', 416, {
      'Content-Range': `bytes */${stat.size}`,
      'Accept-Ranges': 'bytes',
    })
  }
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="history-source-${id}.mp4"`,
    'Cache-Control': 'private, no-cache',
  }
  if (range) {
    if (c.req.method === 'HEAD') {
      return c.body(null, 206, {
        ...headers,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      })
    }
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end })
    return c.newResponse(Readable.toWeb(stream) as ReadableStream, 206, {
      ...headers,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
    })
  }
  if (c.req.method === 'HEAD') {
    return c.body(null, 200, {
      ...headers,
      'Content-Length': String(stat.size),
    })
  }
  const stream = fs.createReadStream(filePath)
  return c.newResponse(Readable.toWeb(stream) as ReadableStream, 200, {
    ...headers,
    'Content-Length': String(stat.size),
  })
})

  app.on(['GET', 'HEAD'], '/:id/images/:index', c => {
    const id = numberId(c.req.param('id'))
    const index = /^\d+$/.test(c.req.param('index')) ? Number(c.req.param('index')) : -1
    if (!id || !Number.isSafeInteger(index) || index < 0) return badRequest(c, 'Invalid history source image')
    const source = getHistorySource(id)
    if (!source) return notFound(c, 'History script not found')
    const filename = safeNoteImagePath(source, index, storageRoot)
    if (!filename) return notFound(c, 'History source image not found')
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
      '.avif': 'image/avif', '.heic': 'image/heic' }[path.extname(filename)] || 'application/octet-stream'
    const headers = { 'Content-Type': mime, 'Content-Length': String(fs.statSync(filename).size),
      'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' }
    if (c.req.method === 'HEAD') return c.body(null, 200, headers)
    return c.newResponse(Readable.toWeb(fs.createReadStream(filename)) as ReadableStream, 200, headers)
  })

  app.get('/:id', (c) => {
  const id = numberId(c.req.param('id'))
  if (!id) return badRequest(c, 'Invalid history source id')
  const source = getHistorySource(id, { includeDeleted: true })
  if (source?.deletedAt) {
    return c.json({
      code: 404,
      message: `稿件 #${id} 已删除，请从稿件列表选择其他稿件。`,
      data: { reason: 'deleted', id, title: source.title, deletedAt: source.deletedAt },
    }, 404)
  }
  return source ? success(c, withUiState(source, storageRoot)) : notFound(c, `稿件 #${id} 不存在，请检查链接或从稿件列表选择其他稿件。`)
})

  return app
}

export default createHistoryScriptsRoute()
