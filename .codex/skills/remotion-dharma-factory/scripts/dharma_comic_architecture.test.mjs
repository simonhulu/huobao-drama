import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildManifestBeatSkeleton,
  buildReusedManifest,
  compiledExecutionPlan,
  createInitialRun,
  deriveNextAction,
  DEFAULT_DHARMA_NARRATION_SPEED,
  DEFAULT_DHARMA_NARRATION_VOICE_ID,
  parseDharmaNarrationSpeed,
  parseDharmaScriptDocument,
} from './dharma_comic_pipeline.mjs'
import {
  validateEnvironment,
  validateManifest,
  validateTtsClone,
  validateTtsTimeline,
} from './dharma_comic_validator.mjs'
import {
  addFailureLesson,
  lessonPathForErrorCode,
  mappedFailureCodes,
} from './dharma_comic_lessons.mjs'

const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repoRoot = resolve(scriptDir, '../../../..')
const runnerPath = join(scriptDir, 'dharma_comic_pipeline.mjs')
const validatorPath = join(scriptDir, 'dharma_comic_validator.mjs')

test('runner source imports the independent validator and does not redefine moved validators', () => {
  const runner = readFileSync(runnerPath, 'utf8')
  assert.match(runner, /from '\.\/dharma_comic_validator\.mjs'/u)
  for (const name of [
    'validateManifest',
    'validatePanelAssets',
    'validateNativeResult',
    'validateTtsTimeline',
    'assessDeliveryQuality',
    'parseBlackIntervals',
    'extractFfmpegWarnings',
    'parseProgressFrameCount',
  ]) {
    assert.doesNotMatch(runner, new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`, 'u'))
    assert.match(readFileSync(validatorPath, 'utf8'), new RegExp(`export\\s+function\\s+${name}\\s*\\(`, 'u'))
  }
})

test('every mapped failure loads exactly one existing lesson and non-failures load none', () => {
  assert.ok(mappedFailureCodes.length > 0)
  for (const code of mappedFailureCodes) {
    const path = lessonPathForErrorCode(code)
    assert.ok(path)
    assert.ok(existsSync(path), `${code} -> ${path}`)
    const status = addFailureLesson({
      stage: 'test', status: 'failed', checks: {}, error_code: code, next_action: 'repair',
    })
    assert.equal(status.checks.lesson_path, path)
  }
  for (const statusName of ['ready', 'running', 'blocked', 'complete']) {
    const status = addFailureLesson({
      stage: 'test', status: statusName, checks: {}, error_code: 'IGNORED', next_action: null,
    })
    assert.equal('lesson_path' in status.checks, false)
  }
})

test('fixed run profile and TTS beat plan do not expose a workflow branch', () => {
  const runPath = '/tmp/example/comic-production.run.json'
  const run = createInitialRun({
    scriptPath: '/tmp/example.md',
    scriptHash: 'a'.repeat(64),
    title: '测试标题',
    runPath,
  })
  assert.equal(run.workflow, 'comic-progressive-five-v1')
  assert.equal(run.profile.stylePreset, 'retro-anime-1980s')
  assert.equal(run.profile.imageModel, 'gpt-image-2')
  assert.equal(run.profile.renderer, 'native-comic-v12')
  assert.equal(run.narrationSpeed, DEFAULT_DHARMA_NARRATION_SPEED)
  assert.equal(run.voiceId, DEFAULT_DHARMA_NARRATION_VOICE_ID)
  assert.equal(parseDharmaNarrationSpeed(undefined), 0.85)
  assert.equal(parseDharmaNarrationSpeed('0.95'), 0.95)
  assert.throws(() => parseDharmaNarrationSpeed('0.7'), /between 0.8 and 2.5/u)
  assert.equal(run.planVersion, 'comic-production-plan-v7')
  assert.deepEqual(run.executionPlan, compiledExecutionPlan)
  assert.deepEqual(compiledExecutionPlan.map((step) => step.stage), [
    'intake',
    'environment_check',
    'episode_create',
    'tts_wait',
    'tts_verify',
    'manifest_plan',
    'manifest_validate',
    'image_submit',
    'image_wait',
    'asset_review',
    'props_build',
    'delivery_render',
    'delivery_verify',
    'episode_publish',
    'complete',
  ])
  assert.deepEqual(compiledExecutionPlan.filter((step) => step.gate).map((step) => step.gate), [
    'asset_contact_sheet',
  ])
  const assetReview = compiledExecutionPlan.find((step) => step.stage === 'asset_review')
  assert.match(assetReview.owner, /agent/u)
  assert.ok(assetReview.checks.some((check) => check.includes('user escalation only when undecidable')))
  const deliveryRender = compiledExecutionPlan.find((step) => step.stage === 'delivery_render')
  assert.ok(deliveryRender.checks.some((check) => check.includes('manifest.deliveryOutput')))
  assert.ok(deliveryRender.checks.some((check) => check.includes('no candidate video')))
  const episodeCreate = compiledExecutionPlan.find((step) => step.stage === 'episode_create')
  assert.ok(episodeCreate.checks.some((check) => check.includes('one transaction')))
  assert.ok(episodeCreate.checks.some((check) => check.includes('replay the original IDs')))

  const titles = Array.from({ length: 50 }, (_, index) => ({
    text: `句${index + 1}`,
    time_begin: index * 1000,
    time_end: (index + 1) * 1000,
  }))
  const beats = buildManifestBeatSkeleton(titles, 51)
  assert.equal(beats.length % 5, 0)
  assert.equal(beats[0].startSec, 0)
  assert.ok(beats.every((beat) => beat.narrationText.length > 0))
})

test('final script front matter is metadata and never part of the narration body', () => {
  const parsed = parseDharmaScriptDocument(`---
title: "独立标题"
confirmed_at: "2026-08-08"
gate: "step15-user-confirmed"
---
第一句正文。

---
这是正文里的分隔线。
`)
  assert.equal(parsed.hasFrontMatter, true)
  assert.equal(parsed.metadata.title, '独立标题')
  assert.equal(parsed.metadata.gate, 'step15-user-confirmed')
  assert.equal(parsed.body, '第一句正文。\n\n---\n这是正文里的分隔线。\n')
  assert.doesNotMatch(parsed.body, /confirmed_at|step15-user-confirmed/u)
})

test('TTS-only revisions reuse creative fields without putting image src into the manifest', () => {
  const sourceManifest = {
    textEmphasisVersion: 1,
    panels: Array.from({ length: 5 }, (_, index) => ({
      key: `p_${String(index + 1).padStart(3, '0')}`,
      startSec: index * 10,
      narrationText: `旧旁白${index + 1}`,
      visualProposition: `旧画面命题${index + 1}`,
      semantic: {
        subject_count: 1,
        subjects: '一个人',
        relationship: '独处',
        action: '坐着思考',
        visible_emotion: '平静',
        visual_evidence: '清晰的手和脸',
      },
      continuity: '人物连续性',
      prompt: `冻结画面提示${index + 1}`,
      referencePanelKeys: [],
      ...(index === 0 ? { quote: { text: '新旁白1', kind: 'theme' } } : {}),
    })),
  }
  const plan = {
    beats: sourceManifest.panels.map((panel, index) => ({
      key: panel.key,
      page: 1,
      panel: index + 1,
      startSec: index === 0 ? 0 : index * 11,
      narrationText: `新旁白${index + 1}`,
      ttsTitleStart: index,
      ttsTitleEnd: index,
    })),
  }
  const reused = buildReusedManifest({
    sourceManifest,
    plan,
    run: {
      episodeId: 900,
      dramaId: 901,
      imageConfigId: 80,
      targetDurationSec: 55,
      deliveryOutput: 'data/static/remotion/dharma-comic-revision.mp4',
      scriptPath: '/tmp/script.md',
      scriptHash: 'a'.repeat(64),
      assetReuse: { sourceRunId: 'source-run' },
    },
  })
  assert.equal(reused.episodeId, 900)
  assert.equal(reused.dramaId, 901)
  assert.equal(reused.panels[0].narrationText, '新旁白1')
  assert.equal(reused.panels[0].prompt, '冻结画面提示1')
  assert.equal(reused.panels[0].src, undefined)
  assert.equal(validateManifest(reused, {
    expectedEpisodeId: 900,
    expectedDramaId: 901,
    expectedConfigId: 80,
    expectedTargetDurationSec: 55,
    expectedDeliveryOutput: reused.deliveryOutput,
    expectedBeats: plan.beats,
  }).passed, true)
})

test('validator independently rejects environment, clone, timeline, and manifest defects', () => {
  assert.equal(validateEnvironment({}).error_code, 'ENVIRONMENT_INVALID')
  assert.equal(validateTtsClone({}).error_code, 'TTS_CLONE_INVALID')
  assert.equal(validateTtsTimeline({ titles: [], audioDurationSec: 0 }).error_code, 'TTS_TIMELINE_MISMATCH')
  const metadataTts = validateTtsTimeline({
    titles: [{ text: 'title: "错误标题" confirmed_at: "2026-08-08" gate:', time_begin: 0, time_end: 1000 }],
    audioDurationSec: 1,
  })
  assert.ok(metadataTts.checks.errors.some((error) => error.includes('front matter')))
  assert.equal(validateManifest({}).error_code, 'MANIFEST_INVALID')
})

test('fresh start persists one resumable state and emits one next action', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-comic-runner-'))
  const scriptPath = join(temp, 'input.md')
  const runPath = join(temp, 'run.json')
  writeFileSync(scriptPath, '# 测试\n这是一份最终净稿。\n')
  const output = execFileSync(process.execPath, [
    runnerPath,
    'start',
    '--script', scriptPath,
    '--run', runPath,
  ], { encoding: 'utf8' })
  const status = JSON.parse(output)
  assert.equal(status.stage, 'environment_check')
  assert.equal(status.status, 'ready')
  assert.equal(status.next_action, 'check-environment')
  assert.equal(Object.keys(status).filter((key) => key === 'next_action').length, 1)
  assert.equal(status.checks.run_path, runPath)
  assert.ok(existsSync(runPath))

  const next = JSON.parse(execFileSync(process.execPath, [runnerPath, 'next', '--run', runPath], { encoding: 'utf8' }))
  assert.equal(next.stage, status.stage)
  assert.equal(next.status, status.status)
  assert.equal(next.error_code, status.error_code)
  assert.equal(next.next_action, status.next_action)
  assert.equal(next.checks.run_path, status.checks.run_path)
})

test('fresh start separates front matter title and narration hash', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-comic-front-matter-'))
  const scriptPath = join(temp, 'input.md')
  const runPath = join(temp, 'run.json')
  const script = `---
title: "来自 front matter 的标题"
confirmed_at: "2026-08-08"
---
第一句正文，不应朗读元数据。
`
  writeFileSync(scriptPath, script)
  execFileSync(process.execPath, [
    runnerPath,
    'start',
    '--script', scriptPath,
    '--run', runPath,
  ], { encoding: 'utf8' })
  const run = JSON.parse(readFileSync(runPath, 'utf8'))
  assert.equal(run.title, '来自 front matter 的标题')
  assert.equal(run.scriptHash, createHash('sha256').update(script).digest('hex'))
  assert.equal(run.narrationHash, createHash('sha256').update('第一句正文，不应朗读元数据。\n').digest('hex'))
  assert.equal(run.scriptMetadata.confirmed_at, '2026-08-08')
})

test('ordinary advance never clears a recorded action failure', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-comic-failure-'))
  const scriptPath = join(temp, 'input.md')
  const runPath = join(temp, 'run.json')
  writeFileSync(scriptPath, '# 测试\n最终净稿。\n')
  const run = createInitialRun({
    scriptPath,
    scriptHash: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
    title: '测试',
    runPath,
  })
  run.actionFailure = {
    stage: 'image_wait',
    action: 'wait',
    errorCode: 'IMAGE_TASK_FAILED',
    errors: ['network timeout'],
    failedAt: '2026-01-01T00:00:00.000Z',
  }
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)

  const output = execFileSync(process.execPath, [runnerPath, 'advance', '--run', runPath], { encoding: 'utf8' })
  assert.equal(JSON.parse(output).status, 'failed')
  assert.equal(JSON.parse(output).next_action, 'retry-action')
  assert.equal(JSON.parse(output).action_kind, 'agent')
  assert.equal(JSON.parse(output).continuation_required, true)
  assert.equal(JSON.parse(output).user_handoff_allowed, false)
  assert.equal(readFileSync(runPath, 'utf8').includes('network timeout'), true)
})

test('run command uses exit 75 for an in-turn agent continuation', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-comic-continuation-'))
  const scriptPath = join(temp, 'input.md')
  const runPath = join(temp, 'run.json')
  writeFileSync(scriptPath, '# 测试\n最终净稿。\n')
  const run = createInitialRun({
    scriptPath,
    scriptHash: createHash('sha256').update(readFileSync(scriptPath)).digest('hex'),
    title: '测试',
    runPath,
  })
  run.actionFailure = {
    stage: 'image_wait',
    action: 'wait',
    errorCode: 'IMAGE_TASK_FAILED',
    errors: ['network timeout'],
    failedAt: '2026-01-01T00:00:00.000Z',
  }
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)

  const execution = spawnSync(process.execPath, [runnerPath, 'run', '--run', runPath], {
    encoding: 'utf8',
  })
  assert.equal(execution.status, 75)
  assert.match(execution.stderr, /AGENT_CONTINUATION_REQUIRED/u)
  const status = JSON.parse(execution.stdout)
  assert.equal(status.next_action, 'retry-action')
  assert.equal(status.continuation_required, true)
  assert.equal(status.user_handoff_allowed, false)
})

test('skill contract forbids default human approval stops at visual review', () => {
  const skill = readFileSync(join(scriptDir, '..', 'SKILL.md'), 'utf8')
  assert.match(skill, /review-assets/u)
  assert.match(skill, /view_image/u)
  assert.match(skill, /delivery_render/u)
  assert.match(skill, /directly.*delivery/su)
  assert.doesNotMatch(skill, /frame_review/u)
  assert.doesNotMatch(skill, /publish-candidate/u)
  assert.doesNotMatch(skill, /candidate\.mp4/u)
  assert.doesNotMatch(skill, /素材人工门禁/u)
  assert.doesNotMatch(skill, /页面人工门禁/u)
  assert.doesNotMatch(skill, /禁止代理自行批准/u)
})

test('skill contract pins typography evidence and episode publication before completion', () => {
  const skill = readFileSync(join(scriptDir, '..', 'SKILL.md'), 'utf8')
  assert.match(skill, /native-comic-v12/u)
  assert.match(skill, /LXGW WenKai Screen/u)
  assert.match(skill, /theme.*scripture.*explanation/su)
  assert.match(skill, /deliveryRenderSha256/u)
  assert.doesNotMatch(skill, /checks\.frame_review_index_path/u)
  assert.doesNotMatch(skill, /subtitle:short/u)
  assert.match(skill, /checks\.episode_published_current == true/u)
  assert.match(skill, /checks\.episode_video_url == checks\.expected_episode_video_url/u)
  assert.match(skill, /artifactChain\.episodeVideoUrl/u)
  assert.match(skill, /\/dharma\/episode\/:id\/footage/u)
})

test('footage route and Dharma UI share episodes.video_url as rendered-state truth', () => {
  const route = readFileSync(join(repoRoot, 'backend/src/routes/dharma.ts'), 'utf8')
  const page = readFileSync(join(repoRoot, 'frontend/app/pages/dharma/episode/[id].vue'), 'utf8')
  assert.match(route, /app\.get\('\/episode\/:episodeId\/footage'/u)
  assert.match(route, /video_url:\s*ep\.videoUrl\s*\?\?\s*null/u)
  assert.match(page, /footage\?\.video_url\s*\?\s*'已渲染'/u)
  assert.match(page, /finalVideoUrl\s*=\s*computed\(\(\)\s*=>\s*footage\.value\?\.video_url/u)
})

test('visual review commands resume the machine runner instead of emitting an intermediate machine state', () => {
  const source = readFileSync(runnerPath, 'utf8')
  const start = source.indexOf("      } else {\n        const { context, paths } = runManifestContext(runPath)")
  const end = source.indexOf('\n      }\n    } finally', start)
  assert.ok(start >= 0 && end > start)
  const visualCommandBranch = source.slice(start, end)
  assert.match(visualCommandBranch, /emitWorkflowStatus\(await runUntilGate\(runPath/u)
  assert.doesNotMatch(visualCommandBranch, /emitWorkflowStatus\(currentRunStatus\(runPath\)\)/u)
})

test('SCRIPT_CHANGED start-new-run binds a revision to the changed script bytes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dharma-comic-script-change-'))
  const scriptPath = join(temp, 'input.md')
  const runPath = join(temp, 'run.json')
  writeFileSync(scriptPath, '# 原稿\n第一版。\n')
  const originalHash = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
  const run = createInitialRun({
    scriptPath,
    scriptHash: originalHash,
    title: '原稿',
    runPath,
  })
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(scriptPath, '# 原稿\n第二版，内容已经改变。\n')
  const changedHash = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')

  const changedStatus = JSON.parse(execFileSync(process.execPath, [
    runnerPath, 'next', '--run', runPath,
  ], { encoding: 'utf8' }))
  assert.equal(changedStatus.error_code, 'SCRIPT_CHANGED')
  assert.equal(changedStatus.next_action, 'start-new-run')

  const revisionExecution = spawnSync(process.execPath, [
    runnerPath,
    'start-new-run',
    '--run', runPath,
    '--actor', 'test-agent',
    '--reason', 'bind changed script bytes',
  ], { encoding: 'utf8' })
  assert.equal(revisionExecution.status, 75)
  assert.match(revisionExecution.stderr, /AGENT_CONTINUATION_REQUIRED/u)
  const revisionStatus = JSON.parse(revisionExecution.stdout)
  const revisionPath = revisionStatus.checks.run_path
  const revision = JSON.parse(readFileSync(revisionPath, 'utf8'))
  assert.notEqual(revisionPath, runPath)
  assert.equal(revision.scriptHash, changedHash)
  assert.equal(revision.revisionSourceScriptHash, originalHash)
  assert.equal(revision.revisionInputChanged, true)
  assert.equal(revision.revisionOf, run.runId)
})

test('factory intake creates drama and episode through one atomic idempotent endpoint', () => {
  const source = readFileSync(runnerPath, 'utf8')
  const start = source.indexOf('async function createEpisodeForRun')
  const end = source.indexOf('\nfunction ttsTaskById', start)
  assert.ok(start >= 0 && end > start)
  const body = source.slice(start, end)
  assert.match(body, /request\('\/dharma\/factory\/intake'/u)
  assert.doesNotMatch(body, /request\('\/dramas'/u)
  assert.doesNotMatch(body, /\/import-script/u)
})

test('TTS retry budget intent is persisted before the task mutation', () => {
  const source = readFileSync(runnerPath, 'utf8')
  const start = source.indexOf('function retryTtsTask')
  const end = source.indexOf('\nexport function ttsFailureRecovery', start)
  assert.ok(start >= 0 && end > start)
  const body = source.slice(start, end)
  const intent = body.indexOf('run.ttsRetryIntent =')
  const persisted = body.indexOf('saveRun(runPath, run)', intent)
  const mutation = body.indexOf('const db = database(false)')
  assert.ok(intent >= 0 && persisted > intent && mutation > persisted)
})

test('post-manifest transition status always contains a single deterministic action', () => {
  const manifest = { panels: [{ key: 'p_001', referencePanelKeys: [] }] }
  const state = { manifestHash: 'x', jobs: [{ key: 'p_001', status: 'failed', attempt: 1 }], stages: {} }
  const result = deriveNextAction(manifest, state, { manifestHash: 'x' })
  assert.equal(result.next_action, 'retry-failed --key p_001')
  assert.equal(result.status, 'ready')
  assert.equal(result.action_kind, 'machine')
  assert.equal('lesson_path' in result.checks, false)
})
