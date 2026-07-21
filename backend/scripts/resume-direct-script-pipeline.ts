/**
 * 一次性脚本：为 drama 27 中已完成 extractor 但缺少 breaker 的精稿直出集数，
 * 补创建 storyboard_breaker 任务，使其自动继续 image/tts/compose/merge。
 */
import { db, schema } from '../src/db/index.js'
import { eq, and, isNull } from 'drizzle-orm'
import { scheduleDirectScriptPipeline } from '../src/services/tasks/auto-pipeline.js'

const dramaId = 27

const episodes = db.select().from(schema.episodes)
  .where(and(
    eq(schema.episodes.dramaId, dramaId),
    isNull(schema.episodes.deletedAt),
    eq(schema.episodes.workflowType, 'direct_script'),
    eq(schema.episodes.autoMode, true),
  ))
  .all()
  .filter(ep => {
    // 只处理还没有分镜的集
    const sbs = db.select({ id: schema.storyboards.id })
      .from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, ep.id))
      .all()
    return sbs.length === 0
  })

console.log(`Found ${episodes.length} direct_script episodes without storyboards`)

for (const ep of episodes) {
  // 检查是否已经有 breaker 任务
  const existing = db.select().from(schema.creationTasks)
    .where(and(
      eq(schema.creationTasks.episodeId, ep.id),
      eq(schema.creationTasks.type, 'agent.run'),
    ))
    .all()
    .filter(t => {
      const payload = JSON.parse(t.payloadJson || '{}')
      return payload.agent_type === 'storyboard_breaker'
    })

  if (existing.some(t => t.status === 'queued' || t.status === 'running')) {
    console.log(`  SKIP ep ${ep.episodeNumber} (breaker already active)`)
    continue
  }

  const pipeline = scheduleDirectScriptPipeline(dramaId, ep.id)
  console.log(`  CREATED breaker task ${pipeline.breaker.id} for ep ${ep.episodeNumber}`)
}

console.log('Done')
