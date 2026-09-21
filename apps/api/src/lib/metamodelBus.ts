/**
 * Il canale del metamodello fra i processi (A-16, ondata 5).
 *
 * ## Il difetto
 * `invalidateSchema(tenantId)` agiva solo sul processo che aveva servito la
 * mutation. `worker` e `events-worker` sono processi separati, con la loro
 * copia delle cache, e non venivano mai avvisati; due repliche dell'API
 * nemmeno. Una relazione appena definita nel disegnatore veniva rifiutata da
 * un'altra replica con «Invalid relation type» fino alla scadenza del TTL
 * (300 s), e lo schema di un tenant restava vecchio per 5 minuti.
 *
 * ## Il canale
 * Un canale Redis `og:metamodel.changed` con `{tenantId, version, origin}`:
 *  - **pubblica** `invalidateSchema` attraverso il publisher registrato qui,
 *    dopo aver svuotato le cache locali;
 *  - **riceve** ogni processo che ha chiamato `startMetamodelBus()`, e
 *    svuota le SUE cache di quel tenant (`clearLocalMetamodelCaches`, che non
 *    ripubblica: nessun rimbalzo).
 *
 * `version` è un `INCR` su `og:metamodel:version:<tenant>`: monotona per
 * tenant, serve a scartare un messaggio arrivato fuori ordine o due volte.
 * `origin` è l'identità di questo processo: il messaggio che torna a chi l'ha
 * pubblicato viene ignorato (ha già svuotato in modo sincrono).
 *
 * ## Connessioni
 * La configurazione è quella condivisa (`getRedisConnection()` di
 * `@opengraphity/events`, unico parser di REDIS_URL/REDIS_PASSWORD): nessuna
 * variabile nuova. Per **pubblicare** si usa il client condiviso
 * `getSharedRedis()` di `lib/bullmq.ts`. Per **ricevere** serve invece una
 * connessione dedicata: un client ioredis in modalità `subscribe` rifiuta ogni
 * altro comando, e quello condiviso serve a INCR/PUBLISH e ai lock. È l'unica
 * connessione in più, ed è obbligata dal protocollo.
 *
 * ## Niente canale muto
 * Un canale che tace senza che nessuno se ne accorga sarebbe il difetto di
 * prima con un nome nuovo. Perciò:
 *  - `PUBLISH` restituisce quanti processi hanno ricevuto: **zero** è un
 *    `warn` esplicito (nessuno in ascolto → le altre repliche restano vecchie);
 *  - una sottoscrizione fallita è un `error` e viene **riprovata** ogni
 *    `RESUBSCRIBE_DELAY_MS` finché non riesce;
 *  - disconnessione, riconnessione e ri-sottoscrizione sono loggate;
 *  - `metamodelBusStatus()` dice in ogni momento se il processo è sottoscritto.
 *
 * ## La ripresa dopo una caduta (PRB00000003)
 * La caduta della connessione di ascolto è un guasto di trasporto: ioredis
 * riconnette, la sottoscrizione si rimette, e fin qui non c'è niente da
 * riparare nel codice. Quello che mancava è la REAZIONE. Il pub/sub di Redis
 * non ha arretrato: i messaggi pubblicati mentre questo processo era staccato
 * sono perduti per sempre, e con loro l'elenco dei tenant cambiati. Rimettere
 * `metamodel_bus_subscribed = 1` e scrivere «in ascolto sul canale» faceva
 * sembrare la ripresa un avvio pulito mentre il processo teneva cache che
 * nessuno gli avrebbe più detto di svuotare, fino al TTL (5 minuti lo schema).
 * Perciò una ri-sottoscrizione DOPO una perdita svuota tutte le cache
 * (`clearAllMetamodelCaches()`), lo dice in un `warn` e lo conta in
 * `metamodel_resubscribe_flush_total`. La prima sottoscrizione no: lì non c'è
 * niente da recuperare.
 *
 * ## Le metriche (ondata 8)
 * I log dicono tutto questo a chi li legge; Prometheus lo sorveglia da sé:
 * `metamodel_published_total{result}` (delivered | no_receivers | error),
 * `metamodel_received_total{result}` (applied | stale | malformed),
 * `metamodel_cache_clear_failures_total{cache}`,
 * `metamodel_bus_subscribed` (0 = questo processo non verrà avvisato) e
 * `metamodel_resubscribe_flush_total` (quante finestre di messaggi perduti).
 * Le regole d'allarme stanno in `infra/prometheus/`, e cosa guardare in
 * `docs/OPERATIONS.md`.
 */
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { getRedisConnection } from '@opengraphity/events'
import { getSharedRedis } from './bullmq.js'
import { logger } from './logger.js'
import {
  metamodelPublishedTotal, metamodelReceivedTotal, metamodelCacheClearFailuresTotal, metamodelBusSubscribed,
  metamodelResubscribeFlushTotal,
} from '../middleware/metrics.js'
import {
  clearAllMetamodelCaches,
  clearLocalMetamodelCaches,
  registerMetamodelPublisher,
  registeredMetamodelCacheClearers,
  type LocalInvalidation,
} from './schemaInvalidator.js'
// Import a effetto: caricare questi due moduli (foglie, nessuna dipendenza
// pesante) registra i loro clearer, così il canale sa già all'avvio che
// svuoterà la cache in memoria e la mappa delle label — invece di dipendere
// da chi è stato importato prima. `schemaCache` e `reportWhitelist` si
// registrano da sé quando il processo li carica: dove non ci sono, non c'è
// niente da svuotare.
import './cache.js'
import './ciTypeFromLabels.js'

