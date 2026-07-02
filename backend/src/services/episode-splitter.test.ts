import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-episode-splitter-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { db, schema } = await import('../db/index.js')
const { now } = await import('../utils/response.js')
const {
  SMART_SPLIT_MODEL,
  SMART_PLOT_CHAIN_TOOL_NAME,
  SMART_SPLIT_TOOL_NAME,
  materializeEpisodeContents,
  splitStoryIntoEpisodes,
} = await import('./episode-splitter.js')

const originalFetch = global.fetch

test.afterEach(() => {
  global.fetch = originalFetch
  delete process.env.SMART_EPISODE_SPLIT_MODEL
})

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

test('splitStoryIntoEpisodes uses two deepseek-v4-flash tool calls and materializes contiguous source text', async () => {
  seedActiveTextConfig()

  const sourceText = [
    '林晚在父亲葬礼上收到一把旧钥匙，却没人告诉她钥匙开什么。',
    '她回到空了十年的老宅，在阁楼木箱里翻到一封没寄出的信。',
    '信里只写着一句话：不要相信顾承。',
    '当晚顾承突然出现，说父亲临终前把公司交给了他。',
    '林晚强装镇定，把钥匙藏进掌心。',
    '可她刚转身，就在顾承袖口看见了和木箱上一样的火漆印。',
  ].join('')

  const requestUrls: string[] = []
  const requestBodies: any[] = []
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrls.push(String(input))
    requestBodies.push(JSON.parse(String(init?.body)))

    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_plot_chain',
              type: 'function',
              function: {
                name: SMART_PLOT_CHAIN_TOOL_NAME,
                arguments: JSON.stringify({
                  plot_progression_chain: [
                    {
                      beat_id: 'beat_1',
                      phase: 'setup',
                      summary: '葬礼上的钥匙与未解之谜建立了故事驱动力。',
                      dramatic_function: '设置主悬念',
                      suspense_value: '钥匙到底开向什么秘密',
                      must_keep_context: '父亲刚去世，林晚孤立无援',
                    },
                    {
                      beat_id: 'beat_2',
                      phase: 'discovery',
                      summary: '老宅和没寄出的信引出对顾承的怀疑。',
                      dramatic_function: '抛出怀疑对象',
                      suspense_value: '父亲为什么警告她不要相信顾承',
                      must_keep_context: '老宅、木箱、信件都是父亲留下的线索',
                    },
                    {
                      beat_id: 'beat_3',
                      phase: 'cliffhanger',
                      summary: '顾承现身并暴露火漆印，形成集尾钩子。',
                      dramatic_function: '制造反转悬念',
                      suspense_value: '顾承和父亲秘密之间存在直接关联',
                      must_keep_context: '顾承主动掌控公司，林晚暂时不能摊牌',
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
              name: SMART_SPLIT_TOOL_NAME,
              arguments: JSON.stringify({
                series_hook: '父亲葬礼上的一把旧钥匙，揭开丈夫顾承藏了十年的致命秘密。',
                episodes: [
                  {
                    title: '钥匙落手',
                    summary: '林晚在葬礼和老宅里接连得到父亲留下的两层线索。',
                    opening_hook: '父亲葬礼上，林晚收到一把来历不明的旧钥匙。',
                    cliffhanger_hook: '那句警告让她第一次意识到顾承可能站在对立面。',
                    estimated_duration_seconds: 160,
                    opening_anchor: '林晚在父亲葬礼上收到一把旧钥匙',
                    ending_anchor: '信里只写着一句话：不要相信顾承。',
                    covered_beat_ids: ['beat_1', 'beat_2'],
                  },
                  {
                    title: '火漆印',
                    summary: '顾承主动上门夺权，林晚在细节里发现他与秘密直接相关。',
                    opening_hook: '丈夫顾承突然出现，开口就要接管父亲的公司。',
                    cliffhanger_hook: '同样的火漆印意味着顾承早就接触过父亲的隐藏计划。',
                    estimated_duration_seconds: 175,
                    opening_anchor: '当晚顾承突然出现',
                    ending_anchor: '可她刚转身，就在顾承袖口看见了和木箱上一样的火漆印。',
                    covered_beat_ids: ['beat_3'],
                  },
                ],
              }),
            },
          }],
        },
      }],
    }), { status: 200 })
  }) as typeof fetch

  const result = await splitStoryIntoEpisodes({
    dramaTitle: '火漆印',
    sourceText,
    durationPresetId: 'micro_30_60',
  })

  assert.equal(requestUrls.length, 2)
  assert.equal(requestUrls[0], 'https://api.deepseek.com/beta/chat/completions')
  assert.equal(requestUrls[1], 'https://api.deepseek.com/beta/chat/completions')
  assert.equal(requestBodies[0].model, SMART_SPLIT_MODEL)
  assert.equal(requestBodies[1].model, SMART_SPLIT_MODEL)
  assert.equal(requestBodies[0].tool_choice.type, 'function')
  assert.equal(requestBodies[0].tool_choice.function.name, SMART_PLOT_CHAIN_TOOL_NAME)
  assert.equal(requestBodies[1].tool_choice.function.name, SMART_SPLIT_TOOL_NAME)
  assert.equal(requestBodies[0].tools[0].function.strict, true)
  assert.equal(requestBodies[1].tools[0].function.strict, true)
  assert.equal(requestBodies[0].response_format, undefined)
  assert.equal(requestBodies[1].response_format, undefined)
  assert.match(requestBodies[0].messages[0].content, /先抽取剧情推进链/)
  assert.match(requestBodies[1].messages[0].content, /剧情推进链已经确定/)
  assert.match(requestBodies[1].messages[1].content, /已确定的剧情推进链/)
  assert.equal(requestBodies[1].tools[0].function.parameters.properties.episodes.items.properties.covered_beat_ids.minItems, undefined)

  assert.equal(result.plotProgressionChain.length, 3)
  assert.equal(result.episodes.length, 2)
  assert.equal(
    result.episodes[0].content,
    '林晚在父亲葬礼上收到一把旧钥匙，却没人告诉她钥匙开什么。她回到空了十年的老宅，在阁楼木箱里翻到一封没寄出的信。信里只写着一句话：不要相信顾承。',
  )
  assert.equal(
    result.episodes[1].content,
    '当晚顾承突然出现，说父亲临终前把公司交给了他。林晚强装镇定，把钥匙藏进掌心。可她刚转身，就在顾承袖口看见了和木箱上一样的火漆印。',
  )
  assert.deepEqual(result.episodes[0].coveredBeatIds, ['beat_1', 'beat_2'])
  assert.equal(result.episodes[1].cliffhangerHook, '同样的火漆印意味着顾承早就接触过父亲的隐藏计划。')
})

