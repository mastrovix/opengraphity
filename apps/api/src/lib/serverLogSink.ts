/**
 * IL SINK PERSISTENTE DEI LOG DEL SERVER (20 set 2026, ondata 3).
 *
 * Fino a oggi i log del server vivevano in `lib/logBuffer.ts`: un anello in
 * memoria da 2.000 righe, perso a ogni riavvio. I 269.110 `:LogEntry` su
 * `system` che sembravano un archivio erano un FOSSILE — ultima riga 8 aprile
 * 2026, scritta da un percorso che nel codice non esiste più. L'area D del
 * programma («il prodotto guarda sé stesso») partiva da zero.
 *
 * ## Le tre decisioni, e il prezzo di ognuna
 *
 * **1. Si persiste solo `error` e `fatal`.** Il fossile dice perché: delle
 * 269.110 righe, 171.206 erano `info`/`http` e 60.270 `warn`/`auth` — il 86%
 * di un archivio che nessuno ha mai letto. Le righe informative servono a
 * seguire una richiesta, e per quello c'è già lo stdout che Promtail manda a
 * Loki. Qui si conserva ciò su cui il prodotto deve aprire un incident su sé
 * stesso. Il prezzo: un guasto che si manifesta solo come `warn` non produce
 * un evento. È una scelta, non una dimenticanza — `LIVELLI_PERSISTITI` è una
 * riga sola da cambiare.
 *
 * **2. Un nodo per (firma, giorno), non per occorrenza.** Il fossile ha
 * insegnato anche questo: 9.883 errori erano lo STESSO bug di validazione del
 * 26 marzo, contato due volte per giunta. Un nodo per occorrenza è un archivio
 * che cresce col rumore e che va letto con un `GROUP BY` per dire qualunque
 * cosa. Un nodo per (firma, giorno) risponde da solo alle due domande che
 * contano — «quante volte» e «su quanti giorni distinti» — ed è quest'ultima
 * che separa un bug chiuso da un guasto che dura.
 *
 * **3. Nessun `tenant_id` sul nodo.** Il progetto dichiara l'allowlist della
 * proiezione: timestamp, livello, modulo, template, prima riga di stack. Il
 * tenant non c'è, e non lo aggiungo di mia iniziativa: sapere QUALI clienti
 * ha colpito un errore è esattamente l'attraversamento di perimetro che il
 * progetto dice di non fare senza una posizione contrattuale. Il prezzo,
 * detto: da qui non si distingue un guasto sistemico da uno che tocca un
 * cliente solo. L'incident si apre comunque, perché si apre sul CI della
 * piattaforma, non su quello di un cliente.
 *
 * ## L'anello: il sink non deve poter parlare di sé stesso
 * Se la scrittura su Neo4j fallisse e il fallimento venisse loggato con
 * `logger`, quella riga rientrerebbe nel sink, che riproverebbe, che
 * fallirebbe. Qui dentro non si chiama MAI `logger`: gli errori si contano e,
 * al massimo una volta ogni `SILENZIO_MS`, si scrivono su `process.stderr` a
 * mano. Il contatore è leggibile (`statoDelSink()`), così «il sink è rotto»
 * resta una cosa che si può sapere.
 */
import { normalizzaMessaggio, primaRigaDiStack, firmaDi } from './serverLogScrub.js'

/** I livelli che finiscono nel grafo. Vedi decisione 1 in testa al file. */
export const LIVELLI_PERSISTITI: ReadonlySet<string> = new Set(['error', 'fatal'])

/**
 * I moduli che il sink non guarda, per non parlare di sé stesso.
 *
 * `server-log-sink` è il sink; `server-log-events` è il connettore che legge
 * quello che il sink ha scritto e ne fa eventi. Se uno dei due fallisse in
 * modo rumoroso, senza questa esclusione il suo errore diventerebbe un
 * evento, che aprirebbe un incident, che al prossimo giro sarebbe di nuovo
 * un errore.
 */
export const MODULI_ESCLUSI: ReadonlySet<string> = new Set(['server-log-sink', 'server-log-events'])

