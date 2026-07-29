/**
 * dharma-props 纯函数单元测试：段落合并 + 视频窗口时间适配 + 素材指派解析。
 * 时序定位（locateNarrationWindow / masterTimeAt）由 grid-story-props.test.ts 锁定，这里不重复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeDharmaSegments,
  fillDharmaVisualGaps,
  findDharmaSegmentAssetReuse,
  findAdjacentDharmaSegmentRoleMismatches,
  findNonAdjacentDharmaAssetReuse,
  mergeDharmaNarrationWindows,
  deriveDharmaBgmMix,
  prepareDharmaDeliveryAssets,
  runDharmaAudioLoudnessProcess,
  runDharmaMediaProbeProcess,
  normalizeDharmaQuoteText,
  normalizeDharmaVisualRole,
  normalizeDharmaVisualSemanticContract,
  buildDharmaSemanticGenerationPrompt,
  resolveVideoWindowTiming,
  resolveSegmentLeadCell,
  resolveDharmaCrossfadeLeadFrames,
  resolveDharmaSegmentFrameWindow,
  resolveDharmaAssignedAssetPath,
  scopeDharmaTimingWindowsToDuration,
  resolveDharmaQuoteTimingWindow,
  extendDharmaVisualTail,
  buildDharmaCanaryFingerprintFromSnapshot,
  validateDharmaSegmentPlaybackPlan,
  isDharmaReviewPilotOutputDuration,
  parseDharmaCell,
  requiresDharmaProductionVisualPlan,
  summarizeDharmaVisualPlan,
  validateDharmaProductionVisualPlan,
  validateDharmaCreativeProductionPlan,
  MIN_PLAYBACK_RATE,
  type DharmaWindowInput,
  type DharmaCell,
} from './dharma-props.js'
import {
  DHARMA_EMOTIONAL_INK_STYLE_ID,
  DHARMA_MINIMAL_LIGHT_STYLE_ID,
  DHARMA_SURREAL_DREAM_STYLE_ID,
  type DharmaEmotion,
} from './dharma-image-style.js'
import type { DharmaDeliveryProxyResult } from './dharma-delivery-proxy.js'

test('runDharmaAudioLoudnessProcess: 响度扫描运行时不会阻塞事件循环', async () => {
  let settled = false
  const scan = runDharmaAudioLoudnessProcess(
    process.execPath,
    ['-e', 'setTimeout(() => process.stderr.write("done"), 250)'],
    { timeoutMs: 2_000 },
  ).then((result) => {
    settled = true
    return result
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  const result = await scan
  assert.deepEqual(result, { status: 0, stderr: 'done' })
})

test('runDharmaMediaProbeProcess: 媒体时长探测不阻塞事件循环且保留 stdout', async () => {
  let settled = false
  const probe = runDharmaMediaProbeProcess(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("12.5"), 250)'],
    { timeoutMs: 2_000 },
  ).then((result) => {
    settled = true
    return result
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  const result = await probe
  assert.deepEqual(result, { status: 0, stdout: '12.5', stderr: '' })
})

test('runDharmaMediaProbeProcess: 取消会终止卡住的探测子进程', async () => {
  const controller = new AbortController()
  const probe = runDharmaMediaProbeProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)'],
    { signal: controller.signal, timeoutMs: 2_000 },
  )
  setTimeout(() => controller.abort(), 25)
  assert.equal(await probe, null)
})

test('normalizeDharmaQuoteText: 金句长度有可读性门禁', () => {
  assert.deepEqual(normalizeDharmaQuoteText(' 应无所住，而生其心 '), { text: '应无所住，而生其心' })
  const overlong = normalizeDharmaQuoteText('一'.repeat(37))
  assert.equal('error' in overlong, true)
  if ('error' in overlong) assert.match(overlong.error, /最多 36 个字符/)
})

test('normalizeDharmaVisualRole: 只接受受控的静室视觉角色', () => {
  assert.deepEqual(normalizeDharmaVisualRole('temple_interior'), { role: 'temple_interior' })
  assert.deepEqual(normalizeDharmaVisualRole('ritual'), { role: 'ritual' })
  assert.deepEqual(normalizeDharmaVisualRole('temple_exterior'), { role: 'temple_exterior' })
  assert.deepEqual(normalizeDharmaVisualRole('contemplative_nature'), { role: 'contemplative_nature' })
  assert.deepEqual(normalizeDharmaVisualRole('human_relationship'), { role: 'human_relationship' })
  const missing = normalizeDharmaVisualRole(undefined)
  const invented = normalizeDharmaVisualRole('park')
  assert.equal('error' in missing, true)
  assert.equal('error' in invented, true)
})

test('人物关系镜头必须持久化可见的叙事证据，氛围镜头不能冒充', () => {
  const missing = normalizeDharmaVisualSemanticContract({
    role: 'human_relationship',
    kind: 'image',
    shotFunction: undefined,
    semantic: undefined,
  })
  assert.equal('error' in missing, true)

  const semantic = {
    subject_count: 2,
    subjects: '成年子女与母亲',
    relationship: '彼此深爱但控制与自主发生冲突',
    action: '母亲松开缠在子女手腕上的红线，子女向门外迈步',
    visible_emotion: '母亲克制地不舍，子女平静而坚定',
    visual_evidence: '红线已经松开但两人的手仍然相触，明确表现放手不等于断绝关系',
  }
  const normalized = normalizeDharmaVisualSemanticContract({
    role: 'human_relationship',
    kind: 'image',
    shotFunction: 'narrative_illustration',
    semantic,
  })
  assert.equal('error' in normalized, false)
  if ('error' in normalized) return
  assert.equal(normalized.semantic?.subjectCount, 2)
  assert.match(
    buildDharmaSemanticGenerationPrompt(normalized.shotFunction, normalized.semantic),
    /红线已经松开.*放手不等于断绝关系/,
  )

  const video = normalizeDharmaVisualSemanticContract({
    role: 'human_relationship',
    kind: 'video',
    shotFunction: 'narrative_illustration',
    semantic,
  })
  assert.equal('error' in video, true)
})

test('requiresDharmaProductionVisualPlan: 全量 60 秒 pilot 和任意时长预算都必须校验整集视觉计划', () => {
  assert.equal(requiresDharmaProductionVisualPlan({}), true)
  assert.equal(requiresDharmaProductionVisualPlan({ maxDurationSec: 60 }), true)
  assert.equal(requiresDharmaProductionVisualPlan({ maxDurationSec: 30 }), true)
  assert.equal(requiresDharmaProductionVisualPlan({ onlyStoryboardIds: [] }), true)
  assert.equal(requiresDharmaProductionVisualPlan({ onlyStoryboardIds: [101] }), false)
})

test('canary fingerprint is scoped to its risk window but binds audio, BGM, and renderer contract', () => {
  const snapshot = {
    rendererContractVersion: 'renderer-v1',
    episode: {
      preTtsAudio: 'audio:100:1',
      bgm: 'bgm:200:1',
    },
    storyboards: [
      {
        id: 12,
        number: 2,
        narration: '窗口内旁白',
        description: '窗口内画面',
        gridCells: '{"dharma":1}',
        asset: 'video:a:10:1',
        startMs: 6_000,
        endMs: 12_000,
      },
    ],
  }
  const current = buildDharmaCanaryFingerprintFromSnapshot(snapshot)

  assert.equal(
    buildDharmaCanaryFingerprintFromSnapshot({ ...snapshot }),
    current,
    'changes outside the serialized risk window do not invalidate the canary',
  )
  for (const changed of [
    { ...snapshot, rendererContractVersion: 'renderer-v2' },
    { ...snapshot, episode: { ...snapshot.episode, preTtsAudio: 'audio:101:2' } },
    { ...snapshot, episode: { ...snapshot.episode, bgm: 'bgm:201:2' } },
    { ...snapshot, storyboards: [{ ...snapshot.storyboards[0], narration: '窗口内旁白已变化' }] },
    { ...snapshot, storyboards: [{ ...snapshot.storyboards[0], asset: 'video:b:10:1' }] },
    { ...snapshot, storyboards: [{ ...snapshot.storyboards[0], startMs: 7_000 }] },
  ]) {
    assert.notEqual(buildDharmaCanaryFingerprintFromSnapshot(changed), current)
  }
})

test('scopeDharmaTimingWindowsToDuration: pilot 保留跨界 storyboard 到最后完整 TTS 片段', () => {
  const timeline = {
    stream: '甲乙丙丁',
    spans: [
      { charStart: 0, charEnd: 2, beginSec: 0, endSec: 52 },
      { charStart: 2, charEnd: 3, beginSec: 52, endSec: 58 },
      { charStart: 3, charEnd: 4, beginSec: 58, endSec: 64 },
    ],
  }
  const scope = scopeDharmaTimingWindowsToDuration([
    { startMs: 0, endMs: 52_000, charStart: 0, charEnd: 2, narration: '甲乙', id: 1 },
    { startMs: 52_000, endMs: 64_000, charStart: 2, charEnd: 4, narration: '丙丁', id: 2 },
  ], 60, timeline)
  assert.equal(scope.durationInFrames, 1_800)
  assert.equal(scope.visualTailEndMs, 60_000)
  assert.deepEqual(scope.windows, [
    { startMs: 0, endMs: 52_000, charStart: 0, charEnd: 2, narration: '甲乙', id: 1 },
    { startMs: 52_000, endMs: 58_000, charStart: 2, charEnd: 3, narration: '丙', id: 2 },
  ])
})

test('resolveDharmaQuoteTimingWindow: 金句只覆盖主时间轴中的经文短语', () => {
  const timeline = {
    stream: '前言应无所住而生其心后语',
    spans: [
      { charStart: 0, charEnd: 2, beginSec: 22.42, endSec: 26.8 },
      { charStart: 2, charEnd: 10, beginSec: 26.8, endSec: 28.2 },
      { charStart: 10, charEnd: 12, beginSec: 28.2, endSec: 30.322 },
    ],
  }
  const window = resolveDharmaQuoteTimingWindow({
    narration: timeline.stream,
    charStart: 0,
    charEnd: timeline.stream.length,
    startMs: 22_420,
    endMs: 30_322,
  }, '应无所住而生其心', timeline)

  assert.deepEqual(window, { startMs: 26_350, endMs: 29_800 })
  assert.equal(resolveDharmaQuoteTimingWindow({
    narration: timeline.stream,
    charStart: 0,
    charEnd: timeline.stream.length,
    startMs: 22_420,
    endMs: 30_322,
  }, '画面里不存在的句子', timeline), null)
})

test('extendDharmaVisualTail: last complete narration segment covers the remaining review-pilot frames', () => {
  const extended = extendDharmaVisualTail([
    { kind: 'video', src: 'static/stock/a.mp4', startMs: 0, endMs: 58_766, storyboardNumbers: [1, 2] },
  ], 60_000)
  assert.equal(extended.length, 1)
  assert.equal(extended[0].endMs, 60_000)
})

test('isDharmaReviewPilotOutputDuration: only a frame-accurate 60-second output is approvable', () => {
  assert.equal(isDharmaReviewPilotOutputDuration(60), true)
  assert.equal(isDharmaReviewPilotOutputDuration(60.053), true)
  assert.equal(isDharmaReviewPilotOutputDuration(60.101), false)
  assert.equal(isDharmaReviewPilotOutputDuration(58.816), false)
  assert.equal(isDharmaReviewPilotOutputDuration(undefined), false)
})

function seg(n: number, startMs: number, endMs: number, kind: 'video' | 'image', src: string): DharmaWindowInput {
  return { storyboardNumber: n, startMs, endMs, kind, src }
}

test('mergeDharmaSegments: 相邻同素材视频分镜合并为一个段落', () => {
  const merged = mergeDharmaSegments([
    seg(1, 0, 8000, 'video', 'static/stock/a.mp4'),
    seg(2, 8000, 16000, 'video', 'static/stock/a.mp4'),
    seg(3, 16000, 24000, 'video', 'static/stock/b.mp4'),
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged[0].storyboardNumbers, [1, 2])
  assert.equal(merged[0].startMs, 0)
  assert.equal(merged[0].endMs, 16000)
  assert.deepEqual(merged[1].storyboardNumbers, [3])
})

test('mergeDharmaSegments: 素材变更即段落边界，即使素材相同但不相邻也不合并', () => {
  const merged = mergeDharmaSegments([
    seg(1, 0, 5000, 'video', 'static/stock/a.mp4'),
    seg(2, 5000, 10000, 'video', 'static/stock/b.mp4'),
    seg(3, 10000, 15000, 'video', 'static/stock/a.mp4'),
  ])
  assert.equal(merged.length, 3)
})

test('resolveSegmentLeadCell: 每个独立段落保留自己的画面参数', () => {
  const merged = mergeDharmaSegments([
    seg(1, 0, 5000, 'video', 'static/stock/a.mp4'),
    seg(2, 5000, 10000, 'video', 'static/stock/b.mp4'),
    seg(3, 10000, 15000, 'video', 'static/stock/c.mp4'),
  ])
  const cells = new Map<number, DharmaCell>([
    [1, { dharma: 1, role: 'contemplative_nature', video: { src: 'static/stock/a.mp4', grade: 'ink_dark', focusX: 30, sourceStartSec: 1 } }],
    [2, { dharma: 1, role: 'ritual', video: { src: 'static/stock/b.mp4' } }],
    [3, { dharma: 1, role: 'temple_interior', video: { src: 'static/stock/c.mp4', grade: 'warm_dawn', focusX: 70, sourceStartSec: 4 } }],
  ])

  assert.deepEqual(resolveSegmentLeadCell(merged[0], cells).video, cells.get(1)?.video)
  assert.deepEqual(resolveSegmentLeadCell(merged[2], cells).video, cells.get(3)?.video)
})

test('findNonAdjacentDharmaAssetReuse: 相邻分镜共用一个视频段落允许', () => {
  const reuse = findNonAdjacentDharmaAssetReuse([
    { storyboardNumber: 1, kind: 'video', src: 'static/stock/a.mp4' },
    { storyboardNumber: 2, kind: 'video', src: 'static/stock/a.mp4' },
    { storyboardNumber: 3, kind: 'video', src: 'static/stock/b.mp4' },
  ])
  assert.deepEqual(reuse, [])
})

test('findNonAdjacentDharmaAssetReuse: A-B-A 必须失败，来源参数不能绕过门禁', () => {
  const reuse = findNonAdjacentDharmaAssetReuse([
    { storyboardNumber: 1, kind: 'video', src: 'static/stock/a.mp4', sourceKey: '/canonical/a.mp4' },
    { storyboardNumber: 2, kind: 'video', src: 'static/stock/b.mp4', sourceKey: '/canonical/b.mp4' },
    { storyboardNumber: 3, kind: 'video', src: 'static/stock/a-alias.mp4', sourceKey: '/canonical/a.mp4' },
  ])
  assert.equal(reuse.length, 1)
  assert.deepEqual(reuse[0].storyboardRanges, [{ start: 1, end: 1 }, { start: 3, end: 3 }])
})

test('findNonAdjacentDharmaAssetReuse: 静态图也不能在后续段落复用', () => {
  const reuse = findNonAdjacentDharmaAssetReuse([
    { storyboardNumber: 1, kind: 'image', src: 'static/image/a.png' },
    { storyboardNumber: 2, kind: 'image', src: 'static/image/b.png' },
    { storyboardNumber: 3, kind: 'image', src: 'static/image/a.png' },
  ])
  assert.equal(reuse.length, 1)
})

test('findNonAdjacentDharmaAssetReuse: 相邻静态图也不能复用，因为它们不是同一个视觉段', () => {
  const reuse = findNonAdjacentDharmaAssetReuse([
    { storyboardNumber: 1, kind: 'image', src: 'static/image/a.png' },
    { storyboardNumber: 2, kind: 'image', src: 'static/image/a.png' },
  ])
  assert.equal(reuse.length, 1)
})

test('findNonAdjacentDharmaAssetReuse: 同一生成任务可把一个静态图用于连续审查段落', () => {
  const reuse = findNonAdjacentDharmaAssetReuse([
    { storyboardNumber: 1, kind: 'image', src: 'static/images/ai-segment.png', generatedSegmentTaskId: 73 },
    { storyboardNumber: 2, kind: 'image', src: 'static/images/ai-segment.png', generatedSegmentTaskId: 73 },
  ])
  assert.deepEqual(reuse, [])
})

test('findDharmaSegmentAssetReuse: task-owned adjacent static segments remain valid at render preflight', () => {
  const reuse = findDharmaSegmentAssetReuse([
    { kind: 'image', src: 'static/images/ai-segment.png', startMs: 0, endMs: 5_000, storyboardNumbers: [1], generatedSegmentTaskId: 73 },
    { kind: 'image', src: 'static/images/ai-segment.png', startMs: 5_000, endMs: 10_000, storyboardNumbers: [2], generatedSegmentTaskId: 73 },
  ])
  assert.deepEqual(reuse, [])
})

test('findAdjacentDharmaSegmentRoleMismatches: 同源相邻视频不能靠改角色伪造神圣覆盖率', () => {
  const mismatches = findAdjacentDharmaSegmentRoleMismatches([
    { storyboardNumber: 1, kind: 'video', src: 'static/stock/a.mp4', sourceKey: '/canonical/a.mp4', role: 'contemplative_nature' },
    { storyboardNumber: 2, kind: 'video', src: 'static/stock/a-alias.mp4', sourceKey: '/canonical/a.mp4', role: 'ritual' },
  ])
  assert.deepEqual(mismatches, [{
    src: 'static/stock/a-alias.mp4',
    storyboardNumbers: [1, 2],
    roles: ['contemplative_nature', 'ritual'],
  }])
})

test('findAdjacentDharmaSegmentRoleMismatches: 相邻同源视频的相同角色仍可合并', () => {
  assert.deepEqual(findAdjacentDharmaSegmentRoleMismatches([
    { storyboardNumber: 1, kind: 'video', src: 'static/stock/a.mp4', role: 'ritual' },
    { storyboardNumber: 2, kind: 'video', src: 'static/stock/a.mp4', role: 'ritual' },
  ]), [])
})

test('findDharmaSegmentAssetReuse: TTS 空隙不把相邻同源视频误判为第二个段落', () => {
  const segments = mergeDharmaSegments([
    seg(1, 0, 5000, 'video', 'static/stock/a.mp4'),
    seg(2, 7000, 12000, 'video', 'static/stock/a.mp4'),
  ])
  const reuse = findDharmaSegmentAssetReuse(segments)
  assert.deepEqual(reuse, [])
})

test('prepareDharmaDeliveryAssets: 同一源只处理一次，并保留 cache / source / created 统计', async () => {
  const calls: string[] = []
  const events: string[] = []
  const resultFor = (sourcePath: string, cacheStatus: DharmaDeliveryProxyResult['cacheStatus']): DharmaDeliveryProxyResult => ({
    sourcePath,
    deliveryPath: `${sourcePath}.delivery.mp4`,
    proxyPath: cacheStatus === 'source' ? null : `${sourcePath}.delivery.mp4`,
    cacheStatus,
    sourceDimensions: { width: 1920, height: 1080 },
    sourceDurationSec: 20,
    deliveryDurationSec: 20,
  })

  const prepared = await prepareDharmaDeliveryAssets(
    ['/tmp/dharma-a.mp4', '/tmp/dharma-a.mp4', '/tmp/dharma-b.mp4', '/tmp/dharma-c.mp4'],
    {
      ensureProxy: async (sourcePath) => {
        calls.push(sourcePath)
        if (sourcePath.endsWith('a.mp4')) return resultFor(sourcePath, 'hit')
        if (sourcePath.endsWith('b.mp4')) return resultFor(sourcePath, 'miss')
        return resultFor(sourcePath, 'source')
      },
      onDeliveryProxy: (result) => events.push(result.cacheStatus),
    },
  )

  assert.deepEqual(calls, ['/tmp/dharma-a.mp4', '/tmp/dharma-b.mp4', '/tmp/dharma-c.mp4'])
  assert.deepEqual(events, ['hit', 'miss', 'source'])
  assert.equal(prepared.summary.source, 1)
  assert.equal(prepared.summary.cacheHits, 1)
  assert.equal(prepared.summary.created, 1)
  assert.ok(prepared.summary.elapsedMs >= 0)
  assert.equal(prepared.bySourcePath.get('/tmp/dharma-b.mp4')?.deliveryPath, '/tmp/dharma-b.mp4.delivery.mp4')
})

test('prepareDharmaDeliveryAssets: 受控并发不会串行化所有首次 proxy', async () => {
  let active = 0
  let peak = 0
  const makeResult = (sourcePath: string): DharmaDeliveryProxyResult => ({
    sourcePath, deliveryPath: sourcePath, proxyPath: sourcePath, cacheStatus: 'miss', sourceDimensions: { width: 1920, height: 1080 }, sourceDurationSec: 20, deliveryDurationSec: 20,
  })
  const prepared = await prepareDharmaDeliveryAssets(['/tmp/a.mp4', '/tmp/b.mp4', '/tmp/c.mp4'], {
    concurrency: 2,
    ensureProxy: async (sourcePath) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return makeResult(sourcePath)
    },
  })
  assert.equal(peak, 2)
  assert.equal(prepared.summary.created, 3)
})

test('mergeDharmaNarrationWindows: 合并短停顿，避免 BGM 在句间抽动', () => {
  assert.deepEqual(mergeDharmaNarrationWindows([
    { startFrame: 0, endFrame: 90 },
    { startFrame: 95, endFrame: 150 },
    { startFrame: 180, endFrame: 240 },
  ]), [
    { startFrame: 0, endFrame: 150 },
    { startFrame: 180, endFrame: 240 },
  ])
})

test('resolveDharmaCrossfadeLeadFrames: props builder budgets exactly the frames Remotion mounts early', () => {
  assert.equal(resolveDharmaCrossfadeLeadFrames(300, 0), 0)
  assert.equal(resolveDharmaCrossfadeLeadFrames(300, 1), 24)
  assert.equal(resolveDharmaCrossfadeLeadFrames(15, 1), 5)
})

test('mergeDharmaNarrationWindows: 合并包络覆盖范围内的短停顿，避免 BGM 回弹', () => {
  assert.deepEqual(mergeDharmaNarrationWindows([
    { startFrame: 0, endFrame: 100 },
    { startFrame: 120, endFrame: 200 },
  ]), [{ startFrame: 0, endFrame: 200 }])
})

test('deriveDharmaBgmMix: 热母带会被降到人声以下并在说话时再闪避', () => {
  const mix = deriveDharmaBgmMix(
    { integratedLufs: -27.8, truePeakDb: -4.9, loudnessRangeLu: 4 },
    { integratedLufs: -9.3, truePeakDb: 0, loudnessRangeLu: 5 },
    500,
  )
  assert.ok(mix.volume < 0.03)
  assert.ok(mix.narrationVolume < mix.volume)
  assert.equal(mix.targetLufs, -41.8)
})

test('deriveDharmaBgmMix: 安静长曲可按实测响度提高，而不会沿用错误的固定小音量', () => {
  const mix = deriveDharmaBgmMix(
    { integratedLufs: -27.8, truePeakDb: -4.9, loudnessRangeLu: 4 },
    { integratedLufs: -33.1, truePeakDb: -11.5, loudnessRangeLu: 12.2 },
    500,
  )
  assert.ok(mix.volume > 0.3)
  assert.ok(mix.volume < 0.5)
})

test('deriveDharmaBgmMix: 短 loop 不得进入长口播', () => {
  assert.throws(() => deriveDharmaBgmMix(
    { integratedLufs: -28, truePeakDb: -5, loudnessRangeLu: 4 },
    { integratedLufs: -12, truePeakDb: -1, loudnessRangeLu: 4 },
    36,
  ), /低于 180s 下限/)
})

test('summarizeDharmaVisualPlan: 覆盖率和早期神圣画面都从真实窗口相对起点计算', () => {
  const summary = summarizeDharmaVisualPlan([
    { startMs: 8_000, endMs: 20_000, role: 'contemplative_nature' },
    { startMs: 20_000, endMs: 50_000, role: 'ritual' },
    { startMs: 50_000, endMs: 68_000, role: 'temple_interior' },
  ])
  assert.equal(summary.totalCoverageMs, 60_000)
  assert.equal(summary.sacredCoverageMs, 48_000)
  assert.equal(summary.sacredCoverageRatio, 0.8)
  assert.equal(summary.firstSacredStartOffsetMs, 12_000)
  assert.equal(summary.coverageMsByRole.contemplative_nature, 12_000)
  assert.equal(summary.coverageMsByRole.ritual, 30_000)
})

test('validateDharmaProductionVisualPlan: 60% 神圣覆盖率和相对 25 秒时限都必须满足', () => {
  assert.doesNotThrow(() => validateDharmaProductionVisualPlan([
    { startMs: 12_000, endMs: 37_000, role: 'contemplative_nature' },
    { startMs: 37_000, endMs: 112_000, role: 'temple_interior' },
  ]))

  assert.throws(() => validateDharmaProductionVisualPlan([
    { startMs: 0, endMs: 10_000, role: 'contemplative_nature' },
    { startMs: 10_000, endMs: 24_000, role: 'ritual' },
  ]), /神圣素材覆盖率/)

  assert.throws(() => validateDharmaProductionVisualPlan([
    { startMs: 12_000, endMs: 38_001, role: 'contemplative_nature' },
    { startMs: 38_001, endMs: 112_000, role: 'temple_exterior' },
  ]), /前 25s 内必须进入/)
})

test('mergeDharmaSegments: 普通静态图不合并，避免把偶然重复伪装成连续段落', () => {
  const merged = mergeDharmaSegments([
    seg(1, 0, 5000, 'image', 'static/img/a.png'),
    seg(2, 5000, 10000, 'image', 'static/img/a.png'),
  ])
  assert.equal(merged.length, 2)
})

test('mergeDharmaSegments: 同一任务生成的连续 AI 图片合并并只启动一次 Ken Burns', () => {
  const merged = mergeDharmaSegments([
    { ...seg(1, 0, 5000, 'image', 'static/img/ai.png'), generatedSegmentTaskId: 73 },
    { ...seg(2, 5000, 10000, 'image', 'static/img/ai.png'), generatedSegmentTaskId: 73 },
  ])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].storyboardNumbers, [1, 2])
  assert.equal(merged[0].endMs, 10_000)
})

test('validateDharmaCreativeProductionPlan: 情绪弧线、三风格和 50% AI 关键图共同通过', () => {
  const image = (src: string, taskId: number, move: 'push' | 'hold') => ({
    src,
    generatedSegmentTaskId: taskId,
    move,
  })
  const windows = [
    { storyboardNumber: 1, startMs: 0, endMs: 10_000, cell: { dharma: 1 as const, emotion: 'curiosity' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: image('static/images/curiosity.png', 1, 'push') } },
    { storyboardNumber: 2, startMs: 10_000, endMs: 20_000, cell: { dharma: 1 as const, emotion: 'stillness' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/stillness.mp4' } } },
    { storyboardNumber: 3, startMs: 20_000, endMs: 30_000, cell: { dharma: 1 as const, emotion: 'tension' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: image('static/images/tension.png', 2, 'push') } },
    { storyboardNumber: 4, startMs: 30_000, endMs: 40_000, cell: { dharma: 1 as const, emotion: 'acceptance' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/acceptance.mp4' } } },
    { storyboardNumber: 5, startMs: 40_000, endMs: 50_000, cell: { dharma: 1 as const, emotion: 'insight' as const, styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID, image: image('static/images/insight.png', 3, 'hold'), quote: { text: '允许边界存在' } } },
    { storyboardNumber: 6, startMs: 50_000, endMs: 60_000, cell: { dharma: 1 as const, emotion: 'release' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/release.mp4' } } },
  ]

  const summary = validateDharmaCreativeProductionPlan(windows, {
    verifiedGeneratedImageTaskIds: new Set([1, 2, 3]),
  })
  assert.deepEqual(summary.styleIds, [
    DHARMA_SURREAL_DREAM_STYLE_ID,
    DHARMA_EMOTIONAL_INK_STYLE_ID,
    DHARMA_MINIMAL_LIGHT_STYLE_ID,
  ])
  assert.deepEqual(summary.emotionSequence, ['curiosity', 'stillness', 'tension', 'acceptance', 'insight', 'release'])
  assert.equal(summary.generatedImageSegmentCount, 3)
  assert.equal(summary.generatedImageCoverageRatio, 0.5)
  assert.equal(summary.videoCoverageRatio, 0.5)
})

test('validateDharmaCreativeProductionPlan: 有出处的经文可在当前情绪风格中 hold 揭示', () => {
  const image = (src: string, taskId: number, move: 'push' | 'pull' | 'hold') => ({
    src,
    generatedSegmentTaskId: taskId,
    move,
  })
  const windows = [
    { storyboardNumber: 1, startMs: 0, endMs: 10_000, cell: { dharma: 1 as const, emotion: 'curiosity' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: image('static/images/curiosity.png', 1, 'push') } },
    { storyboardNumber: 2, startMs: 10_000, endMs: 20_000, cell: { dharma: 1 as const, emotion: 'curiosity' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: image('static/images/scripture.png', 2, 'hold'), quote: { text: '应无所住而生其心', source: '《金刚经》' } } },
    { storyboardNumber: 3, startMs: 20_000, endMs: 30_000, cell: { dharma: 1 as const, emotion: 'stillness' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/stillness.mp4' } } },
    { storyboardNumber: 4, startMs: 30_000, endMs: 40_000, cell: { dharma: 1 as const, emotion: 'tension' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: image('static/images/tension.png', 3, 'push') } },
    { storyboardNumber: 5, startMs: 40_000, endMs: 50_000, cell: { dharma: 1 as const, emotion: 'acceptance' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/acceptance.mp4' } } },
    { storyboardNumber: 6, startMs: 50_000, endMs: 60_000, cell: { dharma: 1 as const, emotion: 'insight' as const, styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID, image: image('static/images/insight.png', 4, 'hold'), quote: { text: '允许边界存在' } } },
    { storyboardNumber: 7, startMs: 60_000, endMs: 70_000, cell: { dharma: 1 as const, emotion: 'release' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/release.mp4' } } },
  ]

  const summary = validateDharmaCreativeProductionPlan(windows, {
    verifiedGeneratedImageTaskIds: new Set([1, 2, 3, 4]),
  })
  assert.equal(summary.segments[1].hasQuote, true)
})

test('validateDharmaCreativeProductionPlan: 机械 stock 轮播不能冒充情绪方案', () => {
  const windows = Array.from({ length: 6 }, (_, index) => ({
    storyboardNumber: index + 1,
    startMs: index * 10_000,
    endMs: (index + 1) * 10_000,
    cell: {
      dharma: 1 as const,
      emotion: 'stillness' as const,
      styleId: DHARMA_EMOTIONAL_INK_STYLE_ID,
      video: { src: `static/videos/stock-${index}.mp4` },
    },
  }))

  assert.throws(() => validateDharmaCreativeProductionPlan(windows), /情绪弧线|开场必须|AI 关键图覆盖率/)
})

test('validateDharmaCreativeProductionPlan: 完整 milestone 之间也不允许情绪逆序回跳', () => {
  const generated = (src: string, taskId: number, move: 'push' | 'pull' | 'hold') => ({
    src,
    generatedSegmentTaskId: taskId,
    move,
  })
  const creativeWindow = (
    storyboardNumber: number,
    startMs: number,
    endMs: number,
    emotion: DharmaEmotion,
    styleId: string,
    asset: Partial<Pick<DharmaCell, 'video' | 'image' | 'quote'>>,
  ) => ({
    storyboardNumber,
    startMs,
    endMs,
    cell: { dharma: 1 as const, emotion, styleId, ...asset },
  })
  const windows = [
    creativeWindow(1, 0, 10_000, 'curiosity', DHARMA_SURREAL_DREAM_STYLE_ID, { image: generated('static/images/arc-1.png', 1, 'push') }),
    creativeWindow(2, 10_000, 20_000, 'stillness', DHARMA_EMOTIONAL_INK_STYLE_ID, { video: { src: 'static/videos/arc-2.mp4' } }),
    creativeWindow(3, 20_000, 30_000, 'curiosity', DHARMA_SURREAL_DREAM_STYLE_ID, { video: { src: 'static/videos/arc-3.mp4' } }),
    creativeWindow(4, 30_000, 40_000, 'tension', DHARMA_SURREAL_DREAM_STYLE_ID, { image: generated('static/images/arc-4.png', 4, 'push') }),
    creativeWindow(5, 40_000, 50_000, 'acceptance', DHARMA_EMOTIONAL_INK_STYLE_ID, { image: generated('static/images/arc-5.png', 5, 'pull') }),
    creativeWindow(6, 50_000, 60_000, 'insight', DHARMA_MINIMAL_LIGHT_STYLE_ID, {
      image: generated('static/images/arc-6.png', 6, 'hold'),
      quote: { text: '心若不住，苦便无处落脚' },
    }),
    creativeWindow(7, 60_000, 70_000, 'release', DHARMA_EMOTIONAL_INK_STYLE_ID, { video: { src: 'static/videos/arc-7.mp4' } }),
  ]

  assert.throws(
    () => validateDharmaCreativeProductionPlan(windows),
    /情绪弧线不能逆序回跳：stillness -> curiosity/,
  )
})

test('validateDharmaCreativeProductionPlan: 普通静态图不能冒充顿悟段的 AI 关键图', () => {
  const generated = (src: string, taskId: number, move: 'push' | 'pull') => ({
    src,
    generatedSegmentTaskId: taskId,
    move,
  })
  const windows = [
    { storyboardNumber: 1, startMs: 0, endMs: 10_000, cell: { dharma: 1 as const, emotion: 'curiosity' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: generated('static/images/curiosity.png', 1, 'push') } },
    { storyboardNumber: 2, startMs: 10_000, endMs: 20_000, cell: { dharma: 1 as const, emotion: 'stillness' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/stillness.mp4' } } },
    { storyboardNumber: 3, startMs: 20_000, endMs: 30_000, cell: { dharma: 1 as const, emotion: 'tension' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: generated('static/images/tension.png', 2, 'push') } },
    { storyboardNumber: 4, startMs: 30_000, endMs: 40_000, cell: { dharma: 1 as const, emotion: 'acceptance' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, image: generated('static/images/acceptance.png', 3, 'pull') } },
    { storyboardNumber: 5, startMs: 40_000, endMs: 50_000, cell: { dharma: 1 as const, emotion: 'insight' as const, styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID, image: { src: 'static/images/library-still.png', move: 'hold' as const }, quote: { text: '允许边界存在' } } },
    { storyboardNumber: 6, startMs: 50_000, endMs: 60_000, cell: { dharma: 1 as const, emotion: 'release' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/release.mp4' } } },
  ]

  assert.throws(() => validateDharmaCreativeProductionPlan(windows), /极简光影 AI 图片/)
})

test('validateDharmaCreativeProductionPlan: 顿悟段即使是可信生成图也必须承载金句', () => {
  const generated = (src: string, taskId: number, move: 'push' | 'pull' | 'hold') => ({
    src,
    generatedSegmentTaskId: taskId,
    move,
  })
  const windows = [
    { storyboardNumber: 1, startMs: 0, endMs: 10_000, cell: { dharma: 1 as const, emotion: 'curiosity' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: generated('static/images/curiosity-quote.png', 11, 'push') } },
    { storyboardNumber: 2, startMs: 10_000, endMs: 20_000, cell: { dharma: 1 as const, emotion: 'stillness' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/stillness-quote.mp4' } } },
    { storyboardNumber: 3, startMs: 20_000, endMs: 30_000, cell: { dharma: 1 as const, emotion: 'tension' as const, styleId: DHARMA_SURREAL_DREAM_STYLE_ID, image: generated('static/images/tension-quote.png', 12, 'push') } },
    { storyboardNumber: 4, startMs: 30_000, endMs: 40_000, cell: { dharma: 1 as const, emotion: 'acceptance' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/acceptance-quote.mp4' } } },
    { storyboardNumber: 5, startMs: 40_000, endMs: 50_000, cell: { dharma: 1 as const, emotion: 'insight' as const, styleId: DHARMA_MINIMAL_LIGHT_STYLE_ID, image: generated('static/images/insight-quote.png', 13, 'hold') } },
    { storyboardNumber: 6, startMs: 50_000, endMs: 60_000, cell: { dharma: 1 as const, emotion: 'release' as const, styleId: DHARMA_EMOTIONAL_INK_STYLE_ID, video: { src: 'static/videos/release-quote.mp4' } } },
  ]

  assert.throws(
    () => validateDharmaCreativeProductionPlan(windows, {
      verifiedGeneratedImageTaskIds: new Set([11, 12, 13]),
    }),
    /承载金句/,
  )
})

test('mergeDharmaSegments: 相邻同素材跨旁白停顿仍合并为一个视觉段落', () => {
  const merged = mergeDharmaSegments([
    seg(1, 0, 5000, 'video', 'static/stock/a.mp4'),
    seg(2, 7000, 12000, 'video', 'static/stock/a.mp4'),
  ])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].storyboardNumbers, [1, 2])
  assert.equal(merged[0].startMs, 0)
  assert.equal(merged[0].endMs, 12000)
})

test('fillDharmaVisualGaps: 素材切换之间的 TTS 停顿由前一视觉段落承载', () => {
  const filled = fillDharmaVisualGaps([
    { kind: 'video', src: 'static/stock/a.mp4', startMs: 0, endMs: 5_000, storyboardNumbers: [1] },
    { kind: 'image', src: 'static/images/b.png', startMs: 11_000, endMs: 16_000, storyboardNumbers: [2] },
  ])

  assert.equal(filled[0].endMs, 11_000)
  assert.equal(filled[1].startMs, 11_000)
})

test('fillDharmaVisualGaps: 出场 AI 图达到 30 秒上限时让入场图提前出现', () => {
  const filled = fillDharmaVisualGaps([
    {
      kind: 'image', src: 'static/images/a.png', startMs: 0, endMs: 29_000,
      storyboardNumbers: [1], generatedSegmentTaskId: 1,
    },
    {
      kind: 'image', src: 'static/images/b.png', startMs: 32_000, endMs: 40_000,
      storyboardNumbers: [2], generatedSegmentTaskId: 2,
    },
  ])

  assert.equal(filled[0].endMs, 29_000)
  assert.equal(filled[1].startMs, 29_000)
})

test('fillDharmaVisualGaps: 两侧 AI 图都会超过 30 秒时拒绝用静音填充', () => {
  assert.throws(() => fillDharmaVisualGaps([
    {
      kind: 'image', src: 'static/images/a.png', startMs: 0, endMs: 29_000,
      storyboardNumbers: [1], generatedSegmentTaskId: 1,
    },
    {
      kind: 'image', src: 'static/images/b.png', startMs: 70_000, endMs: 101_000,
      storyboardNumbers: [2], generatedSegmentTaskId: 2,
    },
  ]), /超过 30s 上限/)
})

test('resolveDharmaSegmentFrameWindow: 相邻绝对时间窗不会因分别取整留下黑帧', () => {
  const outgoing = resolveDharmaSegmentFrameWindow(46, 93)
  const incoming = resolveDharmaSegmentFrameWindow(93, 160)

  assert.equal(outgoing.startFrame + outgoing.durationInFrames, incoming.startFrame)
})

test('resolveVideoWindowTiming: 素材够长时按请求起点起播', () => {
  const timing = resolveVideoWindowTiming(20, 10, 2)
  assert.equal(timing.playbackRate, 1)
  assert.equal(timing.sourceStartSec, 2)
})

test('resolveVideoWindowTiming: 请求起点会让尾段超出素材时前移起点', () => {
  const timing = resolveVideoWindowTiming(20, 10, 15)
  assert.equal(timing.playbackRate, 1)
  assert.equal(timing.sourceStartSec, 10)
})

test('resolveVideoWindowTiming: 素材偏短时慢放拉伸，不循环', () => {
  const timing = resolveVideoWindowTiming(8, 10)
  assert.equal(timing.playbackRate, 0.8)
  assert.equal(timing.sourceStartSec, 0)
})

test('resolveVideoWindowTiming: 慢放比低于下限直接失败（换素材，不硬循环）', () => {
  assert.throws(
    () => resolveVideoWindowTiming(4, 10),
    new RegExp(`慢放比 .* 低于下限 ${MIN_PLAYBACK_RATE}`),
  )
})

test('resolveVideoWindowTiming: 非法时长直接失败', () => {
  assert.throws(() => resolveVideoWindowTiming(0, 10))
  assert.throws(() => resolveVideoWindowTiming(10, 0))
})

test('full-plan playback validation budgets incoming crossfade before any delivery proxy work', () => {
  const segments = [
    { kind: 'video' as const, src: 'a.mp4', startMs: 0, endMs: 10_000, storyboardNumbers: [1] },
    { kind: 'video' as const, src: 'b.mp4', startMs: 10_000, endMs: 20_000, storyboardNumbers: [2] },
  ]
  const cells = new Map<number, DharmaCell>([
    [1, { dharma: 1, role: 'ritual', video: { src: 'a.mp4' } }],
    [2, { dharma: 1, role: 'ritual', video: { src: 'b.mp4' } }],
  ])

  assert.throws(() => validateDharmaSegmentPlaybackPlan(
    segments,
    cells,
    new Map([['a.mp4', 6], ['b.mp4', 6]]),
  ), /素材 b\.mp4.*慢放比.*低于下限/)

  const valid = validateDharmaSegmentPlaybackPlan(
    segments,
    cells,
    new Map([['a.mp4', 10], ['b.mp4', 10.8]]),
  )
  assert.equal(valid[0].playbackRate, 1)
  assert.equal(valid[1].renderedDurationSec, 10.8)
})

test('parseDharmaCell: 只接受 dharma=1 且有 video.src 或 image.src 的 cell', () => {
  assert.equal(parseDharmaCell(null), null)
  assert.equal(parseDharmaCell('not-json'), null)
  assert.equal(parseDharmaCell('{"dharma":1}'), null)
  assert.equal(parseDharmaCell('{"cells":[]}'), null)
  const cell = parseDharmaCell(JSON.stringify({
    dharma: 1,
    role: 'contemplative_nature',
    theme: '山林迷雾',
    video: { src: 'static/remotion/stock/pexels-1.mp4', provider: 'pexels' },
    quote: { text: '应无所住而生其心', source: '《金刚经》' },
  }))
  assert.ok(cell)
  assert.equal(cell.role, 'contemplative_nature')
  assert.equal(cell.video?.src, 'static/remotion/stock/pexels-1.mp4')
  assert.equal(cell.quote?.text, '应无所住而生其心')
})

test('resolveDharmaAssignedAssetPath: delivery proxy 不能伪装成原始 stock 指派', () => {
  assert.throws(
    () => resolveDharmaAssignedAssetPath('static/remotion/stock/proxy/pexels-35574243.mp4', 'video'),
    /不能把 delivery proxy 当作指派来源/,
  )
})
