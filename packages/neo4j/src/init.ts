import { pathToFileURL } from 'node:url'
import { getDriver, closeDriver } from './driver.js'
import { runMigrations, type Migration } from './migrations.js'
import neo4j from 'neo4j-driver'

interface SchemaStatement {
  label: string
  cypher: string
}

/**
 * Le etichette dell'indice fulltext `global_search` — sorgente unica condivisa
 * con la migrazione che lo ricrea sui database già avviati
 * (`20260916_1700_global_search_configuration_item`), perché due elenchi che
 * divergono darebbero una ricerca che funziona sui sistemi nuovi e non su
 * quelli vecchi, senza che nessuno se ne accorga.
 *
 * I CI stanno qui per `:ConfigurationItem` (ondata 6, A6-2): gli indici
 * fulltext non si estendono a runtime, quindi elencare i tipi voleva dire che
 * un tipo creato dal cliente non era cercabile.
 */
export const GLOBAL_SEARCH_LABELS: readonly string[] = [
  'Incident', 'Change', 'Problem', 'ServiceRequest', 'KBArticle', 'ConfigurationItem',
]

/** Le proprietà indicizzate da `global_search`, nello stesso ordine. */
export const GLOBAL_SEARCH_PROPERTIES: readonly string[] = ['title', 'number', 'code', 'name']

