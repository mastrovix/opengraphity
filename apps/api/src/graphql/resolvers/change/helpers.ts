/**
 * Shared helpers for the change/* mutation modules.
 *
 * Any utility needed by more than one mutation file lives here. Individual
 * mutation modules (assessment/plan/execution/reopen/changeMutations) import
 * from ./helpers.js only — they never import from each other, so the graph
 * stays a clean star with helpers.ts at the center.
 */

import { GraphQLError } from 'graphql'
import type { ManagedTransaction } from 'neo4j-driver'
import { ForbiddenError, ValidationError } from '../../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import {
  TASK_STATUS, ASSESSMENT_ROLE, ROLE_LABEL, ROLE_TO_RELATION,
} from '../../../lib/taskStatus.js'
import { runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { calculateCIRiskScore, determineApprovalRoute, deriveChangePriority } from './scoring.js'
import { getInitialStepName } from '../../../lib/workflowHelpers.js'
import { toNumber } from '@opengraphity/neo4j'

export type Session = ReturnType<typeof getSession>

/**
 * Session (opens its own write tx) OR ManagedTransaction (participates in the
 * caller's open transaction). Write helpers below accept either: passed a tx,
 * their writes commit/rollback together with the caller's other writes.
 */
export type SessionOrTx = Session | ManagedTransaction

function isSession(s: SessionOrTx): s is Session {
  return typeof (s as Session).executeWrite === 'function'
}

/** Run a write statement: via tx.run inside an external tx, or in its own executeWrite. */
async function runWrite(target: SessionOrTx, cypher: string, params: Record<string, unknown>): Promise<void> {
  if (isSession(target)) {
    await target.executeWrite((tx) => tx.run(cypher, params))
  } else {
    await target.run(cypher, params)
  }
}

// ── audit ─────────────────────────────────────────────────────────────────────

export async function writeAudit(
  session: SessionOrTx,
  changeId: string,
  tenantId: string,
  action: string,
  actorId: string | null,
  detail: string | null,
) {
  const now = new Date().toISOString()
  await runWrite(session, `
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
  `, { changeId, tenantId, id: uuidv4(), now, action, detail, actorId })
}

// ── code generators ───────────────────────────────────────────────────────────

export async function nextChangeCode(session: Session, tenantId: string): Promise<string> {
  const rows = await runQuery<{ maxNum: unknown }>(session, `
    MATCH (c:Change {tenant_id: $tenantId})
    WHERE c.code STARTS WITH 'CHG'
    WITH max(toInteger(substring(c.code, 3))) AS maxNum
    RETURN coalesce(maxNum, 0) AS maxNum
  `, { tenantId })
  const maxNum = toNumber(rows[0]?.maxNum)
  return 'CHG' + String(maxNum + 1).padStart(8, '0')
}

export async function getNextTaskCodes(session: SessionOrTx, tenantId: string, count: number): Promise<string[]> {
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

/** Predicato condiviso: esclude le change eliminate logicamente (deleteChange). */
export const CHANGE_NOT_DELETED = 'coalesce(c.deleted, false) = false'

export async function loadChange(session: Session, changeId: string, tenantId: string): Promise<Props | null> {
  const row = await runQueryOne<{ props: Props }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    WHERE ${CHANGE_NOT_DELETED}
    RETURN properties(c) AS props
  `, { id: changeId, tenantId })
  return row?.props ?? null
}

export async function getCIName(session: SessionOrTx, ciId: string, tenantId: string): Promise<string> {
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

export async function getAnswerLabel(session: Session, optionId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ label: string }>(session, `
    MATCH (o:AnswerOption {id: $id, tenant_id: $tenantId})
    RETURN o.label AS label
  `, { id: optionId, tenantId })
  return row?.label ?? optionId
}

// ── workflow step helpers ─────────────────────────────────────────────────────

export interface ChangeWorkflow {
  instanceId:  string
  currentStep: string
  props:       Props
}

/**
 * Change (non eliminata) + istanza di workflow + step corrente, in UNA lettura.
 * Lo step è letto dalla relazione CURRENT_STEP (la fonte autoritativa) e
 * confrontato con wi.current_step: una divergenza è corruzione e va fatta
 * emergere, non nascosta scegliendo una delle due. Sostituisce le cinque
 * grafie diverse dello stesso lookup sparse nei moduli.
 */
export async function loadChangeWorkflow(session: Session, changeId: string, tenantId: string): Promise<ChangeWorkflow> {
  const row = await runQueryOne<{ props: Props; deleted: boolean; instanceId: string | null; wiStep: string | null; relStep: string | null }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    OPTIONAL MATCH (wi)-[:CURRENT_STEP]->(s:WorkflowStep)
    RETURN properties(c) AS props, coalesce(c.deleted, false) AS deleted,
           wi.id AS instanceId, wi.current_step AS wiStep, s.name AS relStep
  `, { id: changeId, tenantId })
  if (!row) throw new GraphQLError(`Change ${changeId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
  if (row.deleted) throw new GraphQLError('La change è stata eliminata: nessuna operazione è più possibile', { extensions: { code: 'CONFLICT' } })
  if (!row.instanceId) throw new GraphQLError(`Change ${changeId} senza WorkflowInstance collegata`, { extensions: { code: 'CONFLICT' } })
  if (!row.relStep) throw new GraphQLError(`Change ${changeId}: istanza di workflow senza CURRENT_STEP (ri-esegui il seed del workflow per ricollegarla)`, { extensions: { code: 'CONFLICT' } })
  if (row.wiStep !== row.relStep) {
    logger.error({ changeId, wiStep: row.wiStep, relStep: row.relStep }, '[change] istanza di workflow incoerente')
    throw new GraphQLError(`Change ${changeId}: istanza di workflow incoerente (current_step="${row.wiStep}", CURRENT_STEP="${row.relStep}")`, { extensions: { code: 'CONFLICT' } })
  }
  return { instanceId: row.instanceId, currentStep: row.relStep, props: row.props }
}

export async function getCurrentStep(session: Session, changeId: string, tenantId: string): Promise<string | null> {
  const row = await runQueryOne<{ step: string }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep)
    WHERE ${CHANGE_NOT_DELETED}
    RETURN s.name AS step
  `, { id: changeId, tenantId })
  return row?.step ?? null
}

/**
 * Azzera tutto ciò che deriva dagli assessment quando uno viene riaperto o
 * l'approvazione è rifiutata: rischio aggregato, rotta, esito approvazione e
 * PRIORITÀ (tipo × rischio → con rischio ignoto torna a quella del solo tipo).
 * Prima il reopen lasciava una priorità "high" con rischio null.
 */
export async function resetChangeRisk(session: SessionOrTx, changeId: string, tenantId: string): Promise<void> {
  const row = await runQueryOne<{ changeType: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId}) RETURN c.change_type AS changeType
  `, { changeId, tenantId })
  if (!row) throw new GraphQLError(`Change ${changeId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    SET c.aggregate_risk_score = null, c.approval_route = null, c.approval_status = null,
        c.priority = $priority, c.updated_at = $now
  `, { changeId, tenantId, priority: deriveChangePriority(row.changeType ?? 'normal', null), now: new Date().toISOString() })
}

/** Istanza di workflow della change; rifiuta le change eliminate (nessuna mutation su una change cancellata). */
export async function getInstanceId(session: Session, changeId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ id: string | null; deleted: boolean }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.id AS id, coalesce(c.deleted, false) AS deleted
  `, { id: changeId, tenantId })
  if (!row) throw new GraphQLError(`Change ${changeId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
  if (row.deleted) throw new GraphQLError('La change è stata eliminata: nessuna operazione è più possibile', { extensions: { code: 'CONFLICT' } })
  if (!row.id) throw new GraphQLError(`Change ${changeId} senza WorkflowInstance collegata`, { extensions: { code: 'CONFLICT' } })
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

export async function recomputeCIRiskIfReady(session: SessionOrTx, changeId: string, ciId: string, tenantId: string, actorId: string | null) {
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

  const os = row.ownerScore != null ? toNumber(row.ownerScore) : 0
  const ss = row.supportScore != null ? toNumber(row.supportScore) : 0
  const ciRisk = calculateCIRiskScore(os, ss)

  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
    SET r.risk_score = $risk, r.ci_phase = 'assessed'
  `, { changeId, ciId, tenantId, risk: ciRisk })

  const ciName = await getCIName(session, ciId, tenantId)
  await writeAudit(session, changeId, tenantId, 'ci_risk_computed', actorId, `${ciName}: risk ${ciRisk}`)
}

