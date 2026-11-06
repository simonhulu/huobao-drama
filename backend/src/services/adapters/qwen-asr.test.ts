import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EmptyAsrTranscriptionError, transcribeHistoryAudio } from '../history-script-processing.js'
import {resolveHistoryASRConfig} from '../history-asr-config.js'

const model = 'qwen-audio-3.1-asr-flash-filetrans'
const config = { provider: 'qwen' as const, baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'test-key' }
const policy = {
  policy: 'upload-policy', signature: 'upload-signature', upload_dir: 'temporary/audio',
  upload_host: 'https://upload.example', oss_access_key_id: 'upload-key',
  x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true',
}
const transcription = () => ({
  properties: { original_duration_in_milliseconds: 10_000 },
  transcripts: [{ channel_id: 0, text: ' A complete transcript. ', sentences: [
    { begin_time: 100, end_time: 9500, text: 'A complete transcript.', speaker_id: 0 },
  ] }],
})

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qwen-asr-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'audio.wav')
  await writeFile(file, 'test audio')
  return file
}

function providerFetch(options: {
  document?: unknown
  task?: unknown
  inspect?: (url: string, init?: RequestInit) => void
} = {}): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    options.inspect?.(url, init)
    if (url.includes('/uploads?')) return Response.json({ data: policy })
    if (url === policy.upload_host) return new Response(null, { status: 200 })
    if (url.endsWith('/services/audio/asr/transcription')) return Response.json({ output: { task_id: 'task-1', task_status: 'PENDING' } })
    if (url.endsWith('/tasks/task-1')) return Response.json(options.task ?? { request_id: 'request-1', output: {
      task_id: 'task-1', task_status: 'SUCCEEDED', results: [{ subtask_status: 'SUCCEEDED', transcription_url: 'https://result.example/transcript.json' }],
    } })
    assert.equal(url, 'https://result.example/transcript.json')
    return Response.json(options.document ?? transcription())
  }
}

test('Qwen ASR uploads local audio, submits once, polls and normalizes sentence timestamps to seconds', async t => {
  const file = await fixture(t)
  const requests: string[] = []
  let polls = 0
  const scripted = providerFetch({ inspect(url, init) {
    requests.push(url)
    const headers = new Headers(init?.headers)
    if (url.includes('/uploads?')) {
      assert.equal(new URL(url).searchParams.get('model'), model)
      assert.equal(new URL(url).searchParams.get('action'), 'getPolicy')
      assert.equal(headers.get('Authorization'), 'Bearer test-key')
    } else if (url === policy.upload_host) {
      assert.equal(init?.method, 'POST')
      assert.equal(headers.get('Authorization'), null)
      assert.equal(headers.get('Content-Type'), null)
      const form = init?.body as FormData
      assert.equal(form.get('key'), 'temporary/audio/audio.wav')
      assert.equal(form.get('policy'), policy.policy)
      assert.equal(form.get('OSSAccessKeyId'), policy.oss_access_key_id)
      assert.equal(form.get('signature'), policy.signature)
      assert.equal(form.get('x-oss-object-acl'), 'private')
      assert.equal(form.get('x-oss-forbid-overwrite'), 'true')
      assert.equal(form.get('success_action_status'), '200')
      const audio = form.get('file')
      assert.ok(audio instanceof File)
      assert.equal(audio.name, 'audio.wav')
      assert.equal(Array.from(form.keys()).at(-1), 'file')
    } else if (url.endsWith('/services/audio/asr/transcription')) {
      assert.equal(headers.get('X-DashScope-Async'), 'enable')
      assert.equal(headers.get('X-DashScope-OssResourceResolve'), 'enable')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model, input: { file_urls: ['oss://temporary/audio/audio.wav'] },
        parameters: { channel_id: [0], language_hints: ['zh'] },
      })
    } else if (url.includes('/tasks/')) {
      assert.equal(headers.get('Authorization'), 'Bearer test-key')
    } else {
      assert.equal(headers.get('Authorization'), null)
    }
  } })
  const fetchFn: typeof fetch = async (url, init) => {
    const response = await scripted(url, init)
    if (String(url).includes('/tasks/') && polls++ === 0) return Response.json({ output: { task_status: 'RUNNING' } })
    return response
  }
  const result = await transcribeHistoryAudio(file, 10, { config, fetchFn, pollMs: 0 })
  assert.equal(result.text, 'A complete transcript.')
  assert.equal(result.duration, 10)
  assert.equal(result.provider, 'qwen')
  assert.equal(result.model, model)
  assert.equal(result.trace_id, 'request-1')
  assert.deepEqual(result.segments, [{ start: 0.1, end: 9.5, text: 'A complete transcript.', speaker: '0' }])
  assert.equal(requests.filter(url => url.endsWith('/services/audio/asr/transcription')).length, 1)
  assert.equal(polls, 2)
})

