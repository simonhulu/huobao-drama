import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { HuashengMaterialLibrary } from '../../src/services/huasheng-material-library.mjs'
import { collect, collectAll, downloadVideo, parseOptions } from './collect-recommendations.mjs'

const projectIds = ['260077122691088', '260004813045809', '260003332222111']
const media = { duration: 12.5, width: 1920, height: 1080, codec: 'h264' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const candidate = (pid, index) => {
  const id = index === 0 ? 'shared-source' : `${pid}-asset-${index + 1}`
  return { id, url: `https://media.example/${pid}/${id}.mp4`, cover: `https://media.example/${pid}/${id}.jpg`, material_type: 1, duration: 24 }
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huasheng-all-projects-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', () => assert.fail('batch tests must not access the network'))
  const options = parseOptions(['--all-projects', '--output', root, '--database', path.join(root, 'materials.db')])
  return { root, options }
}

function fixture(ids = projectIds.slice(0, 2), { sharedAssets = true } = {}) {
  const projects = ids.map(pid => ({ pid, name: `project ${pid}` }))
  const data = new Map(ids.map(pid => [pid, {
    project: { pid, name: `project ${pid}`, is_agent_sandbox: true },
    clips: [{ id: '100001', idx: '1', content: `narration ${pid}`, video: candidate(pid, 0), voice: { duration: 5 } }],
  }]))
  const calls = { lists: 0, projects: [], recommendations: [], downloads: [] }
  return {
    data, calls,
    client: {
      projects: async () => { calls.lists++; return projects },
      project: async pid => {
        calls.projects.push(pid)
        assert.ok(data.has(pid), 'only projects in the list may be requested')
        return { data: data.get(pid), prefix: '/api/v2/innovideo' }
      },
      recommendations: async (pid, clip, prefix) => {
        calls.recommendations.push(pid)
        assert.equal(clip.id, '100001')
        assert.equal(prefix, '/api/v2/innovideo')
        return { query: `label ${pid}`, querySource: 'recommendations.query', total: 4, candidates: Array.from({ length: 4 }, (_, index) => {
          const item = candidate(pid, index)
          return sharedAssets ? item : { ...item, id: `${pid}-${item.id}` }
        }) }
      },
    },
    download: (url, filename, args) => downloadVideo(url, filename, {
      ...args, probe: async () => media,
      fetch: async () => {
        calls.downloads.push({ url, filename })
        const bytes = Buffer.from(`fixture video for ${path.posix.basename(new URL(url).pathname)}`)
        return new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } })
      },
    }),
    log() {},
  }
}

async function readJson(filename) { return JSON.parse(await fs.readFile(filename, 'utf8')) }
async function absent(filename) { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }) }
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function inspectDatabase(options, inspect) {
  const library = new HuashengMaterialLibrary({ databasePath: options.database })
  try { return inspect(library) }
  finally { library.close() }
}

test('all-projects CLI options select a batch directory and reject conflicting modes', () => {
  const root = path.resolve('fixture-batch-output')
  const database = path.join(root, 'materials.db')
  const options = parseOptions(['--all-projects', '--output', root, '--database', database])
  assert.equal(options.allProjects, true)
  assert.equal(options.output, root)
  assert.equal(options.database, database)
  assert.equal(options.pid, undefined)
  assert.equal(options.projectConcurrency, 1)
  assert.equal(parseOptions(['--all-projects']).output, fileURLToPath(new URL('../../../data/huasheng-recommendations', import.meta.url)))
  assert.equal(parseOptions(['--all-projects', '--metadata-only', '--limit', '2']).metadataOnly, true)
  for (const value of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '16']) {
    assert.equal(parseOptions(['--all-projects', '--project-concurrency', value]).projectConcurrency, Number(value))
  }
  for (const value of ['0', '-1', '17', '1.5', 'Infinity']) {
    assert.throws(() => parseOptions(['--all-projects', '--project-concurrency', value]), /integer from 1 to 16/)
  }
  assert.throws(() => parseOptions(['--all-projects', '--project-concurrency']), /requires a value/)
  assert.throws(() => parseOptions(['--project', projectIds[0], '--project-concurrency', '2']), /requires --all-projects/)
  for (const otherMode of [['--project', projectIds[0]], ['--stats'], ['--search', 'history'], ['--import-existing']]) {
    assert.throws(() => parseOptions(['--all-projects', ...otherMode]), /--all-projects cannot be combined/)
  }
})

