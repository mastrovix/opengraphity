import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { CONNECTOR_KINDS, parseConfigJSON, sourceConfigOf } from '../../services/eventService.js'
import { getEventPolicy } from '../../services/events/policy.js'
import { EVENT_POLICY_V4_MIGRATION } from '../../lib/eventPolicy.js'
import { invalidateSourceCache } from '../../services/eventStorm.js'
import { DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE, rateLimitOf, validateRateLimitPerMinute } from '../../lib/webhookRateLimit.js'
import { API_KEY_PERMISSIONS, isApiKeyPermission } from '@opengraphity/types'
import { assertInboundTicketTargets } from '../../lib/inboundTicketTargets.js'

/**
 * Un webhook di Event Management ha senso solo se il tenant ha una policy
 * eventi leggibile (revisione A-M8): un tenant senza nodo :Tenant (creato
 * prima dell'onboarding, o "solo integrazione" senza utenti) avrebbe un
 * webhook che risponde 202 e un worker che fallisce ogni job tre volte su
 * "Tenant not found". L'errore deve emergere QUI, alla configurazione.
 */
export async function assertTenantEventPolicy(tenantId: string): Promise<void> {
  try {
    await getEventPolicy(tenantId)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new ValidationError(`Cannot create an event webhook: tenant ${tenantId} has no usable event policy (${reason}). Run the ${EVENT_POLICY_V4_MIGRATION} migration (it creates the missing :Tenant node with the default policy and completes existing policies), then retry`)
  }
}

/** Prima riga di una query scopata per tenant: assente = risorsa inesistente o di un altro tenant. */
function firstRow<T>(rows: T[], what: string): T {
  const row = rows[0]
  if (!row) throw new NotFoundError(what)
  return row
}

/**
 * Event Management: `connectorKind` è obbligatorio (generic | alertmanager |
 * grafana | zabbix | datadog | dynatrace) per entityType = event e vietato per gli altri
 * tipi. Restituisce il valore da persistire in `connector_kind` (null per i
 * non-event).
 */
export function validateConnectorKind(entityType: unknown, connectorKind: unknown): string | null {
  if (entityType === 'event') {
    if (typeof connectorKind !== 'string' || !(CONNECTOR_KINDS as readonly string[]).includes(connectorKind)) {
      throw new ValidationError(`connectorKind is required for entityType "event" and must be one of: ${CONNECTOR_KINDS.join(', ')}. Got: ${JSON.stringify(connectorKind ?? null)}`)
    }
    return connectorKind
  }
  if (connectorKind != null) {
    throw new ValidationError(`connectorKind is only allowed for entityType "event" (got entityType ${JSON.stringify(entityType)})`)
  }
  return null
}

/**
 * La configurazione di mappatura si valida in scrittura, non al primo
 * payload: fieldMapping / defaultValues / valueMapping devono essere JSON
 * oggetto e, per entityType = event, coerenti col connettore (chiavi di
 * field_mapping ammesse, vocabolario di value_mapping, default_values dei
 * preset: severity, resource + resourceKind, resourceFrom — vedi
 * validatePresetDefaults). `valueMapping` vale per OGNI connettore (A1): nei
 * preset traduce severità/stato dello strumento prima della tabella incorporata.
 */
export function validateInboundConfig(final: { entityType: unknown; connectorKind: string | null; fieldMapping: unknown; defaultValues: unknown; valueMapping: unknown }): void {
  const mapping  = parseConfigJSON<Record<string, unknown>>(final.fieldMapping, 'fieldMapping')
  const defaults = parseConfigJSON<Record<string, unknown>>(final.defaultValues, 'defaultValues')
  parseConfigJSON<Record<string, unknown>>(final.valueMapping, 'valueMapping')
  if (final.entityType === 'event') {
    sourceConfigOf({ connector_kind: final.connectorKind, field_mapping: final.fieldMapping, default_values: final.defaultValues, value_mapping: final.valueMapping })
    return
  }
  // D-25: la mappa accettava QUALUNQUE bersaglio e la consegna ne scriveva
  // quattro, scartando il resto con un 201 Created. Qui il salvataggio dice
  // subito cosa il server applica — come già fa il ramo `event` col suo
  // connettore — invece di far scoprire il buco aprendo un ticket importato.
  assertInboundTicketTargets(final.entityType, Object.values(mapping ?? {}), 'fieldMapping')
  assertInboundTicketTargets(final.entityType, Object.keys(defaults ?? {}), 'defaultValues')
}

