import { seedChangeWorkflows } from './seed-change.js'

seedChangeWorkflows('c-one')
  .then(() => {
    console.log('Change workflows seeded')
    process.exit(0)
  })
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
