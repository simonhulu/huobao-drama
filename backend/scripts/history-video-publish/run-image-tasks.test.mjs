import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packageIdentity, sha256, writeJson } from './lib.mjs'
import { packageImageJobs, runPackageImageTasks, registerPackageImageGenerateHandler } from './run-image-tasks.mjs'

test('package runner explicitly enables synchronous-image and single-submission protection without replacing task context', async () => {
  let execute
  const calls = []
  const handler = { fixture: true }
  registerPackageImageGenerateHandler({
    registerTaskHandler(type, value) { assert.equal(type, 'image.generate'); assert.equal(value, handler) },
    createImageGenerateHandler(dependencies) { execute = dependencies.executeImageGeneration; return handler },
    async executeImageGeneration(generationId, options) { calls.push({ generationId, options }); return { generationId } },
  })
  const taskContext = { fixture: 'context' }
  assert.deepEqual(await execute(7, { configId: 95, taskContext, allowSynchronousImage: false }), { generationId: 7 })
  assert.deepEqual(calls, [{ generationId: 7, options: { configId: 95, taskContext, allowSynchronousImage: true, singleSubmission: true } }])
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'history-image-runner-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const packaging = { title: '历史食品造假', opening_hook: '古人如何辨别食物？',
    cover_design: { main_title: '历史食品造假' }, platforms: { baijiahao: { description: '古人如何辨别食物？' } } }
  const script = 'Actual production script'
  const video = Buffer.from('Video fixture')
  const videoPath = path.join(directory, 'video.mp4')
  fs.writeFileSync(videoPath, video)
  fs.writeFileSync(path.join(directory, 'production-script.txt'), script)
  writeJson(path.join(directory, 'publishing-package.json'), packaging)
  writeJson(path.join(directory, 'video-reference.json'), { path: videoPath, sha256: sha256(video) })
  const state = { history_source_id: 1, script_sha256: sha256(script), video_sha256: sha256(video),
    packaging_sha256: sha256(JSON.stringify(packaging)),
    backgrounds: { landscape: { task_id: 1, generation_id: 11, key: 'package-landscape' },
      portrait: { task_id: 2, generation_id: 12, key: 'package-portrait' } } }
  state.package_id = packageIdentity(1, state.script_sha256, state.video_sha256, state.packaging_sha256)
  writeJson(path.join(directory, 'state.json'), state)
  const tasks = new Map([1, 2, 99].map((id) => [id, {
    id, type: 'image.generate', status: 'queued', attempts: 0,
    payload: { image_generation_id: id + 10, single_image_submission: true },
  }]))
  const generations = new Map([[11, { frameType: 'package-landscape' }], [12, { frameType: 'package-portrait' }]])
  const calls = []
  let registrations = 0
  const runtime = {
    getTask: (id) => tasks.get(id), getGeneration: (id) => generations.get(id),
    registerImageGenerateHandler: () => { registrations++ },
    runWorkerOnce: async (options) => {
      calls.push(options)
      assert.deepEqual(options.types, ['image.generate'])
      assert.equal(options.taskIds.length, 1)
      const task = tasks.get(options.taskIds[0])
      task.attempts++
      task.status = 'succeeded'
      return true
    },
  }
  return { directory, state, tasks, generations, runtime, calls, registrations: () => registrations }
}

test('runner executes only persisted package tasks once and reuses completed results', async (t) => {
  const f = fixture(t)
  const result = await runPackageImageTasks(f)
  assert.equal(result.ok, true)
  assert.deepEqual(f.calls.map((call) => call.taskIds), [[1], [2]])
  assert.equal(f.tasks.get(99).status, 'queued')
  assert.equal(f.tasks.get(99).attempts, 0)
  const reused = await runPackageImageTasks(f)
  assert.equal(reused.ok, true)
  assert.ok(reused.tasks.every((task) => !task.executed))
  assert.equal(f.calls.length, 2)
})

