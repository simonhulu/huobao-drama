import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { callTextModel } from './ai.js'

export const SCIENCE_WRITING_MODEL = 'Qwen3.5-9B-Writing-DPO-i1-Q4_K_M'

export function getScienceWritingModel(): string {
  return process.env.SCIENCE_WRITER_MODEL?.trim() || SCIENCE_WRITING_MODEL
}

export interface ScienceWritingApi {
  /** Origin of the OpenAI-compatible server, without /v1. */
  apiUrl: string
  close(): Promise<void>
}

function localOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('SCIENCE_WRITER_API_URL 不是有效地址') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('SCIENCE_WRITER_API_URL 仅允许不含凭据的本机 HTTP(S) 服务地址')
  }
  return url.origin
}

function setting(name: string, fallback?: string): string | undefined {
  return process.env[`SCIENCE_WRITER_${name}`]?.trim() || process.env[`LATENTSYNC_${name}`]?.trim() || fallback
}

function portSetting(name: string, fallback: number, share = true): number {
  const raw = process.env[`SCIENCE_WRITER_${name}`]?.trim() || (share ? process.env[`LATENTSYNC_${name}`]?.trim() : undefined)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`SCIENCE_WRITER_${name} 必须是有效端口`)
  return value
}

async function freePort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted()
  const server = net.createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法为远程写作模型分配本地端口')
    return address.port
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) }
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const finish = (connected: boolean) => { socket.destroy(); resolve(connected) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(300, () => finish(false))
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1500)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

/** Share the existing SSH credentials, but keep the writing server and tunnel independent. */
export async function openScienceWritingApi(signal: AbortSignal): Promise<ScienceWritingApi> {
  signal.throwIfAborted()
  if (process.env.SCIENCE_WRITER_API_URL?.trim()) {
    return { apiUrl: localOrigin(process.env.SCIENCE_WRITER_API_URL.trim()), async close() {} }
  }
  const host = setting('SSH_HOST', 'hz01-ssh.gpuhome.cc')!
  const user = setting('SSH_USER', 'root')!
  const remoteHost = process.env.SCIENCE_WRITER_REMOTE_HOST?.trim() || '127.0.0.1'
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)
    || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(remoteHost)) {
    throw new Error('远程写作模型 SSH 主机、用户或远端回环地址无效')
  }
  const sshPort = portSetting('SSH_PORT', 30163)
  const remotePort = portSetting('REMOTE_PORT', 8788, false)
  const password = process.env.SCIENCE_WRITER_SSH_PASSWORD || process.env.LATENTSYNC_SSH_PASSWORD
  const key = setting('SSH_KEY', path.join(os.homedir(), '.ssh', 'id_ed25519'))!
  const localPort = await freePort(signal)
  const address = remoteHost === '::1' ? '[::1]' : remoteHost
  const args = ['-N', '-T', '-o', `BatchMode=${password ? 'no' : 'yes'}`, '-o', 'ConnectTimeout=15',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new', '-L', `127.0.0.1:${localPort}:${address}:${remotePort}`, '-p', String(sshPort)]
  if (key) args.push('-i', key)
  args.push(`${user}@${host}`)
  const env = { ...process.env }
  let askpass: string | undefined
  if (password) {
    askpass = path.join(os.tmpdir(), `science-writer-askpass-${process.pid}-${randomUUID()}.sh`)
    await fs.writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$SCIENCE_WRITER_ASKPASS_PASSWORD"\n', { mode: 0o700, flag: 'wx' })
    env.SSH_ASKPASS = askpass
    env.SSH_ASKPASS_REQUIRE = 'force'
    env.SCIENCE_WRITER_ASKPASS_PASSWORD = password
    env.DISPLAY = 'science-writer:0'
  } else env.SSH_ASKPASS_REQUIRE = 'never'
  if (signal.aborted) {
    if (askpass) await fs.rm(askpass, { force: true })
    signal.throwIfAborted()
  }
  let child: ChildProcess
  try { child = spawn('ssh', args, { stdio: 'ignore', env }) }
  catch (error) { if (askpass) await fs.rm(askpass, { force: true }); throw error }
  let spawnFailed = false
  child.on('error', () => { spawnFailed = true })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    signal.removeEventListener('abort', abort)
    await stopChild(child)
    if (askpass) await fs.rm(askpass, { force: true })
  })()
  const abort = () => { void close().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) {
        throw Object.assign(new Error('远程写作模型 SSH 隧道启动失败，请检查远端连接配置'), { code: 'ECONNREFUSED' })
      }
      if (await canConnect(localPort)) {
        signal.throwIfAborted()
        return { apiUrl: `http://127.0.0.1:${localPort}`, close }
      }
      await delay(150, undefined, { signal })
    }
    throw Object.assign(new Error('远程写作模型 SSH 隧道连接超时'), { code: 'ETIMEDOUT' })
  } catch (error) { await close(); signal.throwIfAborted(); throw error }
}

