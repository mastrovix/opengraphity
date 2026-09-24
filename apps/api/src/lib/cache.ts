import { registerMetamodelCacheClearer } from './schemaInvalidator.js'

/**
 * How many entries the cache holds at most (review of 23 Sep 2026). The CI
 * list keys carry the search, the page and the filters: typing in a search box
 * or paging adds an entry each, and an entry expired only when the SAME key was
 * read again — on a CI type rarely written, never. Above this the expired
 * entries are swept, and if that is not enough the oldest go.
 */
export const MEMORY_CACHE_MAX_ENTRIES = 2_000

class MemoryCache {
  // A Map keeps insertion order: the first keys are the oldest, and a key set
  // again moves to the end (it is deleted first).
  private store = new Map<string, { data: unknown; expires: number }>()

  constructor(private readonly maxEntries = MEMORY_CACHE_MAX_ENTRIES) {}

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expires) {
      this.store.delete(key)
      return null
    }
    return entry.data as T
  }

  set(key: string, data: unknown, ttlSeconds: number): void {
    this.store.delete(key)
    if (this.store.size >= this.maxEntries) this.makeRoom()
    this.store.set(key, { data, expires: Date.now() + ttlSeconds * 1_000 })
  }

  /** Entries in memory, expired included: diagnostics and tests. */
  size(): number {
    return this.store.size
  }

  private makeRoom(): void {
    const now = Date.now()
    for (const [k, e] of this.store) if (e.expires < now) this.store.delete(k)
    // Still full: the oldest quarter goes, so a full cache is not swept at every set.
    if (this.store.size >= this.maxEntries) {
      let drop = Math.max(1, Math.floor(this.maxEntries / 4))
      for (const k of this.store.keys()) {
        if (drop-- <= 0) break
        this.store.delete(k)
      }
    }
  }

  invalidate(pattern: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(pattern)) this.store.delete(key)
    }
  }

  /**
   * The key `base` and every key below it (`base:...`), and nothing else.
   * A raw prefix is not enough for a tenant: `invalidate('ci:t1')` also threw
   * away `ci:t10`, `ci:t11`, ... — other customers' entries (23 Sep 2026).
   */
  invalidateScope(base: string): void {
    for (const key of this.store.keys()) {
      if (key === base || key.startsWith(`${base}:`)) this.store.delete(key)
    }
  }

  clear(): void {
    this.store.clear()
  }
}

export const cache = new MemoryCache()

/** A cache of its own size: tests only. */
export function createMemoryCache(maxEntries?: number): MemoryCache {
  return new MemoryCache(maxEntries)
}

/**
 * Le famiglie di chiavi di questa cache che dipendono dal METAMODELLO, e quindi
 * vanno svuotate quando un tipo, un campo o una relazione cambiano (A-16).
 * Ogni chiave è `<prefisso>:<tenantId>` (eventualmente seguita da altro), così
 * l'invalidazione è per tenant e non butta la cache degli altri.
 *
 *  - `allowed_rel_types`: i tipi di relazione ammessi, letti da
 *    `CIRelationDefinition` (`resolvers/ciRelationships.ts`, TTL 300 s). È la
 *    causa visibile del difetto: una relazione appena definita veniva rifiutata
 *    con «Invalid relation type» per cinque minuti da ogni processo che non
 *    aveva servito la mutation.
 *  - `topology` e `ci`: contengono righe già mappate, e il campo `type` di ogni
 *    CI è derivato dalle label attraverso il metamodello (`ciTypeFromLabels`):
 *    un tipo aggiunto o rimosso cambia quel valore.
 *
 * La sorgente è unica: chi legge o scrive queste chiavi usa `metamodelCacheKey`.
 */
export const METAMODEL_CACHE_PREFIXES = ['allowed_rel_types', 'topology', 'ci'] as const
export type MetamodelCachePrefix = (typeof METAMODEL_CACHE_PREFIXES)[number]

/** La chiave di una famiglia derivata dal metamodello, per tenant. */
export function metamodelCacheKey(prefix: MetamodelCachePrefix, tenantId: string): string {
  return `${prefix}:${tenantId}`
}

/** Svuota per un tenant solo le famiglie derivate dal metamodello. */
export function invalidateMetamodelDerivedCache(tenantId: string): void {
  for (const prefix of METAMODEL_CACHE_PREFIXES) cache.invalidateScope(metamodelCacheKey(prefix, tenantId))
}

/**
 * Le stesse famiglie, per OGNI tenant (PRB00000003). Non `cache.clear()`: qui
 * dentro vivono anche chiavi che col metamodello non c'entrano, e buttarle
 * sarebbe un danno collaterale gratuito.
 */
export function invalidateAllMetamodelDerivedCache(): void {
  for (const prefix of METAMODEL_CACHE_PREFIXES) cache.invalidate(`${prefix}:`)
}

registerMetamodelCacheClearer('memory-cache', invalidateMetamodelDerivedCache, invalidateAllMetamodelDerivedCache)
