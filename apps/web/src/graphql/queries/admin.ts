/**
 * Barrel kept for backwards compatibility (E-17): the former catch-all
 * `admin.ts` was split per domain. Import from the domain file (or from
 * `@/graphql/queries`, which re-exports everything); do NOT add documents here.
 */
export * from './users.js'
export * from './teams.js'
export * from './reports.js'
export * from './dashboard.js'
export * from './anomaly.js'
export * from './enum.js'
export * from './notifications.js'
export * from './queue.js'
export * from './rules.js'
export * from './automation.js'
export * from './sla.js'
export * from './collaboration.js'
export * from './whatIf.js'
export * from './catalog.js'
