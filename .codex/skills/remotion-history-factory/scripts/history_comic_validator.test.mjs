import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assessDeliveryQuality,
  extractFfmpegWarnings,
  fractionValue,
  manifestContract,
  manifestFactory,
  minHistoryBgmSec,
  parseBlackIntervals,
  parseProgressFrameCount,
  storyboardIdFromPanelKey,
  validateEnvironment,
  validateEpisodeSnapshot,
  validateManifest,
  validateNarrativePlan,
  validateNativeResult,
  validatePanelAssets,
  validateTtsTimeline,
  validateVisualApproval,
} from './history_comic_validator.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sha256File = (path) => sha256(readFileSync(path))

function validManifest(overrides = {}) {
  return {
    contract: manifestContract,
    factory: manifestFactory,
    episodeId: 7,
    dramaId: 3,
    targetDurationSec: 30,
    narrationEndSec: 28.5,
    panels: [0, 1, 2, 3, 4].map((index) => ({
      key: `sb-${11 + index}`,
      src: `static/grid/ep7/panel-${index}.png`,
      startSec: index * 6,
      endSec: (index + 1) * 6,
      ttsTitleStart: index * 2,
      ttsTitleEnd: index * 2 + 1,
    })),
    ...overrides,
  }
}

const validOptions = {
  expectedEpisodeId: 7,
  expectedDramaId: 3,
  expectedTitleCount: 10,
  expectedNarrationEndSec: 28.5,
}

test('valid manifest passes the independent validator', () => {
  const report = validateManifest(validManifest(), validOptions)
  assert.equal(report.passed, true)
  assert.equal(report.error_code, null)
  assert.deepEqual(report.checks.errors, [])
  assert.equal(report.data.panel_count, 5)
  assert.deepEqual(report.data.storyboard_ids, [11, 12, 13, 14, 15])
})

test('manifest rejects contract, factory, and identity defects', () => {
  assert.equal(validateManifest(validManifest({ contract: 'other' }), validOptions).passed, false)
  assert.match(validateManifest(validManifest({ contract: 'other' }), validOptions).checks.errors[0], /contract/u)
  assert.equal(validateManifest(validManifest({ factory: 'other' }), validOptions).passed, false)
  assert.equal(validateManifest(null, validOptions).passed, false)
  assert.equal(validateManifest(validManifest(), { ...validOptions, expectedEpisodeId: 8 }).passed, false)
  assert.equal(validateManifest(validManifest(), { ...validOptions, expectedDramaId: 9 }).passed, false)
  assert.equal(validateManifest(validManifest(), { ...validOptions, expectedNarrationEndSec: 20 }).passed, false)
})

test('manifest rejects fewer than five panels and malformed keys', () => {
  const fourPanels = validManifest()
  fourPanels.panels = fourPanels.panels.slice(0, 4)
  assert.equal(validateManifest(fourPanels, validOptions).passed, false)

  const badKey = validManifest()
  badKey.panels[0].key = 'panel-1'
  const report = validateManifest(badKey, validOptions)
  assert.equal(report.passed, false)
  assert.ok(report.checks.errors.some((error) => error.includes('sb-<storyboardId>')))

  const mismatchedId = validManifest()
  mismatchedId.panels[0].storyboardId = 99
  assert.equal(validateManifest(mismatchedId, validOptions).passed, false)
})

test('manifest rejects duplicate keys and duplicate sources', () => {
  const duplicateKey = validManifest()
  duplicateKey.panels[1].key = duplicateKey.panels[0].key
  assert.equal(validateManifest(duplicateKey, validOptions).passed, false)

  const duplicateSrc = validManifest()
  duplicateSrc.panels[1].src = duplicateSrc.panels[0].src
  const report = validateManifest(duplicateSrc, validOptions)
  assert.equal(report.passed, false)
  assert.ok(report.checks.errors.some((error) => error.includes('Asset reuse is forbidden')))
})

