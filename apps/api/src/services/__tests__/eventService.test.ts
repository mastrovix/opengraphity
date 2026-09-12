/**
 * eventService.ts — normalizzazione per connettore (alertmanager, grafana,
 * zabbix, datadog, dynatrace, generic con percorsi puntati + value_mapping; errori →
 * ValidationError con il percorso del campo), impronta stabile (mai la description), stato
 * successivo dell'evento (ripetizione / nuovo ciclo / risoluzione), regole di
 * ricalcolo della salute del CI (health_source manual / status maintenance
 * intoccabili, ci.status mai scritto), ingest
 * nuovo / ripetuto / resolved→firing / stale / duplicate con mock delle query;
 * la pipeline di correlazione (ondata 3) è mockata e se ne verifica
 * invocazione ed esito. Revisione (ondata 1): la tabella EVENT_TRANSITIONS è
 * la sorgente unica di nextEventState e del CASE Cypher del MERGE: qui si
 * verifica che i due concordino riga per riga.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
// Ondata 7 · C-4: `recomputeCIHealth` non ha più il letterale `'maintenance'`
// nel Cypher — gli stati «in manutenzione» arrivano dalla semantica del
// cliente come parametro `$maintenanceStatuses`. Qui la semantica del cliente
// di prova, con i valori iniziali.
vi.mock('../../lib/ciLifecycle.js', () => ({
  resolveCILifecycleSemantics: vi.fn().mockResolvedValue({
    retired: new Set(['inactive', 'decommissioned']),
    maintenance: new Set(['maintenance']),
    ignored: new Set(['decommissioned']),
  }),
}))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
// Ondata 3: soppressione → salute → correlazione vivono in services/events/pipeline.ts
// (testato a parte via eventCorrelation.test.ts); qui si verifica solo che
// ingestEvent la invochi nel punto giusto e ne rispetti l'esito. Il mock è sul
// modulo reale: la facciata eventCorrelation.js lo ri-esporta.
vi.mock('../events/pipeline.js', () => ({ runEventPipeline: vi.fn() }))
vi.mock('../../middleware/metrics.js', () => ({
  eventsReceivedTotal: { inc: vi.fn() }, eventsDeduplicatedTotal: { inc: vi.fn() }, eventsOrphanTotal: { inc: vi.fn() }, eventsAmbiguousTotal: { inc: vi.fn() }, eventsOutOfOrderTotal: { inc: vi.fn() }, eventsResolvedUnknownTotal: { inc: vi.fn() },
}))

const svc = await import('../eventService.js')
const {
  normalizePayload, fingerprintOf, nextEventState, deriveCIHealth, recomputeCIHealth, ingestEvent, matchCI, getEventPolicy, setEventPolicy, MAX_EVENTS_PER_REQUEST, stripPort, isIpLiteral, hostResource, getPath, listPayloadKeys, PAYLOAD_KEYS_MAX, PAYLOAD_MAX_DEPTH, quoteValue, parseValueMapping, sourceConfigOf, normalizeWithConfig, countTransitionsSince, payloadStatusOf, transitionsOf, MAX_TRANSITIONS, QUIET_OUTCOMES,
  EVENT_TRANSITIONS, prevClassOf, transitionRuleFor, PREV_CLASS_CYPHER, SEVERITY_MAX_CYPHER, TRANSITION_ACTION_CYPHER, transitionCaseCypher, residueClearCypher, transitionSetCypher, ingestMergeCypher, INGEST_WRITE_OUTCOMES, APPLIED_OUTCOME_CYPHER,
  ciMatchCypher, ciMatchParams, shortHostnameKeys, CI_MATCH_GUARD, MATCH_CANDIDATES_MAX, CI_HEALTH_RULES, ciHealthCaseCypher,
  INGEST_HISTORY_KIND_CYPHER, LAST_PAYLOAD_STATUS_CYPHER,
} = svc
const { historyWriteCypher } = await import('../events/history.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { runEventPipeline } = await import('../eventCorrelation.js')
const metrics = await import('../../middleware/metrics.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const pipelineResult = (over: Record<string, unknown> = {}) => ({ outcome: 'none', status: 'firing', suppressedByChangeId: null, incidentId: null, ...over })

function expectValidation(fn: () => unknown, pattern: RegExp) {
  const err = (() => { try { fn(); return null } catch (e) { return e as GraphQLError } })()
  expect(err, 'expected a ValidationError').toBeInstanceOf(GraphQLError)
  expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
  expect(err!.message).toMatch(pattern)
}

/** Dispatch dei mock per frammento di Cypher: la prima regola che combacia vince. */
function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string) => {
    for (const [re, value] of rules) if (re.test(cypher)) return typeof value === 'function' ? (value as () => unknown)() : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string) => { const r = await impl(s, c); return r == null ? [] : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
})

// ── normalizePayload ─────────────────────────────────────────────────────────

const AM_PAYLOAD = {
  receiver: 'opengrafo',
  alerts: [
    {
      status: 'firing', fingerprint: 'abc123',
      labels: { alertname: 'DiskFull', severity: 'critical', instance: 'db-01.example.local:9100', job: 'node' },
      annotations: { summary: 'Disk almost full', description: '/var at 97%' },
      startsAt: '2026-09-09T10:00:00Z', endsAt: '0001-01-01T00:00:00Z',
    },
    {
      status: 'resolved', fingerprint: 'def456',
      labels: { alertname: 'HighLoad', severity: 'warning', instance: '10.0.0.7' },
      annotations: {},
      startsAt: '2026-09-09T09:00:00Z', endsAt: '2026-09-09T09:30:00Z',
    },
  ],
}

describe('normalizePayload — alertmanager', () => {
  it('un evento per alert: resource senza porta, hostname, severity/status/externalId dal payload, description = summary + description', () => {
    const out = normalizePayload('alertmanager', AM_PAYLOAD, {}, {})
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      externalId: 'abc123', status: 'firing', severity: 'critical', title: 'DiskFull',
      description: 'Disk almost full\n/var at 97%',
      resource: 'db-01.example.local', resourceKind: 'hostname',
      labels: { alertname: 'DiskFull', severity: 'critical', instance: 'db-01.example.local:9100', job: 'node' },
      startsAt: '2026-09-09T10:00:00Z',
    })
    expect(out[0]).not.toHaveProperty('endsAt')   // 0001-… = ancora aperto
    // B2-17: `instance` numerico è un IP, non un hostname (l'alias da consultare sul CI è `ip`)
    expect(out[1]).toMatchObject({ externalId: 'def456', status: 'resolved', severity: 'warning', title: 'HighLoad', resource: '10.0.0.7', resourceKind: 'ip', endsAt: '2026-09-09T09:30:00Z' })
    expect(out[1]).not.toHaveProperty('description')
  })

  it('M5 — stripPort: host:porta → host; IPv4:porta → IPv4; [ipv6]:porta → ipv6 senza parentesi; IPv6 nudo e senza porta invariati', () => {
    expect(stripPort('db-01:9100')).toBe('db-01')
    expect(stripPort('10.0.0.7:9100')).toBe('10.0.0.7')
    expect(stripPort('[::1]:9100')).toBe('::1')
    expect(stripPort('[2001:db8::1]:9100')).toBe('2001:db8::1')
    expect(stripPort('[::1]')).toBe('::1')
    expect(stripPort('::1')).toBe('::1')
    expect(stripPort('2001:db8::1')).toBe('2001:db8::1')
    expect(stripPort('db-01')).toBe('db-01')
    expect(stripPort('db-01:abc')).toBe('db-01:abc')
  })

  // Revisione 2 · B2-17: nei target Prometheus di Kubernetes, del cloud e dei
  // node_exporter statici `instance` è quasi sempre un IP con la porta. Trattarlo
  // come `hostname` faceva cercare un alias `hostname = 10.0.0.7` (che la
  // discovery non produce mai) invece dell'alias `ip` del CI: orfani sistematici.
  it('B2-17 — isIpLiteral: `instance` IPv4/IPv6 (con o senza porta) → resourceKind `ip`; nomi e FQDN restano `hostname`', () => {
    expect(isIpLiteral('10.0.0.7')).toBe(true)
    expect(isIpLiteral('::1')).toBe(true)
    expect(isIpLiteral('2001:db8::1')).toBe(true)
    expect(isIpLiteral('::ffff:10.0.0.7')).toBe(true)
    expect(isIpLiteral('db-01')).toBe(false)
    expect(isIpLiteral('db-01.example.local')).toBe(false)
    expect(isIpLiteral('10.0.0.7.example.local')).toBe(false)
    expect(hostResource('10.0.0.7:9100')).toEqual({ resource: '10.0.0.7', resourceKind: 'ip' })
    expect(hostResource('[::1]:9100')).toEqual({ resource: '::1', resourceKind: 'ip' })
    expect(hostResource('db-01:9100')).toEqual({ resource: 'db-01', resourceKind: 'hostname' })

    const alerts = (instance: string) => ({ alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'critical', instance } }] })
    expect(normalizePayload('alertmanager', alerts('10.0.0.7:9100'), {}, {})[0]).toMatchObject({ resource: '10.0.0.7', resourceKind: 'ip' })
    expect(normalizePayload('alertmanager', alerts('[::1]:9100'), {}, {})[0]).toMatchObject({ resource: '::1', resourceKind: 'ip' })
    expect(normalizePayload('alertmanager', alerts('db-01.example.local:9100'), {}, {})[0]).toMatchObject({ resource: 'db-01.example.local', resourceKind: 'hostname' })
    // il generic che DICHIARA hostname segue la stessa regola (il tipo lo decide il valore)
    const generic = (resource: string) => normalizePayload('generic', { title: 'X', severity: 'critical', resource }, {}, { resourceKind: 'hostname' })[0]
    expect(generic('10.0.0.7:9100')).toMatchObject({ resource: '10.0.0.7', resourceKind: 'ip' })
    expect(generic('db-01')).toMatchObject({ resource: 'db-01', resourceKind: 'hostname' })
    // l'alias consultato dal riconoscimento è quello del tipo: `ip`, non `hostname`
    expect(ciMatchParams('t1', { resource: '10.0.0.7', resourceKind: 'ip' }, { matchShortHostname: true })).toMatchObject({ kind: 'ip', kindValue: '10.0.0.7', shortNameKey: null, fqdnPrefix: null })
  })

  it('A1 — value_mapping vale anche per Alertmanager: severità libera (page, P1) e status tradotti; default_values.resource + resourceKind per gli alert senza instance', () => {
    const payload = { alerts: [
      { status: 'firing', labels: { alertname: 'Watchdog', severity: 'page' } },
      { status: 'ok', labels: { alertname: 'X', severity: 'P1', instance: 'h:9100' } },
    ] }
    const vm = parseValueMapping({ severity: { Page: 'critical', p1: 'critical' }, status: { ok: 'resolved' } })
    const out = normalizePayload('alertmanager', payload, {}, { resource: 'prometheus-prod', resourceKind: 'name' }, vm)
    expect(out[0]).toMatchObject({ title: 'Watchdog', severity: 'critical', status: 'firing', resource: 'prometheus-prod', resourceKind: 'name' })
    expect(out[1]).toMatchObject({ severity: 'critical', status: 'resolved', resource: 'h', resourceKind: 'hostname' })
    // senza risorsa predefinita l'alert senza instance è scartato con il rimedio nel messaggio
    expectValidation(() => normalizePayload('alertmanager', { alerts: [payload.alerts[0]] }, {}, {}, vm), /alerts\[0\]\.labels\.instance is missing or empty and default_values\.resource is not set \(set default_values\.resource \+ resourceKind/)
    // resource senza resourceKind: configurazione rotta, non un tipo inventato
    expectValidation(() => normalizePayload('alertmanager', { alerts: [payload.alerts[0]] }, {}, { resource: 'x' }, vm), /default_values\.resourceKind must be one of: hostname, ip, fqdn, external_id, name/)
  })

  it('A1 — normalizeBatch: accettazione parziale per elemento (i validi passano, gli scarti portano indice e motivo); un difetto della busta resta un errore di tutta la richiesta', () => {
    const payload = { alerts: [
      { status: 'firing', labels: { alertname: 'A', severity: 'info', instance: 'h1' } },
      { status: 'firing', labels: { alertname: 'B', severity: 'page', instance: 'h2' } },
      { status: 'firing', labels: { alertname: 'C', severity: 'info' } },
      'not-an-object',
    ] }
    const batch = svc.normalizeBatch('alertmanager', payload, {}, {})
    expect(batch.total).toBe(4)
    expect(batch.events.map((e) => e.title)).toEqual(['A'])
    expect(batch.rejected).toEqual([
      { index: 1, error: expect.stringMatching(/alerts\[1\]\.labels\.severity value "page" is not mapped/) },
      { index: 2, error: expect.stringMatching(/alerts\[2\]\.labels\.instance is missing/) },
      { index: 3, error: 'alerts[3] is not an object' },
    ])
    expect(svc.rejectionSummary(batch)).toMatch(/^3 di 4 scartati: alerts\[1\]\.labels\.severity value "page"/)
    expect(svc.rejectionSummary({ total: 1, rejected: [{ index: 0, error: 'boom' }] })).toBe('boom')
    expect(svc.rejectionSummary({ total: 2, rejected: [] })).toBe('')
    expect(svc.rejectionSummary({ total: 2, rejected: [{ index: 0, error: 'x'.repeat(600) }] })).toHaveLength(500)
    // busta rotta → ValidationError, non una lista di scarti
    expectValidation(() => svc.normalizeBatch('alertmanager', { alerts: 'x' }, {}, {}), /no `alerts` array/)
    // connettori a un evento: indice 0
    expect(svc.normalizeBatch('zabbix', { event_id: '1' }, {}, {})).toEqual({ total: 1, events: [], rejected: [{ index: 0, error: expect.stringMatching(/event_name \(or trigger_name\) is missing/) }] })
    // normalizePayload è la variante tutto-o-niente
    expectValidation(() => normalizePayload('alertmanager', payload, {}, {}), /alerts\[1\]\.labels\.severity value "page"/)
  })

  it.each([
    ['severity fuori enum', { ...AM_PAYLOAD, alerts: [{ ...AM_PAYLOAD.alerts[0], labels: { ...AM_PAYLOAD.alerts[0]!.labels, severity: 'page' } }] }, /alerts\[0\]\.labels\.severity value "page" is not mapped \(value_mapping\.severity\) and is not one of: info, warning, critical/],
    ['severity mancante senza default', { ...AM_PAYLOAD, alerts: [{ ...AM_PAYLOAD.alerts[0], labels: { alertname: 'X', instance: 'h' } }] }, /alerts\[0\]\.labels\.severity is missing \(no default_values\.severity\)/],
    ['alertname mancante', { alerts: [{ status: 'firing', labels: { severity: 'info', instance: 'h' } }] }, /labels\.alertname is missing/],
    ['instance mancante', { alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'info' } }] }, /labels\.instance is missing/],
    ['status sconosciuto', { alerts: [{ status: 'pending', labels: { alertname: 'X', severity: 'info', instance: 'h' } }] }, /alerts\[0\]\.status value "pending" is not mapped \(value_mapping\.status\) and is not one of: firing, resolved/],
    ['status mancante', { alerts: [{ labels: { alertname: 'X', severity: 'info', instance: 'h' } }] }, /alerts\[0\]\.status is missing/],
    ['alerts non lista', { alerts: { status: 'firing' } }, /no `alerts` array/],
    ['payload lista', [AM_PAYLOAD], /must be a JSON object/],
    ['payload null', null, /must be a JSON object/],
    ['alert non oggetto', { alerts: ['x'] }, /alerts\[0\] is not an object/],
  ])('%s → ValidationError', (_name, payload, pattern) => {
    expectValidation(() => normalizePayload('alertmanager', payload, {}, {}), pattern)
  })

  it('severity mancante ma presente in default_values → usa il default (config esplicita, non silenziosa)', () => {
    const payload = { alerts: [{ status: 'firing', labels: { alertname: 'X', instance: 'h' } }] }
    expect(normalizePayload('alertmanager', payload, {}, { severity: 'warning' })[0]!.severity).toBe('warning')
  })

  it(`più di ${MAX_EVENTS_PER_REQUEST} alert → ValidationError prima di normalizzare`, () => {
    const alert = AM_PAYLOAD.alerts[0]!
    const payload = { alerts: Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => alert) }
    expectValidation(() => normalizePayload('alertmanager', payload, {}, {}), /Too many alerts in one request: 501 \(max 500\)/)
    expect(normalizePayload('alertmanager', { alerts: Array.from({ length: MAX_EVENTS_PER_REQUEST }, () => alert) }, {}, {})).toHaveLength(MAX_EVENTS_PER_REQUEST)
  })

  it('etichette non stringa vengono serializzate, quelle null saltate', () => {
    const payload = { alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'info', instance: 'h', n: 3, obj: { a: 1 }, nil: null } }] }
    expect(normalizePayload('alertmanager', payload, {}, {})[0]!.labels).toEqual({ alertname: 'X', severity: 'info', instance: 'h', n: '3', obj: '{"a":1}' })
  })
})

