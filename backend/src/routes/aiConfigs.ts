import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildEgakiChildEnv } from '../services/egaki-chatgpt-image.js'
import { maskSecret } from '../services/secret-crypto.js'
import { buildRightCodeTaskUrl } from '../services/adapters/rightcode-image.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')
const DEFAULT_EGAKI_BIN = path.join(repoRoot, 'backend/node_modules/.bin/egaki')
const DEFAULT_EGAKI_PROXY_BOOTSTRAP = path.join(repoRoot, 'backend/scripts/egaki-undici-proxy.mjs')

function parseSettings(settings: unknown): { success: true; value: any } | { success: false; error: string } {
  if (settings == null) return { success: true, value: null }
  if (typeof settings === 'object') return { success: true, value: settings }
  if (typeof settings !== 'string') return { success: false, error: 'settings must be an object or null' }
  try {
    const parsed = JSON.parse(settings)
    return { success: true, value: parsed }
  } catch {
    return { success: false, error: 'settings contains invalid JSON' }
  }
}

function parseConfigSettings(settings?: string | Record<string, any> | null): Record<string, any> | null {
  if (!settings) return null
  if (typeof settings === 'string') {
    try {
      return JSON.parse(settings)
    } catch {
      return null
    }
  }
  return settings
}

async function getMediaDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ])
    const duration = Number(String(stdout).trim())
    return Number.isFinite(duration) ? duration : null
  } catch {
    return null
  }
}

function validateImageAdapterSettings(settings: any, provider?: unknown): string | null {
  if (settings == null) return null
  if (typeof settings !== 'object') return 'settings must be an object'
  // pcore's GPT Image 2 is intentionally task-only in this system. Letting a
  // saved config request synchronous output creates a misleading UI state and
  // risks bypassing resumable provider-task recovery in future adapter edits.
  if (['pcore', 'gpt-image2'].includes(String(provider || '').trim().toLowerCase()) && settings.async === false) {
    return 'pcore GPT Image 2 requires async: true; synchronous mode is not supported'
  }
  const adapter = settings.adapter
  if (adapter == null) return null
  if (typeof adapter !== 'object') return 'settings.adapter must be an object'
  if (!adapter.request || typeof adapter.request !== 'object') return 'settings.adapter.request is required'
  if (typeof adapter.request.url !== 'string' || !adapter.request.url.trim()) return 'settings.adapter.request.url is required'
  if (adapter.response && typeof adapter.response !== 'object') return 'settings.adapter.response must be an object'
  return null
}

const app = new Hono()

function redactSecretText(value: string, secret?: string) {
  if (!secret) return value
  return value.split(secret).join('***')
}

const SENSITIVE_SETTING_KEY = /^(?:authorization|proxy-authorization|api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password)$/i
const TEMPLATE_VALUE = /\{\{[^{}]+\}\}/

function redactSecretInValue(value: unknown, secret?: string, fieldName = ''): unknown {
  if (value == null) return value
  if (SENSITIVE_SETTING_KEY.test(fieldName)) {
    if (typeof value === 'string' && TEMPLATE_VALUE.test(value) && (!secret || !value.includes(secret))) return value
    return '***'
  }
  if (typeof value === 'string') return redactSecretText(value, secret)
  if (Array.isArray(value)) return value.map(item => redactSecretInValue(item, secret))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecretInValue(child, secret, key)]))
  }
  return value
}

function serializeConfig(row: typeof schema.aiServiceConfigs.$inferSelect) {
  const { apiKey, ...safeRow } = row
  return {
    ...toSnakeCase(safeRow),
    api_key_configured: Boolean(apiKey),
    api_key_hint: maskSecret(apiKey),
    model: row.model ? JSON.parse(row.model) : [],
    settings: row.settings ? redactSecretInValue(JSON.parse(row.settings), apiKey) : null,
  }
}

const HUOBAO_PRESET_SERVICES = [
  { serviceType: 'text', label: '文本', provider: 'chatfire', baseUrl: 'https://api.chatfire.site', model: 'gemini-3-pro-preview', priority: 100 },
  { serviceType: 'image', label: '图片', provider: 'gemini', baseUrl: 'https://api.chatfire.site', model: 'gemini-3-pro-image-preview', priority: 99 },
  { serviceType: 'video', label: '视频', provider: 'volcengine', baseUrl: 'https://api.chatfire.site/volcengine', model: 'doubao-seedance-1-5-pro-251215', priority: 98 },
  { serviceType: 'audio', label: '音频', provider: 'minimax', baseUrl: 'https://api.chatfire.site/minimax', model: 'speech-2.8-hd', priority: 97 },
] as const

