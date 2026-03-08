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
