import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import { workflowEngine } from '@opengraphity/workflow'
import { mapCI, labelToType } from './ci-utils.js'
import type { DomainEvent, IncidentCreatedPayload, IncidentResolvedPayload } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'

export interface IncidentEventPayload {
  id: string; title: string; severity: string; status: string
  ciName: string; assignedTo: string
  resolved_at?: string; affected_ci_ids?: string[]
}

type Session = ReturnType<typeof getSession>

async function loadIncidentData(session: Session, incidentId: string, tenantId: string): Promise<IncidentEventPayload | null> {
  const result = await session.executeRead((tx) =>
    tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
      OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
      RETURN i.id AS id, i.title AS title,
             i.severity AS severity, i.status AS status,
             collect(ci.name)[0] AS ciName,
             u.name AS assignedTo
    `, { incidentId, tenantId }),
  )
  if (!result.records.length) return null
  const r = result.records[0]
  return {
    id:         r.get('id')         as string,
    title:      r.get('title')      as string,
    severity:   r.get('severity')   as string,
    status:     r.get('status')     as string,
    ciName:     (r.get('ciName')    ?? '—') as string,
    assignedTo: (r.get('assignedTo') ?? '—') as string,
  }
}

// ── Mapper ───────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>

function mapIncident(props: Props) {
  return {
    id:              props['id']          as string,
    tenantId:        props['tenant_id']   as string,
    title:           props['title']       as string,
    description:     props['description'] as string | undefined,
    severity:        props['severity']    as string,
    status:          props['status']      as string,
    createdAt:       props['created_at']  as string,
    updatedAt:       props['updated_at']  as string,
    resolvedAt:      props['resolved_at'] as string | undefined,
    rootCause:       (props['root_cause'] ?? null) as string | null,
    // Populated by field resolvers
    assignee:        null,
    assignedTeam:    null,
    affectedCIs:     [],
    causedByProblem: null,
    comments:        [],
  }
}

function mapUser(props: Props) {
  return {
    id:       props['id']        as string,
    tenantId: props['tenant_id'] as string,
    email:    props['email']     as string,
    name:     props['name']      as string,
    role:     props['role']      as string,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function incidents(
  _: unknown,
  args: { status?: string; severity?: string; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  const { status, severity, limit = 50, offset = 0 } = args

  return withSession(async (session) => {
    const params = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      severity: severity ?? null,
      offset,
      limit,
    }
    const whereClause = `
      WHERE ($status   IS NULL OR i.status   = $status)
        AND ($severity IS NULL OR i.severity = $severity)
    `
    const itemRows = await runQuery<{ props: Props }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      ${whereClause}
      WITH i ORDER BY i.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(i) as props
    `, params)
    const countRows = await runQuery<{ total: number }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(i) AS total
    `, params)
    return {
      items: itemRows.map((r) => mapIncident(r.props)),
      total: (countRows[0]?.total as unknown as { toNumber(): number })?.toNumber?.() ?? Number(countRows[0]?.total ?? 0),
    }
  })
}

async function incident(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN properties(i) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: args.id,
      tenantId: ctx.tenantId,
    })
    return row ? mapIncident(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createIncident(
  _: unknown,
  args: { input: { title: string; description?: string; severity: string; affectedCIIds?: string[] } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const cypher = `
      CREATE (i:Incident {
        id:           $id,
        tenant_id:    $tenantId,
        title:        $title,
        description:  $description,
        severity:     $severity,
        status:       'open',
        created_at:   $now,
        updated_at:   $now
      })
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title,
      description: input.description ?? null,
      severity:    input.severity,
      now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Failed to create incident')
    return mapIncident(row.props)
  }, true)

  // Link affected CIs
  if (input.affectedCIIds?.length) {
    await withSession(async (session) => {
      for (const ciId of input.affectedCIIds!) {
        await runQuery(session, `
          MATCH (i:Incident {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
          MERGE (i)-[:AFFECTED_BY]->(ci)
        `, { id, tenantId: ctx.tenantId, ciId })
      }
    }, true)
  }

  // Inizializza istanza workflow
  await withSession(async (session) => {
    await workflowEngine.createInstance(session, ctx.tenantId, id, 'incident')
  }, true)

  // Publish domain event
  const createdPayload: IncidentEventPayload = {
    id, title: input.title, severity: input.severity, status: 'open',
    ciName: '—', assignedTo: '—',
    affected_ci_ids: input.affectedCIIds ?? [],
  }
  const event: DomainEvent<IncidentEventPayload> = {
    id: uuidv4(), type: 'incident.created',
    tenant_id: ctx.tenantId, timestamp: now,
    correlation_id: uuidv4(), actor_id: ctx.userId,
    payload: createdPayload,
  }
  await publish(event)

  return created
}

