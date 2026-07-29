import assert from 'node:assert/strict'
import test from 'node:test'
import {
  areStoryboardNumbersContiguous,
  fitShotFramesToBudget,
  normalizeGridVideo,
  resolveStoryboardNarration,
} from './grid-story-props.js'

test('fitShotFramesToBudget stops at the last complete shot inside the budget', () => {
  assert.deepEqual(fitShotFramesToBudget([24 * 30, 9 * 30, 22 * 30], 30), [24 * 30])
})

test('fitShotFramesToBudget never clips narration in the final included shot', () => {
  assert.deepEqual(fitShotFramesToBudget([155, 172, 172], 15), [155, 172])
})

test('fitShotFramesToBudget leaves an uncapped render unchanged', () => {
  assert.deepEqual(fitShotFramesToBudget([720, 270], undefined), [720, 270])
})

test('resolveStoryboardNarration prefers exact narration over stale visual description', () => {
  assert.equal(resolveStoryboardNarration({
    narration: '他的真名叫威廉·洛克菲勒。',
    description: '妻子主持了葬礼。他的真名叫威廉·洛克菲勒。',
  }), '他的真名叫威廉·洛克菲勒。')
})

test('sparse storyboard selections are detected before rendering', () => {
  assert.equal(areStoryboardNumbersContiguous([1, 2, 3]), true)
  assert.equal(areStoryboardNumbersContiguous([3, 2, 2, 1]), true)
  assert.equal(areStoryboardNumbersContiguous([1, 5, 6]), false)
})

test('stock cutaways are converted to bounded frame windows', () => {
  assert.deepEqual(normalizeGridVideo({
    src: 'static/remotion/stock/pexels-28043983.mp4',
    mode: 'cutaway',
    startSec: 0.6,
    durationSec: 2.1,
    sourceStartSec: 5.2,
    scale: 1.25,
    focusX: 35,
    focusY: 50,
    grade: 'documentary_muted',
    transitionFrames: 6,
  }, 191), {
    src: 'static/remotion/stock/pexels-28043983.mp4',
    mode: 'cutaway',
    startFrame: 18,
    durationInFrames: 63,
    sourceStartFrame: 156,
    scale: 1.25,
    focusX: 35,
    focusY: 50,
    grade: 'documentary_muted',
    transitionFrames: 6,
  })
})

test('stock cutaways cannot run past the narration shot', () => {
  const normalized = normalizeGridVideo({
    src: 'static/remotion/stock/pixabay-33.mp4',
    mode: 'cutaway',
    startSec: 9,
    durationSec: 8,
    scale: 4,
    focusX: -20,
  }, 120)

  assert.equal(normalized?.startFrame, 119)
  assert.equal(normalized?.durationInFrames, 1)
  assert.equal(normalized?.scale, 1.8)
  assert.equal(normalized?.focusX, 0)
})

// ================= v8 权威时序契约回归测试 =================
// 背景 bug：渲染曾按「字数比例」把 storyboard 分摊到 titles 窗口，
// 导致画面/字幕平均落后旁白 2.7s（峰值 8s）。契约：镜头起止只能来自
// storyboard_panels(sb-{id}[-pN]) -> visual_beats 窗口，字幕从主时间轴字符插值。

import {
  buildMasterSubtitleClauses,
  buildMasterTimeline,
  locateNarrationWindow,
  masterTimeAt,
  mergeBeatWindows,
  parsePanelStoryboardId,
} from './grid-story-props.js'

test('panel_key parses plain and multi-panel forms, rejects garbage', () => {
  assert.equal(parsePanelStoryboardId('sb-5096'), 5096)
  assert.equal(parsePanelStoryboardId('sb-5096-p2'), 5096)
  assert.equal(parsePanelStoryboardId('sb-1-p10'), 1)
  assert.equal(parsePanelStoryboardId('panel-5096'), null)
  assert.equal(parsePanelStoryboardId('sb-'), null)
  assert.equal(parsePanelStoryboardId('sb-12x'), null)
  assert.equal(parsePanelStoryboardId(''), null)
})

