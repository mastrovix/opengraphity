/**
 * Migrazione 20260925_1200_step_deadlines (verifica «Cosa resta cablato»,
 * ondata 3): la chiusura automatica `schedule_job(auto_close)` diventa la
 * scadenza del passo, con la stessa durata e lo stesso arrivo; le azioni
 * ritirate si tolgono.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stepDeadlines, autoCloseHours } from '../20260925_1200_step_deadlines.js'
import { MIGRATIONS } from '../index.js'

interface Row { id: string; definitionId: string; tenantId: string; definition: string; step: string; enter: string | null; exit: string | null; deadline: string | null; closedStep: string | null }

function fakeSession(rows: Row[]) {
  const writes: Array<Record<string, unknown>> = []
  return {
    writes,
    run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
      if (cypher.includes('CONTAINS \'schedule_job\'')) return { records: rows.map((r) => ({ get: (k: keyof Row) => r[k] })) }
      writes.push(params)
      return { records: [] }
    }),
  }
}

// Il dato vivo su c-one, c-two e c-test: «resolved» di entrambi i workflow degli incident.
const LIVE: Row = {
  id: 'def-1-step-resolved', definitionId: 'def-1', tenantId: 'c-test', definition: 'Incident Management', step: 'resolved',
  enter: JSON.stringify([{ type: 'sla_stop', params: { sla_type: 'resolve' } }, { type: 'schedule_job', params: { job: 'auto_close', delay_hours: '72' } }]),
  exit: JSON.stringify([{ type: 'cancel_job', params: { job: 'auto_close' } }]),
  deadline: null, closedStep: 'closed',
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260925_1200_step_deadlines', () => {
  it('è registrata dopo gli obiettivi di conformità', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260925_1200_step_deadlines')).toBeGreaterThan(ids.indexOf('20260925_1140_compliance_objectives'))
  })

  it('il caso vivo: 72 ore 24×7 verso «closed», le due azioni tolte, sla_stop resta', async () => {
    const s = fakeSession([LIVE])
    await stepDeadlines.up(s as never)
    expect(s.writes).toHaveLength(1)
    const w = s.writes[0]!
    expect(w).toMatchObject({ id: 'def-1-step-resolved', definitionId: 'def-1', tenantId: 'c-test' })
    expect(JSON.parse(w['deadline'] as string)).toEqual({ after: 72, unit: 'hours', calendar_id: null, to_step: 'closed', set_fields: [] })
    expect(JSON.parse(w['enter'] as string)).toEqual([{ type: 'sla_stop', params: { sla_type: 'resolve' } }])
    expect(JSON.parse(w['exit'] as string)).toEqual([])
  })

  it('senza un arco verso un passo «closed» non nasce una scadenza (non si chiudeva nemmeno prima), ma le azioni si tolgono', async () => {
    const s = fakeSession([{ ...LIVE, closedStep: null }])
    await stepDeadlines.up(s as never)
    expect(s.writes[0]!['deadline']).toBeNull()
    expect(JSON.parse(s.writes[0]!['enter'] as string)).toEqual([{ type: 'sla_stop', params: { sla_type: 'resolve' } }])
  })

  it('una scadenza già scelta dal cliente non si sovrascrive', async () => {
    const own = JSON.stringify({ after: 5, unit: 'days', calendar_id: 'cal-1', to_step: 'closed', set_fields: [] })
    const s = fakeSession([{ ...LIVE, deadline: own }])
    await stepDeadlines.up(s as never)
    expect(s.writes[0]!['deadline']).toBe(own)
  })

  it('un schedule_job con un altro nome (che nessun lavoratore eseguiva) si toglie e si nomina', async () => {
    const s = fakeSession([{ ...LIVE, enter: JSON.stringify([{ type: 'schedule_job', params: { job: 'ping', delay_hours: '1' } }]), exit: null }])
    await stepDeadlines.up(s as never)
    expect(JSON.parse(s.writes[0]!['enter'] as string)).toEqual([])
    expect(s.writes[0]!['deadline']).toBeNull()
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('schedule_job(ping)')
  })

  it('autoCloseHours: durata assente o non valida → nessuna scadenza', () => {
    expect(autoCloseHours([{ type: 'schedule_job', params: { job: 'auto_close', delay_hours: '48' } }])).toBe(48)
    expect(autoCloseHours([{ type: 'schedule_job', params: { job: 'auto_close' } }])).toBeNull()
    expect(autoCloseHours([{ type: 'sla_stop' }])).toBeNull()
  })

  it('idempotente: senza azioni ritirate la lettura non trova niente e non scrive', async () => {
    const s = fakeSession([])
    await stepDeadlines.up(s as never)
    expect(s.writes).toEqual([])
  })
})
