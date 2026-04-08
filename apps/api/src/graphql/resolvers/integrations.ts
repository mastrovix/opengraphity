import { randomBytes, createHash, createHmac } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import { withSession } from './ci-utils.js'
import { runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { logger } from '../../lib/logger.js'

type Props = Record<string, unknown>
const log = logger.child({ module: 'integrations' })

function hash(val: string): string { return createHash('sha256').update(val).digest('hex') }
function genToken(): string { return randomBytes(32).toString('hex') }
function genApiKey(): string { return `og_live_${randomBytes(32).toString('hex')}` }

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapInbound(p: Props) {
  return {
    id: p['id'], name: p['name'], entityType: p['entity_type'],
    fieldMapping: p['field_mapping'], defaultValues: p['default_values'] ?? null,
    transformScript: p['transform_script'] ?? null, enabled: p['enabled'] ?? false,
    lastReceivedAt: p['last_received_at'] ?? null, receiveCount: Number(p['receive_count'] ?? 0),
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
  const token = genToken()
  const id = uuidv4()
  const now = new Date().toISOString()
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      CREATE (w:InboundWebhook {id: $id, tenant_id: $t, name: $name, entity_type: $entityType,
        secret: $secret, field_mapping: $fieldMapping, default_values: $defaultValues,
        transform_script: $transformScript, enabled: true, receive_count: 0, created_at: $now, updated_at: $now})
      RETURN properties(w) AS props
    `, { id, t: ctx.tenantId, name: input['name'], entityType: input['entityType'], secret: hash(token), fieldMapping: input['fieldMapping'], defaultValues: input['defaultValues'] ?? null, transformScript: input['transformScript'] ?? null, now })
    return { ...mapInbound(rows[0]!.props), token }
  }, true)
}

async function updateInboundWebhook(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const sets: string[] = ['w.updated_at = $now']
  const params: Props = { id: args.id, t: ctx.tenantId, now: new Date().toISOString() }
  const map: Record<string, string> = { name: 'name', entityType: 'entity_type', fieldMapping: 'field_mapping', defaultValues: 'default_values', transformScript: 'transform_script', enabled: 'enabled' }
  for (const [gql, neo] of Object.entries(map)) { if (input[gql] !== undefined) { sets.push(`w.${neo} = $${gql}`); params[gql] = input[gql] } }
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:InboundWebhook {id: $id, tenant_id: $t}) SET ${sets.join(', ')} RETURN properties(w) AS props`, params)
    return mapInbound(rows[0]!.props)
  }, true)
}

async function deleteInboundWebhook(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  await withSession(async (s) => { await runQuery(s, `MATCH (w:InboundWebhook {id: $id, tenant_id: $t}) DETACH DELETE w`, { id: args.id, t: ctx.tenantId }) }, true)
  return true
}

async function regenerateWebhookToken(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const token = genToken()
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $t}) SET w.secret = $secret, w.updated_at = $now RETURN properties(w) AS props
    `, { id: args.id, t: ctx.tenantId, secret: hash(token), now: new Date().toISOString() })
    return { ...mapInbound(rows[0]!.props), token }
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
    return mapOutbound(rows[0]!.props)
  }, true)
}

async function updateOutboundWebhook(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const sets: string[] = ['w.updated_at = $now']
  const params: Props = { id: args.id, t: ctx.tenantId, now: new Date().toISOString() }
  const map: Record<string, string> = { name: 'name', url: 'url', method: 'method', headers: 'headers', events: 'events', payloadTemplate: 'payload_template', secret: 'secret', enabled: 'enabled', retryOnFailure: 'retry_on_failure' }
  for (const [gql, neo] of Object.entries(map)) { if (input[gql] !== undefined) { sets.push(`w.${neo} = $${gql}`); params[gql] = input[gql] } }
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) SET ${sets.join(', ')} RETURN properties(w) AS props`, params)
    return mapOutbound(rows[0]!.props)
  }, true)
}

async function deleteOutboundWebhook(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  await withSession(async (s) => { await runQuery(s, `MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) DETACH DELETE w`, { id: args.id, t: ctx.tenantId }) }, true)
  return true
}

async function testOutboundWebhook(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) RETURN properties(w) AS props`, { id: args.id, t: ctx.tenantId })
    if (!rows[0]) throw new Error('Webhook not found')
    const w = rows[0].props
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

async function createApiKey(_: unknown, args: { input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const key = genApiKey()
  const id = uuidv4()
  const now = new Date().toISOString()
  return withSession(async (s) => {
    await runQuery(s, `
      CREATE (k:ApiKey {id: $id, tenant_id: $t, name: $name, key_hash: $keyHash, key_prefix: $keyPrefix,
        permissions: $permissions, rate_limit: $rateLimit, enabled: true,
        request_count: 0, created_by: $createdBy, expires_at: $expiresAt, created_at: $now, updated_at: $now})
    `, { id, t: ctx.tenantId, name: input['name'], keyHash: hash(key), keyPrefix: key.slice(0, 16), permissions: input['permissions'], rateLimit: input['rateLimit'] ?? 60, createdBy: ctx.userId, expiresAt: input['expiresAt'] ?? null, now })
    return { id, name: input['name'] as string, key, keyPrefix: key.slice(0, 16), permissions: input['permissions'] }
  }, true)
}

async function updateApiKey(_: unknown, args: { id: string; input: Props }, ctx: GraphQLContext) {
  const { input } = args
  const sets: string[] = ['k.updated_at = $now']
  const params: Props = { id: args.id, t: ctx.tenantId, now: new Date().toISOString() }
  const map: Record<string, string> = { name: 'name', permissions: 'permissions', rateLimit: 'rate_limit', enabled: 'enabled', expiresAt: 'expires_at' }
  for (const [gql, neo] of Object.entries(map)) { if (input[gql] !== undefined) { sets.push(`k.${neo} = $${gql}`); params[gql] = input[gql] } }
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `MATCH (k:ApiKey {id: $id, tenant_id: $t}) SET ${sets.join(', ')} RETURN properties(k) AS props`, params)
    return mapApiKey(rows[0]!.props)
  }, true)
}

async function deleteApiKey(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  await withSession(async (s) => { await runQuery(s, `MATCH (k:ApiKey {id: $id, tenant_id: $t}) DETACH DELETE k`, { id: args.id, t: ctx.tenantId }) }, true)
  return true
}

async function regenerateApiKey(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const key = genApiKey()
  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (k:ApiKey {id: $id, tenant_id: $t}) SET k.key_hash = $keyHash, k.key_prefix = $keyPrefix, k.updated_at = $now RETURN properties(k) AS props
    `, { id: args.id, t: ctx.tenantId, keyHash: hash(key), keyPrefix: key.slice(0, 16), now: new Date().toISOString() })
    return { id: args.id, name: rows[0]!.props['name'] as string, key, keyPrefix: key.slice(0, 16), permissions: rows[0]!.props['permissions'] }
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
