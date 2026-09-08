/**
 * Daily email digest — BullMQ repeatable job (C-14, A-27).
 *
 * Scheduling: an hourly `tick` (minute 0, UTC) walks every tenant and sends
 * the digest when it is 08:00 in the tenant's own timezone (`Tenant.timezone`;
 * UTC with a one-time warning when the property is missing). Doing it with a
 * tick instead of one repeatable job per tenant means tenants created after
 * boot and timezone changes are picked up without a restart.
 *
 * Idempotency: before sending, `digest:<tenant>:<localDate>` is claimed on
 * Redis with SET NX (TTL 36h). A crash halfway through the tenant loop, a
 * duplicate tick or a manual re-run can no longer re-send the same digest.
 *
 * Recipients: admin/operator users with `notifications_enabled` not false —
 * the hardcoded `@demo.` / `@opengrafo.com` / `usr-N@` exclusions are gone
 * (a real customer on such a domain was silently never served).
 */
import type { Worker, Job } from 'bullmq'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { sendEmail } from '@opengraphity/notifications'
import { digestDaily } from '../lib/emailTemplates.js'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue, getSharedRedis } from '../lib/bullmq.js'

const log = logger.child({ module: 'email-digest' })

export const EMAIL_DIGEST_QUEUE = 'email-digest'
const DIGEST_LOCAL_HOUR   = 8
const MARKER_TTL_SECONDS  = 36 * 3600

interface TenantRow { id: string; timezone: string | null }

const warnedNoTimezone = new Set<string>()

