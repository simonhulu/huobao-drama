import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// History comic five production identity. The manifest builder
// (scripts/videoeditor/build_history_comic_manifest.mjs) must emit exactly
// these strings; the runner validates them before freezing the manifest.
export const manifestContract = 'history-comic-five-manifest-v1'
export const manifestFactory = 'history-comic-five-v1'
// History rule: the episode BGM bed must be at least 30 seconds (the dharma
// pipeline requires 180s; do not copy that number here).
export const minHistoryBgmSec = 30

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

export function storyboardIdFromPanelKey(key) {
  const match = /^sb-(\d+)(?:-p\d+)?$/u.exec(String(key || '').trim())
  return match ? Number(match[1]) : null
}

export function validateEnvironment(facts) {
  const errors = []
  if (facts.api_health_ok !== true) errors.push('Backend health check failed')
  if (!Number.isInteger(facts.worker_count) || facts.worker_count < 1) {
    errors.push('No healthy task worker is available')
  }
  if (facts.ffmpeg_ok !== true) errors.push('ffmpeg is unavailable')
  if (facts.ffprobe_ok !== true) errors.push('ffprobe is unavailable')
  if (facts.native_renderer_ok !== true) errors.push('native-comic-v12 renderer is unavailable')
  if (facts.font_sans_ok !== true) errors.push('NotoSansCJKsc-Regular.otf is missing')
  if (facts.font_serif_ok !== true) errors.push('NotoSerifSC-Bold.ttf is missing')
  if (facts.sync_checker_ok !== true) errors.push('check_dharma_sync.mjs is unavailable')

  const bgm = facts.bgm || {}
  if (bgm.exists !== true) errors.push('Episode BGM file is missing')
  if (!Number.isFinite(bgm.duration_sec) || bgm.duration_sec < minHistoryBgmSec) {
    errors.push(`Episode BGM must be at least ${minHistoryBgmSec} seconds long`)
  }

  return report('ENVIRONMENT_INVALID', errors, {
    worker_count: facts.worker_count ?? null,
    bgm_duration_sec: bgm.duration_sec ?? null,
  })
}

export function validateEpisodeSnapshot({ episode, drama } = {}) {
  const errors = []
  if (!episode) errors.push('Episode does not exist')
  if (!drama) errors.push('Episode drama does not exist')
  if (episode && drama && Number(episode.drama_id) !== Number(drama.id)) {
    errors.push('Episode is not owned by the resolved drama')
  }
  if (episode) {
    const workflowType = String(episode.workflow_type || '').trim()
    if (workflowType !== 'direct_script') {
      errors.push(`Episode ${episode.id} is workflow_type=${workflowType || 'unset'}, not direct_script; the history factory only produces direct_script episodes (the manuscript drives storyboard breaking and the pre-TTS master, so a non-direct_script episode can never pass tts_verify)`)
    }
    if (!String(episode.script_content || '').trim()) {
      errors.push(`Episode ${episode.id} has no direct script manuscript (script_content is empty); write the final manuscript into the episode before production`)
    }
  }
  if (drama && !String(drama.style || '').trim()) {
    errors.push(`Drama ${drama.id} has no locked series visual profile; set dramas.style before production (lock the series visual profile)`)
  }
  return report('EPISODE_SNAPSHOT_INVALID', errors, {
    episode_id: episode?.id ?? null,
    drama_id: drama?.id ?? null,
    style: drama?.style ?? null,
    workflow_type: episode?.workflow_type ?? null,
    has_script: Boolean(episode && String(episode.script_content || '').trim()),
  })
}

