import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────
// ci-utils viene mockato solo per withSession/runQuery/ciTypeFromLabels:
// mapCI resta quello reale, così i test verificano il riuso dei mapper veri.

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return {
    ...actual,
    withSession: vi.fn().mockImplementation(
      async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
    ),
    runQuery:         vi.fn().mockResolvedValue([]),
    ciTypeFromLabels: vi.fn(() => 'server'),
  }
})

// ── Import after mocks ────────────────────────────────────────────────────────

const { globalSearchResolvers } = await import('../globalSearch.js')
const { withSession, runQuery } = await import('../ci-utils.js')

const globalSearch = globalSearchResolvers.Query.globalSearch

// ── Test context ──────────────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@test.io', role: 'operator' }

const EMPTY_RESULTS = { cis: [], changes: [], incidents: [], problems: [], tasks: [], kbArticles: [] }

type Row = Record<string, unknown>

interface Primed { fulltext?: Row[]; ciById?: Row[]; tasks?: Row[]; kb?: Row[] }

/** Instrada il mock di runQuery sulle 4 query del resolver (dispatch sul cypher). */
function primeQueries({ fulltext = [], ciById = [], tasks = [], kb = [] }: Primed) {
  vi.mocked(runQuery).mockImplementation(async (_s, cypher) => {
    if (cypher.includes('db.index.fulltext.queryNodes'))   return fulltext as never
    if (cypher.includes('STARTS WITH $q'))                 return ciById as never
    if (cypher.includes('HAS_ASSESSMENT|HAS_DEPLOY_PLAN')) return tasks as never
    if (cypher.includes(':KBArticle'))                     return kb as never
    return [] as never
  })
}

/** Params della prima chiamata il cui cypher contiene `snippet`. */
function paramsOf(snippet: string): Record<string, unknown> {
  const call = vi.mocked(runQuery).mock.calls.find(([, cypher]) => cypher.includes(snippet))
  expect(call, `nessuna query con "${snippet}"`).toBeDefined()
  return call![2] as Record<string, unknown>
}

