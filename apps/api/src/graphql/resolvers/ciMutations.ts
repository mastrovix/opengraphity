import { withSession } from './ci-utils.js'
import { cache } from '../../lib/cache.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'

type Props = Record<string, unknown>

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

export function buildCreateMutation(
  ciType: CITypeWithDefinitions,
  neo4jLabel: string,
  mapCI: (props: Props, ciType: CITypeWithDefinitions) => Record<string, unknown>,
) {
  return async (_: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) =>
    withSession(async (session) => {
      const { input } = args
      const id  = crypto.randomUUID()
      const now = new Date().toISOString()

      const props: Record<string, unknown> = {
        id, tenant_id: ctx.tenantId,
        name:        input['name'],
        status:      input['status']      ?? 'active',
        environment: input['environment'] ?? null,
        description: input['description'] ?? null,
        notes:       input['notes']       ?? null,
        created_at:  now, updated_at: now,
      }
      for (const field of ciType.fields) {
        if (input[field.name] !== undefined) {
          props[toSnakeCase(field.name)] = input[field.name]
        }
      }

      const result = await session.executeWrite(tx =>
        tx.run(`CREATE (n:${neo4jLabel} $props) RETURN properties(n) AS p`, { props }),
      )

      if (input['ownerGroupId']) {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
             MERGE (n)-[:OWNED_BY]->(t)`,
            { id, teamId: input['ownerGroupId'], tenantId: ctx.tenantId },
          ),
        )
      }
      if (input['supportGroupId']) {
        await session.executeWrite(tx =>
          tx.run(
            `MATCH (n:${neo4jLabel} {id: $id}) MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
             MERGE (n)-[:SUPPORTED_BY]->(t)`,
            { id, teamId: input['supportGroupId'], tenantId: ctx.tenantId },
          ),
        )
      }

      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}`)
      cache.invalidate(`topology:${ctx.tenantId}`)
      void audit(ctx, 'ci.created', 'ConfigurationItem', id)
      return mapCI(result.records[0].get('p') as Props, ciType)
    }, true)
}

export function buildUpdateMutation(
  ciType: CITypeWithDefinitions,
  neo4jLabel: string,
  mapCI: (props: Props, ciType: CITypeWithDefinitions) => Record<string, unknown>,
) {
  return async (
    _: unknown,
    args: { id: string; input: Record<string, unknown> },
    ctx: GraphQLContext,
  ) =>
    withSession(async session => {
      const { id, input } = args
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      for (const f of ['name', 'status', 'environment', 'description', 'notes']) {
        if (input[f] !== undefined) updates[f] = input[f]
      }
      for (const field of ciType.fields) {
        if (input[field.name] !== undefined) {
          updates[toSnakeCase(field.name)] = input[field.name]
        }
      }
      const result = await session.executeWrite(tx =>
        tx.run(
          `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) SET n += $updates RETURN properties(n) AS p`,
          { id, tenantId: ctx.tenantId, updates },
        ),
      )
      if (!result.records.length) throw new Error('CI non trovato')
      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}`)
      cache.invalidate(`topology:${ctx.tenantId}`)
      void audit(ctx, 'ci.updated', 'ConfigurationItem', id)
      return mapCI(result.records[0].get('p') as Props, ciType)
    }, true)
}

export function buildDeleteMutation(
  neo4jLabel: string,
) {
  return async (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
    withSession(async session => {
      await session.executeWrite(tx =>
        tx.run(
          `MATCH (n:${neo4jLabel} {id: $id, tenant_id: $tenantId}) DETACH DELETE n`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
      cache.invalidate(`ci:${ctx.tenantId}:${neo4jLabel}`)
      cache.invalidate(`topology:${ctx.tenantId}`)
      void audit(ctx, 'ci.deleted', 'ConfigurationItem', args.id)
      return true
    }, true)
}
