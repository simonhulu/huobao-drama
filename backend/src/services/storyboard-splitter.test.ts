import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateReadingDurationSeconds,
  splitTextIntoChunks,
  splitStoryboardForDirectScript,
  expandDirectScriptStoryboards,
  DEFAULT_DIRECT_SCRIPT_MAX_DURATION_SECONDS,
} from './storyboard-splitter.js'

test('estimateReadingDurationSeconds rounds up for Chinese text', () => {
  // 4.5 chars/s -> 18 chars ~= 4s, 36 chars ~= 8s, 40 chars ~= 9s
  assert.equal(estimateReadingDurationSeconds('一二三四五六七八'), 2)
  assert.equal(estimateReadingDurationSeconds('一二三四五六七八九'), 2)
  assert.equal(estimateReadingDurationSeconds('a'.repeat(40)), 5)
})

test('splitTextIntoChunks distributes clauses evenly', () => {
  const text = '第一镜，第二镜，第三镜，第四镜。'
  const chunks = splitTextIntoChunks(text, 2)
  assert.equal(chunks.length, 2)
  assert.ok(chunks[0].includes('第一镜'))
  assert.ok(chunks[1].includes('第四镜'))
})

test('splitStoryboardForDirectScript leaves short shots unchanged', () => {
  const sb = {
    shot_number: 1,
    title: '短镜头',
    description: '短短一段话。',
    duration: 5,
  }
  const result = splitStoryboardForDirectScript(sb)
  assert.equal(result.length, 1)
  assert.equal(result[0].duration, 5)
})

test('splitStoryboardForDirectScript splits long text into <=8s shots', () => {
  // 90 Chinese chars ~= 20s reading time -> 3 shots
  const description = '这是一段很长的原文，用来测试direct_script模式下长文本会被自动拆分成多个不超过八秒的子镜头，每个子镜头各自对应一段原文并生成独立的图片提示词。'.repeat(2)
  const sb = {
    shot_number: 1,
    title: '长段落',
    description,
    action: '人物走动',
    location: '街道',
    time: '黄昏',
    atmosphere: '紧张',
    duration: 20,
    image_prompt: '旧图',
    video_prompt: '旧视频',
  }
  const result = splitStoryboardForDirectScript(sb, { aspectRatio: '9:16', style: 'cinematic' })
  assert.ok(result.length > 1, 'should split into multiple shots')
  for (const shot of result) {
    assert.ok((shot.duration || 0) <= DEFAULT_DIRECT_SCRIPT_MAX_DURATION_SECONDS, `shot duration ${shot.duration} exceeds 8s`)
    assert.ok(shot.image_prompt && shot.image_prompt !== '旧图', 'each split shot should have a rebuilt image prompt')
  }
})

test('expandDirectScriptStoryboards renumbers sequentially', () => {
  const storyboards = [
    { shot_number: 5, title: 'A', description: '短。', duration: 4 },
    { shot_number: 2, title: 'B', description: '这是一段很长的原文，需要被拆分。'.repeat(5), duration: 10 },
  ]
  const result = expandDirectScriptStoryboards(storyboards)
  assert.deepEqual(result.map(sb => sb.shot_number), [1, 2, 3, 4])
  assert.ok((result[0].duration || 0) <= DEFAULT_DIRECT_SCRIPT_MAX_DURATION_SECONDS)
})
