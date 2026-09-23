/**
 * What the daily-work aggregates do with the rows the graph returns.
 *
 * The sibling test pins the Cypher rules; this one pins the arithmetic that
 * runs afterwards, because that is where a number goes silently wrong:
 *  - coverage must say how much of the audit log is people, how much is the
 *    generic `mutation.*` fallback and how much could not be read at all —
 *    otherwise an analyst builds a proposal on a minority of the facts;
 *  - two spellings of the same operation (`change_created`, `change.created`)
 *    must add up to ONE row, not two half-rows;
 *  - an action pair repeated by one person on one ticket is a correction, not
 *    a team habit: the three thresholds must all hold;
 *  - every function closes its read session, even when the query throws
 *    (a leaked session per nightly run exhausts the driver pool).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  runQuery: vi.fn(),
  runQueryOne: vi.fn(),
  close: vi.fn(async () => undefined),
}))

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ close: h.close }) }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({ runQuery: h.runQuery, runQueryOne: h.runQueryOne }))

const {
  copertura, azioniUmane, tempiNeiPassi, coppieRipetute, adozioneFunzioniAI, SOGLIE, AI_AUDIT_ACTIONS,
} = await import('../dailyWorkAggregates.js')

beforeEach(() => {
  vi.clearAllMocks()
  h.runQuery.mockResolvedValue([])
  h.runQueryOne.mockResolvedValue(null)
})

describe('copertura', () => {
  it('splits the log into human, generic and unreadable entries', async () => {
    h.runQueryOne.mockResolvedValue({ n: 1519, creati: 93 })
    h.runQuery.mockResolvedValue([
      { action: 'incident.assigned', userId: 'alice', n: 10 },
      { action: 'mutation.createIncident', userId: 'bob', n: 4 },
      // Unreadable: no dot, no known exception. Counted, never hidden.
      { action: 'weirdaction', userId: 'alice', n: 2 },
      // Machines count in the total but not as people.
      { action: 'incident.assigned', userId: 'monitoring', n: 100 },
      // An entry without an actor is not a person either.
      { action: 'incident.assigned', userId: null, n: 7 },
      { action: 'incident.assigned', userId: '   ', n: 1 },
    ])
    const c = await copertura('t1', 14)
    expect(c).toEqual({
      ticket: 1519, conVoceDiCreazione: 93,
      vociTotali: 124, vociUmane: 16, vociGeneriche: 4, azioniNonLette: 2,
      finestraGiorni: 14,
    })
    expect(h.runQueryOne.mock.calls[0]![2]).toMatchObject({ tenantId: 't1' })
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('an empty tenant reads as zeros, with the default 30-day window', async () => {
    const c = await copertura('t1')
    expect(c).toEqual({
      ticket: 0, conVoceDiCreazione: 0, vociTotali: 0, vociUmane: 0, vociGeneriche: 0, azioniNonLette: 0, finestraGiorni: 30,
    })
  })

  it('closes the session even when the query fails', async () => {
    h.runQueryOne.mockRejectedValue(new Error('neo4j down'))
    await expect(copertura('t1')).rejects.toThrow('neo4j down')
    expect(h.close).toHaveBeenCalledTimes(1)
  })
})

describe('azioniUmane', () => {
  it('merges two spellings of the same operation and drops what it cannot read', async () => {
    h.runQuery.mockResolvedValue([
      { action: 'change_created', n: 20, autori: 3, oggetti: 20 },
      { action: 'change.created', n: 5, autori: 4, oggetti: 5 },
      { action: 'tenant.ai_settings.updated', n: 2, autori: 1, oggetti: 1 },
      { action: 'nodot', n: 99, autori: 9, oggetti: 9 },
    ])
    const out = await azioniUmane('t1')
    expect(out).toEqual([
      // Distinct counts are not additive across spellings: the max is the honest lower bound.
      { object: 'change', verb: 'created', n: 25, autoriDistinti: 4, oggettiDistinti: 20 },
      // With several dots the object is everything before the last one.
      { object: 'tenant.ai_settings', verb: 'updated', n: 2, autoriDistinti: 1, oggettiDistinti: 1 },
    ])
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('sorts by volume after merging, not by the order the graph returned', async () => {
    h.runQuery.mockResolvedValue([
      { action: 'incident.assigned', n: 8, autori: 1, oggetti: 1 },
      { action: 'change_created', n: 5, autori: 1, oggetti: 1 },
      { action: 'change.created', n: 5, autori: 1, oggetti: 1 },
    ])
    expect((await azioniUmane('t1')).map((r) => r.n)).toEqual([10, 8])
  })
})

describe('tempiNeiPassi', () => {
  it('rounds hours to two decimals and reports the discarded import zeros', async () => {
    h.runQuery.mockResolvedValue([
      { step: 'assigned', n: 1185, mediana: 1.14567, p90: 9.9999, oltre: 3, zeri: 40 },
    ])
    expect(await tempiNeiPassi('t1', 7)).toEqual([
      { stepName: 'assigned', n: 1185, medianaOre: 1.15, p90Ore: 10, oltre48h: 3, zeriScartati: 40 },
    ])
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('no executions in the window: an empty list', async () => {
    expect(await tempiNeiPassi('t1')).toEqual([])
  })
})

describe('coppieRipetute', () => {
  const coppia = (prima: string, poi: string, n: number, oggetti = 5, autori = 3) => ({ prima, poi, n, oggetti, autori })

  it('keeps only pairs that repeat, on several objects, by several people', async () => {
    h.runQuery.mockResolvedValue([
      coppia('incident.assigned', 'comment.added', 15),
      // The same pair under two spellings: these two rows merge into one.
      coppia('change_created', 'change_transition', 6, 2, 1),
      coppia('change.created', 'change.transitioned', 6, 4, 2),
      // One ticket only: a person fixing a mistake, not a habit.
      coppia('incident.updated', 'incident.resolved', 40, 1, 5),
      // One person only: their way of working, not the team's.
      coppia('problem.created', 'problem.linked', 40, 9, 1),
      // Under the occurrence threshold.
      coppia('kb.created', 'kb.published', SOGLIE.coppia.occorrenze - 1),
    ])
    const out = await coppieRipetute('t1')
    expect(out).toEqual([
      { prima: 'incident.assigned', poi: 'comment.added', n: 15, oggettiDistinti: 5, autoriDistinti: 3 },
      { prima: 'change.created', poi: 'change.transitioned', n: 12, oggettiDistinti: 4, autoriDistinti: 2 },
    ])
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('a pair of an action with itself is a correction, and an unreadable side drops the pair', async () => {
    h.runQuery.mockResolvedValue([
      coppia('incident.updated', 'incident.updated', 50),
      // Two spellings of the same action are still the same action.
      coppia('change_created', 'change.created', 50),
      coppia('nodot', 'incident.updated', 50),
      coppia('incident.updated', 'nodot', 50),
    ])
    expect(await coppieRipetute('t1')).toEqual([])
  })

  it('orders the surviving pairs by volume', async () => {
    h.runQuery.mockResolvedValue([
      coppia('a.x', 'a.y', 10),
      coppia('b.x', 'b.y', 30),
    ])
    expect((await coppieRipetute('t1')).map((c) => c.prima)).toEqual(['b.x', 'a.x'])
  })

  /*
   * D67 (tour of 23 Sep 2026): the pairs were a self-join of the audit log,
   * one index lookup per entry — 2.4 s on the demo tenant. Grouping the
   * entries of one person on one object first gives the same 57 pairs
   * (compared row by row on the demo data) in 0.4 s.
   */
  it('groups the entries of one person on one object before pairing them, instead of joining the log with itself', async () => {
    h.runQuery.mockResolvedValue([])
    await coppieRipetute('t1')
    const cypher = String(h.runQuery.mock.calls[0]![1])
    expect(cypher).toContain('WITH entity, user, collect({action: a.action, at: a.created_at}) AS seq')
    expect(cypher).toContain('UNWIND range(i + 1, size(seq) - 1) AS j')
    expect(cypher).not.toContain('MATCH (b:AuditEntry')
  })
})

