import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PREFIX = 'enc:v1:'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const keyCache = new Map<string, Buffer>()
type KeySource = { cacheKey: string; configured?: string; keyPath?: string }
let boundKeySource: KeySource | null = null

function defaultKeyPath(dbPath?: string) {
  const resolvedDbPath = dbPath || process.env.DB_PATH || path.resolve(process.cwd(), '../data/huobao_drama.db')
  return process.env.AI_CONFIG_KEY_FILE || path.join(path.dirname(resolvedDbPath), '.ai-config-encryption-key')
}

function decodeStrictKey(raw: string): Buffer | null {
  const value = raw.trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex')

  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === KEY_BYTES && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
    return decoded
  }

  return null
}

function decodeConfiguredKey(raw: string) {
  const strictKey = decodeStrictKey(raw)
  if (strictKey) return strictKey

  if (process.env.NODE_ENV === 'production') {
    throw new Error('AI_CONFIG_ENCRYPTION_KEY must be 64-character hex or valid 32-byte base64 in production')
  }

  return createHash('sha256').update(raw.trim(), 'utf8').digest()
}

function resolveKeySource(dbPath?: string): KeySource {
  const configured = process.env.AI_CONFIG_ENCRYPTION_KEY
  if (configured) {
    return {
      cacheKey: `env:${createHash('sha256').update(configured).digest('hex')}`,
      configured,
    }
  }

  const keyPath = path.resolve(defaultKeyPath(dbPath))
  return { cacheKey: `file:${keyPath}`, keyPath }
}

export function bindSecretKeyToDatabase(dbPath: string) {
  boundKeySource ||= resolveKeySource(dbPath)
}

function loadKey() {
  const source = boundKeySource || resolveKeySource()
  if (source.configured) {
    const cached = keyCache.get(source.cacheKey)
    if (cached) return cached
    const key = decodeConfiguredKey(source.configured)
    keyCache.set(source.cacheKey, key)
    return key
  }

  const keyPath = source.keyPath!
  const cached = keyCache.get(source.cacheKey)
  if (cached) return cached
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })

  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, randomBytes(KEY_BYTES).toString('base64'), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
  }

  fs.chmodSync(keyPath, 0o600)
  const key = decodeConfiguredKey(fs.readFileSync(keyPath, 'utf8'))
  keyCache.set(source.cacheKey, key)
  return key
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (!value) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '') ? decoded : null
}

function parseEncryptedSecret(value: string) {
  if (!value.startsWith(PREFIX)) return null
  const parts = value.slice(PREFIX.length).split(':')
  if (parts.length !== 3) return null

  const iv = decodeCanonicalBase64(parts[0])
  const tag = decodeCanonicalBase64(parts[1])
  const ciphertext = decodeCanonicalBase64(parts[2])
  if (iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES || !ciphertext?.length) return null
  return { iv, tag, ciphertext }
}

export function isEncryptedSecret(value: string) {
  return Boolean(parseEncryptedSecret(value))
}

export function encryptSecret(value: string) {
  if (!value) return value

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptSecret(value: string) {
  if (!value || !value.startsWith(PREFIX)) return value
  const parsed = parseEncryptedSecret(value)
  if (!parsed) throw new Error('Invalid encrypted AI config secret format')

  try {
    const decipher = createDecipheriv('aes-256-gcm', loadKey(), parsed.iv)
    decipher.setAuthTag(parsed.tag)
    return Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]).toString('utf8')
  } catch (error) {
    const keyLocation = boundKeySource?.keyPath || defaultKeyPath()
    throw new Error(`Unable to decrypt AI config secret. Check AI_CONFIG_ENCRYPTION_KEY or ${keyLocation}`, {
      cause: error,
    })
  }
}

export function maskSecret(value: string) {
  if (!value) return null
  return `****${value.slice(-4)}`
}
