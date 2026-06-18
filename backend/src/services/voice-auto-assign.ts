/**
 * 规则化音色自动分配（确定性，不调大模型）
 * 从角色的 name/role/personality/description 推断性别、年龄、气质，
 * 与音色库的中文标签（voiceName）做关键词加权匹配，给未分配音色的角色填默认值。
 */
import { eq, isNull, and, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseDialogueLines } from './dialogue.js'
import { logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

type Gender = 'male' | 'female' | 'unknown'
type Age = 'old' | 'young' | 'mid' | 'unknown'

interface VoiceRow {
  voiceId: string
  voiceName: string
  language: string | null
}

/** 从角色文本推断性别（正则严谨化：避免「子女」「兄妹」等误判） */
function inferGender(text: string): Gender {
  const female = /女性|女人|女子|女主|妇女|少女|御姐|大婶|大妈|奶奶|婶子|大娘|姑娘|媳妇|嫂子|太太|夫人|女士|美女|母亲|姐姐|妹妹/
  const male = /男性|男人|男子|男主|大爷|大叔|老汉|爷爷|汉子|小伙|书生|少爷|公子|先生|大哥|弟弟|父亲|叔叔|爹/
  if (female.test(text)) return 'female'
  if (male.test(text)) return 'male'
  return 'unknown'
}

/** 从角色文本推断年龄段。traitText=名/定位/性格（本人）；desc 仅取数字年龄避免跨角色串味 */
function inferAge(traitText: string, desc: string): Age {
  // description 里的「老篾匠」「老伴」可能指别的角色，故只认数字年龄（几乎只描述本人）
  if (/[六七八九]十|[0-9]{2}\s*岁|花甲|古稀|年迈|苍老/.test(desc)) return 'old'
  if (/老人|大爷|大妈|奶奶|爷爷|老汉|老者|老头|老太/.test(traitText)) return 'old'
  if (/青年|少女|少年|小伙|学生|学长|学姐|学弟|学妹|年轻|小哥|青涩|大学生/.test(traitText)) return 'young'
  if (/中年|大叔|大婶|妇女|主任|干部|高管|老板|成熟/.test(traitText)) return 'mid'
  return 'unknown'
}

/** 从音色中文名推断它的性别取向 */
function voiceGender(voiceName: string): Gender {
  if (/女|少女|御姐|大婶|奶奶|姐|妹|娘|闺蜜|小姐|girl|woman|female|lady/i.test(voiceName)) return 'female'
  if (/男|大爷|大叔|青年|少爷|弟|哥|book|boy|man|male|gentleman|executive|youth/i.test(voiceName)) return 'male'
  return 'unknown'
}

/** 从音色中文名推断它的年龄取向 */
function voiceAge(voiceName: string): Age {
  if (/大爷|大妈|奶奶|爷爷|花甲|古稀|elder|senior/i.test(voiceName)) return 'old'
  if (/高管|成熟|御姐|大婶|阅历|executive|mature|wise|adult|woman|host|主持/i.test(voiceName)) return 'mid'
  if (/青年|少女|少爷|青涩|学弟|学妹|学长|学姐|弟弟|妹|男友|学生|萌妹|小哥|竹马|girl|boy|youth|young|lady|miss|bestie/i.test(voiceName)) return 'young'
  return 'unknown'
}

// 气质关键词 → 音色名关键词。仅作「同性别同年龄」内部的次级微调，分值远低于性别/年龄
const TRAIT_RULES: Array<{ when: RegExp; prefer: RegExp; score: number }> = [
  { when: /蛮横|粗暴|混混|霸道|嚣张|凶|恶|反派|地痞|流氓/, prefer: /霸道|不羁|嚣张|少爷/, score: 3 },
  { when: /沉稳|老练|精明|老谋|干部|主任|高管|权威|领导|老板|村长|书记/, prefer: /沉稳|高管|精英|执行|executive|reliable/i, score: 3 },
  { when: /搞笑|幽默|滑稽|风趣|爱看热闹|插科打诨|贫嘴/, prefer: /搞笑|幽默|humor/i, score: 3 },
  { when: /善良|热心|圆滑|和善|慈祥|护家|朴实|淳朴|农村/, prefer: /热心|温暖|善良|kind|warm/i, score: 3 },
  { when: /温柔|温和|贤惠|甜/, prefer: /温柔|甜美|温暖|温润|gentle|sweet|soft/i, score: 2 },
  { when: /机智|沉着|冷静|智慧|稳重|淡定|阅历/, prefer: /沉稳|阅历|真诚|wise|sincere/i, score: 2 },
  { when: /老实|憨厚|纯真|青涩|清澈/, prefer: /纯真|青涩|率真|清澈|pure/i, score: 2 },
]

/** 年龄契合度打分：完全一致权重最高，相邻段小幅，跨段（青年↔老年）重罚 */
function ageScore(charAge: Age, vAge: Age): number {
  if (charAge === 'unknown' || vAge === 'unknown') return 0
  if (charAge === vAge) return 8
  if ((charAge === 'young' && vAge === 'old') || (charAge === 'old' && vAge === 'young')) return -8
  return 2 // 相邻段（young↔mid / mid↔old）轻微容忍
}

/**
 * 给单个角色挑选最合适的音色 id。
 * 优先级（权重从高到低）：性别 → 年龄 → 职业/定位/气质。
 * - 性别已知且冲突：直接排除该音色（硬约束）
 * - 性别一致：+10；年龄完全契合：+8；气质规则：仅 2~3 分做同档内微调
 */
export function pickVoiceForCharacter(
  char: { name?: string | null; role?: string | null; personality?: string | null; description?: string | null },
  voices: VoiceRow[],
): string | null {
  if (!voices.length) return null
  // 气质/性别只用 角色名+定位+性格，避免 description 里提到的「别的角色」污染匹配
  const traitText = [char.name, char.role, char.personality].filter(Boolean).join(' ')
  const desc = char.description || ''
  const g = inferGender(traitText)
  const age = inferAge(traitText, desc)

  let best: { id: string; score: number } | null = null
  for (const v of voices) {
    const vg = voiceGender(v.voiceName)
    // 性别硬约束：角色性别明确但音色性别相反 → 排除
    if (g !== 'unknown' && vg !== 'unknown' && vg !== g) continue

    let score = 0
    if (g !== 'unknown' && vg === g) score += 10        // 性别一致：最高权重
    score += ageScore(age, voiceAge(v.voiceName))        // 年龄：次高权重(+8/-8)
    for (const rule of TRAIT_RULES) {                    // 职业/定位/气质：仅微调
      if (rule.when.test(traitText) && rule.prefer.test(v.voiceName)) score += rule.score
    }
    if (best === null || score > best.score) best = { id: v.voiceId, score }
  }
  if (best && best.score > 0) return best.id

  // 全不命中：按 性别+年龄 回退到稳妥默认
  const pick = (re: RegExp) => voices.find(v => re.test(v.voiceName))?.voiceId
  if (g === 'female') {
    if (age === 'old') return pick(/花甲奶奶|奶奶|热心大婶/) || pick(/女声|少女/) || voices[0].voiceId
    if (age === 'mid') return pick(/热心大婶|成熟女性|阅历|御姐/) || pick(/女声|甜美/) || voices[0].voiceId
    return pick(/甜美女声|温暖少女|少女|甜美/) || voices[0].voiceId
  }
  if (g === 'male') {
    if (age === 'old') return pick(/搞笑大爷|大爷/) || pick(/温润男声|gentleman/i) || voices[0].voiceId
    if (age === 'mid') return pick(/沉稳高管|温润男声|gentleman/i) || voices[0].voiceId
    return pick(/温润青年|青涩青年|温润男声|gentleman/i) || voices[0].voiceId
  }
  // 性别未知：按年龄回退
  if (age === 'old') return pick(/搞笑大爷|花甲奶奶|大爷|奶奶/) || voices[0].voiceId
  if (age === 'mid') return pick(/沉稳高管|温润男声|热心大婶/) || voices[0].voiceId
  return pick(/温润男声|gentleman|沉稳/i) || voices[0].voiceId
}

/** 取该集音频配置对应的 provider；缺省 minimax */
function resolveProvider(episodeId?: number): string {
  if (!episodeId) return 'minimax'
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep?.audioConfigId) return 'minimax'
  const [cfg] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.audioConfigId)).all()
  return cfg?.provider || 'minimax'
}