/** Quante righe si tengono in attesa prima di scrivere. Oltre, si scarta la più vecchia. */
export const MAX_IN_ATTESA = 500
/** Ogni quanto si svuota la coda. */
export const INTERVALLO_MS = 10_000
/** Quanto silenzio fra due lamentele su stderr, perché un guasto non diventi un diluvio. */
const SILENZIO_MS = 60_000

export interface RigaDaScrivere {
  fingerprint: string
  day:         string
  timestamp:   string
  service:     string
  module:      string
  level:       string
  template:    string
  stackHead:   string | null
}

interface StatoInterno {
  inAttesa:    RigaDaScrivere[]
  scartate:    number
  scritte:     number
  fallimenti:  number
  ultimoErrore: string | null
  ultimaLamentela: number
}

const stato: StatoInterno = {
  inAttesa: [], scartate: 0, scritte: 0, fallimenti: 0, ultimoErrore: null, ultimaLamentela: 0,
}

let timer: NodeJS.Timeout | null = null
/** Iniettato all'avvio: il sink non importa il driver, così `logger.ts` resta senza dipendenze pesanti. */
let scriviLotto: ((righe: RigaDaScrivere[]) => Promise<number>) | null = null

/** Lo stato leggibile del sink: «funziona» deve essere una cosa che si può sapere. */
export function statoDelSink(): Readonly<Omit<StatoInterno, 'inAttesa' | 'ultimaLamentela'>> & { inAttesa: number } {
  return {
    inAttesa: stato.inAttesa.length,
    scartate: stato.scartate,
    scritte: stato.scritte,
    fallimenti: stato.fallimenti,
    ultimoErrore: stato.ultimoErrore,
  }
}

/** Solo per i test: riporta il sink allo stato di partenza. */
export function azzeraSink(): void {
  stato.inAttesa = []
  stato.scartate = 0; stato.scritte = 0; stato.fallimenti = 0
  stato.ultimoErrore = null; stato.ultimaLamentela = 0
}

/**
 * Trasforma una riga grezza di pino in una riga da scrivere, oppure `null` se
 * non ci interessa. Pura ed esportata: è ciò che i test guardano.
 *
 * `raw` è l'oggetto che pino serializza, quindi porta `service` ed `env` che
 * `bufferLog` invece scarta (`SKIP_KEYS`).
 */
export function rigaDaLog(raw: Record<string, unknown>, livello: string): RigaDaScrivere | null {
  if (!LIVELLI_PERSISTITI.has(livello)) return null
  const module = typeof raw['module'] === 'string' ? raw['module'] : 'api'
  if (MODULI_ESCLUSI.has(module)) return null

  const service = typeof raw['service'] === 'string' ? raw['service'] : 'opengrafo-api'
  const quando  = new Date(typeof raw['time'] === 'number' ? raw['time'] : Date.now())
  const { template } = normalizzaMessaggio(typeof raw['msg'] === 'string' ? raw['msg'] : '')
  /*
   * Lo stack sta dove pino lo mette quando gli si passa un Error: `err.stack`.
   * Si guarda anche `stack` nudo, perché diversi punti del codice loggano
   * `{ stack: e.stack }` a mano.
   */
  const err = raw['err']
  const stackGrezzo = (err && typeof err === 'object' && 'stack' in err)
    ? (err as { stack?: unknown }).stack
    : raw['stack']

  return {
    fingerprint: firmaDi({ service, module, level: livello, template }),
    day:         quando.toISOString().slice(0, 10),
    timestamp:   quando.toISOString(),
    service, module, level: livello, template,
    stackHead:   primaRigaDiStack(stackGrezzo),
  }
}

/**
 * Il punto d'ingresso, chiamato da `lib/logger.ts` per ogni riga.
 *
 * Non fa I/O e non può lanciare: una riga di log non deve mai far cadere il
 * gesto che l'ha prodotta.
 */
export function registraRigaDelServer(raw: Record<string, unknown>, livello: string): void {
  try {
    const riga = rigaDaLog(raw, livello)
    if (!riga) return
    if (stato.inAttesa.length >= MAX_IN_ATTESA) {
      stato.inAttesa.shift()
      stato.scartate++
    }
    stato.inAttesa.push(riga)
  } catch { /* una riga di log non rompe niente: vedi l'anello, in testa al file */ }
}