const CONSTRAINTS: SchemaStatement[] = [
  {
    label: 'Tenant.id',
    cypher: 'CREATE CONSTRAINT tenant_id_unique IF NOT EXISTS FOR (n:Tenant) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'User.id',
    cypher: 'CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (n:User) REQUIRE n.id IS UNIQUE',
  },
  // Identity is realm-bound (auth/resolveAuth.ts matches on email + tenant_id):
  // the same email may exist in several tenants, never twice in one. Neo4j
  // refuses a uniqueness constraint while a plain index on the same
  // (label, properties) exists, so the former `user_tenant_email` range index
  // is dropped first — the constraint's backing index replaces it.
  {
    label: 'drop range index user_tenant_email (superseded by user_tenant_email_unique)',
    cypher: 'DROP INDEX user_tenant_email IF EXISTS',
  },
  {
    label: 'User(tenant_id, email)',
    cypher: 'CREATE CONSTRAINT user_tenant_email_unique IF NOT EXISTS FOR (n:User) REQUIRE (n.tenant_id, n.email) IS UNIQUE',
  },
  {
    label: 'ConfigurationItem.id',
    cypher: 'CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (n:ConfigurationItem) REQUIRE n.id IS UNIQUE',
  },
  // Discovery reconciliation key: one CI per (tenant, source, external id).
  // The engine MERGEs on this key; the constraint makes a duplicate impossible
  // even under concurrent syncs. Manually created CIs carry none of the
  // discovery_* properties and are NOT subject to it (Neo4j ignores nodes
  // where any constrained property is null). The former plain range index on
  // the same schema must go first (Neo4j refuses the constraint otherwise);
  // the constraint's backing index replaces it for the lookups.
  {
    label: 'drop range index ci_discovery_key (superseded by ci_discovery_key_unique)',
    cypher: 'DROP INDEX ci_discovery_key IF EXISTS',
  },
  {
    label: 'ConfigurationItem(tenant_id, discovery_source_id, discovery_external_id)',
    cypher: 'CREATE CONSTRAINT ci_discovery_key_unique IF NOT EXISTS FOR (n:ConfigurationItem) REQUIRE (n.tenant_id, n.discovery_source_id, n.discovery_external_id) IS UNIQUE',
  },
  {
    label: 'Incident.id',
    cypher: 'CREATE CONSTRAINT incident_id_unique IF NOT EXISTS FOR (n:Incident) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'Change.id',
    cypher: 'CREATE CONSTRAINT change_id_unique IF NOT EXISTS FOR (n:Change) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'WorkflowInstance.id',
    cypher: 'CREATE CONSTRAINT workflow_instance_id_unique IF NOT EXISTS FOR (n:WorkflowInstance) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'FormTemplate.id',
    cypher: 'CREATE CONSTRAINT form_template_id_unique IF NOT EXISTS FOR (n:FormTemplate) REQUIRE n.id IS UNIQUE',
  },
  /**
   * L'etichetta vera è `SLAPolicyNode` (revisione totale · E-25): il vincolo
   * era su `SLAPolicy`, che l'applicazione non usa — un vincolo morto, e
   * NESSUNA unicità sull'id delle policy vere, quindi due creazioni
   * concorrenti con lo stesso id passavano. Verificato sul grafo: zero nodi
   * `:SLAPolicy`, quindi non c'è niente da migrare.
   */
  {
    label: 'SLAPolicyNode.id',
    cypher: 'CREATE CONSTRAINT sla_policy_node_id_unique IF NOT EXISTS FOR (n:SLAPolicyNode) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'Problem.id',
    cypher: 'CREATE CONSTRAINT problem_id_unique IF NOT EXISTS FOR (n:Problem) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'ServiceRequest.id',
    cypher: 'CREATE CONSTRAINT service_request_id_unique IF NOT EXISTS FOR (n:ServiceRequest) REQUIRE n.id IS UNIQUE',
  },
  // Discovery / Sync
  {
    label: 'SyncSource.id',
    cypher: 'CREATE CONSTRAINT sync_source_id_unique IF NOT EXISTS FOR (n:SyncSource) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'SyncRun.id',
    cypher: 'CREATE CONSTRAINT sync_run_id_unique IF NOT EXISTS FOR (n:SyncRun) REQUIRE n.id IS UNIQUE',
  },
  {
    label: 'SyncConflict.id',
    cypher: 'CREATE CONSTRAINT sync_conflict_id_unique IF NOT EXISTS FOR (n:SyncConflict) REQUIRE n.id IS UNIQUE',
  },
  // Human-facing number/code uniqueness per tenant — the safety net behind the
  // atomic Counter (apps/api/src/lib/sequence.ts). Previously only some existed
  // ad-hoc in the DB and were missing from source (Change had none effective:
  // its constraint was on the always-null `number`, the real key is `code`).
  {
    label: 'Incident(tenant_id, number)',
    cypher: 'CREATE CONSTRAINT incident_number_unique IF NOT EXISTS FOR (n:Incident) REQUIRE (n.tenant_id, n.number) IS UNIQUE',
  },
  {
    label: 'Problem(tenant_id, number)',
    cypher: 'CREATE CONSTRAINT problem_number_unique IF NOT EXISTS FOR (n:Problem) REQUIRE (n.tenant_id, n.number) IS UNIQUE',
  },
  {
    label: 'ServiceRequest(tenant_id, number)',
    cypher: 'CREATE CONSTRAINT service_request_number_unique IF NOT EXISTS FOR (n:ServiceRequest) REQUIRE (n.tenant_id, n.number) IS UNIQUE',
  },
  {
    label: 'Change(tenant_id, code)',
    cypher: 'CREATE CONSTRAINT change_code_unique IF NOT EXISTS FOR (n:Change) REQUIRE (n.tenant_id, n.code) IS UNIQUE',
  },
  /**
   * IL COMPITO GENERICO (20 set 2026). Tre invarianti che il codice già
   * rispetta e che qui diventano dichiarate — e imposte dal database, che è
   * l'unico posto dove una regola non si aggira:
   *  - l'id è unico, come per ogni altra entità;
   *  - la CHIAVE NATURALE `ticket + passo + azione` è unica: è quella che
   *    impedisce i doppioni quando un ticket rientra in un passo. La MERGE
   *    da sola regge (provato con cinque scritture simultanee: un compito
   *    solo), ma con il vincolo l'invariante è scritta invece che sperata;
   *  - il numero leggibile è unico nel cliente, come per i ticket.
   */
  {
    label:  'Task.id unique',
    cypher: 'CREATE CONSTRAINT task_id_unique IF NOT EXISTS FOR (k:Task) REQUIRE k.id IS UNIQUE',
  },
  {
    label:  'Task(tenant_id, task_key) unique',
    cypher: 'CREATE CONSTRAINT task_key_unique IF NOT EXISTS FOR (k:Task) REQUIRE (k.tenant_id, k.task_key) IS UNIQUE',
  },
  {
    label:  'Task(tenant_id, code) unique',
    cypher: 'CREATE CONSTRAINT task_code_unique IF NOT EXISTS FOR (k:Task) REQUIRE (k.tenant_id, k.code) IS UNIQUE',
  },
  /**
   * LE PROPOSTE DI MIGLIORAMENTO (20 set 2026) — e il vincolo che il modello
   * copiato NON aveva.
   *
   * Il progetto dice «modellata su `:Anomaly`». Lo è, tranne qui: su
   * `:Anomaly` c'è un `MERGE (a {tenant_id, rule_key, entity_id})` con tre
   * indici e NESSUN vincolo, quindi due scansioni sovrapposte — l'oraria e
   * quella a richiesta — possono duplicare. La promessa «stessa osservazione
   * = stessa impronta = nessun doppione» senza vincolo è vuota, e qui la
   * promessa regge il tetto di cinque proposte aperte: un doppione ruba uno
   * slot a una proposta vera.
   */
  {
    label:  'Proposal.id unique',
    cypher: 'CREATE CONSTRAINT proposal_id_unique IF NOT EXISTS FOR (p:Proposal) REQUIRE p.id IS UNIQUE',
  },
  {
    label:  'Proposal(tenant_id, area, fingerprint) unique',
    cypher: 'CREATE CONSTRAINT proposal_fingerprint_unique IF NOT EXISTS FOR (p:Proposal) REQUIRE (p.tenant_id, p.area, p.fingerprint) IS UNIQUE',
  },
  /**
   * Il nome di un calendario di servizio è unico DAVVERO (revisione totale ·
   * C-34): l'unicità era controllata da una lettura fuori dalla transazione di
   * creazione, quindi due admin che salvavano «Ufficio» nello stesso istante
   * passavano entrambi e la tendina mostrava due calendari omonimi. La chiave
   * è `name_key` = toLower(name), come per i CI: il confronto del prodotto non
   * distingue le maiuscole.
   */
  {
    label: 'ServiceCalendar(tenant_id, name_key)',
    cypher: 'CREATE CONSTRAINT service_calendar_name_unique IF NOT EXISTS FOR (n:ServiceCalendar) REQUIRE (n.tenant_id, n.name_key) IS UNIQUE',
  },
  {
    // F18: `number` sulle change come sugli altri ticket (stesso valore di `code`).
    label: 'Change(tenant_id, number)',
    cypher: 'CREATE CONSTRAINT change_number_unique IF NOT EXISTS FOR (n:Change) REQUIRE (n.tenant_id, n.number) IS UNIQUE',
  },
  { label: 'ServiceCatalogItem.id', cypher: 'CREATE CONSTRAINT service_catalog_item_id_unique IF NOT EXISTS FOR (n:ServiceCatalogItem) REQUIRE n.id IS UNIQUE' },
  { label: 'KBArticleVersion.id', cypher: 'CREATE CONSTRAINT kb_article_version_id_unique IF NOT EXISTS FOR (n:KBArticleVersion) REQUIRE n.id IS UNIQUE' },
  { label: 'OLAContract.id', cypher: 'CREATE CONSTRAINT ola_contract_id_unique IF NOT EXISTS FOR (n:OLAContract) REQUIRE n.id IS UNIQUE' },
  { label: 'ServiceCalendar.id', cypher: 'CREATE CONSTRAINT service_calendar_id_unique IF NOT EXISTS FOR (n:ServiceCalendar) REQUIRE n.id IS UNIQUE' },
  {
    label: 'Counter(tenant_id, kind)',
    cypher: 'CREATE CONSTRAINT counter_key_unique IF NOT EXISTS FOR (n:Counter) REQUIRE (n.tenant_id, n.kind) IS UNIQUE',
  },
  // Consolidated from the former infra/neo4j/init/constraints.cypher — per-label
  // CI id uniqueness (GraphQL CIs carry only their type label, not :ConfigurationItem)
  { label: 'BusinessCapability.id', cypher: 'CREATE CONSTRAINT unique_business_capability_id IF NOT EXISTS FOR (n:BusinessCapability) REQUIRE n.id IS UNIQUE' },
  { label: 'BusinessApplication.id', cypher: 'CREATE CONSTRAINT unique_business_application_id IF NOT EXISTS FOR (n:BusinessApplication) REQUIRE n.id IS UNIQUE' },
  { label: 'Application.id', cypher: 'CREATE CONSTRAINT unique_application_id IF NOT EXISTS FOR (n:Application) REQUIRE n.id IS UNIQUE' },
  { label: 'Database.id', cypher: 'CREATE CONSTRAINT unique_database_id IF NOT EXISTS FOR (n:Database) REQUIRE n.id IS UNIQUE' },
  { label: 'DatabaseInstance.id', cypher: 'CREATE CONSTRAINT unique_database_instance_id IF NOT EXISTS FOR (n:DatabaseInstance) REQUIRE n.id IS UNIQUE' },
  { label: 'Server.id', cypher: 'CREATE CONSTRAINT unique_server_id IF NOT EXISTS FOR (n:Server) REQUIRE n.id IS UNIQUE' },
  { label: 'Certificate.id', cypher: 'CREATE CONSTRAINT unique_certificate_id IF NOT EXISTS FOR (n:Certificate) REQUIRE n.id IS UNIQUE' },
  { label: 'SslCertificate.id', cypher: 'CREATE CONSTRAINT unique_ssl_certificate_id IF NOT EXISTS FOR (n:SslCertificate) REQUIRE n.id IS UNIQUE' },
  { label: 'VirtualMachine.id', cypher: 'CREATE CONSTRAINT unique_virtual_machine_id IF NOT EXISTS FOR (n:VirtualMachine) REQUIRE n.id IS UNIQUE' },
  { label: 'NetworkDevice.id', cypher: 'CREATE CONSTRAINT unique_network_device_id IF NOT EXISTS FOR (n:NetworkDevice) REQUIRE n.id IS UNIQUE' },
  { label: 'Storage.id', cypher: 'CREATE CONSTRAINT unique_storage_id IF NOT EXISTS FOR (n:Storage) REQUIRE n.id IS UNIQUE' },
  { label: 'CloudService.id', cypher: 'CREATE CONSTRAINT unique_cloud_service_id IF NOT EXISTS FOR (n:CloudService) REQUIRE n.id IS UNIQUE' },
  { label: 'ApiEndpoint.id', cypher: 'CREATE CONSTRAINT unique_api_endpoint_id IF NOT EXISTS FOR (n:ApiEndpoint) REQUIRE n.id IS UNIQUE' },
  { label: 'Microservice.id', cypher: 'CREATE CONSTRAINT unique_microservice_id IF NOT EXISTS FOR (n:Microservice) REQUIRE n.id IS UNIQUE' },
  { label: 'DynamicCIGroup.id', cypher: 'CREATE CONSTRAINT unique_dynamic_c_i_group_id IF NOT EXISTS FOR (n:DynamicCIGroup) REQUIRE n.id IS UNIQUE' },
  // D-15 — labels looked up on every request/event that had no schema at all.
  // ApiKey.key_hash: `apiKeyAuth.ts` MATCHes on it for every REST v1 call
  // (was a full label scan) and two keys with the same hash would be a
  // security bug, hence UNIQUE rather than a plain index.
  { label: 'ApiKey.key_hash', cypher: 'CREATE CONSTRAINT api_key_hash_unique IF NOT EXISTS FOR (n:ApiKey) REQUIRE n.key_hash IS UNIQUE' },
  { label: 'KBArticle.id', cypher: 'CREATE CONSTRAINT kb_article_id_unique IF NOT EXISTS FOR (n:KBArticle) REQUIRE n.id IS UNIQUE' },
  { label: 'Team.id', cypher: 'CREATE CONSTRAINT team_id_unique IF NOT EXISTS FOR (n:Team) REQUIRE n.id IS UNIQUE' },
  { label: 'WorkflowDefinition.id', cypher: 'CREATE CONSTRAINT workflow_definition_id_unique IF NOT EXISTS FOR (n:WorkflowDefinition) REQUIRE n.id IS UNIQUE' },
  // Versioned migrations (migrations.ts): one marker per migration id, one
  // global lock node. Both MERGEd on `id`; the constraint makes the MERGE
  // race-free across two processes migrating at once.
  { label: 'Migration.id', cypher: 'CREATE CONSTRAINT migration_id_unique IF NOT EXISTS FOR (n:Migration) REQUIRE n.id IS UNIQUE' },
  { label: 'MigrationLock.id', cypher: 'CREATE CONSTRAINT migration_lock_id_unique IF NOT EXISTS FOR (n:MigrationLock) REQUIRE n.id IS UNIQUE' },
  // Event Management (ondata 1): l'ingest fa MERGE su (tenant_id, fingerprint)
  // — il vincolo rende impossibile il doppione anche con 4 worker concorrenti.
  // CIAlias: un nome (kind, value) di una sorgente punta a UN solo CI per tenant.
  { label: 'Event.id', cypher: 'CREATE CONSTRAINT event_id_unique IF NOT EXISTS FOR (n:Event) REQUIRE n.id IS UNIQUE' },
  { label: 'Event(tenant_id, fingerprint)', cypher: 'CREATE CONSTRAINT event_tenant_fingerprint_unique IF NOT EXISTS FOR (n:Event) REQUIRE (n.tenant_id, n.fingerprint) IS UNIQUE' },
  { label: 'CIAlias.id', cypher: 'CREATE CONSTRAINT ci_alias_id_unique IF NOT EXISTS FOR (n:CIAlias) REQUIRE n.id IS UNIQUE' },
  { label: 'CIAlias(tenant_id, kind, value)', cypher: 'CREATE CONSTRAINT ci_alias_tenant_kind_value_unique IF NOT EXISTS FOR (n:CIAlias) REQUIRE (n.tenant_id, n.kind, n.value) IS UNIQUE' },
  // Cronologia dell'allarme (apps/api/src/services/events/history.ts): una voce per cambiamento di stato/esito dell'Event.
  { label: 'EventHistoryEntry.id', cypher: 'CREATE CONSTRAINT event_history_entry_id_unique IF NOT EXISTS FOR (n:EventHistoryEntry) REQUIRE n.id IS UNIQUE' },
  // Servizi monitorati (apps/api/src/services/serviceImpact/): mappa del servizio e cronologia della sua salute.
  { label: 'ServiceMap.id', cypher: 'CREATE CONSTRAINT service_map_id_unique IF NOT EXISTS FOR (n:ServiceMap) REQUIRE n.id IS UNIQUE' },
  { label: 'ServiceHealthEntry.id', cypher: 'CREATE CONSTRAINT service_health_entry_id_unique IF NOT EXISTS FOR (n:ServiceHealthEntry) REQUIRE n.id IS UNIQUE' },
  // ── Metamodello (D-17) ───────────────────────────────────────────────────
  // Il metamodello — i tipi CI, i loro campi e relazioni, i vocabolari — era
  // il solo pezzo di modello SENZA un vincolo: due «Salva» in parallelo dal
  // disegnatore creavano due nodi omonimi (`createEnumType` legge e poi crea in
  // due transazioni separate), e `loadMetamodel` ne scarta silenziosamente uno
  // mentre l'interfaccia continua a mostrarne due.
  //
  // La chiave naturale di un TIPO e di un VOCABOLARIO è (tenant_id, name) —
  // `system` è un tenant come gli altri, quindi il tipo condiviso e la copia
  // del cliente convivono. I due indici di range sulla stessa schema devono
  // cadere prima (Neo4j rifiuta il vincolo altrimenti): l'indice di appoggio
  // del vincolo li sostituisce per le ricerche.
  //
  // La chiave naturale di un CAMPO e di una RELAZIONE è invece (tipo, name),
  // cioè passa per la relazione `HAS_FIELD`/`HAS_RELATION`: un vincolo di nodo
  // non la può esprimere (`status` esiste su quasi ogni tipo). Lì l'unicità è
  // applicata in scrittura da `addCIField`/`addCIRelation`/`addITILField`, e
  // qui si vincola solo l'identità.
  {
    label: 'drop range index ci_type_definition_tenant_name (superseded by the constraint)',
    cypher: 'DROP INDEX ci_type_definition_tenant_name IF EXISTS',
  },
  { label: 'CITypeDefinition(tenant_id, name)', cypher: 'CREATE CONSTRAINT ci_type_definition_tenant_name_unique IF NOT EXISTS FOR (n:CITypeDefinition) REQUIRE (n.tenant_id, n.name) IS UNIQUE' },
  {
    label: 'drop range index enum_type_definition_tenant_name (superseded by the constraint)',
    cypher: 'DROP INDEX enum_type_definition_tenant_name IF EXISTS',
  },
  { label: 'EnumTypeDefinition(tenant_id, name)', cypher: 'CREATE CONSTRAINT enum_type_definition_tenant_name_unique IF NOT EXISTS FOR (n:EnumTypeDefinition) REQUIRE (n.tenant_id, n.name) IS UNIQUE' },
  // Moduli del catalogo (ondata 1): il nome di un campo della libreria e il
  // nome della proprieta sul ticket, quindi due campi con lo stesso nome nello
  // stesso tenant scriverebbero sullo stesso dato.
  { label: 'FormField(tenant_id, name)', cypher: 'CREATE CONSTRAINT form_field_tenant_name_unique IF NOT EXISTS FOR (n:FormField) REQUIRE (n.tenant_id, n.name) IS UNIQUE' },
  { label: 'CatalogFormRevision(tenant_id, item_id, revision)', cypher: 'CREATE CONSTRAINT catalog_form_revision_unique IF NOT EXISTS FOR (n:CatalogFormRevision) REQUIRE (n.tenant_id, n.item_id, n.revision) IS UNIQUE' },
  { label: 'CIFieldDefinition.id', cypher: 'CREATE CONSTRAINT ci_field_definition_id_unique IF NOT EXISTS FOR (n:CIFieldDefinition) REQUIRE n.id IS UNIQUE' },
  { label: 'CIRelationDefinition.id', cypher: 'CREATE CONSTRAINT ci_relation_definition_id_unique IF NOT EXISTS FOR (n:CIRelationDefinition) REQUIRE n.id IS UNIQUE' },
  { label: 'CISystemRelationDefinition.id', cypher: 'CREATE CONSTRAINT ci_system_relation_definition_id_unique IF NOT EXISTS FOR (n:CISystemRelationDefinition) REQUIRE n.id IS UNIQUE' },  // Revisione totale · E-24: questi cinque vincoli stavano nell'elenco degli
  // INDICI, quindi non passavano dal controllo dei duplicati né dall'ordine
  // «prechecks → vincoli → indici» (e il test di init era rosso).
  { label: 'AnomalyRuleConfig(tenant_id, rule_key) unique', cypher: 'CREATE CONSTRAINT anomaly_rule_config_unique IF NOT EXISTS FOR (c:AnomalyRuleConfig) REQUIRE (c.tenant_id, c.rule_key) IS UNIQUE' },
  { label: 'Role(tenant_id, key) unique', cypher: 'CREATE CONSTRAINT role_tenant_key_unique IF NOT EXISTS FOR (r:Role) REQUIRE (r.tenant_id, r.key) IS UNIQUE' },
  { label: 'TicketCIExclusion(tenant_id, ticket_type, ci_type) unique', cypher: 'CREATE CONSTRAINT ticket_ci_exclusion_unique IF NOT EXISTS FOR (x:TicketCIExclusion) REQUIRE (x.tenant_id, x.ticket_type, x.ci_type) IS UNIQUE' },
  { label: 'SlackInstallation(tenant_id) unique', cypher: 'CREATE CONSTRAINT slack_installation_tenant_unique IF NOT EXISTS FOR (s:SlackInstallation) REQUIRE s.tenant_id IS UNIQUE' },
  { label: 'SlackInstallation(team_id) unique',   cypher: 'CREATE CONSTRAINT slack_installation_team_unique IF NOT EXISTS FOR (s:SlackInstallation) REQUIRE s.team_id IS UNIQUE' },
]

