/**
 * ticketImportService — the row-level validation and failure paths that
 * ticketImportService.test.ts does not exercise.
 *
 * Why these matter for someone migrating from another ITSM tool:
 *  - every bad row must be reported with its row number, external id and a
 *    message key (the web composes the sentence in the importer's language),
 *    and must NOT stop the valid rows around it;
 *  - a tenant without a usable workflow is refused up front, before a single
 *    row is written, instead of leaving tickets without a workflow instance;
 *  - a write that fails for one row is attributed to that row only (one
 *    transaction per row), the other rows still land;
 *  - a dry run counts creates and updates exactly like the real run would;
 *  - comments are the only record of the old conversation: a malformed one is
 *    an error, never a silently dropped or silently internal reply.
 * The graph, the workflow engine and the numbering are doubles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const runs: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const state = { failWriteFor: null as string | null, failWith: null as unknown, counter: 0 }
  const tx = {
    run: async (cypher: string, params: Record<string, unknown> = {}) => {
      runs.push({ cypher, params })
      if (state.failWriteFor && cypher.includes('MERGE (') && params['externalId'] === state.failWriteFor) throw state.failWith
      // The step of the CSV belongs to the ticket's workflow (review of 23 Sep 2026).
      if (cypher.includes('AS known, coalesce(target.is_terminal')) return { records: [{ get: (k: string) => ({ known: true, terminal: false } as Record<string, unknown>)[k] }] }
      if (cypher.includes('MERGE (c:Counter') && cypher.includes('RETURN c.value')) {
        state.counter += 1
        const v = state.counter
        return { records: [{ get: () => v }] }
      }
      return { records: [] }
    },
  }
  const session = {
    executeRead: async () => ({ records: [] }),
    executeWrite: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
  }
  return { runs, state, tx, session }
})

vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { createInstance: vi.fn(async () => ({ id: 'wi-1' })) } }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v),
}))
vi.mock('../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn(), getInitialStepName: vi.fn() }))
vi.mock('../../lib/db.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn(h.session)),
  getSession: vi.fn(),
}))
vi.mock('../../lib/ticketCustomFields.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  customFieldDefs: vi.fn(async () => []),
}))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const svc = await import('../ticketImportService.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
const { withSession } = await import('../../lib/db.js')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }
const STEPS = [
  { name: 'new', isInitial: true, isTerminal: false, isOpen: true, category: null },
  { name: 'resolved', isInitial: false, isTerminal: true, isOpen: false, category: 'resolved' },
]
const KB_STEPS = [
  { name: 'draft', isInitial: true, isTerminal: false, isOpen: true, category: null },
  { name: 'Published', isInitial: false, isTerminal: true, isOpen: false, category: null },
]

function reads(opts: { users?: Array<{ email: string; id: string }>; existing?: Array<{ id: string; externalId: string; number?: string | null }>; kbExisting?: Array<{ id: string; externalId: string }> } = {}) {
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, q: string) => {
    if (q.includes('MATCH (u:User')) return (opts.users ?? []) as never
    if (q.includes('n.import_external_id IN')) return (opts.existing ?? []) as never
    if (q.includes('a.import_external_id IN')) return (opts.kbExisting ?? []) as never
    return [] as never
  })
  vi.mocked(runQueryOne).mockResolvedValue({ maxNum: 0 } as never)
}

const keys = (issues: Array<{ row: number; messageKey: string }>) => issues.map((i) => [i.row, i.messageKey])
const merges = (label: string) => h.runs.filter((r) => r.cypher.includes(`MERGE (${label}`))

beforeEach(() => {
  vi.clearAllMocks()
  h.runs.length = 0
  h.state.failWriteFor = null
  h.state.counter = 0
  vi.mocked(getWorkflowSteps).mockImplementation(async (_s: unknown, _t: string, kind: string) => (kind === 'kb_article' ? KB_STEPS : STEPS) as never)
  reads()
})

describe('importTickets — guards before any read', () => {
  it('a missing tenant or a non-array body is refused; an empty file does nothing at all', async () => {
    await expect(svc.importIncidents([], { tenantId: '', userId: 'u' })).rejects.toThrow(/tenantId is required/)
    await expect(svc.importIncidents('x' as never, ctx)).rejects.toThrow(/rows must be an array/)
    expect(await svc.importIncidents([], ctx)).toEqual({ totalRows: 0, created: 0, updated: 0, errors: [], warnings: [] })
    expect(withSession).not.toHaveBeenCalled()
  })

  it('a tenant without a workflow, or without an initial step, is refused before writing', async () => {
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([])
    await expect(svc.importProblems([{ external_id: 'P', title: 'T', priority: 'high' }], ctx)).rejects.toThrow(/No active workflow definition for "problem"/)
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([{ ...STEPS[1]! }] as never)
    await expect(svc.importProblems([{ external_id: 'P', title: 'T', priority: 'high' }], ctx)).rejects.toThrow(/has no initial step/)
    expect(h.session.executeWrite).not.toHaveBeenCalled()
  })
})

describe('importTickets — row validation', () => {
  it('title too long, impossible date and a number repeated in the file are row errors', async () => {
    const r = await svc.importIncidents([
      { external_id: 'A', title: 'x'.repeat(501), severity: 'P1' },
      { external_id: 'B', title: 'T', severity: 'P1', created_at: '2024-13-45' },
      { external_id: 'C', title: 'T', severity: 'P1', number: 'INC00000100' },
      { external_id: 'D', title: 'T', severity: 'P1', number: 'INC00000100' },
    ], ctx)
    expect(keys(r.errors)).toEqual([[1, 'titleTooLong'], [2, 'invalidDate'], [4, 'numberDuplicate']])
    expect(r.errors[0]!.message).toBe('title is longer than 500 characters')
    expect(r.errors[2]).toMatchObject({ externalId: 'D', message: 'number duplicated in the file: "INC00000100"' })
    expect(r.created).toBe(1)
  })

  it('comments: each malformed shape is its own error; unknown authors warn; `internal: false` stays public', async () => {
    reads({ users: [{ email: 'anna@acme.it', id: 'u-anna' }] })
    const r = await svc.importIncidents([
      { external_id: 'A', title: 'T', severity: 'P1', comments: '{"text":"x"}' },
      { external_id: 'B', title: 'T', severity: 'P1', comments: '[{"text":"  "}]' },
      { external_id: 'C', title: 'T', severity: 'P1', comments: '[{"text":"ok","created_at":"yesterday"}]' },
      { external_id: 'D', title: 'T', severity: 'P1', comments: '[{"text":"ok","internal":"no"}]' },
      { external_id: 'E', title: 'T', severity: 'P1', comments: JSON.stringify([
        null,
      ]) },
      { external_id: 'F', title: 'T', severity: 'P1', comments: JSON.stringify([
        { text: 'Reply to the customer', author_email: 'Anna@acme.it', internal: false, created_at: '2024-01-02T10:00:00Z' },
        { text: 'Note', author_email: 'ghost@acme.it' },
      ]) },
    ], ctx)
    expect(keys(r.errors)).toEqual([[1, 'commentsNotArray'], [2, 'commentTextRequired'], [3, 'commentInvalidDate'], [4, 'commentInternalNotBoolean'], [5, 'commentTextRequired']])
    expect(r.warnings).toEqual([expect.objectContaining({ row: 6, messageKey: 'commentAuthorNotFound', message: 'comments[1]: author_email "ghost@acme.it" not found' })])
    const written = h.runs.find((x) => x.cypher.includes('UNWIND $comments'))!.params['comments'] as Array<Record<string, unknown>>
    expect(written).toEqual([
      { text: 'Reply to the customer', authorEmail: 'Anna@acme.it', authorId: 'u-anna', createdAt: '2024-01-02T10:00:00.000Z', isInternal: false },
      expect.objectContaining({ text: 'Note', authorId: null, isInternal: true }),
    ])
  })

  it('an optional vocabulary column present but empty clears the value instead of being skipped', async () => {
    const r = await svc.importProblems([{ external_id: 'P', title: 'T', priority: 'high', impact: '' }], ctx)
    expect(r.errors).toEqual([])
    expect(merges('n:Problem')[0]!.params['props']).toMatchObject({ priority: 'high', impact: null })
  })

  it('change risk score: an empty cell is null, an absent column is not written', async () => {
    await svc.importChanges([
      { external_id: 'C1', title: 'T', change_type: 'normal', aggregate_risk_score: '' },
    ], ctx)
    expect(merges('n:Change')[0]!.params['props']).toMatchObject({ aggregate_risk_score: null })
    h.runs.length = 0
    await svc.importChanges([{ external_id: 'C2', title: 'T', change_type: 'normal' }], ctx)
    expect(merges('n:Change')[0]!.params['props']).not.toHaveProperty('aggregate_risk_score')
  })
})

describe('importTickets — execution', () => {
  it('a write failing on one row is reported on that row; the other rows are still created', async () => {
    h.state.failWriteFor = 'B'
    h.state.failWith = new Error('constraint violated')
    const r = await svc.importIncidents([
      { external_id: 'A', title: 'T', severity: 'P1' },
      { external_id: 'B', title: 'T', severity: 'P1' },
      { external_id: 'C', title: 'T', severity: 'P1' },
    ], ctx)
    expect(r.created).toBe(2)
    expect(r.errors).toEqual([expect.objectContaining({ row: 2, externalId: 'B', messageKey: 'writeFailed', message: 'write failed: constraint violated' })])
  })

  it('a non-Error failure still yields a readable reason', async () => {
    h.state.failWriteFor = 'A'
    h.state.failWith = 'deadlock'
    const r = await svc.importIncidents([{ external_id: 'A', title: 'T', severity: 'P1' }], ctx)
    expect(r.errors[0]!.messageParams).toEqual({ error: 'deadlock' })
  })

  it('a dry run counts an existing ticket as an update, without writing', async () => {
    reads({ existing: [{ id: 'inc-9', externalId: 'A', number: 'INC00000009' }] })
    const r = await svc.importIncidents([{ external_id: 'A', title: 'T', severity: 'P1' }, { external_id: 'B', title: 'T', severity: 'P1' }], ctx, { dryRun: true })
    expect(r).toMatchObject({ created: 1, updated: 1 })
    expect(h.session.executeWrite).not.toHaveBeenCalled()
  })
})

describe('importKBArticles', () => {
  it('a missing tenant or non-array body is refused; an empty file does nothing', async () => {
    await expect(svc.importKBArticles([], { tenantId: '', userId: 'u' })).rejects.toThrow(/tenantId is required/)
    await expect(svc.importKBArticles({} as never, ctx)).rejects.toThrow(/rows must be an array/)
    expect(await svc.importKBArticles([], ctx)).toMatchObject({ totalRows: 0, created: 0 })
  })

  it('row errors: duplicate id, no title, body too long, invalid date', async () => {
    const r = await svc.importKBArticles([
      { external_id: 'K', title: 'A' },
      { external_id: 'K', title: 'B' },
      { external_id: 'L', title: ' ' },
      { external_id: 'M', title: 'C', body: 'x'.repeat(50_001) },
      { external_id: 'N', title: 'D', created_at: 'not-a-date' },
      { external_id: 'O', title: 'E', published_at: '2024-99-01' },
    ], ctx)
    expect(keys(r.errors)).toEqual([[2, 'externalIdDuplicate'], [3, 'titleRequired'], [4, 'bodyTooLong'], [5, 'invalidDate'], [6, 'invalidDate']])
    expect(r.errors[2]!.message).toBe('body is longer than 50000 characters')
    expect(r.created).toBe(1)
  })

  it('without a published-category step the step NAMED "published" is used (any case)', async () => {
    await svc.importKBArticles([{ external_id: 'K', title: 'VPN', status: 'published' }], ctx)
    expect(merges('a:KBArticle')[0]!.params['status']).toBe('Published')
  })

  it('a workflow with no published step keeps the article in the initial step and says so', async () => {
    vi.mocked(getWorkflowSteps).mockResolvedValue([KB_STEPS[0]!] as never)
    const r = await svc.importKBArticles([{ external_id: 'K', title: 'VPN', status: 'published' }], ctx)
    expect(r.warnings).toEqual([expect.objectContaining({ messageKey: 'kbNoPublishedStep', messageParams: { step: 'draft' } })])
    expect(merges('a:KBArticle')[0]!.params).toMatchObject({ status: 'draft', publishedAt: expect.any(String) as unknown as string })
  })

  it('an unreadable kb workflow imports with the raw status, no instance, and a warning per row', async () => {
    vi.mocked(getWorkflowSteps).mockRejectedValue(new Error('no definition'))
    const r = await svc.importKBArticles([{ external_id: 'K', title: 'Guide', status: 'published' }], ctx)
    expect(r.created).toBe(1)
    expect(r.warnings.map((w) => w.messageKey)).toEqual(['kbNoWorkflow'])
    expect(merges('a:KBArticle')[0]!.params['status']).toBe('published')
    expect(h.runs.some((x) => x.cypher.includes('HAS_WORKFLOW'))).toBe(false)
  })

  it('dry run counts updates; a failed write is attributed to its row', async () => {
    reads({ kbExisting: [{ id: 'kb-1', externalId: 'K' }] })
    const dry = await svc.importKBArticles([{ external_id: 'K', title: 'A' }], ctx, { dryRun: true })
    expect(dry).toMatchObject({ created: 0, updated: 1 })

    h.state.failWriteFor = 'K'
    h.state.failWith = new Error('boom')
    const r = await svc.importKBArticles([{ external_id: 'K', title: 'A' }, { external_id: 'L', title: 'B' }], ctx)
    expect(r).toMatchObject({ created: 1, updated: 0 })
    expect(r.errors).toEqual([expect.objectContaining({ row: 1, messageKey: 'writeFailed', message: 'write failed: boom' })])
    h.state.failWith = 42
    const r2 = await svc.importKBArticles([{ external_id: 'K', title: 'A' }], ctx)
    expect(r2.errors[0]!.messageParams).toEqual({ error: '42' })
  })
})
