#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { validateNarrativeStoryboardContract } from './narrative_storyboard_contract.mjs'
import {
  buildNonGraphicConstraint,
  planSemanticMotion,
  requireNarrationAnchoredWaypointWindows,
  selectImageRecoveryAction,
} from './narrative_storyboard_runtime.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const apiBase = (process.env.HUOBAO_API_BASE || 'http://127.0.0.1:5679').replace(/\/$/, '')
const planPath = path.join(root, 'data/temp/project-8-narrative-storyboard-plan.json')
const outputRoot = path.join(root, 'data/static/remotion/project-8/narrative-storyboard')
const sheetDir = path.join(outputRoot, 'sheets')
const panelDir = path.join(outputRoot, 'panels')
const finalDir = path.join(outputRoot, 'finals')
const statePath = path.join(root, 'data/temp/project-8-narrative-storyboard-production-state.json')
const manifestPath = path.join(outputRoot, 'hierarchy-manifest.json')
const manifestMarkdownPath = path.join(outputRoot, 'hierarchy-manifest.md')
const propsPath = path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-props.json')
const timingPath = path.join(root, 'data/temp/project-8-narrative-storyboard-alignment/project-8-narrative-storyboard-pilot-89s.timing.json')
const pilotAudioSource = path.join(root, 'data/temp/project-8-narrative-storyboard-pilot-89s.mp3')
const pilotAudioDestination = path.join(outputRoot, 'project-8-pilot-89s.mp3')
const openingVideoDir = path.join(outputRoot, 'video')
const openingVideoPath = path.join(openingVideoDir, 'opening-imperial-hunt-grok.mp4')
const stage = argument('--stage', 'sheets')
const force = process.argv.includes('--force')
const configId = Number(argument('--config-id', '2'))
const runTag = argument('--run-tag', 'v1')
const onlyPanels = new Set(
  argument('--only-panels', '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)

const plan = validateNarrativeStoryboardContract(JSON.parse(fs.readFileSync(planPath, 'utf8')))
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { schemaVersion: 1, projectId: 8, sheets: {}, panels: {}, finals: {} }

const sheets = [
  {
    id: 'sheet-01',
    sequenceId: 'seq-01-hunting-death',
    title: 'Death at Ganquan',
    subtitle: 'Hunt, body, false account, hidden arrow',
    columns: 3,
    rows: 2,
    panelIds: ['panel-01', 'panel-02', 'panel-03', 'panel-04', 'panel-05', 'panel-06'],
    crops: [
      [0.013, 0.177, 0.316, 0.350], [0.342, 0.177, 0.316, 0.350], [0.671, 0.177, 0.316, 0.350],
      [0.013, 0.590, 0.316, 0.350], [0.342, 0.590, 0.316, 0.350], [0.671, 0.590, 0.316, 0.350],
    ],
  },
  {
    id: 'sheet-02a',
    sequenceId: 'seq-02-assault-and-response',
    title: 'The Blow Wei Qing Buried',
    subtitle: 'Approach, accuse, strike, suppress',
    columns: 3,
    rows: 2,
    panelIds: ['panel-07', 'panel-08', 'panel-09', 'panel-10', 'panel-11'],
    crops: [
      [0.022, 0.195, 0.310, 0.320], [0.342, 0.195, 0.310, 0.320], [0.662, 0.195, 0.310, 0.320],
      [0.135, 0.585, 0.347, 0.342], [0.505, 0.585, 0.347, 0.342],
    ],
  },
  {
    id: 'sheet-02b',
    sequenceId: 'seq-02-assault-and-response',
    title: 'The Answer at Ganquan',
    subtitle: 'Draw, kill, elevate, compare',
    columns: 2,
    rows: 2,
    panelIds: ['panel-12', 'panel-13', 'panel-14', 'panel-15'],
    crops: [
      [0.017, 0.156, 0.480, 0.372], [0.508, 0.156, 0.480, 0.372],
      [0.017, 0.575, 0.480, 0.374], [0.508, 0.575, 0.480, 0.374],
    ],
  },
  {
    id: 'sheet-03',
    sequenceId: 'seq-03-wei-qing-childhood',
    title: 'Before Wei Qing Had Power',
    subtitle: 'Birth, rejection, exile to the flock',
    columns: 2,
    rows: 2,
    panelIds: ['panel-16', 'panel-17', 'panel-18', 'panel-19'],
    crops: [
      [0.017, 0.147, 0.473, 0.367], [0.511, 0.147, 0.473, 0.367],
      [0.017, 0.565, 0.473, 0.402], [0.511, 0.565, 0.473, 0.402],
    ],
  },
]

const identityGuide = [
  'Character continuity: Emperor Wu is a composed middle-aged Han emperor in black imperial robes with restrained dark-red trim and a ceremonial crown.',
  'Huo Qubing is a lean young Han cavalry commander in dark lamellar armor with a muted red cloak and a recurved bow.',
  'Li Gan is a sturdy adult Han officer in worn dark armor with a square jaw.',
  'Wei Qing is an older calm Han general in blue-black robes or armor, broad-shouldered, with restrained expression.',
  'Young Wei Qing is a thin nine-year-old boy in an oversized rough gray tunic, tied hair, and worn straw shoes.',
].join('\n')

const identityLines = {
  emperor: 'Emperor Wu is a composed middle-aged Han emperor in black imperial robes with restrained dark-red trim and a ceremonial crown.',
  huo: 'Huo Qubing is a lean young Han cavalry commander in dark lamellar armor with a muted red cloak and a recurved bow.',
  li: 'Li Gan is a sturdy adult Han officer in worn dark armor with a square jaw.',
  wei: 'Wei Qing is an older calm Han general in blue-black robes or armor, broad-shouldered, with restrained expression.',
  youngWei: 'Young Wei Qing is a thin nine-year-old boy in an oversized rough gray tunic, tied hair, and worn straw shoes.',
  youngWeiPastoral: 'Young historical Wei Qing has tied dark hair, a simple loose gray tunic, and straw shoes; portray him respectfully in an ordinary Western Han pastoral setting.',
}

const narrativeActionOverrides = {
  'panel-03': '官员指向盖布担架旁清晰的鹿蹄印，向噤声群臣宣布这是猎场鹿群造成的意外。',
  'panel-04': '视线越过李敢肩头，霍去病在猎场另一端刚刚放箭；箭矢穿过纵深，李敢失去平衡，事件因果清楚可见但不展示伤口。',
  'panel-06': '从猎场箭头匹配切入卫青府邸，卫青破裂的臂甲已被布带包住，李敢握着兵器站在近处，明确揭出此前冲突。',
  'panel-10': '卫青后退撞上案几，破裂的臂甲和散落器物显示冲突后果，李敢停在挥击后的姿态。',
  'panel-11': '卫青按住已经包扎的手臂，抬手遣散冲入的侍从，门扇随后合拢。',
  'panel-13': '沿箭矢方向切到李敢从马背失去平衡，披风与马身遮住接触位置，前后地标和行进方向保持一致。',
  'panel-15': '同一条纵深轴线上，前景卫青关闭府门压下冲突，远景霍去病越过盖布担架，形成单画面因果对照而非分屏。',
  'panel-19': '少年卫青接过羊鞭，带着羊群沿冷风荒坡走向牧场，郑家院门留在远处。',
}

const panelRiskTags = {
  'panel-03': ['covered_aftermath'],
  'panel-04': ['weapon_contact'],
  'panel-06': ['covered_injury', 'weapon_contact'],
  'panel-10': ['covered_injury', 'weapon_contact'],
  'panel-11': ['covered_injury'],
  'panel-13': ['weapon_contact'],
  'panel-15': ['covered_aftermath'],
  'panel-19': ['minor_hardship'],
}

const continuityReferencePanelIds = {
  'panel-03': ['panel-01', 'panel-02'],
  'panel-04': ['panel-01', 'panel-02'],
  'panel-05': ['panel-03'],
  'panel-06': ['panel-02'],
  'panel-07': ['panel-06'],
  'panel-08': ['panel-06', 'panel-07'],
  'panel-09': ['panel-07', 'panel-08'],
  'panel-10': ['panel-08', 'panel-09'],
  'panel-11': ['panel-06', 'panel-10'],
  'panel-12': ['panel-04'],
  'panel-13': ['panel-04', 'panel-12'],
  'panel-14': ['panel-06', 'panel-12'],
  'panel-15': ['panel-06', 'panel-13'],
  'panel-16': ['panel-14'],
  'panel-17': ['panel-16'],
  'panel-18': ['panel-16', 'panel-17'],
  'panel-19': ['panel-18'],
}

const panelSpecificConstraints = {
  'panel-03': 'Show a non-graphic official aftermath: Li Gan is fully concealed beneath a plain cloth on a low stretcher, with no visible body, blood, wounds, gore, or exposed remains. An official points to clear deer hoofprints beside the stretcher while the gathered ministers remain silent; the staged deer-accident explanation must be visually legible.',
  'panel-04': 'Depict the decisive action without graphic impact: Huo Qubing has just released the bowstring in the distant hunting field, one arrow crosses the deep frame toward Li Gan, and Li Gan loses balance from the saddle with the contact fully concealed by cloak and horse. No blood, wound, gore, exposed remains, or close-up injury.',
  'panel-06': 'The prior assault is legible from Wei Qing\'s split arm guard, defensive posture, and Li Gan\'s weapon. Keep the injury fully covered by a dark cloth wrap; no blood, open wound, gore, or exposed tissue.',
  'panel-10': 'Show the consequence through Wei Qing\'s recoil, broken arm guard, and overturned desk objects. The arm remains covered by robe and armor; no blood, open wound, gore, or exposed tissue.',
  'panel-11': 'Wei Qing\'s arm is already wrapped in a clean dark bandage while he dismisses the witnesses. No blood, open wound, gore, or exposed tissue.',
  'panel-13': 'Show Li Gan losing balance and falling from the horse at long distance, with cloak and horse concealing the contact. No visible arrow impact, blood, wound, gore, or exposed remains.',
  'panel-15': 'No child is present. Keep one physically coherent palace-gate space with adult Wei Qing restraining attendants in the foreground and adult Huo Qubing riding beyond the same gate past a fully covered stretcher in the deep background; no visible body or injury, no vertical divider, and no split-screen composition.',
  'panel-19': 'Present a calm, non-graphic historical pastoral departure: young Wei Qing walks behind a flock toward open grazing land while the family courtyard remains visible in the distance. No distress, injury, punishment, restraint, threat, or dangerous interaction.',
}

const finalStyle = [
  'Visual profile cold_ink_spatial: use 3D rendering for spatial depth, architectural volume, physically credible light, depth of field, and material response; use 2D treatment for characters, rough black ink contours, cel-shaded shadow masses, flat color blocks, dry-brush grain, paper texture, and slight print misregistration.',
  'Palette: cold blue-gray, ink green, and deep indigo environments, with restrained dark red and small fire-gold accents only where narratively motivated.',
  'The result must look like hand-drawn 2D historical animation figures embedded in a convincing dimensional Han-dynasty environment, never photoreal people and never raw glossy game CG.',
].join('\n')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function allPanels() {
  return plan.sequences.flatMap((sequence) => sequence.panels.map((panel) => {
    const beat = sequence.beats.find((candidate) => candidate.id === panel.beatId)
    return { ...panel, beat, sequence }
  }))
}

function sheetPrompt(spec) {
  const sequence = plan.sequences.find((candidate) => candidate.id === spec.sequenceId)
  const panelById = new Map(sequence.panels.map((panel) => [panel.id, panel]))
  const beatById = new Map(sequence.beats.map((beat) => [beat.id, beat]))
  const beats = spec.panelIds.map((panelId, index) => {
    const panel = panelById.get(panelId)
    const beat = beatById.get(panel.beatId)
    return `P${String(index + 1).padStart(2, '0')} / ${panel.description} / ${beat.description}`
  }).join('\n')
  const isIncompleteGrid = spec.panelIds.length < spec.columns * spec.rows
  const layout = spec.rows === 3
    ? 'Use a very small header band. Make every panel exactly the same size and preserve a strict 3-column by 3-row grid.'
    : isIncompleteGrid
      ? `Reserve the upper band for the two header lines. Use ${spec.columns} panels in the first row and center the remaining ${spec.panelIds.length - spec.columns} equal-size panels in the incomplete last row.`
      : `Reserve the upper band for the two header lines, then use a strict ${spec.columns}-column by ${spec.rows}-row grid.`
  return [
    `Create one balanced 16:9 landscape clean monochrome 2D storyboard line-sketch sheet with exactly ${spec.panelIds.length} panels.`,
    '',
    '[HEADER]',
    'Minimal header with crisp typography and one thin rule; show only:',
    `"${spec.title}"`,
    `"${spec.subtitle}"`,
    '',
    '[BOARD]',
    `${layout} Clear gutters and natural P## reading order. Every panel is a landscape 16:9 composition. Preserve exact panel count and order over decoration.`,
    'Panel headers use only `P## / compact camera angle + shot size / short beat`.',
    '',
    '[STYLE]',
    'Clean monochrome 2D storyboard line sketch on white paper: sparse single-pass graphite-gray contours, simplified featureless pose figures, minimal construction marks, and only essential set geometry.',
    'No fills, wash, hatching, shading, shadows, ambient occlusion, color, texture, 3D volume, finished illustration, dense or repeated lines, facial detail, anatomy detail, clothing detail, or surface detail.',
    '',
    '[CONTINUITY]',
    identityGuide,
    'Keep screen direction, doors, architecture, weapons, body positions, and action consequences continuous within each narrated action group.',
    '',
    '[RULES]',
    `Exactly ${spec.panelIds.length} panels. Only the two header lines and panel headers are visible. No panel text, arrows, icons, insets, extra panels, duplicates, ghost poses, speech balloons, effect words, signatures, logos, or watermarks.`,
    '',
    '[BEATS]',
    'Draw one storyboard panel per visual beat:',
    beats,
  ].join('\n')
}

function finalPrompt(panel) {
  const panelNumber = Number(panel.id.replace('panel-', ''))
  const narrativeAction = narrativeActionOverrides[panel.id] || panel.beat.description
  const relevantIdentities = panelNumber <= 5
    ? [identityLines.emperor, identityLines.huo, identityLines.li]
    : panelNumber <= 6
      ? [identityLines.wei, identityLines.li]
      : panelNumber <= 11
        ? [identityLines.wei, identityLines.li]
        : panelNumber <= 15
          ? [identityLines.emperor, identityLines.huo, identityLines.li, identityLines.wei]
          : panelNumber === 16
          ? [identityLines.wei, identityLines.huo, identityLines.youngWei]
            : panelNumber === 19
              ? [identityLines.youngWeiPastoral]
              : [identityLines.youngWei]
  const panelSpecificConstraint = [
    panelSpecificConstraints[panel.id] || '',
    buildNonGraphicConstraint(panelRiskTags[panel.id] || []),
  ].filter(Boolean).join(' ')
  return [
    `Use the supplied storyboard crop only for staging, camera angle, framing, subject positions, action direction, and major geometry for ${panel.id}. Ignore all sketch lines, borders, labels, and paper artifacts.`,
    'Any additional supplied images control only recurring character identity, wardrobe, architecture, palette, and screen direction. Do not copy their action, pose, framing, or prior scene state into this shot.',
    `Narrative action: ${narrativeAction}`,
    `Shot design: ${panel.description}`,
    `Relevant character continuity only:\n${relevantIdentities.join('\n')}`,
    panelSpecificConstraint,
    finalStyle,
    'Historical world: Western Han dynasty, period-correct architecture, lamellar armor, robes, tack, weapons, furniture, and social behavior. Keep the action physically credible and immediately legible without narration.',
    'Composition: one coherent cinematic 16:9 frame, one decisive focus, strong foreground-midground-background depth, readable silhouettes, no split screen, no collage, no inset, no duplicate person, no decorative frame.',
    'Strict clean image: absolutely no visible text, Chinese characters, Latin letters, numbers, captions, handwriting, signs, logos, signatures, UI, borders, panel headers, or watermark.',
  ].join('\n')
}

function finalReferenceImages(panelId) {
  const storyboardReference = state.panels[panelId]?.localPath
  if (!storyboardReference) throw new Error(`Missing cropped storyboard reference for ${panelId}`)
  const continuityReferences = (continuityReferencePanelIds[panelId] || [])
    .map((referencePanelId) => state.finals[referencePanelId]?.localPath)
    .filter((localPath) => localPath && fs.existsSync(sourcePath(localPath)))
  return Array.from(new Set([storyboardReference, ...continuityReferences])).slice(0, 6)
}

async function request(url, init = {}) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${response.status}: ${JSON.stringify(body).slice(0, 800)}`)
  return Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
}

async function submitImage({ frameType, prompt, referenceImages = [] }) {
  const created = await request(`${apiBase}/api/v1/images`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      config_id: configId,
      aspect_ratio: '16:9',
      frame_type: frameType,
      prompt,
      reference_images: referenceImages,
    }),
  })
  if (!created?.id) throw new Error(`Image request ${frameType} did not return a generation id`)
  return { generationId: created.id, taskId: created.task_id || created.taskId || null }
}

async function waitForImage(generationId, label) {
  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    const row = await request(`${apiBase}/api/v1/images/${generationId}`)
    if (row?.status === 'completed' && row.localPath) return row
    if (row?.status === 'failed') throw new Error(`${label} failed: ${row.errorMsg || row.lastErrorDetail || 'unknown provider error'}`)
    process.stdout.write(`${label}: ${row?.status || 'pending'}\n`)
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  throw new Error(`${label} timed out`)
}

function sourcePath(localPath) {
  return path.join(root, 'data', String(localPath).replace(/^\/+/, ''))
}

function copyGenerated(row, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(sourcePath(row.localPath), destination)
}

function saveState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

async function produceSheets() {
  fs.mkdirSync(sheetDir, { recursive: true })
  for (const spec of sheets) {
    const destination = path.join(sheetDir, `${spec.id}.png`)
    if (!force && state.sheets[spec.id]?.status === 'completed' && fs.existsSync(destination)) {
      process.stdout.write(`${spec.id}: reused ${destination}\n`)
      continue
    }
    const frameType = `project8-narrative-${spec.id}-${runTag}`
    const submitted = await submitImage({ frameType, prompt: sheetPrompt(spec) })
    state.sheets[spec.id] = { ...submitted, frameType, prompt: sheetPrompt(spec), status: 'submitted' }
    saveState()
    const row = await waitForImage(submitted.generationId, spec.id)
    copyGenerated(row, destination)
    state.sheets[spec.id] = { ...state.sheets[spec.id], status: 'completed', sourceLocalPath: row.localPath, localPath: path.relative(path.join(root, 'data'), destination) }
    saveState()
  }
}

function probeDimensions(file) {
  const output = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' })
  const stream = JSON.parse(output).streams?.[0]
  if (!stream?.width || !stream?.height) throw new Error(`Cannot read image dimensions: ${file}`)
  return stream
}

function cropPanels() {
  fs.mkdirSync(panelDir, { recursive: true })
  for (const spec of sheets) {
    const input = path.join(sheetDir, `${spec.id}.png`)
    if (!fs.existsSync(input)) throw new Error(`Missing storyboard sheet ${input}`)
    const { width, height } = probeDimensions(input)
    spec.panelIds.forEach((panelId, index) => {
      const [nx, ny, nw, nh] = spec.crops[index]
      const x = Math.round(width * nx)
      const y = Math.round(height * ny)
      const w = Math.round(width * nw / 2) * 2
      const h = Math.round(height * nh / 2) * 2
      const destination = path.join(panelDir, `${panelId}.png`)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', destination])
      state.panels[panelId] = {
        sheetId: spec.id,
        crop: { x, y, width: w, height: h },
        localPath: path.relative(path.join(root, 'data'), destination),
      }
    })
  }
  saveState()
}

async function runPool(items, concurrency, worker) {
  let next = 0
  const failures = []
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const current = items[next]
      next += 1
      try {
        await worker(current)
      } catch (error) {
        failures.push({ id: current.id, error })
      }
    }
  })
  await Promise.all(runners)
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      failures.map(({ id, error }) => `${id}: ${error.message}`).join('\n'),
    )
  }
}

async function produceFinals() {
  fs.mkdirSync(finalDir, { recursive: true })
  const panels = allPanels().filter((panel) => onlyPanels.size === 0 || onlyPanels.has(panel.id))
  if (onlyPanels.size > 0) {
    const knownPanelIds = new Set(allPanels().map((panel) => panel.id))
    const unknownPanelIds = [...onlyPanels].filter((panelId) => !knownPanelIds.has(panelId))
    if (unknownPanelIds.length > 0) throw new Error(`Unknown --only-panels values: ${unknownPanelIds.join(', ')}`)
  }
  await runPool(panels, 3, async (panel) => {
    const destination = path.join(finalDir, `${panel.id}.png`)
    const existing = state.finals[panel.id]
    const initialAction = selectImageRecoveryAction({
      force,
      localExists: fs.existsSync(destination),
      stateStatus: existing?.status,
    })
    if (initialAction === 'reuse') {
      process.stdout.write(`${panel.id}: reused ${destination}\n`)
      return
    }
    if (!force && existing?.generationId && existing.status === 'submitted') {
      const row = await request(`${apiBase}/api/v1/images/${existing.generationId}`)
      const recoveryAction = selectImageRecoveryAction({
        force,
        localExists: fs.existsSync(destination),
        stateStatus: existing.status,
        providerStatus: row?.status,
      })
      if (recoveryAction === 'adopt' && row.localPath) {
        copyGenerated(row, destination)
        state.finals[panel.id] = {
          ...existing,
          status: 'completed',
          sourceLocalPath: row.localPath,
          localPath: path.relative(path.join(root, 'data'), destination),
        }
        saveState()
        process.stdout.write(`${panel.id}: reconciled generation ${existing.generationId}\n`)
        return
      }
      if (recoveryAction === 'wait') {
        const completed = await waitForImage(existing.generationId, panel.id)
        copyGenerated(completed, destination)
        state.finals[panel.id] = {
          ...existing,
          status: 'completed',
          sourceLocalPath: completed.localPath,
          localPath: path.relative(path.join(root, 'data'), destination),
        }
        saveState()
        process.stdout.write(`${panel.id}: resumed generation ${existing.generationId}\n`)
        return
      }
      process.stdout.write(`${panel.id}: generation ${existing.generationId} failed; submitting targeted retry\n`)
    }
    const referenceImages = finalReferenceImages(panel.id)
    const frameType = `project8-narrative-final-${panel.id}-${runTag}`
    const prompt = finalPrompt(panel)
    const submitted = await submitImage({ frameType, prompt, referenceImages })
    state.finals[panel.id] = { ...submitted, frameType, prompt, referenceImages, status: 'submitted' }
    saveState()
    const row = await waitForImage(submitted.generationId, panel.id)
    copyGenerated(row, destination)
    state.finals[panel.id] = {
      ...state.finals[panel.id],
      status: 'completed',
      sourceLocalPath: row.localPath,
      localPath: path.relative(path.join(root, 'data'), destination),
    }
    saveState()
  })
}

function writeManifest() {
  const hierarchy = plan.sequences.map((sequence) => ({
    id: sequence.id,
    title: sequence.title,
    startMs: sequence.startMs,
    endMs: sequence.endMs,
    storyboardSheets: sheets
      .filter((sheet) => sheet.sequenceId === sequence.id)
      .map((sheet) => state.sheets[sheet.id]?.localPath)
      .filter(Boolean),
    narrationEvents: sequence.events.map((event) => ({
      ...event,
      visualBeats: sequence.beats.filter((beat) => beat.eventId === event.id).map((beat) => {
        const panel = sequence.panels.find((candidate) => candidate.beatId === beat.id)
        const shot = sequence.shots.find((candidate) => {
          if (candidate.source.kind === 'cut') return candidate.source.beatId === beat.id
          return beat.kind === 'waypoint' && candidate.source.waypointGroupId === beat.waypointGroupId && candidate.eventId === beat.eventId
        })
        return {
          ...beat,
          storyboardPanel: {
            ...panel,
            cropLocalPath: state.panels[panel.id]?.localPath || null,
            finalImageLocalPath: state.finals[panel.id]?.localPath || null,
          },
          renderShot: shot || null,
        }
      }),
    })),
  }))
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectId: 8,
    dramaId: 140,
    episodeId: 591,
    visualStyleId: 'cold_ink_spatial',
    audio: 'temp/project-8-narrative-storyboard-pilot-89s.mp3',
    durationMs: plan.durationMs,
    counts: {
      sequences: plan.sequences.length,
      narrationEvents: plan.sequences.reduce((sum, sequence) => sum + sequence.events.length, 0),
      visualBeats: plan.sequences.reduce((sum, sequence) => sum + sequence.beats.length, 0),
      storyboardPanels: plan.sequences.reduce((sum, sequence) => sum + sequence.panels.length, 0),
      renderShots: plan.sequences.reduce((sum, sequence) => sum + sequence.shots.length, 0),
    },
    hierarchy,
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const markdown = [
    '# Project 8 Narrative Storyboard Pilot',
    '',
    `- Duration: ${(plan.durationMs / 1000).toFixed(3)}s`,
    `- Visual style: cold_ink_spatial`,
    `- Structure: ${manifest.counts.sequences} Narrative Sequences / ${manifest.counts.narrationEvents} Narration Events / ${manifest.counts.visualBeats} Visual Beats / ${manifest.counts.storyboardPanels} Storyboard Panels / ${manifest.counts.renderShots} Render Shots`,
    '',
    ...manifest.hierarchy.flatMap((sequence) => [
      `## ${sequence.title} (${formatRange(sequence.startMs, sequence.endMs)})`,
      '',
      ...sequence.storyboardSheets.map((sheet) => `Storyboard sheet: \`${sheet}\``),
      '',
      ...sequence.narrationEvents.flatMap((event) => [
        `### ${event.id} (${formatRange(event.startMs, event.endMs)})`,
        '',
        event.text,
        '',
        ...event.visualBeats.map((beat) => {
          const panel = beat.storyboardPanel
          return `- ${beat.id} [${beat.kind}] -> ${panel.id} -> ${beat.renderShot?.id || 'unmapped'}: ${beat.description}`
        }),
        '',
      ]),
    ]),
  ].join('\n')
  fs.writeFileSync(manifestMarkdownPath, `${markdown}\n`)
  process.stdout.write(`${manifestPath}\n`)
}

