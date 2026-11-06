import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'

const defaultDatabase = fileURLToPath(new URL('../../data/huobao_drama.db', import.meta.url))
const usage = 'Usage: node scripts/reload-main-when-idle.mjs --expected-pid PID --state FILE [--db FILE] [--apply]'
export function parseReloadOptions(args) {
  const options = { apply: false, databasePath: process.env.DB_PATH || defaultDatabase }
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--apply') options.apply = true
    else if (['--expected-pid', '--state', '--db'].includes(key) && args[index + 1] && !args[index + 1].startsWith('--')) {
      options[{ '--expected-pid': 'expectedPid', '--state': 'stateFile', '--db': 'databasePath' }[key]] = args[++index]
    } else throw Error(usage)
  }
  options.expectedPid = Number(options.expectedPid)
  if (!Number.isSafeInteger(options.expectedPid) || options.expectedPid < 1 || !options.stateFile) throw Error(usage)
  options.stateFile = path.resolve(options.stateFile)
  return options
}

export function mainListenerPid() {
  let output
  try { output = execFileSync('/usr/sbin/lsof', ['-nP', '-t', '-iTCP:5679', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { if (error.status === 1 && !String(error.stdout || '').trim()) return null; throw error }
  const pids = [...new Set(output.trim().split(/\s+/).filter(Boolean).map(Number))]
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] < 1) throw Error('ambiguous_listener')
  return pids[0]
}

export function inspectMainWork(databasePath, pid, now = Date.now()) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    if (!exists('history_motion_productions') || !exists('creation_tasks')) throw Error('missing_task_schema')
    const busy = []
    const count = (kind, query, parameters = []) => { const value = db.prepare(query).get(...parameters).count; if (value) busy.push({ kind, count: value }) }
    count('history_motion', "SELECT count(*) AS count FROM history_motion_productions WHERE status IN ('queued','planning','selecting','rendering','validating')")
    const heartbeatOwner = exists('worker_heartbeats') ? ' OR lease_owner IN (SELECT worker_id FROM worker_heartbeats WHERE pid=?)' : ''
    count('creation_tasks', `SELECT count(*) AS count FROM creation_tasks WHERE status='running'
      AND (lease_owner IS NULL OR lease_owner='' OR lease_owner LIKE ?${heartbeatOwner})`, [`%-${pid}`, ...(heartbeatOwner ? [pid] : [])])
    for (const [table, states] of [
      ['history_huasheng_jobs', ['running']],
      ['history_huasheng_export_jobs', ['exporting', 'downloading', 'processing']],
      ['history_social_upload_jobs', ['running']],
    ]) if (exists(table)) count(table, `SELECT count(*) AS count FROM ${table} WHERE status IN (${states.map(() => '?').join(',')})`, states)
    for (const table of ['history_huasheng_lease', 'history_huasheng_inspection_lease']) {
      if (exists(table)) count(table, `SELECT count(*) AS count FROM ${table} WHERE pid=? AND expires_at>?`, [pid, now])
    }
    return busy
  } finally { db.close() }
}

// This is a one-shot observation, not an atomic admission drain; run it during a quiet window.
export function reloadMainWhenIdle(options, dependencies = {}) {
  const listenPid = dependencies.listenPid || mainListenerPid
  const inspect = dependencies.inspect || inspectMainWork
  const kickstart = dependencies.kickstart || (() => execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.huobao-drama.backend`], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }))
  const { stateFile, expectedPid, databasePath, apply = false } = options
  if (!Number.isSafeInteger(expectedPid) || expectedPid < 1 || !stateFile) throw Error(usage)
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 })
  const save = value => {
    const state = { expectedPid, apply, checkedAt: new Date().toISOString(), ...value }
    const temporary = `${stateFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, stateFile)
    return state
  }
  let previous = {}
  try {
    previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
    if (previous.expectedPid && previous.expectedPid !== expectedPid) throw Error('state_pid_mismatch')
    if (previous.status === 'completed') return previous
    const currentPid = listenPid()
    if (currentPid && currentPid !== expectedPid) return save({ status: 'completed', currentPid, idleChecks: 0, reason: 'pid_changed' })
    if (!currentPid) return save({ status: 'waiting', currentPid, idleChecks: 0, reason: 'listener_missing' })
    const claim = `${stateFile}.requested`
    if (fs.existsSync(claim)) return save({ status: previous.status === 'error' ? 'error' : 'waiting', currentPid, idleChecks: 0, reason: 'reload_already_requested' })
    const busy = inspect(databasePath, expectedPid)
    if (busy.length) return save({ status: 'waiting', currentPid, idleChecks: 0, reason: 'busy', busy })
    const idleChecks = previous.status === 'waiting' && previous.reason === 'idle' && previous.apply === apply && [1, 2].includes(previous.idleChecks) ? 2 : 1
    if (idleChecks < 2 || !apply) return save({ status: 'waiting', currentPid, idleChecks, reason: 'idle', dryRun: !apply })
    const finalPid = listenPid()
    if (finalPid !== expectedPid) return save({ status: finalPid ? 'completed' : 'waiting', currentPid: finalPid, idleChecks: 0, reason: finalPid ? 'pid_changed' : 'listener_missing' })
    // Claim before invoking launchctl: even an ambiguous failure must never repeat a restart.
    try { fs.writeFileSync(claim, JSON.stringify({ expectedPid, requestedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error.code === 'EEXIST') return save({ status: 'waiting', currentPid, idleChecks: 0, reason: 'reload_already_requested' }); throw error }
    save({ status: 'waiting', currentPid, idleChecks, reason: 'reload_requested' })
    kickstart()
    return save({ status: 'waiting', currentPid, idleChecks, reason: 'reload_requested' })
  } catch (error) {
    return save({ expectedPid: previous?.expectedPid || expectedPid, status: 'error', idleChecks: 0, reason: 'check_or_reload_failed', error: error.code || (error.message === 'state_pid_mismatch' ? error.message : 'operation_failed') })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = reloadMainWhenIdle(parseReloadOptions(process.argv.slice(2)))
    console.log(JSON.stringify(result))
    if (result.status === 'error') process.exitCode = 1
  } catch { console.error(usage); process.exitCode = 1 }
}
