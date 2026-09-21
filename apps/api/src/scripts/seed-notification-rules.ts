/**
 * Seed default NotificationRule nodes for an existing tenant.
 * Idempotent: safe to run multiple times (uses MERGE).
 *
 * Usage:
 *   pnpm tsx apps/api/src/scripts/seed-notification-rules.ts --slug <tenant_slug>
 *
 * Required env vars: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
 */

import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'
import { seedNotificationRules } from '../lib/seedNotificationRules.js'
import { runScript } from './lib/runScript.js'
import { ScriptArgError } from './lib/scriptArgs.js'

const { values: args } = parseArgs({
  options: { slug: { type: 'string' } },
})

/** Il tenant, o un errore che dice come si passa: nessun default. */
function requireSlug(): string {
  const slug = args['slug']
  if (!slug) {
    throw new ScriptArgError(
      'argomento --slug mancante. Uso: pnpm tsx apps/api/src/scripts/seed-notification-rules.ts --slug <tenant_id>',
    )
  }
  return slug
}

// H-45: un solo runner. L'errore lo stampa e lo conta `runScript`, che chiude
// anche il driver Neo4j: nessun `process.exit`, che troncava i log asincroni.
async function main(): Promise<void> {
  const slug = requireSlug()
  const session = getSession(undefined, 'WRITE')
  try {
    console.log(`\nSeed NotificationRule per tenant: ${slug}\n`)
    await seedNotificationRules(slug, session)
    console.log('\nDone.')
  } finally {
    await session.close()
  }
}

runScript('seed-notification-rules', main)
