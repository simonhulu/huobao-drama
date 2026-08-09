const MOTION_PRESETS = {
  'establish-pull': { scaleFrom: 1.09, scaleTo: 1.025, xFrom: 0, xTo: 0, yFrom: 4, yTo: -2, easing: 'ease-in-out', transition: 'dissolve' },
  'impact-push': { scaleFrom: 1.025, scaleTo: 1.14, xFrom: -5, xTo: 4, yFrom: 2, yTo: -3, easing: 'ease-out', transition: 'cut' },
  'memory-pull': { scaleFrom: 1.11, scaleTo: 1.035, xFrom: 4, xTo: -3, yFrom: -4, yTo: 3, easing: 'ease-in-out', transition: 'dissolve' },
  'restrained-hold': { scaleFrom: 1.055, scaleTo: 1.075, xFrom: 0, xTo: 0, yFrom: 0, yTo: -2, easing: 'ease-out', transition: 'cut' },
  'reveal-push': { scaleFrom: 1.035, scaleTo: 1.105, xFrom: 3, xTo: -2, yFrom: 2, yTo: -2, easing: 'ease-out', transition: 'cut' },
  'action-follow': { scaleFrom: 1.06, scaleTo: 1.09, xFrom: -9, xTo: 8, yFrom: 3, yTo: -3, easing: 'ease-in-out', transition: 'cut' },
  'slow-push': { scaleFrom: 1.04, scaleTo: 1.095, xFrom: -4, xTo: 3, yFrom: 2, yTo: -3, easing: 'ease-in-out', transition: 'dissolve' },
}

function normalizeText(value) {
  return String(value || '').replace(/[\s，。！？；：、“”‘’《》（）()\-—…,.!?;:'"\[\]]+/gu, '')
}

function equalWindows(event, beats) {
  const duration = Math.max(0, event.endMs - event.startMs)
  return beats.map((beat, index) => ({
    id: beat.id,
    startMs: Math.round(event.startMs + duration * index / beats.length),
    endMs: index === beats.length - 1
      ? event.endMs
      : Math.round(event.startMs + duration * (index + 1) / beats.length),
  }))
}

function locateAnchor(anchorText, captions) {
  const anchor = normalizeText(anchorText)
  if (!anchor) return null
  const matches = []
  for (const caption of captions) {
    const text = normalizeText(caption.text)
    if (!text.length) continue
    let cursor = 0
    while (cursor <= text.length - anchor.length) {
      const index = text.indexOf(anchor, cursor)
      if (index < 0) break
      const ratio = index / text.length
      matches.push(Math.round(caption.startMs + (caption.endMs - caption.startMs) * ratio))
      cursor = index + Math.max(1, anchor.length)
    }
  }
  return matches.length === 1 ? matches[0] : null
}

export function deriveWaypointWindows({ event, beats, captions }) {
  if (!Array.isArray(beats) || beats.length === 0) return { strategy: 'empty', windows: [] }
  const relevantCaptions = (captions || []).filter((caption) => (
    caption.endMs > event.startMs && caption.startMs < event.endMs
  ))
  const located = beats.map((beat, index) => (
    index === 0 ? event.startMs : locateAnchor(beat.anchorText, relevantCaptions)
  ))
  const invalidOrder = located.some((value, index) => (
    index > 0
    && value != null
    && (value <= Number(located[index - 1]) || value >= event.endMs)
  ))
  if (located.some((value) => value == null) || invalidOrder) {
    return {
      strategy: 'equal-fallback',
      fallbackReason: invalidOrder ? 'anchor-order' : 'anchor-missing-or-ambiguous',
      windows: equalWindows(event, beats),
    }
  }

  const starts = located.map(Number)
  const windows = beats.map((beat, index) => ({
    id: beat.id,
    startMs: starts[index],
    endMs: index === beats.length - 1 ? event.endMs : starts[index + 1],
  }))
  return { strategy: 'narration-anchor', windows }
}

export class NarrativeStoryboardTimingError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'NarrativeStoryboardTimingError'
    this.code = 'INVALID_NARRATIVE_STORYBOARD_TIMING'
    this.details = details
  }
}

export function requireNarrationAnchoredWaypointWindows(input) {
  const timing = deriveWaypointWindows(input)
  if ((input.beats?.length || 0) > 1 && timing.strategy !== 'narration-anchor') {
    throw new NarrativeStoryboardTimingError(
      `Waypoint group requires unique ordered narration anchors (${timing.fallbackReason || timing.strategy})`,
      {
        eventId: input.event?.id,
        beatIds: (input.beats || []).map((beat) => beat.id),
        fallbackReason: timing.fallbackReason,
      },
    )
  }
  return timing
}

