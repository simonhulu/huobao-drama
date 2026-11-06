#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fail, isMain, loadPackage, verifyVideo } from './lib.mjs'

async function loadRuntime() {
  const [{ getTask }, { runWorkerOnce }, { createImageGenerateHandler }, { registerTaskHandler },
    { executeImageGeneration }, { db, schema }, { eq }] = await Promise.all([
    import('../../src/services/tasks/store.ts'),
    import('../../src/services/tasks/worker.ts'),
    import('../../src/services/tasks/handlers/image-generate.ts'),
    import('../../src/services/tasks/registry.ts'),
    import('../../src/services/image-generation.ts'),
    import('../../src/db/index.ts'),
    import('drizzle-orm'),
  ])
  return {
    getTask, runWorkerOnce,
    registerImageGenerateHandler: () => registerPackageImageGenerateHandler({
      registerTaskHandler, createImageGenerateHandler, executeImageGeneration,
    }),
    getGeneration: (id) => db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).get(),
  }
}

export function registerPackageImageGenerateHandler({ registerTaskHandler, createImageGenerateHandler, executeImageGeneration }) {
  registerTaskHandler('image.generate', createImageGenerateHandler({
    executeImageGeneration: (generationId, options) => executeImageGeneration(generationId, {
      ...options, allowSynchronousImage: true, singleSubmission: true,
    }),
  }))
}

export function packageImageJobs(state, runtime) {
  const jobs = []
  const seen = new Set()
  for (const [name, job] of Object.entries(state.backgrounds || {})) {
    if (job.task_id == null) continue
    if (!Number.isSafeInteger(job.task_id) || job.task_id <= 0
      || !Number.isSafeInteger(job.generation_id) || job.generation_id <= 0) {
      throw new Error(`Invalid recorded image task for ${name}`)
    }
    if (seen.has(job.task_id)) throw new Error(`Duplicate image task ID for ${name}`)
    seen.add(job.task_id)
    const task = runtime.getTask(job.task_id)
    if (!task || task.type !== 'image.generate' || task.payload?.image_generation_id !== job.generation_id) {
      throw new Error(`Recorded task ${job.task_id} does not match the ${name} image generation`)
    }
    const generation = runtime.getGeneration(job.generation_id)
    if (!generation || !job.key || generation.frameType !== job.key) {
      throw new Error(`Image generation ${job.generation_id} does not belong to the ${name} package background`)
    }
    if (task.status === 'queued' && task.attempts === 0 && task.payload.single_image_submission !== true) {
      throw new Error(`Image task ${task.id} lacks single_image_submission protection; inspect the legacy task before execution`)
    }
    jobs.push({ name, task_id: task.id, generation_id: job.generation_id })
  }
  if (!jobs.length) throw new Error('Package has no recorded image task IDs; run backgrounds.mjs to record tasks first')
  return jobs
}

export async function runPackageImageTasks({ directory, runtime } = {}) {
  const { state, video } = loadPackage(directory)
  await verifyVideo(video)
  const services = runtime || await loadRuntime()
  // Validate every persisted association before any handler can contact a provider.
  const jobs = packageImageJobs(state, services)
  services.registerImageGenerateHandler()
  const results = []
  for (const job of jobs) {
    const before = services.getTask(job.task_id)
    if (before.status !== 'queued' || before.attempts > 0) {
      results.push({ ...job, executed: false, status: before.status, attempts: before.attempts,
        reason: before.status === 'queued' ? 'Already attempted; automatic retry is disabled' : 'Task is not queued' })
      continue
    }
    const ran = await services.runWorkerOnce({
      workerId: `history-cover-${process.pid}-${job.task_id}`,
      types: ['image.generate'], taskIds: [job.task_id],
    })
    const after = services.getTask(job.task_id)
    results.push({ ...job, executed: ran, status: after.status, attempts: after.attempts })
  }
  return { ok: results.every((task) => task.status === 'succeeded'), package_id: state.package_id, tasks: results }
}

async function main() {
  const { values } = parseArgs({ options: { package: { type: 'string' } } })
  if (!values.package) throw new Error('Missing --package <directory>; run with node run-tsx.mjs scripts/history-video-publish/run-image-tasks.mjs')
  const result = await runPackageImageTasks({ directory: values.package })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}

if (isMain(import.meta.url)) main().catch(fail)
