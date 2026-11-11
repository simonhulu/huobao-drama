import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function startup(env: NodeJS.ProcessEnv = {}, entry = 'science-server.ts') {
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
  const transpile = (source: string) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const context = {
    require: (name: string) => { assert.ok(name in modules, `Unexpected startup dependency: ${name}`); return modules[name] },
    exports: {}, console: { log() {} }, process: { env, once() {} },
  }
  const automationContext = { ...context, exports: {} }
  runInNewContext(transpile(readFileSync(new URL('./science-automation.ts', import.meta.url), 'utf8')), automationContext)
  const automation = automationContext.exports as { startScienceAutomation: () => void }
  modules['./science-automation.js'] = automation
  let source = readFileSync(new URL(`./${entry}`, import.meta.url), 'utf8')
  if (entry === 'index.ts') {
    const parsed = ts.createSourceFile(entry, source, ts.ScriptTarget.ES2022, true)
    const start = parsed.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'startProductionWorkers')
    assert.ok(start, 'The main server must start production workers after listening')
    source = `${start.getText(parsed)}\nstartProductionWorkers()`
    Object.assign(context, automation, {
      workers: [], db: { $client: {} }, hasHistorySourceWorker() {}, resumeHistorySourceJob() {},
      createHistoryWorkflowMaintenance: () => ({ start() {} }),
      startHistoryHuashengWorker() {}, startHistoryHuashengExportWorker() {}, startHistorySocialUploadWorker() {},
      startHistoryVideoPublicationWorker() {}, startHistoryDualProductionWorker() {}, startHistoryFactoryWorker() {},
      listRegisteredTaskTypes: () => [],
      startTaskWorkerLoop: () => {
        assert.notEqual(env.TASK_WORKER_DISABLED, '1', 'Science opt-ins must not start general task workers')
        return {}
      },
    })
  }
  runInNewContext(transpile(source), context)
  return calls
}

for (const entry of ['science-server.ts', 'index.ts']) {
  test(`${entry} starts its authorized workflow and collection recovery loops by default`, () => {
    assert.deepEqual(startup({}, entry), ['workflow', 'collection'])
  })

  test(`${entry} keeps all science recovery disabled when TASK_WORKER_DISABLED is set`, () => {
    assert.deepEqual(startup({ TASK_WORKER_DISABLED: '1' }, entry), [])
  })

  test(`${entry} delivery opt-in recovers science jobs without enabling collection or general workers`, () => {
    assert.deepEqual(startup({ TASK_WORKER_DISABLED: '1', SCIENCE_DELIVERY_AUTOMATION_ENABLED: '1' }, entry), ['workflow'])
  })

  test(`${entry} collection opt-in recovers batches without enabling delivery or general workers`, () => {
    assert.deepEqual(startup({ TASK_WORKER_DISABLED: '1', SCIENCE_COLLECTION_AUTOMATION_ENABLED: '1' }, entry), ['collection'])
  })

  test(`${entry} both science opt-ins recover delivery and batches without general workers`, () => {
    assert.deepEqual(startup({ TASK_WORKER_DISABLED: '1', SCIENCE_DELIVERY_AUTOMATION_ENABLED: '1', SCIENCE_COLLECTION_AUTOMATION_ENABLED: '1' }, entry), ['workflow', 'collection'])
  })

  test(`${entry} permits explicitly disabling delivery without disabling collection workers`, () => {
    assert.deepEqual(startup({ SCIENCE_DELIVERY_AUTOMATION_ENABLED: '0' }, entry), ['collection'])
  })

  test(`${entry} permits explicitly disabling collection without disabling delivery`, () => {
    assert.deepEqual(startup({ SCIENCE_COLLECTION_AUTOMATION_ENABLED: '0' }, entry), ['workflow'])
    assert.deepEqual(startup({ TASK_WORKER_DISABLED: '1', SCIENCE_DELIVERY_AUTOMATION_ENABLED: '1', SCIENCE_COLLECTION_AUTOMATION_ENABLED: '0' }, entry), ['workflow'])
  })

  test(`${entry} permits explicitly disabling delivery while collection is opted in`, () => {
    assert.deepEqual(startup({ TASK_WORKER_DISABLED: '1', SCIENCE_DELIVERY_AUTOMATION_ENABLED: '0', SCIENCE_COLLECTION_AUTOMATION_ENABLED: '1' }, entry), ['collection'])
  })

  test(`${entry} both explicit opt-outs disable science recovery while general workers are enabled`, () => {
    assert.deepEqual(startup({ SCIENCE_DELIVERY_AUTOMATION_ENABLED: '0', SCIENCE_COLLECTION_AUTOMATION_ENABLED: '0' }, entry), [])
  })

  test(`${entry} delivery opt-out keeps all science recovery off with task workers disabled`, () => {
    assert.deepEqual(startup({ TASK_WORKER_DISABLED: '1', SCIENCE_DELIVERY_AUTOMATION_ENABLED: '0' }, entry), [])
  })
}