const kbRow = (id: string, title: string): Row => ({
  id, title, slug: `${title.toLowerCase().replace(/\s+/g, '-')}-${id}`,
  body: 'body', category: 'howto', tags: '["a"]', status: 'published',
  authorId: 'u1', authorName: 'Author', views: 3, helpfulCount: 1, notHelpfulCount: 0,
  createdAt: '2026-01-01', updatedAt: '2026-01-02', publishedAt: null,
  workflowInstanceId: 'wi-1', currentStep: 'published',
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('globalSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([])
  })

  it('query sotto i 2 caratteri (dopo trim) → gruppi vuoti senza toccare la sessione', async () => {
    const result = await globalSearch(null, { query: '  a  ' }, ctx)

    expect(result).toEqual(EMPTY_RESULTS)
    expect(withSession).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('smista i risultati fulltext nei gruppi con i mapper delle entità complete', async () => {
    primeQueries({
      fulltext: [
        { props: { id: 'inc-1', number: 'INC0001', tenant_id: 'tenant-1', title: 'Server down', severity: 'high', status: 'open', created_at: 'c', updated_at: 'u' }, labels: ['Incident'] },
        { props: { id: 'chg-1', code: 'CHG00000001', tenant_id: 'tenant-1', title: 'Upgrade DB', created_at: 'c', updated_at: 'u' }, labels: ['Change'] },
        { props: { id: 'prb-1', number: 'PRB0001', title: 'Recurring crash', status: 'open', created_at: 'c' }, labels: ['Problem'] },
        { props: { id: 'ci-1', name: 'web-01', status: 'active', created_at: 'c' }, labels: ['Server'] },
        { props: { id: 'kb-1', title: 'Reboot guide' }, labels: ['KBArticle'] },
      ],
      kb: [kbRow('kb-1', 'Reboot guide')],
    })

    const res = await globalSearch(null, { query: 'serv' }, ctx)

    expect(res.incidents).toHaveLength(1)
    expect(res.incidents[0]).toMatchObject({ id: 'inc-1', number: 'INC0001', title: 'Server down', severity: 'high', status: 'open', assignee: null })
    expect(res.changes).toHaveLength(1)
    expect(res.changes[0]).toMatchObject({ id: 'chg-1', code: 'CHG00000001', title: 'Upgrade DB', requester: null })
    expect(res.problems).toHaveLength(1)
    expect(res.problems[0]).toMatchObject({ id: 'prb-1', number: 'PRB0001', title: 'Recurring crash', assignee: null })
    expect(res.cis).toHaveLength(1)
    expect(res.cis[0]).toMatchObject({ id: 'ci-1', name: 'web-01', type: 'server', status: 'active' })
    expect(res.kbArticles).toHaveLength(1)
    expect(res.kbArticles[0]).toMatchObject({ id: 'kb-1', title: 'Reboot guide', tags: ['a'], workflowInstanceId: 'wi-1', currentStep: 'published' })
    expect(res.tasks).toEqual([])
  })

  it('esclude i ServiceRequest dai gruppi', async () => {
    primeQueries({
      fulltext: [{ props: { id: 'sr-1', number: 'REQ0001', title: 'New laptop', status: 'open' }, labels: ['ServiceRequest'] }],
    })
    const res = await globalSearch(null, { query: 'laptop' }, ctx)
    expect(res).toEqual(EMPTY_RESULTS)
  })

  it('clampa limit: max 20, min 1, default 5 (fetchLimit = x12)', async () => {
    await globalSearch(null, { query: 'serv', limit: 999 }, ctx)
    expect(paramsOf('fulltext.queryNodes')['fetchLimit']).toBe(20 * 12)

    vi.clearAllMocks(); vi.mocked(runQuery).mockResolvedValue([])
    await globalSearch(null, { query: 'serv', limit: 0 }, ctx)
    expect(paramsOf('fulltext.queryNodes')['fetchLimit']).toBe(1 * 12)

    vi.clearAllMocks(); vi.mocked(runQuery).mockResolvedValue([])
    await globalSearch(null, { query: 'serv' }, ctx)
    expect(paramsOf('fulltext.queryNodes')['fetchLimit']).toBe(5 * 12)
  })

  it('cappa ogni gruppo a limit', async () => {
    primeQueries({
      fulltext: Array.from({ length: 10 }, (_, i) => ({
        props: { id: `inc-${i}`, number: `INC${i}`, title: `Incident ${i}`, severity: 'low', status: 'open', created_at: 'c', updated_at: 'u' },
        labels: ['Incident'],
      })),
    })
    const res = await globalSearch(null, { query: 'inc', limit: 3 }, ctx)
    expect(res.incidents).toHaveLength(3)
  })

  it('tutte le query sono tenant-scoped', async () => {
    primeQueries({ fulltext: [{ props: { id: 'kb-1', title: 'X' }, labels: ['KBArticle'] }], kb: [kbRow('kb-1', 'X')] })
    await globalSearch(null, { query: 'serv' }, ctx)

    const calls = vi.mocked(runQuery).mock.calls
    expect(calls.length).toBe(4) // fulltext + ci-by-id + tasks + kb
    for (const call of calls) {
      expect((call[2] as Record<string, unknown>)['tenantId']).toBe('tenant-1')
    }
  })

  it('usa la fulltext index con query Lucene tokenizzata a prefissi', async () => {
    await globalSearch(null, { query: '  SERV down  ' }, ctx)

    const call = vi.mocked(runQuery).mock.calls.find(([, c]) => c.includes('fulltext.queryNodes'))
    expect(call).toBeDefined()
    expect(call![1]).toContain("db.index.fulltext.queryNodes('global_search'")
    expect(paramsOf('fulltext.queryNodes')['lucene']).toBe('SERV* AND down*')
  })

  it('tokenizza sui confini non alfanumerici come lo standard analyzer', async () => {
    await globalSearch(null, { query: 'a+b (test)' }, ctx)
    expect(paramsOf('fulltext.queryNodes')['lucene']).toBe('a* AND b* AND test*')
  })

  it('mappa i task con taskType leggibile e riferimenti a change/CI', async () => {
    primeQueries({
      tasks: [
        { id: 't-1', code: 'TASK00000001', label: 'AssessmentTask', status: 'pending',   changeCode: 'CHG00000001', changeId: 'chg-1', ciName: 'web-01' },
        { id: 't-2', code: 'TASK00000002', label: 'DeployPlanTask', status: 'completed', changeCode: 'CHG00000001', changeId: 'chg-1', ciName: 'web-01' },
        { id: 't-3', code: 'TASK00000003', label: 'ValidationTest', status: 'pending',   changeCode: 'CHG00000002', changeId: 'chg-2', ciName: 'db-01' },
        { id: 't-4', code: 'TASK00000004', label: 'DeploymentTask', status: 'pending',   changeCode: 'CHG00000002', changeId: 'chg-2', ciName: 'db-01' },
        { id: 't-5', code: 'TASK00000005', label: 'ReviewTask',     status: 'pending',   changeCode: 'CHG00000002', changeId: 'chg-2', ciName: 'db-01' },
      ],
    })

    const res = await globalSearch(null, { query: 'TASK0000' }, ctx)

    expect(res.tasks.map((t) => t.taskType)).toEqual(['assessment', 'deploy-plan', 'validation', 'deployment', 'review'])
    expect(res.tasks[0]).toEqual({
      id: 't-1', code: 'TASK00000001', taskType: 'assessment', status: 'pending',
      changeCode: 'CHG00000001', changeId: 'chg-1', ciName: 'web-01',
    })
    expect(paramsOf('HAS_ASSESSMENT|HAS_DEPLOY_PLAN')['q']).toBe('TASK0000')
    expect(paramsOf('HAS_ASSESSMENT|HAS_DEPLOY_PLAN')['limit']).toBe(5)
  })

  it('unisce lookup CI per id (STARTS WITH) e fulltext senza duplicati, id prima', async () => {
    primeQueries({
      fulltext: [
        { props: { id: 'ci-dup', name: 'web-01', status: 'active', created_at: 'c' }, labels: ['Server'] },
        { props: { id: 'ci-txt', name: 'web-02', status: 'active', created_at: 'c' }, labels: ['Server'] },
      ],
      ciById: [
        { props: { id: 'ci-dup', name: 'web-01', status: 'active', created_at: 'c' }, labels: ['Server'] },
      ],
    })

    const res = await globalSearch(null, { query: 'ci-dup' }, ctx)

    expect(res.cis.map((c) => c.id)).toEqual(['ci-dup', 'ci-txt'])
    expect(paramsOf('STARTS WITH $q')['q']).toBe('ci-dup')
  })
})
