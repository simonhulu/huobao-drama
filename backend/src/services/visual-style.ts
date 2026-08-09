/**
 * 视觉风格 → Prompt 文本注入
 *
 * GPT Image 2 / DALL-E / 多数文生图 API 没有独立的 style 参数，
 * 风格必须通过 prompt 中的自然语言描述来传递。本模块把 dramas.style
 * 存储的简短风格标记（realistic/anime/ghibli/...）展开成模型易理解的
 * 英文风格短语，并统一 prepend 到生成 prompt 中。
 */
import {
  HISTORY_VISUAL_STYLE_PROFILES,
  buildHistoryVisualStyleDirective,
} from './history-visual-style.js'

const HISTORY_STYLE_DESCRIPTIONS = Object.fromEntries(
  Object.keys(HISTORY_VISUAL_STYLE_PROFILES).map((id) => [id, buildHistoryVisualStyleDirective(id)]),
)

export const STYLE_DESCRIPTIONS: Record<string, string> = {
  // 通用 / 基础风格
  generic: 'cinematic film still, highly detailed, refined visual, dramatic lighting, movie composition',
  realistic: 'photorealistic, realistic lighting and textures, highly detailed',
  anime: 'anime style, crisp linework, vibrant colors',
  ghibli: 'Studio Ghibli style, soft painterly animation, warm colors',
  cinematic: 'cinematic film still, dramatic lighting, movie composition, highly detailed',
  comic: 'comic book style, bold lines, dynamic composition',
  watercolor: 'watercolor painting, soft washes, painterly texture',

  // 电影摄影风格（导演 / 镜头语言）
  wes_anderson: 'Wes Anderson style, symmetrical composition, pastel color palette, deadpan staging, 35mm film',
  film_noir: 'film noir style, high contrast black and white, dramatic shadows, moody cinematic, 1940s aesthetic',
  rembrandt: 'Rembrandt lighting portrait, dramatic chiaroscuro, warm tungsten key light, dark background',
  villeneuve: 'Denis Villeneuve style cinematic, vast scale, atmospheric haze, golden hour, ultra-wide composition',
  wong_kar_wai: 'Wong Kar-wai style, neon reflections, slow shutter motion blur, moody romantic atmosphere, 35mm film grain',
  documentary: 'documentary photography style, natural lighting, photojournalistic, authentic texture, candid moment',
  vintage_film: 'vintage 35mm film photography, subtle grain, warm faded colors, nostalgic mood, soft focus',

  // 艺术绘画
  oil_painting: 'oil painting, rich brushstrokes, classical fine art, textured canvas',
  pastel: 'soft pastel illustration, delicate powdery texture, gentle gradients',
  ink_wash: 'Chinese ink wash painting, expressive brushstrokes, monochrome ink tones, poetic atmosphere',
  ukiyo_e: 'Ukiyo-e woodblock print style, flat bold outlines, vivid colors, traditional Japanese art',
  impressionist: 'Impressionist painting, loose visible brushstrokes, dappled light, vivid color harmony',
  pop_art: 'Pop Art style, bold flat colors, Ben-Day dots, graphic poster aesthetic',
  renaissance: 'Renaissance oil painting, sfumato, classical composition, religious grandeur, chiaroscuro',
  baroque: 'Baroque painting, dramatic tenebrism, ornate detail, emotional intensity, golden light',
  neoclassical: 'Neoclassical painting, clean lines, idealized forms, moral seriousness, Jacques-Louis David style',

  // 视觉氛围
  cyberpunk: 'cyberpunk cinematic, neon-lit cityscape, high-tech low-life, rain-soaked atmosphere',
  steampunk: 'steampunk aesthetic, brass gears, Victorian machinery, warm sepia tones',
  fantasy: 'epic fantasy art, magical lighting, mythical atmosphere, highly detailed',
  noir: 'film noir style, high contrast black and white, dramatic shadows, moody cinematic',
  vintage: 'vintage 1980s aesthetic, film grain, warm faded colors, nostalgic mood',
  minimalist: 'minimalist illustration, clean lines, limited color palette, negative space',
  dark_academia: 'dark academia aesthetic, old library, tungsten lamplight, deep navy and olive palette',

  // 媒介渲染
  digital_art: 'digital art, polished illustration, vibrant colors, clean rendering',
  concept_art: 'concept art, detailed environment design, cinematic composition, professional game art',
  pixel_art: 'pixel art, 16-bit retro game style, crisp pixels, limited palette',
  line_art: 'clean line art, black and white illustration, precise outlines, minimal shading',
  '3d_render': '3D render, octane render, soft studio lighting, photorealistic materials',
  isometric: 'isometric illustration, clean vector-like rendering, balanced geometric composition',

  // 中式 / 东方历史
  chinese_ink: 'Chinese ink wash painting, misty mountains, flowing brushwork, elegant negative space',
  chinese_gongbi: 'Chinese gongbi painting, fine detailed brushwork, rich mineral pigments, traditional court art',
  // Dharma emotional arc presets (the dedicated Dharma catalog also carries treatment/move metadata).
  dharma_emotional_ink_v1: 'new Chinese ink-wash cinematic tableau, layered mineral ink, xuan paper texture, restrained charcoal and jade-gray palette, deep negative space, quiet sacred presence',
  dharma_surreal_dream_v1: 'poetic surreal dreamscape grounded in Eastern contemplative imagery, impossible scale and spatial metaphor, suspended mist, cinematic chiaroscuro, mysterious but serene',
  dharma_minimal_light_v1: 'minimal cinematic light-and-shadow study in a silent temple room, one precise beam of natural light, near-black negative space, spacious centered composition',
  wuxia: 'wuxia cinematic, ancient Chinese martial arts, flowing robes, sword qi, moonlit bamboo forest',
  chinese_palace: 'Chinese imperial palace style, ornate golden dragon details, red pillars, court drama atmosphere',
  eastern_fantasy: 'Eastern fantasy, immortal cultivation aesthetic, celestial mountains, ethereal clouds, glowing runes',
  ukiyo_samurai: 'Ukiyo-e samurai print, dynamic combat pose, flat color areas, bold outlines, Edo period',

  // 西方 / 世界历史
  historical: 'historical epic, cinematic period drama, painterly realism, grand composition, museum quality',
  historical_epic: 'historical epic, cinematic period drama, painterly realism, grand composition, museum quality',
  roman_fresco: 'ancient Roman fresco, archaeological mural, terracotta and ochre palette, classical figures',
  byzantine: 'Byzantine icon painting, gold leaf background, stylized sacred figure, flat perspective',
  medieval_manuscript: 'medieval illuminated manuscript, gold leaf borders, miniature painting, parchment texture',
  dutch_golden_age: 'Dutch Golden Age painting, chiaroscuro, detailed still life, Rembrandt school, 17th century',
  victorian: 'Victorian illustration, engraved line work, sepia tone, 19th century period detail',
  prohibition_era: 'Prohibition-era 1920s, speakeasy atmosphere, Art Deco details, black and white documentary',
  wwii_photo: 'World War II documentary photograph, period-accurate uniforms, grainy black and white, photojournalism',

  // 高级主题风格（兼容旧题材推荐）
  scifi: 'sci-fi cinematic, sleek futuristic design, neon accents, high detail, atmospheric',
  mythology: 'mythological fantasy, ethereal lighting, epic scale, ornate details, divine atmosphere',
  space: 'space cinematic, cosmic scale, deep shadows, glowing nebulae, photorealistic astronomy',
  deepsea: 'deep sea bioluminescent, dark atmospheric, cinematic underwater, mysterious glow',
  ancient: 'ancient civilization, monumental architecture, golden hour cinematic, archaeological grandeur',
  wasteland: 'post-apocalyptic wasteland, dusty atmospheric, cinematic desolation, muted earth tones',

  // 史诗奇幻角色 / 封面构图 preset
  dragon_rider_cover: 'A knight in golden plate armor with a full-face helmet, riding a massive red-brown scaled dragon; the knight holds a longsword in his right hand and grips the hilt with his left, leaning slightly forward with legs straddling the dragon\'s back, a red cape billowing behind him from the shoulders; the dragon has rough, granular scales, spiky protrusions along its head and neck, mouth slightly open showing teeth, front claws planted on ground in a low-crawling stance; background features medieval stone buildings lining a dusty street, softly blurred to suggest depth and atmosphere; warm golden sunlight from upper-left creates strong rim lighting and deep shadows, enhancing form and texture; low-angle eye-level shot with dragon\'s head dominating foreground lower third, knight centered in midground, creating dynamic visual hierarchy; photorealistic fantasy illustration style, high-detail rendering, cinematic lighting, emphasis on muscle definition and scale texture; primary colors: red-brown, gold, ochre; secondary: dark gray, bright orange; materials: polished worn metal armor, wrinkled fabric cape, rocky textured scales with cracks and ridges; aspect ratio 449:600 vertical; ultra-high resolution, sharp edges, no noise or artifacts; likely generation intent: emphasize epic scale and symbiotic power between rider and beast for cover art or game concept.',
  volcanic_forge_blacksmith: 'A middle-aged male blacksmith with a long dark brown beard and facial scars, wearing a soot-stained dark brown leather apron and shoulder armor, raising a heavy iron hammer high in his right hand while his left hand steadies a glowing hot steel bar on a large stone anvil; the anvil features intricate Norse-style geometric carvings and visible wear marks; background depicts a subterranean forge cavern with multi-level metal scaffolding and walkways suspended from rock walls, molten lava waterfalls and fires illuminating the distance, all shrouded in orange-hued smoke; primary lighting comes from the radiant glow of the hot steel and surrounding lava, creating strong contrast, deep shadows, and atmospheric haze; low-angle medium close-up composition, subject centered slightly left, anvil occupying foreground lower half, slight upward camera tilt to emphasize physical power; photorealistic cinematic rendering style, emphasizing metallic textures, worn leather, skin grime, and environmental weathering; dominant colors: dark brown, burnt gold, fiery orange, and charcoal gray; materials: rough cast iron, aged leather, incandescent metal, stone, and dust; 4:5 vertical aspect ratio; ultra-high detail, film-grade sharpness and dynamic range; intended to capture a dramatic moment of forging in an epic fantasy setting, highlighting strength, craftsmanship, and environmental intensity.',

  // 历史叙事可执行风格档案（不使用创作者姓名捷径）
  ...HISTORY_STYLE_DESCRIPTIONS,
}

/**
 * 题材 → 推荐视觉风格
 *
 * 注意：题材（genre）和视觉风格（style）是两个独立字段。
 * 题材只用于内容分类和推荐默认风格；真正注入图片 prompt 的是 style。
 */
export const GENRE_STYLE_RECOMMENDATIONS: Record<string, string> = {
  generic: 'cold_ink_spatial',
  history: 'cold_ink_spatial',
  dharma: 'dharma-emotional-ink-v1',
  scifi: 'cyberpunk',
  mythology: 'eastern_fantasy',
  space: 'cinematic',
  deepsea: 'documentary',
  ancient: 'chinese_gongbi',
  wasteland: 'cinematic',
}

export function recommendedStyleForGenre(genre: string | null | undefined): string {
  if (!genre) return 'cold_ink_spatial'
  return GENRE_STYLE_RECOMMENDATIONS[genre.trim().toLowerCase()] || 'cold_ink_spatial'
}

/**
 * 把风格标记转成可用于 prompt 的英文短语。
 * 未知风格直接回退为 "{style} style"，保证任何自定义值都能生效。
 */
export function styleToPromptPhrase(style: string | null | undefined): string {
  if (!style) return ''
  const normalized = style.trim().toLowerCase().replace(/-/g, '_')
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
