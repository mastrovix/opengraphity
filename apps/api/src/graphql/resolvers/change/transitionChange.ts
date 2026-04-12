import { GraphQLError } from 'graphql'
import { withSession, getSession } from '../ci-utils.js'
import { workflowEngine } from '@opengraphity/workflow'
import { runQuery } from '@opengraphity/neo4j'
import type { WorkflowInstance } from '@opengraphity/workflow'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, type Props } from './mappers.js'
import * as changeService from '../../../services/changeService.js'
import { audit } from '../../../lib/audit.js'

// ── createChangeComment helper ────────────────────────────────────────────────

type Session = ReturnType<typeof getSession>

async function createChangeComment(
  session: Session,
  tenantId: string,
  changeId: string,
  text: string,
  type: string,
  userId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    CREATE (cm:ChangeComment {
      id:         randomUUID(),
      tenant_id:  $tenantId,
      change_id:  $changeId,
      text:       $text,
      type:       $type,
      created_by: $userId,
      created_at: $now
    })
    CREATE (c)-[:HAS_COMMENT]->(cm)
  `, { changeId, tenantId, text, type, userId, now }))
}

// ── executeChangeTransition ───────────────────────────────────────────────────

export async function executeChangeTransition(
  _: unknown,
  args: { instanceId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Get the change entity associated with this workflow instance
    const entityRes = await session.executeRead((tx) => tx.run(`
      MATCH (wi:WorkflowInstance {id: $instanceId})
      RETURN wi.entity_id AS entityId, wi.tenant_id AS tenantId, wi.current_step AS currentStep
    `, { instanceId: args.instanceId }))
    if (!entityRes.records.length) {
      return { success: false, error: 'Workflow instance not found', instance: null }
    }
    const changeId   = entityRes.records[0].get('entityId')    as string
    const tenantId   = entityRes.records[0].get('tenantId')    as string
    const fromStep   = entityRes.records[0].get('currentStep') as string

    // Guard: assessment→cab_approval requires all AssessmentTasks in a final state + at least 1 DeployStep
    if (args.toStep === 'cab_approval') {
      const tasksResult = await session.executeRead((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
              -[:HAS_CHANGE_TASK]->(t:ChangeTask)
        WHERE t.task_type = 'assessment'
        RETURN t.status AS status
      `, { changeId, tenantId }))
      const tasks = tasksResult.records.map((r) => r.get('status') as string)
      const allDone = tasks.length > 0 && tasks.every((s) =>
        ['completed', 'skipped', 'rejected'].includes(s),
      )
      if (!allDone) {
        const pending = tasks.filter((s) =>
          !['completed', 'skipped', 'rejected'].includes(s),
        ).length
        return { success: false, error: `${pending} task di assessment non ancora completati`, instance: null }
      }

      const stepsResult = await session.executeRead((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(s:ChangeTask)
        WHERE s.task_type = 'deploy'
        RETURN count(s) AS total
      `, { changeId, tenantId }))
      const totalSteps = Number(stepsResult.records[0]?.get('total') ?? 0)
      if (totalSteps === 0) {
        return { success: false, error: 'Definisci almeno 1 deploy step prima di inviare al CAB', instance: null }
      }
    }

    // Guard: deployment→completed requires all DeploySteps completed or skipped
    if (args.toStep === 'completed') {
      const pendingRes = await session.executeRead((tx) => tx.run(`
        MATCH (c:Change {id: $changeId})-[:HAS_CHANGE_TASK]->(s:ChangeTask)
        WHERE s.task_type = 'deploy' AND NOT s.status IN ['completed', 'skipped']
        RETURN count(s) AS pending
      `, { changeId }))
      const pending = Number(pendingRes.records[0]?.get('pending') ?? 0)
      if (pending > 0) {
        return { success: false, error: `Ci sono ${pending} deploy step non completati o saltati`, instance: null }
      }
    }

    // Hook: when transitioning to 'assessment', create AssessmentTasks for each CI
    if (args.toStep === 'assessment') {
      const now = new Date().toISOString()

      // Step 1: Create tasks and get CI + owner team in one write
      const tasksResult = await session.executeWrite((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
              -[:AFFECTS]->(ci)
        OPTIONAL MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
        CREATE (t:ChangeTask {
          id:         randomUUID(),
          task_type:  'assessment',
          tenant_id:  $tenantId,
          change_id:  $changeId,
          ci_id:      ci.id,
          status:     'open',
          created_at: $now,
          updated_at: $now
        })
        CREATE (c)-[:HAS_CHANGE_TASK]->(t)
        CREATE (t)-[:ASSESSES]->(ci)
        RETURN t.id AS taskId, ownerTeam.id AS teamId,
               ci.name AS ciName, ownerTeam.name AS teamName, c.title AS changeTitle
      `, { changeId, tenantId, now }))

      // Step 2: Assign owner team to each task (only where team exists)
      for (const record of tasksResult.records) {
        const taskId = record.get('taskId') as string
        const teamId = record.get('teamId') as string | null
        if (teamId) {
          await session.executeWrite((tx) => tx.run(`
            MATCH (t:ChangeTask {id: $taskId})
            MATCH (team:Team {id: $teamId, tenant_id: $tenantId})
            CREATE (t)-[:ASSIGNED_TO_TEAM]->(team)
          `, { taskId, teamId, tenantId }))
        }
      }

      // Step 3: Publish change.task_assigned for each task
      for (const record of tasksResult.records) {
        await changeService.publishTaskAssigned({
          changeId,
          changeTitle: (record.get('changeTitle') ?? '') as string,
          taskId:      record.get('taskId')    as string,
          ciName:      (record.get('ciName')   ?? '—') as string,
          teamName:    (record.get('teamName') ?? '—') as string,
          assignedTo:  '—',
        }, { tenantId, userId: ctx.userId })
      }
    }

    // Execute the transition
    const result = await workflowEngine.transition(session, {
      instanceId:  args.instanceId,
      toStepName:  args.toStep,
      triggeredBy: ctx.userId,
      triggerType: 'manual',
      notes:       args.notes,
    }, { userId: ctx.userId, entityData: {} })

    // Hook: assign assessment tasks
    if (result.success && args.toStep === 'assessment') {
      void audit(ctx, 'change.task_assigned', 'Change', changeId)
    }

    // Publish change.approved when transition reaches 'scheduled'
    if (result.success && args.toStep === 'scheduled') {
      await changeService.approveChange(changeId, { tenantId, userId: ctx.userId })
      void audit(ctx, 'change.approved', 'Change', changeId)
    }

    if (result.success && args.toStep === 'completed') {
      await changeService.completeChange(changeId, { tenantId, userId: ctx.userId })
      void audit(ctx, 'change.completed', 'Change', changeId)
    }

    if (result.success && args.toStep === 'failed') {
      await changeService.failChange(changeId, { tenantId, userId: ctx.userId })
      void audit(ctx, 'change.failed', 'Change', changeId)
    }

    if (result.success && args.toStep === 'rejected') {
      await changeService.rejectChange(changeId, { tenantId, userId: ctx.userId })
      void audit(ctx, 'change.rejected', 'Change', changeId)
    }

    // Audit comment when rejected
    if (result.success && args.toStep === 'rejected') {
      await createChangeComment(
        session, tenantId, changeId,
        `Change rigettato da step ${fromStep}${args.notes ? `: ${args.notes}` : ''}`,
        'rejected', ctx.userId,
      )
    }

    if (result.success) {
      void audit(ctx, 'change.transitioned', 'Change', changeId, { toStep: args.toStep })
    }

    const inst = result.instance as WorkflowInstance | undefined
    return {
      success:  result.success,
      error:    result.error ?? null,
      instance: inst ? {
        id:          inst.id,
        currentStep: inst.currentStep,
        status:      inst.status,
        createdAt:   inst.createdAt,
        updatedAt:   inst.updatedAt,
      } : null,
    }
  }, true)
}

