import test from 'node:test'
import assert from 'node:assert/strict'

const { loadAgentSkills } = await import('./skills.js')

test('loadAgentSkills injects narrator skill instructions', () => {
  const content = loadAgentSkills('narrator')
  assert.match(content, /旁白解说指南/)
  assert.match(content, /内心|背景|因果/)
})
