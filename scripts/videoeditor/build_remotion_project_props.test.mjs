import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const builder = path.join(root, 'scripts/videoeditor/build_remotion_project_props.mjs')
const imagePath = 'static/images/20dc6b9f-e26e-4b1e-9013-5cfcefe063ce.png'
const audioPath = 'static/audio/5d40dcc1-6ab7-4301-9029-9c7913e8a87a.m4a'

function snapshotFor(shots, metadata = null) {
  return {
    project: {
      id: 99,
      sourceEpisodeId: 7,
      title: '测试项目',
      updatedAt: '2026-07-21T00:00:00.000Z',
      metadata,
      sourceSnapshot: {
        episode: { id: 7, episodeNumber: 1, title: '测试集', content: '' },
        storyboards: [],
      },
    },
    shots,
  }
}

function legacyShot() {
  return {
    id: 1,
    sourceStoryboardId: 1,
    shotNumber: 1,
    title: 'Legacy 镜头',
    narration: '保留旧渲染路径。',
    dialogue: '',
    durationMs: 1000,
    shotType: 'ai_plate',
    visualPlan: { visualMode: 'ai-plate', beats: [] },
    sourceEvidence: { legacyAsset: imagePath },
    assets: [],
  }
}

function temporalShot() {
  return {
    id: 1,
    sourceStoryboardId: 1,
    shotNumber: 1,
    title: 'Temporal 镜头',
    narration: '保留时间网格路径。',
    dialogue: '',
    durationMs: 1000,
    shotType: 'graphic',
    visualPlan: {
      visualMode: 'temporal-2grid',
      assetStrategy: 'temporal-2grid-remotion',
      temporalGrid: {
        sheetAssetKey: 'sheet-1',
        panels: [
          { index: 0, semantic: '起始状态' },
          { index: 1, semantic: '结果状态' },
        ],
        keyframes: [
          { atMs: 0, panel: 0 },
          { atMs: 500, panel: 1 },
        ],
      },
      camera: { preset: 'static' },
      transition: { mode: 'crossfade', effect: 'dissolve' },
    },
    sourceEvidence: {},
    assets: [{ assetKey: 'sheet-1', assetType: 'map', localPath: imagePath }],
  }
}

function magnatesRecipe(shot, durationInFrames = 30) {
  return {
    schemaVersion: 'magnates-remotion-recipe-v1',
    fps: 30,
    durationInFrames,
    shots: [{
      id: 'contract-shot',
      durationInFrames: 30,
      background: { src: imagePath, kind: 'image' },
      ...shot,
    }],
  }
}

function startApi(snapshot, assets = []) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const body = pathname.endsWith('/assets') ? { data: assets } : { data: snapshot }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  server.listen(0, '127.0.0.1')
  return once(server, 'listening').then(() => ({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  }))
}

async function runBuilder({ snapshot, assets = [], recipe = null }) {
  const { server, base } = await startApi(snapshot, assets)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotion-props-test-'))
  const outputPath = path.join(tempDir, 'props.json')
  const args = [builder, '--project-id', '99', '--api', `${base}/api/v1`, '--static-base', base, '--output', outputPath]
  let recipePath = null
  if (recipe) {
    recipePath = path.join(tempDir, 'recipe.json')
    fs.writeFileSync(recipePath, JSON.stringify(recipe))
    args.push('--recipe', recipePath)
  }
  const child = spawn(process.execPath, args, { cwd: root })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const [result] = await once(child, 'close')
  server.close()
  await once(server, 'close').catch(() => {})
  return {
    code: result,
    stdout,
    stderr,
    props: fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null,
  }
}

