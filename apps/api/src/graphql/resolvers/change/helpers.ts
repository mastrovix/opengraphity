/**
 * Shared helpers for the change/* mutation modules.
 *
 * Any utility needed by more than one mutation file lives here. Individual
 * mutation modules (assessment/plan/execution/reopen/changeMutations) import
 * from ./helpers.js only — they never import from each other, so the graph
 * stays a clean star with helpers.ts at the center.
 */

import { GraphQLError } from 'graphql'
import { ForbiddenError, ValidationError } from '../../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import {
  TASK_STATUS, ASSESSMENT_ROLE, ROLE_LABEL, ROLE_TO_RELATION,
} from '../../../lib/taskStatus.js'
import { runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { toInt } from './mappers.js'
import { getInitialStepName } from '../../../lib/workflowHelpers.js'

export type Session = ReturnType<typeof getSession>

// ── audit ─────────────────────────────────────────────────────────────────────

export async function writeAudit(
  session: Session,
  changeId: string,
  tenantId: string,
  action: string,
  actorId: string | null,
  detail: string | null,
) {
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    CREATE (e:ChangeAuditEntry {
      id: $id, tenant_id: $tenantId, timestamp: $now,
      action: $action, detail: $detail
    })
    CREATE (c)-[:HAS_AUDIT]->(e)
    WITH e, $actorId AS aid
    OPTIONAL MATCH (u:User {id: aid, tenant_id: $tenantId})
    FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
      CREATE (e)-[:BY]->(u)
    )
  `, { changeId, tenantId, id: uuidv4(), now, action, detail, actorId }))
}

// ── code generators ───────────────────────────────────────────────────────────

export async function nextChangeCode(session: Session, tenantId: string): Promise<string> {
  const rows = await runQuery<{ maxNum: unknown }>(session, `
    MATCH (c:Change {tenant_id: $tenantId})
    WHERE c.code STARTS WITH 'CHG'
    WITH max(toInteger(substring(c.code, 3))) AS maxNum
    RETURN coalesce(maxNum, 0) AS maxNum
  `, { tenantId })
  const maxNum = toInt(rows[0]?.maxNum)
  return 'CHG' + String(maxNum + 1).padStart(8, '0')
}

export async function getNextTaskCodes(session: Session, tenantId: string, count: number): Promise<string[]> {
  const rows = await runQuery<{ code: string }>(session, `
    MATCH (t)
    WHERE t.tenant_id = $tenantId AND t.code STARTS WITH 'TASK'
    RETURN t.code AS code
    ORDER BY t.code DESC
    LIMIT 1
  `, { tenantId })
  let next = 1
  if (rows.length > 0) {
    const n = parseInt(rows[0]!.code.slice(4), 10)
    if (!isNaN(n)) next = n + 1
  }
  return Array.from({ length: count }, (_, i) => 'TASK' + String(next + i).padStart(8, '0'))
}

// ── sanity checks ─────────────────────────────────────────────────────────────

export async function assertCIHasOwnerAndSupport(session: Session, tenantId: string, ciIds: string[]) {
  const rows = await runQuery<{ id: string; name: string; ownerTeamId: string | null; supportTeamId: string | null }>(session, `
    UNWIND $ciIds AS ciId
    MATCH (ci {id: ciId, tenant_id: $tenantId})
    OPTIONAL MATCH (ci)-[:OWNED_BY]->(ownerT:Team)
    OPTIONAL MATCH (ci)-[:SUPPORTED_BY]->(supportT:Team)
    RETURN ci.id AS id, ci.name AS name,
           ownerT.id AS ownerTeamId,
           supportT.id AS supportTeamId
  `, { ciIds, tenantId })
  for (const r of rows) {
    if (!r.ownerTeamId || !r.supportTeamId) {
      logger.error({ ciId: r.id, ciName: r.name, hasOwner: !!r.ownerTeamId, hasSupport: !!r.supportTeamId },
        '[createChange] CI manca di Owner Group o Support Group')
      throw new ValidationError(`CI ${r.name} manca di Owner Group o Support Group`)
    }
  }
}

// ── generic loaders ───────────────────────────────────────────────────────────

export async function loadChange(session: Session, changeId: string, tenantId: string): Promise<Props | null> {
  const row = await runQueryOne<{ props: Props }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    RETURN properties(c) AS props
  `, { id: changeId, tenantId })
  return row?.props ?? null
}

