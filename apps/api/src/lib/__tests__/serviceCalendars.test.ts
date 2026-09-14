/**
 * Verifica «Cosa resta cablato», ondata 2: i calendari di servizio con nome.
 * Un calendario incoerente o senza nome è rifiutato; uno in uso non si elimina.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn(async () => {}) })),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
vi.mock('@opengraphity/sla', async () => {
  const cal = await import('../../../../../packages/sla/src/calendar.js')
  return { parseServiceCalendar: cal.parseServiceCalendar, ServiceCalendarError: cal.ServiceCalendarError }
})

const { createServiceCalendar, deleteServiceCalendar } = await import('../serviceCalendars.js')

const WEEK = { days: [5, 1, 2, 3, 4], start: '08:00', end: '18:00', holidays: ['2026-12-25'] }

beforeEach(() => { runQuery.mockReset(); runQueryOne.mockReset() })

describe('calendari di servizio con nome', () => {
  it('crea il calendario normalizzato col suo nome', async () => {
    runQueryOne.mockResolvedValueOnce(null) // nessun omonimo
    runQuery.mockResolvedValueOnce([])
    const out = await createServiceCalendar('t1', { name: '  Turno NOC  ', calendar: WEEK })
    expect(out).toMatchObject({ name: 'Turno NOC', days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00', usedBySlaPolicies: [], usedByOlaContracts: [] })
    const [, cypher, params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('CREATE (c:ServiceCalendar')
    expect(params).toMatchObject({ tenantId: 't1', name: 'Turno NOC', days: [1, 2, 3, 4, 5] })
  })

  it('senza nome, con un nome già usato o con orari incoerenti è rifiutato senza scrivere', async () => {
    await expect(createServiceCalendar('t1', { name: ' ', calendar: WEEK })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.serviceCalendar.name' } } })
    await expect(createServiceCalendar('t1', { name: 'Notte', calendar: { ...WEEK, start: '18:00', end: '08:00' } }))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.tenant.serviceCalendar.end_before_start' } } })
    runQueryOne.mockResolvedValueOnce({ id: 'cal-1' })
    await expect(createServiceCalendar('t1', { name: 'turno noc', calendar: WEEK })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.serviceCalendar.duplicateName' } } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('un calendario in uso non si elimina, e il rifiuto nomina chi lo usa', async () => {
    runQuery.mockResolvedValueOnce([{ id: 'cal-1', name: 'Turno NOC', ...WEEK, policies: ['Incident di rete'], contracts: ['OLA Rete'] }])
    await expect(deleteServiceCalendar('t1', 'cal-1')).rejects.toThrow(/used by Incident di rete, OLA Rete/)
    expect(runQuery).toHaveBeenCalledTimes(1)
  })
})
