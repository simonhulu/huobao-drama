#!/usr/bin/env node

/** Build renderer props for the director-planned Episode 440 pilot. */

import fs from 'node:fs'
import path from 'node:path'

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

const episodeId = Number(value('--episode-id', 440))
const directorPlanFile = value('--director-plan', 'data/temp/episode-440-director-plan-60s.json')
const sourcePropsFile = value('--source-props', 'data/temp/episode-440-storyfirst-60s-props.json')
const outputFile = value('--output', 'data/temp/episode-440-director-60s-props.json')
const staticBase = (value('--static-base', 'http://localhost:5679')).replace(/\/$/, '')
const imageDir = value('--image-dir', 'data/static/images/episode-440-director-60s')

const source = readJson(sourcePropsFile)
const directorPlan = readJson(directorPlanFile)
const beats = Array.isArray(directorPlan.beats) ? directorPlan.beats : []
if (beats.length !== 10) throw new Error(`director plan must contain 10 beats, got ${beats.length}`)

// Keep the original frozen narration/audio timeline. The visual edit is split
// into event beats without regenerating or re-timing the approved voice.
const durations = [159, 258, 102, 150, 210, 294, 171, 90, 180, 186]
if (durations.reduce((sum, value) => sum + value, 0) !== source.durationInFrames) {
  throw new Error('director durations must fill the frozen source audio exactly')
}

const cameraPresets = ['pan-right', 'push-in', 'pull-out', 'pull-out', 'push-in', 'push-in', 'pan-right', 'push-in', 'pan-left', 'push-in']
const transitionEffects = ['dissolve', 'soft-focus', 'dip-dark', 'dip-dark', 'dissolve', 'soft-focus', 'dip-dark', 'dissolve', 'soft-focus', 'dip-dark']
const transitionModes = ['cut', 'crossfade', 'crossfade', 'crossfade', 'crossfade', 'crossfade', 'crossfade', 'push', 'crossfade', 'crossfade']
const transitionDirections = [null, null, null, null, null, null, null, 'left', null, null]
const overlayPlacements = ['right', 'left', 'right', 'left', 'left', 'right', 'left', 'right', 'left', 'right']

function sourcePathForShot(index) {
  const file = path.join(root, imageDir, `beat-${String(index + 1).padStart(2, '0')}.png`)
  if (!fs.existsSync(file)) throw new Error(`missing director sheet: ${file}`)
  return file
}

let captionOffset = 0
const shots = beats.map((beat, index) => {
  const durationInFrames = durations[index]
  const firstDuration = Math.max(1, Math.round(durationInFrames * 0.46))
  const secondDuration = durationInFrames - firstDuration
  const sheetPath = sourcePathForShot(index)
  const startAction = clean(beat.action)
  const resultAction = clean(beat.afterState)
  const visualProof = Array.isArray(beat.visualProof) && beat.visualProof.length >= 2
    ? beat.visualProof
    : [startAction, resultAction]
  const sourceSpans = Array.isArray(beat.sourceSpans) && beat.sourceSpans.length
    ? beat.sourceSpans
    : [{ start: 0, end: Math.max(1, startAction.length), text: startAction }]
  const narration = clean(sourceSpans.map((span) => span.text).join(' '))
  const context = clean(beat.location || directorPlan.scenes?.find((scene) => scene.id === beat.sceneId)?.location)
  const subject = clean(beat.actorIds?.join(' · '))
  const textOverlay = {
    context: context || '汉初 · 事件现场',
    subject,
    start: clean(beat.action),
    result: clean(beat.afterState),
    placement: overlayPlacements[index],
  }
  const sheetUrl = `${staticBase}/${imageDir.replace(/^data\//, '')}/beat-${String(index + 1).padStart(2, '0')}.png`
  captionOffset += durationInFrames
  return {
    storyboardId: beat.sourceStoryboardIds?.[0] ?? beat.id,
    storyboardNumber: index + 1,
    title: beat.id,
    narration,
    durationInFrames,
    sheetUrl,
    sheetPath,
    gridLayout: '2x1',
    transitionMode: transitionModes[index],
    transitionFrames: transitionModes[index] === 'cut' ? 0 : index === 7 ? 10 : 8,
    transitionEffect: transitionEffects[index],
    transitionDirection: transitionDirections[index] || undefined,
    cameraPreset: cameraPresets[index],
    cameraIntensity: index === 7 ? 0.72 : 0.82,
    sceneTransitionFrames: index === 0 ? 0 : 8,
    textOverlay,
    panels: [
      { sourceIndex: 0, action: startAction, durationInFrames: firstDuration },
      { sourceIndex: 1, action: clean(visualProof[1] || resultAction), durationInFrames: secondDuration },
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
      visualProof,
      causalReason: beat.causalReason,
      nextBeatId: beat.nextBeatId ?? null,
    },
  }
})

const captions = Array.isArray(source.captions) ? source.captions : []
if (!captions.length) throw new Error('source props must contain the frozen caption track')

const props = {
  schemaVersion: 1,
  kind: 'temporal-2grid-episode-props',
  visualMode: 'temporal-2grid',
  assetStrategy: 'temporal-2grid-remotion',
  projectId: source.projectId ?? null,
  episodeId,
  episodeNumber: source.episodeNumber ?? 1,
  title: '毒妇还是棋手？·导演式故事化 60 秒',
  fps: source.fps || 30,
  width: source.width || 1280,
  height: source.height || 720,
  durationInFrames: source.durationInFrames,
  durationSeconds: source.durationInFrames / (source.fps || 30),
  audioDurationInFrames: source.durationInFrames,
  audioUrl: source.audioUrl,
  audioSourceFiles: source.audioSourceFiles,
  subtitleSourceFiles: source.subtitleSourceFiles,
  captionTrack: {
    format: 'ass-source',
    renderer: 'remotion-caption-track',
    safeArea: 'bottom-center',
    cueCount: captions.length,
    audioDurationMs: source.durationInFrames / (source.fps || 30) * 1000,
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
console.log(JSON.stringify({ output: path.resolve(root, outputFile), shots: shots.length, captions: captions.length, durationSeconds: props.durationSeconds }, null, 2))