test('materializeEpisodeContents fails fast when model anchors cannot map back to source text', () => {
  assert.throws(() => materializeEpisodeContents(
    '她推门进屋，发现桌上放着一把旧钥匙。她翻开抽屉，看见一张被烧焦的照片。',
    [
      {
        title: '错误边界',
        summary: '测试',
        cliffhangerHook: '测试',
        openingHook: '测试',
        estimatedDurationSeconds: 90,
        openingAnchor: '她推门进屋',
        endingAnchor: '并不存在的锚点',
        coveredBeatIds: ['beat_1'],
      },
      {
        title: '第二集',
        summary: '测试',
        cliffhangerHook: '测试',
        openingHook: '测试',
        estimatedDurationSeconds: 90,
        openingAnchor: '她翻开抽屉',
        endingAnchor: '她翻开抽屉，看见一张被烧焦的照片。',
        coveredBeatIds: ['beat_2'],
      },
    ],
  ), /锚点无法映射回原文/)
})

test('materializeEpisodeContents keeps the final episode when its ending anchor is not needed for slicing', () => {
  const result = materializeEpisodeContents(
    '她推门进屋，发现桌上放着一把旧钥匙。她翻开抽屉，看见一张被烧焦的照片。',
    [
      {
        title: '第一集',
        summary: '测试',
        cliffhangerHook: '测试',
        openingHook: '测试',
        estimatedDurationSeconds: 90,
        openingAnchor: '她推门进屋',
        endingAnchor: '发现桌上放着一把旧钥匙。',
        coveredBeatIds: ['beat_1'],
      },
      {
        title: '第二集',
        summary: '测试',
        cliffhangerHook: '测试',
        openingHook: '测试',
        estimatedDurationSeconds: 90,
        openingAnchor: '她翻开抽屉',
        endingAnchor: '林晚翻开抽屉，看见一张被烧焦的照片。',
        coveredBeatIds: ['beat_2'],
      },
    ],
  )

  assert.equal(result[1].content, '她翻开抽屉，看见一张被烧焦的照片。')
})

test('materializeEpisodeContents tolerates quote style and whitespace differences in anchors', () => {
  const sourceText = '她冷冷地说：“放心。”\n“我不会再打扰你们。”然后转身离开。'

  const result = materializeEpisodeContents(
    sourceText,
    [
      {
        title: '告别',
        summary: '测试',
        cliffhangerHook: '测试',
        openingHook: '测试',
        estimatedDurationSeconds: 90,
        openingAnchor: '她冷冷地说：',
        endingAnchor: '"放心。"\n"我不会再打扰你们。"',
        coveredBeatIds: ['beat_1'],
      },
    ],
  )

  assert.equal(result.length, 1)
  assert.equal(result[0].content, '她冷冷地说：“放心。”\n“我不会再打扰你们。”然后转身离开。')
})
