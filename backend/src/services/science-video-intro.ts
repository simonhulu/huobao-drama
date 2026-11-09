import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getVideoEncoderOptions } from './composition/video-encoder.js'

const exec = promisify(execFile)
const defaultIntroPath = fileURLToPath(new URL('../../../data/science-pop/assets/xiaolu-intro.mp4', import.meta.url))
const VERSION = 5
const HALF_BODY_LAYOUT_VERSION = 2

export interface ScienceVideoIntroInput { videoPath: string; directory: string }
export type SciencePresenterFraming = 'closeup' | 'head-and-shoulders' | 'half-body'
export interface ScienceVideoIntroProgress { percent: number; processedSeconds: number; totalSeconds: number; speed?: number }
export interface ScienceVideoIntroOptions { signal: AbortSignal; report?: (message: string) => void; onProgress?: (progress: ScienceVideoIntroProgress) => void; introPath?: string; presenterPath?: string; presenterFraming?: SciencePresenterFraming }
export type ScienceVideoIntroPreviewOptions = Omit<ScienceVideoIntroOptions, 'presenterPath' | 'presenterFraming'>
export interface ScienceVideoIntroResult { videoPath: string; introSha256: string; sourceSha256: string }
interface IntroRecord extends ScienceVideoIntroResult { sourcePath: string; outputSha256: string; presenterSha256?: string; presenterFraming?: SciencePresenterFraming; presenterLayoutVersion?: number; renderVersion?: number }
interface IntroManifest { version: typeof VERSION; entries: IntroRecord[] }
interface VideoInfo {
  width: number; height: number; fps: string; duration: number; videoDuration: number; audio: boolean
  frames?: number
  copy?: { timeScale: number; frames: number; colorOptions: string[] }
}

async function fileHash(filename: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const stat = await fs.stat(filename)
  if (!stat.isFile() || !stat.size) throw new Error('片头或科普成片文件为空，请检查本地媒体')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk)
  signal.throwIfAborted()
  return hash.digest('hex')
}

async function matchesHash(filename: string, expected: string, signal: AbortSignal) {
  try { return await fileHash(filename, signal) === expected } catch (error) { signal.throwIfAborted(); return false }
}

