export type StoryFunction = 'event' | 'causal' | 'reveal' | 'character' | 'context' | 'establishing' | 'spatial_flow' | 'network'

export type StorySourceSpan = {
  start: number
  end: number
  text?: string
}

export type StoryContract = {
  beatId: string
  sourceSpans: StorySourceSpan[]
  function: StoryFunction
  actorIds: string[]
  actorMode?: 'person' | 'group' | 'none'
  target?: string
  propIds?: string[]
  action: string
  phase: 'observe' | 'approach' | 'execute' | 'consequence' | 'react'
  beforeState?: string
  afterState?: string
  visualProof: string[]
  nextBeatId?: string | null
  whyNoActor?: string
  assetSemantics?: string[]
}

const STORY_FUNCTIONS: StoryFunction[] = ['event', 'causal', 'reveal', 'character', 'context', 'establishing', 'spatial_flow', 'network']
const STORY_PHASES: StoryContract['phase'][] = ['observe', 'approach', 'execute', 'consequence', 'react']
const ACTOR_MODES: NonNullable<StoryContract['actorMode']>[] = ['person', 'group', 'none']

// These are renderer directions, not events. A clause containing one of them
// is only acceptable when it also contains a concrete action (for example,
// "停住后签字"), otherwise it creates a layer-filling shot with no story beat.
const GENERIC_ACTION_FRAGMENT = /站着|站立|停住|保持静止|呼吸(?:缩放)?|进入房间|走入房间|指向画外|与留白同框|脸部反应|建立人物|表现工业规模|持续运动|节点、路线和标签按叙述顺序出现/iu
const CONCRETE_ACTION = /签|交换|递|拿|写|记账|记录|打开|关闭|走向|奔向|追|抓|击|打|推|拉|谈|说|喊|宣布|拒绝|同意|购买|出售|控制|合并|垄断|运输|收购|起诉|逮捕|投票|倒下|死亡|出生|拆分|迁移|集结|举起|交给|取出|翻开|握住|落下|砍|燃烧|爆炸|碰撞|转身|回头|抬头|低头|凝视|离开|返回|营救|签下|建立(?:公司|关系|制度|网络)/u
const GENERIC_PROOF = /^(?:环境|场景|氛围|空镜|建立(?:场景|人物)?|表现规模|人物出现|镜头推进|光影(?:变化)?|画面展示|与留白同框|持续运动)[。；，,.!?！？、\s]*$/iu
const PLACEHOLDER_STATE = /^(?:无变化|没有变化|未变化|不变|保持不变|保持原状|同上|暂无变化|未知|待定)[。；，,.!?！？、\s]*$/iu

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(clean).filter(Boolean))]
}