export function validateTtsTimeline({ titles, audioDurationSec, targetDurationSec }) {
  const errors = []
  if (!Array.isArray(titles) || !titles.length) errors.push('TTS titles must be a non-empty array')
  let previousEnd = -1
  for (const [index, title] of (titles || []).entries()) {
    const text = String(title?.text || '')
    if (!text.trim()) errors.push(`TTS title ${index + 1} has empty text`)
    const start = Number(title?.time_begin)
    const end = Number(title?.time_end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      errors.push(`TTS title ${index + 1} has an invalid time range`)
    }
    if (Number.isFinite(start) && start < 0) errors.push(`TTS title ${index + 1} starts before zero`)
    if (start < previousEnd) errors.push(`TTS title ${index + 1} overlaps the previous title`)
    previousEnd = end
  }
  const firstStart = Number(titles?.[0]?.time_begin)
  const lastEnd = Number(titles?.at(-1)?.time_end)
  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) errors.push('TTS audio duration is invalid')
  const coveredSec = Number.isFinite(firstStart) && Number.isFinite(lastEnd) ? (lastEnd - firstStart) / 1000 : 0
  const coverageRatio = audioDurationSec > 0 ? coveredSec / audioDurationSec : 0
  if (Number.isFinite(audioDurationSec) && audioDurationSec > 0 && (coverageRatio < 0.6 || coverageRatio > 1.05)) {
    errors.push(`TTS title coverage ratio ${coverageRatio.toFixed(3)} is outside 0.60-1.05`)
  }
  if (Number.isFinite(targetDurationSec) && Number.isFinite(lastEnd)) {
    const tailSec = targetDurationSec - lastEnd / 1000
    if (tailSec > 3) errors.push('Target duration leaves more than 3 seconds after narration')
    if (tailSec < 0) errors.push('Target duration truncates the narration master')
  }
  return report('TTS_TIMELINE_MISMATCH', errors, {
    title_count: titles?.length || 0,
    covered_sec: coveredSec,
    audio_duration_sec: audioDurationSec,
    coverage_ratio: coverageRatio,
  })
}

export function validateNarrativePlan({ plan, beatCoverage, storyboardCount } = {}) {
  const errors = []
  if (!plan) {
    errors.push("No narrative_plans row with kind = 'full' exists for this episode")
  } else {
    if (String(plan.kind || '') !== 'full') errors.push("Latest narrative plan kind must be 'full'")
    if (!plan.timing_source || String(plan.timing_source) === 'storyboard_grid_fallback') {
      errors.push('Latest full narrative plan is a storyboard_grid_fallback skeleton, not real narrative design')
    }
  }
  if (!Number.isInteger(beatCoverage) || beatCoverage < 0) {
    errors.push('Beat coverage query did not return a non-negative integer')
  }
  if (!Number.isInteger(storyboardCount) || storyboardCount < 1) {
    errors.push('Episode has no in-scope storyboards')
  }
  if (Number.isInteger(beatCoverage) && Number.isInteger(storyboardCount) && beatCoverage !== storyboardCount) {
    errors.push(`Beat timing coverage ${beatCoverage} does not equal in-scope storyboard count ${storyboardCount}`)
  }
  return report('NARRATIVE_PLAN_INVALID', errors, {
    plan_id: plan?.id ?? null,
    kind: plan?.kind ?? null,
    timing_source: plan?.timing_source ?? null,
    beat_coverage: Number.isInteger(beatCoverage) ? beatCoverage : null,
    storyboard_count: Number.isInteger(storyboardCount) ? storyboardCount : null,
  })
}

