/**
 * THE TWO TENANTS OF THE INTEGRATION SUITE (wave 7 · C2).
 *
 * The suite runs against a real Neo4j, never against a stack: it writes two
 * whole tenants. They are born like a customer's (`onboardTenantGraph`, the
 * onboarding without the realm) and filled by the demo generator at a small
 * scale, with two different seeds — so the two graphs have the same shapes
 * and different ids, and a query that forgets the tenant finds the other's.
 */
import { getSession, runQuery } from '@opengraphity/neo4j'
import { onboardTenantGraph } from '../lib/tenantOnboarding.js'
import { generateDemoTenant } from '../lib/testData/demoTenant/generate.js'
import { scaledDemoCounts } from '../lib/testData/demoTenant/options.js'

export interface IntegrationTenant {
  id: string
  seed: string
}

export const TENANT_A: IntegrationTenant = { id: 'it-alpha', seed: 'integration-alpha' }
export const TENANT_B: IntegrationTenant = { id: 'it-beta', seed: 'integration-beta' }
export const INTEGRATION_TENANTS: readonly IntegrationTenant[] = [TENANT_A, TENANT_B]

/**
 * The smallest demo tenant the generator accepts: two operators for each of
 * the eleven teams need 55 users, and 0.02 of the default gives 60.
 */
export const INTEGRATION_SCALE = 0.02

/** The environment variable that says the database is a throwaway one. */
export const THROWAWAY_FLAG = 'OG_INTEGRATION_NEO4J'

/**
 * Refuses any database but a throwaway one: the suite writes two tenants and
 * must never do it on a stack. Two locks: the variable says so explicitly,
 * and the graph holds no tenant but the suite's own.
 */
export async function assertThrowawayDatabase(): Promise<void> {
  if (process.env[THROWAWAY_FLAG] !== 'throwaway') {
    throw new Error(`the integration suite writes two tenants: run it only against a throwaway Neo4j, with ${THROWAWAY_FLAG}=throwaway`)
  }
  const session = getSession(undefined, 'READ')
  try {
    const others = await runQuery<{ id: string }>(session,
      'MATCH (t:Tenant) WHERE NOT t.id IN $ours RETURN t.id AS id LIMIT 5',
      { ours: INTEGRATION_TENANTS.map((t) => t.id) })
    if (others.length > 0) {
      throw new Error(`this Neo4j holds other tenants (${others.map((o) => o.id).join(', ')}): the integration suite runs only on a throwaway database`)
    }
  } finally {
    await session.close()
  }
}

/** A tenant whose generator run finished: a local re-run keeps it instead of writing it again. */
async function completedRun(tenantId: string): Promise<boolean> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ n: number }>(session,
      `MATCH (r:DemoDataRun {tenant_id: $tenantId, status: 'completed'}) RETURN count(r) AS n`, { tenantId })
    return Number(rows[0]?.n ?? 0) > 0
  } finally {
    await session.close()
  }
}

/**
 * Onboards and fills the two tenants. A tenant already filled by a completed
 * run is kept (a local re-run takes seconds instead of minutes); one left
 * half-written by a failed run stops here: a throwaway database is thrown
 * away, not repaired.
 */
export async function prepareIntegrationTenants(log: (m: string) => void, nowMs: number): Promise<void> {
  await assertThrowawayDatabase()
  for (const t of INTEGRATION_TENANTS) {
    if (await completedRun(t.id)) {
      log(`${t.id}: already filled by a completed run, kept`)
      continue
    }
    await onboardTenantGraph({
      slug: t.id, tenantName: `Integration ${t.id}`, plan: 'enterprise', timezone: 'Europe/Rome',
      email: `admin@${t.id}.test`, firstName: 'Integration', lastName: 'Admin', adminRole: 'admin',
      domain: 'integration.test', production: false, piIp: undefined,
    }, (step) => log(`${t.id}: ${step}`))
    const run = await generateDemoTenant({ tenantId: t.id, seed: t.seed, nowMs, years: 3, counts: scaledDemoCounts(INTEGRATION_SCALE) }, (m) => log(`${t.id}: ${m}`))
    log(`${t.id}: ${String(run.nodes)} nodes, ${String(run.relationships)} relationships in ${String(Math.round(run.durationMs / 1000))} s`)
  }
}
