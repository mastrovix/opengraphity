/**
 * WHAT THE APP'S TIMERS WOULD HAVE LEFT, FOR THE TICKETS STILL OPEN (23 Sep 2026).
 *
 * Two timers of the app look at open tickets:
 *
 *  - the SLA scheduler: when a ticket is created (or resumed after a pause)
 *    the SLA engine queues a warning, a breach check and a response check at
 *    their deadlines. The generated tickets were never "created" by the
 *    engine, so their FUTURE deadlines are queued here, with the scheduler's
 *    own functions — otherwise an open ticket would never turn breached. Past
 *    deadlines are already in the SLA state the generator wrote; their
 *    notifications would have been sent in the past and are not re-sent.
 *
 *  - the OLA sweep: every minute it marks, on each open ticket (and change
 *    task) whose team time went past a contract's target, that the alert was
 *    sent (`ola_alerted`), then sends it. For the generated past those alerts
 *    were sent when the time ran out; the sweep would send them all now, at
 *    once. The same measure (`olaTeamMeasure`, same queries) marks them here
 *    without sending.
 */
import type { Session } from 'neo4j-driver'
import { runQuery, toNumber } from '@opengraphity/neo4j'
import { calendarFor, getTenantTimezone, scheduleBreachCheck, scheduleResponseCheck, scheduleWarning, type SLAStatus } from '@opengraphity/sla'
import { olaEntityTypes, olaTeamMeasure, type OLATicketFacts } from '../../olaAttainment.js'
import { loadChangeUnits, olaUnitAlertKey } from '../../olaChangeUnits.js'
import { olaOpenTicketsCypher } from '../../olaSweep.js'
import { OLA_CONCLUDED_FIELD } from '../../olaAttainment.js'

/**
 * `runId`: the run's own contracts count although they are still switched
 * off — they are switched on after this (enableRunOlaContracts).
 */
export async function markOlaAlerts(session: Session, tenantId: string, now: Date, runId: string | null = null): Promise<number> {
  const contracts = await runQuery<{ id: string; name: string; entityType: string; teamId: string; resolveMinutes: unknown; businessHours: boolean; calendarId: string | null; createdAt: string | null; timezone: string | null }>(session, `
    MATCH (o:OLAContract {tenant_id: $tenantId})
    WHERE (coalesce(o.enabled, true) = true OR o.demo_run_id = $runId) AND o.team_id IS NOT NULL
    RETURN o.id AS id, o.name AS name, o.entity_type AS entityType, o.team_id AS teamId, o.resolve_minutes AS resolveMinutes,
           coalesce(o.business_hours, false) AS businessHours, o.calendar_id AS calendarId, o.created_at AS createdAt, o.timezone AS timezone
  `, { tenantId, runId })
  let marked = 0
  for (const c of contracts) {
    const calendar = await calendarFor(tenantId, { name: c.name, businessHours: c.businessHours, calendarId: c.calendarId })
    const timezone = c.businessHours && !c.timezone ? await getTenantTimezone(tenantId) : 'UTC'
    const rule = { teamId: c.teamId, createdAt: c.createdAt, resolveMinutes: toNumber(c.resolveMinutes), businessHours: c.businessHours, calendar, timezone: c.timezone ?? null }
    for (const entityType of olaEntityTypes(c.entityType || 'incident')) {
      if (entityType === 'change') {
        const units = (await loadChangeUnits(session, tenantId, { by: 'open', teamId: c.teamId })).filter((u) => !u.alerted.includes(olaUnitAlertKey(c.id, u)))
        for (const u of units) {
          if (olaTeamMeasure(u, rule, timezone, now).state !== 'breached') continue
          await session.executeWrite((tx) => tx.run(`MATCH (n:${u.node.label} {id: $id, tenant_id: $tenantId}) SET n.ola_alerted = coalesce(n.ola_alerted, []) + $key`,
            { id: u.node.id, tenantId, key: olaUnitAlertKey(c.id, u) }))
          marked++
        }
        continue
      }
      const tickets = await runQuery<OLATicketFacts & { id: string }>(session, olaOpenTicketsCypher(entityType), { tenantId, teamId: c.teamId, contractId: c.id })
      const breached = tickets.filter((t) => olaTeamMeasure(t, rule, timezone, now).state === 'breached').map((t) => t.id)
      if (!breached.length) continue
      const label = OLA_CONCLUDED_FIELD[entityType]!.label
      await session.executeWrite((tx) => tx.run(`UNWIND $ids AS id MATCH (e:${label} {id: id, tenant_id: $tenantId}) SET e.ola_alerted = coalesce(e.ola_alerted, []) + $contractId`,
        { ids: breached, tenantId, contractId: c.id }))
      marked += breached.length
    }
  }
  return marked
}

/** Switches on the contracts the run wrote switched off (writeReference.ts), once their past alerts are marked. */
export async function enableRunOlaContracts(session: Session, tenantId: string, runId: string): Promise<number> {
  const rows = await runQuery<{ n: unknown }>(session, `
    MATCH (o:OLAContract {tenant_id: $tenantId, demo_run_id: $runId}) WHERE o.enabled = false
    SET o.enabled = true
    RETURN count(o) AS n
  `, { tenantId, runId })
  return toNumber(rows[0]?.n ?? 0)
}

export async function scheduleOpenSlaJobs(session: Session, tenantId: string, now: Date): Promise<number> {
  const rows = await runQuery<{ id: string; entityId: string; entityType: string; resolveDeadline: string; responseDeadline: string; warning: unknown; responseMet: boolean }>(session, `
    MATCH (e)-[:HAS_SLA]->(s:SLAStatus {tenant_id: $tenantId})
    WHERE (e:Incident OR e:Problem OR e:ServiceRequest) AND s.demo_run_id IS NOT NULL
      AND s.resolved_at IS NULL AND s.paused_at IS NULL AND coalesce(s.breached, false) = false
    RETURN s.id AS id, s.entity_id AS entityId, s.entity_type AS entityType, s.resolve_deadline AS resolveDeadline,
           s.response_deadline AS responseDeadline, s.tier_warning_minutes AS warning, coalesce(s.response_met, false) AS responseMet
  `, { tenantId })
  let scheduled = 0
  for (const r of rows) {
    const status = {
      id: r.id, entity_id: r.entityId, entity_type: r.entityType, tenant_id: tenantId,
      resolve_deadline: r.resolveDeadline, response_deadline: r.responseDeadline, tier: { warning_minutes: toNumber(r.warning) },
    } as unknown as SLAStatus
    const resolveAt = Date.parse(r.resolveDeadline)
    if (resolveAt - toNumber(r.warning) * 60_000 > now.getTime()) { await scheduleWarning(status); scheduled++ }
    if (resolveAt > now.getTime()) { await scheduleBreachCheck(status); scheduled++ }
    if (!r.responseMet && Date.parse(r.responseDeadline) > now.getTime()) { await scheduleResponseCheck(status); scheduled++ }
  }
  return scheduled
}
