import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { nbaBodyRequestUrl, resolveNbaBodyPhoto, type NbaBodyPrepare, type NbaBodyRequest } from './nba-cover-body.js'

const render = 'https://r2.thesportsdb.com/images/media/player/render/realbody123.png'
const cutout = 'https://r2.thesportsdb.com/images/media/player/cutout/portrait123.png'
const search = 'https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=Luka%20Doncic'
const lookup = 'https://www.thesportsdb.com/api/v1/json/123/lookupplayer.php?id=34160864'
const player = { id: '3945274', name: 'Luka Doncic', teamAbbreviation: 'LAL' }
const record = { idPlayer: '34160864', strPlayer: 'Luka Dončić', strSport: 'Basketball', strTeam: 'Los Angeles Lakers', strRender: render, strCutout: cutout }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const pixels = Buffer.alloc(400 * 500 * 4)
for (let y = 0; y < 500; y++) for (let x = 0; x < 400; x++) {
  const i = (y * 400 + x) * 4
  pixels[i] = (x + y) % 256; pixels[i + 1] = (x * 2 + y) % 256; pixels[i + 2] = (x + y * 3) % 256
  pixels[i + 3] = x > 60 && x < 340 && y > 20 && y < 480 ? 255 : 0
}
const body = await sharp(pixels, { raw: { width: 400, height: 500, channels: 4 } }).png().toBuffer()
const alternateBody = await sharp(body).flop().png().toBuffer()
async function directory(t: { after: (callback: () => Promise<void>) => void }) {
  const name = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-body-test-'))
  t.after(() => fs.rm(name, { recursive: true, force: true }))
  return name
}
function request(rows: Record<string, unknown>, calls: string[] = []): NbaBodyRequest {
  return async (url, kind) => {
    nbaBodyRequestUrl(url, kind); calls.push(url)
    assert.ok(url in rows, `Unexpected source ${url}`)
    const value = rows[url]
    if (value instanceof Error) throw value
    return { sourceUrl: url, bytes: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)) }
  }
}
const prepareBody: NbaBodyPrepare = async ({ filename, signal }) => {
  signal.throwIfAborted()
  const bytes = await fs.readFile(filename), metadata = await sharp(bytes).metadata()
  return { path: filename, sha256: digest(bytes), width: metadata.width!, height: metadata.height!, crop: { x: .1, y: 0, width: .8, height: 1 }, verification: { body: true, teamMatches: true } }
}
const input = (directory: string, signal = new AbortController().signal) => ({ player, directory, teamName: '湖人', signal })

test('search identities match exactly after normalization, lookup retrieves render, and processed body evidence is retained', async t => {
  const dir = await directory(t), calls: string[] = [], checked: string[] = []
  const result = await resolveNbaBodyPhoto(input(dir), { request: request({ [search]: { player: [
    { ...record, strPlayer: 'Luka Doncic Jr', strRender: 'https://evil.example/wrong.png' },
    { ...record, strSport: 'Soccer', strRender: 'https://evil.example/wrong2.png' },
    { ...record, strRender: undefined },
  ] }, [lookup]: { players: [record] }, [render]: body, [cutout]: new Error('No alternate photograph') }, calls), prepareBody: async value => {
    assert.equal(value.playerName, 'Luka Doncic'); assert.equal(value.teamName, '湖人'); assert.equal(value.teamAbbreviation, 'LAL')
    checked.push(value.filename); return prepareBody(value)
  } })
  assert.equal(result?.photoKind, 'body'); assert.equal(result?.sourceUrl, render)
  assert.deepEqual(calls, [search, lookup, render, cutout]); assert.equal(checked.length, 1)
  assert.equal(result?.photoWidth, 400); assert.equal(result?.photoHeight, 500)
  assert.equal(result?.photoSha256, digest(body)); assert.equal(result?.photoVerification?.sourceSha256, digest(body))
  assert.deepEqual(result?.photoCrop, { x: .1, y: 0, width: .8, height: 1 })
})

