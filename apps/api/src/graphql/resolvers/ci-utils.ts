import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'
import { neo4jDateToISO } from '../../lib/mappers.js'
import type { Props } from '../../lib/db.js'

export { ciTypeFromLabels }

/*
 * The database access is lib/db.ts (wave 7 · C1): re-exported here for the
 * resolvers, which have always imported it from this file.
 */
export { withSession, runQuery, runQueryOne, getSession, type Props } from '../../lib/db.js'

export function mapBase(props: Props) {
  return {
    id:           props['id']          as string,
    name:         (props['name']       ?? '') as string,
    // type must be set by the caller via ciTypeFromLabels(tenantId, [label]) before mapCI is called
    type:         (props['type']       ?? null) as string | null,
    status:       props['status']      as string | null ?? null,
    environment:  props['environment'] as string | null ?? null,
    description:  props['description'] as string | null ?? null,
    chain:        props['chain']      as string | null ?? null,
    // The infrastructure flag (24 Sep 2026): a field every CI has; absent = not flagged.
    isInfrastructure: props['is_infrastructure'] === true,
    createdAt:    neo4jDateToISO(props['created_at']) ?? '',
    updatedAt:    neo4jDateToISO(props['updated_at']),
    notes:        props['notes']       as string | null ?? null,
    ownerGroup:   null,
    supportGroup: null,
    dependencies: [],
    dependents:   [],
    // Event Management (sola lettura: scritti da eventService)
    health:       (props['health']        ?? null) as string | null,
    healthSource: (props['health_source'] ?? null) as string | null,
    lastEventAt:  neo4jDateToISO(props['last_event_at']),
  }
}

export function mapCI(props: Props) {
  return mapBase(props)
}