export function planSemanticMotion({ description = '', eventText = '', index = 0 }) {
  const evidence = `${description} ${eventText}`.toLowerCase()
  let preset = 'slow-push'
  if (/childhood|memory|童年|小时候|回忆/u.test(evidence)) preset = 'memory-pull'
  else if (/sudden|strike|impact|hit|attack|挥击|动手|冲击|坠马|失去平衡/u.test(evidence)) preset = 'impact-push'
  else if (/silence|suppress|dismiss|关闭|压下|遮掩|噤声|遣散/u.test(evidence)) preset = 'restrained-hold'
  else if (/reveal|truth|question|why|真相|揭出|为什么|发现/u.test(evidence)) preset = 'reveal-push'
  else if (/approach|pursuit|follow|draws|走向|穿过|逼近|追|放箭|拉满弓/u.test(evidence)) preset = 'action-follow'
  else if (/\bews\b|\bws\b|establish|enters|建立|全景|进入|猎队/u.test(evidence)) preset = 'establish-pull'

  const motion = MOTION_PRESETS[preset]
  const mirror = index % 2 === 1 ? -1 : 1
  return {
    preset,
    ...motion,
    xFrom: motion.xFrom * mirror,
    xTo: motion.xTo * mirror,
  }
}

export function classifyStoryboardImageFailure(error) {
  const message = String(error?.message || error || '').toLowerCase()
  if (/content.?policy|safety.?rejection|policy.?violation|moderation/u.test(message)) {
    return {code: 'content_policy', retryable: false, safeToResubmit: false}
  }
  if (/invalid|validation|aspect.?ratio|config.?id|required|unsupported/u.test(message)) {
    return {code: 'validation', retryable: false, safeToResubmit: false}
  }
  if (/429|rate.?limit|overloaded|temporar|econnreset|eai_again|502|503|504/u.test(message)) {
    return {code: 'provider_overloaded', retryable: true, safeToResubmit: true}
  }
  if (/^post\b|post .*fetch failed|submission.*uncertain|socket hang up/u.test(message)) {
    return {code: 'submission_uncertain', retryable: false, safeToResubmit: false}
  }
  if (/timed out|timeout|still processing|pending/u.test(message)) {
    return {code: 'provider_pending', retryable: false, safeToResubmit: false}
  }
  if (/\bfailed:/u.test(message)) {
    return {code: 'provider_failed', retryable: false, safeToResubmit: false}
  }
  return {code: 'unknown', retryable: false, safeToResubmit: false}
}

export function selectImageRecoveryAction({ force, localExists, stateStatus, providerStatus, errorClass, attempts = 0, maxAttempts = 3 }) {
  if (force) return 'resubmit'
  if (stateStatus === 'completed' && localExists) return 'reuse'
  if (stateStatus === 'submitted') {
    if (providerStatus === 'completed') return 'adopt'
    if (providerStatus && !['failed', 'canceled', 'stale'].includes(providerStatus)) return 'wait'
    if (providerStatus === 'failed') {
      return errorClass === 'provider_overloaded' && attempts < maxAttempts ? 'resubmit' : 'blocked'
    }
  }
  if (stateStatus === 'failed') return errorClass === 'provider_overloaded' && attempts < maxAttempts ? 'resubmit' : 'blocked'
  return 'resubmit'
}

export function buildNonGraphicConstraint(riskTags = []) {
  const tags = new Set(riskTags)
  const constraints = []
  if (tags.has('covered_aftermath')) {
    constraints.push('Show aftermath only with the person fully covered on a plain stretcher; preserve the visible evidence and witness reactions.')
  }
  if (tags.has('covered_injury')) {
    constraints.push('Show consequences through damaged clothing, armor, posture, and a clean cloth wrap; keep the injury fully covered.')
  }
  if (tags.has('weapon_contact')) {
    constraints.push('Keep cause and effect legible through weapon trajectory and body balance while the exact contact remains concealed by clothing, distance, or foreground geometry.')
  }
  if (tags.has('minor_hardship')) {
    constraints.push('Portray the historical youth respectfully in an ordinary period setting, without distress, punishment, restraint, threat, or dangerous interaction.')
  }
  if (constraints.length) {
    constraints.push('No blood, open wound, gore, exposed tissue, exposed remains, or close-up injury.')
  }
  return constraints.join(' ')
}