test('a current profile does not override visual rejection of an old jersey or a headshot', async t => {
  const dir = await directory(t), checked: string[] = []
  const result = await resolveNbaBodyPhoto(input(dir), { request: request({ [search]: { player: [record] }, [render]: body, [cutout]: body }), prepareBody: async ({ filename }) => {
    checked.push(filename); return null
  } })
  assert.equal(result, undefined); assert.equal(checked.length, 2)
})

test('verified high-resolution sources work independently of the sports directory and retain provenance', async t => {
  const dir = await directory(t), url = 'https://www.pngarts.com/files/5/Luka-Doncic-PNG-Image.png'
  const result = await resolveNbaBodyPhoto(input(dir), {
    request: request({ [search]: new Error('directory unavailable'), [url]: body }), prepareBody,
    additionalPhotos: async () => [{ sourceUrl: url, pageUrl: 'https://www.pngarts.com/explore/123' }],
  })
  assert.equal(result?.sourceUrl, url)
  assert.equal(result?.photoVerification?.sourcePageUrl, 'https://www.pngarts.com/explore/123')
  assert.equal(result?.photoVerification?.sourceSha256, digest(body))
  const fallback = await resolveNbaBodyPhoto(input(await directory(t)), {
    request: request({ [search]: { player: [record] }, [render]: body }), prepareBody,
    additionalPhotos: async () => { throw new Error('additional source unavailable') },
  })
  assert.equal(fallback?.sourceUrl, render)
})

test('recent photo history selects another qualified pose of the same player and works from the verified cache', async t => {
  const dir = await directory(t), calls: string[] = []
  const options = { request: request({ [search]: { player: [record] }, [render]: body, [cutout]: alternateBody }, calls), prepareBody }
  const result = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: [digest(body)] }, options)
  assert.equal(result?.name, player.name); assert.equal(result?.sourceUrl, cutout)
  assert.equal(result?.photoSha256, digest(alternateBody))
  assert.deepEqual(calls, [search, render, cutout])
  const offlineCalls: string[] = []
  const cached = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: [digest(body)] }, { request: request({}, offlineCalls), prepareBody })
  assert.deepEqual(cached, result); assert.deepEqual(offlineCalls, [])
})

test('recent history recognizes the prepared photo hash as well as the original source hash', async t => {
  const dir = await directory(t)
  const preparedBody = await sharp(body).modulate({ brightness: .9 }).png().toBuffer()
  const result = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: [digest(preparedBody)] }, {
    request: request({ [search]: { player: [record] }, [render]: body, [cutout]: alternateBody }),
    prepareBody: async value => {
      if (value.filename.includes(digest(render).slice(0, 16))) {
        const processedPath = path.join(dir, 'processed-render.png')
        await fs.writeFile(processedPath, preparedBody)
        return { ...(await prepareBody(value))!, path: processedPath, sha256: digest(preparedBody) }
      }
      return prepareBody(value)
    },
  })
  assert.equal(result?.sourceUrl, cutout)
  assert.equal(result?.photoSha256, digest(alternateBody))
})

test('all previously used poses or an invalid alternative retain the first qualified photo', async t => {
  for (const rejectAlternative of [false, true]) {
    const dir = await directory(t), checked: string[] = []
    const result = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: rejectAlternative ? [digest(body)] : [digest(body), digest(alternateBody)] }, {
      request: request({ [search]: { player: [record] }, [render]: body, [cutout]: alternateBody }),
      prepareBody: async value => {
        checked.push(value.filename)
        if (rejectAlternative && value.filename.includes(digest(cutout).slice(0, 16))) return null
        return prepareBody(value)
      },
    })
    assert.equal(checked.length, 2)
    assert.equal(result?.sourceUrl, render); assert.equal(result?.photoSha256, digest(body))
  }
})

