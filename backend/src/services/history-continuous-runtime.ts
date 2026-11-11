import type Database from 'better-sqlite3'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {db} from '../db/index.js'
import {getHistorySource, requireCurrentHistoryScript, type HistorySource} from './history-script-library.js'
import {prepareHistorySourceScript} from './history-script-preparation.js'
import {startHistorySourceJob, resumeHistorySourceJob} from './history-source-jobs.js'
import {historyProductionSourceRevision, startHistoryProductionContinuation} from './history-production-continuation.js'
import {getHistoryProductionState, isHistorySubmissionReceipt} from './history-production-state.js'
import {getHistoryFactory} from './history-factory.js'
import {getHistoryHuashengService, type HistoryHuashengService} from './history-huasheng.js'
import {getHistoryHuashengExportService} from './history-huasheng-export.js'
import {runHistoryDualProductionPass} from './history-video-workflow.js'
import {runHistoryVideoPublicationPass} from './history-video-publication.js'
import {HistorySocialUploadService, type HistorySocialUploadOptions} from './history-social-upload.js'
import {createHistoryContinuousProduction, type HistoryContinuousOptions, type HistoryContinuousScope,
  type HistoryContinuousSource, type HistoryContinuousProgress} from './history-continuous-production.js'

export interface HistoryContinuousRuntimeDependencies {
  database?: Database.Database
  staticRoot?: string
  source?: typeof getHistorySource
  prepare?: typeof prepareHistorySourceScript
  queueCollection?: typeof startHistorySourceJob
  resumeCollection?: typeof resumeHistorySourceJob
  queueContinuation?: typeof startHistoryProductionContinuation
  productionState?: typeof getHistoryProductionState
  productionPass?: typeof runHistoryDualProductionPass
  publicationPass?: typeof runHistoryVideoPublicationPass
  factory?: () => Pick<ReturnType<typeof getHistoryFactory>, 'recoverPending' | 'production' | 'startFromSource' | 'startEpisode' | 'runner'>
  huasheng?: () => Pick<HistoryHuashengService, 'produce' | 'getJob' | 'checkProduction' | 'close'>
  exporter?: () => Pick<ReturnType<typeof getHistoryHuashengExportService>, 'enqueue' | 'runPending' | 'close'>
  social?: (options: HistorySocialUploadOptions) => Pick<HistorySocialUploadService, 'listJobs' | 'enqueue' | 'runPending' | 'close'>
  controller?: typeof createHistoryContinuousProduction
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): Record<string, any> | null => {
  try { const result = typeof value === 'string' ? JSON.parse(value) : value
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null
  } catch { return null }
}

