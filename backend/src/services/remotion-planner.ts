import {
  estimateNarrationDurationMs,
  isHardMaxShotViolation,
  REMOTION_SHOT_RHYTHM,
  splitNarrationToSegments,
} from './remotion-segmentation.js'
import { validateStoryContract } from './story-contract.js'

export type PlannedShotType = 'ai_plate' | 'character' | 'map' | 'stock' | 'graphic' | 'hybrid'
export type PlannedAssetType = 'ai_image' | 'character' | 'map' | 'stock_video' | 'graphic' | 'audio' | 'font'

export interface PlannerStoryboard {
  id?: number | null
  storyboardNumber: number
  sceneId?: number | null
  characterIds?: number[]
  title?: string | null
  location?: string | null
  time?: string | null
  shotType?: string | null
  angle?: string | null
  movement?: string | null
  action?: string | null
  result?: string | null
  atmosphere?: string | null
  imagePrompt?: string | null
  videoPrompt?: string | null
  dialogue?: string | null
  narration?: string | null
  description?: string | null
  duration?: number | null
  firstFrameImage?: string | null
  videoUrl?: string | null
  narrationAudioUrl?: string | null
  audioUrl?: string | null
  people?: string[]
  beatIds?: string[]
  segmentIndex?: number
  visualPlan?: Record<string, unknown> | null
  map?: Record<string, unknown> | null
  stock?: Record<string, unknown> | null
  [key: string]: unknown
}

export interface PlannerExistingShot {
  shotNumber: number
  visualPlan?: unknown
}

export interface PlannerStockAsset {
  provider: string
  videoId: string
  title?: string | null
  creator?: string | null
  query?: string | null
  sourceUrl?: string | null
  downloadUrl?: string | null
  licenseUrl?: string | null
  localPath: string
  duration?: number | null
  width?: number | null
  height?: number | null
  [key: string]: unknown
}

export interface PlannedAsset {
  shotNumber: number
  assetKey: string
  assetType: PlannedAssetType
  provider?: string | null
  status?: 'planned' | 'completed'
  prompt?: unknown
  sourceUrl?: string | null
  localPath?: string | null
  mimeType?: string | null
  width?: number | null
  height?: number | null
  durationMs?: number | null
  license?: unknown
  metadata?: unknown
}

export interface PlannedShot {
  shotNumber: number
  sourceStoryboardId?: number | null
  title: string
  narration?: string | null
  dialogue?: string | null
  durationMs: number
  shotType: PlannedShotType
  visualSetupId: string
  visualPlan: Record<string, unknown>
  sourceEvidence: Record<string, unknown>
  beatIds: string[]
}

export interface RemotionPlan {
  schemaVersion: 1
  shots: PlannedShot[]
  assets: PlannedAsset[]
  summary: {
    shotTypes: Record<PlannedShotType, number>
    assetTypes: Record<PlannedAssetType, number>
    warnings: string[]
  }
}

type Place = {
  id: string
  label: string
  lon: number
  lat: number
  coordinateSource: 'verified'
  labelDx?: number
  labelDy?: number
}

const KNOWN_PEOPLE = [
  '洪秀全', '冯云山', '杨秀清', '萧朝贵', '王作新',
  '洛克菲勒', '威廉·洛克菲勒', '伊丽莎白·洛克菲勒', '莫里斯·克拉克',
  '安德鲁·卡内基', 'J.P.摩根', '艾达·塔贝尔', '西奥多·罗斯福',
]

// Reuse the alpha-ready character library produced by the earlier Rockefeller
// Remotion production. These are local, deterministic assets, not new provider
// calls; unknown characters still use the normal setup-level generation path.
const LOCAL_CHARACTER_LIBRARY: Record<string, string> = {
  '约翰·D·洛克菲勒': 'data/static/remotion/project-2/characters/shot-13-character-约翰-d-洛克菲勒.png',
  '威廉·洛克菲勒': 'data/static/remotion/project-2/characters/shot-2-character-威廉-洛克菲勒.png',
  '伊丽莎白·洛克菲勒': 'data/static/remotion/project-2/characters/shot-2-character-伊丽莎白-洛克菲勒.png',
  '莫里斯·克拉克': 'data/static/remotion/project-2/characters/shot-4-character-莫里斯-克拉克.png',
  '安德鲁·卡内基': 'data/static/remotion/project-2/characters/shot-10-character-安德鲁-卡内基.png',
  'J.P.摩根': 'data/static/remotion/project-2/characters/shot-10-character-j-p-摩根.png',
  '艾达·塔贝尔': 'data/static/remotion/project-2/characters/shot-11-character-艾达-塔贝尔.png',
  '西奥多·罗斯福': 'data/static/remotion/project-2/characters/shot-11-character-西奥多-罗斯福.png',
}

const PLACES: Record<string, Place> = {
  guangzhou: { id: 'guangzhou', label: '广州', lon: 113.2644, lat: 23.1291, coordinateSource: 'verified' },
  huaxian: { id: 'huaxian', label: '广东花县', lon: 113.2202, lat: 23.3772, coordinateSource: 'verified' },
  wuzhou: { id: 'wuzhou', label: '梧州', lon: 111.2791, lat: 23.4761, coordinateSource: 'verified' },
  guiping: { id: 'guiping', label: '桂平 / 金田', lon: 110.0744, lat: 23.3945, coordinateSource: 'verified' },
  nanjing: { id: 'nanjing', label: '天京（南京）', lon: 118.7969, lat: 32.0603, coordinateSource: 'verified' },
  london: { id: 'london', label: '伦敦', lon: -0.1276, lat: 51.5072, coordinateSource: 'verified' },
}

const MAP_SOURCE = {
  name: 'Natural Earth 1:50m · project-local cached vector data',
  license: 'Public Domain',
  url: 'https://github.com/nvkelso/natural-earth-vector',
}

