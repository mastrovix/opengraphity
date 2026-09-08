import { describe, it, expect, vi } from 'vitest'
import { loadRecentHistory, runReportConversation, saveMessage, HISTORY_LIMIT } from '../reportConversation.js'

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
    const history = await loadRecentHistory(s as never, 't1', 'c1', 'msg-new')

    expect(history.map(m => m.content)).toEqual(['u2', 'a2', 'u3', 'a3'])
    const { q, p } = s.calls[0]!
    expect(q).toContain('ReportConversation {id: $convId, tenant_id: $tenantId}')
    expect(q).toContain('WHERE m.id <> $excludeId')
    expect(q).toContain('ORDER BY m.created_at DESC')
    expect(q).toContain('LIMIT toInteger($limit)')
    expect(p).toEqual({ convId: 'c1', tenantId: 't1', excludeId: 'msg-new', limit: HISTORY_LIMIT })
  })
})

describe('saveMessage', () => {
  it('throws when the conversation is not in the tenant (no silent "saved" of a dangling message)', async () => {
    const s = fakeSession(() => [])
    await expect(saveMessage(s as never, 't1', 'ghost', 'user', 'ciao')).rejects.toThrow('ReportConversation ghost not found')
  })

  it('creates the message and bumps the conversation in the same statement', async () => {
    const s = fakeSession(() => [{ id: 'x' }])
    const m = await saveMessage(s as never, 't1', 'c1', 'assistant', 'risposta')
    expect(m).toMatchObject({ role: 'assistant', content: 'risposta' })
    expect(s.calls[0]!.q).toContain('SET c.updated_at = $now')
    expect(s.calls[0]!.p).toMatchObject({ convId: 'c1', tenantId: 't1', role: 'assistant', content: 'risposta', id: m.id })
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
      session: s as never, tenantId: 't1', question: 'quanti incidenti?', conversationId: null,
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
    const s = fakeSession((q) => (q.includes('CREATE (m:ReportMessage') ? [{ id: 'x' }] : []))
    const onCreated = vi.fn()
    const out = await runReportConversation({
      session: s as never, tenantId: 't1', question: 'q', conversationId: 'c-existing',
      ask: async () => 'r', onConversationCreated: onCreated,
    })
    expect(out.conversationId).toBe('c-existing')
    expect(onCreated).not.toHaveBeenCalled()
    expect(s.calls.some(c => c.q.includes('CREATE (:ReportConversation'))).toBe(false)
  })

  it('a failing ask propagates: no assistant message is saved', async () => {
    const s = fakeSession((q) => (q.includes('CREATE (m:ReportMessage') ? [{ id: 'x' }] : []))
    await expect(runReportConversation({
      session: s as never, tenantId: 't1', question: 'q', conversationId: 'c1',
      ask: async () => { throw new Error('overloaded') },
    })).rejects.toThrow('overloaded')
    expect(s.calls.filter(c => c.p['role'] === 'assistant')).toHaveLength(0)
  })
})
