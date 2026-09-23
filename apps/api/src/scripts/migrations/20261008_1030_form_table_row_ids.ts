/**
 * EVERY FORM TABLE ROW HAS AN ID (review of 23 Sep 2026).
 *
 * The rows of a catalog form's table were created without `id`. The restore
 * finds a node again by its id: without one it matched a row by its values,
 * so two requests with the same line (same item, same quantity) came back
 * sharing ONE row, and the relationship to the request was not rebuilt — the
 * first real restore, on a copy, lost 12,736 of them. The rows are now
 * written with an id; this gives one to the rows written before. Idempotent:
 * only rows without an id are touched. `autocommit`: `CALL … IN TRANSACTIONS`
 * cannot run inside the migration marker's transaction.
 */
import type { Migration } from '@opengraphity/neo4j'

export const formTableRowIds: Migration = {
  id: '20261008_1030_form_table_row_ids',
  description: 'Review of 23 Sep 2026: every FormTableRow without an id gets one (the restore finds nodes by id)',
  autocommit: true,
  async up(session) {
    const res = await session.run(`
      MATCH (r:FormTableRow) WHERE r.id IS NULL
      CALL (r) { SET r.id = randomUUID() } IN TRANSACTIONS OF 5000 ROWS
      RETURN count(r) AS updated
    `, {})
    console.log(`[${formTableRowIds.id}] ${String(Number(res.records[0]?.get('updated') ?? 0))} form table rows got an id`)
  },
}
