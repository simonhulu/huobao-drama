import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {copernicusRaster, shadeAtlasRaster} from './atlas-terrain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireBackend = createRequire(path.join(root, 'backend/package.json'));
const sharp = requireBackend('sharp');

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const MAX_TERRAIN_TILES = 96;
const MAX_GEOCODE_REQUESTS = 4;
const MAX_NETWORK_MS = 25_000;
const PROJECTION = 'Equirectangular; longitude and latitude linear in image pixels';
const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const WIKIDATA_URL = 'https://www.wikidata.org/w/api.php';
const TERRAIN_LICENSE_URL = 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md';
const VERSION = 4;
const PLACE_CACHE_VERSION = 2;

const sourceDataDirectory = path.join(root, 'data/static/changping-demo-v2-20261024/map-source-data');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const downloads = new Map();
const geocodes = new Map();
const rasters = new Map();
const datasets = new Map();

async function singleFlight(pending, key, operation) {
  if (pending.has(key)) return pending.get(key);
  const promise = operation();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}

function childDirectory(parent, ...segments) {
  fs.mkdirSync(parent, {recursive: true});
  const base = fs.realpathSync(parent);
  let directory = base;
  for (const segment of segments) {
    if (!segment || path.basename(segment) !== segment || segment === '..' || segment === '.') throw new Error('地图目录名无效');
    const next = path.join(directory, segment);
    if (!fs.existsSync(next)) fs.mkdirSync(next, {recursive: true});
    const actual = fs.realpathSync(next);
    if (!actual.startsWith(`${base}${path.sep}`)) throw new Error(`地图目录越界：${next}`);
    directory = actual;
  }
  return directory;
}

function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, bytes, {flag: 'wx'}); fs.renameSync(temporary, filename); }
  finally { fs.rmSync(temporary, {force: true}); }
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  atomicWrite(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizePlace(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/gu, '')
    .trim()
    .toLocaleLowerCase();
}

function displayPlace(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function canonicalAliases(value) {
  const normalized = normalizePlace(value);
  const aliases = new Set([normalized]);
  if (/市$|县$|區$|区$|镇$|鎮$/u.test(normalized)) aliases.add(normalized.slice(0, -1));
  return [...aliases].filter(Boolean);
}

function validPoint(point) {
  return Array.isArray(point) && point.length >= 2 && finite(point[0]) && finite(point[1])
    && point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90;
}

function context(options) {
  const cacheDirectory = path.resolve(options.cacheDirectory || process.env.HISTORY_MOTION_MAP_CACHE_DIR || path.join(root, 'data/storage/history-motion/map-cache'));
  if (cacheDirectory === path.parse(cacheDirectory).root) throw new Error('地图缓存目录不能是文件系统根目录');
  return {
    cacheDirectory: childDirectory(cacheDirectory),
    sourceDirectories: options.sourceDirectories ?? [sourceDataDirectory,
      path.join(root, 'data/storage/static/remotion/map-source-data'), path.join(root, 'data/static/remotion/map-source-data')],
    terrainDirectories: options.terrainDirectories ?? [path.join(sourceDataDirectory, 'terrarium'),
      path.join(root, 'data/storage/static/remotion/terrarium')],
    referenceDirectory: options.referenceDirectory === null ? null : options.referenceDirectory || path.join(root, 'scripts/history-motion/map-place-references'),
    width: options.width ?? DEFAULT_WIDTH, height: options.height ?? DEFAULT_HEIGHT,
    terrainProvider: options.terrainProvider ?? 'auto',
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    network: options.network ?? process.env.HISTORY_MOTION_MAP_DISABLE_NETWORK !== '1',
    deadline: Date.now() + clamp(options.budgetMs ?? MAX_NETWORK_MS, 1, 35_000),
    requestTimeoutMs: clamp(options.requestTimeoutMs ?? 4_000, 1, 8_000),
    geocodeRequests: 0,
  };
}

function naturalEarth(name, ctx) {
  for (const directory of ctx.sourceDirectories) {
    const filename = path.join(directory, `${name}.geojson`);
    try {
      const stat = fs.statSync(filename);
      const key = `${filename}:${stat.mtimeMs}:${stat.size}`;
      if (datasets.has(key)) return datasets.get(key);
      const bytes = fs.readFileSync(filename), metadata = readJson(`${filename}.source.json`);
      const hash = sha256(bytes);
      if (metadata.sha256 !== hash || !/^https:\/\//.test(metadata.url ?? '')) continue;
      const data = JSON.parse(bytes);
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) continue;
      const result = {features: data.features, source: {kind: 'natural-earth', title: `Natural Earth ${name}`,
        url: metadata.url, downloadedAt: metadata.downloadedAt, sha256: hash, localFile: filename,
        license: 'Public Domain', licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/', attribution: 'Made with Natural Earth'}};
      datasets.set(key, result);
      return result;
    } catch { /* Missing or corrupt shared data may be replaced by a sourced point lookup. */ }
  }
  return null;
}

function candidateAliases(properties) {
  return ['NAME_ZH', 'NAME_ZHT', 'NAME', 'NAME_EN', 'NAMEASCII', 'NAMEALT', 'LS_NAME', 'MEGANAME']
    .flatMap(key => properties?.[key] ? String(properties[key]).split(/[,;]/).map(value => ({key, value})) : []);
}

function localPlaceMatches(name, gazetteer) {
  const aliases = new Set(canonicalAliases(name));
  return (gazetteer?.features ?? []).flatMap(feature => {
    if (feature.geometry?.type !== 'Point' || !validPoint(feature.geometry.coordinates)) return [];
    const properties = feature.properties ?? {};
    const match = candidateAliases(properties).find(alias => canonicalAliases(alias.value).some(value => aliases.has(value)));
    if (!match) return [];
    let score = match.key === 'NAME_ZH' || match.key === 'NAME_ZHT' ? 100 : match.key === 'NAME' || match.key === 'NAME_EN' ? 80 : 40;
    if (properties.NAME === name || properties.NAME_ZH === name || properties.NAME_ZHT === name) score += 5;
    const [lon, lat] = feature.geometry.coordinates.map(Number);
    return [{feature, properties, match, score, lon, lat}];
  }).sort((a, b) => b.score - a.score || (Number(a.properties.SCALERANK ?? 99) - Number(b.properties.SCALERANK ?? 99)));
}

function tileFilename(z, x, y) {
  return `${z}-${x}-${y}.png`;
}

function cachedTile(z, x, y, ctx) {
  const filename = tileFilename(z, x, y);
  for (const directory of [path.join(ctx.cacheDirectory, 'terrarium'), ...ctx.terrainDirectories]) {
    const file = path.join(directory, filename);
    if (!fs.existsSync(file)) continue;
    try {
      const stats = fs.statSync(file);
      if (!stats.isFile() || stats.size === 0) continue;
      const metadataFile = `${file}.source.json`;
      if (!fs.existsSync(metadataFile)) continue;
      const metadata = readJson(metadataFile), buffer = fs.readFileSync(file);
      if (metadata.sha256 !== sha256(buffer) || !metadata.imagerySources) continue;
      return {file, metadata, buffer};
    } catch { continue; }
  }
  return null;
}

async function fetchBytes(url, ctx) {
  if (!ctx.network) throw new Error(`地图网络已禁用，缺少本地缓存：${url}`);
  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) throw new Error(`地图网络预算已耗尽：${url}`);
  const controller = new AbortController();
  let timer, activeReader;
  const abortReader = () => { activeReader?.cancel().catch(() => {}); };
  controller.signal.addEventListener('abort', abortReader, {once: true});
  try {
    return await Promise.race([
      (async () => {
        const response = await ctx.fetchImpl(url, {signal: controller.signal, headers: {
          'User-Agent': 'HuobaoHistoryMotion/1.0 (historical video maps; persistent cache)',
          Accept: 'image/png,application/json;q=0.9',
        }});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader(), chunks = []; let size = 0;
        activeReader = reader;
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 8_000_000) { await reader.cancel(); throw new Error('响应超过 8 MB'); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        return {bytes: Buffer.concat(chunks), headers: response.headers};
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('超时')); }, Math.min(ctx.requestTimeoutMs, remaining)); }),
    ]);
  } catch (error) {
    const reason = error?.name === 'AbortError' ? '超时' : error?.message || String(error);
    throw new Error(`地图源请求失败：${url}（${reason}）`);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abortReader);
  }
}

