import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createRecapComposeHandler } from './recap-compose.js'

describe('recap compose handler', () => {
  it('exists and exposes run function', () => {
    const handler = createRecapComposeHandler()
    assert.strictEqual(typeof handler.run, 'function')
    assert.strictEqual(handler.resumable, true)
    assert.strictEqual(handler.maxAttempts, 2)
  })
})
