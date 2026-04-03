import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { withSession, getSession } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, mapChangeTask, mapChangeComment, type Props } from './mappers.js'
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

function toInt(v: unknown, fallback = 0): number {
  if (v == null) return fallback
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

// ── addAffectedCIToChange ─────────────────────────────────────────────────────

export async function addAffectedCIToChange(
  _: unknown, args: { changeId: string; ciId: string }, ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
      MERGE (c)-[:AFFECTS]->(ci)
      SET c.updated_at = $now
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, now }))

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

// ── saveDeploySteps ───────────────────────────────────────────────────────────

export async function saveDeploySteps(
  _: unknown,
  args: {
    changeId: string
    steps: Array<{
      order: number; title: string; description?: string
      scheduledStart: string; durationDays: number; hasValidation: boolean
      validationStart?: string; validationEnd?: string
      assignedTeamId?: string; validationTeamId?: string
    }>
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    // Delete existing deploy steps
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(s:ChangeTask)
      WHERE s.task_type = 'deploy'
      DETACH DELETE s
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))

    // Fetch default validation team (owner of first affected CI)
    const ownerResult = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
            -[:AFFECTS]->(ci)
            -[:OWNED_BY]->(ownerTeam:Team)
      RETURN ownerTeam.id AS teamId
      LIMIT 1
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))
    const defaultValidationTeamId = (ownerResult.records[0]?.get('teamId') as string | null) ?? null

    // Fetch default deploy team (support group of first affected CI)
    const supportResult = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
            -[:AFFECTS]->(ci)
            -[:SUPPORTED_BY]->(supportTeam:Team)
      RETURN supportTeam.id AS teamId
      LIMIT 1
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))
    const defaultDeployTeamId = (supportResult.records[0]?.get('teamId') as string | null) ?? null

    // Create new steps
    for (const step of args.steps) {
      const stepId = uuidv4()
      const startDate = new Date(step.scheduledStart)
      const endDate = new Date(startDate)
      endDate.setDate(endDate.getDate() + step.durationDays)
      const scheduledEnd = endDate.toISOString()

      await session.executeWrite((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
        CREATE (s:ChangeTask {
          id:               $stepId,
          task_type:        'deploy',
          tenant_id:        $tenantId,
          change_id:        $changeId,
          order:            $order,
          title:            $title,
          description:      $description,
          status:           'pending',
          scheduled_start:  $scheduledStart,
          duration_days:    $durationDays,
          scheduled_end:    $scheduledEnd,
          has_validation:   $hasValidation,
          validation_start: $validationStart,
          validation_end:   $validationEnd,
          validation_status: CASE WHEN $hasValidation THEN 'pending' ELSE null END,
          created_at:       $now,
          updated_at:       $now
        })
        CREATE (c)-[:HAS_CHANGE_TASK]->(s)
      `, {
        changeId: args.changeId, tenantId: ctx.tenantId,
        stepId, order: step.order, title: step.title,
        description: step.description ?? null,
        scheduledStart: step.scheduledStart, durationDays: step.durationDays,
        scheduledEnd, hasValidation: step.hasValidation,
        validationStart: step.validationStart ?? null, validationEnd: step.validationEnd ?? null,
        now,
      }))

      if (step.assignedTeamId) {
        await session.executeWrite((tx) => tx.run(`
          MATCH (s:ChangeTask {id: $stepId}), (t:Team {id: $teamId, tenant_id: $tenantId})
          MERGE (s)-[:ASSIGNED_TO_TEAM]->(t)
        `, { stepId, teamId: step.assignedTeamId, tenantId: ctx.tenantId }))
      } else if (defaultDeployTeamId) {
        await session.executeWrite((tx) => tx.run(`
          MATCH (s:ChangeTask {id: $stepId})
          MATCH (team:Team {id: $teamId, tenant_id: $tenantId})
          MERGE (s)-[:ASSIGNED_TO_TEAM]->(team)
        `, { stepId, teamId: defaultDeployTeamId, tenantId: ctx.tenantId }))
      }
      if (step.validationTeamId) {
        await session.executeWrite((tx) => tx.run(`
          MATCH (s:ChangeTask {id: $stepId}), (t:Team {id: $teamId, tenant_id: $tenantId})
          MERGE (s)-[:VALIDATION_ASSIGNED_TO_TEAM]->(t)
        `, { stepId, teamId: step.validationTeamId, tenantId: ctx.tenantId }))
      } else if (step.hasValidation && defaultValidationTeamId) {
        await session.executeWrite((tx) => tx.run(`
          MATCH (s:ChangeTask {id: $stepId})
          MATCH (team:Team {id: $teamId, tenant_id: $tenantId})
          MERGE (s)-[:VALIDATION_ASSIGNED_TO_TEAM]->(team)
        `, { stepId, teamId: defaultValidationTeamId, tenantId: ctx.tenantId }))
      }
    }

    // Update Change scheduled_start / scheduled_end
    if (args.steps.length > 0) {
      const starts = args.steps.map((s) => s.scheduledStart).sort()
      const ends   = args.steps.map((s) => {
        const d = new Date(s.scheduledStart)
        d.setDate(d.getDate() + s.durationDays)
        return d.toISOString()
      }).sort()
      await session.executeWrite((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
        SET c.scheduled_start = $start, c.scheduled_end = $end, c.updated_at = $now
      `, { changeId: args.changeId, tenantId: ctx.tenantId, start: starts[0], end: ends[ends.length - 1], now }))
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

// ── saveChangeValidation ──────────────────────────────────────────────────────

export async function saveChangeValidation(
  _: unknown,
  args: { changeId: string; scheduledStart: string; scheduledEnd: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    // Validate: validation must end before first deploy step starts
    const firstStepRes = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(s:ChangeTask)
      WHERE s.task_type = 'deploy'
      RETURN s.scheduled_start AS start ORDER BY s.order ASC LIMIT 1
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))

    if (firstStepRes.records.length > 0) {
      const firstStart = firstStepRes.records[0].get('start') as string
      if (args.scheduledEnd >= firstStart) {
        throw new GraphQLError(`La validazione deve terminare prima dell'inizio del primo deploy step (${firstStart})`)
      }
    }

    const valId = uuidv4()
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      MERGE (v:ChangeTask {change_id: $changeId, tenant_id: $tenantId, task_type: 'validation'})
      ON CREATE SET
        v.id             = $valId,
        v.created_at     = $now
      SET
        v.type           = 'global',
        v.scheduled_start = $scheduledStart,
        v.scheduled_end  = $scheduledEnd,
        v.status         = 'pending',
        v.updated_at     = $now
      MERGE (c)-[:HAS_CHANGE_TASK]->(v)
    `, { changeId: args.changeId, tenantId: ctx.tenantId, valId, scheduledStart: args.scheduledStart, scheduledEnd: args.scheduledEnd, now }))

    const result = await session.executeRead((tx) => tx.run(
      `MATCH (c:Change {id: $id, tenant_id: $tenantId}) RETURN properties(c) AS props`,
      { id: args.changeId, tenantId: ctx.tenantId },
    ))
    const row = result.records[0]
    if (!row) throw new GraphQLError('Change not found')
    return mapChange(row.get('props') as Props)
  }, true)
}

// ── updateAssessmentTask ──────────────────────────────────────────────────────

export async function updateAssessmentTask(
  _: unknown,
  args: { taskId: string; input: { riskLevel: string; impactDescription: string; mitigation?: string; notes?: string; assignedTeamId?: string; assignedUserId?: string } },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      SET t.risk_level          = $riskLevel,
          t.impact_description  = $impactDescription,
          t.mitigation          = $mitigation,
          t.notes               = $notes,
          t.status              = 'open',
          t.updated_at          = $now
    `, { taskId: args.taskId, tenantId: ctx.tenantId, riskLevel: args.input.riskLevel, impactDescription: args.input.impactDescription, mitigation: args.input.mitigation ?? null, notes: args.input.notes ?? null, now }))

    if (args.input.assignedTeamId) {
      await session.executeWrite((tx) => tx.run(`
        MATCH (t:ChangeTask {id: $taskId})
        OPTIONAL MATCH (t)-[old:ASSIGNED_TO_TEAM]->() DELETE old
        WITH t MATCH (team:Team {id: $teamId, tenant_id: $tenantId})
        CREATE (t)-[:ASSIGNED_TO_TEAM]->(team)
      `, { taskId: args.taskId, teamId: args.input.assignedTeamId, tenantId: ctx.tenantId }))
    }

    const r = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      RETURN properties(t) AS tProps, properties(ci) AS ciProps, properties(team) AS teamProps, properties(u) AS uProps
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('tProps') as Props,
      row.get('ciProps') as Props | null,
      row.get('teamProps') as Props | null,
      row.get('uProps') as Props | null,
    )
  }, true)
}

