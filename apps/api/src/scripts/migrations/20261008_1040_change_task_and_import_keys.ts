/**
 * Review of 23 Sep 2026: the keys two paths look nodes up by had no index.
 *
 *  - The change tasks (assessment, deploy plan, validation, deployment,
 *    review) are MERGEd on `change_key`: each MERGE scanned the label across
 *    every tenant, and without a uniqueness constraint two simultaneous «add
 *    CI» calls could both create the task.
 *  - The ticket import finds each row's ticket by `import_external_id`, four
 *    times per row: each lookup scanned the tenant's tickets of that type.
 *
 * The constraints are declared in packages/neo4j/src/init.ts (the single
 * source of the schema); here they are created with the same form, for a
 * database that already exists. Checked before writing: no duplicate key on
 * either side (23 Sep 2026, demo-opengrafo and opengrafo), and every change
 * task has both `tenant_id` and `change_key`.
 *
 * Idempotent: `CREATE CONSTRAINT ... IF NOT EXISTS`.
 */
import type { Migration } from '@opengraphity/neo4j'

export const changeTaskAndImportKeys: Migration = {
  id:          '20261008_1040_change_task_and_import_keys',
  description: 'Review of 23 Sep 2026: unique (tenant_id, change_key) on the change tasks and (tenant_id, import_external_id) on imported tickets',

  async up(session) {
    const statements = [
      'CREATE CONSTRAINT assessment_task_change_key_unique IF NOT EXISTS FOR (t:AssessmentTask) REQUIRE (t.tenant_id, t.change_key) IS UNIQUE',
      'CREATE CONSTRAINT deploy_plan_task_change_key_unique IF NOT EXISTS FOR (t:DeployPlanTask) REQUIRE (t.tenant_id, t.change_key) IS UNIQUE',
      'CREATE CONSTRAINT validation_test_change_key_unique IF NOT EXISTS FOR (t:ValidationTest) REQUIRE (t.tenant_id, t.change_key) IS UNIQUE',
      'CREATE CONSTRAINT deployment_task_change_key_unique IF NOT EXISTS FOR (t:DeploymentTask) REQUIRE (t.tenant_id, t.change_key) IS UNIQUE',
      'CREATE CONSTRAINT review_task_change_key_unique IF NOT EXISTS FOR (t:ReviewTask) REQUIRE (t.tenant_id, t.change_key) IS UNIQUE',
      'CREATE CONSTRAINT incident_import_external_id_unique IF NOT EXISTS FOR (n:Incident) REQUIRE (n.tenant_id, n.import_external_id) IS UNIQUE',
      'CREATE CONSTRAINT problem_import_external_id_unique IF NOT EXISTS FOR (n:Problem) REQUIRE (n.tenant_id, n.import_external_id) IS UNIQUE',
      'CREATE CONSTRAINT change_import_external_id_unique IF NOT EXISTS FOR (n:Change) REQUIRE (n.tenant_id, n.import_external_id) IS UNIQUE',
      'CREATE CONSTRAINT service_request_import_external_id_unique IF NOT EXISTS FOR (n:ServiceRequest) REQUIRE (n.tenant_id, n.import_external_id) IS UNIQUE',
      'CREATE CONSTRAINT kb_article_import_external_id_unique IF NOT EXISTS FOR (n:KBArticle) REQUIRE (n.tenant_id, n.import_external_id) IS UNIQUE',
    ]
    for (const q of statements) await session.run(q)
    console.log(`  ${statements.length} constraints checked`)
  },
  // Schema commands do not run in the marker's transaction: Neo4j refuses them.
  autocommit: true,
}