export interface AutoAssignResult {
  assigned: Array<{ id: number; name: string; voice_id: string; pitch: number }>
  skipped: number
  provider: string
}

/**
 * 给 drama 下的角色批量填默认音色。
 * overwrite=false 时只填未分配（voiceStyle 为空）的角色；true 时全部重选。
 */
export function autoAssignVoices(
  dramaId: number,
  opts: { overwrite?: boolean; episodeId?: number } = {},
): AutoAssignResult {
  const provider = resolveProvider(opts.episodeId)
  const voices = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, provider)).all()
    .map(v => ({ voiceId: v.voiceId, voiceName: v.voiceName, language: v.language }))

  const chars = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt))).all()

  logTaskProgress('VoiceAutoAssign', 'begin', { dramaId, provider, voices: voices.length, chars: chars.length, overwrite: !!opts.overwrite })

  // 同一 voice_id 被多个角色占用时，依次错开音调避免“听起来是同一个人”
  // 使用模块级 PITCH_SEQ：第1个用 0，之后 -3/+3/-6...（MiniMax pitch 范围 -12~12）
  const usedCount = new Map<string, number>() // voiceId → 已占用次数

  // 先把「保留不动」的已分配角色计入占用，确保新分配的同音色角色正确错开
  if (!opts.overwrite) {
    for (const ch of chars) {
      if (ch.voiceStyle) usedCount.set(ch.voiceStyle, (usedCount.get(ch.voiceStyle) || 0) + 1)
    }
  }

  const assigned: AutoAssignResult['assigned'] = []
  let skipped = 0
  for (const ch of chars) {
    if (!opts.overwrite && ch.voiceStyle) { skipped++; continue }
    const voiceId = pickVoiceForCharacter(ch, voices)
    if (!voiceId) { skipped++; continue }
    const n = usedCount.get(voiceId) || 0
    usedCount.set(voiceId, n + 1)
    const pitch = PITCH_SEQ[Math.min(n, PITCH_SEQ.length - 1)]
    db.update(schema.characters)
      .set({ voiceStyle: voiceId, voiceProvider: provider, voicePitch: pitch, voiceSampleUrl: null, updatedAt: now() })
      .where(eq(schema.characters.id, ch.id)).run()
    assigned.push({ id: ch.id, name: ch.name, voice_id: voiceId, pitch })
  }

  logTaskSuccess('VoiceAutoAssign', 'done', { dramaId, assigned: assigned.length, skipped })
  return { assigned, skipped, provider }
}