// ── completeAssessmentTask ────────────────────────────────────────────────────

export async function completeAssessmentTask(
  _: unknown,
  args: { taskId: string; input: { riskLevel: string; impactDescription: string; mitigation?: string; notes?: string; assignedTeamId?: string; assignedUserId?: string } },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    const teamCheck = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId})
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      RETURN team
    `, { taskId: args.taskId }))
    if (!teamCheck.records[0]?.get('team'))
      throw new GraphQLError('Assegna un team prima di completare il task')

    const taskData = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      RETURN t.change_id AS changeId
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))
    const changeId = taskData.records[0]?.get('changeId') as string | null
    if (changeId) void audit(ctx, 'change.task_completed', 'Change', changeId)
    if (changeId) {
      const stepsResult = await session.executeRead((tx) => tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
              -[:HAS_CHANGE_TASK]->(s:ChangeTask)
        WHERE s.task_type = 'deploy'
        RETURN count(s) AS total
      `, { changeId, tenantId: ctx.tenantId }))
      const totalSteps = toInt(stepsResult.records[0]?.get('total'))
      if (totalSteps === 0)
        throw new GraphQLError('Aggiungi almeno uno step di deployment prima di completare il task')
    }

    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      SET t.risk_level          = $riskLevel,
          t.impact_description  = $impactDescription,
          t.mitigation          = $mitigation,
          t.notes               = $notes,
          t.status              = 'completed',
          t.completed_at        = $now,
          t.updated_at          = $now
    `, { taskId: args.taskId, tenantId: ctx.tenantId, riskLevel: args.input.riskLevel, impactDescription: args.input.impactDescription, mitigation: args.input.mitigation ?? null, notes: args.input.notes ?? null, now }))

    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId})
      WHERE NOT (t)-[:ASSIGNED_TO]->()
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (t)-[:ASSIGNED_TO]->(u)
    `, { taskId: args.taskId, userId: ctx.userId, tenantId: ctx.tenantId }))

    const r = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      RETURN properties(t) AS tProps, properties(ci) AS ciProps, properties(team) AS teamProps, properties(u) AS uProps
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('tProps') as Props,
      row.get('ciProps') as Props | null,
      row.get('teamProps') as Props | null,
      row.get('uProps') as Props | null,
    )
  }, true)
}

