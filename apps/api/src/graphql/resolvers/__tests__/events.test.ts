/**
 * events.ts — updateEventPolicy valida (enum, interi ≥ 0, severity_map con le
 * tre chiavi) e persiste il merge; linkEventToCI sostituisce il RAISED_ON,
 * crea l'alias (valore minuscolo, mai per kind `name`) e ricalcola la salute del CI;
 * resolveEvent marca resolved, ricalcola la salute del CI e pubblica event.resolved;
 * createIncidentFromEvent delega all'apertura condivisa; filtri di `events`;
 * ruoli sulle mutation amministrative. Ondata 2: sampleInboundPayload,
 * payloadKeys, monitoringSources, ciHealth, previewInboundEvents (nessuna
 * scrittura), sendSampleEvent (accoda con la config della sorgente),
 * setCIHealthOverride (manual / ripristino). Ondata 3: reevaluateEvent,
 * filtri incidentId/suppressedByChangeId, Event.suppressedBy/correlation,
 * Incident.correlatedEvents, Change.suppressedEvents (pipeline mockata).
 * Revisione ondata 3 (prestazioni): riga con sorgente/incident/utente risolti
 * nella stessa query e field resolver cortocircuitati (P-1), ciHealthOverview
 * in una query senza OPTIONAL MATCH moltiplicativi (P-2), eventStats per
 * stato sull'indice (P-3), ricerca full-text e pagina+totale in una query
 * (P-4), liste di Incident/Change paginate con contatore (P-5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/incidentService.js', () => ({ createIncident: vi.fn() }))
vi.mock('../../../jobs/eventIngestWorker.js', () => ({ enqueueEvents: vi.fn() }))
vi.mock('../../../services/eventService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/eventService.js')>()),
  getEventPolicy: vi.fn(), setEventPolicy: vi.fn().mockResolvedValue(undefined), recomputeCIHealth: vi.fn().mockResolvedValue('down'),
}))
// Ondata 3: apertura condivisa e pipeline (soppressione/salute/correlazione)
// sono testate in services/__tests__/eventCorrelation.test.ts.
vi.mock('../../../services/eventCorrelation.js', () => ({
  openIncidentFromEvent: vi.fn(), runEventPipeline: vi.fn(),
  // chiave/identità del gruppo (pure, stesse regole del servizio) e opzioni del lock: createIncidentFromEvent si serializza con la correlazione automatica
  GROUP_LOCK_OPTS: { ttlSeconds: 30, waitMs: 5_000, pollMs: 100 },
  groupLockKey: (t: string, g: string, id: string) => `og:events:group:${t}:${g === 'ci' ? 'ci' : 'fp'}:${id}`,
  groupIdOf: (policy: { group_by: string }, ev: { ciId: string | null; props: Record<string, unknown> }) => (policy.group_by === 'ci' && ev.ciId ? ev.ciId : String(ev.props['fingerprint'] ?? ev.props['id'])),
}))
// Il lock Redis (lib/__tests__/redisLock.test.ts) qui esegue subito la sezione critica; si verifica solo chiave e opzioni.
vi.mock('../../../lib/redisLock.js', () => ({ withRedisLock: vi.fn(async (_k: string, _o: unknown, run: () => Promise<unknown>) => run()) }))
// Ondata 4: le tempeste (contatori Redis) sono in services/__tests__/eventStorm.test.ts.
vi.mock('../../../services/eventStorm.js', () => ({ listStormSources: vi.fn().mockResolvedValue([]) }))
vi.mock('../change/queries.js', () => ({ change: vi.fn() }))
// reevaluateEvent: i passi terminali dell'incident (per "incident ancora aperto") vengono dal workflow.
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: vi.fn().mockResolvedValue([
    { name: 'new', isInitial: true, isTerminal: false, isOpen: true, category: 'new', stepOrder: 1 },
    { name: 'resolved', isInitial: false, isTerminal: true, isOpen: false, category: 'resolved', stepOrder: 4 },
    { name: 'closed', isInitial: false, isTerminal: true, isOpen: false, category: 'closed', stepOrder: 5 },
  ]),
}))

const { eventResolvers } = await import('../events.js')
const { listStormSources } = await import('../../../services/eventStorm.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { getEventPolicy, setEventPolicy, recomputeCIHealth } = await import('../../../services/eventService.js')
const { openIncidentFromEvent, runEventPipeline } = await import('../../../services/eventCorrelation.js')
const { withRedisLock } = await import('../../../lib/redisLock.js')
const { PAYLOAD_MAX_CHARS, SAMPLE_LABEL } = await import('../events.js')
const { MAX_EVENTS_PER_REQUEST, PAYLOAD_MAX_DEPTH } = await import('../../../services/eventService.js')
const { authorize } = await import('../../../lib/authorization.js')
const { change: loadChange } = await import('../change/queries.js')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const { audit } = await import('../../../lib/audit.js')
const { enqueueEvents } = await import('../../../jobs/eventIngestWorker.js')
const { SAMPLE_PAYLOADS, GENERIC_SAMPLE_CONFIG } = await import('../../../lib/eventSamples.js')
const { DEFAULT_EVENT_POLICY } = await import('../../../lib/eventPolicy.js')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'adm-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, userId: 'op-1', role: 'operator' }
const session = { close: vi.fn().mockResolvedValue(undefined) }

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string) => {
    for (const [re, value] of rules) if (re.test(cypher)) return typeof value === 'function' ? (value as () => unknown)() : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string) => { const r = await impl(s, c); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

const eventRow = (over: Record<string, unknown> = {}, ci: { ciId: string | null; ciName?: string; ciStatus?: string; ciHealth?: string; ciLabels?: string[] } = { ciId: null }) => ({
  props: { id: 'ev-1', fingerprint: 'fp', status: 'firing', severity: 'critical', title: 'DiskFull', resource: 'DB-01', resource_kind: 'hostname', count: 3, first_seen_at: 'T0', last_seen_at: 'T1', source_id: 'hook-1', labels: '{}', correlation: 'none', ...over },
  ciId: ci.ciId, ciName: ci.ciName ?? null, ciStatus: ci.ciStatus ?? null, ciHealth: ci.ciHealth ?? null, ciLabels: ci.ciLabels ?? null,
})
const pipelineResult = (over: Record<string, unknown> = {}) => ({ outcome: 'none', status: 'firing', suppressedByChangeId: null, incidentId: null, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(getEventPolicy).mockResolvedValue(structuredClone(DEFAULT_EVENT_POLICY))
  vi.mocked(recomputeCIHealth).mockResolvedValue('down')
  vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
})

// ── updateEventPolicy ────────────────────────────────────────────────────────

describe('updateEventPolicy', () => {
  it('input parziale valido → merge sulla policy attuale, persistito, restituito in camelCase con severityMap JSON', async () => {
    const out = await eventResolvers.Mutation.updateEventPolicy(null, { input: { openIncidentFrom: 'warning', flapThreshold: 6, autoResolve: false } }, admin)
    expect(setEventPolicy).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ open_incident_from: 'warning', flap_threshold: 6, auto_resolve: false, group_by: 'ci', retention_days: 90 }))
    expect(out).toMatchObject({ openIncidentFrom: 'warning', flapThreshold: 6, autoResolve: false, groupBy: 'ci', openDelaySeconds: 0, suppressUpstreamHops: 1, flapWindowMinutes: 10, retentionDays: 90 })
    expect(JSON.parse(out.severityMap)).toEqual(DEFAULT_EVENT_POLICY.severity_map)
    // C-4: versione incrementata e updatedAt scritto, nell'audit le due versioni
    expect(out).toMatchObject({ version: 2, updatedAt: expect.any(String) })
    expect(setEventPolicy).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ version: 2, updated_at: expect.any(String) }))
    expect(audit).toHaveBeenCalledWith(admin, 'event_policy.updated', 'Tenant', 'tenant-1', expect.objectContaining({ version: 2, previousVersion: 1 }))
  })

  it('C-4 — expectedVersion uguale all\'attuale → salva; diverso → BAD_USER_INPUT (modifica concorrente) senza persistere', async () => {
    vi.mocked(getEventPolicy).mockResolvedValue({ ...structuredClone(DEFAULT_EVENT_POLICY), version: 3, updated_at: '2026-09-09T10:00:00.000Z' })
    const out = await eventResolvers.Mutation.updateEventPolicy(null, { input: { retentionDays: 30, expectedVersion: 3 } }, admin)
    expect(out).toMatchObject({ version: 4, retentionDays: 30 })
    vi.clearAllMocks()
    vi.mocked(getEventPolicy).mockResolvedValue({ ...structuredClone(DEFAULT_EVENT_POLICY), version: 3, updated_at: '2026-09-09T10:00:00.000Z' })
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: { retentionDays: 30, expectedVersion: 2 } }, admin), 'BAD_USER_INPUT', /modified by someone else \(expected version 2, current is 3, updated at 2026-09-09T10:00:00\.000Z\)/)
    expect(setEventPolicy).not.toHaveBeenCalled()
  })

  it('I-7 — massimi e coerenza: hops > 10, tempesta con raffreddamento 0 → BAD_USER_INPUT con campo e limite, nulla persistito', async () => {
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: { suppressUpstreamHops: 11 } }, admin), 'BAD_USER_INPUT', /suppress_upstream_hops must be at most 10\. Got: 11/)
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: { openDelaySeconds: 86_401 } }, admin), 'BAD_USER_INPUT', /open_delay_seconds must be at most 86400/)
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: { stormCooldownMinutes: 0 } }, admin), 'BAD_USER_INPUT', /storm_cooldown_minutes must be > 0 when storm_threshold_per_minute is > 0/)
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: { flapWindowMinutes: 0 } }, admin), 'BAD_USER_INPUT', /flap_window_minutes must be > 0 when flap_threshold is > 0/)
    expect(setEventPolicy).not.toHaveBeenCalled()
  })

  it('ondata 4 — flapStableMinutes / stormThresholdPerMinute / stormCooldownMinutes: persistiti in snake_case e restituiti; negativi rifiutati', async () => {
    const out = await eventResolvers.Mutation.updateEventPolicy(null, { input: { flapStableMinutes: 20, stormThresholdPerMinute: 0, stormCooldownMinutes: 10 } }, admin)
    expect(setEventPolicy).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ flap_stable_minutes: 20, storm_threshold_per_minute: 0, storm_cooldown_minutes: 10 }))
    expect(out).toMatchObject({ flapStableMinutes: 20, stormThresholdPerMinute: 0, stormCooldownMinutes: 10, flapThreshold: 4 })
    vi.clearAllMocks()
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: { stormCooldownMinutes: -1 } }, admin), 'BAD_USER_INPUT', /storm_cooldown_minutes must be an integer >= 0/)
    expect(setEventPolicy).not.toHaveBeenCalled()
  })

  it('severityMap valida (JSON con le tre chiavi) → persistita decodificata', async () => {
    const severityMap = JSON.stringify({ critical: { impact: 'high', urgency: 'medium' }, warning: { impact: 'low', urgency: 'low' }, info: { impact: 'low', urgency: 'low' } })
    const out = await eventResolvers.Mutation.updateEventPolicy(null, { input: { severityMap } }, admin)
    expect(vi.mocked(setEventPolicy).mock.calls[0]![1].severity_map.critical).toEqual({ impact: 'high', urgency: 'medium' })
    expect(JSON.parse(out.severityMap).critical).toEqual({ impact: 'high', urgency: 'medium' })
  })

  it.each([
    ['openIncidentFrom fuori enum', { openIncidentFrom: 'always' }, /open_incident_from must be one of: info, warning, critical, never/],
    ['groupBy fuori enum', { groupBy: 'host' }, /group_by must be one of: ci, fingerprint/],
    ['intero negativo', { retentionDays: -1 }, /retention_days must be an integer >= 0/],
    ['non intero', { flapThreshold: 2.5 }, /flap_threshold must be an integer >= 0/],
    ['null esplicito', { openDelaySeconds: null }, /openDelaySeconds cannot be null/],
    ['severityMap non JSON', { severityMap: '{nope' }, /severityMap is not valid JSON/],
    ['severityMap senza una chiave', { severityMap: JSON.stringify({ critical: { impact: 'high', urgency: 'high' }, warning: { impact: 'medium', urgency: 'medium' } }) }, /severityMap\.info is missing/],
    ['severityMap con impact fuori enum', { severityMap: JSON.stringify({ ...DEFAULT_EVENT_POLICY.severity_map, info: { impact: 'none', urgency: 'low' } }) }, /severityMap\.info\.impact must be one of: low, medium, high/],
    ['severityMap con chiave estranea', { severityMap: JSON.stringify({ ...DEFAULT_EVENT_POLICY.severity_map, fatal: { impact: 'high', urgency: 'high' } }) }, /unknown keys: fatal/],
  ])('%s → BAD_USER_INPUT, nulla persistito', async (_n, input, pattern) => {
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: input as never }, admin), 'BAD_USER_INPUT', pattern)
    expect(setEventPolicy).not.toHaveBeenCalled()
  })

  it('operator → FORBIDDEN (seconda linea oltre alla policy centrale)', async () => {
    await expectCode(eventResolvers.Mutation.updateEventPolicy(null, { input: { flapThreshold: 1 } }, operator), 'FORBIDDEN')
    expect(getEventPolicy).not.toHaveBeenCalled()
  })

  it('eventPolicy (query) restituisce la policy del tenant in camelCase', async () => {
    const out = await eventResolvers.Query.eventPolicy(null, null, operator)
    expect(out).toMatchObject({ openIncidentFrom: 'critical', groupBy: 'ci', autoResolve: true, retentionDays: 90 })
    expect(getEventPolicy).toHaveBeenCalledWith('tenant-1')
  })
})

// ── linkEventToCI ────────────────────────────────────────────────────────────

describe('linkEventToCI', () => {
  /** Il frammento CI_REF viene letto due volte (prima e dopo il collegamento): prima il CI vecchio, poi quello nuovo. */
  const before = (a: unknown, b: unknown) => { let n = 0; return () => (n++ === 0 ? a : b) }

  it('createAlias su evento hostname → sostituisce il RAISED_ON, MERGE CIAlias con valore minuscolo e ALIAS_OF, ricalcola il vecchio CI e rivaluta l\'evento (pipeline senza ritardo)', async () => {
    const newRow = eventRow({ correlation: 'opened' }, { ciId: 'ci-new', ciName: 'db-01', ciStatus: 'active', ciHealth: 'down', ciLabels: ['Server'] })
    onCypher([
      [/MATCH \(e:Event \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, before(eventRow({}, { ciId: 'ci-old', ciName: 'old' }), newRow)],
      [/MERGE \(e\)-\[:RAISED_ON\]->\(target\)/, newRow],
      [/MATCH \(a:CIAlias \{tenant_id: \$tenantId, kind: \$kind, value: \$value\}\)-\[:ALIAS_OF\]/, null],   // nessun alias esistente
      [/MERGE \(a:CIAlias/, null],
    ])
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ outcome: 'opened', incidentId: 'inc-1' }) as never)
    const out = await eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-new', createAlias: true }, operator)
    expect(out.ci).toEqual({ id: 'ci-new', name: 'db-01', type: 'server', status: 'active', health: 'down' })
    expect(out.correlation).toBe('opened')

    const link = callMatching(/MERGE \(e\)-\[:RAISED_ON\]->\(target\)/)!
    expect(link.cypher).toContain('MATCH (target:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(link.cypher).toMatch(/OPTIONAL MATCH \(e\)-\[old:RAISED_ON\]->\(other:ConfigurationItem\) WHERE other\.id <> \$ciId\s+DELETE old/)
    expect(link.params).toMatchObject({ id: 'ev-1', ciId: 'ci-new', tenantId: 'tenant-1' })

    const alias = callMatching(/MERGE \(a:CIAlias/)!
    expect(alias.cypher).toContain("MERGE (a:CIAlias {tenant_id: $tenantId, kind: $kind, value: $value})")
    expect(alias.cypher).toContain("ON CREATE SET a.id = $aliasId, a.source = 'manual'")
    expect(alias.cypher).toContain('ON MATCH SET a.updated_by = $userId, a.updated_at = $now')   // I-8
    expect(alias.cypher).toContain('MERGE (a)-[:ALIAS_OF]->(ci)')
    expect(alias.cypher).not.toMatch(/DELETE old/)   // A-4: mai ri-puntato in silenzio
    expect(alias.params).toMatchObject({ tenantId: 'tenant-1', ciId: 'ci-new', kind: 'hostname', value: 'db-01', userId: 'op-1' })
    // la verifica del duplicato precede ogni scrittura, scoped per tenant
    expect(callMatching(/MATCH \(a:CIAlias \{tenant_id: \$tenantId, kind: \$kind, value: \$value\}\)-\[:ALIAS_OF\]->\(ci:ConfigurationItem \{tenant_id: \$tenantId\}\)/)!.params).toEqual({ tenantId: 'tenant-1', kind: 'hostname', value: 'db-01' })

    // il CI vecchio si ricalcola qui; il nuovo dentro la pipeline (dopo la soppressione)
    expect(vi.mocked(recomputeCIHealth).mock.calls).toEqual([['tenant-1', 'ci-old', 'op-1']])
    expect(runEventPipeline).toHaveBeenCalledWith({ tenantId: 'tenant-1', eventId: 'ev-1', actorId: 'op-1', now: expect.any(String), mode: 'reevaluate' })
    expect(audit).toHaveBeenCalledWith(operator, 'event.linked', 'Event', 'ev-1', { ciId: 'ci-new', previousCiId: 'ci-old', aliasCreated: true, correlation: 'opened' })
  })

  it('kind `name` → nessun alias anche con createAlias; senza createAlias idem; evento orfano → nessun ricalcolo del CI vecchio, solo pipeline', async () => {
    // la regola del MERGE va per prima: anche quella query contiene il frammento CI_REF
    onCypher([
      [/MERGE \(e\)-\[:RAISED_ON\]->\(target\)/, eventRow({ resource_kind: 'name' }, { ciId: 'ci-1', ciName: 'x', ciLabels: ['Application'] })],
      [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, before(eventRow({ resource_kind: 'name' }), eventRow({ resource_kind: 'name' }, { ciId: 'ci-1', ciName: 'x', ciLabels: ['Application'] }))],
    ])
    const out = await eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-1', createAlias: true }, operator)
    expect(out.ci).toMatchObject({ id: 'ci-1', type: 'application' })
    expect(callMatching(/CIAlias/)).toBeUndefined()
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(runEventPipeline).toHaveBeenCalledTimes(1)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
    onCypher([
      [/MERGE \(e\)-\[:RAISED_ON\]->\(target\)/, eventRow({}, { ciId: 'ci-1', ciName: 'x', ciLabels: ['Server'] })],
      [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, before(eventRow(), eventRow({}, { ciId: 'ci-1', ciName: 'x', ciLabels: ['Server'] }))],
    ])
    await eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-1' }, operator)
    expect(callMatching(/CIAlias/)).toBeUndefined()
  })

  it('evento inesistente → NOT_FOUND; CI inesistente → NOT_FOUND, nessun ricalcolo', async () => {
    onCypher([[/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, null]])
    await expectCode(eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-x', ciId: 'ci-1' }, operator), 'NOT_FOUND', /Event ev-x/)
    onCypher([[/MERGE \(e\)-\[:RAISED_ON\]->\(target\)/, null], [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow()]])
    await expectCode(eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-x' }, operator), 'NOT_FOUND', /ConfigurationItem ci-x/)
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(runEventPipeline).not.toHaveBeenCalled()
  })

  it('A-4 — createAlias con alias già esistente verso un ALTRO CI → BAD_USER_INPUT che cita il CI attuale, nessuna scrittura (né RAISED_ON né alias), nessuna pipeline', async () => {
    onCypher([
      [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow()],
      [/MATCH \(a:CIAlias \{tenant_id: \$tenantId, kind: \$kind, value: \$value\}\)-\[:ALIAS_OF\]/, { ciId: 'ci-other', ciName: 'db-01 (prod)' }],
    ])
    await expectCode(eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-new', createAlias: true }, operator), 'BAD_USER_INPUT', /Alias hostname=db-01 already points to CI "db-01 \(prod\)" \(ci-other\)/)
    expect(callMatching(/MERGE/)).toBeUndefined()
    expect(runEventPipeline).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('A-4 — alias già esistente verso lo STESSO CI → MERGE idempotente (ON MATCH aggiorna updated_by); senza createAlias nessuna verifica dell\'alias', async () => {
    const linked = eventRow({}, { ciId: 'ci-1', ciName: 'db-01', ciLabels: ['Server'] })
    onCypher([
      [/MERGE \(e\)-\[:RAISED_ON\]->\(target\)/, linked],
      [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, before(eventRow(), linked)],
      [/MATCH \(a:CIAlias \{tenant_id: \$tenantId, kind: \$kind, value: \$value\}\)-\[:ALIAS_OF\]/, { ciId: 'ci-1', ciName: 'db-01' }],
      [/MERGE \(a:CIAlias/, null],
    ])
    await eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-1', createAlias: true }, operator)
    expect(callMatching(/MERGE \(a:CIAlias/)).toBeDefined()
    expect(audit).toHaveBeenCalledWith(operator, 'event.linked', 'Event', 'ev-1', expect.objectContaining({ aliasCreated: true }))

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
    onCypher([[/MERGE \(e\)-\[:RAISED_ON\]->\(target\)/, linked], [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, before(eventRow(), linked)]])
    await eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-1', createAlias: false }, operator)
    expect(callMatching(/CIAlias/)).toBeUndefined()
  })

  it('I-8 — createAlias con risorsa vuota → BAD_USER_INPUT (stessa validazione di createCIAlias), nessuna scrittura', async () => {
    onCypher([[/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow({ resource: '   ' })]])
    await expectCode(eventResolvers.Mutation.linkEventToCI(null, { eventId: 'ev-1', ciId: 'ci-1', createAlias: true }, operator), 'BAD_USER_INPUT', /alias value \(event resource, hostname\) must be at least 1 characters/)
    expect(callMatching(/MERGE/)).toBeUndefined()
  })
})

// ── resolveEvent ─────────────────────────────────────────────────────────────

describe('resolveEvent', () => {
  it('SET resolved + resolved_at + nota, pipeline (salute del CI + chiusura automatica dell\'incident), event.resolved pubblicato, audit', async () => {
    onCypher([[/SET e\.status = 'resolved', e\.resolved_at = \$now/, eventRow({ status: 'resolved', resolved_at: 'NOW' }, { ciId: 'ci-1', ciName: 'db', ciLabels: ['Server'] })]])
    const out = await eventResolvers.Mutation.resolveEvent(null, { id: 'ev-1', note: 'falso allarme' }, operator)
    expect(out).toMatchObject({ id: 'ev-1', status: 'resolved', resolvedAt: 'NOW', ci: { id: 'ci-1', type: 'server' } })
    const set = callMatching(/SET e\.status = 'resolved'/)!
    expect(set.cypher).toContain('MATCH (e:Event {id: $id, tenant_id: $tenantId})')
    // I-1: guardia di stato nel WHERE e residui di soppressione/sfarfallio azzerati
    expect(set.cypher).toContain('WHERE e.status IN $resolvable')
    expect(set.cypher).toContain('e.suppressed_by_change_id = null, e.flapping_since = null')
    expect(set.params).toMatchObject({ id: 'ev-1', tenantId: 'tenant-1', userId: 'op-1', note: 'falso allarme', resolvable: ['firing', 'suppressed', 'flapping'] })
    expect(runEventPipeline).toHaveBeenCalledWith({ tenantId: 'tenant-1', eventId: 'ev-1', actorId: 'op-1', now: expect.any(String), mode: 'reevaluate' })
    expect(recomputeCIHealth).not.toHaveBeenCalled()   // lo fa la pipeline
    expect(publishEvent).toHaveBeenCalledWith('event.resolved', 'tenant-1', 'op-1', expect.objectContaining({ id: 'ev-1', status: 'resolved', ci_id: 'ci-1', entity_type: 'event' }), expect.any(String))
    expect(audit).toHaveBeenCalledWith(operator, 'event.resolved', 'Event', 'ev-1', { note: 'falso allarme' })
  })

  it('evento orfano → pipeline comunque (chiusura automatica); evento inesistente → NOT_FOUND senza pipeline né pubblicazione', async () => {
    onCypher([[/SET e\.status = 'resolved'/, eventRow({ status: 'resolved' })]])
    await eventResolvers.Mutation.resolveEvent(null, { id: 'ev-1' }, operator)
    expect(runEventPipeline).toHaveBeenCalledTimes(1)
    expect(publishEvent).toHaveBeenCalledTimes(1)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/SET e\.status = 'resolved'/, null], [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, null]])
    await expectCode(eventResolvers.Mutation.resolveEvent(null, { id: 'ev-x' }, operator), 'NOT_FOUND')
    expect(runEventPipeline).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('I-1 — evento già risolto → BAD_USER_INPUT (non NOT_FOUND), nessuna pipeline né event.resolved né audit; suppressed e flapping si risolvono', async () => {
    onCypher([[/SET e\.status = 'resolved'/, null], [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow({ status: 'resolved', resolved_at: 'T-1' })]])
    await expectCode(eventResolvers.Mutation.resolveEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT', /Event ev-1 is already resolved \(since T-1\): only firing\/suppressed\/flapping events can be resolved/)
    expect(runEventPipeline).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()

    for (const status of ['suppressed', 'flapping']) {
      vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
      onCypher([[/SET e\.status = 'resolved'/, eventRow({ status: 'resolved', suppressed_by_change_id: null, flapping_since: null })]])
      const out = await eventResolvers.Mutation.resolveEvent(null, { id: 'ev-1' }, operator)
      expect(out, status).toMatchObject({ status: 'resolved', suppressedByChangeId: null, flappingSince: null })
      expect(publishEvent).toHaveBeenCalledTimes(1)
    }
  })
})

// ── createIncidentFromEvent ──────────────────────────────────────────────────

describe('createIncidentFromEvent', () => {
  it('evento con CI non ancora correlato → apertura condivisa (openIncidentFromEvent) con attore = utente e manual = true, audit', async () => {
    vi.mocked(openIncidentFromEvent).mockResolvedValueOnce({ id: 'inc-1', number: 'INC00000001' } as never)
    const row = eventRow({ severity: 'warning', description: 'dettaglio' }, { ciId: 'ci-1', ciName: 'db', ciLabels: ['Server'] })
    onCypher([
      [/MATCH \(e:Event \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH/, row],
      [/CORRELATED_INTO\]->\(i:Incident \{tenant_id: \$tenantId\}\)\s+RETURN i\.id/, null],
    ])
    const out = await eventResolvers.Mutation.createIncidentFromEvent(null, { eventId: 'ev-1' }, operator)
    expect(out).toMatchObject({ id: 'inc-1' })
    expect(openIncidentFromEvent).toHaveBeenCalledWith({ tenantId: 'tenant-1', props: row.props, ciId: 'ci-1', actorId: 'op-1', manual: true })
    expect(audit).toHaveBeenCalledWith(operator, 'event.incident_created', 'Event', 'ev-1', { incidentId: 'inc-1' })
    // I-2: serializzata con la correlazione automatica sul lock del gruppo (policy group_by = ci → il CI)
    expect(withRedisLock).toHaveBeenCalledWith('og:events:group:tenant-1:ci:ci-1', { ttlSeconds: 30, waitMs: 5_000, pollMs: 100 }, expect.any(Function), undefined, expect.stringMatching(/manual incident creation/))
    // lettura e controllo "già correlato" avvengono dentro il lock: la rilettura dopo l'attesa
    expect(calls().filter((c) => /OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/.test(c.cypher))).toHaveLength(2)
  })

  it('I-2 — evento resolved / suppressed / flapping → BAD_USER_INPUT senza apertura; raggruppamento per impronta → lock sull\'impronta', async () => {
    for (const status of ['resolved', 'suppressed', 'flapping']) {
      vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
      vi.mocked(getEventPolicy).mockResolvedValue(structuredClone(DEFAULT_EVENT_POLICY))
      onCypher([[/OPTIONAL MATCH/, eventRow({ status }, { ciId: 'ci-1' })]])
      await expectCode(eventResolvers.Mutation.createIncidentFromEvent(null, { eventId: 'ev-1' }, operator), 'BAD_USER_INPUT', new RegExp(`Event ev-1 is ${status}: only a firing event can open an incident`))
      expect(openIncidentFromEvent).not.toHaveBeenCalled()
      expect(callMatching(/RETURN i\.id AS incidentId/)).toBeUndefined()   // nessuna lettura "già correlato" (la riga porta CORRELATED_INTO nel frammento, non è quella)
    }
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(getEventPolicy).mockResolvedValue({ ...structuredClone(DEFAULT_EVENT_POLICY), group_by: 'fingerprint' })
    vi.mocked(openIncidentFromEvent).mockResolvedValueOnce({ id: 'inc-2' } as never)
    onCypher([[/OPTIONAL MATCH/, eventRow({ fingerprint: 'fp-9' }, { ciId: 'ci-1' })], [/RETURN i\.id/, null]])
    await eventResolvers.Mutation.createIncidentFromEvent(null, { eventId: 'ev-1' }, operator)
    expect(withRedisLock).toHaveBeenCalledWith('og:events:group:tenant-1:fp:fp-9', expect.anything(), expect.any(Function), undefined, expect.any(String))
  })

  it('evento orfano → BAD_USER_INPUT (dall\'apertura condivisa); già correlato → BAD_USER_INPUT con l\'incident, senza chiamare l\'apertura', async () => {
    const { ValidationError } = await import('../../../lib/errors.js')
    vi.mocked(openIncidentFromEvent).mockRejectedValueOnce(new ValidationError('Evento orfano: collega prima un CI (linkEventToCI) — un incident deve avere almeno un CI impattato'))
    onCypher([[/OPTIONAL MATCH/, eventRow()], [/RETURN i\.id/, null]])
    await expectCode(eventResolvers.Mutation.createIncidentFromEvent(null, { eventId: 'ev-1' }, operator), 'BAD_USER_INPUT', /orfano.*linkEventToCI/)
    expect(openIncidentFromEvent).toHaveBeenCalledWith(expect.objectContaining({ ciId: null, manual: true }))

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/OPTIONAL MATCH/, eventRow({}, { ciId: 'ci-1' })], [/RETURN i\.id/, { incidentId: 'inc-9' }]])
    await expectCode(eventResolvers.Mutation.createIncidentFromEvent(null, { eventId: 'ev-1' }, operator), 'BAD_USER_INPUT', /already correlated into incident inc-9/)
    expect(openIncidentFromEvent).not.toHaveBeenCalled()
  })
})

// ── reevaluateEvent / campi di correlazione (ondata 3) ───────────────────────

describe('reevaluateEvent', () => {
  it('evento suppressed → pipeline in modalità reevaluate con l\'attore dell\'utente, audit, restituisce l\'evento riletto', async () => {
    let reads = 0
    onCypher([[/MATCH \(e:Event \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH/, () => (reads++ === 0
      ? eventRow({ status: 'suppressed', correlation: 'suppressed', suppressed_by_change_id: 'chg-1' }, { ciId: 'ci-1', ciLabels: ['Server'] })
      : eventRow({ status: 'firing', correlation: 'opened', correlation_at: 'T2' }, { ciId: 'ci-1', ciLabels: ['Server'] }))]])
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ outcome: 'opened', incidentId: 'inc-1' }) as never)
    const out = await eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator)
    expect(out).toMatchObject({ id: 'ev-1', status: 'firing', correlation: 'opened', correlationAt: 'T2', suppressedByChangeId: null })
    expect(runEventPipeline).toHaveBeenCalledWith({ tenantId: 'tenant-1', eventId: 'ev-1', actorId: 'op-1', mode: 'reevaluate' })
    expect(audit).toHaveBeenCalledWith(operator, 'event.reevaluated', 'Event', 'ev-1', { previousStatus: 'suppressed', previousCorrelation: 'suppressed', outcome: 'opened', incidentId: 'inc-1' })
  })

  it.each([['delayed'], ['pending'], ['none'], ['skipped_orphan'], ['skipped_severity'], ['suppressed'], ['storm_no_ci']])('evento firing con correlation %s → rivalutabile senza leggere gli incident', async (correlation) => {
    onCypher([[/OPTIONAL MATCH/, eventRow({ correlation })]])
    await eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, admin)
    expect(runEventPipeline).toHaveBeenCalledTimes(1)
    expect(callMatching(/HAS_WORKFLOW/)).toBeUndefined()   // openIncidentOfEvent non viene letto
  })

  it.each([['opened'], ['attached'], ['reopened'], ['storm']])('evento firing %s con incident ancora aperto → rifiuto esplicito (BAD_USER_INPUT con numero e passo dell\'incident), nessuna pipeline; incident chiuso → rivalutabile', async (correlation) => {
    onCypher([[/OPTIONAL MATCH/, eventRow({ correlation })], [/CORRELATED_INTO/, { incidentId: 'inc-1', number: 'INC00000007', step: 'in_progress' }]])
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT', /already correlated into open incident INC00000007 \(step "in_progress"\): nothing to re-evaluate/)
    expect(callMatching(/HAS_WORKFLOW/)!.params).toMatchObject({ id: 'ev-1', tenantId: 'tenant-1', terminalSteps: ['resolved', 'closed'] })
    expect(runEventPipeline).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/OPTIONAL MATCH/, eventRow({ correlation })], [/CORRELATED_INTO/, null]])
    await eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator)
    expect(runEventPipeline).toHaveBeenCalledTimes(1)
  })

  it('evento risolto o in sfarfallio → BAD_USER_INPUT senza pipeline; inesistente → NOT_FOUND; viewer → FORBIDDEN', async () => {
    onCypher([[/OPTIONAL MATCH/, eventRow({ status: 'resolved', correlation: 'attached' })]])
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT', /only suppressed or firing events can be re-evaluated/)
    onCypher([[/OPTIONAL MATCH/, eventRow({ status: 'flapping', correlation: 'flapping' })]])
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT')
    onCypher([[/OPTIONAL MATCH/, eventRow({ correlation: 'flapping' })]])   // firing con esito incoerente
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT', /not re-evaluable/)
    expect(runEventPipeline).not.toHaveBeenCalled()
    onCypher([[/OPTIONAL MATCH/, null]])
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-x' }, operator), 'NOT_FOUND')
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, viewer), 'FORBIDDEN')
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('campi di correlazione', () => {
  it('mapEvent: correlation e correlationAt esposti; evento senza correlation → errore che indica la migrazione', async () => {
    const { mapEvent } = await import('../events.js')
    const row = eventRow({ correlation: 'attached', correlation_at: 'T3', suppressed_by_change_id: 'chg-1' })
    expect(mapEvent(row.props, row)).toMatchObject({ correlation: 'attached', correlationAt: 'T3', suppressedByChangeId: 'chg-1' })
    const legacy = eventRow(); delete (legacy.props as Record<string, unknown>)['correlation']
    expect(() => mapEvent(legacy.props, legacy)).toThrow(/20260909_1030_event_management_correlation_rules/)
  })

  it('mapEvent: M9 maxSeverity e M2 resourceExternalId esposti; assenti (eventi pre-ondata 4) → null, mai un valore inventato', async () => {
    const { mapEvent } = await import('../events.js')
    const row = eventRow({ severity: 'warning', max_severity: 'critical', resource_external_id: 'HOST-1A2B' })
    expect(mapEvent(row.props, row)).toMatchObject({ severity: 'warning', maxSeverity: 'critical', resourceExternalId: 'HOST-1A2B' })
    const bare = eventRow()
    expect(mapEvent(bare.props, bare)).toMatchObject({ maxSeverity: null, resourceExternalId: null })
  })

  it('Event.suppressedBy → null senza change; con change carica la change del tenant', async () => {
    await expect(eventResolvers.Event.suppressedBy({ id: 'ev-1', acknowledgedById: null, sourceId: null, suppressedByChangeId: null }, null, operator)).resolves.toBeNull()
    expect(loadChange).not.toHaveBeenCalled()
    vi.mocked(loadChange).mockResolvedValueOnce({ id: 'chg-1', code: 'CHG00000001' } as never)
    await expect(eventResolvers.Event.suppressedBy({ id: 'ev-1', acknowledgedById: null, sourceId: null, suppressedByChangeId: 'chg-1' }, null, operator)).resolves.toMatchObject({ id: 'chg-1' })
    expect(loadChange).toHaveBeenCalledWith(null, { id: 'chg-1' }, operator)
  })

  it('Incident.correlatedEvents e Change.suppressedEvents → query scoped per tenant, ordinate per last_seen_at DESC, paginate (P-5: default 100, cap 500) con la riga completa (P-1)', async () => {
    onCypher([[/CORRELATED_INTO\]->\(i:Incident \{id: \$id, tenant_id: \$tenantId\}\)/, [eventRow({ correlation: 'opened' }, { ciId: 'ci-1', ciLabels: ['Server'] })]]])
    const ev = await eventResolvers.Incident.correlatedEvents({ id: 'inc-1' }, {}, operator)
    expect(ev).toEqual([expect.objectContaining({ id: 'ev-1', correlation: 'opened', ci: expect.objectContaining({ id: 'ci-1' }) })])
    const q1 = callMatching(/CORRELATED_INTO\]->\(i:Incident/)!
    expect(q1.cypher).toContain('MATCH (e:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {id: $id, tenant_id: $tenantId})')
    expect(q1.cypher).toMatch(/ORDER BY e\.last_seen_at DESC\s+SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)\s+OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/)
    expect(q1.cypher).toContain('OPTIONAL MATCH (src:InboundWebhook {id: e.source_id, tenant_id: $tenantId})')
    expect(q1.params).toEqual({ id: 'inc-1', tenantId: 'tenant-1', limit: 100, offset: 0 })

    onCypher([[/SUPPRESSED_BY\]->\(c:Change \{id: \$id, tenant_id: \$tenantId\}\)/, [eventRow({ status: 'suppressed', correlation: 'suppressed' })]]])
    const sup = await eventResolvers.Change.suppressedEvents({ id: 'chg-1' }, { limit: 9000, offset: -3 }, operator)
    expect(sup).toEqual([expect.objectContaining({ id: 'ev-1', status: 'suppressed' })])
    expect(callMatching(/SUPPRESSED_BY/)!.params).toEqual({ id: 'chg-1', tenantId: 'tenant-1', limit: 500, offset: 0 })
  })

  it('P-5 — correlatedEventCount / suppressedEventCount → COUNT { } scoped per tenant sul nodo padre; padre inesistente → NOT_FOUND (mai 0 inventato)', async () => {
    onCypher([[/MATCH \(i:Incident \{id: \$id, tenant_id: \$tenantId\}\)\s+RETURN COUNT \{ \(:Event \{tenant_id: \$tenantId\}\)-\[:CORRELATED_INTO\]->\(i\) \} AS n/, { n: 1234 }]])
    await expect(eventResolvers.Incident.correlatedEventCount({ id: 'inc-1' }, null, viewer)).resolves.toBe(1234)
    expect(callMatching(/CORRELATED_INTO/)!.params).toEqual({ id: 'inc-1', tenantId: 'tenant-1' })
    onCypher([[/MATCH \(c:Change \{id: \$id, tenant_id: \$tenantId\}\)\s+RETURN COUNT \{ \(:Event \{tenant_id: \$tenantId\}\)-\[:SUPPRESSED_BY\]->\(c\) \} AS n/, { n: 0 }]])
    await expect(eventResolvers.Change.suppressedEventCount({ id: 'chg-1' }, null, viewer)).resolves.toBe(0)
    onCypher([[/COUNT \{/, null]])
    await expectCode(eventResolvers.Incident.correlatedEventCount({ id: 'inc-x' }, null, viewer), 'NOT_FOUND', /Incident inc-x/)
    await expectCode(eventResolvers.Change.suppressedEventCount({ id: 'chg-x' }, null, viewer), 'NOT_FOUND', /Change chg-x/)
  })
})

