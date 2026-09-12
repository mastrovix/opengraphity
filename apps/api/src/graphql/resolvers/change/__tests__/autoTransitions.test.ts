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

// L'engine è mockato, ma le condizioni ITSM sono quelle vere (workflow/
// conditions.ts): evaluateCondition delega al registro reale così i test
// esercitano le query di condizione.
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance:    vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:        vi.fn().mockResolvedValue({ success: true }),
    registerCondition: vi.fn(),
    hasCondition:      vi.fn(),
    evaluateCondition: vi.fn(async (session: unknown, name: string, ctx: unknown) => {
      const { CHANGE_CONDITIONS } = await import('../../../../workflow/conditions.js')
      const c = CHANGE_CONDITIONS[name]
      if (!c) throw new Error(`Condizione di transizione sconosciuta: "${name}"`)
      return c.evaluate(session as never, ctx as never)
    }),
  },
}))

vi.mock('../../ci-utils.js', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn(),
}))

vi.mock('../../../../lib/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => child } }
})

// Fine finestra (Event Management, ondata 3 + revisione): i moduli sono
// importati dinamicamente da syncSuppressedEvents solo quando la change ha
// eventi soppressi; la mutation ACCODA il job `reevaluate-change-window`, non
// rivaluta in linea. Qui si verifica quando (e con che cosa) viene accodato.
vi.mock('../../../../services/eventCorrelation.js', () => ({
  // Ondata 4 · A4-1: i passi di finestra vengono dallo SCOPO dei passi del
  // tenant, non da due letterali. Qui il tenant ha i nomi di fabbrica.
  resolveChangeWindowSteps: vi.fn().mockResolvedValue({ implementation: ['deployment'], planned: ['scheduled'], all: ['deployment', 'scheduled'] }),
  reevaluateSuppressedEvents: vi.fn().mockResolvedValue(2),
}))
vi.mock('../../../../jobs/eventCorrelateWorker.js', () => ({
  enqueueChangeWindowReevaluation: vi.fn().mockResolvedValue(undefined),
}))
// Servizi monitorati (revisione 2 · D6.1): ingresso e uscita dalla finestra
// accodano la valutazione delle mappe che includono i CI della change.
vi.mock('../../../../services/serviceImpact/sync.js', () => ({
  notifyChangeWindowChanged: vi.fn().mockResolvedValue(1),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { evaluateAutoTransitions } = await import('../autoTransitions.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { runQuery, runQueryOne } = await import('../../ci-utils.js')
const { logger } = await import('../../../../lib/logger.js')
const { reevaluateSuppressedEvents } = await import('../../../../services/eventCorrelation.js')
const { enqueueChangeWindowReevaluation } = await import('../../../../jobs/eventCorrelateWorker.js')
const { notifyChangeWindowChanged } = await import('../../../../services/serviceImpact/sync.js')

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

  it('condition sconosciuta → fail-loud (CONFLICT), nessuna transition', async () => {
    mockDb({ transitions: [{ toStep: 'somewhere', condition: 'does_not_exist' }], pending: 0 })

    await expect(evaluateAutoTransitions(mockSession, 'chg-1', ctx)).rejects.toThrow(/sconosciuta/)

    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledOnce()
    const [meta] = vi.mocked(logger.error).mock.calls[0]! as [Record<string, unknown>, string]
    expect(meta['condition']).toBe('does_not_exist')
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

  it('change senza WorkflowInstance → nessuna transition', async () => {
    // walk: nessuna WorkflowInstance → esce subito.
    vi.mocked(runQueryOne).mockResolvedValue(null)
    // sync entità collegate (problem/incident): nessun collegamento → no-op.
    vi.mocked(runQuery).mockResolvedValue([] as never)

    await evaluateAutoTransitions(mockSession, 'chg-1', ctx)

    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(enqueueChangeWindowReevaluation).not.toHaveBeenCalled()
  })

  describe('fine finestra (eventi soppressi dalla change): la mutation accoda il job, non rivaluta in linea', () => {
    const ENTERED = '2026-09-09T10:00:00.000Z'

    /** Nessuna transizione automatica; la lettura "step + eventi soppressi" risponde come indicato. */
    function mockWindow(step: string, suppressed: number, enteredAt: string | null = ENTERED) {
      vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, query: string) => {
        if (query.includes('suppressed_by_change_id')) return { step, enteredAt, suppressed } as never
        if (query.includes('HAS_WORKFLOW')) return { instanceId: 'wi-1', step, tenantId: 'tenant-1', entityProps: { id: 'chg-1' } } as never
        return { pending: 1 } as never
      })
      vi.mocked(runQuery).mockResolvedValue([] as never)
    }

    it('change uscita da deployment (review) con eventi soppressi → job accodato con tenant, change ed epoca del passo (updated_at dell\'istanza); NESSUNA rivalutazione in linea', async () => {
      mockWindow('review', 2)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      expect(enqueueChangeWindowReevaluation).toHaveBeenCalledWith('tenant-1', 'chg-1', Date.parse(ENTERED))
      expect(reevaluateSuppressedEvents).not.toHaveBeenCalled()
      const q = vi.mocked(runQueryOne).mock.calls.map((c) => c[1] as string).find((s) => s.includes('suppressed_by_change_id'))!
      expect(q).toContain("MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})")
      expect(q).toContain("(e:Event {tenant_id: $tenantId, status: 'suppressed', suppressed_by_change_id: c.id})")
      expect(q).toContain('wi.updated_at AS enteredAt')
    })

    it('change chiusa (closed) con eventi soppressi → job accodato', async () => {
      mockWindow('closed', 1)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      expect(enqueueChangeWindowReevaluation).toHaveBeenCalledOnce()
    })

    it('accodamento fallito (Redis) → l\'errore propaga (fail-loud, nessun try/catch)', async () => {
      mockWindow('review', 2)
      vi.mocked(enqueueChangeWindowReevaluation).mockRejectedValueOnce(new Error('Redis down'))
      await expect(evaluateAutoTransitions(mockSession, 'chg-1', ctx)).rejects.toThrow('Redis down')
    })

    it('istanza senza updated_at leggibile → epoca corrente con avviso nel log', async () => {
      vi.useFakeTimers({ now: Date.parse('2026-09-09T12:00:00.000Z') })
      try {
        mockWindow('review', 2, null)
        await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      } finally { vi.useRealTimers() }
      expect(enqueueChangeWindowReevaluation).toHaveBeenCalledWith('tenant-1', 'chg-1', Date.parse('2026-09-09T12:00:00.000Z'))
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ changeId: 'chg-1' }), expect.stringMatching(/updated_at non leggibile/))
    })

    it.each([['deployment'], ['scheduled']])('change ancora in %s → nessun job (finestra aperta)', async (step) => {
      mockWindow(step, 3)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      expect(enqueueChangeWindowReevaluation).not.toHaveBeenCalled()
    })

    it('nessun evento soppresso → nessun job (i moduli non vengono nemmeno caricati)', async () => {
      mockWindow('review', 0)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      expect(enqueueChangeWindowReevaluation).not.toHaveBeenCalled()
    })
  })

  // ── Revisione 2 · D6.1: la finestra di change vista dai Servizi ────────────

  describe('segnale ai Servizi monitorati all\'ingresso e all\'uscita dalla finestra', () => {
    /** Nessuna transizione automatica; la lettura "step + marcatore" risponde come indicato. */
    function mockWindowState(step: string, notified: boolean | undefined) {
      vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, query: string) => {
        if (query.includes('suppressed_by_change_id')) return { step, enteredAt: null, suppressed: 0 } as never
        if (query.includes('c.service_window AS notified')) return { step, notified } as never
        if (query.includes('HAS_WORKFLOW')) return { instanceId: 'wi-1', step, tenantId: 'tenant-1', entityProps: { id: 'chg-1' } } as never
        return { pending: 1 } as never
      })
      vi.mocked(runQuery).mockResolvedValue([] as never)
    }
    const setCalls = () => vi.mocked(runQueryOne).mock.calls.map((c) => [c[1] as string, c[2] as Record<string, unknown>] as const).filter(([q]) => q.includes('SET c.service_window'))

    it.each([['deployment'], ['scheduled']])('ingresso in %s (marcatore assente) → valutazione accodata e marcatore a true', async (step) => {
      mockWindowState(step, undefined)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      expect(notifyChangeWindowChanged).toHaveBeenCalledWith('tenant-1', 'chg-1', 'change.window_entered')
      expect(setCalls()).toHaveLength(1)
      expect(setCalls()[0]![1]).toEqual({ changeId: 'chg-1', tenantId: 'tenant-1', inWindow: true })
    })

    it('uscita dalla finestra (marcatore true, passo review) → valutazione accodata e marcatore a false', async () => {
      mockWindowState('review', true)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      expect(notifyChangeWindowChanged).toHaveBeenCalledWith('tenant-1', 'chg-1', 'change.window_left')
      expect(setCalls()[0]![1]).toEqual({ changeId: 'chg-1', tenantId: 'tenant-1', inWindow: false })
    })

    it('stato invariato (dentro la finestra e già segnalato, o fuori e mai segnalato) → nessuna valutazione, nessuna scrittura', async () => {
      mockWindowState('deployment', true)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      mockWindowState('review', false)
      await evaluateAutoTransitions(mockSession, 'chg-1', ctx)
      expect(notifyChangeWindowChanged).not.toHaveBeenCalled()
      expect(setCalls()).toHaveLength(0)
    })

    it('coda dei servizi giù: notifyChangeWindowChanged non lancia mai, la transizione resta valida', async () => {
      mockWindowState('deployment', false)
      vi.mocked(notifyChangeWindowChanged).mockResolvedValueOnce(0)
      await expect(evaluateAutoTransitions(mockSession, 'chg-1', ctx)).resolves.toBeUndefined()
      expect(notifyChangeWindowChanged).toHaveBeenCalledTimes(1)
    })
  })
})

