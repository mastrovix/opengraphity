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

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
// Ondata 3: soppressione → salute → correlazione vivono in eventCorrelation.ts
// (testato a parte); qui si verifica solo che ingestEvent la invochi nel punto
// giusto e ne rispetti l'esito.
vi.mock('../eventCorrelation.js', () => ({ runEventPipeline: vi.fn() }))
vi.mock('../../middleware/metrics.js', () => ({
  eventsReceivedTotal: { inc: vi.fn() }, eventsDeduplicatedTotal: { inc: vi.fn() }, eventsOrphanTotal: { inc: vi.fn() }, eventsStaleTotal: { inc: vi.fn() },
}))

const svc = await import('../eventService.js')
const {
  normalizePayload, fingerprintOf, nextEventState, deriveCIHealth, recomputeCIHealth, ingestEvent, matchCI, getEventPolicy, setEventPolicy, MAX_EVENTS_PER_REQUEST, stripPort, getPath, listPayloadKeys, PAYLOAD_KEYS_MAX, PAYLOAD_MAX_DEPTH, quoteValue, parseValueMapping, sourceConfigOf, normalizeWithConfig, countTransitionsSince, payloadStatusOf, transitionsOf, MAX_TRANSITIONS, QUIET_OUTCOMES,
  EVENT_TRANSITIONS, prevClassOf, transitionRuleFor, PREV_CLASS_CYPHER, SEVERITY_MAX_CYPHER, TRANSITION_ACTION_CYPHER, transitionCaseCypher, residueClearCypher, transitionSetCypher, ingestMergeCypher, INGEST_WRITE_OUTCOMES,
} = svc
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
    expect(out[1]).toMatchObject({ externalId: 'def456', status: 'resolved', severity: 'warning', title: 'HighLoad', resource: '10.0.0.7', endsAt: '2026-09-09T09:30:00Z' })
    expect(out[1]).not.toHaveProperty('description')
  })

  it('stripPort: host:porta → host; ipv6 fra parentesi; senza porta invariato', () => {
    expect(stripPort('db-01:9100')).toBe('db-01')
    expect(stripPort('[::1]:9100')).toBe('[::1]')
    expect(stripPort('db-01')).toBe('db-01')
  })

  it.each([
    ['severity fuori enum', { ...AM_PAYLOAD, alerts: [{ ...AM_PAYLOAD.alerts[0], labels: { ...AM_PAYLOAD.alerts[0]!.labels, severity: 'page' } }] }, /alerts\[0\]\.labels\.severity must be one of: info, warning, critical/],
    ['severity mancante senza default', { ...AM_PAYLOAD, alerts: [{ ...AM_PAYLOAD.alerts[0], labels: { alertname: 'X', instance: 'h' } }] }, /labels\.severity/],
    ['alertname mancante', { alerts: [{ status: 'firing', labels: { severity: 'info', instance: 'h' } }] }, /labels\.alertname is missing/],
    ['instance mancante', { alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'info' } }] }, /labels\.instance is missing/],
    ['status sconosciuto', { alerts: [{ status: 'pending', labels: { alertname: 'X', severity: 'info', instance: 'h' } }] }, /alerts\[0\]\.status must be one of: firing, resolved/],
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
    ['severity fuori enum', { alerts: [{ status: 'firing', labels: { alertname: 'X', severity: 'page', instance: 'h' } }] }, /alerts\[0\]\.labels\.severity must be one of/],
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
    ['event_value non 0/1', { ...ZBX, event_value: 'PROBLEM' }, /event_value must be "1" \(problem\) or "0" \(recovery\)\. Got: "PROBLEM"/],
    ['senza host', { ...ZBX, host_name: undefined, host_ip: undefined }, /host_name \(or host_ip\) is missing/],
    ['payload lista', [ZBX], /Zabbix payload must be a JSON object/],
  ])('%s → ValidationError', (_n, payload, pattern) => {
    expectValidation(() => normalizePayload('zabbix', payload, {}, {}), pattern)
  })
})

