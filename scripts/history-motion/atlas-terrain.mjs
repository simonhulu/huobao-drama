import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const sharp = requireBackend('sharp');
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const COPERNICUS_BASE = 'https://copernicus-dem-30m.s3.amazonaws.com';
const pendingRanges = new Map();
const failedRanges = new Map();

/** Read only classic TIFF directory metadata; libvips handles the Float32 pixels. */
export function copernicusPages(bytes) {
  const little = bytes.toString('ascii', 0, 2) === 'II';
  if (!little && bytes.toString('ascii', 0, 2) !== 'MM') throw Error('Copernicus 源不是 TIFF');
  const u16 = offset => little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const f64 = offset => little ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);
  if (u16(2) !== 42) throw Error('仅支持 Copernicus classic COG TIFF');
  let offset = u32(4); const pages = [], seen = new Set();
  while (offset) {
    if (seen.has(offset) || offset + 2 > bytes.length || pages.length > 12) throw Error('COG 目录越界');
    seen.add(offset);
    const count = u16(offset), end = offset + 2 + count * 12;
    if (end + 4 > bytes.length) throw Error('COG 目录超出请求头范围');
    const tags = {};
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12, tag = u16(entry), type = u16(entry + 2), length = u32(entry + 4);
      if (![256,257,258,259,277,317,322,323,324,325,339,33550,33922].includes(tag)) continue;
      const size = type === 3 ? 2 : type === 4 ? 4 : type === 12 ? 8 : 0;
      if (!size || length > 4096) throw Error('COG 标签格式不受支持');
      const begin = length * size <= 4 ? entry + 8 : u32(entry + 8);
      if (begin + length * size > bytes.length) throw Error('COG 标签超出请求头范围');
      tags[tag] = Array.from({length}, (_, n) => type === 3 ? u16(begin + n * size) : type === 4 ? u32(begin + n * size) : f64(begin + n * size));
    }
    if (tags[258]?.[0] !== 32 || tags[339]?.[0] !== 3 || tags[259]?.[0] !== 8 || tags[277]?.[0] !== 1) throw Error('Copernicus 需要单通道 Float32 Deflate COG');
    if (!tags[324]?.length || tags[324].length !== tags[325]?.length) throw Error('COG 缺少瓦片范围');
    const byteEnd = Math.max(...tags[324].map((start, n) => start + tags[325][n]));
    pages.push({page: pages.length, width: tags[256][0], height: tags[257][0], byteEnd, scale: tags[33550], tie: tags[33922]});
    offset = u32(end);
  }
  if (!pages.length || !pages[0].scale || !pages[0].tie) throw Error('COG 缺少经纬度配准');
  return pages;
}

export function copernicusTileUrl(lon, lat) {
  const name = `Copernicus_DSM_COG_10_${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}_00_${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}_00_DEM`;
  return `${COPERNICUS_BASE}/${name}/${name}.tif`;
}

async function cachedRange(url, end, directory, ctx) {
  const key = `${directory}:${url}:${end}`;
  if (pendingRanges.has(key)) return pendingRanges.get(key);
  const promise = readCachedRange(url, end, directory, ctx);
  pendingRanges.set(key, promise);
  try { return await promise; } finally { pendingRanges.delete(key); }
}

