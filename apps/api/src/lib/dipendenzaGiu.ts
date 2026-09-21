/**
 * UNA DIPENDENZA CHE CADE È UN CAMBIO DI STATO, NON UN EVENTO PER TENTATIVO
 * (21 set 2026).
 *
 * ## Da dove nasce: il primo rimedio trovato dal prodotto su sé stesso
 * L'Autoanalisi ha aperto `PRB00000002` su `opengrafo`, e il fascicolo
 * d'indagine indicava `module: 'bullmq'`. Il grep che il fascicolo stesso
 * scrive ha portato in un comando a `lib/bullmq.ts`, dove tre gestori
 * d'errore facevano tutti la stessa cosa:
 *
 *     q.on('error', (err) => { log.error({ err, queue: name }, '…') })
 *
 * Un `log.error` A OGNI TENTATIVO. ioredis riprova senza sosta, quindi un
 * guasto solo — una risoluzione DNS fallita — ha scritto 952 righe di errore
 * in un giorno su tre processi: 728 sull'api, 196 sull'events-worker, 28 sul
 * worker. Non erano 952 guasti. Era un guasto, ripetuto.
 *
 * E nessuno ha mai scritto QUANDO è tornato su: non c'era un gestore `ready`.
 *
 * ## Perché conta più di quanto sembri
 * Non è «loggare di meno». Quelle righe:
 *  - allagano l'archivio dei log, e l'Autoanalisi poi SPENDE GETTONI per
 *    analizzare il proprio rumore — le proposte di piattaforma aperte oggi
 *    sono esattamente quel rumore;
 *  - affogano gli altri errori, che in quel giorno nessuno ha più visto;
 *  - e, non dicendo mai «è rientrato», lasciano chi guarda senza la sola
 *    informazione che serve davvero durante un guasto.
 *
 * Il precedente sta nello stesso repository: `metamodelBus.ts` ha CINQUE
 * gestori e distingue «caduta», «sto riconnettendo», «pronto». `bullmq.ts` ne
 * aveva uno solo, per tre oggetti diversi.
 *
 * ## Quello che questo modulo NON fa
 * Non nasconde niente. La PRIMA caduta esce sempre a `error`, con l'errore
 * intero. Si tace solo la RIPETIZIONE della stessa caduta, e il conto delle
 * volte taciute viaggia dentro la riga di ripresa: chi legge sa sempre quante
 * sono state. Ogni `INTERVALLO_PROMEMORIA` esce comunque un promemoria, così
 * un guasto lungo non diventa silenzio.
 *
 * La causa sotto resta infrastrutturale: questo modulo la rende leggibile,
 * non la ripara.
 */
import type { Logger } from 'pino'

/** Ogni quanto ricordare che una dipendenza è ancora giù. */
export const INTERVALLO_PROMEMORIA = 60_000

interface Stato {
  /** Da quando è giù. `null` quando è su. */
  da: number | null
  /** Quante cadute sono state taciute da quando è giù. */
  taciute: number
  /** Quando è uscito l'ultimo promemoria. */
  ultimoPromemoria: number
}

/**
 * Il registro degli stati, per chiave.
 *
 * In memoria e per processo, ed è giusto: descrive quello che QUESTO processo
 * ha visto della sua connessione. Due repliche che perdono Redis lo dicono
 * tutte e due, perché sono due fatti diversi — e al riavvio il registro
 * riparte vuoto, che è corretto: un processo appena nato non ha ancora visto
 * cadere niente.
 */
const stati = new Map<string, Stato>()

/** Solo per i test: nessun chiamante in produzione. */
export function scordaGliStati(): void { stati.clear() }

function stato(chiave: string): Stato {
  let s = stati.get(chiave)
  if (!s) { s = { da: null, taciute: 0, ultimoPromemoria: 0 }; stati.set(chiave, s) }
  return s
}

/** È giù adesso? Serve alla diagnostica e ai test. */
export function eGiu(chiave: string): boolean {
  return stati.get(chiave)?.da != null
}

/**
 * Registra un guasto.
 *
 * La prima volta scrive a `error` con l'errore intero. Dalle volte successive
 * tace e conta, tranne un promemoria ogni `INTERVALLO_PROMEMORIA` che dice da
 * quanto dura e quante ne ha taciute.
 */
export function guastoDi(
  log: Logger, chiave: string, err: Error, campi: Record<string, unknown>,
  adesso: number = Date.now(),
): void {
  const s = stato(chiave)
  if (s.da == null) {
    s.da = adesso
    s.taciute = 0
    s.ultimoPromemoria = adesso
    log.error({ err, ...campi }, `[${chiave}] connection lost — retrying; further identical failures are counted, not logged, until it recovers`)
    return
  }
  s.taciute += 1
  if (adesso - s.ultimoPromemoria >= INTERVALLO_PROMEMORIA) {
    s.ultimoPromemoria = adesso
    log.error({ err, ...campi, secondi: Math.round((adesso - s.da) / 1000), taciute: s.taciute },
      `[${chiave}] STILL down — the failures in between were counted, not logged`)
  }
}

/**
 * Registra la ripresa.
 *
 * Se non era giù non scrive niente: `ready` arriva anche alla prima
 * connessione, e un prodotto che annuncia «rientrato» all'avvio, quando non
 * era mai caduto, insegna a non fidarsi di quella riga.
 */
export function ripresaDi(
  log: Logger, chiave: string, campi: Record<string, unknown>, adesso: number = Date.now(),
): void {
  const s = stati.get(chiave)
  if (!s || s.da == null) return
  const secondi = Math.round((adesso - s.da) / 1000)
  const taciute = s.taciute
  s.da = null
  s.taciute = 0
  log.warn({ ...campi, secondi, taciute },
    `[${chiave}] back up after ${String(secondi)}s — ${String(taciute)} repeated failures were counted and not logged`)
}
