/**
 * Populates the `chain` field on all CIs for a tenant using chain families.
 *
 * Logic:
 * - CIs whose type has chain_families = ["Application"] → "Application"
 * - CIs whose type has chain_families = ["Infrastructure"] → "Infrastructure"
 * - Ambiguous CIs (multiple families): check upstream for Application-only types
 * - Everything else → "Infrastructure"
 *
 * Usage: pnpm tsx apps/api/src/scripts/seed-ci-chain.ts --slug c-one
 */
import { calculateAllChains } from '../lib/chainCalculator.js'
import { resolveTenantArg } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

// H-45: il tenant lo legge `resolveTenantArg` (che accetta --tenant, --tenant-id
// e --slug) e il processo lo chiude `runScript`, che chiude anche il driver
// Neo4j: `process.exit` troncava i log asincroni.
async function main() {
  const slug = resolveTenantArg()
  const { total, app, infra } = await calculateAllChains(slug)
  console.log(`CI chain populated for tenant "${slug}": ${total} total, ${app} Application, ${infra} Infrastructure`)
}

runScript('seed-ci-chain', main)
