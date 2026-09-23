/**
 * WAITING FOR THE SLA TO SETTLE: when not to wait, and when to stop.
 *
 * After a ticket is concluded the SLA is closed by the server a moment later,
 * so the page polls for a while. It must not poll at all while the ticket is
 * still open or once its SLA is settled, and it must stop at once when the
 * SLA settles or when the person leaves the page — a polling left running
 * keeps asking the server for a page nobody is looking at.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSlaSettling, SLA_SETTLE_INTERVAL_MS, SLA_SETTLE_MAX_MS } from './useSlaSettling'

const open = { startedAt: 'x', responseDeadline: 'x', resolveDeadline: 'x', responseMet: true, resolveMet: false, breached: false, pausedAt: null, warningMinutes: 30 }

afterEach(() => { vi.useRealTimers() })

describe('useSlaSettling', () => {
  it('a ticket still open, or with its SLA already settled, starts no polling', () => {
    const startPolling = vi.fn(); const stopPolling = vi.fn()
    renderHook(() => useSlaSettling(open, false, { startPolling, stopPolling }))
    renderHook(() => useSlaSettling({ ...open, resolveMet: true }, true, { startPolling, stopPolling }))
    expect(startPolling).not.toHaveBeenCalled()
    expect(stopPolling).not.toHaveBeenCalled()
  })

  it('stops as soon as the SLA settles, and does not stop twice later', () => {
    vi.useFakeTimers()
    const startPolling = vi.fn(); const stopPolling = vi.fn()
    const { rerender } = renderHook(({ sla }) => useSlaSettling(sla, true, { startPolling, stopPolling }), { initialProps: { sla: open } })
    expect(startPolling).toHaveBeenCalledWith(SLA_SETTLE_INTERVAL_MS)
    rerender({ sla: { ...open, resolveMet: true } })
    expect(stopPolling).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SLA_SETTLE_MAX_MS)
    expect(stopPolling).toHaveBeenCalledTimes(1)
  })

  it('leaving the page while it waits stops the polling at once', () => {
    vi.useFakeTimers()
    const startPolling = vi.fn(); const stopPolling = vi.fn()
    const { unmount } = renderHook(() => useSlaSettling(open, true, { startPolling, stopPolling }))
    unmount()
    expect(stopPolling).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SLA_SETTLE_MAX_MS)
    expect(stopPolling).toHaveBeenCalledTimes(1)
  })
})
