import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';

import canonicalize from 'canonicalize';

import {
  assertInvalid,
  assertValid,
  clone,
  collectObjectSchemas,
  createAjv,
  readJson,
  skillRoot,
} from './helpers.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_RECIPE_SCHEMA_SHA256 =
  '5536da349e4ace73c5f128811896b422081f7c899f775b54e0bfa48057b67786';
const REQUIRED_PROTOCOL_SCHEMAS = {
  inputManifest: 'editorial://schema/input-manifest/v1',
  timedTranscript: 'editorial://schema/timed-transcript/v1',
  run: 'editorial://schema/run/v1',
  semanticOutline: 'editorial://schema/semantic-outline/v1',
  agentRequest: 'editorial://schema/agent-request/v1',
  agentResponse: 'editorial://schema/agent-response/v1',
  authoringResult: 'editorial://schema/authoring-result/v1',
  corpusEvidence: 'editorial://schema/corpus-evidence/v1',
  boundarySamples: 'editorial://schema/boundary-samples/v1',
  evidence: 'editorial://schema/evidence/v1',
  techniqueAnnotations: 'editorial://schema/technique-annotations/v1',
  assetInventory: 'editorial://schema/asset-inventory/v1',
  validationReport: 'editorial://schema/validation-report/v1',
  recipeLock: 'editorial://schema/recipe-lock/v1',
  adapterConfig: 'editorial://schema/adapter-config/v1',
  adapterRequest: 'editorial://schema/adapter-request/v1',
  adapterResponse: 'editorial://schema/adapter-response/v1',
  adapterCapabilities: 'editorial://schema/adapter-capabilities/v1',
  rendererEnvironmentLock: 'editorial://schema/renderer-environment-lock/v1',
  remotionProps: 'editorial://schema/remotion-props/v1',
  renderManifest: 'editorial://schema/render-manifest/v1',
  inspectReport: 'editorial://schema/inspect-report/v1',
  layoutTelemetry: 'editorial://schema/layout-telemetry/v1',
  qaReport: 'editorial://schema/qa-report/v1',
  calibrationPolicy: 'editorial://schema/calibration-policy/v1',
};

test('schema registry fixes the production and migration version identities', () => {
  const registry = readJson('contracts/schema-registry.json');
  const byName = Object.fromEntries(registry.schemas.map((entry) => [entry.name, entry]));

  assert.equal(registry.registryVersion, 1);
  assert.equal(byName.recipeV2.id, 'editorial://schema/magnates-remotion-recipe/v2');
  assert.equal(byName.recipeV1.role, 'migration-input-only');
  assert.equal(byName.artifactEnvelope.id, 'editorial://schema/artifact-envelope/v1');
  assert.equal(byName.adapterRequest.id, 'editorial://schema/adapter-request/v1');
  assert.equal(byName.adapterResponse.id, 'editorial://schema/adapter-response/v1');
  for (const [name, id] of Object.entries(REQUIRED_PROTOCOL_SCHEMAS)) {
    assert.equal(byName[name]?.id, id, name);
  }
});

test('every registered production schema compiles under the shared strict validator', () => {
  const registry = readJson('contracts/schema-registry.json');
  const ajv = createAjv();
  for (const entry of registry.schemas.filter((candidate) => candidate.role !== 'migration-input-only')) {
    assert.equal(typeof ajv.getSchema(entry.id), 'function', entry.id);
  }
});

test('all v1 director and adapter schemas are closed at every declared object boundary', () => {
  const registry = readJson('contracts/schema-registry.json');
  const entries = registry.schemas.filter((entry) => entry.role !== 'migration-input-only');

  for (const entry of entries) {
    const schema = readJson(`contracts/${entry.file}`);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.$id, entry.id);

    for (const {pointer, schema: objectSchema} of collectObjectSchemas(schema)) {
      const isNamedMap = objectSchema['x-editorial-map'] === true;
      if (isNamedMap) {
        assert.notEqual(objectSchema.additionalProperties, true, `${entry.file}${pointer}`);
      } else {
        assert.equal(objectSchema.additionalProperties, false, `${entry.file}${pointer}`);
      }
    }
  }
});

