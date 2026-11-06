import { and, count, desc, eq, getTableColumns, isNull, or, sql, type SQL } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import type { CzgtsCollectedArticle } from './history-source-czgts.js'
import { getHistorySourceArtifactState } from './history-script-artifacts.js'
import { historyProductionAssetAvailable, isHistorySubmissionReceipt } from './history-production-state.js'
export { getHistorySourceArtifactState, type HistoryArtifactState } from './history-script-artifacts.js'

export const HISTORY_SOURCE_CATEGORIES = [
  'regional_history',
  'unofficial_history',
  'historical_anecdote',
  'historical_commentary',
  'history_trivia',
] as const

export type HistorySourceCategory = typeof HISTORY_SOURCE_CATEGORIES[number]
export const HISTORY_LIBRARY_CATEGORIES = [...HISTORY_SOURCE_CATEGORIES, 'unclassified'] as const
export type HistoryLibraryCategory = typeof HISTORY_LIBRARY_CATEGORIES[number]
export type HistorySource = typeof schema.historyScriptSources.$inferSelect
export type HistorySourcePatch = Partial<typeof schema.historyScriptSources.$inferInsert>

function textSha256(text: string) { return createHash('sha256').update(text).digest('hex') }

export function requireCurrentHistoryScript(source: HistorySource): string {
  if (!source.rewrittenScript?.trim()) throw new Error('Draft is not available')
  if (getHistorySourceArtifactState(source).rewritten !== 'current') {
    throw new Error('Draft is stale or its provenance is incomplete; process through recreation before exporting')
  }
  return source.rewrittenScript
}

const metricCount = z.number().finite().nonnegative()
const metricsSchema = z.object({
  likes: metricCount.optional(),
  comments: metricCount.optional(),
  shares: metricCount.optional(),
  collects: metricCount.optional(),
  reads: metricCount.optional(),
  fans: metricCount.optional(),
}).strict()

const selectionSchema = z.object({
  reason: z.string().trim().min(1),
  observedAt: z.iso.datetime({ offset: true }),
  comments: z.array(z.object({
    text: z.string(),
    likes: metricCount.optional(),
  }).passthrough()),
}).passthrough()

export interface StoreHistorySourceInput {
  sourceVideoId: string
  sourceType?: 'video' | 'note'
  sourceText?: string
  title: string
  authorName?: string | null
  category: HistoryLibraryCategory
  metrics?: z.infer<typeof metricsSchema>
  selection?: z.infer<typeof selectionSchema>
}

const inputSchema = z.object({
  sourceVideoId: z.string().regex(/^\d+$/, 'sourceVideoId must be a string of digits'),
  sourceType: z.enum(['video', 'note']).optional(),
  sourceText: z.string().optional(),
  title: z.string().trim().min(1),
  authorName: z.string().trim().nullable().optional(),
  category: z.enum(HISTORY_LIBRARY_CATEGORIES),
  metrics: metricsSchema.optional(),
  selection: selectionSchema,
})

export function storeHistorySource(input: StoreHistorySourceInput): HistorySource {
  const parsed = inputSchema.parse(input)
  const ts = now()
  const sourceUrl = `https://www.douyin.com/${parsed.sourceType === 'note' ? 'note' : 'video'}/${parsed.sourceVideoId}`
  const evidence = {
    title: parsed.title,
    category: parsed.category,
    selectionJson: JSON.stringify(parsed.selection),
    updatedAt: ts,
    ...(parsed.authorName !== undefined ? { authorName: parsed.authorName || null } : {}),
    ...(parsed.metrics !== undefined ? { metricsJson: JSON.stringify(parsed.metrics) } : {}),
  }
  // Update observation evidence without resetting a previously processed source.
  return db.insert(schema.historyScriptSources).values({
    ...evidence,
    platform: 'douyin',
    sourceVideoId: parsed.sourceVideoId,
    sourceUrl,
    ...(parsed.sourceType === 'note' ? { mediaJson: JSON.stringify({ kind: 'note', noteId: parsed.sourceVideoId,
      sourceUrl, caption: parsed.sourceText ?? parsed.title }) } : {}),
    createdAt: ts,
  }).onConflictDoUpdate({
    target: [schema.historyScriptSources.platform, schema.historyScriptSources.sourceVideoId],
    set: evidence,
  }).returning().get()
}