test('a clear recently used photograph wins over an unused low-resolution photograph', async t => {
  const dir = await directory(t), highResolution = await sharp(body).resize(800, 1000).png().toBuffer()
  const result = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: [digest(highResolution)] }, {
    request: request({ [search]: { player: [record] }, [render]: highResolution, [cutout]: body }), prepareBody,
  })
  assert.equal(result?.sourceUrl, render)
  assert.equal(result?.photoSha256, digest(highResolution))
  assert.ok(Number(result?.photoVerification?.upscaleToFill) <= 1.15)
})

test('among sufficiently clear photographs, a recent pose is avoided even when its canvas is larger', async t => {
  const dir = await directory(t), larger = await sharp(body).resize(1200, 1500).png().toBuffer()
  const clearAlternative = await sharp(alternateBody).resize(800, 1000).png().toBuffer()
  const result = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: [digest(larger)] }, {
    request: request({ [search]: { player: [record] }, [render]: larger, [cutout]: clearAlternative }), prepareBody,
  })
  assert.equal(result?.sourceUrl, cutout)
  assert.equal(result?.photoSha256, digest(clearAlternative))
})

test('resolution ranking measures the visible player after trimming rather than the transparent canvas', async t => {
  const dir = await directory(t)
  const largeCanvas = await sharp({ create: { width: 2000, height: 2000, channels: 4, background: '#00000000' } })
    .composite([{ input: body, left: 800, top: 750 }]).png().toBuffer()
  const clearAlternative = await sharp(alternateBody).resize(800, 1000).png().toBuffer()
  const result = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: [digest(clearAlternative)] }, {
    request: request({ [search]: { player: [record] }, [render]: largeCanvas, [cutout]: clearAlternative }), prepareBody,
  })
  assert.equal(result?.sourceUrl, cutout)
  assert.ok(Number(result?.photoVerification?.effectiveWidth) < 800)
  assert.ok(Number(result?.photoVerification?.effectiveHeight) < 1000)
})

test('when every photograph is small, substantially better native detail wins before avoiding reuse', async t => {
  const dir = await directory(t), larger = await sharp(body).resize(500, 625).png().toBuffer()
  const result = await resolveNbaBodyPhoto({ ...input(dir), recentPhotoSha256s: [digest(larger)] }, {
    request: request({ [search]: { player: [record] }, [render]: larger, [cutout]: body }), prepareBody,
  })
  assert.equal(result?.sourceUrl, render)
  assert.equal(result?.photoSha256, digest(larger))
})

test('successfully cached search, lookup and original PNG work without networking, with visual validation still required', async t => {
  const dir = await directory(t), rows = { [search]: { player: [{ ...record, strRender: undefined }] }, [lookup]: { players: [record] }, [render]: body, [cutout]: alternateBody }
  const first = await resolveNbaBodyPhoto(input(dir), { request: request(rows), prepareBody })
  const calls: string[] = []
  const offline = await resolveNbaBodyPhoto(input(dir), { request: request({}, calls), prepareBody })
  assert.deepEqual(offline, first); assert.deepEqual(calls, [])
  const rejected = await resolveNbaBodyPhoto(input(dir), { request: request({}, calls), prepareBody: async () => null })
  assert.equal(rejected, undefined)
  calls.length = 0
  await fs.writeFile(first!.photoPath!, 'broken')
  const repaired = await resolveNbaBodyPhoto(input(dir), { request: request({ [render]: body }, calls), prepareBody })
  assert.equal(repaired?.photoSha256, first?.photoSha256); assert.deepEqual(calls, [render])
})

test('a transient lookup failure is not permanently hidden by the successful search cache', async t => {
  const dir = await directory(t)
  const first = await resolveNbaBodyPhoto(input(dir), { request: request({ [search]: { player: [{ ...record, strRender: undefined }] }, [lookup]: new Error('temporary outage'), [cutout]: body }), prepareBody: async () => null })
  assert.equal(first, undefined)
  const calls: string[] = []
  const next = await resolveNbaBodyPhoto(input(dir), { request: request({ [lookup]: { players: [record] }, [render]: body }, calls), prepareBody })
  assert.ok(next?.photoPath); assert.deepEqual(calls, [lookup, render])
})

