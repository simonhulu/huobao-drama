import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DHARMA_IMAGE_STYLE_ID,
  DHARMA_EMOTIONAL_INK_STYLE_ID,
  DHARMA_MINIMAL_LIGHT_STYLE_ID,
  DHARMA_SURREAL_DREAM_STYLE_ID,
  buildDharmaImagePrompt,
  findDharmaImageStyle,
  isCanonicalDharmaImageStyleSnapshot,
  listDharmaImageStyles,
  parseDharmaImageStyleSnapshot,
  resolveDharmaImageStyle,
  resolveDharmaStyleForEmotion,
  snapshotDharmaImageStyle,
  validateDharmaStyleEmotion,
} from './dharma-image-style.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

test('Dharma emotional style catalog exposes three immutable production presets with local previews', () => {
  const styles = listDharmaImageStyles()
  const production = styles.filter((style) => style.production)

  assert.equal(new Set(styles.map((style) => style.id)).size, styles.length)
  assert.deepEqual(production.map((style) => style.id), [
    DHARMA_EMOTIONAL_INK_STYLE_ID,
    DHARMA_SURREAL_DREAM_STYLE_ID,
    DHARMA_MINIMAL_LIGHT_STYLE_ID,
  ])
  assert.equal(DEFAULT_DHARMA_IMAGE_STYLE_ID, DHARMA_EMOTIONAL_INK_STYLE_ID)
  assert.ok(production.every((style) => existsSync(resolve(repoRoot, 'data', style.previewUrl.replace(/^\//, '')))))
})

test('Dharma emotional roles map deterministically to the three production styles', () => {
  assert.equal(resolveDharmaStyleForEmotion('curiosity').id, DHARMA_SURREAL_DREAM_STYLE_ID)
  assert.equal(resolveDharmaStyleForEmotion('tension').id, DHARMA_SURREAL_DREAM_STYLE_ID)
  assert.equal(resolveDharmaStyleForEmotion('stillness').id, DHARMA_EMOTIONAL_INK_STYLE_ID)
  assert.equal(resolveDharmaStyleForEmotion('acceptance').id, DHARMA_EMOTIONAL_INK_STYLE_ID)
  assert.equal(resolveDharmaStyleForEmotion('release').id, DHARMA_EMOTIONAL_INK_STYLE_ID)
  assert.equal(resolveDharmaStyleForEmotion('insight').id, DHARMA_MINIMAL_LIGHT_STYLE_ID)
  assert.equal(validateDharmaStyleEmotion(resolveDharmaStyleForEmotion('insight'), 'insight'), null)
  assert.match(
    validateDharmaStyleEmotion(resolveDharmaStyleForEmotion('curiosity'), 'acceptance') || '',
    /不能承担/,
  )
})

test('unknown stored styles fall back explicitly while known legacy IDs remain readable', () => {
  assert.equal(resolveDharmaImageStyle('unknown-old-style').id, DEFAULT_DHARMA_IMAGE_STYLE_ID)
  assert.equal(findDharmaImageStyle('unknown-old-style'), null)
  assert.equal(resolveDharmaImageStyle('dharma-gongbi-sutra-v1').id, 'dharma-gongbi-sutra-v1')
})

test('queued image work can use an immutable prompt snapshot', () => {
  const style = resolveDharmaStyleForEmotion('curiosity')
  const snapshot = snapshotDharmaImageStyle(style)
  assert.deepEqual(parseDharmaImageStyleSnapshot(snapshot), snapshot)
  assert.equal(isCanonicalDharmaImageStyleSnapshot(style, snapshot), true)
  assert.equal(isCanonicalDharmaImageStyleSnapshot(style, {
    ...snapshot,
    promptPrefix: 'forged prompt prefix',
  }), false)

  const built = buildDharmaImagePrompt('一扇悬在雾中的门', style.id, {
    emotion: 'curiosity',
    snapshot,
  })
  assert.equal(built.snapshot, snapshot)
  assert.match(built.prompt, /poetic surreal dreamscape/)
  assert.match(built.prompt, /一扇悬在雾中的门/)
  assert.match(built.prompt, /without explaining the idea literally/)
  assert.match(built.prompt, /readable text or calligraphy/)
})