test('legacy recipe v1 schema remains byte-identical and migration-only', () => {
  const bytes = readFileSync(join(skillRoot, 'contracts/magnates-remotion-recipe-v1.schema.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), LEGACY_RECIPE_SCHEMA_SHA256);

  const ajv = createAjv();
  const v1 = readJson('fixtures/json/recipe-v1-minimal.json');
  const v2 = readJson('fixtures/json/recipe-v2-minimal.json');
  assertValid(ajv.getSchema('https://huobao.local/schemas/magnates-media-recipe-v1.json'), v1);
  assertInvalid(ajv.getSchema('editorial://schema/magnates-remotion-recipe/v2'), v1);
  assertInvalid(ajv.getSchema('https://huobao.local/schemas/magnates-media-recipe-v1.json'), v2);
});

test('recipe v2 accepts inventory identities and rejects paths, missing cue identities, and unknown fields', () => {
  const validate = createAjv().getSchema('editorial://schema/magnates-remotion-recipe/v2');
  const recipe = readJson('fixtures/json/recipe-v2-minimal.json');
  assertValid(validate, recipe);

  const withPath = clone(recipe);
  withPath.shots[0].background.src = '/tmp/asset.png';
  assertInvalid(validate, withPath);

  const withoutSubjectId = clone(recipe);
  delete withoutSubjectId.shots[0].texts[0].subjectId;
  assertInvalid(validate, withoutSubjectId);

  const counterWithoutMetric = clone(recipe);
  delete counterWithoutMetric.shots[0].texts[1].metricId;
  assertInvalid(validate, counterWithoutMetric);

  const unknown = clone(recipe);
  unknown.shots[0].surprise = true;
  assertInvalid(validate, unknown);
});

test('artifact envelope closes metadata and binds payload shape to artifact type', () => {
  const validate = createAjv().getSchema('editorial://schema/artifact-envelope/v1');
  const artifact = readJson('fixtures/json/artifact-recipe-v2.json');
  assertValid(validate, artifact);

  const unknown = clone(artifact);
  unknown.mutable = true;
  assertInvalid(validate, unknown);

  const wrongPayload = clone(artifact);
  wrongPayload.artifactType = 'adapter-request';
  assertInvalid(validate, wrongPayload);
});

test('artifact envelope correlates every durable production payload in the registry', () => {
  const registry = readJson('contracts/schema-registry.json');
  const envelope = readJson('contracts/artifact-envelope.schema.json');
  const expected = registry.schemas
    .filter(({name, role}) => role === 'production' && !['common', 'artifactEnvelope'].includes(name))
    .map(({name, id}) => [
      name === 'recipeV2' ? 'recipe-v2' : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      id,
    ]);
  const payloadSchemaByType = new Map(
    envelope.allOf.map((branch) => [
      branch.if.properties.artifactType.const,
      branch.then.properties.payload.$ref,
    ]),
  );

  assert.deepEqual([...envelope.properties.artifactType.enum].sort(), expected.map(([type]) => type).sort());
  assert.deepEqual([...payloadSchemaByType.entries()].sort(), expected.sort());
});

test('adapter schemas accept the conformance fixtures and reject drift', () => {
  const ajv = createAjv();
  const config = readJson('fixtures/json/adapter-config.json');
  const capabilities = readJson('fixtures/json/adapter-capabilities.json');
  const request = readJson('fixtures/json/adapter-request-build-props.json');
  const response = readJson('fixtures/json/adapter-response-build-props.json');

  assertValid(ajv.getSchema('editorial://schema/adapter-config/v1'), config);
  assertValid(ajv.getSchema('editorial://schema/adapter-capabilities/v1'), capabilities);
  assertValid(ajv.getSchema('editorial://schema/adapter-request/v1'), request);
  assertValid(ajv.getSchema('editorial://schema/adapter-response/v1'), response);

  const v1Request = clone(request);
  v1Request.recipeSchemaVersion = 'magnates-remotion-recipe-v1';
  assertInvalid(ajv.getSchema('editorial://schema/adapter-request/v1'), v1Request);

  const wrongInputs = clone(request);
  wrongInputs.inputs.media = '/tmp/output.mp4';
  assertInvalid(ajv.getSchema('editorial://schema/adapter-request/v1'), wrongInputs);

  const unknownResponse = clone(response);
  unknownResponse.debug = true;
  assertInvalid(ajv.getSchema('editorial://schema/adapter-response/v1'), unknownResponse);
});

test('semantic, agent, authoring, inspection, and telemetry fixtures satisfy their closed contracts', () => {
  const ajv = createAjv();
  const fixtures = [
    ['editorial://schema/semantic-outline/v1', 'fixtures/json/semantic-outline-minimal.json'],
    ['editorial://schema/agent-request/v1', 'fixtures/json/agent-authoring-request.json'],
    ['editorial://schema/agent-response/v1', 'fixtures/json/agent-authoring-response.json'],
    ['editorial://schema/authoring-result/v1', 'fixtures/json/authoring-result-minimal.json'],
    ['editorial://schema/layout-telemetry/v1', 'fixtures/json/layout-telemetry-minimal.json'],
    ['editorial://schema/inspect-report/v1', 'fixtures/json/inspect-report-minimal.json'],
  ];

  for (const [schemaId, fixturePath] of fixtures) {
    assertValid(ajv.getSchema(schemaId), readJson(fixturePath));
  }

  const response = readJson('fixtures/json/agent-authoring-response.json');
  response.requestHash = 'not-a-hash';
  assertInvalid(ajv.getSchema('editorial://schema/agent-response/v1'), response);
});

test('typed error registry is closed and matches adapter response codes and exits', () => {
  const ajv = createAjv();
  const registry = readJson('contracts/error-codes.json');
  assertValid(ajv.getSchema('editorial://schema/error-codes/v1'), registry);

  const codes = registry.errors.map((entry) => entry.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.includes('INTERNAL_ERROR'));
  assert.ok(codes.includes('PROTOCOL_VERSION_MISMATCH'));
  assert.ok(codes.includes('CANCELLED'));

  const exitByCategory = new Map();
  for (const entry of registry.errors) {
    if (exitByCategory.has(entry.category)) {
      assert.equal(exitByCategory.get(entry.category), entry.exitCode);
    } else {
      exitByCategory.set(entry.category, entry.exitCode);
    }
  }

  const responseSchema = readJson('contracts/adapter-response.schema.json');
  assert.deepEqual(responseSchema.$defs.error.properties.code.enum, codes);
});

test('RFC 8785 vectors have stable canonical bytes and per-vector SHA-256 digests', () => {
  const vectors = readJson('fixtures/json/rfc8785-vectors.json');
  assert.ok(vectors.length >= 5);

  for (const vector of vectors) {
    const canonical = canonicalize(vector.input);
    assert.equal(canonical, vector.canonical, vector.name);
    assert.match(vector.sha256, SHA256_PATTERN);
    assert.equal(createHash('sha256').update(canonical).digest('hex'), vector.sha256, vector.name);
  }
});