test('batch collection isolates identical clip and asset IDs, shares one database and writes its report', async t => {
  const { root, options } = await setup(t)
  const run = fixture()
  const library = new HuashengMaterialLibrary({ databasePath: options.database })
  try {
    const report = await collectAll(options, { ...run, library })
    assert.equal(run.calls.lists, 1)
    assert.deepEqual(run.calls.projects, projectIds.slice(0, 2))
    assert.deepEqual(report.projects.map(entry => [entry.projectId, entry.title, entry.status, entry.totalClips, entry.downloaded, entry.incompleteClips]),
      projectIds.slice(0, 2).map(pid => [pid, `project ${pid}`, 'done', 1, 3, 0]))
    assert.deepEqual(await readJson(path.join(root, 'batch-report.json')), report)
    assert.equal(run.calls.downloads.length, 5)
    assert.equal(library.stats().projects, 2, 'injected library remains open after the batch')
    assert.equal(library.stats().clips, 2)
    assert.equal(library.stats().recommendations, 8)
    assert.equal(library.stats().files, 6)
    for (const pid of projectIds.slice(0, 2)) {
      const rows = library.search({ projectId: pid, downloadedOnly: false, topOnly: true, limit: 100 })
      assert.equal(rows.length, 3)
      assert.equal(library.stats(pid).files, 3)
      assert.ok(rows.every(row => row.projectId === pid && row.clipId === '100001' && row.query === `label ${pid}` && row.status === 'done'))
      for (const row of rows) {
        assert.ok(row.sourceUrl.includes(`/${pid}/`))
        assert.equal(path.relative(path.join(root, pid), row.localPath), `clips/001/${String(row.rank).padStart(2, '0')}_${row.assetId}.mp4`)
        const bytes = await fs.readFile(row.localPath)
        assert.equal(row.bytes, bytes.length)
        assert.equal(row.sha256, digest(bytes))
      }
      const annotation = await readJson(path.join(root, pid, 'clips/001/annotation.json'))
      assert.equal(annotation.projectId, pid)
      assert.equal(annotation.candidates.length, 4)
      await absent(path.join(root, pid, '.collect.lock'))
    }
  } finally { library.close() }
  await absent(path.join(root, '.all-projects.lock'))
})

test('a repeated batch upserts existing records and reuses every completed local file', async t => {
  const { root, options } = await setup(t)
  const run = fixture()
  await collectAll(options, run)
  const before = inspectDatabase(options, library => library.stats())
  const report = await collectAll(options, run)
  assert.ok(report.projects.every(entry => entry.status === 'done' && entry.downloaded === 3))
  assert.equal(run.calls.downloads.length, 5)
  assert.deepEqual(report.projects.map(entry => entry.reused), [3, 3])
  assert.deepEqual(inspectDatabase(options, library => library.stats()), before)
  assert.ok(inspectDatabase(options, library => library.search()).every(row => row.reused))
  assert.deepEqual(await readJson(path.join(root, 'batch-report.json')), report)
  assert.equal(run.calls.recommendations.length, 2, 'unchanged complete clips must reuse recommendation checkpoints')
  assert.ok(report.projects.every(entry => entry.metadataReadClips === 0 && entry.metadataSkippedClips === 1 && entry.repairedDownloads === 0))
})

