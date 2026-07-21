#!/usr/bin/env node

import crypto from 'node:crypto'
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {
  ANNOTATION_SCHEMA_VERSION,
  PROMPT_VERSION,
  REQUEST_SCHEMA_VERSION,
  annotationValidationOptions,
  readValidCachedEvidence,
  validateAnnotation,
} from './vlm_review.mjs'

const CACHE_META_SCHEMA_VERSION = 'editorial-vlm-cache-meta-v3'

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

function jsonDigest(value) {
  return sha256(stableStringify(value))
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
    if (argument === '--input') result.inputPath = value()
    else if (argument === '--target-input') result.targetInputPath = value()
    else if (argument === '--gold') result.goldPath = value()
    else if (argument === '--run-spec') result.runSpecPath = value()
    else if (argument === '--base-cache-root') result.baseCacheRoot = value()
    else if (argument === '--target-cache-root') result.targetCacheRoot = value()
    else if (argument === '--output-cache-root') result.outputCacheRoot = value()
    else if (argument === '--model') result.model = value()
    else if (argument === '--help' || argument === '-h') result.help = true
    else throw new Error(`unknown option: ${argument}`)
  }
  return result
}

function usage() {
  return `Usage: node scripts/editorial-analysis/merge_vlm_target_cache.mjs \\
  --input <full-review-input.json> --target-input <selected-target-input.json> \\
  --gold <human-gold.json> --run-spec <calibration-run.json> \\
  --base-cache-root <existing-batch-cache> --target-cache-root <target-cache> \\
  --output-cache-root <merged-cache> --model <model>`
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true})
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function findCompleteTargetCaches(targetCacheRoot, sourceId, targetReviews, model) {
  const sourceDirectory = path.join(path.resolve(targetCacheRoot), sourceId)
  const entries = await readdir(sourceDirectory, {withFileTypes: true})
  const byReviewId = new Map()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const itemDirectory = path.join(sourceDirectory, entry.name)
    let meta
    let packet
    try {
      [meta, packet] = await Promise.all([
        readJson(path.join(itemDirectory, 'meta.json')),
        readJson(path.join(itemDirectory, 'request.json')),
      ])
    } catch {
      continue
    }
    if (meta?.status !== 'complete' || packet?.schemaVersion !== REQUEST_SCHEMA_VERSION) continue
    if (meta.reviewId !== packet.reviewId || packet.sourceId !== sourceId || packet.body?.model !== model) continue
    if (!targetReviews.has(packet.reviewId)) continue
    if (byReviewId.has(packet.reviewId)) throw new Error(`multiple complete target caches found for ${packet.reviewId}`)
    byReviewId.set(packet.reviewId, {itemDirectory, packet, meta})
  }
  for (const review of targetReviews.values()) {
    if (!byReviewId.has(review.id)) throw new Error(`missing complete target cache for ${review.id}`)
  }
  return byReviewId
}

function dedupe(values, key = stableStringify) {
  const seen = new Set()
  const output = []
  for (const value of values) {
    const digest = key(value)
    if (seen.has(digest)) continue
    seen.add(digest)
    output.push(value)
  }
  return output
}

function mergeUnitEvidence(annotations) {
  const first = annotations[0]
  const layers = dedupe(annotations.flatMap((annotation) => annotation.unitEvidence.layers), (layer) => stableStringify([
    layer.layerType,
    layer.depth,
    layer.description.toLowerCase().replace(/\s+/g, ' ').trim(),
  ]))
  const texts = dedupe(annotations.flatMap((annotation) => annotation.unitEvidence.texts), (item) => stableStringify([
    item.visibleText.toLowerCase().replace(/\s+/g, ' ').trim(),
  ]))
  const cameraContexts = dedupe(annotations.flatMap((annotation) => annotation.unitEvidence.cameraContexts), (context) => stableStringify([
    context.basis,
    context.shotScale,
    context.observedOverviewSampleIndices,
  ])).slice(0, 5)
  if (layers.length > 24 || texts.length > 24) {
    throw new Error(`merged unit evidence exceeds schema limits: layers=${layers.length}, texts=${texts.length}`)
  }
  return {layers, texts, cameraContexts}
}

