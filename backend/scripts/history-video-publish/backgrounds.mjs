#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { parseArgs } from 'node:util'
import { api, fail, fingerprint, isMain, loadPackage, PROJECT_ROOT, sha256, verifyVideo, withPackageLock, writeJson } from './lib.mjs'

export function generationKey(packageId, prompt, ratio, configId, model) {
  return `history-cover-${sha256(JSON.stringify([packageId, prompt, ratio, configId, model]))}`
}

// The image API deduplicates by frame_type. A package/design/model-scoped label
// also lets us recover a lost POST response without submitting another paid job.
export async function findOrSubmit({ origin, key, prompt, ratio, configId, model, request = api }) {
  const rows = await request(origin, '/images')
  const matches = rows.filter((row) => row.frameType === key)
  if (matches.length > 1) throw new Error(`Ambiguous image generation history for ${key}`)
  if (matches.length) {
    const generation = matches[0]
    let taskId
    if (!['completed', 'failed'].includes(generation.status)) {
      const tasks = await request(origin, '/tasks?type=image.generate&active_only=true')
      const related = tasks.filter((task) => task.payload?.image_generation_id === generation.id)
      if (related.length !== 1) throw new Error(`Cannot uniquely recover the active task for image ${generation.id}; inspect before retrying`)
      taskId = related[0].id
    }
    return { generation_id: generation.id, ...(taskId ? { task_id: taskId } : {}), key, recovered: true }
  }
  const capabilities = await request(origin, '/images/capabilities')
  if (capabilities?.single_image_submission !== true) {
    throw new Error('Image API lacks single_image_submission protection; load the current backend before creating a paid image task')
  }
  const result = await request(origin, '/images', { method: 'POST', body: JSON.stringify({
    prompt, aspect_ratio: ratio, config_id: configId, model, frame_type: key,
    allow_synchronous_image: true, single_image_submission: true,
  }) })
  if (!Number.isSafeInteger(result.id)) throw new Error('Image API did not return a generation ID; inspect history before retrying')
  return { generation_id: result.id, task_id: result.task_id, key }
}

