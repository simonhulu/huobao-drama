export const DHARMA_EMOTIONS = [
  'curiosity',
  'stillness',
  'tension',
  'acceptance',
  'insight',
  'release',
] as const

export type DharmaEmotion = typeof DHARMA_EMOTIONS[number]

export const DHARMA_IMAGE_MOVES = [
  'push',
  'pull',
  'hold',
  'drift_left',
  'drift_right',
] as const

export type DharmaImageMove = typeof DHARMA_IMAGE_MOVES[number]

export const DHARMA_VISUAL_TREATMENTS = [
  'ink_wash',
  'surreal_dream',
  'minimal_light',
  'legacy_temple',
] as const

export type DharmaVisualTreatment = typeof DHARMA_VISUAL_TREATMENTS[number]

export const DHARMA_EMOTIONAL_INK_STYLE_ID = 'dharma-emotional-ink-v1'
export const DHARMA_SURREAL_DREAM_STYLE_ID = 'dharma-surreal-dream-v1'
export const DHARMA_MINIMAL_LIGHT_STYLE_ID = 'dharma-minimal-light-v1'
export const DEFAULT_DHARMA_IMAGE_STYLE_ID = DHARMA_EMOTIONAL_INK_STYLE_ID

export interface DharmaImageStyle {
  id: string
  name: string
  description: string
  previewUrl: string
  promptPrefix: string
  negativePrompt: string
  defaultMove: DharmaImageMove
  treatment: DharmaVisualTreatment
  emotions: readonly DharmaEmotion[]
  production: boolean
}

export interface DharmaImageStyleSnapshot {
  version: 1
  id: string
  promptPrefix: string
  negativePrompt: string
  defaultMove: DharmaImageMove
  treatment: DharmaVisualTreatment
}

const COMMON_NEGATIVE_PROMPT = [
  'readable text or calligraphy',
  'subtitles',
  'watermark',
  'logo',
  'literal concept diagram',
  'modern commercial interior',
  'tourist crowd',
  'front-facing presenter',
  'kitsch religious poster',
  'neon cyberpunk palette',
].join(', ')

