import type Database from 'better-sqlite3'
import {getHistoryProductionStates, readHistoryProductionInventory, type HistoryProductionSource} from './history-production-state.js'
import {HISTORY_STATUS_SCHEMA_VERSION} from './history-status-storage.js'
import type {HistorySocialUploads} from './history-social-upload.js'

/** Read-only view shared by the synchronous executor API and isolated HTTP reader. */
export function readHistorySocialCandidates(database: Database.Database, root: string, sourceIds?: number[], summary = false) {
  const selectedIds = sourceIds === undefined ? undefined : [...new Set(sourceIds)]
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row => row.name))
  const indexes = summary ? new Set((database.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{name:string}>).map(row => row.name)) : new Set<string>()
  if (!tables.has('history_script_sources')) return []
  const associations = [
    ['history_dual_production', 'source_id', ''],
    ['history_video_deliveries', 'script_id', ''],
    ['history_huasheng_jobs', 'source_id', ''],
    ['history_motion_productions', 'script_id', ''],
    ['history_script_deliveries', 'script_id', "AND length(trim(a.video_path))>0"],
  ].filter(([table]) => tables.has(table!))
    .map(([table, owner, condition]) => `EXISTS (SELECT 1 FROM ${table} a${summary && indexes.has(`${table}_status_cover`) ? ` INDEXED BY ${table}_status_cover` : ''} WHERE a.${owner}=s.id ${condition})`)
  if (!associations.length) return []
  const columns = new Set((database.pragma('table_info(history_script_sources)') as Array<{name:string}>).map(column => column.name))
  const {sources, inventory} = database.transaction(() => {
    const sourceColumns = summary ? ['id', 'title', 'deleted_at'] : ['id', 'title', 'rewritten_script', 'deleted_at',
      'platform', 'source_video_id', 'source_url', 'raw_transcript', 'corrected_transcript', 'media_json', 'asr_json', 'review_json']
    const hasSummary = summary && tables.has('history_source_status')
    const summaryColumns = ['script_sha256', 'script_text_sha256', 'script_type', 'rewritten_state', 'has_provenance',
      'input_revision', 'projected_revision', 'schema_version', 'deleted', 'updated_at']
    const selected = sourceColumns.filter(column => columns.has(column)).map(column => `s.${column}`)
    if (summary) selected.push(...summaryColumns.map(column => `${hasSummary ? `ss.${column}` : 'NULL'} AS summary_${column}`))
    const covered = summary && indexes.has('history_script_sources_status_cover') ? ' INDEXED BY history_script_sources_status_cover' : ''
    const rows = database.prepare(`SELECT ${selected.join(',')} FROM history_script_sources s${covered}
      ${hasSummary ? 'LEFT JOIN history_source_status ss ON ss.source_id=s.id' : ''}
      WHERE ${columns.has('deleted_at') ? 's.deleted_at IS NULL AND' : ''}
      ${selectedIds ? `s.id IN (${selectedIds.map(() => '?').join(',')}) AND` : ''}
      (${associations.join(' OR ')}) ORDER BY s.id DESC`).all(...(selectedIds ?? [])) as Array<Record<string, any>>
    const sources: HistoryProductionSource[] = rows.map(row => ({id: row.id, title: row.title,
      rewrittenScript: summary ? null : row.rewritten_script || null, deletedAt: row.deleted_at,
      ...(summary ? {statusSummary: {
        scriptSha256: row.summary_script_sha256, scriptTextSha256: row.summary_script_text_sha256,
        scriptType: row.summary_script_type || 'missing',
        artifactState: row.summary_has_provenance ? row.summary_rewritten_state : 'current',
        fresh: row.summary_input_revision != null && row.summary_input_revision === row.summary_projected_revision
          && row.summary_schema_version === HISTORY_STATUS_SCHEMA_VERSION && !row.summary_deleted,
        observedAt: row.summary_updated_at,
      }} : columns.has('media_json') && columns.has('review_json') ? {provenance: {
        platform: row.platform, sourceVideoId: row.source_video_id, sourceUrl: row.source_url,
        rawTranscript: row.raw_transcript, correctedTranscript: row.corrected_transcript, rewrittenScript: row.rewritten_script,
        mediaJson: row.media_json, asrJson: row.asr_json, reviewJson: row.review_json,
      }} : {}),
    }))
    return {sources, inventory: readHistoryProductionInventory(database, sources.map(source => source.id), summary)}
  })()
  const states = getHistoryProductionStates(database, sources, {root, summary, inventory})
  const sourceById = new Map(sources.map(source => [source.id, source]))
  return states.filter(state => state.versions.length > 0).map(state => {
    const uploads: HistorySocialUploads = {}
    if (state.complete) uploads['baijiahao-video'] = {
      status: state.versions.every(version => version.state === 'published') ? 'published' : 'submitted',
      confirmedAt: state.versions.map(version => version.confirmedAt!).sort().at(-1)!, confirmation: 'platform',
    }
    return {scriptId: state.scriptId, title: sourceById.get(state.scriptId)!.title, uploads, versions: state.versions}
  })
}
export type HistorySocialCandidates = ReturnType<typeof readHistorySocialCandidates>
