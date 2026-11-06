import '../../src/load-env.js'
import savedSources from '../../src/services/fixtures/history-source-selection.json' with { type: 'json' }
import { selectHistoryBrowserObservation, type HistoryBrowserObservation } from '../../src/services/history-source-browser.js'

if (!['--saved', '--live'].includes(process.argv.slice(2).join(' '))) {
  throw new Error('Use --saved to evaluate engagement thresholds without model calls')
}

const base = { ...savedSources[0]!.observation, sourceType: 'video' as const, caption: '' }
const examples: Array<{ name: string; selected: boolean; observation: HistoryBrowserObservation }> = [
  { name: 'Threshold boundary', selected: true, observation: { ...base, metrics: { likes: 10000, comments: 20 } } },
  { name: 'Low likes', selected: false, observation: { ...base, metrics: { likes: 9999, comments: 100 } } },
  { name: 'Low comments', selected: false, observation: { ...base, metrics: { likes: 100000, comments: 19 } } },
  { name: 'Unknown likes', selected: false, observation: { ...base, metrics: { comments: 100 } } },
  { name: 'Short video without comment samples', selected: true, observation: { ...base,
    durationSeconds: 30, comments: [], metrics: { likes: 20000, comments: 30 } } },
  { name: 'Image note without video duration', selected: true, observation: { ...base,
    sourceType: 'note', durationSeconds: undefined, comments: [], metrics: { likes: 20000, comments: 30 } } },
]

let failures = 0
for (const sample of examples) {
  const selected = Boolean(selectHistoryBrowserObservation(sample.observation, 'Saved engagement samples'))
  const passed = selected === sample.selected
  if (!passed) failures++
  console.log(JSON.stringify({ name: sample.name, expected: sample.selected, selected, passed }))
}
console.log(JSON.stringify({ samples: examples.length, failures, modelCalls: 0, asrCalls: 0, downloads: 0, sourceWrites: 0 }))
process.exitCode = failures ? 1 : 0