const INDEXES: SchemaStatement[] = [
  {
    label: 'ConfigurationItem(tenant_id)',
    cypher: 'CREATE INDEX ci_tenant_id IF NOT EXISTS FOR (n:ConfigurationItem) ON (n.tenant_id)',
  },
  {
    label: 'Incident(tenant_id)',
    cypher: 'CREATE INDEX incident_tenant_id IF NOT EXISTS FOR (n:Incident) ON (n.tenant_id)',
  },
  {
    label: 'Change(tenant_id)',
    cypher: 'CREATE INDEX change_tenant_id IF NOT EXISTS FOR (n:Change) ON (n.tenant_id)',
  },
  {
    label: 'Incident(tenant_id, status, severity)',
    cypher: 'CREATE INDEX incident_tenant_status_severity IF NOT EXISTS FOR (n:Incident) ON (n.tenant_id, n.status, n.severity)',
  },
  {
    label: 'WorkflowInstance(tenant_id, status)',
    cypher: 'CREATE INDEX workflow_instance_tenant_status IF NOT EXISTS FOR (n:WorkflowInstance) ON (n.tenant_id, n.status)',
  },
  {
    label: 'SLAStatus(breached)',
    cypher: 'CREATE INDEX sla_status_breached IF NOT EXISTS FOR (n:SLAStatus) ON (n.breached)',
  },
  {
    label: 'Problem(tenant_id)',
    cypher: 'CREATE INDEX problem_tenant_id IF NOT EXISTS FOR (n:Problem) ON (n.tenant_id)',
  },
  {
    label: 'Problem(tenant_id, status)',
    cypher: 'CREATE INDEX problem_tenant_status IF NOT EXISTS FOR (n:Problem) ON (n.tenant_id, n.status)',
  },
  {
    label: 'ServiceRequest(tenant_id)',
    cypher: 'CREATE INDEX service_request_tenant_id IF NOT EXISTS FOR (n:ServiceRequest) ON (n.tenant_id)',
  },
  {
    label: 'ServiceRequest(tenant_id, status)',
    cypher: 'CREATE INDEX service_request_tenant_status IF NOT EXISTS FOR (n:ServiceRequest) ON (n.tenant_id, n.status)',
  },
  // User
  { label: 'User(email)',               cypher: 'CREATE INDEX user_email IF NOT EXISTS FOR (u:User) ON (u.email)' },
  { label: 'User(tenant_id)',           cypher: 'CREATE INDEX user_tenant IF NOT EXISTS FOR (u:User) ON (u.tenant_id)' },
  // User(tenant_id, email) is covered by the user_tenant_email_unique constraint above
  // Team
  { label: 'Team(tenant_id)',           cypher: 'CREATE INDEX team_tenant IF NOT EXISTS FOR (t:Team) ON (t.tenant_id)' },
  { label: 'Team(tenant_id, type)',     cypher: 'CREATE INDEX team_type IF NOT EXISTS FOR (t:Team) ON (t.tenant_id, t.type)' },
  // Change
  { label: 'Change(tenant_id, status)', cypher: 'CREATE INDEX change_tenant_status IF NOT EXISTS FOR (c:Change) ON (c.tenant_id, c.status)' },
  { label: 'Change(tenant_id, type)',   cypher: 'CREATE INDEX change_tenant_type IF NOT EXISTS FOR (c:Change) ON (c.tenant_id, c.type)' },
  // Application
  { label: 'Application(tenant_id)',                    cypher: 'CREATE INDEX app_tenant IF NOT EXISTS FOR (n:Application) ON (n.tenant_id)' },
  { label: 'Application(tenant_id, status)',            cypher: 'CREATE INDEX app_tenant_status IF NOT EXISTS FOR (n:Application) ON (n.tenant_id, n.status)' },
  { label: 'Application(tenant_id, environment)',       cypher: 'CREATE INDEX app_tenant_env IF NOT EXISTS FOR (n:Application) ON (n.tenant_id, n.environment)' },
  { label: 'Application(tenant_id, name)',              cypher: 'CREATE INDEX app_name IF NOT EXISTS FOR (n:Application) ON (n.tenant_id, n.name)' },
  // Database
  { label: 'Database(tenant_id)',                       cypher: 'CREATE INDEX db_tenant IF NOT EXISTS FOR (n:Database) ON (n.tenant_id)' },
  { label: 'Database(tenant_id, status)',               cypher: 'CREATE INDEX db_tenant_status IF NOT EXISTS FOR (n:Database) ON (n.tenant_id, n.status)' },
  { label: 'Database(tenant_id, name)',                 cypher: 'CREATE INDEX db_name IF NOT EXISTS FOR (n:Database) ON (n.tenant_id, n.name)' },
  // DatabaseInstance
  { label: 'DatabaseInstance(tenant_id)',               cypher: 'CREATE INDEX dbi_tenant IF NOT EXISTS FOR (n:DatabaseInstance) ON (n.tenant_id)' },
  { label: 'DatabaseInstance(tenant_id, status)',       cypher: 'CREATE INDEX dbi_tenant_status IF NOT EXISTS FOR (n:DatabaseInstance) ON (n.tenant_id, n.status)' },
  { label: 'DatabaseInstance(tenant_id, name)',         cypher: 'CREATE INDEX dbi_name IF NOT EXISTS FOR (n:DatabaseInstance) ON (n.tenant_id, n.name)' },
  // Server
  { label: 'Server(tenant_id)',                         cypher: 'CREATE INDEX srv_tenant IF NOT EXISTS FOR (n:Server) ON (n.tenant_id)' },
  { label: 'Server(tenant_id, status)',                 cypher: 'CREATE INDEX srv_tenant_status IF NOT EXISTS FOR (n:Server) ON (n.tenant_id, n.status)' },
  { label: 'Server(tenant_id, os_version)',             cypher: 'CREATE INDEX srv_tenant_os IF NOT EXISTS FOR (n:Server) ON (n.tenant_id, n.os_version)' },
  { label: 'Server(tenant_id, name)',                   cypher: 'CREATE INDEX srv_name IF NOT EXISTS FOR (n:Server) ON (n.tenant_id, n.name)' },
  // Certificate
  { label: 'Certificate(tenant_id)',                    cypher: 'CREATE INDEX cert_tenant IF NOT EXISTS FOR (n:Certificate) ON (n.tenant_id)' },
  { label: 'Certificate(tenant_id, status)',            cypher: 'CREATE INDEX cert_tenant_status IF NOT EXISTS FOR (n:Certificate) ON (n.tenant_id, n.status)' },
  { label: 'Certificate(tenant_id, expires_at)',        cypher: 'CREATE INDEX cert_expires IF NOT EXISTS FOR (n:Certificate) ON (n.tenant_id, n.expires_at)' },
  { label: 'Certificate(tenant_id, name)',              cypher: 'CREATE INDEX cert_name IF NOT EXISTS FOR (n:Certificate) ON (n.tenant_id, n.name)' },
  // WorkflowDefinition
  { label: 'WorkflowDefinition(tenant_id, entity_type)', cypher: 'CREATE INDEX wf_tenant_type IF NOT EXISTS FOR (w:WorkflowDefinition) ON (w.tenant_id, w.entity_type)' },
  { label: 'WorkflowDefinition(tenant_id, active)',       cypher: 'CREATE INDEX wf_tenant_active IF NOT EXISTS FOR (w:WorkflowDefinition) ON (w.tenant_id, w.active)' },
  /**
   * IL COMPITO GENERICO (20 set 2026), quello che un passo di workflow crea
   * su un ticket qualunque. Senza indici «I miei compiti» scandiva TUTTI i
   * compiti del cliente a ogni apertura della pagina, e ogni chiusura di un
   * compito faceva una scansione per etichetta su `{id}`.
   */
  { label: 'Task(tenant_id, state)',                    cypher: 'CREATE INDEX task_tenant_state IF NOT EXISTS FOR (k:Task) ON (k.tenant_id, k.state)' },
  { label: 'Task(tenant_id, step_name)',                cypher: 'CREATE INDEX task_tenant_step IF NOT EXISTS FOR (k:Task) ON (k.tenant_id, k.step_name)' },
  /*
   * `ChangeTask` NON C'È PIÙ (20 set 2026). Qui stavano tre indici su
   * quell'etichetta: nessun nodo la porta (zero su questa installazione),
   * nessuna query la nomina, e i task delle change hanno da tempo le cinque
   * etichette dei loro tipi. Lo stesso fantasma era già stato tolto dal
   * contatore dei task nella revisione del 14 set (CH-2); questi tre erano
   * rimasti, e ogni `init-schema` li ricreava. Chi li ha ancora se li vede
   * togliere dalla migrazione `20261005_1120_drop_change_task_indexes`.
   */
  // ReportConversation
  { label: 'ReportConversation(tenant_id)',             cypher: 'CREATE INDEX report_tenant IF NOT EXISTS FOR (r:ReportConversation) ON (r.tenant_id)' },
  // NotificationChannel
  { label: 'NotificationChannel(tenant_id)',            cypher: 'CREATE INDEX notif_tenant IF NOT EXISTS FOR (n:NotificationChannel) ON (n.tenant_id)' },
  // DashboardConfig
  { label: 'DashboardConfig(tenant_id)',                cypher: 'CREATE INDEX dashboard_tenant IF NOT EXISTS FOR (d:DashboardConfig) ON (d.tenant_id)' },
  { label: 'DashboardConfig(tenant_id, user_id)',       cypher: 'CREATE INDEX dashboard_user IF NOT EXISTS FOR (d:DashboardConfig) ON (d.tenant_id, d.user_id)' },
  // DashboardWidget
  { label: 'DashboardWidget(dashboard_id)',             cypher: 'CREATE INDEX widget_dashboard IF NOT EXISTS FOR (w:DashboardWidget) ON (w.dashboard_id)' },
  // Anomaly
  { label: 'Anomaly(tenant_id)',                        cypher: 'CREATE INDEX anomaly_tenant IF NOT EXISTS FOR (a:Anomaly) ON (a.tenant_id)' },
  { label: 'Anomaly(tenant_id, status)',                cypher: 'CREATE INDEX anomaly_tenant_status IF NOT EXISTS FOR (a:Anomaly) ON (a.tenant_id, a.status)' },
  { label: 'Anomaly(tenant_id, rule_key)',              cypher: 'CREATE INDEX anomaly_tenant_rule IF NOT EXISTS FOR (a:Anomaly) ON (a.tenant_id, a.rule_key)' },
  // Proposte di miglioramento: la pagina filtra per stato e per area, e il
  // giro notturno cerca per impronta prima di scrivere.
  { label: 'Proposal(tenant_id, status)',               cypher: 'CREATE INDEX proposal_tenant_status IF NOT EXISTS FOR (p:Proposal) ON (p.tenant_id, p.status)' },
  { label: 'Proposal(tenant_id, area)',                 cypher: 'CREATE INDEX proposal_tenant_area IF NOT EXISTS FOR (p:Proposal) ON (p.tenant_id, p.area)' },
  { label: 'Proposal(tenant_id, created_at)',           cypher: 'CREATE INDEX proposal_tenant_created IF NOT EXISTS FOR (p:Proposal) ON (p.tenant_id, p.created_at)' },
  // La lapide di un rifiuto: sopravvive alla purga della proposta, e il giro
  // la cerca per impronta per non riproporre ciò che è già stato respinto.
  { label: 'ProposalRejection(tenant_id, fingerprint)', cypher: 'CREATE INDEX proposal_rejection_fp IF NOT EXISTS FOR (r:ProposalRejection) ON (r.tenant_id, r.fingerprint)' },
  // Configurazione delle regole (ondata 5 di «Nulla cablato»): una per regola per tenant.
  // Ruoli dell'organizzazione (ondata 7 di «Nulla cablato»): una chiave per tenant.
  // Tipi di CI esclusi per tipo di ticket (revisione del 15 set 2026 · CM-8): un'esclusione per coppia.
  // Slack dell'organizzazione (ondata 8): uno per organizzazione, un workspace per una sola organizzazione.
  // Team by id (lookup in OWNED_BY / SUPPORTED_BY joins)
  { label: 'Team(tenant_id, id)',                       cypher: 'CREATE INDEX team_id IF NOT EXISTS FOR (t:Team) ON (t.tenant_id, t.id)' },
  // SyncSource
  { label: 'SyncSource(tenant_id)',                     cypher: 'CREATE INDEX sync_source_tenant IF NOT EXISTS FOR (n:SyncSource) ON (n.tenant_id)' },
  { label: 'SyncSource(tenant_id, enabled)',            cypher: 'CREATE INDEX sync_source_enabled IF NOT EXISTS FOR (n:SyncSource) ON (n.tenant_id, n.enabled)' },
  // SyncRun
  { label: 'SyncRun(tenant_id)',                        cypher: 'CREATE INDEX sync_run_tenant IF NOT EXISTS FOR (n:SyncRun) ON (n.tenant_id)' },
  { label: 'SyncRun(source_id, started_at)',            cypher: 'CREATE INDEX sync_run_source_date IF NOT EXISTS FOR (n:SyncRun) ON (n.source_id, n.started_at)' },
  { label: 'SyncRun(tenant_id, status)',                cypher: 'CREATE INDEX sync_run_status IF NOT EXISTS FOR (n:SyncRun) ON (n.tenant_id, n.status)' },
  // SyncConflict
  { label: 'SyncConflict(tenant_id)',                   cypher: 'CREATE INDEX sync_conflict_tenant IF NOT EXISTS FOR (n:SyncConflict) ON (n.tenant_id)' },
  { label: 'SyncConflict(source_id)',                   cypher: 'CREATE INDEX sync_conflict_source IF NOT EXISTS FOR (n:SyncConflict) ON (n.source_id)' },
  { label: 'SyncConflict(tenant_id, status)',           cypher: 'CREATE INDEX sync_conflict_status IF NOT EXISTS FOR (n:SyncConflict) ON (n.tenant_id, n.status)' },
  { label: 'ServiceCatalogItem(tenant_id)', cypher: 'CREATE INDEX service_catalog_tenant IF NOT EXISTS FOR (n:ServiceCatalogItem) ON (n.tenant_id)' },
  { label: 'FormField(tenant_id)', cypher: 'CREATE INDEX form_field_tenant IF NOT EXISTS FOR (n:FormField) ON (n.tenant_id)' },
  { label: 'CatalogFormRevision(tenant_id, item_id)', cypher: 'CREATE INDEX catalog_form_revision_item IF NOT EXISTS FOR (n:CatalogFormRevision) ON (n.tenant_id, n.item_id)' },
  // Discovery reconciliation lookups by (tenant_id, source, external_id) are
  // served by the ci_discovery_key_unique constraint's backing index (CONSTRAINTS).
  // Fulltext for the command-palette global search (CONTAINS cannot use range indexes).
  // I CI entrano per `:ConfigurationItem`, non per venti etichette fisse
  // (ondata 6, A6-2): un indice fulltext NON si estende a runtime, quindi un
  // tipo creato dal cliente non era cercabile e non lo sarebbe mai diventato
  // senza un intervento sul codice. Ogni CI porta `:ConfigurationItem`
  // (migrazione `20260908_1010`). Su un database già avviato la definizione
  // non cambia da sé (`IF NOT EXISTS` non ridefinisce): la ricrea la migrazione
  // `20260916_1700_global_search_configuration_item`.
  { label: 'global_search (fulltext)', cypher: `CREATE FULLTEXT INDEX global_search IF NOT EXISTS FOR (n:${GLOBAL_SEARCH_LABELS.join('|')}) ON EACH [${GLOBAL_SEARCH_PROPERTIES.map((p) => `n.${p}`).join(', ')}]` },
  { label: 'AssessmentTask(code)', cypher: 'CREATE INDEX assessment_task_code IF NOT EXISTS FOR (t:AssessmentTask) ON (t.code)' },
  { label: 'DeployPlanTask(code)', cypher: 'CREATE INDEX deploy_plan_task_code IF NOT EXISTS FOR (t:DeployPlanTask) ON (t.code)' },
  { label: 'ValidationTest(code)', cypher: 'CREATE INDEX validation_test_code IF NOT EXISTS FOR (t:ValidationTest) ON (t.code)' },
  { label: 'DeploymentTask(code)', cypher: 'CREATE INDEX deployment_task_code IF NOT EXISTS FOR (t:DeploymentTask) ON (t.code)' },
  { label: 'ReviewTask(code)', cypher: 'CREATE INDEX review_task_code IF NOT EXISTS FOR (t:ReviewTask) ON (t.code)' },
  // ── D-15: labels used by the API without any index ──────────────────────
  // NotificationRule: dispatcher.ts loads the rules for (tenant, event) on EVERY domain event.
  { label: 'NotificationRule(tenant_id, event_type)', cypher: 'CREATE INDEX notification_rule_tenant_event IF NOT EXISTS FOR (n:NotificationRule) ON (n.tenant_id, n.event_type)' },
  // SLAPolicyNode: sla/selector.ts picks the policy for every created entity.
  { label: 'SLAPolicyNode(tenant_id, entity_type)', cypher: 'CREATE INDEX sla_policy_node_tenant_type IF NOT EXISTS FOR (n:SLAPolicyNode) ON (n.tenant_id, n.entity_type)' },
  // ServiceCalendar: i calendari con nome di un cliente (verifica «Cosa resta cablato», ondata 2).
  { label: 'ServiceCalendar(tenant_id)', cypher: 'CREATE INDEX service_calendar_tenant IF NOT EXISTS FOR (n:ServiceCalendar) ON (n.tenant_id)' },
  // WorkflowStep: the engine resolves steps by (definition, name) on every transition.
  { label: 'WorkflowStep(definition_id, name)', cypher: 'CREATE INDEX workflow_step_definition_name IF NOT EXISTS FOR (n:WorkflowStep) ON (n.definition_id, n.name)' },
  // E la transizione cerca lo step di arrivo per (definizione, id) — senza
  // questo indice era una scansione dell'etichetta a ogni transizione
  // (revisione totale · E-6). Non è un vincolo di unicità: gli id dei passi dei
  // seed storici (`step-<nome>`) si ripetono fra definizioni, ed è proprio per
  // questo che la query passa dalla definizione.
  { label: 'WorkflowStep(definition_id, id)', cypher: 'CREATE INDEX workflow_step_definition_id IF NOT EXISTS FOR (n:WorkflowStep) ON (n.definition_id, n.id)' },
  // Comments: one model for every ticket, `(ticket)-[:HAS_COMMENT]->(:Comment)`
  // (apps/api/src/lib/ticketComments.ts). `EntityComment` was retired by the
  // migration 20260923_1030_comments_single_model: its index is no longer created.
  { label: 'Comment(tenant_id)', cypher: 'CREATE INDEX comment_tenant IF NOT EXISTS FOR (n:Comment) ON (n.tenant_id)' },
  // Edit/delete of a single comment (resolvers/comments.ts) look it up by id.
  { label: 'Comment(tenant_id, id)', cypher: 'CREATE INDEX comment_tenant_id IF NOT EXISTS FOR (n:Comment) ON (n.tenant_id, n.id)' },
  // Revisione del 14 set 2026 · F10: il pannello legge le notifiche del tenant dalla più recente; la pulizia per età.
  { label: 'InAppNotification(tenant_id, created_at)', cypher: 'CREATE INDEX inapp_notification_tenant_created IF NOT EXISTS FOR (n:InAppNotification) ON (n.tenant_id, n.created_at)' },
  { label: 'InAppNotification(created_at)', cypher: 'CREATE INDEX inapp_notification_created IF NOT EXISTS FOR (n:InAppNotification) ON (n.created_at)' },
  // Metamodel definitions (id lookups from the dynamic CI resolvers). Le chiavi
  // naturali (tenant_id, name) sono VINCOLI di unicità (D-17, vedi CONSTRAINTS):
  // i loro indici di appoggio servono anche queste ricerche, quindi qui restano
  // solo gli indici su `id`.
  { label: 'CITypeDefinition(id)', cypher: 'CREATE INDEX ci_type_definition_id IF NOT EXISTS FOR (n:CITypeDefinition) ON (n.id)' },
  { label: 'EnumTypeDefinition(id)', cypher: 'CREATE INDEX enum_type_definition_id IF NOT EXISTS FOR (n:EnumTypeDefinition) ON (n.id)' },
  // Reports — moved here from apps/api/src/scripts/seed-report-templates.ts
  // (init.ts is the single source of schema; that script is now redundant).
  { label: 'ReportTemplate(tenant_id)', cypher: 'CREATE INDEX report_template_tenant IF NOT EXISTS FOR (r:ReportTemplate) ON (r.tenant_id)' },
  { label: 'ReportTemplate(created_by)', cypher: 'CREATE INDEX report_template_created_by IF NOT EXISTS FOR (r:ReportTemplate) ON (r.created_by)' },
  { label: 'ReportSection(template_id)', cypher: 'CREATE INDEX report_section_template IF NOT EXISTS FOR (s:ReportSection) ON (s.template_id)' },
  { label: 'TraversalStep(section_id)', cypher: 'CREATE INDEX traversal_step_section IF NOT EXISTS FOR (t:TraversalStep) ON (t.section_id)' },
  // DashboardConfig(tenant_id) and Anomaly(tenant_id, status) already exist above.
  // Automation
  { label: 'AutoTrigger(tenant_id)', cypher: 'CREATE INDEX auto_trigger_tenant IF NOT EXISTS FOR (n:AutoTrigger) ON (n.tenant_id)' },
  { label: 'BusinessRule(tenant_id)', cypher: 'CREATE INDEX business_rule_tenant IF NOT EXISTS FOR (n:BusinessRule) ON (n.tenant_id)' },
  // Attachments / audit trail — always read per entity
  { label: 'Attachment(tenant_id, entity_id)', cypher: 'CREATE INDEX attachment_tenant_entity IF NOT EXISTS FOR (n:Attachment) ON (n.tenant_id, n.entity_id)' },
  { label: 'AuditEntry(tenant_id, entity_id)', cypher: 'CREATE INDEX audit_entry_tenant_entity IF NOT EXISTS FOR (n:AuditEntry) ON (n.tenant_id, n.entity_id)' },
  /*
   * GLI AGGREGATI DEL LAVORO QUOTIDIANO (20 set 2026, ondata 2 di
   * «Miglioramento continuo»).
   *
   * L'unico indice era quello per entità. Ogni domanda «che cosa è successo
   * in questa finestra», «chi ha fatto cosa», «quali azioni si ripetono» era
   * una scansione piena di un registro che non si purga mai — e `created_at`
   * è una stringa ISO, quindi l'ordinamento e i confronti sono lessicali e
   * l'indice serve davvero.
   */
  { label: 'AuditEntry(tenant_id, created_at)', cypher: 'CREATE INDEX audit_entry_tenant_created IF NOT EXISTS FOR (n:AuditEntry) ON (n.tenant_id, n.created_at)' },
  { label: 'AuditEntry(tenant_id, action)',     cypher: 'CREATE INDEX audit_entry_tenant_action IF NOT EXISTS FOR (n:AuditEntry) ON (n.tenant_id, n.action)' },
  { label: 'AuditEntry(tenant_id, user_id)',    cypher: 'CREATE INDEX audit_entry_tenant_user IF NOT EXISTS FOR (n:AuditEntry) ON (n.tenant_id, n.user_id)' },
  // Event Management: la console lista per (tenant, status) ordinando per last_seen_at.
  { label: 'Event(tenant_id, status, last_seen_at)', cypher: 'CREATE INDEX event_tenant_status_last_seen IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.status, n.last_seen_at)' },
  // Tempeste per sorgente (eventStorm.ts: MATCH (e:Event {tenant_id, source_id})) e
  // rivalutazioni per stato di correlazione (eventCorrelation.ts: delayed/suppressed).
  { label: 'Event(tenant_id, source_id)', cypher: 'CREATE INDEX event_tenant_source IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.source_id)' },
  { label: 'Event(tenant_id, correlation)', cypher: 'CREATE INDEX event_tenant_correlation IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.correlation)' },
  // Event Management (revisione, ondata 3 — prestazioni): la vista "tutti gli
  // stati" della console ordina per last_seen_at senza filtro di stato (il
  // composito sopra copre l'ordinamento solo con status in uguaglianza);
  // conservazione (purge_events) e contatore resolved24h leggono per resolved_at;
  // la ricerca della console per titolo/risorsa passa dal full-text
  // (CONTAINS non usa gli indici range; query in resolvers/events.ts#eventSearchLucene).
  { label: 'Event(tenant_id, last_seen_at)', cypher: 'CREATE INDEX event_tenant_last_seen IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.last_seen_at)' },
  { label: 'Event(tenant_id, resolved_at)', cypher: 'CREATE INDEX event_tenant_resolved IF NOT EXISTS FOR (n:Event) ON (n.tenant_id, n.resolved_at)' },
  { label: 'event_search (fulltext)', cypher: 'CREATE FULLTEXT INDEX event_search IF NOT EXISTS FOR (n:Event) ON EACH [n.title, n.resource]' },
  // Event Management (revisione 2 · D4.2): le passate periodiche di
  // events-maintenance (services/events/passes.ts) e i gauge di salute
  // (gauges.ts) leggono per `status` su TUTTI i tenant con un cursore su `id`
  // (`MATCH (e:Event {status: $s}) WHERE e.id > $cursor … ORDER BY e.id`).
  // Senza un indice che parta da `status` il planner usava l'indice di
  // unicità su `id` (scansione ordinata di ogni Event, filtro sullo stato):
  // cinque scansioni complete ogni 5 minuti. (status, id) serve filtro E
  // cursore ordinato; (status, correlation) serve i gauge e la passata
  // `pending` (`correlation IN […]` / `= 'delayed'` sotto `status = 'firing'`).
  { label: 'Event(status, id)', cypher: 'CREATE INDEX event_status_id IF NOT EXISTS FOR (n:Event) ON (n.status, n.id)' },
  { label: 'Event(status, correlation)', cypher: 'CREATE INDEX event_status_correlation IF NOT EXISTS FOR (n:Event) ON (n.status, n.correlation)' },
  // Riconoscimento del CI per nome negli allarmi (eventService.ts#matchCI):
  // `name_key` = toLower(name), scritto da chi crea/rinomina il CI
  // (apps/api/src/lib/ciNameKey.ts) e backfillato dalla migrazione
  // 20260909_1050_event_management_indexes.
  { label: 'ConfigurationItem(tenant_id, name_key)', cypher: 'CREATE INDEX ci_tenant_name_key IF NOT EXISTS FOR (n:ConfigurationItem) ON (n.tenant_id, n.name_key)' },
  // Cronologia dell'allarme: Event.history legge le voci di un evento dalla più
  // recente (resolvers/events.ts) e il cap per evento le ordina per `at`.
  { label: 'EventHistoryEntry(tenant_id, event_id, at)', cypher: 'CREATE INDEX event_history_tenant_event IF NOT EXISTS FOR (n:EventHistoryEntry) ON (n.tenant_id, n.event_id, n.at)' },
  // Servizi monitorati: una mappa per servizio (lookup per service_id), la
  // lista per stato/salute (pagina Servizi e passata periodica), la
  // cronologia della mappa dalla più recente (resolvers/services.ts) e il cap
  // per mappa ordinato per `at` (services/serviceImpact/history.ts).
  { label: 'ServiceMap(tenant_id, service_id)', cypher: 'CREATE INDEX service_map_tenant_service IF NOT EXISTS FOR (n:ServiceMap) ON (n.tenant_id, n.service_id)' },
  { label: 'ServiceMap(tenant_id, status)', cypher: 'CREATE INDEX service_map_tenant_status IF NOT EXISTS FOR (n:ServiceMap) ON (n.tenant_id, n.status)' },
  { label: 'ServiceHealthEntry(tenant_id, map_id, at)', cypher: 'CREATE INDEX service_health_tenant_map IF NOT EXISTS FOR (n:ServiceHealthEntry) ON (n.tenant_id, n.map_id, n.at)' },
  // Storia delle assegnazioni ai team: il report OLA/UC filtra i tratti per team.
  { label: 'TicketTeamSegment(tenant_id, team_id)', cypher: 'CREATE INDEX ticket_team_segment_tenant_team IF NOT EXISTS FOR (n:TicketTeamSegment) ON (n.tenant_id, n.team_id)' },
  // NOTE — vector indexes are NOT listed here on purpose: their name and
  // dimension depend on the configured embedding provider
  // (`incident_embedding_<dims>` / `kb_embedding_<dims>`, see
  // apps/api/src/services/embeddings.ts#vectorIndexName). They are created
  // dynamically by apps/api/src/jobs/embeddingWorker.ts (`ensureVectorIndexes`)
  // at worker start, so a provider switch never queries vectors of the wrong size.
]

