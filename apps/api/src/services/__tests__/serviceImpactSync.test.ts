/**
 * services/serviceImpact/sync.ts — mappa VIVA (ondata 5): sincronizzazione con
 * la CMDB e notifica immediata dalle scritture del grafo dei CI.
 *
 * Pinna il contratto: cosa la sincronizzazione tocca (aggiunge, toglie i soli
 * componenti automatici, sposta livello e via) e cosa non tocca MAI (i
 * componenti aggiunti a mano, le esclusioni, le impostazioni
 * propagate/weight/critical); niente da fare → solo `synced_at` (nessuna
 * versione nuova, nessuna voce di cronologia, nessuna rivalutazione); oltre il
 * tetto dei 500 → nulla applicato, mappa `stale`, metrica `skipped_limit`;
 * mappa in pausa mai sincronizzata; `notifyCIGraphChanged` che trova le mappe
 * giuste, ne accoda una per mappa e non lancia mai se la coda è giù.
 *
 * Revisione 2: la notifica trova la mappa anche quando il CI è già stato
 * cancellato (S1, via `node_ids`), e i segnali di manutenzione
 * (`notifyCIMaintenanceChanged` / `notifyChangeWindowChanged`, D6.1) accodano
 * una valutazione per mappa senza mai lanciare.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

// Revisione 2 · D6.2: la lettura della mappa prende `suppress_upstream_hops`
// dalla policy degli allarmi (cache in memoria): qui la policy è mockata, così
// la mappa resta UNA sola query nel test.
vi.mock('../events/policy.js', () => ({ getEventPolicy: vi.fn().mockResolvedValue({ suppress_upstream_hops: 1,
  // Ondata 7 · C-4: la SEMANTICA del ciclo di vita («ritirato», «in
  // manutenzione») è dato del cliente e vive sulla policy. Qui i valori
  // iniziali, gli stessi che il codice aveva come costanti.
  retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'], ignore_lifecycle_statuses: ['decommissioned'] }) }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../middleware/metrics.js', () => ({
  workflowPurposeMissingTotal: { inc: vi.fn() },
  serviceMapSyncsTotal: { inc: vi.fn() },
  serviceEvaluationsTotal: { inc: vi.fn() }, serviceEvaluationDurationSeconds: { observe: vi.fn() }, servicesHealth: { set: vi.fn() },
  serviceMapsStale: { set: vi.fn() }, eventsSuppressedTotal: { inc: vi.fn() },
}))
vi.mock('../serviceImpact/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../serviceImpact/engine.js')>()),
  evaluateServiceMap: vi.fn(),
}))
vi.mock('../../jobs/serviceImpactWorker.js', () => ({
  enqueueServiceMapSync: vi.fn().mockResolvedValue(undefined),
  enqueueServiceMapEvaluation: vi.fn().mockResolvedValue(undefined),
}))

// Ondata 6 (C-1/A-10/C-3): etichette, ruoli e relazioni vengono dal metamodello
// del tenant; qui il tenant di prova ha quello del prodotto.
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:        vi.fn(async () => ['Application', 'Server', 'Database', 'Certificate', 'Storage']),
  apocLabelFilterForTenant: vi.fn(async () => '+Application|+Server|+Database|+Certificate|+Storage'),
}))
vi.mock('../../lib/ciMetamodelForTenant.js', () => ({
  serviceRelationshipTypesForTenant: vi.fn(async () => ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE']),
  suppressionRelPatternForTenant:    vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE'),
  serviceRolesForTenant:             vi.fn(async () => new Map([
    ['Application', 'component'], ['Server', 'infrastructure'], ['Database', 'infrastructure'],
    ['Certificate', 'certificate'], ['Storage', 'infrastructure'],
  ])),
}))

vi.mock('../../lib/workflowHelpers.js', () => ({
  // Ondata 4 · A4-1: i passi della finestra di change vengono dallo SCOPO.
  // Il tenant di prova ha i nomi di fabbrica con gli scopi della migrazione.
  getStepNamesByPurpose: vi.fn(async (_s: unknown, _t: unknown, _e: unknown, purposes: readonly string[]) =>
    purposes.includes('implementation') ? ['deployment'] : ['scheduled']),
}))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../lib/audit.js')
const { evaluateServiceMap } = await import('../serviceImpact/engine.js')
const { serviceMapSyncsTotal } = await import('../../middleware/metrics.js')
const { enqueueServiceMapSync, enqueueServiceMapEvaluation } = await import('../../jobs/serviceImpactWorker.js')
const {
  MAPS_TOUCHED_BY_CIS_CYPHER, MAPS_INCLUDING_CIS_CYPHER, CHANGE_AFFECTED_CIS_CYPHER,
  SERVICE_MAP_SYNC_EVERY_MS, SYNC_APPLY_CYPHER, SYNC_SKIP_LIMIT_CYPHER, SYNC_TOUCH_CYPHER,
  notifyCIGraphChanged, notifyCIMaintenanceChanged, notifyChangeWindowChanged,
  serviceSyncNote, syncPlanOf, syncServiceMap, syncStaleOrOldMaps,
} = await import('../serviceImpact/sync.js')
const { DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_MAP_MAX_NODES } = await import('../../lib/serviceVocabularies.js')

const NOW = '2026-09-10T18:00:00.000Z'
const tx = { run: vi.fn() }
// `executeRead` c'è perché la sessione vera ce l'ha: la risoluzione dei passi
// di finestra per SCOPO (ondata 4 · A4-1) riusa la sessione del chiamante
// invece di aprirne una in più per valutazione.
const session = { close: vi.fn().mockResolvedValue(undefined), executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)), executeRead: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) }

function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of rules) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => { const r = await impl(s, c, p); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'nessun errore lanciato').toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

const LOAD_RE  = /MATCH \(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->/
const EXCL_RE  = /\[:EXCLUDES\]->\(ci \{tenant_id: \$tenantId\}\)/
const APPLY_RE = /SET m\.node_ids = includedIds, m\.stale = false, m\.stale_reason = null/
const TOUCH_RE = /SET m\.synced_at = \$now\s+RETURN/
const SKIP_RE  = /SET m\.stale = true, m\.stale_reason = 'over_limit', m\.synced_at = \$now/

/** Mappa di adesso: api-03 (L1), db-01 (L2), old-99 (L2, non più raggiungibile); `gone-1` sparito dalla CMDB. */
function stateRow(over: { props?: Record<string, unknown>; nodes?: Record<string, unknown>[] } = {}) {
  const n = (o: Record<string, unknown>) => ({ name: String(o['ciId']).toUpperCase(), labels: ['Server'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'operational', healthSource: 'monitoring', status: 'active', changes: [], ...o })
  return {
    props: {
      id: 'map-1', tenant_id: 't1', service_id: 'ba-1', name: 'Enterprise Billing', status: 'active', version: 2, updated_at: 'T-prec',
      max_depth: 4, relationship_types: ['DEPENDS_ON', 'HOSTED_ON'], rules: DEFAULT_SERVICE_IMPACT_RULES_JSON,
      health: 'operational', stale: true, auto_sync: true, synced_at: null, node_ids: ['api-03', 'db-01', 'old-99', 'gone-1'], ...over.props,
    },
    nodes: over.nodes ?? [
      n({ ciId: 'api-03', labels: ['Application'], level: 1, role: 'entry', weight: 8, critical: true, via: null }),
      n({ ciId: 'db-01', labels: ['Database'], health: 'down' }),
      n({ ciId: 'old-99' }),
    ],
  }
}
/** Grafo di adesso: api-03 → srv-9 (nuovo) → db-01 (spostato al livello 3); cert-x escluso. */
const ENTRY_ROW = { serviceName: 'Enterprise Billing', apps: [{ ciId: 'api-03', name: 'API-03', labels: ['Application'], status: 'active', health: 'operational' }] }
const EXPANDED_ROWS = [
  { ciId: 'srv-9', name: 'SRV-09', level: 2, via: 'api-03', labels: ['Server'], status: 'active', health: null },
  { ciId: 'cert-x', name: 'CERT-X', level: 2, via: 'api-03', labels: ['Certificate'], status: 'active', health: null },
  { ciId: 'db-01', name: 'DB-01', level: 3, via: 'srv-9', labels: ['Database'], status: 'active', health: 'down' },
]
const EXCLUSION_ROWS = [{ id: 'cert-x', name: 'CERT-X', labels: ['Certificate'], status: 'active', health: null }]

/** Diff completo + la riga della scrittura (added 1, removed 1 — `gone-1` non ha una INCLUDES da cancellare —, moved 1). */
function diffCypher(state = stateRow(), applyRow: unknown = { version: 3, status: 'active', added: 1, removed: 1, moved: 1 }): Array<[RegExp, unknown]> {
  return [
    [LOAD_RE, state], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, EXPANDED_ROWS], [EXCL_RE, EXCLUSION_ROWS],
    [APPLY_RE, applyRow], [TOUCH_RE, { version: 2, status: 'active' }], [SKIP_RE, { version: 2, status: 'active', wasStale: false }],
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(evaluateServiceMap).mockResolvedValue({ mapId: 'map-1', health: 'down', previousHealth: 'operational', impactScore: 62, changed: true, stale: false, healthIfActive: null, causes: [], incident: null })
})

