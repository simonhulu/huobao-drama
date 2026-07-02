import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createIntroComposeHandler } from './intro-compose.js'

describe('intro compose handler', () => {
  it('exists and exposes run function', () => {
    const handler = createIntroComposeHandler()
    assert.strictEqual(typeof handler.run, 'function')
    assert.strictEqual(handler.resumable, true)
    assert.strictEqual(handler.maxAttempts, 2)
  })
})
