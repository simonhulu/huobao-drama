import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {fileURLToPath, pathToFileURL} from 'node:url'
import sharp from 'sharp'
import {createMapPresentation, getMotionMapPack, motionMapCatalog, prepareMapForces, prepareMotionMap, type MotionMapForce} from './history-motion-maps.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const {prepareMapData} = await import(pathToFileURL(path.join(root, 'scripts/history-motion/map-data.mjs')).href)
const {validateMap} = await import(pathToFileURL(path.join(root, 'scripts/history-motion/render.mjs')).href)
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const read = (filename: string) => JSON.parse(fs.readFileSync(filename, 'utf8'))

const point = (name: string, lon: number, lat: number) => ({type: 'Feature',
  properties: {NAME_ZH: name, NAME: name, NE_ID: name, ADM0NAME: 'China'},
  geometry: {type: 'Point', coordinates: [lon, lat]}})

function fixture(t: TestContext, points = [point('武汉', 114.268071, 30.581977), point('赤壁市', 113.880015, 29.72042)]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-motion-map-'))
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}))
  const sources = path.join(directory, 'sources')
  fs.mkdirSync(sources)
  function dataset(name: string, features: unknown[]) {
    const filename = path.join(sources, `${name}.geojson`)
    const bytes = JSON.stringify({type: 'FeatureCollection', features})
    fs.writeFileSync(filename, bytes)
    fs.writeFileSync(`${filename}.source.json`, JSON.stringify({url: `https://example.org/natural-earth/${name}`,
      sha256: hash(bytes), downloadedAt: '2026-10-26T00:00:00Z'}))
  }
  dataset('ne_10m_populated_places', points)
  dataset('ne_10m_rivers_lake_centerlines', [{type: 'Feature', properties: {name: 'river'},
    geometry: {type: 'LineString', coordinates: [[112, 29.8], [116, 30.5]]}}])
  const calls: string[] = []
  let tilePromise: Promise<Buffer> | undefined
  const tile = async (elevation?: number) => {
    const pixels = Buffer.alloc(256 * 256 * 3)
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const height = elevation ?? -500 + x * 4 + y * 3
      const encoded = Math.round((height + 32768) * 256), index = (y * 256 + x) * 3
      pixels[index] = Math.floor(encoded / 65536)
      pixels[index + 1] = Math.floor(encoded / 256) % 256
      pixels[index + 2] = encoded % 256
    }
    return sharp(pixels, {raw: {width: 256, height: 256, channels: 3}}).png().toBuffer()
  }
  async function fetchImpl(url: string) {
    calls.push(String(url))
    assert.match(String(url), /elevation-tiles-prod\/terrarium\//, 'unexpected network lookup for locally known city')
    tilePromise ??= tile()
    return new Response(new Uint8Array(await tilePromise), {headers: {'content-type': 'image/png',
      'x-amz-meta-x-imagery-sources': 'srtm/N30E114.tif, gmted/30N090E_20101117.tif'}})
  }
  const options = {cacheDirectory: path.join(directory, 'cache'), sourceDirectories: [sources], terrainDirectories: [],
    width: 320, height: 180, fetchImpl, referenceDirectory: null, terrainProvider: 'mapzen'}
  const input = {title: '赤壁地理关系', places: ['武汉', '赤壁'], routes: [{from: '武汉', to: '赤壁', label: '向南推进'}],
    duration: 6, directory: path.join(directory, 'output')}
  return {directory, dataset, input, options, calls, tile}
}

test('legacy map catalog and guarded Changping pack remain available', () => {
  assert.ok(motionMapCatalog.some(pack => pack.id === 'changping-context'))
  assert.equal(getMotionMapPack('changping-context', '长平之战').title, '长平与上党')
  assert.throws(() => getMotionMapPack('changping-context', '赤壁之战'), /不匹配/)
  assert.throws(() => getMotionMapPack('unknown', '赤壁之战'), /尚未准备/)
})