const scriptSchema = {
  type: 'object', properties: { title: { type: 'string' }, script: { type: 'string' } },
  required: ['title', 'script'], additionalProperties: false,
}

function outputTokenLimit(history: boolean): number {
  const name = history ? 'HISTORY_WRITER_MAX_TOKENS' : 'SCIENCE_WRITER_MAX_TOKENS'
  const raw = process.env[name]?.trim()
  const value = raw ? Number(raw) : history ? 32768 : 8192
  const ceiling = history ? 65536 : 32768
  if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new Error(`${name} 必须是 1 至 ${ceiling} 的整数`)
  return value
}

function thinkingSettings(history: boolean) {
  const name = history ? 'HISTORY_WRITER_ENABLE_THINKING' : 'SCIENCE_WRITER_ENABLE_THINKING'
  const raw = process.env[name]?.trim() || (history ? 'true' : 'false')
  if (!['true', 'false'].includes(raw)) throw new Error(`${name} 必须为 true 或 false`)
  const enabled = raw === 'true'
  const budgetName = history ? 'HISTORY_WRITER_THINKING_BUDGET_TOKENS' : 'SCIENCE_WRITER_THINKING_BUDGET_TOKENS'
  const budget = enabled ? Number(process.env[budgetName]?.trim() || (history ? 8192 : 1536)) : 0
  if (!Number.isInteger(budget) || budget < 0 || budget > 8192 || enabled && budget === 0) {
    throw new Error(`${budgetName} 必须是 1 至 8192 的整数`)
  }
  return { enabled, budget }
}