const log = logger.child({ module: 'metamodel-bus' })

/** Il canale. Un nome solo, condiviso da publisher e subscriber. */
export const METAMODEL_CHANNEL = 'og:metamodel.changed'

/** Chiave del contatore di versione del metamodello di un tenant. */
export function metamodelVersionKey(tenantId: string): string {
  return `og:metamodel:version:${tenantId}`
}

/** Identità di questo processo: serve a ignorare il proprio messaggio. */
export const BUS_ORIGIN = randomUUID()

/** Attesa fra due tentativi di sottoscrizione. */
export const RESUBSCRIBE_DELAY_MS = 5_000

export interface MetamodelChange {
  tenantId: string
  version:  number
  origin:   string
}

function isMetamodelChange(v: unknown): v is MetamodelChange {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['tenantId'] === 'string' && o['tenantId'] !== ''
    && typeof o['version'] === 'number' && Number.isFinite(o['version'])
    && typeof o['origin'] === 'string' && o['origin'] !== ''
}

// ── Pubblicazione ────────────────────────────────────────────────────────────

/**
 * Pubblica il cambiamento. Non attende e non lancia: la mutation che l'ha
 * chiamata ha già scritto su Neo4j, e un Redis giù non deve trasformarsi in un
 * errore verso l'utente — deve trasformarsi in una riga di log che dice che le
 * altre repliche resteranno vecchie fino alla scadenza del TTL.
 */
export function publishMetamodelChange(tenantId: string, local?: LocalInvalidation): void {
  void doPublish(tenantId, local)
}

async function doPublish(tenantId: string, local?: LocalInvalidation): Promise<void> {
  try {
    const redis = getSharedRedis()
    const version = await redis.incr(metamodelVersionKey(tenantId))
    const payload: MetamodelChange = { tenantId, version, origin: BUS_ORIGIN }
    const receivers = await redis.publish(METAMODEL_CHANNEL, JSON.stringify(payload))
    const fields = { tenantId, version, receivers, cleared: local?.cleared ?? [], failed: local?.failed ?? [] }
    metamodelPublishedTotal.inc({ result: receivers === 0 ? 'no_receivers' : 'delivered' })
    if (receivers === 0) {
      log.warn(fields,
        '[metamodel] nessun processo in ascolto sul canale: le cache degli altri processi (worker, altre repliche) resteranno vecchie fino alla scadenza del loro TTL (60 s le cache del metamodello, 5 min lo schema)')
    } else {
      log.info(fields, '[metamodel] cambiamento pubblicato: gli altri processi svuoteranno le loro cache di questo tenant')
    }
  } catch (err) {
    metamodelPublishedTotal.inc({ result: 'error' })
    log.error({ err, tenantId, channel: METAMODEL_CHANNEL },
      '[metamodel] pubblicazione fallita: solo QUESTO processo ha svuotato le sue cache; le altre repliche restano vecchie fino alla scadenza del loro TTL (60 s le cache del metamodello, 5 min lo schema)')
  }
}

// ── Ricezione ────────────────────────────────────────────────────────────────

let subscriber: Redis | null = null
let subscribed = false
/**
 * Vero da quando questo processo è stato sottoscritto almeno una volta
 * (PRB00000003). Distingue la PRIMA sottoscrizione — niente da recuperare,
 * le cache sono vuote — da una RI-sottoscrizione, che arriva sempre dopo una
 * finestra di messaggi perduti.
 */
let everSubscribed = false
let retryTimer: NodeJS.Timeout | null = null
/** Ultima versione applicata per tenant: scarta i doppioni e i fuori ordine. */
const lastAppliedVersion = new Map<string, number>()

