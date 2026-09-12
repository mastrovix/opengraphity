/**
 * Servizi monitorati — costruzione automatica della mappa (`buildServiceMap`).
 *
 * Dalla BusinessApplication: `REALIZES` verso le applicazioni tecniche
 * (livello 1), poi le relazioni tecniche scelte IN USCITA
 * (`(x)-[:DEPENDS_ON|HOSTED_ON|…]->(y)`: y è un
 * fornitore di x, x soffre se y è giù) fino a `maxDepth`, con
 * `apoc.path.expandConfig` in ampiezza (BFS) e unicità `NODE_GLOBAL`: un
 * nodo raggiungibile da più percorsi entra UNA volta sola, al livello del
 * percorso più corto, con `via` = il predecessore su quel percorso.
 * Oltre SERVICE_MAP_MAX_NODES → ValidationError con il conteggio (mai
 * un taglio silenzioso). Servizio senza REALIZES → mappa vuota consentita
 * (salute `unknown`), con un warning nel log.
 *
 * ## Tre liste che ora sono del cliente (ondata 6 · C-1 / A-10 / C-3)
 * Le etichette ammesse (`$ciLabels`, `labelFilter`), il **ruolo** di ogni nodo
 * e i tipi di relazione percorribili vengono dal metamodello del tenant
 * (`lib/ciLabelsForTenant.ts`, `lib/ciMetamodelForTenant.ts`), non da tre
 * costanti. Prima un CI di un tipo creato dal cliente era scartato dal filtro
 * e non poteva far parte di NESSUNA mappa, in silenzio; e una relazione sua
 * non era percorribile nemmeno scegliendola.
 *
 * La proposta (nodi con livello, via, ruolo, propaga, peso, critico) è pura
 * rispetto alla scrittura: `createServiceMapNode` la persiste in UNA
 * transazione (ServiceMap + INCLUDES); la valutazione iniziale la fa il
 * motore (engine.ts#createServiceMap).
 */
import { runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { apocLabelFilterForTenant, ciLabelsForTenant } from '../../lib/ciLabelsForTenant.js'
import { serviceRelationshipTypesForTenant, serviceRolesForTenant } from '../../lib/ciMetamodelForTenant.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import {
  DEFAULT_SERVICE_IMPACT_RULES_JSON, NODE_WEIGHT_CERTIFICATE, NODE_WEIGHT_DEFAULT, NODE_WEIGHT_ENTRY,
  SERVICE_MAP_MAX_DEPTH, SERVICE_MAP_MAX_NODES, roleOfLabels,
  type NodePropagation, type ServiceMapStatus, type ServiceNodeRole, type ServiceRoleByLabel,
} from '../../lib/serviceVocabularies.js'
import { isRetiredLifecycle, resolveCILifecycleSemantics, type CILifecycleSemantics } from '../../lib/ciLifecycle.js'

const log = logger.child({ module: 'service-impact' })

export interface ProposedNode {
  ciId:      string
  name:      string
  labels:    string[]
  /** Ciclo di vita e salute del CI: servono al diff dell'ondata 2 per mostrare i nuovi componenti come sono adesso. */
  status:    string | null
  health:    string | null
  level:     number
  via:       string | null
  role:      ServiceNodeRole
  propagate: NodePropagation
  weight:    number
  critical:  boolean
}

export interface ServiceMapProposal {
  serviceName:       string
  /** Profondità e relazioni VALIDATE con cui la proposta è stata costruita (vengono salvate sulla mappa). */
  maxDepth:          number
  relationshipTypes: string[]
  nodes:             ProposedNode[]
}

/**
 * Proposta oltre SERVICE_MAP_MAX_NODES: resta un `BAD_USER_INPUT` per chi crea
 * una mappa a mano (stesso messaggio con il conteggio), ma è una classe a sé
 * perché la sincronizzazione automatica (ondata 5, sync.ts) deve distinguerlo
 * da ogni altro errore di validazione: lì non c'è un utente da avvisare, la
 * mappa viene marcata `stale` e la passata registra `skipped_limit`. Mai un
 * taglio silenzioso, in nessuno dei due casi.
 */
export class ServiceMapTooLargeError extends ValidationError {}

