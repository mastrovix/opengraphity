/** Secondo giro UI del 15 set 2026: gli avvisi OLA/UC sul tempo del team, con una passata ogni minuto. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const txRun = vi.fn(async () => ({ records: [] }))
const session = { close: vi.fn(async () => {}), executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: txRun })) }
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session), runQuery: (...a: unknown[]) => runQuery(...a), toNumber: (v: unknown) => Number(v) }))
vi.mock('@opengraphity/sla', async (importOriginal) => ({ ...(await importOriginal<object>()), getTenantTimezone: vi.fn(async () => 'UTC'), calendarFor: vi.fn(async () => null) }))
const publishEvent = vi.fn(async () => {})
vi.mock('../publishEvent.js', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }))

const loadChangeUnits = vi.fn(async (..._a: unknown[]) => [] as unknown[])
vi.mock('../olaChangeUnits.js', async (importOriginal) => ({ ...(await importOriginal<object>()), loadChangeUnits: (...a: unknown[]) => loadChangeUnits(...a) }))
const { runOLASweep, olaOpenTicketsCypher } = await import('../olaSweep.js')

const CONTRACT = { id: 'c1', tenantId: 't1', name: 'Rete entro 4h', type: 'ola', entityType: 'incident', teamId: 'rete', resolveMinutes: 240, businessHours: false, calendarId: null, createdAt: '2026-09-01T00:00:00Z' }
const seg = (startedAt: string, endedAt: string | null = null) => ({ teamId: 'rete', startedAt, endedAt, inferred: false })

beforeEach(() => { runQuery.mockReset(); txRun.mockClear(); publishEvent.mockClear() })

describe('runOLASweep', () => {
  it('avvisa una volta i ticket del team oltre l\'obiettivo, anche se ci sono arrivati dopo l\'apertura; gli altri no', async () => {
    runQuery
      .mockResolvedValueOnce([CONTRACT])
      .mockResolvedValueOnce([
        { id: 'inc-late', number: 'INC1', title: 'x', createdAt: '2026-09-15T00:00:00Z', concludedAt: null, currentTeamId: 'rete', segments: [seg('2026-09-15T08:00:00Z')] },
        { id: 'inc-ok', number: 'INC2', title: 'y', createdAt: '2026-09-15T00:00:00Z', concludedAt: null, currentTeamId: 'rete', segments: [seg('2026-09-15T11:00:00Z')] },
      ])
    const summary = await runOLASweep(new Date('2026-09-15T12:30:00Z'))
    expect(summary).toEqual({ contracts: 1, candidates: 2, alerted: 1, failed: 0 })
    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent.mock.calls[0]).toEqual(['ola.breached', 't1', expect.any(String), expect.objectContaining({ entity_id: 'inc-late', contract_id: 'c1', used_minutes: 270, target_minutes: 240 }), expect.any(String)])
    expect(txRun).toHaveBeenCalledWith(expect.stringContaining('SET e.ola_alerted = coalesce(e.ola_alerted, []) + $contractId'), expect.objectContaining({ id: 'inc-late', contractId: 'c1' }))
  })

  it('un contratto che non si valuta non ferma gli altri e si conta', async () => {
    const { calendarFor } = await import('@opengraphity/sla')
    vi.mocked(calendarFor).mockRejectedValueOnce(new Error('calendar gone'))
    runQuery.mockResolvedValueOnce([CONTRACT, { ...CONTRACT, id: 'c2' }]).mockResolvedValueOnce([])
    const summary = await runOLASweep(new Date('2026-09-15T12:30:00Z'))
    expect(summary).toMatchObject({ contracts: 2, failed: 1 })
  })

  it('la lettura prende i ticket aperti del team non ancora avvisati per quel contratto', () => {
    const c = olaOpenTicketsCypher('incident')
    expect(c).toContain('-[:ASSIGNED_TO_TEAM]->(:Team {id: $teamId, tenant_id: $tenantId})')
    expect(c).toContain('e.resolved_at IS NULL')
    expect(c).toContain('NOT $contractId IN coalesce(e.ola_alerted, [])')
  })

  it('change: le misure dei task del team, avvisate una volta sul task con la chiave della misura', async () => {
    const { changeUnitsFromRows } = await vi.importActual<typeof import('../olaChangeUnits.js')>('../olaChangeUnits.js')
    const steps = JSON.stringify([{ title: 'Rilascio', validationWindow: { start: '2026-09-15T08:00:00Z', end: '2026-09-15T09:00:00Z' }, releaseWindow: { start: '2026-09-15T18:00:00Z', end: '2026-09-15T19:00:00Z' } }])
    const base = { ticketId: 'chg-1', ticketNumber: 'CHG1', ticketTitle: 'x', createdAt: '2026-09-14T10:00:00Z', ciName: 'Portale', ownerTeamId: 'rete', supportTeamId: 'rete', steps, testedAt: null, deployedAt: null }
    const units = changeUnitsFromRows([], [
      { ...base, id: 'dp-new', alerted: [] },
      { ...base, id: 'dp-old', alerted: ['c1:validation:dp-old:0'] },
    ])
    loadChangeUnits.mockResolvedValueOnce(units)
    runQuery.mockResolvedValueOnce([{ ...CONTRACT, entityType: 'change' }])
    const summary = await runOLASweep(new Date('2026-09-15T12:30:00Z'))
    // dp-new: validazione oltre (4h30 su 4h) → avviso; rilascio non ancora iniziato; dp-old: già avvisato per la validazione.
    expect(summary).toEqual({ contracts: 1, candidates: 3, alerted: 1, failed: 0 })
    expect(loadChangeUnits).toHaveBeenCalledWith(expect.anything(), 't1', { by: 'open', teamId: 'rete' })
    expect(txRun).toHaveBeenCalledWith(expect.stringContaining('MATCH (n:DeployPlanTask {id: $id, tenant_id: $tenantId})'), expect.objectContaining({ id: 'dp-new', key: 'c1:validation:dp-new:0' }))
    expect(publishEvent.mock.calls[0]![3]).toMatchObject({ entity_id: 'chg-1', entity_type: 'change', unit_kind: 'validation', ci_name: 'Portale', used_minutes: 270 })
  })
})
