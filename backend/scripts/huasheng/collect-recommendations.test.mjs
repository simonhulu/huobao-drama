import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HuashengMaterialLibrary } from '../../src/services/huasheng-material-library.mjs'
import { collect, createClient, downloadVideo, importExisting, parseOptions } from './collect-recommendations.mjs'

const pid = '260077122691088'
const session = { cookie: 'SESSDATA=fixture', userAgent: 'fixture-browser' }
const media = { duration: 12.5, width: 1920, height: 1080, codec: 'h264' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Response.json(value)
const candidate = id => ({ id, url: `https://media.example/${id}.mp4`, cover: `https://media.example/${id}.jpg`, duration: 24, material_type: 1 })
const project = (projectPid = pid, sandbox = true) => ({
  project: { pid: projectPid, name: 'fixture project', is_agent_sandbox: sandbox },
  clips: [{ id: '100001', idx: '1', content: 'fixture narration', video: { ...candidate('a'), caption: 'selected source caption' }, voice: { duration: 5 } }],
})

async function directory(t) {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), 'huasheng-recommendations-test-'))
  t.after(() => fs.rm(result, { recursive: true, force: true }))
  return result
}

async function absent(filename) {
  await assert.rejects(fs.lstat(filename), { code: 'ENOENT' })
}

async function readJson(filename) { return JSON.parse(await fs.readFile(filename, 'utf8')) }
async function readIndex(root) {
  const library = new HuashengMaterialLibrary({ databasePath: path.join(root, 'materials.db') })
  try { return library.search({ projectId: pid, downloadedOnly: false, topOnly: true, limit: 1000 }) }
  finally { library.close() }
}

function readStats(root) {
  const library = new HuashengMaterialLibrary({ databasePath: path.join(root, 'materials.db') })
  try { return library.stats(pid) }
  finally { library.close() }
}

function collectionFixture(data = project()) {
  const requests = []
  return {
    requests,
    client: {
      project: async () => ({ data, prefix: '/api/v2/innovideo' }),
      recommendations: async (_pid, clip) => ({
        query: `history label ${clip.id}`, querySource: 'recommendations.query', total: 4,
        candidates: ['a', 'b', 'c', 'd'].map(id => candidate(`${clip.id}-${id}`)),
      }),
    },
    download: (url, filename, args) => downloadVideo(url, filename, {
      ...args, probe: async () => media,
      fetch: async () => {
        requests.push(url)
        return new Response(`video bytes for ${url}`, { headers: { 'content-type': 'video/mp4' } })
      },
    }),
    log() {},
  }
}

async function offlineFixture(t) {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db'), '--import-existing'])
  const clipDirectory = path.join(root, 'clips/001')
  await fs.mkdir(clipDirectory, { recursive: true })
  const candidates = []
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    const bytes = Buffer.from(`offline video fixture ${id}`)
    const localPath = `clips/001/0${index + 1}_${id}.mp4`
    await fs.writeFile(path.join(root, localPath), bytes)
    candidates.push({
      ...candidate(id), rank: index + 1,
      download: { status: 'done', localPath, bytes: bytes.length, sha256: digest(bytes), media, reused: false },
    })
  }
  const record = {
    projectId: pid, order: 1, clipId: '100001', text: 'offline narration', query: 'offline history label',
    querySource: 'recommendations.query', total: 3, capturedAt: '2026-10-24T00:00:00.000Z',
    selectedAssetId: 'a', selectedCaption: 'offline source caption', metadata: project().clips[0], status: 'done', candidates,
  }
  const manifest = {
    schemaVersion: 1, projectId: pid, title: 'offline fixture', projectUrl: options.projectUrl,
    totalClips: 1, requestedClips: 1, top: 3, annotationType: 'huasheng_recommendation_query', clips: [record],
  }
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest))
  await fs.writeFile(path.join(clipDirectory, 'annotation.json'), JSON.stringify(record))
  return { root, options, record }
}

test('options preserve project IDs, normalize approved URLs, and reject other destinations and invalid limits', () => {
  assert.equal(parseOptions(['--project', pid]).pid, pid)
  assert.equal(parseOptions(['--project', `https://huasheng.cn/video/${pid}/`]).projectUrl, `https://www.huasheng.cn/video/${pid}`)
  assert.equal(parseOptions(['--project', pid, '--metadata-only', '--limit', '2']).limit, 2)
  assert.equal(parseOptions(['--project', pid, '--metadata-only']).metadataOnly, true)
  assert.equal(parseOptions(['--help']).help, true)
  for (const value of [
    `http://www.huasheng.cn/video/${pid}`, `https://example.com/video/${pid}`,
    `https://www.huasheng.cn:444/video/${pid}`, `https://user:secret@www.huasheng.cn/video/${pid}`,
    `https://www.huasheng.cn/video/${pid}?pid=other`, `https://www.huasheng.cn/video/${pid}#other`,
    `https://www.huasheng.cn/video/${pid}/extra`,
  ]) assert.throws(() => parseOptions(['--project', value]), /Huasheng project/)
  for (const value of ['0', '-1', '1.5', 'Infinity']) assert.throws(() => parseOptions(['--project', pid, '--limit', value]), /positive integer/)
  assert.throws(() => parseOptions(['--project']), /requires a value/)
  assert.throws(() => parseOptions(['--unknown']), /Unknown option/)
})

test('database options support offline import and project-optional statistics and search', () => {
  const database = path.resolve('fixture-materials.db')
  const stats = parseOptions(['--stats', '--database', database])
  assert.equal(stats.stats, true)
  assert.equal(stats.database, database)
  assert.equal(stats.pid, undefined)
  const search = parseOptions(['--search', 'history label', '--database', database, '--limit', '7'])
  assert.equal(search.search, 'history label')
  assert.equal(search.database, database)
  assert.equal(search.limit, 7)
  assert.equal(search.pid, undefined)
  const imported = parseOptions(['--project', pid, '--import-existing', '--database', database])
  assert.equal(imported.importExisting, true)
  assert.equal(imported.database, database)
  assert.equal(imported.pid, pid)
  assert.equal(parseOptions(['--project', pid, '--stats']).pid, pid)
  assert.equal(parseOptions(['--project', pid, '--search', 'label']).pid, pid)
  assert.equal(parseOptions(['--stats', '--database', 'relative-materials.db']).database, path.resolve('relative-materials.db'))
  for (const option of ['--database', '--search']) assert.throws(() => parseOptions([option]), /requires a value/)
  for (const modes of [['--stats', '--search', 'label'], ['--stats', '--import-existing'], ['--search', 'label', '--import-existing']]) {
    assert.throws(() => parseOptions(['--project', pid, ...modes]), /Choose only one/)
  }
  assert.throws(() => parseOptions(['--import-existing']), /--project is required/)
})

