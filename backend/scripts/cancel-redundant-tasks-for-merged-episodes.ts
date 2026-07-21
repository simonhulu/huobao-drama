import { db, schema } from '../src/db/index.js'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { listTasks, transitionTask } from '../src/services/tasks/store.js'

const MEDIA_TYPES = [
  'agent.run',
  'image.generate',
  'video.generate',
  'tts.storyboard',
  'compose.storyboard',
]

const mergedEpisodeIds = db.select({ episodeId: schema.videoMerges.episodeId })
  .from(schema.videoMerges)
  .where(and(eq(schema.videoMerges.status, 'completed'), isNull(schema.videoMerges.deletedAt)))
  .all()
  .map(r => r.episodeId)
  .filter((id, idx, arr) => arr.indexOf(id) === idx)

console.log(`Episodes with completed merge: ${mergedEpisodeIds.join(', ')}`)

let canceled = 0
for (const task of listTasks({ status: 'queued' })) {
  if (!MEDIA_TYPES.includes(task.type)) continue
  if (!task.episodeId || !mergedEpisodeIds.includes(task.episodeId)) continue
  transitionTask(task.id, 'succeeded', {
    progressMessage: 'Canceled redundant recovery task: episode already has a completed merge video.',
    result: { recovered: true, reason: 'episode already merged' },
  })
  canceled++
}

console.log(`Canceled ${canceled} queued redundant tasks.`)
