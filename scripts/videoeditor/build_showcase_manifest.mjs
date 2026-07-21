#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const snapshotPath = process.argv[2] || path.join(root, 'data/temp/videoeditor-episode-114-1.json')
const planPath = process.argv[3] || path.join(root, 'data/temp/videoeditor-plan-114-1.json')
const assetsPath = process.argv[4] || path.join(root, 'data/temp/videoeditor-showcase-assets-114-1.json')
const outputPath = process.argv[5] || path.join(root, 'data/temp/videoeditor-showcase-props-114-1.json')
const characterAssetsPath = process.argv[6] || path.join(root, 'data/temp/videoeditor-showcase-v2-characters-114-1.json')
const stockAssetsPath = process.argv[7] || path.join(root, 'data/temp/videoeditor-stock-broll-114-1.json')
const apiBase = (process.env.HUOBAO_API_BASE || 'http://localhost:3013').replace(/\/$/, '')
const fps = 30
const selectedNumbers = (process.env.SHOWCASE_SHOTS || '1,2,3,4,5,6,7,8,9,10,11,12,13,14')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)

const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
const assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'))
const characterAssets = fs.existsSync(characterAssetsPath)
  ? JSON.parse(fs.readFileSync(characterAssetsPath, 'utf8'))
  : { characters: [] }
const stockAssets = fs.existsSync(stockAssetsPath)
  ? JSON.parse(fs.readFileSync(stockAssetsPath, 'utf8'))
  : { items: [] }
const assetByStoryboardId = new Map((assets.shots || []).map((item) => [Number(item.storyboardId), item]))
const planByStoryboardId = new Map((plan.shots || []).map((item) => [Number(item.shotId), item]))
const characterByKey = new Map((characterAssets.characters || []).map((item) => [String(item.key), item]))
const stockByStoryboardNumber = new Map()

function localFileFor(relativePath) {
  if (!relativePath) return null
  if (String(relativePath).startsWith('static/')) return path.join(root, 'data', String(relativePath))
  return path.resolve(root, String(relativePath))
}

function staticPathFor(localPath) {
  const localFile = localFileFor(localPath)
  if (!localFile) return null
  const dataRoot = path.join(root, 'data')
  const relativeToData = path.relative(dataRoot, localFile).replaceAll(path.sep, '/')
  if (!relativeToData.startsWith('../') && relativeToData !== '..') return relativeToData
  return String(localPath).replace(/^\/+/, '')
}

for (const item of stockAssets.items || []) {
  const storyboardNumbers = Array.isArray(item.storyboardNumbers)
    ? item.storyboardNumbers
    : item.storyboardNumber != null
      ? [item.storyboardNumber]
      : []
  const localFile = localFileFor(item.localPath)
  if (!item.localPath || !localFile || !fs.existsSync(localFile)) continue
  for (const storyboardNumber of storyboardNumbers) {
    const number = Number(storyboardNumber)
    if (!Number.isInteger(number)) continue
    const staticPath = staticPathFor(item.localPath)
    const current = stockByStoryboardNumber.get(number) || []
    current.push({
      provider: item.provider,
      videoId: String(item.videoId || item.id || path.basename(localFile)),
      title: item.title || '',
      creator: item.creator || '',
      videoUrl: staticUrl(staticPath),
      localPath: staticPath,
      sourceUrl: item.sourceUrl || '',
      licenseUrl: item.licenseUrl || '',
      duration: Number(item.duration) || undefined,
      opacity: Number(item.opacity) || undefined,
      blendMode: item.blendMode || 'screen',
      startFrame: Number.isFinite(Number(item.startFrame)) ? Number(item.startFrame) : undefined,
      endFrame: Number.isFinite(Number(item.endFrame)) ? Number(item.endFrame) : undefined,
    })
    stockByStoryboardNumber.set(number, current)
  }
}