const HUOBAO_AGENT_DEFAULTS = [
  { agentType: 'script_rewriter', name: '剧本改写' },
  { agentType: 'extractor', name: '角色场景提取' },
  { agentType: 'storyboard_breaker', name: '分镜拆解' },
  { agentType: 'voice_assigner', name: '音色分配' },
  { agentType: 'grid_prompt_generator', name: '图片提示词生成' },
] as const

const HUOBAO_AGENT_MODEL = 'gemini-3-pro-preview'

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function viduHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Token ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'rightcode' || p === 'rightcodes' || p === 'right') {
    return {
      method: 'GET',
      url: buildRightCodeTaskUrl(baseUrl, 'connection-probe'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'gpt-image2' || p === 'gpt-image-2' || p === 'pcore') {
    return {
      // The provider exposes no documented models/health endpoint. Use a
      // harmless GET so testing a config never creates a billable image task.
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/images/generations/connection-probe'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'gemini') {
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${m || 'gemini-2.5-flash'}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return { method: 'POST', url: url.toString(), headers: geminiHeaders(apiKey, true), body: {} }
  }

  if (p === 'openai' || p === 'openrouter' || p === 'chatfire') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'ali') {
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v1', serviceType === 'video'
        ? '/services/aigc/video-generation/video-synthesis'
        : '/services/aigc/image-generation/generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'volcengine') {
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'minimax') {
    const path = serviceType === 'audio'
      ? '/t2a_v2'
      : serviceType === 'video'
        ? '/video_generation'
        : '/image_generation'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v1', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'vidu') {
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '', '/ent/v2/img2video'),
      headers: viduHeaders(apiKey, true),
      body: {},
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

async function probeEgakiChatGpt() {
  const egakiBin = process.env.EGAKI_BIN || DEFAULT_EGAKI_BIN
  if (!fs.existsSync(egakiBin)) {
    return {
      ok: false,
      reachable: false,
      status: 0,
      status_text: 'egaki CLI missing',
      method: 'LOCAL',
      url: 'egaki login --show',
      message: `未找到 egaki CLI: ${egakiBin}`,
      response_preview: '',
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(egakiBin, ['login', '--show'], {
      env: buildEgakiChildEnv(process.env, process.env.EGAKI_PROXY_BOOTSTRAP || DEFAULT_EGAKI_PROXY_BOOTSTRAP),
      timeout: 30_000,
      maxBuffer: 64_000,
    })
    const output = `${stdout}\n${stderr}`
    const hasChatGpt = /chatgpt/i.test(output)
    const hasUsableAuth = /(signed|login|token|plan|account|chatgpt)/i.test(output)
    return {
      ok: hasChatGpt || hasUsableAuth,
      reachable: true,
      status: 0,
      status_text: 'local probe complete',
      method: 'LOCAL',
      url: 'egaki login --show',
      message: hasChatGpt || hasUsableAuth
        ? 'egaki CLI 可执行，ChatGPT 登录状态可读取'
        : 'egaki CLI 可执行，但未确认 ChatGPT 登录状态；请运行 egaki login --provider chatgpt',
      response_preview: 'egaki login --show output redacted',
    }
  } catch (error: any) {
    return {
      ok: false,
      reachable: false,
      status: 0,
      status_text: 'local probe failed',
      method: 'LOCAL',
      url: 'egaki login --show',
      message: error?.message?.includes('timed out')
        ? 'egaki 登录状态检查超时，请确认代理和 ChatGPT 登录状态'
        : 'egaki 登录状态不可用，请运行 egaki login --provider chatgpt',
      response_preview: '',
    }
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = db.select().from(schema.aiServiceConfigs).all()
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(serializeConfig)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, 'service_type and provider are required')
  }

  const settingsResult = parseSettings(body.settings)
  if (!settingsResult.success) return badRequest(c, settingsResult.error)

  if (body.service_type === 'image') {
    const adapterError = validateImageAdapterSettings(settingsResult.value, body.provider)
    if (adapterError) return badRequest(c, adapterError)
  }

  const res = db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: settingsResult.value ? JSON.stringify(settingsResult.value) : null,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, Number(res.lastInsertRowid))).all()

  return created(c, serializeConfig(row))
})

