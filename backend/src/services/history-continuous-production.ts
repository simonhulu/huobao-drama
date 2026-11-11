import type Database from 'better-sqlite3'
import {createHash, randomUUID} from 'node:crypto'
import {parseHistoryYoutubeUrl} from './history-source-youtube-url.js'

export interface HistoryContinuousCollectionInput {
  source: 'youtube'; youtube: {urls: string[]}; targetCount: 1; existingSources: 'skip'
}
export interface HistoryContinuousSource {
  id: number; platform: string; deleted: boolean; revision: string; scriptHash: string | null
}
export interface HistoryContinuousPrepared { sourceId: number; revision: string; scriptHash: string }
export interface HistoryContinuousScope {
  sourceIds: number[]; scriptHashes: Record<string, string>
  members: Array<HistoryContinuousPrepared & {continuationTaskId: number}>
  assertCurrent: () => void
}
export interface HistoryContinuousProgress {
  sourceId: number; scriptHash: string; fingerprint: string
  motion: {state: 'pending' | 'active' | 'ready' | 'attention' | 'submitted' | 'published'; receiptId?: string | number}
  huashengState?: string
}
export interface HistoryContinuousOptions {
  database: Database.Database
  queueCollection: (input: HistoryContinuousCollectionInput) => {taskId: number}
  recoverCollection?: (taskId: number) => unknown
  source: (sourceId: number) => HistoryContinuousSource | null
  prepare: (input: {sourceId: number; intentId: string; expectedRevision: string; assertCurrent: () => void}) => Promise<HistoryContinuousPrepared>
  queueContinuation: (input: HistoryContinuousPrepared) => {taskId: number}
  observe: (scope: HistoryContinuousScope) => HistoryContinuousProgress[]
  // Adapters resume only original durable jobs and honor their existing request/lease guards.
  advance: (scope: HistoryContinuousScope) => Promise<void>
  now?: () => number; pid?: number; ownerAlive?: (pid: number) => boolean
}
export interface HistoryContinuousStart {
  requestId: string; settings: {youtubeUrls: string[]; maxPendingMotion?: number}
  sourceBaseline: number; taskBaseline: number
}
export interface HistoryContinuousMember {
  sourceId: number; revision: string; scriptHash: string | null; collectionTaskId: number
  phase: 'pending' | 'preparing' | 'admitted' | 'attention'
  prepareIntentId: string | null; continuationTaskId: number | null
  motionState: HistoryContinuousProgress['motion']['state']; motionReceiptId: string | number | null
  huashengState: string; fingerprint: string | null; message: string | null; updatedAt: number
}
export interface HistoryContinuousRun {
  version: 1; id: string; requestId: string; inputHash: string
  settings: {youtubeUrls: string[]; maxPendingMotion: number}; sourceBaseline: number; taskBaseline: number
  status: 'running' | 'paused'; createdAt: number; updatedAt: number
  collection: {taskId: number; state: 'observing' | 'settled' | 'attention'; message: string | null} | null
  nextCollectAt: number; collectionFailures: number; nextAdvanceAt: number; advanceFailures: number
  advanceInFlight: boolean; attention: string | null
}
export interface HistoryContinuousSnapshot extends HistoryContinuousRun { members: HistoryContinuousMember[]; busy?: boolean }
type Row = {id: string; snapshot: string; owner_pid: number | null; owner_token: string | null}
type Task = {id: number; type: string; status: string; payload_json: string | null; result_json: string | null; scope_id: number | null
  error_code: string | null; cancel_requested: number; completed_at: string | null; updated_at: string | null}
