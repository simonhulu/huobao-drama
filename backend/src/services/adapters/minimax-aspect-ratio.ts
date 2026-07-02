/**
 * 将通用 size（如 1920x1080）映射到 MiniMax 支持的 aspect_ratio
 */
export function sizeToMiniMaxAspectRatio(size?: string | null): string {
  if (!size) return '16:9'

  const [wStr, hStr] = size.split('x')
  const w = Number(wStr)
  const h = Number(hStr)
  if (!w || !h || w <= 0 || h <= 0) return '16:9'

  // 计算宽高比，匹配 MiniMax 支持的比例
  const ratio = w / h

  // 常见比例阈值
  if (Math.abs(ratio - 1) < 0.15) return '1:1' // 1:1
  if (Math.abs(ratio - 16 / 9) < 0.2) return '16:9' // 16:9
  if (Math.abs(ratio - 4 / 3) < 0.15) return '4:3' // 4:3
  if (Math.abs(ratio - 3 / 2) < 0.15) return '3:2' // 3:2
  if (Math.abs(ratio - 2 / 3) < 0.15) return '2:3' // 2:3
  if (Math.abs(ratio - 3 / 4) < 0.15) return '3:4' // 3:4
  if (Math.abs(ratio - 9 / 16) < 0.15) return '9:16' // 9:16
  if (Math.abs(ratio - 21 / 9) < 0.2) return '21:9' // 21:9

  // 默认 16:9
  return '16:9'
}
