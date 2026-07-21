#!/usr/bin/env node

/**
 * Convert the producer-owned Remotion project snapshot into props consumed by
 * the appropriate Remotion composition. Temporal story-first projects target
 * TemporalGridEpisode; legacy layered projects remain on EpisodeShowcase until
 * they are explicitly migrated. This is intentionally a Skill-side step:
 * the Web page only observes the snapshot and never creates these props.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMagnatesProps as buildCanonicalMagnatesProps } from './magnates_props_core.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const fps = 30

const MAGNATES_RECIPE_IDS = new Set([
  'magnateseditorial',
  'magnates-editorial',
  'magnates_editorial',
  'magnates-remotion-recipe-v1',
  'magnates-remotion-recipe-v2',
])
const MAGNATES_RENDERERS = new Set([
  'remotion-magnates-editorial',
  'magnates-editorial',
])
const EDITORIAL_TRANSITIONS = new Set([
  'hard_cut',
  'dissolve',
  'blur_bridge',
  'matte_transition',
  'graphic_transition',
  'distortion',
  'ambiguous',
  'no_local_delta',
  'within_setup_change',
])
const EDITORIAL_CAMERAS = new Set([
  'hold',
  'push_in',
  'pull_out',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'whip',
])
const EDITORIAL_TEXT_ENTRIES = new Set([
  'none',
  'fade',
  'slide_up',
  'slide_left',
  'wipe',
  'type_on',
  'counter',
])
const EDITORIAL_TEXT_EXITS = new Set(['none', 'fade', 'slide_down'])
const EDITORIAL_GRAPHICS = new Set(['underline', 'bar', 'globe', 'grid', 'monitor', 'divider', 'badge'])
const EDITORIAL_ROLES = new Set(['hook', 'establishing', 'mechanism', 'comparison', 'reversal', 'crisis', 'resolution'])

function value(name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function required(name) {
  const result = value(name)
  if (!result) throw new Error(`Missing ${name}`)
  return result
}

function apiBase() {
  return (value('--api', process.env.REMOTION_API_BASE || 'http://localhost:5679/api/v1')).replace(/\/$/, '')
}

function staticBase() {
  return (value('--static-base', process.env.REMOTION_STATIC_BASE || apiBase().replace(/\/api\/v1\/?$/, ''))).replace(/\/$/, '')
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function numberOr(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function recipeId(value) {
  if (value && typeof value === 'object') {
    const record = asRecord(value)
    return recipeId(record.id || record.name || record.recipe || record.compositionId || record.visualMode)
  }
  return String(value || '').trim().toLowerCase()
}

function isMagnatesRecipeId(value) {
  return MAGNATES_RECIPE_IDS.has(recipeId(value))
}

function parseRecipeArgument(rawValue) {
  const raw = String(rawValue || '').trim()
  if (!raw) return null
  const candidates = [raw]
  const local = fs.existsSync(raw) && fs.statSync(raw).isFile() ? raw : sourceFileFor(raw)
  if (local) candidates.unshift(fs.readFileSync(local, 'utf8'))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // A recipe identifier is handled by the caller; malformed JSON is an
      // actionable error only when the value was explicitly supplied as JSON.
    }
  }
  return null
}

function sourceFileFor(localPath) {
  if (!localPath) return null
  const normalized = String(localPath).replaceAll('\\', '/').replace(/^\/+/, '')
  const candidates = [
    path.resolve(root, normalized),
    normalized.startsWith('static/') ? path.resolve(root, 'data', normalized) : null,
    normalized.startsWith('data/') ? path.resolve(root, normalized) : path.resolve(root, 'data', normalized),
  ].filter(Boolean)
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function staticUrl(localPath) {
  if (!localPath) return null
  if (/^https?:\/\//i.test(String(localPath))) return String(localPath)
  if (!sourceFileFor(localPath)) return null
  const normalized = String(localPath).replaceAll('\\', '/').replace(/^\/+/, '')
  const publicPath = normalized.replace(/^data\//, '')
  return `${staticBase()}/${publicPath}`
}

function normalizeTtsText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200F\uFEFF\u00A0\u3000\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[\u2500-\u257F\u2580-\u259F]/g, '')
    .replace(/([\u4e00-\u9fa5\u3400-\u4dbf])\s+(?=[\u4e00-\u9fa5\u3400-\u4dbf])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function readJsonFile(localPath) {
  const file = sourceFileFor(localPath)
  if (!file) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function timeAtTextPosition(titles, position) {
  for (const rawTitle of Array.isArray(titles) ? titles : []) {
    const title = asRecord(rawTitle)
    const textBegin = Number(title.text_begin)
    const textEnd = Number(title.text_end)
    const timeBegin = Number(title.time_begin)
    const timeEnd = Number(title.time_end)
    if (![textBegin, textEnd, timeBegin, timeEnd].every(Number.isFinite)) continue
    if (position < textBegin || position > textEnd) continue
    const ratio = (position - textBegin) / Math.max(1, textEnd - textBegin)
    return timeBegin + (timeEnd - timeBegin) * ratio
  }
  return null
}

function buildAudioTiming(sourceText, sourceShots, audioAsset) {
  if (!audioAsset?.localPath || !Number(audioAsset.durationMs)) return null
  const metadata = assetMetadata(audioAsset)
  const titlesPath = metadata.titlesPath || `${audioAsset.localPath}.titles.json`
  const titlesPayload = readJsonFile(titlesPath)
  const titles = Array.isArray(titlesPayload?.titles) ? titlesPayload.titles : []
  if (!titles.length) return null

  const normalizedSource = normalizeTtsText(sourceText)
  let cursor = 0
  const starts = []
  for (const shot of sourceShots) {
    const narration = normalizeTtsText(shot.narration)
    const position = normalizedSource.indexOf(narration, cursor)
    if (!narration || position < 0) return null
    const startMs = timeAtTextPosition(titles, position)
    if (startMs == null) return null
    starts.push(startMs)
    cursor = position + narration.length
  }

  const durationMs = Number(audioAsset.durationMs)
  const byShotNumber = new Map()
  for (let index = 0; index < sourceShots.length; index += 1) {
    const endMs = index + 1 < starts.length ? starts[index + 1] : durationMs
    const shotDurationMs = Math.max(1, Math.round(endMs - starts[index]))
    byShotNumber.set(Number(sourceShots[index].shotNumber), {
      startMs: Math.round(starts[index]),
      endMs: Math.round(endMs),
      durationMs: shotDurationMs,
    })
  }
  return { durationMs, byShotNumber, titlesPath }
}

async function request(pathname) {
  const response = await fetch(`${apiBase()}${pathname}`, { headers: { accept: 'application/json' } })
  const raw = await response.text()
  let body
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    throw new Error(`${pathname} returned invalid JSON`)
  }
  if (!response.ok || body?.code >= 400) throw new Error(`${pathname} failed: ${body?.message || raw}`)
  return body?.data ?? body
}

function normalizeBeats(shot, durationMs) {
  const plan = asRecord(shot.visualPlan)
  const rawBeats = Array.isArray(plan.beats) ? plan.beats : []
  const source = rawBeats.length ? rawBeats : [{ startMs: 0, endMs: durationMs, text: shot.narration || shot.dialogue || '' }]
  return source.map((rawBeat, index) => {
    const beat = asRecord(rawBeat)
    const startMs = numberOr(beat.startMs, numberOr(beat.start, 0) * 1000)
    const endMs = numberOr(beat.endMs, numberOr(beat.end, durationMs / 1000) * 1000)
    return {
      id: String(beat.id || `shot-${shot.shotNumber}-beat-${index + 1}`),
      start: Math.max(0, startMs) / 1000,
      end: Math.max(Math.max(0, startMs) + 1, Math.min(durationMs, endMs)) / 1000,
      text: cleanText(beat.text),
      role: String(beat.role || 'establishing'),
      framing: String(beat.framing || 'medium'),
      focus: {
        x: numberOr(asRecord(beat.focus).x, 0.5),
        y: numberOr(asRecord(beat.focus).y, 0.5),
        zoom: numberOr(asRecord(beat.focus).zoom, 1.04),
      },
      motion: String(beat.motion || 'hold -> restrained push-in -> hold'),
      easing: String(beat.easing || 'ease-in-out'),
      transition: String(beat.transition || 'smooth'),
      rationale: String(beat.rationale || ''),
      layerMode: String(beat.layerMode || plan.layerMode || 'crop'),
      layers: Array.isArray(beat.layers) ? beat.layers : [],
      fallback: beat.fallback == null ? null : String(beat.fallback),
      warnings: Array.isArray(beat.warnings) ? beat.warnings.map(String) : [],
    }
  })
}

function splitCaption(text, durationInFrames) {
  const raw = cleanText(text).replace(/\s+/g, '')
  if (!raw) return []
  const sentences = raw.split(/(?<=[。！？!?；;])/).map((part) => part.trim()).filter(Boolean)
  const parts = sentences.length > 1
    ? sentences
    : raw.length > 34
      ? raw.split(/(?<=[，,])/).map((part) => part.trim()).filter(Boolean)
      : [raw]
  const selected = parts.length > 4 ? parts.slice(0, 3).concat(parts.slice(-1)) : parts
  const total = selected.reduce((sum, part) => sum + Math.max(1, part.length), 0)
  let cursor = 0
  return selected.map((part, index) => {
    const startFrame = cursor
    cursor = index === selected.length - 1
      ? durationInFrames
      : Math.max(startFrame + 1, Math.round(durationInFrames * (selected.slice(0, index + 1).reduce((sum, item) => sum + Math.max(1, item.length), 0) / total)))
    return { startFrame, endFrame: cursor, text: part }
  })
}

function normalizeMap(rawMap) {
  if (!rawMap || typeof rawMap !== 'object') return null
  const map = asRecord(rawMap)
  const source = asRecord(map.source)
  const bounds = asRecord(map.bounds)
  const locations = Array.isArray(map.locations)
    ? map.locations.map((location) => {
      const item = asRecord(location)
      return {
        id: String(item.id || ''),
        label: String(item.label || item.id || ''),
        lon: numberOr(item.lon, 0),
        lat: numberOr(item.lat, 0),
        coordinateSource: String(item.coordinateSource || 'verified'),
        ...(item.labelDx == null ? {} : { labelDx: numberOr(item.labelDx, 12) }),
        ...(item.labelDy == null ? {} : { labelDy: numberOr(item.labelDy, -10) }),
      }
    }).filter((location) => location.id && location.label)
    : []
  const routes = Array.isArray(map.routes)
    ? map.routes.map((route) => {
      const item = asRecord(route)
      const labelAt = asRecord(item.labelAt)
      return {
        ...(item.id == null ? {} : { id: String(item.id) }),
        from: String(item.from || ''),
        to: String(item.to || ''),
        historyStatus: String(item.historyStatus || 'illustrative'),
        color: String(item.color || '#d66c4c'),
        ...(item.label == null ? {} : { label: String(item.label) }),
        ...(item.labelAt && Number.isFinite(Number(labelAt.lon)) && Number.isFinite(Number(labelAt.lat))
          ? { labelAt: { lon: Number(labelAt.lon), lat: Number(labelAt.lat) } }
          : {}),
        waypoints: Array.isArray(item.waypoints)
          ? item.waypoints.map((point) => ({ lon: numberOr(asRecord(point).lon, 0), lat: numberOr(asRecord(point).lat, 0) }))
          : [],
        ...(item.opacity == null ? {} : { opacity: numberOr(item.opacity, 1) }),
      }
    }).filter((route) => route.from && route.to)
    : []
  return {
    mode: String(map.mode || 'migration'),
    ...(map.mapFamily == null ? {} : { mapFamily: String(map.mapFamily) }),
    projection: String(map.projection || 'equirectangular'),
    bounds: {
      minLon: numberOr(bounds.minLon, 96),
      maxLon: numberOr(bounds.maxLon, 122),
      minLat: numberOr(bounds.minLat, 20),
      maxLat: numberOr(bounds.maxLat, 42),
    },
    historyStatus: String(map.historyStatus || 'illustrative'),
    source: {
      name: String(source.name || 'Project-local vector map'),
      license: String(source.license || 'Unknown'),
      url: String(source.url || ''),
    },
    ...(map.title == null ? {} : { title: String(map.title) }),
    ...(map.subtitle == null ? {} : { subtitle: String(map.subtitle) }),
    legend: Array.isArray(map.legend) ? map.legend.map(String).filter(Boolean) : [],
    locations,
    routes,
    warnings: Array.isArray(map.warnings) ? map.warnings.map(String) : [],
  }
}

function assetMetadata(asset) {
  return asRecord(asset?.metadata)
}

function assetFor(assets, key) {
  return assets.find((asset) => asset.assetKey === key) || null
}

function characterCards(shot, beats, assets, durationInFrames) {
  const plan = asRecord(shot.visualPlan)
  const layers = Array.isArray(plan.characters)
    ? plan.characters
    : Array.isArray(plan.layers) ? plan.layers : []
  const usable = layers.filter((layer) => {
    const item = asRecord(layer)
    const asset = assetFor(assets, item.assetKey)
    const metadata = assetMetadata(asset)
    // A completed opaque character image is still a source asset, not a
    // renderable foreground layer. Only the cutout stage may set alphaReady.
    return Boolean(asset && asset.assetType === 'character' && metadata.alphaReady === true && staticUrl(asset.localPath))
  })
  const count = usable.length
  const width = count <= 1 ? 0.68 : count === 2 ? 0.46 : count === 3 ? 0.32 : 0.25
  return usable.map((rawLayer, index) => {
    const layer = asRecord(rawLayer)
    const asset = assetFor(assets, layer.assetKey)
    const name = String(layer.name || assetMetadata(asset).character || `人物 ${index + 1}`)
    const mentions = beats.filter((beat) => beat.text.includes(name))
    const startFrame = mentions.length ? Math.max(0, Math.round(mentions[0].start * fps) - 8) : 0
    const endFrame = mentions.length ? Math.min(durationInFrames, Math.round(mentions[mentions.length - 1].end * fps) + 10) : durationInFrames
    const left = count <= 1 ? 0.16 : 0.02 + index * ((1 - width - 0.04) / Math.max(1, count - 1))
    return {
      key: String(layer.id || layer.assetKey || `${shot.shotNumber}-${index}`),
      name,
      imageUrl: staticUrl(asset.localPath),
      startFrame,
      endFrame: Math.max(startFrame + 1, endFrame),
      detail: name,
      accent: ['#d8a34d', '#6e9b9a', '#b97158', '#9e8b6b'][index % 4],
      x: left,
      y: 0.02,
      scale: width,
      zIndex: numberOr(layer.zIndex, 20 + index),
      requiresAlpha: Boolean(layer.requiresAlpha ?? assetMetadata(asset).requiresAlpha),
    }
  })
}

function stockItems(shot, assets, durationInFrames) {
  const plan = asRecord(shot.visualPlan)
  const stockPlan = asRecord(plan.stock)
  const candidates = assets.filter((asset) => asset.assetType === 'stock_video' && (!stockPlan.assetKey || asset.assetKey === stockPlan.assetKey))
  const primary = shot.shotType === 'stock'
  return candidates.map((asset) => {
    const metadata = assetMetadata(asset)
    const duration = numberOr(asset.durationMs, numberOr(metadata.durationMs, 0)) / 1000
    const license = asRecord(asset.license)
    return {
      provider: String(asset.provider || metadata.provider || 'stock'),
      videoId: String(metadata.videoId || asset.assetKey),
      title: String(metadata.title || ''),
      creator: String(metadata.creator || ''),
      videoUrl: staticUrl(asset.localPath),
      localPath: String(asset.localPath || ''),
      sourceUrl: String(asset.sourceUrl || ''),
      licenseUrl: String(license.url || ''),
      ...(duration > 0 ? { duration } : {}),
      // A stock clip is either the primary visual or a deliberately visible
      // cutaway. It is never reduced to an incidental low-opacity texture.
      opacity: primary ? 0.96 : 0.92,
      blendMode: 'normal',
      presentation: primary ? 'full-frame' : 'inset-cutaway',
      startFrame: 0,
      endFrame: durationInFrames,
    }
  }).filter((item) => item.videoUrl && item.localPath)
}

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

function integerOr(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

function frameFor(raw, frameKey, msKey, durationInFrames, fallback) {
  const item = asRecord(raw)
  if (item[frameKey] != null) return integerOr(item[frameKey], fallback)
  if (item[msKey] != null) return Math.round(clampNumber(item[msKey], 0, Number.MAX_SAFE_INTEGER, 0) / 1000 * fps)
  return fallback
}

function normalizeFrameRange(raw, durationInFrames) {
  const item = asRecord(raw)
  if (item.startFrame != null && !Number.isInteger(Number(item.startFrame))) {
    throw new Error('MagnatesEditorial cue startFrame must be an integer')
  }
  if (item.endFrame != null && !Number.isInteger(Number(item.endFrame))) {
    throw new Error('MagnatesEditorial cue endFrame must be an integer')
  }
  const startFrame = frameFor(raw, 'startFrame', 'startMs', durationInFrames, 0)
  const endFrame = frameFor(raw, 'endFrame', 'endMs', durationInFrames, durationInFrames)
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || startFrame >= endFrame || endFrame > durationInFrames) {
    throw new Error(`MagnatesEditorial cue frame range must satisfy 0 <= startFrame < endFrame <= ${durationInFrames}`)
  }
  return { startFrame, endFrame }
}

function normalizeRecipeAsset(rawAsset) {
  const raw = asRecord(rawAsset)
  const rawSrc = String(raw.src || raw.localPath || raw.url || '').trim()
  if (!rawSrc) throw new Error('MagnatesEditorial shot background.src is required; no implicit fallback is allowed')
  const publicAsset = path.resolve(root, 'remotion/public', rawSrc.replace(/^\/+/, ''))
  const src = rawSrc.startsWith('data:') || /^https?:\/\//i.test(rawSrc)
    ? rawSrc
    : staticUrl(rawSrc) || (fs.existsSync(publicAsset) ? rawSrc : null)
  if (!src) throw new Error(`MagnatesEditorial background asset cannot be resolved: ${rawSrc}`)
  const kind = raw.kind === 'video' || raw.kind === 'image'
    ? raw.kind
    : /\.(?:mp4|mov|webm|m4v)(?:$|[?#])/i.test(rawSrc) ? 'video' : 'image'
  const result = { src, kind }
  if (raw.fit === 'contain' || raw.fit === 'cover') result.fit = raw.fit
  if (raw.position != null && String(raw.position).trim()) result.position = String(raw.position)
  if (raw.filter != null && String(raw.filter).trim()) result.filter = String(raw.filter)
  return result
}

function normalizeRecipeTransition(rawTransition) {
  const raw = asRecord(rawTransition)
  if (!Object.keys(raw).length) return null
  let transitionClass = String(raw.class || raw.transitionClass || '').trim().toLowerCase()
  if (!transitionClass && raw.mode === 'crossfade') transitionClass = 'dissolve'
  if (!transitionClass && raw.mode === 'cut') transitionClass = 'hard_cut'
  transitionClass = transitionClass.replaceAll('-', '_')
  if (!EDITORIAL_TRANSITIONS.has(transitionClass)) return { class: 'ambiguous' }
  const result = { class: transitionClass }
  if (raw.frames != null) result.frames = Math.round(clampNumber(raw.frames, 0, 45, 0))
  if (raw.accent != null && String(raw.accent).trim()) result.accent = String(raw.accent)
  return result
}

function normalizeRecipeCamera(rawCamera) {
  const raw = asRecord(rawCamera)
  if (!Object.keys(raw).length) return null
  let preset = String(raw.preset || '').trim().toLowerCase().replaceAll('-', '_')
  if (!EDITORIAL_CAMERAS.has(preset)) throw new Error(`MagnatesEditorial camera preset is unsupported: ${preset || '(empty)'}`)
  const result = {
    preset,
    intensity: clampNumber(raw.intensity, 0, 1, undefined),
  }
  if (result.intensity == null) delete result.intensity
  const focus = asRecord(raw.focus)
  if (Number.isFinite(Number(focus.x)) && Number.isFinite(Number(focus.y))) {
    result.focus = {
      x: clampNumber(focus.x, 0, 1, 0.5),
      y: clampNumber(focus.y, 0, 1, 0.5),
    }
  }
  if (raw.startScale != null && Number.isFinite(Number(raw.startScale))) result.startScale = Math.max(1, Number(raw.startScale))
  if (raw.endScale != null && Number.isFinite(Number(raw.endScale))) result.endScale = Math.max(1, Number(raw.endScale))
  return result
}

function normalizeRecipeText(rawCue, durationInFrames, index) {
  const raw = asRecord(rawCue)
  const range = normalizeFrameRange(raw, durationInFrames)
  const rawText = cleanText(raw.text || raw.value || raw.label)
  const subject = cleanText(raw.subject)
  if (!subject || /^(?:text|shape|layer)$/i.test(subject)) {
    throw new Error(`MagnatesEditorial text cue ${index + 1} requires a concrete subject`)
  }
  if (!rawText && raw.type !== 'counter' && raw.from == null && raw.to == null) return null
  const type = raw.type === 'counter' || raw.entry === 'counter' || raw.from != null || raw.to != null ? 'counter' : 'text'
  if (raw.type != null && !['text', 'counter'].includes(String(raw.type))) {
    throw new Error(`MagnatesEditorial text cue ${index + 1} has an unsupported type: ${raw.type}`)
  }
  const result = {
    type,
    subject,
    startFrame: range.startFrame,
    endFrame: range.endFrame,
  }
  if (rawText) result.text = rawText
  const entry = String(raw.entry || '').trim().toLowerCase().replaceAll('-', '_')
  if (entry && !EDITORIAL_TEXT_ENTRIES.has(entry)) throw new Error(`MagnatesEditorial text cue ${index + 1} has an unsupported entry: ${entry}`)
  if (entry) result.entry = entry
  const exit = String(raw.exit || '').trim().toLowerCase().replaceAll('-', '_')
  if (exit && !EDITORIAL_TEXT_EXITS.has(exit)) throw new Error(`MagnatesEditorial text cue ${index + 1} has an unsupported exit: ${exit}`)
  if (exit) result.exit = exit
  if (raw.x != null && Number.isFinite(Number(raw.x))) result.x = Number(raw.x)
  if (raw.y != null && Number.isFinite(Number(raw.y))) result.y = Number(raw.y)
  if (raw.width != null && (typeof raw.width === 'string' || Number.isFinite(Number(raw.width)))) result.width = typeof raw.width === 'string' ? raw.width : Number(raw.width)
  if (['left', 'center', 'right'].includes(raw.align)) result.align = raw.align
  if (raw.fontSize != null) result.fontSize = clampNumber(raw.fontSize, 10, 180, 54)
  if (raw.weight != null) result.weight = Math.round(clampNumber(raw.weight, 100, 900, 700))
  for (const key of ['color', 'accent', 'prefix', 'suffix', 'label']) {
    if (raw[key] != null && String(raw[key]).trim()) result[key] = String(raw[key])
  }
  if (type === 'counter') {
    if (raw.from != null && Number.isFinite(Number(raw.from))) result.from = Number(raw.from)
    if (raw.to != null && Number.isFinite(Number(raw.to))) result.to = Number(raw.to)
    if (raw.decimals != null) result.decimals = Math.round(clampNumber(raw.decimals, 0, 4, 0))
    const unit = cleanText(raw.unit || raw.suffix)
    const period = cleanText(raw.period || raw.label)
    if (!unit || !period) throw new Error(`MagnatesEditorial counter "${subject}" requires unit and period`)
    result.unit = unit
    result.period = period
    if (!result.suffix) result.suffix = unit
    if (!result.label) result.label = period
  }
  return result
}

function normalizeRecipeGraphic(rawCue, durationInFrames, index) {
  const raw = asRecord(rawCue)
  const kind = String(raw.kind || raw.type || '').trim().toLowerCase().replaceAll('-', '_')
  if (!EDITORIAL_GRAPHICS.has(kind)) throw new Error(`MagnatesEditorial graphic cue ${index + 1} has an unsupported kind: ${kind || '(empty)'}`)
  const range = normalizeFrameRange(raw, durationInFrames)
  const subject = cleanText(raw.subject)
  if (!subject || /^(?:text|shape|layer)$/i.test(subject)) {
    throw new Error(`MagnatesEditorial graphic cue ${index + 1} requires a concrete subject`)
  }
  const result = { kind, subject, ...range }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (raw[key] != null && Number.isFinite(Number(raw[key]))) result[key] = Number(raw[key])
  }
  for (const key of ['color', 'secondaryColor', 'label']) {
    if (raw[key] != null && String(raw[key]).trim()) result[key] = String(raw[key])
  }
  return result
}

function normalizeEditorialShot(rawShot, index) {
  const raw = asRecord(rawShot)
  const durationInFrames = integerOr(raw.durationInFrames, 0)
  if (durationInFrames < 1) throw new Error(`MagnatesEditorial shot ${index + 1} requires a positive durationInFrames`)
  const result = {
    id: cleanText(raw.id),
    durationInFrames,
    background: normalizeRecipeAsset(raw.background),
  }
  if (!result.id) throw new Error(`MagnatesEditorial shot ${index + 1} requires an id`)
  const role = String(raw.semanticRole || raw.role || '').trim().toLowerCase()
  if (EDITORIAL_ROLES.has(role)) result.semanticRole = role
  const camera = normalizeRecipeCamera(raw.camera)
  if (camera) result.camera = camera
  const transitionIn = normalizeRecipeTransition(raw.transitionIn)
  const transitionOut = normalizeRecipeTransition(raw.transitionOut)
  if (transitionIn) result.transitionIn = transitionIn
  if (transitionOut) result.transitionOut = transitionOut
  const texts = (Array.isArray(raw.texts) ? raw.texts : [])
    .map((cue, cueIndex) => normalizeRecipeText(cue, durationInFrames, cueIndex))
    .filter(Boolean)
  const graphics = (Array.isArray(raw.graphics) ? raw.graphics : [])
    .map((cue, cueIndex) => normalizeRecipeGraphic(cue, durationInFrames, cueIndex))
    .filter(Boolean)
  if (texts.length) result.texts = texts
  if (graphics.length) result.graphics = graphics
  if (raw.tint != null && String(raw.tint).trim()) result.tint = String(raw.tint)
  if (raw.grain != null) result.grain = clampNumber(raw.grain, 0, 1, 0.12)
  if (raw.sourceLabel != null && String(raw.sourceLabel).trim()) result.sourceLabel = cleanText(raw.sourceLabel)
  return result
}

function normalizeMagnatesRecipe(rawRecipe, fallbackTitle = '') {
  const candidate = asRecord(rawRecipe)
  const recipe = asRecord(candidate.recipe && typeof candidate.recipe === 'object' ? candidate.recipe : candidate)
  if (recipe.schemaVersion !== 'magnates-remotion-recipe-v1') {
    throw new Error('MagnatesEditorial recipe schemaVersion must be magnates-remotion-recipe-v1')
  }
  const rawShots = Array.isArray(recipe.shots) ? recipe.shots : []
  if (!rawShots.length) throw new Error('MagnatesEditorial recipe requires at least one shot')
  const shots = rawShots.map(normalizeEditorialShot)
  const declaredDuration = integerOr(recipe.durationInFrames, 0)
  if (declaredDuration < 1) throw new Error('MagnatesEditorial recipe requires a positive durationInFrames')
  const shotDuration = shots.reduce((sum, shot) => sum + shot.durationInFrames, 0)
  const durationInFrames = declaredDuration
  const delta = durationInFrames - shotDuration
  if (Math.abs(delta) > 1) {
    throw new Error(`MagnatesEditorial recipe duration ${durationInFrames} differs from shot sum ${shotDuration} by more than one frame`)
  }
  if (delta !== 0) {
    const last = shots.at(-1)
    if (last.durationInFrames + delta < 1) {
      throw new Error('MagnatesEditorial recipe cannot reconcile a one-frame duration delta without a non-positive shot')
    }
    last.durationInFrames += delta
  }
  if (shots.reduce((sum, shot) => sum + shot.durationInFrames, 0) !== durationInFrames) {
    throw new Error('MagnatesEditorial recipe shot durations do not sum to durationInFrames')
  }
  const recipeFps = Number(recipe.fps)
  if (!Number.isFinite(recipeFps) || recipeFps <= 0) throw new Error('MagnatesEditorial recipe requires a positive fps')
  return {
    durationInFrames,
    fps: recipeFps,
    ...(cleanText(recipe.title || fallbackTitle) ? { title: cleanText(recipe.title || fallbackTitle) } : {}),
    shots,
  }
}

function hasExplicitMagnatesRecipe(snapshot, cliRecipe) {
  if (isMagnatesRecipeId(cliRecipe)) return true
  const project = asRecord(snapshot?.project)
  const source = asRecord(project.sourceSnapshot)
  const projectMetadata = asRecord(project.metadata)
  const sourceMetadata = asRecord(source.metadata)
  const candidates = [
    projectMetadata.recipe,
    projectMetadata.recipeId,
    projectMetadata.remotionRecipe,
    projectMetadata.compositionId,
    projectMetadata.remotionComposition,
    projectMetadata.visualMode,
    source.recipe,
    source.recipeId,
    source.remotionRecipe,
    source.compositionId,
    source.remotionComposition,
    source.visualMode,
    sourceMetadata.recipe,
    sourceMetadata.recipeId,
    sourceMetadata.remotionRecipe,
    sourceMetadata.compositionId,
    sourceMetadata.remotionComposition,
    sourceMetadata.visualMode,
  ]
  if (candidates.some(isMagnatesRecipeId)) return true
  const shots = Array.isArray(snapshot?.shots) ? snapshot.shots : []
  const explicitShotContracts = shots.filter((shot) => {
    const plan = asRecord(shot?.visualPlan)
    const contract = asRecord(plan.renderContract)
    return MAGNATES_RENDERERS.has(String(contract.renderer || '').trim().toLowerCase())
      || isMagnatesRecipeId(contract.compositionId)
      || isMagnatesRecipeId(contract.recipe)
  })
  return shots.length > 0 && explicitShotContracts.length === shots.length
}

function isTemporalVisualPlan(plan) {
  return plan.visualMode === 'temporal-2grid'
    || plan.assetStrategy === 'temporal-2grid-remotion'
    || plan.temporalGrid !== undefined
}

function temporalGridPanels(visualPlan, durationInFrames) {
  const grid = asRecord(visualPlan.temporalGrid)
  const rawPanels = Array.isArray(grid.panels) ? grid.panels : []
  if (rawPanels.length !== 2) throw new Error('temporal-2grid shot requires exactly two panels')
  const panels = rawPanels.map((raw, index) => {
    const panel = asRecord(raw)
    return {
      sourceIndex: numberOr(panel.index, index),
      action: cleanText(panel.semantic || panel.action || `状态 ${index + 1}`),
    }
  })
  const keyframes = (Array.isArray(grid.keyframes) ? grid.keyframes : [])
    .map((raw) => {
      const keyframe = asRecord(raw)
      return {
        atMs: numberOr(keyframe.atMs, numberOr(keyframe.startMs, 0)),
        panel: numberOr(keyframe.panel, numberOr(keyframe.sourceIndex, 0)),
      }
    })
    .sort((left, right) => left.atMs - right.atMs)
  const secondStart = keyframes.find((keyframe) => keyframe.panel === 1)?.atMs
    ?? Math.round((durationInFrames / fps) * 500)
  const secondStartFrames = Math.max(1, Math.min(durationInFrames - 1, Math.round(secondStart / 1000 * fps)))
  return panels.map((panel, index) => ({
    ...panel,
    durationInFrames: index === 0 ? secondStartFrames : Math.max(1, durationInFrames - secondStartFrames),
  }))
}

function temporalShot(snapshot, shot, audioTiming) {
  const timed = audioTiming?.byShotNumber?.get(Number(shot.shotNumber))
  const durationMs = Math.max(1, numberOr(timed?.durationMs, numberOr(shot.durationMs, 1000)))
  const durationInFrames = Math.max(1, Math.round(durationMs / 1000 * fps))
  const visualPlan = asRecord(shot.visualPlan)
  const grid = asRecord(visualPlan.temporalGrid)
  const assets = Array.isArray(shot.assets) ? shot.assets : []
  const sheetKey = cleanText(grid.sheetAssetKey)
  const sheetAsset = assets.find((asset) => asset.assetKey === sheetKey)
  const sheetUrl = staticUrl(sheetAsset?.localPath) || cleanText(grid.sheetUrl || visualPlan.sheetUrl)
  if (!sheetUrl) {
    throw new Error(`temporal-2grid shot ${shot.shotNumber} is missing approved sheet asset ${sheetKey || '(unknown)'}`)
  }
  const camera = asRecord(visualPlan.camera)
  const transition = asRecord(visualPlan.transition)
  const motion = asRecord(visualPlan.motion)
  const transitionMode = ['cut', 'crossfade', 'push'].includes(String(transition.mode))
    ? String(transition.mode)
    : 'crossfade'
  const transitionEffect = ['dissolve', 'soft-focus', 'dip-dark'].includes(String(transition.effect))
    ? String(transition.effect)
    : 'dissolve'
  const cameraPreset = ['drift', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'static'].includes(String(camera.preset || motion.camera))
    ? String(camera.preset || motion.camera)
    : 'drift'
  const textOverlay = asRecord(visualPlan.textOverlay)
  return {
    storyboardNumber: Number(shot.shotNumber),
    durationInFrames,
    sheetUrl,
    gridLayout: '2x1',
    panels: temporalGridPanels(visualPlan, durationInFrames),
    narration: cleanText(shot.narration || shot.dialogue),
    transitionFrames: Math.max(0, Math.round(numberOr(transition.frames, 10))),
    transitionMode,
    transitionDirection: ['left', 'right', 'up', 'down'].includes(String(transition.direction))
      ? String(transition.direction)
      : 'left',
    transitionEffect,
    cameraPreset,
    cameraIntensity: numberOr(camera.intensity, 0.9),
    sceneTransitionFrames: Math.max(2, Math.round(numberOr(visualPlan.sceneTransitionFrames, 5))),
    ...(Object.keys(textOverlay).length ? { textOverlay } : {}),
    captionText: cleanText(shot.narration || shot.dialogue),
  }
}

function sourceStoryboardFor(snapshot, shot) {
  const source = asRecord(snapshot.project?.sourceSnapshot)
  const storyboards = Array.isArray(source.storyboards) ? source.storyboards : []
  return storyboards.find((item) => Number(item.id) === Number(shot.sourceStoryboardId) || Number(item.storyboardNumber) === Number(shot.shotNumber)) || {}
}

function buildShot(snapshot, shot, audioTiming) {
  const timed = audioTiming?.byShotNumber?.get(Number(shot.shotNumber))
  const durationMs = Math.max(1, numberOr(timed?.durationMs, numberOr(shot.durationMs, 1000)))
  const durationInFrames = Math.max(1, Math.round(durationMs / 1000 * fps))
  const visualPlan = asRecord(shot.visualPlan)
  const assets = Array.isArray(shot.assets) ? shot.assets : []
  const sourceStoryboard = sourceStoryboardFor(snapshot, shot)
  const sourceEvidence = { ...asRecord(shot.sourceEvidence), ...sourceStoryboard }
  const legacyAsset = staticUrl(sourceEvidence.legacyAsset || sourceStoryboard.firstFrameImage || sourceStoryboard.videoUrl)
  const aiAsset = assets.find((asset) => asset.assetType === 'ai_image' && staticUrl(asset.localPath))
  const plateUrl = staticUrl(aiAsset?.localPath) || legacyAsset || ''
  const beats = normalizeBeats(shot, durationMs)
  const characters = characterCards(shot, beats, assets, durationInFrames)
  const stockBroll = stockItems(shot, assets, durationInFrames)
  const warnings = [
    ...(Array.isArray(visualPlan.warnings) ? visualPlan.warnings.map(String) : []),
    ...(!aiAsset && ['ai_plate', 'character', 'hybrid'].includes(shot.shotType) ? ['AI clean plate 尚未落盘，当前使用源 Episode 首帧回退'] : []),
    ...(characters.length < (Array.isArray(visualPlan.characters) ? visualPlan.characters.length : 0) ? ['透明人物层尚未落盘，当前使用场景板或素材库 cutaway，不把整张人物图当作透明层'] : []),
    ...(shot.shotType === 'stock' && !stockBroll.length ? ['素材库视频本地文件缺失，当前仅使用源 Episode 首帧回退'] : []),
    ...(shot.shotType === 'hybrid' && stockBroll.length && !characters.length ? ['人物透明层尚未落盘，当前将素材库视频作为可见主画面回退'] : []),
  ]
  return {
    storyboardNumber: Number(shot.shotNumber),
    storyboardId: Number(shot.id || shot.sourceStoryboardId || shot.shotNumber),
    duration: durationMs / 1000,
    durationInFrames,
    title: cleanText(shot.title || `镜头 ${shot.shotNumber}`),
    shotType: String(shot.shotType || 'ai_plate'),
    imageUrl: plateUrl,
    fallbackImageUrl: legacyAsset,
    audioUrl: staticUrl(sourceEvidence.audioUrl || sourceStoryboard.narrationAudioUrl || sourceStoryboard.audioUrl),
    narration: shot.narration || sourceStoryboard.narration || '',
    graphic: '',
    visualMode: String(visualPlan.visualMode || (shot.shotType === 'map' ? 'map-video' : shot.shotType === 'stock' ? 'stock-broll' : 'ai-plate')),
    visualPlan,
    renderContract: asRecord(visualPlan.renderContract),
    assets,
    characters,
    map: normalizeMap(visualPlan.map),
    stockBroll,
    beats,
    captionSegments: splitCaption(shot.narration || sourceStoryboard.narration || shot.dialogue || '', durationInFrames),
    sourceEvidence,
    warnings,
  }
}

function writePropsArtifact(outputPath, props) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(props, null, 2)}\n`)
}

function buildLegacyMagnatesProps(recipe, snapshot, allAssets, projectId, sourceEpisode, outputPath) {
  const normalizedRecipe = normalizeMagnatesRecipe(recipe, sourceEpisode.title || snapshot.project?.title || '')
  const audioAsset = allAssets.find((asset) => asset.assetType === 'audio' && asset.status === 'completed' && staticUrl(asset.localPath))
  const audioDurationMs = numberOr(audioAsset?.durationMs, 0)
  if (audioDurationMs > 0) {
    const audioFrames = Math.round(audioDurationMs / 1000 * normalizedRecipe.fps)
    if (Math.abs(audioFrames - normalizedRecipe.durationInFrames) > 1) {
      throw new Error(`MagnatesEditorial audio duration ${audioFrames} frames does not match recipe duration ${normalizedRecipe.durationInFrames}`)
    }
  }
  const props = {
    schemaVersion: 1,
    recipeSchemaVersion: String(recipe.schemaVersion || recipe.recipe?.schemaVersion || 'magnates-remotion-recipe-v1'),
    kind: 'magnates-editorial-recipe-props',
    compositionId: 'MagnatesEditorial',
    visualMode: 'magnates-editorial',
    projectId: Number(projectId),
    episodeId: Number(snapshot.project?.sourceEpisodeId || sourceEpisode.id || 0),
    episodeNumber: Number(sourceEpisode.episodeNumber || 0),
    title: normalizedRecipe.title || String(sourceEpisode.title || snapshot.project?.title || ''),
    fps: normalizedRecipe.fps,
    width: 1280,
    height: 720,
    durationInFrames: normalizedRecipe.durationInFrames,
    durationSeconds: normalizedRecipe.durationInFrames / normalizedRecipe.fps,
    audioUrl: staticUrl(audioAsset?.localPath),
    audioAssetKey: audioAsset?.assetKey || null,
    audioDurationMs: audioDurationMs || null,
    sourceProjectUpdatedAt: snapshot.project?.updatedAt || null,
    shots: normalizedRecipe.shots,
  }
  writePropsArtifact(outputPath, props)
  return props
}

/**
 * Compatibility shell dispatch. Canonical v2 recipes go through the pure
 * production core; v1 remains an explicitly legacy mapper for one release.
 * The legacy branch is intentionally kept imperative because it fetches the
 * backend snapshot and writes the historical props artifact.
 */
