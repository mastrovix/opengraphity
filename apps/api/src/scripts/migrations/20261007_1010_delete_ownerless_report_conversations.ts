/**
 * THE AI REPORT CONVERSATIONS SAVED BEFORE THEY HAD AN OWNER (23 Sep 2026).
 *
 * Since PR #83 a report conversation belongs to the person who had it, and
 * every read matches on `user_id`. The conversations saved before carry no
 * `user_id`: nobody can see them any more, and there is no record of who
 * started them, so they cannot be handed back to anyone. The owner of the
 * product decided to delete them rather than keep them hidden.
 *
 * Deleted with their messages (a message outside a conversation is never
 * read). Only nodes WITHOUT `user_id`: a conversation with an owner is never
 * touched. Idempotent: on a second run there is nothing left to match.
 */
import type { Migration } from '@opengraphity/neo4j'

export const deleteOwnerlessReportConversations: Migration = {
  id: '20261007_1010_delete_ownerless_report_conversations',
  description: 'Delete the AI report conversations saved before they had an owner (no user_id), with their messages',

  async up(session) {
    const result = await session.run(`
      MATCH (c:ReportConversation) WHERE c.user_id IS NULL
      OPTIONAL MATCH (c)-[:HAS_MESSAGE]->(m:ReportMessage)
      WITH c, collect(m) AS messages
      FOREACH (m IN messages | DETACH DELETE m)
      DETACH DELETE c
      RETURN count(c) AS conversations
    `)
    const n = result.records[0]?.get('conversations') as { toNumber?: () => number } | number | undefined
    const count = typeof n === 'number' ? n : (n?.toNumber?.() ?? 0)
    console.log(`[20261007_1010_delete_ownerless_report_conversations] ${String(count)} ownerless conversations deleted`)
  },
}