/** Profondità 1..SERVICE_MAP_MAX_DEPTH, intera. */
export function assertMaxDepth(maxDepth: number): number {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > SERVICE_MAP_MAX_DEPTH) {
    throw new ValidationError(`maxDepth must be an integer between 1 and ${SERVICE_MAP_MAX_DEPTH}. Got: ${JSON.stringify(maxDepth)}`)
  }
  return maxDepth
}

/**
 * Sottoinsieme non vuoto dei tipi di relazione percorribili **da questo
 * cliente** (`allowed`: i quattro spediti più quelli dichiarati dai suoi tipi,
 * lib/ciMetamodelForTenant.ts), senza doppioni, nell'ordine canonico di
 * `allowed`. Funzione pura: il chiamante risolve `allowed` una volta.
 *
 * Ondata 6 · C-3: prima la lista ammessa era la costante dei quattro tipi
 * spediti, quindi un tipo di relazione del cliente («BILANCIA») non era
 * nemmeno selezionabile e il ramo mancava da ogni mappa.
 */
export function assertRelationshipTypes(types: readonly string[], allowed: readonly string[]): string[] {
  if (types.length === 0) throw new ValidationError(`relationshipTypes must include at least one of: ${allowed.join(', ')}`)
  for (const t of types) {
    if (!allowed.includes(t)) {
      throw new ValidationError(`relationshipTypes: ${JSON.stringify(t)} is not one of ${allowed.join(', ')}`)
    }
  }
  return allowed.filter((t) => types.includes(t))
}

/** Filtro APOC delle relazioni in uscita: `DEPENDS_ON>|HOSTED_ON>|…`. */
export function relationshipFilterOf(types: readonly string[]): string {
  return types.map((t) => `${t}>`).join('|')
}

/**
 * Ruolo, propagazione, peso e criticità proposti per un nodo (contratto ondata
 * 1). Revisione 2 · D6.3: un CI dismesso o fuori servizio (`ci.status`) è
 * proposto con `propagate: never` — si vede sulla mappa ma non conta, perché
 * il monitoraggio non ne aggiorna più la salute.
 *
 * Ondata 7 · C-4: **quali** stati siano «dismesso o fuori servizio» arriva da
 * `semantics` (la semantica del cliente, lib/ciLifecycle.ts), non da una
 * costante: il parametro è obbligatorio perché nessun chiamante possa
 * dimenticarlo e ricadere su una lista di fabbrica.
 */
export function proposeNodeSettings(roles: ServiceRoleByLabel, labels: readonly string[], level: number, status: string | null, semantics: CILifecycleSemantics): Pick<ProposedNode, 'role' | 'propagate' | 'weight' | 'critical'> {
  const role = roleOfLabels(roles, labels, level)
  const retired = isRetiredLifecycle(status, semantics)
  if (role === 'entry') return { role, propagate: retired ? 'never' : 'weighted', weight: NODE_WEIGHT_ENTRY, critical: !retired }
  if (role === 'certificate') return { role, propagate: 'never', weight: NODE_WEIGHT_CERTIFICATE, critical: false }
  return { role, propagate: retired ? 'never' : 'weighted', weight: NODE_WEIGHT_DEFAULT, critical: false }
}

interface EntryRow { serviceName: string; apps: { ciId: string; name: string; labels: string[]; status: string | null; health: string | null }[] }
interface ExpandedRow { ciId: string; name: string; level: number; via: string; labels: string[]; status: string | null; health: string | null }

/** Livello 1: le applicazioni realizzate dal servizio (solo CI del metamodello, stesso tenant). */
export const ENTRY_NODES_CYPHER = `
  MATCH (ba:BusinessApplication {id: $serviceId, tenant_id: $tenantId})
  OPTIONAL MATCH (ba)-[:REALIZES]->(app {tenant_id: $tenantId})
  WHERE ANY(l IN labels(app) WHERE l IN $ciLabels)
  RETURN ba.name AS serviceName,
         [a IN collect(app) | {ciId: a.id, name: a.name, labels: [l IN labels(a) WHERE l <> 'ConfigurationItem'],
                               status: a.status, health: a.health}] AS apps`