test('manifest enforces monotonic windows with a 500ms overlap tolerance', () => {
  const overlap = validManifest()
  overlap.panels[2].startSec = 11.0 // previous end is 12.0: overlap 1.0s > 0.5s
  const overlapReport = validateManifest(overlap, validOptions)
  assert.equal(overlapReport.passed, false)
  assert.ok(overlapReport.checks.errors.some((error) => error.includes('overlaps the previous panel')))

  const tolerated = validManifest()
  tolerated.panels[2].startSec = 11.6 // overlap 0.4s <= 0.5s
  assert.equal(validateManifest(tolerated, validOptions).passed, true)

  const notIncreasing = validManifest()
  notIncreasing.panels[2].startSec = 6 // equals panels[1].startSec
  assert.equal(validateManifest(notIncreasing, validOptions).passed, false)

  const lateFirst = validManifest()
  lateFirst.panels[0].startSec = 1
  const lateReport = validateManifest(lateFirst, validOptions)
  assert.equal(lateReport.passed, false)
  assert.ok(lateReport.checks.errors.some((error) => error.includes('first panel must start at 0')))

  const pastDuration = validManifest()
  pastDuration.panels[4].endSec = 31 // > 30 + 0.5
  assert.equal(validateManifest(pastDuration, validOptions).passed, false)
})

test('manifest enforces tts title bounds and the 0-3s narration tail', () => {
  const outOfBounds = validManifest()
  outOfBounds.panels[4].ttsTitleEnd = 10
  assert.equal(validateManifest(outOfBounds, validOptions).passed, false)

  const inverted = validManifest()
  inverted.panels[0].ttsTitleStart = 5
  inverted.panels[0].ttsTitleEnd = 2
  assert.equal(validateManifest(inverted, validOptions).passed, false)

  assert.equal(validateManifest(validManifest({ targetDurationSec: 32 }), validOptions).passed, false)
  assert.equal(validateManifest(validManifest({ targetDurationSec: 28 }), validOptions).passed, false)
  assert.equal(validateManifest(validManifest({ targetDurationSec: 31.5 }), validOptions).passed, true)

  const emptySrc = validManifest()
  emptySrc.panels[0].src = '  '
  assert.equal(validateManifest(emptySrc, validOptions).passed, false)

  const badFocus = validManifest()
  badFocus.panels[0].focusX = 120
  assert.equal(validateManifest(badFocus, validOptions).passed, false)
})

test('storyboardIdFromPanelKey parses sb-<id>[-pN]', () => {
  assert.equal(storyboardIdFromPanelKey('sb-12'), 12)
  assert.equal(storyboardIdFromPanelKey('sb-12-p3'), 12)
  assert.equal(storyboardIdFromPanelKey('panel-12'), null)
  assert.equal(storyboardIdFromPanelKey('sb-'), null)
  assert.equal(storyboardIdFromPanelKey(''), null)
})

test('narrative plan validator requires a real full plan with full beat coverage', () => {
  const good = validateNarrativePlan({
    plan: { id: 1, kind: 'full', timing_source: 'tts_master' },
    beatCoverage: 5,
    storyboardCount: 5,
  })
  assert.equal(good.passed, true)

  assert.equal(validateNarrativePlan({ plan: null, beatCoverage: 5, storyboardCount: 5 }).passed, false)
  assert.equal(validateNarrativePlan({
    plan: { id: 1, kind: 'full', timing_source: 'storyboard_grid_fallback' },
    beatCoverage: 5,
    storyboardCount: 5,
  }).passed, false)
  assert.equal(validateNarrativePlan({
    plan: { id: 1, kind: 'teaser', timing_source: 'tts_master' },
    beatCoverage: 5,
    storyboardCount: 5,
  }).passed, false)
  assert.equal(validateNarrativePlan({
    plan: { id: 1, kind: 'full', timing_source: 'tts_master' },
    beatCoverage: 4,
    storyboardCount: 5,
  }).passed, false)
  assert.equal(validateNarrativePlan({
    plan: { id: 1, kind: 'full', timing_source: 'tts_master' },
    beatCoverage: 0,
    storyboardCount: 0,
  }).passed, false)
})