const DHARMA_IMAGE_STYLES: readonly DharmaImageStyle[] = [
  {
    id: DHARMA_EMOTIONAL_INK_STYLE_ID,
    name: '水墨意境',
    description: '以墨色、宣纸肌理与大留白承载平静、接纳和释然。',
    previewUrl: '/static/images/dharma-emotional-ink-v1-preview.jpg',
    promptPrefix: 'new Chinese ink-wash cinematic tableau, layered mineral ink, expressive water diffusion on xuan paper, restrained charcoal and jade-gray palette, deep atmospheric negative space, quiet sacred presence, refined contemporary composition, 16:9 landscape',
    negativePrompt: `${COMMON_NEGATIVE_PROMPT}, decorative antique scroll border, flat clip-art illustration`,
    defaultMove: 'drift_right',
    treatment: 'ink_wash',
    emotions: ['stillness', 'acceptance', 'release'],
    production: true,
  },
  {
    id: DHARMA_SURREAL_DREAM_STYLE_ID,
    name: '超现实梦境',
    description: '用不可能的空间、尺度和光线制造好奇与心理张力。',
    previewUrl: '/static/images/dharma-surreal-dream-v1-preview.jpg',
    promptPrefix: 'poetic surreal dreamscape grounded in Eastern contemplative imagery, impossible scale and spatial metaphor organized around one clear human relationship or symbolic focal action, suspended mist, cinematic chiaroscuro, tactile realism, mysterious but serene, restrained black ivory and oxidized-gold palette, 16:9 landscape',
    negativePrompt: `${COMMON_NEGATIVE_PROMPT}, horror, grotesque anatomy, psychedelic rainbow, fantasy game poster`,
    defaultMove: 'push',
    treatment: 'surreal_dream',
    emotions: ['curiosity', 'tension'],
    production: true,
  },
  {
    id: DHARMA_MINIMAL_LIGHT_STYLE_ID,
    name: '极简光影',
    description: '用单一光束、深暗空间和中心留白托住金句与顿悟。',
    previewUrl: '/static/images/dharma-minimal-light-v1-preview.jpg',
    promptPrefix: 'minimal cinematic light-and-shadow study in a silent temple room, one precise beam of natural light, near-black negative space, a single restrained material detail, spacious centered composition reserved for a teaching phrase overlay, solemn contemplative atmosphere, 16:9 landscape',
    negativePrompt: `${COMMON_NEGATIVE_PROMPT}, busy props, multiple focal points, bright daylight room, decorative typography`,
    defaultMove: 'hold',
    treatment: 'minimal_light',
    emotions: ['insight'],
    production: true,
  },
  {
    id: 'dharma-sacred-temple-v1',
    name: '静室写实（兼容）',
    description: '旧项目兼容风格；新生产请使用情绪风格组合。',
    previewUrl: '/static/images/dharma-style-sacred-temple.jpg',
    promptPrefix: 'serene Chinese Buddhist temple, incense smoke, warm natural light, restrained cinematic realism, contemplative atmosphere, detailed architectural texture',
    negativePrompt: COMMON_NEGATIVE_PROMPT,
    defaultMove: 'push',
    treatment: 'legacy_temple',
    emotions: [],
    production: false,
  },
  {
    id: 'dharma-ink-contemplation-v1',
    name: '宋韵留白（兼容）',
    description: '旧项目兼容风格；新生产请使用情绪风格组合。',
    previewUrl: '/static/images/song-dynasty-aesthetic.png',
    promptPrefix: 'neo-Chinese ink and watercolor illustration, muted mineral pigments, subtle rice paper texture, elegant negative space, tranquil contemplative Buddhist atmosphere',
    negativePrompt: COMMON_NEGATIVE_PROMPT,
    defaultMove: 'push',
    treatment: 'legacy_temple',
    emotions: [],
    production: false,
  },
  {
    id: 'dharma-gongbi-sutra-v1',
    name: '香火暗调（兼容）',
    description: '旧项目兼容风格；新生产请使用情绪风格组合。',
    previewUrl: '/static/images/dharma-style-incense-cinema.jpg',
    promptPrefix: 'low-key Buddhist still life photography, bronze Buddha statue, curling incense smoke, warm candlelight, deep black background, meditative cinematic composition',
    negativePrompt: COMMON_NEGATIVE_PROMPT,
    defaultMove: 'push',
    treatment: 'legacy_temple',
    emotions: [],
    production: false,
  },
  {
    id: 'dharma-quiet-cinema-v1',
    name: '禅居自然（兼容）',
    description: '旧项目兼容风格；新生产请使用情绪风格组合。',
    previewUrl: '/static/images/wabi-sabi-minimal.png',
    promptPrefix: 'quiet Japanese-inspired contemplative architecture, natural wood and stone, dappled daylight, muted earth palette, meditative spatial photography, authentic material texture',
    negativePrompt: COMMON_NEGATIVE_PROMPT,
    defaultMove: 'push',
    treatment: 'legacy_temple',
    emotions: [],
    production: false,
  },
]

const DHARMA_EMOTION_SET = new Set<string>(DHARMA_EMOTIONS)
const DHARMA_IMAGE_MOVE_SET = new Set<string>(DHARMA_IMAGE_MOVES)
const DHARMA_TREATMENT_SET = new Set<string>(DHARMA_VISUAL_TREATMENTS)

const EMOTION_PROMPTS: Record<DharmaEmotion, string> = {
  curiosity: 'Emotional purpose: create an immediate question and quiet unease without explaining the idea literally',
  stillness: 'Emotional purpose: slow the viewer down and create inward stillness',
  tension: 'Emotional purpose: embody inner conflict and psychological pressure without melodrama',
  acceptance: 'Emotional purpose: convey warmth, permission, and non-judgmental acceptance',
  insight: 'Emotional purpose: leave a clear breath of silence around a moment of realization',
  release: 'Emotional purpose: open the space outward and let the viewer leave without a visual conclusion',
}

export function listDharmaImageStyles(): readonly DharmaImageStyle[] {
  return DHARMA_IMAGE_STYLES
}

export function findDharmaImageStyle(style: unknown): DharmaImageStyle | null {
  const id = typeof style === 'string' ? style.trim() : ''
  return DHARMA_IMAGE_STYLES.find((item) => item.id === id) ?? null
}

