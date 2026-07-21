#!/usr/bin/env node

import crypto from 'node:crypto'
import {mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {
  annotationValidationOptions,
  readValidCachedEvidence,
  validateAnnotation,
} from './vlm_review.mjs'

const GOLD_SCHEMA_VERSION = 'editorial-vlm-human-gold-v1'
const LOCK_SCHEMA_VERSION = 'editorial-vlm-human-gold-lock-v1'
export const SEMANTIC_SUPPLEMENT_SCHEMA_VERSION = 'editorial-vlm-semantic-gold-supplement-v1'
export const SEMANTIC_SUPPLEMENT_LOCK_SCHEMA_VERSION = 'editorial-vlm-semantic-gold-lock-v1'
export const CALIBRATION_RUN_SCHEMA_VERSION = 'editorial-vlm-calibration-run-v1'
export const CALIBRATION_RUN_LOCK_SCHEMA_VERSION = 'editorial-vlm-calibration-run-lock-v1'

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

function requireNonEmptyStrings(values, label) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.some((value) => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error(`${label} must be a non-empty string array`)
  }
}

function normalizeTokenPhrase(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  const tokens = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? []
  if (tokens.length === 0) throw new Error(`${label} must contain letters or digits`)
  return tokens
}

function tokenPhraseMatches(value, phrase) {
  const valueTokens = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? []
  if (phrase.length > valueTokens.length) return false
  for (let index = 0; index <= valueTokens.length - phrase.length; index += 1) {
    if (phrase.every((token, offset) => valueTokens[index + offset] === token)) return true
  }
  return false
}

function unorderedStringSetEqual(left, right) {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every((value) => right.includes(value))
}

function validateCalibrationIdentity(calibration, label) {
  if (!isPlainObject(calibration) || typeof calibration.model !== 'string' || !calibration.model) {
    throw new Error(`${label} model is required`)
  }
  for (const field of ['promptVersion', 'annotationSchemaVersion']) {
    if (typeof calibration[field] !== 'string' || !calibration[field]) {
      throw new Error(`${label} ${field} is required`)
    }
  }
  for (const field of ['annotationSchemaDigest', 'requestContractDigest']) {
    if (typeof calibration[field] !== 'string' || !/^[a-f0-9]{64}$/i.test(calibration[field])) {
      throw new Error(`${label} ${field} must be a SHA-256 digest`)
    }
  }
}

function validateGold(gold, input) {
  if (!isPlainObject(gold) || gold.schemaVersion !== GOLD_SCHEMA_VERSION) {
    throw new Error(`unsupported human gold schema; expected ${GOLD_SCHEMA_VERSION}`)
  }
  if (!isPlainObject(input) || input.schemaVersion !== gold.input?.schemaVersion) {
    throw new Error('human gold and review input schema versions do not match')
  }
  if (gold.sourceId !== input.sourceId) throw new Error('human gold and review input source ids do not match')
  if (gold.input?.reviewPlanDigest !== input.reviewPlanDigest) {
    throw new Error('human gold and review input plan digests do not match')
  }
  validateCalibrationIdentity(gold.calibration, 'human gold calibration')
  if (!Array.isArray(gold.reviews) || gold.reviews.length === 0) throw new Error('human gold reviews are required')

  const inputReviews = new Map(input.reviews.map((review) => [review.id, review]))
  if (inputReviews.size !== input.reviews.length) throw new Error('review input ids must be unique')
  const seenReviews = new Set()
  for (const [reviewIndex, expectedReview] of gold.reviews.entries()) {
    const label = `gold.reviews[${reviewIndex}]`
    if (!isPlainObject(expectedReview) || typeof expectedReview.reviewId !== 'string' || !expectedReview.reviewId) {
      throw new Error(`${label}.reviewId is required`)
    }
    if (seenReviews.has(expectedReview.reviewId)) throw new Error(`duplicate human gold review ${expectedReview.reviewId}`)
    seenReviews.add(expectedReview.reviewId)
    const inputReview = inputReviews.get(expectedReview.reviewId)
    if (!inputReview) throw new Error(`human gold references unknown review ${expectedReview.reviewId}`)
    if (!Array.isArray(expectedReview.targets) || expectedReview.targets.length !== inputReview.targets.length) {
      throw new Error(`${label}.targets must match the canonical target count`)
    }
    for (const [targetIndex, expectedTarget] of expectedReview.targets.entries()) {
      const targetLabel = `${label}.targets[${targetIndex}]`
      const canonicalId = inputReview.targets[targetIndex]?.targetRef?.id
      if (expectedTarget?.targetId !== canonicalId) {
        throw new Error(`${targetLabel}.targetId must match canonical order; expected ${canonicalId}`)
      }
      requireNonEmptyStrings(expectedTarget.acceptedEditClasses, `${targetLabel}.acceptedEditClasses`)
      requireNonEmptyStrings(expectedTarget.humanEvidence, `${targetLabel}.humanEvidence`)
      if (!Array.isArray(expectedTarget.requiredChangeTypeAny)) {
        throw new Error(`${targetLabel}.requiredChangeTypeAny must be an array`)
      }
      expectedTarget.requiredChangeTypeAny.forEach((group, groupIndex) => {
        requireNonEmptyStrings(group, `${targetLabel}.requiredChangeTypeAny[${groupIndex}]`)
      })
      if (!Array.isArray(expectedTarget.acceptedAudioRelations) || expectedTarget.acceptedAudioRelations.length === 0) {
        throw new Error(`${targetLabel}.acceptedAudioRelations must not be empty`)
      }
    }
    if (!Array.isArray(expectedReview.requiredContinuousTracks)) {
      throw new Error(`${label}.requiredContinuousTracks must be an array`)
    }
    if (!isPlainObject(expectedReview.requiredUnitEvidence)) {
      throw new Error(`${label}.requiredUnitEvidence must be an object`)
    }
    for (const field of ['layerTypeAny', 'visibleTextAny']) {
      const groups = expectedReview.requiredUnitEvidence[field]
      if (!Array.isArray(groups)) {
        throw new Error(`${label}.requiredUnitEvidence.${field} must be an array`)
      }
      groups.forEach((group, groupIndex) => {
        requireNonEmptyStrings(group, `${label}.requiredUnitEvidence.${field}[${groupIndex}]`)
      })
    }
  }
}

