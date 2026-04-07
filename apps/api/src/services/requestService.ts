import { v4 as uuidv4 } from 'uuid'
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'
import { publishEvent } from '../lib/publishEvent.js'

type Props = Record<string, unknown>

function mapRequest(props: Props) {
  return {
    id:          props['id']           as string,
    tenantId:    props['tenant_id']    as string,
    title:       props['title']        as string,
    description: props['description']  as string | undefined,
    status:      props['status']       as string,
    priority:    props['priority']     as string,
    dueDate:     props['due_date']     as string | undefined,
    completedAt: props['completed_at'] as string | undefined,
    createdAt:   props['created_at']   as string,
    updatedAt:   props['updated_at']   as string,
    requestedBy: null,
    assignee:    null,
  }
}

export async function createRequest(
  input: { title: string; description?: string; priority: string; dueDate?: string },
  ctx: ServiceCtx,
) {
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (r:ServiceRequest {
        id:          $id,
        tenant_id:   $tenantId,
        title:       $title,
        description: $description,
        status:      'open',
        priority:    $priority,
        due_date:    $dueDate,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(r) as props
    `, {
      id, tenantId: ctx.tenantId,
      title: input.title, description: input.description ?? null,
      priority: input.priority, dueDate: input.dueDate ?? null, now,
    })
    if (!rows[0]) throw new Error('Failed to create service request')

    await runQuery(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NOT NULL THEN [1] ELSE [] END |
        MERGE (r)-[:REQUESTED_BY]->(u)
      )
    `, { id, tenantId: ctx.tenantId, userId: ctx.userId })

    return mapRequest(rows[0].props)
  }, true)

  await publishEvent('request.created', ctx.tenantId, ctx.userId, { id, title: input.title, priority: input.priority }, now)
  return created
}

export async function completeRequest(id: string, ctx: ServiceCtx) {
  const now = new Date().toISOString()

  const completed = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      SET r.status       = 'completed',
          r.completed_at = $now,
          r.updated_at   = $now
      RETURN properties(r) as props
    `, { id, tenantId: ctx.tenantId, now })
    if (!rows[0]) throw new Error('ServiceRequest not found')
    return mapRequest(rows[0].props)
  }, true)

  await publishEvent('request.completed', ctx.tenantId, ctx.userId, { id, completed_at: now }, now)
  return completed
}
