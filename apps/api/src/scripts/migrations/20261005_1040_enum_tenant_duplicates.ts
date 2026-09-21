/**
 * I DOPPIONI SENZA INFORMAZIONE: le copie di un vocabolario spedito che non
 * dicono niente di diverso (17 set 2026).
 *
 * ## Come sono nate
 * Fino al 12 settembre `seedEnumTypes` scriveva una COPIA dei vocabolari
 * spediti **per ogni tenant** (`is_system = true`). Dal 13 settembre il
 * modello è un nodo solo su `tenant_id = 'system'`, e la copia del tenant
 * nasce quando qualcuno preme «Personalizza». La migrazione `20260913_1300` ha
 * lasciato quelle vecchie di proposito: potevano contenere personalizzazioni,
 * e cancellarle al buio le avrebbe perse.
 *
 * Il conto, dal vivo: su `c-one` sedici copie, e **nove identiche** al nodo
 * spedito.
 *
 * ## Perché una copia identica non è innocua
 * Una copia del tenant VINCE in lettura sul nodo spedito
 * (`loadTenantEnumOverrides`). Quindi una copia identica:
 *
 *  - **scherma dagli aggiornamenti del prodotto**: un valore nuovo spedito
 *    domani non arriva a quel tenant, gli arriva come «deriva» da accettare a
 *    mano, mentre un tenant nato oggi ce l'ha subito;
 *  - fa divergere l'interfaccia fra due clienti per nessun motivo: lo stesso
 *    vocabolario è modificabile in un tenant e in sola lettura nell'altro, ed è
 *    esattamente la domanda che ha aperto questo lavoro.
 *
 * ## Cosa si cancella, e cosa NON si cancella
 * Solo una copia che è identica allo spedito in **tutto**: valori, etichette
 * per valore, colori per valore, valore predefinito, nome visibile, scope — e
 * che non ha **nessuna relazione**. Qualunque differenza è una scelta di un
 * cliente e resta.
 *
 * Il confronto largo sarebbe stato un disastro silenzioso: su `c-one`
 * `ci_status`, `priority` e `severity` hanno gli stessi valori e le stesse
 * etichette dello spedito, e **colori diversi**. Guardando solo i valori
 * avrei cancellato tre personalizzazioni vere.
 *
 * Restano quindi, e con un motivo leggibile in un log: `status_change` e
 * `status_incident` (valori diversi — sono i nomi dei passi del workflow, che
 * quel cliente ha personalizzato), `ci_status`/`priority`/`severity` (colori),
 * `os` (nome visibile), `status` (nessuno spedito con quel nome: è suo).
 *
 * Idempotente: alla seconda esecuzione non c'è più nessun doppione identico.
 */
import type { Migration } from '@opengraphity/neo4j'

export const enumTenantDuplicates: Migration = {
  id: '20261005_1040_enum_tenant_duplicates',
  description: 'Remove tenant copies of shipped vocabularies that are identical to the shipped node and unreferenced',

  async up(session) {
    /*
     * Prima si GUARDA, poi si cancella, e le due query sono la stessa
     * condizione: il log dice cosa è stato toccato e con quale nome, perché di
     * una cancellazione di dati di un cliente si deve poter rispondere «questi,
     * e nessun altro» anche sei mesi dopo.
     */
    const candidati = await session.run(`
      MATCH (c:EnumTypeDefinition)
      WHERE c.tenant_id <> 'system'
      MATCH (s:EnumTypeDefinition {tenant_id: 'system', name: c.name})
      WHERE c.values = s.values
        AND coalesce(c.value_labels,  '') = coalesce(s.value_labels,  '')
        AND coalesce(c.value_colors,  '') = coalesce(s.value_colors,  '')
        AND coalesce(c.default_value, '') = coalesce(s.default_value, '')
        AND coalesce(c.label,         '') = coalesce(s.label,         '')
        AND coalesce(c.scope,         '') = coalesce(s.scope,         '')
        AND NOT (c)--()
      RETURN c.id AS id, c.tenant_id AS tenantId, c.name AS name
      ORDER BY tenantId, name
    `)

    if (candidati.records.length === 0) {
      console.log(`[${enumTenantDuplicates.id}] nothing to remove: no identical tenant copy of a shipped vocabulary`)
      return
    }

    const perTenant = new Map<string, string[]>()
    for (const rec of candidati.records) {
      const tenantId = rec.get('tenantId') as string
      const elenco = perTenant.get(tenantId) ?? []
      elenco.push(rec.get('name') as string)
      perTenant.set(tenantId, elenco)
    }

    const ids = candidati.records.map((r) => r.get('id') as string)
    /*
     * `DELETE` e non `DETACH DELETE`: la condizione pretende zero relazioni, e
     * se una ne comparisse fra la lettura e la scrittura Neo4j deve FERMARSI —
     * `DETACH` la staccherebbe in silenzio, che su un vocabolario vuol dire
     * togliere i valori a un campo senza dirlo a nessuno.
     */
    const esito = await session.run(`
      MATCH (c:EnumTypeDefinition) WHERE c.id IN $ids
      DELETE c
      RETURN count(*) AS cancellati
    `, { ids })

    const cancellati = Number(esito.records[0]?.get('cancellati') ?? 0)
    const dettaglio = [...perTenant.entries()]
      .map(([tenantId, nomi]) => `${tenantId}: ${nomi.join(', ')}`)
      .join(' · ')

    console.log(
      `[${enumTenantDuplicates.id}] removed ${cancellati} identical tenant cop${cancellati === 1 ? 'y' : 'ies'} ` +
      `of shipped vocabularies — ${dettaglio}. Any copy that differs in values, labels, colors, default, ` +
      'visible name or scope was left untouched.',
    )
  },
}
