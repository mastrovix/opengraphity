/**
 * Indexed lookups by id: the implementation lives in `@opengraphity/types`
 * (the engines in `packages/*` need it too). Re-exported here so that the API
 * imports it like its other Cypher helpers.
 */
export { matchById, TICKET_NODE_LABELS, WORKFLOW_ENTITY_NODE_LABELS } from '@opengraphity/types'
export type { MatchByIdOptions, LabelSet } from '@opengraphity/types'