// ── Applicazione del diff ────────────────────────────────────────────────────

describe('syncServiceMap: cosa applica', () => {
  it('aggiunge i nuovi (added_by auto), toglie gli automatici spariti, sposta livello e via; versione + 1, cronologia, audit, rivalutazione', async () => {
    onCypher(diffCypher())
    const r = await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)

    expect(r).toMatchObject({ mapId: 'map-1', version: 3, changed: true, skipped: null, added: 1, removed: 2, moved: 1, syncedAt: NOW })
    const c = callMatching(APPLY_RE)!
    expect(c.cypher).toBe(SYNC_APPLY_CYPHER)
    expect(c.params['addNodes']).toEqual([{ ciId: 'srv-9', level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03' }])
    // old-99 non è più raggiungibile (automatico), gone-1 non esiste più nella CMDB
    expect(c.params['removeIds']).toEqual(['old-99', 'gone-1'])
    expect(c.params['moveNodes']).toEqual([{ ciId: 'db-01', level: 3, via: 'srv-9' }])
    // guardia di versione: la versione letta dal diff, non una qualsiasi
    expect(c.params['expectedVersion']).toBe(2)
    expect(c.params['tenantId']).toBe('t1')
    // il nodo nuovo nasce automatico: la sincronizzazione lo potrà togliere
    expect(c.cypher).toContain("added_by: 'auto'")
    expect(c.cypher).toContain('level: toInteger(n.level)')
    // cronologia nello stesso statement, con la nota leggibile
    expect(c.cypher).toContain('HAS_HEALTH_HISTORY')
    expect(c.params['hTrigger']).toBe('map_changed')
    expect(c.params['hNote']).toBe('Sincronizzazione automatica: +1, −2, ~1 spostati')
    expect(c.cypher).toContain('SET m.updated_at = $now, m.updated_by = $actorId')
    // X1: la guardia prende il lock (SET) e POI confronta; la versione è già quella nuova
    expect(c.cypher).toMatch(/MATCH \(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)\s+SET m\.version = m\.version \+ 1\s+WITH m, m\.version AS version\s+WHERE version = toInteger\(\$expectedVersion\) \+ 1/)
    expect(c.params['actorId']).toBe('monitoring')

    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', userId: 'monitoring' }), 'service_map.synced', 'ServiceMap', 'map-1', expect.objectContaining({ trigger: 'periodic', added: 1, removed: 2, moved: 1 }))
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 't1', mapId: 'map-1', trigger: 'map_changed', actorId: 'monitoring', now: NOW })
    expect(serviceMapSyncsTotal.inc).toHaveBeenCalledWith({ result: 'changed' })
  })

  it('un componente aggiunto a mano non viene MAI tolto (lo toglie una persona)', async () => {
    const state = stateRow()
    state.nodes[2] = { ...state.nodes[2]!, addedBy: 'manual' }   // old-99, non più raggiungibile
    onCypher(diffCypher(state, { version: 3, status: 'active', added: 1, removed: 0, moved: 1 }))
    const r = await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)

    const c = callMatching(APPLY_RE)!
    expect(c.params['removeIds']).toEqual(['gone-1'])   // solo l'id sparito dalla CMDB
    expect(r.removed).toBe(1)
    // il piano è lo stesso che il resolver mostrerebbe: nessun nodo manual fra le rimozioni
    expect(syncPlanOf({ nodeCount: 3, missing: [], added: [], moved: [], removed: [{ ciId: 'x', node: { addedBy: 'manual' } as never, reason: 'unreachable' }] } as never).removeIds).toEqual([])
  })

  it('non tocca mai propagate, weight e critical dei componenti esistenti (decisioni dell\'amministratore)', () => {
    // lo spostamento aggiorna SOLO livello e via
    expect(SYNC_APPLY_CYPHER).toContain('SET inc.level = toInteger(n.level), inc.via = n.via')
    expect(SYNC_APPLY_CYPHER).not.toMatch(/SET inc\.propagate|SET inc\.weight|SET inc\.critical|inc\.propagate =/)
    // e non tocca le esclusioni: nessuna EXCLUDES nello statement
    expect(SYNC_APPLY_CYPHER).not.toContain('EXCLUDES')
  })

  it('un CI escluso non rientra mai (il diff lo toglie dalla proposta)', async () => {
    onCypher(diffCypher())
    await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)
    const added = (callMatching(APPLY_RE)!.params['addNodes'] as { ciId: string }[]).map((n) => n.ciId)
    expect(added).not.toContain('cert-x')
    expect(callMatching(EXCL_RE)).toBeDefined()   // le esclusioni vengono lette
  })

  it('niente da fare: solo synced_at — nessuna versione nuova, nessuna voce di cronologia, nessuna rivalutazione', async () => {
    // la mappa è già quella che si costruirebbe adesso: api-03 e db-01 al loro posto
    const state = stateRow({
      props: { node_ids: ['api-03', 'db-01'] },
      nodes: [
        { ciId: 'api-03', name: 'API-03', labels: ['Application'], level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', healthSource: null, status: 'active', changes: [] },
        { ciId: 'db-01', name: 'DB-01', labels: ['Database'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'down', healthSource: null, status: 'active', changes: [] },
      ],
    })
    onCypher([
      [LOAD_RE, state], [/REALIZES/, ENTRY_ROW],
      [/apoc\.path\.expandConfig/, [{ ciId: 'db-01', name: 'DB-01', level: 2, via: 'api-03', labels: ['Database'], status: 'active', health: 'down' }]],
      [EXCL_RE, []], [TOUCH_RE, { version: 2, status: 'active' }],
    ])
    const r = await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)

    expect(r).toMatchObject({ changed: false, skipped: null, version: 2, added: 0, removed: 0, moved: 0, note: null, syncedAt: NOW })
    const c = callMatching(TOUCH_RE)!
    expect(c.cypher).toBe(SYNC_TOUCH_CYPHER)
    expect(c.cypher).not.toContain('version + 1')
    expect(c.cypher).not.toContain('HAS_HEALTH_HISTORY')
    expect(c.params).toEqual({ mapId: 'map-1', tenantId: 't1', now: NOW })
    expect(callMatching(APPLY_RE)).toBeUndefined()
    expect(evaluateServiceMap).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(serviceMapSyncsTotal.inc).toHaveBeenCalledWith({ result: 'unchanged' })
  })
})

