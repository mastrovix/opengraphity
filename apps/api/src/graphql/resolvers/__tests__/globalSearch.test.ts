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

type QueryParams = { tenantId: string; lucene: string; fetchLimit: number }
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
    vi.mocked(runQuery).mockResolvedValue([
      { props: { id: 'inc-1', number: 'INC0001', title: 'Server down', status: 'open' }, labels: ['Incident'] },
      { props: { id: 'ci-1', name: 'web-01', status: 'active' }, labels: ['Server'] },
      { props: { id: 'kb-1', title: 'Reboot guide', status: 'published', slug: 'reboot-guide' }, labels: ['KBArticle'] },
    ] as never)

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

  it('clampa limitPerType: max 20, min 1, default 5 (fetchLimit = x12)', async () => {
    await globalSearch(null, { query: 'serv', limitPerType: 999 }, ctx)
    expect(paramsOfCall(0).fetchLimit).toBe(20 * 12)

    vi.clearAllMocks(); vi.mocked(runQuery).mockResolvedValue([])
    await globalSearch(null, { query: 'serv', limitPerType: 0 }, ctx)
    expect(paramsOfCall(0).fetchLimit).toBe(1 * 12)

    vi.clearAllMocks(); vi.mocked(runQuery).mockResolvedValue([])
    await globalSearch(null, { query: 'serv' }, ctx)
    expect(paramsOfCall(0).fetchLimit).toBe(5 * 12)
  })

  it('cappa i risultati per tipo a limitPerType', async () => {
    vi.mocked(runQuery).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        props: { id: `inc-${i}`, number: `INC${i}`, title: `Incident ${i}`, status: 'open' },
        labels: ['Incident'],
      })) as never,
    )
    const hits = await globalSearch(null, { query: 'inc', limitPerType: 3 }, ctx)
    expect(hits).toHaveLength(3)
  })

  it('usa la fulltext index con tenantId e query Lucene escapata a prefissi', async () => {
    await globalSearch(null, { query: '  SERV down  ' }, ctx)

    const calls = vi.mocked(runQuery).mock.calls
    expect(calls).toHaveLength(1)
    const cypher = calls[0]![1] as string
    expect(cypher).toContain("db.index.fulltext.queryNodes('global_search'")
    expect(paramsOfCall(0).tenantId).toBe('tenant-1')
    expect(paramsOfCall(0).lucene).toBe('SERV* AND down*')
  })

  it('escapa i caratteri speciali Lucene', async () => {
    await globalSearch(null, { query: 'a+b (test)' }, ctx)
    expect(paramsOfCall(0).lucene).toBe('a\\+b* AND \\(test\\)*')
  })
})
