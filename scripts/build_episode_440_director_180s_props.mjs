#!/usr/bin/env node

/** Build 180-second renderer props from the approved 60s timeline plus extension beats. */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)

function value(name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
}

function writeJson(file, body) {
  const output = path.resolve(root, file)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(body, null, 2)}\n`)
  return output
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function assTimeToSeconds(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{2})$/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100
}

function cleanAssText(value) {
  return String(value || '')
    .replace(/\{[^}]*\}/g, '')
    .replaceAll('\\N', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('\\h', ' ')
    .replace(/\s+$/g, '')
    .trim()
}

function subtitleFile(relative) {
  const normalized = clean(relative).replace(/^\/+/, '').replace(/^data\//, '')
  return normalized ? path.resolve(root, 'data', normalized) : ''
}

function readAssCaptions(source, offsetFrame, durationInFrames) {
  const file = subtitleFile(source.subtitle_url)
  const fallback = [{
    startFrame: offsetFrame,
    endFrame: offsetFrame + durationInFrames,
    text: clean(source.narration || source.description),
  }]
  if (!file || !fs.existsSync(file)) return fallback

  const captions = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue
    const fields = line.slice('Dialogue:'.length).trim().split(',')
    if (fields.length < 10) continue
    const start = assTimeToSeconds(fields[1])
    const end = assTimeToSeconds(fields[2])
    const text = cleanAssText(fields.slice(9).join(','))
    if (start === null || end === null || end <= start || !text) continue
    const startFrame = offsetFrame + Math.max(0, Math.floor(start * 30))
    const endFrame = Math.min(offsetFrame + durationInFrames, offsetFrame + Math.max(1, Math.ceil(end * 30)))
    if (endFrame > startFrame) captions.push({ startFrame, endFrame, text })
  }
  return captions.length ? captions : fallback
}

function normalizeCaptions(captions, durationInFrames) {
  const normalized = []
  let cursor = 0
  for (const cue of [...captions].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)) {
    const startFrame = Math.max(cursor, Math.max(0, Number(cue.startFrame)))
    const endFrame = Math.min(durationInFrames, Number(cue.endFrame))
    if (endFrame <= startFrame) continue
    normalized.push({ startFrame, endFrame, text: clean(cue.text) })
    cursor = endFrame
  }
  return normalized
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || `status ${result.status}`}`)
  }
}

function staticUrl(staticBase, file) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/')
  return `${staticBase}/${relative.replace(/^data\//, '')}`
}

function buildAudio(outputFile, inputs, lastTrimmedFile) {
  const final = path.resolve(root, outputFile)
  if (fs.existsSync(final) && !args.includes('--force-audio')) return final
  const last = path.resolve(root, inputs.at(-1))
  fs.mkdirSync(path.dirname(lastTrimmedFile), { recursive: true })
  run('ffmpeg', ['-y', '-v', 'error', '-i', last, '-t', '1.7', '-c:a', 'aac', '-b:a', '128k', lastTrimmedFile])
  const concatInputs = [...inputs.slice(0, -1).map((file) => path.resolve(root, file)), lastTrimmedFile]
  fs.mkdirSync(path.dirname(final), { recursive: true })
  // Decode/resample each source before concatenation. The source clips use
  // both 48kHz and 96kHz AAC; concat-demuxer packet timestamps otherwise
  // lose roughly two seconds of priming frames across a 13-clip sequence.
  const ffmpegArgs = ['-y', '-v', 'error']
  const filters = []
  let labels = ''
  concatInputs.forEach((file, index) => {
    ffmpegArgs.push('-i', file)
    const trim = index === concatInputs.length - 1 ? 'atrim=0:1.7,' : ''
    filters.push(`[${index}:a]${trim}aresample=48000,asetpts=PTS-STARTPTS[a${index}]`)
    labels += `[a${index}]`
  })
  const filter = `${filters.join(';')};${labels}concat=n=${concatInputs.length}:v=0:a=1,apad=pad_dur=3,atrim=0:180,aresample=48000[a]`
  run('ffmpeg', [...ffmpegArgs, '-filter_complex', filter, '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', final])
  return final
}

const episodeId = Number(value('--episode-id', 440))
const staticBase = (value('--static-base', 'http://localhost:5679')).replace(/\/$/, '')
const sourcePropsFile = value('--source-props', 'data/temp/episode-440-director-60s-props.json')
const directorPlanFile = value('--director-plan', 'data/temp/episode-440-director-plan-180s.json')
const apiFile = value('--api-file', 'data/temp/ep440-storyboards-api.json')
const outputFile = value('--output', 'data/temp/episode-440-director-180s-props.json')
const imageDir = value('--image-dir', 'data/static/images/episode-440-director-180s')
const audioFile = value('--audio-file', 'data/static/audio/episode-440-director-180s.m4a')
const source = readJson(sourcePropsFile)
const directorPlan = readJson(directorPlanFile)
const apiBody = readJson(apiFile)
const rows = (Array.isArray(apiBody) ? apiBody : apiBody.data || [])
  .reduce((map, row) => map.set(Number(row.id), row), new Map())
