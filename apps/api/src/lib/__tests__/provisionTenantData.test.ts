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
vi.mock('../roles.js', () => ({
  seedFactoryRoles: vi.fn(async (_s: unknown, t: string) => { seeded.push(`roles:${t}`); return ['admin', 'operator', 'viewer', 'end_user'] }),
}))
vi.mock('../domainMatrixSeed.js', () => ({
  seedDomainMatrices: vi.fn(async () => ['priority', 'change_priority']),
}))
// Le severità del portale hanno i loro test (`portalSeverityOptions.test.ts`):
// qui conta che il provisioning le semini, non COME.
vi.mock('../portalSeverityOptions.js', () => ({
  seedPortalSeverityOptions: vi.fn(async (_s: unknown, t: string) => { seeded.push(`severities:${t}`); return { seeded: ['low', 'high'] } }),
}))
// Idem per la lingua: il seme ha i suoi test in `tenantLanguageSeed.test.ts`.
// The OpenGrafo CI (26 Sep 2026) has its own tests (opengrafoSystemCI.test.ts): here it is there, owned by someone.
const sistema = vi.hoisted(() => ({ ci: { ciId: 'ci-og', ownerTeamId: 't-adm', ownerMembers: 1 } as { ciId: string; ownerTeamId: string | null; ownerMembers: number } | null }))
vi.mock('../opengrafoSystemCI.js', () => ({
  ensureOpenGrafoSystemCI: vi.fn(async () => ({ teamCreated: false, members: 0, ciCreated: false })),
  openGrafoSystemCI: vi.fn(async () => sistema.ci),
}))
vi.mock('../tenantLanguage.js', () => ({
  seedDefaultLanguage: vi.fn(async (_s: unknown, t: string) => { seeded.push(`language:${t}`); return { seeded: 'en' } }),
}))

const { provisionTenantData, tenantProvisioningGaps, formatGap, REQUIRED_WORKFLOW_ENTITY_TYPES } = await import('../provisionTenantData.js')

interface Row { get: (k: string) => unknown }

/**
 * Il tenant COMPLETO, come lo vede `tenantProvisioningGaps`: dalla revisione
 * totale (C-21) il provisioning si RILEGGE alla fine e fallisce se manca un
 * pezzo — non essendo atomico, un'interruzione a metà lasciava un tenant
 * mezzo fatto in silenzio. Il finto database deve quindi saper rispondere
 * anche a quella lettura.
 */
const COMPLETE_TENANT: Record<string, unknown> = {
  roleKeys:       ['admin', 'operator', 'viewer', 'end_user'],
  userRoles:      ['admin'],
  dashboards:     1,
  rules:          35,
  matrices:       2,
  questions:      4,
  teams:          2,
  changeManagers: 1,
  entityTypes:    ['incident', 'problem', 'kb_article', 'change', 'service_request'],
}

function session(rows: Row[] = []) {
  // La riga del tenant completo si usa solo se il test non ne ha dato una sua
  // (i test di `tenantProvisioningGaps` descrivono tenant INCOMPLETI).
  const run = vi.fn(async (cypher: string) => {
    const isGapQuery = cypher.includes('collect(ro.key) AS roleKeys')
    const givenByTest = rows.some((r) => r.get('roleKeys') !== undefined)
    return isGapQuery && !givenByTest ? { records: [row(COMPLETE_TENANT)] } : { records: rows }
  })
  return { run, calls: () => run.mock.calls as unknown as Array<[string, Record<string, unknown>]> }
}
const row = (m: Record<string, unknown>) => ({ get: (k: string) => m[k] })

beforeEach(() => { seeded.length = 0; vi.clearAllMocks() })

