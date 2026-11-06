import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nbaServiceConfiguration, NBA_SERVICE_LABEL } from './install-nba-service.mjs'

test('NBA service keeps the standalone server alive and prevents idle sleep without changing its node runtime', () => {
  const configuration = nbaServiceConfiguration({ backend: '/workspace/project/backend', node: '/node/bin/node', environment: { PATH: '/tools/bin:/usr/bin' } })
  assert.equal(configuration.Label, NBA_SERVICE_LABEL)
  assert.deepEqual(configuration.ProgramArguments, ['/usr/bin/caffeinate', '-i', '/node/bin/node', '/workspace/project/backend/run-tsx.mjs', 'src/nba-server.ts'])
  assert.equal(configuration.WorkingDirectory, '/workspace/project/backend')
  assert.equal(configuration.RunAtLoad, true)
  assert.equal(configuration.KeepAlive, true)
  assert.equal(configuration.AbandonProcessGroup, false)
  assert.equal(configuration.ExitTimeOut, 30)
  assert.equal(configuration.ThrottleInterval, 10)
  assert.equal(configuration.Umask, 0o077)
  assert.equal(configuration.StandardOutPath, '/workspace/project/.logs/nba-video-service.log')
  assert.equal(configuration.StandardErrorPath, configuration.StandardOutPath)
})

test('NBA service environment enables scheduling and media tools but never embeds inherited secrets', () => {
  const configuration = nbaServiceConfiguration({ environment: { PATH: '/ffmpeg/bin:/usr/bin', API_KEY: 'not-for-plist', HOME: '/private/home', NBA_PORT: '9999', TASK_WORKER_DISABLED: '1' } })
  assert.deepEqual(Object.keys(configuration.EnvironmentVariables).sort(), ['NBA_PORT', 'PATH', 'TASK_WORKER_DISABLED'])
  assert.equal(configuration.EnvironmentVariables.NBA_PORT, '5684')
  assert.equal(configuration.EnvironmentVariables.TASK_WORKER_DISABLED, '0')
  const directories = configuration.EnvironmentVariables.PATH.split(path.delimiter)
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/ffmpeg/bin']) assert.ok(directories.includes(directory))
  assert.equal(directories.filter(directory => directory === '/usr/bin').length, 1)
  assert.equal(JSON.stringify(configuration).includes('not-for-plist'), false)
})

test('--print emits reviewable configuration without installing or starting a service', () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./install-nba-service.mjs', import.meta.url)), '--print'], { encoding: 'utf8' })
  const configuration = JSON.parse(output)
  assert.equal(configuration.Label, NBA_SERVICE_LABEL)
  assert.equal(configuration.ProgramArguments[2], process.execPath)
  assert.equal(configuration.EnvironmentVariables.TASK_WORKER_DISABLED, '0')
})

test('unsupported installer arguments fail before filesystem or launchctl operations', () => {
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./install-nba-service.mjs', import.meta.url)), '--unknown'], { stdio: 'pipe' }), /Usage:/)
})
