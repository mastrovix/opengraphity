/**
 * Ondata 7 di «Nulla cablato»: i ruoli diventano dato dell'organizzazione.
 *
 * Per ogni tenant crea i quattro ruoli di fabbrica (`admin`, `operator`,
 * `viewer`, `end_user`) con i permessi di `FACTORY_ROLE_PERMISSIONS`: quelli di
 * prima, più le quattro correzioni approvate dal proprietario. `User.role`
 * porta già la chiave del ruolo, quindi ogni persona è collegata al suo senza
 * riscrivere niente; una persona con un ruolo che il tenant non ha fa fallire la
 * migrazione, perché da quel momento non potrebbe fare niente.
 *
 * Un ruolo che c'è già non si tocca. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { seedFactoryRoles } from '../../lib/roles.js'

export const factoryRoles: Migration = {
  id: '20260928_1000_factory_roles',
  description: 'Ruoli di fabbrica (:Role) per ogni tenant, con i permessi di prima',
  async up(session) {
    const tenants = await session.run(`MATCH (t:Tenant) WHERE t.id <> 'system' RETURN t.id AS id ORDER BY id`)
    for (const rec of tenants.records) {
      const tenantId = rec.get('id') as string
      const created = await seedFactoryRoles(session, tenantId)
      console.log(`[${factoryRoles.id}] ${tenantId}: ${created.length ? created.join(', ') : 'già presenti'}`)
    }
    const orphans = await session.run(`
      MATCH (u:User) WHERE u.tenant_id <> 'system'
        AND NOT EXISTS { MATCH (r:Role {tenant_id: u.tenant_id, key: u.role}) }
      RETURN u.tenant_id AS tenantId, u.id AS userId, u.role AS role
    `)
    if (orphans.records.length) {
      const list = orphans.records.map((r) => `${String(r.get('tenantId'))}/${String(r.get('userId'))} (${String(r.get('role'))})`).join(', ')
      throw new Error(`[${factoryRoles.id}] people with a role their organization does not have: ${list}`)
    }
  },
}