test('incremental batches only repair missing or corrupt registered media and leave other files untouched', async t => {
  for (const damage of ['missing', 'corrupt']) await t.test(damage, async t => {
    const { options } = await setup(t)
    const run = fixture()
    await collectAll(options, run)
    const rows = inspectDatabase(options, library => library.search())
    const target = rows.find(row => row.assetId === `${projectIds[0]}-asset-2`)
    const good = rows.filter(row => row.localPath !== target.localPath)
    const unchanged = await Promise.all(good.map(async row => [row.localPath, await fs.stat(row.localPath)]))
    if (damage === 'missing') await fs.unlink(target.localPath)
    else await fs.writeFile(target.localPath, Buffer.alloc(target.bytes, 1))
    const report = await collectAll(options, run)
    assert.ok(report.projects.every(entry => entry.status === 'done'))
    assert.equal(run.calls.recommendations.length, 2, 'missing bytes do not invalidate complete recommendation metadata')
    assert.equal(run.calls.downloads.length, 6, 'only the damaged registered asset should transfer again')
    assert.equal(digest(await fs.readFile(target.localPath)), target.sha256)
    assert.equal(report.projects.reduce((sum, entry) => sum + entry.repairedDownloads, 0), 1)
    for (const [filename, stat] of unchanged) {
      const current = await fs.stat(filename)
      assert.equal(current.ino, stat.ino)
      assert.equal(current.mtimeMs, stat.mtimeMs)
    }
  })
})

test('incremental batches read recommendations only for new projects and changed remote clip metadata', async t => {
  const { options } = await setup(t)
  const run = fixture(projectIds)
  const projects = run.client.projects
  let includeNewProject = false
  run.client.projects = async () => (await projects()).slice(0, includeNewProject ? 3 : 2)
  await collectAll(options, run)
  includeNewProject = true
  run.data.get(projectIds[0]).clips[0].video.query = 'revised remote search query'
  const report = await collectAll(options, run)
  assert.deepEqual(run.calls.recommendations, [projectIds[0], projectIds[1], projectIds[0], projectIds[2]])
  assert.deepEqual(report.projects.map(entry => entry.metadataReadClips), [1, 0, 1])
  assert.deepEqual(report.projects.map(entry => entry.metadataSkippedClips), [0, 1, 0])
  assert.equal(run.calls.downloads.length, 7, 'unchanged assets from the changed clip must not transfer again')
})

test('a newly inserted clip keeps existing clip identity and reuses unchanged recommendations after ordering moves', async t => {
  const { options } = await setup(t)
  const run = fixture(projectIds.slice(0, 1))
  const recommendations = run.client.recommendations
  run.client.recommendations = async (pid, clip, prefix) => clip.id === '100001' ? recommendations(pid, clip, prefix) : {
    query: 'new clip query', querySource: 'recommendations.query', total: 3,
    candidates: ['new-a', 'new-b', 'new-c'].map(id => ({ id, url: `https://media.example/${id}.mp4`, material_type: 1 })),
  }
  await collectAll(options, run)
  const data = run.data.get(projectIds[0])
  data.clips[0].idx = '2'
  data.clips.unshift({ ...structuredClone(data.clips[0]), id: '100002', idx: '1', content: 'newly inserted clip' })
  const report = await collectAll(options, run)
  assert.equal(report.projects[0].status, 'done')
  assert.equal(report.projects[0].metadataReadClips, 1)
  assert.equal(report.projects[0].metadataSkippedClips, 1)
  assert.equal(run.calls.recommendations.length, 1, 'moving an existing clip is not a recommendation change')
  assert.equal(run.calls.downloads.length, 6)
  assert.equal(inspectDatabase(options, library => library.getClip(projectIds[0], '100001', path.join(options.output, projectIds[0]))).order, 2)
})

test('concurrent projects coalesce first downloads of the same asset instead of transferring duplicates', async t => {
  const { options } = await setup(t)
  options.projectConcurrency = 2
  const run = fixture()
  run.client.recommendations = async () => ({ query: 'shared query', querySource: 'recommendations.query', total: 3,
    candidates: Array.from({ length: 3 }, (_, index) => candidate(projectIds[0], index)) })
  const transfers = []
  run.download = (url, filename, args) => downloadVideo(url, filename, { ...args, probe: async () => media,
    fetch: async () => {
      transfers.push(url)
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(`shared fixture ${url}`, { headers: { 'content-type': 'video/mp4' } })
    } })
  const report = await collectAll(options, run)
  assert.ok(report.projects.every(entry => entry.status === 'done'))
  assert.equal(transfers.length, 3)
  assert.equal(report.projects.reduce((sum, entry) => sum + entry.reused, 0), 3)
})

