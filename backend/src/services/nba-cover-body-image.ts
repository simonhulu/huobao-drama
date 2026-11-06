import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { z } from 'zod'

const METHOD = 'nba-body-photo-cleanup-v2'
const CLEANUP_REVISION = 4
const INSPECTION_REVISION = 2
const INSPECTION_MODEL = 'gpt-6.1-terra'
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const execute = promisify(execFile)
const coordinate = z.number().finite().min(0).max(1)
const rectangle = z.object({ x: coordinate, y: coordinate, width: coordinate.positive(), height: coordinate.positive() })
  .refine(box => box.x + box.width <= 1.001 && box.y + box.height <= 1.001, 'Rectangle outside photograph')
const inspectionSchema = z.object({
  teamMatches: z.boolean(), confidence: z.enum(['high', 'low']),
  framing: z.enum(['headshot', 'upper-body', 'full-body', 'unclear']),
  torsoAndArmsVisible: z.boolean(), visibleTeam: z.string().max(100), reason: z.string().max(500),
  crop: rectangle.nullable(),
  commercialRegions: z.array(rectangle.and(z.object({ label: z.string().min(1).max(100) }))).max(20),
})
export type NbaBodyInspection = z.infer<typeof inspectionSchema>
export interface NbaBodyPhotoInput {
  filename: string
  playerName: string
  teamName: string
  teamAbbreviation: string
  signal: AbortSignal
}
export interface NbaBodyPhotoResult {
  path: string; sha256: string; width: number; height: number
  crop?: { x: number; y: number; width: number; height: number }
  verification: Record<string, unknown>
}
export interface NbaBodyPhotoOptions {
  repairMarks?: boolean
  inspect?: (input: NbaBodyPhotoInput, image: Buffer) => Promise<NbaBodyInspection>
  clean?: (input: { source: string; regionsFile: string; output: string; signal: AbortSignal }) => Promise<void>
}

