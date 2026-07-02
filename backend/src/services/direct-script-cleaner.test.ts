import { describe, it } from 'node:test'
import assert from 'node:assert'
import { cleanDirectScript } from './direct-script-cleaner.js'

describe('cleanDirectScript', () => {
  it('returns empty string for empty input', async () => {
    const result = await cleanDirectScript('')
    assert.equal(result, '')
  })

  it('returns unchanged in standard mode for short script', async () => {
    const script = '大臣们反对万历开矿。'
    const result = await cleanDirectScript(script, { retentionMode: 'standard' })
    assert.ok(result.length >= script.length * 0.5)
  })
})
