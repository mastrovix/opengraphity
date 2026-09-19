/**
 * CHI SA CREARE UN COMPITO, registrato una volta per processo (20 set 2026).
 *
 * ## Perché un registro e non un callback nel contesto
 * Le altre azioni che toccano il grafo (`assign_to`, `update_field`,
 * `create_approval_request`) arrivano come callback dentro `ActionContext`,
 * cioè le fornisce **chi chiama la transizione**. Ci sono quattordici
 * chiamanti di `workflowEngine.transition` e cinque punti che costruiscono un
 * `ActionContext`: tre di quei cinque lo costruiscono POVERO, con il solo
 * `userId` e nessun callback (`approval.ts`, i cammini delle change). Su quei
 * cammini un'azione che ha bisogno di un callback fallisce, e la transizione
 * riesce lo stesso perché il motore raccoglie gli errori delle azioni invece
 * di annullare il passaggio.
 *
 * Per i compiti sarebbe il difetto peggiore possibile: il caso principale è
 * «richiesta approvata → partono i compiti», e l'approvazione è proprio uno
 * dei cammini poveri. Il ticket avanzerebbe **senza** i suoi compiti, e
 * nessuno se ne accorgerebbe finché non manca il lavoro.
 *
 * Saper scrivere un compito non è una proprietà di chi chiama: è una
 * proprietà dell'installazione, come saper valutare una condizione. Le
 * condizioni infatti funzionano già così — `registerCondition`, registrate
 * all'import da `apps/api/src/workflow/conditions.ts`, valide per ogni
 * cammino. Questo registro è la stessa cosa per la creazione dei compiti: si
 * registra una volta e vale dappertutto.
 */

/** Quello che serve per scrivere un compito; il resto lo sa il registrato. */
export interface TaskToCreate {
  tenantId:   string
  /** Il ticket a cui appendere il compito. */
  entityId:   string
  /** Il tipo del ticket: il compito lo EREDITA, non lo sceglie (regola d'integrità). */
  entityType: string
  /** Il passo che lo sta creando: la guardia saprà quali compiti bloccano quale passo. */
  stepName:   string
  /** La posizione dell'azione nel passo: entra nella chiave naturale contro i doppioni. */
  actionIndex: number
  title:       string
  description: string | null
  teamId:      string | null
  dueInDays:   number | null
  createdBy:   string
}

export type TaskCreator = (task: TaskToCreate) => Promise<string>

let creatore: TaskCreator | null = null

/**
 * Dichiara chi scrive i compiti. Da chiamare all'avvio del processo, accanto
 * alla registrazione delle condizioni.
 */
export function registerTaskCreator(fn: TaskCreator): void {
  creatore = fn
}

/** Chi scrive i compiti in questo processo, o `null` se nessuno l'ha detto. */
export function currentTaskCreator(): TaskCreator | null {
  return creatore
}

/** Solo per i test: dimentica il registrato. */
export function clearTaskCreator(): void {
  creatore = null
}
