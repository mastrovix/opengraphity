/**
 * I TRE PERMESSI DELLE PROPOSTE DI MIGLIORAMENTO (20 set 2026).
 *
 * I ruoli di un cliente sono nodi nel grafo, scritti quando il tenant è nato:
 * un permesso aggiunto al catalogo oggi non arriva da solo a chi esiste già.
 * Senza questa migrazione la pagina risponde «Accesso negato» anche
 * all'amministratore — verificato dal vivo su `c-test` prima di scriverla.
 *
 * ## A chi vanno, e perché non a tutti allo stesso modo
 * `proposal.read` e `proposal.run` vanno a **tutti i ruoli di lavoro**: sono
 * gesti che non scrivono niente — leggere le proposte e far girare l'analisi.
 *
 * `proposal.accept` va **solo all'amministratore**, ed è una conseguenza
 * diretta della decisione del proprietario: accettare basta il permesso della
 * proposta, senza chiedere anche quello dell'azione sottostante. Chi accetta,
 * quindi, fa eseguire qualunque voce del catalogo chiuso. Dare quel potere a
 * un operatore per default sarebbe una scalata di privilegio regalata; un
 * ruolo su misura può sempre darglielo, ma allora è una decisione di chi lo
 * configura, scritta e visibile nell'editor dei ruoli.
 *
 * Idempotente: alla seconda esecuzione nessun ruolo è «senza».
 */
import type { Migration } from '@opengraphity/neo4j'
import { PERMISSIONS } from '@opengraphity/types'

/** Il filtro sul catalogo tiene l'ordine e butta i permessi che non esistono più. */
const SET_PERMESSI = (aggiunti: readonly string[]) =>
  `r.permissions = [p IN $catalog WHERE p IN r.permissions OR p IN ${JSON.stringify(aggiunti)}]`

export const proposalPermissions: Migration = {
  id: '20261005_1140_proposal_permissions',
  description: 'proposal.read/run to every workspace role, proposal.accept to admins only',

  async up(session) {
    const now = new Date().toISOString()
    const catalog = [...PERMISSIONS]

    const lettura = await session.run(`
      MATCH (r:Role)
      WHERE 'workspace.use' IN r.permissions
        AND NOT ('proposal.read' IN r.permissions AND 'proposal.run' IN r.permissions)
      SET ${SET_PERMESSI(['proposal.read', 'proposal.run'])}, r.updated_at = $now
      RETURN collect(r.tenant_id + '/' + r.key) AS roles
    `, { catalog, now })
    const conLettura = (lettura.records[0]?.get('roles') as string[] | undefined) ?? []

    /*
     * Solo i ruoli di fabbrica `admin`. Non «chi ha config.metamodel»: un
     * ruolo su misura che tocca il metamodello non per questo deve poter far
     * eseguire automazioni e articoli KB.
     */
    const accettazione = await session.run(`
      MATCH (r:Role {key: 'admin'})
      WHERE NOT 'proposal.accept' IN r.permissions
      SET ${SET_PERMESSI(['proposal.accept'])}, r.updated_at = $now
      RETURN collect(r.tenant_id + '/' + r.key) AS roles
    `, { catalog, now })
    const conAccettazione = (accettazione.records[0]?.get('roles') as string[] | undefined) ?? []

    console.log(
      `[${proposalPermissions.id}] lettura+analisi: ${conLettura.length ? conLettura.join(', ') : 'nessun ruolo da aggiornare'}`,
    )
    console.log(
      `[${proposalPermissions.id}] accettazione (solo admin): ${conAccettazione.length ? conAccettazione.join(', ') : 'nessun ruolo da aggiornare'}`,
    )
  },
}