function healthyEnvironment(overrides = {}) {
  return {
    api_health_ok: true,
    worker_count: 2,
    ffmpeg_ok: true,
    ffprobe_ok: true,
    native_renderer_ok: true,
    font_sans_ok: true,
    font_serif_ok: true,
    sync_checker_ok: true,
    bgm: { exists: true, duration_sec: minHistoryBgmSec },
    ...overrides,
  }
}

test('environment validator enforces tools, workers, and the 30s BGM floor', () => {
  assert.equal(validateEnvironment(healthyEnvironment()).passed, true)
  assert.equal(validateEnvironment({}).error_code, 'ENVIRONMENT_INVALID')
  assert.equal(validateEnvironment(healthyEnvironment({ worker_count: 0 })).passed, false)
  assert.equal(validateEnvironment(healthyEnvironment({ ffmpeg_ok: false })).passed, false)
  assert.equal(validateEnvironment(healthyEnvironment({ sync_checker_ok: false })).passed, false)
  assert.equal(validateEnvironment(healthyEnvironment({ bgm: { exists: true, duration_sec: 29.9 } })).passed, false)
  assert.equal(validateEnvironment(healthyEnvironment({ bgm: { exists: true, duration_sec: 30 } })).passed, true)
  assert.equal(validateEnvironment(healthyEnvironment({ bgm: { exists: false, duration_sec: 60 } })).passed, false)
})

test('episode snapshot validator locks drama ownership and series style', () => {
  const good = validateEpisodeSnapshot({
    episode: { id: 7, drama_id: 3, workflow_type: 'direct_script', script_content: '测试稿件' },
    drama: { id: 3, style: 'ink-wash' },
  })
  assert.equal(good.passed, true)
  assert.equal(validateEpisodeSnapshot({ episode: null, drama: null }).passed, false)
  assert.equal(validateEpisodeSnapshot({
    episode: { id: 7, drama_id: 4, workflow_type: 'direct_script', script_content: '测试稿件' },
    drama: { id: 3, style: 'ink-wash' },
  }).passed, false)
  const noStyle = validateEpisodeSnapshot({
    episode: { id: 7, drama_id: 3, workflow_type: 'direct_script', script_content: '测试稿件' },
    drama: { id: 3, style: '  ' },
  })
  assert.equal(noStyle.passed, false)
  assert.match(noStyle.checks.errors.join(' '), /visual profile/u)
})

test('episode snapshot validator requires a direct_script episode with a manuscript', () => {
  const notDirect = validateEpisodeSnapshot({
    episode: { id: 7, drama_id: 3, workflow_type: 'story_rewrite', script_content: '测试稿件' },
    drama: { id: 3, style: 'ink-wash' },
  })
  assert.equal(notDirect.passed, false)
  assert.equal(notDirect.error_code, 'EPISODE_SNAPSHOT_INVALID')
  assert.match(notDirect.checks.errors.join(' '), /not direct_script/u)
  assert.match(notDirect.checks.errors.join(' '), /can never pass tts_verify/u)

  const emptyScript = validateEpisodeSnapshot({
    episode: { id: 7, drama_id: 3, workflow_type: 'direct_script', script_content: '  ' },
    drama: { id: 3, style: 'ink-wash' },
  })
  assert.equal(emptyScript.passed, false)
  assert.match(emptyScript.checks.errors.join(' '), /script_content is empty/u)

  const missingFields = validateEpisodeSnapshot({
    episode: { id: 7, drama_id: 3 },
    drama: { id: 3, style: 'ink-wash' },
  })
  assert.equal(missingFields.passed, false)
  assert.equal(missingFields.checks.workflow_type, null)
  assert.equal(missingFields.checks.has_script, false)
})

function titlesFromWindows(windows) {
  return windows.map(([begin, end], index) => ({ text: `第${index + 1}句`, time_begin: begin, time_end: end }))
}