test('sandbox projects and identical clip IDs stay scoped to the requested pid', async () => {
  const seen = []
  const client = createClient({ session, fetch: async (input, options) => {
    const url = new URL(input)
    seen.push(url)
    assert.equal(url.origin, 'https://www.huasheng.cn')
    assert.equal(options.headers.Cookie, session.cookie)
    assert.equal(options.headers['User-Agent'], session.userAgent)
    assert.equal(options.redirect, 'error')
    const projectPid = url.searchParams.get('pid')
    if (url.pathname.endsWith('/project/info')) return json({ code: 0, data: project(projectPid) })
    assert.equal(url.pathname, '/api/v2/innovideo/clip/candidates/list')
    assert.equal(url.searchParams.get('clip_id'), '100001')
    return json({ code: 0, data: { query: `label ${projectPid}`, page: { total: 1, pn: 1 }, candidates: [candidate(projectPid)] } })
  } })
  for (const projectPid of [pid, '260004813045809']) {
    const result = await client.project(projectPid)
    assert.equal(result.prefix, '/api/v2/innovideo')
    const recommendations = await client.recommendations(projectPid, result.data.clips[0], result.prefix)
    assert.equal(recommendations.query, `label ${projectPid}`)
    assert.equal(recommendations.candidates[0].id, projectPid)
  }
  assert.deepEqual(seen.map(url => [url.pathname, url.searchParams.get('pid')]), [
    ['/api/innovideo/project/info', pid], ['/api/v2/innovideo/project/info', pid], ['/api/v2/innovideo/clip/candidates/list', pid],
    ['/api/innovideo/project/info', '260004813045809'], ['/api/v2/innovideo/project/info', '260004813045809'], ['/api/v2/innovideo/clip/candidates/list', '260004813045809'],
  ])
  const mismatch = createClient({ session, fetch: async () => json(project('other', false)) })
  await assert.rejects(mismatch.project(pid), /项目编号不匹配/)
  const legacy = createClient({ session, fetch: async () => json(project(pid, false)) })
  assert.equal((await legacy.project(pid)).prefix, '/api/huasheng')
})

test('recommendation pagination preserves every candidate and its original rank and metadata', async () => {
  const all = Array.from({ length: 74 }, (_, index) => ({ ...candidate(`asset-${index + 1}`), caption: `source caption ${index}`, custom: { source: index }, width: 1920 }))
  const pages = []
  const client = createClient({ session, fetch: async input => {
    const url = new URL(input)
    assert.equal(url.searchParams.get('pid'), pid)
    assert.equal(url.searchParams.get('ps'), '60')
    const pn = Number(url.searchParams.get('pn'))
    pages.push(pn)
    return json({ code: 0, data: { query: 'recommendation query', page: { total: all.length, pn, ps: 60 }, candidates: all.slice((pn - 1) * 60, pn * 60) } })
  } })
  const result = await client.recommendations(pid, { id: '100001' }, '/api/v2/innovideo')
  assert.deepEqual(pages, [1, 2])
  assert.deepEqual(result, { query: 'recommendation query', querySource: 'recommendations.query', total: 74, candidates: all })
  const fallback = createClient({ session, fetch: async () => json({ code: 0, data: { page: { total: 0 }, candidates: [] } }) })
  const empty = await fallback.recommendations(pid, { id: '100001', video: { query: 'saved query', caption: 'unrelated caption' } }, '/api/v2/innovideo')
  assert.equal(empty.query, 'saved query')
  assert.equal(empty.querySource, 'clip.video.query')
})

test('pagination rejects HTTP and business errors, missing rows, duplicated or inconsistent pages', async t => {
  const first = { query: 'stable query', page: { total: 2, pn: 1 }, candidates: [candidate('a')] }
  const cases = [
    ['HTTP failure', [new Response('unavailable', { status: 503 })], /HTTP 503/],
    ['business failure', [json({ code: -403, data: {} })], /接口错误 -403/],
    ['missing candidates', [json({ code: 0, data: { page: { total: 0 } } })], /candidates/],
    ['malformed candidate', [json({ code: 0, data: { page: { total: 1 }, candidates: [{}] } })], /candidates/],
    ['invalid total', [json({ code: 0, data: { page: { total: 1201 }, candidates: [] } })], /总数无效/],
    ['wrong page', [json({ code: 0, data: { ...first, page: { total: 2, pn: 2 } } })], /页码不匹配/],
    ['duplicate ID', [json({ code: 0, data: first }), json({ code: 0, data: { page: { total: 2, pn: 2 }, candidates: [candidate('a')] } })], /重复或数量不匹配/],
    ['too many rows', [json({ code: 0, data: { page: { total: 1 }, candidates: [candidate('a'), candidate('b')] } })], /重复或数量不匹配/],
    ['total changed', [json({ code: 0, data: first }), json({ code: 0, data: { page: { total: 3, pn: 2 }, candidates: [candidate('b')] } })], /推荐列表已变化/],
    ['query changed', [json({ code: 0, data: first }), json({ code: 0, data: { query: 'different query', page: { total: 2, pn: 2 }, candidates: [candidate('b')] } })], /分镜描述已变化/],
  ]
  for (const [name, responses, expected] of cases) await t.test(name, async () => {
    let calls = 0
    const client = createClient({ session, fetch: async () => {
      assert.ok(calls < responses.length, 'must reject instead of fetching unlimited pages')
      return responses[calls++]
    } })
    await assert.rejects(client.recommendations(pid, { id: '100001' }, '/api/v2/innovideo'), expected)
  })
})

