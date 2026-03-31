import { v4 as uuidv4 } from 'uuid'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'

export interface ChangeEventPayload {
  id: string; title: string; type: string; status: string
  ciName: string; assignedTo: string
}

export interface ChangeTaskPayloadItem {
  changeId: string; changeTitle: string
  taskId: string; ciName: string; teamName: string; assignedTo: string
}

async function loadChangePayload(
  changeId: string,
  tenantId: string,
  status: string,
): Promise<ChangeEventPayload | null> {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      OPTIONAL MATCH (c)-[:AFFECTS]->(ci)
      OPTIONAL MATCH (c)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (c)-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN c.id AS id, c.title AS title, c.type AS type,
             collect(DISTINCT ci.name)[0] AS ciName,
             u.name AS assignedTo, t.name AS teamName
    `, { changeId, tenantId }))
    if (!result.records.length) return null
    const r = result.records[0]
    return {
      id:         r.get('id')                                                    as string,
      title:      r.get('title')                                                 as string,
      type:       r.get('type')                                                  as string,
      status,
      ciName:     ((r.get('ciName')    ?? '—') as string),
      assignedTo: ((r.get('assignedTo') ?? r.get('teamName') ?? '—') as string),
    } satisfies ChangeEventPayload
  })
}

function buildEvent<T>(
  type: string,
  tenantId: string,
  userId: string,
  payload: T,
): DomainEvent<T> {
  return {
    id:             uuidv4(),
    type,
    tenant_id:      tenantId,
    timestamp:      new Date().toISOString(),
    correlation_id: uuidv4(),
    actor_id:       userId,
    payload,
  }
}

export async function approveChange(
  changeId: string,
  ctx: ServiceCtx,
) {
  const payload = await withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      OPTIONAL MATCH (c)-[:AFFECTS]->(ci)
      OPTIONAL MATCH (c)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (c)-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN c.id AS id, c.title AS title, c.type AS type, c.status AS status,
             collect(DISTINCT ci.name)[0] AS ciName,
             u.name AS assignedTo, t.name AS teamName
    `, { changeId, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const r = result.records[0]
    return {
      id:         r.get('id')                                                    as string,
      title:      r.get('title')                                                 as string,
      type:       r.get('type')                                                  as string,
      status:     'scheduled',
      ciName:     ((r.get('ciName')    ?? '—') as string),
      assignedTo: ((r.get('assignedTo') ?? r.get('teamName') ?? '—') as string),
    } satisfies ChangeEventPayload
  })

  if (!payload) return
  await publish(buildEvent('change.approved', ctx.tenantId, ctx.userId, payload))
}

export async function completeChange(changeId: string, ctx: ServiceCtx) {
  const payload = await loadChangePayload(changeId, ctx.tenantId, 'completed')
  if (!payload) return
  await publish(buildEvent('change.completed', ctx.tenantId, ctx.userId, payload))
}

export async function failChange(changeId: string, ctx: ServiceCtx) {
  const payload = await loadChangePayload(changeId, ctx.tenantId, 'failed')
  if (!payload) return
  await publish(buildEvent('change.failed', ctx.tenantId, ctx.userId, payload))
}

export async function rejectChange(changeId: string, ctx: ServiceCtx) {
  const payload = await loadChangePayload(changeId, ctx.tenantId, 'rejected')
  if (!payload) return
  await publish(buildEvent('change.rejected', ctx.tenantId, ctx.userId, payload))
}

export async function publishTaskAssigned(
  item: ChangeTaskPayloadItem,
  ctx: ServiceCtx,
) {
  await publish(buildEvent('change.task_assigned', ctx.tenantId, ctx.userId, item))
}
