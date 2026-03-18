/**
 * Thin indirection layer to avoid circular imports:
 *   schemaCache → resolvers/index → dynamic-ci → schemaCache
 *
 * schemaCache.ts calls registerSchemaInvalidator() at module init.
 * dynamic-ci.ts calls invalidateSchema() in metamodel mutations.
 */

let _fn: (tenantId: string) => void = () => {}

export function registerSchemaInvalidator(fn: (tenantId: string) => void): void {
  _fn = fn
}

export function invalidateSchema(tenantId: string): void {
  _fn(tenantId)
}
