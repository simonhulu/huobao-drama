import fs from 'node:fs'
import path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {fileURLToPath, pathToFileURL} from 'node:url'

export type MotionMapForce = {
  id: string; commander?: string; faction: string; flagText: string; color: string; city: string
  routeIndex?: number; action: 'hold' | 'march' | 'attack' | 'occupy' | 'retreat'
  troopKind?: 'infantry' | 'cavalry'; start: number; end: number
}
export type MotionMapInput = {
  title: string
  places: string[]
  routes?: {from: string; to: string; label?: string}[]
  duration: number
  directory: string
  historicalContext?: string
  presentation?: {kind: 'locate' | 'route' | 'encirclement'; target?: string; label?: string; compress?: boolean}
  forces?: MotionMapForce[]
}

// Structurally compatible with HistoryMotionFactory's map input; preparation evidence is retained for delivery.
export type HistoryMotionMap = {
  enabled: boolean; backgroundSrc: string; width: number; height: number; title?: string
  provenance: {
    verified: boolean; source: string; license: string; projection: string
    historyStatus: 'illustrative' | 'sourced'; attribution: string
    bounds?: {minLon: number; maxLon: number; minLat: number; maxLat: number}
    crs?: string; manifestPath?: string; sources?: Record<string, unknown>[]
  }
  cities?: {name: string; x: number; y: number; role?: 'primary' | 'context'; kind?: 'capital' | 'city' | 'pass' | 'battlefield'; color?: string; highlightStart?: number; highlightDuration?: number}[]
  cartography?: {version: 1; style: 'relief-atlas'}
  geographicLabels?: {id: string; text: string; kind: 'mountain' | 'river' | 'region' | 'lake'; x: number; y: number; angle?: number; priority?: number; waterwayId?: string}[]
  waterways?: {id: string; name?: string; points: [number, number][]; rank?: 1 | 2 | 3}[]
  waterAreas?: {id: string; kind: 'ocean' | 'lake'; rings: [number, number][][]}[]
  routes?: {name?: string; points: [number, number][]; color: string; start?: number; end?: number}[]
  territories?: {name: string; points: [number, number][]; initialPoints?: [number, number][]; color: string; from?: number; to?: number}[]
  camera?: {keyframes: {t: number; focusX: number; focusY: number; zoom: number}[]}
  stages?: {start: number; end: number; label: string}[]
  legend?: {label: string; color: string; kind?: 'line' | 'area' | 'point'}[]
  encirclement?: {center: [number, number]; radiusX: number; radiusY: number; start: number; end: number;
    compressionStart?: number; compressionEnd?: number; innerScale?: number; color: string; fillColor: string; label: string}
  forces?: (MotionMapForce & {portraitSrc?: string; portraitSha256?: string})[]
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const backgroundSrc = path.join(root,'remotion/public/changping-demo-v2/terrain.png')
const project = (lon: number, lat: number): [number,number] => [(lon-107.5)/(116.3-107.5),(37.5-lat)/(37.5-33.6)]
const city = (name: string,lon: number,lat: number) => {const [x,y]=project(lon,lat);return {name,x,y}}
export const motionMapCatalog = [{id:'changping-context',description:'仅用于前262—前260年长平之战：上党、长平、邯郸的地理关系；真实现代地形，历史地名锚点，战区位置示意。'}]
export function getMotionMapPack(id: string, narration: string): HistoryMotionMap {
  if (id !== 'changping-context') throw Error('地图包尚未准备好，需要核实坐标和地图数据')
  if (!/长平/.test(narration)) throw Error('长平地图与本段叙事不匹配，需要准备对应地区的地图')
  if (!fs.existsSync(backgroundSrc)) throw Error('长平真实地形缓存缺失')
  return {enabled:true,backgroundSrc,width:3840,height:1504,title:'长平与上党',
    provenance:{verified:true,source:'https://registry.opendata.aws/terrain-tiles/',license:'Mapzen terrain / USGS SRTM & GMTED2010; Natural Earth public domain',projection:'Equirectangular; bounds 107.5,33.6,116.3,37.5',historyStatus:'illustrative',
      attribution:'地形：Mapzen / USGS；城市锚点与历史背景见长平地图资料。现代地形参照，战区位置示意。'},
    cities:[city('长平（今高平）',112.923,35.798),city('上党（今长治）',113.117,36.195),city('邯郸',114.49,36.61)],
    routes:[],territories:[]}
}

/** Programmatic relative geometry describes a concept, never a historical boundary. */
export function createMapPresentation(input: MotionMapInput, cities: NonNullable<HistoryMotionMap['cities']>, routes: NonNullable<HistoryMotionMap['routes']>): Pick<HistoryMotionMap, 'camera' | 'stages' | 'legend' | 'encirclement'> {
  const duration = input.duration
  const kind = input.presentation?.kind ?? (routes.length ? 'route' : 'locate')
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s/g, '').replace(/[市县区]$/, '')
  const primary = cities.filter(city => city.role !== 'context')
  const target = primary.find(city => input.presentation?.target && normalize(city.name) === normalize(input.presentation.target)) ?? primary[0]
  if (!target) throw Error('地图动画缺少已核实的主要地点')
  const focus = kind === 'route' ? {x: .5, y: .5} : target
  const camera = {keyframes: [
    {t: 0, focusX: .5, focusY: .5, zoom: 1},
    {t: duration * .24, focusX: focus.x, focusY: focus.y, zoom: 1.04},
    {t: duration * .82, focusX: focus.x, focusY: focus.y, zoom: 1.10},
  ]}
  if (kind !== 'encirclement') {
    return {camera, stages: [
      {start: 0, end: duration * .24, label: kind === 'route' ? '建立起终点' : `${target.name} · 地理位置`},
      {start: duration * .24, end: duration, label: input.presentation?.label || (kind === 'route' ? '行进路线（示意）' : '现代地形位置参照')},
    ], legend: kind === 'route' ? routes.slice(0, 3).map(route => ({label: route.name || '路线示意', color: route.color, kind: 'line' as const}))
      : [{label: target.name, color: '#a54232', kind: 'point'}]}
  }
  // A 5-second shot has time to establish, build and hold. Only an explicitly
  // requested longer shot adds a second movement (compression).
  const compress = input.presentation?.compress === true && duration >= 8
  const start = duration * .22, end = duration * (compress ? .48 : .72)
  const rawLabel = input.presentation?.label || '外围部署'
  const label = /示意/.test(rawLabel) ? rawLabel : `${rawLabel}（示意）`
  const encirclement: NonNullable<HistoryMotionMap['encirclement']> = {
    center: [target.x, target.y], radiusX: Math.min(.235, target.x - .055, .945 - target.x),
    radiusY: Math.min(.30, target.y - .12, .86 - target.y),
    start, end, color: '#365b7b', fillColor: '#b85b4f', label,
    ...(compress ? {compressionStart: duration * .55, compressionEnd: duration * .82, innerScale: .62} : {}),
  }
  const stages: NonNullable<HistoryMotionMap['stages']> = [
    {start: 0, end: start, label: `${target.name} · 地理位置`},
    {start, end: compress ? duration * .55 : duration * .76, label},
    ...(compress ? [{start: duration * .55, end: duration * .82, label: '活动空间收拢（示意）'}] : []),
    {start: duration * (compress ? .82 : .76), end: duration, label: compress ? '收拢后的态势（示意）' : '外围部署态势（示意）'},
  ]
  return {camera, stages, encirclement, legend: [
    {label: target.name, color: '#a54232', kind: 'point'},
    {label: '外围部署（示意）', color: encirclement.color, kind: 'line'},
    {label: '活动空间（示意）', color: encirclement.fillColor, kind: 'area'},
  ]}
}

