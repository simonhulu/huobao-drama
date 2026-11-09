import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'

export const SCIENCE_COVER_COMPOSITION_VERSION = 2
const execute = promisify(execFile)
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const defaultPresenter = fileURLToPath(new URL('../../../data/science-pop/assets/xiaolu-presenter.png', import.meta.url))
const defaultCoverPresenter = fileURLToPath(new URL('../../../data/science-pop/assets/xiaolu-cover-presenter.png', import.meta.url))
export interface ScienceCoverPresenterSource { path: string; sha256: string }
export interface ScienceCoverPresenter extends ScienceCoverPresenterSource { width: number; height: number }

export async function scienceCoverPresenterAlpha(mask: Buffer, width: number, height: number) {
  const alpha = await sharp(mask).resize(width, height).removeAlpha().greyscale().raw().toBuffer()
  for (let i = 0; i < alpha.length; i++) alpha[i] = alpha[i]! < 12 ? 0 : alpha[i]! > 245 ? 255 : alpha[i]!
  if (alpha.length !== width * height || !alpha.some(value => value === 0) || !alpha.some(value => value > 200)) {
    throw new Error('主播分割未得到有效透明轮廓，请检查原照')
  }
  return alpha
}

export async function scienceCoverPresenterCutout(source: Buffer, alpha: Buffer, width: number, height: number) {
  const rgb = await sharp(source).toColourspace('srgb').removeAlpha().raw().toBuffer()
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } }).png().toBuffer()
}

export async function resolveScienceCoverPresenter(presenterPath?: string): Promise<ScienceCoverPresenterSource> {
  const curated = await fs.stat(defaultCoverPresenter).then(file => file.isFile()).catch(() => false)
  const file = path.resolve(presenterPath || process.env.SCIENCE_COVER_PRESENTER_PATH || (curated ? defaultCoverPresenter : defaultPresenter))
  try {
    const bytes = await fs.readFile(file), metadata = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata()
    if (!metadata.width || !metadata.height || metadata.width < 200 || metadata.height < 300) throw new Error('invalid dimensions')
    return { path: file, sha256: hash(bytes) }
  } catch (error) { throw new Error('主播封面原照不可用，请恢复主播素材后继续封面生成', { cause: error }) }
}