test('structured progress follows settled projects and exposes no media URLs or request credentials', async t => {
  const { options } = await setup(t)
  options.projectConcurrency = 2
  const run = fixture()
  const progress = []
  const report = await collectAll(options, { ...run, onProgress: value => progress.push(value) })
  assert.deepEqual(progress[0], { stage: 'project_list', completedProjects: 0, totalProjects: 0 })
  assert.deepEqual(progress[1], { stage: 'project_list', completedProjects: 0, totalProjects: 2 })
  assert.deepEqual(progress.at(-1), { stage: 'completed', completedProjects: 2, totalProjects: 2 })
  const completions = progress.filter(value => value.stage === 'project_complete')
  assert.deepEqual(completions.map(value => value.completedProjects), [1, 2])
  assert.ok(completions.every(value => value.status === 'done' && value.totalClips === 1 && value.downloaded === 3 && !value.failedClips && !value.failedDownloads))
  for (const projectId of projectIds.slice(0, 2)) {
    const stages = progress.filter(value => value.projectId === projectId)
    assert.deepEqual(stages.map(value => value.stage), ['project_start', 'project_loaded', 'clip_start', 'clip_complete', 'project_complete'])
    assert.ok(stages.every(value => value.title === `project ${projectId}`))
    assert.deepEqual(stages.filter(value => value.stage.startsWith('clip_')).map(value => [value.clipIndex, value.totalClips]), [[1, 1], [1, 1]])
  }
  assert.doesNotMatch(JSON.stringify(progress), /https?:|Cookie|SESSDATA|candidates|media\.example/)
  assert.ok(Number.isFinite(Date.parse(report.completedAt)))
})

test('project concurrency starts two workers and leaves the third queued until a worker is free', { timeout: 10000 }, async t => {
  const { root, options } = await setup(t)
  options.projectConcurrency = 2
  const run = fixture(projectIds)
  const firstTwoStarted = deferred()
  const release = deferred()
  const project = run.client.project
  run.client.project = async pid => {
    const result = await project(pid)
    if (run.calls.projects.length === 2) firstTwoStarted.resolve()
    await release.promise
    return result
  }
  const pending = collectAll(options, run)
  try {
    await firstTwoStarted.promise
    assert.deepEqual(run.calls.projects, projectIds.slice(0, 2))
    assert.equal(run.calls.downloads.length, 0)
    assert.ok((await fs.lstat(path.join(root, '.all-projects.lock'))).isFile())
  } finally { release.resolve() }
  const report = await pending
  assert.deepEqual(run.calls.projects, projectIds)
  assert.deepEqual(report.projects.map(entry => [entry.projectId, entry.status, entry.downloaded]), projectIds.map(pid => [pid, 'done', 3]))
  assert.deepEqual(await readJson(path.join(root, 'batch-report.json')), report)
  assert.equal(inspectDatabase(options, library => library.stats().downloadedRecommendations), 9)
  for (const pid of projectIds) await absent(path.join(root, pid, '.collect.lock'))
  await absent(path.join(root, '.all-projects.lock'))
})

test('projects recommending the same videos reuse verified files through independent hard links', async t => {
  const { root, options } = await setup(t)
  const run = fixture()
  run.client.recommendations = async pid => ({
    query: `label ${pid}`, querySource: 'recommendations.query', total: 3,
    candidates: Array.from({ length: 3 }, (_, index) => candidate(projectIds[0], index)),
  })
  const report = await collectAll(options, run)
  assert.ok(report.projects.every(entry => entry.status === 'done' && entry.downloaded === 3))
  assert.equal(run.calls.downloads.length, 3, 'the second project must not request already verified assets')
  const rows = inspectDatabase(options, library => projectIds.slice(0, 2).map(projectId => library.search({ projectId })))
  assert.equal(rows[0].length, 3)
  assert.equal(rows[1].length, 3)
  for (const [index, first] of rows[0].entries()) {
    const reused = rows[1][index]
    assert.equal(first.assetId, reused.assetId)
    assert.notEqual(first.localPath, reused.localPath)
    assert.ok(reused.localPath.startsWith(path.join(root, projectIds[1]) + path.sep))
    assert.equal(reused.reused, true)
    const originalStat = await fs.stat(first.localPath)
    const reusedStat = await fs.stat(reused.localPath)
    assert.equal(reusedStat.dev, originalStat.dev)
    assert.equal(reusedStat.ino, originalStat.ino)
    assert.equal(reused.sha256, digest(await fs.readFile(reused.localPath)))
  }
})

