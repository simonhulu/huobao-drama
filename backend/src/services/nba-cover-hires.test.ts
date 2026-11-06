import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { discoverNbaHiresPhotos, nbaHiresSourceUrl } from './nba-cover-hires.js'
import type { NbaBodyRequest } from './nba-cover-body.js'

const tag = 'https://www.pngarts.com/explore/tag/draymond-green'
const image = (id: number, height = 1000) => ({ '@type': 'ImageObject', name: 'Draymond Green PNG Picture',
  contentUrl: `https://www.pngarts.com/files/5/Draymond-Green-${id}.png`, url: `https://www.pngarts.com/explore/${id}`,
  encodingFormat: 'image/png', width: 1000, height })
const html = (rows: unknown[], canonical = tag, title = 'Draymond Green PNG Transparent Images, Pictures, Photos') =>
  `<html><head><title>${title}</title><link rel="canonical" href="${canonical}"></head><body><h1>${title}</h1><script type="application/ld+json">${JSON.stringify({ '@graph': rows })}</script></body></html>`
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nba-hires-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return { playerName: 'Draymond Green', directory, signal: new AbortController().signal }
}
const request = (body: string, calls: string[] = []): NbaBodyRequest => async (url, kind) => {
  assert.equal(kind, 'body-api'); calls.push(url)
  return { sourceUrl: url, bytes: Buffer.from(body) }
}

test('discovers bounded original PNG candidates from matching structured tag metadata, sorted by height', async t => {
  const input = await fixture(t), calls: string[] = []
  const rows = [image(1, 900), image(2, 1800), image(3, 1300), image(3, 1300), image(4, 800), image(5, 749)]
  const result = await discoverNbaHiresPhotos(input, request(html(rows), calls))
  assert.deepEqual(calls, [tag])
  assert.deepEqual(result, [image(2, 1800), image(3, 1300), image(1, 900)].map(row => ({ sourceUrl: row.contentUrl, pageUrl: row.url })))
})

test('full normalized names are required for both the tag and each image, including accent normalization', async t => {
  const input = await fixture(t)
  const wrongNames = ['Jalen Green PNG', 'Draymond Green Jr PNG', 'Draymond Green and Stephen Curry PNG', 'Draymond Green Stephen Curry PNG', 'Draymond Greens PNG']
  assert.deepEqual(await discoverNbaHiresPhotos(input, request(html(wrongNames.map((name, index) => ({ ...image(index), name }))))), [])
  const luka = { ...input, playerName: 'Luka Dončić' }
  const lukaTag = 'https://www.pngarts.com/explore/tag/luka-doncic'
  const result = await discoverNbaHiresPhotos(luka, request(html([{ ...image(7), name: 'Luka Doncic Free PNG Image' }], lukaTag, 'Luka Dončić PNG Images')))
  assert.equal(result.length, 1)
})

test('wrong canonical pages, changed response origins and unrelated headings cannot supply candidates', async t => {
  for (const body of [html([image(1)], tag + '?other=1'), html([image(1)], 'https://evil.example/explore/tag/draymond-green'), html([image(1)], tag, 'Jalen Green PNG Images')]) {
    const input = await fixture(t)
    assert.deepEqual(await discoverNbaHiresPhotos(input, request(body)), [])
    assert.deepEqual(await fs.readdir(input.directory), [])
  }
  const input = await fixture(t)
  assert.deepEqual(await discoverNbaHiresPhotos(input, async () => ({ sourceUrl: 'https://evil.example/', bytes: Buffer.from(html([image(1)])) })), [])
})

test('unsafe image sources, article pages, schema types and dimensions are discarded', async t => {
  const rows = [
    { ...image(1), contentUrl: 'https://www.pngarts.com.evil.example/files/5/player.png' },
    { ...image(2), contentUrl: 'https://user:secret@www.pngarts.com/files/5/player.png' },
    { ...image(3), contentUrl: 'https://www.pngarts.com/files/5/player.png?x=1' },
    { ...image(4), contentUrl: 'https://www.pngarts.com/files/5/player.jpg' },
    { ...image(5), url: 'https://www.pngarts.com/explore/tag/other' },
    { ...image(6), url: 'https://evil.example/explore/6' },
    { ...image(7), width: 599 }, { ...image(8), height: 4097 }, { ...image(9), height: '1000' },
    { ...image(10), '@type': 'NewsArticle' }, { ...image(11), encodingFormat: 'image/jpeg' },
  ]
  assert.deepEqual(await discoverNbaHiresPhotos(await fixture(t), request(html(rows))), [])
  assert.throws(() => nbaHiresSourceUrl('http://www.pngarts.com/files/5/player.png', 'photo'))
  assert.throws(() => nbaHiresSourceUrl('https://www.pngarts.com/explore/123#other', 'page'))
})

test('verified successful discovery is reused offline, while a tampered cache is revalidated and refreshed', async t => {
  const input = await fixture(t), calls: string[] = []
  const first = await discoverNbaHiresPhotos(input, request(html([image(1)]), calls))
  const cached = await discoverNbaHiresPhotos(input, async () => { throw new Error('Offline') })
  assert.deepEqual(cached, first)
  const filename = path.join(input.directory, (await fs.readdir(input.directory))[0])
  const saved = JSON.parse(await fs.readFile(filename, 'utf8'))
  saved.images[0].name = 'Jalen Green PNG Picture'
  saved.imagesSha256 = createHash('sha256').update(JSON.stringify(saved.images)).digest('hex')
  await fs.writeFile(filename, JSON.stringify(saved))
  const refreshed = await discoverNbaHiresPhotos(input, request(html([image(2)]), calls))
  assert.deepEqual(refreshed, [{ sourceUrl: image(2).contentUrl, pageUrl: image(2).url }])
  assert.deepEqual(calls, [tag, tag])
})

test('empty, malformed and failed responses do not create persistent negative cache entries', async t => {
  const input = await fixture(t), calls: string[] = []
  assert.deepEqual(await discoverNbaHiresPhotos(input, request(html([]), calls)), [])
  assert.deepEqual(await discoverNbaHiresPhotos(input, request('<script type="application/ld+json">{broken</script>', calls)), [])
  assert.deepEqual(await discoverNbaHiresPhotos(input, async () => { calls.push(tag); throw new Error('Temporary outage') }), [])
  assert.deepEqual(await fs.readdir(input.directory), [])
  assert.equal((await discoverNbaHiresPhotos(input, request(html([image(1)]), calls))).length, 1)
  assert.equal(calls.length, 4)
})

test('cancellation before or during requests propagates instead of being treated as missing photos', async t => {
  const input = await fixture(t), before = new AbortController(), reason = new Error('Cancelled discovery')
  before.abort(reason)
  await assert.rejects(discoverNbaHiresPhotos({ ...input, signal: before.signal }, request(html([image(1)]))), error => error === reason)
  const during = new AbortController()
  await assert.rejects(discoverNbaHiresPhotos({ ...input, signal: during.signal }, async () => { during.abort(reason); throw reason }), error => error === reason)
})