// Raise-only seeding of the atomic counters to the current max number/code, so
// introducing the Counter on an existing dataset continues numbering instead of
// restarting from 1. Runs after constraints/indexes. Never lowers a counter.
const COUNTER_SEEDS: SchemaStatement[] = [
  { label: 'seed incident counter', cypher: `
    MATCH (i:Incident) WHERE i.tenant_id IS NOT NULL AND i.number IS NOT NULL
    WITH i.tenant_id AS t, max(toInteger(substring(i.number, 3))) AS mx
    MERGE (c:Counter {tenant_id: t, kind: 'incident'})
    SET c.value = CASE WHEN c.value IS NULL OR c.value < mx THEN mx ELSE c.value END` },
  { label: 'seed problem counter', cypher: `
    MATCH (p:Problem) WHERE p.tenant_id IS NOT NULL AND p.number IS NOT NULL
    WITH p.tenant_id AS t, max(toInteger(substring(p.number, 3))) AS mx
    MERGE (c:Counter {tenant_id: t, kind: 'problem'})
    SET c.value = CASE WHEN c.value IS NULL OR c.value < mx THEN mx ELSE c.value END` },
  { label: 'seed service_request counter', cypher: `
    MATCH (sr:ServiceRequest) WHERE sr.tenant_id IS NOT NULL AND sr.number IS NOT NULL
    WITH sr.tenant_id AS t, max(toInteger(substring(sr.number, 3))) AS mx
    MERGE (c:Counter {tenant_id: t, kind: 'service_request'})
    SET c.value = CASE WHEN c.value IS NULL OR c.value < mx THEN mx ELSE c.value END` },
  { label: 'seed change counter', cypher: `
    MATCH (ch:Change) WHERE ch.tenant_id IS NOT NULL AND ch.code STARTS WITH 'CHG'
    WITH ch.tenant_id AS t, max(toInteger(substring(ch.code, 3))) AS mx
    MERGE (c:Counter {tenant_id: t, kind: 'change'})
    SET c.value = CASE WHEN c.value IS NULL OR c.value < mx THEN mx ELSE c.value END` },
  // Revisione del 14 set 2026 · CH-2: questa voce cercava l'etichetta
  // `ChangeTask`, che non esiste — i task hanno le cinque etichette dei loro tipi.
  { label: 'seed task counter', cypher: `
    MATCH (tk) WHERE (tk:AssessmentTask OR tk:DeployPlanTask OR tk:ValidationTest OR tk:DeploymentTask OR tk:ReviewTask)
      AND tk.tenant_id IS NOT NULL AND tk.code STARTS WITH 'TASK'
    WITH tk.tenant_id AS t, max(toInteger(substring(tk.code, 4))) AS mx
    MERGE (c:Counter {tenant_id: t, kind: 'task'})
    SET c.value = CASE WHEN c.value IS NULL OR c.value < mx THEN mx ELSE c.value END` },
]

