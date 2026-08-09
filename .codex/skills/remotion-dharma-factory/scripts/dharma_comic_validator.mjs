import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { NATIVE_AUDIO_MIX_VERSION } from '../../../../scripts/videoeditor/dharma_comic_native_core.mjs'
import { DHARMA_VIDEO_ENCODER } from '../../../../scripts/videoeditor/dharma_ffmpeg_config.mjs'

const semanticFields = [
  'subject_count',
  'subjects',
  'relationship',
  'action',
  'visible_emotion',
  'visual_evidence',
]
const emphasisKinds = ['theme', 'scripture', 'explanation']

function report(errorCode, errors, checks = {}, data = null) {
  return {
    passed: errors.length === 0,
    error_code: errors.length === 0 ? null : errorCode,
    checks: { ...checks, errors },
    data,
  }
}

function positiveNumber(value, label, errors) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) errors.push(`${label} must be a positive number`)
  return number
}

function validateQuote(panel, errors, textEmphasisVersion, emphasisCounts) {
  const text = String(panel.quote?.text || '').trim()
  if (!text || [...text].length > 36) errors.push(`Panel ${panel.key} quote text must be 1-36 characters`)
  const source = String(panel.quote?.source || '').trim()
  if (source && [...source].length > 24) errors.push(`Panel ${panel.key} quote source must be at most 24 characters`)
  if (!String(panel.narrationText || '').includes(text)) {
    errors.push(`Panel ${panel.key} quote must occur verbatim in narrationText`)
  }
  const kind = String(panel.quote?.kind || '').trim()
  if (textEmphasisVersion === 1 || kind) {
    if (!emphasisKinds.includes(kind)) {
      errors.push(`Panel ${panel.key} quote.kind must be theme, scripture, or explanation`)
    } else {
      emphasisCounts[kind] += 1
      if (kind === 'theme' && ([...text].length < 2 || [...text].length > 16)) {
        errors.push(`Panel ${panel.key} theme quote text must be 2-16 characters`)
      }
      if (kind === 'scripture' && !source) {
        errors.push(`Panel ${panel.key} scripture quote requires a source`)
      }
    }
  }
}

function validateBubble(key, bubble, errors) {
  if (!['speech', 'caption'].includes(bubble.kind)) errors.push(`Panel ${key} bubble.kind is invalid`)
  if (!bubble.text?.trim() || [...bubble.text].length > 24) {
    errors.push(`Panel ${key} bubble text must be 1-24 characters`)
  }
  for (const coordinate of ['x', 'y']) {
    const value = Number(bubble[coordinate])
    if (!Number.isFinite(value) || value < 0 || value > 85) {
      errors.push(`Panel ${key} bubble.${coordinate} is invalid`)
    }
  }
  if (bubble.tail && !['left', 'right'].includes(bubble.tail)) {
    errors.push(`Panel ${key} bubble.tail is invalid`)
  }
}

export function validateVisualApproval({
  approval,
  artifactPath,
  expectedArtifactSha256,
  expectedReviewedCount,
}) {
  const errors = []
  const actor = String(approval?.actor || '').trim()
  const reviewTool = String(approval?.reviewTool || '').trim()
  const reason = String(approval?.reason || '').trim()
  const reviewedCount = Number(approval?.reviewedCount)
  const expectedCount = Number(expectedReviewedCount)
  const artifactExists = Boolean(artifactPath && existsSync(artifactPath))
  const actualArtifactSha256 = artifactExists
    ? createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
    : null

  if (!artifactExists) errors.push('Visual review artifact is missing')
  if (!expectedArtifactSha256 || actualArtifactSha256 !== expectedArtifactSha256) {
    errors.push('Visual review artifact SHA-256 does not match the expected bytes')
  }
  if (!approval?.artifactSha256 || approval.artifactSha256 !== actualArtifactSha256) {
    errors.push('Visual approval is not bound to the current artifact bytes')
  }
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    errors.push('Expected visual review count must be a positive integer')
  }
  if (!Number.isInteger(reviewedCount) || reviewedCount !== expectedCount) {
    errors.push('Visual approval does not cover every review item')
  }
  if ([...reason].length < 12) {
    errors.push('Visual approval reason must contain concrete visible evidence')
  }
  if (actor === 'agent') {
    if (!['view_image', 'native_image_read'].includes(reviewTool)) {
      errors.push('Agent visual approval must come from an image-capable review tool')
    }
  } else if (actor === 'user') {
    if (reviewTool !== 'human') errors.push('User visual approval must be recorded as human review')
  } else {
    errors.push('Visual approval actor must be agent or user')
  }

  return report('VISUAL_APPROVAL_INVALID', errors, {
    actor: actor || null,
    review_tool: reviewTool || null,
    reviewed_count: Number.isInteger(reviewedCount) ? reviewedCount : null,
    expected_reviewed_count: Number.isInteger(expectedCount) ? expectedCount : null,
    artifact_sha256: actualArtifactSha256,
  })
}