async function readTerrainTile(z, x, y, ctx) {
  const world = 2 ** z;
  const wrappedX = ((x % world) + world) % world;
  const local = cachedTile(z, wrappedX, y, ctx);
  if (local) {
    await assertTerrainTile(local.buffer, local.file);
    return {buffer: local.buffer, source: {...local.metadata, localFile: local.file}, z, x, y};
  }
  const url = `${TERRAIN_URL}/${z}/${wrappedX}/${y}.png`;
  const file = path.join(childDirectory(ctx.cacheDirectory, 'terrarium'), tileFilename(z, wrappedX, y));
  return singleFlight(downloads, file, async () => {
    const failureFile = path.join(childDirectory(ctx.cacheDirectory, 'failures'), `${sha256(url)}.json`);
    try { const failed = readJson(failureFile); if (failed.until > Date.now()) throw new Error(failed.error); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    let result;
    try {
      result = await fetchBytes(url, ctx);
      await assertTerrainTile(result.bytes, url);
      if (!result.headers.get('x-amz-meta-x-imagery-sources')) throw new Error(`地形瓦片未提供上游数据来源：${url}`);
    } catch (error) {
      if (ctx.network) writeJson(failureFile, {until: Date.now() + 60_000, error: error.message});
      throw error;
    }
    const metadataFile = `${file}.source.json`;
    atomicWrite(file, result.bytes);
    const metadata = {
      url, downloadedAt: new Date().toISOString(), sha256: sha256(result.bytes), bytes: result.bytes.length,
      imagerySources: result.headers.get('x-amz-meta-x-imagery-sources'),
    };
    writeJson(metadataFile, metadata);
    return {buffer: result.bytes, source: {...metadata, localFile: file}, z, x, y};
  });
}

async function assertTerrainTile(buffer, label) {
  try {
    const metadata = await sharp(buffer).metadata();
    if (metadata.width !== 256 || metadata.height !== 256 || !['png'].includes(metadata.format)) {
      throw new Error(`需要 256×256 PNG，实际为 ${metadata.width}×${metadata.height} ${metadata.format || 'unknown'}`);
    }
  } catch (error) {
    throw new Error(`地形瓦片无效：${label}（${error?.message || String(error)}）`);
  }
}

function tileX(lon, zoom) {
  return (lon + 180) / 360 * 2 ** zoom;
}

function tileY(lat, zoom) {
  const safeLat = clamp(lat, -85.05112878, 85.05112878);
  return (1 - Math.asinh(Math.tan(safeLat * Math.PI / 180)) / Math.PI) / 2 * 2 ** zoom;
}

function tileGrid(bounds, zoom) {
  const world = 2 ** zoom;
  const minX = Math.floor(tileX(bounds.minLon, zoom));
  const maxX = Math.min(world - 1, Math.ceil(tileX(bounds.maxLon, zoom)) - 1);
  const minY = Math.max(0, Math.floor(tileY(bounds.maxLat, zoom)));
  const maxY = Math.min(world - 1, Math.ceil(tileY(bounds.minLat, zoom)) - 1);
  const tiles = [];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) tiles.push({x, y});
  return {minX, maxX, minY, maxY, tiles};
}