test('explicit Magnates recipe builds typed props with real asset URLs', async () => {
  const recipe = {
    schemaVersion: 'magnates-remotion-recipe-v1',
    fps: 30,
    durationInFrames: 60,
    title: 'Recipe test',
    shots: [
      {
        id: 'hook',
        durationInFrames: 30,
        background: { src: imagePath, kind: 'image', fit: 'cover' },
        camera: { preset: 'push-in', intensity: 0.7, focus: { x: 0.4, y: 0.5 } },
        transitionIn: { class: 'matte_transition', frames: 10 },
        texts: [{ subject: 'headline', text: 'A decision', startFrame: 0, endFrame: 24, entry: 'type_on' }],
        graphics: [{ kind: 'underline', subject: 'headline underline', startFrame: 5, endFrame: 24 }],
      },
      {
        id: 'reversal',
        durationInFrames: 30,
        background: { src: imagePath, kind: 'image' },
        camera: { preset: 'whip' },
        transitionOut: { class: 'distortion', frames: 8 },
      },
    ],
  }
  const result = await runBuilder({ snapshot: snapshotFor([]), recipe })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.props.compositionId, 'MagnatesEditorial')
  assert.equal(result.props.kind, 'magnates-editorial-recipe-props')
  assert.equal(result.props.durationInFrames, 60)
  assert.equal(result.props.shots.length, 2)
  assert.match(result.props.shots[0].background.src, /127\.0\.0\.1:\d+\/static\/images\//)
  assert.equal(result.props.shots[0].camera.preset, 'push_in')
  assert.equal(result.props.shots[0].transitionIn.class, 'matte_transition')
  assert.equal(result.props.shots[0].texts[0].entry, 'type_on')
  assert.equal(result.props.shots[0].graphics[0].kind, 'underline')
})

test('explicit Magnates recipes fail instead of repairing missing semantic contracts', async () => {
  const cases = [
    {
      name: 'missing background',
      recipe: magnatesRecipe({ background: {} }),
      error: /background\.src is required/,
    },
    {
      name: 'generic subject',
      recipe: magnatesRecipe({ texts: [{ subject: 'text', text: 'Claim', startFrame: 0, endFrame: 10 }] }),
      error: /requires a concrete subject/,
    },
    {
      name: 'unbound counter',
      recipe: magnatesRecipe({ texts: [{ subject: 'market value', type: 'counter', from: 0, to: 10, startFrame: 0, endFrame: 10 }] }),
      error: /requires unit and period/,
    },
    {
      name: 'invalid cue range',
      recipe: magnatesRecipe({ texts: [{ subject: 'decision headline', text: 'No', startFrame: 12, endFrame: 8 }] }),
      error: /cue frame range must satisfy/,
    },
    {
      name: 'unsupported camera',
      recipe: magnatesRecipe({ camera: { preset: 'orbit' } }),
      error: /camera preset is unsupported/,
    },
    {
      name: 'duration mismatch',
      recipe: magnatesRecipe({}, 40),
      error: /differs from shot sum 30 by more than one frame/,
    },
  ]

  for (const item of cases) {
    const result = await runBuilder({ snapshot: snapshotFor([]), recipe: item.recipe })
    assert.notEqual(result.code, 0, item.name)
    assert.match(result.stderr, item.error, item.name)
    assert.equal(result.props, null, item.name)
  }
})

test('explicit Magnates recipe rejects narration audio that does not match its timeline', async () => {
  const result = await runBuilder({
    snapshot: snapshotFor([]),
    recipe: magnatesRecipe({}),
    assets: [{ assetKey: 'narration', assetType: 'audio', status: 'completed', localPath: audioPath, durationMs: 2000 }],
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /audio duration 60 frames does not match recipe duration 30/)
  assert.equal(result.props, null)
})

test('legacy snapshot remains EpisodeShowcase without an explicit recipe', async () => {
  const result = await runBuilder({ snapshot: snapshotFor([legacyShot()]) })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.props.compositionId, 'EpisodeShowcase')
  assert.equal(result.props.shots[0].visualMode, 'ai-plate')
})

test('temporal snapshot remains TemporalGridEpisode without an explicit recipe', async () => {
  const result = await runBuilder({
    snapshot: snapshotFor([temporalShot()]),
    assets: [{ assetKey: 'narration', assetType: 'audio', status: 'completed', localPath: audioPath, durationMs: 1000 }],
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.props.compositionId, 'TemporalGridEpisode')
  assert.equal(result.props.visualMode, 'temporal-2grid')
  assert.equal(result.props.shots[0].gridLayout, '2x1')
})
