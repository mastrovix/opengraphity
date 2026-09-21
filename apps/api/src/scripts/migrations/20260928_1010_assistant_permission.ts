/**
 * Il permesso «Assistente AI» (`assistant.use`), dopo l'ondata 7 di «Nulla
 * cablato». Prima l'assistente lo usava chiunque avesse fatto login, portale
 * compreso, e leggeva incident, CI e change di tutta l'organizzazione.
 *
 * Qui il permesso va ai ruoli che entrano nell'area di lavoro
 * (`workspace.use`): i ruoli di fabbrica admin, operator e viewer, e i ruoli
 * creati dall'organizzazione che hanno l'area di lavoro — la stessa gente che
 * oggi apre la pagina dell'assistente. `end_user` e i ruoli del solo portale no.
 * Da questo momento l'assistente legge solo quello che il ruolo può vedere.
 * Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'
import { PERMISSIONS } from '@opengraphity/types'

export const assistantPermission: Migration = {
  id: '20260928_1010_assistant_permission',
  description: "Permesso assistant.use ai ruoli con l'area di lavoro",
  async up(session) {
    const r = await session.run(`
      MATCH (r:Role) WHERE 'workspace.use' IN r.permissions AND NOT 'assistant.use' IN r.permissions
      SET r.permissions = [p IN $catalog WHERE p IN r.permissions OR p = 'assistant.use'], r.updated_at = $now
      RETURN collect(r.tenant_id + '/' + r.key) AS roles
    `, { catalog: [...PERMISSIONS], now: new Date().toISOString() })
    const roles = (r.records[0]?.get('roles') as string[] | undefined) ?? []
    console.log(`[${assistantPermission.id}] ${roles.length ? roles.join(', ') : 'nessun ruolo da aggiornare'}`)
  },
}