test('tts timeline validator enforces the 0.60-1.05 coverage band', () => {
  const titles = titlesFromWindows([[0, 6000]])
  assert.equal(validateTtsTimeline({ titles, audioDurationSec: 10 }).passed, true) // 0.60 edge
  assert.equal(validateTtsTimeline({ titles, audioDurationSec: 10.2 }).passed, false) // 0.588
  const longTitles = titlesFromWindows([[0, 10500]])
  assert.equal(validateTtsTimeline({ titles: longTitles, audioDurationSec: 10 }).passed, true) // 1.05 edge
  const tooLong = titlesFromWindows([[0, 10600]])
  assert.equal(validateTtsTimeline({ titles: tooLong, audioDurationSec: 10 }).passed, false) // 1.06
})

test('tts timeline validator rejects overlap, empty text, and bad tails', () => {
  const overlap = validateTtsTimeline({
    titles: [
      { text: '一', time_begin: 0, time_end: 5000 },
      { text: '二', time_begin: 4000, time_end: 9000 },
    ],
    audioDurationSec: 10,
  })
  assert.equal(overlap.passed, false)
  assert.ok(overlap.checks.errors.some((error) => error.includes('overlaps')))

  assert.equal(validateTtsTimeline({
    titles: [{ text: '  ', time_begin: 0, time_end: 5000 }],
    audioDurationSec: 10,
  }).passed, false)
  assert.equal(validateTtsTimeline({ titles: [], audioDurationSec: 10 }).passed, false)
  assert.equal(validateTtsTimeline({
    titles: titlesFromWindows([[0, 10000]]),
    audioDurationSec: 10,
    targetDurationSec: 13.5,
  }).passed, false)
  assert.equal(validateTtsTimeline({
    titles: titlesFromWindows([[0, 10000]]),
    audioDurationSec: 10,
    targetDurationSec: 12,
  }).passed, true)
  assert.equal(validateTtsTimeline({
    titles: titlesFromWindows([[0, 10000]]),
    audioDurationSec: 10,
    targetDurationSec: 9,
  }).passed, false)
})

function panelAssetOptions(temp) {
  return {
    resolveAssetPath: (source) => {
      const path = join(temp, source)
      return path
    },
    statFile: statSync,
    hashFile: sha256File,
    hashValue: sha256,
  }
}

test('panel assets must exist, be non-empty, and carry unique content', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-panel-assets-'))
  writeFileSync(join(temp, 'a.png'), 'image-a')
  writeFileSync(join(temp, 'b.png'), 'image-b')
  writeFileSync(join(temp, 'c.png'), 'image-c')
  const panels = ['a.png', 'b.png', 'c.png'].map((src, index) => ({ key: `sb-${index + 1}`, src }))

  const good = validatePanelAssets(panels, panelAssetOptions(temp))
  assert.equal(good.passed, true)
  assert.equal(good.data.assets.length, 3)
  assert.equal(typeof good.data.fingerprint, 'string')

  writeFileSync(join(temp, 'dup.png'), 'image-a')
  const duplicate = validatePanelAssets([...panels, { key: 'sb-4', src: 'dup.png' }], panelAssetOptions(temp))
  assert.equal(duplicate.passed, false)
  assert.ok(duplicate.checks.errors.some((error) => error.includes('identical image content')))

  writeFileSync(join(temp, 'empty.png'), '')
  const empty = validatePanelAssets([{ key: 'sb-1', src: 'empty.png' }], panelAssetOptions(temp))
  assert.equal(empty.passed, false)
  assert.ok(empty.checks.errors.some((error) => error.includes('empty file')))

  const missing = validatePanelAssets([{ key: 'sb-1', src: 'missing.png' }], {
    ...panelAssetOptions(temp),
    resolveAssetPath: (source) => {
      const path = join(temp, source)
      if (source === 'missing.png') throw new Error(`Asset does not exist: ${source}`)
      return path
    },
  })
  assert.equal(missing.passed, false)
  assert.ok(missing.checks.errors.some((error) => error.includes('does not exist')))
})

