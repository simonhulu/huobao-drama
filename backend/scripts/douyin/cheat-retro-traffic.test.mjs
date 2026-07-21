import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTrafficReport, persistTrafficRetro } from './cheat-retro-traffic.mjs'

const analysis = {
  source: 'douyin:traffic-analysis:item_compare',
  capturedAt: '2026-07-13T19:00:00+08:00',
  itemId: '7661846444579589439',
  metrics: {
    bounce_rate_2s: '0.512',
    completion_rate_5s: '0.348',
    avg_view_second: '18.6',
    avg_view_proportion: '0.423',
    comment_count: '23',
    comment_rate: '0.00126',
    like_rate: '0.0338',
    share_rate: '0.0253',
    favorite_rate: '0.0074',
  },
  comparison: {
    bounce_rate_2s: {
      compareValue: '0.375',
      changeRatio: 0.365,
      suggestion: '片头点明视频主题',
    },
  },
}

test('builds a detail report without dropping an existing section', () => {
  const report = buildTrafficReport(
    '# 作品\n\n## 评论\n\n- 👍3 保留这条评论',
    { awemeId: '7661846444579589439', title: '信念崩塌', metrics: {} },
    analysis,
    analysis.capturedAt,
  )

  assert.match(report, /## 流量分析（作品分析）/)
  assert.match(report, /2 秒跳出率 \| 51\.2% \| 37\.5%/)
  assert.match(report, /平均播放时长 \| 18\.6 秒/)
  assert.match(report, /片头点明视频主题/)
  assert.match(report, /## 评论[\s\S]*保留这条评论/)
})

test('persists CDP detail data for the requested aweme id', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cheat-retro-traffic-'))
  try {
    fs.writeFileSync(path.join(folder, 'data.json'), JSON.stringify({
      awemeId: 'stale-id',
      title: '已有作品',
      metrics: { view_count: '1200' },
    }), 'utf8')
    fs.writeFileSync(path.join(folder, 'report.md'), '# 已有作品\n\n## 评论\n\n- 保留', 'utf8')

    const result = persistTrafficRetro({
      awemeId: analysis.itemId,
      videoFolder: folder,
      analysis,
      capturedAt: analysis.capturedAt,
    })

    const data = JSON.parse(fs.readFileSync(result.dataPath, 'utf8'))
    const report = fs.readFileSync(result.reportPath, 'utf8')
    const traffic = JSON.parse(fs.readFileSync(result.trafficPath, 'utf8'))
    assert.equal(result.status, 'available')
    assert.equal(data.awemeId, analysis.itemId)
    assert.equal(data.metrics.view_count, '1200')
    assert.equal(data.metrics.bounce_rate_2s, '0.512')
    assert.equal(data.trafficAnalysisStatus.status, 'available')
    assert.equal(traffic.analysis.itemId, analysis.itemId)
    assert.match(report, /## 流量分析（作品分析）/)
    assert.match(report, /## 评论[\s\S]*保留/)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

