/**
 * Semina i vocabolari SPEDITI col prodotto su `tenant_id = 'system'`.
 *
 * Non prende `--tenant`: i vocabolari spediti sono uno per tutti i clienti
 * (A-2 / C-6). Le copie per tenant sono le personalizzazioni e si creano da
 * `customizeEnumType`, non da qui.
 */
import { getSession } from '@opengraphity/neo4j'
import { seedSystemEnumTypes } from '../lib/seedEnumTypes.js'

const session = getSession(undefined, 'WRITE')
try {
  await seedSystemEnumTypes(session)
  console.log(`✓ Vocabolari spediti seminati su tenant_id='system'`)
} finally {
  await session.close()
}
