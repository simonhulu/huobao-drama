import { Hono } from 'hono'
import { badRequest, notFound, serverError, success } from '../utils/response.js'
import { deleteMusicAsset, refreshMusicLibrary, loadMusicLibrary, findMusicEntry } from '../services/music-library.js'
import { deleteSfxAsset, getSfxLibraryStats, loadMapping, findSfxEntryByAbsolutePath, getSfxUrl, type SfxMapping } from '../services/sfx-library.js'

const app = new Hono()

async function readPathParam(c: any): Promise<string> {
  const queryPath = c.req.query('path')
  if (queryPath) return queryPath
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  return String(body.path || '')
}

/**
 * GET /api/v1/library/music
 *
 * 返回本地 BGM 素材库列表，包含 MiniMax 生成和本地已有的音乐文件元数据。
 */
app.get('/music', async (c) => {
  const lib = await refreshMusicLibrary()
  const items = lib.entries.map(e => ({
    filename: e.filename,
    url: `/${e.url}`,
    duration: e.duration,
    prompt: e.prompt || null,
    emotion_bucket: e.emotionBucket || null,
    intensity: e.intensity || null,
    tags: e.tags || [],
    episode_id: e.episodeId || null,
    source: e.source,
    created_at: e.createdAt,
  }))
  return success(c, {
    total: items.length,
    generated_at: lib.generatedAt,
    items,
  })
})

/**
 * GET /api/v1/library/sfx
 *
 * 返回本地 SFX 音效库列表（来自 sfx-mapping.json）。
 */
app.get('/sfx', (c) => {
  const mapping = loadMapping()
  const stats = getSfxLibraryStats()
  const items = (mapping?.entries || []).map((e: SfxMapping['entries'][number]) => ({
    path: e.relativePath,
    url: `/sfx/${e.relativePath}`,
    pack: e.pack,
    keywords: e.keywords,
  }))
  return success(c, {
    total: items.length,
    mapping_exists: stats.mappingExists,
    generated_at: mapping?.generatedAt || null,
    items,
  })
})

/**
 * GET /api/v1/library/music/lookup?path=static/music/...
 *
 * 根据 BGM 的 relativePath 查询素材库索引详情。
 */
app.get('/music/lookup', (c) => {
  const path = c.req.query('path') || ''
  const entry = findMusicEntry(path)
  if (!entry) {
    return success(c, null)
  }
  return success(c, {
    filename: entry.filename,
    url: `/${entry.url}`,
    duration: entry.duration,
    prompt: entry.prompt || null,
    emotion_bucket: entry.emotionBucket || null,
    intensity: entry.intensity || null,
    tags: entry.tags || [],
    source: entry.source,
    created_at: entry.createdAt,
  })
})

/**
 * DELETE /api/v1/library/music?path=static/music/...
 *
 * 删除一个 BGM 实体文件，并刷新 music library 索引。
 */
app.delete('/music', async (c) => {
  const path = await readPathParam(c)
  if (!path) return badRequest(c, 'path is required')

  try {
    const result = await deleteMusicAsset(path)
    return success(c, {
      deleted: result.deleted,
      relative_path: result.relativePath,
      total: result.total,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除 BGM 失败'
    if (/invalid/i.test(message)) return badRequest(c, message)
    if (/not found/i.test(message)) return notFound(c, message)
    return serverError(c, message)
  }
})

/**
 * GET /api/v1/library/sfx/lookup?path=sfx/library/...
 *
 * 根据 SFX 的 relativePath 查询素材库索引详情。
 */
app.get('/sfx/lookup', (c) => {
  const path = c.req.query('path') || ''
  const absolutePath = path.startsWith('sfx/')
    ? path.replace('sfx/', '')
    : path
  const entry = findSfxEntryByAbsolutePath(absolutePath)
  if (!entry) {
    return success(c, null)
  }
  return success(c, {
    path: entry.relativePath,
    url: `/${getSfxUrl(entry.relativePath)}`,
    pack: entry.pack,
    keywords: entry.keywords,
  })
})

/**
 * DELETE /api/v1/library/sfx?path=library/...
 *
 * 删除一个 SFX 实体文件，并重建 sfx-mapping.json。
 */
app.delete('/sfx', async (c) => {
  const path = await readPathParam(c)
  if (!path) return badRequest(c, 'path is required')

  try {
    const result = deleteSfxAsset(path)
    return success(c, {
      deleted: result.deleted,
      relative_path: result.relativePath,
      total: result.total,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '删除音效失败'
    if (/invalid/i.test(message)) return badRequest(c, message)
    if (/not found/i.test(message)) return notFound(c, message)
    return serverError(c, message)
  }
})

/**
 * POST /api/v1/library/refresh
 *
 * 强制重新扫描 static/music 并补全 duration，返回最新列表。
 */
app.post('/refresh', async (c) => {
  const lib = await refreshMusicLibrary()
  return success(c, {
    total: lib.entries.length,
    generated_at: lib.generatedAt,
  })
})

export default app
