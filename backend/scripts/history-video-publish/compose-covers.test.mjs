import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { composePublishingCovers } from './compose-covers.mjs'

const run = promisify(execFile)
const cliPath = fileURLToPath(new URL('./compose-covers.mjs', import.meta.url))

test('compose-covers requires explicit design and source images', async () => {
  await assert.rejects(run(process.execPath, [cliPath]), /Missing --design/)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-cover-cli-invalid-'))
  try {
    const designPath = path.join(tempDir, 'design.json')
    await fs.writeFile(designPath, 'null')
    await assert.rejects(composePublishingCovers({ designPath }), /nonempty main_title/)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('compose-covers emits absolute paths for the three publishing formats', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-cover-cli-'))
  try {
    const designPath = path.join(tempDir, 'design.json')
    const imagePath = path.join(tempDir, 'base.png')
    await fs.writeFile(designPath, JSON.stringify({ cover_design: { main_title: 'History' } }))
    await sharp({ create: { width: 160, height: 120, channels: 3, background: '#287c86' } })
      .png().toFile(imagePath)
    const { stdout } = await run(process.execPath, [cliPath,
      '--design', designPath, '--landscape', imagePath, '--portrait', imagePath,
      '--out-dir', path.join(tempDir, 'covers'),
    ])
    const result = JSON.parse(stdout)
    assert.equal(result.ok, true)
    assert.deepEqual(Object.keys(result.covers), ['landscape_16x9', 'landscape_4x3', 'portrait_3x4'])
    for (const [key, width, height] of [
      ['landscape_16x9', 1280, 720], ['landscape_4x3', 1200, 900], ['portrait_3x4', 900, 1200],
    ]) {
      const cover = result.covers[key]
      assert.equal(path.isAbsolute(cover.path), true)
      assert.deepEqual([cover.width, cover.height], [width, height])
      const metadata = await sharp(cover.path).metadata()
      assert.deepEqual([metadata.width, metadata.height], [width, height])
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})