describe('normalizePayload — datadog', () => {
  const DD = { alert_id: '7654321', alert_transition: 'Triggered', alert_type: 'error', title: '[Triggered] Memory high', body: 'Memory 94%', hostname: 'cache-01', tags: ['env:prod', 'service:cache', 'monitor'] }

  it('Triggered + error → firing critical, hostname, description dal body, tag chiave:valore come etichette', () => {
    expect(normalizePayload('datadog', DD, {}, {})).toEqual([{
      externalId: '7654321', status: 'firing', severity: 'critical', title: '[Triggered] Memory high', description: 'Memory 94%',
      resource: 'cache-01', resourceKind: 'hostname', labels: { env: 'prod', service: 'cache', monitor: 'true' },
    }])
  })

  it.each([
    ['Triggered', 'firing'], ['Re-Triggered', 'firing'], ['Warn', 'firing'], ['No Data', 'firing'], ['Recovered', 'resolved'], ['recovered', 'resolved'],
  ])('alert_transition %s → %s', (transition, status) => {
    expect(normalizePayload('datadog', { ...DD, alert_transition: transition }, {}, {})[0]!.status).toBe(status)
  })

  it.each([['error', 'critical'], ['warning', 'warning'], ['info', 'info'], ['success', 'info']])('alert_type %s → %s', (type, severity) => {
    expect(normalizePayload('datadog', { ...DD, alert_type: type }, {}, {})[0]!.severity).toBe(severity)
  })

  it('text al posto di body; tags come stringa separata da virgole o oggetto; date epoch → startsAt ISO', () => {
    const out = normalizePayload('datadog', { ...DD, body: undefined, text: 'plain', tags: 'env:prod, team:platform', date: 1788869557 }, {}, {})
    expect(out[0]).toMatchObject({ description: 'plain', labels: { env: 'prod', team: 'platform' }, startsAt: '2026-09-08T12:12:37.000Z' })
    expect(normalizePayload('datadog', { ...DD, tags: { env: 'prod' } }, {}, {})[0]!.labels).toEqual({ env: 'prod' })
  })

  it.each([
    ['senza alert_id', { ...DD, alert_id: undefined }, /alert_id is missing or empty/],
    ['senza title', { ...DD, title: '' }, /title is missing or empty/],
    ['transizione sconosciuta', { ...DD, alert_transition: 'Muted' }, /alert_transition must be one of: Triggered, Re-Triggered, Warn, No Data, Recovered\. Got: "Muted"/],
    ['senza alert_transition', { ...DD, alert_transition: undefined }, /alert_transition is missing/],
    ['senza hostname', { ...DD, hostname: undefined }, /hostname is missing or empty/],
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

  it('OPEN + AVAILABILITY → firing critical, PID come externalId, risorsa = name del primo impattato (hostname), etichette con entity', () => {
    expect(normalizePayload('dynatrace', DT, {}, {})).toEqual([{
      externalId: '-7361280981581184312_1788869500000V2', status: 'firing', severity: 'critical', title: 'Host unavailable',
      description: 'No data from OneAgent for 5 minutes.',
      resource: 'web-02.example.local', resourceKind: 'hostname',
      labels: { ProblemImpact: 'INFRASTRUCTURE', ProblemURL: DT.ProblemURL, ProblemID: 'P-2409', Tags: 'env:prod, team:web', dynatrace_entity: 'HOST-1A2B3C' },
    }])
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

  it('senza ImpactedEntities (assente o vuoto) → risorsa = ImpactedEntity con resourceKind name, senza dynatrace_entity', () => {
    for (const entities of [undefined, []]) {
      const out = normalizePayload('dynatrace', { ...DT, ImpactedEntities: entities }, {}, {})
      expect(out[0]).toMatchObject({ resource: 'Host web-02.example.local', resourceKind: 'name' })
      expect(out[0]!.labels).not.toHaveProperty('dynatrace_entity')
    }
  })

  it('senza PID → ProblemID come externalId; senza ProblemDetailsText → nessuna description', () => {
    const out = normalizePayload('dynatrace', { ...DT, PID: '', ProblemDetailsText: undefined }, {}, {})
    expect(out[0]!.externalId).toBe('P-2409')
    expect(out[0]).not.toHaveProperty('description')
  })

  it.each([
    ['senza PID né ProblemID', { ...DT, PID: undefined, ProblemID: undefined }, /PID \(or ProblemID\) is missing or empty/],
    ['senza ProblemTitle', { ...DT, ProblemTitle: '' }, /ProblemTitle is missing or empty/],
    ['State sconosciuto', { ...DT, State: 'MERGED' }, /State must be one of: OPEN, RESOLVED\. Got: "MERGED"/],
    ['senza State', { ...DT, State: undefined }, /State is missing/],
    ['severità sconosciuta', { ...DT, ProblemSeverity: 'FATAL' }, /ProblemSeverity must be one of: AVAILABILITY, ERROR, PERFORMANCE, RESOURCE_CONTENTION, CUSTOM_ALERT, MONITORING_UNAVAILABLE\. Got: "FATAL"/],
    ['senza severità', { ...DT, ProblemSeverity: undefined }, /ProblemSeverity is missing/],
    ['senza risorsa', { ...DT, ImpactedEntities: [], ImpactedEntity: '' }, /ImpactedEntities is empty and ImpactedEntity is missing or empty/],
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
    expectValidation(() => normalizePayload('dynatrace', { PID: 'P-1', ProblemTitle: 'T', State: long, ProblemSeverity: 'ERROR', ImpactedEntity: 'h' }, {}, {}), /State must be one of: OPEN, RESOLVED\. Got: "y{59}…$/)
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
    ['labels non oggetto', { ...PAYLOAD, tags: 'x' }, MAPPING, DEFAULTS, /labels must be an object/],
    ['chiave di field_mapping sconosciuta', PAYLOAD, { ...MAPPING, summary: 'msg' }, DEFAULTS, /field_mapping\.summary is not a normalized field \(allowed: title, severity, status, resource, resourceKind, externalId, description, labels, startsAt, endsAt\)/],
    ['percorso vuoto', PAYLOAD, { ...MAPPING, title: ' ' }, DEFAULTS, /field_mapping\.title must be a non-empty dotted path/],
    ['payload lista', [PAYLOAD], MAPPING, DEFAULTS, /must be a JSON object/],
  ])('%s → ValidationError', (_n, payload, mapping, defaults, pattern) => {
    expectValidation(() => normalizePayload('generic', payload, mapping as never, defaults, parseValueMapping(VALUES)), pattern)
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
  const existing = { status: 'firing', severity: 'info', count: 3, first_seen_at: 'T0', resolved_at: null, transitions: ['T-1'], last_payload_status: 'firing' }

  it('firing su evento aperto → count+1, severità = la più alta, first_seen invariato, status invariato, nessun passaggio registrato, nessun residuo azzerato', () => {
    expect(nextEventState(existing, ev, 'NOW')).toEqual({ status: 'firing', severity: 'warning', count: 4, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: null, transitions: ['T-1'], last_payload_status: 'firing', clear: 'none' })
    expect(nextEventState({ ...existing, severity: 'critical' }, ev, 'NOW').severity).toBe('critical')
    expect(nextEventState({ ...existing, status: 'suppressed' }, ev, 'NOW').status).toBe('suppressed')
  })

  it('M9 — una severità più bassa in un firing successivo NON abbassa quella dell\'evento (max); un nuovo ciclo dopo resolved riparte da quella del payload', () => {
    expect(nextEventState({ ...existing, severity: 'critical' }, { ...ev, severity: 'info' }, 'NOW')).toMatchObject({ severity: 'critical', count: 4 })
    expect(nextEventState({ ...existing, status: 'flapping', severity: 'critical' }, { ...ev, severity: 'info' }, 'NOW')).toMatchObject({ severity: 'critical' })
    expect(nextEventState({ ...existing, status: 'resolved', severity: 'critical', last_payload_status: 'resolved' }, { ...ev, severity: 'info' }, 'NOW')).toMatchObject({ severity: 'info', count: 1, status: 'firing' })
  })

  it('firing su evento risolto → nuovo ciclo: count 1, first_seen = ora, severità del payload, resolved_at null, passaggio appeso, residui del nuovo ciclo azzerati', () => {
    expect(nextEventState({ ...existing, status: 'resolved', severity: 'critical', resolved_at: 'T1', last_payload_status: 'resolved' }, ev, 'NOW'))
      .toEqual({ status: 'firing', severity: 'warning', count: 1, first_seen_at: 'NOW', last_seen_at: 'NOW', resolved_at: null, transitions: ['T-1', 'NOW'], last_payload_status: 'firing', clear: 'new_cycle' })
  })

  it('resolved su evento aperto → status resolved, resolved_at = ora, count e severità invariati, passaggio appeso, residui (soppressione/sfarfallio/ritardo) azzerati', () => {
    expect(nextEventState(existing, { ...ev, status: 'resolved' }, 'NOW'))
      .toEqual({ status: 'resolved', severity: 'info', count: 3, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: 'NOW', transitions: ['T-1', 'NOW'], last_payload_status: 'resolved', clear: 'resolved' })
    expect(nextEventState({ ...existing, status: 'suppressed' }, { ...ev, status: 'resolved' }, 'NOW')).toMatchObject({ status: 'resolved', clear: 'resolved' })
  })

  it('resolved su evento già risolto → tutto invariato (anche resolved_at: resta il primo rientro), solo last_seen e ultimo payload', () => {
    const resolved = { ...existing, status: 'resolved', resolved_at: 'T1', last_payload_status: 'resolved' }
    expect(nextEventState(resolved, { ...ev, status: 'resolved' }, 'NOW'))
      .toEqual({ status: 'resolved', severity: 'info', count: 3, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: 'T1', transitions: ['T-1'], last_payload_status: 'resolved', clear: 'none' })
  })

  it('ondata 4 — evento flapping: lo stato NON cambia con firing né con resolved; si aggiornano lista, ultimo payload, last_seen, count/resolved_at', () => {
    const flapping = { ...existing, status: 'flapping', severity: 'warning', transitions: ['T-2', 'T-1'], last_payload_status: 'firing' }
    expect(nextEventState(flapping, { ...ev, status: 'resolved' }, 'NOW'))
      .toEqual({ status: 'flapping', severity: 'warning', count: 3, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: 'NOW', transitions: ['T-2', 'T-1', 'NOW'], last_payload_status: 'resolved', clear: 'none' })
    expect(nextEventState({ ...flapping, last_payload_status: 'resolved', resolved_at: 'T1' }, { ...ev, severity: 'critical' }, 'NOW'))
      .toEqual({ status: 'flapping', severity: 'critical', count: 4, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: null, transitions: ['T-2', 'T-1', 'NOW'], last_payload_status: 'firing', clear: 'none' })
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
    ['resolved', 'firing',   { status: 'firing',   count: 1, severity: 'warning',  first_seen_at: 'NOW', resolved_at: null,  clear: 'new_cycle' }],
    ['resolved', 'resolved', { status: 'resolved', count: 3, severity: 'critical', first_seen_at: 'T0',  resolved_at: 'T1',  clear: 'none' }],
    ['firing',   'firing',   { status: 'firing',   count: 4, severity: 'critical', first_seen_at: 'T0',  resolved_at: 'T1',  clear: 'none' }],
    ['firing',   'resolved', { status: 'resolved', count: 3, severity: 'critical', first_seen_at: 'T0',  resolved_at: 'NOW', clear: 'resolved' }],
    ['flapping', 'firing',   { status: 'flapping', count: 4, severity: 'critical', first_seen_at: 'T0',  resolved_at: null,  clear: 'none' }],
    ['flapping', 'resolved', { status: 'flapping', count: 3, severity: 'critical', first_seen_at: 'T0',  resolved_at: 'NOW', clear: 'none' }],
  ]

  it.each(TABLE)('funzione pura — %s × %s', (prev, payload, exp) => {
    const existing = { status: prev, severity: 'critical', count: 3, first_seen_at: 'T0', resolved_at: 'T1', transitions: [], last_payload_status: prev === 'resolved' ? 'resolved' : 'firing' }
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
    expect(transitionCaseCypher((r) => a.severity[r.severity])).toContain(branch(rule.severity === 'payload' ? '$severity' : rule.severity === 'max' ? SEVERITY_MAX_CYPHER : 'e.severity'))
    expect(transitionCaseCypher((r) => a.firstSeen[r.firstSeen])).toContain(branch(exp['first_seen_at'] === 'NOW' ? '$now' : 'coalesce(e.first_seen_at, $now)'))
    expect(transitionCaseCypher((r) => a.resolvedAt[r.resolvedAt])).toContain(branch(exp['resolved_at'] === 'NOW' ? '$now' : exp['resolved_at'] === null ? 'null' : 'e.resolved_at'))
    // residui (M10): suppressed_by_change_id e correlation_due_at solo al passaggio a resolved; flapping_since anche al nuovo ciclo
    const clearsResolved = exp['clear'] === 'resolved'
    const clearsFlap = exp['clear'] === 'resolved' || exp['clear'] === 'new_cycle'
    expect(residueClearCypher('suppressed_by_change_id', ['resolved'])).toContain(branch(clearsResolved ? 'null' : 'e.suppressed_by_change_id'))
    expect(residueClearCypher('correlation_due_at', ['resolved'])).toContain(branch(clearsResolved ? 'null' : 'e.correlation_due_at'))
    expect(residueClearCypher('flapping_since', ['resolved', 'new_cycle'])).toContain(branch(clearsFlap ? 'null' : 'e.flapping_since'))
  })

  it('SEVERITY_MAX_CYPHER confronta i rank ($severityRank) e tiene la corrente a parità; la classe open è "non resolved e non flapping"', () => {
    expect(SEVERITY_MAX_CYPHER).toBe('CASE WHEN coalesce($severityRank[$severity], -1) > coalesce($severityRank[e.severity], -1) THEN $severity ELSE e.severity END')
    expect(PREV_CLASS_CYPHER).toEqual({ resolved: "e.status = 'resolved'", flapping: "e.status = 'flapping'", open: "NOT e.status IN ['resolved', 'flapping']" })
    // nessun ELSE: uno status fuori vocabolario non deve produrre null in silenzio (lo blocca ingestEvent prima)
    expect(transitionCaseCypher(() => '1')).not.toMatch(/ELSE/)
    expect(transitionCaseCypher(() => '1').match(/WHEN /g)).toHaveLength(6)
  })

  it('transitionSetCypher: ogni espressione legge i valori pre-scrittura, quindi status e last_payload_status sono assegnati DOPO count/severity/resolved_at/transitions; transitions appende $now solo a payload diverso dall\'ultimo e tiene gli ultimi 50; last_received_at scritto', () => {
    const set = transitionSetCypher()
    const at = (frag: string) => { const i = set.indexOf(frag); expect(i, frag).toBeGreaterThanOrEqual(0); return i }
    const status = at('e.status = CASE')
    for (const before of ['e.count = CASE', 'e.severity = CASE', 'e.first_seen_at = CASE', 'e.resolved_at = CASE', 'e.suppressed_by_change_id = CASE', 'e.correlation_due_at = CASE', 'e.flapping_since = CASE', 'e.transitions = CASE', 'e.last_payload_status = $status']) {
      expect(at(before), before).toBeLessThan(status)
    }
    expect(at('e.last_payload_status = $status')).toBeGreaterThan(at('e.transitions = CASE'))
    expect(set).toContain(`e.transitions = CASE WHEN $status <> coalesce(e.last_payload_status, CASE WHEN e.status = 'resolved' THEN 'resolved' ELSE 'firing' END) THEN (coalesce(e.transitions, []) + $now)[-${MAX_TRANSITIONS}..] ELSE coalesce(e.transitions, []) END`)
    expect(set).toContain('e.last_seen_at = $now')
    expect(set).toContain('e.last_received_at = $receivedAt')
    expect(set).toContain('e.starts_at = coalesce($startsAt, e.starts_at)')
  })

  it('ingestMergeCypher: un solo MERGE su (tenant_id, fingerprint) con ON CREATE completo, guardia d\'ordine created/applied/duplicate/stale, SET solo se applied, FROM_SOURCE solo se created', () => {
    const q = ingestMergeCypher()
    expect(q.match(/MERGE \(e:Event/g)).toHaveLength(1)
    expect(q).toContain('MERGE (e:Event {tenant_id: $tenantId, fingerprint: $fingerprint})')
    expect(q).toContain('e.count = 1, e.first_seen_at = $now, e.last_seen_at = $now, e.last_received_at = $receivedAt')
    expect(q).toContain("e.resolved_at = CASE WHEN $status = 'resolved' THEN $now ELSE null END")
    expect(q).toContain("e.correlation = 'none', e.correlation_at = null, e.correlation_due_at = null, e.suppressed_by_change_id = null")
    expect(q).toContain('e.transitions = [], e.last_payload_status = $status, e.flapping_since = null')
    expect(q).toContain('e.source_id = $sourceId, e.created_at = $now, e.updated_at = $now')
    expect(q).toContain("WHEN e.id = $id THEN 'created'")
    expect(q).toContain("WHEN e.last_received_at IS NULL OR datetime(e.last_received_at) < datetime($receivedAt) THEN 'applied'")
    expect(q).toContain("WHEN e.last_received_at = $receivedAt THEN 'duplicate'")
    expect(q).toContain("ELSE 'stale' END AS outcome")
    expect(q).toContain("FOREACH (_ IN CASE WHEN outcome = 'applied' THEN [1] ELSE [] END |")
    expect(q).toContain(transitionSetCypher())
    expect(q).toContain('OPTIONAL MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})')
    expect(q).toContain("FOREACH (_ IN CASE WHEN outcome = 'created' AND w IS NOT NULL THEN [1] ELSE [] END | MERGE (e)-[:FROM_SOURCE]->(w))")
    expect(q).toContain('OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})')
    expect(q).toContain('RETURN properties(e) AS props, outcome, ci.id AS ciId, w.connector_kind AS connectorKind, w.last_error IS NOT NULL AS sourceHasError')
    expect(INGEST_WRITE_OUTCOMES).toEqual(['created', 'applied', 'duplicate', 'stale'])
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
  it('health_source manual → non tocca il CI, nessun evento pubblicato', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'operational', healthSource: 'manual', severities: ['critical'] }]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('operational')
    expect(callMatching(/SET ci\.health/)).toBeUndefined()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('CI con status maintenance (ciclo di vita) → non tocca la salute', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'maintenance', health: 'operational', healthSource: 'monitoring', severities: ['critical'] }]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('operational')
    expect(callMatching(/SET ci\.health/)).toBeUndefined()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('I-9 — maintenance con health ma senza health_source (dopo setCIHealthOverride(null)) → scrive health_source = monitoring senza toccare health; senza health non scrive nulla', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'maintenance', health: 'down', healthSource: null, severities: ['critical'] }], [/SET ci\.health_source = 'monitoring'/, null]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('down')
    const set = callMatching(/SET ci\.health_source = 'monitoring'/)!
    expect(set.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(set.cypher).not.toMatch(/ci\.health\s*=/)
    expect(publishEvent).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'maintenance', health: null, healthSource: null, severities: [] }]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBeNull()
    expect(callMatching(/SET ci\.health_source/)).toBeUndefined()
  })

  it('evento critical firing → down, health_source monitoring, last_event_at, ci.health_changed con previous/new', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'operational', healthSource: null, severities: ['warning', 'critical'] }], [/SET ci\.health/, null]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('down')
    const set = callMatching(/SET ci\.health = \$health, ci\.health_source = 'monitoring', ci\.last_event_at = \$now/)!
    expect(set.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(set.params).toMatchObject({ tenantId: 't1', ciId: 'ci-1', health: 'down' })
    expect(set.cypher).not.toMatch(/ci\.status\s*=/)   // il ciclo di vita non si tocca
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 't1', 'op', { id: 'ci-1', ci_id: 'ci-1', previous_health: 'operational', new_health: 'down' }, expect.any(String))
  })

  it('ondata 4 — un evento flapping sul CI (nessun firing) → degraded: la query conta i flapping a parte, scoped per tenant', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'operational', healthSource: 'monitoring', severities: [], flapping: 1 }], [/SET ci\.health/, null]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('degraded')
    const q = callMatching(/collect\(DISTINCT e\.severity\)/)!
    expect(q.cypher).toContain("OPTIONAL MATCH (f:Event {tenant_id: $tenantId, status: 'flapping'})-[:RAISED_ON]->(ci)")
    expect(q.cypher).toContain('count(f) AS flapping')
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 't1', 'op', expect.objectContaining({ previous_health: 'operational', new_health: 'degraded' }), expect.any(String))
  })

  it('solo warning → degraded; nessun evento → operational; salute invariata → nessun ci.health_changed', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'degraded', healthSource: 'monitoring', severities: ['warning'] }], [/SET ci\.health/, null]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('degraded')
    expect(publishEvent).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'down', healthSource: 'monitoring', severities: [] }], [/SET ci\.health/, null]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('operational')
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 't1', 'op', expect.objectContaining({ previous_health: 'down', new_health: 'operational' }), expect.any(String))
  })

  it('CI inesistente (o di un altro tenant) → null, nessuna scrittura', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, null]])
    await expect(recomputeCIHealth('t1', 'ci-x', 'op')).resolves.toBeNull()
    expect(callMatching(/SET ci\.health/)).toBeUndefined()
  })

  it('health_since: si sposta a now SOLO quando la salute cambia; a salute invariata resta com\'è', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'operational', healthSource: 'monitoring', severities: ['critical'] }], [/SET ci\.health/, null]])
    await recomputeCIHealth('t1', 'ci-1', 'op')
    const changed = callMatching(/SET ci\.health/)!
    expect(changed.cypher).toContain('ci.health_since = CASE WHEN $changed THEN $now ELSE ci.health_since END')
    expect(changed.params).toMatchObject({ health: 'down', changed: true, now: expect.any(String) })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'down', healthSource: 'monitoring', severities: ['critical'] }], [/SET ci\.health/, null]])
    await recomputeCIHealth('t1', 'ci-1', 'op')
    expect(callMatching(/SET ci\.health/)!.params).toMatchObject({ health: 'down', changed: false })
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

