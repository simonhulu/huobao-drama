import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../src/db/index.js'
import { recreateHistoryScript } from '../src/services/history-script-recreation.js'
import type { HistoryTranscriptReview } from '../src/services/history-script-processing.js'

const id = Number(process.argv[2])
if (!Number.isSafeInteger(id) || id <= 0) throw Error('Usage: writing-thinking-preview.ts <sourceId>')
const source = db.$client.prepare('SELECT title,author_name,corrected_transcript,rewritten_script,review_json FROM history_script_sources WHERE id=? AND deleted_at IS NULL').get(id) as {
  title: string; author_name: string | null; corrected_transcript: string; rewritten_script: string | null; review_json: string | null
} | undefined
if (!source?.corrected_transcript) throw Error('A complete corrected source is required')
const previous = JSON.parse(source.review_json || '{}')
const review: HistoryTranscriptReview = { correctedTranscript: source.corrected_transcript, corrections: previous.corrections || [],
  factualConcerns: previous.factualConcerns || [], factCheckStatus: previous.factCheckStatus || 'needs_sources' }
const root = fileURLToPath(new URL('../../data/static/history-recreation-study/', import.meta.url))
const directory = path.join(root, `${id}-thinking-${Date.now()}`)
fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(directory, 'source.txt'), source.corrected_transcript)
const fetchOriginal = globalThis.fetch
const results: Record<string, unknown>[] = []
try {
  for (const thinking of [false, true]) {
    let metrics: Record<string, unknown> = {}
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input))
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/v1/chat/completions') {
        throw Error('This comparison may call only the remote writing API')
      }
      const body = JSON.parse(String(init?.body))
      body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: thinking }
      body.reasoning_budget_tokens = thinking ? 1536 : 0
      body.max_tokens = 8192 + (thinking ? 1536 : 0)
      body.seed = 42
      const startedAt = Date.now()
      const response = await fetchOriginal(input, { ...init, body: JSON.stringify(body) })
      const value = await response.json()
      const message = value.choices?.[0]?.message
      metrics = { thinking, model: body.model, maxTokens: body.max_tokens, seed: body.seed,
        reasoningBudgetTokens: body.reasoning_budget_tokens, durationMs: Date.now() - startedAt, status: response.status, finishReason: value.choices?.[0]?.finish_reason,
        usage: value.usage, timings: value.timings,
        reasoningCharacters: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length
          : typeof message?.reasoning === 'string' ? message.reasoning.length : 0 }
      // Retain final prose and aggregate metrics only, never the model's private reasoning.
      if (message) { delete message.reasoning_content; delete message.reasoning }
      return Response.json(value, { status: response.status, headers: response.headers })
    }
    const name = thinking ? 'thinking' : 'nonthinking'
    try {
      const result = await recreateHistoryScript(source.corrected_transcript, review, {
        sourceTitle: source.title, sourceAuthor: source.author_name || undefined,
      })
      fs.writeFileSync(path.join(directory, `${name}.txt`), result.script)
      results.push({ ...metrics, accepted: true, scriptCharacters: result.script.length })
    } catch (error) {
      results.push({ ...metrics, accepted: false, error: (error as Error).message })
    }
    console.log(JSON.stringify(results.at(-1)))
    fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify({ sourceId: id, directory, results }, null, 2))
  }
  const unchanged = db.$client.prepare('SELECT corrected_transcript,rewritten_script FROM history_script_sources WHERE id=?').get(id) as typeof source
  if (unchanged?.corrected_transcript !== source.corrected_transcript || unchanged.rewritten_script !== source.rewritten_script) throw Error('Source changed during isolated comparison')
  console.log(JSON.stringify({ directory, sourceUnchanged: true, productionTriggered: false }))
} finally {
  globalThis.fetch = fetchOriginal
  db.$client.close()
}
