import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import puppeteer from 'puppeteer-core'
import sharp from 'sharp'
import { resolveNbaCoverTeams, type NbaCoverTeam } from './nba-cover-players.js'
import type { NbaBodyCrop } from './nba-cover-body.js'
import { NBA_COVER_MAX_PHOTO_UPSCALE, nbaCoverPhotoDisplay, prepareNbaCoverPhoto } from './nba-cover-photo.js'
import type { NbaArticle, NbaGame } from './nba-types.js'

export const NBA_COVER_POSTER_STYLE = 'nba-action-poster-v2'
const LAYOUT_REVISION = 4
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const formats = [
  { key: 'landscape', width: 1920, height: 1080 },
  { key: 'portrait', width: 1080, height: 1440 },
] as const
type Format = typeof formats[number]
interface PosterTeam extends NbaCoverTeam { photoDataUrl?: string; photoSize?: { width: number; height: number } }
export interface NbaPosterDesign {
  headline: string
  date: string
  home: PosterTeam & { score: number }
  away: PosterTeam & { score: number }
}
export interface NbaPosterInput {
  game: NbaGame
  article?: Pick<NbaArticle, 'title' | 'body'>
  headline: string
  directory: string
  signal: AbortSignal
  recentPhotoSha256s?: string[]
}
export interface NbaPosterEvidence {
  version: 1
  method: typeof NBA_COVER_POSTER_STYLE
  inputHash: string
  gameId: string
  headline: string
  date: string
  teams: Array<{ abbreviation: string; name: string; score: number; player?: {
    id: string; name: string; sourceUrl?: string; photoSha256?: string; width?: number; height?: number
    photoKind: 'body'; framing?: string; cleanedRegions?: number
    selectionReason?: string; recentlyUsedPhoto?: boolean
    crop?: { x: number; y: number; width: number; height: number }
    quality?: { effectiveWidth: number; effectiveHeight: number; cropOmittedForResolution: boolean; maximumUpscale: number;
      display: { landscape: { width: number; height: number; scale: number }; portrait: { width: number; height: number; scale: number } } }
  } }>
  composition: 'players' | 'mixed' | 'team-names'
  portraitTreatment: 'real-body-crop'
  outputs: Record<Format['key'], { width: number; height: number; format: 'png'; sha256: string }>
}
export interface NbaPosterResult { path: string; portraitPath: string; evidence: NbaPosterEvidence }
export interface NbaPosterOptions {
  resolveTeams?: typeof resolveNbaCoverTeams
  render?: (design: NbaPosterDesign, signal: AbortSignal) => Promise<{ landscape: Buffer; portrait: Buffer }>
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

/** All text is escaped and every photograph is embedded; the renderer makes no page requests. */
export function buildNbaPosterHtml(design: NbaPosterDesign, format: Format): string {
  const portrait = format.key === 'portrait'
  const team = (value: PosterTeam, side: 'home' | 'away') => {
    const color = /^#[\da-f]{6}$/i.test(value.color) ? value.color : '#f0f064'
    const photograph = value.photoDataUrl && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.photoDataUrl)
    const size = value.photoSize
    const display = size && [size.width, size.height].every(value => Number.isFinite(value) && value > 0 && value <= 4096)
      ? nbaCoverPhotoDisplay(size.width, size.height, portrait) : undefined
    return `<div class="person ${side}" style="--team-color:${color}">${photograph
      ? `<img src="${value.photoDataUrl}"${display ? ` style="width:${display.width}px;height:${display.height}px"` : ''} alt="${escapeHtml(value.player?.name || value.name)}" />`
      : `<div class="team-type" data-fit="72">${escapeHtml(value.name)}</div>`}<div class="team-line"></div></div>`
  }
  const clauses = design.headline.split(/[，,]/u)
  const headline = clauses.length > 1 ? `<span>${escapeHtml(clauses.shift()!)}</span><span class="secondary">${escapeHtml(clauses.join('，'))}</span>` : `<span>${escapeHtml(design.headline)}</span>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${format.width}px;height:${format.height}px;overflow:hidden}
body{background:#101012;color:#fff;font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-weight:900;letter-spacing:0}
.stage{position:absolute;left:28px;right:28px;top:28px;height:784px}
.person{position:absolute;bottom:0;width:700px;height:784px;overflow:hidden}
.person.home{left:0}.person.away{right:0}
.person img{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:100%;height:100%;object-fit:contain;object-position:center bottom;mask-image:linear-gradient(#000 0%,#000 96%,transparent 100%)}
.team-line{position:absolute;bottom:0;width:80%;height:9px;background:var(--team-color)}.home .team-line{left:10%}.away .team-line{right:10%}
.team-type{position:absolute;inset:65px 22px 50px;display:flex;align-items:center;justify-content:center;font-size:190px;line-height:1.12;text-align:center;overflow-wrap:anywhere}
.match{position:absolute;left:710px;right:710px;top:0;bottom:20px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
.names{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%}.name{width:100%;font-size:92px;line-height:1.4;overflow-wrap:anywhere}
.vs{font:italic 900 38px Arial,sans-serif;color:#f0f064}.score{font:900 86px Arial,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap}.score i{font-style:normal;color:#72726f;font-size:48px;margin:0 8px}
.date{font-size:27px;color:#dededb;white-space:nowrap}
.headline{position:absolute;left:64px;right:64px;top:800px;height:250px;border-top:5px solid #f0f064;padding-top:28px;display:flex;flex-direction:column;justify-content:center;gap:4px}
.headline-copy{font-size:88px;line-height:1.2;overflow-wrap:anywhere}.headline-copy span{display:block;color:#f0f064;text-wrap:balance}.headline-copy .secondary{color:#fff}
${portrait ? `.stage{left:14px;right:14px;top:28px;height:1000px}.person{width:520px;height:720px}.person.home{left:0}.person.away{right:0}
.match{left:35px;right:35px;top:0;bottom:auto;height:260px;gap:8px}.names{flex-direction:row;gap:20px}.name{font-size:76px}.vs{font-size:33px}.score{font-size:90px}.score i{font-size:52px;margin:0 24px}.date{font-size:24px}
.team-type{inset:55px 15px 40px;font-size:148px}.headline{left:54px;right:54px;top:1060px;height:316px;padding-top:30px}.headline-copy{font-size:84px;line-height:1.22}` : ''}
</style></head><body>
<div class="stage">${team(design.home, 'home')}${team(design.away, 'away')}<div class="match"><div class="names"><div class="name" data-fit="34">${escapeHtml(design.home.name)}</div><div class="vs">VS</div><div class="name" data-fit="34">${escapeHtml(design.away.name)}</div></div><div class="score">${design.home.score}<i>:</i>${design.away.score}</div><div class="date">NBA · ${escapeHtml(design.date.replaceAll('-', '.'))}</div></div></div>
<div class="headline"><div class="headline-copy" data-fit="34">${headline}</div></div></body></html>`
}

