/**
 * Seed ITIL-CI relation rules for a tenant.
 * Usage: npx tsx src/scripts/seed-itil-ci-rules.ts --tenant-id c-one
 */
import { getSession } from '@opengraphity/neo4j'
import { v4 as uuidv4 } from 'uuid'

const tenantId = (() => {
  const idx = process.argv.indexOf('--tenant-id')
  if (idx < 0 || !process.argv[idx + 1]) {
    process.stderr.write('Usage: seed-itil-ci-rules.ts --tenant-id <id>\n')
    process.exit(1)
  }
  return process.argv[idx + 1]
})()

interface RuleSpec {
  itilType:     string
  ciType:       string
  relationType: string
  direction:    string
  description:  string
}

const RULES: RuleSpec[] = [
  // Incident
  { itilType: 'incident', ciType: 'server',            relationType: 'IMPACTS',   direction: 'outgoing', description: 'Server impattati dall\'incident' },
  { itilType: 'incident', ciType: 'application',       relationType: 'IMPACTS',   direction: 'outgoing', description: 'Applicazioni impattate dall\'incident' },
  { itilType: 'incident', ciType: 'database',          relationType: 'IMPACTS',   direction: 'outgoing', description: 'Database impattati dall\'incident' },
  // Change
  { itilType: 'change',   ciType: 'server',            relationType: 'MODIFIES',  direction: 'outgoing', description: 'Server modificati dalla change' },
  { itilType: 'change',   ciType: 'application',       relationType: 'MODIFIES',  direction: 'outgoing', description: 'Applicazioni modificate dalla change' },
  { itilType: 'change',   ciType: 'database',          relationType: 'MODIFIES',  direction: 'outgoing', description: 'Database modificati dalla change' },
  // Problem
  { itilType: 'problem',  ciType: 'server',            relationType: 'ROOT_CAUSE', direction: 'outgoing', description: 'Server causa del problem' },
  { itilType: 'problem',  ciType: 'application',       relationType: 'ROOT_CAUSE', direction: 'outgoing', description: 'Applicazioni causa del problem' },
  { itilType: 'problem',  ciType: 'database',          relationType: 'ROOT_CAUSE', direction: 'outgoing', description: 'Database causa del problem' },
]

async function main() {
  const session = getSession()
  const now     = new Date().toISOString()
  let created = 0
  let skipped = 0

  try {
    for (const rule of RULES) {
      const existing = await session.executeRead((tx) =>
        tx.run(
          `MATCH (r:ITILCIRelationRule {tenant_id: $tenantId, itil_type: $itilType, ci_type: $ciType})
           RETURN r.id AS id LIMIT 1`,
          { tenantId, itilType: rule.itilType, ciType: rule.ciType },
        ),
      )
      if (existing.records.length > 0) {
        skipped++
        continue
      }
      await session.executeWrite((tx) =>
        tx.run(
          `CREATE (r:ITILCIRelationRule {
             id:            $id,
             tenant_id:     $tenantId,
             itil_type:     $itilType,
             ci_type:       $ciType,
             relation_type: $relationType,
             direction:     $direction,
             description:   $description,
             created_at:    $now
           })`,
          { id: uuidv4(), tenantId, ...rule, now },
        ),
      )
      created++
    }
    process.stdout.write(`ITIL-CI rules seed: ${created} created, ${skipped} already existed (tenant=${tenantId})\n`)
  } finally {
    await session.close()
    process.exit(0)
  }
}

main().catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1) })