// ── rejectAssessmentTask ──────────────────────────────────────────────────────

export async function rejectAssessmentTask(
  _: unknown,
  args: { taskId: string; reason: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // 1. Recupera task + CI + change_id
    const taskResult = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      MATCH (t)-[:ASSESSES]->(ci)
      RETURN t, ci.id AS ciId, ci.name AS ciName, t.change_id AS changeId
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))
    if (!taskResult.records.length) throw new GraphQLError('Task non trovato')
    const rec      = taskResult.records[0]
    const changeId = rec.get('changeId') as string
    const ciId     = rec.get('ciId')     as string
    const ciName   = rec.get('ciName')   as string
    const now      = new Date().toISOString()

    // 2. Setta task status = skipped con skip_reason
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      SET t.status       = 'skipped',
          t.skip_reason  = $reason,
          t.completed_at = $now,
          t.updated_at   = $now
    `, { taskId: args.taskId, tenantId: ctx.tenantId, reason: args.reason, now }))

    // 3. Auto-assegna utente se non assegnato
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId})
      WHERE NOT (t)-[:ASSIGNED_TO]->()
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (t)-[:ASSIGNED_TO]->(u)
    `, { taskId: args.taskId, userId: ctx.userId, tenantId: ctx.tenantId }))

    // 4. Rimuovi CI dagli affected del change
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
            -[r:AFFECTS]->(ci {id: $ciId})
      DELETE r
    `, { changeId, ciId, tenantId: ctx.tenantId }))

    // 5. Crea commento automatico
    await createChangeComment(
      session, ctx.tenantId, changeId,
      `Task assessment rigettato per CI "${ciName}" — CI rimosso dagli affected. Motivo: ${args.reason}`,
      'task_skipped', ctx.userId,
    )

    // 6. Ritorna task aggiornato
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId})
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      OPTIONAL MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
      OPTIONAL MATCH (ci)-[:SUPPORTED_BY]->(supportTeam:Team)
      RETURN properties(t) AS tProps, properties(team) AS teamProps,
             properties(u) AS uProps, properties(ci) AS ciProps,
             properties(ownerTeam) AS ownerTeamProps,
             properties(supportTeam) AS supportTeamProps
    `, { taskId: args.taskId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    const task = mapChangeTask(
      row.get('tProps') as Props,
      row.get('ciProps') as Props | null,
      row.get('teamProps') as Props | null,
      row.get('uProps') as Props | null,
    )
    const ownerTeamProps   = row.get('ownerTeamProps')   as Props | null
    const supportTeamProps = row.get('supportTeamProps') as Props | null
    if (task.ci) {
      const ci = task.ci as Record<string, unknown>
      ci['owner']        = ownerTeamProps   ? { id: ownerTeamProps['id'],   name: ownerTeamProps['name']   } : null
      ci['supportGroup'] = supportTeamProps ? { id: supportTeamProps['id'], name: supportTeamProps['name'] } : null
    }
    return task
  }, true)
}

