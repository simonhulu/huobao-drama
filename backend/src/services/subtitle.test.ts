import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-subtitle-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { generateAss, generateAssFromTitles, readEpisodeSubtitleConfig, loadTitlesForAudio } = await import('./subtitle.js')

const baseConfig = {
  enabled: true,
  font: 'PingFang SC',
  color: '#FFFFFF',
  size: 48,
  position: 'bottom' as const,
  marginL: 60,
  marginR: 60,
  marginV: 40,
  backgroundColor: null,
  strokeColor: '#000000',
  strokeWidth: 2,
}

test('generateAss produces ASS with configured margins and stroke', () => {
  const ass = generateAss('你好世界', 5, baseConfig)
  assert.ok(ass.includes('Style: Default'))
  assert.ok(ass.includes(',60,60,40,'))
  // 默认无背景时用 BorderStyle=1，描边宽 2，Shadow=0，Alignment=2
  assert.ok(ass.includes(',1,2,0,2,'))
  assert.ok(ass.includes('你好世界'))
})

test('generateAss switches to opaque box when background color is set', () => {
  const ass = generateAss('你好世界', 5, { ...baseConfig, backgroundColor: '#00000080' })
  // BorderStyle=3, Outline=0, Shadow=0, Alignment=2
  assert.ok(ass.includes(',3,0,0,2,'))
  // 半透明黑色的 BGRA 表示
  assert.ok(ass.includes('&H80000000'))
})

test('generateAssFromTitles creates timed Dialogue events', () => {
  const titles = [
    { text_begin: 0, text_end: 2, time_begin: 0, time_end: 800, text: '你好' },
    { text_begin: 2, text_end: 4, time_begin: 800, time_end: 1600, text: '世界' },
  ]
  const ass = generateAssFromTitles(titles, '你好世界', 2, baseConfig)
  const lines = ass.split('\n')
  const dialogues = lines.filter(l => l.startsWith('Dialogue:'))
  assert.equal(dialogues.length, 2)
  assert.ok(dialogues[0].includes('0:00:00.00'))
  assert.ok(dialogues[1].includes('0:00:00.80'))
  assert.ok(dialogues[0].includes('你好'))
  assert.ok(dialogues[1].includes('世界'))
})

test('generateAssFromTitles falls back to static ASS when titles are empty', () => {
  const ass = generateAssFromTitles([], '你好世界', 2, baseConfig)
  const dialogues = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
  assert.equal(dialogues.length, 1)
  assert.ok(dialogues[0].includes('你好世界'))
})

test('generateAssFromTitles splits sentence-level title into multiple cues', () => {
  const titles = [
    {
      text: '第一句。第二句！第三句？',
      text_begin: 0,
      text_end: 14,
      time_begin: 0,
      time_end: 12000,
    },
  ]
  const ass = generateAssFromTitles(titles, '第一句。第二句！第三句？', 12, baseConfig)
  const dialogues = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
  assert.equal(dialogues.length, 3)
  assert.ok(dialogues[0].includes('第一句。'))
  assert.ok(dialogues[1].includes('第二句！'))
  assert.ok(dialogues[2].includes('第三句？'))
  // 时间应被按比例拆分
  assert.ok(dialogues[0].includes('0:00:00.00'))
  assert.ok(dialogues[2].includes('0:00:12.00'))
})

test('readEpisodeSubtitleConfig maps episode columns to config', () => {
  const ep = {
    subtitleEnabled: true,
    subtitleFont: 'Arial',
    subtitleColor: '#FF0000',
    subtitleSize: 36,
    subtitlePosition: 'top',
    subtitleMargin: 80,
    subtitleMarginV: 60,
    subtitleBackgroundColor: '#000000',
    subtitleStrokeColor: '#FFFFFF',
    subtitleStrokeWidth: 3,
  } as any
  const cfg = readEpisodeSubtitleConfig(ep)
  assert.equal(cfg.font, 'Arial')
  assert.equal(cfg.color, '#FF0000')
  assert.equal(cfg.size, 36)
  assert.equal(cfg.position, 'top')
  assert.equal(cfg.marginL, 80)
  assert.equal(cfg.marginR, 80)
  assert.equal(cfg.marginV, 60)
  assert.equal(cfg.backgroundColor, '#000000')
  assert.equal(cfg.strokeColor, '#FFFFFF')
  assert.equal(cfg.strokeWidth, 3)
})

test('loadTitlesForAudio loads ${audio}.titles.json next to the audio file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'huobao-titles-'))
  const audioPath = join(tmp, 'fake.m4a')
  writeFileSync(audioPath, '')
  writeFileSync(`${audioPath}.titles.json`, JSON.stringify({
    text: '你好世界',
    titles: [{ text: '你好', time_begin: 0, time_end: 500 }],
  }))

  const loaded = loadTitlesForAudio(audioPath)
  assert.ok(loaded)
  assert.equal(loaded?.text, '你好世界')
  assert.equal(loaded?.titles.length, 1)
})

test('loadTitlesForAudio returns null when titles file is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'huobao-titles-'))
  const audioPath = join(tmp, 'no-titles.m4a')
  writeFileSync(audioPath, '')
  const loaded = loadTitlesForAudio(audioPath)
  assert.equal(loaded, null)
})
