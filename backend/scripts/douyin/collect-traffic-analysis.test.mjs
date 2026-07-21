import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTrafficPayload, trafficAnalysisMarkdown } from './collect-traffic-analysis.mjs'

test('normalizes detail metrics and comparison advice', () => {
  const analysis = normalizeTrafficPayload({
    item: {
      id: '123',
      metrics: { bounce_rate_2s: '0.4', comment_count: '2' },
    },
    metrics: [
      {
        name: 'bounce_rate_2s',
        name_desc: '2秒跳出率',
        self_value: '0.4',
        compare_value: '0.3',
        change_ratio: '0.3333',
        diff_value: '0.1',
        suggestion: '片头点明主题',
      },
    ],
    selected_metrics: ['bounce_rate_2s'],
  }, '2026-07-13T18:00:00+08:00')

  assert.equal(analysis.source, 'douyin:traffic-analysis:item_compare')
  assert.equal(analysis.itemId, '123')
  assert.equal(analysis.metrics.comment_count, '2')
  assert.equal(analysis.comparison.bounce_rate_2s.compareValue, '0.3')
  assert.equal(analysis.comparison.bounce_rate_2s.changeRatio, 0.3333)
  assert.equal(analysis.comparison.bounce_rate_2s.suggestion, '片头点明主题')
})

test('renders detail metric values and official suggestion', () => {
  const markdown = trafficAnalysisMarkdown({
    metrics: {
      bounce_rate_2s: '0.4',
      avg_view_second: '12.345',
    },
    comparison: {
      bounce_rate_2s: {
        compareValue: '0.3',
        changeRatio: 0.3333,
        suggestion: '片头点明主题',
      },
    },
  })

  assert.match(markdown, /2 秒跳出率 \| 40\.0% \| 30\.0% \| 33\.3%/)
  assert.match(markdown, /平均播放时长 \| 12\.3 秒/)
  assert.match(markdown, /片头点明主题/)
})