// Uniqueness constraints cannot be created over existing duplicates. Neo4j's
// own error names the constraint but not the offending rows; these checks run
// first and fail with the rows and a Cypher to inspect them, so an init failure
// on a populated DB is never a puzzle.
interface UniquenessPrecheck {
  label: string
  /** Must return one row per duplicate group, with columns exposing the key + count */
  cypher: string
  hint: string
}

const UNIQUENESS_PRECHECKS: UniquenessPrecheck[] = [
  {
    label: 'User(tenant_id, email)',
    cypher: `
      MATCH (u:User) WHERE u.tenant_id IS NOT NULL AND u.email IS NOT NULL
      WITH u.tenant_id AS tenant_id, u.email AS email, collect(u.id) AS ids
      WHERE size(ids) > 1
      RETURN tenant_id, email, ids ORDER BY tenant_id, email`,
    hint: 'Merge or delete the duplicate User nodes (keep the one referenced by ' +
          'ASSIGNED_TO / REPORTED_BY / MEMBER_OF), then rerun neo4j:init.',
  },
  {
    label: 'ConfigurationItem(tenant_id, discovery_source_id, discovery_external_id)',
    cypher: `
      MATCH (ci:ConfigurationItem)
      WHERE ci.tenant_id IS NOT NULL AND ci.discovery_source_id IS NOT NULL AND ci.discovery_external_id IS NOT NULL
      WITH ci.tenant_id AS tenant_id, ci.discovery_source_id AS source_id, ci.discovery_external_id AS external_id,
           collect({id: ci.id, name: ci.name, created_at: ci.created_at}) AS nodes
      WHERE size(nodes) > 1
      RETURN tenant_id, source_id, external_id, nodes ORDER BY tenant_id, source_id, external_id`,
    hint: 'Duplicates come from pre-fix concurrent discovery syncs. Keep the oldest node ' +
          '(the one incidents/changes/relations point at), re-point relationships from the ' +
          'others to it, DETACH DELETE the others, then rerun neo4j:init.',
  },
  {
    label: 'ApiKey(key_hash)',
    cypher: `
      MATCH (k:ApiKey) WHERE k.key_hash IS NOT NULL
      WITH k.key_hash AS key_hash, collect({id: k.id, tenant_id: k.tenant_id, name: k.name}) AS keys
      WHERE size(keys) > 1
      RETURN key_hash, keys ORDER BY key_hash`,
    hint: 'Two API keys share the same hash (same secret issued twice). Revoke/delete all but ' +
          'one of them (the callers must rotate the key anyway), then rerun neo4j:init.',
  },
  {
    label: 'KBArticle(id)',
    cypher: `
      MATCH (a:KBArticle) WHERE a.id IS NOT NULL
      WITH a.id AS id, collect({tenant_id: a.tenant_id, title: a.title, created_at: a.created_at}) AS nodes
      WHERE size(nodes) > 1
      RETURN id, nodes ORDER BY id`,
    hint: 'Keep the KBArticle the versions/links (HAS_VERSION, RELATED_KB) point at, re-point ' +
          'the others’ relationships to it, DETACH DELETE the others, then rerun neo4j:init.',
  },
  {
    label: 'Team(id)',
    cypher: `
      MATCH (t:Team) WHERE t.id IS NOT NULL
      WITH t.id AS id, collect({tenant_id: t.tenant_id, name: t.name}) AS nodes
      WHERE size(nodes) > 1
      RETURN id, nodes ORDER BY id`,
    hint: 'Keep the Team referenced by MEMBER_OF / OWNED_BY / SUPPORTED_BY, re-point the others’ ' +
          'relationships to it, DETACH DELETE the others, then rerun neo4j:init.',
  },
  {
    label: 'WorkflowDefinition(id)',
    cypher: `
      MATCH (w:WorkflowDefinition) WHERE w.id IS NOT NULL
      WITH w.id AS id, collect({tenant_id: w.tenant_id, name: w.name, entity_type: w.entity_type}) AS nodes
      WHERE size(nodes) > 1
      RETURN id, nodes ORDER BY id`,
    hint: 'Keep the WorkflowDefinition whose steps carry the running WorkflowInstances ' +
          '(CURRENT_STEP), re-point the others’ HAS_STEP/instances to it, DETACH DELETE the ' +
          'others, then rerun neo4j:init.',
  },
  // Metamodello (D-17): i due vincoli nuovi dell'ondata 8. `init.ts` gira a
  // OGNI avvio dell'API, quindi un duplicato preesistente non deve diventare
  // un'API che non parte con un errore del driver: qui si nomina il gruppo.
  {
    label: 'CITypeDefinition(tenant_id, name)',
    cypher: `
      MATCH (t:CITypeDefinition) WHERE t.tenant_id IS NOT NULL AND t.name IS NOT NULL
      WITH t.tenant_id AS tenant_id, t.name AS name,
           collect({id: t.id, label: t.label, scope: t.scope, active: t.active}) AS nodes
      WHERE size(nodes) > 1
      RETURN tenant_id, name, nodes ORDER BY tenant_id, name`,
    hint: 'Due tipi CI omonimi nello stesso tenant: `loadMetamodel` ne userebbe uno e ' +
          'l\'altro resterebbe visibile nel disegnatore. Tieni quello a cui puntano i CI ' +
          '(e i suoi HAS_FIELD/HAS_RELATION), DETACH DELETE l\'altro, poi rilancia neo4j:init.',
  },
  {
    label: 'EnumTypeDefinition(tenant_id, name)',
    cypher: `
      MATCH (e:EnumTypeDefinition) WHERE e.tenant_id IS NOT NULL AND e.name IS NOT NULL
      WITH e.tenant_id AS tenant_id, e.name AS name,
           collect({id: e.id, label: e.label, is_system: e.is_system, scope: e.scope}) AS nodes
      WHERE size(nodes) > 1
      RETURN tenant_id, name, nodes ORDER BY tenant_id, name`,
    hint: 'Due vocabolari omonimi nello stesso tenant (il check-then-create di ' +
          '`createEnumType`, ora chiuso). Tieni quello a cui puntano i campi (USES_ENUM), ' +
          'ri-aggancia gli altri legami a lui, DETACH DELETE l\'altro, poi rilancia neo4j:init.',
  },
]

