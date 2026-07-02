import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function generateTestVideo(outputPath: string, duration = 2, width = 320, height = 240) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=${width}x${height}:rate=1`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${duration}`,
    '-c:v', 'libx264', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k',
    '-pix_fmt', 'yuv420p', '-t', String(duration), '-y', outputPath,
  ], { stdio: 'ignore' })
}

function generateTestTone(outputPath: string, duration = 2) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', `sine=frequency=500:duration=${duration}`,
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

test('mixEpisode concatenates shots and mixes narration end-to-end without trimming', { skip: !ffmpegAvailable() }, async () => {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'huobao-episode-mixer-'))
  const storageDir = mkdtempSync(path.join(tmpdir(), 'huobao-episode-storage-'))
  process.env.DB_PATH = path.join(dbDir, 'test.db')
  process.env.STORAGE_PATH = storageDir

  const { db, schema } = await import('../../db/index.js')
  const { mixEpisode } = await import('./episode-mixer.js')
  const { now } = await import('../../utils/response.js')

  const ts = now()
  const dramaId = Number(db.insert(schema.dramas).values({
    title: 'Mixer Drama',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const episodeId = Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: 'Mixer Episode',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const shotDuration = 2
  const shotCount = 2
  for (let i = 0; i < shotCount; i++) {
    const videoPath = path.join(storageDir, `shot_${i}.mp4`)
    const narrationPath = path.join(storageDir, `narration_${i}.wav`)
    generateTestVideo(videoPath, shotDuration)
    generateTestTone(narrationPath, shotDuration)

    db.insert(schema.storyboards).values({
      episodeId,
      storyboardNumber: i + 1,
      title: `Shot ${i + 1}`,
      narration: `Narration ${i + 1}`,
      duration: shotDuration,
      composedVideoUrl: `shot_${i}.mp4`,
      narrationAudioUrl: `narration_${i}.wav`,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }

  const outputPath = path.join(storageDir, 'merged', 'episode.mp4')
  const { outputPath: returnedPath, duration: returnedDuration } = await mixEpisode(episodeId, outputPath)

  assert.equal(returnedPath, outputPath)
  assert.ok(fs.existsSync(outputPath), 'merged output should exist')

  const videoDuration = getDuration(outputPath)
  const expectedDuration = shotCount * shotDuration
  assert.ok(
    Math.abs(videoDuration - expectedDuration) < 0.5,
    `merged duration ${videoDuration} should be close to ${expectedDuration}`,
  )
  assert.ok(returnedDuration > 0, 'returned duration should be positive')
})