function staticUrl(relativePath) {
  if (!relativePath) return null
  if (/^https?:\/\//i.test(relativePath)) return relativePath
  return `${apiBase}/${String(relativePath).replace(/^\/+/, '')}`
}

function splitCaption(text, durationInFrames) {
  const raw = String(text || '').replace(/\s+/g, '')
  if (!raw) return []
  const sentences = raw.split(/(?<=[。！？!?；;])/).map((part) => part.trim()).filter(Boolean)
  const parts = sentences.length > 1 ? sentences : raw.length > 30
    ? raw.split(/(?<=[，,])/).map((part) => part.trim()).filter(Boolean)
    : [raw]
  const selected = parts.length > 4 ? parts.slice(0, 3).concat(parts.slice(-1)) : parts
  const weights = selected.map((part) => Math.max(1, part.length))
  const total = weights.reduce((sum, value) => sum + value, 0)
  let cursor = 0
  return selected.map((part, index) => {
    const startFrame = cursor
    cursor = index === selected.length - 1
      ? durationInFrames
      : Math.max(startFrame + 1, Math.round(durationInFrames * (weights.slice(0, index + 1).reduce((sum, value) => sum + value, 0) / total)))
    return { startFrame, endFrame: cursor, text: part }
  })
}

function captionSegmentsFor(shot, durationInFrames) {
  if (Number(shot.storyboardNumber) === 10) {
    const third = Math.round(durationInFrames / 3)
    return [
      { startFrame: 0, endFrame: third, text: '后来太平天国那些将领，杨秀清' },
      { startFrame: third, endFrame: third * 2, text: '李秀成' },
      { startFrame: third * 2, endFrame: Math.max(third * 2 + 1, durationInFrames - 60), text: '萧朝贵，全是这种苦出身。' },
      { startFrame: Math.max(third * 2 + 1, durationInFrames - 60), endFrame: durationInFrames, text: '没地、没饭吃、没出路。' },
    ]
  }
  return splitCaption(shot.narration || shot.dialogue || '', durationInFrames)
}

function graphicFor(shot) {
  const text = [shot.title, shot.narration, shot.action, shot.result, shot.imagePrompt].filter(Boolean).join(' ')
  if (/太平天国170年|战场全景|清代战场/.test(text)) return 'opening'
  if (/4\.3亿|人口爆炸|人口/.test(text)) return 'population'
  if (/1\.86亩|人均耕地|泥土/.test(text)) return 'land'
  if (/失地|重农轻商|荒山|无出路/.test(text)) return 'exodus'
  if (/1850年代|核心追问|日历|为何偏偏/.test(text)) return 'question'
  if (/康乾|康熙|雍正|分屏/.test(text) && /仁政|永不加赋|摊丁入亩/.test(text)) return 'rulers'
  if (/杨秀清|李秀成|萧朝贵|三格/.test(text)) return 'triptych'
  if (/地道|挖矿|炸城墙|引线/.test(text)) return 'tunnel'
  if (/广州港|贸易顺差|茶叶|丝绸|瓷器/.test(text)) return 'trade'
  if (/英国工业革命|白银|钟表|呢绒|洋布/.test(text)) return 'flow'
  if (/洪水|旱灾|天灾不断|左右对比/.test(text)) return 'compare'
  if (/1840年|鸦片战争门坎|炮舰|珠江口/.test(text)) return 'year'
  return 'none'
}

function characterPlanFor(shot, durationInFrames, captions) {
  const number = Number(shot.storyboardNumber)
  if (number === 6) {
    const split = captions?.[0]?.endFrame || Math.round(durationInFrames * 0.47)
    return [
      { key: 'kangxi', name: '康熙', startFrame: 0, endFrame: split, detail: '永不加赋', accent: '#e4b85d' },
      { key: 'yongzheng', name: '雍正', startFrame: split, endFrame: durationInFrames, detail: '摊丁入亩', accent: '#ba6b52' },
    ]
  }
  if (number === 10) {
    const third = Math.round(durationInFrames / 3)
    return [
      { key: 'yang-xiuqing', name: '杨秀清', startFrame: 0, endFrame: third, detail: '抡锤开矿', accent: '#d69a45' },
      { key: 'li-xiucheng', name: '李秀成', startFrame: third, endFrame: third * 2, detail: '推矿车', accent: '#c66f4e' },
      { key: 'xiao-chaogui', name: '萧朝贵', startFrame: third * 2, endFrame: durationInFrames, detail: '矿洞口擦汗', accent: '#9e7860' },
    ]
  }
  return []
}

function mapFor(shot) {
  const storyboardNumber = Number(shot.storyboardNumber)
  if (storyboardNumber === 13) {
    return {
      mode: 'trade-surplus',
      projection: 'equirectangular',
      historyStatus: 'illustrative',
      source: {
        name: 'Local cached world.geojson',
        license: 'Project-local cached source',
        url: 'data/static/demos/world.geojson',
      },
      locations: [
        { id: 'guangzhou', label: '广州港', lon: 113.2644, lat: 23.1291, coordinateSource: 'verified', labelDx: 14, labelDy: 24 },
        { id: 'london', label: '世界市场', lon: -0.1276, lat: 51.5072, coordinateSource: 'verified', labelDx: 14, labelDy: 30 },
      ],
      routes: [
        {
          id: 'goods-out',
          from: 'guangzhou',
          to: 'london',
          historyStatus: 'illustrative',
          color: '#d9984f',
          label: '茶叶 · 丝绸 · 瓷器',
          labelAt: { lon: 57, lat: 18 },
          waypoints: [
            { lon: 99, lat: 11 },
            { lon: 72, lat: 7 },
            { lon: 43, lat: 10 },
            { lon: 18, lat: 28 },
          ],
        },
        {
          id: 'silver-in',
          from: 'london',
          to: 'guangzhou',
          historyStatus: 'illustrative',
          color: '#e7bd68',
          label: '白银流入中国',
          labelAt: { lon: 68, lat: 34 },
          waypoints: [
            { lon: 18, lat: 28 },
            { lon: 43, lat: 10 },
            { lon: 72, lat: 7 },
            { lon: 99, lat: 11 },
          ],
          opacity: 0.92,
        },
      ],
      warnings: ['海上航线用于表达贸易方向，未表示单一可考证航道'],
    }
  }
  if (storyboardNumber === 14) {
    return {
      mode: 'silver-flow',
      projection: 'equirectangular',
      historyStatus: 'illustrative',
      source: {
        name: 'Local cached world.geojson',
        license: 'Project-local cached source',
        url: 'data/static/demos/world.geojson',
      },
      locations: [
        { id: 'guangzhou', label: '广州港', lon: 113.2644, lat: 23.1291, coordinateSource: 'verified', labelDx: 14, labelDy: 24 },
        { id: 'london', label: '英国', lon: -0.1276, lat: 51.5072, coordinateSource: 'verified', labelDx: 14, labelDy: 30 },
      ],
      routes: [
        {
          id: 'industrial-goods',
          from: 'london',
          to: 'guangzhou',
          historyStatus: 'illustrative',
          color: '#729aa0',
          label: '钟表 · 呢绒 · 洋布',
          labelAt: { lon: 38, lat: 4 },
          waypoints: [
            { lon: 18, lat: 28 },
            { lon: 43, lat: 10 },
            { lon: 72, lat: 7 },
            { lon: 99, lat: 11 },
          ],
        },
        {
          id: 'silver-to-china',
          from: 'london',
          to: 'guangzhou',
          historyStatus: 'illustrative',
          color: '#d7a94d',
          label: '白银 → 中国',
          labelAt: { lon: 67, lat: 32 },
          waypoints: [
            { lon: 18, lat: 28 },
            { lon: 43, lat: 10 },
            { lon: 72, lat: 7 },
            { lon: 99, lat: 11 },
          ],
          opacity: 0.98,
        },
      ],
      warnings: ['海上航线用于表达贸易方向，未表示单一可考证航道'],
    }
  }
  if (storyboardNumber !== 9) return null
  return {
    mode: 'migration',
    projection: 'equirectangular',
    source: {
      name: 'Natural Earth 1:50m',
      license: 'Public Domain',
      url: 'https://github.com/nvkelso/natural-earth-vector',
    },
    historyStatus: 'illustrative',
    locations: [
      { id: 'guangzhou', label: '广州', lon: 113.2644, lat: 23.1291, coordinateSource: 'verified' },
      { id: 'wuzhou', label: '梧州', lon: 111.2791, lat: 23.4761, coordinateSource: 'verified' },
      { id: 'guiping', label: '桂平 / 金田', lon: 110.0744, lat: 23.3945, coordinateSource: 'verified' },
    ],
    routes: [
      { from: 'guangzhou', to: 'guiping', historyStatus: 'illustrative', color: '#d66c4c' },
    ],
    warnings: ['路线用于表达失地农民由城镇进入山区的叙事方向，不代表单一可考证迁徙路径'],
  }
}

function buildShot(shot) {
  const asset = assetByStoryboardId.get(Number(shot.id))
  const sourcePlan = planByStoryboardId.get(Number(shot.id))
  if (!sourcePlan) throw new Error(`No edit plan for storyboard ${shot.id}`)
  const durationInFrames = Math.max(1, Math.round(Number(shot.duration) * fps))
  const generatedImageUrl = asset?.imageUrl || staticUrl(asset?.localPath)
  const fallbackImageUrl = staticUrl(shot.firstFrameImage || shot.videoUrl)
  const captionSegments = captionSegmentsFor(shot, durationInFrames)
  const characterPlan = characterPlanFor(shot, durationInFrames, captionSegments)
  const characters = characterPlan
    .map((item) => ({ ...item, imageUrl: characterByKey.get(item.key)?.imageUrl || staticUrl(characterByKey.get(item.key)?.localPath) || null }))
    .filter((item) => item.imageUrl)
  const stockBroll = stockByStoryboardNumber.get(Number(shot.storyboardNumber)) || []
  return {
    storyboardNumber: Number(shot.storyboardNumber),
    storyboardId: Number(shot.id),
    duration: Number(shot.duration),
    durationInFrames,
    title: shot.title || `镜头 ${shot.storyboardNumber}`,
    imageUrl: generatedImageUrl || fallbackImageUrl,
    fallbackImageUrl,
    audioUrl: staticUrl(shot.audioUrl || shot.narrationAudioUrl),
    narration: shot.narration || shot.dialogue || '',
    graphic: graphicFor(shot),
    visualMode: mapFor(shot)?.mode || (characters.length > 0 ? 'character-sequence' : 'image-plate'),
    characters,
    map: mapFor(shot),
    stockBroll,
    captionSegments,
    sourceEvidence: sourcePlan.sourceEvidence,
    beats: sourcePlan.beats,
    warnings: [
      ...(sourcePlan.warnings || []),
      ...(asset?.status === 'reused' ? ['该 showcase 资产已存在，复用同一 gpt-image-2 生成记录'] : []),
      ...(generatedImageUrl ? [] : ['缺少 showcase 生成图，使用 episode 首帧回退']),
      ...(characters.length < characterPlan.length ? ['缺少单人物素材，已回退到普通镜头图'] : []),
    ],
  }
}

const shots = snapshot.storyboards
  .filter((shot) => selectedNumbers.includes(Number(shot.storyboardNumber)))
  .map(buildShot)
const durationInFrames = shots.reduce((sum, shot) => sum + shot.durationInFrames, 0)

const manifest = {
  schemaVersion: 1,
  kind: 'remotion-episode-showcase',
  episodeId: Number(snapshot.episode.id),
  dramaId: Number(snapshot.episode.dramaId),
  episodeNumber: Number(snapshot.episode.episodeNumber),
  title: snapshot.episode.title,
  fps,
  width: 1280,
  height: 720,
  durationInFrames,
  durationSeconds: durationInFrames / fps,
  sourceSnapshot: path.relative(root, snapshotPath),
  editPlan: path.relative(root, planPath),
  assetManifest: path.relative(root, assetsPath),
  characterAssetManifest: path.relative(root, characterAssetsPath),
  stockAssetManifest: path.relative(root, stockAssetsPath),
  selectedStoryboards: selectedNumbers,
  shots,
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(JSON.stringify({ output: outputPath, shots: shots.length, durationSeconds: manifest.durationSeconds, generatedImages: shots.filter((shot) => shot.imageUrl !== shot.fallbackImageUrl).length }, null, 2))