// ── Tetto dei 500 ────────────────────────────────────────────────────────────

describe('syncServiceMap: oltre il tetto dei 500 nodi', () => {
  it('non tronca e non applica nulla: mappa stale, voce di cronologia con il motivo, metrica skipped_limit', async () => {
    const huge = Array.from({ length: SERVICE_MAP_MAX_NODES + 1 }, (_, i) => ({ ciId: `srv-${i}`, name: `SRV-${i}`, level: 2, via: 'api-03', labels: ['Server'], status: 'active', health: null }))
    onCypher([[LOAD_RE, stateRow()], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, huge], [EXCL_RE, []], [SKIP_RE, { version: 2, status: 'active', wasStale: false }]])
    const r = await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)

    expect(r).toMatchObject({ skipped: 'limit', changed: false, version: 2 })
    expect(r.reason).toMatch(/supera il tetto di 500 componenti/)
    const c = callMatching(SKIP_RE)!
    expect(c.cypher).toBe(SYNC_SKIP_LIMIT_CYPHER)
    expect(c.params['hTrigger']).toBe('map_changed')
    expect(c.params['hNote']).toMatch(/Sincronizzazione saltata/)
    // NIENTE viene applicato: nessuna INCLUDES creata o cancellata
    expect(callMatching(APPLY_RE)).toBeUndefined()
    expect(callMatching(TOUCH_RE)).toBeUndefined()
    expect(evaluateServiceMap).not.toHaveBeenCalled()
    expect(serviceMapSyncsTotal.inc).toHaveBeenCalledWith({ result: 'skipped_limit' })
    // la voce di cronologia si scrive una volta sola (finché la mappa resta stale)
    expect(SYNC_SKIP_LIMIT_CYPHER).toContain('becameStale')
  })

  it('la mappa già stale non riceve una seconda voce di cronologia (ma resta il warn e la metrica)', async () => {
    const huge = Array.from({ length: SERVICE_MAP_MAX_NODES + 1 }, (_, i) => ({ ciId: `srv-${i}`, name: `SRV-${i}`, level: 2, via: 'api-03', labels: ['Server'], status: 'active', health: null }))
    onCypher([[LOAD_RE, stateRow()], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, huge], [EXCL_RE, []], [SKIP_RE, { version: 2, status: 'active', wasStale: true }]])
    const r = await syncServiceMap('t1', 'map-1', 'manual', 'adm-1', NOW)
    expect(r.skipped).toBe('limit')
    expect(r.note).toBeNull()
    expect(serviceMapSyncsTotal.inc).toHaveBeenCalledWith({ result: 'skipped_limit' })
  })
})

