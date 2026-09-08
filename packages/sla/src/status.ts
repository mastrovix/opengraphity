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
  /** true only if the entity was resolved within `resolve_deadline` (net of pauses). */
  resolve_met: boolean
  /** Set when the resolve deadline elapsed unresolved; NEVER cleared by a later resolution. */
  breached: boolean
  /** Instant the entity was resolved/completed, when known. */
  resolved_at?: string
  paused_at?: string
  paused_type?: string   // 'resolve' | 'response' | 'both' — which clock is paused
  tier: SLATier
}

/** Columns returned by every SLAStatus read — one source for the projection. */
const SLA_STATUS_PROJECTION = `
      s.id as id, s.tenant_id as tenant_id, s.entity_id as entity_id,
      s.entity_type as entity_type, s.started_at as started_at,
      s.response_deadline as response_deadline, s.resolve_deadline as resolve_deadline,
      s.response_met as response_met, s.resolve_met as resolve_met,
      s.breached as breached, s.resolved_at as resolved_at,
      s.paused_at as paused_at, s.paused_type as paused_type,
      s.tier_severity as tier_severity,
      s.tier_response_minutes as tier_response_minutes,
      s.tier_resolve_minutes as tier_resolve_minutes,
      s.tier_business_hours as tier_business_hours
`

export type SLAPauseType = 'resolve' | 'response' | 'both'

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
    resolved_at:       (props['resolved_at'] ?? undefined) as string | undefined,
    paused_at:         props['paused_at']         as string | undefined,
    paused_type:       props['paused_type']       as string | undefined,
    tier: {
      severity:         props['tier_severity']         as string,
      response_minutes: props['tier_response_minutes'] as number,
      resolve_minutes:  props['tier_resolve_minutes']  as number,
      business_hours:   props['tier_business_hours']   as boolean,
    },
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * `created_at` of the SLA-bearing entity (Incident/Problem/ServiceRequest).
 * The SLA clock starts when the entity was created, not when the consumer
 * happened to process the event (retries/backoff would otherwise push every
 * deadline forward — D-29). Throws if the entity or its created_at is missing:
 * an SLA anchored to an unknown instant is worse than a failed, retried job.
 */
export async function getEntityCreatedAt(tenantId: string, entityId: string): Promise<Date> {
  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    RETURN e.created_at AS created_at
  `
  const session = readSession()
  try {
    const row = await runQueryOne<{ created_at: unknown }>(session, cypher, { tenantId, entityId })
    if (!row) throw new Error(`[sla:status] Entity ${entityId} not found for tenant ${tenantId}`)
    return parseInstant(row.created_at, `created_at of entity ${entityId}`)
  } finally {
    await session.close()
  }
}

/** ISO string → Date, loud on anything unparseable. */
function parseInstant(value: unknown, what: string): Date {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`[sla:status] ${what} is missing or not an ISO string (got ${JSON.stringify(value)})`)
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`[sla:status] ${what} is not a valid instant: "${value}"`)
  return d
}

export async function createSLAStatus(params: {
  tenantId: string
  entityId: string
  entityType: string
  severity: string
  policy: SLAPolicy
  /** Instant the SLA clock starts (the entity's created_at). Defaults to now. */
  startedAt?: Date
}): Promise<SLAStatus> {
  const { tenantId, entityId, entityType, severity, policy } = params

  const tier = policy.tiers.find((t) => t.severity === severity)
  if (!tier) {
    throw new Error(
      `[sla:status] No tier found for severity "${severity}" in policy "${policy.id}"`,
    )
  }

  const now              = params.startedAt ?? new Date()
  const responseDeadline = calculateDeadline(now, tier.response_minutes, tier.business_hours, policy.timezone)
  const resolveDeadline  = calculateDeadline(now, tier.resolve_minutes,  tier.business_hours, policy.timezone)

  const id = randomUUID()

  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    // MERGE (not CREATE): an at-least-once redelivery of entity.created must not
    // create a second SLAStatus for the same entity. ON CREATE sets the fields
    // once; a redelivery returns the existing status unchanged.
    MERGE (e)-[:HAS_SLA]->(s:SLAStatus { tenant_id: $tenantId, entity_id: $entityId })
    ON CREATE SET
      s.id                    = $id,
      s.entity_type           = $entityType,
      s.started_at            = $startedAt,
      s.response_deadline     = $responseDeadline,
      s.resolve_deadline      = $resolveDeadline,
      s.response_met          = false,
      s.resolve_met           = false,
      s.breached              = false,
      s.tier_severity         = $tierSeverity,
      s.tier_response_minutes = $tierResponseMinutes,
      s.tier_resolve_minutes  = $tierResolveMinutes,
      s.tier_business_hours   = $tierBusinessHours
    RETURN ${SLA_STATUS_PROJECTION}
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
    RETURN ${SLA_STATUS_PROJECTION}
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

/**
 * Records the resolution of the entity at `resolvedAt` and decides the SLA
 * outcome (D-02):
 *   - `resolve_met = true`  only if `resolvedAt <= resolve_deadline` (the
 *     deadline is extended by the still-open pause, if the SLA was paused when
 *     the entity got resolved);
 *   - otherwise `resolve_met = false` and `breached = true`.
 * `breached` is never cleared: a breach that later got resolved stays a breach
 * in the compliance history. Also stores `resolved_at` and closes any pause.
 * Returns the updated status, or null if the entity has no SLAStatus.
 */
export async function markResolveMet(
  tenantId: string,
  entityId: string,
  resolvedAt: Date = new Date(),
): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  if (!current) return null
  if (Number.isNaN(resolvedAt.getTime())) {
    throw new Error(`[sla:status] markResolveMet(${entityId}): resolvedAt is not a valid instant`)
  }

  const deadline = parseInstant(current.resolve_deadline, `resolve_deadline of SLAStatus ${current.id}`)
  // A pause still open at resolution time extends the deadline by its duration,
  // exactly as resumeSLA would have done.
  const pausedResolve = current.paused_at && (current.paused_type ?? 'both') !== 'response'
  const pauseShiftMs = pausedResolve
    ? Math.max(0, resolvedAt.getTime() - parseInstant(current.paused_at, `paused_at of SLAStatus ${current.id}`).getTime())
    : 0
  const effectiveDeadlineMs = deadline.getTime() + pauseShiftMs
  const met = resolvedAt.getTime() <= effectiveDeadlineMs

  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    SET s.resolve_met = $met,
        s.breached    = CASE WHEN $met THEN coalesce(s.breached, false) ELSE true END,
        s.resolved_at = $resolvedAt,
        s.paused_at   = null,
        s.paused_type = null
    RETURN ${SLA_STATUS_PROJECTION}
  `
  const session = writeSession()
  try {
    const row = await runQueryOne<Record<string, unknown>>(session, cypher, {
      tenantId, entityId, met, resolvedAt: resolvedAt.toISOString(),
    })
    if (!row) throw new Error(`[sla:status] markResolveMet(${entityId}): SLAStatus vanished during update`)
    return mapToSLAStatus(row)
  } finally {
    await session.close()
  }
}