async function inspectPhoto(input: NbaBodyPhotoInput, image: Buffer): Promise<NbaBodyInspection> {
  const { callTextModel } = await import('./ai.js')
  const { width = 0, height = 0 } = await sharp(image).metadata()
  const lines: string[] = []
  for (let index = 1; index < 10; index++) {
    const x = Math.round(width * index / 10), y = Math.round(height * index / 10)
    lines.push(`<path d="M ${x} 0 V ${height} M 0 ${y} H ${width}"/><text x="${x + 2}" y="14">${index / 10}</text><text x="2" y="${y - 2}">${index / 10}</text>`)
  }
  const grid = await sharp(image).composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><g fill="#00ffff" stroke="#00ffff" stroke-width=".5" font-family="Arial" font-size="12" opacity=".6">${lines.join('')}</g></svg>`) }]).png().toBuffer()
  const system = `你是体育封面图片素材检查员，只检查图片，不审核新闻稿。输入的名字和球队用于匹配已有真实照片，不得画图或建议伪造身体。
返回严格JSON：teamMatches:boolean, confidence:"high"|"low", framing:"headshot"|"upper-body"|"full-body"|"unclear", torsoAndArmsVisible:boolean, visibleTeam:string, reason:string, crop:{x,y,width,height}|null, commercialRegions:[{x,y,width,height,label}]。
只有图片里球衣的实际球队与输入球队一致时teamMatches才为true。球员资料写当前球队不代表旧图片也是当前球队：例如雄鹿MILWAUKEE不能当热火MIAMI。仅凭球衣颜色不能高置信判断。双肩、上臂的一部分及胸部球衣清晰可见即可算upper-body且torsoAndArmsVisible为true；站姿半身照不要求腹部、肘部、下臂或双手入镜。头颈证件照和仅锁骨的一小段球衣属于headshot，不能通过。
所有坐标按完整输入图片归一化到0至1。crop可选择照片实际具备的半身或全身构图，必须保留完整头部、肩膀以及原图中可见的动作手臂、手和篮球，不得裁成大头像；原图已是合格半身或无法保留可见动作时crop为null保留原图。
commercialRegions仅圈出额外叠加的水印、网址、二维码或推广文字。球衣、篮球和鞋上的自然品牌保留，不作为需要消除的推广。不要覆盖脸、皮肤、手或身体。保留球队名称、队服主要图案、号码和真实姿态。
第一张是原始照片，第二张叠加0.1间隔的归一化坐标网格供精确定位。按网格核对每个矩形的实际位置，禁止把相邻领口当作胸标、禁止圈住整个球。若无标识则空数组。只判断真实图片可见内容。`
  const text = JSON.stringify({ playerName: input.playerName, team: input.teamName, abbreviation: input.teamAbbreviation, imageWidth: width, imageHeight: height })
  const raw = await callTextModel([{ role: 'system', content: system }, { role: 'user', content: text }], {
    temperature: 0, maxTokens: 2600, requireComplete: true, responseFormat: { type: 'json_object' },
    extraBody: { model: INSPECTION_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: [
      { type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}`, detail: 'high' } },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${grid.toString('base64')}`, detail: 'high' } },
    ] }] }, signal: AbortSignal.any([input.signal, AbortSignal.timeout(90000)]),
  })
  return inspectionSchema.parse(JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')))
}

async function cleanPhoto(input: { source: string; regionsFile: string; output: string; signal: AbortSignal }) {
  let python = process.env.NBA_COVER_PYTHON || process.env.NBA_AUDIO_PYTHON
  if (!python && await fs.stat('/tmp/vDdPLHaKK4k-audio-env/bin/python').catch(() => null)) python = '/tmp/vDdPLHaKK4k-audio-env/bin/python'
  await execute(python || 'python3', [fileURLToPath(new URL('../../../scripts/nba-video/clean-player-photo.py', import.meta.url)),
    '--input', input.source, '--regions', input.regionsFile, '--output', input.output], { signal: input.signal, timeout: 45000, maxBuffer: 1024 * 1024 })
}

async function atomic(file: string, bytes: string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, file) }
  finally { await fs.unlink(temporary).catch(() => {}) }
}

/** Preserve real body pixels; only small, explicitly identified branding regions may change. */
export async function prepareNbaBodyImage(input: NbaBodyPhotoInput, options: NbaBodyPhotoOptions = {}): Promise<NbaBodyPhotoResult | null> {
  input.signal.throwIfAborted()
  const source = await fs.readFile(input.filename), metadata = await sharp(source, { limitInputPixels: 16_000_000 }).metadata()
  if (metadata.format !== 'png' || !metadata.hasAlpha || !metadata.width || !metadata.height || metadata.width < 240 || metadata.height < 240) return null
  const sourceSha256 = hash(source), identity = [METHOD, INSPECTION_REVISION, INSPECTION_MODEL, sourceSha256, input.playerName, input.teamName, input.teamAbbreviation]
  if (options.repairMarks) identity.push('repair-marks')
  const inputHash = hash(JSON.stringify(identity))
  const prefix = path.join(path.dirname(input.filename), `body-${inputHash.slice(0, 20)}`), checkpointPath = `${prefix}.json`
  let inspection: NbaBodyInspection | undefined
  try {
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'))
    if (checkpoint.inputHash !== inputHash || checkpoint.method !== METHOD) throw new Error('Changed body photograph')
    inspection = inspectionSchema.parse(checkpoint.inspection)
    if (!checkpoint.accepted) { input.signal.throwIfAborted(); return null }
    if (checkpoint.cleanupRevision !== CLEANUP_REVISION) throw new Error('Changed local photo repair')
    const result = checkpoint.result as NbaBodyPhotoResult
    if (result.path !== `${prefix}.png` || hash(await fs.readFile(result.path)) !== result.sha256) throw new Error('Changed cleaned photograph')
    input.signal.throwIfAborted(); return result
  } catch { input.signal.throwIfAborted() }
  inspection ||= inspectionSchema.parse(await (options.inspect || inspectPhoto)(input, source))
  input.signal.throwIfAborted()
  const accepted = inspection.teamMatches && inspection.confidence === 'high' && inspection.torsoAndArmsVisible
    && ['upper-body', 'full-body'].includes(inspection.framing)
  // Cache only a completed visual decision; network/model errors are retried on the next call.
  if (!accepted) {
    await atomic(checkpointPath, JSON.stringify({ method: METHOD, inputHash, accepted: false, inspection }, null, 2))
    return null
  }
  const regions = options.repairMarks ? inspection.commercialRegions : []
  if (regions.some(box => box.width * box.height > .04)
    || regions.reduce((sum, box) => sum + box.width * box.height, 0) > .16) {
    throw new Error('商业标识修补区域过大，不能改动大面积真实身体')
  }
  // A crop must leave most of the source height and width, not just its face.
  const crop = inspection.crop && inspection.crop.width >= .35 && inspection.crop.height >= .48 ? inspection.crop : undefined
  const output = `${prefix}.png`, temporary = `${prefix}.${randomUUID()}.pending.png`, regionsFile = `${prefix}.regions.json`
  try {
    if (regions.length) {
      await atomic(regionsFile, JSON.stringify(regions))
      await (options.clean || cleanPhoto)({ source: input.filename, regionsFile, output: temporary, signal: input.signal })
    } else await fs.writeFile(temporary, source)
    input.signal.throwIfAborted()
    const bytes = await fs.readFile(temporary), image = await sharp(bytes).metadata()
    if (image.width !== metadata.width || image.height !== metadata.height || image.format !== 'png' || !image.hasAlpha) throw new Error('修补后的真实人物照片尺寸或透明通道无效')
    const before = await sharp(source).ensureAlpha().raw().toBuffer(), after = await sharp(bytes).ensureAlpha().raw().toBuffer()
    for (let y = 0; y < metadata.height; y++) for (let x = 0; x < metadata.width; x++) {
      const index = (y * metadata.width + x) * 4
      if (before[index + 3] !== after[index + 3]) throw new Error('商业标识修补改变了人物轮廓')
      if (before[index] === after[index] && before[index + 1] === after[index + 1] && before[index + 2] === after[index + 2]) continue
      const allowed = regions.some(box => x >= Math.floor(box.x * metadata.width!) - 3 && x < Math.ceil((box.x + box.width) * metadata.width!) + 3
        && y >= Math.floor(box.y * metadata.height!) - 3 && y < Math.ceil((box.y + box.height) * metadata.height!) + 3)
      if (!allowed) throw new Error('修补改变了标识区域之外的真实人物像素')
    }
    await fs.rename(temporary, output)
    const result: NbaBodyPhotoResult = { path: output, sha256: hash(bytes), width: metadata.width, height: metadata.height,
      ...(crop ? { crop } : {}), verification: { method: METHOD, inspectionRevision: INSPECTION_REVISION, cleanupRevision: CLEANUP_REVISION, sourceSha256, framing: inspection.framing, visibleTeam: inspection.visibleTeam,
        teamMatches: true, realPhoto: true, posePreserved: true, untouchedPixelsVerified: true, cleanedRegions: regions.length } }
    await atomic(checkpointPath, JSON.stringify({ method: METHOD, cleanupRevision: CLEANUP_REVISION, inputHash, accepted: true, inspection, result }, null, 2))
    return result
  } finally { await fs.unlink(temporary).catch(() => {}) }
}
