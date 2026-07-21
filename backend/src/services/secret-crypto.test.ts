import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const keyDir = mkdtempSync(join(tmpdir(), 'huobao-secret-crypto-'))
process.env.AI_CONFIG_KEY_FILE = join(keyDir, 'first.key')

const { decryptSecret, encryptSecret, isEncryptedSecret } = await import('./secret-crypto.js')

test('strictly distinguishes authenticated ciphertext shape from a matching prefix', () => {
  assert.equal(isEncryptedSecret('enc:v1:not-valid'), false)
  assert.equal(isEncryptedSecret('plain-key'), false)

  const encrypted = encryptSecret('plain-key')
  assert.equal(isEncryptedSecret(encrypted), true)
  assert.equal(decryptSecret(encrypted), 'plain-key')
  assert.throws(() => decryptSecret('enc:v1:not-valid'), /Invalid encrypted AI config secret format/)
})

test('production rejects weak configured master keys', () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousConfiguredKey = process.env.AI_CONFIG_ENCRYPTION_KEY
  process.env.NODE_ENV = 'production'
  process.env.AI_CONFIG_ENCRYPTION_KEY = 'weak-passphrase'
  try {
    assert.throws(() => encryptSecret('must-fail'), /must be 64-character hex or valid 32-byte base64/)
  } finally {
    if (previousNodeEnv == null) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousConfiguredKey == null) delete process.env.AI_CONFIG_ENCRYPTION_KEY
    else process.env.AI_CONFIG_ENCRYPTION_KEY = previousConfiguredKey
  }
})
