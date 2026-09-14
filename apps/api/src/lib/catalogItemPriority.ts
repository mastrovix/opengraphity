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

/**
 * Le voci attive con una categoria scritta a mano che non corrispondeva a
 * nessun valore del Dizionario (ondata 2): la loro categoria è vuota finché
 * l'amministratore non ne sceglie una, e le richieste nascono senza.
 */
export async function catalogItemsWithLegacyCategory(session: Session, tenantId: string): Promise<Array<{ name: string; legacy: string }>> {
  const r = await session.executeRead((tx) => tx.run(`
    MATCH (ci:ServiceCatalogItem {tenant_id: $tenantId})
    WHERE coalesce(ci.active, true) = true AND ci.legacy_category IS NOT NULL
    RETURN ci.name AS name, ci.legacy_category AS legacy ORDER BY name
  `, { tenantId }))
  return r.records.map((rec) => ({ name: rec.get('name') as string, legacy: rec.get('legacy') as string }))
}
