import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { NbaCommand } from './nba-production.js'

const METHOD = 'source-frame-sharpness-v1'
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')

interface FrameScore { timeSeconds: number; sharpness: number; mean: number; contrast: number; usable: boolean }
export interface NbaCoverEvidence {
  version: 1
  method: typeof METHOD
  sourceVideoId: string
  sourceSha256: string
  sourceRange: { start: number; end: number }
  timeSeconds: number
  width: number
  height: number
  format: 'png'
  sha256: string
  candidates: FrameScore[]
}
export interface NbaCoverInput {
  source: { id: string; path: string; sha256: string; width: number; height: number }
  sourceStart: number
  sourceEnd: number
  filename: string
  signal: AbortSignal
  run: NbaCommand
}

async function writeAtomic(filename: string, value: Buffer | string) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, value); await fs.rename(temporary, filename) }
  finally { await fs.unlink(temporary).catch(() => {}) }
}

async function scoreFrame(frame: Buffer, source: NbaCoverInput['source']) {
  const image = sharp(frame, { failOn: 'error' }), metadata = await image.metadata()
  if (metadata.width !== source.width || metadata.height !== source.height || metadata.format !== 'png') {
    throw new Error('封面截帧与素材原生尺寸不一致，不能放大小图代替高清封面')
  }
  // Score the center of the picture so the sharp broadcast scorebar cannot win by itself.
  const left = Math.round(source.width * .1), top = Math.round(source.height * .08)
  const { data, info } = await image.extract({ left, top, width: Math.round(source.width * .8), height: Math.round(source.height * .72) })
    .resize({ width: 640, withoutEnlargement: true }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true })
  let sum = 0, squares = 0, lapSum = 0, lapSquares = 0, count = 0
  for (const value of data) { sum += value; squares += value * value }
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
    const i = y * info.width + x, lap = data[i - 1] + data[i + 1] + data[i - info.width] + data[i + info.width] - 4 * data[i]
    lapSum += lap; lapSquares += lap * lap; count++
  }
  const mean = sum / data.length, contrast = Math.sqrt(Math.max(0, squares / data.length - mean * mean))
  return { sharpness: Math.max(0, lapSquares / count - (lapSum / count) ** 2), mean, contrast,
    usable: mean > 12 && mean < 243 && contrast > 5 }
}

export async function prepareNbaCover(input: NbaCoverInput): Promise<{ path: string; evidence: NbaCoverEvidence }> {
  const { source, sourceStart, sourceEnd, filename, signal } = input
  signal.throwIfAborted()
  if (!(sourceStart >= 0) || !(sourceEnd > sourceStart) || !Number.isFinite(sourceEnd)
    || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 16 || source.height < 16) {
    throw new Error('高清封面缺少有效的原始素材尺寸或取帧区间')
  }
  const evidencePath = `${filename}.json`
  try {
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8')) as NbaCoverEvidence
    const image = await sharp(filename).metadata()
    if (evidence.method === METHOD && evidence.sourceSha256 === source.sha256 && evidence.sourceVideoId === source.id
      && evidence.sourceRange.start === sourceStart && evidence.sourceRange.end === sourceEnd
      && evidence.width === source.width && evidence.height === source.height && image.width === source.width && image.height === source.height
      && image.format === 'png' && digest(await fs.readFile(filename)) === evidence.sha256) {
      signal.throwIfAborted(); return { path: filename, evidence }
    }
  } catch { signal.throwIfAborted() }
  await fs.mkdir(path.dirname(filename), { recursive: true })
  let best: { frame: Buffer; score: FrameScore } | undefined
  const candidates: FrameScore[] = []
  for (let index = 0; index < 8; index++) {
    signal.throwIfAborted()
    const timeSeconds = Number((sourceStart + (sourceEnd - sourceStart) * (.08 + .84 * index / 7)).toFixed(7))
    const { stdout: frame } = await input.run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', timeSeconds.toFixed(7), '-i', source.path,
      '-frames:v', '1', '-an', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], { signal, timeout: 30000 })
    const score = { timeSeconds, ...await scoreFrame(frame, source) }
    candidates.push(score)
    if (score.usable && (!best || score.sharpness > best.score.sharpness)) best = { frame, score }
  }
  if (!best) throw new Error('未找到明亮且有清晰细节的原始视频封面帧，请检查源素材')
  signal.throwIfAborted()
  const evidence: NbaCoverEvidence = { version: 1, method: METHOD, sourceVideoId: source.id, sourceSha256: source.sha256,
    sourceRange: { start: sourceStart, end: sourceEnd }, timeSeconds: best.score.timeSeconds, width: source.width, height: source.height,
    format: 'png', sha256: digest(best.frame), candidates }
  await writeAtomic(filename, best.frame)
  await writeAtomic(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  return { path: filename, evidence }
}
