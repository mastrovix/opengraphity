/**
 * «SEGNALA A OPENGRAFO» (26 Sep 2026, the owner's four choices).
 *
 * A Problem of a customer can be a fault of OpenGrafo itself — a remedy that
 * did not hold is the typical one. Its admins cannot fix the code, and the
 * customer's data never leaves the product by itself (the dossier goes to
 * GitHub only from the platform tenant). So a person makes the gesture:
 *
 *  1. WHERE: on a Problem that has the tenant's OpenGrafo CI among its CIs —
 *     the remedies' Problems and those a person opens by hand on OpenGrafo;
 *  2. WHAT: only technical data — the remedy, its technical cause, the
 *     counts, what the verifications found, error messages scrubbed — plus a
 *     note that the person writes and SEES before it is sent. No title, no
 *     description, no comments, no names of people, CIs or services;
 *  3. WHERE IT ARRIVES: in the platform tenant, as a proposal to be READ
 *     (area `platform`); from there OpenGrafo's people open a Problem, which
 *     goes to GitHub like the others;
 *  4. THE WAY BACK: a comment on the customer's Problem when the report is
 *     read, and one when OpenGrafo's Problem is closed (`reportsClosed`, run
 *     by the self-analysis job).
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { ValidationError } from './errors.js'
import { logger } from './logger.js'
import { TENANT_DI_PIATTAFORMA } from './serverLogEvents.js'
import { OPENGRAFO_CI_KEY } from './opengrafoSystemCI.js'
import { normalizzaMessaggio } from './serverLogScrub.js'
import { scriviProposta } from './proposals.js'
import { OPERATIONS_LIMITS } from './operationsRemedyCommon.js'

export const REPORT_KIND = 'proposal.platformCustomerReport'
export const MAX_NOTE = 2000

/**
 * The parameters of a remedy that may leave the tenant: technical, never a
 * name. A service map's name (`map`) is the customer's, and stays home.
 */
const TECHNICAL_PARAMS: readonly string[] = ['queue', 'count']

/** Failed jobs whose reason is sent, at most: enough to see the fault, not a dump. */
const MAX_REASONS = 3

const MODULE = 'opengrafo-reports'

export interface ReportDraft {
  /** The sentence of the proposal on OpenGrafo's side. */
  params: Record<string, string>
  /** The technical data, as the person sees it before sending. */
  data:   Record<string, string>
}

interface ProblemFacts {
  number:     string
  onOpenGrafo: boolean
  reportedAt: string | null
  fromProposal: { kind: string; cause: string | null; params: Record<string, string> } | null
}