test('visual approval binds actor, tool, review count, and current artifact bytes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-visual-approval-'))
  const sheetPath = join(temp, 'sheet.jpg')
  writeFileSync(sheetPath, 'sheet-v1')
  const sheetSha256 = sha256File(sheetPath)
  const approval = {
    actor: 'agent',
    reviewTool: 'view_image',
    reviewedCount: 5,
    reason: '逐格检查了全部五个画面，构图与字幕可读。',
    artifactSha256: sheetSha256,
  }
  const input = () => ({ approval, artifactPath: sheetPath, expectedArtifactSha256: sheetSha256, expectedReviewedCount: 5 })
  assert.equal(validateVisualApproval(input()).passed, true)
  assert.equal(validateVisualApproval({ ...input(), approval: { ...approval, reviewedCount: 4 } }).passed, false)
  assert.equal(validateVisualApproval({ ...input(), approval: { ...approval, reviewTool: 'sha256-only' } }).passed, false)
  assert.equal(validateVisualApproval({ ...input(), approval: { ...approval, reason: '太短' } }).passed, false)
  assert.equal(validateVisualApproval({
    ...input(),
    approval: { ...approval, actor: 'user', reviewTool: 'human' },
  }).passed, true)
  assert.equal(validateVisualApproval({
    ...input(),
    approval: { ...approval, actor: 'user', reviewTool: 'view_image' },
  }).passed, false)
  assert.equal(validateVisualApproval({
    ...input(),
    approval: { ...approval, actor: 'runner', reviewTool: 'numeric' },
  }).passed, true)
  assert.equal(validateVisualApproval({
    ...input(),
    approval: { ...approval, actor: 'runner', reviewTool: 'view_image' },
  }).passed, false)
  assert.equal(validateVisualApproval({ ...input(), expectedArtifactSha256: 'f'.repeat(64) }).passed, false)
  writeFileSync(sheetPath, 'sheet-v2')
  assert.equal(validateVisualApproval(input()).passed, false)
})

function nativeResultFixture(temp, overrides = {}) {
  const outputPath = join(temp, 'candidate.mp4')
  writeFileSync(outputPath, 'video-bytes')
  const resultPath = join(temp, 'result.json')
  const result = {
    renderer: 'native-comic-v12',
    textPresentationVersion: 'dharma-text-v5',
    subtitlePreset: 'ink-read-v2',
    textLayers: 'overlay',
    sfxEventCount: 0,
    durationFrames: 300,
    propsSha256: 'a'.repeat(64),
    output: outputPath,
    outputSha256: sha256File(outputPath),
    outputBytes: statSync(outputPath).size,
    ...overrides,
  }
  writeFileSync(resultPath, JSON.stringify(result))
  return { resultPath, outputPath, result }
}

test('native result validator accepts a bound render and rejects tampering', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-native-result-'))
  const { resultPath, outputPath } = nativeResultFixture(temp)
  const input = () => ({
    nativeResultPath: resultPath,
    deliveryPath: outputPath,
    expectedFrames: 300,
    expectedPropsSha256: 'a'.repeat(64),
    expectedSfxEventCount: 0,
  })
  const good = validateNativeResult(input())
  assert.equal(good.passed, true)
  assert.equal(good.checks.duration_frames, 300)

  // dharma-text-v5：plate 模式显式声明 textLayers='overlay' 才通过；
  // burned 或缺省的产物不允许混入叠加链路。
  assert.equal(validateNativeResult({ ...input(), expectedTextLayers: 'overlay' }).passed, true)
  const burned = mkdtempSync(join(tmpdir(), 'history-native-burned-'))
  const burnedFixture = nativeResultFixture(burned, { textLayers: 'burned' })
  assert.equal(validateNativeResult({
    nativeResultPath: burnedFixture.resultPath,
    deliveryPath: burnedFixture.outputPath,
    expectedFrames: 300,
    expectedPropsSha256: 'a'.repeat(64),
    expectedSfxEventCount: 0,
    expectedTextLayers: 'overlay',
  }).passed, false)

  assert.equal(validateNativeResult({ ...input(), expectedFrames: 301 }).passed, false)
  assert.equal(validateNativeResult({ ...input(), expectedPropsSha256: 'b'.repeat(64) }).passed, false)
  assert.equal(validateNativeResult({ ...input(), nativeResultPath: join(temp, 'missing.json') }).passed, false)

  const tampered = mkdtempSync(join(tmpdir(), 'history-native-tampered-'))
  const fixture = nativeResultFixture(tampered, { renderer: 'native-comic-v10' })
  assert.equal(validateNativeResult({
    nativeResultPath: fixture.resultPath,
    deliveryPath: fixture.outputPath,
    expectedFrames: 300,
    expectedPropsSha256: 'a'.repeat(64),
    expectedSfxEventCount: 0,
  }).passed, false)

  const tamperedOutput = mkdtempSync(join(tmpdir(), 'history-native-output-'))
  const outputFixture = nativeResultFixture(tamperedOutput)
  writeFileSync(outputFixture.outputPath, 'different-bytes')
  assert.equal(validateNativeResult({
    nativeResultPath: outputFixture.resultPath,
    deliveryPath: outputFixture.outputPath,
    expectedFrames: 300,
    expectedPropsSha256: 'a'.repeat(64),
    expectedSfxEventCount: 0,
  }).passed, false)
})