// ── events (query) / stats / alias ───────────────────────────────────────────

/** La riga della console con le tre giunzioni di P-1 (incident più recente, sorgente ridotta a MonitoringSourceRef, utente). */
const joinedRow = (over: Record<string, unknown> = {}) => ({
  ...eventRow({ correlation: 'attached', acknowledged_by: 'u-1', ...over }, { ciId: 'ci-1', ciName: 'db-01', ciStatus: 'active', ciHealth: 'down', ciLabels: ['Server'] }),
  incident: { id: 'inc-1', number: 'INC00000001', title: 'T', status: 'new', tenant_id: 'tenant-1', created_at: 'T0' },
  source: { id: 'hook-1', name: 'Zabbix', connector_kind: 'zabbix', enabled: true },
  acknowledgedBy: { id: 'u-1', name: 'Ada', email: 'a@x.io', role: 'operator', tenant_id: 'tenant-1' },
})
const PAGE_RE = /RETURN total, items/

describe('events', () => {
  it('filtri → WHERE scoped per tenant, ordinamento last_seen_at DESC, paginazione e total in UNA query (P-4); CI, incident, sorgente e utente nella riga (P-1); con search la sorgente è l\'indice full-text', async () => {
    onCypher([[PAGE_RE, { total: 7, items: [joinedRow(), eventRow({ id: 'ev-2' })] }]])
    const out = await eventResolvers.Query.events(null, { filter: { status: ['firing'], severity: ['critical', 'warning'], orphan: false, search: ' DB-01 ', since: '2026-09-01T00:00:00Z', sourceId: 'hook-1', ciId: 'ci-1', incidentId: 'inc-1', suppressedByChangeId: 'chg-1' }, limit: 10, offset: 20 }, operator)
    expect(out.total).toBe(7)
    expect(out.items).toHaveLength(2)
    expect(out.items[0]).toMatchObject({
      id: 'ev-1', status: 'firing', count: 3, correlation: 'attached', ci: { id: 'ci-1', name: 'db-01', type: 'server', status: 'active', health: 'down' },
      incident: { id: 'inc-1', number: 'INC00000001' }, source: { id: 'hook-1', name: 'Zabbix', connectorKind: 'zabbix', enabled: true }, acknowledgedBy: { id: 'u-1', name: 'Ada' },
    })
    expect(out.items[1]!.ci).toBeNull()
    expect(calls()).toHaveLength(1)   // era 1 + 1 (count) + 50×3 (field resolver) per pagina
    const list = callMatching(PAGE_RE)!
    expect(list.cypher).toContain("CALL db.index.fulltext.queryNodes('event_search', $search) YIELD node AS e")
    expect(list.cypher).not.toMatch(/CONTAINS/)
    expect(list.cypher).toContain('e.tenant_id = $tenantId')
    expect(list.cypher).toContain('e.status IN $status')
    expect(list.cypher).toContain('e.severity IN $severity')
    expect(list.cypher).toContain('e.source_id = $sourceId')
    expect(list.cypher).toContain('EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {id: $ciId, tenant_id: $tenantId}) }')
    expect(list.cypher).toContain('EXISTS { (e)-[:CORRELATED_INTO]->(:Incident {id: $incidentId, tenant_id: $tenantId}) }')
    expect(list.cypher).toContain('EXISTS { (e)-[:SUPPRESSED_BY]->(:Change {id: $suppressedByChangeId, tenant_id: $tenantId}) }')
    expect(list.cypher).toContain('e.last_seen_at >= $since')
    // totale in un CALL { } senza importazioni; la pagina è tagliata PRIMA delle giunzioni e raccolta con collect
    expect(list.cypher).toMatch(/CALL \{\s+CALL db\.index\.fulltext[\s\S]+RETURN count\(e\) AS total\s+\}/)
    expect(list.cypher).toMatch(/ORDER BY e\.last_seen_at DESC\s+SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)\s+OPTIONAL MATCH \(e\)-\[:RAISED_ON\]->\(ci:ConfigurationItem \{tenant_id: \$tenantId\}\)/)
    expect(list.cypher).toContain('[(e)-[:CORRELATED_INTO]->(inc:Incident {tenant_id: $tenantId}) | inc]')
    expect(list.cypher).toContain('OPTIONAL MATCH (src:InboundWebhook {id: e.source_id, tenant_id: $tenantId})')
    expect(list.cypher).toContain('OPTIONAL MATCH (ack:User {id: e.acknowledged_by, tenant_id: $tenantId})')
    // A-2: della sorgente passano solo i campi di MonitoringSourceRef
    expect(list.cypher).toContain('{id: src.id, name: src.name, connector_kind: src.connector_kind, enabled: src.enabled}')
    expect(list.cypher).toMatch(/RETURN collect\(\{props: props, ciId: ciId, [^}]*incident: incident, source: source, acknowledgedBy: acknowledgedBy\}\) AS items/)
    expect(list.params).toMatchObject({ tenantId: 'tenant-1', limit: 10, offset: 20, search: '*db* AND *01*', status: ['firing'], incidentId: 'inc-1', suppressedByChangeId: 'chg-1' })
  })

  it('senza search → MATCH (e:Event) sull\'indice, nessun full-text; search senza lettere né cifre → pagina vuota senza sessione (nessun token può combaciare)', async () => {
    onCypher([[PAGE_RE, { total: 0, items: [] }]])
    await eventResolvers.Query.events(null, { filter: { status: ['firing'] } }, operator)
    const list = callMatching(PAGE_RE)!
    expect(list.cypher).not.toMatch(/fulltext/)
    expect(list.cypher).toMatch(/CALL \{\s+MATCH \(e:Event\)\s+WHERE e\.tenant_id = \$tenantId AND e\.status IN \$status\s+RETURN count\(e\) AS total/)
    expect(list.params).not.toHaveProperty('search')
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expect(eventResolvers.Query.events(null, { filter: { search: ' --- ' } }, operator)).resolves.toEqual({ items: [], total: 0 })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('P-4 — eventSearchLucene: run di lettere/cifre → *run* in AND, minuscolo, caratteri speciali Lucene mai passati, unicode conservato, niente run → null', async () => {
    const { eventSearchLucene } = await import('../events.js')
    expect(eventSearchLucene('api-03.example.local')).toBe('*api* AND *03* AND *example* AND *local*')
    expect(eventSearchLucene('  DB ')).toBe('*db*')
    expect(eventSearchLucene('(a+b) OR title:x* AND "q" ~ \\ / ^ ! { } [ ] ?')).toBe('*a* AND *b* AND *or* AND *title* AND *x* AND *and* AND *q*')
    expect(eventSearchLucene('Città Ñandú')).toBe('*città* AND *ñandú*')
    expect(eventSearchLucene('--- *** ')).toBeNull()
    expect(eventSearchLucene('')).toBeNull()
  })

  it('status/severity fuori enum o since non ISO → BAD_USER_INPUT senza query; limit oltre 500 viene ridotto; pagina senza riga → errore esplicito', async () => {
    await expectCode(eventResolvers.Query.events(null, { filter: { status: ['open'] } }, operator), 'BAD_USER_INPUT', /Invalid status filter "open"/)
    await expectCode(eventResolvers.Query.events(null, { filter: { severity: ['high'] } }, operator), 'BAD_USER_INPUT', /Invalid severity filter/)
    await expectCode(eventResolvers.Query.events(null, { filter: { since: 'ieri' } }, operator), 'BAD_USER_INPUT', /since must be an ISO date/)
    expect(getSession).not.toHaveBeenCalled()
    onCypher([[PAGE_RE, { total: 0, items: [] }]])
    await eventResolvers.Query.events(null, { limit: 5000 }, operator)
    expect(callMatching(PAGE_RE)!.params['limit']).toBe(500)
    onCypher([[PAGE_RE, null]])
    await expect(eventResolvers.Query.events(null, {}, operator)).rejects.toThrow(/page query returned no row/)
  })

  it('P-3 — eventStats → una query per stato sull\'indice (tenant_id, status), orfani solo fra i firing con NOT EXISTS, risolti per resolved_at nelle 24 h; nessuna scansione né OPTIONAL MATCH; + le sorgenti in tempesta', async () => {
    onCypher([[/count\(e\) AS firing/, { firing: 4, critical: 1, warning: 2, orphan: 1, suppressed: 0, flapping: 0, resolved24h: 9 }]])
    const out = await eventResolvers.Query.eventStats(null, null, operator)
    expect(out).toEqual({ firing: 4, critical: 1, warning: 2, orphan: 1, suppressed: 0, flapping: 0, resolved24h: 9, stormSources: [] })
    expect(calls()).toHaveLength(1)
    const q = callMatching(/AS firing/)!
    expect(q.cypher).not.toMatch(/OPTIONAL MATCH/)
    expect(q.cypher).not.toMatch(/MATCH \(e:Event \{tenant_id: \$tenantId\}\)/)   // mai tutti gli eventi
    expect(q.cypher).toContain("MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})")
    expect(q.cypher).toContain('count(CASE WHEN NOT EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {tenant_id: $tenantId}) } THEN 1 END) AS orphan')
    expect(q.cypher).toContain("MATCH (e:Event {tenant_id: $tenantId, status: 'suppressed'})")
    expect(q.cypher).toContain("MATCH (e:Event {tenant_id: $tenantId, status: 'flapping'})")
    expect(q.cypher).toMatch(/MATCH \(e:Event \{tenant_id: \$tenantId, status: 'resolved'\}\)\s+WHERE e\.resolved_at >= \$since24h/)
    expect(Number.isNaN(Date.parse(q.params['since24h'] as string))).toBe(false)
    expect(listStormSources).toHaveBeenCalledWith('tenant-1')

    const storm = { sourceId: 'hook-1', sourceName: 'Zabbix prod', ratePerMinute: 120, since: 'T-5', incidentId: 'inc-storm', incidentNumber: 'INC00000042' }
    vi.mocked(listStormSources).mockResolvedValueOnce([storm])
    expect((await eventResolvers.Query.eventStats(null, null, operator)).stormSources).toEqual([storm])
  })

  it('ondata 4 — Event.flappingSince e transitions24h (passaggi nelle ultime 24 h) dal nodo', async () => {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString()
    const old = new Date(Date.now() - 30 * 3600 * 1000).toISOString()
    onCypher([[/MATCH \(e:Event \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow({ status: 'flapping', flapping_since: 'T-3', transitions: [old, recent, recent] })]])
    const out = await eventResolvers.Query.event(null, { id: 'ev-1' }, operator)
    expect(out).toMatchObject({ id: 'ev-1', status: 'flapping', flappingSince: 'T-3', transitions24h: 2 })
    onCypher([[/MATCH \(e:Event \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow()]])
    expect(await eventResolvers.Query.event(null, { id: 'ev-1' }, operator)).toMatchObject({ flappingSince: null, transitions24h: 0 })
  })

  it('acknowledgeEvent → SET acknowledged_by dal contesto, guardia nel WHERE (non risolto, libero o già mio), audit con il precedente', async () => {
    onCypher([[/SET e\.acknowledged_by = \$userId, e\.acknowledged_at = \$now/, { ...eventRow({ acknowledged_by: 'op-1', acknowledged_at: 'NOW' }), previous: null }]])
    const out = await eventResolvers.Mutation.acknowledgeEvent(null, { id: 'ev-1' }, operator)
    expect(out).toMatchObject({ id: 'ev-1', acknowledgedAt: 'NOW' })
    const q = callMatching(/acknowledged_by/)!
    expect(q.params).toMatchObject({ id: 'ev-1', tenantId: 'tenant-1', userId: 'op-1' })
    expect(q.cypher).toContain("WHERE e.status <> 'resolved' AND (e.acknowledged_by IS NULL OR e.acknowledged_by = $userId)")
    expect(audit).toHaveBeenCalledWith(operator, 'event.acknowledged', 'Event', 'ev-1', { previousAcknowledgedBy: null })
  })

  it('I-3 — acknowledgeEvent: inesistente → NOT_FOUND; risolto → BAD_USER_INPUT; preso in carico da un altro → BAD_USER_INPUT con chi e da quando; ripetuto dallo stesso utente → ok con previousAcknowledgedBy', async () => {
    onCypher([[/SET e\.acknowledged_by/, null], [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, null]])
    await expectCode(eventResolvers.Mutation.acknowledgeEvent(null, { id: 'ev-x' }, operator), 'NOT_FOUND', /Event ev-x/)
    onCypher([[/SET e\.acknowledged_by/, null], [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow({ status: 'resolved' })]])
    await expectCode(eventResolvers.Mutation.acknowledgeEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT', /Event ev-1 is already resolved: nothing to acknowledge/)
    onCypher([
      [/SET e\.acknowledged_by/, null],
      [/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, eventRow({ acknowledged_by: 'adm-1', acknowledged_at: 'T-2' })],
      [/MATCH \(u:User \{id: \$id, tenant_id: \$tenantId\}\)\s+RETURN u\.name/, { name: 'Ada' }],
    ])
    await expectCode(eventResolvers.Mutation.acknowledgeEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT', /already acknowledged by Ada \(adm-1\) since T-2/)
    expect(audit).not.toHaveBeenCalled()

    onCypher([[/SET e\.acknowledged_by/, { ...eventRow({ acknowledged_by: 'op-1', acknowledged_at: 'NOW' }), previous: 'op-1' }]])
    await eventResolvers.Mutation.acknowledgeEvent(null, { id: 'ev-1' }, operator)
    expect(audit).toHaveBeenCalledWith(operator, 'event.acknowledged', 'Event', 'ev-1', { previousAcknowledgedBy: 'op-1' })
  })

  it('X-2 — event(id) inesistente → null; ciAliases → alias del CI scoped per tenant, ordinati per kind/value', async () => {
    onCypher([[/OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, null]])
    await expect(eventResolvers.Query.event(null, { id: 'ev-x' }, viewer)).resolves.toBeNull()
    onCypher([[/MATCH \(a:CIAlias \{tenant_id: \$tenantId\}\)-\[:ALIAS_OF\]->\(ci:ConfigurationItem \{id: \$ciId, tenant_id: \$tenantId\}\)/, [
      { props: { id: 'al-1', kind: 'hostname', value: 'db-01', source: 'manual', created_at: 'T0' }, ciId: 'ci-1', ciName: 'db', ciStatus: 'active', ciHealth: 'down', ciLabels: ['Server'] },
    ]]])
    const out = await eventResolvers.Query.ciAliases(null, { ciId: 'ci-1' }, viewer)
    expect(out).toEqual([{ id: 'al-1', kind: 'hostname', value: 'db-01', source: 'manual', createdAt: 'T0', ci: { id: 'ci-1', name: 'db', type: 'server', status: 'active', health: 'down' } }])
    const q = callMatching(/CIAlias/)!
    expect(q.cypher).toContain('ORDER BY a.kind, a.value')
    expect(q.params).toEqual({ ciId: 'ci-1', tenantId: 'tenant-1' })
  })

  it('X-2 — events: offset negativo → 0, limit 0 → 1, since parsabile ma non ISO → normalizzato a ISO UTC (I-5), filtro orphan scoped per tenant (T-1)', async () => {
    onCypher([[PAGE_RE, { total: 0, items: [] }]])
    await eventResolvers.Query.events(null, { filter: { orphan: true, since: 'Sep 9 2026 10:00 UTC' }, limit: 0, offset: -5 }, operator)
    const list = callMatching(PAGE_RE)!
    expect(list.params).toMatchObject({ limit: 1, offset: 0, since: '2026-09-09T10:00:00.000Z' })
    expect(list.cypher).toContain('NOT EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {tenant_id: $tenantId}) }')
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[PAGE_RE, { total: 0, items: [] }]])
    await eventResolvers.Query.events(null, { filter: { orphan: false } }, operator)
    expect(callMatching(PAGE_RE)!.cypher).toContain('EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {tenant_id: $tenantId}) }')
  })

  it('P-1 — event(id) e le mutation restituiscono la riga con le giunzioni: mapEvent espone incident/source/acknowledgedBy (anche null) solo se la riga li porta', async () => {
    const { mapEvent } = await import('../events.js')
    const full = mapEvent(joinedRow().props, joinedRow())
    expect(full).toMatchObject({ incident: { id: 'inc-1', number: 'INC00000001', title: 'T' }, source: { id: 'hook-1', name: 'Zabbix', connectorKind: 'zabbix', enabled: true }, acknowledgedBy: { id: 'u-1', name: 'Ada', email: 'a@x.io' } })
    const nulls = mapEvent(eventRow().props, { ...eventRow(), incident: null, source: null, acknowledgedBy: null })
    expect(nulls).toMatchObject({ incident: null, source: null, acknowledgedBy: null })
    const bare = mapEvent(eventRow().props, eventRow())
    expect('incident' in bare).toBe(false); expect('source' in bare).toBe(false); expect('acknowledgedBy' in bare).toBe(false)

    onCypher([[/MATCH \(e:Event \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(e\)-\[:RAISED_ON\]/, joinedRow()]])
    const out = await eventResolvers.Query.event(null, { id: 'ev-1' }, viewer)
    expect(out).toMatchObject({ id: 'ev-1', incident: { id: 'inc-1' }, source: { id: 'hook-1' }, acknowledgedBy: { id: 'u-1' } })
    const q = callMatching(/RAISED_ON/)!
    expect(q.cypher).toMatch(/RETURN props, ciId, ciName, ciStatus, ciHealth, ciLabels, incident, source, acknowledgedBy\s*$/)
    // i field resolver non fanno più alcuna query su questo parent
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    expect(await eventResolvers.Event.incident(out!, null, viewer)).toMatchObject({ id: 'inc-1' })
    expect(await eventResolvers.Event.source(out!, null, viewer)).toEqual({ id: 'hook-1', name: 'Zabbix', connectorKind: 'zabbix', enabled: true })
    expect(await eventResolvers.Event.acknowledgedBy(out!, null, viewer)).toMatchObject({ id: 'u-1' })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('P-1 — cortocircuiti dei field resolver: valore già nel parent (anche null) → nessuna query; incident con correlation delayed → null senza query; none/skipped_*/suppressed → query (CORRELATED_INTO resta per la storia)', async () => {
    const { CORRELATIONS_WITHOUT_INCIDENT } = await import('../events.js')
    expect(CORRELATIONS_WITHOUT_INCIDENT).toEqual(['delayed'])
    const base = { id: 'ev-1', acknowledgedById: 'u-1', sourceId: 'hook-1', suppressedByChangeId: null }
    expect(await eventResolvers.Event.incident({ ...base, incident: null }, null, viewer)).toBeNull()
    expect(await eventResolvers.Event.source({ ...base, source: null }, null, viewer)).toBeNull()
    expect(await eventResolvers.Event.acknowledgedBy({ ...base, acknowledgedBy: null }, null, viewer)).toBeNull()
    expect(await eventResolvers.Event.incident({ ...base, correlation: 'delayed' }, null, viewer)).toBeNull()
    expect(getSession).not.toHaveBeenCalled()
    for (const correlation of ['none', 'skipped_orphan', 'skipped_severity', 'pending', 'suppressed', 'flapping', 'storm_no_ci', 'attached']) {
      vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
      onCypher([[/CORRELATED_INTO\]->\(i:Incident \{tenant_id: \$tenantId\}\)/, { props: { id: 'inc-old', number: 'INC00000009', title: 'storico', tenant_id: 'tenant-1' } }]])
      expect(await eventResolvers.Event.incident({ ...base, correlation }, null, viewer), correlation).toMatchObject({ id: 'inc-old' })
    }
  })

  it('X-2 — campi di Event: source (MonitoringSourceRef, scoped), incident (CORRELATED_INTO scoped, null se assente), acknowledgedBy (User scoped); null senza id senza query', async () => {
    const parent = { id: 'ev-1', acknowledgedById: 'u-1', sourceId: 'hook-1', suppressedByChangeId: null }
    onCypher([
      [/MATCH \(w:InboundWebhook \{id: \$id, tenant_id: \$tenantId\}\)/, { props: { id: 'hook-1', name: 'Zabbix', connector_kind: 'zabbix', enabled: true, transform_script: 'secret', field_mapping: '{}', last_error: 'payload…' } }],
      [/CORRELATED_INTO\]->\(i:Incident \{tenant_id: \$tenantId\}\)/, { props: { id: 'inc-1', number: 'INC00000001', title: 'T', tenant_id: 'tenant-1' } }],
      [/MATCH \(u:User \{id: \$id, tenant_id: \$tenantId\}\)\s+RETURN properties\(u\)/, { props: { id: 'u-1', name: 'Ada', email: 'a@x.io', role: 'operator', tenant_id: 'tenant-1' } }],
    ])
    // A-2: solo id/name/connectorKind/enabled, mai script/mappature/lastError
    expect(await eventResolvers.Event.source(parent, null, viewer)).toEqual({ id: 'hook-1', name: 'Zabbix', connectorKind: 'zabbix', enabled: true })
    expect(callMatching(/InboundWebhook/)!.params).toEqual({ id: 'hook-1', tenantId: 'tenant-1' })
    expect(await eventResolvers.Event.incident(parent, null, viewer)).toMatchObject({ id: 'inc-1' })
    expect(callMatching(/CORRELATED_INTO/)!.params).toEqual({ id: 'ev-1', tenantId: 'tenant-1' })
    expect(await eventResolvers.Event.acknowledgedBy(parent, null, viewer)).toMatchObject({ id: 'u-1', name: 'Ada' })
    expect(callMatching(/MATCH \(u:User/)!.params).toEqual({ id: 'u-1', tenantId: 'tenant-1' })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/CORRELATED_INTO/, null], [/InboundWebhook/, null]])
    expect(await eventResolvers.Event.incident({ ...parent, id: 'ev-none' }, null, viewer)).toBeNull()
    expect(await eventResolvers.Event.source({ ...parent, sourceId: 'gone' }, null, viewer)).toBeNull()
    expect(await eventResolvers.Event.source({ ...parent, sourceId: null }, null, viewer)).toBeNull()
    expect(await eventResolvers.Event.acknowledgedBy({ ...parent, acknowledgedById: null }, null, viewer)).toBeNull()
    expect(calls().filter((c) => /User/.test(c.cypher))).toHaveLength(0)
    expect(calls().filter((c) => /InboundWebhook/.test(c.cypher))).toHaveLength(1)
  })

  it('X-2 — viewer: le mutation operative sono negate dalla policy centrale (authorize), la console (events, monitoringSourceRefs) no', () => {
    for (const f of ['acknowledgeEvent', 'resolveEvent', 'linkEventToCI', 'createIncidentFromEvent']) expect(() => authorize('Mutation', f, 'viewer')).toThrow(new RegExp(f))
    expect(() => authorize('Query', 'events', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'monitoringSourceRefs', 'viewer')).not.toThrow()
    expect(() => authorize('Query', 'monitoringSources', 'viewer')).toThrow(/monitoringSources/)
  })

  it('C-2 — mapEvent: labels è String! e un nodo senza labels è un errore esplicito (non una stringa inventata)', async () => {
    const { mapEvent } = await import('../events.js')
    const legacy = eventRow(); delete (legacy.props as Record<string, unknown>)['labels']
    expect(() => mapEvent(legacy.props, legacy)).toThrow(/Event ev-1 has no labels field/)
    expect(mapEvent(eventRow({ labels: '{"env":"prod"}' }).props, eventRow()).labels).toBe('{"env":"prod"}')
  })
})

describe('createCIAlias / deleteCIAlias', () => {
  it('admin: valore normalizzato (minuscolo per hostname), CREATE + ALIAS_OF scoped, duplicato → BAD_USER_INPUT', async () => {
    onCypher([
      [/MATCH \(a:CIAlias \{tenant_id: \$tenantId, kind: \$kind, value: \$value\}\)-\[:ALIAS_OF\]/, null],
      [/CREATE \(a:CIAlias/, { props: { id: 'al-1', kind: 'hostname', value: 'db-01', source: 'manual', created_at: 'NOW' }, ciId: 'ci-1', ciName: 'db', ciStatus: null, ciHealth: null, ciLabels: ['Server'] }],
    ])
    const out = await eventResolvers.Mutation.createCIAlias(null, { ciId: 'ci-1', kind: 'hostname', value: '  DB-01 ' }, admin)
    expect(out).toEqual({ id: 'al-1', kind: 'hostname', value: 'db-01', source: 'manual', createdAt: 'NOW', ci: { id: 'ci-1', name: 'db', type: 'server', status: null, health: null } })
    expect(callMatching(/CREATE \(a:CIAlias/)!.params).toMatchObject({ ciId: 'ci-1', tenantId: 'tenant-1', kind: 'hostname', value: 'db-01' })

    onCypher([[/MATCH \(a:CIAlias \{tenant_id: \$tenantId, kind: \$kind, value: \$value\}\)-\[:ALIAS_OF\]/, { ciId: 'ci-2', ciName: 'other' }]])
    await expectCode(eventResolvers.Mutation.createCIAlias(null, { ciId: 'ci-1', kind: 'hostname', value: 'db-01' }, admin), 'BAD_USER_INPUT', /already points to CI "other" \(ci-2\)/)
  })

  it('external_id conserva le maiuscole; kind fuori enum → BAD_USER_INPUT; operator → FORBIDDEN', async () => {
    onCypher([[/-\[:ALIAS_OF\]->\(ci:ConfigurationItem \{tenant_id: \$tenantId\}\)/, null], [/CREATE \(a:CIAlias/, { props: { id: 'al-2', kind: 'external_id', value: 'i-ABC', source: 'manual' }, ciId: 'ci-1', ciLabels: ['Server'] }]])
    await eventResolvers.Mutation.createCIAlias(null, { ciId: 'ci-1', kind: 'external_id', value: 'i-ABC' }, admin)
    expect(callMatching(/CREATE \(a:CIAlias/)!.params['value']).toBe('i-ABC')
    await expectCode(eventResolvers.Mutation.createCIAlias(null, { ciId: 'ci-1', kind: 'name', value: 'x' }, admin), 'BAD_USER_INPUT', /kind must be one of: hostname, ip, fqdn, external_id/)
    await expectCode(eventResolvers.Mutation.createCIAlias(null, { ciId: 'ci-1', kind: 'ip', value: 'x' }, operator), 'FORBIDDEN')
    await expectCode(eventResolvers.Mutation.deleteCIAlias(null, { id: 'al-1' }, operator), 'FORBIDDEN')
  })

  it('deleteCIAlias → DETACH DELETE scoped, true; inesistente → NOT_FOUND', async () => {
    onCypher([[/DETACH DELETE a/, { deleted: 'al-1' }]])
    await expect(eventResolvers.Mutation.deleteCIAlias(null, { id: 'al-1' }, admin)).resolves.toBe(true)
    expect(callMatching(/DETACH DELETE a/)!.cypher).toContain('MATCH (a:CIAlias {id: $id, tenant_id: $tenantId})')
    onCypher([[/DETACH DELETE a/, null]])
    await expectCode(eventResolvers.Mutation.deleteCIAlias(null, { id: 'al-x' }, admin), 'NOT_FOUND')
  })
})

// ── Ondata 2: configurazione senza codice ────────────────────────────────────

const viewer: GraphQLContext = { ...admin, userId: 'v-1', role: 'viewer' }

describe('sampleInboundPayload / payloadKeys', () => {
  it('sampleInboundPayload → JSON leggibile del campione del connettore; connettore sconosciuto → BAD_USER_INPUT', () => {
    const raw = eventResolvers.Query.sampleInboundPayload(null, { connectorKind: 'zabbix' }, admin)
    expect(JSON.parse(raw)).toEqual(SAMPLE_PAYLOADS.zabbix)
    expect(raw).toContain('\n')
    expect(() => eventResolvers.Query.sampleInboundPayload(null, { connectorKind: 'nagios' }, admin)).toThrow(/connectorKind must be one of: generic, alertmanager, grafana, zabbix, datadog, dynatrace/)
    // A-3: strumenti del wizard admin-only (seconda linea oltre alla policy centrale)
    expect(() => eventResolvers.Query.sampleInboundPayload(null, { connectorKind: 'zabbix' }, operator)).toThrow(/not authorized/)
  })

  it('payloadKeys → percorsi puntati foglia con esempio; JSON non valido o vuoto → BAD_USER_INPUT; operator → FORBIDDEN', () => {
    const keys = eventResolvers.Query.payloadKeys(null, { payload: JSON.stringify({ alert: { name: 'A', tags: ['x', 'y'] }, n: 1 }) }, admin)
    expect(keys).toEqual([{ path: 'alert.name', sample: 'A' }, { path: 'alert.tags.0', sample: 'x' }, { path: 'alert.tags.1', sample: 'y' }, { path: 'n', sample: '1' }])
    expect(() => eventResolvers.Query.payloadKeys(null, { payload: '{nope' }, admin)).toThrow(/payload is not valid JSON/)
    expect(() => eventResolvers.Query.payloadKeys(null, { payload: '' }, admin)).toThrow(GraphQLError)
    expect(() => eventResolvers.Query.payloadKeys(null, { payload: '{}' }, operator)).toThrow(/not authorized/)
  })

  it(`I-4 — payloadKeys: 300+ chiavi → al massimo 300; JSON più profondo di ${PAYLOAD_MAX_DEPTH} livelli o oltre ${PAYLOAD_MAX_CHARS} caratteri → BAD_USER_INPUT (mai un errore interno)`, () => {
    const big = JSON.stringify(Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`k${i}`, i])))
    expect(eventResolvers.Query.payloadKeys(null, { payload: big }, admin)).toHaveLength(300)
    const deep = '['.repeat(PAYLOAD_MAX_DEPTH + 1) + '1' + ']'.repeat(PAYLOAD_MAX_DEPTH + 1)   // foglia al livello 33
    let err = (() => { try { eventResolvers.Query.payloadKeys(null, { payload: deep }, admin); return null } catch (e) { return e as GraphQLError } })()
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT'); expect(err!.message).toMatch(/nested deeper than 32 levels/)
    expect(PAYLOAD_MAX_CHARS).toBe(256 * 1024)
    err = (() => { try { eventResolvers.Query.payloadKeys(null, { payload: `"${'x'.repeat(PAYLOAD_MAX_CHARS)}"` }, admin); return null } catch (e) { return e as GraphQLError } })()
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT'); expect(err!.message).toMatch(/payload must be at most 262144 characters/)
  })
})

describe('monitoringSources / ciHealth', () => {
  it('monitoringSources → InboundWebhook del tenant con entity_type event, mappati come mapInbound (valueMapping, lastError, errorCount)', async () => {
    onCypher([[/MATCH \(w:InboundWebhook \{tenant_id: \$tenantId, entity_type: 'event'\}\)/, [{ props: { id: 'src-1', name: 'Zabbix', entity_type: 'event', connector_kind: 'zabbix', field_mapping: '{}', value_mapping: '{"status":{"1":"firing"}}', last_error: 'boom', error_count: 2, receive_count: 5 } }]]])
    const out = await eventResolvers.Query.monitoringSources(null, null, admin)
    expect(out).toEqual([expect.objectContaining({ id: 'src-1', entityType: 'event', connectorKind: 'zabbix', valueMapping: '{"status":{"1":"firing"}}', lastError: 'boom', errorCount: 2, receiveCount: 5 })])
    expect(callMatching(/entity_type: 'event'/)!.params).toEqual({ tenantId: 'tenant-1' })
    // A-1: la configurazione completa è admin-only (seconda linea)
    await expectCode(eventResolvers.Query.monitoringSources(null, null, operator), 'FORBIDDEN')
  })

  it('A-1 — monitoringSourceRefs → le stesse sorgenti come riferimenti leggeri (id, name, connectorKind, enabled) a ruoli predefiniti: niente mappature, script o lastError', async () => {
    onCypher([[/MATCH \(w:InboundWebhook \{tenant_id: \$tenantId, entity_type: 'event'\}\)/, [{ props: { id: 'src-1', name: 'Zabbix', entity_type: 'event', connector_kind: 'zabbix', enabled: true, transform_script: 'secret', last_error: 'boom' } }, { props: { id: 'src-2', name: 'Legacy', entity_type: 'event' } }]]])
    const out = await eventResolvers.Query.monitoringSourceRefs(null, null, viewer)
    expect(out).toEqual([{ id: 'src-1', name: 'Zabbix', connectorKind: 'zabbix', enabled: true }, { id: 'src-2', name: 'Legacy', connectorKind: null, enabled: false }])
    expect(callMatching(/entity_type: 'event'/)!.cypher).toContain('ORDER BY w.name')
  })

  it('ciHealth → salute, sorgente, ultimo evento e conteggio firing scoped per tenant; CI inesistente → NOT_FOUND', async () => {
    onCypher([[/count\(e\) AS firingEvents/, { ciId: 'ci-1', health: 'down', healthSource: 'monitoring', lastEventAt: 'T1', firingEvents: 3 }]])
    const out = await eventResolvers.Query.ciHealth(null, { ciId: 'ci-1' }, viewer)
    expect(out).toEqual({ ciId: 'ci-1', health: 'down', healthSource: 'monitoring', lastEventAt: 'T1', firingEvents: 3 })
    const q = callMatching(/firingEvents/)!
    expect(q.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(q.cypher).toContain("(e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)")
    onCypher([[/firingEvents/, null]])
    await expectCode(eventResolvers.Query.ciHealth(null, { ciId: 'ci-x' }, viewer), 'NOT_FOUND', /ConfigurationItem ci-x/)
  })
})

describe('previewInboundEvents', () => {
  const generic = { connectorKind: 'generic', payload: JSON.stringify(SAMPLE_PAYLOADS.generic), fieldMapping: JSON.stringify(GENERIC_SAMPLE_CONFIG.fieldMapping), defaultValues: JSON.stringify(GENERIC_SAMPLE_CONFIG.defaultValues), valueMapping: JSON.stringify(GENERIC_SAMPLE_CONFIG.valueMapping) }

  it('generic con la config di esempio → anteprima normalizzata, labels JSON; nessuna query, nessuna coda, nessun audit', async () => {
    const out = await eventResolvers.Mutation.previewInboundEvents(null, { input: generic }, admin)
    expect(out).toEqual([{
      externalId: 'EVT-100234', resourceExternalId: null, status: 'firing', severity: 'warning', title: 'CheckoutErrorRate',
      description: 'Service checkout-api is returning HTTP 500 on 12% of requests',
      resource: 'api-03.example.local', resourceKind: 'hostname', labels: JSON.stringify({ env: 'prod', service: 'checkout-api' }),
    }])
    // M2: il connettore che porta l'id della risorsa lo espone nell'anteprima
    const dt = await eventResolvers.Mutation.previewInboundEvents(null, { input: { connectorKind: 'dynatrace', payload: JSON.stringify(SAMPLE_PAYLOADS.dynatrace) } }, admin)
    expect(dt[0]).toMatchObject({ resourceExternalId: 'HOST-1A2B3C4D5E6F7A8B', resourceKind: 'hostname' })
    expect(getSession).not.toHaveBeenCalled()
    expect(enqueueEvents).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it.each(['alertmanager', 'grafana', 'zabbix', 'datadog', 'dynatrace'] as const)('%s: il campione del connettore produce un evento firing su hostname', async (kind) => {
    const out = await eventResolvers.Mutation.previewInboundEvents(null, { input: { connectorKind: kind, payload: JSON.stringify(SAMPLE_PAYLOADS[kind]) } }, admin)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ status: 'firing', resourceKind: 'hostname' })
    expect(out[0]!.externalId).toBeTruthy()
  })

  it('errori di configurazione o payload → BAD_USER_INPUT con il campo; operator e viewer → FORBIDDEN (strumento del wizard admin, A-3)', async () => {
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, payload: '{oops' } }, admin), 'BAD_USER_INPUT', /payload is not valid JSON/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, connectorKind: 'nagios' } }, admin), 'BAD_USER_INPUT', /connectorKind must be one of/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, valueMapping: JSON.stringify({ severity: {} }) } }, admin), 'BAD_USER_INPUT', /severity value "major" is not mapped/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, defaultValues: null } }, admin), 'BAD_USER_INPUT', /resourceKind is missing: set default_values\.resourceKind/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, fieldMapping: JSON.stringify({ foo: 'bar' }) } }, admin), 'BAD_USER_INPUT', /field_mapping\.foo is not a normalized field/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: generic }, operator), 'FORBIDDEN')
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: generic }, viewer), 'FORBIDDEN')
  })

  it(`X-2 — più di ${MAX_EVENTS_PER_REQUEST} alert in un payload alertmanager → BAD_USER_INPUT; payload oltre ${PAYLOAD_MAX_CHARS} caratteri → BAD_USER_INPUT`, async () => {
    const alert = (SAMPLE_PAYLOADS.alertmanager as { alerts: unknown[] }).alerts[0]
    const many = JSON.stringify({ alerts: Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => alert) })
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { connectorKind: 'alertmanager', payload: many } }, admin), 'BAD_USER_INPUT', /Too many alerts in one request: 501 \(max 500\)/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { connectorKind: 'generic', payload: `"${'x'.repeat(PAYLOAD_MAX_CHARS)}"` } }, admin), 'BAD_USER_INPUT', /payload must be at most 262144 characters/)
  })
})

