import type { WatchQueryFetchPolicy } from '@apollo/client'

/**
 * LA POLITICA DI LETTURA PER IL DATO DEL CLIENTE (terza revisione).
 *
 * Le query che leggono la CONFIGURAZIONE — vocabolari, tipi CI e ITIL, matrici
 * di dominio, team, utenti, definizioni di workflow, visibilità e
 * obbligatorietà dei campi, policy degli allarmi — erano tutte
 * `fetchPolicy: 'cache-first'`. Ventisei posti.
 *
 * `cache-first` va bene per un dato che non cambia sotto di te. Ma il senso di
 * tutto questo programma è che quella roba **è del cliente e cambia mentre
 * l'app è aperta**, e quasi sempre da una pagina DIVERSA da quella che la
 * consuma: i team si creano in «Team e Utenti» e si leggono sulla scheda di un
 * CI; i vocabolari nel Dizionario e si leggono nei form; i workflow nel
 * disegnatore e si leggono nelle azioni delle regole. Un `refetchQueries` sulla
 * pagina che scrive non aiuta la pagina che legge.
 *
 * Trovato dal vivo: creato un team, aperta la scheda di un CI, e il menu dei
 * gruppi offriva solo il team che c'era al primo caricamento. Stessa forma del
 * difetto della matrice delle priorità, dove l'admin rinominava un valore e il
 * form «Crea incident» continuava a proporre quello vecchio, facendo rifiutare
 * ogni invio.
 *
 * `cache-and-network` serve subito il valore in cache — nessuno sfarfallio, la
 * pagina non aspetta la rete — e poi lo corregge. È il compromesso giusto per
 * un dato che è quasi sempre uguale e di tanto in tanto no.
 *
 * NON si usa per: `useMe` (l'utente della sessione non cambia sotto di te) e
 * per il dato di ENTITÀ (liste di incident, dettaglio di un servizio), che ha
 * le sue politiche e i suoi refetch.
 */
export const METAMODEL_FETCH_POLICY: WatchQueryFetchPolicy = 'cache-and-network'
