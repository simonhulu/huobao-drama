import { describe, it, before } from 'node:test'
import assert from 'node:assert'
import { db, schema } from '../db/index.js'
import { composeRecapForEpisode } from './recap-composer.js'
import { now } from '../utils/response.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let testDramaId = 0
let testEpisode2Id = 0

describe('recap composer', () => {
  before(() => {
    const ts = now()
    const dramaRes = db.insert(schema.dramas).values({
      title: 'Recap Test Drama',
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    testDramaId = Number(dramaRes.lastInsertRowid)

    const ep1Res = db.insert(schema.episodes).values({
      dramaId: testDramaId,
      episodeNumber: 1,
      title: '第1集',
      content: 'previous episode content',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const ep1Id = Number(ep1Res.lastInsertRowid)

    const framePath = path.join(__dirname, '../../../data/static/recaps/test-frame.jpg')
    fs.mkdirSync(path.dirname(framePath), { recursive: true })
    if (!fs.existsSync(framePath)) {
      fs.writeFileSync(framePath, Buffer.from('fake-image'))
    }

    db.insert(schema.storyboards).values({
      episodeId: ep1Id,
      storyboardNumber: 1,
      firstFrameImage: 'static/recaps/test-frame.jpg',
      duration: 8,
      createdAt: ts,
      updatedAt: ts,
    }).run()

    const ep2Res = db.insert(schema.episodes).values({
      dramaId: testDramaId,
      episodeNumber: 2,
      title: '第2集',
      content: 'current episode content',
      recapScript: '上一集，主角发现了关键线索。',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    testEpisode2Id = Number(ep2Res.lastInsertRowid)
  })

  it('returns null for episode 1', async () => {
    const result = await composeRecapForEpisode({
      episodeId: testEpisode2Id,
      episodeNumber: 1,
      recapScript: 'test',
      dramaId: testDramaId,
    })
    assert.strictEqual(result, null)
  })

  it('returns null when recap script is empty', async () => {
    const result = await composeRecapForEpisode({
      episodeId: testEpisode2Id,
      episodeNumber: 2,
      recapScript: '   ',
      dramaId: testDramaId,
    })
    assert.strictEqual(result, null)
  })

  it('composes recap video using mocked TTS and ffmpeg', async () => {
    const captured: { args?: string[]; audioPath?: string } = {}
    const result = await composeRecapForEpisode({
      episodeId: testEpisode2Id,
      episodeNumber: 2,
      recapScript: '上一集，主角发现了关键线索。',
      dramaId: testDramaId,
    }, {
      generateTTS: async (text) => {
        captured.audioPath = `/tmp/mock-tts-${text.length}.m4a`
        return captured.audioPath
      },
      runFfmpeg: async (args) => {
        captured.args = args
      },
    })
    assert.strictEqual(result, `static/recaps/${testEpisode2Id}-recap.mp4`)
    assert.ok(captured.audioPath)
    assert.ok(captured.args)
    assert.ok(captured.args!.some(a => a.includes(`${testEpisode2Id}-recap.mp4`)))
  })
})
