/**
 * Migration 20261007_1010: the AI report conversations saved before they had
 * an owner are deleted, with their messages.
 *
 * Why it matters: a deletion that matched too wide would wipe conversations
 * people have today; one that left the messages behind would keep the very
 * text the owner decided to remove.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { deleteOwnerlessReportConversations } = await import('../20261007_1010_delete_ownerless_report_conversations.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

function session(count: unknown) {
  const cyphers: string[] = []
  const run = vi.fn(async (c: string) => {
    cyphers.push(c)
    return { records: [{ get: () => count }] }
  })
  return { session: { run }, cyphers }
}

describe('20261007_1010_delete_ownerless_report_conversations', () => {
  it('is registered last, after the 20261006 ones', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.at(-1)).toBe('20261007_1010_delete_ownerless_report_conversations')
  })

  it('matches ONLY conversations without an owner, and deletes their messages with them', async () => {
    const { session: s, cyphers } = session(3)
    await deleteOwnerlessReportConversations.up(s as never)
    expect(cyphers).toHaveLength(1)
    expect(cyphers[0]).toContain('MATCH (c:ReportConversation) WHERE c.user_id IS NULL')
    expect(cyphers[0]).toContain('(c)-[:HAS_MESSAGE]->(m:ReportMessage)')
    expect(cyphers[0]).toContain('DETACH DELETE m')
    expect(cyphers[0]).toContain('DETACH DELETE c')
    expect(lines).toEqual(['[20261007_1010_delete_ownerless_report_conversations] 3 ownerless conversations deleted'])
  })

  it('reads the count from a Neo4j integer, and a second run reports zero', async () => {
    await deleteOwnerlessReportConversations.up(session({ toNumber: () => 2 }).session as never)
    await deleteOwnerlessReportConversations.up(session(undefined).session as never)
    expect(lines).toEqual([
      '[20261007_1010_delete_ownerless_report_conversations] 2 ownerless conversations deleted',
      '[20261007_1010_delete_ownerless_report_conversations] 0 ownerless conversations deleted',
    ])
  })
})
