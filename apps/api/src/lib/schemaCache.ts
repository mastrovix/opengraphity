/**
 * Lo schema GraphQL **per tenant** (ondata 5, A-1: il perno del programma).
 *
 * ## Com'era
 * `server.ts` costruiva lo schema UNA volta all'avvio con
 * `getSchemaForTenant('system')` e Apollo lo teneva fisso: era l'unico
 * chiamante in tutto il repo. I tipi e i campi creati dal disegnatore **non
 * arrivavano mai all'API**, mentre il web genera le query dal metamodello vivo
 * — quindi creare un tipo dava «Cannot query field» e aggiungere un campo a
 * `server` rompeva il dettaglio di ogni server. E `invalidateSchema('c-one')`
 * cancellava una voce che non era mai esistita, loggando «Schema invalidato —
 * verrà rigenerato»: un messaggio che affermava il falso.
 *
 * ## Com'è
 * Uno schema per tenant, generato dal suo metamodello, tenuto in una cache
 * **limitata** (`GRAPHQL_SCHEMA_CACHE_MAX`, default 25) con sfratto del meno
 * usato di recente: un'istanza cloud con molti clienti non tiene in memoria
 * uno schema per ognuno, lo ricostruisce alla richiesta successiva. Le
 * metriche dicono se la cache lavora (`graphql_schema_builds_total`,
 * `graphql_schema_evictions_total`, `graphql_schema_cache_entries`).
 *
 * ## Quando lo schema di un tenant NON si costruisce
 * Un tipo o un campo personalizzato che collide (un tipo `server`, un campo
 * `2fa`) fa lanciare `makeExecutableSchema`. Se ci si fermasse lì, quel tenant
 * resterebbe **senza API** — e senza la mutation per rimediare, che vive nello
 * stesso schema. Perciò si serve lo schema **sicuro**: base + ITIL, senza i
 * tipi del cliente, così l'amministratore può cancellare il tipo che rompe.
 * Non è un ripiego silenzioso: `graphql_schema_build_failed_total` lo conta,
 * il log porta il motivo e chi serve la richiesta mette l'intestazione
 * `X-Schema-Degraded`. La vera difesa è a monte — la validazione dei nomi in
 * scrittura (A-12) — e questa è la rete sotto di essa.
 */
import { makeExecutableSchema } from '@graphql-tools/schema'
import type { GraphQLSchema } from 'graphql'
import { loadMetamodel, generateSDL, loadITILTypes, generateITILEnumsSDL, type EnumScope } from '@opengraphity/schema-generator'
import { enumScopeClause, loadTenantEnumOverrides, applyEnumOverrides } from './enumScope.js'
import { buildBaseSDL } from '../graphql/schema-base.js'
import { buildResolvers } from '../graphql/resolvers/index.js'
import { logger } from './logger.js'
import { registerSchemaInvalidator } from './schemaInvalidator.js'
import { registerCITypes } from './ciTypeFromLabels.js'
import { config } from './config.js'
import {
  graphqlSchemaBuildsTotal, graphqlSchemaEvictionsTotal, graphqlSchemaBuildFailedTotal, graphqlSchemaCacheEntries,
} from '../middleware/metrics.js'

interface SchemaCacheEntry {
  schema: GraphQLSchema
  generatedAt: number
  tenantId: string
  /** Vero quando è lo schema SICURO: i tipi del tenant non ci sono. */
  degraded: boolean
  /** Perché è degradato (per il log e l'intestazione di risposta). */
  reason: string | null
}

/**
 * `Map` con ordine di inserimento: per l'uso recente si cancella e si
 * reinserisce la voce letta, così la prima chiave è sempre la meno usata.
 */
const cache = new Map<string, SchemaCacheEntry>()
const TTL = 5 * 60 * 1000  // 5 minuti

/** Costruzioni in corso, per tenant: due richieste insieme non generano due schemi. */
const inFlight = new Map<string, Promise<SchemaCacheEntry>>()

function touch(tenantId: string, entry: SchemaCacheEntry): void {
  cache.delete(tenantId)
  cache.set(tenantId, entry)
  graphqlSchemaCacheEntries.set({}, cache.size)
}

function evictIfNeeded(): void {
  const max = Math.max(1, config.graphqlSchemaCacheMax)
  while (cache.size > max) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
    graphqlSchemaEvictionsTotal.inc({})
    logger.info({ tenantId: oldest.value, max }, 'Schema sfrattato dalla cache (limite raggiunto): verrà ricostruito alla prossima richiesta')
  }
  graphqlSchemaCacheEntries.set({}, cache.size)
}

/**
 * L'ambito dei vocabolari che il generatore di schema deve usare (A-2 / C-6).
 * `packages/schema-generator` non può importare `apps/api`, quindi la regola —
 * che ha una sorgente sola, `lib/enumScope.ts` — gliela passiamo noi invece di
 * riscriverla là.
 */
const ENUM_SCOPE: EnumScope = {
  clause:         enumScopeClause,
  loadOverrides:  loadTenantEnumOverrides,
  applyOverrides: applyEnumOverrides,
}

