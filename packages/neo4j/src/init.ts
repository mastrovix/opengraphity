import { pathToFileURL } from 'node:url'
import { getDriver, closeDriver } from './driver.js'
import { runMigrations, type Migration } from './migrations.js'
import neo4j from 'neo4j-driver'

interface SchemaStatement {
  label: string
  cypher: string
}

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
  {
    label: 'SLAPolicy.id',
    cypher: 'CREATE CONSTRAINT sla_policy_id_unique IF NOT EXISTS FOR (n:SLAPolicy) REQUIRE n.id IS UNIQUE',
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
  { label: 'ServiceCatalogItem.id', cypher: 'CREATE CONSTRAINT service_catalog_item_id_unique IF NOT EXISTS FOR (n:ServiceCatalogItem) REQUIRE n.id IS UNIQUE' },
  { label: 'KBArticleVersion.id', cypher: 'CREATE CONSTRAINT kb_article_version_id_unique IF NOT EXISTS FOR (n:KBArticleVersion) REQUIRE n.id IS UNIQUE' },
  { label: 'OLAContract.id', cypher: 'CREATE CONSTRAINT ola_contract_id_unique IF NOT EXISTS FOR (n:OLAContract) REQUIRE n.id IS UNIQUE' },
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
  // ChangeTask
  { label: 'ChangeTask(change_id)',                     cypher: 'CREATE INDEX change_task_change IF NOT EXISTS FOR (t:ChangeTask) ON (t.change_id)' },
  { label: 'ChangeTask(tenant_id, status)',              cypher: 'CREATE INDEX change_task_tenant_status IF NOT EXISTS FOR (t:ChangeTask) ON (t.tenant_id, t.status)' },
  { label: 'ChangeTask(tenant_id, task_type)',           cypher: 'CREATE INDEX change_task_type IF NOT EXISTS FOR (t:ChangeTask) ON (t.tenant_id, t.task_type)' },
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
  // Discovery reconciliation lookups by (tenant_id, source, external_id) are
  // served by the ci_discovery_key_unique constraint's backing index (CONSTRAINTS).
  // Fulltext for the command-palette global search (CONTAINS cannot use range indexes)
  { label: 'global_search (fulltext)', cypher: 'CREATE FULLTEXT INDEX global_search IF NOT EXISTS FOR (n:Incident|Change|Problem|ServiceRequest|KBArticle|BusinessCapability|BusinessApplication|Application|Database|DatabaseInstance|Server|Certificate|SslCertificate|VirtualMachine|NetworkDevice|Storage|CloudService|ApiEndpoint|Microservice|DynamicCIGroup) ON EACH [n.title, n.number, n.code, n.name]' },
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
  // WorkflowStep: the engine resolves steps by (definition, name) on every transition.
  { label: 'WorkflowStep(definition_id, name)', cypher: 'CREATE INDEX workflow_step_definition_name IF NOT EXISTS FOR (n:WorkflowStep) ON (n.definition_id, n.name)' },
  // Comments: two labels coexist — `Comment` (Incident HAS_COMMENT, legacy) and
  // `EntityComment` (generic, resolvers/comments.ts + portal). Both indexed.
  { label: 'EntityComment(tenant_id, entity_id)', cypher: 'CREATE INDEX entity_comment_tenant_entity IF NOT EXISTS FOR (n:EntityComment) ON (n.tenant_id, n.entity_id)' },
  { label: 'Comment(tenant_id)', cypher: 'CREATE INDEX comment_tenant IF NOT EXISTS FOR (n:Comment) ON (n.tenant_id)' },
  // Metamodel definitions (id lookups from the dynamic CI resolvers; nodes are
  // MERGEd on (tenant_id, name), so `id` gets a plain index, not a constraint).
  { label: 'CITypeDefinition(id)', cypher: 'CREATE INDEX ci_type_definition_id IF NOT EXISTS FOR (n:CITypeDefinition) ON (n.id)' },
  { label: 'CITypeDefinition(tenant_id, name)', cypher: 'CREATE INDEX ci_type_definition_tenant_name IF NOT EXISTS FOR (n:CITypeDefinition) ON (n.tenant_id, n.name)' },
  { label: 'EnumTypeDefinition(id)', cypher: 'CREATE INDEX enum_type_definition_id IF NOT EXISTS FOR (n:EnumTypeDefinition) ON (n.id)' },
  { label: 'EnumTypeDefinition(tenant_id, name)', cypher: 'CREATE INDEX enum_type_definition_tenant_name IF NOT EXISTS FOR (n:EnumTypeDefinition) ON (n.tenant_id, n.name)' },
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
  // Riconoscimento del CI per nome negli allarmi (eventService.ts#matchCI):
  // `name_key` = toLower(name), scritto da chi crea/rinomina il CI
  // (apps/api/src/lib/ciNameKey.ts) e backfillato dalla migrazione
  // 20260909_1050_event_management_indexes.
  { label: 'ConfigurationItem(tenant_id, name_key)', cypher: 'CREATE INDEX ci_tenant_name_key IF NOT EXISTS FOR (n:ConfigurationItem) ON (n.tenant_id, n.name_key)' },
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
  { label: 'seed task counter', cypher: `
    MATCH (tk:ChangeTask) WHERE tk.tenant_id IS NOT NULL AND tk.code STARTS WITH 'TASK'
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
  await runStatements(COUNTER_SEEDS, 'CounterSeed')
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
