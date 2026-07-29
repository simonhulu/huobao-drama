import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'

const dbDir = mkdtempSync(join(tmpdir(), 'huobao-ai-configs-'))
const dbPath = join(dbDir, 'test.db')
process.env.DB_PATH = dbPath
process.env.AI_CONFIG_KEY_FILE = join(dbDir, 'secret.key')

const initialDb = new Database(dbPath)
initialDb.exec(`
  CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)
initialDb.prepare(`
  INSERT INTO ai_service_configs
    (service_type, provider, name, base_url, api_key, model, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run('image', 'apimart', 'APIMart', 'https://api.apimart.ai', 'legacy-plain-key', '["gpt-image-2"]', 'now', 'now')
initialDb.close()

const { db, schema } = await import('../db/index.js')
const route = (await import('./aiConfigs.js')).default
const originalFetch = global.fetch

after(() => {
  global.fetch = originalFetch
})

function rawKey(id: number) {
  const rawDb = new Database(dbPath, { readonly: true })
  try {
    return (rawDb.prepare('SELECT api_key FROM ai_service_configs WHERE id = ?').get(id) as { api_key: string }).api_key
  } finally {
    rawDb.close()
  }
}

test('migrates plaintext keys and decrypts them transparently for backend use', () => {
  const [config] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, 1)).all()

  assert.equal(config.apiKey, 'legacy-plain-key')
  assert.match(rawKey(1), /^enc:v1:/)
  assert.doesNotMatch(rawKey(1), /legacy-plain-key/)
})

test('list and detail responses expose only key status and hint', async () => {
  db.update(schema.aiServiceConfigs).set({
    settings: JSON.stringify({
      customHeader: 'Bearer legacy-plain-key',
      headers: {
        Authorization: 'Bearer nested-other-token',
        'x-api-key': 'different-secret',
        template: 'Bearer {{apiKey}}',
      },
      credentials: { token: 'nested-token', password: 'nested-password' },
      request: { Authorization: 'Bearer {{apiKey}}' },
    }),
  }).where(eq(schema.aiServiceConfigs.id, 1)).run()

  const listResponse = await route.request('/')
  const listJson = await listResponse.json()
  const listed = listJson.data[0]

  assert.equal(listed.api_key, undefined)
  assert.equal(listed.api_key_configured, true)
  assert.equal(listed.api_key_hint, '****-key')
  assert.equal(listed.settings.customHeader, 'Bearer ***')
  assert.equal(listed.settings.headers.Authorization, '***')
  assert.equal(listed.settings.headers['x-api-key'], '***')
  assert.equal(listed.settings.credentials.token, '***')
  assert.equal(listed.settings.credentials.password, '***')
  assert.equal(listed.settings.request.Authorization, 'Bearer {{apiKey}}')
  assert.equal(listed.settings.headers.template, 'Bearer {{apiKey}}')

  const detailResponse = await route.request('/1')
  const detailJson = await detailResponse.json()
  assert.equal(detailJson.data.api_key, undefined)
  assert.equal(detailJson.data.api_key_configured, true)
})

test('blank key updates preserve the existing encrypted secret', async () => {
  const before = rawKey(1)
  const response = await route.request('/1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed', api_key: '' }),
  })

  assert.equal(response.status, 200)
  assert.equal(rawKey(1), before)
  const [config] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, 1)).all()
  assert.equal(config.apiKey, 'legacy-plain-key')
})

test('new keys are encrypted and create responses remain redacted', async () => {
  const response = await route.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_type: 'text',
      provider: 'openai',
      name: 'OpenAI',
      base_url: 'https://api.openai.com',
      api_key: 'new-secret-key',
      model: ['test-model'],
    }),
  })
  const json = await response.json()

  assert.equal(response.status, 201)
  assert.equal(json.data.api_key, undefined)
  assert.equal(json.data.api_key_configured, true)
  assert.match(rawKey(json.data.id), /^enc:v1:/)
  assert.doesNotMatch(rawKey(json.data.id), /new-secret-key/)
})

test('replacement keys are encrypted and returned only as status metadata', async () => {
  const response = await route.request('/1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: 'replacement-secret-key' }),
  })
  const json = await response.json()

  assert.equal(response.status, 200)
  assert.equal(json.data, null)
  assert.match(rawKey(1), /^enc:v1:/)
  assert.doesNotMatch(rawKey(1), /replacement-secret-key/)
  const [config] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, 1)).all()
  assert.equal(config.apiKey, 'replacement-secret-key')
})

test('clear_api_key explicitly clears an existing secret', async () => {
  const response = await route.request('/1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear_api_key: true }),
  })
  const json = await response.json()

  assert.equal(response.status, 200)
  assert.equal(rawKey(1), '')
  assert.equal(json.data, null)
  const detail = await (await route.request('/1')).json()
  assert.equal(detail.data.api_key_configured, false)
  assert.equal(detail.data.api_key_hint, null)
})

test('malformed encrypted-looking input is encrypted as plaintext instead of bypassing encryption', async () => {
  const response = await route.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_type: 'text',
      provider: 'openai',
      name: 'Malformed prefix',
      base_url: 'https://api.openai.com',
      api_key: 'enc:v1:not-valid',
      model: ['test-model'],
    }),
  })
  const json = await response.json()
  const stored = rawKey(json.data.id)

  assert.equal(response.status, 201)
  assert.match(stored, /^enc:v1:/)
  assert.notEqual(stored, 'enc:v1:not-valid')
  const [config] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, json.data.id)).all()
  assert.equal(config.apiKey, 'enc:v1:not-valid')
})

test('stored-config probes use the decrypted key without sending it to the browser', async () => {
  db.update(schema.aiServiceConfigs).set({ apiKey: 'legacy-plain-key' })
    .where(eq(schema.aiServiceConfigs.id, 1)).run()
  let authorization = ''
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get('Authorization') || ''
    return new Response('{"error":"legacy-plain-key"}', { status: 200 })
  }) as typeof fetch

  const response = await route.request('/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_id: 1 }),
  })

  assert.equal(response.status, 200)
  assert.equal(authorization, 'Bearer legacy-plain-key')
  const json = await response.json()
  assert.doesNotMatch(json.data.response_preview, /legacy-plain-key/)
  assert.match(json.data.response_preview, /\*\*\*/)
})

test('pcore GPT Image 2 refuses a synchronous image-mode setting', async () => {
  const response = await route.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_type: 'image',
      provider: 'pcore',
      name: 'Pcore',
      base_url: 'https://pcore.ai',
      api_key: 'test-key',
      model: ['gpt-image-2'],
      settings: { async: false },
    }),
  })

  const json = await response.json()
  assert.equal(response.status, 400)
  assert.match(json.message, /requires async: true/)
})
