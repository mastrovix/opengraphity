import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { mapCI, labelToType } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

function mapProblem(props: Props) {
  return {
    id:            props['id']            as string,
    title:         props['title']         as string,
    description:   (props['description']  ?? null) as string | null,
    priority:      (props['priority']     ?? 'medium') as string,
    status:        props['status']        as string,
    rootCause:     (props['root_cause']   ?? null) as string | null,
    workaround:    (props['workaround']   ?? null) as string | null,
    affectedUsers: (props['affected_users'] ?? null) as number | null,
    createdAt:     props['created_at']    as string,
    updatedAt:     (props['updated_at']   ?? null) as string | null,
    resolvedAt:    (props['resolved_at']  ?? null) as string | null,
    closedAt:      (props['closed_at']    ?? null) as string | null,
    createdBy:     null,
    assignee:      null,
    assignedTeam:  null,
    affectedCIs:   [],
    relatedIncidents: [],
    relatedChanges:   [],
    workflowInstance:     null,
    availableTransitions: [],
    workflowHistory:      [],
    comments:             [],
  }
}

function mapProblemComment(props: Props, authorProps: Props | null) {
  return {
    id:        props['id']         as string,
    text:      props['text']       as string,
    type:      (props['type']      ?? 'manual') as string,
    createdAt: props['created_at'] as string,
    updatedAt: (props['updated_at'] ?? null) as string | null,
    author:    authorProps ? {
      id:       authorProps['id']        as string,
      tenantId: authorProps['tenant_id'] as string,
      email:    authorProps['email']     as string,
      name:     authorProps['name']      as string,
      role:     authorProps['role']      as string,
    } : null,
  }
}

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function problems(
  _: unknown,
  args: { limit?: number; offset?: number; status?: string; priority?: string; search?: string },
  ctx: GraphQLContext,
) {
  const { limit = 50, offset = 0, status, priority, search } = args

  return withSession(async (session) => {
    const params = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      priority: priority ?? null,
      search:   search   ? `(?i).*${search}.*` : null,
      offset,
      limit,
    }
    const whereClause = `
      WHERE ($status   IS NULL OR p.status   = $status)
        AND ($priority IS NULL OR p.priority = $priority)
        AND ($search   IS NULL OR p.title =~ $search)
    `
    const itemRows = await runQuery<{ props: Props }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId})
      ${whereClause}
      WITH p ORDER BY p.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(p) as props
    `, params)
    const countRows = await runQuery<{ total: unknown }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(p) AS total
    `, params)
    return {
      items: itemRows.map((r) => mapProblem(r.props)),
      total: (countRows[0]?.total as { toNumber(): number } | undefined)?.toNumber?.() ?? Number(countRows[0]?.total ?? 0),
    }
  })
}