function validateSemanticPredicate(predicate, label, expectedChangeTypes) {
  if (!isPlainObject(predicate)) throw new Error(`${label} must be an object`)
  for (const field of ['changeTypeAny', 'subjectTermsAny', 'mechanismAny']) {
    requireNonEmptyStrings(predicate[field], `${label}.${field}`)
  }
  if (!unorderedStringSetEqual(predicate.changeTypeAny, expectedChangeTypes)) {
    throw new Error(`${label}.changeTypeAny must preserve the corresponding human-gold change type group`)
  }
  for (const [index, term] of predicate.subjectTermsAny.entries()) {
    normalizeTokenPhrase(term, `${label}.subjectTermsAny[${index}]`)
  }
}

export function validateSemanticSupplement(supplement, {gold, goldSha256, inputSha256}) {
  if (!isPlainObject(supplement) || supplement.schemaVersion !== SEMANTIC_SUPPLEMENT_SCHEMA_VERSION) {
    throw new Error(`unsupported semantic supplement schema; expected ${SEMANTIC_SUPPLEMENT_SCHEMA_VERSION}`)
  }
  if (supplement.predicateSemanticsVersion !== 'change-instance-token-phrase-v1') {
    throw new Error('unsupported semantic predicate semantics version')
  }
  if (supplement.sourceId !== gold.sourceId) throw new Error('semantic supplement source id does not match human gold')
  if (!isPlainObject(supplement.baseGold) || supplement.baseGold.schemaVersion !== GOLD_SCHEMA_VERSION) {
    throw new Error('semantic supplement baseGold schema version does not match human gold')
  }
  if (supplement.baseGold.sha256 !== goldSha256) throw new Error('semantic supplement human gold hash does not match')
  if (supplement.inputSha256 !== inputSha256) throw new Error('semantic supplement review input hash does not match')
  if (!Array.isArray(supplement.reviews) || supplement.reviews.length !== gold.reviews.length) {
    throw new Error('semantic supplement reviews must match the human gold review count')
  }

  const expectedReviews = new Map(gold.reviews.map((review) => [review.reviewId, review]))
  let targetCount = 0
  let predicateCount = 0
  for (const [reviewIndex, expectedReview] of gold.reviews.entries()) {
    const item = supplement.reviews[reviewIndex]
    const label = `semantic supplement reviews[${reviewIndex}]`
    if (!isPlainObject(item) || item.reviewId !== expectedReview.reviewId) {
      throw new Error(`${label}.reviewId must match human gold order; expected ${expectedReview.reviewId}`)
    }
    if (!Array.isArray(item.targets)) throw new Error(`${label}.targets must be an array`)
    const expectedPredicateTargets = expectedReview.targets.filter((target) => target.requiredChangeTypeAny.length > 0)
    if (item.targets.length !== expectedPredicateTargets.length) {
      throw new Error(`${label}.targets must cover exactly ${expectedPredicateTargets.length} predicate targets`)
    }
    expectedPredicateTargets.forEach((expectedTarget, predicateTargetIndex) => {
      if (item.targets[predicateTargetIndex]?.targetId !== expectedTarget.targetId) {
        throw new Error(
          `${label}.targets[${predicateTargetIndex}].targetId must match predicate target order; expected ${expectedTarget.targetId}`,
        )
      }
    })
    for (const [targetIndex, expectedTarget] of expectedReview.targets.entries()) {
      const needsPredicates = expectedTarget.requiredChangeTypeAny.length > 0
      const supplementTarget = item.targets.find((candidate) => candidate?.targetId === expectedTarget.targetId)
      if (needsPredicates && !supplementTarget) {
        throw new Error(`${label}.targets is missing ${expectedTarget.targetId}`)
      }
      if (!needsPredicates && supplementTarget) {
        throw new Error(`${label}.targets contains unexpected no-change target ${expectedTarget.targetId}`)
      }
      if (!needsPredicates) continue
      const targetLabel = `${label}.targets[${targetIndex}]`
      if (!Array.isArray(supplementTarget.requiredChangePredicates)) {
        throw new Error(`${targetLabel}.requiredChangePredicates must be an array`)
      }
      if (supplementTarget.requiredChangePredicates.length !== expectedTarget.requiredChangeTypeAny.length) {
        throw new Error(`${targetLabel}.requiredChangePredicates must preserve human-gold group count`)
      }
      for (const [predicateIndex, predicate] of supplementTarget.requiredChangePredicates.entries()) {
        validateSemanticPredicate(
          predicate,
          `${targetLabel}.requiredChangePredicates[${predicateIndex}]`,
          expectedTarget.requiredChangeTypeAny[predicateIndex],
        )
        predicateCount += 1
      }
      targetCount += 1
    }
    for (const candidate of item.targets) {
      if (!expectedReviews.has(expectedReview.reviewId) || !expectedReview.targets.some((target) => target.targetId === candidate.targetId)) {
        throw new Error(`${label}.targets contains an unknown target ${candidate?.targetId}`)
      }
    }
  }
  return {targetCount, predicateCount}
}