/**
 * Stops the SLA clock for the given target(s). Sets `paused_at`/`paused_type`,
 * unless the SLA is already paused or already resolved (nothing to pause).
 * `slaType` picks which clock stops: 'resolve' (warning+breach timers),
 * 'response' (response timer), or 'both'. Returns the updated status (carrying
 * `paused_type`), or null if there was nothing to pause. The caller cancels the
 * corresponding jobs — a paused clock must not fire timers.
 */
export async function pauseSLA(
  tenantId: string,
  entityId: string,
  slaType: SLAPauseType = 'both',
): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  if (!current || current.paused_at || current.resolve_met) return null

  const now = new Date().toISOString()
  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    SET s.paused_at = $now, s.paused_type = $slaType
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId, now, slaType })
  } finally {
    await session.close()
  }
  return { ...current, paused_at: now, paused_type: slaType }
}

/**
 * Restarts the SLA clock. Extends the paused deadline(s) by the elapsed pause
 * duration so the remaining time is preserved, clears `paused_at`/`paused_type`,
 * and returns the updated status. Which deadline shifts depends on the
 * `paused_type` recorded at pause time. Returns null if the SLA was not paused.
 * The caller re-schedules the timers against the new deadlines.
 */
export async function resumeSLA(tenantId: string, entityId: string): Promise<SLAStatus | null> {
  const current = await getSLAStatus(tenantId, entityId)
  if (!current || !current.paused_at) return null

  const pausedType = (current.paused_type ?? 'both') as SLAPauseType
  const pausedMs = Date.now() - new Date(current.paused_at).getTime()
  // Guard against a corrupt/future paused_at producing a negative shift.
  const shiftMs = Math.max(0, pausedMs)
  const shiftResponse = pausedType === 'response' || pausedType === 'both'
  const shiftResolve  = pausedType === 'resolve'  || pausedType === 'both'
  const newResponse = shiftResponse
    ? new Date(new Date(current.response_deadline).getTime() + shiftMs).toISOString()
    : current.response_deadline
  const newResolve = shiftResolve
    ? new Date(new Date(current.resolve_deadline).getTime() + shiftMs).toISOString()
    : current.resolve_deadline

  const cypher = `
    MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
    WHERE e:Incident OR e:Problem OR e:ServiceRequest
    SET s.response_deadline = $newResponse,
        s.resolve_deadline  = $newResolve,
        s.paused_at         = null,
        s.paused_type       = null
  `
  const session = writeSession()
  try {
    await runQuery(session, cypher, { tenantId, entityId, newResponse, newResolve })
  } finally {
    await session.close()
  }
  return {
    ...current,
    response_deadline: newResponse,
    resolve_deadline:  newResolve,
    paused_at:         undefined,
    paused_type:       pausedType,   // report which clock resumed so the caller reschedules
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