export interface MetamodelBusStatus {
  running:    boolean
  subscribed: boolean
  channel:    string
  origin:     string
  /** Le cache che questo processo svuoterebbe ricevendo un messaggio. */
  clearers:   string[]
}

export function metamodelBusStatus(): MetamodelBusStatus {
  return {
    running:    subscriber !== null,
    subscribed,
    channel:    METAMODEL_CHANNEL,
    origin:     BUS_ORIGIN,
    clearers:   registeredMetamodelCacheClearers(),
  }
}

/**
 * Avvia il canale in questo processo: registra il publisher (così
 * `invalidateSchema` pubblica) e apre la sottoscrizione. Idempotente.
 */
export function startMetamodelBus(): void {
  if (subscriber) return
  registerMetamodelPublisher(publishMetamodelChange)

  subscriber = new Redis({
    ...getRedisConnection(),
    // Un subscriber non ha richieste da abbandonare: deve solo riconnettersi
    // per sempre. `null` disattiva il limite di tentativi per comando.
    maxRetriesPerRequest: null,
  })

  subscriber.on('error', (err: Error) => {
    log.error({ err, channel: METAMODEL_CHANNEL },
      '[metamodel] errore della connessione di ascolto — ioredis riconnette; finché non è sottoscritto questo processo NON viene avvisato dei cambiamenti')
  })
  subscriber.on('close', () => {
    subscribed = false
    metamodelBusSubscribed.set({}, 0)
    log.warn({ channel: METAMODEL_CHANNEL },
      '[metamodel] connessione di ascolto chiusa: sottoscrizione persa, in attesa di riconnessione')
  })
  subscriber.on('reconnecting', () => {
    subscribed = false
    metamodelBusSubscribed.set({}, 0)
    log.warn({ channel: METAMODEL_CHANNEL }, '[metamodel] riconnessione della connessione di ascolto in corso')
  })
  // ioredis ri-sottoscrive da sé dopo una riconnessione; ri-emettere SUBSCRIBE
  // è idempotente in Redis e ci dà la conferma (o l'errore) nel log.
  subscriber.on('ready', () => { void subscribeNow() })
  subscriber.on('message', (channel: string, raw: string) => { onMessage(channel, raw) })

  void subscribeNow()
}

async function subscribeNow(): Promise<void> {
  const s = subscriber
  if (!s) return
  try {
    await s.subscribe(METAMODEL_CHANNEL)
    // Sottoscritti ora, ma già sottoscritti prima: in mezzo c'è stata una
    // finestra senza ascolto, e quello che è passato in quella finestra non
    // tornerà (PRB00000003). Si legge PRIMA di rimettere `subscribed` a vero.
    const dopoUnaPerdita = everSubscribed && !subscribed
    subscribed = true
    everSubscribed = true
    metamodelBusSubscribed.set({}, 1)
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    log.info({ channel: METAMODEL_CHANNEL, origin: BUS_ORIGIN, clearers: registeredMetamodelCacheClearers() },
      '[metamodel] in ascolto sul canale: le cache di questo processo verranno svuotate quando il metamodello cambia altrove (`clearers` = quelle registrate finora; i moduli caricati più tardi si aggiungono da sé)')
    if (dopoUnaPerdita) recuperaInvalidazioniPerdute()
  } catch (err) {
    subscribed = false
    metamodelBusSubscribed.set({}, 0)
    log.error({ err, channel: METAMODEL_CHANNEL, retryInMs: RESUBSCRIBE_DELAY_MS },
      '[metamodel] sottoscrizione FALLITA: questo processo non verrà avvisato dei cambiamenti del metamodello — riprovo')
    scheduleRetry()
  }
}

/**
 * La ripresa dopo una sottoscrizione persa (PRB00000003).
 *
 * Il pub/sub di Redis non ha arretrato: i messaggi pubblicati mentre questo
 * processo era staccato sono stati consegnati a chi ascoltava in quel momento
 * e buttati per gli altri. Nessuno li riconsegnerà, e non c'è modo di sapere
 * quali tenant fossero cambiati — la sottoscrizione rimessa a posto sembrava
 * quindi un avvio pulito mentre il processo teneva cache che nessuno gli
 * avrebbe più detto di svuotare, fino alla scadenza del TTL (5 minuti lo
 * schema): esattamente il difetto per cui questo canale esiste.
 *
 * Quindi si butta tutto. Ricaricare cache ancora buone costa qualche query
 * subito dopo una riconnessione; servire un metamodello vecchio costa un
 * «Invalid relation type» a un utente che ha appena definito quella relazione.
 */