export async function computeAggregateRisk(session: SessionOrTx, changeId: string, tenantId: string) {
  const row = await runQueryOne<{ maxRisk: unknown; changeType: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->()
    RETURN max(r.risk_score) AS maxRisk, c.change_type AS changeType
  `, { changeId, tenantId })
  const maxRisk = row?.maxRisk != null ? toNumber(row.maxRisk) : 0
  const approvalRoute = determineApprovalRoute(maxRisk)
  // Priorità (ITIL) = tipo × rischio, ricalcolata e MEMORIZZATA quando il
  // rischio aggregato cambia.
  const priority = deriveChangePriority(row?.changeType ?? 'normal', maxRisk)
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    SET c.aggregate_risk_score = $maxRisk,
        c.approval_route       = $route,
        c.priority             = $priority,
        c.updated_at           = $now
  `, { changeId, tenantId, maxRisk, route: approvalRoute, priority, now: new Date().toISOString() })
}

// TRANSACTIONAL: all writes in single tx — ValidationTest + DeploymentTask per
// ogni CI (creazione + relazioni HAS_VALIDATION/HAS_DEPLOYMENT) vengono creati
// in un'unica statement/tx: o tutti o nessuno. Le letture (CI, task codes)
// restano prima della scrittura.
async function createValidationAndDeploymentTasks(session: SessionOrTx, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return
  const codes = await getNextTaskCodes(session, tenantId, ciRows.length * 2)
  const ciCodes = ciRows.map((r, i) => ({ ciId: r.ciId, valCode: codes[i * 2]!, depCode: codes[i * 2 + 1]! }))
  const now = new Date().toISOString()
  await runWrite(session, `
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
  `, { changeId, tenantId, now, ciCodes })
}

