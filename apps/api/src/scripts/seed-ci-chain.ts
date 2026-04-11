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

const slug = process.argv.find((_, i, a) => a[i - 1] === '--slug') ?? process.argv.find((_, i, a) => a[i - 1] === '--tenant-id')
if (!slug) { console.error('Usage: seed-ci-chain.ts --slug <tenant-id>'); process.exit(1) }

async function main() {
  const { total, app, infra } = await calculateAllChains(slug!)
  console.log(`CI chain populated for tenant "${slug}": ${total} total, ${app} Application, ${infra} Infrastructure`)
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
