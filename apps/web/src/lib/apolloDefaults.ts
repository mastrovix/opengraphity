/**
 * OGNI PAGINA SI RIVALIDA QUANDO SI APRE.
 *
 * Con la politica di Apollo di fabbrica (`cache-first`) una pagina già vista
 * mostrava la cache e basta: il dettaglio di un problem risolto dalla sua
 * change, riaperto navigando nell'app, diceva ancora «Known Error» e non
 * mostrava la change collegata — nel database era già risolto (giro del
 * 14 set 2026). `cache-and-network` mostra subito la cache e la aggiorna con
 * la risposta del server; `nextFetchPolicy: 'cache-first'` evita che ogni
 * nuovo render della stessa pagina rifaccia la richiesta.
 */
import type { ApolloClient } from '@apollo/client'

export const APOLLO_DEFAULT_OPTIONS: ApolloClient.DefaultOptions = {
  watchQuery: { fetchPolicy: 'cache-and-network', nextFetchPolicy: 'cache-first' },
}
