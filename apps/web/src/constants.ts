/** ITIL entity types used across admin pages */
export const ITIL_ENTITY_TYPES = ['incident', 'change', 'problem', 'service_request'] as const
export type ITILEntityType = typeof ITIL_ENTITY_TYPES[number]
