/**
 * Tabella dei tipi di task della change + operazioni generiche.
 *
 * Le cinque mutation di riapertura e le tre di completamento erano otto copie
 * dello stesso blocco ("carica task → verifica → scrivi → audit → rileggi →
 * mappa") che differivano solo per label, relazione, campi da azzerare e
 * messaggio: qui le differenze sono DATI (TASK_KINDS) e la logica è una sola.
 * È anche dove si correggono i drift nati dalla duplicazione: il reopen di un
 * assessment ora azzera anche la priorità (che dal rischio deriva), e un
 * completamento su un task inesistente è NOT_FOUND, non un no-op silenzioso.
 */
import { GraphQLError } from 'graphql'
import { ValidationError } from '../../../lib/errors.js'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT, ROLE_LABEL } from '../../../lib/taskStatus.js'
import { withSession, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import {
  mapAssessmentTask, mapDeployPlanTask, mapValidationTest, mapDeploymentTask, mapReviewTask,
} from './mappers.js'
import {
  CHANGE_NOT_DELETED, assertAdmin, writeAudit, getCIName, assertUserInCITeam, afterEnterStep, resetChangeRisk,
} from './helpers.js'
import { evaluateAutoTransitions } from './autoTransitions.js'

export type TaskKind = 'assessment' | 'deploy-plan' | 'validation' | 'deployment' | 'review'

interface CompleteSpec {
  /** Gruppo del CI che può completare il task. */
  role:            'owner' | 'support'
  /** Azione di audit. */
  audit:           string
  /** Campo timestamp da valorizzare al completamento. */
  timestampField:  string
  /** Campo esito (se il task ha un esito) e valori ammessi. */
  resultField?:    string
  allowedResults?: readonly string[]
}

interface KindDef {
  label:  string          // label Neo4j del task
  rel:    string          // (change)-[:rel]->(task)
  byRel:  string          // (task)-[:byRel]->(user) di chi l'ha chiuso
  title:  string          // nome umano per audit
  reopen: { status: string; clear: readonly string[]; resetRisk: boolean }
  complete?: CompleteSpec
  map:    (p: Props) => unknown
}

export const TASK_KINDS: Record<TaskKind, KindDef> = {
  assessment: {
    label: 'AssessmentTask', rel: 'HAS_ASSESSMENT', byRel: 'COMPLETED_BY', title: 'Assessment',
    // Un assessment riaperto invalida rischio del CI, rischio aggregato e priorità.
    reopen: { status: TASK_STATUS.IN_PROGRESS, clear: ['score', 'completed_at'], resetRisk: true },
    map: mapAssessmentTask,
  },
  'deploy-plan': {
    label: 'DeployPlanTask', rel: 'HAS_DEPLOY_PLAN', byRel: 'COMPLETED_BY', title: 'Piano deploy',
    reopen: { status: TASK_STATUS.IN_PROGRESS, clear: ['completed_at'], resetRisk: false },
    map: mapDeployPlanTask,
  },
  validation: {
    label: 'ValidationTest', rel: 'HAS_VALIDATION', byRel: 'TESTED_BY', title: 'Validation',
    reopen: { status: TASK_STATUS.PENDING, clear: ['result', 'tested_at'], resetRisk: false },
    complete: { role: 'owner', audit: 'validation_completed', timestampField: 'tested_at', resultField: 'result', allowedResults: [VALIDATION_RESULT.PASS, VALIDATION_RESULT.FAIL] },
    map: mapValidationTest,
  },
  deployment: {
    label: 'DeploymentTask', rel: 'HAS_DEPLOYMENT', byRel: 'DEPLOYED_BY', title: 'Deployment',
    reopen: { status: TASK_STATUS.PENDING, clear: ['deployed_at'], resetRisk: false },
    complete: { role: 'support', audit: 'deployment_completed', timestampField: 'deployed_at' },
    map: mapDeploymentTask,
  },
  review: {
    label: 'ReviewTask', rel: 'HAS_REVIEW', byRel: 'REVIEWED_BY', title: 'Review',
    reopen: { status: TASK_STATUS.PENDING, clear: ['result', 'reviewed_at'], resetRisk: false },
    complete: { role: 'owner', audit: 'review_completed', timestampField: 'reviewed_at', resultField: 'result', allowedResults: [REVIEW_RESULT.CONFIRMED, REVIEW_RESULT.REJECTED] },
    map: mapReviewTask,
  },
}

/** Riapre (admin) un task completato riportandolo allo stato aperto del suo tipo. */
export async function reopenTask(kind: TaskKind, taskId: string, reason: string, ctx: GraphQLContext) {
  assertAdmin(ctx)
  const k = TASK_KINDS[kind]
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string; role: string | null }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:${k.rel}]->(t:${k.label} {id: $taskId})
      WHERE ${CHANGE_NOT_DELETED}
      RETURN c.id AS changeId, t.ci_id AS ciId, t.responder_role AS role
    `, { taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`${k.label} ${taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })

    const clears = k.reopen.clear.map((f) => `, t.${f} = null`).join('')
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:${k.label} {id: $taskId, tenant_id: $tenantId})
      SET t.status = $status${clears}
      WITH t
      OPTIONAL MATCH (t)-[r:${k.byRel}]->()
      DELETE r
    `, { taskId, tenantId: ctx.tenantId, status: k.reopen.status }))

    if (k.reopen.resetRisk) {
      await session.executeWrite((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId, tenant_id: $tenantId})
        SET r.risk_score = null, r.ci_phase = 'assessment'
      `, { changeId: tctx.changeId, ciId: tctx.ciId, tenantId: ctx.tenantId }))
      await resetChangeRisk(session, tctx.changeId, ctx.tenantId)
    } else {
      await session.executeWrite((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId}) SET c.updated_at = $now
      `, { changeId: tctx.changeId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    }

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    const who = tctx.role ? ` ${ROLE_LABEL[tctx.role] ?? tctx.role}` : ''
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'task_reopened', ctx.userId,
      `${k.title}${who} · ${ciName} riaperto: ${reason}`)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:${k.label} {id: $taskId, tenant_id: $tenantId}) RETURN properties(t) AS props
    `, { taskId, tenantId: ctx.tenantId })
    return row ? k.map(row.props) : null
  }, true)
}