async function chromeExecutable() {
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH,
    fileURLToPath(new URL('../../../.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell', import.meta.url)),
    fileURLToPath(new URL('../../../.remotion-chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell', import.meta.url)),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  for (const file of candidates) if (file && await fs.stat(file).then(stat => stat.isFile()).catch(() => false)) return file
  throw new Error('NBA 封面排版需要可用的 Chrome，请检查 PUPPETEER_EXECUTABLE_PATH')
}

export async function renderNbaPoster(design: NbaPosterDesign, signal: AbortSignal) {
  signal.throwIfAborted()
  const browser = await puppeteer.launch({ executablePath: await chromeExecutable(), headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const abort = () => { void browser.close().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const page = await browser.newPage(), result = {} as Record<Format['key'], Buffer>
    await page.setRequestInterception(true)
    page.on('request', request => { void (/^(data:|about:)/.test(request.url()) ? request.continue() : request.abort()) })
    for (const format of formats) {
      signal.throwIfAborted()
      await page.setViewport({ width: format.width, height: format.height, deviceScaleFactor: 1 })
      await page.setContent(buildNbaPosterHtml(design, format), { waitUntil: 'load', timeout: 30000 })
      await page.evaluate(() => document.fonts.ready)
      await page.evaluate(async () => {
        await Promise.all([...document.images].map(image => image.decode()))
        for (const element of document.querySelectorAll<HTMLElement>('[data-fit]')) {
          const headline = element.classList.contains('headline-copy')
          let size = parseFloat(getComputedStyle(element).fontSize)
          let fits = false
          while (size >= Number(element.dataset.fit)) {
            fits = element.scrollWidth <= element.clientWidth + 1 && (headline
              ? element.getBoundingClientRect().height <= element.parentElement!.clientHeight - parseFloat(getComputedStyle(element.parentElement!).paddingTop) - 5
              : element.scrollHeight <= element.clientHeight + 1)
            if (fits) break
            size -= 2; element.style.fontSize = `${size}px`
          }
          if (!fits) throw new Error('NBA 封面文字超出安全区')
        }
      })
      result[format.key] = Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: format.width, height: format.height } }))
    }
    signal.throwIfAborted()
    return result
  } catch (error) { signal.throwIfAborted(); throw error }
  finally { signal.removeEventListener('abort', abort); await browser.close().catch(() => {}) }
}

