import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {cp, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  CALIBRATION_RUN_LOCK_SCHEMA_VERSION,
  CALIBRATION_RUN_SCHEMA_VERSION,
  evaluateCalibration,
  loadCalibrationAnnotations,
  validateSemanticSupplement,
  validateSemanticSupplementLock,
  validateCalibrationRunLock,
  validateCalibrationRunManifest,
} from './evaluate_vlm_calibration.mjs'
import {runReviewBatch} from './vlm_review.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const fixtureDirectory = path.join(scriptDirectory, 'fixtures')

async function readFixture(name) {
  return JSON.parse(await readFile(path.join(fixtureDirectory, name), 'utf8'))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  await writeFile(filePath, bytes)
  return bytes
}

async function makeJpegs(root, prefix, count) {
  const imagePaths = []
  for (let index = 0; index < count; index += 1) {
    const imagePath = path.join(root, `${prefix}-${index}.jpg`)
    await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, prefix.length, index, 0xff, 0xd9]))
    imagePaths.push(imagePath)
  }
  return imagePaths
}

async function makeCalibrationScenario() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-calibration-evaluator-'))
  const input = await readFixture('vlm-review-input.json')
  input.reviews = input.reviews.slice(0, 1)
  for (const review of input.reviews) {
    review.overview.imagePaths = await makeJpegs(root, `${review.id}-overview`, 5)
    for (const target of review.targets) {
      target.microSequence.imagePaths = await makeJpegs(root, `${target.targetRef.id}-micro`, 5)
    }
  }
  const inputPath = path.join(root, 'review-input.json')
  const inputBytes = await writeJson(inputPath, input)
  const inputSha256 = sha256(inputBytes)
  const annotation = await readFixture('vlm-review-response.valid.json')
  const cacheRoot = path.join(root, 'cache')
  const summary = await runReviewBatch({
    inputPath,
    cacheRoot,
    config: {
      baseUrl: 'https://vision.example.test',
      apiKey: 'runtime-only-fixture-secret',
      model: 'gpt-4o-mini',
    },
    minIntervalMs: 0,
    sleep: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'chatcmpl-calibration-fixture',
      model: 'gpt-4o-mini',
      choices: [{message: {content: JSON.stringify(annotation)}}],
    }), {status: 200, headers: {'Content-Type': 'application/json'}}),
  })
  assert.equal(summary.completed, 1)
  const summaryItem = summary.items[0]
  const itemDirectory = path.join(cacheRoot, input.sourceId, summaryItem.cacheKey)
  const packet = JSON.parse(await readFile(path.join(itemDirectory, 'request.json'), 'utf8'))

  const gold = fixtureGold()
  gold.input.sha256 = inputSha256
  const goldPath = path.join(root, 'human-gold.json')
  const goldBytes = await writeJson(goldPath, gold)
  const goldSha256 = sha256(goldBytes)
  const lockPath = path.join(root, 'human-gold.lock.json')
  await writeJson(lockPath, {
    schemaVersion: 'editorial-vlm-human-gold-lock-v1',
    sourceId: gold.sourceId,
    goldSha256,
    inputSha256,
  })
  const runManifest = {
    schemaVersion: CALIBRATION_RUN_SCHEMA_VERSION,
    calibrationId: 'fixture-v5.2-gpt4o-mini',
    sourceId: gold.sourceId,
    goldSha256,
    inputSha256,
    createdAt: '2026-07-21T00:00:00.000Z',
    calibration: {
      model: packet.body.model,
      promptVersion: packet.promptVersion,
      annotationSchemaVersion: packet.annotationSchemaVersion,
      annotationSchemaDigest: packet.annotationSchemaDigest,
      requestContractDigest: packet.requestContractDigest,
    },
    reviews: [{
      reviewId: summaryItem.reviewId,
      cacheKey: summaryItem.cacheKey,
      requestBodyDigest: packet.requestBodyDigest,
      targetCount: summaryItem.targetCount,
      imageCount: summaryItem.imageCount,
    }],
  }
  const runSpecPath = path.join(root, 'calibration-run.json')
  const runSpecBytes = await writeJson(runSpecPath, runManifest)
  const runSpecSha256 = sha256(runSpecBytes)
  const runLockPath = path.join(root, 'calibration-run.lock.json')
  const runLockBytes = await writeJson(runLockPath, {
    schemaVersion: CALIBRATION_RUN_LOCK_SCHEMA_VERSION,
    sourceId: runManifest.sourceId,
    calibrationId: runManifest.calibrationId,
    runSpecSha256,
    frozenAt: '2026-07-21T00:01:00.000Z',
  })
  return {
    root,
    input,
    inputPath,
    inputSha256,
    gold,
    goldPath,
    goldSha256,
    lockPath,
    cacheRoot,
    itemDirectory,
    packet,
    runManifest,
    runSpecPath,
    runSpecSha256,
    runLockPath,
    runLockSha256: sha256(runLockBytes),
  }
}

