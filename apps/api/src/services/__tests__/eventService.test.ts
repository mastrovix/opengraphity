/**
 * eventService.ts — normalizzazione per connettore (alertmanager, grafana,
 * zabbix, datadog, dynatrace, generic con percorsi puntati + value_mapping; errori →
 * ValidationError con il percorso del campo), impronta stabile (mai la description), stato
 * successivo dell'evento (ripetizione / nuovo ciclo / risoluzione), regole di
 * ricalcolo della salute del CI (health_source manual / status maintenance
 * intoccabili, ci.status mai scritto), ingest
 * nuovo / ripetuto / resolved→firing con mock delle query.
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

const svc = await import('../eventService.js')
const { normalizePayload, fingerprintOf, nextEventState, deriveCIHealth, recomputeCIHealth, ingestEvent, matchCI, getEventPolicy, MAX_EVENTS_PER_REQUEST, stripPort, getPath, listPayloadKeys, PAYLOAD_KEYS_MAX, parseValueMapping, sourceConfigOf, normalizeWithConfig } = svc
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }

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

// ── nextEventState / deriveCIHealth ──────────────────────────────────────────

describe('nextEventState', () => {
  const ev = { status: 'firing', severity: 'warning', title: 'T', resource: 'r', resourceKind: 'name', labels: {} } as const
  const existing = { status: 'firing', severity: 'info', count: 3, first_seen_at: 'T0', resolved_at: null }

  it('firing su evento aperto → count+1, severità = la più alta, first_seen invariato, status invariato', () => {
    expect(nextEventState(existing, ev, 'NOW')).toEqual({ status: 'firing', severity: 'warning', count: 4, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: null })
    expect(nextEventState({ ...existing, severity: 'critical' }, ev, 'NOW').severity).toBe('critical')
    expect(nextEventState({ ...existing, status: 'suppressed' }, ev, 'NOW').status).toBe('suppressed')
  })

  it('firing su evento risolto → nuovo ciclo: count 1, first_seen = ora, severità del payload, resolved_at null', () => {
    expect(nextEventState({ ...existing, status: 'resolved', severity: 'critical', resolved_at: 'T1' }, ev, 'NOW'))
      .toEqual({ status: 'firing', severity: 'warning', count: 1, first_seen_at: 'NOW', last_seen_at: 'NOW', resolved_at: null })
  })

  it('resolved → status resolved, resolved_at = ora, count e severità invariati', () => {
    expect(nextEventState(existing, { ...ev, status: 'resolved' }, 'NOW'))
      .toEqual({ status: 'resolved', severity: 'info', count: 3, first_seen_at: 'T0', last_seen_at: 'NOW', resolved_at: 'NOW' })
  })
})

describe('deriveCIHealth', () => {
  it('critical → down; solo warning → degraded; nessuno/solo info → operational', () => {
    expect(deriveCIHealth(['warning', 'critical'])).toBe('down')
    expect(deriveCIHealth(['info', 'warning'])).toBe('degraded')
    expect(deriveCIHealth(['info'])).toBe('operational')
    expect(deriveCIHealth([])).toBe('operational')
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

  it('evento critical firing → down, health_source monitoring, last_event_at, ci.health_changed con previous/new', async () => {
    onCypher([[/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'operational', healthSource: null, severities: ['warning', 'critical'] }], [/SET ci\.health/, null]])
    await expect(recomputeCIHealth('t1', 'ci-1', 'op')).resolves.toBe('down')
    const set = callMatching(/SET ci\.health = \$health, ci\.health_source = 'monitoring', ci\.last_event_at = \$now/)!
    expect(set.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(set.params).toMatchObject({ tenantId: 't1', ciId: 'ci-1', health: 'down' })
    expect(set.cypher).not.toMatch(/ci\.status\s*=/)   // il ciclo di vita non si tocca
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 't1', 'op', { id: 'ci-1', ci_id: 'ci-1', previous_health: 'operational', new_health: 'down' }, expect.any(String))
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
  it('ordine: alias external_id → alias per kind (minuscolo) → nome del CI; orfano se nulla combacia', async () => {
    onCypher([[/kind: 'external_id'/, null], [/kind: \$kind/, null], [/toLower\(ci\.name\) = toLower\(\$resource\)/, null]])
    await expect(matchCI('t1', { externalId: 'E1', resource: 'DB-01', resourceKind: 'hostname' })).resolves.toBeNull()
    const c = calls()
    expect(c.map((x) => x.cypher)).toHaveLength(3)
    expect(c[0]!.params).toMatchObject({ tenantId: 't1', value: 'E1' })
    expect(c[1]!.params).toMatchObject({ tenantId: 't1', kind: 'hostname', value: 'db-01' })
    expect(c[2]!.params).toMatchObject({ tenantId: 't1', resource: 'DB-01' })
    for (const x of c) expect(x.cypher).toContain('tenant_id: $tenantId')
  })

  it('alias per kind trovato → non interroga per nome; kind name → salta gli alias', async () => {
    onCypher([[/kind: \$kind/, { ciId: 'ci-alias' }], [/toLower\(ci\.name\)/, { ciId: 'ci-name' }]])
    await expect(matchCI('t1', { resource: 'db-01', resourceKind: 'ip' })).resolves.toBe('ci-alias')
    expect(calls()).toHaveLength(1)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/toLower\(ci\.name\)/, { ciId: 'ci-name' }]])
    await expect(matchCI('t1', { resource: 'db-01', resourceKind: 'name' })).resolves.toBe('ci-name')
    expect(calls()).toHaveLength(1)
  })
})

// ── ingestEvent ──────────────────────────────────────────────────────────────

const EV = { status: 'firing', severity: 'warning', title: 'DiskFull', resource: 'db-01', resourceKind: 'hostname', labels: { job: 'node' } } as const
const eventProps = (over: Record<string, unknown> = {}) => ({ id: 'ev-1', fingerprint: 'fp', title: 'DiskFull', severity: 'warning', status: 'firing', resource: 'db-01', count: 1, source_id: 'hook-1', ...over })

describe('ingestEvent', () => {
  it('evento nuovo senza CI → CREATE con count 1, FROM_SOURCE, event.received + event.orphan, nessun ricalcolo', async () => {
    onCypher([
      [/MATCH \(e:Event \{tenant_id: \$tenantId, fingerprint: \$fingerprint\}\)\s+OPTIONAL MATCH/, null],
      [/CREATE \(e:Event/, { props: eventProps() }],
      [/CIAlias/, null], [/toLower\(ci\.name\)/, null],
    ])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: true, ciId: null })
    const create = callMatching(/CREATE \(e:Event/)!
    expect(create.cypher).toContain('count: 1, first_seen_at: $now, last_seen_at: $now')
    expect(create.cypher).toContain('MERGE (e)-[:FROM_SOURCE]->(w)')
    expect(create.params).toMatchObject({ tenantId: 't1', sourceId: 'hook-1', fingerprint: fingerprintOf('hook-1', EV), status: 'firing', severity: 'warning', labels: '{"job":"node"}', now: 'NOW', externalId: null })
    expect(callMatching(/RAISED_ON\]->\(ci\)\s*$/)).toBeUndefined()
    expect(callMatching(/collect\(DISTINCT e\.severity\)/)).toBeUndefined()
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['event.received', 'event.orphan'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'ev-1', fingerprint: 'fp', ci_id: null, entity_type: 'event', entity_id: 'ev-1', count: 1 })
  })

  it('evento ripetuto (firing) → SET count 2 e severità più alta, CI già agganciato riusato senza matchCI, ricalcolo del CI, solo event.received', async () => {
    onCypher([
      [/MATCH \(e:Event \{tenant_id: \$tenantId, fingerprint: \$fingerprint\}\)\s+OPTIONAL MATCH/, { props: eventProps({ severity: 'critical', count: 1, first_seen_at: 'T0' }), ciId: 'ci-1' }],
      [/SET e\.status = \$status, e\.severity = \$severity, e\.count = toInteger\(\$count\)/, { props: eventProps({ severity: 'critical', count: 2 }) }],
      [/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'down', healthSource: 'monitoring', severities: ['critical'] }],
      [/SET ci\.health/, null],
    ])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-1' })
    const set = callMatching(/SET e\.status = \$status/)!
    expect(set.params).toMatchObject({ status: 'firing', severity: 'critical', count: 2, firstSeenAt: 'T0', lastSeenAt: 'NOW', resolvedAt: null })
    expect(callMatching(/CIAlias/)).toBeUndefined()
    expect(callMatching(/collect\(DISTINCT e\.severity\)/)!.params).toMatchObject({ ciId: 'ci-1', tenantId: 't1' })
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['event.received'])
  })

  it('resolved → firing: nuovo ciclo (count 1, first_seen = ora), CI riconosciuto per nome → MERGE RAISED_ON scoped per tenant', async () => {
    onCypher([
      [/MATCH \(e:Event \{tenant_id: \$tenantId, fingerprint: \$fingerprint\}\)\s+OPTIONAL MATCH/, { props: eventProps({ status: 'resolved', severity: 'critical', count: 7, first_seen_at: 'T0', resolved_at: 'T1' }), ciId: null }],
      [/SET e\.status = \$status/, { props: eventProps({ status: 'firing', count: 1 }) }],
      [/CIAlias/, null], [/toLower\(ci\.name\)/, { ciId: 'ci-9' }],
      [/MERGE \(e\)-\[:RAISED_ON\]->\(ci\)/, null],
      [/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'operational', healthSource: null, severities: ['warning'] }],
      [/SET ci\.health/, null],
    ])
    const out = await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: 'NOW' })
    expect(out).toMatchObject({ created: false, ciId: 'ci-9' })
    expect(callMatching(/SET e\.status = \$status/)!.params).toMatchObject({ status: 'firing', severity: 'warning', count: 1, firstSeenAt: 'NOW', resolvedAt: null })
    const link = callMatching(/MERGE \(e\)-\[:RAISED_ON\]->\(ci\)/)!
    expect(link.cypher).toContain('MATCH (e:Event {id: $eventId, tenant_id: $tenantId})')
    expect(link.cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(link.params).toMatchObject({ eventId: 'ev-1', ciId: 'ci-9', tenantId: 't1' })
    expect(publishEvent).toHaveBeenCalledWith('ci.health_changed', 't1', 'monitoring', expect.objectContaining({ ci_id: 'ci-9', new_health: 'degraded' }), expect.any(String))
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['ci.health_changed', 'event.received'])
  })

  it('payload resolved su evento aperto → event.resolved (non event.received), resolved_at = ora', async () => {
    onCypher([
      [/MATCH \(e:Event \{tenant_id: \$tenantId, fingerprint: \$fingerprint\}\)\s+OPTIONAL MATCH/, { props: eventProps({ count: 2, first_seen_at: 'T0' }), ciId: 'ci-1' }],
      [/SET e\.status = \$status/, { props: eventProps({ status: 'resolved', count: 2 }) }],
      [/collect\(DISTINCT e\.severity\)/, { status: 'active', health: 'degraded', healthSource: 'monitoring', severities: [] }],
      [/SET ci\.health/, null],
    ])
    await ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: { ...EV, status: 'resolved' }, receivedAt: 'NOW', actorId: 'am' })
    expect(callMatching(/SET e\.status = \$status/)!.params).toMatchObject({ status: 'resolved', count: 2, resolvedAt: 'NOW' })
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).toEqual(['ci.health_changed', 'event.resolved'])
    expect(vi.mocked(publishEvent).mock.calls[1]![2]).toBe('am')
  })

  it('CREATE che non restituisce righe → errore esplicito (mai un evento fabbricato)', async () => {
    onCypher([[/MATCH \(e:Event \{tenant_id: \$tenantId, fingerprint: \$fingerprint\}\)\s+OPTIONAL MATCH/, null], [/CREATE \(e:Event/, null]])
    await expect(ingestEvent({ tenantId: 't1', sourceId: 'hook-1', ev: EV })).rejects.toThrow(/not created for tenant t1/)
    expect(publishEvent).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })
})

// ── getEventPolicy ───────────────────────────────────────────────────────────

describe('getEventPolicy', () => {
  it('legge Tenant.event_policy e la valida', async () => {
    const { DEFAULT_EVENT_POLICY_JSON } = await import('../../lib/eventPolicy.js')
    onCypher([[/MATCH \(t:Tenant \{id: \$tenantId\}\)/, { raw: DEFAULT_EVENT_POLICY_JSON }]])
    await expect(getEventPolicy('t1')).resolves.toMatchObject({ open_incident_from: 'critical', group_by: 'ci', flap_threshold: 4 })
  })

  it('policy mancante → errore che indica la migrazione; corrotta → errore con il motivo; tenant inesistente → NotFound', async () => {
    onCypher([[/MATCH \(t:Tenant/, { raw: null }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/Tenant t1 has no event_policy — run the 20260909_1010_event_management_fixup migration/)
    onCypher([[/MATCH \(t:Tenant/, { raw: '{not json' }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/Tenant t1 event_policy is corrupt JSON/)
    onCypher([[/MATCH \(t:Tenant/, { raw: JSON.stringify({ open_incident_from: 'always' }) }]])
    await expect(getEventPolicy('t1')).rejects.toThrow(/event_policy is invalid: .*open_incident_from must be one of/)
    onCypher([[/MATCH \(t:Tenant/, null]])
    await expect(getEventPolicy('t-missing')).rejects.toThrow(/Tenant t-missing not found/)
  })
})
