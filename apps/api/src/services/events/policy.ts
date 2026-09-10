/**
 * Repository della policy del tenant (`Tenant.event_policy`, lib/eventPolicy.ts).
 * Lettura dalla cache in memoria (TTL 30 s) o dal grafo; la scrittura
 * invalida la cache. Un ingest la chiede una volta e la passa lungo la
 * pipeline (M11): una sola lettura per tenant ogni 30 s invece di una per
 * allarme.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { NotFoundError } from '../../lib/errors.js'
import { parseEventPolicy, getCachedEventPolicy, cacheEventPolicy, invalidateEventPolicyCache, type EventPolicy } from '../../lib/eventPolicy.js'

export async function getEventPolicy(tenantId: string): Promise<EventPolicy> {
  const cached = getCachedEventPolicy(tenantId)
  if (cached) return cached
  const session = getSession()
  try {
    const row = await runQueryOne<{ raw: unknown }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      RETURN t.event_policy AS raw
    `, { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    const policy = parseEventPolicy(row.raw, tenantId)
    cacheEventPolicy(tenantId, policy)
    return policy
  } finally {
    await session.close()
  }
}

export async function setEventPolicy(tenantId: string, policy: EventPolicy): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.event_policy = $policy, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, policy: JSON.stringify(policy), now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  invalidateEventPolicyCache(tenantId)
}
