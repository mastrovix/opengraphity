/**
 * Scheduled reports processor (jobs/reportScheduler.ts):
 *  - each due template is CLAIMED atomically (SET last_scheduled_run guarded by
 *    `< $dueAt`): 0 rows → another replica owns the tick, skip; 1 row → execute;
 *  - an invalid cron on one template is logged loudly and does not stop the others;
 *  - a failing execution makes the tick fail after the claim (visible in BullMQ).
 * previousDueAt / buildSlackSummary (pure) are covered in schedulerHelpers.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const queueAdd = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => { processors.set(name, processor); return { name, opts } }),
  getQueue: vi.fn(() => ({ add: queueAdd })),
}))

interface Rec { get(k: string): unknown }
type Tx = { run: (q: string, p?: Record<string, unknown>) => Promise<{ records: Rec[] }> }
type Work = (tx: Tx) => Promise<unknown>

/** Cypher dispatcher: returns the rows for a query (set per test). */
const handler = vi.fn<(q: string, p?: Record<string, unknown>) => Record<string, unknown>[]>()
const calls: Array<{ kind: 'read' | 'write'; mode: string | undefined; q: string; p?: Record<string, unknown> }> = []
const closes = vi.fn().mockResolvedValue(undefined)

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn((_db?: string, mode?: string) => {
    const run = (kind: 'read' | 'write') => async (q: string, p?: Record<string, unknown>) => {
      calls.push({ kind, mode, q, p })
      return { records: handler(q, p).map((r) => ({ get: (k: string) => r[k] ?? null })) }
    }
    return {
      executeRead:  async (work: Work) => work({ run: run('read') }),
      executeWrite: async (work: Work) => work({ run: run('write') }),
      close: closes,
    }
  }),
}))

const sendSlackMessage = vi.fn()
const sendToTenant = vi.fn()
vi.mock('@opengraphity/notifications', () => ({
  sendSlackMessage: (...a: unknown[]) => sendSlackMessage(...a),
  sseManager: { sendToTenant: (...a: unknown[]) => sendToTenant(...a) },
}))

const executeReportSection = vi.fn()
vi.mock('../../lib/reportExecutor.js', () => ({ executeReportSection: (...a: unknown[]) => executeReportSection(...a) }))

const loadTemplateSections = vi.fn()
vi.mock('../../lib/reportTemplates.js', () => ({ loadTemplateSections: (...a: unknown[]) => loadTemplateSections(...a) }))

const logError = vi.fn()
const logWarn = vi.fn()
const logInfo = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { info: logInfo, warn: logWarn, error: logError, debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// Fixed clock: 10:00:30 → the every-minute cron fired at 10:00:00, 30s ago (inside the catch-up window)
vi.useFakeTimers()
vi.setSystemTime(new Date('2026-09-08T10:00:30.000Z'))
afterAll(() => { vi.useRealTimers() })

const { startReportScheduler, REPORT_SCHEDULER_QUEUE } = await import('../reportScheduler.js')

await startReportScheduler()
const processor = processors.get(REPORT_SCHEDULER_QUEUE)!
// captured now: beforeEach clears every mock's calls
const repeatRegistration = queueAdd.mock.calls[0]
const tick = () => processor({ name: 'check', data: {} } as unknown as Job)

const DUE_AT = '2026-09-08T10:00:00.000Z'
const NOW    = '2026-09-08T10:00:30.000Z'
const SECTION = { id: 'sec-1', title: 'Open incidents', chartType: 'kpi' }

const template = (over: Record<string, unknown> = {}) => ({
  props: {
    id: 'tpl-1', tenant_id: 't1', name: 'Weekly ops', schedule_enabled: true,
    schedule_cron: '* * * * *', last_scheduled_run: null, schedule_channel_id: null, ...over,
  },
})

/** Wires the dispatcher: template list, claim result, optional channel webhook. */
function db(opts: { templates: Record<string, unknown>[]; claim: (p?: Record<string, unknown>) => Record<string, unknown>[]; webhook?: string | null }) {
  handler.mockImplementation((q, p) => {
    if (q.includes('MATCH (r:ReportTemplate)') && q.includes('schedule_enabled')) return opts.templates
    if (q.includes('SET r.last_scheduled_run')) return opts.claim(p)
    if (q.includes('NotificationChannel')) return opts.webhook ? [{ webhookUrl: opts.webhook }] : []
    throw new Error(`unexpected query: ${q}`)
  })
}
const claimQuery = () => calls.find((c) => c.q.includes('SET r.last_scheduled_run'))

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  loadTemplateSections.mockResolvedValue([SECTION])
  executeReportSection.mockResolvedValue({ title: 'Open incidents', chartType: 'kpi', data: '{"value": 7}' })
  sendSlackMessage.mockResolvedValue(undefined)
})

