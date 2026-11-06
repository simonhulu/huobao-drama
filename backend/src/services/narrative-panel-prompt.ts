/**
 * 叙事画格生产 —— 逐 Panel 生图提示词
 *
 * 这是「单图叙事合同」(decomposeShotForGrid + buildShotImagePrompt) 的替代生图逻辑。
 * 差异：单图合同对每个 storyboard 独立做 LLM 拆帧 + 独立提示词，跨镜连续性只靠
 * 松散的 scene-group；叙事画格改为从「叙事层级 Panel」(Sequence → Event → Beat →
 * Panel) 直接取设计，并在同一 Sequence 内把上一格的最终图作为连续性参考，从而保证
 * 每个 Sequence 内部的人物身份、服装、调色、屏幕方向与轴线一致。
 *
 * 注意：本模块不调用 LLM 拆帧，所有镜头设计直接来自 Panel 已有的 description /
 * beat.description / sequence.title，以及角色表（用于身份连续性）。
 */

import { sanitizeCharacterVisualIdentity } from './character-visual-identity.js'

/**
 * 叙事画格视觉档案：三维空间体积 + 二维水墨赛璐璐角色。
 * 这是「叙事画格」风格的固定视觉设定，替代单图合同的 buildHistoryVisualStyleDirective。
 */
export const NARRATIVE_PANEL_STYLE = [
  'Visual profile cold_ink_spatial: use 3D rendering for spatial depth, architectural volume, physically credible cold directional light, depth of field, and material response.',
  'Treat characters as refined 2D historical animation: rough black ink contours, cel-shaded shadow masses, flat color blocks, dry-brush grain, paper texture, and slight print misregistration. Never use photoreal people or glossy raw game CG.',
  'Palette: cold blue-gray, ink green, and deep indigo environments with restrained dark red and tiny fire-gold accents only where the narrative motivates them.',
].join('\n')

/** 从角色表生成「身份连续性」规则（替换 produce_project8 里硬编码的霍去病/卫青）。 */
export function relevantIdentitiesFromCharacters(
  characters: Array<{ name: string | null; appearance: string | null }>,
  actionText: string,
): string[] {
  const lines = characters
    .filter((c) => c.name)
    .map((c) => `${c.name}：${sanitizeCharacterVisualIdentity(c.appearance) || '恒定外观未设定'}`)
  if (lines.length) return lines
  // 兜底：无角色表时给出通用西汉历史人物约束
  return [
    'Western Han figures have period-credible Han robes, lamellar armor, saddles, weapons, hair, architecture, and social behavior.',
  ]
}

const VIOLENCE_PATTERN =
  /射杀|射死|中箭|放箭|箭矢|打伤|动了手|斩杀|杀掉|杀人|全军覆没|自刎|自戕|自杀|死亡|大战|交战|包围|冲进|拔刀|冲突|头颅|头骨|尸体|尸骸|shoot|arrow|weapon|kill|death|battle|attack|injury|fight|strike|blood/giu

export function panelRiskTags(text: string): string[] {
  const tags: string[] = []
  if (/射杀|射死|中箭|放箭|箭矢|打伤|动了手|斩杀|杀掉|杀人|全军覆没|自刎|自戕|自杀|死亡|头颅|头骨|尸体|尸骸/u.test(text)) tags.push('covered_aftermath')
  if (/射杀|射死|中箭|放箭|箭矢|打伤|动了手|斩杀|杀掉|杀人/u.test(text)) tags.push('weapon_contact')
  if (/打伤|受伤|受创/u.test(text)) tags.push('covered_injury')
  return [...new Set(tags)]
}

/** 按动作类型给出「可见证据」要求，保证画面不靠静态指挥官肖像代替动作。 */
export function visibleActionRequirement(text: string): string {
  if (/射杀|射死|放箭|中箭|箭矢|弓箭/u.test(text)) {
    return 'For archery, keep the bow, arrow trajectory, target direction, and result legible in one coherent frame; conceal the exact contact when needed.'
  }
  if (/大战|战场|交战|迎战|包围|全军覆没|冲进|杀出来|斩杀|俘获|奔袭|骑兵/u.test(text)) {
    return 'For battle, show a readable formation scale, cavalry or infantry movement, attack direction, and the changed tactical result. Do not replace the action with a static commander portrait.'
  }
  if (/打伤|动了手|拔刀|冲突/u.test(text)) {
    return 'For confrontation, show the approach, contact geometry, body balance, and the changed result without graphic injury.'
  }
  return ''
}

export function safeStoryboardDescription(value: string | null | undefined): string {
  return String(value || '').replace(VIOLENCE_PATTERN, 'historical turning point')
}