type Recovery = {attempts: number; next_attempt_at: number | null; state: string; failure_key: string}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const sha = /^[a-f0-9]{64}$/
const pollMs = 30_000
const recoveryDelays = [30_000, 60_000, 120_000]
const backoff = (attempts: number) => Math.min(30 * 60_000, pollMs * 2 ** Math.min(Math.max(attempts - 1, 0), 6))
const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 1500)
function requireValue(value: unknown, explanation: string): asserts value { if (!value) throw Error(explanation) }
function isAlive(pid: number) {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
function synchronous<T>(value: T): T {
  requireValue(!value || typeof (value as any).then !== 'function', 'Queue and observation dependencies must be synchronous')
  return value
}

export function createHistoryContinuousProduction(options: HistoryContinuousOptions) {
  const db = options.database, now = options.now || Date.now, pid = options.pid ?? process.pid
  requireValue(Number.isSafeInteger(pid) && pid > 0, 'A valid controller PID is required')
  db.exec(`CREATE TABLE IF NOT EXISTS history_continuous_production (
    id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,snapshot TEXT NOT NULL,owner_pid INTEGER,owner_token TEXT);
    CREATE TABLE IF NOT EXISTS history_continuous_members (
      run_id TEXT NOT NULL,source_id INTEGER NOT NULL UNIQUE,snapshot TEXT NOT NULL,PRIMARY KEY(run_id,source_id));
    CREATE TABLE IF NOT EXISTS history_continuous_collections (
      task_id INTEGER PRIMARY KEY,run_id TEXT NOT NULL,source_id INTEGER,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history_source_recovery (
      task_id INTEGER PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,
      state TEXT NOT NULL,failure_key TEXT NOT NULL,updated_at TEXT NOT NULL,last_error TEXT);`)

  function row(id: string) {
    const value = db.prepare('SELECT * FROM history_continuous_production WHERE id=?').get(id) as Row | undefined
    requireValue(value, 'Continuous history run does not exist'); return value
  }
  const read = (id: string) => JSON.parse(row(id).snapshot) as HistoryContinuousRun
  function members(id: string) {
    return (db.prepare('SELECT snapshot FROM history_continuous_members WHERE run_id=? ORDER BY source_id').all(id) as {snapshot: string}[])
      .map(item => JSON.parse(item.snapshot) as HistoryContinuousMember)
  }
  function detail(id: string): HistoryContinuousSnapshot { return {...read(id), members: members(id)} }
  function owned(id: string, token: string) {
    const record = row(id), run = JSON.parse(record.snapshot) as HistoryContinuousRun
    requireValue(record.owner_token === token && record.owner_pid === pid && run.status === 'running', 'Continuous history owner or stop fence changed')
    return run
  }
  function save(run: HistoryContinuousRun, token?: string) {
    run.updatedAt = now()
    const result = token === undefined
      ? db.prepare('UPDATE history_continuous_production SET snapshot=? WHERE id=?').run(JSON.stringify(run), run.id)
      : db.prepare('UPDATE history_continuous_production SET snapshot=? WHERE id=? AND owner_token=? AND owner_pid=?')
        .run(JSON.stringify(run), run.id, token, pid)
    requireValue(result.changes === 1, 'Continuous history write lost its owner fence')
  }
  function saveMember(id: string, member: HistoryContinuousMember) {
    member.updatedAt = now()
    db.prepare(`INSERT INTO history_continuous_members VALUES(?,?,?) ON CONFLICT(run_id,source_id)
      DO UPDATE SET snapshot=excluded.snapshot`).run(id, member.sourceId, JSON.stringify(member))
  }
  function task(id: number) {
    return db.prepare(`SELECT id,type,status,payload_json,result_json,scope_id,error_code,cancel_requested,completed_at,updated_at
      FROM creation_tasks WHERE id=?`).get(id) as Task | undefined
  }
  function source(id: number) {
    const value = synchronous(options.source(id))
    requireValue(value && value.id === id && value.platform === 'youtube' && !value.deleted, 'Original YouTube source was deleted or changed')
    requireValue(typeof value.revision === 'string' && value.revision.length > 0, 'Source revision is missing')
    requireValue(value.scriptHash === null || sha.test(value.scriptHash), 'Source script fingerprint is invalid')
    return value
  }
  function checkMember(member: HistoryContinuousMember) {
    const current = source(member.sourceId)
    requireValue(current.scriptHash === member.scriptHash && (member.phase === 'admitted' || current.revision === member.revision), 'Original admitted source or script changed')
    return current
  }
  function markAttention(id: string, token: string, member: HistoryContinuousMember, error: unknown) {
    db.transaction(() => {
      const run = owned(id, token)
      const record = db.prepare('SELECT snapshot FROM history_continuous_members WHERE run_id=? AND source_id=?').get(id, member.sourceId) as {snapshot: string} | undefined
      requireValue(record, 'Original member checkpoint is missing')
      // A failed admission may have mutated its local object before SQLite rolled back.
      const saved = JSON.parse(record.snapshot) as HistoryContinuousMember
      saved.phase = 'attention'; saved.message = message(error); saveMember(id, saved)
      run.attention = saved.message; save(run, token)
    }).immediate()
  }

  function start(input: HistoryContinuousStart) {
    requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.requestId), 'A stable requestId is required')
    requireValue(Number.isSafeInteger(input.sourceBaseline) && input.sourceBaseline >= 0, 'An explicit source baseline is required')
    requireValue(Number.isSafeInteger(input.taskBaseline) && input.taskBaseline >= 40400, 'The explicit new-task baseline must be at least 40400')
    const urls = input.settings?.youtubeUrls
    requireValue(Array.isArray(urls) && urls.length > 0 && urls.length <= 30, 'Explicit YouTube URLs are required')
    for (const url of urls) parseHistoryYoutubeUrl(url)
    requireValue(new Set(urls).size === urls.length, 'YouTube URLs must not repeat')
    const maxPendingMotion = input.settings.maxPendingMotion ?? 2
    requireValue(Number.isInteger(maxPendingMotion) && maxPendingMotion >= 1 && maxPendingMotion <= 8, 'Motion inventory limit must be between 1 and 8')
    const settings = {youtubeUrls: urls.map(value => parseHistoryYoutubeUrl(value).url), maxPendingMotion}, inputHash = hash(JSON.stringify({requestId: input.requestId,
      settings, sourceBaseline: input.sourceBaseline, taskBaseline: input.taskBaseline}))
    return db.transaction(() => {
      const existing = db.prepare('SELECT id,snapshot FROM history_continuous_production WHERE request_id=?').get(input.requestId) as Row | undefined
      if (existing) {
        requireValue((JSON.parse(existing.snapshot) as HistoryContinuousRun).inputHash === inputHash, 'requestId was already used with different settings or baselines')
        return detail(existing.id)
      }
      // One durable supply loop owns the global inventory; a new start cannot bypass a paused run.
      requireValue(!db.prepare('SELECT 1 FROM history_continuous_production LIMIT 1').get(), 'An original continuous history run already exists; use its original ID')
      const run: HistoryContinuousRun = {version: 1, id: `history-continuous-${randomUUID()}`, requestId: input.requestId, inputHash,
        settings, sourceBaseline: input.sourceBaseline, taskBaseline: input.taskBaseline, status: 'running', createdAt: now(), updatedAt: now(),
        collection: null, nextCollectAt: 0, collectionFailures: 0, nextAdvanceAt: 0, advanceFailures: 0, advanceInFlight: false, attention: null}
      db.prepare('INSERT INTO history_continuous_production VALUES(?,?,?,NULL,NULL)').run(run.id, run.requestId, JSON.stringify(run))
      return detail(run.id)
    }).immediate()
  }
  function stop(id: string) {
    return db.transaction(() => {
      const run = read(id); run.status = 'paused'; save(run)
      db.prepare('UPDATE history_continuous_production SET owner_pid=NULL,owner_token=NULL WHERE id=?').run(id)
      return detail(id)
    }).immediate()
  }
  function resume(id: string) {
    return db.transaction(() => { const run = read(id); run.status = 'running'; save(run); return detail(id) }).immediate()
  }
  function claim(id: string) {
    return db.transaction(() => {
      const record = row(id), run = JSON.parse(record.snapshot) as HistoryContinuousRun
      if (run.status !== 'running') return null
      if (record.owner_token && record.owner_pid !== null) {
        let alive = true
        try { alive = (options.ownerAlive || isAlive)(record.owner_pid) !== false } catch { /* Unknown liveness never revokes a live owner. */ }
        if (alive) return null
      }
      const token = randomUUID()
      db.prepare('UPDATE history_continuous_production SET owner_pid=?,owner_token=? WHERE id=?').run(pid, token, id)
      return token
    }).immediate()
  }

  function recoverRateLimitedCollection(run: HistoryContinuousRun, token: string, original: Task) {
    const pointer = run.collection!, timestamp = now(), iso = new Date(timestamp).toISOString()
    const payload = JSON.parse(original.payload_json || 'null')
    requireValue(original.id === pointer.taskId && original.id > run.taskBaseline
      && db.prepare('SELECT 1 FROM history_continuous_collections WHERE task_id=? AND run_id=?').get(original.id, run.id)
      && payload?.source === 'youtube' && payload.targetCount === 1 && payload.existingSources === 'skip'
      && JSON.stringify(payload.youtube?.urls) === JSON.stringify(run.settings.youtubeUrls), 'Original collection recovery lacks its matching task and run membership')
    const failureKey = original.completed_at || original.updated_at
    requireValue(failureKey && Number.isFinite(Date.parse(failureKey)) && Date.parse(failureKey) <= timestamp, 'Original collection rate-limit timestamp is invalid')
    const previous = db.prepare('SELECT attempts,next_attempt_at,state,failure_key FROM history_source_recovery WHERE task_id=?')
      .get(original.id) as Recovery | undefined
    const attempts = previous?.attempts ?? 0
    if (attempts >= recoveryDelays.length) {
      db.prepare("UPDATE history_source_recovery SET state='exhausted',next_attempt_at=NULL,updated_at=? WHERE task_id=?").run(iso, original.id)
      pointer.state = 'attention'; pointer.message = 'Original collection recovery budget exhausted; retain this task for attention'
      db.prepare("UPDATE history_continuous_collections SET state='attention' WHERE task_id=? AND run_id=?").run(original.id, run.id)
      run.attention = pointer.message
      return
    }
    if (previous?.state !== 'scheduled' || previous.failure_key !== failureKey) {
      const event = db.prepare("SELECT data_json FROM creation_task_events WHERE task_id=? AND event_type='history.rate_limit' ORDER BY id DESC LIMIT 1")
        .get(original.id) as {data_json: string} | undefined
      let retryAfter = 0
      try {
        const value = JSON.parse(event?.data_json || '{}').retryAfterMs
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) retryAfter = value
      } catch { /* Older rate-limit events may omit a structured delay. */ }
      run.nextCollectAt = timestamp + Math.max(recoveryDelays[attempts]!, retryAfter)
      db.prepare(`INSERT INTO history_source_recovery(task_id,attempts,next_attempt_at,state,failure_key,updated_at)
        VALUES(?,?,?,'scheduled',?,?) ON CONFLICT(task_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,
        state=excluded.state,failure_key=excluded.failure_key,updated_at=excluded.updated_at,last_error=NULL`)
        .run(original.id, attempts, run.nextCollectAt, failureKey, iso)
      pointer.state = 'observing'; pointer.message = 'Original rate-limited collection recovery scheduled after durable backoff'
      db.prepare("UPDATE history_continuous_collections SET state='observing' WHERE task_id=? AND run_id=?").run(original.id, run.id)
      return
    }
    if (timestamp < previous.next_attempt_at!) { run.nextCollectAt = previous.next_attempt_at!; return }
    if (db.prepare("SELECT 1 FROM creation_tasks WHERE type='history.source' AND status IN ('queued','running') LIMIT 1").get()) {
      run.nextCollectAt = timestamp + pollMs
      return
    }
    // A nested savepoint rolls back both the task resume and retry budget if either fails.
    db.transaction(() => {
      owned(run.id, token)
      synchronous(options.recoverCollection!(original.id))
      const resumed = task(original.id), current = owned(run.id, token)
      requireValue(current.collection?.taskId === original.id && resumed?.type === 'history.source'
        && ['queued', 'running'].includes(resumed.status) && !resumed.cancel_requested
        && resumed.payload_json === original.payload_json, 'Collection recovery did not queue the original task')
      db.prepare("UPDATE history_source_recovery SET attempts=attempts+1,state='resumed',next_attempt_at=NULL,updated_at=?,last_error=NULL WHERE task_id=?")
        .run(iso, original.id)
      db.prepare("UPDATE history_continuous_collections SET state='observing' WHERE task_id=? AND run_id=?").run(original.id, run.id)
      if (run.attention === pointer.message) run.attention = null
      pointer.state = 'observing'; pointer.message = null; run.collectionFailures = 0; run.nextCollectAt = timestamp
    }).immediate()
  }

  function settleCollection(id: string, token: string) {
    db.transaction(() => {
      const run = owned(id, token), pointer = run.collection
      if (!pointer || pointer.state === 'settled' || now() < run.nextCollectAt) return
      const original = task(pointer.taskId)
      if (original && ['queued', 'running', 'waiting', 'blocked'].includes(original.status)) return
      let error: string | null = null
      if (!original || original.type !== 'history.source' || original.status !== 'succeeded') {
        if (original?.type === 'history.source' && original.status === 'failed' && original.error_code === 'history_source_rate_limited'
          && !original.cancel_requested && options.recoverCollection) {
          try { recoverRateLimitedCollection(run, token, original) } catch (failure) { error = message(failure) }
        } else error = 'Original collection result is unknown or unsuccessful; observe or recover that same task'
      } else {
        let result: any
        try { result = JSON.parse(original.result_json || 'null') } catch { /* Keep the original pointer until its real result can be read. */ }
        if (!result || !Array.isArray(result.sourceIds) || result.sourceIds.some((value: unknown) => !Number.isSafeInteger(value) || Number(value) <= 0)) {
          error = 'Original collection has no valid result; its task will not be replaced'
        } else {
          const fresh = [...new Set<number>(result.sourceIds)].filter(value => value > run.sourceBaseline)
          const proof = db.prepare(`SELECT 1 FROM creation_task_events WHERE task_id=? AND event_type='history.progress'
            AND CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.currentSourceId') END=? LIMIT 1`)
          if (fresh.some(value => !proof.get(pointer.taskId, value))) error = 'Collection membership lacks exact original progress evidence'
          else {
            try {
              const valid = fresh.map(value => source(value)).filter(value => value.scriptHash !== null)
              requireValue(valid.length <= 1, 'Original collection returned more than one valid new script')
              const current = valid[0]
              if (current) {
                const member: HistoryContinuousMember = {sourceId: current.id, revision: current.revision, scriptHash: current.scriptHash,
                  collectionTaskId: pointer.taskId, phase: 'pending', prepareIntentId: null, continuationTaskId: null,
                  motionState: 'pending', motionReceiptId: null, huashengState: 'pending', fingerprint: null, message: null, updatedAt: now()}
                const previous = members(id).find(item => item.sourceId === current.id)
                requireValue(!previous || previous.collectionTaskId === pointer.taskId, 'Source belongs to an earlier collection')
                if (!previous) saveMember(id, member)
                pointer.state = 'settled'; pointer.message = null; run.collectionFailures = 0; run.nextCollectAt = now()
                db.prepare("UPDATE history_continuous_collections SET state='settled',source_id=? WHERE task_id=? AND run_id=?").run(current.id, pointer.taskId, id)
              } else {
                pointer.state = 'settled'; pointer.message = 'Original collection completed without a valid new script'
                run.collectionFailures = Math.min(run.collectionFailures + 1, 16); run.nextCollectAt = now() + backoff(run.collectionFailures)
                db.prepare("UPDATE history_continuous_collections SET state='settled' WHERE task_id=? AND run_id=?").run(pointer.taskId, id)
              }
            } catch (failure) { error = message(failure) }
          }
        }
      }
      if (error) {
        pointer.state = 'attention'; pointer.message = error; run.attention = error
        run.collectionFailures = Math.min(run.collectionFailures + 1, 16); run.nextCollectAt = now() + backoff(run.collectionFailures)
        db.prepare("UPDATE history_continuous_collections SET state='attention' WHERE task_id=? AND run_id=?").run(pointer.taskId, id)
      }
      save(run, token)
    }).immediate()
  }

  async function prepareOne(id: string, token: string) {
    const member = members(id).find(item => item.phase === 'pending' || item.phase === 'preparing')
    if (!member) return
    if (member.phase === 'preparing') {
      markAttention(id, token, member, 'Original preparation outcome is unknown; preserve its intent and source without resubmission'); return
    }
    try {
      db.transaction(() => {
        owned(id, token); checkMember(member)
        member.phase = 'preparing'; member.prepareIntentId = randomUUID(); saveMember(id, member)
      }).immediate()
      const assertCurrent = () => { owned(id, token); checkMember(member) }
      const prepared = await options.prepare({sourceId: member.sourceId, intentId: member.prepareIntentId!, expectedRevision: member.revision, assertCurrent})
      db.transaction(() => {
        const run = owned(id, token), current = source(member.sourceId)
        requireValue(prepared.sourceId === member.sourceId && sha.test(prepared.scriptHash)
          && prepared.scriptHash === current.scriptHash && prepared.revision === current.revision, 'Prepared script changed before admission')
        const queued = synchronous(options.queueContinuation(prepared)), original = task(queued.taskId)
        const payload = original && JSON.parse(original.payload_json || 'null')
        requireValue(original && original.id > run.taskBaseline && original.type === 'history.production.continue'
          && original.scope_id === member.sourceId && payload?.sourceId === member.sourceId
          && payload.scriptSha256 === prepared.scriptHash, 'Original continuation task does not match the prepared source/hash')
        member.revision = prepared.revision; member.scriptHash = prepared.scriptHash
        member.phase = 'admitted'; member.continuationTaskId = queued.taskId; member.message = null
        saveMember(id, member)
      }).immediate()
    } catch (error) {
      if (row(id).owner_token === token && read(id).status === 'running') markAttention(id, token, member, error)
    }
  }
  function currentScope(id: string, token: string) {
    const valid: HistoryContinuousMember[] = []
    for (const member of members(id).sort((a, b) => Number(a.motionReceiptId !== null) - Number(b.motionReceiptId !== null))) {
      if (member.phase !== 'admitted' || member.motionReceiptId !== null && ['completed', 'attention', 'failed', 'canceled'].includes(member.huashengState)) continue
      try { checkMember(member); valid.push(member) } catch (error) { markAttention(id, token, member, error) }
      if (valid.length === 8) break
    }
    const selected = valid.sort((a, b) => Number(a.motionReceiptId !== null) - Number(b.motionReceiptId !== null))
    const scope: HistoryContinuousScope = {sourceIds: selected.map(member => member.sourceId),
      scriptHashes: Object.fromEntries(selected.map(member => [member.sourceId, member.scriptHash!])),
      members: selected.map(member => ({sourceId: member.sourceId, scriptHash: member.scriptHash!, revision: member.revision,
        continuationTaskId: member.continuationTaskId!})), assertCurrent: () => {
        owned(id, token)
        for (const member of selected) checkMember(member)
      }}
    return scope
  }
  async function advance(id: string, token: string) {
    let scope = currentScope(id, token)
    if (!scope.sourceIds.length) return
    scope.assertCurrent()
    const progress = synchronous(options.observe(scope))
    requireValue(Array.isArray(progress) && progress.length === scope.members.length, 'Each scoped member needs one original progress observation')
    db.transaction(() => {
      const run = owned(id, token), seen = new Set<number>()
      for (const item of progress) {
        requireValue(scope.scriptHashes[item.sourceId] === item.scriptHash && !seen.has(item.sourceId), 'Observed progress is outside the explicit source/hash scope')
        requireValue(typeof item.fingerprint === 'string' && item.fingerprint.length > 0, 'Original progress fingerprint is required')
        requireValue(['pending', 'active', 'ready', 'attention', 'submitted', 'published'].includes(item.motion?.state), 'Original Motion state is invalid')
        seen.add(item.sourceId)
        const member = members(id).find(value => value.sourceId === item.sourceId)!
        checkMember(member)
        member.motionState = item.motion.state; member.huashengState = item.huashengState ?? member.huashengState; member.fingerprint = item.fingerprint
        if (['submitted', 'published'].includes(item.motion.state)) {
          requireValue(typeof item.motion.receiptId === 'string' && item.motion.receiptId.length > 0
            || typeof item.motion.receiptId === 'number' && Number.isSafeInteger(item.motion.receiptId) && item.motion.receiptId > 0, 'Validated original Motion submission receipt is required')
          member.motionReceiptId ??= item.motion.receiptId!
        }
        saveMember(id, member)
      }
      // A crashed prior pass is observed first; only existing idempotent handlers run below.
      if (run.advanceInFlight) { run.advanceInFlight = false; run.attention = 'Previous advance outcome is being reconciled through its original jobs' }
      save(run, token)
    }).immediate()
    if (now() < owned(id, token).nextAdvanceAt) return
    scope = currentScope(id, token)
    if (!scope.sourceIds.length) return
    db.transaction(() => { const run = owned(id, token); run.advanceInFlight = true; run.nextAdvanceAt = now() + pollMs; save(run, token) }).immediate()
    try {
      scope.assertCurrent(); await options.advance(scope); scope.assertCurrent()
      db.transaction(() => { const run = owned(id, token); run.advanceInFlight = false; run.advanceFailures = 0; run.nextAdvanceAt = now() + pollMs; save(run, token) }).immediate()
    } catch (error) {
      if (row(id).owner_token !== token || read(id).status !== 'running') return
      db.transaction(() => {
        const run = owned(id, token); run.advanceInFlight = false; run.advanceFailures = Math.min(run.advanceFailures + 1, 16)
        run.nextAdvanceAt = now() + backoff(run.advanceFailures); run.attention = message(error); save(run, token)
      }).immediate()
    }
  }
  function collect(id: string, token: string) {
    db.transaction(() => {
      const run = owned(id, token)
      if (now() < run.nextCollectAt || run.collection && run.collection.state !== 'settled') return
      const pending = members(id).filter(member => member.motionReceiptId === null).length
      if (pending >= run.settings.maxPendingMotion) return
      const input: HistoryContinuousCollectionInput = {source: 'youtube', youtube: {urls: [...run.settings.youtubeUrls]}, targetCount: 1, existingSources: 'skip'}
      const before = (db.prepare('SELECT MAX(id) AS id FROM creation_tasks').get() as {id: number | null}).id ?? 0
      const queued = synchronous(options.queueCollection(input)), original = task(queued.taskId)
      const payload = original && JSON.parse(original.payload_json || 'null')
      requireValue(original && original.type === 'history.source' && original.id > Math.max(before, run.taskBaseline)
        && original.status === 'queued' && payload?.source === 'youtube' && payload.targetCount === 1 && payload.existingSources === 'skip'
        && JSON.stringify(payload.youtube?.urls) === JSON.stringify(input.youtube.urls), 'Collection must queue a new matching task in this same transaction')
      db.prepare("INSERT INTO history_continuous_collections VALUES(?,?,NULL,'observing')").run(queued.taskId, id)
      run.collection = {taskId: queued.taskId, state: 'observing', message: null}; run.nextCollectAt = now(); save(run, token)
    }).immediate()
  }
  async function tick(id: string): Promise<HistoryContinuousSnapshot> {
    const token = claim(id)
    if (!token) return {...detail(id), busy: read(id).status === 'running'}
    try {
      settleCollection(id, token)
      await prepareOne(id, token)
      if (row(id).owner_token !== token || read(id).status !== 'running') return detail(id)
      await advance(id, token)
      if (row(id).owner_token !== token || read(id).status !== 'running') return detail(id)
      try { collect(id, token) }
      catch (error) {
        db.transaction(() => {
          const run = owned(id, token); run.collectionFailures = Math.min(run.collectionFailures + 1, 16)
          run.nextCollectAt = now() + backoff(run.collectionFailures); run.attention = message(error); save(run, token)
        }).immediate()
      }
      return detail(id)
    } finally {
      db.prepare('UPDATE history_continuous_production SET owner_pid=NULL,owner_token=NULL WHERE id=? AND owner_token=? AND owner_pid=?').run(id, token, pid)
    }
  }
  return {start, tick, stop, resume, detail}
}