describe('report-scheduler — claim atomico', () => {
  it('claim senza righe (un\'altra replica ha già preso il tick) → skip: nessuna sezione eseguita, nessuna notifica', async () => {
    db({ templates: [template()], claim: () => [] })

    await expect(tick()).resolves.toBeUndefined()

    expect(claimQuery()).toBeDefined()
    expect(loadTemplateSections).not.toHaveBeenCalled()
    expect(executeReportSection).not.toHaveBeenCalled()
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'tpl-1', dueAt: DUE_AT }), expect.stringContaining('already claimed'))
  })

  it('claim con 1 riga → esegue: la query ha la guardia < $dueAt ed è scopata per tenant', async () => {
    db({ templates: [template()], claim: () => [{ id: 'tpl-1' }] })

    await expect(tick()).resolves.toBeUndefined()

    const claim = claimQuery()!
    expect(claim.kind).toBe('write')
    expect(claim.mode).toBe('WRITE')
    expect(claim.q).toContain('MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})')
    expect(claim.q).toMatch(/WHERE r\.last_scheduled_run IS NULL OR r\.last_scheduled_run < \$dueAt/)
    expect(claim.q).toContain('SET r.last_scheduled_run = $now')
    expect(claim.p).toEqual({ id: 'tpl-1', tenantId: 't1', dueAt: DUE_AT, now: NOW })

    expect(loadTemplateSections).toHaveBeenCalledWith(expect.anything(), 'tpl-1', 't1')
    expect(executeReportSection).toHaveBeenCalledWith(SECTION, 't1')
    expect(sendToTenant).toHaveBeenCalledWith('t1', expect.objectContaining({
      type: 'scheduled_report', entity_id: 'tpl-1', entity_type: 'ReportTemplate', severity: 'info', timestamp: NOW, read: false,
      title: 'Report eseguito: Weekly ops',
    }))
    expect(closes).toHaveBeenCalled()
  })

  it('pre-filtro: last_scheduled_run >= dueAt → nessun tentativo di claim', async () => {
    db({ templates: [template({ last_scheduled_run: DUE_AT })], claim: () => [{ id: 'tpl-1' }] })
    await tick()
    expect(claimQuery()).toBeUndefined()
    expect(executeReportSection).not.toHaveBeenCalled()
  })

  it('template il cui cron non è scattato nella finestra di recupero → non è dovuto', async () => {
    db({ templates: [template({ schedule_cron: '0 3 * * *' })], claim: () => [{ id: 'tpl-1' }] })   // 03:00, 7h fa
    await tick()
    expect(claimQuery()).toBeUndefined()
  })

  it('ogni template è reclamato separatamente: uno skip non blocca l\'altro', async () => {
    db({
      templates: [template({ id: 'tpl-a' }), template({ id: 'tpl-b', tenant_id: 't2' })],
      claim: (p) => (p?.['id'] === 'tpl-b' ? [{ id: 'tpl-b' }] : []),
    })
    await tick()
    expect(loadTemplateSections).toHaveBeenCalledTimes(1)
    expect(loadTemplateSections).toHaveBeenCalledWith(expect.anything(), 'tpl-b', 't2')
    expect(sendToTenant).toHaveBeenCalledWith('t2', expect.anything())
  })
})