// ── Mappe in pausa e congelate ───────────────────────────────────────────────

describe('syncServiceMap: pausa e modalità', () => {
  it('mappa in pausa: nessuna scrittura; a mano è un rifiuto esplicito (BAD_USER_INPUT), dal periodico un no-op', async () => {
    onCypher(diffCypher(stateRow({ props: { status: 'paused' } })))
    await expectCode(syncServiceMap('t1', 'map-1', 'manual', 'adm-1', NOW), 'BAD_USER_INPUT', /is paused: reactivate it before synchronizing/)
    expect(callMatching(APPLY_RE)).toBeUndefined()
    expect(callMatching(TOUCH_RE)).toBeUndefined()
    // un rifiuto non è un guasto del motore: non conta fra gli errori
    expect(serviceMapSyncsTotal.inc).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher(diffCypher(stateRow({ props: { status: 'paused' } })))
    const r = await syncServiceMap('t1', 'map-1', 'periodic', undefined, NOW)
    expect(r.skipped).toBe('paused')
    expect(callMatching(TOUCH_RE)).toBeUndefined()
  })

  it('mappa congelata (auto_sync false): la sincronizzazione manuale funziona lo stesso (è un\'azione esplicita)', async () => {
    onCypher(diffCypher(stateRow({ props: { auto_sync: false } })))
    const r = await syncServiceMap('t1', 'map-1', 'manual', 'adm-1', NOW)
    expect(r.changed).toBe(true)
    expect(callMatching(APPLY_RE)!.params['hNote']).toBe('Sincronizzazione richiesta da adm-1: +1, −2, ~1 spostati')
    expect(callMatching(APPLY_RE)!.params['actorId']).toBe('adm-1')
  })

  it('la nota distingue la sincronizzazione automatica da quella richiesta a mano', () => {
    expect(serviceSyncNote('periodic', { added: 2, removed: 1, moved: 0 }, 'monitoring')).toBe('Sincronizzazione automatica: +2, −1, ~0 spostati')
    expect(serviceSyncNote('manual', { added: 0, removed: 0, moved: 3 }, 'adm-1')).toBe('Sincronizzazione richiesta da adm-1: +0, −0, ~3 spostati')
  })

  it('D6.3: i componenti dismessi NON vengono tolti dalla sincronizzazione automatica (li toglie una persona dal diff): contati e detti nella nota', () => {
    const plan = syncPlanOf({
      nodeCount: 3, missing: [], added: [], moved: [],
      removed: [
        { ciId: 'old-99', node: { addedBy: 'auto' } as never, reason: 'unreachable' },
        { ciId: 'dis-1', node: { addedBy: 'auto' } as never, reason: 'lifecycle' },
        { ciId: 'dis-2', node: { addedBy: 'auto' } as never, reason: 'lifecycle' },
      ],
    } as never)
    expect(plan.removeIds).toEqual(['old-99'])
    expect(plan.retired).toBe(2)
    // la coda della nota arriva solo con una sincronizzazione che cambia qualcosa (niente voce ogni mezz'ora)
    expect(serviceSyncNote('periodic', { added: 0, removed: 1, moved: 0, retired: 2 }, 'monitoring'))
      .toBe('Sincronizzazione automatica: +0, −1, ~0 spostati; 2 componenti dismessi esclusi dal calcolo')
    expect(serviceSyncNote('periodic', { added: 0, removed: 1, moved: 0, retired: 1 }, 'monitoring'))
      .toContain('; 1 componente dismesso escluso dal calcolo')
    expect(serviceSyncNote('periodic', { added: 0, removed: 1, moved: 0, retired: 0 }, 'monitoring')).not.toContain('dismess')
  })
})

