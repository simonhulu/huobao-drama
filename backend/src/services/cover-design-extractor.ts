import { normalizeCoverDesign, type CoverDesign } from './cover-image-composer.js'

export interface CoverDesignExtractionContext {
  episodeTitle?: string
  episodeNumber?: number
  fallbackPrompt?: string
}

type JsonObject = Record<string, unknown>

const FIELD_ALIASES: Record<keyof CoverDesign, string[]> = {
  type: ['type', '类型', '方案类型'],
  recommended_aspect_ratio: ['recommended_aspect_ratio', 'recommendedAspectRatio', '建议画幅比', '画幅比'],
  description: ['description', '画面描述'],
  main_title: ['main_title', 'mainTitle', '主标题', '主标题文案'],
  sub_title: ['sub_title', 'subTitle', '副标题', '副标题文案'],
  kicker: ['kicker', 'label', '栏目标签', '小字标签'],
  episode_label: ['episode_label', 'episodeLabel', '集数标签'],
  brand_label: ['brand_label', 'brandLabel', '品牌标签'],
  accent_color: ['accent_color', 'accentColor', '强调色', '点缀色'],
  color_and_font: ['color_and_font', 'colorAndFont', '色调/字体', '色调与字体'],
  ai_prompt: ['ai_prompt', 'aiPrompt', 'image_prompt', 'imagePrompt', 'AI图片生成提示词', 'AI图片提示词'],
  rationale: ['rationale', '为什么有效', '设计理由'],
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/<br\s*\/?>(?=\S)/gi, ' ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function fieldValue(source: JsonObject, field: keyof CoverDesign): string {
  for (const key of FIELD_ALIASES[field]) {
    const value = clean(source[key])
    if (value) return value
  }
  return ''
}

function hasDesignFields(value: JsonObject): boolean {
  return Object.keys(FIELD_ALIASES).some(field => FIELD_ALIASES[field as keyof CoverDesign]
    .some(key => key in value && clean(value[key])))
}

function selectThumbnailDesign(source: JsonObject): JsonObject | null {
  const designs = Array.isArray(source.thumbnail_designs)
    ? source.thumbnail_designs.filter(isObject)
    : []
  if (!designs.length) return null

  const recommendation = source.recommended_thumbnail
  if (isObject(recommendation)) return recommendation

  if (typeof recommendation === 'number' && designs[recommendation]) {
    return designs[recommendation]!
  }

  const reference = clean(recommendation).toLowerCase()
  if (reference) {
    const letter = reference.match(/封面\s*([ab])|\bconcept\s*([ab])\b/i)?.[1]
      || reference.match(/\b([ab])\b/i)?.[1]
    if (letter) return designs[letter.toLowerCase() === 'b' ? 1 : 0] || designs[0]!

    const byType = designs.find(design => {
      const type = fieldValue(design, 'type').toLowerCase()
      const title = fieldValue(design, 'main_title').toLowerCase()
      return (type && (reference.includes(type) || type.includes(reference)))
        || (title && (reference.includes(title) || title.includes(reference)))
    })
    if (byType) return byType
    if (reference.includes('悬念')) {
      const suspense = designs.find(design => fieldValue(design, 'type').includes('悬念'))
      if (suspense) return suspense
    }
  }

  return designs[0]!
}

function normalizeExtractedDesign(value: JsonObject, context: CoverDesignExtractionContext): CoverDesign | null {
  const nested = value.cover_design
  if (isObject(nested)) return normalizeExtractedDesign(nested, context)
  if (typeof nested === 'string') {
    const nestedDesign = extractCoverDesign(nested, context)
    if (nestedDesign) return nestedDesign
  }

  const selected = selectThumbnailDesign(value)
  if (selected) return normalizeExtractedDesign(selected, context)
  if (!hasDesignFields(value)) return null

  const type = fieldValue(value, 'type')
  const design: CoverDesign = {
    type: type || undefined,
    recommended_aspect_ratio: fieldValue(value, 'recommended_aspect_ratio') || undefined,
    description: fieldValue(value, 'description') || undefined,
    main_title: fieldValue(value, 'main_title') || undefined,
    sub_title: fieldValue(value, 'sub_title') || undefined,
    kicker: fieldValue(value, 'kicker') || undefined,
    episode_label: fieldValue(value, 'episode_label') || undefined,
    brand_label: '',
    accent_color: fieldValue(value, 'accent_color') || undefined,
    color_and_font: fieldValue(value, 'color_and_font') || undefined,
    ai_prompt: fieldValue(value, 'ai_prompt') || undefined,
    rationale: fieldValue(value, 'rationale') || undefined,
  }

  if (!design.main_title && !design.ai_prompt && !design.description) return null
  return normalizeCoverDesign(
    design,
    context.episodeTitle || '',
    context.episodeNumber,
    context.fallbackPrompt,
  )
}

