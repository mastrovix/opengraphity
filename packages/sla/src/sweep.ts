/**
 * THE SLA SWEEP: the timers Redis lost, rebuilt from the graph (review of 23
 * Sep 2026, wave 7 · A1).
 *
 * An SLA's warning, response breach and resolve breach are delayed jobs, one
 * per ticket, in the tenant's Redis queue. Redis restarted empty, a job
 * evicted or a failed enqueue, and the open SLAs never fired: no breach, no
 * escalation, no notification — while OLA and step deadlines already had a
 * periodic sweep over Neo4j state. This is the same for SLA.
 *
 * Every minute, per tenant, it looks for what should have fired and did not,
 * and fires it through the SAME handler as the job (`fireSLATimer`). The
 * per-ticket jobs stay: they fire at the second, and the sweep waits
 * `SLA_SWEEP_GRACE_MS` past a deadline before acting, so it only recovers what
 * the jobs lost. A timer fired by both (a job running late) is dropped the
 * second time: the handler re-reads the status, and its events carry
 * deterministic ids.
 *
 * The candidates come from two composite indexes over flags that already
 * exist, not from a scan of the tenant's SLAs (170,804 of them in the demo
 * tenant, 961 open): an open SLA not breached is exactly
 * `breached = false AND resolve_met = false` — a resolution always sets one of
 * the two (`resolveSLA`) — and a response still owed is `response_met = false`
 * with no notification sent.
 */
import { getSession, runQuery } from '@opengraphity/neo4j'
import { fireSLATimer } from './scheduler.js'

/** How late past its moment a timer must be before the sweep fires it instead of its job. */
export const SLA_SWEEP_GRACE_MS = 2 * 60_000

export interface SLASweepSummary {
  warnings:  number
  breaches:  number
  responses: number
  failed:    number
}

interface ResolveRow {
  entityId:        string
  entityType:      string
  resolveDeadline: string
  warningMinutes:  unknown
  warningSentFor:  string | null
}

interface ResponseRow {
  entityId:        string
  entityType:      string
  resolveDeadline: string
}

/** The open, running SLAs not yet breached: candidates for a warning or a breach. */
export const SLA_SWEEP_RESOLVE_CYPHER = `
  MATCH (s:SLAStatus {tenant_id: $tenantId, breached: false, resolve_met: false})
  WHERE s.resolved_at IS NULL AND s.paused_at IS NULL
  RETURN s.entity_id AS entityId, s.entity_type AS entityType, s.resolve_deadline AS resolveDeadline,
         s.tier_warning_minutes AS warningMinutes, s.warning_sent_for AS warningSentFor`

/**
 * The open, running SLAs whose response is owed and overdue, never notified.
 * The deadlines are ISO instants written by `toISOString()` (UTC, same
 * length): they compare as strings.
 */
export const SLA_SWEEP_RESPONSE_CYPHER = `
  MATCH (s:SLAStatus {tenant_id: $tenantId, response_met: false})
  WHERE s.response_breach_notified_at IS NULL AND s.resolved_at IS NULL AND s.paused_at IS NULL
    AND s.response_deadline <= $cutoff
  RETURN s.entity_id AS entityId, s.entity_type AS entityType, s.resolve_deadline AS resolveDeadline`

/** One tenant's sweep. A timer that could not fire is counted in `failed`: the caller makes the job fail on it. */
export async function runSLASweep(tenantId: string, now: Date = new Date()): Promise<SLASweepSummary> {
  const summary: SLASweepSummary = { warnings: 0, breaches: 0, responses: 0, failed: 0 }
  const cutoffMs = now.getTime() - SLA_SWEEP_GRACE_MS
  const cutoff = new Date(cutoffMs).toISOString()

  const session = getSession(undefined, 'READ')
  let resolveRows: ResolveRow[]
  let responseRows: ResponseRow[]
  try {
    resolveRows  = await runQuery<ResolveRow>(session, SLA_SWEEP_RESOLVE_CYPHER, { tenantId })
    responseRows = await runQuery<ResponseRow>(session, SLA_SWEEP_RESPONSE_CYPHER, { tenantId, cutoff })
  } finally {
    await session.close()
  }

  const fire = async (name: string, row: { entityId: string; entityType: string; resolveDeadline: string }): Promise<boolean> => {
    try {
      await fireSLATimer(name, { tenantId, entityId: row.entityId, entityType: row.entityType, resolveDeadline: row.resolveDeadline })
      return true
    } catch (err) {
      summary.failed++
      console.error(`[sla:sweep] ${name} for ${row.entityType} ${row.entityId} (tenant ${tenantId}) failed:`, err)
      return false
    }
  }

  for (const row of resolveRows) {
    const deadlineMs = new Date(row.resolveDeadline).getTime()
    if (Number.isNaN(deadlineMs)) {
      // A status without a readable deadline is a corrupt row: said, not skipped in silence.
      summary.failed++
      console.error(`[sla:sweep] SLAStatus of ${row.entityType} ${row.entityId} (tenant ${tenantId}) has no readable resolve_deadline: ${String(row.resolveDeadline)}`)
      continue
    }
    if (deadlineMs <= cutoffMs) {
      if (await fire('sla.breach', row)) summary.breaches++
      continue
    }
    const lead = Number(row.warningMinutes)
    const warnAtMs = deadlineMs - (Number.isInteger(lead) && lead > 0 ? lead : 0) * 60_000
    if (warnAtMs <= cutoffMs && row.warningSentFor !== row.resolveDeadline) {
      if (await fire('sla.warning', row)) summary.warnings++
    }
  }
  for (const row of responseRows) {
    if (await fire('sla.response_breach', row)) summary.responses++
  }

  return summary
}