const articleInputSchema = z.object({
  articleId: z.string().regex(/^\d+$/),
  sourceUrl: z.string(),
  title: z.string().trim().min(1),
  authorName: z.string(),
  text: z.string().refine(text => text.trim().length > 0, 'Article text is required'),
  fetchedAt: z.iso.datetime({ offset: true }),
  metadata: z.object({
    gid: z.string().regex(/^\d+$/), platform: z.literal('百家号'), category: z.string(),
    publishTime: z.string(), keywords: z.array(z.string()),
    reads: metricCount.optional(), likes: metricCount.optional(), comments: metricCount.optional(), fans: metricCount.optional(),
  }).strict(),
}).strict().refine(value => value.sourceUrl === `https://baijiahao.baidu.com/s?id=${value.articleId}`, 'Article URL must match its ID')

export function storeHistoryArticleSource(input: CzgtsCollectedArticle): HistorySource {
  const article = articleInputSchema.parse(input)
  const ts = now()
  const { reads, likes, comments, fans } = article.metadata
  // An existing identity (including a deleted one) must never overwrite a saved or reviewed original.
  const inserted = db.insert(schema.historyScriptSources).values({
    platform: 'baijiahao', sourceVideoId: article.articleId, sourceUrl: article.sourceUrl,
    title: article.title, authorName: article.authorName || null, category: 'unclassified',
    status: 'article_saved', rawTranscript: article.text,
    metricsJson: JSON.stringify({ reads, likes, comments, fans }),
    selectionJson: JSON.stringify({ collector: 'czgts', ...article.metadata }),
    mediaJson: JSON.stringify({
      kind: 'article', collector: 'czgts', articleId: article.articleId, sourceUrl: article.sourceUrl,
      fetchedAt: article.fetchedAt, textSha256: textSha256(article.text),
    }),
    createdAt: ts, updatedAt: ts,
  }).onConflictDoNothing({ target: [schema.historyScriptSources.platform, schema.historyScriptSources.sourceVideoId] }).returning().get()
  return inserted ?? db.select().from(schema.historyScriptSources).where(and(
    eq(schema.historyScriptSources.platform, 'baijiahao'), eq(schema.historyScriptSources.sourceVideoId, article.articleId),
  )).get()!
}

export function getHistorySource(id: number, options: { includeDeleted?: boolean } = {}): HistorySource | null {
  if (!Number.isSafeInteger(id) || id < 1) return null
  return db.select().from(schema.historyScriptSources)
    .where(and(eq(schema.historyScriptSources.id, id), options.includeDeleted ? undefined : isNull(schema.historyScriptSources.deletedAt))).get() ?? null
}

export interface ListHistorySourcesOptions {
  category?: HistoryLibraryCategory
  status?: string
  q?: string
  video?: 'completed' | 'not_completed'
  titlePlan?: 'generated' | 'not_generated'
  cover?: 'generated' | 'not_generated'
  motion?: 'generated' | 'not_generated'
  upload?: 'not_uploaded' | 'partially_uploaded' | 'uploaded'
  limit?: number
  offset?: number
}

export interface HistoryWorkflowState {
  videoCompleted: boolean
  videoLinked: boolean
  titlePlanGenerated: boolean
  coverGenerated: boolean
  motionGenerated: boolean
  uploadState: 'not_uploaded' | 'partially_uploaded' | 'uploaded'
  uploads: Record<string, 'submitted' | 'published' | 'not_uploaded'>
  /** Submitted includes published editions; counts refer only to the current manuscript. */
  publicationCounts: { expected: number; submitted: number; published: number }
}