export function validateEnvironment(facts) {
  const errors = []
  if (facts.api_health_ok !== true) errors.push('Backend health check failed')
  if (!Number.isInteger(facts.worker_count) || facts.worker_count < 1) {
    errors.push('No healthy task worker is available')
  }
  if (facts.ffmpeg_ok !== true) errors.push('ffmpeg is unavailable')
  if (facts.h264_videotoolbox_ok !== true) errors.push('ffmpeg does not expose h264_videotoolbox')
  if (facts.ffprobe_ok !== true) errors.push('ffprobe is unavailable')
  if (facts.native_renderer_ok !== true) errors.push('native-comic-v12 renderer is unavailable')
  if (!Number.isInteger(facts.media_account?.id) || facts.media_account.id < 1) {
    errors.push('Dharma media account is missing')
  }

  const image = facts.image_config || {}
  if (!Number.isInteger(image.id) || image.id < 1) errors.push('Active image config is missing')
  if (String(image.provider || '').toLowerCase() !== 'pcore') {
    errors.push('Active image config provider must be pcore')
  }
  if (image.active !== true) errors.push('pcore image config is not active')
  if (!Array.isArray(image.models) || !image.models.includes('gpt-image-2')) {
    errors.push('pcore image config does not include gpt-image-2')
  }

  const bgm = facts.bgm || {}
  if (bgm.exists !== true) errors.push('Fixed BGM file is missing')
  if (!Number.isFinite(bgm.duration_sec) || bgm.duration_sec < 180) {
    errors.push('Fixed BGM must be at least 180 seconds long')
  }

  const voice = facts.voice || {}
  // Production narration runs on Qwen3-TTS voice cloning (qwen3-tts provider);
  // MiniMax remains the music / fallback provider. Accept both.
  const narrationProviders = new Set(['minimax', 'qwen3-tts'])
  if (!narrationProviders.has(String(voice.provider || '').toLowerCase())) {
    errors.push(`Active narration provider must be minimax or qwen3-tts`)
  }
  if (voice.exists !== true) errors.push(`Fixed narration voice ${voice.id || 'unknown'} is missing`)
  if (String(voice.voice_provider || '').toLowerCase()
    && !narrationProviders.has(String(voice.voice_provider || '').toLowerCase())) {
    errors.push(`Fixed narration voice ${voice.id || 'unknown'} is not a minimax or qwen3-tts voice`)
  }

  return report('ENVIRONMENT_INVALID', errors, {
    worker_count: facts.worker_count ?? null,
    media_account_id: facts.media_account?.id ?? null,
    image_config_id: image.id ?? null,
    bgm_duration_sec: bgm.duration_sec ?? null,
    voice_id: voice.id ?? null,
  })
}

export function validateEpisodeOwnership({ run, drama, episode }) {
  const errors = []
  if (!drama) errors.push(`Drama ${run.dramaId || 'unknown'} does not exist`)
  if (!episode) errors.push(`Episode ${run.episodeId || 'unknown'} does not exist`)
  if (drama && String(drama.metadata || '') !== String(run.creationToken || '')) {
    errors.push('Drama creation token does not match this run')
  }
  if (episode && Number(episode.drama_id) !== Number(run.dramaId)) {
    errors.push('Episode is not owned by the run drama')
  }
  if (episode && String(episode.narration_voice_id || '') !== String(run.voiceId || '')) {
    errors.push('Episode narration voice differs from the fixed run voice')
  }
  if (episode && run.narrationSpeed !== undefined
    && Math.abs(Number(episode.narration_speed) - Number(run.narrationSpeed)) > 0.0001) {
    errors.push('Episode narration speed differs from the immutable run speed')
  }
  if (episode && Number(episode.image_config_id) !== Number(run.imageConfigId)) {
    errors.push('Episode image config differs from the validated pcore config')
  }
  if (episode && String(episode.bgm_audio_url || '') !== String(run.bgmPath || '')) {
    errors.push('Episode BGM differs from the fixed production bed')
  }
  return report('EPISODE_CREATE_FAILED', errors, {
    drama_id: run.dramaId ?? null,
    episode_id: run.episodeId ?? null,
  })
}

export function validateTtsClone({ expectedVoiceKey, currentVoiceKey, provider }) {
  const errors = []
  // Production narration uses Qwen3-TTS voice cloning; MiniMax is the music/fallback provider.
  if (!['minimax', 'qwen3-tts'].includes(String(provider || '').toLowerCase())) {
    errors.push('Active narration provider is not minimax or qwen3-tts')
  }
  if (!expectedVoiceKey || currentVoiceKey !== expectedVoiceKey) errors.push('Narration voice changed after environment validation')
  return report('TTS_CLONE_INVALID', errors, {
    expected_voice_key: expectedVoiceKey || null,
    current_voice_key: currentVoiceKey || null,
  })
}

