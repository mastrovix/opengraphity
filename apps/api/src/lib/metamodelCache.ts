/**
 * La forma unica delle cache derivate dal metamodello (revisione delle otto
 * ondate · D-N3, ondata di rimedio 1).
 *
 * ## Il difetto
 * L'ondata 5 ha dato al metamodello un canale fra i processi e un registro di
 * «clearer»: ogni modulo che tiene una cache si iscrive, e `invalidateSchema`
 * li chiama tutti. Ma **sette cache su nove non avevano nessuna scadenza**, e
 * tre punti del prodotto affermavano il contrario — uno esattamente invertito
 * («indefinitely for the GraphQL schema», che è l'unica che scadeva).
 *
 * Il canale è una rete, non una garanzia: se Redis è giù, se il messaggio non
 * arriva, se il processo si è iscritto dopo, o se la mutation non tira la leva,
 * una cache senza TTL resta sbagliata **fino al riavvio del processo**. Dal
 * vivo: dopo una rinomina nel Dizionario, lo stesso processo API rifiutava il
 * valore nuovo e accettava quello rimosso, per sempre.
 *
 * ## La forma
 * Cinque moduli scrivevano lo stesso idioma a mano — una `Map` di promesse,
 * un `registerMetamodelCacheClearer` con un prefisso, un `.catch` che
 * dimentica il fallimento. Qui quell'idioma è scritto una volta, con la
 * scadenza dentro:
 *
 *  - la chiave è sempre `tenantId::sottochiave` (la sottochiave è `''` per le
 *    cache che hanno una voce per tenant), così l'invalidazione per tenant è
 *    sempre lo stesso prefisso;
 *  - un fallimento non si mette in cache (chi chiama lo vede, e il prossimo
 *    ritenta): è il comportamento che tutti e cinque i moduli avevano già, e
 *    che nel caso delle etichette dei CI è deliberato — una lista incompleta
 *    farebbe sparire dei CI;
 *  - il TTL è la rete: la via normale resta il canale del metamodello.
 *
 * Il registro dei clearer non cambia: `invalidateSchema(tenantId)` resta il
 * punto unico, e ogni cache creata qui vi si iscrive col proprio nome.
 */
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'

/**
 * Sessanta secondi: quanto un amministratore può aspettare senza chiamare
 * qualcuno, e quanto già aspetta la whitelist dei report — che è l'unica cache
 * del metamodello che una scadenza l'aveva. Non è il tempo normale di
 * propagazione (quello è il canale Redis, immediato): è il tempo massimo in cui
 * un errore di propagazione resta visibile.
 */
export const METAMODEL_CACHE_TTL_MS = 60_000

/**
 * Oltre questo numero di voci, un `get` ripulisce anche quelle scadute. Senza
 * questa passata la mappa terrebbe per sempre le voci dei tenant che non
 * vengono più interrogati (la scadenza, da sola, è pigra).
 */
const SWEEP_ABOVE_ENTRIES = 256

export interface MetamodelCache<T> {
  /** Il valore per questo tenant (e sottochiave), dalla cache o caricato. */
  get(tenantId: string, subKey?: string): Promise<T>
  /** Dimentica una sottochiave, o tutte le voci di un tenant. */
  invalidate(tenantId: string, subKey?: string): void
  /** Dimentica tutto (solo i test, e lo spegnimento). */
  clear(): void
  /** Voci in memoria, scadute comprese: diagnostica e test. */
  size(): number
}

export function createMetamodelCache<T>(opts: {
  /** Il nome con cui questa cache si iscrive al registro: compare nei log e in `metamodelBusStatus()`. */
  name:   string
  load:   (tenantId: string, subKey: string) => Promise<T>
  ttlMs?: number
}): MetamodelCache<T> {
  const ttlMs   = opts.ttlMs ?? METAMODEL_CACHE_TTL_MS
  const entries = new Map<string, { value: Promise<T>; expiresAt: number }>()
  const keyOf   = (tenantId: string, subKey: string): string => `${tenantId}::${subKey}`

  function invalidate(tenantId: string, subKey?: string): void {
    if (subKey !== undefined) {
      entries.delete(keyOf(tenantId, subKey))
      return
    }
    const prefix = `${tenantId}::`
    for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key)
  }

  registerMetamodelCacheClearer(opts.name, (tenantId: string) => { invalidate(tenantId) })

  return {
    get(tenantId: string, subKey = ''): Promise<T> {
      const key = keyOf(tenantId, subKey)
      const now = Date.now()
      const hit = entries.get(key)
      if (hit && hit.expiresAt > now) return hit.value

      if (entries.size > SWEEP_ABOVE_ENTRIES) {
        for (const [k, e] of [...entries]) if (e.expiresAt <= now) entries.delete(k)
      }

      const value = opts.load(tenantId, subKey).catch((err: unknown) => {
        // Un fallimento non resta in cache: sarebbe un errore che si ripete
        // per un minuto senza che nessuno possa farci niente.
        entries.delete(key)
        throw err
      })
      entries.set(key, { value, expiresAt: now + ttlMs })
      return value
    },
    invalidate,
    clear(): void { entries.clear() },
    size(): number { return entries.size },
  }
}