export interface NarrativePanelPromptInput {
  /** 旁白/动作文本（用于证据路线、角色识别、风险标签）。 */
  actionText: string
  /** Panel 的舞台设计（来自 storyboard_panels.description）。 */
  panelDescription?: string | null
  /** Beat 的动作描述（来自 visual_beats.description）。 */
  beatDescription?: string | null
  /** Sequence 标题（来自 narrative_sequences.title）。 */
  sequenceTitle?: string | null
  /** Sequence id / key（用于按序列聚合连续性）。 */
  sequenceId?: string | null
  /** 本集角色表（用于身份连续性）。 */
  characters?: Array<{ name: string | null; appearance: string | null }>
  /** 设计阶段规划的相机角度（eye_level/low_angle/high_angle/over_the_shoulder）。 */
  cameraAngle?: string | null
  /** 设计阶段规划的景别（establishing_wide/wide/full/medium/close/face_closeup/extreme_detail）。 */
  shotSize?: string | null
  /** 设计阶段规划的连续性锚点：本 Sequence 内恒定保留的人物/服装/道具/复现物体。 */
  continuityAnchors?: string[] | null
  /** 设计阶段规划的屏幕方向（left_to_right/right_to_left/static）。 */
  screenDirection?: string | null
  /** 本 Sequence 统一屏幕轴线，用于与上一格衔接时保持不跳轴。 */
  sequenceScreenAxis?: string | null
  /** 连续性参考模式：'image' 用上一格最终图做参考；'written' 仅用文字连续性规则。 */
  referenceMode?: 'image' | 'written'
  /** 上一格最终图本地路径（image 模式下作为参考图）。 */
  referenceImage?: string | null
  /** 安全恢复模式：把暴力/冲突表达改写成非暴力历史转折点。 */
  safetyRecovery?: boolean
  /** 视觉风格指令（来自 buildCompactStyleDirective；未传则用 NARRATIVE_PANEL_STYLE 兜底）。 */
  styleDirective?: string | null
}

/**
 * 构建叙事画格逐 Panel 生图提示词。
 * 与 produce_project8_full_storyboard_finals.mjs 的 buildFinalPrompt 等价，
 * 但角色连续性改从角色表派生，而非硬编码西汉人物。
 */
export const SHOT_SIZE_LABEL: Record<NonNullable<NarrativePanelPromptInput['shotSize']>, string> = {
  establishing_wide: 'establishing wide shot',
  wide: 'wide shot',
  full: 'full shot',
  medium: 'medium shot',
  close: 'close shot',
  face_closeup: 'face close-up',
  extreme_detail: 'extreme detail',
}

export const CAMERA_ANGLE_LABEL: Record<NonNullable<NarrativePanelPromptInput['cameraAngle']>, string> = {
  eye_level: 'eye-level angle',
  low_angle: 'low angle (looking up)',
  high_angle: 'high angle (looking down)',
  over_the_shoulder: 'over-the-shoulder angle',
}

export const SCREEN_DIRECTION_LABEL: Record<NonNullable<NarrativePanelPromptInput['screenDirection']>, string> = {
  left_to_right: 'subject/screen motion flows left to right',
  right_to_left: 'subject/screen motion flows right to left',
  static: 'subject holds position, no screen traverse',
}

/**
 * 把设计阶段规划的相机/轴线/锚点编译成生图提示词里的一段「连续性摄影计划」。
 * 这是叙事画格相对单图合同的核心改进：单图合同每镜独立，跨镜无连续运镜；
 * 叙事画格在 Sequence 内沿一条发展轨道有意变化景别/角度，并守住统一屏幕轴线。
 */
function buildContinuityCameraBlock(input: NarrativePanelPromptInput): string {
  const parts: string[] = []
  if (input.shotSize) parts.push(`Shot size: ${SHOT_SIZE_LABEL[input.shotSize]}.`)
  if (input.cameraAngle) parts.push(`Camera angle: ${CAMERA_ANGLE_LABEL[input.cameraAngle]}.`)
  if (input.screenDirection) parts.push(`Screen direction: ${SCREEN_DIRECTION_LABEL[input.screenDirection]}.`)
  parts.push('This panel is one key pose on a continuous developing camera track for the sequence (establishing → development → turn → landing): keep motion continuous with the neighbouring panels — no holds, no hard cuts, no pose resets, no teleports between panels.')
  if (input.sequenceScreenAxis) {
    parts.push(`Hold one locked screen axis for the whole sequence: ${input.sequenceScreenAxis}. Do not cross the axis between panels; change only by continuous camera movement.`)
  }
  if (input.continuityAnchors?.length) {
    parts.push(`Persistent continuity anchors that MUST stay visually identical across every panel in this sequence: ${input.continuityAnchors.join('; ')}.`)
  }
  return parts.join(' ')
}