function selectZoom(bounds, ctx) {
  // Rendering a 1080p image from a z9 city crop magnifies only a few hundred
  // elevation samples. Select against the actual output footprint, then apply
  // a bounded download budget. Small previews do not need full-HD source tiles.
  const samplesX = (bounds.maxLon - bounds.minLon) / 360 * 256;
  const samplesY = (tileY(bounds.minLat, 0) - tileY(bounds.maxLat, 0)) * 256;
  const targetZoom = clamp(Math.ceil(Math.log2(Math.max(ctx.width / samplesX, ctx.height / samplesY))), 0, 14);
  const tileBudget = ctx.width * ctx.height >= 1920 * 1080 ? MAX_TERRAIN_TILES : 16;
  let downloadable;
  for (let zoom = targetZoom; zoom >= 0; zoom--) {
    const grid = tileGrid(bounds, zoom);
    if (grid.tiles.length <= tileBudget) { downloadable = {zoom, grid, targetZoom}; break; }
  }
  for (let zoom = targetZoom; zoom >= 0; zoom--) {
    const grid = tileGrid(bounds, zoom);
    if (ctx.network && downloadable && zoom < downloadable.zoom) break;
    if (grid.tiles.length <= 144 && grid.tiles.every(tile => cachedTile(zoom, tile.x, tile.y, ctx))) return {zoom, grid, targetZoom};
  }
  if (downloadable) return downloadable;
  throw new Error(`地图范围过大：低分辨率地形仍需要超过 ${MAX_TERRAIN_TILES} 个瓦片`);
}

async function decodeTile(buffer) {
  const {data, info} = await sharp(buffer).removeAlpha().raw().toBuffer({resolveWithObject: true});
  if (info.width !== 256 || info.height !== 256 || info.channels !== 3) throw new Error('Terrarium 瓦片必须解码为 3 通道 256×256');
  const elevations = new Float32Array(256 * 256);
  for (let i = 0; i < elevations.length; i++) {
    const offset = i * 3;
    elevations[i] = data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32768;
  }
  return elevations;
}

function sampleRaster(elevations, sourceWidth, sourceHeight, x, y) {
  x = clamp(x, 0, sourceWidth - 1.00001);
  y = clamp(y, 0, sourceHeight - 1.00001);
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = (xx, yy) => elevations[yy * sourceWidth + xx];
  const a = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx;
  const b = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
  return a * (1 - fy) + b * fy;
}

async function renderTerrain(bounds, zoom, grid, tileResults, width, height) {
  const sourceWidth = (grid.maxX - grid.minX + 1) * 256;
  const sourceHeight = (grid.maxY - grid.minY + 1) * 256;
  const elevations = new Float32Array(sourceWidth * sourceHeight);
  for (const tile of tileResults) {
    const decoded = await decodeTile(tile.buffer);
    const offsetX = tile.x - grid.minX;
    const offsetY = tile.y - grid.minY;
    for (let py = 0; py < 256; py++) {
      const target = (offsetY * 256 + py) * sourceWidth + offsetX * 256;
      elevations.set(decoded.subarray(py * 256, (py + 1) * 256), target);
    }
  }
  const raster = new Float32Array(width * height);
  const sampleX = Array.from({length: width}, (_, x) => (tileX(bounds.minLon + (x + .5) / width * (bounds.maxLon - bounds.minLon), zoom) - grid.minX) * 256 - .5);
  const sampleY = Array.from({length: height}, (_, y) => {
    const lat = bounds.maxLat - (y + .5) / height * (bounds.maxLat - bounds.minLat);
    return (tileY(lat, zoom) - grid.minY) * 256 - .5;
  });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raster[y * width + x] = sampleRaster(elevations, sourceWidth, sourceHeight, sampleX[x], sampleY[y]);

  return shadeAtlasRaster(raster, bounds, width, height);
}

function clipSegment(a, b, bounds) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - bounds.minLon, bounds.maxLon - a[0], a[1] - bounds.minLat, bounds.maxLat - a[1]];
  let low = 0, high = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const ratio = q[i] / p[i];
    if (p[i] < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
    if (low > high) return null;
  }
  return [[a[0] + low * dx, a[1] + low * dy], [a[0] + high * dx, a[1] + high * dy]];
}

function clippedLines(coordinates, bounds) {
  const lines = [];
  let current = null;
  for (let index = 1; index < coordinates.length; index++) {
    const segment = clipSegment(coordinates[index - 1], coordinates[index], bounds);
    if (!segment) { current = null; continue; }
    if (!current || Math.hypot(current.at(-1)[0] - segment[0][0], current.at(-1)[1] - segment[0][1]) > 1e-7) {
      current = [segment[0], segment[1]]; lines.push(current);
    } else current.push(segment[1]);
  }
  return lines;
}

function projectPoint([lon, lat], bounds) {
  return [(lon - bounds.minLon) / (bounds.maxLon - bounds.minLon), (bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)];
}

function preparedWaterways(bounds, data) {
  const result = [];
  for (const feature of data?.features ?? []) {
    const geometry = feature?.geometry, properties = feature.properties || {};
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    for (const line of lines) for (const clipped of clippedLines(line, bounds)) result.push({
      id: `ne-river-${result.length}`, name: properties.name_zh || properties.NAME_ZH || properties.name || properties.NAME,
      points: clipped.map(point => projectPoint(point, bounds)), rank: Number(properties.scalerank ?? 5) < 3 ? 1 : Number(properties.scalerank ?? 5) < 6 ? 2 : 3,
    });
  }
  return result;
}

