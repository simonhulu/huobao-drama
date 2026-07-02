/**
 * 把 storyboard / episode 数据组装成 StoryboardComposition
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import type { AudioLayer, MotionPlan, StoryboardComposition, VideoLayer } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../../data')

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

export function resolveMediaPath(relativeOrAbsolute: string): string {
  return toAbsPath(relativeOrAbsolute)
}

export interface BuildStoryboardCompositionOptions {
  outputDir: string
  width: number
  height: number
  duration: number
  baseImagePath?: string | null
  baseVideoPath?: string | null
  motion?: MotionPlan
  audioLayers: AudioLayer[]
}

export function buildStoryboardComposition(
  options: BuildStoryboardCompositionOptions,
): StoryboardComposition {
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(options.outputDir, outputFilename)

  let video: VideoLayer
  if (options.baseVideoPath) {
    video = {
      filePath: toAbsPath(options.baseVideoPath),
      type: 'video',
      width: options.width,
      height: options.height,
      duration: options.duration,
      motion: options.motion,
      overlays: [],
    }
  } else if (options.baseImagePath) {
    video = {
      filePath: toAbsPath(options.baseImagePath),
      type: 'image',
      width: options.width,
      height: options.height,
      duration: options.duration,
      motion: options.motion,
      overlays: [],
    }
  } else {
    throw new Error('buildStoryboardComposition requires baseImagePath or baseVideoPath')
  }

  return {
    outputPath,
    video,
    audio: options.audioLayers.map((layer) => ({
      ...layer,
      filePath: toAbsPath(layer.filePath),
    })),
    duration: options.duration,
  }
}
