import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { prepareNbaCover } from './nba-cover.js'
import type { NbaCommand } from './nba-production.js'

const METHOD = 'sports-topic-frame-title-v1'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const formats = [{ key: 'landscape', width: 1920, height: 1080 }, { key: 'portrait', width: 1080, height: 1440 }] as const
export interface NbaTopicCoverInput {
  videoPath: string
  sourceSha256: string
  sourceVideoId: string
  headline: string
  directory: string
  signal: AbortSignal
  run: NbaCommand
}
export interface NbaTopicCoverResult {
  path: string
  portraitPath: string
  evidence: { method: typeof METHOD; inputHash: string; sourceVideoId: string; sourceSha256: string; headline: string;
    sourceWidth: number; sourceHeight: number; frameTimeSeconds: number;
    outputs: Record<'landscape' | 'portrait', { width: number; height: number; sha256: string }> }
}
const escapeXml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)

export function buildNbaTopicTitleSvg(headline: string, width: number, height: number) {
  const portrait = height > width, size = portrait ? 66 : 82, margin = portrait ? 48 : 76
  const characters = [...headline.replace(/\s+/g, ' ').trim()], capacity = Math.floor((width - margin * 2) / size)
  const lines: string[] = []
  for (let index = 0; index < characters.length; index += capacity) lines.push(characters.slice(index, index + capacity).join(''))
  const fontSize = Math.min(size, (height * .34 - 60) / Math.max(1, lines.length) / 1.22)
  const panelHeight = Math.max(height * .2, lines.length * fontSize * 1.22 + 62)
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${panelHeight}" fill="#242424" fill-opacity=".94"/>${lines.map((line, index) => `<text x="${margin}" y="${40 + fontSize + index * fontSize * 1.22}" fill="${index ? '#ffffff' : '#ffe369'}" font-family="PingFang SC,Noto Sans CJK SC,Microsoft YaHei,sans-serif" font-size="${fontSize}" font-weight="800">${escapeXml(line)}</text>`).join('')}</svg>`)
}

async function atomic(filename: string, contents: Buffer | string) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, contents); await fs.rename(temporary, filename) }
  finally { await fs.unlink(temporary).catch(() => {}) }
}

export async function prepareNbaTopicCover(input: NbaTopicCoverInput): Promise<NbaTopicCoverResult> {
  input.signal.throwIfAborted()
  if (!input.headline.trim() || input.headline.length > 120) throw Error('体育主题封面需要有效中文标题')
  const inputHash = hash(JSON.stringify([METHOD, input.sourceVideoId, input.sourceSha256, input.headline]))
  const base = path.join(input.directory, `cover-topic-${inputHash.slice(0, 16)}`), evidencePath = `${base}.json`
  try {
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8')) as NbaTopicCoverResult['evidence']
    const files = formats.map(format => `${base}-${format.key}.png`)
    if (evidence.method === METHOD && evidence.inputHash === inputHash && (await Promise.all(files.map(async (filename, index) => {
      const bytes = await fs.readFile(filename), info = await sharp(bytes).metadata(), format = formats[index]
      return info.width === format.width && info.height === format.height && hash(bytes) === evidence.outputs[format.key].sha256
    }))).every(Boolean)) return { path: files[0], portraitPath: files[1], evidence }
  } catch { input.signal.throwIfAborted() }
  await fs.mkdir(input.directory, { recursive: true })
  const probe = JSON.parse((await input.run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input.videoPath], { signal: input.signal, timeout: 20000 })).stdout.toString())
  const video = probe.streams?.find((stream: any) => stream.codec_type === 'video'), duration = Number(video?.duration || probe.format?.duration)
  if (!video || !Number.isFinite(duration) || duration <= 4) throw Error('主题封面视频缺少有效画面或时长')
  const frame = await prepareNbaCover({ source: { id: input.sourceVideoId, path: input.videoPath, sha256: input.sourceSha256, width: video.width, height: video.height },
    sourceStart: 0, sourceEnd: Math.max(1, duration - 4), filename: `${base}-frame.png`, signal: input.signal, run: input.run })
  const outputs = {} as NbaTopicCoverResult['evidence']['outputs']
  for (const format of formats) {
    input.signal.throwIfAborted()
    const bytes = await sharp(frame.path).resize(format.width, format.height, { fit: 'cover', position: 'attention' })
      .composite([{ input: buildNbaTopicTitleSvg(input.headline, format.width, format.height) }]).png().toBuffer()
    await atomic(`${base}-${format.key}.png`, bytes)
    outputs[format.key] = { width: format.width, height: format.height, sha256: hash(bytes) }
  }
  const evidence: NbaTopicCoverResult['evidence'] = { method: METHOD, inputHash, sourceVideoId: input.sourceVideoId,
    sourceSha256: input.sourceSha256, headline: input.headline, sourceWidth: video.width, sourceHeight: video.height,
    frameTimeSeconds: frame.evidence.timeSeconds, outputs }
  await atomic(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  return { path: `${base}-landscape.png`, portraitPath: `${base}-portrait.png`, evidence }
}
