import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'

const exec = promisify(execFile)

/** Select native video pixels; image generation and artificial upscaling are never used. */
export async function selectVideoCoverFrame(videoPath: string, outputDir: string): Promise<string> {
  let probe: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> }
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', videoPath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 })
    probe = JSON.parse(stdout)
  } catch {
    throw new Error('无法读取封面素材视频，请检查本地视频文件是否存在且可播放')
  }
  const duration = Number(probe.format?.duration)
  const stream = probe.streams?.find(item => item.codec_type === 'video')
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error('素材没有可截取的视频画面')
  if (Math.max(stream.width || 0, stream.height || 0) < 720 || Math.min(stream.width || 0, stream.height || 0) < 400) {
    throw new Error('素材视频分辨率不足，请提供长边至少720像素、短边至少400像素的清晰视频')
  }

  let best: { image: Buffer; score: number } | undefined
  for (const fraction of [.1, .3, .5, .7, .85]) {
    const { stdout: image } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(duration * fraction), '-i', videoPath,
      '-map', '0:v:0', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'],
    { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' })
    if (!image.length) continue
    const { width, height } = await sharp(image).metadata()
    if (!width || !height) continue
    // Exclude borders and typical bottom subtitles when measuring scene detail.
    const region = await sharp(image).extract({ left: Math.floor(width * .05), top: Math.floor(height * .1),
      width: Math.max(1, Math.floor(width * .9)), height: Math.max(1, Math.floor(height * .65)) })
      .resize({ width: Math.min(640, Math.floor(width * .9)), withoutEnlargement: true }).greyscale().png().toBuffer()
    const stats = await sharp(region).stats()
    const channel = stats.channels[0]!
    if (channel.mean < 12 || channel.mean > 243 || channel.stdev < 8 || stats.sharpness < .3) continue
    const exposure = 1 - Math.abs(channel.mean - 128) / 160
    const score = stats.sharpness * Math.sqrt(channel.stdev) * Math.max(.2, exposure)
    if (!best || score > best.score) best = { image, score }
  }
  if (!best) throw new Error('素材视频中没有曝光正常、内容清晰的画面，请更换清晰素材后重试')
  await mkdir(outputDir, { recursive: true })
  const filename = path.join(outputDir, 'cover-frame.png')
  await writeFile(filename, best.image)
  return filename
}
