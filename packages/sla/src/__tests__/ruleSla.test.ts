/**
 * AU-4 (revisione del 14 set 2026): lo SLA di una regola. Prima l'azione
 * creava uno `SLAStatus` senza nessun job (mai un avviso, mai una violazione),
 * lasciava in coda i job del vecchio stato e usava `Europe/Rome` per tutti.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runs: { cypher: string; params: Record<string, unknown> }[] = []
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    runs.push({ cypher, params })
    return [{ id: params['id'], tenant_id: params['tenantId'], entity_id: params['entityId'], entity_type: params['entityType'],
      started_at: params['startedAt'], response_deadline: params['responseDeadline'], resolve_deadline: params['resolveDeadline'],
      response_met: false, resolve_met: false, breached: false, tier_severity: 'custom', tier_response_minutes: params['response'], tier_resolve_minutes: params['resolve'], tier_business_hours: false }]
  }),
  runQueryOne: vi.fn(),
}))
vi.mock('../scheduler.js', () => ({ cancelSLAJobs: vi.fn(), scheduleWarning: vi.fn(), scheduleBreachCheck: vi.fn(), scheduleResponseCheck: vi.fn() }))
vi.mock('../olaBreach.js', () => ({ getTenantTimezone: vi.fn(async () => 'America/New_York') }))

const { applyRuleSLA, assertRuleSLAMinutes } = await import('../ruleSla.js')
const scheduler = await import('../scheduler.js')

beforeEach(() => { vi.clearAllMocks(); runs.length = 0 })

describe('applyRuleSLA', () => {
  it('annulla i job vecchi, sostituisce lo stato e programma avviso, breach e risposta', async () => {
    const start = new Date('2026-09-14T10:00:00Z')
    const s = await applyRuleSLA({ tenantId: 't1', entityType: 'incident', entityId: 'i1', responseMinutes: 15, resolveMinutes: 120, ruleName: 'Security critico', startedAt: start })
    expect(scheduler.cancelSLAJobs).toHaveBeenCalledWith('i1', 'both')
    expect(runs[0]!.cypher).toContain('DETACH DELETE old')
    expect(runs[0]!.params).toMatchObject({ ruleName: 'Security critico', resolveDeadline: '2026-09-14T12:00:00.000Z' })
    for (const f of [scheduler.scheduleWarning, scheduler.scheduleBreachCheck, scheduler.scheduleResponseCheck]) expect(f).toHaveBeenCalledWith(s)
  })

  it('minuti non validi → errore, niente scritto', async () => {
    await expect(applyRuleSLA({ tenantId: 't1', entityType: 'incident', entityId: 'i1', responseMinutes: 0, resolveMinutes: 120, ruleName: 'R' })).rejects.toThrow(/positive whole numbers/)
    expect(() => assertRuleSLAMinutes(300, 60)).toThrow(/cannot be later/)
    expect(runs).toHaveLength(0)
  })
})
