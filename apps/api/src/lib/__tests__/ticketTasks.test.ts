/**
 * Generic ticket tasks (lib/ticketTasks.ts): creation from a workflow step,
 * the "after" chain, the step guard's counter and the readers.
 *
 * Why these behaviours matter:
 *  - a task must hang only from a ticket of its own type, or "My tasks", the
 *    step guard and the reports read broken data; a mismatch must write
 *    nothing and fail loudly;
 *  - a team taken from a form field must never fall back silently to the fixed
 *    team (the work would land on people who do not know they have it);
 *  - re-entering a step must not burn a new TASK number (gaps in numbering);
 *  - a task that waits for another one starts as "waiting", not "open";
 *  - every query stays inside the tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TaskToCreate } from '@opengraphity/workflow'

const h = vi.hoisted(() => ({
  runQuery: vi.fn(),
  runQueryOne: vi.fn(),
  nextSequenceBlock: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  close: vi.fn(async () => undefined),
  getSession: vi.fn(),
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: (...a: unknown[]) => { h.getSession(...a); return { close: h.close } },
}))
// 'problem' is left out of the label map on purpose, to reach the guard that
// protects against a ticket type the engine does not know how to label.
vi.mock('@opengraphity/types', async (orig) => {
  const real = await orig<typeof import('@opengraphity/types')>()
  const labels = { ...real.ENTITY_NEO4J_LABELS } as Record<string, string>
  delete labels['problem']
  return { ...real, ENTITY_NEO4J_LABELS: labels }
})
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  runQuery: (...a: unknown[]) => h.runQuery(...a),
  runQueryOne: (...a: unknown[]) => h.runQueryOne(...a),
}))
vi.mock('../sequence.js', () => ({ nextSequenceBlock: (...a: unknown[]) => h.nextSequenceBlock(...a) }))
vi.mock('../ticketTeamHistory.js', () => ({ firstTeamCypher: () => '', TEAM_NOW_PARAM: '__teamNow' }))
vi.mock('../logger.js', () => ({ logger: { warn: h.warn, error: h.error, info: vi.fn() } }))

const {
  creaCompito, apriDipendenti, annullaCompitiDelTicketConcluso, compitiDaFareNelPasso, compitiDelTicket, compito,
  chiaveCompito, isOpenState, isPendingState, TASK_STATE,
} = await import('../ticketTasks.js')

const task = (over: Partial<TaskToCreate> = {}): TaskToCreate => ({
  tenantId: 't1', entityId: 'sr-1', entityType: 'service_request', stepName: 'fulfil', actionIndex: 0,
  title: 'Prepare laptop', description: null, teamId: 'team-desk', teamFromField: null,
  dueInDays: null, after: null, createdBy: 'workflow', ...over,
})

const createdRow = (over: Record<string, unknown> = {}) => ({ id: 'k1', teamId: 'team-desk', ...over })

/** Routes runQueryOne by query text: the team-from-field lookup and the "already exists" lookup. */
function routeQueryOne(opts: { fieldTeam?: string | null; existing?: string | null }) {
  h.runQueryOne.mockImplementation(async (_s: unknown, q: string) => {
    if (q.includes('FORM_REFERS_TO_TEAM')) return opts.fieldTeam === undefined ? null : { teamId: opts.fieldTeam }
    if (q.includes('task_key: $chiave')) return opts.existing ? { id: opts.existing } : null
    throw new Error('unexpected query')
  })
}

beforeEach(() => {
  for (const f of [h.runQuery, h.runQueryOne, h.nextSequenceBlock, h.warn, h.error, h.getSession]) f.mockReset()
  h.close.mockClear()
  h.nextSequenceBlock.mockResolvedValue(42)
})

describe('task states', () => {
  it('only "open" asks something now; open and waiting both hold the step', () => {
    expect(isOpenState('open')).toBe(true)
    expect(isOpenState('waiting')).toBe(false)
    expect(isPendingState('waiting')).toBe(true)
    expect(isPendingState('open')).toBe(true)
    expect(isPendingState('completed')).toBe(false)
    expect(isPendingState('cancelled')).toBe(false)
  })

  it('the natural key uses the action position, not the title', () => {
    expect(chiaveCompito('sr-1', 'fulfil', 2)).toBe('sr-1::fulfil::2')
  })
})