/**
 * Livelli 2..maxDepth: espansione BFS dalle applicazioni con unicità globale
 * dei nodi (un nodo una volta sola, sul percorso più corto), solo relazioni
 * in uscita del tipo scelto, solo label del metamodello, tutto nel tenant.
 * `limit` = tetto + 1 così il superamento è rilevabile.
 */
export const EXPAND_NODES_CYPHER = `
  MATCH (app {tenant_id: $tenantId})
  WHERE app.id IN $appIds
  WITH collect(app) AS apps
  CALL apoc.path.expandConfig(apps, {
    relationshipFilter: $relFilter,
    labelFilter:        $labelFilter,
    uniqueness:         'NODE_GLOBAL',
    bfs:                true,
    minLevel:           1,
    maxLevel:           toInteger($maxLevel),
    limit:              toInteger($limit)
  }) YIELD path
  WITH path
  WHERE ALL(n IN nodes(path) WHERE n.tenant_id = $tenantId)
  WITH last(nodes(path)) AS node, length(path) + 1 AS level, nodes(path)[-2] AS pred
  RETURN node.id AS ciId, node.name AS name, level, pred.id AS via,
         [l IN labels(node) WHERE l <> 'ConfigurationItem'] AS labels,
         node.status AS status, node.health AS health
  ORDER BY level, name`

/**
 * Proposta di mappa per la BusinessApplication `serviceId`. Non scrive nulla.
 * Servizio inesistente nel tenant → NotFoundError; oltre il tetto → ValidationError.
 */
export async function buildServiceMap(session: Queryable, tenantId: string, serviceId: string, maxDepth: number, relationshipTypes: readonly string[]): Promise<ServiceMapProposal> {
  const depth = assertMaxDepth(maxDepth)
  const types = assertRelationshipTypes(relationshipTypes, await serviceRelationshipTypesForTenant(tenantId))
  // Etichette e ruoli vengono dal metamodello DI QUESTO cliente, risolti una
  // volta per costruzione (ondata 6 · C-1/A-10): il filtro e il ruolo sono due
  // metà della stessa cosa — aprire il filtro senza i ruoli farebbe fallire la
  // proposta sul primo nodo di un tipo del cliente.
  const ciLabels = await ciLabelsForTenant(tenantId)
  const roles = await serviceRolesForTenant(tenantId)
  const semantics = await resolveCILifecycleSemantics(tenantId)

  const entry = await runQueryOne<EntryRow>(session, ENTRY_NODES_CYPHER, { serviceId, tenantId, ciLabels: [...ciLabels] })
  if (!entry) throw new NotFoundError('BusinessApplication', serviceId)
  const apps = entry.apps
  if (apps.length === 0) {
    log.warn({ tenantId, serviceId, serviceName: entry.serviceName }, 'BusinessApplication has no REALIZES: the service map will be empty (health unknown)')
    return { serviceName: entry.serviceName, maxDepth: depth, relationshipTypes: types, nodes: [] }
  }

  const nodes: ProposedNode[] = apps.map((a) => ({ ciId: a.ciId, name: a.name ?? '', labels: a.labels, status: a.status ?? null, health: a.health ?? null, level: 1, via: null, ...proposeNodeSettings(roles, a.labels, 1, a.status ?? null, semantics) }))
  if (depth > 1) {
    const expanded = await runQuery<ExpandedRow>(session, EXPAND_NODES_CYPHER, {
      tenantId, appIds: apps.map((a) => a.ciId),
      relFilter: relationshipFilterOf(types), labelFilter: await apocLabelFilterForTenant(tenantId),
      maxLevel: depth - 1, limit: SERVICE_MAP_MAX_NODES + 1,
    })
    // Precedenza del percorso più corto: le righe arrivano per livello e
    // l'unicità NODE_GLOBAL di APOC dà ogni nodo una volta; se un nodo
    // ricompare (o coincide con un'applicazione di livello 1) vince la prima
    // occorrenza — il livello più basso e il suo `via`.
    const seen = new Set(nodes.map((n) => n.ciId))
    for (const r of expanded) {
      if (seen.has(r.ciId)) continue
      seen.add(r.ciId)
      nodes.push({ ciId: r.ciId, name: r.name ?? '', labels: r.labels, status: r.status ?? null, health: r.health ?? null, level: r.level, via: r.via, ...proposeNodeSettings(roles, r.labels, r.level, r.status ?? null, semantics) })
    }
  }
  if (nodes.length > SERVICE_MAP_MAX_NODES) {
    throw new ServiceMapTooLargeError(`Service map for "${entry.serviceName}" would exceed ${SERVICE_MAP_MAX_NODES} nodes (at least ${nodes.length} reached with maxDepth ${depth} over ${types.join(', ')}): reduce maxDepth or the relationship types`)
  }
  return { serviceName: entry.serviceName, maxDepth: depth, relationshipTypes: types, nodes }
}

