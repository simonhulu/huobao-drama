import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { scienceCoverPresenterPlacement, scienceCoverPresenterAlpha, scienceCoverPresenterCutout } from './science-cover-presenter.js'

test('Vision PNG masks discard their encoding alpha and produce exactly one silhouette channel', async () => {
  const mask = await sharp(Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]),
    { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer()
  assert.deepEqual([...await scienceCoverPresenterAlpha(mask, 3, 1)], [0, 255, 0])
})

test('adding the person mask retains a real transparent channel and preserves original photograph pixels', async () => {
  const source = await sharp({ create: { width: 3, height: 1, channels: 3, background: { r: 123, g: 45, b: 67 } } }).png().toBuffer()
  const photograph = await scienceCoverPresenterCutout(source, Buffer.from([0, 255, 0]), 3, 1)
  assert.equal((await sharp(photograph).metadata()).hasAlpha, true)
  assert.deepEqual([...await sharp(photograph).raw().toBuffer()], [123, 45, 67, 0, 123, 45, 67, 255, 123, 45, 67, 0])
})

test('presenter is a half-body photograph opposite the headline and within cover safe insets', () => {
  for (const format of [{ width: 1280, height: 720 }, { width: 810, height: 1080 }]) {
    for (const textSide of ['text-left', 'text-right'] as const) {
      const box = scienceCoverPresenterPlacement(format, { width: 760, height: 1040 }, textSide)
      assert.ok(box.left >= format.width * .03)
      assert.ok(box.left + box.width <= format.width * .97)
      assert.ok(box.top >= 0)
      assert.ok(box.top + box.height <= format.height)
      if (format.width >= format.height) {
        assert.ok(box.width >= format.width * .23, 'landscape host remains recognizable in a small thumbnail')
        if (textSide === 'text-left') assert.ok(box.left >= format.width * .60)
        else assert.ok(box.left + box.width <= format.width * .40)
      } else assert.ok(box.top >= format.height * .53, 'the complete portrait headline area stays unobstructed')
    }
  }
})
