import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  validateEnvironment,
  validateManifest,
  validateNativeResult,
  validatePanelAssets,
  validateTtsClone,
  validateTtsTimeline,
  validateVisualApproval,
} from './dharma_comic_validator.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function validManifest() {
  const emphasis = [
    { text: '缘起性空', kind: 'theme' },
    { text: '色即是空', kind: 'scripture', source: '《心经》' },
    { text: '看清执着', kind: 'explanation' },
  ]
  const narration = [
    '缘起性空，是理解这件事的钥匙。',
    '《心经》说，色即是空。',
    '这不是让你逃避，而是看清执着。',
    '第4句旁白',
    '第5句旁白',
  ]
  return {
    version: 1,
    textEmphasisVersion: 1,
    episodeId: 10,
    dramaId: 20,
    targetDurationSec: 50,
    fps: 30,
    width: 1280,
    height: 720,
    model: 'gpt-image-2',
    configId: 80,
    stylePreset: 'retro-anime-1980s',
    deliveryOutput: 'data/static/remotion/test.mp4',
    panels: Array.from({ length: 5 }, (_, index) => ({
      key: `p_${String(index + 1).padStart(3, '0')}`,
      startSec: index * 10,
      narrationText: narration[index],
      ttsTitleStart: index,
      ttsTitleEnd: index,
      visualProposition: `第${index + 1}格可见命题`,
      semantic: {
        subject_count: 1,
        subjects: '一名成年人',
        relationship: '人与当前处境',
        action: '完成一个具体动作',
        visible_emotion: '克制',
        visual_evidence: '手部动作和空间距离',
      },
      prompt: `Unique panel ${index + 1}`,
      referencePanelKeys: [],
      ...(emphasis[index] ? { quote: emphasis[index] } : {}),
    })),
  }
}

test('environment and TTS validators pass complete fixed-profile evidence', () => {
  const environment = validateEnvironment({
    api_health_ok: true,
    worker_count: 3,
    ffmpeg_ok: true,
    h264_videotoolbox_ok: true,
    ffprobe_ok: true,
    remotion_ok: true,
    native_renderer_ok: true,
    media_account: { id: 3 },
    image_config: { id: 80, provider: 'pcore', active: true, models: ['gpt-image-2'] },
    bgm: { exists: true, duration_sec: 210 },
    voice: {
      id: 'ttv-voice-2026072016212326-TinwAgRr',
      provider: 'minimax',
      voice_provider: 'minimax',
      exists: true,
    },
  })
  assert.equal(environment.passed, true)

  const clone = validateTtsClone({
    expectedVoiceKey: 'ttv-voice-2026072016212326-TinwAgRr',
    currentVoiceKey: 'ttv-voice-2026072016212326-TinwAgRr',
    provider: 'minimax',
  })
  assert.equal(clone.passed, true)

  const timeline = validateTtsTimeline({
    titles: [
      { text: '第一句', time_begin: 0, time_end: 4000 },
      { text: '第二句', time_begin: 4200, time_end: 9000 },
    ],
    audioDurationSec: 9.2,
    targetDurationSec: 10,
  })
  assert.equal(timeline.passed, true)
})

test('manifest validator owns fixed run identity and creative completeness', () => {
  const manifest = validManifest()
  const report = validateManifest(manifest, {
    expectedEpisodeId: 10,
    expectedDramaId: 20,
    expectedConfigId: 80,
    expectedTargetDurationSec: 50,
    expectedDeliveryOutput: 'data/static/remotion/test.mp4',
  })
  assert.equal(report.passed, true)

  manifest.episodeId = 11
  const mismatch = validateManifest(manifest, { expectedEpisodeId: 10 })
  assert.equal(mismatch.passed, false)
  assert.ok(mismatch.checks.errors.includes('manifest.episodeId does not match the production run'))
})

test('text emphasis contract requires one theme and typed scripture and explanation events', () => {
  const valid = validateManifest(validManifest())
  assert.equal(valid.passed, true)
  assert.deepEqual(valid.data.emphasis_counts, {
    theme: 1,
    scripture: 1,
    explanation: 1,
  })

  const missingTheme = validManifest()
  missingTheme.panels[0].quote.kind = 'explanation'
  const missingThemeReport = validateManifest(missingTheme)
  assert.equal(missingThemeReport.passed, false)
  assert.ok(missingThemeReport.checks.errors.includes('textEmphasisVersion 1 requires exactly one theme quote'))

  const duplicateTheme = validManifest()
  duplicateTheme.panels[2].quote.kind = 'theme'
  const duplicateThemeReport = validateManifest(duplicateTheme)
  assert.equal(duplicateThemeReport.passed, false)
  assert.ok(duplicateThemeReport.checks.errors.includes('textEmphasisVersion 1 requires exactly one theme quote'))

  const missingSource = validManifest()
  delete missingSource.panels[1].quote.source
  const missingSourceReport = validateManifest(missingSource)
  assert.equal(missingSourceReport.passed, false)
  assert.ok(missingSourceReport.checks.errors.includes('Panel p_002 scripture quote requires a source'))

  const untyped = validManifest()
  delete untyped.panels[2].quote.kind
  const untypedReport = validateManifest(untyped)
  assert.equal(untypedReport.passed, false)
  assert.ok(untypedReport.checks.errors.includes('Panel p_003 quote.kind must be theme, scripture, or explanation'))
})

