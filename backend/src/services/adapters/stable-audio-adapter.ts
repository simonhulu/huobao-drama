/**
 * Stable Audio 3 MLX 本地生成适配器
 *
 * 调用 backend/third-party/stable-audio-3/optimized/mlx 里的官方 CLI，
 * 为缺失的 BGM / SFX / ambience 生成素材并缓存。
 *
 * 环境要求：Apple Silicon（MLX），官方权重已下载。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '../../../..')
const SA3_MLX_DIR = path.join(
  PROJECT_ROOT,
  'backend',
  'third-party',
  'stable-audio-3',
  'optimized',
  'mlx',
)
const SA3_SCRIPT = path.join(SA3_MLX_DIR, 'sa3')

export type Sa3AudioType = 'sfx' | 'music'

export interface Sa3GenerateOptions {
  type: Sa3AudioType
  prompt: string
  durationSec: number
  outputPath: string
  seed?: number
  cfg?: number
  negativePrompt?: string
}

function ensureDir(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
}

function sa3Args(opts: Sa3GenerateOptions): string[] {
  const dit = opts.type === 'sfx' ? 'sm-sfx' : 'sm-music'
  const args: string[] = [
    '--prompt', opts.prompt,
    '--dit', dit,
    '--decoder', 'same-s',
    '--seconds', String(Math.min(120, Math.max(1, Math.round(opts.durationSec)))),
    '--out', opts.outputPath,
  ]
  if (opts.seed !== undefined) args.push('--seed', String(opts.seed))
  if (opts.cfg !== undefined) args.push('--cfg', String(opts.cfg))
  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt)
  return args
}

export function sa3CacheKey(prompt: string, durationSec: number, type: Sa3AudioType): string {
  const hash = crypto.createHash('sha256').update(`${type}:${durationSec}:${prompt}`).digest('hex')
  return hash.slice(0, 16)
}

export function sa3DefaultOutputPath(
  type: Sa3AudioType,
  prompt: string,
  durationSec: number,
  category?: string,
): string {
  const hash = sa3CacheKey(prompt, durationSec, type)
  const subdir = type === 'sfx' ? 'sfx/library/sa3-generated' : 'static/music'
  const prefix = category ? `${category}_` : ''
  const name = `${prefix}sa3_${type}_${hash}.wav`
  return path.join(PROJECT_ROOT, 'data', subdir, name)
}

function relFromProjectRoot(absPath: string): string {
  const rel = path.relative(PROJECT_ROOT, absPath)
  return rel
}

/**
 * 运行 SA3 CLI 生成音频。若 outputPath 已存在且非空则直接复用。
 * 返回生成的绝对路径。
 */
export async function generateSa3Audio(opts: Sa3GenerateOptions): Promise<string> {
  const outputPath = path.resolve(opts.outputPath)
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return outputPath
  }
  ensureDir(outputPath)

  return new Promise((resolve, reject) => {
    const args = sa3Args({ ...opts, outputPath })
    const env = {
      ...process.env,
      HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7897',
      HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7897',
      HF_HOME: process.env.HF_HOME || path.join(process.env.HOME || PROJECT_ROOT, '.cache/huggingface'),
    }
    const child = spawn(SA3_SCRIPT, args, {
      cwd: SA3_MLX_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`SA3 exited ${code}: ${stderr || stdout}`))
        return
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        reject(new Error(`SA3 did not write output: ${outputPath}`))
        return
      }
      resolve(outputPath)
    })
  })
}

async function encodeToMp3(
  absWav: string,
  absMp3: string,
  lufs: number,
  bitrate: string,
): Promise<void> {
  ensureDir(absMp3)
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-y', '-v', 'error',
        '-i', absWav,
        '-af', `loudnorm=I=${lufs}:TP=-1.5:LRA=11`,
        '-c:a', 'libmp3lame',
        '-b:a', bitrate,
        absMp3,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg loudnorm failed: ${err}`))
      else resolve()
    })
  })
}

/**
 * 便捷函数：生成 SFX/ambience bed，自动转码为 MP3 并 loudnorm 到 -24 LUFS。
 * 可指定 outputPath（相对或绝对），否则按缓存键生成。
 * 返回相对 repo 根的路径（如 data/sfx/library/sa3-generated/...mp3）。
 */
export async function generateSa3Sfx(
  prompt: string,
  durationSec: number,
  category?: string,
  outputPath?: string,
): Promise<string> {
  const absMp3 = outputPath ? path.resolve(outputPath) : sa3DefaultOutputPath('sfx', prompt, durationSec, category).replace(/\.wav$/, '.mp3')
  const absWav = absMp3.replace(/\.mp3$/, '.wav')

  await generateSa3Audio({ type: 'sfx', prompt, durationSec, outputPath: absWav })
  await encodeToMp3(absWav, absMp3, -24, '128k')

  try { fs.unlinkSync(absWav) } catch {}
  return relFromProjectRoot(absMp3)
}

/**
 * 便捷函数：生成 BGM，自动转码为 MP3 并 loudnorm 到 -14 LUFS。
 * 可指定 outputPath，否则按缓存键生成。
 * 返回相对 repo 根的路径（如 static/music/...mp3）。
 */
export async function generateSa3Music(
  prompt: string,
  durationSec: number,
  category?: string,
  outputPath?: string,
): Promise<string> {
  const absMp3 = outputPath ? path.resolve(outputPath) : sa3DefaultOutputPath('music', prompt, durationSec, category).replace(/\.wav$/, '.mp3')
  const absWav = absMp3.replace(/\.mp3$/, '.wav')

  await generateSa3Audio({ type: 'music', prompt, durationSec, outputPath: absWav })
  await encodeToMp3(absWav, absMp3, -14, '192k')

  try { fs.unlinkSync(absWav) } catch {}
  return relFromProjectRoot(absMp3)
}

