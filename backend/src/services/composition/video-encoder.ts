import os from 'os'

/**
 * 选择当前平台最快的 H.264 编码参数。
 * macOS 优先使用 VideoToolbox 硬件编码；其他平台回退到 libx264 软件编码。
 */
export function getVideoEncoderOptions(): string[] {
  if (os.platform() === 'darwin') {
    return ['-c:v', 'h264_videotoolbox', '-q:v', '50']
  }
  return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']
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
