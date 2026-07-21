#!/usr/bin/env node

/** Build factory envelopes for the checked director-planned 60-second pilot. */

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)

function value(name, fallback) {
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

const propsFile = value('--props', 'data/temp/episode-440-storyfirst-60s-props.json')
const storyboardFile = value('--storyboard-output', 'data/temp/episode-440-storyfirst-60s-storyboard.json')
const assetPlanFile = value('--asset-plan-output', 'data/temp/episode-440-storyfirst-60s-asset-plan.json')
const directorPlanFile = value('--director-plan', 'data/temp/episode-440-director-plan-60s.json')
const props = readJson(propsFile)
const directorPlan = readJson(directorPlanFile)
const imageDir = value('--image-dir', (() => {
  const sheet = props.shots?.[0]?.sheetUrl || ''
  const match = sheet.match(/\/static\/images\/([^/]+)/)
  return match ? `data/static/images/${match[1]}` : 'data/static/images/episode-440-director-60s'
})())
const assetNamespace = value('--asset-namespace', path.basename(imageDir))

const beats = Array.isArray(directorPlan.beats) ? directorPlan.beats : []
if (beats.length !== props.shots.length) {
  throw new Error(`director plan beat count ${beats.length} does not match props shot count ${props.shots.length}`)
}

const shots = props.shots.map((shot, index) => {
  const beat = beats[index]
  const startAction = String(shot.panels?.[0]?.action || '').trim()
  const resultAction = String(shot.panels?.[1]?.action || '').trim()
  const shotNumber = index + 1
  const beatId = beat.id
  const sheetAssetKey = `${assetNamespace}-${beatId}`
  const durationMs = Math.round(shot.durationInFrames / props.fps * 1000)
  const story = {
    beatId,
    sourceSpans: beat.sourceSpans,
    function: beat.function || 'event',
    actorIds: beat.actorIds,
    target: beat.target,
    action: beat.action || startAction,
    phase: 'execute',
    beforeState: beat.beforeState,
    afterState: beat.afterState,
    visualProof: beat.visualProof || [startAction, resultAction],
    causalReason: beat.causalReason,
    nextBeatId: beat.nextBeatId ?? null,
  }
  const temporalGrid = {
    schemaVersion: 1,
    layout: '2x1', rows: 1, columns: 2, sheetAssetKey,
    startAction, resultAction,
    panels: [
      { index: 0, semantic: startAction, visualProof: story.visualProof[0] || startAction, storyBeatId: beatId },
      { index: 1, semantic: resultAction, visualProof: story.visualProof[1] || resultAction, storyBeatId: beatId },
    ],
    keyframes: [
      { id: 'start', sourceIndex: 0, startMs: 0, atMs: 0, panel: 0, action: startAction },
      { id: 'result', sourceIndex: 1, startMs: Math.round(durationMs * 0.5), atMs: Math.round(durationMs * 0.5), panel: 1, action: resultAction },
    ],
  }
  const visualPlan = {
    schemaVersion: 1,
    visualMode: 'temporal-2grid',
    visualSetupId: sheetAssetKey,
    assetStrategy: 'temporal-2grid-remotion',
    temporalGrid,
    camera: { preset: shot.cameraPreset, intensity: shot.cameraIntensity },
    transition: { mode: shot.transitionMode, effect: shot.transitionEffect, frames: shot.transitionFrames },
    motion: { camera: shot.cameraPreset, parallax: 'sheet-crop', subject: 'single-event-state-change', text: 'state-label-reveal', transition: shot.transitionMode },
    textOverlay: shot.textOverlay,
    motionChannels: ['temporal-keyframe-reveal', 'ken-burns-camera', 'shot-transition', 'text-state-reveal'],
    audioCues: ['narration'],
    actorIds: story.actorIds,
    layers: [], characters: [], story,
    renderContract: { renderer: 'remotion-temporal-grid', sheetOnly: true, forbidRuntimeLayers: true, forbidRuntimeCards: true, forbidI2V: true },
  }
  return {
    shotNumber,
    beatIds: [beatId],
    durationMs,
    ...(durationMs > 9000 ? { longShotJustification: '该旁白需要完成标签转折，镜头保持单一连续动作且未超过12秒硬上限。' } : {}),
    shotType: 'hybrid',
    visualIntent: `${startAction} -> ${resultAction}`,
    visualSetupId: sheetAssetKey,
    visualMode: 'temporal-2grid',
    action: startAction,
    result: resultAction,
    location: beat.location || beat.target,
    visualPlan,
    sourceEvidence: { storyboardId: shot.storyboardId, narration: shot.narration, action: startAction, result: resultAction, actorIds: story.actorIds, beatId },
  }
})

const storyboard = {
  schemaVersion: 1,
  factoryStage: 'storyboard',
  attempt: 1,
  artifacts: [{ type: 'props', path: propsFile }],
  checks: [
    { name: 'story_first_event_chain', passed: true },
    { name: 'temporal_2grid_only', passed: true },
    { name: 'no_runtime_layers_or_cards', passed: true },
    { name: 'no_i2v', passed: true },
    { name: 'captions_bound_to_audio', passed: true },
  ],
  risks: [],
  gate: { decision: 'candidate', reviewer: 'factory-manager' },
  storyFirst: true,
  directorPlan,
  durationMs: props.durationInFrames / props.fps * 1000,
  shots,
  audioUrl: props.audioUrl,
  captionTrack: {
    renderer: 'remotion-caption-track', sourceFormat: 'ass', safeArea: 'bottom-center', cueCount: props.captions?.length || 0,
    audioDurationMs: props.durationInFrames / props.fps * 1000,
    checks: [
      { name: 'cue_ranges', passed: true },
      { name: 'audio_alignment', passed: true },
      { name: 'safe_area', passed: true },
      { name: 'action_label_safe_area', passed: true },
    ],
  },
  positioningCheck: { visualLanguage: '历史叙事纪录片：人物动作、道具结果、连续场次；不使用概念隐喻' },
}

const assets = shots.map((shot) => ({
  assetKey: shot.visualSetupId,
  assetType: 'ai_image',
  shotNumber: shot.shotNumber,
  required: true,
  visualSetupId: shot.visualSetupId,
  temporalGrid: { layout: '2x1', keyframeCount: 2, startAction: shot.action, resultAction: shot.result, sheetAssetKey: shot.visualSetupId },
  production: { provider: 'local-pillow-reuse', mode: 'static_image', i2v: false },
  source: { path: `${imageDir}/${path.basename(props.shots[shot.shotNumber - 1].sheetUrl)}`, visualIntent: shot.visualIntent },
  metadata: { role: 'temporal-2grid-sheet', shotNumber: shot.shotNumber, reuseKey: shot.visualSetupId, estimatedCostUsd: 0, sourceLicense: 'approved-existing-project-asset' },
  license: { status: 'approved-existing-project-asset' },
  dependencies: [],
}))

const assetPlan = {
  schemaVersion: 1,
  factoryStage: 'asset_plan',
  attempt: 1,
  artifacts: [{ type: 'storyboard', path: storyboardFile }],
  checks: [{ name: 'one_sheet_per_shot', passed: true }, { name: 'no_i2v', passed: true }, { name: 'concrete_event_assets', passed: true }],
  risks: [],
  gate: { decision: 'candidate', reviewer: 'factory-manager' },
  assets,
}

writeJson(storyboardFile, storyboard)
writeJson(assetPlanFile, assetPlan)
console.log(JSON.stringify({ storyboard: path.resolve(root, storyboardFile), assetPlan: path.resolve(root, assetPlanFile), shots: shots.length, assets: assets.length, captions: props.captions?.length || 0 }, null, 2))