// ── matchCI ──────────────────────────────────────────────────────────────────

describe('matchCI', () => {
  const MATCH_RE = /coalesce\(byExt\.id, byKind\.id, byName\.id\) AS ciId/

  it('UNA sola query: alias external_id → alias per kind (minuscolo) → CI per name_key (minuscolo, indicizzato), tutti scoped per tenant; orfano se nulla combacia', async () => {
    onCypher([[MATCH_RE, { ciId: null }]])
    await expect(matchCI('t1', { externalId: 'E1', resource: 'DB-01', resourceKind: 'hostname' })).resolves.toBeNull()
    const c = calls()
    expect(c).toHaveLength(1)
    const { cypher, params } = c[0]!
    expect(params).toEqual({ tenantId: 't1', externalId: 'E1', kind: 'hostname', kindValue: 'db-01', nameKey: 'db-01' })
    expect(cypher).toContain("OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: 'external_id', value: $externalId})-[:ALIAS_OF]->(byExt:ConfigurationItem {tenant_id: $tenantId})")
    expect(cypher).toContain('OPTIONAL MATCH (:CIAlias {tenant_id: $tenantId, kind: $kind, value: $kindValue})-[:ALIAS_OF]->(byKind:ConfigurationItem {tenant_id: $tenantId})')
    expect(cypher).toContain('OPTIONAL MATCH (byName:ConfigurationItem {tenant_id: $tenantId, name_key: $nameKey})')
    expect(cypher).not.toMatch(/toLower\(ci\.name\)/)
    // a parità di nome vince il CI più vecchio
    expect(cypher).toContain('ORDER BY byName.created_at LIMIT 1')
  })

  it('kind name → alias per kind disattivato (parametri null); kind external_id → valore NON minuscolo; senza externalId → alias external_id disattivato', async () => {
    onCypher([[MATCH_RE, { ciId: 'ci-name' }]])
    await expect(matchCI('t1', { resource: 'Db-01', resourceKind: 'name' })).resolves.toBe('ci-name')
    expect(calls()[0]!.params).toEqual({ tenantId: 't1', externalId: null, kind: null, kindValue: null, nameKey: 'db-01' })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[MATCH_RE, { ciId: 'ci-ext' }]])
    await expect(matchCI('t1', { resource: 'HOST-9', resourceKind: 'external_id' })).resolves.toBe('ci-ext')
    expect(calls()[0]!.params).toMatchObject({ kind: 'external_id', kindValue: 'HOST-9', nameKey: 'host-9' })
    expect(session.close).toHaveBeenCalled()
  })
})