test('a stale recommendation total retains available candidates and records the metadata gap', async () => {
  const candidates = Array.from({ length: 59 }, (_, index) => candidate(`asset-${index}`))
  const client = createClient({ session, fetch: async () => json({ code: 0, data: { query: 'visible material', page: { total: 60, pn: 1, ps: 60 }, candidates } }) })
  const result = await client.recommendations(pid, { id: '100001' }, '/api/v2/innovideo')
  assert.equal(result.total, 60)
  assert.deepEqual(result.candidates, candidates)
  assert.deepEqual(result.metadataWarning, { reportedTotal: 60, capturedTotal: 59, message: '接口报告总数与实际可见素材数不一致' })
})

test('a streamed download is published only after exact bytes, SHA-256 and probe validation', async t => {
  const root = await directory(t)
  const target = path.join(root, 'clip.mp4')
  const bytes = Buffer.from('fixture video split across chunks')
  let reachedProbe
  const probing = new Promise(resolve => { reachedProbe = resolve })
  let finishProbe
  const gate = new Promise(resolve => { finishProbe = resolve })
  const promise = downloadVideo('https://media.example/clip.mp4', target, {
    fetch: async (url, options) => {
      assert.equal(url, 'https://media.example/clip.mp4')
      assert.deepEqual(options.headers, { Referer: 'https://www.huasheng.cn/' })
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 10)); controller.enqueue(bytes.subarray(10)); controller.close()
      } }), { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } })
    },
    probe: async filename => {
      assert.equal(filename, `${target}.part`)
      assert.deepEqual(await fs.readFile(filename), bytes)
      await absent(target)
      reachedProbe()
      await gate
      return media
    },
  })
  await probing
  await absent(target)
  finishProbe()
  const result = await promise
  assert.deepEqual(result, { status: 'done', bytes: bytes.length, sha256: digest(bytes), media, reused: false, repaired: false })
  assert.deepEqual(await fs.readFile(target), bytes)
  await absent(`${target}.part`)
  const reused = await downloadVideo('https://media.example/new-signature.mp4', target, {
    previous: result,
    fetch: () => assert.fail('valid files must not be requested again'),
    probe: () => assert.fail('valid files must not be probed again'),
  })
  assert.deepEqual(reused, { ...result, reused: true })
})

test('failed or invalid media leave neither a final file nor a partial file', async t => {
  const cases = [
    ['HTTP error', () => new Response('denied', { status: 403 }), async () => media, /HTTP 403/],
    ['HTML error', () => new Response('login page', { headers: { 'content-type': 'text/html' } }), async () => media, /网页或播放清单/],
    ['short body', () => new Response('short', { headers: { 'content-length': '50', 'content-type': 'video/mp4' } }), async () => media, /字节数不完整/],
    ['empty body', () => new Response(null, { headers: { 'content-type': 'video/mp4' } }), async () => media, /响应为空/],
    ['zero bytes', () => new Response('', { headers: { 'content-type': 'video/mp4' } }), async () => media, /字节数不完整/],
    ['probe failure', () => new Response('invalid video', { headers: { 'content-type': 'video/mp4' } }), async () => { throw new Error('invalid probe') }, /invalid probe/],
    ['stream failure', () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream interrupted')) } })), async () => media, /stream interrupted/],
  ]
  for (const [name, response, probe, expected] of cases) await t.test(name, async t => {
    const root = await directory(t)
    const target = path.join(root, 'clip.mp4')
    await assert.rejects(downloadVideo('https://media.example/a.mp4', target, { fetch: async () => response(), probe }), expected)
    await absent(target)
    await absent(`${target}.part`)
  })
})

test('downloads preserve existing files, stale partials and paths that collide during validation', async t => {
  const root = await directory(t)
  const target = path.join(root, 'clip.mp4')
  await fs.writeFile(target, 'original')
  await assert.rejects(downloadVideo('https://media.example/a.mp4', target, { fetch: () => assert.fail('existing file must be checked first') }), /已保留原文件/)
  assert.equal(await fs.readFile(target, 'utf8'), 'original')
  await assert.rejects(downloadVideo('https://media.example/a.mp4', target, {
    previous: { status: 'done', bytes: 8, sha256: digest('different') }, fetch: () => assert.fail('mismatch must not overwrite'),
  }), /已保留原文件/)
  await fs.unlink(target)
  await fs.writeFile(`${target}.part`, 'previous partial')
  await assert.rejects(downloadVideo('https://media.example/a.mp4', target, { fetch: () => assert.fail('stale partial must be preserved') }), /已保留/)
  assert.equal(await fs.readFile(`${target}.part`, 'utf8'), 'previous partial')
  await fs.unlink(`${target}.part`)
  await assert.rejects(downloadVideo('https://media.example/a.mp4', target, {
    fetch: async () => new Response('new bytes', { headers: { 'content-type': 'video/mp4' } }),
    probe: async () => { await fs.writeFile(target, 'competing writer'); return media },
  }), /已保留/)
  assert.equal(await fs.readFile(target, 'utf8'), 'competing writer')
  await absent(`${target}.part`)
})

test('collection stores usable labels in the database, retries failures and respects the top three', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  let ordered = [candidate('a'), { ...candidate('b'), caption: 'second source caption' }, candidate('c'), candidate('d')]
  const query = '红军队伍在瑞金街头行进的远景, 中国, 1934年'
  const requests = []
  let failB = true
  const downloads = []
  const client = {
    project: async requestedPid => { assert.equal(requestedPid, pid); return { data: project(), prefix: '/api/v2/innovideo' } },
    recommendations: async (requestedPid, clip, prefix) => {
      assert.equal(requestedPid, pid); assert.equal(clip.id, '100001'); assert.equal(prefix, '/api/v2/innovideo')
      return { query, querySource: 'recommendations.query', total: ordered.length, candidates: structuredClone(ordered) }
    },
  }
  const download = async (url, filename, args) => {
    downloads.push({ url, filename, previous: args.previous })
    return downloadVideo(url, filename, { ...args, probe: async () => media, fetch: async requestedUrl => {
      requests.push(requestedUrl)
      if (requestedUrl.endsWith('/b.mp4') && failB) throw new Error('temporary CDN failure')
      return new Response(`video bytes for ${requestedUrl}`, { headers: { 'content-type': 'video/mp4' } })
    } })
  }
  const first = await collect(options, { client, download, log() {} })
  assert.equal(first.clips[0].status, 'incomplete')
  assert.deepEqual([...requests].sort(), ordered.slice(0, 3).map(item => item.url).sort())
  assert.equal(first.clips[0].candidates.length, 4)
  assert.equal(first.clips[0].candidates[3].download, undefined)
  const initialIndex = await readIndex(root)
  assert.deepEqual(initialIndex.map(item => item.assetId), ['a', 'b', 'c'])
  assert.ok(initialIndex.every(item => item.query === query && item.querySource === 'recommendations.query'))
  assert.equal(initialIndex[0].sourceCaption, 'selected source caption')
  assert.equal(initialIndex[1].sourceCaption, 'second source caption')
  assert.equal(initialIndex[2].sourceCaption, '')
  assert.ok(initialIndex.every(item => item.query !== item.sourceCaption))
  assert.equal(await fs.readFile(path.join(root, 'clips/001/标注.txt'), 'utf8'), `${query}\n\nfixture narration\n`)
  await absent(path.join(root, '.collect.lock'))
  await fs.unlink(path.join(root, 'manifest.json'))
  failB = false
  requests.length = 0
  downloads.length = 0
  const resumed = await collect(options, { client, download, log() {} })
  assert.equal(resumed.clips[0].status, 'done')
  assert.deepEqual(requests, [candidate('b').url], 'completed bytes are reused from the database even when no manifest survived')
  assert.deepEqual(downloads.map(item => item.previous?.status), ['done', 'failed', 'done'])
  for (const item of await readIndex(root)) {
    assert.ok(path.isAbsolute(item.localPath))
    const bytes = await fs.readFile(item.localPath)
    assert.equal(item.status, 'done')
    assert.equal(item.bytes, bytes.length)
    assert.equal(item.sha256, digest(bytes))
  }
  ordered = [ordered[1], ordered[0], ordered[2], ordered[3]]
  requests.length = 0
  const reordered = await collect({ ...options, refreshMetadata: true }, { client, download, log() {} })
  assert.equal(reordered.clips[0].status, 'done')
  assert.deepEqual(requests, [], 'rank changes reuse verified source files through new local paths')
  const finalIndex = await readIndex(root)
  assert.deepEqual(finalIndex.map(item => [item.assetId, item.rank, path.relative(root, item.localPath)]), [
    ['b', 1, 'clips/001/01_b.mp4'], ['a', 2, 'clips/001/02_a.mp4'], ['c', 3, 'clips/001/03_c.mp4'],
  ])
  assert.ok((await fs.readdir(path.join(root, 'clips/001'))).includes('01_a.mp4'), 'earlier rank files remain preserved')
  assert.equal((await readJson(path.join(root, 'manifest.json'))).clips[0].query, query)
})