function fixtureGold() {
  return {
    schemaVersion: 'editorial-vlm-human-gold-v1',
    sourceId: 'fixture-source',
    calibration: {
      model: 'gpt-4o-mini',
      promptVersion: 'fixture-prompt',
      annotationSchemaVersion: 'observed-edit-review-v2',
      annotationSchemaDigest: 'c'.repeat(64),
      requestContractDigest: 'd'.repeat(64),
    },
    input: {
      schemaVersion: 'editorial-vlm-review-input-v2',
      reviewPlanDigest: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
    },
    gate: {requiredReviewPassRate: 1, requiredTargetPassRate: 1},
    reviews: [
      {
        reviewId: 'fixture-boundary-001',
        targets: [
          {
            targetId: 'observation-target-000001',
            acceptedEditClasses: ['within_setup_change'],
            requiredChangeTypeAny: [['text_replace']],
            acceptedAudioRelations: [
              {assessability: 'machine_evidence_available', relation: 'synchronous_accent'},
            ],
            humanEvidence: ['The title changes while the composition remains stable.'],
          },
          {
            targetId: 'observation-target-000002',
            acceptedEditClasses: ['hard_cut'],
            requiredChangeTypeAny: [],
            acceptedAudioRelations: [
              {assessability: 'not_assessable', relation: 'unknown'},
            ],
            humanEvidence: ['The full-frame setup is replaced discontinuously.'],
          },
        ],
        requiredContinuousTracks: [
          {
            behaviors: ['scale_down'],
            directions: ['out'],
            subjectScopes: ['layer'],
            layerTypes: ['logo'],
            startAtMost: 0,
            endAtLeast: 2,
          },
        ],
        requiredUnitEvidence: {
          layerTypeAny: [['logo']],
          visibleTextAny: [['yahoo']],
        },
      },
    ],
  }
}

function fixtureSemanticSupplement() {
  return {
    schemaVersion: 'editorial-vlm-semantic-gold-supplement-v1',
    predicateSemanticsVersion: 'change-instance-token-phrase-v1',
    sourceId: 'fixture-source',
    baseGold: {
      schemaVersion: 'editorial-vlm-human-gold-v1',
      sha256: 'g'.repeat(64),
    },
    inputSha256: 'b'.repeat(64),
    reviews: [
      {
        reviewId: 'fixture-boundary-001',
        targets: [
          {
            targetId: 'observation-target-000001',
            requiredChangePredicates: [
              {
                changeTypeAny: ['text_replace'],
                subjectTermsAny: ['center title'],
                mechanismAny: ['cut'],
              },
            ],
          },
        ],
      },
    ],
  }
}

test('calibration gate passes canonical target judgments and required tracks', async () => {
  const input = await readFixture('vlm-review-input.json')
  const annotation = await readFixture('vlm-review-response.valid.json')
  const report = evaluateCalibration(
    fixtureGold(),
    input,
    new Map([['fixture-boundary-001', annotation]]),
  )

  assert.equal(report.gate.status, 'passed')
  assert.deepEqual(report.counts, {reviews: 1, passedReviews: 1, targets: 2, passedTargets: 2})
})

