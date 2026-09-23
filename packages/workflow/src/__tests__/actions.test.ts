import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorkflowActionConfig, WorkflowInstance, ActionContext } from '../types.js'

// ── Mocks: real SSRF guard from @opengraphity/events, fake publish/Redis/BullMQ, stubbed fetch ──

const fake = vi.hoisted(() => {
  interface FakeQueue { name: string; opts: unknown; add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn> }
  const queues: FakeQueue[] = []
  const state = { existingJob: null as { remove: ReturnType<typeof vi.fn> } | null, addFails: false }
  class Queue implements FakeQueue {
    add = vi.fn(async () => { if (state.addFails) throw new Error('redis down'); return { id: 'job' } })
    close = vi.fn(async () => {})
    getJob = vi.fn(async () => state.existingJob)
    constructor(public name: string, public opts: unknown) { queues.push(this) }
  }
  return { queues, state, Queue }
})

vi.mock('bullmq', () => ({ Queue: fake.Queue, Worker: class {} }))
vi.mock('@opengraphity/events', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/events')>()
  return {
    ...orig,
    publish: vi.fn(async () => {}),
    // The tenant's queue, `<base>@<tenant>`: a fresh fake per call, so each test sees only its own.
    tenantQueue: (base: string, tenantId: string) => new fake.Queue(`${base}@${tenantId}`, {}),
  }
})

type FetchInit = { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
const fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<{ ok: boolean; status: number }>>(
  async () => ({ ok: true, status: 200 }),
)
vi.stubGlobal('fetch', fetchMock)

process.env['LOG_LEVEL'] = 'silent'
const { runAction, evaluateConditions } = await import('../actions.js')
const { publish, UnsafeUrlError } = await import('@opengraphity/events')
const publishMock = vi.mocked(publish)

// ── Fixtures ─────────────────────────────────────────────────────────────────

const instance: WorkflowInstance = {
  id: 'wi-1', tenantId: 't1', definitionId: 'def-1', entityId: 'inc-1', entityType: 'incident',
  currentStep: 'in_progress', status: 'active', createdAt: 'x', updatedAt: 'x',
}
const entityData = { id: 'inc-1', title: 'DB down', severity: 'critical', status: 'in_progress', category: 'database' }
function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return { userId: 'user-1', entityData, ...over }
}
function action(type: WorkflowActionConfig['type'], params: Record<string, unknown> = {}, over: Partial<WorkflowActionConfig> = {}): WorkflowActionConfig {
  return { type, params, ...over }
}
const PUBLIC_URL = 'https://93.184.216.34/hook'   // literal public IP: no DNS needed
// Plain-text template: a JSON-shaped template cannot carry placeholders today
// (see the it.fails below) — the fetch contract is asserted with this one.
const TEMPLATE = 'id={incident.id};title={title}'
const RESOLVED = 'id=inc-1;title=DB down'
const webhook = (over: Record<string, unknown> = {}) => action('call_webhook', {
  url: PUBLIC_URL, method: 'POST', headers: { 'X-Token': 'abc' }, payload_template: TEMPLATE, ...over,
})
const retryQueues = () => fake.queues.filter(q => q.name === 'workflow-jobs@t1')

beforeEach(() => {
  fake.queues.length = 0
  fake.state.existingJob = null
  fake.state.addFails = false
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }))
  publishMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── call_webhook ─────────────────────────────────────────────────────────────

