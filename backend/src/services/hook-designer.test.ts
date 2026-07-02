import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { designHooksForEpisodes } from './hook-designer.js'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-hook-designer-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')

const originalFetch = global.fetch

function seedActiveTextConfig() {
  const ts = now()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'openai',
    name: 'DeepSeek text',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: JSON.stringify(['deepseek-v4-pro']),
    isActive: true,
    priority: 100,
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

it('generates recap_script for episode 2 based on episode 1 cliffhanger', async () => {
  seedActiveTextConfig()

  global.fetch = (async () => {
    return new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_hook_design',
            type: 'function',
            function: {
              name: 'submit_hook_design',
              arguments: JSON.stringify({
                series_hook: 'Alice and Bob: a twenty-year secret.',
                episode_hooks: [
                  {
                    episode_number: 1,
                    opening_hook: 'Alice meets Bob.',
                    cliffhanger_hook: 'Alice leaves.',
                  },
                  {
                    episode_number: 2,
                    opening_hook: 'Bob chases Alice.',
                    cliffhanger_hook: 'They reconcile.',
                    recap_script: '上一集，Alice 和 Bob 争吵后，Alice 离家出走了。',
                  },
                ],
              }),
            },
          }],
        },
      }],
    }), { status: 200 })
  }) as typeof fetch

  const episodes = [
    {
      episodeNumber: 1,
      content: 'Alice met Bob. They argued. Alice left.',
      summary: 'Alice meets Bob, argues, and leaves.',
      coveredBeatIds: ['b1', 'b2', 'b3'],
    },
    {
      episodeNumber: 2,
      content: 'Bob chased Alice. They talked.',
      summary: 'Bob chases Alice and they reconcile.',
      coveredBeatIds: ['b4', 'b5'],
    },
  ]
  const plotChain = [
    { beatId: 'b1', summary: 'Alice meets Bob', mustKeepContext: 'Introduces main characters.' },
    { beatId: 'b2', summary: 'They argue', mustKeepContext: 'Sets up conflict.' },
    { beatId: 'b3', summary: 'Alice leaves', mustKeepContext: 'Cliffhanger: will Bob follow?' },
    { beatId: 'b4', summary: 'Bob chases Alice', mustKeepContext: 'Resolution begins.' },
    { beatId: 'b5', summary: 'They talk', mustKeepContext: 'Conflict de-escalates.' },
  ]

  const result = await designHooksForEpisodes({ episodes, plotChain, dramaTitle: 'Alice and Bob' })

  assert.strictEqual(result.seriesHook.length > 0, true)
  assert.strictEqual(result.episodeHooks.length, 2)
  assert.strictEqual(result.episodeHooks[0].recapScript, undefined)
  assert.ok(result.episodeHooks[1].recapScript)
  assert.ok(result.episodeHooks[1].recapScript?.includes('Alice'))

  global.fetch = originalFetch
})