export function resolveDharmaImageStyle(style: unknown): DharmaImageStyle {
  return findDharmaImageStyle(style)
    ?? DHARMA_IMAGE_STYLES.find((item) => item.id === DEFAULT_DHARMA_IMAGE_STYLE_ID)!
}

export function normalizeDharmaEmotion(value: unknown): { emotion: DharmaEmotion } | { error: string } {
  if (typeof value !== 'string' || !DHARMA_EMOTION_SET.has(value)) {
    return { error: `情绪角色必须是 ${DHARMA_EMOTIONS.join('、')} 之一` }
  }
  return { emotion: value as DharmaEmotion }
}

export function normalizeDharmaImageMove(value: unknown): { move: DharmaImageMove } | { error: string } {
  if (typeof value !== 'string' || !DHARMA_IMAGE_MOVE_SET.has(value)) {
    return { error: `图片运镜必须是 ${DHARMA_IMAGE_MOVES.join('、')} 之一` }
  }
  return { move: value as DharmaImageMove }
}

export function isDharmaProductionImageStyle(style: DharmaImageStyle): boolean {
  return style.production
}

export function resolveDharmaStyleForEmotion(emotion: DharmaEmotion): DharmaImageStyle {
  return DHARMA_IMAGE_STYLES.find((style) => style.production && style.emotions.includes(emotion))!
}

export function validateDharmaStyleEmotion(
  style: DharmaImageStyle,
  emotion: DharmaEmotion,
): string | null {
  if (!style.production) return `风格 ${style.id} 仅用于旧项目兼容，不能进入新的情绪生产方案`
  if (!style.emotions.includes(emotion)) {
    return `风格「${style.name}」不能承担 ${emotion}；该情绪应使用「${resolveDharmaStyleForEmotion(emotion).name}」`
  }
  return null
}

export function snapshotDharmaImageStyle(style: DharmaImageStyle): DharmaImageStyleSnapshot {
  return {
    version: 1,
    id: style.id,
    promptPrefix: style.promptPrefix,
    negativePrompt: style.negativePrompt,
    defaultMove: style.defaultMove,
    treatment: style.treatment,
  }
}

export function isCanonicalDharmaImageStyleSnapshot(
  style: DharmaImageStyle,
  snapshot: DharmaImageStyleSnapshot,
): boolean {
  const canonical = snapshotDharmaImageStyle(style)
  return snapshot.version === canonical.version
    && snapshot.id === canonical.id
    && snapshot.promptPrefix === canonical.promptPrefix
    && snapshot.negativePrompt === canonical.negativePrompt
    && snapshot.defaultMove === canonical.defaultMove
    && snapshot.treatment === canonical.treatment
}

export function parseDharmaImageStyleSnapshot(value: unknown): DharmaImageStyleSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1
    || typeof record.id !== 'string'
    || typeof record.promptPrefix !== 'string'
    || typeof record.negativePrompt !== 'string'
    || typeof record.defaultMove !== 'string'
    || !DHARMA_IMAGE_MOVE_SET.has(record.defaultMove)
    || typeof record.treatment !== 'string'
    || !DHARMA_TREATMENT_SET.has(record.treatment)) return null
  return record as unknown as DharmaImageStyleSnapshot
}

export function buildDharmaImagePrompt(
  prompt: string,
  style: unknown,
  options: { emotion?: DharmaEmotion; spatialContext?: string; snapshot?: DharmaImageStyleSnapshot } = {},
): {
  style: DharmaImageStyle
  snapshot: DharmaImageStyleSnapshot
  prompt: string
} {
  const resolved = resolveDharmaImageStyle(style)
  const snapshot = options.snapshot ?? snapshotDharmaImageStyle(resolved)
  const base = prompt.trim()
  const styledBase = base.toLowerCase().startsWith(snapshot.promptPrefix.toLowerCase())
    ? base
    : `${snapshot.promptPrefix}. ${base}`
  return {
    style: resolved,
    snapshot,
    prompt: [
      styledBase,
      ...(options.spatialContext?.trim() ? [options.spatialContext.trim()] : []),
      ...(options.emotion ? [EMOTION_PROMPTS[options.emotion]] : []),
      `Avoid: ${snapshot.negativePrompt}`,
    ].join('. '),
  }
}