async function remoteGeocode(name, ctx) {
  const directory = childDirectory(ctx.cacheDirectory, 'places');
  const key = sha256(normalizePlace(name));
  const filename = path.join(directory, `${key}.json`);
  return singleFlight(geocodes, filename, async () => {
    try {
      const cached = readJson(filename);
      if (cached.version === PLACE_CACHE_VERSION && cached.error && cached.until > Date.now()) throw new Error(cached.error);
      if (cached.version === PLACE_CACHE_VERSION && validPoint([cached.lon, cached.lat]) && cached.source?.kind === 'wikidata'
        && cached.source.raw.every(item => sha256(fs.readFileSync(item.localFile)) === item.sha256)) return cached;
    } catch (error) {
      if (error.message.startsWith('无法核实地点')) throw error;
    }
    if (ctx.geocodeRequests++ >= MAX_GEOCODE_REQUESTS) throw new Error(`无法核实地点“${name}”：本次公共地点查询上限为 ${MAX_GEOCODE_REQUESTS} 个`);
    const raw = [];
    const request = async parameters => {
      const url = new URL(WIKIDATA_URL);
      for (const [key, value] of Object.entries({...parameters, format: 'json'})) url.searchParams.set(key, value);
      const response = await fetchBytes(url.href, ctx);
      const hash = sha256(response.bytes), localFile = path.join(directory, `${hash}.raw.json`);
      const data = JSON.parse(response.bytes);
      if (data.error) throw new Error(`Wikidata: ${data.error.info ?? data.error.code}`);
      atomicWrite(localFile, response.bytes);
      raw.push({url: url.href, sha256: hash, localFile, downloadedAt: new Date().toISOString()});
      return data;
    };
    try {
      const search = await request({action: 'wbsearchentities', search: name, language: 'zh', uselang: 'zh', type: 'item', limit: '3'});
      const aliases = canonicalAliases(name);
      const candidates = (search.search ?? []).filter(record => /^Q\d+$/.test(record.id)
        && [record.label, record.match?.text].some(text => text && canonicalAliases(text).some(alias => aliases.includes(alias))));
      if (!candidates.length) throw new Error('公共地名库没有名称匹配，不能猜坐标');
      const data = await request({action: 'wbgetentities', ids: candidates.map(record => record.id).join('|'), props: 'claims|labels|descriptions', languages: 'zh|en'});
      const locations = candidates.flatMap(record => {
        const entity = data.entities?.[record.id];
        const coordinates = (entity?.claims?.P625 ?? []).filter(claim => claim.rank !== 'deprecated'
          && claim.mainsnak?.snaktype === 'value' && /\/Q2$/.test(claim.mainsnak.datavalue?.value?.globe ?? ''));
        const preferred = coordinates.filter(claim => claim.rank === 'preferred');
        const unique = new Map((preferred.length ? preferred : coordinates).map(claim => {
          const value = claim.mainsnak.datavalue.value;
          return [`${value.longitude},${value.latitude}`, value];
        }));
        if (unique.size !== 1) return [];
        const coordinate = [...unique.values()][0];
        if (!validPoint([coordinate.longitude, coordinate.latitude])) return [];
        return [{id: record.id, label: record.label, lon: coordinate.longitude, lat: coordinate.latitude}];
      });
      if (locations.length !== 1) throw new Error(locations.length ? '存在多个带坐标的同名地点，请使用更明确的地点名' : '没有唯一的地球坐标');
      const location = locations[0];
      const result = {version: PLACE_CACHE_VERSION, lon: location.lon, lat: location.lat, source: {
        kind: 'wikidata', title: `Wikidata ${location.id}: ${location.label}`, url: `https://www.wikidata.org/wiki/${location.id}`,
        license: 'CC0', licenseUrl: 'https://www.wikidata.org/wiki/Wikidata:Licensing', attribution: 'Wikidata (CC0)',
        coordinateProperty: 'P625', query: name, raw,
      }};
      writeJson(filename, result);
      return result;
    } catch (error) {
      const message = `无法核实地点“${name}”：${error.message}`;
      writeJson(filename, {version: PLACE_CACHE_VERSION, error: message, until: Date.now() + 60_000});
      throw new Error(message);
    }
  });
}

// These aliases locate modern reference cities, never a surveyed ancient settlement or boundary.
const modernReferences = new Map([
  ['长安', '西安'], ['建康', '南京'], ['金陵', '南京'], ['汴京', '开封'],
  ['北平', '北京'], ['大都', '北京'], ['奉天', '沈阳'],
]);

async function resolvePlace(name, gazetteer, ctx) {
  const modernName = modernReferences.get(name) ?? name;
  const matches = localPlaceMatches(modernName, gazetteer);
  if (matches.length) {
    const best = matches[0];
    const tied = matches.filter(match => match.score === best.score && Math.hypot(match.lon - best.lon, match.lat - best.lat) > 0.01);
    if (tied.length) {
      const choices = [best, ...tied].slice(0, 4).map(match => `${match.properties.NAME_ZH || match.properties.NAME} (${[match.properties.ADM1NAME, match.properties.ADM0NAME].filter(Boolean).join(', ')})`).join('、');
      throw new Error(`地点“${name}”存在多个本地匹配（${choices}），拒绝猜坐标`);
    }
    return {name, lon: best.lon, lat: best.lat, source: gazetteer.source,
      modernReference: modernName, locationStatus: 'modern-reference',
      aliasSource: modernName !== name ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(name)}` : undefined,
      evidence: {name: best.properties.NAME, nameZh: best.properties.NAME_ZH, country: best.properties.ADM0NAME,
        region: best.properties.ADM1NAME, neId: best.properties.NE_ID ?? best.properties.ne_id}};
  }
  const reference = sourcedReference(modernName, ctx);
  if (reference) return {name, lon: reference.lon, lat: reference.lat, source: reference.source,
    modernReference: modernName, locationStatus: 'modern-reference', evidence: {scope: reference.scope}};
  const remote = await remoteGeocode(modernName, ctx);
  return {name, lon: remote.lon, lat: remote.lat, source: remote.source, modernReference: modernName,
    locationStatus: 'modern-reference', aliasSource: modernName !== name ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(name)}` : undefined};
}

