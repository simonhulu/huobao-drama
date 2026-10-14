#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const backendRequire = createRequire(path.join(ROOT, 'backend/package.json'))
const remotionRequire = createRequire(path.join(ROOT, 'remotion/package.json'))
const sharp = backendRequire('sharp')
const exec = promisify(execFile)
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const save = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
const local = (url) => path.isAbsolute(url) ? url : path.resolve(ROOT, 'data', url)
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const digest = async (file) => {
  const hash = createHash('sha256')
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

export function readAssCues(ass) {
  const time = (value) => {
    const parts = value.split(':').map(Number)
    return parts.length === 3 && parts.every(Number.isFinite) ? parts[0] * 3600 + parts[1] * 60 + parts[2] : NaN
  }
  const cues = []
  for (const line of ass.split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue
    const fields = line.slice(9).trim().split(',')
    const start = time(fields[1]); const end = time(fields[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid ASS cue')
    cues.push({ start, end, text: fields.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n') })
  }
  return cues
}

export function validateSelection(snapshot, selection) {
  const seen = new Set()
  const selected = selection.shots || []
  for (const item of selected) {
    const shot = snapshot.storyboards.find((s) => s.storyboardNumber === item.storyboardNumber)
    if (!shot || seen.has(shot.id)) throw new Error('Unknown or duplicate selected storyboard')
    seen.add(shot.id)
    if (!item.rationale || !item.effects?.length) throw new Error('Selected shot needs visual rationale and effects')
    for (const effect of item.effects) {
      if (!effect.trigger || !shot.narration?.includes(effect.trigger)) throw new Error(`Shot ${shot.storyboardNumber}: trigger not in narration`)
      if (/【待核/.test(effect.trigger)) throw new Error('Unverified text cannot be emphasized')
      if (!Number.isFinite(effect.start) || !Number.isFinite(effect.end) || effect.start < 0.15
        || effect.end > shot.duration - 0.1 || effect.end - effect.start < 0.8) throw new Error('Effect timing exceeds shot safe window')
      if (!['thought', 'scribble', 'emphasis', 'underline'].includes(effect.kind)) throw new Error('Unknown effect kind')
      for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(effect[key])) throw new Error('Effect box must be numeric')
      if (effect.x < 0 || effect.y < 0 || effect.width <= 0 || effect.height <= 0
        || effect.x + effect.width > 1 || effect.y + effect.height > 0.86) throw new Error('Effect intersects frame edge or subtitle safe area')
    }
  }
  if (selected.length > Math.max(1, Math.floor(snapshot.storyboards.length * 0.18))) throw new Error('Too many shots have effects; keep the edit sparse')
  return selected
}

async function probe(file) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,nb_frames,width,height,duration,r_frame_rate:format=duration', '-of', 'json', file])
  return JSON.parse(stdout)
}

export const planFingerprint = (plan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex')

export function validateRenderedManifest(plan, manifest) {
  if (manifest.sourceFingerprint !== plan.sourceFingerprint || manifest.planFingerprint !== planFingerprint(plan)) {
    throw new Error('Rendered overlays are stale; render the current plan first')
  }
  const selected = plan.shots.filter((s) => s.effects.length)
  if (!Array.isArray(manifest.rendered) || manifest.rendered.length !== selected.length
    || manifest.rendered.some((clip, index) => clip.storyboardNumber !== selected[index].storyboardNumber)) {
    throw new Error('Not every selected shot has a rendered overlay')
  }
}

export function validateOverlayMedia(media, frames, fps) {
  const video = media.streams?.find((s) => s.codec_type === 'video')
  const rate = video?.r_frame_rate?.split('/').map(Number)
  if (!video || video.codec_name !== 'prores' || !video.pix_fmt?.startsWith('yuva')
    || Number(video.nb_frames) !== frames || !rate || rate.length !== 2 || rate[0] / rate[1] !== fps) {
    throw new Error('Invalid overlay: require complete ProRes alpha frames at the plan frame rate')
  }
}

async function inventory(snapshot, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const rows = snapshot.storyboards
  const narrations = rows.map((shot) => ({ ...shot, localImage: local(shot.firstFrameImage),
    cues: shot.subtitleUrl && fs.existsSync(local(shot.subtitleUrl)) ? readAssCues(fs.readFileSync(local(shot.subtitleUrl), 'utf8')) : [] }))
  save(path.join(dir, 'inventory.json'), narrations)
  for (let offset = 0; offset < rows.length; offset += 42) {
    const group = rows.slice(offset, offset + 42)
    const tiles = []
    for (const [index, shot] of group.entries()) {
      const left = index % 6 * 320; const top = Math.floor(index / 6) * 202
      const image = await sharp(local(shot.firstFrameImage)).resize(320, 180, { fit: 'contain', background: '#ffffff' }).png().toBuffer()
      const label = Buffer.from(`<svg width="320" height="22"><rect width="320" height="22" fill="#ffffff"/><text x="8" y="16" fill="#161616" font-family="Arial" font-size="14">${shot.storyboardNumber} / ${shot.id} / ${shot.duration}s</text></svg>`)
      tiles.push({ input: image, left, top }, { input: label, left, top: top + 180 })
    }
    await sharp({ create: { width: 1920, height: Math.ceil(group.length / 6) * 202, channels: 3, background: '#ffffff' } })
      .composite(tiles).jpeg({ quality: 90 }).toFile(path.join(dir, `contact-${offset + 1}.jpg`))
  }
  console.log(JSON.stringify({ episodeId: snapshot.episode.id, shots: rows.length, inventory: path.join(dir, 'inventory.json') }))
}

export function buildPlan(snapshot, selection, source, sourceFingerprint, media) {
  const selected = validateSelection(snapshot, selection)
  const video = media.streams.find((s) => s.codec_type === 'video')
  if (!video || !media.streams.some((s) => s.codec_type === 'audio')) throw new Error('A finished source video with audio is required')
  const fps = 30
  let cursor = 0
  const shots = snapshot.storyboards.map((shot) => {
    const item = selected.find((s) => s.storyboardNumber === shot.storyboardNumber)
    const effects = (item?.effects || []).map(({ start, end, trigger, ...effect }, index) => ({
      ...effect, id: `shot-${shot.id}-effect-${index + 1}`, startFrame: Math.round(start * fps), endFrame: Math.round(end * fps),
      trigger, rationale: item.rationale,
    }))
    const result = {
      shotId: shot.id, storyboardNumber: shot.storyboardNumber, duration: shot.duration, timelineStart: cursor,
      sourceEvidence: { narration: shot.narration || '', dialogue: shot.dialogue || '', videoPrompt: shot.videoPrompt || '',
        movement: shot.movement || '', asset: shot.firstFrameImage },
      warnings: ['missing dialogue/video prompt metadata; source composition inherited without changing camera'],
      effects, editDecision: item?.rationale || '保留原镜头；已有叙事或画内文字足够，不额外添加动画。',
      beats: [{ id: `shot-${shot.id}-beat-1`, start: 0, end: shot.duration, text: shot.narration || 'Source shot hold',
        role: effects.length ? 'reveal' : 'hold', framing: 'source framing', focus: { x: 0.5, y: 0.5, zoom: 1 },
        motion: 'continue source Ken Burns', easing: 'ease-in-out', transition: 'smooth',
        rationale: '延续已审核的原镜头与字幕；本次只在选择的语义窗口加入透明叠加层。',
        layerMode: 'crop', layers: [], fallback: null, warnings: [] }],
    }
    cursor += shot.duration
    return result
  })
  const duration = Number(media.format.duration)
  if (Math.abs(cursor - duration) > 0.1) throw new Error('Source duration differs from storyboard timeline; cannot assume alignment')
  return { schemaVersion: 1, episodeId: snapshot.episode.id, fps, width: video.width, height: video.height,
    duration, sourcePath: source, sourceFingerprint, snapshotSourceUrl: snapshot.sourceUrl, shots,
    audioPolicy: 'copy original audio bit-for-bit; no BGM or new SFX', cameraPolicy: 'inherit original source Ken Burns',
    subtitlesPolicy: 'original burned subtitles remain unchanged', generatedAt: new Date().toISOString() }
}

async function remotionModules() {
  const renderer = await import(remotionRequire.resolve('@remotion/renderer'))
  const bundler = await import(remotionRequire.resolve('@remotion/bundler'))
  return { ...renderer, ...bundler }
}

async function render(plan, dir) {
  if (await digest(plan.sourcePath) !== plan.sourceFingerprint) throw new Error('Source bytes changed; refusing stale plan')
  fs.mkdirSync(dir, { recursive: true })
  const { bundle, selectComposition, renderMedia, renderStill } = await remotionModules()
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'remotion/src/semantic-overlay-entry.tsx'),
    publicDir: path.join(ROOT, 'remotion/public'), rootDir: path.join(ROOT, 'remotion'), outDir: path.join(dir, 'bundle') })
  const browserExecutable = path.join(ROOT, '.remotion-chrome/chrome-headless-shell-mac-arm64/chrome-headless-shell')
  const sourceKeys = ['src/SemanticShotOverlay.tsx', 'src/semantic-overlay-core.ts', 'src/semantic-overlay-entry.tsx',
    'public/fonts/LXGWWenKaiScreen.ttf'].map((file) => path.join(ROOT, 'remotion', file))
  const codeHash = createHash('sha256')
  for (const file of sourceKeys) codeHash.update(fs.readFileSync(file))
  const codeDigest = codeHash.digest('hex')
  const rendered = []
  for (const shot of plan.shots.filter((s) => s.effects.length)) {
    const startFrame = Math.min(...shot.effects.map((e) => e.startFrame))
    const endFrame = Math.max(...shot.effects.map((e) => e.endFrame))
    const props = { width: plan.width, height: plan.height, fps: plan.fps, durationInFrames: endFrame - startFrame,
      effects: shot.effects.map((e) => ({ ...e, startFrame: e.startFrame - startFrame, endFrame: e.endFrame - startFrame })) }
    const key = createHash('sha256').update(JSON.stringify({ props, codeDigest })).digest('hex').slice(0, 16)
    const clip = path.join(dir, `overlay-${shot.storyboardNumber}-${key}.mov`)
    const composition = await selectComposition({ serveUrl, id: 'SemanticShotOverlay', inputProps: props, browserExecutable })
    console.log(JSON.stringify({ phase: 'overlay', storyboard: shot.storyboardNumber, frames: props.durationInFrames }))
    if (fs.existsSync(clip)) validateOverlayMedia(await probe(clip), props.durationInFrames, plan.fps)
    else {
      const partial = `${clip}.partial.mov`
      await renderMedia({ composition, serveUrl, inputProps: props, browserExecutable,
        outputLocation: partial, codec: 'prores', proResProfile: '4444', pixelFormat: 'yuva444p10le', imageFormat: 'png',
        concurrency: 3, muted: true, logLevel: 'error' })
      validateOverlayMedia(await probe(partial), props.durationInFrames, plan.fps)
      fs.renameSync(partial, clip)
    }
    const representative = Math.min(props.durationInFrames - 1, Math.round(props.durationInFrames * 0.6))
    const still = path.join(dir, `overlay-${shot.storyboardNumber}.png`)
    await renderStill({ composition, serveUrl, inputProps: props, browserExecutable, frame: representative,
      output: still, imageFormat: 'png', logLevel: 'error' })
    const globalStart = shot.timelineStart + startFrame / plan.fps
    const base = path.join(dir, `source-${shot.storyboardNumber}.png`)
    await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(globalStart + representative / plan.fps), '-i', plan.sourcePath, '-frames:v', '1', base])
    await sharp(base).composite([{ input: still }]).png().toFile(path.join(dir, `preview-${shot.storyboardNumber}.png`))
    rendered.push({ storyboardNumber: shot.storyboardNumber, clip, globalStart, globalEnd: shot.timelineStart + endFrame / plan.fps,
      frames: props.durationInFrames, still, fingerprint: await digest(clip) })
  }
  save(path.join(dir, 'overlays.json'), { sourceFingerprint: plan.sourceFingerprint, planFingerprint: planFingerprint(plan), rendered })
  return rendered
}

