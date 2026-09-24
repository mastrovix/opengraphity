import { describe, it, expect, vi } from 'vitest'
import { ensureConversation, loadRecentHistory, runReportConversation, saveMessage, HISTORY_LIMIT, REPORT_QUESTION_MAX_CHARS } from '../reportConversation.js'

type Run = (q: string, p: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }>

/** Session whose tx.run dispatches on the Cypher text; records every call. */
function fakeSession(dispatch: (q: string, p: Record<string, unknown>) => Array<Record<string, unknown>>) {
  const calls: Array<{ q: string; p: Record<string, unknown> }> = []
  const run: Run = async (q, p) => {
    calls.push({ q, p })
    return { records: dispatch(q, p).map(r => ({ get: (k: string) => r[k] })) }
  }
  return {
    calls,
    executeRead:  vi.fn().mockImplementation((fn: (tx: { run: Run }) => unknown) => fn({ run })),
    executeWrite: vi.fn().mockImplementation((fn: (tx: { run: Run }) => unknown) => fn({ run })),
    close: vi.fn(),
  }
}

describe('loadRecentHistory (C-10)', () => {
  it('asks for the LAST N messages (DESC + LIMIT), excludes the just-saved message, returns oldest first', async () => {
    // Neo4j returns newest first; the service must reverse it.
    const s = fakeSession(() => [
      { role: 'assistant', content: 'a3' }, { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a2' }, { role: 'user', content: 'u2' },
    ])
    const history = await loadRecentHistory(s as never, 't1', 'u1', 'c1', 'msg-new')

    expect(history.map(m => m.content)).toEqual(['u2', 'a2', 'u3', 'a3'])
    const { q, p } = s.calls[0]!
    expect(q).toContain('ReportConversation {id: $convId, tenant_id: $tenantId, user_id: $userId}')
    expect(q).toContain('WHERE m.id <> $excludeId')
    expect(q).toContain('ORDER BY m.created_at DESC')
    expect(q).toContain('LIMIT toInteger($limit)')
    expect(p).toEqual({ convId: 'c1', tenantId: 't1', userId: 'u1', excludeId: 'msg-new', limit: HISTORY_LIMIT })
  })
})

describe('saveMessage', () => {
  it('throws when the conversation is not in the tenant (no silent "saved" of a dangling message)', async () => {
    const s = fakeSession(() => [])
    await expect(saveMessage(s as never, 't1', 'u1', 'ghost', 'user', 'ciao')).rejects.toThrow('ReportConversation ghost not found')
  })

  it('creates the message and bumps the conversation in the same statement', async () => {
    const s = fakeSession(() => [{ id: 'x' }])
    const m = await saveMessage(s as never, 't1', 'u1', 'c1', 'assistant', 'risposta')
    expect(m).toMatchObject({ role: 'assistant', content: 'risposta' })
    expect(s.calls[0]!.q).toContain('SET c.updated_at = $now')
    expect(s.calls[0]!.p).toMatchObject({ convId: 'c1', tenantId: 't1', userId: 'u1', role: 'assistant', content: 'risposta', id: m.id })
  })
})

describe('runReportConversation — the shared turn used by GraphQL and SSE', () => {
  it('new conversation: create → notify → save user → history (excluding it) → ask → save assistant', async () => {
    const s = fakeSession((q) => {
      if (q.includes('CREATE (m:ReportMessage')) return [{ id: 'saved' }]
      if (q.includes('ORDER BY m.created_at DESC')) return [{ role: 'assistant', content: 'prima risposta' }, { role: 'user', content: 'prima domanda' }]
      return []
    })
    const onCreated = vi.fn()
    const ask = vi.fn().mockResolvedValue('ecco la risposta')

    const out = await runReportConversation({
      session: s as never, tenantId: 't1', userId: 'u1', question: 'quanti incidenti?', conversationId: null,
      ask, onConversationCreated: onCreated,
    })

    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledWith(out.conversationId)
    // history is oldest → newest and does not contain the question itself
    expect(ask).toHaveBeenCalledWith([{ role: 'user', content: 'prima domanda' }, { role: 'assistant', content: 'prima risposta' }], 'quanti incidenti?')
    expect(out.message).toMatchObject({ role: 'assistant', content: 'ecco la risposta' })

    const kinds = s.calls.map(c =>
      c.q.includes('CREATE (:ReportConversation') ? 'create-conv'
      : c.q.includes('ORDER BY m.created_at DESC') ? 'history'
      : c.q.includes('CREATE (m:ReportMessage') ? `save-${c.p['role']}`
      : 'other')
    expect(kinds).toEqual(['create-conv', 'save-user', 'history', 'save-assistant'])
    const historyCall = s.calls.find(c => c.q.includes('ORDER BY m.created_at DESC'))!
    const userSave    = s.calls.find(c => c.p['role'] === 'user')!
    expect(historyCall.p['excludeId']).toBe(userSave.p['id'])
  })

  it('existing conversation: no create, no notification', async () => {
    const s = fakeSession((q) => (q.includes('CREATE (m:ReportMessage') || q.includes('RETURN c.id AS id') ? [{ id: 'x' }] : []))
    const onCreated = vi.fn()
    const out = await runReportConversation({
      session: s as never, tenantId: 't1', userId: 'u1', question: 'q', conversationId: 'c-existing',
      ask: async () => 'r', onConversationCreated: onCreated,
    })
    expect(out.conversationId).toBe('c-existing')
    expect(onCreated).not.toHaveBeenCalled()
    expect(s.calls.some(c => c.q.includes('CREATE (:ReportConversation'))).toBe(false)
  })

  it('a failing ask propagates: no assistant message is saved', async () => {
    const s = fakeSession((q) => (q.includes('CREATE (m:ReportMessage') || q.includes('RETURN c.id AS id') ? [{ id: 'x' }] : []))
    await expect(runReportConversation({
      session: s as never, tenantId: 't1', userId: 'u1', question: 'q', conversationId: 'c1',
      ask: async () => { throw new Error('overloaded') },
    })).rejects.toThrow('overloaded')
    expect(s.calls.filter(c => c.p['role'] === 'assistant')).toHaveLength(0)
  })

  // Review of 23 Sep 2026: a question is saved and sent again in the next ten turns — it had no cap.
  it('a question over the cap is refused with its key before anything is saved or asked', async () => {
    const s = fakeSession(() => [])
    const ask = vi.fn()
    await expect(runReportConversation({
      session: s as never, tenantId: 't1', userId: 'u1', question: 'x'.repeat(REPORT_QUESTION_MAX_CHARS + 1), conversationId: null, ask,
    })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.report.questionTooLong' } } })
    expect(s.calls).toHaveLength(0)
    expect(ask).not.toHaveBeenCalled()
  })
})

/*
 * A report conversation belongs to the person who started it. Before 23 Sep
 * 2026 it was scoped to the tenant only: anyone in the tenant could list, read,
 * continue and delete everybody else's — and a question asked of the AI can
 * carry things the asker would not show a colleague.
 */
describe('ensureConversation — a conversation is private to its owner', () => {
  it('a new conversation is stamped with the asker, so only they can find it again', async () => {
    const s = fakeSession(() => [])
    const out = await ensureConversation(s as never, 't1', 'u1', null, 'how many P1 this week?')
    expect(out.created).toBe(true)
    const create = s.calls.find(c => c.q.includes('CREATE (:ReportConversation'))!
    expect(create.q).toContain('user_id: $userId')
    expect(create.p).toMatchObject({ id: out.conversationId, tenantId: 't1', userId: 'u1' })
  })

  it("continuing someone else's conversation is 'not found' and writes nothing", async () => {
    // The lookup is scoped to the asker: another user's id matches no row.
    const s = fakeSession(() => [])
    await expect(ensureConversation(s as never, 't1', 'intruder', 'c-of-alice', 'q'))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.q).toContain('{id: $id, tenant_id: $tenantId, user_id: $userId}')
    expect(s.calls[0]!.p).toEqual({ id: 'c-of-alice', tenantId: 't1', userId: 'intruder' })
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('the full turn stops before saving the question or calling the AI', async () => {
    // Without this, the intruder's question would be appended to Alice's
    // conversation and Alice's history would be sent to the AI on their behalf.
    const s = fakeSession(() => [])
    const ask = vi.fn()
    await expect(runReportConversation({
      session: s as never, tenantId: 't1', userId: 'intruder', question: 'what did Alice ask?', conversationId: 'c-of-alice', ask,
    })).rejects.toThrow('ReportConversation c-of-alice not found')
    expect(ask).not.toHaveBeenCalled()
    expect(s.calls.some(c => c.q.includes('CREATE (m:ReportMessage'))).toBe(false)
  })

  it('continuing your own conversation reuses it', async () => {
    const s = fakeSession(() => [{ id: 'c1' }])
    await expect(ensureConversation(s as never, 't1', 'u1', 'c1', 'q')).resolves.toEqual({ conversationId: 'c1', created: false })
  })
})