/** The matte changes alpha only. Every visible face/body pixel comes from the actual source photograph. */
export async function prepareScienceCoverPresenter(source: ScienceCoverPresenterSource, signal: AbortSignal): Promise<ScienceCoverPresenter> {
  signal.throwIfAborted()
  const bytes = await fs.readFile(source.path)
  if (hash(bytes) !== source.sha256) throw new Error('主播原照已变化，请重新核对素材')
  const directory = path.join(path.dirname(source.path), '.cover-presenter')
  const prefix = path.join(directory, `person-v3-${source.sha256}`), output = `${prefix}.png`, checkpoint = `${prefix}.json`
  try {
    const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8')) as ScienceCoverPresenter
    if (saved.path === output && saved.sha256 === hash(await fs.readFile(output)) && saved.width > 0 && saved.height > 0) return saved
  } catch { signal.throwIfAborted() }
  await fs.mkdir(directory, { recursive: true })
  const mask = `${prefix}.${randomUUID()}.mask.png`, temporary = `${prefix}.${randomUUID()}.pending.png`
  try {
    const metadata = await sharp(bytes).metadata()
    let cutout = sharp(bytes).toColourspace('srgb').ensureAlpha()
    const stats = metadata.hasAlpha ? await sharp(bytes).stats() : undefined
    if (!stats || stats.channels.at(-1)!.min === 255) {
      if (process.platform !== 'darwin') throw new Error('主播原照需要透明背景；当前主机请配置已抠图的 SCIENCE_COVER_PRESENTER_PATH')
      const script = fileURLToPath(new URL('../../scripts/science-cover-person-mask.m', import.meta.url))
      const executable = path.join(directory, `person-mask-${process.arch}-${hash(await fs.readFile(script)).slice(0, 20)}`)
      if (!await fs.stat(executable).then(file => file.isFile()).catch(() => false)) {
        const compiling = `${executable}.${randomUUID()}.tmp`
        try {
          await execute('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'Vision',
            '-framework', 'CoreImage', script, '-o', compiling], { signal, timeout: 120_000, maxBuffer: 1024 * 1024 })
          await fs.rename(compiling, executable)
        } finally { await fs.rm(compiling, { force: true }) }
      }
      await execute(executable, [source.path, mask], { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
      const alpha = await scienceCoverPresenterAlpha(await fs.readFile(mask), metadata.width!, metadata.height!)
      cutout = sharp(await scienceCoverPresenterCutout(bytes, alpha, metadata.width!, metadata.height!))
    }
    await cutout.trim({ background: '#00000000', threshold: 12 }).png().toFile(temporary)
    const result = await sharp(temporary).metadata(), opacity = (await sharp(temporary).stats()).channels.at(-1)!
    if (!result.hasAlpha || !result.width || !result.height || result.width < 100 || result.height < 200 || opacity.max === 0 || opacity.mean < 5) throw new Error('主播抠图未检测到完整人物，请检查主播原照')
    signal.throwIfAborted()
    const prepared = { path: output, sha256: hash(await fs.readFile(temporary)), width: result.width, height: result.height }
    await fs.rename(temporary, output)
    const savedTemporary = `${checkpoint}.${randomUUID()}.tmp`
    try { await fs.writeFile(savedTemporary, JSON.stringify(prepared)); await fs.rename(savedTemporary, checkpoint) }
    finally { await fs.rm(savedTemporary, { force: true }) }
    return prepared
  } finally { await fs.rm(mask, { force: true }); await fs.rm(temporary, { force: true }) }
}

export function scienceCoverPresenterPlacement(format: { width: number; height: number }, person: { width: number; height: number }, textSide: 'text-left' | 'text-right') {
  const landscape = format.width >= format.height
  const inset = Math.round(format.width * .035)
  const height = Math.round(format.height * (landscape ? .58 : .46))
  const width = Math.min(Math.round(height * person.width / person.height), Math.round(format.width * (landscape ? .28 : .40)))
  const fittedHeight = Math.min(height, Math.round(width * person.height / person.width))
  return { width, height: fittedHeight, left: landscape && textSide === 'text-right' ? inset : format.width - inset - width,
    top: format.height - fittedHeight }
}

export async function composeScienceCoverPresenter(basePath: string, presenter: ScienceCoverPresenter, format: { width: number; height: number }, textSide: 'text-left' | 'text-right', output: string) {
  const box = scienceCoverPresenterPlacement(format, presenter, textSide)
  const metadata = await sharp(basePath).metadata(), landscape = format.width >= format.height
  const sourceWidth = metadata.width!, sourceHeight = metadata.height!
  // The original photography reserves one title side. Fit its subject into a separate
  // safe area so adding the host cannot cover an animal's face or the topic's key object.
  const crop = landscape ? { left: textSide === 'text-left' ? Math.round(sourceWidth * .45) : 0, top: 0,
    width: Math.floor(sourceWidth * .55), height: sourceHeight }
    : { left: 0, top: Math.round(sourceHeight * .43), width: sourceWidth, height: Math.floor(sourceHeight * .57) }
  const subjectBox = landscape ? { width: Math.round(format.width * .46), height: Math.round(format.height * .70),
    left: textSide === 'text-left' ? Math.round(format.width * .51) : Math.round(format.width * .03), top: Math.round(format.height * .02) }
    : { width: Math.round(format.width * .54), height: Math.round(format.height * .46), left: Math.round(format.width * .03), top: Math.round(format.height * .54) }
  const subject = await sharp(basePath).extract(crop).resize(subjectBox.width, subjectBox.height,
    { fit: 'contain', background: '#000000' }).png().toBuffer()
  const photograph = await sharp(presenter.path).resize(box.width, box.height, { fit: 'fill' }).png().toBuffer()
  await sharp({ create: { ...format, channels: 3, background: '#000000' } }).composite([
    { input: subject, left: subjectBox.left, top: subjectBox.top }, { input: photograph, left: box.left, top: box.top },
  ]).png().toFile(output)
}
