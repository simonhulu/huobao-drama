/**
 * 深度图视差视频生成（原型）
 *
 * 流程：
 * 1. 调用 Python 脚本生成深度图（ONNX 或 mock）
 * 2. 用 sharp 按深度阈值把图片拆成前景/中景/背景三层
 * 3. 用 FFmpeg 让三层以不同速度平移/缩放，合成 2.5D 视差视频
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import ffmpeg from 'fluent-ffmpeg'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { getVideoEncoderOptions } from './composition/video-encoder.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const PYTHON_SCRIPT = path.resolve(REPO_ROOT, 'backend/scripts/depth_parallax.py')
const DEPTH_PYTHON = process.env.DEPTH_PARALLAX_PYTHON || 'python3'

export interface ParallaxOptions {
  /** 输出视频宽度，默认 1920 */
  width?: number
  /** 输出视频高度，默认 1080 */
  height?: number
  /** 视频时长（秒），默认 5 */
  duration?: number
  /** 运动幅度（像素），默认 60 */
  motionRange?: number
  /** 是否强制使用 mock 深度图 */
  mock?: boolean
}

export interface ParallaxResult {
  outputPath: string
  mode: 'onnx' | 'mock'
  elapsedSeconds: number
}

function runPythonDepth(inputImage: string, outputDepth: string, mock?: boolean): Promise<{ mode: 'onnx' | 'mock'; elapsedSeconds: number }> {
  return new Promise((resolve, reject) => {
    const args = [PYTHON_SCRIPT, inputImage, outputDepth]
    if (mock) args.push('--mock')

    const proc = spawn(DEPTH_PYTHON, args, { cwd: REPO_ROOT })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => { stdout += data.toString() })
    proc.stderr.on('data', (data) => { stderr += data.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`depth_parallax.py failed: ${stderr || stdout}`))
        return
      }
      try {
        const lastLine = stdout.trim().split('\n').pop() || '{}'
        const result = JSON.parse(lastLine)
        if (result.error) throw new Error(result.error)
        resolve({ mode: result.mode, elapsedSeconds: result.elapsed_seconds })
      } catch (err) {
        reject(new Error(`Failed to parse depth script output: ${stdout}\n${stderr}`))
      }
    })
  })
}

async function createParallaxLayers(
  inputImage: string,
  depthPath: string,
  workDir: string,
  options: Required<ParallaxOptions>,
): Promise<{ background: string; midground: string; foreground: string }> {
  const { width, height } = options

  // 读取深度图（16bit PNG）
  const depthBuffer = await sharp(depthPath).raw().toBuffer({ resolveWithObject: true })
  const { data: depthData, info: depthInfo } = depthBuffer
  const depthPixels = new Uint16Array(depthData.buffer, depthData.byteOffset, depthData.length / 2)

  // 计算深度阈值（按深度分三层：近/中/远）
  const sorted = Array.from(depthPixels).sort((a, b) => a - b)
  const t1 = sorted[Math.floor(sorted.length * 0.35)]
  const t2 = sorted[Math.floor(sorted.length * 0.7)]

  // 为每个像素生成 mask：近景=255，中景=128，远景=0
  const mask = Buffer.alloc(depthPixels.length)
  for (let i = 0; i < depthPixels.length; i++) {
    const d = depthPixels[i]
    if (d <= t1) mask[i] = 255
    else if (d <= t2) mask[i] = 128
    else mask[i] = 0
  }

  // 把 mask resize 到目标输出尺寸
  const maskResized = await sharp(mask, {
    raw: { width: depthInfo.width, height: depthInfo.height, channels: 1 },
  })
    .resize(width, height, { fit: 'cover' })
    .raw()
    .toBuffer()

  // 生成三层：
  // - 背景：完整原图，轻微高斯模糊（模拟景深）
  // - 中景：完整原图
  // - 前景：仅保留近景 mask 区域，带 alpha 透明
  const base = sharp(inputImage).resize(width, height, { fit: 'cover' })

  const background = path.join(workDir, 'layer_bg.png')
  const midground = path.join(workDir, 'layer_mid.png')
  const foreground = path.join(workDir, 'layer_fg.png')

  await Promise.all([
    // 背景层：原图 + 轻微模糊
    base.clone().blur(1.5).toFile(background),
    // 中景层：原图
    base.clone().toFile(midground),
    // 前景层：原图 + alpha mask（仅保留近景）
    base
      .clone()
      .joinChannel(maskResized, { raw: { width, height, channels: 1 } })
      .toFile(foreground),
  ])

  return { background, midground, foreground }
}