describe('normalizePayload — grafana', () => {
  const GRAFANA = {
    alerts: [
      { status: 'firing', fingerprint: 'g1', labels: { alertname: 'HighCPULoad', severity: 'warning', instance: 'web-01.example.local:9100' }, annotations: { summary: 'CPU > 85%' }, startsAt: '2026-09-09T10:05:00Z', endsAt: '0001-01-01T00:00:00Z' },
      { status: 'resolved', fingerprint: 'g2', labels: { alertname: 'PodCrashLoop', severity: 'critical', host: 'k8s-node-3' }, annotations: {}, endsAt: '2026-09-09T10:30:00Z' },
    ],
  }

  it('stesso schema di Alertmanager: firing e resolved, risorsa da labels.instance senza porta oppure labels.host', () => {
    const out = normalizePayload('grafana', GRAFANA, {}, {})
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ externalId: 'g1', status: 'firing', severity: 'warning', title: 'HighCPULoad', resource: 'web-01.example.local', resourceKind: 'hostname', description: 'CPU > 85%', startsAt: '2026-09-09T10:05:00Z' })
    expect(out[0]).not.toHaveProperty('endsAt')
    expect(out[1]).toMatchObject({ externalId: 'g2', status: 'resolved', severity: 'critical', title: 'PodCrashLoop', resource: 'k8s-node-3', resourceKind: 'hostname', endsAt: '2026-09-09T10:30:00Z' })
  })

  it.each([
    ['senza instance né host', { alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'info' } }] }, /alerts\[0\]\.labels\.instance \(or labels\.host\) is missing/],
    ['severity fuori enum', { alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'page', instance: 'h' } }] }, /alerts\[0\]\.labels\.severity value "page" is not mapped/],
    ['senza alerts', { title: '[FIRING:1]' }, /Grafana payload has no `alerts` array/],
    ['payload lista', [], /Grafana payload must be a JSON object/],
  ])('%s → ValidationError con il percorso del campo', (_n, payload, pattern) => {
    expectValidation(() => normalizePayload('grafana', payload, {}, {}), pattern)
  })
})

describe('normalizePayload — zabbix', () => {
  const ZBX = { event_id: '184352', event_name: 'Zabbix agent is not available', event_severity: 'High', event_value: '1', host_name: 'app-01', host_ip: '10.0.1.21', trigger_description: 'Agent not responding', event_opdata: 'Last check: 10:09', trigger_id: '23451' }

  it('problema (event_value 1) → firing, severità mappata, hostname, description = trigger_description + event_opdata, etichette dell\'host', () => {
    const out = normalizePayload('zabbix', ZBX, {}, {})
    expect(out).toEqual([{
      externalId: '184352', status: 'firing', severity: 'critical', title: 'Zabbix agent is not available',
      description: 'Agent not responding\nLast check: 10:09',
      resource: 'app-01', resourceKind: 'hostname',
      labels: { host_name: 'app-01', host_ip: '10.0.1.21', event_severity: 'High', trigger_id: '23451' },
    }])
  })

  it('recupero (event_value 0) → resolved; trigger_name al posto di event_name; senza host_name → host_ip con resourceKind ip', () => {
    const out = normalizePayload('zabbix', { event_id: '1', trigger_name: 'T', event_severity: 'Warning', event_value: '0', host_ip: '10.0.0.9' }, {}, {})
    expect(out[0]).toMatchObject({ status: 'resolved', title: 'T', severity: 'warning', resource: '10.0.0.9', resourceKind: 'ip' })
    expect(out[0]).not.toHaveProperty('description')
  })

  it.each([
    ['Not classified', 'info'], ['Information', 'info'], ['Warning', 'warning'], ['Average', 'warning'], ['High', 'critical'], ['Disaster', 'critical'], ['disaster', 'critical'],
  ])('event_severity %s → %s (senza distinguere maiuscole)', (zbx, expected) => {
    expect(normalizePayload('zabbix', { ...ZBX, event_severity: zbx }, {}, {})[0]!.severity).toBe(expected)
  })

  it.each([
    ['senza event_id', { ...ZBX, event_id: '' }, /event_id is missing or empty/],
    ['senza nome', { ...ZBX, event_name: undefined, trigger_name: undefined }, /event_name \(or trigger_name\) is missing/],
    ['severità sconosciuta', { ...ZBX, event_severity: 'Fatal' }, /event_severity must be one of: Not classified, Information, Warning, Average, High, Disaster\. Got: "Fatal"/],
    ['event_value non 0/1', { ...ZBX, event_value: 'PROBLEM' }, /event_value must be one of: "1" \(problem\), "0" \(recovery\)\. Got: "PROBLEM" \(or map it in value_mapping\.status\)/],
    ['senza event_value', { ...ZBX, event_value: undefined }, /event_value is missing/],
    ['senza host', { ...ZBX, host_name: undefined, host_ip: undefined }, /host_name \(or host_ip\) is missing or empty and default_values\.resource is not set/],
    ['payload lista', [ZBX], /Zabbix payload must be a JSON object/],
  ])('%s → ValidationError', (_n, payload, pattern) => {
    expectValidation(() => normalizePayload('zabbix', payload, {}, {}), pattern)
  })

  it('A1 — value_mapping vince sulla tabella incorporata (Average → critical, PROBLEM → firing) e aggiunge valori ignoti; valori numerici accettati', () => {
    const vm = parseValueMapping({ severity: { average: 'critical', Fatal: 'critical' }, status: { PROBLEM: 'firing', ok: 'resolved' } })
    expect(normalizePayload('zabbix', { ...ZBX, event_severity: 'Average' }, {}, {}, vm)[0]!.severity).toBe('critical')
    expect(normalizePayload('zabbix', { ...ZBX, event_severity: 'Fatal', event_value: 'PROBLEM' }, {}, {}, vm)[0]).toMatchObject({ severity: 'critical', status: 'firing' })
    expect(normalizePayload('zabbix', { ...ZBX, event_value: 'ok' }, {}, {}, vm)[0]!.status).toBe('resolved')
    expect(normalizePayload('zabbix', { ...ZBX, event_value: 1, event_nseverity: 4 }, {}, {})[0]).toMatchObject({ status: 'firing', labels: expect.objectContaining({ event_nseverity: '4' }) })
    // senza host: risorsa predefinita della sorgente
    expect(normalizePayload('zabbix', { ...ZBX, host_name: '', host_ip: '' }, {}, { resource: 'zabbix-server', resourceKind: 'name' })[0]).toMatchObject({ resource: 'zabbix-server', resourceKind: 'name' })
  })

  it('M2 — host_id ({HOST.ID}) è l\'id della risorsa (resourceExternalId) e resta fra le etichette; event_id resta l\'id dell\'allarme', () => {
    const out = normalizePayload('zabbix', { ...ZBX, host_id: '10084' }, {}, {})[0]!
    expect(out).toMatchObject({ externalId: '184352', resourceExternalId: '10084', labels: expect.objectContaining({ host_id: '10084' }) })
    expect(normalizePayload('zabbix', ZBX, {}, {})[0]).not.toHaveProperty('resourceExternalId')
  })

  it('M4 — event_date + event_time (ora locale di Zabbix) → startsAt ISO con il fuso del tenant; senza fuso, fuso non valido o testo non parsabile → startsAt assente e grezzo in labels.event_time', () => {
    const withTime = { ...ZBX, event_date: '2026.09.09', event_time: '10:12:37' }
    const rome = normalizePayload('zabbix', withTime, {}, {}, {}, { timezone: 'Europe/Rome' })[0]!
    expect(rome.startsAt).toBe('2026-09-09T08:12:37.000Z')
    expect(rome.labels).not.toHaveProperty('event_time')
    expect(normalizePayload('zabbix', withTime, {}, {}, {}, { timezone: 'UTC' })[0]!.startsAt).toBe('2026-09-09T10:12:37.000Z')
    expect(normalizePayload('zabbix', { ...withTime, event_date: '2026-01-09' }, {}, {}, {}, { timezone: 'America/New_York' })[0]!.startsAt).toBe('2026-01-09T15:12:37.000Z')
    for (const opts of [{}, { timezone: null }, { timezone: 'Mars/Olympus' }]) {
      const out = normalizePayload('zabbix', withTime, {}, {}, {}, opts)[0]!
      expect(out).not.toHaveProperty('startsAt')
      expect(out.labels['event_time']).toBe('2026.09.09 10:12:37')
    }
    const bad = normalizePayload('zabbix', { ...withTime, event_time: '{EVENT.TIME}' }, {}, {}, {}, { timezone: 'Europe/Rome' })[0]!
    expect(bad).not.toHaveProperty('startsAt')
    expect(bad.labels['event_time']).toBe('2026.09.09 {EVENT.TIME}')
    // solo la data, senza ora: nessun istante, grezzo conservato
    expect(normalizePayload('zabbix', { ...ZBX, event_date: '2026.09.09' }, {}, {}, {}, { timezone: 'Europe/Rome' })[0]!.labels['event_time']).toBe('2026.09.09')
  })

  it('M4 — zonedTimeToISO: ora legale/solare, separatori ammessi, data inesistente e testo estraneo → null', () => {
    const { zonedTimeToISO } = svc
    expect(zonedTimeToISO('2026.07.01 12:00:00', 'Europe/Rome')).toBe('2026-07-01T10:00:00.000Z')   // CEST
    expect(zonedTimeToISO('2026.12.01 12:00:00', 'Europe/Rome')).toBe('2026-12-01T11:00:00.000Z')   // CET
    expect(zonedTimeToISO('2026/12/01 12:00:00', 'Asia/Kolkata')).toBe('2026-12-01T06:30:00.000Z')
    expect(zonedTimeToISO('2026-12-01T12:00:00', 'UTC')).toBe('2026-12-01T12:00:00.000Z')
    expect(zonedTimeToISO('2026.02.30 12:00:00', 'UTC')).toBeNull()
    expect(zonedTimeToISO('2026.12.01 25:00:00', 'UTC')).toBeNull()
    expect(zonedTimeToISO('yesterday', 'UTC')).toBeNull()
    expect(zonedTimeToISO('2026.12.01 12:00:00', undefined)).toBeNull()
    expect(zonedTimeToISO('2026.12.01 12:00:00', 'Not/AZone')).toBeNull()
  })
})

