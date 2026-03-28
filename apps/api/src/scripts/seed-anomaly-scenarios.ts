/**
 * seed-anomaly-scenarios.ts
 *
 * Creates real anomalous situations in the CMDB graph so the scanner can detect them.
 * Safe to re-run (idempotent via MERGE / conditional logic).
 *
 * Scenarios:
 *   A — 3 Orphan CIs       (orphan_ci)
 *   B — 2 SPOFs             (spof)
 *   C — 1 Dependency cycle  (dependency_cycle)
 *   D — 3 Missing owners    (missing_owner)
 *   E — 2 Unauthorized rels (unauthorized_relation)
 *   F — 1 Risk concentration(risk_concentration)
 *   G — Isolated cluster    (isolated_cluster)
 */

import { v4 as uuidv4 } from 'uuid'
import neo4j from 'neo4j-driver'
import { getSession } from '@opengraphity/neo4j'

const TENANT = 'c-one'

async function run(session: ReturnType<typeof getSession>, label: string, cypher: string, params: Record<string, unknown> = {}) {
  console.log(`  → ${label}`)
  const result = await session.run(cypher, { tenantId: TENANT, ...params })
  const summary = result.summary.counters
  const c = summary as unknown as Record<string, () => number>
  const dels = (c['relationshipsDeleted']?.() ?? 0) + (c['nodesDeleted']?.() ?? 0)
  const adds = (c['relationshipsCreated']?.() ?? 0) + (c['nodesCreated']?.() ?? 0)
  if (dels > 0) console.log(`     deleted: ${dels}`)
  if (adds > 0) console.log(`     created: ${adds}`)
  return result
}

