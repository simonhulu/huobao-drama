import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const skillRoot = fileURLToPath(new URL('../..', import.meta.url));

export function readJson(relativePath) {
  const absolutePath = join(skillRoot, relativePath);
  assert.ok(existsSync(absolutePath), `missing contract file: ${relativePath}`);
  return JSON.parse(readFileSync(absolutePath, 'utf8'));
}

export function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    strictRequired: false,
  });
  ajv.addKeyword({keyword: 'x-editorial-map', schemaType: 'boolean'});
  addFormats(ajv);

  const registry = readJson('contracts/schema-registry.json');
  for (const entry of registry.schemas) {
    ajv.addSchema(readJson(`contracts/${entry.file}`));
  }
  return ajv;
}

export function assertValid(validate, value) {
  assert.equal(validate(value), true, JSON.stringify(validate.errors, null, 2));
}

export function assertInvalid(validate, value) {
  assert.equal(validate(value), false, 'expected schema validation to fail');
}

export function clone(value) {
  return structuredClone(value);
}

export function collectObjectSchemas(value, pointer = '#', result = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }

  if (value.type === 'object') {
    result.push({pointer, schema: value});
  }

  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object') {
      collectObjectSchemas(child, `${pointer}/${key}`, result);
    }
  }
  return result;
}
