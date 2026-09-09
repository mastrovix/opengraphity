/**
 * Frammenti di configurazione "pronti da incollare" mostrati al passo
 * Collegamento della procedura guidata, uno per strumento. Sono testo di
 * configurazione dello strumento (YAML/JSON/shell), non testo dell'interfaccia:
 * le istruzioni in prosa stanno in i18n (`monitoring.snippets.*`).
 *
 * I campi attesi da Zabbix, Datadog e Dynatrace rispecchiano i normalizzatori
 * dell'API (apps/api/src/services/eventService.ts: normalizeZabbix /
 * normalizeDatadog / normalizeDynatrace).
 */
import type { ConnectorKind } from '@/types/events'
import { API_BASE } from '@/lib/apiBase'

/** URL assoluto dell'endpoint di una sorgente (rotta REST `POST /api/webhooks/inbound/:hookId`). */
export function sourceEndpointUrl(sourceId: string): string {
  const origin = API_BASE || window.location.origin
  return `${origin}/api/webhooks/inbound/${sourceId}`
}

/** Parametri del media type Webhook di Zabbix: campo JSON atteso → macro standard. */
export const ZABBIX_FIELDS: ReadonlyArray<readonly [field: string, macro: string]> = [
  ['event_id',            '{EVENT.ID}'],
  ['event_name',          '{EVENT.NAME}'],
  ['event_severity',      '{EVENT.SEVERITY}'],
  ['event_value',         '{EVENT.VALUE}'],
  ['host_name',           '{HOST.NAME}'],
  ['host_ip',             '{HOST.IP}'],
  ['trigger_description', '{TRIGGER.DESCRIPTION}'],
  ['event_opdata',        '{EVENT.OPDATA}'],
  ['event_tags',          '{EVENT.TAGS}'],
]

/** Variabili dell'integrazione Webhooks di Datadog: campo JSON atteso → variabile. */
export const DATADOG_FIELDS: ReadonlyArray<readonly [field: string, variable: string]> = [
  ['alert_id',         '$ALERT_ID'],
  ['alert_transition', '$ALERT_TRANSITION'],
  ['alert_type',       '$ALERT_TYPE'],
  ['title',            '$EVENT_TITLE'],
  ['body',             '$EVENT_MSG'],
  ['hostname',         '$HOSTNAME'],
  ['tags',             '$TAGS'],
]

/**
 * Segnaposto del payload personalizzato di Dynatrace (Problem notifications →
 * Custom integration): campo JSON atteso → segnaposto. Vanno tra virgolette,
 * tranne `{ImpactedEntities}`, che Dynatrace espande già in un array JSON.
 */
export const DYNATRACE_FIELDS: ReadonlyArray<readonly [field: string, placeholder: string]> = [
  ['State',              '{State}'],
  ['ProblemID',          '{ProblemID}'],
  ['PID',                '{PID}'],
  ['ProblemTitle',       '{ProblemTitle}'],
  ['ProblemSeverity',    '{ProblemSeverity}'],
  ['ProblemImpact',      '{ProblemImpact}'],
  ['ImpactedEntity',     '{ImpactedEntity}'],
  ['ImpactedEntities',   '{ImpactedEntities}'],
  ['ProblemDetailsText', '{ProblemDetailsText}'],
  ['ProblemURL',         '{ProblemURL}'],
  ['Tags',               '{Tags}'],
]
const DYNATRACE_UNQUOTED: ReadonlySet<string> = new Set(['ImpactedEntities'])

function alertmanagerSnippet(url: string, token: string): string {
  return [
    'receivers:',
    '  - name: opengrafo',
    '    webhook_configs:',
    `      - url: ${url}`,
    '        send_resolved: true',
    '        http_config:',
    '          authorization:',
    '            type: Bearer',
    `            credentials: ${token}`,
    '',
    'route:',
    '  receiver: opengrafo',
  ].join('\n')
}

function grafanaSnippet(url: string, token: string): string {
  return [
    `URL:                  ${url}`,
    'Authorization scheme: Bearer',
    `Authorization creds:  ${token}`,
    'Send resolved:        on',
  ].join('\n')
}

function zabbixSnippet(url: string, token: string): string {
  const params = [['URL', url], ['Token', token], ...ZABBIX_FIELDS.map(([f, m]) => [f, m])] as [string, string][]
  const width = Math.max(...params.map(([k]) => k.length))
  const lines = params.map(([k, v]) => `${k.padEnd(width)}  ${v}`)
  const body = JSON.stringify(Object.fromEntries(ZABBIX_FIELDS.map(([f, m]) => [f, m])), null, 2)
  return ['# Media type "Webhook" — Parameters', ...lines, '', '# JSON body sent (Authorization: Bearer <Token>)', body].join('\n')
}

function datadogSnippet(url: string, token: string): string {
  const payload = JSON.stringify(Object.fromEntries(DATADOG_FIELDS.map(([f, v]) => [f, v])), null, 2)
  return [
    `URL:            ${url}`,
    `Custom headers: {"Authorization": "Bearer ${token}"}`,
    '',
    '# Custom payload',
    payload,
  ].join('\n')
}

/** Il payload va incollato così com'è: JSON.stringify metterebbe tra virgolette anche {ImpactedEntities}. */
export function dynatracePayloadTemplate(): string {
  const lines = DYNATRACE_FIELDS.map(([f, p], i) => {
    const value = DYNATRACE_UNQUOTED.has(f) ? p : `"${p}"`
    return `  "${f}": ${value}${i < DYNATRACE_FIELDS.length - 1 ? ',' : ''}`
  })
  return ['{', ...lines, '}'].join('\n')
}

function dynatraceSnippet(url: string, token: string): string {
  return [
    `Webhook URL:    ${url}`,
    'HTTP header:    Authorization',
    `Header value:   Bearer ${token}`,
    '',
    '# Custom payload (paste as is: {ImpactedEntities} stays unquoted)',
    dynatracePayloadTemplate(),
  ].join('\n')
}

function genericSnippet(url: string, token: string, samplePayload: string): string {
  let body = samplePayload.trim()
  try { body = JSON.stringify(JSON.parse(body)) } catch { /* lasciato com'è: il curl mostra ciò che l'admin ha incollato */ }
  return [
    `curl -X POST '${url}' \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -H 'Authorization: Bearer ${token}' \\`,
    `  -d '${body.replace(/'/g, "'\\''")}'`,
  ].join('\n')
}

/** Frammento per lo strumento; per `generic` include il payload di esempio mappato. */
export function configSnippet(kind: ConnectorKind, url: string, token: string, samplePayload = ''): string {
  switch (kind) {
    case 'alertmanager': return alertmanagerSnippet(url, token)
    case 'grafana':      return grafanaSnippet(url, token)
    case 'zabbix':       return zabbixSnippet(url, token)
    case 'datadog':      return datadogSnippet(url, token)
    case 'dynatrace':    return dynatraceSnippet(url, token)
    case 'generic':      return genericSnippet(url, token, samplePayload)
  }
}