async function problem(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      RETURN properties(p) as props
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapProblem(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createProblem(
  _: unknown,
  args: { input: { title: string; description?: string; priority: string; affectedCIs?: string[]; relatedIncidents?: string[]; workaround?: string } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (p:Problem {
        id:          $id,
        tenant_id:   $tenantId,
        title:       $title,
        description: $description,
        priority:    $priority,
        status:      'new',
        workaround:  $workaround,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(p) as props
    `, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title,
      description: input.description ?? null,
      priority:    input.priority,
      workaround:  input.workaround ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Failed to create problem')
    return mapProblem(row.props)
  }, true)

  if (input.affectedCIs?.length) {
    await withSession(async (session) => {
      for (const ciId of input.affectedCIs!) {
        await runQuery(session, `
          MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
          MERGE (p)-[:AFFECTS]->(ci)
        `, { id, tenantId: ctx.tenantId, ciId })
      }
    }, true)
  }

  if (input.relatedIncidents?.length) {
    await withSession(async (session) => {
      for (const incidentId of input.relatedIncidents!) {
        await runQuery(session, `
          MATCH (p:Problem {id: $id, tenant_id: $tenantId})
          MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
          MERGE (p)-[:CAUSED_BY]->(i)
        `, { id, tenantId: ctx.tenantId, incidentId })
      }
    }, true)
  }

  await withSession(async (session) => {
    await workflowEngine.createInstance(session, ctx.tenantId, id, 'problem')
  }, true)

  return created
}

async function updateProblem(
  _: unknown,
  args: { id: string; input: { title?: string; description?: string; priority?: string; rootCause?: string; workaround?: string; affectedUsers?: number } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      SET p += {
        title:          coalesce($title,        p.title),
        description:    coalesce($description,  p.description),
        priority:       coalesce($priority,     p.priority),
        root_cause:     coalesce($rootCause,    p.root_cause),
        workaround:     coalesce($workaround,   p.workaround),
        affected_users: coalesce($affectedUsers, p.affected_users),
        updated_at:     $now
      }
      RETURN properties(p) as props
    `, {
      id,
      tenantId:      ctx.tenantId,
      title:         input.title         ?? null,
      description:   input.description   ?? null,
      priority:      input.priority      ?? null,
      rootCause:     input.rootCause     ?? null,
      workaround:    input.workaround    ?? null,
      affectedUsers: input.affectedUsers ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function deleteProblem(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      DETACH DELETE p
    `, { id: args.id, tenantId: ctx.tenantId }))
    return true
  }, true)
}

async function linkIncidentToProblem(
  _: unknown,
  args: { problemId: string; incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      MERGE (p)-[:CAUSED_BY]->(i)
      SET p.updated_at = $now
    `, { problemId: args.problemId, incidentId: args.incidentId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function unlinkIncidentFromProblem(
  _: unknown,
  args: { problemId: string; incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[r:CAUSED_BY]->(i:Incident {id: $incidentId})
      DELETE r
      SET p.updated_at = $now
    `, { problemId: args.problemId, incidentId: args.incidentId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function linkChangeToProblem(
  _: unknown,
  args: { problemId: string; changeId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      MERGE (p)-[:RESOLVED_BY]->(c)
      SET p.updated_at = $now
    `, { problemId: args.problemId, changeId: args.changeId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function addCIToProblem(
  _: unknown,
  args: { problemId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
      MERGE (p)-[:AFFECTS]->(ci)
      SET p.updated_at = $now
    `, { problemId: args.problemId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function removeCIFromProblem(
  _: unknown,
  args: { problemId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[r:AFFECTS]->(ci {id: $ciId})
      DELETE r
      SET p.updated_at = $now
    `, { problemId: args.problemId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function assignProblemToTeam(
  _: unknown,
  args: { problemId: string; teamId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      OPTIONAL MATCH (p)-[old:ASSIGNED_TO_TEAM]->()
      DELETE old
      WITH p
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      CREATE (p)-[:ASSIGNED_TO_TEAM]->(t)
      SET p.updated_at = $now
    `, { problemId: args.problemId, teamId: args.teamId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function assignProblemToUser(
  _: unknown,
  args: { problemId: string; userId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      OPTIONAL MATCH (p)-[old:ASSIGNED_TO]->()
      DELETE old
      WITH p
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (p)-[:ASSIGNED_TO]->(u)
      SET p.updated_at = $now
    `, { problemId: args.problemId, userId: args.userId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function executeProblemTransition(
  _: unknown,
  args: { problemId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { problemId: args.problemId, tenantId: ctx.tenantId }))
    if (!wiResult.records.length) throw new GraphQLError('Workflow instance not found for this problem')
    const instanceId = wiResult.records[0]!.get('instanceId') as string

    await workflowEngine.transition(
      session,
      { instanceId, toStepName: args.toStep, triggeredBy: ctx.userId, triggerType: 'manual', notes: args.notes ?? undefined },
      { userId: ctx.userId },
    )

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblem(row.props)
  }, true)
}

async function addProblemComment(
  _: unknown,
  args: { problemId: string; text: string },
  ctx: GraphQLContext,
) {
  const commentId = uuidv4()
  const now       = new Date().toISOString()

  return withSession(async (session) => {
    const rows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, `
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      CREATE (c:ProblemComment {
        id:         $commentId,
        tenant_id:  $tenantId,
        text:       $text,
        type:       'manual',
        created_by: $userId,
        created_at: $now,
        updated_at: $now
      })
      CREATE (p)-[:HAS_COMMENT]->(c)
      WITH c
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      RETURN properties(c) AS cProps, properties(u) AS uProps
    `, { problemId: args.problemId, tenantId: ctx.tenantId, commentId, text: args.text, userId: ctx.userId, now })
    const row = rows[0]
    if (!row) throw new GraphQLError('Problem not found')
    return mapProblemComment(row.cProps, row.uProps)
  }, true)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function problemAffectedCIs(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:AFFECTS]->(ci)
      WHERE ci.tenant_id = $tenantId
      RETURN properties(ci) as props, labels(ci)[0] AS label
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      r.props['type'] = labelToType(r.label)
      return mapCI(r.props)
    })
  })
}

async function problemRelatedIncidents(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:CAUSED_BY]->(i:Incident)
      RETURN properties(i) as props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => ({
      id:              r.props['id']          as string,
      tenantId:        r.props['tenant_id']   as string,
      title:           r.props['title']       as string,
      description:     (r.props['description'] ?? null) as string | null,
      severity:        r.props['severity']    as string,
      status:          r.props['status']      as string,
      createdAt:       r.props['created_at']  as string,
      updatedAt:       r.props['updated_at']  as string,
      resolvedAt:      (r.props['resolved_at'] ?? null) as string | null,
      rootCause:       (r.props['root_cause'] ?? null) as string | null,
      assignee:        null,
      assignedTeam:    null,
      affectedCIs:     [],
      causedByProblem: null,
      comments:        [],
    }))
  })
}

async function problemRelatedChanges(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:RESOLVED_BY]->(c:Change)
      RETURN properties(c) as props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => ({
      id:             r.props['id']              as string,
      tenantId:       r.props['tenant_id']       as string,
      title:          r.props['title']           as string,
      type:           r.props['type']            as string,
      status:         r.props['status']          as string,
      priority:       (r.props['priority']       ?? 'medium') as string,
      rollbackPlan:   (r.props['rollback_plan']  ?? '') as string,
      scheduledStart: (r.props['scheduled_start'] ?? null) as string | null,
      scheduledEnd:   (r.props['scheduled_end']   ?? null) as string | null,
      implementedAt:  (r.props['implemented_at']  ?? null) as string | null,
      description:    (r.props['description']    ?? null) as string | null,
      createdAt:      r.props['created_at']       as string,
      updatedAt:      r.props['updated_at']       as string,
      assignedTeam:    null, assignee: null,
      affectedCIs:     [], relatedIncidents: [],
      changeTasks:     [], createdBy: null, comments: [],
    }))
  })
}

async function problemWorkflowInstance(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const wi = result.records[0]!.get('wi').properties as Props
    return {
      id:          wi['id']           as string,
      currentStep: wi['current_step'] as string,
      status:      wi['status']       as string,
      createdAt:   wi['created_at']   as string,
      updatedAt:   wi['updated_at']   as string,
    }
  })
}