import { requireRole } from '../../lib/requireRole.js'
import { randomBytes, createHash, createHmac } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { withSession } from './ci-utils.js'
import { runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { assertSafeOutboundUrl } from '../../lib/safeUrl.js'

type Props = Record<string, unknown>

function hash(val: string): string { return createHash('sha256').update(val).digest('hex') }
function genToken(): string { return randomBytes(32).toString('hex') }
function genApiKey(): string { return `og_live_${randomBytes(32).toString('hex')}` }

// ── Mappers ──────────────────────────────────────────────────────────────────

export function mapInbound(p: Props) {
  return {
    id: p['id'], name: p['name'], entityType: p['entity_type'],
    connectorKind: p['connector_kind'] ?? null,
    fieldMapping: p['field_mapping'], defaultValues: p['default_values'] ?? null,
    valueMapping: p['value_mapping'] ?? null,
    transformScript: p['transform_script'] ?? null, enabled: p['enabled'] ?? false,
    // Assente sui webhook creati prima del campo → default documentato (M7).
    rateLimitPerMinute: rateLimitOf(p),
    lastReceivedAt: p['last_received_at'] ?? null, receiveCount: Number(p['receive_count'] ?? 0),
    lastError: p['last_error'] ?? null, lastErrorAt: p['last_error_at'] ?? null, errorCount: Number(p['error_count'] ?? 0),
    createdAt: p['created_at'],
  }
}

function mapOutbound(p: Props) {
  return {
    id: p['id'], name: p['name'], url: p['url'], method: p['method'] ?? 'POST',
    headers: p['headers'] ?? null, events: p['events'] ?? [],
    payloadTemplate: p['payload_template'] ?? null, enabled: p['enabled'] ?? false,
    lastSentAt: p['last_sent_at'] ?? null, lastStatusCode: p['last_status_code'] ?? null,
    sendCount: Number(p['send_count'] ?? 0), errorCount: Number(p['error_count'] ?? 0),
    lastError: p['last_error'] ?? null, retryOnFailure: p['retry_on_failure'] ?? true,
  }
}

function mapApiKey(p: Props) {
  return {
    id: p['id'], name: p['name'], keyPrefix: p['key_prefix'], permissions: p['permissions'] ?? [],
    rateLimit: Number(p['rate_limit'] ?? 60), enabled: p['enabled'] ?? false,
    lastUsedAt: p['last_used_at'] ?? null, requestCount: Number(p['request_count'] ?? 0),
    createdBy: p['created_by'] ?? null, expiresAt: p['expires_at'] ?? null, createdAt: p['created_at'],
  }
}

// ── Inbound Webhooks ─────────────────────────────────────────────────────────

function sortClause(alias: string, sf: string | undefined, sd: string | undefined, wl: Record<string, string>, def: string): string {
  const col = wl[sf ?? ''] ?? `${alias}.${def}`
  return `ORDER BY ${col} ${sd === 'asc' ? 'ASC' : 'DESC'}`
}

async function inboundWebhooks(_: unknown, args: { filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const params: Props = { t: ctx.tenantId }
    const allowed = new Set(['name', 'entityType', 'enabled', 'entity_type', 'receive_count'])
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 'w') : ''
    const order = sortClause('w', args.sortField, args.sortDirection, { name: 'w.name', entityType: 'w.entity_type', enabled: 'w.enabled', receiveCount: 'w.receive_count', lastReceivedAt: 'w.last_received_at' }, 'name')
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:InboundWebhook {tenant_id: $t}) ${advWhere ? `WHERE ${advWhere}` : ''} RETURN properties(w) AS props ${order}`, params)
    return rows.map(r => mapInbound(r.props))
  })
}

async function createInboundWebhook(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const connectorKind = validateConnectorKind(input['entityType'], input['connectorKind'])
  validateInboundConfig({ entityType: input['entityType'], connectorKind, fieldMapping: input['fieldMapping'], defaultValues: input['defaultValues'] ?? null, valueMapping: input['valueMapping'] ?? null })
  // Omesso → 100 (l'unico default ammesso, vedi lib/webhookRateLimit.ts); dato → validato 1..10000.
  const rateLimitPerMinute = input['rateLimitPerMinute'] === undefined || input['rateLimitPerMinute'] === null
    ? DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE
    : validateRateLimitPerMinute(input['rateLimitPerMinute'], 'rateLimitPerMinute')
  // Webhook di Event Management: la policy del tenant deve esistere già ora (A-M8), non scoprirlo nel worker.
  if (input['entityType'] === 'event') await assertTenantEventPolicy(ctx.tenantId)
  const token = genToken()
  const id = uuidv4()
  const now = new Date().toISOString()
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      CREATE (w:InboundWebhook {id: $id, tenant_id: $t, name: $name, entity_type: $entityType, connector_kind: $connectorKind,
        secret: $secret, field_mapping: $fieldMapping, default_values: $defaultValues, value_mapping: $valueMapping,
        transform_script: $transformScript, enabled: true, rate_limit_per_minute: toInteger($rateLimitPerMinute),
        receive_count: 0, error_count: 0, created_at: $now, updated_at: $now})
      RETURN properties(w) AS props
    `, { id, t: ctx.tenantId, name: input['name'], entityType: input['entityType'], connectorKind, secret: hash(token), fieldMapping: input['fieldMapping'], defaultValues: input['defaultValues'] ?? null, valueMapping: input['valueMapping'] ?? null, transformScript: input['transformScript'] ?? null, rateLimitPerMinute, now })
    return { ...mapInbound(firstRow(rows, 'InboundWebhook').props), token }
  }, true)
}

