#!/usr/bin/env node

import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--input') {
      index += 1
      result.inputPath = argv[index]
    } else if (argument === '--gold') {
      index += 1
      result.goldPath = argv[index]
    } else if (argument === '--output') {
      index += 1
      result.outputPath = argv[index]
    } else if (argument === '--help' || argument === '-h') {
      result.help = true
    } else {
      throw new Error(`unknown option: ${argument}`)
    }
  }
  return result
}

function usage() {
  return 'Usage: node scripts/editorial-analysis/select_vlm_calibration_targets.mjs --input <split-input.json> --gold <human-gold.json> --output <selected-input.json>'
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  for (const key of ['inputPath', 'goldPath', 'outputPath']) {
    if (!arguments_[key]) throw new Error(`--${key} is required`)
  }

  const [input, gold] = await Promise.all([
    readFile(path.resolve(arguments_.inputPath), 'utf8').then(JSON.parse),
    readFile(path.resolve(arguments_.goldPath), 'utf8').then(JSON.parse),
  ])
  if (!Array.isArray(input.reviews)) throw new Error('split input reviews must be an array')
  if (!Array.isArray(gold.reviews)) throw new Error('human gold reviews must be an array')

  const candidates = new Map()
  for (const review of input.reviews) {
    if (!review || !Array.isArray(review.targets) || review.targets.length !== 1) {
      throw new Error(`split review ${review?.id ?? '<unknown>'} must contain exactly one target`)
    }
    const targetId = review.targets[0]?.targetRef?.id
    if (typeof targetId !== 'string' || !targetId) throw new Error(`split review ${review.id} has an invalid target id`)
    if (candidates.has(targetId)) throw new Error(`duplicate split target ${targetId}`)
    candidates.set(targetId, review)
  }

  const selected = []
  const selectedTargetIds = new Set()
  for (const goldReview of gold.reviews) {
    if (!goldReview || typeof goldReview.reviewId !== 'string') throw new Error('human gold reviewId is invalid')
    for (const goldTarget of goldReview.targets ?? []) {
      const targetId = goldTarget?.targetId
      if (typeof targetId !== 'string' || !targetId) throw new Error(`human gold target id is invalid in ${goldReview.reviewId}`)
      const review = candidates.get(targetId)
      if (!review) throw new Error(`human gold target ${targetId} is missing from split input`)
      const expectedId = `${goldReview.reviewId}--${targetId}`
      if (review.id !== expectedId) {
        throw new Error(`${targetId}: split review id must be ${expectedId}; received ${review.id}`)
      }
      selected.push(review)
      selectedTargetIds.add(targetId)
    }
  }

  if (selectedTargetIds.size !== selected.length) throw new Error('selected calibration targets are not unique')
  const output = {
    schemaVersion: input.schemaVersion,
    sourceId: input.sourceId,
    reviewPlanDigest: input.reviewPlanDigest,
    reviews: selected,
  }
  const outputPath = path.resolve(arguments_.outputPath)
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({sourceId: output.sourceId, reviewCount: output.reviews.length, targetCount: selected.length, output: outputPath}, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({error: String(error?.message ?? error)})}\n`)
    process.exitCode = 1
  })
}

