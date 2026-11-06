#!/usr/bin/env node

/** Validate the editorial director treatment before storyboard or asset work. */

import fs from 'node:fs'

const args = process.argv.slice(2)
const index = args.indexOf('--file')
if (index < 0 || !args[index + 1]) {
  console.error('Usage: node validate_director_plan.mjs --file <plan.json>')
  process.exit(2)
}

const file = args[index + 1]
let value
try {
  value = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const errors = []
const text = (item) => typeof item === 'string' ? item.replace(/\s+/g, ' ').trim() : ''
const strings = (item) => Array.isArray(item) ? [...new Set(item.map(text).filter(Boolean))] : []
const object = (item) => item && typeof item === 'object' && !Array.isArray(item)
const requireText = (item, label) => {
  if (!text(item)) errors.push(`${label} is required`)
}
const concrete = /(?:打开|推门|开门|关门|落闩|锁门|进入|走入|押|带入|押入|看见|发现|惊恐|后退|倒地|跌坐|跪|蜷缩|展开|翻开|阅读|读|书写|记录|递|交换|抓住|握住|松开|抬手|抬头|低头|伸手|取出|拿起|放下|按|拉|推|转身|离开|回头|观察|凝视|传令|命令|说|喊|哭|分发|减免|盖章|签|open|push|close|lock|enter|escort|see|recoil|fall|kneel|curl|unfold|read|write|hand|grab|hold|release|reach|take|put|press|pull|turn|leave|watch|order|sign|stamp|distribute)/iu
const conceptual = /(?:棋盘|棋子|命运|宿命|历史洪流|权力中心|帝国阴影|抽象空间|左右两半|分屏|象征|隐喻|概念化|站在.*中央|女人站在|展示功过|体现复杂性|代表权力)/iu

if (!object(value)) errors.push('plan must be an object')
if (object(value)) {
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  requireText(value.genre, 'genre')
  requireText(value.format, 'format')
  requireText(value.dramaticQuestion, 'dramaticQuestion')
  requireText(value.thesis, 'thesis')
  if (!object(value.protagonist)) errors.push('protagonist is required')
  else {
    requireText(value.protagonist.name, 'protagonist.name')
    requireText(value.protagonist.arc, 'protagonist.arc')
  }

  const scenes = Array.isArray(value.scenes) ? value.scenes : []
  if (!scenes.length) errors.push('scenes must be non-empty')
  const sceneIds = new Set()
  scenes.forEach((scene, index) => {
    if (!object(scene)) { errors.push(`scenes[${index}] must be an object`); return }
    const id = text(scene.id)
    if (!id) errors.push(`scenes[${index}].id is required`)
    if (sceneIds.has(id)) errors.push(`duplicate scene id ${id}`)
    sceneIds.add(id)
    for (const key of ['location', 'time', 'purpose', 'emotionalTurn', 'conflict', 'anchorAction', 'exitTransition']) requireText(scene[key], `scene ${id}.${key}`)
    if (!strings(scene.characters).length) errors.push(`scene ${id}.characters must be non-empty`)
  })

  const beats = Array.isArray(value.beats) ? value.beats : []
  if (!beats.length) errors.push('beats must be non-empty')
  const beatIds = new Set()
  beats.forEach((beat, index) => {
    if (!object(beat)) { errors.push(`beats[${index}] must be an object`); return }
    const id = text(beat.id)
    if (!id) errors.push(`beats[${index}].id is required`)
    if (beatIds.has(id)) errors.push(`duplicate beat id ${id}`)
    beatIds.add(id)
    const sceneId = text(beat.sceneId)
    if (!sceneIds.has(sceneId)) errors.push(`beat ${id} references unknown scene ${sceneId}`)
    if (!strings(beat.actorIds).length) errors.push(`beat ${id}.actorIds must be non-empty`)
    for (const key of ['target', 'action', 'beforeState', 'afterState', 'result', 'causalReason']) requireText(beat[key], `beat ${id}.${key}`)
    if (text(beat.beforeState) === text(beat.afterState)) errors.push(`beat ${id} beforeState and afterState must differ`)
    if (!concrete.test(text(beat.action))) errors.push(`beat ${id}.action needs an observable verb`)
    if (conceptual.test([beat.action, beat.result, beat.beforeState, beat.afterState].map(text).join(' '))) errors.push(`beat ${id} contains a conceptual visual fallback`)
    if (!strings(beat.visualProof).length) errors.push(`beat ${id}.visualProof must be non-empty`)
    const spans = Array.isArray(beat.sourceSpans) ? beat.sourceSpans : []
    if (!spans.length) errors.push(`beat ${id}.sourceSpans must be non-empty`)
    let previousEnd = -1
    spans.forEach((span, spanIndex) => {
      const start = Number(span?.start)
      const end = Number(span?.end)
      if (!object(span) || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || start < previousEnd || !text(span.text)) {
        errors.push(`beat ${id}.sourceSpans[${spanIndex}] is invalid`)
      }
      previousEnd = end
    })
    if (beat.nextBeatId !== null && beat.nextBeatId !== undefined && !beatIds.has(text(beat.nextBeatId))) {
      // Forward references are allowed; checked after all ids are collected.
    }
    if (!object(beat.shot)) errors.push(`beat ${id}.shot is required`)
    else {
      for (const key of ['shotType', 'angle', 'blocking', 'camera', 'transition']) requireText(beat.shot[key], `beat ${id}.shot.${key}`)
      if (!object(beat.shot.reference)) errors.push(`beat ${id}.shot.reference is required`)
      else for (const key of ['shotCafeQuery', 'flimQuery', 'transferableRule']) requireText(beat.shot.reference[key], `beat ${id}.shot.reference.${key}`)
    }
    if (!['existing-still', 'licensed-stock', 'new-static-image'].includes(text(beat.assetStrategy))) errors.push(`beat ${id}.assetStrategy is invalid`)
  })
  beats.forEach((beat, index) => {
    if (index > 0 && !text(beat.causalReason)) errors.push(`beat ${text(beat.id)} lacks causal handoff`)
    if (beat.nextBeatId !== null && beat.nextBeatId !== undefined && !beatIds.has(text(beat.nextBeatId))) errors.push(`beat ${text(beat.id)} references unknown nextBeatId ${text(beat.nextBeatId)}`)
  })

  if (!object(value.visualRules)) errors.push('visualRules is required')
  else {
    if (!strings(value.visualRules.continuityAnchors).length) errors.push('visualRules.continuityAnchors must be non-empty')
    if (!strings(value.visualRules.forbiddenPatterns).length) errors.push('visualRules.forbiddenPatterns must be non-empty')
    requireText(value.visualRules.periodAndStyle, 'visualRules.periodAndStyle')
  }
}

if (errors.length) {
  console.error(JSON.stringify({ valid: false, errors }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ valid: true, genre: value.genre, scenes: value.scenes.length, beats: value.beats.length }, null, 2))