function mergeAnnotations(fullReview, targetAnnotations) {
  const annotations = [...targetAnnotations.values()]
  if (annotations.length !== fullReview.targets.length) {
    throw new Error(`${fullReview.id}: target annotation count does not match full review`)
  }
  const targetObservations = fullReview.targets.map((target) => {
    const targetId = target.targetRef.id
    const annotation = targetAnnotations.get(targetId)
    if (!annotation) throw new Error(`${fullReview.id}: missing target annotation ${targetId}`)
    const observation = annotation.targetObservations?.[0]
    if (!observation || observation.targetId !== targetId) throw new Error(`${targetId}: target annotation order is invalid`)
    return observation
  })
  const definiteBoundaryIntervals = fullReview.targets
    .map((target, index) => ({
      intervalIndex: target.intervalRef.intervalIndex,
      editClass: targetObservations[index].localDelta.editClass,
    }))
    .filter(({editClass}) => new Set(['hard_cut', 'dissolve', 'fade_to_black', 'fade_from_black', 'wipe', 'flash', 'graphic_transition', 'match_transition', 'matte_transition', 'blur_bridge', 'distortion']).has(editClass))
  const continuousTracks = dedupe(annotations.flatMap((annotation) => annotation.continuousTracks))
    .filter((track) => !definiteBoundaryIntervals.some(({intervalIndex}) => (
      track.startSampleIndex <= intervalIndex && intervalIndex < track.endSampleIndex
    )))
  if (continuousTracks.length > 12) throw new Error(`${fullReview.id}: merged continuousTracks exceeds schema limit`)
  const reviewNotes = dedupe(annotations.flatMap((annotation) => annotation.reviewNotes)).slice(0, 12)
  const average = (field) => annotations.reduce((sum, annotation) => sum + annotation.confidence[field], 0) / annotations.length
  return {
    targetObservations,
    continuousTracks,
    unitEvidence: mergeUnitEvidence(annotations),
    reviewNotes,
    confidence: {
      overall: average('overall'),
      unitEvidence: average('unitEvidence'),
      continuousTracks: average('continuousTracks'),
    },
  }
}

