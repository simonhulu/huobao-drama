/**
 * 画幅(宽高比)工具：整集锁定一种画幅，贯穿图片生成→视频生成→合成。
 * 支持横屏 16:9 与竖屏 9:16；其它值回退到 16:9。
 */
export type AspectRatio = '16:9' | '9:16'

export function normalizeAspect(ratio?: string | null): AspectRatio {
  return ratio === '9:16' ? '9:16' : '16:9'
}

/** 图片生成用的 size 字符串(WxH)。横屏 1920x1080 / 竖屏 1080x1920 */
export function ratioToSize(ratio?: string | null): string {
  return normalizeAspect(ratio) === '9:16' ? '1080x1920' : '1920x1080'
}

/** 合成/ffmpeg 用的像素宽高。横屏 1920x1080 / 竖屏 1080x1920 */
export function ratioToDimensions(ratio?: string | null): { width: number; height: number } {
  return normalizeAspect(ratio) === '9:16'
    ? { width: 1080, height: 1920 }
    : { width: 1920, height: 1080 }
}
