/**
 * Revisione del 14 set 2026 · F6: l'orario lavorativo delle policy SLA e dei
 * contratti OLA era 08:00–18:00, lunedì–venerdì, senza festività, per tutti i
 * clienti. Ora è il calendario di servizio del cliente.
 */
import { describe, it, expect } from 'vitest'
import { calculateDeadline } from '../policy.js'
import { FACTORY_SERVICE_CALENDAR, parseServiceCalendar } from '../calendar.js'

describe('calendario di servizio', () => {
  it('giorni e fasce del cliente: lun–sab 09:00–13:00', () => {
    const cal = parseServiceCalendar({ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:00', holidays: [] })
    // venerdì 12:00 UTC + 120 min → 60 il venerdì, 60 il sabato dalle 09:00 → sabato 10:00
    expect(calculateDeadline(new Date('2026-09-18T12:00:00Z'), 120, true, 'UTC', cal).toISOString()).toBe('2026-09-19T10:00:00.000Z')
  })

  it('le festività non sono giorni lavorativi', () => {
    const cal = parseServiceCalendar({ ...FACTORY_SERVICE_CALENDAR, holidays: ['2026-12-25'] })
    // giovedì 24/12 17:00 + 120 → 60 il giovedì, venerdì 25 festa, weekend, lunedì 28 alle 09:00
    expect(calculateDeadline(new Date('2026-12-24T17:00:00Z'), 120, true, 'UTC', cal).toISOString()).toBe('2026-12-28T09:00:00.000Z')
  })

  it('orario lavorativo senza calendario: un errore che lo dice, non le 08–18', () => {
    expect(() => calculateDeadline(new Date('2026-09-18T12:00:00Z'), 60, true, 'UTC', null)).toThrow(/calendar/i)
  })

  it('il calendario di fabbrica è quello che il codice usava', () => {
    expect(FACTORY_SERVICE_CALENDAR).toEqual({ days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', holidays: [] })
  })

  it.each([
    [{ days: [], start: '08:00', end: '18:00', holidays: [] }, /day/],
    [{ days: [7], start: '08:00', end: '18:00', holidays: [] }, /day/],
    [{ days: [1], start: '18:00', end: '08:00', holidays: [] }, /end/],
    [{ days: [1], start: '8', end: '18:00', holidays: [] }, /HH:MM/],
    [{ days: [1], start: '08:00', end: '18:00', holidays: ['25/12/2026'] }, /YYYY-MM-DD/],
    ['nope', /object/],
  ])('calendario non valido → errore (%o)', (raw, message) => {
    expect(() => parseServiceCalendar(raw)).toThrow(message)
  })
})

/** Verifica «Cosa resta cablato», ondata 2: il calendario è quello scelto da ogni policy o contratto. */
describe('calendarFor', () => {
  it('24×7 non legge nessun calendario', async () => {
    const { calendarFor } = await import('../calendar.js')
    expect(await calendarFor('t1', { name: 'P1 incident', businessHours: false, calendarId: null })).toBeNull()
  })

  it('orario di servizio senza calendario scelto → errore che nomina chi lo porta', async () => {
    const { calendarFor } = await import('../calendar.js')
    await expect(calendarFor('t1', { name: 'Rete', businessHours: true, calendarId: null }))
      .rejects.toThrow(/"Rete" counts service hours but has no service calendar/)
  })
})