async function updateInboundWebhook(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const sets: string[] = ['w.updated_at = $now']
  const params: Props = { id: args.id, t: ctx.tenantId, now: new Date().toISOString() }
  const map: Record<string, string> = { name: 'name', entityType: 'entity_type', fieldMapping: 'field_mapping', defaultValues: 'default_values', valueMapping: 'value_mapping', transformScript: 'transform_script', enabled: 'enabled' }
  for (const [gql, neo] of Object.entries(map)) { if (input[gql] !== undefined) { sets.push(`w.${neo} = $${gql}`); params[gql] = input[gql] } }
  if (input['rateLimitPerMinute'] !== undefined) {
    sets.push('w.rate_limit_per_minute = toInteger($rateLimitPerMinute)')
    params['rateLimitPerMinute'] = validateRateLimitPerMinute(input['rateLimitPerMinute'], 'rateLimitPerMinute')
  }
  const CONFIG_KEYS = ['entityType', 'connectorKind', 'fieldMapping', 'defaultValues', 'valueMapping'] as const
  return withSession(async (s) => {
    // Le regole entityType ↔ connectorKind e connettore ↔ mappature valgono
    // sul risultato finale: se un pezzo cambia serve lo stato attuale degli altri.
    if (CONFIG_KEYS.some((k) => input[k] !== undefined)) {
      const current = firstRow(await runQuery<{ entityType: unknown; connectorKind: unknown; fieldMapping: unknown; defaultValues: unknown; valueMapping: unknown }>(s,
        `MATCH (w:InboundWebhook {id: $id, tenant_id: $t})
         RETURN w.entity_type AS entityType, w.connector_kind AS connectorKind, w.field_mapping AS fieldMapping, w.default_values AS defaultValues, w.value_mapping AS valueMapping`,
        { id: args.id, t: ctx.tenantId }), 'InboundWebhook')
      const pick = <K extends (typeof CONFIG_KEYS)[number]>(k: K) => (input[k] !== undefined ? input[k] : current[k])
      const entityType    = pick('entityType')
      const connectorKind = validateConnectorKind(entityType, pick('connectorKind'))
      validateInboundConfig({ entityType, connectorKind, fieldMapping: pick('fieldMapping'), defaultValues: pick('defaultValues'), valueMapping: pick('valueMapping') })
      sets.push('w.connector_kind = $connectorKind')
      params['connectorKind'] = connectorKind
    }
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:InboundWebhook {id: $id, tenant_id: $t}) SET ${sets.join(', ')} RETURN properties(w) AS props`, params)
    // La sorgente è in cache (10 s) nei servizi dell'Event Management: ogni scrittura la invalida.
    invalidateSourceCache(ctx.tenantId, args.id)
    return mapInbound(firstRow(rows, 'InboundWebhook').props)
  }, true)
}

/**
 * Elimina la sorgente E chiude i suoi allarmi ancora accesi (revisione 2 ·
 * D4.1). Prima era un `DETACH DELETE` nudo: gli Event restavano `firing` per
 * sempre — nessun payload `resolved` sarebbe più arrivato, la sorgente non
 * esiste — quindi i CI restavano `down` con `health_source = monitoring`, i
 * loro incident aperti e i servizi degradati, finché qualcuno non risolveva a
 * mano ogni allarme. Lo scenario è comune in adozione: sorgente configurata
 * male, cancellata e ricreata.
 *
 * La cancellazione e la risoluzione degli allarmi stanno nella stessa
 * transazione; dopo il commit la salute dei CI toccati viene ricalcolata e gli
 * allarmi ripassano dalla pipeline, che chiude gli incident per la via normale
 * (services/events/cascade.ts). Il risultato porta i conteggi: l'interfaccia
 * può dire quanti allarmi ha chiuso.
 */
async function deleteInboundWebhook(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const { deleteSourceAndResolveEvents } = await import('../../services/events/cascade.js')
  try {
    return await deleteSourceAndResolveEvents(ctx.tenantId, args.id, ctx.userId)
  } finally {
    // Anche se la riconciliazione post-commit fallisce, la sorgente non c'è più:
    // la cache in memoria (10 s) dei servizi dell'Event Management va invalidata.
    invalidateSourceCache(ctx.tenantId, args.id)
  }
}

async function regenerateWebhookToken(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const token = genToken()
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $t}) SET w.secret = $secret, w.updated_at = $now RETURN properties(w) AS props
    `, { id: args.id, t: ctx.tenantId, secret: hash(token), now: new Date().toISOString() })
    invalidateSourceCache(ctx.tenantId, args.id)
    return { ...mapInbound(firstRow(rows, 'InboundWebhook').props), token }
  }, true)
}

