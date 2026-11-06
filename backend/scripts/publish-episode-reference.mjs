import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

export class EpisodeReferenceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EpisodeReferenceError'
    this.exitCode = 2
  }
}

function positiveId(value, label) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new EpisodeReferenceError(`${label} must be a positive integer`)
  }
  return id
}

export function parseEpisodeReference(reference) {
  const raw = String(reference ?? '').trim()
  if (!raw) throw new EpisodeReferenceError('episode id or URL is required')
  if (/^\d+$/u.test(raw)) return { kind: 'episode_id', episodeId: positiveId(raw, 'episode id') }

  let pathname
  let url
  try {
    url = new URL(raw, 'http://episode-reference.local')
    pathname = url.pathname
  } catch {
    throw new EpisodeReferenceError(`invalid episode reference: ${raw}`)
  }
  pathname = pathname.replace(/\/+$/u, '') || '/'
  if (pathname === '/history-scripts') {
    return { kind: 'history_script', scriptId: positiveId(url.searchParams.get('script'), 'history script id') }
  }

  const dramaEpisode = pathname.match(/^\/drama\/(\d+)\/episode\/(\d+)$/u)
  if (dramaEpisode) {
    return {
      kind: 'drama_episode_number',
      dramaId: positiveId(dramaEpisode[1], 'drama id'),
      episodeNumber: positiveId(dramaEpisode[2], 'episode number'),
    }
  }

  const directEpisode = pathname.match(/^(?:\/dharma\/episode|\/episode|\/whiteboard\/project)\/(\d+)$/u)
  if (directEpisode) return { kind: 'episode_id', episodeId: positiveId(directEpisode[1], 'episode id') }

  throw new EpisodeReferenceError(
    `unsupported episode URL: ${raw}; use /dharma/episode/:id, /episode/:id, /whiteboard/project/:id, or /drama/:dramaId/episode/:episodeNumber`,
  )
}

/** Parse the video-producing Maoxuan project URL without making a bare id ambiguous. */
export function parseMaoxuanVideoReference(reference) {
  const raw = String(reference ?? '').trim()
  if (!raw) throw new EpisodeReferenceError('maoxuan project id or URL is required')

  let pathname
  try {
    pathname = new URL(raw, 'http://maoxuan-reference.local').pathname
  } catch {
    throw new EpisodeReferenceError(`invalid maoxuan project reference: ${raw}`)
  }
  pathname = pathname.replace(/\/+$/u, '') || '/'
  const match = pathname.match(/^\/maoxuan\/project\/(\d+)$/u)
  if (!match) {
    throw new EpisodeReferenceError(
      `unsupported maoxuan project URL: ${raw}; use /maoxuan/project/:id`,
    )
  }
  return positiveId(match[1], 'maoxuan project id')
}

