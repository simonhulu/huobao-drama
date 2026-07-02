import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-drama-smart-split-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const dramasRoute = (await import('./dramas.js')).default

const originalFetch = global.fetch

test.afterEach(() => {
  global.fetch = originalFetch
  delete process.env.SMART_EPISODE_SPLIT_MODEL
})

function seedDrama() {
  const ts = now()
  return Number(db.insert(schema.dramas).values({
    title: '悬疑项目',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function seedPlaceholderEpisode(dramaId: number, episodeNumber = 1) {
  const ts = now()
  return Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber,
    title: `第${episodeNumber}集`,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

function seedConfig(serviceType: 'text' | 'image' | 'video' | 'audio', idLabel: string) {
  const ts = now()
  return Number(db.insert(schema.aiServiceConfigs).values({
    serviceType,
    provider: serviceType === 'text' ? 'openai' : idLabel,
    name: `${idLabel}-${serviceType}`,
    baseUrl: serviceType === 'text' ? 'https://api.deepseek.com' : `https://${idLabel}.example.com`,
    apiKey: 'test-key',
    model: JSON.stringify([serviceType === 'text' ? 'deepseek-v4-pro' : `${idLabel}-model`]),
    isActive: true,
    priority: 100,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

test('POST /:id/smart-split creates episodes from structured AI output', async () => {
  const dramaId = seedDrama()
  seedConfig('text', 'deepseek')
  const imageConfigId = seedConfig('image', 'image')
  const videoConfigId = seedConfig('video', 'video')
  const audioConfigId = seedConfig('audio', 'audio')

  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_plot_chain',
              type: 'function',
              function: {
                name: 'submit_plot_progression_chain',
                arguments: JSON.stringify({
                  plot_progression_chain: [
                    {
                      beat_id: 'beat_1',
                      phase: 'setup',
                      summary: '女主拿到戒指，发现丈夫突然失踪。',
                      dramatic_function: '建立危机',
                      suspense_value: '丈夫为什么在婚礼前夜消失',
                      must_keep_context: '婚礼、戒指、家庭压力',
                    },
                    {
                      beat_id: 'beat_2',
                      phase: 'reversal',
                      summary: '电话那头的人说丈夫从来没有登记身份。',
                      dramatic_function: '反转',
                      suspense_value: '她要嫁的人到底是谁',
                      must_keep_context: '戒指和身份信息形成对照',
                    },
                  ],
                }),
              },
            }],
          },
        }],
      }), { status: 200 })
    }

    return new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_smart_split',
            type: 'function',
            function: {
              name: 'submit_episode_split_plan',
              arguments: JSON.stringify({
                series_hook: '一枚戒指揭开未婚夫的身份谜团',
                episodes: [
                  {
                    title: '婚礼前夜',
                    summary: '婚礼前夜，新娘发现未婚夫突然失踪。',
                    opening_hook: '婚礼前夜，她还在试戒指，未婚夫却突然消失。',
                    cliffhanger_hook: '那通电话让她第一次怀疑未婚夫身份造假。',
                    estimated_duration_seconds: 150,
                    opening_anchor: '婚礼前夜，她还在试戒指',
                    ending_anchor: '只在桌上发现一枚还带着体温的戒指。',
                    covered_beat_ids: ['beat_1'],
                  },
                  {
                    title: '他是谁',
                    summary: '女主追查失踪线索，却发现未婚夫身份根本不存在。',
                    opening_hook: '她顺着通话记录追到了城南旅馆。',
                    cliffhanger_hook: '如果身份是假的，那他接近她的目的才刚刚开始暴露。',
                    estimated_duration_seconds: 165,
                    opening_anchor: '她顺着通话记录追到了城南旅馆',
                    ending_anchor: '电话那头的人平静地说，这个人从来没有登记过身份。',
                    covered_beat_ids: ['beat_2'],
                  },
                ],
              }),
            },
          }],
        },
      }],
    }), { status: 200 })
  }) as typeof fetch

  const sourceText = [
    '婚礼前夜，她还在试戒指，未婚夫却突然消失。',
    '她找遍酒店和车库，只在桌上发现一枚还带着体温的戒指。',
    '她顺着通话记录追到了城南旅馆，前台却说这个男人只住过一晚。',
    '等她拨通身份证核验电话，电话那头的人平静地说，这个人从来没有登记过身份。',
  ].join('')

  const response = await dramasRoute.request(`/${dramaId}/smart-split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_text: sourceText,
      duration_preset: 'shorts_1_3',
      image_config_id: imageConfigId,
      video_config_id: videoConfigId,
      audio_config_id: audioConfigId,
      aspect_ratio: '9:16',
      render_mode: 'image_story',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 201)
  assert.equal(json.data.plot_progression_chain.length, 2)
  assert.equal(json.data.duration_preset.id, 'shorts_1_3')
  assert.equal(json.data.created_episodes[0].title, '婚礼前夜')
  assert.match(json.data.created_episodes[0].content_preview, /婚礼前夜/)

  const rows = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber)
    .all()

  // Tight pacing merges the two short episodes into one based on actual text duration.
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(row.episodeNumber, 1)
  assert.equal(row.imageConfigId, imageConfigId)
  assert.equal(row.videoConfigId, videoConfigId)
  assert.equal(row.audioConfigId, audioConfigId)
  assert.equal(row.aspectRatio, '9:16')
  assert.equal(row.renderMode, 'image_story')
  assert.ok(row.duration && row.duration >= 90)
  assert.match(
    row.content || '',
    /婚礼前夜，她还在试戒指，未婚夫却突然消失。/,
  )
  assert.match(
    row.content || '',
    /这个人从来没有登记过身份。/,
  )
  assert.match(row.description || '', /婚礼前夜，新娘发现未婚夫突然失踪/)
  assert.match(row.description || '', /集尾钩子/)
})

test('POST /:id/smart-split rejects invalid request body', async () => {
  const dramaId = seedDrama()

  const response = await dramasRoute.request(`/${dramaId}/smart-split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_text: '',
      duration_preset: 'shorts_1_3',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 400)
  assert.match(json.message, /source_text|image_config_id/)
})

