// Shared contract only (D-21): domain events + payloads, the Tenant node shape
// (onboarding script, tenant settings) and the real user roles. Entity models
// (Incident, Change, Problem, ServiceRequest, ConfigurationItem) are NOT here:
// nobody imported them and they lied about the domain.
export * from './tenant.js'
export * from './user.js'
export * from './events.js'
export * from './notificationRoutes.js'
export * from './notificationTargets.js'
export * from './workflowPurpose.js'
