/**
 * Revisione del 14 set 2026 · F18: le change hanno `number` come incident,
 * problem e richieste (stesso valore del loro `code`). Ogni query trasversale
 * — ricerca, ticket collegati, approvazioni in attesa — doveva sapere che per
 * le change il numero si chiamava `code`. Qui lo si scrive sulle change
 * esistenti. Il vincolo di unicità (tenant_id, number) è in `packages/neo4j`
 * init (`migrate --init-schema`): una migrazione gira in una transazione di
 * scrittura, che non può contenere modifiche di schema. Idempotente.
 */
import type { Migration } from '@opengraphity/neo4j'

export const changeNumber: Migration = {
  id: '20260923_1080_change_number',
  description: 'Change.number = Change.code sulle change esistenti (il vincolo di unicità è in initSchema)',
  async up(session) {
    const r = await session.run(`
      MATCH (c:Change) WHERE c.number IS NULL AND c.code IS NOT NULL
      SET c.number = c.code
      RETURN c.tenant_id AS tenant, count(*) AS n
    `)
    for (const row of r.records) console.log(`[${changeNumber.id}] ${String(row.get('tenant'))}: ${String(row.get('n'))} change`)
  },
}
