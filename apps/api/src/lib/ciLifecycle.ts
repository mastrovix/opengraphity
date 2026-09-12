/**
 * La SEMANTICA del ciclo di vita del CI: quali valori di `ci_status` contano
 * come «ritirato» e quali come «in manutenzione» (ondata 7 · C-4 / A-14).
 *
 * ## Il difetto
 * Il Dizionario permette al cliente di rinominare, aggiungere e togliere i
 * valori di `ci_status`. La semantica di quei valori, invece, era scritta nel
 * codice in quattro posti diversi:
 *
 *  - `CI_LIFECYCLE_STATUSES` (sei valori) come lista di **validazione**:
 *    `assertLifecycleStatuses` rifiutava `dismesso` — rumoroso e incoerente,
 *    perché il valore era legittimo e stava nel vocabolario del cliente;
 *  - `CI_LIFECYCLE_RETIRED = ['inactive','decommissioned']`, letta da
 *    `isRetiredLifecycle`: un CI «dismesso» con un nome nuovo tornava a pesare
 *    nel calcolo della salute del servizio — **silenzioso**;
 *  - `CI_LIFECYCLE_MAINTENANCE = 'maintenance'` in `serviceImpact/engine.ts` e
 *    lo stesso valore come **letterale dentro il Cypher** di
 *    `events/ciHealth.ts` (`WHEN status = 'maintenance'`): un CI in
 *    manutenzione con un nome nuovo tornava ad aggiornare la sua salute dagli
 *    allarmi e ad aprire incident — **silenzioso**;
 *  - `ciMutations.ts`, il gancio che avvisa i Servizi monitorati quando un CI
 *    entra o esce dalla manutenzione: non scattava più.
 *
 * ## La forma scelta, e perché
 * La semantica vive come **due liste sulla policy del tenant**
 * (`Tenant.event_policy.retired_statuses` e `.maintenance_statuses`,
 * lib/eventPolicy.ts), accanto a `ignore_lifecycle_statuses` che era già lì.
 * Le ragioni, in ordine:
 *
 *  1. **C'è già un posto per le regole di dominio condivise fra allarmi e
 *     servizi, ed è quello**: `suppress_upstream_hops` (i salti a monte) e
 *     `ignore_lifecycle_statuses` stanno sulla policy e li legge anche il
 *     motore delle mappe; la migrazione che li ha introdotti si chiama
 *     «shared_domain_rules». Una terza sede per la terza regola della stessa
 *     famiglia sarebbe stata la quarta copia del problema.
 *  2. **Arriva gratis tutto quello che serve**: lettura con cache per tenant
 *     (TTL 30 s, già valida anche nei worker), `version` con controllo di
 *     modifica concorrente, audit, e una pagina in cui l'amministratore vede e
 *     modifica la semantica (Impostazioni → Policy allarmi).
 *  3. **Un ruolo sul valore dell'enum era l'alternativa, e costa di più senza
 *     rendere di più**: `EnumTypeDefinition.values` è un array di stringhe
 *     letto dal generatore dello schema, dal disegnatore dei vocabolari, dai
 *     semi, da `loadTenantEnumOverrides` e da `domainVocabulary`. Portarlo a
 *     `{valore, ruolo}` vuol dire toccare tutti quei punti per un concetto che
 *     ha senso su UNO dei sedici vocabolari, e su tutti gli altri sarebbe un
 *     campo sempre vuoto. In più un ruolo mancante su un valore nuovo sarebbe
 *     di nuovo un default implicito, cioè il difetto con un nome diverso.
 *  4. **L'obiezione vera al ruolo mancante — «se rinomino il valore, la lista
 *     resta indietro» — la chiude B7-2**, non la forma: `updateEnumType`
 *     conta gli usi di un valore che si sta togliendo, e **la policy è fra gli
 *     usi contati**. Togliere `decommissioned` mentre la semantica lo cita
 *     viene rifiutato, o riscritto sul valore di sostituzione. La semantica non
 *     può quindi restare orfana in silenzio.
 *
 * ## Il primo giorno non cambia niente
 * I valori iniziali sono esattamente le costanti di prima
 * (`retired_statuses = ['inactive','decommissioned']`,
 * `maintenance_statuses = ['maintenance']`), e la migrazione
 * `20260917_1810_ci_lifecycle_semantics` li scrive su ogni tenant esistente
 * (idempotente: non tocca una policy che li ha già).
 */
import type { Session } from 'neo4j-driver'
import { ValidationError } from './errors.js'
import { CI_STATUS_VOCABULARY } from './eventVocabularies.js'
import { assertDomainValue, domainVocabulary } from './domainMatrix.js'
import { getEventPolicy } from '../services/events/policy.js'

export { CI_STATUS_VOCABULARY }

/**
 * La semantica del ciclo di vita di un tenant, già in forma di insiemi: chi la
 * usa fa solo `has`, e non gli serve sapere da dove viene.
 */
