import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LENGTH       = 12   // AES-GCM standard IV
const AUTH_TAG_LENGTH = 16   // AES-GCM auth tag

// ── Key validation ────────────────────────────────────────────────────────────

export function validateEncryptionKey(key: string): boolean {
  return typeof key === 'string' && /^[0-9a-fA-F]{64}$/.test(key)
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex')
}

function resolveKey(encryptionKey: string): Buffer {
  if (!encryptionKey) {
    throw new Error('DISCOVERY_ENCRYPTION_KEY not set')
  }
  if (!validateEncryptionKey(encryptionKey)) {
    throw new Error('DISCOVERY_ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
  }
  return Buffer.from(encryptionKey, 'hex')
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────────

export function encryptCredentials(
  plaintext:     Record<string, string>,
  encryptionKey: string,
): string {
  const key        = resolveKey(encryptionKey)
  const iv         = randomBytes(IV_LENGTH)
  const cipher     = createCipheriv('aes-256-gcm', key, iv)
  const json       = JSON.stringify(plaintext)
  const encrypted  = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const authTag    = cipher.getAuthTag()

  // Layout: IV (12) | authTag (16) | ciphertext
  const result = Buffer.concat([iv, authTag, encrypted])
  return result.toString('base64')
}

export function decryptCredentials(
  encrypted:     string,
  encryptionKey: string,
): Record<string, string> {
  const key  = resolveKey(encryptionKey)
  const buf  = Buffer.from(encrypted, 'base64')

  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Decryption failed: invalid key or corrupted data')
  }

  const iv         = buf.subarray(0, IV_LENGTH)
  const authTag    = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(decrypted.toString('utf8')) as Record<string, string>
  } catch {
    throw new Error('Decryption failed: invalid key or corrupted data')
  }
}
