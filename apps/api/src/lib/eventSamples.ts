/**
 * Payload di esempio dei connettori di monitoraggio (Event Management,
 * ondata 2). Alimentano `sampleInboundPayload` (anteprima nel mappatore,
 * frammenti di configurazione mostrati all'amministratore) e
 * `sendSampleEvent` (prova end-to-end attraverso la pipeline reale).
 *
 * Sono nella forma ESATTA che lo strumento manda al webhook: cambiarli
 * significa cambiare la documentazione che l'interfaccia mostra.
 */
import { ValidationError } from './errors.js'
import { CONNECTOR_KINDS, type ConnectorKind } from '../services/eventService.js'

const ALERTMANAGER_SAMPLE = {
  receiver: 'opengrafo',
  status: 'firing',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'DiskSpaceLow', severity: 'critical', instance: 'db-01.example.local:9100', job: 'node', mountpoint: '/var' },
      annotations: { summary: 'Disk space low on db-01', description: '/var is 97% full (threshold 90%)' },
      startsAt: '2026-09-09T10:00:00.000Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus.example.local/graph?g0.expr=node_filesystem_avail_bytes',
      fingerprint: 'a1b2c3d4e5f6a7b8',
    },
  ],
  groupLabels: { alertname: 'DiskSpaceLow' },
  commonLabels: { alertname: 'DiskSpaceLow', severity: 'critical' },
  externalURL: 'http://alertmanager.example.local:9093',
  version: '4',
  groupKey: '{}:{alertname="DiskSpaceLow"}',
}

const GRAFANA_SAMPLE = {
  receiver: 'opengrafo',
  status: 'firing',
  orgId: 1,
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'HighCPULoad', severity: 'warning', instance: 'web-01.example.local:9100', grafana_folder: 'Infrastructure' },
      annotations: { summary: 'CPU load above 85% for 10 minutes', description: 'Average CPU load on web-01 is 91%' },
      startsAt: '2026-09-09T10:05:00.000Z',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'https://grafana.example.local/alerting/grafana/abc123/view',
      fingerprint: 'f0e1d2c3b4a59687',
      silenceURL: 'https://grafana.example.local/alerting/silence/new',
      dashboardURL: 'https://grafana.example.local/d/node-exporter',
      panelURL: 'https://grafana.example.local/d/node-exporter?viewPanel=3',
      values: { B: 91.2 },
    },
  ],
  groupLabels: { alertname: 'HighCPULoad' },
  commonLabels: { alertname: 'HighCPULoad', severity: 'warning' },
  externalURL: 'https://grafana.example.local/',
  version: '1',
  groupKey: '{}:{alertname="HighCPULoad"}',
  title: '[FIRING:1] HighCPULoad',
  state: 'alerting',
  message: 'CPU load above 85% for 10 minutes',
}

/** Media type "webhook" di Zabbix con i parametri delle macro standard. */
const ZABBIX_SAMPLE = {
  event_id: '184352',
  event_name: 'Zabbix agent is not available (for 3m)',
  trigger_name: 'Zabbix agent is not available (for 3m)',
  trigger_id: '23451',
  trigger_description: 'Zabbix agent on the host is not responding',
  event_severity: 'High',
  event_nseverity: '4',
  event_value: '1',
  event_date: '2026.09.09',
  event_time: '10:12:37',
  event_opdata: 'Last check: 10:09:30',
  event_tags: 'Application:Zabbix agent, Scope:availability',
  host_name: 'app-01',
  host_ip: '10.0.1.21',
  host_id: '10084',
}

/**
 * Webhook integration di Datadog con le variabili `$ALERT_*`, `$HOSTNAME`,
 * `$TAGS`. `alert_id` è l'id del MONITOR (uguale per tutti gli host di un
 * monitor multi-alert): l'identità dell'allarme è `alert_cycle_key` (unico per
 * ciclo trigger→resolve) e, in sua assenza, alert_id + risorsa; `alert_scope`
 * (i tag che hanno attivato l'allarme) può fare da risorsa quando `hostname`
 * è vuoto (default_values.resourceFrom = alert_scope).
 */
