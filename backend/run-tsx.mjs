import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const envArgs = ['.env', '.env.local']
  .map((name) => path.join(root, name))
  .filter((file) => existsSync(file))
  .map((file) => `--env-file=${file}`)

// Do not execute the package's `#!/usr/bin/env node` shim: PATH may resolve a
// different Node installation than the one that launched this script.
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const userArgs = process.argv.slice(2)
const args = userArgs[0] === 'watch'
  ? ['watch', ...envArgs, ...userArgs.slice(1)]
  : [...envArgs, ...userArgs]

const child = spawn(process.execPath, [tsxCli, ...args], {
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
