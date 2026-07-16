/**
 * evaluateAutoTransitions — cammina il workflow in avanti finché le condizioni
 * automatiche dello step corrente lo permettono.
 *
 * Per ogni iterazione il codice esegue, in ordine:
 *   1. runQueryOne  (…HAS_WORKFLOW…)          → WorkflowInstance corrente
 *   2. runQuery     (…TRANSITIONS_TO {trigger: 'automatic'}…) → transizioni uscenti
 *   3. runQueryOne della condition:
 *        all_assessments_complete → …HAS_ASSESSMENT… + …HAS_DEPLOY_PLAN…
 *        all_deployments_complete → …HAS_VALIDATION… + …HAS_DEPLOYMENT…
 *        all_reviews_confirmed    → …HAS_REVIEW…
 *      (tutte ritornano un conteggio `pending`: 0 = condizione soddisfatta)
 *   4. workflowEngine.transition + afterEnterStep se la condizione passa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../context.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('../../ci-utils.js', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn(),
}))

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { evaluateAutoTransitions } = await import('../autoTransitions.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { runQuery, runQueryOne } = await import('../../ci-utils.js')
const { logger } = await import('../../../../lib/logger.js')

// ── Test context ──────────────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator' }
const mockSession = {} as never

/**
 * Mocka il grafo: WorkflowInstance sempre presente, le transizioni automatiche
 * dello step corrente solo alla prima iterazione (poi [] per fermare il loop),
 * e le condition query rispondono con il `pending` indicato.
 */
function mockDb(opts: { transitions: Array<{ toStep: string; condition: string | null }>; pending?: number }) {
  vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, query: string) => {
    if (query.includes('HAS_WORKFLOW')) {
      return { instanceId: 'wi-1', step: 'assessment', tenantId: 'tenant-1', entityProps: { id: 'chg-1', code: 'CHG00000001' } } as never
    }
    // condition query (HAS_ASSESSMENT / HAS_VALIDATION / HAS_REVIEW)
    return { pending: opts.pending ?? 0 } as never
  })
  let transitionsCall = 0
  vi.mocked(runQuery).mockImplementation(async () => {
    transitionsCall += 1
    return (transitionsCall === 1 ? opts.transitions : []) as never
  })
}

const conditionQueries = () =>
  vi.mocked(runQueryOne).mock.calls
    .map((c) => c[1] as string)
    .filter((q) => !q.includes('HAS_WORKFLOW'))

describe('evaluateAutoTransitions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
  })

  describe('all_assessments_complete', () => {
    it('tutti i task completati (pending 0) → fa la transition e chiama afterEnterStep', async () => {
      mockDb({ transitions: [{ toStep: 'planning', condition: 'all_assessments_complete' }], pending: 0 })
      const afterEnterStep = vi.fn().mockResolvedValue(undefined)

      await evaluateAutoTransitions(mockSession, 'chg-1', ctx, afterEnterStep)

      expect(workflowEngine.transition).toHaveBeenCalledOnce()
      expect(workflowEngine.transition).toHaveBeenCalledWith(
        mockSession,
        { instanceId: 'wi-1', toStepName: 'planning', triggeredBy: 'system', triggerType: 'automatic' },
        { userId: 'user-1', entityData: { id: 'chg-1', code: 'CHG00000001' } },
      )
      expect(afterEnterStep).toHaveBeenCalledWith(mockSession, 'chg-1', 'tenant-1', 'planning')
      // la condition interroga assessment + deploy plan
      expect(conditionQueries()[0]).toContain('HAS_ASSESSMENT')
      expect(conditionQueries()[0]).toContain('HAS_DEPLOY_PLAN')
    })

    it('un task ancora pending → NESSUNA transition', async () => {
      mockDb({ transitions: [{ toStep: 'planning', condition: 'all_assessments_complete' }], pending: 1 })

      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

      expect(workflowEngine.transition).not.toHaveBeenCalled()
    })
  })

  describe('all_deployments_complete', () => {
    it('validation pass + deployment completed (pending 0) → transition', async () => {
      mockDb({ transitions: [{ toStep: 'completed', condition: 'all_deployments_complete' }], pending: 0 })

      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

      expect(workflowEngine.transition).toHaveBeenCalledOnce()
      const q = conditionQueries()[0]!
      expect(q).toContain('HAS_VALIDATION')
      expect(q).toContain('HAS_DEPLOYMENT')
      // conta come pending anche le validation completate ma con result != pass
      const params = vi.mocked(runQueryOne).mock.calls
        .find((c) => (c[1] as string).includes('HAS_VALIDATION'))![2] as Record<string, unknown>
      expect(params['passResult']).toBe('pass')
    })

    it('una validation fallita / deployment non completo → NESSUNA transition', async () => {
      mockDb({ transitions: [{ toStep: 'completed', condition: 'all_deployments_complete' }], pending: 1 })

      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

      expect(workflowEngine.transition).not.toHaveBeenCalled()
    })
  })

  describe('all_reviews_confirmed', () => {
    it('tutte le review confirmed (pending 0) → transition', async () => {
      mockDb({ transitions: [{ toStep: 'closed', condition: 'all_reviews_confirmed' }], pending: 0 })

      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

      expect(workflowEngine.transition).toHaveBeenCalledOnce()
      const q = conditionQueries()[0]!
      expect(q).toContain('HAS_REVIEW')
      const params = vi.mocked(runQueryOne).mock.calls
        .find((c) => (c[1] as string).includes('HAS_REVIEW'))![2] as Record<string, unknown>
      expect(params['confirmedResult']).toBe('confirmed')
    })

    it('una review rejected → NESSUNA transition', async () => {
      mockDb({ transitions: [{ toStep: 'closed', condition: 'all_reviews_confirmed' }], pending: 1 })

      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

      expect(workflowEngine.transition).not.toHaveBeenCalled()
    })
  })

  it('condition sconosciuta → logga errore, non fa transition e non crasha', async () => {
    mockDb({ transitions: [{ toStep: 'somewhere', condition: 'does_not_exist' }], pending: 0 })

    await expect(evaluateAutoTransitions(mockSession, 'chg-1', ctx)).resolves.toBeUndefined()

    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledOnce()
    const [meta, msg] = vi.mocked(logger.error).mock.calls[0]! as [Record<string, unknown>, string]
    expect(meta['condition']).toBe('does_not_exist')
    expect(msg).toContain('condition sconosciuta')
  })

  it('transizione automatica senza condition → fired incondizionatamente', async () => {
    mockDb({ transitions: [{ toStep: 'next', condition: null }] })

    await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

    expect(workflowEngine.transition).toHaveBeenCalledOnce()
  })

  it('workflowEngine.transition fallisce → logga e si ferma senza afterEnterStep', async () => {
    mockDb({ transitions: [{ toStep: 'planning', condition: 'all_assessments_complete' }], pending: 0 })
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: false, error: 'guard failed' } as never)
    const afterEnterStep = vi.fn()

    await expect(evaluateAutoTransitions(mockSession, 'chg-1', ctx, afterEnterStep)).resolves.toBeUndefined()

    expect(afterEnterStep).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledOnce()
  })

  it('change senza WorkflowInstance → ritorna senza fare nulla', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)

    await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

    expect(runQuery).not.toHaveBeenCalled()
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })
})
