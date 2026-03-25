import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { withSession, mapCI, ciTypeFromLabels } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChangeTask, mapWI, mapExec, mapChangeComment, mapUser, mapTeam, type Props } from './mappers.js'
import { changeImpactAnalysisField } from './impact.js'

export async function changeAssignedTeam(parent: { id: string; assignedTeam?: unknown; _prefetched?: boolean }, _: unknown, ctx: GraphQLContext) {
  if (parent._prefetched) return parent.assignedTeam ?? null
  return withSession(async (session) => {
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN properties(t) AS props
    `, { id: parent.id, tenantId: ctx.tenantId }))
    return r.records.length ? mapTeam(r.records[0].get('props') as Props) : null
  })
}

export async function changeAssignee(parent: { id: string; assignee?: unknown; _prefetched?: boolean }, _: unknown, ctx: GraphQLContext) {
  if (parent._prefetched) return parent.assignee ?? null
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User)
      RETURN properties(u) AS props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapUser(row.props) : null
  })
}

export async function changeAffectedCIs(parent: { id: string; affectedCIs?: unknown[]; _prefetched?: boolean }, _: unknown, ctx: GraphQLContext) {
  if (parent._prefetched) return parent.affectedCIs ?? []
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:AFFECTS]->(ci)
      WHERE ci.tenant_id = $tenantId
      RETURN properties(ci) AS props, labels(ci)[0] AS label
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      const t = ciTypeFromLabels([r.label])
      r.props['type']  = t
      const ci = mapCI(r.props) as Record<string, unknown>
      ci['ciType']     = t
      ci['__typename'] = r.label || 'Application'
      return ci
    })
  })
}

export async function changeRelatedIncidents(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:RELATED_TO]->(i:Incident)
      RETURN properties(i) AS props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => ({
      id: r.props['id'], tenantId: r.props['tenant_id'], title: r.props['title'],
      description: r.props['description'], severity: r.props['severity'],
      status: r.props['status'], createdAt: r.props['created_at'], updatedAt: r.props['updated_at'],
      resolvedAt: r.props['resolved_at'] ?? null, rootCause: r.props['root_cause'] ?? null,
      assignee: null, assignedTeam: null, affectedCIs: [], causedByProblem: null, comments: [],
    }))
  })
}

export async function changeChangeTasks(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(t:ChangeTask)
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (t)-[:VALIDATION_ASSIGNED_TO_TEAM]->(vt:Team)
      OPTIONAL MATCH (t)-[:VALIDATION_ASSIGNED_TO]->(vu:User)
      OPTIONAL MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
      OPTIONAL MATCH (ci)-[:SUPPORTED_BY]->(supportTeam:Team)
      RETURN properties(t) AS tProps, properties(ci) AS ciProps,
             properties(team) AS teamProps, properties(u) AS uProps,
             properties(vt) AS vtProps, properties(vu) AS vuProps,
             properties(ownerTeam) AS ownerTeamProps, properties(supportTeam) AS supportTeamProps
      ORDER BY t.task_type ASC, t.order ASC
    `, { id: parent.id, tenantId: ctx.tenantId }))
    return r.records.map((rec) => {
      const task = mapChangeTask(
        rec.get('tProps') as Props,
        rec.get('ciProps') as Props | null,
        rec.get('teamProps') as Props | null,
        rec.get('uProps') as Props | null,
        rec.get('vtProps') as Props | null,
        rec.get('vuProps') as Props | null,
      )
      if (task.ci) {
        const ci = task.ci as Record<string, unknown>
        const ownerTeamProps   = rec.get('ownerTeamProps')   as Props | null
        const supportTeamProps = rec.get('supportTeamProps') as Props | null
        ci['ownerGroup']   = ownerTeamProps   ? { id: ownerTeamProps['id'],   name: ownerTeamProps['name']   } : null
        ci['supportGroup'] = supportTeamProps ? { id: supportTeamProps['id'], name: supportTeamProps['name'] } : null
      }
      return task
    })
  })
}

export async function changeWorkflowInstance(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!r.records.length) return null
    return mapWI(r.records[0].get('wi').properties as Record<string, unknown>)
  })
}

export async function changeAvailableTransitions(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const wiRes = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!wiRes.records.length) return []
    const instanceId = wiRes.records[0].get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}

export async function changeWorkflowHistory(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
            -[:HAS_WORKFLOW]->(wi:WorkflowInstance)
            -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
      RETURN exec ORDER BY exec.entered_at ASC
    `, { id: parent.id, tenantId: ctx.tenantId }))
    return r.records.map((rec) => mapExec(rec.get('exec').properties as Record<string, unknown>))
  })
}

export async function changeCreatedBy(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:CREATED_BY]->(u:User)
      RETURN properties(u) AS props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapUser(row.props) : null
  })
}

export async function changeComments(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(cm:ChangeComment)
      OPTIONAL MATCH (u:User {id: cm.created_by, tenant_id: $tenantId})
      RETURN properties(cm) AS cmProps, properties(u) AS uProps
      ORDER BY cm.created_at ASC
    `, { id: parent.id, tenantId: ctx.tenantId }))
    return r.records.map((rec) =>
      mapChangeComment(rec.get('cmProps') as Props, rec.get('uProps') as Props | null),
    )
  })
}

export async function changeTaskCI(parent: { ciId?: string | null }, _: unknown, ctx: GraphQLContext) {
  if (!parent.ciId) return null
  return withSession(async (session) => {
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      RETURN properties(ci) AS props, labels(ci) AS labels
    `, { ciId: parent.ciId, tenantId: ctx.tenantId }))
    if (!r.records.length) return null
    const props      = r.records[0].get('props') as Props
    const labels     = r.records[0].get('labels') as string[]
    const ciType     = ciTypeFromLabels(labels)
    const gqlTypename = labels.find(l => !['ConfigurationItem', 'CIBase', '_BaseNode'].includes(l)) ?? 'Application'
    return {
      id:          props['id'],
      name:        props['name'] ?? '',
      type:        ciType,
      ciType:      ciType,
      status:      props['status']      ?? null,
      environment: props['environment'] ?? null,
      description: props['description'] ?? null,
      createdAt:   props['created_at']  ?? null,
      updatedAt:   props['updated_at']  ?? null,
      notes:       props['notes']       ?? null,
      __typename:  gqlTypename,
    }
  })
}

export { changeImpactAnalysisField }
