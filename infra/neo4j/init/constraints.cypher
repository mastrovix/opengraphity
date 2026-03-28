// Neo4j constraint init — run once on a fresh database
// Execute via: cypher-shell -u neo4j -p <password> -f constraints.cypher

// Unique user per tenant (prevents email collision across tenants)
CREATE CONSTRAINT unique_user_email_per_tenant IF NOT EXISTS
FOR (u:User) REQUIRE (u.tenant_id, u.email) IS NODE KEY;

// Unique incident id (global — IDs are UUIDs)
CREATE CONSTRAINT unique_incident_id IF NOT EXISTS
FOR (i:Incident) REQUIRE i.id IS UNIQUE;

// Unique change id
CREATE CONSTRAINT unique_change_id IF NOT EXISTS
FOR (c:Change) REQUIRE c.id IS UNIQUE;

// Unique CI id
CREATE CONSTRAINT unique_ci_id IF NOT EXISTS
FOR (ci:ConfigurationItem) REQUIRE ci.id IS UNIQUE;

// Unique team id
CREATE CONSTRAINT unique_team_id IF NOT EXISTS
FOR (t:Team) REQUIRE t.id IS UNIQUE;

// Index on tenant_id for all major node types (performance)
CREATE INDEX idx_incident_tenant   IF NOT EXISTS FOR (n:Incident)            ON (n.tenant_id);
CREATE INDEX idx_change_tenant     IF NOT EXISTS FOR (n:Change)              ON (n.tenant_id);
CREATE INDEX idx_problem_tenant    IF NOT EXISTS FOR (n:Problem)             ON (n.tenant_id);
CREATE INDEX idx_team_tenant       IF NOT EXISTS FOR (n:Team)                ON (n.tenant_id);
CREATE INDEX idx_logentry_tenant   IF NOT EXISTS FOR (n:LogEntry)            ON (n.tenant_id);
CREATE INDEX idx_anomaly_tenant    IF NOT EXISTS FOR (n:Anomaly)             ON (n.tenant_id);
CREATE INDEX idx_workflow_tenant   IF NOT EXISTS FOR (n:WorkflowDefinition)  ON (n.tenant_id);
CREATE INDEX idx_dashboard_tenant  IF NOT EXISTS FOR (n:DashboardConfig)     ON (n.tenant_id);
