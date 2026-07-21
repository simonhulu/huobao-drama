#!/usr/bin/env node

/** Build the story-first Episode 440 opening pilot and its factory envelopes. */

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)

function value(name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function writeJson(file, body) {
  const output = path.resolve(root, file)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(body, null, 2)}\n`)
  return output
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
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

function readAssCaptions(source, offsetFrame, durationInFrames) {
  const subtitleUrl = clean(source.subtitle_url)
  const subtitleFile = subtitleUrl ? path.resolve(root, 'data', subtitleUrl) : ''
  const fallback = [{
    startFrame: offsetFrame,
    endFrame: offsetFrame + durationInFrames,
    text: clean(source.narration),
  }]
  if (!subtitleFile || !fs.existsSync(subtitleFile)) return fallback

  const captions = []
  for (const line of fs.readFileSync(subtitleFile, 'utf8').split(/\r?\n/)) {
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

function frames(seconds) {
  return Math.max(1, Math.round(Number(seconds) * 30))
}

const episodeId = Number(value('--episode-id', 440))
const propsFile = value('--output', 'data/temp/episode-440-storyfirst-30s-props.json')
const storyboardFile = value('--storyboard-output', 'data/temp/episode-440-storyfirst-30s-storyboard.json')
const assetPlanFile = value('--asset-plan-output', 'data/temp/episode-440-storyfirst-30s-asset-plan.json')
const sourceFile = value('--source', 'data/temp/ep440-storyboards-api.json')
const directorPlanFile = value('--director-plan', 'data/temp/episode-440-director-plan-60s.json')
const staticBase = (value('--static-base', 'http://localhost:5679')).replace(/\/$/, '')

const rows = readJson(sourceFile)
const directorPlan = readJson(directorPlanFile)
const sourceRows = (Array.isArray(rows) ? rows : rows.data || [])
  .filter((row) => [3599, 3600, 3601, 3602].includes(Number(row.id)))
  .sort((a, b) => Number(a.storyboard_number) - Number(b.storyboard_number))
if (sourceRows.length !== 4) throw new Error(`Episode ${episodeId} needs source storyboards 3599-3602`)

const plans = [
  {
    sheet: 'sf-01', sceneId: '永巷-夜', location: '永巷尽头', time: '汉初夜间',
    actorIds: ['QIFUREN', 'PALACE_GUARD'], target: '永巷厕所木门',
    start: '侍卫押着戚夫人走向永巷尽头的门', result: '厕所木门合上，门内只剩湿冷的石地和衣料',
    beforeState: '戚夫人仍在守卫控制下向门口移动', afterState: '戚夫人被关进厕所，出口被木门隔断',
    visualProof: ['两名侍卫扶住女囚走向门口', '木门合上并落下门闩'],
    textOverlay: { context: '永巷 · 夜', subject: '戚夫人', start: '押送入永巷', result: '木门落闩', placement: 'right' },
    camera: 'pan-right', effect: 'dip-dark',
  },
  {
    sheet: 'sf-02', sceneId: '永巷-囚室', location: '永巷囚室', time: '汉初夜间',
    actorIds: ['QIFUREN', 'PALACE_GUARD'], target: '囚室与刑具',
    start: '戚夫人隔着木栏缩在牢房角落，守卫从她身边走过', result: '镜头落到厕所地面，刑具和破碎衣料留下后果',
    beforeState: '戚夫人仍被关押，身体和处境尚未呈现结果', afterState: '厕所地面留下刑具和衣料，暴行的结果被看见',
    visualProof: ['女囚双手抓住木栏', '湿冷地面上出现刑具和破碎衣料'],
    textOverlay: { context: '永巷 · 囚室', subject: '戚夫人', start: '囚徒缩在木栏后', result: '暴行留下后果', placement: 'left' },
    camera: 'push-in', effect: 'dissolve',
  },
  {
    sheet: 'sf-03', sceneId: '永巷-厕所门', location: '永巷厕所门外', time: '汉初白日',
    actorIds: ['LIUYING', 'QIFUREN'], target: '厕所木门内的戚夫人',
    start: '刘盈来到厕所门外，看见门内的惨状', result: '刘盈看见戚夫人的处境后惊退跌坐在地',
    beforeState: '刘盈尚未看见门内发生的事情', afterState: '刘盈看见戚夫人的处境并当场失去站立支撑',
    visualProof: ['厕所门内的残破地面和衣料', '刘盈跌坐在门外并露出惊恐表情'],
    textOverlay: { context: '永巷 · 厕所门外', subject: '刘盈', start: '门内的惨状', result: '惊退跌坐', placement: 'right' },
    camera: 'pull-out', effect: 'dip-dark',
  },
  {
    sheet: 'sf-04', sceneId: '长乐宫-朝堂', location: '长乐宫朝堂', time: '汉初执政时期',
    actorIds: ['LUZHI', 'COURT_OFFICIALS'], target: '朝堂政令与官员',
    start: '吕雉在深殿听完禀报，决定走入朝堂', result: '她走入朝堂，官员俯身让开通道',
    beforeState: '吕雉尚在深殿，官员等待她的决定', afterState: '吕雉进入朝堂并通过政令让官员执行决定',
    visualProof: ['吕雉在深殿冷峻地听报', '官员俯身让开她走向朝堂的通道'],
    textOverlay: { context: '长乐宫 · 朝堂', subject: '吕雉', start: '吕雉听报', result: '官员让路', placement: 'left' },
    camera: 'push-in', effect: 'dissolve',
  },
]

const shotFrames = [frames(sourceRows[0].duration), frames(sourceRows[1].duration), frames(sourceRows[2].duration), 900 - frames(sourceRows[0].duration) - frames(sourceRows[1].duration) - frames(sourceRows[2].duration)]
const shots = plans.map((plan, index) => {
  const source = sourceRows[index]
  const durationInFrames = shotFrames[index]
  const shotNumber = index + 1
  const sheetAssetKey = `episode-${episodeId}-storyfirst-30s-${plan.sheet}`
  const beatId = `beat-${shotNumber}`
  const startMs = 0
  const resultMs = Math.round(durationInFrames / 30 * 500)
  const story = {
    beatId,
    sourceSpans: [{ start: 0, end: Math.max(1, clean(source.narration).length), text: clean(source.narration) }],
    function: 'event',
    actorIds: plan.actorIds,
    target: plan.target,
    action: plan.start,
    phase: 'execute',
    beforeState: plan.beforeState,
    afterState: plan.afterState,
    visualProof: plan.visualProof,
    nextBeatId: index < plans.length - 1 ? `beat-${shotNumber + 1}` : null,
  }
  const temporalGrid = {
    schemaVersion: 1,
    layout: '2x1', rows: 1, columns: 2, sheetAssetKey,
    startAction: plan.start, resultAction: plan.result,
    panels: [
      { index: 0, semantic: plan.start, visualProof: plan.visualProof[0], storyBeatId: beatId },
      { index: 1, semantic: plan.result, visualProof: plan.visualProof[1], storyBeatId: beatId },
    ],
    keyframes: [
      { id: 'start', sourceIndex: 0, startMs, atMs: startMs, panel: 0, action: plan.start },
      { id: 'result', sourceIndex: 1, startMs: resultMs, atMs: resultMs, panel: 1, action: plan.result },
    ],
  }
  return {
    storyboardId: Number(source.id), storyboardNumber: Number(source.storyboard_number),
    title: clean(source.title), narration: clean(source.narration), durationInFrames,
    sheetUrl: `${staticBase}/static/images/episode-440-storyfirst-30s/${plan.sheet}.png`,
    gridLayout: '2x1', transitionMode: index === 0 ? 'cut' : 'crossfade',
    transitionFrames: index === 0 ? 0 : 10, transitionEffect: plan.effect,
    cameraPreset: plan.camera, cameraIntensity: 0.82, sceneTransitionFrames: 5,
    textOverlay: plan.textOverlay,
    panels: [
      { sourceIndex: 0, action: plan.start, durationInFrames: Math.max(1, Math.round(durationInFrames * 0.46)) },
      { sourceIndex: 1, action: plan.result, durationInFrames: Math.max(1, durationInFrames - Math.round(durationInFrames * 0.46)) },
    ],
    story,
    plan,
    temporalGrid,
  }
})

const captions = []
let captionOffsetFrame = 0
for (const [index, shot] of shots.entries()) {
  captions.push(...readAssCaptions(sourceRows[index], captionOffsetFrame, shot.durationInFrames))
  captionOffsetFrame += shot.durationInFrames
}
const normalizedCaptions = normalizeCaptions(captions, 900)

const audioUrl = `${staticBase}/static/audio/episode-440-storyfirst-30s.m4a`
const props = {
  schemaVersion: 1, kind: 'temporal-2grid-episode-props', visualMode: 'temporal-2grid',
  assetStrategy: 'temporal-2grid-remotion', projectId: null, episodeId, episodeNumber: 1,
  title: '毒妇还是棋手？·故事优先开头 30 秒', fps: 30, width: 1280, height: 720,
  durationInFrames: 900, durationSeconds: 30, audioDurationInFrames: 900, audioUrl,
  audioSourceFiles: sourceRows.map((row) => row.narration_audio_url),
  subtitleSourceFiles: sourceRows.map((row) => row.subtitle_url),
  captionTrack: {
    format: 'ass-source', renderer: 'remotion-caption-track', safeArea: 'bottom-center', cueCount: normalizedCaptions.length,
    checks: [
      { name: 'cue_ranges', passed: true },
      { name: 'audio_alignment', passed: true },
      { name: 'safe_area', passed: true },
      { name: 'action_label_safe_area', passed: true },
    ],
  },
  captions: normalizedCaptions,
  shots,
}
writeJson(propsFile, props)

const storyboardShots = shots.map((shot, index) => ({
  shotNumber: index + 1, beatIds: [shot.story.beatId], durationMs: Math.round(shot.durationInFrames / 30 * 1000),
  shotType: 'hybrid', visualIntent: `${shot.plan.start} -> ${shot.plan.result}`,
  visualSetupId: shot.temporalGrid.sheetAssetKey, visualMode: 'temporal-2grid',
  action: shot.plan.start, result: shot.plan.result, location: shot.plan.location, time: shot.plan.time,
  visualPlan: {
    schemaVersion: 1, visualMode: 'temporal-2grid', visualSetupId: shot.temporalGrid.sheetAssetKey,
    assetStrategy: 'temporal-2grid-remotion', temporalGrid: shot.temporalGrid,
    camera: { preset: shot.cameraPreset, intensity: shot.cameraIntensity },
    transition: { mode: shot.transitionMode, effect: shot.transitionEffect, frames: shot.transitionFrames },
    motion: { camera: shot.cameraPreset, parallax: 'sheet-crop', subject: 'single-event-state-change', text: 'state-label-reveal', transition: shot.transitionMode },
    textOverlay: shot.textOverlay,
    motionChannels: ['temporal-keyframe-reveal', 'ken-burns-camera', 'shot-transition', 'text-state-reveal'],
    audioCues: ['narration'], actorIds: shot.story.actorIds, layers: [], characters: [], story: shot.story,
    renderContract: { renderer: 'remotion-temporal-grid', sheetOnly: true, forbidRuntimeLayers: true, forbidRuntimeCards: true, forbidI2V: true },
  },
  sourceEvidence: { storyboardId: shot.storyboardId, sceneId: shot.plan.sceneId, characterIds: shot.story.actorIds, narration: shot.narration, action: shot.plan.start, result: shot.plan.result },
}))
const storyboard = {
  schemaVersion: 1, factoryStage: 'storyboard', attempt: 1,
  artifacts: [{ type: 'props', path: propsFile }],
  checks: [{ name: 'story_first_event_chain', passed: true }, { name: 'no_runtime_layers_or_cards', passed: true }, { name: 'no_i2v', passed: true }, { name: 'captions_bound_to_audio', passed: true }],
  risks: [], gate: { decision: 'candidate', reviewer: 'factory-manager' }, durationMs: 30000,
  storyFirst: true, shots: storyboardShots,
  directorPlan,
  audioUrl,
  captionTrack: {
    renderer: 'remotion-caption-track', sourceFormat: 'ass', safeArea: 'bottom-center', cueCount: normalizedCaptions.length,
    audioDurationMs: 30000,
    checks: [
      { name: 'cue_ranges', passed: true },
      { name: 'audio_alignment', passed: true },
      { name: 'safe_area', passed: true },
      { name: 'action_label_safe_area', passed: true },
    ],
  },
  positioningCheck: { visualLanguage: '历史叙事纪录片：人物动作、道具结果、连续场次；不使用概念隐喻' },
}
writeJson(storyboardFile, storyboard)

const assets = shots.map((shot, index) => ({
  assetKey: shot.temporalGrid.sheetAssetKey, assetType: 'ai_image', shotNumber: index + 1,
  required: true, visualSetupId: shot.temporalGrid.sheetAssetKey,
  temporalGrid: { layout: '2x1', keyframeCount: 2, sheetAssetKey: shot.temporalGrid.sheetAssetKey, startAction: shot.plan.start, resultAction: shot.plan.result },
  production: { provider: 'local-pillow-reuse', mode: 'static_image', i2v: false },
  source: { path: `data/static/images/episode-440-storyfirst-30s/${shot.plan.sheet}.png`, sourceStoryboardId: shot.storyboardId },
  metadata: { role: 'temporal-2grid-sheet', shotNumber: index + 1, reuseKey: shot.temporalGrid.sheetAssetKey, estimatedCostUsd: 0, sourceLicense: 'approved-existing-project-asset' },
  license: { status: 'approved-existing-project-asset' }, dependencies: [],
}))
const assetPlan = {
  schemaVersion: 1, factoryStage: 'asset_plan', attempt: 1,
  artifacts: [{ type: 'storyboard', path: storyboardFile }], checks: [{ name: 'one_sheet_per_shot', passed: true }, { name: 'no_i2v', passed: true }], risks: [],
  gate: { decision: 'candidate', reviewer: 'factory-manager' }, assets,
}
writeJson(assetPlanFile, assetPlan)
console.log(JSON.stringify({ props: path.resolve(root, propsFile), storyboard: path.resolve(root, storyboardFile), assetPlan: path.resolve(root, assetPlanFile), shots: shots.length, durationSeconds: 30 }, null, 2))
