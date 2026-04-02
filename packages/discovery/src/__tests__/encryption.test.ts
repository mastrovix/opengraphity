import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateEncryptionKey,
  generateEncryptionKey,
  encryptCredentials,
  decryptCredentials,
} from '../encryption.js'

describe('validateEncryptionKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accetta una chiave hex valida di 64 caratteri', () => {
    expect(validateEncryptionKey('a'.repeat(64))).toBe(true)
  })

  it('accetta una chiave hex mista maiuscolo/minuscolo', () => {
    expect(validateEncryptionKey('aAbBcCdDeEfF0123456789aAbBcCdDeEfF0123456789aAbBcCdDeEfF01234567')).toBe(true)
  })

  it('rifiuta una stringa troppo corta', () => {
    expect(validateEncryptionKey('a'.repeat(32))).toBe(false)
  })

  it('rifiuta una stringa troppo lunga', () => {
    expect(validateEncryptionKey('a'.repeat(65))).toBe(false)
  })

  it('rifiuta caratteri non hex', () => {
    expect(validateEncryptionKey('g'.repeat(64))).toBe(false)
  })

  it('rifiuta una stringa con spazi', () => {
    expect(validateEncryptionKey('a'.repeat(63) + ' ')).toBe(false)
  })

  it('rifiuta una stringa vuota', () => {
    expect(validateEncryptionKey('')).toBe(false)
  })
})

describe('generateEncryptionKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('genera una chiave di 64 caratteri', () => {
    const key = generateEncryptionKey()
    expect(key).toHaveLength(64)
  })

  it('genera una chiave hex valida', () => {
    const key = generateEncryptionKey()
    expect(validateEncryptionKey(key)).toBe(true)
  })

  it('genera chiavi diverse ad ogni chiamata', () => {
    const key1 = generateEncryptionKey()
    const key2 = generateEncryptionKey()
    expect(key1).not.toBe(key2)
  })
})

describe('encryptCredentials + decryptCredentials', () => {
  const VALID_KEY = 'a'.repeat(64)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('roundtrip: encrypt → decrypt restituisce l\'oggetto originale', () => {
    const plaintext = { username: 'admin', password: 'secret' }
    const encrypted = encryptCredentials(plaintext, VALID_KEY)
    const decrypted = decryptCredentials(encrypted, VALID_KEY)
    expect(decrypted).toEqual(plaintext)
  })

  it('encrypt produce una stringa base64 non vuota', () => {
    const encrypted = encryptCredentials({ username: 'admin', password: 'secret' }, VALID_KEY)
    expect(typeof encrypted).toBe('string')
    expect(encrypted.length).toBeGreaterThan(0)
  })

  it('encrypt produce output diverso ad ogni chiamata (IV casuale)', () => {
    const plaintext = { username: 'admin', password: 'secret' }
    const enc1 = encryptCredentials(plaintext, VALID_KEY)
    const enc2 = encryptCredentials(plaintext, VALID_KEY)
    expect(enc1).not.toBe(enc2)
  })

  it('decryptCredentials con chiave sbagliata lancia errore con messaggio Decryption failed', () => {
    const plaintext = { username: 'admin', password: 'secret' }
    const encrypted = encryptCredentials(plaintext, VALID_KEY)
    const wrongKey = 'b'.repeat(64)
    expect(() => decryptCredentials(encrypted, wrongKey)).toThrow('Decryption failed')
  })

  it('encryptCredentials con chiave non valida lancia errore', () => {
    expect(() => encryptCredentials({ username: 'admin' }, 'troppo_corta')).toThrow()
  })

  it('decryptCredentials con chiave non valida lancia errore', () => {
    const plaintext = { username: 'admin', password: 'secret' }
    const encrypted = encryptCredentials(plaintext, VALID_KEY)
    expect(() => decryptCredentials(encrypted, 'invalida')).toThrow()
  })

  it('roundtrip con oggetto complesso', () => {
    const plaintext = { host: 'db.example.com', port: '5432', user: 'readonly', password: 'p@$$w0rd!', token: 'abc123' }
    const encrypted = encryptCredentials(plaintext, VALID_KEY)
    const decrypted = decryptCredentials(encrypted, VALID_KEY)
    expect(decrypted).toEqual(plaintext)
  })
})
