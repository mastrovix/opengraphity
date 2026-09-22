/**
 * Improvement proposals — the list mapping and "who decided" name.
 *
 * - `decidedByName` shows the NAME of whoever decided, looked up inside the
 *   viewer's tenant only (a user id from another tenant must never resolve to
 *   a name), and never opens a session for an undecided proposal. The session
 *   is closed even when the lookup fails, or the pool leaks one per row.
 * - The list maps each row the way the single read does: the page decides
 *   whether to offer "undo" from `undoable`, which must be true only for an
 *   accepted, not-yet-undone proposal whose action can be undone and whose undo
 *   state was saved — offering a button that will fail is worse than none.
 * - A missing proposal reads as null (not an error): the page shows "gone".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const proposta = vi.fn()
const elencaProposte = vi.fn()
const conteggiProposte = vi.fn()
vi.mock('../../../lib/proposals.js', () => ({
  proposta: (...a: unknown[]) => proposta(...a),
  elencaProposte: (...a: unknown[]) => elencaProposte(...a),
  conteggiProposte: (...a: unknown[]) => conteggiProposte(...a),
  segnaDecisa: vi.fn(),
  scriviLapide: vi.fn(),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../services/problemService.js', () => ({ createProblem: vi.fn() }))
vi.mock('../../../lib/problemDossier.js', () => ({ legaAllaProposta: vi.fn(), fascicoloDelProblem: vi.fn() }))
vi.mock('../../../jobs/autoanalisiWorker.js', () => ({ enqueuePortaIlFascicolo: vi.fn() }))
vi.mock('../../../jobs/proposalScanner.js', () => ({ analizzaCliente: vi.fn(), conIlLucchetto: vi.fn() }))

const runQueryOne = vi.fn()
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQuery: vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
// config is faked whole: reading the real one needs the product's env secrets.
vi.mock('../../../lib/config.js', () => ({ config: { anthropicApiKey: undefined } }))
vi.mock('../../../lib/logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})

const { proposalResolvers } = await import('../proposals.js')
const { getSession } = await import('@opengraphity/neo4j')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set(['proposal.read']) } as never

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1', area: 'configuration', kind: 'sla_missing', params: undefined,
  fingerprint: 'fp1', evidence: { n: 1, windowDays: 30, refs: [{ entityType: 'team', id: 't9' }], extra: undefined },
  occurrences: 1, windowDays: 30, action: { type: 'automation.create_disabled' },
  rationale: 'why', rationaleLanguage: 'en', status: 'open',
  createdAt: 'yesterday', decidedAt: null, decidedBy: null, rejectedKind: null, rejectedNote: null,
  notNowUntil: null, auditEntryId: null, executionError: null, undone: false, undoState: null,
  openedProblem: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  runQueryOne.mockResolvedValue(null)
  conteggiProposte.mockResolvedValue({ open: 0, accepted: 0, rejected: 0, not_now: 0, expired: 0, superseded: 0 })
})

describe('Proposal.decidedByName', () => {
  const name = (decidedBy: string | null) => proposalResolvers.Proposal.decidedByName({ decidedBy }, null, ctx)

  it('an undecided proposal has no name and opens no session', async () => {
    await expect(name(null)).resolves.toBeNull()
    expect(getSession).not.toHaveBeenCalled()
  })

  it('looks the user up inside the viewer\'s tenant and returns the name', async () => {
    runQueryOne.mockResolvedValue({ name: 'Ada Lovelace' })
    await expect(name('u7')).resolves.toBe('Ada Lovelace')
    const [, cypher, params] = runQueryOne.mock.calls[0]!
    expect(cypher).toContain('MATCH (u:User {tenant_id: $tenantId, id: $userId})')
    expect(params).toEqual({ tenantId: 't1', userId: 'u7' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a user that does not exist in this tenant reads as null, not as the id', async () => {
    runQueryOne.mockResolvedValue(null)
    await expect(name('u-other-tenant')).resolves.toBeNull()
  })

  it('closes the session even when the lookup fails', async () => {
    runQueryOne.mockRejectedValue(new Error('neo4j down'))
    await expect(name('u7')).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('proposals list mapping', () => {
  it('maps each row and computes undoable only for an accepted, undoable, not-undone action with saved state', async () => {
    elencaProposte.mockResolvedValue({
      total: 5,
      items: [
        row({ id: 'a', status: 'accepted', undoState: { before: 1 } }),
        row({ id: 'b', status: 'accepted', undoState: { before: 1 }, undone: true }),
        row({ id: 'c', status: 'accepted', undoState: null }),
        row({ id: 'd', status: 'open', undoState: { before: 1 } }),
        // An action type the catalog does not know cannot be undone.
        row({ id: 'e', status: 'accepted', undoState: { before: 1 }, action: { type: 'unknown.action' } }),
      ],
    })
    const out = await proposalResolvers.Query.proposals(null, {}, ctx) as { items: Array<Record<string, unknown>>; aiAvailable: boolean }
    expect(out.items.map((p) => [p['id'], p['undoable']])).toEqual([['a', true], ['b', false], ['c', false], ['d', false], ['e', false]])
    // Absent params/extra become empty lists, not null: the page iterates them.
    expect(out.items[0]).toMatchObject({ params: [], actionType: 'automation.create_disabled', openedProblemId: null })
    expect((out.items[0]!['evidence'] as Record<string, unknown>)['extra']).toEqual([])
    // No Anthropic key configured: the page must say AI analysts are unavailable.
    expect(out.aiAvailable).toBe(false)
  })

  it('a proposal without an action has no actionType and is never undoable', async () => {
    elencaProposte.mockResolvedValue({ total: 1, items: [row({ status: 'accepted', action: null, undoState: { x: 1 } })] })
    const out = await proposalResolvers.Query.proposals(null, {}, ctx) as { items: Array<Record<string, unknown>> }
    expect(out.items[0]).toMatchObject({ actionType: null, undoable: false })
  })

  it('carries the opened problem id and number', async () => {
    elencaProposte.mockResolvedValue({ total: 1, items: [row({ openedProblem: { id: 'pr1', number: 'PRB0001' } })] })
    const out = await proposalResolvers.Query.proposals(null, {}, ctx) as { items: Array<Record<string, unknown>> }
    expect(out.items[0]).toMatchObject({ openedProblemId: 'pr1', openedProblemNumber: 'PRB0001' })
  })
})

describe('proposal (single)', () => {
  it('a proposal that is gone reads as null', async () => {
    proposta.mockResolvedValue(null)
    await expect(proposalResolvers.Query.proposal(null, { id: 'nope' }, ctx)).resolves.toBeNull()
    // Scoped to the viewer's tenant.
    expect(proposta).toHaveBeenCalledWith('t1', 'nope')
  })
})