async function readManifest(filename: string, directory: string): Promise<IntroManifest> {
  try {
    const data = JSON.parse(await fs.readFile(filename, 'utf8'))
    if (![1, 2, 3, 4, VERSION].includes(data.version) || !Array.isArray(data.entries)) throw new Error('Invalid intro manifest')
    const entries = data.entries.filter((entry: IntroRecord) => entry && typeof entry.sourcePath === 'string'
      && typeof entry.videoPath === 'string' && path.dirname(path.resolve(entry.videoPath)) === directory
      && [entry.introSha256, entry.sourceSha256, entry.outputSha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      && (entry.presenterSha256 === undefined || /^[a-f0-9]{64}$/.test(entry.presenterSha256))
      && (entry.presenterFraming === undefined || ['closeup', 'head-and-shoulders', 'half-body'].includes(entry.presenterFraming)))
      .map((entry: IntroRecord) => ({ ...entry, renderVersion: entry.renderVersion ?? data.version }))
    return { version: VERSION, entries }
  } catch { return { version: VERSION, entries: [] } }
}

async function sourceFromManifest(videoPath: string, directory: string, manifest: IntroManifest, inputSha256: string, signal: AbortSignal) {
  const prepared = manifest.entries.find(entry => entry.outputSha256 === inputSha256)
  if (prepared) {
    if (!await matchesHash(prepared.sourcePath, prepared.sourceSha256, signal)) {
      throw new Error('原科普成片缺失或内容已改变，请提供原成片，不能从已含片头的视频生成主播')
    }
    return { videoPath: prepared.sourcePath, sourceSha256: prepared.sourceSha256 }
  }
  if (manifest.entries.some(entry => entry.videoPath === videoPath)
      || path.dirname(videoPath) === directory && /^science-with-intro-[a-f0-9]+\.mp4$/.test(path.basename(videoPath))) {
    throw new Error('已有片头成片的校验记录缺失或内容损坏，请使用原科普成片重试，避免重复添加片头')
  }
  return { videoPath, sourceSha256: inputSha256 }
}

/** Recover the verified main before upstream extracts its audio for lip synchronization. */
export async function resolveScienceVideoIntroSource(input: ScienceVideoIntroInput, options: { signal: AbortSignal }): Promise<{ videoPath: string; sourceSha256: string }> {
  const directory = path.resolve(input.directory), videoPath = path.resolve(input.videoPath)
  const [manifest, inputSha256] = await Promise.all([
    readManifest(path.join(directory, 'science-video-intro.json'), directory), fileHash(videoPath, options.signal),
  ])
  return sourceFromManifest(videoPath, directory, manifest, inputSha256, options.signal)
}

async function probeVideo(filename: string, signal: AbortSignal): Promise<VideoInfo> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename],
    { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
  const data = JSON.parse(stdout)
  const stream = data.streams?.find((item: any) => item.codec_type === 'video' && item.width > 0 && item.height > 0)
  const duration = Math.max(...[stream?.duration, data.format?.duration]
    .map(Number).filter(value => Number.isFinite(value) && value > 0))
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error('片头和科普成片必须包含可播放的视频画面')
  const rate = String(stream.avg_frame_rate || stream.r_frame_rate || '30/1')
  const [numerator, denominator = 1] = rate.split('/').map(Number)
  const fps = numerator! / denominator!
  const rotation = Number(stream.side_data_list?.find((item: any) => Number.isFinite(Number(item.rotation)))?.rotation || 0)
  const rotated = Math.abs(rotation) % 180 === 90
  const [timeNumerator, timeScale] = String(stream.time_base).split('/').map(Number)
  const [rateNumerator, rateDenominator = 1] = String(stream.r_frame_rate).split('/').map(Number)
  const frames = Number(stream.nb_frames)
  const videoDuration = Number.isFinite(Number(stream.duration)) && Number(stream.duration) > 0 ? Number(stream.duration) : duration
  const copyCompatible = stream.codec_name === 'h264' && stream.pix_fmt === 'yuv420p' && Number(stream.has_b_frames) === 0
    && rotation === 0 && stream.sample_aspect_ratio === '1:1' && stream.field_order === 'progressive'
    && Math.abs(Number(stream.start_time)) < .00001 && stream.width % 2 === 0 && stream.height % 2 === 0
    && timeNumerator === 1 && Number.isSafeInteger(timeScale) && timeScale! > 0
    && Math.abs(rateNumerator! / rateDenominator! - fps) < .00001 && Number.isSafeInteger(frames)
    && Math.abs(frames - videoDuration * fps) < .1 && Math.abs(duration - videoDuration) * fps < .5
  const colorOptions = ['color_range', 'color_space', 'color_transfer', 'color_primaries'].flatMap(key => {
    const value = stream[key]
    return typeof value === 'string' && /^[a-z0-9_-]+$/i.test(value) && !['unknown', 'unspecified', 'reserved'].includes(value)
      ? [`-${key === 'color_space' ? 'colorspace' : key === 'color_transfer' ? 'color_trc' : key}`, value] : []
  })
  return { width: rotated ? stream.height : stream.width, height: rotated ? stream.width : stream.height,
    fps: Number.isFinite(fps) && fps >= 1 && fps <= 120 ? rate : '30/1', duration,
    videoDuration, frames: Number.isSafeInteger(frames) ? frames : undefined,
    audio: data.streams?.some((item: any) => item.codec_type === 'audio') || false,
    ...(copyCompatible ? { copy: { timeScale: timeScale!, frames, colorOptions } } : {}) }
}

