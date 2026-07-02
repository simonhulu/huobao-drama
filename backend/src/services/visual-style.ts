/**
 * 视觉风格 → Prompt 文本注入
 *
 * GPT Image 2 / DALL-E / 多数文生图 API 没有独立的 style 参数，
 * 风格必须通过 prompt 中的自然语言描述来传递。本模块把 dramas.style
 * 存储的简短风格标记（realistic/anime/ghibli/...）展开成模型易理解的
 * 英文风格短语，并统一 prepend 到生成 prompt 中。
 */

export const STYLE_DESCRIPTIONS: Record<string, string> = {
  // 通用 / 基础风格
  generic: 'cinematic film still, highly detailed, refined visual, dramatic lighting, movie composition',
  realistic: 'photorealistic, realistic lighting and textures, highly detailed',
  anime: 'anime style, crisp linework, vibrant colors',
  ghibli: 'Studio Ghibli style, soft painterly animation, warm colors',
  cinematic: 'cinematic film still, dramatic lighting, movie composition, highly detailed',
  comic: 'comic book style, bold lines, dynamic composition',
  watercolor: 'watercolor painting, soft washes, painterly texture',
  // 高级主题风格，适合 YouTube 长视频 / 纪录片式视觉
  historical: 'historical epic, cinematic period drama, painterly realism, grand composition, museum quality',
  scifi: 'sci-fi cinematic, sleek futuristic design, neon accents, high detail, atmospheric',
  mythology: 'mythological fantasy, ethereal lighting, epic scale, ornate details, divine atmosphere',
  space: 'space cinematic, cosmic scale, deep shadows, glowing nebulae, photorealistic astronomy',
  deepsea: 'deep sea bioluminescent, dark atmospheric, cinematic underwater, mysterious glow',
  ancient: 'ancient civilization, monumental architecture, golden hour cinematic, archaeological grandeur',
  wasteland: 'post-apocalyptic wasteland, dusty atmospheric, cinematic desolation, muted earth tones',
}

/**
 * 题材 → 推荐视觉风格
 *
 * 注意：题材（genre）和视觉风格（style）是两个独立字段。
 * 题材只用于内容分类和推荐默认风格；真正注入图片 prompt 的是 style。
 */
export const GENRE_STYLE_RECOMMENDATIONS: Record<string, string> = {
  generic: 'generic',
  history: 'realistic',
  scifi: 'cinematic',
  mythology: 'cinematic',
  space: 'cinematic',
  deepsea: 'cinematic',
  ancient: 'realistic',
  wasteland: 'cinematic',
}

export function recommendedStyleForGenre(genre: string | null | undefined): string {
  if (!genre) return 'generic'
  return GENRE_STYLE_RECOMMENDATIONS[genre.trim().toLowerCase()] || 'generic'
}

/**
 * 把风格标记转成可用于 prompt 的英文短语。
 * 未知风格直接回退为 "{style} style"，保证任何自定义值都能生效。
 */
export function styleToPromptPhrase(style: string | null | undefined): string {
  if (!style) return ''
  const normalized = style.trim().toLowerCase()
  if (!normalized) return ''
  return STYLE_DESCRIPTIONS[normalized] || `${normalized} style`
}

/**
 * 将视觉风格 prepend 到 prompt 最前面。
 * 如果 prompt 已经以该风格短语开头，则不重复添加。
 */
export function applyVisualStyle(
  prompt: string | null | undefined,
  style: string | null | undefined,
): string {
  const phrase = styleToPromptPhrase(style)
  const base = (prompt || '').trim()
  if (!phrase) return base
  if (!base) return phrase
  if (base.toLowerCase().startsWith(phrase.toLowerCase())) return base
  return `${phrase}。${base}`
}