async function readCachedRange(url, end, directory, ctx) {
  const filename = path.join(directory, `${end}.tif`), record = `${filename}.json`;
  try {
    const source = JSON.parse(fs.readFileSync(record, 'utf8')), bytes = fs.readFileSync(filename);
    if (source.url === url && source.range === `bytes=0-${end - 1}` && bytes.length === end && hash(bytes) === source.sha256) return {bytes, source};
  } catch { /* Fetch only the missing range. */ }
  const failureKey = `${directory}:${url}:${end}`, failure = failedRanges.get(failureKey);
  if (failure?.until > Date.now()) throw Error(`Copernicus 本次下载暂不可用，复用其他地形缓存：${failure.reason}`);
  if (!ctx.network || Date.now() >= ctx.deadline) throw Error('Copernicus 缺少本地 COG 范围缓存');
  try {
  const timeout = Math.min(ctx.requestTimeoutMs, ctx.deadline - Date.now());
  const response = await ctx.fetchImpl(url, {headers: {Range: `bytes=0-${end - 1}`, Accept: 'image/tiff'}, signal: AbortSignal.timeout(timeout)});
  if (response.status !== 206 || !response.headers.get('content-range')?.startsWith(`bytes 0-${end - 1}/`)) {
    await response.body?.cancel(); throw Error(`Copernicus 不支持所需范围请求：${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== end) throw Error('Copernicus 范围响应不完整');
  const source = {url, range: `bytes=0-${end - 1}`, bytes: end, sha256: hash(bytes), downloadedAt: new Date().toISOString(), etag: response.headers.get('etag')};
  fs.mkdirSync(directory, {recursive: true});
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, filename);
  fs.writeFileSync(record, JSON.stringify(source, null, 2));
  failedRanges.delete(failureKey);
  return {bytes, source};
  } catch (error) {
    failedRanges.set(failureKey, {until: Date.now() + 60_000, reason: error.message});
    throw error;
  }
}

async function copernicusTile(lon, lat, targetDensity, ctx) {
  const url = copernicusTileUrl(lon, lat), directory = path.join(ctx.cacheDirectory, 'copernicus', `${lon}_${lat}`);
  const header = await cachedRange(url, 16_384, directory, ctx), pages = copernicusPages(header.bytes);
  const available = pages.filter(p => p.byteEnd <= 3_500_000);
  const selected = available.find(p => p.width >= targetDensity * .75 && p.width <= targetDensity * 2.5) ?? available[0];
  if (!selected) throw Error('Copernicus 预览范围超过单片预算');
  const data = await cachedRange(url, selected.byteEnd, directory, ctx);
  const {data: raw, info} = await sharp(data.bytes, {page: selected.page, failOn: 'error'}).toColourspace('b-w').raw({depth: 'float'}).toBuffer({resolveWithObject: true});
  if (info.width !== selected.width || info.height !== selected.height || info.channels !== 1) throw Error('Copernicus 高程解码尺寸错误');
  const scale = pages[0].scale, tie = pages[0].tie;
  if (Math.abs(tie[3] - lon) > .001 || Math.abs(tie[4] - (lat + 1)) > .001) throw Error('Copernicus 经纬度与瓦片请求不一致');
  const sourceWidth = pages[0].width * scale[0], sourceHeight = pages[0].height * scale[1];
  if (Math.abs(sourceWidth - 1) > .005 || Math.abs(sourceHeight - 1) > .005) throw Error('Copernicus 瓦片经纬度范围不是一度');
  return {lon, lat, width: info.width, height: info.height,
    values: new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4),
    source: {...data.source, localFile: path.join(directory, `${selected.byteEnd}.tif`), overview: selected.page, sampledWidth: info.width, sampledHeight: info.height, sourceWidth: pages[0].width, sourceHeight: pages[0].height}};
}

export async function copernicusRaster(bounds, width, height, ctx) {
  const coordinates = [];
  for (let lat = Math.floor(bounds.minLat); lat < Math.ceil(bounds.maxLat); lat++) for (let lon = Math.floor(bounds.minLon); lon < Math.ceil(bounds.maxLon); lon++) coordinates.push([lon, lat]);
  if (coordinates.length > 8 || Math.abs(bounds.minLat) > 70 || Math.abs(bounds.maxLat) > 70) throw Error('此区域使用缓存瓦片地形；Copernicus 局部预算最多八片');
  const density = Math.max(width / (bounds.maxLon - bounds.minLon), height / (bounds.maxLat - bounds.minLat));
  const tiles = await Promise.all(coordinates.map(([lon, lat]) => copernicusTile(lon, lat, density, ctx)));
  const byCoordinate = new Map(tiles.map(tile => [`${tile.lon},${tile.lat}`, tile]));
  const raster = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const lat = bounds.maxLat - (y + .5) / height * (bounds.maxLat - bounds.minLat);
    for (let x = 0; x < width; x++) {
      const lon = bounds.minLon + (x + .5) / width * (bounds.maxLon - bounds.minLon);
      const tile = byCoordinate.get(`${Math.floor(lon)},${Math.floor(lat)}`);
      const sx = clamp((lon - tile.lon) * tile.width - .5, 0, tile.width - 1.00001), sy = clamp((tile.lat + 1 - lat) * tile.height - .5, 0, tile.height - 1.00001);
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const at = (dx, dy) => tile.values[(iy + dy) * tile.width + ix + dx];
      const value = (at(0,0) * (1 - fx) + at(1,0) * fx) * (1 - fy) + (at(0,1) * (1 - fx) + at(1,1) * fx) * fy;
      if (!Number.isFinite(value) || value < -500 || value > 9000) throw Error('Copernicus 高程存在空值或无效像素');
      raster[y * width + x] = value;
    }
  }
  return {raster, source: {kind: 'terrain', title: 'Copernicus DEM GLO-30 (scale-selected COG overviews)',
    url: 'https://registry.opendata.aws/copernicus-dem/', license: 'Copernicus DEM GLO-30 licence',
    licenseUrl: 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model',
    attribution: 'Copernicus DEM © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; modified relief rendering',
    tiles: tiles.map(tile => tile.source)},
    sampling: {provider: 'copernicus-glo30', tileCount: tiles.length, overviewWidths: tiles.map(tile => tile.width),
      nativeWidth: (bounds.maxLon - bounds.minLon) * Math.min(...tiles.map(tile => tile.width)),
      nativeHeight: (bounds.maxLat - bounds.minLat) * Math.min(...tiles.map(tile => tile.height)),
      horizontalUpscale: width / ((bounds.maxLon - bounds.minLon) * Math.min(...tiles.map(tile => tile.width))),
      verticalUpscale: height / ((bounds.maxLat - bounds.minLat) * Math.min(...tiles.map(tile => tile.height))),
      nativeSource: 'GLO-30 approximately 30 m DSM; selected overviews resampled to output extent', downloadedBytes: tiles.reduce((sum, tile) => sum + tile.source.bytes + 16_384, 0)}};
}

function boxBlur(input, width, height, radius) {
  const horizontal = new Float32Array(input.length), output = new Float32Array(input.length), span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width; let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += input[row + clamp(i, 0, width - 1)];
    for (let x = 0; x < width; x++) {horizontal[row + x] = sum / span; sum += input[row + clamp(x + radius + 1, 0, width - 1)] - input[row + clamp(x - radius, 0, width - 1)];}
  }
  for (let x = 0; x < width; x++) {
    let sum = 0; for (let i = -radius; i <= radius; i++) sum += horizontal[clamp(i, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {output[y * width + x] = sum / span; sum += horizontal[clamp(y + radius + 1, 0, height - 1) * width + x] - horizontal[clamp(y - radius, 0, height - 1) * width + x];}
  }
  return output;
}

const COLORS = [[-500,[198,216,215]],[0,[239,236,215]],[90,[231,232,207]],[250,[212,224,194]],[600,[188,207,172]],[1100,[176,193,154]],[1800,[191,191,155]],[3000,[213,198,168]],[5000,[235,225,208]]];
function terrainColor(value) {
  let stop = 1; while (stop < COLORS.length - 1 && value > COLORS[stop][0]) stop++;
  const before = COLORS[stop - 1], after = COLORS[stop], t = clamp((value - before[0]) / (after[0] - before[0]), 0, 1);
  return before[1].map((channel, index) => channel + (after[1][index] - channel) * t);
}

/** Light and broad relief both come from measured elevations; no procedural mountains. */
export async function shadeAtlasRaster(raster, bounds, width, height) {
  if (!(raster instanceof Float32Array) || raster.length !== width * height) throw Error('高程栅格尺寸不匹配');
  const fine = boxBlur(raster, width, height, 1), broad = boxBlur(raster, width, height, Math.max(3, Math.round(width / 180)));
  const pixels = Buffer.alloc(width * height * 3), dy = 111_320 * (bounds.maxLat - bounds.minLat) / height;
  const light = (data, x, y, dx, exaggeration) => {
    const east = data[y * width + Math.min(width - 1, x + 1)], west = data[y * width + Math.max(0, x - 1)];
    const north = data[Math.max(0, y - 1) * width + x], south = data[Math.min(height - 1, y + 1) * width + x];
    const nx = -(east - west) / (2 * dx) * exaggeration, ny = -(north - south) / (2 * dy) * exaggeration, length = Math.hypot(nx, ny, 1);
    return .74 * Math.max(0, (-.5 * nx + .5 * ny + .7071) / length) + .16 * Math.max(0, (.5 * nx + .5 * ny + .7071) / length) + .1 / length;
  };
  for (let y = 0; y < height; y++) {
    const latitude = bounds.maxLat - (y + .5) / height * (bounds.maxLat - bounds.minLat), dx = 111_320 * Math.cos(latitude * Math.PI / 180) * (bounds.maxLon - bounds.minLon) / width;
    for (let x = 0; x < width; x++) {
      const index = y * width + x, elevation = raster[index];
      if (!Number.isFinite(elevation)) throw Error('高程栅格含无效像素');
      const fineLight = light(fine, x, y, dx, 2.5), broadLight = light(broad, x, y, dx, 4);
      const curvature = clamp((fine[index] - broad[index]) / 160, -.18, .12);
      const shade = clamp(.56 + .40 * fineLight + .20 * broadLight + curvature * .22, .57, 1.15);
      const color = terrainColor(elevation);
      for (let c = 0; c < 3; c++) pixels[index * 3 + c] = Math.round(clamp(color[c] * shade, 0, 253));
    }
  }
  return sharp(pixels, {raw: {width, height, channels: 3}}).png().toBuffer();
}