// Register invalidator so dynamic-ci.ts can call it without circular imports.
// Il log dice la VERITÀ: prima affermava «verrà rigenerato» anche quando in
// cache non c'era nessuna voce per quel tenant (ed era il caso normale).
registerSchemaInvalidator((tenantId: string) => {
  const had = cache.delete(tenantId)
  inFlight.delete(tenantId)
  graphqlSchemaCacheEntries.set({}, cache.size)
  if (had) logger.info({ tenantId }, 'Schema invalidato: verrà rigenerato alla prossima richiesta')
  else     logger.debug({ tenantId }, 'Schema invalidato: non era in cache in questo processo, niente da togliere')
})

/** La voce di cache del tenant (schema + stato), costruendola se serve. */
async function getEntry(tenantId: string): Promise<SchemaCacheEntry> {
  const cached = cache.get(tenantId)
  if (cached && (Date.now() - cached.generatedAt) < TTL) {
    touch(tenantId, cached)
    return cached
  }
  const running = inFlight.get(tenantId)
  if (running) return running

  const build = buildEntry(tenantId).finally(() => inFlight.delete(tenantId))
  inFlight.set(tenantId, build)
  return build
}

export async function getSchemaForTenant(tenantId: string): Promise<GraphQLSchema> {
  return (await getEntry(tenantId)).schema
}

/**
 * Lo stato dello schema di un tenant: serve a chi risponde alla richiesta per
 * dire, nell'intestazione, che sta servendo lo schema sicuro.
 */
export async function getSchemaState(tenantId: string): Promise<{ schema: GraphQLSchema; degraded: boolean; reason: string | null }> {
  const e = await getEntry(tenantId)
  return { schema: e.schema, degraded: e.degraded, reason: e.reason }
}

async function buildEntry(tenantId: string): Promise<SchemaCacheEntry> {
  logger.info({ tenantId }, 'Generando schema GraphQL')
  const [ciTypes, itilTypes] = await Promise.all([
    loadMetamodel(tenantId),
    loadITILTypes(tenantId, ENUM_SCOPE),
  ])
  const itilEnumsSDL = generateITILEnumsSDL(itilTypes)
  const baseSDL      = buildBaseSDL()

  try {
    const schema = assemble(ciTypes, baseSDL, itilEnumsSDL)
    registerCITypes(tenantId, ciTypes)
    graphqlSchemaBuildsTotal.inc({})
    const entry: SchemaCacheEntry = { schema, generatedAt: Date.now(), tenantId, degraded: false, reason: null }
    touch(tenantId, entry)
    evictIfNeeded()
    logger.info({ tenantId, ciTypes: ciTypes.length, itilTypes: itilTypes.length }, 'Schema generato')
    return entry
  } catch (e) {
    // Lo schema del tenant non si assembla: quasi sempre un tipo o un campo
    // personalizzato che collide (la validazione in scrittura, A-12, è la
    // difesa a monte). Senza rete, questo tenant resterebbe senza API E senza
    // la mutation per rimediare. Si serve lo schema sicuro — i suoi tipi non
    // ci sono — e lo si dice in ogni modo disponibile.
    const reason = e instanceof Error ? e.message : String(e)
    const shipped = ciTypes.filter((t) => t.scope !== 'tenant')
    graphqlSchemaBuildFailedTotal.inc({})
    logger.error(
      { tenantId, reason, tenantTypes: ciTypes.length - shipped.length },
      'Schema del tenant NON assemblabile: servo lo schema sicuro (base + ITIL, senza i tipi del cliente). ' +
      'Correggi o cancella il tipo che collide: la mutation resta disponibile.',
    )
    const schema = assemble(shipped, baseSDL, itilEnumsSDL)
    registerCITypes(tenantId, shipped)
    graphqlSchemaBuildsTotal.inc({})
    const entry: SchemaCacheEntry = { schema, generatedAt: Date.now(), tenantId, degraded: true, reason }
    touch(tenantId, entry)
    evictIfNeeded()
    return entry
  }
}

function assemble(
  ciTypes: Awaited<ReturnType<typeof loadMetamodel>>,
  baseSDL: string,
  itilEnumsSDL: string,
): GraphQLSchema {
  // `generateSDL` va chiamato SEMPRE, anche con zero tipi: in quel caso
  // restituisce la parte statica del metamodello — cioè `createCIType`, la
  // mutation con cui un cliente senza tipi se ne crea uno. Saltarla lo
  // chiuderebbe fuori dalla propria configurazione. (Con zero tipi non emette
  // più blocchi `extend` vuoti, che non erano SDL valido: corretto alla radice
  // nel generatore.)
  const parts = [baseSDL, generateSDL(ciTypes), itilEnumsSDL].filter((sdl) => sdl.trim() !== '')
  return makeExecutableSchema({
    typeDefs:  parts,
    resolvers: buildResolvers(ciTypes),
  })
}

/** Ricostruisce subito lo schema del tenant (usata dai test e dagli script). */
export async function regenerateSchema(tenantId: string): Promise<GraphQLSchema> {
  cache.delete(tenantId)
  inFlight.delete(tenantId)
  return getSchemaForTenant(tenantId)
}

// Note: invalidateSchema is now in schemaInvalidator.ts to avoid circular imports
// It is still exported here for backward compatibility with server.ts etc.
export { invalidateSchema } from './schemaInvalidator.js'
