import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePrompt, stripVideoTags, truncatePrompt, PROVIDER_PROMPT_LIMITS } from './prompt-utils.js'

test('stripVideoTags removes location, voice, n tags', () => {
  const prompt = '0-3秒：<location>咖啡厅</location>，<role>小明</role>低头看手机。<n>3-6秒：全景，<voice>旁白</voice>。'
  const result = stripVideoTags(prompt)
  assert.equal(result.includes('<location>'), false)
  assert.equal(result.includes('<voice>'), false)
  assert.equal(result.includes('<n>'), false)
  assert.equal(result.includes('咖啡厅'), true)
  assert.equal(result.includes('小明'), true)
  assert.equal(result.includes('旁白'), true)
})

test('stripVideoTags removes role tags leaving name', () => {
  const prompt = '中景，<role>郑大命</role>坐在椅子上'
  assert.equal(stripVideoTags(prompt), '中景，郑大命坐在椅子上')
})

test('truncatePrompt shortens long prompts', () => {
  const prompt = 'a'.repeat(2000)
  assert.equal(truncatePrompt(prompt, 1500).length, 1500)
})

test('normalizePrompt enforces provider limits', () => {
  const prompt = 'a'.repeat(3000)
  assert.equal(normalizePrompt(prompt, 'minimax').length, PROVIDER_PROMPT_LIMITS.minimax)
  assert.equal(normalizePrompt(prompt, 'openai').length, prompt.length)
})

test('normalizePrompt strips video tags and truncates', () => {
  const prompt = '<location>仓库</location>，' + 'a'.repeat(1600)
  const result = normalizePrompt(prompt, 'minimax')
  assert.equal(result.includes('<location>'), false)
  assert.ok(result.length <= PROVIDER_PROMPT_LIMITS.minimax)
})