// ── Outbound Webhooks ────────────────────────────────────────────────────────

async function outboundWebhooks(_: unknown, args: { filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const params: Props = { t: ctx.tenantId }
    const allowed = new Set(['name', 'url', 'enabled', 'send_count'])
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 'w') : ''
    const order = sortClause('w', args.sortField, args.sortDirection, { name: 'w.name', url: 'w.url', enabled: 'w.enabled', sendCount: 'w.send_count', lastSentAt: 'w.last_sent_at' }, 'name')
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:OutboundWebhook {tenant_id: $t}) ${advWhere ? `WHERE ${advWhere}` : ''} RETURN properties(w) AS props ${order}`, params)
    return rows.map(r => mapOutbound(r.props))
  })
}

async function createOutboundWebhook(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  // SSRF guard at configuration time (ValidationError → BAD_USER_INPUT); the
  // delivery worker re-checks at send time (DNS may change).
  await assertSafeOutboundUrl(String(input['url'] ?? ''))
  const id = uuidv4()
  const now = new Date().toISOString()
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      CREATE (w:OutboundWebhook {id: $id, tenant_id: $t, name: $name, url: $url, method: $method,
        headers: $headers, events: $events, payload_template: $payloadTemplate,
        secret: $secret, enabled: $enabled, retry_on_failure: $retryOnFailure,
        send_count: 0, error_count: 0, created_at: $now, updated_at: $now})
      RETURN properties(w) AS props
    `, { id, t: ctx.tenantId, name: input['name'], url: input['url'], method: input['method'] ?? 'POST', headers: input['headers'] ?? null, events: input['events'], payloadTemplate: input['payloadTemplate'] ?? null, secret: input['secret'] ?? null, enabled: input['enabled'] ?? true, retryOnFailure: input['retryOnFailure'] ?? true, now })
    return mapOutbound(firstRow(rows, 'OutboundWebhook').props)
  }, true)
}