function movingIntroMask(width: number, height: number, diameter: number, left: number, top: number, border: number, duration: number, framing: SciencePresenterFraming): string {
  // Only the brief moving layer needs the per-pixel warp, not a full-resolution canvas.
  if (height > 360) {
    const ratio = 360 / height, reducedWidth = Math.ceil(width * ratio / 2) * 2
    return `scale=${reducedWidth}:360:flags=lanczos,`
      + movingIntroMask(reducedWidth, 360, diameter * ratio, left * ratio, top * ratio, border * ratio, duration, framing)
      + `,scale=${width}:${height}:flags=lanczos`
  }
  const cropSize = Math.min(width, height) * (framing === 'half-body' ? 1 : .5)
  const cropY = framing === 'half-body' ? (height - cropSize) / 2
    : Math.max(0, Math.min(height - cropSize, height * .28 - cropSize / 2))
  // Inverse-map a moving crop onto a fixed canvas, so neither scaling nor masking can resize the timeline.
  const geometry = `st(0,clip(T/${duration},0,1));st(0,ld(0)*ld(0)*(3-2*ld(0)));`
    + `st(1,W+(${diameter}-W)*ld(0));st(2,H+(${diameter}-H)*ld(0));`
    + `st(3,${left}*ld(0));st(4,${top}*ld(0));`
    + 'st(5,min(ld(1),ld(2))*ld(0)/2);'
    + 'st(6,abs(X-ld(3)-ld(1)/2)-(ld(1)/2-ld(5)));st(7,abs(Y-ld(4)-ld(2)/2)-(ld(2)/2-ld(5)));'
    + 'st(8,hypot(max(ld(6),0),max(ld(7),0))+min(max(ld(6),ld(7)),0)-ld(5));'
  const sourceX = `(W-${cropSize})*ld(0)/2+(X-ld(3))*(W+(${cropSize}-W)*ld(0))/ld(1)`
  const sourceY = `${cropY}*ld(0)+(Y-ld(4))*(H+(${cropSize}-H)*ld(0))/ld(2)`
  const channel = (name: string) => `${geometry}if(gte(ld(8),-${border}*ld(0)),245,${name}(${sourceX},${sourceY}))`
  return `geq=r='${channel('r')}':g='${channel('g')}':b='${channel('b')}':a='${geometry}clip(.5-ld(8),0,1)*255':interpolation=bilinear`
}

function concatAudioFilter(intro: VideoInfo, main: VideoInfo, inputOffset = 0) {
  return [...[intro, main].map((media, index) =>
    `[${index + inputOffset}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,`
      + `atrim=duration=${media.duration},asetpts=PTS-STARTPTS[a${index}]`),
  '[a0][a1]concat=n=2:v=0:a=1[a]']
}

