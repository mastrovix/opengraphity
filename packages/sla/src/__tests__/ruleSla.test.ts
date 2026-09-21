/**
 * AU-4 (revisione del 14 set 2026): lo SLA di una regola. Prima l'azione
 * creava uno `SLAStatus` senza nessun job (mai un avviso, mai una violazione),
 * lasciava in coda i job del vecchio stato e usava `Europe/Rome` per tutti.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runs: { cypher: string; params: Record<string, unknown> }[] = []
let previous: Record<string, unknown> | null = null
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    runs.push({ cypher, params })
    return [{ id: params['id'], tenant_id: params['tenantId'], entity_id: params['entityId'], entity_type: params['entityType'],
      started_at: params['startedAt'], response_deadline: params['responseDeadline'], resolve_deadline: params['resolveDeadline'],
      response_met: false, resolve_met: false, breached: false, tier_severity: 'custom', tier_response_minutes: params['response'], tier_resolve_minutes: params['resolve'], tier_business_hours: false }]
  }),
  // E-9: `applyRuleSLA` rilegge lo stato precedente (`getSLAStatus`) per non
  // azzerare il tempo già passato.
  runQueryOne: vi.fn(async () => previous),
}))
vi.mock('../scheduler.js', () => ({ cancelSLAJobs: vi.fn(), scheduleWarning: vi.fn(), scheduleBreachCheck: vi.fn(), scheduleResponseCheck: vi.fn() }))
vi.mock('../olaBreach.js', () => ({ getTenantTimezone: vi.fn(async () => 'America/New_York') }))

const { applyRuleSLA, assertRuleSLAMinutes } = await import('../ruleSla.js')
const scheduler = await import('../scheduler.js')

beforeEach(() => { vi.clearAllMocks(); runs.length = 0; previous = null })

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

/**
 * Revisione totale · E-9: la precedenza fra regola e policy non era
 * dichiarata. `applyRuleSLA` cancellava QUALUNQUE SLA — anche uno di policy in
 * corso — e, se la regola scattava di nuovo (per esempio su `on_update`),
 * l'orologio ripartiva da «adesso»: il tempo già consumato spariva.
 */
describe('la regola vince, ma non azzera il tempo già passato (E-9)', () => {
  const statoPrecedente = {
    id: 'sla-0', tenant_id: 't1', entity_id: 'i1', entity_type: 'incident',
    started_at: '2026-09-14T08:00:00.000Z',
    response_deadline: '2026-09-14T09:00:00.000Z', resolve_deadline: '2026-09-14T16:00:00.000Z',
    response_met: true, resolve_met: false, breached: true, breached_at: '2026-09-14T16:00:00.000Z',
    policy_id: 'pol-1', policy_name: 'Incident rete',
    tier_severity: 'high', tier_response_minutes: 60, tier_resolve_minutes: 480, tier_business_hours: false, tier_warning_minutes: 30,
  }

  it('con uno SLA già in corso la partenza resta la sua, e i fatti già avvenuti restano', async () => {
    previous = statoPrecedente
    await applyRuleSLA({ tenantId: 't1', entityType: 'incident', entityId: 'i1', responseMinutes: 15, resolveMinutes: 120, ruleName: 'Security critico', startedAt: new Date('2026-09-14T10:00:00Z') })
    const p = runs[0]!.params
    // La partenza è quella dello SLA precedente, non «adesso» né la creazione.
    expect(p['startedAt']).toBe('2026-09-14T08:00:00.000Z')
    expect(p['resolveDeadline']).toBe('2026-09-14T10:00:00.000Z')
    // Una violazione non si cancella perché una regola ha cambiato l'obiettivo.
    expect(p).toMatchObject({ breached: true, breachedAt: '2026-09-14T16:00:00.000Z', responseMet: true })
  })

  it('senza nessuno SLA precedente parte dalla creazione del ticket', async () => {
    previous = null
    await applyRuleSLA({ tenantId: 't1', entityType: 'incident', entityId: 'i1', responseMinutes: 15, resolveMinutes: 120, ruleName: 'R', startedAt: new Date('2026-09-14T10:00:00Z') })
    expect(runs[0]!.params).toMatchObject({ startedAt: '2026-09-14T10:00:00.000Z', breached: false, responseMet: false })
  })
})
