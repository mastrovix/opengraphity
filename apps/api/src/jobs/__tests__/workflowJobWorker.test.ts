/**
 * workflow-jobs / notification-jobs processors (jobs/workflowJobWorker.ts):
 *  - step_deadlines runs the step-deadline sweep (the old auto_close is a no-op);
 *  - webhook_retry goes through the SSRF guard (private/loopback → throw, no fetch);
 *  - trigger_timer: a failed action fails the job (no "green job, zero actions");
 *  - timer_wait: moves through the pipeline of the transitions (wave 7 · B1);
 *    an error that may be transient fails the job (a refusal is in the .more file).
 * BullMQ is mocked through lib/bullmq.ts, the processor is captured from createTenantWorkers.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const queueAdd = vi.fn().mockResolvedValue(undefined)
const upsertScheduler = vi.fn().mockResolvedValue(undefined)
const removeScheduler = vi.fn().mockResolvedValue(true)

const fakeQueue = { add: queueAdd, upsertJobScheduler: upsertScheduler, removeJobScheduler: removeScheduler }
vi.mock('../../lib/bullmq.js', () => ({
  createTenantWorkers: vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => {
    processors.set(name, processor)
    return { name, opts, close: vi.fn() }
  }),
  getTenantQueue: vi.fn(() => fakeQueue),
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

vi.mock('@opengraphity/workflow', () => ({ WAIT_EXIT_TRIGGERS: ['automatic', 'timer'] }))
const transition = vi.fn()
vi.mock('../../services/ticketTransition.js', () => ({ transitionTicket: (...a: unknown[]) => transition(...a) }))

const closeIncident = vi.fn()
vi.mock('../../services/incidentService.js', () => ({ closeIncident: (...a: unknown[]) => closeIncident(...a) }))

const getWorkflowSteps = vi.fn()
const isEntityOpen = vi.fn()
vi.mock('../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps: (...a: unknown[]) => getWorkflowSteps(...a),
  isEntityOpen:     (...a: unknown[]) => isEntityOpen(...a),
}))

const runStepDeadlineSweep = vi.fn()
vi.mock('../../lib/stepDeadlines.js', () => ({
  runStepDeadlineSweep: (...a: unknown[]) => runStepDeadlineSweep(...a),
  DEADLINE_REASON: { change_window: 'approval_gate', request_approval: 'request_approval', named_approval: 'approval_request', required_fields: 'required_fields', step_metadata: 'step_metadata', type_permission: 'type_permission', workflow: 'transition' },
}))

const executeActions = vi.fn()
const runEscalationCheck = vi.fn()
vi.mock('../../lib/notificationEscalation.js', () => ({ runEscalationCheck: (...a: unknown[]) => runEscalationCheck(...a) }))
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

const { startWorkflowJobWorker, startNotificationJobWorker, scheduleEscalationCheck, scheduleWorkflowSweeps, WORKFLOW_JOBS_QUEUE, NOTIFICATION_JOBS_QUEUE, STEP_DEADLINES_JOB } = await import('../workflowJobWorker.js')
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
  transition.mockResolvedValue({ moved: true, actionErrors: [] })
  closeIncident.mockResolvedValue(undefined)
  getWorkflowSteps.mockResolvedValue(STEPS)
  evaluateConditions.mockReturnValue(true)
})

// ── scadenze dei passi ───────────────────────────────────────────────────────

// Verifica «Cosa resta cablato», ondata 3: la chiusura automatica è la scadenza
// del passo. Il job `auto_close` non esiste più; quelli già in coda prima
// dell'aggiornamento arrivano e non fanno nulla, perché lo stesso ticket lo
// sposta la passata.
describe('workflow-jobs: scadenze dei passi', () => {
  it('step_deadlines → una passata, con il riepilogo nel log se ha fatto qualcosa', async () => {
    runStepDeadlineSweep.mockResolvedValue({ candidates: 3, moved: 1, refused: 0, failed: 0, notDue: 2 })
    await expect(workflowProcessor(job(STEP_DEADLINES_JOB, { instanceId: '', entityId: '', tenantId: 't1', job: STEP_DEADLINES_JOB }))).resolves.toBeUndefined()
    // The sweep of the job's tenant: it runs in that tenant's own queue.
    expect(runStepDeadlineSweep).toHaveBeenCalledWith('t1')
    expect(transition).not.toHaveBeenCalled()
  })

  it('la passata si registra ripetuta ogni minuto, con un id fisso, nella coda del tenant e con il tenant nel job', async () => {
    await scheduleWorkflowSweeps(fakeQueue as never, 't1')
    expect(upsertScheduler).toHaveBeenCalledWith('workflow-step-deadlines', { every: 60_000 }, expect.objectContaining({ name: STEP_DEADLINES_JOB, data: expect.objectContaining({ tenantId: 't1' }) }))
  })

  it('un auto_close di prima dell\'ondata 3 non transisce e non chiude niente', async () => {
    await expect(workflowProcessor(job('auto_close', { instanceId: 'wi-1', entityId: 'inc-1', tenantId: 't1', job: 'auto_close' }))).resolves.toBeUndefined()
    expect(transition).not.toHaveBeenCalled()
    expect(closeIncident).not.toHaveBeenCalled()
    expect(runStepDeadlineSweep).not.toHaveBeenCalled()
  })

  it('una passata che lancia fa fallire il job, invece di sparire', async () => {
    runStepDeadlineSweep.mockRejectedValue(new Error('neo4j giù'))
    await expect(workflowProcessor(job(STEP_DEADLINES_JOB, { instanceId: '', entityId: '', tenantId: 't1', job: STEP_DEADLINES_JOB }))).rejects.toThrow('neo4j giù')
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

  it('tutte le azioni ok → completa; contesto di esecuzione con tenant, attore automation, source=trigger', async () => {
    runQuery.mockResolvedValueOnce([trigger]).mockResolvedValueOnce([entity]).mockResolvedValueOnce([])
    executeActions.mockResolvedValue([{ action: 'set_priority', success: true }])

    await expect(workflowProcessor(job('trigger_timer', data))).resolves.toBeUndefined()

    expect(executeActions).toHaveBeenCalledWith(
      [{ type: 'set_priority', params: { value: 'high' } }],
      {
        tenantId: 't1', userId: 'automation', entityId: 'inc-1', entityType: 'incident',
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
  // Ondata 8 · B-18: il passo di arrivo si risolve al momento dell'ESECUZIONE,
  // leggendo l'arco automatico che esce dal passo dove l'istanza si trova
  // adesso. Il nome messo nel payload quando il timer è partito (ore o giorni
  // prima) è solo un'indicazione: se in mezzo l'amministratore ha cambiato il
  // workflow, quel nome punta al vuoto e la transizione falliva senza che
  // nessuno lo vedesse (un tentativo solo, poi il job resta nei falliti).
  it('timer_wait → risolve il passo di arrivo ADESSO e transiziona con triggeredBy=timer', async () => {
    readRows = [[{ currentStep: 'resolved', toStep: 'closed' }]]
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-2', toStep: 'closed', tenantId: 't1' }))).resolves.toBeUndefined()
    const s = sessions.at(-1)!
    expect(s.mode).toBe('WRITE')
    expect(s.reads[0]!.p).toEqual({ instanceId: 'wi-2', tenantId: 't1', exitTriggers: ['automatic', 'timer'] })
    // Rinegoziato (revisione · B·M-4): l'arco che conclude un'attesa può essere
    // marcato `automatic` O `timer` — il secondo era la scelta ovvia nella
    // tendina e non veniva percorso da nessuno.
    expect(s.reads[0]!.q).toContain('tr.trigger IN $exitTriggers')
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ mode: 'WRITE' }), {
      tenantId: 't1', instanceId: 'wi-2', toStep: 'closed', triggerType: 'automatic',
      actor: { kind: 'system', path: 'timer', userId: 'timer' },
    })
  })

  it('timer_wait: il workflow è cambiato dopo la partenza → si usa il passo di ADESSO (warn), non quello nel payload', async () => {
    readRows = [[{ currentStep: 'risolto', toStep: 'archiviato' }]]
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-2', toStep: 'closed', tenantId: 't1' }))).resolves.toBeUndefined()
    expect(transition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toStep: 'archiviato' }))
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledToStep: 'closed', toStep: 'archiviato', currentStep: 'risolto' }),
      expect.stringContaining('il passo di arrivo è cambiato'),
    )
  })

  it('timer_wait: nessun arco automatico dal passo corrente → il job rigetta nominando il passo (niente attesa infinita muta)', async () => {
    readRows = [[{ currentStep: 'in_attesa', toStep: null }]]
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-2', toStep: 'closed', tenantId: 't1' })))
      .rejects.toThrow(/no transition with an "automatic" or "timer" trigger leaves step "in_attesa"/)
    expect(transition).not.toHaveBeenCalled()
  })

  it('timer_wait: istanza scomparsa → il job rigetta; an error that may be transient → il job rigetta con il suo messaggio', async () => {
    readRows = [[]]
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-2', toStep: 'closed', tenantId: 't1' })))
      .rejects.toThrow(/instance wi-2 of tenant t1 no longer exists/)

    readRows = [[{ currentStep: 'resolved', toStep: 'closed' }]]
    transition.mockResolvedValue({ moved: false, refusal: { guard: 'workflow', final: false, message: 'no such step' } })
    await expect(notificationProcessor(job('timer_wait', { instanceId: 'wi-2', toStep: 'closed', tenantId: 't1' })))
      .rejects.toThrow('timer_wait transition failed for instance wi-2 → closed: no such step')
    expect(sessions.every((s) => s.close.mock.calls.length === 1)).toBe(true)
  })

  // NT-8: prima questo ramo scriveva un log e basta; ora esegue il controllo vero.
  it('escalation_check esegue il controllo dell\'escalation per incident, tenant e regola', async () => {
    runEscalationCheck.mockResolvedValue('escalated')
    await expect(notificationProcessor(job('escalation_check', { incidentId: 'inc-1', tenantId: 't1', ruleId: 'r-1' }))).resolves.toBeUndefined()
    expect(runEscalationCheck).toHaveBeenCalledWith('t1', 'inc-1', 'r-1')
  })

  it('job sconosciuto dovrebbe fallire — BUG: workflowJobWorker.ts:284-285 warn + completamento silenzioso', async () => {
    await expect(notificationProcessor(job('nope', {}))).rejects.toThrow()
  })

  it('scheduleEscalationCheck accoda con delay in ms e jobId deterministico (idempotente per incident+rule)', async () => {
    await scheduleEscalationCheck('inc-1', 't1', 'rule-1', 15)
    expect(queueAdd).toHaveBeenCalledWith(
      'escalation_check',
      { incidentId: 'inc-1', tenantId: 't1', ruleId: 'rule-1' },
      { delay: 15 * 60_000, jobId: 'escalation-inc-1-rule-1', removeOnComplete: true },
    )
  })

  it('scheduleEscalationCheck propaga l\'errore di enqueue (Redis giù non è un warning)', async () => {
    queueAdd.mockRejectedValueOnce(new Error('redis down'))
    await expect(scheduleEscalationCheck('inc-1', 't1', 'rule-1', 1)).rejects.toThrow('redis down')
  })
})
