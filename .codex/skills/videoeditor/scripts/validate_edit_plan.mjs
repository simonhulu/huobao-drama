#!/usr/bin/env node

import fs from 'node:fs'

/**
 * Validate the inspectable timeline contract used by the videoeditor skill.
 * Usage: validate_edit_plan.mjs <episode-snapshot.json> <edit-plan.json>
 */

const [snapshotPath, planPath] = process.argv.slice(2)
if (!snapshotPath || !planPath) {
  console.error('Usage: validate_edit_plan.mjs <episode-snapshot.json> <edit-plan.json>')
  process.exit(2)
}

function readJson(filePath) {
  const raw = filePath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}

function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function closeEnough(a, b, tolerance = 0.1) {
  return Math.abs(Number(a) - Number(b)) <= tolerance
}

function numberInRange(value, min, max) {
  return Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max
}

const EASINGS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out'])
const TRANSITIONS = new Set(['smooth', 'cut', 'flash', 'dip-black'])
const LAYER_MODES = new Set(['crop', 'parallax'])
const REQUIRED_BEAT_FIELDS = [
  'id', 'start', 'end', 'text', 'role', 'framing', 'focus', 'motion',
  'easing', 'transition', 'rationale', 'layerMode', 'layers', 'fallback', 'warnings',
]

let snapshot
let plan
try {
  snapshot = readJson(snapshotPath)
  plan = readJson(planPath)
} catch (error) {
  console.error(`[videoeditor] invalid JSON: ${error.message}`)
  process.exit(1)
}

const errors = []
const warnings = []
const snapshotShots = Array.isArray(snapshot?.storyboards) ? snapshot.storyboards : []
const planShots = Array.isArray(plan?.shots) ? plan.shots : []

if (plan?.schemaVersion !== 1) errors.push('plan.schemaVersion must be 1')
if (!Number.isInteger(Number(plan?.episodeId))) errors.push('plan.episodeId must be an integer')
if (Number(plan?.episodeId) !== Number(snapshot?.episode?.id)) errors.push('plan.episodeId does not match snapshot episode.id')
if (planShots.length !== snapshotShots.length) {
  errors.push(`plan.shots length ${planShots.length} does not match snapshot storyboards length ${snapshotShots.length}`)
}

const snapshotById = new Map(snapshotShots.map((shot) => [Number(shot.id), shot]))
const seenIds = new Set()

