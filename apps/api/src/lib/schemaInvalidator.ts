/**
 * Il punto unico dell'invalidazione del metamodello (A-16, ondata 5).
 *
 * ## Com'era
 * Questo modulo teneva UNA funzione registrata da `schemaCache.ts`, e
 * `invalidateSchema(tenantId)` cancellava la voce della cache degli schemi
 * **del processo che aveva servito la mutation**. Tutto il resto restava
 * vecchio: la whitelist dei report (60 s), i tipi di relazione ammessi
 * (`allowed_rel_types`, 300 s), la mappa label → tipo, e soprattutto le cache
 * **degli altri processi** — `worker` e `events-worker` sono processi separati
 * con la loro copia, e due repliche dell'API pure. Risultato visibile: una
 * relazione appena definita nel disegnatore veniva rifiutata da un'altra
 * replica con «Invalid relation type» per cinque minuti.
 *
 * ## Com'è
 * Due registri, nessun import statico (questo modulo sta in mezzo a un ciclo:
 * `schemaCache` → `resolvers/index` → `dynamic-ci` → `schemaCache`, e deve
 * restare una foglia):
 *
 *  - **i clearer**: ogni modulo che tiene una cache derivata dal metamodello
 *    si registra da sé al proprio caricamento (`schemaCache` attraverso
 *    `registerSchemaInvalidator`, `reportWhitelist`, `cache`,
 *    `ciTypeFromLabels`, e tutte quelle costruite con
 *    `lib/metamodelCache.ts` — vocabolari, matrici di dominio, tipi di change
 *    pre-approvati, etichette e metamodello dei CI). Un processo svuota quello
 *    che ha: un modulo mai caricato non ha niente da svuotare.
 *  - **il publisher**: `lib/metamodelBus.ts` lo registra all'avvio del
 *    processo e porta il cambiamento sul canale Redis, così le altre repliche
 *    svuotano le **loro** cache. Il ricevitore chiama
 *    `clearLocalMetamodelCaches` (che NON pubblica): nessun rimbalzo.
 *
 * `invalidateSchema(tenantId)` resta la firma che chiama tutto il resto del
 * codice: è lei a svuotare le cache locali e a pubblicare. Chi scrive
 * metamodello **deve** chiamarla — `ciTypeMetamodel.ts`, `itilTypeResolvers.ts`,
 * `enumType.ts`, il resolver delle matrici, `lib/changePolicy.ts` — e il lint
 * statico `graphql/__tests__/metamodelInvalidation.test.ts` lo verifica: la
 * revisione delle otto ondate ha misurato che le mutation dei vocabolari, delle
 * matrici e dei tipi pre-approvati non la chiamavano (0 messaggi sul canale),
 * quindi dopo una rinomina nel Dizionario lo stesso processo rifiutava il
 * valore nuovo e accettava quello rimosso.
 *
 * E le cache hanno **tutte** una scadenza (60 s quelle del metamodello, 5 min
 * lo schema): il canale è la via normale, il TTL è la rete per quando tace.
 *
 * Niente silenzi: un clearer che lancia non ferma gli altri ed è raccolto in
 * `failed`; se nessun publisher è registrato (processo senza bus, script,
 * test) `invalidateSchema` lo dice a chi lo osserva attraverso
 * `lastInvalidation()` e il bus lo logga — un canale muto di cui nessuno si
 * accorge sarebbe il difetto di prima con un nome nuovo.
 */

/** Svuota la cache di UN tenant. Deve essere sincrona e non lanciare (se lancia, viene raccolto). */
export type MetamodelCacheClearer = (tenantId: string) => void

/**
 * Porta il cambiamento agli altri processi. Riceve anche l'esito locale, così
 * il bus scrive UNA riga di log con tutto: cosa è stato svuotato qui, cosa ha
 * fallito, e quanti processi hanno ricevuto il messaggio. Non deve lanciare né
 * attendere.
 */
export type MetamodelPublisher = (tenantId: string, local: LocalInvalidation) => void

const clearers = new Map<string, MetamodelCacheClearer>()
let publisher: MetamodelPublisher | null = null

/** Esito dello svuotamento delle cache di questo processo. */
export interface LocalInvalidation {
  tenantId: string
  /** Nomi delle cache svuotate, nell'ordine di registrazione. */
  cleared:  string[]
  /** Clearer che hanno lanciato: non fermano gli altri e non restano nascosti. */
  failed:   { name: string; error: string }[]
}

/** Esito dell'ultima invalidazione: lo leggono la diagnostica e i test. */
export interface InvalidationOutcome extends LocalInvalidation {
  published: boolean
}

let last: InvalidationOutcome | null = null

/**
 * Registra una cache da svuotare quando il metamodello di un tenant cambia.
 * Idempotente per `name`: due caricamenti dello stesso modulo non registrano
 * due clearer.
 */
export function registerMetamodelCacheClearer(name: string, clear: MetamodelCacheClearer): void {
  clearers.set(name, clear)
}

/**
 * Compatibilità: `schemaCache.ts` chiama questa al proprio caricamento. È il
 * clearer di nome `schema` — uno dei tanti, non più l'unico.
 */
export function registerSchemaInvalidator(fn: MetamodelCacheClearer): void {
  registerMetamodelCacheClearer('schema', fn)
}

/** I nomi delle cache registrate in QUESTO processo (log di avvio del bus, test). */
export function registeredMetamodelCacheClearers(): string[] {
  return [...clearers.keys()]
}

/** Registra (o rimuove, con `null`) il canale verso gli altri processi. */
export function registerMetamodelPublisher(fn: MetamodelPublisher | null): void {
  publisher = fn
}

/** Vero quando un canale verso gli altri processi è attivo in questo processo. */
export function hasMetamodelPublisher(): boolean {
  return publisher !== null
}

/**
 * Svuota le cache di QUESTO processo per `tenantId`, senza pubblicare niente.
 * La chiamano `invalidateSchema` (che poi pubblica) e il ricevitore del canale
 * (che non deve pubblicare, altrimenti i messaggi rimbalzano).
 */
export function clearLocalMetamodelCaches(tenantId: string): LocalInvalidation {
  const cleared: string[] = []
  const failed: { name: string; error: string }[] = []
  for (const [name, clear] of clearers) {
    try {
      clear(tenantId)
      cleared.push(name)
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (failed.length > 0) {
    // Import differito: questo modulo deve restare una foglia (vedi il commento
    // in testa). Un clearer che lancia lascia una cache vecchia in questo
    // processo: non può passare in silenzio.
    void import('./logger.js').then(({ logger }) =>
      logger.error({ tenantId, failed, cleared },
        '[metamodel] una o più cache NON sono state svuotate: questo processo resta con dati vecchi per quel tenant fino alla scadenza del loro TTL (60 s le cache del metamodello, 5 min lo schema)'),
    )
  }
  return { tenantId, cleared, failed }
}

/**
 * Il metamodello di `tenantId` è cambiato: svuota le cache locali e avvisa gli
 * altri processi. Firma invariata (`(tenantId: string): void`) perché è il
 * punto unico su cui si appoggia tutto il resto, compreso lo schema per
 * tenant.
 */
export function invalidateSchema(tenantId: string): void {
  const local = clearLocalMetamodelCaches(tenantId)
  if (publisher) publisher(tenantId, local)
  last = { ...local, published: publisher !== null }
}

/** L'ultima invalidazione eseguita in questo processo (diagnostica e test). */
export function lastInvalidation(): InvalidationOutcome | null {
  return last
}
