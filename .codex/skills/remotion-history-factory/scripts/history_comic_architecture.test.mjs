import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  agentActions,
  beatCoverageSql,
  budgets,
  compiledExecutionPlan,
  createInitialRun,
  machineActions,
} from './history_comic_pipeline.mjs'
import {
  addFailureLesson,
  lessonPathForErrorCode,
  mappedFailureCodes,
} from './history_comic_lessons.mjs'
import { publishingPackageFingerprint } from '../../remotion-dharma-factory/scripts/dharma_publishing_package.mjs'

const requireFromBackend = createRequire(new URL('../../../../backend/package.json', import.meta.url))
const Database = requireFromBackend('better-sqlite3')
const scriptDir = dirname(fileURLToPath(import.meta.url))
const runnerPath = join(scriptDir, 'history_comic_pipeline.mjs')
const docPath = join(scriptDir, '..', 'references', 'comic-pipeline.md')

const movedValidators = [
  'validateManifest',
  'validatePanelAssets',
  'validateNativeResult',
  'validateTtsTimeline',
  'validateNarrativePlan',
  'assessDeliveryQuality',
  'parseBlackIntervals',
  'extractFfmpegWarnings',
  'parseProgressFrameCount',
  'validateVisualApproval',
  'validateEnvironment',
]

test('runner imports the independent validator and never redefines it', () => {
  const source = readFileSync(runnerPath, 'utf8')
  assert.match(source, /from '\.\/history_comic_validator\.mjs'/u)
  for (const name of movedValidators) {
    assert.equal(
      new RegExp(`function ${name}\\s*\\(`, 'u').test(source),
      false,
      `runner must not redefine ${name}`,
    )
  }
})

test('createInitialRun pins the workflow, plan version, and 15-stage execution plan', () => {
  const run = createInitialRun({
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试',
    creationToken: 'architecture-token',
  })
  assert.equal(run.workflow, 'history-comic-five-v1')
  assert.equal(run.planVersion, 'history-comic-plan-v1')
  assert.deepEqual(run.executionPlan, compiledExecutionPlan)
  assert.deepEqual(compiledExecutionPlan.map((entry) => entry.stage), [
    'intake',
    'environment_check',
    'tts_verify',
    'narrative_plan_verify',
    'design_ensure',
    'generate_ensure',
    'manifest_build',
    'asset_review',
    'props_build',
    'candidate_render',
    'frame_review',
    'publish',
    'delivery_verify',
    'episode_publish',
    'complete',
  ])
  assert.deepEqual(
    compiledExecutionPlan.filter((entry) => entry.gate).map((entry) => [entry.stage, entry.gate]),
    [['asset_review', 'asset_contact_sheet']],
  )
})

function docSection(doc, heading) {
  const index = doc.indexOf(heading)
  assert.notEqual(index, -1, `doc is missing heading: ${heading}`)
  return doc.slice(index)
}

function fencedBlock(section, lang) {
  const match = new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'u').exec(section)
  assert.ok(match, `doc section is missing a fenced ${lang} block`)
  return match[1]
}

test('documented command surface matches the runner usage text', () => {
  const doc = readFileSync(docPath, 'utf8')
  const commandBlock = fencedBlock(docSection(doc, '## Command surface'), 'text')
  const documented = commandBlock.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(/\s+/u)[0])
  const usage = execFileSync(process.execPath, [runnerPath], { encoding: 'utf8' })
  for (const command of documented) {
    assert.ok(usage.includes(command), `usage text is missing documented command: ${command}`)
  }
  // Every usage command line is documented as well.
  const usageCommands = usage.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('--'))
    .map((line) => line.split(/\s+/u)[0])
  assert.deepEqual(usageCommands.sort(), [...documented].sort())
})

test('documented stage machine matches the compiled execution plan', () => {
  const doc = readFileSync(docPath, 'utf8')
  const section = docSection(doc, '## Stage machine')
  const rows = section.split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()).slice(1, -1))
    .filter((cells) => /^\d+$/u.test(cells[0] || ''))
  const documented = rows.map(([index, stage, owner, gate]) => ({
    index: Number(index),
    stage,
    owner,
    gate: gate || null,
  }))
  assert.deepEqual(documented, compiledExecutionPlan.map((entry) => ({
    index: entry.index,
    stage: entry.stage,
    owner: entry.owner,
    gate: entry.gate || null,
  })))
})

test('documented action classes match the runner exports', () => {
  const doc = readFileSync(docPath, 'utf8')
  const block = fencedBlock(docSection(doc, '## Action classes'), 'text')
  const classes = {}
  for (const line of block.split('\n')) {
    const match = /^(machine|agent):\s*(.+)$/u.exec(line.trim())
    if (match) classes[match[1]] = match[2].split(',').map((item) => item.trim()).filter(Boolean)
  }
  assert.deepEqual([...classes.machine].sort(), [...machineActions].sort())
  assert.deepEqual([...classes.agent].sort(), [...agentActions].sort())
})