test('metadata-only collection sorts clips, keeps all candidates, and never transfers media', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db'), '--metadata-only'])
  const data = project()
  data.clips = [{ ...data.clips[0], id: '100002', idx: '2' }, data.clips[0]]
  const manifest = await collect(options, {
    client: { project: async () => ({ data, prefix: '/api/v2/innovideo' }), recommendations: async (_pid, clip) => ({
      query: `query ${clip.id}`, querySource: 'recommendations.query', total: 4,
      candidates: [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
    }) },
    download: () => assert.fail('metadata-only must not request video bytes'), log() {},
  })
  assert.deepEqual(manifest.clips.map(clip => [clip.order, clip.clipId, clip.status]), [[1, '100001', 'metadata_only'], [2, '100002', 'metadata_only']])
  assert.equal((await readIndex(root)).length, 6)
  assert.ok((await readIndex(root)).every(item => item.status === 'pending'))
  assert.deepEqual((await fs.readdir(path.join(root, 'clips/001'))).sort(), ['annotation.json', '标注.txt'].sort())
})

for (const compositeId of ['', 'different-composite-asset']) {
  test(`collection binds source descriptions to the original video when the composite ID is ${compositeId || 'empty'}`, async t => {
    const root = await directory(t)
    const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
    const data = project()
    data.clips[0].composite_video = { id: compositeId, url: 'https://media.example/composite.mp4', duration: 5 }
    let metadataReads = 0
    const fixture = collectionFixture(data)
    fixture.client.recommendations = async () => {
      metadataReads++
      return { query: '黄昏城墙 兄弟背影', querySource: 'recommendations.query', total: 3, candidates: ['a', 'b', 'c'].map(candidate) }
    }
    const first = await collect(options, fixture)
    assert.equal(first.clips[0].selectedAssetId, 'a')
    assert.equal(first.clips[0].selectedCaption, 'selected source caption')
    const initialIndex = await readIndex(root)
    assert.equal(initialIndex.find(item => item.assetId === 'a').sourceCaption, 'selected source caption')
    assert.ok(initialIndex.filter(item => item.assetId !== 'a').every(item => item.sourceCaption === ''))
    assert.ok(initialIndex.every(item => item.query === '黄昏城墙 兄弟背影'))
    data.clips[0].composite_video.id = 'replacement-composite-asset'
    data.clips[0].composite_video.url = 'https://media.example/replacement-composite.mp4'
    const resumed = await collect(options, fixture)
    assert.equal(resumed.clips[0].metadataSkippedClips, 1, 'changing only the composite cannot invalidate source recommendations')
    assert.equal(metadataReads, 1)
    assert.equal(fixture.requests.length, 3, 'source files are not downloaded again after the composite changes')
  })
}

