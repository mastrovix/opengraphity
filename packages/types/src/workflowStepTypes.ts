/**
 * QUELLO CHE IL MOTORE SA ESEGUIRE (revisione AI, ondata 10).
 *
 * ## Il difetto
 * Il disegnatore offriva nella palette «Biforcazione», «Ricongiunzione» e
 * «Sotto-workflow». Il motore non ne conosce nessuno: entrando in un passo
 * `parallel_fork` seguiva UNA transizione come da un passo normale. Chi
 * disegnava una biforcazione — la valutazione tecnica e quella funzionale che
 * partono insieme — otteneva un processo sequenziale che ne faceva una sola,
 * senza un errore, senza una riga di log, senza niente. La più brutta delle
 * forme di difetto: l'interfaccia promette e il motore tace.
 *
 * `timer_wait` invece è implementato per davvero (`engine.ts` schedula il job
 * e grida se il passo non ha un ritardo o non ha una transizione automatica),
 * e resta nella palette.
 *
 * ## La regola
 * Un tipo di passo si può disegnare solo se il motore lo esegue. Qui c'è
 * l'elenco, uno solo per le tre sponde — motore, API in scrittura e
 * disegnatore —, e i tipi non implementati sono scritti accanto con il motivo
 * invece che cancellati: il giorno in cui il motore imparerà la biforcazione
 * si sposta una riga, e nel frattempo nessuno li riscrive per sbaglio
 * credendoli una dimenticanza.
 *
 * Verificato prima di togliere: su questa installazione nessun passo di
 * nessun workflow è di uno dei tre tipi (`MATCH (s:WorkflowStep) RETURN
 * s.type, count(*)` → standard 159, end 50, start 37).
 */

/** I tipi che il motore esegue. `start`/`end` li mette il prodotto, non la palette. */
export const RUNNABLE_STEP_TYPES = ['start', 'standard', 'end', 'timer_wait'] as const

/** Quelli che il disegnatore può AGGIUNGERE a un processo. */
export const ADDABLE_STEP_TYPES = ['standard', 'timer_wait'] as const

/**
 * Disegnabili ieri, mai eseguiti: restano nel tipo perché un'installazione
 * potrebbe averli salvati, e perché il nome dice cosa manca.
 */
export const UNIMPLEMENTED_STEP_TYPES = ['parallel_fork', 'parallel_join', 'sub_workflow'] as const

export type WorkflowStepType =
  | (typeof RUNNABLE_STEP_TYPES)[number]
  | (typeof UNIMPLEMENTED_STEP_TYPES)[number]

export function isUnimplementedStepType(type: string): boolean {
  return (UNIMPLEMENTED_STEP_TYPES as readonly string[]).includes(type)
}