function parseJsonObjectCandidates(text: string): JsonObject[] {
  const candidates: string[] = []
  const trimmed = text.trim()
  if (trimmed) candidates.push(trimmed)

  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }

  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }

  const objects: JsonObject[] = []
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isObject(parsed)) objects.push(parsed)
    } catch {
      // Markdown and prose around the JSON are expected; try the next candidate.
    }
  }
  return objects
}

function markdownFieldValue(block: string, field: keyof CoverDesign): string {
  const aliases = FIELD_ALIASES[field]
    .filter(alias => !alias.includes('_') && !alias.includes('Prompt'))
    .map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!aliases.length) return ''
  const label = aliases.join('|')
  const match = block.match(new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*|__)?(?:${label})(?:\\*\\*|__)?\\s*[：:]\\s*(.+)$`,
    'im',
  ))
  return clean(match?.[1])
}

function extractMarkdownDesign(text: string, context: CoverDesignExtractionContext): CoverDesign | null {
  const heading = text.match(/(?:^|\n)##\s*(?:八[、.．]\s*)?封面设计方案[^\n]*\n([\s\S]*)/i)
  if (!heading) return null

  const section = heading[1]!.split(/\n##\s+(?!#)/)[0]!
  const headings = [...section.matchAll(/^###\s*封面\s*(?:([A-Za-zＡ-Ｚ])\s*[：:]?\s*)?([^\n]*)/gim)]
  if (!headings.length) return null

  const recommendation = section.match(/^###\s*推荐[^\n]*\n([\s\S]*?)(?=^###\s|$)/im)?.[1] || ''
  const recommendationText = `${recommendation}\n${section.match(/推荐[^\n]*/i)?.[0] || ''}`
  let selectedIndex = 0
  const letter = recommendationText.match(/封面\s*([AB])|\b(?:方案|concept)\s*([AB])\b/i)?.[1]
    || recommendationText.match(/\b([AB])\b/i)?.[1]
  if (letter?.toUpperCase() === 'B') selectedIndex = 1

  const selectedHeading = headings[Math.min(selectedIndex, headings.length - 1)]!
  const start = selectedHeading.index! + selectedHeading[0].length
  const nextHeading = section.slice(start).search(/^###\s/gim)
  const block = section.slice(start, nextHeading >= 0 ? start + nextHeading : undefined)
  const headingType = clean(selectedHeading[2])
  const inferredType = headingType || (selectedHeading[1]?.toUpperCase() === 'B' ? '悬念型' : '冲突型')
  const design: CoverDesign = {
    type: inferredType,
    recommended_aspect_ratio: markdownFieldValue(block, 'recommended_aspect_ratio') || undefined,
    description: markdownFieldValue(block, 'description') || undefined,
    main_title: markdownFieldValue(block, 'main_title') || undefined,
    sub_title: markdownFieldValue(block, 'sub_title') || undefined,
    kicker: markdownFieldValue(block, 'kicker') || undefined,
    accent_color: markdownFieldValue(block, 'accent_color') || undefined,
    color_and_font: markdownFieldValue(block, 'color_and_font') || undefined,
    ai_prompt: markdownFieldValue(block, 'ai_prompt') || undefined,
    rationale: markdownFieldValue(block, 'rationale') || undefined,
    brand_label: '',
  }

  if (!design.main_title && !design.ai_prompt && !design.description) return null
  return normalizeCoverDesign(
    design,
    context.episodeTitle || '',
    context.episodeNumber,
    context.fallbackPrompt,
  )
}

export function extractCoverDesign(
  source: unknown,
  context: CoverDesignExtractionContext = {},
): CoverDesign | null {
  if (isObject(source)) {
    return normalizeExtractedDesign(source, context)
  }
  if (typeof source !== 'string' || !source.trim()) return null

  for (const candidate of parseJsonObjectCandidates(source)) {
    const design = normalizeExtractedDesign(candidate, context)
    if (design) return design
  }
  return extractMarkdownDesign(source, context)
}

export function extractCoverDesignFromText(
  text: string,
  context: CoverDesignExtractionContext = {},
): CoverDesign | null {
  return extractCoverDesign(text, context)
}
