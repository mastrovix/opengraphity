/**
 * Automatic escalation on SLA/OLA breach (consumers/escalationConsumer.ts).
 *
 * Idempotency mechanism pinned here: the consumer looks up an outgoing
 * `TRANSITIONS_TO {trigger: 'sla_breach'}` edge from the entity's CURRENT
 * step. Once escalated/resolved/closed the current step has no such edge, so
 * a redelivered or duplicated breach event finds no row and is a no-op.
 * (A second layer lives in packages/events BaseConsumer: `evt:processed:<queue>:<id>`
 * marker in Redis — out of scope here, the consumer is driven directly.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

const publish = vi.fn()
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public readonly queueName: string) {} },
  publish: (...a: unknown[]) => publish(...a),
}))

interface Rec { get(k: string): unknown }
type Tx = { run: (q: string, p?: Record<string, unknown>) => Promise<{ records: Rec[] }> }
type Work = (tx: Tx) => Promise<unknown>

let rows: Record<string, unknown>[] = []
let readError: Error | null = null
const reads: Array<{ q: string; p?: Record<string, unknown> }> = []
const close = vi.fn().mockResolvedValue(undefined)
const session = {
  executeRead: async (work: Work) => work({
    run: async (q, p) => {
      reads.push({ q, p })
      if (readError) throw readError
      return { records: rows.map((r) => ({ get: (k: string) => r[k] ?? null })) }
    },
  }),
  close,
}
const getSession = vi.fn(() => session)
vi.mock('@opengraphity/neo4j', () => ({ getSession: (...a: unknown[]) => getSession(...(a as [])) }))

const transition = vi.fn()
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { transition: (...a: unknown[]) => transition(...a) } }))

const logError = vi.fn()
const logWarn = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logWarn, error: logError, debug: vi.fn() },
}))

const { EscalationConsumer } = await import('../escalationConsumer.js')

const consumer = new EscalationConsumer()

const event = (type: string, payload: Record<string, unknown>, over: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> => ({
  id:             'evt-1',
  type,
  tenant_id:      't1',
  timestamp:      '2026-09-08T10:00:00.000Z',
  correlation_id: 'corr-1',
  actor_id:       'sla-engine',
  payload,
  ...over,
})

const ESCALATABLE = { instanceId: 'wi-1', entityType: 'incident', fromStep: 'in_progress', toStep: 'escalated', title: 'DB down', severity: 'critical' }

beforeEach(() => {
  vi.clearAllMocks()
  rows = []
  readError = null
  reads.length = 0
  transition.mockResolvedValue({ success: true })
  publish.mockResolvedValue(undefined)
})

describe('EscalationConsumer — sla.breached', () => {
  it('esegue la transizione sla_breach dallo step corrente (tenant + trigger sul motore) e pubblica incident.escalated', async () => {
    rows = [ESCALATABLE]

    await consumer.process(event('sla.breached', { entity_id: 'inc-1' }))

    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(reads).toHaveLength(1)
    expect(reads[0]!.p).toEqual({ entityId: 'inc-1', tenantId: 't1' })
    expect(reads[0]!.q).toContain("[:TRANSITIONS_TO {trigger: 'sla_breach'}]")
    expect(reads[0]!.q).toContain('{id: $entityId, tenant_id: $tenantId}')

    expect(transition).toHaveBeenCalledOnce()
    expect(transition).toHaveBeenCalledWith(
      session,
      { instanceId: 'wi-1', toStepName: 'escalated', triggeredBy: 'sla-engine', triggerType: 'sla_breach' },
      { userId: 'system', entityData: {} },
    )

    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type:           'incident.escalated',
      tenant_id:      't1',
      correlation_id: 'corr-1',
      actor_id:       'sla-engine',
      payload: {
        id: 'inc-1', entity_id: 'inc-1', entity_type: 'incident',
        title: 'DB down', severity: 'critical', status: 'escalated', reason: 'sla_breach',
      },
    }))
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'inc-1', fromStep: 'in_progress', toStep: 'escalated', trigger: 'sla.breached' }),
      expect.stringContaining('auto-escalated'),
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('usa payload.id quando entity_id manca', async () => {
    rows = [ESCALATABLE]
    await consumer.process(event('sla.breached', { id: 'inc-2' }))
    expect(reads[0]!.p).toEqual({ entityId: 'inc-2', tenantId: 't1' })
  })

  it('ola.breached → stesso meccanismo, reason=ola_breach', async () => {
    rows = [ESCALATABLE]
    await consumer.process(event('ola.breached', { entity_id: 'inc-1' }))
    expect(transition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ triggerType: 'sla_breach' }), expect.anything())
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ reason: 'ola_breach' }) }))
  })

  it('titolo/severity assenti → default nel payload dell\'evento (richiesti dal dispatcher notifiche)', async () => {
    rows = [{ ...ESCALATABLE, title: null, severity: null }]
    await consumer.process(event('sla.breached', { entity_id: 'inc-1' }))
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ title: 'incident inc-1', severity: 'high' }),
    }))
  })

  it('correlation_id assente sull\'evento → ne genera uno (uuid)', async () => {
    rows = [ESCALATABLE]
    await consumer.process(event('sla.breached', { entity_id: 'inc-1' }, { correlation_id: undefined as unknown as string }))
    const published = publish.mock.calls[0]![0] as DomainEvent<unknown>
    expect(published.correlation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(published.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('EscalationConsumer — no-op', () => {
  it('evento non di breach → nessuna sessione aperta', async () => {
    await consumer.process(event('incident.created', { entity_id: 'inc-1' }))
    expect(getSession).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  it('payload senza entity_id/id → nessuna sessione aperta', async () => {
    await consumer.process(event('sla.breached', { foo: 'bar' }))
    expect(getSession).not.toHaveBeenCalled()
  })

  it('entità già chiusa/risolta (nessun arco sla_breach dallo step corrente) → nessuna transizione, nessun evento', async () => {
    rows = []
    await expect(consumer.process(event('sla.breached', { entity_id: 'inc-closed' }))).resolves.toBeUndefined()
    expect(reads).toHaveLength(1)
    expect(transition).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('idempotenza: lo stesso evento consegnato due volte → una sola transizione, la seconda è un no-op senza errore', async () => {
    const evt = event('sla.breached', { entity_id: 'inc-1' })

    rows = [ESCALATABLE]                      // 1ª consegna: in_progress ha l'arco sla_breach
    await consumer.process(evt)
    rows = []                                 // 2ª consegna: lo step corrente è 'escalated', nessun arco sla_breach
    await expect(consumer.process(evt)).resolves.toBeUndefined()

    expect(transition).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(reads).toHaveLength(2)
  })

  it('coppia sla.breached + ola.breached sulla stessa entità → una sola escalation', async () => {
    rows = [ESCALATABLE]
    await consumer.process(event('sla.breached', { entity_id: 'inc-1' }, { id: 'evt-sla' }))
    rows = []
    await consumer.process(event('ola.breached', { entity_id: 'inc-1' }, { id: 'evt-ola' }))
    expect(transition).toHaveBeenCalledTimes(1)
  })
})

describe('EscalationConsumer — errori', () => {
  it('errore DB → rilanciato (BaseConsumer ritenta), loggato, sessione chiusa', async () => {
    readError = new Error('neo4j down')
    await expect(consumer.process(event('sla.breached', { entity_id: 'inc-1' }))).rejects.toThrow('neo4j down')
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'inc-1', eventType: 'sla.breached' }), expect.stringContaining('processing failed'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('transizione che lancia → rilanciata, nessun evento pubblicato', async () => {
    rows = [ESCALATABLE]
    transition.mockRejectedValue(new Error('engine exploded'))
    await expect(consumer.process(event('sla.breached', { entity_id: 'inc-1' }))).rejects.toThrow('engine exploded')
    expect(publish).not.toHaveBeenCalled()
  })

  it('publish che fallisce → rilanciato (la notifica di escalation non si perde in silenzio)', async () => {
    rows = [ESCALATABLE]
    publish.mockRejectedValue(new Error('redis down'))
    await expect(consumer.process(event('sla.breached', { entity_id: 'inc-1' }))).rejects.toThrow('redis down')
  })

  it('transizione con success:false dovrebbe far rigettare process() — BUG (da confermare): escalationConsumer.ts:65-68 ritorna dopo il log, BaseConsumer marca l\'evento come processato e l\'escalation è persa in silenzio (in contrasto con il commento a riga 97)', async () => {
    rows = [ESCALATABLE]
    transition.mockResolvedValue({ success: false, error: 'guard rejected' })
    await expect(consumer.process(event('sla.breached', { entity_id: 'inc-1' }))).rejects.toThrow()
  })
})
