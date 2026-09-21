/**
 * Revisione del 14 set 2026 · F7: le date dei PDF erano scritte nel fuso
 * `Europe/Rome` per ogni cliente. Ora nel fuso del cliente.
 */
import { describe, it, expect } from 'vitest'
import { fmtDate } from '../common.js'

describe('fmtDate', () => {
  const instant = '2026-01-15T12:00:00.000Z'

  it('scrive la data nel fuso del cliente', () => {
    expect(fmtDate(instant, { timeZone: 'America/New_York', language: 'en' })).toContain('07:00')
    expect(fmtDate(instant, { timeZone: 'Asia/Tokyo', language: 'en' })).toContain('21:00')
  })

  it('valore assente → trattino', () => {
    expect(fmtDate(null, { timeZone: 'UTC', language: 'en' })).toBe('—')
  })
})
