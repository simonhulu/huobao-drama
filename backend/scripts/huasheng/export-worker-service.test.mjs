import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVICE_LABEL, createServiceConfig, manageExportWorkerService, serviceMain } from './export-worker-service.mjs'

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'export-agent-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const projectRoot = path.join(directory, "project with spaces & 'quotes'")
  const homeDirectory = path.join(directory, 'user home')
  for (const subdirectory of ['backend/scripts/huasheng', 'backend/node_modules/tsx', 'data']) mkdirSync(path.join(projectRoot, subdirectory), { recursive: true })
  writeFileSync(path.join(projectRoot, 'backend/scripts/huasheng/export-worker.ts'), 'throw new Error("Never execute the fixture worker")')
  writeFileSync(path.join(projectRoot, 'backend/node_modules/tsx/package.json'), '{"main":"index.cjs"}')
  writeFileSync(path.join(projectRoot, 'backend/node_modules/tsx/index.cjs'), '')
  writeFileSync(path.join(projectRoot, 'backend/.env'), 'PRIVATE_KEY=must-not-print\nDB_PATH=./wrong.db\nTASK_WORKER_DISABLED=0\n')
  writeFileSync(path.join(projectRoot, 'data/huobao_drama.db'), 'fixture database; do not open')
  const calls = []
  let loaded = false
  let domainAvailable = true
  let failBootout = false
  let failBootstrap = false
  const options = {
    projectRoot, homeDirectory, uid: 501, platform: 'darwin',
    runCommand(executable, args, settings) {
      if (executable === '/usr/bin/plutil') return spawnSync(executable, args, settings)
      assert.equal(executable, '/bin/launchctl', 'no worker or unrelated process may be launched')
      calls.push(args)
      if (args[0] === 'print') return { status: args[1] === 'gui/501' ? (domainAvailable ? 0 : 1) : (loaded ? 0 : 113), stdout: 'unstable output with PRIVATE_KEY=secret', stderr: '' }
      if (args[0] === 'enable') return { status: 0 }
      if (args[0] === 'bootstrap') { if (!failBootstrap) loaded = true; return { status: failBootstrap ? 5 : 0 } }
      if (args[0] === 'bootout') { if (!failBootout) loaded = false; return { status: failBootout ? 5 : 0 } }
      assert.fail(`Unexpected launchctl operation: ${args[0]}`)
    },
  }
  return { options, calls, config: createServiceConfig(options),
    setLoaded(value) { loaded = value }, setDomain(value) { domainAvailable = value },
    failBootout() { failBootout = true }, failBootstrap() { failBootstrap = true },
  }
}

test('plist uses a direct foreground Node process, fixed database and unconditional restart', () => {
  const config = createServiceConfig({ projectRoot: '/tmp/test-project', homeDirectory: '/tmp/test-user', uid: 501 })
  const p = config.plist
  assert.deepEqual(p.ProgramArguments, ['/opt/homebrew/bin/node', '--import', 'tsx', '--env-file=/tmp/test-project/backend/.env', '/tmp/test-project/backend/scripts/huasheng/export-worker.ts', 'serve'])
  assert.equal(p.Label, SERVICE_LABEL)
  assert.equal(p.WorkingDirectory, '/tmp/test-project/backend')
  assert.equal(p.EnvironmentVariables.DB_PATH, '/tmp/test-project/data/huobao_drama.db')
  assert.equal(p.EnvironmentVariables.HOME, '/tmp/test-user')
  assert.equal(p.EnvironmentVariables.TASK_WORKER_DISABLED, '1')
  assert.ok(p.EnvironmentVariables.PATH.split(':').every(path.isAbsolute))
  assert.equal(p.RunAtLoad, true)
  assert.equal(p.KeepAlive, true, 'both exit 0 and nonzero must restart')
  assert.equal(p.ThrottleInterval, 30)
  assert.equal(p.ExitTimeOut, 60)
  assert.equal(p.StandardOutPath, '/tmp/test-user/Library/Logs/huobao-drama/huasheng-export-worker.stdout.log')
  assert.equal(p.StandardErrorPath, '/tmp/test-user/Library/Logs/huobao-drama/huasheng-export-worker.stderr.log')
  assert.doesNotMatch(JSON.stringify(p), /monitoring|enableMonitoring|run-tsx|nohup|\/bin\/sh/)
})