// A small, source-backed fallback for places missing from Natural Earth.
// Keep source documents beside the coordinates so offline rendering does not
// turn a hand-entered number into untraceable geographic evidence.
function sourcedReference(name, ctx) {
  if (!ctx.referenceDirectory) return null;
  let references;
  try { references = readJson(path.join(ctx.referenceDirectory, 'places.json')).places; }
  catch { return null; }
  const aliases = canonicalAliases(name);
  const matches = (references || []).filter(reference => reference.aliases?.some(alias => canonicalAliases(alias).some(value => aliases.includes(value))));
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error(`地点“${name}”存在多个本地来源记录，拒绝猜坐标`);
  const reference = matches[0];
  if (!validPoint([reference.lon, reference.lat]) || reference.source?.kind !== 'geonames' || !reference.source.raw?.length) throw new Error(`地点“${name}”的本地来源记录无效`);
  const raw = reference.source.raw.map(item => {
    if (path.basename(item.file) !== item.file || !/^https:\/\//.test(item.url)) throw new Error('本地点来源路径无效');
    const localFile = path.join(ctx.referenceDirectory, item.file), bytes = fs.readFileSync(localFile);
    if (sha256(bytes) !== item.sha256) throw new Error(`地点“${name}”的来源原件指纹已变化`);
    return {...item, localFile};
  });
  const html = fs.readFileSync(raw[0].localFile, 'utf8');
  const coordinates = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => JSON.parse(match[1])).filter(value => value['@type'] === 'Place' && value.geo?.['@type'] === 'GeoCoordinates');
  if (!coordinates.some(value => Number(value.geo.longitude) === reference.lon && Number(value.geo.latitude) === reference.lat)) throw new Error(`地点“${name}”的坐标不匹配来源原件`);
  return {...reference, source: {...reference.source, raw}};
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('地图输入必须是对象');
  if (typeof input.title !== 'string') throw new Error('地图标题必须是文字');
  const title = displayPlace(input.title);
  if (!title || title.length > 200) throw new Error('地图标题不能为空且不能超过 200 个字符');
  if (!Array.isArray(input.places) || input.places.length < 1 || input.places.length > 40) throw new Error('地图至少需要 1 个、最多 40 个地点');
  if (!finite(input.duration) || input.duration <= 0 || input.duration > 3600) throw new Error('地图时长必须在 0 到 3600 秒之间');
  if (!input.directory || typeof input.directory !== 'string' || !path.isAbsolute(input.directory)) throw new Error('地图输出目录必须是绝对路径');
  const routes = input.routes ?? [];
  if (!Array.isArray(routes) || routes.length > 40) throw new Error('地图路线最多 40 条');
  const placeNames = [...input.places, ...routes.flatMap(route => [route?.from, route?.to])];
  if (placeNames.some(name => typeof name !== 'string' || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name))) throw new Error('地图地点必须是 1 到 100 个字符的名称，不能提供坐标对象');
  if (routes.some(route => !route || !displayPlace(route.from) || !displayPlace(route.to) || (route.label !== undefined && (typeof route.label !== 'string' || displayPlace(route.label).length > 100)))) {
    throw new Error('地图路线必须有 from、to，label 不能超过 100 个字符');
  }
  const presentation = input.presentation;
  if (presentation !== undefined && (!presentation || typeof presentation !== 'object'
    || !['locate', 'route', 'encirclement'].includes(presentation.kind)
    || (presentation.target !== undefined && (typeof presentation.target !== 'string' || !placeNames.some(name => canonicalAliases(name).some(alias => canonicalAliases(presentation.target).includes(alias)))))
    || (presentation.label !== undefined && (typeof presentation.label !== 'string' || !presentation.label.trim() || presentation.label.length > 100))
    || (presentation.compress !== undefined && typeof presentation.compress !== 'boolean'))) throw new Error('地图演示必须指定有效类型，目标必须是已提供的地点');
  const directory = path.resolve(input.directory);
  if (directory === path.parse(directory).root) throw new Error('地图输出目录不能是文件系统根目录');
  return {title, duration: input.duration, directory, places: input.places.map(displayPlace), routes: routes.map(route => ({from: displayPlace(route.from), to: displayPlace(route.to), label: route.label === undefined ? undefined : displayPlace(route.label)})),
    presentation: presentation ? {kind: presentation.kind, target: presentation.target, label: presentation.label, compress: presentation.compress} : undefined};
}

async function mapConcurrent(values, concurrency, worker) {
  const output = new Array(values.length);
  let cursor = 0, failure;
  await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, async () => {
    while (!failure && cursor < values.length) {
      const index = cursor++;
      try { output[index] = await worker(values[index], index); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return output;
}

function safeOutputDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true});
  const realParent = fs.realpathSync(directory);
  if (realParent === path.parse(realParent).root) throw new Error('地图输出目录解析后不能是文件系统根目录');
  return realParent;
}

