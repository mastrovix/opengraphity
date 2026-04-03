import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { runQuery } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { withSession } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, type Props } from './mappers.js'
import { validateStringLength } from '../../../lib/validation.js'

export async function createChange(
  _: unknown,
  args: { input: {
    title: string; description?: string; type: string; priority: string
    affectedCIIds?: string[]; relatedIncidentIds?: string[]
  } },
  ctx: GraphQLContext,
) {
  const { input } = args
  validateStringLength(input.title, 'title', 1, 500)
  validateStringLength(input.description, 'description', 0, 10000)

  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (c:Change {
        id:           $id,
        tenant_id:    $tenantId,
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
      id, tenantId: ctx.tenantId,
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
    // Find the definition matching the change type
    const defRes = await session.executeRead((tx) => tx.run(`
      MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'change', active: true})
      WHERE toLower(wd.name) CONTAINS $typePart
      RETURN wd.id AS defId LIMIT 1
    `, { tenantId: ctx.tenantId, typePart: input.type.toLowerCase() }))

    const definitionId = defRes.records.length > 0
      ? (defRes.records[0].get('defId') as string)
      : undefined

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

  return created
}
