export * from './driver.js'
export * from './query.js'
// tenant.ts (withTenant/assertTenant) was removed (D-27): no callers, and the
// regex-based WHERE injection produced wrong filters silently.