function formatRange(startMs, endMs) {
  return `${(startMs / 1000).toFixed(3)}-${(endMs / 1000).toFixed(3)}s`
}

function staticUrl(relativePath) {
  return `${apiBase}/${String(relativePath).replace(/^\/+/, '')}`
}

function renderTimingForShot(sequence, shot) {
  if (shot.source.kind === 'cut') {
    const beat = sequence.beats.find((candidate) => candidate.id === shot.source.beatId)
    return { startMs: beat.startMs, endMs: beat.endMs }
  }
  const event = sequence.events.find((candidate) => candidate.id === shot.eventId)
  return { startMs: event.startMs, endMs: event.endMs }
}

function produceOpeningVideo() {
  if (!force && state.openingVideo?.status === 'completed' && fs.existsSync(openingVideoPath)) {
    process.stdout.write(`opening-video: reused ${openingVideoPath}\n`)
    return
  }
  const sourceImage = path.join(finalDir, 'panel-01.png')
  if (!fs.existsSync(sourceImage)) throw new Error(`Missing opening storyboard render ${sourceImage}`)
  fs.mkdirSync(openingVideoDir, { recursive: true })
  const prompt = [
    'Use the input image as the exact first-frame composition and preserve its cold ink spatial 3D-to-2D historical animation style.',
    'One continuous six-second Western Han imperial winter hunt shot: foreground deer sprint out across the snowy path as the mounted hunting party surges forward, hooves throwing light snow, cloaks and banners responding naturally to speed.',
    'The low lead camera retreats smoothly in front of the riders, then eases slightly sideways as the formation notices something ahead and begins to slow; keep Emperor Wu centered and the same riders, horses, architecture, wardrobe, palette, faces, and screen direction.',
    'Fast readable motion in the first two seconds, continuous real-time action, no cut, no hold, no slow motion, no morphing, no duplicated riders, no collision, no visible injury, no text, logo, subtitle, border, or watermark.',
  ].join(' ')
  process.stdout.write('opening-video: submitting Grok image-to-video generation\n')
  const output = execFileSync('egaki', [
    'video', prompt,
    '--model', 'grok-imagine-video-1.5',
    '--output', openingVideoPath,
    '--duration', '6',
    '--aspect-ratio', '16:9',
    '--resolution', '720p',
    '--input', sourceImage,
    '--json',
  ], {
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (!fs.existsSync(openingVideoPath)) throw new Error(`Grok generation did not create ${openingVideoPath}: ${output.slice(0, 800)}`)
  const duration = Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', openingVideoPath,
  ], { encoding: 'utf8' }).trim())
  state.openingVideo = {
    status: 'completed',
    provider: 'xai-oauth',
    model: 'grok-imagine-video-1.5',
    prompt,
    durationSec: duration,
    sourceImage: path.relative(path.join(root, 'data'), sourceImage),
    localPath: path.relative(path.join(root, 'data'), openingVideoPath),
  }
  saveState()
  process.stdout.write(`opening-video: completed ${duration.toFixed(3)}s\n`)
}

