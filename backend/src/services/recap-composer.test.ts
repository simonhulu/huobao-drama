import { describe, it, before } from 'node:test'
import assert from 'node:assert'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { composeRecapForEpisode } from './recap-composer.js'
import { now } from '../utils/response.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let testDramaId = 0
let testEpisode2Id = 0
let testEpisode3Id = 0
let mockAudioPath = ''

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'ignore' })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code}`))
    })
  })
}

describe('recap composer', () => {
  const ts = now()
  before(async () => {
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
      openingHook: '主角发现了关键线索',
      cliffhanger: '而真正的幕后黑手，竟然是他',
      recapScript: '上一集，主角发现了关键线索，幕后黑手浮出水面。危机才刚刚开始。',
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
      createdAt: ts,
      updatedAt: ts,
    }).run()
    testEpisode2Id = Number(ep2Res.lastInsertRowid)

    mockAudioPath = path.join(__dirname, '../../../data/static/recaps/mock-recap-audio.m4a')
    fs.mkdirSync(path.dirname(mockAudioPath), { recursive: true })
    if (!fs.existsSync(mockAudioPath)) {
      await runCommand('ffmpeg', [
        '-f', 'lavfi',
        '-i', 'anullsrc=r=24000:cl=mono',
        '-t', '5',
        '-c:a', 'aac',
        '-ar', '24000',
        '-ac', '1',
        '-y',
        mockAudioPath,
      ])
    }
  })

  it('returns null for episode 1', async () => {
    const result = await composeRecapForEpisode({
      episodeId: testEpisode2Id,
      episodeNumber: 1,
      dramaId: testDramaId,
    })
    assert.strictEqual(result, null)
  })

  it('returns null when previous episode has no recap material', async () => {
    const ep3Res = db.insert(schema.episodes).values({
      dramaId: testDramaId,
      episodeNumber: 3,
      title: '第3集',
      content: 'current episode content',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const ep3Id = Number(ep3Res.lastInsertRowid)
    testEpisode3Id = ep3Id

    db.insert(schema.storyboards).values({
      episodeId: ep3Id,
      storyboardNumber: 1,
      firstFrameImage: 'static/recaps/test-frame.jpg',
      duration: 8,
      createdAt: ts,
      updatedAt: ts,
    }).run()

    const result = await composeRecapForEpisode({
      episodeId: ep3Id,
      episodeNumber: 3,
      dramaId: testDramaId,
    })
    assert.strictEqual(result, null)
  })

  it('composes recap video using recapScript and mocked TTS/remotion', async () => {
    const captured: { text?: string; calls: Array<{ cmd: string; args: string[] }>; audioPath?: string } = { calls: [] }
    const result = await composeRecapForEpisode({
      episodeId: testEpisode2Id,
      episodeNumber: 2,
      dramaId: testDramaId,
    }, {
      generateTTS: async (text) => {
        captured.text = text
        captured.audioPath = mockAudioPath
        return mockAudioPath
      },
      runCommand: async (cmd, args) => {
        captured.calls.push({ cmd, args })
        // Simulate remotion output file creation
        const outputArg = args.find((a) => a.endsWith('-recap.mp4'))
        if (outputArg) {
          fs.mkdirSync(path.dirname(outputArg), { recursive: true })
          fs.writeFileSync(outputArg, Buffer.from('mock-recap-video'))
        }
      },
    })
    assert.strictEqual(result, `static/recaps/${testEpisode2Id}-recap.mp4`)
    assert.strictEqual(captured.text, '上一集，主角发现了关键线索，幕后黑手浮出水面。危机才刚刚开始。')
    assert.ok(captured.audioPath)
    assert.ok(captured.calls.length >= 1, 'expected remotion render call')

    const renderCall = captured.calls.find(c => c.cmd.includes('remotion') && c.args.includes('render'))
    assert.ok(renderCall, 'expected remotion render command')
    assert.ok(renderCall!.args.includes('RecapCarousel'))
    assert.ok(renderCall!.args.some(a => a.includes(`${testEpisode2Id}-recap-props.json`)))
    assert.ok(renderCall!.args.some(a => a.startsWith('--duration-in-frames=')))
  })

  it('falls back to hook/cliffhanger when recapScript is empty', async () => {
    // Set hooks on episode 3 so episode 4 can fall back to them.
    db.update(schema.episodes)
      .set({ openingHook: '主角逼近了真相', cliffhanger: '而真凶的身份即将揭晓' })
      .where(eq(schema.episodes.id, testEpisode3Id))
      .run()

    const ep4Res = db.insert(schema.episodes).values({
      dramaId: testDramaId,
      episodeNumber: 4,
      title: '第4集',
      content: 'current episode content',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const ep4Id = Number(ep4Res.lastInsertRowid)

    db.insert(schema.storyboards).values({
      episodeId: ep4Id,
      storyboardNumber: 1,
      firstFrameImage: 'static/recaps/test-frame.jpg',
      duration: 8,
      createdAt: ts,
      updatedAt: ts,
    }).run()

    let capturedText = ''
    await composeRecapForEpisode({
      episodeId: ep4Id,
      episodeNumber: 4,
      dramaId: testDramaId,
    }, {
      generateTTS: async (text) => {
        capturedText = text
        return mockAudioPath
      },
      runCommand: async (_cmd, args) => {
        const outputArg = args.find((a) => a.endsWith('-recap.mp4'))
        if (outputArg) {
          fs.mkdirSync(path.dirname(outputArg), { recursive: true })
          fs.writeFileSync(outputArg, Buffer.from('mock-recap-video'))
        }
      },
    })
    assert.ok(capturedText.startsWith('上一集'))
    assert.ok(capturedText.includes('主角逼近了真相'))
  })
})