async function problemAvailableTransitions(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0]!.get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}

async function problemWorkflowHistory(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (wi)-[:STEP_HISTORY]->(e:WorkflowStepExecution)
      RETURN e
      ORDER BY e.entered_at ASC
    `, { id: parent.id, tenantId: ctx.tenantId }))
    return result.records.map((rec) => {
      const e = rec.get('e').properties as Props
      return {
        id:          e['id']           as string,
        stepName:    e['step_name']    as string,
        enteredAt:   e['entered_at']   as string,
        exitedAt:    (e['exited_at']   ?? null) as string | null,
        durationMs:  (e['duration_ms'] ?? null) as number | null,
        triggeredBy: e['triggered_by'] as string,
        triggerType: e['trigger_type'] as string,
        notes:       (e['notes']       ?? null) as string | null,
      }
    })
  })
}

async function problemComments(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:ProblemComment)
      OPTIONAL MATCH (u:User {id: c.created_by})
      RETURN properties(c) AS cProps, properties(u) AS uProps
      ORDER BY c.created_at ASC
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => mapProblemComment(r.cProps, r.uProps))
  })
}

async function problemAssignee(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User)
      RETURN properties(u) as props
    `, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) return null
    return {
      id:       row.props['id']        as string,
      tenantId: row.props['tenant_id'] as string,
      email:    row.props['email']     as string,
      name:     row.props['name']      as string,
      role:     row.props['role']      as string,
    }
  })
}

async function problemAssignedTeam(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN t
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const t = result.records[0]!.get('t').properties as Props
    return {
      id:          t['id']          as string,
      tenantId:    t['tenant_id']   as string,
      name:        t['name']        as string,
      description: (t['description'] ?? null) as string | null,
      createdAt:   t['created_at']  as string,
    }
  })
}

async function problemCreatedBy(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:CREATED_BY]->(u:User)
      RETURN properties(u) as props
    `, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) return null
    return {
      id:       row.props['id']        as string,
      tenantId: row.props['tenant_id'] as string,
      email:    row.props['email']     as string,
      name:     row.props['name']      as string,
      role:     row.props['role']      as string,
    }
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const problemResolvers = {
  Query: { problems, problem },
  Mutation: {
    createProblem,
    updateProblem,
    deleteProblem,
    linkIncidentToProblem,
    unlinkIncidentFromProblem,
    linkChangeToProblem,
    addCIToProblem,
    removeCIFromProblem,
    assignProblemToTeam,
    assignProblemToUser,
    executeProblemTransition,
    addProblemComment,
  },
  Problem: {
    affectedCIs:          problemAffectedCIs,
    relatedIncidents:     problemRelatedIncidents,
    relatedChanges:       problemRelatedChanges,
    workflowInstance:     problemWorkflowInstance,
    availableTransitions: problemAvailableTransitions,
    workflowHistory:      problemWorkflowHistory,
    comments:             problemComments,
    assignee:             problemAssignee,
    assignedTeam:         problemAssignedTeam,
    createdBy:            problemCreatedBy,
  },
}