async function portraitTeam(team: NbaCoverTeam) {
  let photoDataUrl: string | undefined, photoSize: { width: number; height: number } | undefined
  let photograph: { sha256: string; width: number; height: number; crop?: NbaBodyCrop;
    quality: NonNullable<NonNullable<NbaPosterEvidence['teams'][number]['player']>['quality']> } | undefined
  if (team.player?.photoPath && team.player.photoKind === 'body') try {
    const data = await fs.readFile(team.player.photoPath), metadata = await sharp(data).metadata()
    if (team.player.photoSha256 && hash(data) !== team.player.photoSha256) throw new Error('Changed portrait')
    if (!metadata.width || !metadata.height) throw new Error('Invalid portrait')
    const photo = await prepareNbaCoverPhoto(data, team.player.photoCrop)
    photoSize = { width: photo.width, height: photo.height }
    photoDataUrl = `data:image/png;base64,${photo.bytes.toString('base64')}`
    photograph = { sha256: hash(data), width: metadata.width, height: metadata.height, crop: photo.crop,
      quality: { effectiveWidth: photo.width, effectiveHeight: photo.height, cropOmittedForResolution: photo.cropOmittedForResolution,
        maximumUpscale: NBA_COVER_MAX_PHOTO_UPSCALE, display: { landscape: nbaCoverPhotoDisplay(photo.width, photo.height),
          portrait: nbaCoverPhotoDisplay(photo.width, photo.height, true) } } }
  } catch { /* A failed image uses the team name and never blocks production. */ }
  return { team: { ...team, photoDataUrl, photoSize }, photograph }
}

async function writeAtomic(file: string, value: Buffer | string) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temporary, value); await fs.rename(temporary, file) }
  finally { await fs.unlink(temporary).catch(() => {}) }
}

