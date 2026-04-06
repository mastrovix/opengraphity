import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { withSession, getSession } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, mapChangeComment, type Props } from './mappers.js'

// ── createChangeComment helper ────────────────────────────────────────────────

type Session = ReturnType<typeof getSession>

export async function createChangeComment(
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

export function toInt(v: unknown, fallback = 0): number {
  if (v == null) return fallback
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

// ── addAffectedCIToChange ─────────────────────────────────────────────────────

export async function addAffectedCIToChange(
  _: unknown, args: { changeId: string; ciId: string; relationType?: string | null }, ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const { getAllowedCILabels } = await import('../itilRelations.js')
  const allowedTypes = await getAllowedCILabels(ctx.tenantId, 'change')
  const ciWhereClause = allowedTypes.length > 0
    ? `ANY(label IN labels(ci) WHERE label IN $allowedLabels)`
    : `(ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)`
  const allowedLabels = allowedTypes.map((t) =>
    t.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(''),
  )

  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE ${ciWhereClause}
      MERGE (c)-[r:AFFECTS]->(ci)
      SET c.updated_at = $now, r.relation_type = $relationType
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, now, allowedLabels, relationType: args.relationType ?? null }))

    // Auto-create AssessmentTask if change is currently in 'assessment' step
    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.current_step AS step
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))

    if (wiResult.records[0]?.get('step') === 'assessment') {
      // Check no task already exists for this CI on this change
      const existingTask = await session.executeRead((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(t:ChangeTask)-[:ASSESSES]->(ci {id: $ciId})
        WHERE t.task_type = 'assessment'
        RETURN t.id AS taskId LIMIT 1
      `, { changeId: args.changeId, tenantId: ctx.tenantId, ciId: args.ciId }))

      if (!existingTask.records.length) {
        const ciResult = await session.executeRead((tx) => tx.run(`
          MATCH (ci {id: $ciId})
          OPTIONAL MATCH (ci)-[:OWNED_BY]->(t:Team)
          RETURN ci, t AS ownerTeam
        `, { ciId: args.ciId }))

        const ciRec = ciResult.records[0]
        if (ciRec) {
          const ownerTeam = ciRec.get('ownerTeam')
          const taskId = uuidv4()
          await session.executeWrite((tx) => tx.run(`
            MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
            MATCH (ci {id: $ciId})
            CREATE (t:ChangeTask {
              id:         $taskId,
              task_type:  'assessment',
              tenant_id:  $tenantId,
              change_id:  $changeId,
              ci_id:      $ciId,
              status:     'open',
              created_at: $now,
              updated_at: $now
            })
            CREATE (c)-[:HAS_CHANGE_TASK]->(t)
            CREATE (t)-[:ASSESSES]->(ci)
          `, { changeId: args.changeId, tenantId: ctx.tenantId, ciId: args.ciId, taskId, now }))

          if (ownerTeam) {
            const teamId = (ownerTeam.properties as Record<string, unknown>)['id'] as string
            await session.executeWrite((tx) => tx.run(`
              MATCH (t:ChangeTask {id: $taskId})
              MATCH (team:Team {id: $teamId, tenant_id: $tenantId})
              MERGE (t)-[:ASSIGNED_TO_TEAM]->(team)
            `, { taskId, teamId, tenantId: ctx.tenantId }))
          }
        }
      }
    }

    const r = await session.executeRead((tx) => tx.run(
      `MATCH (c:Change {id: $id, tenant_id: $tenantId}) RETURN properties(c) AS props`,
      { id: args.changeId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new GraphQLError('Change not found')
    return mapChange(row.get('props') as Props)
  }, true)
}

// ── removeAffectedCIFromChange ────────────────────────────────────────────────

export async function removeAffectedCIFromChange(
  _: unknown, args: { changeId: string; ciId: string; reason: string }, ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    // Get CI name before removing
    const ciRes = await session.executeRead((tx) => tx.run(`
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
      RETURN ci.name AS ciName
    `, { ciId: args.ciId, tenantId: ctx.tenantId }))
    const ciName = (ciRes.records[0]?.get('ciName') as string | null) ?? 'sconosciuto'

    // Remove the AFFECTS relation
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
            -[r:AFFECTS]->(ci {id: $ciId, tenant_id: $tenantId})
      DELETE r
      SET c.updated_at = $now
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, now }))

    // Get current workflow step
    const wiRes = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.current_step AS step
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))
    const currentStep = wiRes.records[0]?.get('step') as string | null

    // If in assessment: skip AssessmentTask for this CI
    if (currentStep === 'assessment') {
      await session.executeWrite((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(t:ChangeTask)-[:ASSESSES]->(ci {id: $ciId})
        WHERE t.task_type = 'assessment' AND t.status = 'open'
        SET t.status     = 'skipped',
            t.notes      = $reason,
            t.updated_at = $now
      `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, reason: args.reason, now }))
    }

    // Create audit comment
    await createChangeComment(
      session, ctx.tenantId, args.changeId,
      `CI rimosso: ${ciName}. Motivo: ${args.reason}`,
      'ci_removed', ctx.userId,
    )

    const r = await session.executeRead((tx) => tx.run(
      `MATCH (c:Change {id: $id, tenant_id: $tenantId}) RETURN properties(c) AS props`,
      { id: args.changeId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new GraphQLError('Change not found')
    return mapChange(row.get('props') as Props)
  }, true)
}

// ── addChangeComment ──────────────────────────────────────────────────────────

export async function addChangeComment(
  _: unknown, args: { changeId: string; text: string }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await createChangeComment(session, ctx.tenantId, args.changeId, args.text, 'manual', ctx.userId)
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_COMMENT]->(cm:ChangeComment)
      OPTIONAL MATCH (u:User {id: cm.created_by, tenant_id: $tenantId})
      RETURN properties(cm) AS cmProps, properties(u) AS uProps
      ORDER BY cm.created_at DESC LIMIT 1
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('Comment not found')
    return mapChangeComment(row.get('cmProps') as Props, row.get('uProps') as Props | null)
  }, true)
}

// ── Re-exports from extracted files ──────────────────────────────────────────

export { updateAssessmentTask, completeAssessmentTask, rejectAssessmentTask, assignAssessmentTaskTeam, assignAssessmentTaskUser } from './assessmentTasks.js'
export { saveDeploySteps, assignDeployStepToTeam, assignDeployStepToUser, assignDeployStepValidationTeam, assignDeployStepValidationUser, updateDeployStepStatus, updateDeployStepValidation, updateChangeTask } from './deploySteps.js'
export { saveChangeValidation, completeChangeValidation, failChangeValidation } from './validationTasks.js'
