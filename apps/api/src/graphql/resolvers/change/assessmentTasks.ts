import { GraphQLError } from 'graphql'
import { withSession } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChangeTask, type Props } from './mappers.js'
import { audit } from '../../../lib/audit.js'
import { createChangeComment, toInt } from './changeTasks.js'

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