for (const shot of planShots) {
  const shotId = Number(shot?.shotId)
  const source = snapshotById.get(shotId)
  if (!Number.isInteger(shotId)) {
    errors.push('every shot.shotId must be an integer')
    continue
  }
  if (seenIds.has(shotId)) errors.push(`duplicate shotId ${shotId}`)
  seenIds.add(shotId)
  if (!source) {
    errors.push(`shot ${shotId} is not present in the episode snapshot`)
    continue
  }

  const duration = Number(source.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    warnings.push(`shot ${shotId} has no positive source duration; fallback validation applies`)
  }
  if (!closeEnough(shot.duration, duration)) errors.push(`shot ${shotId} duration does not match source duration`)

  const evidence = shot.sourceEvidence || {}
  const evidenceKeys = ['narration', 'dialogue', 'videoPrompt', 'movement', 'asset']
  const evidenceCount = evidenceKeys.filter((key) => isNonEmpty(evidence[key])).length
  const shotWarnings = Array.isArray(shot.warnings) ? shot.warnings : []
  if (evidenceCount < 4 && !shotWarnings.some((item) => /missing|unavailable|fallback|缺|无/i.test(String(item)))) {
    errors.push(`shot ${shotId} has fewer than four evidence fields without an explicit missing-data warning`)
  }

  const beats = Array.isArray(shot.beats) ? shot.beats : []
  if (beats.length === 0) {
    errors.push(`shot ${shotId} has no beats`)
    continue
  }
  let previousEnd = 0
  let previousSignature = null
  for (let index = 0; index < beats.length; index += 1) {
    const beat = beats[index]
    for (const field of REQUIRED_BEAT_FIELDS) {
      if (!(field in (beat || {}))) errors.push(`shot ${shotId} beat ${index + 1} is missing ${field}`)
    }
    const start = Number(beat?.start)
    const end = Number(beat?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      errors.push(`shot ${shotId} beat ${index + 1} has invalid start/end`)
      continue
    }
    if (start < -0.001 || end > duration + 0.001) errors.push(`shot ${shotId} beat ${index + 1} exceeds shot duration`)
    if (index === 0 && Math.abs(start) > 0.05) errors.push(`shot ${shotId} first beat does not start at zero`)
    if (index > 0) {
      const gap = start - previousEnd
      if (gap < -0.001) errors.push(`shot ${shotId} beats overlap at beat ${index + 1}`)
      if (gap > 0.05) errors.push(`shot ${shotId} has a gap of ${gap.toFixed(3)}s before beat ${index + 1}`)
    }
    if (!isNonEmpty(beat?.text) || !isNonEmpty(beat?.role) || !isNonEmpty(beat?.framing)) {
      errors.push(`shot ${shotId} beat ${index + 1} lacks text, role, or framing`)
    }
    if (!isNonEmpty(beat?.motion) || !EASINGS.has(beat?.easing) || !TRANSITIONS.has(beat?.transition)) {
      errors.push(`shot ${shotId} beat ${index + 1} lacks executable motion/easing/transition`)
    }
    if (!isNonEmpty(beat?.rationale)) errors.push(`shot ${shotId} beat ${index + 1} lacks rationale`)
    if (!LAYER_MODES.has(beat?.layerMode)) errors.push(`shot ${shotId} beat ${index + 1} has invalid layerMode`)
    if (!Array.isArray(beat?.warnings)) errors.push(`shot ${shotId} beat ${index + 1} warnings must be an array`)
    const focus = beat?.focus || {}
    if (!numberInRange(focus.x, 0, 1) || !numberInRange(focus.y, 0, 1) || !numberInRange(focus.zoom, 1, 2.2)) {
      errors.push(`shot ${shotId} beat ${index + 1} has invalid focus coordinates or zoom`)
    }

    if (beat?.layerMode === 'crop' && Array.isArray(beat.layers) && beat.layers.length > 0) {
      errors.push(`shot ${shotId} beat ${index + 1} has layers while layerMode is crop`)
    }
    if (beat?.layerMode === 'parallax') {
      if (!Array.isArray(beat.layers) || beat.layers.length < 2 || beat.layers.length > 4) {
        errors.push(`shot ${shotId} beat ${index + 1} parallax must contain 2-4 layers`)
      }
      if (!isNonEmpty(beat.fallback)) errors.push(`shot ${shotId} beat ${index + 1} parallax lacks crop fallback`)
      for (const layer of Array.isArray(beat.layers) ? beat.layers : []) {
        if (!isNonEmpty(layer?.name) || !numberInRange(layer?.depth, 0, 1) || !numberInRange(layer?.motionMultiplier, 0, 1.5)) {
          errors.push(`shot ${shotId} beat ${index + 1} has invalid parallax layer metadata`)
        }
      }
    }

    const signature = JSON.stringify([beat.motion, beat.easing, beat.transition, focus.x, focus.y, focus.zoom])
    if (previousSignature === signature && !/hold|still|静止|定格|停留|延续|continue/i.test(`${beat.role} ${beat.rationale} ${beat.motion}`)) {
      errors.push(`shot ${shotId} beats ${index} and ${index + 1} reuse the same motion without a hold rationale`)
    }
    previousSignature = signature
    previousEnd = end
  }
  if (Number.isFinite(duration) && beats.length > 0 && !closeEnough(previousEnd, duration)) {
    errors.push(`shot ${shotId} beat timeline ends at ${previousEnd.toFixed(3)}s, expected ${duration.toFixed(3)}s`)
  }
}

for (const source of snapshotShots) {
  if (!seenIds.has(Number(source.id))) errors.push(`snapshot storyboard ${source.id} is missing from plan.shots`)
}

const result = {
  valid: errors.length === 0,
  episodeId: Number(snapshot?.episode?.id),
  shots: planShots.length,
  errors,
  warnings,
}
console.log(JSON.stringify(result, null, 2))
if (errors.length > 0) process.exit(1)
