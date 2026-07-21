#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const snapshotPath = process.argv[2] || path.join(root, 'data/temp/videoeditor-episode-114-1.json')
const outputPath = process.argv[3] || path.join(root, 'data/temp/videoeditor-showcase-assets-114-1.json')
const apiBase = (process.env.HUOBAO_API_BASE || 'http://localhost:3013').replace(/\/$/, '')
const frameType = process.env.SHOWCASE_FRAME_TYPE || 'remotion-showcase-v2-clean'
const mergePath = process.env.SHOWCASE_MERGE_WITH ? path.resolve(process.env.SHOWCASE_MERGE_WITH) : null
const selectedNumbers = (process.env.SHOWCASE_SHOTS || '1,2,3,4,5,6,7,8,9,10,11,12,13,14')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
const selected = snapshot.storyboards.filter((shot) => selectedNumbers.includes(Number(shot.storyboardNumber)))
if (selected.length === 0) throw new Error('No showcase storyboards selected')

async function request(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${url} -> ${response.status}: ${JSON.stringify(body).slice(0, 500)}`)
  }
  return body
}

function unwrap(body) {
  return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
}

function value(row, camel, snake) {
  return row?.[camel] ?? row?.[snake]
}

function staticUrl(relativePath) {
  if (!relativePath) return null
  if (/^https?:\/\//i.test(relativePath)) return relativePath
  return `${apiBase}/${String(relativePath).replace(/^\/+/, '')}`
}

function stableSeed(id) {
  return (Number(id) * 2654435761) >>> 0
}

function cleanPromptText(value) {
  return String(value || '')
    .replace(/横屏16:9电影宽幅构图[，,]?/g, '')
    .replace(/电影级16:9宽幅构图[，,]?/g, '')
    .replace(/关键词叠加，快剪[：:]/g, '')
    .replace(/画面(?:中央|下方|上方|中间)?叠加[^，。]*[，。]?/g, '')
    .replace(/画面(?:中央|下方|上方|中间)?(?:出现|浮现)[^，。]*[，。]?/g, '')
    .replace(/文字清晰可见/g, '纸面保持空白')
    .replace(/日历|年历/g, '无字档案纸')
    .replace(/cinematic(?:写实风格|纪录片质感|史诗风格)?/gi, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildPrompt(shot) {
  const visual = cleanPromptText([shot.location, shot.action, shot.result].filter(Boolean).join('，'))
  const action = cleanPromptText(shot.action || shot.result)
  const movement = cleanPromptText(shot.movement)
  const location = cleanPromptText(shot.location)
  const time = cleanPromptText(shot.time).replace(/历史时期/, '十九世纪历史时期')
  return [
    'Use case: historical-scene',
    'Asset type: clean cinematic 16:9 background plate for a Remotion documentary edit; image only, no typography layer',
    `Primary request: ${visual || action}`,
    `Scene/backdrop: ${location || 'historical China'}, ${time || 'nineteenth-century historical period'}`,
    `Subject/action: ${action || visual}`,
    `Composition/framing: ${cleanPromptText(shot.shotType)} ${cleanPromptText(shot.angle)}; ${movement}; leave clean negative space for captions and graphic overlays`,
    'Style/medium: cinematic historical documentary, grounded photorealism, period-accurate materials, subtle film grain, natural depth and atmospheric perspective',
    'Lighting/mood: match the source description; expressive but physically plausible light, no crushed blacks',
    'Strict clean-plate constraint: absolutely zero visible text of any kind; no Chinese characters, no Latin letters, no Arabic numerals, no dates, no captions, no handwriting, no calligraphy, no readable documents, no signs, no banners, no flags with symbols, no logos, no watermark, no UI, no decorative borders; use blank paper and unmarked fabric whenever paper or flags appear',
    'Output: a single coherent still frame with one visual situation, no collage, no split-screen, no triptych, no multiple portrait panels, 16:9 landscape; all labels and typography will be animated by Remotion',
  ].join('\n')
}

async function findExisting(shot) {
  const rows = unwrap(await request(`${apiBase}/api/v1/images?storyboard_id=${shot.id}`))
  if (!Array.isArray(rows)) return null
  return rows.find((row) => value(row, 'frameType', 'frame_type') === frameType) || null
}

async function submit(shot, configId) {
  const existing = await findExisting(shot)
  const existingStatus = value(existing, 'status', 'status')
  const existingPath = value(existing, 'localPath', 'local_path')
  if (existing && existingStatus === 'completed' && existingPath) {
    return {
      storyboardNumber: shot.storyboardNumber,
      storyboardId: shot.id,
      generationId: existing.id,
      taskId: value(existing, 'taskId', 'task_id') || null,
      status: 'reused',
      prompt: value(existing, 'prompt', 'prompt') || buildPrompt(shot),
      localPath: existingPath,
      imageUrl: staticUrl(existingPath),
    }
  }

  const payload = {
    drama_id: snapshot.episode.dramaId,
    episode_id: snapshot.episode.id,
    storyboard_id: shot.id,
    config_id: configId,
    aspect_ratio: '16:9',
    frame_type: frameType,
    seed: stableSeed(shot.id),
    use_storyboard_prompt: false,
    prompt: buildPrompt(shot),
  }
  const created = unwrap(await request(`${apiBase}/api/v1/images`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  if (!created?.id) throw new Error(`Image request for storyboard ${shot.id} did not return an id`)
  return {
    storyboardNumber: shot.storyboardNumber,
    storyboardId: shot.id,
    generationId: created.id,
    taskId: created.task_id || created.taskId || null,
    status: 'submitted',
    prompt: payload.prompt,
    localPath: null,
    imageUrl: null,
  }
}

async function waitForImage(result) {
  if (result.status === 'reused') return result
  const startedAt = Date.now()
  const timeoutMs = 25 * 60 * 1000
  while (Date.now() - startedAt < timeoutMs) {
    const row = unwrap(await request(`${apiBase}/api/v1/images/${result.generationId}`))
    const status = value(row, 'status', 'status')
    const localPath = value(row, 'localPath', 'local_path')
    if (status === 'completed' && localPath) {
      return { ...result, status: 'completed', localPath, imageUrl: staticUrl(localPath) }
    }
    if (status === 'failed') {
      const error = value(row, 'errorMsg', 'error_msg') || value(row, 'lastErrorDetail', 'last_error_detail') || 'unknown image error'
      throw new Error(`Storyboard ${result.storyboardId} image generation failed: ${error}`)
    }
    process.stdout.write(`  storyboard ${result.storyboardNumber}: ${status || 'pending'}\n`)
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw new Error(`Timed out waiting for storyboard ${result.storyboardId}`)
}

async function main() {
  const configRows = unwrap(await request(`${apiBase}/api/v1/ai-configs?service_type=image`))
  if (!Array.isArray(configRows)) throw new Error('Image AI config response is not an array')
  const config = configRows.find((row) => {
    const models = Array.isArray(row.model) ? row.model : []
    return row.is_active !== false && row.provider === 'apimart' && models.includes('gpt-image-2')
  }) || configRows.find((row) => row.is_active !== false && row.provider === 'apimart')
  if (!config?.id) throw new Error('No active APIMart image config found')

  console.log(`Using image config ${config.id} (${config.provider}, gpt-image-2 path)`)
  const results = []
  for (let index = 0; index < selected.length; index += 3) {
    const group = selected.slice(index, index + 3)
    const submitted = await Promise.all(group.map((shot) => submit(shot, config.id)))
    submitted.forEach((item) => console.log(`storyboard ${item.storyboardNumber}: ${item.status} generation ${item.generationId}`))
    const completed = await Promise.all(submitted.map(waitForImage))
    results.push(...completed)
  }

  let finalResults = results
  let manifestFrameType = frameType
  if (mergePath && fs.existsSync(mergePath)) {
    const baseManifest = JSON.parse(fs.readFileSync(mergePath, 'utf8'))
    const replacementByStoryboardId = new Map(results.map((item) => [Number(item.storyboardId), item]))
    finalResults = (baseManifest.shots || []).map((item) => replacementByStoryboardId.get(Number(item.storyboardId)) || item)
    manifestFrameType = baseManifest.frameType || frameType
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    episodeId: snapshot.episode.id,
    dramaId: snapshot.episode.dramaId,
    frameType: manifestFrameType,
    configId: config.id,
    apiBase,
    shots: finalResults.sort((a, b) => a.storyboardNumber - b.storyboardNumber),
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({ output: outputPath, shots: finalResults.length, paths: finalResults.map((item) => item.localPath) }, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
