import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const envFile = ['.env.local', '.env']
  .map((name) => path.join(root, name))
  .find((file) => existsSync(file))

const tsxBin = process.platform === 'win32'
  ? path.join(root, 'node_modules', '.bin', 'tsx.cmd')
  : path.join(root, 'node_modules', '.bin', 'tsx')

const userArgs = process.argv.slice(2)
const args = envFile && userArgs[0] === 'watch'
  ? ['watch', `--env-file=${envFile}`, ...userArgs.slice(1)]
  : [
      ...(envFile ? [`--env-file=${envFile}`] : []),
      ...userArgs,
    ]

const child = spawn(tsxBin, args, {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
