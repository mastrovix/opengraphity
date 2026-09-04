import { v4 as uuidv4 } from 'uuid'
import { runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { requireRole } from '../../lib/requireRole.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'

type Props = Record<string, unknown>

// Neo4j integers arrive as {low, high} or bigint-like objects.
function toInt(v: unknown): number {
  if (v == null) return 0
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function') return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}
function toNum(v: unknown): number | null {
  if (v == null) return null
  const n = toInt(v)
  return Number.isFinite(n) ? n : null
}

const VALID_TYPES = ['ola', 'uc']
const VALID_ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request', 'any']

// Resolved-timestamp field per entity type — used by the attainment calc.
const RESOLVED_FIELD: Record<string, { label: string; resolvedField: string }> = {
  incident:        { label: 'Incident',        resolvedField: 'resolved_at' },
  problem:         { label: 'Problem',         resolvedField: 'resolved_at' },
  service_request: { label: 'ServiceRequest',  resolvedField: 'completed_at' },
}

function mapOLA(p: Props, teamName: string | null) {
  return {
    id:              p['id']              as string,
    type:            p['type']            as string,
    name:            p['name']            as string,
    description:     (p['description']     ?? null) as string | null,
    entityType:      p['entity_type']     as string,
    responseMinutes: toInt(p['response_minutes']),
    resolveMinutes:  toInt(p['resolve_minutes']),
    businessHours:   (p['business_hours']  ?? false) as boolean,
    partyType:       (p['party_type']      ?? null) as string | null,
    partyName:       (p['party_name']      ?? null) as string | null,
    teamId:          (p['team_id']         ?? null) as string | null,
    teamName,
    enabled:         (p['enabled']         ?? true) as boolean,
    createdAt:       p['created_at']       as string,
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function olaContracts(_: unknown, args: { type?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; teamName: string | null }>(session, `
      MATCH (o:OLAContract {tenant_id: $tenantId})
      ${args.type ? 'WHERE o.type = $type' : ''}
      OPTIONAL MATCH (t:Team {id: o.team_id, tenant_id: $tenantId})
      RETURN properties(o) AS props, t.name AS teamName
      ORDER BY o.type, o.name
    `, { tenantId: ctx.tenantId, type: args.type ?? null })
    return rows.map((r) => mapOLA(r.props, r.teamName))
  })
}

// ── SLA Report ────────────────────────────────────────────────────────────────

interface SLAPriorityRow { priority: string; total: number; met: number; breached: number }

export async function slaReport(_: unknown, args: { windowDays?: number }, ctx: GraphQLContext) {
  const windowDays = Math.min(365, Math.max(1, args.windowDays ?? 30))
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60_000).toISOString()

  return withSession(async (session) => {
    // ── SLA compliance over SLAStatus nodes started within the window ──────────
    const complianceRows = await runQuery<Props>(session, `
      MATCH (e {tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      WHERE (e:Incident OR e:Problem OR e:ServiceRequest) AND s.started_at >= $cutoff
      WITH s,
        CASE WHEN s.resolve_met = true THEN 1 ELSE 0 END AS met,
        CASE WHEN s.breached = true AND coalesce(s.resolve_met, false) = false THEN 1 ELSE 0 END AS breached,
        CASE WHEN s.paused_at IS NOT NULL AND coalesce(s.resolve_met, false) = false THEN 1 ELSE 0 END AS paused
      RETURN
        count(s)                        AS total,
        sum(met)                        AS met,
        sum(breached)                   AS breached,
        sum(paused)                     AS paused
    `, { tenantId: ctx.tenantId, cutoff })

    const c = complianceRows[0] ?? {}
    const total    = toInt(c['total'])
    const met      = toInt(c['met'])
    const breached = toInt(c['breached'])
    const paused   = toInt(c['paused'])
    const openOnTrack = Math.max(0, total - met - breached - paused)
    const concluded   = met + breached
    const breachRate  = concluded > 0 ? (breached / concluded) * 100 : 0

    // ── By priority (SLA tier severity) ───────────────────────────────────────
    const byPriorityRows = await runQuery<Props>(session, `
      MATCH (e {tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      WHERE (e:Incident OR e:Problem OR e:ServiceRequest) AND s.started_at >= $cutoff
      WITH coalesce(s.tier_severity, 'unknown') AS priority,
        CASE WHEN s.resolve_met = true THEN 1 ELSE 0 END AS met,
        CASE WHEN s.breached = true AND coalesce(s.resolve_met, false) = false THEN 1 ELSE 0 END AS breached
      RETURN priority, count(*) AS total, sum(met) AS met, sum(breached) AS breached
      ORDER BY total DESC
    `, { tenantId: ctx.tenantId, cutoff })

    const byPriority: SLAPriorityRow[] = byPriorityRows.map((r) => ({
      priority: r['priority'] as string,
      total:    toInt(r['total']),
      met:      toInt(r['met']),
      breached: toInt(r['breached']),
    }))

    // ── Average resolution time (incidents resolved within the window) ─────────
    const avgRows = await runQuery<Props>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE i.resolved_at IS NOT NULL AND i.resolved_at >= $cutoff AND i.created_at IS NOT NULL
      WITH duration.inSeconds(datetime(i.created_at), datetime(i.resolved_at)).seconds AS secs
      RETURN avg(secs / 60.0) AS avgMinutes
    `, { tenantId: ctx.tenantId, cutoff })
    const avgResolutionMinutes = toNum(avgRows[0]?.['avgMinutes'])

    // ── OLA/UC attainment per contract ────────────────────────────────────────
    const contracts = await runQuery<Props>(session, `
      MATCH (o:OLAContract {tenant_id: $tenantId})
      WHERE coalesce(o.enabled, true) = true
      RETURN properties(o) AS props
      ORDER BY o.type, o.name
    `, { tenantId: ctx.tenantId })

    const ola = []
    for (const row of contracts) {
      const o = row['props'] as Props
      const entityType = (o['entity_type'] as string) || 'incident'
      const mapping = RESOLVED_FIELD[entityType === 'any' ? 'incident' : entityType]
      const resolveMinutes = toInt(o['resolve_minutes'])

      let evaluated = 0, cMet = 0, cBreached = 0
      if (mapping) {
        const attRows = await runQuery<Props>(session, `
          MATCH (e:${mapping.label} {tenant_id: $tenantId})
          WHERE e.${mapping.resolvedField} IS NOT NULL AND e.${mapping.resolvedField} >= $cutoff AND e.created_at IS NOT NULL
          WITH duration.inSeconds(datetime(e.created_at), datetime(e.${mapping.resolvedField})).seconds AS secs
          WITH (secs / 60.0) AS mins
          RETURN count(*) AS evaluated,
                 sum(CASE WHEN mins <= $resolveMinutes THEN 1 ELSE 0 END) AS met,
                 sum(CASE WHEN mins >  $resolveMinutes THEN 1 ELSE 0 END) AS breached
        `, { tenantId: ctx.tenantId, cutoff, resolveMinutes })
        evaluated = toInt(attRows[0]?.['evaluated'])
        cMet      = toInt(attRows[0]?.['met'])
        cBreached = toInt(attRows[0]?.['breached'])
      }

      ola.push({
        id:             o['id']            as string,
        type:           o['type']          as string,
        name:           o['name']          as string,
        entityType,
        partyType:      (o['party_type']    ?? null) as string | null,
        partyName:      (o['party_name']    ?? null) as string | null,
        resolveMinutes,
        evaluated,
        met:            cMet,
        breached:       cBreached,
        attainmentPct:  evaluated > 0 ? (cMet / evaluated) * 100 : null,
      })
    }

    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      sla: { total, met, breached, paused, openOnTrack, breachRate, avgResolutionMinutes, byPriority },
      ola,
    }
  })
}

// ── Mutations ─────────────────────────────────────────────────────────────────

interface OLAInput {
  type?: string; name?: string; description?: string; entityType?: string
  responseMinutes?: number; resolveMinutes?: number; businessHours?: boolean
  partyType?: string; partyName?: string; teamId?: string; enabled?: boolean
}

export async function createOLAContract(_: unknown, args: { input: OLAInput }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const { input } = args
  if (!VALID_TYPES.includes(input.type ?? '')) throw new ValidationError(`type deve essere uno di: ${VALID_TYPES.join(', ')}`)
  if (!VALID_ENTITY_TYPES.includes(input.entityType ?? '')) throw new ValidationError(`entityType deve essere uno di: ${VALID_ENTITY_TYPES.join(', ')}`)
  const name = input.name?.trim()
  if (!name) throw new ValidationError('name è obbligatorio')
  if (!input.responseMinutes || input.responseMinutes <= 0) throw new ValidationError('responseMinutes deve essere > 0')
  if (!input.resolveMinutes || input.resolveMinutes <= 0) throw new ValidationError('resolveMinutes deve essere > 0')

  const id = uuidv4(); const now = new Date().toISOString()
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; teamName: string | null }>(session, `
      CREATE (o:OLAContract {
        id: $id, tenant_id: $tenantId, type: $type, name: $name, description: $description,
        entity_type: $entityType, response_minutes: $responseMinutes, resolve_minutes: $resolveMinutes,
        business_hours: $businessHours, party_type: $partyType, party_name: $partyName,
        team_id: $teamId, enabled: true, created_at: $now
      })
      WITH o
      OPTIONAL MATCH (t:Team {id: o.team_id, tenant_id: $tenantId})
      RETURN properties(o) AS props, t.name AS teamName
    `, {
      id, tenantId: ctx.tenantId, type: input.type, name,
      description: input.description ?? null, entityType: input.entityType,
      responseMinutes: input.responseMinutes, resolveMinutes: input.resolveMinutes,
      businessHours: input.businessHours ?? false, partyType: input.partyType ?? null,
      partyName: input.partyName ?? null, teamId: input.teamId ?? null, now,
    })
    void audit(ctx, 'ola_contract.created', 'OLAContract', id)
    return mapOLA(rows[0]!.props, rows[0]!.teamName)
  }, true)
}

export async function updateOLAContract(_: unknown, args: { id: string; input: OLAInput }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const { input } = args
  if (input.type !== undefined) throw new ValidationError('type non è modificabile')
  if (input.entityType !== undefined && !VALID_ENTITY_TYPES.includes(input.entityType)) {
    throw new ValidationError(`entityType deve essere uno di: ${VALID_ENTITY_TYPES.join(', ')}`)
  }
  const sets: Record<string, unknown> = {}
  if (input.name !== undefined)            sets['name']             = input.name
  if (input.description !== undefined)     sets['description']      = input.description
  if (input.entityType !== undefined)      sets['entity_type']      = input.entityType
  if (input.responseMinutes !== undefined) sets['response_minutes'] = input.responseMinutes
  if (input.resolveMinutes !== undefined)  sets['resolve_minutes']  = input.resolveMinutes
  if (input.businessHours !== undefined)   sets['business_hours']   = input.businessHours
  if (input.partyType !== undefined)       sets['party_type']       = input.partyType
  if (input.partyName !== undefined)       sets['party_name']       = input.partyName
  if (input.teamId !== undefined)          sets['team_id']          = input.teamId
  if (input.enabled !== undefined)         sets['enabled']          = input.enabled
  if (Object.keys(sets).length === 0) throw new ValidationError('updateOLAContract: nessun campo da aggiornare')

  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; teamName: string | null }>(session, `
      MATCH (o:OLAContract {id: $id, tenant_id: $tenantId})
      SET o += $sets
      WITH o
      OPTIONAL MATCH (t:Team {id: o.team_id, tenant_id: $tenantId})
      RETURN properties(o) AS props, t.name AS teamName
    `, { id: args.id, tenantId: ctx.tenantId, sets })
    if (!rows[0]) throw new NotFoundError('OLAContract', args.id)
    void audit(ctx, 'ola_contract.updated', 'OLAContract', args.id)
    return mapOLA(rows[0].props, rows[0].teamName)
  }, true)
}

export const olaResolvers = {
  Query:    { olaContracts, slaReport },
  Mutation: { createOLAContract, updateOLAContract },
}