describe('sendSampleEvent', () => {
  const source = (over: Record<string, unknown> = {}, timezone: string | null = null) => ({ props: { id: 'src-1', tenant_id: 'tenant-1', entity_type: 'event', connector_kind: 'datadog', field_mapping: '{}', default_values: null, value_mapping: null, ...over }, timezone })

  it('carica la sorgente del tenant (con il fuso del tenant nella stessa query), normalizza il campione del SUO connettore con la SUA config, accoda via enqueueEvents, aggiorna le statistiche, audit', async () => {
    vi.mocked(enqueueEvents).mockResolvedValueOnce(1)
    onCypher([[/MATCH \(w:InboundWebhook \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(t:Tenant \{id: \$tenantId\}\)\s+RETURN properties\(w\) AS props, t\.timezone AS timezone/, source()], [/SET w\.receive_count/, null]])
    await expect(eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)).resolves.toBe(1)
    expect(enqueueEvents).toHaveBeenCalledTimes(1)
    const [tenantId, sourceId, events, receivedAt] = vi.mocked(enqueueEvents).mock.calls[0]!
    expect(tenantId).toBe('tenant-1'); expect(sourceId).toBe('src-1')
    expect(events).toHaveLength(1)
    // I-6: il campione è marcato (labels.sample = "true", conservato dall'ingest in Event.labels) e non tocca last_error
    // A3: l'identità dell'allarme Datadog è alert_cycle_key (unico per ciclo), non l'id del monitor
    expect(events[0]).toMatchObject({ externalId: '7654321:1788869557:host:cache-01', status: 'firing', severity: 'critical', resource: 'cache-01', resourceKind: 'hostname', labels: expect.objectContaining({ env: 'prod', alert_id: '7654321', [SAMPLE_LABEL]: 'true' }) })
    expect(SAMPLE_LABEL).toBe('sample')
    expect(Number.isNaN(Date.parse(receivedAt!))).toBe(false)
    const stats = callMatching(/SET w\.receive_count/)!
    expect(stats.cypher).toContain('MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})')
    expect(stats.cypher).not.toMatch(/last_error/)
    expect(stats.params).toMatchObject({ id: 'src-1', tenantId: 'tenant-1', n: 1, now: receivedAt })
    // P-6: la sessione di lettura è chiusa prima dell'enqueue su Redis, quella di scrittura aperta dopo
    expect(vi.mocked(getSession).mock.calls).toEqual([[], [undefined, 'WRITE']])
    expect(session.close).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenCalledWith(admin, 'event_source.sample_sent', 'InboundWebhook', 'src-1', { connectorKind: 'datadog', accepted: 1 })
  })

  it('sorgente generic: applica field_mapping / default_values / value_mapping salvati sul webhook', async () => {
    vi.mocked(enqueueEvents).mockResolvedValueOnce(1)
    onCypher([[/RETURN properties\(w\)/, source({ connector_kind: 'generic', field_mapping: JSON.stringify(GENERIC_SAMPLE_CONFIG.fieldMapping), default_values: JSON.stringify({ resourceKind: 'fqdn' }), value_mapping: JSON.stringify(GENERIC_SAMPLE_CONFIG.valueMapping) })], [/SET w\.receive_count/, null]])
    await eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)
    expect(vi.mocked(enqueueEvents).mock.calls[0]![2][0]).toMatchObject({ title: 'CheckoutErrorRate', severity: 'warning', status: 'firing', resource: 'api-03.example.local', resourceKind: 'fqdn' })
  })

  it('sorgente zabbix: il fuso del tenant converte event_date/event_time del campione in startsAt ISO come fa il webhook; senza fuso startsAt resta vuoto e il grezzo va in labels.event_time', async () => {
    vi.mocked(enqueueEvents).mockResolvedValue(1)
    onCypher([[/RETURN properties\(w\)/, source({ connector_kind: 'zabbix' }, 'Europe/Rome')], [/SET w\.receive_count/, null]])
    await eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)
    expect(vi.mocked(enqueueEvents).mock.calls[0]![2][0]).toMatchObject({ resource: 'app-01', resourceKind: 'hostname', resourceExternalId: expect.any(String), startsAt: '2026-09-09T08:12:37.000Z' })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(enqueueEvents).mockResolvedValue(1)
    onCypher([[/RETURN properties\(w\)/, source({ connector_kind: 'zabbix' }, '  ')], [/SET w\.receive_count/, null]])
    await eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)
    const ev = vi.mocked(enqueueEvents).mock.calls[0]![2][0]!
    expect(ev.startsAt).toBeUndefined()
    expect(ev.labels).toMatchObject({ event_time: '2026.09.09 10:12:37' })
  })

  it('sorgente inesistente/altro tenant → NOT_FOUND; webhook non-event → BAD_USER_INPUT; config rotta → BAD_USER_INPUT; niente in coda; operator → FORBIDDEN', async () => {
    onCypher([[/RETURN properties\(w\)/, null]])
    await expectCode(eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-x' }, admin), 'NOT_FOUND', /InboundWebhook src-x/)
    onCypher([[/RETURN properties\(w\)/, source({ entity_type: 'incident' })]])
    await expectCode(eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin), 'BAD_USER_INPUT', /not a monitoring source/)
    onCypher([[/RETURN properties\(w\)/, source({ connector_kind: 'generic', field_mapping: '{bad' })]])
    await expectCode(eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin), 'BAD_USER_INPUT', /Corrupt field_mapping JSON/)
    expect(enqueueEvents).not.toHaveBeenCalled()
    await expectCode(eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, operator), 'FORBIDDEN')
  })

  it('I-6 — sorgente con last_error preesistente: la prova non lo azzera (resta la diagnosi dell\'ultimo payload reale rifiutato)', async () => {
    vi.mocked(enqueueEvents).mockResolvedValueOnce(1)
    onCypher([[/RETURN properties\(w\)/, source({ last_error: 'severity must be one of…', last_error_at: 'T-1', error_count: 3 })], [/SET w\.receive_count/, null]])
    await eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)
    const stats = callMatching(/SET w\.receive_count/)!
    expect(stats.cypher).not.toMatch(/last_error/)
    expect(stats.cypher).not.toMatch(/error_count/)
  })

  it('coda non disponibile → l\'errore propaga, statistiche non toccate', async () => {
    vi.mocked(enqueueEvents).mockRejectedValueOnce(new Error('redis down'))
    onCypher([[/RETURN properties\(w\)/, source()]])
    await expect(eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)).rejects.toThrow('redis down')
    expect(callMatching(/receive_count/)).toBeUndefined()
    expect(session.close).toHaveBeenCalled()
  })
})