test('batch collection reuses progress from a previous single-project collection', async t => {
  const { root, options } = await setup(t)
  const run = fixture()
  const pid = projectIds[0]
  const single = parseOptions(['--project', pid, '--output', path.join(root, pid), '--database', options.database])
  const initial = await collect(single, run)
  assert.equal(initial.clips[0].status, 'done')
  assert.equal(run.calls.downloads.length, 3)
  const report = await collectAll(options, run)
  assert.ok(report.projects.every(entry => entry.status === 'done'))
  assert.equal(run.calls.downloads.length, 5, 'the second project only downloads assets not already stored')
  const previous = inspectDatabase(options, library => library.search({ projectId: pid }))
  assert.equal(previous.length, 3)
  assert.ok(previous.every(row => row.reused && row.localPath.startsWith(path.join(root, pid) + path.sep)))
})

test('projects with no clips are stored as empty and do not prevent later collection', async t => {
  const { options } = await setup(t)
  const run = fixture()
  run.data.get(projectIds[0]).clips = []
  const report = await collectAll(options, run)
  assert.deepEqual(report.projects.map(entry => [entry.status, entry.totalClips, entry.downloaded, entry.incompleteClips]), [['empty', 0, 0, 0], ['done', 1, 3, 0]])
  assert.deepEqual(run.calls.recommendations, [projectIds[1]])
  assert.equal(run.calls.downloads.length, 3)
  const empty = inspectDatabase(options, library => library.stats(projectIds[0]))
  assert.equal(empty.projects, 1)
  assert.equal(empty.clips, 0)
  assert.equal(empty.recommendations, 0)
})

test('a project read failure is reported and subsequent projects still complete', async t => {
  const { root, options } = await setup(t)
  const run = fixture(projectIds)
  const project = run.client.project
  run.client.project = async pid => {
    if (pid === projectIds[1]) {
      run.calls.projects.push(pid)
      throw new Error('temporary project read failure')
    }
    return project(pid)
  }
  const report = await collectAll(options, run)
  assert.deepEqual(run.calls.projects, projectIds)
  assert.deepEqual(report.projects.map(entry => entry.status), ['done', 'failed', 'done'])
  assert.match(report.projects[1].error, /temporary project read failure/)
  assert.equal(run.calls.downloads.length, 5)
  assert.equal(inspectDatabase(options, library => library.stats(projectIds[2]).downloadedRecommendations), 3)
  assert.deepEqual(await readJson(path.join(root, 'batch-report.json')), report)
})

test('failed downloads leave a project incomplete while later projects continue', async t => {
  const { options } = await setup(t)
  const run = fixture()
  const download = run.download
  run.download = async (url, filename, args) => {
    if (url === candidate(projectIds[0], 1).url) throw new Error('temporary video failure')
    return download(url, filename, args)
  }
  const report = await collectAll(options, run)
  assert.deepEqual(report.projects.map(entry => [entry.status, entry.downloaded, entry.incompleteClips]), [['incomplete', 2, 1], ['done', 3, 0]])
  assert.deepEqual(report.projects.map(entry => [entry.failedClips, entry.failedDownloads, entry.unavailableClips]), [[1, 1, 0], [0, 0, 0]])
  const rows = inspectDatabase(options, library => library.search({ projectId: projectIds[0], downloadedOnly: false, topOnly: true }))
  assert.deepEqual(rows.map(row => row.status), ['done', 'failed', 'done'])
  assert.match(rows[1].error, /temporary video failure/)
})