test('documented budgets match the runner exports', () => {
  const doc = readFileSync(docPath, 'utf8')
  const section = docSection(doc, '## Budgets')
  const rows = section.split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()).slice(1, -1))
    .filter((cells) => /^[a-zA-Z]/u.test(cells[0] || '') && cells[0] !== 'Constant')
  const documented = Object.fromEntries(rows.map(([name, value]) => [name, Number(value)]))
  assert.deepEqual(documented, { ...budgets })
})

test('documented beat coverage SQL matches the runner export byte for byte', () => {
  const doc = readFileSync(docPath, 'utf8')
  const sql = fencedBlock(docSection(doc, '## Beat coverage SQL'), 'sql')
  assert.equal(sql.trim(), beatCoverageSql.trim())
})

function fixtureRunWithActionFailure(runPath) {
  const run = createInitialRun({
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试',
    creationToken: 'architecture-token',
  })
  run.actionFailure = {
    action: 'render-candidate',
    stage: 'candidate_render',
    errors: ['renderer crashed'],
    errorCode: 'RENDER_FAILED',
    failedAt: '2026-01-01T00:00:00.000Z',
  }
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)
  return run
}

test('run command uses exit 75 for an in-turn agent continuation', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-comic-continuation-'))
  const runPath = join(temp, 'run.json')
  fixtureRunWithActionFailure(runPath)

  const execution = spawnSync(process.execPath, [runnerPath, 'run', '--run', runPath], {
    encoding: 'utf8',
  })
  assert.equal(execution.status, 75)
  assert.match(execution.stderr, /AGENT_CONTINUATION_REQUIRED/u)
  const status = JSON.parse(execution.stdout)
  assert.equal(status.status, 'failed')
  assert.equal(status.next_action, 'retry-action')
  assert.equal(status.action_kind, 'agent')
  assert.equal(status.continuation_required, true)
  assert.equal(status.user_handoff_allowed, false)
  assert.equal(readFileSync(runPath, 'utf8').includes('renderer crashed'), true)
})

function fixtureDatabase(temp, style) {
  const dbPath = join(temp, 'test.sqlite')
  const db = new Database(dbPath)
  try {
    db.exec(`
      create table dramas (
        id integer primary key,
        style text,
        title text,
        deleted_at text
      );
      create table episodes (
        id integer primary key,
        drama_id integer,
        title text,
        workflow_type text,
        script_content text,
        bgm_audio_url text,
        opening_hook text,
        cliffhanger text,
        creative_brief_json text,
        cover_prompt text,
        cover_design_json text,
        cover_image_4x3_url text,
        cover_image_3x4_url text,
        metadata text,
        deleted_at text
      );
      insert into dramas (id, style, title, deleted_at) values (3, '${style}', '测试剧', null);
      insert into episodes (id, drama_id, title, workflow_type, script_content, bgm_audio_url, deleted_at)
        values (7, 3, '第一集', 'direct_script', '测试稿件', null, null);
    `)
    const publishingPackage = {
      schema_version: 'dharma-publishing-package/v1',
      title: '第一集',
      opening_hook: '开头钩子',
      cliffhanger: '结尾悬念',
      creative_brief: { stance: '测试立场' },
      cover_design: { main_title: '测试封面', ai_prompt: 'historical scene, no text, no watermark' },
    }
    db.prepare('update episodes set opening_hook = ?, cliffhanger = ?, metadata = ? where id = 7').run(
      publishingPackage.opening_hook,
      publishingPackage.cliffhanger,
      JSON.stringify({ dharmaPublishing: {
        package: publishingPackage,
        package_sha256: publishingPackageFingerprint(publishingPackage),
      } }),
    )
  } finally {
    db.close()
  }
  return dbPath
}

