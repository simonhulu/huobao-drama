import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-dharma-render-task-'))
process.env.DB_PATH = join(dbDir, 'test.db')

const {
  parseRemotionRenderProgress,
  assertDharmaRenderInputFingerprintStable,
  resolveDharmaBrowserExecutable,
  resolveDharmaPropsBuildMaxRuntime,
  resolveDharmaDeliveryProxyConcurrency,
  resolveDharmaRenderWatchdogConfig,
  resolveDharmaRenderArtifact,
  resolveDharmaRenderConcurrency,
  resolveDharmaRemotionOutputStallMs,
  runDharmaPropsBuildWithDeadline,
  dharmaRenderStageProgressMessage,
  probeDharmaRenderedOutput,
  publishDharmaOutputWithPointerCommit,
  buildDharmaEpisodePublishPatch,
  validateDharmaRenderedOutputContract,
  createDharmaEpisodeRenderHandler,
} = await import('./dharma-episode.js')
const { applyDharmaProductionPreflight, getDharmaProductionGate } = await import('../../dharma-production-gate.js')

test('Dharma render refuses a publish when its inputs changed after preflight', () => {
  assert.doesNotThrow(() => assertDharmaRenderInputFingerprintStable('same', 'same'))
  assert.throws(
    () => assertDharmaRenderInputFingerprintStable('before', 'after'),
    /素材、旁白、BGM 或标题在渲染期间发生变化/,
  )
})

test('Dharma render rejects a payload episode that differs from the durable task scope', async () => {
  const handler = createDharmaEpisodeRenderHandler()
  await assert.rejects(
    handler.run({
      taskId: 1,
      episodeId: 693,
      payload: { episode_id: 694 },
      signal: new AbortController().signal,
      attempts: 1,
      progress() {},
      event() {},
      isCancelRequested: () => false,
    }),
    /episode_id mismatch: task=693, payload=694/,
  )
})

test('Dharma render rejects legacy camelCase controls instead of changing artifact class at execution time', async () => {
  const handler = createDharmaEpisodeRenderHandler()
  await assert.rejects(
    handler.run({
      taskId: 2,
      episodeId: 693,
      payload: { episode_id: 693, maxDurationSec: 60 },
      signal: new AbortController().signal,
      attempts: 1,
      progress() {},
      event() {},
      isCancelRequested: () => false,
    }),
    /canonical snake_case fields/,
  )
})

test('Dharma render only pins an explicit or available local browser executable', () => {
  assert.equal(
    resolveDharmaBrowserExecutable('/opt/render/chrome', 'linux', (candidate) => candidate === '/opt/render/chrome'),
    '/opt/render/chrome',
  )
  assert.throws(
    () => resolveDharmaBrowserExecutable('/missing/chrome', 'linux', () => false),
    /REMOTION_BROWSER_EXECUTABLE 不存在/,
  )
  assert.equal(resolveDharmaBrowserExecutable(undefined, 'linux', () => false), null)
  assert.match(resolveDharmaBrowserExecutable(undefined, 'darwin', () => true) || '', /\.remotion-chrome/)
})

test('Dharma render concurrency uses a conservative CPU-capped default', () => {
  assert.equal(resolveDharmaRenderConcurrency(undefined, 12), 4)
  assert.equal(resolveDharmaRenderConcurrency(undefined, 2), 2)
  assert.equal(resolveDharmaRenderConcurrency('6', 12), 6)
})

test('Dharma render concurrency rejects unsafe or malformed overrides before rendering', () => {
  assert.throws(() => resolveDharmaRenderConcurrency('0', 8), /必须是 1-8 的整数/)
  assert.throws(() => resolveDharmaRenderConcurrency('2.5', 8), /必须是 1-8 的整数/)
  assert.throws(() => resolveDharmaRenderConcurrency('9', 8), /超出安全上限 8/)
  assert.throws(() => resolveDharmaRenderConcurrency('5', 4), /超出安全上限 4/)
})

test('Dharma proxy concurrency stays bounded below the render pool', () => {
  assert.equal(resolveDharmaDeliveryProxyConcurrency(undefined, 12), 2)
  assert.equal(resolveDharmaDeliveryProxyConcurrency(undefined, 2), 1)
  assert.equal(resolveDharmaDeliveryProxyConcurrency('3', 8), 3)
  assert.throws(() => resolveDharmaDeliveryProxyConcurrency('5', 12), /超出安全上限 4/)
  assert.throws(() => resolveDharmaDeliveryProxyConcurrency('zero', 8), /必须是 1-4 的整数/)
})

test('Dharma render watchdog has bounded defaults and rejects unbounded configuration', () => {
  assert.deepEqual(resolveDharmaRenderWatchdogConfig(undefined, undefined), {
    maxRuntimeMs: 2_400_000,
    progressStallMs: 180_000,
  })
  assert.deepEqual(resolveDharmaRenderWatchdogConfig('600000', '120000'), {
    maxRuntimeMs: 600_000,
    progressStallMs: 120_000,
  })
  assert.throws(() => resolveDharmaRenderWatchdogConfig('60000', '60000'), /必须小于/)
  assert.throws(() => resolveDharmaRenderWatchdogConfig('forever', '120000'), /必须是/)
})

