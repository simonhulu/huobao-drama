import test from 'node:test'
import assert from 'node:assert/strict'

test('grid review prompt audits direct silent-readable narration evidence', async () => {
  const mod: any = await import('./grid-review.js')
  assert.equal(typeof mod.buildGridReviewSystemPrompt, 'function')
  const prompt = mod.buildGridReviewSystemPrompt()
  assert.match(prompt, /reality_ok/)
  assert.match(prompt, /camera_access_ok/)
  assert.match(prompt, /documentary_genre_ok/)
  assert.match(prompt, /当前旁白/)
  assert.match(prompt, /现实生活/)
  assert.match(prompt, /静音可读/)
  assert.match(prompt, /直接可见证据/)
  assert.match(prompt, /记者询问.*泛化调查 B-roll/)
  assert.match(prompt, /直接事件.*后果痕迹.*后期信息层/)
  assert.match(prompt, /注意力锚点/)
  assert.match(prompt, /应先拆镜/)
})

test('grid review user context includes the final Remotion graphic as visual evidence', async () => {
  const mod: any = await import('./grid-review.js')
  const text = mod.buildGridReviewUserText({
    dramaTitle: '骗子之子',
    narration: '死了，他还要用假名下葬。',
    location: '1906年伊利诺伊墓园',
    time: '1906年5月',
    expectedDesc: '闭合棺木正在下降。',
    graphic: { type: 'identity_reveal', aliasLabel: '下葬姓名', alias: 'William Livingston', verdict: '仍是假名' },
  })
  assert.match(text, /后期信息层/)
  assert.match(text, /William Livingston/)
  assert.match(text, /预期描述.*不是事实依据/)
})

test('grid review parser requires the complete reality contract', async () => {
  const mod: any = await import('./grid-review.js')
  assert.equal(typeof mod.parseGridReviewJson, 'function')

  const rejected = mod.parseGridReviewJson(JSON.stringify({
    narration_match: true,
    era_ok: true,
    text_clean: true,
    reality_ok: false,
    camera_access_ok: true,
    documentary_genre_ok: false,
    issues: ['墓穴旁开棺缺少现实依据'],
  }))
  assert.equal(rejected?.reality_ok, false)
  assert.equal(rejected?.documentary_genre_ok, false)

  assert.equal(mod.parseGridReviewJson(JSON.stringify({
    info_match: true,
    era_ok: true,
    text_clean: true,
    issues: [],
  })), null)
})
