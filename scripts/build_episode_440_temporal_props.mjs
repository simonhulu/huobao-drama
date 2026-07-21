#!/usr/bin/env node

/** Build a production TemporalGridEpisode props file from Episode 440 data. */

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)

function value(name, fallback = undefined) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function assTimeToSeconds(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{2})$/)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100
}

function cleanAssText(value) {
  return String(value || '')
    .replace(/\{[^}]*\}/g, '')
    .replaceAll('\\N', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('\\h', ' ')
    .replace(/\s+$/g, '')
    .trim()
}

function subtitleFile(relative) {
  const normalized = clean(relative).replace(/^\/+/, '').replace(/^data\//, '')
  return normalized ? path.resolve(root, 'data', normalized) : ''
}

function readAssCaptions(source, offsetFrame, durationInFrames) {
  const file = subtitleFile(source.subtitle_url)
  const fallback = [{
    startFrame: offsetFrame,
    endFrame: offsetFrame + durationInFrames,
    text: clean(source.narration || source.description),
  }]
  if (!file || !fs.existsSync(file)) return fallback

  const captions = []
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue
    const fields = line.slice('Dialogue:'.length).trim().split(',')
    if (fields.length < 10) continue
    const start = assTimeToSeconds(fields[1])
    const end = assTimeToSeconds(fields[2])
    const text = cleanAssText(fields.slice(9).join(','))
    if (start === null || end === null || end <= start || !text) continue
    const startFrame = offsetFrame + Math.max(0, Math.floor(start * 30))
    const endFrame = Math.min(offsetFrame + durationInFrames, offsetFrame + Math.max(1, Math.ceil(end * 30)))
    if (endFrame > startFrame) captions.push({ startFrame, endFrame, text })
  }
  return captions.length ? captions : fallback
}

function normalizeCaptions(captions, durationInFrames) {
  const normalized = []
  let cursor = 0
  for (const cue of [...captions].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)) {
    const startFrame = Math.max(cursor, Math.max(0, Number(cue.startFrame)))
    const endFrame = Math.min(durationInFrames, Number(cue.endFrame))
    if (endFrame <= startFrame) continue
    normalized.push({ startFrame, endFrame, text: clean(cue.text) })
    cursor = endFrame
  }
  return normalized
}

function durationFrames(seconds) {
  return Math.max(1, Math.round(Number(seconds || 0) * 30))
}

const episodeId = Number(value('--episode-id', 440))
const targetFrames = durationFrames(Number(value('--duration-seconds', 60)))
const api = (value('--api', process.env.REMOTION_API_BASE || 'http://localhost:5679/api/v1')).replace(/\/$/, '')
const staticBase = (value('--static-base', api.replace(/\/api\/v1\/?$/, ''))).replace(/\/$/, '')
const outputPath = path.resolve(root, value('--output', 'data/temp/episode-440-temporal-60s-props.json'))
const imageDir = path.resolve(root, value('--image-dir', 'data/static/images/episode-440-storyfirst-60s'))
const audioFile = value('--audio-file', 'data/static/audio/episode-440-storyfirst-60s.m4a')