async function problemFacts(tenantId: string, problemId: string): Promise<ProblemFacts | null> {
  const session = getSession(undefined, 'READ')
  try {
    const r = await runQueryOne<{ number: string; onOpenGrafo: boolean; reportedAt: string | null; kind: string | null; cause: string | null; params: string | null }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId, id: $problemId})
      OPTIONAL MATCH (pr:Proposal {tenant_id: $tenantId, id: p.from_proposal_id})
      RETURN p.number AS number,
             EXISTS { MATCH (p)-[:AFFECTS]->(:ConfigurationItem {tenant_id: $tenantId, system_key: $ciKey}) } AS onOpenGrafo,
             p.opengrafo_reported_at AS reportedAt, pr.kind AS kind, pr.cause AS cause, pr.params AS params
    `, { tenantId, problemId, ciKey: OPENGRAFO_CI_KEY })
    if (!r) return null
    let params: Record<string, string> = {}
    try { params = r.params ? JSON.parse(r.params) as Record<string, string> : {} } catch { params = {} }
    return {
      number: r.number, onOpenGrafo: r.onOpenGrafo === true, reportedAt: r.reportedAt ?? null,
      fromProposal: r.kind ? { kind: r.kind, cause: r.cause ?? null, params } : null,
    }
  } finally {
    await session.close()
  }
}

/** Can this Problem be reported, and was it? Read by the Problem page. */
export async function reportState(tenantId: string, problemId: string): Promise<{ canReport: boolean; reportedAt: string | null }> {
  if (tenantId === TENANT_DI_PIATTAFORMA) return { canReport: false, reportedAt: null }
  const f = await problemFacts(tenantId, problemId)
  if (!f) return { canReport: false, reportedAt: null }
  return { canReport: f.onOpenGrafo && f.reportedAt === null, reportedAt: f.reportedAt }
}

/** What the verifications of the remedies for this cause found this week: counts and outcomes, no names. */
async function verificationsOf(tenantId: string, cause: string): Promise<string[]> {
  const since = new Date(Date.now() - OPERATIONS_LIMITS.holdDays * 86_400_000).toISOString()
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ action: string | null; verification: string | null; detail: string | null; at: string | null }>(session, `
      MATCH (p:Proposal {tenant_id: $tenantId, area: 'operations', status: 'accepted'})
      // Remedies only: the proposal «a person has to look» has no action, and nothing to verify.
      WHERE p.cause = $cause AND p.decided_at >= $since AND p.action IS NOT NULL
      RETURN p.action AS action, p.verification AS verification, p.verification_detail AS detail, p.verified_at AS at
      ORDER BY p.decided_at
    `, { tenantId, cause, since })
    return rows.map((r) => {
      let type = '?'
      try { type = r.action ? (JSON.parse(r.action) as { type: string }).type : '?' } catch { /* the type is only a label here */ }
      let numbers = ''
      try {
        const d = r.detail ? JSON.parse(r.detail) as Record<string, unknown> : {}
        numbers = Object.entries(d).filter(([, v]) => typeof v === 'number' || /^\d+$/.test(String(v))).map(([k, v]) => `${k}=${String(v)}`).join(' ')
      } catch { /* no numbers */ }
      return `${type} → ${r.verification ?? 'not verified yet'}${numbers ? ` (${numbers})` : ''}${r.at ? ` ${r.at.slice(0, 16)}` : ''}`
    })
  } finally {
    await session.close()
  }
}

/** The reasons the failed jobs of a queue gave, scrubbed as the log archive is: shapes, not data. */
async function failedReasons(tenantId: string, queue: string): Promise<string[]> {
  const { isTenantQueueBase } = await import('./queueRegistry.js')
  if (!isTenantQueueBase(queue)) return []
  const { getTenantQueue } = await import('./bullmq.js')
  const jobs = await getTenantQueue(queue, tenantId).getJobs(['failed'], 0, 49, false)
  const seen = new Set<string>()
  for (const j of jobs) {
    if (!j.failedReason || j.id?.startsWith('repeat:')) continue
    seen.add(normalizzaMessaggio(j.failedReason).template)
    if (seen.size >= MAX_REASONS) break
  }
  return [...seen]
}

/**
 * The report as it would leave: built from the facts, every time — never
 * from what the page sent, so what the person saw is what is sent.
 */
export async function reportDraft(tenantId: string, problemId: string): Promise<ReportDraft> {
  if (tenantId === TENANT_DI_PIATTAFORMA) {
    throw new ValidationError('the platform tenant does not report to itself', { key: 'errors.openGrafoReport.platformTenant' })
  }
  const f = await problemFacts(tenantId, problemId)
  if (!f) throw new ValidationError('problem not found', { key: 'errors.notFound', params: { entity: 'Problem', id: problemId } })
  if (!f.onOpenGrafo) {
    throw new ValidationError('only a problem on the OpenGrafo CI is reported to OpenGrafo', { key: 'errors.openGrafoReport.notOnOpenGrafo' })
  }
  const params: Record<string, string> = { tenant: tenantId, problem: f.number }
  const data: Record<string, string> = { tenant: tenantId, problem: f.number, origin: f.fromProposal ? 'remedy' : 'person' }
  if (f.fromProposal) {
    data['remedy'] = f.fromProposal.kind
    if (f.fromProposal.cause) {
      data['cause'] = f.fromProposal.cause
      // In the proposal's params too: the title of OpenGrafo's Problem names it (proposalAgreement.ts).
      params['cause'] = f.fromProposal.cause
    }
    for (const k of TECHNICAL_PARAMS) if (f.fromProposal.params[k] !== undefined) data[k] = f.fromProposal.params[k]!
    if (f.fromProposal.cause) {
      const lines = await verificationsOf(tenantId, f.fromProposal.cause)
      lines.forEach((l, i) => { data[`verification${String(i + 1)}`] = l })
    }
    const queue = f.fromProposal.params['queue']
    if (queue) (await failedReasons(tenantId, queue)).forEach((reason, i) => { data[`error${String(i + 1)}`] = reason })
  }
  return { params, data }
}

/**
 * Sends the report: a proposal to read in the platform tenant, and the mark
 * on the customer's Problem. Once per Problem: a second press is refused.
 */
export async function reportToOpenGrafo(tenantId: string, problemId: string, note: string, now: Date = new Date()): Promise<{ proposalId: string; reportedAt: string }> {
  const text = note.trim()
  if (text.length === 0) throw new ValidationError('the note is empty', { key: 'errors.openGrafoReport.noteRequired' })
  if (text.length > MAX_NOTE) {
    throw new ValidationError(`the note is longer than ${String(MAX_NOTE)} characters`, { key: 'errors.openGrafoReport.noteTooLong', params: { max: MAX_NOTE } })
  }
  const state = await reportState(tenantId, problemId)
  if (state.reportedAt) throw new ValidationError('this problem was already reported to OpenGrafo', { key: 'errors.openGrafoReport.alreadyReported' })
  const draft = await reportDraft(tenantId, problemId)

  const written = await scriviProposta({
    tenantId: TENANT_DI_PIATTAFORMA,
    area:     'platform',
    kind:     REPORT_KIND,
    params:   draft.params,
    scope:    `report:${tenantId}:${problemId}`,
    evidence: { n: 1, windowDays: 0, refs: [], extra: draft.data },
    action:   null,
    reportNote:   text,
    reportSource: { tenantId, problemId, problemNumber: draft.params['problem']! },
  }, undefined, now)
  if (!written.scritta) {
    throw new Error(`the report of ${tenantId}/${draft.params['problem'] ?? problemId} was not written on the platform side (${written.motivo})`)
  }
  const reportedAt = now.toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, `
      MATCH (p:Problem {tenant_id: $tenantId, id: $problemId})
      SET p.opengrafo_reported_at = $reportedAt, p.opengrafo_report_proposal_id = $proposalId
    `, { tenantId, problemId, reportedAt, proposalId: written.proposal.id })
  } finally {
    await session.close()
  }
  logger.info({ module: MODULE, tenantId, problem: draft.params['problem'], proposal: written.proposal.id }, 'a problem was reported to OpenGrafo')
  return { proposalId: written.proposal.id, reportedAt }
}

// ── The way back ────────────────────────────────────────────────────────────

export type ReportOutcome = 'acknowledged' | 'rejected' | 'problem_opened' | 'closed'

/**
 * A comment on the customer's Problem, in the customer's language. Written
 * by «OpenGrafo», not by a person of the platform: whose name is not the
 * customer's business.
 */
export async function tellTheReporter(source: { tenantId: string; problemId: string }, outcome: ReportOutcome, params: Record<string, string> = {}): Promise<void> {
  const { systemText } = await import('./systemText.js')
  const text = await systemText(source.tenantId, `openGrafoReport.${outcome}`, params)
  const { writeTicketComment } = await import('./ticketComments.js')
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(async (tx) => {
      await writeTicketComment(tx as never, {
        entityType: 'problem', entityId: source.problemId, tenantId: source.tenantId, text,
        authorId: 'system', authorLabel: 'OpenGrafo', isInternal: false,
      })
    })
  } finally {
    await session.close()
  }
  logger.info({ module: MODULE, tenantId: source.tenantId, problemId: source.problemId, outcome }, 'the reporter was told how the report went')
}

/**
 * OpenGrafo's Problems born from a report, now closed, whose reporter was not
 * told yet: each gets its comment, once. Run by the self-analysis job, with
 * or without GitHub.
 */
export async function reportsClosed(): Promise<number> {
  const session = getSession(undefined, 'WRITE')
  let rows: Array<{ proposalId: string; source: string | null; number: string }>
  try {
    rows = await runQuery(session, `
      MATCH (pr:Proposal {tenant_id: $platform, kind: $kind})
      WHERE pr.report_source IS NOT NULL AND pr.opened_problem IS NOT NULL AND pr.report_closed_told_at IS NULL
      WITH pr, apoc.convert.fromJsonMap(pr.opened_problem) AS op
      MATCH (p:Problem {tenant_id: $platform, id: op.id})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $platform})
      OPTIONAL MATCH (wi)-[:CURRENT_STEP]->(s:WorkflowStep)
      WITH pr, p, wi, s WHERE wi.status <> 'active' OR s.is_open = false
      RETURN pr.id AS proposalId, pr.report_source AS source, p.number AS number
    `, { platform: TENANT_DI_PIATTAFORMA, kind: REPORT_KIND })
  } finally {
    await session.close()
  }
  let told = 0
  for (const r of rows) {
    try {
      const source = JSON.parse(r.source ?? '{}') as { tenantId: string; problemId: string }
      await tellTheReporter(source, 'closed', { platformProblem: r.number })
      const s = getSession(undefined, 'WRITE')
      try {
        await runQuery(s, `MATCH (pr:Proposal {tenant_id: $platform, id: $id}) SET pr.report_closed_told_at = $now`,
          { platform: TENANT_DI_PIATTAFORMA, id: r.proposalId, now: new Date().toISOString() })
      } finally {
        await s.close()
      }
      told += 1
    } catch (err) {
      logger.error({ module: MODULE, proposal: r.proposalId, err: err instanceof Error ? err.message : String(err) }, 'the reporter could not be told the problem was closed, retried at the next run')
    }
  }
  return told
}