export function prepareMapForces(input: MotionMapInput, cities: NonNullable<HistoryMotionMap['cities']>, routes: NonNullable<HistoryMotionMap['routes']>): MotionMapForce[] | undefined {
  if (!input.forces?.length) return undefined
  if (input.forces.length > 8) throw Error('每镜地图最多八支军队标记')
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s/gu, '')
  const ids = new Set<string>(), routeTimes = new Map<number, {start: number; end: number}>()
  return input.forces.map(force => {
    if (!force.id || ids.has(force.id)) throw Error('军队标识不能为空或重复')
    ids.add(force.id)
    if (!Number.isFinite(force.start) || !Number.isFinite(force.end) || force.start < 0 || force.end <= force.start || force.end > input.duration) throw Error('军队动作时间必须在镜头时长内')
    const anchor = cities.find(city => city.role !== 'context' && normalize(city.name) === normalize(force.city))
    if (!anchor || !input.places.some(place => normalize(place) === normalize(force.city))) throw Error(`军队锚点缺少已核实地点：${force.city}`)
    if (force.routeIndex === undefined) {
      if (force.action === 'march' || force.action === 'retreat' || (force.action === 'attack' && input.presentation?.kind !== 'encirclement')) throw Error('行军、撤退和进攻缺少路线')
    } else {
      const route = routes[force.routeIndex], namedRoute = input.routes?.[force.routeIndex]
      if (!Number.isInteger(force.routeIndex) || !route || !namedRoute) throw Error('军队路线引用不存在')
      if (force.action === 'hold') throw Error('驻守动作不能附带行军路线')
      if (normalize(namedRoute.to) !== normalize(anchor.name)) throw Error('军队锚点与路线终点不一致')
      const endpoint = route.points.at(-1)
      if (!endpoint || Math.abs(endpoint[0] - anchor.x) > .000001 || Math.abs(endpoint[1] - anchor.y) > .000001) throw Error('军队路线终点与地图城市投影不一致')
      const timing = routeTimes.get(force.routeIndex)
      if (timing && (timing.start !== force.start || timing.end !== force.end)) throw Error('同一路线的军队动作时间必须一致')
      routeTimes.set(force.routeIndex, force)
      route.start = force.start
      route.end = force.end
      route.color = force.color
    }
    return {...force, city: anchor.name}
  })
}

