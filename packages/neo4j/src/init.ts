import { getDriver, closeDriver } from './driver.js'
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
  {
    label: 'ConfigurationItem.id',
    cypher: 'CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (n:ConfigurationItem) REQUIRE n.id IS UNIQUE',
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
  { label: 'User(tenant_id, email)',    cypher: 'CREATE INDEX user_tenant_email IF NOT EXISTS FOR (u:User) ON (u.tenant_id, u.email)' },
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
]

async function runStatements(statements: SchemaStatement[], kind: string): Promise<void> {
  const driver = getDriver()
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE })

  try {
    for (const stmt of statements) {
      await session.run(stmt.cypher)
      console.log(`[neo4j:init] ${kind} created: ${stmt.label}`)
    }
  } finally {
    await session.close()
  }
}

async function main(): Promise<void> {
  console.log('[neo4j:init] Starting schema initialisation...')

  try {
    await runStatements(CONSTRAINTS, 'Constraint')
    await runStatements(INDEXES, 'Index')
    console.log('[neo4j:init] Schema initialisation complete.')
  } catch (err) {
    console.error('[neo4j:init] Error during initialisation:', err)
    process.exit(1)
  } finally {
    await closeDriver()
  }
}

main()