for (const [compositeId, sourceSha256] of [
  ['', '3cc231f381d16ee42f8e257d869a3cb05ef215eb953fc902bbb5c9663ea7977a'],
  ['different-composite-asset', '58baee7dbf31a6fa2c0b6da4e5f9f9aedf051781ceb024f628a4d0c3b6adf8d0'],
]) {
  test(`legacy composite checkpoint ${compositeId || 'without an ID'} repairs its binding without rereading metadata or transferring files`, async t => {
    const root = await directory(t)
    const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
    const data = project()
    data.clips[0].composite_video = { id: compositeId, url: 'https://media.example/composite.mp4', duration: 5 }
    const fixture = collectionFixture(data)
    fixture.client.recommendations = async () => ({ query: '城墙 远眺', querySource: 'recommendations.query', total: 3, candidates: ['a', 'b', 'c'].map(candidate) })
    await collect(options, fixture)
    const library = new HuashengMaterialLibrary({ databasePath: options.database })
    try {
      const old = library.getClip(pid, '100001', root)
      old.selectedAssetId = compositeId
      old.metadata._recommendationCheckpoint.sourceSha256 = sourceSha256
      library.saveClip(pid, old, root)
    } finally { library.close() }
    fixture.client.recommendations = () => assert.fail('unchanged legacy source metadata must remain cached')
    const resumed = await collect(options, fixture)
    assert.equal(resumed.clips[0].selectedAssetId, 'a')
    assert.equal(resumed.clips[0].metadataSkippedClips, 1)
    assert.notEqual(resumed.clips[0].metadata._recommendationCheckpoint.sourceSha256, sourceSha256)
    assert.equal(fixture.requests.length, 3)
    data.clips[0].video.caption = 'changed source description'
    let refreshed = 0
    fixture.client.recommendations = async () => {
      refreshed++
      return { query: '城墙 远眺', querySource: 'recommendations.query', total: 3, candidates: ['a', 'b', 'c'].map(candidate) }
    }
    await collect(options, fixture)
    assert.equal(refreshed, 1, 'changed source metadata cannot reuse either fingerprint form')
    assert.equal(fixture.requests.length, 3)
  })
}

test('a composite with no source video identity cannot donate its caption to recommendation assets', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db'), '--metadata-only'])
  const data = project()
  data.clips[0].video.id = ''
  data.clips[0].composite_video = { ...candidate('a') }
  const fixture = collectionFixture(data)
  fixture.client.recommendations = async () => ({ query: '城墙 远眺', querySource: 'recommendations.query', total: 3, candidates: ['a', 'b', 'c'].map(candidate) })
  const result = await collect(options, fixture)
  assert.equal(result.clips[0].selectedAssetId, '')
  assert.equal(result.clips[0].selectedCaption, '')
  assert.ok((await readIndex(root)).every(item => item.sourceCaption === ''))
  assert.equal(result.clips[0].metadata.video.caption, 'selected source caption', 'unbound original text remains in raw metadata')
})

test('a collection interrupted on rerun retains completed candidates that have not yet been revisited', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  const client = {
    project: async () => ({ data: project(), prefix: '/api/v2/innovideo' }),
    recommendations: async () => ({ query: 'label', querySource: 'recommendations.query', total: 3, candidates: ['a', 'b', 'c'].map(candidate) }),
  }
  const transfer = (url, filename, args) => downloadVideo(url, filename, { ...args, fetch: async () => new Response('video bytes', { headers: { 'content-type': 'video/mp4' } }), probe: async () => media })
  await collect(options, { client, download: transfer, log() {} })
  const controller = new AbortController()
  await assert.rejects(collect(options, { client, signal: controller.signal, log() {}, download: async (url, filename, args) => {
    if (url.endsWith('/b.mp4')) {
      controller.abort(new Error('interrupted by user'))
      controller.signal.throwIfAborted()
    }
    return transfer(url, filename, args)
  } }), /interrupted by user/)
  await absent(path.join(root, '.collect.lock'))
  const checkpoint = await readJson(path.join(root, 'clips/001/annotation.json'))
  assert.equal(checkpoint.candidates.find(item => item.id === 'c').download?.status, 'done')
  const result = await collect(options, { client, download: transfer, log() {} })
  assert.equal(result.clips[0].status, 'done')
  assert.ok(result.clips[0].candidates.every(item => item.download.reused))
})

test('temporary recommendation failures preserve saved labels and downloads, then clear their error after recovery', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  let unavailable = false
  let transfers = 0
  const client = {
    project: async () => ({ data: project(), prefix: '/api/v2/innovideo' }),
    recommendations: async () => {
      if (unavailable) throw new Error('temporary recommendation failure')
      return { query: 'saved recommendation label', querySource: 'recommendations.query', total: 4, candidates: ['a', 'b', 'c', 'd'].map(candidate) }
    },
  }
  const download = (url, filename, args) => downloadVideo(url, filename, {
    ...args,
    fetch: async () => { transfers++; return new Response('video bytes', { headers: { 'content-type': 'video/mp4' } }) },
    probe: async () => media,
  })
  const initial = await collect(options, { client, download, log() {} })
  const saved = initial.clips[0]
  const savedIndex = await readIndex(root)
  assert.equal(saved.status, 'done')
  assert.equal(saved.query, 'saved recommendation label')
  assert.equal(saved.querySource, 'recommendations.query')
  assert.equal(saved.total, 4)
  assert.ok(Number.isFinite(Date.parse(saved.capturedAt)))
  assert.ok(saved.candidates.slice(0, 3).every(item => item.download.status === 'done'))
  assert.equal(transfers, 3)

  unavailable = true
  const failed = await collect({ ...options, refreshMetadata: true }, { client, download, log() {} })
  const annotation = await readJson(path.join(root, 'clips/001/annotation.json'))
  const manifest = await readJson(path.join(root, 'manifest.json'))
  for (const record of [failed.clips[0], annotation, manifest.clips[0]]) {
    assert.equal(record.status, 'failed')
    assert.equal(record.error, 'temporary recommendation failure')
    for (const key of ['query', 'querySource', 'total', 'capturedAt']) assert.equal(record[key], saved[key])
    assert.deepEqual(record.candidates, saved.candidates)
  }
  assert.deepEqual(await readIndex(root), savedIndex)
  assert.equal(transfers, 3, 'failed metadata requests must preserve existing downloads')

  unavailable = false
  const recovered = await collect(options, { client, download, log() {} })
  const recoveredAnnotation = await readJson(path.join(root, 'clips/001/annotation.json'))
  const recoveredManifest = await readJson(path.join(root, 'manifest.json'))
  for (const record of [recovered.clips[0], recoveredAnnotation, recoveredManifest.clips[0]]) {
    assert.equal(record.status, 'done')
    assert.equal(Object.hasOwn(record, 'error'), false)
    assert.ok(record.candidates.slice(0, 3).every(item => item.download.status === 'done' && item.download.reused))
  }
  assert.ok((await readIndex(root)).every(item => item.query === saved.query && item.status === 'done' && item.reused))
  assert.equal(transfers, 3, 'recovery must reuse the verified local files')
})

