import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-dharma-render-payload-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const {
  createDharmaRenderPayload,
  parseDharmaRenderPayload,
  resolveDharmaRenderArtifact,
  sameCanonicalDharmaRenderPayload,
} = await import('./dharma-render-payload.js')

test('canonical Dharma canary payload identifies a bounded review window', () => {
  assert.deepEqual(parseDharmaRenderPayload({
    episode_id: 726,
    review_kind: 'canary',
    only_storyboard_ids: [13, 11, 12],
    max_duration_sec: 22.5,
  }), {
    payload: {
      episode_id: 726,
      review_kind: 'canary',
      only_storyboard_ids: [11, 12, 13],
      max_duration_sec: 22.5,
    },
    source: 'canonical',
    isPreview: true,
    isReviewPilot: false,
    isReviewCanary: true,
  })
})

test('canonical Dharma canary payload requires storyboard ids and a 15-30 second duration', () => {
  const base = { episode_id: 726, review_kind: 'canary' }
  assert.equal(parseDharmaRenderPayload({ ...base, max_duration_sec: 20 }), null)
  assert.equal(parseDharmaRenderPayload({ ...base, only_storyboard_ids: [11, 12] }), null)
  assert.equal(parseDharmaRenderPayload({ ...base, only_storyboard_ids: [11], max_duration_sec: 14.999 }), null)
  assert.equal(parseDharmaRenderPayload({ ...base, only_storyboard_ids: [11], max_duration_sec: 30.001 }), null)

  assert.equal(parseDharmaRenderPayload({
    ...base,
    only_storyboard_ids: [11],
    max_duration_sec: 15,
  })?.isReviewCanary, true)
  assert.equal(parseDharmaRenderPayload({
    ...base,
    only_storyboard_ids: [11],
    max_duration_sec: 30,
  })?.isReviewCanary, true)
})

test('Dharma render payload creation only persists complete canary requests', () => {
  assert.deepEqual(createDharmaRenderPayload(726, {
    reviewKind: 'canary',
    onlyStoryboardIds: [13, 11, 12],
    maxDurationSec: 20,
  }), {
    episode_id: 726,
    review_kind: 'canary',
    only_storyboard_ids: [11, 12, 13],
    max_duration_sec: 20,
  })

  assert.throws(
    () => createDharmaRenderPayload(726, { reviewKind: 'canary', maxDurationSec: 20 }),
    /canary requires only_storyboard_ids/,
  )
  assert.throws(
    () => createDharmaRenderPayload(726, { reviewKind: 'canary', onlyStoryboardIds: [11] }),
    /canary requires max_duration_sec between 15 and 30/,
  )
  assert.throws(
    () => createDharmaRenderPayload(726, {
      reviewKind: 'canary', onlyStoryboardIds: [11], maxDurationSec: 31,
    }),
    /canary requires max_duration_sec between 15 and 30/,
  )
})

test('canonical task equality distinguishes a review canary from an ordinary preview', () => {
  const canary = createDharmaRenderPayload(726, {
    reviewKind: 'canary',
    onlyStoryboardIds: [11, 12],
    maxDurationSec: 20,
  })
  assert.equal(sameCanonicalDharmaRenderPayload({
    episode_id: 726,
    review_kind: 'canary',
    only_storyboard_ids: [12, 11],
    max_duration_sec: 20,
  }, canary), true)
  assert.equal(sameCanonicalDharmaRenderPayload({
    episode_id: 726,
    only_storyboard_ids: [11, 12],
    max_duration_sec: 20,
  }, canary), false)
})

test('Dharma canary gets an immutable review artifact without changing legacy pilot identity', () => {
  const canary = parseDharmaRenderPayload({
    episode_id: 726,
    review_kind: 'canary',
    only_storyboard_ids: [11, 12],
    max_duration_sec: 22.5,
  })
  assert.ok(canary)
  assert.deepEqual(resolveDharmaRenderArtifact(726, 91, canary), {
    fileStem: 'dharma-ep726-canary-22.5s-task91',
    isPreview: true,
    isReviewPilot: false,
    isReviewCanary: true,
  })

  const pilot = parseDharmaRenderPayload({ episode_id: 726, max_duration_sec: 60 })
  assert.ok(pilot)
  assert.equal(pilot.isReviewPilot, true)
  assert.equal(pilot.isReviewCanary, false)
  assert.deepEqual(resolveDharmaRenderArtifact(726, 92, pilot), {
    fileStem: 'dharma-ep726-pilot-60s-task92',
    isPreview: true,
    isReviewPilot: true,
  })
})

test('historical camelCase canary-like controls retain formal-render semantics', () => {
  assert.deepEqual(parseDharmaRenderPayload({
    episodeId: 726,
    reviewKind: 'canary',
    onlyStoryboardIds: [11, 12],
    maxDurationSec: 20,
  }, { mode: 'historical', expectedEpisodeId: 726 }), {
    payload: { episode_id: 726 },
    source: 'legacy',
    isPreview: false,
    isReviewPilot: false,
    isReviewCanary: false,
  })
})
