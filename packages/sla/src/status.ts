import { randomUUID } from 'crypto'
import { getDriver, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { calculateDeadline, type SLATier, type SLAPolicy } from './policy.js'

export interface SLAStatus {
  id: string
  tenant_id: string
  entity_id: string
  entity_type: string
  started_at: string
  response_deadline: string
  resolve_deadline: string
  response_met: boolean
  resolve_met: boolean
  breached: boolean
  paused_at?: string
  tier: SLATier
}

// ── Session helpers ──────────────────────────────────────────────────────────

function readSession() {
  return getDriver().session({ defaultAccessMode: 'READ' as const })
}

function writeSession() {
  return getDriver().session({ defaultAccessMode: 'WRITE' as const })
}

// ── Node → SLAStatus mapping ─────────────────────────────────────────────────

function mapToSLAStatus(props: Record<string, unknown>): SLAStatus {
  return {
    id:                props['id']                as string,
    tenant_id:         props['tenant_id']         as string,
    entity_id:         props['entity_id']         as string,
    entity_type:       props['entity_type']       as string,
    started_at:        props['started_at']        as string,
    response_deadline: props['response_deadline'] as string,
    resolve_deadline:  props['resolve_deadline']  as string,
    response_met:      props['response_met']      as boolean,
    resolve_met:       props['resolve_met']       as boolean,
    breached:          props['breached']          as boolean,
    paused_at:         props['paused_at']         as string | undefined,
    tier: {
      severity:         props['tier_severity']         as string,
      response_minutes: props['tier_response_minutes'] as number,
      resolve_minutes:  props['tier_resolve_minutes']  as number,
      business_hours:   props['tier_business_hours']   as boolean,
    },
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createSLAStatus(params: {
  tenantId: string
  entityId: string
  entityType: string
  severity: string
  policy: SLAPolicy
}): Promise<SLAStatus> {
  const { tenantId, entityId, entityType, severity, policy } = params

  const tier = policy.tiers.find((t) => t.severity === severity)
  if (!tier) {
    throw new Error(
      `[sla:status] No tier found for severity "${severity}" in policy "${policy.id}"`,
    )
  }

  const now              = new Date()
  const responseDeadline = calculateDeadline(now, tier.response_minutes, tier.business_hours, policy.timezone)
  const resolveDeadline  = calculateDeadline(now, tier.resolve_minutes,  tier.business_hours, policy.timezone)

  const id = randomUUID()

  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    CREATE (s:SLAStatus {
      id:                    $id,
      tenant_id:             $tenantId,
      entity_id:             $entityId,
      entity_type:           $entityType,
      started_at:            $startedAt,
      response_deadline:     $responseDeadline,
      resolve_deadline:      $resolveDeadline,
      response_met:          false,
      resolve_met:           false,
      breached:              false,
      tier_severity:         $tierSeverity,
      tier_response_minutes: $tierResponseMinutes,
      tier_resolve_minutes:  $tierResolveMinutes,
      tier_business_hours:   $tierBusinessHours
    })
    CREATE (e)-[:HAS_SLA]->(s)
    RETURN
      s.id as id, s.tenant_id as tenant_id, s.entity_id as entity_id,
      s.entity_type as entity_type, s.started_at as started_at,
      s.response_deadline as response_deadline, s.resolve_deadline as resolve_deadline,
      s.response_met as response_met, s.resolve_met as resolve_met,
      s.breached as breached, s.paused_at as paused_at,
      s.tier_severity as tier_severity,
      s.tier_response_minutes as tier_response_minutes,
      s.tier_resolve_minutes as tier_resolve_minutes,
      s.tier_business_hours as tier_business_hours
  `

  const session = writeSession()
  try {
    const results = await runQuery<Record<string, unknown>>(session, cypher, {
      id,
      tenantId,
      entityId,
      entityType,
      startedAt:            now.toISOString(),
      responseDeadline:     responseDeadline.toISOString(),
      resolveDeadline:      resolveDeadline.toISOString(),
      tierSeverity:         tier.severity,
      tierResponseMinutes:  tier.response_minutes,
      tierResolveMinutes:   tier.resolve_minutes,
      tierBusinessHours:    tier.business_hours,
    })

    const row = results[0]
    if (!row) throw new Error(`[sla:status] Failed to create SLAStatus for entity ${entityId}`)
    return mapToSLAStatus(row)
  } finally {
    await session.close()
  }
}

export async function getSLAStatus(
  tenantId: string,
  entityId: string,
): Promise<SLAStatus | null> {
  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    RETURN
      s.id as id, s.tenant_id as tenant_id, s.entity_id as entity_id,
      s.entity_type as entity_type, s.started_at as started_at,
      s.response_deadline as response_deadline, s.resolve_deadline as resolve_deadline,
      s.response_met as response_met, s.resolve_met as resolve_met,
      s.breached as breached, s.paused_at as paused_at,
      s.tier_severity as tier_severity,
      s.tier_response_minutes as tier_response_minutes,
      s.tier_resolve_minutes as tier_resolve_minutes,
      s.tier_business_hours as tier_business_hours
  `

  const session = readSession()
  try {
    const row = await runQueryOne<Record<string, unknown>>(session, cypher, { tenantId, entityId })
    return row ? mapToSLAStatus(row) : null
  } finally {
    await session.close()
  }
}

export async function markResponseMet(tenantId: string, entityId: string): Promise<void> {
  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    SET s.response_met = true
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId })
  } finally {
    await session.close()
  }
}

export async function markResolveMet(tenantId: string, entityId: string): Promise<void> {
  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    SET s.resolve_met = true, s.breached = false
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId })
  } finally {
    await session.close()
  }
}

export async function markBreached(tenantId: string, entityId: string): Promise<void> {
  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    SET s.breached = true
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId })
  } finally {
    await session.close()
  }
}