describe('provisionTenantData — tutti i pezzi, una volta sola', () => {
  it('ruoli + dashboard + regole + matrici + i workflow di OGNI tipo di ticket', async () => {
    const s = session([row({ wasCreated: true })])
    const out = await provisionTenantData(s as never, 'c-two', { userId: 'u-1' })

    // Ondata 7: i ruoli di fabbrica per primi, senza nessuno può fare niente.
    expect(out.rolesCreated).toEqual(['admin', 'operator', 'viewer', 'end_user'])
    expect(out.dashboardCreated).toBe(true)
    expect(out.notificationRulesCreated).toBe(35)
    expect(out.matricesCreated).toEqual(['priority', 'change_priority'])
    // cinque definizioni: incident (base + security), problem, kb, change, service request
    expect(out.workflows).toHaveLength(5)
    // Le severità del portale, dichiarate alla nascita: senza, il tenant
    // nasceva con un rilievo di gravità ERRORE e il portale non apriva ticket
    // (17 set 2026).
    expect(out.portalSeveritiesSeeded).toEqual(['low', 'high'])
    // La lingua del prodotto, dichiarata: a schermo non cambia niente, ma da
    // ripiego diventa una scelta (e il rilievo sparisce).
    expect(out.defaultLanguageSeeded).toBe('en')
    expect(seeded).toEqual([
      'roles:c-two', 'severities:c-two', 'language:c-two',
      'incident:c-two', 'problem:c-two', 'kb:c-two',
      'Change RFC Process:c-two', 'Service Request Fulfillment:c-two',
    ])
  })

  it('la dashboard è un MERGE «solo dove manca», intestata al tenant', async () => {
    const s = session([row({ wasCreated: false })])
    const out = await provisionTenantData(s as never, 'c-two')
    expect(out.dashboardCreated).toBe(false)
    const [cypher, params] = s.calls()[0]!
    /*
     * La chiave è tenant + NOME, e non porta `is_default` (revisione del 17
     * set 2026): quella proprietà la riscrive la pagina delle dashboard, e
     * tenerla nella chiave faceva sì che la seconda esecuzione non
     * riconoscesse più la dashboard provisionata e ne creasse una seconda. È
     * lo stesso schema che ha creato i doppioni del metamodello. Questo test
     * prima pinnava la stringa col difetto dentro: cementava il difetto invece
     * di trovarlo.
     */
    expect(cypher).toContain("MERGE (d:DashboardConfig {tenant_id: $tenantId, name: 'Dashboard'})")
    expect(cypher).not.toContain('is_default: true}')
    expect(cypher).toContain('ON CREATE SET')
    expect(cypher).toContain('d.is_default = true')
    expect(params['tenantId']).toBe('c-two')
    // Da una migrazione non c'è nessuno a cui intestarla: resta null, non inventata.
    expect(params['userId']).toBeNull()
  })
})

