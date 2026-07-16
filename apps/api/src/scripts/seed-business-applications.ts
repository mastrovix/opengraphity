/**
 * Seed BusinessApplication CIs (CSDM-style business catalog entries) linked
 * via REALIZES to existing Application CIs and OWNED_BY to existing teams.
 * Idempotent: MERGE by name + tenant. Usage: pnpm seed:business-applications
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'
const now = new Date().toISOString()

interface BASeed {
  name:          string
  description:   string
  businessOwner: string
  criticality:   string
  businessUnit:  string
  costCenter:    string
  userBase:      string
  realizes:      string[]   // Application names
}

const BUSINESS_APPS: BASeed[] = [
  {
    name: 'Customer Relationship Management',
    description: 'Piattaforma CRM aziendale: anagrafiche clienti, pipeline commerciale e post-vendita.',
    businessOwner: 'Vittorio Mastrolilli', criticality: 'business_critical',
    businessUnit: 'Sales', costCenter: 'CC-100', userBase: '~250 utenti',
    realizes: ['APP-001', 'APP-002'],
  },
  {
    name: 'Enterprise Billing',
    description: 'Sistema di fatturazione e riconciliazione pagamenti.',
    businessOwner: 'Marco Bianchi', criticality: 'mission_critical',
    businessUnit: 'Finance', costCenter: 'CC-200', userBase: '~40 utenti',
    realizes: ['APP-003'],
  },
  {
    name: 'HR Self Service',
    description: 'Portale dipendenti: ferie, presenze, buste paga.',
    businessOwner: 'Vittorio Mastrolilli', criticality: 'business_operational',
    businessUnit: 'Human Resources', costCenter: 'CC-300', userBase: 'tutti i dipendenti',
    realizes: ['APP-004', 'APP-005'],
  },
]

async function main() {
  const session = getSession(undefined, 'WRITE')
  try {
    for (const ba of BUSINESS_APPS) {
      await session.executeWrite(async (tx) => {
        await tx.run(`
          MERGE (b:BusinessApplication {name: $name, tenant_id: $tenantId})
          ON CREATE SET
            b.id          = $id,
            b.status      = 'active',
            b.environment = 'production',
            b.created_at  = $now
          SET b.description    = $description,
              b.businessOwner  = $businessOwner,
              b.criticality    = $criticality,
              b.businessUnit   = $businessUnit,
              b.costCenter     = $costCenter,
              b.userBase       = $userBase,
              b.updated_at     = $now
        `, { ...ba, id: uuidv4(), tenantId: TENANT_ID, now })

        await tx.run(`
          MATCH (b:BusinessApplication {name: $name, tenant_id: $tenantId})
          UNWIND $realizes AS appName
          MATCH (a:Application {name: appName, tenant_id: $tenantId})
          MERGE (b)-[:REALIZES]->(a)
        `, { name: ba.name, realizes: ba.realizes, tenantId: TENANT_ID })

        // Owner team: inherit the owner of the first realized application
        await tx.run(`
          MATCH (b:BusinessApplication {name: $name, tenant_id: $tenantId})
          MATCH (b)-[:REALIZES]->(a:Application)-[:OWNED_BY]->(t:Team)
          WITH b, t ORDER BY a.name LIMIT 1
          MERGE (b)-[:OWNED_BY]->(t)
        `, { name: ba.name, tenantId: TENANT_ID })
      })
      console.log(`✓ ${ba.name} → REALIZES ${ba.realizes.join(', ')}`)
    }
  } finally {
    await session.close()
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => { console.error(err); process.exit(1) })
