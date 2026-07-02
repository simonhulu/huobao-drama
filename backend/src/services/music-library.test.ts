import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const storageDir = mkdtempSync(path.join(tmpdir(), 'huobao-music-lib-'))
process.env.STORAGE_PATH = storageDir

const { loadMusicLibrary, saveMusicLibrary, recordGeneratedMusic, refreshMusicLibrary, findMusicEntry } = await import('./music-library.js')

test('loadMusicLibrary returns empty library when file missing', () => {
  const lib = loadMusicLibrary()
  assert.equal(lib.version, 1)
  assert.equal(lib.entries.length, 0)
})

test('recordGeneratedMusic appends entry and reloads it', () => {
  const entry = recordGeneratedMusic('static/music/test-track.mp3', {
    prompt: 'epic orchestral drums',
    emotionBucket: 'epic',
    intensity: 'high',
    episodeId: 42,
    duration: 123.4,
  })
  assert.equal(entry.filename, 'test-track.mp3')
  assert.equal(entry.source, 'minimax')
  assert.equal(entry.emotionBucket, 'epic')
  assert.equal(entry.intensity, 'high')
  assert.equal(entry.episodeId, 42)

  const found = findMusicEntry('static/music/test-track.mp3')
  assert.ok(found)
  assert.equal(found?.prompt, 'epic orchestral drums')
})

test('refreshMusicLibrary scans files and keeps metadata', async () => {
  // Add a raw file without metadata and ensure recorded file also exists
  const rawPath = path.join(storageDir, 'music', 'raw-file.mp3')
  const recordedPath = path.join(storageDir, 'music', 'test-track.mp3')
  fs.mkdirSync(path.dirname(rawPath), { recursive: true })
  fs.writeFileSync(rawPath, Buffer.alloc(1024))
  fs.writeFileSync(recordedPath, Buffer.alloc(1024))

  const lib = await refreshMusicLibrary()
  const raw = lib.entries.find(e => e.filename === 'raw-file.mp3')
  assert.ok(raw)
  assert.equal(raw?.source, 'local')
  assert.equal(raw?.duration, 0)

  const existing = lib.entries.find(e => e.filename === 'test-track.mp3')
  assert.ok(existing)
  assert.equal(existing?.source, 'minimax')
  assert.equal(existing?.emotionBucket, 'epic')
})

test('saveMusicLibrary persists entries', () => {
  const lib = loadMusicLibrary()
  lib.entries = lib.entries.filter(e => e.filename !== 'to-remove.mp3')
  saveMusicLibrary(lib)
  const reloaded = loadMusicLibrary()
  assert.equal(reloaded.entries.length, lib.entries.length)
})

test('refreshMusicLibrary indexes audio files in subdirectories', async () => {
  const subdirPath = path.join(storageDir, 'music', 'freepacks', 'holst', 'mars.mp3')
  fs.mkdirSync(path.dirname(subdirPath), { recursive: true })
  fs.writeFileSync(subdirPath, Buffer.alloc(1024))

  const lib = await refreshMusicLibrary()
  const subdirEntry = lib.entries.find(e => e.relativePath === 'static/music/freepacks/holst/mars.mp3')
  assert.ok(subdirEntry, 'subdirectory music file should be indexed')
  assert.equal(subdirEntry?.filename, 'mars.mp3')
  assert.equal(subdirEntry?.source, 'local')
})
