import { describe, it } from 'node:test'
import assert from 'node:assert'
import { createHookDesignHandler } from './hook-design.js'

describe('hook design handler', () => {
  it('exists and exposes run function', () => {
    const handler = createHookDesignHandler()
    assert.strictEqual(typeof handler.run, 'function')
    assert.strictEqual(handler.resumable, true)
    assert.strictEqual(handler.maxAttempts, 2)
  })
})
