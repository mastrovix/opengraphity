/**
 * ONE WATCHES EDGE PER PERSON AND TICKET (review of 23 Sep 2026, api-tickets#0).
 *
 * Following a ticket was written `MERGE (u)-[:WATCHES {watched_at: $now}]->(e)`:
 * the timestamp was part of the match, so every comment by someone already
 * following it added one more edge, and every later event reached that person
 * once per edge — a comment thread of ten meant ten e-mails for each note.
 * The writes now set the timestamp only when the edge is created; this folds
 * the edges already doubled into one, keeping the earliest `watched_at` (when
 * the person started following). Idempotent: the second run finds nothing.
 */
import type { Migration } from '@opengraphity/neo4j'

export const watchesCollapseDuplicates: Migration = {
  id: '20261008_1020_watches_collapse_duplicates',
  description: 'Review of 23 Sep 2026: duplicate WATCHES edges between the same person and ticket folded into one, keeping the earliest watched_at',
  async up(session) {
    const res = await session.run(`
      MATCH (u:User)-[w:WATCHES]->(e)
      WITH u, e, collect(w) AS edges
      WHERE size(edges) > 1
      WITH u, e, edges, reduce(first = null, x IN edges |
        CASE WHEN first IS NULL OR (x.watched_at IS NOT NULL AND x.watched_at < first.watched_at) THEN x ELSE first END) AS keep
      FOREACH (x IN [d IN edges WHERE d <> keep] | DELETE x)
      RETURN coalesce(e.tenant_id, '') AS tenant, count(*) AS pairs, sum(size(edges) - 1) AS removed
      ORDER BY tenant
    `)
    let removed = 0
    for (const r of res.records) {
      const n = Number(r.get('removed'))
      removed += n
      console.log(`[${watchesCollapseDuplicates.id}] ${String(r.get('tenant'))}: ${String(Number(r.get('pairs')))} person-ticket pairs, ${String(n)} duplicate edges removed`)
    }
    console.log(`[${watchesCollapseDuplicates.id}] ${String(removed)} duplicate WATCHES edges removed`)
  },
}