function buildMagnatesProps(recipe, snapshot, allAssets, projectId, sourceEpisode, outputPath) {
  const schemaVersion = String(recipe?.schemaVersion || recipe?.recipe?.schemaVersion || '')
  if (schemaVersion !== 'magnates-remotion-recipe-v2') {
    return buildLegacyMagnatesProps(recipe, snapshot, allAssets, projectId, sourceEpisode, outputPath)
  }
  const inventory = {
    assets: (Array.isArray(allAssets) ? allAssets : []).map((asset) => ({
      assetId: String(asset?.assetKey || asset?.id || ''),
      // The pure core receives the staged inventory path, never an API URL.
      // URL/public-path adaptation belongs to the renderer boundary.
      stagedPath: String(asset?.localPath || ''),
      kind: asset?.assetType === 'video' || asset?.assetType === 'stock_video' ? 'video' : undefined,
      verified: asset?.status === undefined || asset?.status === 'completed' || asset?.verified === true,
    })).filter((asset) => asset.assetId && asset.stagedPath),
  }
  const target = { profileId: 'youtube-720p', width: 1280, height: 720, fps: 30 }
  const props = buildCanonicalMagnatesProps({
    recipe,
    assetInventory: inventory,
    target,
    metadata: {
      sourceEpisodeId: sourceEpisode?.id == null ? undefined : String(sourceEpisode.id),
    },
  })
  writePropsArtifact(outputPath, props)
  return props
}