const DATADOG_SAMPLE = {
  alert_id: '7654321',
  alert_cycle_key: '7654321:1788869557:host:cache-01',
  alert_scope: 'host:cache-01',
  alert_transition: 'Triggered',
  alert_type: 'error',
  alert_title: 'Memory usage is high on cache-01',
  title: '[Triggered on {host:cache-01}] Memory usage is high',
  body: 'Memory usage is 94% (threshold 90%) over the last 5 minutes.\n\n@webhook-opengrafo',
  text: 'Memory usage is 94% (threshold 90%) over the last 5 minutes.',
  hostname: 'cache-01',
  tags: ['env:prod', 'service:cache', 'team:platform', 'monitor'],
  date: 1788869557,
  last_updated: 1788869557,
  priority: 'normal',
  org: { id: '11111', name: 'Example' },
  link: 'https://app.datadoghq.eu/monitors/123456?group=host%3Acache-01',
  event_type: 'metric_alert_monitor',
}

/**
 * Problem notification di Dynatrace (Custom integration) con il payload
 * personalizzato proposto nel frammento di configurazione: i segnaposto
 * `{State}`, `{PID}`, `{ProblemTitle}`, … già sostituiti.
 */
const DYNATRACE_SAMPLE = {
  State: 'OPEN',
  ProblemID: 'P-2409',
  PID: '-7361280981581184312_1788869500000V2',
  ProblemTitle: 'Host unavailable',
  ProblemSeverity: 'AVAILABILITY',
  ProblemImpact: 'INFRASTRUCTURE',
  ImpactedEntity: 'Host web-02.example.local',
  ImpactedEntities: [{ type: 'HOST', name: 'web-02.example.local', entity: 'HOST-1A2B3C4D5E6F7A8B' }],
  ProblemDetailsText: 'Host web-02.example.local is unavailable: no data has been received from OneAgent for 5 minutes.',
  ProblemURL: 'https://abc12345.live.dynatrace.com/#problems/problemdetails;pid=-7361280981581184312_1788869500000V2',
  Tags: 'env:prod, team:web',
}

/**
 * Payload dimostrativo per il connettore generic: i percorsi puntati che il
 * mappatore mostra (`alert.name`, `alert.level`, `host.name`, `state`, `msg`, `id`).
 */
const GENERIC_SAMPLE = {
  id: 'EVT-100234',
  state: 'open',
  msg: 'Service checkout-api is returning HTTP 500 on 12% of requests',
  alert: { name: 'CheckoutErrorRate', level: 'major', rule: 'error_rate > 10%' },
  host: { name: 'api-03.example.local', ip: '10.0.2.13', datacenter: 'eu-west-1' },
  tags: { env: 'prod', service: 'checkout-api' },
  received_at: '2026-09-09T10:15:00Z',
}

export const SAMPLE_PAYLOADS: Readonly<Record<ConnectorKind, Readonly<Record<string, unknown>>>> = {
  generic:      GENERIC_SAMPLE,
  alertmanager: ALERTMANAGER_SAMPLE,
  grafana:      GRAFANA_SAMPLE,
  zabbix:       ZABBIX_SAMPLE,
  datadog:      DATADOG_SAMPLE,
  dynatrace:    DYNATRACE_SAMPLE,
}

/**
 * Configurazione del connettore generic che, applicata a GENERIC_SAMPLE,
 * produce un evento valido: è il frammento che l'interfaccia propone
 * all'amministratore come punto di partenza.
 */
