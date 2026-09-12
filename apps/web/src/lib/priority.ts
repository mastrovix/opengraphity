/**
 * La priorità **dalla matrice del cliente**, non da una copia nel codice
 * (revisione delle otto ondate · C·N-3).
 *
 * ## Com'era
 * Questo file conteneva una matrice 3×3 scritta a mano, la sua inversa, la
 * mappa `critical → P1` e le etichette italiane dei tre valori. Era lo specchio
 * della matrice del server del 2025 — e l'ondata 7 ha reso quella matrice
 * **dato del cliente**, modificabile da Impostazioni → Matrici di dominio.
 * Conseguenze misurate nella revisione:
 *
 *  1. un cliente che rinomina `impact`/`urgency` vede nel form i **tre bottoni
 *     vecchi**, e ogni invio viene rifiutato dal server (`assertDomainValue`):
 *     il form più usato del prodotto diventa inutilizzabile, e non c'è modo di
 *     aggiustarlo dall'interfaccia;
 *  2. un admin che corregge la matrice dalla pagina continua a vedere nel form
 *     la «Priorità (calcolata)» della matrice **di fabbrica** — un numero
 *     diverso da quello che il server salverà, senza un avviso;
 *  3. `priorityCode` mostrava `P?` a chi aveva rinominato i valori di
 *     `priority`.
 *
 * Nella stessa pagina la *categoria* veniva già da `useEnumValues`: la strada
 * giusta esisteva e non era stata usata per impatto e urgenza.
 *
 * ## Com'è
 * Nessuna tabella qui: funzioni pure che operano sulla matrice che il server
 * manda (`usePriorityMatrix`, che legge `domainMatrices`). Il codice P1…P4 si
 * ricava dalla **posizione** nel vocabolario `priority`, che è una scala
 * ordinata dal più basso al più alto: con i quattro valori di fabbrica dà
 * esattamente P1…P4 come prima, e con i valori rinominati continua a funzionare.
 */

/** Una cella della matrice come la manda il server. */
export interface MatrixCell {
  key:    string
  inputs: string[]
  value:  string | null
}

/** La matrice della priorità, come la manda `domainMatrices`. */
export interface PriorityMatrix {
  /** I valori di `impact` del cliente, dal più basso al più alto. */
  impacts:    string[]
  /** I valori di `urgency` del cliente. */
  urgencies:  string[]
  /** I valori di `priority` del cliente, dal più basso al più alto. */
  priorities: string[]
  cells:      MatrixCell[]
}

/** La chiave di una cella: gli ingressi uniti da `|`, nell'ordine della matrice. */
export function matrixKey(...values: readonly string[]): string {
  return values.join('|')
}

/**
 * La priorità per questa coppia, o `null` se la matrice del cliente non copre
 * la combinazione — che è un'informazione, non un errore da nascondere con un
 * valore inventato: la pagina mostra «da compilare» e il server rifiuterebbe
 * comunque il salvataggio dicendo quale cella manca.
 */
export function derivePriority(matrix: PriorityMatrix | null, impact: string, urgency: string): string | null {
  if (!matrix || impact === '' || urgency === '') return null
  return matrix.cells.find((c) => c.key === matrixKey(impact, urgency))?.value ?? null
}

/**
 * L'inverso: da una priorità alla coppia (impatto, urgenza) che la produce.
 * Serve a chi arriva con la sola priorità (una richiesta di servizio, un link
 * da un'altra pagina) e deve precompilare il form.
 *
 * Più celle possono dare la stessa priorità. La scelta è la stessa del server
 * (`lib/priority.ts` dell'API): prima la cella con **tutti gli ingressi uguali**
 * fra loro — la lettura più neutra — poi la prima nell'ordine della matrice.
 * Così le due parti non divergono.
 */
export function impactUrgencyFromPriority(
  matrix: PriorityMatrix | null, priority: string,
): { impact: string; urgency: string } | null {
  if (!matrix) return null
  const candidates = matrix.cells.filter((c) => c.value === priority)
  if (candidates.length === 0) return null
  const chosen = candidates.find((c) => c.inputs.every((v) => v === c.inputs[0])) ?? candidates[0]!
  const [impact, urgency] = chosen.inputs
  return impact !== undefined && urgency !== undefined ? { impact, urgency } : null
}

/**
 * `P1`…`Pn` dalla **posizione** nel vocabolario delle priorità: l'ultimo valore
 * (il più alto) è `P1`. Con i quattro valori di fabbrica —
 * `low, medium, high, critical` — dà `P4, P3, P2, P1`, esattamente la mappa
 * scritta a mano di prima; con i valori del cliente continua a funzionare.
 *
 * Una priorità che il vocabolario non contiene resta visibile come `P?`: è un
 * dato incoerente (un ticket con una priorità che il Dizionario non ha più) e
 * nasconderlo dietro un numero plausibile sarebbe peggio.
 */
export function priorityCode(priorities: readonly string[], priority: string): string {
  const i = priorities.indexOf(priority)
  return i === -1 ? 'P?' : `P${String(priorities.length - i)}`
}
