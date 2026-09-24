/**
 * THE GRAPHQL SCHEMA OF A TENANT, FOR THE LAYERS BELOW IT (wave 7 · C1).
 *
 * Three checks outside the resolvers ask what the tenant's API looks like:
 * the diagnostics (is the schema degraded?), the name of a new custom field
 * and the form designer (is that name already a field of the type?). The
 * schema is built by graphql/schemaCache.ts, with the resolvers — the layer
 * above. It registers itself here when it is loaded, as the workflow's
 * conditions register on the engine, and these checks read it through this
 * module: lib and services no longer import the GraphQL layer.
 *
 * A process that has not loaded the schema (a worker, a script) and asks for
 * it gets an error that says so, not an empty schema.
 */
import type { GraphQLSchema } from 'graphql'

export interface TenantSchemaState {
  schema:   GraphQLSchema
  degraded: boolean
  reason:   string | null
}

export interface TenantSchemaSource {
  getSchemaForTenant(tenantId: string): Promise<GraphQLSchema>
  getSchemaState(tenantId: string): Promise<TenantSchemaState>
}

let source: TenantSchemaSource | null = null

/** Declares where the tenants' schemas come from: graphql/schemaCache.ts, when it is loaded. */
export function registerTenantSchemaSource(s: TenantSchemaSource): void {
  source = s
}

function current(): TenantSchemaSource {
  if (!source) {
    throw new Error('No tenant GraphQL schema in this process: graphql/schemaCache.ts registers it where the GraphQL server runs')
  }
  return source
}

/** The GraphQL schema the tenant is served. */
export function getSchemaForTenant(tenantId: string): Promise<GraphQLSchema> {
  return current().getSchemaForTenant(tenantId)
}

/** The tenant's schema, and whether it is served degraded (and why). */
export function getSchemaState(tenantId: string): Promise<TenantSchemaState> {
  return current().getSchemaState(tenantId)
}