test('new region creates a real nonblank PNG, georeferenced cities, rivers and source manifest', async t => {
  const f = fixture(t)
  const result = await prepareMapData(f.input, f.options)
  const metadata = await sharp(result.backgroundPath).metadata()
  assert.equal(metadata.format, 'png')
  assert.deepEqual([metadata.width, metadata.height], [320, 180])
  const stats = await sharp(result.backgroundPath).stats()
  assert.ok(stats.channels.some(channel => channel.stdev > 3))
  assert.ok(result.bounds.maxLat < 33, 'new region must not silently use Changping bounds')
  assert.equal(f.calls.length, new Set(f.calls).size)
  assert.ok(f.calls.length > 0 && f.calls.length <= 16)
  const manifest = read(result.manifestPath)
  assert.equal(manifest.crs, 'EPSG:4326')
  assert.match(manifest.projection, /longitude and latitude linear/)
  assert.equal(manifest.backgroundSha256, hash(fs.readFileSync(result.backgroundPath)))
  assert.ok(manifest.sources.some((source: any) => source.title.includes('rivers')))
  assert.ok(manifest.sources.every((source: any) => source.url && source.license && source.attribution))
  assert.match(manifest.attribution, /路线示意/)
  assert.equal(manifest.historyStatus, 'illustrative')
  for (const city of result.cities) {
    const place = manifest.resolvedPlaces.find((item: any) => item.name === city.name)
    assert.equal(city.x, (place.lon - result.bounds.minLon) / (result.bounds.maxLon - result.bounds.minLon))
    assert.equal(city.y, (result.bounds.maxLat - place.lat) / (result.bounds.maxLat - result.bounds.minLat))
    assert.ok(city.x > 0 && city.x < 1 && city.y > 0 && city.y < 1)
  }
})

test('all route endpoints are cities in the identical projection, with bounded animation timing', async t => {
  const f = fixture(t)
  const result = await prepareMapData({...f.input, places: ['武汉'], routes: [
    {from: '武汉', to: '赤壁'}, {from: '赤壁', to: '武汉', label: '返回'},
  ]}, f.options)
  assert.deepEqual(result.cities.map((city: any) => city.name), ['武汉', '赤壁'])
  const [wuhan, chibi] = result.cities
  assert.deepEqual(result.routes[0].points, [[wuhan.x, wuhan.y], [chibi.x, chibi.y]])
  assert.deepEqual(result.routes[1].points, [[chibi.x, chibi.y], [wuhan.x, wuhan.y]])
  assert.ok(result.routes.every((route: any) => route.start >= 0 && route.end > route.start && route.end <= f.input.duration))
  assert.equal(result.routes[0].end, result.routes[1].start)
  assert.ok(result.routes.every((route: any) => /示意/.test(route.name)))
})

test('prepared terrain is reused offline across titles, durations and output projects', async t => {
  const f = fixture(t)
  const first = await prepareMapData(f.input, f.options)
  const requests = f.calls.length
  const rasterDirectories = path.join(f.options.cacheDirectory, 'rasters')
  const raster = path.join(rasterDirectories, fs.readdirSync(rasterDirectories)[0], 'terrain.png')
  const before = fs.statSync(raster).mtimeMs
  const second = await prepareMapData({...f.input, title: '同一地区另一镜', duration: .15,
    directory: path.join(f.directory, 'another-job')}, {...f.options, network: false})
  assert.equal(f.calls.length, requests)
  assert.equal(fs.statSync(raster).mtimeMs, before, 'must reuse rendered terrain, not only downloaded tiles')
  assert.equal(hash(fs.readFileSync(first.backgroundPath)), hash(fs.readFileSync(second.backgroundPath)))
  assert.notEqual(first.backgroundPath, second.backgroundPath)
  assert.ok(second.routes[0].end <= .15)
})