test('semantic supplement validates hashes and passes the matching change instance', async () => {
  const input = await readFixture('vlm-review-input.json')
  const gold = fixtureGold()
  const supplement = fixtureSemanticSupplement()
  const stats = validateSemanticSupplement(supplement, {
    gold,
    goldSha256: 'g'.repeat(64),
    inputSha256: 'b'.repeat(64),
  })
  assert.deepEqual(stats, {targetCount: 1, predicateCount: 1})
  const lock = {
    schemaVersion: 'editorial-vlm-semantic-gold-lock-v1',
    supplementSha256: 's'.repeat(64),
    baseGoldSha256: 'g'.repeat(64),
    inputSha256: 'b'.repeat(64),
    targetCount: 1,
    predicateCount: 1,
  }
  validateSemanticSupplementLock(lock, {
    supplementSha256: 's'.repeat(64),
    goldSha256: 'g'.repeat(64),
    inputSha256: 'b'.repeat(64),
    ...stats,
  })
  const report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', await readFixture('vlm-review-response.valid.json')]]),
    {semanticSupplement: supplement},
  )
  assert.equal(report.gate.status, 'passed')
})

test('semantic supplement rejects a correct type with the wrong subject or mechanism', async () => {
  const input = await readFixture('vlm-review-input.json')
  const gold = fixtureGold()
  const supplement = fixtureSemanticSupplement()
  const annotation = await readFixture('vlm-review-response.valid.json')
  annotation.targetObservations[0].localDelta.changes[0].subject = 'background'
  let report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', annotation]]),
    {semanticSupplement: supplement},
  )
  assert.match(report.reviews[0].targets[0].errors.join('\n'), /semantic change predicates/)

  annotation.targetObservations[0].localDelta.changes[0].subject = 'center title'
  annotation.targetObservations[0].localDelta.changes[0].mechanism = 'type_on'
  report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', annotation]]),
    {semanticSupplement: supplement},
  )
  assert.match(report.reviews[0].targets[0].errors.join('\n'), /semantic change predicates/)
})

test('semantic matching uses whole token phrases and injective change assignment', async () => {
  const input = await readFixture('vlm-review-input.json')
  const gold = fixtureGold()
  const supplement = fixtureSemanticSupplement()
  const annotation = await readFixture('vlm-review-response.valid.json')
  annotation.targetObservations[0].localDelta.changes[0].subject = 'center title-card'
  let report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', annotation]]),
    {semanticSupplement: supplement},
  )
  assert.equal(report.reviews[0].targets[0].status, 'passed')

  annotation.targetObservations[0].localDelta.changes[0].subject = 'center titlecard'
  report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', annotation]]),
    {semanticSupplement: supplement},
  )
  assert.equal(report.reviews[0].targets[0].status, 'failed')

  gold.reviews[0].targets[0].requiredChangeTypeAny = [['text_replace'], ['text_replace']]
  annotation.targetObservations[0].localDelta.changes[0].subject = 'center title'
  supplement.reviews[0].targets[0].requiredChangePredicates.push({
    changeTypeAny: ['text_replace'],
    subjectTermsAny: ['center title'],
    mechanismAny: ['cut'],
  })
  const stats = validateSemanticSupplement(supplement, {
    gold,
    goldSha256: 'g'.repeat(64),
    inputSha256: 'b'.repeat(64),
  })
  assert.deepEqual(stats, {targetCount: 1, predicateCount: 2})
  report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', annotation]]),
    {semanticSupplement: supplement},
  )
  assert.match(report.reviews[0].targets[0].errors.join('\n'), /semantic change predicates/)
})

test('calibration gate fails a contract-valid but human-wrong classification', async () => {
  const input = await readFixture('vlm-review-input.json')
  const annotation = await readFixture('vlm-review-response.valid.json')
  annotation.targetObservations[1].localDelta.editClass = 'graphic_transition'
  const report = evaluateCalibration(
    fixtureGold(),
    input,
    {['fixture-boundary-001']: annotation},
  )

  assert.equal(report.gate.status, 'failed')
  assert.equal(report.counts.passedReviews, 0)
  assert.equal(report.counts.passedTargets, 1)
  assert.match(report.reviews[0].targets[1].errors.join('\n'), /not accepted/)
})

