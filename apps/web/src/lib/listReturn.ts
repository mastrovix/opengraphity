/**
 * Tornare alla lista CON i filtri con cui ci si era arrivati
 * (revisione totale · G-EVT-13).
 *
 * Il «Indietro» di una scheda faceva `navigate('/events')` e buttava via la
 * query string: da `/events?stat=critical&page=3` si tornava alla prima pagina
 * senza filtri, e il lavoro di chi stava scorrendo una lista lunga era perso.
 * La lista mette il proprio `search` nello stato della navigazione; la scheda
 * lo rilegge. Chi apre la scheda da un link diretto (una notifica, un segnalibro)
 * non ha quello stato e torna alla lista pulita, che e la cosa giusta.
 */
import { useLocation, useNavigate } from 'react-router-dom'

/** Campo dello stato di navigazione con la query string della lista di partenza. */
export interface ListReturnState { listSearch?: string }

/** Da usare sulla LISTA: lo stato da passare a `navigate`/`<Link state>`. */
export function listReturnState(search: string): ListReturnState {
  return { listSearch: search }
}

/**
 * Da usare sulla SCHEDA: l'indirizzo della lista, con i filtri se li conosciamo.
 * `listPath` e il percorso senza query (es. `/events`).
 */
export function useListReturn(listPath: string): { to: string; goBack: () => void } {
  const navigate = useNavigate()
  const { state } = useLocation()
  const search = (state as ListReturnState | null)?.listSearch ?? ''
  const to = search ? `${listPath}${search}` : listPath
  return { to, goBack: () => navigate(to) }
}