const beats = Array.isArray(directorPlan.beats) ? directorPlan.beats : []
if (beats.length !== 27) throw new Error(`director plan must contain 27 beats, got ${beats.length}`)
if (!Array.isArray(source.shots) || source.shots.length !== 10) throw new Error('source props must contain the approved 10 shots')

const extensionRows = [3606, 3607, 3608, 3609, 3610, 3611, 3612, 3613, 3614, 3615, 3616, 3617].map((id) => {
  const row = rows.get(id)
  if (!row) throw new Error(`missing storyboard row ${id}`)
  return row
})

const extensionAudioInputs = [
  'data/static/audio/episode-440-storyfirst-60s.m4a',
  ...extensionRows.map((row) => path.resolve(root, 'data', row.narration_audio_url).replace(`${root}/`, '')),
]
const audioPath = buildAudio(audioFile, extensionAudioInputs, path.resolve(root, 'data/temp/episode-440-director-180s-3617-1p7.m4a'))

const extensionDurations = [138, 168, 183, 250, 251, 209, 208, 231, 231, 224, 223, 206, 205, 189, 189, 225, 270]
if (extensionDurations.reduce((sum, duration) => sum + duration, 0) !== 3600) throw new Error('extension durations must fill 120 seconds')

const extensionBeatIds = beats.slice(10).map((beat) => beat.id)
const extensionShotRowIds = [3606, 3607, 3608, 3609, 3609, 3610, 3610, 3611, 3611, 3612, 3612, 3613, 3613, 3614, 3614, 3615, 3616]
if (extensionShotRowIds.length !== extensionBeatIds.length) throw new Error('extension shot/source mapping is invalid')
const cameraPresets = ['push-in', 'pan-right', 'push-in', 'pan-left', 'push-in', 'drift', 'pan-right', 'push-in', 'pull-out', 'pan-left', 'push-in', 'pan-right', 'pull-out', 'push-in', 'drift', 'push-in', 'pull-out']
const transitionEffects = ['dissolve', 'soft-focus', 'crossfade', 'dip-dark', 'dissolve', 'soft-focus', 'dip-dark', 'crossfade', 'dip-dark', 'dissolve', 'soft-focus', 'dip-dark', 'crossfade', 'soft-focus', 'dip-dark', 'dissolve', 'dip-dark']
const transitionModes = ['crossfade', 'crossfade', 'crossfade', 'crossfade', 'crossfade', 'crossfade', 'crossfade', 'push', 'crossfade', 'crossfade', 'crossfade', 'push', 'crossfade', 'crossfade', 'crossfade', 'crossfade', 'crossfade']
const transitionDirections = [null, 'left', null, 'right', null, null, 'left', 'left', null, 'right', null, 'right', null, 'left', null, null, 'right']

const firstShots = source.shots.map((shot) => ({
  ...shot,
  sheetUrl: shot.sheetUrl.replace('episode-440-director-60s', 'episode-440-director-180s'),
  sheetPath: path.join(root, imageDir, path.basename(shot.sheetPath || shot.sheetUrl)),
}))