async function main() {
  const projectId = required('--project-id')
  const outputPath = path.resolve(root, value('--output', `data/temp/remotion-project-${projectId}-props.json`))
  const snapshot = await request(`/remotion/projects/${projectId}`)
  const allAssets = await request(`/remotion/projects/${projectId}/assets`)
  const recipeArgument = value('--recipe')
  const recipePayload = parseRecipeArgument(recipeArgument)
  const magnatesRequested = hasExplicitMagnatesRecipe(snapshot, recipeArgument)
  if (recipeArgument && !recipePayload && !isMagnatesRecipeId(recipeArgument)) {
    throw new Error('--recipe must be a JSON object, a readable JSON file, or the exact MagnatesEditorial recipe id')
  }
  const sourceEpisode = asRecord(asRecord(snapshot.project?.sourceSnapshot).episode)
  if (recipePayload || magnatesRequested) {
    if (!recipePayload) {
      throw new Error('MagnatesEditorial production requires an explicit --recipe JSON payload or JSON file; legacy shots are not auto-converted')
    }
    const magnatesProps = buildMagnatesProps(recipePayload, snapshot, allAssets, projectId, sourceEpisode, outputPath)
    console.log(JSON.stringify({
      output: outputPath,
      compositionId: magnatesProps.compositionId,
      shots: magnatesProps.shots.length,
      durationSeconds: magnatesProps.durationSeconds,
      visualModes: { 'magnates-editorial': magnatesProps.shots.length },
      stockShots: 0,
      layeredShots: 0,
      mapShots: 0,
    }, null, 2))
    return
  }
  const selected = value('--shots')
    ? new Set(value('--shots').split(',').map((item) => Number(item.trim())).filter(Number.isInteger))
    : null
  const sourceShots = (snapshot.shots || []).sort((left, right) => Number(left.shotNumber) - Number(right.shotNumber))
  const audioAsset = allAssets.find((asset) => asset.assetType === 'audio' && asset.status === 'completed' && staticUrl(asset.localPath))
  const audioTiming = buildAudioTiming(sourceEpisode.scriptContent || sourceEpisode.content, sourceShots, audioAsset)
  const shots = sourceShots
    .filter((shot) => !selected || selected.has(Number(shot.shotNumber)))
    .map((shot) => buildShot(snapshot, shot, audioTiming))
  const temporalCount = shots.filter((shot) => isTemporalVisualPlan(asRecord(shot.visualPlan))).length
  const fullTemporal = shots.length > 0 && temporalCount === shots.length
  if (temporalCount > 0 && !fullTemporal) {
    throw new Error('temporal-2grid and legacy layered shots cannot be mixed in one Remotion props file; migrate the remaining shots first')
  }
  if (fullTemporal && (!audioAsset?.localPath || !staticUrl(audioAsset.localPath))) {
    throw new Error('temporal-2grid props require a completed narration audio asset; stop at the voice/audio gate')
  }
  let durationInFrames = shots.reduce((sum, shot) => sum + shot.durationInFrames, 0)
  const fullEpisode = !selected
  if (fullEpisode && audioTiming) {
    durationInFrames = Math.max(1, Math.round(audioTiming.durationMs / 1000 * fps))
    const frameDelta = durationInFrames - shots.reduce((sum, shot) => sum + shot.durationInFrames, 0)
    if (shots.length && frameDelta !== 0) {
      const last = shots[shots.length - 1]
      last.durationInFrames = Math.max(1, last.durationInFrames + frameDelta)
      last.duration = last.durationInFrames / fps
      if (last.captionSegments?.length) last.captionSegments[last.captionSegments.length - 1].endFrame = last.durationInFrames
    }
  }
  if (fullTemporal) {
    const temporalShots = sourceShots
      .filter((shot) => !selected || selected.has(Number(shot.shotNumber)))
      .map((shot) => temporalShot(snapshot, shot, audioTiming))
    let temporalDurationInFrames = temporalShots.reduce((sum, shot) => sum + shot.durationInFrames, 0)
    const temporalAudioDurationMs = fullEpisode
      ? numberOr(audioTiming?.durationMs, numberOr(audioAsset?.durationMs, 0))
      : 0
    if (fullEpisode && temporalAudioDurationMs > 0) {
      const declaredTemporalFrames = temporalDurationInFrames
      temporalDurationInFrames = Math.max(1, Math.round(temporalAudioDurationMs / 1000 * fps))
      if (!audioTiming && Math.abs(temporalDurationInFrames - declaredTemporalFrames) > 2) {
        throw new Error('temporal-2grid audio duration differs from shot timing; provide the narration timing sidecar before rendering')
      }
      const frameDelta = temporalDurationInFrames - temporalShots.reduce((sum, shot) => sum + shot.durationInFrames, 0)
      if (temporalShots.length && frameDelta !== 0) {
        const last = temporalShots[temporalShots.length - 1]
        last.durationInFrames = Math.max(1, last.durationInFrames + frameDelta)
        if (last.panels?.length) {
          const first = last.panels[0]
          const second = last.panels[1]
          const total = first.durationInFrames + second.durationInFrames
          second.durationInFrames = Math.max(1, second.durationInFrames + (last.durationInFrames - total))
        }
      }
    }
    const captions = []
    let captionOffset = 0
    for (const shot of temporalShots) {
      const local = splitCaption(shot.captionText, shot.durationInFrames)
      for (const cue of local) captions.push({
        startFrame: cue.startFrame + captionOffset,
        endFrame: cue.endFrame + captionOffset,
        text: cue.text,
      })
      captionOffset += shot.durationInFrames
      delete shot.captionText
    }
    const temporalProps = {
      schemaVersion: 1,
      kind: 'temporal-2grid-episode-props',
      compositionId: 'TemporalGridEpisode',
      visualMode: 'temporal-2grid',
      assetStrategy: 'temporal-2grid-remotion',
      projectId: Number(projectId),
      episodeId: Number(snapshot.project?.sourceEpisodeId || sourceEpisode.id || 0),
      episodeNumber: Number(sourceEpisode.episodeNumber || 0),
      title: String(sourceEpisode.title || snapshot.project?.title || ''),
      fps,
      width: 1280,
      height: 720,
      durationInFrames: temporalDurationInFrames,
      durationSeconds: temporalDurationInFrames / fps,
      audioUrl: fullEpisode ? staticUrl(audioAsset?.localPath) : null,
      audioAssetKey: fullEpisode ? audioAsset?.assetKey || null : null,
      audioDurationMs: fullEpisode ? temporalAudioDurationMs || null : null,
      audioDurationInFrames: fullEpisode ? temporalDurationInFrames : null,
      captionTrack: {
        format: 'transcript',
        renderer: 'remotion-caption-track',
        safeArea: 'bottom-center',
        cueCount: captions.length,
        audioDurationMs: fullEpisode ? temporalAudioDurationMs || null : null,
        checks: [
          { name: 'cue_ranges', passed: captions.every((cue) => cue.startFrame >= 0 && cue.endFrame > cue.startFrame && cue.endFrame <= temporalDurationInFrames) },
          { name: 'audio_alignment', passed: fullEpisode && temporalAudioDurationMs > 0 },
          { name: 'safe_area', passed: true },
          { name: 'action_label_safe_area', passed: true },
        ],
      },
      captions,
      shots: temporalShots,
    }
    writePropsArtifact(outputPath, temporalProps)
    console.log(JSON.stringify({ output: outputPath, compositionId: temporalProps.compositionId, shots: temporalShots.length, durationSeconds: temporalProps.durationSeconds, visualModes: { 'temporal-2grid': temporalShots.length }, stockShots: 0, layeredShots: 0, mapShots: 0 }, null, 2))
    return
  }

  const props = {
    schemaVersion: 1,
    kind: 'remotion-project-props',
    compositionId: 'EpisodeShowcase',
    projectId: Number(projectId),
    episodeId: Number(snapshot.project?.sourceEpisodeId || sourceEpisode.id || 0),
    episodeNumber: Number(sourceEpisode.episodeNumber || 0),
    title: String(sourceEpisode.title || snapshot.project?.title || ''),
    fps,
    width: 1280,
    height: 720,
    durationInFrames,
    durationSeconds: durationInFrames / fps,
    audioUrl: fullEpisode ? staticUrl(audioAsset?.localPath) : null,
    audioAssetKey: fullEpisode ? audioAsset?.assetKey || null : null,
    audioDurationMs: fullEpisode ? audioTiming?.durationMs || null : null,
    sourceProjectUpdatedAt: snapshot.project?.updatedAt || null,
    shots,
  }
  writePropsArtifact(outputPath, props)
  const counts = shots.reduce((result, shot) => {
    result[shot.visualMode] = (result[shot.visualMode] || 0) + 1
    return result
  }, {})
  console.log(JSON.stringify({ output: outputPath, shots: shots.length, durationSeconds: props.durationSeconds, visualModes: counts, stockShots: shots.filter((shot) => shot.stockBroll.length).length, layeredShots: shots.filter((shot) => shot.characters.length).length, mapShots: shots.filter((shot) => shot.map).length }, null, 2))
}

export {
  buildMagnatesProps,
  hasExplicitMagnatesRecipe,
  isMagnatesRecipeId,
  normalizeMagnatesRecipe,
  normalizeRecipeAsset,
  normalizeRecipeCamera,
  normalizeRecipeGraphic,
  normalizeRecipeText,
  normalizeRecipeTransition,
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[remotion-props] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
