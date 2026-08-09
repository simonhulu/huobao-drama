import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`)
  return result.stdout
}

function runCombined(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`)
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('native renderer rejects props without the explicit overlay text-layer contract', () => {
  const root = resolve(import.meta.dirname, '../..')
  const work = mkdtempSync(join(tmpdir(), 'dharma-native-text-contract-'))
  try {
    const props = join(work, 'props.json')
    writeFileSync(props, JSON.stringify({
      variant: 'progressive_five',
      durationInFrames: 30,
      textPresentationVersion: 'dharma-text-v5',
      subtitlePreset: 'ink-read-v2',
      panels: [{ emphasisStartFrame: 0, src: 'missing-panel.png' }],
    }))
    const rejected = spawnSync('node', [
      join(root, 'scripts/videoeditor/dharma_comic_native_renderer.mjs'),
      '--props', props,
      '--output', join(work, 'delivery.mp4'),
      '--work-dir', join(work, 'render'),
    ], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /requires textLayers=['"]overlay['"]/u,
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('native renderer preserves every delivery frame and mixes emphasis SFX', () => {
  const root = resolve(import.meta.dirname, '../..')
  const work = mkdtempSync(join(tmpdir(), 'dharma-native-renderer-'))
  try {
    const image = join(work, 'panel.svg')
    const audio = join(work, 'narration.wav')
    const props = join(work, 'props.json')
    const output = join(work, 'delivery.mp4')
    writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#b9924b"/><circle cx="640" cy="360" r="180" fill="#080d12"/></svg>')
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'anullsrc=r=48000:cl=stereo', '-t', '5', '-c:a', 'pcm_s16le', audio,
    ])
    writeFileSync(props, JSON.stringify({
      variant: 'progressive_five',
      durationInFrames: 150,
      fps: 30,
      width: 1280,
      height: 720,
      audio,
      audioStartFrame: 0,
      narrationEndFrame: 150,
      narrationWindows: [{ startFrame: 0, endFrame: 150 }],
      textPresentationVersion: 'dharma-text-v5',
      subtitlePreset: 'ink-read-v2',
      textLayers: 'overlay',
      subtitles: [{
        text: '缘起性空，是理解这件事的钥匙。',
        startSec: 0,
        endSec: 3,
        displayStartSec: 0,
        displayEndSec: 3.04,
        subtitleKeywords: ['钥匙'],
      }, {
        text: '可是锅从来不会自己端起来。',
        startSec: 2.94,
        endSec: 4.5,
        displayStartSec: 2.94,
        displayEndSec: 4.85,
        subtitleKeywords: [],
      }],
      quotes: [{
        panelKey: 'p_001',
        kind: 'theme',
        text: '缘起性空',
        startFrame: 10,
        durationInFrames: 50,
        animationPreset: 'glyph-reveal-v1',
        sfxPreset: 'low-temple-bell-v1',
      }],
      panels: [{
        src: image,
        focusX: 50,
        focusY: 50,
        emphasisStartFrame: 0,
        bubble: { kind: 'caption', text: '三十帧完整', x: 10, y: 10 },
      }],
    }))
    run('node', [
      join(root, 'scripts/videoeditor/dharma_comic_native_renderer.mjs'),
      '--props', props,
      '--output', output,
      '--work-dir', join(work, 'render'),
    ])
    const probe = JSON.parse(run('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames,nb_read_frames,has_b_frames,avg_frame_rate', '-of', 'json', output,
    ]))
    assert.equal(Number(probe.streams[0].nb_frames), 150)
    assert.equal(Number(probe.streams[0].nb_read_frames), 150)
    assert.equal(Number(probe.streams[0].has_b_frames), 0)
    const [rateNumerator, rateDenominator] = probe.streams[0].avg_frame_rate.split('/').map(Number)
    assert.ok(Math.abs(rateNumerator / rateDenominator - 30) <= 0.001)
    const decoded = JSON.parse(run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', output,
    ])).frames
    assert.equal(decoded.length, 150)
    decoded.forEach((frame, index) => {
      assert.ok(
        Math.abs(Number(frame.best_effort_timestamp_time) - index / 30) < 0.00005,
        `decoded frame ${index} has timestamp ${frame.best_effort_timestamp_time}`,
      )
    })
    const result = JSON.parse(readFileSync(join(work, 'render/result.json'), 'utf8'))
    assert.equal(result.renderer, 'native-comic-v12')
    assert.equal(result.videoEncoder, 'h264_videotoolbox')
    assert.equal(result.textLayers, 'overlay')
    assert.equal(result.textPresentationVersion, 'dharma-text-v5')
    assert.equal(result.subtitlePreset, 'ink-read-v2')
    assert.equal(result.sfxEventCount, 1)
    assert.ok(result.sfxMaxDurationSec < 0.4)
    assert.ok((-16) - result.sfxMeasuredLufs >= 24)
    assert.equal(result.motionMode, 'perspective-linear')
    assert.match(result.propsSha256, /^[0-9a-f]{64}$/)
    assert.equal(result.propsSha256, fileSha256(props))
    assert.match(result.outputSha256, /^[0-9a-f]{64}$/)
    assert.equal(result.outputSha256, fileSha256(output))
    assert.equal(result.outputBytes, statSync(output).size)
    assert.equal(result.verifiedDeliveryFrames, 150)
    assert.equal(result.verifiedHasBFrames, 0)
    const [resultRateNumerator, resultRateDenominator] = result.verifiedAverageFrameRate.split('/').map(Number)
    assert.ok(Math.abs(resultRateNumerator / resultRateDenominator - 30) <= 0.001)
    const intervalAssets = readdirSync(join(work, 'render/interval-000'))
    // Production plate contract: subtitle/emphasis pixels are rendered by
    // Remotion DharmaTextOverlay, so native only keeps page and bubble assets.
    assert.ok(intervalAssets.includes('state.png'))
    assert.ok(intervalAssets.includes('bubble.png'))
    assert.ok(!intervalAssets.some((name) => name.startsWith('subtitle-')))
    assert.ok(!intervalAssets.some((name) => name.startsWith('emphasis-')))
    assert.ok(!intervalAssets.some((name) => name.includes('-pose-')))

    const eventRms = runCombined('ffmpeg', [
      '-hide_banner', '-nostats', '-ss', '0.35', '-t', '0.8', '-i', output,
      '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-',
    ])
    assert.match(eventRms, /RMS level dB:/u)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('perspective-linear motion changes every decoded frame in both directions', () => {
  const root = resolve(import.meta.dirname, '../..')
  const filters = spawnSync('node', ['--input-type=module', '-e', `
    import {motionFilter} from './scripts/videoeditor/dharma_comic_native_core.mjs';
    process.stdout.write(JSON.stringify([0, 1].map((index) => motionFilter('perspective-linear', index, 90, '0:v', 'v'))));
  `], { cwd: root, encoding: 'utf8' })
  assert.equal(filters.status, 0, filters.stderr)
  for (const filter of JSON.parse(filters.stdout)) {
    const rendered = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1300x732:rate=30',
      '-frames:v', '45', '-filter_complex', filter, '-map', '[v]', '-f', 'framemd5', '-',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert.equal(rendered.status, 0, rendered.stderr)
    const hashes = rendered.stdout.split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(',').at(-1).trim())
    assert.equal(hashes.length, 45)
    assert.equal(new Set(hashes).size, hashes.length)
  }
})

test('plate mode renders the base plate without subtitle or emphasis layers', () => {
  const root = resolve(import.meta.dirname, '../..')
  const work = mkdtempSync(join(tmpdir(), 'dharma-native-plate-'))
  try {
    const image = join(work, 'panel.svg')
    const audio = join(work, 'narration.wav')
    const output = join(work, 'plate.mp4')
    writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#b9924b"/><circle cx="640" cy="360" r="180" fill="#080d12"/></svg>')
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'anullsrc=r=48000:cl=stereo', '-t', '5', '-c:a', 'pcm_s16le', audio,
    ])
    const makeProps = (subtitleText) => ({
      variant: 'progressive_five',
      durationInFrames: 150,
      fps: 30,
      width: 1280,
      height: 720,
      audio,
      audioStartFrame: 0,
      narrationEndFrame: 150,
      narrationWindows: [{ startFrame: 0, endFrame: 150 }],
      textPresentationVersion: 'dharma-text-v5',
      subtitlePreset: 'ink-read-v2',
      // dharma-text-v5：plate 模式——subtitle/emphasis 文字层由 Remotion overlay 叠加。
      textLayers: 'overlay',
      subtitles: [{
        text: subtitleText,
        startSec: 0,
        endSec: 3,
        displayStartSec: 0,
        displayEndSec: 3.04,
        subtitleKeywords: ['钥匙'],
      }],
      quotes: [{
        panelKey: 'p_001',
        kind: 'theme',
        text: '缘起性空',
        startFrame: 10,
        durationInFrames: 50,
        animationPreset: 'handwrite-pose-v1',
        sfxPreset: 'low-temple-bell-v1',
      }],
      panels: [{
        src: image,
        focusX: 50,
        focusY: 50,
        emphasisStartFrame: 0,
        bubble: { kind: 'caption', text: '底片气泡', x: 10, y: 10 },
      }],
    })
    const props = join(work, 'props.json')
    writeFileSync(props, JSON.stringify(makeProps('缘起性空，是理解这件事的钥匙。')))
    const workDir = join(work, 'render')
    run('node', [
      join(root, 'scripts/videoeditor/dharma_comic_native_renderer.mjs'),
      '--props', props,
      '--output', output,
      '--work-dir', workDir,
    ])
    const probe = JSON.parse(run('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames,has_b_frames', '-of', 'json', output,
    ]))
    assert.equal(Number(probe.streams[0].nb_frames), 150)
    assert.equal(Number(probe.streams[0].has_b_frames), 0)
    const result = JSON.parse(readFileSync(join(workDir, 'result.json'), 'utf8'))
    assert.equal(result.renderer, 'native-comic-v12')
    assert.equal(result.videoEncoder, 'h264_videotoolbox')
    assert.equal(result.textLayers, 'overlay')
    assert.equal(result.textPresentationVersion, 'dharma-text-v5')
    const intervalAssets = readdirSync(join(workDir, 'interval-000'))
    // plate 契约：底片只有页面 state 与 bubble，不渲染任何 subtitle/emphasis 文字层资产。
    assert.ok(intervalAssets.includes('state.png'), 'plate keeps the page state frame')
    assert.ok(intervalAssets.includes('bubble.png'), 'bubble stays on the plate (panel content)')
    assert.ok(!intervalAssets.some((name) => name.startsWith('subtitle-')), 'plate emits no subtitle layers')
    assert.ok(!intervalAssets.some((name) => name.startsWith('emphasis-')), 'plate emits no emphasis layers')
    assert.ok(!intervalAssets.some((name) => name.includes('-pose-')), 'plate emits no handwrite poses')
    const fingerprintPath = join(workDir, 'interval-000', 'fingerprint.txt')
    const fingerprintV1 = readFileSync(fingerprintPath, 'utf8').trim()
    // plate 指纹与文字层解耦：subtitle/quote 文本变更不得使底片 interval 缓存失效
    //（文字变更走 overlayFingerprint 触发 Remotion 重渲，底片无需重出）。
    writeFileSync(props, JSON.stringify(makeProps('完全不同的一句字幕文本。')))
    run('node', [
      join(root, 'scripts/videoeditor/dharma_comic_native_renderer.mjs'),
      '--props', props,
      '--output', output,
      '--work-dir', workDir,
    ])
    const fingerprintV2 = readFileSync(fingerprintPath, 'utf8').trim()
    assert.equal(fingerprintV2, fingerprintV1, 'plate interval fingerprint is decoupled from text layers')
    // 非法 textLayers 值显式失败，不静默回退。
    writeFileSync(props, JSON.stringify({ ...makeProps('x'), textLayers: 'mystery' }))
    const rejected = spawnSync('node', [
      join(root, 'scripts/videoeditor/dharma_comic_native_renderer.mjs'),
      '--props', props,
      '--output', output,
      '--work-dir', join(work, 'render-rejected'),
    ], { encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /requires textLayers=['"]overlay['"]/u,
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