export function buildNarrativePanelPrompt(input: NarrativePanelPromptInput): string {
  const {
    actionText,
    panelDescription,
    beatDescription,
    sequenceTitle,
    referenceMode = 'written',
    referenceImage,
    safetyRecovery = false,
  } = input

  const characters = input.characters ?? []
  const action = safetyRecovery
    ? 'Show a nonviolent historical turning point through distance, uninjured witnesses, changing formations, architecture, weather, documents, and symbolic environmental evidence. Preserve the story consequence without depicting confrontation, weapons, injury, death, restraint, or threat.'
    : actionText
  const cameraAndBeat = safetyRecovery
    ? `${safeStoryboardDescription(panelDescription)}; a calm, general-audience historical aftermath composition with the same camera geometry and screen direction.`
    : `${panelDescription || ''}; ${beatDescription || ''}`

  const storyboardInstruction =
    referenceMode === 'image' && referenceImage
      ? `Use the supplied previous panel final image only for ${input.sequenceId || 'this'} sequence's recurring character identity, wardrobe, architecture, palette, and screen direction. Ignore all sketch lines, borders, labels, and paper artifacts.`
      : `Reconstruct this panel's approved staging from the written camera, beat, sequence, character, and action fields below. Preserve the declared camera angle, framing, subject positions, action direction, and major geometry exactly; do not invent a different interpretation.`
  const continuityInstruction =
    referenceMode === 'image' && referenceImage
      ? 'Any supplied previous panel final image controls only recurring character identity, wardrobe, architecture, palette, and screen direction. Do not copy its pose, gaze, action, emotion, injury, or location into this image.'
      : 'Use only the written continuity rules below for recurring identity, wardrobe, architecture, palette, and screen direction. Do not copy a prior beat\'s pose, gaze, action, emotion, injury, or location.'

  const identityLines = relevantIdentitiesFromCharacters(characters, action)
  const cameraPlan = buildContinuityCameraBlock(input)

  return [
    storyboardInstruction,
    continuityInstruction,
    `Narrative action: ${action}`,
    `Storyboard camera and beat: ${cameraAndBeat}`,
    `Sequence context: ${safetyRecovery ? 'historical narrative with a nonviolent general-audience presentation' : sequenceTitle || ''}.`,
    `Relevant character continuity only:\n${identityLines.join('\n')}`,
    safetyRecovery
      ? 'Safety recovery rules: no weapons, combat, injury, dead or unconscious people, physical restraint, threatening gestures, blood, or violent contact. Keep every person visibly safe and uninjured.'
      : visibleActionRequirement(action),
    safetyRecovery ? '' : buildNonGraphicConstraint(panelRiskTags(action)),
    `Continuity camera plan (apply exactly): ${cameraPlan}`,
    input.styleDirective || NARRATIVE_PANEL_STYLE,
    'Historical world: period-credible historical setting. The action must be physically credible and immediately legible without narration.',
    'Composition: one coherent cinematic 16:9 frame, one decisive focus, strong foreground-midground-background depth, readable silhouettes, no split screen, collage, inset, duplicate person, decorative frame, or storyboard layout.',
    'Strict clean image: absolutely no visible text, Chinese characters, Latin letters, numbers, captions, handwriting, signs, logos, signatures, UI, panel headers, borders, or watermark.',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 非图形化约束：当旁白包含遗体/开棺/处决等高风险内容时，要求画面只表现
 * 非图形化的「后果证据」，避免直接渲染遗体或暴力过程。
 */
/**
 * 判断是否需要「安全恢复」模式：当旁白涉及死亡、遗体、开棺、处决、暴力、血、
 * 斩首/尸体等遗体痕迹、经箱/马槽/歌姬等宗教亵渎、裹毯踏杀等高风险内容时，
 * 把画面改写为非暴力历史转折点，避免触发图像供应商的安全拦截（episode 805 实证：
 * 头颅堆塔、倒古兰经当马槽、歌姬入寺、裹毯踏杀、尸横遍野均被 pcore 内容政策拒绝）。
 * 这是叙事画格相对单图合同更稳的一环——单图合同遇到同类旁白往往直接被供应商拒绝。
 */
export function shouldUseSafetyRecovery(text: string): boolean {
  return /死|亡|遗体|遗容|棺|墓|斩|杀|牺牲|战死|阵亡|处决|处死|自刎|自戕|自尽|自杀|血|伤|冲突|攻击|开战|交战|被俘|就义|殉|头颅|头骨|尸体|尸骸|经箱|马槽|歌姬|裹进|亵渎/i.test(text)
}

export function buildNonGraphicConstraint(riskTags: string[]): string {
  if (!riskTags.length) return ''
  const parts: string[] = []
  if (riskTags.includes('covered_aftermath')) {
    parts.push('Show only non-graphic aftermath evidence: abandoned gear, broken standards, retreating distant enemy, empty saddles, or settled dust — never corpses, wounds, bodies, or execution motion.')
  }
  if (riskTags.includes('weapon_contact')) {
    parts.push('Conceal the exact weapon contact; show the result and the changed spatial relationship instead of the impact itself.')
  }
  if (riskTags.includes('covered_injury')) {
    parts.push('Depict injury only as non-graphic consequence: a figure pressing a wrapped arm, a closed door, a dismissed attendant — never open wounds or blood.')
  }
  return parts.join(' ')
}

