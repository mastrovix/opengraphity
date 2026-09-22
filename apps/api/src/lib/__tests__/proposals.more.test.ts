/**
 * The proposal store beyond the four admission gates (those live in
 * proposalsStore.test.ts): reading, deciding, the rejection tombstone and the
 * nightly lifecycle sweeps.
 *
 * Why these behaviours matter for a user:
 *  - every read and write is keyed by tenant: the proposals page of one
 *    customer must never show, count or decide another customer's proposals;
 *  - a row with unreadable JSON must still appear on the page (with empty
 *    params) and be logged — not vanish, and not break the whole list;
 *  - the list filters only on what was asked, and paginates with integer
 *    SKIP/LIMIT (a float SKIP makes Neo4j reject the query and the page is empty);
 *  - the header counters ignore statuses the product does not know, so a
 *    stray value in the graph cannot add a bogus tab;
 *  - deciding stores the undo state and the opened Problem as JSON, so undo
 *    survives a restart between accept and "take it back";
 *  - expiry frees the slot after PROPOSAL_EXPIRY_DAYS: without it five ignored
 *    proposals would silently stop the product from proposing anything;
 *  - "not now" proposals come back open when their date arrives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PROPOSAL_EXPIRY_DAYS } from '@opengraphity/types'

const fake = vi.hoisted(() => ({
  queries: [] as Array<{ q: string; p: Record<string, unknown> }>,
  one:  null as ((q: string) => unknown) | null,
  many: (() => []) as (q: string, p: Record<string, unknown>) => unknown[],
  closed: 0,
  writes: [] as Array<{ q: string; p: Record<string, unknown> }>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    close: async () => { fake.closed += 1 },
    executeWrite: async <T>(fn: (tx: { run: (q: string, p: Record<string, unknown>) => Promise<void> }) => Promise<T>) =>
      fn({ run: async (q, p) => { fake.writes.push({ q, p }) } }),
  }),
}))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  runQueryOne: async (_s: unknown, q: string, p: Record<string, unknown>) => {
    fake.queries.push({ q, p })
    return fake.one ? fake.one(q) : null
  },
  runQuery: async (_s: unknown, q: string, p: Record<string, unknown>) => {
    fake.queries.push({ q, p })
    return fake.many(q, p)
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { logger } = await import('../logger.js')
const {
  scriviProposta, elencaProposte, proposta, conteggiProposte, segnaDecisa,
  scriviLapide, scadiLeVecchie, risvegliaLeRimandate,
} = await import('../proposals.js')

/** A row exactly as the Cypher RETURN hands it back. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1', tenantId: 't1', area: 'configuration', kind: 'proposal.x',
    params: JSON.stringify({ step: 'Approve' }), fingerprint: 'configuration:proposal.x:s',
    evidence: JSON.stringify({ n: 8, windowDays: 30, refs: ['INC1'] }),
    evidenceGrade: 3, occurrences: 8, windowDays: 30,
    action: JSON.stringify({ type: 'workflow.remove_step', params: { step: 'Approve' } }),
    rationale: null, rationaleLanguage: null, status: 'open', createdAt: '2026-09-01T00:00:00.000Z',
    decidedAt: null, decidedBy: null, rejectedKind: null, rejectedNote: null, notNowUntil: null,
    auditEntryId: null, executionError: null, undoState: null, undone: false, openedProblem: null,
    ...over,
  }
}

const NOW = new Date('2026-09-22T10:00:00.000Z')

beforeEach(() => {
  fake.queries = []; fake.one = null; fake.many = () => []; fake.closed = 0; fake.writes = []
  vi.clearAllMocks()
})

describe('row mapping', () => {
  it('parses JSON columns and keeps nulls as nulls', async () => {
    fake.many = () => [row()]
    const p = await proposta('t1', 'p1')
    expect(p).toMatchObject({
      params: { step: 'Approve' },
      evidence: { n: 8, windowDays: 30, refs: ['INC1'] },
      action: { type: 'workflow.remove_step', params: { step: 'Approve' } },
      rationale: null, decidedAt: null, undoState: null, openedProblem: null, undone: false,
    })
  })

  it('stringifies populated decision columns and reads openedProblem and undoState back', async () => {
    fake.many = () => [row({
      rationale: 'why', rationaleLanguage: 'en', status: 'accepted',
      decidedAt: '2026-09-02', decidedBy: 'u1', rejectedKind: 'wrong_analysis', rejectedNote: 'n',
      notNowUntil: '2026-10-01', auditEntryId: 'a1', executionError: 'boom',
      undoState: JSON.stringify({ before: 1 }), openedProblem: JSON.stringify({ id: 'pr1', number: 'PRB1' }), undone: true,
    })]
    const p = await proposta('t1', 'p1')
    expect(p).toMatchObject({
      rationale: 'why', rationaleLanguage: 'en', decidedAt: '2026-09-02', decidedBy: 'u1',
      rejectedKind: 'wrong_analysis', rejectedNote: 'n', notNowUntil: '2026-10-01', auditEntryId: 'a1',
      executionError: 'boom', undoState: { before: 1 }, openedProblem: { id: 'pr1', number: 'PRB1' }, undone: true,
    })
  })

  it('unreadable JSON keeps the row on the page with empty values, and is logged', async () => {
    fake.many = () => [row({
      params: '{broken', evidence: 'nope', action: '', evidenceGrade: null, occurrences: undefined, windowDays: null,
      undone: 'true',
    })]
    const p = await proposta('t1', 'p1')
    expect(p).not.toBeNull()
    expect(p!.params).toEqual({})
    expect(p!.evidence).toEqual({ n: 0, windowDays: 0, refs: [] })
    // Empty string is "no action", not an error: nothing to log for it.
    expect(p!.action).toBeNull()
    expect(p!.evidenceGrade).toBe(0)
    expect(p!.occurrences).toBe(0)
    expect(p!.windowDays).toBe(0)
    // Only a real boolean means undone: a string "true" must not block an undo.
    expect(p!.undone).toBe(false)
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(2)
  })
})

describe('proposta', () => {
  it('is scoped by tenant and id, and returns null when not found', async () => {
    expect(await proposta('t1', 'missing')).toBeNull()
    expect(fake.queries[0]?.p).toEqual({ tenantId: 't1', id: 'missing' })
    expect(fake.queries[0]?.q).toContain('tenant_id: $tenantId')
    expect(fake.closed).toBe(1)
  })
})

describe('scriviProposta: the CREATE contract', () => {
  it('a CREATE that returns nothing is an error naming the fingerprint, and the session closes', async () => {
    fake.one = (q) => (q.includes('AS aperte') ? { aperte: 0, oggi: 0 } : null)
    fake.many = () => []
    await expect(scriviProposta({
      tenantId: 't1', area: 'configuration', kind: 'k', params: {}, scope: 's',
      evidence: { n: 1, windowDays: 0, refs: [] }, action: null,
    }, undefined, NOW)).rejects.toThrow('proposals: CREATE returned no row for configuration:k:s')
    expect(fake.closed).toBe(1)
  })

  it('a read-only proposal stores a null action, null rationale, and counts "today" from UTC midnight', async () => {
    fake.one = (q) => (q.includes('AS aperte') ? { aperte: 0, oggi: 0 } : null)
    fake.many = (_q, p) => [row({ action: p['action'], tenantId: p['tenantId'] })]
    const out = await scriviProposta({
      tenantId: 't1', area: 'configuration', kind: 'k', params: {}, scope: 's',
      evidence: { n: 1, windowDays: 0, refs: [] }, action: null,
    }, undefined, NOW)
    expect(out.scritta).toBe(true)
    const create = fake.queries.find((x) => x.q.includes('CREATE'))!
    expect(create.p).toMatchObject({ action: null, rationale: null, rationaleLanguage: null, now: NOW.toISOString() })
    const counts = fake.queries.find((x) => x.q.includes('AS aperte'))!
    expect(counts.p['daMezzanotte']).toBe('2026-09-22T00:00:00.000Z')
  })

  it('missing counters and a tombstone without a grade are treated as zero', async () => {
    // Tombstone far in the past with no grade: the proposal may come back.
    fake.one = (q) => (q.includes(':ProposalRejection') ? { grade: null, at: '2020-01-01T00:00:00.000Z' } : null)
    fake.many = () => [row()]
    const out = await scriviProposta({
      tenantId: 't1', area: 'configuration', kind: 'k', params: {}, scope: 's',
      evidence: { n: 64, windowDays: 30, refs: [] }, action: null, rationale: 'r', rationaleLanguage: 'it',
    }, { maxOpen: 1, maxPerDay: 1 }, NOW)
    expect(out.scritta).toBe(true)
    expect(fake.queries.find((x) => x.q.includes('CREATE'))!.p).toMatchObject({ rationale: 'r', rationaleLanguage: 'it' })
  })
})

describe('elencaProposte', () => {
  it('without filters only the tenant clause applies, and the total comes from the count', async () => {
    fake.one = () => ({ n: 7 })
    fake.many = () => [row(), row({ id: 'p2' })]
    const out = await elencaProposte('t1', { limit: 20, offset: 0 })
    expect(out.total).toBe(7)
    expect(out.items.map((i) => i.id)).toEqual(['p1', 'p2'])
    const [count, list] = fake.queries
    expect(count?.q).toContain('WHERE p.tenant_id = $tenantId RETURN')
    expect(count?.q).not.toContain('$status')
    expect(list?.q).toContain('SKIP toInteger($offset) LIMIT toInteger($limit)')
    expect(list?.p).toMatchObject({ tenantId: 't1', status: [], area: [], limit: 20, offset: 0 })
    expect(fake.closed).toBe(1)
  })

  it('status and area filters are added only when non-empty', async () => {
    await elencaProposte('t1', { status: ['open', 'not_now'], area: ['configuration'], limit: 5, offset: 10 })
    const list = fake.queries[1]!
    expect(list.q).toContain('p.status IN $status')
    expect(list.q).toContain('p.area IN $area')
    expect(list.p).toMatchObject({ status: ['open', 'not_now'], area: ['configuration'] })

    fake.queries = []
    await elencaProposte('t1', { status: [], area: [], limit: 5, offset: 0 })
    // An empty list means "no filter", not "match nothing".
    expect(fake.queries[1]!.q).not.toContain('IN $status')
    expect(fake.queries[1]!.q).not.toContain('IN $area')
  })

  it('a missing count reads as zero', async () => {
    fake.one = () => null
    expect((await elencaProposte('t1', { limit: 1, offset: 0 })).total).toBe(0)
  })
})

describe('conteggiProposte', () => {
  it('returns every known status, zero when absent, and ignores unknown statuses', async () => {
    fake.many = () => [{ status: 'open', n: 3 }, { status: 'rejected', n: 1 }, { status: 'weird', n: 99 }]
    const out = await conteggiProposte('t1')
    expect(out).toEqual({ open: 3, accepted: 0, rejected: 1, not_now: 0, expired: 0, superseded: 0 })
    expect(fake.queries[0]?.p).toEqual({ tenantId: 't1' })
  })
})

describe('segnaDecisa', () => {
  it('stores undo state and opened Problem as JSON and defaults the optional fields', async () => {
    fake.many = (_q, p) => [row({
      tenantId: p['tenantId'], status: p['status'], decidedBy: p['decidedBy'], decidedAt: p['now'],
      undoState: p['undoState'], openedProblem: p['openedProblem'],
    })]
    const out = await segnaDecisa('t1', 'p1', {
      status: 'accepted', decidedBy: 'u1',
      undoState: { previous: ['a'] }, openedProblem: { id: 'pr1', number: 'PRB0001' },
    }, NOW)
    const p = fake.queries[0]!.p
    expect(p).toMatchObject({
      tenantId: 't1', id: 'p1', status: 'accepted', decidedBy: 'u1', now: NOW.toISOString(),
      rejectedKind: null, rejectedNote: null, notNowUntil: null, auditEntryId: null, executionError: null, undone: false,
    })
    expect(JSON.parse(String(p['undoState']))).toEqual({ previous: ['a'] })
    // Round trip: what was saved to undo is exactly what comes back.
    expect(out?.undoState).toEqual({ previous: ['a'] })
    expect(out?.openedProblem).toEqual({ id: 'pr1', number: 'PRB0001' })
  })

  it('passes explicit rejection fields and null JSON when absent; unknown id returns null', async () => {
    const out = await segnaDecisa('t1', 'nope', {
      status: 'rejected', decidedBy: 'u1', rejectedKind: 'wrong_analysis', rejectedNote: 'no',
      notNowUntil: '2026-10-01', auditEntryId: 'a1', executionError: 'e', undone: true,
    })
    expect(out).toBeNull()
    expect(fake.queries[0]!.p).toMatchObject({
      rejectedKind: 'wrong_analysis', rejectedNote: 'no', notNowUntil: '2026-10-01', auditEntryId: 'a1',
      executionError: 'e', undone: true, undoState: null, openedProblem: null,
    })
    expect(fake.closed).toBe(1)
  })
})

describe('scriviLapide', () => {
  it('MERGEs the tombstone per tenant and fingerprint with grade and date', async () => {
    await scriviLapide('t1', 'configuration:k:s', { kind: 'wrong_analysis', grade: 4 }, NOW)
    expect(fake.writes).toHaveLength(1)
    expect(fake.writes[0]!.q).toContain('MERGE (r:ProposalRejection {tenant_id: $tenantId, fingerprint: $fingerprint})')
    expect(fake.writes[0]!.p).toEqual({ tenantId: 't1', fingerprint: 'configuration:k:s', kind: 'wrong_analysis', grade: 4, now: NOW.toISOString() })
    expect(fake.closed).toBe(1)
  })
})

describe('lifecycle sweeps', () => {
  it('expiry cuts at exactly PROPOSAL_EXPIRY_DAYS and returns how many expired', async () => {
    fake.many = () => [{ n: 4 }]
    expect(await scadiLeVecchie(NOW)).toBe(4)
    const p = fake.queries[0]!.p
    expect(p['limite']).toBe(new Date(NOW.getTime() - PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString())
    expect(p['now']).toBe(NOW.toISOString())
    // Expiring is not rejecting: no tombstone is written.
    expect(fake.writes).toEqual([])
  })

  it('expiry with no result reads as zero', async () => {
    expect(await scadiLeVecchie(NOW)).toBe(0)
  })

  it('waking "not now" proposals returns the count, zero when none', async () => {
    fake.many = () => [{ n: 2 }]
    expect(await risvegliaLeRimandate(NOW)).toBe(2)
    expect(fake.queries[0]!.p).toEqual({ now: NOW.toISOString() })
    fake.many = () => []
    expect(await risvegliaLeRimandate()).toBe(0)
    expect(fake.closed).toBe(2)
  })
})
