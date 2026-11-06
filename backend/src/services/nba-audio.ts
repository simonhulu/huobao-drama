import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { NbaCommand } from './nba-production.js'

interface AudioOptions { signal: AbortSignal; run: NbaCommand }
interface AudioMeasurement { loudnessLUFS: number; truePeakDbTP: number }
interface RepairAttempt { gainDb: number; measurement: AudioMeasurement }
const SAFE_PEAK = -1.5
const TARGET_PEAK = -2

async function fileHash(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename, { signal })) digest.update(chunk)
  return digest.digest('hex')
}

export async function measureNbaAudio(filename: string, options: AudioOptions): Promise<AudioMeasurement> {
  const measured = await options.run('ffmpeg', ['-nostdin', '-hide_banner', '-nostats', '-v', 'info', '-i', filename, '-map', '0:a:0', '-vn',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { signal: options.signal, timeout: 180000, maxBytes: 1024 * 1024 })
  const json = measured.stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0]
  if (!json) throw new Error('成片响度检测未返回有效信号数据，已保留成片')
  let data: any
  try { data = JSON.parse(json) } catch { throw new Error('成片响度检测数据无效，已保留成片') }
  if (data.input_i === '-inf' && data.input_tp === '-inf') throw new Error('成片音轨为静音，已保留成片和混音素材，需重新混音')
  const valid = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value))
  if (!valid(data.input_i) || !valid(data.input_tp)) throw new Error('成片响度检测数据无效，已保留成片')
  return { loudnessLUFS: Number(data.input_i), truePeakDbTP: Number(data.input_tp) }
}

async function videoHash(filename: string, options: AudioOptions) {
  const result = await options.run('ffmpeg', ['-nostdin', '-v', 'error', '-i', filename, '-map', '0:v:0', '-c:v', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-'],
    { signal: options.signal, timeout: 120000, maxBytes: 4096 })
  const digest = result.stdout.toString().match(/SHA256=([^\s]+)/)?.[1]
  if (!digest) throw new Error('音轨修复未能核验画面数据，原片已保留')
  return digest
}

/** Leave the source intact until the producer has verified and promoted the candidate. */
export async function prepareNbaAudio(filename: string, options: AudioOptions & { directory: string; progress?: (message: string) => void }) {
  options.signal.throwIfAborted()
  const sourceSha256 = await fileHash(filename, options.signal), reportPath = path.join(options.directory, 'audio-recovery.json')
  let report: any
  try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')) } catch { /* First measurement. */ }
  const save = async (value: unknown) => {
    const temporary = `${reportPath}.${randomUUID()}.tmp`
    await fs.mkdir(options.directory, { recursive: true })
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
    await fs.rename(temporary, reportPath)
  }
  let before: AudioMeasurement
  try { before = await measureNbaAudio(filename, options) }
  catch (error) {
    options.signal.throwIfAborted()
    await save({ ...(report?.sourceSha256 === sourceSha256 ? report : { status: 'measurement-failed', sourceSha256 }), lastMeasurementError: (error as Error).message })
    throw error
  }
  if (before.truePeakDbTP <= SAFE_PEAK) {
    // Keep prior recovery evidence when verifying its promoted output.
    if (report?.outputSha256 !== sourceSha256) await save({ status: 'passed', sourceSha256, before })
    return { path: filename, measurement: before, evidencePath: reportPath }
  }
  const output = path.join(options.directory, `audio-safe-${sourceSha256.slice(0, 16)}.mp4`)
  if (report?.sourceSha256 === sourceSha256 && report.status === 'recovered' && report.outputPath === output
    && await fileHash(output, options.signal).catch(() => '') === report.outputSha256) {
    const measurement = await measureNbaAudio(output, options)
    if (measurement.truePeakDbTP <= SAFE_PEAK) return { path: output, measurement, evidencePath: reportPath }
  }
  const attempts: RepairAttempt[] = report?.sourceSha256 === sourceSha256 && Array.isArray(report.attempts) ? report.attempts : []
  const originalVideoHash = await videoHash(filename, options)
  while (attempts.length < 2) {
    const last = attempts.at(-1)
    const gainDb = Number((last ? last.gainDb + TARGET_PEAK - last.measurement.truePeakDbTP - .5 : TARGET_PEAK - before.truePeakDbTP).toFixed(2))
    options.progress?.(`音轨真峰值${before.truePeakDbTP.toFixed(2)} dBTP，正在自动修复并复检（${attempts.length + 1}/2），保留画面及现场声比例`)
    await save({ status: 'repairing', sourceSha256, before, attempts, gainDb })
    const temporary = path.join(options.directory, `audio-repair-${randomUUID()}.mp4`)
    try {
      await options.run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', filename, '-map', '0:v:0', '-map', '0:a:0',
        '-map_metadata', '0', '-c:v', 'copy', '-af', `volume=${gainDb}dB`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', temporary],
      { signal: options.signal, timeout: 180000, maxBytes: 1024 * 1024 })
      const measurement = await measureNbaAudio(temporary, options)
      attempts.push({ gainDb, measurement })
      if (await videoHash(temporary, options) !== originalVideoHash) throw new Error('音轨修复后的画面数据发生变化，原片已保留')
      if (measurement.truePeakDbTP <= SAFE_PEAK) {
        options.signal.throwIfAborted()
        await fs.rename(temporary, output)
        await save({ status: 'recovered', sourceSha256, before, attempts, after: measurement, outputPath: output,
          outputSha256: await fileHash(output, options.signal), videoPacketsUnchanged: true, targetTruePeakDbTP: TARGET_PEAK })
        return { path: output, measurement, evidencePath: reportPath }
      }
      await save({ status: 'pending', sourceSha256, before, attempts })
    } finally { await fs.rm(temporary, { force: true }) }
  }
  await save({ status: 'failed', sourceSha256, before, attempts })
  throw new Error(`两次自动修复后真峰值仍未达到安全余量（${attempts.at(-1)!.measurement.truePeakDbTP.toFixed(2)} dBTP），原片与测量记录已保留`)
}
