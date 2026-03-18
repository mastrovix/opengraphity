/**
 * Creates Neo4j indexes for report nodes.
 * Run: tsx src/scripts/seed-report-templates.ts
 */
import neo4j from 'neo4j-driver'

const driver = neo4j.driver(
  process.env['NEO4J_URI'] ?? 'bolt://localhost:7687',
  neo4j.auth.basic(
    process.env['NEO4J_USER'] ?? 'neo4j',
    process.env['NEO4J_PASSWORD'] ?? 'opengraphity_local',
  ),
)

const indexes = [
  'CREATE INDEX report_template_tenant IF NOT EXISTS FOR (r:ReportTemplate) ON (r.tenant_id)',
  'CREATE INDEX report_template_created_by IF NOT EXISTS FOR (r:ReportTemplate) ON (r.created_by)',
  'CREATE INDEX report_section_template IF NOT EXISTS FOR (s:ReportSection) ON (s.template_id)',
  'CREATE INDEX traversal_step_section IF NOT EXISTS FOR (t:TraversalStep) ON (t.section_id)',
]

async function main() {
  const session = driver.session()
  try {
    for (const idx of indexes) {
      await session.run(idx)
      console.log('✓', idx.split('FOR')[0].trim())
    }
    console.log('Report indexes created.')
  } finally {
    await session.close()
    await driver.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
