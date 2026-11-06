import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export interface AIProviderIdentity { endpoint: string; apiKey: string }
export interface AIProviderLease { defer(retryAfterMs?: number): Promise<void> }
interface AdmissionOptions {
  filename: string
  maxConcurrency?: number
  maxWaitMs?: number
  pollMs?: number
  leaseMs?: number
  now?: () => number
}
interface RequestOptions { signal?: AbortSignal; maxConcurrency?: number; maxWaitMs?: number }
type Ticket = { id: string; pid: number; state: string; expires_at: number; max_concurrency: number }

export class AIProviderAdmissionError extends Error {
  readonly status = 429
  readonly source = 'local_admission'
  readonly upstreamDispatched = false
  constructor(readonly code: 'AI_TEXT_ADMISSION_TIMEOUT' | 'AI_TEXT_ADMISSION_UNAVAILABLE', readonly retryAfterMs: number) {
    super(code === 'AI_TEXT_ADMISSION_TIMEOUT'
      ? '文本服务请求容量暂满，等待已达上限；请求尚未发送，已保留当前检查点'
      : '文本服务本机排队协调暂不可用；请求尚未发送，已保留当前检查点')
    this.name = 'AIProviderAdmissionError'
  }
}

export function providerAdmissionKey(identity: AIProviderIdentity) {
  const url = new URL(identity.endpoint)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return createHash('sha256').update(JSON.stringify([url.href, identity.apiKey])).digest('hex')
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}
function isBusy(error: unknown) {
  return !!error && typeof error === 'object' && ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String((error as {code?: unknown}).code))
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** This small database is separate from production snapshots and contains no request content. */
export function createAIProviderAdmission(options: AdmissionOptions) {
  fs.mkdirSync(path.dirname(options.filename), { recursive: true })
  const database = new Database(options.filename, { timeout: 100 })
  database.pragma('journal_mode = WAL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS ai_provider_requests (
      ticket INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
      pid INTEGER NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, max_concurrency INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_provider_request_scope ON ai_provider_requests(scope,state,ticket);
    CREATE TABLE IF NOT EXISTS ai_provider_cooldowns (scope TEXT PRIMARY KEY,retry_at INTEGER NOT NULL);
  `)
  const now = options.now ?? Date.now
  const maximum = positiveInteger(options.maxConcurrency, 2, 32)
  const maxWait = positiveInteger(options.maxWaitMs, 300_000, 1_800_000)
  const pollMs = positiveInteger(options.pollMs, 100, 1000)
  const leaseMs = positiveInteger(options.leaseMs, 120_000, 3_600_000)
  let running = 0
  const pendingReleases = new Set<string>()
  const insert = database.prepare(`INSERT INTO ai_provider_requests(id,scope,pid,state,expires_at,max_concurrency)
    VALUES(?,?,?,'waiting',?,?)`)
  const remove = database.prepare('DELETE FROM ai_provider_requests WHERE id=?')
  const renew = database.prepare("UPDATE ai_provider_requests SET expires_at=? WHERE id=? AND state='active'")
  const cooldown = database.prepare(`INSERT INTO ai_provider_cooldowns(scope,retry_at) VALUES(?,?)
    ON CONFLICT(scope) DO UPDATE SET retry_at=max(retry_at,excluded.retry_at)`)
  const admit = database.transaction((scope: string, id: string, current: number) => {
    for (const releasedId of pendingReleases) remove.run(releasedId)
    database.prepare("DELETE FROM ai_provider_requests WHERE state='waiting' AND expires_at<=?").run(current)
    const tickets = database.prepare('SELECT id,pid,state,expires_at,max_concurrency FROM ai_provider_requests WHERE scope=? ORDER BY ticket')
      .all(scope) as Ticket[]
    // Do not oversubscribe when a live process briefly stalls its heartbeat.
    // A crashed active request keeps its grace lease before capacity is reused.
    const abandoned = new Set(tickets.filter(ticket => ticket.pid !== process.pid && !alive(ticket.pid)
      && (ticket.state === 'waiting' || ticket.expires_at <= current)).map(ticket => ticket.id))
    for (const abandonedId of abandoned) remove.run(abandonedId)
    const live = tickets.filter(ticket => !abandoned.has(ticket.id))
    const retryAt = (database.prepare('SELECT retry_at FROM ai_provider_cooldowns WHERE scope=?').get(scope) as {retry_at: number} | undefined)?.retry_at ?? 0
    if (retryAt > current) return { granted: false, retryAfterMs: retryAt - current }
    const active = live.filter(ticket => ticket.state === 'active').length
    const capacity = Math.min(...live.map(ticket => ticket.max_concurrency))
    const position = live.filter(ticket => ticket.state === 'waiting').findIndex(ticket => ticket.id === id)
    if (position < 0 || position >= capacity - active) return { granted: false, retryAfterMs: pollMs }
    database.prepare("UPDATE ai_provider_requests SET state='active',expires_at=? WHERE id=? AND state='waiting'").run(current + leaseMs, id)
    return { granted: true, retryAfterMs: 0 }
  })
  async function write<T>(operation: () => T, deadline: number, signal?: AbortSignal): Promise<T> {
    for (;;) {
      signal?.throwIfAborted()
      try { return operation() }
      catch (error) {
        if (!isBusy(error) || now() >= deadline) throw error
        await delay(pollMs, undefined, { signal })
      }
    }
  }
  return {
    async run<T>(identity: AIProviderIdentity, work: (lease: AIProviderLease) => Promise<T>, request: RequestOptions = {}): Promise<T> {
      request.signal?.throwIfAborted()
      const scope = providerAdmissionKey(identity), id = randomUUID()
      const deadline = now() + positiveInteger(request.maxWaitMs, maxWait, 1_800_000)
      const capacity = positiveInteger(request.maxConcurrency, maximum, 32)
      let timer: ReturnType<typeof setInterval> | undefined
      let lastRetryAfterMs = pollMs
      running++
      try {
        try { await write(() => insert.run(id, scope, process.pid, deadline, capacity), deadline, request.signal) }
        catch (error) {
          request.signal?.throwIfAborted()
          throw new AIProviderAdmissionError('AI_TEXT_ADMISSION_UNAVAILABLE', 1000)
        }
        for (;;) {
          request.signal?.throwIfAborted()
          if (now() >= deadline) throw new AIProviderAdmissionError('AI_TEXT_ADMISSION_TIMEOUT', Math.max(1, lastRetryAfterMs))
          let state: {granted: boolean; retryAfterMs: number}
          try {
            state = admit.immediate(scope, id, now())
            // A rollback restores released rows, so forget retries only after commit.
            pendingReleases.clear()
          }
          catch (error) {
            if (!isBusy(error)) throw new AIProviderAdmissionError('AI_TEXT_ADMISSION_UNAVAILABLE', 1000)
            state = { granted: false, retryAfterMs: pollMs }
          }
          if (state.granted) break
          lastRetryAfterMs = state.retryAfterMs
          await delay(Math.max(1, Math.min(pollMs, deadline - now())), undefined, { signal: request.signal })
        }
        request.signal?.throwIfAborted()
        timer = setInterval(() => {
          try { renew.run(now() + leaseMs, id) }
          catch { console.warn('[ai-admission] lease heartbeat delayed') }
        }, Math.max(1, Math.floor(leaseMs / 3)))
        timer.unref()
        return await work({
          async defer(retryAfterMs = 10_000) {
            if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) retryAfterMs = 10_000
            const retryAt = now() + Math.min(retryAfterMs, 86_400_000)
            await write(() => cooldown.run(scope, retryAt), now() + 5000)
          },
        })
      } finally {
        if (timer) clearInterval(timer)
        try { await write(() => remove.run(id), now() + 5000) }
        catch {
          pendingReleases.add(id)
          console.warn('[ai-admission] lease release delayed; the next admission will retry it')
        }
        running--
      }
    },
    close() {
      if (running) throw new Error('Cannot close text admission while requests are running')
      database.close()
    },
  }
}

let defaultCoordinator: ReturnType<typeof createAIProviderAdmission> | undefined
export function getAIProviderAdmission() {
  if (!defaultCoordinator) {
    const defaultDatabase = fileURLToPath(new URL('../../../data/huobao_drama.db', import.meta.url))
    const filename = process.env.AI_TEXT_ADMISSION_DB_PATH
      || (process.env.DB_PATH === ':memory:' ? ':memory:' : `${process.env.DB_PATH || defaultDatabase}.ai-admission.db`)
    try { defaultCoordinator = createAIProviderAdmission({ filename: filename === ':memory:' ? filename : path.resolve(filename) }) }
    catch { throw new AIProviderAdmissionError('AI_TEXT_ADMISSION_UNAVAILABLE', 1000) }
  }
  return defaultCoordinator
}
export function closeAIProviderAdmission() { defaultCoordinator?.close(); defaultCoordinator = undefined }

export function getTextAdmissionOptions(settings?: string | Record<string, unknown> | null) {
  let parsed: Record<string, unknown> = {}
  try {
    const value = typeof settings === 'string' ? JSON.parse(settings) : settings
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value
  } catch { /* Existing invalid provider settings keep the conservative defaults. */ }
  return {
    maxConcurrency: positiveInteger(parsed.textMaxConcurrency ?? process.env.AI_TEXT_MAX_CONCURRENCY, 2, 32),
    maxWaitMs: positiveInteger(parsed.textAdmissionMaxWaitMs ?? process.env.AI_TEXT_ADMISSION_MAX_WAIT_MS, 300_000, 1_800_000),
  }
}