test('mergeBeatWindows merges multi-panel shots into one min/max window', () => {
  const map = mergeBeatWindows([
    { panelKey: 'sb-10-p1', startMs: 2000, endMs: 3500 },
    { panelKey: 'sb-10-p2', startMs: 3500, endMs: 5000 },
    { panelKey: 'sb-11', startMs: 5000, endMs: 7243 },
  ])
  assert.deepEqual(map.get(10), { startMs: 2000, endMs: 5000 })
  assert.deepEqual(map.get(11), { startMs: 5000, endMs: 7243 })
})

test('mergeBeatWindows refuses unparseable keys instead of estimating', () => {
  assert.throws(() => mergeBeatWindows([{ panelKey: 'shot-1', startMs: 0, endMs: 1000 }]), /panel_key/)
})

test('mergeBeatWindows refuses untimed or inverted windows', () => {
  assert.throws(() => mergeBeatWindows([{ panelKey: 'sb-1', startMs: null, endMs: 1000 }]), /窗口无效/)
  assert.throws(() => mergeBeatWindows([{ panelKey: 'sb-1', startMs: 2000, endMs: 2000 }]), /窗口无效/)
  assert.throws(() => mergeBeatWindows([{ panelKey: 'sb-1', startMs: 3000, endMs: 1000 }]), /窗口无效/)
})

const TITLES = JSON.stringify([
  { text: '第一句开场白。第二句承接。', time_begin: 0, time_end: 5000 },
  { text: '第三句重复。', time_begin: 5500, time_end: 8000 },
  { text: '第四句重复。收尾。', time_begin: 8200, time_end: 11000 },
])

test('master timeline interpolates character positions to seconds', () => {
  const tl = buildMasterTimeline(TITLES)!
  assert.ok(tl)
  // 第一条 13 字符铺 0..5s；位置 0 -> 0s，中点 6.5 -> 2.5s
  assert.equal(masterTimeAt(tl, 0), 0)
  assert.equal(masterTimeAt(tl, 6.5), 2.5)
  // 跨标题边界：第一条末尾的下一字符落在第二条起点（含静音间隔）
  const firstLen = '第一句开场白。第二句承接。'.length
  assert.equal(masterTimeAt(tl, firstLen), 5.5)
  // 流末尾 -> 最后一条 end
  assert.equal(masterTimeAt(tl, tl.stream.length), 11)
  assert.equal(buildMasterTimeline('not json'), null)
  assert.equal(buildMasterTimeline(null), null)
})

test('locateNarrationWindow cursor keeps repeated text on the later occurrence', () => {
  const tl = buildMasterTimeline(TITLES)!
  const first = locateNarrationWindow(tl, '第三句重复。', 0)!
  assert.equal(masterTimeAt(tl, first.start), 5.5)
  // 文本变化但前缀探测相同的后续镜头：游标之后继续定位，不回跳
  const second = locateNarrationWindow(tl, '第四句重复。', first.cursor)!
  assert.equal(masterTimeAt(tl, second.start), 8.2)
  assert.equal(locateNarrationWindow(tl, '根本不存在的句子。', 0), null)
})

test('master subtitle clauses are anchored to the master timeline, shot-relative', () => {
  const tl = buildMasterTimeline(TITLES)!
  const shotNarr = '第一句开场白。第二句承接。'
  const win = locateNarrationWindow(tl, shotNarr, 0)!
  const clauses = buildMasterSubtitleClauses(shotNarr, win, tl, 0)!
  assert.equal(clauses.length, 2)
  assert.equal(clauses[0].text, '第一句开场白。')
  assert.equal(clauses[0].startSec, 0)
  assert.ok(clauses[0].endSec > clauses[0].startSec)
  // 分句末尾落在下一标题起点：字幕在下一句开讲前的静音期保持（设计行为）
  assert.ok(Math.abs(clauses[1].endSec - 5.5) < 1e-6)
  // 镜头从 5.5s 开始时分句时间转为镜内相对（结尾同样含尾部静音 -> 8.2-5.5=2.7）
  const win2 = locateNarrationWindow(tl, '第三句重复。', 0)!
  const rel = buildMasterSubtitleClauses('第三句重复。', win2, tl, 5.5)!
  assert.equal(rel[0].startSec, 0)
  assert.ok(Math.abs(rel[0].endSec - 2.7) < 1e-6)
})