function concatFilter(intro: VideoInfo, main: VideoInfo, width: number, height: number, presenterFraming?: SciencePresenterFraming, includeAudio = true) {
  const transition = Math.min(.5, main.duration / 2)
  const segments = [intro, main].map((media, index) =>
    `[${index}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${main.fps},format=yuv420p,`
      + `tpad=stop_mode=clone:stop_duration=${media.duration + transition},trim=duration=${media.duration + (index === 0 ? transition : 0)},setpts=PTS-STARTPTS,fps=${main.fps},settb=AVTB[v${index}]`)
  const audio = includeAudio ? concatAudioFilter(intro, main) : []
  const diameter = Math.min(width, height, Math.max(16, Math.round(Math.min(width, height) * (presenterFraming === 'half-body' ? .30 : .25) / 2) * 2))
  // Some mobile feeds center-crop landscape videos to 3:2; leave room for that crop,
  // the right-side controls, and the original subtitles in the bottom 18%.
  const feedWidth = Math.min(width, height * 1.5)
  const right = Math.ceil(((width - feedWidth) / 2 + feedWidth * .12) / 2) * 2
  const bottom = Math.ceil(height * .18 / 2) * 2
  const left = width - diameter - right, top = height - diameter - bottom
  const border = Math.max(1, Math.round(Math.min(width, height) * .002))
  const radius = diameter / 2, distance = 'hypot(X-(W-1)/2,Y-(H-1)/2)'
  const presenterCrop = presenterFraming === 'closeup' || presenterFraming === 'half-body'
    ? `crop=w='max(2,floor(min(iw,ih)/2)*2)':h=ow:x='floor((iw-ow)/4)*2':y='floor((ih-oh)/4)*2'`
    : `crop=w='max(2,floor(min(iw,ih)*0.64/2)*2)':h=ow:x='floor((iw-ow)/4)*2':y='floor(max(0,min(ih-oh,ih*0.36-oh/2))/2)*2'`
  if (presenterFraming) {
    const motion = Math.min(.8, intro.duration / 2), start = intro.duration - motion
    const handoff = Math.min(.12, main.duration / 2)
    return [...segments,
      '[v0]split[intro-prefix][intro-motion]',
      `[intro-prefix]trim=duration=${start},setpts=PTS-STARTPTS,settb=AVTB[prefix]`,
      `[intro-motion]trim=start=${start}:end=${intro.duration},setpts=PTS-STARTPTS,fps=${main.fps},`
        + `tpad=stop_mode=clone:stop_duration=${handoff},trim=duration=${motion + handoff},format=rgba,`
        + `${movingIntroMask(width, height, diameter, left, top, border, motion, presenterFraming)},`
        + `fade=t=out:st=${motion}:d=${handoff}:alpha=1,settb=AVTB[moving]`,
      '[v1]split[main-first][main-body]',
      `[main-first]trim=end_frame=1,setpts=PTS-STARTPTS,fps=${main.fps},tpad=stop_mode=clone:stop_duration=${motion},`
        + `trim=duration=${motion},settb=AVTB[reveal]`,
      `[2:v:0]setpts=PTS-STARTPTS,${presenterCrop},scale=${diameter}:${diameter}:flags=lanczos,`
        + `setsar=1,fps=${main.fps},trim=duration=${main.duration},format=rgba[presenter-colors]`,
      // Static geometry is evaluated for one frame; framesync reuses it for the moving presenter.
      `color=c=0xf5f5f5:s=${diameter}x${diameter}:r=${main.fps}:d=1,trim=end_frame=1,split[mask-input][ring-input]`,
      `[mask-input]format=gray,geq=lum='clip((${radius}-${distance})*255,0,255)'[presenter-mask]`,
      `[ring-input]format=rgba,geq=r=245:g=245:b=245:a='gte(${distance},${radius - border})*255'[ring]`,
      '[presenter-colors][ring]overlay=format=rgb[presenter-framed]',
      '[presenter-framed][presenter-mask]alphamerge[presenter]',
      `[main-body][presenter]overlay=x=${left}:y=${top}:eof_action=pass:format=yuv420,`
        + `format=yuv420p,fps=${main.fps},settb=AVTB[body]`,
      '[reveal][body]concat=n=2:v=1:a=0[underlay]',
      '[underlay][moving]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=yuv420,format=yuv420p,settb=AVTB[transition-body]',
      `[prefix][transition-body]concat=n=2:v=1:a=0,trim=duration=${intro.duration + main.duration},fps=${main.fps},format=yuv420p[v]`,
      ...audio,
    ].join(';')
  }
  const presentation = [
    '[v1]null[body]',
  ]
  return [...segments, ...presentation,
    `[v0][body]xfade=transition=fade:duration=${transition}:offset=${intro.duration},trim=duration=${intro.duration + main.duration},format=yuv420p[v]`,
    ...audio,
  ].join(';')
}

type RenderProgress = (seconds: number, speed: number | undefined, ended: boolean) => void

