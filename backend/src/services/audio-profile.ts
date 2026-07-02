/**
 * Audio Profile Service
 *
 * 从分镜文本（旁白、描述、氛围、地点、动作）推断情绪桶、BGM 提示、
 * 音效建议和环境音描述。不依赖 LLM，使用规则 + 关键词匹配，可离线运行。
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

export type EmotionBucket =
  | 'tense'
  | 'romantic'
  | 'sad'
  | 'happy'
  | 'epic'
  | 'mysterious'
  | 'calm'
  | 'action'
  | 'neutral'

export interface AudioProfile {
  emotionBucket: EmotionBucket
  bgmIntensity: 'low' | 'medium' | 'high'
  bgmPrompt: string
  bgmPromptVariants: string[]
  sfxDescriptions: string[]
  ambientDescription: string
}

interface Rule {
  keywords: string[]
  bucket: EmotionBucket
  intensity: 'low' | 'medium' | 'high'
  bgmAdjective: string
  genres: string[]
  instruments: string[]
  moods: string[]
  ambient?: string
}

const BGM_STYLE = 'instrumental cinematic background music, continuous musical bed, no vocals, no short sound effects, no percussion hits, seamless loop, suitable for short drama'

const EMOTION_RULES: Rule[] = [
  {
    keywords: ['杀', '死', '逃', '追', '抓', '刀', '枪', '战', '打', '暴力', '危机', '危险', '紧张', '恐惧', '害怕', '惊', '尖叫', '威胁', '绑架', '陷害', '揭露', '对峙', 'fight', 'kill', 'escape', 'chase', 'knife', 'gun', 'battle'],
    bucket: 'tense',
    intensity: 'high',
    bgmAdjective: 'tense percussive thriller',
    genres: ['thriller', 'suspense'],
    instruments: ['low strings', 'timpani', 'sub bass', 'dissonant synth'],
    moods: ['suspenseful', 'nervous', 'ominous'],
    ambient: 'tension ambience',
  },
  {
    keywords: ['爱', '吻', '拥抱', '温柔', '心动', '浪漫', '约会', '喜欢', '深情', '甜蜜', 'love', 'kiss', 'romantic', 'tender', 'heart'],
    bucket: 'romantic',
    intensity: 'low',
    bgmAdjective: 'soft romantic piano strings',
    genres: ['romantic drama', 'chamber pop'],
    instruments: ['piano', 'solo violin', 'warm pads', 'acoustic guitar'],
    moods: ['intimate', 'warm', 'yearning'],
    ambient: 'warm room ambience',
  },
  {
    keywords: ['哭', '泪', '痛', '失去', '离别', '绝望', '悲伤', '心碎', '遗憾', 'cry', 'tear', 'sad', 'loss', 'despair', 'heartbroken', 'grief'],
    bucket: 'sad',
    intensity: 'medium',
    bgmAdjective: 'melancholic cello and piano',
    genres: ['melancholic drama', 'neoclassical'],
    instruments: ['cello', 'piano', 'soft strings', 'solo oboe'],
    moods: ['mournful', 'lonely', 'bittersweet'],
    ambient: 'somber ambience',
  },
  {
    keywords: ['笑', '开心', '欢乐', '庆祝', '胜利', '成功', '轻松', '愉快', '聚会', 'happy', 'laugh', 'joy', 'celebrate', 'victory', 'cheerful'],
    bucket: 'happy',
    intensity: 'medium',
    bgmAdjective: 'bright upbeat acoustic',
    genres: ['feel-good', 'light comedy'],
    instruments: ['ukulele', 'light percussion', 'whistled melody', 'bright piano'],
    moods: ['uplifting', 'playful', 'carefree'],
    ambient: 'lively ambience',
  },
  {
    keywords: ['大战', '战争', '英雄', '拯救', '宏大', '史诗', '磅礴', '气势', 'war', 'epic', 'hero', 'save', 'magnificent'],
    bucket: 'epic',
    intensity: 'high',
    bgmAdjective: 'epic orchestral brass and drums',
    genres: ['epic orchestral', 'heroic trailer'],
    instruments: ['brass section', 'taiko drums', 'string staccato', 'choir pad'],
    moods: ['triumphant', 'grandiose', 'heroic'],
    ambient: 'epic battlefield ambience',
  },
  {
    keywords: ['谜', '秘密', '未知', '黑暗', '悬疑', '诡异', '阴森', '探索', 'mystery', 'secret', 'unknown', 'dark', 'suspense', 'eerie'],
    bucket: 'mysterious',
    intensity: 'medium',
    bgmAdjective: 'mysterious ambient synth pads',
    genres: ['mystery', 'dark ambient'],
    instruments: ['synth pads', 'music box', 'soft bells', 'sub drones'],
    moods: ['enigmatic', 'unsettling', 'curious'],
    ambient: 'mysterious ambience',
  },
  {
    keywords: ['安静', '平静', '沉思', '日常', '走路', '街道', '室内', 'calm', 'quiet', 'peaceful', 'daily', 'walk', 'street', 'indoor'],
    bucket: 'calm',
    intensity: 'low',
    bgmAdjective: 'calm gentle ambient',
    genres: ['ambient', 'lo-fi'],
    instruments: ['soft pads', 'acoustic guitar', 'warm bass', ' Rhodes piano'],
    moods: ['peaceful', 'relaxed', 'contemplative'],
    ambient: 'calm room tone',
  },
  {
    keywords: ['古代', '历史', '王朝', '皇帝', '宫廷', '古', 'ancient', 'history', 'dynasty', 'emperor', 'palace', 'royal'],
    bucket: 'epic',
    intensity: 'high',
    bgmAdjective: 'historical Chinese orchestral epic',
    genres: ['historical drama', 'Chinese orchestral'],
    instruments: ['guzheng', 'erhu', 'pipa', 'Chinese percussion', 'orchestral strings'],
    moods: ['majestic', 'regal', 'timeless'],
    ambient: 'ancient hall ambience',
  },
  {
    keywords: ['科幻', '未来', '太空', '飞船', '机器人', 'scifi', 'sci-fi', 'future', 'space', 'spaceship', 'robot', 'cyber'],
    bucket: 'mysterious',
    intensity: 'medium',
    bgmAdjective: 'futuristic cyberpunk synth score',
    genres: ['sci-fi', 'cyberpunk'],
    instruments: ['analog synth', 'arpeggiator', 'distorted bass', 'digital pads'],
    moods: ['futuristic', 'dystopian', 'awe-inspiring'],
    ambient: 'spaceship hum ambience',
  },
]

const SFX_HINTS: Array<{ keywords: string[]; descriptions: string[] }> = [
  { keywords: ['门', '推', '拉', '进', '出', 'door', 'enter', 'exit'], descriptions: ['木门开合 creak', '门把手转动 handle'] },
  { keywords: ['脚步', '走', '跑', '追', '逃', 'footstep', 'walk', 'run', 'chase'], descriptions: ['脚步声 footsteps', '急促脚步 fast steps'] },
  { keywords: ['手机', '电话', '铃', 'phone', 'call', 'ring'], descriptions: ['手机铃声 phone ring', '消息提示 message'] },
  { keywords: ['车', '开车', '刹车', 'car', 'drive', 'brake'], descriptions: ['汽车发动 car engine', '刹车 skid'] },
  { keywords: ['雨', '下雨', 'rain', 'rainy'], descriptions: ['雨声 rain', '雨滴 drip'] },
  { keywords: ['风', '刮', 'wind', 'blow'], descriptions: ['风声 wind', '树叶沙沙 leaves'] },
  { keywords: ['杯', '玻璃', '摔', '碎', 'glass', 'cup', 'break'], descriptions: ['玻璃破碎 glass break', '杯子碰撞 cup clink'] },
  { keywords: ['纸', '书', '翻', 'page', 'book', 'paper'], descriptions: ['翻书页 page flip', '纸张摩擦 paper'] },
  { keywords: ['钱', '币', '筹码', 'money', 'coin', 'chip'], descriptions: ['硬币碰撞 coins', '筹码碰撞 chips'] },
  { keywords: ['刀', '剑', '武器', 'knife', 'sword', 'weapon'], descriptions: ['刀剑出鞘 blade', '金属碰撞 metal hit'] },
  { keywords: ['打', '拳', '掌', 'hit', 'punch', 'slap'], descriptions: ['拳击 punch', '巴掌 slap', '身体撞击 body impact'] },
  { keywords: ['哭', '泪', '抽泣', 'cry', 'tear', 'sob'], descriptions: ['抽泣 sob', '叹息 sigh'] },
  { keywords: ['笑', 'laugh', 'chuckle'], descriptions: ['轻笑 chuckle', '笑声 laugh'] },
]

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[，,、。\.!！?？;；:：""''（）()\[\]]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function scoreRules(text: string): Rule[] {
  const tokens = tokenize(text)
  const scored = EMOTION_RULES.map(rule => {
    let hits = 0
    for (const kw of rule.keywords) {
      if (tokens.some(t => t.includes(kw) || kw.includes(t))) {
        hits++
      }
    }
    return { rule, hits }
  })
  scored.sort((a, b) => b.hits - a.hits)
  return scored.filter(s => s.hits > 0).map(s => s.rule)
}

function buildPromptVariant(rule: Rule, variantIndex: number, intensity: 'low' | 'medium' | 'high'): string {
  const genre = rule.genres[variantIndex % rule.genres.length] || rule.genres[0]
  const instrument = rule.instruments[variantIndex % rule.instruments.length] || rule.instruments[0]
  const mood = rule.moods[variantIndex % rule.moods.length] || rule.moods[0]
  const intensityPhrase = intensity === 'high' ? 'high energy, driving rhythm' : intensity === 'low' ? 'gentle and sparse' : 'moderate dynamic flow'
  return `${genre} ${mood} ${instrument} ${rule.bgmAdjective}, ${BGM_STYLE}, ${intensityPhrase}`
}

function buildPromptVariants(rule: Rule, intensity: 'low' | 'medium' | 'high'): string[] {
  const variants: string[] = []
  for (let i = 0; i < 3; i++) {
    variants.push(buildPromptVariant(rule, i, intensity))
  }
  return variants
}

export function inferAudioProfile(text: string, energyLevel?: string | null): AudioProfile {
  const source = text || ''
  const rules = scoreRules(source)
  const rule = rules[0] ?? {
    bucket: 'neutral' as EmotionBucket,
    intensity: 'medium' as const,
    bgmAdjective: 'neutral cinematic pad',
    genres: ['cinematic ambient'],
    instruments: ['soft pads', 'piano'],
    moods: ['neutral', 'balanced'],
  }

  // energy_level 可以作为强度修正
  let intensity = rule.intensity
  if (energyLevel === 'high') intensity = 'high'
  if (energyLevel === 'low') intensity = 'low'

  const variants = buildPromptVariants(rule, intensity)

  const tokens = tokenize(source)
  const sfxDescriptions: string[] = []
  for (const hint of SFX_HINTS) {
    if (hint.keywords.some(kw => tokens.some(t => t.includes(kw) || kw.includes(t)))) {
      for (const desc of hint.descriptions) {
        if (!sfxDescriptions.includes(desc)) sfxDescriptions.push(desc)
      }
    }
  }

  const ambientDescription = rule.ambient || 'neutral room tone'

  return {
    emotionBucket: rule.bucket,
    bgmIntensity: intensity,
    bgmPrompt: variants[0],
    bgmPromptVariants: variants,
    sfxDescriptions,
    ambientDescription,
  }
}

export function pickBgmPromptVariant(profile: AudioProfile, storyboardNumber: number): string {
  if (!profile.bgmPromptVariants || profile.bgmPromptVariants.length === 0) return profile.bgmPrompt
  const index = Math.max(0, storyboardNumber - 1) % profile.bgmPromptVariants.length
  return profile.bgmPromptVariants[index]
}

export function inferStoryboardAudioProfile(storyboardId: number): AudioProfile {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)

  const text = [
    sb.narration,
    sb.description,
    sb.action,
    sb.atmosphere,
    sb.location,
    sb.title,
    sb.soundEffect,
  ].filter(Boolean).join(' ')

  return inferAudioProfile(text, sb.energyLevel)
}

export function inferEpisodeAudioProfiles(episodeId: number): Map<number, AudioProfile> {
  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()

  const profiles = new Map<number, AudioProfile>()
  for (const sb of sbs) {
    const text = [sb.narration, sb.description, sb.action, sb.atmosphere, sb.location, sb.title, sb.soundEffect]
      .filter(Boolean)
      .join(' ')
    profiles.set(sb.id, inferAudioProfile(text, sb.energyLevel))
  }
  return profiles
}

/**
 * 把推断结果写回 storyboards 表的 bgm_prompt / sound_effect 字段。
 * 仅填充空字段，不会覆盖用户或 agent 已填写的内容。
 * 同一个情绪桶会按 storyboardNumber 轮询 prompt 变体，避免相邻镜头 BGM 雷同。
 */
export function applyAudioProfileToStoryboard(storyboardId: number): AudioProfile {
  const profile = inferStoryboardAudioProfile(storyboardId)
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) return profile

  const updates: Record<string, unknown> = {}
  if (!sb.bgmPrompt?.trim()) {
    updates.bgmPrompt = pickBgmPromptVariant(profile, sb.storyboardNumber)
  }
  if (!sb.soundEffect?.trim() && profile.sfxDescriptions.length > 0) {
    updates.soundEffect = profile.sfxDescriptions.slice(0, 2).join('; ')
  }
  if (Object.keys(updates).length > 0) {
    db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboardId)).run()
  }
  return profile
}
