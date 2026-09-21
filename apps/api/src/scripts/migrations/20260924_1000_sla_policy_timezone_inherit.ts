/**
 * Revisione del 14 set 2026 · F7: una policy SLA senza fuso proprio segue il
 * fuso del cliente.
 *
 * La creazione copiava nella policy il fuso del cliente, così cambiarlo dalla
 * pagina Organizzazione non avrebbe spostato nessuna policy. Qui le policy il
 * cui fuso è UGUALE a quello del loro cliente tornano a ereditarlo (null): è il
 * valore che la creazione aveva copiato. Quelle con un fuso diverso lo tengono,
 * perché è stata una scelta. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const slaPolicyTimezoneInherit: Migration = {
  id: '20260924_1000_sla_policy_timezone_inherit',
  description: 'Policy SLA con il fuso uguale a quello del cliente: tornano a ereditarlo (null)',
  async up(session) {
    const r = await session.run(`
      MATCH (p:SLAPolicyNode), (t:Tenant {id: p.tenant_id})
      WHERE p.timezone IS NOT NULL AND p.timezone = t.timezone
      SET p.timezone = null
      RETURN count(p) AS n
    `)
    const kept = await session.run(`
      MATCH (p:SLAPolicyNode) WHERE p.timezone IS NOT NULL RETURN count(p) AS n
    `)
    console.log(`[${slaPolicyTimezoneInherit.id}] ereditano il fuso del cliente: ${String(r.records[0]?.get('n') ?? 0)}; con fuso proprio: ${String(kept.records[0]?.get('n') ?? 0)}`)
  },
}