// ── Passata periodica (rete di sicurezza) ────────────────────────────────────

describe('syncStaleOrOldMaps: rete di sicurezza ogni 30 minuti', () => {
  it('prende solo le mappe vive e non in pausa, non sincronizzate da più di 30 minuti (o mai), paginate per id', async () => {
    onCypher([
      [/MATCH \(m:ServiceMap\)/, [{ tenantId: 't1', id: 'map-1' }]],
      [LOAD_RE, stateRow()], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, EXPANDED_ROWS], [EXCL_RE, EXCLUSION_ROWS],
      [APPLY_RE, { version: 3, status: 'active', added: 1, removed: 1, moved: 1 }],
    ])
    const r = await syncStaleOrOldMaps(NOW)
    expect(r).toMatchObject({ evaluated: 1, failed: 0, truncated: false })

    const page = callMatching(/MATCH \(m:ServiceMap\)\s+WHERE m\.auto_sync = true/)!
    expect(page.cypher).toContain('WHERE m.auto_sync = true AND m.status <> \'paused\'')
    expect(page.cypher).toContain('(m.synced_at IS NULL OR m.synced_at < $cutoff)')
    expect(page.cypher).toContain('AND m.id > $cursor')
    expect(page.cypher).toContain('ORDER BY m.id LIMIT toInteger($limit)')
    expect(page.cypher).toContain('// tenant-ok')
    expect(page.params['cutoff']).toBe(new Date(Date.parse(NOW) - SERVICE_MAP_SYNC_EVERY_MS).toISOString())
    expect(SERVICE_MAP_SYNC_EVERY_MS).toBe(30 * 60 * 1000)
  })

  it('un errore su una mappa non ferma le altre ma fa fallire la passata alla fine', async () => {
    onCypher([
      [/MATCH \(m:ServiceMap\)/, [{ tenantId: 't1', id: 'map-1' }, { tenantId: 't1', id: 'map-2' }]],
      [LOAD_RE, (p?: Record<string, unknown>) => (p?.['mapId'] === 'map-2' ? null : stateRow())],
      [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, EXPANDED_ROWS], [EXCL_RE, EXCLUSION_ROWS],
      [APPLY_RE, { version: 3, status: 'active', added: 1, removed: 1, moved: 1 }],
    ])
    await expect(syncStaleOrOldMaps(NOW)).rejects.toThrow(/1\/2 service maps failed synchronization/)
    // la prima è stata sincronizzata comunque
    expect(callMatching(APPLY_RE)).toBeDefined()
  })
})

