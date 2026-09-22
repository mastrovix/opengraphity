/**
 * ORGANIZATION SECRETS AT REST.
 *
 * A tenant's Slack bot token (and the signing secret of its own app, when it
 * has one) lives in the graph, not in an environment variable shared by
 * everyone. In the graph it is encrypted with AES-256-GCM under the platform
 * key — so whoever can read a Neo4j dump still cannot post as anybody's bot.
 *
 * GCM is authenticated encryption: the point of the tag is that a tampered
 * ciphertext FAILS instead of decrypting to something else. These tests pin
 * that, plus the two ways the key itself can be wrong — because a key that is
 * missing or mistyped must stop the write, not produce something unreadable
 * that nobody notices until the next Slack message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encryptSecret, decryptSecret, secretsKeyConfigured } from '../secretBox.js'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const original = process.env['SECRETS_ENCRYPTION_KEY']

beforeEach(() => { process.env['SECRETS_ENCRYPTION_KEY'] = KEY_A })
afterEach(() => {
  if (original === undefined) delete process.env['SECRETS_ENCRYPTION_KEY']
  else process.env['SECRETS_ENCRYPTION_KEY'] = original
})

describe('secretsKeyConfigured', () => {
  it('is true only for 64 hexadecimal characters, in either case', () => {
    for (const ok of [KEY_A, 'A'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      process.env['SECRETS_ENCRYPTION_KEY'] = ok
      expect(secretsKeyConfigured()).toBe(true)
    }
  })

  it('is false when the key is missing, too short, too long or not hex', () => {
    for (const bad of [undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'not a key']) {
      if (bad === undefined) delete process.env['SECRETS_ENCRYPTION_KEY']
      else process.env['SECRETS_ENCRYPTION_KEY'] = bad
      expect(secretsKeyConfigured()).toBe(false)
    }
  })
})

describe('encryptSecret / decryptSecret', () => {
  it('a secret comes back exactly as it went in', () => {
    for (const secret of ['xoxb-1234567890-abcdef', '', 'accenti à è ì ò ù and 🔐', 'x'.repeat(5000)]) {
      expect(decryptSecret(encryptSecret(secret))).toBe(secret)
    }
  })

  it('the same secret encrypts differently every time: the IV is random', () => {
    // Without a fresh IV, two organizations using the same token would have
    // identical ciphertexts in the graph — anyone reading it could tell.
    const a = encryptSecret('xoxb-same')
    const b = encryptSecret('xoxb-same')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe(decryptSecret(b))
  })

  it('the stored form is versioned and carries no plaintext', () => {
    // The `v1:` prefix is what a future key rotation reads to recognise the
    // old format instead of guessing.
    const sealed = encryptSecret('xoxb-super-secret-token')
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(sealed).not.toContain('xoxb')
    expect(sealed).not.toContain('secret')
  })

  it('a ciphertext saved under another key does not decrypt: it says the key is wrong', () => {
    // The message names the cause. "Stored secret cannot be decrypted" alone
    // would send whoever reads it looking for graph corruption.
    const sealed = encryptSecret('xoxb-token')
    process.env['SECRETS_ENCRYPTION_KEY'] = KEY_B
    expect(() => decryptSecret(sealed)).toThrow('SECRETS_ENCRYPTION_KEY is not the key it was saved with')
  })

  it('a TAMPERED ciphertext fails instead of decrypting to something else', () => {
    // This is the whole point of GCM over plain AES: an attacker with write
    // access to the graph must not be able to flip the token into another one.
    const sealed = encryptSecret('xoxb-original')
    const raw = Buffer.from(sealed.slice(3), 'base64')
    raw[raw.length - 1] ^= 0xff          // one bit of the ciphertext
    expect(() => decryptSecret(`v1:${raw.toString('base64')}`)).toThrow(/cannot be decrypted/)

    const tag = Buffer.from(sealed.slice(3), 'base64')
    tag[13] ^= 0xff                      // one bit of the auth tag
    expect(() => decryptSecret(`v1:${tag.toString('base64')}`)).toThrow(/cannot be decrypted/)
  })

  it('a value with no version prefix, or too short to hold IV and tag, is refused as corrupt', () => {
    expect(() => decryptSecret('xoxb-plaintext-written-by-hand')).toThrow('Stored secret has an unknown format')
    expect(() => decryptSecret('v2:whatever')).toThrow('Stored secret has an unknown format')
    expect(() => decryptSecret(`v1:${Buffer.from('short').toString('base64')}`)).toThrow('Stored secret is corrupted')
  })

  it('with no key at all nothing is written and nothing is read, and the error says which variable', () => {
    const sealed = encryptSecret('xoxb-token')
    delete process.env['SECRETS_ENCRYPTION_KEY']
    expect(() => encryptSecret('x')).toThrow('SECRETS_ENCRYPTION_KEY is not set')
    expect(() => decryptSecret(sealed)).toThrow('SECRETS_ENCRYPTION_KEY is not set')
  })

  it('a key of the wrong shape is refused before it is used, naming the shape expected', () => {
    // A 32-character key would otherwise fail deep inside node:crypto with
    // "Invalid key length", which says nothing about which variable to fix.
    process.env['SECRETS_ENCRYPTION_KEY'] = 'a'.repeat(32)
    expect(() => encryptSecret('x')).toThrow('SECRETS_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)')
  })
})
