/**
 * 将 aspect_ratio 字符串（如 16:9、9:16）映射为通用 size（如 1920x1080、1080x1920）
 * 未知比例或空值默认返回 1920x1080
 */
export function aspectRatioToSize(aspectRatio?: string | null): string {
  if (!aspectRatio) return '1920x1080'
  const [wStr, hStr] = aspectRatio.split(':').map((s) => s.trim())
  const w = Number(wStr)
  const h = Number(hStr)
  if (!w || !h || w <= 0 || h <= 0) return '1920x1080'

  // 竖屏：宽度取 1080，横屏：宽度取 1920
  const isPortrait = h > w
  const targetWidth = isPortrait ? 1080 : 1920
  const targetHeight = Math.round((targetWidth * h) / w)
  return `${targetWidth}x${targetHeight}`
}