test('concurrent requests share terrain work and never overwrite another map in the same project', async t => {
  const f = fixture(t)
  const [first, second] = await Promise.all([
    prepareMapData(f.input, f.options),
    prepareMapData({...f.input, title: '第二张地图', duration: 4}, f.options),
  ])
  assert.equal(f.calls.length, new Set(f.calls).size)
  assert.notEqual(first.backgroundPath, second.backgroundPath)
  assert.equal(hash(fs.readFileSync(first.backgroundPath)), hash(fs.readFileSync(second.backgroundPath)))
  assert.equal(read(first.manifestPath).title, f.input.title)
  assert.equal(read(second.manifestPath).title, '第二张地图')
})

test('existing external Terrarium caches are reused without modifying their source files', async t => {
  const f = fixture(t)
  const first = await prepareMapData(f.input, f.options)
  const tileDirectory = path.join(f.options.cacheDirectory, 'terrarium')
  const before = fs.readdirSync(tileDirectory).map(file => [file, hash(fs.readFileSync(path.join(tileDirectory, file)))])
  const result = await prepareMapData({...f.input, directory: path.join(f.directory, 'offline')}, {...f.options,
    cacheDirectory: path.join(f.directory, 'fresh-cache'), terrainDirectories: [tileDirectory], network: false})
  assert.equal(hash(fs.readFileSync(first.backgroundPath)), hash(fs.readFileSync(result.backgroundPath)))
  assert.deepEqual(fs.readdirSync(tileDirectory).map(file => [file, hash(fs.readFileSync(path.join(tileDirectory, file)))]), before)
})

function wikidataResponse(url: string, alternatives = false) {
  const parsed = new URL(url)
  if (parsed.searchParams.get('action') === 'wbsearchentities') return Response.json({search: [
    {id: 'Q123', label: '瑞金市'}, ...(alternatives ? [{id: 'Q456', label: '瑞金市'}] : []),
  ]})
  const entity = (longitude: number) => ({claims: {P625: [{rank: 'normal', mainsnak: {snaktype: 'value', datavalue: {
    value: {longitude, latitude: 25.88, globe: 'http://www.wikidata.org/entity/Q2'},
  }}}]}})
  return Response.json({entities: {Q123: entity(116.02), ...(alternatives ? {Q456: entity(120)} : {})}})
}

test('missing local place uses sourced public coordinates once and reuses raw evidence offline', async t => {
  const f = fixture(t)
  const publicCalls: string[] = []
  const fetchImpl = async (url: string) => {
    if (!url.includes('wikidata.org')) return f.options.fetchImpl(url)
    publicCalls.push(url)
    return wikidataResponse(url)
  }
  const input = {...f.input, places: ['瑞金', '瑞金'], routes: [{from: '瑞金', to: '武汉'}]}
  const first = await prepareMapData(input, {...f.options, fetchImpl})
  assert.equal(publicCalls.length, 2)
  assert.equal(first.cities.filter((city: any) => city.role === 'primary').length, 2)
  const source = first.sources.find((item: any) => item.kind === 'wikidata')
  assert.equal(source.coordinateProperty, 'P625')
  assert.equal(source.license, 'CC0')
  assert.equal(source.raw.length, 2)
  for (const raw of source.raw) assert.equal(hash(fs.readFileSync(raw.localFile)), raw.sha256)
  const second = await prepareMapData(input, {...f.options, network: false})
  assert.deepEqual(second.cities, first.cities)
  assert.equal(publicCalls.length, 2)
})

