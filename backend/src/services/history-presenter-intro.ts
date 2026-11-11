import {execFile} from 'node:child_process'
import {createHash, randomInt, randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {acquireNbaJobLock, NbaJobLockBusyError} from './nba-job-lock.js'
import {prepareScienceMusetalkVideo} from './science-musetalk-video.js'
import {prepareScienceVideoWithIntro} from './science-video-intro.js'

const exec = promisify(execFile)
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export interface HistoryPresenterPolicy {version: 1; libraryPath: string; character: 'history'; presenter: 'xiaoba'}
export interface HistoryPresenterIntroSelection {
  version: 1; character: 'history'; presenter: 'xiaoba'; fingerprint: string
  videoPath: string; videoSha256: string; avatarId: string; referenceSha256: string; selectedAt: string
}
interface Media {duration: number; width: number; height: number; fps: number; frames: number}
interface Presenter {presenterPath: string; sourceSha256: string}
export interface HistoryPresenterRuntime {
  presenter: (input: {videoPath: string; directory: string}, options: {signal: AbortSignal; report?: (message: string) => void; avatarId: string; referenceSha256: string}) => Promise<Presenter>
  compose: typeof prepareScienceVideoWithIntro
  probe: (filename: string, signal: AbortSignal) => Promise<Media>
}
export interface HistoryPresenterOptions {signal: AbortSignal; report?: (message: string) => void; runtime?: Partial<HistoryPresenterRuntime>}

/** Snapshot before rendering; old completed/rendered tasks keep their existing edition. */
export function historyPresenterPolicyFromEnv(): HistoryPresenterPolicy | undefined {
  const enabled = process.env.HISTORY_PRESENTER_ENABLED?.trim()
  if (!enabled || ['0', 'false'].includes(enabled)) return undefined
  if (!['1', 'true'].includes(enabled)) throw Error('HISTORY_PRESENTER_ENABLED 必须为 1 或 0')
  const libraryPath = process.env.HISTORY_PRESENTER_LIBRARY_PATH?.trim()
  if (!libraryPath || !path.isAbsolute(libraryPath)) throw Error('历史小疤主播已启用，但尚未配置绝对路径 HISTORY_PRESENTER_LIBRARY_PATH')
  return {version: 1, libraryPath: path.resolve(libraryPath), character: 'history', presenter: 'xiaoba'}
}

async function hashFile(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const info = await fs.stat(filename)
  if (!info.isFile() || !info.size) throw Error('历史主播媒体不存在或为空')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename, {signal})) hash.update(chunk)
  return hash.digest('hex')
}
async function readOptional(filename: string) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
async function save(filename: string, value: unknown) {
  const temporary = `${filename}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync() }
  finally { await handle.close() }
  try { await fs.rename(temporary, filename) }
  finally { await fs.rm(temporary, {force: true}) }
}
async function selectionLock(filename: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { return acquireNbaJobLock(filename) }
    catch (error) {
      if (!(error instanceof NbaJobLockBusyError)) throw error
      if (attempt >= 100) throw Error('历史片头选择暂时繁忙，请继续原任务')
      await delay(100, undefined, {signal})
    }
  }
}
function sameSelection(left: HistoryPresenterIntroSelection, right: HistoryPresenterIntroSelection) {
  return ['version', 'character', 'presenter', 'fingerprint', 'videoPath', 'videoSha256', 'avatarId', 'referenceSha256']
    .every(key => (left as any)?.[key] === (right as any)?.[key])
}

/** Local mirror of accepted factory clips; generated/unreviewed entries never enter the pool. */
export async function selectHistoryPresenterIntro(input: {libraryPath: string; directory: string}, options: {signal: AbortSignal}): Promise<HistoryPresenterIntroSelection> {
  const libraryPath = path.resolve(input.libraryPath), directory = path.resolve(input.directory)
  await fs.mkdir(directory, {recursive: true})
  const release = await selectionLock(`${libraryPath}.selection.lock`, options.signal)
  try {
    const library = await readOptional(libraryPath)
    if (library?.version !== 1 || library.character !== 'history' || library.presenter !== 'xiaoba' || !Array.isArray(library.clips)) {
      throw Error('历史片头库缺失或身份无效，须配置已审核的小疤历史片头镜像')
    }
    const choices: HistoryPresenterIntroSelection[] = []
    for (const entry of library.clips) {
      if (entry.status !== 'ready' || entry.character !== 'history' || entry.presenter !== 'xiaoba') continue
      if (!validHash(entry.fingerprint) || !validHash(entry.videoSha256) || !validHash(entry.referenceSha256)
        || typeof entry.videoPath !== 'string' || !path.isAbsolute(entry.videoPath)
        || typeof entry.avatarId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.avatarId)
        || !/^xiaoba[-_]/.test(entry.avatarId)) throw Error('已审核历史片头缺少合法的小疤头像绑定或媒体指纹')
      if (choices.some(choice => choice.fingerprint === entry.fingerprint)) throw Error('历史片头库含重复的片头指纹')
      choices.push({version: 1, character: 'history', presenter: 'xiaoba', fingerprint: entry.fingerprint,
        videoPath: path.resolve(entry.videoPath), videoSha256: entry.videoSha256, avatarId: entry.avatarId,
        referenceSha256: entry.referenceSha256, selectedAt: ''})
    }
    const selectionFile = path.join(directory, 'history-presenter-selection.json')
    const previous = await readOptional(selectionFile)
    if (previous) {
      const reviewed = choices.find(choice => choice.fingerprint === previous.fingerprint)
      if (!reviewed || !sameSelection(previous, reviewed) || typeof previous.selectedAt !== 'string') throw Error('原任务的历史片头已撤回或身份绑定已改变，请恢复原审核素材')
      if (await hashFile(reviewed.videoPath, options.signal) !== reviewed.videoSha256) throw Error('原任务的小疤历史片头已变化，请恢复原审核素材')
      return previous
    }
    if (!choices.length) throw Error('历史小疤尚无已审核 ready 片头或头像，请完成审核后继续原任务')
    for (const choice of choices) {
      if (await hashFile(choice.videoPath, options.signal) !== choice.videoSha256) throw Error('历史片头库中的已审核视频已变化，不能自动替换或继续交付')
    }
    const stateFile = `${libraryPath}.selection-state.json`, state = await readOptional(stateFile)
    const alternatives = choices.filter(choice => choice.fingerprint !== state?.history)
    const eligible = alternatives.length ? alternatives : choices
    const selected = {...eligible[randomInt(eligible.length)]!, selectedAt: new Date().toISOString()}
    options.signal.throwIfAborted()
    await save(selectionFile, selected)
    await save(stateFile, {version: 1, history: selected.fingerprint})
    return selected
  } finally { release() }
}

async function probe(filename: string, signal: AbortSignal): Promise<Media> {
  const {stdout} = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], {signal, timeout: 60_000})
  const metadata = JSON.parse(stdout), video = metadata.streams?.find((stream: any) => stream.codec_type === 'video')
  const duration = Number(video?.duration ?? metadata.format?.duration)
  const [n, d = 1] = String(video?.avg_frame_rate || '').split('/').map(Number), fps = n! / d
  if (!video || !metadata.streams.some((stream: any) => stream.codec_type === 'audio') || !(Number.isFinite(duration) && duration > 0 && fps >= 1 && fps <= 120 && video.width > 0 && video.height > 0)) {
    throw Error('历史主播合成媒体缺少完整视频、音轨或有效时长')
  }
  return {duration, width: video.width, height: video.height, fps, frames: Number(video.nb_frames) || Math.round(duration * fps)}
}

export async function prepareHistoryPresenterIntro(input: {videoPath: string; directory: string; libraryPath: string; report: Record<string, any>}, options: HistoryPresenterOptions): Promise<{outputPath: string; report: Record<string, any>}> {
  const {signal} = options
  signal.throwIfAborted()
  const directory = path.resolve(input.directory), source = path.resolve(input.videoPath)
  await fs.mkdir(directory, {recursive: true})
  let release: () => void
  try { release = acquireNbaJobLock(path.join(directory, '.history-presenter.lock')) }
  catch (error) { if (error instanceof NbaJobLockBusyError) throw Error('历史小疤主播暂时正在处理中，请继续原任务'); throw error }
  try {
    const sourceSha256 = await hashFile(source, signal)
    if (input.report?.qa?.technical !== 'passed' || input.report.sha256 !== sourceSha256) throw Error('历史正文母片与技术报告不一致，不能生成或交付主播成片')
    const selection = await selectHistoryPresenterIntro(input, {signal})
    const runtime: HistoryPresenterRuntime = {presenter: prepareScienceMusetalkVideo, compose: prepareScienceVideoWithIntro, probe, ...options.runtime}
    const [main, intro] = await Promise.all([runtime.probe(source, signal), runtime.probe(selection.videoPath, signal)])
    if (!Number.isFinite(intro.duration) || intro.duration <= 0 || intro.width * 9 !== intro.height * 16) throw Error('历史小疤片头必须为有效时长、含原声的横屏 16:9 视频，请审核合格素材后继续原任务')
    const binding = createHash('sha256').update(JSON.stringify([1, sourceSha256, selection.fingerprint, selection.videoSha256, selection.avatarId, selection.referenceSha256])).digest('hex')
    const work = path.join(directory, 'versions', binding)
    await fs.mkdir(work, {recursive: true})
    const checkpointPath = path.join(work, 'history-presenter-video.json')
    let checkpoint = await readOptional(checkpointPath)
    if (checkpoint && (checkpoint.version !== 1 || checkpoint.binding !== binding)) throw Error('历史主播检查点与正文或小疤身份不一致，请恢复原任务素材')
    if (checkpoint?.presenterPath) {
      if (!validHash(checkpoint.presenterSha256) || await hashFile(checkpoint.presenterPath, signal) !== checkpoint.presenterSha256) throw Error('已生成的小疤口播视频缺失或已变化，请恢复原任务素材')
    } else {
      options.report?.('正在为历史正文生成小疤本人的整段同步口型')
      const presenter = await runtime.presenter({videoPath: source, directory: path.join(work, 'musetalk')}, {
        signal, report: options.report, avatarId: selection.avatarId, referenceSha256: selection.referenceSha256,
      })
      if (presenter.sourceSha256 !== sourceSha256) throw Error('小疤口播未绑定当前历史正文母片')
      checkpoint = {version: 1, binding, sourceSha256, selection, presenterPath: presenter.presenterPath,
        presenterSha256: await hashFile(presenter.presenterPath, signal)}
      await save(checkpointPath, checkpoint)
    }
    if (checkpoint.outputPath && checkpoint.report?.sha256) {
      try {
        if (await hashFile(checkpoint.outputPath, signal) === checkpoint.report.sha256) return {outputPath: checkpoint.outputPath, report: checkpoint.report}
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const composed = await runtime.compose({videoPath: source, directory: path.join(work, 'composition')}, {
      signal, report: options.report, introPath: selection.videoPath, presenterPath: checkpoint.presenterPath, presenterFraming: 'half-body',
    })
    if (composed.sourceSha256 !== sourceSha256 || composed.introSha256 !== selection.videoSha256) throw Error('历史片头合成结果与原正文或审核片头不一致')
    const [media, sha256, finalSourceSha, finalIntroSha, finalPresenterSha] = await Promise.all([
      runtime.probe(composed.videoPath, signal),
      hashFile(composed.videoPath, signal), hashFile(source, signal), hashFile(selection.videoPath, signal), hashFile(checkpoint.presenterPath, signal),
    ])
    if (Math.abs(media.duration - main.duration - intro.duration) > Math.max(.12, 2 / main.fps)
      || media.width !== main.width || media.height !== main.height || Math.abs(media.fps - main.fps) > .001
      || finalSourceSha !== sourceSha256 || finalIntroSha !== selection.videoSha256 || finalPresenterSha !== checkpoint.presenterSha256) throw Error('历史主播最终成片的画面、时长或素材指纹校验失败')
    const report = {status: 'completed', output: composed.videoPath, sha256, bytes: (await fs.stat(composed.videoPath)).size, ...media,
      renderer: `${input.report.renderer || 'HistoryMotionFactory'} + FFmpeg presenter`, composition: 'HistoryMotionFactoryWithPresenter',
      qa: {technical: 'passed', visual: 'not-reviewed', listening: 'not-reviewed', humanReviewRequired: false},
      sourceRender: {...input.report, output: source},
      presenterIntro: {...selection, presenterSha256: checkpoint.presenterSha256, framing: 'half-body', mainStartSeconds: intro.duration,
        narration: 'original-body-audio', subtitles: 'original-body-preserved', windowPlacement: 'above-bottom-subtitle-band'},
    }
    signal.throwIfAborted()
    await save(`${composed.videoPath}.json`, report)
    await save(checkpointPath, {...checkpoint, outputPath: composed.videoPath, report})
    return {outputPath: composed.videoPath, report}
  } finally { release() }
}
