import { describe, it } from 'node:test'
import assert from 'node:assert'
import introTemplatesApp from './introTemplates.js'

describe('intro templates routes', () => {
  it('lists intro templates', async () => {
    const res = await introTemplatesApp.request('/')
    assert.strictEqual(res.status, 200)
    const json = await res.json()
    assert.ok(Array.isArray(json.data))
  })
})
