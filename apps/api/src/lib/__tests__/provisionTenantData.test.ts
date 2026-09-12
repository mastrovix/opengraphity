/**
 * D-14 — un tenant nasce in UN modo.
 *
 * Il difetto: di modi ce n'erano due, e solo uno rendeva il tenant usabile.
 * `onboard-tenant` creava nodo `:Tenant`, utente, dashboard, regole, matrici e
 * TUTTE le definizioni di workflow; le migrazioni `1010`/`1070` creavano il
 * solo `:Tenant` con la policy eventi. `c-two` è nato così, e il suo primo
 * `createIncident` moriva con «No active workflow definition for "incident"»:
 * un tenant che esiste e non può fare niente, e nessuno lo sa finché qualcuno
 * non ci prova.
 *
 * Qui si pinna che la funzione condivisa faccia tutti i pezzi, e che
 * `tenantProvisioningGaps` sappia DIRE cosa manca — è quello che serve a
 * `migrate --status` per non scoprirlo dal primo ticket.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const seeded: string[] = []

vi.mock('@opengraphity/workflow', () => ({
  seedWorkflowForTenant:        vi.fn(async (t: string) => { seeded.push(`incident:${t}`); return 'def-inc' }),
  seedProblemWorkflowForTenant: vi.fn(async (t: string) => { seeded.push(`problem:${t}`); return 'def-prb' }),
  seedKBWorkflowForTenant:      vi.fn(async (t: string) => { seeded.push(`kb:${t}`); return 'def-kb' }),
  seedWorkflowDefinition:       vi.fn(async (t: string, d: { name: string }) => { seeded.push(`${d.name}:${t}`); return { created: true, definitionId: 'def-x' } }),
}))
vi.mock('../seedNotificationRules.js', () => ({
  seedNotificationRules: vi.fn(async () => ({ created: 35, skipped: 0 })),
}))
vi.mock('../domainMatrixSeed.js', () => ({
  seedDomainMatrices: vi.fn(async () => ['priority', 'change_priority']),
}))

const { provisionTenantData, tenantProvisioningGaps, REQUIRED_WORKFLOW_ENTITY_TYPES } = await import('../provisionTenantData.js')

interface Row { get: (k: string) => unknown }
function session(rows: Row[] = []) {
  const run = vi.fn().mockResolvedValue({ records: rows })
  return { run, calls: () => run.mock.calls as Array<[string, Record<string, unknown>]> }
}
const row = (m: Record<string, unknown>) => ({ get: (k: string) => m[k] })

beforeEach(() => { seeded.length = 0; vi.clearAllMocks() })

describe('provisionTenantData — tutti i pezzi, una volta sola', () => {
  it('dashboard + regole + matrici + i workflow di OGNI tipo di ticket', async () => {
    const s = session([row({ wasCreated: true })])
    const out = await provisionTenantData(s as never, 'c-two', { userId: 'u-1' })

    expect(out.dashboardCreated).toBe(true)
    expect(out.notificationRulesCreated).toBe(35)
    expect(out.matricesCreated).toEqual(['priority', 'change_priority'])
    // cinque definizioni: incident (base + security), problem, kb, change, service request
    expect(out.workflows).toHaveLength(5)
    expect(seeded).toEqual([
      'incident:c-two', 'problem:c-two', 'kb:c-two',
      'Change RFC Process:c-two', 'Service Request Fulfillment:c-two',
    ])
  })

  it('la dashboard è un MERGE «solo dove manca», intestata al tenant', async () => {
    const s = session([row({ wasCreated: false })])
    const out = await provisionTenantData(s as never, 'c-two')
    expect(out.dashboardCreated).toBe(false)
    const [cypher, params] = s.calls()[0]!
    expect(cypher).toContain("MERGE (d:DashboardConfig {tenant_id: $tenantId, name: 'Dashboard', is_default: true})")
    expect(cypher).toContain('ON CREATE SET')
    expect(params['tenantId']).toBe('c-two')
    // Da una migrazione non c'è nessuno a cui intestarla: resta null, non inventata.
    expect(params['userId']).toBeNull()
  })
})

describe('tenantProvisioningGaps — dire cosa manca, invece di scoprirlo al primo ticket', () => {
  it('un tenant completo non ha lacune', async () => {
    const s = session([row({ dashboards: 1, rules: 35, matrices: 5, entityTypes: [...REQUIRED_WORKFLOW_ENTITY_TYPES] })])
    await expect(tenantProvisioningGaps(s as never, 'c-one')).resolves.toEqual([])
  })

  it('lo stato di c-two prima dell\'ondata 8: dashboard e regole sì, workflow nessuno', async () => {
    const s = session([row({ dashboards: 1, rules: 35, matrices: 5, entityTypes: [] })])
    await expect(tenantProvisioningGaps(s as never, 'c-two')).resolves.toEqual([
      'nessun workflow attivo per: incident, problem, kb_article, change, service_request',
    ])
  })

  it('elenca ogni pezzo mancante, e nomina i tipi senza workflow', async () => {
    const s = session([row({ dashboards: 0, rules: 0, matrices: 0, entityTypes: ['incident'] })])
    await expect(tenantProvisioningGaps(s as never, 'nuovo')).resolves.toEqual([
      'nessuna dashboard',
      'nessuna regola di notifica',
      'nessuna matrice di dominio',
      'nessun workflow attivo per: problem, kb_article, change, service_request',
    ])
  })

  it('nessuna riga = il tenant non esiste, e lo dice', async () => {
    const s = session([])
    await expect(tenantProvisioningGaps(s as never, 'fantasma')).resolves.toEqual(['nessuna riga: il tenant non esiste'])
  })
})