test('calibration gate fails contract-valid but human-wrong static evidence', async () => {
  const input = await readFixture('vlm-review-input.json')
  const annotation = await readFixture('vlm-review-response.valid.json')
  annotation.unitEvidence.layers[0].layerType = 'map'
  annotation.unitEvidence.texts[0].visibleText = 'Alta Vista'
  const report = evaluateCalibration(
    fixtureGold(),
    input,
    new Map([['fixture-boundary-001', annotation]]),
  )

  assert.equal(report.gate.status, 'failed')
  assert.deepEqual(report.counts, {reviews: 1, passedReviews: 0, targets: 2, passedTargets: 2})
  assert.doesNotMatch(report.reviews[0].errors.join('\n'), /contract:/)
  assert.match(report.reviews[0].errors.join('\n'), /required unit evidence layer type 0 is missing/)
  assert.match(report.reviews[0].errors.join('\n'), /required unit evidence visible text 0 is missing/)
})

test('visible-text evidence matching is case-insensitive across normalized text fragments', async () => {
  const input = await readFixture('vlm-review-input.json')
  const annotation = await readFixture('vlm-review-response.valid.json')
  const gold = fixtureGold()
  gold.reviews[0].requiredUnitEvidence.visibleTextAny = [['yahoo finance']]
  annotation.unitEvidence.texts[0].visibleText = '  YAHOO\n'
  annotation.unitEvidence.texts.push({
    ...annotation.unitEvidence.texts[0],
    visibleText: '  FINANCE  ',
  })

  const report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', annotation]]),
  )

  assert.equal(report.gate.status, 'passed')
})

test('human gold rejects blank unit-evidence alternatives', async () => {
  const input = await readFixture('vlm-review-input.json')
  const gold = fixtureGold()
  gold.reviews[0].requiredUnitEvidence.visibleTextAny = [[' \n ']]

  assert.throws(
    () => evaluateCalibration(gold, input, new Map()),
    /requiredUnitEvidence\.visibleTextAny\[0\] must be a non-empty string array/,
  )
})

test('human gold must preserve canonical review target order', async () => {
  const input = await readFixture('vlm-review-input.json')
  const gold = fixtureGold()
  gold.reviews[0].targets.reverse()

  assert.throws(
    () => evaluateCalibration(gold, input, new Map()),
    /targetId must match canonical order/,
  )
})

test('calibration run manifest freezes review order and immutable gold/input hashes', () => {
  const calibration = fixtureGold().calibration
  const gold = {
    sourceId: 'fixture-source',
    reviews: [
      {reviewId: 'review-a', targets: [{}, {}]},
      {reviewId: 'review-b', targets: [{}]},
    ],
  }
  const manifest = {
    schemaVersion: CALIBRATION_RUN_SCHEMA_VERSION,
    calibrationId: 'fixture-run',
    sourceId: gold.sourceId,
    goldSha256: '1'.repeat(64),
    inputSha256: '2'.repeat(64),
    createdAt: '2026-07-21T00:00:00.000Z',
    calibration,
    reviews: [
      {
        reviewId: 'review-a',
        cacheKey: '3'.repeat(64),
        requestBodyDigest: '4'.repeat(64),
        targetCount: 2,
        imageCount: 15,
      },
      {
        reviewId: 'review-b',
        cacheKey: '5'.repeat(64),
        requestBodyDigest: '6'.repeat(64),
        targetCount: 1,
        imageCount: 10,
      },
    ],
  }
  const context = {gold, goldSha256: manifest.goldSha256, inputSha256: manifest.inputSha256}

  assert.doesNotThrow(() => validateCalibrationRunManifest(manifest, context))
  const reversed = structuredClone(manifest)
  reversed.reviews.reverse()
  assert.throws(
    () => validateCalibrationRunManifest(reversed, context),
    /reviewId must match human gold order; expected review-a/,
  )
  assert.throws(
    () => validateCalibrationRunManifest(manifest, {...context, goldSha256: '7'.repeat(64)}),
    /human gold hash does not match/,
  )
  assert.throws(
    () => validateCalibrationRunManifest(manifest, {...context, inputSha256: '8'.repeat(64)}),
    /review input hash does not match/,
  )
})

