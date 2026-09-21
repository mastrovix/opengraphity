/**
 * Revisione totale del 16 set 2026 · G-1/A-6: la chiave API creata dal web senza
 * scadenza nasceva con `expires_at = ''` e non funzionava mai; una data scadeva
 * alle 00:00 UTC; il limite al minuto non era validato.
 */
import { describe, it, expect } from 'vitest'
import { assertApiKeyName, assertApiKeyRateLimit, assertExpiryInFuture, normalizeApiKeyExpiry } from '../apiKeyInput.js'

describe('normalizeApiKeyExpiry', () => {
  it.each([undefined, null, '', '   '])('%j = nessuna scadenza (NULL, che la query di autenticazione accetta)', (v) => {
    expect(normalizeApiKeyExpiry(v, 'Europe/Rome')).toBeNull()
  })

  it('una data vale fino alla fine di quel giorno nel fuso dell\'organizzazione', () => {
    // 31 dic 2026 a Roma finisce alle 23:00 UTC (ora solare, +1)
    expect(normalizeApiKeyExpiry('2026-12-31', 'Europe/Rome')).toBe('2026-12-31T23:00:00.000Z')
    // 30 giu 2026 a Roma finisce alle 22:00 UTC (ora legale, +2)
    expect(normalizeApiKeyExpiry('2026-06-30', 'Europe/Rome')).toBe('2026-06-30T22:00:00.000Z')
    expect(normalizeApiKeyExpiry('2026-06-30', 'America/New_York')).toBe('2026-07-01T04:00:00.000Z')
  })

  it('un istante ISO si normalizza a toISOString (confronto fra stringhe = confronto fra istanti)', () => {
    expect(normalizeApiKeyExpiry('2026-12-31T18:30:00+01:00', null)).toBe('2026-12-31T17:30:00.000Z')
  })

  it('una data senza fuso dell\'organizzazione non si può calcolare: errore, non UTC in silenzio', () => {
    expect(() => normalizeApiKeyExpiry('2026-12-31', null)).toThrow(/time zone/)
  })

  it.each(['31/12/2026', '2026-02-30', 'domani', 42])('%j non è una scadenza', (v) => {
    expect(() => normalizeApiKeyExpiry(v, 'Europe/Rome')).toThrow(/expiresAt must be/)
  })

  it('alla creazione una scadenza già passata è rifiutata', () => {
    const now = new Date('2026-09-16T10:00:00Z')
    expect(() => assertExpiryInFuture('2026-09-16T09:59:59.000Z', now)).toThrow(/already past/)
    expect(assertExpiryInFuture('2026-09-17T00:00:00.000Z', now)).toBe('2026-09-17T00:00:00.000Z')
    expect(assertExpiryInFuture(null, now)).toBeNull()
  })
})

describe('assertApiKeyRateLimit / assertApiKeyName', () => {
  it.each([0, -5, 1.5, 100_001, undefined, '60'])('%j non è un limite valido', (v) => {
    expect(() => assertApiKeyRateLimit(v)).toThrow(/rateLimit must be/)
  })
  it('un intero nel range passa', () => { expect(assertApiKeyRateLimit(1000)).toBe(1000) })
  it('il nome è obbligatorio e si toglie lo spazio attorno', () => {
    expect(() => assertApiKeyName('  ')).toThrow(/needs a name/)
    expect(assertApiKeyName(' Import ')).toBe('Import')
  })
})