/**
 * Completa il task di fase (validation / deployment / review) del CI sulla
 * change. Solo il gruppo previsto del CI può farlo; un task inesistente (CI
 * sbagliato, fase sbagliata, task già riaperto) è NOT_FOUND, non un no-op.
 */
export async function completeTask(kind: TaskKind, changeId: string, ciId: string, result: string | undefined, ctx: GraphQLContext) {
  const k = TASK_KINDS[kind]
  const c = k.complete
  if (!c) throw new Error(`Il task di tipo "${kind}" non si completa con completeTask`)
  if (c.allowedResults) {
    if (!result || !c.allowedResults.includes(result)) {
      throw new ValidationError(`result deve essere ${c.allowedResults.map((r) => `"${r}"`).join(' o ')}`)
    }
  }
  return withSession(async (session) => {
    await assertUserInCITeam(session, ciId, ctx.tenantId, ctx, c.role)
    const now = new Date().toISOString()
    const setResult = c.resultField ? `, t.${c.resultField} = $result` : ''
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:${k.rel}]->(t:${k.label} {ci_id: $ciId})
      WHERE ${CHANGE_NOT_DELETED}
      SET t.status = $completed, t.${c.timestampField} = $now${setResult}
      WITH c, t
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        MERGE (t)-[:${k.byRel}]->(u)
      )
      SET c.updated_at = $now
      RETURN t.id AS id
    `, { changeId, ciId, result: result ?? null, completed: TASK_STATUS.COMPLETED, tenantId: ctx.tenantId, userId: ctx.userId, now }))
    if (res.records.length === 0) {
      throw new GraphQLError(`${k.title} per il CI ${ciId} non trovato sulla change (fase sbagliata o task riaperto?)`, { extensions: { code: 'NOT_FOUND' } })
    }

    const ciName = await getCIName(session, ciId, ctx.tenantId)
    await writeAudit(session, changeId, ctx.tenantId, c.audit, ctx.userId,
      c.resultField ? `${ciName}: ${result}` : `${k.title} completato su ${ciName}`)
    await evaluateAutoTransitions(session, changeId, ctx, afterEnterStep)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (:Change {id: $changeId, tenant_id: $tenantId})-[:${k.rel}]->(t:${k.label} {ci_id: $ciId})
      RETURN properties(t) AS props
    `, { changeId, ciId, tenantId: ctx.tenantId })
    return row ? k.map(row.props) : null
  }, true)
}
