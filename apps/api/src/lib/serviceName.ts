/**
 * Come si chiama QUESTO processo nei log.
 *
 * ## Il difetto (ondata 5)
 * `lib/logger.ts` scriveva `service: "opengrafo-api"` in `base`, e i processi
 * worker usano la stessa immagine e lo stesso logger: nei log di Loki i tre
 * processi — API, worker degli embedding, worker degli allarmi e dei servizi —
 * erano indistinguibili. Cercare «cosa ha fatto l'ingest degli allarmi» voleva
 * dire leggere i log di tutti e tre e indovinare dal contenuto.
 *
 * ## Come si decide
 * L'entrypoint: `dist/index.js` è l'API, `dist/worker.js` è un worker. Fra i
 * worker distingue `WORKER_PROFILE`, che la compose già imposta (`events` per
 * `events-worker`, `all` per `worker`). Niente variabili nuove da aggiungere al
 * deploy, e nessun ripiego muto: un entrypoint che non riconosciamo si chiama
 * col proprio nome di file, così nei log si vede **cosa** è e non un'etichetta
 * sbagliata.
 */
import { basename } from 'node:path'

/** I nomi che i log possono portare. Sono le tre righe della compose. */
export const API_SERVICE_NAME    = 'opengrafo-api'
export const WORKER_SERVICE_NAME = 'opengrafo-worker'
export const EVENTS_WORKER_SERVICE_NAME = 'opengrafo-events-worker'

/**
 * `entrypoint` è `process.argv[1]` (il file che Node ha avviato) e
 * `workerProfile` il valore di `WORKER_PROFILE`. Entrambi espliciti, così la
 * funzione è verificabile senza avviare un processo.
 */
export function serviceNameFor(entrypoint: string | undefined, workerProfile: string): string {
  const file = basename(entrypoint ?? '').replace(/\.[cm]?[jt]s$/, '')
  if (file === 'index' || file === 'server') return API_SERVICE_NAME
  if (file === 'worker') {
    return workerProfile === 'events' ? EVENTS_WORKER_SERVICE_NAME : WORKER_SERVICE_NAME
  }
  // Un altro entrypoint (uno script operativo, un test, `tsx` su un file
  // qualunque): si nomina per quello che è.
  return file ? `opengrafo-${file}` : API_SERVICE_NAME
}
