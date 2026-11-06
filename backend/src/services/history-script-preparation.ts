import { createHash } from 'node:crypto'
import { runImmediateTransaction } from '../db/index.js'
import { getHistorySource, requireCurrentHistoryScript, updateHistorySource, type HistorySource } from './history-script-library.js'
import { condenseHistoryScript, historyScriptCharacters, HISTORY_SCRIPT_TARGET_CHARACTERS, type HistoryRecreationResult } from './history-script-recreation.js'
import { estimateHistoryScriptTiming } from './history-script-processing.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function reviewOf(source: HistorySource): Record<string, any> { return JSON.parse(source.reviewJson || '{}') }

export function needsHistoryScriptCondensation(script: string, review: Record<string, any> = {}): boolean {
  return historyScriptCharacters(script) > HISTORY_SCRIPT_TARGET_CHARACTERS && review.scriptCondensation?.scriptSha256 !== hash(script)
}

export function historyScriptCondensationRecord(previous: string, result: HistoryRecreationResult) {
  return { previousScript: previous, previousScriptSha256: hash(previous), scriptSha256: hash(result.script),
    originalCharacters: historyScriptCharacters(previous), characters: historyScriptCharacters(result.script),
    targetCharacters: HISTORY_SCRIPT_TARGET_CHARACTERS, targetSeconds: 900, charactersPerMinute: 300,
    preparedAt: new Date().toISOString(), model: result.model, provider: result.provider,
    skillRevision: result.skillRevision, skillSha256: result.skillSha256 }
}

/** Prepare one shared manuscript before either producer locks its snapshot. */
export async function prepareHistorySourceScript(source: HistorySource, options: {
  condense?: typeof condenseHistoryScript; signal?: AbortSignal; storageRoot?: string
} = {}): Promise<HistorySource> {
  const script = requireCurrentHistoryScript(source)
  if (!needsHistoryScriptCondensation(script, reviewOf(source))) return source
  const { acquireHistorySourceLock } = await import('./history-source-pipeline.js')
  const release = await acquireHistorySourceLock(source.id, options.storageRoot)
  try {
    options.signal?.throwIfAborted()
    const current = getHistorySource(source.id)
    if (!current || requireCurrentHistoryScript(current) !== script || current.correctedTranscript !== source.correctedTranscript) throw Error('稿件已更新，请刷新后再开始制作')
    const result = await (options.condense || condenseHistoryScript)(script, { signal: options.signal, sourceTitle: source.title, sourceAuthor: source.authorName || undefined })
    options.signal?.throwIfAborted()
    return runImmediateTransaction(() => {
      const latest = getHistorySource(source.id)
      if (!latest || requireCurrentHistoryScript(latest) !== script || latest.correctedTranscript !== current.correctedTranscript) throw Error('缩写期间稿件已更新，未覆盖新稿')
      const review = reviewOf(latest)
      // Old producer snapshots and receipts remain associated with their original hash.
      delete review.huashengQueue
      return updateHistorySource(source.id, { rewrittenScript: result.script, status: 'needs_review', lastError: null,
        reviewJson: JSON.stringify({ ...review, draftOrigin: 'source_paraphrase',
          recreation: { ...review.recreation, ...result, script: undefined },
          scriptTiming: estimateHistoryScriptTiming(result.script),
          scriptCondensation: historyScriptCondensationRecord(script, result) }) })!
    })
  } finally { await release() }
}
