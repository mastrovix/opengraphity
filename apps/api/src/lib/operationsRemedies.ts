/**
 * THE RUNNING OF A TENANT, REPAIRED WITH A PERSON'S YES (26 Sep 2026).
 *
 * The owner: «completiamo» the self-analysis. The platform analyst reads the
 * errors of OpenGrafo and writes proposals to be READ — the remedy there is
 * code. This one looks at the RUNNING of a tenant, where the code is right but
 * something got stuck, and the product itself can put it right: failed jobs,
 * alarms left without a decision, service maps behind the CMDB, CI health out
 * of step with the alarms, workflows stuck with the road open.
 *
 * ## The owner's decisions (26 Sep 2026)
 *  - The remedies live IN EACH TENANT and the tenant's admin accepts them: a
 *    remedy touches that tenant only. The platform tenant never acts on a
 *    customer.
 *  - No model here: the detectors read counters and the graph, and a proposal
 *    carries an action of the closed catalogue with typed parameters.
 *
 * ## An operational remedy is not undone: it is VERIFIED
 * A retried job has run; there is nothing to put back. What closes the loop
 * is the check some minutes later — the same condition that opened the
 * proposal, looked at again — written on the proposal: resolved or not.
 *
 * ## Never twice on the same cause without a person
 * A remedy that did not hold is not proposed again for that cause for a week:
 * a proposal to READ takes its place, saying that the remedy was not enough.
 * Retrying a failure that returns hides a defect; a person has to look.
 *
 * ## One episode a day
 * An accepted proposal keeps its fingerprint, and failed jobs come back next
 * month. So the scope of a remedy carries the DAY of the episode: one proposal
 * per cause per day, and the earlier ones stay as the history of that cause.
 */
import { getSession, runQuery } from '@opengraphity/neo4j'
import { fingerprintOf, type ProposalToWrite } from './proposals.js'
import type { EsitoAzione } from './proposalActions.js'
import { QUEUE_REGISTRY, isTenantQueueBase, queueEntry } from './queueRegistry.js'
import { getTenantQueue } from './bullmq.js'
import { ValidationError } from './errors.js'
import { logger } from './logger.js'
import { OPERATIONS_LIMITS, operationsProposal, type VerificationOutcome } from './operationsRemedyCommon.js'
import {
  detectCIHealthOutOfStep, detectStaleServiceMaps, detectStuckAlarms, detectStuckWorkflows,
  verifyAlarms, verifyCIHealth, verifyServiceMap, verifyWorkflows,
} from './operationsGraphRemedies.js'

export { OPERATIONS_LIMITS, type VerificationOutcome } from './operationsRemedyCommon.js'

/** The cause of a failed-jobs proposal: the queue, without the day. */
export function failedJobsCause(queue: string): string {
  return `queue:${queue}`
}

/** The retryable queues of a tenant, from the one registry. */
function retryableTenantQueues(): string[] {
  return QUEUE_REGISTRY.filter((e) => e.scope === 'tenant' && e.retryable).map((e) => e.name)
}

/** Failed jobs read per queue: enough to count what a person would retry, bounded. */
const FAILED_SCAN = 500

/**
 * A run of a PERIODIC job is not something to retry (26 Sep 2026, found on
 * the demo tenant): eleven sweeps of `workflow-jobs` had failed while Neo4j
 * was restarting, and the next repetition had already done their work — the
 * first version proposed retrying them. BullMQ names every repetition
 * `repeat:<key>:<time>`. A periodic job that keeps failing is a fault of the
 * platform, and it reaches a person through the logs and the platform analyst.
 */
function isRepetition(jobId: string | undefined): boolean {
  return jobId?.startsWith('repeat:') === true
}

/** The failed jobs of a queue a person could retry, oldest first: the repetitions left out. */
async function retryableFailed(tenantId: string, queue: string) {
  const jobs = await getTenantQueue(queue, tenantId).getJobs(['failed'], 0, FAILED_SCAN - 1, true)
  return jobs.filter((j) => j.id !== undefined && !isRepetition(j.id))
}

/**
 * THE DETECTOR of failed jobs: one proposal per retryable queue that holds
 * failed jobs — to retry them, or, if a retry already did not hold this week,
 * to be read by a person.
 */