test('Dharma render watchdog gives final encode a longer output-aware grace period', () => {
  assert.equal(resolveDharmaRemotionOutputStallMs(180_000), 360_000)
  assert.equal(resolveDharmaRemotionOutputStallMs(60_000), 300_000)
})

test('Dharma props-build deadline is bounded separately from Remotion frame rendering', () => {
  assert.equal(resolveDharmaPropsBuildMaxRuntime(undefined), 900_000)
  assert.equal(resolveDharmaPropsBuildMaxRuntime('600000'), 600_000)
  assert.throws(() => resolveDharmaPropsBuildMaxRuntime('30000'), /超出安全范围/)
})

test('Dharma props-build deadline aborts stuck proxy work and records watchdog evidence', async () => {
  const controller = new AbortController()
  const events: Array<{ type: string; data: any }> = []
  await assert.rejects(
    runDharmaPropsBuildWithDeadline(
      { signal: controller.signal, event: (type, data) => events.push({ type, data }) },
      10,
      (signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('proxy aborted')), { once: true })
      }),
    ),
    /props 构建超过 10ms 时限/,
  )
  assert.deepEqual(events, [{
    type: 'dharma.episode.render.watchdog',
    data: { scope: 'props_build', reason: 'runtime_limit', max_runtime_ms: 10, signal: 'SIGTERM' },
  }])
})

test('Dharma render parses Remotion frame progress without accepting malformed counters', () => {
  assert.deepEqual(parseRemotionRenderProgress('Rendered 42/300'), { current: 42, total: 300 })
  assert.deepEqual(parseRemotionRenderProgress('\u001b[32mRendered 300 / 300\u001b[0m'), { current: 300, total: 300 })
  assert.equal(parseRemotionRenderProgress('Bundling 65%'), null)
  assert.equal(parseRemotionRenderProgress('Rendered 301/300'), null)
})

test('Dharma output validation passes cancellation into ffprobe and never resolves to publish', async () => {
  const controller = new AbortController()
  let receivedSignal: AbortSignal | undefined
  const pendingProbe = probeDharmaRenderedOutput('task-private-render.mp4', controller.signal, async (_command, _args, options) => {
    const signal = options?.signal
    assert.ok(signal)
    receivedSignal = signal
    return await new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true })
    })
  })

  controller.abort()
  await assert.rejects(pendingProbe, { name: 'AbortError' })
  assert.equal(receivedSignal, controller.signal)
})

test('Dharma render gives every durable pipeline stage a stable progress message', () => {
  assert.equal(dharmaRenderStageProgressMessage('preflight'), 'DharmaEpisode 渲染：前置检查')
  assert.equal(dharmaRenderStageProgressMessage('props_build'), 'DharmaEpisode 渲染：准备素材与合成参数')
  assert.equal(dharmaRenderStageProgressMessage('remotion_render'), 'DharmaEpisode 渲染：启动帧渲染')
  assert.equal(dharmaRenderStageProgressMessage('output_validation'), 'DharmaEpisode 渲染：校验交付文件')
  assert.equal(dharmaRenderStageProgressMessage('publish'), 'DharmaEpisode 渲染：发布成片')
  assert.equal(dharmaRenderStageProgressMessage('not-a-stage'), null)
})

test('Dharma output remains staged when the fenced pointer commit loses its lease', () => {
  const deliveryRoot = mkdtempSync(join(tmpdir(), 'huobao-dharma-output-fenced-'))
  const stagedOutputPath = join(deliveryRoot, 'staged.mp4')
  const finalPath = join(deliveryRoot, 'dharma-ep693-task1.mp4')
  writeFileSync(stagedOutputPath, 'private render')

  const committed = publishDharmaOutputWithPointerCommit(
    stagedOutputPath,
    finalPath,
    () => false,
    deliveryRoot,
  )

  assert.equal(committed, false)
  assert.equal(existsSync(stagedOutputPath), true)
  assert.equal(existsSync(finalPath), false)
})

test('Dharma output removes a final orphan when pointer mutation fails after rename', () => {
  const deliveryRoot = mkdtempSync(join(tmpdir(), 'huobao-dharma-output-rollback-'))
  const stagedOutputPath = join(deliveryRoot, 'staged.mp4')
  const finalPath = join(deliveryRoot, 'dharma-ep693-task2.mp4')
  writeFileSync(stagedOutputPath, 'private render')

  assert.throws(() => publishDharmaOutputWithPointerCommit(
    stagedOutputPath,
    finalPath,
    (moveOutput) => {
      moveOutput()
      throw new Error('episode pointer write failed')
    },
    deliveryRoot,
  ), /episode pointer write failed/)

  assert.equal(existsSync(stagedOutputPath), false)
  assert.equal(existsSync(finalPath), false)
})

