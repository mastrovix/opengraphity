/**
 * Servizi monitorati — mappa del servizio e albero d'impatto (ondata 1).
 *
 * Un servizio monitorato è una BusinessApplication con una `ServiceMap`: i
 * componenti che la reggono (INCLUDES, con livello, ruolo, peso, critico,
 * «pesa»), le regole d'impatto, la salute calcolata dal motore
 * (services/serviceImpact/engine.ts) con punteggio 0–100 e spiegazione (le
 * cause con il percorso dal nodo malato al livello 1), la cronologia.
 *
 * Ondata 2: tutto configurabile da interfaccia — regole e impostazioni dei
 * componenti modificabili con controllo di concorrenza (`expectedVersion`),
 * diff con il grafo di adesso (`serviceMapProposal`) da applicare a scelta,
 * esclusioni permanenti e anteprima del calcolo senza scrivere
 * (`serviceImpactPreview`).
 *
 * Ondata 3: il servizio esce dalla sua pagina — l'incident aperto dal
 * monitoraggio (`ServiceMap.openIncident`, `Incident.impactedServices`) e le
 * capacità di business in sola lettura (`businessCapabilitiesHealth`).
 *
 * Progetto: scratchpad service-impact-opengrafo.html (10 set 2026). Contratto
 * condiviso con il web: i nomi qui sotto non si cambiano. Gli enum
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
  """Stato della mappa: active (valutata dal monitoraggio), paused (nessuna valutazione automatica), draft (bozza)."""
  ${sdlEnum('ServiceMapStatus')}
  """Quanto pesa un nodo: always (pesa sempre), never (informativo: si vede sulla mappa, non pesa), weighted (col suo peso). In ondata 1 always e weighted contano allo stesso modo."""
  ${sdlEnum('NodePropagation')}
  """Ruolo del nodo nella mappa, proposto dal tipo del CI (livello 1 = entry)."""
  ${sdlEnum('ServiceNodeRole')}
  """Cosa ha innescato una voce di cronologia del servizio."""
  ${sdlEnum('ServiceHealthTrigger')}
  """Come contano i componenti senza salute (mai toccati da un allarme): ignorati o come operativi. Mai «giù»."""
  ${sdlEnum('UnknownNodesMode')}
  """Soglia di salute da cui il servizio apre un incident (gli incident per servizio arrivano in ondata 3)."""
  ${sdlEnum('ServiceOpenIncidentFrom')}
  """Perché la mappa è da rivedere: un componente non esiste più (missing_ci) o la proposta supera il tetto (over_limit)."""
  ${sdlEnum('ServiceStaleReason')}
  """Cosa fa la mappa mentre una sorgente degli allarmi dei suoi componenti è in tempesta: hold (sospendi la valutazione, default) o evaluate (valuta comunque)."""
  ${sdlEnum('DuringStormMode')}

  """Regole d'impatto del servizio (ServiceMap.rules, JSON versionato; modificabili da UI)."""
  type ServiceImpactRules {
    version:          Int!
    """Quota ponderata (%) di componenti giù da cui il servizio è giù."""
    downSharePct:     Int!
    """Punteggio d'impatto (%) da cui il servizio è degradato (1 = basta uno)."""
    degradedSharePct: Int!
    """Numero minimo di componenti non operativi che contano perché il servizio sia degradato."""
    minNodes:         Int!
    """Componenti senza salute: ignore (ignorati) o operational (contano come operativi). Mai «giù»."""
    unknownNodes:     UnknownNodesMode!
    """Soglia da cui il servizio apre un incident (ondata 3)."""
    openIncidentFrom: ServiceOpenIncidentFrom!
    """Durante una tempesta della sorgente: hold (default) sospende la valutazione — salute e incident restano come sono — evaluate la fa comunque."""
    duringStorm:      DuringStormMode!
  }

  """Regole d'impatto da salvare: degradedSharePct ≤ downSharePct e minNodes ≤ numero di componenti della mappa, altrimenti BAD_USER_INPUT."""
  input ServiceImpactRulesInput {
    downSharePct:     Int!
    degradedSharePct: Int!
    minNodes:         Int!
    unknownNodes:     UnknownNodesMode!
    openIncidentFrom: ServiceOpenIncidentFrom!
    duringStorm:      DuringStormMode!
  }

  """Impostazioni di un componente: ciò che l'amministratore può cambiare (ruolo, livello e via restano della mappa)."""
  input ServiceMapNodeInput {
    ciId:      ID!
    propagate: NodePropagation!
    """1..10."""
    weight:    Int!
    critical:  Boolean!
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
    """Change in finestra sul CI o su un CI a monte (suppressUpstreamHops della policy allarmi): il componente non pesa (e se è critico il servizio è in manutenzione). Il ciclo di vita ci.status = maintenance è un'altra cosa: si legge da ci.status e da excludedReason."""
    inMaintenance: Boolean!
    """True se il componente conta nel calcolo (pesa, non in finestra, non in manutenzione di ciclo di vita, con salute nota o regola unknownNodes = operational)."""
    contributes:   Boolean!
    """Perché non conta: never (propagate never), lifecycle_decommissioned (CI dismesso o fuori servizio), change_window (change in finestra sul CI), upstream_change_window (change in finestra su un CI a monte), lifecycle_maintenance (ci.status = maintenance), unknown_health (senza salute con unknownNodes = ignore). null se conta."""
    excludedReason: String
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
    """True se la mappa è da rivedere: un componente incluso non esiste più nella CMDB, oppure la sincronizzazione è stata rifiutata dal tetto dei 500 (voce map_changed in cronologia)."""
    stale:             Boolean!
    """Perché la mappa è da rivedere: si azzera insieme a stale, null quando la mappa è a posto (o è stata marcata prima della migrazione 20260910_1120)."""
    staleReason:       ServiceStaleReason
    """Mappa viva: i componenti si aggiornano da soli quando cambia la CMDB (default). False = mappa congelata, il diff si applica a mano. Le esclusioni e i componenti aggiunti a mano restano in entrambi i casi."""
    autoSync:          Boolean!
    """Ultima sincronizzazione con la CMDB; null se non è mai stata sincronizzata."""
    syncedAt:          String
    rules:             ServiceImpactRules!
    health:            ServiceHealth!
    """Salute che il servizio avrebbe senza la finestra di change in corso: valorizzata solo quando health = maintenance."""
    healthIfActive:    ServiceHealth
    """Perché la salute è questa, quando non basta l'elenco delle cause (es. sorgente in tempesta con duringStorm = hold, o componenti in finestra di change a monte). null quando non c'è nulla da spiegare."""
    healthNote:        String
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
    """I CI che l'amministratore ha escluso: non vengono più riproposti dal diff (serviceMapProposal)."""
    excluded:          [ConfigurationItemRef!]!
    """L'incident non chiuso aperto dal monitoraggio per questo servizio (IMPACTS_SERVICE); null se non ce n'è. Con rules.openIncidentFrom = never non ne nascono di nuovi."""
    openIncident:      Incident
  }

  extend type Incident {
    """I servizi la cui salute ha aperto questo incident (IMPACTS_SERVICE), per gravità. Vuoto per gli incident che non vengono dai servizi monitorati."""
    impactedServices:  [ServiceMap!]!
  }

  # ── Capacità di business (sola lettura) ─────────────────────────────────────

  """Una BusinessCapability con la salute dei servizi che la abilitano (ENABLED_BY → BusinessApplication con mappa)."""
  type BusinessCapabilityHealth {
    id:               ID!
    name:             String!
    """La peggiore fra i servizi collegati con una salute nota; unknown se nessuno ne ha una (o se non ci sono servizi collegati)."""
    health:           ServiceHealth!
    """I servizi che abilitano la capacità, per gravità poi per nome."""
    services:         [ServiceRef!]!
    downServices:     Int!
    degradedServices: Int!
  }

  """Un componente della proposta, con le impostazioni che avrebbe se venisse incluso."""
  type ServiceMapProposalNode {
    ci:        ConfigurationItemRef!
    level:     Int!
    role:      ServiceNodeRole!
    propagate: NodePropagation!
    weight:    Int!
    critical:  Boolean!
    via:       ID
  }

  """Un componente che nel grafo di adesso sta a un livello (o dietro un via) diverso da quello della mappa."""
  type ServiceMapMovedNode {
    ci:            ConfigurationItemRef!
    level:         Int!
    proposedLevel: Int!
    via:           ID
    proposedVia:   ID
  }

  """Diff fra la mappa attuale e quella che si costruirebbe adesso dal grafo (nessuna scrittura)."""
  type ServiceMapProposal {
    mapId:             ID!
    version:           Int!
    maxDepth:          Int!
    relationshipTypes: [String!]!
    """Nel grafo, non nella mappa, non esclusi."""
    added:             [ServiceMapProposalNode!]!
    """Nella mappa e non più raggiungibili; un CI cancellato dalla CMDB compare con livello 0, ruolo component e addedBy «gone» (della mappa resta solo il suo id)."""
    removed:           [ServiceMapNode!]!
    """Livello o via cambiati."""
    moved:             [ServiceMapMovedNode!]!
    """Esclusioni attive: non vengono riproposte."""
    excluded:          [ConfigurationItemRef!]!
    """Nodi della proposta senza gli esclusi (per il tetto di 500)."""
    totalProposed:     Int!
  }

  """Esito di «Sincronizza ora»: la mappa aggiornata e cosa è stato applicato."""
  type ServiceMapSyncResult {
    map:     ServiceMap!
    added:   Int!
    removed: Int!
    moved:   Int!
    """True se la sincronizzazione è stata rifiutata (tetto dei 500): nulla è stato applicato."""
    skipped: Boolean!
    """Motivo leggibile quando skipped = true, altrimenti null."""
    reason:  String
  }

  """Esito del calcolo con impostazioni ipotetiche sugli allarmi di adesso: nessuna scrittura."""
  type ServiceImpactPreview {
    health:            ServiceHealth!
    impactScore:       Int!
    causes:            [ImpactCause!]!
    """Componenti che pesano nel calcolo con queste impostazioni."""
    contributingCount: Int!
    nodeCount:         Int!
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
    """Criticità dell'applicazione radice (vocabolario del metamodello: mission_critical, business_critical, business_operational, office_productivity). Il banner dei servizi critici filtra qui, invece di leggere una pagina e scartare a valle."""
    criticality: [String!]
    """Solo i servizi la cui mappa include questo CI."""
    ciId: ID
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
    """Diff fra la mappa e il grafo di adesso (stessi maxDepth e relationshipTypes della mappa): cosa aggiungere, togliere, spostare. Non scrive nulla."""
    serviceMapProposal(id: ID!): ServiceMapProposal!
    """«Con queste impostazioni adesso»: la salute che il servizio avrebbe con le regole e/o i componenti passati (il resto resta com'è). Nessuna scrittura; un ciId non nella mappa è un errore."""
    serviceImpactPreview(id: ID!, rules: ServiceImpactRulesInput, nodes: [ServiceMapNodeInput!]): ServiceImpactPreview!
    """Le capacità di business del tenant con la salute dei servizi che le abilitano, per gravità poi per nome. Sola lettura: nessun nodo nuovo, nessuna modifica."""
    businessCapabilitiesHealth: [BusinessCapabilityHealth!]!
  }

  extend type Mutation {
    """Costruzione automatica dalla BusinessApplication (REALIZES → relazioni tecniche in uscita fino a maxDepth, default 4, max 8; relationshipTypes fra DEPENDS_ON, HOSTED_ON, INSTALLED_ON, USES_CERTIFICATE, default tutte), status active (o draft per una bozza), valutazione immediata. Una sola mappa per servizio; oltre 500 componenti → BAD_USER_INPUT."""
    createServiceMap(serviceId: ID!, maxDepth: Int, relationshipTypes: [String!], status: ServiceMapStatus, autoSync: Boolean): ServiceMap!
    """Rivaluta ora (trigger manual)."""
    reevaluateServiceMap(id: ID!): ServiceMap!
    """Cambia lo stato con controllo di concorrenza (expectedVersion = version letta); rimettere in servizio una mappa (da paused o da draft) la rivaluta subito."""
    setServiceMapStatus(id: ID!, expectedVersion: Int!, status: ServiceMapStatus!): ServiceMap!
    """Salva le regole d'impatto (voce di cronologia rules_changed con i campi cambiati) e rivaluta subito, tranne le mappe in pausa."""
    updateServiceImpactRules(id: ID!, expectedVersion: Int!, rules: ServiceImpactRulesInput!): ServiceMap!
    """Cambia propagate, weight e critical dei soli componenti passati (elenco vuoto o ciId non nella mappa → BAD_USER_INPUT) e rivaluta subito, tranne le mappe in pausa."""
    updateServiceMapNodes(id: ID!, expectedVersion: Int!, nodes: [ServiceMapNodeInput!]!): ServiceMap!
    """Applica le scelte fatte sul diff: add = CI della proposta da includere, exclude = CI da non riproporre mai più (e da togliere, se inclusi), remove = CI inclusi (o spariti dalla CMDB) da togliere. Tutto in una transazione; poi rivaluta, tranne le mappe in pausa."""
    applyServiceMapProposal(id: ID!, expectedVersion: Int!, add: [ID!]!, exclude: [ID!]!, remove: [ID!]!): ServiceMap!
    """Riammette un CI escluso: tornerà nella prossima proposta."""
    removeServiceMapExclusion(id: ID!, expectedVersion: Int!, ciId: ID!): ServiceMap!
    """Accende o spegne l'aggiornamento automatico dei componenti (mappa viva o congelata), con controllo di concorrenza; voce di cronologia map_changed. Non rivaluta la mappa: cambia solo il modo in cui i componenti seguono la CMDB."""
    setServiceMapAutoSync(id: ID!, expectedVersion: Int!, autoSync: Boolean!): ServiceMap!
    """Sincronizza subito i componenti con la CMDB (aggiunge i nuovi, toglie quelli automatici spariti, aggiorna livello e via); i componenti aggiunti a mano e le esclusioni restano. Funziona anche sulle mappe congelate (è un'azione esplicita), non su quelle in pausa. Oltre 500 componenti non applica nulla, marca la mappa da rivedere e torna skipped = true con il motivo."""
    syncServiceMap(id: ID!): ServiceMapSyncResult!
    """Elimina la mappa e la sua cronologia; il servizio (BusinessApplication) e i CI restano."""
    deleteServiceMap(id: ID!): Boolean!
  }
  `
}
