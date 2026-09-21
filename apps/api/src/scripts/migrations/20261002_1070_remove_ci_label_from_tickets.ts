/**
 * H-16: togliere `:ConfigurationItem` dai nodi dei tipi ITIL.
 *
 * La migrazione `20260908_1010_ci_configuration_item_label` aggiunge
 * `:ConfigurationItem` a ogni nodo la cui label e registrata in
 * `CITypeDefinition.neo4j_label`. Nella sua PRIMA versione non escludeva
 * `scope = 'itil'`, e i tipi ITIL (`Incident`, `Problem`, `Change`,
 * `ServiceRequest`, `KBArticle`) hanno una `neo4j_label`: su un database
 * migrato l'8 settembre i ticket hanno preso la label dei CI. Il filtro
 * `scope <> 'itil'` e arrivato dopo — modificando una migrazione GIA APPLICATA,
 * contro la regola dichiarata in `migrations/index.ts` e in OPERATIONS §3 — e
 * nessuna migrazione toglieva la label ai nodi gia etichettati.
 *
 * Cosa causa una label di troppo:
 *  - `global_search` copre `ConfigurationItem`: i ticket tornano due volte;
 *  - la migrazione `1210` raccoglie gli `status` dei `ConfigurationItem` come
 *    «stati del ciclo di vita dei CI» e ci mette dentro quelli degli incident;
 *  - i vincoli e gli indici generici dei CI valgono su nodi che non sono CI.
 *
 * Verificato dal vivo prima di scriverla: su questo database **0** nodi ITIL
 * con `:ConfigurationItem` (le migrazioni sono state applicate con il filtro
 * gia corretto). Vale per un database migrato prima del fix, e `migrate
 * --status` mostrava solo un «drift» informativo che nessuno traduceva in
 * un'azione.
 *
 * Solo i tipi `scope = 'itil'`: un tipo del CLIENTE che si chiami «Incident»
 * non esiste (il nome e riservato, `lib/metamodelNames.ts`), e comunque qui si
 * guarda lo scope, non il nome.
 *
 * Idempotente: filtra sui nodi che hanno ancora la label.
 */
import type { Migration } from '@opengraphity/neo4j'

export const removeCiLabelFromTickets: Migration = {
  id: '20261002_1070_remove_ci_label_from_tickets',
  description: 'H-16: remove :ConfigurationItem from nodes of ITIL types (the first version of 20260908_1010 added it)',
  autocommit: true,
  async up(session) {
    const res = await session.run(`
      MATCH (t:CITypeDefinition)
      WHERE t.scope = 'itil' AND t.neo4j_label IS NOT NULL AND t.neo4j_label <> ''
      WITH collect(DISTINCT t.neo4j_label) AS itilLabels
      CALL {
        WITH itilLabels
        MATCH (n:ConfigurationItem)
        WHERE any(l IN labels(n) WHERE l IN itilLabels)
        REMOVE n:ConfigurationItem
        RETURN count(*) AS removed
      } IN TRANSACTIONS OF 5000 ROWS
      RETURN sum(removed) AS removed`)
    const n = Number(res.records[0]?.get('removed') ?? 0)
    console.log(`[${removeCiLabelFromTickets.id}] :ConfigurationItem tolta da ${n} nodi di tipi ITIL`)
  },
}