function renderProgress(options: ScienceVideoIntroPreviewOptions, totalSeconds: number): RenderProgress {
  let lastReportedAt: number | undefined
  let lastMessageAt: number | undefined
  let lastProcessedSeconds: number | undefined
  return (seconds, speed, ended) => {
    const now = Date.now()
    if (!ended && lastReportedAt !== undefined && now - lastReportedAt < 5_000) return
    lastReportedAt = now
    const processedSeconds = Math.min(totalSeconds, Math.max(0, seconds))
    const percent = Math.min(99, Math.floor(processedSeconds / totalSeconds * 100))
    if (processedSeconds !== lastProcessedSeconds) {
      lastProcessedSeconds = processedSeconds
      options.onProgress?.({ percent, processedSeconds, totalSeconds, ...(speed !== undefined ? { speed } : {}) })
    }
    if (ended || lastMessageAt === undefined || now - lastMessageAt >= 30_000) {
      lastMessageAt = now
      options.report?.(`科普视频正在合成：${percent}%（${Math.floor(processedSeconds)} / ${Math.ceil(totalSeconds)} 秒）`)
    }
  }
}

async function runRender(args: string[], signal: AbortSignal, report: RenderProgress) {
  signal.throwIfAborted()
  const rendering = exec('ffmpeg', ['-progress', 'pipe:1', '-stats_period', '1', ...args],
    { signal, killSignal: 'SIGKILL', timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 })
  const closed = new Promise<void>(resolve => rendering.child.once('close', () => resolve()))
  const abort = () => { rendering.child.kill('SIGKILL') }
  signal.addEventListener('abort', abort, { once: true })
  const lines = createInterface({ input: rendering.child.stdout! })
  const updates = (async () => {
    const record = new Map<string, string>()
    for await (const line of lines) {
      const separator = line.indexOf('=')
      if (separator < 0) continue
      const key = line.slice(0, separator), value = line.slice(separator + 1)
      record.set(key, value)
      if (key !== 'progress') continue
      const microseconds = Number(record.get('out_time_us'))
      const speed = Number(record.get('speed')?.replace(/x$/, ''))
      if (Number.isFinite(microseconds) && microseconds >= 0)
        report(microseconds / 1_000_000, Number.isFinite(speed) && speed > 0 ? speed : undefined, value === 'end')
      record.clear()
    }
  })()
  try {
    if (signal.aborted) abort()
    await Promise.all([rendering, updates])
  } catch (error) {
    abort()
    lines.close()
    await Promise.allSettled([rendering, updates])
    throw error
  } finally {
    lines.close()
    signal.removeEventListener('abort', abort)
    if (signal.aborted) { abort(); await closed }
  }
}

async function encodeVideo(args: string[], finish: string[], width: number, height: number, signal: AbortSignal, report: RenderProgress) {
  const encoder = getVideoEncoderOptions({ width, height })
  const run = (parameters: string[]) => runRender([...args, ...parameters, ...finish], signal, report)
  try {
    await run(encoder)
  } catch (error) {
    signal.throwIfAborted()
    const failure = error as { killed?: boolean; signal?: string }
    if (failure.killed || failure.signal === 'SIGKILL') throw error
    if (!encoder.includes('h264_videotoolbox')) throw error
    await run(['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'])
  }
}

async function decodedFrame(filename: string, at: number, signal: AbortSignal, width: number, height: number) {
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(Math.max(0, at - .00001)), '-i', filename,
    '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'],
  { signal, encoding: 'buffer', timeout: 60_000, maxBuffer: Math.max(16 * 1024 * 1024, width * height * 2) })
  if (stdout.length !== width * height * 1.5) throw new Error('片头拼接接缝缺少完整画面')
  return createHash('sha256').update(stdout).digest('hex')
}

