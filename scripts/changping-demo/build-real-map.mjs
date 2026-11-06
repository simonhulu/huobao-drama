#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(path.join(root, 'backend/package.json'));
const sharp = req('sharp');
const output = path.join(root, 'remotion/public/changping-demo-v2');
const cache = path.join(root, 'data/static/changping-demo-v2-20261024/map-source-data');
const bounds = {minLon: 107.5, maxLon: 116.3, minLat: 33.6, maxLat: 37.5};
const width = 3840, height = 1504, zoom = 9, tileSize = 256;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
fs.mkdirSync(output, {recursive: true});
fs.mkdirSync(cache, {recursive: true});
const tileDirectory = path.join(cache, 'terrarium');
fs.mkdirSync(tileDirectory, {recursive: true});

async function download(url, file, accept) {
  const metadataFile = `${file}.source.json`;
  if (fs.existsSync(file) && fs.existsSync(metadataFile)) return {buffer: fs.readFileSync(file), ...JSON.parse(fs.readFileSync(metadataFile, 'utf8'))};
  const {stdout} = await run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '45',
    '--dump-header', '-', ...(accept ? ['--header', `Accept: ${accept}`] : []), url], {encoding: 'buffer', maxBuffer: 32e6});
  // curl includes the complete final response headers before the downloaded binary.
  let offset = 0, headers = '';
  while (stdout.subarray(offset, offset + 5).toString() === 'HTTP/') {
    const end = stdout.indexOf('\r\n\r\n', offset);
    if (end < 0) throw Error(`Malformed HTTP response: ${url}`);
    headers = stdout.subarray(offset, end).toString(); offset = end + 4;
  }
  const bytes = stdout.subarray(offset);
  const metadata = {url, downloadedAt: new Date().toISOString(), sha256: sha256(bytes), bytes: bytes.length,
    etag: headers.match(/^etag:\s*(.+)$/im)?.[1]?.trim() ?? null,
    imagerySources: headers.match(/^x-amz-meta-x-imagery-sources:\s*(.+)$/im)?.[1]?.trim() ?? null};
  fs.writeFileSync(file, bytes); json(metadataFile, metadata);
  return {buffer: bytes, ...metadata};
}

