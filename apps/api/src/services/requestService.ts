import { v4 as uuidv4 } from 'uuid'
import { nextSequenceValue } from '../lib/sequence.js'
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'
import { publishEvent } from '../lib/publishEvent.js'
import { getInitialStepName } from '../lib/workflowHelpers.js'
import { workflowEngine } from '@opengraphity/workflow'

type Props = Record<string, unknown>

function mapRequest(props: Props) {
  return {
    id:          props['id']           as string,
    number:      (props['number'] ?? '') as string,
    tenantId:    props['tenant_id']    as string,
    title:       props['title']        as string,
    description: props['description']  as string | undefined,
    status:      props['status']       as string,
    priority:    props['priority']     as string,
    dueDate:     props['due_date']     as string | undefined,
    completedAt: props['completed_at'] as string | undefined,
    catalogItemId: (props['catalog_item_id'] ?? null) as string | null,
    requiresApproval: (props['requires_approval'] ?? false) as boolean,
    createdAt:   props['created_at']   as string,
    updatedAt:   props['updated_at']   as string,
    requestedBy: null,
    assignee:    null,
  }
}

export async function createRequest(
  input: { title: string; description?: string; priority: string; dueDate?: string; catalogItemId?: string; requiresApproval?: boolean },
  ctx: ServiceCtx,
) {
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const seq = await nextSequenceValue(session, ctx.tenantId, 'service_request')
    const number = 'REQ' + String(seq).padStart(8, '0')

    // Real lifecycle: start at the workflow's initial step, not a phantom 'open'.
    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'service_request')

    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (r:ServiceRequest {
        id:                $id,
        tenant_id:         $tenantId,
        number:            $number,
        title:             $title,
        description:       $description,
        status:            $status,
        priority:          $priority,
        due_date:          $dueDate,
        catalog_item_id:   $catalogItemId,
        requires_approval: $requiresApproval,
        created_at:        $now,
        updated_at:        $now
      })
      RETURN properties(r) as props
    `, {
      id, tenantId: ctx.tenantId, number, status: initialStatus,
      title: input.title, description: input.description ?? null,
      priority: input.priority, dueDate: input.dueDate ?? null,
      catalogItemId: input.catalogItemId ?? null,
      requiresApproval: input.requiresApproval ?? false,
      now,
    })
    if (!rows[0]) throw new Error('Failed to create service request')

    await runQuery(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NOT NULL THEN [1] ELSE [] END |
        MERGE (r)-[:REQUESTED_BY]->(u)
      )
    `, { id, tenantId: ctx.tenantId, userId: ctx.userId })

    await workflowEngine.createInstance(session, ctx.tenantId, id, 'service_request')

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
