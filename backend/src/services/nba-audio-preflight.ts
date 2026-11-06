import type { NbaCommand } from './nba-production.js'

interface AudioRuntime { signal: AbortSignal; run: NbaCommand }
export interface NbaAudioSilence { startSeconds: number; endSeconds: number }
export interface NbaAudioWindow {
  startSeconds: number
  durationSeconds: number
  rmsDbFS: number
  samplePeakDbFS: number
  audibleFraction: number
  longestSilenceSeconds: number
  silences: NbaAudioSilence[]
}
const RATE = 16000
const CHANNELS = 2
const SILENCE_DB = -50
const FINAL_FADE_ALLOWANCE = 1.15
const round = (value: number) => Math.round(value * 10000) / 10000
const db = (value: number) => round(20 * Math.log10(Math.max(value, 1e-12)))

export class NbaAudioPreflightError extends Error {
  constructor(message: string, readonly evidence: Record<string, unknown>) { super(message); this.name = 'NbaAudioPreflightError' }
}

async function samples(filename: string, startSeconds: number, durationSeconds: number, options: AudioRuntime, rate = RATE, channels = CHANNELS) {
  options.signal.throwIfAborted()
  const result = await options.run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', startSeconds.toFixed(7), '-i', filename, '-t', durationSeconds.toFixed(7),
    '-vn', '-ar', String(rate), '-ac', String(channels), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
  { signal: options.signal, timeout: 30000, maxBytes: 4 * 1024 * 1024 })
  const actualDuration = result.stdout.length / 4 / rate / channels
  if (result.stdout.length % 4 || actualDuration < durationSeconds - .12 || actualDuration > durationSeconds + .12) {
    throw new NbaAudioPreflightError('音频采样不足或长度异常，不能核验首尾声音', { filename, startSeconds, requestedDurationSeconds: durationSeconds, actualDurationSeconds: actualDuration })
  }
  const values = new Float32Array(result.stdout.length / 4)
  for (let index = 0; index < values.length; index++) {
    const value = result.stdout.readFloatLE(index * 4)
    if (!Number.isFinite(value)) throw new NbaAudioPreflightError('音频包含非有限采样，已停止交付', { filename, startSeconds, nonfiniteSampleIndex: index })
    values[index] = value
  }
  return values
}

export async function inspectNbaAudioWindow(filename: string, startSeconds: number, durationSeconds: number, options: AudioRuntime): Promise<NbaAudioWindow> {
  const pcm = await samples(filename, startSeconds, durationSeconds, options)
  const blockSize = RATE * CHANNELS * .02, silences: NbaAudioSilence[] = []
  let energy = 0, peak = 0
  for (let start = 0; start < pcm.length; start += blockSize) {
    const end = Math.min(start + blockSize, pcm.length)
    let blockEnergy = 0
    for (let index = start; index < end; index++) {
      const value = pcm[index]
      energy += value * value; blockEnergy += value * value; peak = Math.max(peak, Math.abs(value))
    }
    if (db(Math.sqrt(blockEnergy / (end - start))) < SILENCE_DB) {
      const beginning = start / RATE / CHANNELS, ending = end / RATE / CHANNELS
      if (silences.at(-1) && Math.abs(silences.at(-1)!.endSeconds - beginning) < .001) silences.at(-1)!.endSeconds = ending
      else silences.push({ startSeconds: beginning, endSeconds: ending })
    }
  }
  const actualDuration = pcm.length / RATE / CHANNELS
  return { startSeconds, durationSeconds: round(actualDuration), rmsDbFS: db(Math.sqrt(energy / pcm.length)), samplePeakDbFS: db(peak),
    audibleFraction: round(1 - silences.reduce((sum, item) => sum + item.endSeconds - item.startSeconds, 0) / actualDuration),
    longestSilenceSeconds: round(Math.max(0, ...silences.map(item => item.endSeconds - item.startSeconds))),
    silences: silences.map(item => ({ startSeconds: round(item.startSeconds), endSeconds: round(item.endSeconds) })) }
}