export function compositionArgs(plan, clips, output) {
  const args = ['-hide_banner', '-y', '-filter_complex_threads', '2', '-i', plan.sourcePath]
  for (const clip of clips) args.push('-i', clip.clip)
  const filters = []
  let current = '0:v'
  clips.forEach((clip, index) => {
    filters.push(`[${index + 1}:v]setpts=PTS-STARTPTS+${clip.globalStart.toFixed(6)}/TB[effect${index}]`)
    filters.push(`[${current}][effect${index}]overlay=0:0:format=auto:eof_action=pass:repeatlast=0:enable='between(t,${clip.globalStart.toFixed(6)},${clip.globalEnd.toFixed(6)})'[out${index}]`)
    current = `out${index}`
  })
  args.push('-filter_complex', filters.join(';'), '-map', `[${current}]`, '-map', '0:a:0',
    '-c:v', 'h264_videotoolbox', '-b:v', '6500k', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-fps_mode', 'passthrough',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output)
  return args
}

async function compose(plan, dir, output) {
  if (await digest(plan.sourcePath) !== plan.sourceFingerprint) throw new Error('Source bytes changed')
  if (path.resolve(output) === path.resolve(plan.sourcePath)) throw new Error('Cannot overwrite original video')
  const manifest = json(path.join(dir, 'overlays.json'))
  validateRenderedManifest(plan, manifest)
  const { rendered } = manifest
  for (const clip of rendered) {
    if (await digest(clip.clip) !== clip.fingerprint) throw new Error('Overlay bytes changed')
    validateOverlayMedia(await probe(clip.clip), clip.frames, plan.fps)
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  await new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', compositionArgs(plan, rendered, output), { stdio: ['ignore', 'pipe', 'inherit'] })
    let lastUpdate = 0
    process.stdout.on('data', (data) => {
      const match = data.toString().match(/out_time=([^\n]+)/)
      if (match && Date.now() - lastUpdate > 10000) { console.log(JSON.stringify({ phase: 'compose', time: match[1] })); lastUpdate = Date.now() }
    })
    process.on('error', reject)
    process.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${code}`)))
  })
  const source = await probe(plan.sourcePath); const result = await probe(output)
  const audioHash = async (file) => {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])
    return stdout.trim()
  }
  const originalAudio = await audioHash(plan.sourcePath); const editedAudio = await audioHash(output)
  if (originalAudio !== editedAudio || Math.abs(Number(source.format.duration) - Number(result.format.duration)) > 0.04) {
    throw new Error('Audio or duration changed; edited output is not approved')
  }
  const report = { passed: true, output, url: `http://127.0.0.1:3013/${path.relative(path.join(ROOT, 'data'), output)}`,
    duration: Number(result.format.duration), audioHash: originalAudio, sourceFingerprint: plan.sourceFingerprint,
    outputFingerprint: await digest(output), shots: plan.shots.length, editedShots: rendered.length, bgmAdded: false }
  save(path.join(dir, 'delivery.json'), report)
  console.log(JSON.stringify(report))
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Expected --option value')
    options[argv[index].slice(2)] = argv[index + 1]
  }
  if (!options.dir) throw new Error('--dir is required')
  const dir = path.resolve(options.dir)
  fs.mkdirSync(dir, { recursive: true })
  if (command === 'inventory') return inventory(json(options.snapshot), dir)
  if (command === 'plan') {
    const source = path.resolve(options.source)
    const plan = buildPlan(json(options.snapshot), json(options.selection), source, await digest(source), await probe(source))
    const file = path.join(dir, 'edit-plan.json'); save(file, plan)
    console.log(JSON.stringify({ plan: file, shots: plan.shots.length, edited: plan.shots.filter((s) => s.effects.length).length }))
    return
  }
  if (command === 'render') return render(json(options.plan), dir)
  if (command === 'compose') return compose(json(options.plan), dir, path.resolve(options.output))
  throw new Error('Expected inventory|plan|render|compose')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.stack || error); process.exitCode = 1
})