function generationPath(value) {
  if (!value || /^(?:https?:|data:)/.test(value)) throw new Error('Completed generation has no local image path')
  if (path.isAbsolute(value) && fs.existsSync(value)) return value
  const relative = value.replace(/^\/+/, '').replace(/^data\//, '')
  const candidate = path.resolve(PROJECT_ROOT, 'data', relative)
  if (!candidate.startsWith(`${path.join(PROJECT_ROOT, 'data')}${path.sep}`)) throw new Error('Generation path escapes data directory')
  return candidate
}

export async function prepareBackgrounds({ directory, configId, model, landscape, portrait, waitSeconds = 900 }) {
  return withPackageLock(directory, async () => {
    const { dir, state, packaging, video } = loadPackage(directory)
    await verifyVideo(video)
    if (state.covers) throw new Error('Covers already frozen; reuse them or prepare a new package for a different design')
    if (!!landscape !== !!portrait) throw new Error('Provide both --landscape and --portrait')
    if (!landscape && (!Number.isSafeInteger(configId) || configId < 1 || !model)) throw new Error('AI mode requires explicit --config and --model')
    if (!landscape && model === 'gpt-image-2-1k') throw new Error('The current image API cannot request 3:4 with gpt-image-2-1k; choose a 3:4-capable model before submitting any paid jobs')
    fs.mkdirSync(path.join(dir, 'covers'), { recursive: true })
    if (!landscape) {
      const configs = await api(state.api_origin, '/ai-configs?service_type=image')
      const config = configs.find((item) => item.id === configId && (item.is_active ?? item.isActive))
      const models = config && (Array.isArray(config.model) ? config.model : (() => { try { return JSON.parse(config.model) } catch { return [config.model] } })())
      if (!config || !Array.isArray(models) || !models.includes(model)) throw new Error('Selected active image configuration/model is unavailable')
    }
    for (const [name, ratio, local] of [['landscape', '16:9', landscape], ['portrait', '3:4', portrait]]) {
      const output = path.join(dir, 'covers', `base-${name}.png`)
      let job = state.backgrounds[name]
      if (job?.sha256) {
        if (await fingerprint(output) !== job.sha256) throw new Error(`Frozen ${name} background fingerprint changed`)
        continue
      }
      if (local) {
        await sharp(path.resolve(local)).rotate().png().toFile(output)
        job = { source: path.resolve(local) }
      } else {
        const prompt = packaging.cover_design[`${name}_prompt`] || packaging.cover_design.ai_prompt
        if (!prompt?.trim()) throw new Error(`Missing ${name}_prompt or ai_prompt`)
        const key = generationKey(state.package_id, prompt, ratio, configId, model)
        if (job && job.key !== key) throw new Error('Generation settings changed; prepare a new package')
        if (!job) {
          // Persist intent before the paid request; recovery queries its unique key.
          state.backgrounds[name] = { key, config_id: configId, model, status: 'submitting' }
          writeJson(path.join(dir, 'state.json'), state)
          job = { ...state.backgrounds[name], ...await findOrSubmit({ origin: state.api_origin, key, prompt, ratio, configId, model }) }
        } else if (!job.generation_id) {
          job = { ...job, ...await findOrSubmit({ origin: state.api_origin, key, prompt, ratio, configId, model }) }
        }
        state.backgrounds[name] = job
        writeJson(path.join(dir, 'state.json'), state)
        const deadline = Date.now() + waitSeconds * 1000
        let generation
        do {
          generation = await api(state.api_origin, `/images/${job.generation_id}`)
          if (!generation) throw new Error(`Generation ${job.generation_id} disappeared; do not resubmit blindly`)
          if (generation.status === 'completed') break
          if (generation.status === 'failed') throw new Error(`Generation ${job.generation_id} failed: ${generation.errorMsg || 'unknown error'}. Existing job retained; no automatic resubmission.`)
          if (job.task_id) {
            const task = await api(state.api_origin, `/tasks/${job.task_id}`)
            if (['failed', 'cancelled', 'canceled'].includes(task?.status)) throw new Error(`Image task ${job.task_id} is ${task.status}; no automatic resubmission`)
          }
          process.stderr.write(`[history-cover] ${name}: generation=${job.generation_id} status=${generation.status}\n`)
          if (Date.now() >= deadline) throw new Error('Image wait timed out; rerun the same command to resume the existing task')
          await new Promise((resolve) => setTimeout(resolve, 5000))
        } while (true)
        await sharp(generationPath(generation.localPath)).rotate().png().toFile(output)
        job.status = 'completed'
      }
      const metadata = await sharp(output).metadata()
      if (Math.abs(metadata.width / metadata.height - (name === 'landscape' ? 16 / 9 : 3 / 4)) > 0.04) {
        throw new Error(`Unexpected ${name} generation geometry: ${metadata.width}x${metadata.height}; inspect before cropping`)
      }
      state.backgrounds[name] = { ...job, path: output, sha256: await fingerprint(output), width: metadata.width, height: metadata.height }
      writeJson(path.join(dir, 'state.json'), state)
    }
    return { ok: true, directory: dir, backgrounds: state.backgrounds }
  })
}

async function main() {
  const { values } = parseArgs({ options: { package: { type: 'string' }, config: { type: 'string' }, model: { type: 'string' },
    landscape: { type: 'string' }, portrait: { type: 'string' }, 'wait-seconds': { type: 'string' } } })
  if (!values.package) throw new Error('Missing --package <directory>')
  process.stdout.write(`${JSON.stringify(await prepareBackgrounds({ directory: values.package, configId: Number(values.config), model: values.model,
    landscape: values.landscape, portrait: values.portrait, waitSeconds: Number(values['wait-seconds'] || 900) }), null, 2)}\n`)
}
if (isMain(import.meta.url)) main().catch(fail)