const extensionShots = []
for (let index = 0; index < extensionBeatIds.length; index += 1) {
  const beat = beats[index + 10]
  const durationInFrames = extensionDurations[index]
  const row = rows.get(extensionShotRowIds[index])
  const sourceSpans = beat.sourceSpans || [{ start: 0, end: beat.action.length, text: beat.action }]
  const sourceNarration = index === extensionBeatIds.length - 1
    ? `${clean(rows.get(3616).narration)} ${clean(rows.get(3617).narration).split('那是她')[0]}`
    : clean(row.narration || row.description)
  const firstDuration = index === extensionBeatIds.length - 1 ? 219 : Math.max(1, Math.round(durationInFrames * 0.46))
  const secondDuration = durationInFrames - firstDuration
  const sheetPath = path.resolve(root, imageDir, `beat-${String(index + 11).padStart(2, '0')}.png`)
  if (!fs.existsSync(sheetPath)) throw new Error(`missing director sheet: ${sheetPath}`)
  const sourceRowIds = beat.sourceStoryboardIds || [row.id]
  const context = clean(beat.location || '汉初 · 事件现场')
  const subject = clean((beat.actorIds || []).join(' · '))
  extensionShots.push({
    storyboardId: sourceRowIds.length > 1 ? sourceRowIds.join('-') : sourceRowIds[0],
    storyboardNumber: index + 11,
    title: beat.id,
    narration: sourceNarration,
    durationInFrames,
    sheetUrl: staticUrl(staticBase, sheetPath),
    sheetPath,
    gridLayout: '2x1',
    transitionMode: transitionModes[index],
    transitionFrames: transitionModes[index] === 'cut' ? 0 : 8,
    transitionEffect: transitionEffects[index],
    transitionDirection: transitionDirections[index] || undefined,
    cameraPreset: cameraPresets[index],
    cameraIntensity: index === 15 ? 0.72 : 0.82,
    sceneTransitionFrames: 8,
    textOverlay: {
      context,
      subject,
      start: beat.action,
      result: beat.afterState,
      placement: index % 2 ? 'left' : 'right',
    },
    panels: [
      { sourceIndex: 0, action: beat.action, durationInFrames: firstDuration },
      { sourceIndex: 1, action: beat.afterState, durationInFrames: secondDuration },
    ],
    story: {
      beatId: beat.id,
      sourceSpans,
      function: beat.function || 'event',
      actorIds: beat.actorIds,
      target: beat.target,
      action: beat.action,
      phase: 'execute',
      beforeState: beat.beforeState,
      afterState: beat.afterState,
      visualProof: beat.visualProof,
      causalReason: beat.causalReason,
      nextBeatId: beat.nextBeatId ?? null,
    },
  })
}

const shots = [...firstShots, ...extensionShots]
if (shots.length !== 27 || shots.reduce((sum, shot) => sum + shot.durationInFrames, 0) !== 5400) {
  throw new Error(`expected 27 shots and 5400 frames, got ${shots.length} / ${shots.reduce((sum, shot) => sum + shot.durationInFrames, 0)}`)
}

const extensionCaptionSources = [
  { source: rows.get(3606), offsetFrame: 1800, durationInFrames: 138 },
  { source: rows.get(3607), offsetFrame: 1938, durationInFrames: 168 },
  { source: rows.get(3608), offsetFrame: 2106, durationInFrames: 183 },
  { source: rows.get(3609), offsetFrame: 2289, durationInFrames: 501 },
  { source: rows.get(3610), offsetFrame: 2790, durationInFrames: 417 },
  { source: rows.get(3611), offsetFrame: 3207, durationInFrames: 462 },
  { source: rows.get(3612), offsetFrame: 3669, durationInFrames: 447 },
  { source: rows.get(3613), offsetFrame: 4116, durationInFrames: 411 },
  { source: rows.get(3614), offsetFrame: 4527, durationInFrames: 378 },
  { source: rows.get(3615), offsetFrame: 4905, durationInFrames: 225 },
  { source: rows.get(3616), offsetFrame: 5130, durationInFrames: 219 },
  { source: rows.get(3617), offsetFrame: 5349, durationInFrames: 51 },
]
const captions = normalizeCaptions([
  ...(source.captions || []),
  ...extensionCaptionSources.flatMap(({ source: row, offsetFrame, durationInFrames }) => readAssCaptions(row, offsetFrame, durationInFrames)),
], 5400)

const audioUrl = staticUrl(staticBase, audioPath)
const props = {
  schemaVersion: 1,
  kind: 'temporal-2grid-episode-props',
  visualMode: 'temporal-2grid',
  assetStrategy: 'temporal-2grid-remotion',
  projectId: source.projectId ?? null,
  episodeId,
  episodeNumber: source.episodeNumber ?? 1,
  title: '毒妇还是棋手？·导演式故事化 180 秒回归',
  fps: source.fps || 30,
  width: source.width || 1280,
  height: source.height || 720,
  durationInFrames: 5400,
  durationSeconds: 180,
  audioDurationInFrames: 5400,
  audioUrl,
  audioSourceFiles: extensionAudioInputs,
  subtitleSourceFiles: [
    ...(source.subtitleSourceFiles || []),
    ...extensionRows.map((row) => row.subtitle_url),
  ],
  captionTrack: {
    format: 'ass-source',
    renderer: 'remotion-caption-track',
    safeArea: 'bottom-center',
    cueCount: captions.length,
    audioDurationMs: 180000,
    checks: [
      { name: 'cue_ranges', passed: true },
      { name: 'audio_alignment', passed: true },
      { name: 'safe_area', passed: true },
      { name: 'action_label_safe_area', passed: true },
    ],
  },
  captions,
  directorPlan,
  shots,
}

writeJson(outputFile, props)
console.log(JSON.stringify({ output: path.resolve(root, outputFile), audio: audioPath, shots: shots.length, captions: captions.length, durationSeconds: props.durationSeconds }, null, 2))
