import test from 'node:test'
import assert from 'node:assert/strict'
import { inferAudioProfile, pickBgmPromptVariant } from './audio-profile.js'

test('inferAudioProfile returns 3 prompt variants per emotion bucket', () => {
  const profile = inferAudioProfile('大战 战争 英雄 拯救 宏大 史诗', 'high')
  assert.equal(profile.emotionBucket, 'epic')
  assert.equal(profile.bgmIntensity, 'high')
  assert.equal(profile.bgmPromptVariants.length, 3)
  assert.ok(profile.bgmPromptVariants.every(p => p.includes('no vocals')))
  assert.ok(profile.bgmPromptVariants.some(p => p.includes('orchestral') || p.includes('brass') || p.includes('drums')))
})

test('inferAudioProfile uses historical Chinese instruments for ancient settings', () => {
  const profile = inferAudioProfile('古代 王朝 皇帝 宫廷 宫殿', 'high')
  assert.equal(profile.emotionBucket, 'epic')
  assert.ok(profile.bgmPromptVariants.some(p => /guzheng|erhu|pipa|Chinese percussion/.test(p)))
})

test('inferAudioProfile uses sci-fi synth for futuristic settings', () => {
  const profile = inferAudioProfile('科幻 未来 太空 飞船 机器人', 'medium')
  assert.equal(profile.emotionBucket, 'mysterious')
  assert.ok(profile.bgmPromptVariants.some(p => /synth|cyberpunk|analog/.test(p)))
})

test('pickBgmPromptVariant rotates by storyboard number', () => {
  const profile = inferAudioProfile('紧张 危机 恐惧', 'high')
  const a = pickBgmPromptVariant(profile, 1)
  const b = pickBgmPromptVariant(profile, 2)
  const c = pickBgmPromptVariant(profile, 3)
  const d = pickBgmPromptVariant(profile, 4)
  assert.notEqual(a, b)
  assert.notEqual(b, c)
  assert.equal(a, d) // 3 variants cycle
})

test('inferAudioProfile provides sfx descriptions for explicit actions', () => {
  const profile = inferAudioProfile('他推开门，快步跑过街道，手机突然响了', 'medium')
  assert.ok(profile.sfxDescriptions.some(d => d.includes('门')))
  assert.ok(profile.sfxDescriptions.some(d => d.includes('脚步')))
  assert.ok(profile.sfxDescriptions.some(d => d.includes('手机')))
})
