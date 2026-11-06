import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function startup(disabled: boolean) {
  const calls: string[] = []
  class App { get() { return this } route() { return this } }
  const modules: Record<string, unknown> = {
    './load-env.js': {},
    '@hono/node-server': { serve: (_options: unknown, ready: () => void) => { ready(); return { close() {} } } },
    hono: { Hono: App },
    './routes/science-workflow.js': { createScienceWorkflowRoute: () => ({}) },
    './services/science-workflow.js': { getScienceWorkflowService: () => ({ startAutomaticExports: () => calls.push('workflow') }) },
    './services/science-collection.js': { getScienceCollectionService: () => ({ startAutomaticRecovery: () => calls.push('collection') }) },
  }
  const source = readFileSync(new URL('./science-server.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  runInNewContext(outputText, {
    require: (name: string) => { assert.ok(name in modules, `Unexpected startup dependency: ${name}`); return modules[name] },
    exports: {}, console: { log() {} }, process: { env: disabled ? { TASK_WORKER_DISABLED: '1' } : {}, once() {} },
  })
  return calls
}

test('the science server starts only its authorized workflow and collection recovery loops', () => {
  assert.deepEqual(startup(false), ['workflow', 'collection'])
})

test('the science server keeps all recovery disabled when TASK_WORKER_DISABLED is set', () => {
  assert.deepEqual(startup(true), [])
})