describe('call_webhook — SSRF guard: blocked URL → error, no fetch, no retry job', () => {
  it.each([
    ['loopback IPv4',        'https://127.0.0.1/hook',                 /loopback|private/],
    ['localhost',            'https://localhost/hook',                 /loopback/],
    ['private 10/8',         'https://10.0.0.5/hook',                  /private/],
    ['private 192.168/16',   'https://192.168.1.1/hook',               /private/],
    ['cloud metadata',       'https://169.254.169.254/latest/meta-data', /link-local|private/],
    ['IPv6 loopback',        'https://[::1]/hook',                     /private|loopback/],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/hook',        /private|loopback/],
    ['non-http scheme',      'ftp://93.184.216.34/hook',               /scheme "ftp:" is not allowed/],
    ['file scheme',          'file:///etc/passwd',                     /scheme "file:" is not allowed/],
    ['plain http (https required outside development)', 'http://93.184.216.34/hook', /must use https/],
    ['credentials in URL',   'https://user:pw@93.184.216.34/hook',     /credentials/],
    ['empty',                '',                                        /empty/],
    ['not a URL',            'not a url',                               /not a valid absolute URL/],
  ])('%s → UnsafeUrlError', async (_label, url, pattern) => {
    const err = await runAction(webhook({ url }), instance, ctx()).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(UnsafeUrlError)
    expect((err as Error).message).toMatch(pattern)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(retryQueues()).toHaveLength(0)
  })

  it('a missing url param is an empty URL → error before any template work', async () => {
    await expect(runAction(action('call_webhook', { payload_template: '{nope}' }), instance, ctx())).rejects.toThrow(UnsafeUrlError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('call_webhook — public URL', () => {
  it('POSTs the resolved payload with Content-Type + custom headers and an abort signal', async () => {
    await expect(runAction(webhook(), instance, ctx())).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(PUBLIC_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Token': 'abc' })
    expect(init.body).toBe(RESOLVED)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(retryQueues()).toHaveLength(0)
  })

  it('GET sends no body; method defaults to POST when absent', async () => {
    await runAction(webhook({ method: 'GET' }), instance, ctx())
    expect(fetchMock.mock.calls[0]![1].method).toBe('GET')
    expect(fetchMock.mock.calls[0]![1].body).toBeUndefined()

    fetchMock.mockClear()
    await runAction(webhook({ method: undefined }), instance, ctx())
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST')
  })

  it('an unresolved placeholder in the payload template throws (no literal "{x}" sent)', async () => {
    await expect(runAction(webhook({ payload_template: 'x={incident.missing}' }), instance, ctx()))
      .rejects.toThrow(/placeholder \{incident\.missing\} did not resolve/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // BUG (packages/workflow/src/actions.ts:52): resolveTemplate matches
  // `\{([^}]+)\}`, so in a JSON template the OUTER `{` opens a "placeholder"
  // that runs to the first `}` — `{"id":"{incident.id}"}` yields the path
  // `"id":"{incident.id` and throws "did not resolve". The web editor labels
  // the field "payload_template (JSON)" (ActionParamsEditor.tsx:147): every
  // JSON body with a placeholder is unusable. An empty `{}` object is the only
  // JSON that survives.
  it('a JSON payload template with placeholders is sent resolved — BUG: placeholder regex swallows the JSON braces (actions.ts:52)', async () => {
    await runAction(webhook({ payload_template: '{"id":"{incident.id}","title":"{title}"}' }), instance, ctx())
    expect(fetchMock.mock.calls[0]![1].body).toBe('{"id":"inc-1","title":"DB down"}')
  })

  it('pinned: an empty JSON object template `{}` (the editor default) passes through', async () => {
    await runAction(webhook({ payload_template: '{}' }), instance, ctx())
    expect(fetchMock.mock.calls[0]![1].body).toBe('{}')
  })

  it('payload over 1MB is refused before fetch', async () => {
    const big = 'x'.repeat(1_000_001)
    await expect(runAction(webhook({ payload_template: big }), instance, ctx())).rejects.toThrow(/payload exceeds 1MB/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('non-2xx response → error naming the status, a webhook_retry job is queued in the tenant\'s queue (attempt 1, exponential 30s ×3)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    await expect(runAction(webhook(), instance, ctx())).rejects.toThrow('call_webhook failed (HTTP 503) — retry scheduled')

    expect(retryQueues()).toHaveLength(1)
    const q = retryQueues()[0]!
    expect(q.add).toHaveBeenCalledTimes(1)
    const [name, data, opts] = q.add.mock.calls[0]! as [string, Record<string, unknown>, Record<string, unknown>]
    expect(name).toBe('webhook_retry')
    // Revisione totale · E-11: gli header (un token del cliente) NON stanno nel
    // job — il worker li rilegge dal passo (stepId/actionIndex) — e i job falliti
    // non restano in Redis per sempre.
    expect(data).toEqual({
      type: 'webhook_retry', url: PUBLIC_URL, method: 'POST',
      payload: RESOLVED, attempt: 1, tenantId: 't1', entityId: 'inc-1',
    })
    expect(JSON.stringify(data)).not.toContain('X-Token')
    expect(opts).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } })
    // The producer singleton of the tenant: never closed after one use.
    expect(q.close).not.toHaveBeenCalled()
  })

  it('network failure (fetch rejects) → same retry path with the error message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(runAction(webhook(), instance, ctx())).rejects.toThrow('call_webhook failed (ECONNRESET) — retry scheduled')
    expect(retryQueues()[0]!.add).toHaveBeenCalledTimes(1)
  })

  it('inside a retry attempt (isWebhookRetry) a failure does NOT enqueue another retry (no loop)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(runAction(webhook(), instance, ctx({ isWebhookRetry: true }))).rejects.toThrow('call_webhook failed (HTTP 500) — retry attempt failed')
    expect(retryQueues()).toHaveLength(0)
  })

  it('if scheduling the retry fails, THAT error propagates (the payload would be lost forever)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    fake.state.addFails = true
    await expect(runAction(webhook(), instance, ctx())).rejects.toThrow('redis down')
    expect(retryQueues()).toHaveLength(1)
  })
})

// ── Conditions ───────────────────────────────────────────────────────────────

describe('conditions gate the action', () => {
  it('conditions not met → action skipped (no publish, no fetch)', async () => {
    const a = action('notify', { event: 'incident.escalated' }, { conditions: [{ field: 'severity', operator: 'eq', value: 'low' }] })
    await runAction(a, instance, ctx())
    expect(publishMock).not.toHaveBeenCalled()
  })

  it('AND (default) requires all, OR requires one', () => {
    const conds = [
      { field: 'severity', operator: 'eq' as const, value: 'critical' },
      { field: 'status', operator: 'eq' as const, value: 'closed' },
    ]
    expect(evaluateConditions(conds, 'AND', entityData)).toBe(false)
    expect(evaluateConditions(conds, 'OR', entityData)).toBe(true)
    expect(evaluateConditions(undefined, 'AND', entityData)).toBe(true)
    expect(evaluateConditions([], 'AND', entityData)).toBe(true)
  })

  it('operators: ne/gt/lt/gte/lte/in/not_in/contains/is_null/is_not_null', () => {
    const data = { n: 5, s: 'hello world', empty: null }
    const ev = (field: string, operator: string, value?: unknown) =>
      evaluateConditions([{ field, operator: operator as 'eq', value }], 'AND', data)
    expect(ev('n', 'ne', 4)).toBe(true)
    expect(ev('n', 'gt', 4)).toBe(true)
    expect(ev('n', 'lt', 4)).toBe(false)
    expect(ev('n', 'gte', 5)).toBe(true)
    expect(ev('n', 'lte', 4)).toBe(false)
    expect(ev('n', 'in', [1, 5])).toBe(true)
    expect(ev('n', 'not_in', [1, 5])).toBe(false)
    expect(ev('n', 'in', 'not-an-array')).toBe(false)
    expect(ev('s', 'contains', 'world')).toBe(true)
    expect(ev('n', 'contains', 'x')).toBe(false)
    expect(ev('empty', 'is_null')).toBe(true)
    expect(ev('missing', 'is_null')).toBe(true)
    expect(ev('s', 'is_not_null')).toBe(true)
  })

  it('unknown operator → throws (a corrupt guard must not execute the action)', () => {
    expect(() => evaluateConditions([{ field: 'n', operator: 'matches' as 'eq', value: 1 }], 'AND', { n: 1 }))
      .toThrow('Unknown action condition operator: matches (field: n)')
  })
})

// ── Event / SLA actions ──────────────────────────────────────────────────────

describe('notify / publish_event / sla_*', () => {
  it('notify without "event" param → error, nothing published', async () => {
    await expect(runAction(action('notify'), instance, ctx())).rejects.toThrow('notify: missing required param "event"')
    await expect(runAction(action('publish_event'), instance, ctx())).rejects.toThrow('publish_event: missing required param "event"')
    expect(publishMock).not.toHaveBeenCalled()
  })

  it('notify publishes a DomainEvent with entity_id/triggered_by (+ target, notes when given)', async () => {
    await runAction(action('notify', { event: 'incident.escalated', target: 'team-dba' }), instance, ctx({ notes: 'urgent' }))
    expect(publishMock).toHaveBeenCalledTimes(1)
    const evt = publishMock.mock.calls[0]![0]
    expect(evt).toMatchObject({
      type: 'incident.escalated', tenant_id: 't1', actor_id: 'user-1',
      payload: { entity_id: 'inc-1', triggered_by: 'user-1', target: 'team-dba', notes: 'urgent' },
    })
    expect(evt.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(evt.correlation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => new Date(evt.timestamp).toISOString()).not.toThrow()

    publishMock.mockClear()
    await runAction(action('publish_event', { event: 'x.y' }), instance, ctx())
    expect(publishMock.mock.calls[0]![0].payload).toEqual({ entity_id: 'inc-1', triggered_by: 'user-1' })
  })

  it('sla_start / sla_stop / sla_pause / sla_resume publish sla.<type>.<verb>; missing sla_type → error', async () => {
    await expect(runAction(action('sla_start'), instance, ctx())).rejects.toThrow('sla_start: missing required param "sla_type"')
    await expect(runAction(action('sla_pause'), instance, ctx())).rejects.toThrow('sla_pause: missing required param "sla_type"')

    await runAction(action('sla_start', { sla_type: 'response' }), instance, ctx())
    expect(publishMock.mock.calls[0]![0]).toMatchObject({
      type: 'sla.response.start', tenant_id: 't1', payload: { entity_id: 'inc-1', entity_type: 'incident', sla_type: 'response' },
    })
    for (const [type, verb] of [['sla_stop', 'stop'], ['sla_pause', 'pause'], ['sla_resume', 'resume']] as const) {
      publishMock.mockClear()
      await runAction(action(type, { sla_type: 'resolution' }), instance, ctx())
      expect(publishMock.mock.calls[0]![0]).toMatchObject({ type: `sla.resolution.${verb}`, payload: { entity_id: 'inc-1', sla_type: 'resolution' } })
    }
  })

  it('notify_rule is a no-op here (handled by the GraphQL resolver)', async () => {
    await expect(runAction(action('notify_rule', { title_key: 'k' }), instance, ctx())).resolves.toBeUndefined()
    expect(publishMock).not.toHaveBeenCalled()
  })

  it('a publish failure propagates', async () => {
    publishMock.mockRejectedValueOnce(new Error('redis down'))
    await expect(runAction(action('notify', { event: 'a.b' }), instance, ctx())).rejects.toThrow('redis down')
  })
})

// ── Azioni ritirate ──────────────────────────────────────────────────────────

// Verifica «Cosa resta cablato», ondata 3: la chiusura automatica è la scadenza
// del passo, e `schedule_job`/`cancel_job` non esistono più. Un dato che le
// porta ancora è configurazione corrotta, e il motore la nomina.
describe('schedule_job / cancel_job ritirate', () => {
  it('non sono più azioni del motore', async () => {
    for (const type of ['schedule_job', 'cancel_job']) {
      await expect(runAction(action(type as never, { job: 'auto_close' }), instance, ctx())).rejects.toThrow(`Unknown workflow action type: ${type}`)
    }
    expect(fake.queues).toEqual([])
  })
})

// ── Entity callbacks ─────────────────────────────────────────────────────────

describe('create_entity', () => {
  const params = { entity_type: 'problem', title_template: 'Problem from {incident.title}', link_to_current: true, copy_fields: ['severity', 'category', 'nope'] }

  it('without the createEntity callback → error (the derived entity would silently not exist)', async () => {
    await expect(runAction(action('create_entity', params), instance, ctx())).rejects.toThrow('create_entity: createEntity callback not provided')
  })

  it('unsupported entity_type → error, callback not called', async () => {
    const createEntity = vi.fn(async () => 'x')
    await expect(runAction(action('create_entity', { ...params, entity_type: 'task' }), instance, ctx({ createEntity })))
      .rejects.toThrow('create_entity: unsupported entity_type "task"')
    expect(createEntity).not.toHaveBeenCalled()
  })

  // WA-2: l'evento di creazione lo pubblica il servizio che crea il ticket, non l'azione (era duplicato).
  it('creates with resolved title, parent link, copied fields; the creation event is left to the creator', async () => {
    const createEntity = vi.fn(async () => 'prb-9')
    const publishEvent = vi.fn(async () => {})
    await runAction(action('create_entity', params), instance, ctx({ createEntity, publishEvent }))
    expect(createEntity).toHaveBeenCalledWith('problem', {
      title: 'Problem from DB down', tenant_id: 't1', parent_id: 'inc-1', parent_type: 'incident', severity: 'critical', category: 'database',
    })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('link_to_current=false → no parent fields; publishEvent optional', async () => {
    const createEntity = vi.fn(async () => 'chg-1')
    await runAction(action('create_entity', { entity_type: 'change', title_template: '{title}', link_to_current: false }), instance, ctx({ createEntity }))
    expect(createEntity).toHaveBeenCalledWith('change', { title: 'DB down', tenant_id: 't1' })
  })
})

describe('assign_to', () => {
  it('without callback → error; without any target → error, nothing assigned', async () => {
    await expect(runAction(action('assign_to', { target_type: 'team', target_id: 'team-1' }), instance, ctx())).rejects.toThrow('assign_to: assignTo callback not provided')
    const assignTo = vi.fn(async () => {})
    await expect(runAction(action('assign_to', { target_type: 'team' }), instance, ctx({ assignTo }))).rejects.toThrow('assign_to: no target_id or target_name resolved')
    expect(assignTo).not.toHaveBeenCalled()
  })

  it('target_id wins; target_name is a template; publishes <entityType>.assigned', async () => {
    const assignTo = vi.fn(async () => {})
    const publishEvent = vi.fn(async () => {})
    await runAction(action('assign_to', { target_type: 'team', target_id: 'team-1' }), instance, ctx({ assignTo, publishEvent }))
    expect(assignTo).toHaveBeenCalledWith('inc-1', 'team', 'team-1')
    expect(publishEvent).toHaveBeenCalledWith('incident.assigned', { entity_id: 'inc-1', target_type: 'team', target_id: 'team-1', assigned_by: 'user-1' })

    await runAction(action('assign_to', { target_type: 'team', target_name: 'team-{incident.category}' }), instance, ctx({ assignTo }))
    expect(assignTo).toHaveBeenLastCalledWith('inc-1', 'team', 'team-database')
  })
})

describe('update_field', () => {
  it('without callback → error; a reserved field → error with the reason, the callback is not called', async () => {
    await expect(runAction(action('update_field', { field: 'severity', value: 'low' }), instance, ctx())).rejects.toThrow('update_field: updateField callback not provided')
    const updateField = vi.fn(async () => {})
    await expect(runAction(action('update_field', { field: 'tenant_id', value: 'evil' }), instance, ctx({ updateField })))
      .rejects.toThrow('The field "tenant_id" identifies or traces the ticket and cannot be set by a step.')
    expect(updateField).not.toHaveBeenCalled()
  })

  // Ondata 8 · B-9: `status` era scrivibile, e il pannello del disegnatore
  // offriva `update_field` con tutti i campi dell'entità. Scriverlo da qui
  // scavalca il motore: `entity.status` e `WorkflowInstance.current_step`
  // divergono, il ticket si mostra chiuso mentre il processo è aperto.
  it('status (e gli altri campi del motore) non sono scrivibili: il rifiuto indica la transizione', async () => {
    const updateField = vi.fn(async () => {})
    for (const field of ['status', 'workflow_step', 'workflow_instance_id', 'resolved_at']) {
      const err = await runAction(action('update_field', { field, value: 'closed' }), instance, ctx({ updateField }))
        .then(() => null, (e: unknown) => e as Error)
      expect(err?.message, field).toContain(`The field "${field}" is written by the workflow engine`)
      expect(err?.message, field).toContain('use a transition')
    }
    expect(updateField).not.toHaveBeenCalled()
  })

  // Ondata 3: «ogni campo non riservato». Un campo del cliente arriva al callback,
  // che è chi conosce il metamodello e il vocabolario.
  it('a customer field passes to the callback', async () => {
    const updateField = vi.fn(async () => {})
    await runAction(action('update_field', { field: 'outcome', value: 'successful' }), instance, ctx({ updateField }))
    expect(updateField).toHaveBeenCalledWith('inc-1', 'outcome', 'successful')
  })

  it('string values are templates, non-strings pass through; publishes <entityType>.updated', async () => {
    const updateField = vi.fn(async () => {})
    const publishEvent = vi.fn(async () => {})
    await runAction(action('update_field', { field: 'description', value: 'Escalated: {title}' }), instance, ctx({ updateField, publishEvent }))
    expect(updateField).toHaveBeenCalledWith('inc-1', 'description', 'Escalated: DB down')
    expect(publishEvent).toHaveBeenCalledWith('incident.updated', { entity_id: 'inc-1', field: 'description', value: 'Escalated: DB down', updated_by: 'user-1' })

    await runAction(action('update_field', { field: 'priority', value: 1 }), instance, ctx({ updateField }))
    expect(updateField).toHaveBeenLastCalledWith('inc-1', 'priority', 1)
  })
})

describe('create_approval_request', () => {
  it('without callback → error', async () => {
    await expect(runAction(action('create_approval_request', { title_template: 'x' }), instance, ctx()))
      .rejects.toThrow('create_approval_request: callback not provided')
  })

  it('passes entity, resolved title, approver role and type', async () => {
    const createApprovalRequest = vi.fn(async () => 'apr-1')
    await runAction(
      action('create_approval_request', { title_template: 'Approve {incident.title}', approver_role: 'APPROVER', approval_type: 'all' }),
      instance, ctx({ createApprovalRequest }),
    )
    expect(createApprovalRequest).toHaveBeenCalledWith({
      entityId: 'inc-1', entityType: 'incident', title: 'Approve DB down', approverRole: 'APPROVER', approvalType: 'all',
      // Moduli del catalogo, ondata 3: senza persone né squadre indicate sono
      // liste vuote, e vale il ruolo — come prima.
      approverUserIds: [], approverTeamIds: [],
    })
  })

  it('persone e squadre indicate arrivano al chiamante, in entrambe le forme (lista o stringa)', async () => {
    const createApprovalRequest = vi.fn(async () => 'apr-1')
    // Il disegnatore scrive una STRINGA separata da virgola: il suo editor tiene
    // i parametri come testo e non può produrre un array.
    await runAction(
      action('create_approval_request', {
        title_template: 'X', approver_user_ids: 'u-1, u-2', approver_team_ids: 'team-9',
      }),
      instance, ctx({ createApprovalRequest }),
    )
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      approverUserIds: ['u-1', 'u-2'], approverTeamIds: ['team-9'],
    }))

    // L'API scrive una LISTA: stesso risultato.
    createApprovalRequest.mockClear()
    await runAction(
      action('create_approval_request', {
        title_template: 'X', approver_user_ids: ['u-3'], approver_team_ids: [],
      }),
      instance, ctx({ createApprovalRequest }),
    )
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      approverUserIds: ['u-3'], approverTeamIds: [],
    }))
  })
})

describe('unknown action type', () => {
  it('throws instead of ignoring newer/corrupt config', async () => {
    await expect(runAction(action('teleport' as 'notify'), instance, ctx())).rejects.toThrow('Unknown workflow action type: teleport')
    expect(publishMock).not.toHaveBeenCalled()
  })
})

/**
 * THE FALLBACKS OF THE ACTIONS, one by one.
 *
 * Every `?? ''`, `?? 'POST'` and `...(x ? {…} : {})` below exists because
 * that parameter CAN be missing: the designer saves an action with only the
 * fields the administrator filled in. A fallback never executed is a fallback
 * never tested — and how these actions fail when a field is missing is
 * exactly what the customer sees.
 */
describe('fallbacks: parameters the designer may have left empty', () => {
  it('a placeholder walking through a NON-object value does not resolve: it throws instead of sending "{…}"', async () => {
    // `{title.something}`: `title` is a string, and descending into it makes
    // no sense. Without this check the webhook would go out with the literal
    // placeholder in the body, and the receiver would take it for data.
    await expect(runAction(webhook({ payload_template: 'x={title.something}' }), instance, ctx()))
      .rejects.toThrow(/\{title\.something\}/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('call_webhook with no payload_template, no method and no headers: empty body, POST, Content-Type only', async () => {
    await runAction(action('call_webhook', { url: PUBLIC_URL }), instance, ctx())
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('POST')
    expect(init.body).toBe('')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('a fetch rejection that is not an Error is still readable as the failure reason', async () => {
    fetchMock.mockRejectedValueOnce('network gone')
    await expect(runAction(webhook(), instance, ctx())).rejects.toThrow('call_webhook failed (network gone) — retry scheduled')
  })

  it('the retry job carries stepId and actionIndex ONLY when present, and the method falls back to POST', async () => {
    // The worker re-reads the headers from the step: without stepId it
    // cannot, and a key holding `undefined` does not survive BullMQ
    // serialization — absent is better than fake.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 })
    await expect(runAction(action('call_webhook', { url: PUBLIC_URL }), instance, ctx())).rejects.toThrow(/retry scheduled/)
    expect(retryQueues()[0]!.add.mock.calls[0]![1]).toEqual({
      type: 'webhook_retry', url: PUBLIC_URL, method: 'POST', payload: '', attempt: 1, tenantId: 't1', entityId: 'inc-1',
    })

    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 })
    await expect(runAction(webhook(), instance, ctx({ stepId: 'step-9', actionIndex: 2 }))).rejects.toThrow(/retry scheduled/)
    expect(retryQueues()[1]!.add.mock.calls[0]![1]).toMatchObject({ stepId: 'step-9', actionIndex: 2 })
  })

  it('create_entity with no title_template creates with an empty title, and change_type is passed only when configured', async () => {
    const createEntity = vi.fn(async () => 'chg-1')
    await runAction(action('create_entity', { entity_type: 'change', change_type: 'standard' }), instance, ctx({ createEntity }))
    expect(createEntity).toHaveBeenCalledWith('change', expect.objectContaining({ title: '', change_type: 'standard' }))

    createEntity.mockClear()
    await runAction(action('create_entity', { entity_type: 'problem' }), instance, ctx({ createEntity }))
    expect(createEntity.mock.calls[0]![1]).not.toHaveProperty('change_type')
  })

  it('create_approval_request with no title_template passes an empty title to the caller', async () => {
    const createApprovalRequest = vi.fn(async () => 'ap-1')
    await runAction(action('create_approval_request', { approver_role: 'APPROVER' }), instance, ctx({ createApprovalRequest }))
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ title: '' }))
  })
})