export interface CILifecycleSemantics {
  /** Fuori dal calcolo delle mappe: dismesso o fuori servizio (era `CI_LIFECYCLE_RETIRED`). */
  retired:     ReadonlySet<string>
  /** Il monitoraggio non ne aggiorna la salute, la mappa non lo conta (era `CI_LIFECYCLE_MAINTENANCE`). */
  maintenance: ReadonlySet<string>
  /** Gli allarmi su questi CI non aprono incident (`skipped_lifecycle`, revisione 2 · D6.3). */
  ignored:     ReadonlySet<string>
}

/**
 * La semantica del tenant, dalla policy (cache in memoria, TTL 30 s: non è un
 * giro in più per allarme né per valutazione di mappa).
 */
export async function resolveCILifecycleSemantics(tenantId: string): Promise<CILifecycleSemantics> {
  const policy = await getEventPolicy(tenantId)
  return {
    retired:     new Set(policy.retired_statuses),
    maintenance: new Set(policy.maintenance_statuses),
    ignored:     new Set(policy.ignore_lifecycle_statuses),
  }
}

/** True se il ciclo di vita del CI lo mette fuori dal calcolo della mappa. */
export function isRetiredLifecycle(status: string | null | undefined, semantics: CILifecycleSemantics): boolean {
  return status != null && semantics.retired.has(status)
}

/** True se il ciclo di vita del CI è «in manutenzione» per questo cliente. */
export function isMaintenanceLifecycle(status: string | null | undefined, semantics: CILifecycleSemantics): boolean {
  return status != null && semantics.maintenance.has(status)
}

/**
 * I valori ammessi per le liste del ciclo di vita: il vocabolario `ci_status`
 * **del cliente** (il suo enum vince su quello di sistema). Serve
 * all'interfaccia e al messaggio d'errore.
 */
export async function lifecycleVocabulary(tenantId: string): Promise<readonly string[]> {
  return domainVocabulary(tenantId, CI_STATUS_VOCABULARY)
}

/**
 * Valida una lista di stati del ciclo di vita contro il vocabolario del
 * cliente. Un valore fuori vocabolario è un errore che elenca gli ammessi
 * (`assertDomainValue`): prima l'errore elencava i valori del **codice**, e su
 * un cliente che aveva rinominato i propri era un messaggio sbagliato.
 */
/**
 * Lo stato con cui nasce un CI quando il chiamante non lo indica: il **primo**
 * valore del vocabolario del cliente, cioè l'ordine in cui il Dizionario li
 * presenta (di fabbrica `active`).
 *
 * Prima la creazione scriveva il letterale `'active'`. Con il vocabolario
 * rinominato — `attivo` — quel valore non è nel Dizionario del cliente: il
 * form lo mostra vuoto e un salvataggio distratto azzera il campo (A-13). Un
 * vocabolario vuoto è un errore, non un ripiego: significa che il cliente non
 * ha nessuno stato con cui creare un CI, e deve saperlo.
 */
export async function initialCIStatus(tenantId: string): Promise<string> {
  const values = await lifecycleVocabulary(tenantId)
  const first = values[0]
  if (first === undefined) {
    throw new ValidationError(
      `Il vocabolario "${CI_STATUS_VOCABULARY}" di questo cliente è vuoto: non c'è uno stato con cui creare un CI. ` +
      `Aggiungi almeno un valore nel Dizionario.`,
    )
  }
  return first
}

export async function assertTenantLifecycleStatuses(
  tenantId: string, values: readonly string[], field: string,
): Promise<string[]> {
  const out: string[] = []
  for (const v of values) {
    try { out.push(await assertDomainValue(tenantId, CI_STATUS_VOCABULARY, v)) }
    catch (e) { throw new ValidationError(`${field}: ${e instanceof Error ? e.message : String(e)}`) }
  }
  return out
}

/**
 * Quante volte un valore di `ci_status` è citato dalla semantica del tenant.
 * La usa `updateEnumType` (B7-2) per non lasciare orfana la semantica quando
 * si toglie un valore dal Dizionario: è il pezzo che rende sicura la scelta
 * delle «due liste» invece del ruolo sul valore.
 *
 * Legge il JSON grezzo e non `getEventPolicy`, perché deve funzionare anche su
 * una policy di una versione precedente (che non ha ancora le due chiavi):
 * in quel caso non cita nulla, ed è vero.
 */
export async function lifecyclePolicyReferences(
  session: Session, tenantId: string, value: string,
): Promise<readonly string[]> {
  const r = await session.executeRead((tx) =>
    tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.event_policy AS raw', { tenantId }),
  )
  const raw = r.records.length ? r.records[0]!.get('raw') : null
  if (typeof raw !== 'string' || raw === '') return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { return [] }
  if (parsed === null || typeof parsed !== 'object') return []
  const p = parsed as Record<string, unknown>
  const hits: string[] = []
  for (const key of ['ignore_lifecycle_statuses', 'retired_statuses', 'maintenance_statuses']) {
    const list = p[key]
    if (Array.isArray(list) && list.includes(value)) hits.push(key)
  }
  return hits
}
