/**
 * Daily email digest — BullMQ repeatable job (C-14, A-27).
 *
 * WHEN AND TO WHOM IS THE TENANT'S CONFIGURATION (revisione del 14 set 2026 ·
 * NT-8): the notification rule `digest.daily` — its `enabled`, `digest_time`
 * (HH:MM in the tenant's timezone) and `target` (all = admin/operator, or a
 * role; `digest_recipients` when explicit addresses are given). Before, the
 * digest went out at a hard-coded 08:00 to every tenant, and the rule's time
 * created a separate job that did nothing. No enabled rule → no digest.
 *
 * Scheduling: a `tick` every five minutes walks every tenant and sends the
 * digest once the tenant-local time has reached the rule's time. Doing it with
 * a tick instead of one repeatable job per tenant means tenants created after
 * boot, timezone changes and rule edits are picked up without a restart; a
 * tick missed by downtime sends later the same day instead of never.
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
import { TICKET_WORKER_PERMISSION } from '@opengraphity/types'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { loadNotificationLocale, loadTenantBrand, sendTenantEmail } from '@opengraphity/notifications'
import { digestDaily } from '../lib/emailTemplates.js'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue, getSharedRedis } from '../lib/bullmq.js'

const log = logger.child({ module: 'email-digest' })

export const EMAIL_DIGEST_QUEUE = 'email-digest'
const MARKER_TTL_SECONDS  = 36 * 3600

interface TenantRow { id: string; timezone: string | null; digestTime: string | null; target: string | null; recipients: string[] | null }

/**
 * Il fuso dell'organizzazione, o un ERRORE (revisione totale · C-10).
 *
 * Prima si ripiegava su UTC con un avviso solo per processo: il digest
 * quotidiano partiva all'ora sbagliata e il cliente non aveva modo di
 * accorgersene. Ovunque altrove (`getTenantTimezone`, la passata OLA, le
 * scadenze dei passi) un tenant senza fuso è un errore, e la diagnostica lo
 * classifica come tale: qui era l'unica eccezione.
 */
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
  throw new Error(
    `Tenant ${tenant.id} has no timezone: the daily digest cannot be sent at the right local hour. `
    + 'Set it in Settings → Organization.',
  )
}

