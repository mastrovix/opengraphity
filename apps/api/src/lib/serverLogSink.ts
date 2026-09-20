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
 * ## I DUE ARCHIVI, e perché sono due (20 set 2026, la sera)
 * Il proprietario ha chiesto: «in un tenant cliente, l'admin non può vedere
 * che errori si sono verificati?». La risposta era «sì, ma solo dall'ultimo
 * riavvio» — e per gli errori dei job di sfondo (SLA, consumer, notifiche)
 * nemmeno quello: nessun browser li vede e l'anello li perde. Per il cliente
 * non erano mai esistiti. È la stessa famiglia del difetto peggiore della
 * storia di questo prodotto: il motore SLA fermo per un giorno intero senza
 * che nessuno se ne accorgesse.
 *
 * Quindi una riga di errore che PORTA un tenant finisce in due posti, che
 * sono due cose diverse e non una copia:
 *
 *  - `:ServerLogEntry` — senza tenant, template scrubbato, aggregato per
 *    (firma, giorno). È la diagnostica della PIATTAFORMA, la legge solo
 *    l'identità di piattaforma, e fonde i clienti apposta.
 *  - `:LogEntry` col `tenant_id` — il messaggio VERO, una riga per
 *    occorrenza, dentro il perimetro di quel cliente e visibile solo a lui
 *    nella sua pagina Log. Qui non si scrubba niente, e il motivo è che non
 *    serve: sono i suoi dati, e un template («Variable <str> not defined»)
 *    non direbbe al suo amministratore quale ticket è andato storto.
 *
 * Si riusa `:LogEntry`, l'etichetta dei log del browser, invece di
 * inventarne una terza: è già per tenant, ha già l'indice, la retention la
 * copre già e la pagina Log la legge già. `module` distingue chi ha scritto
 * («frontend» il browser, il nome del modulo il server).
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

/** Una riga di errore di un cliente: il testo vero, per la sua pagina Log. */
export interface RigaDelCliente {
  tenantId:  string
  timestamp: string
  level:     string
  module:    string
  message:   string
  data:      string | null
}

/** Gli stessi tetti di `rest/client-logs.ts`: le due metà della pagina si somigliano. */
export const MAX_MESSAGGIO = 4_000
export const MAX_DATI      = 8_000

interface StatoInterno {
  inAttesa:    RigaDaScrivere[]
  inAttesaCliente: RigaDelCliente[]
  scartate:    number
  scritte:     number
  fallimenti:  number
  /** Righe di piattaforma buttate perché l'interruttore è spento. Vedi `consenso`. */
  senzaConsenso: number
  ultimoErrore: string | null
  ultimaLamentela: number
}

const stato: StatoInterno = {
  inAttesa: [], inAttesaCliente: [], scartate: 0, scritte: 0, fallimenti: 0, senzaConsenso: 0,
  ultimoErrore: null, ultimaLamentela: 0,
}

let timer: NodeJS.Timeout | null = null
/** Iniettato all'avvio: il sink non importa il driver, così `logger.ts` resta senza dipendenze pesanti. */
let scriviLotto: ((righe: RigaDaScrivere[], delCliente: RigaDelCliente[]) => Promise<number>) | null = null

/**
 * IL CONSENSO ALL'ARCHIVIO CHE ATTRAVERSA I CLIENTI (20 set 2026, rimedio a).
 *
 * `:ServerLogEntry` esiste per una cosa sola: l'Autoanalisi della
 * piattaforma. Quella funzione ha un interruttore, spento di fabbrica per
 * decisione del proprietario — ma la RACCOLTA girava comunque, per tutti i
 * clienti, compresi quelli che avevano spento tutto. Costruivamo l'archivio
 * che attraversa il perimetro anche quando nessuno aveva chiesto di poterlo
 * leggere: l'interruttore governava la lettura e non la scrittura, che è il
 * verso sbagliato.
 *
 * Il predicato è INIETTATO come lo scrittore, e per lo stesso motivo: qui
 * dentro non si importa il driver. È anche il motivo per cui l'assenza del
 * predicato vale «no»: uno script o un test che non ha dichiarato il
 * consenso non costruisce un archivio che attraversa i clienti.
 *
 * Le righe del singolo cliente (`:LogEntry`) NON passano da qui: sono i suoi
 * dati, restano in casa sua, e la sua pagina Log le deve avere comunque.
 */
let consenso: (() => Promise<boolean>) | null = null

/** Lo stato leggibile del sink: «funziona» deve essere una cosa che si può sapere. */
export function statoDelSink(): Readonly<Omit<StatoInterno, 'inAttesa' | 'inAttesaCliente' | 'ultimaLamentela'>> & { inAttesa: number } {
  return {
    inAttesa: stato.inAttesa.length + stato.inAttesaCliente.length,
    scartate: stato.scartate,
    scritte: stato.scritte,
    fallimenti: stato.fallimenti,
    senzaConsenso: stato.senzaConsenso,
    ultimoErrore: stato.ultimoErrore,
  }
}

