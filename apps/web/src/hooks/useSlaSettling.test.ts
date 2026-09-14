import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSlaSettling, slaStillSettling, SLA_SETTLE_INTERVAL_MS, SLA_SETTLE_MAX_MS } from './useSlaSettling'

const aperto = { startedAt: 'x', responseDeadline: 'x', resolveDeadline: 'x', responseMet: true, resolveMet: false, breached: false, pausedAt: '2026-09-14T00:00:00Z' }

afterEach(() => { vi.useRealTimers() })

describe('useSlaSettling', () => {
  it('ticket concluso con SLA ancora aperto (anche «in pausa»): si rilegge, poi si smette', () => {
    vi.useFakeTimers()
    const startPolling = vi.fn(); const stopPolling = vi.fn()
    renderHook(() => useSlaSettling(aperto, true, { startPolling, stopPolling }))
    expect(startPolling).toHaveBeenCalledWith(SLA_SETTLE_INTERVAL_MS)
    vi.advanceTimersByTime(SLA_SETTLE_MAX_MS)
    expect(stopPolling).toHaveBeenCalled()
  })

  it('SLA chiuso, violato, assente, o ticket ancora aperto: niente', () => {
    expect(slaStillSettling({ ...aperto, resolveMet: true }, true)).toBe(false)
    expect(slaStillSettling({ ...aperto, breached: true }, true)).toBe(false)
    expect(slaStillSettling(null, true)).toBe(false)
    expect(slaStillSettling(aperto, false)).toBe(false)
  })
})
