import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { workflowEngine, selectWorkflowForEntity } from '@opengraphity/workflow'
import { withSession } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, type Props } from './mappers.js'
import { validateStringLength } from '../../../lib/validation.js'
import { audit } from '../../../lib/audit.js'
import { logger } from '../../../lib/logger.js'

export async function createChange(
  _: unknown,
  args: { input: {
    title: string; description?: string; type: string; priority: string
    affectedCIIds?: string[]; relatedIncidentIds?: string[]
  } },
  ctx: GraphQLContext,
) {
  const { input } = args
  if (input.type === 'standard') {
    throw new GraphQLError('Standard Changes can only be created from the catalog', { extensions: { code: 'BAD_USER_INPUT' } })
  }
  validateStringLength(input.title, 'title', 1, 500)
  validateStringLength(input.description, 'description', 0, 10000)

  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const countResult = await runQueryOne<{ cnt: unknown }>(session,
      'MATCH (c:Change {tenant_id: $tenantId}) RETURN count(c) AS cnt',
      { tenantId: ctx.tenantId },
    )
    const rawCnt = countResult?.cnt
    const count = typeof rawCnt === 'number' ? rawCnt : typeof (rawCnt as any)?.toNumber === 'function' ? (rawCnt as any).toNumber() : Number(rawCnt ?? 0)
    const number = 'CHG' + String(count + 1).padStart(8, '0')

    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (c:Change {
        id:           $id,
        tenant_id:    $tenantId,
        number:       $number,
        title:        $title,
        description:  $description,
        type:         $type,
        priority:     $priority,
        status:       'draft',
        created_at:   $now,
        updated_at:   $now
      })
      RETURN properties(c) as props
    `, {
      id, tenantId: ctx.tenantId, number,
      title: input.title, description: input.description ?? null,
      type: input.type, priority: input.priority, now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Failed to create change')
    return mapChange(row.props)
  }, true)

  // Link affected CIs
  if (input.affectedCIIds?.length) {
    await withSession(async (session) => {
      for (const ciId of input.affectedCIIds!) {
        await runQuery(session, `
          MATCH (c:Change {id: $id, tenant_id: $tenantId})
          MATCH (ci {id: $ciId, tenant_id: $tenantId})
          WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
          MERGE (c)-[:AFFECTS]->(ci)
        `, { id, tenantId: ctx.tenantId, ciId })
      }
    }, true)
  }

  // Link related incidents
  if (input.relatedIncidentIds?.length) {
    await withSession(async (session) => {
      for (const iId of input.relatedIncidentIds!) {
        await runQuery(session, `
          MATCH (c:Change {id: $id, tenant_id: $tenantId})
          MATCH (i:Incident {id: $iId, tenant_id: $tenantId})
          MERGE (c)-[:RELATED_TO]->(i)
        `, { id, tenantId: ctx.tenantId, iId })
      }
    }, true)
  }

  // Create workflow instance for the correct definition
  await withSession(async (session) => {
    const typePart = input.type.toLowerCase()

    // Use the selector with changeSubtype
    const selected = await selectWorkflowForEntity(session, ctx.tenantId, 'change', null, typePart)
    const definitionId = selected?.definitionId

    if (!definitionId) {
      logger.warn({ type: input.type, tenantId: ctx.tenantId }, 'No workflow found for change type')
    }

    await workflowEngine.createInstance(session, ctx.tenantId, id, 'change', definitionId)

    // For standard type: auto-transition draft → approved
    if (input.type === 'standard') {
      const wiRes = await session.executeRead((tx) => tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN wi.id AS instanceId
      `, { id, tenantId: ctx.tenantId }))
      if (wiRes.records.length > 0) {
        const instanceId = wiRes.records[0].get('instanceId') as string
        await workflowEngine.transition(session, {
          instanceId, toStepName: 'approved',
          triggeredBy: 'system', triggerType: 'automatic',
          notes: 'Standard change — auto-approvato',
        }, { userId: ctx.userId, entityData: {} })
      }
    }
  }, true)

  void audit(ctx, 'change.created', 'Change', id)
  return created
}
