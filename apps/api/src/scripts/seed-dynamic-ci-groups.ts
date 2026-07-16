/**
 * Seed DynamicCIGroup CIs (ServiceNow-style Dynamic CI Groups) for the demo
 * tenant. Two flavours:
 *  - "Production Fleet": dynamic membership (server+application in production,
 *    resolved live by the ciGroupMembers query — no HAS_MEMBER edges)
 *  - "Billing Stack": manual membership via HAS_MEMBER toward APP-003 and the
 *    databases it depends on (DTB-009, DTB-148)
 * Idempotent: MERGE by name + tenant. Usage: pnpm seed:dynamic-ci-groups
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'
const now = new Date().toISOString()

interface GroupSeed {
  name:        string
  description: string
  fields:      Record<string, string>  // snake_case CI properties
  members:     string[]                // CI names for manual HAS_MEMBER edges
}

const GROUPS: GroupSeed[] = [
  {
    name: 'Production Fleet',
    description: 'Tutti i server e le applicazioni in production — membership dinamica valutata live dai criteri.',
    fields: {
      membership_type:      'dynamic',
      criteria_ci_types:    'server,application',
      criteria_environment: 'production',
    },
    members: [],
  },
  {
    name: 'Billing Stack',
    description: 'Stack di fatturazione: APP-003 e i database da cui dipende — membership manuale via HAS_MEMBER.',
    fields: {
      membership_type: 'manual',
    },
    members: ['APP-003', 'DTB-009', 'DTB-148'],
  },
]

async function main() {
  const session = getSession(undefined, 'WRITE')
  try {
    for (const g of GROUPS) {
      await session.executeWrite(async (tx) => {
        await tx.run(`
          MERGE (grp:DynamicCIGroup {name: $name, tenant_id: $tenantId})
          ON CREATE SET
            grp.id          = $id,
            grp.status      = 'active',
            grp.environment = 'production',
            grp.created_at  = $now
          SET grp.description = $description,
              grp.updated_at  = $now
          SET grp += $fields
        `, { name: g.name, description: g.description, fields: g.fields, id: uuidv4(), tenantId: TENANT_ID, now })

        if (g.members.length > 0) {
          await tx.run(`
            MATCH (grp:DynamicCIGroup {name: $name, tenant_id: $tenantId})
            UNWIND $members AS memberName
            MATCH (m {name: memberName, tenant_id: $tenantId})
            WHERE m:Application OR m:Database OR m:Server OR m:DatabaseInstance
            MERGE (grp)-[:HAS_MEMBER]->(m)
          `, { name: g.name, members: g.members, tenantId: TENANT_ID })
        }
      })
      const kind = g.fields['membership_type']
      console.log(`✓ ${g.name} (${kind})${g.members.length > 0 ? ` → HAS_MEMBER ${g.members.join(', ')}` : ''}`)
    }
  } finally {
    await session.close()
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => { console.error(err); process.exit(1) })
