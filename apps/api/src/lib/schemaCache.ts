import { makeExecutableSchema } from '@graphql-tools/schema'
import type { GraphQLSchema } from 'graphql'
import { loadMetamodel, generateSDL, loadITILTypes, generateITILEnumsSDL } from '@opengraphity/schema-generator'
import { buildBaseSDL } from '../graphql/schema-base.js'
import { buildResolvers } from '../graphql/resolvers/index.js'
import { logger } from './logger.js'
import { registerSchemaInvalidator } from './schemaInvalidator.js'
import { registerCITypes } from './ciTypeFromLabels.js'

interface SchemaCacheEntry {
  schema: GraphQLSchema
  generatedAt: number
  tenantId: string
}

const cache = new Map<string, SchemaCacheEntry>()
const TTL = 5 * 60 * 1000  // 5 minuti

// Register invalidator so dynamic-ci.ts can call it without circular imports
registerSchemaInvalidator((tenantId: string) => {
  cache.delete(tenantId)
  logger.info({ tenantId }, 'Schema invalidato — verrà rigenerato')
})

export async function getSchemaForTenant(tenantId: string): Promise<GraphQLSchema> {
  const cached = cache.get(tenantId)
  if (cached && (Date.now() - cached.generatedAt) < TTL) {
    return cached.schema
  }
  return regenerateSchema(tenantId)
}

export async function regenerateSchema(tenantId: string): Promise<GraphQLSchema> {
  logger.info({ tenantId }, 'Rigenerando schema GraphQL')

  const [ciTypes, itilTypes] = await Promise.all([
    loadMetamodel(tenantId),
    loadITILTypes(tenantId),
  ])
  registerCITypes(ciTypes)
  const dynamicSDL    = generateSDL(ciTypes)
  const itilEnumsSDL  = generateITILEnumsSDL(itilTypes)
  const baseSDL       = buildBaseSDL()
  const resolvers     = buildResolvers(ciTypes)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = makeExecutableSchema({
    typeDefs: itilEnumsSDL
      ? [baseSDL, dynamicSDL, itilEnumsSDL]
      : [baseSDL, dynamicSDL],
    resolvers: resolvers as any,
  })

  cache.set(tenantId, { schema, generatedAt: Date.now(), tenantId })

  logger.info({ tenantId, ciTypes: ciTypes.length, itilTypes: itilTypes.length }, 'Schema rigenerato')

  return schema
}

// Note: invalidateSchema is now in schemaInvalidator.ts to avoid circular imports
// It is still exported here for backward compatibility with server.ts etc.
export { invalidateSchema } from './schemaInvalidator.js'