test('fresh start persists one resumable run and emits one next action', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-comic-runner-'))
  const dbPath = fixtureDatabase(temp, 'ink-wash')
  const runPath = join(temp, 'history-comic.run.json')
  const env = { ...process.env, DB_PATH: dbPath }
  const output = execFileSync(process.execPath, [
    runnerPath,
    'start',
    '--episode', '7',
    '--run', runPath,
  ], { encoding: 'utf8', env })
  const status = JSON.parse(output)
  assert.equal(status.stage, 'environment_check')
  assert.equal(status.status, 'ready')
  assert.equal(status.next_action, 'check-environment')
  assert.equal(status.action_kind, 'machine')
  assert.equal(status.checks.run_path, runPath)
  assert.equal(status.checks.episode_id, 7)
  assert.ok(existsSync(runPath))

  // Stdout is a single trimmed line: no pretty printing, no derived
  // accounting block (stage history stays in run.json).
  assert.equal(output.trimEnd().includes('\n'), false)
  assert.equal('accounting' in status.checks, false)

  const next = JSON.parse(execFileSync(process.execPath, [runnerPath, 'next', '--run', runPath], { encoding: 'utf8', env }))
  assert.equal(next.stage, status.stage)
  assert.equal(next.status, status.status)
  assert.equal(next.error_code, status.error_code)
  assert.equal(next.next_action, status.next_action)
  assert.equal(next.checks.run_path, status.checks.run_path)

  // The transition was logged exactly once (next polls the same state).
  const events = readFileSync(join(temp, 'history-comic.events.log'), 'utf8').trim().split('\n')
  assert.equal(events.length, 1)
  assert.equal(JSON.parse(events[0]).event, 'status')
  assert.equal(JSON.parse(events[0]).stage, 'environment_check')
  assert.equal(JSON.parse(events[0]).next_action, 'check-environment')
})

test('start refuses an episode whose drama has no locked visual profile', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-comic-no-style-'))
  const dbPath = fixtureDatabase(temp, '')
  const runPath = join(temp, 'history-comic.run.json')
  const execution = spawnSync(process.execPath, [
    runnerPath,
    'start',
    '--episode', '7',
    '--run', runPath,
  ], { encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath } })
  assert.equal(execution.status, 1)
  assert.match(execution.stderr, /visual profile/u)
  assert.equal(existsSync(runPath), false)
})

test('repair commands re-enter the machine loop before emitting', () => {
  const source = readFileSync(runnerPath, 'utf8')
  for (const command of [
    'retry-action',
    'retry-stage',
    'repair-delivery',
  ]) {
    assert.match(
      source,
      new RegExp(`case '${command}':\\n\\s+return applyAndContinue`, 'u'),
      `${command} must route through applyAndContinue`,
    )
  }
  assert.match(
    source,
    /async function applyAndContinue\(options, effect, extraChecks = \{\}\) \{[\s\S]*?runUntilGate\(runPath, \{ lease \}\)[\s\S]*?emitWorkflowStatus\(status\)/u,
    'applyAndContinue must re-enter the machine loop and emit the workflow status',
  )
  assert.match(
    source,
    /status\.checks = \{ \.\.\.status\.checks, revision_of_run_path: sourceRunPath \}/u,
    'start-new-run must annotate the revision source and re-enter the loop',
  )
})


test('every mapped failure loads exactly one existing lesson and non-failures load none', () => {
  assert.ok(mappedFailureCodes.length > 0)
  for (const code of mappedFailureCodes) {
    const path = lessonPathForErrorCode(code)
    assert.ok(path)
    assert.ok(existsSync(path), `${code} -> ${path}`)
    const status = addFailureLesson({
      stage: 'test', status: 'failed', checks: {}, error_code: code, next_action: 'retry-action',
    })
    assert.equal(status.checks.lesson_path, path)
  }
  for (const statusName of ['ready', 'running', 'paused', 'complete']) {
    const status = addFailureLesson({
      stage: 'test', status: statusName, checks: {}, error_code: 'IGNORED', next_action: null,
    })
    assert.equal('lesson_path' in status.checks, false)
  }
  assert.throws(
    () => addFailureLesson({ stage: 'test', status: 'failed', checks: {}, error_code: 'UNMAPPED_CODE', next_action: null }),
    /no lesson mapping/u,
  )
})

test('retry-action refuses a requeue-exhausted failure without consuming budget', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-comic-requeue-'))
  const runPath = join(temp, 'run.json')
  const run = createInitialRun({
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试',
    creationToken: 'requeue-token',
  })
  run.designRequeueCount = 1
  run.designTask = { id: 42, status: 'succeeded' }
  run.actionFailure = {
    action: 'ensure-design',
    stage: 'design_ensure',
    errors: ['grid.episode_design succeeded but sequences still miss design_json: s1'],
    errorCode: 'DESIGN_INCOMPLETE',
    failedAt: '2026-01-01T00:00:00.000Z',
  }
  run.actionFailureHistory = [run.actionFailure]
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)

  const execution = spawnSync(process.execPath, [runnerPath, 'retry-action', '--run', runPath], { encoding: 'utf8' })
  assert.equal(execution.status, 1)
  assert.match(execution.stderr, /requeue budget is exhausted/u)
  assert.match(execution.stderr, /start-new-run/u)
  const persisted = JSON.parse(readFileSync(runPath, 'utf8'))
  assert.equal(persisted.actionFailure.errorCode, 'DESIGN_INCOMPLETE')
  assert.equal(persisted.actionFailureHistory.length, 1)

  // deriveRunStatus points straight at start-new-run for the same state.
  const status = JSON.parse(execFileSync(process.execPath, [runnerPath, 'status', '--run', runPath], { encoding: 'utf8' }))
  assert.equal(status.status, 'failed')
  assert.equal(status.error_code, 'DESIGN_INCOMPLETE')
  assert.equal(status.next_action, 'start-new-run')
  assert.match(status.checks.lesson_path, /retry-budget\.md$/u)
})

