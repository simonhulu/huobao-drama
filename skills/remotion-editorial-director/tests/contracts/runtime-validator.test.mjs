import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {createContractValidator} from '../../scripts/lib/contract-validator.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = async (name) => JSON.parse(
  await readFile(path.join(skillRoot, 'fixtures/json', name), 'utf8'),
);

test('runtime validator loads the complete registry and validates named contracts', async () => {
  const validator = await createContractValidator({
    contractsDirectory: path.join(skillRoot, 'contracts'),
  });
  assert.equal(validator.validate('recipeV2', await fixture('recipe-v2-minimal.json')), true);
  assert.equal(
    validator.validate('authoringResult', await fixture('authoring-result-minimal.json')),
    true,
  );
});

test('runtime validator fails closed with stable JSON pointer diagnostics', async () => {
  const validator = await createContractValidator({
    contractsDirectory: path.join(skillRoot, 'contracts'),
  });
  const recipe = await fixture('recipe-v2-minimal.json');
  recipe.unknown = true;
  assert.throws(
    () => validator.validate('recipeV2', recipe),
    (error) => error.code === 'SCHEMA_VALIDATION_FAILED' &&
      error.schemaName === 'recipeV2' &&
      error.diagnostics.some(({keyword, instancePath}) =>
        keyword === 'additionalProperties' && instancePath === ''),
  );
  assert.throws(
    () => validator.validate('not-a-contract', {}),
    (error) => error.code === 'SCHEMA_NOT_REGISTERED',
  );
});