test('verified Ruijin populated-place reference works without Wikidata and retains raw source evidence', async t => {
  const f = fixture(t)
  const referenceDirectory = path.join(root, 'scripts/history-motion/map-place-references')
  const result = await prepareMapData({...f.input, title: '瑞金 · 地理位置', places: ['瑞金'], routes: []}, {...f.options, referenceDirectory})
  const manifest = read(result.manifestPath), place = manifest.resolvedPlaces[0]
  assert.equal(place.lon, 116.02715)
  assert.equal(place.lat, 25.8832)
  assert.equal(place.locationStatus, 'modern-reference')
  assert.equal(place.source.license, 'CC BY 4.0')
  assert.match(place.source.url, /geonames.org\/10378131/)
  assert.ok(place.source.raw.every((item: any) => hash(fs.readFileSync(item.localFile)) === item.sha256))
  assert.ok(f.calls.every(url => url.includes('elevation-tiles-prod')))
  const offline = await prepareMapData({...f.input, title: '瑞金位置', places: ['瑞金市'], routes: []}, {...f.options, referenceDirectory, network: false})
  assert.equal(offline.cities.length, 1)
})

test('offline place fallback rejects coordinates edited away from the archived public source', async t => {
  const f = fixture(t), referenceDirectory = path.join(f.directory, 'references')
  fs.cpSync(path.join(root, 'scripts/history-motion/map-place-references'), referenceDirectory, {recursive: true})
  const filename = path.join(referenceDirectory, 'places.json'), references = read(filename)
  references.places[0].lon += 1
  fs.writeFileSync(filename, JSON.stringify(references))
  await assert.rejects(prepareMapData({...f.input, places: ['瑞金'], routes: []}, {...f.options, referenceDirectory}), /坐标不匹配来源原件/)
  assert.equal(f.calls.length, 0)
})

test('unknown place fails explicitly and negative cache prevents per-shot repeated requests', async t => {
  const f = fixture(t)
  let calls = 0
  const options = {...f.options, fetchImpl: async () => { calls++; return Response.json({search: []}) }}
  const input = {...f.input, places: ['不存在的古战场'], routes: []}
  await assert.rejects(prepareMapData(input, options), /无法核实地点.*不存在的古战场/)
  await assert.rejects(prepareMapData({...input, title: '下一镜'}, options), /无法核实地点/)
  assert.equal(calls, 1)
  assert.equal(fs.existsSync(path.join(f.options.cacheDirectory, 'rasters')), false)
})

test('same-name places with different latitudes are rejected without guessing', async t => {
  const f = fixture(t, [point('同名城', 114, 30), point('同名城', 114, 35)])
  await assert.rejects(prepareMapData({...f.input, places: ['同名城'], routes: []}, f.options), /多个本地匹配/)
  assert.equal(f.calls.length, 0)
})

test('ambiguous public coordinates are rejected before terrain preparation', async t => {
  const f = fixture(t)
  await assert.rejects(prepareMapData({...f.input, places: ['瑞金'], routes: []}, {...f.options,
    fetchImpl: async (url: string) => wikidataResponse(url, true)}), /多个.*同名地点/)
  assert.equal(f.calls.length, 0)
})

test('network timeout aborts in-flight requests, stops remaining tiles and returns a specific error', async t => {
  const f = fixture(t)
  let started = 0, aborted = 0
  const begin = Date.now()
  await assert.rejects(prepareMapData(f.input, {...f.options, requestTimeoutMs: 25, budgetMs: 80,
    fetchImpl: (_url: string, {signal}: {signal: AbortSignal}) => new Promise((_resolve, reject) => {
      started++
      signal.addEventListener('abort', () => { aborted++; reject(new DOMException('aborted', 'AbortError')) }, {once: true})
    }),
  }), /地图源请求失败.*超时/)
  assert.ok(Date.now() - begin < 1000)
  assert.ok(started > 0 && started <= 4)
  assert.equal(started, aborted)
})

test('timeout also cancels a response whose body never finishes', async t => {
  const f = fixture(t)
  let cancelled = 0
  await assert.rejects(prepareMapData(f.input, {...f.options, requestTimeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({cancel() { cancelled++ }})),
  }), /超时/)
  assert.ok(cancelled > 0)
})