/** Solo per i test: riporta il sink allo stato di partenza. */
export function azzeraSink(): void {
  stato.inAttesa = []
  stato.inAttesaCliente = []
  stato.scartate = 0; stato.scritte = 0; stato.fallimenti = 0; stato.senzaConsenso = 0
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

/** Taglia dichiarando il taglio, come `rest/client-logs.ts`. */
const TRONCATO = '… [troncato]'
function taglia(testo: string, max: number): string {
  return testo.length <= max ? testo : testo.slice(0, max - TRONCATO.length) + TRONCATO
}

/**
 * La riga per la pagina Log del cliente: il messaggio VERO, non il template.
 *
 * `null` quando la riga non è di nessun cliente — un avvio, una coda, il bus
 * del metamodello. Quelle restano diagnostica di piattaforma e non entrano in
 * casa di nessuno.
 */
export function rigaDelCliente(
  raw: Record<string, unknown>, livello: string, tenantId: string | null,
): RigaDelCliente | null {
  if (tenantId === null || tenantId === '') return null
  if (!LIVELLI_PERSISTITI.has(livello)) return null
  const module = typeof raw['module'] === 'string' ? raw['module'] : 'api'
  if (MODULI_ESCLUSI.has(module)) return null

  /*
   * I campi in più, meno quelli che pino mette su ogni riga: è la stessa
   * regola di `bufferLog`, così la riga persistita e quella in memoria hanno
   * lo stesso contenuto. Quello che la pagina mostrava e perdeva al riavvio,
   * adesso resta.
   */
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !SALTA_NEI_DATI.has(k)),
  )
  return {
    tenantId,
    timestamp: new Date(typeof raw['time'] === 'number' ? raw['time'] : Date.now()).toISOString(),
    level: livello,
    module,
    message: taglia(typeof raw['msg'] === 'string' ? raw['msg'] : '', MAX_MESSAGGIO),
    data: Object.keys(extra).length > 0 ? taglia(JSON.stringify(extra), MAX_DATI) : null,
  }
}

/** Gli stessi di `SKIP_KEYS` in `logger.ts`: pino li mette su ogni riga. */
const SALTA_NEI_DATI = new Set(['level', 'time', 'msg', 'module', 'pid', 'hostname', 'service', 'env'])

/**
 * Il punto d'ingresso, chiamato da `lib/logger.ts` per ogni riga.
 *
 * Non fa I/O e non può lanciare: una riga di log non deve mai far cadere il
 * gesto che l'ha prodotta.
 */
export function registraRigaDelServer(
  raw: Record<string, unknown>, livello: string, tenantId: string | null = null,
): void {
  try {
    const riga = rigaDaLog(raw, livello)
    if (riga) accoda(stato.inAttesa, riga)
    /*
     * Una riga di un cliente va in TUTT'E DUE: nella diagnostica di
     * piattaforma come template aggregato, e in casa sua col testo vero. Non
     * è una copia — sono due cose per due lettori diversi (vedi la testa del
     * file). E la piattaforma deve continuare a vedere anche gli errori nati
     * servendo un cliente, che sono la maggior parte.
     */
    const suo = rigaDelCliente(raw, livello, tenantId)
    if (suo) accoda(stato.inAttesaCliente, suo)
  } catch { /* una riga di log non rompe niente: vedi l'anello, in testa al file */ }
}

/** Accoda con il tetto: oltre, si scarta la più vecchia e la si conta. */
function accoda<T>(coda: T[], riga: T): void {
  if (coda.length >= MAX_IN_ATTESA) { coda.shift(); stato.scartate++ }
  coda.push(riga)
}

/**
 * IL NOME DEL «SERVIZIO» DEL BROWSER.
 *
 * Non è un processo nostro, ma nell'archivio di piattaforma occupa lo stesso
 * posto: una sorgente di errori con un CI censito a cui attaccarli
 * (`opengrafo-web`, migrazione `20261006_1010`). Così il connettore apre gli
 * incident dove vanno, senza sapere che questa sorgente è fatta di browser.
 */
export const SERVIZIO_DEL_BROWSER = 'opengrafo-web'

/**
 * UN ERRORE DEL BROWSER ENTRA NELLA DIAGNOSTICA DI PIATTAFORMA
 * (20 set 2026, sera tardi).
 *
 * Fino a stasera i log del browser erano scritti, da oggi anche letti da una
 * persona — ma nessun analista li guardava. Erano 1.230 righe, e dentro c'era
 * il segnale più vicino all'utente che abbiamo: «SSE notification channel
 * down — reconnecting», 1.074 volte. Nessuna pagina lo diceva.
 *
 * Il progetto li aveva esclusi con una ragione scritta: «li scrive chiunque
 * abbia un account del portale, senza rate limit». La seconda metà non è più
 * vera (ora la rotta ha un freno) e la prima pesa meno di quanto pesava: il
 * testo non fidato ha il suo recinto (`datiNonFidati`), e le proposte di
 * quest'area non portano azioni. Chi volesse avvelenare l'archivio sprecherebbe
 * gettoni per farsi rifiutare una proposta da una persona.
 *
 * Resta che il messaggio l'ha scritto un browser, quindi passa dallo STESSO
 * scrubbing del server: nell'archivio senza tenant non entra un messaggio
 * grezzo, mai, da nessuna sorgente.
 */