export async function prepareMotionMap(input: MotionMapInput): Promise<HistoryMotionMap> {
  const helper = await import(pathToFileURL(path.join(root, 'scripts/history-motion/map-data.mjs')).href)
  const prepared = await helper.prepareMapData(input)
  const geographyHelper = await import(pathToFileURL(path.join(root, 'scripts/history-motion/map-geography.mjs')).href)
  const geography = await geographyHelper.prepareMapGeography({bounds: prepared.bounds, width: prepared.width, height: prepared.height, context: input.historicalContext})
  const sources = [...prepared.sources, ...(geography.sources || [])]
  const cartography = {version: 1 as const, style: 'relief-atlas' as const}
  const forces = prepareMapForces(input, prepared.cities, prepared.routes)
  const presentation = createMapPresentation(input, prepared.cities, prepared.routes)
  const manifest = JSON.parse(fs.readFileSync(prepared.manifestPath, 'utf8'))
  const animationKey = createHash('sha256').update(JSON.stringify({presentation, forces, routes: prepared.routes, cartography,
    geographicLabels: geography.geographicLabels, waterways: geography.waterways, waterAreas: geography.waterAreas})).digest('hex').slice(0, 24)
  const manifestPath = path.join(path.dirname(prepared.manifestPath), `animation-${animationKey}.json`)
  const temporary = `${manifestPath}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({...manifest,
      geographicManifestPath: prepared.manifestPath, motionRoutes: prepared.routes, sources, cartography,
      geographicLabels: geography.geographicLabels, waterways: geography.waterways, waterAreas: geography.waterAreas,
      geographicHistoricalLimit: geography.historicalLimit,
      animation: {...presentation, ...(forces ? {forces, routes: prepared.routes} : {})},
      animationEvidence: {basis: 'Narration-selected relative relation; programmatic viewport geometry',
        historicalBoundary: false, exactTroopPositions: false,
        ...(forces ? {forces: {basis: 'Narration-selected commander, faction and action; city anchors share the sourced map projection',
          representation: 'Symbolic army markers, not troop counts or exact positions', ownershipAction: 'occupy',
          actions: forces.map(({id, commander, faction, city, action, start, end, routeIndex}) => ({id, commander, faction, city, action, start, end, routeIndex}))}} : {})}}, null, 2)}\n`)
    fs.renameSync(temporary, manifestPath)
  } finally { fs.rmSync(temporary, {force: true}) }
  return {
    enabled: true, backgroundSrc: prepared.backgroundPath,
    width: prepared.width, height: prepared.height, title: prepared.title,
    provenance: {
      verified: true,
      source: sources.map((source: {url: string}) => source.url).join(' ; '),
      license: [...new Set(sources.map((source: {license: string}) => source.license))].join(' ; '),
      projection: prepared.projection, crs: 'EPSG:4326', bounds: prepared.bounds,
      historyStatus: 'illustrative', attribution: [prepared.attribution, ...sources.map((source: {attribution?: string}) => source.attribution), geography.historicalLimit].filter(Boolean).join(' ; '),
      sources, manifestPath,
    },
    cities: prepared.cities.map((city: NonNullable<HistoryMotionMap['cities']>[number]) => ({...city,
      color: city.role === 'context' || forces?.length ? '#53645a' : '#a54232',
      ...(city.role === 'context' ? {} : {highlightStart: input.duration * .08, highlightDuration: input.duration * .19})})),
    cartography, geographicLabels: geography.geographicLabels, waterways: geography.waterways, waterAreas: geography.waterAreas,
    routes: prepared.routes, territories: [], ...presentation, ...(forces ? {forces} : {}),
  }
}