// ── assignAssessmentTaskTeam ──────────────────────────────────────────────────

export async function assignAssessmentTaskTeam(
  _: unknown, args: { taskId: string; teamId: string }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[old:ASSIGNED_TO_TEAM]->()
      DELETE old
      WITH t
      MATCH (team:Team {id: $teamId, tenant_id: $tenantId})
      CREATE (t)-[:ASSIGNED_TO_TEAM]->(team)
    `, { taskId: args.taskId, teamId: args.teamId, tenantId: ctx.tenantId }))

    const r = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      RETURN properties(t) AS tProps, properties(team) AS teamProps,
             properties(ci) AS ciProps, properties(u) AS uProps
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('tProps') as Props,
      row.get('ciProps') as Props | null,
      row.get('teamProps') as Props | null,
      row.get('uProps') as Props | null,
    )
  }, true)
}

// ── assignAssessmentTaskUser ──────────────────────────────────────────────────

export async function assignAssessmentTaskUser(
  _: unknown, args: { taskId: string; userId: string }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[old:ASSIGNED_TO]->()
      DELETE old
      WITH t
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (t)-[:ASSIGNED_TO]->(u)
    `, { taskId: args.taskId, userId: args.userId, tenantId: ctx.tenantId }))

    const r = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      OPTIONAL MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
      OPTIONAL MATCH (ci)-[:SUPPORTED_BY]->(supportTeam:Team)
      RETURN properties(t) AS tProps, properties(team) AS teamProps,
             properties(u) AS uProps, properties(ci) AS ciProps,
             properties(ownerTeam) AS ownerTeamProps,
             properties(supportTeam) AS supportTeamProps
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    const task = mapChangeTask(
      row.get('tProps') as Props,
      row.get('ciProps') as Props | null,
      row.get('teamProps') as Props | null,
      row.get('uProps') as Props | null,
    )
    const ownerTeamProps   = row.get('ownerTeamProps')   as Props | null
    const supportTeamProps = row.get('supportTeamProps') as Props | null
    if (task.ci) {
      const ci = task.ci as Record<string, unknown>
      ci['owner']        = ownerTeamProps   ? { id: ownerTeamProps['id'],   name: ownerTeamProps['name']   } : null
      ci['supportGroup'] = supportTeamProps ? { id: supportTeamProps['id'], name: supportTeamProps['name'] } : null
    }
    return task
  }, true)
}

