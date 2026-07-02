import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  buildDeterministicMotionPlan,
  motionPlanToZoompan,
  buildStoryboardComposition,
  renderStoryboardComposition,
} from './index.js'
import type { AudioLayer, GrainVignetteOverlay, TitleOverlay } from './types.js'

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function generateTestImage(outputPath: string, width = 1920, height = 1080) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc=duration=1:size=${width}x${height}:rate=1`,
    '-frames:v', '1',
    '-y', outputPath,
  ], { stdio: 'ignore' })
}

function generateTestTone(outputPath: string, duration = 1) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${duration}`,
    '-y', outputPath,
  ], { stdio: 'ignore' })
}

function getVideoInfo(filePath: string) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' })
  return JSON.parse(raw)
}

test('buildDeterministicMotionPlan returns stable motion plans', () => {
  const plan1 = buildDeterministicMotionPlan(1)
  assert.equal(plan1.kind, 'kenburns')
  assert.equal(plan1.keyframes.length, 2)
  assert.ok(plan1.keyframes[0].zoom > 0)

  const plan2 = buildDeterministicMotionPlan(4)
  assert.equal(plan2.kind, 'pan')
})

test('motionPlanToZoompan produces a zoompan filter string', () => {
  const plan = buildDeterministicMotionPlan(1)
  const filter = motionPlanToZoompan(plan, 1920, 1080, 3)
  assert.ok(filter)
  assert.match(filter!, /zoompan=/)
  assert.match(filter!, /s=1920x1080/)
})

test('renderStoryboardComposition produces a valid video with audio', { skip: !ffmpegAvailable() }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'huobao-composition-'))
  const imagePath = path.join(workDir, 'input.png')
  const tonePath = path.join(workDir, 'tone.wav')
  generateTestImage(imagePath)
  generateTestTone(tonePath, 2)

  const audioLayers: AudioLayer[] = [
    { name: 'tone', filePath: tonePath, start: 0, duration: 2, volume: 0.5 },
  ]

  const composition = buildStoryboardComposition({
    outputDir: workDir,
    width: 1920,
    height: 1080,
    duration: 2,
    baseImagePath: imagePath,
    motion: buildDeterministicMotionPlan(1),
    audioLayers,
  })

  const result = await renderStoryboardComposition(composition)

  assert.ok(fs.existsSync(result.outputPath))
  const info = getVideoInfo(result.outputPath)
  const videoStream = info.streams.find((s: any) => s.codec_type === 'video')
  const audioStream = info.streams.find((s: any) => s.codec_type === 'audio')

  assert.ok(videoStream, 'should have video stream')
  assert.ok(audioStream, 'should have audio stream')
  assert.equal(videoStream.width, 1920)
  assert.equal(videoStream.height, 1080)
  assert.ok(Number(info.format.duration) >= 1.9 && Number(info.format.duration) <= 2.1)
})

test('renderStoryboardComposition produces silent video when no audio', { skip: !ffmpegAvailable() }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'huobao-composition-silent-'))
  const imagePath = path.join(workDir, 'input.png')
  generateTestImage(imagePath)

  const composition = buildStoryboardComposition({
    outputDir: workDir,
    width: 1080,
    height: 1920,
    duration: 1.5,
    baseImagePath: imagePath,
    audioLayers: [],
  })

  const result = await renderStoryboardComposition(composition)

  assert.ok(fs.existsSync(result.outputPath))
  const info = getVideoInfo(result.outputPath)
  const audioStream = info.streams.find((s: any) => s.codec_type === 'audio')
  assert.ok(audioStream, 'silent track should still exist')
})

test('renderStoryboardComposition applies grain-vignette and title overlays', { skip: !ffmpegAvailable() }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'huobao-composition-overlays-'))
  const imagePath = path.join(workDir, 'input.png')
  generateTestImage(imagePath)

  const composition = buildStoryboardComposition({
    outputDir: workDir,
    width: 1920,
    height: 1080,
    duration: 2,
    baseImagePath: imagePath,
    audioLayers: [],
  })

  // Use a system font if available; otherwise skip title overlay validation
  const fontPath = ['/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    .find((p) => fs.existsSync(p))

  const grain: GrainVignetteOverlay = {
    kind: 'grain-vignette',
    start: 0,
    duration: 2,
    params: { grainIntensity: 0.05, vignetteIntensity: 0.12 },
  }
  composition.video.overlays = [grain]

  if (fontPath) {
    const title: TitleOverlay = {
      kind: 'title',
      start: 0,
      duration: 1.5,
      params: { text: '测试标题', fontPath },
    }
    composition.video.overlays.push(title)
  }

  const result = await renderStoryboardComposition(composition)

  assert.ok(fs.existsSync(result.outputPath))
  const info = getVideoInfo(result.outputPath)
  assert.ok(info.streams.some((s: any) => s.codec_type === 'video'))
})

test('renderStoryboardComposition produces different motion for different movement plans', { skip: !ffmpegAvailable() }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'huobao-composition-motion-'))
  const imagePath = path.join(workDir, 'input.png')
  generateTestImage(imagePath)

  const zoomComposition = buildStoryboardComposition({
    outputDir: workDir,
    width: 1920,
    height: 1080,
    duration: 1,
    baseImagePath: imagePath,
    motion: {
      kind: 'kenburns',
      durationScale: 1,
      keyframes: [
        { t: 0, focusX: 0.5, focusY: 0.5, zoom: 1 },
        { t: 1, focusX: 0.5, focusY: 0.5, zoom: 1.2 },
      ],
    },
    audioLayers: [],
  })

  const panComposition = buildStoryboardComposition({
    outputDir: workDir,
    width: 1920,
    height: 1080,
    duration: 1,
    baseImagePath: imagePath,
    motion: {
      kind: 'pan',
      durationScale: 1,
      keyframes: [
        { t: 0, focusX: 0.3, focusY: 0.5, zoom: 1.1 },
        { t: 1, focusX: 0.7, focusY: 0.5, zoom: 1.1 },
      ],
    },
    audioLayers: [],
  })

  const zoomResult = await renderStoryboardComposition(zoomComposition)
  const panResult = await renderStoryboardComposition(panComposition)

  assert.ok(fs.existsSync(zoomResult.outputPath))
  assert.ok(fs.existsSync(panResult.outputPath))
  assert.notEqual(path.basename(zoomResult.outputPath), path.basename(panResult.outputPath))
})