export async function getCIName(session: Session, ciId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ name: string }>(session, `
    MATCH (ci {id: $ciId, tenant_id: $tenantId})
    RETURN coalesce(ci.name, ci.id) AS name
  `, { ciId, tenantId })
  return row?.name ?? ciId
}

export async function getQuestionText(session: Session, questionId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ text: string }>(session, `
    MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
    RETURN q.text AS text
  `, { id: questionId, tenantId })
  return row?.text ?? questionId
}

export async function getAnswerLabel(session: Session, optionId: string): Promise<string> {
  const row = await runQueryOne<{ label: string }>(session, `
    MATCH (o:AnswerOption {id: $id})
    RETURN o.label AS label
  `, { id: optionId })
  return row?.label ?? optionId
}

// ── workflow step helpers ─────────────────────────────────────────────────────

export async function getCurrentStep(session: Session, changeId: string, tenantId: string): Promise<string | null> {
  const row = await runQueryOne<{ step: string }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.current_step AS step
  `, { id: changeId, tenantId })
  return row?.step ?? null
}

export async function getInstanceId(session: Session, changeId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.id AS id
  `, { id: changeId, tenantId })
  if (!row) throw new GraphQLError(`Change ${changeId} senza WorkflowInstance collegata`, { extensions: { code: 'CONFLICT' } })
  return row.id
}

export async function assertInitialStep(session: Session, changeId: string, tenantId: string): Promise<Props> {
  const props = await loadChange(session, changeId, tenantId)
  if (!props) throw new GraphQLError(`Change ${changeId} non trovato`, { extensions: { code: 'NOT_FOUND' } })
  const current = await getCurrentStep(session, changeId, tenantId)
  const initial = await getInitialStepName(session, tenantId, 'change')
  if (current !== initial) {
    logger.error({ changeId, current, initial }, '[change] operazione permessa solo nello step iniziale')
    throw new GraphQLError(`Operazione permessa solo nello step iniziale: step corrente "${current}"`, { extensions: { code: 'CONFLICT' } })
  }
  return props
}

/**
 * Verifica che l'utente corrente sia membro dell'Owner Group o del Support Group
 * del CI. Solleva errore "Non autorizzato" altrimenti. Admin bypass.
 */
export async function assertUserInCITeam(
  session: Session,
  ciId: string,
  tenantId: string,
  ctx: GraphQLContext,
  role: 'owner' | 'support',
) {
  if (ctx.role === 'admin') return
  if (!ctx.userId) {
    logger.error({ ciId, role }, '[authz] utente non identificato')
    throw new ForbiddenError('Non autorizzato: utente non identificato')
  }
  const rel = ROLE_TO_RELATION[role]
  const roleLabel = ROLE_LABEL[role]
  const row = await runQueryOne<{ ok: boolean | null }>(session, `
    MATCH (ci {id: $ciId, tenant_id: $tenantId})-[:${rel}]->(team:Team)
    OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)
    RETURN u IS NOT NULL AS ok
  `, { ciId, tenantId, userId: ctx.userId })
  if (!row || !row.ok) {
    logger.error({ userId: ctx.userId, ciId, role, tenantId }, `[authz] user ${ctx.userId} non è nel ${roleLabel} Group del CI ${ciId}`)
    throw new ForbiddenError(`Non autorizzato: solo il ${roleLabel} Group del CI può eseguire questa azione`)
  }
}

export function assertAdmin(ctx: GraphQLContext) {
  if (ctx.role !== 'admin') {
    logger.error({ userId: ctx.userId, role: ctx.role }, '[authz] reopen tentativo non-admin')
    throw new ForbiddenError('Solo gli admin possono riaprire task')
  }
}

// ── risk + step side-effects ──────────────────────────────────────────────────

export async function recomputeCIRiskIfReady(session: Session, changeId: string, ciId: string, tenantId: string, actorId: string | null) {
  const row = await runQueryOne<{ ownerDone: boolean; supportDone: boolean; ownerScore: unknown; supportScore: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {ci_id: $ciId})
    WITH collect({role: t.responder_role, status: t.status, score: t.score}) AS tasks
    RETURN
      any(x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.OWNER}'   AND x.status = '${TASK_STATUS.COMPLETED}') AS ownerDone,
      any(x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.SUPPORT}' AND x.status = '${TASK_STATUS.COMPLETED}') AS supportDone,
      [x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.OWNER}'   | x.score][0] AS ownerScore,
      [x IN tasks WHERE x.role = '${ASSESSMENT_ROLE.SUPPORT}' | x.score][0] AS supportScore
  `, { changeId, ciId, tenantId })
  if (!row || !row.ownerDone || !row.supportDone) return

  const os = row.ownerScore != null ? toInt(row.ownerScore) : 0
  const ss = row.supportScore != null ? toInt(row.supportScore) : 0
  const ciRisk = Math.round((os + ss) / 2)

  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
    SET r.risk_score = $risk, r.ci_phase = 'assessed'
  `, { changeId, ciId, tenantId, risk: ciRisk }))

  const ciName = await getCIName(session, ciId, tenantId)
  await writeAudit(session, changeId, tenantId, 'ci_risk_computed', actorId, `${ciName}: risk ${ciRisk}`)
}