export async function detectFailedJobs(tenantId: string, now: Date = new Date()): Promise<ProposalToWrite[]> {
  const out: ProposalToWrite[] = []
  for (const queue of retryableTenantQueues()) {
    const failed = (await retryableFailed(tenantId, queue)).length
    if (failed === 0) continue
    out.push(await operationsProposal({
      tenantId, now, cause: failedJobsCause(queue), kind: 'proposal.operationsFailedJobs',
      params: { queue, count: String(failed) }, n: failed,
      action: { type: 'queue.retry_failed', params: { queue, max: Math.min(failed, OPERATIONS_LIMITS.retryMax) } },
    }))
  }
  return out
}

const DETECTORS: ReadonlyArray<(tenantId: string, now: Date) => Promise<ProposalToWrite[]>> = [
  detectFailedJobs, detectStuckAlarms, detectStaleServiceMaps, detectCIHealthOutOfStep, detectStuckWorkflows,
]

/**
 * The analyst of the running of a tenant. No model, no switch: it reads
 * counters and the graph, and every proposal it writes waits for a person's
 * yes. A detector that fails does not take the others with it — it is said in
 * the logs, loudly, and the others' proposals are written.
 */
export async function analizzaFunzionamento(tenantId: string, now: Date = new Date()): Promise<ProposalToWrite[]> {
  const out: ProposalToWrite[] = []
  let allRan = true
  for (const detect of DETECTORS) {
    try {
      out.push(...await detect(tenantId, now))
    } catch (err) {
      allRan = false
      logger.error({ module: 'operations-remedies', tenantId, detector: detect.name, err: err instanceof Error ? err.message : String(err) },
        'operations: a detector failed, the others go on')
    }
  }
  // Only when every detector looked: one that failed has not said its proposals are gone.
  if (allRan) await expireGone(tenantId, out, now)
  return out
}

/**
 * An operational proposal still open that no detector found again is no
 * longer true — the pass repaired it, or someone did — and it would hold one
 * of the few open slots for a month. It expires: not a rejection, no
 * tombstone; if the condition comes back, so does the proposal.
 */