test('repeat collection upserts the database and resumes without any JSON or text backups', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  const fixture = collectionFixture()
  const initial = await collect(options, fixture)
  assert.equal(initial.clips[0].status, 'done')
  const savedStats = readStats(root)
  assert.deepEqual(savedStats, { projects: 1, clips: 1, recommendations: 4, assets: 4, downloadedAssets: 3, files: 3, downloadedRecommendations: 3 })
  await absent(path.join(root, 'dataset.jsonl'))
  const repeated = await collect(options, fixture)
  assert.equal(repeated.clips[0].status, 'done')
  assert.deepEqual(readStats(root), savedStats)
  assert.equal(fixture.requests.length, 3)

  for (const filename of ['manifest.json', 'dataset.jsonl', 'clips/001/annotation.json', 'clips/001/标注.txt']) {
    await fs.rm(path.join(root, filename), { force: true })
  }
  assert.equal((await readIndex(root)).filter(item => item.status === 'done').length, 3)
  const resumed = await collect(options, fixture)
  assert.equal(resumed.clips[0].status, 'done')
  assert.ok(resumed.clips[0].candidates.slice(0, 3).every(item => item.download.reused))
  assert.deepEqual(readStats(root), savedStats)
  assert.equal(fixture.requests.length, 3, 'database checkpoints must reuse media without any JSON backups')
  for (const item of await readIndex(root)) assert.equal(digest(await fs.readFile(item.localPath)), item.sha256)
  await absent(path.join(root, 'dataset.jsonl'))
})

test('incremental metadata requires a complete versioned checkpoint and upgrades legacy records once', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  const fixture = collectionFixture()
  let metadataReads = 0
  const recommendations = fixture.client.recommendations
  fixture.client.recommendations = async (...args) => { metadataReads++; return recommendations(...args) }
  await collect(options, fixture)
  const library = new HuashengMaterialLibrary({ databasePath: options.database })
  try {
    const legacy = library.getClip(pid, '100001', root)
    delete legacy.metadata._recommendationCheckpoint
    library.saveClip(pid, legacy, root)
  } finally { library.close() }
  await collect(options, fixture)
  assert.equal(metadataReads, 2, 'legacy metadata is read once to establish complete remote evidence')
  await collect(options, fixture)
  assert.equal(metadataReads, 2, 'the proven unchanged recommendation snapshot is cached')
  assert.equal(fixture.requests.length, 3)
})

test('proven unchanged clips avoid rewriting recommendation tables or querying reusable-file inventory', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  const fixture = collectionFixture()
  const library = new HuashengMaterialLibrary({ databasePath: options.database })
  try {
    await collect(options, { ...fixture, library })
    await collect(options, { ...fixture, library })
    const saveClip = t.mock.method(library, 'saveClip')
    const findFiles = t.mock.method(library, 'findFiles')
    await collect(options, { ...fixture, library })
    assert.equal(saveClip.mock.callCount(), 0)
    assert.equal(findFiles.mock.callCount(), 0)
    assert.equal(fixture.requests.length, 3)
  } finally { library.close() }
})

test('an expired cached download URL refreshes only its original clip and repairs its missing file', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  const fixture = collectionFixture()
  let expired = false, metadataReads = 0
  const recommendations = fixture.client.recommendations
  fixture.client.recommendations = async (...args) => {
    metadataReads++
    const result = await recommendations(...args)
    if (expired) for (const candidate of result.candidates) candidate.url += '?token=fresh'
    return result
  }
  const transfers = []
  fixture.download = (url, filename, args) => downloadVideo(url, filename, { ...args, probe: async () => media,
    fetch: async () => {
      transfers.push(url)
      return expired && !url.includes('token=fresh') ? new Response('expired signature', { status: 403 })
        : new Response(`fixture bytes ${new URL(url).pathname}`, { headers: { 'content-type': 'video/mp4' } })
    } })
  const first = await collect(options, fixture)
  const missing = first.clips[0].candidates[0].download
  await fs.unlink(path.join(root, missing.localPath))
  expired = true
  const result = await collect(options, fixture)
  assert.equal(result.clips[0].status, 'done')
  assert.equal(metadataReads, 2)
  assert.equal(transfers.length, 5, 'one expired URL and one refreshed transfer are sufficient')
  assert.equal(result.clips[0].metadataReadClips, 1)
  assert.equal(result.clips[0].metadataSkippedClips, 0)
  assert.equal(result.clips[0].repairedDownloads, 1)
  assert.equal(digest(await fs.readFile(path.join(root, missing.localPath))), missing.sha256)
})

