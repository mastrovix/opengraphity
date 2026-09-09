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
vi.mock('../../../services/eventCorrelation.js', () => ({ openIncidentFromEvent: vi.fn(), runEventPipeline: vi.fn() }))
// Ondata 4: le tempeste (contatori Redis) sono in services/__tests__/eventStorm.test.ts.
vi.mock('../../../services/eventStorm.js', () => ({ listStormSources: vi.fn().mockResolvedValue([]) }))
vi.mock('../change/queries.js', () => ({ change: vi.fn() }))

const { eventResolvers } = await import('../events.js')
const { listStormSources } = await import('../../../services/eventStorm.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { getEventPolicy, setEventPolicy, recomputeCIHealth } = await import('../../../services/eventService.js')
const { openIncidentFromEvent, runEventPipeline } = await import('../../../services/eventCorrelation.js')
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
    expect(audit).toHaveBeenCalledWith(admin, 'event_policy.updated', 'Tenant', 'tenant-1', expect.anything())
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
    expect(alias.cypher).toContain('MERGE (a)-[:ALIAS_OF]->(ci)')
    expect(alias.params).toMatchObject({ tenantId: 'tenant-1', ciId: 'ci-new', kind: 'hostname', value: 'db-01', userId: 'op-1' })

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
})

// ── resolveEvent ─────────────────────────────────────────────────────────────