test('a partial lookup preserves the matching search result cutout for visual validation', async t => {
  const dir = await directory(t), calls: string[] = []
  const result = await resolveNbaBodyPhoto(input(dir), { request: request({ [search]: { player: [{ ...record, strRender: undefined }] },
    [lookup]: { players: [{ ...record, strRender: undefined, strCutout: undefined }] }, [cutout]: body }, calls), prepareBody })
  assert.equal(result?.sourceUrl, cutout); assert.equal(result?.photoKind, 'body')
  assert.deepEqual(calls, [search, lookup, cutout])
})

test('unsafe domains, paths, credentials and non-PNG body images are rejected', async t => {
  for (const [url, kind] of [
    ['http://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=Name', 'body-api'],
    ['https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=Name&extra=1', 'body-api'],
    ['https://www.thesportsdb.com/api/v1/json/123/lookupplayer.php?id=../secret', 'body-api'],
    ['https://r2.thesportsdb.com.evil.example/images/media/player/render/real.png', 'body-photo'],
    ['https://r2.thesportsdb.com@127.0.0.1/images/media/player/render/real.png', 'body-photo'],
    ['https://r2.thesportsdb.com/images/media/player/thumb/real.png', 'body-photo'],
    ['https://r2.thesportsdb.com/images/media/player/render/real.jpg', 'body-photo'],
    ['https://www.pngarts.com.evil.example/files/5/Player.png', 'body-photo'],
    ['https://www.pngarts.com/files/5/Player.png?redirect=evil', 'body-photo'],
    ['https://www.pngarts.com/explore/tag/../../admin', 'body-api'],
  ] as const) assert.throws(() => nbaBodyRequestUrl(url, kind))
  for (const bytes of [Buffer.from('<html>blocked</html>'), await sharp(body).flatten().png().toBuffer()]) {
    const dir = await directory(t)
    let checked = false
    const result = await resolveNbaBodyPhoto(input(dir), { request: request({ [search]: { player: [{ ...record, strCutout: undefined }] }, [render]: bytes }), prepareBody: async value => {
      checked = true; return prepareBody(value)
    } })
    assert.equal(result, undefined); assert.equal(checked, false)
  }
})

test('processor output must match the actual processed PNG and a valid normalized crop', async t => {
  for (const change of [
    { sha256: '0'.repeat(64) }, { width: 800 }, { crop: { x: .8, y: 0, width: .8, height: 1 } },
  ]) {
    const dir = await directory(t)
    const result = await resolveNbaBodyPhoto(input(dir), { request: request({ [search]: { player: [{ ...record, strCutout: undefined }] }, [render]: body }), prepareBody: async value => ({ ...(await prepareBody(value))!, ...change }) })
    assert.equal(result, undefined)
  }
})

test('mismatched search and lookup identities cannot supply a different player photo', async t => {
  const dir = await directory(t), calls: string[] = []
  const result = await resolveNbaBodyPhoto(input(dir), { request: request({ [search]: { player: [{ ...record, strPlayer: 'Luka Doncic Jr' }] } }, calls), prepareBody })
  assert.equal(result, undefined); assert.deepEqual(calls, [search])
})

test('cancellation propagates from cached, network and image preparation work', async t => {
  const reason = new Error('cancel body lookup'), before = new AbortController()
  before.abort(reason)
  await assert.rejects(resolveNbaBodyPhoto(input(await directory(t), before.signal), { request: request({}), prepareBody }), error => error === reason)
  const network = new AbortController()
  await assert.rejects(resolveNbaBodyPhoto(input(await directory(t), network.signal), { request: async () => { network.abort(reason); throw reason }, prepareBody }), error => error === reason)
  const preparing = new AbortController()
  await assert.rejects(resolveNbaBodyPhoto(input(await directory(t), preparing.signal), { request: request({ [search]: { player: [record] }, [render]: body }), prepareBody: async () => { preparing.abort(reason); throw reason } }), error => error === reason)
})
