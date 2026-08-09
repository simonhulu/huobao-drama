export const DHARMA_VIDEO_ENCODER = 'h264_videotoolbox'
export const DHARMA_VIDEO_BITRATE = '3M'
export const DHARMA_VIDEO_MAXRATE = '3600k'
export const DHARMA_VIDEO_BUFSIZE = '6M'
export const DHARMA_VIDEO_GOP = 300
export const DHARMA_VIDEO_KEYINT_MIN = 30
export const DHARMA_FILTER_THREADS = 2

function positiveDuration(value) {
  const duration = Number(value)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`FFmpeg input duration must be positive: ${value}`)
  }
  return duration
}

export function appendLoopedImageInput(args, path, durationSec, fps = 30) {
  const duration = positiveDuration(durationSec)
  if (!Number.isFinite(Number(fps)) || Number(fps) <= 0) {
    throw new Error(`FFmpeg input frame rate must be positive: ${fps}`)
  }
  args.push(
    '-loop', '1',
    '-framerate', String(fps),
    '-t', duration.toFixed(6),
    '-i', path,
  )
  return args
}

export function appendFilterThreadOptions(args) {
  args.push(
    '-filter_threads', String(DHARMA_FILTER_THREADS),
    '-filter_complex_threads', String(DHARMA_FILTER_THREADS),
  )
  return args
}

// VideoToolbox uses bitrate-based rate control. `allow_sw=0` makes a missing
// or unavailable VideoToolbox device fail instead of silently using libx264.
export function appendVideoToolboxEncoderOptions(args) {
  args.push(
    '-c:v', DHARMA_VIDEO_ENCODER,
    '-allow_sw', '0',
    '-b:v', DHARMA_VIDEO_BITRATE,
    '-maxrate', DHARMA_VIDEO_MAXRATE,
    '-bufsize', DHARMA_VIDEO_BUFSIZE,
    '-pix_fmt', 'yuv420p',
    '-g', String(DHARMA_VIDEO_GOP),
    '-keyint_min', String(DHARMA_VIDEO_KEYINT_MIN),
    '-bf', '0',
  )
  return args
}
