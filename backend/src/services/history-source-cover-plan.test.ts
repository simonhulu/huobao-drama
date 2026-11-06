import test from 'node:test'
import assert from 'node:assert/strict'
import { enhanceCoverPrompt } from './cover-prompt-enhance.js'
import { coverEditorialPlanSchema, hasCompleteCoverPlan } from './cover-editorial-plan.js'

const script = '朱棣在1399年起兵，三年后进入南京。'
for (const [sourceTitle, expected] of [
  ['【第十二集】朱棣1399年起兵，为何只用三年打进南京？｜欢迎订阅', '朱棣1399年起兵 为何只用三年打进南京？'],
  ['EP.12 朱棣1399-1402年征战｜高清完整版', '朱棣1399-1402年征战'],
  ['秦朝亡了沒人救 漢朝亡了憑什麼還能再活兩百年？-助眠睡前歷史故事', '秦朝亡了沒人救 漢朝亡了憑什麼還能再活兩百年？'],
  ['【明朝】朱棣为何起兵？（上集）', '【明朝】朱棣为何起兵？'],
  ['12集：朱棣为何起兵？ #历史', '朱棣为何起兵？'],
  ['鴉片戰爭慘敗真相，清軍陣亡2.2萬，英軍僅69人，真全怪武器落後嗎?｜晚清｜歷史｜揭秘｜真相｜道光皇帝', '鴉片戰爭慘敗真相 清軍陣亡2.2萬 英軍僅69人 真全怪武器落後嗎?'],
  ['名相冯道：历仕五朝八姓十一帝，忠臣的标准，在乱世还成立吗？ @FHZDN', '名相冯道：历仕五朝八姓十一帝 忠臣的标准 在乱世还成立吗？'],
  ['朱棣1399年起兵｜1402年攻入南京', '朱棣1399年起兵 1402年攻入南京'],
  ['朱棣为何起兵？', '朱棣为何起兵？'],
  ['一百集：' + '历史主题原文'.repeat(12), '历史主题原文'.repeat(12)],
]) {
  test(`source cover keeps original wording after removing metadata: ${sourceTitle}`, async () => {
    const result = await enhanceCoverPrompt({ sourceTitle, episodeContent: script, roughPrompt: '', publishingCopy: true,
      publishingVariant: { videoId: 2, producer: 'motion', otherPackages: [{ producer: 'huasheng', title: expected, mainTitle: expected, imagePrompt: '' }] } },
    async () => assert.fail('original title cleanup and screenshots must not call AI'))
    assert.equal(result.video_title, expected)
    assert.equal(result.baijiahao_title, expected)
    assert.equal(result.main_title, expected)
    assert.equal(result.sub_title, '')
    assert.equal(result.kicker, '')
    assert.equal(result.image_prompt, '')
    const plan = coverEditorialPlanSchema.parse(result.editorial_plan)
    assert.equal(hasCompleteCoverPlan(plan), true)
    assert.equal(hasCompleteCoverPlan({ ...plan, candidates: plan.candidates.map(candidate => ({ ...candidate, main_title: '凭空创作的新标题' })) }), false)
  })
}

test('an empty or metadata-only original cannot invent a title from the script', async () => {
  for (const sourceTitle of ['', '第12集｜欢迎订阅']) {
    await assert.rejects(enhanceCoverPrompt({ sourceTitle, episodeContent: script, roughPrompt: '', publishingCopy: true },
      async () => assert.fail('no model call')), /原标题/)
  }
})

test('a full-length narration can persist a screenshot plan without oversized evidence records', async () => {
  const longScript = '朱棣在1399年起兵，三年后进入南京。'.repeat(300)
  const result = await enhanceCoverPrompt({ sourceTitle: '朱棣为何起兵？', episodeContent: longScript, roughPrompt: '', publishingCopy: true },
    async () => assert.fail('no model call'))
  const plan = coverEditorialPlanSchema.parse(result.editorial_plan)
  assert.equal(hasCompleteCoverPlan(plan), true)
  assert.ok(plan.candidates.every(candidate => candidate.evidence.every(quote => longScript.includes(quote))))
})
