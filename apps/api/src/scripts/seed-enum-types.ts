import { parseArgs } from 'node:util'
import { getSession } from '@opengraphity/neo4j'
import { seedSystemEnumTypes } from '../lib/seedEnumTypes.js'

const { values: args } = parseArgs({
  options: { 'tenant': { type: 'string' } },
})
const tenantId = args['tenant']
if (!tenantId) {
  console.error('Usage: tsx seed-enum-types.ts --tenant <slug>')
  process.exit(1)
}

const session = getSession(undefined, 'WRITE')
try {
  await seedSystemEnumTypes(tenantId, session)
  console.log(`✓ System enum types seeded for tenant: ${tenantId}`)
} finally {
  await session.close()
}
