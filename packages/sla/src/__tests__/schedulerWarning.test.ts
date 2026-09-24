/**
 * NT-8/F6 (revisione del 14 set 2026): il preavviso SLA era 30 minuti fissi
 * per tutti. Ora è quello della policy, scritto nello stato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const add = vi.fn()
vi.mock('@opengraphity/events', () => ({
  publish: vi.fn(),
  tenantQueue: () => ({ add, getJob: vi.fn(async () => null) }),
  TenantWorkerPool: class {},
}))
vi.mock('../status.js', () => ({ getSLAStatus: vi.fn(), markBreached: vi.fn(), markWarningSent: vi.fn(), ticketReference: vi.fn() }))
vi.mock('../olaBreach.js', () => ({ isEntityResolved: vi.fn() }))

const { scheduleWarning } = await import('../scheduler.js')

const deadline = new Date(Date.now() + 5 * 3600_000)
const status = (warning: unknown) => ({
  id: 's1', tenant_id: 't1', entity_id: 'i1', entity_type: 'incident', started_at: new Date().toISOString(),
  response_deadline: deadline.toISOString(), resolve_deadline: deadline.toISOString(),
  response_met: false, resolve_met: false, breached: false,
  tier: { severity: 'high', response_minutes: 60, resolve_minutes: 300, business_hours: false, warning_minutes: warning },
}) as never

beforeEach(() => { add.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('scheduleWarning', () => {
  it('parte i minuti della policy prima della scadenza', async () => {
    await scheduleWarning(status(120))
    const delay = (add.mock.calls[0]![2] as { delay: number }).delay
    expect(Math.abs(delay - (3 * 3600_000))).toBeLessThan(5_000)
  })
  it('uno stato senza preavviso valido è un errore, non 30 minuti inventati', async () => {
    await expect(scheduleWarning(status(undefined))).rejects.toThrow(/no valid warning lead/)
    expect(add).not.toHaveBeenCalled()
  })
})