function fittedBounds(resolved, width, height) {
  const longitudes = resolved.map(place => place.lon), latitudes = resolved.map(place => place.lat);
  const longitudeSpan = Math.max(...longitudes) - Math.min(...longitudes);
  if (longitudeSpan > 180) throw new Error('地图地点跨越日期变更线，当前等经纬度投影无法安全连接');
  if (latitudes.some(latitude => Math.abs(latitude) > 80)) throw new Error('当前地形生成器不支持纬度超过 80 度的极区');
  const centerLon = (Math.max(...longitudes) + Math.min(...longitudes)) / 2;
  const centerLat = (Math.max(...latitudes) + Math.min(...latitudes)) / 2;
  const cosine = Math.cos(centerLat * Math.PI / 180);
  let spanLon = Math.max(.8, longitudeSpan * 1.45);
  let spanLat = Math.max(.5, (Math.max(...latitudes) - Math.min(...latitudes)) * 1.55);
  spanLon = Math.max(spanLon, spanLat * width / height / cosine);
  spanLat = Math.max(spanLat, spanLon * cosine * height / width);
  return {minLon: Math.max(-180, centerLon - spanLon / 2), maxLon: Math.min(180, centerLon + spanLon / 2),
    minLat: Math.max(-85, centerLat - spanLat / 2), maxLat: Math.min(85, centerLat + spanLat / 2)};
}

function contextualPlaces(gazetteer, resolved, bounds) {
  if (!gazetteer) return [];
  const selected = resolved.map(place => projectPoint([place.lon, place.lat], bounds));
  const aliases = new Set(resolved.flatMap(place => [...canonicalAliases(place.name), ...canonicalAliases(place.modernReference)]));
  const candidates = gazetteer.features.flatMap(feature => {
    if (feature.geometry?.type !== 'Point' || !validPoint(feature.geometry.coordinates)) return [];
    const properties = feature.properties ?? {};
    const name = properties.NAME_ZH || properties.NAME || properties.NAME_EN;
    if (!name || candidateAliases(properties).some(alias => canonicalAliases(alias.value).some(value => aliases.has(value)))) return [];
    const [lon, lat] = feature.geometry.coordinates;
    if (resolved.some(place => Math.hypot(place.lon - lon, place.lat - lat) < .02)) return [];
    const [x, y] = projectPoint([lon, lat], bounds);
    // Reserve room for title, phases and captions; avoid labels along crop edges.
    if (x < .09 || x > .88 || y < .2 || y > .79) return [];
    return [{name, lon, lat, x, y, properties, rank: Number(properties.SCALERANK ?? 9)}];
  }).sort((a, b) => a.rank - b.rank || Math.hypot(a.x - .5, a.y - .5) - Math.hypot(b.x - .5, b.y - .5));
  const context = [];
  for (const candidate of candidates) {
    if (selected.some(([x, y]) => Math.abs(x - candidate.x) < .16 && Math.abs(y - candidate.y) < .09)) continue;
    selected.push([candidate.x, candidate.y]);
    context.push({name: candidate.name, lon: candidate.lon, lat: candidate.lat, source: gazetteer.source,
      modernReference: candidate.name, locationStatus: 'modern-reference', role: 'context',
      evidence: {name: candidate.properties.NAME, nameZh: candidate.properties.NAME_ZH,
        country: candidate.properties.ADM0NAME, region: candidate.properties.ADM1NAME,
        neId: candidate.properties.NE_ID ?? candidate.properties.ne_id}});
    if (context.length === 4) break;
  }
  return context;
}

function terrainCredits(tiles) {
  const imagerySources = [...new Set(tiles.flatMap(tile => tile.source.imagerySources.split(/,\s*/)))].sort();
  const upstream = new Set(imagerySources.map(source => source.split('/')[0].toLowerCase()));
  const known = [
    {keys: ['srtm', 'gmted', 'ned', '3dep', 'gtopo30'], license: 'Public Domain', attribution: 'SRTM / GMTED2010 / 3DEP: USGS'},
    {keys: ['etopo1'], license: 'Public Domain', attribution: 'ETOPO1: DOC/NOAA/NESDIS/NCEI, U.S. Department of Commerce'},
    {keys: ['australia', 'au'], license: 'CC BY 4.0', attribution: 'Copyright Commonwealth of Australia (Geoscience Australia) 2017'},
    {keys: ['austria'], license: 'CC BY 3.0 AT', attribution: 'Copyright offene Daten Oesterreichs - Digitales Gelaendemodell (DGM) Oesterreich'},
    {keys: ['canada', 'cdem'], license: 'Open Government Licence - Canada', attribution: 'Contains information licensed under the Open Government Licence - Canada'},
    {keys: ['eudem', 'eu-dem'], license: 'Copernicus EU-DEM terms', attribution: 'Produced using Copernicus data and information funded by the European Union - EU-DEM layers'},
    {keys: ['mexico', 'inegi'], license: 'INEGI free use of information', attribution: 'Source: INEGI, Continental relief, 2016'},
    {keys: ['nz', 'newzealand', 'linz'], license: 'CC BY 3.0 NZ', attribution: 'Copyright 2011 Crown copyright, Land Information New Zealand and the New Zealand Government (All rights reserved)'},
    {keys: ['norway', 'kartverket'], license: 'CC BY 4.0', attribution: 'Copyright Kartverket'},
    {keys: ['uk', 'greatbritain'], license: 'Open Government Licence v3', attribution: 'Copyright Environment Agency copyright and/or database right 2015. All rights reserved'},
    {keys: ['arcticdem'], license: 'ArcticDEM unrestricted use', attribution: 'ArcticDEM created from DigitalGlobe imagery; NSF awards 1043681, 1559691 and 1542736'},
  ];
  const credits = known.filter(record => record.keys.some(key => upstream.has(key)));
  const unknown = [...upstream].filter(key => !known.some(record => record.keys.includes(key)));
  if (unknown.length) throw new Error(`尚未识别地形上游许可与署名：${unknown.join(', ')}；请补充对应来源，未生成冒称公共领域的底图`);
  return {kind: 'terrain', title: 'Mapzen / Tilezen Terrain Tiles', url: 'https://registry.opendata.aws/terrain-tiles/',
    license: [...new Set(credits.map(record => record.license))].join('; '), licenseUrl: TERRAIN_LICENSE_URL,
    attribution: ['Terrain: Mapzen / Tilezen', ...credits.map(record => record.attribution)].join('; '),
    imagerySources, upstream: credits, tiles: tiles.map(tile => ({z: tile.z, x: tile.x, y: tile.y, ...tile.source}))};
}

