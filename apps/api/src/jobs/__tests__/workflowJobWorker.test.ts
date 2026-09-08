/**
 * workflow-jobs / notification-jobs processors (jobs/workflowJobWorker.ts):
 *  - auto_close dispatches per entity type: incident → incidentService.closeIncident
 *    with the tenant; problem/change/… → ValidationError BEFORE the transition;
 *  - webhook_retry goes through the SSRF guard (private/loopback → throw, no fetch);
 *  - trigger_timer: a failed action fails the job (no "green job, zero actions");
 *  - timer_wait: a failed transition fails the job.
 * BullMQ is mocked through lib/bullmq.ts, the processor is captured from createWorker.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const queueAdd = vi.fn().mockResolvedValue(undefined)

vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => {
    processors.set(name, processor)
    return { name, opts, on: vi.fn(), close: vi.fn() }
  }),
  getQueue: vi.fn(() => ({ add: queueAdd })),
}))

interface Rec { get(k: string): unknown }
type Tx = { run: (q: string, p?: Record<string, unknown>) => Promise<{ records: Rec[] }> }
type Work = (tx: Tx) => Promise<unknown>
const rec = (row: Record<string, unknown>): Rec => ({ get: (k) => row[k] ?? null })

interface FakeSession {
  mode: string | undefined
  reads: Array<{ q: string; p?: Record<string, unknown> }>
  executeRead: (work: Work) => Promise<unknown>
  executeWrite: (work: Work) => Promise<unknown>
  close: ReturnType<typeof vi.fn>
}
const sessions: FakeSession[] = []
let readRows: Record<string, unknown>[][] = []

function makeSession(mode?: string): FakeSession {
  let i = 0
  const s: FakeSession = {
    mode,
    reads: [],
    executeRead: async (work) => work({ run: async (q, p) => { s.reads.push({ q, p }); return { records: (readRows[i++] ?? []).map(rec) } } }),
    executeWrite: async (work) => work({ run: async () => ({ records: [] }) }),
    close: vi.fn().mockResolvedValue(undefined),
  }
  sessions.push(s)
  return s
}

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn((_db?: string, mode?: string) => makeSession(mode)),
  runQuery: (...args: unknown[]) => runQuery(...args),
}))

const transition = vi.fn()
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { transition: (...a: unknown[]) => transition(...a) } }))

const closeIncident = vi.fn()
vi.mock('../../services/incidentService.js', () => ({ closeIncident: (...a: unknown[]) => closeIncident(...a) }))

const getWorkflowSteps = vi.fn()
const isEntityOpen = vi.fn()
vi.mock('../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: (...a: unknown[]) => getWorkflowSteps(...a),
  isEntityOpen:     (...a: unknown[]) => isEntityOpen(...a),
}))

const executeActions = vi.fn()
vi.mock('../../lib/actionExecutor.js', () => ({
  executeActions: (...a: unknown[]) => executeActions(...a),
  parseActions:   (raw: string | null) => (raw ? JSON.parse(raw) as unknown[] : []),
}))

const evaluateConditions = vi.fn(() => true)
vi.mock('../../lib/conditionEvaluator.js', () => ({
  parseConditions:    () => [],
  evaluateConditions: () => evaluateConditions(),
}))

const logWarn = vi.fn()
const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterAll(() => { vi.unstubAllGlobals() })

const { startWorkflowJobWorker, startNotificationJobWorker, scheduleEscalationCheck, WORKFLOW_JOBS_QUEUE, NOTIFICATION_JOBS_QUEUE } = await import('../workflowJobWorker.js')
const { ValidationError } = await import('../../lib/errors.js')

startWorkflowJobWorker()
startNotificationJobWorker()
const workflowProcessor = processors.get(WORKFLOW_JOBS_QUEUE)!
const notificationProcessor = processors.get(NOTIFICATION_JOBS_QUEUE)!

const job = (name: string, data: Record<string, unknown>): Job =>
  ({ name, data, id: 'j-1', attemptsMade: 0, opts: {} } as unknown as Job)

const STEPS = [
  { name: 'resolved',  isInitial: false, isTerminal: false, isOpen: false, category: 'resolved', stepOrder: 5 },
  { name: 'cancelled', isInitial: false, isTerminal: true,  isOpen: false, category: null,       stepOrder: 6 },
  { name: 'closed',    isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',   stepOrder: 7 },
]

beforeEach(() => {
  vi.clearAllMocks()
  sessions.length = 0
  readRows = []
  transition.mockResolvedValue({ success: true })
  closeIncident.mockResolvedValue(undefined)
  getWorkflowSteps.mockResolvedValue(STEPS)
  evaluateConditions.mockReturnValue(true)
})

// ── auto_close ───────────────────────────────────────────────────────────────

describe('workflow-jobs: auto_close', () => {
  const data = { instanceId: 'wi-1', entityId: 'inc-1', tenantId: 't1', job: 'auto_close' }

  it('incident → transizione allo step category=closed e closeIncident con il tenant', async () => {
    readRows = [[{ entityType: 'incident' }]]

    await expect(workflowProcessor(job('auto_close', data))).resolves.toBeUndefined()

    const session = sessions[0]!
    expect(session.mode).toBe('WRITE')
    expect(session.reads[0]!.p).toEqual({ instanceId: 'wi-1', tenantId: 't1' })
    expect(session.reads[0]!.q).toContain('WorkflowInstance {id: $instanceId, tenant_id: $tenantId}')
    expect(getWorkflowSteps).toHaveBeenCalledWith(session, 't1', 'incident')
    expect(transition).toHaveBeenCalledWith(
      session,
      { instanceId: 'wi-1', toStepName: 'closed', triggeredBy: 'system', triggerType: 'automatic' },
      { userId: 'system', entityData: {} },
    )
    expect(closeIncident).toHaveBeenCalledWith('inc-1', { tenantId: 't1', userId: 'system' })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('senza step category=closed usa il primo terminale', async () => {
    readRows = [[{ entityType: 'incident' }]]
    getWorkflowSteps.mockResolvedValue(STEPS.filter((s) => s.name !== 'closed'))

    await workflowProcessor(job('auto_close', data))

    expect(transition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toStepName: 'cancelled' }), expect.anything())
  })

  it('problem → ValidationError propagata PRIMA della transizione, closeIncident mai chiamato', async () => {
    readRows = [[{ entityType: 'problem' }]]

    const err = await workflowProcessor(job('auto_close', { ...data, entityId: 'prb-1' })).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toMatch(/auto_close is not implemented for entity type "problem" \(entity prb-1\)/)
    expect(transition).not.toHaveBeenCalled()
    expect(closeIncident).not.toHaveBeenCalled()
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it.each(['change', 'service_request'])('%s → ValidationError (nessun servizio di chiusura)', async (entityType) => {
    readRows = [[{ entityType }]]
    await expect(workflowProcessor(job('auto_close', data))).rejects.toBeInstanceOf(ValidationError)
    expect(transition).not.toHaveBeenCalled()
  })

  it('entity_type sconosciuto → ValidationError "unknown entity type"', async () => {
    readRows = [[{ entityType: 'widget' }]]
    await expect(workflowProcessor(job('auto_close', data))).rejects.toThrow(/unknown entity type "widget"/)
    expect(transition).not.toHaveBeenCalled()
  })

  it('transizione fallita (success:false) → il job rigetta con l\'errore del motore', async () => {
    readRows = [[{ entityType: 'incident' }]]
    transition.mockResolvedValue({ success: false, error: 'guard failed' })

    await expect(workflowProcessor(job('auto_close', data))).rejects.toThrow(/auto_close transition failed for inc-1: guard failed/)
    expect(closeIncident).not.toHaveBeenCalled()
  })

  it('closeIncident che fallisce → il job rigetta (l\'evento closed non viene perso in silenzio)', async () => {
    readRows = [[{ entityType: 'incident' }]]
    closeIncident.mockRejectedValue(new Error('publish failed'))
    await expect(workflowProcessor(job('auto_close', data))).rejects.toThrow('publish failed')
  })

  it('istanza workflow non trovata → no-op loggato (warn), nessuna transizione', async () => {
    readRows = [[]]
    await expect(workflowProcessor(job('auto_close', data))).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'wi-1' }), expect.stringContaining('workflow instance not found'))
    expect(transition).not.toHaveBeenCalled()
    expect(closeIncident).not.toHaveBeenCalled()
  })
})

// ── webhook_retry ────────────────────────────────────────────────────────────

describe('workflow-jobs: webhook_retry', () => {
  const base = { type: 'webhook_retry', method: 'POST', headers: { 'X-Sig': 'abc' }, payload: '{"a":1}', attempt: 2, tenantId: 't1', entityId: 'inc-1' }

  it.each([
    ['https://127.0.0.1/hook',  /SSRF/],
    ['https://10.0.0.5/hook',   /SSRF/],
    ['https://[::1]/hook',      /SSRF/],
    ['https://localhost/hook',  /loopback/],
    ['http://8.8.8.8/hook',     /must use https/],
    ['ftp://example.com/hook',  /scheme/],
  ])('URL bloccato %s → ValidationError, nessuna fetch', async (url, msg) => {
    const p = workflowProcessor(job('webhook_retry', { ...base, url }))
    await expect(p).rejects.toBeInstanceOf(ValidationError)
    await expect(workflowProcessor(job('webhook_retry', { ...base, url }))).rejects.toThrow(msg)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('URL pubblico → fetch con metodo/header/body del job; 2xx completa', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    await expect(workflowProcessor(job('webhook_retry', { ...base, url: 'https://8.8.8.8/hook' }))).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://8.8.8.8/hook')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Sig': 'abc' })
    expect(init.body).toBe('{"a":1}')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('GET non manda body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 })
    await workflowProcessor(job('webhook_retry', { ...base, url: 'https://8.8.8.8/hook', method: 'GET' }))
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeUndefined()
  })

  it('risposta non-2xx → il job rigetta (BullMQ ritenta)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 })
    await expect(workflowProcessor(job('webhook_retry', { ...base, url: 'https://8.8.8.8/hook' }))).rejects.toThrow('HTTP 503')
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ host: '8.8.8.8', attempt: 2 }), expect.stringContaining('attempt failed'))
  })

  it('errore di rete → rilanciato', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    await expect(workflowProcessor(job('webhook_retry', { ...base, url: 'https://8.8.8.8/hook' }))).rejects.toThrow('ECONNRESET')
  })
})

// ── trigger_timer ────────────────────────────────────────────────────────────

describe('workflow-jobs: trigger_timer', () => {
  const data = { triggerId: 'tr-1', entityType: 'incident', entityId: 'inc-1', tenantId: 't1' }
  const trigger = { props: { id: 'tr-1', name: 'Escalate stale', conditions: null, actions: '[{"type":"set_priority","params":{"value":"high"}}]' } }
  const entity = { props: { id: 'inc-1', status: 'new' }, assignedTo: 'u-9', assignedTeam: null }

  it('azione che fallisce → il job rigetta con azione/trigger/entità nel messaggio', async () => {
    runQuery.mockResolvedValueOnce([trigger]).mockResolvedValueOnce([entity]).mockResolvedValueOnce([])
    executeActions.mockResolvedValue([{ action: 'set_priority', success: false, error: 'field locked' }])

    await expect(workflowProcessor(job('trigger_timer', data))).rejects.toThrow(
      '[trigger_timer] action "set_priority" failed for trigger tr-1 on inc-1: field locked (0/1 actions ran)',
    )
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it('tutte le azioni ok → completa; contesto di esecuzione con tenant, system, source=trigger', async () => {
    runQuery.mockResolvedValueOnce([trigger]).mockResolvedValueOnce([entity]).mockResolvedValueOnce([])
    executeActions.mockResolvedValue([{ action: 'set_priority', success: true }])

    await expect(workflowProcessor(job('trigger_timer', data))).resolves.toBeUndefined()

    expect(executeActions).toHaveBeenCalledWith(
      [{ type: 'set_priority', params: { value: 'high' } }],
      {
        tenantId: 't1', userId: 'system', entityId: 'inc-1', entityType: 'incident',
        entity: { id: 'inc-1', status: 'new', assigned_to: 'u-9', assigned_team: null },
        source: 'trigger', sourceName: 'Escalate stale',
      },
    )
    // le query sono scopate per tenant
    expect(runQuery.mock.calls[0]![2]).toEqual({ triggerId: 'tr-1', tenantId: 't1' })
    expect(runQuery.mock.calls[1]![2]).toEqual({ entityId: 'inc-1', tenantId: 't1' })
    expect(runQuery.mock.calls[2]![1]).toMatch(/SET t\.execution_count = coalesce\(t\.execution_count, 0\) \+ 1/)
  })

  it('trigger non trovato/disabilitato → skip senza eseguire azioni', async () => {
    runQuery.mockResolvedValueOnce([])
    await expect(workflowProcessor(job('trigger_timer', data))).resolves.toBeUndefined()
    expect(executeActions).not.toHaveBeenCalled()
    expect(runQuery).toHaveBeenCalledTimes(1)
  })

  it('condizioni non più vere → skip, nessuna azione né conteggio', async () => {
    runQuery.mockResolvedValueOnce([trigger]).mockResolvedValueOnce([entity])
    evaluateConditions.mockReturnValue(false)
    await expect(workflowProcessor(job('trigger_timer', data))).resolves.toBeUndefined()
    expect(executeActions).not.toHaveBeenCalled()
    expect(runQuery).toHaveBeenCalledTimes(2)
  })

  it('executeActions che lancia → il job rigetta', async () => {
    runQuery.mockResolvedValueOnce([trigger]).mockResolvedValueOnce([entity])
    executeActions.mockRejectedValue(new Error('script engine down'))
    await expect(workflowProcessor(job('trigger_timer', data))).rejects.toThrow('script engine down')
  })
})

// ── unknown job ──────────────────────────────────────────────────────────────

describe('workflow-jobs: job sconosciuto', () => {
  it('un job con nome sconosciuto dovrebbe fallire esplicitamente — BUG: workflowJobWorker.ts:230-231 logga un warn e completa il job (fallback silenzioso)', async () => {
    await expect(workflowProcessor(job('not_a_job', { instanceId: 'wi', entityId: 'e', tenantId: 't', job: 'x' }))).rejects.toThrow()
  })

})

// ── notification-jobs ────────────────────────────────────────────────────────

describe('notification-jobs', () => {
  it('timer_wait → transizione automatica con triggeredBy=timer; success:false → il job rigetta', async () => {
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-2', toStep: 'closed', tenantId: 't1' }))).resolves.toBeUndefined()
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'WRITE' }),
      { instanceId: 'wi-2', toStepName: 'closed', triggeredBy: 'timer', triggerType: 'automatic' },
      { userId: 'system', entityData: {} },
    )

    transition.mockResolvedValue({ success: false, error: 'no such step' })
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-2', toStep: 'closed', tenantId: 't1' })))
      .rejects.toThrow('timer_wait transition failed for instance wi-2 → closed: no such step')
    expect(sessions.every((s) => s.close.mock.calls.length === 1)).toBe(true)
  })

  it('escalation_check interroga isEntityOpen con tenant su sessione READ', async () => {
    isEntityOpen.mockResolvedValue(true)
    await expect(notificationProcessor(job('escalation_check', { incidentId: 'inc-1', tenantId: 't1', ruleId: 'r-1' }))).resolves.toBeUndefined()
    expect(isEntityOpen).toHaveBeenCalledWith(expect.objectContaining({ mode: 'READ' }), 'inc-1', 't1')
  })

  it('job sconosciuto dovrebbe fallire — BUG: workflowJobWorker.ts:284-285 warn + completamento silenzioso', async () => {
    await expect(notificationProcessor(job('nope', {}))).rejects.toThrow()
  })

  it('scheduleEscalationCheck accoda con delay in ms e jobId deterministico (idempotente per incident+rule)', async () => {
    await scheduleEscalationCheck('inc-1', 't1', 'rule-1', 15)
    expect(queueAdd).toHaveBeenCalledWith(
      'escalation_check',
      { incidentId: 'inc-1', tenantId: 't1', ruleId: 'rule-1' },
      { delay: 15 * 60_000, jobId: 'escalation:inc-1:rule-1', removeOnComplete: true },
    )
  })

  it('scheduleEscalationCheck propaga l\'errore di enqueue (Redis giù non è un warning)', async () => {
    queueAdd.mockRejectedValueOnce(new Error('redis down'))
    await expect(scheduleEscalationCheck('inc-1', 't1', 'rule-1', 1)).rejects.toThrow('redis down')
  })
})
