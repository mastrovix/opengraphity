/**
 * I SEGRETI DI UN'ORGANIZZAZIONE, CIFRATI (ondata 8 di «Nulla cablato»).
 *
 * Il token di Slack di un'organizzazione (e il segreto di firma della sua app,
 * se ne ha una propria) stanno nel grafo, non in una variabile d'ambiente
 * condivisa da tutti. Nel grafo stanno CIFRATI: AES-256-GCM con la chiave della
 * piattaforma `SECRETS_ENCRYPTION_KEY` (64 caratteri esadecimali). Senza la
 * chiave non si salva e non si legge niente, e l'errore lo dice.
 *
 * Formato: base64 di IV (12) | tag (16) | testo cifrato, prefissato da `v1:`
 * così una rotazione futura della chiave riconosce i dati vecchi.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LENGTH = 12
const TAG_LENGTH = 16
const PREFIX = 'v1:'

export function secretsKeyConfigured(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(process.env['SECRETS_ENCRYPTION_KEY'] ?? '')
}

function key(): Buffer {
  const raw = process.env['SECRETS_ENCRYPTION_KEY']
  if (!raw) throw new Error('SECRETS_ENCRYPTION_KEY is not set: organization secrets (Slack) cannot be stored or read')
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('SECRETS_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes)')
  return Buffer.from(raw, 'hex')
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function decryptSecret(sealed: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error('Stored secret has an unknown format')
  const buf = Buffer.from(sealed.slice(PREFIX.length), 'base64')
  if (buf.length < IV_LENGTH + TAG_LENGTH) throw new Error('Stored secret is corrupted')
  const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, IV_LENGTH))
  decipher.setAuthTag(buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
  try {
    return Buffer.concat([decipher.update(buf.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Stored secret cannot be decrypted: SECRETS_ENCRYPTION_KEY is not the key it was saved with')
  }
}
