import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

// ── Mocks: the engine is tested as a pure event → side-effect mapper ─────────

const markResponseMet   = vi.fn(async () => {})
const markResolveMet    = vi.fn()
const getSLAStatus      = vi.fn()
const createSLAStatus   = vi.fn()
const getEntityCreatedAt = vi.fn()
const cancelSLAJobs     = vi.fn(async () => {})
const scheduleWarning   = vi.fn(async () => {})
const scheduleBreachCheck = vi.fn(async () => {})
const scheduleResponseCheck = vi.fn(async () => {})
const selectSLAForEntity = vi.fn(async () => null)

vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
}))
vi.mock('../status.js', () => ({
  markResponseMet, markResolveMet, getSLAStatus, createSLAStatus, getEntityCreatedAt,
  pauseSLA: vi.fn(), resumeSLA: vi.fn(),
}))
vi.mock('../scheduler.js', () => ({
  initScheduler: vi.fn(), cancelSLAJobs, scheduleWarning, scheduleBreachCheck, scheduleResponseCheck,
  scheduleOLABreaches: vi.fn(async () => {}),
}))
vi.mock('../selector.js', () => ({ selectSLAForEntity }))
vi.mock('../olaBreach.js', () => ({ getActiveOLAContractsFor: vi.fn(async () => []) }))

const { SLAEngine } = await import('../engine.js')

function event<T>(type: string, payload: T, timestamp = '2026-05-01T10:00:00.000Z'): DomainEvent<T> {
  return { id: 'evt-1', type, tenant_id: 't1', timestamp, correlation_id: 'c', actor_id: 'u', payload } as DomainEvent<T>
}

const baseStatus = {
  id: 'sla-1', tenant_id: 't1', entity_id: 'inc-1', entity_type: 'incident',
  started_at: '2026-05-01T09:00:00.000Z',
  response_deadline: '2026-05-01T10:00:00.000Z', resolve_deadline: '2026-05-01T17:00:00.000Z',
  response_met: false, resolve_met: false, breached: false,
  tier: { severity: 'high', response_minutes: 60, resolve_minutes: 480, business_hours: false },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  createSLAStatus.mockResolvedValue(baseStatus)
  getSLAStatus.mockResolvedValue(baseStatus)
  markResolveMet.mockResolvedValue({ ...baseStatus, resolve_met: true })
})

describe('SLAEngine — response met cancels the response timer (D-01)', () => {
  it('incident.assigned → markResponseMet then cancelSLAJobs(id, "response")', async () => {
    const engine = new SLAEngine()
    await engine.process(event('incident.assigned', { id: 'inc-1', assignedTo: 'u2' }))
    expect(markResponseMet).toHaveBeenCalledWith('t1', 'inc-1')
    expect(cancelSLAJobs).toHaveBeenCalledWith('inc-1', 'response')
    // Only the response timer: warning/breach stay armed.
    expect(cancelSLAJobs).toHaveBeenCalledTimes(1)
  })

  it('incident.assigned without an entity id fails loudly', async () => {
    const engine = new SLAEngine()
    await expect(engine.process(event('incident.assigned', {}))).rejects.toThrow('missing entity id')
    expect(markResponseMet).not.toHaveBeenCalled()
  })
})

describe('SLAEngine — SLA clock starts at the entity created_at (D-29)', () => {
  it('reads created_at from the node when the payload lacks it', async () => {
    getEntityCreatedAt.mockResolvedValue(new Date('2026-05-01T09:00:00.000Z'))
    const engine = new SLAEngine()
    await engine.process(event('incident.created', { id: 'inc-1', title: 'x', severity: 'high', affected_ci_ids: [] }))
    expect(getEntityCreatedAt).toHaveBeenCalledWith('t1', 'inc-1')
    const params = createSLAStatus.mock.calls[0]![0] as { startedAt: Date; severity: string }
    expect(params.startedAt.toISOString()).toBe('2026-05-01T09:00:00.000Z')
    expect(params.severity).toBe('high')
    expect(scheduleWarning).toHaveBeenCalled()
    expect(scheduleBreachCheck).toHaveBeenCalled()
    expect(scheduleResponseCheck).toHaveBeenCalled()
  })

  it('uses payload.created_at when present (no DB round-trip)', async () => {
    const engine = new SLAEngine()
    await engine.process(event('problem.created', { id: 'prb-1', title: 'x', impact: 'critical', affected_ci_ids: [], created_at: '2026-05-01T08:30:00.000Z' }))
    expect(getEntityCreatedAt).not.toHaveBeenCalled()
    const params = createSLAStatus.mock.calls[0]![0] as { startedAt: Date }
    expect(params.startedAt.toISOString()).toBe('2026-05-01T08:30:00.000Z')
  })

  it('propagates a missing created_at on the node (no silent "now" fallback)', async () => {
    getEntityCreatedAt.mockRejectedValue(new Error('created_at of entity inc-1 is missing'))
    const engine = new SLAEngine()
    await expect(
      engine.process(event('incident.created', { id: 'inc-1', title: 'x', severity: 'high', affected_ci_ids: [] })),
    ).rejects.toThrow('created_at of entity inc-1 is missing')
    expect(createSLAStatus).not.toHaveBeenCalled()
  })
})

describe('SLAEngine — resolution passes the real resolved_at (D-02)', () => {
  it('incident.resolved → markResolveMet(tenant, id, payload.resolved_at) and cancels all timers', async () => {
    const engine = new SLAEngine()
    await engine.process(event('incident.resolved', { entity_id: 'inc-1', resolved_at: '2026-05-01T12:00:00.000Z' }))
    expect(markResolveMet).toHaveBeenCalledTimes(1)
    const [tenant, id, at] = markResolveMet.mock.calls[0]! as unknown as [string, string, Date]
    expect(tenant).toBe('t1'); expect(id).toBe('inc-1')
    expect(at.toISOString()).toBe('2026-05-01T12:00:00.000Z')
    expect(cancelSLAJobs).toHaveBeenCalledWith('inc-1')
  })

  it('request.completed uses completed_at; without it the event timestamp', async () => {
    const engine = new SLAEngine()
    await engine.process(event('request.completed', { id: 'sr-1', completed_at: '2026-05-02T09:00:00.000Z', fulfilled_by_id: 'u' }))
    expect((markResolveMet.mock.calls[0]![2] as unknown as Date).toISOString()).toBe('2026-05-02T09:00:00.000Z')
    await engine.process(event('problem.resolved', { id: 'prb-1' }, '2026-05-03T09:00:00.000Z'))
    expect((markResolveMet.mock.calls[1]![2] as unknown as Date).toISOString()).toBe('2026-05-03T09:00:00.000Z')
  })

  it('skips entities without an SLAStatus', async () => {
    getSLAStatus.mockResolvedValue(null)
    const engine = new SLAEngine()
    await engine.process(event('incident.resolved', { id: 'inc-9', resolved_at: '2026-05-01T12:00:00.000Z' }))
    expect(markResolveMet).not.toHaveBeenCalled()
    expect(cancelSLAJobs).not.toHaveBeenCalled()
  })
})