export async function computeAggregateRisk(session: Session, changeId: string, tenantId: string) {
  const row = await runQueryOne<{ maxRisk: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->()
    RETURN max(r.risk_score) AS maxRisk
  `, { changeId, tenantId })
  const maxRisk = row?.maxRisk != null ? toInt(row.maxRisk) : 0
  const approvalRoute =
    maxRisk <= 30 ? 'low' :
    maxRisk <= 60 ? 'medium' :
                    'high'
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    SET c.aggregate_risk_score = $maxRisk,
        c.approval_route       = $route,
        c.updated_at           = $now
  `, { changeId, tenantId, maxRisk, route: approvalRoute, now: new Date().toISOString() }))
}

async function createValidationAndDeploymentTasks(session: Session, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return
  const codes = await getNextTaskCodes(session, tenantId, ciRows.length * 2)
  const ciCodes = ciRows.map((r, i) => ({ ciId: r.ciId, valCode: codes[i * 2]!, depCode: codes[i * 2 + 1]! }))
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    UNWIND $ciCodes AS cc
    MATCH (c)-[:AFFECTS_CI]->(ci {id: cc.ciId})
    MERGE (vt:ValidationTest {change_key: $changeId + '-' + ci.id})
      ON CREATE SET vt.id = randomUUID(), vt.code = cc.valCode, vt.tenant_id = $tenantId,
        vt.ci_id = ci.id, vt.status = '${TASK_STATUS.PENDING}',
        vt.result = null, vt.tested_at = null, vt.created_at = $now
    MERGE (c)-[:HAS_VALIDATION]->(vt)
    WITH c, ci, cc
    MERGE (dt:DeploymentTask {change_key: $changeId + '-' + ci.id + '-exec'})
      ON CREATE SET dt.id = randomUUID(), dt.code = cc.depCode, dt.tenant_id = $tenantId,
        dt.ci_id = ci.id, dt.status = '${TASK_STATUS.PENDING}',
        dt.created_at = $now
    MERGE (c)-[:HAS_DEPLOYMENT]->(dt)
  `, { changeId, tenantId, now, ciCodes }))
}

async function createReviewTasks(session: Session, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return
  const codes = await getNextTaskCodes(session, tenantId, ciRows.length)
  const ciCodes = ciRows.map((r, i) => ({ ciId: r.ciId, code: codes[i]! }))
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    UNWIND $ciCodes AS cc
    MERGE (rv:ReviewTask {change_key: $changeId + '-' + cc.ciId + '-review'})
      ON CREATE SET rv.id = randomUUID(), rv.code = cc.code, rv.tenant_id = $tenantId,
        rv.ci_id = cc.ciId, rv.status = '${TASK_STATUS.PENDING}', rv.created_at = $now
    MERGE (c)-[:HAS_REVIEW]->(rv)
  `, { changeId, tenantId, now, ciCodes }))
}

// Dispatch table keyed by the step's `on_enter_create` metadata.
const ON_ENTER_CREATORS: Record<string, (session: Session, changeId: string, tenantId: string) => Promise<void>> = {
  validation_and_deployment: createValidationAndDeploymentTasks,
  review:                    createReviewTasks,
}

/**
 * Side-effects to run immediately after the workflow enters a new step.
 * Reads `on_enter_create` metadata from Neo4j and dispatches to the matching
 * creator. Steps without the metadata are no-ops.
 */
export async function afterEnterStep(session: Session, changeId: string, tenantId: string, stepName: string) {
  const row = await runQueryOne<{ hook: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    MATCH (wi)-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName
    RETURN step.on_enter_create AS hook
  `, { changeId, tenantId, stepName })
  const hook = row?.hook
  if (!hook) return
  const creator = ON_ENTER_CREATORS[hook]
  if (!creator) {
    logger.warn({ changeId, stepName, hook }, '[afterEnterStep] unknown on_enter_create hook')
    return
  }
  await creator(session, changeId, tenantId)
}