const tileX = lon => (lon + 180) / 360 * 2 ** zoom;
const tileY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** zoom;
const minX = Math.floor(tileX(bounds.minLon)), maxX = Math.floor(tileX(bounds.maxLon));
const minY = Math.floor(tileY(bounds.maxLat)), maxY = Math.floor(tileY(bounds.minLat));
const tiles = [];
for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) tiles.push({x, y});
const columns = maxX - minX + 1, rows = maxY - minY + 1;
const sourceWidth = columns * tileSize, sourceHeight = rows * tileSize;
const elevations = new Float32Array(sourceWidth * sourceHeight);
const terrainSources = [];
let cursor = 0, completed = 0;
await Promise.all(Array.from({length: 8}, async () => {
  while (cursor < tiles.length) {
    const {x, y} = tiles[cursor++];
    const result = await download(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`,
      path.join(tileDirectory, `${zoom}-${x}-${y}.png`));
    const {data, info} = await sharp(result.buffer).removeAlpha().raw().toBuffer({resolveWithObject: true});
    if (info.width !== tileSize || info.height !== tileSize || info.channels !== 3) throw Error('Unexpected Terrarium tile format');
    for (let py = 0; py < tileSize; py++) for (let px = 0; px < tileSize; px++) {
      const index = (py * tileSize + px) * 3;
      elevations[((y - minY) * tileSize + py) * sourceWidth + (x - minX) * tileSize + px] = data[index] * 256 + data[index + 1] + data[index + 2] / 256 - 32768;
    }
    const {buffer: ignored, ...metadata} = result;
    terrainSources.push({...metadata, z: zoom, x, y});
    completed++;
    if (completed % 15 === 0 || completed === tiles.length) console.log(`DEM tiles ${completed}/${tiles.length}`);
  }
}));

// This inland study region has no below-sea-level terrain; isolated negative DEM cells are source artifacts.
const repairedSamples = [];
for (let index = 0; index < elevations.length; index++) {
  if (elevations[index] >= 0) continue;
  const x = index % sourceWidth, y = Math.floor(index / sourceWidth), neighbours = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= sourceWidth || yy >= sourceHeight || (!dx && !dy)) continue;
    const value = elevations[yy * sourceWidth + xx];
    if (value >= 0) neighbours.push(value);
  }
  if (!neighbours.length) throw Error('DEM void is too large for local repair');
  neighbours.sort((a, b) => a - b);
  const replacement = neighbours[Math.floor(neighbours.length / 2)];
  repairedSamples.push({sourcePixel: [x, y], originalMetres: elevations[index], replacementMetres: replacement});
}
for (const repair of repairedSamples) elevations[repair.sourcePixel[1] * sourceWidth + repair.sourcePixel[0]] = repair.replacementMetres;

const sample = (x, y) => {
  x = Math.max(0, Math.min(sourceWidth - 1.00001, x)); y = Math.max(0, Math.min(sourceHeight - 1.00001, y));
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const a = elevations[iy * sourceWidth + ix] * (1 - fx) + elevations[iy * sourceWidth + ix + 1] * fx;
  const b = elevations[(iy + 1) * sourceWidth + ix] * (1 - fx) + elevations[(iy + 1) * sourceWidth + ix + 1] * fx;
  return a * (1 - fy) + b * fy;
};
const raster = new Float32Array(width * height);
const sampleX = Array.from({length: width}, (_, x) => (tileX(bounds.minLon + (x + .5) / width * (bounds.maxLon - bounds.minLon)) - minX) * tileSize - .5);
let minimum = Infinity, maximum = -Infinity;
for (let y = 0; y < height; y++) {
  const lat = bounds.maxLat - (y + .5) / height * (bounds.maxLat - bounds.minLat);
  const sourceY = (tileY(lat) - minY) * tileSize - .5;
  for (let x = 0; x < width; x++) {
    const value = sample(sampleX[x], sourceY); raster[y * width + x] = value;
    minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
  }
}
const stops = [[0, [231, 239, 231]], [350, [219, 231, 213]], [900, [202, 219, 194]],
  [1600, [197, 211, 189]], [2400, [219, 225, 211]], [3600, [242, 243, 235]]];
const altitudeColor = z => {
  let i = 1; while (i < stops.length - 1 && z > stops[i][0]) i++;
  const a = stops[i - 1], b = stops[i], amount = Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0])));
  return a[1].map((v, channel) => v + (b[1][channel] - v) * amount);
};
const pixels = Buffer.alloc(width * height * 3);
const dy = 111320 * (bounds.maxLat - bounds.minLat) / height;
const lights = [[-.5, .5, Math.SQRT1_2, .62], [-.7071, 0, Math.SQRT1_2, .14], [0, .7071, Math.SQRT1_2, .14], [.5, .5, Math.SQRT1_2, .1]];
for (let y = 0; y < height; y++) {
  const lat = bounds.maxLat - (y + .5) / height * (bounds.maxLat - bounds.minLat);
  const dx = 111320 * Math.cos(lat * Math.PI / 180) * (bounds.maxLon - bounds.minLon) / width;
  for (let x = 0; x < width; x++) {
    const west = raster[y * width + Math.max(0, x - 1)], east = raster[y * width + Math.min(width - 1, x + 1)];
    const north = raster[Math.max(0, y - 1) * width + x], south = raster[Math.min(height - 1, y + 1) * width + x];
    const nx = -(east - west) / (2 * dx) * 2.6, ny = -(north - south) / (2 * dy) * 2.6;
    const length = Math.hypot(nx, ny, 1);
    const illumination = lights.reduce((total, [lx, ly, lz, weight]) => total + Math.max(0, (nx * lx + ny * ly + lz) / length) * weight, 0);
    const shade = .70 + illumination * .42;
    const color = altitudeColor(raster[y * width + x]);
    const index = (y * width + x) * 3;
    for (let channel = 0; channel < 3; channel++) pixels[index + channel] = Math.round(Math.min(252, color[channel] * shade));
  }
}
const terrain = path.join(output, 'terrain.png');
await sharp(pixels, {raw: {width, height, channels: 3}}).png().toFile(terrain);
console.log(`Terrain rendered ${width}x${height}, elevation ${minimum.toFixed(1)}..${maximum.toFixed(1)}m`);

async function naturalEarth(name) {
  const metadataUrl = `https://api.github.com/repos/nvkelso/natural-earth-vector/contents/geojson/${name}.geojson`;
  const metadata = await download(metadataUrl, path.join(cache, `${name}.github.json`), 'application/vnd.github+json');
  const record = JSON.parse(metadata.buffer);
  if (!record.sha) throw Error('Missing Natural Earth git blob SHA');
  const url = `https://api.github.com/repos/nvkelso/natural-earth-vector/git/blobs/${record.sha}`;
  const result = await download(url, path.join(cache, `${name}.geojson`), 'application/vnd.github.raw+json');
  return {data: JSON.parse(result.buffer), source: {title: `Natural Earth ${name}`, url: record.html_url, downloadUrl: url,
    gitBlobSha: record.sha, sha256: result.sha256, license: 'Public Domain', licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/'}};
}

function clipSegment(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy], q = [a[0] - bounds.minLon, bounds.maxLon - a[0], a[1] - bounds.minLat, bounds.maxLat - a[1]];
  let low = 0, high = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {if (q[i] < 0) return null; continue;}
    const ratio = q[i] / p[i];
    if (p[i] < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
    if (low > high) return null;
  }
  return [[a[0] + low * dx, a[1] + low * dy], [a[0] + high * dx, a[1] + high * dy]];
}
function clipLine(points) {
  const parts = []; let current = null;
  for (let i = 1; i < points.length; i++) {
    const segment = clipSegment(points[i - 1], points[i]);
    if (!segment) {current = null; continue;}
    if (!current || Math.hypot(current.at(-1)[0] - segment[0][0], current.at(-1)[1] - segment[0][1]) > 1e-8) {
      current = [segment[0], segment[1]]; parts.push(current);
    } else current.push(segment[1]);
  }
  return parts;
}
const [riverData, cityData] = await Promise.all([naturalEarth('ne_10m_rivers_lake_centerlines'), naturalEarth('ne_10m_populated_places')]);
const rivers = [];
for (const feature of riverData.data.features) {
  const p = feature.properties, geometry = feature.geometry;
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  for (const line of lines) for (const coordinates of clipLine(line)) rivers.push({name: p.name ?? p.NAME ?? '',
    nameZh: p.name_zh ?? p.NAME_ZH ?? null, rank: p.scalerank ?? p.SCALERANK ?? null, neId: p.ne_id ?? p.NE_ID ?? null,
    coordinates: coordinates.map(point => point.map(value => Number(value.toFixed(6))))});
}
const cities = cityData.data.features.filter(feature => {
  if (feature.geometry.type !== 'Point') return false;
  const [lon, lat] = feature.geometry.coordinates;
  return lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat;
}).map(feature => {
  const p = feature.properties;
  return {name: p.NAME ?? p.name ?? '', nameZh: p.NAME_ZH ?? p.name_zh ?? null, point: feature.geometry.coordinates,
    rank: p.SCALERANK ?? p.scalerank ?? null, neId: p.NE_ID ?? p.ne_id ?? null};
});
const sources = [riverData.source, cityData.source,
  {title: 'Mapzen Terrain Tiles on AWS Open Data', url: 'https://registry.opendata.aws/terrain-tiles/',
    terrainFormat: 'Terrarium: elevation = R*256 + G + B/256 - 32768 metres', imagerySources: [...new Set(terrainSources.flatMap(source => source.imagerySources?.split(', ').filter(Boolean) ?? []))]}];
json(path.join(output, 'geographic-data.json'), {bounds, crs: 'EPSG:4326', projection: 'Equirectangular; longitude and latitude linear in image pixels',
  width, height, rivers, cities, sources, historicalLimit: 'Modern DEM, rivers and city points are geographic context; not reconstructed ancient waterways, settlement sites or national borders.'});
terrainSources.sort((a, b) => a.y - b.y || a.x - b.x);
json(path.join(cache, 'manifest.json'), {bounds, width, height, zoom, terrain: {file: terrain, sha256: sha256(fs.readFileSync(terrain)),
  minimumElevationMetres: minimum, maximumElevationMetres: maximum, tileCount: terrainSources.length,
  dataRepair: {method: 'Isolated negative source elevations in this inland region replaced by median of nonnegative 3x3 neighbours before interpolation',
    count: repairedSamples.length, samples: repairedSamples},
  resampling: 'Bilinear from Web Mercator Terrarium tiles into linear longitude/latitude pixel centres',
  shading: 'Elevation gradient in ground metres; 2.6x vertical exaggeration; weighted northwestern multidirectional illumination'}, sources, tiles: terrainSources});
console.log(JSON.stringify({terrain, geographicData: path.join(output, 'geographic-data.json'), rivers: rivers.length, cities: cities.length, riverNames: [...new Set(rivers.map(river => river.name))], cityNames: cities.map(city => city.nameZh ?? city.name)}));