async function expireGone(tenantId: string, found: readonly ProposalToWrite[], now: Date): Promise<void> {
  const keep = found.map((p) => fingerprintOf(p.area, p.kind, p.scope))
  const session = getSession(undefined, 'WRITE')
  try {
    const rows = await runQuery<{ n: number }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, area: 'operations', status: 'open'})
      WHERE NOT p.fingerprint IN $keep
      SET p.status = 'expired', p.decided_at = $now
      RETURN count(p) AS n
    `, { tenantId, keep, now: now.toISOString() })
    const n = Number(rows[0]?.n ?? 0)
    if (n > 0) logger.info({ module: 'operations-remedies', tenantId, expired: n }, 'operations: proposals no longer true expired')
  } finally {
    await session.close()
  }
}

// ── The remedy ────────────────────────────────────────────────────────────────

/**
 * `queue.retry_failed`: retries the failed jobs of ONE retryable queue of the
 * tenant, twenty at most, oldest first.
 *
 * The parameters are re-checked here, not trusted: between the night the
 * proposal was born and the click the registry may have changed. Nothing to
 * undo (`undoState: null`); the retried job ids go in the details, and the
 * verification looks at those very jobs.
 */
export async function retryFailedJobs(tenantId: string, params: Record<string, unknown>): Promise<EsitoAzione> {
  const queue = params['queue']
  if (typeof queue !== 'string' || !isTenantQueueBase(queue)) {
    throw new ValidationError(`"${String(queue)}" is not a queue of the tenant`, { key: 'errors.proposal.queueUnknown', params: { queue: String(queue) } })
  }
  if (!queueEntry(queue).retryable) {
    throw new ValidationError(`the jobs of queue ${queue} cannot be retried`, { key: 'errors.proposal.queueNotRetryable', params: { queue } })
  }
  const asked = Number(params['max'] ?? OPERATIONS_LIMITS.retryMax)
  const max = Number.isInteger(asked) && asked > 0 ? Math.min(asked, OPERATIONS_LIMITS.retryMax) : OPERATIONS_LIMITS.retryMax
  const jobs = (await retryableFailed(tenantId, queue)).slice(0, max)
  if (jobs.length === 0) {
    throw new ValidationError(`queue ${queue} has no failed job any more`, { key: 'errors.proposal.noFailedJobs', params: { queue } })
  }
  const retried: string[] = []
  for (const job of jobs) {
    if (!job.id) continue
    await job.retry()
    retried.push(job.id)
  }
  logger.info({ module: 'operations-remedies', tenantId, queue, retried: retried.length }, 'operations: failed jobs retried')
  return { details: { queue, retried: retried.length, jobIds: retried }, undoState: null }
}

// ── The verification ──────────────────────────────────────────────────────────

/**
 * Did the retry hold? The retried jobs are looked at again: resolved when
 * none of them has failed again. A job the queue no longer holds (completed
 * and cleaned up) counts as done — it is not there to fail.
 */
export async function verifyRetry(tenantId: string, details: Record<string, unknown>): Promise<VerificationOutcome> {
  const queue = String(details['queue'] ?? '')
  const ids = Array.isArray(details['jobIds']) ? (details['jobIds'] as unknown[]).map(String) : []
  if (!isTenantQueueBase(queue) || ids.length === 0) {
    throw new Error(`operations: the retry to verify has no queue or no jobs (${JSON.stringify(details)})`)
  }
  const q = getTenantQueue(queue, tenantId)
  let failedAgain = 0
  for (const id of ids) {
    const job = await q.getJob(id)
    if (job && (await job.getState()) === 'failed') failedAgain += 1
  }
  return {
    verification: failedAgain === 0 ? 'resolved' : 'unresolved',
    detail:       { queue, retried: ids.length, failedAgain },
  }
}

const VERIFIERS: Readonly<Record<string, (tenantId: string, details: Record<string, unknown>) => Promise<VerificationOutcome>>> = {
  'queue.retry_failed':        verifyRetry,
  'events.reevaluate_stuck':   verifyAlarms,
  'service_map.sync':          verifyServiceMap,
  'ci.recompute_health':       verifyCIHealth,
  'workflow.resume_automatic': verifyWorkflows,
}

/**
 * The verification pass of a tenant: every accepted operational proposal old
 * enough and not verified yet is checked, and the outcome written on it.
 * One that fails to verify is said in the logs and tried at the next pass —
 * never marked resolved by default.
 */
export async function verifyRemedies(tenantId: string, now: Date = new Date()): Promise<{ verified: number }> {
  const before = new Date(now.getTime() - OPERATIONS_LIMITS.verifyAfterMs).toISOString()
  const session = getSession(undefined, 'WRITE')
  let verified = 0
  try {
    const due = await runQuery<{ id: string; action: string | null; details: string | null }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, area: 'operations', status: 'accepted'})
      WHERE p.verification IS NULL AND p.decided_at <= $before AND p.execution_details IS NOT NULL
      RETURN p.id AS id, p.action AS action, p.execution_details AS details
      LIMIT 50
    `, { tenantId, before })
    for (const row of due) {
      try {
        const action = row.action ? JSON.parse(row.action) as { type: string } : null
        const verify = action ? VERIFIERS[action.type] : undefined
        if (!verify) throw new Error(`operations: no verification for action ${action?.type ?? 'none'}`)
        const outcome = await verify(tenantId, JSON.parse(row.details ?? '{}') as Record<string, unknown>)
        await runQuery(session, `
          MATCH (p:Proposal {tenant_id: $tenantId, id: $id})
          SET p.verification = $verification, p.verified_at = $now, p.verification_detail = $detail
        `, { tenantId, id: row.id, verification: outcome.verification, now: now.toISOString(), detail: JSON.stringify(outcome.detail) })
        verified += 1
        logger.info({ module: 'operations-remedies', tenantId, proposal: row.id, verification: outcome.verification }, 'operations: remedy verified')
      } catch (err) {
        logger.error({ module: 'operations-remedies', tenantId, proposal: row.id, err: err instanceof Error ? err.message : String(err) }, 'operations: verification failed, retried at the next pass')
      }
    }
  } finally {
    await session.close()
  }
  return { verified }
}
