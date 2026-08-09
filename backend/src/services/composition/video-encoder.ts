import os from 'os'

interface VideoDimensions {
  width: number
  height: number
}

function readBitrateEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseBitrateKbps(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function estimateBitrateKbps({ width, height }: VideoDimensions): number {
  // 按像素数估算合理码率，避免 14 分钟成片到 400MB。
  // 图文叙事以静态图 + Ken Burns 为主，画面变化平缓，不需要平台级高码率。
  // 每 100 万像素约 1500 kbps。
  const megapixels = (width * height) / 1_000_000
  return Math.max(800, Math.round(megapixels * 1500))
}

/**
 * 选择当前平台最快的 H.264 编码参数。
 * macOS 优先使用 VideoToolbox 硬件编码；其他平台回退到 libx264 软件编码。
 *
 * 默认按输出分辨率限制平均码率，防止 h264_videotoolbox 的 -q:v 在复杂画面上
 * 码率失控导致成片体积过大（如 14 分钟 400MB）。
 *
 * 可通过环境变量覆盖：
 *   VIDEO_BITRATE_KBPS  - 平均码率（kbps）
 *   VIDEO_MAX_BITRATE_KBPS - 最大码率（kbps），默认 1.5 倍平均码率
 *   VIDEO_QUALITY       - VideoToolbox 的 -q:v（0-100，越小质量越好）
 *   VIDEO_CRF           - libx264 的 CRF（默认 23）
 */
export function getVideoEncoderOptions(dimensions?: VideoDimensions): string[] {
  const bitrateKbps = parseBitrateKbps(process.env.VIDEO_BITRATE_KBPS)
    ?? (dimensions ? estimateBitrateKbps(dimensions) : 2500)
  const maxBitrateKbps = parseBitrateKbps(process.env.VIDEO_MAX_BITRATE_KBPS)
    ?? Math.round(bitrateKbps * 1.5)
  const bufsizeKbps = Math.round(bitrateKbps * 2)

  if (os.platform() === 'darwin') {
    const quality = process.env.VIDEO_QUALITY ?? '65'
    return [
      '-c:v', 'h264_videotoolbox',
      '-b:v', `${bitrateKbps}k`,
      '-maxrate', `${maxBitrateKbps}k`,
      '-bufsize', `${bufsizeKbps}k`,
      '-q:v', quality,
    ]
  }

  const crf = process.env.VIDEO_CRF ?? '23'
  return [
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', crf,
    '-maxrate', `${maxBitrateKbps}k`,
    '-bufsize', `${bufsizeKbps}k`,
  ]
}

export function getVideoEncoderName(): string {
  return os.platform() === 'darwin' ? 'h264_videotoolbox' : 'libx264'
}

/**
 * 解码加速参数：macOS 用 VideoToolbox 硬解（-hwaccel videotoolbox），其他平台不启用。
 * 仅用于输入是视频文件的 ffmpeg 调用（图片/lavfi 输入不要加）。
 */
export function getVideoDecodeOptions(): string[] {
  return os.platform() === 'darwin' ? ['-hwaccel', 'videotoolbox'] : []
}