test('delivery quality parsers handle ffmpeg output', () => {
  assert.equal(fractionValue('30/1'), 30)
  assert.ok(Number.isNaN(fractionValue('0/0')))
  assert.ok(Number.isNaN(fractionValue('')))

  const log = [
    '[blackdetect @ 0x1] black_start:1.0 black_end:2.5 black_duration:1.5',
    'black_start:1.0  black_end:2.5  black_duration:1.5',
    'black_start:5 black_end:5.4 black_duration:0.4',
  ].join('\n')
  assert.deepEqual(parseBlackIntervals(log), [
    { startSec: 1, endSec: 2.5, durationSec: 1.5 },
    { startSec: 5, endSec: 5.4, durationSec: 0.4 },
  ])
  assert.deepEqual(parseBlackIntervals(''), [])

  const warnings = extractFfmpegWarnings([
    'Past duration 0.9 too large',
    'deprecated pixel format used, make sure you did set range correctly',
    'deprecated pixel format used, make sure you did set range correctly',
    '[swscaler] warning: deprecated pixel format',
    'normal output line',
  ].join('\n'))
  assert.equal(warnings.length, 2)
  assert.ok(warnings[0].includes('deprecated'))

  assert.equal(parseProgressFrameCount('frame=1\nframe=2\nframe=300\n'), 300)
  assert.ok(Number.isNaN(parseProgressFrameCount('no frames here')))
})

function healthyDeliveryInput(overrides = {}) {
  return {
    probe: {
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
          avg_frame_rate: '30/1',
          duration: '10.0',
          has_b_frames: 0,
          bit_rate: 900_000,
        },
        { codec_type: 'audio', codec_name: 'aac', duration: '10.0' },
      ],
      format: { duration: '10.0' },
    },
    probeStatus: 0,
    expectedFrames: 300,
    expectedFps: 30,
    decodeStatus: 0,
    decodedFrames: 300,
    blackScanLog: '',
    integratedLufs: -23,
    syncStatus: 0,
    ...overrides,
  }
}

test('delivery quality accepts a healthy render', () => {
  const report = assessDeliveryQuality(healthyDeliveryInput())
  assert.equal(report.passed, true)
  assert.equal(report.failureClass, null)
  assert.deepEqual(report.blockingErrors, [])
})