// ── assignDeployStepToTeam ────────────────────────────────────────────────────

export async function assignDeployStepToTeam(
  _: unknown, args: { stepId: string; teamId: string }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      OPTIONAL MATCH (s)-[old:ASSIGNED_TO_TEAM]->() DELETE old
      WITH s MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      CREATE (s)-[:ASSIGNED_TO_TEAM]->(t)
      RETURN properties(s) AS props, properties(t) AS teamProps
    `, { stepId: args.stepId, teamId: args.teamId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(row.get('props') as Props, null, row.get('teamProps') as Props)
  }, true)
}

// ── assignDeployStepToUser ────────────────────────────────────────────────────

export async function assignDeployStepToUser(
  _: unknown, args: { stepId: string; userId: string }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      OPTIONAL MATCH (s)-[old:ASSIGNED_TO]->() DELETE old
      WITH s MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (s)-[:ASSIGNED_TO]->(u)
      RETURN properties(s) AS props, properties(u) AS uProps
    `, { stepId: args.stepId, userId: args.userId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(row.get('props') as Props, null, row.get('uProps') as Props)
  }, true)
}

// ── assignDeployStepValidationTeam ────────────────────────────────────────────

export async function assignDeployStepValidationTeam(
  _: unknown, args: { stepId: string; teamId: string }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      OPTIONAL MATCH (s)-[old:VALIDATION_ASSIGNED_TO_TEAM]->() DELETE old
      WITH s MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      CREATE (s)-[:VALIDATION_ASSIGNED_TO_TEAM]->(t)
      OPTIONAL MATCH (s)-[:ASSIGNED_TO_TEAM]->(at:Team)
      OPTIONAL MATCH (s)-[:ASSIGNED_TO]->(au:User)
      OPTIONAL MATCH (s)-[:VALIDATION_ASSIGNED_TO]->(vu:User)
      RETURN properties(s) AS props, properties(at) AS tProps, properties(au) AS uProps,
             properties(t) AS vtProps, properties(vu) AS vuProps
    `, { stepId: args.stepId, teamId: args.teamId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('props') as Props,
      row.get('tProps') as Props | null,
      row.get('uProps') as Props | null,
      row.get('vtProps') as Props | null,
      row.get('vuProps') as Props | null,
    )
  }, true)
}

// ── assignDeployStepValidationUser ────────────────────────────────────────────

export async function assignDeployStepValidationUser(
  _: unknown, args: { stepId: string; userId: string }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      OPTIONAL MATCH (s)-[old:VALIDATION_ASSIGNED_TO]->() DELETE old
      WITH s MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (s)-[:VALIDATION_ASSIGNED_TO]->(u)
      OPTIONAL MATCH (s)-[:ASSIGNED_TO_TEAM]->(at:Team)
      OPTIONAL MATCH (s)-[:ASSIGNED_TO]->(au:User)
      OPTIONAL MATCH (s)-[:VALIDATION_ASSIGNED_TO_TEAM]->(vt:Team)
      RETURN properties(s) AS props, properties(at) AS tProps, properties(au) AS uProps,
             properties(vt) AS vtProps, properties(u) AS vuProps
    `, { stepId: args.stepId, userId: args.userId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('props') as Props,
      row.get('tProps') as Props | null,
      row.get('uProps') as Props | null,
      row.get('vtProps') as Props | null,
      row.get('vuProps') as Props | null,
    )
  }, true)
}

