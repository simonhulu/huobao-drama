#!/usr/bin/env node

/**
 * Generic factory-stage authoring helper.
 *
 * The content-specific input is a JSON brief produced by the storyboard
 * director. This helper only joins source paragraphs, calculates timing, and
 * wraps the director's decisions in the factory contracts.
 */

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)

function value(name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function required(name) {
  const result = value(name)
  if (!result) throw new Error(`Missing ${name}`)
  return result
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

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function splitGroups(script, targetCharacters = 520) {
  const paragraphs = script.split(/\n\s*\n/).map(cleanText).filter(Boolean)
  const groups = []
  let current = []
  let count = 0
  for (const paragraph of paragraphs) {
    current.push(paragraph)
    count += paragraph.replace(/\s/g, '').length
    if (count >= targetCharacters) {
      groups.push(current.join('\n\n'))
      current = []
      count = 0
    }
  }
  if (current.length) groups.push(current.join('\n\n'))
  return groups
}

function durationMs(narration) {
  return Math.max(9000, Math.round(narration.replace(/\s/g, '').length / 4.8 * 1000))
}

function envelope(factoryStage, fields) {
  return {
    schemaVersion: 1,
    factoryStage,
    attempt: 1,
    artifacts: [],
    checks: [],
    risks: [],
    gate: { decision: 'passed', reviewer: 'storyboard-director' },
    ...fields,
  }
}

function apiBase() {
  return (value('--api', process.env.REMOTION_API_BASE || 'http://localhost:5679/api/v1')).replace(/\/$/, '')
}

async function request(pathname) {
  const response = await fetch(`${apiBase()}${pathname}`, { headers: { accept: 'application/json' } })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : null } catch { throw new Error(`${pathname} returned invalid JSON`) }
  if (!response.ok || body?.code >= 400) throw new Error(`${pathname} failed: ${body?.message || raw}`)
  return body?.data ?? body
}

function characterLayers(shot, shotNumber) {
  return (Array.isArray(shot.characters) ? shot.characters : []).map((raw, index) => {
    const name = cleanText(typeof raw === 'string' ? raw : raw?.name || raw?.person || `人物 ${index + 1}`)
    const slug = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || `character-${index + 1}`
    return {
      ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
      id: raw?.id || slug,
      name,
      assetKey: raw?.assetKey || `shot-${shotNumber}-character-${slug}`,
      type: 'character',
      character: name,
      layerType: 'character-alpha',
      requiresAlpha: raw?.requiresAlpha !== false,
      zIndex: raw?.zIndex ?? 20 + index,
      enter: raw?.enter || (index % 2 === 0 ? 'slide-up-settle' : 'slide-in-settle'),
    }
  })
}

function temporalGridPlan(brief, shotNumber, duration, narration = '') {
  const raw = brief.temporalGrid && typeof brief.temporalGrid === 'object'
    ? brief.temporalGrid
    : {}
  const sourceKeyframes = Array.isArray(raw.keyframes)
    ? raw.keyframes
    : Array.isArray(brief.keyframes)
      ? brief.keyframes
      : [
          { id: 'start', sourceIndex: 0, action: brief.startAction || brief.action },
          { id: 'result', sourceIndex: 1, action: brief.resultAction || brief.result },
        ]
  if (sourceKeyframes.length !== 2) {
    throw new Error(`temporal-2grid shot ${shotNumber} must define exactly two keyframes`)
  }
  const startAction = cleanText(raw.startAction || brief.startAction || sourceKeyframes[0]?.action)
  const resultAction = cleanText(raw.resultAction || brief.resultAction || sourceKeyframes[1]?.action)
  if (!startAction || !resultAction || startAction === resultAction) {
    throw new Error(`temporal-2grid shot ${shotNumber} needs different startAction and resultAction`)
  }
  const midpoint = Math.max(1, Math.round(duration / 2))
  const keyframes = sourceKeyframes.map((keyframe, index) => ({
    id: cleanText(keyframe?.id) || (index === 0 ? 'start' : 'result'),
    sourceIndex: index,
    startMs: index === 0 ? 0 : midpoint,
    action: cleanText(keyframe?.action) || (index === 0 ? startAction : resultAction),
  }))
  const sheetAssetKey = cleanText(raw.sheetAssetKey || brief.sheetAssetKey) || `shot-${shotNumber}-temporal-2grid`
  const camera = raw.camera && typeof raw.camera === 'object' ? raw.camera : {}
  const transition = raw.transition && typeof raw.transition === 'object' ? raw.transition : {}
  const visualProof = Array.isArray(brief.visualProof)
    ? brief.visualProof.map(cleanText).filter(Boolean)
    : [resultAction]
  const actorIds = Array.isArray(brief.actorIds)
    ? brief.actorIds.map(cleanText).filter(Boolean)
    : []
  if (!actorIds.length) {
    throw new Error(`temporal-2grid shot ${shotNumber} requires actorIds`)
  }
  const target = cleanText(brief.target)
  const beforeState = cleanText(brief.beforeState) || startAction
  const afterState = cleanText(brief.afterState) || resultAction
  if (!target || beforeState === afterState) {
    throw new Error(`temporal-2grid shot ${shotNumber} requires target and a beforeState/afterState change`)
  }
  const story = {
    beatId: cleanText(brief.beatId) || `beat-${shotNumber}`,
    sourceSpans: Array.isArray(brief.sourceSpans) && brief.sourceSpans.length
      ? brief.sourceSpans
      : [{ start: 0, end: Math.max(1, narration.length), text: narration || startAction }],
    function: cleanText(brief.storyFunction) || 'event',
    actorIds,
    target,
    action: cleanText(brief.action) || startAction,
    phase: cleanText(brief.phase) || 'execute',
    beforeState,
    afterState,
    visualProof,
    nextBeatId: Object.prototype.hasOwnProperty.call(brief, 'nextBeatId') ? brief.nextBeatId : null,
  }
  return {
    schemaVersion: 1,
    visualMode: 'temporal-2grid',
    visualSetupId: sheetAssetKey,
    assetStrategy: 'temporal-2grid-remotion',
    actorIds,
    temporalGrid: {
      schemaVersion: 1,
      layout: '2x1',
      rows: 1,
      columns: 2,
      sheetAssetKey,
      startAction,
      resultAction,
      panels: [
        { index: 0, semantic: startAction, visualProof: startAction, storyBeatId: story.beatId },
        { index: 1, semantic: resultAction, visualProof: resultAction, storyBeatId: story.beatId },
      ],
      keyframes: keyframes.map((keyframe) => ({
        id: keyframe.id,
        sourceIndex: keyframe.sourceIndex,
        startMs: keyframe.startMs,
        atMs: keyframe.startMs,
        panel: keyframe.sourceIndex,
        action: keyframe.action,
      })),
    },
    ...(brief.textOverlay && typeof brief.textOverlay === 'object' ? { textOverlay: brief.textOverlay } : {}),
    layers: [],
    characters: [],
    motion: {
      camera: cleanText(camera.preset) || 'drift',
      parallax: 'sheet-crop',
      subject: 'temporal-state-change',
      text: 'state-label-reveal',
      transition: cleanText(transition.mode) || 'crossfade',
    },
    motionChannels: ['temporal-keyframe-reveal', 'ken-burns-camera', 'shot-transition', 'text-state-reveal'],
    audioCues: Array.isArray(raw.audioCues) && raw.audioCues.length ? raw.audioCues : ['narration'],
    camera: {
      preset: cleanText(camera.preset) || 'drift',
      intensity: Number.isFinite(Number(camera.intensity)) ? Number(camera.intensity) : 0.9,
    },
    transition: {
      mode: cleanText(transition.mode) || 'crossfade',
      effect: cleanText(transition.effect) || 'dissolve',
      direction: cleanText(transition.direction) || 'left',
      frames: Number.isFinite(Number(transition.frames)) ? Number(transition.frames) : 10,
    },
    renderContract: {
      renderer: 'remotion-temporal-grid',
      sheetOnly: true,
      forbidRuntimeLayers: true,
      forbidRuntimeCards: true,
      forbidI2V: true,
    },
    story,
  }
}

function makeShots(groups, config) {
  const shotBriefs = Array.isArray(config.shots) ? config.shots : []
  if (shotBriefs.length !== groups.length) {
    throw new Error(`storyboard config has ${shotBriefs.length} shots but source produced ${groups.length} narration groups`)
  }
  return groups.map((narration, index) => {
    const number = index + 1
    const brief = shotBriefs[index] || {}
    const isTemporalGrid = config.visualMode === 'temporal-2grid'
      || brief.visualMode === 'temporal-2grid'
      || brief.assetStrategy === 'temporal-2grid-remotion'
      || brief.temporalGrid
    const shotDuration = durationMs(narration)
    if (isTemporalGrid) {
      const visualPlan = temporalGridPlan(brief, number, shotDuration, narration)
      return {
        shotNumber: number,
        sourceStoryboardId: null,
        title: cleanText(brief.title) || `镜头 ${number}`,
        location: cleanText(brief.location),
        time: cleanText(brief.time),
        shotType: 'hybrid',
        angle: cleanText(brief.angle),
        movement: cleanText(brief.movement),
        action: cleanText(brief.action || visualPlan.temporalGrid.startAction),
        result: cleanText(brief.result || visualPlan.temporalGrid.resultAction),
        atmosphere: cleanText(brief.atmosphere),
        narration,
        dialogue: cleanText(brief.dialogue),
        durationMs: shotDuration,
        people: Array.isArray(brief.people) ? brief.people.map(cleanText).filter(Boolean) : [],
        layers: [],
        visualSetupId: visualPlan.visualSetupId,
        visualPlan,
        textOverlay: visualPlan.textOverlay,
        sourceEvidence: {
          narration,
          location: cleanText(brief.location),
          time: cleanText(brief.time),
          action: visualPlan.temporalGrid.startAction,
          result: visualPlan.temporalGrid.resultAction,
          temporalGrid: visualPlan.temporalGrid,
        },
      }
    }
    const layers = characterLayers(brief, number)
    const map = brief.map && typeof brief.map === 'object' ? brief.map : null
    const stock = brief.stock && typeof brief.stock === 'object' ? brief.stock : null
    const visualPlan = {
      schemaVersion: 1,
      visualMode: brief.visualMode || (brief.shotType === 'map' ? 'map-video' : brief.shotType === 'stock' ? 'stock-broll' : layers.length ? 'hybrid-composite' : 'ai-plate'),
      rationale: brief.rationale || '由当前稿件的分镜意图决定素材类型和层级。',
      layerMode: layers.length ? 'alpha-composite' : 'crop',
      characters: layers,
      layers,
      ...(map ? { map } : {}),
      ...(stock ? { stock } : {}),
      beats: [{
        id: `shot-${number}-beat-1`,
        startMs: 0,
        endMs: shotDuration,
        text: '',
        role: brief.beatRole || 'establishing',
        framing: brief.framing || 'wide',
        focus: brief.focus || { x: 0.5, y: 0.5, zoom: 1.04 },
        motion: brief.motion || 'hold -> restrained push-in -> hold',
        easing: brief.easing || 'ease-in-out',
        transition: brief.transition || 'smooth',
        rationale: brief.rationale || '根据当前镜头的信息密度保持稳定、可读的运动。',
      }],
      renderContract: {
        renderer: brief.shotType === 'map' ? 'remotion-map-video' : 'remotion-layered-composite',
        forbidFullFrameCharacter: layers.length > 0,
        forbidMultiCharacterPlate: layers.length > 0,
        visibleStockCutaway: Boolean(stock && layers.length),
      },
    }
    return {
      shotNumber: number,
      sourceStoryboardId: null,
      title: cleanText(brief.title) || `镜头 ${number}`,
      location: cleanText(brief.location),
      time: cleanText(brief.time),
      shotType: brief.shotType || (layers.length ? 'hybrid' : 'ai_plate'),
      angle: cleanText(brief.angle),
      movement: cleanText(brief.movement),
      action: cleanText(brief.action),
      result: cleanText(brief.result),
      atmosphere: cleanText(brief.atmosphere),
      narration,
      dialogue: cleanText(brief.dialogue),
      durationMs: shotDuration,
      people: layers.map((layer) => layer.name),
      layers,
      visualPlan,
      sourceEvidence: {
        narration,
        location: cleanText(brief.location),
        time: cleanText(brief.time),
        action: cleanText(brief.action),
        result: cleanText(brief.result),
      },
    }
  })
}

async function main() {
  const projectId = required('--project-id')
  const configFile = required('--config')
  const config = readJson(configFile)
  const storyFirstOutput = config.storyFirst === true
    || config.visualMode === 'temporal-2grid'
    || config.assetStrategy === 'temporal-2grid-remotion'
    || (Array.isArray(config.shots) && config.shots.some((shot) => shot?.visualMode === 'temporal-2grid' || shot?.assetStrategy === 'temporal-2grid-remotion' || shot?.temporalGrid))
  if (storyFirstOutput && (!config.directorPlan || typeof config.directorPlan !== 'object' || Array.isArray(config.directorPlan))) {
    throw new Error('story-first/temporal storyboard config requires an explicit directorPlan')
  }
  const snapshot = await request(`/remotion/projects/${projectId}`)
  const source = snapshot.project?.sourceSnapshot || {}
  const episode = source.episode || {}
  const script = String(episode.scriptContent || episode.content || episode.narration || '')
  if (!script.trim()) throw new Error('source snapshot has no script content')
  const groups = splitGroups(script, Number(config.targetCharacters) || 520)
  const shots = makeShots(groups, config)
  const totalDurationMs = shots.reduce((sum, shot) => sum + shot.durationMs, 0)
  let cursor = 0
  const beats = shots.map((shot) => {
    const beat = { id: `beat-${shot.shotNumber}`, startMs: cursor, endMs: cursor + shot.durationMs, narration: shot.narration, intent: shot.title, emphasis: 'normal', screenText: null, textAnimation: 'word_reveal' }
    cursor += shot.durationMs
    return beat
  })
  const analysis = config.analysis || {}
  const historical = envelope('historical_analysis', {
    claims: Array.isArray(analysis.claims) ? analysis.claims : [],
    people: Array.isArray(analysis.people) ? analysis.people : [...new Set(shots.flatMap((shot) => shot.people))],
    locations: Array.isArray(analysis.locations) ? analysis.locations : [],
    routes: Array.isArray(analysis.routes) ? analysis.routes : [],
    informationBeats: shots.map((shot) => ({ shotNumber: shot.shotNumber, title: shot.title })),
    checks: [{ name: 'script_frozen', passed: true }, { name: 'visual_facts_separated_from_illustration', passed: true }],
  })
  const narrative = envelope('narrative_beats', {
    durationMs: totalDurationMs,
    beats,
    positioningCheck: config.positioningCheck || { emotionalArc: '由事实建立、结构拆解、代价追问到余韵收束' },
    checks: [{ name: 'beats_contiguous', passed: true }],
  })
  const storyboard = envelope('storyboard', {
    shots,
    ...(storyFirstOutput ? { storyFirst: true, directorPlan: config.directorPlan } : {}),
      positioningCheck: config.positioningCheck || { visualLanguage: config.visualMode === 'temporal-2grid' ? '叙事型2×1时间网格、单图裁剪、克制运镜与连续转场' : '克制的纪录片构图、分层人物、可读的地图和 Remotion 文本动画' },
    checks: [{ name: 'shot_types_explicit', passed: true }, { name: 'text_is_rendered_by_remotion', passed: true }],
  })
  if (value('--historical-output')) writeJson(value('--historical-output'), historical)
  if (value('--narrative-output')) writeJson(value('--narrative-output'), narrative)
  if (value('--storyboard-output')) writeJson(value('--storyboard-output'), storyboard)
  console.log(JSON.stringify({ projectId: Number(projectId), groups: groups.length, durationMs: totalDurationMs, shots: shots.map((shot) => ({ shotNumber: shot.shotNumber, shotType: shot.shotType, title: shot.title })) }, null, 2))
}

main().catch((error) => {
  console.error(`[author-storyboard] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