export function validateSemanticSupplementLock(lock, {supplementSha256, goldSha256, inputSha256, targetCount, predicateCount}) {
  if (!isPlainObject(lock) || lock.schemaVersion !== SEMANTIC_SUPPLEMENT_LOCK_SCHEMA_VERSION) {
    throw new Error(`unsupported semantic supplement lock schema; expected ${SEMANTIC_SUPPLEMENT_LOCK_SCHEMA_VERSION}`)
  }
  if (lock.supplementSha256 !== supplementSha256) throw new Error('semantic supplement hash does not match its immutable lock')
  if (lock.baseGoldSha256 !== goldSha256) throw new Error('semantic supplement lock human gold hash does not match')
  if (lock.inputSha256 !== inputSha256) throw new Error('semantic supplement lock review input hash does not match')
  if (lock.targetCount !== targetCount) throw new Error('semantic supplement lock target count does not match')
  if (lock.predicateCount !== predicateCount) throw new Error('semantic supplement lock predicate count does not match')
}

function semanticSupplementReviewMap(supplement) {
  return new Map(supplement.reviews.map((review) => [review.reviewId, review]))
}

function semanticPredicateMatches(change, predicate) {
  if (!predicate.changeTypeAny.includes(change.changeType)) return false
  if (!predicate.mechanismAny.includes(change.mechanism)) return false
  return predicate.subjectTermsAny.some((term) => tokenPhraseMatches(change.subject, normalizeTokenPhrase(term, 'semantic subject term')))
}

function semanticPredicatesMatchTarget(actual, supplementTarget) {
  const changes = Array.isArray(actual?.localDelta?.changes) ? actual.localDelta.changes : []
  const predicates = supplementTarget.requiredChangePredicates
  if (predicates.length > changes.length) return false
  const used = new Set()
  const visit = (predicateIndex) => {
    if (predicateIndex === predicates.length) return true
    for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
      if (used.has(changeIndex) || !semanticPredicateMatches(changes[changeIndex], predicates[predicateIndex])) continue
      used.add(changeIndex)
      if (visit(predicateIndex + 1)) return true
      used.delete(changeIndex)
    }
    return false
  }
  return visit(0)
}

