/**
 * Servizi monitorati — mappa del servizio e albero d'impatto (ondata 1).
 *
 * Un servizio monitorato è una BusinessApplication con una `ServiceMap`: i
 * componenti che la reggono (INCLUDES, con livello, ruolo, peso, critico,
 * «pesa»), le regole d'impatto, la salute calcolata dal motore
 * (services/serviceImpact/engine.ts) con punteggio 0–100 e spiegazione (le
 * cause con il percorso dal nodo malato al livello 1), la cronologia.
 *
 * Progetto: scratchpad service-impact-opengrafo.html (10 set 2026). Contratto
 * ondata 1 condiviso con il web: i nomi qui sotto non si cambiano. Gli enum
 * sono generati da lib/serviceVocabularies.ts (fonte unica con il motore;
 * graphql/__tests__/schemaServices.test.ts confronta enum ↔ liste). I ruoli
 * NON sono scritti nei commenti: la verità è lib/authorization.ts, pinnata
 * campo per campo in lib/__tests__/authorization.test.ts.
 */
import { sdlEnum } from '../lib/serviceVocabularies.js'

export function servicesSDL(): string {
  return `
  # ── Servizi monitorati ──────────────────────────────────────────────────────

  """Salute del servizio: gli stessi termini del CI più maintenance (un componente critico in finestra di change) e unknown (nessun componente con salute)."""
  ${sdlEnum('ServiceHealth')}
  """Stato della mappa: active (valutata dal monitoraggio), paused (nessuna valutazione automatica), draft (ondata 2)."""
  ${sdlEnum('ServiceMapStatus')}
  """Quanto pesa un nodo: always (pesa sempre), never (informativo: si vede sulla mappa, non pesa), weighted (col suo peso). In ondata 1 always e weighted contano allo stesso modo."""
  ${sdlEnum('NodePropagation')}
  """Ruolo del nodo nella mappa, proposto dal tipo del CI (livello 1 = entry)."""
  ${sdlEnum('ServiceNodeRole')}
  """Cosa ha innescato una voce di cronologia del servizio."""
  ${sdlEnum('ServiceHealthTrigger')}

  """Regole d'impatto del servizio (ServiceMap.rules, JSON versionato; modificabili da UI in ondata 2)."""
  type ServiceImpactRules {
    version:          Int!
    """Quota ponderata (%) di componenti giù da cui il servizio è giù."""
    downSharePct:     Int!
    """Punteggio d'impatto (%) da cui il servizio è degradato (1 = basta uno)."""
    degradedSharePct: Int!
    """Numero minimo di componenti non operativi che contano perché il servizio sia degradato."""
    minNodes:         Int!
    """Componenti senza salute: ignore (ignorati) o operational (contano come operativi). Mai «giù»."""
    unknownNodes:     String!
    """Soglia da cui il servizio apre un incident (never | down | degraded; ondata 3)."""
    openIncidentFrom: String!
  }

  """Un componente che ha pesato sulla salute, con il percorso dal componente malato al livello 1 (via)."""
  type ImpactCause {
    ci:       ConfigurationItemRef!
    health:   CIHealth!
    weight:   Int!
    critical: Boolean!
    """Dal componente stesso risalendo via fino al livello 1."""
    path:     [ConfigurationItemRef!]!
  }

  """Un componente della mappa (INCLUDES) con la salute del CI e se conta nel calcolo."""
  type ServiceMapNode {
    ci:            ConfigurationItemRef!
    """1 = applicazione raggiunta via REALIZES, 2.. = componenti; la radice (livello 0) è il servizio stesso, non incluso."""
    level:         Int!
    role:          ServiceNodeRole!
    propagate:     NodePropagation!
    weight:        Int!
    critical:      Boolean!
    """Id del CI da cui si arriva (null al livello 1)."""
    via:           ID
    addedBy:       String!
    """Salute del CI dal monitoraggio; null finché nessun allarme lo ha riguardato."""
    health:        CIHealth
    """Change in finestra sul CI: il componente non pesa (e se è critico il servizio è in manutenzione)."""
    inMaintenance: Boolean!
    """True se il componente conta nel calcolo (pesa, non in finestra, con salute nota o regola unknownNodes = operational)."""
    contributes:   Boolean!
  }

  """Un arco vivo fra due componenti inclusi (tutti i tipi di relazione fra CI, come la topologia)."""
  type ServiceMapEdge {
    source:  ID!
    target:  ID!
    relType: String!
  }

  """Una voce della cronologia del servizio (ServiceMap.history): cambio di salute, creazione, mappa cambiata."""
  type ServiceHealthEntry {
    id:             ID!
    at:             String!
    health:         ServiceHealth!
    previousHealth: ServiceHealth
    impactScore:    Int!
    trigger:        ServiceHealthTrigger!
    """Le cause al momento della voce (istantanea)."""
    causes:         [ImpactCause!]!
    note:           String
  }

  """Il servizio di business (BusinessApplication) a cui la mappa appartiene."""
  type ServiceRef {
    id:          ID!
    name:        String!
    criticality: String
    ownerGroup:  Team
  }

  type ServiceMap {
    id:                ID!
    service:           ServiceRef!
    name:              String!
    status:            ServiceMapStatus!
    """Contatore di modifica della configurazione (parte da 1): da passare come expectedVersion."""
    version:           Int!
    updatedAt:         String
    maxDepth:          Int!
    relationshipTypes: [String!]!
    builtFrom:         String!
    """True se un componente incluso non esiste più nella CMDB (voce map_changed in cronologia)."""
    stale:             Boolean!
    rules:             ServiceImpactRules!
    health:            ServiceHealth!
    healthSince:       String
    """0–100: quota ponderata dei componenti giù (1) e degradati (0,5) fra quelli che contano."""
    impactScore:       Int!
    evaluatedAt:       String
    """Le cause dell'ultima valutazione, dalla più pesante (al più 20)."""
    explanation:       [ImpactCause!]!
    nodes:             [ServiceMapNode!]!
    nodeCount:         Int!
    """Archi vivi fra i componenti inclusi."""
    edges:             [ServiceMapEdge!]!
    """Ultime limit voci (max 500), dalla più recente."""
    history(limit: Int = 100): [ServiceHealthEntry!]!
    historyCount:      Int!
  }

  """Contatori sul tenant (indipendenti dal filtro)."""
  type ServiceMapCounts {
    total:       Int!
    operational: Int!
    degraded:    Int!
    down:        Int!
    maintenance: Int!
    unknown:     Int!
  }

  type ServiceMapPage {
    items:  [ServiceMap!]!
    total:  Int!
    counts: ServiceMapCounts!
  }

  input ServiceMapFilter {
    health: [ServiceHealth!]
    status: ServiceMapStatus
    """Ricerca sul nome del servizio, senza distinzione di maiuscole."""
    search: String
  }

  extend type Query {
    """Pagina Servizi: mappe del tenant ordinate per gravità (down, degraded, maintenance, unknown, operational), poi punteggio d'impatto decrescente, poi nome. limit ≤ 500 (default 50)."""
    serviceMaps(filter: ServiceMapFilter, limit: Int = 50, offset: Int = 0): ServiceMapPage!
    """Dettaglio; null se la mappa non esiste nel tenant."""
    serviceMap(id: ID!): ServiceMap
    """I servizi la cui mappa include il CI, per gravità."""
    servicesImpactedByCI(ciId: ID!): [ServiceMap!]!
    """BusinessApplication del tenant senza mappa (candidate alla creazione), per nome. limit ≤ 100 (default 20)."""
    serviceMapCandidates(search: String, limit: Int = 20): [ServiceRef!]!
  }

  extend type Mutation {
    """Costruzione automatica dalla BusinessApplication (REALIZES → relazioni tecniche in uscita fino a maxDepth, default 4, max 8; relationshipTypes fra DEPENDS_ON, HOSTED_ON, INSTALLED_ON, USES_CERTIFICATE, default tutte), status active, valutazione immediata. Una sola mappa per servizio; oltre 500 componenti → BAD_USER_INPUT."""
    createServiceMap(serviceId: ID!, maxDepth: Int, relationshipTypes: [String!]): ServiceMap!
    """Rivaluta ora (trigger manual)."""
    reevaluateServiceMap(id: ID!): ServiceMap!
    """Cambia lo stato con controllo di concorrenza (expectedVersion = version letta); riattivare una mappa in pausa la rivaluta subito."""
    setServiceMapStatus(id: ID!, expectedVersion: Int!, status: ServiceMapStatus!): ServiceMap!
    """Elimina la mappa e la sua cronologia; il servizio (BusinessApplication) e i CI restano."""
    deleteServiceMap(id: ID!): Boolean!
  }
  `
}
