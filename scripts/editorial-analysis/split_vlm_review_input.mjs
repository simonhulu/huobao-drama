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
  return 'Usage: node scripts/editorial-analysis/split_vlm_review_input.mjs --input <review-input.json> --output <split-input.json>'
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (!arguments_.inputPath || !arguments_.outputPath) throw new Error('--input and --output are required')
  const inputPath = path.resolve(arguments_.inputPath)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const inputDirectory = path.dirname(inputPath)
  const reviews = []
  for (const review of input.reviews) {
    for (const target of review.targets) {
      const splitReview = structuredClone(review)
      splitReview.id = `${review.id}--${target.targetRef.id}`
      splitReview.targets = [target]
      const candidateIds = new Set(target.targetRef.candidateIds)
      splitReview.machineEvidence = {
        ...splitReview.machineEvidence,
        candidateIds: splitReview.machineEvidence.candidateIds.filter((candidateId) => candidateIds.has(candidateId)),
        candidates: splitReview.machineEvidence.candidates.filter((candidate) => candidateIds.has(candidate.id)),
      }
      splitReview.overview.imagePaths = splitReview.overview.imagePaths.map((filePath) => path.resolve(inputDirectory, filePath))
      splitReview.targets[0].microSequence.imagePaths = splitReview.targets[0].microSequence.imagePaths
        .map((filePath) => path.resolve(inputDirectory, filePath))
      reviews.push(splitReview)
    }
  }
  const output = {
    schemaVersion: input.schemaVersion,
    sourceId: input.sourceId,
    reviewPlanDigest: input.reviewPlanDigest,
    reviews,
  }
  await writeFile(path.resolve(arguments_.outputPath), `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({sourceId: output.sourceId, reviewCount: reviews.length, targetCount: reviews.length, output: path.resolve(arguments_.outputPath)}, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({error: String(error?.message ?? error)})}\n`)
    process.exitCode = 1
  })
}