export function registraErroreDelBrowser(
  messaggio: string, livello: string, quando: string, stack?: unknown,
): void {
  try {
    if (!LIVELLI_PERSISTITI.has(livello)) return
    const { template } = normalizzaMessaggio(messaggio)
    if (template === '') return
    accoda(stato.inAttesa, {
      fingerprint: firmaDi({ service: SERVIZIO_DEL_BROWSER, module: 'frontend', level: livello, template }),
      day:       quando.slice(0, 10),
      timestamp: quando,
      service:   SERVIZIO_DEL_BROWSER,
      module:    'frontend',
      level:     livello,
      template,
      stackHead: primaRigaDiStack(stack),
    })
  } catch { /* un log non rompe niente */ }
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
  if (!scriviLotto) return
  if (stato.inAttesa.length === 0 && stato.inAttesaCliente.length === 0) return
  let lotto = stato.inAttesa
  const delCliente = stato.inAttesaCliente
  stato.inAttesa = []
  stato.inAttesaCliente = []
  /*
   * Il varco, chiesto UNA volta per lotto e non per riga: la risposta è
   * dietro una cache da 60 s e questo giro avviene ogni 10 s.
   *
   * Se la domanda non si può fare — database giù, tenant di piattaforma
   * assente — la risposta vale «no». Un archivio che attraversa il
   * perimetro fra i clienti si costruisce quando qualcuno ha detto di sì,
   * non quando non si è riusciti a chiedere.
   */
  if (lotto.length > 0) {
    let permesso = false
    try { permesso = consenso !== null && await consenso() } catch { permesso = false }
    if (!permesso) {
      stato.senzaConsenso += lotto.length
      lotto = []
    }
  }
  if (lotto.length === 0 && delCliente.length === 0) return
  try {
    stato.scritte += await scriviLotto(lotto, delCliente)
  } catch (e) {
    stato.fallimenti++
    // Le righe si perdono: rimetterle in coda farebbe crescere la memoria
    // mentre il database è giù, ed è il modo in cui un sink di log uccide il
    // processo che doveva osservare.
    stato.scartate += lotto.length + delCliente.length
    lamentati(`write failed, ${String(lotto.length + delCliente.length)} lines lost: ${e instanceof Error ? e.message : String(e)}`)
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
export function avviaSink(
  scrittore: (righe: RigaDaScrivere[], delCliente: RigaDelCliente[]) => Promise<number>,
  chiediIlConsenso: (() => Promise<boolean>) | null = null,
): void {
  scriviLotto = scrittore
  consenso = chiediIlConsenso
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
  consenso = null
}

/**
 * Le righe di un cliente: una per occorrenza.
 *
 * Non si aggrega per (firma, giorno) come l'archivio di piattaforma, ed è
 * deliberato: il suo amministratore vuole sapere che cosa è successo alle tre
 * di notte, non quante volte in tutto. La stessa forma dei log del browser,
 * così la pagina Log le legge senza sapere da dove vengono.
 */
export const LOTTO_CLIENTE_CYPHER = `
  UNWIND $righe AS r
  CREATE (l:LogEntry {
    id: randomUUID(), tenant_id: r.tenantId, timestamp: r.timestamp,
    level: r.level, module: r.module, message: r.message, data: r.data,
    created_at: r.timestamp
  })
  RETURN count(*) AS n
`

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
  const [{ getSession, toNumber }, { collegaSinkDeiLog }, { aiFeatureEnabled }, { TENANT_DI_PIATTAFORMA }] =
    await Promise.all([
      import('@opengraphity/neo4j'),
      import('./logger.js'),
      import('./aiSettings.js'),
      import('./serverLogEvents.js'),
    ])
  avviaSink(async (righe, delCliente) => {
    // Sessione di scrittura in auto-commit: il `MERGE` è una scrittura sola e
    // un fallimento qui non deve trascinarsi dietro una transazione aperta.
    const session = getSession(undefined, 'WRITE')
    try {
      let scritte = 0
      // Una alla volta sulla stessa sessione: due `run` insieme non si
      // possono (già visto in `persistedLogs.ts`).
      if (righe.length > 0) {
        const r = await session.run(LOTTO_CYPHER, { righe })
        scritte += toNumber(r.records[0]?.get('n') ?? 0)
      }
      if (delCliente.length > 0) {
        const r = await session.run(LOTTO_CLIENTE_CYPHER, { righe: delCliente })
        scritte += toNumber(r.records[0]?.get('n') ?? 0)
      }
      return scritte
    } finally {
      await session.close()
    }
  }, () => aiFeatureEnabled(TENANT_DI_PIATTAFORMA, 'platformSelfAnalysis'))
  collegaSinkDeiLog(registraRigaDelServer)
}

/** Lo spegnimento completo: stacca il logger e scrive quel che resta. */
export async function spegniSinkDeiLog(): Promise<void> {
  const { collegaSinkDeiLog } = await import('./logger.js')
  collegaSinkDeiLog(null)
  await fermaSink()
}