async function prepareTerrain(bounds, ctx) {
  const {width, height} = ctx;
  let copernicus, fallback;
  if (ctx.terrainProvider !== 'mapzen' && (width >= 1280 || ctx.terrainProvider === 'copernicus')) try {
    copernicus = await copernicusRaster(bounds, width, height, {...ctx, deadline: Math.min(ctx.deadline, Date.now() + 12_000)});
  } catch (error) {
    if (ctx.terrainProvider === 'copernicus') throw error;
    fallback = String(error.message);
  }
  let {zoom, grid, targetZoom} = copernicus ? {zoom: null, grid: null, targetZoom: null} : selectZoom(bounds, ctx);
  let tiles = [];
  if (!copernicus) try {
    tiles = await mapConcurrent(grid.tiles, 4, tile => readTerrainTile(zoom, tile.x, tile.y, ctx));
  } catch (error) {
    const cached = selectZoom(bounds, {...ctx, network: false});
    if (!cached.grid.tiles.every(tile => cachedTile(cached.zoom, tile.x, tile.y, ctx))) throw error;
    fallback = [fallback, `较细地形下载失败，复用完整 z${cached.zoom} 缓存：${error.message}`].filter(Boolean).join('；');
    zoom = cached.zoom; grid = cached.grid;
    tiles = await mapConcurrent(grid.tiles, 4, tile => readTerrainTile(zoom, tile.x, tile.y, {...ctx, network: false}));
  }
  const key = sha256(JSON.stringify({version: VERSION, bounds, width, height,
    provider: copernicus ? 'copernicus-glo30' : 'mapzen', zoom: copernicus ? null : zoom,
    sources: copernicus?.source.tiles.map(tile => tile.sha256)}));
  const directory = childDirectory(ctx.cacheDirectory, 'rasters', key);
  const backgroundPath = path.join(directory, 'terrain.png');
  const manifestPath = path.join(directory, 'geographic-data.json');
  return singleFlight(rasters, directory, async () => {
    try {
      const manifest = readJson(manifestPath), bytes = fs.readFileSync(backgroundPath);
      if (manifest.backgroundSha256 === sha256(bytes)) {
        const metadata = await sharp(bytes).metadata();
        if (metadata.width === width && metadata.height === height && metadata.format === 'png') return {...manifest, backgroundPath,
          ...(fallback ? {processing: {...manifest.processing, fallback}} : {})};
      }
    } catch { /* Rebuild only this derived raster; original source caches are never changed. */ }
    const source = copernicus?.source ?? terrainCredits(tiles);
    const terrain = copernicus ? await shadeAtlasRaster(copernicus.raster, bounds, width, height) : await renderTerrain(bounds, zoom, grid, tiles, width, height);
    atomicWrite(backgroundPath, terrain);
    const manifest = {version: VERSION, bounds, width, height, crs: 'EPSG:4326', projection: PROJECTION, zoom: copernicus ? null : zoom,
      backgroundSha256: sha256(terrain), sources: [source], cartography: {version: 1, style: 'relief-atlas'},
      processing: {decode: copernicus ? 'Float32 Copernicus COG; scale-selected overview via bounded HTTP Range' : 'Terrarium: R*256 + G + B/256 - 32768 metres',
        resampling: copernicus ? 'Bilinear georeferenced COG overview to linear longitude/latitude pixel centres' : 'Bilinear Web Mercator DEM to linear longitude/latitude pixel centres',
        shading: 'Measured fine and broad elevation relief; multidirectional light; 2.5x fine and 4x broad vertical exaggeration; muted hypsometric tint',
        rivers: 'Separate vector layer; never burned into terrain pixels',
        ...(fallback ? {fallback} : {}),
        negativeElevations: 'Preserved; no Changping-specific inland negative-elevation repair',
        resolution: 'Output pixel dimensions and tile zoom are not source DEM accuracy',
        sampling: copernicus?.sampling ?? {provider: 'mapzen', targetZoom, selectedZoom: zoom, tileCount: grid.tiles.length,
          nativeWidth: (tileX(bounds.maxLon, zoom) - tileX(bounds.minLon, zoom)) * 256,
          nativeHeight: (tileY(bounds.minLat, zoom) - tileY(bounds.maxLat, zoom)) * 256,
          horizontalUpscale: width / ((tileX(bounds.maxLon, zoom) - tileX(bounds.minLon, zoom)) * 256),
          verticalUpscale: height / ((tileY(bounds.minLat, zoom) - tileY(bounds.maxLat, zoom)) * 256)}}};
    writeJson(manifestPath, manifest);
    return {...manifest, backgroundPath};
  });
}