/** Resolves the tenant's timezone; falls back to UTC with ONE warning per tenant per process. */
export function resolveTenantTimezone(tenant: TenantRow): string {
  if (tenant.timezone) {
    try {
      // Throws RangeError on an unknown IANA name — an invalid stored value
      // must be visible, not silently turned into UTC.
      new Intl.DateTimeFormat('en-US', { timeZone: tenant.timezone })
      return tenant.timezone
    } catch (err) {
      throw new Error(`Tenant ${tenant.id} has an invalid timezone "${tenant.timezone}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!warnedNoTimezone.has(tenant.id)) {
    warnedNoTimezone.add(tenant.id)
    log.warn({ tenantId: tenant.id }, 'Tenant has no timezone property — daily digest uses UTC')
  }
  return 'UTC'
}

/** Local hour (0-23) and local calendar date (YYYY-MM-DD) of `at` in `timeZone`. */
export function localHourAndDate(at: Date, timeZone: string): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  // en-CA yields YYYY-MM-DD ordering; hour "24" appears at midnight in some ICU versions.
  const hour = Number(get('hour')) % 24
  return { hour, date: `${get('year')}-${get('month')}-${get('day')}` }
}

export function digestMarkerKey(tenantId: string, localDate: string): string {
  return `digest:${tenantId}:${localDate}`
}

async function loadTenants(): Promise<TenantRow[]> {
  const session = getSession()
  try {
    return await runQuery<TenantRow>(session, `
      MATCH (t:Tenant) RETURN t.id AS id, t.timezone AS timezone
    `, {})
  } finally {
    await session.close()
  }
}

/**
 * One tick: for every tenant whose local hour is DIGEST_LOCAL_HOUR, claim the
 * daily marker and send. `now` is injectable for tests.
 */
export async function processDigestTick(now: Date = new Date()): Promise<{ sent: string[]; skipped: string[] }> {
  const tenants = await loadTenants()
  const sent: string[] = []
  const skipped: string[] = []
  let failures = 0

  for (const tenant of tenants) {
    try {
      const tz = resolveTenantTimezone(tenant)
      const { hour, date } = localHourAndDate(now, tz)
      if (hour !== DIGEST_LOCAL_HOUR) { skipped.push(tenant.id); continue }

      const claimed = await getSharedRedis().set(digestMarkerKey(tenant.id, date), now.toISOString(), 'EX', MARKER_TTL_SECONDS, 'NX')
      if (claimed !== 'OK') {
        log.info({ tenantId: tenant.id, date }, 'Daily digest already sent for this date — skipped (idempotency marker)')
        skipped.push(tenant.id)
        continue
      }

      await sendDigestForTenant(tenant.id)
      sent.push(tenant.id)
    } catch (err) {
      failures++
      log.error({ tenantId: tenant.id, err }, 'Digest failed for tenant')
    }
  }

  if (failures > 0) {
    // The job must fail visibly when any tenant failed; the marker keeps the
    // successful tenants from being re-sent on retry.
    throw new Error(`[email-digest] digest failed for ${failures} tenant(s) — see log`)
  }
  return { sent, skipped }
}

async function sendDigestForTenant(tenantId: string): Promise<void> {
  const session = getSession()
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  try {
    const { getOpenStepNames, getWorkflowSteps } = await import('../lib/workflowHelpers.js')
    const incidentOpen = await getOpenStepNames(session, tenantId, 'incident')
    const changeOpen   = await getOpenStepNames(session, tenantId, 'change')
    const incidentSteps = await getWorkflowSteps(session, tenantId, 'incident')
    const resolvedStep = (incidentSteps.find(s => s.category === 'resolved') ?? incidentSteps.find(s => s.isTerminal))?.name ?? null

    // Stats
    const stats = await runQuery<Record<string, unknown>>(session, `
      OPTIONAL MATCH (i:Incident {tenant_id: $t}) WHERE i.status IN $incidentOpen
      WITH count(i) AS openInc
      OPTIONAL MATCH (r:Incident {tenant_id: $t}) WHERE r.status = $resolvedStep AND r.resolved_at >= $since
      WITH openInc, count(r) AS resolvedToday
      OPTIONAL MATCH (c:Change {tenant_id: $t})-[:HAS_WORKFLOW]->(wi:WorkflowInstance) WHERE wi.current_step IN $changeOpen AND coalesce(c.deleted, false) = false
      WITH openInc, resolvedToday, count(c) AS ongoingChanges
      OPTIONAL MATCH (s:SLAStatus {tenant_id: $t}) WHERE s.breached = true AND s.started_at >= $since
      RETURN openInc, resolvedToday, ongoingChanges, count(s) AS slaBreaches
    `, { t: tenantId, since: yesterday, incidentOpen, changeOpen, resolvedStep })

    const s = stats[0] ?? {}
    const digestStats = {
      openIncidents:  Number(s['openInc'] ?? 0),
      resolvedToday:  Number(s['resolvedToday'] ?? 0),
      ongoingChanges: Number(s['ongoingChanges'] ?? 0),
      slaBreaches:    Number(s['slaBreaches'] ?? 0),
    }

    // Recent events (last 5 incidents created)
    const recent = await runQuery<{ title: string; status: string; created: string }>(session, `
      MATCH (i:Incident {tenant_id: $t})
      WHERE i.created_at >= $since
      RETURN i.title AS title, i.status AS status, i.created_at AS created
      ORDER BY i.created_at DESC LIMIT 5
    `, { t: tenantId, since: yesterday })

    const recentEvents = recent.map(r => `${r.title} (${r.status})`)

    // Recipients: admin/operator users that did not opt out (A-27). A missing
    // flag means enabled — `u.notifications_enabled <> false` alone would drop
    // every user without the property (null <> false is null in Cypher).
    const users = await runQuery<{ email: string }>(session, `
      MATCH (u:User {tenant_id: $t})
      WHERE u.role IN ['admin', 'operator', 'TENANT_ADMIN', 'OPERATOR']
        AND u.email IS NOT NULL AND u.email <> ''
        AND coalesce(u.notifications_enabled, true) = true
      RETURN u.email AS email
    `, { t: tenantId })

    if (users.length === 0) {
      log.info({ tenantId }, 'Daily digest: no recipients')
      return
    }

    const tpl = digestDaily({ ...digestStats, recentEvents }, tenantId)

    let sendFailures = 0
    for (const { email } of users) {
      try {
        await sendEmail({ to: email, ...tpl })
      } catch (err) {
        sendFailures++
        log.error({ err, email, tenantId }, 'Failed to send digest email')
      }
    }
    if (sendFailures > 0) {
      throw new Error(`[email-digest] ${sendFailures}/${users.length} digest emails failed for tenant ${tenantId}`)
    }

    log.info({ tenantId, recipients: users.length }, 'Daily digest sent')
  } finally {
    await session.close()
  }
}

/**
 * Schedules the hourly tick and starts the worker. Async because the
 * repeatable job registration is awaited: a failed registration is a startup
 * error, not a lost `.then()`.
 */
export async function startEmailDigestWorker(): Promise<Worker> {
  await getQueue(EMAIL_DIGEST_QUEUE).add('digest-tick', {}, {
    repeat:           { pattern: '0 * * * *', tz: 'UTC' },
    jobId:            'email-digest-tick',
    removeOnComplete: true,
  })
  log.info({ localHour: DIGEST_LOCAL_HOUR }, 'Email digest tick scheduled (hourly; sends at 08:00 tenant-local time)')

  return createWorker(EMAIL_DIGEST_QUEUE, async (_job: Job) => {
    log.info('Running email digest tick')
    const { sent, skipped } = await processDigestTick()
    log.info({ sent: sent.length, skipped: skipped.length }, 'Email digest tick done')
  }, { concurrency: 1 })
}
