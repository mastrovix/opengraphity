export * from './driver.js'
export * from './query.js'
export * from './migrations.js'
export { initSchema, GLOBAL_SEARCH_LABELS, GLOBAL_SEARCH_PROPERTIES, type InitSchemaOptions } from './init.js'
// tenant.ts (withTenant/assertTenant) was removed (D-27): no callers, and the
// regex-based WHERE injection produced wrong filters silently.