test('legacy frozen manifests remain readable so recovery can rebuild only downstream artifacts', () => {
  const legacy = validManifest()
  delete legacy.textEmphasisVersion
  for (const panel of legacy.panels) {
    if (panel.quote) delete panel.quote.kind
  }
  const report = validateManifest(legacy)
  assert.equal(report.passed, true)
  assert.equal(report.data.legacy_text_emphasis, true)
})

test('manifest validator requires exact frozen beat skeleton identity', () => {
  const manifest = validManifest()
  const expectedBeats = manifest.panels.map((panel) => ({
    key: panel.key,
    startSec: panel.startSec,
    narrationText: panel.narrationText,
    ttsTitleStart: panel.ttsTitleStart,
    ttsTitleEnd: panel.ttsTitleEnd,
  }))

  const report = validateManifest(manifest, { expectedBeats })
  assert.equal(report.passed, true)

  const changedText = validManifest()
  changedText.panels[2].narrationText = '偷偷改过的旁白'
  const textMismatch = validateManifest(changedText, { expectedBeats })
  assert.equal(textMismatch.passed, false)
  assert.ok(textMismatch.checks.errors.includes('Panel p_003 narrationText does not match the frozen beat skeleton'))

  const changedTtsRange = validManifest()
  changedTtsRange.panels[2].ttsTitleStart = 1
  const rangeMismatch = validateManifest(changedTtsRange, { expectedBeats })
  assert.equal(rangeMismatch.passed, false)
  assert.ok(rangeMismatch.checks.errors.includes('Panel p_003 TTS title range does not match the frozen beat skeleton'))

  const missingBeat = validManifest()
  missingBeat.panels.pop()
  const countMismatch = validateManifest(missingBeat, { expectedBeats })
  assert.equal(countMismatch.passed, false)
  assert.ok(countMismatch.checks.errors.includes('Manifest panel count does not match the frozen beat skeleton'))
})

test('manifest validator reports malformed reference collections instead of throwing', () => {
  const manifest = validManifest()
  manifest.panels[1].referencePanelKeys = { key: 'p_001' }
  manifest.panels[2].referenceImages = 'static/images/reference.png'

  const report = validateManifest(manifest)

  assert.equal(report.passed, false)
  assert.ok(report.checks.errors.includes('Panel p_002 referencePanelKeys must be an array'))
  assert.ok(report.checks.errors.includes('Panel p_003 referenceImages must be an array'))
})

test('asset validator fingerprints every panel and rejects duplicate content', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-assets-'))
  const manifest = validManifest()
  const state = { jobs: [] }
  for (const [index, panel] of manifest.panels.entries()) {
    const path = join(temp, `${panel.key}.png`)
    writeFileSync(path, `asset-${index}`)
    state.jobs.push({ key: panel.key, localPath: path })
  }
  const options = {
    resolveAssetPath: (path) => path,
    statFile: statSync,
    hashFile: (path) => sha256(readFileSync(path)),
    hashValue: sha256,
  }
  const unique = validatePanelAssets(manifest, state, options)
  assert.equal(unique.passed, true)
  assert.equal(unique.data.assets.length, 5)

  options.hashFile = () => 'same-hash'
  const duplicate = validatePanelAssets(manifest, state, options)
  assert.equal(duplicate.passed, false)
  assert.match(duplicate.checks.errors[0], /identical image content/u)
})

