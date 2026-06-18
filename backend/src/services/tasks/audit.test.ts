import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyStuckRow } from './audit.js'

const now = Date.parse('2026-06-17T12:00:00.000Z')
const old = '2026-06-17T11:40:00.000Z'
const recent = '2026-06-17T11:59:00.000Z'

test('classifies provider tasks with provider task id as recoverable', () => {
  const result = classifyStuckRow({
    table: 'image_generations',
    id: 42,
    status: 'processing',
    updatedAt: old,
    taskId: 'provider-task-1',
  }, { nowMs: now })

  assert.equal(result.recommendation, 'recoverable')
  assert.equal(result.action, 'resume_provider_poll')
})

test('classifies old provider tasks without provider task id as terminal unknown', () => {
  const result = classifyStuckRow({
    table: 'video_generations',
    id: 43,
    status: 'processing',
    updatedAt: old,
  }, { nowMs: now })

  assert.equal(result.recommendation, 'terminal_unknown')
  assert.match(result.reason, /no provider task id/i)
})

test('classifies storyboard compose rows with source media as recoverable', () => {
  const result = classifyStuckRow({
    table: 'storyboards',
    id: 44,
    status: 'compose_processing',
    updatedAt: old,
    videoUrl: 'static/videos/shot.mp4',
  }, { nowMs: now })

  assert.equal(result.recommendation, 'recoverable')
  assert.equal(result.action, 'rerun_compose')
})

test('classifies recent stuck-looking rows as needing observation', () => {
  const result = classifyStuckRow({
    table: 'video_merges',
    id: 45,
    status: 'processing',
    createdAt: recent,
    scenes: '["static/composed/a.mp4"]',
  }, { nowMs: now })

  assert.equal(result.recommendation, 'needs_manual_review')
  assert.match(result.reason, /not stale/i)
})
