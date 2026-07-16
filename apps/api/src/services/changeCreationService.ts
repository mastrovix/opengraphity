/**
 * Shared Change (RFC) creation logic.
 *
 * Single source of truth used by BOTH:
 *   - the GraphQL `createChange` mutation (graphql/resolvers/change/changeMutations.ts)
 *   - the REST v1 `POST /api/v1/changes` route (rest/v1/changes.ts)
 *
 * The whole RFC bootstrap lives here: CI Owner/Support Group validation,
 * progressive CHG code generation, AssessmentTask (functional + technical)
 * and DeployPlanTask creation per CI, workflow instance creation and the
 * change-level audit entry. Callers only decide how to shape the response.
 *
 * Errors are thrown as lib/errors.js classes (ValidationError, ...): GraphQL
 * lets them bubble up as-is, the REST route translates them into HTTP 400.
 */
import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import { ValidationError } from '../lib/errors.js'
import { TASK_STATUS, ASSESSMENT_ROLE } from '../lib/taskStatus.js'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import {
  writeAudit,
  nextChangeCode,
  getNextTaskCodes,
  assertCIHasOwnerAndSupport,
} from '../graphql/resolvers/change/helpers.js'

export interface ChangeCreationInput {
  title:         string
  description?:  string | null
  changeOwner?:  string | null
  affectedCIIds: string[]
}

export interface ChangeCreationCtx {
  tenantId: string
  userId:   string | null
}

export interface CreatedChange {
  id:   string
  code: string
}

export async function createChangeRFC(
  input: ChangeCreationInput,
  ctx: ChangeCreationCtx,
): Promise<CreatedChange> {
  const { title, description, changeOwner, affectedCIIds } = input
  if (!affectedCIIds || affectedCIIds.length === 0) {
    throw new ValidationError('Un change deve avere almeno un CI impattato')
  }
  if (!title || title.trim().length === 0) {
    throw new ValidationError('title è obbligatorio')
  }
  return withSession(async (session) => {
    await assertCIHasOwnerAndSupport(session, ctx.tenantId, affectedCIIds)
    const code = await nextChangeCode(session, ctx.tenantId)
    const taskCodes = await getNextTaskCodes(session, ctx.tenantId, affectedCIIds.length * 3)
    const ciTasks = affectedCIIds.map((ciId, i) => ({
      ciId,
      ownerCode:   taskCodes[i * 3]!,
      supportCode: taskCodes[i * 3 + 1]!,
      planCode:    taskCodes[i * 3 + 2]!,
    }))
    const id = uuidv4()
    const now = new Date().toISOString()

    await session.executeWrite((tx) => tx.run(`
      CREATE (c:Change {
        id: $id, tenant_id: $tenantId, code: $code,
        title: $title, description: $description,
        aggregate_risk_score: null,
        approval_route: null, approval_status: null,
        created_at: $now, updated_at: $now
      })
      WITH c
      OPTIONAL MATCH (req:User {id: $requesterId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN req IS NULL THEN [] ELSE [1] END |
        CREATE (c)-[:REQUESTED_BY]->(req)
      )
      WITH c
      OPTIONAL MATCH (owner:User {id: $ownerId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN owner IS NULL THEN [] ELSE [1] END |
        CREATE (c)-[:OWNED_BY]->(owner)
      )
      WITH c
      UNWIND $ciTasks AS ct
      MATCH (ci {id: ct.ciId, tenant_id: $tenantId})
      MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
      MATCH (ci)-[:SUPPORTED_BY]->(supportTeam:Team)
      CREATE (c)-[:AFFECTS_CI {ci_phase: 'assessment'}]->(ci)
      CREATE (ownerT:AssessmentTask {
        id: randomUUID(), code: ct.ownerCode, tenant_id: $tenantId, ci_id: ci.id,
        responder_role: '${ASSESSMENT_ROLE.OWNER}', status: '${TASK_STATUS.PENDING}', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(ownerT)
      CREATE (ownerT)-[:ASSIGNED_TO_TEAM]->(ownerTeam)
      CREATE (supportT:AssessmentTask {
        id: randomUUID(), code: ct.supportCode, tenant_id: $tenantId, ci_id: ci.id,
        responder_role: '${ASSESSMENT_ROLE.SUPPORT}', status: '${TASK_STATUS.PENDING}', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(supportT)
      CREATE (supportT)-[:ASSIGNED_TO_TEAM]->(supportTeam)
      CREATE (dp:DeployPlanTask {
        id: randomUUID(), code: ct.planCode, tenant_id: $tenantId, ci_id: ci.id,
        status: '${TASK_STATUS.PENDING}', steps: '[]',
        created_at: $now
      })
      CREATE (c)-[:HAS_DEPLOY_PLAN]->(dp)
      CREATE (dp)-[:ASSIGNED_TO_TEAM]->(supportTeam)
    `, {
      id, code, title,
      description: description ?? null,
      requesterId: ctx.userId,
      ownerId: changeOwner ?? null,
      ciTasks,
      tenantId: ctx.tenantId,
      now,
    }))

    await workflowEngine.createInstance(session, ctx.tenantId, id, 'change')

    await writeAudit(session, id, ctx.tenantId, 'change_created', ctx.userId,
      `Change ${code} creato con ${affectedCIIds.length} CI`)

    return { id, code }
  }, true)
}