// ── ingestEvent ──────────────────────────────────────────────────────────────

const EV = { status: 'firing', severity: 'warning', title: 'DiskFull', resource: 'db-01', resourceKind: 'hostname', labels: { job: 'node' } } as const
const eventProps = (over: Record<string, unknown> = {}) => ({ id: 'ev-1', fingerprint: 'fp', title: 'DiskFull', severity: 'warning', status: 'firing', resource: 'db-01', count: 1, source_id: 'hook-1', last_received_at: 'NOW', ...over })
const MERGE_RE = /MERGE \(e:Event \{tenant_id: \$tenantId, fingerprint: \$fingerprint\}\)/
const MATCH_CI_RE = /coalesce\(byExt\.id, byKind\.id, byName\.id\)/
/** Riga restituita dal MERGE dell'ingest. */
const mergeRow = (outcome: string, props: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({ props: eventProps(props), outcome, ciId: null, connectorKind: null, sourceHasError: false, ...over })

describe('ingestEvent', () => {
  it('evento nuovo senza CI → un solo MERGE (created), riconoscimento del CI in una query, pipeline in modalità ingest, event.received + event.orphan', async () => {
    onCypher([[MERGE_RE, mergeRow('created')], [MATCH_CI_RE, { ciId: null }]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: true, ciId: null, outcome: 'created', sourceHasError: false })
    expect(calls().filter((c) => /Event/.test(c.cypher) && !MATCH_CI_RE.test(c.cypher))).toHaveLength(1)
    const merge = callMatching(MERGE_RE)!
    expect(merge.cypher).toBe(ingestMergeCypher())
    expect(merge.params).toMatchObject({
      tenantId: 't1', sourceId: 'hook-1', fingerprint: fingerprintOf('hook-1', EV), status: 'firing', severity: 'warning',
      severityRank: { info: 0, warning: 1, critical: 2 }, labels: '{"job":"node"}', now: 'NOW', receivedAt: 'NOW', externalId: null, id: expect.any(String),
    })
    expect(callMatching(/MERGE \(e\)-\[:RAISED_ON\]->\(ci\)/)).toBeUndefined()
    // la salute non si ricalcola qui: è dentro la pipeline (dopo la soppressione)
    expect(callMatching(/collect\(DISTINCT e\.severity\)/)).toBeUndefined()
    expect(runEventPipeline).toHaveBeenCalledWith({ tenantId: 't1', eventId: 'ev-1', actorId: 'monitoring', now: 'NOW', mode: 'ingest', created: true })
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['event.received', 'event.orphan'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'ev-1', fingerprint: 'fp', ci_id: null, entity_type: 'event', entity_id: 'ev-1', count: 1 })
    // metriche: ricevuto (connettore assente sul webhook → generic), orfano, non deduplicato
    expect(metrics.eventsReceivedTotal.inc).toHaveBeenCalledWith({ connector: 'generic' })
    expect(metrics.eventsOrphanTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.eventsDeduplicatedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsStaleTotal.inc).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })

  it('evento ripetuto (applied): CI già agganciato riusato senza matchCI, metriche ricevuto{connector} + deduplicato, pipeline con created=false, solo event.received', async () => {
    onCypher([[MERGE_RE, mergeRow('applied', { severity: 'critical', count: 2 }, { ciId: 'ci-1', connectorKind: 'zabbix' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-1', outcome: 'applied' })
    expect(out.props).toMatchObject({ severity: 'critical', count: 2 })
    expect(callMatching(MATCH_CI_RE)).toBeUndefined()
    expect(metrics.eventsReceivedTotal.inc).toHaveBeenCalledWith({ connector: 'zabbix' })
    expect(metrics.eventsDeduplicatedTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.eventsOrphanTotal.inc).not.toHaveBeenCalled()
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', eventId: 'ev-1', mode: 'ingest', created: false }))
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['event.received'])
  })

  it('C1 — payload stantio (stale): nessuna pipeline, nessun evento di dominio, nessun aggancio, metrica events_stale_total{connector}, log info con impronta e i due istanti', async () => {
    onCypher([[MERGE_RE, mergeRow('stale', { status: 'resolved', last_received_at: 'T-LATER' }, { connectorKind: 'alertmanager' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'T-OLD' })
    expect(out).toMatchObject({ created: false, ciId: null, outcome: 'stale' })
    expect(out.props['status']).toBe('resolved')
    expect(calls()).toHaveLength(1)
    expect(runEventPipeline).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(metrics.eventsStaleTotal.inc).toHaveBeenCalledWith({ connector: 'alertmanager' })
    expect(metrics.eventsReceivedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsDeduplicatedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsOrphanTotal.inc).not.toHaveBeenCalled()
    const { logger } = await import('../../lib/logger.js')
    const info = vi.mocked(logger.child({} as never).info).mock.calls.find(([, msg]) => /Stale event payload discarded/.test(String(msg)))!
    expect(info[0]).toMatchObject({ fingerprint: fingerprintOf('hook-1', EV), receivedAt: 'T-OLD', lastReceivedAt: 'T-LATER', payloadStatus: 'firing', status: 'resolved' })
  })

  it('M6 — retry dello stesso job (duplicate): nessuna metrica ricevuto/deduplicato, ma pipeline rieseguita ed eventi di dominio pubblicati', async () => {
    onCypher([[MERGE_RE, mergeRow('duplicate', { count: 2 }, { ciId: 'ci-1' })]])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-1', outcome: 'duplicate' })
    expect(metrics.eventsReceivedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsDeduplicatedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.eventsStaleTotal.inc).not.toHaveBeenCalled()
    expect(runEventPipeline).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ingest', created: false }))
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['event.received'])
  })

  it.each([...QUIET_OUTCOMES])('ondata 4 — esito %s della pipeline → nessun event.received/orphan (l\'avviso lo ha dato la pipeline)', async (outcome) => {
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ outcome, status: outcome === 'suppressed' ? 'suppressed' : outcome === 'flapping' ? 'flapping' : 'firing' }) as never)
    onCypher([[MERGE_RE, mergeRow('created')], [MATCH_CI_RE, { ciId: null }]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('resolved → firing: nuovo ciclo scritto dal MERGE (count 1), CI riconosciuto per nome → MERGE RAISED_ON scoped per tenant, poi pipeline', async () => {
    onCypher([
      [MERGE_RE, mergeRow('applied', { status: 'firing', count: 1, resolved_at: null, flapping_since: null })],
      [MATCH_CI_RE, { ciId: 'ci-9' }],
      [/MERGE \(e\)-\[:RAISED_ON\]->\(ci\)/, null],
    ])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-9', outcome: 'applied' })
    expect(out.props).toMatchObject({ status: 'firing', count: 1, resolved_at: null })
    const link = callMatching(/MERGE \(e\)-\[:RAISED_ON\]->\(ci\)/)!
    expect(link.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})')
    expect(link.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(link.params).toMatchObject({ eventId: 'ev-1', ciId: 'ci-9', tenantId: 't1' })
    // l'ordine conta: prima l'aggancio del CI, poi la pipeline (che ne ricalcola la salute)
    const linkOrder = vi.mocked(runQuery).mock.invocationCallOrder[0]!
    expect(vi.mocked(runEventPipeline).mock.invocationCallOrder[0]!).toBeGreaterThan(linkOrder)
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['event.received'])
  })

  it('payload resolved su evento aperto → event.resolved (non event.received) con l\'actor dato', async () => {
    vi.mocked(runEventPipeline).mockResolvedValue(pipelineResult({ status: 'resolved' }) as never)
    onCypher([[MERGE_RE, mergeRow('applied', { status: 'resolved', count: 2, resolved_at: 'NOW' }, { ciId: 'ci-1' })]])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, status: 'resolved' }, receivedAt: 'NOW', actorId: 'am' })
    expect(callMatching(MERGE_RE)!.params).toMatchObject({ status: 'resolved', receivedAt: 'NOW' })
    expect(runEventPipeline).toHaveBeenCalledWith({ tenantId: 't1', eventId: 'ev-1', actorId: 'am', now: 'NOW', mode: 'ingest', created: false })
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['event.resolved'])
    expect(vi.mocked(publishEvent).mock.calls[0]![2]).toBe('am')
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
