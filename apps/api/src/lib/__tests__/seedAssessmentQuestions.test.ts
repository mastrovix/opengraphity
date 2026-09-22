/**
 * THE ASSESSMENT QUESTIONS A NEW TENANT IS BORN WITH.
 *
 * Without these questions no change can pass its assessment, so a tenant
 * provisioned without them is a tenant whose change process is dead on
 * arrival. What must hold:
 *  - a fresh tenant gets the full core set, each question with its options
 *    and scores (the risk score is computed from them);
 *  - running it again creates NOTHING twice (provisioning is retried after a
 *    partial failure), recognising questions by (tenant, text);
 *  - the link to CI types is re-aligned on EVERY run, also for questions that
 *    already existed, so a CI type the customer added later inherits them;
 *  - everything is scoped to the tenant being provisioned.
 */
import { describe, it, expect } from 'vitest'
import type { Session } from 'neo4j-driver'
import { seedAssessmentQuestions } from '../seedAssessmentQuestions.js'

type Run = { cypher: string; params: Record<string, unknown> }

/** A tiny in-memory graph of questions keyed by tenant and text. */
function fakeSession(existingTexts: string[] = [], tenantId = 't1') {
  const questions = new Map<string, string>(existingTexts.map((t, i) => [`${tenantId}|${t}`, `pre-${String(i)}`]))
  const runs: Run[] = []
  const tx = {
    run: async (cypher: string, params: Record<string, unknown>) => {
      runs.push({ cypher, params })
      if (cypher.includes('RETURN q.id AS id')) {
        const id = questions.get(`${String(params['tenantId'])}|${String(params['text'])}`)
        return { records: id ? [{ get: () => id }] : [] }
      }
      if (cypher.includes('CREATE (q:AssessmentQuestion')) {
        questions.set(`${String(params['tenantId'])}|${String(params['text'])}`, String(params['qid']))
      }
      return { records: [] }
    },
  }
  const session = {
    executeRead: (fn: (t: typeof tx) => unknown) => fn(tx),
    executeWrite: (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as Session
  return { session, runs, questions }
}

const creates = (runs: Run[]) => runs.filter((r) => r.cypher.includes('CREATE (q:AssessmentQuestion'))
const links = (runs: Run[]) => runs.filter((r) => r.cypher.includes('HAS_QUESTION'))

describe('seedAssessmentQuestions', () => {
  it('gives a fresh tenant the full core set, with options and scores', async () => {
    const { session, runs } = fakeSession()
    const out = await seedAssessmentQuestions(session, 't1')

    expect(out.existing).toBe(0)
    expect(out.created).toBeGreaterThan(0)
    expect(creates(runs)).toHaveLength(out.created)
    for (const c of creates(runs)) {
      expect(c.params['tenantId']).toBe('t1')
      expect(['functional', 'technical']).toContain(c.params['category'])
      const options = c.params['options'] as Array<{ label: string; score: number; idx: number }>
      // At least two answers, each with a score, in a stable display order.
      expect(options.length).toBeGreaterThanOrEqual(2)
      expect(options.map((o) => o.idx)).toEqual(options.map((_, i) => i))
      for (const o of options) expect(typeof o.score).toBe('number')
    }
    // Question ids are unique: two questions sharing an id would merge their answers.
    const ids = creates(runs).map((c) => c.params['qid'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is idempotent: a second run creates nothing and still re-links every question', async () => {
    const { session, runs } = fakeSession()
    const first = await seedAssessmentQuestions(session, 't1')
    runs.length = 0
    const second = await seedAssessmentQuestions(session, 't1')

    expect(second).toEqual({ created: 0, existing: first.created })
    expect(creates(runs)).toEqual([])
    expect(links(runs)).toHaveLength(first.created)
  })

  it('creates only what is missing, and links existing questions by their own id', async () => {
    const { session, runs } = fakeSession(['Is a tested rollback plan available?'])
    const out = await seedAssessmentQuestions(session, 't1')

    expect(out.existing).toBe(1)
    expect(creates(runs).map((c) => c.params['text'])).not.toContain('Is a tested rollback plan available?')
    const rollbackLink = links(runs).find((l) => l.params['qid'] === 'pre-0')
    expect(rollbackLink?.params).toMatchObject({ tenantId: 't1', weight: 5 })
  })

  it('links carry the question weight and a sort order that follows the seed order', async () => {
    const { session, runs } = fakeSession()
    await seedAssessmentQuestions(session, 't1')
    const orders = links(runs).map((l) => l.params['sortOrder'])
    expect(orders).toEqual(orders.map((_, i) => i))
    for (const l of links(runs)) expect(l.params['weight']).toEqual(expect.any(Number))
    // The link query only reaches CI types visible to this tenant.
    expect(links(runs)[0]!.cypher).toContain("ct.scope = 'tenant' AND ct.tenant_id = $tenantId")
  })

  it('another tenant\'s questions do not count as existing', async () => {
    const { session } = fakeSession(['Is a tested rollback plan available?'], 'other')
    const out = await seedAssessmentQuestions(session, 't1')
    expect(out.existing).toBe(0)
  })
})