async function copyBodyAfterIntro(introPath: string, sourcePath: string, temporary: string, intro: VideoInfo, main: VideoInfo,
  options: ScienceVideoIntroPreviewOptions, report: RenderProgress) {
  if (!main.copy) return false
  const { signal } = options
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-read_intervals', '%+12',
    '-show_frames', '-show_entries', 'frame=key_frame,pts_time', '-of', 'json', sourcePath], { signal, timeout: 60_000, maxBuffer: 1024 * 1024 })
  const [numerator, denominator = 1] = main.fps.split('/').map(Number), fps = numerator! / denominator!
  const cut = JSON.parse(stdout).frames?.find((frame: any) => frame.key_frame === 1
    && Number(frame.pts_time) >= 1 && Number(frame.pts_time) < main.videoDuration - 1 / fps)
  if (!cut) return false
  const at = Number(cut.pts_time)
  // Only an IDR can start an independently copied H.264 tail. An ordinary
  // I-frame may still reference pictures before the cut in an open GOP.
  const { stdout: packet } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(at), '-i', sourcePath,
    '-map', '0:v:0', '-frames:v', '1', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1'],
  { signal, encoding: 'buffer', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  let idr = false
  for (let i = 0; i + 4 < packet.length; i++) {
    if (packet[i] || packet[i + 1]) continue
    const offset = packet[i + 2] === 1 ? i + 3 : packet[i + 2] === 0 && packet[i + 3] === 1 ? i + 4 : -1
    if (offset < 0) continue
    const type = packet[offset]! & 31
    if (type >= 1 && type <= 5) { idr = type === 5; break }
  }
  if (!idr) return false
  const directory = await fs.mkdtemp(path.join(path.dirname(temporary), '.science-intro-copy-'))
  try {
    const prefix = path.join(directory, 'prefix.mp4'), list = path.join(directory, 'video.ffconcat')
    const frames = Math.ceil((intro.duration + at) * fps - .00001), prefixDuration = frames / fps
    options.report?.('正在编码片头与过渡短片段，后续正文直接复制视频流')
    await encodeVideo(['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', introPath, '-t', String(at), '-i', sourcePath,
      '-filter_complex', concatFilter(intro, { ...main, duration: at }, main.width, main.height, undefined, false), '-map', '[v]'],
    ['-an', '-pix_fmt', 'yuv420p', '-r', main.fps, '-frames:v', String(frames), '-bf', '0',
      '-video_track_timescale', String(main.copy.timeScale), ...main.copy.colorOptions, prefix], main.width, main.height, signal, report)
    const quote = (filename: string) => "'" + filename.replaceAll("'", "'\\''") + "'"
    await fs.writeFile(list, `ffconcat version 1.0\nfile ${quote(prefix)}\nduration ${prefixDuration.toFixed(9)}\n`
      + `file ${quote(sourcePath)}\ninpoint ${at.toFixed(9)}\nduration ${(main.videoDuration - at).toFixed(9)}\n`, { signal })
    options.report?.('正在直接复制正文视频流并拼接原声')
    await runRender(['-nostdin', '-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-i', introPath, '-i', sourcePath, '-filter_complex', concatAudioFilter(intro, main, 1).join(';'),
      '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', temporary], signal, report)
    const output = await probeVideo(temporary, signal)
    const expectedFrames = frames + main.copy.frames - Math.round(at * fps)
    if (output.frames !== expectedFrames || Math.abs(output.videoDuration - expectedFrames / fps) > .01)
      throw new Error('正文视频流复制后的帧数或时长不完整')
    const [original, copied] = await Promise.all([decodedFrame(sourcePath, at, signal, main.width, main.height),
      decodedFrame(temporary, prefixDuration, signal, main.width, main.height)])
    if (original !== copied) throw new Error('正文视频流复制后的接缝画面不一致')
    return true
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

/** Full delivery requires the complete synchronized presenter video. */
export async function prepareScienceVideoWithIntro(input: ScienceVideoIntroInput, options: ScienceVideoIntroOptions): Promise<ScienceVideoIntroResult> {
  options.signal.throwIfAborted()
  const framing = options.presenterFraming ?? process.env.SCIENCE_PRESENTER_FRAMING ?? 'head-and-shoulders'
  if (framing !== 'closeup' && framing !== 'head-and-shoulders' && framing !== 'half-body') throw new Error('主播取景模式无效，请使用 closeup、head-and-shoulders 或 half-body')
  const configuredPresenter = options.presenterPath || process.env.SCIENCE_PRESENTER_VIDEO_PATH
  if (!configuredPresenter) throw new Error('缺少与正文同步的完整主播视频，请先生成整段主播口播视频')
  return prepareScienceVideo(input, options, path.resolve(configuredPresenter), framing)
}

/** Final delivery with the original intro and main audio, without a presenter overlay. */
export async function prepareScienceVideoWithIntroOnly(input: ScienceVideoIntroInput, options: ScienceVideoIntroPreviewOptions): Promise<ScienceVideoIntroResult> {
  return prepareScienceVideo(input, options)
}

export async function prepareScienceVideoIntroPreview(input: ScienceVideoIntroInput, options: ScienceVideoIntroPreviewOptions): Promise<ScienceVideoIntroResult> {
  return prepareScienceVideo(input, options)
}

/** Intro deliveries share media validation, atomic output and source provenance. */
async function prepareScienceVideo(input: ScienceVideoIntroInput, options: ScienceVideoIntroPreviewOptions, presenterPath?: string, presenterFraming?: SciencePresenterFraming): Promise<ScienceVideoIntroResult> {
  const { signal } = options
  signal.throwIfAborted()
  const directory = path.resolve(input.directory)
  const introPath = path.resolve(options.introPath || process.env.SCIENCE_INTRO_VIDEO_PATH || defaultIntroPath)
  const inputPath = path.resolve(input.videoPath)
  const [inputSha256, introSha256, presenterSha256] = await Promise.all([
    fileHash(inputPath, signal), fileHash(introPath, signal), presenterPath ? fileHash(presenterPath, signal) : undefined,
  ])
  await fs.mkdir(directory, { recursive: true })
  const manifestPath = path.join(directory, 'science-video-intro.json')
  const manifest = await readManifest(manifestPath, directory)
  const resolved = await sourceFromManifest(inputPath, directory, manifest, inputSha256, signal)
  const sourcePath = resolved.videoPath, sourceSha256 = resolved.sourceSha256
  const presenterLayoutVersion = presenterFraming === 'half-body' ? HALF_BODY_LAYOUT_VERSION : undefined
  const cached = manifest.entries.find(entry => entry.sourceSha256 === sourceSha256 && entry.introSha256 === introSha256
    && entry.presenterSha256 === presenterSha256 && entry.renderVersion === VERSION
    && (presenterLayoutVersion === undefined || entry.presenterLayoutVersion === presenterLayoutVersion)
    && (!presenterPath || (entry.presenterFraming ?? 'head-and-shoulders') === presenterFraming))
  if (cached && await matchesHash(cached.videoPath, cached.outputSha256, signal)) {
    options.report?.('已复用固定片头成片')
    return { videoPath: cached.videoPath, sourceSha256, introSha256 }
  }
  const [intro, main, presenter] = await Promise.all([probeVideo(introPath, signal), probeVideo(sourcePath, signal),
    presenterPath ? probeVideo(presenterPath, signal) : undefined])
  if (!intro.audio || !main.audio) throw new Error('固定片头和科普成片必须都包含原始音轨，请检查素材后重试')
  if (presenter && presenter.videoDuration + .001 < main.videoDuration) throw new Error('同步主播视频时长不足，必须覆盖正文全程，不能循环补齐')
  const width = Math.ceil(main.width / 2) * 2, height = Math.ceil(main.height / 2) * 2
  const key = createHash('sha256').update(JSON.stringify([VERSION, sourceSha256, introSha256, presenterSha256,
    ...(presenterFraming && presenterFraming !== 'head-and-shoulders' ? [presenterFraming] : []),
    ...(presenterLayoutVersion === undefined ? [] : [presenterLayoutVersion])])).digest('hex')
  const outputPath = path.join(directory, `science-with-intro-${key}.mp4`)
  const temporary = path.join(directory, `.science-intro-${randomUUID()}.partial.mp4`)
  const temporaryManifest = path.join(directory, `.science-intro-${randomUUID()}.json.tmp`)
  const totalSeconds = intro.duration + main.duration
  const report = renderProgress(options, totalSeconds)
  let committedOutput = false, committedManifest = false
  options.report?.(presenterPath ? '正在拼接固定片头与科普成片，正文叠加同步主播圆窗并保留原声' : '正在拼接固定片头与科普成片，保留片头与正文原声')
  try {
    let copied = false
    if (!presenterPath) {
      try { copied = await copyBodyAfterIntro(introPath, sourcePath, temporary, intro, main, options, report) }
      catch {
        signal.throwIfAborted()
        options.report?.('正文视频流复制校验未通过，正在使用兼容模式合成成片')
      }
    }
    if (!copied) {
      const args = ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', introPath, '-i', sourcePath, ...(presenterPath ? ['-i', presenterPath] : []),
        '-filter_complex', concatFilter(intro, main, width, height, presenterFraming), '-map', '[v]', '-map', '[a]']
      const finish = ['-pix_fmt', 'yuv420p', '-r', main.fps, '-fps_mode', 'cfr', '-c:a', 'aac', '-b:a', '192k',
        '-ar', '48000', '-ac', '2', '-movflags', '+faststart', temporary]
      await encodeVideo(args, finish, width, height, signal, report)
    }
    const output = await probeVideo(temporary, signal)
    const [fpsNumerator, fpsDenominator = 1] = main.fps.split('/').map(Number)
    const frameTolerance = Math.max(.08, 1.5 * fpsDenominator! / fpsNumerator!)
    if (!output.audio || output.width !== width || output.height !== height || Math.abs(output.duration - intro.duration - main.duration) > .35
      || Math.abs(output.videoDuration - intro.duration - main.duration) > frameTolerance) {
      throw new Error('固定片头拼接后的成片画面、音轨或时长不完整，请重试')
    }
    const outputSha256 = await fileHash(temporary, signal)
    if (!await matchesHash(sourcePath, sourceSha256, signal) || !await matchesHash(introPath, introSha256, signal)
      || presenterPath && (!presenterSha256 || !await matchesHash(presenterPath, presenterSha256, signal))) {
      throw new Error('拼接期间片头、主播或原科普成片已改变，请重新生成')
    }
    signal.throwIfAborted()
    await fs.rename(temporary, outputPath)
    committedOutput = true
    const record: IntroRecord = { videoPath: outputPath, sourcePath, sourceSha256, introSha256, presenterSha256, presenterFraming, presenterLayoutVersion, outputSha256, renderVersion: VERSION }
    const entries = manifest.entries.filter(entry => entry.videoPath !== outputPath)
    await fs.writeFile(temporaryManifest, JSON.stringify({ version: VERSION, entries: [...entries, record] }, null, 2), { signal })
    signal.throwIfAborted()
    await fs.rename(temporaryManifest, manifestPath)
    committedManifest = true
    options.onProgress?.({ percent: 100, processedSeconds: totalSeconds, totalSeconds })
    options.report?.('科普视频合成完成：100%')
    return { videoPath: outputPath, sourceSha256, introSha256 }
  } catch (error) {
    if (committedOutput && !committedManifest) await fs.rm(outputPath, { force: true })
    signal.throwIfAborted()
    throw error
  } finally {
    await Promise.all([fs.rm(temporary, { force: true }), fs.rm(temporaryManifest, { force: true })])
  }
}
