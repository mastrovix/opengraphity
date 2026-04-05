import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { withSession } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, mapChangeTask, type Props } from './mappers.js'
import { createChangeComment } from './changeTasks.js'

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