export function validateManifest(manifest, options = {}) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return report('MANIFEST_INVALID', ['Manifest must be a JSON object'])
  }
  if (manifest.version !== 1) errors.push('manifest.version must be 1')
  const textEmphasisVersion = manifest.textEmphasisVersion
  if (textEmphasisVersion !== undefined && textEmphasisVersion !== 1) {
    errors.push('textEmphasisVersion must be 1 when present')
  }
  const emphasisCounts = { theme: 0, scripture: 0, explanation: 0 }
  positiveNumber(manifest.episodeId, 'episodeId', errors)
  positiveNumber(manifest.dramaId, 'dramaId', errors)
  const durationSec = positiveNumber(manifest.targetDurationSec, 'targetDurationSec', errors)
  if (Number.isFinite(durationSec) && durationSec < 30) errors.push('targetDurationSec must be at least 30 seconds')
  if ((manifest.fps ?? 30) !== 30) errors.push('Comic production is locked to 30fps')
  if ((manifest.width ?? 1280) !== 1280 || (manifest.height ?? 720) !== 720) {
    errors.push('Comic production is locked to 1280x720')
  }
  if (manifest.model !== 'gpt-image-2') errors.push('Comic production must use gpt-image-2')
  positiveNumber(manifest.configId, 'configId', errors)
  if (manifest.stylePreset !== 'retro-anime-1980s') {
    errors.push(`Unsupported stylePreset: ${manifest.stylePreset}`)
  }
  if (!Array.isArray(manifest.panels) || manifest.panels.length < 5 || manifest.panels.length % 5 !== 0) {
    errors.push('panels must contain complete five-panel pages')
  }

  const keys = new Set()
  const sources = new Set()
  let previousStart = -1
  let previousTtsTitleEnd = -1
  for (const [index, panel] of (manifest.panels || []).entries()) {
    if (!panel.key || !/^[a-z0-9][a-z0-9_-]*$/u.test(panel.key)) {
      errors.push(`panels[${index}].key must use lowercase letters, digits, underscore, or hyphen`)
      continue
    }
    if (keys.has(panel.key)) errors.push(`Duplicate panel key: ${panel.key}`)
    keys.add(panel.key)
    const startSec = Number(panel.startSec)
    if (!Number.isFinite(startSec) || startSec < 0 || startSec >= durationSec) {
      errors.push(`Panel ${panel.key} has invalid startSec`)
    }
    if (startSec <= previousStart) errors.push(`Panel ${panel.key} startSec must be strictly increasing`)
    if (index === 0 && startSec > 0.1) errors.push('The first panel must start at 0 seconds')
    // TTS beat starts are rounded to milliseconds; allow the resulting sub-second drift.
    const adjacentFrozenTitles = Number.isInteger(Number(panel.ttsTitleStart))
      && Number.isInteger(previousTtsTitleEnd)
      && Number(panel.ttsTitleStart) === previousTtsTitleEnd + 1
    // A single frozen TTS title can itself span just over the visual 20s
    // cadence. Keep the normal rule strict, but do not reject an unsplittable
    // adjacent title boundary created by the provider timeline.
    const unsplittableTtsGap = adjacentFrozenTitles && startSec - previousStart <= 22
    if (previousStart >= 0 && startSec - previousStart > 20.5 && !unsplittableTtsGap) {
      errors.push(`Panel ${panel.key} leaves more than 20 seconds without a new narrative beat`)
    }
    previousStart = startSec

    const ttsTitleStart = Number(panel.ttsTitleStart)
    const ttsTitleEnd = Number(panel.ttsTitleEnd)
    if (!Number.isInteger(ttsTitleStart) || ttsTitleStart < 0
      || !Number.isInteger(ttsTitleEnd) || ttsTitleEnd < ttsTitleStart) {
      errors.push(`Panel ${panel.key} has an invalid TTS title range`)
    } else {
      if (ttsTitleStart !== previousTtsTitleEnd + 1) {
        errors.push(`Panel ${panel.key} TTS title range must continue from the previous panel`)
      }
      previousTtsTitleEnd = ttsTitleEnd
    }

    const hasSource = typeof panel.src === 'string' && panel.src.trim().length > 0
    const hasPrompt = typeof panel.prompt === 'string' && panel.prompt.trim().length > 0
    if (hasSource === hasPrompt) errors.push(`Panel ${panel.key} must provide exactly one of src or prompt`)
    if (hasSource) {
      if (sources.has(panel.src)) errors.push(`Asset reuse is forbidden: ${panel.src}`)
      sources.add(panel.src)
    } else {
      if (!panel.narrationText?.trim()) errors.push(`Panel ${panel.key} requires narrationText`)
      if (!panel.visualProposition?.trim()) errors.push(`Panel ${panel.key} requires visualProposition`)
      for (const field of semanticFields) {
        const value = panel.semantic?.[field]
        if (field === 'subject_count') {
          if (!Number.isInteger(value) || value < 0) errors.push(`Panel ${panel.key} semantic.${field} is invalid`)
        } else if (typeof value !== 'string' || !value.trim()) {
          errors.push(`Panel ${panel.key} requires semantic.${field}`)
        }
      }
    }

    const rawReferencePanelKeys = panel.referencePanelKeys
    const rawReferenceImages = panel.referenceImages
    if (rawReferencePanelKeys !== undefined && !Array.isArray(rawReferencePanelKeys)) {
      errors.push(`Panel ${panel.key} referencePanelKeys must be an array`)
    }
    if (rawReferenceImages !== undefined && !Array.isArray(rawReferenceImages)) {
      errors.push(`Panel ${panel.key} referenceImages must be an array`)
    }
    const referencePanelKeys = Array.isArray(rawReferencePanelKeys) ? rawReferencePanelKeys : []
    const referenceImages = Array.isArray(rawReferenceImages) ? rawReferenceImages : []
    for (const referenceKey of referencePanelKeys) {
      if (!keys.has(referenceKey)) {
        errors.push(`Panel ${panel.key} referencePanelKeys must point backward: ${referenceKey}`)
      }
    }
    if (referenceImages.length + referencePanelKeys.length > 3) {
      errors.push(`Panel ${panel.key} has more than 3 total reference images`)
    }
    if (options.resolveReferenceImage) {
      for (const referenceImage of referenceImages) {
        try {
          options.resolveReferenceImage(referenceImage)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
    if (panel.bubble) validateBubble(panel.key, panel.bubble, errors)
    if (panel.quote) validateQuote(panel, errors, textEmphasisVersion, emphasisCounts)
  }

  if (textEmphasisVersion === 1) {
    if (emphasisCounts.theme !== 1) {
      errors.push('textEmphasisVersion 1 requires exactly one theme quote')
    }
    const emphasisTotal = Object.values(emphasisCounts).reduce((sum, count) => sum + count, 0)
    if (durationSec >= 180 && emphasisTotal < 3) {
      errors.push('Long-form textEmphasisVersion 1 manifests require at least three emphasis events')
    }
    if (durationSec >= 180 && emphasisCounts.explanation < 1) {
      errors.push('Long-form textEmphasisVersion 1 manifests require at least one explanation quote')
    }
    const mentionsCanonicalSource = (manifest.panels || []).some((panel) => /《[^》]+》/u.test(String(panel.narrationText || '')))
    if (mentionsCanonicalSource && emphasisCounts.scripture < 1) {
      errors.push('Narration names a canonical source but no scripture quote is marked')
    }
  }

  if (manifest.deliveryOutput && !String(manifest.deliveryOutput).endsWith('.mp4')) {
    errors.push('deliveryOutput must be an .mp4 path')
  }
  if (options.expectedEpisodeId !== undefined
    && Number(manifest.episodeId) !== Number(options.expectedEpisodeId)) {
    errors.push('manifest.episodeId does not match the production run')
  }
  if (options.expectedDramaId !== undefined
    && Number(manifest.dramaId) !== Number(options.expectedDramaId)) {
    errors.push('manifest.dramaId does not match the production run')
  }
  if (options.expectedConfigId !== undefined
    && Number(manifest.configId) !== Number(options.expectedConfigId)) {
    errors.push('manifest.configId does not match the validated pcore config')
  }
  if (options.expectedTargetDurationSec !== undefined
    && Math.abs(Number(manifest.targetDurationSec) - Number(options.expectedTargetDurationSec)) > 0.05) {
    errors.push('manifest.targetDurationSec does not match the verified TTS timeline')
  }
  if (options.expectedDeliveryOutput !== undefined
    && String(manifest.deliveryOutput || '') !== String(options.expectedDeliveryOutput)) {
    errors.push('manifest.deliveryOutput does not match the immutable run output')
  }
  if (options.expectedBeats !== undefined) {
    if (!Array.isArray(options.expectedBeats)) {
      errors.push('expectedBeats must be an array')
    } else {
      const panels = Array.isArray(manifest.panels) ? manifest.panels : []
      if (panels.length !== options.expectedBeats.length) {
        errors.push('Manifest panel count does not match the frozen beat skeleton')
      }
      for (let index = 0; index < Math.min(panels.length, options.expectedBeats.length); index += 1) {
        const panel = panels[index]
        const beat = options.expectedBeats[index]
        const label = panel?.key || `panels[${index}]`
        if (panel?.key !== beat?.key) {
          errors.push(`Panel ${label} key does not match the frozen beat skeleton`)
        }
        if (panel?.startSec !== beat?.startSec) {
          errors.push(`Panel ${label} startSec does not match the frozen beat skeleton`)
        }
        if (panel?.narrationText !== beat?.narrationText) {
          errors.push(`Panel ${label} narrationText does not match the frozen beat skeleton`)
        }
        if (panel?.ttsTitleStart !== beat?.ttsTitleStart
          || panel?.ttsTitleEnd !== beat?.ttsTitleEnd) {
          errors.push(`Panel ${label} TTS title range does not match the frozen beat skeleton`)
        }
      }
    }
  }
  const data = {
    panel_count: Array.isArray(manifest.panels) ? manifest.panels.length : 0,
    fixed_profile: manifest.stylePreset === 'retro-anime-1980s',
    emphasis_counts: emphasisCounts,
    legacy_text_emphasis: textEmphasisVersion === undefined,
  }
  return report('MANIFEST_INVALID', errors, data, data)
}

export function validatePanelAssets(manifest, state, options) {
  const errors = []
  const byKey = new Map((state?.jobs || []).map((job) => [job.key, job]))
  const assets = []
  for (const panel of manifest.panels || []) {
    const sourcePath = byKey.get(panel.key)?.localPath
    if (!sourcePath) {
      errors.push(`Panel ${panel.key} is not ready`)
      continue
    }
    try {
      const path = options.resolveAssetPath(sourcePath)
      assets.push({ key: panel.key, path, sourcePath })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (errors.length) return report('ASSET_INVALID', errors, { expected: manifest.panels?.length || 0 })

  const fingerprints = assets.map((asset) => ({
    key: asset.key,
    path: asset.path,
    bytes: options.statFile(asset.path).size,
    sha256: options.hashFile(asset.path),
  }))
  if (new Set(fingerprints.map((item) => item.sha256)).size !== fingerprints.length) {
    errors.push('Two panels resolve to identical image content; asset reuse is forbidden')
  }
  const fingerprint = options.hashValue(JSON.stringify(fingerprints))
  return report('ASSET_INVALID', errors, {
    expected: manifest.panels.length,
    resolved: assets.length,
    unique_content: new Set(fingerprints.map((item) => item.sha256)).size,
  }, { assets, fingerprints, fingerprint })
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function validateNativeResult({
  nativeResultPath,
  deliveryPath,
  expectedFrames,
  expectedPropsSha256,
  expectedSfxEventCount,
  expectedNarrationLufs,
  expectedAudioMixVersion = NATIVE_AUDIO_MIX_VERSION,
  expectedBgmMounted = false,
  expectedTextLayers,
  expectedVideoEncoder = DHARMA_VIDEO_ENCODER,
}) {
  const errors = []
  if (!existsSync(nativeResultPath)) errors.push(`Native result does not exist: ${nativeResultPath}`)
  if (!existsSync(deliveryPath)) errors.push(`Delivery does not exist: ${deliveryPath}`)
  if (!expectedPropsSha256) errors.push('Expected props SHA-256 is required')
  if (errors.length) return report('NATIVE_RESULT_INVALID', errors)

  let nativeResult
  try {
    nativeResult = JSON.parse(readFileSync(nativeResultPath, 'utf8'))
  } catch (error) {
    errors.push(`Cannot parse native result: ${error instanceof Error ? error.message : String(error)}`)
    return report('NATIVE_RESULT_INVALID', errors)
  }
  if (resolve(nativeResult.output) !== resolve(deliveryPath)) errors.push('Native renderer published an unexpected output path')
  if (nativeResult.renderer !== 'native-comic-v12') {
    errors.push(`Unexpected native renderer version: ${nativeResult.renderer}`)
  }
  // Production results must carry the encoder identity as well as the later
  // ffprobe stream check; missing metadata must not hide a software fallback.
  if (nativeResult.videoEncoder !== expectedVideoEncoder) {
    errors.push(`Unexpected native video encoder: ${nativeResult.videoEncoder || 'missing'}`)
  }
  if (nativeResult.textPresentationVersion !== 'dharma-text-v5') {
    errors.push(`Unexpected text presentation version: ${nativeResult.textPresentationVersion}`)
  }
  if (nativeResult.subtitlePreset !== 'ink-read-v2') {
    errors.push(`Unexpected subtitle preset: ${nativeResult.subtitlePreset}`)
  }
  // dharma-text-v5：plate 底片模式必须显式声明 textLayers='overlay'，
  // 防止 burned 全层产物被误当底片进入 Remotion 叠加链路。
  if (expectedTextLayers !== undefined && nativeResult.textLayers !== expectedTextLayers) {
    errors.push(`Unexpected text layers mode: ${nativeResult.textLayers || 'missing'}`)
  }
  if (nativeResult.audioMixVersion !== expectedAudioMixVersion) {
    errors.push(`Unexpected native audio mix version: ${nativeResult.audioMixVersion || 'missing'}`)
  }
  if (expectedBgmMounted === true && nativeResult.bgmMounted !== true) {
    errors.push('Native renderer did not mount the required BGM')
  }
  if (expectedBgmMounted === true
    && (!Number.isFinite(Number(nativeResult.bgmGain)) || Number(nativeResult.bgmGain) <= 0)) {
    errors.push('Native renderer did not record a positive BGM gain')
  }
  if (expectedSfxEventCount !== undefined
    && Number(nativeResult.sfxEventCount) !== Number(expectedSfxEventCount)) {
    errors.push('Native renderer result has an unexpected SFX event count')
  }
  if (Number(expectedSfxEventCount) > 0) {
    if (!Number.isFinite(Number(nativeResult.sfxMaxDurationSec)) || Number(nativeResult.sfxMaxDurationSec) >= 0.4) {
      errors.push('Emphasis SFX must be shorter than 400ms')
    }
    if (!Number.isFinite(Number(nativeResult.sfxMeasuredLufs))) {
      errors.push('Native renderer did not measure emphasis SFX loudness')
    }
    if (Number.isFinite(Number(expectedNarrationLufs))
      && Number(expectedNarrationLufs) - Number(nativeResult.sfxMeasuredLufs) < 24) {
      errors.push('Emphasis SFX is not at least 24 LU below narration')
    }
  }
  if (Number(nativeResult.durationFrames) !== Number(expectedFrames)) {
    errors.push('Native renderer result has an unexpected frame count')
  }
  const deliveryBytes = statSync(deliveryPath).size
  const deliverySha256 = sha256File(deliveryPath)
  if (nativeResult.propsSha256 !== expectedPropsSha256) {
    errors.push('Native renderer props SHA-256 does not match the frozen props')
  }
  if (nativeResult.outputSha256 !== deliverySha256) {
    errors.push('Native renderer output SHA-256 does not match the delivery file')
  }
  if (Number(nativeResult.outputBytes) !== deliveryBytes) {
    errors.push('Native renderer output byte count does not match the delivery file')
  }
  return report('NATIVE_RESULT_INVALID', errors, {
    renderer: nativeResult.renderer,
    video_encoder: nativeResult.videoEncoder || null,
    duration_frames: Number(nativeResult.durationFrames),
    props_sha256: nativeResult.propsSha256 || null,
    output_sha256: deliverySha256,
    delivery_bytes: deliveryBytes,
  }, nativeResult)
}

export function validateTtsTimeline({ titles, audioDurationSec, targetDurationSec }) {
  const errors = []
  if (!Array.isArray(titles) || !titles.length) errors.push('TTS titles must be a non-empty array')
  let previousEnd = -1
  let maxGapMs = 0
  for (const [index, title] of (titles || []).entries()) {
    const titleText = String(title?.text || '')
    if (index < 3 && /(?:^|\s)(?:title|confirmed_at|gate)\s*:/u.test(titleText)) {
      errors.push(`TTS title ${index + 1} contains script front matter; narration must be body-only`)
    }
    const start = Number(title.time_begin)
    const end = Number(title.time_end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      errors.push(`TTS title ${index + 1} has an invalid time range`)
    }
    if (start < previousEnd) errors.push(`TTS title ${index + 1} overlaps the previous title`)
    if (previousEnd >= 0 && Number.isFinite(start) && Number.isFinite(previousEnd)) {
      maxGapMs = Math.max(maxGapMs, start - previousEnd)
    }
    previousEnd = end
  }
  const firstStart = Number(titles?.[0]?.time_begin)
  const lastEnd = Number(titles?.at(-1)?.time_end)
  const coveredSec = Number.isFinite(firstStart) && Number.isFinite(lastEnd) ? (lastEnd - firstStart) / 1000 : 0
  const coverageRatio = audioDurationSec > 0 ? coveredSec / audioDurationSec : 0
  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) errors.push('TTS audio duration is invalid')
  const tailToleranceSec = Number.isFinite(audioDurationSec) && audioDurationSec > 0
    ? Math.min(1, Math.max(0.25, audioDurationSec * 0.02))
    : 0
  const firstStartSec = Number.isFinite(firstStart) ? firstStart / 1000 : Number.NaN
  const lastEndSec = Number.isFinite(lastEnd) ? lastEnd / 1000 : Number.NaN
  if (Number.isFinite(firstStartSec) && firstStartSec > tailToleranceSec) {
    errors.push(`TTS first title starts too far after audio begins: ${firstStartSec.toFixed(3)}s > ${tailToleranceSec.toFixed(3)}s`)
  }
  if (Number.isFinite(audioDurationSec) && Number.isFinite(lastEndSec)
    && audioDurationSec - lastEndSec > tailToleranceSec) {
    errors.push(`TTS last title ends too far before audio ends: ${(audioDurationSec - lastEndSec).toFixed(3)}s > ${tailToleranceSec.toFixed(3)}s`)
  }
  if (coverageRatio > 1.02) {
    errors.push(`TTS title coverage ratio ${coverageRatio.toFixed(3)} is above 1.02`)
  }
  if (maxGapMs > 1500) {
    errors.push(`TTS title timeline has a material uncovered gap: ${(maxGapMs / 1000).toFixed(3)}s`)
  }
  if (Number.isFinite(targetDurationSec) && targetDurationSec - lastEnd / 1000 > 3) {
    errors.push('Target duration leaves more than 3 seconds after narration')
  }
  return report('TTS_TIMELINE_MISMATCH', errors, {
    title_count: titles?.length || 0,
    covered_sec: coveredSec,
    audio_duration_sec: audioDurationSec,
    coverage_ratio: coverageRatio,
    tail_tolerance_sec: tailToleranceSec,
    max_gap_sec: maxGapMs / 1000,
  })
}

export function fractionValue(value) {
  const [numerator, denominator] = String(value || '').split('/').map(Number)
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : Number.NaN
}

export function parseBlackIntervals(log) {
  const intervals = []
  const pattern = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/gu
  for (const match of String(log || '').matchAll(pattern)) {
    const interval = {
      startSec: Number(match[1]),
      endSec: Number(match[2]),
      durationSec: Number(match[3]),
    }
    if (Object.values(interval).every(Number.isFinite)) intervals.push(interval)
  }
  return [...new Map(intervals.map((interval) => [
    `${interval.startSec}:${interval.endSec}:${interval.durationSec}`,
    interval,
  ])).values()]
}

export function extractFfmpegWarnings(log, limit = 20) {
  const diagnosticPattern = /warning|deprecated|non[ -]?monoton|invalid dts|conversion|codec.*(?:failed|unsupported|mismatch)|timestamp.*(?:invalid|discontinu)/iu
  const unique = []
  const seen = new Set()
  for (const rawLine of String(log || '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || !diagnosticPattern.test(line) || seen.has(line)) continue
    seen.add(line)
    unique.push(line)
    if (unique.length >= limit) break
  }
  return unique
}

export function parseProgressFrameCount(progress) {
  const matches = [...String(progress || '').matchAll(/^frame=(\d+)$/gmu)]
  return matches.length ? Number(matches.at(-1)[1]) : Number.NaN
}

export function assessDeliveryQuality({
  probe,
  probeStatus = 0,
  probeToolError,
  expectedFrames,
  expectedFps,
  decodeStatus,
  decodeToolError,
  decodedFrames,
  blackScanLog,
  integratedLufs,
  loudnessError,
  syncStatus,
  syncToolError,
}) {
  const blockingErrors = []
  const warnings = []
  const block = (code, message, detail, retryable = false) => blockingErrors.push({
    code,
    message,
    retryable,
    ...(detail === undefined ? {} : { detail }),
  })
  const warn = (code, message, detail) => warnings.push({ code, message, ...(detail === undefined ? {} : { detail }) })
  const videos = (probe?.streams || []).filter((stream) => stream.codec_type === 'video')
  const audios = (probe?.streams || []).filter((stream) => stream.codec_type === 'audio')
  const video = videos[0]
  const audio = audios[0]
  const expectedDurationSec = expectedFrames / expectedFps
  const durationToleranceSec = Math.max(0.1, 2 / expectedFps)

  if (probeToolError) {
    block('PROBE_TOOL_FAILED', 'ffprobe could not complete the delivery inspection', String(probeToolError), true)
  } else if (probeStatus !== 0) {
    block('PROBE_FAILED', 'ffprobe completed with an error for the delivery bytes', { status: probeStatus })
  } else if (videos.length !== 1 || audios.length !== 1) {
    block('WRONG_STREAM_COUNT', 'Delivery must contain exactly one video and one audio stream', {
      videoStreams: videos.length,
      audioStreams: audios.length,
    })
  }
  if (video && audio) {
    if (video.codec_name !== 'h264' || audio.codec_name !== 'aac') {
      block('WRONG_CODECS', 'Delivery must be H.264 + AAC', {
        videoCodec: video.codec_name,
        audioCodec: audio.codec_name,
      })
    }
    if (Number(video.width) !== 1280 || Number(video.height) !== 720) {
      block('WRONG_DIMENSIONS', 'Delivery must be 1280x720', { width: video.width, height: video.height })
    }
    const actualFps = fractionValue(video.avg_frame_rate)
    if (!Number.isFinite(actualFps) || Math.abs(actualFps - expectedFps) > 0.001) {
      block('WRONG_FPS', `Delivery must be ${expectedFps}fps`, { actual: video.avg_frame_rate })
    }
    const videoDurationSec = Number(video.duration)
    const audioDurationSec = Number(audio.duration)
    const formatDurationSec = Number(probe?.format?.duration)
    const measuredDurationSec = Number.isFinite(videoDurationSec) ? videoDurationSec : formatDurationSec
    if (!Number.isFinite(measuredDurationSec)
      || Math.abs(measuredDurationSec - expectedDurationSec) > durationToleranceSec) {
      block('WRONG_DURATION', 'Delivery video duration is outside the frame-derived tolerance', {
        expectedDurationSec,
        actualDurationSec: measuredDurationSec,
        toleranceSec: durationToleranceSec,
      })
    }
    if (Number.isFinite(videoDurationSec) && Number.isFinite(audioDurationSec)
      && Math.abs(videoDurationSec - audioDurationSec) > durationToleranceSec) {
      block('AUDIO_VIDEO_DURATION_MISMATCH', 'Audio and video stream durations are out of sync', {
        videoDurationSec,
        audioDurationSec,
        toleranceSec: durationToleranceSec,
      })
    }
    if (Number(video.has_b_frames) > 0) {
      warn('B_FRAMES_PRESENT', 'Delivery contains B-frames; decoded viewing result passed but timestamp portability should be reviewed', {
        hasBFrames: Number(video.has_b_frames),
      })
    }
    const videoBitrate = Number(video.bit_rate || 0)
    if (videoBitrate > 1_250_000) {
      warn('VIDEO_BITRATE_ABOVE_TARGET', 'Video bitrate exceeds the 1Mbps production target', { videoBitrate })
    }
  }

  if (decodeToolError) {
    block('DECODE_TOOL_FAILED', 'Full-video ffmpeg decode could not complete', String(decodeToolError), true)
  } else if (decodeStatus !== 0) {
    block('DECODE_FAILED', 'Full-video ffmpeg decode failed', { status: decodeStatus })
  }
  if (!decodeToolError && (!Number.isInteger(decodedFrames) || decodedFrames !== expectedFrames)) {
    block('DECODED_FRAME_COUNT_MISMATCH', 'Decoded frame count does not match the render plan', {
      expectedFrames,
      decodedFrames,
    })
  }

  const blackIntervals = parseBlackIntervals(blackScanLog)
  for (const interval of blackIntervals) {
    if (interval.durationSec >= 0.5) {
      block('OBVIOUS_BLACK_FRAME', 'A sustained near-black interval is plainly visible', interval)
    } else {
      warn('BLACK_FRAME_CANDIDATE', 'A short near-black interval needs review but does not alone reject the video', interval)
    }
  }
  for (const diagnostic of extractFfmpegWarnings(blackScanLog)) {
    warn('FFMPEG_DIAGNOSTIC', 'ffmpeg emitted a non-blocking codec/conversion diagnostic', diagnostic)
  }

  if (syncToolError) {
    block('SYNC_TOOL_FAILED', 'Authoritative TTS synchronization checker could not complete', String(syncToolError), true)
  } else if (syncStatus !== 0) {
    block('SYNC_CHECK_FAILED', 'Authoritative TTS synchronization check failed', { status: syncStatus })
  }
  if (loudnessError) {
    block('LOUDNESS_SCAN_FAILED', 'Integrated loudness measurement failed', String(loudnessError), true)
  } else if (!Number.isFinite(integratedLufs)) {
    block('LOUDNESS_SCAN_FAILED', 'Integrated loudness measurement returned no numeric result', undefined, true)
  } else if (integratedLufs > -20) {
    block('LOUDNESS_OUT_OF_RANGE', 'Delivery is too loud for narration-first listening', { integratedLufs })
  }

  const deterministicErrors = blockingErrors.filter((error) => error.retryable !== true)
  const retryableErrors = blockingErrors.filter((error) => error.retryable === true)

  return {
    passed: blockingErrors.length === 0,
    error_code: blockingErrors.length ? 'DELIVERY_VERIFICATION_FAILED' : null,
    failureClass: blockingErrors.length === 0
      ? null
      : deterministicErrors.length > 0 ? 'deterministic' : 'transient',
    retryable: blockingErrors.length > 0 && deterministicErrors.length === 0,
    blockingErrors,
    retryableErrors,
    warnings,
    metrics: {
      expectedFrames,
      decodedFrames,
      expectedFps,
      expectedDurationSec,
      integratedLufs: Number.isFinite(integratedLufs) ? integratedLufs : null,
      blackFrameCandidates: blackIntervals.length,
    },
  }
}