export function resolveEpisodeId(reference, options = {}) {
  const parsed = parseEpisodeReference(reference)
  if (parsed.kind === 'history_script') throw new EpisodeReferenceError('history script ids are not episode ids')
  if (parsed.kind === 'episode_id') return parsed.episodeId

  const dbPath = options.dbPath || path.join(options.projectRoot || process.cwd(), 'data/huobao_drama.db')
  const db = new Database(dbPath, { readonly: true, timeout: 30_000 })
  try {
    const row = db.prepare(`
      SELECT id
      FROM episodes
      WHERE drama_id = ? AND episode_number = ? AND deleted_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(parsed.dramaId, parsed.episodeNumber)
    if (!row) {
      throw new EpisodeReferenceError(
        `episode URL did not resolve: drama ${parsed.dramaId} episode ${parsed.episodeNumber} does not exist`,
      )
    }
    return positiveId(row.id, 'resolved episode id')
  } finally {
    db.close()
  }
}

function parseMetadata(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function loadEpisodeFromDb(reference, options = {}) {
  const parsed = parseEpisodeReference(reference)
  if (parsed.kind === 'history_script') return loadHistoryDelivery(parsed.scriptId, options)
  const episodeId = resolveEpisodeId(reference, options)
  const dbPath = options.dbPath || path.join(options.projectRoot || process.cwd(), 'data/huobao_drama.db')
  const db = new Database(dbPath, { readonly: true, timeout: 30_000 })
  try {
    const episode = db.prepare('SELECT * FROM episodes WHERE id = ? AND deleted_at IS NULL').get(episodeId)
    if (!episode) throw new EpisodeReferenceError(`episode ${episodeId} does not exist`)
    const publishing = parseMetadata(episode.metadata).dharmaPublishing?.package
    const title = String(options.title || publishing?.title || episode.video_title || episode.title || `第${episode.episode_number}集`).trim()
    const openingHook = String(publishing?.opening_hook || episode.opening_hook || '').trim()
    const cliffhanger = String(publishing?.cliffhanger || episode.cliffhanger || '').trim()
    return {
      episode_id: episode.id,
      title,
      opening_hook: openingHook,
      cliffhanger,
      description: [openingHook, cliffhanger].filter(Boolean).join('\n\n'),
      video_path: episode.video_url,
      cover_3x4_src: episode.cover_image_3x4_url,
      cover_4x3_src: episode.cover_image_4x3_url,
    }
  } finally {
    db.close()
  }
}

function loadHistoryDelivery(scriptId, options) {
  const projectRoot = options.projectRoot || process.cwd()
  const db = new Database(options.dbPath || path.join(projectRoot, 'data/huobao_drama.db'), { readonly: true })
  try {
    const source = db.prepare('SELECT rewritten_script FROM history_script_sources WHERE id = ? AND deleted_at IS NULL').get(scriptId)
    if (!source) throw new EpisodeReferenceError(`history script ${scriptId} does not exist`)
    const row = db.prepare('SELECT * FROM history_script_deliveries WHERE script_id = ?').get(scriptId)
    if (!row?.video_path) throw new EpisodeReferenceError(`history script ${scriptId}: 请先在脚本页面关联成片`)
    const hash = createHash('sha256').update(String(source.rewritten_script || '')).digest('hex')
    if (!source.rewritten_script?.trim() || hash !== row.script_sha256 || hash !== row.cover_script_sha256) {
      throw new EpisodeReferenceError(`history script ${scriptId}: 脚本已变更，请重新确认成片与封面`)
    }
    const covers = parseMetadata(row.covers_json)
    if (row.cover_status !== 'completed' || ['3:4', '4:3', '16:9'].some(ratio => !covers[ratio])) {
      throw new EpisodeReferenceError(`history script ${scriptId}: 请先在脚本页面完成三比例封面`)
    }
    for (const file of [row.video_path, ...Object.values(covers)]) {
      const root = path.resolve(projectRoot, 'data')
      const absolute = path.resolve(root, file)
      if (!String(file).startsWith('static/') || !absolute.startsWith(root + path.sep)
        || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || !fs.statSync(absolute).size) {
        throw new EpisodeReferenceError(`history script ${scriptId}: 素材文件不存在或路径无效: ${file}`)
      }
    }
    return {
      source_type: 'history_script', history_source_id: scriptId, script_sha256: hash,
      title: String(options.title || row.title || '').trim(), description: String(row.description || '').trim(),
      baijiahao_title: String(row.baijiahao_title || row.title || '').trim(),
      opening_hook: '', cliffhanger: '', video_path: row.video_path,
      cover_3x4_src: covers['3:4'], cover_4x3_src: covers['4:3'], cover_16x9_src: covers['16:9'],
    }
  } finally { db.close() }
}

/** Load a rendered Maoxuan project video for the Douyin video publisher. */
export function loadMaoxuanVideoFromDb(reference, options = {}) {
  const projectId = parseMaoxuanVideoReference(reference)
  const dbPath = options.dbPath || path.join(options.projectRoot || process.cwd(), 'data/huobao_drama.db')
  const db = new Database(dbPath, { readonly: true, timeout: 30_000 })
  try {
    const drama = db.prepare(`
      SELECT id, title, video_title, workflow_type, metadata
      FROM dramas
      WHERE id = ? AND deleted_at IS NULL
    `).get(projectId)
    if (!drama) throw new EpisodeReferenceError(`maoxuan project ${projectId} does not exist`)
    if (drama.workflow_type !== 'maoxuan') {
      throw new EpisodeReferenceError(
        `project ${projectId} is not a maoxuan project (workflow_type=${drama.workflow_type})`,
      )
    }

    const metadata = parseMetadata(drama.metadata)
    const panels = Array.isArray(metadata.panels) ? metadata.panels : []
    const video = db.prepare(`
      SELECT local_path, url
      FROM assets
      WHERE drama_id = ?
        AND category = 'maoxuan_episode_video'
        AND type = 'video'
        AND deleted_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(projectId)
    const cover = db.prepare(`
      SELECT local_path
      FROM image_generations
      WHERE drama_id = ?
        AND image_type = 'maoxuan_panel'
        AND frame_type = 'panel_01'
        AND status = 'completed'
        AND local_path IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(projectId)

    if (!video?.local_path && !video?.url) {
      throw new EpisodeReferenceError(`maoxuan project ${projectId} has no rendered video asset`)
    }
    if (!cover?.local_path) {
      throw new EpisodeReferenceError(`maoxuan project ${projectId} has no completed panel_01 cover`)
    }

    const firstPanelTitle = String(panels[0]?.text || '').replace(/\s+/g, '')
    const title = String(options.title || drama.video_title || firstPanelTitle || drama.title || '').trim()
    const description = [metadata.question, metadata.analysis, '#毛选 #顶级思维']
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('\n')
    if (!title) throw new EpisodeReferenceError(`maoxuan project ${projectId} has no publish title`)
    if (!description) throw new EpisodeReferenceError(`maoxuan project ${projectId} has no publish description`)

    return {
      source_type: 'maoxuan_video',
      project_id: projectId,
      title,
      opening_hook: '',
      cliffhanger: '',
      description,
      video_path: video.local_path || video.url,
      // The same title-bearing panel is normalized to both Douyin cover ratios by prepare.mjs.
      cover_3x4_src: cover.local_path,
      cover_4x3_src: cover.local_path,
    }
  } finally {
    db.close()
  }
}