// ── Notifica immediata dalle scritture CMDB ──────────────────────────────────

describe('notifyCIGraphChanged', () => {
  it('trova le mappe vive che includono uno dei CI (o il cui servizio è uno di essi) e ne accoda UNA per mappa', async () => {
    onCypher([[/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)/, [{ id: 'map-1' }, { id: 'map-2' }]]])
    expect(await notifyCIGraphChanged('t1', ['srv-9', 'db-01', 'srv-9'], 'ci_relationship.added:DEPENDS_ON')).toBe(2)

    const c = callMatching(/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)/)!
    expect(c.cypher).toBe(MAPS_TOUCHED_BY_CIS_CYPHER)
    expect(c.cypher).toContain("WHERE m.auto_sync = true AND m.status <> 'paused'")
    expect(c.cypher).toContain('m.service_id IN $ciIds')
    expect(c.cypher).toContain('any(x IN m.node_ids WHERE x IN $ciIds)')
    expect(c.cypher).toContain('EXISTS { (m)-[:INCLUDES]->(ci {tenant_id: $tenantId}) WHERE ci.id IN $ciIds }')
    expect(c.params).toEqual({ tenantId: 't1', ciIds: ['srv-9', 'db-01'] })   // id ripetuti tolti
    // una sincronizzazione per mappa, non una per CI
    expect(enqueueServiceMapSync).toHaveBeenCalledTimes(2)
    expect(enqueueServiceMapSync).toHaveBeenNthCalledWith(1, 't1', 'map-1', 'periodic')
    expect(enqueueServiceMapSync).toHaveBeenNthCalledWith(2, 't1', 'map-2', 'periodic')
  })

  it('nessuna mappa interessata (o nessun id): non accoda nulla e non interroga il grafo a vuoto', async () => {
    onCypher([[/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)/, []]])
    expect(await notifyCIGraphChanged('t1', ['sconosciuto'], 'ci.deleted')).toBe(0)
    expect(enqueueServiceMapSync).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    expect(await notifyCIGraphChanged('t1', [], 'ci.deleted')).toBe(0)
    expect(await notifyCIGraphChanged('t1', [''], 'ci.deleted')).toBe(0)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('coda (o grafo) irraggiungibile: NON lancia — la scrittura CMDB è già committata — e logga ad alta severità', async () => {
    const { logger } = await import('../../lib/logger.js')
    const log = logger.child({})
    onCypher([[/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)/, [{ id: 'map-1' }]]])
    vi.mocked(enqueueServiceMapSync).mockRejectedValueOnce(new Error('redis down'))
    expect(await notifyCIGraphChanged('t1', ['db-01'], 'ci_relationship.removed:DEPENDS_ON')).toBe(0)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }), expect.stringMatching(/could NOT be enqueued/))

    vi.mocked(runQuery).mockRejectedValueOnce(new Error('neo4j down'))
    expect(await notifyCIGraphChanged('t1', ['db-01'], 'ci.deleted')).toBe(0)
  })
})