test('install writes a valid private plist, preserves paths and is idempotent without restart', t => {
  const f = fixture(t)
  writeFileSync(path.join(f.options.projectRoot, 'backend/.env.local'), 'PRIVATE_KEY=local-secret')
  const result = manageExportWorkerService('install', f.options)
  assert.equal(result.installed, true)
  assert.equal(result.loaded, true)
  const decoded = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', f.config.plistPath], { encoding: 'utf8' })
  assert.equal(decoded.status, 0, decoded.stderr)
  const plist = JSON.parse(decoded.stdout)
  assert.deepEqual(plist, createServiceConfig(f.options).plist)
  assert.match(plist.ProgramArguments[3], /\.env\.local$/)
  assert.equal(statSync(f.config.plistPath).mode & 0o777, 0o600)
  assert.equal(statSync(result.stdoutPath).mode & 0o777, 0o600)
  assert.deepEqual(f.calls.filter(call => call[0] !== 'print').map(call => call[0]), ['enable', 'bootstrap'])
  f.calls.length = 0
  manageExportWorkerService('install', f.options)
  assert.deepEqual(f.calls.filter(call => call[0] !== 'print').map(call => call[0]), ['enable'])
  assert.doesNotMatch(readFileSync(f.config.plistPath, 'utf8'), /PRIVATE_KEY|local-secret|must-not-print/)
})

test('a changed configuration replaces only its loaded service after validation', t => {
  const f = fixture(t)
  manageExportWorkerService('install', f.options)
  writeFileSync(path.join(f.options.projectRoot, 'backend/.env.local'), '')
  f.calls.length = 0
  manageExportWorkerService('install', f.options)
  assert.deepEqual(f.calls.filter(call => call[0] !== 'print').map(call => call[0]), ['bootout', 'enable', 'bootstrap'])
  assert.ok(f.calls.every(call => call[1] === f.config.target || call[1] === f.config.domain))
})

test('status is read-only, does not require env/dependencies/database and never prints launchctl secrets', t => {
  const f = fixture(t)
  rmSync(path.join(f.options.projectRoot, 'backend'), { recursive: true })
  rmSync(path.join(f.options.projectRoot, 'data'), { recursive: true })
  const output = []
  assert.equal(serviceMain(['status'], { ...f.options, write: line => output.push(line) }), 0)
  assert.equal(JSON.parse(output[0]).loaded, false)
  assert.ok(f.calls.every(call => call[0] === 'print'))
  assert.equal(existsSync(f.config.plistPath), false)
  assert.equal(existsSync(f.config.logDirectory), false)
  assert.doesNotMatch(output.join('\n'), /PRIVATE_KEY|secret|unstable/)
  f.setDomain(false)
  assert.equal(manageExportWorkerService('status', f.options).domainAvailable, false)
})

test('uninstall unloads only its service and retains logs and database; repeating it is safe', t => {
  const f = fixture(t)
  const installed = manageExportWorkerService('install', f.options)
  writeFileSync(installed.stdoutPath, 'retained log\n')
  f.calls.length = 0
  const removed = manageExportWorkerService('uninstall', f.options)
  assert.equal(removed.installed, false)
  assert.equal(removed.loaded, false)
  assert.deepEqual(f.calls.filter(call => call[0] !== 'print'), [['bootout', f.config.target]])
  assert.equal(readFileSync(installed.stdoutPath, 'utf8'), 'retained log\n')
  assert.equal(readFileSync(installed.databasePath, 'utf8'), 'fixture database; do not open')
  f.calls.length = 0
  manageExportWorkerService('uninstall', f.options)
  assert.ok(f.calls.every(call => call[0] === 'print'))
})

test('failed validation or failed bootout preserves the existing service and plist', t => {
  const f = fixture(t)
  manageExportWorkerService('install', f.options)
  const original = readFileSync(f.config.plistPath, 'utf8')
  rmSync(path.join(f.options.projectRoot, 'data/huobao_drama.db'))
  f.calls.length = 0
  assert.throws(() => manageExportWorkerService('install', f.options), /Required file/)
  assert.ok(f.calls.every(call => call[0] === 'print'))
  assert.equal(readFileSync(f.config.plistPath, 'utf8'), original)
  f.failBootout()
  assert.throws(() => manageExportWorkerService('uninstall', f.options), /plist was preserved/)
  assert.equal(readFileSync(f.config.plistPath, 'utf8'), original)
})

test('bootstrap failure is actionable and preserves installation for retry without exposing command output', t => {
  const f = fixture(t)
  f.failBootstrap()
  const errors = []
  assert.equal(serviceMain(['install'], { ...f.options, writeError: message => errors.push(message) }), 1)
  assert.match(errors[0], /bootstrap.*retry install/)
  assert.doesNotMatch(errors[0], /PRIVATE_KEY|secret/)
  assert.equal(existsSync(f.config.plistPath), true)
  f.setDomain(false)
  assert.throws(() => manageExportWorkerService('install', f.options), /log in.*Do not use sudo/)
})

test('import, help and invalid commands never call launchctl or start a worker', () => {
  const script = fileURLToPath(new URL('./export-worker-service.mjs', import.meta.url))
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(import.meta.url.replace('.test.mjs', '.mjs'))})`], { encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')
  for (const args of [['--help'], [], ['restart'], ['install', 'unexpected']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, args[0] === '--help' ? 0 : 1)
    assert.match(result.stdout + result.stderr, /Usage:/)
  }
})