async function runPrechecks(): Promise<void> {
  const driver = getDriver()
  const session = driver.session({ defaultAccessMode: neo4j.session.READ })
  try {
    for (const check of UNIQUENESS_PRECHECKS) {
      const result = await session.run(check.cypher)
      if (result.records.length === 0) {
        console.log(`[neo4j:init] Precheck ok: no duplicates for ${check.label}`)
        continue
      }
      const rows = result.records
        .map((r) => JSON.stringify(Object.fromEntries(r.keys.map((k) => [k, r.get(k)]))))
        .join('\n  ')
      throw new Error(
        `Uniqueness constraint on ${check.label} cannot be created: ` +
        `${result.records.length} duplicate group(s) found:\n  ${rows}\n` +
        `Inspect with:${check.cypher}\n${check.hint}`,
      )
    }
  } finally {
    await session.close()
  }
}

async function runStatements(statements: SchemaStatement[], kind: string): Promise<void> {
  const driver = getDriver()
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE })

  try {
    for (const stmt of statements) {
      try {
        await session.run(stmt.cypher)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(`${kind} failed: ${stmt.label}\n  ${stmt.cypher.trim()}\n  → ${reason}`)
      }
      console.log(`[neo4j:init] ${kind} applied: ${stmt.label}`)
    }
  } finally {
    await session.close()
  }
}

