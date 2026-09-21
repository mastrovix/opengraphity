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

/** Il formato corrente delle credenziali cifrate (E-41): come `secretBox.ts`. */
export const CREDENTIALS_PREFIX = 'v1:'

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

  // Layout: `v1:` | base64 di IV (12) | authTag (16) | ciphertext.
  // Il PREFISSO DI VERSIONE (revisione totale · E-41) mancava, a differenza
  // di `secretBox.ts` che lo ha: senza, una rotazione della chiave o un
  // cambio di formato dava lo stesso «Decryption failed» di un dato corrotto,
  // e non si poteva distinguere «chiave vecchia» da «dato rotto». Le
  // credenziali già salvate NON hanno il prefisso e continuano a leggersi.
  const result = Buffer.concat([iv, authTag, encrypted])
  return CREDENTIALS_PREFIX + result.toString('base64')
}

export function decryptCredentials(
  encrypted:     string,
  encryptionKey: string,
): Record<string, string> {
  const key  = resolveKey(encryptionKey)
  /**
   * E-41: `v1:` è il formato di oggi; senza prefisso è una credenziale
   * salvata prima (stesso layout, stessa chiave) e si legge com'è. Un
   * prefisso che non conosciamo è un'ALTRA cosa, e lo si dice invece di
   * confonderlo con una chiave sbagliata.
   */
  const versioned = encrypted.startsWith(CREDENTIALS_PREFIX)
  const other     = /^v\d+:/.exec(encrypted)
  if (!versioned && other) {
    throw new Error(
      `Stored credentials are in format "${other[0]}", which this version cannot read: `
      + 'they were written by a newer OpenGrafo. Update this instance, or re-enter the credentials.',
    )
  }
  const payload = versioned ? encrypted.slice(CREDENTIALS_PREFIX.length) : encrypted
  const buf  = Buffer.from(payload, 'base64')

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