export async function selectNbaClosingAudio(input: { audioPath: string; closingStartSeconds: number; closingDurationSeconds: number; liveEndSeconds: number; sourceDurationSeconds: number }, options: AudioRuntime) {
  const candidates: Array<{ sourceStartSeconds: number; metrics: NbaAudioWindow }> = []
  const starts = [...new Set([input.closingStartSeconds, ...[1, 2, 3].map(offset => Math.max(0, input.liveEndSeconds - offset * input.closingDurationSeconds))])]
  for (const start of starts) {
    if (start + input.closingDurationSeconds > input.sourceDurationSeconds + .08) continue
    const metrics = await inspectNbaAudioWindow(input.audioPath, start, input.closingDurationSeconds, options)
    candidates.push({ sourceStartSeconds: start, metrics })
    if (metrics.rmsDbFS > -45 && metrics.audibleFraction >= .85 && metrics.longestSilenceSeconds <= .5) {
      return { sourceStartSeconds: start, usedFallback: start !== input.closingStartSeconds, candidates, sourceAudioPath: input.audioPath,
        method: 'same-source-adjacent-arena-v1', preservesArenaGain: true }
    }
  }
  throw new NbaAudioPreflightError('片尾没有可衔接的同源有声球场声床，已保留画面和候选检测记录', { candidates, sourceAudioPath: input.audioPath })
}

function locateNarration(mixed: Float32Array, reference: Float32Array, length: number) {
  const rate = 8000
  const score = (shift: number) => {
    let xy = 0, xx = 0, yy = 0
    for (let index = 0; index < length; index++) {
      const x = reference[index], y = mixed[index + shift] || 0
      xy += x * y; xx += x * x; yy += y * y
    }
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0
  }
  let best = { shift: 0, correlation: -1 }
  for (let shift = 0; shift <= rate * .5; shift += 40) {
    const correlation = score(shift)
    if (correlation > best.correlation) best = { shift, correlation }
  }
  const start = Math.max(0, best.shift - 40), end = Math.min(rate * .5, best.shift + 40)
  for (let shift = start; shift <= end; shift++) {
    const correlation = score(shift)
    if (correlation > best.correlation) best = { shift, correlation }
  }
  return { detectedDelaySeconds: round(best.shift / rate), waveformCorrelation: round(best.correlation) }
}

export async function verifyNbaAudioPreflight(filename: string, options: AudioRuntime & { durationSeconds: number; narration?: { path: string; durationSeconds: number; startSeconds: number } }) {
  const windowDuration = Math.min(15, options.durationSeconds)
  const opening = await inspectNbaAudioWindow(filename, 0, windowDuration, options)
  const ending = await inspectNbaAudioWindow(filename, Math.max(0, options.durationSeconds - windowDuration), windowDuration, options)
  const outsideFade = (window: NbaAudioWindow) => round(Math.max(0, ...window.silences.map(item =>
    Math.max(0, Math.min(item.endSeconds, options.durationSeconds - FINAL_FADE_ALLOWANCE - window.startSeconds) - item.startSeconds))))
  const report = { version: 1, status: 'passed', thresholdDbFS: SILENCE_DB, maximumSilenceSeconds: 1.5, finalFadeAllowanceSeconds: FINAL_FADE_ALLOWANCE,
    opening: { ...opening, longestSilenceOutsideFinalFadeSeconds: outsideFade(opening) }, ending: { ...ending, longestSilenceOutsideFinalFadeSeconds: outsideFade(ending) },
    narrationAlignment: { status: 'not-provided', detectedDelaySeconds: undefined as number | undefined, waveformCorrelation: undefined as number | undefined,
      expectedDelaySeconds: options.narration?.startSeconds },
    limitations: '仅核对头尾音频信号和独立配音的插入时间，不代表主观试听或逐球画面语义同步。' }
  for (const [label, window] of [['片头', report.opening], ['片尾', report.ending]] as const) {
    if (window.longestSilenceOutsideFinalFadeSeconds > 1.5 || window.rmsDbFS < -50) {
      report.status = 'failed'
      throw new NbaAudioPreflightError(`${label}存在${window.longestSilenceOutsideFinalFadeSeconds.toFixed(2)}秒异常静音，需检查声床衔接`, report)
    }
  }
  if (options.narration) {
    const lengthSeconds = Math.min(8, options.narration.durationSeconds)
    if (lengthSeconds < 2) throw new NbaAudioPreflightError('独立配音采样不足，无法核验插入时间', report)
    const reference = await samples(options.narration.path, 0, lengthSeconds, options, 8000, 1)
    const mixed = await samples(filename, 0, Math.min(options.durationSeconds, lengthSeconds + .6), options, 8000, 1)
    const alignment = locateNarration(mixed, reference, Math.min(reference.length, Math.floor((mixed.length / 8000 - .5) * 8000)))
    report.narrationAlignment = { ...alignment, expectedDelaySeconds: options.narration.startSeconds, status: 'passed' }
    if (Math.abs(alignment.detectedDelaySeconds - options.narration.startSeconds) > .05 || alignment.waveformCorrelation < .35) {
      report.status = 'failed'; report.narrationAlignment.status = 'failed'
      throw new NbaAudioPreflightError('成片配音插入时间错位或无法与独立配音对应，已保存波形核验记录', report)
    }
  }
  return report
}
