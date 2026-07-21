import {readFile} from 'node:fs/promises';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  ...fields,
});

export const createContractValidator = async ({contractsDirectory}) => {
  const registry = JSON.parse(
    await readFile(path.join(contractsDirectory, 'schema-registry.json'), 'utf8'),
  );
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);
  ajv.addKeyword({keyword: 'x-editorial-map', schemaType: ['boolean', 'object', 'string']});
  const entriesByName = new Map();
  const loaded = [];
  for (const entry of registry.schemas) {
    const schema = JSON.parse(await readFile(path.join(contractsDirectory, entry.file), 'utf8'));
    if (schema.$id !== entry.id) {
      throw codedError(
        'SCHEMA_REGISTRY_ID_MISMATCH',
        `Schema ${entry.name} declares ${schema.$id}, expected ${entry.id}`,
      );
    }
    entriesByName.set(entry.name, entry);
    loaded.push(schema);
  }
  for (const schema of loaded) ajv.addSchema(schema);

  return {
    registry,
    validate(name, value) {
      const entry = entriesByName.get(name) ?? registry.schemas.find(({id}) => id === name);
      if (!entry) throw codedError('SCHEMA_NOT_REGISTERED', `Schema is not registered: ${name}`);
      const validator = ajv.getSchema(entry.id);
      if (!validator(value)) {
        throw codedError('SCHEMA_VALIDATION_FAILED', `Value failed ${entry.name} validation`, {
          diagnostics: validator.errors.map(({instancePath, keyword, message, params, schemaPath}) => ({
            instancePath,
            keyword,
            message,
            params,
            schemaPath,
          })),
          exitCode: 4,
          schemaId: entry.id,
          schemaName: entry.name,
        });
      }
      return true;
    },
  };
};
