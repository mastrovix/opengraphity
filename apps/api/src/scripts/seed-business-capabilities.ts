/**
 * Seed BusinessCapability CIs (CSDM-style capability map): a two-level
 * hierarchy (PARENT_OF) with each leaf enabled by BusinessApplication CIs
 * via (:BusinessCapability)-[:ENABLED_BY]->(:BusinessApplication).
 * Idempotent: MERGE by name + tenant. Usage: pnpm seed:business-capabilities
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'

const TENANT_ID = 'c-one'
const now = new Date().toISOString()

interface CapSeed {
  name:              string
  description:       string
  capabilityOwner:   string
  hierarchyLevel:    string
  strategicPriority: string
  maturity:          string
  parent?:           string     // parent capability name
  enabledBy?:        string[]   // BusinessApplication names
}

const CAPABILITIES: CapSeed[] = [
  // ── Level 1 ────────────────────────────────────────────────────────────────
  { name: 'Customer Management',  description: 'Gestione del ciclo di vita del cliente: acquisizione, relazione, retention.',
    capabilityOwner: 'Vittorio Mastrolilli', hierarchyLevel: 'level_1', strategicPriority: 'core', maturity: 'managed' },
  { name: 'Financial Management', description: 'Gestione finanziaria: fatturazione, incassi, controllo di gestione.',
    capabilityOwner: 'Marco Bianchi', hierarchyLevel: 'level_1', strategicPriority: 'core', maturity: 'defined' },
  { name: 'Workforce Management', description: 'Gestione del personale: amministrazione, presenze, self service.',
    capabilityOwner: 'Vittorio Mastrolilli', hierarchyLevel: 'level_1', strategicPriority: 'supporting', maturity: 'developing' },

  // ── Level 2 ────────────────────────────────────────────────────────────────
  { name: 'Customer Relationship', description: 'Gestione della relazione commerciale e post-vendita.',
    capabilityOwner: 'Vittorio Mastrolilli', hierarchyLevel: 'level_2', strategicPriority: 'differentiating', maturity: 'managed',
    parent: 'Customer Management', enabledBy: ['Customer Relationship Management'] },
  { name: 'Billing & Invoicing', description: 'Emissione fatture, riconciliazione e gestione pagamenti.',
    capabilityOwner: 'Marco Bianchi', hierarchyLevel: 'level_2', strategicPriority: 'core', maturity: 'defined',
    parent: 'Financial Management', enabledBy: ['Enterprise Billing'] },
  { name: 'Employee Self Service', description: 'Servizi self-service per i dipendenti: ferie, presenze, documenti.',
    capabilityOwner: 'Vittorio Mastrolilli', hierarchyLevel: 'level_2', strategicPriority: 'supporting', maturity: 'developing',
    parent: 'Workforce Management', enabledBy: ['HR Self Service'] },
]

async function main() {
  const session = getSession(undefined, 'WRITE')
  try {
    for (const cap of CAPABILITIES) {
      await session.executeWrite(async (tx) => {
        await tx.run(`
          MERGE (c:BusinessCapability {name: $name, tenant_id: $tenantId})
          ON CREATE SET
            c.id          = $id,
            c.status      = 'active',
            c.environment = 'production',
            c.created_at  = $now
          SET c.description       = $description,
              c.capabilityOwner   = $capabilityOwner,
              c.hierarchyLevel    = $hierarchyLevel,
              c.strategicPriority = $strategicPriority,
              c.maturity          = $maturity,
              c.updated_at        = $now
        `, { ...cap, parent: undefined, enabledBy: undefined, id: uuidv4(), tenantId: TENANT_ID, now })

        if (cap.parent) {
          await tx.run(`
            MATCH (child:BusinessCapability {name: $name, tenant_id: $tenantId})
            MATCH (parent:BusinessCapability {name: $parent, tenant_id: $tenantId})
            MERGE (parent)-[:PARENT_OF]->(child)
          `, { name: cap.name, parent: cap.parent, tenantId: TENANT_ID })
        }

        if (cap.enabledBy?.length) {
          await tx.run(`
            MATCH (c:BusinessCapability {name: $name, tenant_id: $tenantId})
            UNWIND $enabledBy AS baName
            MATCH (ba:BusinessApplication {name: baName, tenant_id: $tenantId})
            MERGE (c)-[:ENABLED_BY]->(ba)
          `, { name: cap.name, enabledBy: cap.enabledBy, tenantId: TENANT_ID })
        }
      })
      console.log(`✓ ${cap.name}${cap.parent ? ` (⊂ ${cap.parent})` : ''}${cap.enabledBy ? ` ← ENABLES ${cap.enabledBy.join(', ')}` : ''}`)
    }
  } finally {
    await session.close()
  }
}

main().then(() => process.exit(0)).catch((err: unknown) => { console.error(err); process.exit(1) })
