import { describe, it, after } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-retention-optimizer-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const originalFetch = global.fetch
const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const { optimizeScriptForRetention } = await import('./retention-script-optimizer.js')

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

function mockTextResponse(content: string) {
  global.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }))) as typeof fetch
}

describe('optimizeScriptForRetention', () => {
  it('returns unchanged in standard mode', async () => {
    const script = '大臣们反对万历开矿。真实原因是利益冲突。'
    const result = await optimizeScriptForRetention(script, { retentionMode: 'standard' })
    assert.equal(result.content, script)
    assert.equal(result.cleanScript, script)
    assert.equal(result.productionScript, script)
    assert.equal(result.changes.length, 0)
  })

  it('returns production script, hooks, cliffhanger and retention beats in tight mode', async () => {
    seedTextConfig()
    mockTextResponse('大臣们反对开矿，真正怕的是钱不进他们的口袋。嘉靖旧账证明开矿亏钱只是表象。万历要矿税，掀开的其实是大明官僚的账本。')

    const script = '万历皇帝要开矿，大臣们集体反对。他们怕的不是动乱，而是钱进的不是国库。'
    const result = await optimizeScriptForRetention(script, {
      retentionMode: 'tight',
      hookStyle: 'suspense',
    })

    assert.equal(result.cleanScript, script)
    assert.equal(result.productionScript, '大臣们反对开矿，真正怕的是钱不进他们的口袋。嘉靖旧账证明开矿亏钱只是表象。万历要矿税，掀开的其实是大明官僚的账本。')
    assert.equal(result.content, result.productionScript)
    assert.equal(result.openingHook, '大臣们反对开矿，真正怕的是钱不进他们的口袋')
    assert.equal(result.cliffhanger, '万历要矿税，掀开的其实是大明官僚的账本')
    assert.ok(result.retentionBeats)
    assert.equal(result.retentionBeats?.openingHook.text, result.openingHook)
    assert.equal(result.retentionBeats?.cliffhanger.text, result.cliffhanger)
    assert.ok((result.retentionBeats?.midBeats.length || 0) >= 1)
    assert.ok(result.estimatedDurationSeconds > 0)
  })
})
