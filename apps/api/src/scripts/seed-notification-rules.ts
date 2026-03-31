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

const { values: args } = parseArgs({
  options: { slug: { type: 'string' } },
})

const slug = args['slug']
if (!slug) {
  console.error('Errore: argomento --slug mancante.')
  console.error('Uso: pnpm tsx apps/api/src/scripts/seed-notification-rules.ts --slug <tenant_id>')
  process.exit(1)
}

const session = getSession(undefined, 'WRITE')
try {
  console.log(`\nSeed NotificationRule per tenant: ${slug}\n`)
  await seedNotificationRules(slug, session)
  console.log('\nDone.')
} finally {
  await session.close()
  process.exit(0)
}