test('Qwen ASR supports a workspace endpoint and automatic mixed-language recognition', async t => {
  const file = await fixture(t)
  await transcribeHistoryAudio(file, 10, {
    config: { ...config, baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/' }, language: '', pollMs: 0,
    fetchFn: providerFetch({ inspect(url, init) {
      if (url.includes('/services/')) {
        assert.equal(url, 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription')
        assert.deepEqual(JSON.parse(String(init?.body)).parameters, { channel_id: [0] })
      }
    } }),
  })
})

test('configured QWEN_API_KEY selects Qwen without requiring a MiniMax database configuration', async t => {
  const file = await fixture(t)
  const previous = { key: process.env.QWEN_API_KEY, provider: process.env.ASR_PROVIDER, baseUrl: process.env.QWEN_ASR_BASE_URL }
  process.env.QWEN_API_KEY = 'test-key'
  delete process.env.ASR_PROVIDER
  delete process.env.QWEN_ASR_BASE_URL
  t.after(() => {
    for (const [key, value] of Object.entries({ QWEN_API_KEY: previous.key, ASR_PROVIDER: previous.provider, QWEN_ASR_BASE_URL: previous.baseUrl })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const result = await transcribeHistoryAudio(file, 10, { fetchFn: providerFetch(), pollMs: 0 })
  assert.equal(result.model, model)
  process.env.ASR_PROVIDER = 'unknown'
  await assert.rejects(transcribeHistoryAudio(file, 10, { fetchFn: async () => assert.fail('No request for invalid provider') }), /ASR_PROVIDER/)
  process.env.ASR_PROVIDER = 'qwen'
  delete process.env.QWEN_API_KEY
  await assert.rejects(transcribeHistoryAudio(file, 10, {
    resolveConfig:()=>resolveHistoryASRConfig({env:{ASR_PROVIDER:'qwen'},getConfig:()=>null}),
    fetchFn:async()=>assert.fail('Missing credentials must not contact a provider'),
  }), /QWEN_API_KEY/)
})

test('MiniMax quota rejection falls back once to configured Qwen and records the actual provider',async t=>{
  const file=await fixture(t),selected:(string|undefined)[]=[],requests:string[]=[]
  const qwenFetch=providerFetch({inspect:url=>requests.push(url)})
  const result=await transcribeHistoryAudio(file,10,{pollMs:0,
    resolveConfig:async provider=>{selected.push(provider);return provider==='qwen'?config:{provider:'minimax',baseUrl:'https://mini.example',apiKey:'mini-key'}},
    fetchFn:async (url,init)=>String(url).includes('mini.example')
      ?Response.json({base_resp:{status_code:1008,status_msg:'insufficient balance mini-key'}}):qwenFetch(url,init),
  })
  assert.equal(result.provider,'qwen');assert.equal(result.model,model)
  assert.deepEqual(selected,[undefined,'qwen'])
  assert.equal(requests.filter(url=>url.endsWith('/services/audio/asr/transcription')).length,1)
  assert.equal((result.fallback as any).from,'minimax')
  assert.doesNotMatch(JSON.stringify(result),/mini-key/)
})

test('non-JSON MiniMax authentication and quota refusals still select the backup',async t=>{
  const file=await fixture(t)
  for(const status of [401,402,403,429]) {
    const selected:(string|undefined)[]=[]
    const qwenFetch=providerFetch()
    const result=await transcribeHistoryAudio(file,10,{pollMs:0,
      resolveConfig:async provider=>{selected.push(provider);return provider==='qwen'?config:{provider:'minimax',baseUrl:'https://mini.example',apiKey:'mini-key'}},
      fetchFn:async(url,init)=>String(url).includes('mini.example')?new Response('Gateway rejected the request',{status}):qwenFetch(url,init),
    })
    assert.equal(result.provider,'qwen');assert.deepEqual(selected,[undefined,'qwen'])
  }
})

test('ambiguous timeouts, cancellation and incomplete results never submit to a backup provider',async t=>{
  const file=await fixture(t)
  for(const kind of ['timeout','cancel','incomplete','malformed']) {
    let selections=0;const controller=new AbortController()
    await assert.rejects(transcribeHistoryAudio(file,10,{
      signal:controller.signal,
      resolveConfig:async()=>{selections++;assert.equal(selections,1);return {provider:'minimax',baseUrl:'https://mini.example',apiKey:'mini-key'}},
      fetchFn:async()=>{
        if(kind==='cancel'){controller.abort(Error('User canceled'));return Response.json({error:{message:'no quota'}},{status:402})}
        if(kind==='timeout')throw Error('Request timeout; submission outcome unknown')
        if(kind==='malformed')return new Response('broken success response')
        return Response.json({text:'incomplete',duration:1})
      },
    }))
    assert.equal(selections,1)
  }
})

test('Qwen authentication rejection before submission can fall back; polling failure cannot',async t=>{
  const file=await fixture(t)
  for(const phase of ['policy','poll']) {
    const selected:(string|undefined)[]=[]
    const qwenFetch=providerFetch()
    const run=transcribeHistoryAudio(file,10,{pollMs:0,
      resolveConfig:async provider=>{selected.push(provider);return provider==='minimax'?{provider:'minimax',baseUrl:'https://mini.example',apiKey:'mini-key'}:config},
      fetchFn:async(url,init)=>{
        if(String(url).includes('mini.example'))return Response.json({text:'backup transcript',duration:10})
        if(phase==='policy'&&String(url).includes('/uploads?') || phase==='poll'&&String(url).includes('/tasks/'))return Response.json({message:'Invalid API key'},{status:401})
        return qwenFetch(url,init)
      },
    })
    if(phase==='policy'){assert.equal((await run).provider,'minimax');assert.deepEqual(selected,[undefined,'minimax'])}
    else {await assert.rejects(run,/Qwen ASR 401/);assert.deepEqual(selected,[undefined])}
  }
})

test('Qwen ASR rejects failed tasks and failed subtasks even when the parent succeeded', async t => {
  const file = await fixture(t)
  for (const output of [
    { task_status: 'FAILED', code: 'InvalidParameter', message: 'invalid audio' },
    { task_status: 'CANCELED' },
    { task_status: 'UNKNOWN' },
    { task_status: 'SUCCEEDED', results: [{ subtask_status: 'FAILED', code: 'FILE_DOWNLOAD_FAILED', message: 'cannot download' }] },
    { task_status: 'SUCCEEDED', results: [] },
  ]) {
    await assert.rejects(transcribeHistoryAudio(file, 10, {
      config, pollMs: 0, fetchFn: providerFetch({ task: { output } }),
    }), /Qwen ASR/)
  }
})

test('Qwen ASR rejects empty text, incomplete durations and invalid timestamps', async t => {
  const file = await fixture(t)
  const empty = transcription()
  empty.transcripts[0]!.text = ' '
  await assert.rejects(transcribeHistoryAudio(file, 10, {
    config, pollMs: 0, fetchFn: providerFetch({ document: empty }),
  }), error => error instanceof EmptyAsrTranscriptionError)
  const short = transcription()
  short.properties.original_duration_in_milliseconds = 1000
  await assert.rejects(transcribeHistoryAudio(file, 10, {
    config, pollMs: 0, fetchFn: providerFetch({ document: short }),
  }), /incomplete transcription/)
  const invalid = transcription()
  invalid.transcripts[0]!.sentences[0]!.end_time = 12_000
  await assert.rejects(transcribeHistoryAudio(file, 10, {
    config, pollMs: 0, fetchFn: providerFetch({ document: invalid }),
  }), /invalid segment timestamp/)
  await assert.rejects(transcribeHistoryAudio(file, 10, {
    config, pollMs: 0, fetchFn: providerFetch({ document: { transcripts: transcription().transcripts } }),
  }))
})

test('Qwen ASR surfaces upload and API errors without submitting duplicate tasks', async t => {
  const file = await fixture(t)
  for (const failingStage of ['/uploads?', 'https://upload.example', '/services/audio/asr/transcription', '/tasks/', 'https://result.example']) {
    let failed = false
    const scripted = providerFetch()
    await assert.rejects(transcribeHistoryAudio(file, 10, { config, pollMs: 0, fetchFn: async (url, init) => {
      assert.equal(failed, false, 'No requests after a failed stage')
      if (String(url).includes(failingStage)) {
        failed = true
        return Response.json({ code: 'QuotaExceeded', message: 'no quota' }, { status: 429 })
      }
      return scripted(url, init)
    } }), /Qwen ASR.*429/)
    assert.equal(failed, true)
  }
})

test('Qwen ASR honors cancellation and an overall deadline while polling', async t => {
  const file = await fixture(t)
  const controller = new AbortController()
  let polls = 0
  const fetchFn = providerFetch({ task: { output: { task_status: 'RUNNING' } }, inspect(url) {
    if (url.includes('/tasks/')) { polls++; controller.abort(new Error('Stopped Qwen ASR')) }
  } })
  await assert.rejects(transcribeHistoryAudio(file, 10, { config, fetchFn, signal: controller.signal, pollMs: 0 }), /Stopped Qwen ASR/)
  assert.equal(polls, 1)
  await assert.rejects(transcribeHistoryAudio(file, 10, {
    config, fetchFn: providerFetch({ task: { output: { task_status: 'RUNNING' } } }), pollMs: 1, timeoutMs: 20,
  }), error => error instanceof Error && error.name === 'TimeoutError')
})
