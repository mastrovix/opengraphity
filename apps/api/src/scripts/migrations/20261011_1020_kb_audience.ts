/**
 * Owner's decision of 24 Sep 2026 («Pubblico per articolo»): every knowledge
 * article says who it is for. The portal showed the known errors to the end
 * users — 28 «Workaround: …» articles with internal causes and system names
 * (tour of 24 Sep 2026, G42).
 *
 * The existing articles get their audience from what they are: a known error
 * («Workaround: …» by title, tagged «known error», or linked to a problem) is for the staff; the others — how-to, FAQ — stay for everyone, as
 * the portal showed them so far. An article that already has an audience is
 * not touched. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'

export const kbAudience: Migration = {
  id: '20261011_1020_kb_audience',
  description: 'KBArticle.audience: known errors for the staff, the other articles for everyone',
  async up(session) {
    const res = await session.run(`
      MATCH (a:KBArticle)
      WHERE a.audience IS NULL
      WITH a,
           a.title STARTS WITH 'Workaround:'
             OR coalesce(a.tags, '') CONTAINS 'known error'
             OR EXISTS { MATCH (a)--(:Problem) } AS knownError
      SET a.audience = CASE WHEN knownError THEN 'staff' ELSE 'everyone' END
      RETURN a.audience AS audience, count(*) AS n
    `)
    for (const r of res.records) console.log(`[${kbAudience.id}] ${String(r.get('audience'))}: ${String(r.get('n'))}`)
  },
}