describe('tenantProvisioningGaps — dire cosa manca, invece di scoprirlo al primo ticket', () => {
  /**
   * Terza revisione: le lacune contano anche QUESTIONS, TEAMS e il team
   * designato Change Manager. Il rilevatore diceva «nessun buco» su un tenant
   * appena creato che invece non poteva fare niente — provato dal vivo:
   * `createChange` rifiuta («CI … manca di Owner Group o Support Group», e i
   * gruppi sono team), `completeAssessmentTask` rifiuta («nessuna domanda
   * assegnata al tipo di CI»), e senza Change Manager nessuna change entra in
   * approvazione. Tre muri il primo giorno, nessuno segnalato.
   */
  const ruoli = { roleKeys: ['admin', 'operator', 'viewer', 'end_user'], userRoles: ['admin'] }
  const completo = { ...ruoli, dashboards: 1, rules: 35, matrices: 5, questions: 8, teams: 2, changeManagers: 1 }

  it('un tenant completo non ha lacune', async () => {
    const s = session([row({ ...completo, entityTypes: [...REQUIRED_WORKFLOW_ENTITY_TYPES] })])
    await expect(tenantProvisioningGaps(s as never, 'c-one')).resolves.toEqual([])
  })

  it('the OpenGrafo CI missing, or its team with nobody in it: said — the second is for a person to fix (26 Sep 2026)', async () => {
    const s = session([row({ ...completo, entityTypes: [...REQUIRED_WORKFLOW_ENTITY_TYPES] })])
    sistema.ci = null
    await expect(tenantProvisioningGaps(s as never, 'c-one')).resolves.toEqual([{ kind: 'no_opengrafo_ci' }])
    sistema.ci = { ciId: 'ci-og', ownerTeamId: 't-adm', ownerMembers: 0 }
    await expect(tenantProvisioningGaps(s as never, 'c-one')).resolves.toEqual([{ kind: 'opengrafo_ci_nobody' }])
    sistema.ci = { ciId: 'ci-og', ownerTeamId: 't-adm', ownerMembers: 1 }
  })

  it('the system team is not one of the tenant\'s teams: with it alone, «no teams» is still said', async () => {
    const s = session([row({ ...completo, entityTypes: [...REQUIRED_WORKFLOW_ENTITY_TYPES] })])
    await tenantProvisioningGaps(s as never, 'c-one')
    expect(String((s as { run: { mock: { calls: unknown[][] } } }).run.mock.calls[0]![0])).toContain('count(CASE WHEN coalesce(tm.is_system, false) = false THEN 1 END) AS teams')
  })

  it('lo stato di c-two prima dell\'ondata 8: dashboard e regole sì, workflow nessuno', async () => {
    const s = session([row({ ...completo, entityTypes: [] })])
    await expect(tenantProvisioningGaps(s as never, 'c-two')).resolves.toEqual([
      { kind: 'no_workflows', params: { entityTypes: 'incident, problem, kb_article, change, service_request' } },
    ])
  })

  it('elenca ogni pezzo mancante, e nomina i tipi senza workflow', async () => {
    const s = session([row({ ...ruoli, dashboards: 0, rules: 0, matrices: 0, questions: 0, teams: 0, changeManagers: 0, entityTypes: ['incident'] })])
    const out = await tenantProvisioningGaps(s as never, 'nuovo')
    expect(out).toEqual([
      { kind: 'no_dashboard' },
      { kind: 'no_notification_rules' },
      { kind: 'no_domain_matrices' },
      { kind: 'no_workflows', params: { entityTypes: 'problem, kb_article, change, service_request' } },
      { kind: 'no_assessment_questions' },
      { kind: 'no_teams' },
    ])
  })

  it('lo stato di c-test appena creato: tutto seminato, ma nessun team e nessuna domanda', async () => {
    // Esattamente ciò che ho trovato aprendo un tenant creato con onboard-tenant.
    const s = session([row({ ...ruoli, dashboards: 1, rules: 35, matrices: 6, questions: 0, teams: 0, changeManagers: 0, entityTypes: [...REQUIRED_WORKFLOW_ENTITY_TYPES] })])
    const out = await tenantProvisioningGaps(s as never, 'c-test')
    expect(out.map((g) => g.kind)).toEqual(['no_assessment_questions', 'no_teams'])
  })

  it('con i team ma senza Change Manager designato, lo dice: le change non si approvano', async () => {
    const s = session([row({ ...completo, changeManagers: 0, entityTypes: [...REQUIRED_WORKFLOW_ENTITY_TYPES] })])
    await expect(tenantProvisioningGaps(s as never, 'c-test')).resolves.toEqual([
      { kind: 'no_change_manager' },
    ])
  })

  it('ondata 7: un ruolo di fabbrica o un ruolo portato da una persona che manca è una lacuna', async () => {
    const s = session([row({ ...completo, roleKeys: ['admin', 'viewer'], userRoles: ['admin', 'operator', 'service_desk'], entityTypes: [...REQUIRED_WORKFLOW_ENTITY_TYPES] })])
    await expect(tenantProvisioningGaps(s as never, 'c-test')).resolves.toEqual([
      { kind: 'no_roles', params: { roles: 'operator, end_user, service_desk' } },
    ])
  })

  it('nessuna riga = il tenant non esiste, e lo dice', async () => {
    // Sessione nuda: qui NON vale il tenant completo del mock condiviso, la
    // domanda del test è proprio «cosa risponde senza righe».
    const bare = { run: vi.fn().mockResolvedValue({ records: [] }) }
    await expect(tenantProvisioningGaps(bare as never, 'fantasma')).resolves.toEqual([{ kind: 'tenant_missing' }])
  })
})

/**
 * La resa per la CLI e per i log.
 *
 * Un buco e un DATO: `kind` piu i soli parametri da interpolare. Chi ha una
 * lingua sola — `migrate --status`, i log, le metriche — la rende qui, e chi ha
 * un utente davanti (il client) usa le sue chiavi. Questo test sta a guardia
 * dell'unico modo di sbagliare che resta: aggiungere una `kind` e dimenticare
 * la riga qui, che TypeScript prende solo se lo `switch` resta esaustivo.
 */
describe('formatGap — una lingua sola, e dove una lingua sola va bene', () => {
  const KINDS = [
    'tenant_missing', 'no_roles', 'no_dashboard', 'no_notification_rules', 'no_domain_matrices',
    'no_workflows', 'no_assessment_questions', 'no_teams', 'no_change_manager',
  ] as const

  it('ogni buco ha una resa, e nessuna e vuota', () => {
    for (const kind of KINDS) {
      const testo = formatGap({ kind, params: { entityTypes: 'incident' } })
      expect(testo, kind).toBeTruthy()
      expect(testo.trim(), kind).not.toBe('')
    }
  })

  it('i parametri finiscono nella frase', () => {
    expect(formatGap({ kind: 'no_workflows', params: { entityTypes: 'incident, change' } })).toContain('incident, change')
  })
})