test('Dharma publishing never overwrites an existing task-specific output', () => {
  const deliveryRoot = mkdtempSync(join(tmpdir(), 'huobao-dharma-output-immutable-'))
  const stagedOutputPath = join(deliveryRoot, 'staged.mp4')
  const finalPath = join(deliveryRoot, 'dharma-ep693-task3.mp4')
  writeFileSync(stagedOutputPath, 'new private render')
  writeFileSync(finalPath, 'existing immutable delivery')

  assert.throws(() => publishDharmaOutputWithPointerCommit(
    stagedOutputPath,
    finalPath,
    (moveOutput) => {
      moveOutput()
      return true
    },
    deliveryRoot,
  ), /task-specific output already exists/)

  assert.equal(existsSync(stagedOutputPath), true)
  assert.equal(readFileSync(finalPath, 'utf8'), 'existing immutable delivery')
})

test('Dharma canary publish records review evidence without replacing video_url or legacy pilot metadata', () => {
  const gate = applyDharmaProductionPreflight(null, {
    fullPlanFingerprint: 'full-v1',
    validatorVersion: 'validator-v1',
    rendererContractVersion: 'renderer-v1',
    report: { valid: true },
    validatedAt: '2026-07-28T05:00:00.000Z',
    canary: {
      requirement: 'required',
      reasons: ['quote_card'],
      fingerprint: 'canary-v1',
      window: {
        storyboardIds: [2, 3, 4],
        storyboardNumbers: [2, 3, 4],
        startMs: 6_000,
        endMs: 24_000,
        durationSec: 18,
      },
    },
  })
  gate.canary.taskId = 301
  const currentMetadata = JSON.stringify({
    dharmaPilot: { status: 'approved', output: 'legacy-pilot.mp4' },
    dharmaProductionGate: gate,
  })
  const patch = buildDharmaEpisodePublishPatch(currentMetadata, {
    kind: 'canary',
    taskId: 301,
    output: 'static/remotion/dharma-ep7-canary-18s-task301.mp4',
    fullPlanFingerprint: 'full-v1',
    canaryFingerprint: 'canary-v1',
    renderedAt: '2026-07-28T05:04:00.000Z',
  })

  assert.equal('videoUrl' in patch, false)
  const metadata = JSON.parse(patch.metadata)
  assert.deepEqual(metadata.dharmaPilot, { status: 'approved', output: 'legacy-pilot.mp4' })
  assert.equal(getDharmaProductionGate(patch.metadata)?.canary.status, 'rendered')
  assert.equal(getDharmaProductionGate(patch.metadata)?.canary.output, 'static/remotion/dharma-ep7-canary-18s-task301.mp4')
})

test('Dharma render gives each formal delivery an immutable task-specific artifact', () => {
  assert.deepEqual(resolveDharmaRenderArtifact(693, 123, undefined, undefined), {
    fileStem: 'dharma-ep693-task123', isPreview: false, isReviewPilot: false,
  })
  assert.deepEqual(resolveDharmaRenderArtifact(693, 123, 60, undefined), {
    fileStem: 'dharma-ep693-pilot-60s-task123', isPreview: true, isReviewPilot: true,
  })
  assert.deepEqual(resolveDharmaRenderArtifact(693, 123, 30, undefined), {
    fileStem: 'dharma-ep693-preview-task123', isPreview: true, isReviewPilot: false,
  })
  assert.deepEqual(resolveDharmaRenderArtifact(693, 123, undefined, [10, 11]), {
    fileStem: 'dharma-ep693-preview-task123', isPreview: true, isReviewPilot: false,
  })
})

test('Dharma output contract accepts the delivery profile and rejects unsupported streams', () => {
  const validProbe = {
    format: { duration: '60.053' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '30/1', nb_frames: '1800' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
  }
  assert.deepEqual(validateDharmaRenderedOutputContract(validProbe, 1_800), {
    durationSec: 60.053,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1280,
    height: 720,
    frameRate: 30,
    frameCount: 1800,
    audioStreamCount: 1,
  })
  assert.throws(
    () => validateDharmaRenderedOutputContract({
      ...validProbe,
      streams: [validProbe.streams[0], { codec_type: 'audio', codec_name: 'mp3' }],
    }, 1_800),
    /必须为 AAC/,
  )
  assert.throws(
    () => validateDharmaRenderedOutputContract({
      ...validProbe,
      streams: [...validProbe.streams, { codec_type: 'audio', codec_name: 'aac' }],
    }, 1_800),
    /只有一个音频流/,
  )
  assert.throws(
    () => validateDharmaRenderedOutputContract({
      ...validProbe,
      streams: [{ ...validProbe.streams[0], nb_frames: '1763' }, validProbe.streams[1]],
    }, 1_800),
    /帧数 1763 与合成帧数 1800 不一致/,
  )
})
