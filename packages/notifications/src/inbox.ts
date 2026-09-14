/**
 * L'ARCHIVIO DELLE NOTIFICHE IN-APP (revisione del 14 set 2026 · F10).
 *
 * Una notifica è un nodo `:InAppNotification` del tenant, per una persona
 * (`audience: 'user'`, `user_id`) o per tutto il tenant (`audience: 'tenant'`).
 * Lo stato di una persona sta sulle relazioni `READ_NOTIFICATION` e
 * `DISMISSED_NOTIFICATION` dal suo `:User`, così una notifica del tenant non
 * si copia per ogni persona. La pulizia per età la fa un job di manutenzione.
 */
import { getSession } from '@opengraphity/neo4j'
import type { InAppDelivery, InAppNotification } from './sse.js'

export async function persistInApp(delivery: InAppDelivery): Promise<void> {
  const n = delivery.notification
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) => tx.run(`
      CREATE (n:InAppNotification {
        id: $id, tenant_id: $tenantId, audience: $audience, user_id: $userId,
        type: $type, title: $title, title_fallback: $titleFallback,
        message: $message, message_key: $messageKey, message_params: $messageParams,
        severity: $severity, entity_id: $entityId, entity_type: $entityType,
        created_at: $createdAt
      })
    `, {
      id: n.id, tenantId: delivery.tenantId,
      audience: delivery.userId === null ? 'tenant' : 'user', userId: delivery.userId,
      type: n.type, title: n.title, titleFallback: n.title_fallback ?? null,
      message: n.message, messageKey: n.message_key ?? null,
      messageParams: n.message_params ? JSON.stringify(n.message_params) : null,
      severity: n.severity ?? null, entityId: n.entity_id ?? null, entityType: n.entity_type ?? null,
      createdAt: n.timestamp,
    }))
  } finally {
    await session.close()
  }
}

const VISIBLE = `
  MATCH (n:InAppNotification {tenant_id: $tenantId})
  WHERE (n.audience = 'tenant' OR n.user_id = $userId)
`

function parseParams(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : undefined
  } catch {
    return undefined
  }
}

/** Le notifiche di una persona, dalla più recente, senza quelle che ha nascosto. */
export async function listInbox(tenantId: string, userId: string, limit: number): Promise<InAppNotification[]> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      ${VISIBLE}
        AND NOT EXISTS { MATCH (:User {id: $userId, tenant_id: $tenantId})-[:DISMISSED_NOTIFICATION]->(n) }
      OPTIONAL MATCH (:User {id: $userId, tenant_id: $tenantId})-[r:READ_NOTIFICATION]->(n)
      RETURN properties(n) AS props, r IS NOT NULL AS read
      ORDER BY n.created_at DESC
      LIMIT toInteger($limit)
    `, { tenantId, userId, limit }))
    return res.records.map((r) => {
      const p = r.get('props') as Record<string, unknown>
      return {
        id:             p['id'] as string,
        type:           p['type'] as string,
        title:          p['title'] as string,
        title_fallback: (p['title_fallback'] ?? undefined) as string | undefined,
        message:        (p['message'] ?? '') as string,
        message_key:    (p['message_key'] ?? undefined) as string | undefined,
        message_params: parseParams(p['message_params']),
        severity:       (p['severity'] ?? undefined) as InAppNotification['severity'],
        entity_id:      (p['entity_id'] ?? undefined) as string | undefined,
        entity_type:    (p['entity_type'] ?? undefined) as string | undefined,
        timestamp:      p['created_at'] as string,
        read:           r.get('read') === true,
      }
    })
  } finally {
    await session.close()
  }
}

async function countWrite(cypher: string, params: Record<string, unknown>): Promise<number> {
  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) => tx.run(cypher, params))
    return Number(res.records[0]?.get('n') ?? 0)
  } finally {
    await session.close()
  }
}

export function markInboxRead(tenantId: string, userId: string, id: string): Promise<number> {
  return countWrite(`
    ${VISIBLE} AND n.id = $id
    MATCH (u:User {id: $userId, tenant_id: $tenantId})
    MERGE (u)-[r:READ_NOTIFICATION]->(n) ON CREATE SET r.at = $now
    RETURN count(n) AS n
  `, { tenantId, userId, id, now: new Date().toISOString() })
}

export function markAllInboxRead(tenantId: string, userId: string): Promise<number> {
  return countWrite(`
    ${VISIBLE}
    MATCH (u:User {id: $userId, tenant_id: $tenantId})
    WHERE NOT (u)-[:READ_NOTIFICATION]->(n)
    MERGE (u)-[r:READ_NOTIFICATION]->(n) ON CREATE SET r.at = $now
    RETURN count(n) AS n
  `, { tenantId, userId, now: new Date().toISOString() })
}

export function dismissInbox(tenantId: string, userId: string): Promise<number> {
  return countWrite(`
    ${VISIBLE}
    MATCH (u:User {id: $userId, tenant_id: $tenantId})
    WHERE NOT (u)-[:DISMISSED_NOTIFICATION]->(n)
    MERGE (u)-[:DISMISSED_NOTIFICATION]->(n)
    RETURN count(n) AS n
  `, { tenantId, userId })
}

/** Cancella le notifiche create prima di `before` (ISO), a lotti. Ritorna quante. */
export async function pruneInbox(before: string, batch = 1000): Promise<number> {
  let total = 0
  for (;;) {
    const n = await countWrite(`
      MATCH (n:InAppNotification) WHERE n.created_at < $before
      WITH n LIMIT toInteger($batch)
      DETACH DELETE n
      RETURN count(*) AS n
    `, { before, batch })
    total += n
    if (n < batch) return total
  }
}