describe('resolveEvent', () => {
  it('SET resolved + resolved_at + nota, pipeline (salute del CI + chiusura automatica dell\'incident), event.resolved pubblicato, audit', async () => {
    onCypher([[/SET e\.status = 'resolved', e\.resolved_at = \$now/, eventRow({ status: 'resolved', resolved_at: 'NOW' }, { ciId: 'ci-1', ciName: 'db', ciLabels: ['Server'] })]])
    const out = await eventResolvers.Mutation.resolveEvent(null, { id: 'ev-1', note: 'falso allarme' }, operator)
    expect(out).toMatchObject({ id: 'ev-1', status: 'resolved', resolvedAt: 'NOW', ci: { id: 'ci-1', type: 'server' } })
    const set = callMatching(/SET e\.status = 'resolved'/)!
    expect(set.cypher).toContain('MATCH (e:Event {id: $id, tenant_id: $tenantId})')
    expect(set.params).toMatchObject({ id: 'ev-1', tenantId: 'tenant-1', userId: 'op-1', note: 'falso allarme' })
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
    onCypher([[/SET e\.status = 'resolved'/, null]])
    await expectCode(eventResolvers.Mutation.resolveEvent(null, { id: 'ev-x' }, operator), 'NOT_FOUND')
    expect(runEventPipeline).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
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

  it.each([['delayed'], ['skipped_orphan']])('evento firing con correlation %s → rivalutabile', async (correlation) => {
    onCypher([[/OPTIONAL MATCH/, eventRow({ correlation })]])
    await eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, admin)
    expect(runEventPipeline).toHaveBeenCalledTimes(1)
  })

  it('evento firing normale (correlation opened/none) o risolto → BAD_USER_INPUT senza pipeline; inesistente → NOT_FOUND; viewer → FORBIDDEN', async () => {
    onCypher([[/OPTIONAL MATCH/, eventRow({ correlation: 'opened' })]])
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT', /only suppressed, delayed or skipped_orphan events can be re-evaluated/)
    onCypher([[/OPTIONAL MATCH/, eventRow({ correlation: 'none' })]])
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT')
    onCypher([[/OPTIONAL MATCH/, eventRow({ status: 'resolved', correlation: 'attached' })]])
    await expectCode(eventResolvers.Mutation.reevaluateEvent(null, { id: 'ev-1' }, operator), 'BAD_USER_INPUT')
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

  it('Event.suppressedBy → null senza change; con change carica la change del tenant', async () => {
    await expect(eventResolvers.Event.suppressedBy({ id: 'ev-1', acknowledgedById: null, sourceId: null, suppressedByChangeId: null }, null, operator)).resolves.toBeNull()
    expect(loadChange).not.toHaveBeenCalled()
    vi.mocked(loadChange).mockResolvedValueOnce({ id: 'chg-1', code: 'CHG00000001' } as never)
    await expect(eventResolvers.Event.suppressedBy({ id: 'ev-1', acknowledgedById: null, sourceId: null, suppressedByChangeId: 'chg-1' }, null, operator)).resolves.toMatchObject({ id: 'chg-1' })
    expect(loadChange).toHaveBeenCalledWith(null, { id: 'chg-1' }, operator)
  })

  it('Incident.correlatedEvents e Change.suppressedEvents → query scoped per tenant, ordinate per last_seen_at DESC', async () => {
    onCypher([[/CORRELATED_INTO\]->\(i:Incident \{id: \$id, tenant_id: \$tenantId\}\)/, [eventRow({ correlation: 'opened' }, { ciId: 'ci-1', ciLabels: ['Server'] })]]])
    const ev = await eventResolvers.Incident.correlatedEvents({ id: 'inc-1' }, null, operator)
    expect(ev).toEqual([expect.objectContaining({ id: 'ev-1', correlation: 'opened', ci: expect.objectContaining({ id: 'ci-1' }) })])
    const q1 = callMatching(/CORRELATED_INTO/)!
    expect(q1.cypher).toContain('MATCH (e:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {id: $id, tenant_id: $tenantId})')
    expect(q1.cypher).toContain('ORDER BY e.last_seen_at DESC')
    expect(q1.params).toEqual({ id: 'inc-1', tenantId: 'tenant-1' })

    onCypher([[/SUPPRESSED_BY\]->\(c:Change \{id: \$id, tenant_id: \$tenantId\}\)/, [eventRow({ status: 'suppressed', correlation: 'suppressed' })]]])
    const sup = await eventResolvers.Change.suppressedEvents({ id: 'chg-1' }, null, operator)
    expect(sup).toEqual([expect.objectContaining({ id: 'ev-1', status: 'suppressed' })])
    expect(callMatching(/SUPPRESSED_BY/)!.params).toEqual({ id: 'chg-1', tenantId: 'tenant-1' })
  })
})

// ── events (query) / stats / alias ───────────────────────────────────────────

describe('events', () => {
  it('filtri → WHERE scoped per tenant, ordinamento last_seen_at DESC, paginazione, total; CI risolto inline con type dalle label', async () => {
    onCypher([
      [/RETURN count\(e\) AS total/, { total: 7 }],
      [/ORDER BY e\.last_seen_at DESC/, [eventRow({}, { ciId: 'ci-1', ciName: 'db-01', ciStatus: 'active', ciHealth: 'down', ciLabels: ['Server'] }), eventRow({ id: 'ev-2' })]],
    ])
    const out = await eventResolvers.Query.events(null, { filter: { status: ['firing'], severity: ['critical', 'warning'], orphan: false, search: ' DB ', since: '2026-09-01T00:00:00Z', sourceId: 'hook-1', ciId: 'ci-1', incidentId: 'inc-1', suppressedByChangeId: 'chg-1' }, limit: 10, offset: 20 }, operator)
    expect(out.total).toBe(7)
    expect(out.items).toHaveLength(2)
    expect(out.items[0]).toMatchObject({ id: 'ev-1', status: 'firing', count: 3, correlation: 'none', ci: { id: 'ci-1', name: 'db-01', type: 'server', status: 'active', health: 'down' } })
    expect(out.items[1]!.ci).toBeNull()
    const list = callMatching(/ORDER BY e\.last_seen_at DESC/)!
    expect(list.cypher).toContain('e.tenant_id = $tenantId')
    expect(list.cypher).toContain('e.status IN $status')
    expect(list.cypher).toContain('e.severity IN $severity')
    expect(list.cypher).toContain('e.source_id = $sourceId')
    expect(list.cypher).toContain('EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {id: $ciId, tenant_id: $tenantId}) }')
    expect(list.cypher).toContain('EXISTS { (e)-[:CORRELATED_INTO]->(:Incident {id: $incidentId, tenant_id: $tenantId}) }')
    expect(list.cypher).toContain('EXISTS { (e)-[:SUPPRESSED_BY]->(:Change {id: $suppressedByChangeId, tenant_id: $tenantId}) }')
    expect(list.cypher).toContain('e.last_seen_at >= $since')
    expect(list.cypher).toContain('toLower(e.title) CONTAINS $search')
    expect(list.params).toMatchObject({ tenantId: 'tenant-1', limit: 10, offset: 20, search: 'db', status: ['firing'], incidentId: 'inc-1', suppressedByChangeId: 'chg-1' })
  })

  it('status/severity fuori enum o since non ISO → BAD_USER_INPUT senza query; limit oltre 500 viene ridotto', async () => {
    await expectCode(eventResolvers.Query.events(null, { filter: { status: ['open'] } }, operator), 'BAD_USER_INPUT', /Invalid status filter "open"/)
    await expectCode(eventResolvers.Query.events(null, { filter: { severity: ['high'] } }, operator), 'BAD_USER_INPUT', /Invalid severity filter/)
    await expectCode(eventResolvers.Query.events(null, { filter: { since: 'ieri' } }, operator), 'BAD_USER_INPUT', /since must be an ISO date/)
    expect(getSession).not.toHaveBeenCalled()
    onCypher([[/RETURN count\(e\) AS total/, { total: 0 }], [/ORDER BY e\.last_seen_at DESC/, []]])
    await eventResolvers.Query.events(null, { limit: 5000 }, operator)
    expect(callMatching(/ORDER BY/)!.params['limit']).toBe(500)
  })

  it('eventStats → una query scoped per tenant con i sette contatori + le sorgenti in tempesta (eventStorm.listStormSources)', async () => {
    onCypher([[/count\(CASE WHEN e\.status = 'firing' THEN 1 END\) AS firing/, { firing: 4, critical: 1, warning: 2, orphan: 1, suppressed: 0, flapping: 0, resolved24h: 9 }]])
    const out = await eventResolvers.Query.eventStats(null, null, operator)
    expect(out).toEqual({ firing: 4, critical: 1, warning: 2, orphan: 1, suppressed: 0, flapping: 0, resolved24h: 9, stormSources: [] })
    const q = callMatching(/AS firing/)!
    expect(q.cypher).toContain('MATCH (e:Event {tenant_id: $tenantId})')
    expect(q.cypher).toContain("e.status = 'resolved' AND e.resolved_at >= $since24h")
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

  it('acknowledgeEvent → SET acknowledged_by dal contesto', async () => {
    onCypher([[/SET e\.acknowledged_by = \$userId, e\.acknowledged_at = \$now/, eventRow({ acknowledged_by: 'op-1', acknowledged_at: 'NOW' })]])
    const out = await eventResolvers.Mutation.acknowledgeEvent(null, { id: 'ev-1' }, operator)
    expect(out).toMatchObject({ id: 'ev-1', acknowledgedAt: 'NOW' })
    expect(callMatching(/acknowledged_by/)!.params).toMatchObject({ id: 'ev-1', tenantId: 'tenant-1', userId: 'op-1' })
    expect(audit).toHaveBeenCalledWith(operator, 'event.acknowledged', 'Event', 'ev-1')
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
    const raw = eventResolvers.Query.sampleInboundPayload(null, { connectorKind: 'zabbix' })
    expect(JSON.parse(raw)).toEqual(SAMPLE_PAYLOADS.zabbix)
    expect(raw).toContain('\n')
    expect(() => eventResolvers.Query.sampleInboundPayload(null, { connectorKind: 'nagios' })).toThrow(/connectorKind must be one of: generic, alertmanager, grafana, zabbix, datadog, dynatrace/)
  })

  it('payloadKeys → percorsi puntati foglia con esempio; JSON non valido o vuoto → BAD_USER_INPUT', () => {
    const keys = eventResolvers.Query.payloadKeys(null, { payload: JSON.stringify({ alert: { name: 'A', tags: ['x', 'y'] }, n: 1 }) })
    expect(keys).toEqual([{ path: 'alert.name', sample: 'A' }, { path: 'alert.tags.0', sample: 'x' }, { path: 'alert.tags.1', sample: 'y' }, { path: 'n', sample: '1' }])
    expect(() => eventResolvers.Query.payloadKeys(null, { payload: '{nope' })).toThrow(/payload is not valid JSON/)
    expect(() => eventResolvers.Query.payloadKeys(null, { payload: '' })).toThrow(GraphQLError)
  })
})

describe('monitoringSources / ciHealth', () => {
  it('monitoringSources → InboundWebhook del tenant con entity_type event, mappati come mapInbound (valueMapping, lastError, errorCount)', async () => {
    onCypher([[/MATCH \(w:InboundWebhook \{tenant_id: \$tenantId, entity_type: 'event'\}\)/, [{ props: { id: 'src-1', name: 'Zabbix', entity_type: 'event', connector_kind: 'zabbix', field_mapping: '{}', value_mapping: '{"status":{"1":"firing"}}', last_error: 'boom', error_count: 2, receive_count: 5 } }]]])
    const out = await eventResolvers.Query.monitoringSources(null, null, operator)
    expect(out).toEqual([expect.objectContaining({ id: 'src-1', entityType: 'event', connectorKind: 'zabbix', valueMapping: '{"status":{"1":"firing"}}', lastError: 'boom', errorCount: 2, receiveCount: 5 })])
    expect(callMatching(/entity_type: 'event'/)!.params).toEqual({ tenantId: 'tenant-1' })
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
    const out = await eventResolvers.Mutation.previewInboundEvents(null, { input: generic }, operator)
    expect(out).toEqual([{
      externalId: 'EVT-100234', status: 'firing', severity: 'warning', title: 'CheckoutErrorRate',
      description: 'Service checkout-api is returning HTTP 500 on 12% of requests',
      resource: 'api-03.example.local', resourceKind: 'hostname', labels: JSON.stringify({ env: 'prod', service: 'checkout-api' }),
    }])
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

  it('errori di configurazione o payload → BAD_USER_INPUT con il campo; viewer → FORBIDDEN', async () => {
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, payload: '{oops' } }, operator), 'BAD_USER_INPUT', /payload is not valid JSON/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, connectorKind: 'nagios' } }, operator), 'BAD_USER_INPUT', /connectorKind must be one of/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, valueMapping: JSON.stringify({ severity: {} }) } }, operator), 'BAD_USER_INPUT', /severity value "major" is not mapped/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, defaultValues: null } }, operator), 'BAD_USER_INPUT', /resourceKind is missing: set default_values\.resourceKind/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: { ...generic, fieldMapping: JSON.stringify({ foo: 'bar' }) } }, operator), 'BAD_USER_INPUT', /field_mapping\.foo is not a normalized field/)
    await expectCode(eventResolvers.Mutation.previewInboundEvents(null, { input: generic }, viewer), 'FORBIDDEN')
  })
})

