import { spawnSync } from 'node:child_process'
import { constants, accessSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

export const SERVICE_LABEL = 'cn.huobao.history-huasheng-export'
const defaultRoot = fileURLToPath(new URL('../../../', import.meta.url))
const usage = 'Usage: node scripts/huasheng/export-worker-service.mjs install|status|uninstall'

class ServiceError extends Error {}

export function createServiceConfig(options = {}) {
  const account = userInfo()
  const projectRoot = path.resolve(options.projectRoot ?? defaultRoot)
  const homeDirectory = path.resolve(options.homeDirectory ?? account.homedir)
  const uid = options.uid ?? account.uid
  const backend = path.join(projectRoot, 'backend')
  const node = '/opt/homebrew/bin/node'
  const envFile = ['.env.local', '.env'].map(name => path.join(backend, name)).find(existsSync) ?? path.join(backend, '.env')
  const worker = path.join(backend, 'scripts/huasheng/export-worker.ts')
  // launchd opens these before Node starts. Documents/Desktop can be denied by
  // macOS privacy controls even when the actual worker can access the project.
  const logDirectory = path.join(homeDirectory, 'Library/Logs/huobao-drama')
  const plistPath = path.join(homeDirectory, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`)
  const domain = `gui/${uid}`
  const plist = {
    Label: SERVICE_LABEL,
    ProgramArguments: [node, '--import', 'tsx', `--env-file=${envFile}`, worker, 'serve'],
    WorkingDirectory: backend,
    EnvironmentVariables: {
      HOME: homeDirectory,
      PATH: ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(homeDirectory, '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      DB_PATH: path.join(projectRoot, 'data/huobao_drama.db'),
      TASK_WORKER_DISABLED: '1',
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 30,
    ExitTimeOut: 60,
    Umask: 0o077,
    StandardOutPath: path.join(logDirectory, 'huasheng-export-worker.stdout.log'),
    StandardErrorPath: path.join(logDirectory, 'huasheng-export-worker.stderr.log'),
  }
  return { projectRoot, backend, node, envFile, worker, logDirectory, plistPath, domain, target: `${domain}/${SERVICE_LABEL}`, plist }
}

function requireFile(filename, mode) {
  try {
    if (!statSync(filename).isFile()) throw new Error()
    accessSync(filename, mode)
  } catch {
    throw new ServiceError(`Required file is missing or inaccessible: ${filename}`)
  }
}

function validateInstall(config) {
  requireFile(config.node, constants.X_OK)
  requireFile(config.worker, constants.R_OK)
  requireFile(config.envFile, constants.R_OK)
  requireFile(config.plist.EnvironmentVariables.DB_PATH, constants.R_OK | constants.W_OK)
  try { createRequire(path.join(config.backend, 'package.json')).resolve('tsx') }
  catch { throw new ServiceError('tsx is unavailable in backend/node_modules; install the existing backend dependencies first.') }
}

function atomicWrite(filename, content) {
  const temporary = `${filename}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, filename)
  } finally {
    rmSync(temporary, { force: true })
  }
}

// launchctl print is queried only for its exit status; its text is not a stable API.
export function manageExportWorkerService(action, options = {}) {
  if (!['install', 'status', 'uninstall'].includes(action)) throw new ServiceError(usage)
  if ((options.platform ?? process.platform) !== 'darwin') throw new ServiceError('This service manager requires macOS launchd.')
  const config = createServiceConfig(options)
  const run = options.runCommand ?? spawnSync
  const command = (executable, args, input) => {
    let result
    try {
      result = run(executable, args, { encoding: 'utf8', input, timeout: 70_000, maxBuffer: 1024 * 1024 })
    } catch {
      throw new ServiceError(`Could not execute ${path.basename(executable)}; check command availability and permissions.`)
    }
    if (result.error || result.signal) throw new ServiceError(`${path.basename(executable)} did not finish; check service status before retrying.`)
    return result
  }
  const launchctl = args => command('/bin/launchctl', args)
  const isLoaded = () => launchctl(['print', config.target]).status === 0
  const checked = args => {
    const result = launchctl(args)
    if (result.status !== 0) throw new ServiceError(`launchctl ${args[0]} failed (exit ${result.status}); inspect with: /bin/launchctl print ${config.target}`)
  }
  const domainAvailable = launchctl(['print', config.domain]).status === 0
  let loaded = domainAvailable && isLoaded()
  const report = () => ({
    service: SERVICE_LABEL,
    installed: existsSync(config.plistPath),
    loaded,
    domainAvailable,
    target: config.target,
    plistPath: config.plistPath,
    databasePath: config.plist.EnvironmentVariables.DB_PATH,
    stdoutPath: config.plist.StandardOutPath,
    stderrPath: config.plist.StandardErrorPath,
  })
  if (action === 'status') return report()
  if (!domainAvailable) throw new ServiceError(`The user launchd domain ${config.domain} is unavailable; log in to the macOS desktop as this user and retry. Do not use sudo.`)

  const bootout = () => {
    const result = launchctl(['bootout', config.target])
    loaded = isLoaded()
    if (loaded) throw new ServiceError(`launchctl bootout did not unload the service (exit ${result.status}); the existing plist was preserved.`)
  }
  if (action === 'uninstall') {
    if (loaded) bootout()
    rmSync(config.plistPath, { force: true })
    return report()
  }

  validateInstall(config)
  // plutil handles XML escaping and types instead of interpolating paths into XML.
  const converted = command('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], JSON.stringify(config.plist))
  if (converted.status !== 0 || !converted.stdout) throw new ServiceError('Could not create a valid launchd plist with plutil.')
  const xml = converted.stdout
  const unchanged = existsSync(config.plistPath) && readFileSync(config.plistPath, 'utf8') === xml
  if (loaded && !unchanged) bootout()
  mkdirSync(path.dirname(config.plistPath), { recursive: true, mode: 0o700 })
  mkdirSync(config.logDirectory, { recursive: true, mode: 0o700 })
  for (const log of [config.plist.StandardOutPath, config.plist.StandardErrorPath]) {
    closeSync(openSync(log, 'a', 0o600))
  }
  if (!unchanged) atomicWrite(config.plistPath, xml)
  chmodSync(config.plistPath, 0o600)
  checked(['enable', config.target])
  if (!loaded) {
    const result = launchctl(['bootstrap', config.domain, config.plistPath])
    loaded = isLoaded()
    if (!loaded) throw new ServiceError(`launchctl bootstrap did not load the service (exit ${result.status}); the plist and logs were retained. Check the GUI session and stderr log, then retry install.`)
  }
  return report()
}

export function serviceMain(args = process.argv.slice(2), options = {}) {
  const write = options.write ?? (value => console.log(value))
  const writeError = options.writeError ?? (value => console.error(value))
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { write(usage); return 0 }
  if (args.length !== 1 || !['install', 'status', 'uninstall'].includes(args[0])) { writeError(usage); return 1 }
  try {
    write(JSON.stringify(manageExportWorkerService(args[0], options), null, 2))
    return 0
  } catch (error) {
    writeError(error instanceof ServiceError ? error.message : 'Service operation failed; check file permissions and service status before retrying.')
    return 1
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = serviceMain()
}