// TRANSACTIONAL: all writes in single tx — un ReviewTask per CI, o tutti o nessuno.
async function createReviewTasks(session: SessionOrTx, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return
  const codes = await getNextTaskCodes(session, tenantId, ciRows.length)
  const ciCodes = ciRows.map((r, i) => ({ ciId: r.ciId, code: codes[i]! }))
  const now = new Date().toISOString()
  await runWrite(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    UNWIND $ciCodes AS cc
    MERGE (rv:ReviewTask {change_key: $changeId + '-' + cc.ciId + '-review'})
      ON CREATE SET rv.id = randomUUID(), rv.code = cc.code, rv.tenant_id = $tenantId,
        rv.ci_id = cc.ciId, rv.status = '${TASK_STATUS.PENDING}', rv.created_at = $now
    MERGE (c)-[:HAS_REVIEW]->(rv)
  `, { changeId, tenantId, now, ciCodes })
}

// Dispatch table keyed by the step's `on_enter_create` metadata.
const ON_ENTER_CREATORS: Record<string, (session: SessionOrTx, changeId: string, tenantId: string) => Promise<void>> = {
  validation_and_deployment: createValidationAndDeploymentTasks,
  review:                    createReviewTasks,
}

/**
 * Side-effects to run immediately after the workflow enters a new step.
 * Reads `on_enter_create` metadata from Neo4j and dispatches to the matching
 * creator. Steps without the metadata are no-ops.
 */
export async function afterEnterStep(session: SessionOrTx, changeId: string, tenantId: string, stepName: string) {
  const row = await runQueryOne<{ hook: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    MATCH (wi)-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName
    RETURN step.on_enter_create AS hook
  `, { changeId, tenantId, stepName })
  // Entrando in "approval": crea i requisiti di approvazione (CM + owner group).
  if (stepName === 'approval') {
    const { createChangeApprovals } = await import('./approvalCreation.js')
    await createChangeApprovals(session, changeId, tenantId)
    // Standard = pre-approvata: nessun requisito, avanza subito a scheduled.
    const ct = await runQueryOne<{ t: string }>(session, `MATCH (c:Change {id: $changeId, tenant_id: $tenantId}) RETURN c.change_type AS t`, { changeId, tenantId })
    if (ct?.t === 'standard') {
      const { workflowEngine } = await import('@opengraphity/workflow')
      const instanceId = await getInstanceId(session as Session, changeId, tenantId)
      const res = await workflowEngine.transition(session as Session, { instanceId, toStepName: 'scheduled', triggeredBy: 'system', triggerType: 'automatic', notes: 'Standard: pre-approvata' }, { userId: 'system', entityData: {} })
      // Fail-loud: una standard ferma in approval senza requisiti non si
      // sbloccherebbe mai (nessun record da approvare).
      if (!res.success) {
        throw new GraphQLError(`Change standard: pre-approvazione non riuscita (${res.error ?? 'transizione fallita'})`, { extensions: { code: 'CONFLICT' } })
      }
      await afterEnterStep(session, changeId, tenantId, 'scheduled')
    }
  }
  const hook = row?.hook
  if (!hook) return
  const creator = ON_ENTER_CREATORS[hook]
  if (!creator) {
    // Un hook sconosciuto significa workflow mal configurato: senza i task di
    // fase la change entrerebbe in deployment/review "vuota" e sembrerebbe
    // completa. Meglio bloccare.
    logger.error({ changeId, stepName, hook }, '[afterEnterStep] on_enter_create hook sconosciuto')
    throw new GraphQLError(`Workflow mal configurato: hook on_enter_create "${hook}" sconosciuto per lo step "${stepName}"`, { extensions: { code: 'CONFLICT' } })
  }
  await creator(session, changeId, tenantId)
}