test('visual approval requires current bytes, complete review count, and an auditable review surface', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-visual-approval-'))
  const sheetPath = join(temp, 'sheet.jpg')
  writeFileSync(sheetPath, 'review-sheet-v1')
  const artifactSha256 = sha256(readFileSync(sheetPath))
  const approval = {
    artifactSha256,
    actor: 'agent',
    reviewTool: 'view_image',
    reviewedCount: 70,
    reason: '逐格检查七十格，人物关系、动作、表情和连续性均可直接辨认。',
  }
  const options = {
    artifactPath: sheetPath,
    expectedArtifactSha256: artifactSha256,
    expectedReviewedCount: 70,
  }

  assert.equal(validateVisualApproval({ approval, ...options }).passed, true)
  assert.equal(validateVisualApproval({
    approval: { ...approval, reviewTool: 'sha256-only' },
    ...options,
  }).passed, false)
  assert.equal(validateVisualApproval({
    approval: { ...approval, reviewedCount: 69 },
    ...options,
  }).passed, false)

  writeFileSync(sheetPath, 'review-sheet-v2')
  assert.equal(validateVisualApproval({ approval, ...options }).passed, false)
})

test('native-result validator accepts only the fixed renderer, output, and frame count', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-native-'))
  const deliveryPath = join(temp, 'delivery.mp4')
  const nativeResultPath = join(temp, 'result.json')
  writeFileSync(deliveryPath, 'delivery')
  const outputSha256 = sha256(readFileSync(deliveryPath))
  const outputBytes = statSync(deliveryPath).size
  writeFileSync(nativeResultPath, JSON.stringify({
    renderer: 'native-comic-v12',
    output: deliveryPath,
    durationFrames: 300,
    propsSha256: 'props-hash',
    outputSha256,
    outputBytes,
    textPresentationVersion: 'dharma-text-v5',
    subtitlePreset: 'ink-read-v2',
    videoEncoder: 'h264_videotoolbox',
    audioMixVersion: 'native-audio-v2-bgm-target',
    sfxEventCount: 2,
    sfxMaxDurationSec: 0.38,
    sfxMeasuredLufs: -42,
  }))
  const report = validateNativeResult({
    nativeResultPath,
    deliveryPath,
    expectedFrames: 300,
    expectedPropsSha256: 'props-hash',
    expectedSfxEventCount: 2,
    expectedNarrationLufs: -16,
  })
  assert.equal(report.passed, true)
})

test('native-result validator rejects missing props contract and stale output fingerprint', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-native-'))
  const deliveryPath = join(temp, 'delivery.mp4')
  const nativeResultPath = join(temp, 'result.json')
  writeFileSync(deliveryPath, 'delivery-v2')
  writeFileSync(nativeResultPath, JSON.stringify({
    renderer: 'native-comic-v11',
    output: deliveryPath,
    durationFrames: 300,
    propsSha256: 'old-props',
    outputSha256: sha256('delivery-v1'),
    outputBytes: 10,
    textPresentationVersion: 'dharma-text-v1',
    subtitlePreset: 'legacy-bottom-v0',
    sfxEventCount: 1,
  }))

  const missingExpected = validateNativeResult({ nativeResultPath, deliveryPath, expectedFrames: 300 })
  assert.equal(missingExpected.passed, false)
  assert.ok(missingExpected.checks.errors.includes('Expected props SHA-256 is required'))

  const mismatch = validateNativeResult({
    nativeResultPath,
    deliveryPath,
    expectedFrames: 300,
    expectedPropsSha256: 'expected-props',
    expectedTextLayers: 'overlay',
  })
  assert.equal(mismatch.passed, false)
  assert.ok(mismatch.checks.errors.includes('Native renderer props SHA-256 does not match the frozen props'))
  assert.ok(mismatch.checks.errors.includes('Unexpected native video encoder: missing'))
  assert.ok(mismatch.checks.errors.includes('Unexpected text layers mode: missing'))
  assert.ok(mismatch.checks.errors.includes('Native renderer output SHA-256 does not match the delivery file'))
  assert.ok(mismatch.checks.errors.includes('Native renderer output byte count does not match the delivery file'))
  assert.ok(mismatch.checks.errors.includes('Unexpected subtitle preset: legacy-bottom-v0'))
})

test('TTS timeline rejects materially incomplete title coverage near the audio tail', () => {
  const report = validateTtsTimeline({
    titles: [
      { text: '第一句', time_begin: 0, time_end: 4000 },
      { text: '第二句', time_begin: 4200, time_end: 6200 },
    ],
    audioDurationSec: 10,
    targetDurationSec: 10,
  })

  assert.equal(report.passed, false)
  assert.ok(report.checks.errors.some((error) => error.includes('ends too far before audio ends')))
})

test('TTS timeline allows a small encoder tail after the final title', () => {
  const report = validateTtsTimeline({
    titles: [
      { text: '第一句', time_begin: 0, time_end: 4000 },
      { text: '第二句', time_begin: 4200, time_end: 9800 },
    ],
    audioDurationSec: 10,
    targetDurationSec: 10,
  })

  assert.equal(report.passed, true)
})
