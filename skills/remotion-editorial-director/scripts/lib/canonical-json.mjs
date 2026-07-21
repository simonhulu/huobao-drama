import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import canonicalize from 'canonicalize';

const codedError = (code, message, fields = {}) => Object.assign(new Error(message), {
  code,
  ...fields,
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const assertUnicode = (value, location) => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw codedError('INVALID_JSON_UNICODE', `Lone high surrogate at ${location}`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw codedError('INVALID_JSON_UNICODE', `Lone low surrogate at ${location}`);
    }
  }
};

const validateJsonValue = (value, location = '$') => {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assertUnicode(value, location);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw codedError('INVALID_JSON_VALUE', `Non-finite number at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${location}[${index}]`));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      assertUnicode(key, `${location} key`);
      validateJsonValue(item, `${location}.${key}`);
    }
    return;
  }
  throw codedError('INVALID_JSON_VALUE', `Unsupported JSON value at ${location}`);
};

export const assertSafeJsonInteger = (value, location = '$') => {
  if (!Number.isSafeInteger(value)) {
    throw codedError('UNSAFE_JSON_INTEGER', `Unsafe integer at ${location}`);
  }
};

export const canonicalizePayload = (payload) => {
  validateJsonValue(payload);
  return canonicalize(payload);
};

export const hashPayload = (payload) => sha256(canonicalizePayload(payload));

export const parseStrictJson = (source) => {
  if (typeof source !== 'string') {
    throw codedError('INVALID_JSON', 'JSON source must be a string');
  }
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
  };
  const fail = (message, code = 'INVALID_JSON') => {
    throw codedError(code, `${message} at byte ${Buffer.byteLength(source.slice(0, cursor))}`);
  };
  const parseString = () => {
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor];
      if (!escaped && character === '"') {
        cursor += 1;
        let value;
        try {
          value = JSON.parse(source.slice(start, cursor));
        } catch {
          fail('Invalid JSON string');
        }
        assertUnicode(value, '$');
        return value;
      }
      if (!escaped && character.charCodeAt(0) < 0x20) fail('Unescaped control character');
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      cursor += 1;
    }
    fail('Unterminated JSON string');
  };
  const parseValue = () => {
    skipWhitespace();
    const character = source[cursor];
    if (character === '"') return parseString();
    if (character === '{') {
      cursor += 1;
      skipWhitespace();
      const value = {};
      const keys = new Set();
      if (source[cursor] === '}') {
        cursor += 1;
        return value;
      }
      for (;;) {
        skipWhitespace();
        if (source[cursor] !== '"') fail('Object key must be a string');
        const key = parseString();
        if (keys.has(key)) fail(`Duplicate object key ${JSON.stringify(key)}`, 'DUPLICATE_JSON_KEY');
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ':') fail('Expected colon after object key');
        cursor += 1;
        value[key] = parseValue();
        skipWhitespace();
        if (source[cursor] === '}') {
          cursor += 1;
          return value;
        }
        if (source[cursor] !== ',') fail('Expected comma between object members');
        cursor += 1;
      }
    }
    if (character === '[') {
      cursor += 1;
      skipWhitespace();
      const value = [];
      if (source[cursor] === ']') {
        cursor += 1;
        return value;
      }
      for (;;) {
        value.push(parseValue());
        skipWhitespace();
        if (source[cursor] === ']') {
          cursor += 1;
          return value;
        }
        if (source[cursor] !== ',') fail('Expected comma between array items');
        cursor += 1;
      }
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, cursor)) {
        cursor += literal.length;
        return value;
      }
    }
    const match = source.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) fail('Invalid JSON value');
    cursor += match[0].length;
    const value = Number(match[0]);
    validateJsonValue(value);
    return value;
  };

  const value = parseValue();
  skipWhitespace();
  if (cursor !== source.length) fail('Trailing content after JSON value');
  validateJsonValue(value);
  return value;
};

const atomicWrite = async (destination, bytes) => {
  await mkdir(path.dirname(destination), {recursive: true});
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, {flag: 'wx'});
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
};

export const writeEnvelope = async (destination, {payload, schema, metadata = {}}) => {
  const contentHash = hashPayload(payload);
  const envelope = {contentHash, metadata, payload, schema};
  const bytes = `${canonicalizePayload(envelope)}\n`;
  await atomicWrite(destination, bytes);
  return {artifactHash: sha256(bytes), contentHash, envelope};
};

export const verifyEnvelope = async (filePath) => {
  const bytes = await readFile(filePath, 'utf8');
  const envelope = parseStrictJson(bytes);
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    typeof envelope.contentHash !== 'string' ||
    !Object.hasOwn(envelope, 'payload')
  ) {
    throw codedError('INVALID_ARTIFACT_ENVELOPE', `Invalid artifact envelope: ${filePath}`);
  }
  const contentHash = hashPayload(envelope.payload);
  if (contentHash !== envelope.contentHash) {
    throw codedError('ARTIFACT_CONTENT_HASH_MISMATCH', `Artifact payload hash mismatch: ${filePath}`);
  }
  return {
    artifactHash: sha256(bytes),
    contentHash,
    metadata: envelope.metadata,
    payload: envelope.payload,
    schema: envelope.schema,
  };
};