describe('sendSampleEvent', () => {
  const source = (over: Record<string, unknown> = {}) => ({ props: { id: 'src-1', tenant_id: 'tenant-1', entity_type: 'event', connector_kind: 'datadog', field_mapping: '{}', default_values: null, value_mapping: null, ...over } })

  it('carica la sorgente del tenant, normalizza il campione del SUO connettore con la SUA config, accoda via enqueueEvents, aggiorna le statistiche, audit', async () => {
    vi.mocked(enqueueEvents).mockResolvedValueOnce(1)
    onCypher([[/MATCH \(w:InboundWebhook \{id: \$id, tenant_id: \$tenantId\}\)\s+RETURN properties\(w\)/, source()], [/SET w\.receive_count/, null]])
    await expect(eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)).resolves.toBe(1)
    expect(enqueueEvents).toHaveBeenCalledTimes(1)
    const [tenantId, sourceId, events, receivedAt] = vi.mocked(enqueueEvents).mock.calls[0]!
    expect(tenantId).toBe('tenant-1'); expect(sourceId).toBe('src-1')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ externalId: '7654321', status: 'firing', severity: 'critical', resource: 'cache-01', resourceKind: 'hostname', labels: expect.objectContaining({ env: 'prod' }) })
    expect(Number.isNaN(Date.parse(receivedAt!))).toBe(false)
    const stats = callMatching(/SET w\.receive_count/)!
    expect(stats.cypher).toContain('MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})')
    expect(stats.cypher).toMatch(/w\.last_error = null/)
    expect(stats.params).toMatchObject({ id: 'src-1', tenantId: 'tenant-1', n: 1, now: receivedAt })
    expect(audit).toHaveBeenCalledWith(admin, 'event_source.sample_sent', 'InboundWebhook', 'src-1', { connectorKind: 'datadog', accepted: 1 })
  })

  it('sorgente generic: applica field_mapping / default_values / value_mapping salvati sul webhook', async () => {
    vi.mocked(enqueueEvents).mockResolvedValueOnce(1)
    onCypher([[/RETURN properties\(w\)/, source({ connector_kind: 'generic', field_mapping: JSON.stringify(GENERIC_SAMPLE_CONFIG.fieldMapping), default_values: JSON.stringify({ resourceKind: 'fqdn' }), value_mapping: JSON.stringify(GENERIC_SAMPLE_CONFIG.valueMapping) })], [/SET w\.receive_count/, null]])
    await eventResolvers.Mutation.sendSampleEvent(null, { sourceId: 'src-1' }, admin)
    expect(vi.mocked(enqueueEvents).mock.calls[0]![2][0]).toMatchObject({ title: 'CheckoutErrorRate', severity: 'warning', status: 'firing', resource: 'api-03.example.local', resourceKind: 'fqdn' })
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

  it('contatori su tutto il tenant + righe ordinate per gravità, dipendenti DESC, nome; type dalla label; total', async () => {
    onCypher([
      [/AS unmonitored/, COUNTS],
      [/ORDER BY CASE ci\.health WHEN 'down' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, dependents DESC, ci\.name/, [row(), row({ id: 'ci-2', name: 'app', label: 'Application', health: 'operational', healthSource: 'manual', dependents: 0, ownerTeam: null, healthSince: null, lastEventAt: null, firingEvents: 0 })]],
      [/RETURN count\(ci\) AS total/, { total: 8 }],
    ])
    const out = await eventResolvers.Query.ciHealthOverview(null, {}, viewer)
    expect(out).toMatchObject({ down: 2, degraded: 1, operational: 5, unmonitored: 12, total: 8 })
    expect(out.items).toEqual([
      { id: 'ci-1', name: 'db-01', type: 'server', environment: 'production', health: 'down', healthSource: 'monitoring', healthSince: '2026-09-09T10:00:00Z', lastEventAt: '2026-09-09T10:05:00Z', firingEvents: 2, dependents: 7, ownerTeam: 'DBA' },
      { id: 'ci-2', name: 'app', type: 'application', environment: 'production', health: 'operational', healthSource: 'manual', healthSince: null, lastEventAt: null, firingEvents: 0, dependents: 0, ownerTeam: null },
    ])
    const counts = callMatching(/AS unmonitored/)!
    expect(counts.cypher).toContain('MATCH (ci:ConfigurationItem {tenant_id: $tenantId})')
    expect(counts.cypher).toContain('count(CASE WHEN ci.health IS NULL         THEN 1 END) AS unmonitored')
    expect(counts.params).toEqual({ tenantId: 'tenant-1' })   // indipendenti dal filtro
    const list = callMatching(/ORDER BY CASE ci\.health/)!
    expect(list.cypher).toContain('WHERE ci.health IS NOT NULL')
    expect(list.cypher).toContain("OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)")
    expect(list.cypher).toContain('OPTIONAL MATCH (dep:ConfigurationItem {tenant_id: $tenantId})-[:DEPENDS_ON]->(ci)')
    expect(list.cypher).toContain('OPTIONAL MATCH (ci)-[:OWNED_BY]->(team:Team {tenant_id: $tenantId})')
    expect(list.cypher).toContain("head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label")
    expect(list.params).toMatchObject({ tenantId: 'tenant-1', limit: 100, offset: 0 })
  })

  it('filtri: salute, tipo (→ label), ambiente, team (OWNED_BY scoped), ricerca minuscola; limit clampato a 500', async () => {
    onCypher([[/AS unmonitored/, COUNTS], [/ORDER BY CASE ci\.health/, []], [/RETURN count\(ci\) AS total/, { total: 0 }]])
    const out = await eventResolvers.Query.ciHealthOverview(null, { filter: { health: ['down', 'degraded'], type: 'database_instance', environment: 'staging', team: 'team-9', search: '  DB ' }, limit: 9000, offset: 50 }, operator)
    expect(out.items).toEqual([]); expect(out.total).toBe(0)
    const list = callMatching(/ORDER BY CASE ci\.health/)!
    expect(list.cypher).toContain('ci.health IN $health')
    expect(list.cypher).toContain('$typeLabel IN labels(ci)')
    expect(list.cypher).toContain('ci.environment = $environment')
    expect(list.cypher).toContain('EXISTS { (ci)-[:OWNED_BY]->(:Team {id: $team, tenant_id: $tenantId}) }')
    expect(list.cypher).toContain('toLower(ci.name) CONTAINS $search')
    expect(list.params).toMatchObject({ health: ['down', 'degraded'], typeLabel: 'DatabaseInstance', environment: 'staging', team: 'team-9', search: 'db', limit: 500, offset: 50 })
    // il conteggio usa lo stesso WHERE dei risultati
    expect(callMatching(/RETURN count\(ci\) AS total/)!.cypher).toContain('ci.health IN $health')
    // tipo dinamico (non in TYPE_TO_LABEL) → label PascalCase per convenzione
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/AS unmonitored/, COUNTS], [/ORDER BY CASE ci\.health/, []], [/RETURN count\(ci\) AS total/, { total: 0 }]])
    await eventResolvers.Query.ciHealthOverview(null, { filter: { type: 'erp_system' } }, operator)
    expect(callMatching(/ORDER BY CASE ci\.health/)!.params['typeLabel']).toBe('ErpSystem')
  })

  it('salute fuori vocabolario → BAD_USER_INPUT senza query; riga senza label di tipo → errore esplicito', async () => {
    await expectCode(eventResolvers.Query.ciHealthOverview(null, { filter: { health: ['broken'] } }, operator), 'BAD_USER_INPUT', /Invalid health filter "broken": expected one of operational, degraded, down/)
    expect(getSession).not.toHaveBeenCalled()
    onCypher([[/AS unmonitored/, COUNTS], [/ORDER BY CASE ci\.health/, [row({ label: null })]], [/RETURN count\(ci\) AS total/, { total: 1 }]])
    await expect(eventResolvers.Query.ciHealthOverview(null, {}, operator)).rejects.toThrow(/CI ci-1 has no type label/)
  })
})
