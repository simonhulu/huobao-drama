import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { NBA_COVER_MAX_PHOTO_UPSCALE, nbaCoverPhotoDisplay, prepareNbaCoverPhoto } from './nba-cover-photo.js'

async function photograph(width: number, height: number) {
  return sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite([
    { input: await sharp({ create: { width: width - 40, height: height - 40, channels: 4, background: '#af8452' } }).png().toBuffer(), left: 20, top: 20 },
  ]).png().toBuffer()
}

test('low-resolution crop keeps the full body instead of magnifying fewer original pixels', async () => {
  const result = await prepareNbaCoverPhoto(await photograph(700, 700), { x: .2, y: 0, width: .6, height: .62 })
  assert.equal(result.crop, undefined)
  assert.equal(result.cropOmittedForResolution, true)
  assert.deepEqual([result.width, result.height], [660, 660])
})

test('high-resolution body crops retain the head top and their requested lower boundary', async () => {
  const crop = { x: .2, y: .1, width: .6, height: .6 }
  const result = await prepareNbaCoverPhoto(await photograph(2000, 2000), crop)
  assert.deepEqual(result.crop, crop)
  assert.equal(result.cropOmittedForResolution, false)
  assert.deepEqual([result.width, result.height], [1200, 1380])
})

test('both poster formats cap enlargement using actual visible pixels and still fill with large photographs', () => {
  for (const portrait of [false, true]) {
    const low = nbaCoverPhotoDisplay(305, 434, portrait)
    assert.equal(low.scale, NBA_COVER_MAX_PHOTO_UPSCALE)
    assert.ok(low.width <= 305 * 1.15 && low.height <= 434 * 1.15)
    const high = nbaCoverPhotoDisplay(1400, 1800, portrait)
    assert.ok(high.scale < 1)
    assert.ok(high.width <= (portrait ? 520 : 700) && high.height <= (portrait ? 720 : 784))
  }
})
