/**
 * Daily email digest — BullMQ repeatable job.
 * Runs at 8:00 AM, sends a summary email to all admin/operator users.
 */
import { Worker, Queue } from 'bullmq'
import { getRedisOptions } from '@opengraphity/events'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { sendEmail } from '@opengraphity/notifications'
import { digestDaily } from '../lib/emailTemplates.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'email-digest' })

async function processDigest(): Promise<void> {
  const session = getSession()
  try {
    // Get all tenant IDs
    const tenants = await runQuery<{ id: string }>(session, `
      MATCH (t:Tenant) RETURN t.id AS id
    `, {})

    for (const { id: tenantId } of tenants) {
      try {
        await sendDigestForTenant(tenantId)
      } catch (err) {
        log.error({ tenantId, err }, 'Digest failed for tenant')
      }
    }
  } finally {
    await session.close()
  }
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
      OPTIONAL MATCH (c:Change {tenant_id: $t})-[:HAS_WORKFLOW]->(wi:WorkflowInstance) WHERE wi.current_step IN $changeOpen
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

    // Get admin/operator emails
    const users = await runQuery<{ email: string }>(session, `
      MATCH (u:User {tenant_id: $t})
      WHERE u.role IN ['admin', 'operator', 'TENANT_ADMIN', 'OPERATOR']
        AND u.email IS NOT NULL AND u.email <> ''
        AND NOT u.email CONTAINS '@demo.'
        AND NOT u.email CONTAINS '@opengrafo.com'
        AND NOT u.email =~ 'usr-\\\\d+@.*'
      RETURN u.email AS email
    `, { t: tenantId })

    if (users.length === 0) return

    const tpl = digestDaily({ ...digestStats, recentEvents }, tenantId)

    for (const { email } of users) {
      if (!email) continue
      try {
        await sendEmail({ to: email, ...tpl })
      } catch {
        log.error({ email, tenantId }, 'Failed to send digest email')
      }
    }

    log.info({ tenantId, recipients: users.length }, 'Daily digest sent')
  } finally {
    await session.close()
  }
}

export function startEmailDigestWorker(): Worker {
  const queue = new Queue('email-digest', { connection: getRedisOptions() })

  // Schedule repeatable job: daily at 8:00 AM
  void queue.add('daily-digest', {}, {
    repeat: { pattern: '0 8 * * *' },
    removeOnComplete: true,
  }).then(() => log.info('Email digest job scheduled (daily at 8:00)'))

  const worker = new Worker('email-digest', async () => {
    log.info('Running daily email digest')
    await processDigest()
  }, {
    connection: getRedisOptions(),
    concurrency: 1,
  })

  worker.on('failed', (_job, err) => {
    log.error({ err: err.message }, 'Email digest job failed')
  })

  return worker
}
