import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const backendDirectory = fileURLToPath(new URL('../', import.meta.url))
export const NBA_SERVICE_LABEL = 'com.huobao.nba-video'

export function nbaServiceConfiguration({ backend = backendDirectory, node = process.execPath, environment = process.env } = {}) {
  const workingDirectory = path.resolve(backend), root = path.dirname(workingDirectory)
  const searchPath = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    ...(environment.PATH || '').split(path.delimiter).filter(Boolean)])].join(path.delimiter)
  return {
    Label: NBA_SERVICE_LABEL,
    ProgramArguments: ['/usr/bin/caffeinate', '-i', node, path.join(workingDirectory, 'run-tsx.mjs'), 'src/nba-server.ts'],
    WorkingDirectory: workingDirectory,
    EnvironmentVariables: { PATH: searchPath, TASK_WORKER_DISABLED: '0', NBA_PORT: '5684' },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    ExitTimeOut: 30,
    AbandonProcessGroup: false,
    Umask: 63,
    StandardOutPath: path.join(root, '.logs/nba-video-service.log'),
    StandardErrorPath: path.join(root, '.logs/nba-video-service.log'),
  }
}

export function installNbaService({ writeOnly = false, homeDirectory = os.homedir(), configuration = nbaServiceConfiguration() } = {}) {
  if (process.platform !== 'darwin') throw Error('NBA LaunchAgent installation requires macOS')
  const directory = path.join(homeDirectory, 'Library/LaunchAgents')
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(path.dirname(configuration.StandardOutPath), { recursive: true })
  const filename = path.join(directory, `${NBA_SERVICE_LABEL}.plist`)
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', filename, '-'], { input: JSON.stringify(configuration) })
  fs.chmodSync(filename, 0o600)
  if (!writeOnly) {
    const domain = `gui/${process.getuid()}`
    try { execFileSync('/bin/launchctl', ['bootout', `${domain}/${NBA_SERVICE_LABEL}`], { stdio: 'ignore' }) }
    catch { /* The first installation has no existing LaunchAgent. */ }
    execFileSync('/bin/launchctl', ['bootstrap', domain, filename])
  }
  return filename
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some(argument => !['--print', '--write-only'].includes(argument)) || args.length > 1) {
    throw Error('Usage: node scripts/install-nba-service.mjs [--print | --write-only]')
  }
  if (args.includes('--print')) console.log(JSON.stringify(nbaServiceConfiguration(), null, 2))
  else console.log(`${args.includes('--write-only') ? 'Wrote' : 'Installed'} ${installNbaService({ writeOnly: args.includes('--write-only') })}`)
}
