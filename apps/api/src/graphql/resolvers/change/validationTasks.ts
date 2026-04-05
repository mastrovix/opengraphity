import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { withSession } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, mapChangeTask, type Props } from './mappers.js'

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