// ── Backward-compat mutations ─────────────────────────────────────────────────

export async function approveChange(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status = 'approved', c.updated_at = $now
      RETURN properties(c) as props
    `, { id: args.id, tenantId: ctx.tenantId, now })
    const row = rows[0]
    if (!row) throw new GraphQLError('Change not found')
    return mapChange(row.props)
  }, true)
}

export async function rejectChange(_: unknown, args: { id: string; reason?: string }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status = 'rejected', c.rejection_reason = $reason, c.updated_at = $now
      RETURN properties(c) as props
    `, { id: args.id, tenantId: ctx.tenantId, reason: args.reason ?? null, now })
    const row = rows[0]
    if (!row) throw new GraphQLError('Change not found')
    return mapChange(row.props)
  }, true)
}

export async function deployChange(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status = 'deployed', c.updated_at = $now
      RETURN properties(c) as props
    `, { id: args.id, tenantId: ctx.tenantId, now })
    const row = rows[0]
    if (!row) throw new GraphQLError('Change not found')
    return mapChange(row.props)
  }, true)
}

export async function failChange(_: unknown, args: { id: string; reason?: string }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.status = 'failed', c.failure_reason = $reason, c.updated_at = $now
      RETURN properties(c) as props
    `, { id: args.id, tenantId: ctx.tenantId, reason: args.reason ?? null, now })
    const row = rows[0]
    if (!row) throw new GraphQLError('Change not found')
    return mapChange(row.props)
  }, true)
}