test('calibration run lock anchors exact run-spec bytes, source, and calibration id', async () => {
  const scenario = await makeCalibrationScenario()
  const runLock = JSON.parse(await readFile(scenario.runLockPath, 'utf8'))
  const context = {runManifest: scenario.runManifest, runSpecSha256: scenario.runSpecSha256}

  assert.doesNotThrow(() => validateCalibrationRunLock(runLock, context))
  assert.throws(
    () => validateCalibrationRunLock({...runLock, runSpecSha256: '9'.repeat(64)}, context),
    /run spec hash does not match its immutable lock/,
  )
  assert.throws(
    () => validateCalibrationRunLock({...runLock, sourceId: 'other-source'}, context),
    /source id does not match/,
  )
  assert.throws(
    () => validateCalibrationRunLock({...runLock, calibrationId: 'other-run'}, context),
    /calibrationId does not match/,
  )
})

test('run manifest loads only its exact cache key and ignores other cache directories', async () => {
  const scenario = await makeCalibrationScenario()
  validateCalibrationRunManifest(scenario.runManifest, {
    gold: scenario.gold,
    goldSha256: scenario.goldSha256,
    inputSha256: scenario.inputSha256,
  })
  const decoyDirectory = path.join(scenario.cacheRoot, scenario.gold.sourceId, 'f'.repeat(64))
  await cp(scenario.itemDirectory, decoyDirectory, {recursive: true})

  const loaded = await loadCalibrationAnnotations({
    cacheRoot: scenario.cacheRoot,
    gold: scenario.gold,
    input: scenario.input,
    runManifest: scenario.runManifest,
  })

  assert.deepEqual([...loaded.annotationsByReview.keys()], ['fixture-boundary-001'])
  assert.equal(loaded.evidence.length, 1)
  assert.equal(loaded.evidence[0].cacheKey, scenario.runManifest.reviews[0].cacheKey)
  assert.equal(loaded.evidence[0].itemDirectory, scenario.itemDirectory)
  assert.deepEqual(loaded.diagnostics, [])
})

test('run manifest rejects requestBodyDigest drift in manifest, packet, metadata, or body', async () => {
  for (const [name, mutate, expected] of [
    [
      'manifest',
      async (scenario) => { scenario.runManifest.reviews[0].requestBodyDigest = 'a'.repeat(64) },
      /request packet requestBodyDigest does not match/,
    ],
    [
      'packet',
      async (scenario) => {
        const packetPath = path.join(scenario.itemDirectory, 'request.json')
        const packet = JSON.parse(await readFile(packetPath, 'utf8'))
        packet.requestBodyDigest = 'a'.repeat(64)
        await writeJson(packetPath, packet)
      },
      /request packet requestBodyDigest does not match/,
    ],
    [
      'metadata',
      async (scenario) => {
        const metaPath = path.join(scenario.itemDirectory, 'meta.json')
        const meta = JSON.parse(await readFile(metaPath, 'utf8'))
        meta.requestBodyDigest = 'a'.repeat(64)
        await writeJson(metaPath, meta)
      },
      /cache metadata requestBodyDigest does not match/,
    ],
    [
      'request body',
      async (scenario) => {
        const packetPath = path.join(scenario.itemDirectory, 'request.json')
        const packet = JSON.parse(await readFile(packetPath, 'utf8'))
        packet.body.temperature = 0.25
        await writeJson(packetPath, packet)
      },
      /computed requestBodyDigest does not match/,
    ],
  ]) {
    const scenario = await makeCalibrationScenario()
    await mutate(scenario)
    await assert.rejects(
      loadCalibrationAnnotations({
        cacheRoot: scenario.cacheRoot,
        gold: scenario.gold,
        input: scenario.input,
        runManifest: scenario.runManifest,
      }),
      expected,
      name,
    )
  }
})

test('run manifest calibration identity must match both request packet and metadata', async () => {
  const scenario = await makeCalibrationScenario()
  scenario.runManifest.calibration.promptVersion = 'different-prompt-version'

  await assert.rejects(
    loadCalibrationAnnotations({
      cacheRoot: scenario.cacheRoot,
      gold: scenario.gold,
      input: scenario.input,
      runManifest: scenario.runManifest,
    }),
    /request packet promptVersion does not match/,
  )
})

