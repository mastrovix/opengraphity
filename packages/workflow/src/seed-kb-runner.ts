import { seedKBWorkflowForTenant } from './seed-kb.js'

const tenantId = process.argv[2] ?? 'c-one'

seedKBWorkflowForTenant(tenantId)
  .then(() => {
    console.log(`KB workflow seeded for tenant: ${tenantId}`)
    process.exit(0)
  })
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