function visualActorRefs(visualPlan: Record<string, unknown>): { ids: Set<string>; names: Set<string> } {
  const ids = new Set<string>()
  const names = new Set<string>()
  const add = (raw: unknown) => {
    if (typeof raw === 'string') {
      const value = clean(raw)
      if (value) ids.add(value)
      return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const item = raw as Record<string, unknown>
    const actorId = clean(item.actorId || item.characterId)
    const id = clean(item.id)
    const name = clean(item.name || item.person || item.character)
    if (actorId) ids.add(actorId)
    // `id` is a valid actor reference only when the layer explicitly marks it
    // as an actor. Asset keys and setup ids otherwise create false positives.
    if (id && (item.layerType === 'character-alpha' || item.role === 'character' || item.type === 'character')) ids.add(id)
    if (name) names.add(name)
  }
  for (const key of ['actorIds', 'characters', 'layers', 'foregroundLayers']) {
    const values = visualPlan[key]
    if (Array.isArray(values)) values.forEach(add)
  }
  return { ids, names }
}

function actionIsGeneric(action: string): boolean {
  const normalized = action.replace(/\s+/g, ' ').trim()
  if (!normalized) return true
  // Reject a generic direction even when the model decorates it with a name
  // or a cinematography note. Concrete verbs keep an event clause admissible.
  return GENERIC_ACTION_FRAGMENT.test(normalized) && !CONCRETE_ACTION.test(normalized)
}

export function validateStoryContract(story: unknown, visualPlan?: unknown): StoryContract {
  if (!story || typeof story !== 'object' || Array.isArray(story)) {
    throw new Error('story contract is required')
  }
  const value = story as Record<string, unknown>
  const beatId = clean(value.beatId)
  if (!beatId) throw new Error('story.beatId is required')

  const spans = Array.isArray(value.sourceSpans) ? value.sourceSpans : []
  if (!spans.length) throw new Error(`story ${beatId} requires sourceSpans`)
  let previousEnd = -1
  for (const span of spans) {
    if (!span || typeof span !== 'object' || Array.isArray(span)) throw new Error(`story ${beatId} has invalid sourceSpan`)
    const item = span as Record<string, unknown>
    const start = Number(item.start)
    const end = Number(item.end)
    const spanText = clean(item.text)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || !spanText) {
      throw new Error(`story ${beatId} sourceSpans must be ordered character ranges`)
    }
    if (spanText.length > end - start) {
      throw new Error(`story ${beatId} sourceSpan text exceeds its character range`)
    }
    if (start < previousEnd) throw new Error(`story ${beatId} sourceSpans overlap or are out of order`)
    previousEnd = end
  }

  const storyFunction = clean(value.function) as StoryFunction
  if (!STORY_FUNCTIONS.includes(storyFunction)) throw new Error(`story ${beatId} has invalid function`)

  const actorIds = uniqueStrings(value.actorIds)
  if (actorIds.length !== (Array.isArray(value.actorIds) ? value.actorIds.length : 0)) {
    throw new Error(`story ${beatId} actorIds must be non-empty strings without duplicates`)
  }
  const actorModeValue = clean(value.actorMode)
  if (actorModeValue && !ACTOR_MODES.includes(actorModeValue as NonNullable<StoryContract['actorMode']>)) {
    throw new Error(`story ${beatId} has invalid actorMode`)
  }
  const actorMode = actorModeValue as StoryContract['actorMode'] | ''
  if (actorMode === 'none' && actorIds.length) throw new Error(`story ${beatId} actorMode none cannot declare actorIds`)
  if (actorMode === 'person' && actorIds.length === 0) throw new Error(`story ${beatId} actorMode person requires actorIds`)
  const action = clean(value.action)
  if (!action) throw new Error(`story ${beatId} requires action`)
  if (actionIsGeneric(action)) throw new Error(`story ${beatId} action is a generic pose, not a story event`)

  const proof = uniqueStrings(value.visualProof)
  if (!proof.length) throw new Error(`story ${beatId} requires visualProof`)
  if (proof.every((item) => GENERIC_PROOF.test(item))) {
    throw new Error(`story ${beatId} visualProof must show a concrete story consequence`)
  }

  const target = clean(value.target)
  const beforeState = clean(value.beforeState)
  const afterState = clean(value.afterState)
  const whyNoActor = clean(value.whyNoActor)
  // Spatial/network diagrams can be story evidence without a human on screen;
  // they still need an explicit reason so they cannot silently become filler.
  const isContext = storyFunction === 'context'
    || storyFunction === 'establishing'
    || storyFunction === 'spatial_flow'
    || storyFunction === 'network'
  if (!isContext && actorIds.length === 0) {
    throw new Error(`story ${beatId} requires actorIds for ${storyFunction} shots`)
  }
  if (isContext && actorIds.length === 0 && !whyNoActor) {
    throw new Error(`story ${beatId} context shot requires whyNoActor`)
  }
  if (storyFunction === 'event' || storyFunction === 'causal' || storyFunction === 'reveal') {
    if (!target) throw new Error(`story ${beatId} event shot requires target`)
    if (!beforeState || !afterState || beforeState === afterState || PLACEHOLDER_STATE.test(beforeState) || PLACEHOLDER_STATE.test(afterState)) {
      throw new Error(`story ${beatId} event shot requires a beforeState/afterState change`)
    }
  }
  if (visualPlan && typeof visualPlan === 'object' && !Array.isArray(visualPlan)) {
    const plan = visualPlan as Record<string, unknown>
    const refs = visualActorRefs(plan)
    if (actorIds.length) {
      const missing = actorIds.filter((actorId) => !refs.ids.has(actorId) && !refs.names.has(actorId))
      if (missing.length) {
        throw new Error(`story ${beatId} actorIds are not represented by visualPlan.characters: ${missing.join(', ')}`)
      }
    }
    const assetSemantics = uniqueStrings(value.assetSemantics)
    const hasAssetBackedVisual = ['map', 'stock'].some((key) => {
      const item = plan[key]
      return item && typeof item === 'object' && !Array.isArray(item)
    })
    if (hasAssetBackedVisual && !assetSemantics.length) {
      throw new Error(`story ${beatId} map/stock visual requires assetSemantics`)
    }
  }

  const propIds = uniqueStrings(value.propIds)
  if (Array.isArray(value.propIds) && propIds.length !== value.propIds.length) {
    throw new Error(`story ${beatId} propIds must be non-empty strings without duplicates`)
  }
  const phaseValue = clean(value.phase)
  if (!STORY_PHASES.includes(phaseValue as StoryContract['phase'])) {
    throw new Error(`story ${beatId} has invalid phase`)
  }

  return {
    beatId,
    sourceSpans: spans.map((span) => {
      const item = span as Record<string, unknown>
      return { start: Number(item.start), end: Number(item.end), text: clean(item.text) }
    }),
    function: storyFunction,
    actorIds,
    actorMode: actorMode || undefined,
    target: target || undefined,
    propIds,
    action,
    phase: phaseValue as StoryContract['phase'],
    beforeState: beforeState || undefined,
    afterState: afterState || undefined,
    visualProof: proof,
    nextBeatId: value.nextBeatId == null ? null : clean(value.nextBeatId) || null,
    whyNoActor: whyNoActor || undefined,
    assetSemantics: isNonEmptyArray(value.assetSemantics) ? value.assetSemantics.map(clean).filter(Boolean) : [],
  }
}

export function storyContractFromPlan(visualPlan: unknown): StoryContract | null {
  if (!visualPlan || typeof visualPlan !== 'object' || Array.isArray(visualPlan)) return null
  const story = (visualPlan as Record<string, unknown>).story
  if (!story) return null
  return validateStoryContract(story, visualPlan)
}