describe('setCIHealthOverride', () => {
  const healthRow = (over: Record<string, unknown> = {}) => ({ ciId: 'ci-1', health: 'down', healthSource: 'manual', lastEventAt: null, firingEvents: 0, ...over })

  it('health = down → SET health + health_source manual scoped per tenant, ci.health_changed con previous/new, audit, restituisce ciHealth', async () => {
    onCypher([[/SET ci\.health = \$health, ci\.health_source = 'manual'/, { previous: 'operational' }], [/firingEvents/, healthRow()]])
    const out = await eventResolvers.Mutation.setCIHealthOverride(null, { ciId: 'ci-1', health: 'down' }, operator)
    expect(out).toEqual({ ciId: 'ci-1', health: 'down', healthSource: 'manual', lastEventAt: null, firingEvents: 0 })
    const set = callMatching(/health_source = 'manual'/)!
    expect(set.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(set.cypher).not.toMatch(/ci\.status\s*=/)
    // health_since si sposta solo se la salute cambia (CASE sul valore precedente), mai incondizionatamente
    expect(set.cypher).toContain("ci.health_since = CASE WHEN previous IS NULL OR previous <> $health THEN $now ELSE ci.health_since END")
    expect(set.params).toMatchObject({ ciId: 'ci-1', tenantId: 'tenant-1', health: 'down' })
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 'tenant-1', 'op-1', { id: 'ci-1', ci_id: 'ci-1', previous_health: 'operational', new_health: 'down' }, expect.any(String))
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(operator, 'ci.health_override_set', 'ConfigurationItem', 'ci-1', { health: 'down', previous: 'operational' })
  })

  it('stessa salute di prima → nessun ci.health_changed', async () => {
    onCypher([[/health_source = 'manual'/, { previous: 'degraded' }], [/firingEvents/, healthRow({ health: 'degraded' })]])
    await eventResolvers.Mutation.setCIHealthOverride(null, { ciId: 'ci-1', health: 'degraded' }, admin)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('health = null → REMOVE health_source, ricalcolo dal monitoraggio (recomputeCIHealth), audit', async () => {
    onCypher([[/REMOVE ci\.health_source/, { id: 'ci-1' }], [/firingEvents/, healthRow({ health: 'operational', healthSource: 'monitoring' })]])
    const out = await eventResolvers.Mutation.setCIHealthOverride(null, { ciId: 'ci-1', health: null }, operator)
    expect(out).toMatchObject({ health: 'operational', healthSource: 'monitoring' })
    expect(callMatching(/REMOVE ci\.health_source/)!.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(recomputeCIHealth).toHaveBeenCalledWith('tenant-1', 'ci-1', 'op-1')
    expect(audit).toHaveBeenCalledWith(operator, 'ci.health_override_cleared', 'ConfigurationItem', 'ci-1')
  })

  it('valore fuori enum → BAD_USER_INPUT senza query; CI inesistente → NOT_FOUND; viewer → FORBIDDEN', async () => {
    await expectCode(eventResolvers.Mutation.setCIHealthOverride(null, { ciId: 'ci-1', health: 'broken' }, operator), 'BAD_USER_INPUT', /health must be one of: operational, degraded, down/)
    expect(getSession).not.toHaveBeenCalled()
    onCypher([[/health_source = 'manual'/, null]])
    await expectCode(eventResolvers.Mutation.setCIHealthOverride(null, { ciId: 'ci-x', health: 'down' }, operator), 'NOT_FOUND', /ConfigurationItem ci-x/)
    onCypher([[/REMOVE ci\.health_source/, null]])
    await expectCode(eventResolvers.Mutation.setCIHealthOverride(null, { ciId: 'ci-x' }, operator), 'NOT_FOUND')
    expect(recomputeCIHealth).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    await expectCode(eventResolvers.Mutation.setCIHealthOverride(null, { ciId: 'ci-1', health: 'down' }, viewer), 'FORBIDDEN')
  })
})

// ── Pagina Salute CI: ciHealthOverview ───────────────────────────────────────

describe('ciHealthOverview', () => {
  const COUNTS = { down: 2, degraded: 1, operational: 5, unmonitored: 12 }
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'ci-1', name: 'db-01', label: 'Server', environment: 'production', health: 'down', healthSource: 'monitoring',
    healthSince: '2026-09-09T10:00:00Z', lastEventAt: '2026-09-09T10:05:00Z', firingEvents: 2, dependents: 7, ownerTeam: 'DBA', ...over,
  })

  const OVERVIEW_RE = /RETURN down, degraded, operational, unmonitored, total, items/

  it('P-2 — UNA query: contatori su tutto il tenant + total + righe ordinate per gravità, dipendenti DESC, nome; type dalla label; nessun OPTIONAL MATCH moltiplicativo', async () => {
    onCypher([[OVERVIEW_RE, { ...COUNTS, total: 8, items: [row(), row({ id: 'ci-2', name: 'app', label: 'Application', health: 'operational', healthSource: 'manual', dependents: 0, ownerTeam: null, healthSince: null, lastEventAt: null, firingEvents: 0 })] }]])
    const out = await eventResolvers.Query.ciHealthOverview(null, {}, viewer)
    expect(out).toMatchObject({ down: 2, degraded: 1, operational: 5, unmonitored: 12, total: 8 })
    expect(out.items).toEqual([
      { id: 'ci-1', name: 'db-01', type: 'server', environment: 'production', health: 'down', healthSource: 'monitoring', healthSince: '2026-09-09T10:00:00Z', lastEventAt: '2026-09-09T10:05:00Z', firingEvents: 2, dependents: 7, ownerTeam: 'DBA' },
      { id: 'ci-2', name: 'app', type: 'application', environment: 'production', health: 'operational', healthSource: 'manual', healthSince: null, lastEventAt: null, firingEvents: 0, dependents: 0, ownerTeam: null },
    ])
    expect(calls()).toHaveLength(1)   // erano tre (contatori, pagina, total)
    const q = callMatching(OVERVIEW_RE)!
    expect(q.cypher).not.toMatch(/OPTIONAL MATCH/)
    expect(q.cypher).not.toMatch(/DISTINCT/)
    // contatori del tenant, indipendenti dal filtro (nessun WHERE nel primo CALL)
    expect(q.cypher).toMatch(/CALL \{\s+MATCH \(ci:ConfigurationItem \{tenant_id: \$tenantId\}\)\s+RETURN\s+count\(CASE WHEN ci\.health = 'down'/)
    expect(q.cypher).toContain('count(CASE WHEN ci.health IS NULL         THEN 1 END) AS unmonitored')
    // total e pagina con lo stesso WHERE, salute prima di ogni conteggio
    expect(q.cypher).toMatch(/MATCH \(ci:ConfigurationItem \{tenant_id: \$tenantId\}\)\s+WHERE ci\.health IS NOT NULL\s+RETURN count\(ci\) AS total/)
    expect(q.cypher).toMatch(/WHERE ci\.health IS NOT NULL\s+WITH ci, COUNT \{ \(:ConfigurationItem \{tenant_id: \$tenantId\}\)-\[:DEPENDS_ON\]->\(ci\) \} AS dependents\s+ORDER BY CASE ci\.health WHEN 'down' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, dependents DESC, ci\.name\s+SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)/)
    // firing e team solo sulle righe della pagina (dopo SKIP/LIMIT), non moltiplicativi
    expect(q.cypher).toMatch(/LIMIT toInteger\(\$limit\)\s+RETURN collect\(\{[\s\S]*firingEvents: COUNT \{ \(:Event \{tenant_id: \$tenantId, status: 'firing'\}\)-\[:RAISED_ON\]->\(ci\) \}/)
    expect(q.cypher).toContain('ownerTeam: head([(ci)-[:OWNED_BY]->(t:Team {tenant_id: $tenantId}) | t.name])')
    expect(q.cypher).toContain("label: head([l IN labels(ci) WHERE l <> 'ConfigurationItem'])")
    expect(q.params).toEqual({ tenantId: 'tenant-1', limit: 100, offset: 0 })
  })

  it('filtri: salute, tipo (→ label), ambiente, team (OWNED_BY scoped), ricerca minuscola; limit clampato a 500', async () => {
    onCypher([[OVERVIEW_RE, { ...COUNTS, total: 0, items: [] }]])
    const out = await eventResolvers.Query.ciHealthOverview(null, { filter: { health: ['down', 'degraded'], type: 'database_instance', environment: 'staging', team: 'team-9', search: '  DB ' }, limit: 9000, offset: 50 }, operator)
    expect(out.items).toEqual([]); expect(out.total).toBe(0)
    const q = callMatching(OVERVIEW_RE)!
    const where = 'WHERE ci.health IS NOT NULL AND ci.health IN $health AND $typeLabel IN labels(ci) AND ci.environment = $environment AND EXISTS { (ci)-[:OWNED_BY]->(:Team {id: $team, tenant_id: $tenantId}) } AND toLower(ci.name) CONTAINS $search'
    // lo stesso WHERE per total e pagina, mai nei contatori del tenant
    expect(q.cypher.split(where)).toHaveLength(3)
    expect(q.cypher.indexOf(where)).toBeGreaterThan(q.cypher.indexOf('AS unmonitored'))
    expect(q.params).toMatchObject({ health: ['down', 'degraded'], typeLabel: 'DatabaseInstance', environment: 'staging', team: 'team-9', search: 'db', limit: 500, offset: 50 })
    // tipo dinamico (non in TYPE_TO_LABEL) → label PascalCase per convenzione
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[OVERVIEW_RE, { ...COUNTS, total: 0, items: [] }]])
    await eventResolvers.Query.ciHealthOverview(null, { filter: { type: 'erp_system' } }, operator)
    expect(callMatching(OVERVIEW_RE)!.params['typeLabel']).toBe('ErpSystem')
  })

  it('salute fuori vocabolario → BAD_USER_INPUT senza query; riga senza label di tipo → errore esplicito; query senza riga → errore esplicito', async () => {
    await expectCode(eventResolvers.Query.ciHealthOverview(null, { filter: { health: ['broken'] } }, operator), 'BAD_USER_INPUT', /Invalid health filter "broken": expected one of operational, degraded, down/)
    expect(getSession).not.toHaveBeenCalled()
    onCypher([[OVERVIEW_RE, { ...COUNTS, total: 1, items: [row({ label: null })] }]])
    await expect(eventResolvers.Query.ciHealthOverview(null, {}, operator)).rejects.toThrow(/CI ci-1 has no type label/)
    onCypher([[OVERVIEW_RE, null]])
    await expect(eventResolvers.Query.ciHealthOverview(null, {}, operator)).rejects.toThrow(/overview query returned no row/)
  })
})