test('invalid terrain responses do not produce a map or claim success', async t => {
  const f = fixture(t)
  let calls = 0
  const options = {...f.options, fetchImpl: async () => { calls++; return new Response('<html>error</html>') }}
  await assert.rejects(prepareMapData(f.input, options), /地形瓦片无效/)
  const firstAttempt = calls
  await assert.rejects(prepareMapData({...f.input, title: '下一镜'}, options), /地形瓦片无效/)
  assert.equal(calls, firstAttempt, 'failed tiles must not be downloaded again for every shot')
  assert.equal(fs.readdirSync(path.join(f.input.directory, 'maps')).length, 0)
})

test('overall network budget stops a slow public-place lookup chain', async t => {
  const f = fixture(t)
  let calls = 0
  const begin = Date.now()
  await assert.rejects(prepareMapData({...f.input, places: ['瑞金'], routes: []}, {...f.options,
    budgetMs: 35, requestTimeoutMs: 1000,
    fetchImpl: async (url: string) => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return wikidataResponse(url)
    },
  }), /超时|预算/)
  assert.ok(calls >= 1 && calls <= 2)
  assert.ok(Date.now() - begin < 500)
})

test('terrain with missing source metadata or unknown upstream license cannot claim verified provenance', async t => {
  const f = fixture(t)
  const tile = await f.tile()
  await assert.rejects(prepareMapData(f.input, {...f.options, fetchImpl: async () => new Response(new Uint8Array(tile))}), /未提供上游数据来源/)
  await assert.rejects(prepareMapData(f.input, {...f.options, cacheDirectory: path.join(f.directory, 'unknown-upstream'),
    fetchImpl: async () => new Response(new Uint8Array(tile), {headers: {'x-amz-meta-x-imagery-sources': 'unknown/provider.tif'}}),
  }), /未识别地形上游许可/)
})

test('corrupted derived terrain rebuilds from cached source tiles without networking', async t => {
  const f = fixture(t)
  const first = await prepareMapData(f.input, f.options)
  const rasters = path.join(f.options.cacheDirectory, 'rasters')
  fs.writeFileSync(path.join(rasters, fs.readdirSync(rasters)[0], 'terrain.png'), 'broken')
  const count = f.calls.length
  const second = await prepareMapData(f.input, {...f.options, network: false})
  assert.equal(hash(fs.readFileSync(first.backgroundPath)), hash(fs.readFileSync(second.backgroundPath)))
  assert.equal(f.calls.length, count)
})

test('real negative elevations are preserved instead of applying Changping-only inland repair', async t => {
  const f = fixture(t)
  const tile = await f.tile(-500)
  const result = await prepareMapData(f.input, {...f.options, fetchImpl: async () => new Response(new Uint8Array(tile), {
    headers: {'x-amz-meta-x-imagery-sources': 'etopo1/ETOPO1_Bed_g.tif'},
  })})
  const pixel = await sharp(result.backgroundPath).extract({left: 20, top: 20, width: 1, height: 1}).removeAlpha().raw().toBuffer()
  assert.ok(pixel[2] > pixel[0], 'bathymetric colour must not be replaced by a nonnegative inland median')
  assert.match(read(result.manifestPath).processing.negativeElevations, /Preserved/)
  assert.match(result.attribution, /NOAA/)
})

test('unsafe directories, coordinate objects, invalid duration and coincident routes fail clearly', async t => {
  const f = fixture(t)
  for (const patch of [{directory: '/'}, {directory: 'relative'}, {duration: NaN}, {places: [{name: '武汉', lon: 0, lat: 0}]}]) {
    await assert.rejects(prepareMapData({...f.input, ...patch}, f.options))
  }
  await assert.rejects(prepareMapData({...f.input, routes: [{from: '武汉', to: '武汉'}]}, f.options), /端点重合/)
  const unsafeOutput = path.join(f.directory, 'unsafe-output')
  fs.mkdirSync(unsafeOutput)
  const outside = path.join(f.directory, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(unsafeOutput, 'maps'))
  await assert.rejects(prepareMapData({...f.input, directory: unsafeOutput}, f.options), /目录越界/)
  assert.deepEqual(fs.readdirSync(outside), [])
  assert.equal(f.calls.length, 0)
})

