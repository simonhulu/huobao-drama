import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function generateTestVideo(outputPath: string, duration = 1, width = 320, height = 240) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=${width}x${height}:rate=1`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${duration}`,
    '-c:v', 'libx264', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k',
    '-pix_fmt', 'yuv420p', '-t', String(duration), '-y', outputPath,
  ], { stdio: 'ignore' })
}

function generateTestTone(outputPath: string, duration = 2, frequency = 500, volume = 1) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
    '-af', `volume=${volume}`,
    '-y', outputPath,
  ], { stdio: 'ignore' })
}

function getDuration(filePath: string): number {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8' })
  return Number(JSON.parse(raw).format.duration)
}

function getMeanVolume(filePath: string): number {
  const result = spawnSync('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i', filePath,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`ffmpeg volumedetect failed for ${filePath}: ${result.stderr}`)
  }
  const output = `${result.stdout}\n${result.stderr}`
  const match = output.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/)
  if (!match) throw new Error(`mean_volume not found for ${filePath}`)
  return Number(match[1])
}

test('mixEpisode renders BGM cues without restarting music for every short shot', { skip: !ffmpegAvailable() }, async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'huobao-episode-mixer-bgm-'))
  const storageDir = mkdtempSync(path.join(tmpdir(), 'huobao-episode-storage-bgm-'))
  process.env.DB_PATH = path.join(dbDir, 'test.db')
  process.env.STORAGE_PATH = storageDir

  const { db, schema } = await import('../../db/index.js')
  const { mixEpisode } = await import('./episode-mixer.js')
  const { planBgmCues } = await import('./bgm-cue-planner.js')
  const { now } = await import('../../utils/response.js')

  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Mixer BGM Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Mixer BGM Episode',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  generateTestTone(path.join(storageDir, 'bgm_a.wav'), 2, 500, 0.01)
  generateTestTone(path.join(storageDir, 'bgm_b.wav'), 2, 700, 0.01)

  const bgmSequence = ['bgm_a.wav', 'bgm_b.wav', 'bgm_a.wav', 'bgm_b.wav', 'bgm_a.wav']
  for (let i = 0; i < bgmSequence.length; i++) {
    const videoPath = path.join(storageDir, `bgm_shot_${i}.mp4`)
    generateTestVideo(videoPath, 1)

    db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: i + 1,
      title: `BGM Shot ${i + 1}`,
      narration: '',
      duration: 1,
      composedVideoUrl: `bgm_shot_${i}.mp4`,
      bgmAudioUrl: bgmSequence[i],
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }

  const cuePlan = planBgmCues(
    bgmSequence.map(bgmPath => ({ videoDuration: 1, bgmPath })),
    { minCueDuration: 3, maxCueDuration: 10 },
  )
  assert.equal(cuePlan.length, 1, 'short adjacent BGM shots should become one cue')

  const outputPath = path.join(storageDir, 'merged', 'episode-bgm.mp4')
  const { outputPath: returnedPath, duration: returnedDuration } = await mixEpisode(episodeId, outputPath)

  assert.equal(returnedPath, outputPath)
  assert.ok(fs.existsSync(outputPath), 'merged output with BGM should exist')

  const videoDuration = getDuration(outputPath)
  assert.ok(
    Math.abs(videoDuration - bgmSequence.length) < 0.5,
    `merged duration ${videoDuration} should be close to ${bgmSequence.length}`,
  )
  const meanVolume = getMeanVolume(outputPath)
  assert.ok(meanVolume > -35, `quiet source BGM should be normalized to an audible bed, got ${meanVolume} dB`)
  assert.ok(returnedDuration > 0, 'returned duration should be positive')
})
