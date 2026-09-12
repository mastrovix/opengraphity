/**
 * services/serviceImpact/config.ts — configurazione della mappa dall'interfaccia
 * (ondata 2): validazione (vocabolari, scale, coerenza fra le soglie, peso,
 * elenchi), note leggibili per la cronologia, diff con il grafo di adesso
 * (aggiunti / spariti / spostati / esclusi), anteprima senza scrittura,
 * Cypher pinnato delle scritture (guardia di versione, UNWIND, `tenant_id`,
 * `toInteger`, voce di cronologia nello stesso statement), concorrenza su
 * `expectedVersion`, rivalutazione immediata e mappa `paused` non rivalutata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
// Revisione 2 · D6.2: la lettura della mappa prende `suppress_upstream_hops`
// dalla policy degli allarmi (cache in memoria): qui la policy è mockata, così
// la mappa resta UNA sola query nel test.
vi.mock('../events/policy.js', () => ({ getEventPolicy: vi.fn().mockResolvedValue({ suppress_upstream_hops: 1 }) }))

vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../middleware/metrics.js', () => ({
  workflowPurposeMissingTotal: { inc: vi.fn() },
  serviceEvaluationsTotal: { inc: vi.fn() }, serviceEvaluationDurationSeconds: { observe: vi.fn() }, servicesHealth: { set: vi.fn() },
  eventsSuppressedTotal: { inc: vi.fn() },
}))
vi.mock('../serviceImpact/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../serviceImpact/engine.js')>()),
  evaluateServiceMap: vi.fn(),
}))

vi.mock('../../lib/workflowHelpers.js', () => ({
  // Ondata 4 · A4-1: i passi della finestra di change vengono dallo SCOPO.
  // Il tenant di prova ha i nomi di fabbrica con gli scopi della migrazione.
  getStepNamesByPurpose: vi.fn(async (_s: unknown, _t: unknown, _e: unknown, purposes: readonly string[]) =>
    purposes.includes('implementation') ? ['deployment'] : ['scheduled']),
}))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { evaluateServiceMap } = await import('../serviceImpact/engine.js')
const {
  applyServiceMapProposal, assertExpectedVersion, assertServiceImpactRulesInput, assertServiceMapNodeInputs,
  previewServiceImpact, removeServiceMapExclusion, serviceMapProposal, serviceNodesChangeNote, serviceRulesChangeNote,
  setServiceMapAutoSync, updateServiceImpactRules, updateServiceMapNodes,
  APPLY_PROPOSAL_CYPHER, REMOVE_EXCLUSION_CYPHER, SERVICE_MAP_EXCLUSIONS_CYPHER, SET_AUTO_SYNC_CYPHER, UPDATE_NODES_CYPHER, UPDATE_RULES_CYPHER,
} = await import('../serviceImpact/config.js')
const { DEFAULT_SERVICE_IMPACT_RULES, DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_EXCLUSION_REASON_MANUAL } = await import('../../lib/serviceVocabularies.js')

const NOW = '2026-09-10T10:00:00.000Z'
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
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([s, cypher, params]) => ({ session: s, cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'nessun errore lanciato').toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

const LOAD_RE     = /MATCH \(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->/
const EXCL_RE     = /\[:EXCLUDES\]->\(ci \{tenant_id: \$tenantId\}\)/
const RULES_RE    = /SET m\.rules = \$rules/
const NODES_RE    = /SET inc\.propagate = n\.propagate/
const APPLY_RE    = /SET m\.node_ids = includedIds \+ \$keepMissing/
const UNEXCL_RE   = /MATCH \(m\)-\[e:EXCLUDES\]->\(ci \{id: \$ciId, tenant_id: \$tenantId\}\)/
const AUTOSYNC_RE = /SET m\.auto_sync = \$autoSync/

/** Mappa dell'esempio: api-03 (L1 critico), db-01, old-99 (non più raggiungibile); `gone-1` sparito dalla CMDB. */
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

const DIFF_CYPHER: Array<[RegExp, unknown]> = [[LOAD_RE, stateRow()], [/REALIZES/, ENTRY_ROW], [/apoc\.path\.expandConfig/, EXPANDED_ROWS], [EXCL_RE, EXCLUSION_ROWS]]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(evaluateServiceMap).mockResolvedValue({ mapId: 'map-1', health: 'degraded', previousHealth: 'operational', impactScore: 38, changed: true, stale: false, causes: [] })
})

// ── Validazione ──────────────────────────────────────────────────────────────