test('unsupported dateline and polar maps fail explicitly instead of returning a Changping placeholder', async t => {
  const f = fixture(t, [point('西侧', 179, 10), point('东侧', -179, 10), point('极点', 0, 89)])
  await assert.rejects(prepareMapData({...f.input, places: ['西侧', '东侧'], routes: []}, f.options), /日期变更线/)
  await assert.rejects(prepareMapData({...f.input, places: ['极点'], routes: []}, f.options), /极区/)
  assert.equal(f.calls.length, 0)
})

test('public prepareMotionMap returns the existing renderer map contract for a non-Changping region', async t => {
  const f = fixture(t)
  const previous = process.env.HISTORY_MOTION_MAP_CACHE_DIR
  process.env.HISTORY_MOTION_MAP_CACHE_DIR = f.options.cacheDirectory
  t.after(() => { if (previous === undefined) delete process.env.HISTORY_MOTION_MAP_CACHE_DIR; else process.env.HISTORY_MOTION_MAP_CACHE_DIR = previous })
  t.mock.method(globalThis, 'fetch', f.options.fetchImpl)
  const forces: MotionMapForce[] = [{id:'advance',commander:'主将',faction:'进攻方',flagText:'军',color:'#365b7b',city:'赤壁',
    routeIndex:0,action:'occupy',start:1,end:4}]
  const result = await prepareMotionMap({...f.input, forces})
  assert.equal(result.enabled, true)
  assert.equal(result.provenance.verified, true)
  assert.equal(result.provenance.historyStatus, 'illustrative')
  assert.equal(result.width, 1920)
  assert.equal(result.height, 1080)
  assert.ok(path.isAbsolute(result.backgroundSrc) && fs.statSync(result.backgroundSrc).size > 0)
  assert.ok(result.provenance.manifestPath && fs.existsSync(result.provenance.manifestPath))
  assert.deepEqual(result.territories, [])
  assert.ok(result.camera?.keyframes.some(keyframe => keyframe.zoom > 1))
  assert.ok(result.stages?.length && result.legend?.length)
  assert.ok(read(result.provenance.manifestPath!).animation.camera)
  assert.deepEqual(result.forces, forces)
  assert.deepEqual([result.routes![0].start, result.routes![0].end], [1, 4])
  assert.equal(result.legend?.find(item => item.kind === 'line')?.color,forces[0].color)
  const evidence = read(result.provenance.manifestPath!)
  assert.deepEqual(evidence.animation.forces, forces)
  assert.equal(evidence.animationEvidence.forces.ownershipAction, 'occupy')
  assert.match(evidence.animationEvidence.forces.representation, /not troop counts/)
  assert.equal(evidence.animationEvidence.exactTroopPositions, false)
  assert.ok(fs.existsSync(evidence.geographicManifestPath))
  assert.equal(read(evidence.geographicManifestPath).animation, undefined, 'force animation evidence must not overwrite geographic data')
  const another = await prepareMotionMap({...f.input, forces:[{...forces[0],start:2,end:5}]})
  assert.notEqual(another.provenance.manifestPath,result.provenance.manifestPath)
  assert.equal(another.backgroundSrc,result.backgroundSrc,'animation variants must share terrain')
  assert.deepEqual(read(result.provenance.manifestPath!).animation.forces,forces,'a new animation must preserve prior evidence')
  validateMap(result, f.input.duration)
})

