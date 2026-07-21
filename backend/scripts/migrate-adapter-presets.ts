/**
 * 迁移脚本：为现有 image/video/audio 类型的 ai_service_configs 填充 adapter 预设配置
 * 运行方式：npx tsx backend/scripts/migrate-adapter-presets.ts
 * 环境变量：DATABASE_URL（可选，默认使用项目内 SQLite）
 */
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq, or, isNull } from 'drizzle-orm'
import * as schema from '../src/db/schema'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DB_PATH = process.env.DATABASE_URL
  ? (process.env.DATABASE_URL.startsWith('file:')
      ? process.env.DATABASE_URL.replace('file:', '')
      : process.env.DATABASE_URL)
  : path.resolve(__dirname, '../../data/huobao_drama.db')

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`)
  process.exit(1)
}

const sqlite = new Database(DB_PATH, { timeout: 30000 })
sqlite.pragma('journal_mode = WAL')

const db = drizzle(sqlite, { schema })

const IMAGE_ADAPTER_PRESETS: Record<string, Record<string, unknown>> = {
  openai: {
    adapter: {
      request: {
        url: '/v1/images/generations',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{apiKey}}' },
        body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: 1, response_format: 'url' },
      },
      response: {
        asyncWhenPath: 'task_id',
        taskIdPath: 'task_id',
        imageUrlPath: 'data.0.url',
      },
      poll: {
        request: {
          url: '/v1/images/task/{{taskId}}',
          method: 'GET',
          headers: { Authorization: 'Bearer {{apiKey}}' },
        },
        response: {
          statusPath: 'status',
          completedValues: ['completed'],
          failedValues: ['failed'],
          imageUrlPath: 'image_url',
        },
      },
    },
  },

  minimax: {
    adapter: {
      request: {
        url: '/v1/image_generation',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{apiKey}}' },
        body: { model: '{{model}}', prompt: '{{prompt}}', aspect_ratio: '{{aspectRatio}}', n: 1, response_format: 'url' },
      },
      response: {
        imageUrlPath: 'data.image_urls.0',
      },
      size: { strategy: 'aspectRatio' },
    },
  },

  gemini: {
    adapter: {
      request: {
        url: '{{baseUrl}}/v1beta/models/{{model}}:generateContent?key={{apiKey}}',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          contents: [{ parts: [{ text: '{{prompt}}' }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        },
      },
      response: {
        imageUrlPath: 'predictions.0.imageUrl',
        base64Path: 'predictions.0.bytesBase64Encoded',
      },
      size: { strategy: 'aspectRatio' },
    },
  },

  ali: {
    adapter: {
      request: {
        url: '/api/v1/services/aigc/image-generation/generation',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{apiKey}}' },
        body: {
          model: '{{model}}',
          input: { messages: [{ role: 'user', content: [{ text: '{{prompt}}' }] }] },
          parameters: { size: '{{size}}', n: 1, seed: '{{seed}}' },
        },
      },
      response: {
        asyncWhenPath: 'output.task_id',
        taskIdPath: 'output.task_id',
      },
      poll: {
        request: {
          url: '/api/v1/tasks/{{taskId}}',
          method: 'GET',
          headers: { Authorization: 'Bearer {{apiKey}}' },
        },
        response: {
          statusPath: 'output.task_status',
          completedValues: ['SUCCEEDED'],
          failedValues: ['FAILED'],
          imageUrlPath: 'output.choices.0.message.content.0.image',
        },
      },
      size: { strategy: 'passthrough' },
    },
  },

  volcengine: {
    adapter: {
      request: {
        url: '/api/v3/images/generations',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{apiKey}}' },
        body: { model: '{{model}}', prompt: '{{prompt}}', width: '{{width}}', height: '{{height}}' },
      },
      response: {
        asyncWhenPath: 'task_id',
        taskIdPath: 'task_id',
        imageUrlPath: 'data.0.url',
      },
      poll: {
        request: {
          url: '/api/v3/images/generations/{{taskId}}',
          method: 'GET',
          headers: { Authorization: 'Bearer {{apiKey}}' },
        },
        response: {
          statusPath: 'status',
          completedValues: ['succeeded'],
          failedValues: ['failed'],
          imageUrlPath: 'data.0.url',
        },
      },
      size: { strategy: 'widthHeight' },
    },
  },

  chatfire: {
    adapter: {
      request: {
        url: '/v1/images/generations',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {{apiKey}}' },
        body: { model: '{{model}}', prompt: '{{prompt}}', size: '{{size}}', n: 1, response_format: 'url' },
      },
      response: {
        asyncWhenPath: 'task_id',
        taskIdPath: 'task_id',
        imageUrlPath: 'data.0.url',
      },
      poll: {
        request: {
          url: '/v1/images/task/{{taskId}}',
          method: 'GET',
          headers: { Authorization: 'Bearer {{apiKey}}' },
        },
        response: {
          statusPath: 'status',
          completedValues: ['completed'],
          failedValues: ['failed'],
          imageUrlPath: 'image_url',
        },
      },
    },
  },
}

function getPresetForRow(row: typeof schema.aiServiceConfigs.$inferSelect): Record<string, unknown> | null {
  const provider = (row.provider || '').toLowerCase()
  const serviceType = (row.serviceType || '').toLowerCase()

  if (serviceType === 'image') {
    return IMAGE_ADAPTER_PRESETS[provider] || null
  }

  return null
}

function hasValidAdapter(settings: string | null): boolean {
  if (!settings) return false
  try {
    const parsed = JSON.parse(settings)
    const adapter = parsed?.adapter
    if (!adapter || typeof adapter !== 'object') return false
    return typeof adapter.request?.url === 'string' && adapter.request.url.trim().length > 0
  } catch {
    return false
  }
}

async function main() {
  console.log(`Using database: ${DB_PATH}`)

  const allRows = db.select().from(schema.aiServiceConfigs).all()
  const rows = allRows.filter(row => {
    if (row.serviceType !== 'image') return false
    return !hasValidAdapter(row.settings)
  })

  console.log(`Found ${rows.length} image configs needing adapter preset migration`)

  let updated = 0
  let skipped = 0
  const updatedRows: Array<{ id: number; provider: string | null; serviceType: string; name: string }> = []

  for (const row of rows) {
    const preset = getPresetForRow(row)
    if (!preset) {
      console.log(`  Skip: id=${row.id} provider=${row.provider} serviceType=${row.serviceType} (no preset available)`)
      skipped++
      continue
    }

    const settingsJson = JSON.stringify(preset)
    const ts = new Date().toISOString()

    db.update(schema.aiServiceConfigs)
      .set({ settings: settingsJson, updatedAt: ts })
      .where(eq(schema.aiServiceConfigs.id, row.id))
      .run()

    updated++
    updatedRows.push({ id: row.id, provider: row.provider, serviceType: row.serviceType, name: row.name })
    console.log(`  Updated: id=${row.id} provider=${row.provider} serviceType=${row.serviceType} name="${row.name}"`)
  }

  console.log(`\nMigration complete:`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Skipped: ${skipped}`)
  console.log(`  Total processed: ${rows.length}`)

  if (updatedRows.length > 0) {
    console.log(`\nUpdated rows summary:`)
    for (const r of updatedRows) {
      console.log(`  - [${r.serviceType}] ${r.provider} (id=${r.id}): ${r.name}`)
    }
  }
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
}).finally(() => {
  sqlite.close()
})
