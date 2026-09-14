/**
 * Le voci attive del catalogo servizi senza priorità (verifica «Cosa resta
 * cablato», ondata 1): la priorità delle richieste la decide la voce, e da una
 * voce che non ne ha il portale non apre richieste.
 */
import type { Session } from 'neo4j-driver'

export async function catalogItemsWithoutPriority(session: Session, tenantId: string): Promise<string[]> {
  const r = await session.executeRead((tx) => tx.run(`
    MATCH (ci:ServiceCatalogItem {tenant_id: $tenantId})
    WHERE coalesce(ci.active, true) = true AND (ci.priority IS NULL OR ci.priority = '')
    RETURN ci.name AS name ORDER BY name
  `, { tenantId }))
  return r.records.map((rec) => rec.get('name') as string)
}