test('legacy loading without a run manifest remains compatible', async () => {
  const scenario = await makeCalibrationScenario()
  scenario.gold.calibration = structuredClone(scenario.runManifest.calibration)

  const loaded = await loadCalibrationAnnotations({
    cacheRoot: scenario.cacheRoot,
    gold: scenario.gold,
    input: scenario.input,
  })

  assert.deepEqual([...loaded.annotationsByReview.keys()], ['fixture-boundary-001'])
  assert.equal(loaded.evidence[0].cacheKey, scenario.packet.cacheKey)
  assert.deepEqual(loaded.diagnostics, [])
})

test('frozen V5.1 evaluation uses its legacy audio contract', async () => {
  const input = await readFixture('vlm-review-input.json')
  const annotation = await readFixture('vlm-review-response.valid.json')
  const gold = fixtureGold()
  gold.calibration = {
    model: 'gpt-4o',
    promptVersion: 'observable-editorial-review-v5.1-target-microsequences',
    annotationSchemaVersion: 'observed-edit-review-v2',
    annotationSchemaDigest: '548c042c6c6eb10189f63b858deece52b3da8c5310205cd97015fa1c24388efe',
    requestContractDigest: '4095658902562825c5ee80167183f218ed4b793ff7f3711d877d33858d92275d',
  }
  annotation.targetObservations[0].audioRelation = {
    assessability: 'not_assessable',
    relation: 'unknown',
    evidence: [],
  }
  gold.reviews[0].targets[0].acceptedAudioRelations = [
    {assessability: 'not_assessable', relation: 'unknown'},
  ]

  const report = evaluateCalibration(
    gold,
    input,
    new Map([['fixture-boundary-001', annotation]]),
  )

  assert.equal(report.gate.status, 'passed')
  assert.doesNotMatch(report.reviews[0].errors.join('\n'), /contract:/)
})

test('CLI --run-spec evaluates with runtime calibration and records manifest provenance', async () => {
  const scenario = await makeCalibrationScenario()
  const outputPath = path.join(scenario.root, 'calibration-report.json')
  const result = spawnSync(process.execPath, [
    path.join(scriptDirectory, 'evaluate_vlm_calibration.mjs'),
    '--gold', scenario.goldPath,
    '--lock', scenario.lockPath,
    '--input', scenario.inputPath,
    '--run-spec', scenario.runSpecPath,
    '--run-lock', scenario.runLockPath,
    '--cache-root', scenario.cacheRoot,
    '--output', outputPath,
  ], {encoding: 'utf8'})

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(await readFile(outputPath, 'utf8'))
  assert.equal(report.gate.status, 'passed')
  assert.equal(report.model, scenario.runManifest.calibration.model)
  assert.equal(report.promptVersion, scenario.runManifest.calibration.promptVersion)
  assert.equal(report.annotationSchemaVersion, scenario.runManifest.calibration.annotationSchemaVersion)
  assert.notEqual(report.promptVersion, scenario.gold.calibration.promptVersion)
  assert.deepEqual(report.inputs.calibrationRun, {
    path: scenario.runSpecPath,
    sha256: scenario.runSpecSha256,
  })
  assert.deepEqual(report.inputs.calibrationRunLock, {
    path: scenario.runLockPath,
    sha256: scenario.runLockSha256,
  })
})

test('CLI requires run spec and immutable run lock as a pair', async () => {
  const scenario = await makeCalibrationScenario()
  const outputPath = path.join(scenario.root, 'unlocked-report.json')
  const result = spawnSync(process.execPath, [
    path.join(scriptDirectory, 'evaluate_vlm_calibration.mjs'),
    '--gold', scenario.goldPath,
    '--lock', scenario.lockPath,
    '--input', scenario.inputPath,
    '--run-spec', scenario.runSpecPath,
    '--cache-root', scenario.cacheRoot,
    '--output', outputPath,
  ], {encoding: 'utf8'})

  assert.equal(result.status, 1)
  assert.match(result.stderr, /--run-spec and --run-lock must be provided together/)
})
