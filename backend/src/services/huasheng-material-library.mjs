import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_MATERIAL_DATABASE_PATH = fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url))

const encode = value => JSON.stringify(value ?? {})
const decode = value => JSON.parse(value)
const number = value => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null
const relative = (root, filename) => path.relative(path.resolve(root), filename).split(path.sep).join('/')

export class HuashengMaterialLibrary {
  constructor({ databasePath, database } = {}) {
    const filename = databasePath || process.env.DB_PATH || DEFAULT_MATERIAL_DATABASE_PATH
    this.databasePath = database?.name || (filename === ':memory:' ? filename : path.resolve(filename))
    this.ownsDatabase = !database
    if (!database && filename !== ':memory:') fs.mkdirSync(path.dirname(this.databasePath), { recursive: true })
    this.db = database || new Database(this.databasePath, { timeout: 30000 })
    try {
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('busy_timeout = 30000')
      this.db.pragma('foreign_keys = ON')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS huasheng_material_projects (
          project_id TEXT PRIMARY KEY, title TEXT NOT NULL, project_url TEXT NOT NULL,
          total_clips INTEGER NOT NULL CHECK(total_clips >= 0), top_count INTEGER NOT NULL CHECK(top_count > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS huasheng_material_clips (
          project_id TEXT NOT NULL REFERENCES huasheng_material_projects(project_id), clip_id TEXT NOT NULL,
          order_index INTEGER NOT NULL CHECK(order_index > 0), text TEXT NOT NULL, query TEXT NOT NULL DEFAULT '',
          query_source TEXT NOT NULL DEFAULT '', selected_asset_id TEXT NOT NULL DEFAULT '', selected_caption TEXT NOT NULL DEFAULT '',
          recommendation_total INTEGER NOT NULL CHECK(recommendation_total >= 0), captured_at TEXT,
          status TEXT NOT NULL, error TEXT, metadata_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id, clip_id)
        );
        CREATE TABLE IF NOT EXISTS huasheng_material_assets (
          asset_id TEXT PRIMARY KEY, source_url TEXT, cover TEXT, caption TEXT NOT NULL DEFAULT '',
          duration REAL, width INTEGER, height INTEGER, fps REAL, material_type INTEGER,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS huasheng_material_files (
          file_path TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES huasheng_material_assets(asset_id),
          project_id TEXT NOT NULL REFERENCES huasheng_material_projects(project_id), clip_id TEXT NOT NULL,
          bytes INTEGER NOT NULL CHECK(bytes > 0), sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
          duration REAL, width INTEGER, height INTEGER, codec TEXT, downloaded_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(file_path, asset_id),
          FOREIGN KEY(project_id, clip_id) REFERENCES huasheng_material_clips(project_id, clip_id)
        );
        CREATE TABLE IF NOT EXISTS huasheng_material_recommendations (
          project_id TEXT NOT NULL, clip_id TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES huasheng_material_assets(asset_id),
          rank INTEGER NOT NULL CHECK(rank > 0), metadata_json TEXT NOT NULL,
          download_status TEXT CHECK(download_status IS NULL OR download_status IN ('pending','done','failed','unavailable')),
          target_path TEXT, file_path TEXT, error TEXT, reused INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(project_id, clip_id, asset_id), UNIQUE(project_id, clip_id, rank),
          FOREIGN KEY(project_id, clip_id) REFERENCES huasheng_material_clips(project_id, clip_id),
          FOREIGN KEY(file_path, asset_id) REFERENCES huasheng_material_files(file_path, asset_id),
          CHECK(download_status IS NOT 'done' OR file_path IS NOT NULL)
        );
        CREATE INDEX IF NOT EXISTS huasheng_material_clips_order ON huasheng_material_clips(project_id, order_index);
        CREATE INDEX IF NOT EXISTS huasheng_material_files_asset ON huasheng_material_files(asset_id);
        CREATE INDEX IF NOT EXISTS huasheng_material_files_project ON huasheng_material_files(project_id);
        CREATE INDEX IF NOT EXISTS huasheng_material_recommendations_asset ON huasheng_material_recommendations(asset_id);
        CREATE INDEX IF NOT EXISTS huasheng_material_recommendations_status ON huasheng_material_recommendations(download_status, project_id);
      `)
    } catch (error) {
      if (this.ownsDatabase) this.db.close()
      throw error
    }
  }

  close() { if (this.ownsDatabase && this.db.open) this.db.close() }

  saveProject(manifest) {
    const projectId = String(manifest.projectId || '')
    if (!projectId) throw new Error('Project ID is required')
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO huasheng_material_projects
      (project_id,title,project_url,total_clips,top_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET title=excluded.title,project_url=excluded.project_url,
        total_clips=excluded.total_clips,top_count=excluded.top_count,updated_at=excluded.updated_at`)
      .run(projectId, String(manifest.title || ''), String(manifest.projectUrl || ''), manifest.totalClips ?? 0, manifest.top ?? 3, now, now)
  }

  saveClip(projectId, record, outputRoot) {
    projectId = String(projectId)
    const clipId = String(record.clipId || '')
    if (!clipId || record.projectId !== undefined && String(record.projectId) !== projectId) throw new Error('Clip project ID does not match')
    if (!Array.isArray(record.candidates)) throw new Error('Clip candidates must be an array')
    const now = new Date().toISOString()
    const save = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO huasheng_material_clips
        (project_id,clip_id,order_index,text,query,query_source,selected_asset_id,selected_caption,recommendation_total,
          captured_at,status,error,metadata_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id,clip_id) DO UPDATE SET order_index=excluded.order_index,text=excluded.text,query=excluded.query,
          query_source=excluded.query_source,selected_asset_id=excluded.selected_asset_id,selected_caption=excluded.selected_caption,
          recommendation_total=excluded.recommendation_total,captured_at=excluded.captured_at,status=excluded.status,
          error=excluded.error,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
        .run(projectId, clipId, record.order, String(record.text || ''), String(record.query || ''), String(record.querySource || ''),
          String(record.selectedAssetId || ''), String(record.selectedCaption || ''), record.total ?? record.candidates.length,
          record.capturedAt ?? null, record.status || 'pending', record.error ?? null, encode(record.metadata), now)
      this.db.prepare('DELETE FROM huasheng_material_recommendations WHERE project_id=? AND clip_id=?').run(projectId, clipId)
      const saveAsset = this.db.prepare(`INSERT INTO huasheng_material_assets
        (asset_id,source_url,cover,caption,duration,width,height,fps,material_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(asset_id) DO UPDATE SET source_url=COALESCE(excluded.source_url,source_url),cover=COALESCE(excluded.cover,cover),
          caption=CASE WHEN excluded.caption<>'' THEN excluded.caption ELSE caption END,
          duration=COALESCE(excluded.duration,duration),width=COALESCE(excluded.width,width),height=COALESCE(excluded.height,height),
          fps=COALESCE(excluded.fps,fps),material_type=COALESCE(excluded.material_type,material_type),updated_at=excluded.updated_at`)
      const existingFile = this.db.prepare('SELECT asset_id FROM huasheng_material_files WHERE file_path=?')
      const saveFile = this.db.prepare(`INSERT INTO huasheng_material_files
        (file_path,asset_id,project_id,clip_id,bytes,sha256,duration,width,height,codec,downloaded_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(file_path) DO UPDATE SET bytes=excluded.bytes,sha256=excluded.sha256,duration=excluded.duration,
          width=excluded.width,height=excluded.height,codec=excluded.codec,updated_at=excluded.updated_at`)
      const saveRecommendation = this.db.prepare(`INSERT INTO huasheng_material_recommendations
        (project_id,clip_id,asset_id,rank,metadata_json,download_status,target_path,file_path,error,reused) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      for (const candidate of record.candidates) {
        const assetId = String(candidate.id || '')
        if (!assetId) throw new Error('Candidate asset ID is required')
        const { rank, download, ...metadata } = candidate
        const caption = candidate.caption || (assetId === String(record.selectedAssetId) ? record.selectedCaption : '') || ''
        saveAsset.run(assetId, candidate.url || null, candidate.cover || null, caption, number(candidate.duration),
          number(candidate.width), number(candidate.height), number(candidate.fps), number(candidate.material_type), now, now)
        const targetPath = download?.localPath ? path.resolve(outputRoot, download.localPath) : null
        let filePath = null
        if (download?.status === 'done') {
          if (!targetPath || !Number.isSafeInteger(download.bytes) || download.bytes < 1 || !/^[a-f0-9]{64}$/i.test(download.sha256 || '')) {
            throw new Error('Completed download requires a file path, byte count and SHA-256')
          }
          const existing = existingFile.get(targetPath)
          if (existing && existing.asset_id !== assetId) throw new Error('Local file already belongs to another asset')
          const media = download.media || {}
          saveFile.run(targetPath, assetId, projectId, clipId, download.bytes, download.sha256, number(media.duration), number(media.width),
            number(media.height), media.codec || null, now, now)
          filePath = targetPath
        }
        saveRecommendation.run(projectId, clipId, assetId, rank, encode(metadata), download?.status ?? null,
          targetPath, filePath, download?.error ?? null, Number(Boolean(download?.reused)))
      }
    })
    save.immediate()
  }

  getClip(projectId, clipId, outputRoot) {
    const row = this.db.prepare('SELECT * FROM huasheng_material_clips WHERE project_id=? AND clip_id=?').get(String(projectId), String(clipId))
    if (!row) return null
    const candidates = this.db.prepare(`SELECT r.*,f.bytes,f.sha256,f.duration AS file_duration,f.width AS file_width,
        f.height AS file_height,f.codec
      FROM huasheng_material_recommendations r LEFT JOIN huasheng_material_files f ON f.file_path=r.file_path
      WHERE r.project_id=? AND r.clip_id=? ORDER BY r.rank`).all(String(projectId), String(clipId))
    const record = {
      projectId: row.project_id, clipId: row.clip_id, order: row.order_index, text: row.text, query: row.query,
      querySource: row.query_source, selectedAssetId: row.selected_asset_id, selectedCaption: row.selected_caption,
      total: row.recommendation_total, status: row.status, metadata: decode(row.metadata_json),
      candidates: candidates.map(candidate => {
        const result = { ...decode(candidate.metadata_json), rank: candidate.rank }
        if (candidate.download_status !== null) {
          result.download = { status: candidate.download_status }
          if (candidate.target_path) result.download.localPath = relative(outputRoot, candidate.target_path)
          if (candidate.download_status === 'done') Object.assign(result.download, this.fileDownload(candidate))
          if (candidate.error !== null) result.download.error = candidate.error
        }
        return result
      }),
    }
    if (row.captured_at !== null) record.capturedAt = row.captured_at
    if (row.error !== null) record.error = row.error
    return record
  }

  fileDownload(row) {
    const media = {}
    for (const [key, value] of Object.entries({ duration: row.file_duration, width: row.file_width, height: row.file_height, codec: row.codec })) {
      if (value !== null) media[key] = value
    }
    return { bytes: row.bytes, sha256: row.sha256, media, reused: Boolean(row.reused) }
  }

  findFiles(assetId) {
    return this.db.prepare(`SELECT file_path,bytes,sha256,duration AS file_duration,width AS file_width,
        height AS file_height,codec
      FROM huasheng_material_files WHERE asset_id=? ORDER BY file_path`).all(String(assetId)).map(row => {
      const { bytes, sha256, media } = this.fileDownload(row)
      return { filePath: row.file_path, bytes, sha256, media }
    })
  }

  relocateRoot(sourceRoot, targetRoot) {
    if (typeof sourceRoot !== 'string' || !sourceRoot.trim() || typeof targetRoot !== 'string' || !targetRoot.trim()) {
      throw new Error('Source and target roots are required')
    }
    const source = path.resolve(sourceRoot)
    const target = path.resolve(targetRoot)
    if (source === target) return 0
    const relocate = filename => {
      if (filename === null) return null
      const suffix = path.relative(source, filename)
      if (suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) return filename
      return path.resolve(target, suffix)
    }
    return this.db.transaction(() => {
      // File keys and their composite foreign-key references change together.
      this.db.pragma('defer_foreign_keys = ON')
      const files = this.db.prepare('SELECT file_path FROM huasheng_material_files').all()
        .map(row => ({ before: row.file_path, after: relocate(row.file_path) }))
        .filter(row => row.before !== row.after)
      const existing = this.db.prepare('SELECT 1 FROM huasheng_material_files WHERE file_path=?')
      for (const file of files) {
        if (existing.get(file.after)) throw new Error('Relocation target already belongs to a registered file')
      }
      const updateFile = this.db.prepare('UPDATE huasheng_material_files SET file_path=? WHERE file_path=?')
      for (const file of files) updateFile.run(file.after, file.before)
      const recommendations = this.db.prepare(`SELECT project_id,clip_id,asset_id,file_path,target_path
        FROM huasheng_material_recommendations WHERE file_path IS NOT NULL OR target_path IS NOT NULL`).all()
      const updateRecommendation = this.db.prepare(`UPDATE huasheng_material_recommendations SET file_path=?,target_path=?
        WHERE project_id=? AND clip_id=? AND asset_id=?`)
      for (const row of recommendations) {
        const filePath = relocate(row.file_path)
        const targetPath = relocate(row.target_path)
        if (filePath !== row.file_path || targetPath !== row.target_path) {
          updateRecommendation.run(filePath, targetPath, row.project_id, row.clip_id, row.asset_id)
        }
      }
      for (const table of ['projects', 'clips', 'assets', 'files', 'recommendations']) {
        if (this.db.pragma(`foreign_key_check(huasheng_material_${table})`).length) {
          throw new Error('Relocation would leave invalid material foreign keys')
        }
      }
      return files.length
    }).immediate()
  }

  search({ projectId, clipId, query, downloadedOnly = true, topOnly = false, limit = 100, offset = 0,
    distinctAssets = false, excludeAssetIds = [], excludeSha256 = [] } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid pagination')
    if (![excludeAssetIds, excludeSha256].every(values => Array.isArray(values) && values.length <= 5000
      && values.every(value => typeof value === 'string' && value.length > 0 && value.length <= 200))) throw new Error('Invalid excluded material identities')
    const where = []
    const params = []
    const scoreParams = []
    let relevance = '0'
    if (projectId !== undefined) { where.push('r.project_id=?'); params.push(String(projectId)) }
    if (clipId !== undefined) { where.push('r.clip_id=?'); params.push(String(clipId)) }
    if (downloadedOnly) where.push("r.download_status='done'")
    if (topOnly) where.push('r.rank<=p.top_count')
    if (excludeAssetIds.length) {
      where.push(`r.asset_id NOT IN (${excludeAssetIds.map(() => '?').join(',')})`)
      params.push(...excludeAssetIds)
    }
    if (excludeSha256.length) {
      where.push(`(f.sha256 IS NULL OR f.sha256 NOT IN (${excludeSha256.map(() => '?').join(',')}))`)
      params.push(...excludeSha256)
    }
    if (query) {
      const keyword = `%${String(query).replace(/[\\%_]/g, '\\$&')}%`
      where.push("(c.query LIKE ? ESCAPE '\\' OR a.caption LIKE ? ESCAPE '\\' OR c.text LIKE ? ESCAPE '\\' OR (r.asset_id=c.selected_asset_id AND c.selected_caption LIKE ? ESCAPE '\\'))")
      params.push(keyword, keyword, keyword, keyword)
      relevance = "CASE WHEN a.caption LIKE ? ESCAPE '\\' THEN 30 ELSE 0 END + CASE WHEN r.asset_id=c.selected_asset_id AND c.selected_caption LIKE ? ESCAPE '\\' THEN 25 ELSE 0 END + CASE WHEN c.query LIKE ? ESCAPE '\\' THEN 10 ELSE 0 END + CASE WHEN c.text LIKE ? ESCAPE '\\' THEN 5 ELSE 0 END"
      scoreParams.push(keyword, keyword, keyword, keyword)
    }
    const selection = `SELECT r.*,c.order_index,c.text,c.query,c.query_source,c.selected_asset_id,c.selected_caption,
        a.caption AS asset_caption,a.source_url,a.cover,a.duration,a.width,a.height,a.fps,
        f.bytes,f.sha256,f.duration AS file_duration,f.width AS file_width,f.height AS file_height,f.codec,
        ${relevance} AS relevance
      FROM huasheng_material_recommendations r
      JOIN huasheng_material_clips c ON c.project_id=r.project_id AND c.clip_id=r.clip_id
      JOIN huasheng_material_projects p ON p.project_id=r.project_id
      JOIN huasheng_material_assets a ON a.asset_id=r.asset_id
      LEFT JOIN huasheng_material_files f ON f.file_path=r.file_path
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
    const statement = distinctAssets
      ? `WITH matches AS (${selection}), ranked AS (
          SELECT *,ROW_NUMBER() OVER(PARTITION BY asset_id ORDER BY relevance DESC,rank,project_id,order_index,clip_id) AS match_order FROM matches
        ) SELECT * FROM ranked WHERE match_order=1 ORDER BY relevance DESC,rank,project_id,order_index,clip_id LIMIT ? OFFSET ?`
      : `${selection} ORDER BY r.project_id,c.order_index,r.clip_id,r.rank LIMIT ? OFFSET ?`
    const rows = this.db.prepare(statement).all(...scoreParams, ...params, limit, offset)
    return rows.map(row => {
      const original = decode(row.metadata_json)
      const result = {
        projectId: row.project_id, clipId: row.clip_id, order: row.order_index, text: row.text, query: row.query,
        querySource: row.query_source, annotationType: 'huasheng_recommendation_query', assetId: row.asset_id,
        rank: row.rank, sourceCaption: original.caption || (row.asset_id === row.selected_asset_id ? row.selected_caption : '') || row.asset_caption,
        sourceUrl: original.url || row.source_url, cover: original.cover || row.cover,
        duration: original.duration ?? row.duration, width: original.width ?? row.width, height: original.height ?? row.height,
        fps: original.fps ?? row.fps,
      }
      if (row.download_status !== null) result.status = row.download_status
      if (row.target_path) result.localPath = row.target_path
      if (row.download_status === 'done') Object.assign(result, this.fileDownload(row))
      if (row.error !== null) result.error = row.error
      return result
    })
  }

  stats(projectId) {
    const params = projectId === undefined ? [] : [String(projectId)]
    const filter = projectId === undefined ? '' : ' WHERE project_id=?'
    const count = (sql, args = params) => this.db.prepare(sql).get(...args).count
    const assets = `SELECT DISTINCT asset_id FROM huasheng_material_recommendations${filter}`
    const files = projectId === undefined ? 'SELECT * FROM huasheng_material_files'
      : 'SELECT * FROM huasheng_material_files WHERE project_id=?'
    return {
      projects: count(`SELECT COUNT(*) AS count FROM huasheng_material_projects${filter}`),
      clips: count(`SELECT COUNT(*) AS count FROM huasheng_material_clips${filter}`),
      recommendations: count(`SELECT COUNT(*) AS count FROM huasheng_material_recommendations${filter}`),
      assets: projectId === undefined ? count('SELECT COUNT(*) AS count FROM huasheng_material_assets') : count(`SELECT COUNT(*) AS count FROM (${assets})`),
      downloadedAssets: count(`SELECT COUNT(DISTINCT asset_id) AS count FROM (${files})`),
      files: count(`SELECT COUNT(*) AS count FROM (${files})`),
      downloadedRecommendations: count(`SELECT COUNT(*) AS count FROM huasheng_material_recommendations${filter}${filter ? ' AND' : ' WHERE'} download_status='done'`),
    }
  }
}