describe('report-scheduler — cron invalido', () => {
  it('un template con cron corrotto è loggato (error, con id/nome/cron) e saltato; gli altri vengono eseguiti; il tick non fallisce', async () => {
    db({
      templates: [template({ id: 'tpl-bad', name: 'Broken', schedule_cron: 'not a cron' }), template()],
      claim: () => [{ id: 'tpl-1' }],
    })

    await expect(tick()).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), templateId: 'tpl-bad', name: 'Broken', cron: 'not a cron' }),
      expect.stringContaining('invalid schedule_cron'),
    )
    expect(executeReportSection).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.q.includes('SET r.last_scheduled_run')).map((c) => c.p?.['id'])).toEqual(['tpl-1'])
  })
})

describe('report-scheduler — errori di esecuzione', () => {
  it('sezione che fallisce → il tick rigetta con il conteggio (il claim è già avvenuto: nessun re-run)', async () => {
    db({ templates: [template()], claim: () => [{ id: 'tpl-1' }] })
    executeReportSection.mockRejectedValue(new Error('cypher timeout'))

    await expect(tick()).rejects.toThrow('report-scheduler: 1/1 scheduled report(s) failed — see log')
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), templateId: 'tpl-1' }), expect.stringContaining('error executing report'))
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(claimQuery()).toBeDefined()
  })

  it('un fallimento non blocca gli altri template: 1/2 fallito → gli altri eseguiti, poi rigetta', async () => {
    db({ templates: [template({ id: 'tpl-a' }), template({ id: 'tpl-b' })], claim: (p) => [{ id: p?.['id'] }] })
    loadTemplateSections.mockImplementation(async (_s: unknown, id: string) => { if (id === 'tpl-a') throw new Error('boom'); return [SECTION] })

    await expect(tick()).rejects.toThrow(/1\/2 scheduled report\(s\) failed/)
    expect(sendToTenant).toHaveBeenCalledTimes(1)
  })

  it('errore nel caricamento dei template dovuti → il tick rigetta subito', async () => {
    handler.mockImplementation(() => { throw new Error('neo4j down') })
    await expect(tick()).rejects.toThrow('neo4j down')
  })
})

describe('report-scheduler — consegna Slack', () => {
  it('canale schedulato attivo → sendSlackMessage con i blocchi KPI', async () => {
    db({ templates: [template({ schedule_channel_id: 'ch-1' })], claim: () => [{ id: 'tpl-1' }], webhook: 'https://hooks.slack.com/services/T/B/x' })

    await tick()

    const channelQuery = calls.find((c) => c.q.includes('NotificationChannel'))!
    expect(channelQuery.p).toEqual({ channelId: 'ch-1', tenantId: 't1' })
    expect(channelQuery.q).toMatch(/c\.platform = 'slack' AND c\.active = true/)
    expect(sendSlackMessage).toHaveBeenCalledOnce()
    const [url, text, blocks] = sendSlackMessage.mock.calls[0] as [string, null, unknown[]]
    expect(url).toBe('https://hooks.slack.com/services/T/B/x')
    expect(text).toBeNull()
    expect(JSON.stringify(blocks)).toContain('Weekly ops')
    expect(JSON.stringify(blocks)).toContain('*Open incidents*')
  })

  it('canale non trovato/inattivo nel tenant → warn, nessuna Slack, il report è comunque eseguito', async () => {
    db({ templates: [template({ schedule_channel_id: 'ch-gone' })], claim: () => [{ id: 'tpl-1' }], webhook: null })
    await expect(tick()).resolves.toBeUndefined()
    expect(sendSlackMessage).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'tpl-1', channelId: 'ch-gone' }), expect.stringContaining('Slack delivery skipped'))
    expect(sendToTenant).toHaveBeenCalledOnce()
  })

  it('webhook Slack che fallisce → il template conta come fallito', async () => {
    db({ templates: [template({ schedule_channel_id: 'ch-1' })], claim: () => [{ id: 'tpl-1' }], webhook: 'https://hooks.slack.com/x' })
    sendSlackMessage.mockRejectedValue(new Error('slack 500'))
    await expect(tick()).rejects.toThrow(/1\/1 scheduled report\(s\) failed/)
  })
})

describe('startReportScheduler', () => {
  it('registra il check ogni 60s con jobId fisso', () => {
    expect(repeatRegistration).toEqual(['check', {}, { repeat: { every: 60_000 }, jobId: 'report-scheduler-check', removeOnComplete: true }])
  })
})