function writeRenderProps() {
  if (!fs.existsSync(timingPath)) throw new Error(`Missing caption timing ${timingPath}`)
  if (!fs.existsSync(pilotAudioSource)) throw new Error(`Missing pilot master audio ${pilotAudioSource}`)
  fs.copyFileSync(pilotAudioSource, pilotAudioDestination)
  const timing = JSON.parse(fs.readFileSync(timingPath, 'utf8'))
  const captions = timing.cues.map((cue, index) => ({ id: `caption-${index + 1}`, text: cue.text, startMs: cue.startMs, endMs: cue.endMs }))
  let renderShotIndex = 0
  const props = {
    durationMs: plan.durationMs,
    audioSrc: staticUrl(path.relative(path.join(root, 'data'), pilotAudioDestination)),
    captions,
    sequences: plan.sequences.map(({ id, title, startMs, endMs }) => ({ id, title, startMs, endMs })),
    shots: plan.sequences.flatMap((sequence) => sequence.shots.map((shot) => {
      const shotIndex = renderShotIndex++
      const timingRange = renderTimingForShot(sequence, shot)
      const event = sequence.events.find((candidate) => candidate.id === shot.eventId)
      if (shot.source.kind === 'cut') {
        const panel = sequence.panels.find((candidate) => candidate.beatId === shot.source.beatId)
        const image = state.finals[panel.id]?.localPath
        if (!image) throw new Error(`Missing final image for ${panel.id}`)
        const openingVideo = shot.id === 'shot-01' && state.openingVideo?.localPath
          ? staticUrl(state.openingVideo.localPath)
          : undefined
        return {
          id: shot.id,
          ...timingRange,
          src: staticUrl(image),
          ...(openingVideo ? { videoSrc: openingVideo } : {}),
          motion: planSemanticMotion({ description: panel.description, eventText: event?.text, index: shotIndex }),
        }
      }
      const waypointBeats = sequence.beats.filter((beat) => beat.kind === 'waypoint' && beat.eventId === shot.eventId && beat.waypointGroupId === shot.source.waypointGroupId)
      const waypointTiming = requireNarrationAnchoredWaypointWindows({ event, beats: waypointBeats, captions })
      const windowsById = new Map(waypointTiming.windows.map((window) => [window.id, window]))
      const waypoints = waypointBeats.map((beat, waypointIndex) => {
        const panel = sequence.panels.find((candidate) => candidate.beatId === beat.id)
        const image = state.finals[panel.id]?.localPath
        if (!image) throw new Error(`Missing final image for ${panel.id}`)
        const window = windowsById.get(beat.id)
        return {
          src: staticUrl(image),
          startMs: window.startMs,
          endMs: window.endMs,
          anchorText: beat.anchorText,
          motion: planSemanticMotion({ description: panel.description, eventText: event?.text, index: shotIndex + waypointIndex }),
        }
      })
      return { id: shot.id, ...timingRange, timingStrategy: waypointTiming.strategy, waypoints }
    })),
  }
  fs.writeFileSync(propsPath, `${JSON.stringify(props, null, 2)}\n`)
  process.stdout.write(`${propsPath}\n`)
}

function finalsAreComplete() {
  return allPanels().every((panel) => {
    const destination = path.join(finalDir, `${panel.id}.png`)
    return state.finals[panel.id]?.status === 'completed' && fs.existsSync(destination)
  })
}

async function main() {
  if (!['sheets', 'crops', 'finals', 'opening-video', 'all'].includes(stage)) throw new Error(`Unknown --stage ${stage}`)
  if (stage === 'sheets' || stage === 'all') await produceSheets()
  if (stage === 'crops') cropPanels()
  if (stage === 'finals' || stage === 'all') {
    cropPanels()
    await produceFinals()
  }
  if (stage === 'opening-video') produceOpeningVideo()
  writeManifest()
  if (stage === 'finals' || stage === 'opening-video' || stage === 'all') {
    if (finalsAreComplete()) writeRenderProps()
    else process.stdout.write('Render props deferred until all final panel images are complete.\n')
  }
  process.stdout.write(`${JSON.stringify({ stage, statePath, manifestPath }, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
