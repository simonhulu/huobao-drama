import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCoverDesign } from './cover-design-extractor.js'

test('extracts the recommended thumbnail from polish JSON', () => {
  const design = extractCoverDesign({
    thumbnail_designs: [
      {
        type: '冲突型',
        main_title: '盛世是假象',
        sub_title: '繁华背后谁在承担代价',
        ai_prompt: 'cinematic palace and empty street, highly detailed, no text, no watermark',
        rationale: '把制度代价变成可见的空间对照。',
      },
      {
        type: '悬念型',
        main_title: '账本里的秘密',
        sub_title: '一笔银子如何改变所有人',
        ai_prompt: 'cinematic close-up of an old ledger, highly detailed, no text, no watermark',
      },
    ],
    recommended_thumbnail: '封面 B：悬念型',
  }, { episodeTitle: '被隐藏的账本', episodeNumber: 3 })

  assert.equal(design?.main_title, '账本里的秘密')
  assert.equal(design?.kicker, '悬念型')
  assert.equal(design?.episode_label, '第3集')
  assert.equal(design?.brand_label, '')
})

test('extracts a fenced JSON cover_design wrapper', () => {
  const source = `改写后的精稿\n\n\`\`\`json
{
  "cover_design": {
    "type": "命运转折",
    "main_title": "她终于回头",
    "sub_title": "一张诊断单撕开八年婚姻",
    "image_prompt": "cinematic apartment at night, highly detailed, no text, no watermark",
    "accent_color": "#B84A34"
  }
}
\`\`\``

  const design = extractCoverDesign(source, { episodeTitle: '离婚协议' })
  assert.equal(design?.main_title, '她终于回头')
  assert.equal(design?.ai_prompt, 'cinematic apartment at night, highly detailed, no text, no watermark')
  assert.equal(design?.accent_color, '#B84A34')
})

test('extracts the recommended markdown thumbnail section', () => {
  const source = `## 八、封面设计方案

### 封面 A：冲突型
- **建议画幅比**：9:16
- **画面描述**：宫殿与荒街并置，人物站在两种命运之间。
- **主标题文案**：盛世是假象
- **副标题文案**：繁华背后谁在承担代价
- **AI图片生成提示词**：cinematic palace and empty street, highly detailed, no text, no watermark
- **为什么有效**：缩小后仍能读出强烈反差。

### 封面 B：悬念型
- **建议画幅比**：3:4
- **画面描述**：一册旧账本压住半明半暗的手。
- **主标题文案**：账本里的秘密
- **副标题文案**：一笔银子如何改变所有人
- **AI图片生成提示词**：cinematic old ledger close-up, highly detailed, no text, no watermark
- **为什么有效**：具体物件制造追问。

### 推荐
推荐使用封面 B。
`

  const design = extractCoverDesign(source, { episodeTitle: '制度危机', episodeNumber: 8 })
  assert.equal(design?.main_title, '账本里的秘密')
  assert.equal(design?.sub_title, '一笔银子如何改变所有人')
  assert.equal(design?.recommended_aspect_ratio, '3:4')
  assert.match(design?.ai_prompt || '', /old ledger close-up/)
})

test('returns null for ordinary screenplay text', () => {
  const design = extractCoverDesign('## S01 | 内景 · 客厅 | 深夜\n林夏站在门后，没有回头。', {
    episodeTitle: '离婚协议',
  })
  assert.equal(design, null)
})