function recuperaInvalidazioniPerdute(): void {
  const all = clearAllMetamodelCaches()
  metamodelResubscribeFlushTotal.inc({})
  for (const f of all.failed) metamodelCacheClearFailuresTotal.inc({ cache: f.name })
  log.warn({
    channel: METAMODEL_CHANNEL,
    cleared: all.cleared,
    failed: all.failed,
    withoutClearAll: all.withoutClearAll,
  },
  '[metamodel] ri-sottoscritto dopo una perdita di ascolto: i messaggi passati in quella finestra sono perduti (il pub/sub di Redis non ha arretrato) e non si sa quali tenant siano cambiati, quindi le cache di questo processo sono state svuotate per intero — `withoutClearAll` elenca quelle che non sanno svuotarsi del tutto e restano vecchie fino al loro TTL')
}

function scheduleRetry(): void {
  if (retryTimer || !subscriber) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void subscribeNow()
  }, RESUBSCRIBE_DELAY_MS)
  // Un timer di ritentativo non deve tenere in vita il processo.
  retryTimer.unref?.()
}

function onMessage(channel: string, raw: string): void {
  if (channel !== METAMODEL_CHANNEL) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    metamodelReceivedTotal.inc({ result: 'malformed' })
    log.error({ err, channel }, '[metamodel] messaggio non è JSON: ignorato (le cache di questo processo NON sono state svuotate)')
    return
  }
  if (!isMetamodelChange(parsed)) {
    metamodelReceivedTotal.inc({ result: 'malformed' })
    log.error({ channel, keys: typeof parsed === 'object' && parsed ? Object.keys(parsed) : typeof parsed },
      '[metamodel] messaggio malformato (attesi tenantId, version, origin): ignorato')
    return
  }
  // Il proprio messaggio: le cache locali sono già state svuotate in modo
  // sincrono da invalidateSchema.
  if (parsed.origin === BUS_ORIGIN) return

  const seen = lastAppliedVersion.get(parsed.tenantId)
  if (seen !== undefined && parsed.version === seen) {
    metamodelReceivedTotal.inc({ result: 'stale' })
    log.debug({ tenantId: parsed.tenantId, version: parsed.version, seen },
      '[metamodel] messaggio già applicato: ignorato')
    return
  }
  // Versione PIÙ BASSA di quella vista: il contatore è ripartito da capo
  // (revisione delle otto ondate · D·#2). `version` è un `INCR` su una chiave
  // Redis: un riavvio senza persistenza, o un `FLUSHALL` durante un incidente,
  // la riporta a 1 — e il ricevitore, che ha in memoria «ho già applicato la
  // 7», scartava TUTTO fino alla 8. L'invalidazione fra processi si spegneva in
  // silenzio, con un log a `debug` e un contatore senza allarme.
  //
  // Un contatore che torna indietro non è un messaggio vecchio: è un contatore
  // nuovo. Si applica e si riparte da lì, dicendolo.
  if (seen !== undefined && parsed.version < seen) {
    log.warn({ tenantId: parsed.tenantId, version: parsed.version, seen },
      '[metamodel] il contatore di versione è ripartito da capo (Redis riavviato o svuotato): ' +
      'riparto da questa versione invece di scartare i messaggi — altrimenti l\'invalidazione fra processi ' +
      'resterebbe spenta fino al superamento della versione vecchia')
  }
  lastAppliedVersion.set(parsed.tenantId, parsed.version)

  const local = clearLocalMetamodelCaches(parsed.tenantId)
  metamodelReceivedTotal.inc({ result: 'applied' })
  for (const f of local.failed) metamodelCacheClearFailuresTotal.inc({ cache: f.name })
  log.info({ tenantId: parsed.tenantId, version: parsed.version, cleared: local.cleared, failed: local.failed },
    '[metamodel] cambiato in un altro processo: cache locali di questo tenant svuotate')
}

/** Chiude il canale (spegnimento ordinato). Idempotente. */
export async function stopMetamodelBus(): Promise<void> {
  registerMetamodelPublisher(null)
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  const s = subscriber
  subscriber = null
  subscribed = false
  // Spegnimento ordinato, non una perdita: chi riavvia il canale riparte da
  // cache che verranno ricostruite comunque, e non deve svuotare niente.
  everSubscribed = false
  metamodelBusSubscribed.set({}, 0)
  lastAppliedVersion.clear()
  if (!s) return
  try {
    await s.quit()
  } catch (err) {
    log.error({ err }, '[metamodel] chiusura della connessione di ascolto fallita')
    s.disconnect()
  }
}
