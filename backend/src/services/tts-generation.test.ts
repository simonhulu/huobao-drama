import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-tts-limiter-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const { TTSGenerationLimiter } = await import('./tts-generation.js')

test('TTSGenerationLimiter caps executions per interval', async () => {
  const limiter = new TTSGenerationLimiter(10, 100, 2)
  const start = Date.now()
  const starts: number[] = []

  const jobs = Array.from({ length: 4 }, async (_, i) => {
    await limiter.run(async () => {
      starts.push(Date.now() - start)
      return i
    })
  })

  await Promise.all(jobs)

  assert.equal(starts.length, 4)
  assert.ok(starts[1] < 10, `second job started at ${starts[1]}ms`)
  assert.ok(starts[2] >= 90, `third job started at ${starts[2]}ms`)
  assert.ok(starts[3] >= 90, `fourth job started at ${starts[3]}ms`)
})

test('TTSGenerationLimiter caps concurrent executions', async () => {
  const limiter = new TTSGenerationLimiter(2, 60_000, 100)
  let running = 0
  let maxRunning = 0

  const jobs = Array.from({ length: 6 }, async (_, i) => {
    await limiter.run(async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      return i
    })
  })

  await Promise.all(jobs)

  assert.equal(maxRunning, 2)
  assert.equal(running, 0)
})