/** Regenerate an existing map's terrain without changing any proven geographic anchors. */
export async function prepareAtlasTerrain(input, options = {}) {
  const {bounds, directory} = input;
  if (!bounds || ![bounds.minLon,bounds.maxLon,bounds.minLat,bounds.maxLat].every(finite)
    || bounds.minLon < -180 || bounds.maxLon > 180 || bounds.minLat < -85 || bounds.maxLat > 85
    || bounds.maxLon <= bounds.minLon || bounds.maxLat <= bounds.minLat) throw Error('地图地形范围无效');
  const ctx = context({...options, width: input.width ?? options.width, height: input.height ?? options.height});
  if (![ctx.width,ctx.height].every(Number.isInteger) || ctx.width < 320 || ctx.height < 180 || ctx.width > 3840 || ctx.height > 2160) throw Error('地图输出尺寸无效');
  if (!['auto','mapzen','copernicus'].includes(ctx.terrainProvider)) throw Error('地图地形来源无效');
  const terrain = await prepareTerrain(bounds, ctx);
  const outputParent = safeOutputDirectory(directory), outputDirectory = childDirectory(outputParent, 'atlas-terrain', terrain.backgroundSha256.slice(0, 24));
  const backgroundPath = path.join(outputDirectory, 'terrain.png'), manifestPath = path.join(outputDirectory, 'geographic-data.json');
  atomicWrite(backgroundPath, fs.readFileSync(terrain.backgroundPath));
  const attribution = terrain.sources.map(source => source.attribution).join('; ');
  writeJson(manifestPath, {...terrain, backgroundPath: undefined, attribution});
  return {...terrain, backgroundPath, manifestPath, attribution};
}

export async function prepareMapData(input, options = {}) {
  const normalizedInput = validateInput(input);
  const outputParent = safeOutputDirectory(normalizedInput.directory);
  const mapDirectory = childDirectory(outputParent, 'maps');
  const ctx = context(options);
  const {width, height} = ctx;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 180 || width > 3840 || height > 2160) throw new Error('地图输出尺寸无效');
  const gazetteer = naturalEarth('ne_10m_populated_places', ctx);
  const uniqueNames = [];
  const seen = new Set();
  for (const name of [...normalizedInput.places, ...normalizedInput.routes.flatMap(route => [route.from, route.to])]) {
    const key = normalizePlace(name);
    if (!seen.has(key)) { seen.add(key); uniqueNames.push(name); }
  }
  const resolved = await mapConcurrent(uniqueNames, 1, name => resolvePlace(name, gazetteer, ctx));
  const byName = new Map(resolved.map(place => [normalizePlace(place.name), place]));
  const bounds = fittedBounds(resolved, width, height);
  const allPlaces = [...resolved.map(place => ({...place, role: 'primary'})), ...contextualPlaces(gazetteer, resolved, bounds)];
  const project = point => projectPoint([point.lon, point.lat], bounds);
  const cities = allPlaces.map(place => {
    const [x, y] = project(place);
    return {name: place.name, x, y, role: place.role};
  });
  const routeColors = ['#b63d35', '#2b6f77', '#c78532', '#6e4d83', '#3d6b49'];
  const routes = normalizedInput.routes.map((route, index) => {
    const from = byName.get(normalizePlace(route.from));
    const to = byName.get(normalizePlace(route.to));
    if (!from || !to) throw new Error(`路线端点无法核实：${route.from} → ${route.to}`);
    const points = [project(from), project(to)];
    if (Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]) < .0001) throw new Error(`路线端点重合，拒绝生成：${route.from} → ${route.to}`);
    return {name: `${route.label || `${route.from} → ${route.to}`}（路线示意）`, points, color: routeColors[index % routeColors.length],
      start: normalizedInput.duration * (.12 + .65 * index / normalizedInput.routes.length),
      end: normalizedInput.duration * (.12 + .65 * (index + 1) / normalizedInput.routes.length)};
  });
  const rivers = naturalEarth('ne_10m_rivers_lake_centerlines', ctx);
  const terrain = await prepareTerrain(bounds, ctx);
  const waterways = preparedWaterways(bounds, rivers);
  const sourceRecords = [...terrain.sources, ...(waterways.length ? [rivers.source] : []), ...allPlaces.map(place => place.source)];
  const uniqueSources = sourceRecords.filter((source, index, list) => list.findIndex(other => other.url === source.url) === index);
  const attribution = [
    ...uniqueSources.map(source => source.attribution),
    '现代城市定位，非古城址；路线示意，不表示古道；不含古代国界。',
  ].filter(Boolean).join(' ');
  const outputKey = sha256(JSON.stringify({input: {...normalizedInput, directory: undefined}, bounds, background: terrain.backgroundSha256})).slice(0, 24);
  const outputDirectory = childDirectory(mapDirectory, outputKey);
  const backgroundPath = path.join(outputDirectory, 'terrain.png');
  atomicWrite(backgroundPath, fs.readFileSync(terrain.backgroundPath));
  const manifestPath = path.join(outputDirectory, 'geographic-data.json');
  const manifest = {
    version: VERSION,
    title: normalizedInput.title,
    bounds,
    crs: 'EPSG:4326',
    projection: PROJECTION,
    width,
    height,
    zoom: terrain.zoom,
    backgroundSha256: terrain.backgroundSha256,
    processing: terrain.processing,
    cartography: terrain.cartography,
    resolvedPlaces: allPlaces,
    presentation: normalizedInput.presentation,
    routes: normalizedInput.routes,
    sources: uniqueSources,
    attribution,
    historyStatus: 'illustrative',
    generatedAt: new Date().toISOString(),
  };
  writeJson(manifestPath, {...manifest, cities, motionRoutes: routes, waterways});
  return {title: normalizedInput.title, backgroundPath, width, height, bounds, projection: PROJECTION,
    cities, routes, waterways, cartography: terrain.cartography, processing: terrain.processing, sources: uniqueSources, attribution, manifestPath};
}