// SQL filtering and pagination use the same manuscript identity as the production services.
db.$client.function('history_workflow_script_sha256', { deterministic: true }, (text: unknown) =>
  typeof text === 'string' && text.trim() ? textSha256(text) : null)
db.$client.function('history_workflow_asset_available', (id: unknown, url: unknown) =>
  typeof id === 'number' && historyProductionAssetAvailable(id, url) ? 1 : 0)
db.$client.function('history_workflow_submission_receipt', { deterministic: true }, (value: unknown) => {
  try { return typeof value === 'string' && isHistorySubmissionReceipt(JSON.parse(value)) ? 1 : 0 } catch { return 0 }
})
db.$client.function('history_workflow_same_video_path', (id: unknown, url: unknown, payload: unknown) => {
  if (typeof id !== 'number' || typeof url !== 'string' || !/^\/?static\//.test(url) || /[\\%?#\0]/.test(url)) return 0
  const relative = url.replace(/^\/?static\//, '')
  if (!relative.startsWith(`history-deliveries/${id}/`) || relative.split('/').some(part => !part || part === '.' || part === '..')) return 0
  try {
    const result = typeof payload === 'string' ? JSON.parse(payload) : null
    const root = process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url))
    return typeof result?.videoPath === 'string' && path.resolve(result.videoPath) === path.resolve(root, relative) ? 1 : 0
  } catch { return 0 }
})

/** Share the same output predicates between filtering, counts and displayed state.
 * Reading these tables must never initialize a production service or open a browser. */
