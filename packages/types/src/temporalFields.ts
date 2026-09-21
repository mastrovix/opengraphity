/**
 * «QUESTO CAMPO È UNA DATA?» — una domanda sola, una risposta sola.
 *
 * Serve al costruttore di report: un PERIODO (giorno, settimana, mese) si può
 * chiedere soltanto su una data. Chiederlo su «Stato» produce
 * `date.truncate('day', datetime(n.status))`, e Neo4j risponde «Text cannot be
 * parsed to a DateTime "completed"» — a esecuzione, cioè quando il report è
 * già salvato, magari schedulato, e chi lo ha costruito non c'è più.
 *
 * La domanda si faceva in due posti con due elenchi scritti a mano che già
 * divergevano, e sul server non si faceva affatto. Da qui in avanti la fa
 * questa funzione: il browser per decidere se OFFRIRE il periodo, l'API per
 * RIFIUTARLO.
 *
 * Due sorgenti, in quest'ordine:
 *  - il tipo dichiarato nel metamodello (`date` / `datetime`), che è la
 *    verità quando c'è — compresi i campi che il cliente ha creato lui;
 *  - il NOME, per i campi che il prodotto spedisce e che il metamodello ITIL
 *    non tipizza: `created_at` di un incident non ha un `field_type`, ed è
 *    una data da sempre.
 */

/** I tipi di campo che portano un istante o un giorno. */
export const TEMPORAL_FIELD_TYPES: readonly string[] = ['date', 'datetime']

/**
 * I campi del PRODOTTO che sono date senza che il metamodello lo dichiari.
 * Tutto ciò che finisce per `_at` è già coperto dalla regola sotto: qui
 * stanno solo quelli con un altro nome.
 */
export const SHIPPED_TEMPORAL_FIELD_NAMES: readonly string[] = [
  'due_date',
  'scheduled_start',
  'scheduled_end',
  'window_start',
  'window_end',
  'valid_from',
  'valid_to',
]

/**
 * Vero se su questo campo ha senso chiedere un periodo.
 *
 * @param name      nome della proprietà in snake_case, come lo usa il Cypher
 * @param fieldType tipo dichiarato dal metamodello, se c'è
 */
export function isTemporalField(name: string, fieldType?: string | null): boolean {
  if (fieldType != null && TEMPORAL_FIELD_TYPES.includes(fieldType)) return true
  if (name.endsWith('_at')) return true
  return SHIPPED_TEMPORAL_FIELD_NAMES.includes(name)
}
