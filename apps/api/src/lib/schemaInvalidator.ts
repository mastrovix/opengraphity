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
 * ## Lo svuotamento totale (PRB00000003)
 * Un clearer sa svuotare UN tenant, perché il messaggio dice quale. Quando la
 * connessione di ascolto cade, però, i messaggi pubblicati nel frattempo sono
 * perduti — il pub/sub di Redis non ha arretrato — e alla ripresa questo
 * processo non sa più QUALI tenant siano cambiati: sa solo di aver perso
 * qualcosa. Perciò ogni cache può registrare anche un `clearAll` senza
 * argomenti, e `clearAllMetamodelCaches()` li chiama tutti. Chi non ce l'ha
 * viene NOMINATO in `withoutClearAll`: uno svuotamento parziale che si crede
 * totale sarebbe il difetto di prima travestito da rimedio.
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
 * Svuota la cache di TUTTI i tenant (PRB00000003).
 *
 * Non è `clear(tenantId)` ripetuto: quando serve, i tenant cambiati non si
 * sanno. Il pub/sub di Redis non ha arretrato — i messaggi pubblicati mentre
 * questo processo era staccato sono perduti, e con loro l'elenco di CHI è
 * cambiato. L'unica reazione onesta è buttare tutto e ricaricare.
 */
export type MetamodelCacheClearAll = () => void

/**
 * Porta il cambiamento agli altri processi. Riceve anche l'esito locale, così
 * il bus scrive UNA riga di log con tutto: cosa è stato svuotato qui, cosa ha
 * fallito, e quanti processi hanno ricevuto il messaggio. Non deve lanciare né
 * attendere.
 */
export type MetamodelPublisher = (tenantId: string, local: LocalInvalidation) => void

const clearers = new Map<string, MetamodelCacheClearer>()
/**
 * Secondo registro, deliberatamente separato: una cache può sapersi svuotare
 * per tenant e non per intero, e la differenza NON deve sparire. Chi non è
 * qui dentro viene nominato in `withoutClearAll`, non saltato in silenzio.
 */
const clearAlls = new Map<string, MetamodelCacheClearAll>()
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
 *
 * `clearAll` è lo svuotamento totale, e si passa quando la cache sa farlo:
 * serve solo alla ripresa dopo una sottoscrizione persa, quando i tenant
 * cambiati non si sanno più (PRB00000003). Ometterlo è lecito — una cache che
 * non sa svuotarsi per intero resta vecchia fino al suo TTL — ma non è
 * gratuito: quel nome finisce in `withoutClearAll` e il canale lo logga.
 */
export function registerMetamodelCacheClearer(
  name: string,
  clear: MetamodelCacheClearer,
  clearAll?: MetamodelCacheClearAll,
): void {
  clearers.set(name, clear)
  // I due registri non devono mai divergere: ri-registrarsi senza `clearAll`
  // toglie quello di prima, invece di lasciarne in giro uno che punta alla
  // cache di un modulo ricaricato.
  if (clearAll) clearAlls.set(name, clearAll)
  else clearAlls.delete(name)
}

/**
 * Compatibilità: `schemaCache.ts` chiama questa al proprio caricamento. È il
 * clearer di nome `schema` — uno dei tanti, non più l'unico.
 */
export function registerSchemaInvalidator(fn: MetamodelCacheClearer, clearAll?: MetamodelCacheClearAll): void {
  registerMetamodelCacheClearer('schema', fn, clearAll)
}

/** I nomi delle cache registrate in QUESTO processo (log di avvio del bus, test). */
export function registeredMetamodelCacheClearers(): string[] {
  return [...clearers.keys()]
}

/** I nomi delle cache registrate che NON sanno svuotarsi per intero. */
export function metamodelCacheClearersWithoutClearAll(): string[] {
  return [...clearers.keys()].filter((name) => !clearAlls.has(name))
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

/** Esito dello svuotamento TOTALE delle cache di questo processo. */
export interface GlobalInvalidation {
  /** Nomi delle cache svuotate per intero, nell'ordine di registrazione. */
  cleared:         string[]
  /** Clearer che hanno lanciato: non fermano gli altri e non restano nascosti. */
  failed:          { name: string; error: string }[]
  /**
   * Cache registrate senza svuotamento totale: NON sono state svuotate, e
   * restano vecchie fino alla scadenza del loro TTL. Dichiararle è il punto:
   * uno svuotamento parziale che si crede totale è il difetto di prima.
   */
  withoutClearAll: string[]
}

/**
 * Svuota TUTTE le cache di questo processo, per ogni tenant, senza pubblicare
 * niente (PRB00000003).
 *
 * La chiama il canale quando si ri-sottoscrive DOPO aver perso la
 * sottoscrizione: in quella finestra il pub/sub di Redis — che non ha
 * arretrato — ha buttato i messaggi destinati a questo processo, e nessuno
 * glieli riconsegnerà. Non si sa quali tenant siano cambiati, quindi si butta
 * tutto: ricaricare cache ancora buone costa una query, servire un metamodello
 * vecchio per 5 minuti costa un «Invalid relation type» all'utente.
 */
export function clearAllMetamodelCaches(): GlobalInvalidation {
  const cleared: string[] = []
  const failed: { name: string; error: string }[] = []
  const withoutClearAll: string[] = []
  for (const name of clearers.keys()) {
    const clearAll = clearAlls.get(name)
    if (!clearAll) {
      withoutClearAll.push(name)
      continue
    }
    try {
      clearAll()
      cleared.push(name)
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (failed.length > 0 || withoutClearAll.length > 0) {
    // Import differito: questo modulo deve restare una foglia (vedi il commento
    // in testa). Una cache non svuotata qui è una cache che resta vecchia senza
    // che nessuno le dica più di buttarsi: non può passare in silenzio.
    void import('./logger.js').then(({ logger }) =>
      logger.error({ failed, withoutClearAll, cleared },
        '[metamodel] svuotamento totale incompleto: queste cache restano vecchie, per TUTTI i tenant, fino alla scadenza del loro TTL (60 s le cache del metamodello, 5 min lo schema)'),
    )
  }
  return { cleared, failed, withoutClearAll }
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