export function createHistoryContinuousRuntime({signal, taskBaseline = 40400, dependencies = {}}: {
  signal?: AbortSignal; taskBaseline?: number; dependencies?: HistoryContinuousRuntimeDependencies
} = {}) {
  if (!Number.isSafeInteger(taskBaseline) || taskBaseline < 40400) throw Error('A new-task baseline of at least 40400 is required')
  const database = dependencies.database || db.$client
  const source = dependencies.source || getHistorySource
  const root = path.resolve(dependencies.staticRoot || process.env.STORAGE_PATH || fileURLToPath(new URL('../../../data/static', import.meta.url)))
  let closed = false
  let factory: ReturnType<NonNullable<HistoryContinuousRuntimeDependencies['factory']>> | undefined
  let huasheng: ReturnType<NonNullable<HistoryContinuousRuntimeDependencies['huasheng']>> | undefined
  let exporter: ReturnType<NonNullable<HistoryContinuousRuntimeDependencies['exporter']>> | undefined
  let social: ReturnType<NonNullable<HistoryContinuousRuntimeDependencies['social']>> | undefined
  const alive = () => { if (closed) throw Error('Continuous history runtime is closed'); signal?.throwIfAborted() }
  const getFactory = () => factory ||= (dependencies.factory || getHistoryFactory)()
  const getQueue = () => huasheng ||= (dependencies.huasheng || getHistoryHuashengService)()
  const getExporter = () => exporter ||= (dependencies.exporter || getHistoryHuashengExportService)()
  const getSocial = () => social ||= (dependencies.social || (options => new HistorySocialUploadService(options)))({
    database, root, recoverOnStartup: false, scope: {sourceIds: []}, automaticPreflightRetry: true,
  })
  const table = (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
  const current = (id: number): HistorySource => {
    alive()
    const value = source(id, {includeDeleted: true})
    if (!value || value.id !== id || value.platform !== 'youtube' || value.deletedAt) throw Error('Original YouTube source was deleted or changed')
    return value
  }
  const snapshot = (value: HistorySource): HistoryContinuousSource => {
    let scriptHash: string | null = null
    try { scriptHash = digest(requireCurrentHistoryScript(value)) } catch { /* An invalid artifact is not a current script. */ }
    return {id: value.id, platform: value.platform, deleted: Boolean(value.deletedAt), revision: historyProductionSourceRevision(value), scriptHash}
  }
  const assertScope = (scope: HistoryContinuousScope) => {
    alive(); scope.assertCurrent()
    if (scope.sourceIds.length !== scope.members.length || new Set(scope.sourceIds).size !== scope.sourceIds.length) throw Error('Invalid continuous history scope')
    for (const member of scope.members) {
      if (!scope.sourceIds.includes(member.sourceId) || scope.scriptHashes[member.sourceId] !== member.scriptHash
        || snapshot(current(member.sourceId)).scriptHash !== member.scriptHash) throw Error('Original admitted source or script changed')
    }
  }
  const scoped = (scope: HistoryContinuousScope, sourceColumn = 'source_id', hashColumn = 'script_sha256') => ({
    where: scope.members.length ? scope.members.map(() => `(${sourceColumn}=? AND ${hashColumn}=?)`).join(' OR ') : '0',
    values: scope.members.flatMap(member => [member.sourceId, member.scriptHash]),
  })
  const dualRows = (scope: HistoryContinuousScope): Array<{source_id: number; script_sha256: string; huasheng_job_id: number}> => {
    if (!table('history_dual_production')) return []
    const selected = scoped(scope)
    return database.prepare(`SELECT source_id,script_sha256,huasheng_job_id FROM history_dual_production WHERE ${selected.where}`).all(...selected.values) as any
  }
  const deliveries = (scope: HistoryContinuousScope): Array<{id: number}> => {
    if (!table('history_video_deliveries')) return []
    const selected = scoped(scope, 'script_id')
    return database.prepare(`SELECT id FROM history_video_deliveries WHERE (${selected.where}) AND producer IN ('motion','huasheng')`).all(...selected.values) as any
  }
  const uploads = (scope: HistoryContinuousScope): Array<Record<string, any>> => {
    if (!table('history_social_upload_jobs') || !table('history_video_deliveries')) return []
    const selected = scoped(scope, 'v.script_id', 'v.script_sha256')
    return database.prepare(`SELECT j.*,v.script_sha256 AS delivery_script_hash,v.video_path AS delivery_video_path,
      v.producer AS delivery_producer,v.producer_job_id AS delivery_job_id FROM history_social_upload_jobs j
      JOIN history_video_deliveries v ON v.id=j.video_id AND v.script_id=j.source_id AND v.producer=j.video_producer
      WHERE (${selected.where}) AND j.publication_mode='publish' AND j.target='baijiahao-video' ORDER BY j.id DESC`).all(...selected.values) as any
  }
  const receipt = (row: Record<string, any>) => {
    const result = object(row.result_json), payload = object(row.payload_json)
    if (row.status !== 'completed' || !isHistorySubmissionReceipt(result) || !payload
      || String(payload.jobId) !== String(row.id) || payload.scriptId !== row.source_id
      || payload.target !== 'baijiahao-video' || payload.publicationMode !== 'publish'
      || !row.fingerprint || payload.fingerprint !== row.fingerprint
      || payload.accountName !== 'history_baijiahao' || result.accountName !== payload.accountName
      || typeof payload.videoPath !== 'string') return null
    const filename = path.resolve(root, String(row.delivery_video_path).replace(/^\/?static\//, ''))
    return path.resolve(payload.videoPath) === filename ? result : null
  }
  const options: HistoryContinuousOptions = {
    database,
    source(id) { alive(); const value = source(id, {includeDeleted: true}); return value ? snapshot(value) : null },
    queueCollection(input) {
      alive()
      const result = (dependencies.queueCollection || startHistorySourceJob)(input)
      if (!result.created) throw Error('Another original collection is active; wait without adopting its task')
      if (result.job.id <= taskBaseline) throw Error('Collection task is outside the new-task baseline')
      return {taskId: result.job.id}
    },
    recoverCollection(id) {
      alive()
      if (!Number.isSafeInteger(id) || id <= taskBaseline) throw Error('Original collection task is outside the new-task baseline')
      const job = (dependencies.resumeCollection || resumeHistorySourceJob)(id)
      if (!job || job.id !== id || !['queued', 'running'].includes(job.status)) {
        throw Error('Collection recovery must retain the original queued or running task')
      }
      return {taskId: job.id}
    },
    async prepare(input) {
      alive(); input.assertCurrent()
      const before = current(input.sourceId)
      if (historyProductionSourceRevision(before) !== input.expectedRevision) throw Error('Source revision changed before preparation')
      await (dependencies.prepare || prepareHistorySourceScript)(before, {signal})
      alive()
      const prepared = snapshot(current(input.sourceId))
      if (!prepared.scriptHash) throw Error('Prepared source has no valid current script')
      return {sourceId: prepared.id, revision: prepared.revision, scriptHash: prepared.scriptHash}
    },
    queueContinuation(input) {
      const value = snapshot(current(input.sourceId))
      if (value.revision !== input.revision || value.scriptHash !== input.scriptHash) throw Error('Prepared source changed before continuation')
      const result = (dependencies.queueContinuation || startHistoryProductionContinuation)(input.sourceId, {expectedRevision: input.revision})
      const task = result.task
      if (!task || task.id <= taskBaseline || task.type !== 'history.production.continue' || task.scopeId !== input.sourceId
        || task.payload?.sourceId !== input.sourceId || task.payload?.scriptSha256 !== input.scriptHash) {
        throw Error('Original continuation task does not match the admitted source/hash/baseline')
      }
      return {taskId: task.id}
    },
    observe(scope) {
      assertScope(scope)
      const originalUploads = uploads(scope)
      return scope.members.map(member => {
        const value = current(member.sourceId)
        const state = (dependencies.productionState || getHistoryProductionState)(database, {
          id: value.id, title: value.title, rewrittenScript: value.rewrittenScript, provenance: value,
        }, {root})
        if (state.scriptSha256 !== member.scriptHash) throw Error('Production observation belongs to another script')
        const motion = state.versions.find(version => version.producer === 'motion' && version.scriptSha256 === member.scriptHash)
        const matched = originalUploads.find(row => row.source_id === member.sourceId && row.delivery_script_hash === member.scriptHash
          && row.delivery_producer === 'motion' && row.video_id === motion?.videoId
          && row.delivery_job_id === motion?.producerJobId && receipt(row))
        const result = matched && receipt(matched)
        const motionState: HistoryContinuousProgress['motion']['state'] = result ? result.published ? 'published' : 'submitted'
          : !motion ? 'pending' : ['submitted', 'published', 'attention', 'uncertain', 'stale'].includes(motion.state) ? 'attention'
            : motion.state === 'ready' ? 'ready' : motion.state === 'pending' ? 'pending' : 'active'
        return {sourceId: member.sourceId, scriptHash: member.scriptHash,
          fingerprint: digest(JSON.stringify({versions: state.versions, receipt: matched ? {id: matched.id, result: result} : null})),
          motion: {state: motionState, ...(matched && result ? {receiptId: String(matched.id)} : {})},
          huashengState: state.versions.find(version => version.producer === 'huasheng')?.state || 'pending'}
      })
    },
    async advance(scope) {
      assertScope(scope)
      if (!scope.sourceIds.length) return
      const errors: unknown[] = []
      const step = async (operation: () => unknown | Promise<unknown>) => {
        assertScope(scope)
        try { await operation() } catch (error) { assertScope(scope); errors.push(error) }
        assertScope(scope)
      }
      const pass = dependencies.productionPass || runHistoryDualProductionPass
      // Launch local work before a cloud account or export can wait for recovery.
      await step(() => pass({sourceIds: [...scope.sourceIds], motionOnly: true, factory: getFactory()}))
      await step(() => getFactory().recoverPending(scope.sourceIds))
      const allowedJobs = new Map(dualRows(scope).map(row => [row.huasheng_job_id, row]))
      const selectedQueue: Pick<HistoryHuashengService, 'produce' | 'getJob' | 'checkProduction'> = {
        getJob(id) {
          assertScope(scope)
          const expected = allowedJobs.get(id)
          if (!expected) throw Error('Huasheng job is outside the admitted source/hash/account')
          const job = getQueue().getJob(id)
          if (job.sourceId !== expected.source_id || job.scriptSha256 !== expected.script_sha256
            || job.huashengAccountName !== 'history_huasheng_legacy') throw Error('Huasheng job is outside the admitted source/hash/account')
          return job
        },
        async produce(ids, productionOptions) {
          const jobs = ids.map(id => selectedQueue.getJob(id))
          const runnable = jobs.filter(job => !job.cancelRequested && job.status === 'queued' && job.productionStatus === 'not_started'
            && !((job.checkpoint === 'create_pending' || job.stage === 'create_pending') && !job.projectUrl))
          const results = jobs.filter(job => !runnable.includes(job)).map(job => ({jobId: job.id, sourceId: job.sourceId,
            status: job.status === 'queued' && !job.projectUrl && (job.checkpoint === 'create_pending' || job.stage === 'create_pending')
              ? 'blocked' as const : 'skipped' as const, message: 'Preserve the original cloud job and its creation checkpoint'}))
          if (runnable.length) {
            assertScope(scope)
            const result = await getQueue().produce(runnable.map(job => job.id), productionOptions)
            assertScope(scope)
            return {...result, results: [...result.results, ...results]}
          }
          return {results, running: false}
        },
        checkProduction(sourceId, productionOptions) {
          assertScope(scope)
          if (sourceId === undefined || !scope.sourceIds.includes(sourceId) || !productionOptions?.jobIds
            || productionOptions.jobIds.some(id => selectedQueue.getJob(id).sourceId !== sourceId)) throw Error('Explicit original Huasheng jobs are required')
          const result = getQueue().checkProduction(sourceId, productionOptions)
          assertScope(scope); return result
        },
      }
      await step(async () => {
        if (allowedJobs.size) await selectedQueue.produce([...allowedJobs.keys()])
      })
      await step(() => pass({sourceIds: [...scope.sourceIds], queue: selectedQueue, factory: getFactory(), exporter: getExporter()}))
      await step(async () => {
        if (!table('history_huasheng_export_jobs')) return
        const selected = scoped(scope, 'e.source_id', 'e.script_sha256')
        const jobs = database.prepare(`SELECT e.id FROM history_huasheng_export_jobs e JOIN history_dual_production d
          ON d.source_id=e.source_id AND d.script_sha256=e.script_sha256 AND d.huasheng_job_id=e.huasheng_job_id
          WHERE ${selected.where}`).all(...selected.values) as Array<{id: number}>
        if (jobs.length) await getExporter().runPending(jobs.map(job => job.id))
      })
      await step(async () => {
        const videoIds = deliveries(scope).map(video => video.id)
        const selected = scoped(scope)
        const intentIds = table('history_video_publication_intents')
          ? (database.prepare(`SELECT id FROM history_video_publication_intents WHERE ${selected.where}`).all(...selected.values) as Array<{id: number}>).map(row => row.id) : []
        await (dependencies.publicationPass || runHistoryVideoPublicationPass)({social: getSocial(),
          scope: {sourceIds: [...scope.sourceIds], videoIds, jobIds: intentIds}})
      })
      await step(() => getSocial().runPending({sourceIds: [...scope.sourceIds], videoIds: deliveries(scope).map(row => row.id),
        jobIds: uploads(scope).map(row => row.id)}))
      if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '))
    },
  }
  const controller = (dependencies.controller || createHistoryContinuousProduction)(options)
  let closing: Promise<void> | undefined
  return {controller, close() {
    return closing ||= (async () => {
      closed = true
      const results = await Promise.allSettled([factory?.runner.stop(10_000), huasheng?.close(), exporter?.close(), social?.close()])
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Continuous history services did not all stop')
    })()
  }}
}