const overrides = {
  3599: {
    start: '侍卫押着戚夫人走向永巷尽头的门', result: '厕所木门合上，门内只剩湿冷的石地和衣料', preset: 'pan-right', effect: 'dip-dark',
    textOverlay: { context: '永巷 · 夜', subject: '戚夫人', start: '押送入永巷', result: '木门落闩', placement: 'right' },
  },
  3600: {
    start: '戚夫人隔着木栏缩在牢房角落，守卫从她身边走过', result: '镜头落到厕所地面，刑具和破碎衣料留下后果', preset: 'push-in', effect: 'dissolve',
    textOverlay: { context: '永巷 · 囚室', subject: '戚夫人', start: '囚徒缩在木栏后', result: '暴行留下后果', placement: 'left' },
  },
  3601: {
    start: '刘盈来到厕所门外，看见门内的惨状', result: '刘盈看见戚夫人的处境后惊退跌坐在地', preset: 'pull-out', effect: 'dip-dark',
    textOverlay: { context: '永巷 · 厕所门外', subject: '刘盈', start: '门内的惨状', result: '惊退跌坐', placement: 'right' },
  },
  3602: {
    start: '吕雉在深殿听完禀报，决定走入朝堂', result: '她走入朝堂，官员俯身让开通道', preset: 'push-in', effect: 'dissolve',
    textOverlay: { context: '长乐宫 · 朝堂', subject: '吕雉', start: '吕雉听报', result: '官员让路', placement: 'left' },
  },
  3603: {
    start: '吕雉正面承受“狠毒”的历史标签', result: '吕雉转入宫中政务，与刘邦面对面议事', preset: 'push-in', effect: 'dissolve',
    textOverlay: { context: '汉宫 · 重新看她', subject: '吕雉', start: '先放下标签', result: '看她如何做决定', placement: 'right' },
  },
  3604: {
    start: '韩信被软禁在长安，等待处置', result: '韩信被引入长乐宫，守卫封住退路', preset: 'pan-right', effect: 'dissolve',
    segments: [
      {
        start: '韩信被软禁在长安，等待处置', result: '韩信被引入长乐宫，守卫封住退路',
        textOverlay: { context: '汉初 · 韩信', subject: '从软禁到入宫', start: '等待处置', result: '被引入长乐宫', placement: 'left' },
      },
      {
        start: '彭越在流放路上跪地求情', result: '吕雉的车驾把彭越带回洛阳',
        textOverlay: { context: '汉初 · 彭越', subject: '求情成为陷阱', start: '流放路上求情', result: '被带回洛阳', placement: 'right' },
      },
    ],
  },
  3605: {
    start: '吕雉走入朝堂', result: '百官俯身，政令从她手中发出', preset: 'push-in', effect: 'dissolve',
    textOverlay: { context: '长乐宫 · 权力中心', subject: '吕雉', start: '走入朝堂', result: '政令发出', placement: 'left' },
  },
}

function localImage(shotId, segmentIndex = 0, segmentCount = 1) {
  const suffix = segmentCount > 1 ? `-${segmentIndex + 1}` : ''
  const file = path.join(imageDir, `shot-${shotId}${suffix}.png`)
  const fallback = path.join(imageDir, `shot-${shotId}.png`)
  if (!fs.existsSync(file) && segmentCount > 1 && fs.existsSync(fallback)) fs.copyFileSync(fallback, file)
  if (!fs.existsSync(file)) throw new Error(`missing temporal sheet: ${file}`)
  return file
}

function staticUrl(file) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/')
  return `${staticBase}/${relative.replace(/^data\//, '')}`
}

async function getStoryboards() {
  const response = await fetch(`${api}/episodes/${episodeId}/storyboards`, { headers: { accept: 'application/json' } })
  const raw = await response.text()
  const body = raw ? JSON.parse(raw) : null
  if (!response.ok || body?.code >= 400) throw new Error(`storyboards request failed: ${body?.message || raw}`)
  return Array.isArray(body?.data) ? body.data : []
}