test('force preparation anchors to sourced city projection and keeps route/army movement synchronized', () => {
  const cities = [{name:'济南',x:.2,y:.3},{name:'德州',x:.7,y:.6}]
  const routes = [{points:[[.2,.3],[.7,.6]] as [number,number][],color:'#000000',start:0,end:1}]
  const force: MotionMapForce = {id:'ming',commander:'盛庸',faction:'朝廷军',flagText:'明',color:'#365b7b',city:'德州',
    routeIndex:0,action:'occupy',start:1,end:4}
  const input = {title:'收复德州',places:['济南','德州'],routes:[{from:'济南',to:'德州'}],duration:5,directory:'/tmp',forces:[force]}
  assert.deepEqual(prepareMapForces(input,cities,routes), [force])
  assert.deepEqual(routes[0], {points:[[.2,.3],[.7,.6]],color:'#365b7b',start:1,end:4})
  assert.equal('color' in cities[1],false,'preparation must not pre-apply a future capture to the city')
  assert.deepEqual(prepareMapForces({...input,forces:[{...force,routeIndex:undefined,action:'hold'}]},cities,routes), [{...force,routeIndex:undefined,action:'hold'}])
  assert.equal(prepareMapForces({...input,forces:undefined},cities,routes),undefined)
})

test('force preparation rejects unknown anchors, mismatched route endpoints and conflicting action times', () => {
  const cities = [{name:'济南',x:.2,y:.3},{name:'德州',x:.7,y:.6}]
  const routes = [{points:[[.2,.3],[.7,.6]] as [number,number][],color:'#365b7b'}]
  const force: MotionMapForce = {id:'ming',faction:'朝廷军',flagText:'明',color:'#365b7b',city:'德州',routeIndex:0,action:'occupy',start:1,end:4}
  const input = {title:'收复德州',places:['济南','德州'],routes:[{from:'济南',to:'德州'}],duration:5,directory:'/tmp',forces:[force]}
  for (const patch of [{city:'南京'}, {routeIndex:1}, {city:'济南'}, {end:6}, {start:4}, {routeIndex:undefined,action:'retreat'}] as Partial<MotionMapForce>[])
    assert.throws(() => prepareMapForces({...input,forces:[{...force,...patch}]},cities,routes))
  assert.throws(() => prepareMapForces({...input,forces:[force,{...force,id:'other',start:2}]},cities,routes), /时间必须一致/)
  assert.throws(() => prepareMapForces(input,[cities[0],{...cities[1],x:.8}],routes), /投影不一致/)
  assert.throws(() => prepareMapForces(input,[cities[0],{...cities[1],role:'context'}],routes), /已核实地点/)
})

test('1080p local maps upgrade a coarse cached crop within a bounded tile budget and report native sampling', async t => {
  const f = fixture(t, [point('瑞金', 116.02715, 25.8832), point('长汀县', 116.316662, 25.866986)])
  const input = {...f.input, places: ['瑞金'], routes: []}
  const preview = await prepareMapData(input, f.options)
  const oldCalls = f.calls.length
  const fallback = await prepareMapData(input, {...f.options, width: 1920, height: 1080, network: false})
  assert.equal(read(fallback.manifestPath).zoom, read(preview.manifestPath).zoom)
  assert.equal(f.calls.length, oldCalls, 'offline rendering must preserve coarse-cache fallback')
  const full = await prepareMapData(input, {...f.options, width: 1920, height: 1080})
  const lowManifest = read(preview.manifestPath), highManifest = read(full.manifestPath)
  assert.ok(highManifest.zoom > 9 && highManifest.zoom > lowManifest.zoom)
  assert.ok(f.calls.length - oldCalls <= 96)
  assert.ok(highManifest.processing.sampling.nativeWidth > 1000)
  assert.ok(highManifest.processing.sampling.horizontalUpscale < 2)
  assert.equal(highManifest.processing.sampling.selectedZoom, highManifest.zoom)
  const offline = await prepareMapData(input, {...f.options, width: 1920, height: 1080, network: false})
  assert.equal(read(offline.manifestPath).zoom, highManifest.zoom)
  assert.equal(hash(fs.readFileSync(full.backgroundPath)), hash(fs.readFileSync(offline.backgroundPath)))
})