export interface InitSchemaOptions {
  /**
   * Versioned data migrations to run AFTER constraints/indexes/counter seeds
   * (migrations.ts). This package cannot know the application's migrations
   * (dependency direction): the caller passes them — apps/api does so from
   * `scripts/migrate.ts --init-schema`. The bare `neo4j:init` CLI runs none.
   */
  migrations?: readonly Migration[]
  log?: (message: string) => void
  /**
   * Rifà la semina dei contatori anche se il marcatore c'è (E-26). Serve dopo
   * un ripristino da backup, dove i numeri nel grafo possono essere più alti
   * dei contatori.
   */
  reseedCounters?: boolean
}

/** Il marcatore della semina dei contatori (E-26): un nodo solo, senza tenant. */
const COUNTER_SEED_MARKER = 'counters'

async function countersAlreadySeeded(force: boolean): Promise<boolean> {
  if (force) return false
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const r = await session.run('MATCH (s:SchemaSeed {id: $id}) RETURN s.at AS at', { id: COUNTER_SEED_MARKER })
    return r.records.length > 0
  } finally {
    await session.close()
  }
}

async function markCountersSeeded(): Promise<void> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    await session.run('MERGE (s:SchemaSeed {id: $id}) SET s.at = $at', { id: COUNTER_SEED_MARKER, at: new Date().toISOString() })
  } finally {
    await session.close()
  }
}