async function updateIncident(
  _: unknown,
  args: { id: string; input: { title?: string; description?: string; severity?: string; status?: string } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i += {
        title:       coalesce($title, i.title),
        description: coalesce($description, i.description),
        severity:    coalesce($severity, i.severity),
        status:      coalesce($status, i.status),
        updated_at:  $now
      }
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title       ?? null,
      description: input.description ?? null,
      severity:    input.severity    ?? null,
      status:      input.status      ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Incident not found')
    return mapIncident(row.props)
  }, true)
}

async function resolveIncident(
  _: unknown,
  args: { id: string; rootCause?: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const resolved = await withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i.status = 'resolved', i.resolved_at = $now, i.updated_at = $now
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: args.id,
      tenantId: ctx.tenantId,
      now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Incident not found')
    return mapIncident(row.props)
  }, true)

  const resolvedData = await withSession((s) => loadIncidentData(s, args.id, ctx.tenantId))
  const resolvedPayload: IncidentEventPayload = resolvedData ?? {
    id: args.id, title: `Incident ${args.id}`, severity: 'low', status: 'resolved',
    ciName: '—', assignedTo: '—', resolved_at: now,
  }
  resolvedPayload.resolved_at = now
  const event: DomainEvent<IncidentEventPayload> = {
    id: uuidv4(), type: 'incident.resolved',
    tenant_id: ctx.tenantId, timestamp: now,
    correlation_id: uuidv4(), actor_id: ctx.userId,
    payload: resolvedPayload,
  }
  await publish(event)

  return resolved
}

async function assignIncidentToTeam(
  _: unknown,
  args: { id: string; teamId: string },
  ctx: GraphQLContext,
) {
  if (!args.teamId || !args.teamId.trim()) throw new GraphQLError('teamId è obbligatorio')
  const now = new Date().toISOString()

  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (i)-[old:ASSIGNED_TO_TEAM]->()
      DELETE old
      WITH i
      MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
      CREATE (i)-[:ASSIGNED_TO_TEAM]->(t)
      SET i.updated_at = $now
    `, { id: args.id, teamId: args.teamId, tenantId: ctx.tenantId, now }))

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE wi.current_step = 'new'
      RETURN wi.id AS instanceId
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId = wiResult.records[0]!.get('instanceId') as string
      await workflowEngine.transition(
        session,
        { instanceId, toStepName: 'assigned', triggeredBy: ctx.userId, triggerType: 'automatic', notes: `Assegnato al team ${args.teamId}` },
        { userId: ctx.userId },
      )
    }

    const result = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.id, tenantId: ctx.tenantId },
    ))
    const row = result.records[0]
    if (!row) throw new GraphQLError('Incident not found')
    const assigned = mapIncident(row.get('props') as Props)
    const assignedData = await loadIncidentData(session, args.id, ctx.tenantId)
    const assignedPayload = assignedData ?? { id: args.id, title: assigned.title, severity: assigned.severity, status: assigned.status, ciName: '—', assignedTo: '—' }
    const assignedEvent: DomainEvent<IncidentEventPayload> = {
      id: uuidv4(), type: 'incident.assigned',
      tenant_id: ctx.tenantId, timestamp: now,
      correlation_id: uuidv4(), actor_id: ctx.userId,
      payload: assignedPayload,
    }
    await publish(assignedEvent)
    return assigned
  }, true)
}

async function assignIncidentToUser(
  _: unknown,
  args: { id: string; userId: string },
  ctx: GraphQLContext,
) {
  if (!args.userId || !args.userId.trim()) throw new GraphQLError('userId è obbligatorio')
  const now = new Date().toISOString()

  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (i)-[old:ASSIGNED_TO]->()
      DELETE old
      WITH i
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (i)-[:ASSIGNED_TO]->(u)
      SET i.updated_at = $now
    `, { id: args.id, userId: args.userId, tenantId: ctx.tenantId, now }))

    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE wi.current_step = 'assigned'
      RETURN wi.id AS instanceId
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (wiResult.records.length > 0) {
      const instanceId = wiResult.records[0]!.get('instanceId') as string
      await workflowEngine.transition(
        session,
        { instanceId, toStepName: 'in_progress', triggeredBy: ctx.userId, triggerType: 'automatic', notes: `Preso in carico da user ${args.userId}` },
        { userId: ctx.userId },
      )
    }

    const result = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.id, tenantId: ctx.tenantId },
    ))
    const row = result.records[0]
    if (!row) throw new GraphQLError('Incident not found')
    const assignedToUser = mapIncident(row.get('props') as Props)
    const assignedToUserData = await loadIncidentData(session, args.id, ctx.tenantId)
    const assignedToUserPayload = assignedToUserData ?? { id: args.id, title: assignedToUser.title, severity: assignedToUser.severity, status: assignedToUser.status, ciName: '—', assignedTo: '—' }
    const assignedToUserEvent: DomainEvent<IncidentEventPayload> = {
      id: uuidv4(), type: 'incident.assigned',
      tenant_id: ctx.tenantId, timestamp: now,
      correlation_id: uuidv4(), actor_id: ctx.userId,
      payload: assignedToUserPayload,
    }
    await publish(assignedToUserEvent)
    return assignedToUser
  }, true)
}