test('candidate shortages and non-video recommendations are unavailable rather than failed transfers', async t => {
  const { options } = await setup(t)
  const run = fixture()
  run.client.recommendations = async pid => ({
    query: `label ${pid}`, querySource: 'recommendations.query', total: pid === projectIds[0] ? 2 : 3,
    candidates: pid === projectIds[0] ? [candidate(pid, 0), candidate(pid, 1)] : [
      candidate(pid, 0), { ...candidate(pid, 1), material_type: 2, url: 'https://media.example/unavailable.jpg' }, candidate(pid, 2),
    ],
  })
  const report = await collectAll(options, run)
  assert.deepEqual(report.projects.map(entry => [entry.status, entry.downloaded, entry.incompleteClips, entry.unavailableClips, entry.failedClips, entry.failedDownloads]), [
    ['incomplete', 2, 1, 1, 0, 0], ['incomplete', 2, 1, 1, 0, 0],
  ])
})

test('recommendation request failures are counted separately from candidate shortages', async t => {
  const { options } = await setup(t)
  const run = fixture()
  const recommendations = run.client.recommendations
  run.client.recommendations = async (pid, ...args) => {
    if (pid === projectIds[0]) throw new Error('recommendation read failed')
    return recommendations(pid, ...args)
  }
  const report = await collectAll(options, run)
  assert.deepEqual(report.projects.map(entry => [entry.failedClips, entry.failedDownloads, entry.unavailableClips]), [[1, 0, 0], [0, 0, 0]])
})

test('recommendation count gaps remain visible in database metadata and batch reports without blocking the top three', async t => {
  const { root, options } = await setup(t)
  const run = fixture()
  const warning = { reportedTotal: 60, capturedTotal: 59, message: '接口报告总数与实际可见素材数不一致' }
  const recommendations = run.client.recommendations
  run.client.recommendations = async (pid, clip, prefix) => {
    const result = await recommendations(pid, clip, prefix)
    if (pid !== projectIds[0]) return result
    return { ...result, total: 60, candidates: Array.from({ length: 59 }, (_, index) => candidate(pid, index)), metadataWarning: warning }
  }
  const report = await collectAll(options, run)
  assert.deepEqual(report.projects.map(entry => [entry.status, entry.downloaded, entry.incompleteClips, entry.metadataWarnings, entry.metadataComplete]), [
    ['done', 3, 0, 1, false], ['done', 3, 0, 0, true],
  ])
  assert.ok(report.projects.every(entry => !entry.failedClips && !entry.failedDownloads && !entry.unavailableClips))
  assert.equal(run.calls.downloads.length, 5)
  const stored = inspectDatabase(options, library => library.getClip(projectIds[0], '100001', path.join(root, projectIds[0])))
  assert.equal(stored.status, 'done')
  assert.equal(stored.total, 60)
  assert.equal(stored.candidates.length, 59)
  assert.deepEqual(stored.metadata._recommendationCollection, warning)
  assert.ok(stored.candidates.slice(0, 3).every(item => item.download.status === 'done'))
  assert.ok(stored.candidates.slice(3).every(item => item.download === undefined))
  const backup = await readJson(path.join(root, projectIds[0], 'clips/001/annotation.json'))
  assert.deepEqual(backup.metadata._recommendationCollection, warning)
  assert.deepEqual(await readJson(path.join(root, 'batch-report.json')), report)
})