describe('validazione degli input', () => {
  const ok = { downSharePct: 50, degradedSharePct: 10, minNodes: 2, unknownNodes: 'operational', openIncidentFrom: 'down', duringStorm: 'hold' } as const

  it('regole: vocabolari e scale di assertServiceImpactRules, ma come BAD_USER_INPUT (input dell\'utente, non dato corrotto)', () => {
    expect(assertServiceImpactRulesInput(ok, 3)).toEqual({ version: 1, down_share_pct: 50, degraded_share_pct: 10, min_nodes: 2, unknown_nodes: 'operational', open_incident_from: 'down', during_storm: 'hold' })
    for (const [bad, pattern] of [
      [{ ...ok, downSharePct: 101 }, /down_share_pct must be an integer between 0 and 100/],
      [{ ...ok, degradedSharePct: -1 }, /degraded_share_pct must be an integer between 0 and 100/],
      [{ ...ok, minNodes: 0 }, /min_nodes must be an integer >= 1/],
      [{ ...ok, unknownNodes: 'maybe' }, /unknown_nodes must be one of: ignore, operational/],
      [{ ...ok, openIncidentFrom: 'always' }, /open_incident_from must be one of: never, down, degraded/],
      // Revisione 2 · D6.4: il comportamento durante una tempesta è un vocabolario chiuso come gli altri
      [{ ...ok, duringStorm: 'ignore' }, /during_storm must be one of: evaluate, hold/],
    ] as const) {
      const err = (() => { try { assertServiceImpactRulesInput(bad as never, 3); return null } catch (e) { return e } })()
      expect(err).toBeInstanceOf(GraphQLError)
      expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
      expect((err as GraphQLError).message).toMatch(pattern)
    }
  })

  it('coerenza: soglia degradato ≤ soglia giù; minimo componenti ≤ componenti della mappa (almeno 1)', () => {
    expect(() => assertServiceImpactRulesInput({ ...ok, degradedSharePct: 60 }, 3)).toThrow(/degraded_share_pct \(60\) must be <= rules\.down_share_pct \(50\)/)
    expect(() => assertServiceImpactRulesInput({ ...ok, minNodes: 4 }, 3)).toThrow(/min_nodes \(4\) must be <= the number of components of the map \(3\)/)
    // mappa vuota: il minimo resta 1 (mai 0)
    expect(assertServiceImpactRulesInput({ ...ok, minNodes: 1 }, 0).min_nodes).toBe(1)
    expect(() => assertServiceImpactRulesInput({ ...ok, minNodes: 2 }, 0)).toThrow(/must be <= the number of components of the map \(1\)/)
  })

  it('componenti: elenco non vuoto, senza doppioni, propagate nel vocabolario, peso 1..10, critico booleano', () => {
    expect(assertServiceMapNodeInputs([{ ciId: 'db-01', propagate: 'never', weight: 10, critical: true }])).toHaveLength(1)
    expect(() => assertServiceMapNodeInputs([])).toThrow(/nodes must not be empty/)
    expect(() => assertServiceMapNodeInputs([{ ciId: 'a', propagate: 'always', weight: 1, critical: false }, { ciId: 'a', propagate: 'always', weight: 1, critical: false }])).toThrow(/nodes: a appears twice/)
    expect(() => assertServiceMapNodeInputs([{ ciId: '', propagate: 'always', weight: 1, critical: false }])).toThrow(/ciId must be a non-empty id/)
    expect(() => assertServiceMapNodeInputs([{ ciId: 'a', propagate: 'sometimes' as never, weight: 1, critical: false }])).toThrow(/propagate must be one of: always, never, weighted/)
    for (const w of [0, 11, 2.5]) expect(() => assertServiceMapNodeInputs([{ ciId: 'a', propagate: 'always', weight: w, critical: false }])).toThrow(/weight must be an integer between 1 and 10/)
    expect(() => assertServiceMapNodeInputs([{ ciId: 'a', propagate: 'always', weight: 1, critical: 'si' as never }])).toThrow(/critical must be a boolean/)
  })

  it('expectedVersion intera ≥ 1', () => {
    expect(assertExpectedVersion(3)).toBe(3)
    for (const v of [0, -1, 1.5, '2', null]) expect(() => assertExpectedVersion(v)).toThrow(/expectedVersion must be an integer >= 1/)
  })

  it('note leggibili: campi cambiati con etichette italiane; nessun cambiamento → BAD_USER_INPUT (una scrittura a vuoto alzerebbe la versione)', () => {
    expect(serviceRulesChangeNote(DEFAULT_SERVICE_IMPACT_RULES, { ...DEFAULT_SERVICE_IMPACT_RULES, down_share_pct: 70, min_nodes: 2, unknown_nodes: 'ignore', open_incident_from: 'never' }))
      .toBe('Regole aggiornate: soglia giù 50 → 70, minimo componenti 1 → 2, componenti senza salute operativi → ignorati, apri incident da giù → mai')
    expect(() => serviceRulesChangeNote(DEFAULT_SERVICE_IMPACT_RULES, { ...DEFAULT_SERVICE_IMPACT_RULES })).toThrow(/rules are identical to the current ones/)
    expect(serviceNodesChangeNote(['DB-01'])).toBe('1 componente aggiornato: DB-01')
    expect(serviceNodesChangeNote(['A', 'B', 'C', 'D', 'E'])).toBe('5 componenti aggiornati: A, B, C, e altri 2')
  })
})