/**
 * Prechecks, constraints, indexes, counter seeds, then the given migrations.
 * Throws on the first failure (the schema is then NOT fully initialised).
 * Does not close the driver.
 */
export async function initSchema(opts: InitSchemaOptions = {}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m))
  log('[neo4j:init] Starting schema initialisation...')
  await runPrechecks()
  await runStatements(CONSTRAINTS, 'Constraint')
  await runStatements(INDEXES, 'Index')
  /**
   * I contatori si seminano UNA volta (revisione totale · E-26): sono cinque
   * `max()` su tutti gli incident, problem, richieste, change e task, cioè
   * cinque scansioni complete, e giravano a ogni esecuzione. Servono una sola
   * volta: a partire da lì il contatore lo alza l'applicazione (`sequence.ts`)
   * e l'import lo alza sopra ogni numero conservato. Un marcatore nel grafo
   * lo ricorda; `reseedCounters: true` lo rifà (dopo un ripristino da backup).
   */
  if (await countersAlreadySeeded(opts.reseedCounters === true)) {
    log('[neo4j:init] Counter seeds skipped: already done (pass reseedCounters to redo them after a restore).')
  } else {
    await runStatements(COUNTER_SEEDS, 'CounterSeed')
    await markCountersSeeded()
  }
  log('[neo4j:init] Schema initialisation complete.')

  const migrations = opts.migrations ?? []
  if (migrations.length === 0) {
    log('[neo4j:init] No migrations passed — run `pnpm --filter @opengraphity/api migrate` for the application data migrations.')
    return
  }
  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const res = await runMigrations(migrations, { session, log })
    log(`[neo4j:init] Migrations: ${res.applied.length} applied, ${res.skipped.length} already applied.`)
  } finally {
    await session.close()
  }
}

async function main(): Promise<void> {
  try {
    await initSchema()
  } catch (err) {
    console.error('[neo4j:init] FAILED — schema NOT fully initialised:')
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  } finally {
    await closeDriver()
  }
}

// Direct run only (`node dist/init.js`): the module is also imported by
// index.ts for `initSchema`, and an import must not initialise anything.
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) main()