// ── updateDeployStepStatus ────────────────────────────────────────────────────

export async function updateDeployStepStatus(
  _: unknown,
  args: { stepId: string; status: string; notes?: string; skipReason?: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    if (['in_progress', 'completed'].includes(args.status)) {
      const teamCheck = await session.executeRead((tx) => tx.run(`
        MATCH (s:ChangeTask {id: $stepId})
        OPTIONAL MATCH (s)-[:ASSIGNED_TO_TEAM]->(team:Team)
        RETURN team
      `, { stepId: args.stepId }))
      if (!teamCheck.records[0]?.get('team'))
        throw new GraphQLError('Assegna un team allo step prima di procedere')
    }

    await session.executeWrite((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      SET s.status       = $status,
          s.notes        = coalesce($notes, s.notes),
          s.skip_reason  = coalesce($skipReason, s.skip_reason),
          s.completed_at = CASE WHEN $status IN ['completed','failed','skipped'] THEN $now ELSE s.completed_at END,
          s.updated_at   = $now
    `, { stepId: args.stepId, tenantId: ctx.tenantId, status: args.status, notes: args.notes ?? null, skipReason: args.skipReason ?? null, now }))

    const r = await session.executeRead((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      OPTIONAL MATCH (s)-[:ASSIGNED_TO_TEAM]->(t:Team)
      OPTIONAL MATCH (s)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (s)-[:VALIDATION_ASSIGNED_TO_TEAM]->(vt:Team)
      OPTIONAL MATCH (s)-[:VALIDATION_ASSIGNED_TO]->(vu:User)
      RETURN properties(s) AS props, properties(t) AS tProps, properties(u) AS uProps,
             properties(vt) AS vtProps, properties(vu) AS vuProps
    `, { stepId: args.stepId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    const stepProps = row.get('props') as Props
    if (args.status === 'skipped') {
      const changeId = stepProps['change_id'] as string
      const order    = stepProps['order'] as number
      await createChangeComment(
        session, ctx.tenantId, changeId,
        `Deploy step ${order} saltato: ${args.skipReason ?? '—'}`,
        'step_skipped', ctx.userId,
      )
    }
    return mapChangeTask(
      stepProps,
      row.get('tProps') as Props | null,
      row.get('uProps') as Props | null,
      row.get('vtProps') as Props | null,
      row.get('vuProps') as Props | null,
    )
  }, true)
}

// ── updateDeployStepValidation ────────────────────────────────────────────────

export async function updateDeployStepValidation(
  _: unknown,
  args: { stepId: string; status: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const teamCheck = await session.executeRead((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId})
      OPTIONAL MATCH (s)-[:VALIDATION_ASSIGNED_TO_TEAM]->(team:Team)
      RETURN team
    `, { stepId: args.stepId }))
    if (!teamCheck.records[0]?.get('team'))
      throw new GraphQLError('Assegna un team di validazione prima di procedere')

    const stepResult = await session.executeRead((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      RETURN s.change_id AS changeId, s.order AS order, s.title AS title
    `, { stepId: args.stepId, tenantId: ctx.tenantId }))
    if (!stepResult.records.length) throw new GraphQLError('Deploy step non trovato')
    const changeId = stepResult.records[0].get('changeId') as string
    const order    = stepResult.records[0].get('order')    as number
    const title    = stepResult.records[0].get('title')    as string

    await session.executeWrite((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      SET s.validation_status = $status,
          s.validation_notes  = $notes,
          s.updated_at        = $now
    `, { stepId: args.stepId, tenantId: ctx.tenantId, status: args.status, notes: args.notes ?? null, now: new Date().toISOString() }))

    const label = args.status === 'passed' ? 'superata' : 'fallita'
    await createChangeComment(
      session, ctx.tenantId, changeId,
      `Validazione Step ${order} "${title}" ${label}${args.notes ? ': ' + args.notes : ''}`,
      'transition', ctx.userId,
    )

    const r = await session.executeRead((tx) => tx.run(`
      MATCH (s:ChangeTask {id: $stepId, tenant_id: $tenantId})
      OPTIONAL MATCH (s)-[:ASSIGNED_TO_TEAM]->(t:Team)
      OPTIONAL MATCH (s)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (s)-[:VALIDATION_ASSIGNED_TO_TEAM]->(vt:Team)
      OPTIONAL MATCH (s)-[:VALIDATION_ASSIGNED_TO]->(vu:User)
      RETURN properties(s) AS props, properties(t) AS tProps, properties(u) AS uProps,
             properties(vt) AS vtProps, properties(vu) AS vuProps
    `, { stepId: args.stepId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('props') as Props,
      row.get('tProps') as Props | null,
      row.get('uProps') as Props | null,
      row.get('vtProps') as Props | null,
      row.get('vuProps') as Props | null,
    )
  }, true)
}

// ── updateChangeTask ──────────────────────────────────────────────────────────

export async function updateChangeTask(
  _: unknown, args: { id: string; input: { rollbackPlan?: string | null } }, ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $id, tenant_id: $tenantId})
      SET t.rollback_plan = $rollbackPlan, t.updated_at = $now
    `, {
      id: args.id,
      tenantId: ctx.tenantId,
      rollbackPlan: args.input.rollbackPlan ?? null,
      now: new Date().toISOString(),
    }))

    const r = await session.executeRead((tx) => tx.run(`
      MATCH (t:ChangeTask {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      RETURN properties(t) AS props, properties(team) AS teamProps,
             properties(u) AS uProps, properties(ci) AS ciProps
    `, { id: args.id, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('props') as Props,
      row.get('ciProps') as Props | null,
      row.get('teamProps') as Props | null,
      row.get('uProps') as Props | null,
    )
  }, true)
}

// ── completeChangeValidation ──────────────────────────────────────────────────

export async function completeChangeValidation(
  _: unknown, args: { changeId: string; notes?: string }, ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(v:ChangeTask)
      WHERE v.task_type = 'validation'
      SET v.status       = 'passed',
          v.notes        = coalesce($notes, v.notes),
          v.completed_at = $now,
          v.updated_at   = $now
    `, { changeId: args.changeId, tenantId: ctx.tenantId, notes: args.notes ?? null, now }))
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(v:ChangeTask)
      WHERE v.task_type = 'validation'
      OPTIONAL MATCH (v)-[:ASSIGNED_TO_TEAM]->(t:Team)
      OPTIONAL MATCH (v)-[:ASSIGNED_TO]->(u:User)
      RETURN properties(v) AS vProps, properties(t) AS tProps, properties(u) AS uProps
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('vProps') as Props,
      null,
      row.get('tProps') as Props | null,
      row.get('uProps') as Props | null,
    )
  }, true)
}

// ── failChangeValidation ──────────────────────────────────────────────────────

export async function failChangeValidation(
  _: unknown, args: { changeId: string }, ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(v:ChangeTask)
      WHERE v.task_type = 'validation'
      SET v.status       = 'failed',
          v.completed_at = $now,
          v.updated_at   = $now
    `, { changeId: args.changeId, tenantId: ctx.tenantId, now }))
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(v:ChangeTask)
      WHERE v.task_type = 'validation'
      OPTIONAL MATCH (v)-[:ASSIGNED_TO_TEAM]->(t:Team)
      OPTIONAL MATCH (v)-[:ASSIGNED_TO]->(u:User)
      RETURN properties(v) AS vProps, properties(t) AS tProps, properties(u) AS uProps
    `, { changeId: args.changeId, tenantId: ctx.tenantId }))
    const row = r.records[0]
    if (!row) throw new GraphQLError('ChangeTask not found')
    return mapChangeTask(
      row.get('vProps') as Props,
      null,
      row.get('tProps') as Props | null,
      row.get('uProps') as Props | null,
    )
  }, true)
}