test('a newer runner release refuses mutation without polluting failure history', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-comic-version-'))
  const runPath = join(temp, 'run.json')
  const run = createInitialRun({
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试',
    creationToken: 'version-token',
  })
  run.runnerRelease = 999
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)

  const execution = spawnSync(process.execPath, [runnerPath, 'run', '--run', runPath], { encoding: 'utf8' })
  assert.equal(execution.status, 1)
  assert.match(execution.stderr, /RUNNER_VERSION_MISMATCH/u)
  assert.match(execution.stderr, /start-new-run/u)
  const persisted = JSON.parse(readFileSync(runPath, 'utf8'))
  assert.equal('actionFailure' in persisted, false)
  assert.equal('actionFailureHistory' in persisted, false)
  assert.equal(persisted.runnerRelease, 999)

  // Reads stay best-effort: status still derives without mutating the run.
  const statusExecution = spawnSync(process.execPath, [runnerPath, 'status', '--run', runPath], { encoding: 'utf8' })
  assert.equal(statusExecution.status, 0)
  assert.equal(JSON.parse(statusExecution.stdout).error_code, 'ENVIRONMENT_CHECK_REQUIRED')
  assert.equal(JSON.parse(readFileSync(runPath, 'utf8')).runnerRelease, 999)
})

test('start-new-run archives failure history but never inherits budget counters', () => {
  const temp = mkdtempSync(join(tmpdir(), 'history-comic-revision-'))
  const dbPath = fixtureDatabase(temp, 'ink-wash')
  const env = { ...process.env, DB_PATH: dbPath }
  const runPath = join(temp, 'history-comic.run.json')
  const source = createInitialRun({
    episodeId: 7,
    dramaId: 3,
    style: 'ink-wash',
    title: '测试',
    creationToken: 'revision-token',
  })
  source.designRequeueCount = 1
  source.generateRequeueCount = 1
  source.generateAttempts = { 12: 3 }
  source.actionFailure = {
    action: 'ensure-generate',
    stage: 'generate_ensure',
    errors: ['grid.episode_generate succeeded but storyboards still miss panel images: 12'],
    errorCode: 'GENERATE_INCOMPLETE',
    failedAt: '2026-01-01T00:00:00.000Z',
  }
  source.actionFailureHistory = [
    { action: 'ensure-generate', stage: 'generate_ensure', errorCode: 'GENERATE_TASK_FAILED', failedAt: '2026-01-01T00:00:00.000Z' },
    source.actionFailure,
  ]
  writeFileSync(runPath, `${JSON.stringify(source, null, 2)}\n`)

  const execution = spawnSync(process.execPath, [
    runnerPath,
    'start-new-run',
    '--run', runPath,
    '--actor', 'test-agent',
    '--reason', 'refresh exhausted budgets',
  ], { encoding: 'utf8', env })
  assert.equal(execution.status, 75)
  const status = JSON.parse(execution.stdout)
  const revisionPath = status.checks.run_path
  assert.equal(status.checks.revision_of_run_path, runPath)
  assert.notEqual(revisionPath, runPath)
  const revision = JSON.parse(readFileSync(revisionPath, 'utf8'))
  assert.equal(revision.revisionOf, source.runId)
  assert.equal(revision.revisionActor, 'test-agent')
  assert.equal('actionFailure' in revision, false)
  assert.equal('actionFailureHistory' in revision, false)
  assert.equal('designRequeueCount' in revision, false)
  assert.equal('generateRequeueCount' in revision, false)
  assert.equal('generateAttempts' in revision, false)
  assert.equal(revision.revisionSourceFailures.length, 2)
  assert.equal(revision.revisionSourceFailures[1].errorCode, 'GENERATE_INCOMPLETE')

  // The source run file keeps its own failure history untouched.
  const persistedSource = JSON.parse(readFileSync(runPath, 'utf8'))
  assert.equal(persistedSource.actionFailureHistory.length, 2)
  assert.equal(persistedSource.designRequeueCount, 1)

  // Both runs record the revision handshake in the shared run-dir event log.
  const events = readFileSync(join(temp, 'history-comic.events.log'), 'utf8')
  assert.match(events, /"event":"run_revised"/u)
  assert.match(events, /"event":"run_superseded"/u)
})