describe('creaCompito', () => {
  it('a new task gets the next TASK number, starts open, and is written with the ticket label check', async () => {
    routeQueryOne({ existing: null })
    h.runQuery.mockResolvedValueOnce([createdRow()])
    await expect(creaCompito(task())).resolves.toBe('k1')
    const p = h.runQuery.mock.calls[0]?.[2] as Record<string, unknown>
    expect(p['code']).toBe('TASK00000042')
    expect(p['statoIniziale']).toBe(TASK_STATE.OPEN)
    expect(p['etichetta']).toBe('ServiceRequest')
    expect(p['taskKey']).toBe('sr-1::fulfil::0')
    expect(p['tenantId']).toBe('t1')
    expect(p['teamId']).toBe('team-desk')
    expect(p['dueAt']).toBeNull()
    expect(h.getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(h.close).toHaveBeenCalled()
  })

  it('re-entering the step does not take a new number (no gaps in numbering)', async () => {
    routeQueryOne({ existing: 'k-old' })
    h.runQuery.mockResolvedValueOnce([createdRow({ id: 'k-old' })])
    await expect(creaCompito(task())).resolves.toBe('k-old')
    expect(h.nextSequenceBlock).not.toHaveBeenCalled()
    expect((h.runQuery.mock.calls[0]?.[2] as Record<string, unknown>)['code']).toBeNull()
  })

  // Review of 23 Sep 2026: the MERGE matched the cancelled task and left it cancelled — the step's gate passed with no work done.
  it('re-entering the step reopens a task CANCELLED by the conclusion, clearing why and when; a completed one stays completed', async () => {
    routeQueryOne({ existing: 'k-old' })
    h.runQuery.mockResolvedValueOnce([createdRow({ id: 'k-old' })])
    await creaCompito(task())
    const [cypher, p] = [String(h.runQuery.mock.calls[0]?.[1]), h.runQuery.mock.calls[0]?.[2] as Record<string, unknown>]
    expect(p['annullato']).toBe(TASK_STATE.CANCELLED)
    const onMatch = cypher.slice(cypher.indexOf('ON MATCH SET'), cypher.indexOf('WITH ticket, k, squadra'))
    for (const f of ['completed_at', 'completed_by', 'cancel_reason']) expect(onMatch).toContain(`k.${f} = CASE WHEN k.state = $annullato THEN null ELSE k.${f} END`)
    // The state last: the items before it still read the old one.
    expect(onMatch.trim().endsWith('k.state        = CASE WHEN k.state = $annullato THEN $statoIniziale ELSE k.state END')).toBe(true)
  })

  it('a task that waits for another starts as waiting, and a due date is days from now', async () => {
    routeQueryOne({})
    h.runQuery.mockResolvedValueOnce([createdRow()])
    const before = Date.now()
    await creaCompito(task({ after: 'Create account', dueInDays: 2 }))
    const p = h.runQuery.mock.calls[0]?.[2] as Record<string, unknown>
    expect(p['statoIniziale']).toBe(TASK_STATE.WAITING)
    expect(p['after']).toBe('Create account')
    const due = Date.parse(p['dueAt'] as string)
    expect(due - before).toBeGreaterThanOrEqual(2 * 86_400_000 - 1000)
    expect(due - before).toBeLessThanOrEqual(2 * 86_400_000 + 5000)
  })

  it('the team from a form field wins over the fixed team', async () => {
    routeQueryOne({ fieldTeam: 'team-from-ci' })
    h.runQuery.mockResolvedValueOnce([createdRow({ teamId: 'team-from-ci' })])
    await creaCompito(task({ teamFromField: 'application' }))
    expect((h.runQuery.mock.calls[0]?.[2] as Record<string, unknown>)['teamId']).toBe('team-from-ci')
    expect(h.warn).not.toHaveBeenCalled()
  })

  it('an empty form field gives no assignee — never the fixed team — and it is logged', async () => {
    routeQueryOne({ fieldTeam: null })
    h.runQuery.mockResolvedValueOnce([createdRow({ teamId: null })])
    await creaCompito(task({ teamFromField: 'application' }))
    expect((h.runQuery.mock.calls[0]?.[2] as Record<string, unknown>)['teamId']).toBeNull()
    expect(h.warn).toHaveBeenCalledTimes(1)
    // No team was asked for, so a missing team on the result is not an error.
    expect(h.error).not.toHaveBeenCalled()
  })

  it('a missing ticket row (no field answer at all) also gives no assignee', async () => {
    routeQueryOne({})
    h.runQuery.mockResolvedValueOnce([createdRow({ teamId: null })])
    await creaCompito(task({ teamFromField: 'application' }))
    expect(h.warn).toHaveBeenCalledTimes(1)
  })

  it('a fixed team that no longer exists is logged as an error, the task still exists', async () => {
    routeQueryOne({})
    h.runQuery.mockResolvedValueOnce([createdRow({ teamId: null })])
    await expect(creaCompito(task())).resolves.toBe('k1')
    expect(h.error).toHaveBeenCalledTimes(1)
  })

  it('a ticket that is not of the declared type writes nothing and fails loudly', async () => {
    routeQueryOne({})
    h.runQuery.mockResolvedValueOnce([])
    await expect(creaCompito(task({ entityType: 'change', entityId: 'inc-1' })))
      .rejects.toThrow(/change "inc-1" not found, or it is not a Change/)
    expect(h.close).toHaveBeenCalled()
  })

  it('a non-ticket (a KB article) is refused before any database access', async () => {
    await expect(creaCompito(task({ entityType: 'kb_article' }))).rejects.toThrow(/"kb_article" is not a ticket/)
    expect(h.getSession).not.toHaveBeenCalled()
  })

  it('a ticket type the engine has no label for is refused', async () => {
    await expect(creaCompito(task({ entityType: 'problem' }))).rejects.toThrow(/unknown entity type "problem"/)
    expect(h.getSession).not.toHaveBeenCalled()
  })
})

describe('the waiting chain and the step guard', () => {
  it('apriDipendenti returns how many were opened, and 0 when the query returns nothing', async () => {
    h.runQuery.mockResolvedValueOnce([{ aperti: 2 }]).mockResolvedValueOnce([])
    await expect(apriDipendenti({} as never, 't1', 'k1')).resolves.toBe(2)
    const p = h.runQuery.mock.calls[0]?.[2] as Record<string, unknown>
    expect(p).toEqual({ taskId: 'k1', tenantId: 't1', attesa: 'waiting', aperto: 'open' })
    await expect(apriDipendenti({} as never, 't1', 'k1')).resolves.toBe(0)
  })

  it('compitiDaFareNelPasso counts open and waiting tasks of that step only', async () => {
    h.runQuery.mockResolvedValueOnce([{ quanti: 3 }]).mockResolvedValueOnce([])
    await expect(compitiDaFareNelPasso({} as never, 't1', 'sr-1', 'fulfil')).resolves.toBe(3)
    expect(h.runQuery.mock.calls[0]?.[2]).toEqual({ entityId: 'sr-1', tenantId: 't1', stepName: 'fulfil', daFare: ['open', 'waiting'] })
    await expect(compitiDaFareNelPasso({} as never, 't1', 'sr-1', 'fulfil')).resolves.toBe(0)
  })
})

describe('closing a ticket cancels its pending tasks', () => {
  it('returns how many were cancelled (0 when none), in a write session that is always closed', async () => {
    h.runQuery.mockResolvedValueOnce([{ quanti: 4 }]).mockResolvedValueOnce([])
    await expect(annullaCompitiDelTicketConcluso('t1', 'inc-1', 'Ticket closed')).resolves.toBe(4)
    await expect(annullaCompitiDelTicketConcluso('t1', 'inc-1', 'Ticket closed')).resolves.toBe(0)
    expect(h.getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(h.close).toHaveBeenCalledTimes(2)
  })
})

describe('reading tasks', () => {
  const full = {
    id: 'k1', code: 'TASK00000001', title: 'T', description: 'D', state: 'open', afterTitle: 'A',
    entityType: 'incident', entityId: 'inc-1', stepName: 's', dueAt: '2026-01-01', teamId: 'tm', teamName: 'Desk',
    assigneeId: 'u1', assigneeName: 'Ann', createdAt: '2025-12-01', completedAt: '2025-12-02', completedById: 'u2', cancelReason: 'why',
  }

  it('compitiDelTicket maps every column and turns missing optionals into null', async () => {
    const bare = { id: 'k2', code: 'TASK00000002', title: 'T2', state: 'open', entityType: 'incident', entityId: 'inc-1', stepName: 's', createdAt: 'x' }
    h.runQuery.mockResolvedValueOnce([full, bare])
    const out = await compitiDelTicket('t1', 'inc-1')
    expect(out[0]).toEqual(full)
    expect(out[1]).toMatchObject({ description: null, afterTitle: null, dueAt: null, teamId: null, teamName: null, assigneeId: null, assigneeName: null, completedAt: null, completedById: null, cancelReason: null })
    expect(h.runQuery.mock.calls[0]?.[2]).toEqual({ entityId: 'inc-1', tenantId: 't1' })
    expect(h.getSession).toHaveBeenCalledWith(undefined, 'READ')
    expect(h.close).toHaveBeenCalled()
  })

  it('compito returns the task, or null when it is not in this tenant', async () => {
    h.runQueryOne.mockResolvedValueOnce(full).mockResolvedValueOnce(null)
    await expect(compito('t1', 'k1')).resolves.toEqual(full)
    expect(h.runQueryOne.mock.calls[0]?.[2]).toEqual({ taskId: 'k1', tenantId: 't1' })
    await expect(compito('t2', 'k1')).resolves.toBeNull()
    expect(h.close).toHaveBeenCalledTimes(2)
  })
})