async function updateOutboundWebhook(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  const { input } = args
  if (input['url'] !== undefined) await assertSafeOutboundUrl(String(input['url'] ?? ''))
  const sets: string[] = ['w.updated_at = $now']
  const params: Props = { id: args.id, t: ctx.tenantId, now: new Date().toISOString() }
  const map: Record<string, string> = { name: 'name', url: 'url', method: 'method', headers: 'headers', events: 'events', payloadTemplate: 'payload_template', secret: 'secret', enabled: 'enabled', retryOnFailure: 'retry_on_failure' }
  for (const [gql, neo] of Object.entries(map)) { if (input[gql] !== undefined) { sets.push(`w.${neo} = $${gql}`); params[gql] = input[gql] } }
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) SET ${sets.join(', ')} RETURN properties(w) AS props`, params)
    return mapOutbound(firstRow(rows, 'OutboundWebhook').props)
  }, true)
}

async function deleteOutboundWebhook(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  await withSession(async (s) => { await runQuery(s, `MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) DETACH DELETE w`, { id: args.id, t: ctx.tenantId }) }, true)
  return true
}

async function testOutboundWebhook(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) RETURN properties(w) AS props`, { id: args.id, t: ctx.tenantId })
    if (!rows[0]) throw new NotFoundError('Webhook')
    const w = rows[0].props
    // Read-SSRF guard: the response body is echoed back to the caller, so an
    // internal URL here would leak internal services. Throws ValidationError.
    await assertSafeOutboundUrl(String(w['url'] ?? ''))
    const body = JSON.stringify({ event_type: 'test', entity: { id: 'test', title: 'Test webhook' }, timestamp: new Date().toISOString(), tenant_id: ctx.tenantId })
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(w['headers'] ? JSON.parse(w['headers'] as string) : {}) }
    if (w['secret']) headers['X-Webhook-Signature'] = createHmac('sha256', w['secret'] as string).update(body).digest('hex')
    const t0 = Date.now()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const res = await fetch(w['url'] as string, { method: (w['method'] as string) ?? 'POST', headers, body, signal: controller.signal })
      clearTimeout(timer)
      const resBody = await res.text().catch(() => '')
      return { success: res.ok, statusCode: res.status, responseBody: resBody.slice(0, 500), error: null, duration: Date.now() - t0 }
    } catch (err) {
      return { success: false, statusCode: null, responseBody: null, error: err instanceof Error ? err.message : String(err), duration: Date.now() - t0 }
    }
  })
}

// ── API Keys ─────────────────────────────────────────────────────────────────

async function apiKeys(_: unknown, args: { filters?: string; sortField?: string; sortDirection?: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const params: Props = { t: ctx.tenantId }
    const allowed = new Set(['name', 'enabled', 'request_count'])
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 'k') : ''
    const order = sortClause('k', args.sortField, args.sortDirection, { name: 'k.name', enabled: 'k.enabled', requestCount: 'k.request_count', lastUsedAt: 'k.last_used_at' }, 'name')
    const rows = await runQuery<{ props: Props }>(s, `MATCH (k:ApiKey {tenant_id: $t}) ${advWhere ? `WHERE ${advWhere}` : ''} RETURN properties(k) AS props ${order}`, params)
    return rows.map(r => mapApiKey(r.props))
  })
}

/**
 * I permessi di una chiave API si validano in scrittura (D-26): `permissions`
 * veniva salvato così com'era, quindi un refuso (`incident:read` al singolare,
 * o `ci:write`, che nessuna rotta richiede) diventava una chiave che non poteva
 * fare niente — e il 403 «Missing permissions» arrivava molto dopo, a chi
 * chiamava. L'elenco è `API_KEY_PERMISSIONS` (`@opengraphity/types`), lo stesso
 * che offre la pagina Integrazioni e che un lint statico confronta con i
 * letterali di `requirePermission` nelle rotte.
 */
