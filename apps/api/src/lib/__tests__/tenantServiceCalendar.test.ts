/**
 * Revisione del 14 set 2026 · F6: il calendario di servizio (giorni, fascia
 * oraria, festività) si sceglie dalla pagina Organizzazione e vale per le policy
 * SLA e i contratti OLA in orario lavorativo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn(async () => {}) })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
vi.mock('@opengraphity/sla', async () => {
  const cal = await import('../../../../../packages/sla/src/calendar.js')
  return { parseServiceCalendar: cal.parseServiceCalendar, ServiceCalendarError: cal.ServiceCalendarError }
})

const { setTenantServiceCalendar, tenantServiceCalendar } = await import('../tenantServiceCalendar.js')
const { ValidationError } = await import('../errors.js')

describe('calendario di servizio del cliente', () => {
  beforeEach(() => { runQueryOne.mockReset() })

  it('salva il calendario normalizzato', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    const out = await setTenantServiceCalendar('t1', { days: [5, 1, 1], start: '09:00', end: '17:30', holidays: ['2026-12-25'] })
    expect(out).toEqual({ days: [1, 5], start: '09:00', end: '17:30', holidays: ['2026-12-25'] })
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('SET t.service_calendar = $calendar')
    expect(JSON.parse(String(params['calendar']))).toEqual(out)
  })

  it('un calendario non valido è rifiutato con una chiave i18n e il motivo, senza scrivere', async () => {
    const err = await setTenantServiceCalendar('t1', { days: [1], start: '18:00', end: '08:00', holidays: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as { extensions: { i18n: { key: string; params: Record<string, string> } } }).extensions.i18n).toEqual({ key: 'errors.tenant.serviceCalendar.end_before_start', params: { start: '18:00', end: '08:00' } })
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('lettura: null se non configurato', async () => {
    runQueryOne.mockResolvedValueOnce({ calendar: null })
    expect(await tenantServiceCalendar('t1')).toBeNull()
  })
})
