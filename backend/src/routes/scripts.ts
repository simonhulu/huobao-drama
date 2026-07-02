import { Hono } from 'hono'
import { badRequest, success } from '../utils/response.js'
import { cleanDirectScript, type HookStyle, type RetentionMode } from '../services/direct-script-cleaner.js'
import { optimizeScriptForRetention } from '../services/retention-script-optimizer.js'

const app = new Hono()
type CleanMode = 'faithful' | 'retention'

function parseRetentionMode(value: unknown): RetentionMode {
  return value === 'tight' ? 'tight' : 'standard'
}

function parseCleanMode(value: unknown, retentionMode: RetentionMode): CleanMode {
  if (value === 'retention' || retentionMode === 'tight') return 'retention'
  return 'faithful'
}

function parseHookStyle(value: unknown): HookStyle {
  if (value === 'suspense' || value === 'conflict' || value === 'data') return value
  return 'auto'
}

// POST /scripts/clean - 预览/获取清理后的解说稿（不写入数据库）
app.post('/clean', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, any>))
  const content = String(body.content || '').trim()
  if (!content) return badRequest(c, 'content is required')

  try {
    const requestedRetentionMode = parseRetentionMode(body.retention_mode)
    const cleanMode = parseCleanMode(body.clean_mode, requestedRetentionMode)
    const retentionMode: RetentionMode = cleanMode === 'retention' ? 'tight' : 'standard'
    const hookStyle = parseHookStyle(body.hook_style)

    const cleaned = await cleanDirectScript(content, { retentionMode: 'standard', hookStyle })
    if (cleanMode === 'retention') {
      const optimized = await optimizeScriptForRetention(cleaned, {
        retentionMode,
        hookStyle,
      })
      return success(c, {
        original_length: content.length,
        cleaned_length: cleaned.length,
        production_length: optimized.productionScript.length,
        clean_mode: cleanMode,
        retention_mode: retentionMode,
        hook_style: hookStyle,
        clean_script: optimized.cleanScript,
        production_script: optimized.productionScript,
        content: optimized.productionScript,
        opening_hook: optimized.openingHook || null,
        cliffhanger: optimized.cliffhanger || null,
        retention_beats: optimized.retentionBeats || null,
        changes: optimized.changes,
      })
    }

    return success(c, {
      original_length: content.length,
      cleaned_length: cleaned.length,
      production_length: cleaned.length,
      clean_mode: cleanMode,
      retention_mode: retentionMode,
      hook_style: hookStyle,
      clean_script: cleaned,
      production_script: cleaned,
      content: cleaned,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '清理解说稿失败'
    return c.json({ code: 500, message }, 500)
  }
})

export default app
