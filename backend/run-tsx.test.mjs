import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const envValues = {
  '.env': 'RUNNER_TEST_BASE_ONLY=base\nRUNNER_TEST_OVERRIDE=base\nRUNNER_TEST_INHERITED=base\n',
  '.env.local': 'RUNNER_TEST_LOCAL_ONLY=local\nRUNNER_TEST_OVERRIDE=local\nRUNNER_TEST_INHERITED=local\n',
}
const valueNames = ['RUNNER_TEST_BASE_ONLY', 'RUNNER_TEST_LOCAL_ONLY', 'RUNNER_TEST_OVERRIDE', 'RUNNER_TEST_INHERITED']
const stub = `
import {execFileSync} from 'node:child_process'
const args = process.argv.slice(2)
const envArgs = args.filter(arg => arg.startsWith('--env-file='))
const program = 'console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(valueNames)}.map(name => [name, process.env[name] ?? null]))))'
const values = JSON.parse(execFileSync(process.execPath, [...envArgs, '--input-type=module', '--eval', program], {encoding:'utf8'}))
console.log(JSON.stringify({args, values, execPath:process.execPath, cwd:process.cwd()}))
`

for (const watch of [false, true]) {
  for (const files of [[], ['.env'], ['.env.local'], ['.env', '.env.local']]) {
    test(`${watch ? 'watch' : 'ordinary'} launcher loads ${files.join(' then ') || 'no env files'}`, t => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'run-tsx-test-')))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      copyFileSync(new URL('./run-tsx.mjs', import.meta.url), path.join(root, 'run-tsx.mjs'))
      const cli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
      mkdirSync(path.dirname(cli), { recursive: true })
      writeFileSync(cli, stub)
      for (const file of files) writeFileSync(path.join(root, file), envValues[file])

      const env = { ...process.env }
      for (const name of valueNames) delete env[name]
      env.RUNNER_TEST_INHERITED = 'inherited'
      const userArgs = [...(watch ? ['watch'] : []), 'src/example.ts', '--example-flag']
      const result = JSON.parse(execFileSync(process.execPath, [path.join(root, 'run-tsx.mjs'), ...userArgs], {
        env, encoding: 'utf8', cwd: tmpdir(),
      }))
      const envArgs = files.map(file => `--env-file=${path.join(root, file)}`)
      assert.deepEqual(result.args, watch
        ? ['watch', ...envArgs, 'src/example.ts', '--example-flag']
        : [...envArgs, 'src/example.ts', '--example-flag'])
      assert.equal(result.execPath, process.execPath)
      assert.equal(result.cwd, root)
      assert.deepEqual(result.values, {
        RUNNER_TEST_BASE_ONLY: files.includes('.env') ? 'base' : null,
        RUNNER_TEST_LOCAL_ONLY: files.includes('.env.local') ? 'local' : null,
        RUNNER_TEST_OVERRIDE: files.includes('.env.local') ? 'local' : files.includes('.env') ? 'base' : null,
        RUNNER_TEST_INHERITED: 'inherited',
      })
    })
  }
}