describe('normalizePayload — datadog', () => {
  const DD = { alert_id: '7654321', alert_transition: 'Triggered', alert_type: 'error', title: '[Triggered] Memory high', body: 'Memory 94%', hostname: 'cache-01', tags: ['env:prod', 'service:cache', 'monitor'] }

  it('Triggered + error → firing critical, hostname, description dal body, tag chiave:valore come etichette (+ alert_id); A3: senza alert_cycle_key l\'id dell\'allarme è alert_id@risorsa', () => {
    expect(normalizePayload('datadog', DD, {}, {})).toEqual([{
      externalId: '7654321@cache-01', status: 'firing', severity: 'critical', title: '[Triggered] Memory high', description: 'Memory 94%',
      resource: 'cache-01', resourceKind: 'hostname', labels: { env: 'prod', service: 'cache', monitor: 'true', alert_id: '7654321' },
    }])
  })

  it('A3 — monitor multi-alert: due host con lo stesso alert_id sono due allarmi (impronte diverse); con alert_cycle_key l\'identità è il ciclo', () => {
    const a = normalizePayload('datadog', { ...DD, hostname: 'cache-01' }, {}, {})[0]!
    const b = normalizePayload('datadog', { ...DD, hostname: 'cache-02' }, {}, {})[0]!
    expect(fingerprintOf('s', a)).not.toBe(fingerprintOf('s', b))
    const cycle = normalizePayload('datadog', { ...DD, alert_cycle_key: '7654321:1788869557:host:cache-01', alert_scope: 'host:cache-01' }, {}, {})[0]!
    expect(cycle).toMatchObject({ externalId: '7654321:1788869557:host:cache-01', labels: expect.objectContaining({ alert_id: '7654321', alert_scope: 'host:cache-01', alert_cycle_key: '7654321:1788869557:host:cache-01' }) })
    // il Recovered dello stesso ciclo ha la stessa impronta
    const recovered = normalizePayload('datadog', { ...DD, alert_cycle_key: '7654321:1788869557:host:cache-01', alert_transition: 'Recovered' }, {}, {})[0]!
    expect(fingerprintOf('s', recovered)).toBe(fingerprintOf('s', cycle))
  })

  it('M4 — hostname vuoto (monitor su log/APM): alert_scope come nome SOLO con default_values.resourceFrom = alert_scope; poi default_values.resource; altrimenti scarto esplicito', () => {
    const noHost = { ...DD, hostname: '', alert_scope: 'service:checkout, env:prod' }
    expect(normalizePayload('datadog', noHost, {}, { resourceFrom: 'alert_scope' })[0]).toMatchObject({ resource: 'service:checkout, env:prod', resourceKind: 'name' })
    expect(normalizePayload('datadog', noHost, {}, { resource: 'datadog', resourceKind: 'name' })[0]).toMatchObject({ resource: 'datadog', resourceKind: 'name' })
    expectValidation(() => normalizePayload('datadog', noHost, {}, {}), /hostname is missing or empty and default_values\.resource is not set and default_values\.resourceFrom is not "alert_scope"/)
    // resourceFrom abilitato ma alert_scope assente → resource predefinita o scarto
    expectValidation(() => normalizePayload('datadog', { ...DD, hostname: '' }, {}, { resourceFrom: 'alert_scope' }), /hostname is missing or empty and default_values\.resource is not set \(set/)
    // hostname presente vince sempre
    expect(normalizePayload('datadog', { ...noHost, hostname: 'h' }, {}, { resourceFrom: 'alert_scope' })[0]).toMatchObject({ resource: 'h', resourceKind: 'hostname' })
  })

  it.each([
    ['Triggered', 'firing'], ['Re-Triggered', 'firing'], ['Warn', 'firing'], ['Re-Warn', 'firing'], ['No Data', 'firing'], ['Re-No Data', 'firing'], ['Renotify', 'firing'], ['Re-Notify', 'firing'],
    ['Recovered', 'resolved'], ['recovered', 'resolved'], ['Warn Recovered', 'resolved'],
  ])('alert_transition %s → %s', (transition, status) => {
    expect(normalizePayload('datadog', { ...DD, alert_transition: transition }, {}, {})[0]!.status).toBe(status)
  })

  it.each([['error', 'critical'], ['warning', 'warning'], ['info', 'info'], ['success', 'info']])('alert_type %s → %s', (type, severity) => {
    expect(normalizePayload('datadog', { ...DD, alert_type: type }, {}, {})[0]!.severity).toBe(severity)
  })

  it('A1 — alert_type / alert_transition fuori tabella → scarto, salvo value_mapping', () => {
    expectValidation(() => normalizePayload('datadog', { ...DD, alert_type: 'critical' }, {}, {}), /alert_type must be one of: error, warning, info, success\. Got: "critical" \(or map it in value_mapping\.severity\)/)
    const vm = parseValueMapping({ severity: { critical: 'critical' }, status: { Muted: 'resolved' } })
    expect(normalizePayload('datadog', { ...DD, alert_type: 'critical', alert_transition: 'Muted' }, {}, {}, vm)[0]).toMatchObject({ severity: 'critical', status: 'resolved' })
  })

  it('text al posto di body; tags come stringa separata da virgole o oggetto; date epoch → startsAt ISO', () => {
    const out = normalizePayload('datadog', { ...DD, body: undefined, text: 'plain', tags: 'env:prod, team:platform', date: 1788869557 }, {}, {})
    expect(out[0]).toMatchObject({ description: 'plain', labels: { env: 'prod', team: 'platform', alert_id: '7654321' }, startsAt: '2026-09-08T12:12:37.000Z' })
    expect(normalizePayload('datadog', { ...DD, tags: { env: 'prod' } }, {}, {})[0]!.labels).toEqual({ env: 'prod', alert_id: '7654321' })
  })

  it.each([
    ['senza alert_id', { ...DD, alert_id: undefined }, /alert_id is missing or empty/],
    ['senza title', { ...DD, title: '' }, /title is missing or empty/],
    ['transizione sconosciuta', { ...DD, alert_transition: 'Muted' }, /alert_transition must be one of: Triggered, Re-Triggered, Warn, Re-Warn, No Data, Re-No Data, Renotify, Recovered, Warn Recovered\. Got: "Muted" \(or map it in value_mapping\.status\)/],
    ['senza alert_transition', { ...DD, alert_transition: undefined }, /alert_transition is missing/],
    ['senza hostname', { ...DD, hostname: undefined }, /hostname is missing or empty and default_values\.resource is not set/],
    ['tags numero', { ...DD, tags: 3 }, /tags must be a list/],
    ['payload stringa', 'x', /Datadog payload must be a JSON object/],
  ])('%s → ValidationError', (_n, payload, pattern) => {
    expectValidation(() => normalizePayload('datadog', payload, {}, {}), pattern)
  })
})

describe('normalizePayload — dynatrace', () => {
  const DT = {
    State: 'OPEN', ProblemID: 'P-2409', PID: '-7361280981581184312_1788869500000V2', ProblemTitle: 'Host unavailable',
    ProblemSeverity: 'AVAILABILITY', ProblemImpact: 'INFRASTRUCTURE', ImpactedEntity: 'Host web-02.example.local',
    ImpactedEntities: [{ type: 'HOST', name: 'web-02.example.local', entity: 'HOST-1A2B3C' }, { type: 'SERVICE', name: 'checkout', entity: 'SERVICE-9F' }],
    ProblemDetailsText: 'No data from OneAgent for 5 minutes.',
    ProblemURL: 'https://abc12345.live.dynatrace.com/#problems/problemdetails;pid=-7361280981581184312_1788869500000V2',
    Tags: 'env:prod, team:web',
  }

  it('OPEN + AVAILABILITY → firing critical, PID come externalId, risorsa = name del primo impattato (HOST → hostname), entity = resourceExternalId (M2) e fra le etichette', () => {
    expect(normalizePayload('dynatrace', DT, {}, {})).toEqual([{
      externalId: '-7361280981581184312_1788869500000V2', resourceExternalId: 'HOST-1A2B3C', status: 'firing', severity: 'critical', title: 'Host unavailable',
      description: 'No data from OneAgent for 5 minutes.',
      resource: 'web-02.example.local', resourceKind: 'hostname',
      labels: { ProblemImpact: 'INFRASTRUCTURE', ProblemURL: DT.ProblemURL, ProblemID: 'P-2409', Tags: 'env:prod, team:web', dynatrace_entity: 'HOST-1A2B3C' },
    }])
  })

  it('M3 — primo impattato SERVICE/APPLICATION (o senza type) → resourceKind name, entity SERVICE-… come resourceExternalId', () => {
    const svcFirst = normalizePayload('dynatrace', { ...DT, ImpactedEntities: [{ type: 'SERVICE', name: 'checkout', entity: 'SERVICE-9F' }] }, {}, {})[0]!
    expect(svcFirst).toMatchObject({ resource: 'checkout', resourceKind: 'name', resourceExternalId: 'SERVICE-9F', labels: expect.objectContaining({ dynatrace_entity: 'SERVICE-9F' }) })
    expect(normalizePayload('dynatrace', { ...DT, ImpactedEntities: [{ type: 'host', name: 'h', entity: 'HOST-1' }] }, {}, {})[0]!.resourceKind).toBe('hostname')
    const untyped = normalizePayload('dynatrace', { ...DT, ImpactedEntities: [{ name: 'thing' }] }, {}, {})[0]!
    expect(untyped).toMatchObject({ resource: 'thing', resourceKind: 'name' })
    expect(untyped).not.toHaveProperty('resourceExternalId')
  })

  it('A1 — value_mapping traduce State e ProblemSeverity prima della tabella incorporata; default_values.resource quando manca ogni entità', () => {
    const vm = parseValueMapping({ status: { merged: 'resolved' }, severity: { fatal: 'critical', performance: 'critical' } })
    expect(normalizePayload('dynatrace', { ...DT, State: 'MERGED', ProblemSeverity: 'FATAL' }, {}, {}, vm)[0]).toMatchObject({ status: 'resolved', severity: 'critical' })
    expect(normalizePayload('dynatrace', { ...DT, ProblemSeverity: 'PERFORMANCE' }, {}, {}, vm)[0]!.severity).toBe('critical')
    expect(normalizePayload('dynatrace', { ...DT, ImpactedEntities: [], ImpactedEntity: '' }, {}, { resource: 'dynatrace', resourceKind: 'name' })[0]).toMatchObject({ resource: 'dynatrace', resourceKind: 'name' })
  })

  it('RESOLVED → resolved (senza distinguere maiuscole)', () => {
    expect(normalizePayload('dynatrace', { ...DT, State: 'RESOLVED' }, {}, {})[0]!.status).toBe('resolved')
    expect(normalizePayload('dynatrace', { ...DT, State: 'resolved' }, {}, {})[0]!.status).toBe('resolved')
  })

  it.each([
    ['AVAILABILITY', 'critical'], ['ERROR', 'critical'], ['PERFORMANCE', 'warning'], ['RESOURCE_CONTENTION', 'warning'], ['CUSTOM_ALERT', 'warning'], ['MONITORING_UNAVAILABLE', 'info'], ['performance', 'warning'],
  ])('ProblemSeverity %s → %s', (dt, expected) => {
    expect(normalizePayload('dynatrace', { ...DT, ProblemSeverity: dt }, {}, {})[0]!.severity).toBe(expected)
  })

  it('M3 — senza ImpactedEntities (assente o vuoto) → risorsa = ImpactedEntity senza il prefisso di tipo riconosciuto (Host → hostname, Service → name), senza dynatrace_entity; prefisso ignoto → errore', () => {
    for (const entities of [undefined, []]) {
      const out = normalizePayload('dynatrace', { ...DT, ImpactedEntities: entities }, {}, {})
      expect(out[0]).toMatchObject({ resource: 'web-02.example.local', resourceKind: 'hostname' })
      expect(out[0]!.labels).not.toHaveProperty('dynatrace_entity')
      expect(out[0]).not.toHaveProperty('resourceExternalId')
    }
    expect(normalizePayload('dynatrace', { ...DT, ImpactedEntities: [], ImpactedEntity: 'Service checkout' }, {}, {})[0]).toMatchObject({ resource: 'checkout', resourceKind: 'name' })
    expect(normalizePayload('dynatrace', { ...DT, ImpactedEntities: [], ImpactedEntity: 'Process group  nginx' }, {}, {})[0]).toMatchObject({ resource: 'nginx', resourceKind: 'name' })
    expectValidation(() => normalizePayload('dynatrace', { ...DT, ImpactedEntities: [], ImpactedEntity: '3 impacted entities' }, {}, {}), /ImpactedEntity "3 impacted entities" does not start with a known entity type \(Host, Service, Application, Process group, Process, Custom device, Database, Synthetic monitor, Kubernetes cluster, Cloud application\): paste the \{ImpactedEntities\} placeholder/)
    expectValidation(() => normalizePayload('dynatrace', { ...DT, ImpactedEntities: [], ImpactedEntity: 'Host ' }, {}, {}), /ImpactedEntity "Host" does not start with a known entity type/)
  })

  it('senza PID → ProblemID come externalId; senza ProblemDetailsText → nessuna description', () => {
    const out = normalizePayload('dynatrace', { ...DT, PID: '', ProblemDetailsText: undefined }, {}, {})
    expect(out[0]!.externalId).toBe('P-2409')
    expect(out[0]).not.toHaveProperty('description')
  })

  it.each([
    ['senza PID né ProblemID', { ...DT, PID: undefined, ProblemID: undefined }, /PID \(or ProblemID\) is missing or empty/],
    ['senza ProblemTitle', { ...DT, ProblemTitle: '' }, /ProblemTitle is missing or empty/],
    ['State sconosciuto', { ...DT, State: 'MERGED' }, /State must be one of: OPEN, RESOLVED\. Got: "MERGED" \(or map it in value_mapping\.status\)/],
    ['senza State', { ...DT, State: undefined }, /State is missing/],
    ['severità sconosciuta', { ...DT, ProblemSeverity: 'FATAL' }, /ProblemSeverity must be one of: AVAILABILITY, ERROR, PERFORMANCE, RESOURCE_CONTENTION, CUSTOM_ALERT, MONITORING_UNAVAILABLE\. Got: "FATAL" \(or map it in value_mapping\.severity\)/],
    ['senza severità', { ...DT, ProblemSeverity: undefined }, /ProblemSeverity is missing/],
    ['senza risorsa', { ...DT, ImpactedEntities: [], ImpactedEntity: '' }, /ImpactedEntities is empty and ImpactedEntity is missing or empty and default_values\.resource is not set/],
    ['ImpactedEntities stringa (segnaposto tra virgolette)', { ...DT, ImpactedEntities: '{ImpactedEntities}' }, /ImpactedEntities must be a list/],
    ['primo impattato senza name', { ...DT, ImpactedEntities: [{ type: 'HOST', entity: 'HOST-1' }] }, /ImpactedEntities\[0\]\.name is missing or empty/],
    ['payload stringa', 'x', /Dynatrace payload must be a JSON object/],
  ])('%s → ValidationError', (_n, payload, pattern) => {
    expectValidation(() => normalizePayload('dynatrace', payload, {}, {}), pattern)
  })
})

// ── generic: percorsi puntati + value_mapping ────────────────────────────────

describe('getPath / listPayloadKeys', () => {
  const doc = { a: { b: [{ c: 'x' }, { c: 'y' }], n: 0 }, s: 'str', nil: null, empty: {}, list: [] }

  it('getPath risolve oggetti annidati e indici di array; segmento assente → undefined; percorso vuoto → ValidationError', () => {
    expect(getPath(doc, 'a.b.1.c')).toBe('y')
    expect(getPath(doc, 'a.n')).toBe(0)
    expect(getPath(doc, 'a.b.x')).toBeUndefined()
    expect(getPath(doc, 'a.b.5.c')).toBeUndefined()
    expect(getPath(doc, 's.length')).toBeUndefined()   // gli scalari non hanno figli
    expect(getPath(doc, 'nil.x')).toBeUndefined()
    expectValidation(() => getPath(doc, '  ', 'field_mapping.title'), /field_mapping\.title is empty/)
  })

  it('listPayloadKeys elenca le foglie con percorso puntato, array espansi con indice, valori troncati a 60 caratteri', () => {
    const long = 'x'.repeat(80)
    expect(listPayloadKeys({ ...doc, long, num: 12, bool: true })).toEqual([
      { path: 'a.b.0.c', sample: 'x' }, { path: 'a.b.1.c', sample: 'y' }, { path: 'a.n', sample: '0' },
      { path: 's', sample: 'str' }, { path: 'nil', sample: 'null' }, { path: 'empty', sample: '{}' }, { path: 'list', sample: '[]' },
      { path: 'long', sample: `${'x'.repeat(60)}…` }, { path: 'num', sample: '12' }, { path: 'bool', sample: 'true' },
    ])
    expect(listPayloadKeys('scalar')).toEqual([])
  })

  it(`al massimo ${PAYLOAD_KEYS_MAX} chiavi`, () => {
    const big = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    expect(listPayloadKeys(big)).toHaveLength(PAYLOAD_KEYS_MAX)
  })

  it(`I-4 — profondità massima ${PAYLOAD_MAX_DEPTH}: un payload più annidato → ValidationError (non RangeError); al limite passa; getPath rifiuta un percorso più lungo`, () => {
    const nest = (depth: number): unknown => { let v: unknown = 'leaf'; for (let i = 0; i < depth; i++) v = [v]; return v }
    expect(listPayloadKeys(nest(PAYLOAD_MAX_DEPTH))).toEqual([{ path: Array(PAYLOAD_MAX_DEPTH).fill('0').join('.'), sample: 'leaf' }])
    expectValidation(() => listPayloadKeys(nest(PAYLOAD_MAX_DEPTH + 1)), new RegExp(`payload is nested deeper than ${PAYLOAD_MAX_DEPTH} levels`))
    // ~50.000 livelli: prima era "Maximum call stack size exceeded"
    expectValidation(() => listPayloadKeys(JSON.parse('['.repeat(50_000) + ']'.repeat(50_000))), /nested deeper than/)
    expectValidation(() => getPath({ a: 1 }, Array(PAYLOAD_MAX_DEPTH + 1).fill('a').join('.'), 'field_mapping.title'), /field_mapping\.title has 33 segments: at most 32 levels/)
    expect(getPath(nest(PAYLOAD_MAX_DEPTH), Array(PAYLOAD_MAX_DEPTH).fill('0').join('.'))).toBe('leaf')
  })

  it('B1 — getPath legge solo proprietà proprie: constructor.name / toString / __proto__ non ereditati → undefined (campo mancante)', () => {
    expect(getPath({ a: 1 }, 'constructor.name')).toBeUndefined()
    expect(getPath({ a: 1 }, 'toString')).toBeUndefined()
    expect(getPath({ a: { b: 2 } }, 'a.hasOwnProperty')).toBeUndefined()
    // una chiave propria che si chiama come una proprietà del prototipo si legge
    expect(getPath(JSON.parse('{"constructor": {"name": "own"}}'), 'constructor.name')).toBe('own')
    expect(getPath({ a: 1 }, 'a')).toBe(1)
  })

  it('B2 — quoteValue: i valori citati nei messaggi sono JSON troncati a 60 caratteri (finiscono in last_error e nei log)', () => {
    expect(quoteValue('x')).toBe('"x"')
    expect(quoteValue(null)).toBe('null')
    expect(quoteValue(undefined)).toBe('undefined')
    expect(quoteValue({ a: 1 })).toBe('{"a":1}')
    const long = 'y'.repeat(500)
    expect(quoteValue(long)).toBe(`"${'y'.repeat(59)}…`)
    expect(quoteValue(long)).toHaveLength(61)
    // il messaggio di un connettore cita il valore troncato, non i 500 caratteri
    expectValidation(() => normalizePayload('dynatrace', { PID: 'P-1', ProblemTitle: 'T', State: long, ProblemSeverity: 'ERROR', ImpactedEntity: 'Host h' }, {}, {}), /State must be one of: OPEN, RESOLVED\. Got: "y{59}… \(or map it in value_mapping\.status\)$/)
  })
})

describe('normalizePayload — generic (campo normalizzato → percorso puntato)', () => {
  const PAYLOAD = { id: 'EVT-1', state: 'OPEN', msg: 'Disk 97%', alert: { name: 'DiskFull', level: 'Disaster' }, host: { name: 'db-01:9100', ip: '10.0.0.5' }, tags: { env: 'prod' }, alerts: [{ labels: { instance: 'arr-host' } }] }
  const MAPPING  = { title: 'alert.name', severity: 'alert.level', resource: 'host.name', status: 'state', description: 'msg', externalId: 'id', labels: 'tags' }
  const DEFAULTS = { resourceKind: 'hostname' }
  const VALUES   = { severity: { Disaster: 'critical', High: 'critical', Average: 'warning', Information: 'info' }, status: { '1': 'firing', '0': 'resolved', open: 'firing', closed: 'resolved' } }

  it('percorsi annidati, value_mapping senza distinguere maiuscole, resourceKind da default_values, porta tolta per hostname', () => {
    const out = normalizePayload('generic', PAYLOAD, MAPPING, DEFAULTS, parseValueMapping(VALUES))
    expect(out).toEqual([{
      externalId: 'EVT-1', status: 'firing', severity: 'critical', title: 'DiskFull', description: 'Disk 97%',
      resource: 'db-01', resourceKind: 'hostname', labels: { env: 'prod' },
    }])
  })

  it('indici di array nel percorso (alerts.0.labels.instance); resourceKind ip mantiene la stringa; valori già nel vocabolario passano senza mappa', () => {
    // default_values è per campo normalizzato (severity/status), non per percorso
    const out = normalizePayload('generic', PAYLOAD, { ...MAPPING, resource: 'alerts.0.labels.instance', severity: 'missing.sev', status: 'missing.st' }, { resourceKind: 'ip', severity: 'warning', status: 'resolved' }, {})
    expect(out[0]).toMatchObject({ resource: 'arr-host', resourceKind: 'ip' })
    const direct = normalizePayload('generic', { ...PAYLOAD, alert: { name: 'X', level: 'warning' }, state: 'resolved', host: { name: 'h' } }, MAPPING, DEFAULTS, {})
    expect(direct[0]).toMatchObject({ severity: 'warning', status: 'resolved' })
  })

  it('campo non mappato → chiave omonima alla radice; default_values riempie solo i campi assenti; status assente → firing', () => {
    const out = normalizePayload('generic', { title: 'T', severity: 'info', resource: 'r' }, {}, { resourceKind: 'name', description: 'from defaults', severity: 'critical' }, {})
    expect(out[0]).toEqual({ title: 'T', severity: 'info', status: 'firing', resource: 'r', resourceKind: 'name', description: 'from defaults', labels: {} })
  })

  it.each([
    ['severity non mappata e fuori vocabolario', { ...PAYLOAD, alert: { name: 'X', level: 'Purple' } }, MAPPING, DEFAULTS, /severity value "Purple" is not mapped \(value_mapping\.severity\) and is not one of: info, warning, critical/],
    ['status non mappato', { ...PAYLOAD, state: 'ACK' }, MAPPING, DEFAULTS, /status value "ACK" is not mapped \(value_mapping\.status\)/],
    ['title assente al percorso', { ...PAYLOAD, alert: { level: 'High' } }, MAPPING, DEFAULTS, /title \(field_mapping\.title = "alert\.name", no default_values\.title\) is missing or empty/],
    ['resource assente', { ...PAYLOAD, host: {} }, MAPPING, DEFAULTS, /resource \(field_mapping\.resource = "host\.name"/],
    ['severity assente senza default', { ...PAYLOAD, alert: { name: 'X' } }, MAPPING, DEFAULTS, /severity \(field_mapping\.severity = "alert\.level", no default_values\.severity\) is missing/],
    ['resourceKind mancante (né mappato né in default_values)', PAYLOAD, MAPPING, {}, /resourceKind is missing: set default_values\.resourceKind/],
    ['resourceKind fuori enum', PAYLOAD, MAPPING, { resourceKind: 'mac' }, /resourceKind must be one of: hostname, ip, fqdn, external_id, name/],
    ['labels numero', { ...PAYLOAD, tags: 3 }, MAPPING, DEFAULTS, /labels must be a list of "key:value" strings, a comma-separated string or an object/],
    ['chiave di field_mapping sconosciuta', PAYLOAD, { ...MAPPING, summary: 'msg' }, DEFAULTS, /field_mapping\.summary is not a normalized field \(allowed: title, severity, status, resource, resourceKind, resourceExternalId, externalId, description, labels, startsAt, endsAt\)/],
    ['percorso vuoto', PAYLOAD, { ...MAPPING, title: ' ' }, DEFAULTS, /field_mapping\.title must be a non-empty dotted path/],
    ['payload lista', [PAYLOAD], MAPPING, DEFAULTS, /must be a JSON object/],
  ])('%s → ValidationError', (_n, payload, mapping, defaults, pattern) => {
    expectValidation(() => normalizePayload('generic', payload, mapping as never, defaults, parseValueMapping(VALUES)), pattern)
  })

  it('B6 — labels del generic: oggetto, lista ["k:v"] (senza ":" → true) o stringa CSV; M2 — resourceExternalId da field_mapping', () => {
    const base = { title: 'T', severity: 'info', resource: 'r' }
    expect(normalizePayload('generic', { ...base, labels: ['env:prod', 'monitor', ' team:ops '] }, {}, { resourceKind: 'name' })[0]!.labels).toEqual({ env: 'prod', monitor: 'true', team: 'ops' })
    expect(normalizePayload('generic', { ...base, labels: 'env:prod, team:ops' }, {}, { resourceKind: 'name' })[0]!.labels).toEqual({ env: 'prod', team: 'ops' })
    expect(normalizePayload('generic', { ...base, labels: { env: 'prod', n: 2 } }, {}, { resourceKind: 'name' })[0]!.labels).toEqual({ env: 'prod', n: '2' })
    const out = normalizePayload('generic', { ...base, host: { id: 'HOST-42' } }, { resourceExternalId: 'host.id' }, { resourceKind: 'name' })[0]!
    expect(out.resourceExternalId).toBe('HOST-42')
    expect(out).not.toHaveProperty('externalId')
  })

  it('A1 — validatePresetDefaults (sourceConfigOf dei preset): chiavi ignote, resource senza resourceKind, resourceKind fuori enum, resourceFrom fuori opzioni → ValidationError; config valida accettata', () => {
    const cfg = (kind: string, defaults: Record<string, unknown>) => sourceConfigOf({ connector_kind: kind, default_values: JSON.stringify(defaults) })
    expect(cfg('alertmanager', { severity: 'warning', resource: 'prom', resourceKind: 'name' }).defaults).toEqual({ severity: 'warning', resource: 'prom', resourceKind: 'name' })
    expect(cfg('datadog', { resourceFrom: 'alert_scope' }).defaults).toEqual({ resourceFrom: 'alert_scope' })
    expectValidation(() => cfg('alertmanager', { title: 'x' }), /default_values\.title is not supported by the alertmanager connector \(allowed: severity, resource, resourceKind, resourceFrom\)/)
    expectValidation(() => cfg('zabbix', { resource: 'x' }), /default_values\.resourceKind is required with default_values\.resource/)
    expectValidation(() => cfg('zabbix', { resource: '' , resourceKind: 'name' }), /default_values\.resource must be a non-empty string/)
    expectValidation(() => cfg('zabbix', { resourceKind: 'planet' }), /default_values\.resourceKind must be one of: hostname, ip, fqdn, external_id, name/)
    expectValidation(() => cfg('zabbix', { severity: '' }), /default_values\.severity must be a non-empty string/)
    expectValidation(() => cfg('zabbix', { resourceFrom: 'alert_scope' }), /default_values\.resourceFrom is not supported by the zabbix connector/)
    expectValidation(() => cfg('datadog', { resourceFrom: 'tags' }), /default_values\.resourceFrom for datadog must be one of: alert_scope\. Got: "tags"/)
    // il generic non passa da qui: i suoi default sono i campi normalizzati
    expect(sourceConfigOf({ connector_kind: 'generic', default_values: JSON.stringify({ title: 'x', resourceKind: 'name' }) }).defaults).toEqual({ title: 'x', resourceKind: 'name' })
  })

  it('parseValueMapping: campo non supportato, tabella non oggetto, destinazione fuori vocabolario → ValidationError', () => {
    expectValidation(() => parseValueMapping({ title: { a: 'b' } }), /value_mapping\.title is not supported \(allowed: severity, status\)/)
    expectValidation(() => parseValueMapping({ severity: 'high' }), /value_mapping\.severity must be an object/)
    expectValidation(() => parseValueMapping({ severity: { Disaster: 'fatal' } }), /value_mapping\.severity\.Disaster must be one of: info, warning, critical\. Got: "fatal"/)
    expectValidation(() => parseValueMapping({ status: { '1': 'open' } }), /value_mapping\.status\.1 must be one of: firing, resolved/)
    expect(parseValueMapping(null)).toEqual({})
  })

  it('sourceConfigOf: legge i JSON del webhook (assenti → {}), connector_kind assente → generic, corrotto/sconosciuto → ValidationError', () => {
    const cfg = sourceConfigOf({ connector_kind: null, field_mapping: JSON.stringify(MAPPING), default_values: JSON.stringify(DEFAULTS), value_mapping: JSON.stringify(VALUES) })
    expect(cfg.connectorKind).toBe('generic')
    expect(cfg.valueMapping.severity).toMatchObject({ disaster: 'critical' })
    expect(normalizeWithConfig(cfg, PAYLOAD)[0]).toMatchObject({ title: 'DiskFull', severity: 'critical' })
    expect(sourceConfigOf({ connector_kind: 'zabbix' })).toEqual({ connectorKind: 'zabbix', fieldMapping: {}, defaults: {}, valueMapping: {} })
    expectValidation(() => sourceConfigOf({ connector_kind: 'nagios' }), /connector_kind must be one of: generic, alertmanager, grafana, zabbix, datadog, dynatrace/)
    expectValidation(() => sourceConfigOf({ connector_kind: 'generic', field_mapping: '{nope' }), /Corrupt field_mapping JSON/)
    expectValidation(() => sourceConfigOf({ connector_kind: 'generic', value_mapping: '[]' }), /value_mapping must be a JSON object/)
    expectValidation(() => sourceConfigOf({ connector_kind: 'generic', field_mapping: JSON.stringify({ foo: 'bar' }) }), /field_mapping\.foo is not a normalized field/)
  })

  it('connector_kind sconosciuto → ValidationError', () => {
    expectValidation(() => normalizePayload('nagios' as never, {}, {}, {}), /Unknown connector_kind "nagios"/)
    expectValidation(() => svc.assertConnectorKind('nagios'), /connector_kind must be one of: generic, alertmanager, grafana, zabbix, datadog, dynatrace/)
  })
})

// ── fingerprintOf ────────────────────────────────────────────────────────────

describe('fingerprintOf', () => {
  const base = { title: 'DiskFull', resource: 'db-01', labels: { b: '2', a: '1' } }

  it('è stabile, esadecimale sha256, e non dipende dall\'ordine delle etichette', () => {
    const a = fingerprintOf('src-1', base)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintOf('src-1', { ...base, labels: { a: '1', b: '2' } })).toBe(a)
  })

  it('non include mai la description', () => {
    expect(fingerprintOf('src-1', { ...base, description: 'x' } as never)).toBe(fingerprintOf('src-1', { ...base, description: 'y' } as never))
  })

  it('cambia con sorgente, titolo, risorsa o etichette', () => {
    const a = fingerprintOf('src-1', base)
    expect(fingerprintOf('src-2', base)).not.toBe(a)
    expect(fingerprintOf('src-1', { ...base, title: 'Other' })).not.toBe(a)
    expect(fingerprintOf('src-1', { ...base, resource: 'db-02' })).not.toBe(a)
    expect(fingerprintOf('src-1', { ...base, labels: { a: '1' } })).not.toBe(a)
  })

  it('con externalId conta solo (sourceId, externalId)', () => {
    const a = fingerprintOf('src-1', { ...base, externalId: 'E1' })
    expect(fingerprintOf('src-1', { title: 'Different', resource: 'x', labels: {}, externalId: 'E1' })).toBe(a)
    expect(fingerprintOf('src-1', { ...base, externalId: 'E2' })).not.toBe(a)
    expect(fingerprintOf('src-2', { ...base, externalId: 'E1' })).not.toBe(a)
    expect(a).not.toBe(fingerprintOf('src-1', base))
  })
})

// ── nextEventState / tabella di transizione ──────────────────────────────────

describe('nextEventState', () => {
  const ev = { status: 'firing', severity: 'warning', title: 'T', resource: 'r', resourceKind: 'name', labels: {} } as const
  const existing = { status: 'firing', severity: 'info', max_severity: 'info', count: 3, first_seen_at: 'T0', resolved_at: null, transitions: ['T-1'], last_payload_status: 'firing', correlation: 'attached' }

  it('firing su evento aperto → count+1, severità = quella del payload, max_severity = la più alta, first_seen invariato, status invariato, nessun passaggio registrato, nessun residuo azzerato', () => {
    expect(nextEventState(existing, ev, 'NOW')).toEqual({ status: 'firing', severity: 'warning', max_severity: 'warning', count: 4, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: null, transitions: ['T-1'], last_payload_status: 'firing', correlation: 'attached', clear: 'none' })
    expect(nextEventState({ ...existing, severity: 'critical', max_severity: 'critical' }, ev, 'NOW')).toMatchObject({ severity: 'warning', max_severity: 'critical' })
    expect(nextEventState({ ...existing, status: 'suppressed' }, ev, 'NOW').status).toBe('suppressed')
  })

  it('M9 — la severità è quella dell\'ULTIMO payload (può scendere: la salute del CI segue la sorgente); la storia resta in max_severity; un nuovo ciclo riparte da quella del payload; evento senza max_severity → parte dalla corrente', () => {
    expect(nextEventState({ ...existing, severity: 'critical', max_severity: 'critical' }, { ...ev, severity: 'info' }, 'NOW')).toMatchObject({ severity: 'info', max_severity: 'critical', count: 4 })
    expect(nextEventState({ ...existing, status: 'flapping', severity: 'critical', max_severity: 'critical' }, { ...ev, severity: 'info' }, 'NOW')).toMatchObject({ severity: 'info', max_severity: 'critical' })
    expect(nextEventState({ ...existing, status: 'resolved', severity: 'critical', max_severity: 'critical', last_payload_status: 'resolved' }, { ...ev, severity: 'info' }, 'NOW')).toMatchObject({ severity: 'info', max_severity: 'info', count: 1, status: 'firing' })
    // pre-M9: max_severity assente → la storia nota è la corrente
    const legacy = { ...existing, severity: 'critical', max_severity: undefined }
    expect(nextEventState(legacy, { ...ev, severity: 'info' }, 'NOW')).toMatchObject({ severity: 'info', max_severity: 'critical' })
    expect(nextEventState({ ...legacy, status: 'resolved', last_payload_status: 'resolved' }, { ...ev, status: 'resolved' }, 'NOW')).toMatchObject({ severity: 'critical', max_severity: 'critical' })
  })

  it('firing su evento risolto → nuovo ciclo: count 1, first_seen = ora, severità del payload, resolved_at null, passaggio appeso, residui del nuovo ciclo azzerati (M10: correlation → none)', () => {
    expect(nextEventState({ ...existing, status: 'resolved', severity: 'critical', max_severity: 'critical', resolved_at: 'T1', last_payload_status: 'resolved', correlation: 'attached' }, ev, 'NOW'))
      .toEqual({ status: 'firing', severity: 'warning', max_severity: 'warning', count: 1, first_seen_at: 'NOW', last_seen_at: 'NOW', resolved_at: null, transitions: ['T-1', 'NOW'], last_payload_status: 'firing', correlation: 'none', clear: 'new_cycle' })
  })

  it('resolved su evento aperto → status resolved, resolved_at = ora, count e severità invariati, passaggio appeso, residui (soppressione/sfarfallio/ritardo) azzerati, correlation invariata', () => {
    expect(nextEventState(existing, { ...ev, status: 'resolved' }, 'NOW'))
      .toEqual({ status: 'resolved', severity: 'info', max_severity: 'info', count: 3, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: 'NOW', transitions: ['T-1', 'NOW'], last_payload_status: 'resolved', correlation: 'attached', clear: 'resolved' })
    expect(nextEventState({ ...existing, status: 'suppressed' }, { ...ev, status: 'resolved' }, 'NOW')).toMatchObject({ status: 'resolved', clear: 'resolved' })
  })

  it('resolved su evento già risolto → tutto invariato (anche resolved_at: resta il primo rientro), solo last_seen e ultimo payload', () => {
    const resolved = { ...existing, status: 'resolved', resolved_at: 'T1', last_payload_status: 'resolved' }
    expect(nextEventState(resolved, { ...ev, status: 'resolved' }, 'NOW'))
      .toEqual({ status: 'resolved', severity: 'info', max_severity: 'info', count: 3, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: 'T1', transitions: ['T-1'], last_payload_status: 'resolved', correlation: 'attached', clear: 'none' })
  })

  it('ondata 4 — evento flapping: lo stato NON cambia con firing né con resolved; si aggiornano lista, ultimo payload, last_seen, count/resolved_at', () => {
    const flapping = { ...existing, status: 'flapping', severity: 'warning', max_severity: 'warning', transitions: ['T-2', 'T-1'], last_payload_status: 'firing', correlation: 'flapping' }
    expect(nextEventState(flapping, { ...ev, status: 'resolved' }, 'NOW'))
      .toEqual({ status: 'flapping', severity: 'warning', max_severity: 'warning', count: 3, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: 'NOW', transitions: ['T-2', 'T-1', 'NOW'], last_payload_status: 'resolved', correlation: 'flapping', clear: 'none' })
    expect(nextEventState({ ...flapping, last_payload_status: 'resolved', resolved_at: 'T1' }, { ...ev, severity: 'critical' }, 'NOW'))
      .toEqual({ status: 'flapping', severity: 'critical', max_severity: 'critical', count: 4, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: null, transitions: ['T-2', 'T-1', 'NOW'], last_payload_status: 'firing', correlation: 'flapping', clear: 'none' })
    // ripetizione dello stesso stato durante lo sfarfallio: nessun passaggio
    expect(nextEventState(flapping, ev, 'NOW').transitions).toEqual(['T-2', 'T-1'])
  })

  it('ondata 4 — eventi pre-migrazione senza last_payload_status/transitions: lo stato del payload si deduce dallo status, la lista parte vuota', () => {
    const legacy = { status: 'firing', severity: 'info', count: 1, first_seen_at: 'T0', resolved_at: null }
    expect(payloadStatusOf(legacy)).toBe('firing')
    expect(payloadStatusOf({ ...legacy, status: 'suppressed' })).toBe('firing')
    expect(payloadStatusOf({ ...legacy, status: 'resolved' })).toBe('resolved')
    expect(payloadStatusOf({ ...legacy, status: 'resolved', last_payload_status: 'firing' })).toBe('firing')
    expect(transitionsOf(legacy)).toEqual([])
    expect(transitionsOf({ transitions: ['a', 3, null, 'b'] })).toEqual(['a', 'b'])
    expect(nextEventState(legacy, { ...ev, status: 'resolved' }, 'NOW')).toMatchObject({ status: 'resolved', transitions: ['NOW'], last_payload_status: 'resolved' })
    expect(nextEventState(legacy, ev, 'NOW')).toMatchObject({ status: 'firing', transitions: [], last_payload_status: 'firing' })
  })

  it(`ondata 4 — la lista dei passaggi tiene gli ultimi ${MAX_TRANSITIONS}`, () => {
    const many = Array.from({ length: MAX_TRANSITIONS }, (_, i) => `T${i}`)
    const out = nextEventState({ ...existing, transitions: many }, { ...ev, status: 'resolved' }, 'NOW')
    expect(out.transitions).toHaveLength(MAX_TRANSITIONS)
    expect(out.transitions[0]).toBe('T1')
    expect(out.transitions[MAX_TRANSITIONS - 1]).toBe('NOW')
  })

  it('countTransitionsSince conta i passaggi dall\'istante dato (incluso)', () => {
    const t = ['2026-09-09T09:50:00.000Z', '2026-09-09T09:55:00.000Z', '2026-09-09T10:00:00.000Z']
    expect(countTransitionsSince(t, Date.parse('2026-09-09T09:55:00.000Z'))).toBe(2)
    expect(countTransitionsSince(t, Date.parse('2026-09-09T10:00:01.000Z'))).toBe(0)
    expect(countTransitionsSince([], 0)).toBe(0)
  })
})

describe('EVENT_TRANSITIONS — tabella condivisa fra funzione pura e CASE Cypher', () => {
  const ev = { status: 'firing', severity: 'warning', title: 'T', resource: 'r', resourceKind: 'name', labels: {} } as const

  it('è esaustiva: 3 classi di stato corrente × 2 stati del payload, ognuna una volta; prevClassOf mappa firing/suppressed/altro su open', () => {
    expect(EVENT_TRANSITIONS).toHaveLength(6)
    const keys = EVENT_TRANSITIONS.map((r) => `${r.prev}×${r.payload}`).sort()
    expect(keys).toEqual(['flapping×firing', 'flapping×resolved', 'open×firing', 'open×resolved', 'resolved×firing', 'resolved×resolved'])
    expect(prevClassOf('resolved')).toBe('resolved'); expect(prevClassOf('flapping')).toBe('flapping')
    expect(prevClassOf('firing')).toBe('open'); expect(prevClassOf('suppressed')).toBe('open'); expect(prevClassOf(undefined)).toBe('open')
    expect(() => transitionRuleFor('open', 'boh' as never)).toThrow(/No event transition rule for open × boh/)
  })

  // Tabella attesa (documentata nel commento di EVENT_TRANSITIONS): la funzione
  // pura deve produrla dalle regole, il CASE Cypher deve avere un ramo per riga
  // con l'espressione dell'azione corrispondente.
  const TABLE: Array<[prev: string, payload: 'firing' | 'resolved', exp: Record<string, unknown>]> = [
    ['resolved', 'firing',   { status: 'firing',   count: 1, severity: 'warning',  max_severity: 'warning',  first_seen_at: 'NOW', resolved_at: null,  correlation: 'none',     clear: 'new_cycle' }],
    ['resolved', 'resolved', { status: 'resolved', count: 3, severity: 'critical', max_severity: 'critical', first_seen_at: 'T0',  resolved_at: 'T1',  correlation: 'attached', clear: 'none' }],
    ['firing',   'firing',   { status: 'firing',   count: 4, severity: 'warning',  max_severity: 'critical', first_seen_at: 'T0',  resolved_at: 'T1',  correlation: 'attached', clear: 'none' }],
    ['firing',   'resolved', { status: 'resolved', count: 3, severity: 'critical', max_severity: 'critical', first_seen_at: 'T0',  resolved_at: 'NOW', correlation: 'attached', clear: 'resolved' }],
    ['flapping', 'firing',   { status: 'flapping', count: 4, severity: 'warning',  max_severity: 'critical', first_seen_at: 'T0',  resolved_at: null,  correlation: 'attached', clear: 'none' }],
    ['flapping', 'resolved', { status: 'flapping', count: 3, severity: 'critical', max_severity: 'critical', first_seen_at: 'T0',  resolved_at: 'NOW', correlation: 'attached', clear: 'none' }],
  ]

  it.each(TABLE)('funzione pura — %s × %s', (prev, payload, exp) => {
    const existing = { status: prev, severity: 'critical', max_severity: 'critical', count: 3, first_seen_at: 'T0', resolved_at: 'T1', transitions: [], last_payload_status: prev === 'resolved' ? 'resolved' : 'firing', correlation: 'attached' }
    expect(nextEventState(existing, { ...ev, status: payload }, 'NOW')).toMatchObject(exp)
  })

  it.each(TABLE)('CASE Cypher — %s × %s: un ramo WHEN per riga con le espressioni della regola', (prev, payload, exp) => {
    const rule = transitionRuleFor(prevClassOf(prev), payload)
    const a = TRANSITION_ACTION_CYPHER
    const branch = (value: string) => `WHEN ${PREV_CLASS_CYPHER[rule.prev]} AND $status = '${payload}' THEN ${value}`
    const set = transitionSetCypher()
    expect(set).toContain(`e.status = ${transitionCaseCypher((r) => a.status[r.status])}`)
    expect(transitionCaseCypher((r) => a.status[r.status])).toContain(branch(exp['status'] === prev ? 'e.status' : `'${exp['status']}'`))
    expect(transitionCaseCypher((r) => a.count[r.count])).toContain(branch(exp['count'] === 1 ? '1' : exp['count'] === 4 ? 'coalesce(e.count, 0) + 1' : 'e.count'))
    // M9: la severità corrente è quella del payload a ogni firing (mai "max"); la storia in max_severity
    expect(rule.severity).toBe(exp['severity'] === 'warning' ? 'payload' : 'keep')
    expect(transitionCaseCypher((r) => a.severity[r.severity])).toContain(branch(rule.severity === 'payload' ? '$severity' : rule.severity === 'max' ? SEVERITY_MAX_CYPHER : 'e.severity'))
    expect(transitionCaseCypher((r) => a.maxSeverity[r.maxSeverity])).toContain(branch(rule.maxSeverity === 'payload' ? '$severity' : rule.maxSeverity === 'max' ? svc.MAX_SEVERITY_MAX_CYPHER : 'coalesce(e.max_severity, e.severity)'))
    expect(transitionCaseCypher((r) => a.firstSeen[r.firstSeen])).toContain(branch(exp['first_seen_at'] === 'NOW' ? '$now' : 'coalesce(e.first_seen_at, $now)'))
    expect(transitionCaseCypher((r) => a.resolvedAt[r.resolvedAt])).toContain(branch(exp['resolved_at'] === 'NOW' ? '$now' : exp['resolved_at'] === null ? 'null' : 'e.resolved_at'))
    // residui (M10): suppressed_by_change_id solo al passaggio a resolved; correlation_due_at e flapping_since anche al nuovo ciclo; correlation → none e correlation_at → null al nuovo ciclo
    const clearsResolved = exp['clear'] === 'resolved'
    const newCycle = exp['clear'] === 'new_cycle'
    const clearsFlap = clearsResolved || newCycle
    expect(residueClearCypher('suppressed_by_change_id', ['resolved'])).toContain(branch(clearsResolved ? 'null' : 'e.suppressed_by_change_id'))
    expect(residueClearCypher('correlation_due_at', ['resolved', 'new_cycle'])).toContain(branch(clearsFlap ? 'null' : 'e.correlation_due_at'))
    expect(residueClearCypher('flapping_since', ['resolved', 'new_cycle'])).toContain(branch(clearsFlap ? 'null' : 'e.flapping_since'))
    expect(set).toContain(`e.correlation = ${transitionCaseCypher((r) => (r.clear === 'new_cycle' ? "'none'" : 'e.correlation'))}`)
    expect(transitionCaseCypher((r) => (r.clear === 'new_cycle' ? "'none'" : 'e.correlation'))).toContain(branch(newCycle ? "'none'" : 'e.correlation'))
    expect(set).toContain(`e.correlation_at = ${residueClearCypher('correlation_at', ['new_cycle'])}`)
    expect(set).toContain(`e.correlation_due_at = ${residueClearCypher('correlation_due_at', ['resolved', 'new_cycle'])}`)
  })

  it('SEVERITY_MAX_CYPHER confronta i rank ($severityRank) e tiene la corrente a parità; MAX_SEVERITY_MAX_CYPHER parte da max_severity (o dalla corrente se assente); la classe open è "non resolved e non flapping"', () => {
    expect(SEVERITY_MAX_CYPHER).toBe('CASE WHEN coalesce($severityRank[$severity], -1) > coalesce($severityRank[e.severity], -1) THEN $severity ELSE e.severity END')
    expect(svc.MAX_SEVERITY_MAX_CYPHER).toBe('CASE WHEN coalesce($severityRank[$severity], -1) > coalesce($severityRank[coalesce(e.max_severity, e.severity)], -1) THEN $severity ELSE coalesce(e.max_severity, e.severity) END')
    expect(PREV_CLASS_CYPHER).toEqual({ resolved: "e.status = 'resolved'", flapping: "e.status = 'flapping'", open: "NOT e.status IN ['resolved', 'flapping']" })
    // nessun ELSE: uno status fuori vocabolario non deve produrre null in silenzio (lo blocca ingestEvent prima)
    expect(transitionCaseCypher(() => '1')).not.toMatch(/ELSE/)
    expect(transitionCaseCypher(() => '1').match(/WHEN /g)).toHaveLength(6)
  })

  it('transitionSetCypher: ogni espressione legge i valori pre-scrittura, quindi status e last_payload_status sono assegnati DOPO count/severity/resolved_at/transitions; transitions appende $now solo a payload diverso dall\'ultimo e tiene gli ultimi 50; last_received_at scritto', () => {
    const set = transitionSetCypher()
    const at = (frag: string) => { const i = set.indexOf(frag); expect(i, frag).toBeGreaterThanOrEqual(0); return i }
    const status = at('e.status = CASE')
    for (const before of ['e.count = CASE', 'e.max_severity = CASE', 'e.severity = CASE', 'e.first_seen_at = CASE', 'e.resolved_at = CASE', 'e.suppressed_by_change_id = CASE', 'e.correlation_due_at = CASE', 'e.flapping_since = CASE', 'e.correlation = CASE', 'e.correlation_at = CASE', 'e.transitions = CASE', 'e.last_payload_status = $status']) {
      expect(at(before), before).toBeLessThan(status)
    }
    // M9: max_severity legge e.severity pre-scrittura (eventi senza max_severity) → assegnata PRIMA di severity
    expect(at('e.max_severity = CASE')).toBeLessThan(at('e.severity = CASE'))
    expect(at('e.last_payload_status = $status')).toBeGreaterThan(at('e.transitions = CASE'))
    expect(set).toContain('e.resource_external_id = coalesce($resourceExternalId, e.resource_external_id)')
    expect(set).toContain(`e.transitions = CASE WHEN $status <> coalesce(e.last_payload_status, CASE WHEN e.status = 'resolved' THEN 'resolved' ELSE 'firing' END) THEN (coalesce(e.transitions, []) + $now)[-${MAX_TRANSITIONS}..] ELSE coalesce(e.transitions, []) END`)
    expect(set).toContain('e.last_seen_at = $now')
    // B2-06: la guardia d'ordine non torna indietro su un payload fuori ordine
    expect(set).toContain("e.last_received_at = CASE WHEN outcome = 'out_of_order' THEN e.last_received_at ELSE $receivedAt END")
    expect(set).toContain('e.starts_at = coalesce($startsAt, e.starts_at)')
  })

  it('ingestMergeCypher: un solo MERGE su (tenant_id, fingerprint) con ON CREATE completo, guardia d\'ordine created/applied/duplicate/out_of_order, SET se applied o fuori ordine, FROM_SOURCE solo se created, riconoscimento e aggancio del CI nello stesso statement (M11)', () => {
    const q = ingestMergeCypher()
    expect(q.match(/MERGE \(e:Event/g)).toHaveLength(1)
    expect(q).toContain('MERGE (e:Event {tenant_id: $tenantId, fingerprint: $fingerprint})')
    expect(q).toContain('e.id = $id, e.external_id = $externalId, e.resource_external_id = $resourceExternalId')
    expect(q).toContain('e.status = $status, e.severity = $severity, e.max_severity = $severity')
    // B5: first_seen_at dal parametro (starts_at della sorgente per un resolved mai visto, altrimenti $now: lo decide ingest.ts)
    expect(q).toContain('e.count = 1, e.first_seen_at = $firstSeenAt, e.last_seen_at = $now, e.last_received_at = $receivedAt')
    expect(q).toContain("e.resolved_at = CASE WHEN $status = 'resolved' THEN $now ELSE null END")
    expect(q).toContain("e.correlation = 'none', e.correlation_at = null, e.correlation_due_at = null, e.suppressed_by_change_id = null")
    expect(q).toContain('e.transitions = [], e.last_payload_status = $status, e.flapping_since = null')
    expect(q).toContain('e.source_id = $sourceId, e.created_at = $now, e.updated_at = $now')
    expect(q).toContain("WHEN e.id = $id THEN 'created'")
    expect(q).toContain("WHEN e.last_received_at IS NULL OR datetime(e.last_received_at) < datetime($receivedAt) THEN 'applied'")
    expect(q).toContain("WHEN e.last_received_at = $receivedAt THEN 'duplicate'")
    // B2-06: un payload vecchio con lo STESSO stato dell'ultimo applicato è innocuo (duplicate); con uno stato diverso viene APPLICATO (out_of_order)
    expect(q).toContain(`WHEN $status = ${LAST_PAYLOAD_STATUS_CYPHER} THEN 'duplicate'`)
    expect(q).toContain("ELSE 'out_of_order' END AS outcome")
    expect(q).toContain(`FOREACH (_ IN CASE WHEN ${APPLIED_OUTCOME_CYPHER} THEN [1] ELSE [] END |`)
    expect(q).toContain(transitionSetCypher())
    expect(q).toContain('OPTIONAL MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})')
    expect(q).toContain("FOREACH (_ IN CASE WHEN outcome = 'created' AND w IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:FROM_SOURCE]->(w))")
    // CI: quello già agganciato vince; altrimenti alias/nome (solo se non agganciato e non stale), poi RAISED_ON
    expect(q).toContain('OPTIONAL MATCH (e)-[:RAISED_ON]->(linked:ConfigurationItem {tenant_id: $tenantId})')
    expect(CI_MATCH_GUARD).toBe('linked IS NULL')
    expect(q).toContain(ciMatchCypher({ guard: CI_MATCH_GUARD, carry: ['e', 'outcome', 'w', 'linked'] }))
    expect(q).not.toMatch(/LIMIT 1/)
    expect(q).toContain('coalesce(linked, matched) AS ci')
    // A2: match_reason scritto ogni volta che il riconoscimento gira; RAISED_ON solo con UN CI riconosciuto (mai su ambiguous)
    expect(q).toContain(`FOREACH (_ IN CASE WHEN ${CI_MATCH_GUARD} THEN [1] ELSE [] END | SET e.match_reason = matchReason)`)
    expect(q).toContain('FOREACH (_ IN CASE WHEN linked IS NULL AND matched IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:RAISED_ON]->(matched))')
    expect(q).toContain('RETURN properties(e) AS props, outcome, ci.id AS ciId,')
    expect(q).toContain(`CASE WHEN ${CI_MATCH_GUARD} THEN matchReason ELSE null END AS matchReason`)
    expect(q).toContain(`CASE WHEN ${CI_MATCH_GUARD} THEN candidates ELSE [] END AS candidates`)
    expect(q).toContain('w.connector_kind AS connectorKind, w.last_error IS NOT NULL AS sourceHasError')
    expect(INGEST_WRITE_OUTCOMES).toEqual(['created', 'applied', 'duplicate', 'out_of_order'])
  })

  it('cronologia dell\'allarme nello STESSO statement (history.ts): kind dal CASE sui valori PRE-scrittura (first_seen / cycle_firing / cycle_resolved / severity_changed / null), at = $firstSeenAt per la first_seen, nota = severità precedente, severità del payload; niente per ripetizioni e duplicate', () => {
    const q = ingestMergeCypher()
    // il CASE legge e.status / e.last_payload_status / e.severity prima del SET (sta prima del FOREACH applied) e la severità precedente viaggia per la nota
    expect(q).toContain(`WITH e, outcome, ${INGEST_HISTORY_KIND_CYPHER} AS historyKind, e.severity AS previousSeverity`)
    expect(q.indexOf('AS historyKind')).toBeLessThan(q.indexOf(`FOREACH (_ IN CASE WHEN ${APPLIED_OUTCOME_CYPHER} THEN [1] ELSE [] END |`))
    expect(INGEST_HISTORY_KIND_CYPHER).toContain("WHEN outcome = 'created' THEN 'first_seen'")
    // stessa regola dei passaggi (transitions): stato del payload diverso dall'ultimo applicato
    expect(INGEST_HISTORY_KIND_CYPHER).toContain(`WHEN ${APPLIED_OUTCOME_CYPHER} AND $status <> ${LAST_PAYLOAD_STATUS_CYPHER} THEN CASE WHEN $status = 'firing' THEN 'cycle_firing' ELSE 'cycle_resolved' END`)
    expect(LAST_PAYLOAD_STATUS_CYPHER).toBe("coalesce(e.last_payload_status, CASE WHEN e.status = 'resolved' THEN 'resolved' ELSE 'firing' END)")
    expect(transitionSetCypher()).toContain(`e.transitions = CASE WHEN $status <> ${LAST_PAYLOAD_STATUS_CYPHER} THEN (coalesce(e.transitions, []) + $now)[-${MAX_TRANSITIONS}..]`)
    expect(INGEST_HISTORY_KIND_CYPHER).toContain(`WHEN ${APPLIED_OUTCOME_CYPHER} AND $status = 'firing' AND $severity <> e.severity THEN 'severity_changed'`)
    expect(INGEST_HISTORY_KIND_CYPHER).toMatch(/ELSE null END$/)   // duplicate/ripetizione: nessuna voce
    // il frammento condiviso, con i campi calcolati: CREATE dentro il FOREACH su historyKind, poi il cap
    const fragment = historyWriteCypher({
      when: 'historyKind IS NOT NULL', imports: ['historyKind'],
      fields: { id: '$historyId', kind: 'historyKind', at: "CASE WHEN historyKind = 'first_seen' THEN $firstSeenAt ELSE $now END", outcome: 'null', actorId: "'monitoring'", incidentId: 'null', changeId: 'null', ciId: 'null', note: "CASE WHEN historyKind = 'severity_changed' THEN previousSeverity ELSE null END", severity: '$severity' },
    })
    expect(q).toContain(fragment)
    expect(q).toContain('FOREACH (_ IN CASE WHEN historyKind IS NOT NULL THEN [1] ELSE [] END |')
    expect(q).toContain('CREATE (e)-[:HAS_HISTORY]->(:EventHistoryEntry {id: $historyId, tenant_id: $tenantId, event_id: e.id')
    expect(q).toMatch(/WHERE old\.kind <> 'first_seen'\s+WITH old ORDER BY old\.at DESC, old\.id DESC\s+SKIP 199\s+DETACH DELETE old\s+\}\s+WITH e, outcome\s+OPTIONAL MATCH \(w:InboundWebhook/)
    expect(q.match(/HAS_HISTORY/g)).toHaveLength(2)   // la CREATE e il cap, una volta sola
  })

  it('ciMatchCypher (A2/M2): alias external_id SOLO con $resourceExternalId (mai l\'id dell\'allarme), alias per kind, name_key indicizzato con collect (ambiguità esplicita), nome corto/FQDN solo con $matchShortHostname e senza nome esatto; precedenza alias_external_id → alias → name → name_short → none; candidati al massimo 5', () => {
    const q = ciMatchCypher()
    expect(q).toContain("OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: 'external_id', value: $resourceExternalId})-[:ALIAS_OF]->(byExt:ConfigurationItem {tenant_id: $tenantId})")
    expect(q).not.toMatch(/\$externalId\b/)
    expect(q).toContain('OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: $kind, value: $kindValue})-[:ALIAS_OF]->(byKind:ConfigurationItem {tenant_id: $tenantId})')
    expect(q).toContain('OPTIONAL MATCH (byName:ConfigurationItem {tenant_id: $tenantId, name_key: $nameKey})')
    expect(q).not.toMatch(/toLower\(ci\.name\)/)
    expect(q).not.toMatch(/LIMIT 1/)
    expect(q).toContain('WITH byExt, byKind, byName ORDER BY byName.created_at')
    expect(q).toContain('WITH byExt, byKind, collect(byName) AS byNames')
    // nome corto ↔ FQDN: entrambi i seek sull'indice (name_key inline / STARTS WITH), spenti senza policy o con un nome esatto trovato
    expect(q).toContain('OPTIONAL MATCH (byShort:ConfigurationItem {tenant_id: $tenantId, name_key: $shortNameKey}) WHERE $matchShortHostname AND size(byNames) = 0')
    expect(q).toContain('OPTIONAL MATCH (byPrefix:ConfigurationItem {tenant_id: $tenantId}) WHERE $matchShortHostname AND size(byNames) = 0 AND byPrefix.name_key STARTS WITH $fqdnPrefix')
    expect(q).toContain('collect(byShortOrPrefix) AS byShorts')
    expect(q).toMatch(/WHEN byExt IS NOT NULL THEN 'alias_external_id'\s+WHEN byKind IS NOT NULL THEN 'alias'\s+WHEN size\(byNames\) = 1 THEN 'name'\s+WHEN size\(byNames\) > 1 THEN 'ambiguous'\s+WHEN size\(byShorts\) = 1 THEN 'name_short'\s+WHEN size\(byShorts\) > 1 THEN 'ambiguous'\s+ELSE 'none' END AS matchReason/)
    expect(q).toContain("CASE matchReason WHEN 'alias_external_id' THEN byExt WHEN 'alias' THEN byKind WHEN 'name' THEN byNames[0] WHEN 'name_short' THEN byShorts[0] ELSE null END AS matched")
    expect(MATCH_CANDIDATES_MAX).toBe(5)
    expect(q).toContain("CASE WHEN matchReason = 'ambiguous' THEN [c IN (CASE WHEN size(byNames) > 1 THEN byNames ELSE byShorts END)[..5] | {id: c.id, name: c.name}] ELSE [] END AS candidates")
    // senza guardia niente WHERE sui tre MATCH principali; con guardia, su tutti e cinque
    expect(q.match(/\) WHERE /g)).toHaveLength(2)
    const guarded = ciMatchCypher({ guard: 'x IS NULL', carry: ['a', 'b'] })
    expect(guarded.match(/ WHERE x IS NULL/g)).toHaveLength(5)
    expect(guarded.match(/ WHERE x IS NULL AND \$matchShortHostname AND size\(byNames\) = 0/g)).toHaveLength(2)
    // le variabili del chiamante attraversano ogni WITH (collect non le perde)
    expect(guarded.match(/WITH a, b, /g)).toHaveLength(6)
    expect(guarded).not.toMatch(/WITH byExt/)
  })

  it('shortHostnameKeys: FQDN → prima etichetta; nome corto → prefisso "nome."; niente per ip/external_id, indirizzi IPv4/IPv6, etichetta vuota; ciMatchParams le espone solo con la policy accesa', () => {
    expect(shortHostnameKeys('db-01.example.local', 'hostname')).toEqual({ shortNameKey: 'db-01', fqdnPrefix: null })
    expect(shortHostnameKeys('db-01', 'hostname')).toEqual({ shortNameKey: null, fqdnPrefix: 'db-01.' })
    expect(shortHostnameKeys('db-01', 'fqdn')).toEqual({ shortNameKey: null, fqdnPrefix: 'db-01.' })
    expect(shortHostnameKeys('checkout.prod', 'name')).toEqual({ shortNameKey: 'checkout', fqdnPrefix: null })
    expect(shortHostnameKeys('10.0.0.7', 'hostname')).toEqual({ shortNameKey: null, fqdnPrefix: null })
    expect(shortHostnameKeys('2001:db8::10', 'hostname')).toEqual({ shortNameKey: null, fqdnPrefix: null })
    expect(shortHostnameKeys('10.0.0.7', 'ip')).toEqual({ shortNameKey: null, fqdnPrefix: null })
    expect(shortHostnameKeys('host-9', 'external_id')).toEqual({ shortNameKey: null, fqdnPrefix: null })
    expect(shortHostnameKeys('.example', 'hostname')).toEqual({ shortNameKey: null, fqdnPrefix: null })
    expect(shortHostnameKeys(null, 'hostname')).toEqual({ shortNameKey: null, fqdnPrefix: null })
    const ev = { resource: 'DB-01.Example.local', resourceKind: 'hostname', resourceExternalId: 'HOST-1' } as const
    expect(ciMatchParams('t1', ev, { matchShortHostname: false })).toEqual({ tenantId: 't1', resourceExternalId: 'HOST-1', kind: 'hostname', kindValue: 'db-01.example.local', nameKey: 'db-01.example.local', matchShortHostname: false, shortNameKey: null, fqdnPrefix: null })
    expect(ciMatchParams('t1', ev, { matchShortHostname: true })).toMatchObject({ matchShortHostname: true, shortNameKey: 'db-01', fqdnPrefix: null })
    expect(ciMatchParams('t1', { resource: 'db-01', resourceKind: 'hostname' }, { matchShortHostname: true })).toMatchObject({ resourceExternalId: null, shortNameKey: null, fqdnPrefix: 'db-01.' })
    // kind name → alias per kind spento; kind external_id → valore NON minuscolo
    expect(ciMatchParams('t1', { resource: 'Db-01', resourceKind: 'name' }, { matchShortHostname: false })).toMatchObject({ kind: null, kindValue: null, nameKey: 'db-01' })
    expect(ciMatchParams('t1', { resource: 'HOST-9', resourceKind: 'external_id' }, { matchShortHostname: true })).toMatchObject({ kind: 'external_id', kindValue: 'HOST-9', nameKey: 'host-9', shortNameKey: null, fqdnPrefix: null })
  })
})


describe('deriveCIHealth', () => {
  it('critical → down; solo warning → degraded; nessuno/solo info → operational', () => {
    expect(deriveCIHealth(['warning', 'critical'])).toBe('down')
    expect(deriveCIHealth(['info', 'warning'])).toBe('degraded')
    expect(deriveCIHealth(['info'])).toBe('operational')
    expect(deriveCIHealth([])).toBe('operational')
  })

  it('ondata 4 — un evento flapping vale degraded (instabilità), ma un firing critical vale comunque down', () => {
    expect(deriveCIHealth([], true)).toBe('degraded')
    expect(deriveCIHealth(['info'], true)).toBe('degraded')
    expect(deriveCIHealth(['critical'], true)).toBe('down')
    expect(deriveCIHealth([], false)).toBe('operational')
  })
})

// ── recomputeCIHealth ────────────────────────────────────────────────────────

describe('recomputeCIHealth', () => {
  const HEALTH_RE = /ci\.health AS previous, ci\.health_source AS healthSource/
  const row = (over: Record<string, unknown> = {}) => ({ rule: 'monitoring', previous: 'operational', health: 'down', changed: true, name: 'db-01', ...over })

  it('M11 — UNA sola query: severità dei firing + flapping (scoped per tenant) → salute derivata in Cypher, scrittura solo con regola monitoring, health_since solo se cambia, mai ci.status; ci.health_changed con previous/new e il nome del CI', async () => {
    onCypher([[HEALTH_RE, row()]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('down')
    expect(calls()).toHaveLength(1)
    const { cypher, params } = calls()[0]!
    // Ondata 7 · C-4: gli stati «in manutenzione» viaggiano come PARAMETRO
    // (la semantica del cliente), non come letterale nel Cypher.
    expect(params).toEqual({ tenantId: 't1', ciId: 'ci-1', now: expect.any(String), maintenanceStatuses: ['maintenance'] })
    expect(cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(cypher).toContain("OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)")
    expect(cypher).toContain("OPTIONAL MATCH (f:Event {tenant_id: $tenantId, status: 'flapping'})-[:RAISED_ON]->(ci)")
    expect(cypher).toContain(ciHealthCaseCypher('severities', 'flapping'))
    expect(cypher).toContain("CASE WHEN healthSource = 'manual' THEN 'manual' WHEN status IN $maintenanceStatuses THEN 'maintenance' ELSE 'monitoring' END AS rule")
    expect(cypher).not.toContain("status = 'maintenance'")   // nessun valore di dominio scritto nel Cypher
    expect(cypher).toContain("FOREACH (_ IN CASE WHEN rule = 'monitoring' THEN [1] ELSE [] END |")
    expect(cypher).toContain("SET ci.health = derived, ci.health_source = 'monitoring', ci.last_event_at = $now, ci.updated_at = $now")
    expect(cypher).toContain('ci.health_since = CASE WHEN changed THEN $now ELSE ci.health_since END')
    expect(cypher).not.toMatch(/ci\.status\s*=/)   // il ciclo di vita non si tocca
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(cypher).toContain('ci.name AS name')
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 't1', 'op', { id: 'ci-1', ci_id: 'ci-1', name: 'db-01', previous_health: 'operational', new_health: 'down' }, expect.any(String))
  })

  it('il CASE Cypher e deriveCIHealth nascono dalla stessa tabella: critical → down, warning o flapping → degraded, altrimenti operational', () => {
    expect(CI_HEALTH_RULES).toEqual([{ severity: 'critical', health: 'down' }, { severity: 'warning', health: 'degraded' }])
    expect(ciHealthCaseCypher('severities', 'flapping')).toBe("CASE WHEN 'critical' IN severities THEN 'down' WHEN 'warning' IN severities OR flapping THEN 'degraded' ELSE 'operational' END")
  })

  it('health_source manual → la query non scrive la salute (regola manual) e restituisce quella corrente; nessun evento pubblicato', async () => {
    onCypher([[HEALTH_RE, row({ rule: 'manual', previous: 'operational', health: 'operational', changed: false })]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('operational')
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('CI con status maintenance (ciclo di vita) → non tocca la salute; I-9: con health ma senza health_source ripristina solo health_source = monitoring (FOREACH condizionale)', async () => {
    onCypher([[HEALTH_RE, row({ rule: 'maintenance', previous: 'down', health: 'down', changed: false })]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('down')
    const { cypher } = calls()[0]!
    expect(cypher).toContain("FOREACH (_ IN CASE WHEN rule = 'maintenance' AND previous IS NOT NULL AND healthSource IS NULL THEN [1] ELSE [] END |")
    expect(cypher).toContain("SET ci.health_source = 'monitoring', ci.updated_at = $now")
    expect(cypher).toContain("RETURN rule, previous, CASE WHEN rule = 'monitoring' THEN derived ELSE previous END AS health, changed")
    expect(publishEvent).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[HEALTH_RE, row({ rule: 'maintenance', previous: null, health: null, changed: false })]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBeNull()
  })

  it('salute invariata → changed false → nessun ci.health_changed; CI mai valutato (previous null) → changed con previous_health null', async () => {
    onCypher([[HEALTH_RE, row({ previous: 'degraded', health: 'degraded', changed: false })]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('degraded')
    expect(publishEvent).not.toHaveBeenCalled()
    // la condizione di cambio vive nella query: previous null conta come cambiamento
    expect(calls()[0]!.cypher).toContain("(rule = 'monitoring' AND (previous IS NULL OR previous <> derived)) AS changed")

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[HEALTH_RE, row({ previous: null, health: 'operational', changed: true })]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('operational')
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 't1', 'op', expect.objectContaining({ previous_health: null, new_health: 'operational' }), expect.any(String))
  })

  it('CI inesistente (o di un altro tenant) → null, nessun evento', async () => {
    onCypher([[HEALTH_RE, null]])
    await expect(recomputeCIHealth('t1', 'ci-x', 'op')).resolves.toBeNull()
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

// ── matchCI ──────────────────────────────────────────────────────────────────

describe('matchCI', () => {
  const MATCH_RE = /RETURN matched\.id AS ciId, matchReason, candidates/

  it('UNA sola query (il frammento ciMatchCypher senza guardia) con i parametri di ciMatchParams, scoped per tenant; orfano con il motivo e i candidati', async () => {
    onCypher([[MATCH_RE, { ciId: null, matchReason: 'ambiguous', candidates: [{ id: 'ci-a', name: 'DB-01' }, { id: 'ci-b', name: 'db-01' }] }]])
    await expect(matchCI('t1', { resourceExternalId: 'HOST-1', resource: 'DB-01', resourceKind: 'hostname' }, { matchShortHostname: false }))
      .resolves.toEqual({ ciId: null, matchReason: 'ambiguous', candidates: [{ id: 'ci-a', name: 'DB-01' }, { id: 'ci-b', name: 'db-01' }] })
    const c = calls()
    expect(c).toHaveLength(1)
    const { cypher, params } = c[0]!
    expect(params).toEqual(ciMatchParams('t1', { resourceExternalId: 'HOST-1', resource: 'DB-01', resourceKind: 'hostname' }, { matchShortHostname: false }))
    expect(cypher).toContain(ciMatchCypher())
    expect(cypher).not.toMatch(/WHERE linked/)
    expect(session.close).toHaveBeenCalled()
  })

  it('CI riconosciuto → ciId e motivo; motivo fuori vocabolario o nessuna riga → errore (mai un esito inventato)', async () => {
    onCypher([[MATCH_RE, { ciId: 'ci-name', matchReason: 'name_short', candidates: [] }]])
    await expect(matchCI('t1', { resource: 'db-01.example.local', resourceKind: 'hostname' }, { matchShortHostname: true })).resolves.toEqual({ ciId: 'ci-name', matchReason: 'name_short', candidates: [] })
    expect(calls()[0]!.params).toMatchObject({ matchShortHostname: true, shortNameKey: 'db-01' })

    onCypher([[MATCH_RE, { ciId: 'ci-x', matchReason: 'boh', candidates: [] }]])
    await expect(matchCI('t1', { resource: 'x', resourceKind: 'name' }, { matchShortHostname: false })).rejects.toThrow(/unexpected match_reason "boh"/)
    onCypher([[MATCH_RE, null]])
    await expect(matchCI('t1', { resource: 'x', resourceKind: 'name' }, { matchShortHostname: false })).rejects.toThrow(/returned no row for tenant t1/)
  })
})

// ── ingestEvent ──────────────────────────────────────────────────────────────

const EV = { status: 'firing', severity: 'warning', title: 'DiskFull', resource: 'db-01', resourceKind: 'hostname', labels: { job: 'node' } } as const
const eventProps = (over: Record<string, unknown> = {}) => ({ id: 'ev-1', fingerprint: 'fp', title: 'DiskFull', severity: 'warning', status: 'firing', resource: 'db-01', count: 1, source_id: 'hook-1', last_received_at: 'NOW', first_seen_at: 'T0', resolved_at: null, ...over })
const MERGE_RE = /MERGE \(e:Event \{tenant_id: \$tenantId, fingerprint: \$fingerprint\}\)/
/** Riga restituita dal MERGE dell'ingest (il CI, riconosciuto o già agganciato, arriva da qui; matchReason null = riconoscimento non eseguito). */
const mergeRow = (outcome: string, props: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({ props: eventProps(props), outcome, ciId: null, matchReason: null, candidates: [], connectorKind: null, sourceHasError: false, ...over })
const publishedTypes = () => vi.mocked(publishEvent).mock.calls.map((c) => c[0])
const { cacheEventPolicy: primePolicy, invalidateEventPolicyCache: clearPolicy, DEFAULT_EVENT_POLICY: POLICY } = await import('../../lib/eventPolicy.js')

describe('ingestEvent', () => {
  // La policy del tenant arriva dalla cache (M11): qui è già calda, così il MERGE resta l'unica query.
  beforeEach(() => primePolicy('t1', POLICY))

  it('M11 — evento nuovo senza CI → UN solo statement (MERGE + riconoscimento del CI), record passato alla pipeline in modalità ingest senza rilettura, event.received + event.orphan con il motivo', async () => {
    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW', match_reason: 'none' }, { matchReason: 'none' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW', jobId: 'job-9' })
    expect(out).toMatchObject({ created: true, ciId: null, matchReason: 'none', candidates: [], outcome: 'created', sourceHasError: false })
    expect(calls()).toHaveLength(1)
    const merge = callMatching(MERGE_RE)!
    expect(merge.cypher).toBe(ingestMergeCypher())
    expect(merge.params).toMatchObject({
      ...ciMatchParams('t1', EV, { matchShortHostname: false }),
      sourceId: 'hook-1', fingerprint: fingerprintOf('hook-1', EV), status: 'firing', severity: 'warning',
      severityRank: { info: 0, warning: 1, critical: 2 }, labels: '{"job":"node"}', now: 'NOW', receivedAt: 'NOW', externalId: null, id: expect.any(String),
    })
    expect(merge.params).toMatchObject({ kind: 'hostname', kindValue: 'db-01', nameKey: 'db-01', matchShortHostname: false, shortNameKey: null, fqdnPrefix: null })
    // cronologia: l'id della voce (first_seen / cycle / severità) che il MERGE scrive nello stesso statement, diverso a ogni ingest
    expect(merge.params['historyId']).toEqual(expect.any(String))
    expect(merge.params['historyId']).not.toBe(merge.params['id'])
    expect(getSession).toHaveBeenCalledTimes(1)
    expect(runEventPipeline).toHaveBeenCalledWith({
      tenantId: 't1', eventId: 'ev-1', actorId: 'monitoring', now: 'NOW', mode: 'ingest', opensCycle: true, jobId: 'job-9',
      record: { props: expect.objectContaining({ id: 'ev-1', status: 'firing' }), ciId: null, ciStatus: null },
    })
    expect(publishedTypes()).toEqual(['event.received', 'event.orphan'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'ev-1', fingerprint: 'fp', ci_id: null, entity_type: 'event', entity_id: 'ev-1', count: 1 })
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).not.toHaveProperty('match_reason')
    expect(vi.mocked(publishEvent).mock.calls[1]![3]).toMatchObject({ id: 'ev-1', ci_id: null, match_reason: 'none', candidates: [] })
    // metriche: ricevuto (connettore assente sul webhook → generic), orfano, non deduplicato, non ambiguo
    expect(metrics.eventsReceivedTotal.inc).toHaveBeenCalledWith({ connector: 'generic' })
    expect(metrics.eventsOrphanTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.eventsAmbiguousTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsDeduplicatedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsOutOfOrderTotal.inc).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })

  it('A2 — policy match_short_hostname: letta dalla cache (nessuna query in più) e passata al MERGE come $matchShortHostname con le chiavi del nome corto; cache fredda → MATCH (t:Tenant) prima del MERGE; tenant senza policy → errore prima di ogni scrittura', async () => {
    primePolicy('t1', { ...POLICY, match_short_hostname: true })
    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW', match_reason: 'name_short' }, { ciId: 'ci-9', matchReason: 'name_short' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, resource: 'db-01.example.local' }, receivedAt: 'NOW' })
    expect(out).toMatchObject({ ciId: 'ci-9', matchReason: 'name_short' })
    expect(calls()).toHaveLength(1)
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ matchShortHostname: true, nameKey: 'db-01.example.local', shortNameKey: 'db-01', fqdnPrefix: null })
    expect(publishedTypes()).toEqual(['event.received'])

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
    clearPolicy('t1')
    onCypher([[/MATCH \(t:Tenant \{id: \$tenantId\}\)/, { raw: JSON.stringify({ ...POLICY, match_short_hostname: true }) }], [MERGE_RE, mergeRow('created', { first_seen_at: 'NOW' }, { matchReason: 'none' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(calls().map((c) => (MERGE_RE.test(c.cypher) ? 'merge' : 'policy'))).toEqual(['policy', 'merge'])
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ matchShortHostname: true, shortNameKey: null, fqdnPrefix: 'db-01.' })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    clearPolicy('t1')
    onCypher([[/MATCH \(t:Tenant \{id: \$tenantId\}\)/, { raw: null }]])
    await expect(ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })).rejects.toThrow(/Tenant t1 has no event_policy/)
    expect(callMatching(MERGE_RE)).toBeUndefined()
    expect(runEventPipeline).not.toHaveBeenCalled()
  })

  it('A2 — nome ambiguo (più CI con lo stesso name_key): orfano con match_reason = ambiguous, metrica events_ambiguous_total (+ orfano), log warn con i candidati, event.orphan con motivo e candidati; il retry duplicate lo riconta (l\'ambiguità persiste)', async () => {
    const candidates = [{ id: 'ci-a', name: 'DB-01' }, { id: 'ci-b', name: 'db-01' }]
    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW', match_reason: 'ambiguous' }, { matchReason: 'ambiguous', candidates })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW', jobId: 'job-9' })
    expect(out).toMatchObject({ created: true, ciId: null, matchReason: 'ambiguous', candidates })
    expect(out.props['match_reason']).toBe('ambiguous')
    expect(metrics.eventsAmbiguousTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.eventsOrphanTotal.inc).toHaveBeenCalledTimes(1)
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ record: { props: expect.objectContaining({ match_reason: 'ambiguous' }), ciId: null, ciStatus: null } }))
    expect(publishedTypes()).toEqual(['event.received', 'event.orphan'])
    expect(vi.mocked(publishEvent).mock.calls[1]![3]).toMatchObject({ id: 'ev-1', ci_id: null, match_reason: 'ambiguous', candidates })
    const { logger } = await import('../../lib/logger.js')
    const warn = vi.mocked(logger.child({} as never).warn).mock.calls.find(([, msg]) => /more than one CI matches/.test(String(msg)))!
    expect(warn[0]).toMatchObject({ fingerprint: fingerprintOf('hook-1', EV), jobId: 'job-9', resource: 'db-01', resourceKind: 'hostname', candidates })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
    onCypher([[MERGE_RE, mergeRow('duplicate', { first_seen_at: 'NOW', match_reason: 'ambiguous' }, { matchReason: 'ambiguous', candidates })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(metrics.eventsAmbiguousTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.eventsReceivedTotal.inc).not.toHaveBeenCalled()
  })

  it('riconoscimento non eseguito (CI già agganciato: matchReason null dal MERGE) → nessuna metrica ambiguo, matchReason null nel risultato; match_reason fuori vocabolario dal MERGE → errore', async () => {
    onCypher([[MERGE_RE, mergeRow('applied', { count: 2, match_reason: 'alias_external_id' }, { ciId: 'ci-1', matchReason: null })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ ciId: 'ci-1', matchReason: null, candidates: [] })
    expect(metrics.eventsAmbiguousTotal.inc).not.toHaveBeenCalled()

    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW' }, { matchReason: 'guess' })]])
    await expect(ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })).rejects.toThrow(/unexpected match_reason "guess"/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('evento ripetuto (applied, first_seen_at vecchio): CI già agganciato dal MERGE, metriche ricevuto{connector} + deduplicato, pipeline con opensCycle=false, e NESSUN event.received (3.3: solo il payload che apre il ciclo notifica)', async () => {
    onCypher([[MERGE_RE, mergeRow('applied', { severity: 'critical', count: 2 }, { ciId: 'ci-1', connectorKind: 'zabbix' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-1', outcome: 'applied' })
    expect(out.props).toMatchObject({ severity: 'critical', count: 2 })
    expect(calls()).toHaveLength(1)
    expect(metrics.eventsReceivedTotal.inc).toHaveBeenCalledWith({ connector: 'zabbix' })
    expect(metrics.eventsDeduplicatedTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.eventsOrphanTotal.inc).not.toHaveBeenCalled()
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', eventId: 'ev-1', mode: 'ingest', opensCycle: false, record: { props: expect.objectContaining({ count: 2 }), ciId: 'ci-1', ciStatus: null } }))
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('3.3 — event.received solo al ciclo nuovo (resolved → firing: first_seen_at = istante del payload), event.resolved solo alla chiusura (resolved_at = istante del payload); ripetizioni firing/resolved silenziose; event.orphan segue la stessa regola', async () => {
    // nuovo ciclo → received (+ orphan senza CI)
    onCypher([[MERGE_RE, mergeRow('applied', { status: 'firing', count: 1, first_seen_at: 'NOW' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(publishedTypes()).toEqual(['event.received', 'event.orphan'])

    // ripetizione resolved (resolved_at vecchio) → niente
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ status: 'resolved' }) as never)
    onCypher([[MERGE_RE, mergeRow('applied', { status: 'resolved', count: 2, resolved_at: 'T-OLD' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, status: 'resolved' }, receivedAt: 'NOW' })
    expect(publishEvent).not.toHaveBeenCalled()

    // ripetizione firing orfana → nemmeno event.orphan
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
    onCypher([[MERGE_RE, mergeRow('applied', { count: 5 })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(publishEvent).not.toHaveBeenCalled()
    expect(metrics.eventsOrphanTotal.inc).toHaveBeenCalledTimes(1)   // la metrica conta comunque
  })

  it('B2-06 — payload fuori ordine (receivedAt indietro) con stato DIVERSO: applicato, warn con i due istanti, metrica events_out_of_order_total{connector}, pipeline eseguita', async () => {
    onCypher([[MERGE_RE, mergeRow('out_of_order', { status: 'resolved', resolved_at: 'NOW', last_received_at: 'T-LATER' }, { ciId: 'ci-1', connectorKind: 'alertmanager' })]])
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ status: 'resolved' }) as never)
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, status: 'resolved' }, receivedAt: 'NOW', jobId: 'job-9' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-1', outcome: 'out_of_order' })
    expect(metrics.eventsOutOfOrderTotal.inc).toHaveBeenCalledWith({ connector: 'alertmanager' })
    // applicato come un payload qualunque: metriche di ricezione, pipeline, evento di dominio della chiusura del ciclo
    expect(metrics.eventsReceivedTotal.inc).toHaveBeenCalledWith({ connector: 'alertmanager' })
    expect(metrics.eventsDeduplicatedTotal.inc).toHaveBeenCalledTimes(1)
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ingest', opensCycle: false }))
    expect(publishedTypes()).toEqual(['event.resolved'])
    const { logger } = await import('../../lib/logger.js')
    const warn = vi.mocked(logger.child({} as never).warn).mock.calls.find(([, msg]) => /Out-of-order event payload applied/.test(String(msg)))!
    expect(warn[0]).toMatchObject({ fingerprint: fingerprintOf('hook-1', EV), jobId: 'job-9', receivedAt: 'NOW', lastReceivedAt: 'T-LATER', payloadStatus: 'resolved', status: 'resolved' })
  })

  it('B2-06 — payload fuori ordine con lo STESSO stato dell\'ultimo applicato: duplicate (innocuo), nessun warn, nessuna metrica fuori ordine, stato non toccato ma pipeline rieseguita', async () => {
    onCypher([[MERGE_RE, mergeRow('duplicate', { status: 'firing', count: 3, last_received_at: 'T-LATER' }, { ciId: 'ci-1', connectorKind: 'alertmanager' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'T-OLD' })
    expect(out).toMatchObject({ created: false, outcome: 'duplicate' })
    expect(metrics.eventsOutOfOrderTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsReceivedTotal.inc).not.toHaveBeenCalled()
    expect(runEventPipeline).toHaveBeenCalledTimes(1)
    expect(publishEvent).not.toHaveBeenCalled()   // nessun ciclo aperto o chiuso da questo payload
  })

  it('M6 — retry dello stesso job (duplicate): nessuna metrica ricevuto/deduplicato, ma pipeline rieseguita; l\'evento di dominio del ciclo aperto viene ripubblicato (at-least-once: first_seen_at = receivedAt del retry)', async () => {
    onCypher([[MERGE_RE, mergeRow('duplicate', { count: 1, first_seen_at: 'NOW' }, { ciId: 'ci-1' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-1', outcome: 'duplicate' })
    expect(metrics.eventsReceivedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsDeduplicatedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsOutOfOrderTotal.inc).not.toHaveBeenCalled()
    // B2-03: il retry ripete un ciclo già contato (stessa receivedAt) → non alimenta il contatore di tempesta,
    // ma l'evento di dominio del ciclo aperto viene ripubblicato (at-least-once).
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ingest', opensCycle: false }))
    expect(publishedTypes()).toEqual(['event.received'])
  })

  it.each([...QUIET_OUTCOMES])('ondata 4 — esito %s della pipeline → nessun event.received/orphan (l\'avviso lo ha dato la pipeline)', async (outcome) => {
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ outcome, status: outcome === 'suppressed' ? 'suppressed' : outcome === 'flapping' ? 'flapping' : 'firing' }) as never)
    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('B2-03 — resolved → firing: nuovo ciclo scritto dal MERGE (count 1), CI riconosciuto e agganciato nello stesso statement, pipeline con il CI nel record e opensCycle=true (l\'allarme che torna conta per la tempesta come uno nuovo)', async () => {
    onCypher([[MERGE_RE, mergeRow('applied', { status: 'firing', count: 1, resolved_at: null, first_seen_at: 'NOW', flapping_since: null }, { ciId: 'ci-9' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-9', outcome: 'applied' })
    expect(out.props).toMatchObject({ status: 'firing', count: 1, resolved_at: null })
    expect(calls()).toHaveLength(1)
    expect(callMatching(MERGE_RE)!.cypher).toContain('MERGE (e)-[:RAISED_ON]->(matched)')
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ opensCycle: true, record: { props: expect.objectContaining({ id: 'ev-1' }), ciId: 'ci-9', ciStatus: null } }))
    expect(metrics.eventsOrphanTotal.inc).not.toHaveBeenCalled()
    expect(publishedTypes()).toEqual(['event.received'])
  })

  it('payload resolved che chiude il ciclo → event.resolved (non event.received) con l\'actor dato', async () => {
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ status: 'resolved' }) as never)
    onCypher([[MERGE_RE, mergeRow('applied', { status: 'resolved', count: 2, resolved_at: 'NOW' }, { ciId: 'ci-1' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, status: 'resolved' }, receivedAt: 'NOW', actorId: 'am' })
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ status: 'resolved', receivedAt: 'NOW' })
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', eventId: 'ev-1', actorId: 'am', now: 'NOW', mode: 'ingest', opensCycle: false }))
    expect(publishedTypes()).toEqual(['event.resolved'])
    expect(vi.mocked(publishEvent).mock.calls[0]![2]).toBe('am')
  })

  it('B5 — resolved di un allarme mai visto: Event creato con first_seen_at = starts_at della sorgente (ISO), nessun event.resolved/orphan, metrica events_resolved_unknown_total{connector}; pipeline eseguita (salute del CI)', async () => {
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ status: 'resolved' }) as never)
    onCypher([[MERGE_RE, mergeRow('created', { status: 'resolved', count: 1, first_seen_at: '2026-09-09T10:00:00.000Z', resolved_at: 'NOW' }, { connectorKind: 'alertmanager' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, status: 'resolved', startsAt: '2026-09-09T12:00:00+02:00' }, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: true, outcome: 'created' })
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ status: 'resolved', firstSeenAt: '2026-09-09T10:00:00.000Z', now: 'NOW' })
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ingest', opensCycle: true }))
    expect(publishEvent).not.toHaveBeenCalled()
    expect(metrics.eventsResolvedUnknownTotal.inc).toHaveBeenCalledWith({ connector: 'alertmanager' })
    expect(metrics.eventsReceivedTotal.inc).toHaveBeenCalledWith({ connector: 'alertmanager' })
    expect(metrics.eventsOrphanTotal.inc).toHaveBeenCalledTimes(1)   // la metrica conta, l'avviso no
    // starts_at assente o non parsabile → istante di ricezione; firing → sempre l'istante di ricezione
    const { firstSeenOfResolvedUnknown } = await import('../events/ingest.js')
    expect(firstSeenOfResolvedUnknown(undefined, 'NOW')).toBe('NOW')
    expect(firstSeenOfResolvedUnknown('yesterday', 'NOW')).toBe('NOW')
    expect(firstSeenOfResolvedUnknown('2026-09-09T10:00:00Z', 'NOW')).toBe('2026-09-09T10:00:00.000Z')
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, startsAt: '2026-09-09T10:00:00Z' }, receivedAt: 'NOW' })
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ firstSeenAt: 'NOW' })
    expect(metrics.eventsResolvedUnknownTotal.inc).not.toHaveBeenCalled()
    expect(publishedTypes()).toEqual(['event.received', 'event.orphan'])
  })

  it('M2 — resourceExternalId viaggia come parametro del MERGE ($resourceExternalId, null se assente): è quello confrontato con l\'alias external_id, l\'id dell\'allarme ($externalId) serve solo a Event.external_id', async () => {
    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW' }, { ciId: 'ci-ext', matchReason: 'alias_external_id' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, externalId: 'alarm-77', resourceExternalId: 'HOST-1A2B' }, receivedAt: 'NOW' })
    expect(out).toMatchObject({ ciId: 'ci-ext', matchReason: 'alias_external_id' })
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ resourceExternalId: 'HOST-1A2B', externalId: 'alarm-77' })
    expect(ingestMergeCypher()).toContain("kind: 'external_id', value: $resourceExternalId")
    expect(ingestMergeCypher()).not.toContain("value: $externalId")
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult() as never)
    onCypher([[MERGE_RE, mergeRow('created', { first_seen_at: 'NOW' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ resourceExternalId: null })
  })

  it('pipeline → suppressed: nessun event.received (l\'avviso è event.suppressed della pipeline), status suppressed nel risultato', async () => {
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ outcome: 'suppressed', status: 'suppressed', suppressedByChangeId: 'chg-1' }) as never)
    onCypher([[MERGE_RE, mergeRow('applied', { count: 2 }, { ciId: 'ci-1' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out.props['status']).toBe('suppressed')
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('pipeline che fallisce → l\'ingest fallisce (il job ritenta: al retry il MERGE risponde duplicate e non riconta), nessun evento di dominio pubblicato', async () => {
    vi.mocked(runEventPipeline).mockRejectedValueOnce(new Error('Tenant t1 has no event_policy'))
    onCypher([[MERGE_RE, mergeRow('applied', { count: 2 }, { ciId: 'ci-1' })]])
    await expect(ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })).rejects.toThrow(/no event_policy/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('MERGE che non restituisce righe o con esito sconosciuto → errore esplicito (mai un evento fabbricato); status fuori vocabolario → ValidationError prima di ogni query', async () => {
    onCypher([[MERGE_RE, null]])
    await expect(ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV })).rejects.toThrow(/not written for tenant t1/)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()

    onCypher([[MERGE_RE, mergeRow('boh')]])
    await expect(ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV })).rejects.toThrow(/unexpected ingest outcome "boh"/)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expect(ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, status: 'ack' as never } })).rejects.toThrow(/Event status must be firing or resolved/)
    expect(calls()).toHaveLength(0)
  })

  it('sourceHasError del MERGE (la sorgente porta un last_error) arriva al chiamante: è il worker ad azzerarlo dopo un job riuscito', async () => {
    onCypher([[MERGE_RE, mergeRow('applied', {}, { ciId: 'ci-1', sourceHasError: true })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out.sourceHasError).toBe(true)
    expect(callMatching(/last_error = null/)).toBeUndefined()
  })
})

// ── getEventPolicy ───────────────────────────────────────────────────────────

const { DEFAULT_EVENT_POLICY_JSON, DEFAULT_EVENT_POLICY, invalidateEventPolicyCache, EVENT_POLICY_CACHE_TTL_MS } = await import('../../lib/eventPolicy.js')

describe('getEventPolicy', () => {
  beforeEach(() => invalidateEventPolicyCache())

  it('legge Tenant.event_policy e la valida', async () => {
    onCypher([[/MATCH \(t:Tenant \{id: \$tenantId\}\)/, { raw: DEFAULT_EVENT_POLICY_JSON }]])
    await expect(getEventPolicy('t1')).resolves.toMatchObject({ open_incident_from: 'critical', group_by: 'ci', flap_threshold: 4, flap_stable_minutes: 15, storm_threshold_per_minute: 50, storm_cooldown_minutes: 5 })
  })

  it('M11 — cache per tenant (TTL 30 s): la seconda lettura non interroga il grafo; setEventPolicy la invalida; allo scadere del TTL si rilegge', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-09T10:00:00.000Z') })
    try {
      onCypher([[/MATCH \(t:Tenant \{id: \$tenantId\}\)\s+RETURN/, { raw: DEFAULT_EVENT_POLICY_JSON }], [/SET t\.event_policy/, { id: 't1' }]])
      await getEventPolicy('t1')
      await getEventPolicy('t1')
      expect(calls().filter((c) => /RETURN t\.event_policy/.test(c.cypher))).toHaveLength(1)
      // tenant diverso → lettura propria
      await getEventPolicy('t2')
      expect(calls().filter((c) => /RETURN t\.event_policy/.test(c.cypher))).toHaveLength(2)

      await setEventPolicy('t1', { ...DEFAULT_EVENT_POLICY, retention_days: 7 })
      await getEventPolicy('t1')
      expect(calls().filter((c) => /RETURN t\.event_policy/.test(c.cypher))).toHaveLength(3)
      await getEventPolicy('t2')   // t2 non invalidata
      expect(calls().filter((c) => /RETURN t\.event_policy/.test(c.cypher))).toHaveLength(3)

      vi.setSystemTime(Date.parse('2026-09-09T10:00:00.000Z') + EVENT_POLICY_CACHE_TTL_MS + 1)
      await getEventPolicy('t2')
      expect(calls().filter((c) => /RETURN t\.event_policy/.test(c.cypher))).toHaveLength(4)
    } finally { vi.useRealTimers() }
  })

  it('una policy non valida NON viene messa in cache: la lettura successiva riprova sul grafo', async () => {
    onCypher([[/MATCH \(t:Tenant/, { raw: '{not json' }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/corrupt JSON/)
    onCypher([[/MATCH \(t:Tenant/, { raw: DEFAULT_EVENT_POLICY_JSON }]])
    await expect(getEventPolicy('t1')).resolves.toMatchObject({ group_by: 'ci' })
  })

  it('ondata 4 — policy di versione precedente (senza le chiavi di sfarfallio stabile/tempesta) → errore che indica la migrazione 1040', async () => {
    const { flap_stable_minutes: _a, storm_threshold_per_minute: _b, storm_cooldown_minutes: _c, ...v1 } = DEFAULT_EVENT_POLICY
    onCypher([[/MATCH \(t:Tenant/, { raw: JSON.stringify(v1) }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/flap_stable_minutes must be an integer >= 0.*missing flap_stable_minutes, storm_threshold_per_minute, storm_cooldown_minutes: run the 20260909_1040_event_management_policy_v2 migration/)
  })

  it('policy mancante → errore che indica la migrazione; corrotta → errore con il motivo; tenant inesistente → NotFound', async () => {
    onCypher([[/MATCH \(t:Tenant/, { raw: null }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/Tenant t1 has no event_policy — run the 20260909_1010_event_management_fixup migration/)
    onCypher([[/MATCH \(t:Tenant/, { raw: '{not json' }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/Tenant t1 event_policy is corrupt JSON/)
    // policy completa (versionata) con un valore fuori enum: il motivo è quel campo
    onCypher([[/MATCH \(t:Tenant/, { raw: JSON.stringify({ ...DEFAULT_EVENT_POLICY, open_incident_from: 'always' }) }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/event_policy is invalid: .*open_incident_from must be one of/)
    onCypher([[/MATCH \(t:Tenant/, null]])
    await expect(getEventPolicy('t-missing')).rejects.toThrow(/Tenant t-missing not found/)
  })
})
