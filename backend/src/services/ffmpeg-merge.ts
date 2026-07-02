/**
 * FFmpeg 多镜头拼接 — 将所有合成后的镜头视频拼接为一集
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { mixEpisode } from './composition/episode-mixer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

/**
 * 拼接一集的所有合成镜头视频
 */
export async function mergeEpisodeVideos(episodeId: number, dramaId: number): Promise<number> {
  const mergeId = enqueueEpisodeMerge(episodeId, dramaId)
  executeEpisodeMerge(mergeId).catch(err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
  })
  return mergeId
}

export interface ExecuteEpisodeMergeResult {
  merge_id: number
  merged_url: string | null
  duration: number | null
}

/**
 * 为一集创建 merge 记录并返回 mergeId
 */
export function enqueueEpisodeMerge(episodeId: number, dramaId: number): number {
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const videos = storyboards
    .map(sb => sb.composedVideoUrl)
    .filter(Boolean) as string[]

  if (videos.length === 0) throw new Error('No videos to merge')

  logTaskStart('MergeTask', 'episode-merge-enqueue', { episodeId, dramaId, clips: videos.length })

  const ts = now()
  const res = db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    createdAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

/**
 * 执行已存在的 merge 记录
 */
export async function executeEpisodeMerge(mergeId: number): Promise<ExecuteEpisodeMergeResult> {
  const [merge] = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).all()
  if (!merge) throw new Error(`Merge ${mergeId} not found`)
  if (!merge.episodeId) throw new Error(`Merge ${mergeId} has no episode_id`)

  const episodeId = merge.episodeId
  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const missing = storyboards.filter(sb => !sb.composedVideoUrl)
  if (missing.length > 0) {
    const ids = missing.map(sb => sb.id).join(',')
    const errorMsg = `Cannot merge: missing composed_video_url for storyboard(s): ${ids}`
    db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg })
      .where(eq(schema.videoMerges.id, mergeId)).run()
    throw new Error(errorMsg)
  }

  const videos = storyboards
    .map(sb => sb.composedVideoUrl)
    .filter(Boolean) as string[]

  if (videos.length === 0) {
    const errorMsg = 'No videos to merge'
    db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg })
      .where(eq(schema.videoMerges.id, mergeId)).run()
    throw new Error(errorMsg)
  }

  logTaskStart('MergeTask', 'episode-merge', { mergeId, episodeId, clips: videos.length })

  try {
    await doMerge(mergeId, episodeId, videos)
  } catch (err: any) {
    db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId)).run()
    throw err
  }

  const [updated] = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).all()
  return {
    merge_id: mergeId,
    merged_url: updated?.mergedUrl || null,
    duration: updated?.duration || null,
  }
}

async function doMerge(mergeId: number, episodeId: number, _videos: string[]) {
  // 输出文件
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  // 使用 episode mixer 完成拼接 + J-Cut/L-Cut 旁白重叠
  const { duration } = await mixEpisode(episodeId, outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 更新 merge 记录
  db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId)).run()

  // 更新 episode
  db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId)).run()

  logTaskSuccess('MergeTask', 'episode-merge', { mergeId, episodeId, output: mergedRelative, duration })
}