test('delivery quality flags deterministic failures as non-retryable', () => {
  const wrongCodec = assessDeliveryQuality(healthyDeliveryInput({
    probe: {
      streams: [
        { codec_type: 'video', codec_name: 'vp9', width: 1280, height: 720, avg_frame_rate: '30/1', duration: '10.0' },
        { codec_type: 'audio', codec_name: 'aac', duration: '10.0' },
      ],
      format: { duration: '10.0' },
    },
  }))
  assert.equal(wrongCodec.passed, false)
  assert.equal(wrongCodec.failureClass, 'deterministic')
  assert.equal(wrongCodec.retryable, false)
  assert.ok(wrongCodec.blockingErrors.some((error) => error.code === 'WRONG_CODECS'))

  const frameMismatch = assessDeliveryQuality(healthyDeliveryInput({ decodedFrames: 299 }))
  assert.equal(frameMismatch.passed, false)
  assert.ok(frameMismatch.blockingErrors.some((error) => error.code === 'DECODED_FRAME_COUNT_MISMATCH'))

  const blackGap = assessDeliveryQuality(healthyDeliveryInput({
    blackScanLog: 'black_start:2 black_end:2.8 black_duration:0.8',
  }))
  assert.equal(blackGap.passed, false)
  assert.ok(blackGap.blockingErrors.some((error) => error.code === 'OBVIOUS_BLACK_FRAME'))

  const shortBlack = assessDeliveryQuality(healthyDeliveryInput({
    blackScanLog: 'black_start:2 black_end:2.3 black_duration:0.3',
  }))
  assert.equal(shortBlack.passed, true)
  assert.ok(shortBlack.warnings.some((warning) => warning.code === 'BLACK_FRAME_CANDIDATE'))

  const avMismatch = assessDeliveryQuality(healthyDeliveryInput({
    probe: {
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', duration: '10.0' },
        { codec_type: 'audio', codec_name: 'aac', duration: '10.6' },
      ],
      format: { duration: '10.0' },
    },
  }))
  assert.equal(avMismatch.passed, false)
  assert.ok(avMismatch.blockingErrors.some((error) => error.code === 'AUDIO_VIDEO_DURATION_MISMATCH'))

  const wrongDuration = assessDeliveryQuality(healthyDeliveryInput({
    probe: {
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '30/1', duration: '10.5' },
        { codec_type: 'audio', codec_name: 'aac', duration: '10.5' },
      ],
      format: { duration: '10.5' },
    },
  }))
  assert.equal(wrongDuration.passed, false)
  assert.ok(wrongDuration.blockingErrors.some((error) => error.code === 'WRONG_DURATION'))

  const syncFailure = assessDeliveryQuality(healthyDeliveryInput({ syncStatus: 1 }))
  assert.equal(syncFailure.passed, false)
  assert.ok(syncFailure.blockingErrors.some((error) => error.code === 'SYNC_CHECK_FAILED'))

  const tooLoud = assessDeliveryQuality(healthyDeliveryInput({ integratedLufs: -15 }))
  assert.equal(tooLoud.passed, false)
  assert.ok(tooLoud.blockingErrors.some((error) => error.code === 'LOUDNESS_OUT_OF_RANGE'))
})

test('delivery quality hard-fails on effective silence', () => {
  const silent = assessDeliveryQuality(healthyDeliveryInput({ integratedLufs: -71 }))
  assert.equal(silent.passed, false)
  assert.equal(silent.failureClass, 'deterministic')
  assert.ok(silent.blockingErrors.some((error) => error.code === 'LOUDNESS_TOO_QUIET'))
  const quietButAudible = assessDeliveryQuality(healthyDeliveryInput({ integratedLufs: -69 }))
  assert.equal(quietButAudible.passed, true)
})

test('delivery quality classifies pure tool failures as transient and retryable', () => {
  const report = assessDeliveryQuality(healthyDeliveryInput({
    probe: null,
    probeStatus: 1,
    probeToolError: 'spawnSync ffprobe ETIMEDOUT',
  }))
  assert.equal(report.passed, false)
  assert.equal(report.failureClass, 'transient')
  assert.equal(report.retryable, true)
  assert.ok(report.retryableErrors.some((error) => error.code === 'PROBE_TOOL_FAILED'))

  const mixed = assessDeliveryQuality(healthyDeliveryInput({
    probeToolError: 'spawnSync ffprobe ETIMEDOUT',
    decodedFrames: 12,
  }))
  assert.equal(mixed.failureClass, 'deterministic')
  assert.equal(mixed.retryable, false)
})
