import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'tenant-demo'

async function seed() {
  const session = getSession(undefined, neo4j.session.WRITE)

  let created = 0
  let skipped = 0
  const now = new Date().toISOString()

  for (let i = 1; i <= 70; i++) {
    const name = `TEA-${String(i).padStart(3, '0')}`
    const id   = uuidv4()
    const type = i % 2 === 0 ? 'owner' : 'support'

    const result = await session.run(
      `MERGE (t:Team {name: $name, tenant_id: $tenantId})
       ON CREATE SET
         t.id         = $id,
         t.tenant_id  = $tenantId,
         t.type       = $type,
         t.created_at = $createdAt
       RETURN t.id AS id, (t.created_at = $createdAt) AS wasCreated`,
      { name, tenantId: TENANT_ID, id, type, createdAt: now }
    )

    const wasCreated = result.records[0].get('wasCreated') as boolean
    if (wasCreated) { created++ } else { skipped++ }
  }

  await session.close()
  console.log(`Done. Created: ${created}, Skipped: ${skipped}`)
}

seed().catch((err) => { console.error(err); process.exit(1) })
