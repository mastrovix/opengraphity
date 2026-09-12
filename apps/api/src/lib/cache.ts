import { registerMetamodelCacheClearer } from './schemaInvalidator.js'

class MemoryCache {
  private store = new Map<string, { data: unknown; expires: number }>()

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
    this.store.set(key, { data, expires: Date.now() + ttlSeconds * 1_000 })
  }

  invalidate(pattern: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(pattern)) this.store.delete(key)
    }
  }

  clear(): void {
    this.store.clear()
  }
}

export const cache = new MemoryCache()

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
  for (const prefix of METAMODEL_CACHE_PREFIXES) cache.invalidate(metamodelCacheKey(prefix, tenantId))
}

registerMetamodelCacheClearer('memory-cache', invalidateMetamodelDerivedCache)
