/**
 * The assessment question admin beyond validation: what is written, where,
 * and what is refused.
 *
 * `questionAdmin.test.ts` pins the rules on text, labels and scores. This file
 * pins the rest of the lifecycle, because each of these broke a change for real:
 *  - editing the options must NOT drop an answer already given: removing an
 *    option someone chose is refused, naming it, instead of silently orphaning
 *    the `AssessmentResponse` (tasks then showed "Missing answers");
 *  - a question with responses cannot be deleted (the risk score of completed
 *    changes would lose its evidence);
 *  - every write is scoped to the caller's tenant, and a CI type can only be
 *    linked if it is shipped with the product or belongs to the caller;
 *  - turning "core" off detaches the question from every CI type, turning it
 *    on attaches it to all of them — the checkbox in the UI calls this.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

const h = vi.hoisted(() => ({
  run: vi.fn<(q: string, p?: Record<string, unknown>) => Promise<{ records: unknown[] }>>(),
  runQuery: vi.fn(),
  runQueryOne: vi.fn(),
}))

vi.mock('../../ci-utils.js', () => ({
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeWrite: (w: (tx: unknown) => unknown) => w({ run: h.run }),
    executeRead:  (w: (tx: unknown) => unknown) => w({ run: h.run }),
  }),
  runQuery: h.runQuery,
  runQueryOne: h.runQueryOne,
}))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const {
  createAssessmentQuestion, updateAssessmentQuestion, deleteAssessmentQuestion,
  assignQuestionToCIType, removeQuestionFromCIType, setQuestionCore,
} = await import('../questionAdmin.js')

const ctx = { tenantId: 'c-test', userId: 'u1', userEmail: 'a@b.c', role: 'admin', permissions: perms('admin') } as never
const buone = [{ label: 'Tested', score: 1, sortOrder: 0 }, { label: 'Untested', score: 3, sortOrder: 1 }]
const cypher = () => h.run.mock.calls.map((c) => String(c[0]))
const params = () => h.run.mock.calls.map((c) => c[1] ?? {})

/** The question as the graph returns it after a write, with its options. */
function graphReturnsQuestion(id = 'q1') {
  h.runQueryOne.mockResolvedValueOnce({ props: { id, text: 'Tested?', category: 'technical', is_core: true, is_active: true, created_at: '2026-09-01' } })
  h.runQuery.mockResolvedValueOnce([
    { props: { id: 'o1', label: 'Tested', score: 1, sort_order: 0 } },
    { props: { id: 'o2', label: 'Untested', score: 3, sort_order: 1 } },
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  h.run.mockResolvedValue({ records: [] })
  h.runQuery.mockResolvedValue([])
  h.runQueryOne.mockResolvedValue(null)
})

describe('createAssessmentQuestion', () => {
  it('rejects an unknown category', async () => {
    await expect(createAssessmentQuestion(null, { input: { text: 'Q', category: 'legal', isCore: false, options: buone } }, ctx))
      .rejects.toThrow(/functional" or "technical/)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('a non-core question is created in the tenant and NOT attached to any CI type', async () => {
    graphReturnsQuestion()
    const out = await createAssessmentQuestion(null, { input: { text: 'Tested?', category: 'technical', isCore: false, options: buone } }, ctx)
    expect(cypher()).toHaveLength(1)
    expect(cypher()[0]).toContain('CREATE (q:AssessmentQuestion')
    expect(params()[0]).toMatchObject({ tenantId: 'c-test', text: 'Tested?', isCore: false, options: buone })
    // The answer is read back from the graph, options in order, mapped for the API.
    expect(out).toEqual({
      id: 'q1', text: 'Tested?', category: 'technical', isCore: true, isActive: true, createdAt: '2026-09-01',
      options: [
        { id: 'o1', label: 'Tested', score: 1, sortOrder: 0 },
        { id: 'o2', label: 'Untested', score: 3, sortOrder: 1 },
      ],
    })
    expect(h.runQueryOne.mock.calls[0]![2]).toEqual({ id: expect.any(String), tenantId: 'c-test' })
  })

  it('a question the graph cannot read back returns null rather than a half object', async () => {
    const out = await createAssessmentQuestion(null, { input: { text: 'Q', category: 'functional', isCore: false, options: buone } }, ctx)
    expect(out).toBeNull()
    expect(h.runQuery).not.toHaveBeenCalled()
  })
})

describe('assertQuestionUsable — the shapes that bypass GraphQL typing', () => {
  it('an option whose label is not a string is treated as blank', async () => {
    await expect(createAssessmentQuestion(null, { input: {
      text: 'Q', category: 'technical', isCore: false,
      options: [{ label: null as never, score: 1, sortOrder: 0 }, { label: 'b', score: 2, sortOrder: 1 }],
    } }, ctx)).rejects.toThrow(/One answer option has no text/)
  })

  it('counts every blank option in the message', async () => {
    await expect(createAssessmentQuestion(null, { input: {
      text: 'Q', category: 'technical', isCore: false,
      options: [{ label: '', score: 1, sortOrder: 0 }, { label: ' ', score: 2, sortOrder: 1 }, { label: 'c', score: 3, sortOrder: 2 }],
    } }, ctx)).rejects.toThrow(/2 answer options have no text/)
  })

  it('a missing or infinite score is refused before the integer rule', async () => {
    for (const score of [undefined, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(createAssessmentQuestion(null, { input: {
        text: 'Q', category: 'technical', isCore: false,
        options: [{ label: 'a', score: score as never, sortOrder: 0 }, { label: 'b', score: 2, sortOrder: 1 }],
      } }, ctx)).rejects.toThrow(/numeric score/)
    }
  })
})

describe('updateAssessmentQuestion', () => {
  it('rejects an unknown category, but an omitted one is fine', async () => {
    await expect(updateAssessmentQuestion(null, { id: 'q1', input: { category: 'legal' } }, ctx)).rejects.toThrow(/category/)
    await updateAssessmentQuestion(null, { id: 'q1', input: { isActive: false } }, ctx)
    // Omitted fields become null so `coalesce` keeps the stored value.
    expect(params()[0]).toEqual({ id: 'q1', tenantId: 'c-test', text: null, category: null, isCore: null, isActive: false })
  })

  it('without options, the options are not touched', async () => {
    await updateAssessmentQuestion(null, { id: 'q1', input: { text: 'New text' } }, ctx)
    expect(cypher()).toHaveLength(1)
    expect(h.runQuery).not.toHaveBeenCalled()
  })

  it('keeps existing options by id, so answers already given survive', async () => {
    const options = [{ id: 'o1', label: 'Tested', score: 1, sortOrder: 0 }, { id: '', label: 'New', score: 4, sortOrder: 1 }, { label: 'Other', score: 2, sortOrder: 2 }]
    await updateAssessmentQuestion(null, { id: 'q1', input: { options } }, ctx)
    // The in-use check runs against the options being REMOVED only, in this tenant.
    expect(h.runQuery.mock.calls[0]![2]).toEqual({ questionId: 'q1', tenantId: 'c-test', keptIds: ['o1'] })
    const write = cypher()[1]!
    expect(write).toContain('coalesce(opt.id, randomUUID())')
    expect(write).toContain('WHERE NOT gone.id IN $keptIds')
    expect(params()[1]).toMatchObject({ questionId: 'q1', tenantId: 'c-test', keptIds: ['o1'], options })
  })

  it('removing an option somebody already chose is refused, naming it', async () => {
    h.runQuery.mockResolvedValueOnce([{ label: 'Untested', answers: 3 }, { label: 'Partly', answers: 1 }])
    const err = await updateAssessmentQuestion(null, { id: 'q1', input: { options: [{ id: 'o1', label: 'Tested', score: 1, sortOrder: 0 }, { label: 'x', score: 2, sortOrder: 1 }] } }, ctx)
      .then(() => null, (e: { message: string; extensions: { code: string } }) => e)
    expect(err!.extensions.code).toBe('CONFLICT')
    expect(err!.message).toContain('"Untested" (3), "Partly" (1)')
    // Nothing was deleted: only the scalar update ran before the refusal.
    expect(cypher().some((q) => q.includes('DETACH DELETE'))).toBe(false)
  })
})

describe('deleteAssessmentQuestion', () => {
  it('a question with responses cannot be deleted', async () => {
    h.runQueryOne.mockResolvedValueOnce({ count: 2 })
    await expect(deleteAssessmentQuestion(null, { id: 'q1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('without responses, question and options are deleted in the tenant', async () => {
    h.runQueryOne.mockResolvedValueOnce({ count: 0 })
    expect(await deleteAssessmentQuestion(null, { id: 'q1' }, ctx)).toBe(true)
    expect(cypher()[0]).toContain('DETACH DELETE o, q')
    expect(params()[0]).toEqual({ id: 'q1', tenantId: 'c-test' })
  })

  it('no count row at all is read as zero', async () => {
    expect(await deleteAssessmentQuestion(null, { id: 'q1' }, ctx)).toBe(true)
  })
})

describe('CI type links', () => {
  it('assign: only a shipped CI type or one of the caller, with the given weight and order', async () => {
    expect(await assignQuestionToCIType(null, { questionId: 'q1', ciTypeId: 'ct1', weight: 2, sortOrder: 5 }, ctx)).toBe(true)
    expect(cypher()[0]).toContain("ct.scope = 'base' OR ct.tenant_id IN [$tenantId, 'system']")
    expect(params()[0]).toEqual({ ciTypeId: 'ct1', questionId: 'q1', weight: 2, sortOrder: 5, tenantId: 'c-test' })
  })

  it('remove: the same scope rule, so another tenant\'s link cannot be cut', async () => {
    expect(await removeQuestionFromCIType(null, { questionId: 'q1', ciTypeId: 'ct1' }, ctx)).toBe(true)
    expect(cypher()[0]).toContain("ct.scope = 'base' OR ct.tenant_id IN [$tenantId, 'system']")
    expect(cypher()[0]).toContain('DELETE rel')
    expect(params()[0]).toEqual({ ciTypeId: 'ct1', questionId: 'q1', tenantId: 'c-test' })
  })
})

describe('setQuestionCore', () => {
  it('on: attaches to every active CI type of the customer too, and returns the question', async () => {
    graphReturnsQuestion()
    const out = await setQuestionCore(null, { questionId: 'q1', isCore: true }, ctx)
    expect(cypher()).toHaveLength(2)
    expect(cypher()[1]).toMatch(/ct\.scope = 'base' OR \(ct\.scope = 'tenant' AND ct\.tenant_id = \$tenantId\)/)
    expect(cypher()[1]).toContain('MERGE (ct)-[rel:HAS_QUESTION]->(q)')
    expect(params()).toEqual([{ id: 'q1', tenantId: 'c-test', isCore: true }, { id: 'q1', tenantId: 'c-test' }])
    expect(out).toMatchObject({ id: 'q1', options: [{ id: 'o1' }, { id: 'o2' }] })
  })

  it('off: detaches from every CI type', async () => {
    await setQuestionCore(null, { questionId: 'q1', isCore: false }, ctx)
    expect(cypher()[1]).toContain('DELETE rel')
    expect(cypher()[1]).not.toContain('MERGE')
    expect(params()[1]).toEqual({ id: 'q1', tenantId: 'c-test' })
  })
})