const MAP_BOUNDS = { minLon: 96, maxLon: 122, minLat: 20, maxLat: 42 }
const WORLD_MAP_BOUNDS = { minLon: -20, maxLon: 140, minLat: -12, maxLat: 72 }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function cleanText(value: unknown): string {
  return stringValue(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function canonicalPerson(value: string): string {
  if (/伊丽莎白/.test(value)) return '伊丽莎白·洛克菲勒'
  if (/威廉/.test(value)) return '威廉·洛克菲勒'
  if (/莫里斯|克拉克/.test(value)) return '莫里斯·克拉克'
  if (/卡内基/.test(value)) return '安德鲁·卡内基'
  if (/J\.?\s*P\.?|摩根/.test(value)) return 'J.P.摩根'
  if (/艾达|塔贝尔/.test(value)) return '艾达·塔贝尔'
  if (/西奥多|罗斯福/.test(value)) return '西奥多·罗斯福'
  if (/约翰|洛克菲勒/.test(value)) return '约翰·D·洛克菲勒'
  return value
}

function sourceText(storyboard: PlannerStoryboard): string {
  return [
    storyboard.title,
    storyboard.location,
    storyboard.time,
    storyboard.shotType,
    storyboard.angle,
    storyboard.movement,
    storyboard.action,
    storyboard.result,
    storyboard.narration,
    storyboard.dialogue,
    storyboard.description,
    storyboard.imagePrompt,
    storyboard.videoPrompt,
  ].map(cleanText).filter(Boolean).join(' ')
}

function visualSourceText(storyboard: PlannerStoryboard): string {
  return [
    storyboard.title,
    storyboard.location,
    storyboard.shotType,
    storyboard.angle,
    storyboard.movement,
    storyboard.action,
    storyboard.result,
  ].map(cleanText).filter(Boolean).join(' ')
}

function peopleIn(storyboard: PlannerStoryboard, text: string): string[] {
  const plan = record(storyboard.visualPlan)
  const declared = [
    ...(Array.isArray(storyboard.people) ? storyboard.people : []),
    ...(Array.isArray(plan.people) ? plan.people : []),
    ...(Array.isArray(plan.characters) ? plan.characters : []),
    ...(Array.isArray(plan.layers) ? plan.layers : []),
  ].map((value) => typeof value === 'string' ? value : stringValue(record(value).name)).map(cleanText).filter(Boolean)
  // Names found only in narration, title, or location are not enough to
  // justify a foreground character layer. For legacy rows, require the
  // visible action/result to name the person; explicit storyboard/visualPlan
  // people remain authoritative and can represent an actor whose name is not
  // repeated in the action text.
  const visibleAction = [storyboard.action, storyboard.result].map(cleanText).filter(Boolean).join(' ')
  const legacy = KNOWN_PEOPLE.filter((name) => visibleAction.includes(name))
  const normalized = [...new Set([...declared, ...legacy].map(canonicalPerson))]
  return normalized
}

function isEmptyOfPeople(text: string): boolean {
  return /空无一人|无人|没有人|曾经倒下的那个位置/.test(text)
}

function stockQueryKind(text: string): 'field' | 'crowd' | 'mining' | 'river' | 'ship' | null {
  if (/洪水|河流|江|水路|渡河|河岸/.test(text)) return 'river'
  if (/船|海上|港口|航路/.test(text)) return 'ship'
  if (/种地|农民|耕地|田地|农田|田野|庄稼|耕作/.test(text)) return 'field'
  if (/烧炭工|采煤|煤矿|矿洞|挖矿/.test(text)) return 'mining'
  if (/会众|群众|人群|乡勇|团练|聚集|穷人|集体/.test(text)) return 'crowd'
  return null
}

function stockMatches(item: PlannerStockAsset, kind: ReturnType<typeof stockQueryKind>): boolean {
  if (!kind) return false
  const haystack = [item.query, item.title, item.provider].map(cleanText).join(' ').toLowerCase()
  // Historical narration may use stock as neutral texture, but modern signs,
  // streets, machines, and container ports break the period continuity. A
  // producer can explicitly mark a clip as historical-safe to opt in.
  const metadata = record(item.metadata)
  if (metadata.historicalSafe === false) return false
  const modernMarkers = /modern|city|urban|street|seoul|korea|market|mall|shopping|tourism|cctv|signage|container|wheel loader|machine|machinery|industrial|construction|heavy equipment|factory|skyscraper/
  if (metadata.historicalSafe !== true && modernMarkers.test(haystack)) return false
  const patterns: Record<NonNullable<ReturnType<typeof stockQueryKind>>, RegExp> = {
    field: /field|farm|farmer|rural|田|农/,
    crowd: /crowd|people|gathering|village|人群/,
    mining: /mine|mining|coal|矿|煤/,
    river: /river|flood|water|mountain|河|水|山/,
    ship: /ship|ocean|boat|sea|sailing|船|海/,
  }
  return patterns[kind].test(haystack)
}

function chooseStock(storyboard: PlannerStoryboard, catalog: PlannerStockAsset[]): { item: PlannerStockAsset; kind: NonNullable<ReturnType<typeof stockQueryKind>> } | null {
  const plan = record(storyboard.visualPlan)
  const direct = record(storyboard.stock)
  const declared = Object.keys(direct).length ? direct : record(plan.stock)
  const declaredQuery = cleanText(declared.query)
  if (declaredQuery) {
    const declaredKind = cleanText(declared.kind)
    const kind = ['field', 'crowd', 'mining', 'river', 'ship'].includes(declaredKind)
      ? declaredKind as NonNullable<ReturnType<typeof stockQueryKind>>
      : stockQueryKind(declaredQuery)
    const item = catalog.find((candidate) => {
      const haystack = [candidate.query, candidate.title].map(cleanText).join(' ').toLowerCase()
      return stockMatches(candidate, kind) && (haystack.includes(declaredQuery.toLowerCase()) || declaredQuery.toLowerCase().includes(haystack))
    })
    if (item && kind) return { item, kind }
  }
  const text = visualSourceText(storyboard)
  const kind = stockQueryKind(text)
  if (!kind) return null
  const item = catalog.find((candidate) => stockMatches(candidate, kind))
  return item ? { item, kind } : null
}

function shortTitle(text: string, fallback: string) {
  const firstSentence = text.split(/(?<=[。！？!?；;])/)[0] || text
  const chars = Array.from(firstSentence)
  return chars.length > 28 ? `${chars.slice(0, 28).join('')}…` : firstSentence || fallback
}

function storyboardNarration(storyboard: PlannerStoryboard) {
  return cleanText(storyboard.narration || storyboard.dialogue || storyboard.description || storyboard.action || '')
}

/**
 * Split legacy/storyboard-stage rows before they become Remotion shots. A
 * storyboard row is a source description, not permission to hold one visual
 * for its entire narration. The source id and evidence are retained so the
 * resulting shots remain auditable.
 */
export function segmentStoryboardForRemotion(storyboard: PlannerStoryboard): PlannerStoryboard[] {
  const narration = storyboardNarration(storyboard)
  const declaredStory = record(record(storyboard.visualPlan).story)
  const declaredStoryBeatId = cleanText(declaredStory.beatId)
  const sourceDurationMs = Number(storyboard.duration || 0) > 0
    ? Math.round(Number(storyboard.duration) * 1000)
    : null

  if (!narration) {
    const durationMs = sourceDurationMs || REMOTION_SHOT_RHYTHM.targetShotDurationMs
    const partCount = Math.max(1, Math.ceil(durationMs / REMOTION_SHOT_RHYTHM.maxShotDurationMs))
    return Array.from({ length: partCount }, (_, index) => ({
      ...storyboard,
      title: partCount === 1
        ? storyboard.title
        : `${cleanText(storyboard.title) || `镜头 ${storyboard.storyboardNumber}`} · ${index + 1}`,
      duration: Math.round(durationMs / partCount) / 1000,
      segmentIndex: index,
      beatIds: storyboard.beatIds?.length
        ? storyboard.beatIds
        : declaredStoryBeatId
          ? [declaredStoryBeatId]
          : [`beat-${storyboard.storyboardNumber}-${index + 1}`],
    }))
  }

  const estimatedDurationMs = sourceDurationMs || estimateNarrationDurationMs(narration)
  const narrationChars = Array.from(narration.replace(/\s+/g, '')).length
  const alreadySafe = estimatedDurationMs <= REMOTION_SHOT_RHYTHM.maxShotDurationMs
    && narrationChars <= REMOTION_SHOT_RHYTHM.maxNarrationChars
  const segments = alreadySafe
    ? [{ text: narration, durationMs: estimatedDurationMs }]
    : splitNarrationToSegments(narration, estimatedDurationMs)

  return segments.map((segment, index) => ({
    ...storyboard,
    storyboardNumber: storyboard.storyboardNumber,
    title: segments.length === 1
      ? storyboard.title
      : `${shortTitle(segment.text, `镜头 ${storyboard.storyboardNumber}`)} · ${index + 1}`,
    narration: segment.text,
    description: segment.text,
    duration: segment.durationMs / 1000,
    segmentIndex: index,
    beatIds: storyboard.beatIds?.length
      ? storyboard.beatIds
      : declaredStoryBeatId
        ? [declaredStoryBeatId]
        : [`beat-${storyboard.storyboardNumber}-${index + 1}`],
  }))
}

// Script projects do not have legacy storyboard rows. They use the same
// semantic rhythm splitter as imported storyboard rows so a raw script can
// never create a 90-second Remotion shot by accident.
export function segmentScriptToStoryboards(script: string): PlannerStoryboard[] {
  const paragraphs = script
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (!paragraphs.length) return []

  let storyboardNumber = 0
  return paragraphs.flatMap((paragraph, paragraphIndex) => (
    splitNarrationToSegments(paragraph).map((segment, segmentIndex) => {
      storyboardNumber += 1
      return {
        storyboardNumber,
        title: shortTitle(segment.text, `镜头 ${storyboardNumber}`),
        shotType: 'auto',
        angle: '纪录片叙事镜头，根据叙事意图选择构图',
        movement: 'restrained push-in with semantic reframing',
        action: segment.text,
        result: '',
        atmosphere: '根据账号定位与叙事段落决定',
        narration: segment.text,
        description: segment.text,
        imagePrompt: '由分镜阶段决定是否生成无文字 clean plate、独立人物层或地图画面。',
        videoPrompt: '由 Remotion 根据分镜阶段的 visualPlan 进行分层合成和文字动画。',
        duration: segment.durationMs / 1000,
        segmentIndex,
        beatIds: [`beat-${storyboardNumber}`],
        visualPlan: {
          visualSetupId: `script-paragraph-${paragraphIndex + 1}`,
        },
      }
    })
  ))
}

function place(id: string): Place {
  return PLACES[id]
}

function mapSpecFor(storyboard: PlannerStoryboard, text: string): Record<string, unknown> | null {
  const direct = record(storyboard.map)
  const declared = Object.keys(direct).length ? direct : record(record(storyboard.visualPlan).map)
  if (Object.keys(declared).length > 0) return declared
  let mode: string
  let title: string
  let subtitle: string
  let from: string
  let to: string
  let waypoints: Array<{ lon: number; lat: number }> = []
  let waypointLocations: Place[] = []
  let warnings: string[]
  const tradeLanguage = /白银|贸易顺差|贸易流向|贸易网络|茶叶|丝绸|瓷器|钟表|呢绒|洋布|英国工业革命|工业革命/.test(text)
  if (tradeLanguage) {
    const silverFlow = /白银|工业革命|钟表|呢绒|洋布/.test(text)
    const goodsRoute = {
      id: silverFlow ? 'industrial-goods' : 'goods-out',
      from: 'guangzhou',
      to: 'london',
      waypoints: [
        { lon: 99, lat: 11 },
        { lon: 72, lat: 7 },
        { lon: 43, lat: 10 },
        { lon: 18, lat: 28 },
      ],
      historyStatus: 'illustrative',
      color: '#d9984f',
      label: silverFlow ? '钟表 · 呢绒 · 洋布' : '茶叶 · 丝绸 · 瓷器',
      labelAt: silverFlow ? { lon: 38, lat: 4 } : { lon: 57, lat: 18 },
    }
    const silverRoute = {
      id: silverFlow ? 'silver-to-china' : 'silver-in',
      from: 'london',
      to: 'guangzhou',
      waypoints: [
        { lon: 18, lat: 28 },
        { lon: 43, lat: 10 },
        { lon: 72, lat: 7 },
        { lon: 99, lat: 11 },
      ],
      historyStatus: 'illustrative',
      color: '#d7a94d',
      label: '白银流入中国',
      labelAt: { lon: 68, lat: 34 },
      opacity: 0.98,
    }
    return {
      mode: silverFlow ? 'silver-flow' : 'trade-surplus',
      projection: 'equirectangular',
      bounds: WORLD_MAP_BOUNDS,
      historyStatus: 'illustrative',
      source: MAP_SOURCE,
      title: silverFlow ? '工业革命初期' : '海上贸易网络',
      subtitle: silverFlow ? '白银流向中国' : '贸易顺差 · 货物出海',
      locations: [place('guangzhou'), place('london')],
      routes: [goodsRoute, silverRoute],
      warnings: ['海上航线用于表达贸易方向，未表示单一可考证航道'],
    }
  }

  if (/广州/.test(text) && /奔走|前往|营救/.test(text)) {
    mode = 'migration'
    title = '奔走与营救'
    subtitle = '紫荆山 → 广州'
    from = 'guiping'
    to = 'guangzhou'
    waypointLocations = [place('wuzhou')]
    waypoints = waypointLocations.map(({ lon, lat }) => ({ lon, lat }))
    warnings = ['路线用于表达洪秀全前往广州的叙事方向，不代表唯一可考证路径']
  } else if (/广东花县|遣回|归途|获释/.test(text)) {
    mode = 'migration'
    title = '释放之后的归途'
    subtitle = '广东花县 → 紫荆山'
    from = 'huaxian'
    to = 'guiping'
    waypointLocations = [place('guangzhou'), place('wuzhou')]
    waypoints = waypointLocations.map(({ lon, lat }) => ({ lon, lat }))
    warnings = ['归途为叙事示意；史料对押解与返回过程存在不同考证']
  } else if (/天京.*延伸|延伸.*天京|越过.*天京/.test(text)) {
    mode = 'migration'
    title = '裂缝如何延伸到天京'
    subtitle = '紫荆山 → 天京（南京）'
    from = 'guiping'
    to = 'nanjing'
    waypoints = [{ lon: 113.0, lat: 26.5 }, { lon: 115.2, lat: 29.2 }]
    warnings = ['路线用于表达制度影响的空间延伸，不是军事行军路线']
  } else {
    return null
  }

  const locations = [place(from), ...waypointLocations, place(to)]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)

  return {
    mode,
    projection: 'equirectangular',
    bounds: MAP_BOUNDS,
    historyStatus: 'illustrative',
    source: MAP_SOURCE,
    title,
    subtitle,
    locations,
    routes: [{
      id: `${from}-to-${to}`,
      from,
      to,
      waypoints,
      historyStatus: 'illustrative',
      color: '#d66c4c',
      label: subtitle,
    }],
    warnings,
  }
}

function existingBeats(existing: PlannerExistingShot | undefined, declaredPlan: Record<string, unknown> = {}): unknown[] {
  const declaredBeats = Array.isArray(declaredPlan.beats) ? declaredPlan.beats : []
  if (declaredBeats.length) return declaredBeats
  const plan = record(existing?.visualPlan)
  const beats = Array.isArray(plan.beats) ? plan.beats : []
  if (beats.length) return beats
  // A missing beat is a planning error, not permission to invent an
  // establishing shot. Returning an empty list keeps the failure visible to
  // the storyboard/shot gate and preserves the source-to-shot relationship.
  return []
}

function slug(value: string): string {
  const stable = {
    洪秀全: 'hong-xiuquan',
    冯云山: 'feng-yunshan',
    杨秀清: 'yang-xiuqing',
    萧朝贵: 'xiao-chaogui',
    王作新: 'wang-zuoxin',
  }[value as '洪秀全' | '冯云山' | '杨秀清' | '萧朝贵' | '王作新']
  if (stable) return stable
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'character'
}

function setupAssetKey(visualSetupId: string, suffix: string) {
  return `${slug(visualSetupId)}-${suffix}`
}

function characterAssetKey(person: string, shotNumber: number) {
  const canonical = canonicalPerson(person)
  // `assetKey` identifies one persisted row and must therefore be unique per
  // shot. Reuse across shots is represented separately by metadata.reuseKey.
  return `shot-${shotNumber}-character-${slug(canonical)}`
}

function visualSetupIdFor(storyboard: PlannerStoryboard, declaredPlan: Record<string, unknown>): string {
  const explicit = cleanText(declaredPlan.visualSetupId || declaredPlan.setupId)
  if (explicit) return explicit
  const basis = [storyboard.location, storyboard.time].map(cleanText).filter(Boolean)
  if (basis.length) return `setup-${slug(basis.join('-'))}`
  return `setup-${slug(cleanText(storyboard.title) || `shot-${storyboard.storyboardNumber}`)}`
}

function characterPrompt(person: string, storyboard: PlannerStoryboard): string {
  return [
    '用途：Remotion 人物透明层，不是完整场景图。',
    `人物：${person}，${cleanText(storyboard.action || storyboard.narration)}`,
    '只生成一个人物主体，完整或半身均可，透明背景 PNG，边缘干净，手指和衣物完整，人物不要携带任何文字、旗帜、标识或其他人。',
    `服饰、年龄、体态必须符合镜头指定的时代和地点：${cleanText(storyboard.time) || '以当前历史稿件为准'}；${cleanText(storyboard.location) || '以当前镜头地点为准'}。后续由 Remotion 将人物层叠加到 AI 场景板上。`,
  ].join('\n')
}

function platePrompt(storyboard: PlannerStoryboard, purpose: string): string {
  return [
    '用途：Remotion clean plate，画面内禁止出现文字。',
    `镜头：${cleanText(storyboard.title)}；${cleanText(storyboard.location)}；${cleanText(storyboard.action || storyboard.result)}`,
    `层职责：${purpose}`,
    `电影纪录片写实质感，符合镜头指定的时代和地点：${cleanText(storyboard.time) || '以当前历史稿件为准'}；${cleanText(storyboard.location) || '以当前镜头地点为准'}。保留给人物层和 Remotion 文本动画足够的留白。`,
    '严格禁止中文、英文、数字、字幕、招牌、旗帜文字、Logo、水印、界面、拼贴和分屏。',
  ].join('\n')
}

function buildSourceEvidence(storyboard: PlannerStoryboard): Record<string, unknown> {
  const story = record(record(storyboard.visualPlan).story)
  return {
    storyboardId: storyboard.id ?? null,
    storyboardNumber: storyboard.storyboardNumber,
    title: storyboard.title || '',
    sceneId: storyboard.sceneId ?? null,
    characterIds: storyboard.characterIds || [],
    people: storyboard.people || [],
    shotType: storyboard.shotType || '',
    angle: storyboard.angle || '',
    narration: storyboard.narration || '',
    dialogue: storyboard.dialogue || '',
    location: storyboard.location || '',
    time: storyboard.time || '',
    movement: storyboard.movement || '',
    action: storyboard.action || '',
    result: storyboard.result || '',
    atmosphere: storyboard.atmosphere || '',
    description: storyboard.description || '',
    videoPrompt: storyboard.videoPrompt || '',
    beatIds: storyboard.beatIds || [],
    story: Object.keys(story).length ? story : null,
    segmentIndex: storyboard.segmentIndex ?? 0,
    legacyAsset: storyboard.firstFrameImage || storyboard.videoUrl || null,
    audioUrl: storyboard.audioUrl || storyboard.narrationAudioUrl || null,
  }
}

function buildAssetForStock(shotNumber: number, stock: PlannerStockAsset, kind: string, visualSetupId?: string): PlannedAsset {
  const reuseKey = `${visualSetupId || `shot-${shotNumber}`}-stock-${kind}`
  return {
    shotNumber,
    assetKey: `shot-${shotNumber}-stock-${kind}`,
    assetType: 'stock_video',
    provider: stock.provider,
    status: 'completed',
    sourceUrl: stock.sourceUrl || null,
    localPath: stock.localPath,
    mimeType: 'video/mp4',
    width: stock.width || null,
    height: stock.height || null,
    durationMs: stock.duration ? Math.round(Number(stock.duration) * 1000) : null,
    license: { name: stock.provider, url: stock.licenseUrl || null, query: stock.query || null },
    metadata: {
      role: 'stock-broll',
      visualSetupId: visualSetupId || null,
      reuseKey,
      query: stock.query || null,
      title: stock.title || null,
      creator: stock.creator || null,
      videoId: stock.videoId,
      blendMode: 'normal',
      opacity: 1,
      selectionReason: kind,
    },
  }
}

function isTemporalPlan(plan: Record<string, unknown>): boolean {
  return plan.visualMode === 'temporal-2grid'
    || plan.assetStrategy === 'temporal-2grid-remotion'
    || plan.temporalGrid !== undefined
}

function temporalGridFor(
  storyboard: PlannerStoryboard,
  shotNumber: number,
  declaredPlan: Record<string, unknown>,
  durationMs: number,
): Record<string, unknown> {
  const raw = record(declaredPlan.temporalGrid)
  const rawPanels = Array.isArray(raw.panels) ? raw.panels : []
  const panels = rawPanels.map((value, index) => {
    const panel = record(value)
    const semantic = cleanText(panel.semantic || panel.action || (index === 0 ? storyboard.action : storyboard.result))
    const visualProof = cleanText(panel.visualProof || semantic)
    return {
      ...panel,
      index,
      semantic,
      visualProof,
      ...(panel.storyBeatId == null ? {} : { storyBeatId: cleanText(panel.storyBeatId) }),
    }
  })
  if (panels.length !== 2 || panels.some((panel) => !panel.semantic || !panel.visualProof)) {
    throw new Error(`镜头 ${shotNumber} temporal-2grid 必须提供两个不同且可验证的时间状态`)
  }

  const rawKeyframes = Array.isArray(raw.keyframes) ? raw.keyframes : []
  const midpoint = Math.max(1, Math.min(durationMs - 1, Math.round(durationMs / 2)))
  const keyframes = rawKeyframes.length
    ? rawKeyframes.map((value, index) => {
      const keyframe = record(value)
      const panel = Number(keyframe.panel ?? keyframe.sourceIndex ?? index)
      const atMs = Number(keyframe.atMs ?? keyframe.startMs ?? (index === 0 ? 0 : midpoint))
      return {
        ...keyframe,
        atMs,
        panel,
        sourceIndex: panel,
        action: cleanText(keyframe.action || panels[Math.max(0, Math.min(1, panel))]?.semantic),
      }
    })
    : [
      { id: 'start', atMs: 0, panel: 0, sourceIndex: 0, action: panels[0].semantic },
      { id: 'result', atMs: midpoint, panel: 1, sourceIndex: 1, action: panels[1].semantic },
    ]
  if (keyframes.length < 2 || keyframes.some((keyframe) => !keyframe.action)) {
    throw new Error(`镜头 ${shotNumber} temporal-2grid 必须提供至少两个有动作描述的关键帧`)
  }

  return {
    ...raw,
    schemaVersion: 1,
    layout: '2x1',
    rows: 1,
    columns: 2,
    sheetAssetKey: cleanText(raw.sheetAssetKey || declaredPlan.sheetAssetKey) || `shot-${shotNumber}-temporal-2grid`,
    panels,
    keyframes,
  }
}

function temporalSheetPrompt(
  storyboard: PlannerStoryboard,
  grid: Record<string, unknown>,
): string {
  const panels = Array.isArray(grid.panels) ? grid.panels.map((panel) => record(panel)) : []
  const first = cleanText(panels[0]?.semantic)
  const second = cleanText(panels[1]?.semantic)
  return [
    '用途：历史叙事镜头的 2x1 时间关键帧图；不是海报、不是信息卡片、不是分层素材。',
    `左半幅（动作开始）：${first}`,
    `右半幅（动作结果）：${second}`,
    `故事上下文：${cleanText(storyboard.narration || storyboard.description || storyboard.action)}`,
    `地点与时代：${cleanText(storyboard.location) || '按历史稿件确定'}；${cleanText(storyboard.time) || '按历史稿件确定'}`,
    '两半幅必须是同一场景和人物的连续事件，人物、目标、道具和结果都要可见；左右状态必须明显不同。',
    '电影纪录片写实构图，禁止字幕、标题、Logo、水印、界面、抽象概念、棋盘隐喻、空场景和同姿势重复。',
  ].join('\n')
}

function buildTemporalSheetAsset(
  storyboard: PlannerStoryboard,
  shotNumber: number,
  visualPlan: Record<string, unknown>,
  visualSetupId: string,
): PlannedAsset {
  const grid = record(visualPlan.temporalGrid)
  const sheetAssetKey = cleanText(grid.sheetAssetKey) || `shot-${shotNumber}-temporal-2grid`
  const declaredPath = cleanText(
    grid.localPath
      || grid.sheetLocalPath
      || visualPlan.sheetLocalPath
      || storyboard['temporalSheetPath'],
  )
  const panels = Array.isArray(grid.panels) ? grid.panels.map((panel) => record(panel)) : []
  return {
    shotNumber,
    assetKey: sheetAssetKey,
    assetType: 'ai_image',
    provider: declaredPath ? 'local-reuse' : 'gpt-image-2',
    status: declaredPath ? 'completed' : 'planned',
    prompt: declaredPath ? null : { text: temporalSheetPrompt(storyboard, grid) },
    localPath: declaredPath || null,
    mimeType: declaredPath ? 'image/png' : null,
    metadata: {
      role: 'temporal-2grid-sheet',
      shotNumber,
      visualSetupId,
      reuseKey: `${visualSetupId}-temporal-2grid-sheet`,
      sheetAssetKey,
      layout: '2x1',
      noText: true,
      temporalGrid: {
        schemaVersion: 1,
        sheetAssetKey,
        rows: 1,
        columns: 2,
        panels: panels.map((panel, index) => ({
          index,
          semantic: cleanText(panel.semantic),
          visualProof: cleanText(panel.visualProof),
        })),
      },
    },
  }
}

function buildVisualPlan(
  storyboard: PlannerStoryboard,
  shotNumber: number,
  shotType: PlannedShotType,
  map: Record<string, unknown> | null,
  stock: { item: PlannerStockAsset; kind: string } | null,
  people: string[],
  existing: PlannerExistingShot | undefined,
  durationMs: number,
): Record<string, unknown> {
  const declaredPlan = record(storyboard.visualPlan)
  const visualSetupId = visualSetupIdFor(storyboard, declaredPlan)
  if (isTemporalPlan(declaredPlan)) {
    const temporalGrid = temporalGridFor(storyboard, shotNumber, declaredPlan, durationMs)
    const declaredMotion = record(declaredPlan.motion)
    const declaredCamera = record(declaredPlan.camera)
    const declaredTransition = record(declaredPlan.transition)
    const declaredChannels = Array.isArray(declaredPlan.motionChannels)
      ? declaredPlan.motionChannels.map(cleanText).filter(Boolean)
      : []
    const visualPlan: Record<string, unknown> = {
      schemaVersion: 1,
      visualSetupId,
      assetStrategy: 'temporal-2grid-remotion',
      visualMode: 'temporal-2grid',
      rationale: cleanText(declaredPlan.rationale) || '一张时间关键帧图承担动作开始到结果的连续叙事。',
      temporalGrid,
      layers: [],
      characters: [],
      motion: {
        camera: cleanText(declaredMotion.camera || declaredCamera.preset) || 'drift',
        parallax: 'sheet-crop',
        subject: 'temporal-state-change',
        text: cleanText(declaredMotion.text) || 'state-label-reveal',
        transition: cleanText(declaredMotion.transition || declaredTransition.mode) || 'crossfade',
      },
      motionChannels: [...new Set([
        ...declaredChannels,
        'temporal-keyframe-reveal',
        'ken-burns-camera',
        'shot-transition',
      ])],
      audioCues: Array.isArray(declaredPlan.audioCues) && declaredPlan.audioCues.length
        ? declaredPlan.audioCues
        : ['narration'],
      camera: {
        preset: cleanText(declaredCamera.preset || declaredMotion.camera) || 'drift',
        intensity: Number.isFinite(Number(declaredCamera.intensity)) ? Number(declaredCamera.intensity) : 0.9,
      },
      transition: {
        mode: cleanText(declaredTransition.mode || declaredMotion.transition) || 'crossfade',
        effect: cleanText(declaredTransition.effect) || 'dissolve',
        direction: cleanText(declaredTransition.direction) || 'left',
        frames: Number.isFinite(Number(declaredTransition.frames)) ? Number(declaredTransition.frames) : 10,
      },
      renderContract: {
        renderer: 'remotion-temporal-grid',
        sheetOnly: true,
        forbidRuntimeLayers: true,
        forbidRuntimeCards: true,
        forbidI2V: true,
      },
      fallback: null,
      warnings: [],
    }
    for (const key of ['textOverlay', 'story', 'longShotJustification']) {
      if (declaredPlan[key] !== undefined) visualPlan[key] = declaredPlan[key]
    }
    return visualPlan
  }
  const declaredLayers = Array.isArray(declaredPlan.characters)
    ? declaredPlan.characters
    : Array.isArray(declaredPlan.layers) ? declaredPlan.layers : []
  const layers: Array<Record<string, unknown>> = shotType === 'map' ? [] : declaredLayers.length
    ? declaredLayers.map((rawLayer, index) => {
      const layer = record(rawLayer)
      const name = cleanText(layer.name || layer.person || people[index] || `人物 ${index + 1}`)
      return {
        ...layer,
        id: String(layer.id || slug(name)),
        name,
        assetKey: characterAssetKey(name, shotNumber),
        layerType: 'character-alpha',
        zIndex: Number(layer.zIndex ?? 20 + index),
        depth: Number(layer.depth ?? (index === 0 ? 0.5 : 0.62 + index * 0.08)),
        motionMultiplier: Number(layer.motionMultiplier ?? (index === 0 ? 1 : 0.86)),
        enter: String(layer.enter || (index % 2 === 0 ? 'slide-up-settle' : 'slide-in-settle')),
        requiresAlpha: layer.requiresAlpha !== false,
      }
    })
    : people.map((person, index) => ({
      id: slug(person),
      name: person,
      assetKey: characterAssetKey(person, shotNumber),
      layerType: 'character-alpha',
      zIndex: 20 + index,
      depth: index === 0 ? 0.5 : 0.62 + index * 0.08,
      motionMultiplier: index === 0 ? 1 : 0.86,
      enter: index % 2 === 0 ? 'slide-up-settle' : 'slide-in-settle',
      requiresAlpha: true,
    }))
  const visualPlan: Record<string, unknown> = {
    schemaVersion: 1,
    visualSetupId,
    assetStrategy: 'static-layered-remotion',
    visualMode: shotType === 'map'
      ? map?.mode ? `${String(map.mode)}-map-video` : 'map-video'
      : shotType === 'stock'
        ? 'stock-broll'
        : shotType === 'hybrid'
          ? 'hybrid-composite'
          : people.length
            ? 'layered-composite'
            : 'ai-plate',
    rationale: shotType === 'map'
      ? '地理关系是本镜头的信息主体，使用 Remotion 动态地图视频与路线动画。'
      : stock
        ? people.length
          ? '人物使用独立透明层，素材库视频作为可见 cutaway；Remotion 负责场景、人物、视频与文字动画的层级合成。'
          : '素材库视频承担主画面，Remotion 负责裁切、节奏、转场和文字动画。'
        : people.length
          ? '人物只作为独立透明层生成，场景、人物和文字由 Remotion 分层合成；禁止把整张人物图当作镜头。'
          : '使用无文字 AI clean plate，所有文字由 Remotion 绘制。',
    beats: existingBeats(existing, declaredPlan),
    layerMode: layers.length ? 'alpha-composite' : 'crop',
    layers,
    characters: layers,
    motion: {
      camera: cleanText(record(declaredPlan.motion).camera || declaredPlan.cameraMotion) || 'restrained-push-in',
      parallax: cleanText(record(declaredPlan.motion).parallax) || 'three-depth',
      subject: layers.length
        ? cleanText(record(declaredPlan.motion).subject) || 'staggered-enter-breathe-pose-swap'
        : 'none',
      text: cleanText(record(declaredPlan.motion).text) || 'phrase-reveal',
      transition: cleanText(record(declaredPlan.motion).transition) || 'narrative-cut',
    },
    motionChannels: map
      ? ['camera', 'map-route-reveal', 'text-reveal']
      : layers.length
        ? ['camera', 'parallax', 'subject-pose']
        : shotType === 'stock'
          ? ['stock-crop', 'camera', 'text-reveal']
          : ['camera', 'text-reveal'],
    audioCues: Array.isArray(declaredPlan.audioCues) && declaredPlan.audioCues.length
      ? declaredPlan.audioCues
      : ['narration'],
    composition: layers.length
      ? {
        background: 'scene-plate',
        foreground: layers.map((layer) => layer.assetKey),
        text: 'remotion-text-layer',
        zOrder: ['scene-plate', 'stock-broll', ...layers.map((layer) => layer.assetKey), 'graphics', 'captions'],
      }
      : null,
    fallback: layers.length ? '等待透明人物层时使用 AI clean plate 或素材库 cutaway，不回退为单人物整图' : null,
    warnings: layers.length ? ['人物资产必须通过透明背景/抠图质量检查后才能进入渲染'] : [],
    renderContract: {
      renderer: shotType === 'map' ? 'remotion-map-video' : 'remotion-layered-composite',
      forbidFullFrameCharacter: layers.length > 0,
      forbidMultiCharacterPlate: layers.length > 0,
      visibleStockCutaway: Boolean(stock && people),
    },
  }
  // Keep the semantic contract attached to the shot. The renderer and QC must
  // be able to audit which action/target/state transition the visual serves.
  if (Object.keys(record(declaredPlan.story)).length) visualPlan.story = declaredPlan.story
  if (map) visualPlan.map = {
    renderer: 'remotion-map-video',
    assetRole: 'animated-map-video',
    ...map,
  }
  if (stock && shotType !== 'map') {
    visualPlan.stock = {
      assetKey: `shot-${storyboard.storyboardNumber}-stock-${stock.kind}`,
      query: stock.item.query || null,
      provider: stock.item.provider,
      usage: shotType === 'stock' ? 'primary' : 'cutaway',
      opacity: 1,
      presentation: shotType === 'stock' ? 'full-frame' : 'inset-cutaway',
    }
  }
  return visualPlan
}

export function planRemotionShots(
  storyboards: PlannerStoryboard[],
  existingShots: PlannerExistingShot[] = [],
  stockCatalog: PlannerStockAsset[] = [],
): RemotionPlan {
  const segmentedStoryboards = storyboards.flatMap(segmentStoryboardForRemotion)
  const hasDuplicateNumbers = new Set(segmentedStoryboards.map((storyboard) => storyboard.storyboardNumber)).size
    !== segmentedStoryboards.length
  const requiresRenumbering = hasDuplicateNumbers || segmentedStoryboards.some((storyboard) => (storyboard.segmentIndex || 0) > 0)
  const normalizedStoryboards = requiresRenumbering
    ? segmentedStoryboards.map((storyboard, index) => ({ ...storyboard, storyboardNumber: index + 1 }))
    : segmentedStoryboards
  const existingByNumber = requiresRenumbering
    ? new Map<number, PlannerExistingShot>()
    : new Map(existingShots.map((shot) => [shot.shotNumber, shot]))
  const shots: PlannedShot[] = []
  const assets: PlannedAsset[] = []
  const warnings: string[] = []

  for (const storyboard of normalizedStoryboards) {
    const number = Number(storyboard.storyboardNumber)
    if (!Number.isInteger(number) || number < 1) continue
    const durationMs = Math.max(1, Math.round(Number(storyboard.duration || 1) * 1000))
    if (isHardMaxShotViolation(durationMs)) {
      throw new Error(`镜头 ${number} 时长 ${durationMs}ms 超过硬上限 ${REMOTION_SHOT_RHYTHM.hardMaxShotDurationMs}ms`)
    }
    const text = sourceText(storyboard)
    const declaredPlan = record(storyboard.visualPlan)
    const temporal = isTemporalPlan(declaredPlan)
    const people = isEmptyOfPeople(text) ? [] : peopleIn(storyboard, text)
    const map = temporal ? null : mapSpecFor(storyboard, text)
    const stock = temporal ? null : chooseStock(storyboard, stockCatalog)
    const declaredStory = declaredPlan.story
    if (declaredStory !== undefined) {
      validateStoryContract(declaredStory, declaredPlan)
    }
    // A person is always a foreground layer over a scene plate. Even a
    // single-person narration shot must not become a full-frame portrait.
    // Keep `character` in the public contract for legacy/manual plans, but do
    // not emit it from the producer planner.
    const declaredShotType = ['ai_plate', 'character', 'map', 'stock', 'graphic', 'hybrid'].includes(String(storyboard.shotType))
      ? String(storyboard.shotType) as PlannedShotType
      : null
    const shotType: PlannedShotType = temporal
      ? 'hybrid'
      : map
      ? 'map'
      : declaredShotType === 'graphic'
        ? 'graphic'
        : declaredShotType === 'stock' && !people.length
          ? 'stock'
          : people.length
            ? 'hybrid'
            : declaredShotType && declaredShotType !== 'character'
              ? declaredShotType
              : stock
                ? 'stock'
                : 'ai_plate'

    const visualPlan = buildVisualPlan(storyboard, number, shotType, map, stock, people, existingByNumber.get(number), durationMs)
    const visualSetupId = String(visualPlan.visualSetupId)
    const storyBeatId = declaredStory && typeof declaredStory === 'object' && !Array.isArray(declaredStory)
      ? cleanText(record(declaredStory).beatId)
      : ''
    const beatIds = storyboard.beatIds?.length ? storyboard.beatIds : storyBeatId ? [storyBeatId] : [`beat-${number}`]
    visualPlan.beatIds = beatIds
    const longShotJustification = cleanText(
      record(storyboard.visualPlan).longShotJustification
        || record(storyboard.visualPlan).long_shot_justification,
    )
    if (durationMs > REMOTION_SHOT_RHYTHM.maxShotDurationMs && !longShotJustification) {
      throw new Error(`镜头 ${number} 超过默认上限 ${REMOTION_SHOT_RHYTHM.maxShotDurationMs}ms，必须提供 longShotJustification`)
    }
    const characterLayers = Array.isArray(record(visualPlan).characters)
      ? (record(visualPlan).characters as unknown[]).map((value) => record(value))
      : []
    shots.push({
      shotNumber: number,
      sourceStoryboardId: storyboard.id ?? null,
      title: cleanText(storyboard.title) || `镜头 ${number}`,
      narration: storyboard.narration || null,
      dialogue: storyboard.dialogue || null,
      durationMs,
      shotType,
      visualSetupId: String(visualPlan.visualSetupId),
      visualPlan,
      sourceEvidence: buildSourceEvidence(storyboard),
      beatIds,
    })

    if (temporal) {
      assets.push(buildTemporalSheetAsset(storyboard, number, visualPlan, visualSetupId))
    } else if (shotType === 'map') {
      assets.push({
        shotNumber: number,
        assetKey: `shot-${number}-map-${String((map?.mode as string) || 'route')}`,
        assetType: 'map',
        provider: 'remotion-local-vector-map',
        status: 'completed',
        mimeType: 'application/json',
        license: MAP_SOURCE,
        metadata: { renderer: 'EpisodeShowcase', map, visualSetupId, reuseKey: `${visualSetupId}-map` },
      })
    } else if (shotType === 'stock') {
      if (stock) assets.push(buildAssetForStock(number, stock.item, stock.kind, visualSetupId))
      else warnings.push(`镜头 ${number} 没有匹配到可用素材库视频，需回退为 AI clean plate`)
    } else {
      if (characterLayers.length) {
        assets.push({
          shotNumber: number,
          assetKey: `shot-${number}-scene-plate`,
          assetType: 'ai_image',
          provider: 'gpt-image-2',
          prompt: { text: platePrompt(storyboard, '背景场景层；人物位置留空') },
          metadata: { role: 'background-plate', required: true, noText: true, visualSetupId, reuseKey: `${visualSetupId}-scene-plate` },
        })
        for (const layer of characterLayers) {
          const person = canonicalPerson(cleanText(layer.name) || '人物')
          const assetKey = characterAssetKey(person, number)
          const localPath = LOCAL_CHARACTER_LIBRARY[person]
          assets.push({
            shotNumber: number,
            assetKey,
            assetType: 'character',
            provider: localPath ? 'local-library' : 'gpt-image-2',
            status: localPath ? 'completed' : 'planned',
            prompt: localPath ? null : { text: characterPrompt(person, storyboard) },
            localPath: localPath || null,
            mimeType: localPath ? 'image/png' : null,
            metadata: {
              role: 'character-alpha-layer',
              character: person,
              requiresAlpha: layer.requiresAlpha !== false,
              segmentationModel: 'birefnet-general-lite',
              alphaReady: Boolean(localPath),
              sourceProjectId: localPath ? 2 : null,
              visualSetupId,
              reuseKey: `${visualSetupId}-character-${slug(person)}`,
            },
          })
        }
      } else {
        assets.push({
          shotNumber: number,
          assetKey: `shot-${number}-ai-plate`,
          assetType: 'ai_image',
          provider: 'gpt-image-2',
          prompt: { text: platePrompt(storyboard, '完整背景 clean plate') },
          metadata: { role: 'background-plate', required: true, noText: true, visualSetupId, reuseKey: `${visualSetupId}-scene-plate` },
        })
      }
      if (stock) assets.push(buildAssetForStock(number, stock.item, stock.kind, visualSetupId))
    }
  }

  const shotTypes: Record<PlannedShotType, number> = { ai_plate: 0, character: 0, map: 0, stock: 0, graphic: 0, hybrid: 0 }
  const assetTypes: Record<PlannedAssetType, number> = { ai_image: 0, character: 0, map: 0, stock_video: 0, graphic: 0, audio: 0, font: 0 }
  for (const shot of shots) shotTypes[shot.shotType] += 1
  for (const asset of assets) assetTypes[asset.assetType] += 1

  return { schemaVersion: 1, shots, assets, summary: { shotTypes, assetTypes, warnings } }
}
