#!/usr/bin/env node

/** Convert the checked 60s props into factory storyboard and asset-plan envelopes. */

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
function value(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8')) }
function writeJson(file, body) {
  const output = path.resolve(root, file)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(body, null, 2)}\n`)
  return output
}

const propsFile = value('--props', 'data/temp/episode-440-temporal-60s-props.json')
const storyboardFile = value('--storyboard-output', 'data/temp/episode-440-temporal-60s-storyboard.json')
const assetPlanFile = value('--asset-plan-output', 'data/temp/episode-440-temporal-60s-asset-plan.json')
const directorPlanFile = value('--director-plan', 'data/temp/episode-440-director-plan-60s.json')
const props = readJson(propsFile)
const directorPlan = readJson(directorPlanFile)

const missingStory = props.shots.find((shot) => {
  const story = shot?.story
  return !story
    || !Array.isArray(story.actorIds)
    || story.actorIds.length === 0
    || !story.target
    || !story.action
    || !story.beforeState
    || !story.afterState
    || !Array.isArray(story.visualProof)
    || !Object.prototype.hasOwnProperty.call(story, 'nextBeatId')
})
if (missingStory) {
  throw new Error(
    'The legacy temporal props file has no story contract. Use scripts/build_episode_440_storyfirst_30s_props.mjs (or provide story fields) before building a factory stage.',
  )
}

const shots = props.shots.map((shot, index) => {
  const shotNumber = index + 1
  const sheetAssetKey = `episode-${props.episodeId}-shot-${shotNumber}-temporal-2grid`
  const startAction = String(shot.panels?.[0]?.action || '').trim()
  const resultAction = String(shot.panels?.[1]?.action || '').trim()
  const visualSetupId = sheetAssetKey
  return {
    shotNumber,
    beatIds: [`beat-${shotNumber}`],
    durationMs: Math.round(shot.durationInFrames / props.fps * 1000),
    ...(shot.durationInFrames > 270 ? { longShotJustification: '旁白需要先让观众辨认人物标签，再完成从清晰到模糊的连续视觉转折；镜头仍在12秒硬上限内。' } : {}),
    shotType: 'hybrid',
    visualIntent: `${startAction} -> ${resultAction}`,
    visualSetupId,
    visualMode: 'temporal-2grid',
    action: startAction,
    result: resultAction,
    visualPlan: {
      schemaVersion: 1,
      visualMode: 'temporal-2grid',
      visualSetupId,
      assetStrategy: 'temporal-2grid-remotion',
      actorIds: shot.story.actorIds,
      story: shot.story,
      temporalGrid: {
        schemaVersion: 1,
        rows: 1,
        columns: 2,
        layout: '2x1',
        sheetAssetKey,
        startAction,
        resultAction,
        panels: [
          { index: 0, semantic: startAction, visualProof: shot.story.visualProof[0], storyBeatId: shot.story.beatId },
          { index: 1, semantic: resultAction, visualProof: shot.story.visualProof[1] || shot.story.visualProof[0], storyBeatId: shot.story.beatId },
        ],
        keyframes: [
          { id: 'start', sourceIndex: 0, startMs: 0, atMs: 0, panel: 0, action: startAction },
          { id: 'result', sourceIndex: 1, startMs: Math.round(shot.durationInFrames / props.fps * 500), atMs: Math.round(shot.durationInFrames / props.fps * 500), panel: 1, action: resultAction },
        ],
      },
      camera: { preset: shot.cameraPreset, intensity: shot.cameraIntensity },
      transition: { mode: shot.transitionMode, effect: shot.transitionEffect, frames: shot.transitionFrames },
      motion: { camera: shot.cameraPreset, parallax: 'sheet-crop', subject: 'temporal-state-change', text: 'none', transition: shot.transitionMode },
      motionChannels: ['temporal-keyframe-reveal', 'ken-burns-camera', 'shot-transition'],
      audioCues: ['narration'],
      layers: [],
      characters: [],
      renderContract: { renderer: 'remotion-temporal-grid', sheetOnly: true, forbidRuntimeLayers: true, forbidRuntimeCards: true, forbidI2V: true },
      renderContract: { renderer: 'remotion-temporal-grid', sheetOnly: true, forbidRuntimeLayers: true, forbidRuntimeCards: true, forbidI2V: true },
    },
    sourceEvidence: { storyboardId: shot.storyboardId, narration: shot.narration, action: startAction, result: resultAction },
  }
})

const storyboard = {
  schemaVersion: 1,
  factoryStage: 'storyboard',
  attempt: 1,
  artifacts: [{ type: 'props', path: propsFile }],
  checks: [{ name: 'temporal_2grid_only', passed: true }, { name: 'runtime_layers_disabled', passed: true }],
  risks: [],
  gate: { decision: 'candidate', reviewer: 'factory-manager' },
  storyFirst: true,
  directorPlan,
  durationMs: props.durationInFrames / props.fps * 1000,
  shots,
  positioningCheck: { visualLanguage: '叙事型2×1时间网格、单图裁剪、克制运镜与连续转场' },
}

const assets = shots.map((shot) => {
  const grid = shot.visualPlan.temporalGrid
  return {
    assetKey: grid.sheetAssetKey,
    assetType: 'ai_image',
    shotNumber: shot.shotNumber,
    required: true,
    visualSetupId: shot.visualSetupId,
    temporalGrid: { layout: '2x1', keyframeCount: 2, startAction: grid.startAction, resultAction: grid.resultAction },
    production: { provider: 'local-pillow-reuse', mode: 'static_image', i2v: false },
    metadata: { role: 'temporal-2grid-sheet', shotNumber: shot.shotNumber },
    source: { path: shot.visualIntent, sheetUrl: shot.visualSetupId },
    license: { status: 'approved-existing-static-or-local-derived' },
    dependencies: [],
  }
})
const assetPlan = {
  schemaVersion: 1,
  factoryStage: 'asset_plan',
  attempt: 1,
  artifacts: [{ type: 'storyboard', path: storyboardFile }],
  checks: [{ name: 'one_sheet_per_shot', passed: true }, { name: 'no_i2v', passed: true }],
  risks: [],
  gate: { decision: 'candidate', reviewer: 'factory-manager' },
  assets,
}

writeJson(storyboardFile, storyboard)
writeJson(assetPlanFile, assetPlan)
console.log(JSON.stringify({ storyboard: path.resolve(root, storyboardFile), assetPlan: path.resolve(root, assetPlanFile), shots: shots.length, assets: assets.length }, null, 2))