export const GENERIC_SAMPLE_CONFIG = {
  fieldMapping:  { title: 'alert.name', severity: 'alert.level', resource: 'host.name', status: 'state', description: 'msg', externalId: 'id', labels: 'tags' },
  defaultValues: { resourceKind: 'hostname' },
  valueMapping:  {
    severity: { minor: 'info', major: 'warning', critical: 'critical' },
    status:   { open: 'firing', closed: 'resolved' },
  },
} as const

/** Copia profonda del payload di esempio del connettore (mai l'oggetto condiviso). */
export function sampleInboundPayload(connectorKind: string): Record<string, unknown> {
  if (!(CONNECTOR_KINDS as readonly string[]).includes(connectorKind)) {
    throw new ValidationError(`connectorKind must be one of: ${CONNECTOR_KINDS.join(', ')}. Got: ${JSON.stringify(connectorKind)}`)
  }
  return structuredClone(SAMPLE_PAYLOADS[connectorKind as ConnectorKind]) as Record<string, unknown>
}

/**
 * Campione per una sorgente «generic» con una mappatura propria (revisione
 * totale · G-MON-1). Il campione fisso GENERIC_SAMPLE ha i percorsi
 * dell'esempio (`alert.name`, `host.name`…): una sorgente che mappa
 * `event.summary` non li ha, e la prova finiva sempre con
 * «field_mapping.title (event.summary) is missing».
 *
 * Qui il payload si costruisce AL CONTRARIO: per ogni campo mappato si scrive
 * un valore dimostrativo al percorso che la sorgente dichiara. I campi con un
 * `default_values` restano fuori (li riempie la normalizzazione), severity e
 * status usano una chiave del `value_mapping` della sorgente se ce n'è una, per
 * non farsi rifiutare dalla traduzione.
 */
const GENERIC_FIELD_DEMO: Readonly<Record<string, string>> = {
  title:              'Sample alarm from OpenGrafo',
  description:        'Test event sent from the monitoring source wizard',
  resource:           'sample-host.example.local',
  resourceKind:       'hostname',
  severity:           'critical',
  status:             'firing',
  externalId:         'SAMPLE-1',
  resourceExternalId: 'SAMPLE-CI-1',
  startsAt:           '2026-09-09T10:00:00Z',
  endsAt:             '',
  labels:             'sample:true',
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return
  let node = target
  for (const key of parts.slice(0, -1)) {
    const next = node[key]
    if (next == null || typeof next !== 'object' || Array.isArray(next)) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[parts[parts.length - 1]!] = value
}

/**
 * `fieldMapping` = la mappatura della sorgente (campo normalizzato → percorso),
 * `valueMapping` = le sue traduzioni, `defaults` = i suoi valori predefiniti.
 */
export function genericSamplePayload(
  fieldMapping: Record<string, string>,
  valueMapping: Record<string, Record<string, string>> = {},
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [field, path] of Object.entries(fieldMapping)) {
    if (typeof path !== 'string' || !path.trim()) continue
    const demo = GENERIC_FIELD_DEMO[field]
    if (demo === undefined || demo === '') continue
    // Il valore deve sopravvivere alla traduzione della sorgente: se c'è una
    // tabella per questo campo, si manda una delle chiavi che essa conosce.
    const table = valueMapping[field]
    const keys = table ? Object.keys(table) : []
    const value = keys.length > 0 ? (keys.find((k) => table![k] === demo) ?? keys[0]!) : demo
    setPath(payload, path, value)
  }
  // Un campo obbligatorio non mappato si legge alla chiave omonima alla radice;
  // se nemmeno i default lo coprono, va nel payload.
  for (const field of ['title', 'resource', 'severity'] as const) {
    if (fieldMapping[field] || (defaults[field] !== undefined && defaults[field] !== null && defaults[field] !== '')) continue
    const table = valueMapping[field]
    const keys = table ? Object.keys(table) : []
    payload[field] = keys.length > 0 ? (keys.find((k) => table![k] === GENERIC_FIELD_DEMO[field]) ?? keys[0]!) : GENERIC_FIELD_DEMO[field]!
  }
  return payload
}