// ── Ondata 4 · A4-2/A4-3: change ↔ problem ↔ incident per SCOPO e CATEGORIA ───

/**
 * Il tenant ha rinominato i passi di change, problem e incident. Con il codice
 * di prima (`changeStep === 'deployment'`, `problemStep === 'change_requested'`,
 * `toStepName: 'resolved'`) nessuna di queste sincronizzazioni scattava: il
 * problem restava per sempre ad aspettare una change già rilasciata.
 *
 * Il nucleo `lib/workflowHelpers.ts` non è mockato: la sessione risponde alla
 * sua query, per entity_type.
 */
describe('sincronizzazione con problem e incident su workflow rinominati (A4-2/A4-3)', () => {
  const rec = (m: Record<string, unknown>) => ({ get: (k: string) => (k in m ? m[k] : null) })
  const STEPS: Record<string, Array<[string, string | null, string, number]>> = {
    // nome, scopo, categoria, ordine
    change:  [['valutazione', 'assessment', 'active', 1], ['cab_settimanale', 'approval', 'waiting', 2],
              ['in_calendario', 'scheduled', 'waiting', 3], ['rilascio_notturno', 'implementation', 'active', 4],
              ['verifica', 'review', 'active', 5], ['archiviata', null, 'closed', 6]],
    problem: [['analisi', 'investigation', 'active', 1], ['attesa_change', 'change_requested', 'waiting', 2],
              ['change_in_corso', 'change_in_progress', 'waiting', 3], ['risolto', null, 'resolved', 4]],
    incident:[['nuovo', null, 'active', 1], ['lavorazione', null, 'active', 2], ['sistemato', null, 'resolved', 3]],
  }
  const session = {
    executeRead: (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<{ records: unknown[] }> }) => unknown) =>
      fn({ run: async (_c: string, p: Record<string, unknown>) => ({
        records: (STEPS[p['entityType'] as string] ?? []).map(([name, purpose, category, order]) => rec({
          name, purpose, category, stepOrder: order,
          isInitial: order === 1, isTerminal: category === 'closed', isOpen: category !== 'closed',
        })),
      }) }),
  } as never

  /** `changeStep` per la change, e una riga di problem/incident collegato. */
  function mockDb2(changeStep: string, linked: { problemStep?: string; incidentStep?: string }) {
    vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, q: string) => {
      if (q.includes('c.service_window AS notified')) return { step: changeStep, notified: false }
      if (q.includes('HAS_WORKFLOW')) return { instanceId: 'wi-1', step: changeStep, tenantId: 'tenant-1', entityProps: { id: 'chg-1' } }
      return { pending: 1 }
    }) as never)
    vi.mocked(runQuery).mockImplementation((async (_s: unknown, q: string) => {
      if (q.includes('TRANSITIONS_TO')) return []
      if (q.includes('(p:Problem')) return linked.problemStep ? [{ changeStep, instanceId: 'pw-1', problemStep: linked.problemStep }] : []
      if (q.includes('(i:Incident')) return linked.incidentStep ? [{ changeStep, code: 'CHG1', instanceId: 'iw-1', incidentStep: linked.incidentStep }] : []
      return []
    }) as never)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
    const { invalidateWorkflowCache } = await import('../../../../lib/workflowHelpers.js')
    invalidateWorkflowCache()
  })

  it('change nel passo di scopo implementation → il problem in «attesa_change» passa a «change_in_corso»', async () => {
    mockDb2('rilascio_notturno', { problemStep: 'attesa_change' })
    await evaluateAutoTransitions(session, 'chg-1', ctx)
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      session, expect.objectContaining({ instanceId: 'pw-1', toStepName: 'change_in_corso' }), expect.anything())
  })

  it('change nel passo di categoria closed → problem risolto (categoria resolved) e incident risolto', async () => {
    mockDb2('archiviata', { problemStep: 'change_in_corso', incidentStep: 'lavorazione' })
    await evaluateAutoTransitions(session, 'chg-1', ctx)
    const targets = vi.mocked(workflowEngine.transition).mock.calls.map((c) => (c[1] as { instanceId: string; toStepName: string }))
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ instanceId: 'pw-1', toStepName: 'risolto' }),
      expect.objectContaining({ instanceId: 'iw-1', toStepName: 'sistemato' }),
    ]))
  })

  it('incident in un passo non lavorabile (categoria resolved) → nessun auto-resolve, e lo dice', async () => {
    mockDb2('archiviata', { incidentStep: 'sistemato' })
    await evaluateAutoTransitions(session, 'chg-1', ctx)
    expect(vi.mocked(workflowEngine.transition).mock.calls.filter((c) => (c[1] as { instanceId: string }).instanceId === 'iw-1')).toHaveLength(0)
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ incidentStep: 'sistemato' }), expect.stringContaining('nessun auto-resolve'))
  })

  it('change in un passo che non è né rilascio né chiusura → nessuna sincronizzazione', async () => {
    mockDb2('cab_settimanale', { problemStep: 'attesa_change', incidentStep: 'lavorazione' })
    await evaluateAutoTransitions(session, 'chg-1', ctx)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })
})
