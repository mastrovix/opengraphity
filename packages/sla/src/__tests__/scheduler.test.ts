import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

// ── Mocks (pure unit test: no Redis, no Neo4j) ────────────────────────────────

const publish     = vi.fn(async () => {})
const getSLAStatus = vi.fn()
const markBreached = vi.fn(async () => {})
const callOrder: string[] = []

vi.mock('@opengraphity/events', () => ({
  publish: (...args: unknown[]) => { callOrder.push('publish'); return publish(...(args as [])) },
}))
vi.mock('../status.js', () => ({
  getSLAStatus: (...args: unknown[]) => getSLAStatus(...(args as [])),
  markBreached: (...args: unknown[]) => { callOrder.push('markBreached'); return markBreached(...(args as [])) },
}))
vi.mock('../olaBreach.js', () => ({ isEntityResolved: vi.fn(async () => false) }))

const { processSLAJob } = await import('../scheduler.js')

function job(name: string): Job {
  return {
    name,
    id: `${name}-inc-1`,
    data: { entityId: 'inc-1', entityType: 'incident', tenantId: 't1', resolveDeadline: new Date(Date.now() + 60_000).toISOString() },
  } as unknown as Job
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sla-1', tenant_id: 't1', entity_id: 'inc-1', entity_type: 'incident',
    started_at: '2026-01-01T00:00:00.000Z',
    response_deadline: '2026-01-01T01:00:00.000Z', resolve_deadline: '2026-01-01T04:00:00.000Z',
    response_met: false, resolve_met: false, breached: false,
    tier: { severity: 'high', response_minutes: 60, resolve_minutes: 240, business_hours: false },
    ...overrides,
  }
}

beforeEach(() => {
  publish.mockClear(); getSLAStatus.mockReset(); markBreached.mockClear(); callOrder.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('processSLAJob — defense in depth against met targets (D-01)', () => {
  it('sla.response_breach: does NOT publish when response_met is already true', async () => {
    getSLAStatus.mockResolvedValue(status({ response_met: true }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await processSLAJob(job('sla.response_breach'))
    expect(publish).not.toHaveBeenCalled()
    expect(log.mock.calls.some(c => String(c[0]).includes('skipped: already met'))).toBe(true)
  })

  it('sla.response_breach: publishes a warning (minutes_remaining 0) when the response is still open', async () => {
    getSLAStatus.mockResolvedValue(status())
    await processSLAJob(job('sla.response_breach'))
    expect(publish).toHaveBeenCalledTimes(1)
    const event = publish.mock.calls[0]![0] as unknown as { type: string; id: string; payload: { minutes_remaining: number } }
    expect(event.type).toBe('sla.warning')
    expect(event.payload.minutes_remaining).toBe(0)
    expect(event.id).toBe('response-breach-sla-1')
  })

  it('sla.warning: skipped when resolve_met', async () => {
    getSLAStatus.mockResolvedValue(status({ resolve_met: true, resolved_at: '2026-01-01T02:00:00.000Z' }))
    await processSLAJob(job('sla.warning'))
    expect(publish).not.toHaveBeenCalled()
  })

  it('sla.warning: skipped when the SLA is paused', async () => {
    getSLAStatus.mockResolvedValue(status({ paused_at: '2026-01-01T02:00:00.000Z', paused_type: 'resolve' }))
    await processSLAJob(job('sla.warning'))
    expect(publish).not.toHaveBeenCalled()
  })

  it('sla.breach: skipped when resolve_met (no markBreached either)', async () => {
    getSLAStatus.mockResolvedValue(status({ resolve_met: true }))
    await processSLAJob(job('sla.breach'))
    expect(publish).not.toHaveBeenCalled()
    expect(markBreached).not.toHaveBeenCalled()
  })

  it('sla.breach: skipped when the SLAStatus no longer exists', async () => {
    getSLAStatus.mockResolvedValue(null)
    await processSLAJob(job('sla.breach'))
    expect(publish).not.toHaveBeenCalled()
    expect(markBreached).not.toHaveBeenCalled()
  })

  it('sla.response_breach: a met resolve target also silences the response timer', async () => {
    getSLAStatus.mockResolvedValue(status({ resolve_met: true }))
    await processSLAJob(job('sla.response_breach'))
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('processSLAJob — sla.breach ordering and idempotency (D-10)', () => {
  it('marks the status breached BEFORE publishing, with a deterministic event id', async () => {
    getSLAStatus.mockResolvedValue(status())
    await processSLAJob(job('sla.breach'))
    expect(callOrder).toEqual(['markBreached', 'publish'])
    expect(markBreached).toHaveBeenCalledWith('t1', 'inc-1')
    const event = publish.mock.calls[0]![0] as unknown as { type: string; id: string; payload: Record<string, unknown> }
    expect(event.type).toBe('sla.breached')
    expect(event.id).toBe('breach-sla-1')
    expect(event.payload['entity_id']).toBe('inc-1')
  })

  it('a retry after a failed publish re-publishes the SAME event id (consumer dedup drops it)', async () => {
    getSLAStatus.mockResolvedValue(status())
    publish.mockRejectedValueOnce(new Error('redis down'))
    await expect(processSLAJob(job('sla.breach'))).rejects.toThrow('redis down')
    await processSLAJob(job('sla.breach'))
    const ids = publish.mock.calls.map(c => (c[0] as unknown as { id: string }).id)
    expect(ids).toEqual(['breach-sla-1', 'breach-sla-1'])
  })

  it('rejects an unknown job type loudly', async () => {
    await expect(processSLAJob(job('sla.bogus'))).rejects.toThrow('Unknown job type')
  })
})