async function readValidatedTargetAnnotation(item, targetReview) {
  const validResponse = await readValidCachedEvidence(item.itemDirectory, item.packet, targetReview)
  if (!validResponse) throw new Error(`${targetReview.id}: target cache evidence bundle is invalid`)
  const annotation = await readJson(path.join(item.itemDirectory, 'model-annotation.json'))
  const validation = validateAnnotation(annotation, annotationValidationOptions(targetReview, item.packet))
  if (!validation.ok) throw new Error(`${targetReview.id}: target annotation is invalid: ${validation.errors.join('; ')}`)
  return annotation
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  for (const key of ['inputPath', 'targetInputPath', 'goldPath', 'runSpecPath', 'baseCacheRoot', 'targetCacheRoot', 'outputCacheRoot', 'model']) {
    if (!arguments_[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }

  const [input, targetInput, gold, runSpec] = await Promise.all([
    readJson(path.resolve(arguments_.inputPath)),
    readJson(path.resolve(arguments_.targetInputPath)),
    readJson(path.resolve(arguments_.goldPath)),
    readJson(path.resolve(arguments_.runSpecPath)),
  ])
  if (input.sourceId !== targetInput.sourceId || input.sourceId !== runSpec.sourceId || input.sourceId !== gold.sourceId) {
    throw new Error('input, target input, gold, and run spec sourceId values must match')
  }
  if (input.reviewPlanDigest !== targetInput.reviewPlanDigest) throw new Error('target input reviewPlanDigest does not match full input')

  const fullReviews = new Map(input.reviews.map((review) => [review.id, review]))
  const targetReviews = new Map(targetInput.reviews.map((review) => [review.id, review]))
  const targetCaches = await findCompleteTargetCaches(arguments_.targetCacheRoot, input.sourceId, targetReviews, arguments_.model)
  const goldReviewIds = new Set(gold.reviews.map((review) => review.reviewId))
  if (runSpec.reviews.length !== gold.reviews.length) throw new Error('run spec review count does not match gold')

  const outputRoot = path.resolve(arguments_.outputCacheRoot)
  const sourceOutputDirectory = path.join(outputRoot, input.sourceId)
  const manifest = {
    schemaVersion: 'editorial-vlm-target-cache-merge-v1',
    sourceId: input.sourceId,
    model: arguments_.model,
    fullInput: path.resolve(arguments_.inputPath),
    targetInput: path.resolve(arguments_.targetInputPath),
    baseCacheRoot: path.resolve(arguments_.baseCacheRoot),
    targetCacheRoot: path.resolve(arguments_.targetCacheRoot),
    runSpec: path.resolve(arguments_.runSpecPath),
    reviews: [],
  }

  for (const runItem of runSpec.reviews) {
    if (!goldReviewIds.has(runItem.reviewId)) throw new Error(`run spec references non-gold review ${runItem.reviewId}`)
    const fullReview = fullReviews.get(runItem.reviewId)
    if (!fullReview) throw new Error(`full input is missing ${runItem.reviewId}`)
    const baseItemDirectory = path.join(path.resolve(arguments_.baseCacheRoot), input.sourceId, runItem.cacheKey)
    const basePacket = await readJson(path.join(baseItemDirectory, 'request.json'))
    const baseMeta = await readJson(path.join(baseItemDirectory, 'meta.json'))
    if (baseMeta.status !== 'complete' || basePacket.reviewId !== runItem.reviewId || basePacket.cacheKey !== runItem.cacheKey) {
      throw new Error(`${runItem.reviewId}: base cache does not match run spec`)
    }
    if (basePacket.body?.model !== arguments_.model || basePacket.promptVersion !== PROMPT_VERSION) {
      throw new Error(`${runItem.reviewId}: base cache model or prompt version does not match merge contract`)
    }

    const targetAnnotations = new Map()
    for (const target of fullReview.targets) {
      const targetId = target.targetRef.id
      const splitReviewId = `${runItem.reviewId}--${targetId}`
      const targetReview = targetReviews.get(splitReviewId)
      if (!targetReview) throw new Error(`${targetId}: selected target input is missing ${splitReviewId}`)
      const targetItem = targetCaches.get(splitReviewId)
      targetAnnotations.set(targetId, await readValidatedTargetAnnotation(targetItem, targetReview))
    }
    const mergedAnnotation = mergeAnnotations(fullReview, targetAnnotations)
    const validation = validateAnnotation(mergedAnnotation, annotationValidationOptions(fullReview, basePacket))
    if (!validation.ok) throw new Error(`${runItem.reviewId}: merged annotation is invalid: ${validation.errors.join('; ')}`)
    const enrichedResponse = {
      ...mergedAnnotation,
      targetObservations: mergedAnnotation.targetObservations.map((observation, index) => ({
        ...observation,
        targetRef: fullReview.targets[index].targetRef,
        intervalRef: fullReview.targets[index].intervalRef,
      })),
    }
    const providerRaw = mergedAnnotation
    const artifactDigests = {
      request: jsonDigest(basePacket),
      providerRaw: jsonDigest(providerRaw),
      modelAnnotation: jsonDigest(mergedAnnotation),
      response: jsonDigest(enrichedResponse),
    }
    const mergedMeta = {
      ...baseMeta,
      schemaVersion: CACHE_META_SCHEMA_VERSION,
      status: 'complete',
      runId: `merged-${Date.now().toString(36)}-${crypto.randomUUID()}`,
      acceptedAttempt: 1,
      attempts: 1,
      repaired: false,
      error: null,
      artifactDigests,
      updatedAt: new Date().toISOString(),
    }
    const outputItemDirectory = path.join(sourceOutputDirectory, runItem.cacheKey)
    await writeJson(path.join(outputItemDirectory, 'request.json'), basePacket)
    await writeJson(path.join(outputItemDirectory, 'provider-raw.json'), providerRaw)
    await writeJson(path.join(outputItemDirectory, 'model-annotation.json'), mergedAnnotation)
    await writeJson(path.join(outputItemDirectory, 'response.json'), enrichedResponse)
    await writeJson(path.join(outputItemDirectory, 'meta.json'), mergedMeta)
    manifest.reviews.push({
      reviewId: runItem.reviewId,
      cacheKey: runItem.cacheKey,
      targetIds: fullReview.targets.map((target) => target.targetRef.id),
      targetReviewIds: fullReview.targets.map((target) => `${runItem.reviewId}--${target.targetRef.id}`),
      mergedAnnotationSha256: jsonDigest(mergedAnnotation),
    })
  }

  if (manifest.reviews.length !== gold.reviews.length) throw new Error('merged review count does not match gold')
  await writeJson(path.join(outputRoot, 'merge-manifest.json'), manifest)
  process.stdout.write(`${JSON.stringify({sourceId: input.sourceId, reviewCount: manifest.reviews.length, targetCount: manifest.reviews.reduce((sum, review) => sum + review.targetIds.length, 0), outputCacheRoot: outputRoot}, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({error: String(error?.message ?? error)})}\n`)
    process.exitCode = 1
  })
}
