import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  downloadFromManifest,
  getProviderApiKey,
  normalizeCoverrVideos,
  normalizePexelsVideos,
  normalizePixabayVideos,
} from './stock_videos.mjs'

test('requires provider API key from explicit environment variables', () => {
  assert.throws(
    () => getProviderApiKey('pexels', {}),
    /PEXELS_API_KEY/,
  )
  assert.equal(
    getProviderApiKey('pixabay', { PIXABAY_API_KEYS: ' first-key , second-key ' }),
    'first-key',
  )
})

test('normalizes Pexels videos defensively and prefers 16:9 720p downloads', () => {
  const items = normalizePexelsVideos({
    videos: [
      {
        id: 123,
        duration: 8,
        width: 1920,
        height: 1080,
        url: 'https://www.pexels.com/video/123/',
        user: { name: 'Creator' },
        video_files: [
          { width: 540, height: 960, link: 'https://cdn.example/portrait.mp4' },
          { width: 1280, height: 720, link: 'https://cdn.example/landscape.mp4' },
        ],
      },
      { id: 456, duration: 2, video_files: [{ width: 1280, height: 720, link: 'https://cdn.example/short.mp4' }] },
      { duration: 8, video_files: [{ width: 1280, height: 720, link: 'https://cdn.example/missing-id.mp4' }] },
    ],
  }, { query: 'ocean', minDuration: 5 })

  assert.deepEqual(items, [
    {
      provider: 'pexels',
      videoId: '123',
      title: '',
      creator: 'Creator',
      duration: 8,
      width: 1280,
      height: 720,
      sourceUrl: 'https://www.pexels.com/video/123/',
      downloadUrl: 'https://cdn.example/landscape.mp4',
      licenseUrl: 'https://www.pexels.com/license/',
      query: 'ocean',
    },
  ])
})

test('normalizes Pixabay videos with stable manifest schema', () => {
  const items = normalizePixabayVideos({
    hits: [
      {
        id: 999,
        duration: 12,
        pageURL: 'https://pixabay.com/videos/city-999/',
        user: 'Pixabay User',
        videos: {
          tiny: { width: 480, height: 270, url: 'https://cdn.example/tiny.mp4' },
          medium: { width: 1280, height: 720, url: 'https://cdn.example/medium.mp4' },
        },
      },
    ],
  }, { query: 'city flow', minDuration: 3 })

  assert.equal(items.length, 1)
  assert.equal(items[0].provider, 'pixabay')
  assert.equal(items[0].videoId, '999')
  assert.equal(items[0].downloadUrl, 'https://cdn.example/medium.mp4')
  assert.equal(items[0].licenseUrl, 'https://pixabay.com/service/license-summary/')
  assert.equal(items[0].query, 'city flow')
})

test('normalizes Coverr videos from signed download fields without requiring all metadata', () => {
  const items = normalizeCoverrVideos({
    hits: [
      {
        id: 'coverr-1',
        duration: '10.500000',
        title: 'Smoke',
        slug: 'smoke',
        urls: { mp4_download: 'https://coverr.example/download-token' },
      },
      {
        id: 'coverr-short',
        duration: 1,
        urls: { mp4_download: 'https://coverr.example/short' },
      },
    ],
  }, { query: 'smoke', minDuration: 3 })

  assert.equal(items.length, 1)
  assert.equal(items[0].provider, 'coverr')
  assert.equal(items[0].videoId, 'coverr-1')
  assert.equal(items[0].duration, 10)
  assert.equal(items[0].width, 1920)
  assert.equal(items[0].height, 1080)
  assert.equal(items[0].downloadUrl, 'https://coverr.example/download-token')
  assert.equal(items[0].sourceUrl, 'https://coverr.co/videos/smoke')
  assert.equal(items[0].licenseUrl, 'https://coverr.co/license')
})

test('downloads only manifest entries with downloadUrl and records local metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-videos-'))
  const manifestPath = path.join(tempDir, 'manifest.json')
  const dest = path.join(tempDir, 'stock')
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'videoeditor-stock-videos',
    query: 'cloud',
    results: [
      { provider: 'pexels', videoId: 'abc', downloadUrl: 'https://cdn.example/video.mp4' },
      { provider: 'coverr', videoId: 'skip-me' },
    ],
  }, null, 2))

  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return new Response(Buffer.from('video-bytes'), {
      status: 200,
      headers: { 'content-type': 'video/mp4' },
    })
  }

  const result = await downloadFromManifest({ manifestPath, dest, fetchImpl, now: () => '2026-07-13T00:00:00.000Z' })
  const updated = JSON.parse(await fs.readFile(manifestPath, 'utf8'))

  assert.deepEqual(calls, ['https://cdn.example/video.mp4'])
  assert.equal(result.downloaded, 1)
  assert.equal(updated.results[0].localPath, path.join(dest, 'pexels-abc.mp4'))
  assert.equal(updated.results[0].downloadedAt, '2026-07-13T00:00:00.000Z')
  assert.equal(updated.results[0].bytes, 11)
  assert.match(updated.results[0].sha256, /^[a-f0-9]{64}$/)
  assert.equal(updated.results[1].localPath, undefined)
})
