import { stripVideoTags } from './adapters/prompt-utils.js'

function parseAspectRatio(aspectRatio?: string | null) {
  if (!aspectRatio) return null
  const [wStr, hStr] = aspectRatio.split(':').map((item) => item.trim())
  const w = Number(wStr)
  const h = Number(hStr)
  if (!w || !h || w <= 0 || h <= 0) return null
  return { w, h }
}

function stripExplicitAspectWords(prompt: string): string {
  let next = prompt.trim()
  for (let i = 0; i < 4; i++) {
    const previous = next
    next = next
      .replace(/^\s*(横屏|横版|宽屏|宽幅|宽银幕)\s*(16\s*[:：]\s*9)?\s*(电影宽幅构图|电影化宽幅构图|构图)?[，,。；;\s]*/iu, '')
      .replace(/^\s*(竖屏|竖版|竖构图|手机竖屏)\s*(9\s*[:：]\s*16)?\s*(手机短视频构图|短视频构图|构图)?[，,。；;\s]*/iu, '')
      .replace(/^\s*(16\s*[:：]\s*9|9\s*[:：]\s*16)[，,。；;\s]*/u, '')
      .replace(/^\s*\b(widescreen|landscape|portrait)\b[，,。；;\s]*/iu, '')
      .trim()
    if (next === previous) break
  }
  return next
}

export function normalizeStoryboardImagePromptForAspectRatio(
  prompt: string | null | undefined,
  aspectRatio?: string | null,
): string {
  const cleaned = stripVideoTags(prompt || '').trim()
  if (!cleaned) return cleaned

  const ratio = parseAspectRatio(aspectRatio)
  if (!ratio) return cleaned

  const body = stripExplicitAspectWords(cleaned)
    .replace(/[。！？!?]+[，,]/gu, '，')
    .replace(/[，,。；;\s]+$/u, '')
  if (!body) return cleaned

  if (ratio.h > ratio.w) {
    const prefix = '竖屏9:16手机短视频构图'
    const suffix = body.includes('手机全屏') || body.includes('竖屏')
      ? ''
      : '，主体上下层次清楚，适合手机全屏观看'
    return `${prefix}，${body}${suffix}`
  }

  if (ratio.w > ratio.h) {
    const prefix = '横屏16:9电影宽幅构图'
    return `${prefix}，${body}`
  }

  return body
}