// 同音色错开音调序列（与 autoAssignVoices 一致）
const PITCH_SEQ = [0, -3, 3, -6, 6, -9, 9, -12, 12]

/**
 * 按角色当前 voiceStyle 分布，给“撞同一音色”的角色错开 pitch。
 * 用于 LLM 分配音色后补做去重（LLM 只选 voice_id，不设 pitch）。
 * 每个 voice_id 第 1 个角色 pitch=0，之后 -3/+3/-6...。返回调整的角色数。
 */
export function dedupeCharacterPitches(dramaId: number): number {
  const chars = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt))).all()
  const seen = new Map<string, number>()
  let changed = 0
  for (const ch of chars) {
    if (!ch.voiceStyle) continue
    const n = seen.get(ch.voiceStyle) || 0
    seen.set(ch.voiceStyle, n + 1)
    const pitch = PITCH_SEQ[Math.min(n, PITCH_SEQ.length - 1)]
    if (ch.voicePitch !== pitch) {
      db.update(schema.characters).set({ voicePitch: pitch, voiceSampleUrl: null, updatedAt: now() })
        .where(eq(schema.characters.id, ch.id)).run()
      changed++
    }
  }
  if (changed) logTaskSuccess('VoiceAutoAssign', 'dedupe-pitch', { dramaId, changed })
  return changed
}

/**
 * 角色音色变更后，作废其参演镜头的对白配音与成片：
 * 找出该 drama 下 dialogue 含此说话人的 storyboards，置空 ttsAudioUrl + composedVideoUrl，
 * 下次合成会用新音色重生成。旁白音轨(narrationAudioUrl)与角色无关，保留不动。
 * 返回受影响的 storyboard 数。
 */
export function invalidateCharacterAudio(dramaId: number, characterName: string): number {
  if (!characterName) return 0
  // 该 drama 下所有剧集的 storyboards
  const episodes = db.select({ id: schema.episodes.id }).from(schema.episodes)
    .where(eq(schema.episodes.dramaId, dramaId)).all()
  if (!episodes.length) return 0
  const epIds = episodes.map(e => e.id)
  const sbs = db.select().from(schema.storyboards)
    .where(inArray(schema.storyboards.episodeId, epIds)).all()

  let affected = 0
  for (const sb of sbs) {
    if (!sb.ttsAudioUrl && !sb.composedVideoUrl) continue
    const speakers = parseDialogueLines(sb.dialogue).map(l => l.speaker)
    if (!speakers.includes(characterName)) continue
    db.update(schema.storyboards)
      .set({ ttsAudioUrl: null, composedVideoUrl: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, sb.id)).run()
    affected++
  }
  if (affected) logTaskSuccess('VoiceAutoAssign', 'invalidate-audio', { dramaId, characterName, affected })
  return affected
}