// POST /ai-configs/huobao-preset
app.post('/huobao-preset', async (c) => {
  const body = await c.req.json()
  const apiKey = String(body.api_key || '').trim()
  if (!apiKey) return badRequest(c, 'api_key is required')

  const ts = now()

  for (const preset of HUOBAO_PRESET_SERVICES) {
    const [existing] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, preset.serviceType)).all()
      .filter(row => row.provider === preset.provider)

    const values = {
      serviceType: preset.serviceType,
      provider: preset.provider,
      name: `火宝默认${preset.label}服务`,
      baseUrl: preset.baseUrl,
      apiKey,
      model: JSON.stringify([preset.model]),
      priority: preset.priority,
      isActive: true,
      updatedAt: ts,
    }

    if (existing) {
      db.update(schema.aiServiceConfigs).set(values).where(eq(schema.aiServiceConfigs.id, existing.id)).run()
    } else {
      db.insert(schema.aiServiceConfigs).values({
        ...values,
        createdAt: ts,
      }).run()
    }
  }

  for (const agent of HUOBAO_AGENT_DEFAULTS) {
    const [existing] = db.select().from(schema.agentConfigs).where(eq(schema.agentConfigs.agentType, agent.agentType)).all()
    const values = {
      name: agent.name,
      model: HUOBAO_AGENT_MODEL,
      isActive: true,
      updatedAt: ts,
    }

    if (existing) {
      db.update(schema.agentConfigs).set(values).where(eq(schema.agentConfigs.id, existing.id)).run()
    } else {
      db.insert(schema.agentConfigs).values({
        agentType: agent.agentType,
        description: '',
        model: HUOBAO_AGENT_MODEL,
        name: agent.name,
        systemPrompt: '',
        temperature: 0.7,
        maxTokens: 4096,
        maxIterations: 10,
        isActive: true,
        createdAt: ts,
        updatedAt: ts,
      }).run()
    }
  }

  const configs = db.select().from(schema.aiServiceConfigs).all().map(serializeConfig)
  const agents = db.select().from(schema.agentConfigs).all().map(row => toSnakeCase(row))

  logTaskSuccess('AIConfig', 'huobao-preset-applied', {
    serviceCount: HUOBAO_PRESET_SERVICES.length,
    agentCount: HUOBAO_AGENT_DEFAULTS.length,
  })

  return success(c, {
    configs,
    agents,
    agent_model: HUOBAO_AGENT_MODEL,
  })
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  const configId = Number(body.config_id)
  const [storedConfig] = Number.isInteger(configId) && configId > 0
    ? db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).all()
    : []
  if (configId && !storedConfig) return notFound(c, '配置不存在')

  const serviceType = storedConfig?.serviceType || body.service_type
  const providerName = storedConfig?.provider || body.provider
  const baseUrl = storedConfig?.baseUrl || body.base_url
  const apiKey = storedConfig?.apiKey || body.api_key
  const configModel = storedConfig?.model ? JSON.parse(storedConfig.model) : body.model
  const provider = String(providerName || '').toLowerCase()
  if (!serviceType || !providerName || (provider !== 'egaki-chatgpt' && !baseUrl)) {
    return badRequest(c, 'service_type, provider and base_url are required')
  }

  if (serviceType === 'image' && provider === 'egaki-chatgpt') {
    const payload = await probeEgakiChatGpt()
    if (payload.ok) logTaskSuccess('AIConfig', 'egaki-chatgpt-probe-done', { reachable: payload.reachable })
    else logTaskError('AIConfig', 'egaki-chatgpt-probe-failed', { message: payload.message })
    return success(c, payload)
  }

  const model = Array.isArray(configModel) ? configModel[0] : configModel
  const probe = buildProbe(serviceType, providerName, baseUrl, model, apiKey)
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType,
    provider: providerName,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    })
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
      || ((provider === 'rightcode' || provider === 'rightcodes' || provider === 'right'
        || provider === 'gpt-image2' || provider === 'gpt-image-2' || provider === 'pcore') && resp.status === 404)
    const payload = {
      ok: resp.ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message: reachable
        ? (resp.ok ? '端点可访问，认证与路径基本正常' : '端点已响应，请根据状态码判断认证或路径是否正确')
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: redactSecretText(text.slice(0, 240), apiKey),
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: providerName,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: providerName,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    const safeErrorMessage = redactSecretText(error.message || '请求失败', apiKey)
    logTaskError('AIConfig', 'probe-failed', {
      provider: providerName,
      url: probeUrl,
      error: safeErrorMessage,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: safeErrorMessage,
      response_preview: '',
    })
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row) return notFound(c)
  return success(c, serializeConfig(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }

  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if (body.clear_api_key === true) updates.apiKey = ''
  else if (typeof body.api_key === 'string' && body.api_key.trim()) updates.apiKey = body.api_key.trim()
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active

  if ('settings' in body) {
    const settingsResult = parseSettings(body.settings)
    if (!settingsResult.success) return badRequest(c, settingsResult.error)

    const [existing] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).all()
    const serviceType = body.service_type || existing?.serviceType
    if (serviceType === 'image') {
      const adapterError = validateImageAdapterSettings(settingsResult.value, body.provider || existing?.provider)
      if (adapterError) return badRequest(c, adapterError)
    }

    updates.settings = settingsResult.value ? JSON.stringify(settingsResult.value) : null
  }

  db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id)).run()
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).run()
  return success(c)
})