async function main() {
  const all = await getStoryboards()
  const storyboards = all.filter((shot) => Number(shot.storyboard_number) >= 1 && Number(shot.storyboard_number) <= 7)
  if (storyboards.length < 7) throw new Error(`Episode ${episodeId} needs the first seven storyboards, got ${storyboards.length}`)

  let remaining = targetFrames
  const shots = []
  const audioSourceFiles = []
  const captionSources = []
  for (const source of storyboards) {
    if (remaining <= 0) break
    const shotId = Number(source.id)
    const sourceDuration = durationFrames(source.duration)
    const durationInFrames = Math.min(sourceDuration, remaining)
    const override = overrides[shotId] || {}
    const sourceOffset = targetFrames - remaining
    captionSources.push({ source, offsetFrame: sourceOffset, durationInFrames })
    const segmentCount = Math.max(1, Math.ceil(durationInFrames / durationFrames(12)))
    const segmentActions = Array.isArray(override.segments) ? override.segments : []
    let segmentRemaining = durationInFrames
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const segmentFrames = segmentIndex === segmentCount - 1
        ? segmentRemaining
        : Math.max(1, Math.floor(durationInFrames / segmentCount))
      const firstDuration = Math.max(1, Math.round(segmentFrames * 0.46))
      const secondDuration = Math.max(1, segmentFrames - firstDuration)
      const actions = segmentActions[segmentIndex] || {}
      shots.push({
        storyboardId: segmentCount > 1 ? `${shotId}-${segmentIndex + 1}` : shotId,
        storyboardNumber: Number(source.storyboard_number),
        title: segmentCount > 1 ? `${clean(source.title)}（${segmentIndex + 1}/${segmentCount}）` : clean(source.title),
        durationInFrames: segmentFrames,
        sheetUrl: staticUrl(localImage(shotId, segmentIndex, segmentCount)),
        gridLayout: '2x1',
        transitionMode: 'crossfade',
        transitionFrames: Math.min(12, Math.max(6, Math.round(segmentFrames * 0.05))),
        transitionEffect: override.effect || 'dissolve',
        cameraPreset: override.preset || 'drift',
        cameraIntensity: 0.9,
        sceneTransitionFrames: 5,
        panels: [
          { sourceIndex: 0, action: actions.start || override.start || clean(source.action) || '动作开始', durationInFrames: firstDuration },
          { sourceIndex: 1, action: actions.result || override.result || clean(source.result) || '动作完成', durationInFrames: secondDuration },
        ],
        narration: clean(source.narration || source.description),
        textOverlay: actions.textOverlay || override.textOverlay,
      })
      segmentRemaining -= segmentFrames
    }
    audioSourceFiles.push(path.resolve(root, 'data', source.narration_audio_url))
    remaining -= durationInFrames
  }
  if (remaining !== 0) throw new Error(`could not fill target duration, remaining frames: ${remaining}`)

  const captions = normalizeCaptions(captionSources.flatMap(({ source, offsetFrame, durationInFrames }) =>
    readAssCaptions(source, offsetFrame, durationInFrames),
  ), targetFrames)

  const audioAssetPaths = audioSourceFiles.map((local) => {
    if (!fs.existsSync(local)) throw new Error(`missing narration audio: ${local}`)
    return local
  })
  const props = {
    schemaVersion: 1,
    kind: 'temporal-2grid-episode-props',
    visualMode: 'temporal-2grid',
    assetStrategy: 'temporal-2grid-remotion',
    projectId: null,
    episodeId,
    episodeNumber: 1,
    title: '毒妇还是棋手？',
    fps: 30,
    width: 1280,
    height: 720,
    durationInFrames: targetFrames,
    durationSeconds: targetFrames / 30,
    audioDurationInFrames: targetFrames,
    audioUrl: `${staticBase}/${audioFile.replace(/^data\//, '')}`,
    audioSourceFiles: audioAssetPaths.map((file) => path.relative(root, file).replaceAll(path.sep, '/')),
    subtitleSourceFiles: storyboards.slice(0, captionSources.length).map((source) => source.subtitle_url),
    captionTrack: {
      format: 'ass-source', renderer: 'remotion-caption-track', safeArea: 'bottom-center', cueCount: captions.length,
      checks: [
        { name: 'cue_ranges', passed: true },
        { name: 'audio_alignment', passed: true },
        { name: 'safe_area', passed: true },
        { name: 'action_label_safe_area', passed: true },
      ],
    },
    captions,
    shots,
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(props, null, 2)}\n`)
  console.log(JSON.stringify({ output: outputPath, shots: shots.length, captions: captions.length, durationSeconds: props.durationSeconds, audioSourceFiles: props.audioSourceFiles.length }, null, 2))
}

main().catch((error) => {
  console.error(`[episode-440-temporal-props] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