test('repairing registered corrupted media publishes verified replacement bytes and preserves unknown files', async t => {
  const root = await directory(t)
  const filename = path.join(root, 'owned.mp4')
  const expected = Buffer.from('original valid media')
  const damaged = Buffer.alloc(expected.length, 1)
  const registered = { filePath: filename, bytes: expected.length, sha256: digest(expected), media }
  await fs.writeFile(filename, damaged)
  await assert.rejects(downloadVideo('https://media.example/owned.mp4', filename, {
    repairExisting: true, reusableFiles: [registered],
    fetch: async () => new Response(expected, { headers: { 'content-type': 'video/mp4' } }),
    probe: async () => { throw new Error('replacement validation failed') },
  }), /replacement validation failed/)
  assert.deepEqual(await fs.readFile(filename), damaged, 'failed replacement retains the registered damaged file')
  const repaired = await downloadVideo('https://media.example/owned.mp4', filename, {
    repairExisting: true, reusableFiles: [registered],
    fetch: async () => new Response(expected, { headers: { 'content-type': 'video/mp4' } }), probe: async () => media,
  })
  assert.equal(repaired.repaired, true)
  assert.deepEqual(await fs.readFile(filename), expected)
  const unknown = path.join(root, 'unknown.mp4')
  await fs.writeFile(unknown, 'unregistered original')
  await assert.rejects(downloadVideo('https://media.example/unknown.mp4', unknown, {
    repairExisting: true, reusableFiles: [], fetch: () => assert.fail('unknown files are never replaced'),
  }), /已保留原文件/)
  assert.equal(await fs.readFile(unknown, 'utf8'), 'unregistered original')
})

test('a limited repeat collection preserves other clips already stored in the database', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  const data = project()
  data.clips.push({ ...data.clips[0], id: '100002', idx: '2', content: 'second narration' })
  const fixture = collectionFixture(data)
  await collect(options, fixture)
  const savedStats = readStats(root)
  assert.equal(savedStats.clips, 2)
  assert.equal(savedStats.recommendations, 8)
  const otherClip = (await readIndex(root)).filter(item => item.clipId === '100002')
  assert.equal(otherClip.length, 3)

  const limited = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db'), '--limit', '1'])
  const result = await collect(limited, fixture)
  assert.equal(result.clips.length, 1)
  assert.equal(result.clips[0].clipId, '100001')
  assert.deepEqual(readStats(root), savedStats)
  assert.deepEqual((await readIndex(root)).filter(item => item.clipId === '100002'), otherClip)
  assert.equal(fixture.requests.length, 6)
})

test('corrupted JSON backups do not block database queries or collection recovery', async t => {
  const root = await directory(t)
  const options = parseOptions(['--project', pid, '--output', root, '--database', path.join(root, 'materials.db')])
  const fixture = collectionFixture()
  await collect(options, fixture)
  const savedIndex = await readIndex(root)
  for (const filename of ['manifest.json', 'dataset.jsonl', 'clips/001/annotation.json']) {
    await fs.writeFile(path.join(root, filename), '{ broken backup')
  }
  assert.deepEqual(await readIndex(root), savedIndex)
  assert.equal(readStats(root).downloadedRecommendations, 3)
  const result = await collect(options, fixture)
  assert.equal(result.clips[0].status, 'done')
  assert.ok(result.clips[0].candidates.slice(0, 3).every(item => item.download.reused))
  assert.equal(fixture.requests.length, 3)
})

test('offline import validates actual local files, upserts once and never requests Huasheng', async t => {
  const { root, options, record } = await offlineFixture(t)
  const network = t.mock.method(globalThis, 'fetch', () => assert.fail('offline import must not request a website'))
  const initial = await importExisting(options, { log() {} })
  assert.deepEqual(initial, { projects: 1, clips: 1, recommendations: 3, assets: 3, downloadedAssets: 3, files: 3, downloadedRecommendations: 3 })
  const indexed = await readIndex(root)
  assert.equal(indexed.length, 3)
  for (const item of indexed) {
    const bytes = await fs.readFile(item.localPath)
    assert.ok(path.isAbsolute(item.localPath))
    assert.equal(item.status, 'done')
    assert.equal(item.query, record.query)
    assert.equal(item.bytes, bytes.length)
    assert.equal(item.sha256, digest(bytes))
  }
  await fs.writeFile(path.join(root, 'clips/001/annotation.json'), JSON.stringify({ ...record, query: 'stale replacement label' }))
  const library = new HuashengMaterialLibrary({ databasePath: options.database })
  try {
    library.saveProject({ projectId: pid, title: 'updated database title', projectUrl: options.projectUrl, totalClips: 2, top: 3 })
    const storedProject = library.db.prepare('SELECT * FROM huasheng_material_projects WHERE project_id=?').get(pid)
    const repeated = await importExisting(options, { library, log() {} })
    assert.deepEqual(repeated, initial)
    assert.deepEqual(library.db.prepare('SELECT * FROM huasheng_material_projects WHERE project_id=?').get(pid), storedProject,
      'older manifest metadata must not overwrite the database project')
    assert.equal(library.getClip(pid, record.clipId, root).query, record.query)
    assert.equal(library.search({ projectId: pid }).length, 3, 'injected library remains usable after import')
  } finally { library.close() }
  assert.deepEqual(await readIndex(root), indexed)
  assert.equal(network.mock.callCount(), 0)
})

test('offline import records size and hash mismatches as failed instead of downloaded', async t => {
  const { root, options, record } = await offlineFixture(t)
  const network = t.mock.method(globalThis, 'fetch', () => assert.fail('file verification must remain offline'))
  const changedHash = record.candidates[1].download
  await fs.writeFile(path.join(root, changedHash.localPath), Buffer.alloc(changedHash.bytes, 120))
  await fs.appendFile(path.join(root, record.candidates[2].download.localPath), 'extra bytes')
  const stats = await importExisting(options, { log() {} })
  assert.equal(stats.recommendations, 3)
  assert.equal(stats.files, 1)
  assert.equal(stats.downloadedRecommendations, 1)
  const indexed = await readIndex(root)
  assert.deepEqual(indexed.map(item => [item.assetId, item.status]), [['a', 'done'], ['b', 'failed'], ['c', 'failed']])
  for (const item of indexed.slice(1)) {
    assert.match(item.error, /导入文件核验失败/)
    assert.equal(Object.hasOwn(item, 'sha256'), false)
  }
  const library = new HuashengMaterialLibrary({ databasePath: options.database })
  try {
    assert.equal(library.getClip(pid, record.clipId, root).status, 'incomplete')
    assert.deepEqual(library.search({ projectId: pid }).map(item => item.assetId), ['a'])
  } finally { library.close() }
  assert.equal(network.mock.callCount(), 0)
})