test('aborting a batch preserves completed files, cleans partial downloads and stops subsequent projects', { timeout: 10000 }, async t => {
  const { root, options } = await setup(t)
  const run = fixture()
  const controller = new AbortController()
  const download = run.download
  const partialsStarted = deferred()
  let partials = 0
  run.download = async (url, filename, args) => {
    if (url === candidate(projectIds[0], 0).url) {
      const result = await download(url, filename, args)
      await partialsStarted.promise
      controller.abort(new Error('stop batch collection'))
      return result
    }
    return downloadVideo(url, filename, {
      ...args, probe: () => assert.fail('interrupted partial files must not reach media validation'),
      fetch: async () => {
        if (++partials === 2) partialsStarted.resolve()
        return new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('partial video bytes')) } }), {
          headers: { 'content-type': 'video/mp4' },
        })
      },
    })
  }
  await assert.rejects(collectAll(options, { ...run, signal: controller.signal }), /stop batch collection/)
  assert.deepEqual(run.calls.projects, [projectIds[0]])
  assert.equal(partials, 2)
  const saved = inspectDatabase(options, library => library.search({ projectId: projectIds[0] }))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].sha256, digest(await fs.readFile(saved[0].localPath)))
  for (const index of [1, 2]) {
    const filename = path.join(root, projectIds[0], 'clips/001', `0${index + 1}_${candidate(projectIds[0], index).id}.mp4`)
    await absent(filename)
    await absent(`${filename}.part`)
  }
  assert.equal(inspectDatabase(options, library => library.stats(projectIds[1]).projects), 0)
  const report = await readJson(path.join(root, 'batch-report.json'))
  assert.equal(report.projects[0].status, 'interrupted')
  assert.match(report.projects[0].error, /stop batch collection/)
  assert.equal(report.projects[1].status, 'pending')
  await absent(path.join(root, '.all-projects.lock'))
  await absent(path.join(root, projectIds[0], '.collect.lock'))
})

test('aborting concurrent projects waits for every worker to clean its partial files', { timeout: 10000 }, async t => {
  const { root, options } = await setup(t)
  options.projectConcurrency = 2
  const run = fixture(projectIds, { sharedAssets: false })
  const controller = new AbortController()
  const secondProjectProbing = deferred()
  const releaseCleanup = deferred()
  const aborted = deferred()
  controller.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
  const download = run.download
  let probesStarted = 0
  let activeProbes = 0
  run.download = async (url, filename, args) => {
    if (url.includes(`/${projectIds[1]}/`)) {
      return downloadVideo(url, filename, {
        ...args,
        fetch: async () => new Response(Buffer.from('second project fixture video'), { headers: { 'content-type': 'video/mp4' } }),
        probe: async () => {
          activeProbes++
          if (++probesStarted === 3) secondProjectProbing.resolve()
          try {
            await releaseCleanup.promise
            args.signal.throwIfAborted()
            return media
          } finally { activeProbes-- }
        },
      })
    }
    const result = await download(url, filename, args)
    if (url === candidate(projectIds[0], 0).url) {
      await secondProjectProbing.promise
      controller.abort(new Error('stop concurrent batch'))
    }
    return result
  }
  let settled = false
  const pending = collectAll(options, { ...run, signal: controller.signal })
  const rejected = assert.rejects(pending.finally(() => { settled = true }), /stop concurrent batch/)
  try {
    await aborted.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, 'the batch must wait for worker cleanup before rejecting')
    assert.equal(activeProbes, 3)
    assert.deepEqual(run.calls.projects, projectIds.slice(0, 2))
    assert.ok((await fs.lstat(path.join(root, '.all-projects.lock'))).isFile())
    assert.ok((await fs.lstat(path.join(root, projectIds[1], '.collect.lock'))).isFile())
    for (const index of [0, 1, 2]) {
      const filename = path.join(root, projectIds[1], 'clips/001', `0${index + 1}_${projectIds[1]}-${candidate(projectIds[1], index).id}.mp4`)
      assert.ok((await fs.lstat(`${filename}.part`)).isFile())
    }
  } finally {
    releaseCleanup.resolve()
    await rejected
  }
  assert.equal(activeProbes, 0)
  assert.equal(settled, true)
  assert.deepEqual(run.calls.projects, projectIds.slice(0, 2))
  for (const pid of projectIds.slice(0, 2)) {
    await absent(path.join(root, pid, '.collect.lock'))
    assert.ok((await fs.readdir(path.join(root, pid, 'clips/001'))).every(filename => !filename.endsWith('.part')))
  }
  await absent(path.join(root, '.all-projects.lock'))
  const report = await readJson(path.join(root, 'batch-report.json'))
  assert.deepEqual(report.projects.map(entry => entry.status), ['done', 'interrupted', 'pending'])
  assert.equal(inspectDatabase(options, library => library.stats(projectIds[2]).projects), 0)
})

