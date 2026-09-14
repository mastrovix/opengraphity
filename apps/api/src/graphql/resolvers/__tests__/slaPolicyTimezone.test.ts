/**
 * Revisione del 14 set 2026 · F7: `mapSLAPolicy` inventava `Europe/Rome` per
 * una policy senza fuso e la creazione copiava il fuso del cliente nella
 * policy. Ora una policy senza fuso proprio lo eredita (null), e un fuso
 * proprio deve essere una zona IANA vera.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ runQuery: (...a: unknown[]) => runQuery(...a), getSession: vi.fn() }))
vi.mock('../ci-utils.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn({})) }))
vi.mock('../../../lib/triggerEngine.js', () => ({ invalidateTriggerCache: vi.fn() }))
vi.mock('../../../lib/rulesEngine.js', () => ({ invalidateRulesCache: vi.fn() }))
vi.mock('../../../lib/filterBuilder.js', () => ({ buildAdvancedWhere: vi.fn() }))
const getTenantTimezone = vi.fn(async () => 'Europe/Rome')
vi.mock('@opengraphity/sla', () => ({ selectSLAForEntity: vi.fn(), getTenantTimezone, assertRuleSLAMinutes: vi.fn() }))

const { automationResolvers } = await import('../automation.js')
const ctx = { tenantId: 't1', userId: 'u1', role: 'admin' } as never
const input = { name: 'P', entityType: 'incident', responseMinutes: 60, resolveMinutes: 240, complianceTarget: 95, complianceWarning: 80 }

describe('SLA policy — fuso', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('creata senza fuso → salva null (eredita) e non copia quello del cliente', async () => {
    runQuery.mockImplementationOnce(async (_s: unknown, _c: string, params: Record<string, unknown>) =>
      [{ props: { id: 'p1', name: 'P', entity_type: 'incident', timezone: params['timezone'], response_minutes: 60, resolve_minutes: 240, warning_minutes: 30 } }])
    const p = await automationResolvers.Mutation.createSLAPolicy(null, { input }, ctx) as { timezone: unknown }
    expect((runQuery.mock.calls[0]![2] as Record<string, unknown>)['timezone']).toBeNull()
    expect(p.timezone).toBeNull()
    expect(getTenantTimezone).not.toHaveBeenCalled()
  })

  it('fuso proprio sconosciuto → rifiutato prima di scrivere', async () => {
    await expect(automationResolvers.Mutation.createSLAPolicy(null, { input: { ...input, timezone: 'Mars/Olympus' } }, ctx))
      .rejects.toThrow(/Mars\/Olympus/)
    await expect(automationResolvers.Mutation.updateSLAPolicy(null, { id: 'p1', input: { timezone: 'Mars/Olympus' } }, ctx))
      .rejects.toThrow(/Mars\/Olympus/)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('aggiornata con fuso vuoto → torna a ereditare (null)', async () => {
    runQuery.mockResolvedValueOnce([{ props: { id: 'p1', name: 'P', entity_type: 'incident', response_minutes: 60, resolve_minutes: 240, warning_minutes: 30 } }])
    await automationResolvers.Mutation.updateSLAPolicy(null, { id: 'p1', input: { timezone: '' } }, ctx)
    const [, , params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(params['timezone']).toBeNull()
  })
})