async function main() {
  // ── 0. CLEAN UP ───────────────────────────────────────────────────────────────
  console.log('\n=== 0. Pulizia nodi Anomaly e AnomalyConfig ===')
  const cleanSession = getSession(undefined, neo4j.session.WRITE)
  try {
    await cleanSession.run(`MATCH (a:Anomaly) DETACH DELETE a`)
    await cleanSession.run(`MATCH (c:AnomalyConfig) DETACH DELETE c`)
    console.log('  → eliminati tutti i nodi Anomaly e AnomalyConfig')
  } finally {
    await cleanSession.close()
  }

  // ── A. ORPHAN CIs ─────────────────────────────────────────────────────────────
  console.log('\n=== SCENARIO A — 3 CI Orfani ===')
  const sessionA = getSession(undefined, neo4j.session.WRITE)
  try {
    // Remove ALL relationships from 3 CI nodes to make them orphans
    for (const name of ['APP-100', 'SRV-500', 'DB-300']) {
      await run(sessionA, `Rimuovi tutte le relazioni da ${name}`, `
        MATCH (ci {name: $name, tenant_id: $tenantId})-[r]-()
        DELETE r
      `, { name })
    }
  } finally {
    await sessionA.close()
  }

  // ── B. SPOF ───────────────────────────────────────────────────────────────────
  console.log('\n=== SCENARIO B — 2 Single Points of Failure ===')
  const sessionB = getSession(undefined, neo4j.session.WRITE)
  try {
    // Make SRV-010 a SPOF: ≥5 production apps DEPEND_ON it
    await run(sessionB, 'SPOF #1: SRV-010 — 7 production apps DEPENDS_ON', `
      MATCH (srv:Server {name: 'SRV-010', tenant_id: $tenantId})
      MATCH (app:Application {tenant_id: $tenantId, environment: 'production'})
      WHERE NOT (app)-[:DEPENDS_ON]->(srv)
      WITH srv, app LIMIT 7
      MERGE (app)-[:DEPENDS_ON]->(srv)
    `)
    // Make SRV-020 a SPOF: 6 apps
    await run(sessionB, 'SPOF #2: SRV-020 — 6 production apps DEPENDS_ON', `
      MATCH (srv:Server {name: 'SRV-020', tenant_id: $tenantId})
      MATCH (app:Application {tenant_id: $tenantId, environment: 'production'})
      WHERE NOT (app)-[:DEPENDS_ON]->(srv)
      WITH srv, app LIMIT 6
      MERGE (app)-[:DEPENDS_ON]->(srv)
    `)
  } finally {
    await sessionB.close()
  }

  // ── C. DEPENDENCY CYCLE ───────────────────────────────────────────────────────
  console.log('\n=== SCENARIO C — Ciclo di Dipendenza ===')
  const sessionC = getSession(undefined, neo4j.session.WRITE)
  try {
    await run(sessionC, 'Ciclo: APP-001 → APP-050 → APP-150 → APP-001', `
      MATCH (a:Application {name: 'APP-001', tenant_id: $tenantId})
      MATCH (b:Application {name: 'APP-050', tenant_id: $tenantId})
      MATCH (c:Application {name: 'APP-150', tenant_id: $tenantId})
      MERGE (a)-[:DEPENDS_ON]->(b)
      MERGE (b)-[:DEPENDS_ON]->(c)
      MERGE (c)-[:DEPENDS_ON]->(a)
    `)
  } finally {
    await sessionC.close()
  }

  // ── D. MISSING OWNER ──────────────────────────────────────────────────────────
  console.log('\n=== SCENARIO D — 3 CI Senza Owner ===')
  const sessionD = getSession(undefined, neo4j.session.WRITE)
  try {
    for (const name of ['DB-200', 'DB-201', 'DB-202']) {
      await run(sessionD, `Rimuovi OWNED_BY da ${name}`, `
        MATCH (ci:Database {name: $name, tenant_id: $tenantId})-[r:OWNED_BY]->()
        DELETE r
      `, { name })
    }
  } finally {
    await sessionD.close()
  }

  // ── E. UNAUTHORIZED RELATIONS ─────────────────────────────────────────────────
  console.log('\n=== SCENARIO E — 2 Relazioni Non Autorizzate ===')
  const sessionE = getSession(undefined, neo4j.session.WRITE)
  try {
    await run(sessionE, 'SRV-001 -[:DEPENDS_ON]-> APP-001 (inverso)', `
      MATCH (srv:Server {name: 'SRV-001', tenant_id: $tenantId})
      MATCH (app:Application {name: 'APP-001', tenant_id: $tenantId})
      MERGE (srv)-[:DEPENDS_ON]->(app)
    `)
    await run(sessionE, 'SRV-002 -[:DEPENDS_ON]-> APP-002 (inverso)', `
      MATCH (srv:Server {name: 'SRV-002', tenant_id: $tenantId})
      MATCH (app:Application {name: 'APP-002', tenant_id: $tenantId})
      MERGE (srv)-[:DEPENDS_ON]->(app)
    `)
  } finally {
    await sessionE.close()
  }

  // ── F. RISK CONCENTRATION ─────────────────────────────────────────────────────
  console.log('\n=== SCENARIO F — Concentrazione di Rischio su SRV-010 ===')
  const sessionF = getSession(undefined, neo4j.session.WRITE)
  try {
    const now = new Date().toISOString()
    for (let i = 1; i <= 6; i++) {
      const id = uuidv4()
      await run(sessionF, `Incidente critico #${i} → SRV-010`, `
        MATCH (srv:Server {name: 'SRV-010', tenant_id: $tenantId})
        CREATE (inc:Incident {
          id:          $id,
          tenant_id:   $tenantId,
          title:       'Incidente critico automatico #' + toString($i),
          severity:    'critical',
          status:      'open',
          created_at:  $now,
          updated_at:  $now
        })
        CREATE (inc)-[:AFFECTS]->(srv)
      `, { id, i, now })
    }
  } finally {
    await sessionF.close()
  }

  // ── G. ISOLATED CLUSTER ───────────────────────────────────────────────────────
  console.log('\n=== SCENARIO G — Cluster Isolato (3 nodi LEGACY) ===')
  const sessionG = getSession(undefined, neo4j.session.WRITE)
  try {
    await run(sessionG, 'Crea LEGACY-SRV-01, LEGACY-APP-01, LEGACY-DB-01 (cluster)', `
      MERGE (srv:Server  {name: 'LEGACY-SRV-01', tenant_id: $tenantId})
        ON CREATE SET srv.id = randomUUID(), srv.status = 'active', srv.environment = 'production',
                      srv.description = 'Legacy server — cluster isolato', srv.created_at = datetime()
      MERGE (app:Application {name: 'LEGACY-APP-01', tenant_id: $tenantId})
        ON CREATE SET app.id = randomUUID(), app.status = 'active', app.environment = 'production',
                      app.description = 'Legacy app — cluster isolato', app.created_at = datetime()
      MERGE (db:Database {name: 'LEGACY-DB-01', tenant_id: $tenantId})
        ON CREATE SET db.id = randomUUID(), db.status = 'active', db.environment = 'production',
                      db.description = 'Legacy db — cluster isolato', db.created_at = datetime()
      MERGE (app)-[:HOSTED_ON]->(srv)
      MERGE (app)-[:DEPENDS_ON]->(db)
    `)
  } finally {
    await sessionG.close()
  }

  console.log('\n✓ Tutti gli scenari creati. Avvia lo scanner per rilevare le anomalie.')
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