async function addAffectedCI(
  _: unknown,
  args: { incidentId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
      MERGE (i)-[:AFFECTED_BY]->(ci)
      SET i.updated_at = $now
    `, { incidentId: args.incidentId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.incidentId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new GraphQLError('Incident not found')
    return mapIncident(row.get('props') as Props)
  }, true)
}

async function removeAffectedCI(
  _: unknown,
  args: { incidentId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
            -[r:AFFECTED_BY]->(ci {id: $ciId, tenant_id: $tenantId})
      DELETE r
      SET i.updated_at = $now
    `, { incidentId: args.incidentId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.incidentId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new GraphQLError('Incident not found')
    return mapIncident(row.get('props') as Props)
  }, true)
}

async function addIncidentComment(
  _: unknown,
  args: { id: string; text: string },
  ctx: GraphQLContext,
) {
  const commentId = uuidv4()
  const now       = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (c:Comment {
        id:         $commentId,
        tenant_id:  $tenantId,
        text:       $text,
        author_id:  $userId,
        created_at: $now,
        updated_at: $now
      })
      CREATE (i)-[:HAS_COMMENT]->(c)
      RETURN properties(c) AS cProps, properties(u) AS uProps
    `
    const rows = await runQuery<{ cProps: Props; uProps: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, commentId, text: args.text, now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Incident not found')
    return {
      id:        row.cProps['id']         as string,
      text:      row.cProps['text']       as string,
      createdAt: row.cProps['created_at'] as string,
      updatedAt: row.cProps['updated_at'] as string,
      author:    mapUser(row.uProps),
    }
  }, true)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function incidentAssignedTeam(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN t
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const t = result.records[0]!.get('t').properties as Record<string, unknown>
    return {
      id:          t['id']          as string,
      tenantId:    t['tenant_id']   as string,
      name:        t['name']        as string,
      description: (t['description'] ?? null) as string | null,
      createdAt:   t['created_at']  as string,
    }
  })
}

async function incidentAssignee(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User)
      RETURN properties(u) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return row ? mapUser(row.props) : null
  })
}

async function incidentAffectedCIs(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
      WHERE ci.tenant_id = $tenantId
      RETURN properties(ci) as props, labels(ci)[0] AS label
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => {
      r.props['type'] = labelToType(r.label)
      return mapCI(r.props)
    })
  })
}

async function incidentComments(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
      OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
      RETURN properties(c) AS cProps, properties(u) AS uProps
      ORDER BY c.created_at ASC
    `
    const rows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => ({
      id:        r.cProps['id']         as string,
      text:      r.cProps['text']       as string,
      createdAt: r.cProps['created_at'] as string,
      updatedAt: r.cProps['updated_at'] as string,
      author:    r.uProps ? mapUser(r.uProps) : null,
    }))
  })
}

async function incidentCausedByProblem(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:CAUSED_BY]->(p:Problem)
      RETURN properties(p) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    if (!row) return null
    const p = row.props
    return {
      id: p['id'], tenantId: p['tenant_id'], title: p['title'],
      description: p['description'], status: p['status'], impact: p['impact'],
      rootCause: p['root_cause'], workaround: p['workaround'],
      createdAt: p['created_at'], updatedAt: p['updated_at'], resolvedAt: p['resolved_at'],
      relatedIncidents: [], resolvedByChange: null,
    }
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const incidentResolvers = {
  Query: { incidents, incident },
  Mutation: { createIncident, updateIncident, resolveIncident, assignIncidentToTeam, assignIncidentToUser, addIncidentComment, addAffectedCI, removeAffectedCI },
  Incident: {
    assignee:        incidentAssignee,
    assignedTeam:    incidentAssignedTeam,
    affectedCIs:     incidentAffectedCIs,
    causedByProblem: incidentCausedByProblem,
    comments:        incidentComments,
  },
}
