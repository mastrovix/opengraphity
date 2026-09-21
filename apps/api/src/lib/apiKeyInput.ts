/**
 * I campi di una chiave API che l'amministratore sceglie: il nome, il limite di
 * richieste al minuto e la scadenza (revisione totale del 16 set 2026 · G-1, A-6).
 *
 * ## Il difetto
 * Il form Integrazioni parte con «Scade il» vuoto e lo spediva così: `''`. Il
 * resolver scriveva `expires_at: input.expiresAt ?? null`, e `''` non è nullish,
 * quindi il nodo nasceva con `expires_at = ''`. L'autenticazione filtra
 * `k.expires_at IS NULL OR k.expires_at > $now`: una stringa vuota non è NULL e
 * non è maggiore di nessuna data → **ogni chiave creata senza scadenza non
 * funzionava mai**, con la pagina che la mostrava attiva. Con una data scelta il
 * valore era `2026-12-31`, confrontato come stringa con un istante ISO: la chiave
 * scadeva alle 00:00 UTC di quel giorno, cioè la sera prima in Italia.
 *
 * Il limite al minuto non era validato: `0` o un negativo rendevano la chiave
 * inutilizzabile (429 a ogni chiamata), e l'API ripiegava in silenzio su 60 per
 * le chiavi senza il campo.
 *
 * ## La regola
 * - `expiresAt` assente, `null` o `''` = nessuna scadenza (si scrive NULL);
 * - una data `AAAA-MM-GG` vale **fino alla fine di quel giorno nel fuso
 *   dell'organizzazione**: si scrive l'istante UTC dell'inizio del giorno dopo, e
 *   la chiave vale finché `now < expires_at`;
 * - un istante ISO completo si normalizza a `toISOString()`, così il confronto
 *   fra stringhe nella query resta un confronto fra istanti;
 * - qualunque altra cosa è un errore; una scadenza già passata, alla creazione,
 *   pure (nascerebbe una chiave morta);
 * - il limite al minuto è obbligatorio e intero in `API_KEY_RATE_LIMIT_MIN..MAX`.
 */
import { zonedTimeToUtc } from '@opengraphity/sla'
import { ValidationError } from './errors.js'

export const API_KEY_RATE_LIMIT_MIN = 1
export const API_KEY_RATE_LIMIT_MAX = 100_000

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

export function assertApiKeyName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('The API key needs a name', { key: 'errors.apiKey.nameRequired' })
  }
  return value.trim()
}

/**
 * Il limite che l'autenticazione usava in silenzio per le chiavi senza il
 * campo: la migrazione 20261001_1000 lo scrive. In LETTURA una chiave non
 * ancora migrata non deve far fallire l'intera pagina: si mostra questo valore
 * e si logga la chiave.
 */
export const LEGACY_API_KEY_RATE_LIMIT = 60

export function isApiKeyRateLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= API_KEY_RATE_LIMIT_MIN && value <= API_KEY_RATE_LIMIT_MAX
}

export function assertApiKeyRateLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < API_KEY_RATE_LIMIT_MIN || value > API_KEY_RATE_LIMIT_MAX) {
    throw new ValidationError(
      `rateLimit must be a whole number of requests per minute from ${API_KEY_RATE_LIMIT_MIN} to ${API_KEY_RATE_LIMIT_MAX} (got ${JSON.stringify(value ?? null)})`,
      { key: 'errors.apiKey.rateLimit', params: { min: String(API_KEY_RATE_LIMIT_MIN), max: String(API_KEY_RATE_LIMIT_MAX) } },
    )
  }
  return value
}

/**
 * La scadenza da scrivere sul nodo: `null` (nessuna) o un istante ISO UTC.
 * `timeZone` è il fuso dell'organizzazione, necessario solo per una data senza ora.
 */
export function normalizeApiKeyExpiry(value: unknown, timeZone: string | null): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw invalidExpiry(value)
  const raw = value.trim()
  if (raw === '') return null

  const dateOnly = DATE_ONLY_RE.exec(raw)
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])]
    const day = new Date(Date.UTC(y, m - 1, d))
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) throw invalidExpiry(value)
    if (!timeZone) {
      throw new ValidationError(
        'The organization has no time zone: the end of the expiry day cannot be computed. Set the time zone in Organization settings.',
        { key: 'errors.apiKey.expiryNeedsTimezone' },
      )
    }
    const next = new Date(Date.UTC(y, m - 1, d + 1))
    return zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone).toISOString()
  }

  if (ISO_INSTANT_RE.test(raw)) {
    const ms = Date.parse(raw)
    if (Number.isNaN(ms)) throw invalidExpiry(value)
    return new Date(ms).toISOString()
  }
  throw invalidExpiry(value)
}

/** Alla creazione una scadenza già passata non ha senso: la chiave nascerebbe morta. */
export function assertExpiryInFuture(expiresAt: string | null, now: Date = new Date()): string | null {
  if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) {
    throw new ValidationError('The expiry date is already past: the key would never work', { key: 'errors.apiKey.expiryInPast' })
  }
  return expiresAt
}

function invalidExpiry(value: unknown): ValidationError {
  return new ValidationError(
    `expiresAt must be a date (YYYY-MM-DD), an ISO instant, or empty for no expiry (got ${JSON.stringify(value)})`,
    { key: 'errors.apiKey.expiryFormat' },
  )
}
