import { v4 as uuidv4 } from 'uuid'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { runQuery } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import type { ServiceCtx } from './incidentService.js'

type Props = Record<string, unknown>

function buildEvent<T>(
  type: string,
  tenantId: string,
  userId: string,
  payload: T,
  timestamp: string,
): DomainEvent<T> {
  return {
    id:             uuidv4(),
    type,
    tenant_id:      tenantId,
    timestamp,
    correlation_id: uuidv4(),
    actor_id:       userId,
    payload,
  }
}

export async function createCI(
  input: { name: string; type: string; status: string; environment: string },
  ctx: ServiceCtx,
) {
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (ci:ConfigurationItem {
        id:          $id,
        tenant_id:   $tenantId,
        name:        $name,
        type:        $type,
        status:      $status,
        environment: $environment,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(ci) as props
    `, { id, tenantId: ctx.tenantId, ...input, now })
    if (!rows[0]) throw new Error('Failed to create ConfigurationItem')
    return rows[0].props
  }, true)

  await publish(buildEvent(
    'ci.created', ctx.tenantId, ctx.userId,
    { id, type: input.type, tenant_id: ctx.tenantId },
    now,
  ))
  return created
}

export async function addDependency(
  fromId: string,
  toId: string,
  type: string,
  ctx: ServiceCtx,
) {
  const now = new Date().toISOString()

  await withSession(async (session) => {
    await runQuery(session, `
      MATCH (a:ConfigurationItem {id: $fromId, tenant_id: $tenantId})
      MATCH (b:ConfigurationItem {id: $toId,   tenant_id: $tenantId})
      MERGE (a)-[r:DEPENDS_ON {type: $type}]->(b)
      ON CREATE SET r.created_at = $now
    `, { fromId, toId, type, tenantId: ctx.tenantId, now })
  }, true)

  await publish(buildEvent(
    'ci.dependency_added', ctx.tenantId, ctx.userId,
    { from_id: fromId, to_id: toId, type },
    now,
  ))
}