export function assertApiKeyPermissions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`permissions must be a list of strings. Allowed: ${API_KEY_PERMISSIONS.join(', ')}`)
  }
  const bad = value.filter((p) => !isApiKeyPermission(p))
  if (bad.length > 0) {
    throw new ValidationError(
      `permissions: ${bad.map((p) => JSON.stringify(p)).join(', ')} ` +
      `${bad.length === 1 ? 'is not a permission' : 'are not permissions'} that any route applies. ` +
      `Allowed: ${API_KEY_PERMISSIONS.join(', ')}`,
    )
  }
  return value as string[]
}

async function createApiKey(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const { input } = args
  const key = genApiKey()
  const id = uuidv4()
  const now = new Date().toISOString()
  const permissions = assertApiKeyPermissions(input['permissions'])
  return withSession(async (s) => {
    await runQuery(s, `
      CREATE (k:ApiKey {id: $id, tenant_id: $t, name: $name, key_hash: $keyHash, key_prefix: $keyPrefix,
        permissions: $permissions, rate_limit: $rateLimit, enabled: true,
        request_count: 0, created_by: $createdBy, expires_at: $expiresAt, created_at: $now, updated_at: $now})
    `, { id, t: ctx.tenantId, name: input['name'], keyHash: hash(key), keyPrefix: key.slice(0, 16), permissions, rateLimit: input['rateLimit'] ?? 60, createdBy: ctx.userId, expiresAt: input['expiresAt'] ?? null, now })
    return { id, name: input['name'] as string, key, keyPrefix: key.slice(0, 16), permissions }
  }, true)
}

async function updateApiKey(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const { input } = args
  const sets: string[] = ['k.updated_at = $now']
  const params: Props = { id: args.id, t: ctx.tenantId, now: new Date().toISOString() }
  if (input['permissions'] !== undefined) input['permissions'] = assertApiKeyPermissions(input['permissions'])
  const map: Record<string, string> = { name: 'name', permissions: 'permissions', rateLimit: 'rate_limit', enabled: 'enabled', expiresAt: 'expires_at' }
  for (const [gql, neo] of Object.entries(map)) { if (input[gql] !== undefined) { sets.push(`k.${neo} = $${gql}`); params[gql] = input[gql] } }
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `MATCH (k:ApiKey {id: $id, tenant_id: $t}) SET ${sets.join(', ')} RETURN properties(k) AS props`, params)
    return mapApiKey(firstRow(rows, 'ApiKey').props)
  }, true)
}

async function deleteApiKey(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  await withSession(async (s) => { await runQuery(s, `MATCH (k:ApiKey {id: $id, tenant_id: $t}) DETACH DELETE k`, { id: args.id, t: ctx.tenantId }) }, true)
  return true
}

async function regenerateApiKey(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const key = genApiKey()
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (k:ApiKey {id: $id, tenant_id: $t}) SET k.key_hash = $keyHash, k.key_prefix = $keyPrefix, k.updated_at = $now RETURN properties(k) AS props
    `, { id: args.id, t: ctx.tenantId, keyHash: hash(key), keyPrefix: key.slice(0, 16), now: new Date().toISOString() })
    const row = firstRow(rows, 'ApiKey')
    return { id: args.id, name: row.props['name'] as string, key, keyPrefix: key.slice(0, 16), permissions: row.props['permissions'] }
  }, true)
}

export const integrationsResolvers = {
  Query:    { inboundWebhooks, outboundWebhooks, apiKeys },
  Mutation: {
    createInboundWebhook, updateInboundWebhook, deleteInboundWebhook, regenerateWebhookToken,
    createOutboundWebhook, updateOutboundWebhook, deleteOutboundWebhook, testOutboundWebhook,
    createApiKey, updateApiKey, deleteApiKey, regenerateApiKey,
  },
}