export function validateCalibrationRunManifest(runManifest, {gold, goldSha256, inputSha256, semanticSupplementSha256}) {
  if (!isPlainObject(runManifest) || runManifest.schemaVersion !== CALIBRATION_RUN_SCHEMA_VERSION) {
    throw new Error(`unsupported calibration run schema; expected ${CALIBRATION_RUN_SCHEMA_VERSION}`)
  }
  if (runManifest.sourceId !== gold.sourceId) throw new Error('calibration run source id does not match human gold')
  if (runManifest.goldSha256 !== goldSha256) throw new Error('calibration run human gold hash does not match')
  if (runManifest.inputSha256 !== inputSha256) throw new Error('calibration run review input hash does not match')
  if (semanticSupplementSha256 !== undefined && runManifest.semanticSupplementSha256 !== semanticSupplementSha256) {
    throw new Error('calibration run semantic supplement hash does not match')
  }
  if (semanticSupplementSha256 === undefined && runManifest.semanticSupplementSha256 !== undefined) {
    throw new Error('calibration run references an unexpected semantic supplement')
  }
  if (typeof runManifest.calibrationId !== 'string' || !runManifest.calibrationId) {
    throw new Error('calibration run calibrationId is required')
  }
  if (typeof runManifest.createdAt !== 'string' || !Number.isFinite(Date.parse(runManifest.createdAt))) {
    throw new Error('calibration run createdAt must be an ISO timestamp')
  }
  validateCalibrationIdentity(runManifest.calibration, 'calibration run')
  if (!Array.isArray(runManifest.reviews) || runManifest.reviews.length !== gold.reviews.length) {
    throw new Error('calibration run reviews must match the human gold review count')
  }
  const seenCacheKeys = new Set()
  for (const [index, expectedReview] of gold.reviews.entries()) {
    const item = runManifest.reviews[index]
    const label = `calibration run reviews[${index}]`
    if (!isPlainObject(item) || item.reviewId !== expectedReview.reviewId) {
      throw new Error(`${label}.reviewId must match human gold order; expected ${expectedReview.reviewId}`)
    }
    for (const field of ['cacheKey', 'requestBodyDigest']) {
      if (typeof item[field] !== 'string' || !/^[a-f0-9]{64}$/i.test(item[field])) {
        throw new Error(`${label}.${field} must be a SHA-256 digest`)
      }
    }
    if (seenCacheKeys.has(item.cacheKey)) throw new Error('calibration run cache keys must be unique')
    seenCacheKeys.add(item.cacheKey)
    const targetCount = expectedReview.targets.length
    if (item.targetCount !== targetCount) throw new Error(`${label}.targetCount must be ${targetCount}`)
    const imageCount = 5 + targetCount * 5
    if (item.imageCount !== imageCount) throw new Error(`${label}.imageCount must be ${imageCount}`)
  }
}

export function validateCalibrationRunLock(runLock, {runManifest, runSpecSha256}) {
  if (!isPlainObject(runLock) || runLock.schemaVersion !== CALIBRATION_RUN_LOCK_SCHEMA_VERSION) {
    throw new Error(`unsupported calibration run lock schema; expected ${CALIBRATION_RUN_LOCK_SCHEMA_VERSION}`)
  }
  if (typeof runLock.runSpecSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(runLock.runSpecSha256)) {
    throw new Error('calibration run lock runSpecSha256 must be a SHA-256 digest')
  }
  if (runLock.runSpecSha256 !== runSpecSha256) {
    throw new Error('calibration run spec hash does not match its immutable lock')
  }
  if (runLock.sourceId !== runManifest.sourceId) {
    throw new Error('calibration run lock source id does not match the run spec')
  }
  if (runLock.calibrationId !== runManifest.calibrationId) {
    throw new Error('calibration run lock calibrationId does not match the run spec')
  }
  if (runLock.frozenAt !== undefined && (
    typeof runLock.frozenAt !== 'string' || !Number.isFinite(Date.parse(runLock.frozenAt))
  )) {
    throw new Error('calibration run lock frozenAt must be an ISO timestamp')
  }
}

