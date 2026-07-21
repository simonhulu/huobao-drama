/**
 * Director treatment contract shared by the storyboard agent and the
 * Remotion factory. This is editorial metadata, not a renderer instruction.
 */

export type DirectorPlan = {
  schemaVersion: 1
  genre: string
  format: string
  protagonist: {
    id?: string
    name: string
    arc: string
  }
  dramaticQuestion: string
  thesis: string
  scenes: Array<{
    id: string
    location: string
    time: string
    purpose: string
    emotionalTurn: string
    characters: string[]
    conflict: string
    anchorAction: string
    exitTransition: string
  }>
  beats: Array<{
    id: string
    sceneId: string
    sourceSpans: Array<{ start: number; end: number; text: string }>
    function: 'hook' | 'event' | 'reveal' | 'consequence' | 'context' | 'transition'
    actorIds: string[]
    target: string
    action: string
    beforeState: string
    afterState: string
    result: string
    visualProof: string[]
    causalReason: string
    nextBeatId: string | null
    shot: {
      shotType: string
      angle: string
      blocking: string
      camera: string
      transition: string
      reference: {
        shotCafeQuery: string
        flimQuery: string
        transferableRule: string
      }
    }
    assetStrategy: 'existing-still' | 'licensed-stock' | 'new-static-image'
    illustrative?: boolean
  }>
  visualRules: {
    continuityAnchors: string[]
    forbiddenPatterns: string[]
    periodAndStyle: string
  }
}

const CONCRETE_ACTION = /(?:打开|推门|开门|关门|落闩|锁门|进入|走入|押|带入|押入|看见|发现|惊恐|后退|倒地|跌坐|跪|蜷缩|展开|翻开|阅读|读|书写|记录|递|交换|抓住|握住|松开|抬手|抬头|低头|伸手|取出|拿起|放下|按|拉|推|转身|离开|回头|观察|凝视|传令|命令|说|喊|哭|燃烧|砍|追|挡|分发|减免|盖章|签|open|push|close|lock|enter|escort|see|recoil|fall|kneel|curl|unfold|read|write|hand|grab|hold|release|reach|take|put|press|pull|turn|leave|watch|order|sign|stamp|distribute)/iu
const ABSTRACT_PATTERN = /(?:棋盘|棋子|命运|宿命|历史洪流|权力中心|帝国阴影|抽象空间|左右两半|分屏|象征|隐喻|概念化|站在.*中央|女人站在|展示功过|体现复杂性|代表权力)/iu

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : []
}

function fail(message: string): never {
  throw new Error(`director plan: ${message}`)
}

function requireText(value: unknown, field: string): string {
  const result = text(value)
  if (!result) fail(`${field} is required`)
  return result
}

function sourceSpans(value: unknown, beatId: string) {
  if (!Array.isArray(value) || value.length === 0) fail(`beat ${beatId} requires sourceSpans`)
  let previousEnd = -1
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`beat ${beatId} sourceSpans[${index}] is invalid`)
    const item = raw as Record<string, unknown>
    const start = Number(item.start)
    const end = Number(item.end)
    const spanText = requireText(item.text, `beat ${beatId} sourceSpans[${index}].text`)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || start < previousEnd) {
      fail(`beat ${beatId} sourceSpans must be ordered integer ranges`)
    }
    if (spanText.length > end - start) fail(`beat ${beatId} sourceSpans[${index}] text exceeds range`)
    previousEnd = end
    return { start, end, text: spanText }
  })
}