test('POST /:id/smart-split reuses the default empty placeholder episode', async () => {
  const dramaId = seedDrama()
  seedPlaceholderEpisode(dramaId, 1)
  seedConfig('text', 'deepseek')
  const imageConfigId = seedConfig('image', 'image')
  const videoConfigId = seedConfig('video', 'video')
  const audioConfigId = seedConfig('audio', 'audio')

  let callCount = 0
  global.fetch = (async () => {
    callCount += 1
    if (callCount === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_plot_chain',
              type: 'function',
              function: {
                name: 'submit_plot_progression_chain',
                arguments: JSON.stringify({
                  plot_progression_chain: [
                    {
                      beat_id: 'beat_1',
                      phase: 'setup',
                      summary: '第一段建立危机。',
                      dramatic_function: '建立主冲突',
                      suspense_value: '戒指为什么会被留下',
                      must_keep_context: '婚礼前夜与未婚夫失踪',
                    },
                    {
                      beat_id: 'beat_2',
                      phase: 'reversal',
                      summary: '第二段揭示身份反转。',
                      dramatic_function: '抛出更大谜题',
                      suspense_value: '未婚夫身份从未登记',
                      must_keep_context: '电话核验与旅馆线索',
                    },
                  ],
                }),
              },
            }],
          },
        }],
      }), { status: 200 })
    }

    return new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_smart_split',
            type: 'function',
            function: {
              name: 'submit_episode_split_plan',
              arguments: JSON.stringify({
                series_hook: '一枚戒指揭开未婚夫的身份谜团',
                episodes: [
                  {
                    title: '婚礼前夜',
                    summary: '女主发现未婚夫消失，只剩下一枚戒指。',
                    opening_hook: '婚礼前夜，她还在试戒指，未婚夫却突然消失。',
                    cliffhanger_hook: '戒指被留下，意味着他离开得过于仓促。',
                    estimated_duration_seconds: 120,
                    opening_anchor: '婚礼前夜，她还在试戒指',
                    ending_anchor: '只在桌上发现一枚还带着体温的戒指。',
                    covered_beat_ids: ['beat_1'],
                  },
                  {
                    title: '身份空白',
                    summary: '她追查失踪线索，发现未婚夫身份不存在。',
                    opening_hook: '她顺着通话记录追到了城南旅馆。',
                    cliffhanger_hook: '如果身份是假的，那这场婚礼本身就是局。',
                    estimated_duration_seconds: 140,
                    opening_anchor: '她顺着通话记录追到了城南旅馆',
                    ending_anchor: '电话那头的人平静地说，这个人从来没有登记过身份。',
                    covered_beat_ids: ['beat_2'],
                  },
                ],
              }),
            },
          }],
        },
      }],
    }), { status: 200 })
  }) as typeof fetch

  const sourceText = [
    '婚礼前夜，她还在试戒指，未婚夫却突然消失。',
    '她找遍酒店和车库，只在桌上发现一枚还带着体温的戒指。',
    '她顺着通话记录追到了城南旅馆，前台却说这个男人只住过一晚。',
    '等她拨通身份证核验电话，电话那头的人平静地说，这个人从来没有登记过身份。',
  ].join('')

  const response = await dramasRoute.request(`/${dramaId}/smart-split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_text: sourceText,
      duration_preset: 'shorts_1_3',
      image_config_id: imageConfigId,
      video_config_id: videoConfigId,
      audio_config_id: audioConfigId,
      aspect_ratio: '9:16',
      render_mode: 'image_story',
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 201)
  assert.equal(json.data.created_episodes[0].episode_number, 1)

  const rows = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId))
    .orderBy(schema.episodes.episodeNumber)
    .all()

  // Tight pacing merges the short episodes; the single placeholder is reused.
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(row.episodeNumber, 1)
  assert.equal(row.title, '婚礼前夜')
  assert.match(row.content || '', /婚礼前夜/)
  assert.match(row.content || '', /这个人从来没有登记过身份。/)
})
