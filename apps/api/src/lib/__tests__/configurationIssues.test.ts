/**
 * La diagnostica che dice all'amministratore cosa c'è da sistemare (revisione
 * delle otto ondate · A·#3, D·D4, D·#5, C·#8).
 *
 * Il prodotto sapeva già tutte queste cose e le diceva a tutti tranne che a chi
 * può rimediare: l'intestazione HTTP, la metrica, il log e `migrate --status`
 * non arrivano all'amministratore del tenant, che vede solo pagine che non
 * funzionano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let degraded = { degraded: false, reason: null as string | null }
let gaps: string[] = []
let policy: Record<string, string[]> = { ignore_lifecycle_statuses: [], retired_statuses: [], maintenance_statuses: [] }
let vocabularies: Record<string, string[]> = {}
let matrices: Record<string, Record<string, string>> = {}

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }) }))
vi.mock('../schemaCache.js', () => ({ getSchemaState: vi.fn(async () => degraded) }))
vi.mock('../provisionTenantData.js', () => ({ tenantProvisioningGaps: vi.fn(async () => gaps) }))
vi.mock('../../services/events/policy.js', () => ({ getEventPolicy: vi.fn(async () => policy) }))
vi.mock('../domainMatrix.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../domainMatrix.js')>()
  return {
    ...orig,
    domainVocabulary: vi.fn(async (_t: string, name: string) => vocabularies[name] ?? []),
    loadDomainMatrix: vi.fn(async (_t: string, kind: string) => ({ kind, entries: matrices[kind] ?? {}, isDefault: false, updatedAt: null })),
  }
})

const { configurationIssues } = await import('../configurationIssues.js')
const { DOMAIN_MATRIX_KINDS } = await import('../domainMatrix.js')

/** Vocabolari e matrici complete: lo stato in cui non c'è niente da dire. */
function healthy(): void {
  degraded = { degraded: false, reason: null }
  gaps = []
  vocabularies = {
    impact: ['low'], urgency: ['low'], priority: ['low'], severity: ['low'],
    service_criticality: ['mission_critical'], event_severity: ['info'], import_severity: ['minor'],
    change_type: ['standard'], risk_band: ['low'],
    ci_status: ['active', 'dismesso'],
  }
  matrices = Object.fromEntries(Object.entries(DOMAIN_MATRIX_KINDS).map(([kind, spec]) => {
    const key = spec.inputs.map((i) => vocabularies[i]![0]!).join('|')
    return [kind, { [key]: vocabularies[spec.output]![0]! }]
  }))
  policy = { ignore_lifecycle_statuses: [], retired_statuses: ['dismesso'], maintenance_statuses: [] }
}

beforeEach(() => { healthy() })

describe('configurationIssues', () => {
  it('niente da sistemare → lista vuota (un banner che compare sempre diventa invisibile)', async () => {
    expect(await configurationIssues('c-one')).toEqual([])
  })

  it('schema degradato → errore che riporta il motivo e dove si rimedia', async () => {
    degraded = { degraded: true, reason: 'tipo "armadio": unknown fieldType "integer"' }
    const [issue] = await configurationIssues('c-one')
    expect(issue).toMatchObject({ kind: 'schema_degraded', severity: 'error', where: '/settings/ci-types' })
    expect(issue!.message).toContain('unknown fieldType "integer"')
  })

  it('buchi di configurazione → errore che nomina il pulsante da premere', async () => {
    gaps = ['nessun workflow attivo per: incident, change']
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'provisioning_gap')
    expect(issue).toMatchObject({ severity: 'error', where: '/workflow' })
    expect(issue!.message).toContain('Completa la configurazione')
  })

  it('matrice con una combinazione senza valore → errore; solo chiavi residue → avviso', async () => {
    vocabularies['impact'] = ['low', 'high']   // la matrice `priority` non copre `high|low`
    const mancante = (await configurationIssues('c-one')).find((i) => i.kind === 'matrix_incomplete')
    expect(mancante).toMatchObject({ severity: 'error', where: '/settings/domain-matrices' })
    expect(mancante!.message).toMatch(/combinazioni senza valore/)

    healthy()
    matrices['priority'] = { ...matrices['priority']!, 'rimasto|low': 'low' }
    const residuo = (await configurationIssues('c-one')).find((i) => i.kind === 'matrix_incomplete')
    expect(residuo).toMatchObject({ severity: 'warning' })
    expect(residuo!.message).toMatch(/chiavi rimaste da una rinomina/)
  })

  /**
   * D·#5: la migrazione `1810` scrive `retired_statuses` senza verificare che
   * quei valori siano nel `ci_status` del cliente. Chi aveva già rinominato
   * `decommissioned` si ritrovava una policy che punta al nulla — cioè i CI
   * dismessi di nuovo dentro la salute dei servizi, che è il difetto C-4
   * dichiarato chiuso, spostato dal codice al dato.
   */
  it('la policy che cita uno stato fuori vocabolario → errore che dice la conseguenza', async () => {
    policy = { ...policy, retired_statuses: ['decommissioned'] }   // il cliente l'ha rinominato
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'policy_out_of_vocabulary')
    expect(issue).toMatchObject({ severity: 'error', where: '/settings/events' })
    expect(issue!.message).toContain('retired_statuses → decommissioned')
    expect(issue!.message).toMatch(/tornano a pesare nella salute dei servizi/)
  })

  /**
   * C·#8, il caso reale di c-one: `expired` e `revoked` sono stati aggiunti al
   * vocabolario, ma `retired_statuses` non li conosce — 68 CI con un ciclo di
   * vita concluso pesavano ancora nella salute dei servizi, e nessuna pagina lo
   * diceva.
   */
  it('stati aggiunti al vocabolario senza semantica → avviso che dice cosa significa per il prodotto', async () => {
    vocabularies['ci_status'] = ['active', 'dismesso', 'expired', 'revoked']
    const issue = (await configurationIssues('c-one')).find((i) => i.kind === 'vocabulary_without_semantics')
    expect(issue).toMatchObject({ severity: 'warning' })
    expect(issue!.message).toContain('expired, revoked')
    expect(issue!.message).toMatch(/in servizio/)
  })

  it('il primo valore della scala non è «senza semantica»: è lo stato in servizio', async () => {
    vocabularies['ci_status'] = ['active', 'dismesso']
    expect((await configurationIssues('c-one')).find((i) => i.kind === 'vocabulary_without_semantics')).toBeUndefined()
  })

  it('un controllo che fallisce diventa una voce, e non nasconde gli altri', async () => {
    const { getSchemaState } = await import('../schemaCache.js')
    vi.mocked(getSchemaState).mockRejectedValueOnce(new Error('neo4j giù'))
    gaps = ['nessuna dashboard']
    const issues = await configurationIssues('c-one')
    expect(issues.find((i) => i.kind === 'check_failed')?.message).toContain('neo4j giù')
    expect(issues.find((i) => i.kind === 'provisioning_gap')).toBeDefined()
  })
})