export function validateManifest(manifest, options = {}) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return report('MANIFEST_INVALID', ['Manifest must be a JSON object'])
  }
  const expectedContract = options.expectedContract || manifestContract
  if (String(manifest.contract || '') !== expectedContract) {
    errors.push(`manifest.contract must be ${expectedContract}`)
  }
  if (String(manifest.factory || '') !== manifestFactory) {
    errors.push(`manifest.factory must be ${manifestFactory}`)
  }
  positiveNumber(manifest.episodeId, 'episodeId', errors)
  positiveNumber(manifest.dramaId, 'dramaId', errors)
  const durationSec = positiveNumber(manifest.targetDurationSec, 'targetDurationSec', errors)
  const narrationEndSec = positiveNumber(manifest.narrationEndSec, 'narrationEndSec', errors)
  if (Number.isFinite(durationSec) && Number.isFinite(narrationEndSec)) {
    const tailSec = durationSec - narrationEndSec
    if (tailSec > 3) errors.push('targetDurationSec leaves more than 3 seconds after narration')
    if (tailSec < 0) errors.push('targetDurationSec truncates the narration master')
  }
  if (!Array.isArray(manifest.panels) || manifest.panels.length < 5) {
    errors.push('panels must contain at least 5 panels')
  }

  const keys = new Set()
  const sources = new Set()
  let previousStart = -1
  let previousEnd = -1
  const titleCount = Number.isInteger(options.expectedTitleCount) ? options.expectedTitleCount : null
  for (const [index, panel] of (manifest.panels || []).entries()) {
    const key = String(panel?.key || '')
    const storyboardId = storyboardIdFromPanelKey(key)
    if (storyboardId === null) {
      errors.push(`panels[${index}].key must parse as sb-<storyboardId>[-pN]: ${key || 'empty'}`)
      continue
    }
    if (keys.has(key)) errors.push(`Duplicate panel key: ${key}`)
    keys.add(key)
    if (panel.storyboardId !== undefined && Number(panel.storyboardId) !== storyboardId) {
      errors.push(`Panel ${key} storyboardId does not match its key`)
    }

    const startSec = Number(panel.startSec)
    const endSec = Number(panel.endSec)
    if (!Number.isFinite(startSec) || startSec < 0) errors.push(`Panel ${key} has invalid startSec`)
    if (!Number.isFinite(endSec) || endSec <= startSec) errors.push(`Panel ${key} has invalid endSec`)
    if (Number.isFinite(startSec)) {
      if (index === 0 && startSec > 0.5) errors.push('The first panel must start at 0 seconds')
      if (previousStart >= 0 && startSec <= previousStart) {
        errors.push(`Panel ${key} startSec must be strictly increasing`)
      }
      if (previousEnd >= 0 && startSec < previousEnd - 0.5) {
        errors.push(`Panel ${key} overlaps the previous panel by more than 500ms`)
      }
    }
    if (Number.isFinite(endSec) && Number.isFinite(durationSec) && endSec > durationSec + 0.5) {
      errors.push(`Panel ${key} ends after targetDurationSec`)
    }
    previousStart = startSec
    previousEnd = Number.isFinite(endSec) ? endSec : previousEnd

    const ttsTitleStart = Number(panel.ttsTitleStart)
    const ttsTitleEnd = Number(panel.ttsTitleEnd)
    if (!Number.isInteger(ttsTitleStart) || ttsTitleStart < 0
      || !Number.isInteger(ttsTitleEnd) || ttsTitleEnd < ttsTitleStart) {
      errors.push(`Panel ${key} has an invalid TTS title range`)
    } else if (titleCount !== null && ttsTitleEnd >= titleCount) {
      errors.push(`Panel ${key} TTS title range exceeds the frozen titles (${titleCount})`)
    }

    const src = typeof panel.src === 'string' ? panel.src.trim() : ''
    if (!src) {
      errors.push(`Panel ${key} has an empty src`)
    } else {
      if (sources.has(src)) errors.push(`Asset reuse is forbidden: ${src}`)
      sources.add(src)
    }
    if (panel.focusX !== undefined && (!Number.isFinite(Number(panel.focusX)) || Number(panel.focusX) < 0 || Number(panel.focusX) > 100)) {
      errors.push(`Panel ${key} focusX must be 0-100`)
    }
    if (panel.focusY !== undefined && (!Number.isFinite(Number(panel.focusY)) || Number(panel.focusY) < 0 || Number(panel.focusY) > 100)) {
      errors.push(`Panel ${key} focusY must be 0-100`)
    }
  }

  if (options.expectedEpisodeId !== undefined
    && Number(manifest.episodeId) !== Number(options.expectedEpisodeId)) {
    errors.push('manifest.episodeId does not match the production run')
  }
  if (options.expectedDramaId !== undefined
    && Number(manifest.dramaId) !== Number(options.expectedDramaId)) {
    errors.push('manifest.dramaId does not match the production run')
  }
  if (options.expectedNarrationEndSec !== undefined
    && Number.isFinite(narrationEndSec)
    && Math.abs(narrationEndSec - Number(options.expectedNarrationEndSec)) > 0.05) {
    errors.push('manifest.narrationEndSec does not match the frozen TTS timeline')
  }
  const data = {
    panel_count: Array.isArray(manifest.panels) ? manifest.panels.length : 0,
    storyboard_ids: [...new Set((manifest.panels || []).map((panel) => storyboardIdFromPanelKey(panel?.key)).filter((id) => id !== null))],
  }
  return report('MANIFEST_INVALID', errors, data, data)
}