// POST /ai-configs/:id/clone-voice — 上传参考音频并复刻音色（SiliconFlow）
app.post('/:id/clone-voice', async (c) => {
  const id = Number(c.req.param('id'))
  const [config] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!config) return notFound(c, '配置不存在')
  if (config.provider?.toLowerCase() !== 'siliconflow') {
    return badRequest(c, '仅 siliconflow 配置支持音色复刻')
  }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  const text = String(formData.get('text') || '').trim()
  const customName = String(formData.get('custom_name') || 'custom_voice').trim()

  if (!file) return badRequest(c, 'file is required')
  if (!text) return badRequest(c, 'text is required')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siliconflow-clone-'))
  try {
    const originalPath = path.join(tmpDir, 'original')
    fs.writeFileSync(originalPath, Buffer.from(await file.arrayBuffer()))

    const duration = await getMediaDurationSeconds(originalPath)
    if (duration && duration > 30) {
      return badRequest(c, `参考音频时长 ${duration.toFixed(1)} 秒，SiliconFlow 音色复刻需要 30 秒以内。请先裁剪成 5-30 秒，并保证文本与音频逐字匹配。`)
    }

    const fileName = file.name || ''
    const isVideo = file.type?.startsWith('video/') || /\.mp4$/i.test(fileName)

    let audioPath = originalPath
    if (isVideo) {
      audioPath = path.join(tmpDir, 'audio.wav')
      await execFileAsync('ffmpeg', [
        '-y', '-i', originalPath,
        '-vn', '-acodec', 'pcm_s16le',
        '-ar', '22050', '-ac', '1',
        audioPath,
      ])
    }

    const uploadAudioPath = path.join(tmpDir, 'voice.mp3')
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', audioPath,
      '-acodec', 'libmp3lame',
      '-ar', '22050', '-ac', '1', '-q:a', '4',
      uploadAudioPath,
    ])

    const models = config.model ? JSON.parse(config.model) : []
    const model = models[0] || 'FunAudioLLM/CosyVoice2-0.5B'

    const uploadForm = new FormData()
    uploadForm.append('model', model)
    uploadForm.append('customName', customName)
    uploadForm.append('text', text)
    const voiceBlob = new Blob([fs.readFileSync(uploadAudioPath)], { type: 'audio/mpeg' })
    // Docs show `1.file`, while the live API also accepts/expects `file`.
    // Send both so browser uploads work across SiliconFlow's documented and deployed variants.
    uploadForm.append('file', voiceBlob, 'voice.mp3')
    uploadForm.append('1.file', voiceBlob, 'voice.mp3')

    logTaskProgress('AIConfig', 'clone-voice-upload', { configId: id, model, customName, duration })
    const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/uploads/audio/voice'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: uploadForm,
    })
    const result = await resp.json()
    if (!resp.ok || !result.uri) {
      logTaskError('AIConfig', 'clone-voice-failed', { configId: id, status: resp.status, result })
      return badRequest(c, result.message || `音色复刻失败: ${resp.status}`)
    }

    const settings = parseConfigSettings(config.settings) || {}
    settings.useForNarration = true
    settings.narrationVoiceUri = result.uri

    db.update(schema.aiServiceConfigs)
      .set({ settings: JSON.stringify(settings), updatedAt: now() })
      .where(eq(schema.aiServiceConfigs.id, id))
      .run()

    logTaskSuccess('AIConfig', 'clone-voice-done', { configId: id, uri: result.uri })
    return success(c, { uri: result.uri })
  } catch (err: any) {
    logTaskError('AIConfig', 'clone-voice-error', { configId: id, error: err.message })
    return badRequest(c, err.message || '音色复刻失败')
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = db.select().from(schema.aiServiceProviders).all()
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