describe('adozioneFunzioniAI', () => {
  it('returns the raw action as the feature, with numbers coerced', async () => {
    h.runQuery.mockResolvedValue([{ action: 'kb_article.drafted_by_ai', n: '3', autori: '2' }])
    expect(await adozioneFunzioniAI('t1')).toEqual([{ feature: 'kb_article.drafted_by_ai', n: 3, autoriDistinti: 2 }])
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  /*
   * Tour of 23 Sep 2026: `CONTAINS 'ai'` counted taking a task («claimed»), a
   * maintenance window and an e-mail preference as AI at work.
   */
  it('counts only the entries named as AI at work, never a substring of the action', async () => {
    h.runQuery.mockResolvedValue([])
    await adozioneFunzioniAI('t1')
    const cypher = String(h.runQuery.mock.calls[0]![1])
    const params = h.runQuery.mock.calls[0]![2] as Record<string, unknown>
    expect(cypher).toContain('a.action IN $azioniAI')
    expect(cypher).not.toContain('CONTAINS')
    expect(params['azioniAI']).toEqual([...AI_AUDIT_ACTIONS])
    for (const notAI of ['task.claimed', 'user.email_notifications.updated', 'mutation.createMaintenanceWindow', 'proposal.execution_failed', 'domain_matrix_updated']) {
      expect(AI_AUDIT_ACTIONS).not.toContain(notAI)
    }
    expect(AI_AUDIT_ACTIONS).toContain('kb_article.drafted_by_ai')
  })
})