function assertIdentityValue(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match the calibration run`)
}

function validateRunCacheIdentity({packet, meta, item, review, runManifest, gold}) {
  if (!isPlainObject(packet)) throw new Error(`${item.reviewId}: request packet must be an object`)
  if (!isPlainObject(meta)) throw new Error(`${item.reviewId}: cache metadata must be an object`)
  if (!isPlainObject(packet.body)) throw new Error(`${item.reviewId}: request packet body must be an object`)

  const calibration = runManifest.calibration
  for (const [label, actual, expected] of [
    ['request packet sourceId', packet.sourceId, gold.sourceId],
    ['cache metadata sourceId', meta.sourceId, gold.sourceId],
    ['request packet reviewId', packet.reviewId, item.reviewId],
    ['cache metadata reviewId', meta.reviewId, item.reviewId],
    ['request packet cacheKey', packet.cacheKey, item.cacheKey],
    ['cache metadata cacheKey', meta.cacheKey, item.cacheKey],
    ['request packet reviewPlanDigest', packet.reviewPlanDigest, gold.input.reviewPlanDigest],
    ['cache metadata reviewPlanDigest', meta.reviewPlanDigest, gold.input.reviewPlanDigest],
    ['request packet model', packet.body.model, calibration.model],
    ['cache metadata model', meta.model, calibration.model],
    ['request packet promptVersion', packet.promptVersion, calibration.promptVersion],
    ['cache metadata promptVersion', meta.promptVersion, calibration.promptVersion],
    [
      'request packet annotationSchemaVersion',
      packet.annotationSchemaVersion,
      calibration.annotationSchemaVersion,
    ],
    [
      'cache metadata annotationSchemaVersion',
      meta.annotationSchemaVersion,
      calibration.annotationSchemaVersion,
    ],
    ['request packet annotationSchemaDigest', packet.annotationSchemaDigest, calibration.annotationSchemaDigest],
    ['cache metadata annotationSchemaDigest', meta.annotationSchemaDigest, calibration.annotationSchemaDigest],
    ['request packet requestContractDigest', packet.requestContractDigest, calibration.requestContractDigest],
    ['cache metadata requestContractDigest', meta.requestContractDigest, calibration.requestContractDigest],
    ['request packet requestBodyDigest', packet.requestBodyDigest, item.requestBodyDigest],
    ['cache metadata requestBodyDigest', meta.requestBodyDigest, item.requestBodyDigest],
  ]) {
    assertIdentityValue(actual, expected, `${item.reviewId}: ${label}`)
  }

  const computedRequestBodyDigest = sha256(stableStringify(packet.body))
  assertIdentityValue(
    computedRequestBodyDigest,
    item.requestBodyDigest,
    `${item.reviewId}: computed requestBodyDigest`,
  )
  const imageCount = packet.body.messages
    ?.flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'image_url')
    .length
  assertIdentityValue(imageCount, item.imageCount, `${item.reviewId}: request imageCount`)
  assertIdentityValue(review.targets.length, item.targetCount, `${item.reviewId}: review targetCount`)
}

function getAnnotation(annotationsByReview, reviewId) {
  if (annotationsByReview instanceof Map) return annotationsByReview.get(reviewId)
  return annotationsByReview?.[reviewId]
}

function audioRelationAccepted(actual, accepted) {
  return accepted.some((candidate) => (
    candidate?.assessability === actual?.assessability && candidate?.relation === actual?.relation
  ))
}

function trackMatches(track, expected) {
  if (expected.behaviors && !expected.behaviors.includes(track.behavior)) return false
  if (expected.directions && !expected.directions.includes(track.direction)) return false
  if (expected.subjectScopes && !expected.subjectScopes.includes(track.subject?.scope)) return false
  if (expected.layerTypes && !expected.layerTypes.includes(track.subject?.layerType)) return false
  if (expected.startAtMost !== undefined && track.startSampleIndex > expected.startAtMost) return false
  if (expected.endAtLeast !== undefined && track.endSampleIndex < expected.endAtLeast) return false
  return true
}

function normalizeVisibleText(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, ' ').trim() : ''
}

export function evaluateCalibration(gold, input, annotationsByReview, options = {}) {
  validateGold(gold, input)
  const calibration = options.calibration ?? gold.calibration
  validateCalibrationIdentity(calibration, 'calibration evaluation')
  const semanticReviews = options.semanticSupplement ? semanticSupplementReviewMap(options.semanticSupplement) : null
  const inputReviews = new Map(input.reviews.map((review) => [review.id, review]))
  const reviewResults = []
  let passedTargets = 0
  let totalTargets = 0

  for (const expectedReview of gold.reviews) {
    const review = inputReviews.get(expectedReview.reviewId)
    const annotation = getAnnotation(annotationsByReview, expectedReview.reviewId)
    const reviewErrors = []
    const targetResults = []
    if (!annotation) {
      reviewErrors.push('complete model annotation is missing')
    } else {
      const validation = validateAnnotation(
        annotation,
        annotationValidationOptions(review, calibration),
      )
      reviewErrors.push(...validation.errors.map((error) => `contract: ${error}`))
    }

    for (const [targetIndex, expectedTarget] of expectedReview.targets.entries()) {
      totalTargets += 1
      const actual = annotation?.targetObservations?.[targetIndex]
      const errors = []
      if (!actual) {
        errors.push('target observation is missing')
      } else {
        if (actual.targetId !== expectedTarget.targetId) errors.push(`targetId is ${actual.targetId}`)
        const editClass = actual.localDelta?.editClass
        if (!expectedTarget.acceptedEditClasses.includes(editClass)) {
          errors.push(`editClass ${editClass} is not accepted`)
        }
        const changeTypes = new Set((actual.localDelta?.changes ?? []).map((change) => change.changeType))
        for (const acceptedGroup of expectedTarget.requiredChangeTypeAny) {
          if (!acceptedGroup.some((changeType) => changeTypes.has(changeType))) {
            errors.push(`missing required change type; expected one of ${acceptedGroup.join(', ')}`)
          }
        }
        if (semanticReviews && expectedTarget.requiredChangeTypeAny.length > 0) {
          const semanticReview = semanticReviews.get(expectedReview.reviewId)
          const semanticTarget = semanticReview?.targets?.find((candidate) => candidate.targetId === expectedTarget.targetId)
          if (!semanticTarget || !semanticPredicatesMatchTarget(actual, semanticTarget)) {
            errors.push('required semantic change predicates are not satisfied')
          }
        }
        if (!audioRelationAccepted(actual.audioRelation, expectedTarget.acceptedAudioRelations)) {
          errors.push(
            `audio relation ${actual.audioRelation?.assessability}/${actual.audioRelation?.relation} is not accepted`,
          )
        }
      }
      if (errors.length === 0) passedTargets += 1
      targetResults.push({targetId: expectedTarget.targetId, status: errors.length === 0 ? 'passed' : 'failed', errors})
    }

    for (const [trackIndex, expectedTrack] of expectedReview.requiredContinuousTracks.entries()) {
      if (!(annotation?.continuousTracks ?? []).some((track) => trackMatches(track, expectedTrack))) {
        reviewErrors.push(`required continuous track ${trackIndex} is missing`)
      }
    }
    const observedLayerTypes = new Set(
      (annotation?.unitEvidence?.layers ?? []).map((layer) => layer.layerType),
    )
    for (const [groupIndex, acceptedLayerTypes] of expectedReview.requiredUnitEvidence.layerTypeAny.entries()) {
      if (!acceptedLayerTypes.some((layerType) => observedLayerTypes.has(layerType))) {
        reviewErrors.push(
          `required unit evidence layer type ${groupIndex} is missing; expected one of ${acceptedLayerTypes.join(', ')}`,
        )
      }
    }
    const mergedVisibleText = normalizeVisibleText(
      (annotation?.unitEvidence?.texts ?? []).map((text) => text.visibleText).join(' '),
    )
    for (const [groupIndex, acceptedTexts] of expectedReview.requiredUnitEvidence.visibleTextAny.entries()) {
      if (!acceptedTexts.some((candidate) => mergedVisibleText.includes(normalizeVisibleText(candidate)))) {
        reviewErrors.push(
          `required unit evidence visible text ${groupIndex} is missing; expected one of ${acceptedTexts.join(', ')}`,
        )
      }
    }
    if (targetResults.some((result) => result.status === 'failed')) reviewErrors.push('one or more target judgments failed')
    reviewResults.push({
      reviewId: expectedReview.reviewId,
      status: reviewErrors.length === 0 ? 'passed' : 'failed',
      errors: reviewErrors,
      targets: targetResults,
    })
  }

  const passedReviews = reviewResults.filter((review) => review.status === 'passed').length
  const reviewPassRate = passedReviews / reviewResults.length
  const targetPassRate = passedTargets / totalTargets
  const requiredReviewPassRate = Number(gold.gate?.requiredReviewPassRate ?? 1)
  const requiredTargetPassRate = Number(gold.gate?.requiredTargetPassRate ?? 1)
  const passed = reviewPassRate >= requiredReviewPassRate && targetPassRate >= requiredTargetPassRate
  return {
    schemaVersion: 'editorial-vlm-calibration-report-v1',
    sourceId: gold.sourceId,
    model: calibration.model,
    promptVersion: calibration.promptVersion,
    annotationSchemaVersion: calibration.annotationSchemaVersion,
    counts: {
      reviews: reviewResults.length,
      passedReviews,
      targets: totalTargets,
      passedTargets,
    },
    gate: {
      status: passed ? 'passed' : 'failed',
      requiredReviewPassRate,
      actualReviewPassRate: reviewPassRate,
      requiredTargetPassRate,
      actualTargetPassRate: targetPassRate,
    },
    reviews: reviewResults,
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function loadManifestCalibrationAnnotations({cacheRoot, gold, input, runManifest}) {
  const sourceDirectory = path.join(path.resolve(cacheRoot), gold.sourceId)
  const inputReviews = new Map(input.reviews.map((review) => [review.id, review]))
  const annotationsByReview = new Map()
  const evidence = []
  const diagnostics = []

  for (const item of runManifest.reviews) {
    const review = inputReviews.get(item.reviewId)
    if (!review) throw new Error(`calibration run references unknown review ${item.reviewId}`)
    const itemDirectory = path.join(sourceDirectory, item.cacheKey)
    let packet
    let meta
    try {
      [packet, meta] = await Promise.all([
        readJson(path.join(itemDirectory, 'request.json')),
        readJson(path.join(itemDirectory, 'meta.json')),
      ])
    } catch {
      diagnostics.push(`${item.reviewId}: exact cache entry ${item.cacheKey} is missing or unreadable`)
      continue
    }
    validateRunCacheIdentity({packet, meta, item, review, runManifest, gold})
    const valid = await readValidCachedEvidence(itemDirectory, packet, review)
    if (!valid) {
      diagnostics.push(`${item.reviewId}: exact cache evidence bundle ${item.cacheKey} is invalid`)
      continue
    }
    annotationsByReview.set(item.reviewId, await readJson(path.join(itemDirectory, 'model-annotation.json')))
    evidence.push({
      reviewId: item.reviewId,
      itemDirectory,
      cacheKey: item.cacheKey,
      requestBodyDigest: item.requestBodyDigest,
      runId: meta.runId,
    })
  }
  return {annotationsByReview, evidence, diagnostics}
}

async function loadLegacyCalibrationAnnotations({cacheRoot, gold, input}) {
  const sourceDirectory = path.join(path.resolve(cacheRoot), gold.sourceId)
  let entries
  try {
    entries = await readdir(sourceDirectory, {withFileTypes: true})
  } catch {
    return {annotationsByReview: new Map(), evidence: [], diagnostics: ['cache source directory is missing']}
  }
  const expectedReviewIds = new Set(gold.reviews.map((review) => review.reviewId))
  const candidates = new Map()
  const diagnostics = []
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
    if (meta.status !== 'complete' || !expectedReviewIds.has(meta.reviewId)) continue
    if (
      meta.model !== gold.calibration.model
      || meta.promptVersion !== gold.calibration.promptVersion
      || meta.annotationSchemaVersion !== gold.calibration.annotationSchemaVersion
      || meta.annotationSchemaDigest !== gold.calibration.annotationSchemaDigest
      || meta.requestContractDigest !== gold.calibration.requestContractDigest
      || meta.reviewPlanDigest !== gold.input.reviewPlanDigest
    ) {
      continue
    }
    const review = input.reviews.find((candidate) => candidate.id === meta.reviewId)
    const valid = await readValidCachedEvidence(itemDirectory, packet, review)
    if (!valid) {
      diagnostics.push(`${meta.reviewId}: cache evidence bundle is invalid`)
      continue
    }
    if (candidates.has(meta.reviewId)) throw new Error(`multiple complete calibration results found for ${meta.reviewId}`)
    candidates.set(meta.reviewId, {
      annotation: await readJson(path.join(itemDirectory, 'model-annotation.json')),
      itemDirectory,
      cacheKey: packet.cacheKey,
      runId: meta.runId,
    })
  }
  return {
    annotationsByReview: new Map([...candidates].map(([reviewId, candidate]) => [reviewId, candidate.annotation])),
    evidence: [...candidates].map(([reviewId, candidate]) => ({reviewId, ...candidate, annotation: undefined})),
    diagnostics,
  }
}

export async function loadCalibrationAnnotations({cacheRoot, gold, input, runManifest}) {
  if (runManifest) return loadManifestCalibrationAnnotations({cacheRoot, gold, input, runManifest})
  return loadLegacyCalibrationAnnotations({cacheRoot, gold, input})
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true})
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporaryPath, filePath)
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
    else if (argument === '--semantic-supplement') result.semanticSupplementPath = value()
    else if (argument === '--semantic-lock') result.semanticLockPath = value()
    else if (argument === '--run-spec') result.runSpecPath = value()
    else if (argument === '--run-lock') result.runLockPath = value()
    else if (argument === '--cache-root') result.cacheRoot = value()
    else if (argument === '--output') result.outputPath = value()
    else if (argument === '--help' || argument === '-h') result.help = true
    else throw new Error(`unknown option: ${argument}`)
  }
  return result
}

function usage() {
  return `Usage: node scripts/editorial-analysis/evaluate_vlm_calibration.mjs \\
  --gold <human-gold.json> --lock <gold.lock.json> --input <vlm-review-input.json> \\
  [--semantic-supplement <semantic-gold.json> --semantic-lock <semantic-gold.lock.json>] \\
  [--run-spec <calibration-run.json> --run-lock <calibration-run.lock.json>] \\
  --cache-root <directory> --output <report.json>`
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  for (const key of ['goldPath', 'lockPath', 'inputPath', 'cacheRoot', 'outputPath']) {
    if (!arguments_[key]) throw new Error(`--${key.replace(/Path$/, '').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }
  if (Boolean(arguments_.runSpecPath) !== Boolean(arguments_.runLockPath)) {
    throw new Error('--run-spec and --run-lock must be provided together')
  }
  if (Boolean(arguments_.semanticSupplementPath) !== Boolean(arguments_.semanticLockPath)) {
    throw new Error('--semantic-supplement and --semantic-lock must be provided together')
  }
  const [goldBytes, inputBytes, lock, semanticBytes, semanticLockBytes, runSpecBytes, runLockBytes] = await Promise.all([
    readFile(arguments_.goldPath),
    readFile(arguments_.inputPath),
    readJson(arguments_.lockPath),
    arguments_.semanticSupplementPath ? readFile(arguments_.semanticSupplementPath) : null,
    arguments_.semanticLockPath ? readFile(arguments_.semanticLockPath) : null,
    arguments_.runSpecPath ? readFile(arguments_.runSpecPath) : null,
    arguments_.runLockPath ? readFile(arguments_.runLockPath) : null,
  ])
  if (lock.schemaVersion !== LOCK_SCHEMA_VERSION) throw new Error(`unsupported human gold lock schema`)
  const goldSha256 = sha256(goldBytes)
  const inputSha256 = sha256(inputBytes)
  if (lock.goldSha256 !== goldSha256) throw new Error('human gold hash does not match its immutable lock')
  if (lock.inputSha256 !== inputSha256) throw new Error('review input hash does not match the immutable gold lock')
  const gold = JSON.parse(goldBytes.toString('utf8'))
  const input = JSON.parse(inputBytes.toString('utf8'))
  if (gold.input?.sha256 !== inputSha256) throw new Error('review input hash does not match human gold')
  const semanticSupplement = semanticBytes ? JSON.parse(semanticBytes.toString('utf8')) : null
  const semanticSupplementSha256 = semanticBytes ? sha256(semanticBytes) : null
  let semanticSupplementStats = null
  if (semanticSupplement) {
    semanticSupplementStats = validateSemanticSupplement(semanticSupplement, {gold, goldSha256, inputSha256})
    validateSemanticSupplementLock(
      JSON.parse(semanticLockBytes.toString('utf8')),
      {
        supplementSha256: semanticSupplementSha256,
        goldSha256,
        inputSha256,
        ...semanticSupplementStats,
      },
    )
  }
  const runManifest = runSpecBytes ? JSON.parse(runSpecBytes.toString('utf8')) : null
  const runLock = runLockBytes ? JSON.parse(runLockBytes.toString('utf8')) : null
  const runSpecSha256 = runSpecBytes ? sha256(runSpecBytes) : null
  if (runManifest) {
    validateCalibrationRunManifest(
      runManifest,
      {
        gold,
        goldSha256,
        inputSha256,
        ...(semanticSupplement ? {semanticSupplementSha256} : {}),
      },
    )
    validateCalibrationRunLock(runLock, {runManifest, runSpecSha256})
  }
  const loaded = await loadCalibrationAnnotations({
    cacheRoot: arguments_.cacheRoot,
    gold,
    input,
    runManifest,
  })
  const report = evaluateCalibration(
    gold,
    input,
    loaded.annotationsByReview,
    {calibration: runManifest?.calibration, semanticSupplement},
  )
  report.inputs = {
    gold: {path: path.resolve(arguments_.goldPath), sha256: goldSha256},
    lock: {path: path.resolve(arguments_.lockPath)},
    reviewInput: {path: path.resolve(arguments_.inputPath), sha256: inputSha256},
    cacheRoot: path.resolve(arguments_.cacheRoot),
  }
  if (semanticSupplement) {
    report.inputs.semanticSupplement = {
      path: path.resolve(arguments_.semanticSupplementPath),
      sha256: semanticSupplementSha256,
      lockPath: path.resolve(arguments_.semanticLockPath),
      targetCount: semanticSupplementStats.targetCount,
      predicateCount: semanticSupplementStats.predicateCount,
    }
  }
  if (runManifest) {
    report.inputs.calibrationRun = {
      path: path.resolve(arguments_.runSpecPath),
      sha256: runSpecSha256,
    }
    report.inputs.calibrationRunLock = {
      path: path.resolve(arguments_.runLockPath),
      sha256: sha256(runLockBytes),
    }
  }
  report.evidence = loaded.evidence.map(({annotation: _annotation, ...value}) => value)
  report.diagnostics = loaded.diagnostics
  await atomicWriteJson(path.resolve(arguments_.outputPath), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.gate.status !== 'passed') process.exitCode = 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({error: String(error?.message ?? error)})}\n`)
    process.exitCode = 1
  })
}
