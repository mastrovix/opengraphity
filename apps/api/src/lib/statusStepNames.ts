/**
 * I nomi di passo per CLASSE di stato, per chi non ha una sessione in mano
 * (servizi AI, job) — ondata 8 · B-22 / B-5.
 *
 * ## Il difetto
 * I servizi scrivevano le liste a mano: `NOT i.status IN ['closed','resolved']`
 * per gli incident «aperti», `NOT ch.status IN ['completed','closed',
 * 'cancelled','failed']` per le change «in corso». Metà di quei valori non è
 * mai prodotta da nessun workflow (`completed`, `cancelled`, `failed` non sono
 * passi della definizione change), e i passi veri del cliente non ci sono: un
 * passo terminale aggiunto dal disegnatore («Annullato») veniva contato come
 * **aperto**, e l'assistente elencava fra i ticket da lavorare cose concluse.
 * In silenzio, perché la risposta sembra sempre plausibile.
 *
 * ## La regola
 * Le classi (`open | in_progress | resolved | closed`) e la loro derivazione
 * dai metadata del passo sono già in `workflowHelpers` (`stepStatusClasses`,
 * `getStepNamesByClass`, ondata 2 · B0-3): qui c'è solo la comodità di
 * chiamarle con una sessione propria. Nessuna logica duplicata.
 */
import { getSession } from '@opengraphity/neo4j'
import { getStepNamesByClass, type TicketStatusClass } from './workflowHelpers.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'status-step-names' })

/** I nomi di passo di quelle classi, uniti e senza ripetizioni. */
export async function statusNamesForClasses(
  tenantId: string,
  entityType: string,
  classes: readonly TicketStatusClass[],
): Promise<string[]> {
  const session = getSession(undefined, 'READ')
  try {
    const byClass = await getStepNamesByClass(session, tenantId, entityType)
    return [...new Set(classes.flatMap((c) => byClass[c]))]
  } finally {
    await session.close()
  }
}

/**
 * I passi che **concludono** il ticket: risolti (categoria `resolved`) e chiusi
 * (terminali non risolti). È il complemento di «aperto», e si usa in negativo
 * (`NOT status IN $names`) proprio come prima: così un valore storico che non è
 * più un passo di nessuna definizione continua a contare come aperto, invece di
 * sparire dai conteggi.
 *
 * Elenco vuoto = il workflow del tenant non dichiara nessun passo conclusivo.
 * Qui non si fallisce (sono letture, non decisioni: fermare l'assistente non
 * aiuterebbe nessuno) ma lo si scrive nei log, perché la conseguenza — «tutti i
 * ticket risultano aperti» — altrimenti sembra un dato e non una configurazione
 * mancante.
 */
export async function concludedStatusNames(tenantId: string, entityType: string): Promise<string[]> {
  const names = await statusNamesForClasses(tenantId, entityType, ['resolved', 'closed'])
  if (names.length === 0) {
    log.warn({ tenantId, entityType }, 'Nessun passo conclusivo (categoria resolved o terminale) nel workflow: ogni ticket risulterà aperto')
  }
  return names
}