export interface CreateServiceMapNodeInput {
  tenantId:  string
  serviceId: string
  mapId:     string
  status:    ServiceMapStatus
  /** Mappa viva (default) o congelata: ondata 5, services/serviceImpact/sync.ts. */
  autoSync:  boolean
  proposal:  ServiceMapProposal
  actorId:   string
  now:       string
}

/**
 * Scrittura della mappa: ServiceMap + INCLUDES in uno statement. `node_ids`
 * conserva gli id inclusi (per rilevare i nodi spariti: la mappa diventa
 * stale). `auto_sync` dice se la mappa si aggiorna da sola quando cambia la
 * CMDB (ondata 5) e `synced_at` nasce null: la mappa appena costruita È
 * allineata al grafo, ma non l'ha ancora sincronizzata nessuno.
 */
export const CREATE_SERVICE_MAP_CYPHER = `
  MATCH (ba:BusinessApplication {id: $serviceId, tenant_id: $tenantId})
  WHERE NOT EXISTS { (ba)-[:HAS_SERVICE_MAP]->(:ServiceMap {tenant_id: $tenantId}) }
  CREATE (ba)-[:HAS_SERVICE_MAP]->(m:ServiceMap {
    id: $mapId, tenant_id: $tenantId, service_id: ba.id, name: ba.name, status: $status, version: 1,
    updated_at: $now, updated_by: $actorId, built_from: 'auto', max_depth: toInteger($maxDepth),
    relationship_types: $relationshipTypes, rules: $rules,
    health: 'unknown', health_since: null, impact_score: 0, explanation: '[]', stale: false, evaluated_at: null,
    auto_sync: $autoSync, synced_at: null,
    node_ids: [n IN $nodes | n.ciId], created_at: $now
  })
  WITH m
  CALL {
    WITH m
    UNWIND $nodes AS n
    MATCH (ci {id: n.ciId, tenant_id: $tenantId})
    CREATE (m)-[:INCLUDES {level: toInteger(n.level), role: n.role, propagate: n.propagate, weight: toInteger(n.weight),
                           critical: n.critical, via: n.via, added_by: 'auto', added_at: $now}]->(ci)
    RETURN count(ci) AS linked
  }
  RETURN m.id AS id, linked`

/**
 * Persiste la proposta. Una sola mappa per servizio: se esiste già (anche
 * creata da un'altra richiesta nel frattempo) lo statement non scrive nulla →
 * ValidationError. Un CI della proposta sparito fra proposta e scrittura →
 * errore (la transazione del chiamante non viene committata).
 */
export async function createServiceMapNode(tx: Queryable, input: CreateServiceMapNodeInput): Promise<void> {
  const nodes = input.proposal.nodes.map((n) => ({ ciId: n.ciId, level: n.level, role: n.role, propagate: n.propagate, weight: n.weight, critical: n.critical, via: n.via }))
  const row = await runQueryOne<{ id: string; linked: number }>(tx, CREATE_SERVICE_MAP_CYPHER, {
    serviceId: input.serviceId, tenantId: input.tenantId, mapId: input.mapId, status: input.status, autoSync: input.autoSync,
    maxDepth: input.proposal.maxDepth, relationshipTypes: [...input.proposal.relationshipTypes], rules: DEFAULT_SERVICE_IMPACT_RULES_JSON,
    nodes, actorId: input.actorId, now: input.now,
  })
  if (!row) throw new ValidationError(`BusinessApplication ${input.serviceId} already has a service map (one map per service) or does not exist in tenant ${input.tenantId}`)
  if (Number(row.linked) !== nodes.length) {
    throw new Error(`Service map ${input.mapId}: ${Number(row.linked)} of ${nodes.length} proposed nodes could be linked (a CI vanished between proposal and creation)`)
  }
}