export function validatePanelAssets(panels, options) {
  const errors = []
  const assets = []
  for (const panel of panels || []) {
    const sourcePath = typeof panel?.src === 'string' ? panel.src.trim() : ''
    if (!sourcePath) {
      errors.push(`Panel ${panel?.key || 'unknown'} has no src`)
      continue
    }
    try {
      const path = options.resolveAssetPath(sourcePath)
      assets.push({ key: panel.key, path, sourcePath })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (errors.length) return report('ASSET_INVALID', errors, { expected: panels?.length || 0 })

  const fingerprints = assets.map((asset) => ({
    key: asset.key,
    path: asset.path,
    bytes: options.statFile(asset.path).size,
    sha256: options.hashFile(asset.path),
  }))
  for (const item of fingerprints) {
    if (!Number.isFinite(item.bytes) || item.bytes < 1) {
      errors.push(`Panel ${item.key} resolves to an empty file: ${item.path}`)
    }
  }
  if (new Set(fingerprints.map((item) => item.sha256)).size !== fingerprints.length) {
    errors.push('Two panels resolve to identical image content; asset reuse is forbidden')
  }
  const fingerprint = options.hashValue(JSON.stringify(fingerprints))
  return report('ASSET_INVALID', errors, {
    expected: panels.length,
    resolved: assets.length,
    unique_content: new Set(fingerprints.map((item) => item.sha256)).size,
  }, { assets, fingerprints, fingerprint })
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
  } else if (actor === 'runner') {
    if (reviewTool !== 'numeric') errors.push('Runner visual approval must be recorded as a numeric gate review')
  } else {
    errors.push('Visual approval actor must be agent, user, or runner')
  }

  return report('VISUAL_APPROVAL_INVALID', errors, {
    actor: actor || null,
    review_tool: reviewTool || null,
    reviewed_count: Number.isInteger(reviewedCount) ? reviewedCount : null,
    expected_reviewed_count: Number.isInteger(expectedCount) ? expectedCount : null,
    artifact_sha256: actualArtifactSha256,
  })
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
  expectedTextLayers,
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
  if (nativeResult.textPresentationVersion !== 'dharma-text-v5') {
    errors.push(`Unexpected text presentation version: ${nativeResult.textPresentationVersion}`)
  }
  if (nativeResult.subtitlePreset !== 'ink-read-v2') {
    errors.push(`Unexpected subtitle preset: ${nativeResult.subtitlePreset}`)
  }
  // dharma-text-v5：plate 底片模式必须显式声明 textLayers='overlay'，
  // 缺省（burned 全层产物）不允许混入叠加链路。
  if (expectedTextLayers !== undefined && nativeResult.textLayers !== expectedTextLayers) {
    errors.push(`Unexpected text layers mode: ${nativeResult.textLayers}`)
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
    duration_frames: Number(nativeResult.durationFrames),
    props_sha256: nativeResult.propsSha256 || null,
    output_sha256: deliverySha256,
    delivery_bytes: deliveryBytes,
  }, nativeResult)
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
      && Math.abs(videoDurationSec - audioDurationSec) > 0.5) {
      block('AUDIO_VIDEO_DURATION_MISMATCH', 'Audio and video stream durations are out of sync', {
        videoDurationSec,
        audioDurationSec,
        toleranceSec: 0.5,
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
  } else if (integratedLufs <= -70) {
    block('LOUDNESS_TOO_QUIET', 'Delivery is effectively silent; narration or mix is missing', { integratedLufs })
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
