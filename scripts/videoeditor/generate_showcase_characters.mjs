#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const snapshotPath = process.argv[2] || path.join(root, 'data/temp/videoeditor-episode-114-1.json')
const outputPath = process.argv[3] || path.join(root, 'data/temp/videoeditor-showcase-v2-characters-114-1.json')
const apiBase = (process.env.HUOBAO_API_BASE || 'http://localhost:3013').replace(/\/$/, '')
const framePrefix = process.env.SHOWCASE_CHARACTER_FRAME_PREFIX || 'remotion-showcase-v2-character'

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
const storyboardByNumber = new Map(snapshot.storyboards.map((shot) => [Number(shot.storyboardNumber), shot]))

const specs = [
  {
    key: 'kangxi',
    storyboardNumber: 6,
    name: '康熙',
    action: '清代皇帝在大殿书案前批阅奏折，神情沉稳仁厚，手持朱笔，单人半身肖像',
    mood: '温和、克制、带有制度秩序感',
  },
  {
    key: 'yongzheng',
    storyboardNumber: 6,
    name: '雍正',
    action: '清代皇帝伏案疾书政令，神情冷峻果决，单人半身肖像',
    mood: '锋利、专注、带有改革压力',
  },
  {
    key: 'yang-xiuqing',
    storyboardNumber: 10,
    name: '杨秀清',
    action: '十九世纪中国南方矿工出身的年轻男子，在矿洞中抡锤开矿，汗水与煤灰覆盖脸颊，单人半身肖像',
    mood: '强韧、粗粝、身体力量感',
  },
  {
    key: 'li-xiucheng',
    storyboardNumber: 10,
    name: '李秀成',
    action: '十九世纪中国南方矿工出身的年轻男子，推着沉重矿车喘息，汗水与煤灰覆盖脸颊，单人半身肖像',
    mood: '疲惫、坚毅、沉默',
  },
  {
    key: 'xiao-chaogui',
    storyboardNumber: 10,
    name: '萧朝贵',
    action: '十九世纪中国南方矿工出身的年轻男子，在矿洞口用破布擦汗，眼神坚定，单人半身肖像',
    mood: '警觉、坚决、带有生存压力',
  },
]

async function request(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${response.status}: ${JSON.stringify(body).slice(0, 500)}`)
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

function stableSeed(storyboardId, key) {
  let hash = Number(storyboardId) * 2654435761
  for (const char of key) hash = ((hash ^ char.charCodeAt(0)) * 16777619) >>> 0
  return hash >>> 0
}

function buildPrompt(spec) {
  return [
    'Use case: clean single-character portrait plate for a Remotion documentary edit',
    `Subject: ${spec.action}`,
    `Mood and lighting: ${spec.mood}; warm directional historical light, grounded documentary realism`,
    'Composition: one person only, centered or slightly off-center, waist-up or chest-up, enough negative space for animated name and narration graphics, 16:9 landscape',
    'Strict constraints: exactly one visible person; no other people, no crowd, no collage, no split-screen, no triptych, no text, no Chinese characters, no Latin letters, no Arabic numerals, no handwriting, no signs, no banners, no logos, no watermark, no UI, no modern objects',
    'Output: a single coherent clean image plate; all names, policy labels, captions, and titles will be added in Remotion',
  ].join('\n')
}

async function findExisting(spec) {
  const shot = storyboardByNumber.get(spec.storyboardNumber)
  if (!shot) throw new Error(`Missing storyboard ${spec.storyboardNumber}`)
  const rows = unwrap(await request(`${apiBase}/api/v1/images?storyboard_id=${shot.id}`))
  if (!Array.isArray(rows)) return null
  const frameType = `${framePrefix}-${spec.key}`
  return rows.find((row) => value(row, 'frameType', 'frame_type') === frameType) || null
}

async function submit(spec, configId) {
  const shot = storyboardByNumber.get(spec.storyboardNumber)
  const frameType = `${framePrefix}-${spec.key}`
  const existing = await findExisting(spec)
  const existingStatus = value(existing, 'status', 'status')
  const existingPath = value(existing, 'localPath', 'local_path')
  if (existing && existingStatus === 'completed' && existingPath) {
    return {
      key: spec.key,
      name: spec.name,
      storyboardNumber: spec.storyboardNumber,
      storyboardId: shot.id,
      generationId: existing.id,
      status: 'reused',
      prompt: value(existing, 'prompt', 'prompt') || buildPrompt(spec),
      localPath: existingPath,
      imageUrl: staticUrl(existingPath),
    }
  }

  const created = unwrap(await request(`${apiBase}/api/v1/images`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      drama_id: snapshot.episode.dramaId,
      episode_id: snapshot.episode.id,
      storyboard_id: shot.id,
      config_id: configId,
      aspect_ratio: '16:9',
      frame_type: frameType,
      seed: stableSeed(shot.id, spec.key),
      use_storyboard_prompt: false,
      prompt: buildPrompt(spec),
    }),
  }))
  if (!created?.id) throw new Error(`Image request for ${spec.key} did not return an id`)
  return {
    key: spec.key,
    name: spec.name,
    storyboardNumber: spec.storyboardNumber,
    storyboardId: shot.id,
    generationId: created.id,
    taskId: created.task_id || created.taskId || null,
    status: 'submitted',
    prompt: buildPrompt(spec),
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
    if (status === 'completed' && localPath) return { ...result, status: 'completed', localPath, imageUrl: staticUrl(localPath) }
    if (status === 'failed') {
      const error = value(row, 'errorMsg', 'error_msg') || value(row, 'lastErrorDetail', 'last_error_detail') || 'unknown image error'
      throw new Error(`Character ${result.key} generation failed: ${error}`)
    }
    process.stdout.write(`  character ${result.key}: ${status || 'pending'}\n`)
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw new Error(`Timed out waiting for character ${result.key}`)
}

async function main() {
  const configRows = unwrap(await request(`${apiBase}/api/v1/ai-configs?service_type=image`))
  if (!Array.isArray(configRows)) throw new Error('Image AI config response is not an array')
  const config = configRows.find((row) => {
    const models = Array.isArray(row.model) ? row.model : []
    return row.is_active !== false && row.provider === 'apimart' && models.includes('gpt-image-2')
  }) || configRows.find((row) => row.is_active !== false && row.provider === 'apimart')
  if (!config?.id) throw new Error('No active APIMart image config found')

  console.log(`Using image config ${config.id} (${config.provider}, gpt-image-2 character path)`)
  const results = []
  for (let index = 0; index < specs.length; index += 2) {
    const group = specs.slice(index, index + 2)
    const submitted = await Promise.all(group.map((spec) => submit(spec, config.id)))
    submitted.forEach((item) => console.log(`character ${item.key}: ${item.status} generation ${item.generationId}`))
    results.push(...await Promise.all(submitted.map(waitForImage)))
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    episodeId: snapshot.episode.id,
    dramaId: snapshot.episode.dramaId,
    framePrefix,
    configId: config.id,
    apiBase,
    characters: results,
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({ output: outputPath, characters: results.length, paths: results.map((item) => item.localPath) }, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
