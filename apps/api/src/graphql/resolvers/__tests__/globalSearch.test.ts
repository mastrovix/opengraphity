import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  runQuery:         vi.fn().mockResolvedValue([]),
  ciTypeFromLabels: vi.fn(() => 'server'),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { globalSearchResolvers } = await import('../globalSearch.js')
const { withSession, runQuery } = await import('../ci-utils.js')

const globalSearch = globalSearchResolvers.Query.globalSearch

// ── Test context ──────────────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@test.io', role: 'operator' }

type QueryParams = { tenantId: string; q: string; limit: number }
const paramsOfCall = (i: number) => vi.mocked(runQuery).mock.calls[i]![2] as QueryParams

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('globalSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([])
  })

  it('query sotto i 2 caratteri (dopo trim) → [] senza toccare la sessione', async () => {
    const result = await globalSearch(null, { query: '  a  ' }, ctx)

    expect(result).toEqual([])
    expect(withSession).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('mappa i risultati in SearchHit con entityType/id/title corretti', async () => {
    vi.mocked(runQuery).mockImplementation(async (_session, cypher) => {
      if (cypher.includes('(n:Incident'))  return [{ props: { id: 'inc-1', number: 'INC0001', title: 'Server down', status: 'open' } }] as never
      if (cypher.includes('n:Application')) return [{ props: { id: 'ci-1', name: 'web-01', status: 'active' }, labels: ['Server'] }] as never
      if (cypher.includes('(n:KBArticle'))  return [{ props: { id: 'kb-1', title: 'Reboot guide', status: 'published', slug: 'reboot-guide' } }] as never
      return [] as never
    })

    const hits = await globalSearch(null, { query: 'serv' }, ctx)

    expect(hits).toHaveLength(3)
    expect(hits[0]).toEqual({
      entityType: 'incident',
      id:         'inc-1',
      number:     'INC0001',
      title:      'Server down',
      status:     'open',
      ciType:     null,
      slug:       null,
    })
    expect(hits[1]).toEqual({
      entityType: 'ci',
      id:         'ci-1',
      number:     null,
      title:      'web-01',
      status:     'active',
      ciType:     'server',
      slug:       null,
    })
    expect(hits[2]).toEqual({
      entityType: 'kb_article',
      id:         'kb-1',
      number:     null,
      title:      'Reboot guide',
      status:     'published',
      ciType:     null,
      slug:       'reboot-guide',
    })
  })

  it('clampa limitPerType al massimo di 20', async () => {
    await globalSearch(null, { query: 'serv', limitPerType: 999 }, ctx)

    const calls = vi.mocked(runQuery).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (let i = 0; i < calls.length; i++) {
      expect(paramsOfCall(i).limit).toBe(20)
    }
  })

  it('clampa limitPerType al minimo di 1 (default 5)', async () => {
    await globalSearch(null, { query: 'serv', limitPerType: 0 }, ctx)
    expect(paramsOfCall(0).limit).toBe(1)

    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([])

    await globalSearch(null, { query: 'serv' }, ctx)
    expect(paramsOfCall(0).limit).toBe(5)
  })

  it('ogni chiamata a runQuery riceve il tenantId del contesto e la query lowercase', async () => {
    await globalSearch(null, { query: '  SERV  ' }, ctx)

    const calls = vi.mocked(runQuery).mock.calls
    // 4 entity ITSM + CI + KB article
    expect(calls).toHaveLength(6)
    for (let i = 0; i < calls.length; i++) {
      expect(paramsOfCall(i).tenantId).toBe('tenant-1')
      expect(paramsOfCall(i).q).toBe('serv')
    }
  })
})