function workflowExpressions() {
  const tables = new Set((db.$client.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('history_huasheng_jobs','history_script_deliveries','history_motion_productions',
      'history_social_upload_jobs','history_video_deliveries','history_dual_production','history_video_packaging')`)
    .all() as { name: string }[]).map(row => row.name))
  const columns = (table: string) => new Set(tables.has(table)
    ? (db.$client.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name) : [])
  const hasColumns = (table: string, required: string[]) => {
    const actual = columns(table)
    return required.every(column => actual.has(column))
  }
  // Keep correlated IDs qualified when Drizzle compiles a direct SELECT expression.
  const sourceId = sql`${schema.historyScriptSources.id}`
  const currentScript = schema.historyScriptSources.rewrittenScript
  const scriptHash = sql`history_workflow_script_sha256(${currentScript})`
  const no = sql`0`
  const linkedVideo = tables.has('history_script_deliveries') ? sql`EXISTS (
    SELECT 1 FROM history_script_deliveries d WHERE d.script_id=${sourceId} AND length(trim(d.video_path)) > 0
      AND (d.script_sha256=${scriptHash} OR (d.script_sha256 IS NULL AND ${currentScript} IS NULL))
      AND history_workflow_asset_available(${sourceId},d.video_path)=1
  )` : no
  const legacyTitlePlanGenerated = tables.has('history_script_deliveries') ? sql`EXISTS (
    SELECT 1 FROM history_script_deliveries d WHERE d.script_id=${sourceId}
      AND d.design_status='completed' AND length(trim(d.title)) > 0
      AND (d.script_sha256=${scriptHash} OR (d.script_sha256 IS NULL AND ${currentScript} IS NULL))
  )` : no
  const legacyCoverGenerated = tables.has('history_script_deliveries') ? sql`EXISTS (
    SELECT 1 FROM history_script_deliveries d WHERE d.script_id=${sourceId} AND d.cover_status='completed'
    AND (d.cover_script_sha256=${scriptHash} OR (d.cover_script_sha256 IS NULL AND ${currentScript} IS NULL))
    AND CASE WHEN json_valid(d.covers_json) THEN
      history_workflow_asset_available(${sourceId},json_extract(d.covers_json,'$."16:9"'))=1
      AND history_workflow_asset_available(${sourceId},json_extract(d.covers_json,'$."3:4"'))=1
    ELSE 0 END
  )` : no
  const hasEditions = hasColumns('history_video_deliveries', ['id', 'script_id', 'script_sha256', 'producer', 'video_path'])
  const hasPublicationJobs = hasColumns('history_social_upload_jobs', ['source_id', 'target', 'status', 'result_json', 'publication_mode', 'video_id'])
  // A later render supersedes the previous output of that producer, even if the previous render was published.
  const currentEdition = sql`v.script_id=${sourceId} AND v.script_sha256=${scriptHash} AND length(trim(v.video_path))>0
    AND v.id=(SELECT MAX(latest.id) FROM history_video_deliveries latest
      WHERE latest.script_id=v.script_id AND latest.script_sha256=v.script_sha256 AND latest.producer=v.producer)`
  const editionLinked = hasEditions ? sql`EXISTS (SELECT 1 FROM history_video_deliveries v WHERE ${currentEdition}
    AND history_workflow_asset_available(${sourceId},v.video_path)=1)` : no
  const editionMotion = hasEditions ? sql`EXISTS (SELECT 1 FROM history_video_deliveries v WHERE ${currentEdition} AND v.producer='motion'
    AND history_workflow_asset_available(${sourceId},v.video_path)=1)` : no
  const registeredProduction = hasColumns('history_dual_production', ['source_id', 'script_sha256']) ? sql`EXISTS (
    SELECT 1 FROM history_dual_production p WHERE p.source_id=${sourceId} AND p.script_sha256=${scriptHash}
  )` : no
  const motionBackfill = hasColumns('history_dual_production', ['source_id', 'script_sha256', 'production_mode']) ? sql`EXISTS (
    SELECT 1 FROM history_dual_production p WHERE p.source_id=${sourceId} AND p.script_sha256=${scriptHash}
      AND p.production_mode='motion_backfill'
  )` : no
  const requiredEdition = sql`${currentEdition} AND CASE WHEN ${registeredProduction}
    THEN CASE WHEN ${motionBackfill} THEN v.producer='motion' ELSE v.producer IN ('huasheng','motion') END ELSE 1 END`
  const editionCount = hasEditions ? sql`(SELECT COUNT(*) FROM history_video_deliveries v WHERE ${requiredEdition})` : no
  const deliveredCount = hasEditions ? sql`(SELECT COUNT(*) FROM history_video_deliveries v WHERE ${requiredEdition}
    AND history_workflow_asset_available(${sourceId},v.video_path)=1)` : no
  const dualExpected = sql`CASE WHEN ${registeredProduction} THEN CASE WHEN ${motionBackfill} THEN 1 ELSE 2 END ELSE 0 END`
  const expected = sql`MAX(${editionCount}, ${dualExpected}, CASE WHEN ${linkedVideo} THEN 1 ELSE 0 END)`
  const editionRecords = hasEditions ? sql`EXISTS (SELECT 1 FROM history_video_deliveries v WHERE v.script_id=${sourceId})` : no
  const hasPackaging = hasColumns('history_video_packaging', ['video_id','script_id','script_sha256','title',
    'design_status','cover_script_sha256','cover_status','covers_json'])
  const packagingCount = (condition: SQL) => hasEditions && hasPackaging ? sql`(
    SELECT COUNT(*) FROM history_video_deliveries v WHERE ${requiredEdition} AND EXISTS (
      SELECT 1 FROM history_video_packaging p WHERE p.video_id=v.id AND p.script_id=${sourceId}
        AND p.script_sha256=${scriptHash} AND (${condition})
    )
  )` : no
  const titleCount = packagingCount(sql`p.design_status='completed' AND length(trim(p.title))>0`)
  const coverCount = packagingCount(sql`p.cover_status='completed' AND p.cover_script_sha256=${scriptHash}
    AND CASE WHEN json_valid(p.covers_json) THEN
      history_workflow_asset_available(${sourceId},json_extract(p.covers_json,'$."16:9"'))=1
      AND history_workflow_asset_available(${sourceId},json_extract(p.covers_json,'$."3:4"'))=1
    ELSE 0 END`)
  // Once concrete editions exist, shared legacy packaging cannot complete a new or superseded output.
  const titlePlanGenerated = sql`CASE WHEN ${editionRecords} THEN (${expected}>0 AND ${titleCount}=${expected}) ELSE ${legacyTitlePlanGenerated} END`
  const coverGenerated = sql`CASE WHEN ${editionRecords} THEN (${expected}>0 AND ${coverCount}=${expected}) ELSE ${legacyCoverGenerated} END`
  const receipt = sql`history_workflow_submission_receipt(u.result_json)=1`
  const sameVideo = columns('history_social_upload_jobs').has('payload_json')
    ? sql`(u.video_id=v.id OR (u.video_id IS NULL AND history_workflow_same_video_path(${sourceId},v.video_path,u.payload_json)=1))`
    : sql`u.video_id=v.id`
  const publicationCount = (publishedOnly: boolean) => hasEditions && hasPublicationJobs ? sql`(
    SELECT COUNT(*) FROM history_video_deliveries v WHERE ${requiredEdition} AND EXISTS (
      SELECT 1 FROM history_social_upload_jobs u WHERE u.source_id=${sourceId} AND ${sameVideo}
        AND u.target='baijiahao-video' AND u.publication_mode='publish' AND u.status='completed' AND (${receipt})
        ${publishedOnly ? sql`AND json_extract(u.result_json,'$.publicationStatus')='published'` : sql``}
    )
  )` : no
  const submitted = publicationCount(false)
  const published = publicationCount(true)
  const publicationState = sql`CASE WHEN ${submitted}=0 THEN 'not_uploaded'
    WHEN ${published}=${expected} THEN 'published' ELSE 'submitted' END`
  return {
    videoCompleted: sql`CASE WHEN ${editionRecords} OR ${dualExpected}>0
      THEN ${expected}>0 AND ${deliveredCount}=${expected} ELSE ${linkedVideo} END`.mapWith(Boolean),
    videoLinked: sql`(${editionLinked} OR ${linkedVideo})`.mapWith(Boolean),
    titlePlanGenerated: titlePlanGenerated.mapWith(Boolean),
    coverGenerated: coverGenerated.mapWith(Boolean),
    motionGenerated: editionMotion.mapWith(Boolean),
    uploadState: sql`CASE WHEN ${submitted}=0 THEN 'not_uploaded'
      WHEN ${submitted}=${expected} THEN 'uploaded' ELSE 'partially_uploaded' END`.mapWith(value => value as HistoryWorkflowState['uploadState']),
    uploads: sql`json_object('baijiahao-video', ${publicationState})`
      .mapWith(value => JSON.parse(String(value)) as HistoryWorkflowState['uploads']),
    publicationCounts: sql`json_object('expected', ${expected}, 'submitted', ${submitted}, 'published', ${published})`
      .mapWith(value => JSON.parse(String(value)) as HistoryWorkflowState['publicationCounts']),
  }
}

export function getHistorySourceWorkflowState(id: number): HistoryWorkflowState {
  return db.select(workflowExpressions()).from(schema.historyScriptSources)
    .where(eq(schema.historyScriptSources.id, id)).get()
    ?? { videoCompleted: false, videoLinked: false, titlePlanGenerated: false, coverGenerated: false, motionGenerated: false,
    uploadState: 'not_uploaded', uploads: { 'baijiahao-video': 'not_uploaded' }, publicationCounts: { expected: 0, submitted: 0, published: 0 } }
}

export function listHistorySources(options: ListHistorySourcesOptions = {}) {
  const parsed = z.object({
    category: z.enum(HISTORY_LIBRARY_CATEGORIES).optional(),
    status: z.string().trim().min(1).optional(),
    q: z.string().trim().optional(),
    video: z.enum(['completed', 'not_completed']).optional(),
    titlePlan: z.enum(['generated', 'not_generated']).optional(),
    cover: z.enum(['generated', 'not_generated']).optional(),
    motion: z.enum(['generated', 'not_generated']).optional(),
    upload: z.enum(['not_uploaded', 'partially_uploaded', 'uploaded']).optional(),
    limit: z.number().int().positive().default(20),
    offset: z.number().int().nonnegative().default(0),
  }).parse(options)
  const table = schema.historyScriptSources
  const workflowState = workflowExpressions()
  const filters: SQL[] = [isNull(table.deletedAt)]
  for (const [value, expression] of [
    [parsed.video, workflowState.videoCompleted], [parsed.titlePlan, workflowState.titlePlanGenerated],
    [parsed.cover, workflowState.coverGenerated], [parsed.motion, workflowState.motionGenerated],
  ] as const) {
    if (value) filters.push(sql`(${expression}) = ${value === 'completed' || value === 'generated' ? 1 : 0}`)
  }
  if (parsed.upload) filters.push(sql`(${workflowState.uploadState}) = ${parsed.upload}`)
  if (parsed.category) filters.push(eq(table.category, parsed.category))
  if (parsed.status) filters.push(eq(table.status, parsed.status))
  if (parsed.q) {
    const pattern = `%${parsed.q.replace(/[\\%_]/g, '\\$&')}%`
    filters.push(or(...[
      table.title, table.authorName, table.rawTranscript, table.correctedTranscript, table.rewrittenScript,
    ].map(column => sql`${column} LIKE ${pattern} ESCAPE '\\'`))!)
  }
  const where = and(...filters)
  const items = db.select({ ...getTableColumns(table), workflowState }).from(table).where(where)
    .orderBy(desc(table.updatedAt), desc(table.id))
    .limit(Math.min(parsed.limit, 100)).offset(parsed.offset).all()
  const total = db.select({ total: count() }).from(table).where(where).get()!.total
  return { items, total }
}

const patchSchema = z.object({
  title: z.string().trim().min(1).optional(),
  authorName: z.string().trim().nullable().optional(),
  category: z.enum(HISTORY_LIBRARY_CATEGORIES).optional(),
  status: z.string().trim().min(1).optional(),
  metricsJson: z.string().optional(),
  selectionJson: z.string().optional(),
  mediaJson: z.string().optional(),
  rawTranscript: z.string().nullable().optional(),
  correctedTranscript: z.string().nullable().optional(),
  rewrittenScript: z.string().nullable().optional(),
  asrJson: z.string().nullable().optional(),
  reviewJson: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
}).strict()

export function updateHistorySource(id: number, patch: HistorySourcePatch): HistorySource | null {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid history source id')
  // Strict validation also prevents callers from mutating source identity or creation time.
  const parsed = patchSchema.parse(patch)
  if (parsed.metricsJson !== undefined) {
    parsed.metricsJson = JSON.stringify(metricsSchema.parse(JSON.parse(parsed.metricsJson)))
  }
  if (parsed.selectionJson !== undefined) {
    parsed.selectionJson = JSON.stringify(selectionSchema.parse(JSON.parse(parsed.selectionJson)))
  }
  for (const field of ['mediaJson', 'asrJson', 'reviewJson'] as const) {
    if (parsed[field] !== undefined && parsed[field] !== null) JSON.parse(parsed[field])
  }
  return db.update(schema.historyScriptSources).set({ ...parsed, updatedAt: now() })
    .where(and(eq(schema.historyScriptSources.id, id), isNull(schema.historyScriptSources.deletedAt))).returning().get() ?? null
}

// Retain source identity for deduplication; the ASR pipeline owns temporary media cleanup.
// Callers must hold the source lock and validate the revision before invoking this mutation.
export function deleteHistorySource(id: number): HistorySource | null {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid history source id')
  const ts = now()
  return db.update(schema.historyScriptSources).set({ deletedAt: ts, updatedAt: ts })
    .where(and(eq(schema.historyScriptSources.id, id), isNull(schema.historyScriptSources.deletedAt))).returning().get() ?? null
}