test('runner validates every task type, generation ID and package image key before registering a handler', async (t) => {
  for (const kind of ['type', 'generation', 'key', 'missing']) {
    const f = fixture(t)
    if (kind === 'type') f.tasks.get(2).type = 'video.generate'
    if (kind === 'generation') f.tasks.get(2).payload.image_generation_id = 99
    if (kind === 'key') f.generations.get(12).frameType = 'other-package'
    if (kind === 'missing') f.tasks.delete(2)
    await assert.rejects(runPackageImageTasks(f), /does not match|does not belong/)
    assert.equal(f.registrations(), 0)
    assert.deepEqual(f.calls, [])
    assert.equal(f.tasks.get(1).attempts, 0)
  }
})

test('runner rejects runnable legacy tasks lacking submission protection before running any task', async (t) => {
  for (const value of [undefined, false, 'true']) {
    const f = fixture(t)
    f.tasks.get(2).payload.single_image_submission = value
    await assert.rejects(runPackageImageTasks(f), /lacks single_image_submission protection/)
    assert.equal(f.registrations(), 0)
    assert.deepEqual(f.calls, [])
  }
})

test('runner can reuse already completed legacy tasks without contacting the provider', async (t) => {
  const f = fixture(t)
  for (const task of f.tasks.values()) {
    task.status = 'succeeded'
    task.attempts = 1
    delete task.payload.single_image_submission
  }
  assert.equal((await runPackageImageTasks(f)).ok, true)
  assert.deepEqual(f.calls, [])
})

test('runner never retries attempted, running, failed or canceled tasks', async (t) => {
  const f = fixture(t)
  f.tasks.get(1).attempts = 1
  for (const status of ['queued', 'running', 'failed', 'canceled']) {
    f.tasks.get(1).status = status
    f.tasks.get(2).status = status
    const result = await runPackageImageTasks(f)
    if (status === 'queued') assert.deepEqual(f.calls.map((call) => call.taskIds), [[2]])
    else assert.ok(result.tasks.every((task) => !task.executed))
    assert.equal(result.ok, false)
  }
  assert.equal(f.tasks.get(1).attempts, 1)
})

test('runner reports blocked or requeued task as incomplete without polling or repeating it', async (t) => {
  const f = fixture(t)
  f.runtime.runWorkerOnce = async (options) => { f.calls.push(options); return false }
  const result = await runPackageImageTasks(f)
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 2)
  assert.ok(result.tasks.every((task) => task.status === 'queued' && !task.executed))
})

test('missing or duplicate recorded task IDs cannot broaden the execution scope', (t) => {
  const f = fixture(t)
  assert.throws(() => packageImageJobs({ backgrounds: {} }, f.runtime), /no recorded image task IDs/)
  assert.throws(() => packageImageJobs({ backgrounds: { landscape: { task_id: '1', generation_id: 11 } } }, f.runtime), /Invalid recorded/)
  f.state.backgrounds.portrait.task_id = 1
  assert.throws(() => packageImageJobs(f.state, f.runtime), /Duplicate image task ID/)
  assert.equal(f.registrations(), 0)
  assert.deepEqual(f.calls, [])
})

test('CLI loads the existing image handler through run-tsx and rejects nonexistent tasks without contacting a provider', (t) => {
  const f = fixture(t)
  const backend = fileURLToPath(new URL('../..', import.meta.url))
  assert.throws(() => execFileSync(process.execPath,
    ['run-tsx.mjs', 'scripts/history-video-publish/run-image-tasks.mjs', '--package', f.directory], {
      cwd: backend, encoding: 'utf8', stdio: 'pipe', timeout: 20000,
      env: { ...process.env, DB_PATH: path.join(f.directory, 'isolated.db') },
    }), (error) => {
      assert.equal(error.status, 1)
      assert.match(error.stderr, /Recorded task 1 does not match the landscape image generation/)
      return true
    })
})
