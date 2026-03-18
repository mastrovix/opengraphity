import { makeExecutableSchema } from '@graphql-tools/schema'
import type { GraphQLSchema } from 'graphql'
import { loadMetamodel, generateSDL } from '@opengraphity/schema-generator'
import { buildBaseSDL } from '../graphql/schema-base.js'
import { buildResolvers } from '../graphql/resolvers/index.js'
import { logger } from './logger.js'

interface SchemaCacheEntry {
  schema: GraphQLSchema
  generatedAt: number
  tenantId: string
}

const cache = new Map<string, SchemaCacheEntry>()
const TTL = 5 * 60 * 1000  // 5 minuti

export async function getSchemaForTenant(tenantId: string): Promise<GraphQLSchema> {
  const cached = cache.get(tenantId)
  if (cached && (Date.now() - cached.generatedAt) < TTL) {
    return cached.schema
  }
  return regenerateSchema(tenantId)
}

export async function regenerateSchema(tenantId: string): Promise<GraphQLSchema> {
  logger.info({ tenantId }, 'Rigenerando schema GraphQL')

  const types = await loadMetamodel(tenantId)
  const dynamicSDL = generateSDL(types)
  const baseSDL = buildBaseSDL()
  const resolvers = buildResolvers(types)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = makeExecutableSchema({
    typeDefs: [baseSDL, dynamicSDL],
    resolvers: resolvers as any,
  })

  cache.set(tenantId, { schema, generatedAt: Date.now(), tenantId })

  logger.info({ tenantId, types: types.length }, 'Schema rigenerato')

  return schema
}

export function invalidateSchema(tenantId: string): void {
  cache.delete(tenantId)
  logger.info({ tenantId }, 'Schema invalidato — verrà rigenerato')
}
