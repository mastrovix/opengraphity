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

// ── Fulltext index for the command-palette global search ─────────────────────
// CONTAINS on 278k+ nodes cannot use range indexes; the fulltext index gives
// indexed prefix search across every searchable entity type.
CREATE FULLTEXT INDEX global_search IF NOT EXISTS
FOR (n:Incident|Change|Problem|ServiceRequest|KBArticle|BusinessCapability|BusinessApplication|Application|Database|DatabaseInstance|Server|Certificate|SslCertificate|VirtualMachine|NetworkDevice|Storage|CloudService|ApiEndpoint|Microservice)
ON EACH [n.title, n.number, n.code, n.name];

// ── Range indexes on change-task codes (global search: tasks group) ──────────
// Honest note: range indexes do NOT accelerate the CONTAINS predicate used by
// the task search; they only help STARTS WITH / equality lookups on codes
// (e.g. pasting a full "TASK00000042"). Added per spec anyway.
CREATE INDEX assessment_task_code  IF NOT EXISTS FOR (t:AssessmentTask) ON (t.code);
CREATE INDEX deploy_plan_task_code IF NOT EXISTS FOR (t:DeployPlanTask) ON (t.code);
CREATE INDEX validation_test_code  IF NOT EXISTS FOR (t:ValidationTest) ON (t.code);
CREATE INDEX deployment_task_code  IF NOT EXISTS FOR (t:DeploymentTask) ON (t.code);
CREATE INDEX review_task_code      IF NOT EXISTS FOR (t:ReviewTask)     ON (t.code);
