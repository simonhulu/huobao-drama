import path from 'node:path';

import {hashPayload} from './canonical-json.mjs';
import {hashFile} from './media-facts-cache.mjs';

const producer = Object.freeze({name: 'remotion-editorial-director', version: '0.1.0'});

export const promoteArtifact = async ({
  artifactType,
  createdAt = new Date().toISOString(),
  inputHashes,
  payload,
  relativePath,
  runId,
  schemaName,
  store,
  validator,
}) => {
  validator.validate(schemaName, payload);
  const schemaEntry = validator.registry.schemas.find(({name}) => name === schemaName);
  if (!schemaEntry) {
    throw Object.assign(new Error(`Schema is not registered: ${schemaName}`), {
      code: 'SCHEMA_NOT_REGISTERED',
    });
  }
  const contentHash = hashPayload(payload);
  const envelope = {
    artifactType,
    contentHash,
    createdAt,
    inputHashes,
    payload,
    producer,
    runId,
    schemaVersion: 'editorial://schema/artifact-envelope/v1',
  };
  validator.validate('artifactEnvelope', envelope);
  await store.promoteJson(relativePath, envelope);
  const absolutePath = path.resolve(store.root, relativePath);
  return {
    contentHash,
    envelope,
    reference: {
      artifactType,
      path: absolutePath,
      schemaId: schemaEntry.id,
      sha256: await hashFile(absolutePath),
    },
  };
};