export async function prepareNbaPoster(input: NbaPosterInput, options: NbaPosterOptions = {}): Promise<NbaPosterResult> {
  input.signal.throwIfAborted()
  const headline = input.headline.replace(/\s+/g, ' ').trim(), { game } = input
  if (!game.verified || !game.home.name || !game.away.name || !/^\d{4}-\d{2}-\d{2}$/.test(game.localDate)
    || ![game.home.score, game.away.score].every(score => Number.isInteger(score) && score >= 0) || !headline || headline.length > 120) {
    throw new Error('NBA 对阵封面需要比赛双方、日期、终场比分和当前中文标题')
  }
  await fs.mkdir(input.directory, { recursive: true })
  const resolved = await (options.resolveTeams || (value => resolveNbaCoverTeams(value, { photoMode: 'body' })))({ ...input, headline })
  input.signal.throwIfAborted()
  const home = await portraitTeam(resolved.home), away = await portraitTeam(resolved.away)
  const design: NbaPosterDesign = { headline, date: game.localDate,
    home: { ...home.team, score: game.home.score }, away: { ...away.team, score: game.away.score } }
  const teams = ([['home', home], ['away', away]] as const).map(([side, value]) => ({
    abbreviation: value.team.abbreviation, name: value.team.name, score: game[side].score,
    ...(value.team.player && value.photograph ? { player: { id: value.team.player.id, name: value.team.player.name,
      sourceUrl: value.team.player.sourceUrl, photoSha256: value.photograph.sha256, width: value.photograph.width, height: value.photograph.height,
      ...(value.team.player.selectionReason ? { selectionReason: value.team.player.selectionReason } : {}),
      recentlyUsedPhoto: Boolean(input.recentPhotoSha256s?.includes(value.photograph.sha256)),
      photoKind: 'body' as const, framing: typeof value.team.player.photoVerification?.framing === 'string' ? value.team.player.photoVerification.framing : undefined,
      ...(value.photograph.crop ? { crop: value.photograph.crop } : {}), quality: value.photograph.quality,
      cleanedRegions: typeof value.team.player.photoVerification?.cleanedRegions === 'number' ? value.team.player.photoVerification.cleanedRegions : undefined } } : {}),
  }))
  const inputHash = hash(JSON.stringify([NBA_COVER_POSTER_STYLE, LAYOUT_REVISION, game.id, game.localDate, headline, teams,
    home.team.color, away.team.color]))
  const prefix = path.join(input.directory, `cover-${inputHash.slice(0, 16)}-poster-v2`)
  const paths = { landscape: `${prefix}-landscape.png`, portrait: `${prefix}-portrait.png` }, evidencePath = `${prefix}.json`
  try {
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8')) as NbaPosterEvidence
    if (evidence.method !== NBA_COVER_POSTER_STYLE || evidence.inputHash !== inputHash) throw new Error('Changed design')
    for (const format of formats) {
      const data = await fs.readFile(paths[format.key]), image = await sharp(data).metadata()
      if (image.width !== format.width || image.height !== format.height || image.format !== 'png'
        || hash(data) !== evidence.outputs[format.key].sha256) throw new Error('Changed cover')
    }
    input.signal.throwIfAborted()
    return { path: paths.landscape, portraitPath: paths.portrait, evidence }
  } catch { input.signal.throwIfAborted() }
  const images = await (options.render || renderNbaPoster)(design, input.signal)
  const output = {} as NbaPosterEvidence['outputs']
  for (const format of formats) {
    input.signal.throwIfAborted()
    const data = images[format.key], image = await sharp(data).metadata()
    if (image.width !== format.width || image.height !== format.height || image.format !== 'png') throw new Error('NBA 海报渲染尺寸不正确')
    output[format.key] = { width: format.width, height: format.height, format: 'png', sha256: hash(data) }
    await writeAtomic(paths[format.key], data)
  }
  const count = teams.filter(team => team.player).length
  const evidence: NbaPosterEvidence = { version: 1, method: NBA_COVER_POSTER_STYLE, inputHash, gameId: game.id, headline, date: game.localDate,
    teams, composition: count === 2 ? 'players' : count === 1 ? 'mixed' : 'team-names', portraitTreatment: 'real-body-crop', outputs: output }
  input.signal.throwIfAborted()
  await writeAtomic(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  return { path: paths.landscape, portraitPath: paths.portrait, evidence }
}
