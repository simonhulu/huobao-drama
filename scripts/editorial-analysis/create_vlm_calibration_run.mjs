#!/usr/bin/env node

import crypto from 'node:crypto'
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {
  ANNOTATION_SCHEMA_VERSION,
  ANNOTATION_SCHEMA_DIGEST,
  INPUT_SCHEMA_VERSION,
  PROMPT_VERSION,
  REQUEST_SCHEMA_VERSION,
} from './vlm_review.mjs'

const GOLD_SCHEMA_VERSION = 'editorial-vlm-human-gold-v1'
const GOLD_LOCK_SCHEMA_VERSION = 'editorial-vlm-human-gold-lock-v1'
const RUN_SCHEMA_VERSION = 'editorial-vlm-calibration-run-v1'
const RUN_LOCK_SCHEMA_VERSION = 'editorial-vlm-calibration-run-lock-v1'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJsonValue(value[key])]))
}

function stableStringify(value) {
  return JSON.stringify(sortedJsonValue(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true})
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${argument} requires a value`)
      return argv[index]
    }
    if (argument === '--gold') result.goldPath = value()
    else if (argument === '--lock') result.lockPath = value()
    else if (argument === '--input') result.inputPath = value()
    else if (argument === '--cache-root') result.cacheRoot = value()
    else if (argument === '--model') result.model = value()
    else if (argument === '--calibration-id') result.calibrationId = value()
    else if (argument === '--semantic-supplement-sha256') result.semanticSupplementSha256 = value()
    else if (argument === '--output') result.outputPath = value()
    else if (argument === '--lock-output') result.lockOutputPath = value()
    else if (argument === '--help' || argument === '-h') result.help = true
    else throw new Error(`unknown option: ${argument}`)
  }
  return result
}

function usage() {
  return `Usage: node scripts/editorial-analysis/create_vlm_calibration_run.mjs \\
  --gold <human-gold.json> --lock <gold.lock.json> --input <review-input.json> \\
  --cache-root <dry-run-cache> --model <model> --calibration-id <id> \\
  [--semantic-supplement-sha256 <sha256>] --output <run-spec.json> --lock-output <run-lock.json>`
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  for (const key of ['goldPath', 'lockPath', 'inputPath', 'cacheRoot', 'model', 'calibrationId', 'outputPath', 'lockOutputPath']) {
    if (!arguments_[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }

  const [goldBytes, inputBytes, lock] = await Promise.all([
    readFile(arguments_.goldPath),
    readFile(arguments_.inputPath),
    readJson(arguments_.lockPath),
  ])
  if (lock.schemaVersion !== GOLD_LOCK_SCHEMA_VERSION) throw new Error('unsupported human gold lock schema')
  const goldSha256 = sha256(goldBytes)
  const inputSha256 = sha256(inputBytes)
  if (lock.goldSha256 !== goldSha256) throw new Error('human gold hash does not match its immutable lock')
  if (lock.inputSha256 !== inputSha256) throw new Error('review input hash does not match its immutable gold lock')
  const gold = JSON.parse(goldBytes.toString('utf8'))
  const input = JSON.parse(inputBytes.toString('utf8'))
  if (gold.schemaVersion !== GOLD_SCHEMA_VERSION) throw new Error('unsupported human gold schema')
  if (input.schemaVersion !== INPUT_SCHEMA_VERSION) throw new Error('unsupported review input schema')
  if (gold.sourceId !== input.sourceId || gold.input?.sha256 !== inputSha256) {
    throw new Error('human gold and review input identity does not match')
  }

  const sourceDirectory = path.join(path.resolve(arguments_.cacheRoot), input.sourceId)
  const entries = await readdir(sourceDirectory, {withFileTypes: true})
  const candidates = new Map()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const itemDirectory = path.join(sourceDirectory, entry.name)
    let packet
    let meta
    try {
      [packet, meta] = await Promise.all([
        readJson(path.join(itemDirectory, 'request.json')),
        readJson(path.join(itemDirectory, 'meta.json')),
      ])
    } catch {
      continue
    }
    if (meta.status !== 'dry_run' && meta.status !== 'complete') continue
    if (!gold.reviews.some((review) => review.reviewId === meta.reviewId)) continue
    if (packet.schemaVersion !== REQUEST_SCHEMA_VERSION || packet.promptVersion !== PROMPT_VERSION) continue
    if (packet.annotationSchemaVersion !== ANNOTATION_SCHEMA_VERSION || packet.annotationSchemaDigest !== ANNOTATION_SCHEMA_DIGEST) continue
    if (packet.body?.model !== arguments_.model || packet.sourceId !== input.sourceId || packet.reviewId !== meta.reviewId) continue
    if (packet.requestBodyDigest !== sha256(stableStringify(packet.body))) throw new Error(`${meta.reviewId}: request body digest is invalid`)
    if (meta.requestBodyDigest !== packet.requestBodyDigest) throw new Error(`${meta.reviewId}: metadata request body digest does not match packet`)
    if (candidates.has(meta.reviewId)) throw new Error(`multiple cache entries found for ${meta.reviewId}`)
    candidates.set(meta.reviewId, {packet, meta})
  }

  const calibration = {
    model: arguments_.model,
    promptVersion: PROMPT_VERSION,
    annotationSchemaVersion: ANNOTATION_SCHEMA_VERSION,
    annotationSchemaDigest: ANNOTATION_SCHEMA_DIGEST,
    requestContractDigest: null,
  }
  const reviews = []
  for (const expectedReview of gold.reviews) {
    const candidate = candidates.get(expectedReview.reviewId)
    if (!candidate) throw new Error(`missing dry-run cache entry for ${expectedReview.reviewId}`)
    if (!calibration.requestContractDigest) calibration.requestContractDigest = candidate.packet.requestContractDigest
    if (candidate.packet.requestContractDigest !== calibration.requestContractDigest) {
      throw new Error(`${expectedReview.reviewId}: request contract differs across calibration run`)
    }
    reviews.push({
      reviewId: expectedReview.reviewId,
      cacheKey: candidate.packet.cacheKey,
      requestBodyDigest: candidate.packet.requestBodyDigest,
      targetCount: expectedReview.targets.length,
      imageCount: 5 + expectedReview.targets.length * 5,
    })
  }
  const runManifest = {
    schemaVersion: RUN_SCHEMA_VERSION,
    calibrationId: arguments_.calibrationId,
    sourceId: input.sourceId,
    goldSha256,
    inputSha256,
    createdAt: new Date().toISOString(),
    calibration,
    ...(arguments_.semanticSupplementSha256 ? {semanticSupplementSha256: arguments_.semanticSupplementSha256} : {}),
    reviews,
  }
  const runSpecBytes = Buffer.from(`${JSON.stringify(runManifest, null, 2)}\n`)
  await mkdir(path.dirname(path.resolve(arguments_.outputPath)), {recursive: true})
  await writeFile(path.resolve(arguments_.outputPath), runSpecBytes)
  const runSpecSha256 = sha256(runSpecBytes)
  await writeJson(path.resolve(arguments_.lockOutputPath), {
    schemaVersion: RUN_LOCK_SCHEMA_VERSION,
    sourceId: input.sourceId,
    calibrationId: arguments_.calibrationId,
    runSpecSha256,
    frozenAt: new Date().toISOString(),
  })
  process.stdout.write(`${JSON.stringify({runSpec: path.resolve(arguments_.outputPath), runSpecSha256, reviewCount: reviews.length, targetCount: reviews.reduce((sum, review) => sum + review.targetCount, 0)}, null, 2)}\n`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({error: String(error?.message ?? error)})}\n`)
    process.exitCode = 1
  })
}