// ── Diff ─────────────────────────────────────────────────────────────────────

describe('serviceMapProposal (diff con il grafo di adesso)', () => {
  it('ricostruisce con maxDepth e relationshipTypes della mappa, non riprone gli esclusi; aggiunti / spariti (CI cancellato incluso) / spostati / esclusi / totale', async () => {
    onCypher(DIFF_CYPHER)
    const d = await serviceMapProposal('t1', 'map-1', NOW)
    expect(d).toMatchObject({ mapId: 'map-1', version: 2, status: 'active', maxDepth: 4, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'], totalProposed: 3 })
    expect(d.added.map((n) => [n.ciId, n.level, n.via, n.role, n.weight])).toEqual([['srv-9', 2, 'api-03', 'infrastructure', 5]])
    expect(d.moved.map((m) => [m.node.ciId, m.node.level, m.proposedLevel, m.node.via, m.proposedVia])).toEqual([['db-01', 2, 3, 'api-03', 'srv-9']])
    expect(d.removed.map((r) => [r.ciId, r.node?.ciId ?? null, r.reason])).toEqual([['old-99', 'old-99', 'unreachable'], ['gone-1', null, 'unreachable']])
    expect(d.excluded).toEqual(EXCLUSION_ROWS)
    // la profondità e le relazioni della ricostruzione sono quelle salvate sulla mappa
    expect(callMatching(/apoc\.path\.expandConfig/)!.params).toMatchObject({ tenantId: 't1', maxLevel: 3, relFilter: 'DEPENDS_ON>|HOSTED_ON>' })
    const x = callMatching(EXCL_RE)!
    expect(x.cypher).toBe(SERVICE_MAP_EXCLUSIONS_CYPHER)
    expect(x.cypher).toContain('MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})-[:EXCLUDES]->(ci {tenant_id: $tenantId})')
    expect(x.params).toEqual({ mapId: 'map-1', tenantId: 't1' })
    expect(getSession).toHaveBeenCalledWith()   // sola lettura
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('D6.3: un componente dismesso è proposto in rimozione con motivo `lifecycle`, non fra gli spostati; un CI dismesso nel grafo non viene proposto come nuovo', async () => {
    const nodes = [
      { ciId: 'api-03', name: 'API-03', labels: ['Application'], level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', healthSource: null, status: 'active', changes: [] },
      // db-01 è dismesso E spostato nel grafo di adesso: vince la rimozione
      { ciId: 'db-01', name: 'DB-01', labels: ['Database'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'down', healthSource: null, status: 'decommissioned', changes: [] },
    ]
    onCypher([
      [LOAD_RE, stateRow({ props: { node_ids: ['api-03', 'db-01'], stale: false }, nodes })],
      [/REALIZES/, ENTRY_ROW],
      // srv-9 è dismesso nel grafo: non va proposto come componente nuovo
      [/apoc/, [
        { ciId: 'srv-9', name: 'SRV-09', level: 2, via: 'api-03', labels: ['Server'], status: 'decommissioned', health: null },
        { ...EXPANDED_ROWS[2]!, status: 'decommissioned' },
      ]],
      [EXCL_RE, []],
    ])
    const d = await serviceMapProposal('t1', 'map-1', NOW)
    expect(d.added).toEqual([])
    expect(d.moved).toEqual([])
    expect(d.removed.map((r) => [r.ciId, r.reason])).toEqual([['db-01', 'lifecycle']])
    expect(d.totalProposed).toBe(1)   // il dismesso non entra nel tetto
  })

  it('mappa allineata: nessun aggiunto/sparito/spostato; mappa inesistente → NOT_FOUND', async () => {
    onCypher([
      [LOAD_RE, stateRow({ props: { node_ids: ['api-03'], stale: false }, nodes: [{ ciId: 'api-03', name: 'API-03', labels: ['Application'], level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', healthSource: null, status: 'active', changes: [] }] })],
      [/REALIZES/, ENTRY_ROW], [/apoc/, []], [EXCL_RE, []],
    ])
    const d = await serviceMapProposal('t1', 'map-1', NOW)
    expect([d.added, d.removed, d.moved, d.excluded]).toEqual([[], [], [], []])
    expect(d.totalProposed).toBe(1)
    onCypher([[LOAD_RE, null]])
    await expectCode(serviceMapProposal('t1', 'map-x', NOW), 'NOT_FOUND')
  })
})

// ── Anteprima ────────────────────────────────────────────────────────────────

describe('previewServiceImpact', () => {
  it('calcolo sullo stato reale con le sostituzioni: nessuna scrittura, nessuna sessione WRITE', async () => {
    onCypher([[LOAD_RE, stateRow()]])
    const p = await previewServiceImpact({ tenantId: 't1', mapId: 'map-1', now: NOW })
    // db-01 giù (5) su 18 di peso → 28 %, sotto il 50 % di down_share_pct → degradato
    expect(p).toMatchObject({ health: 'degraded', impactScore: 28, contributingCount: 3, nodeCount: 3 })
    expect(p.causes.map((c) => [c.ciId, c.ci.name, c.ci.type, c.path.map((x) => x.id)])).toEqual([['db-01', 'DB-01', 'database', ['db-01', 'api-03']]])
    expect(getSession).toHaveBeenCalledWith()
    expect(vi.mocked(runQueryOne).mock.calls).toHaveLength(1)
    expect(session.executeWrite).not.toHaveBeenCalled()
    expect(evaluateServiceMap).not.toHaveBeenCalled()
  })

  it('regole sostituite (soglia giù abbassata) e nodi sostituiti (peso e «non pesa») cambiano l\'esito, senza toccare il grafo', async () => {
    onCypher([[LOAD_RE, stateRow()]])
    const down = await previewServiceImpact({ tenantId: 't1', mapId: 'map-1', now: NOW, rules: { downSharePct: 20, degradedSharePct: 1, minNodes: 1, unknownNodes: 'operational', openIncidentFrom: 'down', duringStorm: 'hold' } })
    expect(down.health).toBe('down')
    onCypher([[LOAD_RE, stateRow()]])
    const off = await previewServiceImpact({ tenantId: 't1', mapId: 'map-1', now: NOW, nodes: [{ ciId: 'db-01', propagate: 'never', weight: 5, critical: false }] })
    expect(off).toMatchObject({ health: 'operational', impactScore: 0, contributingCount: 2, nodeCount: 3 })
    expect(vi.mocked(runQueryOne).mock.calls.every((c) => LOAD_RE.test(c[1] as string))).toBe(true)
  })

  it('un ciId non nella mappa → BAD_USER_INPUT con l\'id; regole fuori scala → BAD_USER_INPUT (mai un calcolo su valori inventati)', async () => {
    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(previewServiceImpact({ tenantId: 't1', mapId: 'map-1', now: NOW, nodes: [{ ciId: 'nope', propagate: 'always', weight: 5, critical: false }] }), 'BAD_USER_INPUT', /nodes: nope is not a component of ServiceMap map-1/)
    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(previewServiceImpact({ tenantId: 't1', mapId: 'map-1', now: NOW, rules: { downSharePct: 10, degradedSharePct: 90, minNodes: 1, unknownNodes: 'ignore', openIncidentFrom: 'never', duringStorm: 'evaluate' } }), 'BAD_USER_INPUT', /degraded_share_pct \(90\) must be <=/)
  })
})

// ── Regole ───────────────────────────────────────────────────────────────────

describe('updateServiceImpactRules', () => {
  const rules = { downSharePct: 70, degradedSharePct: 10, minNodes: 2, unknownNodes: 'ignore', openIncidentFrom: 'never', duringStorm: 'evaluate' } as const

  it('una transazione: guardia di versione nel Cypher, regole in JSON, version + 1, voce rules_changed con la nota e la salute presa dalla mappa; poi rivalutazione con lo stesso trigger', async () => {
    onCypher([[LOAD_RE, stateRow()], [RULES_RE, { version: 3, status: 'active' }]])
    const r = await updateServiceImpactRules({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, rules, actorId: 'u-1', now: NOW })
    expect(r).toMatchObject({ mapId: 'map-1', version: 3, status: 'active', note: 'Regole aggiornate: soglia giù 50 → 70, soglia degradato 1 → 10, minimo componenti 1 → 2, componenti senza salute operativi → ignorati, apri incident da giù → mai, durante una tempesta sospendi la valutazione → valuta comunque' })
    expect(r.evaluation).toMatchObject({ health: 'degraded' })

    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    // Due sessioni chiuse, non una: la scrittura (WRITE) e la lettura dei passi
    // di finestra per SCOPO, che dentro una `ManagedTransaction` non può
    // riusare nulla e apre la propria (ondata 4 · A4-1; a cache calda non
    // esegue nessuna query). La transazione di scrittura resta UNA.
    expect(session.close).toHaveBeenCalledTimes(2)
    const w = callMatching(RULES_RE)!
    expect(w.session).toBe(tx)
    expect(w.cypher).toBe(UPDATE_RULES_CYPHER)
    expect(w.cypher).toMatch(/MATCH \(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)\s+SET m\.version = m\.version \+ 1\s+WITH m, m\.version AS version\s+WHERE version = toInteger\(\$expectedVersion\) \+ 1/)
    expect(w.cypher).toContain('SET m.updated_at = $now, m.updated_by = $actorId')
    expect(w.cypher).toContain('CREATE (m)-[:HAS_HEALTH_HISTORY]->(:ServiceHealthEntry {id: $hId, tenant_id: $tenantId, map_id: m.id, at: $hAt, health: m.health, previous_health: null,')
    expect(w.cypher).toContain('impact_score: toInteger(m.impact_score), cause: m.explanation, trigger: $hTrigger, note: $hNote})')
    expect(w.params).toMatchObject({
      mapId: 'map-1', tenantId: 't1', expectedVersion: 2, now: NOW, actorId: 'u-1',
      rules: JSON.stringify({ version: 1, down_share_pct: 70, degraded_share_pct: 10, min_nodes: 2, unknown_nodes: 'ignore', open_incident_from: 'never', during_storm: 'evaluate' }),
      hTrigger: 'rules_changed', hAt: NOW, hNote: r.note,
    })
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 't1', mapId: 'map-1', trigger: 'rules_changed', actorId: 'u-1' })
  })

  it('mappa in pausa: scrive e versiona, ma NON rivaluta (la salute resta l\'ultima nota)', async () => {
    onCypher([[LOAD_RE, stateRow({ props: { status: 'paused' } })], [RULES_RE, { version: 3, status: 'paused' }]])
    const r = await updateServiceImpactRules({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, rules, actorId: 'u-1', now: NOW })
    expect(r.evaluation).toBeNull()
    expect(callMatching(RULES_RE)).toBeDefined()
    expect(evaluateServiceMap).not.toHaveBeenCalled()
  })

  it('versione diversa → BAD_USER_INPUT con la versione attuale, senza scrivere né rivalutare; mappa assente → NOT_FOUND; regole identiche → BAD_USER_INPUT', async () => {
    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(updateServiceImpactRules({ tenantId: 't1', mapId: 'map-1', expectedVersion: 1, rules, actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /modified by someone else \(expected version 1, current is 2, updated at T-prec\)/)
    expect(callMatching(RULES_RE)).toBeUndefined()
    expect(evaluateServiceMap).not.toHaveBeenCalled()
    // 2 = sessione di scrittura + lettura dei passi di finestra per scopo (vedi sopra)
    expect(session.close).toHaveBeenCalledTimes(2)

    onCypher([[LOAD_RE, null]])
    await expectCode(updateServiceImpactRules({ tenantId: 't1', mapId: 'map-x', expectedVersion: 2, rules, actorId: 'u-1', now: NOW }), 'NOT_FOUND')

    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(updateServiceImpactRules({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, rules: { downSharePct: 50, degradedSharePct: 1, minNodes: 1, unknownNodes: 'operational', openIncidentFrom: 'down', duringStorm: 'hold' }, actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /identical to the current ones/)
    expect(callMatching(RULES_RE)).toBeUndefined()
  })

  it('la guardia di versione scatta nel Cypher (gara persa dopo la lettura) → errore, transazione annullata', async () => {
    onCypher([[LOAD_RE, stateRow()], [RULES_RE, null]])
    await expect(updateServiceImpactRules({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, rules, actorId: 'u-1', now: NOW }))
      .rejects.toThrow(/changed while writing its configuration \(expected version 2\)/)
    expect(evaluateServiceMap).not.toHaveBeenCalled()
  })
})

// ── Impostazioni dei componenti ──────────────────────────────────────────────

describe('updateServiceMapNodes', () => {
  const nodes = [{ ciId: 'db-01', propagate: 'never' as const, weight: 7, critical: true }, { ciId: 'old-99', propagate: 'weighted' as const, weight: 2, critical: false }]

  it('UNA query con UNWIND scopata per tenant: solo propagate/weight/critical, toInteger sul peso, nota con i nomi, poi rivalutazione', async () => {
    onCypher([[LOAD_RE, stateRow()], [NODES_RE, { version: 3, status: 'active', updated: 2 }]])
    const r = await updateServiceMapNodes({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, nodes, actorId: 'u-1', now: NOW })
    expect(r).toMatchObject({ version: 3, note: '2 componenti aggiornati: DB-01, OLD-99' })
    const w = callMatching(NODES_RE)!
    expect(w.cypher).toBe(UPDATE_NODES_CYPHER)
    expect(w.cypher).toMatch(/CALL \{\s+WITH m\s+UNWIND \$nodes AS n\s+MATCH \(m\)-\[inc:INCLUDES\]->\(ci \{id: n\.ciId, tenant_id: \$tenantId\}\)/)
    expect(w.cypher).toContain('SET inc.propagate = n.propagate, inc.weight = toInteger(n.weight), inc.critical = n.critical')
    expect(w.cypher).toContain('RETURN count(inc) AS updated')
    expect(w.cypher).not.toContain('inc.level')
    expect(w.cypher).not.toContain('inc.role')
    expect(w.params).toMatchObject({ mapId: 'map-1', tenantId: 't1', expectedVersion: 2, actorId: 'u-1', hTrigger: 'rules_changed', hNote: r.note, nodes })
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 't1', mapId: 'map-1', trigger: 'rules_changed', actorId: 'u-1' })
  })

  it('elenco vuoto o ciId non nella mappa → BAD_USER_INPUT con l\'id, senza scrivere; meno righe aggiornate del previsto → errore (transazione annullata)', async () => {
    await expectCode(updateServiceMapNodes({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, nodes: [], actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /nodes must not be empty/)
    expect(runQueryOne).not.toHaveBeenCalled()

    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(updateServiceMapNodes({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, nodes: [{ ciId: 'nope', propagate: 'always', weight: 5, critical: false }], actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /nodes: nope is not a component of ServiceMap map-1/)
    expect(callMatching(NODES_RE)).toBeUndefined()

    onCypher([[LOAD_RE, stateRow()], [NODES_RE, { version: 3, status: 'active', updated: 1 }]])
    await expect(updateServiceMapNodes({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, nodes, actorId: 'u-1', now: NOW }))
      .rejects.toThrow(/1 of 2 components could be updated/)
    expect(evaluateServiceMap).not.toHaveBeenCalled()
  })

  it('versione diversa → BAD_USER_INPUT prima di ogni scrittura', async () => {
    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(updateServiceMapNodes({ tenantId: 't1', mapId: 'map-1', expectedVersion: 9, nodes, actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /expected version 9, current is 2/)
    expect(callMatching(NODES_RE)).toBeUndefined()
  })
})

// ── Applicazione del diff ────────────────────────────────────────────────────

describe('applyServiceMapProposal', () => {
  const applied = { version: 3, status: 'active', added: 1, excluded: 1, removed: 1, included: 3 }

  it('aggiunge con le impostazioni proposte (added_by manual), esclude e toglie in uno statement; node_ids ricalcolato e stale spento quando gli id spariti sono stati tolti', async () => {
    onCypher([...DIFF_CYPHER, [APPLY_RE, applied]])
    const r = await applyServiceMapProposal({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, add: ['srv-9'], exclude: ['old-99'], remove: ['gone-1'], actorId: 'u-1', now: NOW })
    expect(r).toMatchObject({ version: 3, status: 'active', note: 'Mappa aggiornata: +1, −1, esclusi 1' })

    const w = callMatching(APPLY_RE)!
    expect(w.session).toBe(tx)
    expect(w.cypher).toBe(APPLY_PROPOSAL_CYPHER)
    expect(w.cypher).toMatch(/WITH m, m\.version AS version\s+WHERE version = toInteger\(\$expectedVersion\)/)
    expect(w.cypher).toContain('MATCH (ci {id: n.ciId, tenant_id: $tenantId})')
    expect(w.cypher).toContain("CREATE (m)-[:INCLUDES {level: toInteger(n.level), role: n.role, propagate: n.propagate, weight: toInteger(n.weight),")
    expect(w.cypher).toContain("critical: n.critical, via: n.via, added_by: 'manual', added_at: $now}]->(ci)")
    expect(w.cypher).toMatch(/MERGE \(m\)-\[e:EXCLUDES\]->\(ci\)\s+ON CREATE SET e\.reason = \$excludeReason, e\.excluded_by = \$actorId, e\.at = \$now/)
    expect(w.cypher).toMatch(/OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->\(ci \{id: rid, tenant_id: \$tenantId\}\)\s+WITH collect\(inc\) AS incs\s+FOREACH \(x IN incs \| DELETE x\)/)
    expect(w.cypher).toContain('[(m)-[:INCLUDES]->(ci {tenant_id: $tenantId}) | ci.id] AS includedIds')
    expect(w.cypher).toContain('SET m.node_ids = includedIds + $keepMissing, m.stale = size($keepMissing) > 0')
    expect(w.params).toMatchObject({
      mapId: 'map-1', tenantId: 't1', expectedVersion: 2, actorId: 'u-1', now: NOW,
      addNodes: [{ ciId: 'srv-9', level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03' }],
      excludeIds: ['old-99'], removeIds: ['old-99'], keepMissing: [], excludeReason: SERVICE_EXCLUSION_REASON_MANUAL,
      hTrigger: 'map_changed', hNote: 'Mappa aggiornata: +1, −1, esclusi 1',
    })
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 't1', mapId: 'map-1', trigger: 'map_changed', actorId: 'u-1' })
  })

  it('un id sparito non tolto resta in node_ids (la mappa resta stale)', async () => {
    onCypher([...DIFF_CYPHER, [APPLY_RE, { ...applied, excluded: 0, removed: 0, added: 1 }]])
    await applyServiceMapProposal({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, add: ['srv-9'], exclude: [], remove: [], actorId: 'u-1', now: NOW })
    expect(callMatching(APPLY_RE)!.params).toMatchObject({ keepMissing: ['gone-1'], removeIds: [], excludeIds: [] })
  })

  it('ogni id deve appartenere alla proposta o alla mappa, le liste sono disgiunte e almeno una piena', async () => {
    const bad = async (args: { add?: string[]; exclude?: string[]; remove?: string[] }, pattern: RegExp) => {
      onCypher([...DIFF_CYPHER])
      await expectCode(applyServiceMapProposal({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, add: args.add ?? [], exclude: args.exclude ?? [], remove: args.remove ?? [], actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', pattern)
      expect(callMatching(APPLY_RE)).toBeUndefined()
    }
    await bad({ add: ['db-01'] }, /add: db-01 is not a component of the proposal \(added\)/)
    await bad({ add: ['cert-x'] }, /add: cert-x is not a component of the proposal \(added\)/)   // escluso: mai riproposto
    await bad({ exclude: ['ghost'] }, /exclude: ghost is not a component of the proposal or of the map/)
    await bad({ remove: ['srv-9'] }, /remove: srv-9 is not a component of the map/)
    await bad({ add: ['srv-9', 'srv-9'] }, /add: srv-9 appears twice/)
    await bad({ add: ['srv-9'], exclude: ['srv-9'] }, /must be disjoint: srv-9 appears in more than one list/)
    await bad({}, /add, exclude and remove are all empty/)
  })

  it('conteggi che non tornano (un CI sparito durante la scrittura) → errore, transazione annullata, nessuna rivalutazione', async () => {
    onCypher([...DIFF_CYPHER, [APPLY_RE, { ...applied, added: 0 }]])
    await expect(applyServiceMapProposal({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, add: ['srv-9'], exclude: ['old-99'], remove: ['gone-1'], actorId: 'u-1', now: NOW }))
      .rejects.toThrow(/applied 0\/1 additions, 1\/1 exclusions, 1\/1 removals \(a CI vanished while writing\)/)
    expect(evaluateServiceMap).not.toHaveBeenCalled()
  })

  it('versione diversa → BAD_USER_INPUT senza scrivere', async () => {
    onCypher([...DIFF_CYPHER])
    await expectCode(applyServiceMapProposal({ tenantId: 't1', mapId: 'map-1', expectedVersion: 7, add: ['srv-9'], exclude: [], remove: [], actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /expected version 7, current is 2/)
    expect(callMatching(APPLY_RE)).toBeUndefined()
  })
})

// ── Esclusioni ───────────────────────────────────────────────────────────────

describe('removeServiceMapExclusion', () => {
  it('toglie la EXCLUDES scopata per tenant, versiona, scrive la voce map_changed col nome del CI e rivaluta', async () => {
    onCypher([[LOAD_RE, stateRow()], [EXCL_RE, EXCLUSION_ROWS], [UNEXCL_RE, { version: 3, status: 'active', removed: 1 }]])
    const r = await removeServiceMapExclusion({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, ciId: 'cert-x', actorId: 'u-1', now: NOW })
    expect(r).toMatchObject({ version: 3, note: 'Esclusione rimossa: CERT-X' })
    const w = callMatching(UNEXCL_RE)!
    expect(w.cypher).toBe(REMOVE_EXCLUSION_CYPHER)
    expect(w.cypher).toMatch(/WITH collect\(e\) AS excludes\s+FOREACH \(x IN excludes \| DELETE x\)\s+RETURN size\(excludes\) AS removed/)
    expect(w.params).toMatchObject({ mapId: 'map-1', tenantId: 't1', expectedVersion: 2, ciId: 'cert-x', hTrigger: 'map_changed', hNote: r.note })
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 't1', mapId: 'map-1', trigger: 'map_changed', actorId: 'u-1' })
  })

  it('CI non escluso → BAD_USER_INPUT senza scrivere; relazione sparita fra lettura e scrittura → errore', async () => {
    onCypher([[LOAD_RE, stateRow()], [EXCL_RE, EXCLUSION_ROWS]])
    await expectCode(removeServiceMapExclusion({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, ciId: 'db-01', actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /ciId: db-01 is not excluded from ServiceMap map-1/)
    expect(callMatching(UNEXCL_RE)).toBeUndefined()
    onCypher([[LOAD_RE, stateRow()], [EXCL_RE, EXCLUSION_ROWS], [UNEXCL_RE, { version: 3, status: 'active', removed: 0 }]])
    await expect(removeServiceMapExclusion({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, ciId: 'cert-x', actorId: 'u-1', now: NOW }))
      .rejects.toThrow(/exclusion of cert-x was not removed \(0 relationships deleted\)/)
  })
})

// ── Interruttore della mappa viva (ondata 5) ─────────────────────────────────

describe('setServiceMapAutoSync', () => {
  it('cambia solo auto_sync, versiona, scrive la voce map_changed con la nota leggibile e NON rivaluta la mappa', async () => {
    onCypher([[LOAD_RE, stateRow()], [AUTOSYNC_RE, { version: 3, status: 'active' }]])
    const r = await setServiceMapAutoSync({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, autoSync: false, actorId: 'u-1', now: NOW })
    expect(r).toMatchObject({ version: 3, status: 'active', note: 'Aggiornamento automatico disattivato', evaluation: null })
    const w = callMatching(AUTOSYNC_RE)!
    expect(w.cypher).toBe(SET_AUTO_SYNC_CYPHER)
    expect(w.cypher).toContain('WHERE version = toInteger($expectedVersion)')
    expect(w.cypher).toContain('SET m.updated_at = $now, m.updated_by = $actorId')
    // nessun'altra proprietà della mappa viene toccata
    expect(w.cypher).not.toMatch(/SET m\.rules|SET m\.node_ids|SET m\.status/)
    expect(w.params).toMatchObject({ mapId: 'map-1', tenantId: 't1', expectedVersion: 2, autoSync: false, hTrigger: 'map_changed', hNote: r.note })
    // cambiare modalità non cambia né i componenti né la loro salute
    expect(evaluateServiceMap).not.toHaveBeenCalled()
  })

  it('accendere l\'interruttore su una mappa congelata: nota speculare', async () => {
    onCypher([[LOAD_RE, stateRow({ props: { auto_sync: false } })], [AUTOSYNC_RE, { version: 3, status: 'active' }]])
    const r = await setServiceMapAutoSync({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, autoSync: true, actorId: 'u-1', now: NOW })
    expect(r.note).toBe('Aggiornamento automatico attivato')
  })

  it('stesso valore → BAD_USER_INPUT senza scrivere (alzerebbe la versione con una voce vuota); versione diversa → conflitto; auto_sync assente → la migrazione', async () => {
    onCypher([[LOAD_RE, stateRow()]])
    await expectCode(setServiceMapAutoSync({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, autoSync: true, actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /already has autoSync true: nothing to save/)
    expect(callMatching(AUTOSYNC_RE)).toBeUndefined()

    await expectCode(setServiceMapAutoSync({ tenantId: 't1', mapId: 'map-1', expectedVersion: 5, autoSync: false, actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /expected version 5, current is 2/)
    await expectCode(setServiceMapAutoSync({ tenantId: 't1', mapId: 'map-1', expectedVersion: 0, autoSync: false, actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /expectedVersion must be an integer >= 1/)
    await expectCode(setServiceMapAutoSync({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, autoSync: 'si' as never, actorId: 'u-1', now: NOW }), 'BAD_USER_INPUT', /autoSync must be a boolean/)

    onCypher([[LOAD_RE, stateRow({ props: { auto_sync: undefined } })]])
    await expect(setServiceMapAutoSync({ tenantId: 't1', mapId: 'map-1', expectedVersion: 2, autoSync: false, actorId: 'u-1', now: NOW }))
      .rejects.toThrow(/has no auto_sync \(got undefined\) — run the 20260910_1110_service_map_auto_sync migration/)
  })
})