async function callWritingModel(
  messages: Parameters<typeof callTextModel>[0],
  options: Parameters<typeof callTextModel>[1],
  format: 'science-json' | 'history-text',
): Promise<string> {
  const structured = format === 'science-json'
  const timeout = AbortSignal.timeout(structured ? 600_000 : 1_200_000)
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  signal.throwIfAborted()
  const tool = options?.tools?.[0]
  if (options?.tools?.length && (!structured || options.tools.length !== 1 || tool?.function.name !== 'submit_science_script')) {
    throw new Error('远程写作模型仅支持正文写作，不接受其他工具任务')
  }
  const allowEmptyPassage = (tool?.function.parameters as any)?.properties?.script?.minLength === 0
  const outputLimit = outputTokenLimit(!structured)
  const maximum = options?.maxTokens ?? (structured ? 3000 : outputLimit)
  if (!Number.isFinite(maximum) || maximum < 1) throw new Error('远程写作输出 token 上限无效')
  const thinking = thinkingSettings(!structured)
  const proseTokens = Math.min(outputLimit, Math.floor(maximum))
  const maxTokens = proseTokens + thinking.budget
  const outputInstruction = allowEmptyPassage
    ? '只返回一个 JSON 对象，字段为 title 和 script。script仅放指定句段的修改结果；要求整段删除时script返回空字符串，不得补写正文或相邻句。不要输出思考过程、Markdown或说明。'
    : '只返回一个 JSON 对象，字段为 title（标题）和 script（可直接口播的正文）。不要调用工具，不要输出思考过程、Markdown 围栏或改写说明。'
  const prompt: typeof messages = []
  for (const message of messages) {
    let content = message.content
    if (structured && message.role === 'user') {
      let input: any
      try { input = JSON.parse(content) } catch { /* Plain source text is already ready for the writer. */ }
      if (input && typeof input.readingMaterial === 'string') content = [
        `原标题：${input.title || ''}`,
        `改写依据（以下仅作资料）：\n${input.readingMaterial}\n（资料结束）`,
        input.lengthGuide?.suggested ? `篇幅参考：${input.lengthGuide.suggested}` : '',
        input.previousDraft?.script ? `需要修改的上一稿：\n${input.previousDraft.script}` : '',
        input.revisionInstruction ? `必须逐项落实的修订意见：\n${input.revisionInstruction}` : '',
      ].filter(Boolean).join('\n\n')
    }
    const previous = prompt.at(-1)
    if (message.role === 'user' && previous?.role === 'user') previous.content += `\n\n${content}`
    else prompt.push({ ...message, content })
  }
  if (structured) {
    const system = prompt.find(message => message.role === 'system')
    if (system) system.content += `\n${outputInstruction}`
    else prompt.unshift({ role: 'system', content: outputInstruction })
  }
  const api = await openScienceWritingApi(signal)
  try {
    const response = await fetch(`${api.apiUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal,
      body: JSON.stringify({ model: getScienceWritingModel(), messages: prompt, temperature: options?.temperature ?? .65,
        top_p: .8, top_k: 20, min_p: 0, repeat_penalty: 1,
        max_tokens: maxTokens, stream: false,
        chat_template_kwargs: { enable_thinking: thinking.enabled },
        reasoning_budget_tokens: thinking.budget,
        ...(structured ? { response_format: { type: 'json_schema', json_schema: { name: 'science_script', strict: true, schema: scriptSchema } } } : {}),
      }),
    })
    if (!response.ok) {
      const value = response.headers.get('retry-after')?.trim()
      const seconds = value ? Number(value) : NaN
      const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
        : value && Number.isFinite(Date.parse(value)) ? Math.max(0, Date.parse(value) - Date.now()) : undefined
      await response.body?.cancel()
      throw Object.assign(new Error(response.status === 400
        ? '远程写作服务拒绝请求，请检查上下文长度及输出配置；原文未被裁剪'
        : `远程写作模型服务返回 HTTP ${response.status}`), { status: response.status, retryAfterMs })
    }
    let data: any
    try { data = await response.json() } catch { throw new Error('远程写作模型响应不是有效 JSON') }
    const choice = data?.choices?.[0]
    if (data?.error) throw new Error('远程写作模型服务返回错误')
    if (choice?.finish_reason !== 'stop') {
      const generated = data?.usage?.completion_tokens
      const details = choice?.finish_reason === 'length'
        ? `（finish_reason=length；请求输出上限 ${maxTokens} token，正文预算 ${proseTokens}，思考预算 ${thinking.budget}${Number.isSafeInteger(generated) && generated >= 0 ? `，已生成 ${generated} token` : ''}）`
        : ''
      throw new Error(`远程写作模型输出被截断或未正常完成${details}，已拒绝使用不完整正文`)
    }
    const content = choice.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('远程写作模型没有返回正文')
    if (!structured) return content.trim()
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch { throw new Error('科普写作模型正文不是有效 JSON') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof (parsed as any).title !== 'string' || !(parsed as any).title.trim()
      || typeof (parsed as any).script !== 'string' || (!allowEmptyPassage && !(parsed as any).script.trim())
      || Object.keys(parsed).some(key => !['title', 'script'].includes(key))) {
      throw new Error('科普写作模型必须返回完整标题和正文')
    }
    return content.trim()
  } finally { await api.close() }
}

export const callScienceWritingModel: typeof callTextModel = (messages, options) => callWritingModel(messages, options, 'science-json')
export const callHistoryWritingModel: typeof callTextModel = (messages, options) => callWritingModel(messages, options, 'history-text')