test('a finer terrain download failure keeps usable cached geography and records its actual resolution', async t => {
  const f = fixture(t)
  const cached = await prepareMapData(f.input, f.options), cachedManifest = read(cached.manifestPath)
  let attempted = 0
  const recovered = await prepareMapData(f.input, {...f.options, width: 1920, height: 1080,
    fetchImpl: async () => {attempted++; throw Error('temporary terrain outage')},
  })
  const manifest = read(recovered.manifestPath)
  assert.ok(attempted > 0)
  assert.equal(manifest.zoom, cachedManifest.zoom)
  assert.equal(manifest.processing.sampling.selectedZoom, cachedManifest.zoom)
  assert.match(manifest.processing.fallback, /复用完整.*缓存/)
  assert.match(manifest.processing.fallback, /temporary terrain outage/)
  assert.deepEqual(recovered.bounds, cached.bounds)
  assert.deepEqual(recovered.cities, cached.cities)
})

test('nearby source-backed context cities use the same projection without adding geocoding or invented labels', async t => {
  const f = fixture(t, [point('瑞金', 116.02715, 25.8832), point('长汀县', 116.316662, 25.866986),
    point('长汀重复点', 116.31667, 25.867), point('遥远城市', 125, 35)])
  const result = await prepareMapData({...f.input, places: ['瑞金'], routes: []}, f.options)
  assert.deepEqual(result.cities.map((city: any) => [city.name, city.role]), [['瑞金', 'primary'], ['长汀县', 'context']])
  const manifest = read(result.manifestPath)
  const context = manifest.resolvedPlaces.find((place: any) => place.role === 'context')
  assert.equal(context.source.kind, 'natural-earth')
  assert.equal(context.locationStatus, 'modern-reference')
  assert.equal(result.cities[1].x, (context.lon - result.bounds.minLon) / (result.bounds.maxLon - result.bounds.minLon))
  assert.ok(f.calls.every(url => url.includes('elevation-tiles-prod')))
})

test('five-second encirclement establishes then builds a labelled illustrative perimeter without a rushed compression', () => {
  const input = {title: '瑞金外围部署', places: ['瑞金'], duration: 5, directory: '/tmp',
    presentation: {kind: 'encirclement' as const, target: '瑞金', label: '外围部署', compress: true}}
  const result = createMapPresentation(input, [{name: '瑞金', role: 'primary', x: .5, y: .5}], [])
  assert.ok(result.encirclement)
  assert.match(result.encirclement.label, /示意/)
  assert.equal(result.encirclement.color, '#365b7b')
  assert.equal(result.encirclement.fillColor, '#b85b4f')
  assert.deepEqual(result.legend?.find(item => item.kind === 'area'), {label: '活动空间（示意）', color: '#b85b4f', kind: 'area'})
  assert.deepEqual(result.encirclement.center, [.5, .5])
  assert.equal(result.encirclement.compressionStart, undefined)
  assert.ok(result.encirclement.start > 0 && result.encirclement.end < 4)
  assert.equal(result.stages?.at(-1)?.end, 5)
  for (const [index, stage] of result.stages!.entries()) {
    assert.ok(stage.end > stage.start)
    if (index) assert.equal(stage.start, result.stages![index - 1].end)
  }
})

test('longer explicit encirclement adds compression after construction and preserves a result hold', () => {
  const input = {title: '瑞金外围部署', places: ['瑞金'], duration: 10, directory: '/tmp',
    presentation: {kind: 'encirclement' as const, compress: true}}
  const result = createMapPresentation(input, [{name: '瑞金', role: 'primary', x: .5, y: .5}], [])
  assert.ok(result.encirclement!.compressionStart! > result.encirclement!.end)
  assert.ok(result.encirclement!.compressionEnd! < 9)
  assert.ok(result.encirclement!.innerScale! < 1)
  assert.ok(result.legend?.every(item => item.label === '瑞金' || /示意/.test(item.label)))
  const fixed = createMapPresentation({...input, presentation: {kind: 'encirclement'}}, [{name: '瑞金', x: .5, y: .5}], [])
  assert.equal(fixed.encirclement!.compressionStart, undefined)
})
