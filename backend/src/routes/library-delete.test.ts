import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const root = await mkdtemp(join(tmpdir(), 'huobao-library-delete-'))
process.env.STORAGE_PATH = join(root, 'static')
process.env.SFX_LIBRARY_PATH = join(root, 'sfx')

const libraryRoute = (await import('./library.js')).default

async function readJson(response: Response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function writeAsset(relativePath: string) {
  const fullPath = join(root, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, 'fake audio')
  return fullPath
}

test('DELETE /music removes a BGM file and refreshes the library index', async () => {
  const deletedPath = writeAsset('static/music/delete-me.mp3')
  writeAsset('static/music/keep-me.mp3')

  const response = await libraryRoute.request('/music?path=/static/music/delete-me.mp3', {
    method: 'DELETE',
  })
  const json = await readJson(response)

  assert.equal(response.status, 200)
  assert.equal(json.data.deleted, true)
  assert.equal(json.data.relative_path, 'static/music/delete-me.mp3')
  assert.equal(existsSync(deletedPath), false)

  const listResponse = await libraryRoute.request('/music')
  const listJson = await readJson(listResponse)
  assert.equal(listResponse.status, 200)
  assert.equal(listJson.data.items.some((item: any) => item.filename === 'delete-me.mp3'), false)
  assert.equal(listJson.data.items.some((item: any) => item.filename === 'keep-me.mp3'), true)
})

test('DELETE /sfx removes an SFX file and refreshes the mapping', async () => {
  const deletedPath = writeAsset('sfx/library/test-pack/click.wav')
  writeAsset('sfx/library/test-pack/keep.wav')

  const response = await libraryRoute.request('/sfx?path=library/test-pack/click.wav', {
    method: 'DELETE',
  })
  const json = await readJson(response)

  assert.equal(response.status, 200)
  assert.equal(json.data.deleted, true)
  assert.equal(json.data.relative_path, 'library/test-pack/click.wav')
  assert.equal(existsSync(deletedPath), false)

  const listResponse = await libraryRoute.request('/sfx')
  const listJson = await readJson(listResponse)
  assert.equal(listResponse.status, 200)
  assert.equal(listJson.data.items.some((item: any) => item.path === 'library/test-pack/click.wav'), false)
  assert.equal(listJson.data.items.some((item: any) => item.path === 'library/test-pack/keep.wav'), true)
})

test('DELETE /music rejects paths outside the music library', async () => {
  const response = await libraryRoute.request('/music?path=../secret.mp3', {
    method: 'DELETE',
  })
  const json = await readJson(response)

  assert.equal(response.status, 400)
  assert.match(json.message, /path/)
})