test('project listing reads every page without filtering project types or trusting sandbox flags', async () => {
  const records = Array.from({ length: 65 }, (_, index) => ({ pid: String(100000 + index), name: `project ${index}`, is_agent_sandbox: false, project_type: index % 3 }))
  const pages = []
  const client = createClient({ session, fetch: async (input, options) => {
    const url = new URL(input)
    assert.equal(url.pathname, '/api/innovideo/project/list')
    assert.equal(url.searchParams.get('ps'), '20')
    assert.equal(options.headers.Cookie, session.cookie)
    const pn = Number(url.searchParams.get('pn'))
    pages.push(pn)
    return json({ total: '65', projects: records.slice((pn - 1) * 20, pn * 20) })
  } })
  assert.deepEqual(await client.projects(), records)
  assert.deepEqual(pages, [1, 2, 3, 4])
  const empty = createClient({ session, fetch: async () => json({ code: 404 }) })
  assert.deepEqual(await empty.projects(), [])
})

test('an unproduced project with a null clip list is empty while malformed produced projects still fail', async () => {
  const client = stage => createClient({ session, fetch: async input => {
    const url = new URL(input)
    if (url.pathname === '/api/innovideo/project/info') return json(project())
    return json({ code: 0, data: { project: { pid, project_stage: stage, version: 0 }, clips: null } })
  } })
  assert.deepEqual((await client(0).project(pid)).data.clips, [])
  await assert.rejects(client(3).project(pid), /缺少 clips/)
})

test('project listing rejects login errors and incomplete or changing pagination', async t => {
  const first = { total: '2', projects: [{ pid: '100001' }] }
  const cases = [
    ['login required', [{ code: 401 }], /接口错误 401/],
    ['missing total', [{ projects: [] }], /总数无效/],
    ['invalid project', [{ total: 1, projects: [{}] }], /projects/],
    ['early end', [first, { total: '2', projects: [] }], /提前结束/],
    ['duplicate project', [first, first], /重复项目/],
    ['changed total', [first, { total: '3', projects: [{ pid: '100002' }] }], /已变化/],
    ['extra records', [{ total: '0', projects: [{ pid: '100001' }] }], /数量不匹配/],
  ]
  for (const [name, responses, expected] of cases) await t.test(name, async () => {
    const client = createClient({ session, fetch: async () => {
      assert.ok(responses.length)
      return json(responses.shift())
    } })
    await assert.rejects(client.projects(), expected)
  })
})

test('verified local assets are hard-linked into another clip without downloading again', async t => {
  const root = await directory(t)
  const source = path.join(root, 'source.mp4')
  const filename = path.join(root, 'another-clip.mp4')
  const bytes = Buffer.from('already verified video')
  await fs.writeFile(source, bytes)
  const result = await downloadVideo('https://media.example/source.mp4', filename, {
    reusableFiles: [{ filePath: source, bytes: bytes.length, sha256: digest(bytes), media }],
    fetch: () => assert.fail('existing verified asset must not be downloaded'),
    probe: () => assert.fail('previous media validation is retained'),
  })
  assert.equal(result.reused, true)
  assert.equal(result.sha256, digest(bytes))
  assert.deepEqual(await fs.readFile(filename), bytes)
  assert.equal((await fs.stat(source)).ino, (await fs.stat(filename)).ino)
  await absent(`${filename}.part`)
})

test('missing or corrupted reusable files fall back to download and preserve their contents', async t => {
  const root = await directory(t)
  const source = path.join(root, 'corrupt.mp4')
  const filename = path.join(root, 'downloaded.mp4')
  const corrupted = Buffer.from('bad video')
  const bytes = Buffer.from('real video')
  await fs.writeFile(source, corrupted)
  let downloads = 0
  const result = await downloadVideo('https://media.example/source.mp4', filename, {
    reusableFiles: [
      { filePath: path.join(root, 'missing.mp4'), bytes: bytes.length, sha256: digest(bytes), media },
      { filePath: source, bytes: corrupted.length, sha256: digest(bytes), media },
    ],
    fetch: async () => { downloads++; return new Response(bytes) },
    probe: async () => media,
  })
  assert.equal(downloads, 1)
  assert.equal(result.reused, false)
  assert.deepEqual(await fs.readFile(source), corrupted)
  assert.deepEqual(await fs.readFile(filename), bytes)
})

test('low disk space stops new downloads while leaving existing files untouched', async t => {
  const root = await directory(t)
  const filename = path.join(root, 'new.mp4')
  const previous = process.env.MEDIA_DISK_RESERVE_GIB
  delete process.env.MEDIA_DISK_RESERVE_GIB
  t.after(() => { if (previous !== undefined) process.env.MEDIA_DISK_RESERVE_GIB = previous })
  t.mock.method(fs, 'statfs', async () => ({ bavail: 9 * 1024 ** 2, bsize: 1024 }))
  await assert.rejects(downloadVideo('https://media.example/source.mp4', filename, {
    fetch: () => assert.fail('a new transfer must not start without sufficient space'),
  }), { code: 'MATERIAL_DISK_FULL' })
  await absent(filename)
  await absent(`${filename}.part`)
})

test('configured disk reserve stops new transfers while verified local media remains reusable', async t => {
  const root = await directory(t)
  const filename = path.join(root, 'new.mp4')
  const previous = process.env.MEDIA_DISK_RESERVE_GIB
  process.env.MEDIA_DISK_RESERVE_GIB = '1000000000'
  t.after(() => {
    if (previous === undefined) delete process.env.MEDIA_DISK_RESERVE_GIB
    else process.env.MEDIA_DISK_RESERVE_GIB = previous
  })
  await assert.rejects(downloadVideo('https://media.example/source.mp4', filename, {
    fetch: () => assert.fail('configured reserve must stop a new transfer'),
  }), { code: 'MATERIAL_DISK_FULL' })
  const bytes = Buffer.from('verified local video')
  await fs.writeFile(filename, bytes)
  const saved = { status: 'done', bytes: bytes.length, sha256: digest(bytes), media }
  assert.equal((await downloadVideo('https://media.example/source.mp4', filename, {
    previous: saved, fetch: () => assert.fail('verified local video must not be downloaded again'),
  })).reused, true)
  await absent(`${filename}.part`)
})