function renderParallaxVideo(
  layers: { background: string; midground: string; foreground: string },
  outputPath: string,
  options: Required<ParallaxOptions>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { width, height, duration, motionRange } = options
    const fps = 24
    const totalFrames = Math.round(duration * fps)

    // 三层运动幅度：前景最大，中景中等，背景最小
    // 前景和背景向相反方向移动，模拟摄像机横向平移（dolly）时的透视效果
    const fgRange = motionRange
    const midRange = Math.round(motionRange * 0.45)
    const bgRange = Math.round(motionRange * 0.18)

    // 为了避免运动时露出边缘，每层先放大；运动幅度越大，需要放大越多
    const scale = 1.0 + Math.max(0.12, motionRange / Math.min(width, height))
    const scaledW = Math.round(width * scale)
    const scaledH = Math.round(height * scale)

    const buildMotion = (range: number, direction: 1 | -1) => {
      // direction: 1 表示向右移动，-1 表示向左移动
      const signedRange = range * direction
      const xExpr = `'(${scaledW}-${width})/2 + ${signedRange / 2} - ${signedRange}*t/${duration}'`
      const yExpr = `'(${scaledH}-${height})/2 + ${range * 0.15}*sin(2*PI*t/${duration})'`
      return { xExpr, yExpr }
    }

    // 模拟摄像机从左向右移动：前景相对向左（-1），背景相对向右（+1）
    const bgMotion = buildMotion(bgRange, 1)
    const midMotion = buildMotion(midRange, 1)
    const fgMotion = buildMotion(fgRange, -1)

    const cmd = ffmpeg()
      .input(layers.background).inputOptions(['-loop', '1', '-framerate', `${fps}`])
      .input(layers.midground).inputOptions(['-loop', '1', '-framerate', `${fps}`])
      .input(layers.foreground).inputOptions(['-loop', '1', '-framerate', `${fps}`])
      .complexFilter(
        [
          // 背景层：放大 + 缓慢平移
          {
            filter: 'scale',
            options: `${scaledW}:${scaledH}`,
            inputs: '0:v',
            outputs: 'bg_scaled',
          },
          {
            filter: 'crop',
            options: `${width}:${height}:${bgMotion.xExpr}:${bgMotion.yExpr}`,
            inputs: 'bg_scaled',
            outputs: 'bg',
          },
          // 中景层：放大 + 中等平移
          {
            filter: 'scale',
            options: `${scaledW}:${scaledH}`,
            inputs: '1:v',
            outputs: 'mid_scaled',
          },
          {
            filter: 'crop',
            options: `${width}:${height}:${midMotion.xExpr}:${midMotion.yExpr}`,
            inputs: 'mid_scaled',
            outputs: 'mid',
          },
          // 前景层：放大 + 快速平移 + 轻微缩放呼吸
          {
            filter: 'scale',
            options: `${scaledW}:${scaledH}`,
            inputs: '2:v',
            outputs: 'fg_scaled',
          },
          {
            filter: 'crop',
            options: `${width}:${height}:${fgMotion.xExpr}:${fgMotion.yExpr}`,
            inputs: 'fg_scaled',
            outputs: 'fg',
          },
          // 叠加：背景 -> 中景 -> 前景
          {
            filter: 'overlay',
            options: '0:0',
            inputs: ['bg', 'mid'],
            outputs: 'bg_mid',
          },
          {
            filter: 'overlay',
            options: '0:0:enable=1',
            inputs: ['bg_mid', 'fg'],
            outputs: 'out',
          },
        ],
        'out',
      )
      .outputOptions([
        '-r', `${fps}`,
        '-t', `${duration}`,
        ...getVideoEncoderOptions(),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('start', (cmdLine) => { console.log('[Parallax] FFmpeg:', cmdLine) })
      .on('error', (err) => reject(err))
      .on('end', () => resolve())
      .run()
  })
}

export async function generateParallaxVideo(
  inputImage: string,
  outputPath?: string,
  options: ParallaxOptions = {},
): Promise<ParallaxResult> {
  const opts: Required<ParallaxOptions> = {
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    duration: options.duration ?? 5,
    motionRange: options.motionRange ?? 60,
    mock: options.mock ?? false,
  }

  const workDir = path.join(REPO_ROOT, 'data', 'temp', `parallax-${uuid()}`)
  fs.mkdirSync(workDir, { recursive: true })

  try {
    const depthPath = path.join(workDir, 'depth.png')
    const { mode, elapsedSeconds } = await runPythonDepth(inputImage, depthPath, opts.mock)

    const layers = await createParallaxLayers(inputImage, depthPath, workDir, opts)

    const finalOutput = outputPath || path.join(REPO_ROOT, 'data', 'temp', `parallax-${uuid()}.mp4`)
    fs.mkdirSync(path.dirname(finalOutput), { recursive: true })

    await renderParallaxVideo(layers, finalOutput, opts)

    return { outputPath: finalOutput, mode, elapsedSeconds }
  } finally {
    // 原型阶段保留 workDir 便于调试；生产环境可以清理
    // fs.rmSync(workDir, { recursive: true, force: true })
  }
}