// ── S1: cancellazione di un CI (id sparito dal grafo ma ancora in node_ids) ───

describe('notifyCIGraphChanged: CI cancellato (revisione 2 · S1)', () => {
  it('id assente dal grafo ma presente in node_ids → la mappa viene accodata lo stesso', async () => {
    // la mutation cancella prima (DETACH DELETE porta via la INCLUDES) e notifica
    // dopo: l'EXISTS non trova più nulla, `node_ids` sì.
    const maps: { id: string }[] = []
    onCypher([[/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)/, (p?: Record<string, unknown>) => {
      const ids = p?.['ciIds'] as string[]
      // il finto grafo risponde solo sulla condizione node_ids
      return ids.includes('gone-1') ? [{ id: 'map-1' }] : maps
    }]])
    expect(await notifyCIGraphChanged('t1', ['gone-1'], 'ci.deleted')).toBe(1)
    expect(enqueueServiceMapSync).toHaveBeenCalledWith('t1', 'map-1', 'periodic')
  })

  it('dopo una sincronizzazione riuscita `node_ids` è ricalcolato dalle INCLUDES rimaste (l\'id sparito non resta lì per sempre)', () => {
    expect(SYNC_APPLY_CYPHER).toContain('[(m)-[:INCLUDES]->(ci {tenant_id: $tenantId}) | ci.id] AS includedIds')
    expect(SYNC_APPLY_CYPHER).toContain('SET m.node_ids = includedIds, m.stale = false, m.stale_reason = null, m.synced_at = $now')
  })
})

// ── D6.1: segnali di manutenzione ai servizi ─────────────────────────────────

