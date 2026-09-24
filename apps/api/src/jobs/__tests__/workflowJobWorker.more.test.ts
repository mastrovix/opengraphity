/**
 * workflow-jobs / notification-jobs processors: the branches the first test
 * file does not reach.
 *
 * Why these behaviours matter:
 *  - webhook_retry re-reads the HEADERS from the workflow step (a customer
 *    token must not sit in clear in Redis). The right action must be picked
 *    (by index, or the first call_webhook), a vanished step or corrupt JSON
 *    must not block the retry, and the read must be tenant-scoped.
 *  - The OLA sweep must FAIL the job when a contract could not be evaluated:
 *    a green job with a silent failure means an OLA alert that never arrives.
 *  - timer_wait on a change must pass the approval gate, and a refusal (by the
 *    gate or by a transition guard) must be written on the step execution so
 *    the diagnostics list the ticket — not a thrown error that exhausts
 *    retries and leaves the ticket waiting forever without a signal.
 *  - The three periodic sweeps must be registered with fixed ids, and an
 *    exhausted webhook retry must be logged loudly.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const workerOpts = new Map<string, { onFailed?: (job: unknown, err: Error) => void }>()
const upsertScheduler = vi.fn().mockResolvedValue(undefined)

vi.mock('../../lib/bullmq.js', () => ({
  createTenantWorkers: vi.fn((name: string, processor: AnyProcessor, opts?: { onFailed?: (job: unknown, err: Error) => void }) => {
    processors.set(name, processor)
    workerOpts.set(name, opts ?? {})
    return { name }
  }),
  getTenantQueue: vi.fn(() => ({ add: vi.fn(), upsertJobScheduler: upsertScheduler })),
}))

interface Rec { get(k: string): unknown }
const rec = (row: Record<string, unknown>): Rec => ({ get: (k) => row[k] ?? null })
let readRows: Record<string, unknown>[] = []
const sessionClose = vi.fn().mockResolvedValue(undefined)
const makeSession = (mode?: string) => ({
  mode,
  executeRead: async (work: (tx: { run: () => Promise<{ records: Rec[] }> }) => Promise<unknown>) =>
    work({ run: async () => ({ records: readRows.map(rec) }) }),
  close: sessionClose,
})

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn((_db?: string, mode?: string) => makeSession(mode)),
  runQuery: (...args: unknown[]) => runQuery(...args),
}))

const transition = vi.fn()
vi.mock('@opengraphity/workflow', () => ({ WAIT_EXIT_TRIGGERS: ['automatic', 'timer'], workflowEngine: { transition: (...a: unknown[]) => transition(...a) } }))

const runStepDeadlineSweep = vi.fn()
vi.mock('../../lib/stepDeadlines.js', () => ({ runStepDeadlineSweep: (...a: unknown[]) => runStepDeadlineSweep(...a) }))
const runOLASweep = vi.fn()
vi.mock('../../lib/olaSweep.js', () => ({ runOLASweep: (...a: unknown[]) => runOLASweep(...a) }))
const riprendiTransizioniDi = vi.fn()
vi.mock('../../lib/riprendiTransizioni.js', () => ({ riprendiTransizioniDi: (...a: unknown[]) => riprendiTransizioniDi(...a) }))
const automaticTransitionAllowed = vi.fn()
vi.mock('../../graphql/resolvers/change/windowGate.js', () => ({
  automaticTransitionAllowed: (...a: unknown[]) => automaticTransitionAllowed(...a),
}))
const loadAutomationEntity = vi.fn()
vi.mock('../../lib/automationEntity.js', () => ({ loadAutomationEntity: (...a: unknown[]) => loadAutomationEntity(...a) }))
const executeActions = vi.fn()
vi.mock('../../lib/actionExecutor.js', () => ({
  executeActions: (...a: unknown[]) => executeActions(...a),
  parseActions: () => [],
}))
vi.mock('../../lib/conditionEvaluator.js', () => ({ parseConditions: () => [], evaluateConditions: () => true }))

const logInfo = vi.fn()
const logWarn = vi.fn()
const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { info: logInfo, warn: logWarn, error: logError, debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
afterAll(() => { vi.unstubAllGlobals() })

const mod = await import('../workflowJobWorker.js')
mod.startWorkflowJobWorker()
mod.startNotificationJobWorker()
const workflowProcessor = processors.get(mod.WORKFLOW_JOBS_QUEUE)!
const notificationProcessor = processors.get(mod.NOTIFICATION_JOBS_QUEUE)!

const job = (name: string, data: Record<string, unknown>): Job =>
  ({ name, data, id: 'j-1', attemptsMade: 0, opts: {} } as unknown as Job)

beforeEach(() => {
  vi.clearAllMocks()
  readRows = []
  transition.mockResolvedValue({ success: true })
  fetchMock.mockResolvedValue({ ok: true, status: 200, body: { cancel: async () => undefined } })
})

// ── webhook_retry: headers re-read from the step ────────────────────────────

describe('webhook_retry reads the headers from the workflow step', () => {
  const base = { type: 'webhook_retry', url: 'https://8.8.8.8/hook', method: 'POST', payload: '{}', attempt: 1, tenantId: 't1', entityId: 'inc-1' }
  const sentHeaders = () => (fetchMock.mock.calls[0]![1] as RequestInit).headers

  it('picks the action by its index, over exit then enter actions, tenant-scoped', async () => {
    runQuery.mockResolvedValueOnce([{
      exitActions: JSON.stringify([{ type: 'call_webhook', params: { headers: { 'X-Exit': '1' } } }]),
      enterActions: JSON.stringify([{ type: 'call_webhook', params: { headers: { Authorization: 'Bearer s3cret' } } }]),
    }])
    await workflowProcessor(job('webhook_retry', { ...base, stepId: 'st-1', actionIndex: 1 }))
    expect(runQuery.mock.calls[0]![2]).toEqual({ stepId: 'st-1', tenantId: 't1' })
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' })
  })

  it('without an index, uses the first call_webhook action', async () => {
    runQuery.mockResolvedValueOnce([{
      exitActions: null,
      enterActions: JSON.stringify([{ type: 'set_field' }, { type: 'call_webhook', params: { headers: { 'X-Sig': 'abc' } } }]),
    }])
    await workflowProcessor(job('webhook_retry', { ...base, stepId: 'st-1' }))
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json', 'X-Sig': 'abc' })
  })

  it('an index that points at a non-webhook action, array headers or corrupt JSON: no headers, the retry still goes', async () => {
    runQuery.mockResolvedValueOnce([{ exitActions: '{not json', enterActions: JSON.stringify([{ type: 'set_field', params: { headers: { A: '1' } } }]) }])
    await workflowProcessor(job('webhook_retry', { ...base, stepId: 'st-1', actionIndex: 0 }))
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' })

    fetchMock.mockClear()
    runQuery.mockResolvedValueOnce([{ exitActions: null, enterActions: JSON.stringify([{ type: 'call_webhook', params: { headers: ['A'] } }]) }])
    await workflowProcessor(job('webhook_retry', { ...base, stepId: 'st-1' }))
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' })
  })

  it('a step that no longer exists: retry without headers, with a warning', async () => {
    runQuery.mockResolvedValueOnce([])
    await workflowProcessor(job('webhook_retry', { ...base, stepId: 'gone' }))
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' })
    expect(logWarn).toHaveBeenCalledWith({ stepId: 'gone' }, expect.stringContaining('no longer exists'))
    expect(sessionClose).toHaveBeenCalled()
  })

  it('a response body that cannot be discarded does not turn a delivered webhook into a failure', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, body: { cancel: async () => { throw new Error('stream locked') } } })
    await expect(workflowProcessor(job('webhook_retry', base))).resolves.toBeUndefined()
  })

  it('a receiver that never answers is aborted after 15 seconds and the attempt fails (BullMQ retries)', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
      }))
      const p = workflowProcessor(job('webhook_retry', base))
      const outcome = expect(p).rejects.toThrow('aborted')
      await vi.advanceTimersByTimeAsync(15_000)
      await outcome
    } finally {
      vi.useRealTimers()
    }
  })

  it('an old job without step and without headers sends only the content type', async () => {
    await workflowProcessor(job('webhook_retry', base))
    expect(runQuery).not.toHaveBeenCalled()
    expect(sentHeaders()).toEqual({ 'Content-Type': 'application/json' })
  })
})

// ── periodic sweeps ─────────────────────────────────────────────────────────

describe('periodic sweeps', () => {
  it('a step-deadline sweep that did nothing writes no log line', async () => {
    runStepDeadlineSweep.mockResolvedValue({ moved: 0, refused: 0, failed: 0 })
    await workflowProcessor(job(mod.STEP_DEADLINES_JOB, { tenantId: 't1' }))
    expect(logInfo).not.toHaveBeenCalled()
  })

  it('the OLA sweep logs what it did, and FAILS the job when a contract could not be evaluated', async () => {
    runOLASweep.mockResolvedValueOnce({ alerted: 0, failed: 0 })
    await expect(workflowProcessor(job(mod.OLA_SWEEP_JOB, { tenantId: 't1' }))).resolves.toBeUndefined()
    expect(runOLASweep).toHaveBeenCalledWith('t1')
    expect(logInfo).not.toHaveBeenCalled()

    runOLASweep.mockResolvedValueOnce({ alerted: 2, failed: 0 })
    await expect(workflowProcessor(job(mod.OLA_SWEEP_JOB, { tenantId: 't1' }))).resolves.toBeUndefined()
    expect(logInfo).toHaveBeenCalledWith({ tenantId: 't1', alerted: 2, failed: 0 }, '[workflow-jobs] OLA sweep')

    runOLASweep.mockResolvedValueOnce({ alerted: 1, failed: 3 })
    await expect(workflowProcessor(job(mod.OLA_SWEEP_JOB, { tenantId: 't1' }))).rejects.toThrow('OLA sweep: 3 contract(s) could not be evaluated')
  })

  it('the resume job runs the automatic-transition resume of the job\'s tenant, and says so only when it moved something', async () => {
    riprendiTransizioniDi.mockResolvedValue({ mosse: 0, candidate: 0, rifiutateDalVarco: 0 })
    await workflowProcessor(job(mod.RIPRESA_JOB, { tenantId: 't1' }))
    expect(riprendiTransizioniDi).toHaveBeenCalledWith('t1')
    expect(logInfo).not.toHaveBeenCalled()
    riprendiTransizioniDi.mockResolvedValue({ mosse: 2, candidate: 3, rifiutateDalVarco: 1 })
    await workflowProcessor(job(mod.RIPRESA_JOB, { tenantId: 't1' }))
    expect(logInfo).toHaveBeenCalledWith({ tenantId: 't1', mosse: 2, candidate: 3, rifiutateDalVarco: 1 }, 'automatic transitions resumed')
  })

  it('the OLA and resume sweeps are registered with fixed ids and their period, in the tenant\'s queue', async () => {
    await mod.scheduleWorkflowSweeps({ upsertJobScheduler: upsertScheduler } as never, 't1')
    expect(upsertScheduler).toHaveBeenCalledWith('workflow-ola-sweep', { every: 60_000 }, expect.objectContaining({ name: mod.OLA_SWEEP_JOB, data: expect.objectContaining({ tenantId: 't1' }) }))
    expect(upsertScheduler).toHaveBeenCalledWith('workflow-ripresa-transizioni', { every: 5 * 60_000 }, expect.objectContaining({ name: mod.RIPRESA_JOB }))
  })
})

// ── trigger_timer: entity gone ──────────────────────────────────────────────

describe('trigger_timer', () => {
  it('an entity that no longer exists is skipped without running actions', async () => {
    runQuery.mockResolvedValueOnce([{ props: { id: 'tr-1', name: 'x' } }])
    loadAutomationEntity.mockResolvedValue(null)
    await expect(workflowProcessor(job('trigger_timer', { triggerId: 'tr-1', entityType: 'incident', entityId: 'inc-1', tenantId: 't1' })))
      .resolves.toBeUndefined()
    expect(loadAutomationEntity).toHaveBeenCalledWith(expect.anything(), 't1', 'incident', 'inc-1')
    expect(executeActions).not.toHaveBeenCalled()
  })

  it('a failed action without an error message still names the action', async () => {
    runQuery.mockResolvedValueOnce([{ props: { id: 'tr-1', name: 'x' } }]).mockResolvedValueOnce([])
    loadAutomationEntity.mockResolvedValue({ id: 'inc-1' })
    executeActions.mockResolvedValue([{ action: 'set_field', success: false }])
    await expect(workflowProcessor(job('trigger_timer', { triggerId: 'tr-1', entityType: 'incident', entityId: 'inc-1', tenantId: 't1' })))
      .rejects.toThrow('action "set_field" failed for trigger tr-1 on inc-1: unknown error (0/1 actions ran)')
  })
})

// ── timer_wait on a change ──────────────────────────────────────────────────

describe('timer_wait', () => {
  const data = { instanceId: 'wi-1', toStep: 'implement', tenantId: 't1' }

  it('a change passes through the approval gate before moving', async () => {
    readRows = [{ currentStep: 'wait', toStep: 'implement', changeId: 'chg-1', changeType: 'normal' }]
    automaticTransitionAllowed.mockResolvedValue(true)
    await notificationProcessor(job('timer_wait', data))
    expect(automaticTransitionAllowed).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 't1', changeId: 'chg-1', changeType: 'normal', currentStep: 'wait', toStep: 'implement',
    }, 'timer_job')
    expect(transition).toHaveBeenCalledOnce()
  })

  it('a change without a type is still gated (empty type), not skipped', async () => {
    readRows = [{ currentStep: 'wait', toStep: 'implement', changeId: 'chg-1', changeType: null }]
    automaticTransitionAllowed.mockResolvedValue(true)
    await notificationProcessor(job('timer_wait', { instanceId: 'wi-1', tenantId: 't1' }))
    expect(automaticTransitionAllowed.mock.calls[0]![1]).toMatchObject({ changeType: '' })
  })

  it('refused by the gate: no transition, and the refusal is written on the open step execution', async () => {
    readRows = [{ currentStep: 'wait', toStep: 'implement', changeId: 'chg-1', changeType: 'normal' }]
    automaticTransitionAllowed.mockResolvedValue(false)
    await expect(notificationProcessor(job('timer_wait', data))).resolves.toBeUndefined()
    expect(transition).not.toHaveBeenCalled()
    const [, q, p] = runQuery.mock.calls[0]! as [unknown, string, Record<string, unknown>]
    expect(q).toContain("ex.deadline_reason     = 'approval_gate'")
    expect(q).toContain('ex.exited_at IS NULL')
    expect(p).toMatchObject({ instanceId: 'wi-1', tenantId: 't1', toStep: 'implement' })
    expect(sessionClose).toHaveBeenCalled()
  })

  it('refused by a transition guard: no throw (the timer would never re-arm), the refusal is recorded', async () => {
    readRows = [{ currentStep: 'wait', toStep: 'closed', changeId: null, changeType: null }]
    transition.mockResolvedValue({ success: false, refusedByCondition: 'tasks_done', error: 'open tasks' })
    await expect(notificationProcessor(job('timer_wait', data))).resolves.toBeUndefined()
    const [, q, p] = runQuery.mock.calls[0]! as [unknown, string, Record<string, unknown>]
    expect(q).toContain("ex.deadline_reason     = 'transition_condition'")
    expect(String(p['detail'])).toContain('"tasks_done"')
    expect(String(p['detail'])).toContain('(open tasks)')
  })

  it('a guard refusal without an error text still records the detail', async () => {
    readRows = [{ currentStep: 'wait', toStep: 'closed' }]
    transition.mockResolvedValue({ success: false, refusedByCondition: 'tasks_done' })
    await notificationProcessor(job('timer_wait', data))
    expect(String((runQuery.mock.calls[0]![2] as Record<string, unknown>)['detail'])).toMatch(/\(\)$/)
  })

  it('a failure that is not a guard refusal fails the job; without an error it says unknown', async () => {
    readRows = [{ currentStep: 'wait', toStep: 'closed' }]
    transition.mockResolvedValue({ success: false })
    await expect(notificationProcessor(job('timer_wait', data))).rejects.toThrow('closed: unknown')
  })

  it('no automatic edge and no scheduled step: the error says n/a', async () => {
    readRows = [{ currentStep: 'wait', toStep: null }]
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-1', tenantId: 't1' }))).rejects.toThrow(/towards "n\/a"/)
  })
})

// ── worker wiring ───────────────────────────────────────────────────────────

describe('worker failure hook', () => {
  const onFailed = () => workerOpts.get(mod.WORKFLOW_JOBS_QUEUE)!.onFailed!

  it('logs loudly when a webhook retry has exhausted its attempts, with the host only', () => {
    onFailed()({ name: 'webhook_retry', attemptsMade: 5, opts: { attempts: 5 }, data: { url: 'https://8.8.8.8/hook?token=abc' } }, new Error('HTTP 503'))
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'webhook_retry', attempts: 5, err: 'HTTP 503' }), '[webhook_retry] all retries exhausted')
    // The query string may carry a secret: it must not reach the log.
    expect(JSON.stringify(logError.mock.calls[0]![0])).not.toContain('token=abc')
  })

  it('stays quiet while attempts remain, for other jobs, and for a missing job', () => {
    onFailed()({ name: 'webhook_retry', attemptsMade: 1, opts: { attempts: 5 }, data: { url: 'https://8.8.8.8/' } }, new Error('x'))
    onFailed()({ name: 'trigger_timer', attemptsMade: 5, opts: { attempts: 5 }, data: {} }, new Error('x'))
    onFailed()(undefined, new Error('x'))
    expect(logError).not.toHaveBeenCalled()
  })

  it('without opts a job has ONE attempt: failing it once is exhaustion; a missing url is tolerated', () => {
    onFailed()({ name: 'webhook_retry', data: {} }, new Error('x'))
    // No attemptsMade reads as zero: nothing has been used up yet.
    expect(logError).not.toHaveBeenCalled()
    onFailed()({ name: 'webhook_retry', attemptsMade: 1, data: {} }, new Error('x'))
    expect(logError).toHaveBeenCalledOnce()
  })
})