/** La lamentela di chi non può usare il logger. Al massimo una al minuto. */
function lamentati(messaggio: string): void {
  stato.ultimoErrore = messaggio
  const ora = Date.now()
  if (ora - stato.ultimaLamentela < SILENZIO_MS) return
  stato.ultimaLamentela = ora
  process.stderr.write(`[server-log-sink] ${messaggio}\n`)
}

/** Svuota la coda. Esportata perché i test e l'arresto la chiamino a mano. */
export async function svuota(): Promise<void> {
  if (stato.inAttesa.length === 0 || !scriviLotto) return
  const lotto = stato.inAttesa
  stato.inAttesa = []
  try {
    stato.scritte += await scriviLotto(lotto)
  } catch (e) {
    stato.fallimenti++
    // Le righe si perdono: rimetterle in coda farebbe crescere la memoria
    // mentre il database è giù, ed è il modo in cui un sink di log uccide il
    // processo che doveva osservare.
    stato.scartate += lotto.length
    lamentati(`write failed, ${String(lotto.length)} lines lost: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * La query del lotto: un nodo per (firma, giorno).
 *
 * `day` è la chiave insieme alla firma, quindi lo stesso errore ripetuto
 * cento volte in un giorno è un nodo con `count = 100`, e su venti giorni
 * sono venti nodi — che è esattamente la domanda che il connettore fa.
 */
export const LOTTO_CYPHER = `
  UNWIND $righe AS r
  MERGE (l:ServerLogEntry {fingerprint: r.fingerprint, day: r.day})
    ON CREATE SET
      l.id = randomUUID(), l.first_at = r.timestamp, l.count = 0,
      l.service = r.service, l.module = r.module, l.level = r.level,
      l.template = r.template, l.stack_head = r.stackHead
  SET l.count = l.count + 1,
      l.last_at = CASE WHEN l.last_at IS NULL OR r.timestamp > l.last_at THEN r.timestamp ELSE l.last_at END
  RETURN count(*) AS n
`

/**
 * Accende il sink. `scrittore` fa l'I/O: lo passa `index.ts`, così questo
 * modulo non importa il driver e `logger.ts` può importarlo senza cicli.
 */
export function avviaSink(scrittore: (righe: RigaDaScrivere[]) => Promise<number>): void {
  scriviLotto = scrittore
  if (timer) return
  timer = setInterval(() => { void svuota() }, INTERVALLO_MS)
  // Il timer non deve tenere in vita il processo: un'uscita pulita passa da `fermaSink`.
  timer.unref?.()
}

/** Spegne il sink scrivendo quello che resta: le ultime righe prima di un riavvio sono le più interessanti. */
export async function fermaSink(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null }
  await svuota()
  scriviLotto = null
}

/**
 * Accende il sink con lo scrittore vero e lo collega al logger.
 *
 * La chiamano i due entrypoint (`index.ts` e `worker.ts`): i log del worker
 * sono la metà dei log del prodotto, e un guasto delle code non sarebbe
 * arrivato nel grafo se il sink vivesse solo nell'API.
 *
 * Il `try/finally` sulla sessione e il `catch` che NON logga sono la stessa
 * regola dell'anello: qui dentro un errore si conta, non si racconta.
 */
export async function accendiSinkDeiLog(): Promise<void> {
  const [{ getSession, toNumber }, { collegaSinkDeiLog }] = await Promise.all([
    import('@opengraphity/neo4j'),
    import('./logger.js'),
  ])
  avviaSink(async (righe) => {
    // Sessione di scrittura in auto-commit: il `MERGE` è una scrittura sola e
    // un fallimento qui non deve trascinarsi dietro una transazione aperta.
    const session = getSession(undefined, 'WRITE')
    try {
      const r = await session.run(LOTTO_CYPHER, { righe })
      return toNumber(r.records[0]?.get('n') ?? 0)
    } finally {
      await session.close()
    }
  })
  collegaSinkDeiLog(registraRigaDelServer)
}

/** Lo spegnimento completo: stacca il logger e scrive quel che resta. */
export async function spegniSinkDeiLog(): Promise<void> {
  const { collegaSinkDeiLog } = await import('./logger.js')
  collegaSinkDeiLog(null)
  await fermaSink()
}