describe('notifyCIMaintenanceChanged / notifyChangeWindowChanged (revisione 2 · D6.1)', () => {
  const MAPS_RE = /MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)-\[:INCLUDES\]->/
  const CHANGE_RE = /MATCH \(c:Change \{id: \$changeId, tenant_id: \$tenantId\}\)-\[:AFFECTS_CI\]->/

  it('accoda UNA valutazione (trigger maintenance) per ogni mappa non in pausa che include i CI; id ripetuti tolti', async () => {
    onCypher([[MAPS_RE, [{ id: 'map-1' }, { id: 'map-2' }]]])
    expect(await notifyCIMaintenanceChanged('t1', ['app-3', 'db-01', 'app-3'], 'ci.status:entered_maintenance')).toBe(2)
    const c = callMatching(MAPS_RE)!
    expect(c.cypher).toBe(MAPS_INCLUDING_CIS_CYPHER)
    expect(c.cypher).toContain("WHERE m.status <> 'paused' AND ci.id IN $ciIds")
    // non c'entra `auto_sync`: la composizione non cambia, cambia la salute
    expect(c.cypher).not.toContain('auto_sync')
    expect(c.params).toEqual({ tenantId: 't1', ciIds: ['app-3', 'db-01'] })
    expect(enqueueServiceMapEvaluation).toHaveBeenCalledTimes(2)
    expect(enqueueServiceMapEvaluation).toHaveBeenNthCalledWith(1, 't1', 'map-1', 'maintenance')
    expect(enqueueServiceMapEvaluation).toHaveBeenNthCalledWith(2, 't1', 'map-2', 'maintenance')
  })

  it('nessun id o nessuna mappa: non accoda nulla e non interroga il grafo a vuoto', async () => {
    onCypher([[MAPS_RE, []]])
    expect(await notifyCIMaintenanceChanged('t1', ['sconosciuto'], 'x')).toBe(0)
    expect(enqueueServiceMapEvaluation).not.toHaveBeenCalled()
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    expect(await notifyCIMaintenanceChanged('t1', [], 'x')).toBe(0)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('coda (o grafo) giù: NON lancia — la transizione della change è già scritta — e logga ad alta severità', async () => {
    const { logger } = await import('../../lib/logger.js')
    const log = logger.child({})
    onCypher([[MAPS_RE, [{ id: 'map-1' }]]])
    vi.mocked(enqueueServiceMapEvaluation).mockRejectedValueOnce(new Error('redis down'))
    expect(await notifyCIMaintenanceChanged('t1', ['app-3'], 'x')).toBe(0)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }), expect.stringMatching(/could NOT be enqueued/))
  })

  it('notifyChangeWindowChanged: legge gli AFFECTS_CI della change e passa di lì; una lettura fallita non lancia', async () => {
    onCypher([[CHANGE_RE, [{ id: 'app-3' }, { id: 'db-01' }]], [MAPS_RE, [{ id: 'map-1' }]]])
    expect(await notifyChangeWindowChanged('t1', 'chg-1', 'change.window_entered')).toBe(1)
    const c = callMatching(CHANGE_RE)!
    expect(c.cypher).toBe(CHANGE_AFFECTED_CIS_CYPHER)
    expect(c.params).toEqual({ tenantId: 't1', changeId: 'chg-1' })
    expect(callMatching(MAPS_RE)!.params).toEqual({ tenantId: 't1', ciIds: ['app-3', 'db-01'] })
    expect(enqueueServiceMapEvaluation).toHaveBeenCalledWith('t1', 'map-1', 'maintenance')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(runQuery).mockRejectedValueOnce(new Error('neo4j down'))
    expect(await notifyChangeWindowChanged('t1', 'chg-1', 'change.deleted')).toBe(0)
    expect(enqueueServiceMapEvaluation).not.toHaveBeenCalled()
  })

  it('change senza CI collegati: nessuna valutazione accodata', async () => {
    onCypher([[CHANGE_RE, []]])
    expect(await notifyChangeWindowChanged('t1', 'chg-1', 'change.window_left')).toBe(0)
    expect(enqueueServiceMapEvaluation).not.toHaveBeenCalled()
  })
})
