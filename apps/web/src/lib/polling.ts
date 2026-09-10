/**
 * Polling di `useQuery` in pausa quando la scheda non è visibile.
 *
 *   useQuery(GET_X, { ...pausedWhenHidden(15_000), fetchPolicy: 'cache-and-network' })
 *
 * Apollo (≥ 3.8) chiama `skipPollAttempt` a ogni tick: se torna true il tick
 * salta e il timer prosegue, così N schede aperte in background non fanno
 * N × richieste al minuto. Al ritorno in primo piano il tick successivo
 * riparte normalmente (al più `pollInterval` dopo). Lo smontaggio ferma il
 * polling da solo: qui non c'è nessun `setInterval` manuale.
 */
export interface PausedPolling {
  pollInterval:    number
  skipPollAttempt: () => boolean
}

/** Il tick è saltato quando il documento è nascosto (`document.hidden`). */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

export function pausedWhenHidden(pollInterval: number): PausedPolling {
  if (!Number.isFinite(pollInterval) || pollInterval <= 0) {
    throw new Error(`pausedWhenHidden: pollInterval non valido (${pollInterval})`)
  }
  return { pollInterval, skipPollAttempt: isDocumentHidden }
}