export function validateDirectorPlan(input: unknown): DirectorPlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('payload must be an object')
  const value = input as Record<string, unknown>
  if (Number(value.schemaVersion) !== 1) fail('schemaVersion must be 1')
  const genre = requireText(value.genre, 'genre')
  const format = requireText(value.format, 'format')
  const protagonistValue = value.protagonist
  if (!protagonistValue || typeof protagonistValue !== 'object' || Array.isArray(protagonistValue)) fail('protagonist is required')
  const protagonist = protagonistValue as Record<string, unknown>
  const protagonistName = requireText(protagonist.name, 'protagonist.name')
  const protagonistArc = requireText(protagonist.arc, 'protagonist.arc')
  const dramaticQuestion = requireText(value.dramaticQuestion, 'dramaticQuestion')
  const thesis = requireText(value.thesis, 'thesis')

  if (!Array.isArray(value.scenes) || value.scenes.length === 0) fail('scenes must be non-empty')
  const sceneIds = new Set<string>()
  const scenes = value.scenes.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`scenes[${index}] is invalid`)
    const item = raw as Record<string, unknown>
    const id = requireText(item.id, `scenes[${index}].id`)
    if (sceneIds.has(id)) fail(`duplicate scene id ${id}`)
    sceneIds.add(id)
    const characters = strings(item.characters)
    if (!characters.length) fail(`scene ${id} requires characters`)
    return {
      id,
      location: requireText(item.location, `scene ${id}.location`),
      time: requireText(item.time, `scene ${id}.time`),
      purpose: requireText(item.purpose, `scene ${id}.purpose`),
      emotionalTurn: requireText(item.emotionalTurn, `scene ${id}.emotionalTurn`),
      characters,
      conflict: requireText(item.conflict, `scene ${id}.conflict`),
      anchorAction: requireText(item.anchorAction, `scene ${id}.anchorAction`),
      exitTransition: requireText(item.exitTransition, `scene ${id}.exitTransition`),
    }
  })

  if (!Array.isArray(value.beats) || value.beats.length === 0) fail('beats must be non-empty')
  const beatIds = new Set<string>()
  const beats = value.beats.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`beats[${index}] is invalid`)
    const item = raw as Record<string, unknown>
    const id = requireText(item.id, `beats[${index}].id`)
    if (beatIds.has(id)) fail(`duplicate beat id ${id}`)
    beatIds.add(id)
    const sceneId = requireText(item.sceneId, `beat ${id}.sceneId`)
    if (!sceneIds.has(sceneId)) fail(`beat ${id} references unknown scene ${sceneId}`)
    const actorIds = strings(item.actorIds)
    if (!actorIds.length) fail(`beat ${id} requires actorIds`)
    const action = requireText(item.action, `beat ${id}.action`)
    const result = requireText(item.result, `beat ${id}.result`)
    const beforeState = requireText(item.beforeState, `beat ${id}.beforeState`)
    const afterState = requireText(item.afterState, `beat ${id}.afterState`)
    if (beforeState === afterState) fail(`beat ${id} beforeState and afterState must differ`)
    if (!CONCRETE_ACTION.test(action)) fail(`beat ${id}.action needs a concrete observable verb`)
    const visibleText = [action, result, beforeState, afterState].join(' ')
    if (ABSTRACT_PATTERN.test(visibleText)) fail(`beat ${id} contains a conceptual visual fallback`)
    const visualProof = strings(item.visualProof)
    if (!visualProof.length) fail(`beat ${id} requires visualProof`)
    const causalReason = requireText(item.causalReason, `beat ${id}.causalReason`)
    const shotValue = item.shot
    if (!shotValue || typeof shotValue !== 'object' || Array.isArray(shotValue)) fail(`beat ${id}.shot is required`)
    const shot = shotValue as Record<string, unknown>
    const referenceValue = shot.reference
    if (!referenceValue || typeof referenceValue !== 'object' || Array.isArray(referenceValue)) fail(`beat ${id}.shot.reference is required`)
    const reference = referenceValue as Record<string, unknown>
    const assetStrategy = requireText(item.assetStrategy, `beat ${id}.assetStrategy`) as DirectorPlan['beats'][number]['assetStrategy']
    if (!['existing-still', 'licensed-stock', 'new-static-image'].includes(assetStrategy)) fail(`beat ${id}.assetStrategy is invalid`)
    return {
      id,
      sceneId,
      sourceSpans: sourceSpans(item.sourceSpans, id),
      function: requireText(item.function, `beat ${id}.function`) as DirectorPlan['beats'][number]['function'],
      actorIds,
      target: requireText(item.target, `beat ${id}.target`),
      action,
      beforeState,
      afterState,
      result,
      visualProof,
      causalReason,
      nextBeatId: item.nextBeatId == null ? null : requireText(item.nextBeatId, `beat ${id}.nextBeatId`),
      shot: {
        shotType: requireText(shot.shotType, `beat ${id}.shot.shotType`),
        angle: requireText(shot.angle, `beat ${id}.shot.angle`),
        blocking: requireText(shot.blocking, `beat ${id}.shot.blocking`),
        camera: requireText(shot.camera, `beat ${id}.shot.camera`),
        transition: requireText(shot.transition, `beat ${id}.shot.transition`),
        reference: {
          shotCafeQuery: requireText(reference.shotCafeQuery, `beat ${id}.shot.reference.shotCafeQuery`),
          flimQuery: requireText(reference.flimQuery, `beat ${id}.shot.reference.flimQuery`),
          transferableRule: requireText(reference.transferableRule, `beat ${id}.shot.reference.transferableRule`),
        },
      },
      assetStrategy,
      ...(item.illustrative === true ? { illustrative: true } : {}),
    }
  })

  beats.forEach((beat, index) => {
    if (index > 0 && !beat.causalReason.trim()) fail(`beat ${beat.id} must explain its causal handoff`)
    if (beat.nextBeatId !== null && !beatIds.has(beat.nextBeatId)) fail(`beat ${beat.id} references unknown nextBeatId ${beat.nextBeatId}`)
  })

  const rulesValue = value.visualRules
  if (!rulesValue || typeof rulesValue !== 'object' || Array.isArray(rulesValue)) fail('visualRules is required')
  const rules = rulesValue as Record<string, unknown>
  const continuityAnchors = strings(rules.continuityAnchors)
  const forbiddenPatterns = strings(rules.forbiddenPatterns)
  if (!continuityAnchors.length || !forbiddenPatterns.length) fail('visualRules requires continuityAnchors and forbiddenPatterns')
  return {
    schemaVersion: 1,
    genre,
    format,
    protagonist: { id: text(protagonist.id) || undefined, name: protagonistName, arc: protagonistArc },
    dramaticQuestion,
    thesis,
    scenes,
    beats,
    visualRules: {
      continuityAnchors,
      forbiddenPatterns,
      periodAndStyle: requireText(rules.periodAndStyle, 'visualRules.periodAndStyle'),
    },
  }
}