/** Local hour (0-23), minute and calendar date (YYYY-MM-DD) of `at` in `timeZone`. */
export function localHourAndDate(at: Date, timeZone: string): { hour: number; minute: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  // en-CA yields YYYY-MM-DD ordering; hour "24" appears at midnight in some ICU versions.
  const hour = Number(get('hour')) % 24
  return { hour, minute: Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` }
}

/** True once the local time has reached the rule's HH:MM. Pure, for tests. */
export function digestDue(local: { hour: number; minute: number }, digestTime: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(digestTime)
  if (!m) throw new Error(`digest.daily rule has an invalid digest_time "${digestTime}" (expected HH:MM)`)
  return local.hour * 60 + local.minute >= Number(m[1]) * 60 + Number(m[2])
}

export function digestMarkerKey(tenantId: string, localDate: string): string {
  return `digest:${tenantId}:${localDate}`
}

async function loadTenants(): Promise<TenantRow[]> {
  const session = getSession()
  try {
    // Only tenants with an ENABLED digest rule: the rule is the configuration.
    return await runQuery<TenantRow>(session, `
      MATCH (t:Tenant)
      MATCH (r:NotificationRule {tenant_id: t.id, event_type: 'digest.daily', enabled: true})
      RETURN t.id AS id, t.timezone AS timezone, r.digest_time AS digestTime, r.target AS target, r.digest_recipients AS recipients
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
      const local = localHourAndDate(now, tz)
      const { date } = local
      if (!tenant.digestTime) throw new Error(`digest.daily rule of tenant ${tenant.id} has no digest_time: set the time on the rule`)
      if (!digestDue(local, tenant.digestTime)) { skipped.push(tenant.id); continue }

      const marker = digestMarkerKey(tenant.id, date)
      const claimed = await getSharedRedis().set(marker, now.toISOString(), 'EX', MARKER_TTL_SECONDS, 'NX')
      if (claimed !== 'OK') {
        log.info({ tenantId: tenant.id, date }, 'Daily digest already sent for this date — skipped (idempotency marker)')
        skipped.push(tenant.id)
        continue
      }

      // Il marcatore serve a non mandarlo DUE volte, non a cancellare il
      // tentativo fallito: se l'invio non riesce (SMTP giù, Neo4j in affanno)
      // il marcatore va rimosso, altrimenti il digest di quel giorno è perso
      // e i tick successivi lo saltano come «già inviato» (revisione totale ·
      // C-9). Il prossimo tick riprova.
      try {
        await sendDigestForTenant(tenant)
      } catch (err) {
        await getSharedRedis().del(marker).catch((delErr: unknown) => {
          log.error({ tenantId: tenant.id, date, err: delErr },
            'Digest failed AND the idempotency marker could not be removed: no digest for this tenant today')
        })
        throw err
      }
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

async function sendDigestForTenant(tenant: TenantRow): Promise<void> {
  const tenantId = tenant.id
  const session = getSession()
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  try {
    const { getOpenStepNames, getWorkflowSteps } = await import('../lib/workflowHelpers.js')
    const incidentOpen = await getOpenStepNames(session, tenantId, 'incident')
    const changeOpen   = await getOpenStepNames(session, tenantId, 'change')
    const incidentSteps = await getWorkflowSteps(session, tenantId, 'incident')
    /**
     * TUTTI i passi risolutivi, non il primo (revisione totale · C-24): con
     * due passi di categoria «resolved» — o due definizioni attive, come su
     * c-one — «risolti oggi» contava solo quelli del primo e il numero del
     * digest era più basso del vero, senza che si capisse perché.
     */
    const resolvedSteps = incidentSteps.filter((s) => s.category === 'resolved').map((s) => s.name)
    const resolvedStepNames = resolvedSteps.length > 0
      ? resolvedSteps
      : incidentSteps.filter((s) => s.isTerminal).map((s) => s.name)

    // Stats
    const stats = await runQuery<Record<string, unknown>>(session, `
      OPTIONAL MATCH (i:Incident {tenant_id: $t}) WHERE i.status IN $incidentOpen
      WITH count(i) AS openInc
      OPTIONAL MATCH (r:Incident {tenant_id: $t}) WHERE r.status IN $resolvedStepNames AND r.resolved_at >= $since
      WITH openInc, count(r) AS resolvedToday
      OPTIONAL MATCH (c:Change {tenant_id: $t})-[:HAS_WORKFLOW]->(wi:WorkflowInstance) WHERE wi.current_step IN $changeOpen AND coalesce(c.deleted, false) = false
      WITH openInc, resolvedToday, count(c) AS ongoingChanges
      // Le violazioni AVVENUTE nelle ultime 24 ore (C-8): prima si contavano
      // gli SLA *iniziati* nelle 24 ore che risultano violati.
      OPTIONAL MATCH (s:SLAStatus {tenant_id: $t}) WHERE s.breached = true AND s.breached_at >= $since
      RETURN openInc, resolvedToday, ongoingChanges, count(s) AS slaBreaches
    `, { t: tenantId, since: yesterday, incidentOpen, changeOpen, resolvedStepNames })

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

    // Recipients: people who work tickets (TICKET_WORKER_PERMISSION on their role,
    // wave 7 — it was admin/operator) or the users with the target role, that did not opt out (A-27). A missing
    // flag means enabled — `u.notifications_enabled <> false` alone would drop
    // every user without the property (null <> false is null in Cypher).
    const users = tenant.recipients && tenant.recipients.length > 0
      ? tenant.recipients.map((email) => ({ email }))
      : await runQuery<{ email: string }>(session, `
      MATCH (u:User {tenant_id: $t})
      MATCH (r:Role {tenant_id: $t, key: u.role})
      WHERE (CASE WHEN $role IS NULL THEN $permission IN r.permissions ELSE u.role = $role END)
        AND u.email IS NOT NULL AND u.email <> ''
        AND coalesce(u.active, true) = true
        AND coalesce(u.notifications_enabled, true) = true
      RETURN u.email AS email
    `, { t: tenantId, role: digestRole(tenant.target), permission: TICKET_WORKER_PERMISSION })

    if (users.length === 0) {
      log.info({ tenantId }, 'Daily digest: no recipients')
      return
    }

    const tpl = digestDaily({ ...digestStats, recentEvents }, { tenantId, brand: await loadTenantBrand(tenantId) }, await loadNotificationLocale(tenantId))

    let sendFailures = 0
    for (const { email } of users) {
      try {
        await sendTenantEmail(tenantId, { to: email, ...tpl })
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

/** The rule's target as a user role: `all` → people who work tickets (null), `role:x` → x. Anything else cannot address a digest. */
export function digestRole(target: string | null): string | null {
  if (target == null || target === 'all') return null
  if (target.startsWith('role:')) return target.slice('role:'.length)
  throw new Error(`digest.daily rule target "${target}" cannot address a tenant digest (use all or a role)`)
}

/**
 * Schedules the tick and starts the worker. Async because the
 * repeatable job registration is awaited: a failed registration is a startup
 * error, not a lost `.then()`.
 */
export async function startEmailDigestWorker(): Promise<Worker> {
  /*
   * JOB SCHEDULER, non piu' «repeat» (21 set 2026, BullMQ 6).
   *
   * BullMQ 6 ha RIMOSSO i job ripetibili: `repeat` su `add()`, la classe
   * `Repeat`, `getRepeatableJobs()` e `removeRepeatable*()` non esistono piu'.
   * Al loro posto i Job Scheduler, che hanno un'identita' esplicita — il primo
   * argomento — invece di essere dedotta da (nome, opzioni di ripetizione).
   *
   * La ricorrenza si registra a ogni avvio del worker, come prima: non c'e'
   * stato da migrare, e `upsert` significa che riavviare non ne crea una
   * seconda.
   */
  await getQueue(EMAIL_DIGEST_QUEUE).upsertJobScheduler(
    'email-digest-tick',
    { pattern: '*/5 * * * *', tz: 'UTC' },
    { name: 'digest-tick', data: {}, opts: { removeOnComplete: true } },
  )
  log.info('Email digest tick scheduled (every 5 minutes; sends at the time of each tenant\'s digest.daily rule)')

  return createWorker(EMAIL_DIGEST_QUEUE, async (_job: Job) => {
    log.info('Running email digest tick')
    const { sent, skipped } = await processDigestTick()
    log.info({ sent: sent.length, skipped: skipped.length }, 'Email digest tick done')
  }, { concurrency: 1 })
}
