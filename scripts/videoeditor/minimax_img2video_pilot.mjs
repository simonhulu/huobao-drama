#!/usr/bin/env node
/**
 * MiniMax 图生视频试点（评估用，非生产路径）。
 * 本地图片 → 768px JPEG data URI（与 backend normalizeVideoReferenceUrl 同规约）
 * → POST /v1/video_generation → 轮询 task → 下载 mp4。
 *
 * 用法:
 *   MINIMAX_KEY=<key> node minimax_img2video_pilot.mjs \
 *     --image <png> --prompt <text> --dur <6|10> --output <mp4>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'

const BASE_URL = 'https://api.minimaxi.com'
const MODEL = 'MiniMax-Hailuo-2.3'

/** 与 backend secret-crypto 同规约：从 sqlite 读 enc:v1 密文并解密（密钥不入上下文）。 */
function loadMinimaxKey() {
  const db = resolve('data/huobao_drama.db')
  const row = spawnSync('sqlite3', [db, 'select api_key from ai_service_configs where id=3'], { encoding: 'utf8' })
  if (row.status !== 0) fail(`sqlite3 failed: ${row.stderr}`)
  const value = row.stdout.trim()
  if (!value.startsWith('enc:v1:')) return value
  const keyFile = resolve('data/.ai-config-encryption-key')
  const raw = readFileSync(keyFile, 'utf8').trim()
  let key
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex')
  else {
    const decoded = Buffer.from(raw, 'base64')
    key = decoded.length === 32 ? decoded : createHash('sha256').update(raw, 'utf8').digest()
  }
  const [iv, tag, ciphertext] = value.slice('enc:v1:'.length).split(':').map((part) => Buffer.from(part, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function fail(message) {
  console.error(`minimax_img2video_pilot: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) fail(`Unexpected argument: ${key}`)
    options[key.slice(2).replaceAll('-', '_')] = argv[index + 1]
    index += 1
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (!options.image || !options.prompt || !options.output) {
  fail('Usage: minimax_img2video_pilot.mjs --image <png> --prompt <text> --dur <6|10> --output <mp4>')
}
const apiKey = process.env.MINIMAX_KEY || loadMinimaxKey()
const imagePath = resolve(options.image)
if (!existsSync(imagePath)) fail(`Image missing: ${imagePath}`)

// 768px JPEG q68 data URI（对齐 backend readImageAsCompressedDataUrl 行为）
const tmpJpeg = `/tmp/minimax-ref-${Date.now()}.jpg`
const conv = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-i', imagePath, '-vf', 'scale=768:-2', '-q:v', '4', tmpJpeg], { encoding: 'utf8' })
if (conv.status !== 0) fail(`ffmpeg convert failed: ${conv.stderr}`)
const dataUrl = `data:image/jpeg;base64,${readFileSync(tmpJpeg).toString('base64')}`

const dur = Number(options.dur || 6)
const body = {
  model: MODEL,
  prompt: options.prompt,
  first_frame_image: dataUrl,
  duration: dur,
  resolution: '768P',
}

console.log(JSON.stringify({ step: 'submit', prompt: options.prompt, dur, refBytes: dataUrl.length }))
let taskId = options.task
if (!taskId) {
  const submit = await fetch(`${BASE_URL}/v1/video_generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!submit.ok) fail(`submit HTTP ${submit.status}: ${(await submit.text()).slice(0, 500)}`)
  const submitted = await submit.json()
  taskId = submitted.task_id || submitted.id || submitted.data?.id
  if (!taskId) fail(`No task_id in response: ${JSON.stringify(submitted).slice(0, 500)}`)
}
console.log(JSON.stringify({ step: 'task', taskId }))

const deadline = Date.now() + 12 * 60_000
for (;;) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 15_000))
  const poll = await fetch(`${BASE_URL}/v1/query/video_generation?task_id=${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!poll.ok) {
    console.log(JSON.stringify({ step: 'poll', http: poll.status }))
    continue
  }
  const result = await poll.json()
  const status = result.status || result.state || result.data?.status
  console.log(JSON.stringify({ step: 'poll', status }))
  if (status === 'completed' || status === 'succeeded' || status === 'Success') {
    let videoUrl = result.video_url || result.data?.video_url || result.content?.video_url
    const fileId = result.file_id || result.data?.file_id
    if (!videoUrl && fileId) {
      const fileResp = await fetch(`${BASE_URL}/v1/files/retrieve?file_id=${fileId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (fileResp.ok) {
        const fileResult = await fileResp.json()
        videoUrl = fileResult.file?.download_url || fileResult.data?.download_url || fileResult.download_url
      }
    }
    if (!videoUrl) fail(`Completed but no video url: ${JSON.stringify(result).slice(0, 500)}`)
    const videoResp = await fetch(videoUrl)
    if (!videoResp.ok) fail(`download HTTP ${videoResp.status}`)
    writeFileSync(resolve(options.output), Buffer.from(await videoResp.arrayBuffer()))
    console.log(JSON.stringify({ step: 'done', output: resolve(options.output) }))
    process.exit(0)
  }
  if (status === 'failed' || status === 'error' || status === 'Failed' || status === 'Fail') {
    fail(`Generation failed: ${JSON.stringify(result).slice(0, 500)}`)
  }
  if (Date.now() > deadline) fail('Poll timeout (12min)')
}
