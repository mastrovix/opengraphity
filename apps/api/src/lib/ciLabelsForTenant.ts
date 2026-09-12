/**
 * Quali etichette Neo4j sono CI, **per questo cliente** (ondata 6: A-9 / C-1 /
 * C-2 / D-7).
 *
 * ## Il difetto
 * Sedici etichette erano scritte a mano in `ciLabels.ts`, e il commento del
 * file lo ammetteva: «aggiungere un tipo di CI vuol dire toccare QUESTO file».
 * Da lì partivano diciassette consumatori — impatto, topologia, ricerca
 * globale, selettori dei ticket, gruppi dinamici, allegati, REST, assistente,
 * regole di anomalia, mappe dei servizi, catene. Un tipo creato dal cliente
 * (o un CI arrivato dalla discovery) esiste nel grafo e **non conta in nessuno
 * di quei posti**: non entra nell'impatto di un incident, non entra nella
 * mappa di un servizio, e un gruppo dinamico «solo bilanciatori» restituisce
 * i CI di tutti i tipi. Quasi sempre in silenzio.
 *
 * ## La regola
 * Le etichette dei CI si chiedono **al metamodello del tenant**, non a una
 * lista. `ALL_CI_LABELS` resta come seme dei tipi spediti col prodotto — così
 * un processo che non ha ancora letto il metamodello non peggiora la
 * situazione di prima — ma l'unione è per tenant e comprende i tipi suoi.
 *
 * ## Perché non basta la cache dello schema
 * `schemaCache` tiene gli schemi eseguibili e vive solo nell'API: `worker` ed
 * `events-worker` non ne hanno. Questa cache è più piccola (un elenco di
 * stringhe), sta in ogni processo, e si svuota da sé quando il metamodello
 * cambia — anche in un altro processo — perché si registra fra i «clearer»
 * del canale del metamodello (ondata 5).
 */
import { ENUM_SCOPE } from './enumScope.js'
import { loadMetamodel } from '@opengraphity/schema-generator'
import { createMetamodelCache } from './metamodelCache.js'
import { ALL_CI_LABELS } from './ciLabels.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'ci-labels' })

/** Cache per tenant: la svuota il canale del metamodello, e scade da sé. */
const cache = createMetamodelCache<readonly string[]>({
  name: 'ci-labels-for-tenant',
  load: (tenantId) => loadLabels(tenantId),
})

/**
 * Le etichette dei tipi CI **attivi** che questo cliente vede: i tipi spediti
 * col prodotto più i suoi. In ordine stabile (serve a rendere deterministici i
 * predicati Cypher che ne derivano, e quindi la cache dei piani di query).
 */
export function ciLabelsForTenant(tenantId: string): Promise<readonly string[]> {
  return cache.get(tenantId)
}

function loadLabels(tenantId: string): Promise<readonly string[]> {
  return loadMetamodel(tenantId, ENUM_SCOPE)
    .then((types) => {
      const labels = new Set<string>(ALL_CI_LABELS)
      for (const t of types) if (t.neo4jLabel) labels.add(t.neo4jLabel)
      const out = [...labels].sort()
      const extra = out.filter((l) => !ALL_CI_LABELS.includes(l))
      if (extra.length) log.debug({ tenantId, extra }, 'Etichette dei CI oltre a quelle spedite col prodotto')
      return out as readonly string[]
    })
    .catch((err: unknown) => {
      // Il metamodello non si legge (database non raggiungibile): si NON
      // nasconde l'errore dietro le etichette statiche, perché una lista
      // incompleta significa CI che scompaiono da impatto, mappe e ricerca —
      // esattamente il difetto che questo modulo chiude. Chi chiama decide se
      // fermarsi; la cache non trattiene il fallimento (lo garantisce
      // `createMetamodelCache`).
      log.error({ tenantId, err }, 'Etichette dei CI non leggibili dal metamodello')
      throw err
    })
}

/**
 * `(alias:Label1 OR alias:Label2 …)` per le clausole WHERE, con le etichette
 * di QUESTO cliente. Sostituisce `ciLabelPredicate`, che usava la lista fissa.
 */
export async function ciLabelPredicateForTenant(alias: string, tenantId: string): Promise<string> {
  const labels = await ciLabelsForTenant(tenantId)
  return '(' + labels.map((l) => `${alias}:${l}`).join(' OR ') + ')'
}

/**
 * Filtro etichette per le procedure APOC di espansione
 * (`labelFilter: '+Server|+Database…'`), con le etichette di questo cliente.
 */
export async function apocLabelFilterForTenant(tenantId: string): Promise<string> {
  const labels = await ciLabelsForTenant(tenantId)
  return labels.map((l) => `+${l}`).join('|')
}

/**
 * Il nome del tipo CI per un'etichetta, secondo il metamodello del tenant.
 * `null` quando nessun tipo attivo dichiara quell'etichetta: chi chiama deve
 * dirlo, non inventare un nome «per convenzione».
 */
export async function ciTypeNameForLabel(tenantId: string, label: string): Promise<string | null> {
  const types = await loadMetamodel(tenantId, ENUM_SCOPE)
  return types.find((t) => t.neo4jLabel === label)?.name ?? null
}

/** Solo per i test: svuota tutto. */
export function clearCILabelCache(): void {
  cache.clear()
}
