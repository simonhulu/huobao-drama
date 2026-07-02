import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-scripts-clean-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const originalFetch = global.fetch
const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const scriptsRoute = (await import('./scripts.js')).default

after(() => {
  global.fetch = originalFetch
})

function seedTextConfig() {
  const ts = now()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: 'openai-text',
    baseUrl: 'https://text.example.com',
    apiKey: 'test-key',
    model: JSON.stringify(['gpt-test']),
    isActive: true,
    priority: 100,
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

function mockTextResponses(contents: string[]) {
  let callCount = 0
  global.fetch = (async () => {
    const content = contents[Math.min(callCount, contents.length - 1)] || ''
    callCount += 1
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }))
  }) as typeof fetch
  return () => callCount
}

test('POST /scripts/clean returns two-stage retention preview', async () => {
  seedTextConfig()
  const callCount = mockTextResponses([
    '万历要开矿，大臣们反对。嘉靖旧账显示曾经亏钱。',
    '大臣们反对开矿，怕的不是亏钱，而是钱流向皇权。嘉靖旧账只是他们最体面的理由。下一集，万历派出的矿监会把矛盾推到台前。',
  ])

  const response = await scriptsRoute.request('/clean', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '万历要开矿，大臣们反对。嘉靖旧账显示曾经亏钱。',
      clean_mode: 'retention',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 200)
  assert.equal(callCount(), 2)
  assert.equal(json.data.clean_mode, 'retention')
  assert.equal(json.data.retention_mode, 'tight')
  assert.equal(json.data.clean_script, '万历要开矿，大臣们反对。嘉靖旧账显示曾经亏钱。')
  assert.equal(json.data.production_script, '大臣们反对开矿，怕的不是亏钱，而是钱流向皇权。嘉靖旧账只是他们最体面的理由。下一集，万历派出的矿监会把矛盾推到台前。')
  assert.equal(json.data.content, json.data.production_script)
  assert.equal(json.data.opening_hook, '大臣们反对开矿，怕的不是亏钱，而是钱流向皇权')
  assert.equal(json.data.cliffhanger, '下一集，万历派出的矿监会把矛盾推到台前')
  assert.ok(json.data.retention_beats)
  assert.equal(json.data.retention_beats.openingHook.text, json.data.opening_hook)
})
