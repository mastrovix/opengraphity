/**
 * Dal **nome del tipo** all'etichetta Neo4j, per questo cliente (ondata 6:
 * A-9 / C-2 / D-7). È il verso opposto di `ciTypeNameForLabel`.
 *
 * ## Il difetto
 * Tre punti traducevano un nome di tipo scelto dall'utente in un'etichetta con
 * una tabella fissa o con una convenzione, e sbagliavano in silenzio:
 *  - `ciGroup.criteriaTypesToLabels`: `TYPE_TO_LABEL[t]` e i tipi ignoti
 *    «silently ignored» — il gruppo dinamico «solo bilanciatori» finiva senza
 *    criteri e restituiva i CI di **tutti** i tipi;
 *  - `topology.labelFromType`: `TYPE_TO_LABEL[t] ?? t`, cioè il nome del tipo
 *    usato come etichetta (`load_balancer` non è un'etichetta: zero nodi);
 *  - `incident.addAffectedCI` / `problem.addCIToProblem`: le regole ITIL
 *    convertivano `ci_type` in PascalCase a mano, e un tipo la cui etichetta
 *    non segue la convenzione dava un `MERGE` che non scriveva niente.
 *
 * ## La regola
 * L'insieme delle etichette ammesse è quello del nucleo
 * (`ciLabelsForTenant`), l'unica autorità su «cosa è un CI per questo
 * cliente»; i **nomi** vengono dal metamodello dello stesso tenant. Un nome
 * che non si risolve **si dice** (`ValidationError` con il nome e i tipi
 * ammessi): mai un elenco vuoto, mai un'etichetta inventata.
 *
 * `TYPE_TO_LABEL` entra solo per gli **alias storici** dei tipi spediti col
 * prodotto (`db_instance` → `DatabaseInstance`, e i sette tipi spediti che non
 * hanno una `CITypeDefinition` nel grafo): senza di loro un client REST che
 * chiama `?type=virtual_machine` da oggi prenderebbe un 400.
 */
import { loadMetamodel } from '@opengraphity/schema-generator'
import { ciLabelsForTenant } from './ciLabelsForTenant.js'
import { registerMetamodelCacheClearer } from './schemaInvalidator.js'
import { TYPE_TO_LABEL } from './ciLabels.js'
import { ValidationError } from './errors.js'

/** `tenantId → (nome del tipo in minuscolo → etichetta)`. */
const cache = new Map<string, Promise<ReadonlyMap<string, string>>>()

registerMetamodelCacheClearer('ci-type-name-to-label', (tenantId: string) => {
  cache.delete(tenantId)
})

/**
 * La mappa nome → etichetta di questo cliente.
 *
 * `loadMetamodel` viene chiamato una volta sola (e il risultato messo in
 * cache): chiedere il nome etichetta per etichetta con `ciTypeNameForLabel`
 * sarebbe una query per etichetta, cioè quindici round-trip per costruire la
 * stessa mappa. L'autorità su *quali* etichette valgono resta il nucleo: un
 * tipo del metamodello che il nucleo non elenca non entra.
 */
function nameToLabel(tenantId: string): Promise<ReadonlyMap<string, string>> {
  const hit = cache.get(tenantId)
  if (hit) return hit

  const load = (async () => {
    const labels = new Set(await ciLabelsForTenant(tenantId))
    const types = await loadMetamodel(tenantId)
    const map = new Map<string, string>()
    for (const t of types) {
      if (t.neo4jLabel && labels.has(t.neo4jLabel)) map.set(t.name.toLowerCase(), t.neo4jLabel)
    }
    // Alias storici dei tipi spediti col prodotto, solo verso etichette che il
    // nucleo riconosce per questo tenant.
    for (const [alias, label] of Object.entries(TYPE_TO_LABEL)) {
      if (labels.has(label) && !map.has(alias)) map.set(alias, label)
    }
    return map as ReadonlyMap<string, string>
  })().catch((err: unknown) => {
    // Come nel nucleo: una mappa incompleta farebbe sparire in silenzio i CI
    // di un tipo. L'errore esce e non resta in cache.
    cache.delete(tenantId)
    throw err
  })

  cache.set(tenantId, load)
  return load
}

/** I nomi dei tipi CI che questo cliente può nominare, in ordine stabile (messaggi d'errore). */
export async function ciTypeNamesForTenant(tenantId: string): Promise<string[]> {
  return [...(await nameToLabel(tenantId)).keys()].sort()
}

/** L'etichetta del tipo `typeName`, o `null` se questo cliente non ha un tipo così. */
export async function ciLabelForTypeName(tenantId: string, typeName: string): Promise<string | null> {
  return (await nameToLabel(tenantId)).get(typeName.trim().toLowerCase()) ?? null
}

/**
 * Le etichette dei tipi richiesti, **deduplicate e in ordine di richiesta**.
 * Un nome che non è un tipo di questo cliente ferma l'operazione dicendo quale
 * è e quali sono i tipi ammessi: `what` dice da dove viene la richiesta (i
 * criteri di un gruppo, il filtro della topologia, il parametro REST).
 */
export async function ciLabelsForTypeNames(
  tenantId: string,
  typeNames: readonly string[],
  what: string,
): Promise<string[]> {
  const map = await nameToLabel(tenantId)
  const out: string[] = []
  for (const raw of typeNames) {
    const name = raw.trim().toLowerCase()
    if (!name) continue
    const label = map.get(name)
    if (!label) {
      throw new ValidationError(
        `${what}: "${raw}" non è un tipo di CI di questo cliente (ammessi: ${[...map.keys()].sort().join(', ')})`,
      )
    }
    if (!out.includes(label)) out.push(label)
  }
  return out
}

/** Solo per i test: svuota tutto. */
export function clearCITypeNameCache(): void {
  cache.clear()
}
