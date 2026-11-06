import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {asrProviderError} from '../asr-provider-error.js'

export const QWEN_ASR_MODEL = 'qwen-audio-3.1-asr-flash-filetrans'
export const QWEN_ASR_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'

export interface QwenASROptions {
  config: { baseUrl: string; apiKey: string }
  fetchFn?: typeof fetch
  signal?: AbortSignal
  language?: string
  pollMs?: number
  timeoutMs?: number
}

const uploadPolicySchema = z.object({
  data: z.object({
    policy: z.string().min(1), signature: z.string().min(1),
    upload_dir: z.string().min(1), upload_host: z.url(), oss_access_key_id: z.string().min(1),
    x_oss_object_acl: z.string().min(1), x_oss_forbid_overwrite: z.string().min(1),
    max_file_size_mb: z.number().positive().optional(),
  }),
})

const taskSchema = z.object({
  request_id: z.string().optional(),
  output: z.object({
    task_id: z.string().min(1).optional(), task_status: z.string(),
    code: z.string().optional(), message: z.string().optional(),
    results: z.array(z.object({
      subtask_status: z.string(), transcription_url: z.url().optional(),
      code: z.string().optional(), message: z.string().optional(),
    })).optional(),
  }),
})

const transcriptionSchema = z.object({
  properties: z.object({ original_duration_in_milliseconds: z.number().finite().positive() }),
  transcripts: z.array(z.object({
    channel_id: z.number().int(), text: z.string(),
    sentences: z.array(z.object({
      begin_time: z.number().finite().nonnegative(), end_time: z.number().finite().nonnegative(),
      text: z.string(), speaker_id: z.union([z.number(), z.string()]).optional(),
    })).default([]),
  })),
})

export async function transcribeQwenAudio(filePath: string, options: QwenASROptions) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 20 * 60_000)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
  signal.throwIfAborted()
  const fetchFn = options.fetchFn ?? fetch
  const base = options.config.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '') + '/api/v1'
  const authorization = { Authorization: `Bearer ${options.config.apiKey}` }
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(240_000)])
  const jsonRequest = async (url: string, init: RequestInit = {}, canFallback=false) => {
    signal.throwIfAborted()
    const response = await fetchFn(url, { ...init, signal: requestSignal() })
    signal.throwIfAborted()
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { code?: string; message?: string }
      const detail = String(error.message || error.code || 'request rejected').replaceAll(options.config.apiKey, '[redacted]')
      throw asrProviderError('Qwen',response.status,detail,options.config.apiKey,canFallback)
    }
    const result = await response.json()
    signal.throwIfAborted()
    if (result.code) {
      const detail = String(result.message || result.code).replaceAll(options.config.apiKey, '[redacted]')
      if(canFallback)throw asrProviderError('Qwen',response.status,`${result.code}: ${detail}`,options.config.apiKey,true)
      throw new Error(`Qwen ASR ${result.code}: ${detail}`)
    }
    return result
  }

  const policyUrl = new URL(`${base}/uploads`)
  policyUrl.searchParams.set('action', 'getPolicy')
  policyUrl.searchParams.set('model', QWEN_ASR_MODEL)
  const { data: policy } = uploadPolicySchema.parse(await jsonRequest(String(policyUrl), { headers: authorization },true))
  if (policy.max_file_size_mb && (await stat(filePath)).size > policy.max_file_size_mb * 1024 * 1024) {
    throw new Error('Qwen ASR audio exceeds the temporary upload size limit')
  }
  const audio = await readFile(filePath)
  signal.throwIfAborted()
  const key = `${policy.upload_dir.replace(/\/+$/, '')}/${basename(filePath)}`
  const form = new FormData()
  form.set('OSSAccessKeyId', policy.oss_access_key_id)
  form.set('signature', policy.signature)
  form.set('policy', policy.policy)
  form.set('key', key)
  form.set('x-oss-object-acl', policy.x_oss_object_acl)
  form.set('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite)
  form.set('success_action_status', '200')
  form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), basename(filePath))
  const uploaded = await fetchFn(policy.upload_host, { method: 'POST', body: form, signal: requestSignal() })
  signal.throwIfAborted()
  if (!uploaded.ok) throw new Error(`Qwen ASR upload ${uploaded.status}: audio upload failed`)
  await uploaded.body?.cancel()

  // Local files use a short-lived OSS resource, resolved by DashScope at task submission.
  let task = taskSchema.parse(await jsonRequest(`${base}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
    body: JSON.stringify({
      model: QWEN_ASR_MODEL,
      input: { file_urls: [`oss://${key}`] },
      parameters: { channel_id: [0], ...((options.language ?? 'zh') ? { language_hints: [options.language ?? 'zh'] } : {}) },
    }),
  },true))
  const taskId = task.output.task_id
  if (!taskId) throw new Error('Qwen ASR submission returned no task ID')
  while (task.output.task_status !== 'SUCCEEDED') {
    if (!['PENDING', 'RUNNING'].includes(task.output.task_status)) {
      throw new Error(`Qwen ASR task ${task.output.task_status}: ${task.output.message || task.output.code || 'transcription failed'}`)
    }
    try { await delay(options.pollMs ?? 2000, undefined, { signal }) }
    catch (error) { signal.throwIfAborted(); throw error }
    task = taskSchema.parse(await jsonRequest(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers: authorization }))
  }
  const [result] = task.output.results ?? []
  if (task.output.results?.length !== 1 || result?.subtask_status !== 'SUCCEEDED' || !result.transcription_url) {
    throw new Error(`Qwen ASR result failed: ${result?.message || result?.code || 'missing successful transcription result'}`)
  }
  // Result URLs carry their own OSS signature; never forward the API key to them.
  const document = transcriptionSchema.parse(await jsonRequest(result.transcription_url))
  const transcripts = document.transcripts.filter(transcript => transcript.channel_id === 0)
  return {
    provider: 'qwen' as const, model: QWEN_ASR_MODEL,
    text: transcripts.map(transcript => transcript.text.trim()).join('\n').trim(),
    duration: document.properties.original_duration_in_milliseconds / 1000,
    trace_id: task.request_id,
    segments: transcripts.flatMap(transcript => transcript.sentences.map(sentence => ({
      start: sentence.begin_time / 1000, end: sentence.end_time / 1000, text: sentence.text,
      ...(sentence.speaker_id !== undefined ? { speaker: String(sentence.speaker_id) } : {}),
    }))),
  }
}