test('a throwing progress callback waits for concurrent downloads before closing the shared library', { timeout: 10000 }, async t => {
  const { root, options } = await setup(t)
  options.projectConcurrency = 2
  const run = fixture(projectIds.slice(0, 2), { sharedAssets: false })
  const secondProjectProbing = deferred()
  const releaseProbes = deferred()
  const callbackFailed = deferred()
  const callbackError = new Error('progress persistence failed')
  const download = run.download
  let probesStarted = 0
  let activeProbes = 0
  run.download = async (url, filename, args) => {
    if (!url.includes(`/${projectIds[1]}/`)) {
      const result = await download(url, filename, args)
      await secondProjectProbing.promise
      return result
    }
    return downloadVideo(url, filename, {
      ...args,
      fetch: async () => new Response('second project bytes', { headers: { 'content-type': 'video/mp4' } }),
      probe: async () => {
        activeProbes++
        if (++probesStarted === 3) secondProjectProbing.resolve()
        try { await releaseProbes.promise; return media }
        finally { activeProbes-- }
      },
    })
  }
  let settled = false
  const pending = collectAll(options, { ...run, onProgress: value => {
    if (value.stage === 'project_complete' && value.projectId === projectIds[0]) {
      callbackFailed.resolve()
      throw callbackError
    }
  } })
  const rejected = assert.rejects(pending.finally(() => { settled = true }), error => error === callbackError)
  try {
    await callbackFailed.promise
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(activeProbes, 3)
    assert.ok((await fs.lstat(path.join(root, '.all-projects.lock'))).isFile())
  } finally {
    releaseProbes.resolve()
    await rejected
  }
  assert.equal(activeProbes, 0)
  assert.equal(inspectDatabase(options, library => library.stats().files), 6)
  for (const pid of projectIds.slice(0, 2)) {
    await absent(path.join(root, pid, '.collect.lock'))
    assert.ok((await fs.readdir(path.join(root, pid, 'clips/001'))).every(filename => !filename.endsWith('.part')))
  }
  await absent(path.join(root, '.all-projects.lock'))
})

test('insufficient disk space aborts all project workers and releases the batch locks', { timeout: 10000 }, async t => {
  const { root, options } = await setup(t)
  options.projectConcurrency = 2
  const run = fixture(projectIds, { sharedAssets: false })
  const secondProjectWaiting = deferred()
  const diskError = Object.assign(new Error('insufficient disk space'), { code: 'MATERIAL_DISK_FULL' })
  const signals = new Set()
  let waiting = 0
  run.download = async (url, _filename, { signal }) => {
    signals.add(signal)
    if (url.includes(`/${projectIds[0]}/`)) {
      await secondProjectWaiting.promise
      throw diskError
    }
    signal.throwIfAborted()
    if (++waiting === 3) secondProjectWaiting.resolve()
    try {
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } finally { waiting-- }
  }
  await assert.rejects(collectAll(options, run), error => error === diskError)
  assert.deepEqual(run.calls.projects, projectIds.slice(0, 2))
  assert.equal(waiting, 0, 'all workers must observe the internal abort before the batch returns')
  assert.equal(signals.size, 1)
  assert.ok([...signals].every(signal => signal.aborted && signal.reason === diskError))
  assert.equal(run.calls.downloads.length, 0)
  const report = await readJson(path.join(root, 'batch-report.json'))
  assert.deepEqual(report.projects.map(entry => entry.status), ['interrupted', 'interrupted', 'pending'])
  assert.ok(report.projects.slice(0, 2).every(entry => entry.error === diskError.message))
  for (const pid of projectIds.slice(0, 2)) await absent(path.join(root, pid, '.collect.lock'))
  await absent(path.join(root, '.all-projects.lock'))
  assert.equal(inspectDatabase(options, library => library.stats(projectIds[2]).projects), 0)
})

test('an already aborted batch does not request the project list', async t => {
  const { options } = await setup(t)
  const run = fixture()
  await assert.rejects(collectAll(options, { ...run, signal: AbortSignal.abort(new Error('already stopped')) }), /already stopped/)
  assert.equal(run.calls.lists, 0)
  assert.deepEqual(run.calls.projects, [])
})
