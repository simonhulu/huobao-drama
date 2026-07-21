import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

import {
  ANNOTATION_SCHEMA,
  ANNOTATION_SCHEMA_VERSION,
  INPUT_SCHEMA_VERSION,
  REQUEST_SCHEMA_VERSION,
  V51_CALIBRATION_CONTRACT,
  annotationValidationOptions,
  buildRequestPacket,
  readValidCachedEvidence,
  runReviewBatch,
  validateAnnotation,
} from './vlm_review.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '../..')
const fixtureDirectory = path.join(scriptDirectory, 'fixtures')

async function readFixture(name) {
  return JSON.parse(await readFile(path.join(fixtureDirectory, name), 'utf8'))
}

async function makeJpegs(root, prefix, count) {
  const paths = []
  for (let index = 0; index < count; index += 1) {
    const imagePath = path.join(root, `${prefix}-${String(index + 1).padStart(2, '0')}.jpg`)
    await writeFile(imagePath, Buffer.from([
      0xff,
      0xd8,
      0xff,
      0xe0,
      prefix.length,
      prefix.charCodeAt(prefix.length - 1),
      index,
      0xff,
      0xd9,
    ]))
    paths.push(imagePath)
  }
  return paths
}

async function makeInput(root, reviewCount = 2) {
  const input = await readFixture('vlm-review-input.json')
  input.reviews = input.reviews.slice(0, reviewCount)
  for (const review of input.reviews) {
    review.overview.imagePaths = await makeJpegs(root, `${review.id}-overview`, 5)
    for (const target of review.targets) {
      target.microSequence.imagePaths = await makeJpegs(root, `${review.id}-${target.targetRef.id}`, 5)
    }
  }
  const inputPath = path.join(root, 'reviews.json')
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`)
  return inputPath
}

async function listFiles(root) {
  const output = []
  async function visit(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else output.push(absolute)
    }
  }
  await visit(root)
  return output.sort()
}

function chatResponse(annotation, extra = {}) {
  return new Response(JSON.stringify({
    id: extra.id ?? 'chatcmpl-fixture',
    model: extra.model ?? 'gpt-4o-mini',
    choices: [{message: {content: JSON.stringify(annotation)}}],
  }), {status: 200, headers: {'Content-Type': 'application/json'}})
}

function collectSchemaKeywords(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaKeywords(item, output)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      output.add(key)
      collectSchemaKeywords(child, output)
    }
  }
  return output
}

function validationOptions(review, contractIdentity) {
  return annotationValidationOptions(review, contractIdentity)
}

async function requestPacket(inputPath, review, overrides = {}) {
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  return buildRequestPacket(review, {
    inputDirectory: path.dirname(inputPath),
    endpoint: 'https://vision.example.test/v1/chat/completions',
    model: 'gpt-4o-mini',
    sourceId: input.sourceId,
    reviewPlanDigest: input.reviewPlanDigest,
    ...overrides,
  })
}

test('V5 schema accepts target-local observations and rejects dynamic unit evidence', async () => {
  const input = await readFixture('vlm-review-input.json')
  const annotation = await readFixture('vlm-review-response.valid.json')
  assert.equal(INPUT_SCHEMA_VERSION, 'editorial-vlm-review-input-v2')
  assert.equal(REQUEST_SCHEMA_VERSION, 'editorial-vlm-request-v2')
  assert.equal(ANNOTATION_SCHEMA_VERSION, 'observed-edit-review-v2')
  assert.deepEqual(ANNOTATION_SCHEMA.required, [
    'targetObservations',
    'continuousTracks',
    'unitEvidence',
    'reviewNotes',
    'confidence',
  ])
  assert.deepEqual(validateAnnotation(annotation, validationOptions(input.reviews[0])), {ok: true, errors: []})

  const invented = structuredClone(annotation)
  invented.unitEvidence.layers[0].motion = 'zoom_in'
  const result = validateAnnotation(invented, validationOptions(input.reviews[0]))
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /unitEvidence\.layers\[0\]\.motion: additional property/)
})

test('annotation requires exactly one target observation in canonical input order', async () => {
  const input = await readFixture('vlm-review-input.json')
  const review = input.reviews[0]
  const annotation = await readFixture('vlm-review-response.valid.json')

  for (const [name, mutate, expected] of [
    ['reversed', (value) => value.targetObservations.reverse(), /targetId.*canonical order/],
    ['duplicate', (value) => { value.targetObservations[1].targetId = value.targetObservations[0].targetId }, /targetId.*canonical order/],
    ['missing', (value) => value.targetObservations.pop(), /exactly 2 items/],
    ['invented', (value) => { value.targetObservations[0].targetRef = review.targets[0].targetRef }, /targetRef: additional property/],
  ]) {
    const invalid = structuredClone(annotation)
    mutate(invalid)
    const result = validateAnnotation(invalid, validationOptions(review))
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), expected, name)
  }
})

test('local delta ownership is exclusive and every classification remains evidenced', async () => {
  const input = await readFixture('vlm-review-input.json')
  const review = input.reviews[0]
  const annotation = await readFixture('vlm-review-response.valid.json')

  for (const [name, mutate, expected] of [
    [
      'within-setup change without events',
      (value) => { value.targetObservations[0].localDelta.changes = [] },
      /changes: must not be empty for within_setup_change/,
    ],
    [
      'boundary owning within-setup events',
      (value) => { value.targetObservations[1].localDelta.changes = structuredClone(value.targetObservations[0].localDelta.changes) },
      /changes: must be empty unless editClass is within_setup_change/,
    ],
    [
      'no-delta owning within-setup events',
      (value) => {
        value.targetObservations[1].localDelta.editClass = 'no_local_delta'
        value.targetObservations[1].localDelta.changes = structuredClone(value.targetObservations[0].localDelta.changes)
      },
      /changes: must be empty unless editClass is within_setup_change/,
    ],
    [
      'ambiguous without alternatives',
      (value) => {
        value.targetObservations[1].localDelta.editClass = 'ambiguous'
        value.targetObservations[1].localDelta.alternativeExplanations = []
      },
      /alternativeExplanations: must not be empty for ambiguous/,
    ],
    [
      'classification without evidence',
      (value) => { value.targetObservations[1].localDelta.evidence = [] },
      /localDelta\.evidence: must not be empty/,
    ],
  ]) {
    const invalid = structuredClone(annotation)
    mutate(invalid)
    const result = validateAnnotation(invalid, validationOptions(review))
    assert.equal(result.ok, false, name)
    assert.match(result.errors.join('\n'), expected, name)
  }
})

test('audio relation must exactly copy deterministic machine timing evidence', async () => {
  const input = await readFixture('vlm-review-input.json')
  const review = input.reviews[0]
  const annotation = await readFixture('vlm-review-response.valid.json')

  const visualDetectorAsAudio = structuredClone(annotation)
  visualDetectorAsAudio.targetObservations[0].audioRelation = {
    assessability: 'machine_evidence_available',
    relation: 'synchronous_accent',
    evidence: ['ffmpeg_scene'],
  }
  assert.match(
    validateAnnotation(visualDetectorAsAudio, validationOptions(review)).errors.join('\n'),
    /must exactly copy the supplied machineAudioRelation/,
  )

  const inventedAudio = structuredClone(annotation)
  inventedAudio.targetObservations[1].audioRelation = {
    assessability: 'machine_evidence_available',
    relation: 'prelap',
    evidence: ['side_onset'],
  }
  assert.match(
    validateAnnotation(inventedAudio, validationOptions(review)).errors.join('\n'),
    /must exactly copy the supplied machineAudioRelation/,
  )

  assert.deepEqual(
    validateAnnotation(visualDetectorAsAudio, validationOptions(review, V51_CALIBRATION_CONTRACT)),
    {ok: true, errors: []},
  )
  assert.match(
    validateAnnotation(visualDetectorAsAudio, validationOptions(review, {
      ...V51_CALIBRATION_CONTRACT,
      requestContractDigest: '0'.repeat(64),
    })).errors.join('\n'),
    /must exactly copy the supplied machineAudioRelation/,
  )
})

test('continuous tracks span two intervals, use coherent directions, and stop at definite boundaries', async () => {
  const input = await readFixture('vlm-review-input.json')
  const review = input.reviews[0]
  const annotation = await readFixture('vlm-review-response.valid.json')

  const tooShort = structuredClone(annotation)
  tooShort.continuousTracks[0].endSampleIndex = 1
  assert.match(
    validateAnnotation(tooShort, validationOptions(review)).errors.join('\n'),
    /must span at least 2 overview intervals/,
  )

  const wrongDirection = structuredClone(annotation)
  wrongDirection.continuousTracks[0].direction = 'in'
  assert.match(
    validateAnnotation(wrongDirection, validationOptions(review)).errors.join('\n'),
    /direction must be out when behavior is scale_down/,
  )

  const crossesBoundary = structuredClone(annotation)
  crossesBoundary.continuousTracks[0].endSampleIndex = 4
  assert.match(
    validateAnnotation(crossesBoundary, validationOptions(review)).errors.join('\n'),
    /crosses definite boundary target observation-target-000002/,
  )
})

test('request v2 orders five overview images before canonical five-frame target groups', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-request-'))
  const inputPath = await makeInput(root, 1)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const packet = await requestPacket(inputPath, input.reviews[0])

  assert.equal(packet.schemaVersion, 'editorial-vlm-request-v2')
  assert.equal(packet.reviewPlanDigest, input.reviewPlanDigest)
  assert.match(packet.annotationSchemaDigest, /^[a-f0-9]{64}$/)
  assert.match(packet.requestContractDigest, /^[a-f0-9]{64}$/)
  assert.match(packet.requestBodyDigest, /^[a-f0-9]{64}$/)
  assert.match(packet.targetMapDigest, /^[a-f0-9]{64}$/)
  assert.equal(packet.body.response_format.type, 'json_schema')
  assert.equal(packet.body.response_format.json_schema.strict, true)
  const apiSchemaKeywords = collectSchemaKeywords(packet.body.response_format.json_schema.schema)
  for (const unsupported of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems']) {
    assert.equal(apiSchemaKeywords.has(unsupported), false, unsupported)
  }

  const content = packet.body.messages[1].content
  assert.match(packet.body.messages[0].content, /setup-first sequence/)
  assert.match(packet.body.messages[0].content, /persistent overlay does not turn a background source cut/)
  assert.match(content[0].text, /"machineAudioRelation"/)
  assert.match(content[0].text, /"relation": "synchronous_accent"/)
  assert.doesNotMatch(content[0].text, /"machineEvidence"|ffmpeg_scene/)
  const modelFacingText = content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  for (const hiddenIdentity of [input.sourceId, input.reviews[0].id, input.reviewPlanDigest, root]) {
    assert.equal(modelFacingText.includes(hiddenIdentity), false, hiddenIdentity)
  }
  for (const imagePath of [
    ...input.reviews[0].overview.imagePaths,
    ...input.reviews[0].targets.flatMap((target) => target.microSequence.imagePaths),
  ]) {
    assert.equal(modelFacingText.includes(path.basename(imagePath)), false, path.basename(imagePath))
  }
  assert.doesNotMatch(modelFacingText, /[a-f0-9]{64}/)
  assert.doesNotMatch(
    modelFacingText,
    /"(?:sourceId|reviewId|reviewPlanDigest|fileName|sha256|frameIndex|timeSeconds|frameOffset)"/,
  )
  assert.doesNotMatch(modelFacingText, /\b(?:frameIndex|timeSeconds|frameOffset|sha256)=/)
  assert.equal(packet.sourceId, input.sourceId)
  assert.equal(packet.reviewId, input.reviews[0].id)
  assert.equal(packet.reviewPlanDigest, input.reviewPlanDigest)
  const mismatchedAudio = await readFixture('vlm-review-response.valid.json')
  mismatchedAudio.targetObservations[0].audioRelation = {
    assessability: 'machine_evidence_available',
    relation: 'postlap',
    evidence: ['legacy non-deterministic audio claim'],
  }
  assert.match(
    validateAnnotation(mismatchedAudio, validationOptions(input.reviews[0], packet)).errors.join('\n'),
    /must exactly copy the supplied machineAudioRelation/,
  )
  const imageParts = content.filter((part) => part.type === 'image_url')
  assert.equal(imageParts.length, 15)
  assert.equal(new Set(imageParts.map((part) => part.image_url.url)).size, 15)
  assert.equal(imageParts.every((part) => part.image_url.detail === 'high'), true)
  const labels = content.filter((part) => part.type === 'text').map((part) => part.text)
  assert.deepEqual(
    labels.filter((label) => /^OVERVIEW SAMPLE/.test(label)).map((label) => Number(/index=(\d+)/.exec(label)[1])),
    [0, 1, 2, 3, 4],
  )
  assert.deepEqual(
    labels.filter((label) => /^TARGET GROUP/.test(label)).map((label) => /targetId=([^ ]+)/.exec(label)[1]),
    ['observation-target-000001', 'observation-target-000002'],
  )
  assert.deepEqual(
    labels.filter((label) => /^TARGET MICRO SAMPLE/.test(label)).map((label) => /targetId=([^ ]+)/.exec(label)[1]),
    [
      ...Array(5).fill('observation-target-000001'),
      ...Array(5).fill('observation-target-000002'),
    ],
  )
})

test('cache identity changes with the review plan or canonical target map', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-identity-'))
  const inputPath = await makeInput(root, 1)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const review = input.reviews[0]
  const original = await requestPacket(inputPath, review)
  const otherPlan = await requestPacket(inputPath, review, {reviewPlanDigest: 'b'.repeat(64)})
  const otherModel = await requestPacket(inputPath, review, {model: 'gpt-4o'})
  const otherSource = await requestPacket(inputPath, review, {sourceId: 'different-source'})
  const renamedReview = structuredClone(review)
  renamedReview.id = 'different-review-id'
  const otherReviewId = await requestPacket(inputPath, renamedReview)
  const changedReview = structuredClone(review)
  changedReview.targets[0].targetRef.candidateIds = ['different-candidate']
  changedReview.machineEvidence.candidateIds[0] = 'different-candidate'
  changedReview.machineEvidence.candidates[0].id = 'different-candidate'
  const otherTarget = await requestPacket(inputPath, changedReview)

  assert.notEqual(original.cacheKey, otherPlan.cacheKey)
  assert.equal(original.targetMapDigest, otherPlan.targetMapDigest)
  assert.equal(original.requestContractDigest, otherModel.requestContractDigest)
  assert.notEqual(original.requestBodyDigest, otherModel.requestBodyDigest)
  assert.notEqual(original.cacheKey, otherModel.cacheKey)
  assert.equal(original.requestBodyDigest, otherSource.requestBodyDigest)
  assert.notEqual(original.cacheKey, otherSource.cacheKey)
  assert.equal(original.requestBodyDigest, otherReviewId.requestBodyDigest)
  assert.notEqual(original.cacheKey, otherReviewId.cacheKey)
  assert.notEqual(original.targetMapDigest, otherTarget.targetMapDigest)
  assert.notEqual(original.cacheKey, otherTarget.cacheKey)
})

test('all ten frozen Yahoo V5.1 cache bundles replay under their recorded contract', async () => {
  const inputPath = path.join(
    projectRoot,
    'tmp/editorial-analysis/yahoo-4b8b778897c5c513/vlm-review-input-v2.json',
  )
  const cacheRoot = path.join(
    projectRoot,
    'tmp/editorial-analysis/vlm-calibration-yahoo-v5-gpt4o/yahoo',
  )
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const reviewsById = new Map(input.reviews.map((review) => [review.id, review]))
  const cacheEntries = (await readdir(cacheRoot, {withFileTypes: true}))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  const frozenEntries = []
  for (const entry of cacheEntries) {
    const packet = JSON.parse(await readFile(path.join(cacheRoot, entry.name, 'request.json'), 'utf8'))
    if (
      packet.promptVersion === V51_CALIBRATION_CONTRACT.promptVersion
      && packet.requestContractDigest === V51_CALIBRATION_CONTRACT.requestContractDigest
    ) {
      frozenEntries.push({entry, packet})
    }
  }
  assert.equal(frozenEntries.length, 10)

  const replayedReviewIds = []
  for (const {entry, packet} of frozenEntries) {
    const itemDirectory = path.join(cacheRoot, entry.name)
    assert.equal(packet.promptVersion, V51_CALIBRATION_CONTRACT.promptVersion)
    assert.equal(packet.requestContractDigest, V51_CALIBRATION_CONTRACT.requestContractDigest)
    const review = reviewsById.get(packet.reviewId)
    assert.ok(review, packet.reviewId)
    assert.ok(await readValidCachedEvidence(itemDirectory, packet, review), packet.reviewId)
    replayedReviewIds.push(packet.reviewId)
  }

  assert.equal(new Set(replayedReviewIds).size, 10)
})

test('review normalization rejects malformed overview, target counts, micro-sequences, and provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-normalize-'))
  const inputPath = await makeInput(root, 1)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const original = input.reviews[0]

  for (const [name, mutate, expected] of [
    ['overview images', (value) => value.overview.imagePaths.pop(), /overview\.imagePaths must contain exactly 5/],
    ['no targets', (value) => { value.targets = [] }, /targets must contain between 1 and 4/],
    ['too many targets', (value) => { value.targets = Array(5).fill(value.targets[0]) }, /targets must contain between 1 and 4/],
    ['micro images', (value) => value.targets[0].microSequence.imagePaths.pop(), /microSequence\.imagePaths must contain exactly 5/],
    ['interval sample', (value) => { value.targets[0].intervalRef.previousSample.frameIndex += 1 }, /previousSample must equal overview sample 1/],
    ['anchor provenance', (value) => { value.targets[0].microSequence.samples[2].frameOffset = 1 }, /must contain exactly one canonical anchor sample/],
    ['duplicate target id', (value) => { value.targets[1].targetRef.id = value.targets[0].targetRef.id }, /target ids must be unique/],
    ['candidate provenance', (value) => { value.targets[0].targetRef.candidateTimesSeconds[0] += 0.01 }, /candidateTimesSeconds does not match machineEvidence/],
  ]) {
    const invalid = structuredClone(original)
    mutate(invalid)
    await assert.rejects(requestPacket(inputPath, invalid), expected, name)
  }
})

test('dry-run validates input v2 and persists a credential-free request only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-dry-'))
  const inputPath = await makeInput(root, 1)
  const cacheRoot = path.join(root, 'cache')
  const secret = 'sk-fixture-must-never-be-written'
  const summary = await runReviewBatch({
    inputPath,
    cacheRoot,
    dryRun: true,
    config: {baseUrl: 'https://vision.example.test/gateway', apiKey: secret, model: 'gpt-4o-mini'},
  })

  assert.equal(summary.selected, 1)
  assert.equal(summary.schemaVersion, 'editorial-vlm-run-summary-v2')
  assert.equal(summary.totalTargetCount, 2)
  assert.equal(summary.totalImageCount, 15)
  assert.equal(summary.generated, 1)
  assert.equal(summary.requested, 0)
  assert.deepEqual(summary.items.map(({reviewId, targetCount, imageCount, status}) => ({reviewId, targetCount, imageCount, status})), [
    {reviewId: 'fixture-boundary-001', targetCount: 2, imageCount: 15, status: 'dry_run'},
  ])
  const files = await listFiles(cacheRoot)
  assert.equal(files.filter((file) => file.endsWith('request.json')).length, 1)
  assert.equal(files.some((file) => file.endsWith('response.json')), false)
  for (const file of files) assert.doesNotMatch(await readFile(file, 'utf8'), new RegExp(secret))
})

test('successful review saves provider raw, model annotation, and canonical enriched response', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-evidence-'))
  const inputPath = await makeInput(root, 1)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const annotation = await readFixture('vlm-review-response.valid.json')
  const cacheRoot = path.join(root, 'cache')
  const secret = 'sk-runtime-only-secret'
  let requestCount = 0

  const first = await runReviewBatch({
    inputPath,
    cacheRoot,
    config: {baseUrl: 'https://vision.example.test', apiKey: secret, model: 'gpt-4o-mini'},
    minIntervalMs: 0,
    fetchImpl: async (_url, init) => {
      requestCount += 1
      assert.equal(init.headers.Authorization, `Bearer ${secret}`)
      return chatResponse(annotation)
    },
    sleep: async () => {},
  })
  assert.equal(first.completed, 1)
  assert.equal(requestCount, 1)

  const second = await runReviewBatch({
    inputPath,
    cacheRoot,
    config: {baseUrl: 'https://vision.example.test', apiKey: secret, model: 'gpt-4o-mini'},
    minIntervalMs: 0,
    fetchImpl: async () => { throw new Error('valid canonical cache must resume without a request') },
    sleep: async () => {},
  })
  assert.equal(second.skipped, 1)

  const files = await listFiles(cacheRoot)
  const providerPath = files.find((file) => file.endsWith('provider-raw.json'))
  const annotationPath = files.find((file) => file.endsWith('model-annotation.json'))
  const responsePath = files.find((file) => file.endsWith('response.json'))
  assert.ok(providerPath)
  assert.ok(annotationPath)
  assert.ok(responsePath)
  const savedAnnotation = JSON.parse(await readFile(annotationPath, 'utf8'))
  const savedResponse = JSON.parse(await readFile(responsePath, 'utf8'))
  assert.deepEqual(savedAnnotation, annotation)
  assert.equal(Object.hasOwn(savedAnnotation.targetObservations[0], 'targetRef'), false)
  assert.deepEqual(savedResponse.targetObservations[0].targetRef, input.reviews[0].targets[0].targetRef)
  assert.deepEqual(savedResponse.targetObservations[0].intervalRef, input.reviews[0].targets[0].intervalRef)
  for (const file of files) assert.doesNotMatch(await readFile(file, 'utf8'), new RegExp(secret))
})

test('cache resumes only when provider, model, and enriched evidence agree', async () => {
  const annotation = await readFixture('vlm-review-response.valid.json')

  for (const [name, corrupt] of [
    [
      'request identity',
      async (files) => {
        const file = files.find((candidate) => candidate.endsWith('request.json'))
        const value = JSON.parse(await readFile(file, 'utf8'))
        value.reviewId = 'tampered-review-id'
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
      },
    ],
    [
      'provider evidence',
      async (files) => writeFile(files.find((file) => file.endsWith('provider-raw.json')), '{}\n'),
    ],
    [
      'model annotation',
      async (files) => {
        const file = files.find((candidate) => candidate.endsWith('model-annotation.json'))
        const value = JSON.parse(await readFile(file, 'utf8'))
        value.reviewNotes = ['tampered model annotation']
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
      },
    ],
    [
      'enriched response',
      async (files) => {
        const file = files.find((candidate) => candidate.endsWith('response.json'))
        const value = JSON.parse(await readFile(file, 'utf8'))
        value.reviewNotes = ['tampered enriched response']
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
      },
    ],
    [
      'commit metadata',
      async (files) => {
        const file = files.find((candidate) => candidate.endsWith('meta.json'))
        const value = JSON.parse(await readFile(file, 'utf8'))
        value.status = 'failed'
        await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
      },
    ],
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-cache-evidence-'))
    const inputPath = await makeInput(root, 1)
    const cacheRoot = path.join(root, 'cache')
    const config = {baseUrl: 'https://vision.example.test', apiKey: 'runtime-secret', model: 'gpt-4o-mini'}
    let requestCount = 0
    const fetchImpl = async () => {
      requestCount += 1
      return chatResponse(annotation)
    }

    const first = await runReviewBatch({inputPath, cacheRoot, config, minIntervalMs: 0, fetchImpl, sleep: async () => {}})
    assert.equal(first.completed, 1, name)
    await corrupt(await listFiles(cacheRoot))
    const second = await runReviewBatch({inputPath, cacheRoot, config, minIntervalMs: 0, fetchImpl, sleep: async () => {}})
    assert.equal(second.completed, 1, name)
    assert.equal(second.skipped, 0, name)
    assert.equal(requestCount, 2, name)
  }
})

test('failed forced runs cannot revive stale canonical evidence and attempts remain isolated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-force-failure-'))
  const inputPath = await makeInput(root, 1)
  const annotation = await readFixture('vlm-review-response.valid.json')
  const cacheRoot = path.join(root, 'cache')
  const config = {baseUrl: 'https://vision.example.test', apiKey: 'runtime-secret', model: 'gpt-4o-mini'}
  let requestCount = 0

  const successResponse = async () => {
    requestCount += 1
    return chatResponse(annotation)
  }
  const initial = await runReviewBatch({
    inputPath,
    cacheRoot,
    config,
    minIntervalMs: 0,
    fetchImpl: successResponse,
    sleep: async () => {},
  })
  assert.equal(initial.completed, 1)

  const failedForce = await runReviewBatch({
    inputPath,
    cacheRoot,
    config,
    force: true,
    maxAttempts: 1,
    minIntervalMs: 0,
    fetchImpl: async () => {
      requestCount += 1
      return new Response('forced failure', {status: 400})
    },
    sleep: async () => {},
  })
  assert.equal(failedForce.failed, 1)

  const retry = await runReviewBatch({
    inputPath,
    cacheRoot,
    config,
    minIntervalMs: 0,
    fetchImpl: successResponse,
    sleep: async () => {},
  })
  assert.equal(retry.completed, 1)
  assert.equal(retry.skipped, 0)
  assert.equal(requestCount, 3)

  const attemptFiles = (await listFiles(cacheRoot)).filter((file) => file.endsWith('provider-raw.attempt-01.json'))
  assert.equal(attemptFiles.length, 3)
  assert.equal(new Set(attemptFiles.map((file) => path.dirname(file))).size, 3)
})

test('schema failure issues at most one non-identical repair request with validator errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-repair-'))
  const inputPath = await makeInput(root, 1)
  const annotation = await readFixture('vlm-review-response.valid.json')
  const bodies = []

  const result = await runReviewBatch({
    inputPath,
    cacheRoot: path.join(root, 'cache'),
    config: {baseUrl: 'https://vision.example.test', apiKey: 'runtime-secret', model: 'gpt-4o-mini'},
    maxAttempts: 5,
    retryBaseMs: 0,
    minIntervalMs: 0,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return bodies.length === 1 ? chatResponse({targetObservations: []}) : chatResponse(annotation)
    },
    sleep: async () => {},
  })

  assert.equal(result.completed, 1)
  assert.equal(bodies.length, 2)
  assert.notDeepEqual(bodies[0], bodies[1])
  assert.equal(bodies[1].messages.at(-2).role, 'assistant')
  assert.equal(bodies[1].messages.at(-1).role, 'user')
  assert.match(bodies[1].messages.at(-1).content, /validator errors/i)
  assert.match(bodies[1].messages.at(-1).content, /targetObservations/)
})

test('a second schema-invalid response fails without a third model request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-repair-limit-'))
  const inputPath = await makeInput(root, 1)
  let requestCount = 0
  const result = await runReviewBatch({
    inputPath,
    cacheRoot: path.join(root, 'cache'),
    config: {baseUrl: 'https://vision.example.test', apiKey: 'runtime-secret', model: 'gpt-4o-mini'},
    maxAttempts: 9,
    retryBaseMs: 0,
    minIntervalMs: 0,
    fetchImpl: async () => {
      requestCount += 1
      return chatResponse({targetObservations: []})
    },
    sleep: async () => {},
  })
  assert.equal(result.failed, 1)
  assert.equal(requestCount, 2)
  assert.equal((await listFiles(path.join(root, 'cache'))).some((file) => file.endsWith('response.json')), false)
})

test('CLI dry-run honors selection without requiring or printing an API key', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vlm-review-cli-'))
  const inputPath = await makeInput(root)
  const cacheRoot = path.join(root, 'cache')
  const secret = 'sk-cli-environment-secret'
  const completed = spawnSync(process.execPath, [
    path.join(scriptDirectory, 'vlm_review.mjs'),
    '--input', inputPath,
    '--cache-root', cacheRoot,
    '--base-url', 'https://vision.example.test',
    '--dry-run',
    '--review-id', 'fixture-beat-002',
  ], {
    encoding: 'utf8',
    env: {...process.env, EDITORIAL_VLM_API_KEY: secret},
  })

  assert.equal(completed.status, 0, completed.stderr)
  const summary = JSON.parse(completed.stdout)
  assert.equal(summary.selected, 1)
  assert.equal(summary.generated, 1)
  assert.equal(summary.totalTargetCount, 1)
  assert.equal(summary.totalImageCount, 10)
  assert.equal(summary.items[0].status, 'dry_run')
  assert.doesNotMatch(completed.stdout, new RegExp(secret))
  assert.doesNotMatch(completed.stderr, new RegExp(secret))
})
